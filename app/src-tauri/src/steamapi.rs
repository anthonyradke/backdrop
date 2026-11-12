//! Downloads workshop items the way Wallpaper Engine does: by asking the Steam client, running in
//! the background, through Steam's own `steam_api64.dll`, so no Steam window opens.
//!
//! The DLL isn't shipped with Backdrop. Wallpaper Engine's install has one, and that install is
//! needed anyway (only owners can download its workshop files). Steam treats whatever process loads
//! the DLL as Wallpaper Engine running until that process exits, so the main app never loads it: each
//! download runs in a short-lived helper, `backdrop.exe --steam-download <id>`, that subscribes,
//! waits for Steam to finish, and exits. If the DLL misbehaves, or someone presses Stop in Steam,
//! only the helper goes.
//!
//! The helper reports on stdout, one line each: `subscribed`, `progress <bytes> <total>`,
//! `installed`, or `error <message>`.

use crate::{log, Core};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const HELPER_ARG: &str = "--steam-download";

/// Workshop id -> (bytes downloaded, total), for downloads a helper is running.
static PROGRESS: Mutex<Option<HashMap<String, [u64; 2]>>> = Mutex::new(None);

pub fn progress() -> HashMap<String, [u64; 2]> {
    PROGRESS.lock().unwrap().clone().unwrap_or_default()
}

fn set_progress(id: &str, p: Option<[u64; 2]>) {
    let mut g = PROGRESS.lock().unwrap();
    let map = g.get_or_insert_with(HashMap::new);
    match p {
        Some(p) => map.insert(id.to_string(), p),
        None => map.remove(id),
    };
}

/// A line from the helper.
#[derive(Debug, PartialEq)]
enum Line {
    Subscribed,
    Progress(u64, u64),
    Installed,
    Error(String),
    /// Anything else (Steam's DLL prints to stdout too).
    Other,
}

fn parse(line: &str) -> Line {
    let mut parts = line.split(' ');
    match parts.next() {
        Some("subscribed") if line == "subscribed" => Line::Subscribed,
        Some("installed") if line == "installed" => Line::Installed,
        Some("progress") => match parts.map(str::parse::<u64>).collect::<Result<Vec<_>, _>>().as_deref() {
            Ok([done, total]) => Line::Progress(*done, *total),
            _ => Line::Other,
        },
        Some("error") if line.len() > 6 => Line::Error(line[6..].to_string()),
        _ => Line::Other,
    }
}

/// Stops a helper that's no longer wanted, without waiting for it here.
fn stop(mut child: std::process::Child) {
    let _ = child.kill();
    std::thread::spawn(move || child.wait());
}

/// Subscribes to `id` through a helper process. Returns once Steam has taken the subscription (the
/// download carries on, and the workshop sync loop imports it when it lands), or with an error if
/// that can't happen this way, so the caller can fall back to opening the item in Steam.
pub fn download(app: &AppHandle, id: &str) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("only on Windows".into());
    }
    // A second click while the first download runs: that one carries on.
    if progress().contains_key(id) {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.args([HELPER_ARG, id])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start the download helper: {e}"))?;
    let stdout = child.stdout.take().expect("piped");

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    // Subscribing is one round trip to Steam's servers; the helper gives up on its own after 15s.
    // One that hasn't answered by the deadline is stuck (inside Steam's init, say) and is stopped,
    // or Steam would go on showing Wallpaper Engine as running.
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left).map(|l| parse(&l)) {
            Ok(Line::Subscribed) => break,
            Ok(Line::Error(e)) => {
                stop(child);
                return Err(e);
            }
            Ok(_) => {}
            Err(_) => {
                stop(child);
                return Err("the download helper didn't answer".into());
            }
        }
    }
    log(format!("workshop item {id}: subscribed through Steam, downloading"));
    set_progress(id, Some([0, 0]));
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        for line in rx {
            match parse(&line) {
                Line::Progress(done, total) => {
                    set_progress(&id, Some([done, total]));
                    app.state::<Core>().emit_state();
                }
                Line::Installed => log(format!("workshop item {id}: Steam finished downloading")),
                Line::Error(e) => log(format!("workshop item {id}: {e}")),
                _ => {}
            }
        }
        let _ = child.wait();
        // The helper exited. Steam keeps the subscription either way, and the sync loop takes the
        // item from Steam's folder whenever it's complete.
        set_progress(&id, None);
        app.state::<Core>().emit_state();
    });
    Ok(())
}

/// The helper process. Returns the exit code.
pub fn helper(id: Option<&str>) -> i32 {
    use std::io::Write;
    let say = |s: String| {
        let mut out = std::io::stdout().lock();
        // Backdrop is gone if this fails; nothing left to report to.
        if writeln!(out, "{s}").and_then(|_| out.flush()).is_err() {
            std::process::exit(3);
        }
    };
    let Some(id) = id.and_then(|s| s.parse::<u64>().ok()) else {
        say("error bad workshop id".into());
        return 2;
    };
    match imp::run(id, &say) {
        Ok(()) => 0,
        Err(e) => {
            say(format!("error {e}"));
            1
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn run(_id: u64, _say: &dyn Fn(String)) -> Result<(), String> {
        Err("only on Windows".into())
    }
}

#[cfg(windows)]
mod imp {
    use crate::workshop::{steam_libraries, APP_ID};
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};
    use windows::core::{s, HSTRING, PCSTR};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};

    // EItemState flags.
    const SUBSCRIBED: u32 = 1;
    const INSTALLED: u32 = 4;
    const NEEDS_UPDATE: u32 = 8;
    const DOWNLOADING: u32 = 16;
    const DOWNLOAD_PENDING: u32 = 32;
    /// How long a download may sit without any bytes arriving.
    const STALLED: Duration = Duration::from_secs(5 * 60);

    /// The flat C API, the part we use.
    struct Api {
        run_callbacks: unsafe extern "C" fn(),
        shutdown: unsafe extern "C" fn(),
        ugc: *mut c_void,
        subscribe: unsafe extern "C" fn(*mut c_void, u64) -> u64,
        download: unsafe extern "C" fn(*mut c_void, u64, bool) -> bool,
        state: unsafe extern "C" fn(*mut c_void, u64) -> u32,
        info: unsafe extern "C" fn(*mut c_void, u64, *mut u64, *mut u64) -> bool,
    }

    /// Wallpaper Engine's `steam_api64.dll`, in whichever Steam library it's installed in.
    fn dll_path() -> Option<PathBuf> {
        steam_libraries().into_iter().find_map(|lib| {
            let we = lib.join("steamapps").join("common").join("wallpaper_engine");
            [we.join("bin").join("steam_api64.dll"), we.join("steam_api64.dll")].into_iter().find(|p| p.is_file())
        })
    }

    unsafe fn sym<T>(m: HMODULE, name: PCSTR) -> Result<T, String> {
        let f = GetProcAddress(m, name).ok_or_else(|| format!("steam_api64.dll has no {}", name.display()))?;
        Ok(std::mem::transmute_copy(&f))
    }

    impl Api {
        unsafe fn open() -> Result<Api, String> {
            let path = dll_path().ok_or("Wallpaper Engine isn't installed in Steam")?;
            let m = LoadLibraryExW(&HSTRING::from(path.as_os_str()), None, LOAD_WITH_ALTERED_SEARCH_PATH)
                .map_err(|e| format!("couldn't load {}: {e}", path.display()))?;
            let running: unsafe extern "C" fn() -> bool = sym(m, s!("SteamAPI_IsSteamRunning"))?;
            if !running() {
                return Err("Steam isn't running".into());
            }
            // Which app we are, for Steam. Set before init, while this process has one thread.
            std::env::set_var("SteamAppId", APP_ID.to_string());
            std::env::set_var("SteamGameId", APP_ID.to_string());
            match sym::<unsafe extern "C" fn(*mut [u8; 1024]) -> i32>(m, s!("SteamAPI_InitFlat")) {
                Ok(init) => {
                    let mut msg = [0u8; 1024];
                    if init(&mut msg) != 0 {
                        let n = msg.iter().position(|&b| b == 0).unwrap_or(msg.len());
                        return Err(format!("Steam said no: {}", String::from_utf8_lossy(&msg[..n])));
                    }
                }
                Err(_) => {
                    let init: unsafe extern "C" fn() -> bool = sym(m, s!("SteamAPI_InitSafe"))?;
                    if !init() {
                        return Err("Steam said no (is Wallpaper Engine in your library?)".into());
                    }
                }
            }
            let shutdown: unsafe extern "C" fn() = sym(m, s!("SteamAPI_Shutdown"))?;
            // The interface version moves with the SDK; take the newest this DLL has.
            let ugc = [s!("SteamAPI_SteamUGC_v021"), s!("SteamAPI_SteamUGC_v020"), s!("SteamAPI_SteamUGC_v019"), s!("SteamAPI_SteamUGC_v018")]
                .into_iter()
                .find_map(|n| sym::<unsafe extern "C" fn() -> *mut c_void>(m, n).ok())
                .map(|get| get())
                .filter(|p| !p.is_null());
            let Some(ugc) = ugc else {
                shutdown();
                return Err("this steam_api64.dll is too old or too new".into());
            };
            Ok(Api {
                run_callbacks: sym(m, s!("SteamAPI_RunCallbacks"))?,
                shutdown,
                ugc,
                subscribe: sym(m, s!("SteamAPI_ISteamUGC_SubscribeItem"))?,
                download: sym(m, s!("SteamAPI_ISteamUGC_DownloadItem"))?,
                state: sym(m, s!("SteamAPI_ISteamUGC_GetItemState"))?,
                info: sym(m, s!("SteamAPI_ISteamUGC_GetItemDownloadInfo"))?,
            })
        }

        fn state(&self, id: u64) -> u32 {
            unsafe {
                (self.run_callbacks)();
                (self.state)(self.ugc, id)
            }
        }
    }

    impl Drop for Api {
        fn drop(&mut self) {
            unsafe { (self.shutdown)() }
        }
    }

    pub fn run(id: u64, say: &dyn Fn(String)) -> Result<(), String> {
        let api = unsafe { Api::open()? };
        if api.state(id) & SUBSCRIBED == 0 {
            if unsafe { (api.subscribe)(api.ugc, id) } == 0 {
                return Err("Steam wouldn't subscribe".into());
            }
            let t = Instant::now();
            while api.state(id) & SUBSCRIBED == 0 {
                if t.elapsed() > Duration::from_secs(15) {
                    return Err("Steam didn't confirm the subscription".into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        say("subscribed".into());
        // High priority: start now rather than whenever Steam gets to it.
        unsafe { (api.download)(api.ugc, id, true) };

        let t = Instant::now();
        let (mut last, mut said) = ([0, u64::MAX], Instant::now());
        // When the downloaded size last changed, or Steam last said it's working on it.
        let mut moving = Instant::now();
        loop {
            let st = api.state(id);
            if st & INSTALLED != 0 && st & (NEEDS_UPDATE | DOWNLOADING | DOWNLOAD_PENDING) == 0 {
                say("installed".into());
                return Ok(());
            }
            let (mut done, mut total) = (0u64, 0u64);
            unsafe { (api.info)(api.ugc, id, &mut done, &mut total) };
            if done != last[0] || (st & (DOWNLOADING | DOWNLOAD_PENDING) != 0 && done == 0) {
                moving = Instant::now();
            }
            // Removed from the workshop, out of disk space, or Steam lost interest: there's no sense
            // in holding the helper (and "Wallpaper Engine running" in Steam) open for hours.
            if moving.elapsed() > STALLED {
                return Err(format!("Steam hasn't moved this download for {} minutes; leaving it to Steam", STALLED.as_secs() / 60));
            }
            // Every whole percent, and now and then regardless so a gone Backdrop is noticed.
            let pct = |d: u64, t: u64| (d * 100).checked_div(t).unwrap_or(0);
            if pct(done, total) != pct(last[0], last[1]) || total != last[1] || said.elapsed() > Duration::from_secs(10) {
                say(format!("progress {done} {total}"));
                (last, said) = ([done, total], Instant::now());
            }
            if t.elapsed() > Duration::from_secs(2 * 3600) {
                return Err("still not downloaded after two hours; leaving it to Steam".into());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_lines() {
        assert_eq!(parse("subscribed"), Line::Subscribed);
        assert_eq!(parse("installed"), Line::Installed);
        assert_eq!(parse("progress 10 200"), Line::Progress(10, 200));
        assert_eq!(parse("progress 10"), Line::Other);
        assert_eq!(parse("progress a b"), Line::Other);
        assert_eq!(parse("error Steam isn't running"), Line::Error("Steam isn't running".into()));
        assert_eq!(parse("[S_API] SteamAPI_Init(): Loaded"), Line::Other);
        assert_eq!(parse("subscribed but not"), Line::Other);
    }
}
