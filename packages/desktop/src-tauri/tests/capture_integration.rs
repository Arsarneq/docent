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

#[cfg(target_os = "windows")]
mod user_actions {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow, GetWindowRect,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE, WINDOW_EX_STYLE,
    };
    use windows::Win32::Foundation::RECT;
    use windows::core::w;

    /// Create a test window and return its handle + center coordinates.
    unsafe fn create_target_window() -> (HWND, i32, i32) {
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!("Docent Test Target"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            200, 200, 600, 400,
            HWND::default(),
            None,
            None,
            Some(ptr::null()),
        ).expect("Failed to create target window");

        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));

        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).unwrap();
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;

        (hwnd, cx, cy)
    }

    #[test]
    #[serial]
    fn click_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(clicks(&events).len() >= 1, "Expected at least 1 click, got {}", clicks(&events).len());
    }

    #[test]
    #[serial]
    fn right_click_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Right, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(right_clicks(&events).len() >= 1, "Expected at least 1 right_click, got {}", right_clicks(&events).len());
    }

    #[test]
    #[serial]
    fn key_press_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Return, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(keys(&events).len() >= 1, "Expected at least 1 key event, got {}", keys(&events).len());
    }

    #[test]
    #[serial]
    fn scroll_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.scroll(5, enigo::Axis::Vertical).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(scrolls(&events).len() >= 1, "Expected at least 1 scroll event, got {}", scrolls(&events).len());
    }

    #[test]
    #[serial]
    fn typing_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.text("hello").unwrap();
        thread::sleep(Duration::from_millis(600));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let total = keys(&events).len() + types(&events).len();
        assert!(total >= 1, "Expected at least 1 key or type event from typing, got {}", total);
    }

    #[test]
    #[serial]
    fn double_click_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(clicks(&events).len() >= 2, "Expected at least 2 clicks for double-click, got {}", clicks(&events).len());
    }

    #[test]
    #[serial]
    fn drag_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx - 50, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Press).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.move_mouse(cx + 150, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let drags: Vec<_> = events.iter()
            .filter(|e| matches!(&e.payload, ActionPayload::DragStart { .. }))
            .collect();
        let drops: Vec<_> = events.iter()
            .filter(|e| matches!(&e.payload, ActionPayload::Drop { .. }))
            .collect();

        assert!(drags.len() >= 1, "Expected at least 1 drag_start, got {}", drags.len());
        assert!(drops.len() >= 1, "Expected at least 1 drop, got {}", drops.len());
    }

    #[test]
    #[serial]
    fn modifier_key_combo_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Control, Direction::Press).unwrap();
        enigo.key(enigo::Key::Unicode('a'), Direction::Click).unwrap();
        enigo.key(enigo::Key::Control, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(keys(&events).len() >= 1, "Expected at least 1 key event for Ctrl+A, got {}", keys(&events).len());
    }
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


// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL USER ACTION TESTS — window switching, special keys
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod user_actions_advanced {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow, GetWindowRect,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE, WINDOW_EX_STYLE,
    };
    use windows::Win32::Foundation::RECT;
    use windows::core::w;

    unsafe fn create_target_window(title: &str, x: i32, y: i32) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            x, y, 400, 300,
            HWND::default(),
            None,
            None,
            Some(ptr::null()),
        ).expect("Failed to create target window");

        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));

        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).unwrap();
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;

        (hwnd, cx, cy)
    }

    #[test]
    #[serial]
    fn user_click_switches_window_produces_context_switch() {
        // User clicking a different window should produce a context_switch.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create two windows.
        let (hwnd1, _, _) = unsafe { create_target_window("Window A", 100, 100) };
        thread::sleep(Duration::from_millis(200));
        let (hwnd2, cx2, cy2) = unsafe { create_target_window("Window B", 600, 100) };
        thread::sleep(Duration::from_millis(200));

        // Bring window A to front, then click on window B.
        unsafe { let _ = SetForegroundWindow(hwnd1); }
        thread::sleep(Duration::from_millis(300));

        // Clear any setup events by stopping and restarting.
        // Actually, just wait and then do the user action.
        let mut enigo = Enigo::new(&Settings::default()).unwrap();

        // Now simulate clicking window B (the user action).
        enigo.move_mouse(cx2, cy2, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd1);
            let _ = DestroyWindow(hwnd2);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have a click AND a context_switch (user switched windows by clicking).
        let click_events = clicks(&events);
        let switch_events = context_switches(&events);
        assert!(click_events.len() >= 1, "Expected click when switching windows, got {}", click_events.len());
        assert!(switch_events.len() >= 1, "Expected context_switch when clicking different window, got {}", switch_events.len());
    }

    #[test]
    #[serial]
    fn escape_key_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Escape Test", 200, 200) };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let key_events = keys(&events);
        assert!(key_events.len() >= 1, "Expected Escape key event, got {}", key_events.len());
    }

    #[test]
    #[serial]
    fn tab_key_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Tab Test", 200, 200) };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Tab, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let key_events = keys(&events);
        assert!(key_events.len() >= 1, "Expected Tab key event, got {}", key_events.len());
    }

    #[test]
    #[serial]
    fn arrow_keys_are_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Arrow Test", 200, 200) };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::DownArrow, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.key(enigo::Key::UpArrow, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let key_events = keys(&events);
        assert!(key_events.len() >= 2, "Expected at least 2 arrow key events, got {}", key_events.len());
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL SIDE-EFFECT TESTS — selection, notifications, title changes
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod side_effects_more {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow,
        SetWindowTextW, ShowWindow,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE, WS_POPUP,
        SW_SHOW, SW_HIDE,
        WINDOW_EX_STYLE,
    };
    use windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST;
    use windows::core::w;

    unsafe fn create_test_window(title: &str) -> HWND {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
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
    fn programmatic_title_change_should_not_be_captured() {
        // Changing a window's title bar text is not a user action.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let hwnd = unsafe { create_test_window("Original Title") };
        thread::sleep(Duration::from_millis(200));

        // Change title multiple times.
        for i in 0..3 {
            let text: Vec<u16> = format!("Title {}\0", i).encode_utf16().collect();
            unsafe { SetWindowTextW(hwnd, windows::core::PCWSTR(text.as_ptr())).unwrap(); }
            thread::sleep(Duration::from_millis(100));
        }
        thread::sleep(Duration::from_millis(600));

        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        let type_events = types(&events);
        assert_eq!(type_events.len(), 0, "Title changes should not produce type events. Got {}.", type_events.len());
    }

    #[test]
    #[serial]
    fn notification_popup_should_not_be_captured() {
        // A transient notification-style window appearing and disappearing
        // should not produce context_open/close/switch events.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create a topmost popup (simulates a notification toast).
        let hwnd = unsafe {
            let title = w!("Notification");
            CreateWindowExW(
                WS_EX_TOPMOST,
                w!("STATIC"),
                title,
                WS_POPUP | WS_VISIBLE,
                800, 50, 300, 80,
                HWND::default(),
                None,
                None,
                Some(ptr::null()),
            ).expect("Failed to create notification window")
        };
        thread::sleep(Duration::from_millis(500));

        // Dismiss it.
        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no lifecycle events from a notification popup.
        let opens = context_opens(&events);
        let closes = context_closes(&events);
        let switches = context_switches(&events);
        assert_eq!(opens.len(), 0, "Notification popup should not produce context_open. Got {}.", opens.len());
        assert_eq!(closes.len(), 0, "Notification popup should not produce context_close. Got {}.", closes.len());
        assert_eq!(switches.len(), 0, "Notification popup should not produce context_switch. Got {}.", switches.len());
    }

    #[test]
    #[serial]
    fn programmatic_show_hide_should_not_be_captured() {
        // Showing and hiding a window programmatically is not a user action.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let hwnd = unsafe { create_test_window("Show/Hide Test") };
        thread::sleep(Duration::from_millis(200));

        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
            thread::sleep(Duration::from_millis(200));
            let _ = ShowWindow(hwnd, SW_SHOW);
        }
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        let opens = context_opens(&events);
        let closes = context_closes(&events);
        assert_eq!(opens.len(), 0, "Show/Hide should not produce context_open. Got {}.", opens.len());
        assert_eq!(closes.len(), 0, "Show/Hide should not produce context_close. Got {}.", closes.len());
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// CAPTURE BEHAVIOUR TESTS — verify specific capture layer logic
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod capture_behaviour {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow, GetWindowRect,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE, WINDOW_EX_STYLE,
    };
    use windows::Win32::Foundation::RECT;
    use windows::core::w;

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            200, 200, 600, 400,
            HWND::default(),
            None,
            None,
            Some(ptr::null()),
        ).expect("Failed to create target window");

        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));

        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).unwrap();
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;
        (hwnd, cx, cy)
    }

    #[test]
    #[serial]
    fn printable_keys_are_not_captured_as_key_events() {
        // The desktop capture layer filters printable characters (a-z, 0-9)
        // from key events — they're redundant with the coalesced type event.
        // Only control keys (Enter, Escape, Tab, Arrows, etc.) should produce key events.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Printable Key Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // Type individual printable characters.
        enigo.key(enigo::Key::Unicode('a'), Direction::Click).unwrap();
        enigo.key(enigo::Key::Unicode('b'), Direction::Click).unwrap();
        enigo.key(enigo::Key::Unicode('c'), Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(600));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Printable keys should NOT produce key events (they're filtered).
        // They should produce a coalesced type event instead.
        let key_events = keys(&events);
        for k in &key_events {
            if let ActionPayload::Key { key, modifiers, .. } = &k.payload {
                // If a key event IS produced, it should not be a plain printable char
                // (unless it has a modifier like Ctrl).
                let is_printable = key.len() == 1 && !modifiers.ctrl && !modifiers.alt && !modifiers.meta;
                assert!(
                    !is_printable,
                    "Printable key '{}' should not produce a key event without modifiers",
                    key
                );
            }
        }
    }

    #[test]
    #[serial]
    fn typing_produces_coalesced_type_event() {
        // Rapid typing should produce a single coalesced type event (not one per keystroke).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Coalesce Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.text("hello").unwrap();
        // Wait for the 500ms type debounce to flush.
        thread::sleep(Duration::from_millis(800));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let type_events = types(&events);
        // Should produce at most 1 coalesced type event (not 5 separate ones).
        assert!(
            type_events.len() <= 1,
            "Expected at most 1 coalesced type event, got {}",
            type_events.len()
        );
    }

    #[test]
    #[serial]
    fn focus_deduplication_works() {
        // Consecutive focus events on the same element should be deduplicated.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Focus Dedup Test") };
        thread::sleep(Duration::from_millis(200));

        // Click the same spot multiple times — should not produce multiple focus events.
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        for _ in 0..3 {
            enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
            enigo.button(enigo::Button::Left, Direction::Click).unwrap();
            thread::sleep(Duration::from_millis(100));
        }
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have 3 clicks but at most 1 focus event (deduplicated).
        let focus_events = focuses(&events);
        assert!(
            focus_events.len() <= 1,
            "Expected at most 1 focus event (deduplicated), got {}",
            focus_events.len()
        );
    }

    #[test]
    #[serial]
    fn password_field_value_is_masked() {
        // When typing in a password field, the captured value should be masked.
        // NOTE: This test requires a window with a password edit control.
        // Using the built-in EDIT class with ES_PASSWORD style.
        use windows::Win32::UI::WindowsAndMessaging::{
            WS_CHILD, ES_PASSWORD, WS_BORDER,
        };

        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create parent window.
        let (parent, _, _) = unsafe { create_target_window("Password Test") };
        thread::sleep(Duration::from_millis(100));

        // Create a password edit control inside it.
        let edit = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("EDIT"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_BORDER | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(ES_PASSWORD as u32),
                10, 10, 200, 30,
                parent,
                None,
                None,
                Some(ptr::null()),
            ).expect("Failed to create edit control")
        };
        thread::sleep(Duration::from_millis(200));

        // Focus the edit and type a password.
        unsafe { let _ = SetForegroundWindow(parent); }
        thread::sleep(Duration::from_millis(100));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // Click on the edit control area.
        let mut rect = RECT::default();
        unsafe { GetWindowRect(edit, &mut rect).unwrap(); }
        let ecx = (rect.left + rect.right) / 2;
        let ecy = (rect.top + rect.bottom) / 2;
        enigo.move_mouse(ecx, ecy, Coordinate::Abs).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(100));

        enigo.text("secret123").unwrap();
        thread::sleep(Duration::from_millis(800));

        unsafe {
            let _ = DestroyWindow(edit);
            let _ = DestroyWindow(parent);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // If a type event was produced, its value should be masked.
        let type_events = types(&events);
        for t in &type_events {
            if let ActionPayload::Type { value, .. } = &t.payload {
                assert!(
                    !value.contains("secret"),
                    "Password value should be masked, but got: '{}'",
                    value
                );
            }
        }
        // Also check no event contains the raw password anywhere.
        let json = format!("{:?}", events);
        assert!(
            !json.contains("secret123"),
            "Raw password 'secret123' should never appear in captured events"
        );
    }

    #[test]
    #[serial]
    fn alt_tab_produces_context_switch() {
        // Alt+Tab is a user action for switching windows.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        // Create two windows so Alt+Tab has something to switch to.
        let (hwnd1, _, _) = unsafe { create_target_window("Alt-Tab A") };
        let (hwnd2, _, _) = unsafe { create_target_window("Alt-Tab B") };
        thread::sleep(Duration::from_millis(300));

        // Simulate Alt+Tab.
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Alt, Direction::Press).unwrap();
        enigo.key(enigo::Key::Tab, Direction::Click).unwrap();
        enigo.key(enigo::Key::Alt, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd1);
            let _ = DestroyWindow(hwnd2);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Alt+Tab should produce a context_switch (user switched windows).
        let switches = context_switches(&events);
        assert!(
            switches.len() >= 1,
            "Expected context_switch from Alt+Tab, got {}",
            switches.len()
        );
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXTENDED USER ACTION TESTS — more input types
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod user_actions_extended {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow, GetWindowRect,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE, WINDOW_EX_STYLE,
    };
    use windows::core::w;

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            200, 200, 600, 400,
            HWND::default(),
            None,
            None,
            Some(ptr::null()),
        ).expect("Failed to create target window");
        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).unwrap();
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;
        (hwnd, cx, cy)
    }

    #[test]
    #[serial]
    fn middle_click_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Middle Click") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Middle, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Middle click should produce a click event.
        let click_events = clicks(&events);
        assert!(click_events.len() >= 1, "Expected middle click to be captured, got {} clicks", click_events.len());
    }

    #[test]
    #[serial]
    fn horizontal_scroll_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("H-Scroll") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.scroll(5, enigo::Axis::Horizontal).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Horizontal scroll should produce a scroll event.
        let scroll_events = scrolls(&events);
        assert!(scroll_events.len() >= 1, "Expected horizontal scroll to be captured, got {}", scroll_events.len());
    }

    #[test]
    #[serial]
    fn f_keys_are_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("F-Key Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::F5, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let key_events = keys(&events);
        assert!(key_events.len() >= 1, "Expected F5 key to be captured, got {}", key_events.len());
    }

    #[test]
    #[serial]
    fn navigation_keys_are_captured() {
        // Home, End, PageUp, PageDown, Delete, Backspace.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Nav Keys") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Home, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.key(enigo::Key::End, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.key(enigo::Key::PageUp, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.key(enigo::Key::PageDown, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.key(enigo::Key::Delete, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.key(enigo::Key::Backspace, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let key_events = keys(&events);
        assert!(key_events.len() >= 6, "Expected at least 6 navigation key events, got {}", key_events.len());
    }

    #[test]
    #[serial]
    fn text_selection_by_shift_click_is_captured() {
        // Shift+click for range selection — both the key modifier and click should be captured.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Shift-Click") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // First click.
        enigo.move_mouse(cx - 50, cy, Coordinate::Abs).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(100));
        // Shift+click (range select).
        enigo.key(enigo::Key::Shift, Direction::Press).unwrap();
        enigo.move_mouse(cx + 50, cy, Coordinate::Abs).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        enigo.key(enigo::Key::Shift, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        assert!(click_events.len() >= 2, "Expected at least 2 clicks for shift-click selection, got {}", click_events.len());
    }

    #[test]
    #[serial]
    fn alt_f4_is_captured() {
        // Alt+F4 is a user action (close window). The key combo should be captured.
        // NOTE: We don't actually want to close our test window via Alt+F4 because
        // STATIC windows don't process WM_CLOSE. We just verify the key is captured.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Alt-F4 Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Alt, Direction::Press).unwrap();
        enigo.key(enigo::Key::F4, Direction::Click).unwrap();
        enigo.key(enigo::Key::Alt, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let key_events = keys(&events);
        assert!(key_events.len() >= 1, "Expected Alt+F4 key event, got {}", key_events.len());
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCROLL BEHAVIOUR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod scroll_behaviour {
    use super::*;
    use std::ptr;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow, GetWindowRect,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE, WINDOW_EX_STYLE,
    };
    use windows::core::w;

    unsafe fn create_target_window() -> (HWND, i32, i32) {
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!("Scroll Test"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            200, 200, 600, 400,
            HWND::default(),
            None,
            None,
            Some(ptr::null()),
        ).expect("Failed to create target window");
        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).unwrap();
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;
        (hwnd, cx, cy)
    }

    #[test]
    #[serial]
    fn small_scroll_is_filtered() {
        // A single small scroll tick should be filtered (below threshold).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        // Single small scroll (1 tick).
        enigo.scroll(1, enigo::Axis::Vertical).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Small scroll should be filtered (threshold not met).
        let scroll_events = scrolls(&events);
        assert_eq!(scroll_events.len(), 0, "Small scroll should be filtered, got {}", scroll_events.len());
    }

    #[test]
    #[serial]
    fn rapid_scrolls_are_coalesced() {
        // Multiple rapid scroll events should be coalesced into one.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window() };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        // Rapid scrolling (many ticks in quick succession).
        for _ in 0..10 {
            enigo.scroll(2, enigo::Axis::Vertical).unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(500));

        unsafe { let _ = DestroyWindow(hwnd); }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should produce at most 1-2 coalesced scroll events (not 10).
        let scroll_events = scrolls(&events);
        assert!(
            scroll_events.len() <= 2,
            "Rapid scrolls should be coalesced, got {} scroll events",
            scroll_events.len()
        );
    }
}
