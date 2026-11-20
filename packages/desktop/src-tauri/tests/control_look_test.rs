// How the Windows backend looks at a control by its window handle.
//
// The windows are real windows of this process, asked through UI Automation
// the way a worker asks a recorded program. No input is sent, so nothing here
// depends on which window is in front.
//
// The tests run one at a time (`#[serial]`): with several of them opening
// windows and asking at once, UI Automation now and then answers E_FAIL for a
// window that was just created, and the backend reads that as a window it
// could not look at.
#![cfg(windows)]

use std::sync::mpsc;
use std::thread;

use docent_desktop_lib::capture::win32_bindings::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, GetCurrentThreadId, GetMessageW,
    PostThreadMessageW, SetWindowTextW, TranslateMessage, ES_PASSWORD, HWND, LPARAM, MSG, WM_QUIT,
    WPARAM, WS_BORDER, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use docent_desktop_lib::capture::windows::WindowsAccessibilityBackend;
use docent_desktop_lib::capture::worker_pool::{AccessibilityBackend, ControlLook, ControlNature};
use serial_test::serial;
use windows_core::w;

/// A window with two fields of its own, kept alive and answering on its own
/// thread until it is dropped.
struct Dialog {
    window: i64,
    field: i64,
    password: i64,
    thread_id: u32,
    thread: Option<thread::JoinHandle<()>>,
}

impl Dialog {
    fn open() -> Self {
        Self::open_with(true)
    }

    /// A window with nothing in it: its `field` and `password` are no windows.
    fn open_bare() -> Self {
        Self::open_with(false)
    }

    fn open_with(fields: bool) -> Self {
        let (tx, rx) = mpsc::channel::<(i64, i64, i64, u32)>();
        let thread = thread::spawn(move || unsafe {
            let window = CreateWindowExW(
                0,
                w!("STATIC"),
                w!("Control look"),
                (WS_OVERLAPPEDWINDOW | WS_VISIBLE) as u32,
                120,
                120,
                420,
                160,
                None,
                None,
                None,
                Some(std::ptr::null()),
            );
            assert!(!window.0.is_null(), "the window was not created");
            let child = |text, style: i32, y| {
                let field = CreateWindowExW(
                    0,
                    w!("EDIT"),
                    text,
                    (WS_CHILD | WS_VISIBLE | WS_BORDER | style) as u32,
                    10,
                    y,
                    380,
                    24,
                    Some(window),
                    None,
                    None,
                    Some(std::ptr::null()),
                );
                assert!(!field.0.is_null(), "a field was not created");
                field
            };
            let (field, password) = if fields {
                let field = child(w!("report"), 0, 10);
                let password = child(w!("hidden"), ES_PASSWORD, 44);
                (field.0 as i64, password.0 as i64)
            } else {
                (0, 0)
            };
            tx.send((window.0 as i64, field, password, GetCurrentThreadId()))
                .expect("the window's handles were not handed back");

            // A thread waiting in GetMessageW answers the messages UI
            // Automation sends its windows. It ends on the WM_QUIT of `drop`.
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(window);
        });
        let (window, field, password, thread_id) =
            rx.recv().expect("the window's thread did not start");
        Self {
            window,
            field,
            password,
            thread_id,
            thread: Some(thread),
        }
    }

    /// Close the window and wait until it is gone.
    fn close(&mut self) {
        if let Some(thread) = self.thread.take() {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT as u32, WPARAM(0), LPARAM(0));
            }
            thread.join().expect("the window's thread failed");
        }
    }
}

impl Drop for Dialog {
    fn drop(&mut self) {
        self.close();
    }
}

/// A backend set up the way a worker sets its own up.
struct Backend(WindowsAccessibilityBackend);

impl Backend {
    fn new() -> Self {
        let mut backend = WindowsAccessibilityBackend::new();
        backend.init().expect("UI Automation did not start");
        Self(backend)
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.0.cleanup();
    }
}

#[test]
#[serial]
fn a_field_is_a_control_of_its_own_and_is_described() {
    let dialog = Dialog::open();
    let backend = Backend::new();

    assert_eq!(
        backend.0.control_nature(dialog.field),
        ControlNature::Own { password: false }
    );
    let ControlLook::Own(element) = backend.0.describe_control(dialog.field) else {
        panic!("the field was not described as a control of its own");
    };
    assert_eq!(element.tag, "Edit");
    assert!(!element.selector.is_empty());
    assert_ne!(element.element_type.as_deref(), Some("password"));
}

#[test]
#[serial]
fn a_password_field_is_seen_as_one() {
    let dialog = Dialog::open();
    let backend = Backend::new();

    assert_eq!(
        backend.0.control_nature(dialog.password),
        ControlNature::Own { password: true }
    );
    let ControlLook::Own(element) = backend.0.describe_control(dialog.password) else {
        panic!("the password field was not described as a control of its own");
    };
    assert_eq!(element.element_type.as_deref(), Some("password"));
}

#[test]
#[serial]
fn a_window_that_holds_fields_is_not_a_control_of_its_own() {
    let dialog = Dialog::open();
    let backend = Backend::new();

    assert_eq!(
        backend.0.control_nature(dialog.window),
        ControlNature::Shared
    );
    assert!(matches!(
        backend.0.describe_control(dialog.window),
        ControlLook::Shared
    ));
}

/// A window with nothing in it that can take the focus is itself what a key
/// pressed in it goes to, and it is described like any element: with a
/// selector and locator candidates (docent#713). What UI Automation reports as
/// the focused element of such a window is not asked here, since that depends
/// on which window is in front.
#[test]
#[serial]
fn a_window_with_nothing_to_focus_is_described_with_locators() {
    let dialog = Dialog::open_bare();
    let backend = Backend::new();

    let ControlLook::Own(element) = backend.0.describe_control(dialog.window) else {
        panic!("the bare window was not described as a control of its own");
    };
    assert!(!element.selector.is_empty(), "got {element:?}");
    assert!(!element.locators.is_empty(), "got {element:?}");
}

#[test]
#[serial]
fn the_value_is_read_from_the_control_as_it_is_now() {
    let dialog = Dialog::open();
    let backend = Backend::new();

    assert_eq!(
        backend.0.control_value(dialog.field).as_deref(),
        Some("report")
    );
    unsafe {
        let _ = SetWindowTextW(HWND(dialog.field as *mut _), w!("report 2"));
    }
    assert_eq!(
        backend.0.control_value(dialog.field).as_deref(),
        Some("report 2")
    );
}

/// A control that has no value gives none, where an emptied field gives an
/// empty one.
#[test]
#[serial]
fn a_control_without_a_value_gives_none_and_an_emptied_field_an_empty_one() {
    let dialog = Dialog::open();
    let backend = Backend::new();

    assert_eq!(backend.0.control_value(dialog.window), None);
    unsafe {
        let _ = SetWindowTextW(HWND(dialog.field as *mut _), w!(""));
    }
    assert_eq!(backend.0.control_value(dialog.field).as_deref(), Some(""));
}

#[test]
#[serial]
fn a_handle_of_no_window_is_gone() {
    let mut dialog = Dialog::open();
    let backend = Backend::new();
    assert_ne!(backend.0.control_nature(dialog.field), ControlNature::Gone);

    dialog.close();

    assert_eq!(backend.0.control_nature(dialog.field), ControlNature::Gone);
    assert!(matches!(
        backend.0.describe_control(dialog.field),
        ControlLook::Gone
    ));
    assert_eq!(backend.0.control_value(dialog.field), None);
    assert_eq!(backend.0.control_nature(0), ControlNature::Gone);
    assert_eq!(backend.0.control_value(0), None);
}

/// The focused control is read from the window system's own state: a handle
/// or none, and never a wait on another program.
#[test]
#[serial]
fn the_focused_control_is_read_without_asking_a_program() {
    let _dialog = Dialog::open();
    let backend = Backend::new();

    let started = std::time::Instant::now();
    let _ = backend.0.focused_control();
    assert!(started.elapsed() < std::time::Duration::from_millis(100));
}
