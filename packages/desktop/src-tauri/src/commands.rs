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
use crate::secret_store::{self, SecretStore};

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
    let appdata =
        std::env::var("APPDATA").map_err(|_| "APPDATA environment variable not set".to_string())?;
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

/// Type alias for the shared, lockable capture layer.
///
/// Command bodies are factored into helpers that take this directly (rather
/// than `State<AppState>`) so they can be unit-tested with a mock
/// `CaptureLayer` without constructing a Tauri runtime.
type CaptureMutex = Mutex<Box<dyn CaptureLayer>>;

fn lock_capture(
    capture: &CaptureMutex,
) -> Result<std::sync::MutexGuard<'_, Box<dyn CaptureLayer>>, String> {
    capture
        .lock()
        .map_err(|e| format!("Failed to lock capture state: {e}"))
}

/// Core logic for `start_capture` — testable without a Tauri runtime.
fn start_capture_impl(
    capture: &CaptureMutex,
    sender: std::sync::mpsc::Sender<crate::capture::ActionEvent>,
    pid: Option<u32>,
) -> Result<(), String> {
    let mut capture = lock_capture(capture)?;

    if let Some(target_pid) = pid {
        capture.set_excluded_pid(Some(target_pid));
    }

    capture
        .start(sender)
        .map_err(|e: CaptureError| e.to_string())
}

/// Core logic for `stop_capture` — testable without a Tauri runtime.
fn stop_capture_impl(capture: &CaptureMutex) -> Result<(), String> {
    let mut capture = lock_capture(capture)?;
    capture.stop().map_err(|e: CaptureError| e.to_string())
}

/// Core logic for `list_windows` — testable without a Tauri runtime.
fn list_windows_impl(capture: &CaptureMutex) -> Result<Vec<WindowInfo>, String> {
    let capture = lock_capture(capture)?;
    capture
        .list_windows()
        .map_err(|e: CaptureError| e.to_string())
}

/// Core logic for `check_permissions` — testable without a Tauri runtime.
fn check_permissions_impl(capture: &CaptureMutex) -> Result<PermissionStatus, String> {
    let capture = lock_capture(capture)?;
    Ok(capture.check_permissions())
}

/// Start the capture layer. Optionally set the target PID for context.
///
/// Actions are streamed to the frontend via the `capture:action` event channel
/// (set up in `lib.rs`).
#[tauri::command]
pub fn start_capture(state: State<'_, AppState>, pid: Option<u32>) -> Result<(), String> {
    start_capture_impl(&state.capture, state.action_sender.clone(), pid)
}

/// Stop the capture layer.
#[tauri::command]
pub fn stop_capture(state: State<'_, AppState>) -> Result<(), String> {
    stop_capture_impl(&state.capture)
}

/// List visible windows for target application selection.
#[tauri::command]
pub fn list_windows(state: State<'_, AppState>) -> Result<Vec<WindowInfo>, String> {
    list_windows_impl(&state.capture)
}

/// Check if required platform permissions are granted.
#[tauri::command]
pub fn check_permissions(state: State<'_, AppState>) -> Result<PermissionStatus, String> {
    check_permissions_impl(&state.capture)
}

// ---------------------------------------------------------------------------
// Persistence commands
// ---------------------------------------------------------------------------

/// Re-inject the API keys held in the OS credential store (S2) into a raw
/// session JSON string read from disk.
///
/// The session file on disk no longer contains `settings.apiKey` /
/// `settings.syncApiKey` (they are stored in the credential manager); this
/// restores them so the frontend sees the shape it always has. If the JSON is
/// not a parseable object — or secret storage is disabled on this target — the
/// string is returned unchanged.
fn inject_secrets_into_json(contents: String, store: &dyn SecretStore) -> String {
    if !secret_store::ENABLED {
        return contents;
    }
    match serde_json::from_str::<serde_json::Value>(&contents) {
        Ok(mut state) if state.is_object() => match secret_store::inject_secrets(&mut state, store)
        {
            Ok(()) => serde_json::to_string(&state).unwrap_or(contents),
            Err(e) => {
                eprintln!("Warning: failed to load API keys from credential store: {e}");
                contents
            }
        },
        // Not an object (or parse failure) — nothing to inject into.
        _ => contents,
    }
}

/// Core logic for `load_state` — testable with an injected [`SecretStore`].
fn load_state_impl(store: &dyn SecretStore) -> Result<String, String> {
    let path = session_file_path()?;

    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No persistence file yet — start with empty state.
            "{}".to_string()
        }
        Err(e) => {
            // File exists but is unreadable — log warning, start empty.
            eprintln!(
                "Warning: failed to read session file at {}: {e}",
                path.display()
            );
            "{}".to_string()
        }
    };

    Ok(inject_secrets_into_json(contents, store))
}

/// Strip the API keys out of a raw session JSON string and persist them to the
/// OS credential store (S2), returning the JSON that should be written to disk.
///
/// If the JSON is not a parseable object — or secret storage is disabled on
/// this target — the string is returned unchanged so the previous inline
/// behaviour is preserved.
fn strip_secrets_from_json(data: String, store: &dyn SecretStore) -> Result<String, String> {
    if !secret_store::ENABLED {
        return Ok(data);
    }
    match serde_json::from_str::<serde_json::Value>(&data) {
        Ok(mut state) if state.is_object() => {
            secret_store::strip_secrets(&mut state, store)?;
            Ok(serde_json::to_string(&state).unwrap_or(data))
        }
        // Not an object (or parse failure) — write through unchanged.
        _ => Ok(data),
    }
}

/// Core logic for `save_state` — testable with an injected [`SecretStore`].
fn save_state_impl(data: String, store: &dyn SecretStore) -> Result<(), String> {
    let sanitized = strip_secrets_from_json(data, store)?;

    ensure_session_dir()?;
    let path = session_file_path()?;

    fs::write(&path, sanitized)
        .map_err(|e| format!("Failed to write session file at {}: {e}", path.display()))
}

/// Load session state from the filesystem.
///
/// Returns the raw JSON string, or an empty object `"{}"` if the file does
/// not exist or is unreadable (Req 14.4). API keys (S2) are re-injected from
/// the OS credential store before returning.
#[tauri::command]
pub fn load_state() -> Result<String, String> {
    load_state_impl(secret_store::default_store().as_ref())
}

/// Save session state to the filesystem.
///
/// Writes the provided JSON string to `%APPDATA%/com.docent.desktop/session.json`.
/// API keys (S2) are stripped out and stored in the OS credential store rather
/// than written to the file.
#[tauri::command]
pub fn save_state(data: String) -> Result<(), String> {
    save_state_impl(data, secret_store::default_store().as_ref())
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

/// Core logic for `get_max_sequence_number` — testable without a Tauri runtime.
fn get_max_sequence_number_impl(capture: &CaptureMutex) -> Result<u64, String> {
    let capture = lock_capture(capture)?;
    Ok(capture.max_sequence_id())
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
    get_max_sequence_number_impl(&state.capture)
}

/// Core logic for `set_self_capture_exclusion` — testable without a Tauri runtime.
///
/// Takes the host PID explicitly (rather than reading `std::process::id()`)
/// so the behaviour can be verified in tests.
fn set_self_capture_exclusion_impl(
    capture: &CaptureMutex,
    host_pid: u32,
    enabled: bool,
) -> Result<(), String> {
    let mut capture = lock_capture(capture)?;

    if enabled {
        eprintln!("[Docent] Self-capture exclusion ON: host_pid={host_pid}");
        capture.set_excluded_pid(Some(host_pid));
    } else {
        eprintln!("[Docent] Self-capture exclusion OFF");
        capture.set_excluded_pid(None);
    }

    Ok(())
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
    set_self_capture_exclusion_impl(&state.capture, std::process::id(), enabled)
}

/// Core logic for `set_target_pid` — testable without a Tauri runtime.
fn set_target_pid_impl(capture: &CaptureMutex, pid: Option<u32>) -> Result<(), String> {
    let mut capture = lock_capture(capture)?;

    let effective_pid = pid.filter(|&p| p != 0);
    eprintln!("[Docent] Target PID set to: {:?}", effective_pid);
    capture.set_included_pid(effective_pid);

    Ok(())
}

/// Set the target application PID for capture filtering.
///
/// When set, only events from this PID are captured. All other events are
/// filtered out (except self-capture exclusion which always takes priority).
/// Pass `null` or `0` to capture all applications.
#[tauri::command]
pub fn set_target_pid(state: State<'_, AppState>, pid: Option<u32>) -> Result<(), String> {
    set_target_pid_impl(&state.capture, pid)
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
            fs::write(&path_buf, data).map_err(|e| format!("Failed to write export file: {e}"))
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{ActionEvent, CaptureError, CaptureLayer, PermissionStatus, WindowInfo};
    use std::sync::mpsc;
    use std::sync::Arc;

    /// Shared, observable record of calls made to the mock. Held by both the
    /// test and the `MockCapture` (via `Arc`) so assertions can inspect what
    /// the command helpers did, despite `CaptureLayer` having no getters.
    #[derive(Default)]
    struct Recorded {
        started: bool,
        stopped: bool,
        excluded_pid: Option<u32>,
        included_pid: Option<u32>,
    }

    struct MockCapture {
        rec: Arc<Mutex<Recorded>>,
        max_seq: u64,
        windows: Vec<WindowInfo>,
        permissions_granted: bool,
        fail_start: bool,
        fail_stop: bool,
        fail_list: bool,
    }

    impl MockCapture {
        fn new() -> (Self, Arc<Mutex<Recorded>>) {
            let rec = Arc::new(Mutex::new(Recorded::default()));
            let mock = MockCapture {
                rec: Arc::clone(&rec),
                max_seq: 0,
                windows: Vec::new(),
                permissions_granted: false,
                fail_start: false,
                fail_stop: false,
                fail_list: false,
            };
            (mock, rec)
        }
    }

    impl CaptureLayer for MockCapture {
        fn start(&mut self, _sender: mpsc::Sender<ActionEvent>) -> Result<(), CaptureError> {
            if self.fail_start {
                return Err(CaptureError::Platform("mock start failure".into()));
            }
            self.rec.lock().unwrap().started = true;
            Ok(())
        }

        fn stop(&mut self) -> Result<(), CaptureError> {
            if self.fail_stop {
                return Err(CaptureError::Platform("mock stop failure".into()));
            }
            self.rec.lock().unwrap().stopped = true;
            Ok(())
        }

        fn is_active(&self) -> bool {
            let r = self.rec.lock().unwrap();
            r.started && !r.stopped
        }

        fn check_permissions(&self) -> PermissionStatus {
            PermissionStatus {
                granted: self.permissions_granted,
                message: None,
            }
        }

        fn list_windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
            if self.fail_list {
                return Err(CaptureError::PermissionDenied("mock list failure".into()));
            }
            Ok(self.windows.clone())
        }

        fn set_excluded_pid(&mut self, pid: Option<u32>) {
            self.rec.lock().unwrap().excluded_pid = pid;
        }

        fn set_included_pid(&mut self, pid: Option<u32>) {
            self.rec.lock().unwrap().included_pid = pid;
        }

        fn max_sequence_id(&self) -> u64 {
            self.max_seq
        }
    }

    fn mutex(mock: MockCapture) -> CaptureMutex {
        Mutex::new(Box::new(mock))
    }

    // ── start_capture_impl ──────────────────────────────────────────────────

    #[test]
    fn start_capture_starts_the_layer() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);
        let (tx, _rx) = mpsc::channel();

        let result = start_capture_impl(&cap, tx, None);

        assert!(result.is_ok());
        assert!(rec.lock().unwrap().started);
        assert_eq!(rec.lock().unwrap().excluded_pid, None);
    }

    #[test]
    fn start_capture_sets_excluded_pid_when_pid_provided() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);
        let (tx, _rx) = mpsc::channel();

        start_capture_impl(&cap, tx, Some(4321)).unwrap();

        assert!(rec.lock().unwrap().started);
        assert_eq!(rec.lock().unwrap().excluded_pid, Some(4321));
    }

    #[test]
    fn start_capture_propagates_start_error() {
        let (mut mock, _rec) = MockCapture::new();
        mock.fail_start = true;
        let cap = mutex(mock);
        let (tx, _rx) = mpsc::channel();

        let result = start_capture_impl(&cap, tx, None);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("mock start failure"));
    }

    // ── stop_capture_impl ───────────────────────────────────────────────────

    #[test]
    fn stop_capture_stops_the_layer() {
        let (mock, rec) = MockCapture::new();
        rec.lock().unwrap().started = true;
        let cap = mutex(mock);

        let result = stop_capture_impl(&cap);

        assert!(result.is_ok());
        assert!(rec.lock().unwrap().stopped);
    }

    #[test]
    fn stop_capture_propagates_stop_error() {
        let (mut mock, _rec) = MockCapture::new();
        mock.fail_stop = true;
        let cap = mutex(mock);

        let result = stop_capture_impl(&cap);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("mock stop failure"));
    }

    // ── list_windows_impl ───────────────────────────────────────────────────

    #[test]
    fn list_windows_returns_windows() {
        let (mut mock, _rec) = MockCapture::new();
        mock.windows = vec![WindowInfo {
            window_id: 42,
            title: "Notepad".into(),
            process_name: "notepad.exe".into(),
            pid: 100,
        }];
        let cap = mutex(mock);

        let result = list_windows_impl(&cap).unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].title, "Notepad");
        assert_eq!(result[0].pid, 100);
    }

    #[test]
    fn list_windows_propagates_error() {
        let (mut mock, _rec) = MockCapture::new();
        mock.fail_list = true;
        let cap = mutex(mock);

        let result = list_windows_impl(&cap);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("mock list failure"));
    }

    // ── check_permissions_impl ──────────────────────────────────────────────

    #[test]
    fn check_permissions_reports_granted() {
        let (mut mock, _rec) = MockCapture::new();
        mock.permissions_granted = true;
        let cap = mutex(mock);

        let status = check_permissions_impl(&cap).unwrap();

        assert!(status.granted);
    }

    #[test]
    fn check_permissions_reports_not_granted() {
        let (mock, _rec) = MockCapture::new();
        let cap = mutex(mock);

        let status = check_permissions_impl(&cap).unwrap();

        assert!(!status.granted);
    }

    // ── get_max_sequence_number_impl ────────────────────────────────────────

    #[test]
    fn max_sequence_number_returns_zero_initially() {
        let (mock, _rec) = MockCapture::new();
        let cap = mutex(mock);
        assert_eq!(get_max_sequence_number_impl(&cap).unwrap(), 0);
    }

    #[test]
    fn max_sequence_number_returns_layer_value() {
        let (mut mock, _rec) = MockCapture::new();
        mock.max_seq = 99;
        let cap = mutex(mock);
        assert_eq!(get_max_sequence_number_impl(&cap).unwrap(), 99);
    }

    // ── set_self_capture_exclusion_impl ─────────────────────────────────────

    #[test]
    fn self_capture_exclusion_enabled_sets_host_pid() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);

        set_self_capture_exclusion_impl(&cap, 1234, true).unwrap();

        assert_eq!(rec.lock().unwrap().excluded_pid, Some(1234));
    }

    #[test]
    fn self_capture_exclusion_disabled_clears_pid() {
        let (mock, rec) = MockCapture::new();
        rec.lock().unwrap().excluded_pid = Some(1234);
        let cap = mutex(mock);

        set_self_capture_exclusion_impl(&cap, 1234, false).unwrap();

        assert_eq!(rec.lock().unwrap().excluded_pid, None);
    }

    // ── set_target_pid_impl ─────────────────────────────────────────────────

    #[test]
    fn set_target_pid_stores_nonzero_pid() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);

        set_target_pid_impl(&cap, Some(555)).unwrap();

        assert_eq!(rec.lock().unwrap().included_pid, Some(555));
    }

    #[test]
    fn set_target_pid_treats_zero_as_none() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);

        set_target_pid_impl(&cap, Some(0)).unwrap();

        assert_eq!(rec.lock().unwrap().included_pid, None);
    }

    #[test]
    fn set_target_pid_accepts_none() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);

        set_target_pid_impl(&cap, None).unwrap();

        assert_eq!(rec.lock().unwrap().included_pid, None);
    }

    // ── secret-at-rest JSON wrappers (S2) ────────────────────────────────────
    //
    // These wrappers gate on `secret_store::ENABLED`, which is only true on
    // Windows (the shipping target with a credential backend). The behavioural
    // assertions therefore only hold on Windows; the tests are compiled and run
    // there. The underlying strip/inject logic has platform-independent unit
    // tests in `secret_store.rs`.
    #[cfg(windows)]
    mod secret_wrappers {
        use super::super::*;
        use crate::secret_store::SecretStore;
        use std::collections::HashMap;
        use std::sync::Mutex;

        #[derive(Default)]
        struct MemStore {
            map: Mutex<HashMap<String, String>>,
        }

        impl SecretStore for MemStore {
            fn set(&self, name: &str, value: &str) -> Result<(), String> {
                self.map
                    .lock()
                    .unwrap()
                    .insert(name.to_string(), value.to_string());
                Ok(())
            }
            fn get(&self, name: &str) -> Result<Option<String>, String> {
                Ok(self.map.lock().unwrap().get(name).cloned())
            }
            fn delete(&self, name: &str) -> Result<(), String> {
                self.map.lock().unwrap().remove(name);
                Ok(())
            }
        }

        #[test]
        fn strip_removes_api_key_from_written_json() {
            let store = MemStore::default();
            let data =
                r#"{"settings":{"endpointUrl":"https://api.test","apiKey":"secret"}}"#.to_string();

            let out = strip_secrets_from_json(data, &store).unwrap();

            assert!(!out.contains("secret"), "apiKey must not reach the file");
            assert!(out.contains("https://api.test"), "endpoint stays in file");
            assert_eq!(store.get("apiKey").unwrap().as_deref(), Some("secret"));
        }

        #[test]
        fn inject_restores_api_key_into_read_json() {
            let store = MemStore::default();
            store.set("apiKey", "secret").unwrap();
            let on_disk = r#"{"settings":{"endpointUrl":"https://api.test"}}"#.to_string();

            let out = inject_secrets_into_json(on_disk, &store);

            assert!(out.contains("secret"), "apiKey restored on load");
        }

        #[test]
        fn non_object_json_passes_through_unchanged() {
            let store = MemStore::default();
            assert_eq!(
                strip_secrets_from_json("not json".to_string(), &store).unwrap(),
                "not json"
            );
            assert_eq!(inject_secrets_into_json("[]".to_string(), &store), "[]");
        }

        #[test]
        fn strip_then_inject_round_trips_through_strings() {
            let store = MemStore::default();
            let original =
                r#"{"settings":{"endpointUrl":"https://api.test","apiKey":"k1","syncApiKey":"k2"}}"#
                    .to_string();

            let on_disk = strip_secrets_from_json(original.clone(), &store).unwrap();
            let restored = inject_secrets_into_json(on_disk, &store);

            let a: serde_json::Value = serde_json::from_str(&original).unwrap();
            let b: serde_json::Value = serde_json::from_str(&restored).unwrap();
            assert_eq!(a, b);
        }
    }
}
