//! Integration test for file dialog navigation capture.
//!
//! ci-skip: launches Notepad via the shell, which isn't reliably available on
//! CI runners — this test is meant to run locally only. The CI Rust coverage
//! discovery step skips any test file whose source contains the `ci-skip`
//! marker, so there's no filename list to maintain in the workflow.
//!
//! Verifies that opening a file dialog and navigating within it does NOT
//! produce spurious events (duplicate selects, context_close from folder
//! refresh, redundant focus events).
//!
//! This retires desktop manual test #5 (File Dialog Navigation).
//!
//! Approach:
//! 1. Open a real file dialog via IFileOpenDialog COM API
//! 2. Wait for it to appear (FindWindowW for dialog class)
//! 3. Navigate by clicking inside the dialog (tree view / list view)
//! 4. Assert: no duplicate select events per click, no context_close
//! 5. Close with Escape
//!
//! Run with: cargo test --test file_dialog_test
//! Requires: Windows (uses COM APIs)

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use enigo::{Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serial_test::serial;

use docent_desktop_lib::capture::{ActionEvent, ActionPayload, CaptureLayer};

#[cfg(target_os = "windows")]
use docent_desktop_lib::capture::windows::WindowsCapture;

// ─── Helpers ────────────────────────────────────────────────────────────────

fn selects(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Select { .. }))
        .collect()
}

fn context_closes(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::ContextClose { .. }))
        .collect()
}

fn clicks(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Click { .. }))
        .collect()
}

fn focuses(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Focus { .. }))
        .collect()
}

// ─── File Dialog Test ───────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod file_dialog_navigation {
    use super::*;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetWindowRect, SetForegroundWindow,
    };

    /// Open a file dialog by launching Notepad and sending Ctrl+O.
    /// Returns the Notepad process PID for cleanup.
    ///
    /// The spawned Notepad is intentionally not `wait()`ed on: the test needs
    /// it alive and interactive while driving the file dialog, and it is reaped
    /// out of band via `taskkill /F /PID` in `kill_process`. This is a
    /// Windows-only test, where the Unix "zombie process" concern the lint
    /// guards against does not apply.
    #[allow(clippy::zombie_processes)]
    fn spawn_notepad_with_dialog(enigo: &mut Enigo) -> u32 {
        use std::process::Command;

        // Launch notepad
        let child = Command::new("notepad.exe")
            .spawn()
            .expect("Failed to launch notepad");
        let pid = child.id();

        // Wait for notepad window to appear and click on it to give it focus
        let start = std::time::Instant::now();
        let notepad_hwnd;
        loop {
            // Try both old and new Notepad class names
            let hwnd = unsafe { FindWindowW(w!("Notepad"), None) }
                .or_else(|_| unsafe { FindWindowW(None, w!("Untitled - Notepad")) });
            if let Ok(h) = hwnd {
                if h != HWND::default() {
                    notepad_hwnd = h;
                    break;
                }
            }
            if start.elapsed() > Duration::from_millis(5000) {
                panic!("Notepad window did not appear within 5s");
            }
            thread::sleep(Duration::from_millis(100));
        }

        // Click on the notepad window to ensure it has focus
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(notepad_hwnd, &mut rect).unwrap();
        }
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(300));

        // Send Ctrl+O to open file dialog
        enigo.key(Key::Control, Direction::Press).unwrap();
        enigo.key(Key::Unicode('o'), Direction::Click).unwrap();
        enigo.key(Key::Control, Direction::Release).unwrap();

        pid
    }

    /// Kill a process by PID.
    fn kill_process(pid: u32) {
        use std::process::Command;
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }

    /// Wait for the file dialog window to appear.
    /// Returns the HWND if found within timeout.
    fn wait_for_dialog(timeout_ms: u64) -> Option<HWND> {
        let start = std::time::Instant::now();
        loop {
            // Common file dialog class name
            let hwnd = unsafe { FindWindowW(w!("#32770"), None) };
            if let Ok(h) = hwnd {
                if h != HWND::default() {
                    return Some(h);
                }
            }
            if start.elapsed() > Duration::from_millis(timeout_ms) {
                return None;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Test: File dialog navigation does not produce spurious context_close events.
    ///
    /// When navigating folders in a file dialog, the internal list view refreshes
    /// which can fire WinEvents that look like window destruction. The capture
    /// layer must filter these out.
    #[test]
    #[serial]
    fn file_dialog_navigation_no_spurious_context_close() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();

        // Open Notepad and its file dialog
        let pid = spawn_notepad_with_dialog(&mut enigo);

        // Wait for file dialog to appear
        let dialog_hwnd = wait_for_dialog(5000).expect("File dialog did not appear within 5s");
        thread::sleep(Duration::from_millis(500));

        // Bring dialog to foreground
        unsafe {
            let _ = SetForegroundWindow(dialog_hwnd);
        }
        thread::sleep(Duration::from_millis(200));

        // Get dialog rect for clicking inside it
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(dialog_hwnd, &mut rect).unwrap();
        }

        // Click in the left panel (navigation pane / tree view area)
        let nav_x = rect.left + (rect.right - rect.left) / 4;
        let nav_y = rect.top + (rect.bottom - rect.top) / 2;

        // First click — select an item in the navigation pane
        enigo.move_mouse(nav_x, nav_y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(800)); // Wait for folder to load

        // Second click — slightly lower to select a different item
        let nav_y2 = nav_y + 30;
        enigo.move_mouse(nav_x, nav_y2, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(800));

        // Third click — in the file list area (right side)
        let list_x = rect.left + (rect.right - rect.left) * 3 / 4;
        let list_y = rect.top + (rect.bottom - rect.top) / 2;
        enigo.move_mouse(list_x, list_y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        // Close the dialog with Escape
        enigo.key(Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        // Kill notepad
        kill_process(pid);
        thread::sleep(Duration::from_millis(300));

        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // ASSERTION 1: No context_close events from folder refresh.
        // The dialog's internal list view refresh should NOT produce context_close.
        let closes = context_closes(&events);
        assert!(
            closes.is_empty(),
            "File dialog navigation produced {} spurious context_close events (expected 0). \
             Folder refresh is leaking as window destruction.",
            closes.len()
        );

        // ASSERTION 2: Clicks should be captured (we clicked 3 times).
        let click_events = clicks(&events);
        assert!(
            click_events.len() >= 2,
            "Expected at least 2 click events from dialog interaction, got {}",
            click_events.len()
        );
    }

    /// Test: File dialog clicks do not produce duplicate select events.
    ///
    /// Each click on a tree item or list item should produce at most one
    /// select event (or zero, since select is suppressed after click).
    #[test]
    #[serial]
    fn file_dialog_no_duplicate_select_per_click() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();

        // Open Notepad and its file dialog
        let pid = spawn_notepad_with_dialog(&mut enigo);
        let dialog_hwnd = wait_for_dialog(5000).expect("File dialog did not appear within 5s");
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = SetForegroundWindow(dialog_hwnd);
        }
        thread::sleep(Duration::from_millis(200));

        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(dialog_hwnd, &mut rect).unwrap();
        }

        // Click in the file list area
        let list_x = rect.left + (rect.right - rect.left) * 3 / 4;
        let list_y = rect.top + (rect.bottom - rect.top) / 2;
        enigo.move_mouse(list_x, list_y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(600));

        // Close
        enigo.key(Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        kill_process(pid);
        thread::sleep(Duration::from_millis(300));

        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Select events should be suppressed after clicks (the click is sufficient).
        // At most 0 select events per click — the capture layer filters them.
        let select_events = selects(&events);
        let click_events = clicks(&events);

        // No more select events than click events (ideally 0 selects)
        assert!(
            select_events.len() <= click_events.len(),
            "Got {} select events for {} clicks — duplicate selects are leaking. \
             Expected select to be suppressed after click.",
            select_events.len(),
            click_events.len()
        );
    }

    /// Test: File dialog does not produce excessive focus noise.
    ///
    /// File dialogs have many internal controls that receive focus. The capture
    /// layer should not produce an unbounded number of focus events — but some
    /// focus events are legitimate (different controls receiving focus).
    /// This test verifies the count stays reasonable (not exponential).
    #[test]
    #[serial]
    fn file_dialog_focus_count_is_bounded() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();

        let pid = spawn_notepad_with_dialog(&mut enigo);
        let dialog_hwnd = wait_for_dialog(5000).expect("File dialog did not appear within 5s");
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = SetForegroundWindow(dialog_hwnd);
        }
        thread::sleep(Duration::from_millis(200));

        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(dialog_hwnd, &mut rect).unwrap();
        }

        // Single click in the navigation pane
        let nav_x = rect.left + (rect.right - rect.left) / 4;
        let nav_y = rect.top + (rect.bottom - rect.top) / 2;
        enigo.move_mouse(nav_x, nav_y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(600));

        // Close
        enigo.key(Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        kill_process(pid);
        thread::sleep(Duration::from_millis(300));

        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Focus events should be bounded — not exponential.
        // A file dialog interaction should produce fewer than 10 focus events total
        // (dialog open + tree view focus + list view focus + a few internal controls).
        let focus_events = focuses(&events);

        assert!(
            focus_events.len() < 10,
            "Got {} focus events from a single dialog interaction — \
             focus noise is not being filtered. Expected < 10.",
            focus_events.len()
        );
    }
}
