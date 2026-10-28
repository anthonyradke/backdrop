//! Linux and anything else: players are plain windows. Only used for development.

use crate::config::Fit;
use crate::engine::Display;
use std::collections::HashSet;
use std::path::Path;
use tauri::{AppHandle, LogicalPosition, LogicalSize, WebviewWindow};

pub const NATIVE_IMAGES: bool = false;

pub fn attach(_app: &AppHandle, win: &WebviewWindow, d: &Display) {
    let _ = win.set_position(LogicalPosition::new(d.x as f64 / d.scale, d.y as f64 / d.scale));
    let _ = win.set_size(LogicalSize::new(d.width as f64 / d.scale, d.height as f64 / d.scale));
    let _ = win.set_always_on_bottom(true);
    let _ = win.show();
}

pub fn alive(_win: &WebviewWindow) -> bool {
    true
}

pub fn keep_attached(_app: &AppHandle, _win: &WebviewWindow, _d: &Display) {}

pub fn set_image(_app: &AppHandle, _d: &Display, _path: &Path, _fit: Fit) -> Result<(), String> {
    Err("not supported on this OS".into())
}

pub fn covered(_app: &AppHandle, _wins: &[(String, WebviewWindow, Display)]) -> HashSet<String> {
    HashSet::new()
}

pub fn on_battery() -> bool {
    false
}

pub fn low_power() -> bool {
    false
}

pub fn locked() -> bool {
    false
}

pub fn focused(_app: &AppHandle, _displays: &[Display]) -> HashSet<String> {
    HashSet::new()
}

pub fn cleanup(_app: &AppHandle) {}

pub fn after_close(_app: &AppHandle) {}

/// Steam's install folder, if there is one.
pub fn steam_dir() -> Option<std::path::PathBuf> {
    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
    [".steam/steam", ".local/share/Steam"].iter().map(|p| home.join(p)).find(|p| p.is_dir())
}
