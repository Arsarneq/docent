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
use super::waiting_accents::{NamedPresses, WaitingAccents};
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
    /// Modifier key state: (ctrl, shift, alt, meta), as the system holds the
    /// keys: AltGr counted as Ctrl and Alt together, which is how Windows
    /// hands it to programs and how a layout is asked what a key gives. Every
    /// verdict on a keystroke reads it (a shortcut or typing, the key's name,
    /// masking, a key the system takes); an action's `modifiers` is written
    /// from `ctrl_alt_read` where it was read ([`modifiers_of`]).
    pub modifiers: (bool, bool, bool, bool),
    /// What the Input_Thread read of the Ctrl and Alt keys at the event, from
    /// which a worker writes an action's `modifiers` once it knows whether
    /// the layout read makes the right Alt AltGr
    /// ([`super::held_keys::CtrlAltRead`],
    /// [`AccessibilityBackend::layout_alt_gr`]); `None` where the platform
    /// read nothing of them, and then `modifiers` is written as it is, with
    /// no AltGr.
    pub ctrl_alt_read: Option<super::held_keys::CtrlAltRead>,
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
    /// naming the physical key a `key` action's `code` states, and above the
    /// mark what the hook read of the input method at the press
    /// ([`super::held_keys::input_method_param`]; nothing where none was read);
    /// `focused_control` the window
    /// handle of the control that held the keyboard focus at the key (`0` when
    /// none was read, see `settle_key_on_its_control`); `part_focus` the
    /// number of the latest focus change that named a part of that control
    /// (see [`PartFocusNote`]); and `layout_char`, in the low 32 bits, what the
    /// keyboard layout gives a punctuation key with no modifier, the dead-key
    /// flag in bit 31 (read by [`is_dead_key`]; 0 for every other key), with
    /// the repeat mark in the bit above it
    /// ([`super::held_keys::KEY_REPEAT_PARAM`]): set on a key-down for a key
    /// that was already down (a press key repeat generated while the key was
    /// held), clear on the press itself (see [`super::held_keys::HeldKeys`]),
    /// and above that the key's number among the keys of its window
    /// ([`key_number_param`], `0` when not numbered).
    /// `[button, 0, 0, 0]` from the mouse hook's click paths, where
    /// [`CLICK_COMPLETES_DOUBLE_CLICK`] marks the second click of a
    /// double-click (read by the pool's routing and the click arm) and
    /// [`CLICK_IS_MIDDLE_BUTTON`] a middle-button press (read by the click
    /// arm). On other platforms: unused or platform-defined.
    pub callback_params: [i64; 4],
    /// What the keyboard layout gives the key of a keystroke as pressed, with
    /// the modifiers and the Caps Lock state of the press
    /// ([`super::key_value::answer_param`]). `0`, nothing read, as the
    /// Input_Thread dispatches the event: the worker that processes it asks
    /// the layout ([`AccessibilityBackend::key_value`]) and fills it in
    /// ([`with_key_values`]). A `key` action's `key` is named from it
    /// ([`key_name`]).
    pub key_value: u32,
    /// The keyboard layout of the thread the keystroke went to, as the
    /// platform hands it (on Windows the layout handle), read by the keyboard
    /// hook at the press; `0` where none was read, and for every event that
    /// is no keystroke.
    pub keyboard_layout: i64,
    /// The thread of the foreground window at the keystroke, read by the
    /// keyboard hook at the press, also for a key attributed to no window;
    /// `0` where none was read, and for every event that is no keystroke.
    /// The key behind a dead key is named by what the two make only within
    /// one thread ([`super::waiting_accents`]).
    pub keyboard_thread: u32,
    /// Whether Caps Lock was on at the keystroke, read by the keyboard hook
    /// at the press; `false` for every event that is no keystroke.
    pub caps_lock: bool,
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
    /// The title of the event's window, read by the Input_Thread at a
    /// foreground event, while the window was there: a window can close
    /// before a worker gets to its switch, and then it has no title to read
    /// (docent#801). `None` for every other event, and where it was not read.
    pub window_title: Option<String>,
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
    /// A menu item was clicked: a command to the field typed into last (its
    /// Paste, where the menu is the field's own). Sent to the typing worker
    /// only, behind the [`WorkerMessage::EndTyping`] of the same click.
    MenuCommand,
    /// A wheel event was dispatched. The scroll it becomes is written with no
    /// place in the order of the events, so a key held behind a dead key
    /// ([`PendingBuffers::key_behind_dead_keys`]) is written now, ahead of
    /// it. Sent to the typing worker only; with no key held it does nothing.
    WriteHeldKey,
    /// Capture started, or a window came to the front: look at the control
    /// that holds the keyboard focus now, so the first key typed into it finds
    /// it known and the field's first value is read without waiting on its
    /// description (docent#761). Sent to the typing worker only; it writes
    /// nothing.
    LookAtFocus,
    /// A key went down that is no part of the recording (its window is not
    /// recorded). Nothing is written for it; it is taken into the accents
    /// that wait ([`super::waiting_accents`]), since it can be a dead key or
    /// take an accent away like any other: the layout it went down on, its
    /// code, and the modifiers and the Caps Lock state of the press
    /// ([`super::key_value::Held::index`]), with [`SYSTEM_MAY_TAKE`] set
    /// where the system may act on the key itself. Sent to the typing worker
    /// only.
    UnrecordedKey {
        layout: i64,
        /// The thread of the window the key went to; `0` where unknown.
        thread: u32,
        key_code: u32,
        held: u8,
    },
    /// The worker did not get every key-down in the order pressed: which
    /// accent waits is not known ([`super::waiting_accents`]). Sent to the
    /// typing worker only.
    AccentsNotKnown,
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
    /// How many of the last buffered keys are dead keys (see
    /// [`is_dead_key`]) with no other key behind them. A dead key enters
    /// nothing by itself, so no value change follows it and the wait says
    /// nothing about it: it stays buffered until the next key or the end of
    /// the typing decides what it was. No pending `type` holds its text, so
    /// a `type` written while it waits does not supersede it.
    pub pending_dead_keys: usize,
    /// The typing ended while those dead keys waited behind keys no value
    /// change had reached: they are keys now, written behind those keys when
    /// their wait ends, and no key pressed later makes them text.
    pub dead_keys_are_keys: bool,
    /// The accent of each dead key waiting at the end of the buffered keys
    /// ([`dead_key_accent`]), in the order pressed.
    pub waiting_accents: Vec<Option<char>>,
    /// What the field held when the first of those dead keys was pressed,
    /// where it was read then.
    pub value_at_dead_key: Option<String>,
    /// A key that is no typing key, pressed behind dead keys that wait and
    /// held until it is known what they were: a program can enter the bare
    /// accent as a character with such a key (docent#769). The buffered keys
    /// are then those dead keys and no other. It is written behind them when
    /// a value taken for the field decides it, when its wait for one is over,
    /// or ahead of whatever is written next.
    pub key_behind_dead_keys: Option<ActionEvent>,
    /// How many of `pending_keys`, from the first, are written as keys after
    /// the pending `type`: their value change came, and its value was read after a later key of the
    /// window had been dispatched, so it was not taken (docent#761). The
    /// pending `type` keeps the last value read in time, and these keys are
    /// written after it, as keys, unless a value read in time supersedes
    /// them.
    pub keys_after_type: usize,
    /// The pool's record of what each key-down was named
    /// ([`NamedPresses`]), one for all its workers: handed to a worker with
    /// its buffers. No buffer of its own.
    pub named_presses: Arc<NamedPresses>,
}

impl PendingBuffers {
    fn new() -> Self {
        Self::default()
    }

    /// The typing in a field has ended: write the pending `type` (if any),
    /// then the keys after its value ([`keys_after_type`](Self::keys_after_type)),
    /// as keys. The other buffered keys, which no value change has reached
    /// yet, stay buffered. Used at points where a type event must be
    /// committed before another action (context switch, control key).
    fn flush_pending_type_only(&mut self, action_sender: &mpsc::Sender<ActionEvent>) {
        flush_pending_type(&mut self.pending_type, action_sender);
        self.write_keys_after_type(true, action_sender);
        if self.pending_keys.is_empty() {
            self.pending_keys_last_timestamp = 0;
        }
    }

    /// Write, as keys, the keys after the `type`
    /// ([`keys_after_type`](Self::keys_after_type)) when `after_type`, which
    /// are then none; otherwise the keys behind them, which no value change
    /// has reached. The one place either is taken from the buffer.
    fn write_keys_after_type(
        &mut self,
        after_type: bool,
        action_sender: &mpsc::Sender<ActionEvent>,
    ) {
        let split = self.keys_after_type.min(self.pending_keys.len());
        let keys = if after_type {
            self.keys_after_type = 0;
            self.pending_keys.drain(..split)
        } else {
            self.pending_keys.drain(split..)
        };
        for event in keys {
            let _ = action_sender.send(event);
        }
    }

    /// Write every buffered key as a key, and behind them the key held
    /// behind waiting dead keys.
    fn write_keys(&mut self, action_sender: &mpsc::Sender<ActionEvent>) {
        flush_pending_keys(&mut self.pending_keys, action_sender);
        if let Some(key) = self.key_behind_dead_keys.take() {
            let _ = action_sender.send(key);
        }
        self.pending_keys_last_timestamp = 0;
        self.keys_after_type = 0;
        self.no_dead_key_waits();
    }

    /// No dead key waits at the end of the buffered keys any more.
    fn no_dead_key_waits(&mut self) {
        self.pending_dead_keys = 0;
        self.dead_keys_are_keys = false;
        self.waiting_accents.clear();
        self.value_at_dead_key = None;
    }

    /// A typing key was buffered: count it among the waiting dead keys where
    /// it is one (`dead`, with its `accent` and the field's value read at
    /// the press), and end their wait where it is none.
    fn note_buffered_key(&mut self, dead: bool, accent: Option<char>, value: Option<String>) {
        if !dead {
            self.pending_dead_keys = 0;
            self.waiting_accents.clear();
            self.value_at_dead_key = None;
            return;
        }
        // The key itself is the last buffered one.
        let waiting = self
            .pending_dead_keys
            .min(self.pending_keys.len().saturating_sub(1));
        if waiting == 0 {
            self.waiting_accents.clear();
            self.value_at_dead_key = value;
        }
        self.waiting_accents.truncate(waiting);
        self.waiting_accents.resize(waiting, None);
        self.waiting_accents.push(accent);
        self.pending_dead_keys = waiting + 1;
    }

    /// A value was taken for the field's `type`: discard the waiting dead
    /// keys whose accent the program entered as a character, which are part
    /// of that text (docent#769). The program entered one where `value`
    /// holds the accent more often than the field did `before` the first of
    /// them was pressed; that many of the dead keys with the accent, from
    /// the first, are text.
    ///
    /// Only where every buffered key is such a dead key and `before` is
    /// known: text of other keys that no value has reached could hold the
    /// accent too, and nothing would tell whose it is. The dead keys then
    /// stay as they are.
    fn take_dead_keys_entered(&mut self, before: Option<&str>, value: &str) {
        let waiting = self.undecided_dead_keys();
        let Some(before) = before else { return };
        if waiting == 0
            || waiting != self.pending_keys.len()
            || waiting != self.waiting_accents.len()
        {
            return;
        }
        let mut entered: Vec<(char, usize)> = Vec::new();
        let mut kept_keys = Vec::with_capacity(waiting);
        let mut kept_accents = Vec::with_capacity(waiting);
        for (key, accent) in self
            .pending_keys
            .drain(..)
            .zip(self.waiting_accents.drain(..))
        {
            let is_text = accent.is_some_and(|accent| {
                let left = match entered.iter_mut().find(|(known, _)| *known == accent) {
                    Some((_, left)) => left,
                    None => {
                        let gained = value
                            .matches(accent)
                            .count()
                            .saturating_sub(before.matches(accent).count());
                        entered.push((accent, gained));
                        &mut entered.last_mut().expect("just pushed").1
                    }
                };
                let text = *left > 0;
                *left = left.saturating_sub(1);
                text
            });
            if !is_text {
                kept_keys.push(key);
                kept_accents.push(accent);
            }
        }
        self.pending_dead_keys = kept_keys.len();
        self.pending_keys = kept_keys;
        self.waiting_accents = kept_accents;
        // The dead keys left wait behind this value: it is what the field
        // held before any accent of theirs.
        self.value_at_dead_key = (self.pending_dead_keys > 0).then(|| value.to_string());
    }

    /// Whether every buffered key was pressed in `element` of `context_id`:
    /// the field a value was taken for.
    fn dead_keys_wait_in(&self, context_id: Option<i64>, element: &ElementDescription) -> bool {
        self.pending_keys.iter().all(|key| {
            key.context_id == context_id
                && matches!(&key.payload,
                    ActionPayload::Key { element: pressed_in, .. } if same_field(pressed_in, element))
        })
    }

    /// The key held behind waiting dead keys is written now, behind them:
    /// what is written next must not come ahead of it.
    fn write_key_behind_dead_keys(&mut self, action_sender: &mpsc::Sender<ActionEvent>) {
        if self.key_behind_dead_keys.is_some() {
            self.write_keys(action_sender);
        }
    }

    /// Discard the buffered keys a value read in time made text. A dead key
    /// waiting at the end of the buffer stays: it enters nothing by itself,
    /// so the value is the text of the keys before it.
    fn clear_keys(&mut self) {
        let waiting = self.waiting_dead_keys();
        let text_keys = self.pending_keys.len() - waiting;
        self.pending_keys.drain(..text_keys);
        self.keys_after_type = 0;
        if waiting == 0 {
            self.pending_keys_last_timestamp = 0;
            self.no_dead_key_waits();
        }
    }

    /// The typing in a field has ended: write the pending `type` and the
    /// keys after it, and settle a dead key still waiting for the key after
    /// it. No character follows it now, so it is a key; no value change that
    /// comes later is its own.
    ///
    /// Where it is the only key buffered it is written here. Where keys no
    /// value change has reached are buffered ahead of it, it is written
    /// behind them, in the order pressed: here where their wait for a value
    /// change is over at `now`, otherwise when that wait ends
    /// ([`write_keys_that_took_no_text`]), or behind the `type` their value
    /// change makes. Writing them here regardless would write a key beside
    /// its own text.
    fn end_typing(&mut self, now: u64, action_sender: &mpsc::Sender<ActionEvent>) {
        self.flush_pending_type_only(action_sender);
        if self.waiting_dead_keys() == 0 {
            return;
        }
        if self.waiting_dead_keys() == self.pending_keys.len() {
            self.write_keys(action_sender);
            return;
        }
        self.dead_keys_are_keys = true;
        write_keys_that_took_no_text(self, now, action_sender);
    }

    /// How many dead keys at the end of the buffered keys still wait for the
    /// key after them: none once the end of the typing made them keys.
    fn undecided_dead_keys(&self) -> usize {
        if self.dead_keys_are_keys {
            0
        } else {
            self.waiting_dead_keys()
        }
    }

    /// How many dead keys wait at the end of the buffered keys.
    fn waiting_dead_keys(&self) -> usize {
        self.pending_dead_keys.min(self.pending_keys.len())
    }

    /// Write the pending `type` and then every buffered key, each once: the
    /// keys after the `type`, the keys no value change has reached, and a
    /// dead key waiting at the end of the buffer, which is no part of a
    /// `type` and is written behind it, as a key.
    fn drain_typing_into(&mut self, action_sender: &mpsc::Sender<ActionEvent>) {
        self.flush_pending_type_only(action_sender);
        self.write_keys(action_sender);
    }

    /// Drain all buffered actions, emitting them via `action_sender`.
    ///
    /// The pending `type`, then every buffered key, each once: the keys after
    /// the `type` are not in the `type`'s value, which was read before them, and a key
    /// no value change has reached yet is not either (docent#761). Returns
    /// after the buffers are empty. Safe to call more than once and from
    /// either the worker or the shutdown drainer — whoever calls first
    /// empties the buffers; subsequent calls are no-ops.
    fn drain_into(&mut self, action_sender: &mpsc::Sender<ActionEvent>) {
        self.drain_typing_into(action_sender);
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
    /// What each key-down was named, shared by the workers
    /// ([`PendingBuffers::named_presses`]).
    named_presses: Arc<NamedPresses>,
    /// The typing worker: the one worker every keyboard and value-change event
    /// reaches, so its queue processes a value change after the keystrokes
    /// that caused it and the typing state it judges them with (buffered keys,
    /// the pending type, the last values) is whole. Chosen by shortest queue
    /// at the first such event, kept across a respawn of its index, and given
    /// up when a flush barrier finds it unresponsive ([`flush_all`](Self::flush_all)),
    /// so typing does not queue behind a wedged accessibility call for the
    /// rest of the capture. `NO_TYPING_WORKER` while none is chosen.
    typing_worker: AtomicUsize,
    /// Whether the typing role was given out before: a worker that gets it
    /// after another is told that it did not get every key
    /// ([`WorkerMessage::AccentsNotKnown`]).
    typing_worker_chosen_before: bool,
    /// The workers that did not answer the most recent flush barrier, one bit
    /// per index. The typing and focus roles are not given to one of them while another
    /// worker is available; a respawn clears its index's bit.
    missed_last_barrier: AtomicU64,
    /// The focus worker: the one worker every focus event reaches, whatever
    /// window the event named, so it compares each focus with the last focus
    /// it wrote (docent#735). Chosen like the typing worker, at
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
        let named_presses = Arc::new(NamedPresses::new());

        for index in 0..count {
            let (tx, rx) = mpsc::channel();
            let queue_len = Arc::new(AtomicU64::new(0));
            let pending: SharedPendingBuffers = Arc::new(Mutex::new(PendingBuffers {
                named_presses: Arc::clone(&named_presses),
                ..PendingBuffers::new()
            }));
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
            named_presses,
            typing_worker: AtomicUsize::new(NO_TYPING_WORKER),
            typing_worker_chosen_before: false,
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
        if ends_typing(&event) {
            self.tell_typing_worker(WorkerMessage::EndTyping);
        }
        if is_menu_command(&event) {
            self.tell_typing_worker(WorkerMessage::MenuCommand);
        }
        if matches!(event.event_type, RawEventType::Scroll) {
            self.tell_typing_worker(WorkerMessage::WriteHeldKey);
        }
        let comes_to_front = matches!(event.event_type, RawEventType::Foreground);
        let worker_index = self.select_worker(&event);
        if matches!(event.event_type, RawEventType::Keyboard) {
            // Before it is sent: its name is awaited from here on.
            self.named_presses.expect(event.sequence_id);
        }
        self.send_to_worker(worker_index, event);
        if comes_to_front {
            self.look_at_focus();
        }
    }

    /// Ask the typing worker to look at the control that holds the keyboard
    /// focus ([`WorkerMessage::LookAtFocus`]): at the start of a capture, and
    /// whenever a window comes to the front. Choosing the typing worker here
    /// is what makes the look reach the worker the keys will go to.
    pub fn look_at_focus(&mut self) {
        let index = self.typing_worker_index();
        if let Some(worker) = self.workers.get(index) {
            let _ = worker.sender.send(WorkerMessage::LookAtFocus);
        }
    }

    /// The typing worker, chosen by shortest queue among the workers that
    /// answered the last flush barrier when none holds the role.
    fn typing_worker_index(&mut self) -> usize {
        let current = self.typing_worker.load(Ordering::SeqCst);
        if current != NO_TYPING_WORKER {
            return current;
        }
        let idx = self.responsive_shortest_queue_worker();
        self.typing_worker.store(idx, Ordering::SeqCst);
        // A worker that takes the role over did not get the keys before it:
        // which accent waits is not known to it.
        if self.typing_worker_chosen_before {
            if let Some(worker) = self.workers.get(idx) {
                let _ = worker.sender.send(WorkerMessage::AccentsNotKnown);
            }
        }
        self.typing_worker_chosen_before = true;
        idx
    }

    /// The typing in a field has ended with no event to dispatch: a window
    /// the recording keeps nothing of (the recorder's own window, or one
    /// outside the application recorded) came to the front. The `type` held
    /// is written then, as it is when a recorded window comes to the front
    /// (docent#768).
    pub fn end_typing(&mut self) {
        self.tell_typing_worker(WorkerMessage::EndTyping);
    }

    /// A key went down that is no part of the recording
    /// ([`WorkerMessage::UnrecordedKey`]). It goes to the typing worker, one
    /// chosen now where none holds the role, so it is taken in the order
    /// pressed among the keys recorded.
    pub fn unrecorded_key(&mut self, layout: i64, thread: u32, key_code: u32, held: u8) {
        let index = self.typing_worker_index();
        if let Some(worker) = self.workers.get(index) {
            let _ = worker.sender.send(WorkerMessage::UnrecordedKey {
                layout,
                thread,
                key_code,
                held,
            });
        }
    }

    /// Send the typing worker a message that is no event: that the typing in
    /// a field has ended, or that a menu item was clicked. With no typing
    /// worker yet there is no pending `type` and no field typed into; a
    /// worker whose channel is gone has its buffers drained when it is
    /// respawned.
    fn tell_typing_worker(&mut self, message: WorkerMessage) {
        let index = self.typing_worker.load(Ordering::SeqCst);
        if let Some(worker) = self.workers.get(index) {
            let _ = worker.sender.send(message);
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
            RawEventType::Keyboard | RawEventType::ValueChange => self.typing_worker_index(),
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
        let pending: SharedPendingBuffers = Arc::new(Mutex::new(PendingBuffers {
            named_presses: Arc::clone(&self.named_presses),
            ..PendingBuffers::new()
        }));
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

        // A replacement of the typing worker did not get the keys the worker
        // before it got: which accent waits is not known to it.
        if self.typing_worker.load(Ordering::SeqCst) == index {
            let _ = self.workers[index]
                .sender
                .send(WorkerMessage::AccentsNotKnown);
        }

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
    /// context of that window (DCP-21).
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

    /// Whether the context of the top-level window `window` was introduced
    /// by an event the Input_Thread dispatched before the event numbered
    /// `sequence_id`: a `context_switch` or `context_open` into it, or the
    /// session's first action, in it (DCP-20). A worker that records an
    /// action in a window other than the one its event named asks this, as
    /// the Input_Thread introduced only that one. A platform that does not
    /// keep the record returns `true` always.
    fn context_introduced_before(&self, _window: i64, _sequence_id: u64) -> bool {
        true
    }

    /// The number of the latest key press the Input_Thread dispatched in
    /// `window`; each keystroke carries its own number
    /// ([`RawEvent::callback_params`], see [`KeyNumbers`]). While the two are
    /// equal, no later key of that window has been dispatched. A platform
    /// that numbers no keys returns `0` always, and its keystrokes carry `0`.
    fn keys_dispatched(&self, _window: i64) -> u64 {
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

    /// Whether the window `control` answers a message within
    /// [`PROMPT_ANSWER_MS`] (a program not hung). Asked before the look ahead
    /// of the keys ([`WorkerMessage::LookAtFocus`]), which no key waits on, so
    /// a program that answers late is not described then. A platform that
    /// cannot ask answers `true`.
    fn answers_promptly(&self, _control: i64) -> bool {
        true
    }

    /// The id of the process that owns `window_handle`; `0` where unknown.
    fn process_id_of(&self, _window_handle: i64) -> u32 {
        0
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

    /// What keyboard layout `layout` (the value a keystroke carries in
    /// [`RawEvent::keyboard_layout`]) gives key `key_code` as pressed with
    /// `held`, as a keyboard event carries it
    /// ([`super::key_value::pressed_param`]). `0` where the layout cannot be
    /// asked (no layout, a platform with no such read, or not now).
    fn key_value(&self, _layout: i64, _key_code: u32, _held: super::key_value::Held) -> u32 {
        0
    }

    /// Whether keyboard layout `layout` (a layout handle, as
    /// [`super::held_keys::CtrlAltRead::layout`] holds it) makes the right
    /// Alt AltGr, as the layout's own file states it. `None` where that
    /// cannot be read (no layout, a platform with no such read, a file that
    /// is not in the form read).
    fn layout_alt_gr(&self, _layout: i64) -> Option<bool> {
        None
    }

    /// What keyboard layout `layout` lists for `accent` and `base` together:
    /// the one character a program enters for a key that gives `base`,
    /// pressed behind a dead key with that accent, or an accent that waits in
    /// its turn. `None` where the layout lists nothing for the two;
    /// [`NoList`](super::waiting_accents::NoList) where its list cannot be
    /// read (a platform with none, or a layout file that is not in the form
    /// read).
    fn composed(
        &self,
        _layout: i64,
        _accent: super::layout_file::Accent,
        _base: char,
    ) -> Result<Option<super::layout_file::Composed>, super::waiting_accents::NoList> {
        Err(super::waiting_accents::NoList)
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

/// `VK_PACKET`: the virtual-key code a keystroke injected as Unicode
/// (`SendInput` with `KEYEVENTF_UNICODE` — IME results, remote-desktop stacks,
/// software keyboards, automation) reaches the low-level hook with. Its scan
/// code carries the injected UTF-16 code unit, which the hook passes on in
/// `RawEvent::callback_params[0]` (docent#260).
pub(crate) const VK_PACKET: u32 = 0xE7;

/// The key value for a key whose identity is not known — the browser's own
/// value for that case, so the desktop names it the way the extension would.
const UNIDENTIFIED_KEY: &str = "Unidentified";

/// Name a keyboard event's key, by the W3C UI Events `key` values (the
/// session-format document states the rule under Key names):
///
/// - a `VK_PACKET` keystroke by the character its code unit carries, and
///   `Unidentified` for a unit that is no character on its own (a surrogate
///   half of a character outside the Basic Multilingual Plane, or a control
///   character);
/// - Shift, Control and Alt by their generic codes, and the empty name for
///   their left and right codes, which a caller skips;
/// - the space bar `Space` where no layout was read;
/// - a key with a name of its own by that name
///   ([`super::key_value::named_key`]), the mode keys by the language of the
///   layout read at the press;
/// - every other key by what the layout gave the press
///   ([`RawEvent::key_value`]): the character, a space as `Space`, `Dead` for
///   a dead key, and `Unidentified` where the layout gave nothing or was not
///   read. No name is guessed from the key's code.
fn key_name(raw: &RawEvent) -> String {
    key_name_of(
        raw.key_code,
        raw.callback_params[0],
        raw.key_value,
        super::key_value::primary_language(raw.keyboard_layout),
    )
}

/// The `key` value of the space bar, and of any key that gives a space.
const SPACE_KEY: &str = "Space";

/// [`key_name`] for a key by its code, its scan code (`callback_params[0]`),
/// what the layout gave the press and the layout's primary language.
fn key_name_of(key_code: u32, scan_code: i64, key_value: u32, language: u16) -> String {
    use super::key_value::{answer_of, key_value_name, named_key};
    match key_code {
        VK_PACKET => match char::from_u32((scan_code & 0xFFFF) as u32) {
            Some(' ') => SPACE_KEY.to_string(),
            Some(c) if !c.is_control() => c.to_string(),
            _ => UNIDENTIFIED_KEY.to_string(),
        },
        0x10 => "Shift".to_string(),
        0x11 => "Control".to_string(),
        0x12 => "Alt".to_string(),
        // VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU.
        0xA0..=0xA5 => String::new(),
        // The space bar where no layout was read. Where one was, the key is
        // named by what the layout gives it, a space among them.
        0x20 if answer_of(key_value).is_none() => SPACE_KEY.to_string(),
        _ => match named_key(key_code, language) {
            Some(name) => name.to_string(),
            None => key_value_name(answer_of(key_value)),
        },
    }
}

/// Whether a virtual-key code is a punctuation key: one of the OEM codes
/// (`0xBA`-`0xC2`, `0xDB`-`0xDF`, `0xE1`-`0xE4`, `0xE6`), whose character each
/// keyboard layout assigns for itself. Called on the keyboard hook: no
/// allocation, no lock.
pub(crate) const fn is_punctuation_key(vk: u32) -> bool {
    matches!(vk, 0xBA..=0xC2 | 0xDB..=0xDF | 0xE1..=0xE4 | 0xE6)
}

/// The modifiers and the Caps Lock state of a keystroke, as a layout is asked
/// with them.
pub(crate) const fn held_of(raw: &RawEvent) -> super::key_value::Held {
    let (ctrl, shift, alt, _meta) = raw.modifiers;
    super::key_value::Held {
        shift,
        ctrl,
        alt,
        caps_lock: raw.caps_lock,
    }
}

/// `raw` with what the layout gives its key, and each key held at it, filled
/// in from `backend` ([`RawEvent::key_value`]): the keystroke's own key as
/// pressed, and a held key as it was pressed at its own key-down. A value
/// already there is kept. `None` where there is nothing to fill in.
fn with_key_values<B: AccessibilityBackend>(raw: &RawEvent, backend: &B) -> Option<RawEvent> {
    use super::key_value::Held;
    let own = matches!(raw.event_type, RawEventType::Keyboard) && raw.key_value == 0;
    if !own && raw.held.iter().all(|k| k.key_value != 0) {
        return None;
    }
    let mut filled = raw.clone();
    if own {
        filled.key_value = backend.key_value(raw.keyboard_layout, raw.key_code, held_of(raw));
    }
    for key in filled.held.iter_mut().filter(|k| k.key_value == 0) {
        key.key_value = backend.key_value(
            key.layout,
            key.key_code,
            Held::from_index(usize::from(key.held)),
        );
    }
    Some(filled)
}

/// The modifier keys held at a raw event, as its action states them: AltGr as
/// `alt_graph`, and `ctrl` and `alt` only for a Ctrl and an Alt the person
/// held, where the platform read the Ctrl and Alt keys
/// (`RawEvent::ctrl_alt_read`); whether the layout read makes the right Alt
/// AltGr is asked of `backend`.
fn modifiers_of<B: AccessibilityBackend>(raw: &RawEvent, backend: &B) -> Modifiers {
    let (ctrl, shift, alt, meta) = raw.modifiers;
    let held = raw.ctrl_alt_read.map_or(
        super::held_keys::CtrlAltHeld {
            ctrl,
            alt,
            alt_graph: false,
        },
        |read| read.held(backend.layout_alt_gr(read.layout)),
    );
    Modifiers {
        ctrl: held.ctrl,
        shift,
        alt: held.alt,
        meta,
        alt_graph: held.alt_graph,
    }
}

/// The keys that were down at a raw event, as its action states them.
///
/// Each key is named as its own `key` action names it: by what the layout
/// gave it as it was pressed, and where it was pressed behind an accent that
/// waited, by what that key-down was named ([`held_key_value`]). The hook's
/// record lists no modifier key, so every key here has such a name.
fn held_at<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    presses: &NamedPresses,
) -> HeldKeysAtAction {
    // One wait for the action, whatever number of keys is held at it.
    let wait_ends = Instant::now() + HELD_NAME_WAIT;
    let (held_keys, held_presses) = raw
        .held
        .iter()
        .map(|k| {
            let as_pressed = if k.key_value != 0 {
                k.key_value
            } else {
                backend.key_value(
                    k.layout,
                    k.key_code,
                    super::key_value::Held::from_index(usize::from(k.held)),
                )
            };
            (
                key_name_of(
                    k.key_code,
                    i64::from(k.scan_code),
                    held_key_value(k, as_pressed, presses, wait_ends),
                    super::key_value::primary_language(k.layout),
                ),
                k.press,
            )
        })
        .unzip();
    HeldKeysAtAction {
        held_keys,
        held_presses,
    }
}

/// How long a worker waits at one action for the typing worker to name the
/// key-downs its held keys are down by, before it names a key
/// `Unidentified`.
const HELD_NAME_WAIT: Duration = if cfg!(test) {
    Duration::from_millis(60)
} else {
    Duration::from_secs(5)
};

/// The value a held key is named by: `as_pressed`, what the layout gave it
/// as it was pressed, or what its own key-down was named where that is
/// another ([`NamedPresses`]). Only a key that gives a character or is a dead
/// key is ever named otherwise, so no other key is asked about.
///
/// The typing worker names the keys in the order pressed; another worker can
/// get to an action before the typing worker got to the held key's key-down.
/// It then waits for that name until `wait_ends` ([`HELD_NAME_WAIT`] from
/// when the action's held keys were first asked about), and names the key
/// `Unidentified` where none came: no name is guessed.
fn held_key_value(
    key: &super::held_keys::HeldPress,
    as_pressed: u32,
    presses: &NamedPresses,
    wait_ends: Instant,
) -> u32 {
    use super::key_value::{as_held_of, with_value, LayoutAnswer};
    use super::waiting_accents::PressName;
    let renamable = key.press != 0
        && key.key_code != VK_PACKET
        && matches!(
            as_held_of(as_pressed),
            Some(LayoutAnswer::Char(_) | LayoutAnswer::Dead(_))
        );
    if !renamable {
        return as_pressed;
    }
    match presses.of(
        key.press,
        wait_ends.saturating_duration_since(Instant::now()),
    ) {
        PressName::AsPressed => as_pressed,
        PressName::Renamed(value) => value,
        PressName::NotKnown => with_value(as_pressed, LayoutAnswer::Nothing),
    }
}

/// A key-down named: `raw` with what the layout gives its key and the keys
/// held at it filled in ([`with_key_values`]), and with its key named by what
/// it makes with an accent that waited ([`name_behind_waiting_accent`]).
/// `None` where `raw` stands as it is.
fn key_as_named<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    state: &mut WorkerState,
) -> Option<RawEvent> {
    let filled = with_key_values(raw, backend);
    let named = name_behind_waiting_accent(
        filled.as_ref().unwrap_or(raw),
        backend,
        &mut state.accents,
        &state.named_presses,
    );
    named.or(filled)
}

/// Take the key-down `raw` (its key's value filled in) into the accents that
/// wait, note what it was named for the workers that state held keys, and
/// give `raw` with its key renamed where an accent that waited renames it:
/// by the one character the two make, or as not known (`Unidentified`) where
/// it is not known whether an accent waited ([`super::waiting_accents`]).
///
/// Called for every key-down the typing worker gets, in the order pressed,
/// whether or not an action is written for it. An injected character
/// (`VK_PACKET`) is left out: it reaches the program as the character it
/// carries, past the layout.
fn name_behind_waiting_accent<B: AccessibilityBackend>(
    raw: &RawEvent,
    backend: &B,
    accents: &mut WaitingAccents,
    presses: &NamedPresses,
) -> Option<RawEvent> {
    use super::key_value::{as_held_of, with_value, Held, LayoutAnswer};
    use super::waiting_accents::{met_by_an_accent, Named};
    if raw.key_code == VK_PACKET || is_shift_ctrl_or_alt(raw.key_code) {
        presses.note(raw.sequence_id, None);
        return None;
    }
    let layout = raw.keyboard_layout;
    let thread = raw.keyboard_thread;
    let (ctrl, shift, alt, _meta) = raw.modifiers;
    let held = Held {
        shift,
        ctrl,
        alt,
        caps_lock: raw.caps_lock,
    };
    let meets = met_by_an_accent(as_held_of(raw.key_value), raw.key_code, held);
    let composed = |accent, base| backend.composed(layout, accent, base);
    let named = if super::scroll::system_takes_key(raw.key_code, raw.modifiers) {
        accents.press_the_system_may_take(layout, thread, meets, composed)
    } else {
        accents.press(layout, thread, meets, composed)
    };
    let value = match named {
        Named::AsPressed => None,
        Named::Composed(made) => Some(with_value(raw.key_value, LayoutAnswer::Char(made))),
        Named::NotKnown => Some(with_value(raw.key_value, LayoutAnswer::Nothing)),
    };
    presses.note(raw.sequence_id, value);
    value.map(|value| RawEvent {
        key_value: value,
        ..raw.clone()
    })
}

/// Set in the `held` of a [`WorkerMessage::UnrecordedKey`] where the system
/// may act on the key itself ([`super::scroll::system_takes_key`]).
pub const SYSTEM_MAY_TAKE: u8 = 0x10;

/// Whether a virtual-key code is a Shift, Control or Alt key's, generic or
/// left or right: a key that gives nothing on any layout.
const fn is_shift_ctrl_or_alt(key_code: u32) -> bool {
    matches!(key_code, 0x10..=0x12 | 0xA0..=0xA5)
}

/// Take a key-down that is no part of the recording into the accents that
/// wait ([`WorkerMessage::UnrecordedKey`]). Nothing is written or kept of
/// it but what waits afterwards.
fn note_unrecorded_key<B: AccessibilityBackend>(
    layout: i64,
    thread: u32,
    key_code: u32,
    held: u8,
    backend: &B,
    accents: &mut WaitingAccents,
) {
    use super::key_value::{as_held_of, Held};
    use super::waiting_accents::met_by_an_accent;
    if key_code == VK_PACKET || is_shift_ctrl_or_alt(key_code) {
        return;
    }
    let system_may_take = held & SYSTEM_MAY_TAKE != 0;
    let held = Held::from_index(usize::from(held & 0x0F));
    let value = backend.key_value(layout, key_code, held);
    let meets = met_by_an_accent(as_held_of(value), key_code, held);
    let composed = |accent, base| backend.composed(layout, accent, base);
    let _ = if system_may_take {
        accents.press_the_system_may_take(layout, thread, meets, composed)
    } else {
        accents.press(layout, thread, meets, composed)
    };
}

/// Whether a key name is the empty name [`key_name`] gives the
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

/// Whether a keystroke is a dead key: it enters nothing by itself; its accent
/// goes into the character the next key enters.
///
/// Where the worker asked the layout's table about the press
/// ([`RawEvent::key_value`]), the answer is the table's, Caps Lock counted.
/// Otherwise:
///
/// Where the keyboard hook asked the layout about the key as pressed, with
/// the modifiers held ([`super::held_keys::dead_as_pressed_of`]), the answer
/// is the layout's: a key dead with Shift or AltGr is a dead key, and a key
/// dead only without them is none when pressed with one.
///
/// Where the hook did not ask, what is known is the dead-key flag of the
/// unmodified key (bit 31 of the layout character). It counts for a press
/// with neither Shift nor AltGr (Ctrl and Alt together); with one of them the
/// key is taken for an ordinary one.
fn is_dead_key(raw: &RawEvent) -> bool {
    if !is_printable_key(raw) {
        return false;
    }
    // What the layout's table says of the press with the modifiers and the
    // Caps Lock state as held, where the worker asked it: the read the key's
    // name comes from, so the two agree.
    if let Some(dead) = super::key_value::dead_as_held_of(raw.key_value) {
        return dead;
    }
    if let Some(read) = super::held_keys::dead_as_pressed_of(raw.callback_params[3]) {
        return matches!(read, super::held_keys::AsPressed::DeadKey { .. });
    }
    let (ctrl, shift, alt, _meta) = raw.modifiers;
    !shift
        && !(ctrl && alt)
        && super::held_keys::layout_char_of(raw.callback_params[3]) & 0x8000_0000 != 0
}

/// The accent a dead key carries: the character a program enters for it
/// where no character takes the accent (the key pressed twice, or a key that
/// is no typing key behind it). The layout's answer for the key as pressed
/// where the hook asked, otherwise the layout character of the unmodified
/// key. `None` for a key that is no dead key and where the layout named none.
fn dead_key_accent(raw: &RawEvent) -> Option<char> {
    if !is_dead_key(raw) {
        return None;
    }
    let code = match super::held_keys::dead_as_pressed_of(raw.callback_params[3]) {
        Some(super::held_keys::AsPressed::DeadKey { accent }) => u32::from(accent),
        _ => super::held_keys::layout_char_of(raw.callback_params[3]) & 0xFFFF,
    };
    char::from_u32(code).filter(|accent| *accent != '\0')
}

/// Whether a keystroke is a paste key: V with Ctrl (with or without Shift), or
/// Insert with Shift alone. The value change that follows one is the pasted
/// text. A paste made from a menu has no such key.
fn is_paste_key(raw: &RawEvent) -> bool {
    let (ctrl, shift, alt, meta) = raw.modifiers;
    match raw.key_code {
        0x56 => ctrl && !alt && !meta,
        0x2D => shift && !ctrl && !alt && !meta,
        _ => false,
    }
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
        0x20 | 0x30..=0x39 | 0x41..=0x5A | 0x60..=0x6F | VK_PACKET
    ) || is_punctuation_key(key_code)
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

/// What the keyboard hook read of the input method at a keystroke (the fourth
/// callback parameter, above the repeat mark; see
/// [`RawEvent::callback_params`]), as the `key` action states it.
fn input_method_at(raw: &RawEvent) -> super::InputMethodAtKey {
    super::held_keys::input_method_of(raw.callback_params[0]).into()
}

/// The key names that enter no character: Shift, Control and Alt, and every
/// key with a name of its own ([`super::key_value::named_key`]) except
/// `Process`, the key an input method took, which stands for a typing key.
/// The function keys (`F1` to `F24`) join them by their form. The adapter's
/// sensitive-field rule keeps the same list
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
    "Cancel",
    "Clear",
    "JunjaMode",
    "FinalMode",
    "Convert",
    "NonConvert",
    "Accept",
    "ModeChange",
    "Select",
    "Print",
    "Execute",
    "Help",
    "ContextMenu",
    "Standby",
    "BrowserBack",
    "BrowserForward",
    "BrowserRefresh",
    "BrowserStop",
    "BrowserSearch",
    "BrowserFavorites",
    "BrowserHome",
    "AudioVolumeMute",
    "AudioVolumeDown",
    "AudioVolumeUp",
    "MediaTrackNext",
    "MediaTrackPrevious",
    "MediaStop",
    "MediaPlayPause",
    "LaunchMail",
    "LaunchMediaPlayer",
    "LaunchApplication1",
    "LaunchApplication2",
    "Attn",
    "CrSel",
    "ExSel",
    "EraseEof",
    "Play",
    "ZoomToggle",
    "HangulMode",
    "HanjaMode",
    "KanaMode",
    "KanjiMode",
    "Alphanumeric",
    "Katakana",
    "Hiragana",
    "Hankaku",
    "Zenkaku",
    "Romaji",
];

/// Whether a key name is a function key's: `F` and a number.
fn is_function_key_name(key: &str) -> bool {
    key.strip_prefix('F')
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Whether a keystroke into a password field enters text there, and so
/// belongs to the field's masked type: every key except the ones known to
/// enter no character and the shortcuts. The test is closed on the keys that
/// stay keys, so every other name (a character, `Dead`, `Unidentified`,
/// `Process`) counts as text and is masked. Ctrl and Alt held together
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

    let mut state = WorkerState::new(Arc::clone(&lock_buffers(&pending).named_presses));

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
                    // A key-down may not have been taken into the accents
                    // that wait: which waits is no longer known.
                    if matches!(raw.event_type, RawEventType::Keyboard) {
                        state.accents.forget();
                    }
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
                lock_buffers(&pending).end_typing(current_timestamp_ms(), &action_sender);
            }
            Ok(WorkerMessage::MenuCommand) => note_menu_command(&mut state),
            Ok(WorkerMessage::WriteHeldKey) => {
                // In-memory buffer mutation only — no backend calls inside.
                lock_buffers(&pending).write_key_behind_dead_keys(&action_sender);
            }
            Ok(WorkerMessage::UnrecordedKey {
                layout,
                thread,
                key_code,
                held,
            }) => {
                // One read of the layout's table; the buffers are not touched.
                let taken = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    note_unrecorded_key(
                        layout,
                        thread,
                        key_code,
                        held,
                        &backend,
                        &mut state.accents,
                    );
                }));
                if taken.is_err() {
                    state.accents.forget();
                }
            }
            Ok(WorkerMessage::AccentsNotKnown) => state.accents.forget(),
            Ok(WorkerMessage::LookAtFocus) => {
                // Backend calls only; the buffers are not touched.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    look_at_focused_control(
                        &backend,
                        &mut state.controls,
                        excluded_pid.load(Ordering::SeqCst),
                    );
                }));
            }
            Ok(WorkerMessage::Shutdown) => {
                // Drain remaining events in the queue. A message that is no
                // event does not end the drain: the events behind it are the
                // person's too.
                while let Ok(message) = receiver.try_recv() {
                    match message {
                        WorkerMessage::Event(raw) => {
                            queue_len.fetch_sub(1, Ordering::SeqCst);
                            let done =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
                            if done.is_err() && matches!(raw.event_type, RawEventType::Keyboard) {
                                state.accents.forget();
                            }
                        }
                        WorkerMessage::AccentsNotKnown => state.accents.forget(),
                        WorkerMessage::EndTyping => {
                            lock_buffers(&pending)
                                .end_typing(current_timestamp_ms(), &action_sender);
                        }
                        WorkerMessage::MenuCommand => note_menu_command(&mut state),
                        WorkerMessage::WriteHeldKey => {
                            lock_buffers(&pending).write_key_behind_dead_keys(&action_sender);
                        }
                        // No key follows a stop: nothing to look at.
                        WorkerMessage::LookAtFocus => {}
                        // A key recorded can still follow in the queue.
                        WorkerMessage::UnrecordedKey {
                            layout,
                            thread,
                            key_code,
                            held,
                        } => {
                            let taken =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    note_unrecorded_key(
                                        layout,
                                        thread,
                                        key_code,
                                        held,
                                        &backend,
                                        &mut state.accents,
                                    );
                                }));
                            if taken.is_err() {
                                state.accents.forget();
                            }
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
    /// The windows a focus took a `context_switch` into, written by this
    /// worker before it because no event introduced them (docent#817).
    introduced_by_focus: std::collections::HashSet<i64>,
    /// The value of the field typed into last, as last taken for its `type`.
    last_value: Option<LastValue>,
    /// The field a paste key (see [`is_paste_key`]) was pressed in, or the
    /// field typed into last when a menu item was clicked (see
    /// [`note_menu_command`]), until a value change is taken for that field:
    /// that one is the pasted text, also where it repeats the field's value.
    /// A program can report the paste after the keys that follow it, so no
    /// later key ends the wait.
    pasted_into: Option<LastValue>,
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
    /// The accents that wait, from the keys this worker took in the order
    /// pressed. Kept by the typing worker; no other worker gets a key.
    accents: WaitingAccents,
    /// What each key-down was named, shared by the pool's workers.
    named_presses: Arc<NamedPresses>,
}

impl WorkerState {
    fn new(named_presses: Arc<NamedPresses>) -> Self {
        Self {
            accents: WaitingAccents::new(),
            named_presses,
            last_focus: None,
            introduced_by_focus: Default::default(),
            last_value: None,
            pasted_into: None,
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
    /// The key's window, as the Input_Thread attributed it, and its number
    /// among that window's keys (see [`KeyNumbers`]); `0` when not numbered.
    window: i64,
    number: u64,
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

/// The key presses the Input_Thread dispatched, numbered per window
/// (docent#761): each keystroke carries its number
/// ([`key_number_param`]), and a worker that has read a field's value asks
/// for the number of the window's latest key ([`AccessibilityBackend::keys_dispatched`]).
/// While the two are equal, no later key of that window was dispatched, so
/// the program had received no later key when it answered the read.
///
/// Numbers are per window because a key goes to the focus of the window it
/// was pressed in: a key pressed in another window cannot reach the field,
/// so it makes no read of the field late, where one count for all windows
/// would. They are taken
/// from one count for every window, so a number never comes back for a
/// window that was let go and noted again. Written by the
/// Input_Thread only, read by the workers with no lock: a window being
/// replaced in its slot can only answer a later number than its own, and a
/// window not remembered answers [`KeyNumbers::NOT_REMEMBERED`], which is no
/// key's number. Both make a read not count, never the other way round.
#[derive(Debug)]
pub struct KeyNumbers {
    last: AtomicU64,
    slots: [KeySlot; KeyNumbers::WINDOWS],
}

#[derive(Debug)]
struct KeySlot {
    window: std::sync::atomic::AtomicI64,
    latest: AtomicU64,
}

/// The bits a key number takes (see [`key_number_param`]).
const KEY_NUMBER_MASK: u64 = (1 << 30) - 1;

/// Where a key number sits in a keystroke's `callback_params[3]`: the bit
/// above the repeat mark, which sits above the layout character.
///
/// | bits  | holds                                                  |
/// |-------|--------------------------------------------------------|
/// | 0–31  | the layout character ([`super::held_keys::layout_char_of`]), with the dead-key read in bits 16 to 30 |
/// | 32    | the repeat mark ([`super::held_keys::KEY_REPEAT_PARAM`]) |
/// | 33–62 | the key number ([`KEY_NUMBER_MASK`])                   |
/// | 63    | clear: the parameter stays a positive `i64`            |
const KEY_NUMBER_SHIFT: u32 = super::held_keys::KEY_REPEAT_PARAM.trailing_zeros() + 1;

const _: () = assert!(
    KEY_NUMBER_SHIFT + KEY_NUMBER_MASK.count_ones() <= 63,
    "a key number fits below the sign bit"
);

impl KeyNumbers {
    /// How many windows are remembered.
    pub const WINDOWS: usize = 16;

    /// What [`latest`](Self::latest) answers for a window it does not
    /// remember: no key's number.
    pub const NOT_REMEMBERED: u64 = u64::MAX;

    pub const fn new() -> Self {
        Self {
            last: AtomicU64::new(0),
            slots: [const {
                KeySlot {
                    window: std::sync::atomic::AtomicI64::new(0),
                    latest: AtomicU64::new(0),
                }
            }; KeyNumbers::WINDOWS],
        }
    }

    /// Number a key press dispatched in `window` and return its number, never
    /// `0` (which stands for a key not numbered). Called on the Input_Thread
    /// only.
    pub fn number(&self, window: i64) -> u64 {
        let mut number = 0;
        while number == 0 {
            number = (self.last.fetch_add(1, Ordering::SeqCst) + 1) & KEY_NUMBER_MASK;
        }
        let slot = match self
            .slots
            .iter()
            .find(|s| s.window.load(Ordering::SeqCst) == window)
        {
            Some(slot) => slot,
            // The window whose latest key is the oldest is let go (a slot
            // never used holds `0`, older than every number).
            None => self
                .slots
                .iter()
                .min_by_key(|s| s.latest.load(Ordering::SeqCst))
                .expect("KeyNumbers has slots"),
        };
        // The number before the window: a reader that finds the window finds
        // its number or a later one.
        slot.latest.store(number, Ordering::SeqCst);
        slot.window.store(window, Ordering::SeqCst);
        number
    }

    /// The number a keystroke of key `vk` in `window` carries: a key that
    /// can change a field's text is numbered ([`number`](Self::number)); a
    /// Shift, Control or Alt key changes no text, so it carries the number of
    /// the window's latest key and moves nothing for a read of that window
    /// (a window not remembered numbers it, as its first key). Called on the
    /// Input_Thread only.
    pub fn for_key(&self, window: i64, vk: u32) -> u64 {
        match self.latest(window) {
            latest if !numbers_key(vk) && latest != Self::NOT_REMEMBERED => latest,
            _ => self.number(window),
        }
    }

    /// The number of the latest key dispatched in `window`;
    /// [`NOT_REMEMBERED`](Self::NOT_REMEMBERED) when the window is not
    /// remembered.
    pub fn latest(&self, window: i64) -> u64 {
        self.slots
            .iter()
            .find(|s| s.window.load(Ordering::SeqCst) == window)
            .map_or(Self::NOT_REMEMBERED, |s| s.latest.load(Ordering::SeqCst))
    }
}

impl Default for KeyNumbers {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether a keystroke of key `vk` is numbered among its window's keys (see
/// [`KeyNumbers::for_key`]): every key but Shift, Control and Alt, generic
/// (`0x10`–`0x12`) or left and right (`0xA0`–`0xA5`).
pub const fn numbers_key(vk: u32) -> bool {
    !matches!(vk, 0x10..=0x12 | 0xA0..=0xA5)
}

/// A key number as a keystroke's `callback_params[3]` carries it, to be
/// or-ed with the layout character and the repeat mark.
pub const fn key_number_param(number: u64) -> i64 {
    ((number & KEY_NUMBER_MASK) as i64) << KEY_NUMBER_SHIFT
}

/// The number the Input_Thread gave this keystroke among the keys of its
/// window (see [`KeyNumbers`]); `0` when not numbered, and for every event
/// that is no keystroke.
fn key_number_of(raw: &RawEvent) -> u64 {
    if matches!(raw.event_type, RawEventType::Keyboard) {
        ((raw.callback_params[3] >> KEY_NUMBER_SHIFT) as u64) & KEY_NUMBER_MASK
    } else {
        0
    }
}

/// The Input_Thread's record of the contexts a capture session has
/// introduced, by top-level window handle (DCP-20). A raw event that is to be
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

    /// Whether the session has introduced `root`: by a switch or open into
    /// it, or by an action in it.
    pub fn is_introduced(&self, root: i64) -> bool {
        self.introduced.contains(&root)
    }

    /// The number the Input_Thread notes for `root` ([`ContextsIntroducedAt`])
    /// once it has dispatched the event numbered `event`, and ahead of it the
    /// switch numbered `switch` where [`switch_before`](Self::switch_before)
    /// dispatched one: the switch's where there was one, the event's
    /// otherwise; none where `root` is not introduced.
    pub fn introduced_by(&self, root: i64, switch: Option<u64>, event: u64) -> Option<u64> {
        self.is_introduced(root).then(|| switch.unwrap_or(event))
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

/// The number of the event that introduced each context of a capture session,
/// by top-level window handle: the `context_switch` or `context_open` into it,
/// or its first action where that introduced it ([`ContextIntroductions`]).
/// Noted by the Input_Thread as it dispatches, and read by a worker that
/// records an action in a window other than the one its event named
/// (docent#817), so it is shared, behind a lock held only for the map's own
/// work.
#[derive(Debug, Default)]
pub struct ContextsIntroducedAt {
    at: Mutex<std::collections::BTreeMap<i64, u64>>,
}

impl ContextsIntroducedAt {
    /// None introduced, as a `static` can hold it.
    pub const fn new() -> Self {
        Self {
            at: Mutex::new(std::collections::BTreeMap::new()),
        }
    }

    /// Note that the event numbered `sequence_id` introduced `root`; a window
    /// noted already keeps its number.
    pub fn note(&self, root: i64, sequence_id: u64) {
        let mut at = self.at.lock().unwrap_or_else(|e| e.into_inner());
        at.entry(root).or_insert(sequence_id);
    }

    /// Whether an event dispatched before the event numbered `sequence_id`
    /// introduced `root`.
    pub fn introduced_before(&self, root: i64, sequence_id: u64) -> bool {
        let at = self.at.lock().unwrap_or_else(|e| e.into_inner());
        at.get(&root).is_some_and(|noted| *noted < sequence_id)
    }

    /// Forget every context, for a new capture session.
    pub fn clear(&self) {
        self.at.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// The Input_Thread's dispatch of `event`, whose window's top-level window is
/// `root`, while `foreground_root` is in front: where
/// [`ContextIntroductions::switch_before`] says the window needs one, the
/// switch `switch_into` makes for it is sent ahead of the event; then the
/// event. `send` sends one event and answers the number it gave it. Where
/// this dispatch introduced `root`, `introduced_at` notes the number of the
/// switch, or of the event where it took none (docent#817).
pub fn dispatch_introducing(
    contexts: &mut ContextIntroductions,
    introduced_at: &ContextsIntroducedAt,
    event: RawEvent,
    root: i64,
    foreground_root: i64,
    switch_into: impl FnOnce(&RawEvent) -> RawEvent,
    mut send: impl FnMut(RawEvent) -> u64,
) {
    let known = contexts.is_introduced(root);
    let switch = contexts
        .switch_before(&event, root, foreground_root)
        .then(|| send(switch_into(&event)));
    let sequence_id = send(event);
    if !known {
        if let Some(by) = contexts.introduced_by(root, switch, sequence_id) {
            introduced_at.note(root, by);
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
    describe_and_note_control(
        backend,
        controls,
        control,
        KnownControl {
            element: None,
            epoch: raw.focus_epoch,
            part_focus: key_part_focus(raw),
            title,
        },
    )
}

/// Describe the control with window handle `control` and note it as `known`
/// says, with the description; the element it is, `None` for a window that
/// holds other elements and for a control gone, which is not noted.
fn describe_and_note_control<B: AccessibilityBackend>(
    backend: &B,
    controls: &mut HashMap<i64, KnownControl>,
    control: i64,
    known: KnownControl,
) -> Option<ElementDescription> {
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
            ..known
        },
    );
    element
}

/// How long the look ahead of the keys waits for the focused control's
/// window to answer before it leaves the control to its first key (see
/// [`AccessibilityBackend::answers_promptly`]).
pub const PROMPT_ANSWER_MS: u32 = 50;

/// A [`KnownControl::part_focus`] no keystroke carries: a control looked at
/// ahead of its keys has what it is looked at again, with no description, at
/// its first key.
const LOOKED_AT_AHEAD: i64 = i64::MIN;

/// Look at the control that holds the keyboard focus now, ahead of any key
/// typed into it ([`WorkerMessage::LookAtFocus`]), and note it under the
/// focus epoch read before the look: a key under the same count of the
/// person's takes it as [`settle_key_on_its_control`] takes a control it
/// looked at itself, after one look at what the control is
/// ([`LOOKED_AT_AHEAD`]), which needs no description. A control already
/// known, a platform that counts no focus changes (whose keys are never
/// settled on their control) and no focused control leave nothing to do;
/// nor does a control of the excluded process (`excluded_pid`), or one whose
/// window does not answer promptly
/// ([`AccessibilityBackend::answers_promptly`]): no key waits on this look,
/// and the control's first key looks at it itself.
fn look_at_focused_control<B: AccessibilityBackend>(
    backend: &B,
    controls: &mut HashMap<i64, KnownControl>,
    excluded_pid: u32,
) {
    let epoch = backend.focus_epoch();
    if epoch == 0 {
        return;
    }
    let control = backend.focused_control();
    if control == 0 || controls.contains_key(&control) {
        return;
    }
    let window = backend.root_window_handle(control);
    if excluded_pid != 0 && backend.process_id_of(window) == excluded_pid {
        return;
    }
    if !backend.answers_promptly(control) {
        return;
    }
    let title = backend.window_title(window);
    describe_and_note_control(
        backend,
        controls,
        control,
        KnownControl {
            element: None,
            epoch,
            part_focus: LOOKED_AT_AHEAD,
            title,
        },
    );
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
        // A key discarded here went down all the same: it is taken into the
        // accents that wait, and nothing is written for it.
        if matches!(raw.event_type, RawEventType::Keyboard) {
            let _ = key_as_named(raw, backend, state);
        }
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
    if ends_typing(raw) {
        lock_buffers(pending).flush_pending_type_only(action_sender);
    }
    // A key held behind dead keys is written ahead of this event's action. A
    // value change is what it waits for, and a key settles it itself.
    if !matches!(
        raw.event_type,
        RawEventType::ValueChange | RawEventType::Keyboard
    ) {
        lock_buffers(pending).write_key_behind_dead_keys(action_sender);
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
                &state.named_presses,
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
                &state.named_presses,
            );
        }
        RawEventType::Focus => {
            handle_focus(
                raw,
                backend,
                action_sender,
                context_id,
                &mut state.last_focus,
                &mut state.introduced_by_focus,
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
                lock_buffers(pending).clear_keys();
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
                &state.named_presses,
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
                &state.named_presses,
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
    presses: &NamedPresses,
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
            modifiers: modifiers_of(raw, backend),
            held: held_at(raw, backend, presses),
            element: element_desc.clone(),
        }
    } else {
        ActionPayload::Click {
            x: screen_x,
            y: screen_y,
            modifiers: modifiers_of(raw, backend),
            held: held_at(raw, backend, presses),
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
    introduced_by_focus: &mut std::collections::HashSet<i64>,
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
    // The scope filters (DCP-5) judged the process of the window the focus
    // event named. An element in another window of another process, or of a
    // process that can no longer be read, was judged by no filter: the focus
    // moved on to it while the event waited, and that process's own focus
    // events may be the ones the filters drop. Nothing is written for it.
    let elsewhere = element_window != 0 && Some(element_window) != context_id;
    if elsewhere && backend.process_id_of(element_window) != raw.process_id {
        return;
    }
    // The element is the one focused when it is described, which need not be
    // in the window the focus event named: a dialog that closed as the focus
    // went back to its owner, for one (docent#709). The focus is recorded in
    // the context of the element's own window (DCP-21), the event's where the
    // description resolved no window.
    let (context_id, window_rect) = if elsewhere {
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

    // The Input_Thread introduced the window the event named, not the
    // element's (DCP-20). Where no event before this one introduced the
    // element's window, the focus is the first action in its context, and a
    // `context_switch` into it is written first, at the focus's own place in
    // the recording (docent#817). It is named by the event's process, the
    // one the scope filters judged, and titled as the window reads now. The
    // window's process is read again after its title, and nothing about the
    // window is read after that: a window that changed process since the
    // check above (it closed, and its handle went to another process's
    // window) is one no filter judged, and nothing is written.
    let switch = if elsewhere
        && !introduced_by_focus.contains(&element_window)
        && !backend.context_introduced_before(element_window, raw.sequence_id)
    {
        let title = backend.window_title(element_window);
        if backend.process_id_of(element_window) != raw.process_id {
            return;
        }
        let source = backend
            .process_name_of(raw.process_id)
            .unwrap_or_else(|| format!("pid:{}", raw.process_id));
        Some((source, title))
    } else {
        None
    };
    *last_focus = Some(key);
    if let Some((source, title)) = switch {
        introduced_by_focus.insert(element_window);
        send_context_switch(
            raw,
            source,
            title,
            action_sender,
            context_id,
            window_rect.clone(),
        );
    }

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
                Some(_) if !read_in_time(last_key, backend) => {
                    keep_keys_after_late_read(pending);
                    return false;
                }
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
            &mut state.pasted_into,
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
            Some(_)
                if !read_in_time(
                    state
                        .last_key
                        .as_ref()
                        .filter(|k| k.context_id == context_id),
                    backend,
                ) =>
            {
                keep_keys_after_late_read(pending);
                return false;
            }
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
        &mut state.pasted_into,
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
    pasted_into: &mut Option<LastValue>,
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
    // no typing key and no paste key pressed for it, is the same change
    // reported again (a program that reports one change twice) and adds
    // nothing. With a typing key buffered it is typing: the person typed the
    // same text over itself. A dead key waiting for the key after it is no
    // such key: it enters nothing by itself. The first value change of a field after a paste
    // key pressed in it is the pasted text: the same text pasted over itself.
    // Only the field typed into last is remembered, so a value the field held
    // in an earlier typing run is never what a later one is compared with.
    let pasted = pasted_into
        .take_if(|field| field.is_of(context_id, &element))
        .is_some();
    let repeats_last = buffers.pending_keys.len() == buffers.waiting_dead_keys()
        && !pasted
        && last_value
            .as_ref()
            .is_some_and(|last| last.is_of(context_id, &element) && last.value == value);
    if repeats_last {
        return true;
    }
    // Dead keys that wait in this field and whose accent the program entered
    // are part of this text. What the field held before them is the value
    // read at the first of them, or else the value last taken for the field.
    // A password field's value is its mask and says nothing, and a value
    // taken for another field says nothing about dead keys pressed in theirs.
    if !is_password && buffers.dead_keys_wait_in(context_id, &element) {
        let before = buffers.value_at_dead_key.take().or_else(|| {
            last_value
                .as_ref()
                .filter(|last| last.is_of(context_id, &element))
                .map(|last| last.value.clone())
        });
        buffers.take_dead_keys_entered(before.as_deref(), &value);
    }
    // The key held behind dead keys ended the typing before this value: the
    // dead keys still buffered entered nothing and are keys, and it is
    // written behind them, ahead of the `type` this value starts.
    buffers.write_key_behind_dead_keys(action_sender);
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

/// Whether a value just read for a value change was read in time: no key of
/// the window was dispatched after the last key before the value change, so
/// the program had received no later key when it answered (docent#761). A
/// value read later can hold what later keys did (the Backspace that ended
/// the typing, the space after it), which the person did not have when the
/// typing ended; it is not taken. A key not numbered (`0`) counts every read,
/// as does a value change with no key before it.
///
/// A value read in time holds no key after the last key, but it need not
/// hold that key itself: the program can have raised the value change for an
/// earlier key and not yet applied the last one. Nothing tells the two apart
/// (docent#762).
fn read_in_time<B: AccessibilityBackend>(last_key: Option<&LastKey>, backend: &B) -> bool {
    match last_key {
        Some(key) if key.number != 0 => backend.keys_dispatched(key.window) == key.number,
        _ => true,
    }
}

/// A value read too late is not taken: the pending `type` keeps the last
/// value read in time, and the keys buffered now are the keys after it, to
/// be written as keys unless a value read in time supersedes them.
fn keep_keys_after_late_read(pending: &SharedPendingBuffers) {
    let mut buffers = lock_buffers(pending);
    buffers.keys_after_type = buffers.pending_keys.len();
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

/// Whether `event` is a click on a menu item. Only a click whose element the
/// Input_Thread described at the release is known to be one.
fn is_menu_command(event: &RawEvent) -> bool {
    matches!(event.event_type, RawEventType::Click)
        && event
            .pre_captured_element
            .as_ref()
            .is_some_and(|element| element.tag == "MenuItem")
}

/// A menu item was clicked. A menu's Paste puts text into the field typed
/// into last with no key pressed, so that field's next value change is taken
/// as the person's entry, also where it repeats the field's recorded value
/// (the same text pasted over itself). Which item was clicked is not asked:
/// its name is in the application's language. An item that changes no text
/// (Copy) therefore leaves the field waiting, and a repeated report of its
/// value that comes later is then written as one more `type`.
fn note_menu_command(state: &mut WorkerState) {
    if let Some(last) = &state.last_value {
        state.pasted_into = Some(LastValue {
            context_id: last.context_id,
            selector: last.selector.clone(),
            place: last.place.clone(),
            value: String::new(),
        });
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
    // Skip the empty name: every left/right Shift, Control or Alt keydown;
    // a key pressed while they are held reads them into its own modifiers.
    // The empty name is given by the key's code alone, whatever its layout.
    if is_modifier_only_key(&key_name(raw)) {
        // It gives nothing on any layout, and leaves an accent waiting.
        state.named_presses.note(raw.sequence_id, None);
        return;
    }

    // A key attributed to no window (desktop capture DCP-14): a key the system
    // takes while the foreground window is excluded. Whatever is focused is
    // that excluded window's, so nothing is asked of the backend; the key is
    // no keystroke of any window, so the typing state is left as it is.
    if raw.window_handle == 0 {
        let named = key_as_named(raw, backend, state);
        let raw = named.as_ref().unwrap_or(raw);
        let key = key_name(raw);
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
                modifiers: modifiers_of(raw, backend),
                code: physical_key_of(raw),
                input_method: input_method_at(raw),
                repeat: is_repeat(raw),
                held: held_at(raw, backend, &state.named_presses),
                element,
            },
        };
        let mut buffers = lock_buffers(pending);
        buffers.flush_pending_type_only(action_sender);
        buffers.write_keys(action_sender);
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
    let described_now = on_control.is_none() && remembered.is_none();
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
    // What the layout gives the key and the keys held at it: asked only now,
    // off the keyboard hook and with the element settled. The first ask of a
    // layout builds its table, which takes long enough for the focus to move.
    // The key is named with an accent that waited taken in.
    let named = key_as_named(raw, backend, state);
    let raw = named.as_ref().unwrap_or(raw);
    let key = key_name(raw);
    let key_element = element.clone();
    if is_paste_key(raw) {
        state.pasted_into = Some(LastValue::of(context_id, &element, ""));
    }
    state.last_key = Some(LastKey {
        context_id,
        selector: element.selector.clone(),
        place: element.place_in_window.clone(),
        mark,
        control,
        window: raw.window_handle,
        number: key_number_of(raw),
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
        buffers.write_keys(action_sender);
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
    // What the field holds at a dead key, where it was read for this key:
    // from its control, or with an element described just now. An element
    // remembered from an earlier key holds an earlier value and gives none.
    let dead = buffered && is_dead_key(raw);
    let value_at_dead_key = if !dead {
        None
    } else if control != 0 {
        backend.control_value(control)
    } else if described_now {
        element.value.clone()
    } else {
        None
    };

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
            modifiers: modifiers_of(raw, backend),
            repeat: is_repeat(raw),
            code: physical_key_of(raw),
            input_method: input_method_at(raw),
            held: held_at(raw, backend, &state.named_presses),
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
            buffers.write_keys(action_sender);
        }
        // A dead key the end of the typing made a key is no part of the text
        // this key enters: it and the keys ahead of it are written now, in
        // the order pressed.
        if buffers.dead_keys_are_keys {
            buffers.write_keys(action_sender);
        }
        // Dead keys with a key held behind them got no value for it: they
        // and it are keys, ahead of this one.
        buffers.write_key_behind_dead_keys(action_sender);
        // Buffer printable keys — they may be superseded by a type event.
        buffers.pending_keys.push(event);
        buffers.pending_keys_last_timestamp = raw.timestamp;
        buffers.note_buffered_key(dead, dead_key_accent(raw), value_at_dead_key);
    } else {
        // Control key — flush pending type and pending keys, then emit.
        buffers.flush_pending_type_only(action_sender);
        // Behind dead keys that wait in this field, with no other key
        // buffered, the key is held with them: a value the field reports for
        // it says whether the program entered their accent as text.
        let waiting = buffers.undecided_dead_keys();
        let behind_dead_keys = waiting > 0
            && waiting == buffers.pending_keys.len()
            && buffers.key_behind_dead_keys.is_none()
            && buffers.pending_keys.iter().all(|dead_key| {
                dead_key.context_id == context_id
                    && matches!(&dead_key.payload,
                        ActionPayload::Key { element, .. } if same_field(element, &key_element))
            });
        if behind_dead_keys {
            buffers.key_behind_dead_keys = Some(event);
            buffers.pending_keys_last_timestamp = raw.timestamp;
        } else {
            buffers.write_keys(action_sender);
            let _ = action_sender.send(event);
        }
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
    // The title the Input_Thread read with the event, while the window was
    // there; the window's own where none was read then (docent#801).
    let title = raw
        .window_title
        .clone()
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| backend.window_title(raw.window_handle));
    // The process the Input_Thread read with the event, while the window was
    // there: a window can close before a worker gets to its switch, and then
    // it names no process (docent#761). The window names it where the
    // process cannot be named by its id. An exited process's id can be
    // reused: a process started under it before the switch is read would
    // be named instead. Where the process has exited and the window has
    // closed too, the window names no process ("pid:0"), and the switch is
    // named by the id read at the event, as a process that cannot be read is
    // (docent#801).
    let source = Some(raw.process_id)
        .filter(|pid| *pid != 0)
        .and_then(|pid| backend.process_name_of(pid))
        .unwrap_or_else(|| match backend.process_name(raw.window_handle) {
            by_window if by_window == "pid:0" && raw.process_id != 0 => {
                format!("pid:{}", raw.process_id)
            }
            by_window => by_window,
        });

    send_context_switch(raw, source, title, action_sender, context_id, window_rect);
}

/// Send the `context_switch` for `raw`, named `source` and titled `title`
/// (none where empty).
fn send_context_switch(
    raw: &RawEvent,
    source: String,
    title: String,
    action_sender: &mpsc::Sender<ActionEvent>,
    context_id: Option<i64>,
    window_rect: Option<WindowRect>,
) {
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
    presses: &NamedPresses,
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
            modifiers: modifiers_of(raw, backend),
            held: held_at(raw, backend, presses),
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
    presses: &NamedPresses,
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
            modifiers: modifiers_of(raw, backend),
            held: held_at(raw, backend, presses),
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
    // The keys after the `type` (a value read too late) did take text: their value
    // change came. They wait for the end of the typing, or for a value read
    // in time that makes them part of the `type` (docent#761); the keys
    // behind them that no value change reached are written as any are.
    // While a dead key waits for the key after it, the wait writes nothing;
    // one the end of the typing made a key is written with the others.
    // Dead keys with a key held behind them: no value came for that key
    // within the wait, so the program entered nothing and all are keys.
    if buffers.key_behind_dead_keys.is_some()
        && debounce_elapsed(now, buffers.pending_keys_last_timestamp, KEY_TEXT_WAIT_MS)
    {
        buffers.write_keys(action_sender);
        return;
    }
    if buffers.pending_keys.len() > buffers.keys_after_type
        && buffers.undecided_dead_keys() == 0
        && buffers.pending_keys_last_timestamp > 0
        && debounce_elapsed(now, buffers.pending_keys_last_timestamp, KEY_TEXT_WAIT_MS)
    {
        buffers.write_keys_after_type(false, action_sender);
        buffers.pending_keys_last_timestamp = 0;
        buffers.no_dead_key_waits();
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
///
/// Nor is the foreground event the Input_Thread dispatches ahead of a first
/// action in an inactive window the session had not introduced
/// ([`switch_before_event`]): that window has not come to the front (a wheel
/// turned or a drop made over it), and the action behind it ends the typing
/// where it is one that does (docent#810).
fn ends_typing(event: &RawEvent) -> bool {
    match event.event_type {
        RawEventType::Foreground => event.callback_params[3] != SWITCH_BEFORE_ITS_ACTION,
        RawEventType::Click
        | RawEventType::RightClick
        | RawEventType::DragStart { .. }
        | RawEventType::Drop { .. } => true,
        _ => false,
    }
}

/// The foreground event the Input_Thread dispatches ahead of `action`, the
/// first action in a window the session had not introduced
/// (`ContextIntroductions::switch_before`): into `root`, whose process is
/// `process_id` and whose title, read with it, is `window_title`. Marked
/// [`SWITCH_BEFORE_ITS_ACTION`] where `root` is not the window in front
/// (`foreground_root`), which has then not come to the front; a switch into
/// the window in front counts as its activation (DCP-20) and is not marked.
pub fn switch_before_event(
    action: &RawEvent,
    root: i64,
    foreground_root: i64,
    process_id: u32,
    window_title: Option<String>,
) -> RawEvent {
    let mark = if root == foreground_root {
        0
    } else {
        SWITCH_BEFORE_ITS_ACTION
    };
    RawEvent {
        event_type: RawEventType::Foreground,
        sequence_id: 0,
        timestamp: action.timestamp,
        screen_x: 0,
        screen_y: 0,
        window_handle: root,
        process_id,
        key_code: 0,
        modifiers: (false, false, false, false),
        ctrl_alt_read: None,
        scroll_delta: 0.0,
        callback_params: [0, 0, 0, mark],
        key_value: 0,
        keyboard_layout: 0,
        keyboard_thread: 0,
        caps_lock: false,
        pre_captured_element: None,
        focus_epoch: 0,
        // A switch states no held keys: only a keystroke, a click, a
        // right-click and a drop are stamped with them (held_keys).
        held: Vec::new(),
        window_title,
    }
}

/// The mark, in the fourth callback parameter, of a foreground event the
/// Input_Thread dispatches ahead of a first action in an inactive window the
/// session had not introduced ([`switch_before_event`]), rather than for a
/// window that came to the front.
pub const SWITCH_BEFORE_ITS_ACTION: i64 = 1;

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
                    alt_graph: false,
                },
                repeat: false,
                code: None,
                input_method: Default::default(),
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
                    Ok(WorkerMessage::EndTyping)
                    | Ok(WorkerMessage::MenuCommand)
                    | Ok(WorkerMessage::WriteHeldKey)
                    | Ok(WorkerMessage::UnrecordedKey { .. } | WorkerMessage::AccentsNotKnown)
                    | Ok(WorkerMessage::LookAtFocus) => {}
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
            ctrl_alt_read: None,
            scroll_delta: 0.0,
            callback_params: [0; 4],
            key_value: 0,
            keyboard_layout: 0,
            keyboard_thread: 0,
            caps_lock: false,
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
            window_title: None,
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

    /// What [`role_pool`] workers note: (index, spawn of that index, key code).
    type Received = Arc<Mutex<Vec<(usize, usize, u32)>>>;

    /// The key code that makes a [`role_pool`] worker end its thread when it
    /// receives the event, as a worker that died would.
    const DIES: u32 = 0xFF;

    /// The key code that makes a [`role_pool`] worker count its queue as
    /// empty, as a worker that has caught up would. Its queue otherwise only
    /// grows, so a choice by queue depends on the order of dispatch alone.
    const CATCHES_UP: u32 = 0xFE;

    /// A pool of `count` workers that note each event they receive as
    /// (index, the spawn of that index counted from 0, key code), and end
    /// their thread on an event whose key code is [`DIES`], and count their
    /// queue as empty on one whose key code is [`CATCHES_UP`]. A worker answers a
    /// flush barrier unless `answers(index, spawn)` says it does not.
    fn role_pool(count: usize, answers: fn(usize, usize) -> bool) -> (WorkerPool, Received) {
        // The workers note on their own threads, so `received` holds each
        // worker's events in order, not one order across workers: compare it
        // with `sorted`.
        let received: Received = Arc::new(Mutex::new(Vec::new()));
        let spawns: Arc<Mutex<HashMap<usize, usize>>> = Arc::new(Mutex::new(HashMap::new()));
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        let seen = Arc::clone(&received);
        let pool = WorkerPool::new(count, action_tx, move |idx, rx, queue_len, _sender, _p| {
            let seen = Arc::clone(&seen);
            let spawn = {
                let mut spawns = spawns.lock().unwrap();
                let next = spawns.entry(idx).or_insert(0);
                *next += 1;
                *next - 1
            };
            thread::spawn(move || loop {
                match rx.recv() {
                    Ok(WorkerMessage::Event(event)) => {
                        seen.lock().unwrap().push((idx, spawn, event.key_code));
                        if event.key_code == DIES {
                            break;
                        }
                        if event.key_code == CATCHES_UP {
                            queue_len.store(0, Ordering::SeqCst);
                        }
                    }
                    Ok(WorkerMessage::Flush(ack)) => {
                        if answers(idx, spawn) {
                            let _ = ack.send(idx);
                        }
                    }
                    Ok(WorkerMessage::AccentsNotKnown) => {
                        seen.lock().unwrap().push((idx, spawn, ACCENTS_NOT_KNOWN));
                    }
                    Ok(WorkerMessage::EndTyping)
                    | Ok(WorkerMessage::MenuCommand)
                    | Ok(WorkerMessage::WriteHeldKey)
                    | Ok(WorkerMessage::UnrecordedKey { .. })
                    | Ok(WorkerMessage::LookAtFocus) => {}
                    Ok(WorkerMessage::Shutdown) | Err(_) => break,
                }
            })
        });
        (pool, received)
    }

    /// What a [`role_pool`] worker notes in place of a key code when it is
    /// told that the accents that wait are not known.
    const ACCENTS_NOT_KNOWN: u32 = u32::MAX;

    /// The events `received` holds, sorted.
    fn sorted(received: &Received) -> Vec<(usize, usize, u32)> {
        let mut all = received.lock().unwrap().clone();
        all.retain(|(_, _, key_code)| *key_code != ACCENTS_NOT_KNOWN);
        all.sort_unstable();
        all
    }

    /// The workers (index, spawn) told that the accents that wait are not
    /// known, and how many of its events each had got before it was told.
    fn told_accents_not_known(received: &Received) -> Vec<(usize, usize, usize)> {
        let all = received.lock().unwrap().clone();
        all.iter()
            .enumerate()
            .filter(|(_, (_, _, key_code))| *key_code == ACCENTS_NOT_KNOWN)
            .map(|(at, (idx, spawn, _))| {
                let before = all[..at]
                    .iter()
                    .filter(|(i, s, k)| i == idx && s == spawn && *k != ACCENTS_NOT_KNOWN)
                    .count();
                (*idx, *spawn, before)
            })
            .collect()
    }

    /// A worker that takes the typing role after another did not get the
    /// keys before it: it is told so ahead of its first key. The first
    /// worker to take the role is told nothing.
    #[test]
    fn regression_717_a_worker_that_takes_the_typing_role_over_is_told_it_missed_keys() {
        let (mut pool, received) = role_pool(2, |idx, _| idx != 1);
        pool.dispatch(role_event(RawEventType::Click, 1, 0x41)); // to worker 0
        pool.dispatch(role_event(RawEventType::Keyboard, 1, 0x42)); // worker 1 takes the role
        thread::sleep(Duration::from_millis(50));
        assert_eq!(told_accents_not_known(&received), vec![]);
        // Worker 1 misses a barrier and gives the role up.
        assert_eq!(pool.flush_all(1, Duration::from_millis(200)), vec![1]);
        pool.dispatch(role_event(RawEventType::Keyboard, 1, 0x43)); // worker 0 takes it
        pool.dispatch(role_event(RawEventType::Keyboard, 1, 0x44));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            sorted(&received),
            vec![(0, 0, 0x41), (0, 0, 0x43), (0, 0, 0x44), (1, 0, 0x42)]
        );
        // Told once, after its click and ahead of its first key.
        assert_eq!(told_accents_not_known(&received), vec![(0, 0, 1)]);
        pool.shutdown_with_timeout(Duration::from_millis(200));
    }

    /// A key-down whose processing panics is dropped, and may not have been
    /// taken into the accents that wait: the next key is not known.
    #[test]
    fn regression_717_a_key_down_lost_to_a_panic_leaves_the_accent_not_known() {
        let (mut pool, rx) = pool_with_probe_backend(false, false);
        pool.dispatch(probe_key(PROBE_DEAD_KEY, false, 1));
        pool.dispatch(probe_key(PROBE_PANICS, false, 2));
        pool.dispatch(probe_key(0x45, false, 3));
        pool.dispatch(probe_key(0x45, false, 4));
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));
        assert_eq!(
            key_names(&drain_events(&rx)),
            vec!["Dead", "Unidentified", "e"]
        );
    }

    /// The pool says which key-downs it sent to be named: one that its
    /// worker never names has no name, whatever was named after it.
    #[test]
    fn regression_717_a_key_down_sent_and_never_named_is_not_named_as_pressed() {
        use crate::capture::waiting_accents::PressName;
        let (mut pool, _received) = role_pool(1, |_, _| true);
        let mut key = role_event(RawEventType::Keyboard, 1, 0x45);
        key.sequence_id = 7;
        pool.dispatch(key); // the role pool's worker names nothing
        let presses = Arc::clone(&pool.named_presses);
        presses.note(8, None);
        assert_eq!(presses.of(7, Duration::ZERO), PressName::NotKnown);
        assert_eq!(presses.of(8, Duration::ZERO), PressName::AsPressed);
        // An event that is no key-down is not awaited.
        let mut click = role_event(RawEventType::Click, 1, 0);
        click.sequence_id = 9;
        pool.dispatch(click);
        presses.note(10, None);
        assert_eq!(presses.of(9, Duration::ZERO), PressName::AsPressed);
        pool.shutdown_with_timeout(Duration::from_millis(200));
    }

    /// An event of `event_type` in `window_handle` with key code `key_code`.
    fn role_event(event_type: RawEventType, window_handle: i64, key_code: u32) -> RawEvent {
        RawEvent {
            event_type,
            sequence_id: 0,
            timestamp: 1,
            screen_x: 0,
            screen_y: 0,
            window_handle,
            process_id: 1,
            key_code,
            modifiers: (false, false, false, false),
            ctrl_alt_read: None,
            scroll_delta: 0.0,
            callback_params: [0; 4],
            key_value: 0,
            keyboard_layout: 0,
            keyboard_thread: 0,
            caps_lock: false,
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
            window_title: None,
        }
    }

    #[test]
    fn a_respawned_typing_worker_keeps_the_role_at_its_index() {
        a_role_stays_at_its_index_across_a_respawn(RawEventType::Keyboard);
    }

    #[test]
    fn a_respawned_focus_worker_keeps_the_role_at_its_index() {
        a_role_stays_at_its_index_across_a_respawn(RawEventType::Focus);
    }

    /// The replacement for a dead worker is installed at its index, and a
    /// role stays with the index: worker 1 takes the role, worker 0 catches
    /// up, worker 1 dies, and its replacement takes the events of the role
    /// after it, where the role chosen again, as the replacement is installed
    /// or after, would reach worker 0 (an empty queue, or a tie, which goes
    /// to the lower index).
    fn a_role_stays_at_its_index_across_a_respawn(event_type: RawEventType) {
        let (mut pool, received) = role_pool(2, |_, _| true);
        pool.dispatch(role_event(RawEventType::Click, 1, 0x41)); // to worker 0
        pool.dispatch(role_event(event_type.clone(), 1, 0x42)); // worker 1 takes the role
        pool.dispatch(role_event(RawEventType::Click, 1, CATCHES_UP)); // to worker 0, on the tie
        pool.dispatch(role_event(event_type.clone(), 1, DIES)); // worker 1 dies
        thread::sleep(Duration::from_millis(50));
        pool.dispatch(role_event(event_type.clone(), 1, 0x43)); // worker 1 is respawned
        pool.dispatch(role_event(event_type.clone(), 1, 0x44));
        thread::sleep(Duration::from_millis(100));

        assert_eq!(
            sorted(&received),
            vec![
                (0, 0, 0x41),
                (0, 0, CATCHES_UP),
                (1, 0, 0x42),
                (1, 0, DIES),
                (1, 1, 0x43),
                (1, 1, 0x44),
            ]
        );
        // The replacement of the typing worker did not get the keys before
        // it, and is told so ahead of its first; no other role is.
        let told = if matches!(event_type, RawEventType::Keyboard) {
            vec![(1, 1, 0)]
        } else {
            vec![]
        };
        assert_eq!(told_accents_not_known(&received), told);
        pool.shutdown_with_timeout(Duration::from_millis(200));
    }

    #[test]
    fn a_respawned_worker_counts_as_one_that_answered_the_last_flush_barrier() {
        // Workers 0 and 1 miss a barrier, and worker 0 then dies; its
        // replacement has missed none, while worker 1 still has, so the first
        // keystroke takes the shorter queue of workers 0 and 2 (a tie, so
        // worker 0). Worker 0 still counted as missing would leave worker 2,
        // and worker 1 counted as answering would win on its empty queue.
        let (mut pool, received) = role_pool(3, |idx, spawn| !(idx == 1 || idx == 0 && spawn == 0));
        let missed = pool.flush_all(1, Duration::from_millis(200));
        assert_eq!(missed, vec![0, 1]);
        pool.dispatch(role_event(RawEventType::Selection, 7, 0x41)); // to worker 0
        pool.dispatch(role_event(RawEventType::Selection, 8, 0x42)); // to worker 1
        pool.dispatch(role_event(RawEventType::Selection, 9, 0x43)); // to worker 2
        pool.dispatch(role_event(RawEventType::Selection, 8, CATCHES_UP)); // worker 1 catches up
        pool.dispatch(role_event(RawEventType::Selection, 7, DIES)); // worker 0 dies
        thread::sleep(Duration::from_millis(50));
        pool.dispatch(role_event(RawEventType::Selection, 7, 0x44)); // to worker 0: respawned
        pool.dispatch(role_event(RawEventType::Keyboard, 1, 0x45));
        thread::sleep(Duration::from_millis(100));

        assert_eq!(
            sorted(&received),
            vec![
                (0, 0, 0x41),
                (0, 0, DIES),
                (0, 1, 0x44),
                (0, 1, 0x45),
                (1, 0, 0x42),
                (1, 0, CATCHES_UP),
                (2, 0, 0x43),
            ]
        );
        pool.shutdown_with_timeout(Duration::from_millis(200));
    }

    #[test]
    fn a_role_nobody_holds_goes_to_the_shortest_queue_when_every_worker_missed_the_barrier() {
        // With no worker that answered the last barrier, a role chosen then
        // goes to the shortest queue among all workers: the typing role to
        // worker 1, as worker 0 holds a click, and then the focus role to
        // worker 0, the two queues being even and ties going to the lower
        // index.
        let (mut pool, received) = role_pool(2, |_, _| false);
        pool.dispatch(role_event(RawEventType::Click, 1, 0x41)); // to worker 0
        let missed = pool.flush_all(1, Duration::from_millis(200));
        assert_eq!(missed, vec![0, 1]);
        pool.dispatch(role_event(RawEventType::Keyboard, 1, 0x42));
        pool.dispatch(role_event(RawEventType::Focus, 1, 0x43));
        thread::sleep(Duration::from_millis(100));

        assert_eq!(
            sorted(&received),
            vec![(0, 0, 0x41), (0, 0, 0x43), (1, 0, 0x42)]
        );
        pool.shutdown_with_timeout(Duration::from_millis(200));
    }

    #[test]
    fn dead_keys_are_made_text_only_by_a_value_of_their_own_field() {
        // A value taken for another field, or in another window, says nothing
        // about dead keys that wait in theirs: the accent it holds is not
        // theirs.
        let field = |selector: &str| ElementDescription {
            tag: "Edit".to_string(),
            selector: selector.to_string(),
            ..Default::default()
        };
        let mut buffers = PendingBuffers::new();
        buffers.pending_keys = vec![key_event("\u{b4}")];
        buffers.note_buffered_key(true, Some('\u{b4}'), Some(String::new()));
        assert!(buffers.dead_keys_wait_in(Some(42), &field("win > edit")));
        assert!(!buffers.dead_keys_wait_in(Some(42), &field("win > other")));
        assert!(!buffers.dead_keys_wait_in(Some(7), &field("win > edit")));

        // In their own field the accent gained makes them text, once each.
        buffers.pending_keys.push(key_event("\u{b4}"));
        buffers.note_buffered_key(true, Some('\u{b4}'), None);
        buffers.pending_keys.push(key_event("\u{b4}"));
        buffers.note_buffered_key(true, Some('\u{b4}'), None);
        let before = buffers.value_at_dead_key.take();
        buffers.take_dead_keys_entered(before.as_deref(), "\u{b4}\u{b4}");
        assert_eq!(buffers.pending_keys.len(), 1);
        assert_eq!(buffers.waiting_dead_keys(), 1);
        assert_eq!(buffers.value_at_dead_key.as_deref(), Some("\u{b4}\u{b4}"));
        // With what the field held before not known, nothing is decided.
        buffers.take_dead_keys_entered(None, "\u{b4}\u{b4}\u{b4}");
        assert_eq!(buffers.pending_keys.len(), 1);
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

    /// The layout the probe backend answers for: a letter key gives its
    /// letter, in upper case with Shift or Caps Lock but not both; the space
    /// bar a space; Enter a control character; [`PROBE_DEAD_KEY`] is a dead
    /// key, the acute accent and with Shift the grave; every other key gives
    /// nothing. With Ctrl or Alt held a letter and the dead key give nothing.
    /// The acute accent makes `é` with `e`, `Á` with `A` and itself with a
    /// space; the grave accent makes `è` with `e`.
    const PROBE_LAYOUT: i64 = 0x0409_0409;
    /// The thread the probe keys are pressed in ([`probe_key`]).
    const PROBE_THREAD: u32 = 42;
    const PROBE_DEAD_KEY: u32 = 0xDD;
    /// A key code the probe backend panics on when its layout is asked.
    const PROBE_PANICS: u32 = 0x87;
    const ACUTE: char = '\u{b4}';

    impl AccessibilityBackend for ProbeBackend {
        fn layout_alt_gr(&self, layout: i64) -> Option<bool> {
            (layout == PROBE_LAYOUT).then_some(true)
        }

        fn key_value(
            &self,
            layout: i64,
            key_code: u32,
            held: crate::capture::key_value::Held,
        ) -> u32 {
            if layout != PROBE_LAYOUT {
                return 0;
            }
            if key_code == PROBE_PANICS {
                panic!("the probe layout was asked about the key that panics");
            }
            let answers = |with: crate::capture::key_value::Held| {
                // An injected character is no key of the layout: as on
                // Windows, the layout has no answer for it.
                if key_code == VK_PACKET {
                    return None;
                }
                Some(match key_code {
                    0x41..=0x5A if with.ctrl || with.alt => LayoutAnswer::Nothing,
                    0x41..=0x5A if with.shift != with.caps_lock => {
                        LayoutAnswer::Char(char::from(key_code as u8))
                    }
                    0x41..=0x5A => {
                        LayoutAnswer::Char(char::from(key_code as u8).to_ascii_lowercase())
                    }
                    PROBE_DEAD_KEY if with.ctrl || with.alt => LayoutAnswer::Nothing,
                    PROBE_DEAD_KEY if with.shift => LayoutAnswer::Dead('`'),
                    PROBE_DEAD_KEY => LayoutAnswer::Dead(ACUTE),
                    0x20 => LayoutAnswer::Char(' '),
                    0x0D => LayoutAnswer::Other,
                    _ => LayoutAnswer::Nothing,
                })
            };
            crate::capture::key_value::pressed_param(held, answers)
        }

        fn composed(
            &self,
            layout: i64,
            accent: crate::capture::layout_file::Accent,
            base: char,
        ) -> Result<
            Option<crate::capture::layout_file::Composed>,
            crate::capture::waiting_accents::NoList,
        > {
            use crate::capture::layout_file::Compositions;
            if layout != PROBE_LAYOUT {
                return Err(crate::capture::waiting_accents::NoList);
            }
            Ok(Compositions::of_entries(&[
                (ACUTE, 'e', 'é', false),
                (ACUTE, 'A', 'Á', false),
                (ACUTE, ' ', ACUTE, false),
                ('`', 'e', 'è', false),
            ])
            .asked(accent, base))
        }

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
        // The A key, which the layout gave `a`.
        layout_key_raw_event(0x41, Some(LayoutAnswer::Char('a')), 1)
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
            ctrl_alt_read: None,
            scroll_delta: 0.0,
            callback_params: [0; 4],
            key_value: 0,
            keyboard_layout: 0,
            keyboard_thread: 0,
            caps_lock: false,
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
            window_title: None,
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
            ctrl_alt_read: None,
            scroll_delta: 0.0,
            callback_params: [0; 4],
            key_value: 0,
            keyboard_layout: 0,
            keyboard_thread: 0,
            caps_lock: false,
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
            window_title: None,
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
        let mut e = no_window(layout_key_raw_event(0x45, Some(LayoutAnswer::Char('e')), 3));
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
                ("e".to_string(), true, false, space_held.clone()),
                ("e".to_string(), true, true, space_held),
            ]
        );
    }

    // Regression: #825 — the desktop wrote AltGr as Ctrl and Alt.
    // https://github.com/Arsarneq/docent/issues/825
    #[test]
    fn regression_825_a_key_states_alt_graph_and_the_ctrl_and_alt_the_person_held() {
        use crate::capture::held_keys::{CtrlAltRead, PersonLeftCtrl};
        let (mut pool, rx) = pool_with_probe_backend(false, false);
        // The keyboard's state at each: the left Ctrl and the right Alt down
        // (AltGr alone, or a left Ctrl held before AltGr), the left Ctrl and
        // the left Alt down. On the probe's layout, which has AltGr.
        let read = |person_left_ctrl, windows_ctrl_for_right_alt, right_alt: bool| CtrlAltRead {
            ctrl: true,
            alt: true,
            left_ctrl: true,
            right_ctrl: false,
            left_alt: !right_alt,
            right_alt,
            person_left_ctrl: PersonLeftCtrl::Known(person_left_ctrl),
            windows_ctrl_for_right_alt,
            layout: PROBE_LAYOUT,
        };
        // AltGr with E; a left Ctrl, then AltGr, with E (Windows sends no Ctrl
        // of its own); Ctrl and Alt with E. Last, a key with nothing read of
        // the Ctrl and Alt keys: written as the system holds them.
        let cases = [
            Some(read(false, true, true)),
            Some(read(true, false, true)),
            Some(read(true, false, false)),
            None,
        ];
        for (i, case) in cases.iter().enumerate() {
            let mut e =
                layout_key_raw_event(0x45, Some(LayoutAnswer::Char('\u{20ac}')), i as u64 + 1);
            e.modifiers = (true, false, true, false);
            e.ctrl_alt_read = *case;
            pool.dispatch(e);
        }
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        let stated: Vec<_> = drain_events(&rx)
            .into_iter()
            .filter_map(|e| match e.payload {
                ActionPayload::Key { key, modifiers, .. } => Some((key, modifiers)),
                _ => None,
            })
            .collect();
        let m = |ctrl, alt, alt_graph| Modifiers {
            ctrl,
            shift: false,
            alt,
            meta: false,
            alt_graph,
        };
        let euro = "\u{20ac}".to_string();
        assert_eq!(
            stated,
            vec![
                (euro.clone(), m(false, false, true)),
                (euro.clone(), m(true, false, true)),
                (euro.clone(), m(true, true, false)),
                (euro, m(true, true, false)),
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
            vec!["a"],
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

    use crate::capture::key_value::{answer_param, LayoutAnswer};

    /// A keydown of key `vk` for which the keyboard hook read `answer` from
    /// the keyboard layout (`RawEvent::key_value`).
    fn layout_key_raw_event(vk: u32, answer: Option<LayoutAnswer>, sequence_id: u64) -> RawEvent {
        let mut raw = control_key_raw_event(vk, sequence_id);
        raw.key_value = answer_param(answer);
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
        pool.dispatch(layout_key_raw_event(0xBB, Some(LayoutAnswer::Char('+')), 1));
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));

        assert_eq!(
            key_names(&drain_events(&rx)),
            vec!["+"],
            "VK_OEM_PLUS on a layout where it enters `+` must be named `+`"
        );
    }

    /// A key name, as the worker names the keydown of `vk` for which the hook
    /// read `answer` from the layout.
    fn name_with(vk: u32, answer: Option<LayoutAnswer>) -> String {
        key_name(&layout_key_raw_event(vk, answer, 1))
    }

    fn name_with_char(vk: u32, character: char) -> String {
        name_with(vk, Some(LayoutAnswer::Char(character)))
    }

    // Regression: #717 — the desktop named a key by its code (`A` for the A
    // key whatever was held, `1` for Shift and 1, `Numpad1`, `Add`), where the
    // extension names what the press means on the layout.
    // https://github.com/Arsarneq/docent/issues/717
    #[test]
    fn regression_717_a_character_key_is_named_by_the_character_the_press_gives() {
        // A letter in the case the press gives it.
        assert_eq!(name_with_char(0x41, 'a'), "a");
        assert_eq!(name_with_char(0x41, 'A'), "A");
        // Danish: Shift and 1, Shift and the key right of 0, AltGr and E.
        assert_eq!(name_with_char(0x31, '!'), "!");
        assert_eq!(name_with_char(0xBB, '?'), "?");
        assert_eq!(name_with_char(0x45, '€'), "€");
        // A letter on a punctuation code keeps its case too.
        assert_eq!(name_with_char(0xC0, 'æ'), "æ");
        assert_eq!(name_with_char(0xC0, 'Æ'), "Æ");
        assert_eq!(name_with_char(0xDB, 'ß'), "ß");
        // The numeric keypad with Num Lock on gives its characters.
        assert_eq!(name_with_char(0x61, '1'), "1");
        assert_eq!(name_with_char(0x6B, '+'), "+");
        assert_eq!(name_with_char(0x6E, ','), ",");
        // Every typing code is named by what the layout gave the press.
        for vk in (0..=0xFF_u32).filter(|vk| is_typing_key_code(*vk)) {
            if vk != VK_PACKET && vk != 0x20 {
                assert_eq!(name_with_char(vk, '§'), "§", "vk {vk:#x}");
            }
        }
        // Code 0xE1 among them: a typing key like the other punctuation
        // codes, with no name or rule of its own.
        assert_eq!(name_with(0xE1, None), "Unidentified");
        assert_eq!(name_with(0xE1, Some(LayoutAnswer::Dead('\u{b4}'))), "Dead");
    }

    #[test]
    fn the_modifiers_and_caps_lock_of_a_press_are_what_the_layout_is_asked_with() {
        use crate::capture::key_value::Held;
        let mut raw = control_key_raw_event(0x41, 1);
        assert_eq!(held_of(&raw), Held::default());
        // (ctrl, shift, alt, meta): each lands in its own place, and Meta in
        // none.
        raw.modifiers = (true, false, false, true);
        assert_eq!(
            held_of(&raw),
            Held {
                ctrl: true,
                ..Held::default()
            }
        );
        raw.modifiers = (false, true, false, false);
        assert_eq!(
            held_of(&raw),
            Held {
                shift: true,
                ..Held::default()
            }
        );
        raw.modifiers = (false, false, true, false);
        raw.caps_lock = true;
        assert_eq!(
            held_of(&raw),
            Held {
                alt: true,
                caps_lock: true,
                ..Held::default()
            }
        );
    }

    /// A dead key is known by the read its name comes from, where the worker
    /// asked the layout: with Caps Lock on, a key can be dead where the
    /// hook's own reads, which leave Caps Lock out, say it is none, and the
    /// other way round.
    #[test]
    fn a_dead_key_is_known_by_the_layouts_answer_for_the_press_as_held() {
        use crate::capture::key_value::{pressed_param, Held};
        let dead_as_held = pressed_param(Held::default(), |_| Some(LayoutAnswer::Dead('\u{b4}')));
        let char_as_held = pressed_param(Held::default(), |_| Some(LayoutAnswer::Char('^')));
        // The hook's reads say no dead key (no flag on the layout character).
        let mut raw = control_key_raw_event(0xDD, 1);
        raw.key_value = dead_as_held;
        assert!(is_dead_key(&raw));
        // The hook's reads say a dead key (bit 31 of the layout character).
        raw.callback_params[3] = 0x8000_00B4;
        raw.key_value = char_as_held;
        assert!(!is_dead_key(&raw));
        // Where the worker did not ask, the hook's reads decide.
        raw.key_value = 0;
        assert!(is_dead_key(&raw));
        raw.key_value = answer_param(Some(LayoutAnswer::Char('^')));
        assert!(is_dead_key(&raw));
        // A shortcut is no dead key, whatever the layout names it.
        raw.key_value = dead_as_held;
        raw.modifiers = (true, false, false, false);
        assert!(!is_dead_key(&raw));
    }

    #[test]
    fn a_space_is_named_space() {
        assert_eq!(name_with_char(0x20, ' '), "Space");
        // The space bar gives what its layout gives it as pressed.
        assert_eq!(name_with_char(0x20, '\u{a0}'), "\u{a0}");
        // The space bar is the space bar where no layout was read.
        assert_eq!(name_with(0x20, None), "Space");
        // And a key the layout gives a space.
        assert_eq!(name_with_char(0xBB, ' '), "Space");
    }

    #[test]
    fn a_dead_key_is_named_dead() {
        assert_eq!(name_with(0xDB, Some(LayoutAnswer::Dead('\u{b4}'))), "Dead");
        assert_eq!(name_with(0xBA, Some(LayoutAnswer::Dead('\u{b4}'))), "Dead");
    }

    #[test]
    fn a_key_the_layout_gives_nothing_is_unidentified() {
        assert_eq!(name_with(0xBB, Some(LayoutAnswer::Nothing)), "Unidentified");
        // Nor is a key named where the layout was not read: no name is
        // guessed from the key's code.
        assert_eq!(name_with(0xBB, None), "Unidentified");
        assert_eq!(name_with(0x41, None), "Unidentified");
        assert_eq!(name_with(0x61, None), "Unidentified");
        // A code with no name and no character.
        assert_eq!(name_with(0x07, None), "Unidentified");
    }

    #[test]
    fn a_key_with_a_name_of_its_own_keeps_it_whatever_the_layout_answers() {
        assert_eq!(name_with_char(0x0D, '+'), "Enter");
        assert_eq!(name_with(0x0D, None), "Enter");
        assert_eq!(name_with(0x23, None), "End");
        assert_eq!(name_with(0x74, None), "F5");
        assert_eq!(name_with(0x5B, None), "Meta");
        assert_eq!(name_with(0x5D, None), "ContextMenu");
        assert_eq!(name_with(0xAF, None), "AudioVolumeUp");
        // The numeric keypad with Num Lock off sends the navigation keys'
        // codes, and the 5 key sends Clear.
        assert_eq!(name_with(0x0C, None), "Clear");
        // Shift, Control and Alt by their generic codes; the left and right
        // codes are skipped (the empty name).
        assert_eq!(name_with(0x10, None), "Shift");
        assert_eq!(name_with(0x11, None), "Control");
        assert_eq!(name_with(0x12, None), "Alt");
        for vk in 0xA0..=0xA5 {
            assert!(is_modifier_only_key(&name_with(vk, None)), "vk {vk:#x}");
        }
    }

    #[test]
    fn a_mode_key_is_named_by_the_language_of_the_layout_read_at_the_press() {
        let on = |layout: i64| {
            let mut raw = layout_key_raw_event(0x15, None, 1);
            raw.keyboard_layout = layout;
            key_name(&raw)
        };
        assert_eq!(on(0x0412_0412), "HangulMode");
        assert_eq!(on(0x0411_0411), "KanaMode");
        assert_eq!(on(0x0406_0406), "Unidentified");
        assert_eq!(on(0), "Unidentified");
    }

    #[test]
    fn an_injected_character_is_named_by_the_character_it_carries() {
        let mut raw = layout_key_raw_event(VK_PACKET, Some(LayoutAnswer::Char('+')), 1);
        raw.callback_params[0] = i64::from(u32::from('é'));
        assert_eq!(key_name(&raw), "é");
        raw.callback_params[0] = i64::from(u32::from(' '));
        assert_eq!(key_name(&raw), "Space");
        raw.callback_params[0] = 0xD800;
        assert_eq!(key_name(&raw), "Unidentified");
    }

    #[test]
    fn a_held_key_is_named_by_what_the_layout_gave_it_at_its_key_down() {
        use crate::capture::held_keys::HeldPress;
        let mut raw = control_key_raw_event(0x0D, 9);
        let held =
            |key_code: u32, answer: Option<LayoutAnswer>, layout: i64, press: u64| HeldPress {
                key_code,
                scan_code: 0,
                press,
                key_value: answer_param(answer),
                layout,
                held: 0,
            };
        raw.held = vec![
            held(0x41, Some(LayoutAnswer::Char('A')), 0x0406_0406, 1),
            held(0xBB, Some(LayoutAnswer::Char('?')), 0x0406_0406, 2),
            held(0x15, None, 0x0412_0412, 3),
            held(0x26, None, 0, 4),
        ];
        let backend = ProbeBackend {
            block_focused: false,
            block_window_title: false,
        };
        // Every held key's own key-down was named as pressed.
        let presses = NamedPresses::new();
        presses.note(4, None);
        let at = held_at(&raw, &backend, &presses);
        assert_eq!(at.held_keys, vec!["A", "?", "HangulMode", "ArrowUp"]);
        assert_eq!(at.held_presses, vec![1, 2, 3, 4]);
    }

    /// The worker asks the layout what a key gives, off the keyboard hook:
    /// the keystroke's own key with the modifiers and the Caps Lock state of
    /// the press, and each held key as it was pressed at its own key-down.
    #[test]
    fn the_worker_fills_in_what_the_layout_gives_a_key_and_the_keys_held_at_it() {
        use crate::capture::held_keys::HeldPress;
        use crate::capture::key_value::Held;
        let backend = ProbeBackend {
            block_focused: false,
            block_window_title: false,
        };
        let on_layout = |vk: u32| {
            let mut raw = control_key_raw_event(vk, 2);
            raw.keyboard_layout = PROBE_LAYOUT;
            raw
        };
        let named = |raw: &RawEvent| key_name(&with_key_values(raw, &backend).expect("filled"));
        let mut a = on_layout(0x41);
        assert_eq!(named(&a), "a");
        a.modifiers = (false, true, false, false);
        assert_eq!(named(&a), "A");
        a.caps_lock = true;
        assert_eq!(named(&a), "a", "Shift with Caps Lock on");
        // Ctrl gives no character: the Shift and Caps Lock state alone.
        a.modifiers = (true, false, false, false);
        assert_eq!(named(&a), "A");
        // A key the layout gives nothing, and a layout that cannot be asked.
        assert_eq!(named(&on_layout(0xBB)), "Unidentified");
        let mut unread = on_layout(0x41);
        unread.keyboard_layout = 0;
        assert_eq!(named(&unread), "Unidentified");

        // A held key is asked with what was held at its own key-down, on the
        // layout read then, whatever the event that states it carries.
        let shift = Held {
            shift: true,
            ..Held::default()
        };
        let held = |key_code: u32, with: Held, layout: i64| HeldPress {
            key_code,
            scan_code: 0,
            press: 1,
            key_value: 0,
            layout,
            held: with.index() as u8,
        };
        let mut click = control_key_raw_event(0, 3);
        click.event_type = RawEventType::Click;
        click.held = vec![
            held(0x42, shift, PROBE_LAYOUT),
            held(0x43, Held::default(), PROBE_LAYOUT),
            held(0x44, Held::default(), 0),
        ];
        let presses = NamedPresses::new();
        presses.note(1, None);
        let filled = with_key_values(&click, &backend).expect("filled");
        assert_eq!(filled.key_value, 0, "a click has no key of its own");
        assert_eq!(
            held_at(&filled, &backend, &presses).held_keys,
            vec!["B", "c", "Unidentified"]
        );
        // The held keys of an action are asked about where they are named,
        // so nothing has to be filled in ahead for them.
        assert_eq!(
            held_at(&click, &backend, &presses).held_keys,
            vec!["B", "c", "Unidentified"]
        );

        // A value already there is kept, and an event with nothing to fill
        // in is left as it is.
        let given = layout_key_raw_event(0x41, Some(LayoutAnswer::Char('q')), 4);
        assert!(with_key_values(&given, &backend).is_none());
        let mut scroll = control_key_raw_event(0, 5);
        scroll.event_type = RawEventType::Scroll;
        assert!(with_key_values(&scroll, &backend).is_none());
    }

    // -- the key behind a dead key (docent#717) --------------------------------

    fn probe() -> ProbeBackend {
        ProbeBackend {
            block_focused: false,
            block_window_title: false,
        }
    }

    /// A key-down of `vk` on the probe layout, with or without Shift.
    fn probe_key(vk: u32, shift: bool, sequence_id: u64) -> RawEvent {
        let mut raw = control_key_raw_event(vk, sequence_id);
        raw.keyboard_layout = PROBE_LAYOUT;
        raw.keyboard_thread = PROBE_THREAD;
        raw.modifiers = (false, shift, false, false);
        raw
    }

    /// The name a worker with `state` gives the key-down `raw`.
    fn named_in(state: &mut WorkerState, raw: &RawEvent) -> String {
        let named = key_as_named(raw, &probe(), state);
        key_name(named.as_ref().unwrap_or(raw))
    }

    /// A worker's state once the probe thread had a key that gives something
    /// (a `q`, which no accent of the probe layout makes anything with): no
    /// accent waits in it. A recording starts with no thread known
    /// ([`regression_836_at_the_start_no_thread_is_known`]).
    fn settled(presses: Arc<NamedPresses>) -> WorkerState {
        let mut state = WorkerState::new(presses);
        assert_eq!(named_in(&mut state, &probe_key(0x51, false, 0)), "q");
        state
    }

    /// At the start of a recording a program can hold an accent from before
    /// it: the first key an accent of the layout would rename is not known,
    /// the key behind a dead key pressed first is not known, and a key no
    /// accent would rename keeps its name.
    #[test]
    fn regression_836_at_the_start_no_thread_is_known() {
        let start = || WorkerState::new(Arc::new(NamedPresses::new()));
        let mut state = start();
        assert_eq!(
            named_in(&mut state, &probe_key(0x45, false, 1)),
            "Unidentified"
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 2)), "e");
        let mut state = start();
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        assert_eq!(
            named_in(&mut state, &probe_key(0x45, false, 2)),
            "Unidentified"
        );
        let mut state = start();
        assert_eq!(named_in(&mut state, &probe_key(0x51, false, 1)), "q");
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 2)), "e");
        // Each thread by itself.
        let mut elsewhere = probe_key(0x45, false, 3);
        elsewhere.keyboard_thread = PROBE_THREAD + 1;
        assert_eq!(named_in(&mut state, &elsewhere), "Unidentified");
        // Ctrl and a letter is named whatever waits.
        let mut state = start();
        let mut ctrl_e = probe_key(0x45, false, 1);
        ctrl_e.modifiers = (true, false, false, false);
        assert_eq!(named_in(&mut state, &ctrl_e), "e");
    }

    /// The names of `keys` (a key code, and whether Shift is held), pressed
    /// in turn on the probe layout.
    fn names_in_turn(keys: &[(u32, bool)]) -> Vec<String> {
        let mut state = settled(Arc::new(NamedPresses::new()));
        keys.iter()
            .enumerate()
            .map(|(at, &(vk, shift))| named_in(&mut state, &probe_key(vk, shift, at as u64 + 1)))
            .collect()
    }

    const DEAD: (u32, bool) = (PROBE_DEAD_KEY, false);
    const E: (u32, bool) = (0x45, false);

    // Regression: #717 — a browser names the key pressed behind a dead key by
    // the character the two make (measured in Chrome on a Danish layout); the
    // desktop named it by the key's own character.
    // https://github.com/Arsarneq/docent/issues/717
    #[test]
    fn regression_717_the_key_behind_a_dead_key_is_named_by_what_the_two_make() {
        assert_eq!(names_in_turn(&[DEAD, E]), ["Dead", "é"]);
        assert_eq!(names_in_turn(&[DEAD, (0x41, true)]), ["Dead", "Á"]);
        assert_eq!(names_in_turn(&[DEAD, (0x20, false)]), ["Dead", "\u{b4}"]);
        assert_eq!(names_in_turn(&[(PROBE_DEAD_KEY, true), E]), ["Dead", "è"]);
        // The accent is used once.
        assert_eq!(names_in_turn(&[DEAD, E, E]), ["Dead", "é", "e"]);
    }

    #[test]
    fn regression_717_a_key_the_accent_makes_nothing_with_keeps_its_name() {
        assert_eq!(names_in_turn(&[DEAD, (0x51, false)]), ["Dead", "q"]);
        // It took the accent away.
        assert_eq!(names_in_turn(&[DEAD, (0x51, false), E]), ["Dead", "q", "e"]);
        // A second dead key.
        assert_eq!(names_in_turn(&[DEAD, DEAD, E]), ["Dead", "Dead", "e"]);
        // Ctrl with a letter is named by the letter, as with no accent.
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        let mut ctrl_a = probe_key(0x41, false, 2);
        ctrl_a.modifiers = (true, false, false, false);
        assert_eq!(named_in(&mut state, &ctrl_a), "a");
    }

    #[test]
    fn regression_717_a_key_that_gives_nothing_leaves_the_accent_for_the_next() {
        // An arrow key between the dead key and the letter.
        assert_eq!(
            names_in_turn(&[DEAD, (0x25, false), E]),
            ["Dead", "ArrowLeft", "é"]
        );
        // Enter gives a control character: it takes the accent away.
        assert_eq!(
            names_in_turn(&[DEAD, (0x0D, false), E]),
            ["Dead", "Enter", "e"]
        );
    }

    #[test]
    fn regression_717_a_shift_key_and_an_injected_character_leave_the_accent_waiting() {
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        // An injected character reaches the program past the layout.
        let mut packet = probe_key(VK_PACKET, false, 2);
        packet.callback_params[0] = i64::from(u32::from('x'));
        assert_eq!(named_in(&mut state, &packet), "x");
        assert_eq!(named_in(&mut state, &probe_key(0x10, false, 3)), "Shift");
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 4)), "é");
    }

    /// A key the system may act on itself (the Windows key held) may never
    /// reach the layout: behind an accent its name and what waits after it
    /// are not known; with no accent waiting it changes nothing.
    #[test]
    fn regression_717_a_key_the_system_may_take_is_not_known_behind_an_accent() {
        let win = |vk: u32, sequence_id: u64| {
            let mut raw = probe_key(vk, false, sequence_id);
            raw.modifiers = (false, false, false, true);
            raw
        };
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(named_in(&mut state, &win(0x45, 1)), "e");
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 2)), "e");
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 3)),
            "Dead"
        );
        assert_eq!(named_in(&mut state, &win(0x45, 4)), "Unidentified");
        assert_eq!(
            named_in(&mut state, &probe_key(0x45, false, 5)),
            "Unidentified"
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 6)), "e");
        // The same for a key outside the recording.
        let backend = probe();
        let mut state = settled(Arc::new(NamedPresses::new()));
        note_unrecorded_key(
            PROBE_LAYOUT,
            PROBE_THREAD,
            PROBE_DEAD_KEY,
            0,
            &backend,
            &mut state.accents,
        );
        note_unrecorded_key(
            PROBE_LAYOUT,
            PROBE_THREAD,
            0x45,
            SYSTEM_MAY_TAKE,
            &backend,
            &mut state.accents,
        );
        assert_eq!(
            named_in(&mut state, &probe_key(0x45, false, 1)),
            "Unidentified"
        );
    }

    /// docent#836: programs differ in whether an accent begun in one window
    /// is used in another, so a key behind a dead key pressed in a window of
    /// another thread is not known, recorded or not.
    #[test]
    fn regression_836_a_key_behind_a_dead_key_of_another_thread_is_not_known() {
        let backend = probe();
        let other_thread = PROBE_THREAD + 1;
        // The dead key outside the recording, in another thread.
        let mut state = settled(Arc::new(NamedPresses::new()));
        note_unrecorded_key(
            PROBE_LAYOUT,
            other_thread,
            PROBE_DEAD_KEY,
            0,
            &backend,
            &mut state.accents,
        );
        assert_eq!(
            named_in(&mut state, &probe_key(0x45, false, 1)),
            "Unidentified"
        );
        // The dead key recorded, the key behind it in another window.
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        let mut elsewhere = probe_key(0x45, false, 2);
        elsewhere.keyboard_thread = other_thread;
        assert_eq!(named_in(&mut state, &elsewhere), "Unidentified");
        assert_eq!(
            named_in(&mut state, &probe_key(0x45, false, 3)),
            "Unidentified"
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 4)), "e");
    }

    /// The thread is the one the keyboard hook read at the key-down
    /// ([`RawEvent::keyboard_thread`]), whichever window of it the key is
    /// attributed to, and whether or not that window still exists.
    #[test]
    fn regression_836_the_thread_of_a_key_is_the_one_read_at_its_key_down() {
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        // Another window of the same thread (a dialog of the program).
        let mut dialog = probe_key(0x45, false, 2);
        dialog.window_handle += 1;
        assert_eq!(named_in(&mut state, &dialog), "é");
        // The same window handle with another thread read.
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        let mut elsewhere = probe_key(0x45, false, 2);
        elsewhere.keyboard_thread = PROBE_THREAD + 1;
        assert_eq!(named_in(&mut state, &elsewhere), "Unidentified");
    }

    #[test]
    fn regression_717_a_key_outside_the_recording_is_taken_into_the_accents_that_wait() {
        let backend = probe();
        // A dead key pressed in a window that is not recorded: the key behind
        // it, in a recorded window, is the composed one.
        let mut state = settled(Arc::new(NamedPresses::new()));
        note_unrecorded_key(
            PROBE_LAYOUT,
            PROBE_THREAD,
            PROBE_DEAD_KEY,
            0,
            &backend,
            &mut state.accents,
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 1)), "é");
        // A letter pressed there takes a recorded dead key's accent away.
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        note_unrecorded_key(
            PROBE_LAYOUT,
            PROBE_THREAD,
            0x51,
            0,
            &backend,
            &mut state.accents,
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 2)), "e");
        // With Shift held there, the dead key is the grave accent.
        let shift = crate::capture::key_value::Held {
            shift: true,
            ..Default::default()
        };
        let mut state = settled(Arc::new(NamedPresses::new()));
        note_unrecorded_key(
            PROBE_LAYOUT,
            PROBE_THREAD,
            PROBE_DEAD_KEY,
            shift.index() as u8,
            &backend,
            &mut state.accents,
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 1)), "è");
        // A Shift key and an injected character there change nothing.
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        note_unrecorded_key(
            PROBE_LAYOUT,
            PROBE_THREAD,
            0xA0,
            0,
            &backend,
            &mut state.accents,
        );
        note_unrecorded_key(
            PROBE_LAYOUT,
            PROBE_THREAD,
            VK_PACKET,
            0,
            &backend,
            &mut state.accents,
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 2)), "é");
    }

    #[test]
    fn regression_717_a_key_is_not_named_where_it_is_not_known_whether_an_accent_waits() {
        // A key on a layout that cannot be asked: it may have been a dead
        // key. The next key an accent would rename has no name; the one
        // behind it has.
        let mut state = settled(Arc::new(NamedPresses::new()));
        let mut unread = probe_key(0xBA, false, 1);
        unread.keyboard_layout = 0;
        assert_eq!(named_in(&mut state, &unread), "Unidentified");
        assert_eq!(
            named_in(&mut state, &probe_key(0x45, false, 2)),
            "Unidentified"
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 3)), "e");
        // A key with a name of its own keeps it.
        let mut state = settled(Arc::new(NamedPresses::new()));
        assert_eq!(named_in(&mut state, &unread), "Unidentified");
        assert_eq!(
            named_in(&mut state, &probe_key(0x25, false, 2)),
            "ArrowLeft"
        );
    }

    #[test]
    fn regression_717_a_held_key_is_named_as_its_own_key_down_was() {
        use crate::capture::held_keys::HeldPress;
        let presses = Arc::new(NamedPresses::new());
        let mut state = settled(Arc::clone(&presses));
        assert_eq!(
            named_in(&mut state, &probe_key(PROBE_DEAD_KEY, false, 1)),
            "Dead"
        );
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 2)), "é");
        assert_eq!(named_in(&mut state, &probe_key(0x45, false, 3)), "e");
        let held = |key_code: u32, press: u64| HeldPress {
            key_code,
            scan_code: 0,
            press,
            key_value: 0,
            layout: PROBE_LAYOUT,
            held: 0,
        };
        // A click on another worker, with the keys of the three key-downs
        // held: each is named as its `key` action was.
        let mut click = control_key_raw_event(0, 4);
        click.event_type = RawEventType::Click;
        click.held = vec![held(PROBE_DEAD_KEY, 1), held(0x45, 2), held(0x45, 3)];
        assert_eq!(
            held_at(&click, &probe(), &presses).held_keys,
            vec!["Dead", "é", "e"]
        );
        // A key-down the typing worker has not got to is waited for, and
        // named `Unidentified` where its name does not come; a key with a
        // name of its own is not waited for.
        click.held = vec![held(0x45, 9), held(0x26, 10)];
        let asked = Instant::now();
        assert_eq!(
            held_at(&click, &probe(), &presses).held_keys,
            vec!["Unidentified", "ArrowUp"]
        );
        assert!(asked.elapsed() >= HELD_NAME_WAIT);
        assert!(
            asked.elapsed() < HELD_NAME_WAIT * 4,
            "one wait, for one key"
        );
        // One wait for the action, whatever number of its held keys has
        // no name yet; and a key-down that had no name in time is not
        // waited for at the next action.
        click.held = vec![held(0x45, 9), held(0x45, 11), held(0x45, 12)];
        let asked = Instant::now();
        assert_eq!(
            held_at(&click, &probe(), &presses).held_keys,
            vec!["Unidentified", "Unidentified", "Unidentified"]
        );
        assert!(
            asked.elapsed() < HELD_NAME_WAIT * 2,
            "one wait, for the action"
        );
        let asked = Instant::now();
        click.held = vec![held(0x45, 9), held(0x45, 11), held(0x45, 12)];
        let _ = held_at(&click, &probe(), &presses);
        assert!(asked.elapsed() < HELD_NAME_WAIT, "not waited for again");
        // A name that comes while the click's worker waits is the key's.
        let naming = {
            let presses = Arc::clone(&presses);
            thread::spawn(move || {
                thread::sleep(HELD_NAME_WAIT / 4);
                presses.note(13, None);
            })
        };
        click.held = vec![held(0x45, 13)];
        assert_eq!(held_at(&click, &probe(), &presses).held_keys, vec!["e"]);
        naming.join().unwrap();
        // And one that comes after the wait is the key's from then on.
        presses.note(9, None);
        click.held = vec![held(0x45, 9)];
        assert_eq!(held_at(&click, &probe(), &presses).held_keys, vec!["e"]);
    }

    /// Through the pool: the keys of a field that reports no value change are
    /// written as keys, the one behind the dead key by what the two make; a
    /// key outside the recording is taken in the order pressed.
    #[test]
    fn regression_717_the_pool_names_the_key_behind_a_dead_key() {
        let (mut pool, rx) = pool_with_probe_backend(false, false);
        // The first key of the thread: from it on no accent waits there.
        pool.dispatch(probe_key(0x51, false, 1));
        pool.dispatch(probe_key(PROBE_DEAD_KEY, false, 2));
        pool.dispatch(probe_key(0x45, false, 3));
        pool.unrecorded_key(PROBE_LAYOUT, PROBE_THREAD, PROBE_DEAD_KEY, 0);
        pool.dispatch(probe_key(0x45, false, 4));
        pool.dispatch(probe_key(0x45, false, 5));
        thread::sleep(Duration::from_millis(100));
        pool.shutdown_with_timeout(Duration::from_secs(5));
        assert_eq!(
            key_names(&drain_events(&rx)),
            vec!["q", "Dead", "é", "é", "e"]
        );
    }

    #[test]
    fn a_punctuation_key_is_printable_input_whatever_the_layout_answered() {
        let mut raw = layout_key_raw_event(0xE2, Some(LayoutAnswer::Char('<')), 1);
        assert!(is_printable_key(&raw));
        // Without an answer it has no name and is still a typing key: the
        // typing table decides by the key's code (is_typing_key_code).
        raw.key_value = 0;
        assert_eq!(key_name(&raw), "Unidentified");
        assert!(is_printable_key(&raw));
    }

    #[test]
    fn every_key_with_a_name_of_its_own_stays_a_key_in_a_password_field() {
        use crate::capture::key_value::named_key;
        for language in [0_u16, 0x11, 0x12] {
            for vk in 0..=0xFF_u32 {
                let Some(name) = named_key(vk, language) else {
                    continue;
                };
                let raw = control_key_raw_event(vk, 1);
                // The key an input method took names no key of its own: what
                // was pressed is a typing key, so it is masked as text.
                assert_eq!(
                    enters_text_in_password_field(&raw, name),
                    name == "Process",
                    "{name}"
                );
            }
        }
        // A character, a dead key and a key with no name are text there.
        let raw = control_key_raw_event(0x41, 1);
        for name in ["a", "A", "?", "Space", "Dead", "Unidentified"] {
            assert!(enters_text_in_password_field(&raw, name), "{name}");
        }
    }

    // -- keys numbered per window (docent#761) -------------------------------

    /// Each window answers the number of its own latest key, from one count,
    /// so a key in another window moves nothing for it; a number is never 0.
    #[test]
    fn keys_are_numbered_per_window_from_one_count() {
        let keys = KeyNumbers::new();
        assert_eq!(keys.latest(7), KeyNumbers::NOT_REMEMBERED);
        let first = keys.number(7);
        assert_ne!(first, 0);
        assert_eq!(keys.latest(7), first);
        let other = keys.number(8);
        assert!(other > first);
        assert_eq!(keys.latest(7), first, "a key in another window");
        let second = keys.number(7);
        assert!(second > other);
        assert_eq!(keys.latest(7), second);
        assert_eq!(keys.latest(8), other);
    }

    /// A window let go answers no key's number, so a read checked against it
    /// is not taken; noted again, it answers its new latest key.
    #[test]
    fn a_window_let_go_answers_no_keys_number() {
        let keys = KeyNumbers::new();
        let first = keys.number(1);
        for window in 2..=KeyNumbers::WINDOWS as i64 + 1 {
            keys.number(window);
        }
        assert_eq!(keys.latest(1), KeyNumbers::NOT_REMEMBERED);
        let again = keys.number(1);
        assert!(again > first);
        assert_eq!(keys.latest(1), again);
    }

    /// Shift, Control and Alt change no text: their keystrokes carry the
    /// window's latest number and move nothing for a read of the window; a
    /// window with no key yet numbers its first, whatever the key.
    #[test]
    fn a_shift_control_or_alt_key_moves_no_windows_count() {
        let keys = KeyNumbers::new();
        let first = keys.for_key(3, 0xA0);
        assert_ne!(first, 0, "a window's first key is numbered");
        let a = keys.for_key(3, u32::from(b'A'));
        assert!(a > first);
        for vk in [0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5] {
            assert_eq!(keys.for_key(3, vk), a, "key {vk:#x}");
        }
        assert_eq!(keys.latest(3), a);
        for vk in [0x08, 0x09, 0x0D, 0x14, 0x20, 0x5B, u32::from(b'B')] {
            assert!(numbers_key(vk), "key {vk:#x}");
        }
        assert!(keys.for_key(3, u32::from(b'B')) > a);
    }

    /// The window let go is the one whose latest key is the oldest: a window
    /// typed into again keeps its place, whatever order the windows came in.
    #[test]
    fn the_window_let_go_is_the_one_with_the_oldest_key() {
        let keys = KeyNumbers::new();
        for window in 1..=KeyNumbers::WINDOWS as i64 {
            keys.number(window);
        }
        let again = keys.number(1);
        keys.number(KeyNumbers::WINDOWS as i64 + 1);
        assert_eq!(keys.latest(1), again, "typed into again, kept");
        assert_eq!(keys.latest(2), KeyNumbers::NOT_REMEMBERED, "the oldest");
        for window in 3..=KeyNumbers::WINDOWS as i64 + 1 {
            assert_ne!(keys.latest(window), KeyNumbers::NOT_REMEMBERED);
        }
    }

    /// The number rides above the layout character and the repeat mark
    /// without touching either, and only a keystroke carries one.
    #[test]
    fn a_key_number_rides_beside_the_layout_character_and_the_repeat_mark() {
        let mut raw = control_key_raw_event(0xBA, 1);
        raw.callback_params[3] = i64::from(';' as u32)
            | crate::capture::held_keys::KEY_REPEAT_PARAM
            | key_number_param(5);
        assert_eq!(key_number_of(&raw), 5);
        assert!(is_repeat(&raw));
        assert_eq!(
            crate::capture::held_keys::layout_char_of(raw.callback_params[3]),
            ';' as u32
        );
        raw.callback_params[3] = i64::from(u32::MAX) | key_number_param(KEY_NUMBER_MASK);
        assert_eq!(key_number_of(&raw), KEY_NUMBER_MASK);
        assert!(!is_repeat(&raw));
        raw.event_type = RawEventType::ValueChange;
        assert_eq!(key_number_of(&raw), 0);
    }
}
