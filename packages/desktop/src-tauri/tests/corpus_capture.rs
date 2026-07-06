//! Scripted-truth capture-corpus producer (desktop leg; doctrine in
//! corpus/README.md at the repo root).
//!
//! Each test is one corpus session: it creates a controlled window, OWNS the
//! foreground (AttachThreadInput; panics "SETUP FAILURE" if the environment
//! refuses — a session whose events would be filtered must never run), drives
//! real OS input via Enigo, and serializes the captured ActionEvents — with
//! the same serde shape Tauri's `emit` uses — to
//! `corpus/out/desktop-windows-events/<session>.events.json`. The Node
//! assembler (`scripts/corpus-assemble-desktop.js`) replays the dump through
//! the real frontend pipeline into a `.docent.json` envelope, which
//! `scripts/corpus-compare.js` diffs against the session's committed truth.
//!
//! Unlike `capture_integration.rs` (whose keyboard/foreground tests
//! deliberately avoid counted assertions), every corpus session runs strictly
//! foreground-owned, so its event stream is assertable — the corpus's truth
//! diff IS the assertion. Tests here only assert the environment contract
//! (foreground ownership, bounded stop) and that the dump was written.
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
    CreateWindowExW, DestroyWindow, GetWindowRect, SetForegroundWindow, WINDOW_STYLE,
    WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

/// SS_NOTIFY: a bare STATIC answers WM_NCHITTEST with HTTRANSPARENT
/// (click-through); this style makes it hit-testable. Same rationale as
/// capture_integration.rs's constant.
const SS_NOTIFY_STYLE: WINDOW_STYLE = WINDOW_STYLE(0x0000_0100);

/// Create the controlled session window at a FIXED position/size (the corpus
/// normalizes coordinates to placeholders, but fixed geometry keeps the
/// element-resolution path itself deterministic).
unsafe fn create_session_window(title: windows::core::PCWSTR) -> (HWND, i32, i32) {
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST,
        w!("STATIC"),
        title,
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
    .expect("Failed to create session window");
    let _ = SetForegroundWindow(hwnd);
    thread::sleep(Duration::from_millis(100));

    let mut rect = RECT::default();
    GetWindowRect(hwnd, &mut rect).unwrap();
    (
        (hwnd),
        (rect.left + rect.right) / 2,
        (rect.top + rect.bottom) / 2,
    )
}

/// Foreground ownership guard (the completeness-module discipline): steal the
/// foreground via AttachThreadInput and REFUSE to run the session if the
/// window never becomes foreground — a corpus session whose input would be
/// filtered must fail as environment, never as a phantom capture diff.
fn assert_took_foreground(hwnd: HWND) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId,
    };
    unsafe {
        let our_thread = GetCurrentThreadId();
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let attached = fg_thread != 0 && fg_thread != our_thread;
        if attached {
            let _ = AttachThreadInput(our_thread, fg_thread, true);
        }
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(our_thread, fg_thread, false);
        }
    }
    let start = Instant::now();
    loop {
        if unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() } == hwnd {
            return;
        }
        if start.elapsed() > Duration::from_millis(2000) {
            panic!(
                "SETUP FAILURE (environment, not capture): the session window never \
                 became the foreground window — refusing to produce a corpus dump \
                 whose events the pipeline would filter"
            );
        }
        thread::sleep(Duration::from_millis(50));
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

/// Run one mouse-driven session: start capture, own the foreground, run the
/// scripted input against the window centre, stop bounded, write the dump.
fn run_mouse_session(session: &str, script: impl FnOnce(&mut Enigo, i32, i32)) {
    let (tx, rx) = mpsc::channel::<ActionEvent>();
    let mut capture = WindowsCapture::new();
    capture.set_excluded_pid(None);
    capture.start(tx).expect("Failed to start capture");
    thread::sleep(Duration::from_millis(200));

    let (hwnd, cx, cy) = unsafe { create_session_window(w!("Docent Corpus Session")) };
    assert_took_foreground(hwnd);
    thread::sleep(Duration::from_millis(200));

    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    script(&mut enigo, cx, cy);
    // Let worker describes and coalescing settle before stopping.
    thread::sleep(Duration::from_millis(800));

    unsafe {
        let _ = DestroyWindow(hwnd);
    }
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
    run_mouse_session("d-click", |enigo, cx, cy| {
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
    run_mouse_session("d-double-click", |enigo, cx, cy| {
        enigo.move_mouse(cx, cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(80));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    });
}
