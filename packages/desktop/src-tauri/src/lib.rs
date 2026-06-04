// Docent Desktop — Tauri v2 application library entry point.
//
// Registers all Tauri commands, initialises the capture layer, and sets up
// the event channel between the capture thread and the frontend.
//
// Requirements:
// - 1.1: Tauri v2 application structure
// - 1.2: Tauri v2 as the application framework
// - 1.5: Platform-specific code behind a common trait

pub mod capture;
pub mod commands;
pub mod secret_store;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

use commands::AppState;

/// Run the Tauri application.
///
/// 1. Creates the platform-specific capture layer via [`capture::Capture`]
///    (Windows uses the native backend; other platforms currently use a no-op
///    stub — see `capture::stub`).
/// 2. Sets up an `mpsc` channel for `ActionEvent` streaming.
/// 3. Spawns a background thread that receives `ActionEvent`s from the capture
///    layer and emits them to the frontend via `app.emit("capture:action", event)`.
/// 4. Registers all Tauri commands.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create the platform-specific capture layer. `capture::Capture` resolves
    // to the native backend on supported platforms and to a no-op stub
    // elsewhere, so this is target-independent.
    let capture_layer: Box<dyn capture::CaptureLayer> = Box::new(capture::Capture::new());

    // Set up the action event channel.
    // The sender is given to the capture layer (via AppState) when `start_capture`
    // is called. The receiver runs on a background thread that forwards events
    // to the frontend.
    let (action_tx, action_rx) = std::sync::mpsc::channel::<capture::ActionEvent>();

    // Background Auto-Sync keep-alive flag (R23.15). Shared between the command
    // that arms/disarms it (`set_auto_sync_keepalive`) and the window close
    // handler below, which reads it to decide whether a close hides the window
    // (keeping the webview + its Auto-Sync timer alive) or quits the app.
    let auto_sync_keepalive = Arc::new(AtomicBool::new(false));

    let app_state = AppState {
        capture: Mutex::new(capture_layer),
        action_sender: action_tx,
        auto_sync_keepalive: Arc::clone(&auto_sync_keepalive),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::stop_capture,
            commands::list_windows,
            commands::check_permissions,
            commands::load_state,
            commands::save_state,
            commands::get_self_pid,
            commands::get_max_sequence_number,
            commands::set_self_capture_exclusion,
            commands::set_target_pid,
            commands::set_auto_sync_keepalive,
            commands::export_file,
            commands::import_file,
        ])
        .setup(|app| {
            // Spawn a background thread that receives ActionEvents from the
            // capture layer's mpsc channel and emits them to the frontend
            // via Tauri's event system.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                while let Ok(event) = action_rx.recv() {
                    // Emit to all frontend listeners on the "capture:action" channel.
                    let _ = handle.emit("capture:action", &event);
                }
            });

            // System tray (R23.15): while the background Auto-Sync keep-alive is
            // armed, closing the window only hides it, so the tray is the user's
            // way back to the window and the explicit way to quit. A "Show"
            // item re-reveals + focuses the main window; "Quit" exits the app
            // regardless of the keep-alive flag.
            let show_item = MenuItemBuilder::with_id("show", "Show Docent").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;

            TrayIconBuilder::with_id("docent-tray")
                .tooltip("Docent Desktop")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(move |window, event| {
            // R23.15: when the background Auto-Sync keep-alive is armed, a window
            // close request HIDES the window instead of destroying the webview,
            // so the frontend's Auto-Sync timer and the shared `sync()` it
            // invokes keep running headless. When it is disarmed, the close
            // proceeds normally (the app quits with its last window). The user
            // can always re-show or quit from the system tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if auto_sync_keepalive.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Docent Desktop");
}
