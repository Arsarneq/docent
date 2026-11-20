// Property tests for the capture worker pool infrastructure.
//
// The principal subjects: sequence numbering, shortest-queue dispatch, typing
// and sticky routing, drag-pair routing, and the dead-worker drain rescues (dispatch-time
// respawn and shutdown join) — the pipeline-level truth-lock — alongside
// end-to-end action truth-locks over the same pipeline (key, right-click,
// selection, scroll flush, locator pass-through, excluded-PID discard). The
// click-vs-drag threshold itself belongs to the Windows provider and is pinned
// beside it, in the `capture::windows` module's own unit tests.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;

use docent_desktop_lib::capture::worker_pool::{RawEvent, RawEventType, WorkerMessage, WorkerPool};
use docent_desktop_lib::capture::ActionEvent;
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Create a default `RawEvent` with the given type and window handle.
fn make_raw_event(event_type: RawEventType, window_handle: i64) -> RawEvent {
    RawEvent {
        event_type,
        sequence_id: 0,
        timestamp: 1000,
        screen_x: 100,
        screen_y: 200,
        window_handle,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    }
}

// ---------------------------------------------------------------------------
// Sequence numbering is monotonically increasing from 1
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]

    /// Sequence numbering
    ///
    /// For any N in 1..1000, assigning ids on the pool's shared sequence counter
    /// the way the Input_Thread does (`fetch_add(1) + 1`) produces exactly the
    /// sequence 1, 2, 3, ..., N with no gaps or duplicates.
    #[test]
    fn sequence_numbering_is_monotonically_increasing(n in 1usize..1000) {
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        let pool = WorkerPool::new(1, action_tx, |_index, _rx, _queue_len, _sender, _pending| {
            std::thread::spawn(|| {
                // Worker does nothing; we only test sequence numbering.
            })
        });

        // Mirror the Input_Thread's assignment (windows.rs input_dispatch_raw_event)
        // on the same shared counter the pool exposes.
        let counter = pool.sequence_counter();
        let ids: Vec<u64> = (0..n)
            .map(|_| counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1)
            .collect();

        // Verify the sequence is exactly 1, 2, ..., N.
        for (i, &id) in ids.iter().enumerate() {
            prop_assert_eq!(
                id,
                (i as u64) + 1,
                "expected sequence_id {} at position {}, got {}",
                i + 1,
                i,
                id
            );
        }

        // Verify max_sequence_id matches the last assigned value.
        prop_assert_eq!(
            pool.max_sequence_id(),
            n as u64,
            "max_sequence_id should be {} after {} calls",
            n,
            n
        );
    }
}

// ---------------------------------------------------------------------------
// Shortest-queue dispatch selects the least busy worker
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Shortest-queue dispatch
    ///
    /// For any total number of events dispatched to a 3-worker pool where
    /// workers do NOT consume events (queue_len accumulates), the dispatch
    /// distributes events evenly with lowest-index tie-breaking.
    ///
    /// After N dispatches with no consumption:
    /// - Each worker has either floor(N/3) or ceil(N/3) events.
    /// - Workers with ceil(N/3) events have lower indices than those with
    ///   floor(N/3), verifying lowest-index tie-breaking.
    #[test]
    fn shortest_queue_dispatch_selects_least_busy_worker(
        q0 in 0u64..100,
        q1 in 0u64..100,
        q2 in 0u64..100,
    ) {
        let total = (q0 + q1 + q2) as usize;
        if total == 0 {
            // Nothing to dispatch — property holds vacuously.
            return Ok(());
        }

        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();

        // Track per-worker event counts. Workers do NOT decrement queue_len,
        // so it accumulates — this lets us verify shortest-queue selection.
        let worker_counts: Vec<Arc<AtomicU64>> = (0..3)
            .map(|_| Arc::new(AtomicU64::new(0)))
            .collect();
        let wc_clone = worker_counts.clone();

        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender, _pending| {
            let wc = Arc::clone(&wc_clone[index]);
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(_)) => {
                            wc.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(WorkerMessage::Flush(_)) => {}
                        Ok(WorkerMessage::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
        });

        // Dispatch `total` Click events (non-sticky, uses shortest-queue).
        for _ in 0..total {
            pool.dispatch(make_raw_event(RawEventType::Click, 0));
        }

        // Give workers time to receive all events.
        std::thread::sleep(std::time::Duration::from_millis(50));

        let counts: [u64; 3] = [
            worker_counts[0].load(Ordering::SeqCst),
            worker_counts[1].load(Ordering::SeqCst),
            worker_counts[2].load(Ordering::SeqCst),
        ];

        // Verify total is correct.
        prop_assert_eq!(
            counts[0] + counts[1] + counts[2],
            total as u64,
            "total events dispatched should be {}, got {}",
            total,
            counts[0] + counts[1] + counts[2]
        );

        let base = (total / 3) as u64;

        // Each worker should have either `base` or `base+1` events.
        for (i, &count) in counts.iter().enumerate() {
            prop_assert!(
                count == base || count == base + 1,
                "worker {} has {} events, expected {} or {} (total={})",
                i, count, base, base + 1, total
            );
        }

        // Verify tie-breaking: workers with more events (base+1) should
        // have lower indices than workers with fewer events (base).
        for i in 0..3 {
            for j in (i + 1)..3 {
                prop_assert!(
                    counts[i] >= counts[j],
                    "worker {} has fewer events ({}) than worker {} ({}) — \
                     violates lowest-index tie-breaking",
                    i, counts[i], j, counts[j]
                );
            }
        }

        pool.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Sticky routing for value-change events
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Sticky routing
    ///
    /// For any sequence of focus and selection events with the same
    /// window_handle, all events are dispatched to the same worker index.
    #[test]
    fn sticky_routing_for_focus_and_selection_events(
        window_handle in 1i64..10000,
        kinds in proptest::collection::vec(proptest::bool::ANY, 2..50),
    ) {
        let event_count = kinds.len();
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        let worker_counts: Vec<Arc<AtomicU64>> = (0..3)
            .map(|_| Arc::new(AtomicU64::new(0)))
            .collect();
        let wc_clone = worker_counts.clone();

        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender, _pending| {
            let wc = Arc::clone(&wc_clone[index]);
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(raw)) => {
                            if matches!(
                                raw.event_type,
                                RawEventType::Focus | RawEventType::Selection
                            ) {
                                wc.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        Ok(WorkerMessage::Flush(_)) => {}
                        Ok(WorkerMessage::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
        });

        // Dispatch focus and selection events with the same window_handle,
        // a click between them so the queue lengths keep moving.
        for is_focus in &kinds {
            let event_type = if *is_focus {
                RawEventType::Focus
            } else {
                RawEventType::Selection
            };
            pool.dispatch(make_raw_event(event_type, window_handle));
            pool.dispatch(make_raw_event(RawEventType::Click, window_handle + 1));
        }

        // Give workers time to receive.
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Exactly one worker should have received all events.
        let counts: Vec<u64> = worker_counts
            .iter()
            .map(|c| c.load(Ordering::SeqCst))
            .collect();

        let total: u64 = counts.iter().sum();
        prop_assert_eq!(
            total,
            event_count as u64,
            "total events should be {}, got {}",
            event_count,
            total
        );

        // Exactly one worker should have all events, others should have 0.
        let non_zero_workers: Vec<usize> = counts
            .iter()
            .enumerate()
            .filter(|(_, &c)| c > 0)
            .map(|(i, _)| i)
            .collect();

        prop_assert_eq!(
            non_zero_workers.len(),
            1,
            "expected exactly 1 worker to receive all focus and selection events, \
             but {} workers received events: {:?}",
            non_zero_workers.len(),
            counts
        );

        prop_assert_eq!(
            counts[non_zero_workers[0]],
            event_count as u64,
            "the sticky worker should have all {} events",
            event_count
        );

        pool.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Drag pair routing to same worker
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Drag pair routing
    ///
    /// For any drag event, both the DragStart and Drop RawEvents are
    /// dispatched to the same worker index.
    #[test]
    fn drag_pair_routed_to_same_worker(
        src_x in -10000i32..10000,
        src_y in -10000i32..10000,
        dst_x in -10000i32..10000,
        dst_y in -10000i32..10000,
        window_handle in 1i64..10000,
    ) {
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();

        // Track which worker receives DragStart and Drop events.
        let worker_events: Vec<Arc<std::sync::Mutex<Vec<String>>>> = (0..3)
            .map(|_| Arc::new(std::sync::Mutex::new(Vec::new())))
            .collect();
        let we_clone = worker_events.clone();

        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender, _pending| {
            let events = Arc::clone(&we_clone[index]);
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(raw)) => {
                            let event_name = match &raw.event_type {
                                RawEventType::DragStart { .. } => "DragStart",
                                RawEventType::Drop { .. } => "Drop",
                                _ => "Other",
                            };
                            events.lock().unwrap().push(event_name.to_string());
                        }
                        Ok(WorkerMessage::Flush(_)) => {}
                        Ok(WorkerMessage::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
        });

        // Dispatch a DragStart followed by a Drop.
        let drag_start = RawEvent {
            event_type: RawEventType::DragStart {
                source_coords: (src_x, src_y),
            },
            sequence_id: 1,
            timestamp: 1000,
            screen_x: src_x,
            screen_y: src_y,
            window_handle,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        };

        let drop_event = RawEvent {
            event_type: RawEventType::Drop {
                source_coords: (src_x, src_y),
            },
            sequence_id: 2,
            timestamp: 1001,
            screen_x: dst_x,
            screen_y: dst_y,
            window_handle,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        };

        pool.dispatch(drag_start);
        pool.dispatch(drop_event);

        // Give workers time to receive.
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Find which worker got DragStart and which got Drop.
        let mut drag_start_idx: Option<usize> = None;
        let mut drop_idx: Option<usize> = None;

        for (i, events) in worker_events.iter().enumerate() {
            let evts = events.lock().unwrap();
            for evt in evts.iter() {
                if evt == "DragStart" {
                    drag_start_idx = Some(i);
                }
                if evt == "Drop" {
                    drop_idx = Some(i);
                }
            }
        }

        prop_assert!(
            drag_start_idx.is_some(),
            "DragStart event was not received by any worker"
        );
        prop_assert!(
            drop_idx.is_some(),
            "Drop event was not received by any worker"
        );

        prop_assert_eq!(
            drag_start_idx.unwrap(),
            drop_idx.unwrap(),
            "DragStart went to worker {} but Drop went to worker {} — \
             both should go to the same worker",
            drag_start_idx.unwrap(),
            drop_idx.unwrap()
        );

        pool.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Mock AccessibilityBackend for worker_loop tests
// ---------------------------------------------------------------------------

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicU32;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use docent_desktop_lib::capture::worker_pool::{
    focus_names_a_part, worker_loop, AccessibilityBackend, ContextIntroductions, ControlLook,
    ControlNature, PartFocusNote, PendingBuffers, FOCUS_EPOCH_PERSON_STEP,
};
use docent_desktop_lib::capture::{
    ActionPayload, CaptureError, CaptureMode, ElementDescription, Modifiers,
};

/// A mock accessibility backend for testing the worker_loop.
///
/// Returns fixed element descriptions. For type coalescing tests, the
/// `focused_values` queue provides a sequence of text values that
/// `focused_element()` returns on successive calls.
struct MockBackend {
    /// Queue of text values for `focused_element()`. When empty, falls back
    /// to `default_text`.
    focused_values: Arc<Mutex<VecDeque<String>>>,
    /// Default text value when `focused_values` is exhausted.
    default_text: String,
    /// Fixed element selector returned by all element queries.
    selector: String,
}

impl MockBackend {
    fn new() -> Self {
        Self {
            focused_values: Arc::new(Mutex::new(VecDeque::new())),
            default_text: "hello".to_string(),
            selector: "Edit#input1".to_string(),
        }
    }

    /// Create a mock backend with a queue of focused element text values.
    fn with_focused_values(values: Vec<String>) -> Self {
        Self {
            focused_values: Arc::new(Mutex::new(VecDeque::from(values))),
            default_text: "default".to_string(),
            selector: "Edit#input1".to_string(),
        }
    }
}

impl AccessibilityBackend for MockBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }

    fn cleanup(&mut self) {}

    fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
        Some(ElementDescription {
            tag: "Button".to_string(),
            id: Some("btn1".to_string()),
            name: Some("Click Me".to_string()),
            role: Some("button".to_string()),
            element_type: None,
            text: None,
            selector: self.selector.clone(),
            ..Default::default()
        })
    }

    fn focused_element(&self) -> Option<ElementDescription> {
        let text = {
            let mut vals = self.focused_values.lock().unwrap();
            if let Some(v) = vals.pop_front() {
                v
            } else {
                self.default_text.clone()
            }
        };
        Some(ElementDescription {
            tag: "Edit".to_string(),
            id: Some("input1".to_string()),
            name: Some("Text Field".to_string()),
            role: Some("editable text".to_string()),
            element_type: None,
            text: Some(text),
            selector: self.selector.clone(),
            ..Default::default()
        })
    }

    fn window_title(&self, _window_handle: i64) -> String {
        "Test Window".to_string()
    }

    fn process_name(&self, _window_handle: i64) -> String {
        "test.exe".to_string()
    }

    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
        None
    }

    fn root_window_handle(&self, window_handle: i64) -> i64 {
        window_handle
    }

    fn window_rect(&self, _window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        // Deliberately NOT at the origin: at (0,0) screen coordinates and
        // window-relative coordinates coincide, so any coordinate-space bug is
        // invisible to every assertion written against this mock (issue #141).
        Some(docent_desktop_lib::capture::WindowRect {
            x: 100,
            y: 50,
            width: 1920,
            height: 1080,
        })
    }

    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

/// Helper: spawn a worker_loop in a background thread and return the channels
/// and handles needed to interact with it.
struct WorkerTestHarness {
    pending: Arc<Mutex<PendingBuffers>>,
    event_tx: mpsc::Sender<WorkerMessage>,
    action_rx: mpsc::Receiver<ActionEvent>,
    _queue_len: Arc<AtomicU64>,
    _excluded_pid: Arc<AtomicU32>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WorkerTestHarness {
    fn new(backend: impl AccessibilityBackend) -> Self {
        let (event_tx, event_rx) = mpsc::channel::<WorkerMessage>();
        let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
        let queue_len = Arc::new(AtomicU64::new(0));
        let excluded_pid = Arc::new(AtomicU32::new(0));

        let ql = Arc::clone(&queue_len);
        let ep = Arc::clone(&excluded_pid);

        let pending = Arc::new(Mutex::new(PendingBuffers::default()));
        let worker_pending = Arc::clone(&pending);
        let thread = thread::spawn(move || {
            worker_loop(
                0,
                backend,
                event_rx,
                ql,
                action_tx,
                ep,
                worker_pending,
                None,
            );
        });

        Self {
            pending,
            event_tx,
            action_rx,
            _queue_len: queue_len,
            _excluded_pid: excluded_pid,
            thread: Some(thread),
        }
    }

    /// Send a raw event to the worker.
    fn send_event(&self, event: RawEvent) {
        self._queue_len.fetch_add(1, Ordering::SeqCst);
        self.event_tx
            .send(WorkerMessage::Event(Box::new(event)))
            .unwrap();
    }

    /// Put completed key actions into the worker's held buffer, as keystrokes
    /// buffered a moment ago would sit there.
    fn seed_pending_keys(&self, keys: Vec<ActionEvent>) {
        let mut buffers = self.pending.lock().unwrap();
        buffers.pending_keys = keys;
        buffers.pending_keys_last_timestamp = now_ms();
    }

    /// Send a commit flush marker (docent#298) and return the acknowledging
    /// worker index. Does NOT terminate the worker.
    fn flush(&self) -> usize {
        let (ack_tx, ack_rx) = mpsc::channel::<usize>();
        self.event_tx.send(WorkerMessage::Flush(ack_tx)).unwrap();
        ack_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker did not acknowledge flush")
    }

    /// Drain the action events currently available, waiting briefly for each.
    fn drain_actions(&self) -> Vec<ActionEvent> {
        let mut events = Vec::new();
        while let Ok(evt) = self.action_rx.recv_timeout(Duration::from_millis(200)) {
            events.push(evt);
        }
        events
    }

    /// Send shutdown and join the worker thread.
    fn shutdown(mut self) -> Vec<ActionEvent> {
        let _ = self.event_tx.send(WorkerMessage::Shutdown);
        if let Some(handle) = self.thread.take() {
            handle.join().unwrap();
        }
        // Collect all action events.
        let mut events = Vec::new();
        while let Ok(evt) = self.action_rx.try_recv() {
            events.push(evt);
        }
        events
    }
}

// ---------------------------------------------------------------------------
// Sequence_id preservation from RawEvent to ActionEvent
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Sequence_id preservation
    ///
    /// For any RawEvent with a given sequence_id processed by a worker,
    /// the resulting ActionEvent carries the same sequence_id value.
    #[test]
    fn sequence_id_preserved_from_raw_to_action(
        seq_id in 1u64..100000,
        event_type_idx in 0u8..4,
    ) {
        let event_type = match event_type_idx {
            0 => RawEventType::Click,
            1 => RawEventType::Focus,
            2 => RawEventType::Foreground,
            _ => RawEventType::Selection,
        };

        let raw = RawEvent {
            event_type,
            sequence_id: seq_id,
            timestamp: 1000,
            screen_x: 100,
            screen_y: 200,
            window_handle: 12345,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        };

        let harness = WorkerTestHarness::new(MockBackend::new());
        harness.send_event(raw);

        // Give the worker time to process.
        thread::sleep(Duration::from_millis(100));

        let remaining = harness.shutdown();

        // We should have at least one action event.
        prop_assert!(
            !remaining.is_empty(),
            "expected at least one ActionEvent, got none"
        );

        // The first event should carry the same sequence_id.
        let first = &remaining[0];
        prop_assert_eq!(
            first.sequence_id,
            Some(seq_id),
            "ActionEvent sequence_id should be Some({}), got {:?}",
            seq_id,
            first.sequence_id
        );
    }
}

// ---------------------------------------------------------------------------
// Type event coalescing produces one event per keystroke sequence
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// Type coalescing
    ///
    /// For any sequence of rapid value-change events for the same element
    /// within the debounce interval, the worker emits exactly one `type`
    /// ActionEvent with the final value.
    #[test]
    fn type_coalescing_produces_one_event_per_keystroke_sequence(
        keystroke_count in 2usize..20,
    ) {
        // Build a sequence of incrementally typed values: "a", "ab", "abc", ...
        let values: Vec<String> = (0..keystroke_count)
            .map(|i| {
                (0..=i)
                    .map(|j| (b'a' + (j % 26) as u8) as char)
                    .collect::<String>()
            })
            .collect();

        let final_value = values.last().unwrap().clone();

        let backend = MockBackend::with_focused_values(values);
        let harness = WorkerTestHarness::new(backend);

        // Send rapid value-change events with the same timestamp base
        // (all within the debounce window).
        let base_ts = 10000u64;
        for i in 0..keystroke_count {
            let raw = RawEvent {
                event_type: RawEventType::ValueChange,
                sequence_id: (i + 1) as u64,
                timestamp: base_ts + (i as u64 * 10), // 10ms apart — well within 500ms debounce
                screen_x: 0,
                screen_y: 0,
                window_handle: 100,
                process_id: 1,
                key_code: 0,
                modifiers: (false, false, false, false),
                scroll_delta: 0.0,
                callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
            };
            harness.send_event(raw);
        }

        // Wait for debounce to expire (500ms) plus some margin.
        thread::sleep(Duration::from_millis(700));

        let events = harness.shutdown();

        // Filter to only Type events.
        let type_events: Vec<&ActionEvent> = events
            .iter()
            .filter(|e| matches!(e.payload, ActionPayload::Type { .. }))
            .collect();

        prop_assert_eq!(
            type_events.len(),
            1,
            "expected exactly 1 type event, got {} (total events: {})",
            type_events.len(),
            events.len()
        );

        // Verify the final value.
        if let ActionPayload::Type { ref value, .. } = type_events[0].payload {
            prop_assert_eq!(
                value,
                &final_value,
                "type event value should be '{}', got '{}'",
                final_value,
                value
            );
        } else {
            prop_assert!(false, "expected Type payload");
        }
    }
}

// ---------------------------------------------------------------------------
// Pending type event is flushed before focus or context-switch
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// Flush on context change
    ///
    /// When a worker has a pending type event and receives a focus or
    /// foreground event, the type event is emitted before the focus/context_switch
    /// event, and the type event's sequence_id is lower.
    #[test]
    fn pending_type_flushed_before_context_change(
        flush_trigger in 0u8..2, // 0 = Focus, 1 = Foreground
        value_change_count in 1usize..5,
    ) {
        // Build values for the value-change sequence.
        let values: Vec<String> = (0..value_change_count)
            .map(|i| format!("val_{}", i + 1))
            .collect();
        let final_value = values.last().unwrap().clone();

        // The focused_element call for the Focus event will also consume
        // from the queue, so add an extra value for that.
        let mut all_values = values.clone();
        if flush_trigger == 0 {
            // Focus event calls focused_element() once
            all_values.push("focus_element_text".to_string());
        }

        let backend = MockBackend::with_focused_values(all_values);
        let harness = WorkerTestHarness::new(backend);

        let base_ts = 10000u64;
        let type_seq_start = 1u64;

        // Send value-change events (rapid, within debounce).
        for i in 0..value_change_count {
            let raw = RawEvent {
                event_type: RawEventType::ValueChange,
                sequence_id: type_seq_start + i as u64,
                timestamp: base_ts + (i as u64 * 10),
                screen_x: 0,
                screen_y: 0,
                window_handle: 100,
                process_id: 1,
                key_code: 0,
                modifiers: (false, false, false, false),
                scroll_delta: 0.0,
                callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
            };
            harness.send_event(raw);
        }

        // Small delay to ensure value-change events are processed.
        thread::sleep(Duration::from_millis(100));

        // Now send the context-change event (Focus or Foreground).
        let context_seq = type_seq_start + value_change_count as u64;
        let context_event = RawEvent {
            event_type: if flush_trigger == 0 {
                RawEventType::Focus
            } else {
                RawEventType::Foreground
            },
            sequence_id: context_seq,
            timestamp: base_ts + 200,
            screen_x: 0,
            screen_y: 0,
            window_handle: 200, // Different window for foreground
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        };
        harness.send_event(context_event);

        // Give worker time to process.
        thread::sleep(Duration::from_millis(200));

        let events = harness.shutdown();

        // Find the type event and the context event.
        let type_idx = events.iter().position(|e| {
            matches!(e.payload, ActionPayload::Type { .. })
        });
        let context_idx = events.iter().position(|e| {
            matches!(
                e.payload,
                ActionPayload::Focus { .. } | ActionPayload::ContextSwitch { .. }
            )
        });

        prop_assert!(
            type_idx.is_some(),
            "expected a Type event to be emitted (events: {:?})",
            events.iter().map(|e| format!("{:?}", e.payload)).collect::<Vec<_>>()
        );
        prop_assert!(
            context_idx.is_some(),
            "expected a Focus/ContextSwitch event to be emitted"
        );

        let ti = type_idx.unwrap();
        let ci = context_idx.unwrap();

        // Type event must come before the context event.
        prop_assert!(
            ti < ci,
            "type event (index {}) should come before context event (index {})",
            ti,
            ci
        );

        // Type event's sequence_id should be lower than context event's.
        let type_seq = events[ti].sequence_id.unwrap_or(0);
        let ctx_seq = events[ci].sequence_id.unwrap_or(0);
        prop_assert!(
            type_seq < ctx_seq,
            "type event sequence_id ({}) should be less than context event sequence_id ({})",
            type_seq,
            ctx_seq
        );

        // Verify the type event has the final value.
        if let ActionPayload::Type { ref value, .. } = events[ti].payload {
            prop_assert_eq!(
                value,
                &final_value,
                "type event value should be '{}', got '{}'",
                final_value,
                value
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests for worker failure handling
// ---------------------------------------------------------------------------

/// Test: simulate worker panic, verify pool respawns the dead worker and
/// redistributes events to surviving workers while the respawn happens.
/// Note: the first send to a worker that will panic succeeds (the worker
/// panics after receiving the event). The failure is detected on the next
/// dispatch attempt to that worker's channel.
#[test]
fn worker_panic_respawns_and_redistributes() {
    let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();

    // Track how many times each worker index has been spawned.
    let spawn_counts: Vec<Arc<AtomicU64>> = (0..3).map(|_| Arc::new(AtomicU64::new(0))).collect();
    let sc_clone = spawn_counts.clone();

    let worker_counts: Vec<Arc<AtomicU64>> = (0..3).map(|_| Arc::new(AtomicU64::new(0))).collect();
    let wc_clone = worker_counts.clone();

    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, _queue_len, _sender, _pending| {
            let wc = Arc::clone(&wc_clone[index]);
            let sc = Arc::clone(&sc_clone[index]);
            let generation = sc.fetch_add(1, Ordering::SeqCst);
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(_)) => {
                            if index == 0 && generation == 0 {
                                // First-generation worker 0 panics on first event.
                                panic!("simulated worker 0 panic");
                            }
                            wc.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(WorkerMessage::Flush(_)) => {}
                        Ok(WorkerMessage::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
        },
    );

    // Dispatch one event to worker 0 (send succeeds, worker panics after recv).
    pool.dispatch(make_raw_event(RawEventType::Click, 0));
    // Give worker 0 time to panic and drop its receiver.
    thread::sleep(Duration::from_millis(100));

    // Dispatch more events. The next attempt to send to worker 0 will fail,
    // triggering a respawn. The event is retried on the fresh worker 0.
    for _ in 0..12 {
        pool.dispatch(make_raw_event(RawEventType::Click, 0));
    }

    thread::sleep(Duration::from_millis(100));

    let count0 = worker_counts[0].load(Ordering::SeqCst);
    let count1 = worker_counts[1].load(Ordering::SeqCst);
    let count2 = worker_counts[2].load(Ordering::SeqCst);

    // All 12 events should have been delivered across the workers.
    // (The first event that triggered the panic is lost — the worker panicked
    // while processing it. But all subsequent events are delivered.)
    assert_eq!(
        count0 + count1 + count2,
        12,
        "all 12 post-panic events should be delivered: w0={}, w1={}, w2={}",
        count0,
        count1,
        count2
    );

    // Worker 0 should have been spawned at least twice (original + respawn).
    assert!(
        spawn_counts[0].load(Ordering::SeqCst) >= 2,
        "worker 0 should have been respawned"
    );

    pool.shutdown();
}

/// Test: workers that keep panicking get respawned, and shutdown still
/// completes cleanly without hanging.
#[test]
fn repeatedly_failing_workers_get_respawned_and_shutdown_completes() {
    let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();

    let spawn_total = Arc::new(AtomicU64::new(0));
    let st_clone = spawn_total.clone();

    // Track when workers have panicked so we know they're dead.
    let panicked_count = Arc::new(AtomicU64::new(0));
    let pc_clone = panicked_count.clone();

    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |_index, rx, _queue_len, _sender, _pending| {
            st_clone.fetch_add(1, Ordering::SeqCst);
            let pc = pc_clone.clone();
            std::thread::spawn(move || {
                // Each worker panics on first event, but handles Shutdown cleanly.
                match rx.recv() {
                    Ok(WorkerMessage::Event(_)) => {
                        pc.fetch_add(1, Ordering::SeqCst);
                        panic!("simulated worker panic");
                    }
                    Ok(WorkerMessage::Flush(_)) => {}
                    Ok(WorkerMessage::Shutdown) => {}
                    Err(_) => {}
                }
            })
        },
    );

    // Initial spawn: 3 workers.
    assert_eq!(spawn_total.load(Ordering::SeqCst), 3);

    // Dispatch events to trigger panics. The first send to each worker
    // succeeds (worker panics after recv). The failure is detected on the
    // next send attempt, which triggers a respawn.
    // Round 1: send 3 events (one to each worker, all succeed, all panic).
    for _ in 0..3 {
        pool.dispatch(make_raw_event(RawEventType::Click, 0));
    }

    // Wait until all 3 workers have actually panicked (not just a fixed sleep).
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while panicked_count.load(Ordering::SeqCst) < 3 {
        if std::time::Instant::now() > deadline {
            panic!(
                "Timed out waiting for workers to panic. Only {} of 3 panicked.",
                panicked_count.load(Ordering::SeqCst)
            );
        }
        thread::sleep(Duration::from_millis(10));
    }

    // Round 2: repeatedly dispatch events until respawns are detected.
    // The pool detects dead workers when send() fails (receiver dropped after
    // thread termination). On fast machines this is immediate; on slow CI
    // runners the thread teardown takes longer.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while spawn_total.load(Ordering::SeqCst) <= 3 {
        if std::time::Instant::now() > deadline {
            panic!(
                "Timed out waiting for respawns. Total spawns: {} (expected > 3)",
                spawn_total.load(Ordering::SeqCst)
            );
        }
        pool.dispatch(make_raw_event(RawEventType::Click, 0));
        thread::sleep(Duration::from_millis(50));
    }

    // Workers have been respawned (verified by the loop above).
    // Shutdown should complete without hanging.
    pool.shutdown();
}

/// Test: `max_sequence_id` returns 0 before any events dispatched.
#[test]
fn max_sequence_id_returns_zero_initially() {
    let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
    let pool = WorkerPool::new(
        1,
        action_tx,
        |_index, _rx, _queue_len, _sender, _pending| std::thread::spawn(|| {}),
    );

    assert_eq!(
        pool.max_sequence_id(),
        0,
        "max_sequence_id should be 0 before any events dispatched"
    );
}

/// Test: worker shutdown flushes pending type event.
#[test]
fn worker_shutdown_flushes_pending_type_event() {
    let values = vec!["h".to_string(), "he".to_string(), "hel".to_string()];
    let backend = MockBackend::with_focused_values(values);
    let harness = WorkerTestHarness::new(backend);

    // Send value-change events (rapid, within debounce).
    for i in 0..3 {
        let raw = RawEvent {
            event_type: RawEventType::ValueChange,
            sequence_id: (i + 1) as u64,
            timestamp: 10000 + (i as u64 * 10),
            screen_x: 0,
            screen_y: 0,
            window_handle: 100,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        };
        harness.send_event(raw);
    }

    // Small delay to ensure events are queued but debounce hasn't expired.
    thread::sleep(Duration::from_millis(100));

    // Shutdown immediately (before 500ms debounce expires).
    let events = harness.shutdown();

    // There should be exactly one Type event with the final value.
    let type_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Type { .. }))
        .collect();

    assert_eq!(
        type_events.len(),
        1,
        "shutdown should flush exactly 1 pending type event, got {}",
        type_events.len()
    );

    if let ActionPayload::Type { ref value, .. } = type_events[0].payload {
        assert_eq!(
            value, "hel",
            "flushed type event should have final value 'hel', got '{}'",
            value
        );
    } else {
        panic!("expected Type payload");
    }
}

/// Regression: #298 — a commit flush drains buffered actions mid-capture, and
/// the worker keeps running afterwards (contrast Shutdown, which drains + exits).
/// https://github.com/Arsarneq/docent/issues/298
#[test]
fn regression_298_flush_drains_pending_and_worker_continues() {
    let values = vec!["h".to_string(), "he".to_string(), "hel".to_string()];
    let harness = WorkerTestHarness::new(MockBackend::with_focused_values(values));

    // Buffer a pending type via rapid value-changes (within the 500ms debounce).
    for i in 0..3 {
        harness.send_event(RawEvent {
            event_type: RawEventType::ValueChange,
            sequence_id: (i + 1) as u64,
            timestamp: 10_000 + (i as u64 * 10),
            screen_x: 0,
            screen_y: 0,
            window_handle: 100,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        });
    }
    thread::sleep(Duration::from_millis(50)); // queued, debounce not yet expired

    // The flush drains the buffered type immediately — without waiting out the
    // 500ms debounce — and the worker acknowledges.
    let acked = harness.flush();
    assert_eq!(acked, 0, "the single worker (index 0) should acknowledge");

    let after_flush = harness.drain_actions();
    let type_events: Vec<&ActionEvent> = after_flush
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Type { .. }))
        .collect();
    assert_eq!(
        type_events.len(),
        1,
        "flush should drain exactly one pending type event, got {}",
        type_events.len()
    );
    if let ActionPayload::Type { ref value, .. } = type_events[0].payload {
        assert_eq!(value, "hel", "flushed type should carry the final value");
    } else {
        panic!("expected a Type payload");
    }

    // The worker did NOT exit on the flush: a subsequent event still produces an
    // action (Shutdown would have broken the loop here).
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 4,
        timestamp: 20_000,
        screen_x: 100,
        screen_y: 200,
        window_handle: 100,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });
    let after_click = harness.drain_actions();
    assert!(
        after_click
            .iter()
            .any(|e| matches!(e.payload, ActionPayload::Click { .. })),
        "worker should keep processing after a flush (expected a Click action)"
    );

    let _ = harness.shutdown();
}

/// Regression: #298 — `flush_all` fans the flush to every live worker, drains
/// their buffers into the action stream, emits exactly one `BarrierComplete`
/// sentinel LAST (carrying the barrier id), and reports no wedged workers when
/// all respond.
/// https://github.com/Arsarneq/docent/issues/298
#[test]
fn regression_298_flush_all_drains_workers_and_emits_sentinel_last() {
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let mut pool = WorkerPool::new(3, action_tx, |index, rx, queue_len, sender, pending| {
        thread::spawn(move || {
            let ep = Arc::new(AtomicU32::new(0));
            let backend = MockBackend::with_focused_values(vec![
                "a".to_string(),
                "ab".to_string(),
                "abc".to_string(),
            ]);
            worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
        })
    });

    // Buffer a pending type on one worker (value-changes for the same window are
    // sticky-routed to a single worker).
    for i in 0..3 {
        pool.dispatch(RawEvent {
            event_type: RawEventType::ValueChange,
            sequence_id: (i + 1) as u64,
            timestamp: 10_000 + (i as u64 * 10),
            screen_x: 0,
            screen_y: 0,
            window_handle: 100,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        });
    }
    thread::sleep(Duration::from_millis(80)); // buffered, debounce not expired

    let wedged = pool.flush_all(7, Duration::from_secs(2));
    assert!(
        wedged.is_empty(),
        "no worker should be wedged, got {wedged:?}"
    );

    let mut events = Vec::new();
    while let Ok(evt) = action_rx.recv_timeout(Duration::from_millis(200)) {
        events.push(evt);
    }

    let sentinels: Vec<u64> = events
        .iter()
        .filter_map(|e| match e.payload {
            ActionPayload::BarrierComplete { barrier_id } => Some(barrier_id),
            _ => None,
        })
        .collect();
    assert_eq!(
        sentinels,
        vec![7],
        "exactly one sentinel carrying barrier_id 7"
    );
    assert!(
        matches!(
            events.last().unwrap().payload,
            ActionPayload::BarrierComplete { .. }
        ),
        "the sentinel must be the LAST event on the stream"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e.payload, ActionPayload::Type { .. })),
        "the buffered type action should have been drained before the sentinel"
    );

    pool.shutdown();
}

/// A mock backend that panics when `element_at_point` is called with
/// specific "poison" coordinates, but works normally for all other events.
struct PoisonEventBackend {
    poison_x: i32,
    poison_y: i32,
}

impl AccessibilityBackend for PoisonEventBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }
    fn cleanup(&mut self) {}

    fn element_at_point(&self, x: i32, y: i32) -> Option<ElementDescription> {
        if x == self.poison_x && y == self.poison_y {
            panic!("poison event triggered panic in element_at_point");
        }
        Some(ElementDescription {
            tag: "Button".to_string(),
            id: Some("btn1".to_string()),
            name: Some("OK".to_string()),
            role: Some("button".to_string()),
            element_type: None,
            text: None,
            selector: "Button#btn1".to_string(),
            ..Default::default()
        })
    }

    fn focused_element(&self) -> Option<ElementDescription> {
        Some(ElementDescription {
            tag: "Edit".to_string(),
            id: Some("input1".to_string()),
            name: Some("Text Field".to_string()),
            role: Some("editable text".to_string()),
            element_type: None,
            text: Some("hello".to_string()),
            selector: "Edit#input1".to_string(),
            ..Default::default()
        })
    }

    fn window_title(&self, _window_handle: i64) -> String {
        "Test".to_string()
    }
    fn process_name(&self, _window_handle: i64) -> String {
        "test.exe".to_string()
    }
    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
        None
    }
    fn root_window_handle(&self, window_handle: i64) -> i64 {
        window_handle
    }
    fn window_rect(&self, _window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        // Non-origin for the same reason as MockBackend's rect: at (0,0) a
        // coordinate-space mix-up is invisible to assertions.
        Some(docent_desktop_lib::capture::WindowRect {
            x: 100,
            y: 50,
            width: 1920,
            height: 1080,
        })
    }
    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

/// Test: a "poison event" that causes a panic in event processing does NOT
/// kill the worker. The worker catches the panic, drops that single event,
/// and continues processing subsequent events normally.
#[test]
fn poison_event_does_not_kill_worker() {
    let backend = PoisonEventBackend {
        poison_x: 666,
        poison_y: 666,
    };
    let harness = WorkerTestHarness::new(backend);

    // Send a normal click event.
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 100,
        screen_y: 200,
        window_handle: 1,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    // Send the poison event (will panic inside element_at_point).
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 2,
        timestamp: 1001,
        screen_x: 666,
        screen_y: 666,
        window_handle: 1,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    // Send another normal click event after the poison.
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 3,
        timestamp: 1002,
        screen_x: 100,
        screen_y: 200,
        window_handle: 1,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    // Give the worker time to process all three events.
    thread::sleep(Duration::from_millis(200));

    let events = harness.shutdown();

    // We should have exactly 2 Click events (seq 1 and 3).
    // The poison event (seq 2) was dropped after the panic was caught.
    let click_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .collect();

    assert_eq!(
        click_events.len(),
        2,
        "expected 2 click events (poison event dropped), got {}",
        click_events.len()
    );

    assert_eq!(click_events[0].sequence_id, Some(1));
    assert_eq!(click_events[1].sequence_id, Some(3));
}

// ---------------------------------------------------------------------------
// Locator pass-through (issues #138/#139)
// ---------------------------------------------------------------------------

/// A backend whose elements carry locator candidates and provider facts —
/// guards the pipeline against silently stripping them between the backend
/// and the emitted ActionEvent.
struct LocatorBackend;

fn locator_rich_element() -> ElementDescription {
    use docent_desktop_lib::capture::{LocatorEntry, LocatorMatch};
    ElementDescription {
        tag: "Edit".to_string(),
        id: Some("txtAmount".to_string()),
        name: Some("Amount".to_string()),
        role: Some("edit".to_string()),
        element_type: None,
        text: Some("100".to_string()),
        selector: "Window:App > Edit:Amount".to_string(),
        position_in_set: Some(2),
        size_of_set: Some(5),
        level: Some(1),
        framework_id: Some("WPF".to_string()),
        locators: vec![
            LocatorEntry::AutomationId {
                value: "txtAmount".to_string(),
                stats: LocatorMatch {
                    match_count: Some(1),
                    match_index: Some(Some(0)),
                },
            },
            LocatorEntry::TreePath {
                value: "Window:App > Edit:Amount".to_string(),
            },
        ],
        // The backend emits no latency; the worker stamps it (docent#220).
        described_after_ms: None,
    }
}

impl AccessibilityBackend for LocatorBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }
    fn cleanup(&mut self) {}
    fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
        Some(locator_rich_element())
    }
    fn focused_element(&self) -> Option<ElementDescription> {
        Some(locator_rich_element())
    }
    fn window_title(&self, _window_handle: i64) -> String {
        "App".to_string()
    }
    fn process_name(&self, _window_handle: i64) -> String {
        "test.exe".to_string()
    }
    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
        None
    }
    fn root_window_handle(&self, window_handle: i64) -> i64 {
        window_handle
    }
    fn window_rect(&self, _window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        None
    }
    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

/// Locator candidates and provider facts produced by the backend must reach
/// the emitted ActionEvent verbatim — nothing in the worker pipeline may
/// strip or rewrite them.
#[test]
fn locators_and_provider_facts_pass_through_the_pipeline_verbatim() {
    let harness = WorkerTestHarness::new(LocatorBackend);
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 10,
        screen_y: 20,
        window_handle: 1,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let click = events
        .iter()
        .find(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .expect("expected a Click event");
    if let ActionPayload::Click { ref element, .. } = click.payload {
        // The describe-latency stamp is the ONE deliberate worker-side
        // mutation (docent#220) — everything else must ride verbatim.
        assert!(
            element.described_after_ms.is_some(),
            "dequeue-described element must carry the describe latency"
        );
        let mut unstamped = element.clone();
        unstamped.described_after_ms = None;
        assert_eq!(
            unstamped,
            locator_rich_element(),
            "element must pass through verbatim (modulo the latency stamp)"
        );
    } else {
        unreachable!("filtered to Click above");
    }
}

/// Pre-captured hook clicks were described at the input itself — the worker
/// must export that as a latency of exactly 0, and must not re-describe.
#[test]
fn pre_captured_click_exports_zero_describe_latency() {
    let harness = WorkerTestHarness::new(LocatorBackend);
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 10,
        screen_y: 20,
        window_handle: 1,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: Some(locator_rich_element()),
        focus_epoch: 0,
    });

    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let click = events
        .iter()
        .find(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .expect("expected a Click event");
    if let ActionPayload::Click { ref element, .. } = click.payload {
        assert_eq!(
            element.described_after_ms,
            Some(0),
            "hook pre-captured elements are described at input time"
        );
    } else {
        unreachable!("filtered to Click above");
    }
}

/// A described element whose click downgrades to coordinate mode must shed
/// every element-identity claim (docent#220): coordinate mode records where
/// the user acted, and the schema documents locators as absent there.
#[test]
fn coordinate_downgrade_strips_locators_facts_and_latency() {
    struct WindowElementBackend;
    impl AccessibilityBackend for WindowElementBackend {
        fn init(&mut self) -> Result<(), CaptureError> {
            Ok(())
        }
        fn cleanup(&mut self) {}
        fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
            // A window background: real description, measured locators —
            // but tag "Window" downgrades the click to coordinate mode.
            Some(ElementDescription {
                tag: "Window".to_string(),
                ..locator_rich_element()
            })
        }
        fn focused_element(&self) -> Option<ElementDescription> {
            None
        }
        fn window_title(&self, _window_handle: i64) -> String {
            "App".to_string()
        }
        fn process_name(&self, _window_handle: i64) -> String {
            "test.exe".to_string()
        }
        fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
            None
        }
        fn root_window_handle(&self, window_handle: i64) -> i64 {
            window_handle
        }
        fn window_rect(
            &self,
            _window_handle: i64,
        ) -> Option<docent_desktop_lib::capture::WindowRect> {
            None
        }
        fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
            None
        }
    }

    let harness = WorkerTestHarness::new(WindowElementBackend);
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 10,
        screen_y: 20,
        window_handle: 1,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let click = events
        .iter()
        .find(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .expect("expected a Click event");
    assert!(matches!(click.capture_mode, CaptureMode::Coordinate));
    if let ActionPayload::Click { ref element, .. } = click.payload {
        assert!(element.locators.is_empty(), "coordinate mode: no locators");
        assert_eq!(element.position_in_set, None);
        assert_eq!(element.size_of_set, None);
        assert_eq!(element.level, None);
        assert_eq!(element.framework_id, None);
        assert_eq!(element.described_after_ms, None);
    } else {
        unreachable!("filtered to Click above");
    }
}

// ---------------------------------------------------------------------------
// context_open facts (issue #229)
// ---------------------------------------------------------------------------

/// context_open must carry the observed executable path as `source` and must
/// never fabricate an opener: the pipeline does not observe which window
/// caused the create, so `opener_context_id` is null — not a self-reference.
#[test]
fn context_open_carries_process_source_and_no_fabricated_opener() {
    let harness = WorkerTestHarness::new(LocatorBackend);
    harness.send_event(RawEvent {
        event_type: RawEventType::WindowCreate,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 0,
        screen_y: 0,
        window_handle: 42,
        process_id: 7,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let open = events
        .iter()
        .find(|e| matches!(e.payload, ActionPayload::ContextOpen { .. }))
        .expect("expected a ContextOpen event");
    if let ActionPayload::ContextOpen {
        ref opener_context_id,
        ref source,
    } = open.payload
    {
        assert_eq!(
            *source,
            Some("test.exe".to_string()),
            "source must carry the observed executable path"
        );
        assert_eq!(
            *opener_context_id, None,
            "opener is not observed — null, never the window's own id"
        );
    } else {
        unreachable!("filtered to ContextOpen above");
    }
}

// ---------------------------------------------------------------------------
// Coordinate-space truth-lock (issue #141)
// ---------------------------------------------------------------------------

/// A backend that cannot resolve any element, forcing the coordinate-fallback
/// path, with its window deliberately NOT at the screen origin.
struct NoElementBackend;

impl AccessibilityBackend for NoElementBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }
    fn cleanup(&mut self) {}
    fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
        None
    }
    fn focused_element(&self) -> Option<ElementDescription> {
        None
    }
    fn window_title(&self, _window_handle: i64) -> String {
        "Plain Window".to_string()
    }
    fn process_name(&self, _window_handle: i64) -> String {
        "test.exe".to_string()
    }
    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
        None
    }
    fn root_window_handle(&self, window_handle: i64) -> i64 {
        window_handle
    }
    fn window_rect(&self, _window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        Some(docent_desktop_lib::capture::WindowRect {
            x: 100,
            y: 50,
            width: 1920,
            height: 1080,
        })
    }
    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

/// Truth-lock for the format's CURRENT coordinate semantics (issue #141):
/// with the window at a non-origin position, a coordinate-fallback click emits
/// the raw SCREEN point — identically in the action's `x`/`y` and in the
/// `coord:` selector — and never a window-relative one. If window-relative
/// values ever ship, they must arrive as new named fields; this test failing
/// on `x`/`y` or `coord:` means emitted meaning changed in place, which the
/// version classifier cannot see (`scripts/bump-schema.js` exists for that).
#[test]
fn coordinate_fallback_emits_screen_space_verbatim_for_non_origin_window() {
    use docent_desktop_lib::capture::CaptureMode;

    let harness = WorkerTestHarness::new(NoElementBackend);
    harness.send_event(RawEvent {
        event_type: RawEventType::Click,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 412,
        screen_y: 633,
        window_handle: 1,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let click = events
        .iter()
        .find(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .expect("expected a Click event from the coordinate-fallback path");

    assert_eq!(click.capture_mode, CaptureMode::Coordinate);
    assert_eq!(
        click.window_rect,
        Some(docent_desktop_lib::capture::WindowRect {
            x: 100,
            y: 50,
            width: 1920,
            height: 1080,
        }),
        "window_rect is carried verbatim (physical pixels)"
    );

    if let ActionPayload::Click { x, y, ref element } = click.payload {
        // Screen space, verbatim: NOT (412-100, 633-50) = (312, 583).
        assert_eq!((x, y), (412.0, 633.0), "action x/y are raw screen values");
        assert_eq!(
            element.selector, "coord:412,633",
            "the coord: selector encodes the same raw screen point"
        );
        assert_eq!(element.tag, "unknown");
        assert_eq!(element.name.as_deref(), Some("Plain Window"));
    } else {
        unreachable!("filtered to Click above");
    }
}

// ---------------------------------------------------------------------------
// Additional unit tests for coverage gaps
// ---------------------------------------------------------------------------

/// Test: scroll accumulator flush on timeout — when the worker receives scroll
/// events and then no more events arrive, the periodic timeout flush emits
/// the accumulated scroll action.
#[test]
fn scroll_accumulator_flushes_on_timeout() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    // Send multiple scroll events (rapid, within debounce window).
    // Use current_timestamp so the debounce calculation works correctly.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    for i in 0..5 {
        let raw = RawEvent {
            event_type: RawEventType::Scroll,
            sequence_id: (i + 1) as u64,
            timestamp: now + (i as u64 * 20), // 20ms apart
            screen_x: 500,
            screen_y: 500,
            window_handle: 100,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 100.0, // Each scroll event has delta 100 (total 500 > 200 threshold)
            callback_params: [0, 0, 0, 0], // vertical scroll
            pre_captured_element: None,
            focus_epoch: 0,
        };
        harness.send_event(raw);
    }

    // Wait for the scroll debounce (300ms) + recv_timeout (50ms) + margin.
    thread::sleep(Duration::from_millis(600));

    let events = harness.shutdown();

    // Should have at least one Scroll action event from the timeout flush.
    let scroll_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Scroll { .. }))
        .collect();

    assert!(
        !scroll_events.is_empty(),
        "expected at least 1 scroll event from timeout flush, got 0 (total events: {})",
        events.len()
    );
}

/// Test: scroll accumulator flush on shutdown — when the worker has pending
/// scroll events and receives Shutdown, the scroll is flushed.
#[test]
fn scroll_accumulator_flushes_on_shutdown() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    // Use current timestamp so the accumulator's debounce check works.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    // Send scroll events that exceed the threshold (total > 200 wheel-delta units).
    for i in 0..3 {
        let raw = RawEvent {
            event_type: RawEventType::Scroll,
            sequence_id: (i + 1) as u64,
            timestamp: now + (i as u64 * 10),
            screen_x: 500,
            screen_y: 500,
            window_handle: 100,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 150.0,           // total 450 > 200 threshold
            callback_params: [0, 0, 0, 0], // vertical scroll
            pre_captured_element: None,
            focus_epoch: 0,
        };
        harness.send_event(raw);
    }

    // Shutdown immediately (before debounce expires).
    // The shutdown path flushes with u64::MAX timestamp which always exceeds debounce.
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    // Should have a scroll event from the shutdown flush.
    let scroll_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Scroll { .. }))
        .collect();

    assert!(
        !scroll_events.is_empty(),
        "expected scroll event from shutdown flush, got 0 (total events: {})",
        events.len()
    );
}

/// Test: focus deduplication — consecutive focus events on the same element
/// should produce only one Focus action event.
#[test]
fn focus_deduplication_suppresses_consecutive_same_element() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    // Send two focus events for the same window (same element via mock).
    for i in 0..2 {
        let raw = RawEvent {
            event_type: RawEventType::Focus,
            sequence_id: (i + 1) as u64,
            timestamp: 10000 + (i as u64 * 100),
            screen_x: 0,
            screen_y: 0,
            window_handle: 100,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        };
        harness.send_event(raw);
    }

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    // Only one focus event should be emitted (second is deduplicated).
    let focus_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Focus { .. }))
        .collect();

    assert_eq!(
        focus_events.len(),
        1,
        "expected 1 focus event (dedup), got {} (total events: {})",
        focus_events.len(),
        events.len()
    );
}

/// Test: value-change deduplication — consecutive value-change events with
/// the same value should not produce duplicate type events.
#[test]
fn value_change_deduplication_same_value() {
    // All focused_element calls return the same text value.
    let values = vec![
        "same_value".to_string(),
        "same_value".to_string(),
        "same_value".to_string(),
    ];
    let backend = MockBackend::with_focused_values(values);
    let harness = WorkerTestHarness::new(backend);

    // Send three value-change events that all resolve to the same value.
    for i in 0..3 {
        let raw = RawEvent {
            event_type: RawEventType::ValueChange,
            sequence_id: (i + 1) as u64,
            timestamp: 10000 + (i as u64 * 10),
            screen_x: 0,
            screen_y: 0,
            window_handle: 100,
            process_id: 1,
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        };
        harness.send_event(raw);
    }

    // Wait for debounce to expire.
    thread::sleep(Duration::from_millis(700));
    let events = harness.shutdown();

    // Should produce at most one type event (dedup suppresses duplicates).
    let type_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Type { .. }))
        .collect();

    assert!(
        type_events.len() <= 1,
        "expected at most 1 type event (dedup same value), got {}",
        type_events.len()
    );
}

/// Test: keyboard event produces a Key action event for control keys.
#[test]
fn keyboard_event_produces_key_action() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    // Send a keyboard event for Enter key (0x0D).
    let raw = RawEvent {
        event_type: RawEventType::Keyboard,
        sequence_id: 1,
        timestamp: 10000,
        screen_x: 0,
        screen_y: 0,
        window_handle: 100,
        process_id: 1,
        key_code: 0x0D, // Enter
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    };
    harness.send_event(raw);

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    // Should have a Key action event.
    let key_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Key { .. }))
        .collect();

    assert_eq!(
        key_events.len(),
        1,
        "expected 1 key event for Enter, got {}",
        key_events.len()
    );
}

/// Test: keyboard event with modifier-only key (Shift alone) is skipped.
#[test]
fn modifier_only_key_is_skipped() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    // Send a keyboard event for left Shift (0xA0) — modifier-only, should be skipped.
    let raw = RawEvent {
        event_type: RawEventType::Keyboard,
        sequence_id: 1,
        timestamp: 10000,
        screen_x: 0,
        screen_y: 0,
        window_handle: 100,
        process_id: 1,
        key_code: 0xA0, // VK_LSHIFT
        modifiers: (false, true, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    };
    harness.send_event(raw);

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    // Should NOT produce a key event for modifier-only keys.
    let key_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Key { .. }))
        .collect();

    assert_eq!(
        key_events.len(),
        0,
        "expected 0 key events for modifier-only key, got {}",
        key_events.len()
    );
}

/// Test: foreground event produces a ContextSwitch action.
#[test]
fn foreground_event_produces_context_switch() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    let raw = RawEvent {
        event_type: RawEventType::Foreground,
        sequence_id: 1,
        timestamp: 10000,
        screen_x: 0,
        screen_y: 0,
        window_handle: 200,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    };
    harness.send_event(raw);

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    let ctx_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::ContextSwitch { .. }))
        .collect();

    assert_eq!(
        ctx_events.len(),
        1,
        "expected 1 context_switch event, got {}",
        ctx_events.len()
    );
}

/// Test: right-click event produces a RightClick action.
#[test]
fn right_click_event_produces_right_click_action() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    let raw = RawEvent {
        event_type: RawEventType::RightClick,
        sequence_id: 1,
        timestamp: 10000,
        screen_x: 300,
        screen_y: 400,
        window_handle: 100,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0; 4],
        pre_captured_element: None,
        focus_epoch: 0,
    };
    harness.send_event(raw);

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    let rc_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::RightClick { .. }))
        .collect();

    assert_eq!(
        rc_events.len(),
        1,
        "expected 1 right_click event, got {}",
        rc_events.len()
    );
}

/// Test: excluded PID events are discarded.
#[test]
fn excluded_pid_events_are_discarded() {
    let backend = MockBackend::new();
    let (event_tx, event_rx) = mpsc::channel::<WorkerMessage>();
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let queue_len = Arc::new(AtomicU64::new(0));
    let excluded_pid = Arc::new(AtomicU32::new(42)); // Exclude PID 42

    let ql = Arc::clone(&queue_len);
    let ep = Arc::clone(&excluded_pid);

    let thread_handle = thread::spawn(move || {
        let pending = std::sync::Arc::new(Mutex::new(PendingBuffers::default()));
        worker_loop(0, backend, event_rx, ql, action_tx, ep, pending, None);
    });

    // Send an event from the excluded PID.
    queue_len.fetch_add(1, Ordering::SeqCst);
    event_tx
        .send(WorkerMessage::Event(Box::new(RawEvent {
            event_type: RawEventType::Click,
            sequence_id: 1,
            timestamp: 10000,
            screen_x: 100,
            screen_y: 200,
            window_handle: 100,
            process_id: 42, // Excluded PID
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        })))
        .unwrap();

    // Send a normal event from a different PID.
    queue_len.fetch_add(1, Ordering::SeqCst);
    event_tx
        .send(WorkerMessage::Event(Box::new(RawEvent {
            event_type: RawEventType::Click,
            sequence_id: 2,
            timestamp: 10001,
            screen_x: 100,
            screen_y: 200,
            window_handle: 100,
            process_id: 99, // Not excluded
            key_code: 0,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0; 4],
            pre_captured_element: None,
            focus_epoch: 0,
        })))
        .unwrap();

    thread::sleep(Duration::from_millis(200));
    let _ = event_tx.send(WorkerMessage::Shutdown);
    thread_handle.join().unwrap();

    // Collect events.
    let mut events = Vec::new();
    while let Ok(evt) = action_rx.try_recv() {
        events.push(evt);
    }

    // Only the non-excluded event should produce an action.
    let click_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .collect();

    assert_eq!(
        click_events.len(),
        1,
        "expected 1 click event (excluded PID filtered), got {}",
        click_events.len()
    );
    assert_eq!(click_events[0].sequence_id, Some(2));
}

/// Test: selection events immediately after a click are suppressed by the
/// input thread (verified in capture_integration.rs::select_suppressed_after_click).
/// This test verifies the worker-level behaviour: if a selection event DOES
/// arrive at the worker (i.e. wasn't filtered by the input thread), it produces
/// a select action.
#[test]
fn selection_event_produces_select_action() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(RawEvent {
        event_type: RawEventType::Selection,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 100,
        screen_y: 200,
        window_handle: 1234,
        process_id: 1,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [0, 0, 0, 0],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    let select_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Select { .. }))
        .collect();

    assert_eq!(
        select_events.len(),
        1,
        "expected 1 select event, got {}",
        select_events.len()
    );
}

/// Test: modifier-only keys (Shift, Ctrl, Alt variants) are skipped by
/// the keyboard handler — they produce no action events.
/// Note: VK_LWIN/VK_RWIN (0x5B/0x5C) produce "Meta" and ARE captured.
/// Covers issue #59 acceptance criteria: verify modifier-variant keys are suppressed.
#[test]
fn modifier_only_keys_produce_no_events() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    // VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2,
    // VK_RCONTROL = 0xA3, VK_LMENU = 0xA4, VK_RMENU = 0xA5
    // These all return empty string from vk_to_key_name → skipped.
    for vk in [0xA0u32, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5] {
        harness.send_event(RawEvent {
            event_type: RawEventType::Keyboard,
            sequence_id: 1,
            timestamp: 1000,
            screen_x: 0,
            screen_y: 0,
            window_handle: 1234,
            process_id: 1,
            key_code: vk,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [0, 0, 0, 0],
            pre_captured_element: None,
            focus_epoch: 0,
        });
    }

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(
        events.len(),
        0,
        "modifier-only keys should produce no events, got {}",
        events.len()
    );
}

/// Test: Win+L key combo — the L key with meta modifier IS captured as a key
/// event (our code doesn't suppress it). The actual suppression of Win+L
/// happens at the OS kernel level — the low-level hook never receives it.
/// This test documents that if Win+L somehow reached our code, it would be
/// captured as a normal key event (Meta+L).
#[test]
fn win_l_key_combo_is_captured_if_received() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    // VK_L = 0x4C, meta = true
    harness.send_event(RawEvent {
        event_type: RawEventType::Keyboard,
        sequence_id: 1,
        timestamp: 1000,
        screen_x: 0,
        screen_y: 0,
        window_handle: 1234,
        process_id: 1,
        key_code: 0x4C,                         // VK_L
        modifiers: (false, false, false, true), // meta = true
        scroll_delta: 0.0,
        callback_params: [0, 0, 0, 0],
        pre_captured_element: None,
        focus_epoch: 0,
    });

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    // The key event IS emitted (our code doesn't suppress Win+L — the OS does).
    let key_events: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Key { .. }))
        .collect();

    assert_eq!(
        key_events.len(),
        1,
        "Win+L should be captured if it reaches the worker (OS suppresses it before our hook)"
    );
}

// ---------------------------------------------------------------------------
// Unicode-injected keystrokes (VK_PACKET) — docent#260
// ---------------------------------------------------------------------------
//
// Text injected with `SendInput` and `KEYEVENTF_UNICODE` (IME results, remote
// desktop stacks, software keyboards, automation) reaches the low-level hook as
// `VK_PACKET` (0xE7) keydowns whose scan code is the injected UTF-16 code unit;
// the hook hands that unit to the worker in `callback_params[0]`. These pin the
// worker's side: such a keystroke is printable input, buffered like a layout
// printable so a value change supersedes it, and named by its character when
// no value change arrives.

const VK_PACKET: u32 = 0xE7;

/// Wall-clock milliseconds, so the worker's debounce tick (which compares
/// against the real clock) holds buffered keys until the test's own events land.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// A `VK_PACKET` keydown carrying one UTF-16 code unit, as the hook builds it.
fn packet_key(seq: u64, timestamp: u64, unit: u16) -> RawEvent {
    RawEvent {
        event_type: RawEventType::Keyboard,
        sequence_id: seq,
        timestamp,
        screen_x: 0,
        screen_y: 0,
        window_handle: 1234,
        process_id: 1,
        key_code: VK_PACKET,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [i64::from(unit), 0, 0, 0],
        pre_captured_element: None,
        focus_epoch: 0,
    }
}

fn key_names_of(events: &[ActionEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key { key, .. } => Some(key.clone()),
            _ => None,
        })
        .collect()
}

/// Regression for docent#260: injected keystrokes followed by the value change
/// they caused are recorded as the one `type`, with no `key` beside it.
#[test]
fn regression_260_injected_keys_are_superseded_by_the_type() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    for (i, unit) in "h i".encode_utf16().enumerate() {
        harness.send_event(packet_key(i as u64 + 1, t + i as u64, unit));
    }
    let mut value_change = make_raw_event(RawEventType::ValueChange, 1234);
    value_change.sequence_id = 4;
    value_change.timestamp = t + 3;
    harness.send_event(value_change);

    // Past TYPE_DEBOUNCE_MS (500 ms), so the type flushes on the worker's tick.
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "injected keystrokes must be superseded by the type, got {events:?}"
    );
    let type_count = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Type { .. }))
        .count();
    assert_eq!(
        type_count, 1,
        "expected the one coalesced type, got {events:?}"
    );
}

/// Regression for docent#260: with no value change (a control that is not
/// editable), injected keystrokes are written as keys named by the character
/// they carried — never `VK_0xE7`, which names no key the person pressed.
#[test]
fn regression_260_injected_keys_without_a_type_are_named_by_their_character() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    for (i, unit) in "h é".encode_utf16().enumerate() {
        harness.send_event(packet_key(i as u64 + 1, t + i as u64, unit));
    }

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    // A space carries the name a layout space key gets.
    assert_eq!(key_names_of(&events), vec!["h", "Space", "é"]);
}

/// A code unit that is no character on its own — either half of a surrogate
/// pair, or a control character — is still buffered (so a value change
/// supersedes it), and when written it carries `Unidentified`, the key value
/// for a key whose identity is not known, rather than a made-up name.
#[test]
fn regression_260_injected_units_that_are_no_character_are_unidentified() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    // U+1F600 as its surrogate pair, then a carriage return.
    let units: Vec<u16> = "😀\r".encode_utf16().collect();
    assert_eq!(units.len(), 3);
    for (i, unit) in units.iter().enumerate() {
        harness.send_event(packet_key(i as u64 + 1, t + i as u64, *unit));
    }

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        key_names_of(&events),
        vec!["Unidentified".to_string(); 3],
        "no unit should be named VK_0xE7 or by a lone surrogate, got {events:?}"
    );
}

/// The supersede rule holds for the units that are no character too: a value
/// change after an injected surrogate pair leaves only the `type`.
#[test]
fn regression_260_injected_surrogate_pair_is_superseded_by_the_type() {
    let backend = MockBackend::new();
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    let units: Vec<u16> = "😀".encode_utf16().collect();
    for (i, unit) in units.iter().enumerate() {
        harness.send_event(packet_key(i as u64 + 1, t + i as u64, *unit));
    }
    let mut value_change = make_raw_event(RawEventType::ValueChange, 1234);
    value_change.sequence_id = 3;
    value_change.timestamp = t + 2;
    harness.send_event(value_change);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "got {events:?}"
    );
}

// ---------------------------------------------------------------------------
// Sacred-buffer drains on the dead-worker paths
// ---------------------------------------------------------------------------
//
// Every action that has reached a worker's held buffers must survive any
// commit or stop (DCP-12). These pin the two dead-worker paths that used to
// drop them: the dispatch-time respawn (fresh buffers installed over the dead
// worker's) and shutdown's join-of-an-already-finished worker (joined without
// the detach branch's rescue drain). Origin: the flush-barrier dual review on
// https://github.com/Arsarneq/docent/pull/400.

/// A completed-but-held key ActionEvent for seeding a worker's buffers.
fn held_key(key: &str) -> ActionEvent {
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
                selector: "win > edit".to_string(),
                ..Default::default()
            },
        },
    }
}

/// Names of the Key actions in a slice of events, in order.
fn held_key_names(events: &[ActionEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key { key, .. } => Some(key.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn respawn_drains_the_dead_workers_held_buffers() {
    use std::sync::atomic::AtomicUsize;

    let spawn_count = Arc::new(AtomicUsize::new(0));
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    // Seeded-signal channel: the dying worker signals AFTER it has seeded its
    // buffers and dropped its receiver, so the test proceeds exactly when the
    // death is observable — no timing sleep to race a loaded machine.
    let (seeded_tx, seeded_rx) = mpsc::channel::<()>();
    let spawn_count_in_closure = Arc::clone(&spawn_count);

    let mut pool = WorkerPool::new(
        1,
        action_tx,
        move |_index, rx, _queue_len, _sender, pending| {
            let generation = spawn_count_in_closure.fetch_add(1, Ordering::SeqCst);
            let seeded = seeded_tx.clone();
            thread::spawn(move || {
                if generation == 0 {
                    // First generation: buffer completed actions, then die
                    // without draining (models a worker killed outside the
                    // per-event panic guard). Signal only after the receiver is
                    // dropped, so a dispatch after the signal deterministically
                    // observes the death.
                    pending.lock().unwrap().pending_keys = vec![held_key("k1"), held_key("k2")];
                    drop(rx);
                    let _ = seeded.send(());
                } else {
                    // Replacement: a well-behaved worker.
                    while let Ok(msg) = rx.recv() {
                        if matches!(msg, WorkerMessage::Shutdown) {
                            break;
                        }
                    }
                }
            })
        },
    );

    seeded_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the seeded worker must report before the test proceeds");

    // Dispatch: the pool finds the worker dead, respawns it in place, and — the
    // guarantee under test — drains the dead worker's held buffers into the
    // action stream instead of replacing them with fresh empty ones. The drain
    // runs synchronously inside the respawn, so the actions are already on the
    // channel when dispatch returns.
    pool.dispatch(make_raw_event(RawEventType::Click, 100));

    let events: Vec<ActionEvent> = action_rx.try_iter().collect();
    assert_eq!(
        held_key_names(&events),
        vec!["k1", "k2"],
        "the dead worker's held completed actions must be drained at respawn"
    );

    pool.shutdown();
}

#[test]
fn shutdown_drains_the_buffers_of_an_already_dead_worker() {
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    // Seeded-signal channel — same discipline as the respawn test above: the
    // signal follows the receiver drop, so shutdown deterministically finds a
    // dead (or imminently finished) worker rather than racing a sleep.
    let (seeded_tx, seeded_rx) = mpsc::channel::<()>();
    let mut pool = WorkerPool::new(
        1,
        action_tx,
        move |_index, rx, _queue_len, _sender, pending| {
            let seeded = seeded_tx.clone();
            thread::spawn(move || {
                // Buffer completed actions, then die without draining. At
                // shutdown this worker reports finished (not wedged), so it is
                // joined — and the join branch must drain what it held, exactly
                // as the detach branch rescues a wedged worker's buffers.
                pending.lock().unwrap().pending_keys = vec![held_key("d1"), held_key("d2")];
                drop(rx);
                let _ = seeded.send(());
            })
        },
    );

    seeded_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the seeded worker must report before the test proceeds");

    pool.shutdown();

    let events: Vec<ActionEvent> = action_rx.try_iter().collect();
    assert_eq!(
        held_key_names(&events),
        vec!["d1", "d2"],
        "an already-dead worker's held completed actions must be drained at shutdown"
    );
}

// ---------------------------------------------------------------------------
// Typing across the pool: one `type`, no `key` beside it (DCP-9)
// ---------------------------------------------------------------------------
//
// The worker tests above feed one worker. These feed the pool, where a burst of
// keystrokes arrives while every worker is still busy describing an earlier
// event, and the value changes the burst caused arrive behind it.

use std::sync::Condvar;

/// The latch a [`TypingBackend`] waits on before answering a focused-element
/// query: closed, every worker stays inside its first query; opened, they run.
type Gate = Arc<(Mutex<bool>, Condvar)>;

fn closed_gate() -> Gate {
    Arc::new((Mutex::new(false), Condvar::new()))
}

fn open_gate(gate: &Gate) {
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
}

/// A backend whose focused element is one edit field holding `text`, of
/// `element_type` (`Some("password")` for a password field), described only
/// once `gate` is open.
struct TypingBackend {
    gate: Gate,
    element_type: Option<String>,
    text: Option<String>,
}

impl TypingBackend {
    fn edit(gate: &Gate, text: &str) -> Self {
        Self {
            gate: Arc::clone(gate),
            element_type: None,
            text: Some(text.to_string()),
        }
    }

    fn password(gate: &Gate) -> Self {
        Self {
            gate: Arc::clone(gate),
            element_type: Some("password".to_string()),
            text: None,
        }
    }
}

impl AccessibilityBackend for TypingBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }

    fn cleanup(&mut self) {}

    fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
        None
    }

    fn focused_element(&self) -> Option<ElementDescription> {
        let (open, signal) = &*self.gate;
        let guard = open.lock().unwrap();
        // Bounded, so a test that never opens the gate fails instead of hanging.
        let _open = signal
            .wait_timeout_while(guard, Duration::from_secs(10), |open| !*open)
            .unwrap();
        Some(ElementDescription {
            tag: "Edit".to_string(),
            id: Some("field1".to_string()),
            name: Some("Field".to_string()),
            role: Some("editable text".to_string()),
            element_type: self.element_type.clone(),
            text: self.text.clone(),
            selector: "Edit#field1".to_string(),
            ..Default::default()
        })
    }

    fn window_title(&self, _window_handle: i64) -> String {
        "Test Window".to_string()
    }

    fn process_name(&self, _window_handle: i64) -> String {
        "test.exe".to_string()
    }

    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
        None
    }

    fn root_window_handle(&self, window_handle: i64) -> i64 {
        window_handle
    }

    fn window_rect(&self, _window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        None
    }

    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

/// A keydown of a layout key (`key_code` is its virtual-key code).
fn layout_key(seq: u64, timestamp: u64, key_code: u32) -> RawEvent {
    let mut raw = make_raw_event(RawEventType::Keyboard, 1234);
    raw.sequence_id = seq;
    raw.timestamp = timestamp;
    raw.key_code = key_code;
    raw
}

fn value_change(seq: u64, timestamp: u64, window_handle: i64) -> RawEvent {
    let mut raw = make_raw_event(RawEventType::ValueChange, window_handle);
    raw.sequence_id = seq;
    raw.timestamp = timestamp;
    raw
}

fn type_values_of(events: &[ActionEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Type { value, .. } => Some(value.clone()),
            _ => None,
        })
        .collect()
}

/// Regression: twelve keystrokes typed as one burst into an edit field were
/// recorded as the `type` plus eight `key` actions, out of typing order. The
/// burst arrived while the workers were busy, so shortest-queue dispatch spread
/// the keystrokes over all three; the value changes reached one worker, which
/// discarded only the keystrokes it held itself, and the other two workers
/// wrote theirs as keys when the debounce ran out.
#[test]
fn regression_noissue_a_typing_burst_over_busy_workers_records_one_type() {
    let gate = closed_gate();
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let worker_gate = Arc::clone(&gate);
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = TypingBackend::edit(&worker_gate, "hello docent");
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );

    // The burst: every keystroke is dispatched before any worker has answered.
    let t = now_ms();
    let mut seq = 0;
    for unit in "hello docent".encode_utf16() {
        seq += 1;
        pool.dispatch(packet_key(seq, t, unit));
    }
    // The value changes the burst caused, from the edit control's own window.
    for _ in 0..3 {
        seq += 1;
        pool.dispatch(value_change(seq, t + 5, 5678));
    }
    open_gate(&gate);

    // Past TYPE_DEBOUNCE_MS (500 ms), so every worker's tick has flushed.
    thread::sleep(Duration::from_millis(900));
    pool.shutdown();
    let events: Vec<ActionEvent> = action_rx.try_iter().collect();

    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "the type supersedes every keystroke of the burst, got {events:?}"
    );
    assert_eq!(
        type_values_of(&events),
        vec!["hello docent"],
        "expected the one coalesced type, got {events:?}"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Typing routing
    ///
    /// For any mix of keyboard and value-change events over any windows, with
    /// clicks between them loading the queues, one worker receives every
    /// keyboard and value-change event.
    #[test]
    fn keyboard_and_value_change_events_reach_one_worker(
        events in proptest::collection::vec((0u8..3, 1i64..6), 2..60),
    ) {
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        let typing_counts: Vec<Arc<AtomicU64>> = (0..3)
            .map(|_| Arc::new(AtomicU64::new(0)))
            .collect();
        let tc_clone = typing_counts.clone();

        // Workers never dequeue until shutdown, so the queue lengths the
        // dispatcher reads are exactly what the test dispatched.
        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender, _pending| {
            let tc = Arc::clone(&tc_clone[index]);
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(raw)) => {
                            if matches!(
                                raw.event_type,
                                RawEventType::Keyboard | RawEventType::ValueChange
                            ) {
                                tc.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        Ok(WorkerMessage::Flush(_)) => {}
                        Ok(WorkerMessage::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
        });

        let mut typing_total = 0u64;
        for (kind, window_handle) in &events {
            let event_type = match kind {
                0 => RawEventType::Keyboard,
                1 => RawEventType::ValueChange,
                _ => RawEventType::Click,
            };
            if *kind < 2 {
                typing_total += 1;
            }
            pool.dispatch(make_raw_event(event_type, *window_handle));
        }
        pool.shutdown();

        let counts: Vec<u64> = typing_counts
            .iter()
            .map(|c| c.load(Ordering::SeqCst))
            .collect();
        prop_assert_eq!(counts.iter().sum::<u64>(), typing_total);
        prop_assert!(
            counts.iter().filter(|&&c| c > 0).count() <= 1,
            "keyboard and value-change events reached more than one worker: {:?}",
            counts
        );
    }
}

/// Regression: typing into a password field that reports no value change was
/// recorded as `key` actions; it is the field's one masked `type`.
#[test]
fn regression_noissue_typing_in_a_password_field_that_reports_no_value_change_is_one_masked_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let harness = WorkerTestHarness::new(TypingBackend::password(&gate));

    let t = now_ms();
    // 0x50 = P, 0x57 = W.
    harness.send_event(layout_key(1, t, 0x50));
    harness.send_event(layout_key(2, t + 1, 0x57));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "typing in a password field is its masked type, got {events:?}"
    );
    assert_eq!(type_values_of(&events), vec!["••••••••"]);
}

/// Regression: a control key processed before the password field's value
/// change put `key` actions for the typing ahead of the masked `type`, and a
/// second `type` behind the control key; it is one masked `type`, then the
/// control key.
#[test]
fn regression_noissue_enter_right_behind_typing_in_a_password_field_writes_no_character_key() {
    let gate = closed_gate();
    open_gate(&gate);
    let harness = WorkerTestHarness::new(TypingBackend::password(&gate));

    let t = now_ms();
    harness.send_event(packet_key(1, t, u16::from(b'p')));
    harness.send_event(packet_key(2, t + 1, u16::from(b'w')));
    harness.send_event(layout_key(3, t + 2, 0x0D)); // Enter
    harness.send_event(value_change(4, t + 6, 1234));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    // The typing, then the control key, and nothing after it: the value change
    // finds the masked type already recorded for the field.
    let kinds: Vec<String> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Type { value, .. } => Some(format!("type {value}")),
            ActionPayload::Key { key, .. } => Some(format!("key {key}")),
            _ => None,
        })
        .collect();
    assert_eq!(
        kinds,
        vec!["type ••••••••", "key Enter"],
        "the typing is one masked type ahead of the control key, got {events:?}"
    );
}

/// In a password field the space bar, the numeric keypad, a key the name
/// table does not know and an AltGr combination enter characters too; each
/// belongs to the masked type. A shortcut (Ctrl+V) stays a key.
#[test]
fn regression_noissue_every_text_entering_key_in_a_password_field_joins_the_masked_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let harness = WorkerTestHarness::new(TypingBackend::password(&gate));

    let t = now_ms();
    harness.send_event(layout_key(1, t, 0x20)); // space bar
    harness.send_event(layout_key(2, t + 1, 0x65)); // numeric keypad 5
    harness.send_event(layout_key(3, t + 2, 0x6B)); // numeric keypad +
    harness.send_event(layout_key(6, t + 3, 0x6C)); // numeric keypad separator
    harness.send_event(layout_key(7, t + 3, 0xE2)); // a layout's extra key
    let mut alt_gr = layout_key(4, t + 3, 0x32); // AltGr+2
    alt_gr.modifiers = (true, false, true, false);
    harness.send_event(alt_gr);
    let mut paste = layout_key(5, t + 4, 0x56); // Ctrl+V
    paste.modifiers = (true, false, false, false);
    harness.send_event(paste);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(key_names_of(&events), vec!["V"], "got {events:?}");
    assert_eq!(type_values_of(&events), vec!["••••••••"], "got {events:?}");
}

/// Keys buffered for a control that reports no value change are written as
/// keys when typing starts in a password field; the masked type does not
/// supersede them.
#[test]
fn keys_typed_before_a_password_field_survive_its_masked_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let harness = WorkerTestHarness::new(TypingBackend::password(&gate));

    let t = now_ms();
    harness.seed_pending_keys(vec![held_key("1"), held_key("2")]);
    harness.send_event(layout_key(1, t, 0x50));
    thread::sleep(Duration::from_millis(100));
    harness.flush();
    let events = harness.shutdown();

    assert_eq!(held_key_names(&events), vec!["1", "2"], "got {events:?}");
    assert_eq!(type_values_of(&events), vec!["••••••••"], "got {events:?}");
}

// Repeated keystrokes: every press is recorded, however many and however fast.
// Nothing in the pipeline collapses equal neighbours; these pin that for a
// short run ("keep") and a long one, in a control that reports no value change
// (each press is its own `key`, in typing order) and in an edit field (the one
// `type` carries the field's text).

fn burst_through_busy_pool(text: &str, value_changes: usize) -> Vec<ActionEvent> {
    let gate = closed_gate();
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let worker_gate = Arc::clone(&gate);
    let field_text = text.to_string();
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = TypingBackend::edit(&worker_gate, &field_text);
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );

    let t = now_ms();
    let mut seq = 0;
    for c in text.chars() {
        seq += 1;
        // Layout keys: the virtual-key code of a letter is its upper-case ASCII.
        pool.dispatch(layout_key(seq, t, c.to_ascii_uppercase() as u32));
    }
    for _ in 0..value_changes {
        seq += 1;
        pool.dispatch(value_change(seq, t + 5, 5678));
    }
    open_gate(&gate);

    thread::sleep(Duration::from_millis(900));
    pool.shutdown();
    action_rx.try_iter().collect()
}

fn upper_letters(text: &str) -> Vec<String> {
    text.chars()
        .map(|c| c.to_ascii_uppercase().to_string())
        .collect()
}

#[test]
fn repeated_keystrokes_with_no_value_change_are_each_recorded_in_order() {
    let long_run = format!("k{}p", "e".repeat(24));
    for text in ["keep", long_run.as_str()] {
        let events = burst_through_busy_pool(text, 0);
        assert_eq!(
            key_names_of(&events),
            upper_letters(text),
            "every press of {text:?} is its own key, in typing order"
        );
        assert_eq!(type_values_of(&events), Vec::<String>::new());
    }
}

#[test]
fn repeated_keystrokes_in_an_edit_field_are_the_one_type_with_every_character() {
    let long_run = format!("k{}p", "e".repeat(24));
    for text in ["keep", long_run.as_str()] {
        let events = burst_through_busy_pool(text, 3);
        assert_eq!(
            key_names_of(&events),
            Vec::<String>::new(),
            "got {events:?}"
        );
        assert_eq!(type_values_of(&events), vec![text.to_string()]);
    }
}

/// Regression: the last recorded value was kept per selector alone, so a value
/// typed in one window hid the same value arriving in another window whose
/// element has an equal selector (two documents of one application).
#[test]
fn regression_noissue_the_same_value_in_a_second_window_is_its_own_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let harness = WorkerTestHarness::new(TypingBackend::edit(&gate, "keep"));

    let t = now_ms();
    harness.send_event(value_change(1, t, 100));
    harness.send_event(value_change(2, t + 1, 200));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        type_values_of(&events),
        vec!["keep", "keep"],
        "got {events:?}"
    );
    let contexts: Vec<Option<i64>> = events.iter().map(|e| e.context_id).collect();
    assert_eq!(contexts, vec![Some(100), Some(200)]);
}

// ---------------------------------------------------------------------------
// A key or value change described late names its own element, or none
// ---------------------------------------------------------------------------
//
// A worker describes a keystroke or a value change by asking for the focused
// element when it gets to the event. By then focus may have moved: the window
// closed, the person went to another window or another control. These tests
// move the focus between the event and its description.

/// What the screen looks like at the moment a worker asks.
#[derive(Clone)]
struct FocusScene {
    epoch: u64,
    foreground: i64,
    element: ElementDescription,
}

fn scene_element(tag: &str, selector: &str, text: Option<&str>) -> ElementDescription {
    ElementDescription {
        tag: tag.to_string(),
        id: Some(selector.to_string()),
        name: Some(selector.to_string()),
        text: text.map(str::to_string),
        selector: selector.to_string(),
        ..Default::default()
    }
}

/// A backend whose focus the test moves; it counts focused-element queries.
/// An element's identity is its `id`: two descriptions with one `id` are the
/// same element, whatever their selectors say.
struct MovingFocusBackend {
    scene: Arc<Mutex<FocusScene>>,
    queries: Arc<AtomicU64>,
    marked: Mutex<Option<String>>,
    /// The focused-element query fails.
    fails: bool,
    controls: Arc<Mutex<Controls>>,
}

/// The controls (window handles that take the keyboard focus) of the dialog,
/// as the test arranges them, and how often the backend was asked about them.
#[derive(Default)]
struct Controls {
    /// The control that holds the keyboard focus right now.
    focused: i64,
    /// Live controls that can hold the focus only themselves.
    own: HashMap<i64, ElementDescription>,
    /// Live windows that hold other focusable elements.
    shared: Vec<i64>,
    /// The title of the dialog.
    title: String,
    descriptions: u64,
    value_reads: u64,
    nature_looks: u64,
}

impl Controls {
    fn nature(&self, control: i64) -> ControlNature {
        if let Some(element) = self.own.get(&control) {
            ControlNature::Own {
                password: element.element_type.as_deref() == Some("password"),
            }
        } else if self.shared.contains(&control) {
            ControlNature::Shared
        } else {
            ControlNature::Gone
        }
    }
}

/// A backend with the handles a test moves its focus and its controls by.
type WithControls = (
    MovingFocusBackend,
    Arc<Mutex<FocusScene>>,
    Arc<AtomicU64>,
    Arc<Mutex<Controls>>,
);

impl MovingFocusBackend {
    fn new(scene: FocusScene) -> (Self, Arc<Mutex<FocusScene>>, Arc<AtomicU64>) {
        let scene = Arc::new(Mutex::new(scene));
        let queries = Arc::new(AtomicU64::new(0));
        (
            Self {
                scene: Arc::clone(&scene),
                queries: Arc::clone(&queries),
                marked: Mutex::new(None),
                fails: false,
                controls: Arc::default(),
            },
            scene,
            queries,
        )
    }

    /// A backend that also knows the dialog's controls.
    fn with_controls(scene: FocusScene, controls: Controls) -> WithControls {
        let (mut backend, scene, queries) = Self::new(scene);
        backend.controls = Arc::new(Mutex::new(controls));
        let controls = Arc::clone(&backend.controls);
        (backend, scene, queries, controls)
    }
}

impl AccessibilityBackend for MovingFocusBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }

    fn cleanup(&mut self) {}

    fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
        None
    }

    fn focused_element(&self) -> Option<ElementDescription> {
        self.queries.fetch_add(1, Ordering::SeqCst);
        if self.fails {
            return None;
        }
        Some(self.scene.lock().unwrap().element.clone())
    }

    fn focused_element_marked(&self) -> Option<ElementDescription> {
        let element = self.focused_element()?;
        *self.marked.lock().unwrap() = element.id.clone();
        Some(element)
    }

    /// The focused element is in the window in front.
    fn focused_element_in_window(&self) -> Option<(ElementDescription, i64)> {
        let element = self.focused_element()?;
        Some((element, self.scene.lock().unwrap().foreground))
    }

    fn focused_is_marked(&self) -> Option<bool> {
        let focused = self.scene.lock().unwrap().element.id.clone();
        Some(focused.is_some() && focused == *self.marked.lock().unwrap())
    }

    fn focus_epoch(&self) -> u64 {
        self.scene.lock().unwrap().epoch
    }

    fn is_foreground_window(&self, window_handle: i64) -> bool {
        self.scene.lock().unwrap().foreground == window_handle
    }

    fn focused_control(&self) -> i64 {
        self.controls.lock().unwrap().focused
    }

    fn control_nature(&self, control: i64) -> ControlNature {
        let mut controls = self.controls.lock().unwrap();
        controls.nature_looks += 1;
        controls.nature(control)
    }

    fn describe_control(&self, control: i64) -> ControlLook {
        let mut controls = self.controls.lock().unwrap();
        controls.descriptions += 1;
        if let Some(element) = controls.own.get(&control) {
            ControlLook::Own(Box::new(element.clone()))
        } else if controls.shared.contains(&control) {
            ControlLook::Shared
        } else {
            ControlLook::Gone
        }
    }

    fn control_value(&self, control: i64) -> Option<String> {
        let mut controls = self.controls.lock().unwrap();
        controls.value_reads += 1;
        controls.own.get(&control).and_then(|e| e.text.clone())
    }

    fn window_title(&self, _window_handle: i64) -> String {
        self.controls.lock().unwrap().title.clone()
    }

    fn process_name(&self, _window_handle: i64) -> String {
        "test.exe".to_string()
    }

    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
        None
    }

    fn root_window_handle(&self, window_handle: i64) -> i64 {
        // The dialog's fields are windows inside it, alive or gone.
        if window_handle == FIELD || window_handle == OTHER_FIELD {
            DIALOG
        } else {
            window_handle
        }
    }

    fn window_rect(&self, _window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        None
    }

    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

const DIALOG: i64 = 1234;
const OTHER_WINDOW: i64 = 999;

fn file_name_field(text: &str) -> FocusScene {
    FocusScene {
        epoch: 1,
        foreground: DIALOG,
        element: scene_element("Edit", "Dialog > Edit:File name", Some(text)),
    }
}

/// A key or value change of the dialog, dispatched while its field had focus.
fn in_dialog(mut raw: RawEvent) -> RawEvent {
    raw.window_handle = DIALOG;
    raw.focus_epoch = 1;
    raw
}

/// `key` and `type` actions as `"key <name> on <selector>"` and
/// `"type <value> on <selector>"`, in the order written.
fn typed_actions_of(events: &[ActionEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key { key, element, .. } => {
                Some(format!("key {key} on {}", element.selector))
            }
            ActionPayload::Type { value, element } => {
                Some(format!("type {value} on {}", element.selector))
            }
            _ => None,
        })
        .collect()
}

/// Regression for docent#688: Backspace pressed in a dialog's field was
/// described after the dialog had closed and named the document behind it.
/// With nothing known about the dialog's field, the key names no element.
#[test]
fn regression_688_a_key_described_after_its_window_closed_names_no_element() {
    let (backend, _scene, _) = MovingFocusBackend::new(FocusScene {
        epoch: 2,
        foreground: OTHER_WINDOW,
        element: scene_element("Edit", "Document > Edit:Text Editor", Some("text")),
    });
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x08))); // Backspace

    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();

    assert_eq!(typed_actions_of(&events), vec!["key Backspace on "]);
    let element = events
        .iter()
        .find_map(|e| match &e.payload {
            ActionPayload::Key { element, .. } => Some(element),
            _ => None,
        })
        .unwrap();
    assert_eq!(element.tag, "Unknown", "got {element:?}");
}

/// Regression for docent#688 and docent#689: Enter pressed in a field was
/// described after focus had gone to another window (the recorder's own, in
/// the report). The field was described for the keys before it, under the same
/// focus, so Enter is recorded on the field.
#[test]
fn regression_688_a_late_key_is_recorded_on_the_element_its_focus_was_described_as() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field("a"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'a'))));
    thread::sleep(Duration::from_millis(150));
    *scene.lock().unwrap() = FocusScene {
        epoch: 2,
        foreground: OTHER_WINDOW,
        element: scene_element("Edit", "Recorder > Edit:narration-input", Some("")),
    };
    harness.send_event(in_dialog(layout_key(2, t + 1, 0x0D))); // Enter

    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "key Enter on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// Regression for docent#690: a value change described after focus had gone to
/// another window was recorded as a `type` on the newly focused element, with
/// that element's name as the value. It is no `type`; the keys it would have
/// superseded are kept, on their own field.
#[test]
fn regression_690_a_value_change_described_after_focus_left_its_window_is_no_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field("hi"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'h'))));
    harness.send_event(in_dialog(packet_key(2, t + 1, u16::from(b'i'))));
    thread::sleep(Duration::from_millis(150));
    *scene.lock().unwrap() = FocusScene {
        epoch: 2,
        foreground: OTHER_WINDOW,
        element: scene_element("Window", "Window:Calculator", Some("Calculator")),
    };
    harness.send_event(in_dialog(value_change(3, t + 2, DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key h on Dialog > Edit:File name",
            "key i on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// Regression for docent#690: the same inside one window. Focus went from the
/// field to a button of the same dialog before the value change was described;
/// the button is not the element the value change belongs to.
#[test]
fn regression_690_a_value_change_described_after_focus_moved_within_its_window_is_no_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field("hi"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'h'))));
    harness.send_event(in_dialog(packet_key(2, t + 1, u16::from(b'i'))));
    thread::sleep(Duration::from_millis(150));
    *scene.lock().unwrap() = FocusScene {
        epoch: 2,
        foreground: DIALOG,
        element: scene_element("Button", "Dialog > Button:Save", Some("Save")),
    };
    harness.send_event(in_dialog(value_change(3, t + 2, DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key h on Dialog > Edit:File name",
            "key i on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// A focus change was counted, but the same element of the same window is
/// still focused (a program that reports focus again while one types): the
/// value change is the field's `type` as before.
#[test]
fn a_value_change_after_a_counted_focus_change_back_on_the_same_element_is_its_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field("hi"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'h'))));
    harness.send_event(in_dialog(packet_key(2, t + 1, u16::from(b'i'))));
    thread::sleep(Duration::from_millis(150));
    scene.lock().unwrap().epoch = 2;
    harness.send_event(in_dialog(value_change(3, t + 2, DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type hi on Dialog > Edit:File name"],
        "got {events:?}"
    );
}

/// Keys typed into a password field and described after focus left it stay
/// part of the field's masked `type`: the field was described as a password
/// field under the same focus.
#[test]
fn late_keys_of_a_password_field_stay_in_its_masked_type() {
    let mut field = file_name_field("");
    field.element.element_type = Some("password".to_string());
    field.element.text = None;
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'p'))));
    thread::sleep(Duration::from_millis(150));
    *scene.lock().unwrap() = FocusScene {
        epoch: 2,
        foreground: OTHER_WINDOW,
        element: scene_element("Edit", "Document > Edit:Text Editor", Some("text")),
    };
    harness.send_event(in_dialog(packet_key(2, t + 1, u16::from(b'w'))));
    harness.send_event(in_dialog(layout_key(3, t + 2, 0x0D))); // Enter

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "type •••••••• on Dialog > Edit:File name",
            "key Enter on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// Text keys whose window was gone before the first of them could be
/// described: nothing shows the field was not a password field, so no
/// character is written. They are one masked `type` on no element; the
/// control key behind them is a key on no element.
#[test]
fn text_keys_described_after_their_window_closed_are_one_masked_type() {
    let (backend, _scene, _) = MovingFocusBackend::new(FocusScene {
        epoch: 2,
        foreground: OTHER_WINDOW,
        element: scene_element("Edit", "Document > Edit:Text Editor", Some("text")),
    });
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'p'))));
    harness.send_event(in_dialog(value_change(2, t + 1, DIALOG)));
    harness.send_event(in_dialog(packet_key(3, t + 2, u16::from(b'w'))));
    harness.send_event(in_dialog(value_change(4, t + 3, DIALOG)));
    harness.send_event(in_dialog(layout_key(5, t + 4, 0x0D))); // Enter

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type •••••••• on ", "key Enter on "],
        "got {events:?}"
    );
}

/// A `type` is pending for the first character when the window closes; the
/// value changes of the later characters are dropped. The pending `type` must
/// not discard their keys when it is written: the recording holds the `type`
/// and then every later key.
#[test]
fn keys_kept_after_a_dropped_value_change_survive_the_pending_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field("r"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'r'))));
    harness.send_event(in_dialog(value_change(2, t + 1, DIALOG)));
    thread::sleep(Duration::from_millis(100));
    *scene.lock().unwrap() = FocusScene {
        epoch: 2,
        foreground: OTHER_WINDOW,
        element: scene_element("Edit", "Document > Edit:Text Editor", Some("text")),
    };
    harness.send_event(in_dialog(packet_key(3, t + 2, u16::from(b'e'))));
    harness.send_event(in_dialog(value_change(4, t + 3, DIALOG)));
    harness.send_event(in_dialog(packet_key(5, t + 4, u16::from(b'p'))));
    harness.send_event(in_dialog(value_change(6, t + 5, DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "type r on Dialog > Edit:File name",
            "key e on Dialog > Edit:File name",
            "key p on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// Backspace starts a new focus count behind itself, so the value change it
/// causes carries a count no key was described under. Described after focus
/// moved to a button of the same window, it is still no `type` on the button:
/// the button is not the element the last key was recorded on.
#[test]
fn regression_690_a_value_change_under_a_count_of_its_own_is_checked_against_the_last_key() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field("ab"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'a'))));
    harness.send_event(in_dialog(layout_key(2, t + 1, 0x08))); // Backspace
    thread::sleep(Duration::from_millis(150));
    *scene.lock().unwrap() = FocusScene {
        epoch: 3,
        foreground: DIALOG,
        element: scene_element("Button", "Dialog > Button:Save", Some("Save")),
    };
    let mut late = value_change(3, t + 2, DIALOG);
    late.focus_epoch = 2;
    harness.send_event(late);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "key Backspace on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// A program moves the focus to its next field without reporting it (no focus
/// change is counted). While the key's window is in front and the count
/// stands, the remembered element is confirmed against the focused one, so
/// the next key is described afresh, on the field it went to.
#[test]
fn a_focus_move_the_program_did_not_report_is_noticed_at_the_next_key() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(layout_key(1, t, 0x70))); // F1, on the first field
    thread::sleep(Duration::from_millis(150));
    scene.lock().unwrap().element = scene_element("Edit", "Dialog > Edit:Second", Some(""));
    harness.send_event(in_dialog(layout_key(2, t + 1, 0x71))); // F2

    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key F1 on Dialog > Edit:File name",
            "key F2 on Dialog > Edit:Second"
        ],
        "got {events:?}"
    );
}

/// The first character changes the window's title, and with it the selector
/// of the field (an editor whose title gains a "modified" mark). The value
/// change is still the `type` of the element the key went to: it is the same
/// element, described differently.
#[test]
fn a_value_change_on_the_same_element_under_a_changed_selector_is_its_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(packet_key(1, t, u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.selector = "*Dialog > Edit:File name".to_string();
        scene.element.text = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, t + 1, DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type h on *Dialog > Edit:File name"],
        "got {events:?}"
    );
}

/// The person typed one character and clicked elsewhere in the same window
/// before the character could be described. The focused element is then not
/// the character's, and nothing shows what its field was: no element is
/// named and the character is not written.
#[test]
fn a_first_text_key_described_after_the_person_moved_focus_is_masked_on_no_element() {
    let (backend, _scene, _) = MovingFocusBackend::new(FocusScene {
        // One person-made focus move later than the key below.
        epoch: (1 << 32) | 1,
        foreground: DIALOG,
        element: scene_element("Edit", "Dialog > Edit:Other field", Some("")),
    });
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b's'))));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type •••••••• on "],
        "got {events:?}"
    );
}

/// A focus-moving key counts itself in the person's half right behind its own
/// dispatch. Described after that, as the first key under its count, it is
/// still its own: recorded on the focused element, not on none.
#[test]
fn a_focus_moving_key_is_not_made_unknowable_by_its_own_count() {
    let (backend, _scene, _) = MovingFocusBackend::new(FocusScene {
        // The Tab below, counted.
        epoch: (1 << 32) | 1,
        foreground: DIALOG,
        element: scene_element("Edit", "Dialog > Edit:File name", Some("")),
    });
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x09))); // Tab

    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["key Tab on Dialog > Edit:File name"],
        "got {events:?}"
    );
}

/// A program reported a focus change of its own after the key (the count's
/// low half moved, the person did nothing): the key is recorded on the
/// focused element of its window, with its character, as before.
#[test]
fn a_first_text_key_behind_a_program_reported_focus_change_keeps_its_character() {
    let (backend, _scene, _) = MovingFocusBackend::new(FocusScene {
        epoch: 5,
        foreground: DIALOG,
        element: scene_element("Edit", "Dialog > Edit:File name", Some("")),
    });
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b's'))));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["key s on Dialog > Edit:File name"],
        "got {events:?}"
    );
}

/// The key's window is in front but gives no focused element (the query
/// failed): nothing shows what the field was, so a text key is not written
/// with its character.
#[test]
fn a_text_key_whose_window_gives_no_focused_element_is_masked() {
    let (mut backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    backend.fails = true;
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b's'))));
    harness.send_event(in_dialog(layout_key(2, now_ms(), 0x0D))); // Enter

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type •••••••• on ", "key Enter on "],
        "got {events:?}"
    );
}

/// A run of one key repeated, pressed under one focus, is described once and
/// comes out as the one `type` with every character.
#[test]
fn repeated_keys_under_one_focus_are_described_once_and_typed_exactly() {
    let text = format!("k{}p", "e".repeat(24));
    let (backend, _scene, queries) = MovingFocusBackend::new(file_name_field(&text));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    for (i, unit) in text.encode_utf16().enumerate() {
        harness.send_event(in_dialog(packet_key(i as u64 + 1, t + i as u64, unit)));
    }
    harness.send_event(in_dialog(value_change(27, t + 30, DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![format!("type {text} on Dialog > Edit:File name")],
        "got {events:?}"
    );
    // One query for the 26 keys, one for the value change's value.
    assert_eq!(queries.load(Ordering::SeqCst), 2);
}

/// The keys after which the Input_Thread starts a new focus epoch: every key
/// that can move the focus, never a plain typing key.
#[test]
fn only_plain_typing_keys_keep_the_focus_epoch() {
    use docent_desktop_lib::capture::worker_pool::key_may_move_focus;
    let none = (false, false, false, false);
    let alt_gr = (true, false, true, false);
    let ctrl = (true, false, false, false);
    let shift = (false, true, false, false);

    // Letters, digits, space, keypad, punctuation, an injected character.
    for vk in [0x41, 0x5A, 0x30, 0x20, 0x65, 0xBB, 0xE2, VK_PACKET] {
        assert!(!key_may_move_focus(vk, none), "vk {vk:#x}");
        assert!(!key_may_move_focus(vk, shift), "vk {vk:#x} with Shift");
        assert!(!key_may_move_focus(vk, alt_gr), "vk {vk:#x} with AltGr");
        assert!(key_may_move_focus(vk, ctrl), "vk {vk:#x} with Ctrl");
    }
    // Shift, Control and lock keys alone.
    for vk in [0x10, 0x11, 0xA0, 0xA3, 0x14, 0x90] {
        assert!(!key_may_move_focus(vk, none), "vk {vk:#x}");
    }
    // Alt alone opens a menu; as the Alt of AltGr (Control is down) it does not.
    for vk in [0x12, 0xA4, 0xA5] {
        assert!(key_may_move_focus(vk, none), "vk {vk:#x}");
        assert!(!key_may_move_focus(vk, ctrl), "vk {vk:#x} with Ctrl");
    }
    // The extra punctuation keys of other layouts type characters.
    for vk in [0xC1, 0xC2, 0xE1, 0xE4, 0xE6] {
        assert!(!key_may_move_focus(vk, none), "vk {vk:#x}");
    }
    // Tab, Enter, Escape, an arrow, F6, the Windows key, an unknown key.
    for vk in [0x09, 0x0D, 0x1B, 0x25, 0x75, 0x5B, 0xFF] {
        assert!(key_may_move_focus(vk, none), "vk {vk:#x}");
    }
}

// ---------------------------------------------------------------------------
// A keystroke's control is settled when the key is pressed
// ---------------------------------------------------------------------------
//
// The Input_Thread reads which control holds the keyboard focus when a key is
// pressed and stamps the key with it. A control that can hold the focus only
// itself is described once; its later keys and its value changes need no
// focused-element query, so they are recorded on it however late a worker
// gets to them.

/// The dialog's file-name field as a control of its own.
const FIELD: i64 = 77;
/// Another field of the dialog.
const OTHER_FIELD: i64 = 88;

/// The dialog with its file-name field focused, holding `text`.
fn field_controls(text: &str) -> Controls {
    Controls {
        focused: FIELD,
        own: HashMap::from([(
            FIELD,
            scene_element("Edit", "Dialog > Edit:File name", Some(text)),
        )]),
        ..Default::default()
    }
}

/// What a focused-element query would answer: never the file-name field, so
/// a `type` or key on the field shows the query was not what named it.
fn save_button_focused() -> FocusScene {
    FocusScene {
        epoch: 1,
        foreground: DIALOG,
        element: scene_element("Button", "Dialog > Button:Save", None),
    }
}

/// A key of the dialog pressed while the file-name field held the focus.
fn in_field(raw: RawEvent) -> RawEvent {
    let mut raw = in_dialog(raw);
    raw.callback_params[1] = FIELD;
    raw
}

/// A value change a control reported about itself.
fn control_value_change(seq: u64, timestamp: u64, control: i64) -> RawEvent {
    let mut raw = value_change(seq, timestamp, control);
    raw.callback_params = [-4, 0, 0, 0]; // OBJID_CLIENT, CHILDID_SELF
    raw.focus_epoch = 1;
    raw
}

/// From the hands-on run of 2026-11-19: a file name typed into a Save As
/// dialog whose descriptions took a second each. The first key was described
/// in time; the keys behind it and Enter were reached after Enter had closed
/// the dialog, and were recorded on no element, the text masked. They carry
/// the field's handle, and the field was described for the first key.
#[test]
fn keys_reached_after_their_dialog_closed_are_recorded_on_the_control_they_were_pressed_in() {
    let (backend, scene, queries, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("c"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'c'))));
    thread::sleep(Duration::from_millis(150));
    // Enter was pressed and the dialog is gone.
    *scene.lock().unwrap() = FocusScene {
        epoch: 2 + FOCUS_EPOCH_PERSON_STEP,
        foreground: OTHER_WINDOW,
        element: scene_element("Edit", "Document > Edit:Text Editor", Some("text")),
    };
    {
        let mut controls = controls.lock().unwrap();
        controls.focused = 0;
        controls.own.clear();
    }
    harness.send_event(in_field(packet_key(2, t + 1, u16::from(b'o'))));
    harness.send_event(in_field(packet_key(3, t + 2, u16::from(b'p'))));
    harness.send_event(in_field(layout_key(4, t + 3, 0x0D))); // Enter

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key c on Dialog > Edit:File name",
            "key o on Dialog > Edit:File name",
            "key p on Dialog > Edit:File name",
            "key Enter on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
    assert_eq!(controls.lock().unwrap().descriptions, 1);
    assert_eq!(queries.load(Ordering::SeqCst), 0);
}

/// From the hands-on run of 2026-11-19: a program reported a focus change
/// while a file name was typed (the field's suggestion list), Enter closed
/// the dialog, and Enter was reached after that. Its control could not be
/// looked at again, and Enter was recorded on no element. Enter enters no
/// text, so what the control had become cannot put a character on record: it
/// stays on the control it was pressed in.
#[test]
fn a_key_that_enters_no_text_keeps_its_control_when_the_control_closed_before_the_second_look() {
    let (backend, scene, queries, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("c"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'c'))));
    thread::sleep(Duration::from_millis(150));
    close_the_dialog(&scene, &controls);
    let mut enter = in_field(layout_key(2, t + 1, 0x0D));
    enter.focus_epoch = 2;
    enter.callback_params[2] = 1;
    harness.send_event(enter);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key c on Dialog > Edit:File name",
            "key Enter on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
    assert_eq!(queries.load(Ordering::SeqCst), 0);
}

/// The same for a key that enters text: nothing shows the control had not
/// become a password field before it closed, so the key is held to the
/// password rule and names no element.
#[test]
fn a_text_key_whose_control_closed_before_the_second_look_is_masked_on_no_element() {
    let (backend, scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("c"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'c'))));
    thread::sleep(Duration::from_millis(150));
    close_the_dialog(&scene, &controls);
    let mut key = in_field(packet_key(2, t + 1, u16::from(b'o')));
    key.focus_epoch = 2;
    key.callback_params[2] = 1;
    harness.send_event(key);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["key c on Dialog > Edit:File name", "type •••••••• on "],
        "got {events:?}"
    );
}

/// From the hands-on run of 2026-11-19: the file-name field's suggestion list
/// reported a focus change while the name was typed at a person's speed. The
/// next character waited for a second look at the field, the dialog was busy,
/// Enter closed it, and the character was masked on no element. A focus
/// change that names no part of the control says nothing about the control:
/// it is not looked at again, and the key is the control's with no call.
#[test]
fn a_focus_change_that_names_no_part_of_the_control_asks_for_no_second_look() {
    let (backend, scene, queries, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("c"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'c'))));
    thread::sleep(Duration::from_millis(150));
    close_the_dialog(&scene, &controls);
    let mut key = in_field(packet_key(2, t + 1, u16::from(b'o')));
    key.focus_epoch = 2;
    harness.send_event(key);
    let mut enter = in_field(layout_key(3, t + 2, 0x0D));
    enter.focus_epoch = 2;
    harness.send_event(enter);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key c on Dialog > Edit:File name",
            "key o on Dialog > Edit:File name",
            "key Enter on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
    assert_eq!(controls.lock().unwrap().nature_looks, 0);
    assert_eq!(queries.load(Ordering::SeqCst), 0);
}

/// The Input_Thread's note of the focus changes that named a part of a
/// window: each has a number of its own, and a window that never had one
/// answers 0. A window pushed out of the note must not answer what a worker
/// may have kept from before its latest change (0 from a first look before
/// any change, or an older number): it answers the number of the latest
/// change pushed out, which is its own latest or a later one.
#[test]
fn the_part_focus_note_never_answers_a_number_from_before_a_windows_latest_change() {
    let mut note = PartFocusNote::default();
    assert_eq!(note.of(77), 0);
    let before_any_change = note.of(77);

    note.add(77);
    let first = note.of(77);
    assert_ne!(first, 0);
    assert_eq!(note.of(88), 0);

    note.add(88);
    note.add(77);
    let latest = note.of(77);
    assert!(latest > note.of(88));
    assert!(note.of(88) > first);

    for window in 100..100 + PartFocusNote::WINDOWS as i64 {
        note.add(window);
    }
    // 77 and 88 are pushed out. Neither answers a number it had before its
    // latest change, and 77 does not answer the 0 of before any change.
    assert!(note.of(77) >= latest);
    assert_ne!(note.of(77), before_any_change);
    assert_ne!(note.of(77), first);
    assert_ne!(note.of(88), 0);
    // A window still in the note answers its own number.
    let last = 100 + PartFocusNote::WINDOWS as i64 - 1;
    assert!(note.of(last) > note.of(77));
}

/// A focus change names a window as a whole by the window's own object or
/// its client area with no child; anything else names a part of it.
#[test]
fn a_focus_change_names_a_part_unless_it_names_the_window_or_its_client_area() {
    assert!(!focus_names_a_part(0, 0)); // OBJID_WINDOW, CHILDID_SELF
    assert!(!focus_names_a_part(-4, 0)); // OBJID_CLIENT, CHILDID_SELF
    assert!(focus_names_a_part(-4, 3));
    assert!(focus_names_a_part(-4, -1207));
    assert!(focus_names_a_part(-25, 0));
    assert!(focus_names_a_part(12, 0));
}

/// Enter was pressed and the dialog is gone: another window is in front and
/// the dialog's controls no longer exist.
fn close_the_dialog(scene: &Arc<Mutex<FocusScene>>, controls: &Arc<Mutex<Controls>>) {
    *scene.lock().unwrap() = FocusScene {
        epoch: 2 + FOCUS_EPOCH_PERSON_STEP,
        foreground: OTHER_WINDOW,
        element: scene_element("Edit", "Document > Edit:Text Editor", Some("text")),
    };
    let mut controls = controls.lock().unwrap();
    controls.focused = 0;
    controls.own.clear();
}

/// A value change a control reports about itself is that control's `type`,
/// read from the control: no focused-element query, whatever has the focus by
/// then. Repeated keys are in the value exactly as typed.
#[test]
fn a_value_change_of_the_keys_control_is_its_type_whatever_has_focus_by_then() {
    let text = format!("k{}p", "e".repeat(24));
    let (backend, scene, queries, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls(&text));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    for (i, unit) in text.encode_utf16().enumerate() {
        harness.send_event(in_field(packet_key(i as u64 + 1, t + i as u64, unit)));
    }
    thread::sleep(Duration::from_millis(150));
    scene.lock().unwrap().epoch = 2;
    controls.lock().unwrap().focused = OTHER_FIELD;
    harness.send_event(control_value_change(27, t + 30, FIELD));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![format!("type {text} on Dialog > Edit:File name")],
        "got {events:?}"
    );
    assert_eq!(queries.load(Ordering::SeqCst), 0);
    let controls = controls.lock().unwrap();
    assert_eq!((controls.descriptions, controls.value_reads), (1, 1));
}

/// Only the value change of the control the keys went to is their `type`. One
/// from another control of the window, or from a part of the control that is
/// not the control itself (its scroll bar), says nothing about them: it is
/// passed over, and the keys wait for their own.
#[test]
fn a_value_change_from_elsewhere_in_the_window_is_passed_over() {
    let mut arranged = field_controls("hi");
    arranged.own.insert(
        OTHER_FIELD,
        scene_element("Edit", "Dialog > Edit:Other", Some("zz")),
    );
    let (backend, _scene, _, _) =
        MovingFocusBackend::with_controls(save_button_focused(), arranged);
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'h'))));
    harness.send_event(in_field(packet_key(2, t + 1, u16::from(b'i'))));
    harness.send_event(control_value_change(3, t + 2, OTHER_FIELD));
    let mut scroll_bar = control_value_change(4, t + 3, FIELD);
    scroll_bar.callback_params = [-5, 0, 0, 0]; // OBJID_VSCROLL
    harness.send_event(scroll_bar);
    harness.send_event(control_value_change(5, t + 4, FIELD));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type hi on Dialog > Edit:File name"],
        "got {events:?}"
    );
}

/// The handle is read on the hook, possibly before the program acted on what
/// the person did just before (Tab, then a character at once). So the first
/// key after the person did something that can move the focus is taken on its
/// handle only once the present confirms it. Reached after the person moved
/// the focus again, nothing confirms it: the key names no element, masked.
#[test]
fn a_first_key_after_a_focus_move_reached_too_late_is_not_taken_on_its_handle() {
    let (backend, scene, _, _) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("a"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
    thread::sleep(Duration::from_millis(150));
    scene.lock().unwrap().epoch = 1 + 2 * FOCUS_EPOCH_PERSON_STEP;
    let mut late = in_field(packet_key(2, t + 1, u16::from(b'x')));
    late.focus_epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
    harness.send_event(late);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["key a on Dialog > Edit:File name", "type •••••••• on "],
        "got {events:?}"
    );
}

/// The same first key reached in time, with the focus in another control by
/// then (the program had acted on the Tab after the hook read the handle): it
/// is described from the focused element, as a key without a handle is.
#[test]
fn a_first_key_after_a_focus_move_whose_handle_the_present_contradicts_is_described_by_focus() {
    let (backend, scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("a"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
    thread::sleep(Duration::from_millis(150));
    *scene.lock().unwrap() = FocusScene {
        epoch: 1 + FOCUS_EPOCH_PERSON_STEP,
        foreground: DIALOG,
        element: scene_element("Edit", "Dialog > Edit:Other", Some("")),
    };
    controls.lock().unwrap().focused = OTHER_FIELD;
    let mut key = in_field(packet_key(2, t + 1, u16::from(b'x')));
    key.focus_epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
    harness.send_event(key);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "key x on Dialog > Edit:Other"
        ],
        "got {events:?}"
    );
}

/// A program moved the focus without the person doing anything (a field that
/// advances by itself) after the hook read the handle. Reached while nothing
/// was counted since the key, the present contradicts the handle and the key
/// is described from the focused element.
#[test]
fn a_later_key_whose_handle_the_present_contradicts_is_described_by_focus() {
    let (backend, scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("a"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
    thread::sleep(Duration::from_millis(150));
    scene.lock().unwrap().element = scene_element("Edit", "Dialog > Edit:Other", Some(""));
    controls.lock().unwrap().focused = OTHER_FIELD;
    harness.send_event(in_field(packet_key(2, t + 1, u16::from(b'b'))));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "key b on Dialog > Edit:Other"
        ],
        "got {events:?}"
    );
}

/// A window that holds other focusable elements (a browser's page, a canvas
/// of controls) does not say which of them a key went to: its keys are
/// described from the focused element, and the window is looked at once.
#[test]
fn a_window_that_holds_other_focusable_elements_is_described_by_focus() {
    let (backend, _scene, queries, controls) = MovingFocusBackend::with_controls(
        file_name_field("ab"),
        Controls {
            focused: FIELD,
            shared: vec![FIELD],
            ..Default::default()
        },
    );
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
    harness.send_event(in_field(packet_key(2, t + 1, u16::from(b'b'))));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "key b on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
    assert_eq!(controls.lock().unwrap().descriptions, 1);
    assert!(queries.load(Ordering::SeqCst) >= 1);
}

/// A password control: its keys are the masked `type`, and its value is never
/// read.
#[test]
fn keys_of_a_password_control_are_its_masked_type_and_its_value_is_not_read() {
    let mut arranged = field_controls("");
    let field = arranged.own.get_mut(&FIELD).unwrap();
    field.element_type = Some("password".to_string());
    field.text = None;
    let (backend, _scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), arranged);
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'p'))));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    harness.send_event(in_field(packet_key(3, t + 2, u16::from(b'w'))));
    harness.send_event(control_value_change(4, t + 3, FIELD));
    harness.send_event(in_field(layout_key(5, t + 4, 0x0D))); // Enter

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "type •••••••• on Dialog > Edit:File name",
            "key Enter on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
    assert_eq!(controls.lock().unwrap().value_reads, 0);
}

/// A control's description names its window (the title is in the selector).
/// Under the same title the description is kept across what the person does;
/// once the title has changed, the control is described again.
#[test]
fn a_control_is_described_again_only_when_its_windows_title_changed() {
    for (retitled, expected_second, expected_descriptions) in [
        (false, "key b on Dialog > Edit:File name", 1),
        (true, "key b on Saved > Edit:File name", 2),
    ] {
        let (backend, scene, _, controls) =
            MovingFocusBackend::with_controls(save_button_focused(), field_controls("a"));
        let harness = WorkerTestHarness::new(backend);

        let t = now_ms();
        harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
        thread::sleep(Duration::from_millis(150));
        scene.lock().unwrap().epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
        if retitled {
            let mut controls = controls.lock().unwrap();
            controls.title = "Saved".to_string();
            controls.own.get_mut(&FIELD).unwrap().selector = "Saved > Edit:File name".to_string();
        }
        let mut key = in_field(packet_key(2, t + 1, u16::from(b'b')));
        key.focus_epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
        harness.send_event(key);

        thread::sleep(Duration::from_millis(900));
        let events = harness.shutdown();

        assert_eq!(
            typed_actions_of(&events),
            vec!["key a on Dialog > Edit:File name", expected_second],
            "retitled {retitled}: got {events:?}"
        );
        assert_eq!(
            controls.lock().unwrap().descriptions,
            expected_descriptions,
            "retitled {retitled}"
        );
    }
}

/// The control is gone when its value change is reached: there is no value to
/// read, so there is no `type`, and the keys stay keys on their control.
#[test]
fn a_value_change_of_a_control_that_is_gone_keeps_its_keys() {
    let (backend, _scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("hi"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'h'))));
    harness.send_event(in_field(packet_key(2, t + 1, u16::from(b'i'))));
    thread::sleep(Duration::from_millis(150));
    controls.lock().unwrap().own.clear();
    harness.send_event(control_value_change(3, t + 2, FIELD));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key h on Dialog > Edit:File name",
            "key i on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// A field that shows its text until the person unticks "show password": the
/// same control, the same window title, now a password field. What a control
/// is gets looked at again at the first key after anything the person did, so
/// the keys typed after the click are the masked `type`.
#[test]
fn a_control_that_became_a_password_field_is_masked_from_the_next_key_on() {
    let (backend, scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("a"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
    thread::sleep(Duration::from_millis(150));
    scene.lock().unwrap().epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
    {
        let mut controls = controls.lock().unwrap();
        let field = controls.own.get_mut(&FIELD).unwrap();
        field.element_type = Some("password".to_string());
        field.text = None;
    }
    for (i, unit) in b"se".iter().copied().enumerate() {
        let mut key = in_field(packet_key(2 + i as u64, t + 1 + i as u64, u16::from(unit)));
        key.focus_epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
        harness.send_event(key);
    }
    let mut change = control_value_change(4, t + 3, FIELD);
    change.focus_epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
    harness.send_event(change);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "type •••••••• on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
    assert_eq!(controls.lock().unwrap().value_reads, 0);
}

/// A window that held nothing focusable when it was first looked at (a page
/// not loaded yet) and holds focusable elements now: its keys are described
/// from the focused element from the next key after anything the person did.
#[test]
fn a_control_that_came_to_hold_focusable_elements_is_described_by_focus() {
    let (backend, scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("a"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
    thread::sleep(Duration::from_millis(150));
    *scene.lock().unwrap() = FocusScene {
        epoch: 1 + FOCUS_EPOCH_PERSON_STEP,
        foreground: DIALOG,
        element: scene_element("Edit", "Dialog > Page > Edit:Search", Some("")),
    };
    {
        let mut controls = controls.lock().unwrap();
        controls.own.clear();
        controls.shared.push(FIELD);
    }
    let mut key = in_field(packet_key(2, t + 1, u16::from(b'b')));
    key.focus_epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
    harness.send_event(key);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "key b on Dialog > Page > Edit:Search"
        ],
        "got {events:?}"
    );
}

/// A `type` is pending for one field when the person types into another
/// whose value change is not the control's own (and so is passed over). The
/// pending `type` is the first field's: it is written when the key for the
/// other field arrives, and does not take that key with it later.
#[test]
fn a_key_on_another_element_is_not_superseded_by_the_pending_type() {
    let mut arranged = field_controls("hi");
    arranged.own.insert(
        OTHER_FIELD,
        scene_element("Edit", "Dialog > Edit:Other", Some("z")),
    );
    let (backend, scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), arranged);
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'h'))));
    harness.send_event(in_field(packet_key(2, t + 1, u16::from(b'i'))));
    harness.send_event(control_value_change(3, t + 2, FIELD));
    thread::sleep(Duration::from_millis(150));
    scene.lock().unwrap().epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
    controls.lock().unwrap().focused = OTHER_FIELD;
    let mut key = in_dialog(packet_key(4, t + 3, u16::from(b'z')));
    key.callback_params[1] = OTHER_FIELD;
    key.focus_epoch = 1 + FOCUS_EPOCH_PERSON_STEP;
    harness.send_event(key);
    let mut part = control_value_change(5, t + 4, OTHER_FIELD);
    part.callback_params = [-25, 0, 0, 0]; // not the control's own object
    harness.send_event(part);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "type hi on Dialog > Edit:File name",
            "key z on Dialog > Edit:Other"
        ],
        "got {events:?}"
    );
}

/// A program can change what a control is with the person doing nothing: a
/// page finishes loading and puts the focus into its password input. That
/// focus change names a part of the control and the next key carries its
/// number, so the control is looked at again at that key, and a control that now holds a focused password field is
/// described from the focused element: its characters are the masked `type`.
#[test]
fn a_control_is_looked_at_again_after_a_focus_change_the_program_made() {
    let (backend, scene, _, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("a"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'a'))));
    thread::sleep(Duration::from_millis(150));
    let mut password = scene_element("Edit", "Dialog > Page > Edit:Password", None);
    password.element_type = Some("password".to_string());
    *scene.lock().unwrap() = FocusScene {
        epoch: 2,
        foreground: DIALOG,
        element: password,
    };
    {
        let mut controls = controls.lock().unwrap();
        controls.own.clear();
        controls.shared.push(FIELD);
    }
    let mut key = in_field(packet_key(2, t + 1, u16::from(b's')));
    key.focus_epoch = 2;
    key.callback_params[2] = 1; // a focus change named a part of the control
    harness.send_event(key);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key a on Dialog > Edit:File name",
            "type •••••••• on Dialog > Page > Edit:Password"
        ],
        "got {events:?}"
    );
}

// ---------------------------------------------------------------------------
// Context introduction and the context of a focus
// ---------------------------------------------------------------------------

const NOTEPAD: i64 = 4321;

/// A raw event of `event_type` in `window`, pressing `key_code` with
/// `modifiers` where it is a key.
fn event_in(
    event_type: RawEventType,
    window: i64,
    key_code: u32,
    modifiers: (bool, bool, bool, bool),
) -> RawEvent {
    let mut raw = make_raw_event(event_type, window);
    raw.key_code = key_code;
    raw.modifiers = modifiers;
    raw
}

fn key_in(window: i64, key_code: u32) -> RawEvent {
    event_in(
        RawEventType::Keyboard,
        window,
        key_code,
        (false, false, false, false),
    )
}

const NO_MODIFIERS: (bool, bool, bool, bool) = (false, false, false, false);
const VK_LCONTROL: u32 = 0xA2;
const VK_LSHIFT: u32 = 0xA0;

/// Regression for docent#708: Notepad's Save As dialog, opened with
/// Ctrl+Shift+S, came in front later than its activation correlates with the
/// keys, so no `context_switch` was written for it, and the dialog's first
/// `key` was its context's first action. A key in a window whose context the
/// session has not introduced has a `context_switch` into that window
/// dispatched before it; once introduced, the window takes no further one.
/// https://github.com/Arsarneq/docent/issues/708
#[test]
fn regression_708_a_key_in_a_dialog_whose_activation_was_not_recorded_is_introduced_by_a_switch() {
    let mut contexts = ContextIntroductions::default();
    // Typing in Notepad, the session's first context.
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x41), NOTEPAD, NOTEPAD));
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x42), NOTEPAD, NOTEPAD));
    // Ctrl+Shift+S in Notepad.
    assert!(!contexts.switch_before(&key_in(NOTEPAD, VK_LCONTROL), NOTEPAD, NOTEPAD));
    assert!(!contexts.switch_before(&key_in(NOTEPAD, VK_LSHIFT), NOTEPAD, NOTEPAD));
    let save_as = event_in(
        RawEventType::Keyboard,
        NOTEPAD,
        0x53,
        (true, true, false, false),
    );
    assert!(!contexts.switch_before(&save_as, NOTEPAD, NOTEPAD));
    // The dialog's activation correlated with nothing: no foreground event
    // was dispatched. Its first key is introduced by a switch.
    assert!(contexts.switch_before(&key_in(DIALOG, 0x46), DIALOG, DIALOG));
    // Its next keys, its value change and its Enter take none.
    assert!(!contexts.switch_before(&key_in(DIALOG, 0x47), DIALOG, DIALOG));
    let value_change = event_in(RawEventType::ValueChange, DIALOG, 0, NO_MODIFIERS);
    assert!(!contexts.switch_before(&value_change, DIALOG, DIALOG));
    assert!(!contexts.switch_before(&key_in(DIALOG, 0x0D), DIALOG, DIALOG));
    // Back in Notepad, introduced already: no switch.
    let focus = event_in(RawEventType::Focus, NOTEPAD, 0, NO_MODIFIERS);
    assert!(!contexts.switch_before(&focus, NOTEPAD, NOTEPAD));
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x43), NOTEPAD, NOTEPAD));
}

/// A window that the session introduced by a dispatched `context_switch` or
/// `context_open` takes no further switch before its actions; a click is an
/// action like a key.
#[test]
fn a_window_introduced_by_a_switch_or_an_open_takes_no_further_switch() {
    let mut contexts = ContextIntroductions::default();
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x41), NOTEPAD, NOTEPAD));
    let switch = event_in(RawEventType::Foreground, DIALOG, 0, NO_MODIFIERS);
    assert!(!contexts.switch_before(&switch, DIALOG, DIALOG));
    assert!(!contexts.switch_before(&key_in(DIALOG, 0x46), DIALOG, DIALOG));
    let open = event_in(RawEventType::WindowCreate, OTHER_WINDOW, 0, NO_MODIFIERS);
    assert!(!contexts.switch_before(&open, OTHER_WINDOW, OTHER_WINDOW));
    let click = event_in(RawEventType::Click, OTHER_WINDOW, 0, NO_MODIFIERS);
    assert!(!contexts.switch_before(&click, OTHER_WINDOW, OTHER_WINDOW));
    // A click is the first action of a window nothing introduced.
    let click = event_in(RawEventType::Click, 777, 0, NO_MODIFIERS);
    assert!(contexts.switch_before(&click, 777, 777));
    // A close introduces nothing and asks for no switch.
    let close = event_in(RawEventType::WindowDestroy, 778, 0, NO_MODIFIERS);
    assert!(!contexts.switch_before(&close, 778, 778));
    assert!(contexts.switch_before(&key_in(778, 0x41), 778, 778));
}

/// A lone Shift, Ctrl or Alt press is dropped by the worker (DCP-13), so it
/// neither introduces a window nor is the session's first context: the next
/// key is.
#[test]
fn a_lone_modifier_press_introduces_no_window() {
    let mut contexts = ContextIntroductions::default();
    assert!(!contexts.switch_before(&key_in(DIALOG, VK_LSHIFT), DIALOG, DIALOG));
    // Notepad's key is the session's first action.
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x41), NOTEPAD, NOTEPAD));
    assert!(!contexts.switch_before(&key_in(DIALOG, VK_LSHIFT), DIALOG, DIALOG));
    assert!(contexts.switch_before(&key_in(DIALOG, 0x46), DIALOG, DIALOG));
    // An event with no window takes none.
    assert!(!contexts.switch_before(&key_in(0, 0x46), 0, 0));
}

/// Regression for docent#709: when Notepad's Save As dialog closed on Enter,
/// the `focus` written for Notepad's text area carried the dialog's context:
/// the focus event named the dialog, and the element described was the one
/// focused by then, in Notepad. A focus is recorded under the context of the
/// window its element is in.
/// https://github.com/Arsarneq/docent/issues/709
#[test]
fn regression_709_a_focus_after_its_dialog_closed_carries_the_context_of_its_elements_window() {
    let (backend, _scene, _) = MovingFocusBackend::new(FocusScene {
        epoch: 2,
        foreground: NOTEPAD,
        element: scene_element("Document", "Notepad > Document:Text editor", None),
    });
    let harness = WorkerTestHarness::new(backend);
    let mut focus = make_raw_event(RawEventType::Focus, DIALOG);
    focus.sequence_id = 1;
    harness.send_event(focus);
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let focuses: Vec<(Option<i64>, String)> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Focus { element } => Some((e.context_id, element.selector.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        focuses,
        vec![(Some(NOTEPAD), "Notepad > Document:Text editor".to_string())],
        "got {events:?}"
    );
}

/// A window an action lands in without being in front (the window under a
/// wheel) is introduced, but its switch does not stand for the activation of
/// the window in front: a later click or correlated activation into that
/// window is still written.
#[test]
fn a_switch_into_an_inactive_window_does_not_swallow_its_later_activation() {
    const B: i64 = 555;
    let mut contexts = ContextIntroductions::default();
    // Notepad in front and introduced.
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x41), NOTEPAD, NOTEPAD));
    // A wheel over inactive B: B is introduced by a switch.
    let wheel = event_in(RawEventType::Scroll, B, 0, NO_MODIFIERS);
    assert!(contexts.switch_before(&wheel, B, NOTEPAD));
    // A key in Notepad, still in front: no switch.
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x42), NOTEPAD, NOTEPAD));
    // The person clicks into B (or B's activation correlates): written.
    assert!(contexts.activation_switches(B));
    // And not twice.
    assert!(!contexts.activation_switches(B));
}

/// A switch dispatched before an action in the window in front stands for
/// that window's activation: a late foreground change into it is not
/// written again.
#[test]
fn a_switch_into_the_window_in_front_stands_for_its_late_activation() {
    let mut contexts = ContextIntroductions::default();
    assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x41), NOTEPAD, NOTEPAD));
    assert!(contexts.switch_before(&key_in(DIALOG, 0x46), DIALOG, DIALOG));
    assert!(!contexts.activation_switches(DIALOG));
    // Back to Notepad by a correlated activation: written.
    assert!(contexts.activation_switches(NOTEPAD));
}

/// The session's first context counts only before every switch and open: an
/// action after a switch into one window, in another window, takes a switch.
#[test]
fn an_action_after_a_switch_is_not_the_sessions_first_context() {
    let mut contexts = ContextIntroductions::default();
    let switch = event_in(RawEventType::Foreground, NOTEPAD, 0, NO_MODIFIERS);
    assert!(!contexts.switch_before(&switch, NOTEPAD, NOTEPAD));
    assert!(contexts.switch_before(&key_in(DIALOG, 0x46), DIALOG, DIALOG));
}

/// A backend whose focused element is in `window` (0: the description
/// resolved none), with a rectangle of its own for every window handle.
struct FocusWindowBackend {
    window: i64,
}

fn rect_of(window_handle: i64) -> docent_desktop_lib::capture::WindowRect {
    docent_desktop_lib::capture::WindowRect {
        x: window_handle as i32,
        y: 7,
        width: 640,
        height: 480,
    }
}

impl AccessibilityBackend for FocusWindowBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }
    fn cleanup(&mut self) {}
    fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
        None
    }
    fn focused_element(&self) -> Option<ElementDescription> {
        Some(scene_element(
            "Document",
            "Notepad > Document:Text editor",
            None,
        ))
    }
    fn focused_element_in_window(&self) -> Option<(ElementDescription, i64)> {
        Some((self.focused_element()?, self.window))
    }
    fn window_title(&self, _window_handle: i64) -> String {
        String::new()
    }
    fn process_name(&self, _window_handle: i64) -> String {
        "test.exe".to_string()
    }
    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> {
        None
    }
    fn root_window_handle(&self, window_handle: i64) -> i64 {
        window_handle
    }
    fn window_rect(&self, window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        Some(rect_of(window_handle))
    }
    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

/// The context and rectangle of the focus written for one focus event named
/// `DIALOG`, with the focused element in `window`.
fn focus_written_with_element_in(
    window: i64,
) -> Vec<(Option<i64>, Option<docent_desktop_lib::capture::WindowRect>)> {
    let harness = WorkerTestHarness::new(FocusWindowBackend { window });
    let mut focus = make_raw_event(RawEventType::Focus, DIALOG);
    focus.sequence_id = 1;
    harness.send_event(focus);
    thread::sleep(Duration::from_millis(100));
    harness
        .shutdown()
        .into_iter()
        .filter(|e| matches!(e.payload, ActionPayload::Focus { .. }))
        .map(|e| (e.context_id, e.window_rect))
        .collect()
}

/// A focus takes the rectangle of the window its element is in, with its
/// context.
#[test]
fn a_focus_takes_the_rectangle_of_its_elements_window() {
    assert_eq!(
        focus_written_with_element_in(NOTEPAD),
        vec![(Some(NOTEPAD), Some(rect_of(NOTEPAD)))]
    );
}

/// Where the element's description resolved no window, the focus keeps the
/// context and rectangle of the window the event named.
#[test]
fn a_focus_whose_element_resolved_no_window_keeps_the_events_window() {
    assert_eq!(
        focus_written_with_element_in(0),
        vec![(Some(DIALOG), Some(rect_of(DIALOG)))]
    );
}

/// A right or middle press into an inactive window not introduced yet writes
/// one switch into it: the switch dispatched at the press, before the press,
/// and neither the press nor the activation it causes adds another.
#[test]
fn a_right_press_into_an_inactive_window_writes_one_switch() {
    const B: i64 = 556;
    for event_type in [RawEventType::RightClick, RawEventType::Click] {
        let mut contexts = ContextIntroductions::default();
        assert!(!contexts.switch_before(&key_in(NOTEPAD, 0x41), NOTEPAD, NOTEPAD));
        let mut switches = 0;
        if contexts.press_switches(B, NOTEPAD) {
            switches += 1;
            let switch = event_in(RawEventType::Foreground, B, 0, NO_MODIFIERS);
            assert!(!contexts.switch_before(&switch, B, NOTEPAD));
        }
        let press = event_in(event_type, B, 0, NO_MODIFIERS);
        if contexts.switch_before(&press, B, NOTEPAD) {
            switches += 1;
        }
        // The press activates B; its foreground change correlates.
        if contexts.activation_switches(B) {
            switches += 1;
        }
        assert_eq!(switches, 1);
    }
}

/// A press in the window in front switches nothing.
#[test]
fn a_press_in_the_window_in_front_switches_nothing() {
    let mut contexts = ContextIntroductions::default();
    assert!(!contexts.press_switches(NOTEPAD, NOTEPAD));
}
