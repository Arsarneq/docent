// Worker pool — platform-agnostic infrastructure for the capture worker pool.
//
// This module contains RawEvent, WorkerPool, dispatch logic, sequence
// numbering, the AccessibilityBackend trait, and the worker receive loop.
//
// Governance declared in scripts/area-map.json (see its declared-governance entry): workers assign each action's
// context_id from the root-window resolution, so context identity (and with
// it the format's context-introduction rule) is decided here; the
// per-platform schemas are authoritative for field semantics.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::action_mapping::PASSWORD_MASK;
use super::coordinate;
use super::held_keys::KEY_EXTENDED_PARAM;
use super::language::preferred_languages;
use super::physical_key::physical_key_code;
use super::scroll::{RawScrollEvent, ScrollAccumulator};
use super::{
    ActionEvent, ActionPayload, CaptureError, CaptureMode, ElementDescription, HeldKeysAtAction,
    Modifiers, WindowRect,
};

/// Maximum total time [`WorkerPool::shutdown`] waits for all worker threads to
/// exit before detaching any stragglers. Workers normally exit near-instantly
/// once they receive the shutdown signal; this bound only matters when a worker
/// is wedged in an unresponsive platform accessibility call.
const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Poll interval used while waiting for worker threads to finish during
/// shutdown. Small enough that normal (fast) exits aren't delayed noticeably.
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Maximum total time [`WorkerPool::flush_all`] waits for every worker to
/// acknowledge a commit flush barrier (docent#298) before rescuing the
/// stragglers' buffers in place and returning. Bounds the step-commit latency
/// exactly as `WORKER_SHUTDOWN_TIMEOUT` bounds shutdown; a genuinely wedged
/// worker (parked in an unresponsive accessibility call) cannot stall commit
/// past this — its completed-but-held actions are drained by the pool itself.
pub const FLUSH_BARRIER_TIMEOUT: Duration = Duration::from_secs(5);

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
    /// Wheel delta for scroll events, fed unconverted into [`RawScrollEvent`]
    /// (which states its units and sign); the axis is `callback_params[0]`
    /// (1 = horizontal).
    pub scroll_delta: f64,
    /// Platform-specific opaque callback parameters.
    ///
    /// On Windows: `[id_object, id_child, 0, 0]` from `SetWinEventHook`
    /// callbacks, which workers use to determine which sub-element triggered
    /// the event, a focus event carrying its number among the focus events
    /// dispatched in the third slot (see
    /// [`AccessibilityBackend::focus_events_dispatched`]); `[axis, 0, 0, 0]` from the mouse hook's wheel path, where
    /// 1 = horizontal (read by the scroll arm); `[scan_code, focused_control,
    /// part_focus, layout_char]` from the keyboard hook, all read by the
    /// keyboard arm: `scan_code` is the hook's scan code, for a `VK_PACKET`
    /// keystroke the injected UTF-16 code unit, with the hook's extended mark
    /// for the key in the bit above it
    /// ([`super::held_keys::KEY_EXTENDED_PARAM`]), scan code and mark together
    /// naming the physical key a `key` action's `code` states;
    /// `focused_control` the window
    /// handle of the control that held the keyboard focus at the key (`0` when
    /// none was read, see `settle_key_on_its_control`); `part_focus` the
    /// number of the latest focus change that named a part of that control
    /// (see [`PartFocusNote`]); and `layout_char`, in the low 32 bits, what the
    /// keyboard layout gives a punctuation key (see [`punctuation_key_name`]; 0
    /// for every other key), with the repeat mark in the bit above it
    /// ([`super::held_keys::KEY_REPEAT_PARAM`]): set on a key-down for a key
    /// that was already down (a press key repeat generated while the key was
    /// held), clear on the press itself (see [`super::held_keys::HeldKeys`]).
    /// `[button, 0, 0, 0]` from the mouse hook's click paths, where
    /// [`CLICK_COMPLETES_DOUBLE_CLICK`] marks the second click of a
    /// double-click (read by the pool's routing and the click arm) and
    /// [`CLICK_IS_MIDDLE_BUTTON`] a middle-button press (read by the click
    /// arm). On other platforms: unused or platform-defined.
    pub callback_params: [i64; 4],
    /// Pre-captured element description, from the click pre-capture the
    /// mouse hook waited on (DCP-1). For a click, right-click or middle
    /// press, the hook asks a pre-capture describer for the element at the
    /// point and waits for at most the budget before dispatching. An answer
    /// that came in time is attached here, described at the click, before
    /// the click takes effect, and the worker uses it directly. If `None` —
    /// no answer in time, an answer that described nothing, or no
    /// pre-capture running — the worker performs its own query, after the
    /// click has taken effect (DCP-13).
    pub pre_captured_element: Option<super::ElementDescription>,
    /// The focus epoch when the Input_Thread dispatched this event: a count of
    /// the focus and foreground changes it had seen by then (see
    /// [`AccessibilityBackend::focus_epoch`]). Two events with the same epoch
    /// were dispatched with no focus change between them; a worker that
    /// describes "the focused element" later compares this with the epoch at
    /// that moment to know whether focus is still where the event happened.
    /// Assigned by the Input_Thread at dispatch; `0` where the platform does
    /// not count focus changes.
    ///
    /// The count has two halves. The high 32 bits count what the person did
    /// that can move the focus (a mouse-down, a focus-moving key): counted on
    /// the hooks, so exact at every dispatch. The low 32 bits count the focus
    /// and foreground changes programs reported, which reach the Input_Thread
    /// a moment after they happen. See [`person_moved_focus_between`].
    pub focus_epoch: u64,
    /// The keys that were down when the Input_Thread dispatched this event
    /// and whose key-down it had dispatched, in the order they went down,
    /// without the modifier keys and without a keystroke's own key (see
    /// [`super::held_keys::HeldKeys::dispatched_down`]). Filled for the
    /// keystrokes and the pointer events an action's `held_keys` is written
    /// from; empty otherwise.
    pub held: Vec<super::held_keys::HeldPress>,
}

// ---------------------------------------------------------------------------
// Double-click
// ---------------------------------------------------------------------------

/// The `callback_params[0]` value of a left [`RawEventType::Click`] whose press
/// completed a double-click (DCP-10); `0` on every other left click.
pub const CLICK_COMPLETES_DOUBLE_CLICK: i64 = 1;

/// The `callback_params[0]` value of a [`RawEventType::Click`] the middle
/// button's press records (DCP-10): a click of the format, but no press of
/// the left button, so it confirms no file dialog.
pub const CLICK_IS_MIDDLE_BUTTON: i64 = 2;

/// Whether `raw` is a click the middle button's press records.
pub fn is_middle_button_click(raw: &RawEvent) -> bool {
    matches!(raw.event_type, RawEventType::Click)
        && raw.callback_params[0] == CLICK_IS_MIDDLE_BUTTON
}

/// Whether `raw` is a left click whose press completed a double-click.
pub fn completes_double_click(raw: &RawEvent) -> bool {
    matches!(raw.event_type, RawEventType::Click)
        && raw.callback_params[0] == CLICK_COMPLETES_DOUBLE_CLICK
}

/// One press of the left button, as the double-click test reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClickPress {
    /// The press time on the system's input clock, in milliseconds (it wraps).
    pub time_ms: u32,
    /// Screen-space X coordinate of the press.
    pub x: i32,
    /// Screen-space Y coordinate of the press.
    pub y: i32,
    /// The window the press landed in.
    pub window: i64,
}

/// The system's double-click bounds: the longest time between the two presses
/// and the size of the rectangle, centred on the first press, the second must
/// land in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DoubleClickBounds {
    pub max_interval_ms: u32,
    pub width: i32,
    pub height: i32,
}

/// Pairs left clicks into double-clicks the way the system does (DCP-10): a
/// click's press completes a double-click when it lands in the same window as
/// the press of the left click before it, within the system's double-click
/// time after it and inside the system's double-click rectangle around it. A
/// press that completes a double-click starts no new pair, and a right or
/// middle press, or a drag, between two left clicks breaks the pair.
///
/// Pure state the mouse hook keeps, so the pairing is testable without
/// synthesizing input.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DoubleClickTracker {
    previous: Option<ClickPress>,
}

impl DoubleClickTracker {
    /// A tracker with no click recorded.
    pub const fn new() -> Self {
        Self { previous: None }
    }

    /// Record a left click by its press; answers whether that press completed
    /// a double-click.
    pub fn left_click(&mut self, press: ClickPress, bounds: DoubleClickBounds) -> bool {
        let completes = self.previous.is_some_and(|first| {
            first.window == press.window
                && press.time_ms.wrapping_sub(first.time_ms) <= bounds.max_interval_ms
                && (press.x - first.x).abs() <= bounds.width / 2
                && (press.y - first.y).abs() <= bounds.height / 2
        });
        self.previous = if completes { None } else { Some(press) };
        completes
    }

    /// Break the pair: the next left click starts a new one.
    pub fn break_pair(&mut self) {
        self.previous = None;
    }
}

// ---------------------------------------------------------------------------
// WorkerMessage
// ---------------------------------------------------------------------------

/// Messages sent from the Input_Thread to worker threads.
pub enum WorkerMessage {
    /// A raw event to process.
    Event(Box<RawEvent>),
    /// Commit flush barrier (docent#298): drain completed-but-held actions
    /// (`drain_into`) into the action stream, then acknowledge by sending this
    /// worker's index on the enclosed channel — **without exiting** the loop
    /// (capture continues after the step commit). Contrast
    /// [`WorkerMessage::Shutdown`], which drains and then exits.
    Flush(mpsc::Sender<usize>),
    /// The typing in a field has ended (a pointer press, a drag or a window
    /// change was dispatched): write the pending `type`, so that it stands
    /// ahead of what follows. Sent to the typing worker only, on its FIFO
    /// channel, so it is processed after every keystroke and value change
    /// dispatched before it.
    EndTyping,
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

/// The pool's drain directory: one live [`SharedPendingBuffers`] handle per
/// worker index, kept current by the pool itself (construction and every
/// respawn replace the slot). Shared with the platform layer so the commit
/// flush barrier's **fallback drain** can empty every worker's held buffers
/// without going through the input thread or the bridge — the recovery path
/// when the marker-ordered barrier cannot report within its bound. A mirror
/// is required, not a convenience: during capture the pool itself is owned by
/// the bridge thread's closure, so the platform layer has no path to the
/// workers at barrier time except through handles retained at start.
pub type PendingDirectory = Arc<Mutex<Vec<SharedPendingBuffers>>>;

/// Emit the [`ActionPayload::BarrierComplete`] sentinel for `barrier_id` onto
/// the action stream — the single construction site for the sentinel, shared
/// by the marker-ordered path ([`WorkerPool::flush_all`]) and the fallback
/// drain ([`fallback_drain_and_seal`]).
fn emit_barrier_sentinel(action_sender: &mpsc::Sender<ActionEvent>, barrier_id: u64) {
    let _ = action_sender.send(ActionEvent {
        timestamp: current_timestamp_ms(),
        context_id: None,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect: None,
        preferred_languages: None,
        sequence_id: None,
        payload: ActionPayload::BarrierComplete { barrier_id },
    });
}

/// Drain every buffer in the directory into `action_sender`, then emit the
/// [`ActionPayload::BarrierComplete`] sentinel for `barrier_id` after them —
/// the commit flush barrier's fallback drain. Runs on the caller's thread and
/// touches no worker channel, so it works when the input thread is dead or its
/// pump is stalled. Safe against every concurrent drain: `drain_into` empties
/// the buffers under their shared lock (poison-tolerant), so whoever drains
/// first wins and a later drain finds nothing to re-emit.
pub fn fallback_drain_and_seal(
    directory: &PendingDirectory,
    action_sender: &mpsc::Sender<ActionEvent>,
    barrier_id: u64,
) {
    let handles: Vec<SharedPendingBuffers> = match directory.lock() {
        Ok(dir) => dir.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    for pending in &handles {
        lock_buffers(pending).drain_into(action_sender);
    }
    emit_barrier_sentinel(action_sender, barrier_id);
}

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
    /// The `type` of the field being typed into, held until the typing ends.
    pub pending_type: Option<PendingTypeEvent>,
    /// Typing keys waiting for the value change that makes them text.
    pub pending_keys: Vec<ActionEvent>,
    /// Timestamp of the last buffered key (the wait is counted from it).
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
    /// supersedes the individual keystrokes), as it does when the typing
    /// ends. Returns after the buffers are empty. Safe to call more than
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
                preferred_languages: preferred_languages(),
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

/// The value of the pool's typing-worker slot while no worker holds the role.
const NO_TYPING_WORKER: usize = usize::MAX;

/// The value of the pool's focus-worker slot while no worker holds the role.
const NO_FOCUS_WORKER: usize = usize::MAX;

/// Platform-agnostic worker pool for dispatching raw events to accessibility
/// worker threads.
///
/// The pool manages a fixed set of workers, assigns monotonic sequence numbers
/// to events, and routes events using shortest-queue dispatch with one typing
/// worker for keyboard and value-change events, one focus worker for focus
/// events, sticky routing for selection events, and paired routing for drag
/// events and double-clicks.
///
/// When a worker panics, the pool detects the failure on the next dispatch
/// attempt, immediately respawns a replacement worker at the same index, and
/// retries the event. Surviving workers continue processing events while the
/// replacement is being spawned, so no events are lost.
pub struct WorkerPool {
    workers: Vec<WorkerHandle>,
    /// Live per-index pending-buffer handles, mirrored from `workers` so the
    /// platform layer can run the barrier's fallback drain without the pool
    /// (see [`PendingDirectory`]). Updated in-place on every respawn.
    pending_directory: PendingDirectory,
    sequence_counter: Arc<AtomicU64>,
    /// The typing worker: the one worker every keyboard and value-change event
    /// reaches, so its queue processes a value change after the keystrokes
    /// that caused it and the typing state it judges them with (buffered keys,
    /// the pending type, the last values) is whole. Chosen by shortest queue
    /// at the first such event, kept across a respawn of its index, and given
    /// up when a flush barrier finds it unresponsive ([`flush_all`](Self::flush_all)),
    /// so typing does not queue behind a wedged accessibility call for the
    /// rest of the capture. `NO_TYPING_WORKER` while none is chosen.
    typing_worker: AtomicUsize,
    /// The workers that did not answer the most recent flush barrier, one bit
    /// per index. The typing role is not given to one of them while another
    /// worker is available; a respawn clears its index's bit.
    missed_last_barrier: AtomicU64,
    /// The focus worker: the one worker every focus event reaches, whatever
    /// window the event named, so the last focus it compares a focus with is
    /// the focus before it (docent#735). Chosen like the typing worker, at
    /// the first focus event, kept across a respawn of its index, and given up
    /// the same way when a flush barrier finds it unresponsive.
    /// `NO_FOCUS_WORKER` while none is chosen.
    focus_worker: AtomicUsize,
    /// Sticky routing: maps `window_handle` → `worker_index` for selection
    /// events, so each window's selections reach one worker, in order.
    window_affinity: HashMap<i64, usize>,
    /// Tracks the worker index that received the most recent `DragStart`,
    /// so the corresponding `Drop` event is routed to the same worker.
    last_drag_worker: Option<usize>,
    /// The worker index that received the most recent `Click`, so a click
    /// that completes a double-click reaches the worker that processed the
    /// click before it (the file-dialog proxy reads the pair there, DCP-6).
    /// Kept across a respawn of its index: a click retried on the fresh
    /// worker is the one its pair must follow.
    last_click_worker: Option<usize>,
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

        let pending_directory: PendingDirectory = Arc::new(Mutex::new(
            workers.iter().map(|w| Arc::clone(&w.pending)).collect(),
        ));

        Self {
            workers,
            pending_directory,
            sequence_counter: Arc::new(AtomicU64::new(0)),
            typing_worker: AtomicUsize::new(NO_TYPING_WORKER),
            missed_last_barrier: AtomicU64::new(0),
            focus_worker: AtomicUsize::new(NO_FOCUS_WORKER),
            window_affinity: HashMap::new(),
            last_drag_worker: None,
            last_click_worker: None,
            spawn_worker: Box::new(spawn_worker),
            action_sender,
        }
    }

    /// Shared handle to the pool's [`PendingDirectory`] — the platform layer
    /// retains a clone at capture start so the commit flush barrier's fallback
    /// drain can reach every worker's held buffers directly.
    pub fn pending_directory(&self) -> &PendingDirectory {
        &self.pending_directory
    }

    /// Get the current max sequence number assigned so far.
    /// Returns 0 if no events have been dispatched.
    ///
    /// The Input_Thread assigns ids directly on the shared counter returned by
    /// [`sequence_counter`](Self::sequence_counter); this is the read side.
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
    /// - `Keyboard`, `ValueChange` → the typing worker (one worker for all of
    ///   them, whatever the window).
    /// - `Focus` → the focus worker (one worker for all of them, whatever the
    ///   window).
    /// - `Selection` → sticky routing (same `window_handle` → same worker).
    /// - `DragStart`   → shortest-queue worker (index stored for the paired `Drop`).
    /// - `Drop`        → same worker as the most recent `DragStart`.
    /// - `Click`       → shortest-queue worker, or, for a click that completes
    ///   a double-click, the same worker as the click before it.
    /// - All others    → shortest-queue worker.
    ///
    /// If the selected worker has disconnected (panicked), it is marked dead
    /// and removed from future dispatch rotation. The event is retried on the
    /// next available worker. Sticky affinity entries pointing to the dead
    /// worker are cleared so subsequent events are re-routed; the typing and
    /// focus workers stay the respawned index.
    pub fn dispatch(&mut self, event: RawEvent) {
        if ends_typing(&event.event_type) {
            self.end_typing();
        }
        let worker_index = self.select_worker(&event);
        self.send_to_worker(worker_index, event);
    }

    /// Tell the typing worker that the typing in a field has ended. With no
    /// typing worker yet there is no pending `type`; a worker whose channel is
    /// gone has its buffers drained when it is respawned.
    fn end_typing(&mut self) {
        let index = self.typing_worker.load(Ordering::SeqCst);
        if let Some(worker) = self.workers.get(index) {
            let _ = worker.sender.send(WorkerMessage::EndTyping);
        }
    }

    /// Select the target worker index for an event based on routing rules.
    fn select_worker(&mut self, event: &RawEvent) -> usize {
        match &event.event_type {
            // Typing: every keystroke and every value change goes to one
            // worker. Its FIFO queue then processes a value change after the
            // keystrokes that caused it, so the value change supersedes all of
            // them — spread over several workers, each would hold keystrokes
            // the value change's worker never sees.
            RawEventType::Keyboard | RawEventType::ValueChange => {
                let current = self.typing_worker.load(Ordering::SeqCst);
                if current != NO_TYPING_WORKER {
                    return current;
                }
                let idx = self.responsive_shortest_queue_worker();
                self.typing_worker.store(idx, Ordering::SeqCst);
                idx
            }
            // Focus: every focus event goes to one worker. A worker describes
            // the element focused when it gets to the event, which need not
            // be in the window the event named, and compares it with its last
            // focus; routed by window, two events of one focus change could
            // each be compared with a different last focus and both be
            // written (docent#735).
            RawEventType::Focus => {
                let current = self.focus_worker.load(Ordering::SeqCst);
                if current != NO_FOCUS_WORKER {
                    return current;
                }
                let idx = self.responsive_shortest_queue_worker();
                self.focus_worker.store(idx, Ordering::SeqCst);
                idx
            }
            // Sticky routing: consecutive selections in the same window go to
            // the same worker, which processes them in order.
            RawEventType::Selection => {
                let handle = event.window_handle;
                if let Some(&idx) = self.window_affinity.get(&handle) {
                    return idx;
                }
                let idx = self.shortest_queue_worker();
                self.window_affinity.insert(handle, idx);
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
            // Double-click pairing: the second click of a double-click reaches
            // the worker that processed the first, whose FIFO queue then
            // handles the pair in order.
            RawEventType::Click => {
                let idx = match self.last_click_worker {
                    Some(idx) if completes_double_click(event) => idx,
                    _ => self.shortest_queue_worker(),
                };
                self.last_click_worker = Some(idx);
                idx
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
    /// Joins the old thread (if any), **drains the dead worker's held buffers
    /// into the action stream** (completed actions are sacred — a worker dying
    /// with a buffered scroll/type/key sequence must not take it down with the
    /// respawn), creates a fresh channel and queue counter, calls the stored
    /// spawn closure, and swaps the new handle into the workers vec (updating
    /// the [`PendingDirectory`] slot in the same step). The respawned worker
    /// participates in dispatch immediately.
    fn respawn_worker(&mut self, index: usize) {
        // Join the old thread to clean up resources.
        if let Some(worker) = self.workers.get_mut(index) {
            if let Some(handle) = worker.thread.take() {
                let _ = handle.join(); // Ignore panic payload.
            }
        }

        // Drain the dead worker's held buffers before its handle is replaced —
        // the completed actions it buffered would otherwise be dropped with the
        // old `PendingBuffers`. Idempotent like every drain: if the worker
        // flushed before dying, this finds the buffers empty.
        if let Some(worker) = self.workers.get(index) {
            lock_buffers(&worker.pending).drain_into(&self.action_sender);
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

        // Keep the drain directory pointing at the LIVE buffers: a fallback
        // drain against the old handle would empty a dropped buffer and miss
        // the replacement's.
        match self.pending_directory.lock() {
            Ok(mut dir) => {
                if let Some(slot) = dir.get_mut(index) {
                    *slot = Arc::clone(&pending);
                }
            }
            Err(poisoned) => {
                if let Some(slot) = poisoned.into_inner().get_mut(index) {
                    *slot = Arc::clone(&pending);
                }
            }
        }

        self.workers[index] = WorkerHandle {
            sender: tx,
            queue_len,
            thread: Some(thread),
            pending,
        };

        // Clear sticky affinity entries that pointed to the dead worker.
        self.window_affinity.retain(|_, &mut v| v != index);

        // The typing and focus workers keep their index: the replacement is
        // installed at that index, so keyboard and value-change events stay
        // together, and so do focus events. The
        // replacement has missed no barrier.
        if index < 64 {
            self.missed_last_barrier
                .fetch_and(!(1 << index), Ordering::SeqCst);
        }

        // Clear drag worker if it was the dead one.
        if self.last_drag_worker == Some(index) {
            self.last_drag_worker = None;
        }
    }

    /// Signal all workers to shut down and wait (bounded) for their threads.
    ///
    /// Sends `WorkerMessage::Shutdown` to each worker, then waits up to
    /// `WORKER_SHUTDOWN_TIMEOUT` for **all** threads to finish. Any worker
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
                // A worker that exited through its own Shutdown arm drained on
                // the way out — but a worker that DIED (panic outside the
                // per-event guard, failed init) never did, and its held
                // completed actions are as sacred as a wedged worker's. Drain
                // here too; like every drain this is idempotent, so the normal
                // exit path just finds the buffers empty.
                match worker.pending.lock() {
                    Ok(mut buffers) => buffers.drain_into(&action_sender),
                    Err(poisoned) => poisoned.into_inner().drain_into(&action_sender),
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

    /// Flush every live worker's completed-but-held buffers mid-capture — the
    /// step-commit flush barrier (docent#298) — and wait, bounded by `timeout`,
    /// for all to acknowledge; then emit a [`ActionPayload::BarrierComplete`]
    /// sentinel carrying `barrier_id` as the **last** action on the stream so the
    /// frontend can confirm delivery of every drained action before it collects
    /// the step. Unlike [`shutdown`](Self::shutdown) the workers keep running and
    /// no thread is ever detached — this is a non-terminating drain.
    ///
    /// A worker that does not acknowledge within `timeout` — genuinely wedged in
    /// an unresponsive accessibility call, or already dead — has its shared
    /// buffers rescued in place here (locked and drained, poison-tolerant), so no
    /// completed action is lost. `drain_into` is idempotent, so if the worker
    /// later wakes and processes its own `Flush` marker it finds the buffers
    /// empty. Returns the indices of the workers that had to be rescued — the
    /// "unresolved workers" report. Sequence ids are deliberately **not** tracked:
    /// a coalesced type action carries only its last id and a scroll carries none,
    /// so per-id accounting could be neither complete nor correct.
    pub fn flush_all(&self, barrier_id: u64, timeout: Duration) -> Vec<usize> {
        let (ack_tx, ack_rx) = mpsc::channel::<usize>();

        // Fan the flush marker to every worker. A send that fails means the
        // worker thread is gone (panicked, dropped its receiver): rescue its
        // buffers directly rather than waiting for an ack that will never come.
        let mut expected: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut rescue: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for (i, worker) in self.workers.iter().enumerate() {
            match worker.sender.send(WorkerMessage::Flush(ack_tx.clone())) {
                Ok(()) => {
                    expected.insert(i);
                }
                Err(_) => {
                    rescue.insert(i);
                }
            }
        }
        // Drop our own handle so a still-buffered clone in a wedged worker's queue
        // is the only thing left holding the channel open; we bound the wait
        // explicitly below regardless of disconnection.
        drop(ack_tx);

        // Bounded wait for acknowledgements against a single shared deadline (not
        // per-worker), so total commit latency cannot exceed `timeout`.
        let deadline = Instant::now() + timeout;
        let mut acked: std::collections::HashSet<usize> = std::collections::HashSet::new();
        while acked.len() < expected.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match ack_rx.recv_timeout(remaining) {
                Ok(idx) => {
                    acked.insert(idx);
                }
                Err(_) => break,
            }
        }

        // Rescue any worker that did not acknowledge in time (wedged) as well as
        // any already-dead worker. The worker never holds `pending` across a
        // platform accessibility call (see PendingBuffers locking discipline), so
        // a wedged worker holds no lock here and this always succeeds.
        for &i in expected.difference(&acked) {
            rescue.insert(i);
        }
        for &i in &rescue {
            if let Some(worker) = self.workers.get(i) {
                match worker.pending.lock() {
                    Ok(mut buffers) => buffers.drain_into(&self.action_sender),
                    Err(poisoned) => poisoned.into_inner().drain_into(&self.action_sender),
                }
            }
        }

        // Emit the completion sentinel LAST. Each acknowledging worker sent its
        // drained actions before it acked (drain_into runs before ack.send in the
        // Flush arm), we waited for every ack, and the in-place rescues above ran
        // before this send — so on the single MPSC action channel this sentinel is
        // enqueued after every action belonging to the step.
        emit_barrier_sentinel(&self.action_sender, barrier_id);

        // A typing worker that did not answer gives the role up: the next
        // keyboard or value-change event chooses again, among the workers that
        // did answer. What the unanswered worker still has queued stays on it.
        let missed = rescue
            .iter()
            .filter(|i| **i < 64)
            .fold(0u64, |mask, i| mask | (1 << i));
        self.missed_last_barrier.store(missed, Ordering::SeqCst);
        let typing = self.typing_worker.load(Ordering::SeqCst);
        if rescue.contains(&typing) {
            self.typing_worker.store(NO_TYPING_WORKER, Ordering::SeqCst);
        }
        // The focus worker likewise, so focus events after this commit do not
        // wait behind a wedged accessibility call.
        let focus = self.focus_worker.load(Ordering::SeqCst);
        if rescue.contains(&focus) {
            self.focus_worker.store(NO_FOCUS_WORKER, Ordering::SeqCst);
        }

        let mut rescued: Vec<usize> = rescue.into_iter().collect();
        rescued.sort_unstable();
        rescued
    }

    /// The shortest-queue worker among those that answered the most recent
    /// flush barrier, or among all workers when none did.
    fn responsive_shortest_queue_worker(&self) -> usize {
        let missed = self.missed_last_barrier.load(Ordering::SeqCst);
        let unresponsive: std::collections::HashSet<usize> = (0..self.workers.len())
            .filter(|i| *i < 64 && missed & (1 << i) != 0)
            .collect();
        self.pick_worker_excluding(&unresponsive)
            .unwrap_or_else(|| self.shortest_queue_worker())
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

    /// Query the currently focused element together with the top-level window
    /// it is in, both read in one description; the window is `0` when the
    /// description resolved none. A focus action is recorded under the
    /// context of that window (DCP-7).
    fn focused_element_in_window(&self) -> Option<(ElementDescription, i64)> {
        self.focused_element().map(|element| (element, 0))
    }

    /// The current focus epoch: the Input_Thread's count of focus changes,
    /// in the two halves [`RawEvent::focus_epoch`] describes (not one plain
    /// number: compare for equality, or with `person_moved_focus_between`).
    /// An event carries the epoch of its dispatch; while the two are equal,
    /// no focus change has been seen since the event. A platform that does
    /// not count focus changes returns `0` always.
    fn focus_epoch(&self) -> u64 {
        0
    }

    /// The number of the latest focus event the Input_Thread dispatched,
    /// counted from 1; each focus event carries its own number
    /// ([`RawEvent::callback_params`]). While the two are equal, no later
    /// focus event has been dispatched, so no later event records the focus.
    /// A platform that does not number its focus events returns `0` always.
    fn focus_events_dispatched(&self) -> u64 {
        0
    }

    /// Whether `window_handle`'s top-level window is the foreground window
    /// right now. The focused element belongs to the foreground window, so an
    /// event's window that is no longer in front (closed, or left for another
    /// window) is not where the focused element is.
    fn is_foreground_window(&self, _window_handle: i64) -> bool {
        true
    }

    /// Describe the focused element and mark it: the element
    /// [`focused_is_marked`](Self::focused_is_marked) compares against until
    /// the next call. The typing worker describes keystrokes and value
    /// changes through this.
    fn focused_element_marked(&self) -> Option<ElementDescription> {
        self.focused_element()
    }

    /// Whether the element focused right now is the one last marked by
    /// [`focused_element_marked`](Self::focused_element_marked): the same
    /// element, not an equal description. A check of identity only, far
    /// cheaper than a description. `None` when the platform cannot tell.
    fn focused_is_marked(&self) -> Option<bool> {
        None
    }

    /// The window handle of the control that holds the keyboard focus right
    /// now, `0` when there is none or the platform has no such handle. A cheap
    /// read of the window system's own state, no accessibility call.
    fn focused_control(&self) -> i64 {
        0
    }

    /// What the control with window handle `control` is right now (see
    /// [`ControlNature`]): the part of [`describe_control`](Self::describe_control)
    /// that can change while the control lives, without the description.
    fn control_nature(&self, _control: i64) -> ControlNature {
        ControlNature::Gone
    }

    /// Look at the control with window handle `control` (see [`ControlLook`]).
    fn describe_control(&self, _control: i64) -> ControlLook {
        ControlLook::Gone
    }

    /// The value the control with window handle `control` holds right now;
    /// `None` when the control is gone or gives none.
    fn control_value(&self, _control: i64) -> Option<String> {
        None
    }

    /// Get the window title for a window handle.
    fn window_title(&self, window_handle: i64) -> String;

    /// Get the process name for a window handle.
    fn process_name(&self, window_handle: i64) -> String;

    /// The name [`process_name`](Self::process_name) gives a window of the
    /// process `process_id`, read from the process itself, so it names the
    /// process after the window has closed; `None` where the platform cannot
    /// name a process by its id.
    fn process_name_of(&self, _process_id: u32) -> Option<String> {
        None
    }

    /// Read a file dialog path from the given window: the dialog itself or
    /// any window inside it (a click names the control under the pointer).
    /// Returns `(dialog_type, file_path)`, `file_path` being the directory the
    /// dialog shows and its File name text joined with a backslash, or the
    /// text alone when it is a full path or the directory could not be read;
    /// `None` if the window is not in a file dialog or its File name box is
    /// empty or could not be read.
    fn read_file_dialog_path(&self, window_handle: i64) -> Option<(String, String)>;

    /// The file on disk that `shown_path` (a [`read_file_dialog_path`]
    /// path: the File name text as the dialog shows it, in the dialog's
    /// folder) names, decided by [`element_mapping::chosen_file_on_disk`]
    /// against the names the shell displays for the folder's files; `None`
    /// when the text names no file or several, or `shown_path` is not a full
    /// path. The worker asks it for an Open dialog only (DCP-13).
    ///
    /// [`read_file_dialog_path`]: Self::read_file_dialog_path
    /// [`element_mapping::chosen_file_on_disk`]: super::element_mapping::chosen_file_on_disk
    fn file_on_disk(&self, _shown_path: &str) -> Option<String> {
        None
    }

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

/// What a control is at one moment, as far as the recording of its keys
/// depends on it. A field can become a password field and a window can come
/// to hold focusable elements without anything else about it changing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlNature {
    /// It can hold the keyboard focus only itself; `password` is whether it
    /// is a password field.
    Own { password: bool },
    /// It holds other elements that can take the focus.
    Shared,
    /// It is gone, or could not be looked at.
    Gone,
}

/// What [`AccessibilityBackend::describe_control`] found behind a control's
/// window handle.
#[derive(Debug, Clone)]
pub enum ControlLook {
    /// The control can hold the keyboard focus only itself (an edit field with
    /// a window of its own): a key pressed while the handle held the focus
    /// went to this element.
    Own(Box<ElementDescription>),
    /// The window holds other elements that can take the focus (a browser's
    /// page, a canvas of controls): the handle does not say which of them a
    /// key went to.
    Shared,
    /// The window is gone, or could not be looked at.
    Gone,
}

// ---------------------------------------------------------------------------
// PendingTypeEvent
// ---------------------------------------------------------------------------

/// The `type` of the field being typed into, held until the typing in it
/// ends.
///
/// Each keystroke in a text field produces a `ValueChange` event. The worker
/// writes no `type` per keystroke: it holds one for the field, carries it
/// forward to each new value, and writes it when the typing ends (see
/// [`ends_typing`] and the key handler). A pause between two keys ends
/// nothing.
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
}

use super::timing::{debounce_elapsed, KEY_TEXT_WAIT_MS, WORKER_RECV_TIMEOUT as RECV_TIMEOUT};

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

/// Stamp the observed input→describe latency (docent#220) on a description
/// built at worker-dequeue time, relative to the raw event whose timestamp
/// the resulting action exports. Both clocks share the Unix-ms base
/// (`current_timestamp_ms` here and in the hook), so the difference is the
/// real gap between the input and the moment the description was captured.
fn stamp_described_after(element: &mut ElementDescription, raw_timestamp: u64) {
    element.described_after_ms = Some(current_timestamp_ms().saturating_sub(raw_timestamp));
}

/// Clear element-identity claims from a description emitted in coordinate
/// mode (docent#220): coordinate mode records where the user acted, not which
/// element the accessibility layer resolved there — the schema documents
/// locators (and the describe-latency fact) as absent in that mode.
fn strip_identity_claims(element: &mut ElementDescription) {
    element.locators = Vec::new();
    element.position_in_set = None;
    element.size_of_set = None;
    element.level = None;
    element.framework_id = None;
    element.language = None;
    element.described_after_ms = None;
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
/// Returns an empty string for the left/right Shift, Control and Alt codes
/// (`0xA0`–`0xA5`), signalling the caller to skip the event; the generic
/// Shift, Control and Alt codes (`0x10`–`0x12`) map to their names, and both
/// Win keys (`0x5B`, `0x5C`) to `Meta`.
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
        _ => format!("VK_{vk:#04X}"),
    }
}

/// `VK_PACKET`: the virtual-key code a keystroke injected as Unicode
/// (`SendInput` with `KEYEVENTF_UNICODE` — IME results, remote-desktop stacks,
/// software keyboards, automation) reaches the low-level hook with. Its scan
/// code carries the injected UTF-16 code unit, which the hook passes on in
/// `RawEvent::callback_params[0]` (docent#260).
pub(crate) const VK_PACKET: u32 = 0xE7;

/// The key value for a key whose identity is not known — the browser's own
/// value for that case, so the desktop names it the way the extension would.
const UNIDENTIFIED_KEY: &str = "Unidentified";

/// Name a keyboard event's key. A `VK_PACKET` keystroke is named by the
/// character its code unit carries — a space by `Space`, the name a layout
/// space key gets — and a unit that is no character on its own (a surrogate
/// half of a character outside the Basic Multilingual Plane, or a control
/// character) is `Unidentified`. A punctuation key is named by its layout's
/// character ([`punctuation_key_name`]). Every other code goes through
/// [`vk_to_key_name`].
fn key_name(raw: &RawEvent) -> String {
    key_name_of(
        raw.key_code,
        raw.callback_params[0],
        super::held_keys::layout_char_of(raw.callback_params[3]),
    )
}

/// [`key_name`] for a key by its code, its scan code and the layout character
/// the keyboard hook read for it (`callback_params[0]` and `[3]`).
fn key_name_of(key_code: u32, scan_code: i64, layout_char: u32) -> String {
    if is_punctuation_key(key_code) {
        return punctuation_key_name(key_code, i64::from(layout_char));
    }
    if key_code != VK_PACKET {
        return vk_to_key_name(key_code);
    }
    let unit = (scan_code & 0xFFFF) as u32;
    match char::from_u32(unit) {
        Some(' ') => vk_to_key_name(0x20),
        Some(c) if !c.is_control() => c.to_string(),
        _ => UNIDENTIFIED_KEY.to_string(),
    }
}

/// Whether a virtual-key code is a punctuation key: one of the OEM codes
/// (`0xBA`-`0xC2`, `0xDB`-`0xDF`, `0xE1`-`0xE4`, `0xE6`), whose character each
/// keyboard layout assigns for itself. Called on the keyboard hook: no
/// allocation, no lock.
pub(crate) const fn is_punctuation_key(vk: u32) -> bool {
    matches!(vk, 0xBA..=0xC2 | 0xDB..=0xDF | 0xE1..=0xE4 | 0xE6)
}

/// The markers the keyboard layout tables write in place of a character:
/// `WCH_NONE` `0xF000`, `WCH_DEAD` `0xF001` and `WCH_LGTR` `0xF002`, the
/// documented ones. A value among them names no character a key enters; any
/// other private-use value is a character the layout gives the key.
const LAYOUT_TABLE_MARKERS: std::ops::RangeInclusive<char> = '\u{F000}'..='\u{F002}';

/// Name a punctuation key by `layout_char`, the value the keyboard hook read
/// for it from the keyboard layout of the foreground window's thread: the
/// character the key enters with no modifier in the low 16 bits, and the
/// dead-key flag in bit 31, which the name leaves out (a dead key is named by
/// the accent it carries). A letter is named in its upper case, as the letter
/// keys are, where that is one character; a space is `Space`; a value that is
/// no character (0 where the layout gives the key none or no layout was read,
/// a control character, a surrogate half, or one of the layout tables' own
/// markers `0xF000`-`0xF002`) leaves the key to its code's name, `VK_0x..`.
pub(crate) fn punctuation_key_name(vk: u32, layout_char: i64) -> String {
    match char::from_u32((layout_char & 0xFFFF) as u32) {
        Some(' ') => vk_to_key_name(0x20),
        Some(c) if !c.is_control() && !LAYOUT_TABLE_MARKERS.contains(&c) => {
            let mut upper = c.to_uppercase();
            match (upper.next(), upper.next()) {
                (Some(u), None) => u.to_string(),
                _ => c.to_string(),
            }
        }
        _ => vk_to_key_name(vk),
    }
}

/// The modifier keys held at a raw event, as its action states them.
fn modifiers_of(raw: &RawEvent) -> Modifiers {
    Modifiers {
        ctrl: raw.modifiers.0,
        shift: raw.modifiers.1,
        alt: raw.modifiers.2,
        meta: raw.modifiers.3,
    }
}

/// The keys that were down at a raw event, as its action states them.
///
/// Each key is named as its own `key` action names it. The hook's record
/// lists no modifier key, so every key here has such a name.
fn held_at(raw: &RawEvent) -> HeldKeysAtAction {
    let (held_keys, held_presses) = raw
        .held
        .iter()
        .map(|k| {
            (
                key_name_of(k.key_code, i64::from(k.scan_code), k.layout_char),
                k.press,
            )
        })
        .unzip();
    HeldKeysAtAction {
        held_keys,
        held_presses,
    }
}

/// Whether a key name is the empty name `vk_to_key_name` returns for the
/// left/right Shift, Control and Alt codes: `true` means skip the event.
/// Printable characters are handled separately via the pending_keys buffer.
fn is_modifier_only_key(key: &str) -> bool {
    key.is_empty()
}

/// Determine whether a keystroke is printable input (should be buffered, not
/// emitted immediately): a typing key (see [`is_typing_key_code`]) pressed with
/// no modifier or as a character of its layout. Ctrl and Alt held together is
/// AltGr, which enters a character; Ctrl, Alt or Meta held otherwise is a
/// shortcut.
fn is_printable_key(raw: &RawEvent) -> bool {
    let (ctrl, _shift, alt, meta) = raw.modifiers;
    is_typing_key_code(raw.key_code) && !meta && ctrl == alt
}

/// Whether a virtual-key code is a typing key's: one that enters a character
/// on some layout. A closed table: the space bar, digits, letters, the numeric
/// keypad (digits, operators, decimal and separator; with NumLock off the
/// keypad sends the navigation keys' own codes instead), punctuation (the OEM
/// keys of every layout: 0xBA-0xC2, 0xDB-0xDF, 0xE1-0xE4, 0xE6) and
/// `VK_PACKET`. Called on the keyboard hook: no allocation, no lock.
pub const fn is_typing_key_code(key_code: u32) -> bool {
    matches!(
        key_code,
        0x20 | 0x30..=0x39
            | 0x41..=0x5A
            | 0x60..=0x6F
            | 0xBA..=0xC2
            | 0xDB..=0xDF
            | 0xE1..=0xE4
            | 0xE6
            | VK_PACKET
    )
}

/// The control types that take no typed text: a key pressed on one presses,
/// toggles or opens it, and no value change makes that key text. A closed
/// list of the accessibility control types a platform backend names (see the
/// backend's control-type table); every other type may take text, and a value
/// change decides. The adapter's sensitive-field rule keeps the same list
/// (`packages/desktop/src/adapter-tauri.js`).
const NON_TEXT_CONTROL_TAGS: &[&str] = &[
    "Button",
    "CheckBox",
    "Hyperlink",
    "MenuItem",
    "RadioButton",
    "SplitButton",
    "TabItem",
];

/// Whether `element` is a control that takes no typed text (see
/// [`NON_TEXT_CONTROL_TAGS`]).
fn takes_no_typed_text(element: &ElementDescription) -> bool {
    NON_TEXT_CONTROL_TAGS.contains(&element.tag.as_str())
}

/// One step of the person's half of the focus epoch (see
/// [`RawEvent::focus_epoch`]).
pub const FOCUS_EPOCH_PERSON_STEP: u64 = 1 << 32;

/// Whether the person did something that can move the focus between the
/// dispatch of `raw` and the moment `epoch_now` was read: a mouse-down or a
/// focus-moving key other than `raw` itself (a focus-moving key starts the
/// next count right behind its own dispatch).
fn person_moved_focus_between(raw: &RawEvent, epoch_now: u64) -> bool {
    let own_step = if matches!(raw.event_type, RawEventType::Keyboard)
        && key_may_move_focus(raw.key_code, raw.modifiers)
    {
        FOCUS_EPOCH_PERSON_STEP
    } else {
        0
    };
    // The key's own step may or may not have been counted yet when the epoch
    // was read; either reading is the key's own.
    let now = epoch_now >> 32;
    now != raw.focus_epoch >> 32 && now != raw.focus_epoch.wrapping_add(own_step) >> 32
}

/// Whether a keydown can move the focus by itself: every key but the plain
/// typing keys. Tab, Enter, Escape, the arrows, a shortcut or a key this table
/// does not know may leave another element focused; a letter, a digit, the
/// space bar, punctuation and the numeric keypad type into the focused one
/// (AltGr, which is Ctrl+Alt, included), and Shift, Control and the lock keys
/// do nothing alone. Alt alone opens a menu when it is released, so it counts,
/// except as the Alt of AltGr (Control is down by then). The typing keys are a
/// closed table of the virtual-key codes that enter a character on some
/// layout. The Input_Thread counts a key that can move the focus in the
/// person's half of the focus epoch, right behind the key's own dispatch.
/// Called on the keyboard hook: no allocation, no lock.
pub fn key_may_move_focus(key_code: u32, modifiers: (bool, bool, bool, bool)) -> bool {
    let (ctrl, _shift, alt, meta) = modifiers;
    match key_code {
        // Shift, Control (generic and left/right), CapsLock, NumLock,
        // ScrollLock.
        0x10 | 0x11 | 0xA0..=0xA3 | 0x14 | 0x90 | 0x91 => false,
        // Alt (generic and left/right).
        0x12 | 0xA4 | 0xA5 => !ctrl,
        // A typing key moves the focus only as a shortcut.
        code if is_typing_key_code(code) => meta || ctrl != alt,
        _ => true,
    }
}

/// Whether the keyboard hook marked this key-down as one that key repeat
/// generated while the key was held down (the repeat mark in the fourth
/// callback parameter, [`super::held_keys::KEY_REPEAT_PARAM`]; see
/// [`RawEvent::callback_params`]).
fn is_repeat(raw: &RawEvent) -> bool {
    raw.callback_params[3] & super::held_keys::KEY_REPEAT_PARAM != 0
}

/// The physical key of a keystroke, by its W3C UI Events `code` value, from the
/// hook's scan code and extended mark (the first callback parameter; see
/// [`RawEvent::callback_params`]). An injected character has none: what it
/// carries in the scan code's place is its code unit.
fn physical_key_of(raw: &RawEvent) -> Option<&'static str> {
    if raw.key_code == VK_PACKET {
        return None;
    }
    let params = raw.callback_params[0];
    // The low half is the hook's scan code, a 32-bit value.
    physical_key_code(params as u32, params & KEY_EXTENDED_PARAM != 0)
}

/// The key names that enter no character: editing, navigation, lock, system
/// and modifier keys. The function keys (`F1` to `F24`) join them by their
/// form. The adapter's sensitive-field rule keeps the same list
/// (`packages/desktop/src/adapter-tauri.js`).
const NON_TEXT_KEY_NAMES: &[&str] = &[
    "Backspace",
    "Tab",
    "Enter",
    "Shift",
    "Control",
    "Alt",
    "Pause",
    "CapsLock",
    "Escape",
    "PageUp",
    "PageDown",
    "End",
    "Home",
    "ArrowLeft",
    "ArrowUp",
    "ArrowRight",
    "ArrowDown",
    "PrintScreen",
    "Insert",
    "Delete",
    "Meta",
    "NumLock",
    "ScrollLock",
];

/// Whether a key name is a function key's: `F` and a number.
fn is_function_key_name(key: &str) -> bool {
    key.strip_prefix('F')
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Whether a keystroke into a password field enters text there, and so
/// belongs to the field's masked type: every key except the ones known to
/// enter no character and the shortcuts. The test is closed on the keys that
/// stay keys, so a key the name table does not know (a layout's extra key, a
/// keypad separator) counts as text and is masked. Ctrl and Alt held together
/// is AltGr, which enters a character; Ctrl, Alt or Meta held otherwise is a
/// shortcut.
fn enters_text_in_password_field(raw: &RawEvent, key: &str) -> bool {
    let (ctrl, _shift, alt, meta) = raw.modifiers;
    if meta || (ctrl != alt) {
        return false;
    }
    !NON_TEXT_KEY_NAMES.contains(&key) && !is_function_key_name(key)
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
/// - Worker event processing
/// - Type coalescing
/// - Existing behavior preservation
/// - Worker failure handling (coordinate fallback)
/// - Platform-agnostic coalescing/dedup
// The `ready` signal plus the existing routing/coalescing dependencies push this
// one past clippy's 7-arg threshold; they are cohesive worker wiring (channels,
// counters, shared buffers), not worth a params struct for an internal fn.
#[allow(clippy::too_many_arguments)]
pub fn worker_loop<B: AccessibilityBackend>(
    worker_index: usize,
    mut backend: B,
    receiver: mpsc::Receiver<WorkerMessage>,
    queue_len: Arc<AtomicU64>,
    action_sender: mpsc::Sender<ActionEvent>,
    excluded_pid: Arc<AtomicU32>,
    pending: SharedPendingBuffers,
    ready: Option<mpsc::Sender<()>>,
) {
    let init_result = backend.init();
    // Signal that this worker has finished its (possibly cold) init phase so
    // WindowsCapture::start() can return only once every worker is past its
    // first UIA/COM instantiation and able to consume events. Without this, an
    // event dispatched during a multi-second cold init on a fresh/headless
    // machine sits unconsumed in the worker's queue and is silently dropped on a
    // fast stop() (the shutdown detach path does not drain the queue). Signal
    // regardless of success — a worker whose init failed has still finished
    // initialising (it is respawned on the next dispatch); start() must never
    // block waiting on it.
    if let Some(ready) = &ready {
        let _ = ready.send(());
    }
    if let Err(e) = init_result {
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
            Ok(WorkerMessage::Flush(ack)) => {
                // Commit flush barrier (docent#298): drain the completed-but-held
                // buffers into the action stream, then acknowledge — but do NOT
                // break, unlike Shutdown. Because a worker's channel is FIFO, this
                // marker is processed only after every event dispatched to this
                // worker before it, so the drain captures the whole step. Holds the
                // lock only for the in-memory drain — no backend calls inside.
                lock_buffers(&pending).drain_into(&action_sender);
                let _ = ack.send(worker_index);
            }
            Ok(WorkerMessage::EndTyping) => {
                // In-memory buffer mutation only — no backend calls inside.
                lock_buffers(&pending).flush_pending_type_only(&action_sender);
            }
            Ok(WorkerMessage::Shutdown) => {
                // Drain remaining events in the queue. A message that is no
                // event does not end the drain: the events behind it are the
                // person's too.
                while let Ok(message) = receiver.try_recv() {
                    match message {
                        WorkerMessage::Event(raw) => {
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
                        WorkerMessage::EndTyping => {
                            lock_buffers(&pending).flush_pending_type_only(&action_sender);
                        }
                        WorkerMessage::Flush(ack) => {
                            lock_buffers(&pending).drain_into(&action_sender);
                            let _ = ack.send(worker_index);
                        }
                        WorkerMessage::Shutdown => {}
                    }
                }
                // Flush all buffered (completed) actions. Holds the lock only
                // for the in-memory drain — no backend calls inside.
                lock_buffers(&pending).drain_into(&action_sender);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Periodic flush for the scroll debounce and for typing keys
                // that got no value change.
                let now = current_timestamp_ms();
                let mut buffers = lock_buffers(&pending);
                if let Some(result) = buffers.scroll_acc.try_flush(now) {
                    let _ = action_sender.send(ActionEvent {
                        timestamp: now,
                        context_id: None,
                        capture_mode: CaptureMode::Accessibility,
                        frame_src: None,
                        window_rect: None,
                        preferred_languages: preferred_languages(),
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
                write_keys_that_took_no_text(&mut buffers, now, &action_sender);
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
    /// The focus last written: its context and its element's selector.
    last_focus: Option<(Option<i64>, String)>,
    /// The value of the field typed into last, as last taken for its `type`.
    last_value: Option<LastValue>,
    last_drag_element: Option<ElementDescription>,
    /// The file the last click selected in a file dialog's item view, read
    /// from the dialog at that click, for the click that completes a
    /// double-click on it (DCP-6). Taken by every click.
    file_pick: Option<FilePick>,
    /// The element last described for a keystroke or value change while focus
    /// was known not to have moved since that event (see [`TypingFocus`]).
    typing_focus: Option<TypingFocus>,
    /// Counts the typing descriptions made (each marks its element on the
    /// backend), so an element knows whether it is still the marked one.
    mark_seq: u64,
    /// The element the last keystroke was recorded on, per window.
    last_key: Option<LastKey>,
    /// What is known of the controls keys were pressed in, by window handle
    /// (see [`KnownControl`]).
    controls: HashMap<i64, KnownControl>,
}

impl WorkerState {
    fn new() -> Self {
        Self {
            last_focus: None,
            last_value: None,
            last_drag_element: None,
            file_pick: None,
            typing_focus: None,
            mark_seq: 0,
            last_key: None,
            controls: HashMap::new(),
        }
    }
}

/// The focused element of one window under one focus epoch.
///
/// A keystroke or value change is described by asking for the focused element
/// when a worker gets to it, which can be after focus has moved on. The
/// Input_Thread stamps every event with the focus epoch of its dispatch, so
/// events with equal epochs in one window share their focused element: once
/// one of them is described while the epoch still stands, the description
/// holds for the others whenever they are processed.
struct TypingFocus {
    context_id: Option<i64>,
    epoch: u64,
    element: ElementDescription,
    /// `WorkerState::mark_seq` of the description that produced `element`.
    mark: u64,
}

/// The element the last keystroke of a window was recorded on. A value change
/// is the `type` of the element its keystrokes went to, so it is checked
/// against this.
struct LastKey {
    context_id: Option<i64>,
    /// Empty when the key named no element.
    selector: String,
    /// The element's place under its window (see [`same_field`]), where the
    /// description knew it.
    place: Option<String>,
    /// `WorkerState::mark_seq` of the description the element came from;
    /// `None` when the key named no element, or was recorded on its control.
    mark: Option<u64>,
    /// The window handle of the control the key was recorded on (see
    /// [`settle_key_on_its_control`]); `0` when it was described by focus.
    control: i64,
}

/// A control keys were pressed in: a window handle that held the keyboard
/// focus when the Input_Thread read it on the keyboard hook.
///
/// A window handle names one control for as long as the control lives, so a
/// description made once holds for every key stamped with the handle, however
/// late a worker gets to it, and the control's value can be read from the
/// control itself.
struct KnownControl {
    /// The control's description; `None` for a window that holds other
    /// focusable elements, whose keys are described by focus.
    element: Option<ElementDescription>,
    /// The focus epoch of the keystroke the control was last looked at for
    /// (see [`settle_key_on_its_control`]).
    epoch: u64,
    /// The keystroke's part-focus number at that look (see [`key_part_focus`]).
    part_focus: i64,
    /// The title of the control's top-level window when it was described: a
    /// description names its window, so a changed title means describing the
    /// control again.
    title: String,
}

/// More controls than a person types into between two commits; past it the
/// table starts over, and each control is described again at its next key.
const KNOWN_CONTROLS_MAX: usize = 64;

/// `OBJID_CLIENT`: the object id of a window's own client area in a WinEvent.
const OBJECT_ID_CLIENT: i64 = -4;

/// The window handle of the control that held the keyboard focus when this
/// key was pressed, as the Input_Thread read it on the keyboard hook
/// (`callback_params[1]`); `0` when it read none.
fn key_control(raw: &RawEvent) -> i64 {
    if matches!(raw.event_type, RawEventType::Keyboard) {
        raw.callback_params[1]
    } else {
        0
    }
}

/// The number the Input_Thread gave this focus event among the focus events
/// it dispatched (`callback_params[2]`, see
/// [`AccessibilityBackend::focus_events_dispatched`]); `0` when not numbered.
fn focus_event_number(raw: &RawEvent) -> u64 {
    raw.callback_params[2] as u64
}

/// The number of the latest focus change that named a part of this key's
/// control, as the Input_Thread noted it when the key was pressed
/// (`callback_params[2]`, see [`PartFocusNote`]); `0` when there was none.
fn key_part_focus(raw: &RawEvent) -> i64 {
    raw.callback_params[2]
}

/// Whether a focus change a program reported names a part of a window rather
/// than the window as a whole. A window as a whole is named by its own object
/// (`OBJID_WINDOW`) or its client area (`OBJID_CLIENT`) with no child. A
/// control that holds the focus only itself reports itself that way; a window
/// that has come to hold focusable elements reports the one that took the
/// focus by another object or a child id.
pub fn focus_names_a_part(id_object: i64, id_child: i64) -> bool {
    const OBJECT_ID_WINDOW: i64 = 0;
    id_child != 0 || (id_object != OBJECT_ID_WINDOW && id_object != OBJECT_ID_CLIENT)
}

/// The Input_Thread's note of the focus changes that named a part of a
/// window (see [`focus_names_a_part`]), by window handle. Every such change
/// gets the next number, so a keystroke stamped with its control's number
/// tells a worker whether one happened since the worker last looked at the
/// control. A window that never had one answers `0`. A window pushed out by
/// newer ones answers the number of the latest change pushed out: its own
/// latest or a later one, so never a number a worker can have kept from
/// before the window's latest change (a kept `0` included). Kept and read on
/// the Input_Thread only: a short fixed scan, no allocation after the first
/// few changes.
#[derive(Debug, Default)]
pub struct PartFocusNote {
    last: i64,
    /// The number of the latest change pushed out of `windows`.
    pushed_out: i64,
    /// Oldest first.
    windows: Vec<(i64, i64)>,
}

impl PartFocusNote {
    /// How many windows are remembered.
    pub const WINDOWS: usize = 16;

    /// Note a focus change that named a part of `window`.
    pub fn add(&mut self, window: i64) {
        self.last += 1;
        self.windows.retain(|(w, _)| *w != window);
        if self.windows.len() >= Self::WINDOWS {
            // The oldest entry, and numbers only grow: the latest pushed out.
            self.pushed_out = self.windows.remove(0).1;
        }
        self.windows.push((window, self.last));
    }

    /// The number of the latest such change in `window`; for a window not
    /// remembered, the number of the latest change pushed out (`0` while
    /// none was).
    pub fn of(&self, window: i64) -> i64 {
        self.windows
            .iter()
            .find(|(w, _)| *w == window)
            .map_or(self.pushed_out, |(_, number)| *number)
    }
}

/// The Input_Thread's record of the contexts a capture session has
/// introduced, by top-level window handle (DCP-7). A raw event that is to be
/// dispatched in a window whose context the session has not introduced has a
/// `context_switch` into that window dispatched before it, so the context's
/// first action follows its establishment (core CP-17, session-format SF-10).
/// Beside it, the window of the last switch into the window in front, which a
/// foreground change into the same window does not repeat. Kept and read on
/// the Input_Thread only.
#[derive(Debug, Default)]
pub struct ContextIntroductions {
    introduced: std::collections::HashSet<i64>,
    last_switch: i64,
}

impl ContextIntroductions {
    /// A button press in `pressed_root` while `foreground_root` is in front:
    /// whether the press switches into another window, which it does when
    /// the two differ and [`activation_switches`](Self::activation_switches)
    /// writes it. Dispatched at the press, before the press itself, so the
    /// press finds the window introduced and the activation it causes is not
    /// written again.
    pub fn press_switches(&mut self, pressed_root: i64, foreground_root: i64) -> bool {
        pressed_root != foreground_root && self.activation_switches(pressed_root)
    }

    /// A foreground change into `root` that the Input_Thread is to dispatch
    /// as a `context_switch` (a correlated activation, or a click into
    /// another window): whether it is written, which it is unless the last
    /// switch into the window in front named `root` already. Notes `root` as
    /// that window when it is.
    pub fn activation_switches(&mut self, root: i64) -> bool {
        if root == self.last_switch {
            return false;
        }
        self.last_switch = root;
        true
    }

    /// Whether a `context_switch` into `root` is dispatched before `event`,
    /// whose window's top-level window is `root`; noting what `event`
    /// introduces.
    ///
    /// - A `context_switch` or `context_open` (a foreground or window-create
    ///   event) introduces its window and needs no switch; a close introduces
    ///   nothing.
    /// - A lone Shift, Ctrl or Alt press, which the worker drops (DCP-13),
    ///   and an event with no window, count for nothing.
    /// - Any other event is an action. One before any switch or open is in
    ///   the session's first context, which needs no introduction; one in a
    ///   window not introduced yet takes the switch, and the window is
    ///   introduced from then on.
    ///
    /// `foreground_root` is the top-level window in front when `event` is
    /// dispatched. A switch into it stands for its activation, which a late
    /// foreground change then does not repeat; a switch into any other window
    /// (an inactive window under a wheel or a drop) leaves the window in
    /// front's activation to be written when it comes.
    pub fn switch_before(&mut self, event: &RawEvent, root: i64, foreground_root: i64) -> bool {
        let switched = self.introduces(event, root);
        if switched && root == foreground_root {
            self.last_switch = root;
        }
        switched
    }

    fn introduces(&mut self, event: &RawEvent, root: i64) -> bool {
        if root == 0 {
            return false;
        }
        match event.event_type {
            RawEventType::Foreground | RawEventType::WindowCreate => {
                self.introduced.insert(root);
                false
            }
            RawEventType::WindowDestroy | RawEventType::MouseDown | RawEventType::MouseUp => false,
            RawEventType::Keyboard if is_modifier_only_key(&key_name(event)) => false,
            _ => {
                let first = self.introduced.is_empty();
                self.introduced.insert(root) && !first
            }
        }
    }
}

/// The window handle of the control a value change is about, when the control
/// reported it about itself (its own client object, not a child element and
/// not a scroll bar); `0` otherwise.
fn value_change_control(raw: &RawEvent) -> i64 {
    if matches!(raw.event_type, RawEventType::ValueChange)
        && raw.callback_params[0] == OBJECT_ID_CLIENT
        && raw.callback_params[1] == 0
    {
        raw.window_handle
    } else {
        0
    }
}

/// The element of the control a key was pressed in, where the key's handle
/// settles it; `None` where the key has to be described by focus.
///
/// The handle was read on the keyboard hook, at the key itself, so it does
/// not go stale while the key waits for a worker. It can be wrong in one way:
/// read before the program acted on what came just before the key. So:
///
/// - Under the person's count the control was last confirmed under, nothing
///   the person did can have moved the focus since: the handle stands. While
///   the present can still speak for the key (nothing counted since, its
///   window in front) and names another control, a program moved the focus
///   on its own and the key is described by focus. While no focus change
///   named a part of the control since it was last looked at, the key takes
///   the control's element with no call at all.
/// - A first key under a new count of the person's (a click, Tab, Backspace
///   came before it) is taken on its handle only when the present confirms
///   it: the person did nothing since that can move the focus, and the handle
///   holds the focus now. Otherwise it is described by focus, which names no
///   element once the person has moved on.
///
/// A control is described when it is first confirmed. What the control is (a
/// field of its own, a password field) is looked at again at the first key
/// under each later count of the person's, and at the first key after a
/// program reported a focus change that named a part of the control (a
/// window that came to hold a focusable element reports the one that took
/// the focus that way; see [`focus_names_a_part`]). Any other focus change a
/// program reports says nothing about the control and asks for no look: a
/// look waits on the program, and a key that waits while the person presses
/// Enter finds its dialog gone. A control that is gone at the second look
/// leaves the key to the description by focus, except a key that enters no
/// text under the person's count the control was last looked at under, which
/// stays on the control. The control is described again when what it is
/// changed, or, at a new count of the person's, when the title of its window
/// did (the description names the window).
fn settle_key_on_its_control<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    controls: &mut HashMap<i64, KnownControl>,
) -> Option<ElementDescription> {
    let control = key_control(raw);
    if control == 0 || raw.focus_epoch == 0 {
        return None;
    }
    let person = raw.focus_epoch >> 32;
    let epoch_now = backend.focus_epoch();
    let confirmed_under = controls.get(&control).map(|k| k.epoch);
    let same_person = confirmed_under.is_some_and(|epoch| epoch >> 32 == person);
    if same_person {
        let present_speaks =
            epoch_now == raw.focus_epoch && backend.is_foreground_window(raw.window_handle);
        if present_speaks && backend.focused_control() != control {
            return None;
        }
        // Nothing the person did, and no focus change that named a part of
        // the control, since it was last looked at: it is what it was. A
        // window that holds other elements is left to the description by
        // focus whatever was reported.
        if let Some(known) = controls.get(&control) {
            if known.element.is_none() || known.part_focus == key_part_focus(raw) {
                return known.element.clone();
            }
        }
    } else if person_moved_focus_between(raw, epoch_now) || backend.focused_control() != control {
        return None;
    }
    // The person did something since the control was last looked at (ticked
    // a box), or a program reported a focus change that named a part of it
    // (a page that finished loading and focused one of its fields). What the
    // control is may have changed with nothing else about it changing, so
    // that is looked at again, which needs no description. The description is
    // kept while the control is what it was and, at a new count of the
    // person's, its window is titled as it was.
    let title = if same_person {
        None
    } else {
        Some(backend.window_title(raw.window_handle))
    };
    if let Some(known) = controls
        .get_mut(&control)
        .filter(|k| title.as_ref().is_none_or(|t| *t == k.title))
    {
        let nature = match &known.element {
            Some(element) => ControlNature::Own {
                password: element.element_type.as_deref() == Some("password"),
            },
            None => ControlNature::Shared,
        };
        match backend.control_nature(control) {
            // The control closed before it could be looked at again. Under a
            // new count of the person's nothing is known of it. Under the
            // count it was last looked at under, the person did nothing in
            // between and the key was pressed in it: a key that enters no
            // text stays on it, since what the control had become cannot put
            // a character on record. A key that enters text does not: nothing
            // shows the control had not become a password field.
            ControlNature::Gone => {
                return if same_person && !enters_text_in_password_field(raw, &key_name(raw)) {
                    known.element.clone()
                } else {
                    None
                };
            }
            now if now == nature => {
                known.epoch = raw.focus_epoch;
                known.part_focus = key_part_focus(raw);
                return known.element.clone();
            }
            _ => {}
        }
    }
    let title = title.unwrap_or_else(|| backend.window_title(raw.window_handle));
    let element = match backend.describe_control(control) {
        ControlLook::Own(element) => Some(*element),
        ControlLook::Shared => None,
        ControlLook::Gone => return None,
    };
    if controls.len() >= KNOWN_CONTROLS_MAX {
        controls.clear();
    }
    controls.insert(
        control,
        KnownControl {
            element: element.clone(),
            epoch: raw.focus_epoch,
            part_focus: key_part_focus(raw),
            title,
        },
    );
    element
}

/// The element remembered for `raw`'s window and focus epoch, if any. Epoch
/// `0` (a platform that does not count focus changes) remembers nothing.
fn remembered_focus<'a>(
    typing_focus: &'a Option<TypingFocus>,
    raw: &RawEvent,
    context_id: Option<i64>,
) -> Option<&'a TypingFocus> {
    typing_focus.as_ref().filter(|f| {
        raw.focus_epoch != 0 && f.epoch == raw.focus_epoch && f.context_id == context_id
    })
}

/// What [`describe_focused_for`] found in the event's window.
struct FocusedNow {
    /// The focused element; `None` when the window gave none (the query
    /// failed or timed out).
    element: Option<ElementDescription>,
    /// No focus change at all was counted since the event's dispatch: the
    /// element is the event's.
    focus_stands: bool,
    /// The person clicked or pressed a focus-moving key since the event: the
    /// element is, as far as anyone can tell, not the event's.
    person_moved_focus: bool,
}

/// Describe the focused element for a keystroke or value change of
/// `raw.window_handle`, now, and mark it on the backend.
///
/// `None` when that window is not in front any more (it closed, or the person
/// left it): the focused element is then some other window's.
fn describe_focused_for<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    mark_seq: &mut u64,
) -> Option<FocusedNow> {
    let epoch_before = backend.focus_epoch();
    if !backend.is_foreground_window(raw.window_handle) {
        return None;
    }
    let element = backend.focused_element_marked();
    *mark_seq += 1;
    let epoch_after = backend.focus_epoch();
    if !backend.is_foreground_window(raw.window_handle) {
        return None;
    }
    let counted = raw.focus_epoch != 0;
    Some(FocusedNow {
        element,
        focus_stands: counted && epoch_before == raw.focus_epoch && epoch_after == raw.focus_epoch,
        person_moved_focus: counted && person_moved_focus_between(raw, epoch_after),
    })
}

/// The description of a keystroke whose element cannot be described: its
/// window's title as the name, no selector.
fn undescribed_element<B: AccessibilityBackend>(raw: &RawEvent, backend: &B) -> ElementDescription {
    ElementDescription {
        tag: "Unknown".to_string(),
        id: None,
        name: Some(backend.window_title(raw.window_handle)),
        role: None,
        element_type: None,
        text: None,
        selector: String::new(),
        ..Default::default()
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

    // The typing in a field has ended: its `type` goes out ahead of this
    // event's action. The dispatcher tells the typing worker the same when
    // the event is another worker's.
    if ends_typing(&raw.event_type) {
        lock_buffers(pending).flush_pending_type_only(action_sender);
    }

    match &raw.event_type {
        RawEventType::Click => {
            handle_click(
                raw,
                backend,
                action_sender,
                context_id,
                false,
                window_rect.clone(),
                &mut state.file_pick,
            );
        }
        RawEventType::RightClick => {
            handle_click(
                raw,
                backend,
                action_sender,
                context_id,
                true,
                window_rect.clone(),
                &mut state.file_pick,
            );
        }
        RawEventType::Focus => {
            handle_focus(
                raw,
                backend,
                action_sender,
                context_id,
                &mut state.last_focus,
                window_rect.clone(),
            );
        }
        RawEventType::ValueChange => {
            let described = handle_value_change(
                raw,
                backend,
                action_sender,
                context_id,
                pending,
                state,
                window_rect.clone(),
            );
            // A value change arrived — pending keys will be superseded by the
            // type event when it flushes. Clear them now. A value change whose
            // element could not be described supersedes nothing: the keys are
            // then the only record of the typing.
            if described {
                let mut buffers = lock_buffers(pending);
                buffers.pending_keys.clear();
                buffers.pending_keys_last_timestamp = 0;
            }
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
                state,
                window_rect.clone(),
            );
        }
        RawEventType::Foreground => {
            handle_foreground(raw, backend, action_sender, context_id, window_rect.clone());
        }
        RawEventType::WindowCreate => {
            // The executable path is the documented `source` for desktop
            // context lifecycle actions; `process_name` returns a `String`,
            // and an empty read is written as a `None` source below.
            let process = backend.process_name(raw.window_handle);
            let _ = action_sender.send(ActionEvent {
                timestamp: raw.timestamp,
                context_id,
                capture_mode: CaptureMode::Accessibility,
                frame_src: None,
                window_rect: window_rect.clone(),
                preferred_languages: preferred_languages(),
                sequence_id: Some(raw.sequence_id),
                payload: ActionPayload::ContextOpen {
                    // The pipeline does not observe which window caused this
                    // create — null is the honest value, never a self-reference.
                    opener_context_id: None,
                    source: if process.is_empty() {
                        None
                    } else {
                        Some(process)
                    },
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
                preferred_languages: preferred_languages(),
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
                    preferred_languages: preferred_languages(),
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

/// A file selected in a file dialog's item view, as the dialog showed it at
/// the click that selected it.
#[derive(Debug, Clone)]
struct FilePick {
    dialog_type: String,
    file_path: String,
    source: String,
    context_id: Option<i64>,
    window_rect: Option<WindowRect>,
}

/// The file a click in a file dialog's item view selected, read from the
/// dialog while it is open: the click landed on an item (its element is, or
/// sits inside, a `ListItem`), and the dialog's File name field holds that
/// item's name, which selecting a file puts there and selecting a folder does
/// not. `None` for any other click, and when the dialog cannot be read.
fn read_file_pick<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    element: &ElementDescription,
    context_id: Option<i64>,
    window_rect: &Option<WindowRect>,
) -> Option<FilePick> {
    // Only a click on a list item reads the dialog, so other clicks cost no
    // accessibility query here.
    let items: Vec<&str> = element
        .selector
        .split(" > ")
        .filter_map(|segment| segment.strip_prefix("ListItem:"))
        .collect();
    if items.is_empty() {
        return None;
    }
    let pick = read_file_dialog(raw, backend, context_id, window_rect)?;
    // `file_path` is the dialog's directory and File name joined with a
    // backslash, or the File name alone (the backend's read); `rsplit` always
    // yields a first piece.
    let file_name = pick.file_path.rsplit('\\').next()?;
    if file_name.is_empty() || !items.contains(&file_name) {
        return None;
    }
    Some(pick)
}

/// The file dialog `raw`'s window is in, as the backend reads it now, with the
/// opening application and the click's context: `None` when the window is in
/// no file dialog or no File name could be read.
fn read_file_dialog<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    context_id: Option<i64>,
    window_rect: &Option<WindowRect>,
) -> Option<FilePick> {
    let (dialog_type, file_path) = backend.read_file_dialog_path(raw.window_handle)?;
    Some(FilePick {
        dialog_type,
        file_path,
        source: backend.process_name(raw.window_handle),
        context_id,
        window_rect: window_rect.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
fn handle_click<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    is_right_click: bool,
    window_rect: Option<WindowRect>,
    file_pick: &mut Option<FilePick>,
) {
    // The pick belongs to the click just before this one (the pool routes a
    // double-click's second click to the first click's worker).
    let previous_pick = file_pick.take();

    // Priority chain for element resolution:
    // 1. Pre-captured element, described at the click within the hook's
    //    budget (DCP-1), before the click took effect
    // 2. Worker's own ElementFromPoint query
    // 3. Option D: if the window closed between capture and query,
    //    use the window title from the original HWND
    let (capture_mode, mut element_desc) = if let Some(ref pre) = raw.pre_captured_element {
        // The pre-capture described the element at the click — use it.
        let mode = if pre.tag == "Window" || pre.tag == "Pane" {
            CaptureMode::Coordinate
        } else {
            CaptureMode::Accessibility
        };
        let mut el = pre.clone();
        // Described at the click, while the hook waited on it.
        el.described_after_ms = Some(0);
        (mode, el)
    } else {
        // No pre-captured element — query from the worker.
        let element = backend.element_at_point(raw.screen_x, raw.screen_y);
        match element {
            Some(mut el) => {
                stamp_described_after(&mut el, raw.timestamp);
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
    if matches!(capture_mode, CaptureMode::Coordinate) {
        strip_identity_claims(&mut element_desc);
    }

    // Emitted verbatim in screen space (physical pixels) — the same values the
    // hook observed, and the same values a coordinate-mode selector encodes.
    // Window-relative coordinates land only under new named fields (issue #141).
    let (screen_x, screen_y) = (raw.screen_x as f64, raw.screen_y as f64);

    let payload = if is_right_click {
        ActionPayload::RightClick {
            x: screen_x,
            y: screen_y,
            modifiers: modifiers_of(raw),
            held: held_at(raw),
            element: element_desc.clone(),
        }
    } else {
        ActionPayload::Click {
            x: screen_x,
            y: screen_y,
            modifiers: modifiers_of(raw),
            held: held_at(raw),
            element: element_desc.clone(),
        }
    };

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode,
        frame_src: None,
        window_rect: window_rect.clone(),
        preferred_languages: preferred_languages(),
        sequence_id: Some(raw.sequence_id),
        payload,
    });

    // Only a left click confirms or selects in a file dialog: a right or
    // middle press reads no dialog.
    if is_right_click || is_middle_button_click(raw) {
        return;
    }

    // File dialog proxy (DCP-6), confirmed one of two ways. A click on a
    // button named "Save" or "Open": the dialog is read at that click.
    let is_confirm_button = element_desc.tag == "Button"
        && element_desc
            .name
            .as_deref()
            .is_some_and(|name| matches!(name.to_lowercase().as_str(), "save" | "open"));
    let pick = if is_confirm_button {
        read_file_dialog(raw, backend, context_id, &window_rect)
    } else if completes_double_click(raw) {
        // A double-click on a file in the item view: its second press closes
        // the dialog, often before this click is processed, so the dialog
        // was read at the first click, which selected the file.
        previous_pick
    } else {
        *file_pick = read_file_pick(raw, backend, &element_desc, context_id, &window_rect);
        None
    };
    if let Some(pick) = pick {
        // An Open dialog's text can leave out the file's extension; the file
        // it names is recorded where exactly one does. A Save's text names
        // the file to be written, which a file already displayed under the
        // same text is not, so it is recorded as shown (DCP-13).
        let file_path = if pick.dialog_type == "open" {
            backend
                .file_on_disk(&pick.file_path)
                .unwrap_or(pick.file_path)
        } else {
            pick.file_path
        };
        let _ = action_sender.send(ActionEvent {
            timestamp: raw.timestamp,
            context_id: pick.context_id,
            capture_mode: CaptureMode::Accessibility,
            frame_src: None,
            window_rect: pick.window_rect,
            preferred_languages: preferred_languages(),
            sequence_id: Some(raw.sequence_id),
            payload: ActionPayload::FileDialog {
                dialog_type: pick.dialog_type,
                file_path,
                source: pick.source,
            },
        });
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
    last_focus: &mut Option<(Option<i64>, String)>,
    window_rect: Option<WindowRect>,
) {
    let (mut element, element_window) = match backend.focused_element_in_window() {
        Some(found) => found,
        None => return, // Can't resolve focused element — skip.
    };
    // A focus event dispatched after this one means the element described
    // now need not be the one this event named, and the later event records
    // the focus at its own place in the recording (docent#735). Read after
    // the description, so an event dispatched during it counts. Only focus
    // events actually dispatched count: a focus change the Input_Thread
    // filters out sends no event that would record the focus instead.
    let number = focus_event_number(raw);
    if number != 0 && backend.focus_events_dispatched() != number {
        return;
    }
    stamp_described_after(&mut element, raw.timestamp);
    // The element is the one focused when it is described, which need not be
    // in the window the focus event named: a dialog that closed as the focus
    // went back to its owner, for one (docent#709). The focus is recorded in
    // the context of the element's own window (DCP-7), the event's where the
    // description resolved no window.
    let (context_id, window_rect) = if element_window != 0 && Some(element_window) != context_id {
        (Some(element_window), backend.window_rect(element_window))
    } else {
        (context_id, window_rect)
    };

    // Focus deduplication: skip the element of the last focus written, its
    // selector within its window.
    let key = (context_id, element.selector.clone());
    if last_focus.as_ref() == Some(&key) {
        return;
    }
    *last_focus = Some(key);

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        preferred_languages: preferred_languages(),
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
    state: &mut WorkerState,
    window_rect: Option<WindowRect>,
) -> bool {
    // Backend (UIA) calls happen BEFORE taking the buffer lock.
    //
    // The value is read from the focused element now, so that element has to
    // be the one the value change belongs to: the element its keystrokes were
    // recorded on. The value change is dispatched only behind a keystroke of
    // its own window, and that keystroke was processed before it.
    let last_key = state
        .last_key
        .as_ref()
        .filter(|k| k.context_id == context_id);
    // The keystroke was recorded on its control: its value change is the one
    // that control reports about itself, and the value is read from the
    // control, whatever holds the focus by now. A value change from anywhere
    // else in the window says nothing about the keystroke and is passed over.
    if let Some(key_control) = last_key.map(|k| k.control).filter(|c| *c != 0) {
        if value_change_control(raw) != key_control {
            return false;
        }
        let Some(mut element) = state
            .controls
            .get(&key_control)
            .and_then(|known| known.element.clone())
        else {
            return false;
        };
        let is_password = element.element_type.as_deref() == Some("password");
        let value = if is_password {
            PASSWORD_MASK.to_string()
        } else {
            match backend.control_value(key_control) {
                Some(value) => {
                    element.text = Some(value.clone());
                    value
                }
                None => {
                    // The control is gone or gives no value: no `type`.
                    keep_keys_of_dropped_value_change(pending, action_sender);
                    return false;
                }
            }
        };
        return record_type_value(
            raw,
            action_sender,
            context_id,
            pending,
            &mut state.last_value,
            window_rect,
            element,
            value,
            is_password,
        );
    }
    // A keystroke that named no element (its window was gone, gave no focused
    // element, or the person had moved the focus): the value change has no
    // element to be the `type` of.
    if last_key.is_some_and(|k| k.mark.is_none()) {
        keep_keys_of_dropped_value_change(pending, action_sender);
        return false;
    }
    // Identity first, where the key's element is still the marked one: a
    // description can change while the element stays (a window title in the
    // selector that gains a "modified" mark with the first character).
    let same_as_key = match last_key {
        Some(k) if k.mark == Some(state.mark_seq) => backend.focused_is_marked(),
        _ => None,
    };
    if same_as_key == Some(false) {
        keep_keys_of_dropped_value_change(pending, action_sender);
        return false;
    }
    let key_field = last_key.map(|k| (k.selector.clone(), k.place.clone()));
    let described = describe_focused_for(raw, backend, &mut state.mark_seq);
    let Some(FocusedNow {
        element: Some(element),
        focus_stands,
        ..
    }) = described
    else {
        // The marked element changed or went; the last key no longer holds it.
        if let Some(k) = state.last_key.as_mut() {
            k.mark = None;
        }
        keep_keys_of_dropped_value_change(pending, action_sender);
        return false;
    };
    if same_as_key.is_none()
        && key_field
            .is_some_and(|(selector, place)| !same_field_as(&selector, place.as_deref(), &element))
    {
        if let Some(k) = state.last_key.as_mut() {
            k.mark = None;
        }
        keep_keys_of_dropped_value_change(pending, action_sender);
        return false;
    }
    // The element was just marked again: the last key's element is the marked
    // one still.
    if let Some(k) = state
        .last_key
        .as_mut()
        .filter(|k| k.context_id == context_id)
    {
        k.mark = Some(state.mark_seq);
        k.selector = element.selector.clone();
        k.place = element.place_in_window.clone();
    }
    if focus_stands {
        state.typing_focus = Some(TypingFocus {
            context_id,
            epoch: raw.focus_epoch,
            element: element.clone(),
            mark: state.mark_seq,
        });
    } else if let Some(f) = state.typing_focus.as_mut() {
        // The remembered element, described again.
        if f.context_id == context_id
            && f.epoch == raw.focus_epoch
            && same_field(&f.element, &element)
        {
            f.mark = state.mark_seq;
        }
    }
    let is_password = element.element_type.as_deref() == Some("password");
    let value = if is_password {
        PASSWORD_MASK.to_string()
    } else {
        // The value, never the text: the text of a field that holds nothing
        // is its name, which nobody typed.
        match element.value.clone() {
            Some(value) => value,
            None => {
                // The element has no value: no `type`.
                keep_keys_of_dropped_value_change(pending, action_sender);
                return false;
            }
        }
    };
    record_type_value(
        raw,
        action_sender,
        context_id,
        pending,
        &mut state.last_value,
        window_rect,
        element,
        value,
        is_password,
    )
}

/// Start or carry forward the pending `type` of `element` with `value`,
/// unless the value is the element's last recorded one.
#[allow(clippy::too_many_arguments)]
fn record_type_value(
    raw: &RawEvent,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    pending: &SharedPendingBuffers,
    last_value: &mut Option<LastValue>,
    window_rect: Option<WindowRect>,
    mut element: ElementDescription,
    value: String,
    is_password: bool,
) -> bool {
    // A control that takes no typed text has no `type`: a value change
    // attributed to it is the effect of pressing it (the field a button
    // clears), and the key that pressed it stays the record.
    if takes_no_typed_text(&element) {
        keep_keys_of_dropped_value_change(pending, action_sender);
        return false;
    }

    // The first value-change describes the element; that element (and the
    // matching timestamp) is what the coalesced type action exports.
    stamp_described_after(&mut element, raw.timestamp);

    // In-memory buffer mutation only — short lock, no backend calls inside.
    let mut buffers = lock_buffers(pending);

    // A value change that repeats the value just taken for this field, with
    // no typing key pressed for it, is the same change reported again (a
    // program that reports one change twice) and adds nothing. With a typing
    // key buffered it is typing: the person typed the same text over itself.
    // Only the field typed into last is remembered, so a value the field held
    // in an earlier typing run is never what a later one is compared with.
    let repeats_last = buffers.pending_keys.is_empty()
        && last_value
            .as_ref()
            .is_some_and(|last| last.is_of(context_id, &element) && last.value == value);
    if repeats_last {
        return true;
    }
    *last_value = Some(LastValue::of(context_id, &element, &value));

    buffer_type_value(
        &mut buffers,
        action_sender,
        element,
        value,
        is_password,
        raw,
        context_id,
        window_rect,
    );
    true
}

/// A value change that is no `type` supersedes no keystroke. A `type` already
/// pending would discard the buffered keys when it is written, so it is
/// written now, ahead of them; the keys stay buffered and are written as keys.
fn keep_keys_of_dropped_value_change(
    pending: &SharedPendingBuffers,
    action_sender: &mpsc::Sender<ActionEvent>,
) {
    let mut buffers = lock_buffers(pending);
    if !buffers.pending_keys.is_empty() {
        buffers.flush_pending_type_only(action_sender);
    }
}

/// The value last taken for a field's `type`, and the field it was taken for.
/// One is kept: that of the field typed into last. It tells a value change
/// reported twice from typing (see [`record_type_value`]).
struct LastValue {
    context_id: Option<i64>,
    selector: String,
    place: Option<String>,
    value: String,
}

impl LastValue {
    fn of(context_id: Option<i64>, element: &ElementDescription, value: &str) -> Self {
        Self {
            context_id,
            selector: element.selector.clone(),
            place: element.place_in_window.clone(),
            value: value.to_string(),
        }
    }

    /// Whether `element` of the window `context_id` is the field it was taken
    /// for. Two windows can hold elements with equal selectors (two documents
    /// of one application), and they are two fields.
    fn is_of(&self, context_id: Option<i64>, element: &ElementDescription) -> bool {
        self.context_id == context_id
            && same_field_as(&self.selector, self.place.as_deref(), element)
    }
}

/// Whether two descriptions read in one window are of the same element.
///
/// The selector holds the window's title, and a title changes while the
/// element stays (an editor adds or drops its "modified" mark while the
/// person types), so where both descriptions know their place under the
/// window, the place decides. Where one does not, the selectors do.
fn same_field(a: &ElementDescription, b: &ElementDescription) -> bool {
    same_field_as(&a.selector, a.place_in_window.as_deref(), b)
}

/// [`same_field`], for an element remembered by its selector and its place.
fn same_field_as(selector: &str, place: Option<&str>, element: &ElementDescription) -> bool {
    match (place, element.place_in_window.as_deref()) {
        (Some(a_place), Some(b_place)) => a_place == b_place,
        _ => selector == element.selector,
    }
}

/// Start the pending type event for `element`, or carry the one already
/// pending for it forward to `value`.
///
/// A type pending for a different element is flushed first. For the same
/// element the value and the sequence id move to this
/// event; the action's own timestamp and described element stay those of the
/// event that started it.
#[allow(clippy::too_many_arguments)]
fn buffer_type_value(
    buffers: &mut PendingBuffers,
    action_sender: &mpsc::Sender<ActionEvent>,
    element: ElementDescription,
    value: String,
    is_password: bool,
    raw: &RawEvent,
    context_id: Option<i64>,
    window_rect: Option<WindowRect>,
) {
    // The pending type is this element's when it names the same selector in the
    // same window; a type pending for any other element is flushed first.
    let same_element =
        |pt: &PendingTypeEvent| pt.context_id == context_id && same_field(&pt.element, &element);
    if buffers
        .pending_type
        .as_ref()
        .is_some_and(|pt| !same_element(pt))
    {
        buffers.flush_pending_type_only(action_sender);
    }

    // Buffer or update the pending type event.
    match buffers.pending_type {
        Some(ref mut pt) => {
            // Same element — carry the value forward.
            pt.value = value;
            pt.sequence_id = raw.sequence_id;
        }
        None => {
            // New element or no pending event.
            buffers.pending_type = Some(PendingTypeEvent {
                element,
                value,
                is_password,
                timestamp: raw.timestamp,
                context_id,
                window_rect,
                sequence_id: raw.sequence_id,
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
                    ..Default::default()
                };
                (fallback, String::new())
            }
        }
    };
    // Every arm above resolved its description at dequeue time — including
    // the window-title fallback, which reads its data at this moment too.
    let mut final_element = final_element;
    stamp_described_after(&mut final_element, raw.timestamp);

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        preferred_languages: preferred_languages(),
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
    state: &mut WorkerState,
    window_rect: Option<WindowRect>,
) {
    let key = key_name(raw);

    // Skip the empty name: every left/right Shift, Control or Alt keydown;
    // a key pressed while they are held reads them into its own modifiers.
    if is_modifier_only_key(&key) {
        return;
    }

    // A key attributed to no window (desktop capture DCP-14): a key the system
    // takes while the foreground window is excluded. Whatever is focused is
    // that excluded window's, so nothing is asked of the backend; the key is
    // no keystroke of any window, so the typing state is left as it is.
    if raw.window_handle == 0 {
        let mut element = ElementDescription {
            tag: "Unknown".to_string(),
            selector: String::new(),
            ..Default::default()
        };
        // Stamped like every constructed stand-in (session format,
        // `described_after_ms`).
        stamp_described_after(&mut element, raw.timestamp);
        let event = ActionEvent {
            timestamp: raw.timestamp,
            context_id: None,
            capture_mode: CaptureMode::Accessibility,
            frame_src: None,
            window_rect: None,
            preferred_languages: preferred_languages(),
            sequence_id: Some(raw.sequence_id),
            payload: ActionPayload::Key {
                key,
                modifiers: modifiers_of(raw),
                code: physical_key_of(raw),
                repeat: is_repeat(raw),
                held: held_at(raw),
                element,
            },
        };
        let mut buffers = lock_buffers(pending);
        buffers.flush_pending_type_only(action_sender);
        flush_pending_keys(&mut buffers.pending_keys, action_sender);
        let _ = action_sender.send(event);
        return;
    }

    // Backend (UIA) call happens BEFORE taking the buffer lock — never hold
    // the lock across a platform call (see PendingBuffers locking discipline).
    //
    // The key belongs to the element that had focus when it was pressed. An
    // element already described under the key's own focus epoch is that
    // element, whatever is focused by now; while the present can still speak
    // for the key (its window in front, no focus change counted since), the
    // backend confirms the focused element is that very one, and a program
    // that moved the focus without reporting it gets a fresh description.
    // Otherwise the focused element is asked for, and taken only while the
    // key's window is still in front; a key whose window closed or was left
    // names no element rather than whatever has focus at this moment.
    //
    // Before any of that: the key carries the handle of the control that held
    // the focus when it was pressed, and where that settles the element no
    // focused-element query is made at all.
    let on_control = settle_key_on_its_control(raw, backend, &mut state.controls);
    let control = if on_control.is_some() {
        key_control(raw)
    } else {
        0
    };
    let mut disproved = false;
    let remembered = if on_control.is_some() {
        None
    } else {
        remembered_focus(&state.typing_focus, raw, context_id)
    }
    .and_then(|known| {
        let present_speaks = known.mark == state.mark_seq
            && backend.focus_epoch() == raw.focus_epoch
            && backend.is_foreground_window(raw.window_handle);
        if present_speaks && backend.focused_is_marked() == Some(false) {
            disproved = true;
            None
        } else {
            Some((known.element.clone(), known.mark))
        }
    });
    if disproved {
        // Not the focused element under this count after all: later keys must
        // not take it either.
        state.typing_focus = None;
    }
    // `unknowable`: nothing can be said about the element the key went to.
    // Its window is gone, the window gave no focused element, or the person
    // moved the focus (a click, a focus-moving key) before this description.
    let (mut element, mark, unknowable) = match (on_control, remembered) {
        (Some(element), _) => (element, None, false),
        (None, Some((element, mark))) => (element, Some(mark), false),
        (None, None) => match describe_focused_for(raw, backend, &mut state.mark_seq) {
            Some(FocusedNow {
                element: Some(element),
                focus_stands,
                person_moved_focus: false,
            }) => {
                if focus_stands {
                    state.typing_focus = Some(TypingFocus {
                        context_id,
                        epoch: raw.focus_epoch,
                        element: element.clone(),
                        mark: state.mark_seq,
                    });
                }
                (element, Some(state.mark_seq), false)
            }
            _ => (undescribed_element(raw, backend), None, true),
        },
    };
    // The gap to the moment this worker settled the key's element.
    stamp_described_after(&mut element, raw.timestamp);
    let key_element = element.clone();
    state.last_key = Some(LastKey {
        context_id,
        selector: element.selector.clone(),
        place: element.place_in_window.clone(),
        mark,
        control,
    });

    // Typing into a password field is its masked type, never a key: a key is
    // named by the character it carries, and a buffered key is written as
    // typed whenever no value change discards it first (a control key right
    // behind it, a drain, a field that reports no value change). So the
    // keystroke starts or extends the field's pending type itself, masked as
    // a value change would mask it; the value change that follows finds the
    // mask already recorded as the field's last value and adds nothing.
    //
    // A key whose element is unknowable is held to the same rule: nothing
    // shows its field was not a password field, so its character is not
    // written.
    if (element.element_type.as_deref() == Some("password") || unknowable)
        && enters_text_in_password_field(raw, &key)
    {
        state.last_value = Some(LastValue::of(context_id, &element, PASSWORD_MASK));
        let mut buffers = lock_buffers(pending);
        // Keys still buffered were typed into another control, one that
        // reported no value change; write them before this type starts, so no
        // later flush counts them superseded by it.
        flush_pending_keys(&mut buffers.pending_keys, action_sender);
        buffers.pending_keys_last_timestamp = 0;
        buffer_type_value(
            &mut buffers,
            action_sender,
            element,
            PASSWORD_MASK.to_string(),
            true,
            raw,
            context_id,
            window_rect,
        );
        return;
    }

    // A typing key waits for the value change that would make it text, except
    // on a control that takes no typed text, where it is a key at once.
    let buffered = is_printable_key(raw) && !takes_no_typed_text(&element);

    let event = ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        preferred_languages: preferred_languages(),
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::Key {
            key: key.clone(),
            modifiers: modifiers_of(raw),
            repeat: is_repeat(raw),
            code: physical_key_of(raw),
            held: held_at(raw),
            element,
        },
    };

    // In-memory buffer mutation only — short lock, no backend calls inside.
    let mut buffers = lock_buffers(pending);
    if buffered {
        // A `type` pending for another element is not this key's: it is
        // written now, so that it cannot count this key superseded when it is
        // written later.
        if buffers
            .pending_type
            .as_ref()
            .is_some_and(|pt| pt.context_id != context_id || !same_field(&pt.element, &key_element))
        {
            buffers.flush_pending_type_only(action_sender);
        }
        // Keys buffered on another element are not this element's typing
        // either: its value change must not supersede them, so they are
        // written now, as the keys they are.
        if buffers.pending_keys.iter().any(|pending_key| {
            pending_key.context_id != context_id
                || !matches!(&pending_key.payload,
                    ActionPayload::Key { element, .. } if same_field(element, &key_element))
        }) {
            flush_pending_keys(&mut buffers.pending_keys, action_sender);
        }
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
    // The process the Input_Thread read with the event, while the window was
    // there: a window can close before a worker gets to its switch, and then
    // it names no process (docent#761). The window names it where the
    // process cannot be named by its id.
    let source = Some(raw.process_id)
        .filter(|pid| *pid != 0)
        .and_then(|pid| backend.process_name_of(pid))
        .unwrap_or_else(|| backend.process_name(raw.window_handle));

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        preferred_languages: preferred_languages(),
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
    let mut element = backend
        .element_at_point(raw.screen_x, raw.screen_y)
        .unwrap_or_else(|| {
            let title = backend.window_title(raw.window_handle);
            coordinate::fallback_element(&title, raw.screen_x, raw.screen_y)
        });
    stamp_described_after(&mut element, raw.timestamp);

    *last_drag_element = Some(element.clone());

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        preferred_languages: preferred_languages(),
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::DragStart {
            modifiers: modifiers_of(raw),
            held: held_at(raw),
            element,
        },
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
    let mut element = backend
        .element_at_point(raw.screen_x, raw.screen_y)
        .unwrap_or_else(|| {
            let title = backend.window_title(raw.window_handle);
            coordinate::fallback_element(&title, raw.screen_x, raw.screen_y)
        });
    stamp_described_after(&mut element, raw.timestamp);

    // The source element keeps the stamp from its own describe at drag-start.
    let source_element = last_drag_element.take();

    let _ = action_sender.send(ActionEvent {
        timestamp: raw.timestamp,
        context_id,
        capture_mode: CaptureMode::Accessibility,
        frame_src: None,
        window_rect,
        preferred_languages: preferred_languages(),
        sequence_id: Some(raw.sequence_id),
        payload: ActionPayload::Drop {
            x: raw.screen_x as f64,
            y: raw.screen_y as f64,
            modifiers: modifiers_of(raw),
            held: held_at(raw),
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
            preferred_languages: preferred_languages(),
            sequence_id: Some(pt.sequence_id),
            payload: ActionPayload::Type {
                element: pt.element,
                value: pt.value,
            },
        });
    }
}

/// Flush buffered printable key events — emit them as individual key actions.
/// Called when the KEY_TEXT_WAIT_MS wait passes with no value change arriving
/// (meaning the app doesn't fire EVENT_OBJECT_VALUECHANGE for these keystrokes).
fn flush_pending_keys(
    pending_keys: &mut Vec<ActionEvent>,
    action_sender: &mpsc::Sender<ActionEvent>,
) {
    for event in pending_keys.drain(..) {
        let _ = action_sender.send(event);
    }
}

/// Write the buffered typing keys as keys once no value change has followed
/// the last of them for [`KEY_TEXT_WAIT_MS`]: the control took no text from
/// them (a calculator's digit keys).
///
/// The pending `type` is not written here. How long a person pauses between
/// keys is no part of what they typed: a field's `type` is written when the
/// typing in it ends (a key that is no text, typing in another element, a
/// pointer press, a drag, a window change, a step commit or a stop).
fn write_keys_that_took_no_text(
    buffers: &mut PendingBuffers,
    now: u64,
    action_sender: &mpsc::Sender<ActionEvent>,
) {
    if !buffers.pending_keys.is_empty()
        && buffers.pending_keys_last_timestamp > 0
        && debounce_elapsed(now, buffers.pending_keys_last_timestamp, KEY_TEXT_WAIT_MS)
    {
        flush_pending_keys(&mut buffers.pending_keys, action_sender);
        buffers.pending_keys_last_timestamp = 0;
    }
}

/// Whether a dispatched event ends the typing in a field: the person
/// clicked, right-clicked or dragged, or another window came to the front. A
/// `type` pending then is complete, and is written ahead of that event's
/// action.
///
/// A focus event is none: the key that moved the focus (Tab) has ended the
/// typing already, and a program that reports the focus again on the field
/// being typed into ends nothing. A value change that reaches the worker
/// after one of these events starts the field's next `type`.
fn ends_typing(event_type: &RawEventType) -> bool {
    matches!(
        event_type,
        RawEventType::Click
            | RawEventType::RightClick
            | RawEventType::DragStart { .. }
            | RawEventType::Drop { .. }
            | RawEventType::Foreground
    )
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
            preferred_languages: preferred_languages(),
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
                held: HeldKeysAtAction::default(),
                element: ElementDescription {
                    tag: "Edit".to_string(),
                    id: None,
                    name: None,
                    role: None,
                    element_type: None,
                    text: None,
                    selector: "win > edit".to_string(),
                    ..Default::default()
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
    fn flush_all_rescues_a_wedged_worker_in_place_and_still_emits_the_sentinel() {
        // Regression: #298 — a worker that buffered actions then wedged (never
        // acknowledges the flush) has its buffers rescued IN PLACE by flush_all
        // (no thread detach, unlike shutdown), is reported in the returned set,
        // and does not prevent the completion sentinel from being emitted last.
        let (mut pool, rx) = pool_with(1, |rx, pending, _sender| {
            lock_buffers(&pending).pending_keys = vec![key_event("x"), key_event("y")];
            // Consume messages but never acknowledge; block as a wedged UIA call would.
            loop {
                let _ = rx.recv();
                std::thread::sleep(Duration::from_secs(3600));
            }
        });

        thread::sleep(Duration::from_millis(50)); // let it seed its buffer
        let wedged = pool.flush_all(9, Duration::from_millis(200));
        assert_eq!(
            wedged,
            vec![0],
            "the wedged worker must be reported rescued"
        );

        let events = drain_events(&rx);
        assert_eq!(
            key_names(&events),
            vec!["x", "y"],
            "the wedged worker's buffered actions must be rescued in place"
        );
        assert!(
            matches!(
                events.last().unwrap().payload,
                ActionPayload::BarrierComplete { barrier_id: 9 }
            ),
            "the completion sentinel must still be emitted last"
        );

        pool.shutdown_with_timeout(Duration::from_millis(200));
    }

    #[test]
    fn a_typing_worker_that_misses_the_flush_barrier_gives_the_role_up() {
        // Typing follows one worker. One that is wedged in an accessibility
        // call would hold every later keystroke behind it, so the barrier that
        // finds it unresponsive frees the role and the next keystroke goes to
        // a worker that answers.
        a_role_is_given_up_at_a_missed_barrier(RawEventType::Keyboard);
    }

    #[test]
    fn a_focus_worker_that_misses_the_flush_barrier_gives_the_role_up() {
        // Every focus event follows one worker (docent#735); the role is
        // freed like the typing worker's.
        a_role_is_given_up_at_a_missed_barrier(RawEventType::Focus);
    }

    /// Worker 0 takes the first event of `event_type` and wedges; after a
    /// barrier it misses, the next such event reaches worker 1.
    fn a_role_is_given_up_at_a_missed_barrier(event_type: RawEventType) {
        let received: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        let seen = Arc::clone(&received);
        let mut pool = WorkerPool::new(2, action_tx, move |idx, rx, _queue_len, _sender, _p| {
            let seen = Arc::clone(&seen);
            thread::spawn(move || loop {
                match rx.recv() {
                    Ok(WorkerMessage::Event(_)) => {
                        seen.lock().unwrap().push(idx);
                        if idx == 0 {
                            // Worker 0 wedges on its first event.
                            std::thread::sleep(Duration::from_secs(3600));
                        }
                    }
                    Ok(WorkerMessage::Flush(ack)) => {
                        let _ = ack.send(idx);
                    }
                    Ok(WorkerMessage::EndTyping) => {}
                    Ok(WorkerMessage::Shutdown) | Err(_) => break,
                }
            })
        });
        let key = || RawEvent {
            event_type: event_type.clone(),
            sequence_id: 0,
            timestamp: 1,
            screen_x: 0,
            screen_y: 0,
            window_handle: 1,
            process_id: 1,
            key_code: 0x41,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
        };

        pool.dispatch(key()); // worker 0 takes the typing role and wedges
        thread::sleep(Duration::from_millis(50));
        let wedged = pool.flush_all(3, Duration::from_millis(200));
        assert_eq!(wedged, vec![0]);
        pool.dispatch(key());
        thread::sleep(Duration::from_millis(100));

        assert_eq!(
            *received.lock().unwrap(),
            vec![0, 1],
            "worker 0 took the first event and wedged with nothing queued \
             behind it; after the barrier the next one reaches worker 1"
        );
        pool.shutdown_with_timeout(Duration::from_millis(200));
    }

    #[test]
    fn drain_into_twice_emits_each_held_action_once() {
        // The idempotence every rescue path leans on (DCP-12): a drain empties
        // the buffers under their shared lock, so a second drain — a late
        // marker-ordered flush after a fallback, a teardown drain after the
        // barrier — emits nothing. Pins the drain-twice behaviour directly.
        let (tx, rx) = mpsc::channel::<ActionEvent>();
        let pending: SharedPendingBuffers = Arc::new(Mutex::new(PendingBuffers::new()));
        lock_buffers(&pending).pending_keys = vec![key_event("a"), key_event("b")];

        lock_buffers(&pending).drain_into(&tx);
        lock_buffers(&pending).drain_into(&tx);

        let events = drain_events(&rx);
        assert_eq!(
            key_names(&events),
            vec!["a", "b"],
            "each held action must be emitted exactly once"
        );
        assert_eq!(events.len(), 2, "the second drain must emit nothing");
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
                    ..
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

    /// Backend whose `focused_element()` and/or `window_title()` either return
    /// at once or block forever, modelling a responsive vs. an unresponsive
    /// application. `block_focused` gates the element query (the click/keypress
    /// path); `block_window_title` gates the title lookup (the foreground /
    /// context-switch path). Every other query returns promptly so only the
    /// targeted in-handler UIA call is affected.
    struct ProbeBackend {
        block_focused: bool,
        block_window_title: bool,
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
                ..Default::default()
            })
        }
        fn window_title(&self, _window_handle: i64) -> String {
            if self.block_window_title {
                // Model an unresponsive provider on the foreground path: the
                // title lookup never returns. The wedged worker is detached by
                // bounded shutdown and reclaimed at process exit (same pattern
                // as `block_focused`).
                loop {
                    thread::sleep(Duration::from_secs(3600));
                }
            }
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
    fn pool_with_probe_backend(
        block_focused: bool,
        block_window_title: bool,
    ) -> (WorkerPool, mpsc::Receiver<ActionEvent>) {
        let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
        let pool = WorkerPool::new(1, action_tx, move |idx, rx, queue_len, sender, pending| {
            let excluded_pid = Arc::new(AtomicU32::new(0));
            thread::spawn(move || {
                let backend = ProbeBackend {
                    block_focused,
                    block_window_title,
                };
                worker_loop(
                    idx,
                    backend,
                    rx,
                    queue_len,
                    sender,
                    excluded_pid,
                    pending,
                    None,
                );
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
            focus_epoch: 0,
            held: Vec::new(),
        }
    }

    /// A foreground-change RawEvent for the context-switch tests.
    fn foreground_raw_event() -> RawEvent {
        RawEvent {
            event_type: RawEventType::Foreground,
            sequence_id: 1,
            timestamp: 1000,
            screen_x: 0,
            screen_y: 0,
            window_handle: 99,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
        }
    }

    #[test]
    fn a_key_attributed_to_no_window_names_no_element_and_no_window() {
        // The hook attributes a key the system takes to no window when the
        // self-capture exclusion excludes the foreground window (DCP-14): the
        // worker must not describe whatever is focused (a window of Docent's
        // own), only write the nameless stand-in with no context.
        let (mut pool, rx) = pool_with_probe_backend(false, false);
        let mut raw = control_key_raw_event(0x5B, 1); // the left Windows key
        raw.window_handle = 0;
        raw.process_id = 0;
        pool.dispatch(raw);
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        let events = drain_events(&rx);
        assert_eq!(key_names(&events), vec!["Meta"]);
        let event = &events[0];
        assert_eq!(event.context_id, None);
        assert_eq!(event.window_rect, None);
        match &event.payload {
            ActionPayload::Key { element, .. } => {
                assert_eq!(element.tag, "Unknown");
                assert_eq!(element.selector, "");
                assert_eq!(element.name, None);
                assert!(element.locators.is_empty());
                // A constructed stand-in carries the describe stamp like every
                // other (session format, `described_after_ms`; docent#220).
                assert!(element.described_after_ms.is_some());
            }
            _ => panic!("expected Key payload"),
        }
    }

    #[test]
    fn a_key_attributed_to_no_window_states_its_modifiers_held_keys_and_repeat() {
        // Win+E pressed while Docent is in front (DCP-14), Space held from
        // before: the hook's record stamps each key at its dispatch as it
        // stamps every keystroke. The Windows key is a modifier, never a held
        // key; E states it as `meta`, Space as a held key, and its repeat.
        use crate::capture::held_keys::{HeldKeys, KEY_REPEAT_PARAM};
        let (mut pool, rx) = pool_with_probe_backend(false, false);
        let mut record = HeldKeys::new();
        let up = |_| false;
        record.on_hook_message(0x0100, 0x20, 0x39, up);
        let mut space = control_key_raw_event(0x20, 1);
        space.callback_params[0] = 0x39;
        record.stamp(&mut space);
        let no_window = |mut raw: RawEvent| {
            raw.window_handle = 0;
            raw.process_id = 0;
            raw
        };
        record.on_hook_message(0x0100, 0x5B, 0x5B, up);
        let mut win = no_window(control_key_raw_event(0x5B, 2));
        win.callback_params[0] = 0x5B;
        record.stamp(&mut win);
        pool.dispatch(win);
        let mut e = no_window(control_key_raw_event(0x45, 3));
        e.modifiers = (false, false, false, true);
        e.callback_params[0] = 0x12;
        let mut e_repeat = e.clone();
        record.on_hook_message(0x0100, 0x45, 0x12, up);
        record.stamp(&mut e);
        pool.dispatch(e);
        e_repeat.sequence_id = 4;
        e_repeat.callback_params[3] = KEY_REPEAT_PARAM;
        record.on_hook_message(0x0100, 0x45, 0x12, |_| true);
        record.stamp(&mut e_repeat);
        pool.dispatch(e_repeat);
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        let stated: Vec<_> = drain_events(&rx)
            .into_iter()
            .filter_map(|e| match e.payload {
                ActionPayload::Key {
                    key,
                    modifiers,
                    repeat,
                    held,
                    ..
                } => Some((key, modifiers.meta, repeat, held.held_keys)),
                _ => None,
            })
            .collect();
        let space_held = vec!["Space".to_string()];
        assert_eq!(
            stated,
            vec![
                ("Meta".to_string(), false, false, space_held.clone()),
                ("E".to_string(), true, false, space_held.clone()),
                ("E".to_string(), true, true, space_held),
            ]
        );
    }

    #[test]
    fn responsive_app_keypress_is_captured() {
        // Responsive app: the focused-element query returns promptly, the key
        // is buffered, and the worker's own Shutdown flush emits it. Everything
        // the user put down is captured.
        let (mut pool, rx) = pool_with_probe_backend(false, false);
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
        let (mut pool, rx) = pool_with_probe_backend(false, false);
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
        let (mut pool, rx) = pool_with_probe_backend(true, false);
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

    #[test]
    fn responsive_app_foreground_produces_context_switch() {
        // Responsive app: a foreground change resolves its title/process via
        // prompt queries and the context switch is emitted immediately. This is
        // the DETERMINISTIC equivalent of the `alt_tab_produces_context_switch`
        // real-input integration test — whose capture *count* is
        // environment-dependent (synthesised Alt+Tab needs a real interactive
        // task switcher) and therefore only asserted as no-hang/best-effort.
        let (mut pool, rx) = pool_with_probe_backend(false, false);
        pool.dispatch(foreground_raw_event());
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        let switches: Vec<_> = drain_events(&rx)
            .into_iter()
            .filter_map(|e| match e.payload {
                ActionPayload::ContextSwitch { source, title } => Some((source, title)),
                _ => None,
            })
            .collect();
        assert_eq!(
            switches,
            vec![("probe.exe".to_string(), Some("Probe".to_string()))],
            "a responsive app's foreground change must produce exactly one context switch"
        );
    }

    #[test]
    fn unresponsive_app_foreground_is_not_captured_and_shutdown_is_bounded() {
        // Unresponsive app on the foreground path: the worker blocks inside the
        // title lookup, so the context switch is never emitted. Per the product
        // decision (see the module note above), a context switch is treated like
        // any other in-flight event — Docent captures NOTHING for it when the
        // provider hangs, and shutdown is still bounded (the wedged worker is
        // detached, not joined). This pins down that the foreground path follows
        // the same lose-on-hang contract as the keypress path, deterministically.
        let (mut pool, rx) = pool_with_probe_backend(false, true);
        pool.dispatch(foreground_raw_event());
        // Let the worker pick up the event and block inside window_title().
        thread::sleep(Duration::from_millis(100));

        let timeout = Duration::from_millis(300);
        let start = Instant::now();
        pool.shutdown_with_timeout(timeout);
        let elapsed = start.elapsed();

        assert!(
            elapsed >= timeout && elapsed < Duration::from_secs(3),
            "shutdown must be bounded even when the foreground title lookup hangs (took {elapsed:?})"
        );
        assert!(
            !drain_events(&rx)
                .iter()
                .any(|e| matches!(e.payload, ActionPayload::ContextSwitch { .. })),
            "an unresponsive app's in-flight context switch must NOT be captured"
        );
        // Wedged worker was detached, so a second shutdown is a no-op.
        assert!(pool.workers.iter().all(|w| w.thread.is_none()));
    }

    /// A keydown of punctuation key `vk` whose layout character, as the
    /// keyboard hook reads it, is `layout_char` (`callback_params[3]`).
    fn punctuation_key_raw_event(vk: u32, layout_char: u32, sequence_id: u64) -> RawEvent {
        let mut raw = control_key_raw_event(vk, sequence_id);
        raw.callback_params[3] = i64::from(layout_char);
        raw
    }

    // Regression: #691 — on a Danish keyboard the `+` key (VK_OEM_PLUS) was
    // recorded as `=`, the US-layout character of that code.
    // https://github.com/Arsarneq/docent/issues/691
    #[test]
    fn regression_691_punctuation_key_named_by_its_layout_character() {
        // The Calculator case: `+` pressed with no modifier into a control that
        // reports no value change, so the buffered key is written as a key.
        let (mut pool, rx) = pool_with_probe_backend(false, false);
        pool.dispatch(punctuation_key_raw_event(0xBB, u32::from('+'), 1));
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        assert_eq!(
            key_names(&drain_events(&rx)),
            vec!["+"],
            "VK_OEM_PLUS on a layout where it enters `+` must be named `+`"
        );
    }

    /// A key name, as the worker names the keydown of `vk` whose
    /// `callback_params[3]` is `layout_char`.
    fn name_with_layout_char(vk: u32, layout_char: i64) -> String {
        let mut raw = control_key_raw_event(vk, 1);
        raw.callback_params[3] = layout_char;
        key_name(&raw)
    }

    #[test]
    fn a_punctuation_key_is_named_by_the_character_its_layout_gives_it() {
        // Danish: `+` on VK_OEM_PLUS, `<` on VK_OEM_102, `'` on VK_OEM_2.
        assert_eq!(name_with_layout_char(0xBB, '+' as i64), "+");
        assert_eq!(name_with_layout_char(0xE2, '<' as i64), "<");
        assert_eq!(name_with_layout_char(0xBF, '\'' as i64), "'");
        // US: the same codes give the US characters.
        assert_eq!(name_with_layout_char(0xBB, '=' as i64), "=");
        assert_eq!(name_with_layout_char(0xE2, '\\' as i64), "\\");
        // Every OEM code reads its layout character.
        for vk in [0xBA, 0xC0, 0xC1, 0xC2, 0xDB, 0xDF, 0xE1, 0xE3, 0xE4, 0xE6] {
            assert_eq!(name_with_layout_char(vk, '§' as i64), "§", "vk {vk:#x}");
        }
    }

    #[test]
    fn a_punctuation_key_that_enters_a_letter_is_named_in_upper_case() {
        // Danish Æ, Ø and Å sit on OEM codes; letters are named upper case.
        assert_eq!(name_with_layout_char(0xC0, 'æ' as i64), "Æ");
        assert_eq!(name_with_layout_char(0xDE, 'ø' as i64), "Ø");
        assert_eq!(name_with_layout_char(0xDD, 'Å' as i64), "Å");
        // A letter whose upper case is more than one character keeps its own.
        assert_eq!(name_with_layout_char(0xDB, 'ß' as i64), "ß");
    }

    #[test]
    fn a_dead_punctuation_key_is_named_by_its_accent() {
        // Bit 31 flags a dead key; the low word is the accent it carries.
        assert_eq!(name_with_layout_char(0xDB, 0x8000_00B4), "´");
        assert_eq!(name_with_layout_char(0xBA, 0x8000_00A8), "¨");
    }

    #[test]
    fn a_punctuation_key_with_no_layout_character_is_named_by_its_code() {
        // No character read (the layout gives the key none, or nothing read).
        assert_eq!(name_with_layout_char(0xBB, 0), "VK_0xBB");
        assert_eq!(name_with_layout_char(0xE2, 0), "VK_0xE2");
        // A control character or a surrogate half is no character either.
        assert_eq!(name_with_layout_char(0xBB, 0x1B), "VK_0xBB");
        assert_eq!(name_with_layout_char(0xBB, 0xD800), "VK_0xBB");
        // Nor is a layout table's own marker (WCH_NONE, WCH_DEAD, WCH_LGTR).
        for marker in [0xF000, 0xF001, 0xF002] {
            assert_eq!(
                name_with_layout_char(0xBB, marker),
                "VK_0xBB",
                "{marker:#x}"
            );
        }
        // Any other private-use value is a character the layout gives the key.
        assert_eq!(name_with_layout_char(0xBB, 0xF003), "\u{F003}");
        assert_eq!(name_with_layout_char(0xBB, 0xF0FF), "\u{F0FF}");
        assert_eq!(name_with_layout_char(0xBB, 0xF100), "\u{F100}");
        // A space is named as the space bar is.
        assert_eq!(name_with_layout_char(0xBB, ' ' as i64), "Space");
    }

    #[test]
    fn only_punctuation_keys_read_the_layout_character() {
        // A letter, a digit, a keypad key and a control key keep their names.
        assert_eq!(name_with_layout_char(0x41, 'q' as i64), "A");
        assert_eq!(name_with_layout_char(0x31, '&' as i64), "1");
        assert_eq!(name_with_layout_char(0x6B, '+' as i64), "Add");
        assert_eq!(name_with_layout_char(0x0D, '+' as i64), "Enter");
        // VK_PACKET is named by its scan code's character.
        let mut raw = control_key_raw_event(VK_PACKET, 1);
        raw.callback_params = [i64::from(u32::from('é')), 0, 0, '+' as i64];
        assert_eq!(key_name(&raw), "é");
    }

    #[test]
    fn a_punctuation_key_is_printable_input_with_or_without_a_layout_character() {
        let mut raw = control_key_raw_event(0xE2, 1);
        raw.callback_params[3] = '<' as i64;
        assert!(is_printable_key(&raw));
        // Without one it is named by its code and is still a typing key: the
        // typing table decides by the key's code (is_typing_key_code).
        raw.callback_params[3] = 0;
        assert_eq!(key_name(&raw), "VK_0xE2");
        assert!(is_printable_key(&raw));
    }
}
