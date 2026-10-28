//! The engine thread: once a second (or when poked) it reads the displays, makes sure every display
//! with a wallpaper has a player window behind the desktop icons (or a native OS wallpaper for still
//! images), closes windows nobody needs, and pauses players that can't be seen.

use crate::config::Fit;
use crate::{log, platform, Core};
use crate::common::{Item, Kind};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    /// Stable id for assignments (the OS display name, made unique).
    pub key: String,
    pub name: String,
    /// Physical pixels in the virtual-screen space.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Playing,
    Paused,
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayView {
    #[serde(flatten)]
    pub display: Display,
    pub item: Option<String>,
    pub status: Status,
    /// Why it's paused: manual, locked, battery, lowPower, covered or focused.
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerParams {
    pub kind: Kind,
    /// Path under the media:// root, e.g. `<id>/media.mp4`.
    pub src: String,
    pub fit: Fit,
    pub muted: bool,
    pub volume: f64,
    pub speed: f64,
    pub paused: bool,
    /// Where to darken a strip for the taskbar: `top`, `bottom`, or none.
    pub shade: Option<&'static str>,
    /// Item id to capture a full-size still frame of (for the system wallpaper), when it has none yet.
    pub capture: Option<String>,
    /// Loopback server base URL, tried when a video fails over media://.
    pub fallback: Option<String>,
}

struct Slot {
    label: String,
    display: Display,
}

struct Engine {
    app: AppHandle,
    /// Display key -> its player window.
    slots: HashMap<String, Slot>,
    /// Display key -> (item id, fit) last set as the native wallpaper.
    native: HashMap<String, (String, Fit)>,
    covered: HashSet<String>,
    on_battery: bool,
    low_power: bool,
    battery_checked: Option<Instant>,
    /// Wall-clock time of the last tick. A big gap means the computer was asleep.
    last_tick: std::time::SystemTime,
    /// Display key -> when creating its window last failed (retried after a pause).
    failed: HashMap<String, Instant>,
    /// Players rebuilt after Explorer destroyed them, for unique window labels.
    respawns: u32,
}

pub fn spawn(app: AppHandle) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("backdrop-engine".into())
        .spawn(move || {
            let mut e = Engine {
                app,
                slots: HashMap::new(),
                native: HashMap::new(),
                covered: HashSet::new(),
                on_battery: false,
                low_power: false,
                battery_checked: None,
                last_tick: std::time::SystemTime::now(),
                failed: HashMap::new(),
                respawns: 0,
            };
            loop {
                match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                while rx.try_recv().is_ok() {}
                e.tick();
            }
        })
        .expect("engine thread");
    tx
}

/// Still images go straight to the OS wallpaper (no window, no GPU); GIFs need a player.
pub fn uses_native(item: &Item) -> bool {
    platform::NATIVE_IMAGES && item.kind == Kind::Image && !item.file.ends_with(".gif")
}

/// The OS wallpaper APIs have no "fit height": it's Fill when the picture is wider than the screen
/// (the sides get cropped) and Fit when it's narrower (bars at the sides).
pub fn native_fit(fit: Fit, size: (Option<u32>, Option<u32>), d: &Display) -> Fit {
    match (fit, size) {
        (Fit::Height, (Some(w), Some(h))) if h > 0 && d.height > 0 => {
            if w as f64 / h as f64 >= d.width as f64 / d.height as f64 {
                Fit::Cover
            } else {
                Fit::Contain
            }
        }
        (Fit::Height, _) => Fit::Cover,
        (f, _) => f,
    }
}

/// The full-size frame of a moving wallpaper that stands in as the system wallpaper.
pub const FRAME: &str = "frame.jpg";

pub fn label_for(key: &str) -> String {
    // FNV-1a: labels may only hold a few characters, and display names hold anything.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("wp-{h:016x}")
}

fn pretty_name(raw: &str, index: usize) -> String {
    // Windows names look like \\.\DISPLAY2.
    let trimmed = raw.trim_start_matches(['\\', '.']);
    if let Some(n) = trimmed.strip_prefix("DISPLAY") {
        return format!("Display {n}");
    }
    if trimmed.is_empty() {
        format!("Display {}", index + 1)
    } else {
        trimmed.to_string()
    }
}

pub fn read_displays(app: &AppHandle) -> Vec<Display> {
    let mut mons = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    mons.sort_by_key(|m| (m.position().x, m.position().y));
    let mut seen: HashMap<String, usize> = HashMap::new();
    mons.iter()
        .enumerate()
        .map(|(i, m)| {
            let raw = m.name().cloned().unwrap_or_default();
            let n = seen.entry(raw.clone()).or_insert(0);
            *n += 1;
            let base = if raw.is_empty() { format!("display-{i}") } else { raw.clone() };
            let key = if *n > 1 { format!("{base}#{n}") } else { base };
            let mut name = pretty_name(&raw, i);
            if *n > 1 {
                name = format!("{name} ({n})");
            }
            Display {
                key,
                name,
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
                scale: m.scale_factor(),
                primary: primary == Some(*m.position()),
            }
        })
        .collect()
}

fn create_player(app: &AppHandle, label: &str, d: &Display) -> tauri::Result<WebviewWindow> {
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::App("player.html".into()))
        .title("Backdrop wallpaper")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .shadow(false)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .inner_size(d.width as f64 / d.scale, d.height as f64 / d.scale)
        .position(d.x as f64 / d.scale, d.y as f64 / d.scale);
    #[cfg(windows)]
    let b = b.additional_browser_args(crate::WEBVIEW_ARGS).focusable(false);
    b.build()
}

impl Engine {
    fn tick(&mut self) {
        let displays = read_displays(&self.app);
        // Monitors can vanish for a moment around sleep and resolution changes. Don't tear down.
        if displays.is_empty() {
            return;
        }
        let app = self.app.clone();
        let core = app.state::<Core>();
        let cfg = core.config.lock().unwrap().clone();
        let (root, items): (_, HashMap<String, Item>) = {
            let lib = core.library.lock().unwrap();
            let wanted: HashSet<&String> = cfg.assignments.values().collect();
            (
                lib.root.clone(),
                lib.items.iter().filter(|(id, _)| wanted.contains(id)).map(|(k, v)| (k.clone(), v.clone())).collect(),
            )
        };

        let now = std::time::SystemTime::now();
        let slept = now.duration_since(self.last_tick).is_ok_and(|d| d > Duration::from_secs(30));
        self.last_tick = now;
        if slept {
            log("woke from sleep");
            if cfg.rotation.on_wake {
                crate::rotation::trigger(&self.app, crate::rotation::Why::Wake);
            }
        }

        if slept || self.battery_checked.is_none_or(|t| t.elapsed() > Duration::from_secs(15)) {
            self.on_battery = platform::on_battery();
            self.low_power = platform::low_power();
            self.battery_checked = Some(Instant::now());
        }
        let manual = core.manual_pause.load(Ordering::Relaxed);
        let locked = cfg.pause_locked && platform::locked();
        let focused =
            if cfg.pause_focused && !self.slots.is_empty() { platform::focused(&self.app, &displays) } else { HashSet::new() };
        let shade = cfg.shade_bar.then_some("bottom");

        let mut views = Vec::with_capacity(displays.len());
        let mut wanted: HashSet<String> = HashSet::new();
        let mut native_now: HashSet<String> = HashSet::new();
        for d in &displays {
            let assigned = cfg.assignments.get(&d.key).cloned();
            let mut status = Status::Idle;
            let mut reason = None;
            if let Some(item) = assigned.as_ref().and_then(|id| items.get(id)) {
                // Still images are the wallpaper; moving ones can leave a frame of themselves as it.
                let frame = root.join(&item.id).join(FRAME);
                let native_src = if uses_native(item) {
                    Some((item.id.clone(), root.join(&item.id).join(&item.file)))
                } else if platform::NATIVE_IMAGES && cfg.still_frame && item.kind != Kind::Web && frame.is_file() {
                    Some((format!("{}#frame", item.id), frame.clone()))
                } else {
                    None
                };
                if let Some((native_id, path)) = native_src {
                    native_now.insert(d.key.clone());
                    let fit = native_fit(cfg.fit, (item.width, item.height), d);
                    let want = (native_id, fit);
                    if self.native.get(&d.key) != Some(&want) {
                        match platform::set_image(&self.app, d, &path, fit) {
                            Ok(()) => {
                                self.native.insert(d.key.clone(), want);
                            }
                            Err(e) => {
                                log(format!("set image on {}: {e}", d.name));
                                // Remember it anyway so we don't retry every second.
                                self.native.insert(d.key.clone(), want);
                            }
                        }
                    }
                }
                if uses_native(item) {
                    status = Status::Image;
                } else {
                    reason = [
                        (manual, "manual"),
                        (locked, "locked"),
                        (cfg.pause_battery && self.on_battery, "battery"),
                        (cfg.pause_low_power && self.low_power, "lowPower"),
                        (cfg.pause_covered && self.covered.contains(&d.key), "covered"),
                        (focused.contains(&d.key), "focused"),
                    ]
                    .into_iter()
                    .find(|(on, _)| *on)
                    .map(|(_, why)| why);
                    let paused = reason.is_some();
                    let wants_frame = platform::NATIVE_IMAGES && cfg.still_frame && item.kind != Kind::Web;
                    let params = PlayerParams {
                        kind: item.kind,
                        src: crate::library::Library::player_src(item),
                        fit: cfg.fit,
                        muted: cfg.muted,
                        volume: cfg.volume.clamp(0.0, 1.0),
                        speed: cfg.speed.clamp(0.25, 2.0),
                        paused,
                        shade,
                        capture: (wants_frame && !frame.is_file()).then(|| item.id.clone()),
                        fallback: core.loopback.clone(),
                    };
                    if self.ensure_player(&core, d, params) {
                        wanted.insert(d.key.clone());
                        status = if paused { Status::Paused } else { Status::Playing };
                    } else {
                        reason = None;
                    }
                }
            }
            views.push(DisplayView { display: d.clone(), item: assigned, status, reason });
        }
        self.native.retain(|k, _| native_now.contains(k));

        let stale: Vec<String> = self.slots.keys().filter(|k| !wanted.contains(*k)).cloned().collect();
        for key in stale {
            if let Some(slot) = self.slots.remove(&key) {
                core.players.lock().unwrap().remove(&slot.label);
                if let Some(w) = self.app.get_webview_window(&slot.label) {
                    let _ = w.destroy();
                    platform::after_close(&self.app);
                }
            }
        }

        // Visibility for the next tick (needs the windows to exist first).
        let wins: Vec<(String, WebviewWindow, Display)> = self
            .slots
            .iter()
            .filter_map(|(k, s)| self.app.get_webview_window(&s.label).map(|w| (k.clone(), w, s.display.clone())))
            .collect();
        let covered = if cfg.pause_covered && !wins.is_empty() { platform::covered(&self.app, &wins) } else { HashSet::new() };
        let covered_changed = covered != self.covered;
        if covered_changed {
            let mut keys: Vec<&String> = covered.iter().collect();
            keys.sort();
            log(format!("covered displays: {keys:?}"));
        }
        self.covered = covered;

        let changed = {
            let mut cur = core.displays.lock().unwrap();
            let changed = *cur != views;
            *cur = views;
            changed
        };
        if changed {
            core.emit_state();
        }
        if covered_changed {
            // Apply the new pause state right away rather than a second later.
            core.poke();
        }
    }

    /// Makes sure the display has a live player showing `params`. Returns false if there's no
    /// window (creation failed).
    fn ensure_player(&mut self, core: &Core, d: &Display, params: PlayerParams) -> bool {
        let mut label = self.slots.get(&d.key).map(|s| s.label.clone()).unwrap_or_else(|| label_for(&d.key));
        let mut existing = self.app.get_webview_window(&label);
        if let Some(win) = existing.take_if(|w| !platform::alive(w)) {
            // Destroyed with Explorer's desktop window when Explorer restarted. Tauri may keep the
            // label taken, so the new window gets a fresh one.
            log(format!("player on {} was destroyed (Explorer restarted?); making a new one", d.name));
            let _ = win.destroy();
            core.players.lock().unwrap().remove(&label);
            self.slots.remove(&d.key);
            self.respawns += 1;
            label = format!("{}-{}", label_for(&d.key), self.respawns);
        }
        match existing {
            Some(win) => {
                match self.slots.get_mut(&d.key) {
                    Some(slot) if slot.display == *d => platform::keep_attached(&self.app, &win, d),
                    Some(slot) => {
                        platform::attach(&self.app, &win, d);
                        slot.display = d.clone();
                    }
                    None => {
                        platform::attach(&self.app, &win, d);
                        self.slots.insert(d.key.clone(), Slot { label: label.clone(), display: d.clone() });
                    }
                }
                let mut players = core.players.lock().unwrap();
                if players.get(&label) != Some(&params) {
                    players.insert(label.clone(), params.clone());
                    drop(players);
                    let _ = self.app.emit_to(EventTarget::webview_window(&label), "player:update", params);
                }
                true
            }
            None => {
                // No window yet, or the old one was destroyed with Explorer's desktop window (above).
                self.slots.remove(&d.key);
                if self.failed.get(&d.key).is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
                    return false;
                }
                core.players.lock().unwrap().insert(label.clone(), params);
                match create_player(&self.app, &label, d) {
                    Ok(win) => {
                        platform::attach(&self.app, &win, d);
                        self.slots.insert(d.key.clone(), Slot { label, display: d.clone() });
                        self.failed.remove(&d.key);
                        log(format!("player up on {}", d.name));
                        true
                    }
                    Err(e) => {
                        log(format!("could not create the player for {}: {e}", d.name));
                        core.players.lock().unwrap().remove(&label);
                        self.failed.insert(d.key.clone(), Instant::now());
                        false
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_valid_and_stable() {
        let l = label_for(r"\\.\DISPLAY1");
        assert_eq!(l, label_for(r"\\.\DISPLAY1"));
        assert_ne!(l, label_for(r"\\.\DISPLAY2"));
        assert!(l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn height_fit() {
        let d = Display { key: "a".into(), name: "a".into(), x: 0, y: 0, width: 1920, height: 1080, scale: 1.0, primary: true };
        assert_eq!(native_fit(Fit::Height, (Some(3000), Some(1000)), &d), Fit::Cover);
        assert_eq!(native_fit(Fit::Height, (Some(1000), Some(1000)), &d), Fit::Contain);
        assert_eq!(native_fit(Fit::Height, (None, None), &d), Fit::Cover);
        assert_eq!(native_fit(Fit::Center, (None, None), &d), Fit::Center);
    }

    #[test]
    fn names() {
        assert_eq!(pretty_name(r"\\.\DISPLAY2", 0), "Display 2");
        assert_eq!(pretty_name("LG HDR 4K", 0), "LG HDR 4K");
        assert_eq!(pretty_name("", 2), "Display 3");
    }
}
