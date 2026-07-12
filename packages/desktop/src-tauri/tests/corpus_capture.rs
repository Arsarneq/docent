//! Scripted-truth capture-corpus producer (desktop leg; doctrine in
//! docs/verification/scripted-truth-corpus.md).
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

use enigo::{Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
use serial_test::serial;

use docent_desktop_lib::capture::windows::WindowsCapture;
use docent_desktop_lib::capture::{ActionEvent, ActionPayload, CaptureLayer, ElementDescription};

use windows::core::{w, BSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, GetWindowRect,
    RegisterClassW, TranslateMessage, MSG, WINDOW_STYLE, WM_GETOBJECT, WNDCLASSW, WS_EX_TOPMOST,
    WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

// UIA imports for the conformance-vector Control-view snapshot walker (see the
// `v_vector_fixture` test at the end of this file) AND the labeled_by fixture's
// UIA OverrideProvider (see the provider section below). The walker runs on the
// test thread against the live fixture window; it reuses no crate-private capture
// helper (those are pub(crate)), so the small UIA property reads and the
// control-type-id → name table are self-contained here.
use windows::core::Interface;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED, SAFEARRAY,
};
use windows::Win32::System::Variant::{VARIANT, VARIANT_0_0, VT_BSTR, VT_UNKNOWN};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IRawElementProviderFragment, IRawElementProviderFragmentRoot,
    IRawElementProviderFragmentRoot_Impl, IRawElementProviderFragment_Impl,
    IRawElementProviderHwndOverride, IRawElementProviderHwndOverride_Impl,
    IRawElementProviderSimple, IRawElementProviderSimple_Impl, IUIAutomation, IUIAutomationElement,
    IUIAutomationTreeWalker, NavigateDirection, ProviderOptions, ProviderOptions_OverrideProvider,
    ProviderOptions_ServerSideProvider, ProviderOptions_UseComThreading,
    UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId, UIA_ControlTypePropertyId,
    UIA_LabeledByPropertyId, UIA_NamePropertyId, UIA_ValueValuePropertyId,
    UiaGetReservedNotSupportedValue, UiaHostProviderFromHwnd, UiaRect, UiaReturnRawElementProvider,
    UiaRootObjectId, UIA_PATTERN_ID, UIA_PROPERTY_ID,
};
use windows_core::{implement, Error as ComError, IUnknown, Result as ComResult};

#[derive(PartialEq, Clone, Copy)]
enum Child {
    None,
    ScrollEdit,
    TypeEdit,
    PasswordEdit,
    /// A STATIC label (control id 1001) preceding an EDIT (control id 1002),
    /// hosted in a dedicated custom-class window whose WndProc answers
    /// WM_GETOBJECT with a UIA OverrideProvider (see the provider section below).
    /// The Win32 control ids surface as UIA AutomationIds (authored content
    /// provenance), the STATIC supplies the EDIT's UIA Name, the controls carry
    /// distinct class names, and the provider MERGES a real UIA LabeledBy relation
    /// onto the native EDIT (ControlType stays Edit) — so ALL FIVE desktop
    /// strategies (automation_id / role_name / class_name / labeled_by /
    /// tree_path) are exercisable over this window. Used by the conformance-vector
    /// fixture (`v_vector_fixture`), never a manifest corpus session.
    LabeledEdit,
}

/// The authored content AutomationIds the vector fixture assigns (Win32 control
/// ids surfaced by UIA). The snapshot walker preserves the UIA Name of nodes
/// carrying one of these (authored content); every other node's Name is
/// OS-provided and normalized to a locale-stable placeholder.
const FIXTURE_AUTHORED_IDS: &[&str] = &["1001", "1002"];

// ---------------------------------------------------------------------------
// labeled_by fixture — a UIA OverrideProvider that MERGES a real LabeledBy
// relation onto the native EDIT.
//
// A raw Win32 STATIC→EDIT gives the EDIT its accessible Name but NOT a UIA
// LabeledBy *relation element*. To expose one over a controlled fixture without
// losing the EDIT's native identity, the fixture window (a dedicated custom
// class) answers WM_GETOBJECT with a fragment-root provider implementing
// IRawElementProviderHwndOverride. GetOverrideProviderForHwnd(edit) returns an
// OverrideProvider (ProviderOptions_OverrideProvider) that host-delegates to the
// native EDIT (ControlType / AutomationId / ClassName / Name flow through) and
// supplies ONLY UIA_LabeledBy = a small self-describing LabelProvider whose Name
// is the label text. UIA MERGES the override onto the native element, so a DIRECT
// read (capture's ElementFromPoint / ElementFromHandle) AND a Control-view walk
// both see ControlType=Edit + the real LabeledBy relation. Nothing is fabricated
// in the reader — UIA genuinely reports the relation, exactly as a WPF/XAML
// AutomationProperties.LabeledBy does. `#[implement]` comes from windows-core, a
// test-only dev-dependency (see Cargo.toml) that never enters the shipped build.
// ---------------------------------------------------------------------------

/// The label text the fixture's EDIT is labeled by (the visible STATIC's text).
const FIXTURE_LABEL_NAME: &str = "Amount";

fn as_hwnd(x: isize) -> HWND {
    HWND(x as *mut core::ffi::c_void)
}

/// Build a `VT_UNKNOWN` VARIANT owning `unknown` — the shape UIA expects for an
/// element-valued property (and that `get_labeled_by_name` reads). Written via a
/// raw pointer because Rust does not auto-`DerefMut` a `ManuallyDrop` union
/// field; the freshly-defaulted VARIANT's empty slot is overwritten, not dropped.
unsafe fn variant_from_unknown(unknown: IUnknown) -> VARIANT {
    let mut v = VARIANT::default();
    let slot = std::ptr::addr_of_mut!(v.Anonymous.Anonymous) as *mut VARIANT_0_0;
    (*slot).vt = VT_UNKNOWN;
    (*slot).Anonymous.punkVal = std::mem::ManuallyDrop::new(Some(unknown));
    v
}

/// The UIA "not supported" sentinel, wrapped in a VARIANT — returned for every
/// property the override does not itself supply, so those fall through to the
/// host (native) provider rather than being blanked.
unsafe fn not_supported() -> ComResult<VARIANT> {
    Ok(variant_from_unknown(UiaGetReservedNotSupportedValue()?))
}

/// A minimal self-describing UIA element (a custom provider object, NOT a bare
/// host provider — a host provider fails to marshal cross-apartment as an
/// element-valued property). It is the target of the EDIT's LabeledBy relation;
/// its Name mirrors the visible STATIC label so `get_labeled_by_name` reads it.
#[implement(IRawElementProviderSimple)]
struct LabelProvider;

impl IRawElementProviderSimple_Impl for LabelProvider_Impl {
    fn ProviderOptions(&self) -> ComResult<ProviderOptions> {
        Ok(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading)
    }
    fn GetPatternProvider(&self, _id: UIA_PATTERN_ID) -> ComResult<IUnknown> {
        Err(ComError::empty())
    }
    fn GetPropertyValue(&self, id: UIA_PROPERTY_ID) -> ComResult<VARIANT> {
        if id == UIA_NamePropertyId {
            return Ok(VARIANT::from(BSTR::from(FIXTURE_LABEL_NAME)));
        }
        if id == UIA_ControlTypePropertyId {
            return Ok(VARIANT::from(50020i32)); // UIA_TextControlTypeId
        }
        unsafe { not_supported() }
    }
    fn HostRawElementProvider(&self) -> ComResult<IRawElementProviderSimple> {
        Err(ComError::empty())
    }
}

/// The EDIT override provider: merges onto the native EDIT (host-delegated), adds
/// ONLY the LabeledBy relation.
#[implement(IRawElementProviderSimple)]
struct EditOverride {
    edit: isize,
}

impl IRawElementProviderSimple_Impl for EditOverride_Impl {
    fn ProviderOptions(&self) -> ComResult<ProviderOptions> {
        Ok(ProviderOptions_ServerSideProvider
            | ProviderOptions_OverrideProvider
            | ProviderOptions_UseComThreading)
    }
    fn GetPatternProvider(&self, _id: UIA_PATTERN_ID) -> ComResult<IUnknown> {
        Err(ComError::empty())
    }
    fn GetPropertyValue(&self, id: UIA_PROPERTY_ID) -> ComResult<VARIANT> {
        if id == UIA_LabeledByPropertyId {
            let label: IRawElementProviderSimple = LabelProvider.into();
            return Ok(unsafe { variant_from_unknown(label.cast()?) });
        }
        // ControlType / Name / AutomationId / ClassName fall through to the EDIT.
        unsafe { not_supported() }
    }
    fn HostRawElementProvider(&self) -> ComResult<IRawElementProviderSimple> {
        unsafe { UiaHostProviderFromHwnd(as_hwnd(self.edit)) }
    }
}

/// The fixture window's fragment-root provider: host-delegates its own properties
/// (so the snapshot root and OS chrome are preserved) and, via
/// IRawElementProviderHwndOverride, layers the EditOverride onto the EDIT child.
#[implement(
    IRawElementProviderSimple,
    IRawElementProviderFragment,
    IRawElementProviderFragmentRoot,
    IRawElementProviderHwndOverride
)]
struct FixtureRoot {
    parent: isize,
    edit: isize,
}

impl IRawElementProviderSimple_Impl for FixtureRoot_Impl {
    fn ProviderOptions(&self) -> ComResult<ProviderOptions> {
        Ok(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading)
    }
    fn GetPatternProvider(&self, _id: UIA_PATTERN_ID) -> ComResult<IUnknown> {
        Err(ComError::empty())
    }
    fn GetPropertyValue(&self, _id: UIA_PROPERTY_ID) -> ComResult<VARIANT> {
        unsafe { not_supported() }
    }
    fn HostRawElementProvider(&self) -> ComResult<IRawElementProviderSimple> {
        unsafe { UiaHostProviderFromHwnd(as_hwnd(self.parent)) }
    }
}

impl IRawElementProviderFragment_Impl for FixtureRoot_Impl {
    fn Navigate(&self, _dir: NavigateDirection) -> ComResult<IRawElementProviderFragment> {
        // The EDIT child is placed by the HWND hierarchy, not fragment navigation.
        Err(ComError::empty())
    }
    fn GetRuntimeId(&self) -> ComResult<*mut SAFEARRAY> {
        Ok(std::ptr::null_mut())
    }
    fn BoundingRectangle(&self) -> ComResult<UiaRect> {
        Ok(UiaRect {
            left: 0.0,
            top: 0.0,
            width: 0.0,
            height: 0.0,
        })
    }
    fn GetEmbeddedFragmentRoots(&self) -> ComResult<*mut SAFEARRAY> {
        Ok(std::ptr::null_mut())
    }
    fn SetFocus(&self) -> ComResult<()> {
        Ok(())
    }
    fn FragmentRoot(&self) -> ComResult<IRawElementProviderFragmentRoot> {
        // A fresh instance representing the same (stateless) root.
        Ok(FixtureRoot {
            parent: self.parent,
            edit: self.edit,
        }
        .into())
    }
}

impl IRawElementProviderFragmentRoot_Impl for FixtureRoot_Impl {
    fn ElementProviderFromPoint(&self, _x: f64, _y: f64) -> ComResult<IRawElementProviderFragment> {
        Err(ComError::empty())
    }
    fn GetFocus(&self) -> ComResult<IRawElementProviderFragment> {
        Err(ComError::empty())
    }
}

impl IRawElementProviderHwndOverride_Impl for FixtureRoot_Impl {
    fn GetOverrideProviderForHwnd(&self, h: HWND) -> ComResult<IRawElementProviderSimple> {
        if h.0 as isize == self.edit {
            Ok(EditOverride { edit: self.edit }.into())
        } else {
            Err(ComError::empty())
        }
    }
}

thread_local! {
    /// (parent_hwnd, edit_hwnd) for the fixture window on this pump thread, set
    /// after the children are created; read by [`fixture_wndproc`].
    static FIXTURE_HWNDS: std::cell::Cell<(isize, isize)> = const { std::cell::Cell::new((0, 0)) };
}

/// The fixture window's WndProc: answers the UIA object request with the
/// fragment-root provider, forwards everything else to DefWindowProc.
unsafe extern "system" fn fixture_wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if m == WM_GETOBJECT && l.0 == UiaRootObjectId as isize {
        let (parent, edit) = FIXTURE_HWNDS.with(|c| c.get());
        if parent != 0 && edit != 0 && h.0 as isize == parent {
            let provider: IRawElementProviderSimple = FixtureRoot { parent, edit }.into();
            return UiaReturnRawElementProvider(h, w, l, &provider);
        }
    }
    DefWindowProcW(h, m, w, l)
}

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
        Self::build2(title, x, y, Child::None, false)
    }

    fn build(title: &'static str, x: i32, y: i32, child: Child) -> Self {
        Self::build2(title, x, y, child, false)
    }

    /// plain: a custom-registered class with DefWindowProc — hit-testable
    /// client area but no accessibility content, so element resolution finds
    /// only the window itself and capture falls back to coordinate mode
    /// deterministically (an SS_NOTIFY STATIC always resolves accessibility).
    fn build2(title: &'static str, x: i32, y: i32, child: Child, plain: bool) -> Self {
        use std::sync::mpsc as smpsc;
        use windows::Win32::System::Threading::GetCurrentThreadId;

        let (tx, rx) = smpsc::channel::<(u32, isize, i32, i32)>();
        let handle = thread::spawn(move || unsafe {
            // The labeled_by fixture hosts a UIA provider on this window; give the
            // pump thread a single-threaded apartment so UIA can marshal the
            // UseComThreading provider's WM_GETOBJECT calls. Other windows carry no
            // provider and stay apartment-free.
            if child == Child::LabeledEdit {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
            let class = if child == Child::LabeledEdit {
                // Dedicated custom class whose WndProc answers WM_GETOBJECT with
                // the fixture's OverrideProvider (labeled_by coverage). Isolated to
                // this fixture — no other session's window or pump is perturbed.
                static REGISTER_FIXTURE: std::sync::Once = std::sync::Once::new();
                REGISTER_FIXTURE.call_once(|| {
                    let wc = WNDCLASSW {
                        lpfnWndProc: Some(fixture_wndproc),
                        lpszClassName: w!("DocentVectorFixture"),
                        ..Default::default()
                    };
                    let _ = RegisterClassW(&wc);
                });
                w!("DocentVectorFixture")
            } else if plain {
                unsafe extern "system" fn plain_proc(
                    h: HWND,
                    m: u32,
                    w: WPARAM,
                    l: LPARAM,
                ) -> LRESULT {
                    DefWindowProcW(h, m, w, l)
                }
                static REGISTER: std::sync::Once = std::sync::Once::new();
                REGISTER.call_once(|| {
                    let wc = WNDCLASSW {
                        lpfnWndProc: Some(plain_proc),
                        lpszClassName: w!("DocentCorpusPlain"),
                        ..Default::default()
                    };
                    let _ = RegisterClassW(&wc);
                });
                w!("DocentCorpusPlain")
            } else {
                w!("STATIC")
            };
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST,
                class,
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
            if child == Child::LabeledEdit {
                use windows::Win32::UI::WindowsAndMessaging::{
                    ES_AUTOVSCROLL, HMENU, WS_BORDER, WS_CHILD,
                };
                // A STATIC label (control id 1001) precedes the EDIT so UIA
                // derives the EDIT's Name from it (its accessible name = "Amount");
                // both Win32 control ids surface as UIA AutomationIds (authored
                // content). The custom-class WndProc's OverrideProvider then merges
                // a real LabeledBy relation (→ the label text) onto the native
                // EDIT. Positions keep the EDIT under the window centre so the
                // focus click lands on it.
                let label = CreateWindowExW(
                    Default::default(),
                    w!("STATIC"),
                    w!("Amount"),
                    WS_CHILD | WS_VISIBLE,
                    10,
                    10,
                    560,
                    24,
                    Some(hwnd),
                    Some(HMENU(1001isize as *mut core::ffi::c_void)),
                    None,
                    Some(std::ptr::null()),
                )
                .expect("Failed to create fixture label");
                let edit = CreateWindowExW(
                    Default::default(),
                    w!("EDIT"),
                    w!(""),
                    WS_CHILD | WS_VISIBLE | WS_BORDER | WINDOW_STYLE(ES_AUTOVSCROLL as u32),
                    10,
                    44,
                    560,
                    300,
                    Some(hwnd),
                    Some(HMENU(1002isize as *mut core::ffi::c_void)),
                    None,
                    Some(std::ptr::null()),
                )
                .expect("Failed to create fixture edit");
                let _ = label;
                // Publish (parent, edit) for fixture_wndproc to build the provider
                // when UIA requests the window's element.
                FIXTURE_HWNDS.with(|c| c.set((hwnd.0 as isize, edit.0 as isize)));
            } else if child != Child::None {
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowTextW, ES_AUTOVSCROLL, ES_MULTILINE, ES_PASSWORD, WS_BORDER, WS_CHILD,
                    WS_VSCROLL,
                };
                let edit = CreateWindowExW(
                    Default::default(),
                    w!("EDIT"),
                    w!(""),
                    WS_CHILD
                        | WS_VISIBLE
                        | WS_BORDER
                        | if child == Child::ScrollEdit {
                            WS_VSCROLL
                        } else {
                            Default::default()
                        }
                        | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(
                            if child == Child::ScrollEdit {
                                ES_MULTILINE as u32
                            } else {
                                0
                            },
                        )
                        | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(
                            if child == Child::PasswordEdit {
                                ES_PASSWORD as u32
                            } else {
                                ES_AUTOVSCROLL as u32
                            },
                        ),
                    10,
                    10,
                    560,
                    340,
                    Some(hwnd),
                    None,
                    None,
                    Some(std::ptr::null()),
                )
                .expect("Failed to create edit child");
                if child == Child::ScrollEdit {
                    let lines: String = (1..=80)
                        .map(|i| {
                            format!(
                                "corpus line {i}
"
                            )
                        })
                        .collect();
                    let wide: Vec<u16> = lines.encode_utf16().chain(std::iter::once(0)).collect();
                    let _ = SetWindowTextW(edit, windows::core::PCWSTR(wide.as_ptr()));
                }
            }
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
    events: &'a [ActionEvent],
}

/// Serialize the session's events to the corpus event-dump location
/// (repo root = CARGO_MANIFEST_DIR/../../..).
fn write_dump(session: &str, events: &[ActionEvent]) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../corpus/out/desktop-windows-events");
    fs::create_dir_all(&dir).expect("create events dir");
    let dump = Dump { session, events };
    fs::write(
        dir.join(format!("{session}.events.json")),
        serde_json::to_string_pretty(&dump).expect("serialize dump"),
    )
    .expect("write dump");
}

/// Run one mouse-driven session: start capture, create the (unraised) session
/// and primer windows, run the scripted input against their centres, stop
/// bounded, write the dump. `scroll_edit` adds the multiline EDIT child to
/// the session window (created on the window's own thread).
fn run_mouse_session_with(
    session: &str,
    child: Child,
    script: impl FnOnce(&mut Enigo, &SessionWindow, &SessionWindow),
) {
    let (tx, rx) = mpsc::channel::<ActionEvent>();
    let mut capture = WindowsCapture::new();
    capture.set_excluded_pid(None);
    capture.start(tx).expect("Failed to start capture");
    thread::sleep(Duration::from_millis(200));

    let win = SessionWindow::build("Docent Corpus Session", 200, 200, child);
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

fn run_mouse_session(
    session: &str,
    script: impl FnOnce(&mut Enigo, &SessionWindow, &SessionWindow),
) {
    run_mouse_session_with(session, Child::None, script)
}

/// Ownership guard (the coordinate_fallback_for_plain_window precedent):
/// the click point must belong to OUR window before input is synthesized —
/// otherwise the click leaks into whatever overlaps that point.
fn assert_owns_point(hwnd: HWND, x: i32, y: i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
    let start = Instant::now();
    loop {
        let under = unsafe { WindowFromPoint(POINT { x, y }) };
        let root = unsafe { GetAncestor(under, GA_ROOT) };
        if under == hwnd || root == hwnd {
            return;
        }
        if start.elapsed() > Duration::from_millis(2000) {
            panic!("SETUP FAILURE (environment, not capture): the click point does not belong to the session window - refusing to synthesize input that would leak into another application");
        }
        thread::sleep(Duration::from_millis(50));
    }
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

/// Wheel scroll over content that REALLY scrolls (a multiline EDIT child,
/// created on the window thread — a cross-thread child deadlocks parent
/// teardown): 5 notches, far past the significance floor
/// (SCROLL_MIN_DISTANCE_PX in src/capture/timing.rs). docent#228: current
/// capture derives scroll actions from wheel notches and fabricates
/// scroll_top/scroll_left as 0.0 with element: null; the truth carries the
/// real movement (the scroll-amounts relaxation keeps 0-vs-nonzero visible).
#[test]
#[serial]
fn d_scroll_above_floor() {
    run_mouse_session_with(
        "d-scroll-above-floor",
        Child::ScrollEdit,
        |enigo, win, _primer| {
            enigo.move_mouse(win.cx, win.cy, Coordinate::Abs).unwrap();
            thread::sleep(Duration::from_millis(50));
            enigo.button(enigo::Button::Left, Direction::Click).unwrap();
            thread::sleep(Duration::from_millis(350));
            enigo.scroll(5, enigo::Axis::Vertical).unwrap();
            thread::sleep(Duration::from_millis(600));
        },
    );
}

/// One wheel notch over the really-scrolling EDIT — under the significance
/// floor (SCROLL_MIN_DISTANCE_PX), so current capture discards the scroll
/// entirely (docent#232). The truth carries it.
#[test]
#[serial]
fn d_scroll_floor() {
    run_mouse_session_with(
        "d-scroll-floor",
        Child::ScrollEdit,
        |enigo, win, _primer| {
            enigo.move_mouse(win.cx, win.cy, Coordinate::Abs).unwrap();
            thread::sleep(Duration::from_millis(50));
            enigo.button(enigo::Button::Left, Direction::Click).unwrap();
            thread::sleep(Duration::from_millis(350));
            enigo.scroll(1, enigo::Axis::Vertical).unwrap();
            thread::sleep(Duration::from_millis(600));
        },
    );
}

/// Click the empty single-line EDIT (focus follows the click-driven
/// activation), then type: printable keys buffer and the same-root
/// value-change coalesces them into one type action (docent#220-era
/// semantics). Focus-dependent — the count-determinism hedge applies if the
/// headless runner refuses focus-driven typing.
#[test]
#[serial]
fn d_type_edit() {
    run_mouse_session_with("d-type-edit", Child::TypeEdit, |enigo, win, _primer| {
        enigo.move_mouse(win.cx, win.cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(350));
        // Per-character Key::Unicode clicks with a human-ish cadence: layout
        // VKs, so printables buffer and the value-change supersedes them
        // (enigo.text() would inject VK_PACKET keystrokes — see the session
        // notes: that path leaks phantom keys nondeterministically).
        for c in "hello".chars() {
            enigo.key(enigo::Key::Unicode(c), Direction::Click).unwrap();
            thread::sleep(Duration::from_millis(60));
        }
        thread::sleep(Duration::from_millis(600));
    });
}

/// The d-type-edit pattern against an ES_PASSWORD EDIT: the native
/// IsPassword signal masks the typed value at capture — truth pins the exact
/// mask, the redacted flag, and nulled text (the desktop chokepoint contract
/// PR #248 drift-guards; here it runs against a REAL capture).
#[test]
#[serial]
fn d_redaction() {
    run_mouse_session_with("d-redaction", Child::PasswordEdit, |enigo, win, _primer| {
        enigo.move_mouse(win.cx, win.cy, Coordinate::Abs).unwrap();
        thread::sleep(Duration::from_millis(50));
        enigo.button(enigo::Button::Left, Direction::Click).unwrap();
        thread::sleep(Duration::from_millis(350));
        for c in "hunter".chars() {
            enigo.key(enigo::Key::Unicode(c), Direction::Click).unwrap();
            thread::sleep(Duration::from_millis(60));
        }
    });
}

/// A click on the PLAIN custom-class window (DefWindowProc, no accessibility
/// content): element resolution finds only the window, so capture falls back
/// to coordinate mode - screen point + window geometry, no element-identity
/// claims. The ownership guard runs before input (a click-through or covered
/// point must never leak input into another application).
#[test]
#[serial]
fn d_coordinate() {
    let (tx, rx) = mpsc::channel::<ActionEvent>();
    let mut capture = WindowsCapture::new();
    capture.set_excluded_pid(None);
    capture.start(tx).expect("Failed to start capture");
    thread::sleep(Duration::from_millis(200));

    let win = SessionWindow::build2("Docent Corpus Plain", 200, 200, Child::None, true);
    let primer = SessionWindow::new("Docent Corpus Primer", 900, 620);
    thread::sleep(Duration::from_millis(200));
    assert_owns_point(win.hwnd, win.cx, win.cy);

    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    enigo.move_mouse(win.cx, win.cy, Coordinate::Abs).unwrap();
    thread::sleep(Duration::from_millis(50));
    enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    thread::sleep(Duration::from_millis(800));

    drop(primer);
    drop(win);
    let start = Instant::now();
    capture.stop().unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "capture.stop() must not hang"
    );
    let events: Vec<ActionEvent> = rx.try_iter().collect();
    write_dump("d-coordinate", &events);
}

// ---------------------------------------------------------------------------
// Conformance-vector fixture (desktop leg; doctrine in docs/verification/scripted-truth-corpus.md
// and docs/technical/locator-resolution.md "Conformance and Vector Scope").
//
// This is a dedicated VECTOR-ONLY fixture, NOT a manifest corpus session: it
// has no truth.docent.json and no known-diffs baseline key (enumerated in
// corpus/vector-fixtures.json). It captures the acted-on element through the
// REAL desktop path and serializes a full-window UIA Control-view snapshot, so
// a committed conformance vector can be assembled from producer-emitted facts
// (never hand-authored). Node assembly + the hygiene locks live in JS
// (scripts/corpus-assemble-desktop-vectors.js,
// packages/shared/tests/unit/conformance-vectors.test.js).
// ---------------------------------------------------------------------------

/// Reserved placeholder for the normalized Name of OS-provided (non-authored)
/// nodes — the corpus's environment-string normalization discipline, so a
/// committed snapshot never freezes an OS-locale string. ASCII + bracketed so
/// it cannot collide with an authored content Name.
const NAME_PLACEHOLDER: &str = "[os-name]";

/// The LabeledBy relation edge carried by a snapshot node.
#[derive(serde::Serialize)]
struct LabeledByEdge {
    target_name: String,
}

/// One serialized node of the UIA Control view — the desktop_node shape in
/// corpus/vector.schema.json. control_type/automation_id/class_name/structure
/// are verbatim (stable, count-relevant); Names are normalized per authored
/// provenance (see [`walk_node`]).
#[derive(serde::Serialize)]
struct SnapshotNode {
    node_id: String,
    control_type: String,
    name: Option<String>,
    automation_id: Option<String>,
    class_name: Option<String>,
    text: Option<String>,
    labeled_by: Option<LabeledByEdge>,
    children: Vec<SnapshotNode>,
}

/// The producer-emitted vector source dump: the acted-on element's real capture
/// facts + the full-window snapshot + the ground-truth node. The Node assembler
/// splits `element` into element_facts + locators, augments labeled_by/tree_path
/// with harness-measured stats over the snapshot, and writes the committed
/// `.vector.json`.
#[derive(serde::Serialize)]
struct VecDump<'a> {
    fixture: &'a str,
    window_title: String,
    element: &'a ElementDescription,
    tree_snapshot: SnapshotNode,
    ground_truth_node_id: String,
}

/// Map a UIA control-type id to its non-localized name. Copied VERBATIM from
/// `capture::windows::control_type_name` (which is `pub(crate)`, so an
/// integration test cannot call it) — the snapshot's control_type MUST match
/// exactly what production records as `element.tag` / `role_name.role` /
/// tree_path segments, or the harness measurement would diverge from capture.
fn control_type_name(id: i32) -> &'static str {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Unknown",
    }
}

/// Read a BSTR property; empty string when absent (total, like the production
/// property helpers).
unsafe fn prop_string(element: &IUIAutomationElement, property_id: UIA_PROPERTY_ID) -> String {
    element
        .GetCurrentPropertyValue(property_id)
        .ok()
        .and_then(|v| {
            let inner = &v.Anonymous.Anonymous;
            if inner.vt == VT_BSTR {
                let bstr_ptr = &inner.Anonymous.bstrVal;
                if bstr_ptr.is_empty() {
                    None
                } else {
                    Some(bstr_ptr.to_string())
                }
            } else {
                None
            }
        })
        .unwrap_or_default()
}

/// Read an i32 property; 0 when absent.
unsafe fn prop_i32(element: &IUIAutomationElement, property_id: UIA_PROPERTY_ID) -> i32 {
    element
        .GetCurrentPropertyValue(property_id)
        .ok()
        .and_then(|v| {
            let val: Result<i32, _> = (&v).try_into();
            val.ok()
        })
        .unwrap_or(0)
}

/// The accessible Name of the element referenced by LabeledBy; empty when none.
/// Mirrors `capture::windows::get_labeled_by_name`.
unsafe fn labeled_by_name(element: &IUIAutomationElement) -> String {
    element
        .GetCurrentPropertyValue(UIA_LabeledByPropertyId)
        .ok()
        .and_then(|v| {
            let inner = &v.Anonymous.Anonymous;
            if inner.vt == VT_UNKNOWN {
                inner
                    .Anonymous
                    .punkVal
                    .as_ref()
                    .and_then(|unk| unk.cast::<IUIAutomationElement>().ok())
            } else {
                None
            }
        })
        .map(|label| prop_string(&label, UIA_NamePropertyId))
        .unwrap_or_default()
}

/// Recursively serialize one Control-view node and its descendants, assigning
/// pre-order node ids, marking the ground truth by authored AutomationId, and
/// normalizing OS-provided Names.
#[allow(clippy::too_many_arguments)]
unsafe fn walk_node(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    counter: &mut usize,
    depth: usize,
    ground_truth: &mut Option<String>,
    target_automation_id: &str,
) -> SnapshotNode {
    let node_id = format!("d{}", *counter);
    *counter += 1;

    let control_type = control_type_name(prop_i32(element, UIA_ControlTypePropertyId)).to_string();
    let raw_name = prop_string(element, UIA_NamePropertyId);
    let automation_id = prop_string(element, UIA_AutomationIdPropertyId);
    let class_name = prop_string(element, UIA_ClassNamePropertyId);
    let value = prop_string(element, UIA_ValueValuePropertyId);
    let label = labeled_by_name(element);

    // Authored content provenance ([Q-3]/[Z-2]): a node carrying an authored
    // content AutomationId — or the window root — keeps its Name; every other
    // node's Name is OS-provided and normalized, REGARDLESS of tree position.
    // control_type/automation_id/class_name/structure are always kept verbatim.
    let authored = FIXTURE_AUTHORED_IDS.contains(&automation_id.as_str());
    let is_root = depth == 0;
    let keep_name = authored || is_root;

    if ground_truth.is_none() && !automation_id.is_empty() && automation_id == target_automation_id
    {
        *ground_truth = Some(node_id.clone());
    }

    let name = if raw_name.is_empty() {
        None
    } else if keep_name {
        Some(raw_name)
    } else {
        Some(NAME_PLACEHOLDER.to_string())
    };
    // text (corroboration only) and the labeled_by edge (an authored label
    // relation) are kept only for authored content; OS nodes carry neither.
    let text = if keep_name && !value.is_empty() {
        Some(value.chars().take(100).collect())
    } else {
        None
    };
    let labeled_by = if keep_name && !label.is_empty() {
        Some(LabeledByEdge { target_name: label })
    } else {
        None
    };

    let mut children = Vec::new();
    if depth < 40 && *counter < 500 {
        let mut next = walker
            .GetFirstChildElement(element)
            .ok()
            .filter(|e| !e.as_raw().is_null());
        while let Some(child) = next {
            children.push(walk_node(
                walker,
                &child,
                counter,
                depth + 1,
                ground_truth,
                target_automation_id,
            ));
            next = walker
                .GetNextSiblingElement(&child)
                .ok()
                .filter(|e| !e.as_raw().is_null());
        }
    }

    SnapshotNode {
        node_id,
        control_type,
        name,
        automation_id: (!automation_id.is_empty()).then_some(automation_id),
        class_name: (!class_name.is_empty()).then_some(class_name),
        text,
        labeled_by,
        children,
    }
}

/// Walk the acted-on top-level window's Control view (window itself included —
/// the spec's desktop bound scope, no excision), returning the snapshot root and
/// the ground-truth node id. New code: production has only an upward ancestor
/// walk (tree_path derivation), never a downward subtree serializer.
unsafe fn walk_window(hwnd: HWND, target_automation_id: &str) -> (SnapshotNode, Option<String>) {
    // UIA works in either apartment; ignore an already-initialized result.
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let uia: IUIAutomation =
        CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL).expect("create UIAutomation");
    let root = uia
        .ElementFromHandle(hwnd)
        .expect("resolve the window UIA element");
    let walker = uia.ControlViewWalker().expect("control view walker");
    let mut counter = 0usize;
    let mut ground_truth = None;
    let snapshot = walk_node(
        &walker,
        &root,
        &mut counter,
        0,
        &mut ground_truth,
        target_automation_id,
    );
    (snapshot, ground_truth)
}

/// Write the producer-emitted vector source dump to the corpus vectors-out
/// location (repo root = CARGO_MANIFEST_DIR/../../..).
fn write_vecdump(
    fixture: &str,
    window_title: &str,
    element: &ElementDescription,
    tree_snapshot: SnapshotNode,
    ground_truth_node_id: String,
) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../corpus/out/desktop-windows-vectors");
    fs::create_dir_all(&dir).expect("create vectors-out dir");
    let dump = VecDump {
        fixture,
        window_title: window_title.to_string(),
        element,
        tree_snapshot,
        ground_truth_node_id,
    };
    fs::write(
        dir.join(format!("{fixture}.vecdump.json")),
        serde_json::to_string_pretty(&dump).expect("serialize vecdump"),
    )
    .expect("write vecdump");
}

/// Produce the desktop conformance-vector fixture live: create the labeled-edit
/// fixture window (unraised), focus the EDIT with a real click, type one
/// character (the value-change coalesces into a worker-described `type` whose
/// element carries MEASURED locator stats — an input-time click element is
/// unmeasured), walk the window's Control view, and dump the acted-on element +
/// snapshot + ground truth. `use enigo` classifies this as an integration test;
/// `#[serial]` guards the shared input layer; the fixture needs real focus.
#[test]
#[serial]
fn v_vector_fixture() {
    const FIXTURE: &str = "desktop-fixture";
    const WINDOW_TITLE: &str = "Docent Vector Fixture";
    const TARGET_AUTOMATION_ID: &str = "1002"; // the EDIT's Win32 control id

    let (tx, rx) = mpsc::channel::<ActionEvent>();
    let mut capture = WindowsCapture::new();
    capture.set_excluded_pid(None);
    capture.start(tx).expect("Failed to start capture");
    thread::sleep(Duration::from_millis(200));

    let win = SessionWindow::build(WINDOW_TITLE, 250, 250, Child::LabeledEdit);
    let primer = SessionWindow::new("Docent Corpus Primer", 900, 620);
    thread::sleep(Duration::from_millis(200));

    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    enigo.move_mouse(win.cx, win.cy, Coordinate::Abs).unwrap();
    thread::sleep(Duration::from_millis(50));
    enigo.button(enigo::Button::Left, Direction::Click).unwrap();
    thread::sleep(Duration::from_millis(350));
    // Single layout-VK keystroke (never enigo.text(), which injects VK_PACKET).
    enigo
        .key(enigo::Key::Unicode('x'), Direction::Click)
        .unwrap();
    thread::sleep(Duration::from_millis(700));

    drop(primer);
    thread::sleep(Duration::from_millis(300));

    // Walk the acted-on window's Control view while it is still alive.
    let (snapshot, ground_truth) = unsafe { walk_window(win.hwnd, TARGET_AUTOMATION_ID) };

    let start = Instant::now();
    capture.stop().unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "capture.stop() must not hang (took {:?})",
        start.elapsed()
    );
    let events: Vec<ActionEvent> = rx.try_iter().collect();

    // The vector-carrying element is the worker-described `type` element.
    let element = events.iter().find_map(|e| match &e.payload {
        ActionPayload::Type { element, .. } => Some(element.clone()),
        _ => None,
    });

    // Surface an environment shortfall loudly rather than writing a half dump:
    // if the headless runner refuses focus-driven typing, no `type` is captured.
    let element = element.expect(
        "no worker-described `type` action captured — the fixture needs real focus-driven typing",
    );
    let ground_truth_node_id = ground_truth
        .expect("the EDIT (authored automation_id 1002) was not found in the Control view");

    write_vecdump(
        FIXTURE,
        WINDOW_TITLE,
        &element,
        snapshot,
        ground_truth_node_id,
    );

    drop(win);
}
