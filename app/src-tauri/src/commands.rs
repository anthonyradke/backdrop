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

async fn import_all(app: &AppHandle, paths: Vec<PathBuf>) -> ImportResult {
    let mut res = ImportResult { ids: vec![], errors: vec![] };
    let core = app.state::<Core>();
    for path in paths {
        let a = app.clone();
        let out = tauri::async_runtime::spawn_blocking(move || library::import_into(&a.state::<Core>(), &path, false, |_, _| {})).await;
        match out {
            Ok(Ok(item)) => {
                res.ids.push(item.id.clone());
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
pub async fn import_paths(app: AppHandle, paths: Vec<String>) -> Result<ImportResult, String> {
    Ok(import_all(&app, paths.into_iter().map(PathBuf::from).collect()).await)
}

/// Opens the system file picker (or folder picker, for HTML wallpapers) and imports the choice.
#[tauri::command]
pub async fn pick_files(app: AppHandle, folder: bool) -> Result<ImportResult, String> {
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
    Ok(import_all(&app, picked).await)
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

/// Deletes wallpapers from the library (one, or a whole selection), taking them off the displays and
/// out of rotation first.
#[tauri::command]
pub fn delete_items(core: State<'_, Core>, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    core.update_config(|c| {
        c.assignments.retain(|_, v| !ids.contains(v));
        c.span.take_if(|v| ids.contains(v));
        c.rotation.pool.retain(|v| !ids.contains(v));
        for list in c.rotation.display_pools.values_mut() {
            list.retain(|v| !ids.contains(v));
        }
        c.rotation.display_pools.retain(|_, list| !list.is_empty());
        c.schedule.retain(|s| !ids.contains(&s.item));
    });
    {
        let mut lib = core.library.lock().unwrap();
        for id in &ids {
            lib.remove(id);
        }
    }
    log(format!("deleted {} wallpaper(s) from the library", ids.len()));
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
        c.span = None;
        for k in keys {
            c.assignments.insert(k, id.clone());
        }
    });
    Ok(())
}

/// Stretches one wallpaper across all the displays as a single picture.
#[tauri::command]
pub fn span_wallpaper(core: State<'_, Core>, id: String) -> Result<(), String> {
    if !core.library.lock().unwrap().items.contains_key(&id) {
        return Err("not in the library".into());
    }
    core.update_config(|c| c.span = Some(id));
    Ok(())
}

#[tauri::command]
pub fn clear_wallpaper(core: State<'_, Core>, display: Option<String>) {
    core.update_config(|c| match display {
        Some(k) => {
            c.assignments.remove(&k);
        }
        None => {
            c.assignments.clear();
            c.span = None;
        }
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
    workshop_updates: Option<bool>,
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
        if let Some(v) = patch.workshop_updates {
            c.workshop_updates = v;
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

/// Adds items to (or takes them off) the rotation list, keeping the order they were marked in.
#[tauri::command]
pub fn set_in_rotation(core: State<'_, Core>, ids: Vec<String>, on: bool) -> Result<(), String> {
    if !ids.iter().all(|id| common::valid_id(id)) {
        return Err("bad id".into());
    }
    core.update_config(|c| {
        if on {
            for id in ids {
                if !c.rotation.pool.contains(&id) {
                    c.rotation.pool.push(id);
                }
            }
        } else {
            c.rotation.pool.retain(|x| !ids.contains(x));
        }
    });
    Ok(())
}

/// Adds items to (or takes them off) one display's own rotation list, used with "different on each
/// display".
#[tauri::command]
pub fn set_in_display_rotation(core: State<'_, Core>, ids: Vec<String>, display: String, on: bool) -> Result<(), String> {
    if !ids.iter().all(|id| common::valid_id(id)) {
        return Err("bad id".into());
    }
    core.update_config(|c| {
        let list = c.rotation.display_pools.entry(display.clone()).or_default();
        if on {
            for id in ids {
                if !list.contains(&id) {
                    list.push(id);
                }
            }
        } else {
            list.retain(|x| !ids.contains(x));
        }
        c.rotation.display_pools.retain(|_, list| !list.is_empty());
    });
    Ok(())
}

/// Replaces the programs that pause or mute the wallpapers while they run.
#[tauri::command]
pub fn set_app_rules(core: State<'_, Core>, rules: Vec<config::AppRule>) -> Result<(), String> {
    let mut clean: Vec<config::AppRule> = vec![];
    for mut r in rules {
        r.exe = r.exe.trim().to_lowercase();
        if r.exe.is_empty() || r.exe.contains(['/', '\\']) {
            return Err("bad program name".into());
        }
        if !clean.iter().any(|c| c.exe == r.exe) {
            clean.push(r);
        }
    }
    core.update_config(|c| c.app_rules = clean);
    Ok(())
}

/// The programs running now, for picking one to add a rule for.
#[tauri::command]
pub async fn running_apps() -> Result<Vec<String>, String> {
    let mut v: Vec<String> = tauri::async_runtime::spawn_blocking(crate::platform::running_exes).await.map_err(|e| e.to_string())?.into_iter().filter(|e| e.ends_with(".exe")).collect();
    v.sort();
    Ok(v)
}

/// Converts a video WebView2 can't play to H.264 with FFmpeg (transcode.rs). Returns once it has
/// started; progress comes with the state.
#[tauri::command]
pub fn convert_video(app: AppHandle, id: String) -> Result<(), String> {
    crate::transcode::start(&app, &id)
}

/// Replaces the schedule: the times of day the wallpaper changes, each to a chosen wallpaper.
#[tauri::command]
pub fn set_schedule(core: State<'_, Core>, slots: Vec<config::Slot>) -> Result<(), String> {
    if slots.iter().any(|s| s.at >= 24 * 60 || !common::valid_id(&s.item)) {
        return Err("bad schedule".into());
    }
    core.update_config(|c| c.schedule = slots);
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
    common::write_atomic(&dir.join(crate::engine::FRAME), &jpeg).map_err(|e| e.to_string())?;
    core.poke();
    Ok(())
}

/// A scene's or HTML wallpaper's own settings: the `general.properties` (and `localization`) from
/// its project.json, with the values the user picked.
#[derive(Serialize)]
pub struct ItemProperties {
    properties: serde_json::Value,
    localization: serde_json::Value,
    values: std::collections::BTreeMap<String, serde_json::Value>,
}

#[tauri::command]
pub fn item_properties(core: State<'_, Core>, id: String) -> Result<Option<ItemProperties>, String> {
    let (dir, item) = {
        let lib = core.library.lock().unwrap();
        let item = lib.items.get(&id).cloned().ok_or("not in the library")?;
        (lib.dir(&id), item)
    };
    let project = match item.kind {
        common::Kind::Scene => dir.join(crate::scene::DIR).join("project.json"),
        common::Kind::Web => dir.join("web").join("project.json"),
        _ => return Ok(None),
    };
    let Ok(bytes) = std::fs::read(&project) else { return Ok(None) };
    // Windows editors leave a byte order mark, which serde refuses.
    let text = String::from_utf8_lossy(&bytes);
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) else { return Ok(None) };
    let general = &json["general"];
    let properties = general["properties"].clone();
    if !properties.is_object() || properties.as_object().is_some_and(|o| o.is_empty()) {
        return Ok(None);
    }
    Ok(Some(ItemProperties { properties, localization: general["localization"].clone(), values: item.properties }))
}

/// Sets some of a wallpaper's own properties; a null value goes back to the wallpaper's default,
/// and `reset` clears them all first.
#[tauri::command]
pub fn set_item_properties(
    core: State<'_, Core>,
    id: String,
    values: std::collections::BTreeMap<String, serde_json::Value>,
    reset: Option<bool>,
) -> Result<(), String> {
    {
        let mut lib = core.library.lock().unwrap();
        let item = lib.items.get_mut(&id).ok_or("not in the library")?;
        if reset.unwrap_or(false) {
            item.properties.clear();
        }
        for (k, v) in values {
            if v.is_null() {
                item.properties.remove(&k);
            } else {
                item.properties.insert(k, v);
            }
        }
        let item = item.clone();
        lib.save_meta(&item).map_err(|e| e.to_string())?;
    }
    core.poke();
    core.emit_state();
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

/// Where the cursor is in physical pixels, and whether it's pressing on the bare desktop. Wallpapers
/// sit behind the icons and get no mouse events, so scenes that react to the cursor ask for them.
#[tauri::command]
pub fn cursor_position(app: AppHandle) -> Option<(f64, f64, bool)> {
    app.cursor_position().ok().map(|p| (p.x, p.y, crate::platform::desktop_pressed(p.x, p.y)))
}

/// Levels of what's playing, for scenes that react to music. Left then right.
#[tauri::command]
pub fn audio_spectrum() -> Vec<f32> {
    crate::audio::spectrum()
}

/// The current track, for scenes that show it. The session API blocks, so it stays off the main thread.
#[tauri::command]
pub async fn now_playing(have: Option<String>) -> Result<Option<crate::nowplaying::NowPlaying>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::nowplaying::read(have.as_deref())).await.map_err(|e| e.to_string())
}

/// A player's measurement of what its wallpaper costs to show (see `Cost::rate`). Saved with the
/// item when its rating changes, so the library can show it later.
#[tauri::command]
pub fn player_stats(core: State<'_, Core>, id: String, ms: f64, fps: f64, dropped: f64) -> Result<(), String> {
    if !common::valid_id(&id) || ![ms, fps, dropped].iter().all(|v| v.is_finite() && *v >= 0.0) {
        return Err("bad stats".into());
    }
    let changed = {
        let mut lib = core.library.lock().unwrap();
        let Some(item) = lib.items.get_mut(&id) else { return Ok(()) };
        let cost = common::Cost::rate(item.kind, ms, fps.min(1000.0), dropped.min(1.0));
        let changed = item.cost.as_ref().map(|c| c.level) != Some(cost.level);
        item.cost = Some(cost);
        if changed {
            let item = item.clone();
            let _ = lib.save_meta(&item);
        }
        changed
    };
    if changed {
        core.emit_state();
    }
    Ok(())
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
