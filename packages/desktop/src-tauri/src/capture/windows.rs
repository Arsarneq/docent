// Windows UI Automation Provider — platform-specific capture implementation.
//
// This module implements the `CaptureLayer` trait for Windows using a
// worker pool architecture:
//
// - **Input_Thread**: Runs `SetWinEventHook` / `SetWindowsHookEx` callbacks
//   and a message pump. Captures raw event data (coordinates, window handles,
//   key codes, timestamps) and dispatches `RawEvent`s to workers. It makes no
//   accessibility call: the `ElementFromPoint` pre-capture of clicked
//   elements runs on the pre-capture describers, which the mouse hook waits
//   on for at most a budget set from the system's hook timeout (DCP-1);
//   every other accessibility query runs on the workers.
//
// - **Worker_Pool**: 3 pre-initialised Accessibility_Worker threads, each
//   with its own COM STA apartment and `IUIAutomation` instance. Workers
//   receive `RawEvent`s, perform the expensive accessibility queries, and
//   produce completed `ActionEvent`s with monotonic sequence numbers.
//
// The capture runs on dedicated OS threads because Windows event hooks
// require a message pump (`GetMessage`/`DispatchMessage`) on the registering
// thread.
//
// Governance declared in scripts/area-map.json (see its declared-governance entry): this provider decides when context
// lifecycle actions are emitted (the input-correlation gate for
// context_switch, the tracked-window filter for context_open/context_close),
// so it bears on the format's context-introduction rule; the per-platform
// schemas are authoritative for field semantics.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::uia_core_api::{
    UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId, UIA_ControlTypePropertyId,
    UIA_CulturePropertyId, UIA_FrameworkIdPropertyId, UIA_IsControlElementPropertyId,
    UIA_IsKeyboardFocusablePropertyId, UIA_IsPasswordPropertyId, UIA_LabeledByPropertyId,
    UIA_LevelPropertyId, UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId,
    UIA_NativeWindowHandlePropertyId, UIA_PositionInSetPropertyId, UIA_SelectionPatternId,
    UIA_SizeOfSetPropertyId, UIA_ToolBarControlTypeId, UIA_ValueValuePropertyId,
};
use super::variant::Variant;
use super::win32_bindings::{
    CUIAutomation, CallNextHookEx, CloseHandle, CoCreateInstance, CoInitializeEx, CoUninitialize,
    DispatchMessageW, EnumWindows, GetAncestor, GetAsyncKeyState, GetClassNameW,
    GetCurrentThreadId, GetDoubleClickTime, GetForegroundWindow, GetGUIThreadInfo, GetKeyState,
    GetKeyboardLayout, GetKeyboardLayoutList, GetMessageW, GetParent, GetSystemDirectoryW,
    GetSystemMetrics, GetUserPreferredUILanguages, GetWindow, GetWindowLongW, GetWindowTextW,
    GetWindowThreadProcessId, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationSelectionPattern, ImmGetDefaultIMEWnd, InternalGetWindowText, IsWindow,
    IsWindowVisible, LCIDToLocaleName, MapVirtualKeyExW, PeekMessageW, PostThreadMessageW,
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, SendMessageTimeoutW,
    SetProcessDpiAwarenessContext, SetWinEventHook, SetWindowsHookExW, TranslateMessage,
    TreeScope_Descendants, TreeScope_Subtree, UnhookWinEvent, UnhookWindowsHookEx, WindowFromPoint,
    ACCESS_MASK, CHILDID_SELF, CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY,
    EVENT_OBJECT_FOCUS, EVENT_OBJECT_SELECTION, EVENT_OBJECT_VALUECHANGE, EVENT_SYSTEM_FOREGROUND,
    GA_ROOT, GA_ROOTOWNER, GUITHREADINFO, GWL_STYLE, GW_OWNER, HANDLE, HHOOK, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKL, HWINEVENTHOOK, HWND, INVALID_HANDLE_VALUE,
    KBDLLHOOKSTRUCT, KEY_READ, LCID, LLKHF_EXTENDED, LOCALE_ALLOW_NEUTRAL_NAMES,
    LOCALE_NAME_MAX_LENGTH, LPARAM, LRESULT, MAPVK_VK_TO_CHAR, MSG, MSLLHOOKSTRUCT,
    MUI_LANGUAGE_NAME, OBJID_WINDOW, PM_NOREMOVE, POINT, PROPERTYID, RRF_RT_REG_DWORD,
    RRF_RT_REG_SZ, SMTO_ABORTIFHUNG, SMTO_BLOCK, SM_CXDOUBLECLK, SM_CYDOUBLECLK, UIA_HWND,
    VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VT_EMPTY, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WINEVENT_OUTOFCONTEXT, WM_APP, WM_IME_CONTROL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDOWN, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NULL, WM_QUIT, WM_RBUTTONDOWN,
    WM_SYSKEYDOWN, WM_USER, WPARAM, WS_CHILD,
};
use super::win32_bindings::{RtlGetVersion, ToUnicodeEx, OSVERSIONINFOW};
use windows_core::{Error, Interface, BOOL, BSTR, PWSTR};

use super::element_mapping::{
    map_element, truncate_text, LocatorMeasurements, MeasuredIndex, MeasuredPair,
    NativeElementProperties,
};
use super::hook_diagnostics;
use super::language::{names_a_language, parse_multi_string, tag_from_wide};
use super::pre_capture::{
    pre_capture_click, Built, PreCapture, Readiness, SessionPreCapture, PROCESS_DESCRIBERS,
};
use super::scroll::KeyAttribution;
use super::timing;
use super::worker_pool::{
    fallback_drain_and_seal, worker_loop, AccessibilityBackend, ClickPress, ControlLook,
    ControlNature, DoubleClickBounds, DoubleClickTracker, PendingDirectory, RawEvent, RawEventType,
    WorkerPool, CLICK_COMPLETES_DOUBLE_CLICK, CLICK_IS_MIDDLE_BUTTON, FLUSH_BARRIER_TIMEOUT,
};
use super::{
    ActionEvent, BarrierCompletion, BarrierReport, CaptureError, CaptureLayer, ElementDescription,
    PermissionStatus, WindowInfo,
};

/// Number of accessibility worker threads in the pool.
const WORKER_COUNT: usize = 3;

/// Thread message (posted to the Input_Thread) that triggers the commit flush
/// barrier (docent#298). The command thread posts it after enqueuing a
/// [`FlushRequest`]; the Input_Thread forwards the request onto its own sender
/// as a [`BridgeMessage::Flush`] so the flush is FIFO-ordered behind every raw
/// event the step already produced.
const WM_APP_FLUSH: u32 = WM_APP as u32 + 1;

/// Messages carried on the Input_Thread → bridge channel.
///
/// The bridge either dispatches a raw event to the worker pool or, for the
/// commit flush barrier (docent#298), runs the pool-wide flush and reports the
/// rescued-worker set back through `done`. Both variants travel on the input
/// thread's single sender, so a `Flush` is FIFO-ordered behind every `Event`
/// the input thread has already produced for the step.
enum BridgeMessage {
    Event(Box<RawEvent>),
    Flush {
        barrier_id: u64,
        done: std::sync::mpsc::Sender<Vec<usize>>,
    },
    /// A window the recording keeps nothing of came to the front, away from
    /// the field typed into (docent#768). FIFO-ordered behind the keys already sent.
    TypingEnded,
    /// A key went down in a window the recording keeps nothing of
    /// ([`super::worker_pool::WorkerMessage::UnrecordedKey`]): the layout it
    /// went down on, its code, and the modifiers and Caps Lock state of the
    /// press. FIFO-ordered among the keys sent.
    UnrecordedKey {
        layout: i64,
        key_code: u32,
        held: u8,
    },
}

/// A pending commit-barrier request handed from the command thread to the
/// Input_Thread via [`INPUT_FLUSH_REQUESTS`]. The input thread pops it and
/// forwards it onto its own sender as a [`BridgeMessage::Flush`].
struct FlushRequest {
    barrier_id: u64,
    done: std::sync::mpsc::Sender<Vec<usize>>,
}

/// Shared queue of pending commit-barrier requests (command thread → Input_Thread).
type FlushQueue = Arc<Mutex<VecDeque<FlushRequest>>>;

/// Upper bound `start()` waits for each worker to finish its (possibly cold)
/// UIA/COM init before proceeding without it. Generous because a fresh or
/// headless machine's first `CoCreateInstance(CUIAutomation)` can take several
/// seconds; hitting this bound is pathological and only logs a warning.
const WORKER_INIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound `start()` waits for the Input_Thread's startup handshake — the
/// hooks-registered (or failed) report it sends after COM init and hook
/// registration. Normally milliseconds; generous for the same cold-machine
/// reason as [`WORKER_INIT_TIMEOUT`]. Hitting the bound only warns and
/// proceeds (a definite failure report, by contrast, fails `start()` loudly).
const INPUT_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Bounded wait used while cleaning up after a failed `start()`: how long to
/// wait for a thread that is expected to be exiting before abandoning it.
const FAILED_START_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Upper bound `start()` waits for the Input_Thread to report its thread id.
/// The report is sent immediately after the thread forces its message queue
/// into existence — before COM init and hook registration — so it normally
/// arrives in microseconds; missing this bound means the thread never ran.
const INPUT_TID_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// PID exclusion helper
// ---------------------------------------------------------------------------

/// Check if a window is owned by (or is a child of) a window belonging to the
/// excluded process. This catches system dialogs (prompt, file picker, etc.)
/// that are visually part of Docent but run under system process PIDs like
/// explorer.exe.
unsafe fn is_owned_by_excluded(hwnd: HWND, excluded_pid: u32) -> bool {
    // Walk up the owner chain to the root owner window
    let root_owner = GetAncestor(hwnd, GA_ROOTOWNER as u32);
    if root_owner.0.is_null() || root_owner == hwnd {
        return false;
    }
    let mut owner_pid: u32 = 0;
    GetWindowThreadProcessId(root_owner, Some(&mut owner_pid));
    if owner_pid == excluded_pid {
        return true;
    }
    // Also check if the root owner belongs to a child of the excluded process
    !windows_should_keep_event(owner_pid, Some(excluded_pid)) && owner_pid != 0
}

// ---------------------------------------------------------------------------
// Windows process-tree filtering (self-capture exclusion)
// ---------------------------------------------------------------------------

/// Windows-specific extension of the platform-agnostic
/// [`should_keep_event`](super::scroll::should_keep_event) filter.
///
/// Returns `true` if the event should be **kept**. Applies the shared base
/// rule first (PID 0 / direct excluded-PID match), then, while self-capture
/// exclusion is on, DCP-5's process-tree ground (`is_descendant_of`) — Docent
/// renders its UI in a WebView2 host that spawns several layers of child
/// processes under different PIDs — and its executable-name ground — the
/// webview runtime's or Docent's own (`is_recognized_by_exe_name`); DCP-5's
/// owned-window ground is the scope filter's, applied through
/// `is_owned_by_excluded`, which itself consults this filter.
fn windows_should_keep_event(event_pid: u32, excluded_pid: Option<u32>) -> bool {
    if !super::scroll::should_keep_event(event_pid, excluded_pid) {
        return false;
    }
    if let Some(excl) = excluded_pid {
        // Check if the process is part of the Docent process tree.
        // WebView2 spawns multiple levels of child processes, so we check
        // both the ancestor chain AND the process executable name.
        if is_descendant_of(event_pid, excl) {
            return false;
        }
        // Executable-name ground (DCP-5): the webview runtime's file name, or
        // Docent's own binary name, regardless of tree membership.
        if is_recognized_by_exe_name(event_pid) {
            return false;
        }
    }
    true
}

/// The running process's own executable file name, read once — Docent's own
/// binary name for the executable-name ground (DCP-5), whatever the build named
/// it (dev, bundled, or test binary).
fn own_exe_name() -> Option<&'static str> {
    static OWN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    OWN.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
    })
    .as_deref()
}

/// Check if a process is recognized by executable name (DCP-5): the webview
/// runtime's file name or Docent's own binary name, matched whole
/// ([`is_recognized_exe_name`](super::scroll::is_recognized_exe_name)).
fn is_recognized_by_exe_name(pid: u32) -> bool {
    get_process_exe_name(pid)
        .is_some_and(|name| super::scroll::is_recognized_exe_name(&name, own_exe_name()))
}

/// Check if `pid` is a descendant (child, grandchild, etc.) of `ancestor_pid`.
/// Walks up the process tree via parent PIDs, up to 5 levels deep.
fn is_descendant_of(pid: u32, ancestor_pid: u32) -> bool {
    let mut current = pid;
    for _ in 0..5 {
        match get_parent_pid(current) {
            Some(parent) if parent == ancestor_pid => return true,
            Some(parent) if parent == 0 || parent == current => return false,
            Some(parent) => current = parent,
            None => return false,
        }
    }
    false
}

/// The failure read of a `HANDLE`-returning call, in one place: `OpenProcess`
/// reports failure as a null handle and `CreateToolhelp32Snapshot` as
/// `INVALID_HANDLE_VALUE`; both values are refused for every handle. `None` on
/// failure.
fn valid_handle(handle: HANDLE) -> Option<HANDLE> {
    (!handle.0.is_null() && handle != INVALID_HANDLE_VALUE).then_some(handle)
}

/// Get the executable name of a process by PID using CreateToolhelp32Snapshot.
fn get_process_exe_name(pid: u32) -> Option<String> {
    use super::win32_bindings::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = valid_handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS as u32, 0))?;
        let mut entry = PROCESSENTRY32 {
            dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };
        if Process32First(snapshot, &mut entry).as_bool() {
            loop {
                if entry.th32ProcessID == pid {
                    let _ = CloseHandle(snapshot);
                    let name = entry
                        .szExeFile
                        .iter()
                        .take_while(|&&c| c != 0)
                        .map(|&c| c as u8 as char)
                        .collect::<String>();
                    return Some(name);
                }
                if !Process32Next(snapshot, &mut entry).as_bool() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        None
    }
}

/// Get the parent PID of a process using CreateToolhelp32Snapshot.
fn get_parent_pid(pid: u32) -> Option<u32> {
    use super::win32_bindings::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = valid_handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS as u32, 0))?;
        let mut entry = PROCESSENTRY32 {
            dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };
        if Process32First(snapshot, &mut entry).as_bool() {
            loop {
                if entry.th32ProcessID == pid {
                    let _ = CloseHandle(snapshot);
                    return Some(entry.th32ParentProcessID);
                }
                if !Process32Next(snapshot, &mut entry).as_bool() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        None
    }
}

/// Movement past which a left press-move-release records a drag rather than a
/// click, in pixels on either axis (desktop capture principles, DCP-10).
const DRAG_THRESHOLD_PX: i32 = 5;

/// Whether a left press-move-release moved far enough to be a drag: more than
/// [`DRAG_THRESHOLD_PX`] between button-down and button-up on either axis,
/// measured as absolute distance so direction does not matter. Movement within
/// the threshold is a click.
///
/// Extracted as pure logic the release handler consumes (the discipline the
/// contributing guide states for JavaScript, applied here) so the threshold's
/// boundary is unit-testable without synthesizing real mouse input.
fn is_drag(down: POINT, up: POINT) -> bool {
    let dx = (up.x - down.x).abs();
    let dy = (up.y - down.y).abs();
    dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX
}

/// What a left-button release records (desktop capture principles, DCP-10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeftRelease {
    /// One click, at the release point.
    Click,
    /// The drag pair — a drag_start followed by a drop — whose source is
    /// described from the recorded press point.
    DragPair { source_coords: (i32, i32) },
}

/// What the left button's release records, decided from the press point the
/// button-down recorded (absent when no press was recorded for this release)
/// and the release point: the drag pair once the movement passes the
/// [`DRAG_THRESHOLD_PX`] threshold, and a click otherwise. The pair's source
/// is the press point, which is where the gesture started.
///
/// Pure logic the release handler consumes, so the whole decision — not only
/// its threshold — is unit-testable without synthesizing real mouse input.
/// The other buttons reach no decision here: their arms record on button-down
/// through [`down_dispatch_event_type`].
fn classify_left_release(down: Option<POINT>, up: POINT) -> LeftRelease {
    match down {
        Some(down_pt) if is_drag(down_pt, up) => LeftRelease::DragPair {
            source_coords: (down_pt.x, down_pt.y),
        },
        _ => LeftRelease::Click,
    }
}

/// The raw event a button-down message records, for the buttons whose action is
/// dispatched from the press itself: the middle button records a click and the
/// right button a right-click, each on button-down. A message outside that pair
/// records nothing here — the left button's own arms carry the press-move-release
/// decision ([`classify_left_release`]), and the wheel messages their own.
///
/// Pure logic both button-down arms consume, so the mapping is unit-testable
/// without synthesizing real mouse input.
fn down_dispatch_event_type(msg: u32) -> Option<RawEventType> {
    match msg as i32 {
        WM_MBUTTONDOWN => Some(RawEventType::Click),
        WM_RBUTTONDOWN => Some(RawEventType::RightClick),
        _ => None,
    }
}

/// The `callback_params[0]` a button-down's raw event carries: the middle
/// button's click is marked as the middle button's, so the click arm tells it
/// from a left click (it confirms no file dialog); the right-click needs no
/// mark.
///
/// Pure logic the button-down arm consumes, so the mark is unit-testable
/// without synthesizing real mouse input.
fn down_dispatch_click_mark(msg: u32) -> i64 {
    match msg as i32 {
        WM_MBUTTONDOWN => CLICK_IS_MIDDLE_BUTTON,
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// Thread-local state for Input_Thread hook callbacks
// ---------------------------------------------------------------------------
//
// Windows hook callbacks are C-style `extern "system"` functions that cannot
// capture closures. We use thread-local statics to give the callbacks access
// to the dispatch channel, sequence counter, and other per-session state.

thread_local! {
    /// How many mouse hook calls are running on the Input_Thread, one inside
    /// another: a call dispatched while the thread waits inside an earlier
    /// one (`hook_diagnostics`).
    static INPUT_MOUSE_HOOK_DEPTH: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// Channel sender for dispatching messages to the bridge thread.
    static INPUT_RAW_SENDER: std::cell::RefCell<Option<std::sync::mpsc::Sender<BridgeMessage>>> =
        const { std::cell::RefCell::new(None) };

    /// Shared queue of pending commit-barrier requests (docent#298). The command
    /// thread pushes a [`FlushRequest`] and posts `WM_APP_FLUSH`; the message
    /// pump pops it here and forwards it onto `INPUT_RAW_SENDER`.
    static INPUT_FLUSH_REQUESTS: std::cell::RefCell<Option<FlushQueue>> =
        const { std::cell::RefCell::new(None) };

    /// Shared sequence counter for assigning monotonic sequence IDs.
    static INPUT_SEQUENCE_COUNTER: std::cell::RefCell<Option<Arc<AtomicU64>>> =
        const { std::cell::RefCell::new(None) };

    /// Shared active flag — checked by hook callbacks to skip events after stop.
    static INPUT_ACTIVE: std::cell::RefCell<Option<Arc<AtomicBool>>> =
        const { std::cell::RefCell::new(None) };

    /// Shared excluded PID for self-capture filtering.
    static INPUT_EXCLUDED_PID: std::cell::RefCell<Option<Arc<AtomicU32>>> =
        const { std::cell::RefCell::new(None) };

    /// Shared included PID for target app filtering. 0 means capture all.
    static INPUT_INCLUDED_PID: std::cell::RefCell<Option<Arc<AtomicU32>>> =
        const { std::cell::RefCell::new(None) };

    /// What the foreground layout answered about its dead keys, asked once
    /// per key and modifier state ([`foreground_dead_as_pressed`]).
    static INPUT_DEAD_KEY_ANSWERS: std::cell::RefCell<super::held_keys::DeadKeyAnswers> =
        const { std::cell::RefCell::new(super::held_keys::DeadKeyAnswers::new()) };

    /// PID of the current foreground window. Updated on EVENT_SYSTEM_FOREGROUND.
    /// Events from non-foreground processes are filtered out.
    static INPUT_FOREGROUND_PID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };

    /// The focus changes that named a part of a window, by window handle. A
    /// keystroke is stamped with the number of its control's latest one.
    static INPUT_PART_FOCUS: std::cell::RefCell<super::worker_pool::PartFocusNote> =
        std::cell::RefCell::new(super::worker_pool::PartFocusNote::default());

    /// The contexts this capture session has introduced (DCP-7): an event in
    /// a window not introduced yet has a foreground event dispatched before
    /// it. With them the root window of the last switch into the window in
    /// front, which deduplicates foreground events (click-based and
    /// WinEvent-based). Cleared with the thread's other state when the
    /// session ends.
    static INPUT_CONTEXTS: std::cell::RefCell<super::worker_pool::ContextIntroductions> =
        std::cell::RefCell::new(super::worker_pool::ContextIntroductions::default());

    /// Mouse-down position for drag detection. Set on WM_LBUTTONDOWN,
    /// compared against WM_LBUTTONUP to classify click vs drag.
    static INPUT_MOUSE_DOWN_POS: std::cell::Cell<Option<POINT>> = const { std::cell::Cell::new(None) };

    /// The left press under way, for the double-click test at its release:
    /// set on WM_LBUTTONDOWN, read when the release classifies as a click.
    static INPUT_LEFT_PRESS: std::cell::Cell<Option<ClickPress>> = const { std::cell::Cell::new(None) };

    /// Pairs left clicks into double-clicks (DCP-10).
    static INPUT_DOUBLE_CLICKS: std::cell::Cell<DoubleClickTracker> = const {
        std::cell::Cell::new(DoubleClickTracker::new())
    };

    /// Set of window handles for which we've dispatched a WindowCreate event.
    /// Only emit WindowDestroy (context_close) for windows in this set —
    /// prevents spurious context_close for internal windows that were never
    /// captured as context_open.
    static INPUT_OPENED_WINDOWS: std::cell::RefCell<std::collections::HashSet<i64>> =
        std::cell::RefCell::new(std::collections::HashSet::new());

    /// Per-process self-capture verdict cache. Maps PID → should_keep, so the
    /// self-capture grounds are paid for once per process instead of once per
    /// event: the process-tree walk and the executable-name read each open
    /// `CreateToolhelp32Snapshot`, and the owned-window ground opens one too
    /// on the path past its root-owner guards. It is a first-event-wins record,
    /// not a memo of a recomputable answer: a later window of the same process
    /// rides the first event's verdict by design, so an entry is never
    /// refreshed. Lives on the Input_Thread, which is spawned fresh for each
    /// capture session, and is cleared with the thread's other state when that
    /// thread tears down — a verdict never outlives the session that made it.
    static INPUT_PID_CACHE: std::cell::RefCell<std::collections::HashMap<u32, bool>> =
        std::cell::RefCell::new(std::collections::HashMap::new());

    /// The click pre-capture the mouse hook asks (DCP-1): `ElementFromPoint`
    /// at left mouse-up on a non-drag click and at right/middle button-down,
    /// run on a pre-capture describer thread and waited on for at most the
    /// budget set at start from the system's hook timeout
    /// (`timing::pre_capture_budget_ms`), so the element is described while
    /// the target window is still alive and no application holds the hook past
    /// that timeout. A session that could not start it at its start tries
    /// again at a later click, at most once a second.
    static INPUT_PRE_CAPTURE: std::cell::RefCell<SessionPreCapture<ClickPreCapture>> =
        std::cell::RefCell::new(SessionPreCapture::default());

    /// The session's pre-capture budget, set at start from the system's hook
    /// timeout, for a pre-capture started at a later click.
    static INPUT_PRE_CAPTURE_BUDGET: std::cell::Cell<Duration> =
        const { std::cell::Cell::new(Duration::ZERO) };
    /// How long the keyboard hook waits for each answer of a key press's
    /// input-method read, set at the session's start from the system's hook
    /// timeout (`timing::input_method_read_timeout_ms`); 0 until then, and
    /// where the hook does not read.
    static INPUT_METHOD_QUESTION_LIMIT_MS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };

    /// Timestamp of the most recent low-level input event (button press or
    /// release, key press, or wheel). Used to correlate WinEvent callbacks
    /// with user actions.
    static INPUT_LAST_INPUT_TIMESTAMP: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };

    /// Window handle that received the most recent low-level input event.
    /// Used to scope selection correlation to the same root window: dialog
    /// initialization noise (a Save As dialog pre-selecting its filename box)
    /// correlates in time with the Ctrl+O or click that opened the dialog,
    /// but fires in a root window the user has not acted in yet.
    static INPUT_LAST_INPUT_WINDOW: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };

    /// The modifiers held and the keys that were down when the pointer first
    /// passed the drag threshold after the left button's press: what a drag
    /// start, dispatched at the release, states.
    static INPUT_DRAG_START_KEYS: std::cell::RefCell<super::held_keys::DragStartKeys> =
        const { std::cell::RefCell::new(super::held_keys::DragStartKeys::new()) };

    /// The keys that are down, as the keyboard hook saw them go down and up
    /// (seeded from the keyboard's state when the hook is installed). A
    /// key-down for a key already in it is a press key repeat generated.
    static INPUT_HELD_KEYS: std::cell::RefCell<super::held_keys::HeldKeys> =
        const { std::cell::RefCell::new(super::held_keys::HeldKeys::new()) };

    /// Timestamp of the most recent low-level keyboard event only.
    /// Used specifically for value-change correlation — mouse clicks should not
    /// satisfy value-change correlation because only keyboard input produces
    /// value changes that should be captured.
    static INPUT_LAST_KEYBOARD_TIMESTAMP: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };

    /// Window handle that received the most recent keyboard input.
    /// Used to scope value-change correlation: only correlate value changes
    /// with keyboard events that targeted the SAME window. This prevents
    /// Ctrl+S in Notepad from correlating with value changes in the Save As
    /// dialog that opens afterwards.
    static INPUT_LAST_KEYBOARD_WINDOW: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };

    /// Timestamp of the most recent left click — stamped at WM_LBUTTONDOWN (a
    /// selection can fire between down and up) and again when WM_LBUTTONUP
    /// classifies a click. Focus and selection WinEvents within
    /// `timing::CLICK_REDUNDANCY_MS` of it are suppressed as redundant (DCP-7).
    static INPUT_LAST_CLICK_TIMESTAMP: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Record a low-level input event (a left, right or middle button press, the
/// left button's release, a key press, or wheel) for WinEvent correlation: the
/// timestamp gates whether a subsequent WinEvent is user-caused at all, the
/// window scopes selection correlation to the root the input landed in.
fn note_input(timestamp: u64, window_handle: i64) {
    INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(timestamp));
    INPUT_LAST_INPUT_WINDOW.with(|w| w.set(window_handle));
}

/// True when `timestamp` falls within `window_ms` of the most recent
/// low-level input event of any kind.
fn input_correlated(timestamp: u64, window_ms: u64) -> bool {
    let last_input = INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.get());
    timing::is_correlated(timestamp, last_input, window_ms)
}

// ---------------------------------------------------------------------------
// WindowsCapture struct
// ---------------------------------------------------------------------------

/// Windows-specific implementation of the `CaptureLayer` trait.
///
/// Uses a worker pool architecture: the Input_Thread captures raw event data
/// and dispatches to 3 Accessibility_Worker threads via shortest-queue
/// selection. Workers perform the expensive accessibility queries and produce
/// completed `ActionEvent`s with monotonic sequence numbers.
pub struct WindowsCapture {
    active: Arc<AtomicBool>,
    /// Shared excluded PID. 0 means no exclusion. Read by workers on every event.
    excluded_pid: Arc<AtomicU32>,
    /// Shared included PID (target app). 0 means capture all. Read by input thread on every event.
    included_pid: Arc<AtomicU32>,
    /// The worker pool that manages accessibility worker threads.
    /// Owned by the bridge thread during capture; stored here only for shutdown.
    worker_pool: Option<WorkerPool>,
    /// Bridge thread that receives `RawEvent`s from the input thread and
    /// calls `pool.dispatch()`. Owns the `WorkerPool` during capture.
    bridge_thread: Option<JoinHandle<WorkerPool>>,
    /// The Windows thread ID for the Input_Thread (used to post WM_QUIT and
    /// WM_APP_FLUSH).
    input_thread_id: Option<u32>,
    /// Join handle for the Input_Thread.
    input_thread: Option<JoinHandle<Result<(), CaptureError>>>,
    /// Shared queue of pending commit-barrier requests handed to the
    /// Input_Thread (docent#298). Present only while capturing.
    flush_requests: Option<FlushQueue>,
    /// Retained clone of the pool's drain directory. Present only while
    /// capturing; set and cleared together with `flush_requests`. This is the
    /// flush barrier's **fallback drain** path: when the marker-ordered
    /// barrier cannot report within its bound, the held buffers are drained
    /// through these handles directly, bypassing the input thread.
    pending_directory: Option<PendingDirectory>,
    /// Retained clone of the action channel, for the fallback drain's emitted
    /// actions and sentinel. Present only while capturing.
    action_sender: Option<Sender<ActionEvent>>,
    /// Monotonic source of commit-barrier ids (docent#298).
    barrier_counter: AtomicU64,
}

impl WindowsCapture {
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
            excluded_pid: Arc::new(AtomicU32::new(0)),
            included_pid: Arc::new(AtomicU32::new(0)),
            worker_pool: None,
            bridge_thread: None,
            input_thread_id: None,
            input_thread: None,
            flush_requests: None,
            pending_directory: None,
            action_sender: None,
            barrier_counter: AtomicU64::new(0),
        }
    }
}

impl Default for WindowsCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowsCapture {
    /// Run the pool-wide commit flush barrier in-order and wait (bounded) for it
    /// to complete. Hands a flush request to the Input_Thread and wakes its
    /// message pump, so the flush marker is forwarded onto the **same FIFO
    /// channel** as raw events (ordered behind every raw event dispatched so far,
    /// closing the cross-thread race a command-thread injection would leave
    /// open); the bridge drains every worker's held buffers and the pool emits
    /// the `barrier_complete` sentinel last on the action stream. Returns the
    /// resulting [`BarrierReport`]. The bounded wait is slightly longer than the
    /// pool's own `FLUSH_BARRIER_TIMEOUT` so the pool always reports first.
    ///
    /// On timeout — the input thread is dead or its pump stalled past the bound,
    /// so the marker-ordered path cannot complete — the **fallback drain** runs:
    /// every worker's held buffers are drained directly through the retained
    /// [`PendingDirectory`] (bypassing the stalled input path) and the sentinel
    /// is emitted after them, so the recovered actions still reach the stream
    /// and the frontend's wait still resolves. The report says which happened
    /// ([`BarrierCompletion`]) — a timeout is never shaped like a success. If
    /// the marker-ordered flush later completes anyway (a transient stall), its
    /// drains find the buffers already empty (every drain is idempotent under
    /// the shared lock) and its duplicate sentinel is parked and evicted by the
    /// frontend — no action can be delivered twice.
    ///
    /// A missing input thread, flush queue, drain directory, or action sender —
    /// never in normal operation while capture is active; the four are set and
    /// cleared together — yields a no-op `barrier_id: 0` report.
    ///
    /// Callers ([`commit_barrier`](CaptureLayer::commit_barrier) and
    /// [`stop`](CaptureLayer::stop)) guarantee capture is active before calling.
    fn run_flush_barrier(&self) -> BarrierReport {
        self.run_flush_barrier_with(FLUSH_BARRIER_TIMEOUT + Duration::from_secs(1))
    }

    /// [`run_flush_barrier`](Self::run_flush_barrier) with an explicit bound on
    /// the report wait (for testing the timeout/fallback arm deterministically).
    fn run_flush_barrier_with(&self, report_timeout: Duration) -> BarrierReport {
        let (Some(tid), Some(requests), Some(directory), Some(sender)) = (
            self.input_thread_id,
            self.flush_requests.as_ref(),
            self.pending_directory.as_ref(),
            self.action_sender.as_ref(),
        ) else {
            return BarrierReport {
                barrier_id: 0,
                wedged_workers: 0,
                completion: BarrierCompletion::NotRun,
            };
        };

        let barrier_id = self.barrier_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let (done_tx, done_rx) = std::sync::mpsc::channel::<Vec<usize>>();

        if let Ok(mut queue) = requests.lock() {
            queue.push_back(FlushRequest {
                barrier_id,
                done: done_tx,
            });
        }

        // Fast-fail the wake: a failed post means the marker-ordered path
        // cannot start — the thread is gone (ERROR_INVALID_THREAD_ID) or its
        // queue is full, which is a stalled pump — so branch straight to the
        // fallback drain instead of waiting out a report that cannot come.
        // The queued FlushRequest is left in place deliberately: if a stalled
        // pump later recovers and serves it, the marker-ordered drains find
        // the buffers already empty and the duplicate sentinel is parked and
        // evicted by the frontend — benign by the same idempotence as a late
        // completion.
        let posted = unsafe { PostThreadMessageW(tid, WM_APP_FLUSH, WPARAM(0), LPARAM(0)) };
        if !posted.as_bool() {
            self.warn_and_fallback_drain(
                barrier_id,
                "its wake could not be posted to the input thread",
                directory,
                sender,
            );
            return BarrierReport {
                barrier_id,
                // No acknowledgement data exists on this path; `completion`
                // carries the truth (see BarrierReport's field docs).
                wedged_workers: 0,
                completion: BarrierCompletion::FallbackDrained,
            };
        }

        match done_rx.recv_timeout(report_timeout) {
            Ok(wedged) => BarrierReport {
                barrier_id,
                wedged_workers: wedged.len(),
                completion: BarrierCompletion::MarkerOrdered,
            },
            Err(_) => {
                self.warn_and_fallback_drain(
                    barrier_id,
                    "it reported nothing within the bound",
                    directory,
                    sender,
                );
                BarrierReport {
                    barrier_id,
                    // No acknowledgement data exists on this path; `completion`
                    // carries the truth (see BarrierReport's field docs).
                    wedged_workers: 0,
                    completion: BarrierCompletion::FallbackDrained,
                }
            }
        }
    }

    /// Log a barrier's degraded path and run the fallback drain — shared by
    /// the failed-wake and expired-report arms of
    /// [`run_flush_barrier_with`](Self::run_flush_barrier_with).
    fn warn_and_fallback_drain(
        &self,
        barrier_id: u64,
        why: &str,
        directory: &PendingDirectory,
        sender: &Sender<ActionEvent>,
    ) {
        // Best-effort write, discarded on failure: `eprintln!` panics if the
        // stderr write errors (e.g. a broken pipe), which would turn this
        // documented degraded-but-continuing path into a crash.
        use std::io::Write;
        let _ = writeln!(
            std::io::stderr(),
            "[WindowsCapture] Warning: flush barrier {barrier_id} — {why}; \
             recovering held buffers by fallback drain"
        );
        fallback_drain_and_seal(directory, sender, barrier_id);
    }

    /// Tear down whatever a failed `start()` already spawned, leaving the
    /// capture inactive. Joins only threads that are (or promptly become)
    /// finished — a thread stuck in a blocking startup call is abandoned with a
    /// warning rather than allowed to hang `start()`'s error path.
    fn abort_failed_start(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        self.input_thread_id = None;

        let input_gone = match self.input_thread.take() {
            Some(handle) => bounded_join_or_abandon(handle, FAILED_START_JOIN_TIMEOUT, "input"),
            None => true,
        };

        if let Some(bridge) = self.bridge_thread.take() {
            if input_gone {
                // The input thread is gone, so its bridge sender is dropped and
                // the bridge exits promptly, returning the pool for shutdown.
                match bridge.join() {
                    Ok(mut pool) => pool.shutdown(),
                    Err(_) => eprintln!(
                        "[WindowsCapture] Warning: bridge thread panicked during \
                         failed-start cleanup"
                    ),
                }
            } else {
                // The abandoned input thread still holds the bridge sender, so
                // the bridge cannot exit; abandon it (and the pool it owns) too.
                drop(bridge);
                eprintln!(
                    "[WindowsCapture] Warning: bridge thread and worker pool abandoned \
                     after failed start (reclaimed at process exit)"
                );
            }
        }

        self.flush_requests = None;
        self.pending_directory = None;
        self.action_sender = None;
    }
}

/// Wait up to `timeout` for `handle` to finish, then join it. Returns `true`
/// when the thread was joined, `false` when the deadline passed with the
/// thread still running (the handle is dropped — the thread is abandoned and
/// reclaimed at process exit).
fn bounded_join_or_abandon<T>(handle: JoinHandle<T>, timeout: Duration, name: &str) -> bool {
    let deadline = Instant::now() + timeout;
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            eprintln!(
                "[WindowsCapture] Warning: {name} thread still running after a failed start; \
                 abandoning it (reclaimed at process exit)"
            );
            drop(handle);
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = handle.join();
    true
}

/// Interpret the Input_Thread's startup handshake: the hooks-registered (or
/// failed) report it sends once COM init and hook registration have resolved.
///
/// - A success report → `start()` proceeds.
/// - A failure report → the startup error, verbatim — `start()` fails loudly
///   instead of returning a capture session that cannot capture or flush.
/// - A disconnected channel → the thread exited without reporting (a panic
///   before the report site); surfaced as a platform error.
/// - Timeout → warn and proceed: a pathologically slow COM init is not a
///   definite failure, and failing `start()` while the thread may still come
///   alive would create a zombie session. The same warn-and-proceed posture as
///   the worker-init bound; if the thread does die later, the flush barrier's
///   fallback drain and truthful report cover the session's completeness.
fn interpret_input_ready(
    result: Result<Result<(), CaptureError>, std::sync::mpsc::RecvTimeoutError>,
) -> Result<(), CaptureError> {
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(CaptureError::Platform(
            "input thread exited before reporting hook registration".into(),
        )),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            eprintln!(
                "[WindowsCapture] Warning: input thread did not report hook registration \
                 within {INPUT_READY_TIMEOUT:?}; starting anyway"
            );
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// CaptureLayer trait implementation
// ---------------------------------------------------------------------------

impl CaptureLayer for WindowsCapture {
    fn start(&mut self, sender: Sender<ActionEvent>) -> Result<(), CaptureError> {
        if self.active.load(Ordering::SeqCst) {
            return Ok(());
        }

        self.active.store(true, Ordering::SeqCst);
        hook_diagnostics::reset();
        let excluded_pid = self.excluded_pid.clone();

        // Each worker signals here once it has finished its (possibly cold)
        // UIA/COM init; start() blocks (bounded) until all are ready, so capture
        // is genuinely able to consume events when start() returns — no events
        // dropped during a multi-second cold warm-up on a fresh/headless machine.
        // See worker_loop for why an event dispatched into a not-yet-initialised
        // worker would otherwise be lost on a fast stop().
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();

        // --- Create WorkerPool with WORKER_COUNT workers ---
        let mut pool = WorkerPool::new(WORKER_COUNT, sender.clone(), {
            let excluded_pid = excluded_pid.clone();
            let ready_tx = ready_tx.clone();
            move |index, rx, queue_len, action_sender, pending| {
                let excluded_pid = excluded_pid.clone();
                let ready_tx = ready_tx.clone();
                thread::spawn(move || {
                    let backend = WindowsAccessibilityBackend::new();
                    worker_loop(
                        index,
                        backend,
                        rx,
                        queue_len,
                        action_sender,
                        excluded_pid,
                        pending,
                        Some(ready_tx),
                    );
                })
            }
        });

        // Block (bounded) until every worker is past its cold init and looping.
        // We expect exactly WORKER_COUNT "ready" signals; the generous per-signal
        // timeout is a safety net so a pathological cold init can't hang capture
        // start (it only logs and proceeds).
        for _ in 0..WORKER_COUNT {
            if ready_rx.recv_timeout(WORKER_INIT_TIMEOUT).is_err() {
                eprintln!(
                    "[WindowsCapture] Warning: a worker did not finish init within \
                     {WORKER_INIT_TIMEOUT:?}; starting anyway (early events may be missed)"
                );
                break;
            }
        }

        // The control that holds the keyboard focus as capture starts is
        // looked at now, on the typing worker, so the first key typed into it
        // finds it known (docent#761). Nothing is written.
        pool.look_at_focus();

        // Clone the shared sequence counter for the Input_Thread, which assigns
        // a monotonic id to every raw event (docent#139 reorder buffer).
        let sequence_counter = Arc::clone(pool.sequence_counter());

        // Retain the pool's drain directory and the action channel for the
        // flush barrier's fallback drain (set and cleared together with
        // `flush_requests` — run_flush_barrier treats the set as one).
        self.pending_directory = Some(Arc::clone(pool.pending_directory()));
        self.action_sender = Some(sender.clone());

        // --- Create bridge channel (Input_Thread → bridge → pool) ---
        let (raw_tx, raw_rx) = std::sync::mpsc::channel::<BridgeMessage>();

        // Shared queue of pending commit-barrier requests (docent#298).
        let flush_requests: FlushQueue = Arc::new(Mutex::new(VecDeque::new()));
        self.flush_requests = Some(Arc::clone(&flush_requests));

        // Spawn bridge thread: dispatches raw events, and on a Flush marker runs
        // the pool-wide commit flush barrier and reports the rescued-worker set.
        let bridge_handle = thread::spawn(move || {
            while let Ok(message) = raw_rx.recv() {
                match message {
                    BridgeMessage::Event(event) => pool.dispatch(*event),
                    BridgeMessage::Flush { barrier_id, done } => {
                        let wedged = pool.flush_all(barrier_id, FLUSH_BARRIER_TIMEOUT);
                        let _ = done.send(wedged);
                    }
                    BridgeMessage::TypingEnded => pool.end_typing(),
                    BridgeMessage::UnrecordedKey {
                        layout,
                        key_code,
                        held,
                    } => pool.unrecorded_key(layout, key_code, held),
                }
            }
            // Channel closed (input thread dropped raw_tx) — return pool for shutdown.
            pool
        });
        self.bridge_thread = Some(bridge_handle);

        // --- Spawn Input_Thread ---
        let active = self.active.clone();
        let excluded_pid_for_input = self.excluded_pid.clone();
        let included_pid_for_input = self.included_pid.clone();

        let (tid_tx, tid_rx) = std::sync::mpsc::channel::<u32>();

        // Startup handshake: the input thread reports its COM-init + hook
        // registration outcome here, so a thread that dies right after the tid
        // report fails `start()` loudly instead of leaving a session that can
        // never capture or flush.
        let (hooks_ready_tx, hooks_ready_rx) =
            std::sync::mpsc::channel::<Result<(), CaptureError>>();

        let input_handle = thread::spawn(move || -> Result<(), CaptureError> {
            let thread_id = unsafe { GetCurrentThreadId() };
            // Create this thread's message queue BEFORE reporting the tid. A
            // Win32 thread has no message queue until its first USER32 call,
            // and `PostThreadMessageW` to a queue-less thread fails with
            // ERROR_INVALID_THREAD_ID — so without this, `start()` could return
            // (tid received) while a `commit_barrier`/`stop` flush wake posted
            // right afterwards was silently lost: the flush request would sit
            // unserved and `run_flush_barrier` would time out into a report with
            // no `barrier_complete` sentinel ever emitted. Forcing the queue
            // here closes that lazy-queue race: once `start()` has returned, the
            // queue exists, so a flush wake is deliverable while the
            // Input_Thread lives. (Not a liveness guarantee — a COM-init or
            // hook-registration failure below still exits this thread after the
            // tid report, and a post against the dead thread fails into
            // `run_flush_barrier`'s timeout path.) The documented queue-forcing
            // recipe: PeekMessage, PM_NOREMOVE.
            unsafe {
                let mut msg = MSG::default();
                let _ = PeekMessageW(
                    &mut msg,
                    None,
                    WM_USER as u32,
                    WM_USER as u32,
                    PM_NOREMOVE as u32,
                );
            }
            let _ = tid_tx.send(thread_id);
            input_thread_main(
                active,
                excluded_pid_for_input,
                included_pid_for_input,
                sequence_counter,
                raw_tx,
                flush_requests,
                hooks_ready_tx,
            )
        });
        self.input_thread = Some(input_handle);

        let tid = match tid_rx.recv_timeout(INPUT_TID_TIMEOUT) {
            Ok(tid) => tid,
            Err(_) => {
                self.abort_failed_start();
                return Err(CaptureError::Platform(
                    "input thread did not report its thread ID".into(),
                ));
            }
        };
        self.input_thread_id = Some(tid);

        // Probe the reported queue with a benign WM_NULL. The queue was forced
        // into existence before the tid report (PeekMessageW above), so this
        // converts "start() returned ⇒ a flush wake is deliverable" from
        // comment-held to runtime-checked: a failed post means the thread is
        // already gone, and a session built on it could never flush.
        let probe = unsafe { PostThreadMessageW(tid, WM_NULL as u32, WPARAM(0), LPARAM(0)) };
        if !probe.as_bool() {
            self.abort_failed_start();
            return Err(CaptureError::Platform(
                "input thread message queue unavailable (WM_NULL probe failed)".into(),
            ));
        }

        // Wait (bounded) for the hooks-registered handshake; a definite failure
        // report or a silent exit fails start() loudly — see interpret_input_ready.
        if let Err(e) = interpret_input_ready(hooks_ready_rx.recv_timeout(INPUT_READY_TIMEOUT)) {
            self.abort_failed_start();
            return Err(e);
        }

        Ok(())
    }

    fn stop(&mut self) -> Result<BarrierReport, CaptureError> {
        if !self.active.load(Ordering::SeqCst) {
            return Ok(BarrierReport {
                barrier_id: 0,
                wedged_workers: 0,
                completion: BarrierCompletion::NotRun,
            });
        }

        // Fuse the commit flush barrier INTO stop: while the Input_Thread is
        // still pumping, run the in-order flush so every held completed action
        // drains behind this step's raw events and the `barrier_complete`
        // sentinel is emitted last — THEN deactivate and tear down. A step commit
        // reaches completeness through stop alone (no separate commit_barrier
        // round-trip), closing the delivery race with zero JS-round-trip window
        // and working with self-capture exclusion off. The subsequent shutdown
        // drain is idempotent over the same buffers (whoever drains first empties
        // them; a later drain finds nothing to re-emit).
        let report = self.run_flush_barrier();

        // Signal the Input_Thread to stop.
        self.active.store(false, Ordering::SeqCst);

        // Post WM_QUIT to the Input_Thread to break its message pump.
        if let Some(tid) = self.input_thread_id.take() {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT as u32, WPARAM(0), LPARAM(0));
            }
        }

        // Join the Input_Thread. When it exits, it drops the raw_tx sender,
        // which causes the bridge thread's recv() to return Err and exit.
        //
        // An error or panic from the thread is logged, not returned: the
        // barrier above already ran (by fallback drain if the thread was
        // dead), so the recovered actions and the truthful report exist —
        // aborting teardown here would discard that report and leak the
        // bridge and pool. The startup-failure class of thread error is
        // already surfaced loudly by start()'s handshake.
        if let Some(handle) = self.input_thread.take() {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    eprintln!(
                        "[WindowsCapture] Warning: input thread had exited with an error \
                         ({e}); continuing teardown"
                    );
                }
                Err(_) => {
                    eprintln!(
                        "[WindowsCapture] Warning: input thread panicked; continuing teardown"
                    );
                }
            }
        }

        // Join the bridge thread to get the pool back for shutdown.
        if let Some(bridge) = self.bridge_thread.take() {
            match bridge.join() {
                Ok(mut pool) => {
                    pool.shutdown();
                }
                Err(_) => {
                    eprintln!("[WindowsCapture] Warning: bridge thread panicked during shutdown");
                }
            }
        }

        // Shut down the worker pool if it wasn't moved to the bridge thread
        // (shouldn't happen in normal flow, but handle gracefully).
        if let Some(mut pool) = self.worker_pool.take() {
            pool.shutdown();
        }

        self.flush_requests = None;
        self.pending_directory = None;
        self.action_sender = None;

        // What the mouse hook saw, when it was slow enough to have cost input
        // (docent#741); the counts stay readable through
        // `hook_diagnostics::snapshot` until the next start.
        if let Some(line) = hook_diagnostics::snapshot().report() {
            eprintln!("{line}");
        }

        Ok(report)
    }

    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    fn check_permissions(&self) -> PermissionStatus {
        PermissionStatus {
            granted: true,
            message: None,
        }
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        list_visible_windows()
    }

    fn set_excluded_pid(&mut self, pid: Option<u32>) {
        self.excluded_pid.store(pid.unwrap_or(0), Ordering::SeqCst);
    }

    fn set_included_pid(&mut self, pid: Option<u32>) {
        self.included_pid.store(pid.unwrap_or(0), Ordering::SeqCst);
    }

    fn commit_barrier(&self) -> Result<BarrierReport, CaptureError> {
        // Not capturing → nothing is buffered; report a no-op.
        if !self.active.load(Ordering::SeqCst) {
            return Ok(BarrierReport {
                barrier_id: 0,
                wedged_workers: 0,
                completion: BarrierCompletion::NotRun,
            });
        }
        Ok(self.run_flush_barrier())
    }
}

// ---------------------------------------------------------------------------
// Input_Thread entry point
// ---------------------------------------------------------------------------

/// The Input_Thread runs the platform's input observation loop (message pump +
/// hooks). It captures raw event data and dispatches `RawEvent`s to the
/// worker pool via a channel. It makes no accessibility call: the mouse hook
/// asks the pre-capture describers for a clicked element and waits for at
/// most the budget (DCP-1).
///
/// # Arguments
///
/// * `active` — Shared flag; the thread exits when this becomes `false`.
/// * `excluded_pid` — PID to exclude from capture (self-capture filtering).
/// * `sequence_counter` — Shared atomic counter for assigning monotonic
///   sequence IDs to each `RawEvent`.
/// * `raw_tx` — Channel sender for dispatching `RawEvent`s to the bridge
///   thread, which forwards them to `WorkerPool::dispatch()`.
/// * `hooks_ready` — Startup handshake back to `start()`: `Ok(())` once every
///   hook is registered and the pump is about to run, or the startup error —
///   sent before this function returns it — so `start()` fails loudly instead
///   of returning a session whose input thread is already dead.
///
/// # Requirements
///
/// 1.1–1.5, 10.1–10.4
fn input_thread_main(
    active: Arc<AtomicBool>,
    excluded_pid: Arc<AtomicU32>,
    included_pid: Arc<AtomicU32>,
    sequence_counter: Arc<AtomicU64>,
    raw_tx: std::sync::mpsc::Sender<BridgeMessage>,
    flush_requests: FlushQueue,
    hooks_ready: std::sync::mpsc::Sender<Result<(), CaptureError>>,
) -> Result<(), CaptureError> {
    // --- COM initialisation (STA, needed for the message pump) ---
    unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_APARTMENTTHREADED as u32).ok() {
            let err = CaptureError::ComInit(e.to_string());
            let _ = hooks_ready.send(Err(err.clone()));
            return Err(err);
        }
    }

    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _com_guard = ComGuard;

    // --- DPI awareness ---
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    // --- Store thread-local state for hook callbacks ---
    INPUT_RAW_SENDER.with(|s| *s.borrow_mut() = Some(raw_tx));
    INPUT_SEQUENCE_COUNTER.with(|c| *c.borrow_mut() = Some(sequence_counter));
    CONTEXTS_INTRODUCED_AT.clear();
    INPUT_ACTIVE.with(|a| *a.borrow_mut() = Some(active.clone()));
    INPUT_EXCLUDED_PID.with(|p| *p.borrow_mut() = Some(excluded_pid));
    INPUT_INCLUDED_PID.with(|p| *p.borrow_mut() = Some(included_pid));
    INPUT_FLUSH_REQUESTS.with(|q| *q.borrow_mut() = Some(flush_requests));

    // Start the click pre-capture's describers (DCP-1). Without them a click
    // is dispatched with no element and its worker describes it (DCP-13).
    let pre_capture = start_click_pre_capture();
    INPUT_PRE_CAPTURE
        .with(|p| *p.borrow_mut() = SessionPreCapture::started(pre_capture, Instant::now()));

    // Initialize foreground PID with the current foreground window.
    let fg_hwnd = unsafe { GetForegroundWindow() };
    if !fg_hwnd.0.is_null() {
        let mut fg_pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(fg_hwnd, Some(&mut fg_pid)) };
        INPUT_FOREGROUND_PID.with(|p| p.set(fg_pid));
    }

    // --- Register event hooks ---
    let mut win_hooks: Vec<HWINEVENTHOOK> = Vec::new();
    let mut ll_hooks: Vec<HHOOK> = Vec::new();

    let hook_result = (|| -> Result<(), CaptureError> {
        // WinEvent hooks for window lifecycle and accessibility events.
        for (event_min, event_max) in [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY),
            (EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS),
            (EVENT_OBJECT_VALUECHANGE, EVENT_OBJECT_VALUECHANGE),
            (EVENT_OBJECT_SELECTION, EVENT_OBJECT_SELECTION),
        ] {
            let hook = unsafe {
                SetWinEventHook(
                    event_min as u32,
                    event_max as u32,
                    None,
                    Some(input_win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT as u32,
                )
            };
            if hook.0.is_null() {
                return Err(CaptureError::HookFailed(format!(
                    "SetWinEventHook failed for events {event_min}–{event_max}"
                )));
            }
            win_hooks.push(hook);
        }

        // Low-level mouse hook.
        let mouse_hook =
            unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(input_mouse_ll_proc), None, 0) };
        if mouse_hook.0.is_null() {
            let e = Error::from_thread();
            return Err(CaptureError::HookFailed(format!("WH_MOUSE_LL: {e}")));
        }
        ll_hooks.push(mouse_hook);

        // Low-level keyboard hook.
        let kb_hook =
            unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(input_keyboard_ll_proc), None, 0) };
        if kb_hook.0.is_null() {
            let e = Error::from_thread();
            return Err(CaptureError::HookFailed(format!("WH_KEYBOARD_LL: {e}")));
        }
        ll_hooks.push(kb_hook);
        // A key already held now is a held key at its next key-down.
        INPUT_HELD_KEYS.with(|held| {
            *held.borrow_mut() = super::held_keys::HeldKeys::seeded(|vk| {
                // SAFETY: GetAsyncKeyState takes any virtual-key code and
                // reads the keyboard's state; it has no other precondition.
                unsafe { GetAsyncKeyState(vk as i32) < 0 }
            });
        });

        Ok(())
    })();

    if let Err(e) = hook_result {
        for h in &win_hooks {
            unsafe {
                let _ = UnhookWinEvent(*h);
            }
        }
        for h in &ll_hooks {
            unsafe {
                let _ = UnhookWindowsHookEx(*h);
            }
        }
        // Clean up thread-local state.
        INPUT_RAW_SENDER.with(|s| *s.borrow_mut() = None);
        INPUT_SEQUENCE_COUNTER.with(|c| *c.borrow_mut() = None);
        INPUT_ACTIVE.with(|a| *a.borrow_mut() = None);
        INPUT_EXCLUDED_PID.with(|p| *p.borrow_mut() = None);
        INPUT_INCLUDED_PID.with(|p| *p.borrow_mut() = None);
        INPUT_FLUSH_REQUESTS.with(|q| *q.borrow_mut() = None);
        INPUT_PID_CACHE.with(|c| c.borrow_mut().clear());
        end_click_pre_capture();
        INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(0));
        INPUT_LAST_INPUT_WINDOW.with(|w| w.set(0));
        INPUT_LAST_KEYBOARD_TIMESTAMP.with(|t| t.set(0));
        let _ = hooks_ready.send(Err(e.clone()));
        return Err(e);
    }

    // Startup handshake: every hook is registered and the pump is about to
    // run — report readiness so start() can return a live session.
    let _ = hooks_ready.send(Ok(()));

    // --- Message pump ---
    unsafe {
        let mut msg = MSG::default();
        while active.load(Ordering::SeqCst) {
            let ret = GetMessageW(&mut msg, None, 0, 0);
            if !ret.as_bool() {
                break; // WM_QUIT or error
            }
            // Commit flush barrier (docent#298): a thread message (no window) —
            // handle it inline rather than dispatching, then continue pumping.
            if msg.hwnd.0.is_null() && msg.message == WM_APP_FLUSH {
                input_forward_flush();
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    // --- Cleanup: unhook all hooks ---
    for h in &win_hooks {
        unsafe {
            let _ = UnhookWinEvent(*h);
        }
    }
    for h in &ll_hooks {
        unsafe {
            let _ = UnhookWindowsHookEx(*h);
        }
    }

    // --- Clean up thread-local state ---
    INPUT_RAW_SENDER.with(|s| *s.borrow_mut() = None);
    INPUT_SEQUENCE_COUNTER.with(|c| *c.borrow_mut() = None);
    INPUT_ACTIVE.with(|a| *a.borrow_mut() = None);
    INPUT_EXCLUDED_PID.with(|p| *p.borrow_mut() = None);
    INPUT_INCLUDED_PID.with(|p| *p.borrow_mut() = None);
    INPUT_FLUSH_REQUESTS.with(|q| *q.borrow_mut() = None);
    INPUT_FOREGROUND_PID.with(|p| p.set(0));
    INPUT_CONTEXTS.with(|c| *c.borrow_mut() = Default::default());
    CONTEXTS_INTRODUCED_AT.clear();
    INPUT_MOUSE_DOWN_POS.with(|p| p.set(None));
    INPUT_OPENED_WINDOWS.with(|s| s.borrow_mut().clear());
    INPUT_PID_CACHE.with(|c| c.borrow_mut().clear());
    end_click_pre_capture();
    INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(0));
    INPUT_LAST_INPUT_WINDOW.with(|w| w.set(0));
    INPUT_LAST_KEYBOARD_TIMESTAMP.with(|t| t.set(0));
    INPUT_LAST_KEYBOARD_WINDOW.with(|w| w.set(0));
    INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.set(0));

    Ok(())
}

// ---------------------------------------------------------------------------
// Input_Thread helper: dispatch a RawEvent
// ---------------------------------------------------------------------------

/// The focus epoch, in two halves (`RawEvent::focus_epoch`): the low 32 bits
/// count the focus and foreground changes programs reported to the
/// Input_Thread, the high 32 bits the mouse-downs and focus-moving keys the
/// hooks saw (each may move the focus without the program reporting it).
/// Every raw event is stamped with the epoch of its dispatch, and a worker
/// reads the current one when it describes the focused element for a
/// keystroke or value change (`AccessibilityBackend::focus_epoch`). Starts at
/// 1; 0 means "not counted". Process-wide, so the workers read it directly.
static FOCUS_EPOCH: AtomicU64 = AtomicU64::new(1);

/// The number of the latest focus event the Input_Thread dispatched
/// (`AccessibilityBackend::focus_events_dispatched`); `0` before the first.
/// Process-wide, so the workers read it directly.
static FOCUS_EVENTS_DISPATCHED: AtomicU64 = AtomicU64::new(0);

/// The number of the event that introduced each context of the capture
/// session (`AccessibilityBackend::context_introduced_before`, docent#817).
/// Noted on the Input_Thread as it dispatches; process-wide, so the workers
/// read it directly. Cleared when the Input_Thread starts and stops.
static CONTEXTS_INTRODUCED_AT: super::worker_pool::ContextsIntroducedAt =
    super::worker_pool::ContextsIntroducedAt::new();

/// The key presses the Input_Thread dispatched, numbered per window
/// (`AccessibilityBackend::keys_dispatched`, docent#761). Process-wide, so the
/// workers read it directly.
static KEYS_DISPATCHED: super::worker_pool::KeyNumbers = super::worker_pool::KeyNumbers::new();

/// Count a focus or foreground change a program reported (the low half of
/// the epoch). One atomic add.
fn focus_epoch_advance() {
    FOCUS_EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// Count something the person did that can move the focus: a mouse-down or a
/// focus-moving key (the high half of the epoch). One atomic add: safe on the
/// hooks.
fn focus_epoch_advance_by_person() {
    FOCUS_EPOCH.fetch_add(
        super::worker_pool::FOCUS_EPOCH_PERSON_STEP,
        Ordering::SeqCst,
    );
}

/// Dispatch a `RawEvent` to the bridge thread, after the foreground event
/// that introduces its window's context where the session has not introduced
/// it (DCP-7, `ContextIntroductions`). Called from hook callbacks on the
/// Input_Thread.
fn input_dispatch_raw_event(event: RawEvent) {
    let root = input_root_of(event.window_handle);
    let foreground_root = input_root_of(unsafe { GetForegroundWindow() }.0 as i64);
    INPUT_CONTEXTS.with(|c| {
        super::worker_pool::dispatch_introducing(
            &mut c.borrow_mut(),
            &CONTEXTS_INTRODUCED_AT,
            event,
            root,
            foreground_root,
            |action| {
                let mut process_id: u32 = 0;
                unsafe { GetWindowThreadProcessId(HWND(root as *mut _), Some(&mut process_id)) };
                super::worker_pool::switch_before_event(
                    action,
                    root,
                    foreground_root,
                    process_id,
                    input_window_title(HWND(root as *mut _)),
                )
            },
            input_send_raw_event,
        )
    });
}

/// The title of `hwnd` as the system holds it, read on the Input_Thread with
/// a foreground event, while the window is there (docent#801). It sends the
/// window no message, so a window whose thread does not answer cannot hold
/// the hooks. Read into the 512-unit buffer [`get_window_title`] uses;
/// `None` when the window has no title or is gone.
fn input_window_title(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 512];
    let len = unsafe { InternalGetWindowText(hwnd, PWSTR(buf.as_mut_ptr()), buf.len() as i32) };
    (len > 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

/// The top-level (`GA_ROOT`) window of `window_handle`: the handle itself
/// when it has none, `0` for no window.
fn input_root_of(window_handle: i64) -> i64 {
    if window_handle == 0 {
        return 0;
    }
    let root = unsafe { GetAncestor(HWND(window_handle as *mut _), GA_ROOT as u32) };
    if root.0.is_null() {
        window_handle
    } else {
        root.0 as i64
    }
}

/// Assign a sequence ID and send a `RawEvent` to the bridge thread; the ID
/// assigned.
fn input_send_raw_event(mut event: RawEvent) -> u64 {
    event.focus_epoch = FOCUS_EPOCH.load(Ordering::SeqCst);
    // Assign monotonic sequence ID.
    let seq_id = INPUT_SEQUENCE_COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .map(|counter| counter.fetch_add(1, Ordering::SeqCst) + 1)
            .unwrap_or(0)
    });
    event.sequence_id = seq_id;
    // The keys that are down at this event, for the actions that state them.
    INPUT_HELD_KEYS.with(|held| held.borrow_mut().stamp(&mut event));

    // Send to bridge thread.
    INPUT_RAW_SENDER.with(|s| {
        if let Some(sender) = s.borrow().as_ref() {
            let _ = sender.send(BridgeMessage::Event(Box::new(event)));
        }
    });
    seq_id
}

/// What the Input_Thread does with a window event the scope filters drop:
/// nothing is written for it, and a dropped window that comes to the front
/// (`EVENT_SYSTEM_FOREGROUND`) has taken the keyboard from the field typed
/// into, so the pool is told the typing has ended. Without this the field's
/// `type` waited for the next key or click in a recorded window, and text
/// typed last in a step was not in the step when the person went to the
/// recorder's panel to complete it (docent#768).
///
/// A pointer press on a dropped window is no such end by itself: a window
/// that takes no focus (an on-screen keyboard, the emoji panel) leaves the
/// person typing in the field. Any other window event of a dropped window
/// tells the pool nothing.
fn input_dropped_window_event(event: u32) {
    if event != EVENT_SYSTEM_FOREGROUND as u32 {
        return;
    }
    INPUT_RAW_SENDER.with(|s| {
        if let Some(sender) = s.borrow().as_ref() {
            let _ = sender.send(BridgeMessage::TypingEnded);
        }
    });
}

/// Tell the pool of a key that went down in a window the recording keeps
/// nothing of ([`BridgeMessage::UnrecordedKey`]). The key can be a dead key,
/// or take a waiting accent away, like any other, and Windows keeps one
/// waiting accent a layout whichever window the keys go to: the typing worker
/// takes the key into the accents that wait, so the next key recorded is
/// named right. Nothing is written or logged for the key, and the worker
/// keeps nothing of it but what waits afterwards.
///
/// Called on the keyboard hook: one send, like a key's own.
fn input_send_unrecorded_key(layout: i64, key_code: u32, held: super::key_value::Held) {
    INPUT_RAW_SENDER.with(|s| {
        if let Some(sender) = s.borrow().as_ref() {
            let _ = sender.send(BridgeMessage::UnrecordedKey {
                layout,
                key_code,
                held: held.index() as u8,
            });
        }
    });
}

/// Forward a pending commit-barrier request (docent#298) onto the Input_Thread's
/// own bridge sender. Called from the message pump on `WM_APP_FLUSH`, so the
/// resulting [`BridgeMessage::Flush`] is FIFO-ordered behind every raw event the
/// input thread has already dispatched for the step being committed.
fn input_forward_flush() {
    let request =
        INPUT_FLUSH_REQUESTS.with(|q| q.borrow().as_ref().and_then(|q| q.lock().ok()?.pop_front()));
    if let Some(FlushRequest { barrier_id, done }) = request {
        INPUT_RAW_SENDER.with(|s| {
            if let Some(sender) = s.borrow().as_ref() {
                let _ = sender.send(BridgeMessage::Flush { barrier_id, done });
            }
        });
    }
}

/// The click pre-capture: a screen point in, the element there out (`None`
/// when nothing could be described).
type ClickPreCapture = PreCapture<(i32, i32), Option<super::ElementDescription>>;

/// A pre-capture describer's accessibility client, in its own multithreaded
/// apartment (the profile the worker's `init` describes: a client thread
/// that owns no window and pumps no messages). Fields drop in order: the
/// client before the apartment is left.
struct PreCaptureClient {
    uia: Option<IUIAutomation>,
    _apartment: Option<ComApartment>,
}

/// Leaves the COM apartment its thread entered, when dropped.
struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// How long start waits for the first pre-capture describer to build its
/// accessibility client before going on without waiting further.
const PRE_CAPTURE_READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Read the user's low-level hook timeout setting
/// (`HKCU\Control Panel\Desktop\LowLevelHooksTimeout`), a `REG_DWORD` or a
/// `REG_SZ`; [`timing::HookTimeoutSetting::Absent`] when it is neither or
/// cannot be read.
fn read_hook_timeout_setting() -> timing::HookTimeoutSetting {
    let key = windows_core::w!("Control Panel\\Desktop");
    let value = windows_core::w!("LowLevelHooksTimeout");
    let mut number: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key,
            value,
            RRF_RT_REG_DWORD as u32,
            None,
            Some((&mut number as *mut u32).cast()),
            Some(&mut size),
        )
    };
    if status.0 == 0 {
        return timing::HookTimeoutSetting::Number(number);
    }
    let mut text = [0u16; 64];
    let mut size = std::mem::size_of_val(&text) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key,
            value,
            RRF_RT_REG_SZ as u32,
            None,
            Some(text.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status.0 == 0 {
        let len = text.iter().position(|&c| c == 0).unwrap_or(text.len());
        return timing::HookTimeoutSetting::Text(String::from_utf16_lossy(&text[..len]));
    }
    timing::HookTimeoutSetting::Absent
}

/// Start the click pre-capture's describers (DCP-1) with the session's
/// budget. An error when no describer can be started (the process's
/// describers at the cap).
fn spawn_click_pre_capture() -> std::io::Result<ClickPreCapture> {
    PreCapture::spawn(
        "docent-pre-capture",
        INPUT_PRE_CAPTURE_BUDGET.with(|b| b.get()),
        &PROCESS_DESCRIBERS,
        || unsafe {
            let apartment = CoInitializeEx(None, COINIT_MULTITHREADED as u32)
                .ok()
                .ok()
                .map(|()| ComApartment);
            let uia = apartment.as_ref().and_then(|_| {
                CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_ALL as u32).ok()
            });
            Built {
                client_built: uia.is_some(),
                state: PreCaptureClient {
                    uia,
                    _apartment: apartment,
                },
            }
        },
        |client: &PreCaptureClient, (x, y): (i32, i32)| unsafe {
            let uia = client.uia.as_ref()?;
            let element = uia.ElementFromPoint(POINT { x, y }).ok()?;
            // Unmeasured by design: the hook waits on this call, so the
            // FindAll-based match measurement is off-limits here. Locator
            // entries carry values only; the pair ships absent (= not
            // measured).
            uia_element_to_description_unmeasured(uia, &element)
        },
    )
}

/// Set the session's pre-capture budget and the time limit of the keyboard
/// hook's questions to an input-method window from the system's low-level
/// hook timeout, start the click pre-capture's describers (DCP-1), and wait, for
/// at most `PRE_CAPTURE_READY_TIMEOUT`, for the first to build its
/// accessibility client, so the first click is pre-captured. `None`, logged,
/// when no describer can be started (a later click tries again); a warning
/// when the wait runs out or the client was not built (the clicks the
/// pre-capture cannot describe are described by their workers, DCP-13).
fn start_click_pre_capture() -> Option<ClickPreCapture> {
    let hook_timeout_ms = timing::hook_timeout_ms(&read_hook_timeout_setting());
    let budget_ms = timing::pre_capture_budget_ms(hook_timeout_ms);
    let question_limit_ms = timing::input_method_read_timeout_ms(hook_timeout_ms);
    hook_diagnostics::session_bounds(hook_timeout_ms, budget_ms, question_limit_ms);
    INPUT_PRE_CAPTURE_BUDGET.with(|b| b.set(Duration::from_millis(budget_ms)));
    INPUT_METHOD_QUESTION_LIMIT_MS.with(|t| t.set(question_limit_ms as u32));
    match spawn_click_pre_capture() {
        Ok(pre_capture) => {
            match pre_capture.wait_ready(PRE_CAPTURE_READY_TIMEOUT) {
                Readiness::Built => {}
                Readiness::ClientNotBuilt => eprintln!(
                    "[WindowsCapture] Warning: the click pre-capture's accessibility client \
                     could not be built; clicks are described by the workers"
                ),
                Readiness::NotReady => eprintln!(
                    "[WindowsCapture] Warning: the click pre-capture was not ready within \
                     {PRE_CAPTURE_READY_TIMEOUT:?}; clicks before it is are described by \
                     the workers"
                ),
            }
            Some(pre_capture)
        }
        Err(e) => {
            eprintln!(
                "[WindowsCapture] Warning: the click pre-capture did not start ({e}); \
                 clicks are described by the workers until a later click starts it"
            );
            None
        }
    }
}

/// End the click pre-capture as the input thread ends: store its outcome
/// counts for the stop report, then drop it. Its describers are never
/// joined; each ends once its last call returns.
fn end_click_pre_capture() {
    if let Some(pre_capture) = INPUT_PRE_CAPTURE.with(|p| p.borrow_mut().take()) {
        hook_diagnostics::pre_capture_outcomes(pre_capture.counts());
    }
}

/// Pre-capture the element at the given screen coordinates, in the process
/// `pid` (DCP-1): ask a pre-capture describer and wait for at most the
/// budget. `None` when the answer did not come in time, when that process
/// still holds a describer, when no describer is free, or when nothing could
/// be described; the click is dispatched either way, and its worker describes
/// it when this gave no element. Called at left mouse-up on a non-drag click
/// and at right/middle button-down, so an answer describes the element while
/// the target window is still alive. The wait dispatches no message, so no
/// hook call runs inside it.
fn input_pre_capture_element(pid: u32, x: i32, y: i32) -> Option<super::ElementDescription> {
    INPUT_PRE_CAPTURE.with(|p| {
        let mut session = p.borrow_mut();
        // A session whose pre-capture could not be started tries again here,
        // without waiting for the new describer: this ask waits for it within
        // the budget.
        let pre = session.for_click(Instant::now(), || spawn_click_pre_capture().ok());
        pre_capture_click(pre, u64::from(pid), (x, y))
    })
}

/// Check if the Input_Thread is active.
fn input_is_active() -> bool {
    INPUT_ACTIVE.with(|a| {
        a.borrow()
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    })
}

/// Read the current excluded PID from the Input_Thread's shared atomic.
fn input_get_excluded_pid() -> Option<u32> {
    INPUT_EXCLUDED_PID.with(|p| {
        p.borrow().as_ref().and_then(|arc| {
            let val = arc.load(Ordering::SeqCst);
            if val == 0 {
                None
            } else {
                Some(val)
            }
        })
    })
}

/// Read the current included PID (target app) from the Input_Thread's shared atomic.
/// Returns None if no target is set (capture all).
fn input_get_included_pid() -> Option<u32> {
    INPUT_INCLUDED_PID.with(|p| {
        p.borrow().as_ref().and_then(|arc| {
            let val = arc.load(Ordering::SeqCst);
            if val == 0 {
                None
            } else {
                Some(val)
            }
        })
    })
}

/// The scope filters' decision (desktop capture principles, DCP-5) as pure
/// logic: which filter decides an event, in what order, and the per-process
/// verdict the self-capture grounds are judged under.
///
/// Returns `true` if the event should be **kept**. The decision opens by
/// delegating to the platform-agnostic base rule
/// ([`should_keep_event`](super::scroll::should_keep_event)), which carries the
/// resolvable-window skip and the excluded process's own events, so neither is
/// restated here. Everything else the decision reaches outside itself is
/// injected, which is what makes it exercisable without a live capture session:
/// `cached_verdict` / `record_verdict` read and write the per-process verdict
/// cache; `tree_and_name_keep` re-applies that base rule and layers Docent's
/// process tree and the executable-name recognition on top
/// ([`windows_should_keep_event`]); and `owned_by_excluded` answers whether
/// this event's window is owned by an excluded process's window
/// ([`is_owned_by_excluded`], the system dialogs Docent itself opens). No
/// injected lookup runs once an earlier filter has decided the event, and the
/// verdict cache is touched only through the two accessors — a thread-local
/// `RefCell` store therefore stays borrowed only across each accessor call,
/// never across a Windows lookup.
///
/// Two properties the ordering carries, both doctrine:
///
/// - the excluded process's own events are dropped by the base rule above the
///   target filter, so selecting that process as the target still excludes it.
///   The other self-capture grounds sit below the target filter instead, which
///   is what spares an out-of-target process their lookups entirely;
/// - the self-capture verdict is **per-process**: the first event from a
///   process to reach those grounds pays for the lookups that verdict needs
///   (the owner walk is spared when the tree and name grounds already exclude
///   the process), the answer is recorded under its PID, and every later event
///   from that process — from any of its windows — reads the recorded verdict.
///
/// Extracted as pure logic the runtime path consumes (the discipline the
/// contributing guide states for JavaScript, applied here) so those semantics
/// are unit-testable without standing up the Win32 hook machinery.
fn scope_filter_decision(
    event_pid: u32,
    included_pid: Option<u32>,
    excluded_pid: Option<u32>,
    cached_verdict: impl FnOnce(u32) -> Option<bool>,
    record_verdict: impl FnOnce(u32, bool),
    tree_and_name_keep: impl FnOnce(u32, Option<u32>) -> bool,
    owned_by_excluded: impl FnOnce(u32) -> bool,
) -> bool {
    // The base rule, shared with every platform: an event whose window can no
    // longer be resolved, and the excluded process's own events, are dropped —
    // the latter before the target filter is consulted at all, which is what
    // makes the exclusion outrank a target naming that same process.
    if !super::scroll::should_keep_event(event_pid, excluded_pid) {
        return false;
    }

    // Target application: with a target set, only its process is captured.
    if let Some(incl) = included_pid {
        if event_pid != incl {
            return false;
        }
    }

    // The remaining self-capture grounds apply only while the exclusion is on.
    let Some(excl) = excluded_pid else {
        return true;
    };

    // Per-process, first-event-wins: every window of a process shares whichever
    // verdict its first event produced.
    if let Some(cached) = cached_verdict(event_pid) {
        return cached;
    }
    let keep = if tree_and_name_keep(event_pid, excluded_pid) {
        !owned_by_excluded(excl)
    } else {
        false
    };
    record_verdict(event_pid, keep);
    keep
}

/// Apply the scope filters to an event on the Input_Thread: reads the target
/// application from the thread's shared atomic, backs the per-process verdict
/// cache with its thread-local map, and supplies the real Windows lookups to
/// [`scope_filter_decision`]. The cache spares repeated
/// `CreateToolhelp32Snapshot` walks for a process already judged, and is
/// cleared with the rest of the thread's state when capture stops. Each
/// accessor borrows the map for its own call only, so no borrow is held across
/// a Windows lookup.
fn input_should_keep_event_cached(event_pid: u32, excluded_pid: Option<u32>, hwnd: HWND) -> bool {
    scope_filter_decision(
        event_pid,
        input_get_included_pid(),
        excluded_pid,
        |pid| INPUT_PID_CACHE.with(|cache| cache.borrow().get(&pid).copied()),
        |pid, keep| {
            INPUT_PID_CACHE.with(|cache| cache.borrow_mut().insert(pid, keep));
        },
        windows_should_keep_event,
        |excl| unsafe { is_owned_by_excluded(hwnd, excl) },
    )
}

// ---------------------------------------------------------------------------
// Input_Thread WinEvent callback
// ---------------------------------------------------------------------------

/// WinEvent callback for the Input_Thread: times each call
/// (`hook_diagnostics`; the mouse hook's calls wait behind it) around
/// [`input_win_event_handle`].
unsafe extern "system" fn input_win_event_proc(
    hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    id_event_thread: u32,
    dwms_event_time: u32,
) {
    let started = Instant::now();
    input_win_event_handle(
        hook,
        event,
        hwnd,
        id_object,
        id_child,
        id_event_thread,
        dwms_event_time,
    );
    hook_diagnostics::win_event_returned(started.elapsed());
}

/// What the WinEvent callback does with one event. Captures raw event data
/// and dispatches `RawEvent`s. Performs zero accessibility queries.
unsafe fn input_win_event_handle(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _id_event_thread: u32,
    _dwms_event_time: u32,
) {
    if !input_is_active() {
        return;
    }

    // Count every focus and foreground change, before any filter below: a
    // change into an excluded or background window still means the focused
    // element is no longer the one earlier keystrokes went to.
    if event == EVENT_OBJECT_FOCUS as u32 || event == EVENT_SYSTEM_FOREGROUND as u32 {
        focus_epoch_advance();
    }
    // Beside the count: a focus change that names a part of a window is
    // noted for that window, so a keystroke into the window tells a worker
    // that what the window holds may have changed.
    if event == EVENT_OBJECT_FOCUS as u32
        && super::worker_pool::focus_names_a_part(i64::from(id_object), i64::from(id_child))
    {
        INPUT_PART_FOCUS.with(|note| note.borrow_mut().add(hwnd.0 as i64));
    }

    let mut process_id: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    let excluded = input_get_excluded_pid();

    // PID exclusion check (cached — covers both PID tree and ownership).
    if !input_should_keep_event_cached(process_id, excluded, hwnd) {
        input_dropped_window_event(event);
        return;
    }

    // Foreground PID tracking and filtering.
    if event == EVENT_SYSTEM_FOREGROUND as u32 {
        INPUT_FOREGROUND_PID.with(|p| p.set(process_id));
    } else {
        let fg_pid = INPUT_FOREGROUND_PID.with(|p| p.get());
        if fg_pid != 0 && process_id != fg_pid {
            return;
        }
    }

    let timestamp = current_timestamp_ms();
    let window_handle = hwnd.0 as i64;

    match event {
        x if x == EVENT_SYSTEM_FOREGROUND as u32 => {
            // Only dispatch context_switch if correlated with recent user input.
            // Programmatic foreground changes (notifications, minimize/restore by
            // other apps) will not have a preceding input event within the window.
            if !input_correlated(timestamp, timing::FOREGROUND_CORRELATION_MS) {
                return; // Programmatic — suppress.
            }

            // Resolve root window for deduplication comparison.
            let root = GetAncestor(hwnd, GA_ROOT as u32);
            let root_handle = if root.0.is_null() {
                window_handle
            } else {
                root.0 as i64
            };

            // Deduplicate: if the click-based handler already dispatched a
            // foreground event for this same root window, skip.
            if !INPUT_CONTEXTS.with(|c| c.borrow_mut().activation_switches(root_handle)) {
                return; // Already dispatched by click handler.
            }

            input_dispatch_raw_event(RawEvent {
                event_type: RawEventType::Foreground,
                sequence_id: 0, // assigned by input_dispatch_raw_event
                timestamp,
                screen_x: 0,
                screen_y: 0,
                window_handle,
                process_id,
                key_code: 0,
                modifiers: (false, false, false, false),
                scroll_delta: 0.0,
                callback_params: [id_object as i64, id_child as i64, 0, 0],
                key_value: 0,
                keyboard_layout: 0,
                caps_lock: false,
                pre_captured_element: None,
                focus_epoch: 0,
                held: Vec::new(),
                window_title: input_window_title(hwnd),
            });
        }

        x if x == EVENT_OBJECT_CREATE as u32
            && id_object == OBJID_WINDOW
            && id_child == CHILDID_SELF =>
        {
            if !IsWindow(Some(hwnd)).as_bool() {
                return;
            }
            // Only emit for top-level visible windows.
            if !IsWindowVisible(hwnd).as_bool() {
                return;
            }
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if style & WS_CHILD as u32 != 0 {
                return;
            }
            let parent = GetParent(hwnd);
            if !parent.0.is_null() {
                return;
            }
            // Only dispatch if correlated with recent user input.
            if !input_correlated(timestamp, timing::WINDOW_LIFECYCLE_CORRELATION_MS) {
                return; // Programmatic window creation — suppress.
            }
            input_dispatch_raw_event(RawEvent {
                event_type: RawEventType::WindowCreate,
                sequence_id: 0,
                timestamp,
                screen_x: 0,
                screen_y: 0,
                window_handle,
                process_id,
                key_code: 0,
                modifiers: (false, false, false, false),
                scroll_delta: 0.0,
                callback_params: [id_object as i64, id_child as i64, 0, 0],
                key_value: 0,
                keyboard_layout: 0,
                caps_lock: false,
                pre_captured_element: None,
                focus_epoch: 0,
                held: Vec::new(),
                window_title: None,
            });
            // Track this window so we only emit context_close for it.
            INPUT_OPENED_WINDOWS.with(|s| s.borrow_mut().insert(window_handle));
        }

        x if x == EVENT_OBJECT_DESTROY as u32
            && id_object == OBJID_WINDOW
            && id_child == CHILDID_SELF =>
        {
            // Only emit context_close for true top-level windows.
            // Skip child windows, owned windows, and windows without
            // titles to avoid flooding when dialogs with many
            // sub-windows are dismissed.
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if style & WS_CHILD as u32 != 0 {
                // Child window — skip.
            } else {
                let parent = GetParent(hwnd);
                let has_parent = !parent.0.is_null();
                // Check if the window is owned by another window.
                let owner = GetWindow(hwnd, GW_OWNER as u32);
                let has_owner = !owner.0.is_null();
                // Check if the window has a title (titleless windows
                // are typically internal framework windows).
                let title = get_window_title(hwnd);
                // Check if this window's root ancestor is the current
                // foreground window — if so, it's an internal sub-window
                // (e.g. file dialog folder view refreshing), not a
                // standalone window the user closed.
                let fg = GetForegroundWindow();
                let root = GetAncestor(hwnd, GA_ROOT as u32);
                let is_sub_of_foreground = !fg.0.is_null() && !root.0.is_null() && root == fg;

                if !has_parent && !has_owner && !title.is_empty() && !is_sub_of_foreground {
                    // Only emit context_close for windows we previously
                    // emitted context_open for. This prevents spurious
                    // context_close for internal windows (file dialog
                    // folder views, shell sub-windows) that were never
                    // captured as context_open.
                    let was_opened =
                        INPUT_OPENED_WINDOWS.with(|s| s.borrow_mut().remove(&window_handle));
                    if !was_opened {
                        return; // Never opened — don't close.
                    }
                    // Only dispatch if correlated with recent user input.
                    if !input_correlated(timestamp, timing::WINDOW_LIFECYCLE_CORRELATION_MS) {
                        return; // Programmatic window destruction — suppress.
                    }
                    input_dispatch_raw_event(RawEvent {
                        event_type: RawEventType::WindowDestroy,
                        sequence_id: 0,
                        timestamp,
                        screen_x: 0,
                        screen_y: 0,
                        window_handle,
                        process_id,
                        key_code: 0,
                        modifiers: (false, false, false, false),
                        scroll_delta: 0.0,
                        callback_params: [id_object as i64, id_child as i64, 0, 0],
                        key_value: 0,
                        keyboard_layout: 0,
                        caps_lock: false,
                        pre_captured_element: None,
                        focus_epoch: 0,
                        held: Vec::new(),
                        window_title: None,
                    });
                }
            }
        }

        x if x == EVENT_OBJECT_FOCUS as u32 => {
            // Only dispatch focus if correlated with recent user input.
            // Programmatic focus changes (e.g., SetFocus calls from apps)
            // will not have a preceding input event within the window.
            if !input_correlated(timestamp, timing::FOCUS_CORRELATION_MS) {
                return; // Programmatic focus — suppress.
            }

            // Suppress focus events that follow a mouse click —
            // timing::is_click_redundant decides. The click already captures
            // the interaction — focus is redundant.
            // Focus is only meaningful when caused by Tab key (keyboard navigation).
            let mouse_down = INPUT_MOUSE_DOWN_POS.with(|p| p.get().is_some());
            if mouse_down {
                return; // Click in progress — focus is redundant.
            }
            let last_click = INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.get());
            if timing::is_click_redundant(timestamp, last_click) {
                return; // Recent click — focus is redundant.
            }

            input_dispatch_raw_event(RawEvent {
                event_type: RawEventType::Focus,
                sequence_id: 0,
                timestamp,
                screen_x: 0,
                screen_y: 0,
                window_handle,
                process_id,
                key_code: 0,
                modifiers: (false, false, false, false),
                scroll_delta: 0.0,
                // The event's number among the focus events dispatched,
                // counted here, where the event is sure to be sent.
                callback_params: [
                    id_object as i64,
                    id_child as i64,
                    (FOCUS_EVENTS_DISPATCHED.fetch_add(1, Ordering::SeqCst) + 1) as i64,
                    0,
                ],
                key_value: 0,
                keyboard_layout: 0,
                caps_lock: false,
                pre_captured_element: None,
                focus_epoch: 0,
                held: Vec::new(),
                window_title: None,
            });
        }

        x if x == EVENT_OBJECT_VALUECHANGE as u32 => {
            // Only dispatch value-change if correlated with recent keyboard input
            // that targeted the SAME window (root ancestor). This prevents
            // Ctrl+S in Notepad from correlating with value changes in the
            // Save As dialog that opens afterwards.
            let last_keyboard = INPUT_LAST_KEYBOARD_TIMESTAMP.with(|t| t.get());
            if !timing::is_correlated(
                timestamp,
                last_keyboard,
                timing::VALUE_CHANGE_CORRELATION_MS,
            ) {
                return; // No recent keyboard input — suppress.
            }
            // Check that the keyboard input targeted the same root window.
            let last_kb_window = INPUT_LAST_KEYBOARD_WINDOW.with(|w| w.get());
            if last_kb_window != 0 && last_kb_window != window_handle {
                // Keyboard was in a different window — this value change is
                // from a newly opened dialog, not from user typing.
                let vc_root = GetAncestor(hwnd, GA_ROOT as u32);
                let kb_root = HWND(last_kb_window as *mut _);
                let kb_root_resolved = GetAncestor(kb_root, GA_ROOT as u32);
                let vc_root_h = if vc_root.0.is_null() {
                    hwnd.0 as i64
                } else {
                    vc_root.0 as i64
                };
                let kb_root_h = if kb_root_resolved.0.is_null() {
                    last_kb_window
                } else {
                    kb_root_resolved.0 as i64
                };
                if vc_root_h != kb_root_h {
                    return; // Different root window — suppress.
                }
            }

            input_dispatch_raw_event(RawEvent {
                event_type: RawEventType::ValueChange,
                sequence_id: 0,
                timestamp,
                screen_x: 0,
                screen_y: 0,
                window_handle,
                process_id,
                key_code: 0,
                modifiers: (false, false, false, false),
                scroll_delta: 0.0,
                callback_params: [id_object as i64, id_child as i64, 0, 0],
                key_value: 0,
                keyboard_layout: 0,
                caps_lock: false,
                pre_captured_element: None,
                focus_epoch: 0,
                held: Vec::new(),
                window_title: None,
            });
        }

        x if x == EVENT_OBJECT_SELECTION as u32 => {
            // A selection is user-caused only when correlated with recent
            // input — uncorrelated events are the application's own doing
            // (timers, async loads, background refresh), and idle background
            // apps fire them continuously. Same doctrine as the focus gate.
            if !input_correlated(timestamp, timing::SELECTION_CORRELATION_MS) {
                return; // No recent user input — programmatic selection.
            }

            // ...and only when it fires in the same root window that
            // received the input. This filters dialog initialization noise
            // regardless of input kind (a Save As dialog's filename ComboBox
            // fires selection events when it opens, whether the dialog was
            // opened by a click on "Open..." or by Ctrl+O).
            let input_window = INPUT_LAST_INPUT_WINDOW.with(|w| w.get());
            if input_window != 0 && input_window != window_handle {
                let sel_root = GetAncestor(hwnd, GA_ROOT as u32);
                let input_hwnd = HWND(input_window as *mut _);
                let input_root = GetAncestor(input_hwnd, GA_ROOT as u32);
                let sel_root_h = if sel_root.0.is_null() {
                    hwnd.0 as i64
                } else {
                    sel_root.0 as i64
                };
                let input_root_h = if input_root.0.is_null() {
                    input_window
                } else {
                    input_root.0 as i64
                };
                if sel_root_h != input_root_h {
                    return; // Different root window — dialog init noise.
                }
            }

            // Suppress selection events that follow a mouse click.
            // The click already captures what was selected — the selection
            // event is redundant. We check:
            // 1. Mouse button is currently down (click in progress)
            // 2. A click was recent (timing::is_click_redundant decides)
            let mouse_down = INPUT_MOUSE_DOWN_POS.with(|p| p.get().is_some());
            if mouse_down {
                return; // Click in progress — suppress.
            }
            let last_click = INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.get());
            if timing::is_click_redundant(timestamp, last_click) {
                return; // Recent click — suppress.
            }
            input_dispatch_raw_event(RawEvent {
                event_type: RawEventType::Selection,
                sequence_id: 0,
                timestamp,
                screen_x: 0,
                screen_y: 0,
                window_handle,
                process_id,
                key_code: 0,
                modifiers: (false, false, false, false),
                scroll_delta: 0.0,
                callback_params: [id_object as i64, id_child as i64, 0, 0],
                key_value: 0,
                keyboard_layout: 0,
                caps_lock: false,
                pre_captured_element: None,
                focus_epoch: 0,
                held: Vec::new(),
                window_title: None,
            });
        }

        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Input_Thread double-click pairing (DCP-10)
// ---------------------------------------------------------------------------

/// Record a left click by its press on the Input_Thread's pairing state, and
/// answer whether the press completed a double-click under the system's
/// double-click time and rectangle, read at the click: two system-parameter
/// reads, no accessibility call.
fn double_click_completed_by(press: ClickPress) -> bool {
    let bounds = unsafe {
        DoubleClickBounds {
            max_interval_ms: GetDoubleClickTime(),
            width: GetSystemMetrics(SM_CXDOUBLECLK),
            height: GetSystemMetrics(SM_CYDOUBLECLK),
        }
    };
    INPUT_DOUBLE_CLICKS.with(|cell| {
        let mut tracker = cell.get();
        let completed = tracker.left_click(press, bounds);
        cell.set(tracker);
        completed
    })
}

/// Break the Input_Thread's double-click pairing: the next left click starts
/// a new pair.
fn double_click_break_pair() {
    INPUT_DOUBLE_CLICKS.with(|cell| {
        let mut tracker = cell.get();
        tracker.break_pair();
        cell.set(tracker);
    });
}

// ---------------------------------------------------------------------------
// Input_Thread low-level mouse hook callback
// ---------------------------------------------------------------------------

/// A press on `point_hwnd` while `fg_hwnd` is in front: when it lands in a
/// different top-level window, proactively dispatch a Foreground event for
/// that window (`ContextIntroductions::press_switches` decides), before the
/// press itself is dispatched. Some window classes (e.g. STATIC) don't fire
/// EVENT_SYSTEM_FOREGROUND on activation, so the switch is detected here to
/// guarantee the context_switch, and the activation the press causes is then
/// deduplicated.
unsafe fn input_press_switch(point_hwnd: HWND, fg_hwnd: HWND, timestamp: u64) {
    if point_hwnd.0.is_null() {
        return;
    }
    let clicked_handle = input_root_of(point_hwnd.0 as i64);
    let fg_handle = input_root_of(fg_hwnd.0 as i64);
    if !INPUT_CONTEXTS.with(|c| c.borrow_mut().press_switches(clicked_handle, fg_handle)) {
        return;
    }
    // Different root window — user is switching context.
    let clicked_root = HWND(clicked_handle as *mut _);
    let mut clicked_pid: u32 = 0;
    GetWindowThreadProcessId(clicked_root, Some(&mut clicked_pid));
    INPUT_FOREGROUND_PID.with(|p| p.set(clicked_pid));
    input_dispatch_raw_event(RawEvent {
        event_type: RawEventType::Foreground,
        sequence_id: 0,
        timestamp,
        screen_x: 0,
        screen_y: 0,
        window_handle: clicked_handle,
        process_id: clicked_pid,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0, 0, 0, 0],
        key_value: 0,
        keyboard_layout: 0,
        caps_lock: false,
        pre_captured_element: None,
        focus_epoch: 0,
        held: Vec::new(),
        window_title: input_window_title(clicked_root),
    });
}

/// Low-level mouse hook for the Input_Thread: times each call and counts how
/// deep calls run inside one another (`hook_diagnostics`), around
/// [`input_mouse_ll_handle`], then passes the message on.
unsafe extern "system" fn input_mouse_ll_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    let depth = INPUT_MOUSE_HOOK_DEPTH.with(|d| {
        d.set(d.get() + 1);
        d.get()
    });
    hook_diagnostics::mouse_call_entered(depth);
    let started = Instant::now();
    input_mouse_ll_handle(n_code, w_param, l_param);
    hook_diagnostics::mouse_call_returned(started.elapsed());
    INPUT_MOUSE_HOOK_DEPTH.with(|d| d.set(d.get() - 1));
    CallNextHookEx(None, n_code, w_param, l_param)
}

/// What the low-level mouse hook does with one message. Captures raw mouse
/// data, performs click-vs-drag classification, and dispatches `RawEvent`s.
/// Waits, for a bounded time only, on the `ElementFromPoint` pre-capture at a
/// click (DCP-1).
unsafe fn input_mouse_ll_handle(n_code: i32, w_param: WPARAM, l_param: LPARAM) {
    if n_code >= 0 && input_is_active() {
        let mouse_struct = &*(l_param.0 as *const MSLLHOOKSTRUCT);
        let msg = w_param.0 as u32;
        let pt = mouse_struct.pt;

        // A mouse-down may move the focus, reported or not, in a captured or
        // an excluded window: later keystrokes start a new focus epoch.
        // The extra buttons (Back, Forward) count too.
        const WM_XBUTTONDOWN: i32 = 0x020B;
        if matches!(
            msg as i32,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
        ) {
            focus_epoch_advance_by_person();
        }

        // A drag starts where the pointer first passes the threshold from a
        // kept left press; what is held there is the drag start's to state.
        // Over any window: the keys are the keyboard's, wherever the pointer
        // is.
        if msg == WM_MOUSEMOVE as u32 {
            if let Some(down) = INPUT_MOUSE_DOWN_POS.with(|p| p.get()) {
                INPUT_DRAG_START_KEYS.with(|k| {
                    k.borrow_mut()
                        .on_move(is_drag(down, pt), || input_keys_held())
                });
            }
        }

        // Use WindowFromPoint for PID exclusion — determines WHETHER to capture
        // the event by checking if the click target is Docent's own window.
        // Previously used GetForegroundWindow, which incorrectly filtered events
        // when Docent was foreground but the user clicked on a different window.
        let point_hwnd = WindowFromPoint(pt);
        let fg_hwnd = GetForegroundWindow();
        let check_hwnd = if point_hwnd.0.is_null() {
            fg_hwnd
        } else {
            point_hwnd
        };
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(check_hwnd, Some(&mut pid));
        let excluded = input_get_excluded_pid();

        if input_should_keep_event_cached(pid, excluded, check_hwnd) {
            let timestamp = current_timestamp_ms();

            // window_handle field identifies WHICH window was interacted with.
            let window_handle = if point_hwnd.0.is_null() {
                fg_hwnd.0 as i64
            } else {
                point_hwnd.0 as i64
            };

            match msg as i32 {
                WM_LBUTTONDOWN => {
                    hook_diagnostics::left_down();
                    // Record the input for correlation.
                    note_input(timestamp, window_handle);
                    // Store mouse-down position for drag detection.
                    INPUT_MOUSE_DOWN_POS.with(|p| p.set(Some(pt)));
                    // And the press itself, for the double-click test.
                    INPUT_LEFT_PRESS.with(|p| {
                        p.set(Some(ClickPress {
                            time_ms: mouse_struct.time,
                            x: pt.x,
                            y: pt.y,
                            window: window_handle,
                        }))
                    });
                    // What is held when a drag starts from here is read at
                    // the first move past the threshold.
                    INPUT_DRAG_START_KEYS.with(|k| k.borrow_mut().on_press());
                    // Set click timestamp on mousedown (not just mouseup) because
                    // EVENT_OBJECT_SELECTION can fire between mousedown and mouseup.
                    INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.set(timestamp));

                    input_press_switch(point_hwnd, fg_hwnd, timestamp);
                }
                WM_LBUTTONUP => {
                    hook_diagnostics::left_up();
                    // A release is input too: selections completed at the end
                    // of a long drag correlate with the release, not the press.
                    note_input(timestamp, window_handle);
                    let classified =
                        classify_left_release(INPUT_MOUSE_DOWN_POS.with(|p| p.get()), pt);
                    // The press this release ends, taken whatever the release
                    // records, so no later release reads it.
                    let left_press = INPUT_LEFT_PRESS.with(|p| p.take());

                    if let LeftRelease::DragPair { source_coords } = classified {
                        // A drag between two clicks breaks a double-click.
                        double_click_break_pair();
                        // Drag detected: dispatch DragStart + Drop pair. The
                        // drag start states what was held when the pointer
                        // first passed the threshold, the drop what is held
                        // now.
                        let (down_modifiers, down_held) = INPUT_DRAG_START_KEYS
                            .with(|k| k.borrow_mut().at_release(|| input_keys_held()));
                        input_dispatch_raw_event(RawEvent {
                            event_type: RawEventType::DragStart { source_coords },
                            sequence_id: 0,
                            timestamp,
                            screen_x: source_coords.0,
                            screen_y: source_coords.1,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: down_modifiers,
                            scroll_delta: 0.0,
                            callback_params: [0, 0, 0, 0],
                            key_value: 0,
                            keyboard_layout: 0,
                            caps_lock: false,
                            pre_captured_element: None,
                            focus_epoch: 0,
                            held: down_held,
                            window_title: None,
                        });

                        input_dispatch_raw_event(RawEvent {
                            event_type: RawEventType::Drop { source_coords },
                            sequence_id: 0,
                            timestamp,
                            screen_x: pt.x,
                            screen_y: pt.y,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: get_modifier_state(),
                            scroll_delta: 0.0,
                            callback_params: [0, 0, 0, 0],
                            key_value: 0,
                            keyboard_layout: 0,
                            caps_lock: false,
                            pre_captured_element: None,
                            focus_epoch: 0,
                            held: Vec::new(),
                            window_title: None,
                        });
                    } else {
                        // Click detected — pre-capture the element while
                        // the window is still alive, within the budget.
                        let pre_element = input_pre_capture_element(pid, pt.x, pt.y);
                        let double = left_press.is_some_and(double_click_completed_by);
                        input_dispatch_raw_event(RawEvent {
                            event_type: RawEventType::Click,
                            sequence_id: 0,
                            timestamp,
                            screen_x: pt.x,
                            screen_y: pt.y,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: get_modifier_state(),
                            scroll_delta: 0.0,
                            callback_params: [
                                if double {
                                    CLICK_COMPLETES_DOUBLE_CLICK
                                } else {
                                    0
                                },
                                0,
                                0,
                                0,
                            ],
                            key_value: 0,
                            keyboard_layout: 0,
                            caps_lock: false,
                            pre_captured_element: pre_element,
                            focus_epoch: 0,
                            held: Vec::new(),
                            window_title: None,
                        });
                        INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.set(timestamp));
                        hook_diagnostics::left_click_dispatched();
                    }

                    INPUT_MOUSE_DOWN_POS.with(|p| p.set(None));
                }
                WM_MOUSEWHEEL => {
                    // Wheel is input: wheel-rotated selections (ComboBox,
                    // lists) must correlate like any other user action.
                    note_input(timestamp, window_handle);
                    let delta = (mouse_struct.mouseData >> 16) as i16 as f64;
                    input_dispatch_raw_event(RawEvent {
                        event_type: RawEventType::Scroll,
                        sequence_id: 0,
                        timestamp,
                        screen_x: pt.x,
                        screen_y: pt.y,
                        window_handle,
                        process_id: pid,
                        key_code: 0,
                        modifiers: (false, false, false, false),
                        scroll_delta: delta,
                        callback_params: [0, 0, 0, 0],
                        key_value: 0,
                        keyboard_layout: 0,
                        caps_lock: false,
                        pre_captured_element: None,
                        focus_epoch: 0,
                        held: Vec::new(),
                        window_title: None,
                    });
                }
                WM_MOUSEHWHEEL => {
                    note_input(timestamp, window_handle);
                    let delta = (mouse_struct.mouseData >> 16) as i16 as f64;
                    input_dispatch_raw_event(RawEvent {
                        event_type: RawEventType::Scroll,
                        sequence_id: 0,
                        timestamp,
                        screen_x: pt.x,
                        screen_y: pt.y,
                        window_handle,
                        process_id: pid,
                        key_code: 0,
                        modifiers: (false, false, false, false),
                        scroll_delta: delta,
                        callback_params: [1, 0, 0, 0], // 1 = horizontal axis
                        key_value: 0,
                        keyboard_layout: 0,
                        caps_lock: false,
                        pre_captured_element: None,
                        focus_epoch: 0,
                        held: Vec::new(),
                        window_title: None,
                    });
                }
                // The middle and right buttons record on the press itself, each
                // dispatching the raw event its message maps to.
                WM_MBUTTONDOWN | WM_RBUTTONDOWN => {
                    // Another button between two left clicks breaks a
                    // double-click.
                    double_click_break_pair();
                    if let Some(event_type) = down_dispatch_event_type(msg) {
                        // Record the input for correlation.
                        note_input(timestamp, window_handle);
                        // The press activates the window it lands in: its
                        // switch goes before the press, as a left press's.
                        input_press_switch(point_hwnd, fg_hwnd, timestamp);
                        let pre_element = input_pre_capture_element(pid, pt.x, pt.y);
                        input_dispatch_raw_event(RawEvent {
                            event_type,
                            sequence_id: 0,
                            timestamp,
                            screen_x: pt.x,
                            screen_y: pt.y,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: get_modifier_state(),
                            scroll_delta: 0.0,
                            callback_params: [down_dispatch_click_mark(msg), 0, 0, 0],
                            key_value: 0,
                            keyboard_layout: 0,
                            caps_lock: false,
                            pre_captured_element: pre_element,
                            focus_epoch: 0,
                            held: Vec::new(),
                            window_title: None,
                        });
                    }
                }
                _ => {}
            }
        } else if msg == WM_LBUTTONUP as u32 {
            // Excluded PID — clear drag state, and pair no double-click across
            // the excluded window.
            INPUT_MOUSE_DOWN_POS.with(|p| p.set(None));
            INPUT_LEFT_PRESS.with(|p| p.set(None));
            double_click_break_pair();
        }
    }
}

/// The modifiers held and the keys that are down now, as a pointer action
/// states them.
unsafe fn input_keys_held() -> super::held_keys::KeysHeld {
    (
        get_modifier_state(),
        INPUT_HELD_KEYS.with(|held| held.borrow().dispatched_down(None)),
    )
}

/// The window handle of the control that holds the keyboard focus in the
/// thread `thread_id` (the foreground window's thread), `0` when there is
/// none or it cannot be read. `GetGUIThreadInfo` answers from the window
/// system's own record of the thread's input state: it sends the thread no
/// message, so it returns at once however busy the program is.
unsafe fn focused_control_of_thread(thread_id: u32) -> i64 {
    if thread_id == 0 {
        return 0;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if GetGUIThreadInfo(thread_id, &mut info).as_bool() {
        info.hwndFocus.0 as i64
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// Input_Thread low-level keyboard hook callback
// ---------------------------------------------------------------------------

/// Low-level keyboard hook for the Input_Thread. Captures raw key data
/// and dispatches `RawEvent`s. No accessibility queries.
unsafe extern "system" fn input_keyboard_ll_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    // Which keys are down is kept for every keystroke the hook is handed, in
    // an excluded window and outside an active capture too: a key held down
    // across either boundary is still a held key when its next key-down is
    // captured.
    let mut repeat = false;
    if n_code >= 0 {
        let kb_struct = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        // The hook is called before the keyboard's asynchronous state takes
        // this key-down in, so that state still says whether the key was down
        // before it: the second opinion on a repeat.
        repeat = INPUT_HELD_KEYS.with(|held| {
            held.borrow_mut().on_hook_message(
                w_param.0 as u32,
                super::held_keys::key_of(
                    kb_struct.vkCode,
                    kb_struct.flags & LLKHF_EXTENDED as u32 != 0,
                ),
                kb_struct.scanCode,
                |vk| GetAsyncKeyState(vk as i32) < 0,
            )
        });
    }

    if n_code >= 0 && input_is_active() {
        let msg = w_param.0 as u32;
        if msg == WM_KEYDOWN as u32 || msg == WM_SYSKEYDOWN as u32 {
            let kb_struct = &*(l_param.0 as *const KBDLLHOOKSTRUCT);

            let hwnd = GetForegroundWindow();
            let mut pid: u32 = 0;
            let thread_id = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let excluded = input_get_excluded_pid();
            let foreground_kept = input_should_keep_event_cached(pid, excluded, hwnd);
            let modifiers = get_modifier_state();
            // Which window the key is attributed to (DCP-14): a key the
            // system acts on, not the foreground window (the Windows key,
            // Ctrl+Esc, Alt+Tab, for example: `system_takes_key`), is kept
            // with no window over an excluded foreground window.
            let attribution = super::scroll::keyboard_attribution(
                kb_struct.vkCode,
                modifiers,
                pid,
                input_get_included_pid(),
                excluded,
                foreground_kept,
            );

            if attribution != KeyAttribution::Dropped {
                let layout_char = foreground_layout_char(kb_struct.vkCode, thread_id);
                let dead_as_pressed = foreground_dead_as_pressed(
                    kb_struct.vkCode,
                    kb_struct.scanCode,
                    modifiers,
                    thread_id,
                );
                let (keyboard_layout, caps_lock) = foreground_layout_and_caps_lock(thread_id);
                let timestamp = current_timestamp_ms();
                let foreground_handle = hwnd.0 as i64;
                let (window_handle, process_id) = match attribution {
                    KeyAttribution::NoWindow => (0, 0),
                    _ => (foreground_handle, pid),
                };

                // Record the input for correlation. A key with no window still
                // correlates the window changes it causes, with the foreground
                // window it was pressed over as the input's window, so the
                // selections of the windows it opens stay scoped out (DCP-8);
                // it types into no window, so it is no keyboard input for
                // value-change correlation.
                note_input(timestamp, foreground_handle);
                if attribution == KeyAttribution::ForegroundWindow {
                    INPUT_LAST_KEYBOARD_TIMESTAMP.with(|t| t.set(timestamp));
                    INPUT_LAST_KEYBOARD_WINDOW.with(|w| w.set(window_handle));
                }

                // The control holding the keyboard focus, for the worker to
                // settle the key on; none for a key with no window, whose
                // focused control is the excluded window's.
                let control = match attribution {
                    KeyAttribution::NoWindow => 0,
                    _ => focused_control_of_thread(thread_id),
                };
                // What the input method of that control says of itself at
                // this press, before the key takes effect; none for a key
                // with no window.
                let input_method = match attribution {
                    KeyAttribution::NoWindow => None,
                    _ => input_method_state_of(control, hwnd),
                };
                // The key's number among its window's keys, counted here,
                // where the key is sure to be sent: a worker that read a
                // field's value takes it only while no later key of the
                // window was dispatched (docent#761). A key with no window
                // types into none, and is not numbered; a Shift, Control or
                // Alt key changes no text, and carries the window's latest
                // number.
                let number = match attribution {
                    KeyAttribution::NoWindow => 0,
                    _ => KEYS_DISPATCHED.for_key(window_handle, kb_struct.vkCode),
                };
                input_dispatch_raw_event(RawEvent {
                    event_type: RawEventType::Keyboard,
                    sequence_id: 0,
                    timestamp,
                    screen_x: 0,
                    screen_y: 0,
                    window_handle,
                    process_id,
                    key_code: kb_struct.vkCode,
                    modifiers,
                    scroll_delta: 0.0,
                    // The scan code: for a VK_PACKET keystroke it is the
                    // injected UTF-16 code unit the worker names the key by
                    // (docent#260). A copy of a field of the struct already
                    // read above — no call, lock or allocation on the hook.
                    // Beside it the control that holds the keyboard focus at
                    // this key: one read of the window system's own state,
                    // which sends no message and waits on no program.
                    // And the number of the latest focus change that named a
                    // part of that control, from this thread's own note.
                    // Then the character a punctuation key enters on the
                    // foreground window's layout, read above (docent#691),
                    // with whether the key is a dead key as pressed
                    // (docent#769), and
                    // above it whether the key was already down at this
                    // key-down: a press key repeat generated (docent#696),
                    // and above that the key's number, counted above.
                    // Above the scan code sits the hook's extended mark,
                    // which tells apart two keys that share a key code;
                    // the two together name the physical key (docent#717).
                    // Above that mark sits what was read of the input method
                    // (docent#237).
                    callback_params: [
                        i64::from(kb_struct.scanCode)
                            | if kb_struct.flags & LLKHF_EXTENDED as u32 != 0 {
                                super::held_keys::KEY_EXTENDED_PARAM
                            } else {
                                0
                            }
                            | super::held_keys::input_method_param(input_method),
                        control,
                        INPUT_PART_FOCUS.with(|note| note.borrow().of(control)),
                        i64::from(layout_char)
                            | super::held_keys::dead_as_pressed_param(dead_as_pressed)
                            | if repeat {
                                super::held_keys::KEY_REPEAT_PARAM
                            } else {
                                0
                            }
                            | super::worker_pool::key_number_param(number),
                    ],
                    // The layout of the foreground window's thread and the
                    // Caps Lock state, both read above: a worker asks the
                    // layout what the key gives as pressed (docent#717).
                    key_value: 0,
                    keyboard_layout,
                    caps_lock,
                    pre_captured_element: None,
                    focus_epoch: 0,
                    held: Vec::new(),
                    window_title: None,
                });
            } else {
                // A key the recording keeps nothing of: it still goes into
                // the accents that wait.
                let (keyboard_layout, caps_lock) = foreground_layout_and_caps_lock(thread_id);
                let (ctrl, shift, alt, _meta) = modifiers;
                input_send_unrecorded_key(
                    keyboard_layout,
                    kb_struct.vkCode,
                    super::key_value::Held {
                        shift,
                        ctrl,
                        alt,
                        caps_lock,
                    },
                );
            }
            // After the key's own dispatch, so the key keeps the epoch it was
            // pressed under. Outside the exclusion gate: a focus-moving key
            // pressed in an excluded window moves the focus all the same.
            if super::worker_pool::key_may_move_focus(kb_struct.vkCode, modifiers) {
                focus_epoch_advance_by_person();
            }
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

/// The `WM_IME_CONTROL` command that asks an input-method window whether its
/// input method is on (`IMC_GETOPENSTATUS`).
const IMC_GETOPENSTATUS: usize = 0x0005;
/// The `WM_IME_CONTROL` command that asks an input-method window for its
/// conversion mode (`IMC_GETCONVERSIONMODE`).
const IMC_GETCONVERSIONMODE: usize = 0x0001;

/// What the input method says of itself for the control `control` (the
/// control that holds the keyboard focus; the foreground window `foreground`
/// where none was read): whether it is on, and its conversion mode. `None`
/// where the window has no input-method window, where that window gave no
/// answer to the first ask within the session's time limit
/// (`timing::input_method_read_timeout_ms`) or refused it, or where that
/// limit is 0.
///
/// Called on the keyboard hook. The input-method window belongs to the
/// program's own thread, which has to answer, so each of the two asks waits
/// for at most the time limit and gives up at once on a thread the system
/// knows to be hung; which is asked when, and what stands where one gets no
/// answer, is [`super::held_keys::read_input_method`]'s to state. The wait
/// dispatches no message to this thread (`SMTO_BLOCK`), so no hook call runs
/// inside it.
unsafe fn input_method_state_of(
    control: i64,
    foreground: HWND,
) -> Option<super::held_keys::InputMethodState> {
    use super::held_keys::InputMethodQuestion;
    use hook_diagnostics::InputMethodReadOutcome;
    let timeout_ms = INPUT_METHOD_QUESTION_LIMIT_MS.with(|t| t.get());
    if timeout_ms == 0 {
        return None;
    }
    let started = Instant::now();
    let window = if control != 0 {
        HWND(control as *mut core::ffi::c_void)
    } else {
        foreground
    };
    let input_method_window = if window.0.is_null() {
        window
    } else {
        ImmGetDefaultIMEWnd(window)
    };
    if input_method_window.0.is_null() {
        hook_diagnostics::input_method_read(started.elapsed(), InputMethodReadOutcome::NoWindow);
        return None;
    }
    let state = super::held_keys::read_input_method(|question| {
        let command = match question {
            InputMethodQuestion::OpenStatus => IMC_GETOPENSTATUS,
            InputMethodQuestion::ConversionMode => IMC_GETCONVERSIONMODE,
        };
        ask_input_method(input_method_window, command, timeout_ms)
    });
    let outcome = match state {
        None => InputMethodReadOutcome::NoAnswer,
        Some(state) if state.conversion_mode.is_none() => InputMethodReadOutcome::OpenStatusAlone,
        Some(_) => InputMethodReadOutcome::Answered,
    };
    hook_diagnostics::input_method_read(started.elapsed(), outcome);
    state
}

/// Ask an input-method window one `WM_IME_CONTROL` question; `None` when no
/// answer came within the time limit, or the message was refused.
unsafe fn ask_input_method(
    input_method_window: HWND,
    command: usize,
    timeout_ms: u32,
) -> Option<usize> {
    let mut answer = 0usize;
    let sent = SendMessageTimeoutW(
        input_method_window,
        WM_IME_CONTROL as u32,
        WPARAM(command),
        LPARAM(0),
        (SMTO_ABORTIFHUNG | SMTO_BLOCK) as u32,
        timeout_ms,
        Some(&mut answer),
    );
    (sent.0 != 0).then_some(answer)
}

/// What the keyboard layout of the foreground window's thread (`thread_id`,
/// the thread `GetWindowThreadProcessId` names) gives punctuation key `vk`
/// with no modifier, with the dead-key flag in bit 31, for the worker to know
/// a dead key by; 0 for every other key, and where no thread or layout is
/// known. The layout is read at the keypress, so a later switch of layout does
/// not rename the key. Called on the keyboard hook: two user32 reads, no
/// accessibility call, lock or allocation.
unsafe fn foreground_layout_char(vk: u32, thread_id: u32) -> u32 {
    // Thread 0 would ask for this thread's own layout, not the window's.
    if thread_id == 0 || !super::worker_pool::is_punctuation_key(vk) {
        return 0;
    }
    layout_char(vk, GetKeyboardLayout(thread_id))
}

/// Whether this Windows honors the flag that makes `ToUnicodeEx` leave the
/// keyboard state as it is (flag 4: Windows 10 version 1607, build 14393, and
/// later). Without it the call takes the pending accent of a dead key, in the
/// application typed into too, so the layout is not asked there. Read once.
fn layout_read_leaves_key_state() -> bool {
    static HONORED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *HONORED.get_or_init(|| {
        let mut version = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        // SAFETY: a sized, writable version structure of this frame.
        let status = unsafe { RtlGetVersion(&mut version) };
        status.is_ok() && windows_build_honors_flag(version.dwMajorVersion, version.dwBuildNumber)
    })
}

/// Whether a Windows of this major version and build honors `ToUnicodeEx`'s
/// flag 4: Windows 10 from build 14393 on.
const fn windows_build_honors_flag(major: u32, build: u32) -> bool {
    major > 10 || (major == 10 && build >= 14393)
}

/// Whether typing key `vk` (scan code `scan_code`) is a dead key as pressed,
/// with `modifiers` (Ctrl, Shift, Alt, Meta) held, on the keyboard layout of
/// the foreground window's thread (`thread_id`): `None` where it is not known
/// (no thread or layout, a key that is no typing key, an injected character,
/// a shortcut modifier held, neither Shift nor AltGr held, a Windows that
/// does not honor the flag below, or a key pressed while an accent is pending
/// before the layout was asked about it, see below).
///
/// The layout is asked with `ToUnicodeEx` and its flag 4, which leaves the
/// keyboard state as it is: measured on Windows 10 (19045) from a low-level
/// keyboard hook, dead keys in the application typed into compose as with no
/// call at all, where the same call with no flag breaks every one of them
/// (docent#769).
///
/// The answer depends on an accent already pending, and the accent pending
/// when the hook runs is the one the application has got to, not the one the
/// keys pressed so far will leave. So the layout is asked only while nothing
/// is pending ([`layout_has_no_accent_pending`], checked before and after),
/// and its answer is kept for the layout ([`INPUT_DEAD_KEY_ANSWERS`]): what a
/// key is with given modifiers is then the same at every press, however far
/// behind the application is. CapsLock is no part of the question.
///
/// Called on the keyboard hook: three user32 reads until the layout has
/// answered for a key with given modifiers and none after, no accessibility call,
/// lock or allocation.
unsafe fn foreground_dead_as_pressed(
    vk: u32,
    scan_code: u32,
    modifiers: (bool, bool, bool, bool),
    thread_id: u32,
) -> Option<super::held_keys::AsPressed> {
    let (ctrl, shift, alt, meta) = modifiers;
    // Ctrl and Alt together are AltGr; either alone, or Meta, is a shortcut,
    // which enters no text and is asked nothing.
    if thread_id == 0
        || meta
        || ctrl != alt
        || vk == super::worker_pool::VK_PACKET
        || !super::worker_pool::is_typing_key_code(vk)
        || !layout_read_leaves_key_state()
    {
        return None;
    }
    let alt_gr = ctrl && alt;
    // A press with neither is the layout's own mark for the key, which the
    // worker has already and which depends on nothing pending.
    if !shift && !alt_gr {
        return None;
    }
    let hkl = GetKeyboardLayout(thread_id);
    let layout = hkl.0 as isize;
    if let Some(kept) = INPUT_DEAD_KEY_ANSWERS.with(|a| a.borrow().get(layout, vk, shift, alt_gr)) {
        return Some(kept);
    }
    let dead = dead_as_pressed(vk, scan_code, shift, alt_gr, hkl)?;
    INPUT_DEAD_KEY_ANSWERS.with(|a| a.borrow_mut().learn(layout, vk, shift, alt_gr, dead));
    Some(dead)
}

/// `ToUnicodeEx`: the keyboard state is not changed.
const LEAVE_KEY_STATE: u32 = 4;

/// The keyboard layout of the foreground window's thread (`thread_id`), as
/// its handle, and whether Caps Lock is on: what a worker asks the layout
/// with to name the key ([`layout_key_value`]). The layout is 0 where no
/// thread is known. Both are read at the press, so a later switch of layout
/// or of Caps Lock does not rename the key.
///
/// Called on the keyboard hook: two user32 reads, no accessibility call,
/// lock or allocation. The layout itself is not asked here: its answers for
/// every key take far longer than a hook may.
unsafe fn foreground_layout_and_caps_lock(thread_id: u32) -> (i64, bool) {
    // Thread 0 would ask for this thread's own layout, not the window's.
    let layout = if thread_id == 0 {
        0
    } else {
        GetKeyboardLayout(thread_id).0 as isize as i64
    };
    // The low bit of a toggle key's state: Caps Lock is on.
    (layout, GetKeyState(VK_CAPITAL) & 1 != 0)
}

/// How many layouts' answers are kept at once; the oldest goes first.
const LAYOUT_TABLES_KEPT: usize = 8;

/// The answers of the keyboard layouts asked so far, one table a layout
/// ([`fill_layout_answers`]), shared by the workers.
static LAYOUT_TABLES: Mutex<Vec<Box<super::key_value::LayoutAnswers>>> = Mutex::new(Vec::new());

/// What layout `layout` (a layout handle, as a keystroke carries it) gives
/// key `vk` as pressed with `held`, as a keyboard event carries it
/// ([`super::key_value::pressed_param`]): looked up in the order a browser
/// uses in the layout's table of answers.
/// The table is taken the first time the layout is asked about, for every
/// key and combination of modifiers, so a key pressed behind a dead key is
/// named by its own character, whatever accent is pending by then.
///
/// 0, nothing read, where there is no layout, for an injected character (named by the
/// unit it carries), on a Windows that does not honor the flag that leaves
/// the key state ([`layout_read_leaves_key_state`]), and where the layout's
/// answers could not be taken now ([`fill_layout_answers`]).
///
/// Called by a worker, never on the keyboard hook.
fn layout_key_value(layout: i64, vk: u32, held: super::key_value::Held) -> u32 {
    use super::key_value::{pressed_param, LayoutAnswers};
    if layout == 0 || vk == super::worker_pool::VK_PACKET || !layout_read_leaves_key_state() {
        return 0;
    }
    let id = layout as isize;
    let look_up = |tables: &[Box<LayoutAnswers>]| {
        tables
            .iter()
            .find(|table| table.is_of(id))
            .map(|table| pressed_param(held, |with| table.get(id, vk, with)))
    };
    let tables = || LAYOUT_TABLES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(value) = look_up(&tables()) {
        return value;
    }
    // Taken with the lock let go: it is some thousand reads of the layout.
    let mut table = Box::new(LayoutAnswers::new());
    // SAFETY: reads of a layout's tables that leave the keyboard state.
    if !unsafe { fill_layout_answers(HKL(id as *mut core::ffi::c_void), &mut table) } {
        return 0;
    }
    let mut tables = tables();
    if !tables.iter().any(|kept| kept.is_of(id)) {
        if tables.len() >= LAYOUT_TABLES_KEPT {
            tables.remove(0);
        }
        tables.push(table);
    }
    look_up(&tables).unwrap_or(0)
}

/// The lists of the keyboard layouts asked so far: what each accent of a
/// layout makes with each character ([`super::layout_file::Compositions`]),
/// or none for a layout whose list could not be read. Shared by the workers;
/// as many are kept as tables.
type LayoutList = Option<Arc<super::layout_file::Compositions>>;
static LAYOUT_LISTS: Mutex<Vec<(isize, LayoutList)>> = Mutex::new(Vec::new());

/// What layout `layout` (a layout handle, as a keystroke carries it) lists
/// for `accent` and `base` together: the name of a key pressed behind a dead
/// key ([`super::waiting_accents`]). The list is read from the layout's file
/// the first time the layout is asked about ([`read_layout_list`]).
///
/// `None` where the layout lists nothing for the two, and for a layout whose
/// list could not be read: the key is then named by its own character, and
/// the log says once for the layout why.
///
/// Called by a worker, never on the keyboard hook.
fn layout_composed(layout: i64, accent: char, base: char) -> Option<super::layout_file::Composed> {
    if layout == 0 {
        return None;
    }
    let id = layout as isize;
    let lists = || LAYOUT_LISTS.lock().unwrap_or_else(|e| e.into_inner());
    let kept = |lists: &[(isize, LayoutList)]| {
        lists
            .iter()
            .find(|(of, _)| *of == id)
            .map(|(_, list)| list.clone())
    };
    let known = kept(&lists());
    let list = match known {
        Some(list) => list,
        None => {
            // Read with the lock let go: registry reads and a file read.
            let read = match read_layout_list(layout) {
                Ok(list) => Some(Arc::new(list)),
                Err(why) => {
                    eprintln!(
                        "[WindowsCapture] The dead-key list of keyboard layout {:08X} was not \
                         read ({why}): a key pressed behind a dead key is named by its own \
                         character on this layout.",
                        layout as u32
                    );
                    None
                }
            };
            let mut lists = lists();
            match kept(&lists) {
                Some(list) => list,
                None => {
                    if lists.len() >= LAYOUT_TABLES_KEPT {
                        lists.remove(0);
                    }
                    lists.push((id, read.clone()));
                    read
                }
            }
        }
    };
    list?.of(accent, base)
}

/// The registry key that lists the keyboard layouts, one key a layout.
const KEYBOARD_LAYOUTS_KEY: &str = "SYSTEM\\CurrentControlSet\\Control\\Keyboard Layouts";
/// The most layout keys looked through for a `Layout Id`.
const MOST_LAYOUT_KEYS: u32 = 4096;
/// The most bytes read of a layout file. The files shipped with Windows are
/// some thousands of bytes.
const MOST_LAYOUT_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// A string value of a key under `HKEY_LOCAL_MACHINE`; `None` where there is
/// none, it is no string, or it is longer than 259 units.
fn machine_registry_string(key: &str, value: &str) -> Option<String> {
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(key), wide(value));
    let mut text = [0u16; 260];
    let mut size = std::mem::size_of_val(&text) as u32;
    // SAFETY: two NUL-terminated strings that live across the call, and a
    // buffer of the size stated.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            windows_core::PCWSTR(key.as_ptr()),
            windows_core::PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ as u32,
            None,
            Some(text.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status.0 != 0 {
        return None;
    }
    let len = text.iter().position(|&c| c == 0).unwrap_or(text.len());
    String::from_utf16(&text[..len]).ok()
}

/// The name of the layout key whose `Layout Id` value is `id`.
fn layout_key_with_id(id: u16) -> Option<String> {
    let layouts: Vec<u16> = KEYBOARD_LAYOUTS_KEY.encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();
    // SAFETY: a NUL-terminated string that lives across the call, and a
    // handle of this frame to open into.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            windows_core::PCWSTR(layouts.as_ptr()),
            None,
            ACCESS_MASK(KEY_READ as u32),
            &mut key,
        )
    };
    if opened.0 != 0 {
        return None;
    }
    /// The status that ends the list of a key's subkeys.
    const NO_MORE_ITEMS: i32 = 259;
    let mut found = None;
    for index in 0..MOST_LAYOUT_KEYS {
        let mut name = [0u16; 64];
        let mut len = name.len() as u32;
        // SAFETY: a buffer of the length stated, and the key opened above.
        let status = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            )
        };
        if status.0 == NO_MORE_ITEMS {
            break;
        }
        // A key that could not be named (a name longer than a layout key's)
        // is none of the ones looked for.
        if status.0 != 0 {
            continue;
        }
        let Some(name) = name
            .get(..len as usize)
            .and_then(|units| String::from_utf16(units).ok())
        else {
            continue;
        };
        let stated =
            machine_registry_string(&format!("{KEYBOARD_LAYOUTS_KEY}\\{name}"), "Layout Id");
        if stated.as_deref().and_then(super::layout_file::layout_id_of) == Some(id) {
            found = Some(name);
            break;
        }
    }
    // SAFETY: the key opened above, closed once.
    unsafe {
        let _ = RegCloseKey(key);
    }
    found
}

/// The system folder, where the keyboard layout files are.
fn system_directory() -> Option<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    let mut path = [0u16; 260];
    // SAFETY: a buffer of the length stated.
    let len = unsafe { GetSystemDirectoryW(Some(PWSTR(path.as_mut_ptr())), path.len() as u32) };
    let units = path.get(..len as usize).filter(|units| !units.is_empty())?;
    Some(std::ffi::OsString::from_wide(units).into())
}

/// Read the list of what each accent makes with each character from the
/// file of layout `layout`: the registry names the file for the layout
/// ([`super::layout_file::layout_key_of`]), and it is read from the system
/// folder as bytes ([`super::layout_file::compositions_in`]). The file is
/// never loaded or run, a name that is no plain file name is not followed
/// ([`super::layout_file::is_layout_file_name`]), and no more than
/// [`MOST_LAYOUT_FILE_BYTES`] are read. The error says why no list was read.
fn read_layout_list(layout: i64) -> Result<super::layout_file::Compositions, String> {
    use super::layout_file::{compositions_in, is_layout_file_name, layout_key_of, LayoutKey};
    use std::io::Read;
    let key = match layout_key_of(layout).ok_or("no layout")? {
        LayoutKey::Named(name) => name,
        LayoutKey::WithLayoutId(id) => {
            layout_key_with_id(id).ok_or("the registry has no layout with its layout id")?
        }
    };
    let file = machine_registry_string(&format!("{KEYBOARD_LAYOUTS_KEY}\\{key}"), "Layout File")
        .ok_or("the registry names no file for it")?;
    if !is_layout_file_name(&file) {
        return Err("the file the registry names is no plain file name".to_string());
    }
    let path = system_directory()
        .ok_or("the system folder is not known")?
        .join(file);
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|opened| {
            opened
                .take(MOST_LAYOUT_FILE_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|e| format!("its file could not be read: {}", e.kind()))?;
    if bytes.len() as u64 > MOST_LAYOUT_FILE_BYTES {
        return Err("its file is too long".to_string());
    }
    compositions_in(&bytes).map_err(|e| format!("its file: {e}"))
}

/// Take the answers of every keyboard layout loaded now, once for the
/// process and on a thread of its own, so that the first key pressed on a
/// layout finds its table there. A layout loaded later is asked at its first
/// key ([`layout_key_value`]).
fn warm_layout_tables() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let _ = thread::Builder::new()
            .name("docent-layout-tables".into())
            .spawn(|| {
                // SAFETY: the list is read into a buffer of the size the
                // first call reports.
                let layouts = unsafe {
                    let mut loaded = vec![HKL::default(); GetKeyboardLayoutList(0, None) as usize];
                    let n = GetKeyboardLayoutList(loaded.len() as i32, Some(loaded.as_mut_ptr()));
                    loaded.truncate(n.max(0) as usize);
                    loaded
                };
                for hkl in layouts.into_iter().take(LAYOUT_TABLES_KEPT) {
                    // Asking about any key takes the layout's table.
                    let _ = layout_key_value(
                        hkl.0 as isize as i64,
                        0x20,
                        super::key_value::Held::default(),
                    );
                }
            });
    });
}

/// The virtual-key code of Caps Lock.
const VK_CAPITAL: i32 = 0x14;

/// Take layout `hkl`'s answer for every key code and combination of Shift,
/// Ctrl, Alt and Caps Lock into `answers`, and say whether they were taken.
/// Each is `ToUnicodeEx` on a keyboard state that holds those modifiers and
/// nothing else, with the flag that leaves the keyboard state as it is, read
/// as [`super::key_value::layout_answer`] states: the way a browser builds
/// its own table for a layout.
///
/// An answer depends on an accent already pending, so the answers are taken
/// only while none is ([`layout_has_no_accent_pending`], checked before the
/// first key code and after each, since the person can type a dead key while
/// the answers are taken); otherwise the table is left holding nothing, to be
/// taken at a later press.
///
/// It is some thousand reads of the layout (measured at 450 ms on a test
/// machine), so it is never called on the keyboard hook.
unsafe fn fill_layout_answers(hkl: HKL, answers: &mut super::key_value::LayoutAnswers) -> bool {
    if hkl.0.is_null() {
        return false;
    }
    let ask = |vk: u32, held: super::key_value::Held| {
        let mut state = [0u8; 256];
        if held.shift {
            state[0x10] = 0x80;
        }
        if held.ctrl {
            state[0x11] = 0x80;
        }
        if held.alt {
            state[0x12] = 0x80;
        }
        if held.caps_lock {
            state[VK_CAPITAL as usize] = 0x01;
        }
        let mut entered = [0u16; 8];
        let answered = ToUnicodeEx(
            vk,
            0,
            state.as_ptr(),
            windows_core::PWSTR(entered.as_mut_ptr()),
            entered.len() as i32,
            LEAVE_KEY_STATE,
            Some(hkl),
        );
        super::key_value::layout_answer(answered, entered[0])
    };
    answers.fill(hkl.0 as isize, ask, || layout_has_no_accent_pending(hkl))
}

/// Whether no accent of a dead key is pending for `hkl` right now: the layout
/// answers Enter with the one carriage return. With an accent pending it
/// answers with the accent as well, or with something else.
unsafe fn layout_has_no_accent_pending(hkl: HKL) -> bool {
    let state = [0u8; 256];
    let mut entered = [0u16; 8];
    let answer = ToUnicodeEx(
        0x0D,
        0x1C,
        state.as_ptr(),
        windows_core::PWSTR(entered.as_mut_ptr()),
        entered.len() as i32,
        LEAVE_KEY_STATE,
        Some(hkl),
    );
    answer == 1 && entered[0] == 0x0D
}

/// What layout `hkl` answers for the key with Shift or AltGr held: whether it
/// is a dead key, and the accent it names for one. `None` for no layout, and where an accent is pending before
/// or after the question, since the answer then says what the key does to
/// that accent and not what the key is.
unsafe fn dead_as_pressed(
    vk: u32,
    scan_code: u32,
    shift: bool,
    alt_gr: bool,
    hkl: HKL,
) -> Option<super::held_keys::AsPressed> {
    use super::held_keys::AsPressed;
    if hkl.0.is_null() || !layout_has_no_accent_pending(hkl) {
        return None;
    }
    let mut state = [0u8; 256];
    if shift {
        state[0x10] = 0x80;
    }
    if alt_gr {
        state[0x11] = 0x80;
        state[0x12] = 0x80;
    }
    let mut entered = [0u16; 8];
    // A negative answer is a dead key, with its accent in the buffer.
    let answer = ToUnicodeEx(
        vk,
        scan_code,
        state.as_ptr(),
        windows_core::PWSTR(entered.as_mut_ptr()),
        entered.len() as i32,
        LEAVE_KEY_STATE,
        Some(hkl),
    );
    let read = if answer < 0 {
        AsPressed::DeadKey { accent: entered[0] }
    } else {
        AsPressed::NoDeadKey
    };
    layout_has_no_accent_pending(hkl).then_some(read)
}

/// The character `vk` enters with no modifier on keyboard layout `hkl`, with
/// the dead-key flag in bit 31, as `MapVirtualKeyExW(MAPVK_VK_TO_CHAR)` gives
/// it (0 where the layout gives none). The read takes no key-state array: it
/// answers with the key's own character on the layout's base table, never
/// what the modifiers held at the keypress make of it, and it touches no
/// dead-key state, so a dead key pressed before it still composes with the
/// next key.
unsafe fn layout_char(vk: u32, hkl: HKL) -> u32 {
    if hkl.0.is_null() {
        return 0;
    }
    MapVirtualKeyExW(vk, MAPVK_VK_TO_CHAR as u32, Some(hkl))
}

// ---------------------------------------------------------------------------
// UIA element resolution helpers (used by WindowsAccessibilityBackend)
// ---------------------------------------------------------------------------

/// Map a Windows `UIA_*ControlTypeId` numeric value to a human-readable tag.
///
/// The IDs are defined by Microsoft and are stable across Windows versions.
/// This is the Windows implementation of the per-platform control-type → tag
/// mapping; the platform-agnostic `element_mapping` module consumes the
/// resulting string via `NativeElementProperties::tag`.
/// See: <https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controltype-ids>
pub(crate) fn control_type_name(id: i32) -> &'static str {
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

/// Identity-scan cap per measured locator candidate: at most this many
/// `CompareElements` COM calls per `FindAll` result. Past the cap,
/// `match_count` ships with `match_index` absent (not measured).
const MAX_MATCH_SCAN: i32 = 50;

/// Cap on the ancestor walk when building the tree path (pre-existing bound,
/// promoted to a named constant).
const MAX_TREE_PATH_ANCESTORS: usize = 20;

/// Convert a UIA element to an `ElementDescription` using the element mapping
/// module, INCLUDING measured locator match statistics (docent#139). This is
/// the worker path: measurement adds bounded work (up to 3 `FindAll` calls +
/// a capped identity scan) and must never run inside the low-level input hook
/// — hook code uses [`uia_element_to_description_unmeasured`] instead.
pub(crate) unsafe fn uia_element_to_description(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Option<ElementDescription> {
    uia_element_to_description_in_window(uia, element).map(|(description, _)| description)
}

/// [`uia_element_to_description`], together with the top-level window handle
/// the description resolved for the element (`0` when it resolved none): the
/// handle a context id is made of.
pub(crate) unsafe fn uia_element_to_description_in_window(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Option<(ElementDescription, i64)> {
    let (mut props, control_type_id, window_root, window_handle) =
        gather_native_properties(uia, element);
    if let Some(root) = window_root {
        props.measurements = measure_candidates(uia, &root, element, control_type_id, &props);
    }
    Some((map_element(&props), window_handle))
}

/// Convert a UIA element to an `ElementDescription` WITHOUT measuring match
/// statistics — candidate values only, pairs absent (the schema's "not
/// measured"). Used by the click pre-capture's describers, which the
/// low-level mouse hook waits on for at most a budget below the system's hook
/// timeout (DCP-1): `FindAll` traversals would spend that budget, so they are
/// off-limits there.
pub(crate) unsafe fn uia_element_to_description_unmeasured(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Option<ElementDescription> {
    let (props, _control_type_id, _window_root, _window_handle) =
        gather_native_properties(uia, element);
    Some(map_element(&props))
}

/// Read every native property the element description needs (docent#138:
/// the original six plus ClassName, FrameworkId, LabeledBy-name, and the
/// provider-reported set ordinals), plus the tree path annotated with the
/// window-root position. Returns the raw control-type id (measurement
/// conditions match on it), the top-level window element (the measurement
/// scope), when resolvable, and the top-level window handle (`0` when none
/// resolved).
unsafe fn gather_native_properties(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> (
    NativeElementProperties,
    i32,
    Option<IUIAutomationElement>,
    i64,
) {
    let control_type_id = get_i32_property(element, UIA_ControlTypePropertyId);
    let automation_id = get_string_property(element, UIA_AutomationIdPropertyId);
    let name = get_string_property(element, UIA_NamePropertyId);
    let localized_type = get_string_property(element, UIA_LocalizedControlTypePropertyId);
    let value = value_held(element);
    let is_password = get_is_password(element);
    let class_name = get_string_property(element, UIA_ClassNamePropertyId);
    let framework_id = get_string_property(element, UIA_FrameworkIdPropertyId);
    let labeled_by = get_labeled_by_name(element);
    let position_in_set = get_i32_property(element, UIA_PositionInSetPropertyId);
    let size_of_set = get_i32_property(element, UIA_SizeOfSetPropertyId);
    let level = get_i32_property(element, UIA_LevelPropertyId);

    let (tree_path, window_root_offset, window_root, window_handle, language) =
        build_tree_path_with_root(uia, element);

    let props = NativeElementProperties {
        tag: control_type_name(control_type_id).to_string(),
        automation_id,
        name,
        localized_control_type: localized_type,
        is_password,
        value,
        tree_path,
        class_name,
        framework_id,
        language,
        labeled_by,
        position_in_set,
        size_of_set,
        level,
        window_root_offset,
        measurements: Default::default(),
    };
    (props, control_type_id, window_root, window_handle)
}

/// Read one property of a UIA element as an owned [`Variant`]. This is the one
/// place a VARIANT handed over by UI Automation enters the backend: the wrapper
/// takes ownership and its `Drop` clears it. `None` when the call fails.
unsafe fn property_value(
    element: &IUIAutomationElement,
    property_id: PROPERTYID,
) -> Option<Variant> {
    element
        .GetCurrentPropertyValue(property_id)
        .ok()
        .map(|v| Variant::from_raw(v))
}

/// Read the accessible name of the element referenced by the LabeledBy
/// property. The property's VARIANT wraps an `IUIAutomationElement` behind
/// `IUnknown`; any failure along the way yields `""` (total, like every
/// property helper here).
unsafe fn get_labeled_by_name(element: &IUIAutomationElement) -> String {
    property_value(element, UIA_LabeledByPropertyId)
        .and_then(|v| {
            v.as_unknown()
                .and_then(|unk| unk.cast::<IUIAutomationElement>().ok())
        })
        .map(|label| get_string_property(&label, UIA_NamePropertyId))
        .unwrap_or_default()
}

/// Build a BSTR-typed VARIANT for property conditions on string properties.
fn bstr_variant(value: &str) -> Variant {
    Variant::from(BSTR::from(value))
}

/// AND a candidate's property condition with `IsControlElement == true`,
/// emulating the Control view for `FindAll` (which has no view parameter).
unsafe fn control_view_condition(
    uia: &IUIAutomation,
    condition: &IUIAutomationCondition,
) -> Option<IUIAutomationCondition> {
    let control = uia
        .CreatePropertyCondition(UIA_IsControlElementPropertyId, Variant::from(true).as_raw())
        .ok()?;
    uia.CreateAndCondition(condition, &control).ok()
}

/// Measure one candidate: ONE `FindAll(TreeScope_Subtree, …)` over the window
/// root (window itself included), then a bounded identity scan. Returns
/// `None` when the query failed or matched nothing (pair absent = not
/// measured; the schema minimum for `match_count` is 1).
unsafe fn measure_pair(
    uia: &IUIAutomation,
    scope: &IUIAutomationElement,
    target: &IUIAutomationElement,
    condition: &IUIAutomationCondition,
) -> Option<MeasuredPair> {
    let cond = control_view_condition(uia, condition)?;
    let found = scope.FindAll(TreeScope_Subtree, &cond).ok()?;
    let len = found.Length().ok()?;
    if len <= 0 {
        return None;
    }
    let scan = len.min(MAX_MATCH_SCAN);
    for i in 0..scan {
        if let Ok(el) = found.GetElement(i) {
            if uia
                .CompareElements(&el, target)
                .map(|b| b.as_bool())
                .unwrap_or(false)
            {
                return Some(MeasuredPair {
                    count: len as u32,
                    index: MeasuredIndex::Found(i as u32),
                });
            }
        }
    }
    let index = if len > MAX_MATCH_SCAN {
        MeasuredIndex::NotMeasured
    } else {
        MeasuredIndex::NotMatched
    };
    Some(MeasuredPair {
        count: len as u32,
        index,
    })
}

/// Measure the three condition-expressible candidates (docent#139):
/// automation_id, role_name (raw ControlType id + Name), class_name.
/// `labeled_by` and `tree_path` are never measured (the cheapness rule):
/// label-relation equality is not property-condition-expressible, and path
/// counting is O(nodes × depth).
unsafe fn measure_candidates(
    uia: &IUIAutomation,
    scope: &IUIAutomationElement,
    target: &IUIAutomationElement,
    control_type_id: i32,
    props: &NativeElementProperties,
) -> LocatorMeasurements {
    let mut m = LocatorMeasurements::default();

    if !props.automation_id.is_empty() {
        if let Ok(cond) = uia.CreatePropertyCondition(
            UIA_AutomationIdPropertyId,
            bstr_variant(&props.automation_id).as_raw(),
        ) {
            m.automation_id = measure_pair(uia, scope, target, &cond);
        }
    }

    if !props.name.is_empty() {
        let type_cond = uia.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            Variant::from(control_type_id).as_raw(),
        );
        let name_cond =
            uia.CreatePropertyCondition(UIA_NamePropertyId, bstr_variant(&props.name).as_raw());
        if let (Ok(type_cond), Ok(name_cond)) = (type_cond, name_cond) {
            if let Ok(cond) = uia.CreateAndCondition(&type_cond, &name_cond) {
                m.role_name = measure_pair(uia, scope, target, &cond);
            }
        }
    }

    if !props.class_name.is_empty() {
        if let Ok(cond) = uia.CreatePropertyCondition(
            UIA_ClassNamePropertyId,
            bstr_variant(&props.class_name).as_raw(),
        ) {
            m.class_name = measure_pair(uia, scope, target, &cond);
        }
    }

    m
}

/// Get an i32 property from a UIA element via VARIANT. Every property read this
/// way is documented as `VT_I4`; a value of any other type reads as 0, as a
/// failed call does.
unsafe fn get_i32_property(element: &IUIAutomationElement, property_id: PROPERTYID) -> i32 {
    property_value(element, property_id)
        .and_then(|v| v.as_i32())
        .unwrap_or(0)
}

/// Get a string property from a UIA element via VARIANT. Only a `VT_BSTR` value
/// reads; an empty string, a value of another type and a failed call all yield
/// `""`.
unsafe fn get_string_property(element: &IUIAutomationElement, property_id: PROPERTYID) -> String {
    property_value(element, property_id)
        .and_then(|v| {
            v.as_bstr()
                .filter(|b| !b.is_empty())
                .map(|b| String::from_utf16_lossy(b))
        })
        .unwrap_or_default()
}

/// The value an element holds, `None` where it has none. Asked without the
/// default: an element that has no value answers with no string at all, where
/// the plain read would answer an empty one, the same as a field the person
/// emptied.
unsafe fn value_held(element: &IUIAutomationElement) -> Option<String> {
    let value = Variant::from_raw(
        element
            .GetCurrentPropertyValueEx(UIA_ValueValuePropertyId, true)
            .ok()?,
    );
    Some(String::from_utf16_lossy(value.as_bstr()?))
}

/// The `IsPassword` reading rule, decided in this one place over the property's
/// answer: a `VT_BOOL` answer (the property's documented type) reads as itself;
/// no answer — a failed call or a `VT_EMPTY` value — reads as `false`; an answer
/// of any other type reads as `true`, so a provider that answers outside the
/// documented type has its field masked rather than exposed. The
/// `is_password_value_*` unit tests pin each case.
fn is_password_value(answer: Option<&Variant>) -> bool {
    match answer {
        None => false,
        Some(v) => v.as_bool().unwrap_or(v.vt() != VT_EMPTY),
    }
}

/// Read a UIA element's `IsPassword` property through [`is_password_value`].
unsafe fn get_is_password(element: &IUIAutomationElement) -> bool {
    is_password_value(property_value(element, UIA_IsPasswordPropertyId).as_ref())
}

/// The language a UIA element reports for itself: its Culture property (a
/// locale identifier, `VT_I4`) as the locale name Windows gives that
/// identifier. `""` when the element reports none (the property's default, 0),
/// when the identifier names no language of its own ([`names_a_language`]),
/// and when either call fails. A
/// language-only identifier keeps its language-only name (`en`, not a
/// regional default).
unsafe fn get_culture_tag(element: &IUIAutomationElement) -> String {
    let lcid = get_i32_property(element, UIA_CulturePropertyId) as u32;
    if !names_a_language(lcid) {
        return String::new();
    }
    let mut name = [0u16; LOCALE_NAME_MAX_LENGTH as usize];
    let written = LCIDToLocaleName(
        LCID(lcid),
        Some(PWSTR(name.as_mut_ptr())),
        LOCALE_NAME_MAX_LENGTH,
        LOCALE_ALLOW_NEUTRAL_NAMES as u32,
    );
    if written <= 0 {
        return String::new();
    }
    tag_from_wide(&name).unwrap_or_default()
}

/// The user's preferred UI languages as Windows lists them, most preferred
/// first, as language names (`da-DK`). `None` when Windows could not be read.
/// Asked twice: once for the size of the list, once for the list.
pub(crate) fn read_preferred_ui_languages() -> Option<Vec<String>> {
    let mut count = 0u32;
    let mut length = 0u32;
    // SAFETY: a null buffer with a zero length asks only for the length; the
    // out-pointers are live locals.
    let sized = unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME as u32, &mut count, None, &mut length)
    };
    if !sized.as_bool() || length == 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: `buffer` holds `length` units, the length the call is told.
    let read = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME as u32,
            &mut count,
            Some(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    if !read.as_bool() {
        return None;
    }
    Some(parse_multi_string(&buffer))
}

/// Resolve the top-level (GA_ROOT) window handle for a native window handle
/// reported by UIA. Returns 0 when unresolvable.
unsafe fn top_level_hwnd(native_hwnd: i32) -> i64 {
    if native_hwnd == 0 {
        return 0;
    }
    let hwnd = HWND(native_hwnd as isize as *mut _);
    let root = GetAncestor(hwnd, GA_ROOT as u32);
    if root.0.is_null() {
        native_hwnd as i64
    } else {
        root.0 as i64
    }
}

/// Build the tree path for a UIA element by walking up the control view,
/// annotated with the window root (docent#139).
///
/// The walk itself is unchanged from the original `build_tree_path` (same
/// segments, same cap, same selector output). Additionally, the top-level
/// window handle is resolved from the FIRST hwnd-backed node on the walk up —
/// the element itself for classic Win32, or the nearest host window for
/// windowless providers (WPF/XAML children, Chromium content, DirectUI), which
/// report `NativeWindowHandle` = 0 for themselves while the walk passes
/// through their hwnd-backed host. The visited node whose handle IS that
/// top-level handle marks the window-root position in the path, and the
/// top-level window ELEMENT (via `ElementFromHandle`) becomes the measurement
/// scope. When no hwnd-backed node is seen within the walk cap, the offset
/// and scope are `None` — locator measurement is skipped and the `tree_path`
/// entry is omitted, so the recorded value never contradicts the schema's
/// "from the window root". The top-level handle itself is returned fourth (`0`
/// when none was seen), and the declared language last (empty when none).
unsafe fn build_tree_path_with_root(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> (
    Vec<String>,
    Option<usize>,
    Option<IUIAutomationElement>,
    i64,
    String,
) {
    let mut path = Vec::new();
    // Pre-reverse index of the node identified as the top-level window.
    let mut root_pre_index: Option<usize> = None;
    // Resolved lazily from the first hwnd-backed node the walk visits.
    let mut root_hwnd: i64 = 0;

    // Reads a node's native handle, resolves the top-level handle from the
    // first non-zero one, and reports whether this node IS the top-level
    // window. Total: any failure reads as handle 0.
    let mut note_node = |node: &IUIAutomationElement| -> bool {
        let handle = get_i32_property(node, UIA_NativeWindowHandlePropertyId);
        if handle == 0 {
            return false;
        }
        if root_hwnd == 0 {
            root_hwnd = top_level_hwnd(handle);
        }
        handle as i64 == root_hwnd
    };

    let control_type_id = get_i32_property(element, UIA_ControlTypePropertyId);
    let name = get_string_property(element, UIA_NamePropertyId);
    let tag = control_type_name(control_type_id);

    let segment = if name.is_empty() {
        tag.to_string()
    } else {
        format!("{tag}:{name}")
    };
    path.push(segment);
    if note_node(element) {
        root_pre_index = Some(0);
    }
    // The language of the nearest node, from the element up to its top-level
    // window, that reports one. Once the window root is found, nodes above it
    // are not asked: the desktop is not part of the application. An ancestor's
    // answer counts only when the walk confirmed the window root, since
    // without one nothing shows the ancestor was inside the window.
    let own_language = get_culture_tag(element);
    let mut inherited_language = String::new();

    let walker = uia.ControlViewWalker().ok();

    if let Some(walker) = walker {
        let mut current = element.clone();
        for _ in 0..MAX_TREE_PATH_ANCESTORS {
            match walker.GetParentElement(&current) {
                Ok(parent) => {
                    let parent_type_id = get_i32_property(&parent, UIA_ControlTypePropertyId);
                    let parent_name = get_string_property(&parent, UIA_NamePropertyId);
                    let parent_tag = control_type_name(parent_type_id);

                    let seg = if parent_name.is_empty() {
                        parent_tag.to_string()
                    } else {
                        format!("{parent_tag}:{parent_name}")
                    };
                    path.push(seg);
                    let within_window = root_pre_index.is_none();
                    if note_node(&parent) && root_pre_index.is_none() {
                        root_pre_index = Some(path.len() - 1);
                    }
                    if within_window && own_language.is_empty() && inherited_language.is_empty() {
                        inherited_language = get_culture_tag(&parent);
                    }
                    current = parent;
                }
                Err(_) => break,
            }
        }
    }

    path.reverse();
    // Convert the pre-reverse index to the post-reverse offset. The offset
    // stands on its own: it records that the root node was positively
    // identified IN the path, independent of scope resolution below.
    let window_root_offset = root_pre_index.map(|i| path.len() - 1 - i);

    let window_root = if root_hwnd != 0 {
        uia.ElementFromHandle(UIA_HWND(root_hwnd as isize as *mut _))
            .ok()
    } else {
        None
    };

    let language = if !own_language.is_empty() {
        own_language
    } else if root_pre_index.is_some() {
        inherited_language
    } else {
        String::new()
    };

    (path, window_root_offset, window_root, root_hwnd, language)
}

// ---------------------------------------------------------------------------
// File dialog helpers (used by WindowsAccessibilityBackend)
// ---------------------------------------------------------------------------

/// The condition matching a control of `control_type_id` whose AutomationId is
/// `automation_id`. Both tests ride one condition, so a search over a file
/// dialog returns only the controls it names, never every control of the type
/// (the item view holds an Edit per item).
unsafe fn type_and_automation_id_condition(
    uia: &IUIAutomation,
    control_type_id: i32,
    automation_id: &str,
) -> Option<IUIAutomationCondition> {
    let type_condition = uia
        .CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            Variant::from(control_type_id).as_raw(),
        )
        .ok()?;
    let id_condition = uia
        .CreatePropertyCondition(
            UIA_AutomationIdPropertyId,
            bstr_variant(automation_id).as_raw(),
        )
        .ok()?;
    uia.CreateAndCondition(&type_condition, &id_condition).ok()
}

/// The Value of the first Edit under `parent` with AutomationId
/// `automation_id`, as it is — empty for an empty box; none when no such
/// Edit exists. Its Name is the label beside the box ("File name:"), never
/// its content.
unsafe fn edit_value_by_automation_id(
    uia: &IUIAutomation,
    parent: &IUIAutomationElement,
    automation_id: &str,
) -> Option<String> {
    use super::uia_core_api::UIA_EditControlTypeId;
    use super::win32_bindings::TreeScope_Descendants;

    let condition = type_and_automation_id_condition(uia, UIA_EditControlTypeId.0, automation_id)?;
    let edit = parent.FindFirst(TreeScope_Descendants, &condition).ok()?;
    Some(get_string_property(&edit, UIA_ValueValuePropertyId))
}

/// The text of a file dialog's File name box: the Edit an Open dialog gives
/// AutomationId 1148 (the cmb13 combo box's id), else the one a Save dialog
/// gives 1001 (the edt1 id) — the first that exists, by its Value; none when
/// neither exists or the box is empty.
unsafe fn file_name_box_text(
    uia: &IUIAutomation,
    dialog_element: &IUIAutomationElement,
) -> Option<String> {
    ["1148", "1001"]
        .into_iter()
        .find_map(|id| edit_value_by_automation_id(uia, dialog_element, id))
        .filter(|text| !text.is_empty())
}

/// Find a child Edit element by AutomationId and return its non-empty Value.
pub(crate) unsafe fn find_child_value_by_automation_id(
    uia: &IUIAutomation,
    parent: &IUIAutomationElement,
    target_automation_id: &str,
) -> Option<String> {
    use super::uia_core_api::UIA_EditControlTypeId;
    use super::win32_bindings::TreeScope_Descendants;

    let edit_condition =
        type_and_automation_id_condition(uia, UIA_EditControlTypeId.0, target_automation_id)?;

    let all_edits = parent
        .FindAll(TreeScope_Descendants, &edit_condition)
        .ok()?;

    let count = all_edits.Length().ok()?;
    for i in 0..count {
        if let Ok(child) = all_edits.GetElement(i) {
            let value = get_string_property(&child, UIA_ValueValuePropertyId);
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// Read the current directory from a file dialog's address bar / breadcrumb.
pub(crate) unsafe fn read_file_dialog_directory(
    uia: &IUIAutomation,
    dialog_element: &IUIAutomationElement,
) -> Option<String> {
    use super::win32_bindings::TreeScope_Descendants;

    // Strategy 1: Look for the address bar edit with AutomationId "41477".
    if let Some(addr) = find_child_value_by_automation_id(uia, dialog_element, "41477") {
        if !addr.is_empty() {
            return Some(addr);
        }
    }

    // Strategy 2: Look for a ToolBar with AutomationId "1001" — the breadcrumb
    // bar. Its Name is the current path behind a label ("Address: " on an
    // English system), which is not part of the path.
    let toolbar_condition =
        type_and_automation_id_condition(uia, UIA_ToolBarControlTypeId.0, "1001")?;

    let toolbars = dialog_element
        .FindAll(TreeScope_Descendants, &toolbar_condition)
        .ok()?;

    let count = toolbars.Length().ok()?;
    for i in 0..count {
        if let Ok(tb) = toolbars.GetElement(i) {
            let name = get_string_property(&tb, UIA_NamePropertyId);
            if let Some(path) = super::element_mapping::path_in_address_label(&name) {
                return Some(path.to_string());
            }
        }
    }

    None
}

/// The most folder entries [`file_on_disk`] looks at for one File name text;
/// past it the text is decided to name no one file, so the cost of the
/// lookup stays bounded in a folder of any size.
const FILE_DIALOG_CANDIDATE_LIMIT: usize = 64;

/// The file on disk a file dialog's shown path names (see
/// [`AccessibilityBackend::file_on_disk`]). The files the text can be shown
/// for are the ones the folder lists under the text followed by an extension
/// (`<text>.*`, which also lists `<text>` itself), each with the name the
/// shell displays for it ([`shell_display_name`]); the typed path itself
/// counts where it is a file.
fn file_on_disk(shown_path: &str) -> Option<String> {
    use super::win32_bindings::{
        FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
        FILE_ATTRIBUTE_DIRECTORY, WIN32_FIND_DATAW,
    };

    // A path that is not a full one (no folder was read, or the text is
    // relative) would resolve against this process's working directory.
    if !super::element_mapping::is_full_path(shown_path) {
        return None;
    }
    let (directory, text) = shown_path.rsplit_once('\\')?;
    let typed_path_is_file = std::path::Path::new(shown_path).is_file();
    let mut listed = Vec::new();
    // A text holding a wildcard is a filter the dialog applies, not a name.
    if !text.is_empty() && !text.contains(['*', '?']) {
        let pattern: Vec<u16> = format!("{shown_path}.*")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut data = WIN32_FIND_DATAW::default();
        let find = unsafe {
            FindFirstFileExW(
                windows_core::PCWSTR(pattern.as_ptr()),
                FindExInfoBasic,
                &mut data as *mut WIN32_FIND_DATAW as *mut core::ffi::c_void,
                FindExSearchNameMatch,
                None,
                0,
            )
        };
        if find != INVALID_HANDLE_VALUE {
            let mut seen = 0;
            let mut complete = false;
            while seen < FILE_DIALOG_CANDIDATE_LIMIT {
                seen += 1;
                if data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY as u32 == 0 {
                    let path = format!("{directory}\\{}", wide_until_nul(&data.cFileName));
                    if let Some(display) = shell_display_name(&path) {
                        listed.push((display, path));
                    }
                }
                if !unsafe { FindNextFileW(find, &mut data) }.as_bool() {
                    complete = true;
                    break;
                }
            }
            unsafe {
                let _ = FindClose(find);
            }
            if !complete {
                return None;
            }
        }
    }
    super::element_mapping::chosen_file_on_disk(shown_path, typed_path_is_file, &listed)
}

/// The name the shell displays for the file at `path`, as a folder view
/// shows it (`SHGFI_DISPLAYNAME`): without its extension where the system
/// hides extensions.
fn shell_display_name(path: &str) -> Option<String> {
    use super::win32_bindings::{SHGetFileInfoW, SHFILEINFOW, SHGFI_DISPLAYNAME};

    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut info = SHFILEINFOW::default();
    let found = unsafe {
        SHGetFileInfoW(
            windows_core::PCWSTR(wide.as_ptr()),
            0,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_DISPLAYNAME as u32,
        )
    };
    (found != 0).then(|| wide_until_nul(&info.szDisplayName))
}

/// The text in a fixed UTF-16 buffer, up to its first NUL.
fn wide_until_nul(buffer: &[u16]) -> String {
    let len = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

// ---------------------------------------------------------------------------
// Window enumeration
// ---------------------------------------------------------------------------

fn list_visible_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    let mut windows: Vec<WindowInfo> = Vec::new();

    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut windows as *mut Vec<WindowInfo> as isize),
        );
    }

    Ok(windows)
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    let owner = GetWindow(hwnd, GW_OWNER as u32);
    if !owner.0.is_null() {
        return BOOL(1);
    }

    let title = get_window_title(hwnd);
    if title.is_empty() {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process_name = get_process_name_for_pid(pid);

    let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    windows.push(WindowInfo {
        window_id: hwnd.0 as i64,
        title,
        process_name,
        pid,
    });

    BOOL(1)
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

pub(crate) unsafe fn get_window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, PWSTR(buf.as_mut_ptr()), buf.len() as i32);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

pub(crate) unsafe fn get_class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, PWSTR(buf.as_mut_ptr()), buf.len() as i32);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

pub(crate) unsafe fn get_process_name_for_hwnd(hwnd: HWND) -> String {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    get_process_name_for_pid(pid)
}

fn get_process_name_for_pid(pid: u32) -> String {
    process_exe_name(pid).unwrap_or_else(|| format!("pid:{pid}"))
}

/// The executable file name of the process `pid`, read from the process;
/// `None` when it cannot be opened or read (it has exited, or access is
/// refused).
fn process_exe_name(pid: u32) -> Option<String> {
    use super::win32_bindings::{
        GetModuleFileNameExW, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let h = valid_handle(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION as u32,
            false,
            pid,
        ))?;
        let mut buf = [0u16; 512];
        let len = GetModuleFileNameExW(Some(h), None, PWSTR(buf.as_mut_ptr()), buf.len() as u32);
        let _ = CloseHandle(h);
        if len == 0 {
            return None;
        }
        let full_path = String::from_utf16_lossy(&buf[..len as usize]);
        Some(
            full_path
                .rsplit('\\')
                .next()
                .unwrap_or(&full_path)
                .to_string(),
        )
    }
}

pub(crate) fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) unsafe fn get_modifier_state() -> (bool, bool, bool, bool) {
    let ctrl = GetAsyncKeyState(VK_CONTROL) < 0;
    let shift = GetAsyncKeyState(VK_SHIFT) < 0;
    let alt = GetAsyncKeyState(VK_MENU) < 0;
    let meta = GetAsyncKeyState(VK_LWIN) < 0 || GetAsyncKeyState(VK_RWIN) < 0;
    (ctrl, shift, alt, meta)
}

// ---------------------------------------------------------------------------
// WindowsAccessibilityBackend
// ---------------------------------------------------------------------------

/// Windows-specific implementation of the [`AccessibilityBackend`] trait.
///
/// Each worker thread creates its own instance. The `init()` method
/// initialises a COM STA apartment and creates an `IUIAutomation` instance.
/// The `cleanup()` method drops the COM interface and calls `CoUninitialize`.
///
/// # Safety — `Send` impl
///
/// `IUIAutomation` is a COM interface that lives in a COM STA apartment.
/// COM STA objects are normally not `Send` because they must be accessed from
/// the thread that created them. In our architecture each worker creates its
/// own COM apartment and its own `IUIAutomation` instance, and the backend is
/// moved into the worker thread *before* `init()` is called. The `uia` field
/// is `None` during the move and is only populated on the worker thread.
/// Therefore the `Send` bound is safe.
pub struct WindowsAccessibilityBackend {
    uia: Option<IUIAutomation>,
    /// The element last described by `focused_element_marked`, kept so
    /// `focused_is_marked` can ask UIA whether the focused element is that
    /// very element. `None` during the move into the worker thread, like
    /// `uia`; set, read and dropped (in `cleanup`) on that thread only.
    marked: std::cell::RefCell<Option<IUIAutomationElement>>,
}

impl WindowsAccessibilityBackend {
    /// The element of the control with window handle `control` and what the
    /// control is right now; `None` when the window is gone or UI Automation
    /// gives no element for it.
    ///
    /// The control holds the focus only itself when nothing below it can take
    /// the keyboard focus. `FindFirst` answers "none" as a null element, which
    /// arrives here as an error that carries a success code; any real failure
    /// leaves the question open, and an open question is answered as a window
    /// that holds others.
    unsafe fn control_element(
        &self,
        control: i64,
    ) -> Option<(IUIAutomationElement, ControlNature)> {
        let uia = self.uia.as_ref()?;
        let hwnd = HWND(control as *mut _);
        if control == 0 || !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }
        let element = uia
            .ElementFromHandle(UIA_HWND(control as isize as *mut _))
            .ok()?;
        let Ok(focusable) = uia.CreatePropertyCondition(
            UIA_IsKeyboardFocusablePropertyId,
            Variant::from(true).as_raw(),
        ) else {
            return Some((element, ControlNature::Shared));
        };
        let nature = match element.FindFirst(TreeScope_Descendants, &focusable) {
            Err(none) if none.code().is_ok() => ControlNature::Own {
                password: get_is_password(&element),
            },
            _ => ControlNature::Shared,
        };
        Some((element, nature))
    }
}

// SAFETY: See doc comment on the struct. The IUIAutomation instance is created
// and used exclusively on the worker thread that owns this backend.
unsafe impl Send for WindowsAccessibilityBackend {}

impl WindowsAccessibilityBackend {
    /// Create a new backend with no COM initialisation.
    /// Call `init()` on the worker thread to set up COM and UIA.
    pub fn new() -> Self {
        Self {
            uia: None,
            marked: std::cell::RefCell::new(None),
        }
    }
}

impl Default for WindowsAccessibilityBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AccessibilityBackend for WindowsAccessibilityBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        unsafe {
            // MTA (multithreaded apartment), not STA. These worker threads are
            // pure UI Automation *clients*: they own no windows and run no
            // message pump. Microsoft's UIA threading guidance prescribes MTA
            // for exactly this profile (separate thread, no windows, calls UIA
            // across the desktop including the app's own UI):
            // https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading
            //
            // The previous STA model was a latent deadlock: an STA thread must
            // pump messages while a cross-apartment/cross-process UIA call is
            // outstanding, but these workers never pump — so a UIA call against
            // an unresponsive window could hang the worker indefinitely (the
            // root cause behind the capture.stop() hangs). MTA removes the pump
            // obligation; COM marshals calls without requiring the caller to
            // pump. Each worker owns its own IUIAutomation instance and never
            // marshals live elements across threads, so the MTA element-affinity
            // caveat does not apply.
            CoInitializeEx(None, COINIT_MULTITHREADED as u32)
                .ok()
                .map_err(|e| CaptureError::ComInit(e.to_string()))?;
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL as u32)
                .map_err(|e| CaptureError::ComInit(format!("IUIAutomation: {e}")))?;
            self.uia = Some(uia);
        }
        warm_layout_tables();
        Ok(())
    }

    fn cleanup(&mut self) {
        // Drop the COM interfaces before uninitialising COM.
        *self.marked.borrow_mut() = None;
        self.uia = None;
        unsafe {
            CoUninitialize();
        }
    }

    fn element_at_point(&self, x: i32, y: i32) -> Option<ElementDescription> {
        let uia = self.uia.as_ref()?;
        let pt = POINT { x, y };
        let element = unsafe { uia.ElementFromPoint(pt).ok()? };
        unsafe { uia_element_to_description(uia, &element) }
    }

    fn focused_element(&self) -> Option<ElementDescription> {
        let uia = self.uia.as_ref()?;
        let focused = unsafe { uia.GetFocusedElement().ok()? };
        unsafe { uia_element_to_description(uia, &focused) }
    }

    fn focused_element_in_window(&self) -> Option<(ElementDescription, i64)> {
        let uia = self.uia.as_ref()?;
        let focused = unsafe { uia.GetFocusedElement().ok()? };
        unsafe { uia_element_to_description_in_window(uia, &focused) }
    }

    fn focused_element_marked(&self) -> Option<ElementDescription> {
        // Nothing is marked unless this call describes an element.
        *self.marked.borrow_mut() = None;
        let uia = self.uia.as_ref()?;
        let focused = unsafe { uia.GetFocusedElement().ok()? };
        let description = unsafe { uia_element_to_description(uia, &focused)? };
        *self.marked.borrow_mut() = Some(focused);
        Some(description)
    }

    fn focused_is_marked(&self) -> Option<bool> {
        let uia = self.uia.as_ref()?;
        let marked = self.marked.borrow();
        let marked = marked.as_ref()?;
        unsafe {
            let focused = uia.GetFocusedElement().ok()?;
            Some(uia.CompareElements(marked, &focused).ok()?.as_bool())
        }
    }

    fn focus_epoch(&self) -> u64 {
        FOCUS_EPOCH.load(Ordering::SeqCst)
    }

    fn focus_events_dispatched(&self) -> u64 {
        FOCUS_EVENTS_DISPATCHED.load(Ordering::SeqCst)
    }

    fn context_introduced_before(&self, window: i64, sequence_id: u64) -> bool {
        CONTEXTS_INTRODUCED_AT.introduced_before(window, sequence_id)
    }

    fn keys_dispatched(&self, window: i64) -> u64 {
        KEYS_DISPATCHED.latest(window)
    }

    fn is_foreground_window(&self, window_handle: i64) -> bool {
        if window_handle == 0 {
            return false;
        }
        let hwnd = HWND(window_handle as *mut _);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return false;
            }
            let foreground = GetForegroundWindow();
            if foreground.0.is_null() {
                return false;
            }
            // Compare top-level windows: a value change comes from a control
            // inside the window, a keystroke from the window itself.
            let root_of = |h: HWND| {
                let root = GetAncestor(h, GA_ROOT as u32);
                if root.0.is_null() {
                    h.0
                } else {
                    root.0
                }
            };
            root_of(hwnd) == root_of(foreground)
        }
    }

    fn focused_control(&self) -> i64 {
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.0.is_null() {
                return 0;
            }
            focused_control_of_thread(GetWindowThreadProcessId(foreground, None))
        }
    }

    fn control_nature(&self, control: i64) -> ControlNature {
        match unsafe { self.control_element(control) } {
            Some((_, nature)) => nature,
            None => ControlNature::Gone,
        }
    }

    fn describe_control(&self, control: i64) -> ControlLook {
        let Some(uia) = self.uia.as_ref() else {
            return ControlLook::Gone;
        };
        unsafe {
            match self.control_element(control) {
                Some((element, ControlNature::Own { .. })) => {
                    match uia_element_to_description(uia, &element) {
                        Some(description) => ControlLook::Own(Box::new(description)),
                        None => ControlLook::Gone,
                    }
                }
                Some((_, ControlNature::Shared)) => ControlLook::Shared,
                _ => ControlLook::Gone,
            }
        }
    }

    fn control_value(&self, control: i64) -> Option<String> {
        let uia = self.uia.as_ref()?;
        let hwnd = HWND(control as *mut _);
        unsafe {
            if control == 0 || !IsWindow(Some(hwnd)).as_bool() {
                return None;
            }
            let element = uia
                .ElementFromHandle(UIA_HWND(control as isize as *mut _))
                .ok()?;
            // Cut as a description's text is.
            value_held(&element).map(|value| truncate_text(&value))
        }
    }

    fn window_title(&self, window_handle: i64) -> String {
        let hwnd = HWND(window_handle as *mut _);
        unsafe { get_window_title(hwnd) }
    }

    fn process_name(&self, window_handle: i64) -> String {
        let hwnd = HWND(window_handle as *mut _);
        unsafe { get_process_name_for_hwnd(hwnd) }
    }

    fn process_name_of(&self, process_id: u32) -> Option<String> {
        process_exe_name(process_id)
    }

    fn key_value(&self, layout: i64, key_code: u32, held: super::key_value::Held) -> u32 {
        layout_key_value(layout, key_code, held)
    }

    fn composed(
        &self,
        layout: i64,
        accent: char,
        base: char,
    ) -> Option<super::layout_file::Composed> {
        layout_composed(layout, accent, base)
    }

    fn process_id_of(&self, window_handle: i64) -> u32 {
        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(HWND(window_handle as *mut _), Some(&mut process_id));
        }
        process_id
    }

    /// A `WM_NULL` sent to the control's own window, which its thread
    /// answers once it is back at its message loop; a thread the system
    /// already counts as hung is not waited on at all.
    fn answers_promptly(&self, control: i64) -> bool {
        unsafe {
            SendMessageTimeoutW(
                HWND(control as *mut _),
                WM_NULL as u32,
                WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG as u32,
                super::worker_pool::PROMPT_ANSWER_MS,
                None,
            )
            .0 != 0
        }
    }

    fn read_file_dialog_path(&self, window_handle: i64) -> Option<(String, String)> {
        let uia = self.uia.as_ref()?;
        // A click names the control under the pointer (the Open button, the
        // item view), a child of the dialog: the dialog is its root window.
        let hwnd = HWND(self.root_window_handle(window_handle) as *mut _);

        // Check if the window is a file dialog (class name #32770).
        let class_name = unsafe { get_class_name(hwnd) };
        if class_name != "#32770" {
            return None;
        }

        // Determine dialog type from the window title.
        let title = unsafe { get_window_title(hwnd) };
        let title_lower = title.to_lowercase();
        let dialog_type = if title_lower.contains("save as") {
            "save_as"
        } else if title_lower.contains("save") {
            "save"
        } else if title_lower.contains("open") {
            "open"
        } else {
            return None;
        };

        // Read the file path from the dialog's UIA tree.
        unsafe {
            let dialog_element = uia.ElementFromHandle(UIA_HWND(hwnd.0)).ok()?;

            // The File name box's text: the name as the dialog shows it,
            // without the extension where the system hides extensions.
            let filename = file_name_box_text(uia, &dialog_element)?;

            // Try to read the current directory from the breadcrumb/address bar.
            let directory = read_file_dialog_directory(uia, &dialog_element);

            let file_path =
                super::element_mapping::typed_file_path(directory.as_deref(), &filename);

            Some((dialog_type.to_string(), file_path))
        }
    }

    fn file_on_disk(&self, shown_path: &str) -> Option<String> {
        file_on_disk(shown_path)
    }

    fn root_window_handle(&self, window_handle: i64) -> i64 {
        let hwnd = HWND(window_handle as *mut _);
        let root = unsafe { GetAncestor(hwnd, GA_ROOT as u32) };
        if root.0.is_null() {
            window_handle
        } else {
            root.0 as i64
        }
    }

    fn window_rect(&self, window_handle: i64) -> Option<super::WindowRect> {
        use super::win32_bindings::{GetWindowRect, RECT};

        let hwnd = HWND(window_handle as *mut _);
        let root = unsafe { GetAncestor(hwnd, GA_ROOT as u32) };
        let target = if root.0.is_null() { hwnd } else { root };

        let mut rect = RECT::default();
        let ok = unsafe { GetWindowRect(target, &mut rect) };
        if ok.as_bool() {
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            // Return None for zero-size rects (window already destroyed or invalid)
            if width <= 0 || height <= 0 {
                return None;
            }
            Some(super::WindowRect {
                x: rect.left,
                y: rect.top,
                width,
                height,
            })
        } else {
            None
        }
    }

    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        let uia = self.uia.as_ref()?;
        let focused = unsafe { uia.GetFocusedElement().ok()? };

        // Try to get the SelectionPattern from the focused element.
        let pattern: IUIAutomationSelectionPattern = unsafe {
            let pattern_obj = focused.GetCurrentPattern(UIA_SelectionPatternId).ok()?;
            pattern_obj.cast().ok()?
        };

        // Get the current selection array.
        let selection = unsafe { pattern.GetCurrentSelection().ok()? };
        let count = unsafe { selection.Length().ok()? };
        if count == 0 {
            return None;
        }

        // Get the first selected element.
        let selected_element = unsafe { selection.GetElement(0).ok()? };

        // Build the element description for the selected item.
        let description = unsafe { uia_element_to_description(uia, &selected_element)? };

        // Get the name of the selected item.
        let name = unsafe { get_string_property(&selected_element, UIA_NamePropertyId) };

        Some((description, name))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{
        control_type_name, get_parent_pid, get_process_exe_name, is_descendant_of,
        is_password_value, is_recognized_by_exe_name, layout_char, windows_should_keep_event,
        GetCurrentThreadId, MapVirtualKeyExW, Variant, BSTR, HKL, VT_EMPTY,
    };
    use crate::capture::key_value::{
        answer_of, dead_as_held_of, key_value_name, value_as_pressed, Held, LayoutAnswer,
        LayoutAnswers,
    };
    use crate::capture::uia_core_api::UiaGetReservedNotSupportedValue;
    use crate::capture::win32_bindings::VARIANT;
    use crate::capture::win32_bindings::{
        GetKeyboardLayoutList, LoadKeyboardLayoutW, UnloadKeyboardLayout, KLF_NOTELLSHELL,
        MAPVK_VSC_TO_VK,
    };
    use crate::capture::worker_pool::is_punctuation_key;

    // -- a process named by its id (docent#761) -------------------------------

    /// A process is named by its id as its windows are named, with no window
    /// needed: the name a context switch states when its window closed before
    /// a worker got to it. The test process names itself.
    #[test]
    fn a_process_is_named_by_its_id_as_its_windows_are() {
        let backend = super::WindowsAccessibilityBackend::new();
        let exe = std::env::current_exe().unwrap();
        let expected = exe.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            super::AccessibilityBackend::process_name_of(&backend, std::process::id()),
            Some(expected)
        );
    }

    /// A process that has exited is named by no id: the switch then falls
    /// back to its window, and never states "pid:<n>" as a name read by id.
    #[test]
    fn a_process_that_has_exited_is_named_by_no_id() {
        let backend = super::WindowsAccessibilityBackend::new();
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        drop(child);
        assert_eq!(
            super::AccessibilityBackend::process_name_of(&backend, pid),
            None
        );
    }

    /// The Input_Thread reads a window's title with a foreground event, the
    /// title a switch written after its window closed keeps (docent#801): a
    /// titled window gives its title, and a window that is gone gives none.
    #[test]
    fn a_window_s_title_is_read_with_its_foreground_event_and_none_once_it_is_gone() {
        use crate::capture::win32_bindings::{CreateWindowExW, DestroyWindow};
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                windows_core::w!("STATIC"),
                windows_core::w!("Docent title read"),
                0,
                0,
                0,
                100,
                100,
                None,
                None,
                None,
                Some(std::ptr::null()),
            )
        };
        assert!(!hwnd.0.is_null(), "failed to create a window");
        assert_eq!(
            super::input_window_title(hwnd),
            Some("Docent title read".to_string())
        );
        assert!(
            unsafe { DestroyWindow(hwnd) }.as_bool(),
            "failed to destroy the window"
        );
        assert_eq!(super::input_window_title(hwnd), None);
    }

    // -- a punctuation key's layout character (docent#691) --------------------

    /// A keyboard layout loaded for a test, by its layout id, and unloaded
    /// when the test ends unless it was loaded before.
    struct LoadedLayout {
        hkl: HKL,
        unload: bool,
    }

    impl LoadedLayout {
        fn load(id: &str, language: usize) -> Self {
            let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
            // SAFETY: the list is read into a buffer of the size the first call
            // reports, and the id is a NUL-terminated UTF-16 string that lives
            // across the call.
            unsafe {
                let mut loaded = vec![HKL::default(); GetKeyboardLayoutList(0, None) as usize];
                let n = GetKeyboardLayoutList(loaded.len() as i32, Some(loaded.as_mut_ptr()));
                loaded.truncate(n.max(0) as usize);
                let hkl = LoadKeyboardLayoutW(
                    windows_core::PCWSTR(wide.as_ptr()),
                    KLF_NOTELLSHELL as u32,
                );
                assert!(!hkl.0.is_null(), "layout {id} must load");
                // The language half of the handle: the layout asked for, not a
                // substitute.
                assert_eq!(hkl.0 as usize & 0xFFFF, language, "layout {id}");
                LoadedLayout {
                    hkl,
                    unload: !loaded.contains(&hkl),
                }
            }
        }

        /// The virtual-key code this layout gives the key at `scan_code`.
        fn vk_at(&self, scan_code: u32) -> u32 {
            // SAFETY: a read of a loaded layout's tables.
            unsafe { MapVirtualKeyExW(scan_code, MAPVK_VSC_TO_VK as u32, Some(self.hkl)) }
        }

        /// This layout's answers for every key and combination of modifiers,
        /// as the keyboard hook takes them.
        fn answers(&self) -> Box<LayoutAnswers> {
            let mut answers = Box::new(LayoutAnswers::new());
            // SAFETY: reads of a loaded layout's tables that leave the key state.
            assert!(
                unsafe { super::fill_layout_answers(self.hkl, &mut answers) },
                "the layout's answers must be taken"
            );
            answers
        }
    }

    /// The `key` value of typing key `vk` pressed with `held`, from a
    /// layout's answers.
    fn value(answers: &LayoutAnswers, hkl: HKL, vk: u32, held: Held) -> String {
        key_value_name(value_as_pressed(held, |with| {
            answers.get(hkl.0 as isize, vk, with)
        }))
    }

    const PLAIN: Held = Held {
        shift: false,
        ctrl: false,
        alt: false,
        caps_lock: false,
    };
    const SHIFT: Held = Held {
        shift: true,
        ..PLAIN
    };
    const CAPS_LOCK: Held = Held {
        caps_lock: true,
        ..PLAIN
    };
    const CTRL: Held = Held {
        ctrl: true,
        ..PLAIN
    };
    const ALT_GR: Held = Held {
        ctrl: true,
        alt: true,
        ..PLAIN
    };

    // Regression: #717 — the desktop named a key by its code, where the
    // extension names what the press means on the layout.
    // https://github.com/Arsarneq/docent/issues/717
    #[test]
    #[serial_test::serial(danish_layout)]
    fn regression_717_the_danish_layout_names_a_key_by_what_the_press_gives() {
        if !super::layout_read_leaves_key_state() {
            return; // a Windows before 10.0.14393: the layout is not asked
        }
        let danish = LoadedLayout::load("00000406", 0x0406);
        let answers = danish.answers();
        let key = |vk, held| value(&answers, danish.hkl, vk, held);
        // A letter in the case the press gives it; Ctrl gives no character,
        // so the key is named by its Shift and Caps Lock state alone.
        assert_eq!(key(0x41, PLAIN), "a");
        assert_eq!(key(0x41, SHIFT), "A");
        assert_eq!(key(0x41, CAPS_LOCK), "A");
        assert_eq!(key(0x41, CTRL), "a");
        assert_eq!(
            key(
                0x41,
                Held {
                    shift: true,
                    ..CTRL
                }
            ),
            "A"
        );
        // 1 with Shift, the key right of 0 alone and with Shift, AltGr and E.
        assert_eq!(key(0x31, SHIFT), "!");
        assert_eq!(key(0xBB, PLAIN), "+");
        assert_eq!(key(0xBB, SHIFT), "?");
        assert_eq!(key(0x45, ALT_GR), "\u{20ac}");
        // The key right of L (scan code 0x27) is `æ`.
        let ae = danish.vk_at(0x27);
        assert_eq!(key(ae, PLAIN), "æ");
        assert_eq!(key(ae, SHIFT), "Æ");
        assert_eq!(key(ae, CAPS_LOCK), "Æ");
        // The key right of `+` (scan code 0x0D): a dead key alone and with
        // Shift, `|` with AltGr.
        let acute = danish.vk_at(0x0D);
        assert_eq!(key(acute, PLAIN), "Dead");
        assert_eq!(key(acute, SHIFT), "Dead");
        assert_eq!(key(acute, ALT_GR), "|");
        // The space bar, and the numeric keypad with Num Lock on: the
        // decimal key gives a comma.
        assert_eq!(key(0x20, PLAIN), "Space");
        assert_eq!(key(0x61, PLAIN), "1");
        assert_eq!(key(0x6B, PLAIN), "+");
        assert_eq!(key(0x6E, PLAIN), ",");
        // A code the layout gives nothing.
        assert_eq!(key(0x07, PLAIN), "Unidentified");
        // Taking the answers left no accent pending.
        // SAFETY: a read of a loaded layout's tables.
        assert!(unsafe { super::layout_has_no_accent_pending(danish.hkl) });
    }

    #[test]
    fn regression_717_the_us_layout_names_a_key_by_what_the_press_gives() {
        if !super::layout_read_leaves_key_state() {
            return;
        }
        let us = LoadedLayout::load("00000409", 0x0409);
        let answers = us.answers();
        let key = |vk, held| value(&answers, us.hkl, vk, held);
        assert_eq!(key(0xBB, PLAIN), "=");
        assert_eq!(key(0xBB, SHIFT), "+");
        assert_eq!(key(0xDE, PLAIN), "'");
        assert_eq!(key(0x32, SHIFT), "@");
        assert_eq!(key(0x6E, PLAIN), ".");
        // No AltGr on this layout: Ctrl and Alt give no character, and the
        // key is named by its own.
        assert_eq!(key(0x45, ALT_GR), "e");
    }

    // -- the key behind a dead key (docent#717) --------------------------------

    /// Every keyboard layout file of this Windows gives its list: the form
    /// the files are read in ([`crate::capture::layout_file`]) is the form
    /// they are built in. A file for another processor is none of them.
    #[test]
    fn regression_717_every_keyboard_layout_file_of_this_windows_gives_its_list() {
        use crate::capture::layout_file::{
            compositions_in, descriptor_bytes, Composed, LayoutFileError,
        };
        let folder = super::system_directory().expect("the system folder");
        let mut read = 0;
        let mut with_dead_keys = 0;
        let mut not_read = Vec::new();
        for entry in std::fs::read_dir(&folder).expect("the system folder is listed") {
            let path = entry.expect("an entry").path();
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !name.starts_with("kbd") || !name.ends_with(".dll") {
                continue;
            }
            let bytes = std::fs::read(&path).expect("a layout file is read");
            match compositions_in(&bytes) {
                Ok(list) => {
                    read += 1;
                    if !list.is_empty() {
                        with_dead_keys += 1;
                    }
                    if name == "kbdda.dll" {
                        assert_eq!(list.of('\u{b4}', 'e'), Some(Composed::Char('é')));
                        assert_eq!(list.of('\u{b4}', ' '), Some(Composed::Char('\u{b4}')));
                        assert_eq!(list.of('\u{a8}', 'u'), Some(Composed::Char('ü')));
                        assert_eq!(list.of('\u{b4}', 'q'), None);
                    }
                }
                // A file that is no layout's (a helper library named alike).
                Err(LayoutFileError::NoDescriptor | LayoutFileError::NotAnImage) => {}
                Err(why) => not_read.push(format!(
                    "{name}: {why} {:02X?}",
                    descriptor_bytes(&bytes).unwrap_or_default()
                )),
            }
        }
        assert!(not_read.is_empty(), "layout files not read: {not_read:#?}");
        assert!(read >= 100, "{read} layout files were read");
        assert!(with_dead_keys >= 20, "{with_dead_keys} have dead keys");
    }

    /// A layout's list is found from its handle: by the handle's own number
    /// (Danish), and by its layout id (United States-International).
    #[test]
    #[serial_test::serial(danish_layout)]
    fn regression_717_a_layouts_list_is_read_from_its_handle() {
        use crate::capture::layout_file::Composed;
        let danish = LoadedLayout::load("00000406", 0x0406);
        let layout = danish.hkl.0 as isize as i64;
        assert_eq!(
            super::layout_composed(layout, '\u{b4}', 'e'),
            Some(Composed::Char('é'))
        );
        assert_eq!(
            super::layout_composed(layout, '`', 'A'),
            Some(Composed::Char('À'))
        );
        assert_eq!(super::layout_composed(layout, '\u{b4}', 'q'), None);
        assert_eq!(super::layout_composed(0, '\u{b4}', 'e'), None);
        let international = LoadedLayout::load("00020409", 0x0409);
        let layout = international.hkl.0 as isize as i64;
        assert_eq!(
            super::layout_composed(layout, '\'', 'e'),
            Some(Composed::Char('é'))
        );
        // The plain United States layout has no dead key.
        let us = LoadedLayout::load("00000409", 0x0409);
        assert!(super::read_layout_list(us.hkl.0 as isize as i64)
            .expect("read")
            .is_empty());
    }

    /// The rule for the key behind a dead key, held against Windows' own
    /// translation of the keys, the one a program gets its characters from:
    /// on each layout, behind each of its accents, every key code with every
    /// combination of Shift, Ctrl, Alt and Caps Lock. The key is renamed
    /// exactly where Windows enters one character that is not the key's own,
    /// to that character, and the accent that waits afterwards is the one
    /// the rule says.
    ///
    /// The keys are translated with the read that takes them into the
    /// layout's keyboard state, as a program's own translation does; each
    /// round ends on a space, which takes any accent away.
    #[test]
    #[serial_test::serial(danish_layout)]
    fn regression_717_the_key_behind_a_dead_key_is_named_as_windows_enters_it() {
        use crate::capture::key_value::as_held_of;
        use crate::capture::key_value::pressed_param;
        use crate::capture::layout_file::Composed;
        use crate::capture::waiting_accents::{Named, WaitingAccents};
        if !super::layout_read_leaves_key_state() {
            return; // a Windows before 10.0.14393: the layout is not asked
        }
        let mut wrong = Vec::new();
        let mut rounds = 0_u32;
        for (id, language) in [
            ("00000406", 0x0406),
            ("00020409", 0x0409),
            ("00000407", 0x0407),
            ("0000040C", 0x040C),
            ("0000040A", 0x040A),
            ("00000405", 0x0405),
        ] {
            let loaded = LoadedLayout::load(id, language);
            let layout = loaded.hkl.0 as isize as i64;
            let answers = loaded.answers();
            let list = super::read_layout_list(layout).expect("the layout's list");
            let as_held = |vk: u32, held: Held| {
                as_held_of(pressed_param(held, |with| {
                    answers.get(loaded.hkl.0 as isize, vk, with)
                }))
            };
            // Windows' own translation of a key-down, taken into the
            // layout's keyboard state.
            let press = |vk: u32, held: Held| -> (i32, [u16; 8]) {
                let mut state = [0u8; 256];
                if held.shift {
                    state[0x10] = 0x80;
                }
                if held.ctrl {
                    state[0x11] = 0x80;
                }
                if held.alt {
                    state[0x12] = 0x80;
                }
                if held.caps_lock {
                    state[0x14] = 0x01;
                }
                let mut entered = [0u16; 8];
                // SAFETY: a keyboard-state read; the accent it can leave
                // pending is taken out by the space that ends each round.
                let answered = unsafe {
                    super::ToUnicodeEx(
                        vk,
                        0,
                        state.as_ptr(),
                        windows_core::PWSTR(entered.as_mut_ptr()),
                        8,
                        0,
                        Some(loaded.hkl),
                    )
                };
                (answered, entered)
            };
            // One dead key for each accent of the layout.
            let mut dead_keys: Vec<(u32, Held, char)> = Vec::new();
            for vk in 0..256_u32 {
                for combination in 0..16 {
                    let held = Held::from_index(combination);
                    if let Some(LayoutAnswer::Dead(accent)) = as_held(vk, held) {
                        if !dead_keys.iter().any(|(_, _, known)| *known == accent) {
                            dead_keys.push((vk, held, accent));
                        }
                    }
                }
            }
            if id == "00000406" {
                assert_eq!(
                    dead_keys.len(),
                    5,
                    "the Danish layout's accents: {dead_keys:?}"
                );
            }
            for &(dead_vk, dead_held, accent) in &dead_keys {
                for vk in 0..256_u32 {
                    for combination in 0..16 {
                        let held = Held::from_index(combination);
                        rounds += 1;
                        // What Windows does.
                        let dead = press(dead_vk, dead_held);
                        let (answered, entered) = press(vk, held);
                        let space = press(0x20, PLAIN);
                        // What the rule says.
                        let mut accents = WaitingAccents::new();
                        let of = |a: char, b: char| list.of(a, b);
                        accents.press(layout, as_held(dead_vk, dead_held), of);
                        let key = as_held(vk, held);
                        let named = accents.press(layout, key, of);
                        let waits = accents.waiting_on(layout);

                        // The key is renamed where Windows enters one
                        // character, no control character, that is not the
                        // key's own.
                        let own = match key {
                            Some(LayoutAnswer::Char(own)) => Some(own),
                            _ => None,
                        };
                        let entered_one = (answered == 1)
                            .then(|| char::from_u32(u32::from(entered[0])))
                            .flatten()
                            .filter(|c| !c.is_control());
                        let renamed_by_windows = entered_one.filter(|c| Some(*c) != own);
                        let renamed_by_rule = match named {
                            Named::Composed(made) => Some(made).filter(|c| Some(*c) != own),
                            Named::AsPressed => None,
                            Named::NotKnown => Some('\u{fffd}'),
                        };
                        // What waits afterwards, read from what the space
                        // entered: the space alone with no accent, what the
                        // accent makes with a space, or the accent and the
                        // space one after the other.
                        let space_expected = match waits {
                            None => Some((1, [0x20, 0])),
                            Some(waiting) => match list.of(waiting, ' ') {
                                Some(Composed::Char(made)) => Some((1, [made as u16, 0])),
                                None => Some((2, [waiting as u16, 0x20])),
                                Some(Composed::Dead(_)) => None,
                            },
                        };
                        let space_seen = (
                            space.0,
                            [space.1[0], if space.0 > 1 { space.1[1] } else { 0 }],
                        );
                        let agree = dead.0 == -1
                            && renamed_by_windows == renamed_by_rule
                            && space_expected.is_none_or(|expected| expected == space_seen);
                        if !agree && wrong.len() < 60 {
                            wrong.push(format!(
                                "{id} accent {accent:?} key {vk:#04X} held {combination:#06b} \
                                 ({key:?}): dead key answered {}, Windows entered {answered} \
                                 {:04X?}, rule {named:?} with {waits:?} waiting, the space \
                                 entered {} {:04X?}",
                                dead.0,
                                &entered[..answered.clamp(0, 8) as usize],
                                space.0,
                                &space.1[..space.0.clamp(0, 8) as usize],
                            ));
                        }
                    }
                }
            }
            // No accent is left pending on the layout.
            // SAFETY: a read of a loaded layout's tables.
            assert!(unsafe { super::layout_has_no_accent_pending(loaded.hkl) });
        }
        assert!(
            wrong.is_empty(),
            "the rule and Windows differ in {} of {rounds} rounds (the first shown): {wrong:#?}",
            wrong.len()
        );
        assert!(
            rounds >= 5 * 4096,
            "{rounds} rounds were held against Windows"
        );
    }

    /// A worker's question goes through the tables kept for the process:
    /// the layout is asked once, and its answers serve every later key.
    #[test]
    #[serial_test::serial(danish_layout)]
    fn regression_717_a_worker_asks_a_layout_through_the_tables_kept() {
        if !super::layout_read_leaves_key_state() {
            return;
        }
        let danish = LoadedLayout::load("00000406", 0x0406);
        let layout = danish.hkl.0 as isize as i64;
        let read = |vk, held| super::layout_key_value(layout, vk, held);
        let ask = |vk, held| answer_of(read(vk, held));
        assert_eq!(ask(0x41, SHIFT), Some(LayoutAnswer::Char('A')));
        assert_eq!(ask(0x41, CTRL), Some(LayoutAnswer::Char('a')));
        assert_eq!(ask(0x07, PLAIN), Some(LayoutAnswer::Nothing));
        // The acute key: dead alone, a character with AltGr, and with Ctrl
        // named `Dead` by its plain state while the press makes no dead key.
        let acute = danish.vk_at(0x0D);
        assert_eq!(ask(acute, PLAIN), Some(LayoutAnswer::Dead('\u{b4}')));
        assert_eq!(dead_as_held_of(read(acute, PLAIN)), Some(true));
        assert_eq!(dead_as_held_of(read(acute, ALT_GR)), Some(false));
        assert_eq!(ask(acute, CTRL), Some(LayoutAnswer::Dead('\u{b4}')));
        assert_eq!(dead_as_held_of(read(acute, CTRL)), Some(false));
        let kept = || {
            super::LAYOUT_TABLES
                .lock()
                .unwrap()
                .iter()
                .filter(|table| table.is_of(layout as isize))
                .count()
        };
        assert_eq!(kept(), 1, "one table for the layout");
        // No layout, and an injected character, are not asked.
        assert_eq!(super::layout_key_value(0, 0x41, PLAIN), 0);
        assert_eq!(read(crate::capture::worker_pool::VK_PACKET, PLAIN), 0);
    }

    /// The hook's read: thread 0 names no layout.
    #[test]
    fn the_hook_reads_no_layout_for_thread_zero() {
        // SAFETY: two reads of the window system's state.
        unsafe {
            assert_eq!(super::foreground_layout_and_caps_lock(0).0, 0);
            assert_ne!(
                super::foreground_layout_and_caps_lock(GetCurrentThreadId()).0,
                0
            );
        }
    }

    #[test]
    fn the_layouts_answers_are_not_taken_from_no_layout() {
        let mut answers = Box::new(LayoutAnswers::new());
        // SAFETY: a null layout is answered without a call.
        assert!(!unsafe { super::fill_layout_answers(HKL::default(), &mut answers) });
        assert!(!answers.is_of(0));
    }

    impl Drop for LoadedLayout {
        fn drop(&mut self) {
            if self.unload {
                // SAFETY: a layout this test loaded and no longer uses.
                unsafe {
                    let _ = UnloadKeyboardLayout(self.hkl);
                }
            }
        }
    }

    /// The Danish layout asked about a key as pressed: the acute key is dead
    /// alone and with Shift (grave) and enters `|` with AltGr; the diaeresis
    /// key is dead alone, with Shift (circumflex) and with AltGr (tilde); a
    /// letter is none. Asking leaves the keyboard state as it is, so the same
    /// question gets the same answer twice and no accent is pending after.
    /// While an accent is pending the layout is not asked: its answer would
    /// say what the key does to the accent (docent#769).
    #[test]
    #[serial_test::serial(danish_layout)]
    fn regression_769_the_danish_layout_says_which_keys_are_dead_as_pressed() {
        if !super::layout_read_leaves_key_state() {
            return; // a Windows before 10.0.14393: the layout is not asked
        }
        use crate::capture::held_keys::AsPressed;
        let danish = LoadedLayout::load("00000406", 0x0406);
        let acute = danish.vk_at(0x0D);
        let diaeresis = danish.vk_at(0x1B);
        let e = danish.vk_at(0x12);
        let ask = |vk, scan, shift, alt_gr| {
            // SAFETY: a read of a loaded layout's tables that leaves the key state.
            unsafe { super::dead_as_pressed(vk, scan, shift, alt_gr, danish.hkl) }
        };
        let dead = |accent: char| {
            Some(AsPressed::DeadKey {
                accent: accent as u16,
            })
        };
        for _ in 0..2 {
            assert_eq!(ask(acute, 0x0D, false, false), dead('\u{b4}'));
            assert_eq!(ask(acute, 0x0D, true, false), dead('\u{60}'));
            assert_eq!(ask(acute, 0x0D, false, true), Some(AsPressed::NoDeadKey));
            assert_eq!(ask(diaeresis, 0x1B, false, false), dead('\u{a8}'));
            assert_eq!(ask(diaeresis, 0x1B, true, false), dead('\u{5e}'));
            assert_eq!(ask(diaeresis, 0x1B, false, true), dead('\u{7e}'));
            assert_eq!(ask(e, 0x12, false, false), Some(AsPressed::NoDeadKey));
        }
        // SAFETY: reads of a loaded layout's tables.
        assert!(unsafe { super::layout_has_no_accent_pending(danish.hkl) });
        assert_eq!(
            unsafe { super::dead_as_pressed(acute, 0x0D, false, false, HKL(std::ptr::null_mut())) },
            None
        );

        // An accent made pending (the same read with no flag takes the key
        // into the keyboard state): nothing is answered until it is gone.
        let state = [0u8; 256];
        let mut entered = [0u16; 8];
        let press = |vk, scan, entered: &mut [u16; 8]| {
            // SAFETY: a keyboard-state read of this thread; the accent it
            // leaves pending is taken out again below.
            unsafe {
                super::ToUnicodeEx(
                    vk,
                    scan,
                    state.as_ptr(),
                    windows_core::PWSTR(entered.as_mut_ptr()),
                    8,
                    0,
                    Some(danish.hkl),
                )
            }
        };
        assert!(
            press(acute, 0x0D, &mut entered) < 0,
            "the acute key is dead"
        );
        let pending = unsafe { super::layout_has_no_accent_pending(danish.hkl) };
        let answered = ask(e, 0x12, false, false);
        // Enter takes the accent out again, whatever the asserts below find.
        press(0x0D, 0x1C, &mut entered);
        assert!(!pending, "an accent is pending after the dead key");
        assert_eq!(answered, None, "the layout is not asked while one is");
        assert!(unsafe { super::layout_has_no_accent_pending(danish.hkl) });
        assert_eq!(ask(e, 0x12, false, false), Some(AsPressed::NoDeadKey));
    }

    #[test]
    fn regression_769_the_layout_is_asked_only_where_windows_leaves_the_key_state() {
        assert!(!super::windows_build_honors_flag(6, 9600));
        assert!(!super::windows_build_honors_flag(10, 10586));
        assert!(super::windows_build_honors_flag(10, 14393));
        assert!(super::windows_build_honors_flag(10, 19045));
        assert!(super::windows_build_honors_flag(11, 0));
    }

    #[test]
    #[serial_test::serial(danish_layout)]
    fn layout_char_reads_what_the_danish_layout_gives_a_punctuation_key() {
        let danish = LoadedLayout::load("00000406", 0x0406);
        // VK_OEM_PLUS, the key right of 0, enters `+` (`=` on the US layout).
        // SAFETY: a read of a loaded layout's tables.
        assert_eq!(unsafe { layout_char(0xBB, danish.hkl) }, u32::from('+'));
        // The key right of L (scan code 0x27) enters `æ`.
        let ae = danish.vk_at(0x27);
        assert!(is_punctuation_key(ae), "vk {ae:#x}");
        // SAFETY: a read of a loaded layout's tables.
        assert_eq!(unsafe { layout_char(ae, danish.hkl) }, u32::from('æ'));
        // The key right of `+` (scan code 0x0D) is the dead acute accent.
        let acute = danish.vk_at(0x0D);
        assert!(is_punctuation_key(acute), "vk {acute:#x}");
        // SAFETY: a read of a loaded layout's tables.
        let read = unsafe { layout_char(acute, danish.hkl) };
        assert_ne!(read & 0x8000_0000, 0, "the dead-key flag");
        assert_eq!(read & 0xFFFF, u32::from('´'), "its accent");
    }

    #[test]
    fn layout_char_reads_what_the_us_layout_gives_a_punctuation_key() {
        let us = LoadedLayout::load("00000409", 0x0409);
        // SAFETY: reads of a loaded layout's tables.
        assert_eq!(unsafe { layout_char(0xBB, us.hkl) }, u32::from('='));
        assert_eq!(unsafe { layout_char(0xDE, us.hkl) }, u32::from('\''));
    }

    #[test]
    fn layout_char_reads_nothing_from_no_layout() {
        // SAFETY: a null layout is answered without a call.
        assert_eq!(unsafe { layout_char(0xBB, HKL::default()) }, 0);
    }

    // -- the held-key record's message numbers ---------------------------------

    #[test]
    fn the_held_key_record_reads_the_systems_own_keyboard_messages() {
        use crate::capture::held_keys::{KEY_DOWN_MESSAGES, KEY_UP_MESSAGES};
        use crate::capture::win32_bindings::{WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP};
        assert_eq!(KEY_DOWN_MESSAGES, [WM_KEYDOWN as u32, WM_SYSKEYDOWN as u32]);
        assert_eq!(KEY_UP_MESSAGES, [WM_KEYUP as u32, WM_SYSKEYUP as u32]);
    }

    // -- the IsPassword reading rule -----------------------------------------

    #[test]
    fn is_password_value_reads_a_bool_answer_as_itself() {
        assert!(is_password_value(Some(&Variant::from(true))));
        assert!(!is_password_value(Some(&Variant::from(false))));
    }

    #[test]
    fn is_password_value_reads_no_answer_as_false() {
        assert!(!is_password_value(None));
        // SAFETY: a zeroed VARIANT is VT_EMPTY and owns nothing to clear.
        let empty = unsafe { Variant::from_raw(VARIANT::default()) };
        assert_eq!(empty.vt(), VT_EMPTY);
        assert!(!is_password_value(Some(&empty)));
    }

    #[test]
    fn is_password_value_reads_an_answer_of_another_type_as_a_password() {
        assert!(is_password_value(Some(&Variant::from(0i32))));
        assert!(is_password_value(Some(&Variant::from(1i32))));
        assert!(is_password_value(Some(&Variant::from(BSTR::from("false")))));
        // SAFETY: the reserved value is handed over with one reference, which the
        // wrapper releases on drop.
        let not_supported = unsafe { UiaGetReservedNotSupportedValue() }.expect("reserved value");
        assert!(is_password_value(Some(&Variant::from(not_supported))));
    }

    // -- process-tree helpers (against the live process table) -------------
    //
    // These exercise the relocated WebView2 self-capture helpers using the
    // current test process, which is guaranteed to exist in the snapshot and
    // to have a real exe name and parent PID — so the success paths are
    // deterministic without needing a spawned child.

    #[test]
    fn get_process_exe_name_resolves_current_process() {
        let pid = std::process::id();
        let name = get_process_exe_name(pid).expect("current process must be in the snapshot");
        assert!(!name.is_empty(), "exe name should be non-empty");
        // The test binary runs under cargo/llvm-cov; the exe name ends in .exe.
        assert!(
            name.to_lowercase().ends_with(".exe"),
            "unexpected exe name: {name}"
        );
    }

    #[test]
    fn get_process_exe_name_unknown_pid_is_none() {
        // An almost-certainly-unused high PID exercises the not-found path.
        // (Windows PIDs are multiples of 4 and nowhere near u32::MAX - 1.)
        assert_eq!(get_process_exe_name(u32::MAX - 1), None);
    }

    #[test]
    fn get_parent_pid_resolves_current_process() {
        let pid = std::process::id();
        let parent = get_parent_pid(pid).expect("current process must have a parent");
        assert_ne!(
            parent, pid,
            "parent PID must differ from the process itself"
        );
    }

    #[test]
    fn is_descendant_of_self_is_false() {
        // A process is not its own ancestor (the walk starts at the parent).
        let pid = std::process::id();
        assert!(!is_descendant_of(pid, pid));
    }

    #[test]
    fn is_descendant_of_actual_parent_is_true() {
        // The current process is a descendant of its own parent.
        let pid = std::process::id();
        let parent = get_parent_pid(pid).expect("current process must have a parent");
        assert!(
            is_descendant_of(pid, parent),
            "process {pid} should be a descendant of its parent {parent}"
        );
    }

    #[test]
    fn is_recognized_by_exe_name_matches_docent_binary_name() {
        // The running test binary (`docent_desktop_lib-<hash>.exe`) is, by
        // construction, this process's own binary name — the own-name branch
        // matches it whole. The whole-name comparison's negative cases are the
        // scroll module's regression tests
        // `regression_noissue_exe_name_only_containing_docent_is_kept` and
        // `regression_noissue_exe_name_only_containing_the_runtime_name_is_kept`.
        assert!(is_recognized_by_exe_name(std::process::id()));
    }

    #[test]
    fn is_recognized_by_exe_name_false_for_unknown_pid() {
        // No exe name resolvable → not recognized by name.
        assert!(!is_recognized_by_exe_name(u32::MAX - 1));
    }

    // -- windows_should_keep_event (base-rule delegation) ------------------
    //
    // The WebView2 process-tree paths are covered above; here we assert the
    // deterministic base-rule short-circuits.

    #[test]
    fn keep_event_pid_zero_is_always_filtered() {
        assert!(!windows_should_keep_event(0, None));
        assert!(!windows_should_keep_event(0, Some(0)));
        assert!(!windows_should_keep_event(0, Some(1234)));
    }

    #[test]
    fn keep_event_excluded_pid_is_filtered() {
        assert!(!windows_should_keep_event(1234, Some(1234)));
    }

    #[test]
    fn keep_event_no_exclusion_keeps_all() {
        assert!(windows_should_keep_event(1234, None));
        assert!(windows_should_keep_event(u32::MAX, None));
    }

    // -- scope filters: base rule, target, exclusion, per-process verdict ---
    //
    // The composed decision the hooks run per event (DCP-5). The verdict cache
    // and the Windows lookups are injected, so these state the filters' order
    // and the per-process verdict semantics without a live capture session.
    // Where a filter is meant to decide the event before an injected lookup is
    // reached, the cases pass the panicking stubs below, so a reordering that
    // spends a lookup it should not is a loud failure rather than a silently
    // different answer.

    use super::{
        classify_left_release, down_dispatch_click_mark, down_dispatch_event_type,
        input_should_keep_event_cached, is_drag, scope_filter_decision, AtomicU32, LeftRelease,
        RawEventType, CLICK_IS_MIDDLE_BUTTON, DRAG_THRESHOLD_PX, HWND, INPUT_INCLUDED_PID,
        INPUT_PID_CACHE, POINT, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
    };
    use super::{
        input_dropped_window_event, BridgeMessage, EVENT_OBJECT_FOCUS, EVENT_OBJECT_VALUECHANGE,
        EVENT_SYSTEM_FOREGROUND, INPUT_RAW_SENDER,
    };
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    /// PIDs standing in for the processes these cases talk about.
    const TARGET_APP: u32 = 4242; // the application the user selected
    const OTHER_APP: u32 = 777; // some other running application
    const DOCENT: u32 = 1001; // Docent's own process (the excluded one)
    const DIALOG_HOST: u32 = 2002; // the process hosting a dialog Docent opened

    /// A dropped window that comes to the front tells the pool that the
    /// typing has ended, and sends no event of that window; its other window
    /// events tell the pool nothing (docent#768).
    #[test]
    fn regression_768_a_dropped_window_that_comes_to_the_front_ends_the_typing() {
        let (tx, rx) = std::sync::mpsc::channel::<BridgeMessage>();
        INPUT_RAW_SENDER.with(|s| *s.borrow_mut() = Some(tx));
        input_dropped_window_event(EVENT_SYSTEM_FOREGROUND as u32);
        assert!(matches!(rx.try_recv(), Ok(BridgeMessage::TypingEnded)));
        assert!(rx.try_recv().is_err(), "one message only");
        for other in [EVENT_OBJECT_FOCUS as u32, EVENT_OBJECT_VALUECHANGE as u32] {
            input_dropped_window_event(other);
            assert!(rx.try_recv().is_err(), "event {other:#x}");
        }
        INPUT_RAW_SENDER.with(|s| *s.borrow_mut() = None);
    }

    /// A verdict cache for one capture session's worth of events, plus a count
    /// of the owner lookups the decision spent against it.
    #[derive(Default)]
    struct Session {
        verdicts: RefCell<HashMap<u32, bool>>,
        owner_lookups: Cell<u32>,
    }

    impl Session {
        /// Run the decision against this session's store, supplying the two
        /// Windows lookups this event should see.
        fn decide(
            &self,
            event_pid: u32,
            included_pid: Option<u32>,
            excluded_pid: Option<u32>,
            tree_and_name_keep: impl FnOnce(u32, Option<u32>) -> bool,
            owned_by_excluded: impl FnOnce(u32) -> bool,
        ) -> bool {
            scope_filter_decision(
                event_pid,
                included_pid,
                excluded_pid,
                |pid| self.verdicts.borrow().get(&pid).copied(),
                |pid, keep| {
                    self.verdicts.borrow_mut().insert(pid, keep);
                },
                tree_and_name_keep,
                owned_by_excluded,
            )
        }

        /// An owner lookup that answers `owned` and counts itself.
        fn owner_says(&self, owned: bool) -> impl FnOnce(u32) -> bool + '_ {
            move |_excluded| {
                self.owner_lookups.set(self.owner_lookups.get() + 1);
                owned
            }
        }

        fn recorded(&self, pid: u32) -> Option<bool> {
            self.verdicts.borrow().get(&pid).copied()
        }
    }

    /// The process-tree / executable-name chain, answering "not one of ours".
    fn tree_and_name_admits(_pid: u32, _excluded: Option<u32>) -> bool {
        true
    }

    fn unreachable_tree_and_name(_pid: u32, _excluded: Option<u32>) -> bool {
        panic!("an earlier filter decides this event — the process-tree/name lookup must not run");
    }

    fn unreachable_owned(_excluded: u32) -> bool {
        panic!("an earlier filter decides this event — the owned-window lookup must not run");
    }

    #[test]
    fn an_unresolvable_window_is_skipped_whatever_the_other_filters_say() {
        // The decision delegates the resolvable-window skip to the base rule:
        // an event whose window is already gone (PID 0) is dropped with the
        // exclusion off and no target set — the arm with nothing else standing
        // behind it — and stays dropped when a target names it too.
        let session = Session::default();
        assert!(
            !session.decide(0, None, None, unreachable_tree_and_name, unreachable_owned),
            "an event whose window can no longer be resolved is not captured"
        );
        // `Some(0)` is unreachable in production — the target-application
        // command normalizes 0 to no-target — and is chosen deliberately: it
        // is the one target value that would admit this event, so the boundary
        // is tested with the target filter as permissive as it can be.
        assert!(
            !session.decide(
                0,
                Some(0),
                None,
                unreachable_tree_and_name,
                unreachable_owned
            ),
            "and no target selection can admit it"
        );
        assert_eq!(
            session.recorded(0),
            None,
            "a skipped unresolvable window records no per-process verdict"
        );
    }

    #[test]
    fn the_target_filter_settles_an_out_of_target_event_before_any_lookup() {
        // With the exclusion armed AND a target selected, an event from neither
        // process is settled by the target filter alone: no process-tree walk,
        // no executable-name read, no owner walk is spent on a process this
        // recording does not want.
        let session = Session::default();
        assert!(
            !session.decide(
                OTHER_APP,
                Some(TARGET_APP),
                Some(DOCENT),
                unreachable_tree_and_name,
                unreachable_owned,
            ),
            "an out-of-target event is dropped without spending a self-capture lookup"
        );
        assert_eq!(
            session.recorded(OTHER_APP),
            None,
            "and records no per-process verdict, so a later target change is not prejudged"
        );
    }

    #[test]
    fn target_filter_captures_only_the_selected_application() {
        let session = Session::default();
        assert!(
            session.decide(
                TARGET_APP,
                Some(TARGET_APP),
                None,
                unreachable_tree_and_name,
                unreachable_owned,
            ),
            "an event attributed to the selected target's process is captured"
        );
        assert!(
            !session.decide(
                OTHER_APP,
                Some(TARGET_APP),
                None,
                unreachable_tree_and_name,
                unreachable_owned,
            ),
            "with a target set, an event from any other process is not captured"
        );
    }

    #[test]
    fn no_target_set_captures_every_application() {
        let session = Session::default();
        for pid in [TARGET_APP, OTHER_APP] {
            assert!(
                session.decide(
                    pid,
                    None,
                    None,
                    unreachable_tree_and_name,
                    unreachable_owned
                ),
                "with no target set, every application is captured (PID {pid})"
            );
        }
    }

    #[test]
    fn self_capture_exclusion_takes_priority_over_the_target_filter() {
        // Selecting the excluded process as the target still excludes it: the
        // base rule drops the excluded process's own events before the target
        // filter is consulted, so the target never gets to admit them.
        let session = Session::default();
        assert!(
            !session.decide(
                DOCENT,
                Some(DOCENT),
                Some(DOCENT),
                unreachable_tree_and_name,
                unreachable_owned,
            ),
            "the exclusion outranks the target filter while the exclusion is on"
        );
        // The control: the same target admits the same process the moment the
        // exclusion is off, so the drop above is the exclusion's doing and not
        // the target filter's.
        let session = Session::default();
        assert!(
            session.decide(
                DOCENT,
                Some(DOCENT),
                None,
                unreachable_tree_and_name,
                unreachable_owned,
            ),
            "with the exclusion off, the selected target is captured like any other"
        );
    }

    #[test]
    fn a_window_owned_by_an_excluded_process_is_excluded() {
        // A dialog Docent opened runs under another process, so it clears the
        // process-tree and executable-name grounds; its window's root owner is
        // Docent's, which is the ground that excludes it.
        let session = Session::default();
        let kept = session.decide(
            DIALOG_HOST,
            None,
            Some(DOCENT),
            tree_and_name_admits,
            |excluded| {
                assert_eq!(
                    excluded, DOCENT,
                    "the owner check is made against the excluded process"
                );
                true
            },
        );
        assert!(!kept, "a system dialog Docent opened is not captured");
        assert_eq!(
            session.recorded(DIALOG_HOST),
            Some(false),
            "the verdict is recorded for the process, not for the window"
        );
    }

    #[test]
    fn the_self_capture_verdict_is_per_process_and_the_first_event_wins() {
        // First event excluded — its window IS owned by Docent's. A later event
        // from a window of the same process that is NOT owned (so on its own it
        // would be kept) still shares the first event's verdict.
        let session = Session::default();
        let first = session.decide(
            DIALOG_HOST,
            None,
            Some(DOCENT),
            tree_and_name_admits,
            session.owner_says(true),
        );
        let second = session.decide(
            DIALOG_HOST,
            None,
            Some(DOCENT),
            tree_and_name_admits,
            session.owner_says(false),
        );
        assert!(!first);
        assert!(
            !second,
            "every window of the process shares the verdict its first event produced"
        );
        assert_eq!(
            session.owner_lookups.get(),
            1,
            "the verdict is evaluated on the first event and recorded, not re-evaluated per event"
        );

        // The same rule in the other direction: first event kept, so a later
        // event from a window that IS owned rides the same recorded verdict.
        let session = Session::default();
        let first = session.decide(
            DIALOG_HOST,
            None,
            Some(DOCENT),
            tree_and_name_admits,
            session.owner_says(false),
        );
        let second = session.decide(
            DIALOG_HOST,
            None,
            Some(DOCENT),
            tree_and_name_admits,
            session.owner_says(true),
        );
        assert!(first);
        assert!(
            second,
            "a first-event keep is recorded for the process just as a first-event exclusion is"
        );
        assert_eq!(session.owner_lookups.get(), 1);
    }

    #[test]
    fn a_process_the_tree_and_name_grounds_exclude_never_reaches_the_owner_check() {
        // Docent's own process tree and the executable-name recognition are
        // decided before the owner walk, and their verdict is recorded too.
        let session = Session::default();
        assert!(
            !session.decide(
                DIALOG_HOST,
                None,
                Some(DOCENT),
                |_pid, _excluded| false,
                unreachable_owned,
            ),
            "a process the tree/name grounds exclude is not captured"
        );
        assert_eq!(session.recorded(DIALOG_HOST), Some(false));
        assert!(
            !session.decide(
                DIALOG_HOST,
                None,
                Some(DOCENT),
                unreachable_tree_and_name,
                unreachable_owned,
            ),
            "and that verdict is recorded for the process like any other"
        );
    }

    // -- the Input_Thread adapter over the decision ------------------------

    /// A PID no live process can be using, so the process-table lookups answer
    /// it deterministically: it resolves to no executable name, and therefore
    /// to no executable-name recognition. The adjacent cases
    /// `get_process_exe_name_unknown_pid_is_none` and
    /// `is_recognized_by_exe_name_false_for_unknown_pid` pin those two answers.
    const UNKNOWN_PROCESS: u32 = u32::MAX - 1;

    /// Set the Input_Thread's target-application atomic; `None` writes the
    /// no-target value the adapter reads as "capture every application".
    fn set_input_target(pid: Option<u32>) {
        INPUT_INCLUDED_PID.with(|p| {
            *p.borrow_mut() = Some(std::sync::Arc::new(AtomicU32::new(pid.unwrap_or(0))));
        });
    }

    fn recorded_by_input_thread(pid: u32) -> Option<bool> {
        INPUT_PID_CACHE.with(|cache| cache.borrow().get(&pid).copied())
    }

    /// Return the Input_Thread's scope state to its between-sessions shape.
    fn clear_input_scope_state() {
        INPUT_INCLUDED_PID.with(|p| *p.borrow_mut() = None);
        INPUT_PID_CACHE.with(|c| c.borrow_mut().clear());
    }

    #[test]
    fn the_input_thread_adapter_applies_the_target_application_it_reads() {
        // The entry point the hooks actually call. It reads the target from
        // the Input_Thread's shared atomic, so seeding that atomic is what
        // lets the composed answer be observed here; the seeded verdicts keep
        // the processes that get past the target filter off the lookup path.
        let no_window = HWND(std::ptr::null_mut());
        set_input_target(Some(TARGET_APP));
        INPUT_PID_CACHE.with(|cache| {
            let mut verdicts = cache.borrow_mut();
            verdicts.insert(TARGET_APP, true);
            verdicts.insert(OTHER_APP, true);
        });

        assert!(
            input_should_keep_event_cached(TARGET_APP, Some(DOCENT), no_window),
            "the selected target's events reach capture"
        );
        assert!(
            !input_should_keep_event_cached(OTHER_APP, Some(DOCENT), no_window),
            "the target the adapter reads still drops every other process, recorded verdict or not"
        );
        assert!(
            !input_should_keep_event_cached(DOCENT, Some(DOCENT), no_window),
            "and the excluded process is dropped whatever the target says"
        );
        assert!(
            !input_should_keep_event_cached(0, Some(DOCENT), no_window),
            "an unresolvable window is skipped through the adapter too"
        );

        // Clearing the target restores capture of every application — the
        // adapter re-reads the atomic per event rather than latching it.
        set_input_target(None);
        assert!(
            input_should_keep_event_cached(OTHER_APP, Some(DOCENT), no_window),
            "with the target cleared, the same event is captured"
        );

        clear_input_scope_state();
    }

    #[test]
    fn the_input_thread_adapter_records_a_process_verdict_and_then_rides_it() {
        // The verdict cache's two halves, over the real Windows lookups the
        // adapter supplies: a process with no verdict yet is judged by them
        // and the answer written to the Input_Thread's map; a later event from
        // that process reads the written answer instead of being judged again.
        let no_window = HWND(std::ptr::null_mut());
        set_input_target(None);
        INPUT_PID_CACHE.with(|c| c.borrow_mut().clear());

        // First event: no verdict recorded, so the real lookups run. The
        // process-tree walk and the executable-name read cannot place this PID
        // in Docent's tree, and the owner walk — supplied for real, with a
        // window handle that has no root owner — takes its no-root-owner arm.
        // So the event is captured, and that answer must reach the cache.
        assert!(
            input_should_keep_event_cached(UNKNOWN_PROCESS, Some(DOCENT), no_window),
            "a process the real lookups cannot tie to Docent is captured"
        );
        assert_eq!(
            recorded_by_input_thread(UNKNOWN_PROCESS),
            Some(true),
            "and the adapter writes that verdict to the Input_Thread's verdict cache"
        );

        // Flip the recorded verdict to the opposite of what those same lookups
        // would produce. The next event from that process must ride the record
        // rather than be judged afresh, so this is what the read decides.
        INPUT_PID_CACHE.with(|c| {
            c.borrow_mut().insert(UNKNOWN_PROCESS, false);
        });
        assert!(
            !input_should_keep_event_cached(UNKNOWN_PROCESS, Some(DOCENT), no_window),
            "a later event from that process rides the recorded verdict, not a fresh judgement"
        );

        clear_input_scope_state();
    }

    // -- pointer gesture classification (DCP-10) ---------------------------

    fn at(x: i32, y: i32) -> POINT {
        POINT { x, y }
    }

    #[test]
    fn drag_threshold_is_the_documented_five_pixels() {
        // A value pin on a doctrine constant: the threshold is stated in the
        // desktop capture principles, so the constant cannot drift away from
        // the documented value unnoticed.
        assert_eq!(
            DRAG_THRESHOLD_PX, 5,
            "the classification threshold is documented as 5 px on either axis"
        );
    }

    #[test]
    fn movement_within_the_threshold_is_a_click() {
        // "More than 5 px" is strict, so a release exactly 5 px from the press
        // is still a click — on either axis and in either direction.
        assert!(!is_drag(at(100, 100), at(100, 100)), "no movement");
        assert!(!is_drag(at(100, 100), at(105, 100)), "5 px right");
        assert!(!is_drag(at(100, 100), at(95, 100)), "5 px left");
        assert!(!is_drag(at(100, 100), at(100, 105)), "5 px down");
        assert!(!is_drag(at(100, 100), at(95, 95)), "5 px on both axes");
    }

    #[test]
    fn movement_past_the_threshold_on_either_axis_is_a_drag() {
        // One axis past the threshold is enough, and the distance is absolute,
        // so the direction of travel does not change the classification.
        assert!(is_drag(at(100, 100), at(106, 100)), "6 px right");
        assert!(is_drag(at(100, 100), at(94, 100)), "6 px left");
        assert!(is_drag(at(100, 100), at(100, 106)), "6 px down");
        assert!(is_drag(at(100, 100), at(100, 94)), "6 px up");
        assert!(
            is_drag(at(100, 100), at(102, 140)),
            "one axis past the threshold decides even when the other is within it"
        );
    }

    // The whole left-button decision, over the seam the release handler
    // consumes: what the release records, and where the drag pair says the
    // gesture began. The threshold cases above hold the predicate this rides on.

    #[test]
    fn a_release_past_the_threshold_is_the_drag_pair_sourced_at_the_press() {
        // The pair is emitted at the release, and its source describes the
        // press point — not the release point the gesture ended at.
        assert_eq!(
            classify_left_release(Some(at(100, 100)), at(400, 250)),
            LeftRelease::DragPair {
                source_coords: (100, 100)
            }
        );
    }

    #[test]
    fn a_release_within_the_threshold_is_a_click() {
        // The same press-move-release, moved a distance the threshold covers.
        assert_eq!(
            classify_left_release(Some(at(100, 100)), at(103, 104)),
            LeftRelease::Click
        );
    }

    #[test]
    fn a_release_with_no_recorded_press_is_a_click() {
        // A release whose press was never recorded — the press landed while
        // capture was off, or an excluded window's release cleared it — has no
        // gesture to source a drag from, so it records the click at the release.
        assert_eq!(
            classify_left_release(None, at(400, 250)),
            LeftRelease::Click
        );
    }

    #[test]
    fn the_middle_and_right_buttons_dispatch_their_action_from_the_press() {
        // Each of these arms records on button-down, so the mapping is the
        // whole decision: middle records a click, right a right-click.
        assert!(matches!(
            down_dispatch_event_type(WM_MBUTTONDOWN as u32),
            Some(RawEventType::Click)
        ));
        assert!(matches!(
            down_dispatch_event_type(WM_RBUTTONDOWN as u32),
            Some(RawEventType::RightClick)
        ));
    }

    #[test]
    fn the_down_dispatch_mapping_answers_for_its_own_two_messages() {
        // The left button's press records no action of its own (its release
        // does, above), and the wheel messages are their own arm — so neither
        // reaches this mapping.
        assert!(down_dispatch_event_type(WM_LBUTTONDOWN as u32).is_none());
        assert!(down_dispatch_event_type(WM_MOUSEWHEEL as u32).is_none());
    }

    #[test]
    fn regression_692_the_middle_buttons_click_is_marked_as_the_middle_buttons() {
        // https://github.com/Arsarneq/docent/issues/692 — a middle press on a
        // file dialog's Open button recorded a file_dialog.
        assert_eq!(
            down_dispatch_click_mark(WM_MBUTTONDOWN as u32),
            CLICK_IS_MIDDLE_BUTTON
        );
        assert_eq!(down_dispatch_click_mark(WM_RBUTTONDOWN as u32), 0);
    }

    // -- flush-barrier fallback drain (truthful completion) ----------------
    //
    // These hand-wire a WindowsCapture whose input thread can never serve a
    // flush request (a thread id no live thread owns), which is the
    // deterministic injection for the dead-input-thread / stalled-pump class:
    // the marker-ordered barrier cannot report, so the timeout arm must
    // recover the held buffers by fallback drain, emit the sentinel after
    // them, and say so in the report — never return a success-shaped one.

    use super::super::worker_pool::{PendingBuffers, PendingDirectory, SharedPendingBuffers};
    use super::super::{
        ActionEvent, ActionPayload, BarrierCompletion, CaptureError, CaptureMode,
        ElementDescription, Modifiers,
    };
    use super::{
        interpret_input_ready, PeekMessageW, WindowsCapture, INPUT_READY_TIMEOUT, MSG, PM_NOREMOVE,
        WM_USER,
    };
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// A buffered key action for seeding a worker's held buffers.
    fn held_key_event(key: &str) -> ActionEvent {
        ActionEvent {
            timestamp: 1,
            context_id: Some(7),
            capture_mode: CaptureMode::Accessibility,
            frame_src: None,
            window_rect: None,
            preferred_languages: None,
            sequence_id: Some(1),
            payload: ActionPayload::Key {
                key: key.to_string(),
                modifiers: Modifiers {
                    ctrl: false,
                    shift: false,
                    alt: false,
                    meta: false,
                },
                repeat: false,
                code: None,
                input_method: Default::default(),
                held: crate::capture::HeldKeysAtAction::default(),
                element: ElementDescription {
                    tag: "Edit".to_string(),
                    selector: "win > edit".to_string(),
                    ..Default::default()
                },
            },
        }
    }

    /// A thread id no live thread owns (no thread id the OS would allocate is
    /// anywhere near this), so every post to it fails — the injected
    /// dead-input-thread condition, which the fast-fail arm must catch without
    /// waiting out the report bound.
    const DEAD_TID: u32 = u32::MAX - 3;

    /// Hand-wire a capture whose session handles exist but whose "input
    /// thread" is `tid`, with one worker buffer seeded with `key`. Returns the
    /// capture, the seeded buffer handle, and the action receiver.
    fn capture_with_seeded_buffer(
        tid: u32,
        key: &str,
    ) -> (
        WindowsCapture,
        SharedPendingBuffers,
        std::sync::mpsc::Receiver<ActionEvent>,
    ) {
        let mut capture = WindowsCapture::new();
        capture.input_thread_id = Some(tid);
        capture.flush_requests = Some(Arc::new(Mutex::new(VecDeque::new())));

        let pending: SharedPendingBuffers = Arc::new(Mutex::new(PendingBuffers::default()));
        pending
            .lock()
            .unwrap()
            .pending_keys
            .push(held_key_event(key));
        let directory: PendingDirectory = Arc::new(Mutex::new(vec![Arc::clone(&pending)]));
        capture.pending_directory = Some(directory);

        let (tx, rx) = std::sync::mpsc::channel::<ActionEvent>();
        capture.action_sender = Some(tx);
        (capture, pending, rx)
    }

    /// Assert the fallback contract on a report + stream: fallback-drained
    /// completion, real id, recovered action first, sentinel last, buffers
    /// left empty.
    fn assert_fallback_recovered(
        report: &super::BarrierReport,
        pending: &SharedPendingBuffers,
        rx: &std::sync::mpsc::Receiver<ActionEvent>,
        key: &str,
    ) {
        assert_eq!(
            report.completion,
            BarrierCompletion::FallbackDrained,
            "an unserved barrier must never be shaped like a success"
        );
        assert!(report.barrier_id > 0, "the barrier id is still real");

        let events: Vec<ActionEvent> = rx.try_iter().collect();
        assert!(
            matches!(events.first().map(|e| &e.payload), Some(ActionPayload::Key { key: k, .. }) if k == key),
            "the held completed action must be recovered onto the action stream"
        );
        assert!(
            matches!(
                events.last().map(|e| &e.payload),
                Some(ActionPayload::BarrierComplete { barrier_id }) if *barrier_id == report.barrier_id
            ),
            "the sentinel must be emitted after the recovered actions"
        );
        assert!(
            pending.lock().unwrap().pending_keys.is_empty(),
            "the drain empties the buffers, so a late marker-ordered drain re-emits nothing"
        );
    }

    #[test]
    fn flush_barrier_timeout_recovers_buffers_by_fallback_drain_and_reports_it() {
        // The stalled-pump injection: the wake posts into THIS test thread's
        // message queue (forced into existence below, exactly the recipe the
        // real input thread uses), but nothing ever pumps it — so the post
        // succeeds and the report wait must expire into the fallback drain.
        unsafe {
            let mut msg = MSG::default();
            let _ = PeekMessageW(
                &mut msg,
                None,
                WM_USER as u32,
                WM_USER as u32,
                PM_NOREMOVE as u32,
            );
        }
        let own_tid = unsafe { GetCurrentThreadId() };
        let (capture, pending, rx) = capture_with_seeded_buffer(own_tid, "q");

        let report = capture.run_flush_barrier_with(Duration::from_millis(100));

        assert_fallback_recovered(&report, &pending, &rx, "q");
    }

    #[test]
    fn flush_barrier_dead_thread_fast_fails_to_fallback_without_waiting() {
        // The dead-thread injection: the wake post fails outright, so the
        // fast-fail arm must branch to the fallback drain immediately — the
        // generous report bound below must never be waited out (pre-fast-fail,
        // a dead thread cost the caller the full bound).
        let (capture, pending, rx) = capture_with_seeded_buffer(DEAD_TID, "z");

        let started = std::time::Instant::now();
        let report = capture.run_flush_barrier_with(Duration::from_secs(60));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a failed wake must fall back immediately, not wait out the report bound (took {:?})",
            started.elapsed()
        );

        assert_fallback_recovered(&report, &pending, &rx, "z");
    }

    #[test]
    fn flush_barrier_without_a_live_session_reports_not_run() {
        // No input thread / queue / directory / sender — the four are set and
        // cleared together; without them no barrier can run and the report
        // must say so instead of minting an id.
        let capture = WindowsCapture::new();
        let report = capture.run_flush_barrier();
        assert_eq!(report.barrier_id, 0);
        assert_eq!(report.completion, BarrierCompletion::NotRun);
        assert_eq!(report.wedged_workers, 0);
    }

    // -- start()'s input-thread readiness handshake ------------------------

    #[test]
    fn input_ready_success_report_proceeds() {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), CaptureError>>();
        tx.send(Ok(())).unwrap();
        assert!(interpret_input_ready(rx.recv_timeout(INPUT_READY_TIMEOUT)).is_ok());
    }

    #[test]
    fn input_ready_failure_report_fails_start_with_the_real_error() {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), CaptureError>>();
        tx.send(Err(CaptureError::HookFailed("WH_MOUSE_LL: denied".into())))
            .unwrap();
        let err = interpret_input_ready(rx.recv_timeout(INPUT_READY_TIMEOUT)).unwrap_err();
        assert!(
            matches!(err, CaptureError::HookFailed(ref m) if m.contains("WH_MOUSE_LL")),
            "the startup error must surface verbatim, got: {err}"
        );
    }

    #[test]
    fn input_ready_silent_exit_fails_start() {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), CaptureError>>();
        drop(tx); // the thread exited without reporting (panic before the report site)
        let err = interpret_input_ready(rx.recv_timeout(Duration::from_millis(50))).unwrap_err();
        assert!(matches!(err, CaptureError::Platform(_)));
    }

    #[test]
    fn input_ready_timeout_warns_and_proceeds() {
        // A pathologically slow init is not a definite failure: the handshake
        // times out into warn-and-proceed (the worker-init posture), never a
        // zombie-creating hard failure.
        let (_tx, rx) = std::sync::mpsc::channel::<Result<(), CaptureError>>();
        assert!(interpret_input_ready(rx.recv_timeout(Duration::from_millis(20))).is_ok());
    }

    // -- control_type_name -------------------------------------------------

    #[test]
    fn known_control_types_map_correctly() {
        assert_eq!(control_type_name(50000), "Button");
        assert_eq!(control_type_name(50004), "Edit");
        assert_eq!(control_type_name(50020), "Text");
        assert_eq!(control_type_name(50032), "Window");
        assert_eq!(control_type_name(50033), "Pane");
    }

    #[test]
    fn unknown_control_type_returns_unknown() {
        assert_eq!(control_type_name(99999), "Unknown");
        assert_eq!(control_type_name(-1), "Unknown");
        assert_eq!(control_type_name(0), "Unknown");
    }

    #[test]
    fn calendar_control_type() {
        assert_eq!(control_type_name(50001), "Calendar");
    }

    #[test]
    fn checkbox_control_type() {
        assert_eq!(control_type_name(50002), "CheckBox");
    }

    #[test]
    fn combobox_control_type() {
        assert_eq!(control_type_name(50003), "ComboBox");
    }

    #[test]
    fn hyperlink_control_type() {
        assert_eq!(control_type_name(50005), "Hyperlink");
    }

    #[test]
    fn image_control_type() {
        assert_eq!(control_type_name(50006), "Image");
    }

    #[test]
    fn list_and_listitem_control_types() {
        assert_eq!(control_type_name(50007), "ListItem");
        assert_eq!(control_type_name(50008), "List");
    }

    #[test]
    fn menu_control_types() {
        assert_eq!(control_type_name(50009), "Menu");
        assert_eq!(control_type_name(50010), "MenuBar");
        assert_eq!(control_type_name(50011), "MenuItem");
    }

    #[test]
    fn progress_radio_scrollbar_slider_spinner() {
        assert_eq!(control_type_name(50012), "ProgressBar");
        assert_eq!(control_type_name(50013), "RadioButton");
        assert_eq!(control_type_name(50014), "ScrollBar");
        assert_eq!(control_type_name(50015), "Slider");
        assert_eq!(control_type_name(50016), "Spinner");
    }

    #[test]
    fn statusbar_tab_tabitem() {
        assert_eq!(control_type_name(50017), "StatusBar");
        assert_eq!(control_type_name(50018), "Tab");
        assert_eq!(control_type_name(50019), "TabItem");
    }

    #[test]
    fn toolbar_tooltip_tree_treeitem() {
        assert_eq!(control_type_name(50021), "ToolBar");
        assert_eq!(control_type_name(50022), "ToolTip");
        assert_eq!(control_type_name(50023), "Tree");
        assert_eq!(control_type_name(50024), "TreeItem");
    }

    #[test]
    fn group_thumb_datagrid_dataitem_document() {
        assert_eq!(control_type_name(50026), "Group");
        assert_eq!(control_type_name(50027), "Thumb");
        assert_eq!(control_type_name(50028), "DataGrid");
        assert_eq!(control_type_name(50029), "DataItem");
        assert_eq!(control_type_name(50030), "Document");
    }

    #[test]
    fn splitbutton_header_headeritem_table_titlebar() {
        assert_eq!(control_type_name(50031), "SplitButton");
        assert_eq!(control_type_name(50034), "Header");
        assert_eq!(control_type_name(50035), "HeaderItem");
        assert_eq!(control_type_name(50036), "Table");
        assert_eq!(control_type_name(50037), "TitleBar");
    }

    #[test]
    fn separator_semanticzoom_appbar() {
        assert_eq!(control_type_name(50038), "Separator");
        assert_eq!(control_type_name(50039), "SemanticZoom");
        assert_eq!(control_type_name(50040), "AppBar");
    }
}

// ---------------------------------------------------------------------------
// The file-dialog read against a real common Open dialog
// ---------------------------------------------------------------------------

#[cfg(test)]
mod file_dialog_read_tests {
    //! The backend's file-dialog read (DCP-6) run against a real common Open
    //! dialog this process opens with `GetOpenFileNameW` on a thread of its
    //! own, showing a folder the test creates, with the File name preset — no
    //! other application and no synthesized input. The dialog is modal on its
    //! thread; a guard closes it however the test ends.

    use super::super::win32_bindings::{
        FindWindowW, GetDlgItem, GetOpenFileNameW, GetSaveFileNameW, PostMessageW, OFN_EXPLORER,
        OFN_FILEMUSTEXIST, OPENFILENAMEW, WM_CLOSE,
    };
    use super::*;
    use windows_core::PCWSTR;

    /// The file the dialog's folder holds and its File name names.
    const FILE: &str = "docent-692-known.txt";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// Closes the dialog when dropped, so a failed assertion leaves no modal
    /// window behind for the rest of the suite.
    struct CloseOnDrop(isize);

    impl Drop for CloseOnDrop {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe {
                    let _ = PostMessageW(
                        Some(HWND(self.0 as *mut _)),
                        WM_CLOSE as u32,
                        WPARAM(0),
                        LPARAM(0),
                    );
                }
            }
        }
    }

    /// Poll `f` until it answers `Some` or `timeout` passes.
    fn poll<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
        let start = Instant::now();
        loop {
            if let Some(v) = f() {
                return Some(v);
            }
            if start.elapsed() > timeout {
                return None;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// Walk `read_file_dialog_path`'s steps with the helpers it calls and
    /// report each one's answer, then every Edit, ComboBox and ToolBar under
    /// the dialog with its ControlType, AutomationId, Name, Value and
    /// ClassName. Test diagnostics only: it decides nothing.
    unsafe fn diagnose_file_dialog_read(
        backend: &WindowsAccessibilityBackend,
        window: i64,
    ) -> String {
        use super::super::uia_core_api::UIA_EditControlTypeId;
        use super::super::win32_bindings::TreeScope_Descendants;
        use std::fmt::Write as _;

        let mut out = String::from("file-dialog read diagnosis:\n");
        let root = backend.root_window_handle(window);
        let hwnd = HWND(root as *mut _);
        let _ = writeln!(out, "  window {window:#x}, root {root:#x}");
        let _ = writeln!(
            out,
            "  step class: {:?} (wants \"#32770\")",
            get_class_name(hwnd)
        );
        let _ = writeln!(out, "  step title: {:?}", get_window_title(hwnd));
        let Some(uia) = backend.uia.as_ref() else {
            let _ = writeln!(out, "  step uia: no IUIAutomation (init not run)");
            return out;
        };
        let dialog = match uia.ElementFromHandle(UIA_HWND(hwnd.0)) {
            Ok(el) => el,
            Err(e) => {
                let _ = writeln!(out, "  step ElementFromHandle: error {e}");
                return out;
            }
        };
        let _ = writeln!(
            out,
            "  step File name edit Value (Edit 1148, Edit 1001): {:?}, {:?}",
            edit_value_by_automation_id(uia, &dialog, "1148"),
            edit_value_by_automation_id(uia, &dialog, "1001")
        );
        let _ = writeln!(
            out,
            "  step directory: {:?}",
            read_file_dialog_directory(uia, &dialog)
        );
        let all = match uia
            .CreateTrueCondition()
            .and_then(|c| dialog.FindAll(TreeScope_Descendants, &c))
        {
            Ok(all) => all,
            Err(e) => {
                let _ = writeln!(out, "  descendants: FindAll error {e}");
                return out;
            }
        };
        let count = all.Length().unwrap_or(0);
        let _ = writeln!(
            out,
            "  descendants: {count} (Edit, ComboBox and ToolBar listed)"
        );
        let wanted = [
            UIA_EditControlTypeId.0,
            50003, // UIA_ComboBoxControlTypeId (control_type_name's table)
            UIA_ToolBarControlTypeId.0,
        ];
        for i in 0..count {
            let Ok(el) = all.GetElement(i) else { continue };
            let control_type = get_i32_property(&el, UIA_ControlTypePropertyId);
            if !wanted.contains(&control_type) {
                continue;
            }
            let _ = writeln!(
                out,
                "    {} ({control_type}) id={:?} name={:?} value={:?} class={:?}",
                control_type_name(control_type),
                get_string_property(&el, UIA_AutomationIdPropertyId),
                get_string_property(&el, UIA_NamePropertyId),
                get_string_property(&el, UIA_ValueValuePropertyId),
                get_string_property(&el, UIA_ClassNamePropertyId),
            );
        }
        out
    }

    /// Which common dialog [`open_test_dialog`] opens.
    #[derive(Clone, Copy)]
    enum DialogKind {
        Open,
        SaveAs,
    }

    /// A common dialog open on a thread of its own, showing a folder made for
    /// it; dropping it closes the dialog, joins its thread and removes the
    /// folder.
    struct TestDialog {
        /// The folder, by its long path as the dialog shows it.
        dir: String,
        made: std::path::PathBuf,
        /// One of the dialog's child windows, as a click names one.
        child: i64,
        guard: Option<CloseOnDrop>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for TestDialog {
        fn drop(&mut self) {
            drop(self.guard.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            let _ = std::fs::remove_dir_all(&self.made);
        }
    }

    /// Open a `kind` dialog titled after `tag`, on a folder holding `files`,
    /// with its File name preset to `preset`, and wait for it to appear.
    fn open_test_dialog(kind: DialogKind, tag: &str, files: &[&str], preset: &str) -> TestDialog {
        // The folder, by its long path: the temp path can be a short (8.3)
        // one, and the dialog shows the long one.
        let made = std::env::temp_dir().join(format!("docent-692-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&made).unwrap();
        for file in files {
            std::fs::write(made.join(file), b"692").unwrap();
        }
        let canonical = std::fs::canonicalize(&made).unwrap();
        let dir = canonical.to_string_lossy();
        let dir = dir.strip_prefix(r"\\?\").unwrap_or(&dir).to_string();
        let title = match kind {
            DialogKind::Open => format!("Docent read test {tag} {} - Open", std::process::id()),
            DialogKind::SaveAs => {
                format!("Docent read test {tag} {} - Save As", std::process::id())
            }
        };

        let thread = {
            let dir = dir.clone();
            let title = title.clone();
            let preset = preset.to_string();
            thread::spawn(move || unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED as u32);
                let dir_w = wide(&dir);
                let title_w = wide(&title);
                let filter: Vec<u16> = "Text files\0*.txt\0\0".encode_utf16().collect();
                let mut file = [0u16; 260];
                for (slot, unit) in file.iter_mut().zip(preset.encode_utf16()) {
                    *slot = unit;
                }
                let mut ofn = OPENFILENAMEW {
                    lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
                    lpstrFilter: PCWSTR(filter.as_ptr()),
                    lpstrFile: PWSTR(file.as_mut_ptr()),
                    nMaxFile: file.len() as u32,
                    lpstrInitialDir: PCWSTR(dir_w.as_ptr()),
                    lpstrTitle: PCWSTR(title_w.as_ptr()),
                    ..Default::default()
                };
                // Each returns once the dialog is closed (cancelled: no file).
                match kind {
                    DialogKind::Open => {
                        ofn.Flags = (OFN_EXPLORER | OFN_FILEMUSTEXIST) as u32;
                        let _ = GetOpenFileNameW(&mut ofn);
                    }
                    DialogKind::SaveAs => {
                        ofn.Flags = OFN_EXPLORER as u32;
                        let _ = GetSaveFileNameW(&mut ofn);
                    }
                }
                CoUninitialize();
            })
        };

        let title_w = wide(&title);
        let dialog = poll(Duration::from_secs(20), || {
            let h = unsafe { FindWindowW(windows_core::w!("#32770"), PCWSTR(title_w.as_ptr())) };
            (!h.0.is_null()).then_some(h.0 as isize)
        });
        let mut opened = TestDialog {
            dir,
            made,
            child: 0,
            guard: dialog.map(CloseOnDrop),
            thread: Some(thread),
        };
        let dialog = dialog.expect("the common dialog did not appear");

        // The Open or Save button (IDOK); the File name combo box (cmb13)
        // where a dialog shows its button windowless.
        opened.child = [1, 0x047C]
            .into_iter()
            .map(|id| unsafe { GetDlgItem(Some(HWND(dialog as *mut _)), id) })
            .find(|h| !h.0.is_null())
            .expect("the dialog has neither an OK button nor a File name box window")
            .0 as i64;
        assert_ne!(
            opened.child, dialog as i64,
            "the read is given a child window"
        );
        opened
    }

    /// Read the dialog until the read, passed through what the worker records
    /// for its type, is `expected`; print the diagnosis and fail otherwise.
    fn assert_recorded(backend: &WindowsAccessibilityBackend, child: i64, expected: (&str, &str)) {
        let mut last = None;
        let matched = poll(Duration::from_secs(20), || {
            last = backend.read_file_dialog_path(child).map(|(kind, shown)| {
                // The worker's emission (handle_click): only an Open dialog's
                // text is looked up on disk.
                let path = if kind == "open" {
                    backend.file_on_disk(&shown).unwrap_or(shown)
                } else {
                    shown
                };
                (kind, path)
            });
            match &last {
                Some((kind, path)) if kind == expected.0 && path == expected.1 => Some(()),
                _ => None,
            }
        });
        if matched.is_none() {
            // Diagnostic only: report where the read stops and the dialog's
            // tree, so a failing run shows what the dialog holds.
            eprintln!("{}", unsafe { diagnose_file_dialog_read(backend, child) });
            eprintln!(
                "  shell display name of {}: {:?}",
                expected.1,
                shell_display_name(expected.1)
            );
        }
        assert!(matched.is_some(), "read {last:?}, expected {expected:?}");
    }

    /// A read given one of an Open dialog's child windows — its Open button,
    /// which is what a click names — resolves the dialog as that window's
    /// root and returns the dialog type from the title and the folder the
    /// dialog shows joined with its File name, which names the file on disk
    /// whether or not the system hides its extension; once the dialog has
    /// closed, a read from the same window returns none.
    #[test]
    fn a_file_dialog_read_from_its_open_button_names_the_folder_and_the_file() {
        let mut opened = open_test_dialog(DialogKind::Open, "open", &[FILE], FILE);
        let child = opened.child;
        let mut backend = WindowsAccessibilityBackend::new();
        backend.init().unwrap();
        assert_eq!(
            backend.root_window_handle(child),
            opened.guard.as_ref().unwrap().0 as i64
        );

        let expected = format!("{}\\{FILE}", opened.dir);
        assert_recorded(&backend, child, ("open", &expected));

        drop(opened.guard.take());
        if let Some(thread) = opened.thread.take() {
            thread.join().unwrap();
        }
        assert_eq!(
            backend.read_file_dialog_path(child),
            None,
            "a closed dialog reads as none"
        );
        backend.cleanup();
    }

    /// An empty File name box reads as no file: the box's label ("File
    /// name:", its Name) is not its text. Read once the dialog's folder and
    /// box are both readable, so the none is the box's and not a dialog
    /// still loading.
    #[test]
    fn a_file_dialog_with_an_empty_file_name_box_reads_as_none() {
        let opened = open_test_dialog(DialogKind::Open, "empty", &[FILE], "");
        let mut backend = WindowsAccessibilityBackend::new();
        backend.init().unwrap();
        let root = HWND(backend.root_window_handle(opened.child) as *mut _);
        let loaded = poll(Duration::from_secs(20), || unsafe {
            let uia = backend.uia.as_ref()?;
            let dialog = uia.ElementFromHandle(UIA_HWND(root.0)).ok()?;
            read_file_dialog_directory(uia, &dialog)?;
            edit_value_by_automation_id(uia, &dialog, "1148")
                .or_else(|| edit_value_by_automation_id(uia, &dialog, "1001"))
        });
        if loaded.is_none() {
            eprintln!("{}", unsafe {
                diagnose_file_dialog_read(&backend, opened.child)
            });
        }
        assert_eq!(loaded.as_deref(), Some(""), "the File name box is empty");
        assert_eq!(backend.read_file_dialog_path(opened.child), None);
        backend.cleanup();
    }

    /// A Save As dialog's read returns `save_as` and the folder joined with
    /// the File name text as shown — the file to be written, which need not
    /// exist and is not looked up on disk.
    #[test]
    fn a_save_as_dialog_read_names_the_folder_and_the_text() {
        let opened = open_test_dialog(DialogKind::SaveAs, "save", &[FILE], "docent-692-new");
        let mut backend = WindowsAccessibilityBackend::new();
        backend.init().unwrap();
        let expected = format!("{}\\docent-692-new", opened.dir);
        assert_recorded(&backend, opened.child, ("save_as", &expected));
        backend.cleanup();
    }

    /// The lookup on a real folder, on a thread set up as a worker's (COM
    /// initialised). The shell's display name of a file is its name or its
    /// stem, as the system shows or hides extensions, and the answers are
    /// asserted for whichever it is: a stem names its one file; a name typed
    /// with its extension names that file even beside another file shown
    /// under the same text; a text two files are shown as names neither;
    /// a text more files than the candidate limit are listed under names
    /// none, where fewer resolve; and a path that is not a full one is not
    /// looked up.
    #[test]
    fn the_file_a_text_names_is_looked_up_on_disk_within_a_bound() {
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED as u32) }.is_ok();
        let made = std::env::temp_dir().join(format!("docent-692-lookup-{}", std::process::id()));
        std::fs::create_dir_all(&made).unwrap();
        let canonical = std::fs::canonicalize(&made).unwrap();
        let dir = canonical.to_string_lossy();
        let dir = dir.strip_prefix(r"\\?\").unwrap_or(&dir).to_string();
        for name in ["solo.txt", "pair.txt", "pair.log", "few.txt", "many.txt"] {
            std::fs::write(canonical.join(name), b"692").unwrap();
        }
        for n in 0..3 {
            std::fs::write(canonical.join(format!("few.txt.{n}")), b"692").unwrap();
        }
        for n in 0..FILE_DIALOG_CANDIDATE_LIMIT {
            std::fs::write(canonical.join(format!("many.txt.{n}")), b"692").unwrap();
        }
        let path = |name: &str| format!("{dir}\\{name}");

        // The shell answers, with the name or the stem.
        let display = shell_display_name(&path("solo.txt"));
        assert!(
            matches!(display.as_deref(), Some("solo" | "solo.txt")),
            "display name of solo.txt: {display:?}"
        );
        let hides = display.as_deref() == Some("solo");
        let stem_names = |name: &str| hides.then(|| path(name));
        assert_eq!(file_on_disk(&path("solo")), stem_names("solo.txt"));
        assert_eq!(file_on_disk(&path("few")), stem_names("few.txt"));
        // Where extensions are hidden, many.txt alone displays as "many":
        // only the bound leaves it unnamed.
        assert_eq!(file_on_disk(&path("many")), None);

        assert_eq!(file_on_disk(&path("pair.txt")), Some(path("pair.txt")));
        assert_eq!(file_on_disk(&path("pair.log")), Some(path("pair.log")));
        // The shell shows an extension of a type with no registered handler
        // whatever the setting, so "pair" names both files only where both
        // are shown as it.
        let pair_shown = |name: &str| shell_display_name(&path(name)).as_deref() == Some("pair");
        let pair_expected = match (pair_shown("pair.txt"), pair_shown("pair.log")) {
            (true, false) => Some(path("pair.txt")),
            (false, true) => Some(path("pair.log")),
            _ => None,
        };
        assert_eq!(file_on_disk(&path("pair")), pair_expected);
        assert_eq!(file_on_disk(&path("absent")), None);
        assert_eq!(file_on_disk(&path("pair*")), None, "a filter");
        assert_eq!(file_on_disk("pair.txt"), None, "no folder");
        assert_eq!(file_on_disk(r"sub\pair.txt"), None, "a relative path");

        let _ = std::fs::remove_dir_all(&made);
        if com {
            unsafe { CoUninitialize() };
        }
    }
}

#[cfg(test)]
mod input_thread_helper_tests {
    //! The Input_Thread's own helpers, run with the system's real values.

    use super::*;

    /// Pairing on the Input_Thread's state with the system's double-click
    /// bounds: a second press at the same point and time completes a
    /// double-click, the press after it starts a new pair, and a broken pair
    /// completes none. Each test thread has its own pairing state.
    #[test]
    fn the_input_threads_pairing_reads_the_systems_double_click_bounds() {
        let press = |time_ms| ClickPress {
            time_ms,
            x: 10,
            y: 10,
            window: 42,
        };
        assert!(!double_click_completed_by(press(1000)));
        assert!(double_click_completed_by(press(1000)));
        assert!(!double_click_completed_by(press(1000)), "third press");
        double_click_break_pair();
        assert!(!double_click_completed_by(press(1000)), "after the break");
        // Later than any double-click time the system allows (5000 ms max).
        assert!(!double_click_completed_by(press(1000 + 6000)));
    }

    /// The layout read's guards: thread 0, which would name this thread's own
    /// layout, and a key that is no punctuation key read nothing.
    #[test]
    fn the_foreground_layout_read_reads_nothing_for_thread_zero_or_a_non_punctuation_key() {
        unsafe {
            assert_eq!(foreground_layout_char(0xBE, 0), 0, "thread 0");
            assert_eq!(
                foreground_layout_char(0x41, GetCurrentThreadId()),
                0,
                "a letter key"
            );
        }
    }
}
