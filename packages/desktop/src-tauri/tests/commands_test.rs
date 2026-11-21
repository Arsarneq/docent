//! Unit tests for the persistence commands (load_state, save_state).
//!
//! These test the pure filesystem logic without requiring the full Tauri
//! runtime. We override APPDATA to point to a temp directory so tests
//! don't interfere with real user data.

use std::env;
use std::fs;
use std::path::PathBuf;

use serial_test::serial;

/// Get the session file path (same logic as commands.rs)
fn session_file_path() -> PathBuf {
    let appdata = env::var("APPDATA").expect("APPDATA must be set");
    PathBuf::from(appdata)
        .join("com.docent.desktop")
        .join("session.json")
}

/// Helper: set APPDATA to a temp directory for test isolation
fn with_temp_appdata(test_name: &str) -> tempfile::TempDir {
    let tmp = tempfile::Builder::new()
        .prefix(&format!("docent-test-{test_name}-"))
        .tempdir()
        .expect("Failed to create temp dir");
    env::set_var("APPDATA", tmp.path());
    tmp
}

// We call the commands module functions directly.
// Since they use APPDATA internally, we override it per test.
//
// These tests cover the raw filesystem persistence, so they drive the
// `_impl` entry points with a `DisabledStore`: that keeps load/save byte-exact
// (no secret strip/inject) and, crucially, never touches the machine-global
// Windows Credential Manager — which is shared across the whole test binary and
// would otherwise leak `apiKey` values between #[serial] tests. Secret
// strip/inject has its own dedicated unit tests in `secret_store.rs` and
// `commands.rs`.
use docent_desktop_lib::commands::{load_state_impl, save_state_impl, LoadError, SessionGuard};
use docent_desktop_lib::secret_store::DisabledStore;

/// The filesystem-only store used by every persistence test here.
fn store() -> DisabledStore {
    DisabledStore
}

/// A fresh guard, as a newly started app holds one.
fn guard() -> SessionGuard {
    SessionGuard::default()
}

/// The names of the entries in the session folder, sorted.
fn session_dir_entries() -> Vec<String> {
    let dir = session_file_path().parent().unwrap().to_path_buf();
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Write `bytes` as the session file, creating its folder.
fn write_session_file(bytes: &[u8]) {
    let path = session_file_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
}

/// Load, expecting the file to have been set aside; returns where it was kept.
fn load_expecting_set_aside(guard: &SessionGuard) -> PathBuf {
    match load_state_impl(&store(), guard) {
        Err(LoadError::SetAside { path, kept_as, .. }) => {
            assert_eq!(PathBuf::from(path), session_file_path());
            PathBuf::from(kept_as)
        }
        other => panic!("expected the session file to be set aside, got {other:?}"),
    }
}

#[test]
#[serial]
fn load_state_returns_empty_object_when_no_file_exists() {
    let _tmp = with_temp_appdata("load-missing");

    let result = load_state_impl(&store(), &guard());
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "{}");
}

#[test]
#[serial]
fn save_state_creates_file_and_directories() {
    let _tmp = with_temp_appdata("save-creates");

    let data = r#"{"projects":[],"settings":{}}"#.to_string();
    let result = save_state_impl(data.clone(), &store(), &guard());
    assert!(result.is_ok());

    // Verify file was written
    let path = session_file_path();
    assert!(path.exists());
    let contents = fs::read_to_string(&path).unwrap();
    assert_eq!(contents, data);
}

#[test]
#[serial]
fn load_state_reads_saved_data() {
    let _tmp = with_temp_appdata("load-saved");

    let data = r#"{"projects":[{"project_id":"abc","name":"Test"}],"settings":{"theme":"dark"}}"#
        .to_string();
    save_state_impl(data.clone(), &store(), &guard()).unwrap();

    let result = load_state_impl(&store(), &guard());
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), data);
}

#[test]
#[serial]
fn save_state_overwrites_existing_file() {
    let _tmp = with_temp_appdata("save-overwrite");

    save_state_impl(r#"{"old":"data"}"#.to_string(), &store(), &guard()).unwrap();
    save_state_impl(r#"{"new":"data"}"#.to_string(), &store(), &guard()).unwrap();

    let result = load_state_impl(&store(), &guard()).unwrap();
    assert_eq!(result, r#"{"new":"data"}"#);
}

#[test]
#[serial]
fn load_state_sets_aside_a_session_path_it_cannot_read() {
    let _tmp = with_temp_appdata("load-unreadable");

    // The session path is a folder, so it cannot be read as a file.
    let path = session_file_path();
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("inside.txt"), "kept").unwrap();

    let g = guard();
    let kept_as = load_expecting_set_aside(&g);

    assert!(
        !path.exists(),
        "the unreadable entry no longer sits at the session path"
    );
    assert_eq!(
        fs::read_to_string(kept_as.join("inside.txt")).unwrap(),
        "kept"
    );
}

#[test]
#[serial]
fn load_state_sets_aside_a_file_that_is_not_json_and_keeps_its_bytes() {
    let _tmp = with_temp_appdata("load-cut-off");

    // A save cut off half-way leaves a file like this one.
    let cut_off = br#"{"projects":[{"project_id":"p1","name":"Checkout fl"#;
    write_session_file(cut_off);

    let g = guard();
    let kept_as = load_expecting_set_aside(&g);

    assert!(!session_file_path().exists());
    assert_eq!(
        kept_as.parent().unwrap(),
        session_file_path().parent().unwrap()
    );
    let name = kept_as.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("session.unreadable-") && name.ends_with(".json"),
        "kept as {name}"
    );
    assert_eq!(
        fs::read(&kept_as).unwrap(),
        cut_off,
        "the kept file is byte for byte the one read"
    );
}

#[test]
#[serial]
fn load_state_sets_aside_json_that_is_not_an_object() {
    for (i, text) in ["[1,2,3]", "null", "\"projects\"", "42"].iter().enumerate() {
        let _tmp = with_temp_appdata(&format!("load-not-object-{i}"));
        write_session_file(text.as_bytes());

        let kept_as = load_expecting_set_aside(&guard());
        assert_eq!(fs::read_to_string(&kept_as).unwrap(), *text);
    }
}

#[test]
#[serial]
fn load_state_sets_aside_a_file_that_is_not_text() {
    let _tmp = with_temp_appdata("load-not-utf8");
    let bytes = [0xff_u8, 0xfe, 0x00, 0x7b];
    write_session_file(&bytes);

    let kept_as = load_expecting_set_aside(&guard());
    assert_eq!(fs::read(&kept_as).unwrap(), bytes);
}

#[test]
#[serial]
fn a_save_after_a_set_aside_writes_a_new_file_and_leaves_the_kept_one_alone() {
    let _tmp = with_temp_appdata("save-after-set-aside");
    write_session_file(b"{not json");

    let g = guard();
    let kept_as = load_expecting_set_aside(&g);

    // The app started empty; its first save writes a fresh session file.
    let fresh = r#"{"projects":[],"settings":{}}"#.to_string();
    save_state_impl(fresh.clone(), &store(), &g).unwrap();

    assert_eq!(fs::read_to_string(session_file_path()).unwrap(), fresh);
    assert_eq!(fs::read_to_string(&kept_as).unwrap(), "{not json");
    // Later loads read the fresh file as usual.
    assert_eq!(load_state_impl(&store(), &g).unwrap(), fresh);
}

#[test]
#[serial]
fn a_second_set_aside_never_replaces_the_first() {
    let _tmp = with_temp_appdata("set-aside-twice");

    write_session_file(b"first broken");
    let first = load_expecting_set_aside(&guard());
    write_session_file(b"second broken");
    let second = load_expecting_set_aside(&guard());

    assert_ne!(first, second);
    assert_eq!(fs::read_to_string(&first).unwrap(), "first broken");
    assert_eq!(fs::read_to_string(&second).unwrap(), "second broken");
}

#[test]
#[serial]
fn save_state_leaves_only_the_session_file_behind() {
    let _tmp = with_temp_appdata("save-no-leftovers");

    save_state_impl(r#"{"a":1}"#.to_string(), &store(), &guard()).unwrap();
    save_state_impl(r#"{"a":2}"#.to_string(), &store(), &guard()).unwrap();

    assert_eq!(session_dir_entries(), vec!["session.json".to_string()]);
    assert_eq!(
        fs::read_to_string(session_file_path()).unwrap(),
        r#"{"a":2}"#
    );
}

#[test]
#[serial]
fn round_trip_preserves_valid_json() {
    let _tmp = with_temp_appdata("round-trip");

    let state = serde_json::json!({
        "projects": [{
            "project_id": "019e0000-0000-7000-8000-000000000001",
            "name": "Round Trip Test",
            "created_at": "2026-01-01T00:00:00.000Z",
            "metadata": { "ticket": "PROJ-42", "tags": ["smoke", "login"] },
            "recordings": [{
                "recording_id": "019e0000-0000-7000-8000-000000000002",
                "name": "Flow A",
                "created_at": "2026-01-01T00:00:00.000Z",
                "metadata": { "env": "staging" },
                "steps": [{
                    "uuid": "019e0000-0000-7000-8000-000000000003",
                    "logical_id": "019e0000-0000-7000-8000-000000000004",
                    "step_number": 1,
                    "created_at": "2026-01-01T00:00:00.000Z",
                    "step_type": "validation",
                    "expect": "present",
                    "actions": [{"type": "click", "timestamp": 1000}],
                    "deleted": false
                }]
            }]
        }],
        "settings": {
            "endpointUrl": "http://localhost:3000",
            "apiKey": "secret",
            "theme": "dark",
            "selfCaptureExclusion": true,
            "recordingMode": "simple"
        }
    });

    let json_str = serde_json::to_string(&state).unwrap();
    save_state_impl(json_str.clone(), &store(), &guard()).unwrap();

    let loaded = load_state_impl(&store(), &guard()).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&loaded).unwrap();
    assert_eq!(parsed, state);
}
