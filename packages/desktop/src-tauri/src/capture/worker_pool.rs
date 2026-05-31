// Worker pool — platform-agnostic infrastructure for the capture worker pool.
//
// This module contains RawEvent, WorkerPool, dispatch logic, sequence
// numbering, the AccessibilityBackend trait, and the worker receive loop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::action_mapping::PASSWORD_MASK;
use super::coordinate;
use super::scroll::{RawScrollEvent, ScrollAccumulator};
use super::{
    ActionEvent, ActionPayload, CaptureError, CaptureMode, ElementDescription, Modifiers,
    WindowRect,
};

/// Maximum total time [`WorkerPool::shutdown`] waits for all worker threads to
/// exit before detaching any stragglers. Workers normally exit near-instantly
/// once they receive the shutdown signal; this bound only matters when a worker
/// is wedged in an unresponsive platform accessibility call.
const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Poll interval used while waiting for worker threads to finish during
/// shutdown. Small enough that normal (fast) exits aren't delayed noticeably.
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(10);

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
    /// Shared handle to the worker's flushable buffers (completed-but-held
    /// actions). The worker mutates these; the pool retains a clone so
    /// [`shutdown`](WorkerPool::shutdown) can drain and emit them even if the
    /// worker thread has to be detached (e.g. stuck in a slow platform call).
    /// This is what makes buffered actions survive a detach — see
    /// [`PendingBuffers`].
    pub pending: SharedPendingBuffers,
}

// ---------------------------------------------------------------------------
// PendingBuffers — flushable, completed-but-held actions
// ---------------------------------------------------------------------------

/// Shared handle to a worker's flushable buffers.
pub type SharedPendingBuffers = Arc<Mutex<PendingBuffers>>;

/// The subset of per-worker state that holds **completed actions awaiting
/// emission** (as opposed to dedup/correlation state used to judge future
/// events). These are "sacred": on stop they must be flushed, never lost.
///
/// This lives behind an `Arc<Mutex<>>` shared between the worker thread and the
/// pool so that [`WorkerPool::shutdown`] can drain and emit any buffered
/// actions itself if a worker has to be detached without reaching its own
/// flush path.
///
/// # Locking discipline
///
/// The worker only ever locks this around **in-memory mutations** (push/take of
/// already-built `ActionEvent`s) — never across a platform accessibility call.
/// A wedged worker is therefore always stuck *outside* this lock, so the
/// shutdown drainer can always acquire it. Violating this discipline (holding
/// the lock across a backend call) would reintroduce a shutdown hang.
#[derive(Default)]
pub struct PendingBuffers {
    /// Accumulated scroll deltas awaiting debounce/threshold flush.
    pub scroll_acc: ScrollAccumulator,
    /// Buffered type event awaiting coalesce-window flush.
    pub pending_type: Option<PendingTypeEvent>,
    /// Buffered printable key events awaiting debounce flush.
    pub pending_keys: Vec<ActionEvent>,
    /// Timestamp of the last buffered key (for debounce flush).
    pub pending_keys_last_timestamp: u64,
}

impl PendingBuffers {
    fn new() -> Self {
        Self::default()
    }

    /// Flush only the pending type event (if any), emitting it. Used at points
    /// where a type event must be committed before another action (context
    /// switch, control key) without touching the key/scroll buffers.
    fn flush_pending_type_only(&mut self, action_sender: &mpsc::Sender<ActionEvent>) {
        flush_pending_type(&mut self.pending_type, action_sender);
    }

    /// Drain all buffered actions, emitting them via `action_sender`.
    ///
    /// Pending type takes precedence over pending keys (the type value
    /// supersedes the individual keystrokes), matching the live debounce
    /// behaviour. Returns after the buffers are empty. Safe to call more than
    /// once and from either the worker or the shutdown drainer — whoever calls
    /// first empties the buffers; subsequent calls are no-ops.
    fn drain_into(&mut self, action_sender: &mpsc::Sender<ActionEvent>) {
        if self.pending_type.is_some() {
            // A type event supersedes buffered keys.
            flush_pending_type(&mut self.pending_type, action_sender);
            self.pending_keys.clear();
            self.pending_keys_last_timestamp = 0;
        } else {
            flush_pending_keys(&mut self.pending_keys, action_sender);
            self.pending_keys_last_timestamp = 0;
        }
        if let Some(result) = self.scroll_acc.try_flush(u64::MAX) {
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
    }
}

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

/// Type alias for the boxed spawn closure stored by the pool.
///
/// The closure receives `(worker_index, receiver, queue_len, action_sender,
/// pending)` and returns a `JoinHandle<()>` for the spawned worker thread.
/// `pending` is the worker's shared flushable-buffer handle.
type SpawnWorkerFn = Box<
    dyn Fn(
            usize,
            mpsc::Receiver<WorkerMessage>,
            Arc<AtomicU64>,
            mpsc::Sender<ActionEvent>,
            SharedPendingBuffers,
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
    /// `Arc<AtomicU64>` queue-length counter, a clone of `action_sender`, and
    /// the worker's shared [`SharedPendingBuffers`] handle.
    pub fn new<F>(count: usize, action_sender: mpsc::Sender<ActionEvent>, spawn_worker: F) -> Self
    where
        F: Fn(
                usize,
                mpsc::Receiver<WorkerMessage>,
                Arc<AtomicU64>,
                mpsc::Sender<ActionEvent>,
                SharedPendingBuffers,
            ) -> JoinHandle<()>
            + Send
            + 'static,
    {
        let mut workers = Vec::with_capacity(count);

        for index in 0..count {
            let (tx, rx) = mpsc::channel();
            let queue_len = Arc::new(AtomicU64::new(0));
            let pending: SharedPendingBuffers = Arc::new(Mutex::new(PendingBuffers::new()));
            let handle = spawn_worker(
                index,
                rx,
                Arc::clone(&queue_len),
                action_sender.clone(),
                Arc::clone(&pending),
            );
            workers.push(WorkerHandle {
                sender: tx,
                queue_len,
                thread: Some(handle),
                pending,
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
            RawEventType::Drop { .. } => self
                .last_drag_worker
                .unwrap_or_else(|| self.shortest_queue_worker()),
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
                match worker
                    .sender
                    .send(WorkerMessage::Event(Box::new(current_event)))
                {
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
        let pending: SharedPendingBuffers = Arc::new(Mutex::new(PendingBuffers::new()));
        let thread = (self.spawn_worker)(
            index,
            rx,
            Arc::clone(&queue_len),
            self.action_sender.clone(),
            Arc::clone(&pending),
        );

        eprintln!("[WorkerPool] Respawned worker {index}");

        self.workers[index] = WorkerHandle {
            sender: tx,
            queue_len,
            thread: Some(thread),
            pending,
        };

        // Clear sticky affinity entries that pointed to the dead worker.
        self.value_change_affinity.retain(|_, &mut v| v != index);

        // Clear drag worker if it was the dead one.
        if self.last_drag_worker == Some(index) {
            self.last_drag_worker = None;
        }
    }

    /// Signal all workers to shut down and wait (bounded) for their threads.
    ///
    /// Sends `WorkerMessage::Shutdown` to each worker, then waits up to
    /// [`WORKER_SHUTDOWN_TIMEOUT`] for **all** threads to finish. Any worker
    /// that hasn't exited by the deadline is detached (its `JoinHandle` is
    /// dropped) rather than joined.
    ///
    /// The bound matters: a worker can be parked inside a platform
    /// accessibility call (UIA `ElementFromPoint`, AT-SPI2 query, …) that does
    /// not return promptly when the target window is unresponsive. An
    /// unbounded `join()` there would hang `shutdown()` — and therefore
    /// `stop()` — indefinitely, which is exactly how a single wedged worker can
    /// stall an entire serial test run until the CI job timeout. Detaching the
    /// straggler lets shutdown always return; the leaked thread is reclaimed at
    /// process exit.
    pub fn shutdown(&mut self) {
        self.shutdown_with_timeout(WORKER_SHUTDOWN_TIMEOUT);
    }

    /// [`shutdown`](Self::shutdown) with an explicit timeout (for testing).
    fn shutdown_with_timeout(&mut self, timeout: Duration) {
        // Send shutdown signal to all workers.
        for (i, worker) in self.workers.iter().enumerate() {
            if worker.sender.send(WorkerMessage::Shutdown).is_err() {
                eprintln!("[WorkerPool] Warning: worker {i} already disconnected during shutdown");
            }
        }

        // Clone the sender so we can emit rescued buffers while iterating
        // `self.workers` mutably below.
        let action_sender = self.action_sender.clone();

        // Wait (bounded) for every worker thread to finish. We poll
        // `is_finished()` so a single stuck worker can't block the others'
        // cleanup, and so the total wait is capped at `timeout`.
        let deadline = Instant::now() + timeout;
        for (i, worker) in self.workers.iter_mut().enumerate() {
            let Some(handle) = worker.thread.take() else {
                continue;
            };

            // Spin-wait for this handle to finish, up to the shared deadline.
            while !handle.is_finished() {
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(SHUTDOWN_POLL_INTERVAL);
            }

            if handle.is_finished() {
                if let Err(e) = handle.join() {
                    eprintln!("[WorkerPool] Warning: worker {i} panicked: {e:?}");
                }
            } else {
                // Worker is wedged (likely in a blocking platform call).
                // Detach it: dropping the handle leaks the thread, which is
                // reclaimed at process exit. Shutdown must not hang on it.
                //
                // Before detaching, rescue the worker's buffered actions: it
                // never reached its own flush path, but those completed actions
                // are sacred and must not be lost. The worker only ever locks
                // `pending` around in-memory mutations (never across a platform
                // call), so a wedged worker holds no lock here and we can
                // always acquire it. `drain_into` empties the buffers, so if
                // the worker *does* later wake and flush, it finds them empty —
                // no double emit.
                eprintln!(
                    "[WorkerPool] Warning: worker {i} did not exit within {timeout:?}; \
                     detaching (rescuing buffered actions)"
                );
                match worker.pending.lock() {
                    Ok(mut buffers) => buffers.drain_into(&action_sender),
                    Err(poisoned) => {
                        // A panicked worker poisoned the lock. The buffers are
                        // still structurally valid; rescue them anyway.
                        poisoned.into_inner().drain_into(&action_sender);
                    }
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

/// Lock a worker's shared pending buffers, tolerating poisoning.
///
/// If a worker thread panicked while holding the lock, the buffers are still
/// structurally valid, so we recover the guard rather than propagate the
/// panic — losing buffered actions to a poisoned lock would defeat the point.
///
/// Callers MUST NOT hold this guard across a platform accessibility call (see
/// [`PendingBuffers`] locking discipline).
fn lock_buffers(pending: &SharedPendingBuffers) -> std::sync::MutexGuard<'_, PendingBuffers> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

/// Determine whether a key event should be emitted immediately.
///
/// Returns `true` for control keys and modifier combos (emit immediately).
/// Returns `false` for modifier-only keys (skip entirely — no useful info).
/// Printable characters are handled separately via the pending_keys buffer.
fn is_modifier_only_key(key: &str) -> bool {
    key.is_empty()
}

/// Determine whether a key is a printable character (should be buffered,
/// not emitted immediately).
fn is_printable_key(key: &str, modifiers: &(bool, bool, bool, bool)) -> bool {
    // A key is "printable" if it's a single character with no Ctrl/Alt/Meta.
    key.len() == 1 && !modifiers.0 && !modifiers.2 && !modifiers.3
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
    pending: SharedPendingBuffers,
) {
    if let Err(e) = backend.init() {
        eprintln!("[Worker {worker_index}] init failed: {e}");
        return;
    }

    let mut state = WorkerState::new();

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
                        &mut state,
                        &pending,
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
                            &mut state,
                            &pending,
                        );
                    }));
                }
                // Flush all buffered (completed) actions. Holds the lock only
                // for the in-memory drain — no backend calls inside.
                lock_buffers(&pending).drain_into(&action_sender);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Periodic flush for scroll debounce and type debounce.
                let now = current_timestamp_ms();
                let mut buffers = lock_buffers(&pending);
                if let Some(result) = buffers.scroll_acc.try_flush(now) {
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
                try_flush_type_debounce(&mut buffers, now, &action_sender);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Channel closed — flush and exit.
                lock_buffers(&pending).drain_into(&action_sender);
                break;
            }
        }
    }

    backend.cleanup();
}

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

/// Mutable per-worker **dedup/correlation** state passed to `process_raw_event`.
///
/// This holds only "forward-looking" state — used to decide whether to emit
/// *future* events (focus/value/select dedup, drag pairing). It is deliberately
/// **not** shared: once capture stops there are no future events to judge, so
/// losing this state on a worker detach has no consequence.
///
/// The "sacred" completed-but-held actions (scroll/type/key buffers) live
/// separately in [`PendingBuffers`] behind a shared lock, so they survive a
/// detach — see that type's docs.
struct WorkerState {
    last_focus_selector: String,
    last_value_map: HashMap<String, String>,
    last_drag_element: Option<ElementDescription>,
    /// Timestamp of the last click event — used to suppress duplicate select
    /// events that fire immediately after a click on the same element.
    last_click_timestamp: u64,
}

impl WorkerState {
    fn new() -> Self {
        Self {
            last_focus_selector: String::new(),
            last_value_map: HashMap::new(),
            last_drag_element: None,
            last_click_timestamp: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

/// Process a single raw event, performing accessibility queries and emitting
/// the appropriate `ActionEvent`.
fn process_raw_event<B: AccessibilityBackend>(
    _worker_index: usize,
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    excluded_pid: &Arc<AtomicU32>,
    state: &mut WorkerState,
    pending: &SharedPendingBuffers,
) {
    // PID exclusion check — discard events from the excluded process.
    let excl = excluded_pid.load(Ordering::SeqCst);
    if excl != 0 && raw.process_id == excl {
        return;
    }

    // Resolve context_id from the root window handle.
    let context_id = if raw.window_handle != 0 {
        let root = backend.root_window_handle(raw.window_handle);
        if root != 0 {
            Some(root)
        } else {
            Some(raw.window_handle)
        }
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
                raw,
                backend,
                action_sender,
                context_id,
                false,
                window_rect.clone(),
            );
            state.last_click_timestamp = raw.timestamp;
        }
        RawEventType::RightClick => {
            handle_click(
                raw,
                backend,
                action_sender,
                context_id,
                true,
                window_rect.clone(),
            );
            state.last_click_timestamp = raw.timestamp;
        }
        RawEventType::Focus => {
            handle_focus(
                raw,
                backend,
                action_sender,
                context_id,
                &mut state.last_focus_selector,
                window_rect.clone(),
            );
        }
        RawEventType::ValueChange => {
            handle_value_change(
                raw,
                backend,
                action_sender,
                context_id,
                pending,
                &mut state.last_value_map,
                window_rect.clone(),
            );
            // A value change arrived — pending keys will be superseded by the
            // type event when it flushes. Clear them now.
            let mut buffers = lock_buffers(pending);
            buffers.pending_keys.clear();
            buffers.pending_keys_last_timestamp = 0;
        }
        RawEventType::Selection => {
            handle_selection(raw, backend, action_sender, context_id, window_rect.clone());
        }
        RawEventType::Keyboard => {
            handle_keyboard(
                raw,
                backend,
                action_sender,
                context_id,
                pending,
                window_rect.clone(),
            );
        }
        RawEventType::Foreground => {
            // Flush pending type before context switch.
            lock_buffers(pending).flush_pending_type_only(action_sender);
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
            let now = current_timestamp_ms();
            let mut buffers = lock_buffers(pending);
            buffers.scroll_acc.push(RawScrollEvent {
                timestamp: raw.timestamp,
                delta_x: if is_horizontal { raw.scroll_delta } else { 0.0 },
                delta_y: if is_horizontal { 0.0 } else { raw.scroll_delta },
            });
            // Check if debounce has elapsed (will be checked on timeout too).
            if let Some(result) = buffers.scroll_acc.try_flush(now) {
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
            handle_drag_start(
                raw,
                backend,
                action_sender,
                context_id,
                &mut state.last_drag_element,
                window_rect.clone(),
            );
        }
        RawEventType::Drop { source_coords: _ } => {
            handle_drop(
                raw,
                backend,
                action_sender,
                context_id,
                &mut state.last_drag_element,
                window_rect.clone(),
            );
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

    // File dialog detection: if the clicked element is a button named
    // "Save" or "Open", check if the window is a file dialog.
    if !is_right_click {
        if let Some(ref name) = element_desc.name {
            let name_lower = name.to_lowercase();
            if (name_lower == "save" || name_lower == "open") && element_desc.tag == "Button" {
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
        payload: ActionPayload::Focus { element },
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
    pending: &SharedPendingBuffers,
    last_value_map: &mut HashMap<String, String>,
    window_rect: Option<WindowRect>,
) {
    // Backend (UIA) call happens BEFORE taking the buffer lock.
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
    // (last_value_map is dedup state — stays thread-local in WorkerState.)
    if let Some(last_val) = last_value_map.get(&element.selector) {
        if *last_val == value {
            return;
        }
    }
    last_value_map.insert(element.selector.clone(), value.clone());

    // In-memory buffer mutation only — short lock, no backend calls inside.
    let mut buffers = lock_buffers(pending);

    // Check if we have a pending type event for a different element — flush it.
    if let Some(ref pt) = buffers.pending_type {
        if pt.element.selector != element.selector {
            buffers.flush_pending_type_only(action_sender);
        }
    }

    // Buffer or update the pending type event.
    match buffers.pending_type {
        Some(ref mut pt) if pt.element.selector == element.selector => {
            // Same element — update value and reset debounce timer.
            pt.value = value;
            pt.sequence_id = raw.sequence_id;
            pt.last_update = raw.timestamp;
        }
        _ => {
            // New element or no pending event.
            buffers.pending_type = Some(PendingTypeEvent {
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
        let is_container = matches!(el.tag.as_str(), "List" | "ComboBox" | "Tree" | "DataGrid");

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
                    name: if title.is_empty() {
                        None
                    } else {
                        Some(title.clone())
                    },
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
    pending: &SharedPendingBuffers,
    window_rect: Option<WindowRect>,
) {
    let key = vk_to_key_name(raw.key_code);

    // Skip modifier-only keys (Shift, Ctrl, Alt alone — no useful info).
    if is_modifier_only_key(&key) {
        return;
    }

    // Backend (UIA) call happens BEFORE taking the buffer lock — never hold
    // the lock across a platform call (see PendingBuffers locking discipline).
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

    let event = ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::Key {
            key: key.clone(),
            modifiers: Modifiers {
                ctrl: raw.modifiers.0,
                shift: raw.modifiers.1,
                alt: raw.modifiers.2,
                meta: raw.modifiers.3,
            },
            element,
        },
    };

    // In-memory buffer mutation only — short lock, no backend calls inside.
    let mut buffers = lock_buffers(pending);
    if is_printable_key(&key, &raw.modifiers) {
        // Buffer printable keys — they may be superseded by a type event.
        buffers.pending_keys.push(event);
        buffers.pending_keys_last_timestamp = raw.timestamp;
    } else {
        // Control key — flush pending type and pending keys, then emit.
        buffers.flush_pending_type_only(action_sender);
        flush_pending_keys(&mut buffers.pending_keys, action_sender);
        let _ = action_sender.send(event);
    }
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
/// ActionEvent. When a type event is flushed, pending keys are discarded
/// (they're superseded by the coalesced type value).
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

/// Flush buffered printable key events — emit them as individual key actions.
/// Called when the TYPE_DEBOUNCE_MS window expires without a type event arriving
/// (meaning the app doesn't fire EVENT_OBJECT_VALUECHANGE for these keystrokes).
fn flush_pending_keys(
    pending_keys: &mut Vec<ActionEvent>,
    action_sender: &mpsc::Sender<ActionEvent>,
) {
    for event in pending_keys.drain(..) {
        let _ = action_sender.send(event);
    }
}

/// Check if the type debounce interval has elapsed and flush if so.
/// Also flushes pending keys if the type debounce expired without a type event.
fn try_flush_type_debounce(
    buffers: &mut PendingBuffers,
    now: u64,
    action_sender: &mpsc::Sender<ActionEvent>,
) {
    let should_flush_type = buffers
        .pending_type
        .as_ref()
        .map(|pt| now.saturating_sub(pt.last_update) >= TYPE_DEBOUNCE_MS)
        .unwrap_or(false);

    if should_flush_type {
        flush_pending_type(&mut buffers.pending_type, action_sender);
        // Type event was produced — discard pending keys (superseded).
        buffers.pending_keys.clear();
        buffers.pending_keys_last_timestamp = 0;
    } else if !buffers.pending_keys.is_empty()
        && buffers.pending_keys_last_timestamp > 0
        && now.saturating_sub(buffers.pending_keys_last_timestamp) >= TYPE_DEBOUNCE_MS
    {
        // No type event arrived within the debounce window — emit the keys.
        flush_pending_keys(&mut buffers.pending_keys, action_sender);
        buffers.pending_keys_last_timestamp = 0;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// Build a pool whose workers run `body(rx, pending, sender)` in their
    /// receive loop. `body` gets the worker's message receiver, its shared
    /// pending buffers, and the action sender, so a test can pre-seed buffered
    /// actions and choose to flush+exit on `Shutdown`, or ignore it and block
    /// forever.
    fn pool_with<F>(count: usize, body: F) -> (WorkerPool, mpsc::Receiver<ActionEvent>)
    where
        F: Fn(mpsc::Receiver<WorkerMessage>, SharedPendingBuffers, mpsc::Sender<ActionEvent>)
            + Send
            + Sync
            + Clone
            + 'static,
    {
        let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
        let pool = WorkerPool::new(
            count,
            action_tx,
            move |_idx, rx, _queue_len, sender, pending| {
                let body = body.clone();
                thread::spawn(move || body(rx, pending, sender))
            },
        );
        (pool, action_rx)
    }

    /// Build a key ActionEvent for seeding pending_keys in tests.
    fn key_event(key: &str) -> ActionEvent {
        ActionEvent {
            timestamp: 1,
            context_id: Some(42),
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
                    id: None,
                    name: None,
                    role: None,
                    element_type: None,
                    text: None,
                    selector: "win > edit".to_string(),
                },
            },
        }
    }

    /// Collect all currently-available ActionEvents from the receiver.
    fn drain_events(rx: &mpsc::Receiver<ActionEvent>) -> Vec<ActionEvent> {
        rx.try_iter().collect()
    }

    fn key_names(events: &[ActionEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match &e.payload {
                ActionPayload::Key { key, .. } => Some(key.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn shutdown_joins_well_behaved_workers_quickly() {
        // Workers that exit as soon as they see Shutdown should be joined well
        // within the timeout.
        let (mut pool, _rx) = pool_with(3, |rx, _pending, _sender| {
            while let Ok(msg) = rx.recv() {
                if matches!(msg, WorkerMessage::Shutdown) {
                    break;
                }
            }
        });

        let start = Instant::now();
        pool.shutdown_with_timeout(Duration::from_secs(5));
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_secs(1),
            "shutdown of cooperative workers took {elapsed:?}, expected < 1s"
        );
        // All handles taken.
        assert!(pool.workers.iter().all(|w| w.thread.is_none()));
    }

    #[test]
    fn shutdown_is_bounded_when_a_worker_is_wedged() {
        // A worker that never returns (e.g. parked in a blocking platform call)
        // must not hang shutdown: it should be detached once the timeout
        // elapses, and shutdown should return shortly after the deadline.
        let (mut pool, _rx) = pool_with(2, |rx, _pending, _sender| {
            // Ignore Shutdown entirely and block forever.
            loop {
                let _ = rx.recv();
                std::thread::sleep(Duration::from_secs(3600));
            }
        });

        let timeout = Duration::from_millis(200);
        let start = Instant::now();
        pool.shutdown_with_timeout(timeout);
        let elapsed = start.elapsed();

        // Must return, and not much later than the (per-handle) deadline.
        assert!(
            elapsed < Duration::from_secs(5),
            "shutdown with a wedged worker took {elapsed:?}; it should be bounded"
        );
        assert!(
            elapsed >= timeout,
            "shutdown returned before the timeout elapsed ({elapsed:?})"
        );
        // The wedged handles are detached (taken) so a second shutdown is a no-op.
        assert!(pool.workers.iter().all(|w| w.thread.is_none()));
    }

    #[test]
    fn shutdown_is_idempotent() {
        // Calling shutdown twice must not panic or block — the second call has
        // no handles left to join.
        let (mut pool, _rx) = pool_with(2, |rx, _pending, _sender| {
            while let Ok(msg) = rx.recv() {
                if matches!(msg, WorkerMessage::Shutdown) {
                    break;
                }
            }
        });

        pool.shutdown_with_timeout(Duration::from_secs(5));
        // Second call: no handles, returns immediately.
        let start = Instant::now();
        pool.shutdown_with_timeout(Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn responsive_worker_flushes_buffered_keys_on_shutdown() {
        // A worker that buffered keys and is responsive flushes them via its
        // own Shutdown handler. This is the behaviour the MTA fix restores:
        // a non-wedged worker always reaches its flush.
        let (mut pool, rx) = pool_with(1, |rx, pending, sender| {
            // Seed buffered keys, then behave normally (flush on Shutdown via
            // the real drain_into, mirroring the worker loop's Shutdown arm).
            lock_buffers(&pending).pending_keys = vec![key_event("a"), key_event("b")];
            while let Ok(msg) = rx.recv() {
                if matches!(msg, WorkerMessage::Shutdown) {
                    lock_buffers(&pending).drain_into(&sender);
                    break;
                }
            }
        });

        // Give the worker a moment to seed its buffer before shutting down.
        thread::sleep(Duration::from_millis(50));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        let events = drain_events(&rx);
        assert_eq!(
            key_names(&events),
            vec!["a", "b"],
            "responsive worker must flush its buffered keys on shutdown"
        );
    }

    #[test]
    fn buffered_keys_survive_a_worker_detach() {
        // THE key guarantee (option B): completed/buffered actions are sacred.
        // Even if a worker wedges and must be detached, the buffered keys it
        // already captured must still be flushed — by the shutdown drainer
        // reaching into the shared buffer.
        let (mut pool, rx) = pool_with(1, |rx, pending, _sender| {
            // Seed buffered keys, then wedge forever (never reach own flush).
            lock_buffers(&pending).pending_keys = vec![key_event("x"), key_event("y")];
            // Block forever ignoring Shutdown — simulates a wedged UIA call.
            loop {
                let _ = rx.recv();
                std::thread::sleep(Duration::from_secs(3600));
            }
        });

        thread::sleep(Duration::from_millis(50));
        pool.shutdown_with_timeout(Duration::from_millis(200));

        let events = drain_events(&rx);
        assert_eq!(
            key_names(&events),
            vec!["x", "y"],
            "buffered keys must survive a worker detach (drained by shutdown)"
        );
    }

    #[test]
    fn detached_worker_buffered_keys_are_complete_and_correct() {
        // Addresses the specific concern: when a worker is detached and we only
        // have the flushable buffer (no dedup/correlation state), the rescued
        // actions must still be COMPLETE and CORRECT — same key, element, and
        // context as captured — needing nothing from the lost forward-looking
        // state. This proves the Group-1/Group-2 split loses nothing essential.
        let (mut pool, rx) = pool_with(1, |rx, pending, _sender| {
            {
                let mut b = lock_buffers(&pending);
                b.pending_keys = vec![key_event("h"), key_event("i")];
            }
            loop {
                let _ = rx.recv();
                std::thread::sleep(Duration::from_secs(3600));
            }
        });

        thread::sleep(Duration::from_millis(50));
        pool.shutdown_with_timeout(Duration::from_millis(200));

        let events = drain_events(&rx);
        let key_events: Vec<&ActionEvent> = events
            .iter()
            .filter(|e| matches!(e.payload, ActionPayload::Key { .. }))
            .collect();
        assert_eq!(key_events.len(), 2, "both buffered keys must be rescued");

        for (event, expected_key) in key_events.iter().zip(["h", "i"]) {
            // context_id preserved (was set at capture time, not derived from
            // any dedup state).
            assert_eq!(event.context_id, Some(42));
            match &event.payload {
                ActionPayload::Key {
                    key,
                    modifiers,
                    element,
                } => {
                    assert_eq!(key, expected_key, "key value intact");
                    assert!(
                        !modifiers.ctrl && !modifiers.shift && !modifiers.alt && !modifiers.meta,
                        "modifiers intact"
                    );
                    // Element (resolved via UIA at capture time) is fully
                    // present — no "best guess" needed at flush.
                    assert_eq!(element.tag, "Edit");
                    assert_eq!(element.selector, "win > edit");
                }
                _ => panic!("expected Key payload"),
            }
        }
    }

    // -----------------------------------------------------------------------
    // Unresponsive-vs-responsive application behaviour (deterministic)
    // -----------------------------------------------------------------------
    //
    // These drive the *real* `worker_loop`/`handle_keyboard` pipeline through a
    // backend whose `focused_element()` query either returns promptly
    // (responsive app) or blocks forever (unresponsive app — a "cut line").
    //
    // They pin down the product decision that the flaky integration tests could
    // not express deterministically: when the target app stops answering
    // accessibility queries, Docent captures *nothing* for the in-flight event
    // and never hangs; when the app is responsive, the event is captured.

    /// Backend whose `focused_element()` either returns at once or blocks
    /// forever, modelling a responsive vs. an unresponsive application. Every
    /// other query returns promptly so only the in-handler UIA call is affected.
    struct ProbeBackend {
        block_focused: bool,
    }

    impl AccessibilityBackend for ProbeBackend {
        fn init(&mut self) -> Result<(), CaptureError> {
            Ok(())
        }
        fn cleanup(&mut self) {}
        fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
            None
        }
        fn focused_element(&self) -> Option<ElementDescription> {
            if self.block_focused {
                // Model an unresponsive provider: the synchronous query never
                // returns. The thread is detached by bounded shutdown and
                // reclaimed at process exit (same pattern as the wedged-worker
                // tests above).
                loop {
                    thread::sleep(Duration::from_secs(3600));
                }
            }
            Some(ElementDescription {
                tag: "Edit".to_string(),
                id: None,
                name: Some("Field".to_string()),
                role: None,
                element_type: None,
                text: None,
                selector: "win > edit".to_string(),
            })
        }
        fn window_title(&self, _window_handle: i64) -> String {
            "Probe".to_string()
        }
        fn process_name(&self, _window_handle: i64) -> String {
            "probe.exe".to_string()
        }
        fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
            None
        }
        fn root_window_handle(&self, window_handle: i64) -> i64 {
            window_handle
        }
        fn window_rect(&self, _window_handle: i64) -> Option<WindowRect> {
            None
        }
        fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
            None
        }
    }

    /// Build a single-worker pool running the real `worker_loop` over a
    /// `ProbeBackend`. Returns the pool and the action receiver.
    fn pool_with_probe_backend(block_focused: bool) -> (WorkerPool, mpsc::Receiver<ActionEvent>) {
        let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
        let pool = WorkerPool::new(1, action_tx, move |idx, rx, queue_len, sender, pending| {
            let excluded_pid = Arc::new(AtomicU32::new(0));
            thread::spawn(move || {
                let backend = ProbeBackend { block_focused };
                worker_loop(idx, backend, rx, queue_len, sender, excluded_pid, pending);
            })
        });
        (pool, action_rx)
    }

    /// A printable-key RawEvent ('a') for the responsive/unresponsive tests.
    fn printable_key_raw_event() -> RawEvent {
        control_key_raw_event(0x41, 1) // 'A'
    }

    /// A keyboard RawEvent for a given virtual-key code and sequence id.
    fn control_key_raw_event(key_code: u32, sequence_id: u64) -> RawEvent {
        RawEvent {
            event_type: RawEventType::Keyboard,
            sequence_id,
            timestamp: 1000 + sequence_id,
            screen_x: 0,
            screen_y: 0,
            window_handle: 42,
            process_id: 1,
            key_code,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
        }
    }

    #[test]
    fn responsive_app_keypress_is_captured() {
        // Responsive app: the focused-element query returns promptly, the key
        // is buffered, and the worker's own Shutdown flush emits it. Everything
        // the user put down is captured.
        let (mut pool, rx) = pool_with_probe_backend(false);
        pool.dispatch(printable_key_raw_event());
        // Let the worker process the event before shutting down.
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        assert_eq!(
            key_names(&drain_events(&rx)),
            vec!["A"],
            "a responsive app's keypress must be captured"
        );
    }

    #[test]
    fn responsive_app_navigation_keys_are_all_captured() {
        // Responsive app, control keys (Home/End/PageUp/PageDown/Delete/
        // Backspace): each is resolved via a prompt focused_element() query and
        // emitted immediately. All six are captured, in order, with none lost
        // or duplicated. This is the deterministic equivalent of the
        // navigation_keys real-input integration test (whose capture *count* is
        // environment-dependent and therefore not asserted on CI).
        let (mut pool, rx) = pool_with_probe_backend(false);
        // VK codes: Home 0x24, End 0x23, PageUp 0x21, PageDown 0x22,
        // Delete 0x2E, Backspace 0x08.
        let vks = [0x24u32, 0x23, 0x21, 0x22, 0x2E, 0x08];
        for (i, vk) in vks.iter().enumerate() {
            pool.dispatch(control_key_raw_event(*vk, (i + 1) as u64));
        }
        thread::sleep(Duration::from_millis(150));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        assert_eq!(
            key_names(&drain_events(&rx)),
            vec!["Home", "End", "PageUp", "PageDown", "Delete", "Backspace"],
            "all six navigation keys must be captured in order on a responsive app"
        );
    }

    #[test]
    fn unresponsive_app_in_flight_keypress_is_not_captured_and_shutdown_is_bounded() {
        // Unresponsive app ("cut line"): the worker blocks inside the
        // focused-element query, so the key is never buffered. On stop there is
        // nothing to rescue — Docent correctly captures NOTHING for the
        // in-flight event — and, critically, shutdown is still bounded (the
        // wedged worker is detached, not joined).
        let (mut pool, rx) = pool_with_probe_backend(true);
        pool.dispatch(printable_key_raw_event());
        // Let the worker pick up the event and block inside focused_element().
        thread::sleep(Duration::from_millis(100));

        let timeout = Duration::from_millis(300);
        let start = Instant::now();
        pool.shutdown_with_timeout(timeout);
        let elapsed = start.elapsed();

        assert!(
            elapsed >= timeout && elapsed < Duration::from_secs(3),
            "shutdown must be bounded even when the app is unresponsive (took {elapsed:?})"
        );
        assert!(
            drain_events(&rx).is_empty(),
            "an unresponsive app's in-flight keypress must NOT be captured"
        );
        // Wedged worker was detached, so a second shutdown is a no-op.
        assert!(pool.workers.iter().all(|w| w.thread.is_none()));
    }
}
