// Worker pool — platform-agnostic infrastructure for the capture worker pool.
//
// This module contains RawEvent, WorkerPool, dispatch logic, sequence
// numbering, the AccessibilityBackend trait, and the worker receive loop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use super::action_mapping::PASSWORD_MASK;
use super::coordinate;
use super::scroll::{RawScrollEvent, ScrollAccumulator};
use super::{
    ActionEvent, ActionPayload, CaptureError, CaptureMode, ElementDescription, Modifiers,
    WindowRect,
};

// ---------------------------------------------------------------------------
// RawEventType
// ---------------------------------------------------------------------------

/// Event types that the Input_Thread can produce.
///
/// Each variant corresponds to a category of user interaction captured by the
/// platform's input observation hooks. The Input_Thread classifies the raw OS
/// event into one of these variants before dispatching to a worker.
#[derive(Debug, Clone)]
pub enum RawEventType {
    Click,
    RightClick,
    MouseDown,
    MouseUp,
    DragStart { source_coords: (i32, i32) },
    Drop { source_coords: (i32, i32) },
    Focus,
    ValueChange,
    Selection,
    Keyboard,
    Foreground,
    WindowCreate,
    WindowDestroy,
    Scroll,
}

// ---------------------------------------------------------------------------
// RawEvent
// ---------------------------------------------------------------------------

/// Platform-agnostic raw event captured by the Input_Thread.
///
/// Carries all data needed for a worker to perform accessibility queries
/// without calling back to the Input_Thread. The Input_Thread populates
/// only the fields relevant to the event type; unused fields carry default
/// values (0 for integers, false for booleans).
#[derive(Debug, Clone)]
pub struct RawEvent {
    pub event_type: RawEventType,
    /// Monotonic sequence number assigned by the Input_Thread, starting at 1.
    pub sequence_id: u64,
    /// Unix milliseconds timestamp of the event.
    pub timestamp: u64,
    /// Screen-space X coordinate (mouse events).
    pub screen_x: i32,
    /// Screen-space Y coordinate (mouse events).
    pub screen_y: i32,
    /// Platform-opaque window identifier (HWND as i64 on Windows).
    pub window_handle: i64,
    /// Process ID of the event source.
    pub process_id: u32,
    /// Virtual key code (keyboard events).
    pub key_code: u32,
    /// Modifier key state: (ctrl, shift, alt, meta).
    pub modifiers: (bool, bool, bool, bool),
    /// Scroll delta value (scroll events).
    pub scroll_delta: f64,
    /// Platform-specific opaque callback parameters.
    ///
    /// On Windows: `[id_object, id_child, 0, 0]` from `SetWinEventHook`
    /// callbacks. Workers use these to determine which sub-element triggered
    /// the event. On other platforms: unused or platform-defined.
    pub callback_params: [i64; 4],
    /// Pre-captured element description from the Input_Thread.
    /// For mouse click/right-click events, the Input_Thread may perform a
    /// quick `ElementFromPoint` query before dispatching. If the query
    /// succeeds within the timeout, the result is attached here so the
    /// worker can use it directly — guaranteeing the element is captured
    /// while the window is still alive. If `None`, the worker performs
    /// its own query.
    pub pre_captured_element: Option<super::ElementDescription>,
}

// ---------------------------------------------------------------------------
// WorkerMessage
// ---------------------------------------------------------------------------

/// Messages sent from the Input_Thread to worker threads.
pub enum WorkerMessage {
    /// A raw event to process.
    Event(Box<RawEvent>),
    /// Poison pill — drain remaining events then exit.
    Shutdown,
}

// ---------------------------------------------------------------------------
// WorkerHandle
// ---------------------------------------------------------------------------

/// A handle to a single worker thread and its input queue.
pub struct WorkerHandle {
    /// Channel sender for dispatching messages to this worker.
    pub sender: mpsc::Sender<WorkerMessage>,
    /// Atomic counter tracking the number of pending items in this worker's queue.
    pub queue_len: Arc<AtomicU64>,
    /// Join handle for the worker's OS thread. `None` after the thread has been joined.
    pub thread: Option<JoinHandle<()>>,
}

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

/// Type alias for the boxed spawn closure stored by the pool.
///
/// The closure receives `(worker_index, receiver, queue_len, action_sender)`
/// and returns a `JoinHandle<()>` for the spawned worker thread.
type SpawnWorkerFn = Box<
    dyn Fn(
            usize,
            mpsc::Receiver<WorkerMessage>,
            Arc<AtomicU64>,
            mpsc::Sender<ActionEvent>,
        ) -> JoinHandle<()>
        + Send,
>;

/// Platform-agnostic worker pool for dispatching raw events to accessibility
/// worker threads.
///
/// The pool manages a fixed set of workers, assigns monotonic sequence numbers
/// to events, and routes events using shortest-queue dispatch with sticky
/// routing for value-change events and paired routing for drag events.
///
/// When a worker panics, the pool detects the failure on the next dispatch
/// attempt, immediately respawns a replacement worker at the same index, and
/// retries the event. Surviving workers continue processing events while the
/// replacement is being spawned, so no events are lost.
pub struct WorkerPool {
    workers: Vec<WorkerHandle>,
    sequence_counter: Arc<AtomicU64>,
    /// Sticky routing: maps `window_handle` → `worker_index` for value-change
    /// events, ensuring consecutive keystrokes for the same window are
    /// coalesced by a single worker.
    value_change_affinity: HashMap<i64, usize>,
    /// Tracks the worker index that received the most recent `DragStart`,
    /// so the corresponding `Drop` event is routed to the same worker.
    last_drag_worker: Option<usize>,
    /// Retained spawn closure for respawning dead workers.
    spawn_worker: SpawnWorkerFn,
    /// Retained action sender for respawning dead workers.
    action_sender: mpsc::Sender<ActionEvent>,
}

impl WorkerPool {
    /// Create a new pool with `count` workers.
    ///
    /// `action_sender` is the channel that workers use to send completed
    /// `ActionEvent`s back to the event bridge.
    ///
    /// `spawn_worker` is called for each worker index (0..count) and must
    /// return a `JoinHandle<()>`. It receives the worker index, the
    /// `mpsc::Receiver<WorkerMessage>` for that worker's queue, an
    /// `Arc<AtomicU64>` queue-length counter, and a clone of `action_sender`.
    pub fn new<F>(
        count: usize,
        action_sender: mpsc::Sender<ActionEvent>,
        spawn_worker: F,
    ) -> Self
    where
        F: Fn(
                usize,
                mpsc::Receiver<WorkerMessage>,
                Arc<AtomicU64>,
                mpsc::Sender<ActionEvent>,
            ) -> JoinHandle<()>
            + Send
            + 'static,
    {
        let mut workers = Vec::with_capacity(count);

        for index in 0..count {
            let (tx, rx) = mpsc::channel();
            let queue_len = Arc::new(AtomicU64::new(0));
            let handle = spawn_worker(
                index,
                rx,
                Arc::clone(&queue_len),
                action_sender.clone(),
            );
            workers.push(WorkerHandle {
                sender: tx,
                queue_len,
                thread: Some(handle),
            });
        }

        Self {
            workers,
            sequence_counter: Arc::new(AtomicU64::new(0)),
            value_change_affinity: HashMap::new(),
            last_drag_worker: None,
            spawn_worker: Box::new(spawn_worker),
            action_sender,
        }
    }

    /// Get the next sequence number (monotonically increasing, starts at 1).
    pub fn next_sequence_id(&self) -> u64 {
        self.sequence_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Get the current max sequence number assigned so far.
    /// Returns 0 if no events have been dispatched.
    pub fn max_sequence_id(&self) -> u64 {
        self.sequence_counter.load(Ordering::SeqCst)
    }

    /// Return a shared reference to the sequence counter `Arc`.
    /// Used by the Input_Thread to assign sequence numbers directly.
    pub fn sequence_counter(&self) -> &Arc<AtomicU64> {
        &self.sequence_counter
    }

    /// Dispatch a `RawEvent` to the appropriate worker.
    ///
    /// Routing rules:
    /// - `ValueChange` → sticky routing (same `window_handle` → same worker).
    /// - `DragStart`   → shortest-queue worker (index stored for the paired `Drop`).
    /// - `Drop`        → same worker as the most recent `DragStart`.
    /// - All others    → shortest-queue worker.
    ///
    /// If the selected worker has disconnected (panicked), it is marked dead
    /// and removed from future dispatch rotation. The event is retried on the
    /// next available worker. Sticky affinity entries pointing to the dead
    /// worker are cleared so subsequent events are re-routed.
    pub fn dispatch(&mut self, event: RawEvent) {
        let worker_index = self.select_worker(&event);
        self.send_to_worker(worker_index, event);
    }

    /// Select the target worker index for an event based on routing rules.
    fn select_worker(&mut self, event: &RawEvent) -> usize {
        match &event.event_type {
            // Sticky routing: consecutive events for the same window go to
            // the same worker. This ensures per-worker deduplication works
            // correctly (focus dedup, value-change dedup, selection dedup).
            RawEventType::ValueChange | RawEventType::Focus | RawEventType::Selection => {
                let handle = event.window_handle;
                if let Some(&idx) = self.value_change_affinity.get(&handle) {
                    return idx;
                }
                let idx = self.shortest_queue_worker();
                self.value_change_affinity.insert(handle, idx);
                idx
            }
            RawEventType::DragStart { .. } => {
                let idx = self.shortest_queue_worker();
                self.last_drag_worker = Some(idx);
                idx
            }
            RawEventType::Drop { .. } => {
                self.last_drag_worker
                    .unwrap_or_else(|| self.shortest_queue_worker())
            }
            _ => self.shortest_queue_worker(),
        }
    }

    /// Attempt to send an event to the given worker. If the worker is dead,
    /// respawn it in-place and retry the send on the fresh worker. Falls back
    /// to other live workers only if the respawned worker also fails
    /// immediately (which shouldn't happen in practice).
    fn send_to_worker(&mut self, first_choice: usize, event: RawEvent) {
        let worker_count = self.workers.len();
        let mut current_event = event;
        // Track indices where send failed AND respawn was attempted, to avoid
        // infinite loops if respawned workers also fail immediately.
        let mut respawned = std::collections::HashSet::new();
        let mut target = first_choice;

        loop {
            if respawned.len() >= worker_count {
                // Every slot has been respawned and still fails.
                eprintln!(
                    "[WorkerPool] Error: all workers unresponsive after respawn, \
                     dropping event (seq={})",
                    current_event.sequence_id
                );
                return;
            }

            if let Some(worker) = self.workers.get(target) {
                worker.queue_len.fetch_add(1, Ordering::SeqCst);
                match worker.sender.send(WorkerMessage::Event(Box::new(current_event))) {
                    Ok(()) => return, // Successfully dispatched.
                    Err(mpsc::SendError(WorkerMessage::Event(returned_event))) => {
                        // Worker is dead. Undo the queue_len bump.
                        worker.queue_len.fetch_sub(1, Ordering::SeqCst);
                        current_event = *returned_event;

                        if respawned.contains(&target) {
                            // Already respawned this index and it failed again.
                            // Try a different worker.
                            match self.pick_worker_excluding(&respawned) {
                                Some(idx) => {
                                    target = idx;
                                    continue;
                                }
                                None => {
                                    eprintln!(
                                        "[WorkerPool] Error: no live workers remaining, \
                                         dropping event (seq={})",
                                        current_event.sequence_id
                                    );
                                    return;
                                }
                            }
                        }

                        // Respawn the dead worker and retry on it.
                        self.respawn_worker(target);
                        respawned.insert(target);
                        // Loop back to retry send on the freshly respawned worker.
                    }
                    Err(_) => {
                        // Shutdown message bounced back — shouldn't happen here.
                        self.respawn_worker(target);
                        return;
                    }
                }
            } else {
                return;
            }
        }
    }

    /// Pick the worker with the shortest queue, excluding a set of indices.
    /// Returns `None` if all workers are excluded.
    fn pick_worker_excluding(&self, exclude: &std::collections::HashSet<usize>) -> Option<usize> {
        self.workers
            .iter()
            .enumerate()
            .filter(|(idx, _)| !exclude.contains(idx))
            .min_by_key(|(idx, w)| (w.queue_len.load(Ordering::SeqCst), *idx))
            .map(|(idx, _)| idx)
    }

    /// Respawn a dead worker at the given index.
    ///
    /// Joins the old thread (if any), creates a fresh channel and queue
    /// counter, calls the stored spawn closure, and swaps the new handle
    /// into the workers vec. The respawned worker participates in dispatch
    /// immediately.
    fn respawn_worker(&mut self, index: usize) {
        // Join the old thread to clean up resources.
        if let Some(worker) = self.workers.get_mut(index) {
            if let Some(handle) = worker.thread.take() {
                let _ = handle.join(); // Ignore panic payload.
            }
        }

        // Create fresh channel and queue counter.
        let (tx, rx) = mpsc::channel();
        let queue_len = Arc::new(AtomicU64::new(0));
        let thread = (self.spawn_worker)(
            index,
            rx,
            Arc::clone(&queue_len),
            self.action_sender.clone(),
        );

        eprintln!("[WorkerPool] Respawned worker {index}");

        self.workers[index] = WorkerHandle {
            sender: tx,
            queue_len,
            thread: Some(thread),
        };

        // Clear sticky affinity entries that pointed to the dead worker.
        self.value_change_affinity.retain(|_, &mut v| v != index);

        // Clear drag worker if it was the dead one.
        if self.last_drag_worker == Some(index) {
            self.last_drag_worker = None;
        }
    }

    /// Signal all workers to shut down and wait for their threads to finish.
    ///
    /// Sends `WorkerMessage::Shutdown` to each worker, then joins every
    /// thread handle.
    pub fn shutdown(&mut self) {
        // Send shutdown signal to all workers.
        for (i, worker) in self.workers.iter().enumerate() {
            if worker.sender.send(WorkerMessage::Shutdown).is_err() {
                eprintln!(
                    "[WorkerPool] Warning: worker {i} already disconnected during shutdown"
                );
            }
        }

        // Join all worker threads.
        for (i, worker) in self.workers.iter_mut().enumerate() {
            if let Some(handle) = worker.thread.take() {
                if let Err(e) = handle.join() {
                    eprintln!("[WorkerPool] Warning: worker {i} panicked: {e:?}");
                }
            }
        }
    }

    /// Find the worker with the shortest queue.
    /// Ties are broken by lowest index.
    fn shortest_queue_worker(&self) -> usize {
        self.workers
            .iter()
            .enumerate()
            .min_by_key(|(idx, w)| (w.queue_len.load(Ordering::SeqCst), *idx))
            .map(|(idx, _)| idx)
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// AccessibilityBackend trait
// ---------------------------------------------------------------------------

/// Trait that platform-specific code implements for worker initialization
/// and accessibility queries.
///
/// Each platform (Windows, macOS, Linux) provides a concrete type that
/// implements this trait. The platform-agnostic `worker_loop` calls these
/// methods to perform accessibility queries without knowing which platform
/// it is running on.
///
/// The `Send + 'static` bounds allow the backend to be moved into a worker
/// thread at spawn time.
pub trait AccessibilityBackend: Send + 'static {
    /// Initialize the accessibility API session for this worker thread.
    /// Called once when the worker thread starts.
    fn init(&mut self) -> Result<(), CaptureError>;

    /// Clean up the accessibility API session.
    /// Called when the worker thread shuts down.
    fn cleanup(&mut self);

    /// Query the element at the given screen coordinates.
    fn element_at_point(&self, x: i32, y: i32) -> Option<ElementDescription>;

    /// Query the currently focused element.
    fn focused_element(&self) -> Option<ElementDescription>;

    /// Get the window title for a window handle.
    fn window_title(&self, window_handle: i64) -> String;

    /// Get the process name for a window handle.
    fn process_name(&self, window_handle: i64) -> String;

    /// Read a file dialog path from the given window (if it is a file dialog).
    /// Returns `(dialog_type, file_path)` or `None` if the window is not a
    /// file dialog or no path could be read.
    fn read_file_dialog_path(&self, window_handle: i64) -> Option<(String, String)>;

    /// Resolve a window handle to its top-level root window handle.
    ///
    /// Used to produce consistent `context_id` values — child controls
    /// within the same application window should share the same context_id.
    /// On Windows this calls `GetAncestor(hwnd, GA_ROOT)`.
    fn root_window_handle(&self, window_handle: i64) -> i64;

    /// Get the window rectangle (position and size) for a window handle.
    ///
    /// Resolves to the root window via `GetAncestor(GA_ROOT)` and returns
    /// the bounding rectangle. Returns `None` if the call fails or the
    /// handle is invalid.
    fn window_rect(&self, window_handle: i64) -> Option<WindowRect>;

    /// Attempt to get the selected item's description and name from a
    /// container element (List, ComboBox, Tree, DataGrid) using the
    /// `IUIAutomationSelectionPattern`.
    ///
    /// Returns `Some((element_description, selected_item_name))` if a
    /// selection could be resolved, or `None` if the pattern is not
    /// supported or no item is selected.
    fn selected_item_name(&self, window_handle: i64) -> Option<(ElementDescription, String)>;
}

// ---------------------------------------------------------------------------
// PendingTypeEvent
// ---------------------------------------------------------------------------

/// Buffered type event for coalescing rapid value-change events into a single
/// `type` ActionEvent.
///
/// When the user types into a text field, each keystroke produces a
/// `ValueChange` event. Rather than emitting one `type` ActionEvent per
/// keystroke, the worker buffers them and emits a single event after a 500ms
/// debounce interval with no new value changes.
#[derive(Debug, Clone)]
pub struct PendingTypeEvent {
    /// The element being typed into.
    pub element: ElementDescription,
    /// The current (latest) value of the element.
    pub value: String,
    /// Whether the element is a password field.
    pub is_password: bool,
    /// Timestamp of the first value-change in this sequence.
    pub timestamp: u64,
    /// Resolved context_id for the event.
    pub context_id: Option<i64>,
    /// Resolved window_rect for the event.
    pub window_rect: Option<WindowRect>,
    /// Sequence_id from the most recent value-change RawEvent.
    pub sequence_id: u64,
    /// Timestamp of the last value-change update (used for debounce).
    pub last_update: u64,
}

/// Debounce interval for type event coalescing (imported from timing.rs).
use super::timing::{TYPE_DEBOUNCE_MS, WORKER_RECV_TIMEOUT as RECV_TIMEOUT};

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

/// Get the current Unix millisecond timestamp.
fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// Key name mapping (platform-agnostic)
// ---------------------------------------------------------------------------

/// Map a virtual key code to a human-readable key name.
///
/// Returns an empty string for modifier-only keys (Shift, Control, Alt, Meta
/// and their left/right variants), signalling the caller to skip the event.
fn vk_to_key_name(vk: u32) -> String {
    match vk {
        0x08 => "Backspace".to_string(),
        0x09 => "Tab".to_string(),
        0x0D => "Enter".to_string(),
        0x10 => "Shift".to_string(),
        0x11 => "Control".to_string(),
        0x12 => "Alt".to_string(),
        0x13 => "Pause".to_string(),
        0x14 => "CapsLock".to_string(),
        0x1B => "Escape".to_string(),
        0x20 => "Space".to_string(),
        0x21 => "PageUp".to_string(),
        0x22 => "PageDown".to_string(),
        0x23 => "End".to_string(),
        0x24 => "Home".to_string(),
        0x25 => "ArrowLeft".to_string(),
        0x26 => "ArrowUp".to_string(),
        0x27 => "ArrowRight".to_string(),
        0x28 => "ArrowDown".to_string(),
        0x2C => "PrintScreen".to_string(),
        0x2D => "Insert".to_string(),
        0x2E => "Delete".to_string(),
        0x30..=0x39 => char::from(vk as u8).to_string(),
        0x41..=0x5A => char::from(vk as u8).to_string(),
        0x5B | 0x5C => "Meta".to_string(),
        0x60..=0x69 => format!("Numpad{}", vk - 0x60),
        0x6A => "Multiply".to_string(),
        0x6B => "Add".to_string(),
        0x6D => "Subtract".to_string(),
        0x6E => "Decimal".to_string(),
        0x6F => "Divide".to_string(),
        0x70..=0x87 => format!("F{}", vk - 0x6F),
        0x90 => "NumLock".to_string(),
        0x91 => "ScrollLock".to_string(),
        // Left/right modifier VK codes → empty string (skip).
        0xA0 | 0xA1 => String::new(), // VK_LSHIFT, VK_RSHIFT
        0xA2 | 0xA3 => String::new(), // VK_LCONTROL, VK_RCONTROL
        0xA4 | 0xA5 => String::new(), // VK_LMENU (LAlt), VK_RMENU (RAlt)
        0xBA => ";".to_string(),
        0xBB => "=".to_string(),
        0xBC => ",".to_string(),
        0xBD => "-".to_string(),
        0xBE => ".".to_string(),
        0xBF => "/".to_string(),
        0xC0 => "`".to_string(),
        0xDB => "[".to_string(),
        0xDC => "\\".to_string(),
        0xDD => "]".to_string(),
        0xDE => "'".to_string(),
        _ => format!("VK_{vk:#04X}"),
    }
}

/// Determine whether a key event should be emitted.
///
/// Returns `true` for control keys and modifier combos. Returns `false` for
/// plain printable characters (single-char keys with no Ctrl/Alt/Meta held),
/// which are redundant with the coalesced `type` event from value-change.
fn should_keep_key_event(key: &str, modifiers: &(bool, bool, bool, bool)) -> bool {
    // Skip modifier-only keys (empty key name).
    if key.is_empty() {
        return false;
    }
    // A key is "printable" if it's a single character with no Ctrl/Alt/Meta.
    let is_printable_char = key.len() == 1 && !modifiers.0 && !modifiers.2 && !modifiers.3;
    !is_printable_char
}

// ---------------------------------------------------------------------------
// worker_loop
// ---------------------------------------------------------------------------

/// The main receive loop for each worker thread.
///
/// Platform-agnostic — calls into the [`AccessibilityBackend`] trait for
/// platform-specific queries. Each worker maintains its own scroll
/// accumulator, type coalescing buffer, and deduplication state.
///
/// # Lifecycle
///
/// 1. Calls `backend.init()` on entry.
/// 2. Enters a receive loop using `recv_timeout(50ms)` for periodic flush.
/// 3. On `Shutdown`: drains remaining events, flushes pending type and scroll.
/// 4. Calls `backend.cleanup()` on exit.
///
/// # Requirements
///
/// - 5.1–5.13: Worker event processing
/// - 9.1, 9.3–9.6: Type coalescing
/// - 12.2–12.8: Existing behavior preservation
/// - 13.4: Worker failure handling (coordinate fallback)
/// - 14.5: Platform-agnostic coalescing/dedup
pub fn worker_loop<B: AccessibilityBackend>(
    worker_index: usize,
    mut backend: B,
    receiver: mpsc::Receiver<WorkerMessage>,
    queue_len: Arc<AtomicU64>,
    action_sender: mpsc::Sender<ActionEvent>,
    excluded_pid: Arc<AtomicU32>,
) {
    if let Err(e) = backend.init() {
        eprintln!("[Worker {worker_index}] init failed: {e}");
        return;
    }

    let mut scroll_acc = ScrollAccumulator::new();
    let mut pending_type: Option<PendingTypeEvent> = None;
    let mut last_focus_selector = String::new();
    let mut last_value_map: HashMap<String, String> = HashMap::new();
    // Track the last DragStart element so we can attach it to the Drop event.
    let mut last_drag_element: Option<ElementDescription> = None;

    loop {
        match receiver.recv_timeout(RECV_TIMEOUT) {
            Ok(WorkerMessage::Event(raw)) => {
                queue_len.fetch_sub(1, Ordering::SeqCst);

                // Catch panics in event processing so a single bad event
                // doesn't kill the worker thread. The event is dropped (it
                // would just panic again if retried on another worker), but
                // the worker stays alive for subsequent events.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_raw_event(
                        worker_index,
                        &raw,
                        &backend,
                        &action_sender,
                        &excluded_pid,
                        &mut scroll_acc,
                        &mut pending_type,
                        &mut last_focus_selector,
                        &mut last_value_map,
                        &mut last_drag_element,
                    );
                }));
                if let Err(panic_info) = result {
                    let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = panic_info.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_string()
                    };
                    eprintln!(
                        "[Worker {worker_index}] panic processing event (seq={}): {msg}",
                        raw.sequence_id
                    );
                }
            }
            Ok(WorkerMessage::Shutdown) => {
                // Drain remaining events in the queue.
                while let Ok(WorkerMessage::Event(raw)) = receiver.try_recv() {
                    queue_len.fetch_sub(1, Ordering::SeqCst);
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        process_raw_event(
                            worker_index,
                            &raw,
                            &backend,
                            &action_sender,
                            &excluded_pid,
                            &mut scroll_acc,
                            &mut pending_type,
                            &mut last_focus_selector,
                            &mut last_value_map,
                            &mut last_drag_element,
                        );
                    }));
                }
                // Flush pending type event.
                flush_pending_type(&mut pending_type, &action_sender);
                // Flush scroll accumulator with a far-future timestamp.
                if let Some(result) = scroll_acc.try_flush(u64::MAX) {
                    // We don't have a specific raw event for this flush, so
                    // emit with current timestamp and no context_id.
                    let _ = action_sender.send(ActionEvent {
                        timestamp: current_timestamp_ms(),
                        context_id: None,
                        capture_mode: CaptureMode::Accessibility,
                        frame_src: None,
                        window_rect: None,
                        sequence_id: None,
                        payload: ActionPayload::Scroll {
                            element: None,
                            scroll_top: 0.0,
                            scroll_left: 0.0,
                            delta_y: result.total_delta_y,
                            delta_x: result.total_delta_x,
                        },
                    });
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Periodic flush for scroll debounce and type debounce.
                let now = current_timestamp_ms();
                if let Some(result) = scroll_acc.try_flush(now) {
                    let _ = action_sender.send(ActionEvent {
                        timestamp: now,
                        context_id: None,
                        capture_mode: CaptureMode::Accessibility,
                        frame_src: None,
                        window_rect: None,
                        sequence_id: None,
                        payload: ActionPayload::Scroll {
                            element: None,
                            scroll_top: 0.0,
                            scroll_left: 0.0,
                            delta_y: result.total_delta_y,
                            delta_x: result.total_delta_x,
                        },
                    });
                }
                try_flush_type_debounce(&mut pending_type, now, &action_sender);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Channel closed — flush and exit.
                flush_pending_type(&mut pending_type, &action_sender);
                break;
            }
        }
    }

    backend.cleanup();
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

/// Process a single raw event, performing accessibility queries and emitting
/// the appropriate `ActionEvent`.
#[allow(clippy::too_many_arguments)]
fn process_raw_event<B: AccessibilityBackend>(
    _worker_index: usize,
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    excluded_pid: &Arc<AtomicU32>,
    scroll_acc: &mut ScrollAccumulator,
    pending_type: &mut Option<PendingTypeEvent>,
    last_focus_selector: &mut String,
    last_value_map: &mut HashMap<String, String>,
    last_drag_element: &mut Option<ElementDescription>,
) {
    // PID exclusion check — discard events from the excluded process.
    let excl = excluded_pid.load(Ordering::SeqCst);
    if excl != 0 && raw.process_id == excl {
        return;
    }

    // Resolve context_id from the root window handle.
    let context_id = if raw.window_handle != 0 {
        let root = backend.root_window_handle(raw.window_handle);
        if root != 0 { Some(root) } else { Some(raw.window_handle) }
    } else {
        None
    };

    // Resolve window_rect from the window handle.
    let window_rect = if raw.window_handle != 0 {
        backend.window_rect(raw.window_handle)
    } else {
        None
    };

    match &raw.event_type {
        RawEventType::Click => {
            handle_click(
                raw, backend, action_sender, context_id, false, window_rect.clone(),
            );
        }
        RawEventType::RightClick => {
            handle_click(
                raw, backend, action_sender, context_id, true, window_rect.clone(),
            );
        }
        RawEventType::Focus => {
            handle_focus(
                raw, backend, action_sender, context_id, last_focus_selector, window_rect.clone(),
            );
        }
        RawEventType::ValueChange => {
            handle_value_change(
                raw,
                backend,
                action_sender,
                context_id,
                pending_type,
                last_value_map,
                window_rect.clone(),
            );
        }
        RawEventType::Selection => {
            handle_selection(raw, backend, action_sender, context_id, window_rect.clone());
        }
        RawEventType::Keyboard => {
            handle_keyboard(
                raw, backend, action_sender, context_id, pending_type, window_rect.clone(),
            );
        }
        RawEventType::Foreground => {
            // Flush pending type before context switch.
            flush_pending_type(pending_type, action_sender);
            handle_foreground(raw, backend, action_sender, context_id, window_rect.clone());
        }
        RawEventType::WindowCreate => {
            let _ = action_sender.send(ActionEvent {
                timestamp: raw.timestamp,
                context_id,
                capture_mode: CaptureMode::Accessibility,
                frame_src: None,
                window_rect: window_rect.clone(),
                sequence_id: Some(raw.sequence_id),
                payload: ActionPayload::ContextOpen {
                    opener_context_id: context_id,
                    source: None,
                },
            });
        }
        RawEventType::WindowDestroy => {
            let _ = action_sender.send(ActionEvent {
                timestamp: raw.timestamp,
                context_id,
                capture_mode: CaptureMode::Accessibility,
                frame_src: None,
                window_rect: window_rect.clone(),
                sequence_id: Some(raw.sequence_id),
                payload: ActionPayload::ContextClose {
                    window_closing: true,
                },
            });
        }
        RawEventType::Scroll => {
            let is_horizontal = raw.callback_params[0] == 1;
            scroll_acc.push(RawScrollEvent {
                timestamp: raw.timestamp,
                delta_x: if is_horizontal { raw.scroll_delta } else { 0.0 },
                delta_y: if is_horizontal { 0.0 } else { raw.scroll_delta },
            });
            // Check if debounce has elapsed (will be checked on timeout too).
            let now = current_timestamp_ms();
            if let Some(result) = scroll_acc.try_flush(now) {
                let _ = action_sender.send(ActionEvent {
                    timestamp: raw.timestamp,
                    context_id,
                    capture_mode: CaptureMode::Accessibility,
                    frame_src: None,
                    window_rect: window_rect.clone(),
                    sequence_id: Some(raw.sequence_id),
                    payload: ActionPayload::Scroll {
                        element: None,
                        scroll_top: 0.0,
                        scroll_left: 0.0,
                        delta_y: result.total_delta_y,
                        delta_x: result.total_delta_x,
                    },
                });
            }
        }
        RawEventType::DragStart { source_coords: _ } => {
            handle_drag_start(raw, backend, action_sender, context_id, last_drag_element, window_rect.clone());
        }
        RawEventType::Drop { source_coords: _ } => {
            handle_drop(raw, backend, action_sender, context_id, last_drag_element, window_rect.clone());
        }
        RawEventType::MouseDown | RawEventType::MouseUp => {
            // MouseDown/MouseUp are handled by the Input_Thread for drag
            // detection. Workers should not receive them directly — ignore.
        }
    }
}

// ---------------------------------------------------------------------------
// Click handling
// ---------------------------------------------------------------------------

fn handle_click<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    is_right_click: bool,
    window_rect: Option<WindowRect>,
) {
    // Priority chain for element resolution:
    // 1. Pre-captured element from Input_Thread (window guaranteed alive)
    // 2. Worker's own ElementFromPoint query
    // 3. Option D: if the window closed between capture and query,
    //    use the window title from the original HWND
    let (capture_mode, element_desc) = if let Some(ref pre) = raw.pre_captured_element {
        // Input_Thread already captured the element — use it directly.
        let mode = if pre.tag == "Window" || pre.tag == "Pane" {
            CaptureMode::Coordinate
        } else {
            CaptureMode::Accessibility
        };
        (mode, pre.clone())
    } else {
        // No pre-captured element — query from the worker.
        let element = backend.element_at_point(raw.screen_x, raw.screen_y);
        match element {
            Some(el) => {
                let mode = if el.tag == "Window" || el.tag == "Pane" {
                    CaptureMode::Coordinate
                } else {
                    CaptureMode::Accessibility
                };
                (mode, el)
            }
            None => {
                // Query failed — window may have closed. Use the window
                // title from the original HWND as a fallback description.
                let title = backend.window_title(raw.window_handle);
                let el = coordinate::fallback_element(&title, raw.screen_x, raw.screen_y);
                (CaptureMode::Coordinate, el)
            }
        }
    };

    let (rel_x, rel_y) = (raw.screen_x as f64, raw.screen_y as f64);

    let payload = if is_right_click {
        ActionPayload::RightClick {
            x: rel_x,
            y: rel_y,
            element: element_desc.clone(),
        }
    } else {
        ActionPayload::Click {
            x: rel_x,
            y: rel_y,
            element: element_desc.clone(),
        }
    };

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode,
        frame_src: None,
        window_rect: window_rect.clone(),
        sequence_id: Some(raw.sequence_id),
        payload,
    });

    // Selection detection: if the clicked element is a list item (or similar
    // selectable item), also emit a select event. This handles cases where
    // EVENT_OBJECT_SELECTION doesn't fire (e.g. LISTBOX without message pump).
    if !is_right_click {
        let is_list_item = matches!(
            element_desc.tag.as_str(),
            "ListItem" | "TreeItem" | "DataItem" | "TabItem"
        );
        // Also check role for Win32 controls that might report differently.
        let role_is_item = element_desc.role.as_deref().is_some_and(|r| {
            matches!(r, "listitem" | "treeitem" | "option" | "tab")
        });
        if is_list_item || role_is_item {
            let value = element_desc.name.clone().unwrap_or_default();
            let _ = action_sender.send(ActionEvent {
                timestamp: raw.timestamp,
                context_id,
                capture_mode: CaptureMode::Accessibility,
                frame_src: None,
                window_rect: window_rect.clone(),
                sequence_id: Some(raw.sequence_id),
                payload: ActionPayload::Select {
                    element: element_desc.clone(),
                    value,
                },
            });
        }
    }

    // File dialog detection: if the clicked element is a button named
    // "Save" or "Open", check if the window is a file dialog.
    if !is_right_click {
        if let Some(ref name) = element_desc.name {
            let name_lower = name.to_lowercase();
            if (name_lower == "save" || name_lower == "open")
                && element_desc.tag == "Button"
            {
                if let Some((dialog_type, file_path)) =
                    backend.read_file_dialog_path(raw.window_handle)
                {
                    let source = backend.process_name(raw.window_handle);
                    let _ = action_sender.send(ActionEvent {
                        timestamp: raw.timestamp,
                        context_id,
                        capture_mode: CaptureMode::Accessibility,
                        frame_src: None,
                        window_rect,
                        sequence_id: Some(raw.sequence_id),
                        payload: ActionPayload::FileDialog {
                            dialog_type,
                            file_path,
                            source,
                        },
                    });
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Focus handling
// ---------------------------------------------------------------------------

fn handle_focus<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    last_focus_selector: &mut String,
    window_rect: Option<WindowRect>,
) {
    let element = match backend.focused_element() {
        Some(el) => el,
        None => return, // Can't resolve focused element — skip.
    };

    // Focus deduplication: skip if same selector as last focus event.
    if element.selector == *last_focus_selector {
        return;
    }
    *last_focus_selector = element.selector.clone();

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::Focus {
            element,
        },
    });
}

// ---------------------------------------------------------------------------
// Value-change handling (type coalescing)
// ---------------------------------------------------------------------------

fn handle_value_change<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    pending_type: &mut Option<PendingTypeEvent>,
    last_value_map: &mut HashMap<String, String>,
    window_rect: Option<WindowRect>,
) {
    let element = match backend.focused_element() {
        Some(el) => el,
        None => return,
    };

    let is_password = element.element_type.as_deref() == Some("password");
    let value = if is_password {
        PASSWORD_MASK.to_string()
    } else {
        element.text.clone().unwrap_or_default()
    };

    // Value-change deduplication: skip if value unchanged for this element.
    if let Some(last_val) = last_value_map.get(&element.selector) {
        if *last_val == value {
            return;
        }
    }
    last_value_map.insert(element.selector.clone(), value.clone());

    // Check if we have a pending type event for a different element — flush it.
    if let Some(ref pt) = pending_type {
        if pt.element.selector != element.selector {
            flush_pending_type(pending_type, action_sender);
        }
    }

    // Buffer or update the pending type event.
    match pending_type {
        Some(ref mut pt) if pt.element.selector == element.selector => {
            // Same element — update value and reset debounce timer.
            pt.value = value;
            pt.sequence_id = raw.sequence_id;
            pt.last_update = raw.timestamp;
        }
        _ => {
            // New element or no pending event.
            *pending_type = Some(PendingTypeEvent {
                element,
                value,
                is_password,
                timestamp: raw.timestamp,
                context_id,
                window_rect,
                sequence_id: raw.sequence_id,
                last_update: raw.timestamp,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Selection handling
// ---------------------------------------------------------------------------

fn handle_selection<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    window_rect: Option<WindowRect>,
) {
    let element = backend.focused_element();

    // Try to resolve the selected item via SelectionPattern first.
    // This works regardless of whether focused_element succeeded.
    let (final_element, value) = if let Some(ref el) = element {
        // Check if the focused element is a container type (List, ComboBox, Tree, DataGrid).
        let is_container = matches!(
            el.tag.as_str(),
            "List" | "ComboBox" | "Tree" | "DataGrid"
        );

        if is_container {
            // Try to get the selected item from the container.
            match backend.selected_item_name(raw.window_handle) {
                Some((selected_el, selected_name)) => (selected_el, selected_name),
                None => {
                    // Fall back to the focused element's Name property as the value.
                    let value = el.name.clone().unwrap_or_default();
                    (el.clone(), value)
                }
            }
        } else {
            let value = el.text.clone().unwrap_or_default();
            (el.clone(), value)
        }
    } else {
        // focused_element() returned None. Still try selected_item_name.
        match backend.selected_item_name(raw.window_handle) {
            Some((selected_el, selected_name)) => (selected_el, selected_name),
            None => {
                // Emit a minimal select event with a fallback element.
                let title = backend.window_title(raw.window_handle);
                let fallback = super::ElementDescription {
                    tag: "ListItem".to_string(),
                    id: None,
                    selector: String::new(),
                    name: if title.is_empty() { None } else { Some(title.clone()) },
                    role: Some("listitem".to_string()),
                    element_type: None,
                    text: None,
                };
                (fallback, String::new())
            }
        }
    };

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::Select {
            element: final_element,
            value,
        },
    });
}

// ---------------------------------------------------------------------------
// Keyboard handling
// ---------------------------------------------------------------------------

fn handle_keyboard<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    pending_type: &mut Option<PendingTypeEvent>,
    window_rect: Option<WindowRect>,
) {
    let key = vk_to_key_name(raw.key_code);

    // Apply key filtering: skip modifier-only and plain printable chars.
    if !should_keep_key_event(&key, &raw.modifiers) {
        return;
    }

    // Flush pending type before emitting a control key (e.g. user types
    // "hello" then presses Enter).
    flush_pending_type(pending_type, action_sender);

    let element = backend.focused_element().unwrap_or_else(|| {
        let title = backend.window_title(raw.window_handle);
        ElementDescription {
            tag: "Unknown".to_string(),
            id: None,
            name: Some(title),
            role: None,
            element_type: None,
            text: None,
            selector: String::new(),
        }
    });

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::Key {
            key,
            modifiers: Modifiers {
                ctrl: raw.modifiers.0,
                shift: raw.modifiers.1,
                alt: raw.modifiers.2,
                meta: raw.modifiers.3,
            },
            element,
        },
    });
}

// ---------------------------------------------------------------------------
// Foreground handling
// ---------------------------------------------------------------------------

fn handle_foreground<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    window_rect: Option<WindowRect>,
) {
    let title = backend.window_title(raw.window_handle);
    let source = backend.process_name(raw.window_handle);

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::ContextSwitch {
            source,
            title: if title.is_empty() { None } else { Some(title) },
        },
    });
}

// ---------------------------------------------------------------------------
// Drag handling
// ---------------------------------------------------------------------------

fn handle_drag_start<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    last_drag_element: &mut Option<ElementDescription>,
    window_rect: Option<WindowRect>,
) {
    let element = backend
        .element_at_point(raw.screen_x, raw.screen_y)
        .unwrap_or_else(|| {
            let title = backend.window_title(raw.window_handle);
            coordinate::fallback_element(&title, raw.screen_x, raw.screen_y)
        });

    *last_drag_element = Some(element.clone());

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::DragStart { element },
    });
}

fn handle_drop<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    last_drag_element: &mut Option<ElementDescription>,
    window_rect: Option<WindowRect>,
) {
    let element = backend
        .element_at_point(raw.screen_x, raw.screen_y)
        .unwrap_or_else(|| {
            let title = backend.window_title(raw.window_handle);
            coordinate::fallback_element(&title, raw.screen_x, raw.screen_y)
        });

    let source_element = last_drag_element.take();

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::Drop {
            x: raw.screen_x as f64,
            y: raw.screen_y as f64,
            element,
            source_element,
        },
    });
}

// ---------------------------------------------------------------------------
// Type event flush helpers
// ---------------------------------------------------------------------------

/// Flush the pending type event immediately, emitting it as a `type`
/// ActionEvent.
fn flush_pending_type(
    pending_type: &mut Option<PendingTypeEvent>,
    action_sender: &mpsc::Sender<ActionEvent>,
) {
    if let Some(pt) = pending_type.take() {
        let _ = action_sender.send(ActionEvent {
            timestamp: pt.timestamp,
            context_id: pt.context_id,
            capture_mode: CaptureMode::Accessibility,
            frame_src: None,
            window_rect: pt.window_rect,
            sequence_id: Some(pt.sequence_id),
            payload: ActionPayload::Type {
                element: pt.element,
                value: pt.value,
            },
        });
    }
}

/// Check if the type debounce interval has elapsed and flush if so.
fn try_flush_type_debounce(
    pending_type: &mut Option<PendingTypeEvent>,
    now: u64,
    action_sender: &mpsc::Sender<ActionEvent>,
) {
    let should_flush = pending_type
        .as_ref()
        .map(|pt| now.saturating_sub(pt.last_update) >= TYPE_DEBOUNCE_MS)
        .unwrap_or(false);

    if should_flush {
        flush_pending_type(pending_type, action_sender);
    }
}
