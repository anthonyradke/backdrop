//! Converts videos WebView2 can't play (HEVC, ProRes) to H.264 with FFmpeg, when FFmpeg is
//! installed. Windows has no ProRes decoder at all and decodes HEVC only with a separate Store
//! extension, so Media Foundation can't do this reliably; FFmpeg can. Backdrop doesn't ship it (a
//! build with libx264 is GPL and about 100 MB); the library's Install FFmpeg button has winget fetch
//! it instead, which checks the download against its manifest's hash and keeps it updated.
//!
//! The converted file is imported as a new item that takes the old one's name, properties and place
//! (`Core::replace_item`), and the old item goes.

use crate::{common, library, log, Core};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Item id -> percent done, for conversions running now.
static PROGRESS: Mutex<Option<HashMap<String, u8>>> = Mutex::new(None);
/// The FFmpeg processes running now, so quitting Backdrop can stop them.
static RUNNING: Mutex<Vec<Arc<Mutex<Child>>>> = Mutex::new(vec![]);

pub fn progress() -> HashMap<String, u8> {
    PROGRESS.lock().unwrap().clone().unwrap_or_default()
}

fn set_progress(id: &str, p: Option<u8>) {
    let mut g = PROGRESS.lock().unwrap();
    let map = g.get_or_insert_with(HashMap::new);
    match p {
        Some(p) => map.insert(id.to_string(), p),
        None => map.remove(id),
    };
}

/// Where `ffmpeg()` last found FFmpeg, and when it looked.
static FOUND: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);
/// winget is installing FFmpeg now.
static INSTALLING: AtomicBool = AtomicBool::new(false);

pub fn installing() -> bool {
    INSTALLING.load(Ordering::Relaxed)
}

/// `ffmpeg.exe` on the PATH or where winget and the usual manual installs put it. Looked up at most
/// once a minute, since the library window asks with every update.
pub fn ffmpeg() -> Option<PathBuf> {
    let mut cache = FOUND.lock().unwrap();
    if let Some((at, found)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(60) {
            return found.clone();
        }
    }
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    // winget's links folders aren't on this process's PATH until Backdrop restarts after an install.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(Path::new(&local).join("Microsoft").join("WinGet").join("Links"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        dirs.push(Path::new(&pf).join("WinGet").join("Links"));
    }
    dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
    let found = dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file());
    *cache = Some((Instant::now(), found.clone()));
    found
}

/// Installs FFmpeg with winget (the Gyan.FFmpeg package, which links `ffmpeg.exe` into winget's
/// links folder). Blocks until winget is done, which takes a minute or so for the download.
pub fn install(core: &Core) -> Result<(), String> {
    if ffmpeg().is_some() {
        return Ok(());
    }
    if INSTALLING.swap(true, Ordering::Relaxed) {
        return Ok(());
    }
    core.emit_state();
    log("installing FFmpeg with winget");
    let mut cmd = Command::new("winget");
    cmd.args(["install", "--id", "Gyan.FFmpeg", "--exact", "--source", "winget", "--silent"])
        .args(["--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"])
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output();
    *FOUND.lock().unwrap() = None;
    let found = ffmpeg().is_some();
    INSTALLING.store(false, Ordering::Relaxed);
    core.emit_state();
    let out = match out {
        Err(e) => {
            log(format!("couldn't run winget: {e}"));
            return Err("winget isn't available here. Install FFmpeg from ffmpeg.org and restart Backdrop.".into());
        }
        Ok(o) => o,
    };
    if found {
        log("FFmpeg installed");
        return Ok(());
    }
    // winget redraws its progress with \r, so only the last piece of each line is what it said.
    let text = String::from_utf8_lossy(&out.stdout);
    let said: Vec<&str> = text.lines().filter_map(|l| l.rsplit('\r').map(str::trim).find(|p| !p.is_empty())).collect();
    let tail = said[said.len().saturating_sub(3)..].join(" | ");
    log(format!("winget didn't install FFmpeg ({}): {tail}", out.status));
    Err(if tail.is_empty() { "winget couldn't install FFmpeg".to_string() } else { format!("winget couldn't install FFmpeg: {tail}") })
}

/// "Duration: 00:01:02.50," from FFmpeg's banner, in seconds.
fn duration(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("Duration:")?.trim_start();
    let hms = rest.split(',').next()?.trim();
    let mut parts = hms.split(':');
    let (h, m, s): (f64, f64, f64) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Starts converting `id`. Returns once FFmpeg is running; the result lands in the library (or the
/// log) when it's done.
pub fn start(app: &AppHandle, id: &str) -> Result<(), String> {
    let ffmpeg = ffmpeg().ok_or("FFmpeg isn't installed")?;
    if progress().contains_key(id) {
        return Ok(());
    }
    let core = app.state::<Core>();
    let (src, root, item) = {
        let lib = core.library.lock().unwrap();
        let item = lib.items.get(id).cloned().ok_or("not in the library")?;
        if item.kind != common::Kind::Video {
            return Err("only videos can be converted".into());
        }
        (lib.dir(id).join(&item.file), lib.root.clone(), item)
    };
    // Named like import staging, so a leftover from a crash is cleared on the next start.
    let out = root.join(format!(".import-convert-{id}.mp4"));
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(&src)
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"])
        .args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats"])
        .arg(&out)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start FFmpeg: {e}"))?;
    let (stdout, stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let child = Arc::new(Mutex::new(child));
    RUNNING.lock().unwrap().push(child.clone());
    set_progress(id, Some(0));
    core.emit_state();
    log(format!("converting {id} ({}) to H.264", item.codec.as_deref().unwrap_or("?")));

    // The banner (on stderr) has the length; the progress lines (stdout) have how far along it is.
    let total = Arc::new(Mutex::new(None::<f64>));
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let (total, tail) = (total.clone(), tail.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(d) = duration(&line) {
                    total.lock().unwrap().get_or_insert(d);
                }
                let mut t = tail.lock().unwrap();
                t.push(line);
                if t.len() > 8 {
                    t.remove(0);
                }
            }
        });
    }
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        let core = app.state::<Core>();
        let mut shown = 0u8;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) else { continue };
            let Some(total) = *total.lock().unwrap() else { continue };
            let pct = ((us / 1e6 / total) * 100.0).clamp(0.0, 99.0) as u8;
            if pct != shown {
                shown = pct;
                set_progress(&id, Some(pct));
                core.emit_state();
            }
        }
        // Polled rather than waited on, so stop_all can take the lock to kill it.
        let ok = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) => {}
                Err(_) => break false,
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        RUNNING.lock().unwrap().retain(|c| !Arc::ptr_eq(c, &child));
        let result = if ok { finish(&core, &item, &out) } else { Err(tail.lock().unwrap().join(" | ")) };
        let _ = std::fs::remove_file(&out);
        set_progress(&id, None);
        match result {
            Ok(new) => log(format!("converted {id}; {new} replaces it")),
            Err(e) => log(format!("converting {id} failed: {e}")),
        }
        core.emit_state();
    });
    Ok(())
}

/// Imports the converted file in place of the original.
fn finish(core: &Core, old: &common::Item, out: &Path) -> Result<String, String> {
    let new = library::import_into(core, out, false, |item, dir| {
        item.name = old.name.clone();
        item.tags = old.tags.clone();
        item.workshop = old.workshop.clone();
        item.source_mtime = old.source_mtime;
        let _ = library::write_meta(dir, item);
    })
    .map_err(|e| e.to_string())?;
    if new.id != old.id {
        core.replace_item(&old.id, &new.id);
    }
    Ok(new.id)
}

/// Stops conversions still running (Backdrop is quitting).
pub fn stop_all() {
    for c in RUNNING.lock().unwrap().drain(..) {
        let _ = c.lock().unwrap().kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_length() {
        assert_eq!(duration("  Duration: 00:01:02.50, start: 0.000000, bitrate: 5000 kb/s"), Some(62.5));
        assert_eq!(duration("  Duration: 01:00:00.00, start"), Some(3600.0));
        assert_eq!(duration("  Duration: N/A, bitrate: N/A"), None);
        assert_eq!(duration("Stream #0:0"), None);
    }
}
