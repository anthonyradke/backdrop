//! Commands the library window and the players call.

use crate::config::{self, Fit, Order};
use crate::engine::{read_displays, PlayerParams};
use crate::{common, library, log, steamapi, update, workshop, Core, StateView};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn get_state(core: State<'_, Core>) -> StateView {
    core.state_view()
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

/// Stores a thumbnail the library window rendered (JPEG as base64 or a data URL), optionally the
/// larger poster the library's hero shows, and, when known, the media's pixel size.
#[tauri::command]
pub fn save_thumb(
    core: State<'_, Core>,
    id: String,
    data: String,
    poster: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    if !common::valid_id(&id) {
        return Err("bad id".into());
    }
    let decode = |data: &str| {
        let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or(data);
        base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())
    };
    let jpeg = decode(&data)?;
    let poster = poster.as_deref().map(decode).transpose()?;
    let mut lib = core.library.lock().unwrap();
    let dir = lib.dir(&id);
    if !dir.is_dir() {
        return Err("not in the library".into());
    }
    std::fs::write(dir.join("thumb.jpg"), jpeg).map_err(|e| e.to_string())?;
    if let Some(poster) = poster {
        std::fs::write(dir.join("poster.jpg"), poster).map_err(|e| e.to_string())?;
    }
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
pub fn rename_item(core: State<'_, Core>, id: String, name: String) -> Result<(), String> {
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
    Ok(())
}

#[tauri::command]
pub fn delete_local(core: State<'_, Core>, id: String) {
    core.update_config(|c| c.assignments.retain(|_, v| *v != id));
    core.library.lock().unwrap().remove(&id);
    core.emit_state();
}

/// Shows a wallpaper on one display, or on all of them when `display` is null.
#[tauri::command]
pub fn set_wallpaper(
    app: AppHandle,
    core: State<'_, Core>,
    id: String,
    display: Option<String>,
) -> Result<(), String> {
    if !core.library.lock().unwrap().items.contains_key(&id) {
        return Err("not in the library".into());
    }
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

/// Puts every setting back to its default, keeping the library.
#[tauri::command]
pub fn reset_settings(app: AppHandle, core: State<'_, Core>) {
    core.update_config(|c| *c = config::Config::default());
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

/// One page of the Wallpaper Engine workshop, anime left out (see workshop.rs).
#[tauri::command]
pub async fn workshop_browse(core: State<'_, Core>, query: workshop::Query) -> Result<workshop::Page, String> {
    let hidden = core.workshop.lock().unwrap().hidden().clone();
    tauri::async_runtime::spawn_blocking(move || workshop::browse(&query, &hidden)).await.map_err(|e| e.to_string())?
}

/// The video and HTML wallpapers Steam has downloaded for Wallpaper Engine.
#[tauri::command]
pub async fn workshop_subscribed(core: State<'_, Core>) -> Result<Vec<workshop::WsItem>, String> {
    let hidden = core.workshop.lock().unwrap().hidden().clone();
    tauri::async_runtime::spawn_blocking(move || workshop::subscribed(&hidden)).await.map_err(|e| e.to_string())?
}

/// Subscribes through Steam in the background, or, when that can't work (Steam not running, no
/// Wallpaper Engine), opens the item in the Steam client to subscribe there. Either way it's
/// imported once Steam has downloaded it. Returns "background" or "steam".
#[tauri::command]
pub async fn workshop_subscribe(app: AppHandle, id: String) -> Result<&'static str, String> {
    if !workshop::valid_ws_id(&id) {
        return Err("bad id".into());
    }
    let (a, i) = (app.clone(), id.clone());
    let direct = tauri::async_runtime::spawn_blocking(move || steamapi::download(&a, &i)).await.map_err(|e| e.to_string())?;
    let how = match direct {
        Ok(()) => "background",
        Err(e) => {
            log(format!("workshop item {id}: can't download in the background ({e}); opening Steam"));
            app.opener()
                .open_url(format!("steam://url/CommunityFilePage/{id}"), None::<&str>)
                .map_err(|e| format!("couldn't open Steam: {e}"))?;
            "steam"
        }
    };
    let core = app.state::<Core>();
    core.workshop.lock().unwrap().add_pending(&id);
    core.emit_state();
    Ok(how)
}

/// Opens the item in the Steam client.
#[tauri::command]
pub fn workshop_open_steam(app: AppHandle, id: String) -> Result<(), String> {
    if !workshop::valid_ws_id(&id) {
        return Err("bad id".into());
    }
    app.opener().open_url(format!("steam://url/CommunityFilePage/{id}"), None::<&str>).map_err(|e| format!("couldn't open Steam: {e}"))
}

/// Opens the item's workshop page in the browser.
#[tauri::command]
pub fn workshop_open(app: AppHandle, id: String) -> Result<(), String> {
    if !workshop::valid_ws_id(&id) {
        return Err("bad id".into());
    }
    app.opener()
        .open_url(format!("https://steamcommunity.com/sharedfiles/filedetails/?id={id}"), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Imports an item Steam has already downloaded. Returns the library item id.
#[tauri::command]
pub async fn workshop_add(app: AppHandle, id: String) -> Result<String, String> {
    if !workshop::valid_ws_id(&id) {
        return Err("bad id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let core = app.state::<Core>();
        let item = workshop::import(&core, &id)?;
        core.workshop.lock().unwrap().remove_pending(&id);
        core.emit_state();
        Ok(item.id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hides a workshop item from browsing, or with `creator`, everything that creator uploaded.
#[tauri::command]
pub fn workshop_hide(core: State<'_, Core>, id: String, creator: Option<String>) -> Result<(), String> {
    if !workshop::valid_ws_id(&id) || creator.as_deref().is_some_and(|c| !workshop::valid_ws_id(c)) {
        return Err("bad id".into());
    }
    core.workshop.lock().unwrap().hide(&id, creator.as_deref());
    core.emit_state();
    Ok(())
}

#[tauri::command]
pub fn workshop_unhide_all(core: State<'_, Core>) {
    core.workshop.lock().unwrap().unhide_all();
    core.emit_state();
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> update::Status {
    update::status(&app)
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<update::Status, String> {
    update::check(&app).await;
    Ok(update::status(&app))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    update::install(&app).await
}
