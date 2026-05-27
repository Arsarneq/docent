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
use docent_desktop_lib::commands::{load_state, save_state};

#[test]
#[serial]
fn load_state_returns_empty_object_when_no_file_exists() {
    let _tmp = with_temp_appdata("load-missing");

    let result = load_state();
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "{}");
}

#[test]
#[serial]
fn save_state_creates_file_and_directories() {
    let _tmp = with_temp_appdata("save-creates");

    let data = r#"{"projects":[],"settings":{}}"#.to_string();
    let result = save_state(data.clone());
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
    save_state(data.clone()).unwrap();

    let result = load_state();
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), data);
}

#[test]
#[serial]
fn save_state_overwrites_existing_file() {
    let _tmp = with_temp_appdata("save-overwrite");

    save_state(r#"{"old":"data"}"#.to_string()).unwrap();
    save_state(r#"{"new":"data"}"#.to_string()).unwrap();

    let result = load_state().unwrap();
    assert_eq!(result, r#"{"new":"data"}"#);
}

#[test]
#[serial]
fn load_state_returns_empty_object_for_unreadable_file() {
    let _tmp = with_temp_appdata("load-unreadable");

    // Create the directory but make the file a directory (unreadable as file)
    let path = session_file_path();
    fs::create_dir_all(&path).unwrap(); // path is now a directory, not a file

    let result = load_state();
    assert!(result.is_ok());
    // Should return "{}" gracefully (Req 14.4)
    assert_eq!(result.unwrap(), "{}");
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
    save_state(json_str.clone()).unwrap();

    let loaded = load_state().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&loaded).unwrap();
    assert_eq!(parsed, state);
}
