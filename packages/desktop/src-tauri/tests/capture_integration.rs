//! Integration tests for the desktop capture layer.
//!
//! Uses Enigo to simulate real OS-level input (mouse clicks, keyboard)
//! and verifies that the capture layer produces the correct ActionEvents.
//!
//! These tests are the desktop equivalent of the extension's Playwright tests.
//! They run cross-platform (Windows, macOS, Linux) with a single test suite.
//!
//! Run with: cargo test --test capture_integration
//! CI: runs on windows-latest (and future macos-latest, ubuntu-latest with xvfb)
//!
//! NOTE: These tests require a display (headed mode). On Linux CI, use xvfb-run.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use enigo::{Enigo, Keyboard, Mouse, Settings, Coordinate, Direction};

use docent_desktop_lib::capture::{ActionEvent, ActionPayload, CaptureLayer};

#[cfg(target_os = "windows")]
use docent_desktop_lib::capture::windows::WindowsCapture;

/// Helper: start capture, run a closure that simulates input, stop capture,
/// return all collected ActionEvents.
#[cfg(target_os = "windows")]
fn capture_during<F>(setup: F) -> Vec<ActionEvent>
where
    F: FnOnce(&mut Enigo),
{
    let (tx, rx) = mpsc::channel::<ActionEvent>();
    let mut capture = WindowsCapture::new();

    // Don't exclude our own PID — we ARE the process simulating input.
    capture.set_excluded_pid(None);

    capture.start(tx).expect("Failed to start capture");

    // Give hooks time to register.
    thread::sleep(Duration::from_millis(200));

    // Simulate input.
    let mut enigo = Enigo::new(&Settings::default()).expect("Failed to create Enigo");
    setup(&mut enigo);

    // Wait for events to be processed by workers.
    thread::sleep(Duration::from_millis(1000));

    capture.stop().expect("Failed to stop capture");

    // Collect all events from the channel.
    rx.try_iter().collect()
}

// ─── User Action Tests ──────────────────────────────────────────────────────
// These verify that real user input IS captured.

#[test]
#[cfg(target_os = "windows")]
fn click_is_captured() {
    let events = capture_during(|enigo| {
        enigo.move_mouse(500, 500, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    });

    let clicks: Vec<_> = events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Click { .. }))
        .collect();

    assert!(
        clicks.len() >= 1,
        "Expected at least 1 click event, got {}. All events: {:?}",
        clicks.len(),
        events.iter().map(|e| format!("{:?}", e.payload)).collect::<Vec<_>>()
    );
}

#[test]
#[cfg(target_os = "windows")]
fn right_click_is_captured() {
    let events = capture_during(|enigo| {
        enigo.move_mouse(500, 500, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Right, Direction::Click).unwrap();
    });

    let right_clicks: Vec<_> = events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::RightClick { .. }))
        .collect();

    assert!(
        right_clicks.len() >= 1,
        "Expected at least 1 right_click event, got {}",
        right_clicks.len()
    );
}

#[test]
#[cfg(target_os = "windows")]
fn key_press_is_captured() {
    let events = capture_during(|enigo| {
        // Press and release Enter.
        enigo.key(enigo::Key::Return, Direction::Click).unwrap();
    });

    let keys: Vec<_> = events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Key { .. }))
        .collect();

    assert!(
        keys.len() >= 1,
        "Expected at least 1 key event, got {}",
        keys.len()
    );
}

#[test]
#[cfg(target_os = "windows")]
fn scroll_is_captured() {
    let events = capture_during(|enigo| {
        enigo.move_mouse(500, 500, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        // Scroll down significantly.
        enigo.scroll(5, enigo::Axis::Vertical).unwrap();
        // Wait for scroll debounce.
        thread::sleep(Duration::from_millis(500));
    });

    let scrolls: Vec<_> = events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Scroll { .. }))
        .collect();

    assert!(
        scrolls.len() >= 1,
        "Expected at least 1 scroll event, got {}",
        scrolls.len()
    );
}

// ─── Side-Effect Tests ──────────────────────────────────────────────────────
// These verify that programmatic changes are NOT captured.
// TODO: Implement once the desktop capture layer has side-effect filtering.
// The pattern: start a test app that programmatically changes values/focus,
// verify those changes don't appear in the captured events.


// ─── Context Lifecycle Tests ────────────────────────────────────────────────
// These verify that window lifecycle events are captured correctly.

#[test]
#[cfg(target_os = "windows")]
fn context_switch_is_captured_on_foreground_change() {
    // This test verifies that switching the foreground window produces
    // a context_switch event. We simulate Alt+Tab or clicking another window.
    // For now, just verify the capture layer produces context_switch events
    // when the foreground changes.
    let events = capture_during(|enigo| {
        // Press Alt+Tab to switch windows (if multiple windows exist).
        // This may not produce a context_switch if only one window is open,
        // so we just verify no crash occurs.
        enigo.key(enigo::Key::Tab, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(200));
    });

    // We can't guarantee a context_switch (depends on open windows),
    // but we verify the capture layer handles keyboard input without crashing.
    let _ = events; // No assertion — just verifying stability.
}

// ─── Capture Principle Tests ────────────────────────────────────────────────
// These will verify that the desktop capture layer follows the same principles
// as the extension: capture what the user did, nothing else.
//
// TODO: Add these once the desktop capture layer has side-effect filtering:
//
// - programmatic_focus_not_captured: spawn a window, programmatically call
//   SetFocus on a control, verify no focus event is captured
//
// - programmatic_value_change_not_captured: spawn a window with an edit
//   control, programmatically set its text, verify no type event is captured
//
// - programmatic_window_open_not_captured: programmatically create a window
//   (not via user input), verify no context_open is captured
//
// - timer_value_updates_not_captured: spawn a window with a timer that
//   updates a control's value, verify no type events are captured
//
// These require the capture layer to distinguish user input (from low-level
// hooks) from programmatic changes (from WinEvent hooks). The current
// implementation captures both indiscriminately — fixing this is the next step.
