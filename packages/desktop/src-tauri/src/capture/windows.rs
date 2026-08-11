// Windows UI Automation Provider — platform-specific capture implementation.
//
// This module implements the `CaptureLayer` trait for Windows using a
// worker pool architecture:
//
// - **Input_Thread**: Runs `SetWinEventHook` / `SetWindowsHookEx` callbacks
//   and a message pump. Captures raw event data (coordinates, window handles,
//   key codes, timestamps) and dispatches `RawEvent`s to workers. Performs
//   zero accessibility queries.
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

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationSelectionPattern, SetWinEventHook, TreeScope_Subtree, UIA_AutomationIdPropertyId,
    UIA_ClassNamePropertyId, UIA_ControlTypePropertyId, UIA_FrameworkIdPropertyId,
    UIA_IsControlElementPropertyId, UIA_IsPasswordPropertyId, UIA_LabeledByPropertyId,
    UIA_LevelPropertyId, UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId,
    UIA_NativeWindowHandlePropertyId, UIA_PositionInSetPropertyId, UIA_SelectionPatternId,
    UIA_SizeOfSetPropertyId, UIA_ValueValuePropertyId, UnhookWinEvent, HWINEVENTHOOK,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, EnumWindows, GetClassNameW, GetForegroundWindow, GetMessageW,
    GetParent, GetWindow, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
    IsWindowVisible, PeekMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, WindowFromPoint, CHILDID_SELF, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY,
    EVENT_OBJECT_FOCUS, EVENT_OBJECT_SELECTION, EVENT_OBJECT_VALUECHANGE, EVENT_SYSTEM_FOREGROUND,
    GWL_STYLE, GW_OWNER, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, OBJID_WINDOW, PM_NOREMOVE,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WM_APP, WM_KEYDOWN, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MOUSEWHEEL, WM_NULL, WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN,
    WM_USER, WS_CHILD,
};

use super::element_mapping::{
    map_element, LocatorMeasurements, MeasuredIndex, MeasuredPair, NativeElementProperties,
};
use super::timing;
use super::worker_pool::{
    fallback_drain_and_seal, worker_loop, AccessibilityBackend, PendingDirectory, RawEvent,
    RawEventType, WorkerPool, FLUSH_BARRIER_TIMEOUT,
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
const WM_APP_FLUSH: u32 = WM_APP + 1;

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

/// Horizontal mouse wheel message (not always exported by the windows crate).
const WM_MOUSEHWHEEL: u32 = 0x020E;

// ---------------------------------------------------------------------------
// PID exclusion helper
// ---------------------------------------------------------------------------

/// Check if a window is owned by (or is a child of) a window belonging to the
/// excluded process. This catches system dialogs (prompt, file picker, etc.)
/// that are visually part of Docent but run under system process PIDs like
/// explorer.exe.
unsafe fn is_owned_by_excluded(hwnd: HWND, excluded_pid: u32) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetAncestor;
    use windows::Win32::UI::WindowsAndMessaging::GA_ROOTOWNER;

    // Walk up the owner chain to the root owner window
    let root_owner = GetAncestor(hwnd, GA_ROOTOWNER);
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
/// rule first (PID 0 / direct excluded-PID match), then the Windows-only
/// WebView2 process-tree checks: Docent renders its UI in a WebView2 host that
/// spawns several layers of child processes under different PIDs, so events
/// from those children must also be excluded when self-capture exclusion is on.
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
        // Fallback: check if the process is msedgewebview2.exe (WebView2
        // renderer) — these are always Docent's children when self-capture
        // exclusion is enabled.
        if is_webview_process(event_pid) {
            return false;
        }
    }
    true
}

/// Check if a process is a WebView2 renderer by its executable name.
fn is_webview_process(pid: u32) -> bool {
    if let Some(name) = get_process_exe_name(pid) {
        let lower = name.to_lowercase();
        lower.contains("msedgewebview2") || lower.contains("docent")
    } else {
        false
    }
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

/// Get the executable name of a process by PID using CreateToolhelp32Snapshot.
fn get_process_exe_name(pid: u32) -> Option<String> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32 {
            dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };
        if Process32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == pid {
                    let _ = windows::Win32::Foundation::CloseHandle(snapshot);
                    let name = entry
                        .szExeFile
                        .iter()
                        .take_while(|&&c| c != 0)
                        .map(|&c| c as u8 as char)
                        .collect::<String>();
                    return Some(name);
                }
                if Process32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        None
    }
}

/// Get the parent PID of a process using CreateToolhelp32Snapshot.
fn get_parent_pid(pid: u32) -> Option<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32 {
            dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };
        if Process32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == pid {
                    let _ = windows::Win32::Foundation::CloseHandle(snapshot);
                    return Some(entry.th32ParentProcessID);
                }
                if Process32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
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
    match msg {
        WM_MBUTTONDOWN => Some(RawEventType::Click),
        WM_RBUTTONDOWN => Some(RawEventType::RightClick),
        _ => None,
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

    /// PID of the current foreground window. Updated on EVENT_SYSTEM_FOREGROUND.
    /// Events from non-foreground processes are filtered out.
    static INPUT_FOREGROUND_PID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };

    /// Root window handle of the last dispatched foreground event. Used to
    /// deduplicate foreground events (click-based + WinEvent-based).
    static INPUT_LAST_FOREGROUND_HWND: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };

    /// Mouse-down position for drag detection. Set on WM_LBUTTONDOWN,
    /// compared against WM_LBUTTONUP to classify click vs drag.
    static INPUT_MOUSE_DOWN_POS: std::cell::Cell<Option<POINT>> = const { std::cell::Cell::new(None) };

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

    /// IUIAutomation instance for pre-capturing click elements in the
    /// Input_Thread. Used ONLY for `ElementFromPoint` — at left mouse-up on a
    /// non-drag click, and at right/middle button-down — with a short timeout.
    /// This ensures the element is captured while the target window is still
    /// alive (before the click is processed).
    static INPUT_UIA: std::cell::RefCell<Option<IUIAutomation>> =
        const { std::cell::RefCell::new(None) };

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

    /// Timestamp of the most recent completed click (WM_LBUTTONUP that was
    /// classified as a click, not a drag). Used to suppress duplicate
    /// EVENT_OBJECT_SELECTION that fires immediately after a click.
    static INPUT_LAST_CLICK_TIMESTAMP: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Record a low-level input event (button press or release, key press, or
/// wheel) for WinEvent correlation: the timestamp gates whether a subsequent
/// WinEvent is user-caused at all, the window scopes selection correlation to
/// the root the input landed in.
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
        if posted.is_err() {
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
            let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
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
                let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
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
        let probe = unsafe { PostThreadMessageW(tid, WM_NULL, WPARAM(0), LPARAM(0)) };
        if probe.is_err() {
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
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
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
/// worker pool via a channel. It performs zero accessibility queries.
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
        if let Err(e) = CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() {
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
    INPUT_ACTIVE.with(|a| *a.borrow_mut() = Some(active.clone()));
    INPUT_EXCLUDED_PID.with(|p| *p.borrow_mut() = Some(excluded_pid));
    INPUT_INCLUDED_PID.with(|p| *p.borrow_mut() = Some(included_pid));
    INPUT_FLUSH_REQUESTS.with(|q| *q.borrow_mut() = Some(flush_requests));

    // Create a lightweight IUIAutomation instance for pre-capturing click
    // elements. Used ONLY for the ElementFromPoint pre-capture (left mouse-up on a non-drag click; right/middle button-down).
    let input_uia: Option<IUIAutomation> =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL).ok() };
    INPUT_UIA.with(|u| *u.borrow_mut() = input_uia);

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
                    event_min,
                    event_max,
                    None,
                    Some(input_win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            if hook.is_invalid() {
                return Err(CaptureError::HookFailed(format!(
                    "SetWinEventHook failed for events {event_min}–{event_max}"
                )));
            }
            win_hooks.push(hook);
        }

        // Low-level mouse hook.
        let mouse_hook = unsafe {
            SetWindowsHookExW(WH_MOUSE_LL, Some(input_mouse_ll_proc), None, 0)
                .map_err(|e| CaptureError::HookFailed(format!("WH_MOUSE_LL: {e}")))?
        };
        ll_hooks.push(mouse_hook);

        // Low-level keyboard hook.
        let kb_hook = unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(input_keyboard_ll_proc), None, 0)
                .map_err(|e| CaptureError::HookFailed(format!("WH_KEYBOARD_LL: {e}")))?
        };
        ll_hooks.push(kb_hook);

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
        INPUT_UIA.with(|u| *u.borrow_mut() = None);
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
    INPUT_LAST_FOREGROUND_HWND.with(|p| p.set(0));
    INPUT_MOUSE_DOWN_POS.with(|p| p.set(None));
    INPUT_OPENED_WINDOWS.with(|s| s.borrow_mut().clear());
    INPUT_PID_CACHE.with(|c| c.borrow_mut().clear());
    INPUT_UIA.with(|u| *u.borrow_mut() = None);
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

/// Assign a sequence ID and dispatch a `RawEvent` to the bridge thread.
/// Called from hook callbacks on the Input_Thread.
fn input_dispatch_raw_event(mut event: RawEvent) {
    // Assign monotonic sequence ID.
    let seq_id = INPUT_SEQUENCE_COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .map(|counter| counter.fetch_add(1, Ordering::SeqCst) + 1)
            .unwrap_or(0)
    });
    event.sequence_id = seq_id;

    // Send to bridge thread.
    INPUT_RAW_SENDER.with(|s| {
        if let Some(sender) = s.borrow().as_ref() {
            let _ = sender.send(BridgeMessage::Event(Box::new(event)));
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

/// Pre-capture the element at the given screen coordinates using the
/// Input_Thread's IUIAutomation instance. Returns `Some(ElementDescription)`
/// if the query succeeds quickly, `None` if it fails or the UIA instance
/// is not available. Called at left mouse-up on a non-drag click and at
/// right/middle button-down, so the element is captured while the target
/// window is guaranteed to still be alive.
unsafe fn input_pre_capture_element(x: i32, y: i32) -> Option<super::ElementDescription> {
    INPUT_UIA.with(|u| {
        let uia = u.borrow();
        let uia = uia.as_ref()?;
        let pt = POINT { x, y };
        let element = uia.ElementFromPoint(pt).ok()?;
        // Unmeasured by design: this runs inside the low-level mouse hook's
        // latency budget (Windows silently unhooks slow LL hooks), so the
        // FindAll-based match measurement is off-limits here. Locator entries
        // carry values only; the pair ships absent (= not measured).
        uia_element_to_description_unmeasured(uia, &element)
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

/// WinEvent callback for the Input_Thread. Captures raw event data and
/// dispatches `RawEvent`s. Performs zero accessibility queries.
unsafe extern "system" fn input_win_event_proc(
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

    let mut process_id: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    let excluded = input_get_excluded_pid();

    // PID exclusion check (cached — covers both PID tree and ownership).
    if !input_should_keep_event_cached(process_id, excluded, hwnd) {
        return;
    }

    // Foreground PID tracking and filtering.
    if event == EVENT_SYSTEM_FOREGROUND {
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
        x if x == EVENT_SYSTEM_FOREGROUND => {
            // Only dispatch context_switch if correlated with recent user input.
            // Programmatic foreground changes (notifications, minimize/restore by
            // other apps) will not have a preceding input event within the window.
            if !input_correlated(timestamp, timing::FOREGROUND_CORRELATION_MS) {
                return; // Programmatic — suppress.
            }

            // Resolve root window for deduplication comparison.
            use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
            let root = GetAncestor(hwnd, GA_ROOT);
            let root_handle = if root.0.is_null() {
                window_handle
            } else {
                root.0 as i64
            };

            // Deduplicate: if the click-based handler already dispatched a
            // foreground event for this same root window, skip.
            let last_fg = INPUT_LAST_FOREGROUND_HWND.with(|h| h.get());
            if root_handle == last_fg {
                return; // Already dispatched by click handler.
            }
            INPUT_LAST_FOREGROUND_HWND.with(|h| h.set(root_handle));

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
                pre_captured_element: None,
            });
        }

        x if x == EVENT_OBJECT_CREATE
            && id_object == OBJID_WINDOW.0
            && id_child == CHILDID_SELF as i32 =>
        {
            if !IsWindow(Some(hwnd)).as_bool() {
                return;
            }
            // Only emit for top-level visible windows.
            if !IsWindowVisible(hwnd).as_bool() {
                return;
            }
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if style & WS_CHILD.0 != 0 {
                return;
            }
            let parent = GetParent(hwnd);
            if let Ok(p) = parent {
                if !p.0.is_null() {
                    return;
                }
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
                pre_captured_element: None,
            });
            // Track this window so we only emit context_close for it.
            INPUT_OPENED_WINDOWS.with(|s| s.borrow_mut().insert(window_handle));
        }

        x if x == EVENT_OBJECT_DESTROY
            && id_object == OBJID_WINDOW.0
            && id_child == CHILDID_SELF as i32 =>
        {
            // Only emit context_close for true top-level windows.
            // Skip child windows, owned windows, and windows without
            // titles to avoid flooding when dialogs with many
            // sub-windows are dismissed.
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if style & WS_CHILD.0 != 0 {
                // Child window — skip.
            } else {
                let parent = GetParent(hwnd);
                let has_parent = parent.is_ok_and(|p| !p.0.is_null());
                // Check if the window is owned by another window.
                let owner = GetWindow(hwnd, GW_OWNER);
                let has_owner = owner.is_ok_and(|o| o != HWND::default());
                // Check if the window has a title (titleless windows
                // are typically internal framework windows).
                let title = get_window_title(hwnd);
                // Check if this window's root ancestor is the current
                // foreground window — if so, it's an internal sub-window
                // (e.g. file dialog folder view refreshing), not a
                // standalone window the user closed.
                let fg = GetForegroundWindow();
                let root = {
                    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
                    GetAncestor(hwnd, GA_ROOT)
                };
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
                        pre_captured_element: None,
                    });
                }
            }
        }

        x if x == EVENT_OBJECT_FOCUS => {
            // Only dispatch focus if correlated with recent user input.
            // Programmatic focus changes (e.g., SetFocus calls from apps)
            // will not have a preceding input event within the window.
            if !input_correlated(timestamp, timing::FOCUS_CORRELATION_MS) {
                return; // Programmatic focus — suppress.
            }

            // Suppress focus events that follow a mouse click (within 200ms).
            // The click already captures the interaction — focus is redundant.
            // Focus is only meaningful when caused by Tab key (keyboard navigation).
            let mouse_down = INPUT_MOUSE_DOWN_POS.with(|p| p.get().is_some());
            if mouse_down {
                return; // Click in progress — focus is redundant.
            }
            let last_click = INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.get());
            if last_click > 0 && timestamp.saturating_sub(last_click) < 200 {
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
                callback_params: [id_object as i64, id_child as i64, 0, 0],
                pre_captured_element: None,
            });
        }

        x if x == EVENT_OBJECT_VALUECHANGE => {
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
                use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
                let vc_root = GetAncestor(hwnd, GA_ROOT);
                let kb_root = HWND(last_kb_window as *mut _);
                let kb_root_resolved = GetAncestor(kb_root, GA_ROOT);
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
                pre_captured_element: None,
            });
        }

        x if x == EVENT_OBJECT_SELECTION => {
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
                use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
                let sel_root = GetAncestor(hwnd, GA_ROOT);
                let input_hwnd = HWND(input_window as *mut _);
                let input_root = GetAncestor(input_hwnd, GA_ROOT);
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
            // 2. A click was recently completed (within 200ms)
            let mouse_down = INPUT_MOUSE_DOWN_POS.with(|p| p.get().is_some());
            if mouse_down {
                return; // Click in progress — suppress.
            }
            let last_click = INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.get());
            if last_click > 0 && timestamp.saturating_sub(last_click) < 200 {
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
                pre_captured_element: None,
            });
        }

        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Input_Thread low-level mouse hook callback
// ---------------------------------------------------------------------------

/// Low-level mouse hook for the Input_Thread. Captures raw mouse data,
/// performs click-vs-drag classification, and dispatches `RawEvent`s.
/// No accessibility queries.
unsafe extern "system" fn input_mouse_ll_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code >= 0 && input_is_active() {
        let mouse_struct = &*(l_param.0 as *const MSLLHOOKSTRUCT);
        let msg = w_param.0 as u32;
        let pt = mouse_struct.pt;

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

            match msg {
                WM_LBUTTONDOWN => {
                    // Record the input for correlation.
                    note_input(timestamp, window_handle);
                    // Store mouse-down position for drag detection.
                    INPUT_MOUSE_DOWN_POS.with(|p| p.set(Some(pt)));
                    // Set click timestamp on mousedown (not just mouseup) because
                    // EVENT_OBJECT_SELECTION can fire between mousedown and mouseup.
                    INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.set(timestamp));

                    // If clicking on a different top-level window, proactively
                    // dispatch a Foreground event. Some window classes (e.g.
                    // STATIC) don't fire EVENT_SYSTEM_FOREGROUND on activation,
                    // so we detect the switch here to guarantee context_switch.
                    if !point_hwnd.0.is_null() {
                        use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
                        let clicked_root = GetAncestor(point_hwnd, GA_ROOT);
                        let fg_root = GetAncestor(fg_hwnd, GA_ROOT);
                        let clicked_root_h = if clicked_root.0.is_null() {
                            point_hwnd
                        } else {
                            clicked_root
                        };
                        let fg_root_h = if fg_root.0.is_null() {
                            fg_hwnd
                        } else {
                            fg_root
                        };
                        if clicked_root_h != fg_root_h {
                            let clicked_handle = clicked_root_h.0 as i64;
                            let last_fg = INPUT_LAST_FOREGROUND_HWND.with(|h| h.get());
                            if clicked_handle != last_fg {
                                // Different root window — user is switching context.
                                INPUT_LAST_FOREGROUND_HWND.with(|h| h.set(clicked_handle));
                                let mut clicked_pid: u32 = 0;
                                GetWindowThreadProcessId(clicked_root_h, Some(&mut clicked_pid));
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
                                    pre_captured_element: None,
                                });
                            }
                        }
                    }
                }
                WM_LBUTTONUP => {
                    // A release is input too: selections completed at the end
                    // of a long drag correlate with the release, not the press.
                    note_input(timestamp, window_handle);
                    let classified =
                        classify_left_release(INPUT_MOUSE_DOWN_POS.with(|p| p.get()), pt);

                    if let LeftRelease::DragPair { source_coords } = classified {
                        // Drag detected: dispatch DragStart + Drop pair.
                        input_dispatch_raw_event(RawEvent {
                            event_type: RawEventType::DragStart { source_coords },
                            sequence_id: 0,
                            timestamp,
                            screen_x: source_coords.0,
                            screen_y: source_coords.1,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: (false, false, false, false),
                            scroll_delta: 0.0,
                            callback_params: [0, 0, 0, 0],
                            pre_captured_element: None,
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
                            modifiers: (false, false, false, false),
                            scroll_delta: 0.0,
                            callback_params: [0, 0, 0, 0],
                            pre_captured_element: None,
                        });
                    } else {
                        // Click detected — pre-capture the element while
                        // the window is guaranteed alive.
                        let pre_element = input_pre_capture_element(pt.x, pt.y);
                        input_dispatch_raw_event(RawEvent {
                            event_type: RawEventType::Click,
                            sequence_id: 0,
                            timestamp,
                            screen_x: pt.x,
                            screen_y: pt.y,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: (false, false, false, false),
                            scroll_delta: 0.0,
                            callback_params: [0, 0, 0, 0],
                            pre_captured_element: pre_element,
                        });
                        INPUT_LAST_CLICK_TIMESTAMP.with(|t| t.set(timestamp));
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
                        pre_captured_element: None,
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
                        pre_captured_element: None,
                    });
                }
                // The middle and right buttons record on the press itself, each
                // dispatching the raw event its message maps to.
                WM_MBUTTONDOWN | WM_RBUTTONDOWN => {
                    if let Some(event_type) = down_dispatch_event_type(msg) {
                        // Record the input for correlation.
                        note_input(timestamp, window_handle);
                        let pre_element = input_pre_capture_element(pt.x, pt.y);
                        input_dispatch_raw_event(RawEvent {
                            event_type,
                            sequence_id: 0,
                            timestamp,
                            screen_x: pt.x,
                            screen_y: pt.y,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: (false, false, false, false),
                            scroll_delta: 0.0,
                            callback_params: [0, 0, 0, 0],
                            pre_captured_element: pre_element,
                        });
                    }
                }
                _ => {}
            }
        } else if msg == WM_LBUTTONUP {
            // Excluded PID — clear drag state.
            INPUT_MOUSE_DOWN_POS.with(|p| p.set(None));
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
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
    if n_code >= 0 && input_is_active() {
        let msg = w_param.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let kb_struct = &*(l_param.0 as *const KBDLLHOOKSTRUCT);

            let hwnd = GetForegroundWindow();
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let excluded = input_get_excluded_pid();

            if input_should_keep_event_cached(pid, excluded, hwnd) {
                let modifiers = get_modifier_state();
                let timestamp = current_timestamp_ms();
                let window_handle = hwnd.0 as i64;

                // Record the input for correlation (plus the keyboard-only
                // pair used by value-change correlation).
                note_input(timestamp, window_handle);
                INPUT_LAST_KEYBOARD_TIMESTAMP.with(|t| t.set(timestamp));
                INPUT_LAST_KEYBOARD_WINDOW.with(|w| w.set(window_handle));

                input_dispatch_raw_event(RawEvent {
                    event_type: RawEventType::Keyboard,
                    sequence_id: 0,
                    timestamp,
                    screen_x: 0,
                    screen_y: 0,
                    window_handle,
                    process_id: pid,
                    key_code: kb_struct.vkCode,
                    modifiers,
                    scroll_delta: 0.0,
                    callback_params: [0, 0, 0, 0],
                    pre_captured_element: None,
                });
            }
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
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
    let (mut props, control_type_id, window_root) = gather_native_properties(uia, element);
    if let Some(root) = window_root {
        props.measurements = measure_candidates(uia, &root, element, control_type_id, &props);
    }
    Some(map_element(&props))
}

/// Convert a UIA element to an `ElementDescription` WITHOUT measuring match
/// statistics — candidate values only, pairs absent (the schema's "not
/// measured"). Used by the input-hook pre-capture path, which sits in the
/// system-wide low-level mouse hook: Windows silently unhooks slow LL hooks,
/// so `FindAll` traversals are off-limits there.
pub(crate) unsafe fn uia_element_to_description_unmeasured(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Option<ElementDescription> {
    let (props, _control_type_id, _window_root) = gather_native_properties(uia, element);
    Some(map_element(&props))
}

/// Read every native property the element description needs (docent#138:
/// the original six plus ClassName, FrameworkId, LabeledBy-name, and the
/// provider-reported set ordinals), plus the tree path annotated with the
/// window-root position. Returns the raw control-type id (measurement
/// conditions match on it) and the top-level window element (the measurement
/// scope), when resolvable.
unsafe fn gather_native_properties(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> (NativeElementProperties, i32, Option<IUIAutomationElement>) {
    let control_type_id = get_i32_property(element, UIA_ControlTypePropertyId);
    let automation_id = get_string_property(element, UIA_AutomationIdPropertyId);
    let name = get_string_property(element, UIA_NamePropertyId);
    let localized_type = get_string_property(element, UIA_LocalizedControlTypePropertyId);
    let value = get_string_property(element, UIA_ValueValuePropertyId);
    let is_password = get_bool_property(element, UIA_IsPasswordPropertyId);
    let class_name = get_string_property(element, UIA_ClassNamePropertyId);
    let framework_id = get_string_property(element, UIA_FrameworkIdPropertyId);
    let labeled_by = get_labeled_by_name(element);
    let position_in_set = get_i32_property(element, UIA_PositionInSetPropertyId);
    let size_of_set = get_i32_property(element, UIA_SizeOfSetPropertyId);
    let level = get_i32_property(element, UIA_LevelPropertyId);

    let (tree_path, window_root_offset, window_root) = build_tree_path_with_root(uia, element);

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
        labeled_by,
        position_in_set,
        size_of_set,
        level,
        window_root_offset,
        measurements: Default::default(),
    };
    (props, control_type_id, window_root)
}

/// Read the accessible name of the element referenced by the LabeledBy
/// property. The property's VARIANT wraps an `IUIAutomationElement` behind
/// `IUnknown`; any failure along the way yields `""` (total, like every
/// property helper here).
unsafe fn get_labeled_by_name(element: &IUIAutomationElement) -> String {
    use windows::core::Interface;
    use windows::Win32::System::Variant::VT_UNKNOWN;
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
        .map(|label| get_string_property(&label, UIA_NamePropertyId))
        .unwrap_or_default()
}

/// Build a BSTR-typed VARIANT for property conditions on string properties.
unsafe fn bstr_variant(value: &str) -> windows::Win32::System::Variant::VARIANT {
    windows::Win32::System::Variant::VARIANT::from(windows::core::BSTR::from(value))
}

/// AND a candidate's property condition with `IsControlElement == true`,
/// emulating the Control view for `FindAll` (which has no view parameter).
unsafe fn control_view_condition(
    uia: &IUIAutomation,
    condition: &IUIAutomationCondition,
) -> Option<IUIAutomationCondition> {
    let control = uia
        .CreatePropertyCondition(
            UIA_IsControlElementPropertyId,
            &windows::Win32::System::Variant::VARIANT::from(true),
        )
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
            &bstr_variant(&props.automation_id),
        ) {
            m.automation_id = measure_pair(uia, scope, target, &cond);
        }
    }

    if !props.name.is_empty() {
        let type_cond = uia.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &windows::Win32::System::Variant::VARIANT::from(control_type_id),
        );
        let name_cond = uia.CreatePropertyCondition(UIA_NamePropertyId, &bstr_variant(&props.name));
        if let (Ok(type_cond), Ok(name_cond)) = (type_cond, name_cond) {
            if let Ok(cond) = uia.CreateAndCondition(&type_cond, &name_cond) {
                m.role_name = measure_pair(uia, scope, target, &cond);
            }
        }
    }

    if !props.class_name.is_empty() {
        if let Ok(cond) =
            uia.CreatePropertyCondition(UIA_ClassNamePropertyId, &bstr_variant(&props.class_name))
        {
            m.class_name = measure_pair(uia, scope, target, &cond);
        }
    }

    m
}

/// Get an i32 property from a UIA element via VARIANT.
unsafe fn get_i32_property(
    element: &IUIAutomationElement,
    property_id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> i32 {
    element
        .GetCurrentPropertyValue(property_id)
        .ok()
        .and_then(|v| {
            // Try to extract as i32 from the VARIANT.
            let val: Result<i32, _> = (&v).try_into();
            val.ok()
        })
        .unwrap_or(0)
}

/// Get a string property from a UIA element via VARIANT.
unsafe fn get_string_property(
    element: &IUIAutomationElement,
    property_id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> String {
    use windows::Win32::System::Variant::VT_BSTR;
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

/// Get a bool property from a UIA element via VARIANT.
unsafe fn get_bool_property(
    element: &IUIAutomationElement,
    property_id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> bool {
    element
        .GetCurrentPropertyValue(property_id)
        .ok()
        .and_then(|v| {
            let b: Result<bool, _> = (&v).try_into();
            b.ok()
        })
        .unwrap_or(false)
}

/// Resolve the top-level (GA_ROOT) window handle for a native window handle
/// reported by UIA. Returns 0 when unresolvable.
unsafe fn top_level_hwnd(native_hwnd: i32) -> i64 {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
    if native_hwnd == 0 {
        return 0;
    }
    let hwnd = HWND(native_hwnd as isize as *mut _);
    let root = GetAncestor(hwnd, GA_ROOT);
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
/// "from the window root".
unsafe fn build_tree_path_with_root(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> (Vec<String>, Option<usize>, Option<IUIAutomationElement>) {
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
                    if note_node(&parent) && root_pre_index.is_none() {
                        root_pre_index = Some(path.len() - 1);
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
        uia.ElementFromHandle(HWND(root_hwnd as isize as *mut _))
            .ok()
    } else {
        None
    };

    (path, window_root_offset, window_root)
}

// ---------------------------------------------------------------------------
// File dialog helpers (used by WindowsAccessibilityBackend)
// ---------------------------------------------------------------------------

/// Find a child Edit element by AutomationId and return its value.
pub(crate) unsafe fn find_child_value_by_automation_id(
    uia: &IUIAutomation,
    parent: &IUIAutomationElement,
    target_automation_id: &str,
) -> Option<String> {
    use windows::Win32::UI::Accessibility::{TreeScope_Descendants, UIA_EditControlTypeId};

    // Create a condition to find Edit controls.
    let edit_condition = uia
        .CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &windows::Win32::System::Variant::VARIANT::from(UIA_EditControlTypeId.0),
        )
        .ok()?;

    let all_edits = parent
        .FindAll(TreeScope_Descendants, &edit_condition)
        .ok()?;

    let count = all_edits.Length().ok()?;
    for i in 0..count {
        if let Ok(child) = all_edits.GetElement(i) {
            let auto_id = get_string_property(&child, UIA_AutomationIdPropertyId);
            if auto_id == target_automation_id {
                let value = get_string_property(&child, UIA_ValueValuePropertyId);
                if !value.is_empty() {
                    return Some(value);
                }
                // Fall back to the Name property.
                let name = get_string_property(&child, UIA_NamePropertyId);
                if !name.is_empty() {
                    return Some(name);
                }
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
    use windows::Win32::UI::Accessibility::TreeScope_Descendants;

    // Strategy 1: Look for the address bar edit with AutomationId "41477".
    if let Some(addr) = find_child_value_by_automation_id(uia, dialog_element, "41477") {
        if !addr.is_empty() {
            return Some(addr);
        }
    }

    // Strategy 2: Look for a ToolBar with AutomationId "1001" — the breadcrumb
    // bar. Its Name property often contains the current path.
    let toolbar_condition = uia
        .CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &windows::Win32::System::Variant::VARIANT::from(
                windows::Win32::UI::Accessibility::UIA_ToolBarControlTypeId.0,
            ),
        )
        .ok()?;

    let toolbars = dialog_element
        .FindAll(TreeScope_Descendants, &toolbar_condition)
        .ok()?;

    let count = toolbars.Length().ok()?;
    for i in 0..count {
        if let Ok(tb) = toolbars.GetElement(i) {
            let auto_id = get_string_property(&tb, UIA_AutomationIdPropertyId);
            if auto_id == "1001" {
                let name = get_string_property(&tb, UIA_NamePropertyId);
                if !name.is_empty() && name.contains('\\') {
                    return Some(name);
                }
            }
        }
    }

    None
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

    let owner = GetWindow(hwnd, GW_OWNER);
    if owner.is_ok_and(|h| h != HWND::default()) {
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
    let len = GetWindowTextW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

pub(crate) unsafe fn get_class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
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
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        match handle {
            Ok(h) => {
                let mut buf = [0u16; 512];
                let len = GetModuleFileNameExW(Some(h), None, &mut buf);
                let _ = windows::Win32::Foundation::CloseHandle(h);
                if len > 0 {
                    let full_path = String::from_utf16_lossy(&buf[..len as usize]);
                    full_path
                        .rsplit('\\')
                        .next()
                        .unwrap_or(&full_path)
                        .to_string()
                } else {
                    format!("pid:{pid}")
                }
            }
            Err(_) => format!("pid:{pid}"),
        }
    }
}

pub(crate) fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) unsafe fn get_modifier_state() -> (bool, bool, bool, bool) {
    let ctrl = GetAsyncKeyState(VK_CONTROL.0 as i32) < 0;
    let shift = GetAsyncKeyState(VK_SHIFT.0 as i32) < 0;
    let alt = GetAsyncKeyState(VK_MENU.0 as i32) < 0;
    let meta = GetAsyncKeyState(VK_LWIN.0 as i32) < 0 || GetAsyncKeyState(VK_RWIN.0 as i32) < 0;
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
}

// SAFETY: See doc comment on the struct. The IUIAutomation instance is created
// and used exclusively on the worker thread that owns this backend.
unsafe impl Send for WindowsAccessibilityBackend {}

impl WindowsAccessibilityBackend {
    /// Create a new backend with no COM initialisation.
    /// Call `init()` on the worker thread to set up COM and UIA.
    pub fn new() -> Self {
        Self { uia: None }
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
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| CaptureError::ComInit(e.to_string()))?;
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
                .map_err(|e| CaptureError::ComInit(format!("IUIAutomation: {e}")))?;
            self.uia = Some(uia);
        }
        Ok(())
    }

    fn cleanup(&mut self) {
        // Drop the COM interface before uninitialising COM.
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

    fn window_title(&self, window_handle: i64) -> String {
        let hwnd = HWND(window_handle as *mut _);
        unsafe { get_window_title(hwnd) }
    }

    fn process_name(&self, window_handle: i64) -> String {
        let hwnd = HWND(window_handle as *mut _);
        unsafe { get_process_name_for_hwnd(hwnd) }
    }

    fn read_file_dialog_path(&self, window_handle: i64) -> Option<(String, String)> {
        let uia = self.uia.as_ref()?;
        let hwnd = HWND(window_handle as *mut _);

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
            let dialog_element = uia.ElementFromHandle(hwnd).ok()?;

            // Read the filename from the "File name:" edit (AutomationId "1001").
            let filename = find_child_value_by_automation_id(uia, &dialog_element, "1001")?;
            if filename.is_empty() {
                return None;
            }

            // Try to read the current directory from the breadcrumb/address bar.
            let directory = read_file_dialog_directory(uia, &dialog_element);

            let file_path = match directory {
                Some(dir) if !dir.is_empty() => {
                    let dir = dir.trim_end_matches('\\');
                    format!("{dir}\\{filename}")
                }
                _ => filename,
            };

            Some((dialog_type.to_string(), file_path))
        }
    }

    fn root_window_handle(&self, window_handle: i64) -> i64 {
        use windows::Win32::UI::WindowsAndMessaging::GetAncestor;
        use windows::Win32::UI::WindowsAndMessaging::GA_ROOT;

        let hwnd = HWND(window_handle as *mut _);
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        if root.0.is_null() {
            window_handle
        } else {
            root.0 as i64
        }
    }

    fn window_rect(&self, window_handle: i64) -> Option<super::WindowRect> {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetWindowRect, GA_ROOT};

        let hwnd = HWND(window_handle as *mut _);
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        let target = if root.0.is_null() { hwnd } else { root };

        let mut rect = RECT::default();
        let ok = unsafe { GetWindowRect(target, &mut rect) };
        if ok.is_ok() {
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
        use windows::core::Interface;

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
        is_webview_process, windows_should_keep_event,
    };

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
    fn is_webview_process_matches_docent_binary_name() {
        // The self-capture filter treats any process whose exe name contains
        // "docent" (or "msedgewebview2") as part of Docent's own tree. The test
        // binary is `docent-desktop…`, so this exercises the positive match.
        assert!(is_webview_process(std::process::id()));
    }

    #[test]
    fn is_webview_process_false_for_unknown_pid() {
        // No exe name resolvable → not a WebView process.
        assert!(!is_webview_process(u32::MAX - 1));
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
        classify_left_release, down_dispatch_event_type, input_should_keep_event_cached, is_drag,
        scope_filter_decision, AtomicU32, LeftRelease, RawEventType, DRAG_THRESHOLD_PX, HWND,
        INPUT_INCLUDED_PID, INPUT_PID_CACHE, POINT, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEWHEEL,
        WM_RBUTTONDOWN,
    };
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    /// PIDs standing in for the processes these cases talk about.
    const TARGET_APP: u32 = 4242; // the application the user selected
    const OTHER_APP: u32 = 777; // some other running application
    const DOCENT: u32 = 1001; // Docent's own process (the excluded one)
    const DIALOG_HOST: u32 = 2002; // the process hosting a dialog Docent opened

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
    /// to no Docent-tree membership by name. The adjacent cases
    /// `get_process_exe_name_unknown_pid_is_none` and
    /// `is_webview_process_false_for_unknown_pid` pin those two answers.
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
            down_dispatch_event_type(WM_MBUTTONDOWN),
            Some(RawEventType::Click)
        ));
        assert!(matches!(
            down_dispatch_event_type(WM_RBUTTONDOWN),
            Some(RawEventType::RightClick)
        ));
    }

    #[test]
    fn the_down_dispatch_mapping_answers_for_its_own_two_messages() {
        // The left button's press records no action of its own (its release
        // does, above), and the wheel messages are their own arm — so neither
        // reaches this mapping.
        assert!(down_dispatch_event_type(WM_LBUTTONDOWN).is_none());
        assert!(down_dispatch_event_type(WM_MOUSEWHEEL).is_none());
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
            sequence_id: Some(1),
            payload: ActionPayload::Key {
                key: key.to_string(),
                modifiers: Modifiers {
                    ctrl: false,
                    shift: false,
                    alt: false,
                    meta: false,
                },
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
            let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
        }
        let own_tid = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
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
