//! macOS: players are borderless windows at the desktop window level (above the wallpaper, below
//! the Finder icons), on every Space, ignoring the mouse and left out of Mission Control and
//! Cmd-Tab. Still images go through NSWorkspace, the same API System Settings uses.

use crate::config::Fit;
use crate::engine::Display;
use crate::{log, on_main};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSDictionary, NSNumber, NSPoint, NSRect, NSSize, NSString, NSURL};
use std::collections::HashSet;
use std::ffi::{c_char, c_void};
use std::path::Path;
use tauri::{AppHandle, WebviewWindow};

pub const NATIVE_IMAGES: bool = true;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
    fn CGSessionCopyCurrentDictionary() -> *const c_void;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPSCopyPowerSourcesInfo() -> *const c_void;
    fn IOPSGetProvidingPowerSourceType(snapshot: *const c_void) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
    fn CFStringGetCString(s: *const c_void, buf: *mut c_char, size: isize, encoding: u32) -> u8;
}

const K_CG_DESKTOP_WINDOW_LEVEL_KEY: i32 = 2;
// NSWindowCollectionBehavior
const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
const STATIONARY: usize = 1 << 4;
const IGNORES_CYCLE: usize = 1 << 6;
const FULL_SCREEN_NONE: usize = 1 << 9;
// NSWindowOcclusionState
const OCCLUSION_VISIBLE: usize = 1 << 1;

fn ns_of(win: &WebviewWindow) -> Option<usize> {
    win.ns_window().ok().map(|p| p as usize)
}

/// Finds the NSScreen for a display. Monitor positions are top-left based (physical pixels =
/// points x scale); NSScreen frames are in points with a bottom-left origin on the main screen.
unsafe fn screen_for(d: &Display) -> Option<(*mut AnyObject, NSRect)> {
    let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
    let n: usize = msg_send![screens, count];
    let mut all = Vec::with_capacity(n);
    for i in 0..n {
        let s: *mut AnyObject = msg_send![screens, objectAtIndex: i];
        let f: NSRect = msg_send![s, frame];
        all.push((s, f));
    }
    let primary_h = all.first()?.1.size.height;
    let (x, y) = (d.x as f64 / d.scale, d.y as f64 / d.scale);
    let (w, h) = (d.width as f64 / d.scale, d.height as f64 / d.scale);
    let cocoa_y = primary_h - (y + h);
    all.into_iter()
        .map(|(s, f)| {
            let err = (f.origin.x - x).abs()
                + (f.origin.y - cocoa_y).abs()
                + (f.size.width - w).abs()
                + (f.size.height - h).abs();
            (err, s, f)
        })
        .filter(|(err, _, _)| *err < 8.0)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, s, f)| (s, f))
}

unsafe fn attach_now(w: *mut AnyObject, d: &Display) {
    let level = CGWindowLevelForKey(K_CG_DESKTOP_WINDOW_LEVEL_KEY) as isize + 1;
    let _: () = msg_send![w, setLevel: level];
    let behavior = CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE | FULL_SCREEN_NONE;
    let _: () = msg_send![w, setCollectionBehavior: behavior];
    let _: () = msg_send![w, setIgnoresMouseEvents: true];
    let _: () = msg_send![w, setHasShadow: false];
    let _: () = msg_send![w, setCanHide: false];
    let frame = match screen_for(d) {
        Some((_, f)) => f,
        None => {
            log(format!("attach: no NSScreen matches {}; using monitor geometry", d.name));
            let s: *mut AnyObject = msg_send![class!(NSScreen), mainScreen];
            let main: NSRect = msg_send![s, frame];
            let (x, y) = (d.x as f64 / d.scale, d.y as f64 / d.scale);
            let (wd, ht) = (d.width as f64 / d.scale, d.height as f64 / d.scale);
            NSRect::new(NSPoint::new(x, main.size.height - (y + ht)), NSSize::new(wd, ht))
        }
    };
    let _: () = msg_send![w, setFrame: frame, display: true];
    let _: () = msg_send![w, orderFront: std::ptr::null::<AnyObject>()];
    log(format!("attached player to {} ({}x{} pt)", d.name, frame.size.width, frame.size.height));
}

pub fn attach(app: &AppHandle, win: &WebviewWindow, d: &Display) {
    let Some(p) = ns_of(win) else { return };
    let d = d.clone();
    on_main(app, move || unsafe { attach_now(p as *mut AnyObject, &d) });
}

pub fn keep_attached(_app: &AppHandle, _win: &WebviewWindow, _d: &Display) {}

pub fn after_close(_app: &AppHandle) {}

pub fn set_image(app: &AppHandle, d: &Display, path: &Path, fit: Fit) -> Result<(), String> {
    let d = d.clone();
    let path = path.to_string_lossy().to_string();
    on_main(app, move || unsafe {
        let (screen, _) = screen_for(&d).ok_or("no matching screen")?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
        // NSImageScaling: 1 = axes independently (stretch), 2 = none, 3 = proportionally up or down.
        // The engine turns Height into Cover or Contain before it gets here.
        let (scaling, clip) = match fit {
            Fit::Cover | Fit::Height => (3, true),
            Fit::Contain => (3, false),
            Fit::Stretch => (1, false),
            Fit::Center => (2, false),
        };
        let keys = [
            objc2_app_kit::NSWorkspaceDesktopImageScalingKey,
            objc2_app_kit::NSWorkspaceDesktopImageAllowClippingKey,
        ];
        let vals: [Retained<NSNumber>; 2] = [NSNumber::new_isize(scaling), NSNumber::new_bool(clip)];
        let opts = NSDictionary::from_slices(&keys, &[&*vals[0], &*vals[1]]);
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = msg_send![ws, setDesktopImageURL: &*url, forScreen: screen, options: &*opts, error: &mut err];
        if ok {
            Ok(())
        } else {
            Err("NSWorkspace refused the image".to_string())
        }
    })
    .unwrap_or_else(|| Err("main thread busy".into()))
}

/// Players macOS reports as not visible at all: behind a fullscreen app's Space, or under
/// windows that cover the whole screen.
pub fn covered(app: &AppHandle, wins: &[(String, WebviewWindow, Display)]) -> HashSet<String> {
    let list: Vec<(String, usize)> = wins.iter().filter_map(|(k, w, _)| ns_of(w).map(|p| (k.clone(), p))).collect();
    on_main(app, move || {
        list.into_iter()
            .filter(|(_, p)| unsafe {
                let state: usize = msg_send![*p as *mut AnyObject, occlusionState];
                state & OCCLUSION_VISIBLE == 0
            })
            .map(|(k, _)| k)
            .collect()
    })
    .unwrap_or_default()
}

pub fn on_battery() -> bool {
    unsafe {
        let info = IOPSCopyPowerSourcesInfo();
        if info.is_null() {
            return false;
        }
        let kind = IOPSGetProvidingPowerSourceType(info);
        let mut buf = [0 as c_char; 64];
        let battery = !kind.is_null()
            && CFStringGetCString(kind, buf.as_mut_ptr(), buf.len() as isize, 0x0800_0100) != 0
            && std::ffi::CStr::from_ptr(buf.as_ptr()).to_bytes() == b"Battery Power";
        CFRelease(info);
        battery
    }
}

pub fn low_power() -> bool {
    unsafe {
        let pi: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let sel = objc2::sel!(isLowPowerModeEnabled);
        let has: bool = msg_send![pi, respondsToSelector: sel];
        if !has {
            return false;
        }
        let on: bool = msg_send![pi, isLowPowerModeEnabled];
        on
    }
}

unsafe fn number(dict: *mut AnyObject, key: &str) -> Option<f64> {
    let v: *mut AnyObject = msg_send![dict, objectForKey: &*NSString::from_str(key)];
    if v.is_null() {
        return None;
    }
    Some(msg_send![v, doubleValue])
}

/// The session dictionary says whether the login window is covering the screen.
pub fn locked() -> bool {
    unsafe {
        let d = CGSessionCopyCurrentDictionary();
        if d.is_null() {
            return false;
        }
        let locked = number(d as *mut AnyObject, "CGSSessionScreenIsLocked").is_some_and(|v| v != 0.0);
        CFRelease(d);
        locked
    }
}

/// The display holding the frontmost app's front window, unless that app is Finder (the desktop)
/// or Backdrop.
pub fn focused(app: &AppHandle, displays: &[Display]) -> HashSet<String> {
    let displays = displays.to_vec();
    on_main(app, move || unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return HashSet::new();
        }
        let pid: i32 = msg_send![front, processIdentifier];
        let bundle: *mut AnyObject = msg_send![front, bundleIdentifier];
        let finder = !bundle.is_null() && {
            let b = &*(bundle as *const NSString);
            b.to_string() == "com.apple.finder"
        };
        if finder || pid as u32 == std::process::id() {
            return HashSet::new();
        }
        // On-screen windows, front to back, without the desktop's own.
        let list = CGWindowListCopyWindowInfo(1 | 1 << 4, 0);
        if list.is_null() {
            return HashSet::new();
        }
        let arr = list as *mut AnyObject;
        let n: usize = msg_send![arr, count];
        let mut center = None;
        for i in 0..n {
            let w: *mut AnyObject = msg_send![arr, objectAtIndex: i];
            if number(w, "kCGWindowOwnerPID") != Some(pid as f64) || number(w, "kCGWindowLayer") != Some(0.0) {
                continue;
            }
            let b: *mut AnyObject = msg_send![w, objectForKey: &*NSString::from_str("kCGWindowBounds")];
            if b.is_null() {
                continue;
            }
            if let (Some(x), Some(y), Some(wd), Some(ht)) =
                (number(b, "X"), number(b, "Y"), number(b, "Width"), number(b, "Height"))
            {
                // Skip slivers like status windows; a real window is bigger than this.
                if wd > 80.0 && ht > 80.0 {
                    center = Some((x + wd / 2.0, y + ht / 2.0));
                    break;
                }
            }
        }
        CFRelease(list);
        let Some((cx, cy)) = center else { return HashSet::new() };
        // Window bounds are points from the main screen's top-left, like monitor position / scale.
        displays
            .iter()
            .filter(|d| {
                let (x, y) = (d.x as f64 / d.scale, d.y as f64 / d.scale);
                let (w, h) = (d.width as f64 / d.scale, d.height as f64 / d.scale);
                cx >= x && cx < x + w && cy >= y && cy < y + h
            })
            .map(|d| d.key.clone())
            .collect()
    })
    .unwrap_or_default()
}

pub fn cleanup(_app: &AppHandle) {}
