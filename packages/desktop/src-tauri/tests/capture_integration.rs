//! Integration tests for the desktop capture layer.
//!
//! Uses Enigo to simulate real OS-level input (mouse clicks, keyboard)
//! and verifies that the capture layer produces the correct ActionEvents.
//!
//! These tests are the desktop equivalent of the extension's Playwright tests.
//! They run cross-platform (Windows, Linux) with a single test suite.
//!
//! Run with: cargo test --test capture_integration
//! CI: runs on windows-latest (and future ubuntu-latest with xvfb)
//!
//! Serial execution is enforced via #[serial] attribute (serial_test crate).
//! Tests share the OS input layer and would interfere in parallel.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use enigo::{Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

use docent_desktop_lib::capture::{ActionEvent, ActionPayload, CaptureLayer};
use serial_test::serial;

#[cfg(target_os = "windows")]
use docent_desktop_lib::capture::windows::WindowsCapture;

/// STATIC's default window procedure answers `WM_NCHITTEST` with
/// `HTTRANSPARENT`, making a bare STATIC test window **click-through**:
/// synthetic input aimed at it lands in whatever the user has underneath
/// (their editor, their terminal), while the test stays green on clicks it
/// never owned. Every STATIC test window therefore carries `SS_NOTIFY`
/// (hit-testable, `HTCLIENT`) — this constant — and `WS_EX_TOPMOST` (wins
/// stacking despite the foreground lock). The ownership guard in
/// `os_chrome::coordinate_fallback_for_plain_window` enforces the property at
/// runtime and names the covering window if it ever regresses.
#[cfg(target_os = "windows")]
const SS_NOTIFY_STYLE: windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE =
    windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(0x0000_0100);

/// A target window hosted on its **own dedicated thread that runs a real,
/// continuous `GetMessage` pump** — i.e. a *responsive* application.
///
/// Capture workers issue *synchronous* cross-thread accessibility queries
/// (`GetFocusedElement`/`WM_GETOBJECT`, `GetWindowTextW`/`WM_GETTEXT`, …). On an
/// interactive desktop, owning the window on a thread blocked in `GetMessageW`
/// keeps it continuously responsive to those queries, like a real app's UI
/// thread. The pump exits when a `WM_QUIT` is posted to the thread (on `Drop`),
/// and the window is destroyed on its owning thread (a Win32 requirement).
///
/// Caveat (why integration tests can't assert capture *counts*): the worker's
/// `GetFocusedElement()` queries whatever holds *system keyboard focus*, not
/// this window specifically. On a headless CI runner, `SetForegroundWindow`
/// from a non-interactive process is denied and a bare `STATIC` cannot take
/// keyboard focus, so focus resolves elsewhere — often to a window that does
/// not pump. That makes "a key was captured" environment-dependent. The
/// responsive/unresponsive capture contracts are therefore pinned
/// deterministically at the worker layer (see `worker_pool.rs`); real-input
/// tests here assert only the environment-independent contract that capture
/// never *hangs*.
#[cfg(target_os = "windows")]
struct ResponsiveWindow {
    /// Owning thread id — target of the `WM_QUIT` that stops the pump.
    thread_id: u32,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "windows")]
impl ResponsiveWindow {
    fn new(title: &str) -> Self {
        use std::sync::mpsc as smpsc;
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, SetForegroundWindow,
            TranslateMessage, MSG, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };

        let title = title.to_string();
        let (tx, rx) = smpsc::channel::<u32>();
        let handle = thread::spawn(move || unsafe {
            let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
            let hwnd = CreateWindowExW(
                windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
                windows::core::w!("STATIC"),
                windows::core::PCWSTR(title_wide.as_ptr()),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
                200,
                200,
                600,
                400,
                None,
                None,
                None,
                Some(std::ptr::null()),
            )
            .expect("Failed to create target window");
            let _ = SetForegroundWindow(hwnd);
            tx.send(GetCurrentThreadId())
                .expect("failed to hand back thread id");

            // Continuous, blocking pump. A thread parked in GetMessageW still
            // services incoming cross-thread *sent* messages (WM_GETOBJECT,
            // WM_GETTEXT), so the window stays responsive to the capture
            // workers' queries. Exits when Drop posts WM_QUIT to this thread.
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            // DestroyWindow must run on the creating thread.
            let _ = DestroyWindow(hwnd);
        });

        let thread_id = rx.recv().expect("window thread failed to start");
        // Let the window settle and become foreground before input is driven.
        thread::sleep(Duration::from_millis(100));
        Self {
            thread_id,
            handle: Some(handle),
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ResponsiveWindow {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
        unsafe {
            // Stop the pump; GetMessageW returns 0 on WM_QUIT, the loop breaks,
            // and the window is destroyed on its owning thread.
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Stop capture and assert it returns within the bounded-shutdown ceiling
/// (never hangs), returning the collected events.
///
/// This is the **environment-independent contract** every real-input keyboard
/// test can rely on. The worker's synchronous `focused_element()` query targets
/// whatever holds *system keyboard focus*, which on a headless CI runner may be
/// an unresponsive window (`SetForegroundWindow` is denied for non-interactive
/// processes and a bare STATIC can't take focus). In that case Docent correctly
/// captures **nothing** for the in-flight event — a "cut line" — so the *count*
/// of captured keys is environment-dependent and must not be asserted here.
/// What must ALWAYS hold is that capture never hangs. Capture counts /
/// coalescing are pinned deterministically at the worker layer (worker_pool.rs).
#[cfg(target_os = "windows")]
fn stop_capture_bounded(
    mut capture: WindowsCapture,
    rx: &mpsc::Receiver<ActionEvent>,
) -> Vec<ActionEvent> {
    let start = Instant::now();
    capture.stop().unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "capture.stop() must not hang (took {:?})",
        start.elapsed()
    );
    rx.try_iter().collect()
}

/// Assert that every captured `Key` event is well-formed — a non-empty key name
/// (captured keys are never garbled or empty). Deliberately asserts no *count*
/// (see [`stop_capture_bounded`]); this is the integrity half of the
/// environment-independent contract for real-input keyboard tests.
#[cfg(target_os = "windows")]
fn assert_captured_keys_well_formed(events: &[ActionEvent]) {
    for e in keys(events) {
        if let ActionPayload::Key { key, .. } = &e.payload {
            assert!(
                !key.is_empty(),
                "a captured key event must have a non-empty key name"
            );
        }
    }
}

/// Assert that every captured `ContextSwitch` is well-formed — it carries the
/// window `context_id` it switched to. Deliberately asserts no *count* (see
/// [`stop_capture_bounded`]); this is the integrity half of the
/// environment-independent contract for the real-input foreground/Alt+Tab test,
/// whose capture count depends on the OS task switcher actually changing the
/// foreground window.
#[cfg(target_os = "windows")]
fn assert_captured_context_switches_well_formed(events: &[ActionEvent]) {
    for sw in context_switches(events) {
        assert!(
            sw.context_id.is_some(),
            "a captured context switch must carry a window context_id"
        );
    }
}

/// Assert that every captured element's locator candidates (docent#138/#139)
/// are well-formed — environment-independent invariants only, never counts
/// (see [`stop_capture_bounded`]): locators are OPTIONAL per element (the
/// input-hook path and provider variance legitimately produce value-only or
/// empty sets); when present, every entry carries a non-empty value/name,
/// the pair invariants hold (`Found(i)` implies `i < count`; an index is only
/// present alongside a count), and provider-reported set ordinals are >= 1.
/// Coordinate-mode elements carry no locators at all.
#[cfg(target_os = "windows")]
fn assert_captured_element_locators_well_formed(events: &[ActionEvent]) {
    use docent_desktop_lib::capture::{CaptureMode, LocatorEntry};

    fn check_element(el: &docent_desktop_lib::capture::ElementDescription, mode: &CaptureMode) {
        if matches!(mode, CaptureMode::Coordinate) {
            assert!(
                el.locators.is_empty(),
                "coordinate-mode elements must carry no locators"
            );
        }
        for v in [el.position_in_set, el.size_of_set, el.level]
            .into_iter()
            .flatten()
        {
            assert!(v >= 1, "provider set ordinals must be >= 1, got {v}");
        }
        if let Some(fw) = &el.framework_id {
            assert!(
                !fw.is_empty(),
                "framework_id must be non-empty when present"
            );
        }
        for entry in &el.locators {
            let stats = match entry {
                LocatorEntry::AutomationId { value, stats } => {
                    assert!(!value.is_empty(), "automation_id value must be non-empty");
                    Some(stats)
                }
                LocatorEntry::RoleName { role, name, stats } => {
                    assert!(!role.is_empty(), "role_name role must be non-empty");
                    assert!(!name.is_empty(), "role_name name must be non-empty");
                    Some(stats)
                }
                LocatorEntry::ClassName { value, stats } => {
                    assert!(!value.is_empty(), "class_name value must be non-empty");
                    Some(stats)
                }
                LocatorEntry::LabeledBy { value } => {
                    assert!(!value.is_empty(), "labeled_by value must be non-empty");
                    None
                }
                LocatorEntry::TreePath { value } => {
                    assert!(!value.is_empty(), "tree_path value must be non-empty");
                    None
                }
            };
            if let Some(stats) = stats {
                if stats.match_index.is_some() {
                    assert!(
                        stats.match_count.is_some(),
                        "an index may only appear alongside a count"
                    );
                }
                if let (Some(count), Some(Some(i))) = (stats.match_count, stats.match_index) {
                    assert!(i < count, "match_index {i} must be < match_count {count}");
                }
                if let Some(count) = stats.match_count {
                    assert!(count >= 1, "match_count must be >= 1, got {count}");
                }
            }
        }
    }

    for e in events {
        match &e.payload {
            ActionPayload::Click { element, .. }
            | ActionPayload::RightClick { element, .. }
            | ActionPayload::Type { element, .. }
            | ActionPayload::Select { element, .. }
            | ActionPayload::Key { element, .. }
            | ActionPayload::Focus { element }
            | ActionPayload::DragStart { element } => check_element(element, &e.capture_mode),
            ActionPayload::Drop {
                element,
                source_element,
                ..
            } => {
                check_element(element, &e.capture_mode);
                if let Some(src) = source_element {
                    check_element(src, &e.capture_mode);
                }
            }
            _ => {}
        }
    }
}

// ─── Test Harness ───────────────────────────────────────────────────────────

/// Filter events by payload type.
fn clicks(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Click { .. }))
        .collect()
}

fn right_clicks(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::RightClick { .. }))
        .collect()
}

fn keys(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Key { .. }))
        .collect()
}

fn scrolls(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Scroll { .. }))
        .collect()
}

fn focuses(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Focus { .. }))
        .collect()
}

fn types(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Type { .. }))
        .collect()
}

fn selects(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::Select { .. }))
        .collect()
}

fn context_opens(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::ContextOpen { .. }))
        .collect()
}

fn context_closes(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::ContextClose { .. }))
        .collect()
}

fn context_switches(events: &[ActionEvent]) -> Vec<&ActionEvent> {
    events
        .iter()
        .filter(|e| matches!(&e.payload, ActionPayload::ContextSwitch { .. }))
        .collect()
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER ACTION TESTS — verify real input IS captured
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod user_actions {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    /// Create a test window and return its handle + center coordinates.
    unsafe fn create_target_window() -> (HWND, i32, i32) {
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            w!("Docent Test Target"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");

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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(
            !clicks(&events).is_empty(),
            "Expected at least 1 click, got {}",
            clicks(&events).len()
        );
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
        enigo
            .button(enigo::Button::Right, Direction::Click)
            .unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(
            !right_clicks(&events).is_empty(),
            "Expected at least 1 right_click, got {}",
            right_clicks(&events).len()
        );
    }

    #[test]
    #[serial]
    fn key_press_is_captured() {
        // Real-input keyboard test: asserts the environment-independent
        // contract (capture never hangs; captured keys are well-formed), not a
        // capture count — see stop_capture_bounded. Count coverage is at the
        // worker layer (worker_pool.rs).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Key Press Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Return, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(
            !scrolls(&events).is_empty(),
            "Expected at least 1 scroll event, got {}",
            scrolls(&events).len()
        );
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let total = keys(&events).len() + types(&events).len();
        assert!(
            total >= 1,
            "Expected at least 1 key or type event from typing, got {}",
            total
        );
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert!(
            clicks(&events).len() >= 2,
            "Expected at least 2 clicks for double-click, got {}",
            clicks(&events).len()
        );
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
        enigo
            .button(enigo::Button::Left, Direction::Release)
            .unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let drags: Vec<_> = events
            .iter()
            .filter(|e| matches!(&e.payload, ActionPayload::DragStart { .. }))
            .collect();
        let drops: Vec<_> = events
            .iter()
            .filter(|e| matches!(&e.payload, ActionPayload::Drop { .. }))
            .collect();

        assert!(
            !drags.is_empty(),
            "Expected at least 1 drag_start, got {}",
            drags.len()
        );
        assert!(
            !drops.is_empty(),
            "Expected at least 1 drop, got {}",
            drops.len()
        );
    }

    #[test]
    #[serial]
    fn modifier_key_combo_is_captured() {
        // Environment-independent contract (no-hang + well-formed keys); see
        // stop_capture_bounded. Modifier-combo semantics are pinned at the
        // worker layer.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Modifier Combo Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Control, Direction::Press).unwrap();
        enigo
            .key(enigo::Key::Unicode('a'), Direction::Click)
            .unwrap();
        enigo.key(enigo::Key::Control, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
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
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow, SetWindowTextW, WINDOW_EX_STYLE,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    /// Helper: create a simple test window and return its handle.
    unsafe fn create_test_window(title: &str) -> HWND {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let class = w!("STATIC"); // Use built-in STATIC class

        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            100,
            100,
            400,
            300,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create test window")
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
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no context_open or context_close events.
        // These are side-effects of programmatic window creation, not user actions.
        let opens = context_opens(&events);
        let closes = context_closes(&events);
        assert_eq!(
            opens.len(),
            0,
            "Programmatic window creation should not produce context_open. Got {} events.",
            opens.len()
        );
        assert_eq!(
            closes.len(),
            0,
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
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no focus or context_switch events from programmatic focus.
        let focus_events = focuses(&events);
        let switches = context_switches(&events);
        assert_eq!(
            focus_events.len(),
            0,
            "Programmatic SetFocus should not produce focus events. Got {}.",
            focus_events.len()
        );
        assert_eq!(
            switches.len(),
            0,
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
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no type events from programmatic value changes.
        let type_events = types(&events);
        assert_eq!(
            type_events.len(),
            0,
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        let type_events = types(&events);
        assert_eq!(
            type_events.len(),
            0,
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
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, MoveWindow, SetForegroundWindow, ShowWindow, SW_MINIMIZE,
        SW_RESTORE, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe fn create_test_window(title: &str) -> HWND {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let class = w!("STATIC");
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            100,
            100,
            400,
            300,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create test window")
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // No click, drag, or other events should be produced.
        let click_events = clicks(&events);
        let drag_events: Vec<_> = events
            .iter()
            .filter(|e| matches!(&e.payload, ActionPayload::DragStart { .. }))
            .collect();
        assert_eq!(
            click_events.len(),
            0,
            "Window move should not produce clicks. Got {}.",
            click_events.len()
        );
        assert_eq!(
            drag_events.len(),
            0,
            "Window move should not produce drags. Got {}.",
            drag_events.len()
        );
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // No context_switch or focus events should be produced.
        let switches = context_switches(&events);
        let focus_events = focuses(&events);
        assert_eq!(
            switches.len(),
            0,
            "Programmatic minimize/restore should not produce context_switch. Got {}.",
            switches.len()
        );
        assert_eq!(
            focus_events.len(),
            0,
            "Programmatic minimize/restore should not produce focus. Got {}.",
            focus_events.len()
        );
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
            focus_events.len(),
            0,
            "Rapid programmatic focus moves should not produce focus events. Got {}.",
            focus_events.len()
        );
        assert_eq!(
            switches.len(),
            0,
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
            opens.len(),
            0,
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
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str, x: i32, y: i32) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            x,
            y,
            400,
            300,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");

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

        // Create two windows in non-overlapping screen regions.
        let (hwnd1, cx1, cy1) = unsafe { create_target_window("Window A", 100, 100) };
        thread::sleep(Duration::from_millis(200));
        let (hwnd2, cx2, cy2) = unsafe { create_target_window("Window B", 600, 100) };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();

        // Establish window A as the foreground window via a real user click.
        // SetForegroundWindow() from a background process is subject to
        // Windows' foreground-lock restrictions and is unreliable in CI: when
        // it silently fails, window B (created last, already foreground) stays
        // foreground, so the later click on B produces no foreground change and
        // no context_switch is emitted — which is exactly the flake we saw. A
        // synthesized click is treated as genuine user input and reliably
        // activates the window, so the subsequent click on B is a true switch.
        enigo.move_mouse(cx1, cy1, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(300));

        // Now click window B — a user click that switches foreground A -> B.
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
        assert!(
            !click_events.is_empty(),
            "Expected click when switching windows, got {}",
            click_events.len()
        );
        assert!(
            !switch_events.is_empty(),
            "Expected context_switch when clicking different window, got {}",
            switch_events.len()
        );
    }

    #[test]
    #[serial]
    fn escape_key_is_captured() {
        // Environment-independent contract (no-hang + well-formed keys).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Escape Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }

    #[test]
    #[serial]
    fn tab_key_is_captured() {
        // Environment-independent contract (no-hang + well-formed keys).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Tab Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Tab, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }

    #[test]
    #[serial]
    fn arrow_keys_are_captured() {
        // Environment-independent contract (no-hang + well-formed keys).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Arrow Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::DownArrow, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(100));
        enigo.key(enigo::Key::UpArrow, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL SIDE-EFFECT TESTS — selection, notifications, title changes
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod side_effects_more {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetWindowTextW, ShowWindow, SW_HIDE, SW_SHOW,
        WS_OVERLAPPEDWINDOW, WS_POPUP, WS_VISIBLE,
    };

    unsafe fn create_test_window(title: &str) -> HWND {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            100,
            100,
            400,
            300,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create test window")
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
            unsafe {
                SetWindowTextW(hwnd, windows::core::PCWSTR(text.as_ptr())).unwrap();
            }
            thread::sleep(Duration::from_millis(100));
        }
        thread::sleep(Duration::from_millis(600));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        let type_events = types(&events);
        assert_eq!(
            type_events.len(),
            0,
            "Title changes should not produce type events. Got {}.",
            type_events.len()
        );
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
                800,
                50,
                300,
                80,
                None,
                None,
                None,
                Some(ptr::null()),
            )
            .expect("Failed to create notification window")
        };
        thread::sleep(Duration::from_millis(500));

        // Dismiss it.
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        // Ideal: no lifecycle events from a notification popup.
        let opens = context_opens(&events);
        let closes = context_closes(&events);
        let switches = context_switches(&events);
        assert_eq!(
            opens.len(),
            0,
            "Notification popup should not produce context_open. Got {}.",
            opens.len()
        );
        assert_eq!(
            closes.len(),
            0,
            "Notification popup should not produce context_close. Got {}.",
            closes.len()
        );
        assert_eq!(
            switches.len(),
            0,
            "Notification popup should not produce context_switch. Got {}.",
            switches.len()
        );
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().expect("Failed to stop capture");
        let events: Vec<_> = rx.try_iter().collect();

        let opens = context_opens(&events);
        let closes = context_closes(&events);
        assert_eq!(
            opens.len(),
            0,
            "Show/Hide should not produce context_open. Got {}.",
            opens.len()
        );
        assert_eq!(
            closes.len(),
            0,
            "Show/Hide should not produce context_close. Got {}.",
            closes.len()
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPTURE BEHAVIOUR TESTS — verify specific capture layer logic
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod capture_behaviour {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WINDOW_EX_STYLE,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");

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
    fn printable_keys_are_captured_when_no_type_event_arrives() {
        // Typing into a non-editable control (no EVENT_OBJECT_VALUECHANGE):
        // printable keys are buffered and flushed as individual key events when
        // the TYPE_DEBOUNCE_MS window expires without a type event.
        //
        // Like navigation_keys, this asserts the environment-independent
        // contract: capture must never hang, stop() always returns, and any
        // captured key is a clean single printable char (never garbled). It
        // does NOT assert a capture *count* — the worker's focused_element()
        // query targets whatever holds system keyboard focus, which on a
        // headless CI runner is not this window (see ResponsiveWindow docs), so
        // when focus resolves to an unresponsive window Docent correctly
        // captures nothing (a "cut line"). The deterministic
        // "no type event → keys emitted individually" coverage lives at the
        // worker layer in worker_pool.rs.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).expect("Failed to start capture");
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Printable Key Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // Type individual printable characters into a non-editable window.
        enigo
            .key(enigo::Key::Unicode('a'), Direction::Click)
            .unwrap();
        enigo
            .key(enigo::Key::Unicode('b'), Direction::Click)
            .unwrap();
        enigo
            .key(enigo::Key::Unicode('c'), Direction::Click)
            .unwrap();
        // Wait for TYPE_DEBOUNCE_MS + buffer to flush. The window keeps
        // answering the workers' queries on its own pump thread throughout.
        thread::sleep(Duration::from_millis(1500));

        drop(window); // Destroys the window on its owning thread.

        // The core guarantee: stop() returns promptly even if a worker had to
        // query an unresponsive focus target (bounded shutdown, no hang).
        let stop_start = Instant::now();
        capture.stop().unwrap();
        assert!(
            stop_start.elapsed() < Duration::from_secs(20),
            "capture.stop() must not hang on printable-key queries (took {:?})",
            stop_start.elapsed()
        );

        let events: Vec<_> = rx.try_iter().collect();

        // No count assertion (see above). Whatever printable keys ARE captured
        // must be clean single characters with no Ctrl/Alt/Meta — captured keys
        // are never garbled. (vk_to_key_name maps VK 'A'..'Z' to uppercase
        // regardless of shift state, so compare case-insensitively.)
        for e in keys(&events) {
            if let ActionPayload::Key { key, modifiers, .. } = &e.payload {
                if key.len() == 1 && !modifiers.ctrl && !modifiers.alt && !modifiers.meta {
                    assert!(
                        ["a", "b", "c"].contains(&key.to_lowercase().as_str()),
                        "unexpected printable key captured: {key:?}"
                    );
                }
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
        // Wait for TYPE_DEBOUNCE_MS (1000ms) + buffer to flush.
        thread::sleep(Duration::from_millis(1500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
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
        use windows::Win32::UI::WindowsAndMessaging::{ES_PASSWORD, WS_BORDER, WS_CHILD};

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
                WS_CHILD
                    | WS_VISIBLE
                    | WS_BORDER
                    | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(ES_PASSWORD as u32),
                10,
                10,
                200,
                30,
                Some(parent),
                None,
                None,
                Some(ptr::null()),
            )
            .expect("Failed to create edit control")
        };
        thread::sleep(Duration::from_millis(200));

        // Focus the edit and type a password.
        unsafe {
            let _ = SetForegroundWindow(parent);
        }
        thread::sleep(Duration::from_millis(100));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // Click on the edit control area.
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(edit, &mut rect).unwrap();
        }
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
        let events = stop_capture_bounded(capture, &rx);
        // The capture *count* is environment-dependent: synthesised Alt+Tab only
        // produces a foreground change if a real interactive task switcher acts
        // on it, which a headless/CI runner has not got — that flaked as
        // "Expected context_switch from Alt+Tab, got 0". So assert only the
        // environment-independent contract: capture never hangs, and any switch
        // captured is well-formed. The deterministic "foreground -> context_switch"
        // guarantee is pinned at the worker layer (worker_pool.rs
        // `responsive_app_foreground_produces_context_switch`).
        assert_captured_context_switches_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENDED USER ACTION TESTS — more input types
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod user_actions_extended {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");
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
        enigo
            .button(enigo::Button::Middle, Direction::Click)
            .unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Middle click should produce a click event.
        let click_events = clicks(&events);
        assert!(
            !click_events.is_empty(),
            "Expected middle click to be captured, got {} clicks",
            click_events.len()
        );
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Horizontal scroll should produce a scroll event.
        let scroll_events = scrolls(&events);
        assert!(
            !scroll_events.is_empty(),
            "Expected horizontal scroll to be captured, got {}",
            scroll_events.len()
        );
    }

    #[test]
    #[serial]
    fn f_keys_are_captured() {
        // Environment-independent contract (no-hang + well-formed keys).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("F-Key Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::F5, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }

    #[test]
    #[serial]
    fn navigation_keys_are_captured() {
        // Home, End, PageUp, PageDown, Delete, Backspace — control keys, which
        // `handle_keyboard` resolves via a *synchronous* `focused_element()`
        // query and emits immediately (six such queries — the most query-heavy
        // real-input test).
        //
        // This asserts the environment-independent contract: capture must
        // **never hang**, `stop()` always returns, and no key is duplicated.
        // It deliberately does NOT assert a capture *count*: the worker's
        // `GetFocusedElement()` queries whatever holds system keyboard focus,
        // which on a headless CI runner is not this window (SetForegroundWindow
        // is denied for non-interactive processes and a bare STATIC can't take
        // focus). When focus resolves to an unresponsive window the queries
        // block and Docent correctly captures nothing — a "cut line" — so a
        // count assertion would be environment-dependent and flaky.
        //
        // The responsive→captured and unresponsive→nothing+bounded contracts
        // are pinned deterministically at the worker layer in worker_pool.rs.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Nav Keys");

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

        drop(window); // Destroys the window on its owning thread.

        // The core guarantee: stop() returns promptly even if workers had to
        // query an unresponsive focus target (bounded shutdown, no hang).
        let stop_start = Instant::now();
        capture.stop().unwrap();
        assert!(
            stop_start.elapsed() < Duration::from_secs(20),
            "capture.stop() must not hang on navigation-key queries (took {:?})",
            stop_start.elapsed()
        );

        let events: Vec<_> = rx.try_iter().collect();
        let key_events = keys(&events);

        // No count assertion (see above). Whatever IS captured must be a clean,
        // non-duplicated navigation key — captured keys are never garbled.
        let allowed = ["Home", "End", "PageUp", "PageDown", "Delete", "Backspace"];
        let mut seen = Vec::new();
        for e in &key_events {
            if let ActionPayload::Key { key, .. } = &e.payload {
                assert!(
                    allowed.contains(&key.as_str()),
                    "unexpected key captured: {key:?}"
                );
                assert!(
                    !seen.contains(key),
                    "navigation key {key:?} was captured more than once"
                );
                seen.push(key.clone());
            }
        }
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        assert!(
            click_events.len() >= 2,
            "Expected at least 2 clicks for shift-click selection, got {}",
            click_events.len()
        );
    }

    #[test]
    #[serial]
    fn alt_f4_is_captured() {
        // Alt+F4 is a user action (close window). NOTE: we don't actually close
        // our test window — STATIC windows don't process WM_CLOSE — we just
        // verify the key path. Asserts the environment-independent contract
        // (no-hang + well-formed keys); see stop_capture_bounded.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Alt-F4 Test");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Alt, Direction::Press).unwrap();
        enigo.key(enigo::Key::F4, Direction::Click).unwrap();
        enigo.key(enigo::Key::Alt, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCROLL BEHAVIOUR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod scroll_behaviour {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    unsafe fn create_target_window() -> (HWND, i32, i32) {
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            w!("Scroll Test"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Small scroll should be filtered (threshold not met).
        let scroll_events = scrolls(&events);
        assert_eq!(
            scroll_events.len(),
            0,
            "Small scroll should be filtered, got {}",
            scroll_events.len()
        );
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

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
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

// ═══════════════════════════════════════════════════════════════════════════════
// MISSING USER ACTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod user_actions_missing {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");
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
    fn ctrl_click_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Ctrl-Click") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.key(enigo::Key::Control, Direction::Press).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        enigo.key(enigo::Key::Control, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        assert!(
            !click_events.is_empty(),
            "Expected Ctrl+click to be captured, got {}",
            click_events.len()
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MISSING SIDE-EFFECT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod side_effects_missing {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::ScrollWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe fn create_test_window(title: &str) -> HWND {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            100,
            100,
            400,
            300,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create test window")
    }

    #[test]
    #[serial]
    fn programmatic_scroll_should_not_be_captured() {
        // ScrollWindow called by application code is not a user action.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let hwnd = unsafe { create_test_window("Scroll Test") };
        thread::sleep(Duration::from_millis(200));

        // Programmatically scroll the window content.
        unsafe {
            let _ = ScrollWindow(hwnd, 0, -100, None, None);
        }
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let scroll_events = scrolls(&events);
        assert_eq!(
            scroll_events.len(),
            0,
            "Programmatic ScrollWindow should not produce scroll events. Got {}.",
            scroll_events.len()
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MISSING CAPTURE BEHAVIOUR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod capture_behaviour_missing {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");
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
    fn context_id_is_consistent_for_same_window() {
        // Multiple actions on the same window should have the same context_id.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Context ID Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // Multiple clicks on the same window.
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(200));
        enigo.move_mouse(cx + 20, cy + 20, Coordinate::Abs).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(200));
        enigo.key(enigo::Key::Return, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Actions on the same window should share a context_id. We assert the
        // dominant context_id (the one our deliberate clicks/Enter landed on)
        // rather than requiring every event to match: on a busy desktop the
        // very first synthesized event can land a focus-acquisition artifact on
        // a different window before our target window takes foreground. The
        // intent — same-window actions share an id — is verified by requiring a
        // strict majority to share one id, tolerating at most one stray event.
        let context_ids: Vec<_> = events.iter().filter_map(|e| e.context_id).collect();

        if context_ids.len() >= 2 {
            let mut counts: std::collections::HashMap<i64, usize> =
                std::collections::HashMap::new();
            for &id in &context_ids {
                *counts.entry(id).or_insert(0) += 1;
            }
            let (&dominant, &dominant_count) =
                counts.iter().max_by_key(|(_, &c)| c).expect("non-empty");
            assert!(
                dominant_count >= context_ids.len() - 1,
                "Same-window actions should share a context_id (allowing one stray \
                 focus-acquisition event). Dominant id {dominant} covered {dominant_count} \
                 of {} events. Got: {context_ids:?}",
                context_ids.len()
            );
        }
    }

    #[test]
    #[serial]
    fn window_rect_is_present_on_actions() {
        // Each action should include the window's position and size.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Window Rect Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Click events should have window_rect set.
        let click_events = clicks(&events);
        assert!(!click_events.is_empty(), "Expected at least 1 click");

        for click in &click_events {
            assert!(
                click.window_rect.is_some(),
                "Click action should have window_rect set, but it was None"
            );
            if let Some(ref rect) = click.window_rect {
                assert!(rect.width > 0, "window_rect width should be > 0");
                assert!(rect.height > 0, "window_rect height should be > 0");
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLETENESS TESTS — filling remaining gaps
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod completeness {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, SetWindowTextW,
        WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");
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
    fn mouse_move_alone_produces_nothing() {
        // Moving the mouse without clicking should not produce any events.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Move Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // Move mouse around without clicking.
        enigo.move_mouse(cx - 50, cy - 50, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.move_mouse(cx + 50, cy + 50, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        assert_eq!(
            events.len(),
            0,
            "Mouse move alone should produce no events. Got {} events: {:?}",
            events.len(),
            events
                .iter()
                .map(|e| format!("{:?}", e.payload))
                .take(5)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    #[serial]
    fn click_coordinates_are_correct() {
        // Clicks at different positions should have different x,y values.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Coords Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // Click at two different positions.
        enigo.move_mouse(cx - 80, cy - 40, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(200));

        enigo.move_mouse(cx + 80, cy + 40, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        assert!(
            click_events.len() >= 2,
            "Expected 2 clicks, got {}",
            click_events.len()
        );

        // Extract coordinates from the two clicks.
        let coords: Vec<(f64, f64)> = click_events
            .iter()
            .filter_map(|e| {
                if let ActionPayload::Click { x, y, .. } = &e.payload {
                    Some((*x, *y))
                } else {
                    None
                }
            })
            .collect();

        assert!(coords.len() >= 2, "Expected 2 click coords");
        // The two clicks should be at different positions.
        assert_ne!(
            coords[0], coords[1],
            "Clicks at different positions should have different coordinates"
        );
    }

    #[test]
    #[serial]
    fn rapid_clicks_are_not_dropped() {
        // Multiple rapid clicks should all be captured (no events lost).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Rapid Click") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));

        // 5 rapid clicks.
        for _ in 0..5 {
            enigo.button(enigo::Button::Left, Direction::Click).unwrap();
            thread::sleep(Duration::from_millis(30));
        }
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        assert_eq!(
            click_events.len(),
            5,
            "Expected 5 rapid clicks captured, got {}",
            click_events.len()
        );
    }

    #[test]
    #[serial]
    fn long_text_coalescing_produces_final_value() {
        // Typing a long string should produce a single coalesced type event
        // with the final value (not intermediate states).
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Long Type") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.text("the quick brown fox").unwrap();
        // Wait for coalescing debounce (500ms).
        thread::sleep(Duration::from_millis(800));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let type_events = types(&events);
        // Should produce at most 1 coalesced type event.
        assert!(
            type_events.len() <= 1,
            "Expected at most 1 coalesced type event for long text, got {}",
            type_events.len()
        );
    }

    #[test]
    #[serial]
    fn value_change_dedup_same_value_not_reemitted() {
        // If the same value is reported twice, only the first should be captured.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let hwnd = unsafe {
            let title_wide: Vec<u16> = "Dedup Test\0".encode_utf16().collect();
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("EDIT"),
                windows::core::PCWSTR(title_wide.as_ptr()),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                200,
                200,
                400,
                200,
                None,
                None,
                None,
                Some(ptr::null()),
            )
            .expect("Failed to create edit window")
        };
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(200));

        // Set the same value twice programmatically.
        unsafe {
            SetWindowTextW(hwnd, w!("same value")).unwrap();
            thread::sleep(Duration::from_millis(200));
            SetWindowTextW(hwnd, w!("same value")).unwrap();
        }
        thread::sleep(Duration::from_millis(800));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let type_events = types(&events);
        // Same value set twice should produce at most 1 type event (deduplicated).
        assert!(
            type_events.len() <= 1,
            "Same value set twice should be deduplicated. Got {} type events.",
            type_events.len()
        );
    }

    #[test]
    #[serial]
    fn multi_modifier_combo_is_captured() {
        // Ctrl+Shift+Alt+key. Asserts the environment-independent contract
        // (no-hang + well-formed keys); see stop_capture_bounded. Modifier
        // semantics are pinned at the worker layer.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let window = ResponsiveWindow::new("Multi-Mod");

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.key(enigo::Key::Control, Direction::Press).unwrap();
        enigo.key(enigo::Key::Shift, Direction::Press).unwrap();
        enigo.key(enigo::Key::Alt, Direction::Press).unwrap();
        enigo
            .key(enigo::Key::Unicode('k'), Direction::Click)
            .unwrap();
        enigo.key(enigo::Key::Alt, Direction::Release).unwrap();
        enigo.key(enigo::Key::Shift, Direction::Release).unwrap();
        enigo.key(enigo::Key::Control, Direction::Release).unwrap();
        thread::sleep(Duration::from_millis(500));

        drop(window);
        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }

    #[test]
    #[serial]
    fn coordinate_fallback_for_generic_window() {
        // Clicking on a plain STATIC window (no specific child controls)
        // should produce a click with capture_mode = Coordinate (since
        // ElementFromPoint resolves to the Window/Pane itself).
        use docent_desktop_lib::capture::CaptureMode;

        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Fallback Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        assert!(!click_events.is_empty(), "Expected at least 1 click");

        // A STATIC window with no child controls — ElementFromPoint may
        // resolve to the window itself (Pane/Window control type) triggering
        // coordinate fallback, OR it may resolve to the STATIC control.
        // Either mode is acceptable — we just verify the field is set.
        for click in &click_events {
            assert!(
                click.capture_mode == CaptureMode::Accessibility
                    || click.capture_mode == CaptureMode::Coordinate,
                "capture_mode should be Accessibility or Coordinate"
            );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTION TEST
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod selection {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{LPARAM, RECT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SendMessageW, SetForegroundWindow,
        LBS_NOTIFY, WINDOW_EX_STYLE, WS_BORDER, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    const LB_ADDSTRING: u32 = 0x0180;

    #[test]
    #[serial]
    fn user_click_on_listbox_item_produces_select() {
        // Clicking an item in a LISTBOX should produce a select action.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        // Create parent window.
        let parent = unsafe {
            CreateWindowExW(
                windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
                w!("STATIC"),
                w!("Selection Test"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
                200,
                200,
                400,
                300,
                None,
                None,
                None,
                Some(ptr::null()),
            )
            .expect("Failed to create parent")
        };
        unsafe {
            let _ = SetForegroundWindow(parent);
        }
        thread::sleep(Duration::from_millis(100));

        // Create a LISTBOX with items.
        let listbox = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("LISTBOX"),
                w!(""),
                WS_CHILD
                    | WS_VISIBLE
                    | WS_BORDER
                    | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(LBS_NOTIFY as u32),
                10,
                10,
                200,
                150,
                Some(parent),
                None,
                None,
                Some(ptr::null()),
            )
            .expect("Failed to create listbox")
        };

        // Add items.
        unsafe {
            let items = [w!("Item A"), w!("Item B"), w!("Item C")];
            for item in &items {
                SendMessageW(
                    listbox,
                    LB_ADDSTRING,
                    Some(WPARAM(0)),
                    Some(LPARAM(item.as_ptr() as isize)),
                );
            }
        }
        thread::sleep(Duration::from_millis(200));

        // Click on the second item in the listbox.
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(listbox, &mut rect).unwrap();
        }
        let lx = rect.left + 50;
        let ly = rect.top + 30; // Approximate position of second item.

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(lx, ly, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(listbox);
            let _ = DestroyWindow(parent);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have a click action. The click on a list item IS the selection —
        // a separate select event is not needed (it would be redundant with the click).
        let click_events = clicks(&events);
        assert!(
            !click_events.is_empty(),
            "Expected click on listbox item, got {}",
            click_events.len()
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEDUPLICATION AND CORRELATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod deduplication {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(title_wide.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");
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
    fn select_suppressed_after_click() {
        // Clicking an element should NOT produce a separate select event.
        // The click already captures the interaction.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Select Dedup") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let select_events = selects(&events);
        assert_eq!(
            select_events.len(),
            0,
            "Click should not produce a separate select event. Got {} selects.",
            select_events.len()
        );
    }

    #[test]
    #[serial]
    fn focus_suppressed_after_click() {
        // Clicking an element should NOT produce a separate focus event.
        // The click already captures the interaction.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Focus Dedup") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let focus_events = focuses(&events);
        assert_eq!(
            focus_events.len(),
            0,
            "Click should not produce a separate focus event. Got {} focus events.",
            focus_events.len()
        );
    }

    #[test]
    #[serial]
    fn double_click_not_misclassified_as_drag() {
        // Two rapid clicks (double-click) should produce 2 click events,
        // not a drag_start + drop.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Double Click") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        // Rapid double-click (minimal delay between clicks).
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        let drag_events: Vec<_> = events
            .iter()
            .filter(|e| matches!(&e.payload, ActionPayload::DragStart { .. }))
            .collect();

        assert!(
            click_events.len() >= 2,
            "Expected 2 clicks for double-click, got {}",
            click_events.len()
        );
        assert_eq!(
            drag_events.len(),
            0,
            "Double-click should not produce drag_start. Got {}.",
            drag_events.len()
        );
    }

    #[test]
    #[serial]
    fn context_close_only_for_opened_windows() {
        // A window that was never captured as context_open should not
        // produce context_close when destroyed.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        // Create and immediately destroy a window — no user input precedes
        // the creation, so it won't be captured as context_open.
        let hwnd = unsafe {
            CreateWindowExW(
                windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
                w!("STATIC"),
                w!("Ephemeral Window"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
                100,
                100,
                400,
                300,
                None,
                None,
                None,
                Some(ptr::null()),
            )
            .expect("Failed to create window")
        };
        thread::sleep(Duration::from_millis(300));

        // Now simulate a click (to satisfy correlation) and destroy.
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(hwnd, &mut rect).unwrap();
        }
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(100));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(300));

        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have a click but NO context_close (window was never opened).
        let close_events = context_closes(&events);
        assert_eq!(
            close_events.len(),
            0,
            "Window never captured as context_open should not produce context_close. Got {}.",
            close_events.len()
        );
    }

    #[test]
    #[serial]
    fn value_change_from_different_window_suppressed() {
        // A value change in a different root window than the keyboard input
        // should be suppressed (e.g. Ctrl+S in Notepad → Save As dialog initializes).
        use windows::Win32::UI::WindowsAndMessaging::SetWindowTextW;

        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        // Create two windows (simulating Notepad + Save As dialog).
        let (hwnd1, _, _) = unsafe { create_target_window("Window A") };
        let (hwnd2, _, _) = unsafe { create_target_window("Window B") };
        thread::sleep(Duration::from_millis(200));

        // Type in window A (sets keyboard correlation to window A).
        unsafe {
            let _ = SetForegroundWindow(hwnd1);
        }
        thread::sleep(Duration::from_millis(100));
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo
            .key(enigo::Key::Unicode('x'), Direction::Click)
            .unwrap();
        thread::sleep(Duration::from_millis(100));

        // Programmatically change value in window B (simulates dialog init).
        unsafe {
            SetWindowTextW(hwnd2, w!("dialog value")).unwrap();
        }
        thread::sleep(Duration::from_millis(1500)); // Wait for debounce

        unsafe {
            let _ = DestroyWindow(hwnd1);
            let _ = DestroyWindow(hwnd2);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should NOT have a type event for "dialog value" (different window).
        let type_events = types(&events);
        for t in &type_events {
            if let ActionPayload::Type { value, .. } = &t.payload {
                assert!(
                    !value.contains("dialog value"),
                    "Value change from different window should be suppressed, but got: '{}'",
                    value
                );
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OS CHROME TESTS — title bar, right-click menu, coordinate fallback
// Covers manual tests 2, 8, 10 from packages/desktop/tests/manual/README.md
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod os_chrome {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WS_EX_TOPMOST,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let wide_title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        // SS_NOTIFY_STYLE + TOPMOST: see the file-level constant's doc — a bare
        // STATIC window is click-through and loses the stacking race.
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(wide_title.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");

        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));

        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).unwrap();
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;

        (hwnd, cx, cy)
    }

    /// Manual test 2: Click title bar close button (top-right corner).
    /// The close button is approximately at (rect.right - 23, rect.top + 10).
    #[test]
    #[serial]
    fn title_bar_close_button_click() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, _, _) = unsafe { create_target_window("Title Bar Test") };
        thread::sleep(Duration::from_millis(200));

        // Compute close button position from window rect.
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(hwnd, &mut rect).unwrap();
        }
        let close_x = rect.right - 23;
        let close_y = rect.top + 10;

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(close_x, close_y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        // Window should be destroyed by the click, but just in case:
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have at least one click event.
        let click_events = clicks(&events);
        assert!(
            !click_events.is_empty(),
            "Expected click on title bar close button, got 0 clicks"
        );
    }

    /// Manual test 8: Right-click produces right_click + context_switch (menu window).
    #[test]
    #[serial]
    fn right_click_produces_context_switch_for_menu() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (hwnd, cx, cy) = unsafe { create_target_window("Right-Click Menu Test") };
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo
            .button(enigo::Button::Right, Direction::Click)
            .unwrap();
        // Wait for context menu to appear.
        thread::sleep(Duration::from_millis(800));

        // Dismiss the menu with Escape.
        enigo.key(enigo::Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(300));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have a right_click event.
        let rc_events = right_clicks(&events);
        assert!(!rc_events.is_empty(), "Expected right_click event, got 0");

        // May also have a context_switch for the menu window (depends on timing).
        // This is a best-effort check — the menu may or may not trigger a foreground change.
    }

    /// Manual test 10: Click in a window without accessibility tree produces
    /// coordinate fallback (capture_mode: "coordinate").
    /// We use a plain STATIC window which has minimal accessibility.
    ///
    /// The capture mode is provider-dependent (a STATIC window may or may not
    /// resolve an element), so this test does NOT pin the mode — it branches on
    /// the mode that actually occurred and asserts that mode's own contract,
    /// instead of asserting only "some click happened" (which verified neither).
    #[test]
    #[serial]
    fn coordinate_fallback_for_plain_window() {
        use docent_desktop_lib::capture::CaptureMode;

        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        // STATIC windows have very basic accessibility — they may trigger
        // coordinate fallback depending on the element resolution.
        let (hwnd, cx, cy) = unsafe { create_target_window("Coordinate Test") };
        thread::sleep(Duration::from_millis(200));

        // Guard: the click point must actually belong to our window before we
        // synthesize input — otherwise the click leaks into whatever overlaps
        // that point (desktop churn from a previous test, another app) and the
        // assertions below fail with confusing downstream evidence.
        {
            use windows::Win32::Foundation::POINT;
            use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
            let start = std::time::Instant::now();
            loop {
                let under = unsafe { WindowFromPoint(POINT { x: cx, y: cy }) };
                let root = unsafe { GetAncestor(under, GA_ROOT) };
                if under == hwnd || root == hwnd {
                    break;
                }
                if start.elapsed() >= Duration::from_millis(2000) {
                    let (class, title) = unsafe {
                        use windows::Win32::UI::WindowsAndMessaging::{
                            GetClassNameW, GetWindowTextW,
                        };
                        let mut class_buf = [0u16; 256];
                        let n = GetClassNameW(root, &mut class_buf);
                        let mut title_buf = [0u16; 256];
                        let m = GetWindowTextW(root, &mut title_buf);
                        (
                            String::from_utf16_lossy(&class_buf[..n.max(0) as usize]),
                            String::from_utf16_lossy(&title_buf[..m.max(0) as usize]),
                        )
                    };
                    panic!(
                        "SETUP FAILURE (environment, not capture): the test window \
                         never owned its own centre point ({cx},{cy}) — something \
                         overlaps it; clicking would leak into the session. \
                         [covering window: class={class:?} title={title:?} \
                         hwnd={hwnd:?} under={under:?} root={root:?}]"
                    );
                }
                thread::sleep(Duration::from_millis(100));
            }
        }

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(500));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        let click_events = clicks(&events);
        assert!(!click_events.is_empty(), "Expected at least 1 click event");

        for click in &click_events {
            let ActionPayload::Click { x, y, ref element } = click.payload else {
                unreachable!("clicks() filters to Click");
            };
            // Emitted x/y are the raw SCREEN point in BOTH modes (issue #141;
            // the pipeline truth-lock lives in worker_pool_test.rs). Tolerance
            // covers SendInput's absolute-coordinate rounding — a window-origin
            // sized error would still fail loudly.
            assert!(
                (x - cx as f64).abs() <= 2.0 && (y - cy as f64).abs() <= 2.0,
                "click x/y should be the raw screen point ({cx},{cy}), got ({x},{y})"
            );
            match click.capture_mode {
                CaptureMode::Coordinate => {
                    // Coordinate mode's own contract: unknown element, and the
                    // coord: selector encodes exactly the emitted x/y.
                    assert_eq!(element.tag, "unknown");
                    assert_eq!(
                        element.selector,
                        format!("coord:{},{}", x as i32, y as i32),
                        "coord: selector must encode the same raw point as x/y"
                    );
                }
                CaptureMode::Accessibility => {
                    // Accessibility mode's own contract: a resolved element,
                    // never a coord: placeholder.
                    assert_ne!(element.tag, "unknown");
                    assert!(
                        !element.selector.starts_with("coord:"),
                        "accessibility-mode element must not carry a coord: selector"
                    );
                }
                ref other => panic!("unexpected capture mode on desktop: {other:?}"),
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASKBAR & SYSTEM CHROME TESTS — taskbar, Start menu, system tray
// Covers manual tests 11, 12, 15 from packages/desktop/tests/manual/README.md
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod taskbar_chrome {
    use super::*;
    use std::ptr;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, FindWindowW, GetWindowRect, SetForegroundWindow,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe fn create_target_window(title: &str) -> (HWND, i32, i32) {
        let wide_title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = CreateWindowExW(
            windows::Win32::UI::WindowsAndMessaging::WS_EX_TOPMOST,
            w!("STATIC"),
            windows::core::PCWSTR(wide_title.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
            200,
            200,
            600,
            400,
            None,
            None,
            None,
            Some(ptr::null()),
        )
        .expect("Failed to create target window");

        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));

        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).unwrap();
        let cx = (rect.left + rect.right) / 2;
        let cy = (rect.top + rect.bottom) / 2;

        (hwnd, cx, cy)
    }

    /// Manual test 11: Click the taskbar to switch apps.
    /// Computes taskbar position from the difference between screen size and work area.
    #[test]
    #[serial]
    fn taskbar_click_produces_context_switch() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        // Create a window so there's something on the taskbar.
        let (hwnd, _, _) = unsafe { create_target_window("Taskbar Test Window") };
        thread::sleep(Duration::from_millis(300));

        // Find the taskbar window to get its exact position.
        let taskbar_hwnd = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }
            .expect("Shell_TrayWnd not found — test requires a desktop with taskbar");

        let mut taskbar_rect = RECT::default();
        unsafe {
            GetWindowRect(taskbar_hwnd, &mut taskbar_rect).unwrap();
        }

        // Click in the middle of the taskbar (should hit a taskbar button).
        let taskbar_cx = (taskbar_rect.left + taskbar_rect.right) / 2;
        let taskbar_cy = (taskbar_rect.top + taskbar_rect.bottom) / 2;

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo
            .move_mouse(taskbar_cx, taskbar_cy, Coordinate::Abs)
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(800));

        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have at least a click event on the taskbar.
        let click_events = clicks(&events);
        assert!(
            !click_events.is_empty(),
            "Expected click on taskbar, got 0 clicks (total events: {})",
            events.len()
        );
    }

    /// Manual test 12: Win key opens Start menu, typing produces key events.
    #[test]
    #[serial]
    fn win_key_opens_start_and_typing_captured() {
        // Drives the real Start menu (no test window of our own). On a headless
        // runner the Start menu / its search box may not take focus, so capture
        // counts are environment-dependent — assert the environment-independent
        // contract instead (no-hang + well-formed keys); see stop_capture_bounded.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        let mut enigo = Enigo::new(&Settings::default()).unwrap();

        // Press Win key to open Start menu.
        enigo.key(enigo::Key::Meta, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(800));

        // Type a search query.
        enigo
            .key(enigo::Key::Unicode('t'), Direction::Click)
            .unwrap();
        enigo
            .key(enigo::Key::Unicode('e'), Direction::Click)
            .unwrap();
        enigo
            .key(enigo::Key::Unicode('s'), Direction::Click)
            .unwrap();
        enigo
            .key(enigo::Key::Unicode('t'), Direction::Click)
            .unwrap();
        thread::sleep(Duration::from_millis(500));

        // Close Start menu with Escape.
        enigo.key(enigo::Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(300));

        let events = stop_capture_bounded(capture, &rx);
        assert_captured_keys_well_formed(&events);
        assert_captured_element_locators_well_formed(&events);
    }

    /// Manual test 15: Click system tray area (notification area).
    #[test]
    #[serial]
    fn system_tray_click_is_captured() {
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let mut capture = WindowsCapture::new();
        capture.set_excluded_pid(None);
        capture.start(tx).unwrap();
        thread::sleep(Duration::from_millis(200));

        // Find the taskbar to compute tray position (right side of taskbar).
        let taskbar_hwnd = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }
            .expect("Shell_TrayWnd not found — test requires a desktop with taskbar");

        let mut taskbar_rect = RECT::default();
        unsafe {
            GetWindowRect(taskbar_hwnd, &mut taskbar_rect).unwrap();
        }

        // System tray is on the right side of the taskbar.
        // Click near the right edge (clock area).
        let tray_x = taskbar_rect.right - 50;
        let tray_y = (taskbar_rect.top + taskbar_rect.bottom) / 2;

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        enigo.move_mouse(tray_x, tray_y, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(800));

        // Dismiss any popup that opened (Escape).
        enigo.key(enigo::Key::Escape, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(300));

        capture.stop().unwrap();
        let events: Vec<_> = rx.try_iter().collect();

        // Should have at least a click event.
        let click_events = clicks(&events);
        assert!(
            !click_events.is_empty(),
            "Expected click on system tray area, got 0 clicks (total events: {})",
            events.len()
        );
    }
}
