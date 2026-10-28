//! Windows: players live inside Explorer's desktop window, below the icons.
//!
//! Sending Progman the undocumented 0x052C message makes Explorer create a WorkerW window behind
//! the desktop icons. Before Windows 11 24H2 that WorkerW is a top-level window right after the one
//! holding SHELLDLL_DefView (the icons), and we parent the player to it. On 24H2's "raised desktop"
//! (Progman has WS_EX_NOREDIRECTIONBITMAP), the WorkerW and the icons are both children of Progman:
//! the player becomes a layered child of Progman placed just under SHELLDLL_DefView, and the
//! WorkerW goes to the bottom. This is the same approach Lively Wallpaper uses.

use crate::config::Fit;
use crate::engine::Display;
use crate::{log, on_main};
use std::collections::HashSet;
use std::path::Path;
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::core::{w, BOOL, HSTRING, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MapWindowPoints, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE,
    WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK,
};
use windows::Win32::UI::Shell::{
    DesktopWallpaper, IDesktopWallpaper, DWPOS_CENTER, DWPOS_FILL, DWPOS_FIT, DWPOS_STRETCH,
};
use windows::Win32::UI::WindowsAndMessaging::*;

pub const NATIVE_IMAGES: bool = true;

#[derive(Clone, Copy)]
struct Desktop {
    progman: HWND,
    workerw: HWND,
    defview: HWND,
    raised: bool,
}

impl Desktop {
    fn parent(&self) -> HWND {
        if self.raised || self.workerw.is_invalid() {
            self.progman
        } else {
            self.workerw
        }
    }
}

fn hwnd_of(win: &WebviewWindow) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe fn find_desktop() -> Option<Desktop> {
    let progman = FindWindowW(w!("Progman"), PCWSTR::null()).ok().filter(|h| !h.is_invalid())?;
    let mut result = 0usize;
    SendMessageTimeoutW(progman, 0x052C, WPARAM(0xD), LPARAM(1), SMTO_NORMAL, 1000, Some(&mut result));

    let ex = GetWindowLongPtrW(progman, GWL_EXSTYLE) as u32;
    if ex & WS_EX_NOREDIRECTIONBITMAP.0 != 0 {
        let workerw = FindWindowExW(Some(progman), None, w!("WorkerW"), PCWSTR::null()).unwrap_or_default();
        let defview = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), PCWSTR::null()).unwrap_or_default();
        return Some(Desktop { progman, workerw, defview, raised: true });
    }

    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp.0 as *mut HWND);
        if FindWindowExW(Some(h), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok_and(|v| !v.is_invalid()) {
            if let Ok(ww) = FindWindowExW(None, Some(h), w!("WorkerW"), PCWSTR::null()) {
                *out = ww;
            }
        }
        BOOL(1)
    }
    let mut workerw = HWND::default();
    let _ = EnumWindows(Some(each), LPARAM(&mut workerw as *mut HWND as isize));
    Some(Desktop { progman, workerw, defview: HWND::default(), raised: false })
}

unsafe fn attach_now(h: HWND, d: &Display) {
    let Some(desk) = find_desktop() else {
        log("attach: no Progman window (is Explorer running?)");
        return;
    };
    let parent = desk.parent();

    let style = GetWindowLongPtrW(h, GWL_STYLE) as u32;
    let strip = WS_POPUP.0 | WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0;
    SetWindowLongPtrW(h, GWL_STYLE, ((style & !strip) | WS_CHILD.0 | WS_VISIBLE.0) as isize);
    let mut ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
    ex = (ex & !WS_EX_APPWINDOW.0) | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0;
    if desk.raised {
        ex |= WS_EX_LAYERED.0;
    }
    SetWindowLongPtrW(h, GWL_EXSTYLE, ex as isize);
    if desk.raised {
        let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);
    }
    if let Err(e) = SetParent(h, Some(parent)) {
        log(format!("attach: SetParent failed: {e}"));
    }

    // Monitor coordinates are virtual-screen pixels; the child is positioned in its parent's space.
    let mut pts = [POINT { x: d.x, y: d.y }];
    MapWindowPoints(None, Some(parent), &mut pts);
    let mut flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED;
    let after = if desk.raised && !desk.defview.is_invalid() {
        Some(desk.defview)
    } else {
        flags |= SWP_NOZORDER;
        None
    };
    let _ = SetWindowPos(h, after, pts[0].x, pts[0].y, d.width as i32, d.height as i32, flags);
    if desk.raised && !desk.workerw.is_invalid() {
        let _ = SetWindowPos(desk.workerw, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    log(format!(
        "attached player to {} ({}, {}x{} at {},{})",
        d.name,
        if desk.raised { "raised desktop" } else { "WorkerW" },
        d.width,
        d.height,
        pts[0].x,
        pts[0].y
    ));
}

pub fn attach(app: &AppHandle, win: &WebviewWindow, d: &Display) {
    let Some(h) = hwnd_of(win) else { return };
    let d = d.clone();
    on_main(app, move || unsafe { attach_now(HWND(h as _), &d) });
}

/// False once the window is gone underneath Tauri, which happens when Explorer restarts: the
/// players are children of its desktop window and get destroyed with it, while Tauri still hands
/// out the old `WebviewWindow`.
pub fn alive(win: &WebviewWindow) -> bool {
    hwnd_of(win).is_some_and(|h| unsafe { IsWindow(Some(HWND(h as _))).as_bool() })
}

pub fn keep_attached(app: &AppHandle, win: &WebviewWindow, d: &Display) {
    let Some(h) = hwnd_of(win) else { return };
    let ok = unsafe {
        GetParent(HWND(h as _))
            .ok()
            .filter(|p| !p.is_invalid() && IsWindow(Some(*p)).as_bool())
            .is_some_and(|p| matches!(class_name(p).as_str(), "Progman" | "WorkerW"))
    };
    if !ok {
        log(format!("player on {} lost its desktop parent; re-attaching", d.name));
        attach(app, win, d);
    }
}

fn rect_eq(r: &RECT, d: &Display) -> bool {
    r.left == d.x && r.top == d.y && r.right - r.left == d.width as i32 && r.bottom - r.top == d.height as i32
}

pub fn set_image(_app: &AppHandle, d: &Display, path: &Path, fit: Fit) -> Result<(), String> {
    let d = d.clone();
    let path = HSTRING::from(path.as_os_str());
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> Result<(), String> {
            let dw: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let n = dw.GetMonitorDevicePathCount().map_err(|e| e.to_string())?;
            let mut found = false;
            for i in 0..n {
                let Ok(id) = dw.GetMonitorDevicePathAt(i) else { continue };
                if dw.GetMonitorRECT(PCWSTR(id.0)).is_ok_and(|r| rect_eq(&r, &d)) {
                    dw.SetWallpaper(PCWSTR(id.0), PCWSTR(path.as_ptr())).map_err(|e| e.to_string())?;
                    found = true;
                }
                CoTaskMemFree(Some(id.0 as *const _));
            }
            // The engine turns Height into Cover or Contain before it gets here.
            let pos = match fit {
                Fit::Cover | Fit::Height => DWPOS_FILL,
                Fit::Contain => DWPOS_FIT,
                Fit::Stretch => DWPOS_STRETCH,
                Fit::Center => DWPOS_CENTER,
            };
            dw.SetPosition(pos).map_err(|e| e.to_string())?;
            if found {
                Ok(())
            } else {
                Err("display not found".into())
            }
        })();
        CoUninitialize();
        result
    })
    .join()
    .map_err(|_| "wallpaper thread panicked".to_string())?
}

/// Makes Explorer repaint the wallpaper. Only needed on the pre-24H2 layout, where the WorkerW
/// otherwise keeps showing a closed player's last frame; on the raised desktop the wallpaper is
/// simply underneath. Passing no path re-applies the current one (what Lively and Wallpaper Engine do).
fn refresh_desktop() {
    unsafe {
        let raised = FindWindowW(w!("Progman"), PCWSTR::null())
            .ok()
            .is_some_and(|p| GetWindowLongPtrW(p, GWL_EXSTYLE) as u32 & WS_EX_NOREDIRECTIONBITMAP.0 != 0);
        if !raised {
            let _ = SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, None, SPIF_UPDATEINIFILE);
        }
    }
}

pub fn after_close(_app: &AppHandle) {
    refresh_desktop();
}

struct CoverScan {
    pid: u32,
    foreground: HWND,
    hits: Vec<RECT>,
}

/// A display counts as covered when a visible, non-cloaked window from another app is maximized
/// on it, or fills it completely (fullscreen games and video). Click-through overlays don't count.
pub fn covered(_app: &AppHandle, wins: &[(String, WebviewWindow, Display)]) -> HashSet<String> {
    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> BOOL {
        let scan = &mut *(lp.0 as *mut CoverScan);
        if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() {
            return BOOL(1);
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0 {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == scan.pid {
            return BOOL(1);
        }
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if ex & (WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0) != 0 {
            return BOOL(1);
        }
        if matches!(
            class_name(h).as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow"
        ) {
            return BOOL(1);
        }
        let mon = MonitorFromWindow(h, MONITOR_DEFAULTTONULL);
        if mon.is_invalid() {
            return BOOL(1);
        }
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return BOOL(1);
        }
        let m = mi.rcMonitor;
        let zoomed = IsZoomed(h).as_bool();
        let mut r = RECT::default();
        let got = DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok()
            || GetWindowRect(h, &mut r).is_ok();
        let fills = got && r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
        // Only trust "fills the screen" for the foreground window or maximized ones; some apps
        // park big invisible helper windows that would otherwise pause everything.
        if zoomed || (fills && h == scan.foreground) || (fills && ex & WS_EX_TOOLWINDOW.0 == 0) {
            scan.hits.push(m);
        }
        BOOL(1)
    }

    let mut scan = CoverScan { pid: std::process::id(), foreground: unsafe { GetForegroundWindow() }, hits: vec![] };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut scan as *mut CoverScan as isize));
    }
    wins.iter()
        .filter(|(_, _, d)| scan.hits.iter().any(|r| rect_eq(r, d)))
        .map(|(k, _, _)| k.clone())
        .collect()
}

pub fn on_battery() -> bool {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s).is_ok() && s.ACLineStatus == 0 }
}

/// Battery saver (Energy saver on Windows 11).
pub fn low_power() -> bool {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s).is_ok() && s.SystemStatusFlag == 1 }
}

/// Whether this session's screen is locked. Anything unexpected counts as unlocked, so a failed
/// query never leaves the wallpaper paused.
pub fn locked() -> bool {
    unsafe {
        let mut buf = windows::core::PWSTR::null();
        let mut bytes = 0u32;
        if WTSQuerySessionInformationW(Some(WTS_CURRENT_SERVER_HANDLE), WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buf, &mut bytes)
            .is_err()
            || buf.is_null()
        {
            return false;
        }
        let locked = bytes as usize >= std::mem::size_of::<WTSINFOEXW>() && {
            let info = &*(buf.0 as *const WTSINFOEXW);
            info.Level == 1 && info.Data.WTSInfoExLevel1.SessionFlags as u32 == WTS_SESSIONSTATE_LOCK
        };
        WTSFreeMemory(buf.0 as *mut _);
        locked
    }
}

/// The display whose foreground window belongs to another app (not the desktop, the taskbar or
/// Backdrop itself).
pub fn focused(_app: &AppHandle, displays: &[Display]) -> HashSet<String> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() || IsIconic(fg).as_bool() {
            return HashSet::new();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == std::process::id()
            || matches!(
                class_name(fg).as_str(),
                "Progman"
                    | "WorkerW"
                    | "Shell_TrayWnd"
                    | "Shell_SecondaryTrayWnd"
                    | "Windows.UI.Core.CoreWindow"
                    | "XamlExplorerHostIslandWindow"
                    | "TopLevelWindowForOverflowXamlIsland"
            )
        {
            return HashSet::new();
        }
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if mon.is_invalid() || !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return HashSet::new();
        }
        displays.iter().filter(|d| rect_eq(&mi.rcMonitor, d)).map(|d| d.key.clone()).collect()
    }
}

pub fn cleanup(app: &AppHandle) {
    let players: Vec<_> = app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("wp-")).collect();
    for (_, w) in players {
        let _ = w.destroy();
    }
    refresh_desktop();
}

/// Steam's install folder, from the registry (HKCU\\Software\\Valve\\Steam\\SteamPath).
pub fn steam_dir() -> Option<std::path::PathBuf> {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    let err = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam"),
            w!("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    let path = if err.is_ok() {
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        std::path::PathBuf::from(String::from_utf16_lossy(&buf[..n]))
    } else {
        std::path::PathBuf::from(r"C:\Program Files (x86)\Steam")
    };
    path.is_dir().then_some(path)
}
