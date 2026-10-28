//! Self-update from GitHub Releases (the same scheme as kit). Backdrop checks a few seconds after it
//! starts and then every few hours; installing only happens when asked, from the title bar button
//! or the tray menu.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Long enough for the window and the wallpapers to come up first.
const FIRST_CHECK: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct Shared {
    status: Mutex<Status>,
    pending: Mutex<Option<Update>>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub current: String,
    /// Newer version on GitHub, if any.
    pub available: Option<String>,
    pub notes: Option<String>,
    pub checking: bool,
    /// A check has finished at least once.
    pub checked: bool,
    /// Download progress in percent while installing.
    pub progress: Option<u8>,
    pub error: Option<String>,
}

pub fn init(app: &AppHandle) {
    let status = Status { current: app.package_info().version.to_string(), ..Status::default() };
    app.manage(Shared { status: Mutex::new(status), ..Shared::default() });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

pub fn status(app: &AppHandle) -> Status {
    app.state::<Shared>().status.lock().unwrap().clone()
}

fn set(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    let status = {
        let shared = app.state::<Shared>();
        let mut s = shared.status.lock().unwrap();
        f(&mut s);
        s.clone()
    };
    let _ = app.emit("update", status);
}

pub async fn check(app: &AppHandle) {
    {
        let shared = app.state::<Shared>();
        let mut s = shared.status.lock().unwrap();
        if s.checking || s.progress.is_some() {
            return;
        }
        s.checking = true;
    }
    let _ = app.emit("update", status(app));
    let result = match updater(app) {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    match result {
        Ok(update) => {
            let (available, notes) = match &update {
                Some(u) => (Some(u.version.clone()), u.body.clone().filter(|b| !b.trim().is_empty())),
                None => (None, None),
            };
            if let Some(v) = &available {
                crate::log(format!("update {v} is available"));
            }
            *app.state::<Shared>().pending.lock().unwrap() = update;
            set(app, |s| {
                s.available = available;
                s.notes = notes;
                s.error = None;
            });
        }
        // Being offline is normal; keep whatever we knew and only say why when someone asked.
        Err(e) => {
            crate::log(format!("update check failed: {e}"));
            set(app, |s| s.error = Some(e.to_string()));
        }
    }
    set(app, |s| {
        s.checking = false;
        s.checked = true;
    });
    crate::refresh_tray_update(app);
}

/// The installer replaces the exe while Backdrop is gone, and the updater ends the process with
/// `exit(0)`, which skips `RunEvent::Exit`; so take the wallpapers down here first.
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let handle = app.clone();
    app.updater_builder()
        .on_before_exit(move || {
            crate::log("installing an update");
            let h = handle.clone();
            crate::on_main(&handle, move || crate::platform::cleanup(&h));
            handle.cleanup_before_exit();
        })
        .build()
}

/// Downloads, verifies and runs the installer, which restarts Backdrop. Only returns on failure.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let update = app.state::<Shared>().pending.lock().unwrap().clone().ok_or("No update to install.")?;
    {
        let shared = app.state::<Shared>();
        let mut s = shared.status.lock().unwrap();
        if s.progress.is_some() {
            return Ok(());
        }
        s.progress = Some(0);
        s.error = None;
    }
    let _ = app.emit("update", status(app));
    let mut done = 0u64;
    let result = update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                if let Some(total) = total.filter(|&t| t > 0) {
                    let pct = (done * 100 / total).min(100) as u8;
                    if status(app).progress != Some(pct) {
                        set(app, |s| s.progress = Some(pct));
                    }
                }
            },
            || {},
        )
        .await;
    let err = match result {
        Ok(()) => "The installer didn't start.".to_string(),
        Err(e) => e.to_string(),
    };
    crate::log(format!("update failed: {err}"));
    set(app, |s| {
        s.progress = None;
        s.error = Some(err.clone());
    });
    Err(err)
}
