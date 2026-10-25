use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    #[default]
    Cover,
    Contain,
    Stretch,
    /// Original size, centered.
    Center,
    /// Scaled so the height matches the screen; the sides are cropped or left black.
    Height,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    Sequential,
    #[default]
    Shuffle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Rotation {
    /// Minutes between changes; 0 = never.
    pub minutes: u32,
    pub order: Order,
    /// Each display gets its own wallpaper instead of all showing the same one.
    pub per_display: bool,
    /// Item ids to rotate through, in order. Empty = every wallpaper on this computer.
    pub pool: Vec<String>,
    /// Pick a random wallpaper when Backdrop starts.
    pub on_start: bool,
    /// Pick a random wallpaper after the computer wakes from sleep (opening the lid).
    pub on_wake: bool,
}

impl Default for Rotation {
    fn default() -> Self {
        Self { minutes: 0, order: Order::Shuffle, per_display: false, pool: vec![], on_start: false, on_wake: false }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Display key -> item id.
    pub assignments: BTreeMap<String, String>,
    pub fit: Fit,
    pub muted: bool,
    /// 0.0 - 1.0
    pub volume: f64,
    /// Video playback rate, 0.25 - 2.0.
    pub speed: f64,
    /// Darken the strip under the taskbar so it stays readable.
    pub shade_bar: bool,
    /// Also set a frame of each moving wallpaper as the system wallpaper, so the desktop matches
    /// before the player starts.
    pub still_frame: bool,
    pub pause_covered: bool,
    /// Pause a display's wallpaper while another app's window is in front on it.
    pub pause_focused: bool,
    pub pause_battery: bool,
    /// Pause with battery saver on.
    pub pause_low_power: bool,
    /// Pause while the screen is locked.
    pub pause_locked: bool,
    /// UI language code (`en`, `es`, `de`, `zh-Hans`); empty = follow the system.
    pub language: String,
    pub rotation: Rotation,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            assignments: BTreeMap::new(),
            fit: Fit::Cover,
            muted: true,
            volume: 0.5,
            speed: 1.0,
            shade_bar: false,
            still_frame: true,
            pause_covered: true,
            pause_focused: false,
            pause_battery: true,
            pause_low_power: true,
            pause_locked: true,
            language: String::new(),
            rotation: Rotation::default(),
        }
    }
}

pub fn load(path: &Path) -> Config {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, cfg: &Config) {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(cfg).expect("config serializes");
    if std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path)).is_err() {
        crate::log(format!("could not save {}", path.display()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_config_fills_defaults() {
        // Old configs still have a "server" field; it's ignored.
        let c: Config = serde_json::from_str(r#"{"server":"https://a"}"#).unwrap();
        assert!(c.muted && c.pause_covered && c.still_frame);
        assert_eq!((c.speed, c.rotation.minutes, c.rotation.order), (1.0, 0, Order::Shuffle));
        let c: Config = serde_json::from_str(r#"{"fit":"height","rotation":{"minutes":30}}"#).unwrap();
        assert_eq!((c.fit, c.rotation.minutes, c.rotation.on_wake), (Fit::Height, 30, false));
    }
}
