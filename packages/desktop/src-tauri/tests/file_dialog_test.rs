//! Integration test for file dialog navigation capture.
//!
//! ci-skip: launches Notepad via the shell, which isn't reliably available on
//! CI runners — this test is meant to run locally only. The CI Rust coverage
//! discovery step skips any test file whose source contains the `ci-skip`
//! marker, so there's no filename list to maintain in the workflow.
//!
//! NOT a CI coverage gap: the behaviours this relies on — `context_close`
//! suppression on list-view refresh, select-after-click suppression, and
//! focus-noise filtering — are pinned deterministically on CI by the
//! `deduplication::*` tests in `capture_integration.rs`. This local-only test is
//! the real-file-dialog integration exercise of that already-covered logic.
//!
//! Verifies that opening a file dialog and *actually navigating the folder
//! tree* (clicking the C: drive in the navigation pane, then opening the
//! "Program Files" folder in the file list) does NOT produce spurious events
//! (context_close from the list-view refresh, duplicate selects, redundant
//! focus noise).
//!
//! This retires desktop manual test #5 (File Dialog Navigation).
//!
//! Navigation is deterministic: target elements (the "(C:)" tree item and the
//! "Program Files" list item) are located by name via UI Automation and clicked
//! at their real bounding-rect centres — no hard-coded pixel guessing. This
//! guarantees the genuine folder-load/list-refresh actually occurs, so the
//! "no spurious context_close" assertion is meaningful rather than vacuous.
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
    use windows::core::BSTR;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, PropertyConditionFlags_None,
        TreeScope_Descendants, UIA_NamePropertyId,
    };
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

    /// A UIA session scoped to a single dialog window, used to locate child
    /// elements by name so the test can click their real screen positions
    /// instead of guessing pixel coordinates.
    ///
    /// Runs in its own STA apartment for the duration of the lookups. (This is
    /// the test harness driving the dialog — entirely separate from the capture
    /// layer's worker threads, which run MTA.)
    struct DialogUia {
        uia: IUIAutomation,
        root: IUIAutomationElement,
    }

    impl DialogUia {
        /// Create a UIA session rooted at the given dialog window.
        fn new(dialog_hwnd: HWND) -> Self {
            unsafe {
                // Best-effort COM init for this thread. Ignore the result:
                // S_OK / S_FALSE mean COM is initialised; RPC_E_CHANGED_MODE
                // means it's already up in another mode, where CoCreateInstance
                // still works via marshaling. We never CoUninitialize — each
                // #[test] runs on its own thread, so COM is torn down when the
                // thread exits. Calling CoUninitialize here would risk releasing
                // the apartment while the IUIAutomation interfaces below are
                // still live (Rust runs an explicit Drop impl before dropping
                // the struct's fields), which segfaults.
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
                    .expect("create IUIAutomation");
                let root = uia
                    .ElementFromHandle(dialog_hwnd)
                    .expect("dialog UIA element");
                Self { uia, root }
            }
        }

        /// Find a descendant element whose Name property exactly equals `name`.
        /// Returns the centre point (screen coords) of its bounding rectangle.
        ///
        /// Retries for up to `timeout_ms` to allow the dialog's view to settle
        /// (e.g. after a navigation refreshes the list).
        fn find_center_by_name(&self, name: &str, timeout_ms: u64) -> Option<(i32, i32)> {
            let start = std::time::Instant::now();
            loop {
                if let Some(point) = self.try_find_center_by_name(name) {
                    return Some(point);
                }
                if start.elapsed() > Duration::from_millis(timeout_ms) {
                    return None;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }

        fn try_find_center_by_name(&self, name: &str) -> Option<(i32, i32)> {
            unsafe {
                let condition = self
                    .uia
                    .CreatePropertyConditionEx(
                        UIA_NamePropertyId,
                        &VARIANT::from(BSTR::from(name)),
                        PropertyConditionFlags_None,
                    )
                    .ok()?;
                let element = self
                    .root
                    .FindFirst(TreeScope_Descendants, &condition)
                    .ok()?;
                // FindFirst returns a null element (not an Err) when nothing
                // matches; CurrentBoundingRectangle then fails, which `ok()?`
                // turns into None.
                let rect = element.CurrentBoundingRectangle().ok()?;
                if rect.right <= rect.left || rect.bottom <= rect.top {
                    return None; // Off-screen / zero-size — not clickable.
                }
                let cx = (rect.left + rect.right) / 2;
                let cy = (rect.top + rect.bottom) / 2;
                Some((cx, cy))
            }
        }
    }

    /// Shared setup: start capture, open Notepad's file dialog, bring it to the
    /// foreground, and return everything the test needs. Panics on setup
    /// failure (a setup failure is a test failure, not a capture-behaviour
    /// result).
    fn open_dialog() -> (
        WindowsCapture,
        mpsc::Receiver<ActionEvent>,
        Enigo,
        u32,
        HWND,
    ) {
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
        thread::sleep(Duration::from_millis(300));

        (capture, rx, enigo, pid, dialog_hwnd)
    }

    /// Move to `(x, y)` and single-click.
    fn click_at(enigo: &mut Enigo, x: i32, y: i32) {
        enigo.move_mouse(x, y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    }

    /// Move to `(x, y)` and double-click (to open a folder in the list view).
    fn double_click_at(enigo: &mut Enigo, x: i32, y: i32) {
        enigo.move_mouse(x, y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(60));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    }

    /// Navigate the dialog: click the C: drive in the navigation pane, then
    /// open the "Program Files" folder in the file list. Returns `true` if both
    /// targets were found and acted on. A `false` return means the environment
    /// didn't present the expected tree (e.g. unusual drive labelling) and the
    /// caller should skip rather than fail.
    fn navigate_c_then_program_files(uia: &DialogUia, enigo: &mut Enigo) -> bool {
        // 1. Click the local C: drive tree item. Drive labels vary
        //    ("Local Disk (C:)", "OS (C:)", …) so match the universal "(C:)".
        let Some((cx, cy)) = uia.find_center_by_name("(C:)", 3000).or_else(|| {
            // Some shells expose the full label; try a couple of common ones.
            uia.find_center_by_name("Local Disk (C:)", 500)
        }) else {
            return false;
        };
        click_at(enigo, cx, cy);
        thread::sleep(Duration::from_millis(1000)); // folder load / list refresh #1

        // 2. Open "Program Files" (exact match, excluding the "(x86)" variant).
        let Some((px, py)) = uia.find_center_by_name("Program Files", 3000) else {
            return false;
        };
        double_click_at(enigo, px, py);
        thread::sleep(Duration::from_millis(1000)); // folder load / list refresh #2

        true
    }

    /// Navigating the folder tree (C: → Program Files) must not make the
    /// capture layer over-report. A single navigation is exercised once and
    /// checked for three distinct noise properties — they're facets of the same
    /// behaviour ("don't emit spurious/duplicate/excessive events during a
    /// dialog interaction"), so running one scenario and asserting all three is
    /// both faithful and ~3x cheaper than three identical-scenario tests.
    ///
    /// Navigation is deterministic (targets located by name via UIA), so the
    /// genuine folder-load/list-view refresh provably occurs — making the
    /// no-`context_close` assertion meaningful rather than vacuous.
    #[test]
    #[serial]
    fn folder_navigation_produces_no_spurious_events() {
        let (mut capture, rx, mut enigo, pid, dialog_hwnd) = open_dialog();
        let uia = DialogUia::new(dialog_hwnd);

        let navigated = navigate_c_then_program_files(&uia, &mut enigo);

        // Close the dialog and clean up.
        enigo.key(Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));
        kill_process(pid);
        thread::sleep(Duration::from_millis(300));
        capture.stop().unwrap();

        if !navigated {
            eprintln!(
                "SKIP: could not locate C: drive and/or Program Files in the dialog; \
                 environment does not present the expected folder tree."
            );
            return;
        }

        let events: Vec<_> = rx.try_iter().collect();
        let click_events = clicks(&events);

        // Sanity: the navigation clicks were captured (so the assertions below
        // are evaluated against a run that actually interacted with the dialog).
        assert!(
            !click_events.is_empty(),
            "Expected at least one click event from folder navigation, got 0"
        );

        // 1. No context_close from the folder-load list-view teardown/rebuild.
        //    The dialog's internal list view refreshes on navigation, firing
        //    WinEvents that look like window destruction; the capture layer
        //    must filter them out.
        let closes = context_closes(&events);
        assert!(
            closes.is_empty(),
            "Folder navigation produced {} spurious context_close events (expected 0). \
             The list-view refresh is leaking as window destruction.",
            closes.len()
        );

        // 2. No more select events than clicks. A click already captures the
        //    user's intent, so the redundant EVENT_OBJECT_SELECTION that fires
        //    alongside it must be suppressed.
        let select_events = selects(&events);
        assert!(
            select_events.len() <= click_events.len(),
            "Got {} select events for {} clicks — duplicate selects are leaking. \
             Expected select to be suppressed after click.",
            select_events.len(),
            click_events.len()
        );

        // 3. Focus noise stays bounded. File dialogs shuffle focus across many
        //    internal controls during navigation; the capture layer should
        //    report some legitimate focus changes but not one per control.
        let focus_events = focuses(&events);
        assert!(
            focus_events.len() < 12,
            "Got {} focus events from a two-step folder navigation — \
             focus noise is not being filtered. Expected < 12.",
            focus_events.len()
        );
    }
}
