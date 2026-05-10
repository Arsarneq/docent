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
//! Serial execution is enforced via #[serial] attribute (serial_test crate).
//! Tests share the OS input layer and would interfere in parallel.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use enigo::{Enigo, Keyboard, Mouse, Settings, Coordinate, Direction};

use docent_desktop_lib::capture::{ActionEvent, ActionPayload, CaptureLayer};
use serial_test::serial;

#[cfg(target_os = "windows")]
use docent_desktop_lib::capture::windows::WindowsCapture;

// ─── Test Harness ───────────────────────────────────────────────────────────

/// Start capture, run a closure that simulates input, stop capture,
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

/// Filter events by payload type.
fn clicks(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::Click { .. })).collect()
}

fn right_clicks(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::RightClick { .. })).collect()
}

fn keys(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::Key { .. })).collect()
}

fn scrolls(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::Scroll { .. })).collect()
}

fn focuses(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::Focus { .. })).collect()
}

fn types(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::Type { .. })).collect()
}

fn selects(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::Select { .. })).collect()
}

fn context_opens(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::ContextOpen { .. })).collect()
}

fn context_closes(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::ContextClose { .. })).collect()
}

fn context_switches(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events.iter().filter(|e| matches!(&e.payload, ActionPayload::ContextSwitch { .. })).collect()
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER ACTION TESTS — verify real input IS captured
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_click_is_captured() {
    let events = capture_during(|enigo| {
        enigo.move_mouse(500, 500, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    });

    assert!(
        clicks(&events).len() >= 1,
        "Expected at least 1 click, got {}",
        clicks(&events).len()
    );
}

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_right_click_is_captured() {
    let events = capture_during(|enigo| {
        enigo.move_mouse(500, 500, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Right, Direction::Click).unwrap();
    });

    assert!(
        right_clicks(&events).len() >= 1,
        "Expected at least 1 right_click, got {}",
        right_clicks(&events).len()
    );
}

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_key_press_is_captured() {
    let events = capture_during(|enigo| {
        enigo.key(enigo::Key::Return, Direction::Click).unwrap();
    });

    assert!(
        keys(&events).len() >= 1,
        "Expected at least 1 key event, got {}",
        keys(&events).len()
    );
}

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_scroll_is_captured() {
    let events = capture_during(|enigo| {
        enigo.move_mouse(500, 500, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.scroll(5, enigo::Axis::Vertical).unwrap();
        thread::sleep(Duration::from_millis(500));
    });

    assert!(
        scrolls(&events).len() >= 1,
        "Expected at least 1 scroll event, got {}",
        scrolls(&events).len()
    );
}

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_typing_is_captured() {
    let events = capture_during(|enigo| {
        // Type some characters — should produce value change events
        // on whatever element is focused.
        enigo.text("hello").unwrap();
        thread::sleep(Duration::from_millis(600)); // Wait for type coalescing debounce
    });

    // Typing produces either key events (for individual keys) or type events
    // (coalesced value changes). At minimum we should see activity.
    let total = keys(&events).len() + types(&events).len();
    assert!(
        total >= 1,
        "Expected at least 1 key or type event from typing, got {}",
        total
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIDE-EFFECT TESTS — verify programmatic changes are NOT captured
// These test the same principle as the extension tests: capture what the user
// did, nothing else.
//
// NOTE: These tests will FAIL until the desktop capture layer is fixed to
// filter side-effects. They document the ideal behaviour.
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod side_effects {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, ShowWindow, SetForegroundWindow,
        SetWindowTextW,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        WINDOW_EX_STYLE,
    };
    use windows::core::w;

    /// Helper: create a simple test window and return its handle.
    unsafe fn create_test_window(title: &str) -> HWND {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let class = w!("STATIC"); // Use built-in STATIC class

        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            100, 100, 400, 300,
            HWND::default(),
            None,
            None,
            Some(ptr::null()),
        ).expect("Failed to create test window")
    }

    #[test]
    #[serial]
    fn programmatic_window_create_should_not_be_captured() {
        // A window created programmatically (not by user action) should not
        // produce a context_open event.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Programmatically create a window — this is a side-effect.
        let hwnd = unsafe { create_test_window("Programmatic Window") };
        thread::sleep(Duration::from_millis(500));

        // Clean up.
        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no context_open or context_close events.
        // These are side-effects of programmatic window creation, not user actions.
        let opens = context_opens(&events);
        let closes = context_closes(&events);
        assert_eq!(
            opens.len(), 0,
            "Programmatic window creation should not produce context_open. Got {} events.",
            opens.len()
        );
        assert_eq!(
            closes.len(), 0,
            "Programmatic window destruction should not produce context_close. Got {} events.",
            closes.len()
        );
    }

    #[test]
    #[serial]
    fn programmatic_focus_should_not_be_captured() {
        // When an application programmatically calls SetFocus/SetForegroundWindow,
        // it should not produce a focus or context_switch event.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create a window and programmatically bring it to foreground.
        let hwnd = unsafe { create_test_window("Focus Test Window") };
        thread::sleep(Duration::from_millis(200));
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(500));

        // Clean up.
        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no focus or context_switch events from programmatic focus.
        let focus_events = focuses(&events);
        let switches = context_switches(&events);
        assert_eq!(
            focus_events.len(), 0,
            "Programmatic SetFocus should not produce focus events. Got {}.",
            focus_events.len()
        );
        assert_eq!(
            switches.len(), 0,
            "Programmatic SetForegroundWindow should not produce context_switch. Got {}.",
            switches.len()
        );
    }

    #[test]
    #[serial]
    fn programmatic_value_change_should_not_be_captured() {
        // When an application programmatically sets a control's text,
        // it should not produce a type event.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create a window and programmatically change its text.
        let hwnd = unsafe { create_test_window("Value Test") };
        thread::sleep(Duration::from_millis(200));

        // Programmatically set text — this is a side-effect.
        unsafe {
            let text = w!("Programmatic value change!");
            SetWindowTextW(hwnd, text).unwrap();
        }
        thread::sleep(Duration::from_millis(600)); // Wait for type coalescing

        // Clean up.
        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no type events from programmatic value changes.
        let type_events = types(&events);
        assert_eq!(
            type_events.len(), 0,
            "Programmatic SetWindowText should not produce type events. Got {}.",
            type_events.len()
        );
    }

    #[test]
    #[serial]
    fn timer_value_updates_should_not_be_captured() {
        // When a timer updates a control's value repeatedly,
        // none of those updates should be captured.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let hwnd = unsafe { create_test_window("Timer Test") };
        thread::sleep(Duration::from_millis(200));

        // Simulate timer-driven updates.
        for i in 0..5 {
            let text: Vec<u16> = format!("Update {}\0", i).encode_utf16().collect();
            unsafe {
                SetWindowTextW(hwnd, windows::core::PCWSTR(text.as_ptr())).unwrap();
            }
            thread::sleep(Duration::from_millis(100));
        }
        thread::sleep(Duration::from_millis(600));

        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        let type_events = types(&events);
        assert_eq!(
            type_events.len(), 0,
            "Timer-driven value updates should not produce type events. Got {}.",
            type_events.len()
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL USER ACTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_double_click_is_captured() {
    let events = capture_during(|enigo| {
        enigo.move_mouse(500, 500, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        // Double-click = two rapid clicks.
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    });

    let click_count = clicks(&events).len();
    assert!(
        click_count >= 2,
        "Expected at least 2 click events for double-click, got {}",
        click_count
    );
}

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_drag_is_captured() {
    let events = capture_during(|enigo| {
        // Mouse down at (400, 400), move to (600, 600), mouse up.
        enigo.move_mouse(400, 400, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Press).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.move_mouse(600, 600, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Release).unwrap();
    });

    // A drag should produce drag_start + drop, or at minimum a click
    // (if the drag threshold wasn't met). With 200px movement it should
    // exceed the DRAG_THRESHOLD_PX (5px).
    let drags: Vec<_> = events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::DragStart { .. }))
        .collect();
    let drops: Vec<_> = events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Drop { .. }))
        .collect();

    assert!(
        drags.len() >= 1,
        "Expected at least 1 drag_start event, got {}",
        drags.len()
    );
    assert!(
        drops.len() >= 1,
        "Expected at least 1 drop event, got {}",
        drops.len()
    );
}

#[test]
    #[serial]
#[cfg(target_os = "windows")]
fn user_modifier_key_combo_is_captured() {
    // Ctrl+A should produce a key event with ctrl modifier.
    let events = capture_during(|enigo| {
        enigo.key(enigo::Key::Control, Direction::Press).unwrap();
        enigo.key(enigo::Key::Unicode('a'), Direction::Click).unwrap();
        enigo.key(enigo::Key::Control, Direction::Release).unwrap();
    });

    let key_events = keys(&events);
    assert!(
        key_events.len() >= 1,
        "Expected at least 1 key event for Ctrl+A, got {}",
        key_events.len()
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL SIDE-EFFECT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod side_effects_additional {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow,
        SetWindowTextW, MoveWindow, ShowWindow,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE, SW_MINIMIZE, SW_RESTORE,
        WINDOW_EX_STYLE,
    };
    use windows::core::w;

    unsafe fn create_test_window(title: &str) -> HWND {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let class = w!("STATIC");
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            100, 100, 400, 300,
            HWND::default(),
            None,
            None,
            Some(ptr::null()),
        ).expect("Failed to create test window")
    }

    #[test]
    #[serial]
    fn programmatic_window_move_should_not_be_captured() {
        // Moving a window programmatically is not a user action.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let hwnd = unsafe { create_test_window("Move Test") };
        thread::sleep(Duration::from_millis(200));

        // Programmatically move the window.
        unsafe {
            MoveWindow(hwnd, 200, 200, 500, 400, true).unwrap();
        }
        thread::sleep(Duration::from_millis(300));

        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // No click, drag, or other events should be produced.
        let click_events = clicks(&events);
        let drag_events: Vec<_> = events
            .iter()
            .filter(|e| matches!(&e.payload, ActionPayload::DragStart { .. }))
            .collect();
        assert_eq!(click_events.len(), 0, "Window move should not produce clicks. Got {}.", click_events.len());
        assert_eq!(drag_events.len(), 0, "Window move should not produce drags. Got {}.", drag_events.len());
    }

    #[test]
    #[serial]
    fn programmatic_minimize_restore_should_not_be_captured() {
        // Minimizing and restoring a window programmatically is not a user action.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let hwnd = unsafe { create_test_window("Minimize Test") };
        thread::sleep(Duration::from_millis(200));

        // Programmatically minimize then restore.
        unsafe {
            let _ = ShowWindow(hwnd, SW_MINIMIZE);
            thread::sleep(Duration::from_millis(300));
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // No context_switch or focus events should be produced.
        let switches = context_switches(&events);
        let focus_events = focuses(&events);
        assert_eq!(switches.len(), 0, "Programmatic minimize/restore should not produce context_switch. Got {}.", switches.len());
        assert_eq!(focus_events.len(), 0, "Programmatic minimize/restore should not produce focus. Got {}.", focus_events.len());
    }

    #[test]
    #[serial]
    fn rapid_programmatic_focus_moves_should_not_be_captured() {
        // Simulates form validation: rapidly moving focus across controls.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create multiple windows and rapidly switch focus between them.
        let hwnd1 = unsafe { create_test_window("Focus 1") };
        let hwnd2 = unsafe { create_test_window("Focus 2") };
        let hwnd3 = unsafe { create_test_window("Focus 3") };
        thread::sleep(Duration::from_millis(200));

        unsafe {
            let _ = SetForegroundWindow(hwnd1);
            thread::sleep(Duration::from_millis(100));
            let _ = SetForegroundWindow(hwnd2);
            thread::sleep(Duration::from_millis(100));
            let _ = SetForegroundWindow(hwnd3);
        }
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd1);
            let _ = DestroyWindow(hwnd2);
            let _ = DestroyWindow(hwnd3);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no focus or context_switch events from programmatic focus moves.
        let focus_events = focuses(&events);
        let switches = context_switches(&events);
        assert_eq!(
            focus_events.len(), 0,
            "Rapid programmatic focus moves should not produce focus events. Got {}.",
            focus_events.len()
        );
        assert_eq!(
            switches.len(), 0,
            "Rapid programmatic focus moves should not produce context_switch. Got {}.",
            switches.len()
        );
    }

    #[test]
    #[serial]
    fn programmatic_child_window_should_not_be_captured() {
        // When an application spawns a child/dialog window programmatically,
        // it should not produce context_open.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create a parent window, then spawn a child window.
        let parent = unsafe { create_test_window("Parent") };
        thread::sleep(Duration::from_millis(200));
        let child = unsafe { create_test_window("Child Dialog") };
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(child);
            let _ = DestroyWindow(parent);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no context_open for programmatic child windows.
        let opens = context_opens(&events);
        assert_eq!(
            opens.len(), 0,
            "Programmatic child window should not produce context_open. Got {}.",
            opens.len()
        );
    }
}
