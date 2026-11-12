// Commands get permissions, so each window can be limited to the ones it uses (capabilities/).
// Every command in `generate_handler!` in lib.rs must be listed here.
const COMMANDS: &[&str] = &[
    "get_state",
    "import_paths",
    "pick_files",
    "save_thumb",
    "rename_item",
    "delete_items",
    "set_wallpaper",
    "cursor_position",
    "audio_spectrum",
    "now_playing",
    "span_wallpaper",
    "clear_wallpaper",
    "update_settings",
    "set_paused",
    "set_autostart",
    "open_library_dir",
    "player_init",
    "player_log",
    "player_stats",
    "set_in_rotation",
    "set_in_display_rotation",
    "set_schedule",
    "set_app_rules",
    "running_apps",
    "next_wallpaper",
    "save_frame",
    "reset_settings",
    "item_properties",
    "set_item_properties",
    "workshop_browse",
    "workshop_subscribed",
    "workshop_subscribe",
    "workshop_open",
    "workshop_open_steam",
    "workshop_add",
    "workshop_hide",
    "workshop_unhide_all",
    "update_state",
    "check_update",
    "install_update",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build");
}
