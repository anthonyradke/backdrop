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
        // NSImageScaling: 1 = axes independently (stretch), 3 = proportionally up or down.
        let (scaling, clip) = match fit {
            Fit::Cover => (3, true),
            Fit::Contain => (3, false),
            Fit::Stretch => (1, false),
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

pub fn cleanup(_app: &AppHandle) {}
