mod commands;
mod config;
mod engine;
mod library;
mod loopback;
mod media;
mod platform;
mod remote;

use config::Config;
use engine::{DisplayView, PlayerParams};
use library::{ItemView, Library};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::ManagerExt as _;

/// WebView2 options. Every webview in the app must use the same ones or WebView2 refuses to create
/// the second window. Autoplay with sound needs the policy flag; the occlusion flags stop WebView2
/// from deciding a wallpaper behind the desktop icons is hidden and throttling it.
#[cfg(windows)]
pub const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
     --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required";

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Appends a line to `backdrop.log` in the app data folder (kept under 1 MB).
pub fn log(msg: impl std::fmt::Display) {
    // eprintln! panics when stderr is a broken pipe, and release builds abort on panic.
    let _ = writeln!(std::io::stderr(), "[backdrop] {msg}");
    let Some(path) = LOG_PATH.get() else { return };
    if std::fs::metadata(path).map(|m| m.len() > 1 << 20).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.old"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {msg}", backdrop_common::now());
    }
}

/// Runs `f` on the main (UI) thread and waits for the result. AppKit window calls must happen
/// there. Never call this from the main thread itself.
pub fn on_main<R: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(5)).ok()
}

pub struct Core {
    pub app: AppHandle,
    config_path: PathBuf,
    pub config: Mutex<Config>,
    pub library: Mutex<Library>,
    pub manual_pause: AtomicBool,
    pub displays: Mutex<Vec<DisplayView>>,
    /// Window label -> what that player should show.
    pub players: Mutex<HashMap<String, PlayerParams>>,
    /// Item ids with an upload or download running.
    pub transfers: Mutex<HashSet<String>>,
    /// Base URL of the loopback server the player falls back to for video.
    pub loopback: Option<String>,
    engine: Mutex<Option<mpsc::Sender<()>>>,
    tray_pause: Mutex<Option<CheckMenuItem<Wry>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    config: Config,
    displays: Vec<DisplayView>,
    items: Vec<ItemView>,
    paused: bool,
    platform: &'static str,
    library_dir: String,
    autostart: bool,
    version: &'static str,
    transfers: Vec<String>,
    loopback: Option<String>,
}

impl Core {
    /// Wakes the engine so it applies changes now instead of on its next tick.
    pub fn poke(&self) {
        if let Some(tx) = self.engine.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }

    pub fn server(&self) -> Result<String, String> {
        let s = self.config.lock().unwrap().server.clone();
        if s.is_empty() {
            Err("no shared library set up (Settings)".into())
        } else {
            Ok(s)
        }
    }

    pub fn update_config(&self, f: impl FnOnce(&mut Config)) {
        {
            let mut c = self.config.lock().unwrap();
            f(&mut c);
            config::save(&self.config_path, &c);
        }
        self.poke();
        self.emit_state();
    }

    pub fn set_paused(&self, paused: bool) {
        self.manual_pause.store(paused, Ordering::Relaxed);
        if let Some(item) = self.tray_pause.lock().unwrap().as_ref() {
            let _ = item.set_checked(paused);
        }
        self.poke();
        self.emit_state();
    }

    pub fn state_view(&self) -> StateView {
        let (items, library_dir) = {
            let lib = self.library.lock().unwrap();
            (lib.views(), lib.root.to_string_lossy().to_string())
        };
        StateView {
            config: self.config.lock().unwrap().clone(),
            displays: self.displays.lock().unwrap().clone(),
            items,
            paused: self.manual_pause.load(Ordering::Relaxed),
            platform: std::env::consts::OS,
            library_dir,
            autostart: self.app.autolaunch().is_enabled().unwrap_or(false),
            version: env!("CARGO_PKG_VERSION"),
            transfers: self.transfers.lock().unwrap().iter().cloned().collect(),
            loopback: self.loopback.clone(),
        }
    }

    /// Pushes the full state to the library window, if it's open.
    pub fn emit_state(&self) {
        if self.app.get_webview_window("main").is_some() {
            let _ = self.app.emit_to("main", "state", self.state_view());
        }
    }
}

pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = app.show();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Backdrop")
        .inner_size(1120.0, 740.0)
        .min_inner_size(780.0, 520.0)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(7, 8, 11, 255));
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 21.0));
    #[cfg(windows)]
    let b = b.decorations(false).additional_browser_args(WEBVIEW_ARGS);
    match b.build() {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => log(format!("could not open the library window: {e}")),
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Backdrop", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause wallpapers", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Backdrop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
    *app.state::<Core>().tray_pause.lock().unwrap() = Some(pause);

    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = app.default_window_icon().cloned().expect("bundle icon");

    let tray = TrayIconBuilder::with_id("tray")
        .icon(icon)
        .tooltip("Backdrop")
        .menu(&menu)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "pause" => {
                let core = app.state::<Core>();
                let now = !core.manual_pause.load(Ordering::Relaxed);
                core.set_paused(now);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            // Windows convention: left click opens the window, right click shows the menu.
            #[cfg(not(target_os = "macos"))]
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
            #[cfg(target_os = "macos")]
            let _ = (tray, e);
        });
    #[cfg(target_os = "macos")]
    let tray = tray.icon_as_template(true).show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let tray = tray.show_menu_on_left_click(false);
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .register_asynchronous_uri_scheme_protocol("media", |ctx, req, responder| {
            let root = ctx.app_handle().state::<Core>().library.lock().unwrap().root.clone();
            std::thread::spawn(move || responder.respond(media::handle(&root, &req)));
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let _ = LOG_PATH.set(data.join("backdrop.log"));
            log(format!("starting {} on {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS));

            let config_path = data.join("config.json");
            let config = config::load(&config_path);
            let library = Library::open(data.join("library"));
            let loopback = loopback::start(library.root.clone());
            app.manage(Core {
                app: handle.clone(),
                config_path,
                config: Mutex::new(config),
                library: Mutex::new(library),
                manual_pause: AtomicBool::new(false),
                displays: Mutex::new(vec![]),
                players: Mutex::new(HashMap::new()),
                transfers: Mutex::new(HashSet::new()),
                loopback,
                engine: Mutex::new(None),
                tray_pause: Mutex::new(None),
            });

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(&handle)?;
            let tx = engine::spawn(handle.clone());
            *app.state::<Core>().engine.lock().unwrap() = Some(tx);

            if !std::env::args().any(|a| a == "--hidden") {
                show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the library window frees its webview; the app keeps running in the tray.
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::remote_items,
            commands::test_server,
            commands::import_paths,
            commands::pick_files,
            commands::save_thumb,
            commands::rename_item,
            commands::delete_local,
            commands::delete_remote,
            commands::upload,
            commands::download,
            commands::set_wallpaper,
            commands::clear_wallpaper,
            commands::update_settings,
            commands::set_paused,
            commands::set_autostart,
            commands::open_library_dir,
            commands::player_init,
            commands::player_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building backdrop")
        .run(|app, event| match event {
            // Windows closing (including the last one) never quits; only the tray's Quit does.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            RunEvent::Exit => {
                log("exiting");
                platform::cleanup(app);
            }
            _ => {}
        });
}
