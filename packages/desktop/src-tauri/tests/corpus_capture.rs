//! Scripted-truth capture-corpus producer (desktop leg; doctrine in
//! corpus/README.md at the repo root).
//!
//! Each test is one corpus session: it creates a controlled window that is
//! DELIBERATELY NOT raised to the foreground (a programmatic raise succeeds
//! locally but is denied on the headless runner, which would make the stream
//! environment-dependent — instead the session's FIRST CLICK activates the
//! window in every environment, so the resulting context_switch is a
//! deterministic part of each session's truth), drives real OS input via
//! Enigo, and serializes the captured ActionEvents — with the same serde
//! shape Tauri's `emit` uses — to
//! `corpus/out/desktop-windows-events/<session>.events.json`. The Node
//! assembler (`scripts/corpus-assemble-desktop.js`) replays the dump through
//! the real frontend pipeline into a `.docent.json` envelope, which
//! `scripts/corpus-compare.js` diffs against the session's committed truth.
//!
//! Window OWNERSHIP is proven by the truth diff itself: the captured element
//! identity (this window's title/class/selector) would differ if input had
//! landed anywhere else, and the corpus baseline would go red. Pure-mouse
//! input lands by position at the hook level and needs no focus; keyboard-
//! driven tranche-2 sessions DO need real focus and must establish it with a
//! real click first (the user_click_switches_window precedent), reshaped or
//! dropped per the count-determinism hedge if CI cannot sustain it. Tests
//! here only assert the environment contract (bounded stop) and that the
//! dump was written.
//!
//! Tranche 1 (pure-mouse classes the integration suite proves CI-stable):
//! d-click, d-double-click. Remaining catalogue (d-coordinate — needs the
//! guarded plain-window pattern from os_chrome::coordinate_fallback_for_
//! plain_window, because an SS_NOTIFY STATIC is UIA-resolvable and lands
//! accessibility mode — plus d-type-edit, d-context-switch, d-selection-gate,
//! d-redaction, d-scroll-*) follows the same pattern; see the corpus plan's
//! desktop-leg section.
//!
//! `use enigo` auto-classifies this file as an integration test in CI
//! (windows-latest, --test-threads=1); #[serial] guards the shared input layer.

#![cfg(target_os = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use enigo::{Coordinate, Direction, Enigo, Mouse, Settings};
use serial_test::serial;

use docent_desktop_lib::capture::windows::WindowsCapture;
use docent_desktop_lib::capture::{ActionEvent, CaptureLayer};

use windows::core::w;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, GetWindowRect, TranslateMessage,
    MSG, WINDOW_STYLE, WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

/// SS_NOTIFY: a bare STATIC answers WM_NCHITTEST with HTTRANSPARENT
/// (click-through); this style makes it hit-testable. Same rationale as
/// capture_integration.rs's constant.
const SS_NOTIFY_STYLE: WINDOW_STYLE = WINDOW_STYLE(0x0000_0100);

/// The controlled session window, hosted on its OWN thread running a
/// continuous `GetMessageW` pump (the ResponsiveWindow discipline from
/// capture_integration.rs): the pump lets click-driven activation complete
/// and keeps the window responsive to the capture workers' synchronous
/// accessibility queries. Never raised programmatically — the session's first
/// click activates it, deterministically in every environment (see the file
/// header). Fixed position/size: the corpus normalizes coordinates to
/// placeholders, but fixed geometry keeps element resolution deterministic.
struct SessionWindow {
    thread_id: u32,
    handle: Option<std::thread::JoinHandle<()>>,
    hwnd: HWND,
    cx: i32,
    cy: i32,
}

impl SessionWindow {
    fn new(title: &'static str, x: i32, y: i32) -> Self {
        use std::sync::mpsc as smpsc;
        use windows::Win32::System::Threading::GetCurrentThreadId;

        let (tx, rx) = smpsc::channel::<(u32, isize, i32, i32)>();
        let handle = thread::spawn(move || unsafe {
            let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST,
                w!("STATIC"),
                windows::core::PCWSTR(title_wide.as_ptr()),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE | SS_NOTIFY_STYLE,
                x,
                y,
                600,
                400,
                None,
                None,
                None,
                Some(std::ptr::null()),
            )
            .expect("Failed to create session window");
            let mut rect = RECT::default();
            GetWindowRect(hwnd, &mut rect).unwrap();
            tx.send((
                GetCurrentThreadId(),
                hwnd.0 as isize,
                (rect.left + rect.right) / 2,
                (rect.top + rect.bottom) / 2,
            ))
            .expect("failed to hand back window info");

            // Continuous blocking pump; exits when Drop posts WM_QUIT.
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(hwnd);
        });

        let (thread_id, hwnd_raw, cx, cy) = rx.recv().expect("window thread failed to start");
        thread::sleep(Duration::from_millis(100));
        Self {
            thread_id,
            handle: Some(handle),
            hwnd: HWND(hwnd_raw as *mut core::ffi::c_void),
            cx,
            cy,
        }
    }
}

impl Drop for SessionWindow {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[derive(serde::Serialize)]
struct Dump<'a> {
    session: &'a str,
    max_sequence_number: u64,
    events: &'a [ActionEvent],
}

/// Serialize the session's events to the corpus event-dump location
/// (repo root = CARGO_MANIFEST_DIR/../../..).
fn write_dump(session: &str, events: &[ActionEvent]) {
    let max_sequence_number = events
        .iter()
        .filter_map(|e| e.sequence_id)
        .max()
        .unwrap_or(0);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../corpus/out/desktop-windows-events");
    fs::create_dir_all(&dir).expect("create events dir");
    let dump = Dump {
        session,
        max_sequence_number,
        events,
    };
    fs::write(
        dir.join(format!("{session}.events.json")),
        serde_json::to_string_pretty(&dump).expect("serialize dump"),
    )
    .expect("write dump");
}

/// Run one mouse-driven session: start capture, create the (unraised) session
/// and primer windows, run the scripted input against their centres, stop
/// bounded, write the dump.
fn run_mouse_session(
    session: &str,
    script: impl FnOnce(&mut Enigo, &SessionWindow, &SessionWindow),
) {
    let (tx, rx) = mpsc::channel::<ActionEvent>();
    let mut capture = WindowsCapture::new();
    capture.set_excluded_pid(None);
    capture.start(tx).expect("Failed to start capture");
    thread::sleep(Duration::from_millis(200));

    let win = SessionWindow::new("Docent Corpus Session", 200, 200);
    // The PRIMER equalizes the pre-click foreground state across environments:
    // created LAST, it holds the foreground locally (creation from a
    // foreground-privileged process auto-activates — a programmatic, correctly
    // filtered activation), while on a headless runner neither window
    // activates. Either way the session window is NOT foreground when the
    // first scripted click lands, so that click's activation context_switch
    // is a deterministic part of every session's truth.
    let primer = SessionWindow::new("Docent Corpus Primer", 900, 620);
    thread::sleep(Duration::from_millis(200));

    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    script(&mut enigo, &win, &primer);
    drop(primer);
    // Let worker describes and coalescing settle before stopping.
    thread::sleep(Duration::from_millis(800));

    drop(win);
    let start = Instant::now();
    capture.stop().unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "capture.stop() must not hang (took {:?})",
        start.elapsed()
    );
    let events: Vec<ActionEvent> = rx.try_iter().collect();
    write_dump(session, &events);
}

/// One deliberate left click at the window centre.
#[test]
#[serial]
fn d_click() {
    run_mouse_session("d-click", |enigo, win, _primer| {
        let (cx, cy) = (win.cx, win.cy);
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    });
}

/// Two rapid clicks — the format has no double_click type, so the truth is
/// two click actions (the double-click identity gap is format-inexpressible
/// and lives with the lint/backlog, not the corpus).
#[test]
#[serial]
fn d_double_click() {
    run_mouse_session("d-double-click", |enigo, win, _primer| {
        let (cx, cy) = (win.cx, win.cy);
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(80));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    });
}

/// User switches between two windows by clicking each in turn: activation
/// context_switch + click on the session window, then the same pair on the
/// primer — the context-lifecycle class, driven entirely by real clicks.
#[test]
#[serial]
fn d_context_switch() {
    run_mouse_session("d-context-switch", |enigo, win, primer| {
        let ((cx, cy), (px, py)) = ((win.cx, win.cy), (primer.cx, primer.cy));
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(400));
        enigo.move_mouse(px, py, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    });
}

/// Deterministic application-side selection signal (the completeness-module
/// helper): a synthetic EVENT_OBJECT_SELECTION on the window, which capture
/// records only when correlated with recent real input in the same root.
unsafe fn fire_selection(hwnd: HWND) {
    use windows::Win32::UI::Accessibility::NotifyWinEvent;
    use windows::Win32::UI::WindowsAndMessaging::{
        CHILDID_SELF, EVENT_OBJECT_SELECTION, OBJID_CLIENT,
    };
    NotifyWinEvent(
        EVENT_OBJECT_SELECTION,
        hwnd,
        OBJID_CLIENT.0,
        CHILDID_SELF as i32,
    );
}

/// The selection-gate class: a real click activates the session window, and
/// an application selection fired in the SAME root within the correlation
/// window is captured as a select action. (The uncorrelated/cross-root
/// negatives are pinned by the completeness module in capture_integration.rs;
/// the corpus pins the positive stream.)
#[test]
#[serial]
fn d_selection_gate() {
    run_mouse_session("d-selection-gate", |enigo, win, _primer| {
        enigo.move_mouse(win.cx, win.cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        // Past the 200ms click-redundancy suppression, still input-correlated.
        thread::sleep(Duration::from_millis(350));
        unsafe { fire_selection(win.hwnd) };
    });
}
