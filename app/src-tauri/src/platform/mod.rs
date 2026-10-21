//! Per-OS desktop integration. Every backend exposes the same functions:
//!
//! - `attach`: put a player window behind the desktop icons, covering one display
//! - `keep_attached`: cheap check, run every second, that repairs the attachment if the OS undid it
//! - `set_image`: set a still image as the OS wallpaper for one display (no window at all)
//! - `covered`: which displays' players can't currently be seen (fullscreen or maximized apps)
//! - `focused`: displays where another app's window is in front
//! - `on_battery`, `low_power`, `locked`, `cleanup`

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use other::*;
