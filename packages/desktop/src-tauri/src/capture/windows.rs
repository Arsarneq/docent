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

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationSelectionPattern,
    SetWinEventHook, UnhookWinEvent, UIA_AutomationIdPropertyId, UIA_ControlTypePropertyId,
    UIA_IsPasswordPropertyId, UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId,
    UIA_SelectionPatternId, UIA_ValueValuePropertyId, HWINEVENTHOOK,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, EnumWindows, GetClassNameW,
    GetForegroundWindow, GetMessageW, GetParent, GetWindow, GetWindowLongW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WindowFromPoint,
    CHILDID_SELF, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_FOCUS,
    EVENT_OBJECT_SELECTION, EVENT_OBJECT_VALUECHANGE, EVENT_SYSTEM_FOREGROUND, GWL_STYLE,
    GW_OWNER, HHOOK, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, MSG, OBJID_WINDOW, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDOWN, WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN, WS_CHILD,
};

use super::element_mapping::{control_type_name, map_element, UiaProperties};
use super::scroll::should_keep_event;
use super::timing;
use super::worker_pool::{AccessibilityBackend, RawEvent, RawEventType, WorkerPool, worker_loop};
use super::{
    ActionEvent, CaptureError, CaptureLayer, ElementDescription,
    PermissionStatus, WindowInfo,
};

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
    !super::scroll::should_keep_event(owner_pid, Some(excluded_pid)) && owner_pid != 0
}

const DRAG_THRESHOLD_PX: i32 = 5;

// ---------------------------------------------------------------------------
// Thread-local state for Input_Thread hook callbacks
// ---------------------------------------------------------------------------
//
// Windows hook callbacks are C-style `extern "system"` functions that cannot
// capture closures. We use thread-local statics to give the callbacks access
// to the dispatch channel, sequence counter, and other per-session state.

thread_local! {
    /// Channel sender for dispatching `RawEvent`s to the bridge thread.
    static INPUT_RAW_SENDER: std::cell::RefCell<Option<std::sync::mpsc::Sender<RawEvent>>> =
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

    /// Cache for PID exclusion check results. Maps PID → should_keep (true/false).
    /// Avoids repeated CreateToolhelp32Snapshot calls for the same PID.
    /// Cleared when capture starts (new session may have different excluded PID).
    static INPUT_PID_CACHE: std::cell::RefCell<std::collections::HashMap<u32, bool>> =
        std::cell::RefCell::new(std::collections::HashMap::new());

    /// IUIAutomation instance for pre-capturing click elements in the
    /// Input_Thread. Used ONLY for `ElementFromPoint` on mouse-up events
    /// with a short timeout. This ensures the element is captured while
    /// the target window is still alive (before the click is processed).
    static INPUT_UIA: std::cell::RefCell<Option<IUIAutomation>> =
        const { std::cell::RefCell::new(None) };

    /// Timestamp of the most recent low-level input event (mouse click or key press).
    /// Used to correlate WinEvent callbacks with user actions.
    static INPUT_LAST_INPUT_TIMESTAMP: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };

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
    /// The worker pool that manages accessibility worker threads.
    /// Owned by the bridge thread during capture; stored here only for shutdown.
    worker_pool: Option<WorkerPool>,
    /// Shared sequence counter — stored here so `max_sequence_id()` works
    /// even after the pool is moved to the bridge thread.
    sequence_counter: Option<Arc<AtomicU64>>,
    /// Bridge thread that receives `RawEvent`s from the input thread and
    /// calls `pool.dispatch()`. Owns the `WorkerPool` during capture.
    bridge_thread: Option<JoinHandle<WorkerPool>>,
    /// The Windows thread ID for the Input_Thread (used to post WM_QUIT).
    input_thread_id: Option<u32>,
    /// Join handle for the Input_Thread.
    input_thread: Option<JoinHandle<Result<(), CaptureError>>>,
}

impl WindowsCapture {
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
            excluded_pid: Arc::new(AtomicU32::new(0)),
            worker_pool: None,
            sequence_counter: None,
            bridge_thread: None,
            input_thread_id: None,
            input_thread: None,
        }
    }
}

impl Default for WindowsCapture {
    fn default() -> Self {
        Self::new()
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

        // --- Create WorkerPool with 3 workers ---
        let mut pool = WorkerPool::new(3, sender.clone(), {
            let excluded_pid = excluded_pid.clone();
            move |index, rx, queue_len, action_sender| {
                let excluded_pid = excluded_pid.clone();
                thread::spawn(move || {
                    let backend = WindowsAccessibilityBackend::new();
                    worker_loop(index, backend, rx, queue_len, action_sender, excluded_pid);
                })
            }
        });

        // Workers are ready once spawned — init happens inside worker_loop.

        // Store the sequence counter so max_sequence_id() works.
        let sequence_counter = Arc::clone(pool.sequence_counter());
        self.sequence_counter = Some(Arc::clone(&sequence_counter));

        // --- Create raw event channel (Input_Thread → bridge → pool.dispatch) ---
        let (raw_tx, raw_rx) = std::sync::mpsc::channel::<RawEvent>();

        // Spawn bridge thread: receives RawEvents and calls pool.dispatch().
        let bridge_handle = thread::spawn(move || {
            while let Ok(event) = raw_rx.recv() {
                pool.dispatch(event);
            }
            // Channel closed (input thread dropped raw_tx) — return pool for shutdown.
            pool
        });
        self.bridge_thread = Some(bridge_handle);

        // --- Spawn Input_Thread ---
        let active = self.active.clone();
        let excluded_pid_for_input = self.excluded_pid.clone();

        let (tid_tx, tid_rx) = std::sync::mpsc::channel::<u32>();

        let input_handle = thread::spawn(move || -> Result<(), CaptureError> {
            let thread_id = unsafe {
                windows::Win32::System::Threading::GetCurrentThreadId()
            };
            let _ = tid_tx.send(thread_id);
            input_thread_main(active, excluded_pid_for_input, sequence_counter, raw_tx)
        });

        match tid_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(tid) => self.input_thread_id = Some(tid),
            Err(_) => {
                self.active.store(false, Ordering::SeqCst);
                return Err(CaptureError::Platform(
                    "input thread did not report its thread ID".into(),
                ));
            }
        }

        self.input_thread = Some(input_handle);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), CaptureError> {
        if !self.active.load(Ordering::SeqCst) {
            return Ok(());
        }

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
        if let Some(handle) = self.input_thread.take() {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    return Err(CaptureError::Platform("input thread panicked".into()));
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

        self.sequence_counter = None;

        Ok(())
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

    fn max_sequence_id(&self) -> u64 {
        self.sequence_counter
            .as_ref()
            .map(|c| c.load(Ordering::SeqCst))
            .unwrap_or(0)
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
///
/// # Requirements
///
/// 1.1–1.5, 10.1–10.4
fn input_thread_main(
    active: Arc<AtomicBool>,
    excluded_pid: Arc<AtomicU32>,
    sequence_counter: Arc<AtomicU64>,
    raw_tx: std::sync::mpsc::Sender<RawEvent>,
) -> Result<(), CaptureError> {
    // --- COM initialisation (STA, needed for the message pump) ---
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| CaptureError::ComInit(e.to_string()))?;
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

    // Create a lightweight IUIAutomation instance for pre-capturing click
    // elements. This is used ONLY for ElementFromPoint on mouse-up events.
    let input_uia: Option<IUIAutomation> = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL).ok()
    };
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
            unsafe { let _ = UnhookWinEvent(*h); }
        }
        for h in &ll_hooks {
            unsafe { let _ = UnhookWindowsHookEx(*h); }
        }
        // Clean up thread-local state.
        INPUT_RAW_SENDER.with(|s| *s.borrow_mut() = None);
        INPUT_SEQUENCE_COUNTER.with(|c| *c.borrow_mut() = None);
        INPUT_ACTIVE.with(|a| *a.borrow_mut() = None);
        INPUT_EXCLUDED_PID.with(|p| *p.borrow_mut() = None);
        INPUT_PID_CACHE.with(|c| c.borrow_mut().clear());
        INPUT_UIA.with(|u| *u.borrow_mut() = None);
        INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(0));
        INPUT_LAST_KEYBOARD_TIMESTAMP.with(|t| t.set(0));
        return Err(e);
    }

    // --- Message pump ---
    unsafe {
        let mut msg = MSG::default();
        while active.load(Ordering::SeqCst) {
            let ret = GetMessageW(&mut msg, HWND::default(), 0, 0);
            if ret == BOOL(0) || ret == BOOL(-1) {
                break; // WM_QUIT or error
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    // --- Cleanup: unhook all hooks ---
    for h in &win_hooks {
        unsafe { let _ = UnhookWinEvent(*h); }
    }
    for h in &ll_hooks {
        unsafe { let _ = UnhookWindowsHookEx(*h); }
    }

    // --- Clean up thread-local state ---
    INPUT_RAW_SENDER.with(|s| *s.borrow_mut() = None);
    INPUT_SEQUENCE_COUNTER.with(|c| *c.borrow_mut() = None);
    INPUT_ACTIVE.with(|a| *a.borrow_mut() = None);
    INPUT_EXCLUDED_PID.with(|p| *p.borrow_mut() = None);
    INPUT_FOREGROUND_PID.with(|p| p.set(0));
    INPUT_LAST_FOREGROUND_HWND.with(|p| p.set(0));
    INPUT_MOUSE_DOWN_POS.with(|p| p.set(None));
    INPUT_OPENED_WINDOWS.with(|s| s.borrow_mut().clear());
    INPUT_PID_CACHE.with(|c| c.borrow_mut().clear());
    INPUT_UIA.with(|u| *u.borrow_mut() = None);
    INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(0));
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
            let _ = sender.send(event);
        }
    });
}

/// Pre-capture the element at the given screen coordinates using the
/// Input_Thread's IUIAutomation instance. Returns `Some(ElementDescription)`
/// if the query succeeds quickly, `None` if it fails or the UIA instance
/// is not available. This is called on mouse-up to capture the element
/// while the target window is guaranteed to still be alive.
unsafe fn input_pre_capture_element(x: i32, y: i32) -> Option<super::ElementDescription> {
    INPUT_UIA.with(|u| {
        let uia = u.borrow();
        let uia = uia.as_ref()?;
        let pt = POINT { x, y };
        let element = uia.ElementFromPoint(pt).ok()?;
        uia_element_to_description(uia, &element)
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
            if val == 0 { None } else { Some(val) }
        })
    })
}

/// Cached PID exclusion check. Uses a thread-local HashMap to avoid
/// repeated CreateToolhelp32Snapshot calls for the same PID.
/// The cache is populated on first check and reused for subsequent events.
/// This covers both the direct PID check AND the is_owned_by_excluded check.
fn input_should_keep_event_cached(event_pid: u32, excluded_pid: Option<u32>, hwnd: HWND) -> bool {
    // Fast path: PID 0 is always filtered, no exclusion means keep all.
    if event_pid == 0 {
        return false;
    }
    let Some(excl) = excluded_pid else {
        return true;
    };
    // Direct match — no cache needed.
    if event_pid == excl {
        return false;
    }
    // Check cache — keyed by (event_pid, hwnd) to cover ownership checks.
    // We use just event_pid as key since ownership is PID-based.
    INPUT_PID_CACHE.with(|cache| {
        let map = cache.borrow();
        if let Some(&result) = map.get(&event_pid) {
            return result;
        }
        drop(map);
        // Cache miss — do the expensive checks once.
        let keep = should_keep_event(event_pid, excluded_pid);
        if !keep {
            cache.borrow_mut().insert(event_pid, false);
            return false;
        }
        // Also check ownership (is_owned_by_excluded).
        let owned = unsafe { is_owned_by_excluded(hwnd, excl) };
        let result = !owned;
        cache.borrow_mut().insert(event_pid, result);
        result
    })
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
            let last_input = INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.get());
            if timestamp.saturating_sub(last_input) > timing::FOREGROUND_CORRELATION_MS {
                return; // Programmatic — suppress.
            }

            // Resolve root window for deduplication comparison.
            use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
            let root = GetAncestor(hwnd, GA_ROOT);
            let root_handle = if root.0.is_null() { window_handle } else { root.0 as i64 };

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
            && id_object == OBJID_WINDOW.0 && id_child == CHILDID_SELF as i32 => {
                if !IsWindow(hwnd).as_bool() {
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
                let last_input = INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.get());
                if timestamp.saturating_sub(last_input) > timing::WINDOW_LIFECYCLE_CORRELATION_MS {
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
            && id_object == OBJID_WINDOW.0 && id_child == CHILDID_SELF as i32 => {
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
                        let was_opened = INPUT_OPENED_WINDOWS.with(|s| s.borrow_mut().remove(&window_handle));
                        if !was_opened {
                            return; // Never opened — don't close.
                        }
                        // Only dispatch if correlated with recent user input.
                        let last_input = INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.get());
                        if timestamp.saturating_sub(last_input) > timing::WINDOW_LIFECYCLE_CORRELATION_MS {
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
            let last_input = INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.get());
            if timestamp.saturating_sub(last_input) > timing::FOCUS_CORRELATION_MS {
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
            if timestamp.saturating_sub(last_keyboard) > timing::VALUE_CHANGE_CORRELATION_MS {
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
                let vc_root_h = if vc_root.0.is_null() { hwnd.0 as i64 } else { vc_root.0 as i64 };
                let kb_root_h = if kb_root_resolved.0.is_null() { last_kb_window } else { kb_root_resolved.0 as i64 };
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
            // Suppress selection events that follow a mouse click.
            // The click already captures what was selected — the selection
            // event is redundant. We check both:
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
        let check_hwnd = if point_hwnd.0.is_null() { fg_hwnd } else { point_hwnd };
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
                    // Update last-input timestamp for correlation.
                    INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(timestamp));
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
                        let clicked_root_h = if clicked_root.0.is_null() { point_hwnd } else { clicked_root };
                        let fg_root_h = if fg_root.0.is_null() { fg_hwnd } else { fg_root };
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
                    let was_drag = INPUT_MOUSE_DOWN_POS.with(|p| {
                        let down = p.get();
                        down.is_some_and(|down_pt| {
                            let dx = (pt.x - down_pt.x).abs();
                            let dy = (pt.y - down_pt.y).abs();
                            dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX
                        })
                    });

                    if was_drag {
                        // Drag detected: dispatch DragStart + Drop pair.
                        let down_pt = INPUT_MOUSE_DOWN_POS.with(|p| p.get())
                            .unwrap_or(pt);
                        let source_coords = (down_pt.x, down_pt.y);

                        input_dispatch_raw_event(RawEvent {
                            event_type: RawEventType::DragStart {
                                source_coords,
                            },
                            sequence_id: 0,
                            timestamp,
                            screen_x: down_pt.x,
                            screen_y: down_pt.y,
                            window_handle,
                            process_id: pid,
                            key_code: 0,
                            modifiers: (false, false, false, false),
                            scroll_delta: 0.0,
                            callback_params: [0, 0, 0, 0],
                            pre_captured_element: None,
                        });

                        input_dispatch_raw_event(RawEvent {
                            event_type: RawEventType::Drop {
                                source_coords,
                            },
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
                WM_RBUTTONDOWN => {
                    // Update last-input timestamp for correlation.
                    INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(timestamp));
                    let pre_element = input_pre_capture_element(pt.x, pt.y);
                    input_dispatch_raw_event(RawEvent {
                        event_type: RawEventType::RightClick,
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
                WM_MOUSEWHEEL => {
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
                WM_MBUTTONDOWN => {
                    // Update last-input timestamp for correlation.
                    INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(timestamp));
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
                }
                _ => {}
            }
        } else if msg == WM_LBUTTONUP {
            // Excluded PID — clear drag state.
            INPUT_MOUSE_DOWN_POS.with(|p| p.set(None));
        }
    }

    CallNextHookEx(HHOOK::default(), n_code, w_param, l_param)
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

                // Update both timestamps for correlation.
                INPUT_LAST_INPUT_TIMESTAMP.with(|t| t.set(timestamp));
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

    CallNextHookEx(HHOOK::default(), n_code, w_param, l_param)
}

// ---------------------------------------------------------------------------
// UIA element resolution helpers (used by WindowsAccessibilityBackend)
// ---------------------------------------------------------------------------

/// Convert a UIA element to an `ElementDescription` using the element mapping
/// module. Requires a reference to the `IUIAutomation` instance for tree
/// walking (building the tree path).
pub(crate) unsafe fn uia_element_to_description(
    uia: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Option<ElementDescription> {
    let control_type_id = get_i32_property(element, UIA_ControlTypePropertyId);
    let automation_id = get_string_property(element, UIA_AutomationIdPropertyId);
    let name = get_string_property(element, UIA_NamePropertyId);
    let localized_type = get_string_property(element, UIA_LocalizedControlTypePropertyId);
    let value = get_string_property(element, UIA_ValueValuePropertyId);
    let is_password = get_bool_property(element, UIA_IsPasswordPropertyId);

    let props = UiaProperties {
        control_type_id,
        automation_id,
        name,
        localized_control_type: localized_type,
        is_password,
        value,
        tree_path: build_tree_path(uia, element),
    };

    Some(map_element(&props))
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
    element
        .GetCurrentPropertyValue(property_id)
        .ok()
        .and_then(|v| {
            let bstr: Result<windows::core::BSTR, _> = (&v).try_into();
            bstr.ok().map(|b| b.to_string())
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

/// Build the tree path for a UIA element by walking up the control view.
/// Requires a reference to the `IUIAutomation` instance for the tree walker.
unsafe fn build_tree_path(uia: &IUIAutomation, element: &IUIAutomationElement) -> Vec<String> {
    let mut path = Vec::new();

    let control_type_id = get_i32_property(element, UIA_ControlTypePropertyId);
    let name = get_string_property(element, UIA_NamePropertyId);
    let tag = control_type_name(control_type_id);

    let segment = if name.is_empty() {
        tag.to_string()
    } else {
        format!("{tag}:{name}")
    };
    path.push(segment);

    let walker = uia.ControlViewWalker().ok();

    if let Some(walker) = walker {
        let mut current = element.clone();
        for _ in 0..20 {
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
                    current = parent;
                }
                Err(_) => break,
            }
        }
    }

    path.reverse();
    path
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
    use windows::Win32::UI::Accessibility::{
        TreeScope_Descendants, UIA_EditControlTypeId,
    };

    // Create a condition to find Edit controls.
    let edit_condition = uia
        .CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &windows::core::VARIANT::from(UIA_EditControlTypeId.0),
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
            &windows::core::VARIANT::from(
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
        hwnd: hwnd.0 as i64,
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
                let len = GetModuleFileNameExW(h, None, &mut buf);
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
    let meta = GetAsyncKeyState(VK_LWIN.0 as i32) < 0
        || GetAsyncKeyState(VK_RWIN.0 as i32) < 0;
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
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
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
            let filename =
                find_child_value_by_automation_id(uia, &dialog_element, "1001")?;
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
            let pattern_obj = focused
                .GetCurrentPattern(UIA_SelectionPatternId)
                .ok()?;
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
