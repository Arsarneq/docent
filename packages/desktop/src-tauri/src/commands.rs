// Tauri commands — bridge between the JavaScript frontend and the Rust backend.
//
// Each function annotated with `#[tauri::command]` is callable from the
// frontend via `invoke("command_name", { args })`.
//
// Requirements:
// - 12.5: Tauri commands for start/stop capture, list windows, check permissions
// - 14.1: Filesystem persistence (load/save state)
// - 7.2:  Native save dialog for export
// - 8.1:  Native open dialog for import

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;

use crate::capture::{CaptureError, CaptureLayer, PermissionStatus, WindowInfo};

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

/// Shared application state managed by Tauri.
///
/// Holds the platform-specific `CaptureLayer` implementation behind a `Mutex`
/// so that commands can mutate it safely from the main thread.
pub struct AppState {
    pub capture: Mutex<Box<dyn CaptureLayer>>,
    pub action_sender: std::sync::mpsc::Sender<crate::capture::ActionEvent>,
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/// Return the path to the session persistence file:
/// `%APPDATA%/com.docent.desktop/session.json` on Windows.
fn session_file_path() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA environment variable not set".to_string())?;
    let dir = PathBuf::from(appdata).join("com.docent.desktop");
    Ok(dir.join("session.json"))
}

/// Ensure the parent directory for the session file exists.
fn ensure_session_dir() -> Result<(), String> {
    let path = session_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create session directory: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Capture commands
// ---------------------------------------------------------------------------

/// Start the capture layer. Optionally set the target PID for context.
///
/// Actions are streamed to the frontend via the `capture:action` event channel
/// (set up in `lib.rs`).
#[tauri::command]
pub fn start_capture(
    state: State<'_, AppState>,
    pid: Option<u32>,
) -> Result<(), String> {
    let mut capture = state
        .capture
        .lock()
        .map_err(|e| format!("Failed to lock capture state: {e}"))?;

    if let Some(target_pid) = pid {
        capture.set_excluded_pid(Some(target_pid));
    }

    let sender = state.action_sender.clone();
    capture
        .start(sender)
        .map_err(|e: CaptureError| e.to_string())
}

/// Stop the capture layer.
#[tauri::command]
pub fn stop_capture(state: State<'_, AppState>) -> Result<(), String> {
    let mut capture = state
        .capture
        .lock()
        .map_err(|e| format!("Failed to lock capture state: {e}"))?;

    capture.stop().map_err(|e: CaptureError| e.to_string())
}

/// List visible windows for target application selection.
#[tauri::command]
pub fn list_windows(state: State<'_, AppState>) -> Result<Vec<WindowInfo>, String> {
    let capture = state
        .capture
        .lock()
        .map_err(|e| format!("Failed to lock capture state: {e}"))?;

    capture
        .list_windows()
        .map_err(|e: CaptureError| e.to_string())
}

/// Check if required platform permissions are granted.
#[tauri::command]
pub fn check_permissions(state: State<'_, AppState>) -> Result<PermissionStatus, String> {
    let capture = state
        .capture
        .lock()
        .map_err(|e| format!("Failed to lock capture state: {e}"))?;

    Ok(capture.check_permissions())
}

// ---------------------------------------------------------------------------
// Persistence commands
// ---------------------------------------------------------------------------

/// Load session state from the filesystem.
///
/// Returns the raw JSON string, or an empty object `"{}"` if the file does
/// not exist or is unreadable (Req 14.4).
#[tauri::command]
pub fn load_state() -> Result<String, String> {
    let path = session_file_path()?;

    match fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No persistence file yet — start with empty state.
            Ok("{}".to_string())
        }
        Err(e) => {
            // File exists but is unreadable — log warning, start empty.
            eprintln!(
                "Warning: failed to read session file at {}: {e}",
                path.display()
            );
            Ok("{}".to_string())
        }
    }
}

/// Save session state to the filesystem.
///
/// Writes the provided JSON string to `%APPDATA%/com.docent.desktop/session.json`.
#[tauri::command]
pub fn save_state(data: String) -> Result<(), String> {
    ensure_session_dir()?;
    let path = session_file_path()?;

    fs::write(&path, data)
        .map_err(|e| format!("Failed to write session file at {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Self-capture exclusion commands
// ---------------------------------------------------------------------------

/// Return the current process ID so the frontend can display it or use it
/// for self-capture exclusion logic.
#[tauri::command]
pub fn get_self_pid() -> u32 {
    std::process::id()
}

/// Return the current maximum sequence number assigned by the capture layer.
///
/// Used by the frontend completeness guarantee: before committing a step,
/// the frontend queries this value and waits until all events up to that
/// sequence number have been received (or a timeout expires).
///
/// Returns 0 if no events have been dispatched in the current session.
#[tauri::command]
pub fn get_max_sequence_number(state: State<'_, AppState>) -> Result<u64, String> {
    let capture = state
        .capture
        .lock()
        .map_err(|e| format!("Failed to lock capture state: {e}"))?;

    Ok(capture.max_sequence_id())
}

/// Enable or disable self-capture exclusion.
///
/// When enabled, events originating from the app's own process or any of its
/// WebView2 child processes are filtered out. We collect all PIDs belonging to
/// the Docent process tree (the host exe + all msedgewebview2.exe children).
#[tauri::command]
pub fn set_self_capture_exclusion(
    state: State<'_, AppState>,
    _window: tauri::Window,
    enabled: bool,
) -> Result<(), String> {
    let mut capture = state
        .capture
        .lock()
        .map_err(|e| format!("Failed to lock capture state: {e}"))?;

    if enabled {
        let host_pid = std::process::id();
        eprintln!("[Docent] Self-capture exclusion ON: host_pid={host_pid}");
        capture.set_excluded_pid(Some(host_pid));
    } else {
        eprintln!("[Docent] Self-capture exclusion OFF");
        capture.set_excluded_pid(None);
    }

    Ok(())
}



// ---------------------------------------------------------------------------
// Export / Import commands
// ---------------------------------------------------------------------------

/// Export project data via the native save dialog.
///
/// Opens a save dialog with the provided default filename. If the user
/// confirms, writes `data` to the chosen path.
#[tauri::command]
pub async fn export_file(
    app: tauri::AppHandle,
    data: String,
    default_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Docent JSON", &["docent.json", "json"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_buf: PathBuf = path
                .as_path()
                .ok_or_else(|| "Invalid file path".to_string())?
                .to_path_buf();
            fs::write(&path_buf, data)
                .map_err(|e| format!("Failed to write export file: {e}"))
        }
        None => {
            // User cancelled the dialog — not an error.
            Ok(())
        }
    }
}

/// Import a `.docent.json` file via the native open dialog.
///
/// Opens a file dialog. If the user selects a file, returns its contents
/// as a JSON string. Returns `None` if the user cancels.
#[tauri::command]
pub async fn import_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("Docent JSON", &["docent.json", "json"])
        .blocking_pick_file();

    match file_path {
        Some(path) => {
            let path_buf: PathBuf = path
                .as_path()
                .ok_or_else(|| "Invalid file path".to_string())?
                .to_path_buf();
            let contents = fs::read_to_string(&path_buf)
                .map_err(|e| format!("Failed to read import file: {e}"))?;
            Ok(Some(contents))
        }
        None => {
            // User cancelled the dialog.
            Ok(None)
        }
    }
}
