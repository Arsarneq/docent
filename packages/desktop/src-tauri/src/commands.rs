// Tauri commands — bridge between the JavaScript frontend and the Rust backend.
//
// Each function annotated with `#[tauri::command]` is callable from the
// frontend via `invoke("command_name", { args })`.
//
// Requirements:
// - Tauri commands for start/stop capture, list windows
// - Filesystem persistence (load/save state)
// - Native save dialog for export
// - Native open dialog for import
//
// Governance declared in scripts/area-map.json (see its declared-governance entry): the capture events these commands relay become .docent.json action data; the per-platform schemas are authoritative for field semantics.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use tauri::State;

use crate::capture::{BarrierReport, CaptureError, CaptureLayer, WindowInfo};
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
    /// Whether the background Auto-Sync host wants the window kept alive when
    /// closed. While `true`, the window's close request HIDES the
    /// window instead of destroying the webview, so the frontend's Auto-Sync
    /// timer + the shared `sync()` it invokes keep running headless. The
    /// frontend arms/disarms this via `set_auto_sync_keepalive` as Auto-Sync is
    /// enabled/disabled. Shared as an `Arc<AtomicBool>` so the `lib.rs` window
    /// event handler can read it without locking the capture mutex.
    pub auto_sync_keepalive: Arc<AtomicBool>,
    /// The gate on the session file's reads and writes (`load_state` /
    /// `save_state`); see [`SessionGuard`].
    pub session: SessionGuard,
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

    if let Some(excluded_pid) = pid {
        capture.set_excluded_pid(Some(excluded_pid));
    }

    capture
        .start(sender)
        .map_err(|e: CaptureError| e.to_string())
}

/// Core logic for `stop_capture` — testable without a Tauri runtime.
fn stop_capture_impl(capture: &CaptureMutex) -> Result<BarrierReport, String> {
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

/// Start the capture layer. An optional `pid` arms self-capture exclusion for
/// that process before starting — the shipped panel always passes `null` and
/// arms exclusion through `set_self_capture_exclusion`. PID-based targeting is
/// `set_target_pid`, never this parameter (docent#319).
///
/// Actions are streamed to the frontend via the `capture:action` event channel
/// (set up in `lib.rs`).
#[tauri::command]
pub fn start_capture(state: State<'_, AppState>, pid: Option<u32>) -> Result<(), String> {
    start_capture_impl(&state.capture, state.action_sender.clone(), pid)
}

/// Stop the capture layer, running the commit flush barrier as it stops.
///
/// Returns the barrier report `{ barrier_id, wedged_workers, completion }`;
/// the frontend waits for the matching `barrier_complete` sentinel on the
/// `capture:action` stream so a committed step captures every drained action.
/// `barrier_id` is `0` when no capture was active.
#[tauri::command]
pub fn stop_capture(state: State<'_, AppState>) -> Result<BarrierReport, String> {
    stop_capture_impl(&state.capture)
}

/// List visible windows for target application selection.
#[tauri::command]
pub fn list_windows(state: State<'_, AppState>) -> Result<Vec<WindowInfo>, String> {
    list_windows_impl(&state.capture)
}

// ---------------------------------------------------------------------------
// Persistence commands
// ---------------------------------------------------------------------------

/// Why `load_state` could not hand back the session file, sent to the
/// frontend as the command's error (`{ "kind": "set_aside", ... }`).
#[derive(Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LoadError {
    /// The file could not be read, or held no JSON object, and was moved to
    /// `kept_as` in the same folder. Saving goes on to a new session file.
    ///
    /// `state` is `{}` with the credential-store keys re-injected (a missing
    /// file itself reads as a bare `{}`), the state the app starts from:
    /// starting from it rather than from a bare empty state keeps the next
    /// save from clearing the stored keys (DSH-2's clear branch).
    SetAside {
        path: String,
        kept_as: String,
        reason: String,
        state: String,
    },
    /// The file could not be read, or held no JSON object, and could not be
    /// moved either. It stays at `path`, and every save is refused for the
    /// rest of the run so nothing replaces it. Every later load in the run
    /// answers with this same error and tries no second move, so the file is
    /// still where the user was told it is.
    KeptInPlace { path: String, reason: String },
    /// The session file's location could not be found. Every save is refused
    /// for the rest of the run.
    NoLocation { reason: String },
}

/// Written by hand so a set-aside's `state`, which carries the API keys from
/// the credential store, never reaches a log or a test message.
impl std::fmt::Debug for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::SetAside {
                path,
                kept_as,
                reason,
                ..
            } => f
                .debug_struct("SetAside")
                .field("path", path)
                .field("kept_as", kept_as)
                .field("reason", reason)
                .field("state", &"<withheld>")
                .finish(),
            LoadError::KeptInPlace { path, reason } => f
                .debug_struct("KeptInPlace")
                .field("path", path)
                .field("reason", reason)
                .finish(),
            LoadError::NoLocation { reason } => f
                .debug_struct("NoLocation")
                .field("reason", reason)
                .finish(),
        }
    }
}

impl LoadError {
    /// The plain reason the error carries.
    fn reason(&self) -> &str {
        match self {
            LoadError::SetAside { reason, .. }
            | LoadError::KeptInPlace { reason, .. }
            | LoadError::NoLocation { reason } => reason,
        }
    }
}

/// The one gate every read and write of the session file passes through.
///
/// It serializes the session file's I/O, and it remembers, for the rest of
/// the run, that a load left an unreadable file in place: from then on every
/// save is refused, so the file is never written over, and every load answers
/// with the same error without touching the file again. The refusal is never
/// lifted while the app runs, since the panel's copy in memory started empty.
#[derive(Debug, Default)]
pub struct SessionGuard {
    /// `Some(error)` once saves are refused: the load error that refused them.
    refused: Mutex<Option<LoadError>>,
}

impl SessionGuard {
    /// Whether every save is refused for the rest of the run.
    pub fn saves_refused(&self) -> bool {
        self.refused.lock().map(|r| r.is_some()).unwrap_or(true)
    }
}

/// Re-inject the API keys held in the OS credential store into a raw
/// session JSON string read from disk.
///
/// The session file on disk no longer contains `settings.apiKey` /
/// `settings.syncApiKey` (they are stored in the credential manager); this
/// restores them so the frontend sees the shape it always has. If the JSON is
/// not a parseable object — or secret storage is disabled on this target — the
/// string is returned unchanged.
fn inject_secrets_into_json(contents: String, store: &dyn SecretStore) -> String {
    if !store.enabled() {
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
///
/// Public so integration tests can drive the filesystem path with a
/// [`secret_store::DisabledStore`], exercising real load/save without touching
/// the machine-global credential store.
pub fn load_state_impl(store: &dyn SecretStore, guard: &SessionGuard) -> Result<String, LoadError> {
    load_guarded(session_file_path(), store, guard, &|from, to| {
        fs::rename(from, to)
    })
}

/// [`load_from`] under the guard's lock, recording a refusal of every later
/// save when the file stayed in place or its location is unknown; once
/// recorded, every load answers with that error and reads nothing.
fn load_guarded(
    path: Result<PathBuf, String>,
    store: &dyn SecretStore,
    guard: &SessionGuard,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<String, LoadError> {
    let mut refused = guard.refused.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(err) = refused.as_ref() {
        return Err(err.clone());
    }
    let result = match path {
        Ok(path) => load_from(&path, store, rename),
        Err(reason) => Err(LoadError::NoLocation { reason }),
    };
    if let Err(err @ (LoadError::KeptInPlace { .. } | LoadError::NoLocation { .. })) = &result {
        *refused = Some(err.clone());
    }
    result
}

/// Read the session file at `path`.
///
/// A missing file reads as `{}`. A file that cannot be read, or that holds
/// no JSON object, is never handed back as empty: it is moved aside with
/// `rename` and the error says where it was kept, or, when the move fails,
/// that it stayed in place.
fn load_from(
    path: &Path,
    store: &dyn SecretStore,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<String, LoadError> {
    let reason = match fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No persistence file yet — start with empty state.
            return Ok("{}".to_string());
        }
        Err(e) => format!("it could not be read: {e}"),
        Ok(bytes) => match String::from_utf8(bytes) {
            Err(_) => "it is not text".to_string(),
            Ok(contents) => match serde_json::from_str::<serde_json::Value>(&contents) {
                Ok(value) if value.is_object() => {
                    return Ok(inject_secrets_into_json(contents, store));
                }
                Ok(_) => "it does not hold a JSON object".to_string(),
                Err(e) => format!("it is not valid JSON: {e}"),
            },
        },
    };
    let shown = path.display().to_string();
    eprintln!("Warning: the session file at {shown} cannot be used, {reason}");
    let kept_as = set_aside_path(path);
    match rename(path, &kept_as) {
        Ok(()) => Err(LoadError::SetAside {
            path: shown,
            kept_as: kept_as.display().to_string(),
            reason,
            state: inject_secrets_into_json("{}".to_string(), store),
        }),
        Err(e) => Err(LoadError::KeptInPlace {
            path: shown,
            reason: format!("{reason}, and it could not be moved aside: {e}"),
        }),
    }
}

/// A name beside `path` that nothing holds yet:
/// `session.unreadable-<UTC time>.json`, with `-2`, `-3`, … added when a file
/// set aside in the same second already holds it.
fn set_aside_path(path: &Path) -> PathBuf {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stamp = utc_stamp(std::time::SystemTime::now());
    let mut candidate = dir.join(format!("session.unreadable-{stamp}.json"));
    let mut n = 2;
    while candidate.symlink_metadata().is_ok() {
        candidate = dir.join(format!("session.unreadable-{stamp}-{n}.json"));
        n += 1;
    }
    candidate
}

/// `YYYYMMDDTHHMMSSZ` for `time`, in UTC.
fn utc_stamp(time: std::time::SystemTime) -> String {
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// Strip the API keys out of a raw session JSON string and persist them to the
/// OS credential store, returning the JSON that should be written to disk.
///
/// If the JSON is not a parseable object — or secret storage is disabled on
/// this target — the string is returned unchanged so the previous inline
/// behaviour is preserved.
fn strip_secrets_from_json(data: String, store: &dyn SecretStore) -> Result<String, String> {
    if !store.enabled() {
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
///
/// Public so integration tests can drive the filesystem path with a
/// [`secret_store::DisabledStore`].
pub fn save_state_impl(
    data: String,
    store: &dyn SecretStore,
    guard: &SessionGuard,
) -> Result<(), String> {
    let refused = guard.refused.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(err) = refused.as_ref() {
        return Err(format!(
            "Not saved: the session file could not be read at startup and is kept as it is ({})",
            err.reason()
        ));
    }
    let sanitized = strip_secrets_from_json(data, store)?;

    ensure_session_dir()?;
    let path = session_file_path()?;
    save_to(&path, &sanitized)
}

/// Write `contents` as the session file at `path` without ever leaving it
/// half-written: the bytes go to a temporary file in the same folder, are
/// flushed to disk, and the temporary file is then renamed over `path`.
fn save_to(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    written.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to write session file at {}: {e}", path.display())
    })
}

/// Load session state from the filesystem.
///
/// Returns the raw JSON string, or an empty object `"{}"` if the file does
/// not exist. A file that cannot be read or holds no JSON object answers with
/// a [`LoadError`] and is never written over. API keys are re-injected from
/// the OS credential store before returning.
#[tauri::command]
pub fn load_state(state: State<'_, AppState>) -> Result<String, LoadError> {
    load_state_impl(secret_store::default_store().as_ref(), &state.session)
}

/// Save session state to the filesystem.
///
/// Writes the provided JSON string to `%APPDATA%/com.docent.desktop/session.json`
/// through a temporary file and a rename, and refuses while [`SessionGuard`]
/// holds an unreadable file in place.
/// API keys are stripped out and stored in the OS credential store rather
/// than written to the file.
#[tauri::command]
pub fn save_state(state: State<'_, AppState>, data: String) -> Result<(), String> {
    save_state_impl(data, secret_store::default_store().as_ref(), &state.session)
}

// ---------------------------------------------------------------------------
// Self-capture exclusion commands
// ---------------------------------------------------------------------------

/// Core logic for `commit_barrier` — testable without a Tauri runtime.
fn commit_barrier_impl(capture: &CaptureMutex) -> Result<BarrierReport, String> {
    let capture = lock_capture(capture)?;
    capture
        .commit_barrier()
        .map_err(|e: CaptureError| e.to_string())
}

/// Run the step-commit flush barrier (docent#298).
///
/// Drains every capture worker's completed-but-held actions into the
/// `capture:action` stream, emits a `BarrierComplete` sentinel the frontend
/// waits on to confirm delivery, and returns
/// `{ barrier_id, wedged_workers, completion }`.
/// Bounded — a worker wedged in an unresponsive accessibility call cannot stall
/// the commit; its buffered actions are rescued in place instead.
#[tauri::command]
pub fn commit_barrier(state: State<'_, AppState>) -> Result<BarrierReport, String> {
    commit_barrier_impl(&state.capture)
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
// Background Auto-Sync keep-alive command
// ---------------------------------------------------------------------------

/// Arm or disarm the background Auto-Sync keep-alive.
///
/// While armed (`enabled == true`), the window's close request is intercepted in
/// `lib.rs` and the window is HIDDEN instead of destroyed, so the frontend's
/// Auto-Sync timer + the shared `sync()` it invokes keep running with the window
/// closed/minimized. The system tray (set up in `lib.rs`)
/// lets the user re-show the window or quit. While disarmed, the window closes —
/// and the app quits — normally. The frontend calls this from its Auto-Sync host
/// as the `Auto_Sync` setting is enabled/disabled.
#[tauri::command]
pub fn set_auto_sync_keepalive(state: State<'_, AppState>, enabled: bool) {
    state.auto_sync_keepalive.store(enabled, Ordering::SeqCst);
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
    use crate::capture::{
        ActionEvent, BarrierCompletion, BarrierReport, CaptureError, CaptureLayer,
        PermissionStatus, WindowInfo,
    };
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
        barrier_calls: u32,
    }

    struct MockCapture {
        rec: Arc<Mutex<Recorded>>,
        windows: Vec<WindowInfo>,
        fail_start: bool,
        fail_stop: bool,
        fail_list: bool,
        barrier_wedged: usize,
    }

    impl MockCapture {
        fn new() -> (Self, Arc<Mutex<Recorded>>) {
            let rec = Arc::new(Mutex::new(Recorded::default()));
            let mock = MockCapture {
                rec: Arc::clone(&rec),
                windows: Vec::new(),
                fail_start: false,
                fail_stop: false,
                fail_list: false,
                barrier_wedged: 0,
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

        fn stop(&mut self) -> Result<BarrierReport, CaptureError> {
            if self.fail_stop {
                return Err(CaptureError::Platform("mock stop failure".into()));
            }
            let mut rec = self.rec.lock().unwrap();
            rec.stopped = true;
            // The real stop fuses the commit flush barrier, so it reports one too;
            // model that here (a barrier call, an incrementing id) so the command
            // test can assert stop runs the barrier.
            rec.barrier_calls += 1;
            Ok(BarrierReport {
                barrier_id: rec.barrier_calls as u64,
                wedged_workers: self.barrier_wedged,
                completion: BarrierCompletion::MarkerOrdered,
            })
        }

        fn is_active(&self) -> bool {
            let r = self.rec.lock().unwrap();
            r.started && !r.stopped
        }

        fn check_permissions(&self) -> PermissionStatus {
            PermissionStatus {
                granted: false,
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

        fn commit_barrier(&self) -> Result<BarrierReport, CaptureError> {
            let mut rec = self.rec.lock().unwrap();
            rec.barrier_calls += 1;
            Ok(BarrierReport {
                barrier_id: rec.barrier_calls as u64,
                wedged_workers: self.barrier_wedged,
                completion: BarrierCompletion::MarkerOrdered,
            })
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

    // Pins the exclude semantics of `start_capture`'s optional pid: it arms
    // self-capture exclusion and never the target-application filter, so a
    // future caller cannot pass a pid expecting that process to be targeted.
    // https://github.com/Arsarneq/docent/issues/319
    #[test]
    fn start_capture_pid_reaches_only_the_exclude_sink() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);
        let (tx, _rx) = mpsc::channel();

        start_capture_impl(&cap, tx, Some(4321)).unwrap();

        let rec = rec.lock().unwrap();
        assert_eq!(
            rec.excluded_pid,
            Some(4321),
            "the pid arms self-capture exclusion"
        );
        assert_eq!(
            rec.included_pid, None,
            "the pid must never reach the target-application filter"
        );
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
    fn stop_capture_stops_the_layer_and_reports_the_fused_barrier() {
        let (mock, rec) = MockCapture::new();
        rec.lock().unwrap().started = true;
        let cap = mutex(mock);

        let report = stop_capture_impl(&cap).unwrap();

        assert!(rec.lock().unwrap().stopped);
        // stop fuses the commit flush barrier: it runs one and reports its id so
        // the frontend can wait for the delivery sentinel on the stop path alone.
        assert_eq!(rec.lock().unwrap().barrier_calls, 1);
        assert_eq!(report.barrier_id, 1);
        assert_eq!(report.wedged_workers, 0);
    }

    #[test]
    fn stop_capture_reports_wedged_workers_from_the_fused_barrier() {
        let (mut mock, rec) = MockCapture::new();
        mock.barrier_wedged = 3;
        rec.lock().unwrap().started = true;
        let cap = mutex(mock);

        let report = stop_capture_impl(&cap).unwrap();

        assert_eq!(report.wedged_workers, 3);
    }

    #[test]
    fn stop_capture_passes_the_barrier_completion_through() {
        let (mock, rec) = MockCapture::new();
        rec.lock().unwrap().started = true;
        let cap = mutex(mock);

        let report = stop_capture_impl(&cap).unwrap();

        // The truthful-completion contract: callers read how the barrier
        // completed from the report itself, so the command must pass the
        // capture layer's completion through unchanged.
        assert_eq!(report.completion, BarrierCompletion::MarkerOrdered);
    }

    #[test]
    fn barrier_report_serializes_completion_snake_case_for_the_frontend() {
        // The frontend distinguishes outcomes by the serialized string, so the
        // wire form is part of the contract.
        let report = BarrierReport {
            barrier_id: 3,
            wedged_workers: 0,
            completion: BarrierCompletion::FallbackDrained,
        };
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["completion"], "fallback_drained");
        assert_eq!(v["barrier_id"], 3);
        let ordered = serde_json::to_value(BarrierCompletion::MarkerOrdered).unwrap();
        assert_eq!(ordered, "marker_ordered");
        let not_run = serde_json::to_value(BarrierCompletion::NotRun).unwrap();
        assert_eq!(not_run, "not_run");
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

    // ── commit_barrier_impl ─────────────────────────────────────────────────

    #[test]
    fn commit_barrier_invokes_the_layer_and_reports() {
        let (mock, rec) = MockCapture::new();
        let cap = mutex(mock);

        let report = commit_barrier_impl(&cap).unwrap();

        assert_eq!(rec.lock().unwrap().barrier_calls, 1);
        assert_eq!(report.barrier_id, 1);
        assert_eq!(report.wedged_workers, 0);
    }

    #[test]
    fn commit_barrier_reports_wedged_workers() {
        let (mut mock, _rec) = MockCapture::new();
        mock.barrier_wedged = 2;
        let cap = mutex(mock);

        let report = commit_barrier_impl(&cap).unwrap();

        assert_eq!(report.wedged_workers, 2);
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

    // ── the session file's load guard ───────────────────────────────────
    //
    // The filesystem cases run through the public entry points in
    // tests/commands_test.rs. These reach what those cannot: a move aside
    // that fails, and the refusal it leaves for the rest of the run.
    mod session_guard {
        use super::super::*;
        use crate::secret_store::DisabledStore;

        fn failing_rename(_: &Path, _: &Path) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "held by another program",
            ))
        }

        fn real_rename(from: &Path, to: &Path) -> std::io::Result<()> {
            fs::rename(from, to)
        }

        #[test]
        fn a_file_that_cannot_be_moved_stays_in_place_and_every_later_save_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("session.json");
            fs::write(&path, "{cut off").unwrap();
            let guard = SessionGuard::default();

            let result = load_guarded(Ok(path.clone()), &DisabledStore, &guard, &failing_rename);

            match result {
                Err(LoadError::KeptInPlace { path: p, reason }) => {
                    assert_eq!(p, path.display().to_string());
                    assert!(reason.contains("held by another program"), "{reason}");
                }
                other => panic!("expected KeptInPlace, got {other:?}"),
            }
            assert_eq!(fs::read_to_string(&path).unwrap(), "{cut off");
            assert!(guard.saves_refused());

            let saved = save_state_impl(r#"{"projects":[]}"#.to_string(), &DisabledStore, &guard);
            assert!(saved.unwrap_err().starts_with("Not saved:"));
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                "{cut off",
                "the file is untouched"
            );
        }

        #[test]
        fn a_later_load_in_the_run_moves_nothing_and_the_refusal_holds() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("session.json");
            fs::write(&path, "{cut off").unwrap();
            let guard = SessionGuard::default();
            let _ = load_guarded(Ok(path.clone()), &DisabledStore, &guard, &failing_rename);

            // Another program lets go of the file later in the run, so a
            // second move would now work. The user was told the file stays
            // where it is, and the panel's copy in memory started empty, so
            // a later load moves nothing and the refusal stands.
            let later = load_guarded(Ok(path.clone()), &DisabledStore, &guard, &real_rename);
            assert!(
                matches!(later, Err(LoadError::KeptInPlace { .. })),
                "{later:?}"
            );
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                "{cut off",
                "not moved, not changed"
            );
            assert_eq!(
                fs::read_dir(dir.path()).unwrap().count(),
                1,
                "nothing set aside"
            );
            assert!(
                guard.saves_refused(),
                "the refusal is never lifted during the run"
            );
        }

        #[test]
        fn an_unknown_location_refuses_every_later_save() {
            let guard = SessionGuard::default();
            let result = load_guarded(
                Err("APPDATA environment variable not set".to_string()),
                &DisabledStore,
                &guard,
                &real_rename,
            );
            assert_eq!(
                result,
                Err(LoadError::NoLocation {
                    reason: "APPDATA environment variable not set".to_string()
                })
            );
            assert!(guard.saves_refused());

            // A later load of the run, with the location now known, answers
            // with the same error and reads nothing.
            let dir = tempfile::tempdir().unwrap();
            let later = load_guarded(
                Ok(dir.path().join("session.json")),
                &DisabledStore,
                &guard,
                &real_rename,
            );
            assert_eq!(later, result);
        }

        #[test]
        fn a_set_aside_and_a_missing_file_leave_saving_on() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("session.json");
            let guard = SessionGuard::default();

            assert_eq!(
                load_guarded(Ok(path.clone()), &DisabledStore, &guard, &real_rename),
                Ok("{}".to_string())
            );
            fs::write(&path, "nope").unwrap();
            let set_aside = load_guarded(Ok(path.clone()), &DisabledStore, &guard, &real_rename);
            assert!(
                matches!(set_aside, Err(LoadError::SetAside { .. })),
                "{set_aside:?}"
            );
            assert!(!guard.saves_refused());
        }

        #[test]
        fn the_error_reaches_the_frontend_tagged_by_kind() {
            let err = LoadError::SetAside {
                path: "C:\\a\\session.json".to_string(),
                kept_as: "C:\\a\\session.unreadable-20261121T171500Z.json".to_string(),
                reason: "it is not text".to_string(),
                state: "{}".to_string(),
            };
            let v = serde_json::to_value(&err).unwrap();
            assert_eq!(v["kind"], "set_aside");
            assert_eq!(
                v["kept_as"],
                "C:\\a\\session.unreadable-20261121T171500Z.json"
            );
            let v = serde_json::to_value(LoadError::KeptInPlace {
                path: "p".to_string(),
                reason: "r".to_string(),
            })
            .unwrap();
            assert_eq!(v["kind"], "kept_in_place");
            let v = serde_json::to_value(LoadError::NoLocation {
                reason: "r".to_string(),
            })
            .unwrap();
            assert_eq!(v["kind"], "no_location");
        }

        /// A credential store holding the dispatch key, as on a machine
        /// where the user configured one.
        struct OneKeyStore;
        impl SecretStore for OneKeyStore {
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                Ok(())
            }
            fn get(&self, name: &str) -> Result<Option<String>, String> {
                Ok((name == "apiKey").then(|| "stored-key".to_string()))
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
        }

        #[test]
        fn a_set_aside_shows_no_stored_key_when_printed() {
            let err = LoadError::SetAside {
                path: "p".to_string(),
                kept_as: "k".to_string(),
                reason: "r".to_string(),
                state: r#"{"settings":{"apiKey":"stored-key"}}"#.to_string(),
            };
            let shown = format!("{err:?}");
            assert!(!shown.contains("stored-key"), "{}", shown.len());
            assert!(shown.contains("<withheld>"));
        }

        #[test]
        fn a_set_aside_starts_from_the_stored_keys_so_a_save_keeps_them() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("session.json");
            fs::write(&path, "{cut off").unwrap();

            let result = load_guarded(
                Ok(path),
                &OneKeyStore,
                &SessionGuard::default(),
                &real_rename,
            );

            match result {
                Err(LoadError::SetAside { state, .. }) => {
                    let v: serde_json::Value = serde_json::from_str(&state).unwrap();
                    assert_eq!(v["settings"]["apiKey"], "stored-key");
                }
                other => panic!("expected SetAside, got {other:?}"),
            }
        }

        #[test]
        fn utc_stamp_names_the_moment_in_utc() {
            use std::time::{Duration, UNIX_EPOCH};
            assert_eq!(utc_stamp(UNIX_EPOCH), "19700101T000000Z");
            // 2026-11-21 17:15:00 UTC
            assert_eq!(
                utc_stamp(UNIX_EPOCH + Duration::from_secs(1_795_281_300)),
                "20261121T171500Z"
            );
            // A leap day: 2024-02-29 23:59:59 UTC
            assert_eq!(
                utc_stamp(UNIX_EPOCH + Duration::from_secs(1_709_251_199)),
                "20240229T235959Z"
            );
        }
    }

    // ── secret-at-rest JSON wrappers ────────────────────────────────────
    //
    // The wrappers gate on `store.enabled()`. These tests pass an explicitly
    // enabled in-memory mock (the trait default is enabled), so they exercise
    // the strip/inject path on every platform — no dependency on the live
    // credential backend. The underlying strip/inject logic also has dedicated
    // unit tests in `secret_store.rs`.
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
        fn disabled_store_leaves_json_untouched() {
            // A DisabledStore (enabled() == false) must pass JSON through
            // verbatim — this is the path the filesystem integration tests and
            // non-Windows targets rely on.
            use crate::secret_store::DisabledStore;
            let data =
                r#"{"settings":{"endpointUrl":"https://api.test","apiKey":"secret"}}"#.to_string();
            assert_eq!(
                strip_secrets_from_json(data.clone(), &DisabledStore).unwrap(),
                data
            );
            assert_eq!(inject_secrets_into_json(data.clone(), &DisabledStore), data);
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
        fn empty_object_round_trips_without_gaining_settings() {
            // Regression: inject must not synthesise an empty `settings` object
            // when the store holds no secrets — `"{}"` must stay `"{}"`.
            let store = MemStore::default();
            assert_eq!(inject_secrets_into_json("{}".to_string(), &store), "{}");
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
