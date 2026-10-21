//! Commands the library window and the players call.

use crate::config::{self, Fit, Order};
use crate::engine::{read_displays, PlayerParams};
use crate::library;
use crate::{log, remote, Core, StateView};
use backdrop_common::{self as common, Item, Kind, Listed};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn get_state(core: State<'_, Core>) -> StateView {
    core.state_view()
}

#[tauri::command]
pub async fn remote_items(core: State<'_, Core>) -> Result<Vec<Listed>, String> {
    let server = core.server()?;
    remote::list(&server).await
}

/// Checks the address and saves it when it answers. An empty address turns sharing off.
#[tauri::command]
pub async fn test_server(core: State<'_, Core>, url: String) -> Result<String, String> {
    let server = config::normalize_server(&url);
    if !server.is_empty() {
        remote::health(&server).await?;
    }
    core.update_config(|c| c.server = server.clone());
    Ok(server)
}

#[derive(Serialize)]
pub struct ImportResult {
    ids: Vec<String>,
    errors: Vec<String>,
}

async fn import_all(core: &Core, paths: Vec<PathBuf>) -> ImportResult {
    let mut res = ImportResult { ids: vec![], errors: vec![] };
    for path in paths {
        let (root, existing) = {
            let lib = core.library.lock().unwrap();
            (lib.root.clone(), lib.items.clone())
        };
        let p = path.clone();
        let out = tauri::async_runtime::spawn_blocking(move || library::import(&root, &p, &existing)).await;
        match out {
            Ok(Ok(item)) => {
                res.ids.push(item.id.clone());
                core.library.lock().unwrap().items.insert(item.id.clone(), item);
                core.emit_state();
            }
            Ok(Err(e)) => res.errors.push(e.to_string()),
            Err(e) => res.errors.push(e.to_string()),
        }
    }
    if !res.errors.is_empty() {
        log(format!("import errors: {:?}", res.errors));
    }
    res
}

#[tauri::command]
pub async fn import_paths(core: State<'_, Core>, paths: Vec<String>) -> Result<ImportResult, String> {
    Ok(import_all(&core, paths.into_iter().map(PathBuf::from).collect()).await)
}

/// Opens the system file picker (or folder picker, for HTML wallpapers) and imports the choice.
#[tauri::command]
pub async fn pick_files(app: AppHandle, core: State<'_, Core>, folder: bool) -> Result<ImportResult, String> {
    let picked: Vec<PathBuf> = if folder {
        app.dialog()
            .file()
            .set_title("Choose a folder with an index.html")
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .into_iter()
            .collect()
    } else {
        let exts: Vec<&str> =
            common::VIDEO_EXTS.iter().chain(common::IMAGE_EXTS).chain(common::WEB_EXTS).copied().collect();
        app.dialog()
            .file()
            .set_title("Add wallpapers")
            .add_filter("Wallpapers", &exts)
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect()
    };
    Ok(import_all(&core, picked).await)
}

/// Stores a thumbnail the library window rendered (JPEG as base64 or a data URL) and, when known,
/// the media's pixel size.
#[tauri::command]
pub fn save_thumb(
    core: State<'_, Core>,
    id: String,
    data: String,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    if !common::valid_id(&id) {
        return Err("bad id".into());
    }
    let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or(&data);
    let jpeg = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    let mut lib = core.library.lock().unwrap();
    let dir = lib.dir(&id);
    if !dir.is_dir() {
        return Err("not in the library".into());
    }
    std::fs::write(dir.join("thumb.jpg"), jpeg).map_err(|e| e.to_string())?;
    if let Some(item) = lib.items.get_mut(&id) {
        if item.width.is_none() && width.is_some() {
            item.width = width;
            item.height = height;
            let item = item.clone();
            let _ = lib.save_meta(&item);
        }
    }
    drop(lib);
    core.emit_state();
    Ok(())
}

#[tauri::command]
pub async fn rename_item(core: State<'_, Core>, id: String, name: String, remote: bool) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name can't be empty".into());
    }
    {
        let mut lib = core.library.lock().unwrap();
        if let Some(item) = lib.items.get_mut(&id) {
            item.name = name.clone();
            let item = item.clone();
            lib.save_meta(&item).map_err(|e| e.to_string())?;
        }
    }
    core.emit_state();
    if remote {
        let server = core.server()?;
        remote::rename(&server, &id, &name).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_local(core: State<'_, Core>, id: String) {
    core.update_config(|c| c.assignments.retain(|_, v| *v != id));
    core.library.lock().unwrap().remove(&id);
    core.emit_state();
}

#[tauri::command]
pub async fn delete_remote(core: State<'_, Core>, id: String) -> Result<(), String> {
    let server = core.server()?;
    remote::delete(&server, &id).await
}

/// Sends `transfer` events to the library window, at most ~5 a second.
struct Progress {
    app: AppHandle,
    id: String,
    dir: &'static str,
    last: Mutex<Option<Instant>>,
}

#[derive(Serialize, Clone)]
struct TransferEvent<'a> {
    id: &'a str,
    dir: &'a str,
    done: u64,
    total: u64,
    state: &'a str,
    error: Option<String>,
}

impl Progress {
    fn new(app: &AppHandle, id: &str, dir: &'static str) -> Self {
        Self { app: app.clone(), id: id.to_string(), dir, last: Mutex::new(None) }
    }

    fn send(&self, done: u64, total: u64, state: &str, error: Option<String>) {
        let _ = self.app.emit_to(
            "main",
            "transfer",
            TransferEvent { id: &self.id, dir: self.dir, done, total, state, error },
        );
    }

    fn tick(&self, done: u64, total: u64) {
        let mut last = self.last.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < Duration::from_millis(200)) && done < total {
            return;
        }
        *last = Some(Instant::now());
        drop(last);
        self.send(done, total, "active", None);
    }
}

/// Marks an item as transferring for as long as it lives.
struct TransferGuard<'a> {
    core: &'a Core,
    id: String,
}

impl<'a> TransferGuard<'a> {
    fn new(core: &'a Core, id: &str) -> Result<Self, String> {
        if !core.transfers.lock().unwrap().insert(id.to_string()) {
            return Err("already transferring".into());
        }
        core.emit_state();
        Ok(Self { core, id: id.to_string() })
    }
}

impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        self.core.transfers.lock().unwrap().remove(&self.id);
        self.core.emit_state();
    }
}

#[tauri::command]
pub async fn upload(app: AppHandle, core: State<'_, Core>, id: String) -> Result<(), String> {
    let server = core.server()?;
    let (item, path, thumb) = {
        let lib = core.library.lock().unwrap();
        let item = lib.items.get(&id).cloned().ok_or("not on this computer")?;
        let path = lib.media_path(&item);
        let thumb = lib.has_thumb(&id).then(|| lib.dir(&id).join("thumb.jpg"));
        (item, path, thumb)
    };
    let _guard = TransferGuard::new(&core, &id)?;
    let progress = std::sync::Arc::new(Progress::new(&app, &id, "up"));
    let p = progress.clone();
    let result = remote::upload(&server, &path, &item.file, &item.name, move |d, t| p.tick(d, t)).await;
    match result {
        Ok(remote_item) => {
            if remote_item.id != item.id {
                log(format!("upload of {} came back as {}", item.id, remote_item.id));
            }
            // The server makes its own thumbnails for video and images; web pages need ours.
            if item.kind == Kind::Web {
                if let Some(t) = thumb.and_then(|t| std::fs::read(t).ok()) {
                    let _ = remote::put_thumb(&server, &remote_item.id, t).await;
                }
            }
            progress.send(item.size, item.size, "done", None);
            Ok(())
        }
        Err(e) => {
            progress.send(0, 0, "error", Some(e.clone()));
            Err(e)
        }
    }
}

/// Pulls an item from the server into the local library (no-op if it's already here).
pub(crate) async fn fetch(app: &AppHandle, core: &Core, id: &str) -> Result<Item, String> {
    if let Some(item) = core.library.lock().unwrap().items.get(id).cloned() {
        return Ok(item);
    }
    if !common::valid_id(id) {
        return Err("bad id".into());
    }
    let server = core.server()?;
    let item = remote::list(&server)
        .await?
        .into_iter()
        .map(|l| l.item)
        .find(|i| i.id == id)
        .ok_or("that wallpaper isn't in the shared library any more")?;
    let _guard = TransferGuard::new(core, id)?;
    let progress = Progress::new(app, id, "down");
    let root = core.library.lock().unwrap().root.clone();
    let staging = root.join(format!(".download-{id}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let result = async {
        remote::download(&server, id, &staging.join(&item.file), |d, t| progress.tick(d, t)).await?;
        if let Err(e) = remote::download_thumb(&server, id, &staging.join("thumb.jpg")).await {
            log(format!("thumbnail for {id}: {e}"));
        }
        let (st, it) = (staging.clone(), item.clone());
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let media = st.join(&it.file);
            if common::hash_file(&media).map_err(|e| e.to_string())? != it.id {
                return Err("the download doesn't match the library copy".into());
            }
            if it.kind == Kind::Web {
                common::pack::extract(&media, &st.join("web")).map_err(|e| e.to_string())?;
            }
            library::write_meta(&st, &it).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        let dest = root.join(id);
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&staging, &dest).map_err(|e| e.to_string())
    }
    .await;

    match result {
        Ok(()) => {
            core.library.lock().unwrap().items.insert(id.to_string(), item.clone());
            progress.send(item.size, item.size, "done", None);
            core.emit_state();
            Ok(item)
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            progress.send(0, 0, "error", Some(e.clone()));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn download(app: AppHandle, core: State<'_, Core>, id: String) -> Result<(), String> {
    fetch(&app, &core, &id).await.map(|_| ())
}

/// Shows a wallpaper on one display, or on all of them when `display` is null. Wallpapers that
/// only live on the server are downloaded first.
#[tauri::command]
pub async fn set_wallpaper(
    app: AppHandle,
    core: State<'_, Core>,
    id: String,
    display: Option<String>,
) -> Result<(), String> {
    fetch(&app, &core, &id).await?;
    let keys: Vec<String> = match display {
        Some(k) => vec![k],
        None => {
            let known: Vec<String> = core.displays.lock().unwrap().iter().map(|d| d.display.key.clone()).collect();
            if known.is_empty() {
                read_displays(&app).into_iter().map(|d| d.key).collect()
            } else {
                known
            }
        }
    };
    core.update_config(|c| {
        for k in keys {
            c.assignments.insert(k, id.clone());
        }
    });
    Ok(())
}

#[tauri::command]
pub fn clear_wallpaper(core: State<'_, Core>, display: Option<String>) {
    core.update_config(|c| match display {
        Some(k) => {
            c.assignments.remove(&k);
        }
        None => c.assignments.clear(),
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    fit: Option<Fit>,
    muted: Option<bool>,
    volume: Option<f64>,
    speed: Option<f64>,
    shade_bar: Option<bool>,
    still_frame: Option<bool>,
    pause_covered: Option<bool>,
    pause_focused: Option<bool>,
    pause_battery: Option<bool>,
    pause_low_power: Option<bool>,
    pause_locked: Option<bool>,
    language: Option<String>,
    rotation_minutes: Option<u32>,
    rotation_order: Option<Order>,
    rotation_per_display: Option<bool>,
    rotation_on_start: Option<bool>,
    rotation_on_wake: Option<bool>,
}

#[tauri::command]
pub fn update_settings(app: AppHandle, core: State<'_, Core>, patch: SettingsPatch) {
    if patch.rotation_minutes.is_some() {
        // A new interval counts from now.
        *core.rotated_at.lock().unwrap() = Instant::now();
    }
    let language = patch.language.clone();
    core.update_config(|c| {
        if let Some(v) = patch.speed {
            c.speed = v.clamp(0.25, 2.0);
        }
        if let Some(v) = patch.shade_bar {
            c.shade_bar = v;
        }
        if let Some(v) = patch.still_frame {
            c.still_frame = v;
        }
        if let Some(v) = patch.pause_focused {
            c.pause_focused = v;
        }
        if let Some(v) = patch.pause_low_power {
            c.pause_low_power = v;
        }
        if let Some(v) = patch.pause_locked {
            c.pause_locked = v;
        }
        if let Some(v) = patch.language {
            c.language = v;
        }
        if let Some(v) = patch.rotation_minutes {
            c.rotation.minutes = v;
        }
        if let Some(v) = patch.rotation_order {
            c.rotation.order = v;
        }
        if let Some(v) = patch.rotation_per_display {
            c.rotation.per_display = v;
        }
        if let Some(v) = patch.rotation_on_start {
            c.rotation.on_start = v;
        }
        if let Some(v) = patch.rotation_on_wake {
            c.rotation.on_wake = v;
        }
        if let Some(v) = patch.fit {
            c.fit = v;
        }
        if let Some(v) = patch.muted {
            c.muted = v;
        }
        if let Some(v) = patch.volume {
            c.volume = v.clamp(0.0, 1.0);
        }
        if let Some(v) = patch.pause_covered {
            c.pause_covered = v;
        }
        if let Some(v) = patch.pause_battery {
            c.pause_battery = v;
        }
    });
    if language.is_some() {
        crate::translate_tray(&app);
    }
}

/// Adds an item to (or takes it off) the rotation list.
#[tauri::command]
pub fn set_in_rotation(core: State<'_, Core>, id: String, on: bool) -> Result<(), String> {
    if !common::valid_id(&id) {
        return Err("bad id".into());
    }
    core.update_config(|c| {
        c.rotation.pool.retain(|x| *x != id);
        if on {
            c.rotation.pool.push(id);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn next_wallpaper(app: AppHandle) -> Result<(), String> {
    crate::rotation::advance(&app, crate::rotation::Why::Manual).await
}

/// A player sending the full-size frame it captured of a moving wallpaper (JPEG data URL). It
/// becomes the system wallpaper behind the player.
#[tauri::command]
pub fn save_frame(core: State<'_, Core>, id: String, data: String) -> Result<(), String> {
    if !common::valid_id(&id) {
        return Err("bad id".into());
    }
    let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or(&data);
    let jpeg = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    if jpeg.len() < 3 || jpeg[..3] != [0xFF, 0xD8, 0xFF] {
        return Err("not a JPEG".into());
    }
    let dir = core.library.lock().unwrap().dir(&id);
    if !dir.is_dir() {
        return Err("not in the library".into());
    }
    let tmp = dir.join("frame.jpg.tmp");
    std::fs::write(&tmp, jpeg).and_then(|_| std::fs::rename(&tmp, dir.join(crate::engine::FRAME))).map_err(|e| e.to_string())?;
    core.poke();
    Ok(())
}

/// Starts an H.264 copy of a server video on the server.
#[tauri::command]
pub async fn convert_remote(
    core: State<'_, Core>,
    id: String,
    max_height: Option<u32>,
    max_fps: Option<u32>,
) -> Result<serde_json::Value, String> {
    let server = core.server()?;
    remote::convert(&server, &id, max_height, max_fps).await
}

#[tauri::command]
pub async fn remote_jobs(core: State<'_, Core>) -> Result<serde_json::Value, String> {
    let server = core.server()?;
    remote::jobs(&server).await
}

#[derive(Serialize)]
pub struct Freed {
    count: usize,
    bytes: u64,
}

/// Removes local copies of wallpapers that are also on the server and aren't showing anywhere.
/// They download again when picked.
#[tauri::command]
pub async fn free_space(core: State<'_, Core>) -> Result<Freed, String> {
    let server = core.server()?;
    let remote: std::collections::HashSet<String> = remote::list(&server).await?.into_iter().map(|l| l.item.id).collect();
    let showing: std::collections::HashSet<String> = core.config.lock().unwrap().assignments.values().cloned().collect();
    let mut freed = Freed { count: 0, bytes: 0 };
    {
        let mut lib = core.library.lock().unwrap();
        let gone: Vec<(String, u64)> = lib
            .items
            .values()
            .filter(|i| remote.contains(&i.id) && !showing.contains(&i.id))
            .map(|i| (i.id.clone(), i.size))
            .collect();
        for (id, size) in gone {
            lib.remove(&id);
            freed.count += 1;
            freed.bytes += size;
        }
    }
    core.emit_state();
    Ok(freed)
}

/// Puts every setting back to its default, keeping the library and the server address.
#[tauri::command]
pub fn reset_settings(app: AppHandle, core: State<'_, Core>) {
    core.update_config(|c| {
        let server = std::mem::take(&mut c.server);
        *c = config::Config { server, ..Default::default() };
    });
    crate::translate_tray(&app);
}

#[tauri::command]
pub fn set_paused(core: State<'_, Core>, paused: bool) {
    core.set_paused(paused);
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, core: State<'_, Core>, on: bool) -> Result<(), String> {
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    core.emit_state();
    Ok(())
}

#[tauri::command]
pub fn open_library_dir(app: AppHandle, core: State<'_, Core>) -> Result<(), String> {
    let root = core.library.lock().unwrap().root.clone();
    app.opener().open_path(root.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// A player window asking what it should show.
#[tauri::command]
pub fn player_init(window: WebviewWindow, core: State<'_, Core>) -> Option<PlayerParams> {
    core.players.lock().unwrap().get(window.label()).cloned()
}


/// Players report problems (a video that won't decode, autoplay refused) into backdrop.log.
#[tauri::command]
pub fn player_log(window: WebviewWindow, msg: String) {
    log(format!("player {}: {}", window.label(), msg.chars().take(500).collect::<String>()));
}
