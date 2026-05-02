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

use std::sync::Mutex;

use tauri::Emitter;

use commands::AppState;

/// Run the Tauri application.
///
/// 1. Creates a `WindowsCapture` instance (behind `#[cfg(target_os = "windows")]`).
/// 2. Sets up an `mpsc` channel for `ActionEvent` streaming.
/// 3. Spawns a background thread that receives `ActionEvent`s from the capture
///    layer and emits them to the frontend via `app.emit("capture:action", event)`.
/// 4. Registers all Tauri commands.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create the platform-specific capture layer.
    #[cfg(target_os = "windows")]
    let capture_layer: Box<dyn capture::CaptureLayer> =
        Box::new(capture::windows::WindowsCapture::new());

    #[cfg(not(target_os = "windows"))]
    compile_error!("Only Windows is supported in this release. macOS and Linux are planned.");

    // Set up the action event channel.
    // The sender is given to the capture layer (via AppState) when `start_capture`
    // is called. The receiver runs on a background thread that forwards events
    // to the frontend.
    let (action_tx, action_rx) = std::sync::mpsc::channel::<capture::ActionEvent>();

    let app_state = AppState {
        capture: Mutex::new(capture_layer),
        action_sender: action_tx,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Docent Desktop");
}
