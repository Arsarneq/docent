// Property tests for the capture worker pool infrastructure.
//
// The principal subjects: sequence numbering, shortest-queue dispatch, typing,
// focus and sticky routing, drag-pair and double-click routing, and the
// dead-worker drain rescues (dispatch-time respawn and shutdown join) — the
// pipeline-level truth-lock — alongside end-to-end action truth-locks over the
// same pipeline (key, right-click, selection, scroll flush, locator pass-through,
// excluded-PID discard, the file-dialog proxy), and the double-click pairing
// the mouse hook keeps (DCP-10). The click-vs-drag threshold itself belongs to
// the Windows provider and is pinned beside it, in the `capture::windows`
// module's own unit tests.

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
        held: Vec::new(),
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
                        Ok(WorkerMessage::EndTyping) | Ok(WorkerMessage::MenuCommand)
                            | Ok(WorkerMessage::LookAtFocus) => {}
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
// Focus worker and sticky selection routing
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Focus and selection routing
    ///
    /// Every focus event reaches one worker, whatever window it names
    /// (docent#735), and every selection event in one window reaches one
    /// worker.
    #[test]
    fn focus_events_reach_one_worker_and_selections_route_sticky(
        window_handle in 1i64..10000,
        kinds in proptest::collection::vec(proptest::bool::ANY, 2..50),
    ) {
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        // Per worker: [focus events, selection events] received.
        let worker_counts: Vec<[Arc<AtomicU64>; 2]> = (0..3)
            .map(|_| [Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0))])
            .collect();
        let wc_clone = worker_counts.clone();

        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender, _pending| {
            let [focus, selection] = wc_clone[index].clone();
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(raw)) => match raw.event_type {
                            RawEventType::Focus => {
                                focus.fetch_add(1, Ordering::SeqCst);
                            }
                            RawEventType::Selection => {
                                selection.fetch_add(1, Ordering::SeqCst);
                            }
                            _ => {}
                        },
                        Ok(WorkerMessage::Flush(_)) => {}
                        Ok(WorkerMessage::EndTyping) | Ok(WorkerMessage::MenuCommand)
                            | Ok(WorkerMessage::LookAtFocus) => {}
                        Ok(WorkerMessage::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
        });

        // Focus events naming three different windows, selections in one
        // window, a click between them so the queue lengths keep moving.
        for (i, is_focus) in kinds.iter().enumerate() {
            if *is_focus {
                let window = window_handle + 10_000 * (i as i64 % 3);
                pool.dispatch(make_raw_event(RawEventType::Focus, window));
            } else {
                pool.dispatch(make_raw_event(RawEventType::Selection, window_handle));
            }
            pool.dispatch(make_raw_event(RawEventType::Click, window_handle + 1));
        }

        // Give workers time to receive.
        std::thread::sleep(std::time::Duration::from_millis(50));

        for (kind, name) in [(0usize, "focus"), (1usize, "selection")] {
            let expected = kinds.iter().filter(|f| **f == (kind == 0)).count() as u64;
            let counts: Vec<u64> = worker_counts
                .iter()
                .map(|c| c[kind].load(Ordering::SeqCst))
                .collect();
            let total: u64 = counts.iter().sum();
            prop_assert_eq!(total, expected, "every {} event should arrive", name);
            let receiving = counts.iter().filter(|c| **c > 0).count();
            prop_assert!(
                receiving <= 1,
                "expected one worker to receive every {} event, got {:?}",
                name,
                counts
            );
        }

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
                        Ok(WorkerMessage::EndTyping) | Ok(WorkerMessage::MenuCommand)
                            | Ok(WorkerMessage::LookAtFocus) => {}
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
            held: Vec::new(),
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
            held: Vec::new(),
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
    focus_names_a_part, key_number_param, worker_loop, AccessibilityBackend, ContextIntroductions,
    ControlLook, ControlNature, PartFocusNote, PendingBuffers, FOCUS_EPOCH_PERSON_STEP,
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
            text: Some(text.clone()),
            value: Some(text),
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
            held: Vec::new(),
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
    /// For any sequence of value-change events for the same element, the
    /// worker emits exactly one `type` ActionEvent with the final value,
    /// when the typing ends (here at the stop).
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

        // Send value-change events with the same timestamp base.
        let base_ts = 10000u64;
        for i in 0..keystroke_count {
            let raw = RawEvent {
                event_type: RawEventType::ValueChange,
                sequence_id: (i + 1) as u64,
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
            held: Vec::new(),
            };
            harness.send_event(raw);
        }

        // Longer than any pause rule: no pause writes the type.
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
// Pending type event is flushed before a context switch
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// Flush on context change
    ///
    /// When a worker has a pending type event and receives a foreground
    /// event, the type event is emitted before the context_switch event, and
    /// the type event's sequence_id is lower.
    #[test]
    fn pending_type_flushed_before_context_change(
        value_change_count in 1usize..5,
    ) {
        // Build values for the value-change sequence.
        let values: Vec<String> = (0..value_change_count)
            .map(|i| format!("val_{}", i + 1))
            .collect();
        let final_value = values.last().unwrap().clone();

        let backend = MockBackend::with_focused_values(values.clone());
        let harness = WorkerTestHarness::new(backend);

        let base_ts = 10000u64;
        let type_seq_start = 1u64;

        // Send the value-change events of one field's typing.
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
            held: Vec::new(),
            };
            harness.send_event(raw);
        }

        // Small delay to ensure value-change events are processed.
        thread::sleep(Duration::from_millis(100));

        // Now send the context-change event.
        let context_seq = type_seq_start + value_change_count as u64;
        let context_event = RawEvent {
            event_type: RawEventType::Foreground,
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
            held: Vec::new(),
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
                ActionPayload::ContextSwitch { .. }
            )
        });

        prop_assert!(
            type_idx.is_some(),
            "expected a Type event to be emitted (events: {:?})",
            events.iter().map(|e| format!("{:?}", e.payload)).collect::<Vec<_>>()
        );
        prop_assert!(
            context_idx.is_some(),
            "expected a ContextSwitch event to be emitted"
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
                        Ok(WorkerMessage::EndTyping)
                        | Ok(WorkerMessage::MenuCommand)
                        | Ok(WorkerMessage::LookAtFocus) => {}
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
                    Ok(WorkerMessage::EndTyping)
                    | Ok(WorkerMessage::MenuCommand)
                    | Ok(WorkerMessage::LookAtFocus) => {}
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

    // Send the value-change events of one field's typing.
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
            held: Vec::new(),
        };
        harness.send_event(raw);
    }

    // Small delay to ensure the events are processed.
    thread::sleep(Duration::from_millis(100));

    // The typing has not ended: the stop writes its type.
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

    // Hold a pending type: value changes of a typing that has not ended.
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
            held: Vec::new(),
        });
    }
    thread::sleep(Duration::from_millis(50)); // processed, the type held

    // The flush writes the held type, and the worker acknowledges.
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
        held: Vec::new(),
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
            held: Vec::new(),
        });
    }
    thread::sleep(Duration::from_millis(80)); // processed, the type held

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
            value: Some("hello".to_string()),
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
        held: Vec::new(),
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
        held: Vec::new(),
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
        held: Vec::new(),
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
        language: Some("da-DK".to_string()),
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
        value: None,
        place_in_window: None,
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
        held: Vec::new(),
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
        held: Vec::new(),
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

/// Every action states the user's language preference as the platform lists
/// it when the action is built, and states null when the platform could not
/// be read.
#[test]
fn an_action_carries_the_platforms_preferred_languages() {
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
        held: Vec::new(),
    });

    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let click = events
        .iter()
        .find(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .expect("expected a Click event");
    let expected = docent_desktop_lib::capture::language::preferred_languages();
    assert_eq!(click.preferred_languages, expected);
    let json = serde_json::to_value(click).unwrap();
    match expected {
        Some(languages) => assert_eq!(json["preferred_languages"], serde_json::json!(languages)),
        None => assert!(json["preferred_languages"].is_null()),
    }
    assert!(
        json.as_object()
            .unwrap()
            .contains_key("preferred_languages"),
        "the field is stated on every action, null included"
    );
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
        held: Vec::new(),
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
        assert_eq!(element.language, None);
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
        held: Vec::new(),
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
        held: Vec::new(),
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

    if let ActionPayload::Click {
        x, y, ref element, ..
    } = click.payload
    {
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
            held: Vec::new(),
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
            held: Vec::new(),
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
            held: Vec::new(),
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
            held: Vec::new(),
        };
        harness.send_event(raw);
    }

    // Longer than the wait of a key that took no text.
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
        held: Vec::new(),
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
        held: Vec::new(),
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
        held: Vec::new(),
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

/// A window that has closed by the time its foreground change is described:
/// asked by its handle it names no process ("pid:0", as the Windows backend
/// gives it), while the process the Input_Thread read at the event is still
/// named by its id.
struct ClosedWindowBackend(MockBackend);

impl AccessibilityBackend for ClosedWindowBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }
    fn cleanup(&mut self) {}
    fn element_at_point(&self, x: i32, y: i32) -> Option<ElementDescription> {
        self.0.element_at_point(x, y)
    }
    fn focused_element(&self) -> Option<ElementDescription> {
        self.0.focused_element()
    }
    fn window_title(&self, _window_handle: i64) -> String {
        String::new()
    }
    fn process_name(&self, _window_handle: i64) -> String {
        "pid:0".to_string()
    }
    fn process_name_of(&self, process_id: u32) -> Option<String> {
        (process_id == 4242).then(|| "notepad.exe".to_string())
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

// Regression: #761 — a context_switch into a window that closed before the
// worker described it named its source "pid:0"
// https://github.com/Arsarneq/docent/issues/761
#[test]
fn regression_761_context_switch_names_its_source_by_the_event_process() {
    let harness = WorkerTestHarness::new(ClosedWindowBackend(MockBackend::new()));
    let mut raw = make_raw_event(RawEventType::Foreground, 66168);
    raw.sequence_id = 1;
    raw.process_id = 4242;
    harness.send_event(raw);

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    let sources: Vec<&str> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::ContextSwitch { source, .. } => Some(source.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        sources,
        vec!["notepad.exe"],
        "the switch is named by the process read at the event, not by the closed window"
    );
}

/// A process the backend cannot name by its id leaves the switch named by
/// its window, as before.
#[test]
fn a_context_switch_whose_process_has_no_name_by_id_is_named_by_its_window() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let mut raw = make_raw_event(RawEventType::Foreground, 200);
    raw.sequence_id = 1;
    raw.process_id = 4242;
    harness.send_event(raw);

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    let sources: Vec<&str> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::ContextSwitch { source, .. } => Some(source.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(sources, vec!["test.exe"]);
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
        held: Vec::new(),
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
            held: Vec::new(),
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
            held: Vec::new(),
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
        held: Vec::new(),
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
            held: Vec::new(),
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
        held: Vec::new(),
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
        held: Vec::new(),
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

    // Past KEY_TEXT_WAIT_MS (500 ms): a key no value change took would be written by now.
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
            held: Default::default(),
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
    /// The field's text as it stands now, where a test types it in over time.
    live_text: Option<Arc<Mutex<String>>>,
    /// Whether the element has a value at all (a document that reports its
    /// text some other way has none).
    has_value: bool,
}

impl TypingBackend {
    fn edit(gate: &Gate, text: &str) -> Self {
        Self {
            gate: Arc::clone(gate),
            element_type: None,
            text: Some(text.to_string()),
            live_text: None,
            has_value: true,
        }
    }

    /// An edit field whose text is whatever `live_text` holds when it is read.
    fn edit_live(gate: &Gate, live_text: &Arc<Mutex<String>>) -> Self {
        Self {
            gate: Arc::clone(gate),
            element_type: None,
            text: None,
            live_text: Some(Arc::clone(live_text)),
            has_value: true,
        }
    }

    fn password(gate: &Gate) -> Self {
        Self {
            gate: Arc::clone(gate),
            element_type: Some("password".to_string()),
            text: None,
            live_text: None,
            has_value: true,
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
            // As the mapping gives them: the text is the value, or the name
            // where the value is empty; the value is the value.
            text: match &self.live_text {
                Some(live) => Some(live.lock().unwrap().clone())
                    .filter(|text| !text.is_empty())
                    .or(Some("Field".to_string())),
                None => self.text.clone(),
            },
            value: match &self.live_text {
                Some(live) if self.has_value => Some(live.lock().unwrap().clone()),
                Some(_) => None,
                None => self.text.clone(),
            },
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

/// The input-method fields of the one `key` action among `events`, as the
/// action is written for the panel: each field's JSON value, `None` where the
/// field is left out.
fn input_method_fields_of(
    events: &[ActionEvent],
) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
    let keys: Vec<&ActionEvent> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Key { .. }))
        .collect();
    assert_eq!(keys.len(), 1, "one key action, got {events:?}");
    let written = serde_json::to_value(keys[0]).unwrap();
    (
        written.get("input_method_open").cloned(),
        written.get("input_method_conversion_mode").cloned(),
    )
}

/// A key press states what the keyboard hook read of the input method at the
/// press: whether one was on, and its conversion mode as the system gave it.
#[test]
fn regression_237_a_key_states_the_input_method_read_at_its_press() {
    for (name, state, open, mode) in [
        (
            "on, native full-shape",
            InputMethodState {
                open: true,
                conversion_mode: Some(0x9),
            },
            true,
            9,
        ),
        (
            "off",
            InputMethodState {
                open: false,
                conversion_mode: Some(0),
            },
            false,
            0,
        ),
        (
            "off with a mode left set",
            InputMethodState {
                open: false,
                conversion_mode: Some(0x19),
            },
            false,
            0x19,
        ),
    ] {
        let harness = WorkerTestHarness::new(MockBackend::new());
        let mut enter = layout_key(1, now_ms(), 0x0D);
        enter.callback_params[0] |= input_method_param(Some(state));
        harness.send_event(enter);
        thread::sleep(Duration::from_millis(100));
        let events = harness.shutdown();

        assert_eq!(
            input_method_fields_of(&events),
            (Some(serde_json::json!(open)), Some(serde_json::json!(mode))),
            "{name}: got {events:?}"
        );
    }
}

/// A key press whose open status was read and whose conversion mode was not
/// states the open status alone.
#[test]
fn regression_237_a_key_states_the_open_status_alone_where_the_mode_was_not_read() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let mut enter = layout_key(1, now_ms(), 0x0D);
    enter.callback_params[0] |= input_method_param(Some(InputMethodState {
        open: true,
        conversion_mode: None,
    }));
    harness.send_event(enter);
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    assert_eq!(
        input_method_fields_of(&events),
        (Some(serde_json::json!(true)), None),
        "got {events:?}"
    );
}

/// A key press whose input method was not read (no input-method window, no
/// answer in time, a key attributed to no window) leaves both fields out.
#[test]
fn regression_237_a_key_whose_input_method_was_not_read_leaves_the_fields_out() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    harness.send_event(layout_key(1, now_ms(), 0x0D));
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    assert_eq!(
        input_method_fields_of(&events),
        (None, None),
        "got {events:?}"
    );
}

/// The input method read rides beside the layout character and the repeat
/// mark, and changes neither: a repeated punctuation key keeps its name and
/// its repeat.
#[test]
fn regression_237_the_input_method_read_leaves_the_key_name_and_the_repeat_mark() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let mut plus = layout_key(1, now_ms(), 0xBB);
    plus.modifiers = (true, false, false, false);
    plus.callback_params[3] = i64::from(u32::from('+')) | KEY_REPEAT_PARAM;
    plus.callback_params[0] |= input_method_param(Some(InputMethodState {
        open: true,
        conversion_mode: Some(0x07FF_FFFF),
    }));
    harness.send_event(plus);
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let named: Vec<(String, bool)> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key { key, repeat, .. } => Some((key.clone(), *repeat)),
            _ => None,
        })
        .collect();
    assert_eq!(named, vec![("+".to_string(), true)], "got {events:?}");
    assert_eq!(
        input_method_fields_of(&events),
        (
            Some(serde_json::json!(true)),
            Some(serde_json::json!(0x07FF_FFFF))
        ),
        "got {events:?}"
    );
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

/// Type one character into the live field: the text gains it, and its key and
/// the value change the key caused are handed to `send`, the next two
/// sequence ids taken from `seq`. Waits for the worker to have processed both.
fn type_character(
    live: &Arc<Mutex<String>>,
    character: char,
    seq: &mut u64,
    mut send: impl FnMut(RawEvent),
) {
    live.lock().unwrap().push(character);
    let t = now_ms();
    *seq += 1;
    send(layout_key(*seq, t, character.to_ascii_uppercase() as u32));
    *seq += 1;
    send(value_change(*seq, t + 5, 1234));
    thread::sleep(Duration::from_millis(100));
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

    // Past KEY_TEXT_WAIT_MS (500 ms): a key no value change took would be written by now.
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
                        Ok(WorkerMessage::EndTyping) | Ok(WorkerMessage::MenuCommand)
                            | Ok(WorkerMessage::LookAtFocus) => {}
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

fn focus_event(seq: u64, timestamp: u64, window_handle: i64) -> RawEvent {
    let mut raw = make_raw_event(RawEventType::Focus, window_handle);
    raw.sequence_id = seq;
    raw.timestamp = timestamp;
    raw
}

fn focus_selectors_of(events: &[ActionEvent]) -> Vec<String> {
    let mut focuses: Vec<(u64, String)> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Focus { element } => {
                Some((e.sequence_id.unwrap_or(0), element.selector.clone()))
            }
            _ => None,
        })
        .collect();
    focuses.sort();
    focuses.into_iter().map(|(_, selector)| selector).collect()
}

/// Regression (https://github.com/Arsarneq/docent/issues/735): one focus
/// change after a dialog closed was written as two identical focus actions.
/// The focus events named two windows (the dialog's File name box, the
/// owner's text area), so sticky routing gave them to two workers while the
/// first was still busy; both described the element focused when they got to
/// it, the owner's text area once the dialog had closed, and each compared it
/// with its own last focus only.
#[test]
fn regression_735_one_focus_change_named_by_two_windows_is_one_focus() {
    let dialog = 0x200;
    let owner = 0x100;
    let gate = closed_gate();
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let worker_gate = Arc::clone(&gate);
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            // Every description, however late, finds the same element
            // focused, in the owner's window. The events count no focus
            // epoch, so only the comparison with the last focus judges them.
            let backend = LateFocusBackend {
                gate: Arc::clone(&worker_gate),
                epoch: Arc::new(AtomicU64::new(0)),
                focus_events: Arc::new(AtomicU64::new(0)),
                window: owner,
            };
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );

    let t = now_ms();
    // The dialog's field reports the focus twice while the worker is busy,
    // then the focus returns to the owner as the dialog closes.
    pool.dispatch(focus_event(1, t, dialog));
    pool.dispatch(focus_event(2, t + 5, dialog));
    pool.dispatch(focus_event(3, t + 10, owner));
    open_gate(&gate);

    thread::sleep(Duration::from_millis(300));
    pool.shutdown();
    let events: Vec<ActionEvent> = action_rx.try_iter().collect();

    assert_eq!(
        focus_selectors_of(&events),
        vec!["Window:delete_me.txt - Notepad > Edit:Text Editor".to_string()],
        "focus events described as one element, with no other focus between \
         them, are one focus action"
    );
}

/// A focus that returns to an element after a focus elsewhere is a focus
/// change of its own and is written, whichever windows the events named.
#[test]
fn a_focus_back_to_an_element_after_another_focus_is_written() {
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    // Field A, field B, field A again: each description pops the next one.
    let selectors = Arc::new(Mutex::new(VecDeque::from(vec![
        "Edit#a".to_string(),
        "Edit#b".to_string(),
        "Edit#a".to_string(),
    ])));
    let worker_selectors = Arc::clone(&selectors);
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = QueuedFocusBackend {
                selectors: Arc::clone(&worker_selectors),
            };
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );

    let t = now_ms();
    for (seq, window) in [(1, 0x100), (2, 0x200), (3, 0x100)] {
        pool.dispatch(focus_event(seq, t + seq * 5, window));
        thread::sleep(Duration::from_millis(60));
    }
    pool.shutdown();
    let events: Vec<ActionEvent> = action_rx.try_iter().collect();

    assert_eq!(
        focus_selectors_of(&events),
        vec!["Edit#a", "Edit#b", "Edit#a"],
    );
}

/// A focused element in Notepad's window `window`, described only once
/// `gate` is open, under a focus epoch the test moves on.
struct LateFocusBackend {
    gate: Gate,
    epoch: Arc<AtomicU64>,
    /// The number of the latest focus event the Input_Thread dispatched.
    focus_events: Arc<AtomicU64>,
    window: i64,
}

impl AccessibilityBackend for LateFocusBackend {
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
        let _open = signal
            .wait_timeout_while(guard, Duration::from_secs(10), |open| !*open)
            .unwrap();
        Some(ElementDescription {
            tag: "Edit".to_string(),
            name: Some("Text Editor".to_string()),
            selector: "Window:delete_me.txt - Notepad > Edit:Text Editor".to_string(),
            ..Default::default()
        })
    }

    fn focused_element_in_window(&self) -> Option<(ElementDescription, i64)> {
        self.focused_element().map(|element| (element, self.window))
    }

    fn focus_epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    fn focus_events_dispatched(&self) -> u64 {
        self.focus_events.load(Ordering::SeqCst)
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

/// A focus event as the Input_Thread dispatches it: the focus change counted,
/// the event numbered as the latest focus event dispatched, and stamped with
/// both.
fn dispatched_focus(
    seq: u64,
    timestamp: u64,
    window_handle: i64,
    epoch: &AtomicU64,
    focus_events: &AtomicU64,
) -> RawEvent {
    epoch.fetch_add(1, Ordering::SeqCst);
    let mut raw = focus_event(seq, timestamp, window_handle);
    raw.focus_epoch = epoch.load(Ordering::SeqCst);
    raw.callback_params[2] = (focus_events.fetch_add(1, Ordering::SeqCst) + 1) as i64;
    raw
}

/// Regression (https://github.com/Arsarneq/docent/issues/735): the focus on
/// a dialog's File name box waited behind a busy worker and was described
/// after Enter had closed the dialog, as the owner's text area. Written at
/// its own place, before the path was typed, it also made the owner's own
/// focus after the Enter compare equal and go unwritten. A focus described
/// after a later focus event was dispatched writes nothing; the later focus
/// is written at its own place.
#[test]
fn regression_735_a_focus_described_after_a_later_focus_event_writes_nothing() {
    const DIALOG: i64 = 0x200;
    const OWNER: i64 = 0x100;
    let gate = closed_gate();
    let epoch = Arc::new(AtomicU64::new(1));
    let focus_events = Arc::new(AtomicU64::new(0));
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let (worker_gate, worker_epoch, worker_focus_events) = (
        Arc::clone(&gate),
        Arc::clone(&epoch),
        Arc::clone(&focus_events),
    );
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = LateFocusBackend {
                gate: Arc::clone(&worker_gate),
                epoch: Arc::clone(&worker_epoch),
                focus_events: Arc::clone(&worker_focus_events),
                window: OWNER,
            };
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );

    let t = now_ms();
    // The File name box takes the focus.
    pool.dispatch(dispatched_focus(1, t, DIALOG, &epoch, &focus_events));
    // The path is typed into the box, then Enter (a key that may move the
    // focus, counted behind its own dispatch).
    for (i, key_code) in [0x41u32, 0x42, 0x0D].into_iter().enumerate() {
        let mut key = layout_key(2 + i as u64, t + 10 * (i as u64 + 1), key_code);
        key.window_handle = DIALOG;
        key.focus_epoch = epoch.load(Ordering::SeqCst);
        pool.dispatch(key);
    }
    epoch.fetch_add(FOCUS_EPOCH_PERSON_STEP, Ordering::SeqCst);
    // The dialog closes and the focus returns to the owner's text area.
    pool.dispatch(dispatched_focus(5, t + 50, OWNER, &epoch, &focus_events));
    open_gate(&gate);

    thread::sleep(Duration::from_millis(300));
    pool.shutdown();
    let events: Vec<ActionEvent> = action_rx.try_iter().collect();

    let focuses: Vec<u64> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Focus { .. }))
        .map(|e| e.sequence_id.unwrap_or(0))
        .collect();
    assert_eq!(
        focuses,
        vec![5],
        "one focus, at the owner's own focus event after the Enter"
    );
}

/// Regression (https://github.com/Arsarneq/docent/issues/735): a focus
/// change the Input_Thread counts but sends no focus event for (a background
/// or out-of-scope program focusing inside its own window, for one) does not
/// make a worker drop a focus it describes after it: no later focus event
/// would record the focus in its place.
#[test]
fn regression_735_a_focus_described_after_a_counted_change_with_no_focus_event_is_written() {
    const FIELD_WINDOW: i64 = 0x100;
    let gate = closed_gate();
    let epoch = Arc::new(AtomicU64::new(1));
    let focus_events = Arc::new(AtomicU64::new(0));
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let (worker_gate, worker_epoch, worker_focus_events) = (
        Arc::clone(&gate),
        Arc::clone(&epoch),
        Arc::clone(&focus_events),
    );
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = LateFocusBackend {
                gate: Arc::clone(&worker_gate),
                epoch: Arc::clone(&worker_epoch),
                focus_events: Arc::clone(&worker_focus_events),
                window: FIELD_WINDOW,
            };
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );

    // Tab moves the focus to the field while the worker is busy.
    pool.dispatch(dispatched_focus(
        1,
        now_ms(),
        FIELD_WINDOW,
        &epoch,
        &focus_events,
    ));
    // Another program reports a focus change inside its own window: counted,
    // and filtered out with no focus event sent.
    epoch.fetch_add(1, Ordering::SeqCst);
    open_gate(&gate);

    thread::sleep(Duration::from_millis(300));
    pool.shutdown();
    let events: Vec<ActionEvent> = action_rx.try_iter().collect();

    let focuses: Vec<u64> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Focus { .. }))
        .map(|e| e.sequence_id.unwrap_or(0))
        .collect();
    assert_eq!(focuses, vec![1], "the field's focus is written");
}

/// A focus on an element whose selector equals that of the focus before it,
/// in another window (two windows of one program with the same title), is a
/// focus change and is written; the same element twice is one focus.
#[test]
fn a_focus_is_compared_with_the_last_within_its_window() {
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let selectors = Arc::new(Mutex::new(VecDeque::from(vec![
        "Edit#a".to_string(),
        "Edit#a".to_string(),
        "Edit#a".to_string(),
    ])));
    let worker_selectors = Arc::clone(&selectors);
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = QueuedFocusBackend {
                selectors: Arc::clone(&worker_selectors),
            };
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );

    let t = now_ms();
    for (seq, window) in [(1, 0x100), (2, 0x200), (3, 0x200)] {
        pool.dispatch(focus_event(seq, t + seq * 5, window));
        thread::sleep(Duration::from_millis(60));
    }
    pool.shutdown();
    let events: Vec<ActionEvent> = action_rx.try_iter().collect();

    let focuses: Vec<(u64, Option<i64>)> = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Focus { .. }))
        .map(|e| (e.sequence_id.unwrap_or(0), e.context_id))
        .collect();
    assert_eq!(focuses, vec![(1, Some(0x100)), (2, Some(0x200))]);
}

/// A backend whose focused element is the next selector of a shared queue.
struct QueuedFocusBackend {
    selectors: Arc<Mutex<VecDeque<String>>>,
}

impl AccessibilityBackend for QueuedFocusBackend {
    fn init(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }

    fn cleanup(&mut self) {}

    fn element_at_point(&self, _x: i32, _y: i32) -> Option<ElementDescription> {
        None
    }

    fn focused_element(&self) -> Option<ElementDescription> {
        let selector = self.selectors.lock().unwrap().pop_front()?;
        Some(ElementDescription {
            tag: "Edit".to_string(),
            selector,
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

/// Regression: text typed with a pause of more than 500 ms between
/// the keys was recorded as one `type` per key, each holding the field's text
/// so far ("k", "ke", "kee", "keep"): the pending `type` was written whenever
/// no value change had followed it for that long. How fast a person types is
/// no part of what they typed.
#[test]
fn regression_719_text_typed_with_pauses_between_the_keys_is_one_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let live = Arc::new(Mutex::new(String::new()));
    let harness = WorkerTestHarness::new(TypingBackend::edit_live(&gate, &live));

    let mut seq = 0;
    for character in "keep".chars() {
        type_character(&live, character, &mut seq, |raw| harness.send_event(raw));
        // Longer than the old pause rule (500 ms) and the worker's tick.
        thread::sleep(Duration::from_millis(600));
    }
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["keep"], "got {events:?}");
    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "got {events:?}"
    );
}

/// Regression: a field emptied by a key was recorded with its name as the
/// `type` value. An element's text falls back to its name where its value is
/// empty, and the `type` value was read from that text.
#[test]
fn regression_720_a_field_emptied_by_a_key_is_the_empty_type_not_its_name() {
    let gate = closed_gate();
    open_gate(&gate);
    let live = Arc::new(Mutex::new("a".to_string()));
    let harness = WorkerTestHarness::new(TypingBackend::edit_live(&gate, &live));

    live.lock().unwrap().clear();
    let t = now_ms();
    harness.send_event(layout_key(1, t, 0x08)); // Backspace
    harness.send_event(value_change(2, t + 5, 1234));
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    assert_eq!(key_names_of(&events), vec!["Backspace"], "got {events:?}");
    assert_eq!(type_values_of(&events), vec![""], "got {events:?}");
}

/// An element that has no value gives a value change no `type`: its name is
/// not what was typed, and the keys stay the record.
#[test]
fn a_value_change_on_an_element_with_no_value_keeps_the_keys() {
    let gate = closed_gate();
    open_gate(&gate);
    let live = Arc::new(Mutex::new(String::new()));
    let mut backend = TypingBackend::edit_live(&gate, &live);
    backend.has_value = false;
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(layout_key(1, t, 0x41));
    harness.send_event(value_change(2, t + 5, 1234));
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    assert_eq!(
        type_values_of(&events),
        Vec::<String>::new(),
        "got {events:?}"
    );
    assert_eq!(key_names_of(&events), vec!["A"], "got {events:?}");
}

/// The events that end the typing in a field, each with the name it is
/// reported under when its case fails.
fn typing_enders() -> Vec<(&'static str, RawEventType)> {
    vec![
        ("click", RawEventType::Click),
        ("right click", RawEventType::RightClick),
        (
            "drag start",
            RawEventType::DragStart {
                source_coords: (0, 0),
            },
        ),
        (
            "drop",
            RawEventType::Drop {
                source_coords: (0, 0),
            },
        ),
        ("foreground", RawEventType::Foreground),
    ]
}

/// A field's `type` is written when the typing in it ends, and a click, a
/// drag or a window change ends it, whichever worker
/// that event is routed to: the text typed before it is one `type`, written
/// while the recording still runs, and the text typed after it is the next.
#[test]
fn regression_719_the_event_that_ends_the_typing_writes_the_type() {
    for (name, ender) in typing_enders() {
        let gate = closed_gate();
        open_gate(&gate);
        let live = Arc::new(Mutex::new(String::new()));
        let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
        let worker_gate = Arc::clone(&gate);
        let worker_live = Arc::clone(&live);
        let mut pool = WorkerPool::new(
            3,
            action_tx,
            move |index, rx, queue_len, sender, pending| {
                let backend = TypingBackend::edit_live(&worker_gate, &worker_live);
                thread::spawn(move || {
                    let ep = Arc::new(AtomicU32::new(0));
                    worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
                })
            },
        );
        let mut seq = 0;
        type_character(&live, 'a', &mut seq, |raw| pool.dispatch(raw));
        type_character(&live, 'b', &mut seq, |raw| pool.dispatch(raw));
        let typed_until = seq;
        let mut end = make_raw_event(ender, 1234);
        end.sequence_id = typed_until + 1;
        end.timestamp = now_ms();
        pool.dispatch(end);
        thread::sleep(Duration::from_millis(200));
        let before_stop: Vec<ActionEvent> = action_rx.try_iter().collect();
        assert_eq!(
            type_values_of(&before_stop),
            vec!["ab"],
            "{name}: the typing it ended is written at once, got {before_stop:?}"
        );
        let written = before_stop
            .iter()
            .find(|e| matches!(e.payload, ActionPayload::Type { .. }))
            .unwrap();
        assert_eq!(
            written.sequence_id,
            Some(typed_until),
            "{name}: the type is ordered ahead of the event that ended it"
        );

        // The ending event took the next id.
        seq += 1;
        type_character(&live, 'c', &mut seq, |raw| pool.dispatch(raw));
        pool.shutdown();
        let after: Vec<ActionEvent> = action_rx.try_iter().collect();
        assert_eq!(
            type_values_of(&after),
            vec!["abc"],
            "{name}: the text typed after it is the next type, got {after:?}"
        );
    }
}

/// A window the recording keeps nothing of comes to the front (the
/// recorder's own window to complete the step, or a window outside the
/// application recorded): no event of that window reaches the pool, and the typing has ended all the same. Told so, the pool has the
/// `type` written at once, with no further key or click in the application
/// (docent#768), and the text typed on return is the next `type`.
#[test]
fn regression_768_leaving_for_a_window_not_recorded_writes_the_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let live = Arc::new(Mutex::new(String::new()));
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let worker_gate = Arc::clone(&gate);
    let worker_live = Arc::clone(&live);
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = TypingBackend::edit_live(&worker_gate, &worker_live);
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );
    let mut seq = 0;
    type_character(&live, 'a', &mut seq, |raw| pool.dispatch(raw));
    type_character(&live, 'b', &mut seq, |raw| pool.dispatch(raw));
    let typed_until = seq;
    pool.end_typing();
    thread::sleep(Duration::from_millis(200));
    let before_stop: Vec<ActionEvent> = action_rx.try_iter().collect();
    assert_eq!(
        type_values_of(&before_stop),
        vec!["ab"],
        "the typing is written when the person leaves, got {before_stop:?}"
    );
    assert_eq!(
        before_stop.len(),
        1,
        "and nothing beside it, got {before_stop:?}"
    );
    assert_eq!(before_stop[0].sequence_id, Some(typed_until));

    type_character(&live, 'c', &mut seq, |raw| pool.dispatch(raw));
    pool.shutdown();
    let after: Vec<ActionEvent> = action_rx.try_iter().collect();
    assert_eq!(
        type_values_of(&after),
        vec!["abc"],
        "the text typed on return is the next type, got {after:?}"
    );
}

/// Leaving with nothing typed writes nothing.
#[test]
fn regression_768_leaving_with_nothing_typed_writes_nothing() {
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, queue_len, sender, pending| {
            let backend = MockBackend::new();
            thread::spawn(move || {
                let ep = Arc::new(AtomicU32::new(0));
                worker_loop(index, backend, rx, queue_len, sender, ep, pending, None);
            })
        },
    );
    pool.end_typing();
    pool.shutdown();
    let written: Vec<ActionEvent> = action_rx.try_iter().collect();
    assert!(written.is_empty(), "got {written:?}");
}

/// What each worker of a three-worker pool is sent when `events` are
/// dispatched in order: "event" for an event, "end typing" and "look at
/// focus" for the signals.
fn messages_sent_for(events: Vec<RawEvent>) -> Vec<Vec<&'static str>> {
    let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
    let sent: Vec<Arc<Mutex<Vec<&'static str>>>> =
        (0..3).map(|_| Arc::new(Mutex::new(Vec::new()))).collect();
    let worker_sent = sent.clone();
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, _queue_len, _sender, _pending| {
            let sent = Arc::clone(&worker_sent[index]);
            thread::spawn(move || loop {
                match rx.recv() {
                    Ok(WorkerMessage::Event(_)) => sent.lock().unwrap().push("event"),
                    Ok(WorkerMessage::EndTyping) => sent.lock().unwrap().push("end typing"),
                    Ok(WorkerMessage::MenuCommand) => sent.lock().unwrap().push("menu command"),
                    Ok(WorkerMessage::LookAtFocus) => sent.lock().unwrap().push("look at focus"),
                    Ok(WorkerMessage::Flush(_)) => {}
                    Ok(WorkerMessage::Shutdown) | Err(_) => break,
                }
            })
        },
    );
    for event in events {
        pool.dispatch(event);
    }
    pool.shutdown();
    let result = sent.iter().map(|w| w.lock().unwrap().clone()).collect();
    result
}

/// The event that ends the typing is routed like any other, to a worker that
/// is seldom the typing worker; the dispatcher tells the typing worker, in
/// the order of the events, so the `type` it holds goes out.
#[test]
fn regression_719_the_typing_worker_is_told_when_the_typing_ends() {
    for (name, ender) in typing_enders() {
        // These workers never report an event done, so the typing worker's
        // queue stays the longest and the ending event goes to another.
        let sent = messages_sent_for(vec![layout_key(1, 1000, 0x41), make_raw_event(ender, 1234)]);
        assert!(
            sent.iter()
                .any(|worker| worker.starts_with(&["event", "end typing"])),
            "{name}: the worker that got the key is told behind it, got {sent:?}"
        );
    }
}

/// A window that comes to the front has the typing worker look at the
/// control focused in it, behind the end of the typing (docent#761); no other
/// event does.
#[test]
fn a_window_that_comes_to_the_front_has_the_typing_worker_look_at_its_focus() {
    let sent = messages_sent_for(vec![
        layout_key(1, 1000, 0x41),
        make_raw_event(RawEventType::Foreground, 1234),
    ]);
    assert!(
        sent.iter()
            .any(|worker| worker == &["event", "end typing", "look at focus"]),
        "got {sent:?}"
    );
    for (name, event_type) in typing_enders()
        .into_iter()
        .filter(|(_, t)| !matches!(t, RawEventType::Foreground))
        .chain([
            ("scroll", RawEventType::Scroll),
            ("focus", RawEventType::Focus),
            ("key", RawEventType::Keyboard),
        ])
    {
        let sent = messages_sent_for(vec![
            layout_key(1, 1000, 0x41),
            make_raw_event(event_type, 1234),
        ]);
        assert!(
            sent.iter().all(|w| !w.contains(&"look at focus")),
            "{name}: got {sent:?}"
        );
    }
}

/// Before any key, the look chooses the typing worker, and the keys follow
/// it there.
#[test]
fn a_look_before_any_key_chooses_the_typing_worker() {
    let sent = messages_sent_for(vec![
        make_raw_event(RawEventType::Foreground, 1234),
        layout_key(2, 1000, 0x41),
    ]);
    assert!(
        sent.iter()
            .any(|worker| worker.ends_with(&["look at focus", "event"])),
        "got {sent:?}"
    );
}

/// An event that ends no typing sends the typing worker nothing.
#[test]
fn an_event_that_ends_no_typing_sends_the_typing_worker_nothing() {
    for event_type in [
        RawEventType::Scroll,
        RawEventType::ValueChange,
        RawEventType::Keyboard,
        RawEventType::Selection,
        RawEventType::Focus,
    ] {
        let sent = messages_sent_for(vec![
            layout_key(1, 1000, 0x41),
            make_raw_event(event_type.clone(), 1234),
        ]);
        assert!(
            sent.iter().all(|w| !w.contains(&"end typing")),
            "{event_type:?}: got {sent:?}"
        );
    }
}

/// Regression: a worker told to shut down drained the events still queued
/// behind that message only up to the first message that was no event, so
/// the typing queued behind an end-of-typing signal or a commit's flush marker
/// was lost at the stop.
#[test]
fn regression_719_the_shutdown_drain_reads_past_messages_that_are_no_event() {
    let gate = closed_gate();
    let live = Arc::new(Mutex::new("ab".to_string()));
    let harness = WorkerTestHarness::new(TypingBackend::edit_live(&gate, &live));

    // The worker holds on the first key until the gate opens; everything
    // else queues behind it, the shutdown ahead of the rest.
    let t = now_ms();
    harness.send_event(layout_key(1, t, 0x41));
    thread::sleep(Duration::from_millis(100));
    harness.event_tx.send(WorkerMessage::Shutdown).unwrap();
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    harness.send_event(layout_key(2, t + 1, 0x42));
    let (ack_tx, ack_rx) = mpsc::channel::<usize>();
    harness.event_tx.send(WorkerMessage::Flush(ack_tx)).unwrap();
    harness.send_event(value_change(3, t + 2, 1234));
    open_gate(&gate);
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["ab"], "got {events:?}");
    assert!(
        ack_rx.try_recv().is_ok(),
        "a flush marker read during the drain is acknowledged"
    );
}

/// A value change that reaches the worker after the click that ended the
/// typing is not folded back into the `type` already written: it starts the
/// field's next `type`, behind the click.
#[test]
fn a_value_change_arriving_after_the_click_starts_the_next_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let live = Arc::new(Mutex::new(String::new()));
    let harness = WorkerTestHarness::new(TypingBackend::edit_live(&gate, &live));

    let mut seq = 0;
    type_character(&live, 'a', &mut seq, |raw| harness.send_event(raw));
    // The second key's value change is late: the click is dispatched first.
    let t = now_ms();
    harness.send_event(layout_key(3, t, 0x42));
    let mut click = make_raw_event(RawEventType::Click, 1234);
    click.sequence_id = 4;
    click.timestamp = t + 1;
    harness.send_event(click);
    live.lock().unwrap().push('b');
    harness.send_event(value_change(5, t + 2, 1234));
    thread::sleep(Duration::from_millis(100));
    let events = harness.shutdown();

    let types: Vec<(String, Option<u64>)> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Type { value, .. } => Some((value.clone(), e.sequence_id)),
            _ => None,
        })
        .collect();
    assert_eq!(
        types,
        vec![("a".to_string(), Some(2)), ("ab".to_string(), Some(5))],
        "got {events:?}"
    );
}

/// A focus event ends no typing: a program that reports the focus again on
/// the field being typed into leaves its text the one `type`.
#[test]
fn a_focus_event_between_the_keys_leaves_the_typing_one_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let live = Arc::new(Mutex::new(String::new()));
    let harness = WorkerTestHarness::new(TypingBackend::edit_live(&gate, &live));

    let mut seq = 0;
    for character in "ab".chars() {
        type_character(&live, character, &mut seq, |raw| harness.send_event(raw));
        seq += 1;
        let mut focus = make_raw_event(RawEventType::Focus, 1234);
        focus.sequence_id = seq;
        focus.timestamp = now_ms();
        harness.send_event(focus);
    }
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["ab"], "got {events:?}");
}

/// A scroll or a pointer move is no end to the typing: the text typed around
/// it stays the one `type`.
#[test]
fn a_scroll_between_the_keys_leaves_the_typing_one_type() {
    let gate = closed_gate();
    open_gate(&gate);
    let live = Arc::new(Mutex::new(String::new()));
    let harness = WorkerTestHarness::new(TypingBackend::edit_live(&gate, &live));

    let mut seq = 0;
    for character in "ab".chars() {
        type_character(&live, character, &mut seq, |raw| harness.send_event(raw));
        seq += 1;
        let mut scroll = make_raw_event(RawEventType::Scroll, 1234);
        scroll.sequence_id = seq;
        scroll.timestamp = now_ms();
        scroll.scroll_delta = 10.0;
        harness.send_event(scroll);
    }
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["ab"], "got {events:?}");
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
        value: text.map(str::to_string),
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
    /// The backend cannot say whether the focused element is the marked one.
    no_marks: bool,
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
    /// The number of the latest key the Input_Thread dispatched, by window;
    /// a window not in it answers `0`, the platform numbering none.
    latest_keys: HashMap<i64, u64>,
    /// Scripted value reads, first first: the value a control read answers
    /// and the number of the latest key dispatched in the control's window
    /// once the read finished.
    reads: VecDeque<(&'static str, u64)>,
    /// The dialog's window answers no message in time (a hung program).
    hung: bool,
    /// The id of the process that owns the dialog.
    process_id: u32,
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
                no_marks: false,
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
        if self.no_marks {
            return None;
        }
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
        if let Some((value, latest)) = controls.reads.pop_front() {
            controls
                .latest_keys
                .insert(self.root_window_handle(control), latest);
            return Some(value.to_string());
        }
        controls.own.get(&control).and_then(|e| e.text.clone())
    }

    fn keys_dispatched(&self, window: i64) -> u64 {
        let controls = self.controls.lock().unwrap();
        controls.latest_keys.get(&window).copied().unwrap_or(0)
    }

    fn answers_promptly(&self, control: i64) -> bool {
        !(self.controls.lock().unwrap().hung && self.root_window_handle(control) == DIALOG)
    }

    fn process_id_of(&self, window_handle: i64) -> u32 {
        if window_handle == DIALOG {
            self.controls.lock().unwrap().process_id
        } else {
            0
        }
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
        scene.element.value = Some("h".to_string());
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

/// The window's title changes while the person types on (an editor adds or
/// drops its "modified" mark), and the selector of the field with it. The
/// typing is one `type` still: the field is the same, under another title.
#[test]
fn regression_734_typing_across_a_change_of_the_window_title_is_one_type() {
    let mut field = file_name_field("");
    field.element.selector = "Window:Untitled - Editor > Edit:Text".to_string();
    field.element.place_in_window = Some("Edit:Text".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);

    let mut seq = 0;
    for (text, selector) in [
        ("h", "Window:Untitled - Editor > Edit:Text"),
        ("hi", "Window:*Untitled - Editor > Edit:Text"),
        ("hi!", "Window:*Untitled - Editor > Edit:Text"),
    ] {
        seq += 1;
        let unit = u16::from(*text.as_bytes().last().unwrap());
        harness.send_event(in_dialog(packet_key(seq, now_ms(), unit)));
        thread::sleep(Duration::from_millis(150));
        {
            let mut scene = scene.lock().unwrap();
            scene.element.selector = selector.to_string();
            scene.element.text = Some(text.to_string());
            scene.element.value = Some(text.to_string());
        }
        seq += 1;
        harness.send_event(in_dialog(value_change(seq, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(150));
    }

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type hi! on Window:Untitled - Editor > Edit:Text"],
        "got {events:?}"
    );
}

/// Where the backend cannot say whether the focused element is still the
/// marked one, the description decides whether a value change is the key's:
/// by the field's place under the window, across a title change too.
#[test]
fn regression_734_a_value_change_under_another_title_is_the_key_s_where_no_mark_tells() {
    let mut field = file_name_field("");
    field.element.selector = "Window:Untitled - Editor > Edit:Text".to_string();
    field.element.place_in_window = Some("Edit:Text".to_string());
    let (mut backend, scene, _) = MovingFocusBackend::new(field);
    backend.no_marks = true;
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.selector = "Window:*Untitled - Editor > Edit:Text".to_string();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type h on Window:*Untitled - Editor > Edit:Text"],
        "got {events:?}"
    );
}

/// The key's element was described before its place under the window could
/// be read, and the value change that followed read it. A later value change
/// of the field under another title is still the field's: the place the
/// first value change read is remembered for the key.
#[test]
fn regression_734_the_place_a_value_change_read_is_remembered_for_the_key() {
    let mut field = file_name_field("");
    field.element.selector = "Window:Untitled - Editor > Edit:Text".to_string();
    let (mut backend, scene, _) = MovingFocusBackend::new(field);
    backend.no_marks = true;
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.place_in_window = Some("Edit:Text".to_string());
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.selector = "Window:*Untitled - Editor > Edit:Text".to_string();
        scene.element.text = Some("hello".to_string());
        scene.element.value = Some("hello".to_string());
    }
    // The field completes the word itself: a value change with no key.
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["hello"], "got {events:?}");
}

/// The field remembered for the typing is described again at a value change
/// that came with a change of the title and a focus change the program made.
/// It is the remembered field still, so its mark is the fresh one, and a key
/// pressed after the focus has really gone elsewhere is found out: it is
/// recorded on the element that has the focus, not on the remembered field.
#[test]
fn regression_734_the_remembered_field_is_known_again_under_another_title() {
    let mut field = file_name_field("");
    field.element.selector = "Window:Untitled - Editor > Edit:Text".to_string();
    field.element.place_in_window = Some("Edit:Text".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        // A focus change the program made, counted since the key.
        scene.epoch = 2;
        scene.element.selector = "Window:*Untitled - Editor > Edit:Text".to_string();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.epoch = 1;
        let mut other = scene_element("Edit", "Window:*Untitled - Editor > Edit:Other", None);
        other.place_in_window = Some("Edit:Other".to_string());
        scene.element = other;
    }
    harness.send_event(in_dialog(packet_key(3, now_ms(), u16::from(b'x'))));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    let actions = typed_actions_of(&events);
    assert!(
        actions.contains(&"key x on Window:*Untitled - Editor > Edit:Other".to_string()),
        "got {actions:?}"
    );
}

/// A value typed, undone and typed again, in an editor whose title gains and
/// drops an unsaved mark: the second typing was compared with the value kept
/// from the first under the same title, and neither its `type` nor its key
/// was written.
#[test]
fn regression_736_a_value_typed_undone_and_typed_again_is_recorded() {
    let mut field = file_name_field("");
    field.element.selector = "Window:doc - Editor > Edit:Text".to_string();
    field.element.place_in_window = Some("Edit:Text".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);
    let set = |selector: &str, value: &str| {
        let mut scene = scene.lock().unwrap();
        scene.element.selector = selector.to_string();
        scene.element.text = Some(value.to_string());
        scene.element.value = Some(value.to_string());
    };

    // Type h: the title gains the mark.
    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    set("Window:*doc - Editor > Edit:Text", "h");
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    // Ctrl+Z: the text is gone and the mark with it.
    let mut undo = layout_key(3, now_ms(), 0x5A);
    undo.modifiers = (true, false, false, false);
    harness.send_event(in_dialog(undo));
    thread::sleep(Duration::from_millis(150));
    set("Window:doc - Editor > Edit:Text", "");
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    // Type h again.
    harness.send_event(in_dialog(packet_key(5, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    set("Window:*doc - Editor > Edit:Text", "h");
    harness.send_event(in_dialog(value_change(6, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    // The emptied value is carried forward into the second typing.
    assert_eq!(
        typed_actions_of(&events),
        vec![
            "type h on Window:*doc - Editor > Edit:Text",
            "key Z on Window:*doc - Editor > Edit:Text",
            "type h on Window:doc - Editor > Edit:Text"
        ],
        "got {events:?}"
    );
}

/// A field's text is replaced by typing the same text again (select all, then
/// the same character). The value is the one already recorded, and the person
/// typed it all the same: the typing is written.
#[test]
fn regression_736_the_same_text_typed_over_itself_is_recorded() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    let set = |value: &str| {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some(value.to_string());
        scene.element.value = Some(value.to_string());
    };

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    set("h");
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    // Ctrl+A selects the text; it ends the typing.
    let mut select_all = layout_key(3, now_ms(), 0x41);
    select_all.modifiers = (true, false, false, false);
    harness.send_event(in_dialog(select_all));
    thread::sleep(Duration::from_millis(150));
    // h again, over the selection: the value is h as before.
    harness.send_event(in_dialog(packet_key(4, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(5, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "type h on Dialog > Edit:File name",
            "key A on Dialog > Edit:File name",
            "type h on Dialog > Edit:File name"
        ],
        "got {events:?}"
    );
}

/// A value pasted, undone and pasted again, with no typing key at all and a
/// title that changes with each: every value the field took is recorded.
#[test]
fn regression_736_a_value_pasted_undone_and_pasted_again_is_recorded() {
    let mut field = file_name_field("");
    field.element.selector = "Window:doc - Editor > Edit:Text".to_string();
    field.element.place_in_window = Some("Edit:Text".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);
    let set = |selector: &str, value: &str| {
        let mut scene = scene.lock().unwrap();
        scene.element.selector = selector.to_string();
        scene.element.text = Some(value.to_string());
        scene.element.value = Some(value.to_string());
    };
    let mut seq = 0;
    for (code, selector, value) in [
        (0x56, "Window:*doc - Editor > Edit:Text", "h"), // Ctrl+V
        (0x5A, "Window:doc - Editor > Edit:Text", ""),   // Ctrl+Z
        (0x56, "Window:*doc - Editor > Edit:Text", "h"), // Ctrl+V
    ] {
        seq += 1;
        let mut key = layout_key(seq, now_ms(), code);
        key.modifiers = (true, false, false, false);
        harness.send_event(in_dialog(key));
        thread::sleep(Duration::from_millis(150));
        set(selector, value);
        seq += 1;
        harness.send_event(in_dialog(value_change(seq, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(150));
    }

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        type_values_of(&events),
        vec!["h", "", "h"],
        "got {events:?}"
    );
}

/// The same text pasted over itself: the value change that follows a paste
/// key is the person's entry, also where it repeats the field's value.
#[test]
fn regression_751_the_same_text_pasted_over_itself_is_recorded() {
    for (name, paste_code, paste_modifiers) in [
        ("Ctrl+V", 0x56, (true, false, false, false)),
        ("Shift+Insert", 0x2D, (false, true, false, false)),
    ] {
        let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
        let harness = WorkerTestHarness::new(backend);
        let mut seq = 0;
        // Paste, select all, paste again: the field holds "h" after each paste.
        for (code, modifiers, reports) in [
            (paste_code, paste_modifiers, true),
            (0x41, (true, false, false, false), false), // Ctrl+A
            (paste_code, paste_modifiers, true),
        ] {
            seq += 1;
            let mut key = layout_key(seq, now_ms(), code);
            key.modifiers = modifiers;
            harness.send_event(in_dialog(key));
            thread::sleep(Duration::from_millis(150));
            if reports {
                {
                    let mut scene = scene.lock().unwrap();
                    scene.element.text = Some("h".to_string());
                    scene.element.value = Some("h".to_string());
                }
                seq += 1;
                harness.send_event(in_dialog(value_change(seq, now_ms(), DIALOG)));
                thread::sleep(Duration::from_millis(150));
            }
        }

        thread::sleep(Duration::from_millis(900));
        let events = harness.shutdown();

        assert_eq!(
            type_values_of(&events),
            vec!["h", "h"],
            "{name}: got {events:?}"
        );
    }
}

/// The pasted text can be reported after the next key: it is the paste's
/// value change all the same.
#[test]
fn regression_751_a_paste_reported_after_the_next_key_is_recorded() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    let ctrl = (true, false, false, false);
    let none = (false, false, false, false);

    let mut paste = layout_key(1, now_ms(), 0x56);
    paste.modifiers = ctrl;
    harness.send_event(in_dialog(paste));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    // Select all, paste the same text, and press Home before the program
    // reports the paste.
    for (seq, code, modifiers) in [(3, 0x41, ctrl), (4, 0x56, ctrl), (5, 0x24, none)] {
        let mut key = layout_key(seq, now_ms(), code);
        key.modifiers = modifiers;
        harness.send_event(in_dialog(key));
        thread::sleep(Duration::from_millis(150));
    }
    harness.send_event(in_dialog(value_change(6, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h", "h"], "got {events:?}");
}

/// The stated limit of the paste key: one that pasted nothing still waits for
/// the field's next value change, and a repeated report is taken for its text.
#[test]
fn regression_751_a_paste_key_that_pasted_nothing_takes_the_next_report_for_its_text() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    // Ctrl+V with nothing to paste: the program reports no change for it.
    let mut paste = layout_key(3, now_ms(), 0x56);
    paste.modifiers = (true, false, false, false);
    harness.send_event(in_dialog(paste));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h", "h"], "got {events:?}");
}

/// A paste key stands for one value change: the same value reported again
/// after it is a repeated report, as after typing.
#[test]
fn regression_751_a_value_change_reported_twice_after_a_paste_is_one_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    let mut paste = layout_key(1, now_ms(), 0x56);
    paste.modifiers = (true, false, false, false);
    harness.send_event(in_dialog(paste));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    // A key that pastes nothing follows; the program reports once more.
    let mut select_all = layout_key(4, now_ms(), 0x41);
    select_all.modifiers = (true, false, false, false);
    harness.send_event(in_dialog(select_all));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(5, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h"], "got {events:?}");
}

/// The Danish acute accent key, a dead key: the keyboard hook reads its
/// accent from the layout with the dead-key flag in bit 31.
fn dead_key(seq: u64) -> RawEvent {
    let mut key = layout_key(seq, now_ms(), 0xDD);
    key.callback_params = [0x0D, 0, 0, 0x8000_0000 | i64::from(u32::from('\u{b4}'))];
    in_dialog(key)
}

/// A dead key is text where the character key after it enters text, however
/// long the person waits between the two: the wait for a value change does
/// not make it a key, because a dead key enters nothing by itself.
#[test]
fn regression_744_a_dead_key_is_text_when_the_next_key_enters_text() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(900));
    harness.send_event(in_dialog(layout_key(2, now_ms(), 0x45)));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("\u{e9}".to_string());
        scene.element.value = Some("\u{e9}".to_string());
    }
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["\u{e9}"], "got {events:?}");
    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "got {events:?}"
    );
}

/// A dead key is a `key` where no character follows it: the key that is no
/// text writes it ahead of itself.
#[test]
fn regression_744_a_dead_key_is_a_key_when_no_character_follows() {
    let (backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(900));
    harness.send_event(in_dialog(layout_key(2, now_ms(), 0x08)));

    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();

    assert_eq!(
        key_names_of(&events),
        vec!["\u{b4}", "Backspace"],
        "got {events:?}"
    );
}

/// A key that is no typing key follows a dead key, and the program enters the
/// bare accent as a character with it (Notepad at Tab: the accent and a tab
/// character). The `type` holds what was entered, so the dead key is part of
/// that text and is no `key` beside it (docent#769). The key that followed is
/// a `key` as always.
#[test]
fn regression_769_a_dead_key_whose_accent_the_program_enters_is_text() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(layout_key(2, now_ms(), 0x09)));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("\u{b4}\t".to_string());
        scene.element.value = Some("\u{b4}\t".to_string());
    }
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["\u{b4}\t"], "got {events:?}");
    assert_eq!(key_names_of(&events), vec!["Tab"], "got {events:?}");
}

/// The same behind typed text and with a pause before the key that is no
/// typing key (Enter): the text typed first is its own `type`, and the
/// accent the program entered at Enter is in the next one, with no `key` for
/// the dead key (docent#769).
#[test]
fn regression_769_a_dead_key_behind_typed_text_whose_accent_the_program_enters_is_text() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x43)));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("c".to_string());
        scene.element.value = Some("c".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    harness.send_event(dead_key(3));
    thread::sleep(Duration::from_millis(900));
    harness.send_event(in_dialog(layout_key(4, now_ms(), 0x0D)));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("c\u{b4}\r\n".to_string());
        scene.element.value = Some("c\u{b4}\r\n".to_string());
    }
    harness.send_event(in_dialog(value_change(5, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        type_values_of(&events),
        vec!["c", "c\u{b4}\r\n"],
        "got {events:?}"
    );
    assert_eq!(key_names_of(&events), vec!["Enter"], "got {events:?}");
}

/// A dead key still waiting when the typing ends (a pointer press, a window
/// change) is written then, ahead of what follows.
#[test]
fn regression_744_a_dead_key_waiting_is_written_when_the_typing_ends() {
    let (backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(900));
    assert_eq!(
        key_names_of(&harness.drain_actions()),
        Vec::<String>::new(),
        "the dead key waits for the key after it"
    );
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    let written = harness.drain_actions();
    let _ = harness.shutdown();

    assert_eq!(key_names_of(&written), vec!["\u{b4}"], "got {written:?}");
}

/// Text is typed, then a dead key: the field's `type` is still held when the
/// typing ends, and the dead key behind it took no part in that text. It is
/// written as a `key` behind the `type`, whatever ends the typing.
#[test]
fn regression_744_a_dead_key_behind_typed_text_is_written_behind_the_type() {
    for ender in ["end of typing", "commit", "stop"] {
        let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
        let harness = WorkerTestHarness::new(backend);

        harness.send_event(in_dialog(layout_key(1, now_ms(), 0x43)));
        {
            let mut scene = scene.lock().unwrap();
            scene.element.text = Some("c".to_string());
            scene.element.value = Some("c".to_string());
        }
        harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(150));
        harness.send_event(dead_key(3));
        thread::sleep(Duration::from_millis(900));

        let mut events = Vec::new();
        match ender {
            "end of typing" => {
                harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
                events.extend(harness.drain_actions());
            }
            "commit" => {
                harness.flush();
                events.extend(harness.drain_actions());
            }
            _ => {}
        }
        events.extend(harness.shutdown());

        let written: Vec<String> = events
            .iter()
            .filter_map(|e| match &e.payload {
                ActionPayload::Type { value, .. } => Some(format!("type {value}")),
                ActionPayload::Key { key, .. } => Some(format!("key {key}")),
                _ => None,
            })
            .collect();
        assert_eq!(
            written,
            vec!["type c", "key \u{b4}"],
            "{ender}: got {events:?}"
        );
    }
}

/// A dead key and the character key after it are both keys where the control
/// took no text from them.
#[test]
fn regression_744_a_dead_key_and_its_character_are_keys_where_no_text_was_taken() {
    let (backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(layout_key(2, now_ms(), 0x45)));
    thread::sleep(Duration::from_millis(900));
    let written = harness.drain_actions();
    let _ = harness.shutdown();

    assert_eq!(
        key_names_of(&written),
        vec!["\u{b4}", "E"],
        "got {written:?}"
    );
}

/// Paste "h" into the dialog's field with the paste key, so the field's last
/// recorded value is "h".
fn paste_h_with_the_key(harness: &WorkerTestHarness, scene: &Arc<Mutex<FocusScene>>) {
    let mut paste = layout_key(1, now_ms(), 0x56);
    paste.modifiers = (true, false, false, false);
    harness.send_event(in_dialog(paste));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
}

/// The same text pasted over itself from a menu: the click on the menu item
/// ends the typing and is a command to the field typed into last, so that
/// field's next value change is the person's entry, also where it repeats
/// the value recorded for the field.
#[test]
fn regression_751_the_same_text_pasted_over_itself_from_a_menu_is_recorded() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    paste_h_with_the_key(&harness, &scene);

    // The click on the menu's Paste item, as the dispatcher tells the typing
    // worker of it; the program then reports the field's value, again "h".
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    harness.event_tx.send(WorkerMessage::MenuCommand).unwrap();
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h", "h"], "got {events:?}");
}

/// A menu command stands for one value change: the same value reported again
/// after it is a repeated report.
#[test]
fn regression_751_a_value_change_reported_twice_after_a_menu_command_is_one_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    paste_h_with_the_key(&harness, &scene);

    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    harness.event_tx.send(WorkerMessage::MenuCommand).unwrap();
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h", "h"], "got {events:?}");
}

/// The stated limit of the menu command: which item was clicked is not read,
/// so after an item that pasted nothing (Save, Copy) a report that repeats
/// the field's value is taken for a paste and written, once.
#[test]
fn regression_751_a_menu_item_that_pasted_nothing_takes_the_next_report_for_its_text() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    paste_h_with_the_key(&harness, &scene);

    // The click on the item changes no text; a key follows, and only then
    // does the program report the field's value once more, and again.
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    harness.event_tx.send(WorkerMessage::MenuCommand).unwrap();
    harness.send_event(in_dialog(layout_key(3, now_ms(), 0x24)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(5, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h", "h"], "got {events:?}");
}

/// A menu command with no field typed into before it waits for nothing: the
/// first text of a field is recorded as ever.
#[test]
fn regression_751_a_menu_command_before_any_typing_leaves_the_first_text_one_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    harness.event_tx.send(WorkerMessage::MenuCommand).unwrap();
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(1, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h"], "got {events:?}");
}

/// A click whose element is `tag`, as the Input_Thread describes it at the
/// release.
fn click_on(tag: &str) -> RawEvent {
    let mut click = make_raw_event(RawEventType::Click, 1234);
    click.sequence_id = 2;
    click.pre_captured_element = Some(ElementDescription {
        tag: tag.to_string(),
        ..file_name_field("").element
    });
    click
}

/// A click on a menu item is routed like any click, to a worker that is
/// seldom the typing worker; the dispatcher tells the typing worker of the
/// command, behind the end of the typing.
#[test]
fn regression_751_the_typing_worker_is_told_of_a_click_on_a_menu_item() {
    let sent = messages_sent_for(vec![layout_key(1, 1000, 0x41), click_on("MenuItem")]);
    assert!(
        sent.iter()
            .any(|worker| worker.starts_with(&["event", "end typing", "menu command"])),
        "got {sent:?}"
    );
}

/// A click on anything else, and a click whose element was not described at
/// the release, is no menu command.
#[test]
fn regression_751_a_click_on_no_menu_item_is_no_menu_command() {
    let plain = make_raw_event(RawEventType::Click, 1234);
    let mut right_click = click_on("MenuItem");
    right_click.event_type = RawEventType::RightClick;
    for (name, click) in [
        ("a button", click_on("Button")),
        ("an element not described", plain),
        ("a right click on a menu item", right_click),
    ] {
        let sent = messages_sent_for(vec![layout_key(1, 1000, 0x41), click]);
        assert!(
            sent.iter().all(|w| !w.contains(&"menu command")),
            "{name}: got {sent:?}"
        );
    }
}

/// A program that reports one change twice writes one `type`: the second
/// report repeats the field's value and no key was typed for it.
#[test]
fn regression_736_a_value_change_reported_twice_is_one_type() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(150));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("h".to_string());
        scene.element.value = Some("h".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    // Enter ends the typing; the program then reports the value once more.
    harness.send_event(in_dialog(layout_key(3, now_ms(), 0x0D)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["h"], "got {events:?}");
}

/// A top-level window is not always a `Window` to the accessibility tree: the
/// title can sit in a segment of another kind. The field is told by its place
/// under the window, whatever the window's segment says.
#[test]
fn regression_734_typing_across_a_title_change_of_a_window_of_another_kind_is_one_type() {
    let mut field = file_name_field("");
    field.element.selector = "Pane:Desktop 1 > Pane:doc - Editor > Edit".to_string();
    field.element.place_in_window = Some("Edit".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);

    let mut seq = 0;
    for (text, selector) in [
        ("a", "Pane:Desktop 1 > Pane:doc - Editor > Edit"),
        ("ab", "Pane:Desktop 1 > Pane:doc > changed - Editor > Edit"),
    ] {
        seq += 1;
        let unit = u16::from(*text.as_bytes().last().unwrap());
        harness.send_event(in_dialog(packet_key(seq, now_ms(), unit)));
        thread::sleep(Duration::from_millis(150));
        {
            let mut scene = scene.lock().unwrap();
            scene.element.selector = selector.to_string();
            scene.element.text = Some(text.to_string());
            scene.element.value = Some(text.to_string());
        }
        seq += 1;
        harness.send_event(in_dialog(value_change(seq, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(150));
    }

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec!["type ab on Pane:Desktop 1 > Pane:doc - Editor > Edit"],
        "got {events:?}"
    );
}

/// Two keys are pressed before the first value change arrives, and the title
/// changes between them. Both are the field's typing: the first is not
/// written as a key when the second arrives.
#[test]
fn regression_734_keys_buffered_across_a_title_change_are_the_field_s_one_type() {
    let mut field = file_name_field("");
    field.element.selector = "Window:Untitled - Editor > Edit:Text".to_string();
    field.element.place_in_window = Some("Edit:Text".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(in_dialog(packet_key(1, now_ms(), u16::from(b'h'))));
    thread::sleep(Duration::from_millis(100));
    scene.lock().unwrap().element.selector = "Window:*Untitled - Editor > Edit:Text".to_string();
    harness.send_event(in_dialog(packet_key(2, now_ms(), u16::from(b'i'))));
    thread::sleep(Duration::from_millis(100));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("hi".to_string());
        scene.element.value = Some("hi".to_string());
    }
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    let actions = typed_actions_of(&events);
    assert_eq!(actions.len(), 1, "got {actions:?}");
    assert!(actions[0].starts_with("type hi on "), "got {actions:?}");
}

/// Two documents of one window differ in a segment under the window's root.
/// They are two fields: text typed into the second is not carried into the
/// `type` pending for the first, and each keeps its own last value.
#[test]
fn regression_734_two_documents_of_one_window_stay_two_fields() {
    let mut field = file_name_field("");
    field.element.selector = "Window:Frame > Window:a.txt > Edit".to_string();
    field.element.place_in_window = Some("Window:a.txt\u{1f}Edit".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);

    let mut seq = 0;
    for (selector, place) in [
        (
            "Window:Frame > Window:a.txt > Edit",
            "Window:a.txt\u{1f}Edit",
        ),
        (
            "Window:Frame > Window:b.txt > Edit",
            "Window:b.txt\u{1f}Edit",
        ),
    ] {
        {
            let mut scene = scene.lock().unwrap();
            // Another element: the mark on the first is not on this one.
            scene.element.id = Some(selector.to_string());
            scene.element.selector = selector.to_string();
            scene.element.place_in_window = Some(place.to_string());
            scene.element.text = Some(String::new());
            scene.element.value = Some(String::new());
        }
        seq += 1;
        harness.send_event(in_dialog(packet_key(seq, now_ms(), u16::from(b'5'))));
        thread::sleep(Duration::from_millis(150));
        {
            let mut scene = scene.lock().unwrap();
            scene.element.text = Some("5".to_string());
            scene.element.value = Some("5".to_string());
        }
        seq += 1;
        harness.send_event(in_dialog(value_change(seq, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(150));
    }

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(
        typed_actions_of(&events),
        vec![
            "type 5 on Window:Frame > Window:a.txt > Edit",
            "type 5 on Window:Frame > Window:b.txt > Edit"
        ],
        "got {events:?}"
    );
}

/// One window shows one record after another under a title that names it.
/// The same value typed into the same field of the next record is recorded:
/// the last value is kept for the field under the title it had.
#[test]
fn regression_734_the_same_value_typed_under_another_title_is_recorded() {
    let mut field = file_name_field("");
    field.element.selector = "Window:Order 1001 - App > Edit:Quantity".to_string();
    field.element.place_in_window = Some("Edit:Quantity".to_string());
    let (backend, scene, _) = MovingFocusBackend::new(field);
    let harness = WorkerTestHarness::new(backend);

    let mut seq = 0;
    for selector in [
        "Window:Order 1001 - App > Edit:Quantity",
        "Window:Order 1002 - App > Edit:Quantity",
    ] {
        {
            let mut scene = scene.lock().unwrap();
            scene.element.selector = selector.to_string();
            scene.element.text = Some(String::new());
            scene.element.value = Some(String::new());
        }
        seq += 1;
        harness.send_event(in_dialog(packet_key(seq, now_ms(), u16::from(b'5'))));
        thread::sleep(Duration::from_millis(150));
        {
            let mut scene = scene.lock().unwrap();
            scene.element.text = Some("5".to_string());
            scene.element.value = Some("5".to_string());
        }
        seq += 1;
        harness.send_event(in_dialog(value_change(seq, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(150));
        // Enter saves the record and ends the typing.
        seq += 1;
        harness.send_event(in_dialog(layout_key(seq, now_ms(), 0x0D)));
        thread::sleep(Duration::from_millis(150));
    }

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();

    assert_eq!(type_values_of(&events), vec!["5", "5"], "got {events:?}");
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
// File dialog proxy: a file confirmed by a double-click in the item view
// ---------------------------------------------------------------------------

use docent_desktop_lib::capture::worker_pool::{
    ClickPress, DoubleClickBounds, DoubleClickTracker, CLICK_COMPLETES_DOUBLE_CLICK,
    CLICK_IS_MIDDLE_BUTTON,
};

/// The windows of a Notepad Open dialog, as the mouse hook names them: the
/// items view a click on a file lands in (a child of the dialog), the dialog
/// itself, and Notepad's editor, which a click lands in once the dialog has
/// closed.
const ITEMS_VIEW: i64 = 0x0510;
const OPEN_DIALOG: i64 = 0x0500;
const EDITOR: i64 = 0x0610;
/// Notepad's main window, behind its Open dialog.
const NOTEPAD_MAIN: i64 = 0x0600;

/// A backend modelling an Open dialog showing `directory`, whose File name
/// field holds `file_name`: its read answers for any window inside the
/// dialog, and for no other window (the dialog is gone once the second click
/// of a double-click is processed).
struct FileDialogBackend {
    directory: &'static str,
    file_name: &'static str,
    /// The file on disk the shown path names, as `(shown path, file)`.
    on_disk: Option<(&'static str, &'static str)>,
    /// The dialog type its title gives.
    dialog_type: &'static str,
    reads: Arc<AtomicU64>,
}

impl FileDialogBackend {
    fn showing(directory: &'static str, file_name: &'static str) -> (Self, Arc<AtomicU64>) {
        let reads = Arc::new(AtomicU64::new(0));
        (
            Self {
                directory,
                file_name,
                on_disk: None,
                dialog_type: "open",
                reads: Arc::clone(&reads),
            },
            reads,
        )
    }
}

impl AccessibilityBackend for FileDialogBackend {
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
    fn window_title(&self, window_handle: i64) -> String {
        if self.root_window_handle(window_handle) == OPEN_DIALOG {
            "Open".to_string()
        } else {
            "license.txt - Notepad".to_string()
        }
    }
    fn process_name(&self, _window_handle: i64) -> String {
        "notepad.exe".to_string()
    }
    fn read_file_dialog_path(&self, window_handle: i64) -> Option<(String, String)> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.root_window_handle(window_handle) != OPEN_DIALOG {
            return None;
        }
        Some((
            self.dialog_type.to_string(),
            format!("{}\\{}", self.directory, self.file_name),
        ))
    }
    fn file_on_disk(&self, shown_path: &str) -> Option<String> {
        self.on_disk
            .filter(|(shown, _)| *shown == shown_path)
            .map(|(_, file)| file.to_string())
    }
    fn root_window_handle(&self, window_handle: i64) -> i64 {
        match window_handle {
            ITEMS_VIEW | OPEN_DIALOG => OPEN_DIALOG,
            EDITOR | NOTEPAD_MAIN => NOTEPAD_MAIN,
            other => other,
        }
    }
    fn window_rect(&self, window_handle: i64) -> Option<docent_desktop_lib::capture::WindowRect> {
        let x = if self.root_window_handle(window_handle) == OPEN_DIALOG {
            200
        } else {
            0
        };
        Some(docent_desktop_lib::capture::WindowRect {
            x,
            y: 100,
            width: 800,
            height: 600,
        })
    }
    fn selected_item_name(&self, _window_handle: i64) -> Option<(ElementDescription, String)> {
        None
    }
}

/// The element a click on an item's name cell in the dialog's item view is
/// described as (the Details view, as the issue's recording shows it).
fn item_name_cell(item: &str) -> ElementDescription {
    ElementDescription {
        tag: "Edit".to_string(),
        name: Some("Name".to_string()),
        selector: format!(
            "Pane:Desktop 1 > Window:license.txt - Notepad > Window:Open > Pane > \
             Pane:Shell Folder View > List:Items View > Group:A long time ago > \
             ListItem:{item} > Edit:Name"
        ),
        ..Default::default()
    }
}

/// The dialog's Open button.
fn open_button() -> ElementDescription {
    ElementDescription {
        tag: "Button".to_string(),
        name: Some("Open".to_string()),
        selector: "Pane:Desktop 1 > Window:license.txt - Notepad > Window:Open > Button:Open"
            .to_string(),
        ..Default::default()
    }
}

/// Notepad's editor, where the second click of the double-click is described
/// once the dialog has closed.
fn notepad_editor() -> ElementDescription {
    ElementDescription {
        tag: "Edit".to_string(),
        name: Some("Text Editor".to_string()),
        selector: "Pane:Desktop 1 > Window:license.txt - Notepad > Edit:Text Editor".to_string(),
        ..Default::default()
    }
}

/// A left click as the mouse hook dispatches it; `completes_double_click`
/// marks the second press of a double-click.
fn left_click(
    sequence_id: u64,
    timestamp: u64,
    window_handle: i64,
    element: ElementDescription,
    completes_double_click: bool,
) -> RawEvent {
    RawEvent {
        event_type: RawEventType::Click,
        sequence_id,
        timestamp,
        screen_x: 2539,
        screen_y: 665,
        window_handle,
        process_id: 7,
        key_code: 0,
        modifiers: (false, false, false, false),
        scroll_delta: 0.0,
        callback_params: [
            if completes_double_click {
                CLICK_COMPLETES_DOUBLE_CLICK
            } else {
                0
            },
            0,
            0,
            0,
        ],
        pre_captured_element: Some(element),
        focus_epoch: 0,
        held: Vec::new(),
    }
}

fn file_dialogs(events: &[ActionEvent]) -> Vec<(String, String, String, Option<i64>, u64)> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::FileDialog {
                dialog_type,
                file_path,
                source,
            } => Some((
                dialog_type.clone(),
                file_path.clone(),
                source.clone(),
                e.context_id,
                e.sequence_id.unwrap_or(0),
            )),
            _ => None,
        })
        .collect()
}

fn click_count(events: &[ActionEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Click { .. }))
        .count()
}

// Regression: #692 — a file opened by a double-click in a file dialog's item
// view recorded no folder, so the file could not be located from the file.
// https://github.com/Arsarneq/docent/issues/692
#[test]
fn regression_692_double_click_on_a_file_records_the_file_and_its_folder() {
    let (backend, _reads) = FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license.txt");
    let harness = WorkerTestHarness::new(backend);

    // The first click selects license.txt in the dialog; the second, 160 ms
    // later at the same point, completes the double-click, and by its
    // release the dialog has closed: it is described in Notepad's editor.
    harness.send_event(left_click(
        1,
        1000,
        ITEMS_VIEW,
        item_name_cell("license.txt"),
        false,
    ));
    harness.send_event(left_click(2, 1160, EDITOR, notepad_editor(), true));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(click_count(&events), 2, "both clicks are recorded");
    assert_eq!(
        file_dialogs(&events),
        vec![(
            "open".to_string(),
            "C:\\Users\\u\\Downloads\\license.txt".to_string(),
            "notepad.exe".to_string(),
            Some(OPEN_DIALOG),
            2,
        )],
        "the double-click records the file it opened, with the dialog's folder, \
         in the dialog's context and beside the second click"
    );
}

/// A double-click on a folder navigates the dialog: selecting a folder leaves
/// the File name field as it was, so the read at the first click does not
/// name the item, and nothing is recorded beyond the two clicks.
#[test]
fn double_click_on_a_folder_in_a_file_dialog_records_no_file_dialog() {
    // The File name still holds a file selected earlier.
    let (backend, _reads) = FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license.txt");
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(left_click(
        1,
        1000,
        ITEMS_VIEW,
        item_name_cell("Archive"),
        false,
    ));
    harness.send_event(left_click(
        2,
        1160,
        ITEMS_VIEW,
        item_name_cell("Archive"),
        true,
    ));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(click_count(&events), 2, "both clicks are recorded");
    assert!(
        file_dialogs(&events).is_empty(),
        "a folder is no file chosen"
    );
}

/// Two clicks on a file that do not make a double-click select it twice and
/// confirm nothing: no file_dialog, and each click reads the dialog afresh.
#[test]
fn two_clicks_on_a_file_that_are_no_double_click_record_no_file_dialog() {
    let (backend, reads) = FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license.txt");
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(left_click(
        1,
        1000,
        ITEMS_VIEW,
        item_name_cell("license.txt"),
        false,
    ));
    harness.send_event(left_click(
        2,
        3000,
        ITEMS_VIEW,
        item_name_cell("license.txt"),
        false,
    ));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(click_count(&events), 2);
    assert!(file_dialogs(&events).is_empty());
    assert_eq!(
        reads.load(Ordering::SeqCst),
        2,
        "each item click reads the dialog"
    );
}

/// A double-click whose first click was on no list item reads no dialog and
/// records no file_dialog: only a click on an item reads the dialog.
#[test]
fn a_double_click_off_the_item_view_reads_no_dialog_and_records_no_file_dialog() {
    let (backend, reads) = FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license.txt");
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(left_click(1, 1000, EDITOR, notepad_editor(), false));
    harness.send_event(left_click(2, 1160, EDITOR, notepad_editor(), true));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(click_count(&events), 2);
    assert!(file_dialogs(&events).is_empty());
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "no item click, no dialog read"
    );
}

/// The file a click selected is held for the click right after it only: a
/// double-click whose first click selected nothing does not confirm a file an
/// earlier click selected.
#[test]
fn a_file_selected_before_another_click_is_not_confirmed_by_a_later_double_click() {
    let (backend, _reads) = FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license.txt");
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(left_click(
        1,
        1000,
        ITEMS_VIEW,
        item_name_cell("license.txt"),
        false,
    ));
    harness.send_event(left_click(2, 3000, EDITOR, notepad_editor(), false));
    harness.send_event(left_click(3, 3160, EDITOR, notepad_editor(), true));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(click_count(&events), 3);
    assert!(file_dialogs(&events).is_empty());
}

/// A click on the dialog's Open button reads the dialog at that click, from
/// the button's window, and records the file beside it.
#[test]
fn a_click_on_the_open_button_records_the_file_and_its_folder() {
    let (backend, _reads) = FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license.txt");
    let harness = WorkerTestHarness::new(backend);

    let open_button = open_button();
    harness.send_event(left_click(1, 1000, ITEMS_VIEW, open_button, false));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(click_count(&events), 1);
    assert_eq!(
        file_dialogs(&events),
        vec![(
            "open".to_string(),
            "C:\\Users\\u\\Downloads\\license.txt".to_string(),
            "notepad.exe".to_string(),
            Some(OPEN_DIALOG),
            1,
        )]
    );
}

/// With file extensions hidden, the dialog shows "license" for license.txt,
/// in its item view and its File name field alike: the file_dialog names the
/// file on disk the text names, not the text, whichever way the pick is
/// confirmed.
#[test]
fn regression_692_a_file_shown_without_its_extension_is_recorded_as_the_file() {
    for by_double_click in [true, false] {
        let (mut backend, _reads) =
            FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license");
        backend.on_disk = Some((
            "C:\\Users\\u\\Downloads\\license",
            "C:\\Users\\u\\Downloads\\license.txt",
        ));
        let harness = WorkerTestHarness::new(backend);
        if by_double_click {
            harness.send_event(left_click(
                1,
                1000,
                ITEMS_VIEW,
                item_name_cell("license"),
                false,
            ));
            harness.send_event(left_click(2, 1160, EDITOR, notepad_editor(), true));
        } else {
            harness.send_event(left_click(1, 1000, ITEMS_VIEW, open_button(), false));
        }

        thread::sleep(Duration::from_millis(200));
        let events = harness.shutdown();

        let recorded: Vec<String> = file_dialogs(&events).into_iter().map(|d| d.1).collect();
        assert_eq!(
            recorded,
            vec!["C:\\Users\\u\\Downloads\\license.txt".to_string()],
            "confirmed by {}",
            if by_double_click {
                "a double-click"
            } else {
                "the Open button"
            }
        );
    }
}

/// A Save dialog's File name text names the file to be written, which need
/// not exist: a file already there that the shell displays under the same
/// text ("report" for report.pdf, saving a report as .docx) is not the
/// file chosen, so a Save records the text as the dialog shows it.
#[test]
fn a_save_records_the_text_not_a_file_displayed_under_it() {
    for dialog_type in ["save", "save_as"] {
        let (mut backend, _reads) = FileDialogBackend::showing("C:\\Users\\u\\Documents", "report");
        backend.dialog_type = dialog_type;
        backend.on_disk = Some((
            "C:\\Users\\u\\Documents\\report",
            "C:\\Users\\u\\Documents\\report.pdf",
        ));
        let harness = WorkerTestHarness::new(backend);
        harness.send_event(left_click(1, 1000, ITEMS_VIEW, save_button(), false));

        thread::sleep(Duration::from_millis(200));
        let events = harness.shutdown();

        let recorded: Vec<(String, String)> = file_dialogs(&events)
            .into_iter()
            .map(|d| (d.0, d.1))
            .collect();
        assert_eq!(
            recorded,
            vec![(
                dialog_type.to_string(),
                "C:\\Users\\u\\Documents\\report".to_string()
            )]
        );
    }
}

fn save_button() -> ElementDescription {
    ElementDescription {
        tag: "Button".to_string(),
        name: Some("Save".to_string()),
        selector: "Pane:Desktop 1 > Window:Untitled - Notepad > Window:Save As > Button:Save"
            .to_string(),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Double-click pairing (DCP-10)
// ---------------------------------------------------------------------------

/// The system's default bounds: 500 ms, a 4 x 4 rectangle.
const BOUNDS: DoubleClickBounds = DoubleClickBounds {
    max_interval_ms: 500,
    width: 4,
    height: 4,
};

fn press(time_ms: u32, x: i32, y: i32) -> ClickPress {
    ClickPress {
        time_ms,
        x,
        y,
        window: 7,
    }
}

#[test]
fn a_second_press_within_the_time_and_rectangle_completes_a_double_click() {
    let mut tracker = DoubleClickTracker::new();
    assert!(!tracker.left_click(press(1000, 100, 100), BOUNDS));
    assert!(tracker.left_click(press(1500, 102, 98), BOUNDS));
}

#[test]
fn a_second_press_too_late_far_or_in_another_window_starts_a_new_pair() {
    let mut tracker = DoubleClickTracker::new();
    assert!(!tracker.left_click(press(1000, 100, 100), BOUNDS));
    assert!(!tracker.left_click(press(1501, 100, 100), BOUNDS), "late");
    assert!(
        !tracker.left_click(press(1600, 103, 100), BOUNDS),
        "too far on x"
    );
    assert!(
        !tracker.left_click(press(1700, 103, 103), BOUNDS),
        "too far on y"
    );
    let other_window = ClickPress {
        window: 8,
        ..press(1750, 103, 103)
    };
    assert!(!tracker.left_click(other_window, BOUNDS), "another window");
    // Each press that completed nothing started a new pair.
    assert!(tracker.left_click(
        ClickPress {
            window: 8,
            ..press(1800, 103, 103)
        },
        BOUNDS
    ));
}

#[test]
fn the_press_after_a_double_click_starts_a_new_pair() {
    let mut tracker = DoubleClickTracker::new();
    assert!(!tracker.left_click(press(1000, 100, 100), BOUNDS));
    assert!(tracker.left_click(press(1100, 100, 100), BOUNDS));
    assert!(
        !tracker.left_click(press(1200, 100, 100), BOUNDS),
        "third press"
    );
    assert!(
        tracker.left_click(press(1300, 100, 100), BOUNDS),
        "fourth press"
    );
}

#[test]
fn a_broken_pair_completes_no_double_click() {
    let mut tracker = DoubleClickTracker::new();
    assert!(!tracker.left_click(press(1000, 100, 100), BOUNDS));
    tracker.break_pair();
    assert!(!tracker.left_click(press(1100, 100, 100), BOUNDS));
}

#[test]
fn the_double_click_interval_is_measured_across_the_input_clock_wrapping() {
    let mut tracker = DoubleClickTracker::new();
    assert!(!tracker.left_click(press(u32::MAX - 100, 100, 100), BOUNDS));
    assert!(tracker.left_click(press(200, 100, 100), BOUNDS));
}

/// A click that completes a double-click reaches the worker that took the
/// click before it, even when another worker's queue is shorter; any other
/// click takes the shortest queue.
#[test]
fn a_click_completing_a_double_click_routes_to_the_previous_clicks_worker() {
    let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
    let received: Vec<Arc<Mutex<Vec<u64>>>> =
        (0..3).map(|_| Arc::new(Mutex::new(Vec::new()))).collect();
    let rec = received.clone();
    // The stub workers record what reaches them and never shorten their
    // queue, so each dispatch lengthens the chosen worker's queue.
    let mut pool = WorkerPool::new(
        3,
        action_tx,
        move |index, rx, _queue_len, _sender, _pending| {
            let got = Arc::clone(&rec[index]);
            thread::spawn(move || loop {
                match rx.recv() {
                    Ok(WorkerMessage::Event(raw)) => got.lock().unwrap().push(raw.sequence_id),
                    Ok(WorkerMessage::Flush(_))
                    | Ok(WorkerMessage::EndTyping)
                    | Ok(WorkerMessage::MenuCommand)
                    | Ok(WorkerMessage::LookAtFocus) => {}
                    Ok(WorkerMessage::Shutdown) | Err(_) => break,
                }
            })
        },
    );

    let click = |seq: u64, double: bool| RawEvent {
        sequence_id: seq,
        ..left_click(seq, 1000 + seq, ITEMS_VIEW, item_name_cell("a.txt"), double)
    };
    pool.dispatch(click(1, false)); // shortest queue: worker 0
    pool.dispatch(click(2, true)); // the pair's second: worker 0 again
    pool.dispatch(click(3, false)); // shortest queue: worker 1
    pool.dispatch(click(4, true)); // the pair's second: worker 1 again
    thread::sleep(Duration::from_millis(100));

    let at = |i: usize| received[i].lock().unwrap().clone();
    assert_eq!(at(0), vec![1, 2]);
    assert_eq!(at(1), vec![3, 4]);
    assert!(at(2).is_empty());
    pool.shutdown();
}

/// A middle-button press, which the mouse hook dispatches as a click marked
/// as the middle button's, confirms no dialog: a middle press on the Open
/// button writes no file_dialog, and one on an item reads no dialog.
#[test]
fn regression_692_a_middle_press_on_the_open_button_records_no_file_dialog() {
    let (backend, reads) = FileDialogBackend::showing("C:\\Users\\u\\Downloads", "license.txt");
    let harness = WorkerTestHarness::new(backend);

    let open_button = open_button();
    let middle = |seq: u64, element: ElementDescription| RawEvent {
        callback_params: [CLICK_IS_MIDDLE_BUTTON, 0, 0, 0],
        ..left_click(seq, 1000 + seq, ITEMS_VIEW, element, false)
    };
    harness.send_event(middle(1, open_button));
    harness.send_event(middle(2, item_name_cell("license.txt")));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(
        click_count(&events),
        2,
        "both presses are recorded as clicks"
    );
    assert!(
        file_dialogs(&events).is_empty(),
        "a middle press confirms nothing"
    );
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "a middle press reads no dialog"
    );
}

/// The File name test cannot tell a folder from a file of the same name: a
/// double-click on a folder whose name the File name already holds (typed
/// there earlier, for example) writes a file_dialog naming that folder, as
/// the desktop capture document's exception list states (DCP-13).
#[test]
fn a_double_click_on_a_folder_the_file_name_already_names_writes_a_file_dialog() {
    let (backend, _reads) = FileDialogBackend::showing("C:\\Users\\u\\Documents", "Invoices");
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(left_click(
        1,
        1000,
        ITEMS_VIEW,
        item_name_cell("Invoices"),
        false,
    ));
    harness.send_event(left_click(
        2,
        1160,
        ITEMS_VIEW,
        item_name_cell("Invoices"),
        true,
    ));

    thread::sleep(Duration::from_millis(200));
    let events = harness.shutdown();

    assert_eq!(click_count(&events), 2);
    assert_eq!(
        file_dialogs(&events),
        vec![(
            "open".to_string(),
            "C:\\Users\\u\\Documents\\Invoices".to_string(),
            "notepad.exe".to_string(),
            Some(OPEN_DIALOG),
            2,
        )]
    );
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

/// A key attributed to no window (a key the system takes while Docent's own
/// window is in front, DCP-14) is dispatched with window handle 0: there is no
/// window to introduce, so it takes no switch and introduces nothing, and the
/// next action in an introduced window takes none either.
#[test]
fn a_key_attributed_to_no_window_introduces_no_context() {
    const DOCENT: i64 = 777;
    let mut contexts = ContextIntroductions::default();
    // Notepad in front and introduced.
    let foreground = event_in(
        RawEventType::Foreground,
        NOTEPAD,
        0,
        (false, false, false, false),
    );
    assert!(!contexts.switch_before(&foreground, NOTEPAD, NOTEPAD));
    // The Windows key over Docent's window: no window, no switch.
    let win_key = event_in(
        RawEventType::Keyboard,
        0,
        0x5B,
        (false, false, false, false),
    );
    assert!(!contexts.switch_before(&win_key, 0, DOCENT));
    let e = event_in(RawEventType::Keyboard, 0, 0x45, (false, false, false, true));
    assert!(!contexts.switch_before(&e, 0, DOCENT));
    // Notepad, introduced before, needs no switch afterwards.
    let key = event_in(
        RawEventType::Keyboard,
        NOTEPAD,
        0x41,
        (false, false, false, false),
    );
    assert!(!contexts.switch_before(&key, NOTEPAD, NOTEPAD));
}

/// A press in the window in front switches nothing.
#[test]
fn a_press_in_the_window_in_front_switches_nothing() {
    let mut contexts = ContextIntroductions::default();
    assert!(!contexts.press_switches(NOTEPAD, NOTEPAD));
}

// ---------------------------------------------------------------------------
// Keys that enter a character, and repeated presses of a held key (docent#696)
// ---------------------------------------------------------------------------

/// Regression: a space typed through the keyboard layout inside a typing burst
/// was written as a `key` between two `type` actions, the first cut off at the
/// space. The space bar enters a character like any letter, so the field's
/// one `type` carries it.
#[test]
fn regression_696_a_space_typed_into_an_edit_field_stays_in_the_one_type() {
    let events = burst_through_busy_pool("hi you there", 3);
    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "got {events:?}"
    );
    assert_eq!(type_values_of(&events), vec!["hi you there".to_string()]);
}

/// A space pressed where no value change follows (a button, a checkbox) is
/// the `key` `Space`, in its place among the other keys.
#[test]
fn regression_696_a_space_with_no_value_change_is_the_key_space() {
    let events = burst_through_busy_pool("a b", 0);
    assert_eq!(key_names_of(&events), vec!["A", "Space", "B"]);
    assert_eq!(type_values_of(&events), Vec::<String>::new());
}

/// A key's modifiers: `(ctrl, shift, alt, meta)`.
type Mods = (bool, bool, bool, bool);
/// No modifier held.
const PLAIN: Mods = (false, false, false, false);
/// AltGr: the keyboard reports it as Ctrl and Alt held together.
const ALT_GR: Mods = (true, false, true, false);

/// A burst of layout keys, each with its modifiers, into an edit field holding `field_text`, with `value_changes` behind it.
fn layout_burst(keys: &[(u32, Mods)], field_text: &str, value_changes: usize) -> Vec<ActionEvent> {
    let gate = closed_gate();
    let (action_tx, action_rx) = mpsc::channel::<ActionEvent>();
    let worker_gate = Arc::clone(&gate);
    let field_text = field_text.to_string();
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
    for (key_code, modifiers) in keys {
        seq += 1;
        let mut raw = layout_key(seq, t, *key_code);
        raw.modifiers = *modifiers;
        pool.dispatch(raw);
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

/// The burst a numeric keypad types: `1`, `2`, the decimal key, `5`
/// (VK_NUMPAD1, VK_NUMPAD2, VK_DECIMAL, VK_NUMPAD5).
fn keypad_burst(field_text: &str, value_changes: usize) -> Vec<ActionEvent> {
    let keys = [0x61, 0x62, 0x6E, 0x65].map(|key_code| (key_code, PLAIN));
    layout_burst(&keys, field_text, value_changes)
}

/// Regression: a character typed with AltGr (`@` as AltGr+2 on many layouts)
/// and a layout key the name table has no name for (the extra key of an ISO
/// keyboard, VK_OEM_102) were written as keys that cut the field's `type` in
/// two, as the space was. Every key that enters a character is typing.
#[test]
fn regression_696_altgr_and_unnamed_layout_keys_stay_in_the_one_type() {
    // a, AltGr+2, b, VK_OEM_102.
    let keys = [(0x41, PLAIN), (0x32, ALT_GR), (0x42, PLAIN), (0xE2, PLAIN)];
    let events = layout_burst(&keys, "a@b<", 3);
    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "got {events:?}"
    );
    assert_eq!(type_values_of(&events), vec!["a@b<".to_string()]);
}

/// With no value change behind them the same keys are keys, in order, each
/// with the modifiers it was pressed with.
#[test]
fn regression_696_altgr_and_unnamed_layout_keys_with_no_value_change_are_keys() {
    let keys = [(0x41, PLAIN), (0x32, ALT_GR), (0xE2, PLAIN)];
    let events = layout_burst(&keys, "", 0);
    assert_eq!(key_names_of(&events), vec!["A", "2", "VK_0xE2"]);
}

/// A shortcut is no typing: Ctrl+S right behind typed keys is written at
/// once, behind the keys typed before it.
#[test]
fn a_shortcut_behind_typed_keys_is_a_key_in_its_place() {
    let ctrl = (true, false, false, false);
    let events = layout_burst(&[(0x41, PLAIN), (0x53, ctrl), (0x42, PLAIN)], "", 0);
    assert_eq!(key_names_of(&events), vec!["A", "S", "B"]);
}

/// Regression: a numeric-keypad key typed into an edit field was written as a
/// `key` that cut the field's `type` in two, as the space was.
#[test]
fn regression_696_keypad_keys_typed_into_an_edit_field_stay_in_the_one_type() {
    let events = keypad_burst("12.5", 3);
    assert_eq!(
        key_names_of(&events),
        Vec::<String>::new(),
        "got {events:?}"
    );
    assert_eq!(type_values_of(&events), vec!["12.5".to_string()]);
}

#[test]
fn regression_696_keypad_keys_with_no_value_change_are_keys_in_order() {
    let events = keypad_burst("", 0);
    assert_eq!(
        key_names_of(&events),
        vec!["Numpad1", "Numpad2", "Decimal", "Numpad5"]
    );
}

fn key_repeats_of(events: &[ActionEvent]) -> Vec<(String, bool)> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key { key, repeat, .. } => Some((key.clone(), *repeat)),
            _ => None,
        })
        .collect()
}

/// A key-down the hook marked as a repeat (the repeat mark in the fourth
/// callback parameter) is a `key` with `repeat` true; the press itself carries
/// false. Every press is written.
#[test]
fn regression_696_a_held_key_writes_every_press_and_marks_the_repeats() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let t = now_ms();
    // Enter pressed and held: the press, then two presses key repeat made.
    for (seq, repeat) in [(1, 0), (2, KEY_REPEAT_PARAM), (3, KEY_REPEAT_PARAM)] {
        let mut raw = layout_key(seq, t, 0x0D);
        raw.callback_params[3] = repeat;
        harness.send_event(raw);
    }
    // A buffered key (a letter with no value change) keeps its mark too.
    for (seq, repeat) in [(4, 0), (5, KEY_REPEAT_PARAM)] {
        let mut raw = layout_key(seq, t, 0x41);
        raw.callback_params[3] = repeat;
        harness.send_event(raw);
    }
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    assert_eq!(
        key_repeats_of(&events),
        vec![
            ("Enter".to_string(), false),
            ("Enter".to_string(), true),
            ("Enter".to_string(), true),
            ("A".to_string(), false),
            ("A".to_string(), true),
        ]
    );
}

fn key_codes_of(events: &[ActionEvent]) -> Vec<(String, Option<&'static str>)> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key { key, code, .. } => Some((key.clone(), *code)),
            _ => None,
        })
        .collect()
}

/// A `key` names the physical key that was pressed in `code`, read from the
/// hook's scan code and extended mark: the two Enter keys differ there, and a
/// key is named the same on every layout (docent#717).
#[test]
fn regression_717_a_key_names_the_physical_key_that_was_pressed() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let t = now_ms();
    // (virtual-key code, scan code, extended mark)
    let presses: [(u32, i64, bool); 5] = [
        (0x0D, 0x1C, false), // Enter
        (0x0D, 0x1C, true),  // Enter on the numeric keypad
        (0xBB, 0x0C, false), // the key right of 0 (`+` on a Danish layout)
        (0x25, 0x4B, true),  // the left arrow
        (0x25, 0x4B, false), // 4 on the numeric keypad with NumLock off
    ];
    for (i, (key_code, scan, extended)) in presses.into_iter().enumerate() {
        let mut raw = layout_key(i as u64 + 1, t, key_code);
        raw.callback_params[0] = scan | if extended { KEY_EXTENDED_PARAM } else { 0 };
        harness.send_event(raw);
    }
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    let codes: Vec<Option<&str>> = key_codes_of(&events).into_iter().map(|(_, c)| c).collect();
    // The field is written into the file under that name.
    let numpad_enter = events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Key { .. }))
        .nth(1)
        .expect("the second key");
    assert_eq!(
        serde_json::to_value(numpad_enter).unwrap()["code"],
        "NumpadEnter"
    );
    assert_eq!(
        codes,
        vec![
            Some("Enter"),
            Some("NumpadEnter"),
            Some("Minus"),
            Some("ArrowLeft"),
            Some("Numpad4"),
        ]
    );
}

/// A key attributed to no window (a key the system takes) was pressed on a
/// physical key like any other, and states it.
#[test]
fn regression_717_a_key_attributed_to_no_window_names_its_physical_key() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let mut raw = layout_key(1, now_ms(), 0x5B); // the left Windows key
    raw.window_handle = 0;
    raw.callback_params[0] = 0x5B | KEY_EXTENDED_PARAM;
    harness.send_event(raw);
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    let codes: Vec<Option<&str>> = key_codes_of(&events).into_iter().map(|(_, c)| c).collect();
    assert_eq!(codes, vec![Some("MetaLeft")]);
}

/// An injected character has no physical key (its scan code is the character's
/// code unit), and neither has a key the hook gave no scan code: the `key`
/// carries no `code`, and the field is left out of the file.
#[test]
fn regression_717_a_key_with_no_physical_key_carries_no_code() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let t = now_ms();
    harness.send_event(packet_key(1, t, 0x1C)); // a code unit that is also Enter's scan code
    harness.send_event(layout_key(2, t, 0x0D)); // Enter with scan code 0
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    let keys = key_codes_of(&events);
    assert_eq!(keys.len(), 2, "{keys:?}");
    assert!(keys.iter().all(|(_, code)| code.is_none()), "{keys:?}");
    for event in events
        .iter()
        .filter(|e| matches!(e.payload, ActionPayload::Key { .. }))
    {
        let json = serde_json::to_value(event).unwrap();
        assert!(json.get("code").is_none(), "{json}");
    }
}

// ---------------------------------------------------------------------------
// Typing keys on a control that takes no typed text (docent#696)
// ---------------------------------------------------------------------------

/// The dialog with one of its controls focused.
fn dialog_control(tag: &str, selector: &str) -> FocusScene {
    FocusScene {
        epoch: 1,
        foreground: DIALOG,
        element: scene_element(tag, selector, Some("")),
    }
}

/// A space pressed on a button is the key that presses it. A value change the
/// press causes elsewhere in the window (the field a "Clear" button empties)
/// is no typing into the button: it supersedes no key and is no `type`.
#[test]
fn regression_696_a_space_on_a_button_survives_a_value_change_in_its_window() {
    for (tag, selector) in [
        ("Button", "Dialog > Button:Clear"),
        ("CheckBox", "Dialog > CheckBox:Remember"),
        ("RadioButton", "Dialog > RadioButton:First"),
        ("Hyperlink", "Dialog > Hyperlink:More"),
        ("MenuItem", "Dialog > MenuItem:Open"),
        ("SplitButton", "Dialog > SplitButton:Paste"),
        ("TabItem", "Dialog > TabItem:General"),
    ] {
        let (backend, _scene, _) = MovingFocusBackend::new(dialog_control(tag, selector));
        let harness = WorkerTestHarness::new(backend);

        let t = now_ms();
        harness.send_event(in_dialog(layout_key(1, t, 0x20)));
        harness.send_event(in_dialog(value_change(2, t + 5, DIALOG)));

        thread::sleep(Duration::from_millis(900));
        let events = harness.shutdown();
        assert_eq!(
            typed_actions_of(&events),
            vec![format!("key Space on {selector}")],
            "got {events:?}"
        );
    }
}

/// A typing key on such a control is written at once: no value change can
/// make it text, so nothing is waited for.
#[test]
fn a_typing_key_on_a_button_is_written_without_waiting() {
    let (backend, _scene, _) =
        MovingFocusBackend::new(dialog_control("Button", "Dialog > Button:Seven"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(layout_key(1, t, 0x67))); // keypad 7
    harness.send_event(in_dialog(layout_key(2, t + 1, 0x20)));

    // Well inside KEY_TEXT_WAIT_MS (500 ms).
    thread::sleep(Duration::from_millis(200));
    let early = harness.drain_actions();
    assert_eq!(
        typed_actions_of(&early),
        vec![
            "key Numpad7 on Dialog > Button:Seven",
            "key Space on Dialog > Button:Seven"
        ],
        "got {early:?}"
    );
    harness.shutdown();
}

/// Enter on a button, and a value change its press causes elsewhere in the
/// window: the key, and no `type` on the button.
#[test]
fn a_value_change_behind_enter_on_a_button_is_no_type_on_the_button() {
    let (backend, _scene, _) =
        MovingFocusBackend::new(dialog_control("Button", "Dialog > Button:Clear"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(layout_key(1, t, 0x0D)));
    harness.send_event(in_dialog(value_change(2, t + 5, DIALOG)));

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    assert_eq!(
        typed_actions_of(&events),
        vec!["key Enter on Dialog > Button:Clear"],
        "got {events:?}"
    );
}

/// Keys buffered on one element are not superseded by typing into another:
/// a letter pressed on a pane (which may or may not take text), then, focus
/// having moved, a letter typed into a field whose value change follows. The
/// first is a key on the pane, the second the field's `type`.
#[test]
fn regression_696_keys_buffered_on_one_element_survive_typing_into_another() {
    let (backend, scene, _) =
        MovingFocusBackend::new(dialog_control("Pane", "Dialog > Pane:Board"));
    let harness = WorkerTestHarness::new(backend);

    let t = now_ms();
    harness.send_event(in_dialog(layout_key(1, t, 0x58))); // x, on the pane
    thread::sleep(Duration::from_millis(100));
    *scene.lock().unwrap() = FocusScene {
        epoch: 2,
        foreground: DIALOG,
        element: scene_element("Edit", "Dialog > Edit:Name", Some("a")),
    };
    let mut key = in_dialog(layout_key(2, t + 100, 0x41)); // a, in the field
    key.focus_epoch = 2;
    harness.send_event(key);
    let mut change = in_dialog(value_change(3, t + 105, DIALOG));
    change.focus_epoch = 2;
    harness.send_event(change);

    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    assert_eq!(
        typed_actions_of(&events),
        vec![
            "key X on Dialog > Pane:Board",
            "type a on Dialog > Edit:Name"
        ],
        "got {events:?}"
    );
}

// ---------------------------------------------------------------------------
// The keys that were down at an action (docent#706), and the modifiers held
// at a pointer action (docent#239)
// ---------------------------------------------------------------------------

use docent_desktop_lib::capture::held_keys::{
    input_method_param, HeldKeys, HeldPress, InputMethodState, KEY_EXTENDED_PARAM, KEY_REPEAT_PARAM,
};
use docent_desktop_lib::capture::HeldKeysAtAction;

/// Keys the hook found down at an event: `(key code, scan code, key-down)`.
fn held_presses(keys: &[(u32, u32, u64)]) -> Vec<HeldPress> {
    keys.iter()
        .map(|&(key_code, scan_code, press)| HeldPress {
            key_code,
            scan_code,
            press,
            layout_char: 0,
        })
        .collect()
}

/// What an action states about held keys: `(names, key-downs)`.
fn stated(names: &[&str], presses: &[u64]) -> HeldKeysAtAction {
    HeldKeysAtAction {
        held_keys: names.iter().map(|n| n.to_string()).collect(),
        held_presses: presses.to_vec(),
    }
}

/// Each action that states held keys, as `(type, modifiers, held)`.
fn held_statements_of(events: &[ActionEvent]) -> Vec<(&'static str, Mods, HeldKeysAtAction)> {
    let mods = |m: &Modifiers| (m.ctrl, m.shift, m.alt, m.meta);
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key {
                modifiers, held, ..
            } => Some(("key", mods(modifiers), held.clone())),
            ActionPayload::Click {
                modifiers, held, ..
            } => Some(("click", mods(modifiers), held.clone())),
            ActionPayload::RightClick {
                modifiers, held, ..
            } => Some(("right_click", mods(modifiers), held.clone())),
            ActionPayload::DragStart {
                modifiers, held, ..
            } => Some(("drag_start", mods(modifiers), held.clone())),
            ActionPayload::Drop {
                modifiers, held, ..
            } => Some(("drop", mods(modifiers), held.clone())),
            _ => None,
        })
        .collect()
}

/// Regression for docent#706: Tab pressed while Space was held down was
/// recorded like any Tab, so the Space that pressed nothing (its release went
/// to another element) read as a press of its button. A key states the keys
/// that were down at it, by the names their own key actions carry, in the
/// order they went down, each with the key-down it is down by.
#[test]
fn regression_706_a_key_states_the_keys_that_were_down_at_it() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let t = now_ms();
    let mut tab = layout_key(4, t, 0x09);
    tab.held = held_presses(&[
        (0x20, 0x39, 1),
        (VK_PACKET, u32::from(b'x'), 2),
        (VK_PACKET, u32::from(b' '), 3),
    ]);
    harness.send_event(tab);
    // A buffered key (a letter with no value change) states them too.
    let mut letter = layout_key(5, t, 0x41);
    letter.held = held_presses(&[(0x0D, 0x1C, 2)]);
    harness.send_event(letter);
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    assert_eq!(
        held_statements_of(&events),
        vec![
            ("key", PLAIN, stated(&["Space", "x", "Space"], &[1, 2, 3])),
            ("key", PLAIN, stated(&["Enter"], &[2])),
        ]
    );
}

/// Regression for docent#706 and docent#239: a click, a right-click and both
/// halves of a drag made with a key or a modifier held down were recorded like
/// plain ones. Each states the modifiers held and the keys that were down.
#[test]
fn regression_706_pointer_actions_state_modifiers_and_held_keys() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let ctrl_shift = (true, true, false, false);
    let pointer_events = [
        RawEventType::Click,
        RawEventType::RightClick,
        RawEventType::DragStart {
            source_coords: (10, 10),
        },
        RawEventType::Drop {
            source_coords: (10, 10),
        },
    ];
    for (i, event_type) in pointer_events.into_iter().enumerate() {
        let mut raw = make_raw_event(event_type, 100);
        raw.sequence_id = i as u64 + 10;
        raw.timestamp = now_ms();
        raw.modifiers = ctrl_shift;
        raw.held = held_presses(&[(0x20, 0x39, 3)]);
        harness.send_event(raw);
    }
    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();
    let space = stated(&["Space"], &[3]);
    assert_eq!(
        held_statements_of(&events),
        vec![
            ("click", ctrl_shift, space.clone()),
            ("right_click", ctrl_shift, space.clone()),
            ("drag_start", ctrl_shift, space.clone()),
            ("drop", ctrl_shift, space),
        ]
    );
}

/// docent#691 with docent#696: the layout character and the repeat mark share
/// the fourth callback parameter. A punctuation key pressed and then repeated
/// is named by its layout's character both times, and only the key-down key
/// repeat made is marked a repeat.
#[test]
fn regression_691_a_repeated_punctuation_key_is_named_by_its_layout_and_marked_repeat() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let t = now_ms();
    // Danish layout: VK_OEM_PLUS (0xBB) enters '+'.
    let mut press = layout_key(1, t, 0xBB);
    press.callback_params[3] = '+' as i64;
    harness.send_event(press);
    let mut repeat = layout_key(2, t, 0xBB);
    repeat.callback_params[3] = '+' as i64 | KEY_REPEAT_PARAM;
    harness.send_event(repeat);
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    assert_eq!(
        key_repeats_of(&events),
        vec![("+".to_string(), false), ("+".to_string(), true)]
    );
}

/// docent#691 with docent#706: a held key is named as its own key action
/// names it, so a punctuation key held down is named by the character its
/// layout gave it at its key-down, on a key pressed while it is held and on
/// the pointer actions made while it is held. Driven through the hook's
/// record, which stamps each event at its dispatch.
#[test]
fn regression_691_a_held_punctuation_key_is_named_by_its_layout_character() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let mut record = HeldKeys::new();
    let t = now_ms();
    let not_down = |_| false;
    // Danish '+' (VK_OEM_PLUS, scan code 0x0C) goes down and is dispatched.
    assert!(!record.on_hook_message(0x0100, 0xBB, 0x0C, not_down));
    let mut plus = layout_key(1, t, 0xBB);
    plus.callback_params = [0x0C, 0, 0, '+' as i64];
    record.stamp(&mut plus);
    harness.send_event(plus);
    // Tab pressed while it is held.
    assert!(!record.on_hook_message(0x0100, 0x09, 0x0F, not_down));
    let mut tab = layout_key(2, t, 0x09);
    tab.callback_params[0] = 0x0F;
    record.stamp(&mut tab);
    harness.send_event(tab);
    record.on_hook_message(0x0101, 0x09, 0x0F, not_down);
    // A click, a drag and its drop made while it is held.
    let mut click = make_raw_event(RawEventType::Click, 100);
    click.sequence_id = 3;
    click.timestamp = t;
    record.stamp(&mut click);
    harness.send_event(click);
    let mut drag_start = make_raw_event(
        RawEventType::DragStart {
            source_coords: (10, 10),
        },
        100,
    );
    drag_start.sequence_id = 4;
    drag_start.timestamp = t;
    // The mouse hook reads a drag start's keys at the threshold.
    drag_start.held = record.dispatched_down(None);
    harness.send_event(drag_start);
    let mut drop = make_raw_event(
        RawEventType::Drop {
            source_coords: (10, 10),
        },
        100,
    );
    drop.sequence_id = 5;
    drop.timestamp = t;
    record.stamp(&mut drop);
    harness.send_event(drop);
    thread::sleep(Duration::from_millis(900));
    let events = harness.shutdown();
    let plus_held = stated(&["+"], &[1]);
    assert_eq!(
        held_statements_of(&events),
        vec![
            ("key", PLAIN, stated(&[], &[])),
            ("key", PLAIN, plus_held.clone()),
            ("click", PLAIN, plus_held.clone()),
            ("drag_start", PLAIN, plus_held.clone()),
            ("drop", PLAIN, plus_held),
        ]
    );
}

/// An action with no key down states so: `held_keys` is written, empty, and
/// the key-downs (internal to the frontend's filter) are not.
#[test]
fn an_action_with_no_key_down_writes_an_empty_held_keys() {
    let harness = WorkerTestHarness::new(MockBackend::new());
    let mut click = make_raw_event(RawEventType::Click, 100);
    click.sequence_id = 1;
    click.timestamp = now_ms();
    harness.send_event(click);
    let mut enter = layout_key(2, now_ms(), 0x0D);
    enter.held = held_presses(&[(0x20, 0x39, 1)]);
    harness.send_event(enter);
    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();
    let written: Vec<serde_json::Value> = events
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .filter(|v| v["type"] == "click" || v["type"] == "key")
        .collect();
    assert_eq!(written.len(), 2, "got {written:?}");
    assert_eq!(written[0]["held_keys"], serde_json::json!([]));
    assert!(written[0].get("held_presses").is_none(), "{:?}", written[0]);
    assert_eq!(
        written[0]["modifiers"],
        serde_json::json!({"ctrl": false, "shift": false, "alt": false, "meta": false})
    );
    assert_eq!(written[1]["held_keys"], serde_json::json!(["Space"]));
    assert_eq!(written[1]["held_presses"], serde_json::json!([1]));
    // The payload's own grouping is not part of what is written.
    assert!(written[1].get("held").is_none(), "{:?}", written[1]);
}

// ---------------------------------------------------------------------------
// A typed value is taken only when it was read in time (docent#761)
// ---------------------------------------------------------------------------
//
// The Input_Thread numbers the keys it dispatches per window. A value read
// for a value change is taken only while no later key of the window was
// dispatched by the time the read finished; the `type` keeps the last value
// taken, and the keys after it are written as keys after it.

/// The file-name field's selector, as the `type` and `key` actions name it.
const IN_FIELD: &str = "on Dialog > Edit:File name";

/// A key typed into the dialog's field, numbered `number` among the dialog's
/// keys.
fn numbered_in_field(raw: RawEvent, number: u64) -> RawEvent {
    let mut raw = in_field(raw);
    raw.callback_params[3] |= key_number_param(number);
    raw
}

/// The field's controls, with the value reads the test scripts.
fn field_with_reads(reads: &[(&'static str, u64)]) -> Controls {
    Controls {
        reads: reads.iter().copied().collect(),
        ..field_controls("")
    }
}

/// `a`, `a`, Backspace typed into the field, each key followed by the value
/// change it caused, the reads answering as `reads` scripts.
fn type_aa_backspace(reads: &[(&'static str, u64)]) -> Vec<String> {
    let (backend, _scene, _queries, _controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_with_reads(reads));
    let harness = WorkerTestHarness::new(backend);
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(1, t, u16::from(b'a')), 1));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    harness.send_event(numbered_in_field(packet_key(3, t + 2, u16::from(b'a')), 2));
    harness.send_event(control_value_change(4, t + 3, FIELD));
    harness.send_event(numbered_in_field(layout_key(5, t + 4, 0x08), 3)); // Backspace
    harness.send_event(control_value_change(6, t + 5, FIELD));
    thread::sleep(Duration::from_millis(300));
    typed_actions_of(&harness.shutdown())
}

/// `field` the actions, each as `typed_actions_of` writes it.
fn on_field(actions: &[&str]) -> Vec<String> {
    actions.iter().map(|a| format!("{a} {IN_FIELD}")).collect()
}

// Regression: #761 — the value of the second `a` was read after the
// Backspace had landed, and the `type` written at the Backspace held "a"
// where the person had "aa".
// https://github.com/Arsarneq/docent/issues/761
#[test]
fn regression_761_a_value_read_after_a_later_key_is_not_the_type() {
    let actions = type_aa_backspace(&[
        ("a", 1), // read before the second `a` was dispatched
        ("a", 3), // read after the Backspace was dispatched
        ("a", 3), // the Backspace's own change, read in time
    ]);
    assert_eq!(
        actions,
        on_field(&["type a", "key a", "key Backspace"]),
        "the type keeps the value read in time; the key after it is a key"
    );
}

/// The issue's runs: every read of the run was made after the Backspace was
/// dispatched (the first value change waited on the field's description). No
/// value was read in time, so every key is a key, none dropped or doubled;
/// the Backspace's own change, read in time, is the field's next `type`.
#[test]
fn regression_761_a_run_with_no_value_read_in_time_is_its_keys() {
    let actions = type_aa_backspace(&[("a", 3), ("a", 3), ("a", 3)]);
    assert_eq!(
        actions,
        on_field(&["key a", "key a", "key Backspace", "type a"])
    );
}

/// KNOWN OPEN CASE, not the behavior wanted (docent#762): the program raised
/// the value change of the first `a` only after the second `a` was
/// dispatched, and the read, made before the Backspace, found the second `a`
/// not yet applied. The read counts (no key after the second `a` had been
/// dispatched), so the `type` holds "a"; the second `a` is in neither the
/// `type` nor a `key`. The worker has nothing that tells this read from one
/// that holds the second `a`. Pinned so a change to it is seen; a value
/// source exact as of the change closes it.
#[test]
fn open_case_762_a_value_read_in_time_can_lack_the_last_key_before_it() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("a", 2), ("a", 3)]),
    );
    let harness = WorkerTestHarness::new(backend);
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(1, t, u16::from(b'a')), 1));
    harness.send_event(numbered_in_field(packet_key(2, t + 1, u16::from(b'a')), 2));
    harness.send_event(control_value_change(3, t + 2, FIELD)); // raised for the first `a`
    harness.send_event(numbered_in_field(layout_key(4, t + 3, 0x08), 3)); // Backspace
    harness.send_event(control_value_change(5, t + 4, FIELD)); // raised for the second `a`
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        typed_actions_of(&harness.shutdown()),
        on_field(&["type a", "key Backspace"]),
        "the open case: the second `a` is recorded nowhere"
    );
}

/// Keys are numbered per window: a key pressed in another window before the
/// field's value was read makes the read no later, and the value is the
/// field's `type`.
#[test]
fn a_key_in_another_window_leaves_a_read_in_time() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        Controls {
            latest_keys: HashMap::from([(OTHER_WINDOW, 2)]),
            ..field_with_reads(&[("a", 1)])
        },
    );
    let harness = WorkerTestHarness::new(backend);
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(1, t, u16::from(b'a')), 1));
    harness.send_event(control_value_change(2, t + 1, FIELD)); // read after `x`
    let mut x = packet_key(3, t + 2, u16::from(b'x'));
    x.window_handle = OTHER_WINDOW;
    x.focus_epoch = 1;
    x.callback_params[3] |= key_number_param(2);
    harness.send_event(x);
    thread::sleep(Duration::from_millis(300));
    let field: Vec<String> = typed_actions_of(&harness.shutdown())
        .into_iter()
        .filter(|a| a.ends_with(IN_FIELD))
        .collect();
    assert_eq!(field, on_field(&["type a"]));
}

/// A value read late in the middle of a run splits nothing: the next value
/// read in time supersedes the keys kept after the late one, and the field
/// has one `type`.
#[test]
fn a_late_read_followed_by_a_read_in_time_leaves_one_type() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("a", 2), ("ab", 2)]),
    );
    let harness = WorkerTestHarness::new(backend);
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(1, t, u16::from(b'a')), 1));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    harness.send_event(numbered_in_field(packet_key(3, t + 2, u16::from(b'b')), 2));
    harness.send_event(control_value_change(4, t + 3, FIELD));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        typed_actions_of(&harness.shutdown()),
        on_field(&["type ab"])
    );
}

/// The keys kept after the value read in time survive a commit or a stop: the
/// drain writes them after the `type`.
#[test]
fn keys_kept_after_the_type_are_written_by_a_drain() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("a", 1), ("ab", 3)]),
    );
    let harness = WorkerTestHarness::new(backend);
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(1, t, u16::from(b'a')), 1));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    harness.send_event(numbered_in_field(packet_key(3, t + 2, u16::from(b'b')), 2));
    harness.send_event(control_value_change(4, t + 3, FIELD));
    thread::sleep(Duration::from_millis(300));
    harness.flush();
    assert_eq!(
        typed_actions_of(&harness.drain_actions()),
        on_field(&["type a", "key b"])
    );
    harness.shutdown();
}

/// A pause ends nothing for kept keys either: they had a value change, so the
/// wait for keys that took no text does not write them, and a value read in
/// time after the pause makes them part of the one `type`, not doubled.
#[test]
fn keys_kept_after_the_type_wait_through_a_pause() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("a", 1), ("ab", 3), ("abc", 3)]),
    );
    let harness = WorkerTestHarness::new(backend);
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(1, t, u16::from(b'a')), 1));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    harness.send_event(numbered_in_field(packet_key(3, t + 2, u16::from(b'b')), 2));
    harness.send_event(control_value_change(4, t + 3, FIELD));
    thread::sleep(Duration::from_millis(900));
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(5, t, u16::from(b'c')), 3));
    harness.send_event(control_value_change(6, t + 1, FIELD));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        typed_actions_of(&harness.shutdown()),
        on_field(&["type abc"])
    );
}

/// The same rule where the key's element is described by focus: a value
/// read after a later key of the window was dispatched is not taken.
#[test]
fn regression_761_a_value_described_after_a_later_key_is_not_the_type() {
    let (backend, _scene, _queries, controls) = MovingFocusBackend::with_controls(
        FocusScene {
            epoch: 1,
            foreground: DIALOG,
            element: scene_element("Edit", "Dialog > Edit:Name", Some("a")),
        },
        Controls {
            latest_keys: HashMap::from([(DIALOG, 3)]),
            ..Default::default()
        },
    );
    let harness = WorkerTestHarness::new(backend);
    let numbered = |raw: RawEvent, number: u64| {
        let mut raw = in_dialog(raw);
        raw.callback_params[3] |= key_number_param(number);
        raw
    };
    let t = now_ms();
    harness.send_event(numbered(packet_key(1, t, u16::from(b'a')), 1));
    harness.send_event(in_dialog(value_change(2, t + 1, DIALOG)));
    harness.send_event(numbered(packet_key(3, t + 2, u16::from(b'a')), 2));
    harness.send_event(in_dialog(value_change(4, t + 3, DIALOG)));
    harness.send_event(numbered(layout_key(5, t + 4, 0x08), 3)); // Backspace
    harness.send_event(in_dialog(value_change(6, t + 5, DIALOG)));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        typed_actions_of(&harness.shutdown()),
        vec![
            "key a on Dialog > Edit:Name",
            "key a on Dialog > Edit:Name",
            "key Backspace on Dialog > Edit:Name",
            "type a on Dialog > Edit:Name"
        ]
    );
    drop(controls);
}

// ---------------------------------------------------------------------------
// The focused control is looked at ahead of its keys (docent#761)
// ---------------------------------------------------------------------------

/// Capture started, or a window came to the front: the typing worker looks at
/// the control that holds the focus, so the first key typed into it takes no
/// description, and the field's first value is read without waiting on one.
/// The key only looks again at what the control is.
#[test]
fn the_focused_control_is_described_ahead_of_its_first_key() {
    let (backend, _scene, queries, controls) =
        MovingFocusBackend::with_controls(save_button_focused(), field_controls("c"));
    let harness = WorkerTestHarness::new(backend);
    harness.event_tx.send(WorkerMessage::LookAtFocus).unwrap();
    thread::sleep(Duration::from_millis(150));
    assert_eq!(
        controls.lock().unwrap().descriptions,
        1,
        "described on the look"
    );

    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'c'))));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    thread::sleep(Duration::from_millis(300));
    let events = harness.shutdown();

    assert_eq!(typed_actions_of(&events), on_field(&["type c"]));
    let controls = controls.lock().unwrap();
    assert_eq!(controls.descriptions, 1, "the key took no description");
    assert_eq!(controls.nature_looks, 1, "the key looked at what it is");
    assert_eq!(queries.load(Ordering::SeqCst), 0);
}

/// A look with no focused control, or at a control already known, describes
/// nothing.
#[test]
fn a_look_with_nothing_new_in_focus_describes_nothing() {
    let (backend, _scene, _queries, controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        Controls {
            focused: 0,
            ..field_controls("c")
        },
    );
    let harness = WorkerTestHarness::new(backend);
    harness.event_tx.send(WorkerMessage::LookAtFocus).unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(controls.lock().unwrap().descriptions, 0);
    controls.lock().unwrap().focused = FIELD;
    harness.event_tx.send(WorkerMessage::LookAtFocus).unwrap();
    harness.event_tx.send(WorkerMessage::LookAtFocus).unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(controls.lock().unwrap().descriptions, 1);
    assert!(harness.shutdown().is_empty(), "a look writes nothing");
}

/// A look at a control whose program answers no message in time describes
/// nothing: no key waits on the look, and the first key describes the
/// control itself.
#[test]
fn a_look_at_a_control_whose_program_answers_late_describes_nothing() {
    let (backend, _scene, _queries, controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        Controls {
            hung: true,
            ..field_controls("c")
        },
    );
    let harness = WorkerTestHarness::new(backend);
    harness.event_tx.send(WorkerMessage::LookAtFocus).unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(controls.lock().unwrap().descriptions, 0);
    let t = now_ms();
    harness.send_event(in_field(packet_key(1, t, u16::from(b'c'))));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(typed_actions_of(&harness.shutdown()), on_field(&["type c"]));
    assert_eq!(
        controls.lock().unwrap().descriptions,
        1,
        "the key described it"
    );
}

/// A look at a control of the excluded process (Docent's own window in
/// front) describes nothing.
#[test]
fn a_look_at_a_control_of_the_excluded_process_describes_nothing() {
    let (backend, _scene, _queries, controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        Controls {
            process_id: 42,
            ..field_controls("c")
        },
    );
    let harness = WorkerTestHarness::new(backend);
    harness._excluded_pid.store(42, Ordering::SeqCst);
    harness.event_tx.send(WorkerMessage::LookAtFocus).unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(controls.lock().unwrap().descriptions, 0);
    harness._excluded_pid.store(7, Ordering::SeqCst);
    harness.event_tx.send(WorkerMessage::LookAtFocus).unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        controls.lock().unwrap().descriptions,
        1,
        "another process excluded"
    );
    harness.shutdown();
}

/// `type` and `key` actions as `typed_actions_of` writes them, in the order
/// the recording holds them: by sequence id, as the frontend orders them
/// (DCP-2), the `type` under the id of its last value change.
fn typed_in_recorded_order(events: &[ActionEvent]) -> Vec<String> {
    let mut events: Vec<&ActionEvent> = events.iter().collect();
    events.sort_by_key(|e| e.sequence_id);
    typed_actions_of(&events.into_iter().cloned().collect::<Vec<_>>())
}

/// `1` read in time, `5` read only after `x` was dispatched, and `x`, which
/// the field refused (no value change), sent into the field.
fn one_five_refused_x(harness: &WorkerTestHarness) {
    let t = now_ms();
    harness.send_event(numbered_in_field(packet_key(1, t, u16::from(b'1')), 1));
    harness.send_event(control_value_change(2, t + 1, FIELD));
    harness.send_event(numbered_in_field(packet_key(3, t + 2, u16::from(b'5')), 2));
    harness.send_event(control_value_change(4, t + 3, FIELD)); // read after `x`
    harness.send_event(numbered_in_field(packet_key(5, t + 4, u16::from(b'x')), 3));
}

/// A key that got no value change, buffered behind a kept key, is written
/// once the wait for keys that took no text has passed, and the commit then
/// writes the `type` and the kept key: every key once.
#[test]
fn a_key_with_no_value_change_behind_a_kept_key_is_written_after_the_wait() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("1", 1), ("15", 3)]),
    );
    let harness = WorkerTestHarness::new(backend);
    one_five_refused_x(&harness);
    thread::sleep(Duration::from_millis(1200));
    let mut events = harness.drain_actions();
    assert_eq!(
        typed_actions_of(&events),
        on_field(&["key x"]),
        "the wait writes `x` alone"
    );
    harness.flush();
    events.extend(harness.drain_actions());
    harness.shutdown();
    assert_eq!(
        typed_in_recorded_order(&events),
        on_field(&["type 1", "key 5", "key x"])
    );
}

/// The same keys drained by a commit before the wait has passed: the drain
/// writes the `type`, the kept key and the key behind it.
#[test]
fn a_commit_writes_every_buffered_key_behind_the_type() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("1", 1), ("15", 3)]),
    );
    let harness = WorkerTestHarness::new(backend);
    one_five_refused_x(&harness);
    thread::sleep(Duration::from_millis(150));
    harness.flush();
    let events = harness.drain_actions();
    harness.shutdown();
    assert_eq!(
        typed_in_recorded_order(&events),
        on_field(&["type 1", "key 5", "key x"])
    );
}

/// And by a stop.
#[test]
fn a_stop_writes_every_buffered_key_behind_the_type() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("1", 1), ("15", 3)]),
    );
    let harness = WorkerTestHarness::new(backend);
    one_five_refused_x(&harness);
    assert_eq!(
        typed_in_recorded_order(&harness.shutdown()),
        on_field(&["type 1", "key 5", "key x"])
    );
}

/// KNOWN OPEN CASE, not the behavior wanted (docent#762): a value change no
/// buffered key carries the text of (a paste, an accepted suggestion, a
/// composed character), read only after a later key was dispatched, is not
/// taken, and no key carries its text: the pasted text is recorded nowhere.
/// Taking the late value could record a value the person never had.
#[test]
fn open_case_762_a_pasted_value_read_late_is_recorded_nowhere() {
    let (backend, _scene, _queries, _controls) = MovingFocusBackend::with_controls(
        save_button_focused(),
        field_with_reads(&[("pasted", 2)]),
    );
    let harness = WorkerTestHarness::new(backend);
    let t = now_ms();
    let mut ctrl_v = numbered_in_field(layout_key(1, t, 0x56), 1);
    ctrl_v.modifiers = (true, false, false, false);
    harness.send_event(ctrl_v);
    harness.send_event(control_value_change(2, t + 1, FIELD)); // read after Enter
    harness.send_event(numbered_in_field(layout_key(3, t + 2, 0x0D), 2)); // Enter
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        typed_actions_of(&harness.shutdown()),
        on_field(&["key V", "key Enter"]),
        "the open case: the pasted text is recorded nowhere"
    );
}

/// The `type` and `key` actions of a recording, each as one word and its
/// text, in the order they were written.
fn types_and_keys(events: &[ActionEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Type { value, .. } => Some(format!("type {value}")),
            ActionPayload::Key { key, .. } => Some(format!("key {key}")),
            _ => None,
        })
        .collect()
}

#[test]
fn a_key_ahead_of_a_waiting_dead_key_is_written_once_when_its_value_comes_after_the_typing_ends() {
    // X, a dead key, the typing ends (a click), and only then the program
    // reports X's text. The dead key is a key: no character followed it. X is
    // the text of the `type`, and is not written as a key beside it.
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x58)));
    harness.send_event(dead_key(2));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("x".to_string());
        scene.element.value = Some("x".to_string());
    }
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["key \u{b4}", "type x"]
    );
}

#[test]
fn a_value_change_of_an_earlier_key_leaves_a_waiting_dead_key_to_be_written() {
    // C, a dead key, then C's value change, then the typing ends. The dead
    // key entered nothing; the value change is C's.
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x43)));
    harness.send_event(dead_key(2));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("c".to_string());
        scene.element.value = Some("c".to_string());
    }
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["type c", "key \u{b4}"]
    );
}

#[test]
fn a_value_reported_again_behind_a_waiting_dead_key_leaves_it_to_be_written() {
    // C and its value change, a dead key, then the program reports the same
    // value once more, then the typing ends.
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x43)));
    {
        let mut scene = scene.lock().unwrap();
        scene.element.text = Some("c".to_string());
        scene.element.value = Some("c".to_string());
    }
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(dead_key(3));
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["type c", "key \u{b4}"]
    );
}

/// A dead key as the hook read it for the press itself: the layout asked
/// about the key with the modifiers held (docent#769).
fn dead_key_as_pressed(seq: u64, modifiers: (bool, bool, bool, bool), dead: bool) -> RawEvent {
    key_as_pressed(seq, modifiers, dead.then_some('\u{60}'))
}

/// The same with the accent the layout named for the press: `None` for a key
/// that is no dead key as pressed.
fn key_as_pressed(seq: u64, modifiers: (bool, bool, bool, bool), accent: Option<char>) -> RawEvent {
    use docent_desktop_lib::capture::held_keys::{dead_as_pressed_param, AsPressed};
    let mut key = dead_key(seq);
    key.modifiers = modifiers;
    key.callback_params[3] |= dead_as_pressed_param(Some(match accent {
        Some(accent) => AsPressed::DeadKey {
            accent: accent as u16,
        },
        None => AsPressed::NoDeadKey,
    }));
    key
}

/// Set the value the dialog's field holds.
fn field_holds(scene: &std::sync::Mutex<FocusScene>, value: &str) {
    let mut scene = scene.lock().unwrap();
    scene.element.text = Some(value.to_string());
    scene.element.value = Some(value.to_string());
}

/// A dead key pressed twice: the program enters both accents as characters
/// at the second press. The `type` holds them, and neither press is a `key`
/// beside it (docent#769).
#[test]
fn regression_769_a_dead_key_pressed_twice_is_the_text_the_program_enters() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(900));
    harness.send_event(dead_key(2));
    field_holds(&scene, "\u{b4}\u{b4}");
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["type \u{b4}\u{b4}"]
    );
}

/// The same where the second press is a key dead with Shift (the grave
/// accent on the Danish acute key): both accents are in the `type`
/// (docent#769).
#[test]
fn regression_769_a_dead_key_and_a_shifted_dead_key_are_the_text_the_program_enters() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(key_as_pressed(
        2,
        (false, true, false, false),
        Some('\u{60}'),
    ));
    field_holds(&scene, "\u{b4}\u{60}");
    harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["type \u{b4}\u{60}"]
    );
}

/// A dead key pressed three times: the first two are the text the program
/// entered at the second press, and the third still waits for the key after
/// it. With no such key it is a `key` when the typing ends.
#[test]
fn a_dead_key_pressed_a_third_time_waits_behind_the_text_of_the_first_two() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(dead_key(1));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(dead_key(2));
    harness.send_event(dead_key(3));
    thread::sleep(Duration::from_millis(150));
    field_holds(&scene, "\u{b4}\u{b4}");
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["type \u{b4}\u{b4}", "key \u{b4}"]
    );
}

/// A dead key and then a key that is no typing key, in a program that enters
/// nothing for the two (Tab in a dialog moves the focus): both are keys, in
/// the order pressed, once the wait for a value change is over.
#[test]
fn a_dead_key_and_a_key_that_enters_nothing_are_keys_in_the_order_pressed() {
    let (backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(dead_key(1));
    harness.send_event(in_dialog(layout_key(2, now_ms(), 0x09)));
    thread::sleep(Duration::from_millis(900));
    let mut written = Vec::new();
    while let Ok(event) = harness.action_rx.try_recv() {
        written.push(event);
    }
    assert_eq!(
        types_and_keys(&written),
        vec!["key \u{b4}", "key Tab"],
        "written at the wait, before the recording stops"
    );
    assert!(types_and_keys(&harness.shutdown()).is_empty());
}

/// The same where the person clicks before the wait is over: the two keys
/// are written ahead of the click, in the order pressed.
#[test]
fn a_dead_key_and_the_key_behind_it_are_written_ahead_of_a_click() {
    let (backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(dead_key(1));
    harness.send_event(in_dialog(layout_key(2, now_ms(), 0x09)));
    harness.send_event(click_on("Button"));
    let events = harness.shutdown();
    let order: Vec<String> = events
        .iter()
        .filter_map(|e| match &e.payload {
            ActionPayload::Key { key, .. } => Some(format!("key {key}")),
            ActionPayload::Click { .. } => Some("click".to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(order, vec!["key \u{b4}", "key Tab", "click"]);
}

/// A dead key, a key that is no typing key, and a value that holds no more
/// of the accent than before (the program took the key and dropped the
/// accent): the dead key entered nothing and is a `key`, ahead of the key
/// behind it.
#[test]
fn a_dead_key_whose_accent_the_program_does_not_enter_is_a_key() {
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x43)));
    field_holds(&scene, "c");
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(dead_key(3));
    harness.send_event(in_dialog(layout_key(4, now_ms(), 0x09)));
    field_holds(&scene, "c\t");
    harness.send_event(in_dialog(value_change(5, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(900));
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["type c", "key \u{b4}", "key Tab", "type c\t"]
    );
}

/// A field that held the accent already: the value after the dead key and
/// Tab holds one more of it, so the dead key is text; a value that holds as
/// many as before leaves it a `key`.
#[test]
fn a_dead_key_is_text_only_where_the_field_gained_its_accent() {
    for (after, expected) in [
        ("\u{b4}\u{b4}\t", vec!["key Tab", "type \u{b4}\u{b4}\t"]),
        ("\u{b4}\t", vec!["key \u{b4}", "key Tab", "type \u{b4}\t"]),
    ] {
        let (backend, scene, _) = MovingFocusBackend::new(file_name_field("\u{b4}"));
        field_holds(&scene, "\u{b4}");
        let harness = WorkerTestHarness::new(backend);
        harness.send_event(dead_key(1));
        thread::sleep(Duration::from_millis(150));
        harness.send_event(in_dialog(layout_key(2, now_ms(), 0x09)));
        field_holds(&scene, after);
        harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(900));
        assert_eq!(types_and_keys(&harness.shutdown()), expected, "{after:?}");
    }
}

#[test]
fn a_key_that_is_dead_only_unshifted_is_no_dead_key_when_pressed_with_shift() {
    // The layout marks the key as dead for the press with no modifier. With
    // Shift it enters a character of its own (the German `^` key enters `°`),
    // so its value change makes it text and it is not written as a key. This
    // holds where the hook asked about the press (and was told it is not
    // dead) and where it could not ask.
    for asked in [true, false] {
        let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
        let harness = WorkerTestHarness::new(backend);
        let key = if asked {
            dead_key_as_pressed(1, (false, true, false, false), false)
        } else {
            let mut key = dead_key(1);
            key.modifiers = (false, true, false, false);
            key
        };
        harness.send_event(key);
        {
            let mut scene = scene.lock().unwrap();
            scene.element.text = Some("\u{b0}".to_string());
            scene.element.value = Some("\u{b0}".to_string());
        }
        harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
        thread::sleep(Duration::from_millis(900));
        harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
        assert_eq!(
            types_and_keys(&harness.shutdown()),
            vec!["type \u{b0}"],
            "asked: {asked}"
        );
    }
}

/// A key that is dead with Shift or with AltGr held (the Danish acute key
/// with Shift is the grave accent, the diaeresis key with AltGr the tilde) is
/// a dead key as much as with no modifier: it waits for the key after it
/// however long the person takes, and is part of that key's text, with no
/// `key` beside it (docent#769).
#[test]
fn regression_769_a_key_dead_with_shift_or_altgr_is_text_when_the_next_key_enters_text() {
    for (name, modifiers, text) in [
        ("Shift", (false, true, false, false), "\u{e8}"),
        ("AltGr", (true, false, true, false), "\u{f1}"),
    ] {
        let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
        let harness = WorkerTestHarness::new(backend);

        harness.send_event(dead_key_as_pressed(1, modifiers, true));
        thread::sleep(Duration::from_millis(900));
        harness.send_event(in_dialog(layout_key(2, now_ms(), 0x45)));
        {
            let mut scene = scene.lock().unwrap();
            scene.element.text = Some(text.to_string());
            scene.element.value = Some(text.to_string());
        }
        harness.send_event(in_dialog(value_change(3, now_ms(), DIALOG)));

        thread::sleep(Duration::from_millis(900));
        assert_eq!(
            types_and_keys(&harness.shutdown()),
            vec![format!("type {text}")],
            "{name}"
        );
    }
}

/// A key the layout marks dead with no modifier, pressed with a modifier that
/// makes it an ordinary character (the Danish acute key with AltGr enters
/// `|`), is no dead key: with no value change it is written as a `key` after
/// the wait, not held for the key after it (docent#769).
#[test]
fn regression_769_a_key_not_dead_as_pressed_is_an_ordinary_key() {
    let (backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);

    harness.send_event(dead_key_as_pressed(1, (true, false, true, false), false));
    thread::sleep(Duration::from_millis(900));
    let written_at_the_wait = types_and_keys(&harness.shutdown());
    assert_eq!(written_at_the_wait, vec!["key \u{b4}"]);
}

#[test]
fn a_key_that_took_no_text_is_written_ahead_of_the_dead_key_behind_it_when_the_typing_ends() {
    // X and a dead key in a control that reports no value change, a pause
    // longer than the wait, then the typing ends (a click). Both are keys,
    // written in the order they were pressed, and before what ended the
    // typing.
    let (backend, _scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x58)));
    harness.send_event(dead_key(2));
    thread::sleep(Duration::from_millis(900));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    thread::sleep(Duration::from_millis(30));
    assert_eq!(
        types_and_keys(&harness.drain_actions()),
        vec!["key X", "key \u{b4}"]
    );
    harness.shutdown();
}

#[test]
fn a_value_reported_again_while_only_a_dead_key_waits_is_no_second_type() {
    // C and its value, a dead key, a value change that gives no value (it
    // writes the `type` and keeps the keys), and then the program reports the
    // field's value once more. Only the dead key is buffered, and it enters
    // nothing, so the report is a repeat and no text typed over itself.
    let set_value = |scene: &Arc<Mutex<FocusScene>>, value: Option<&str>| {
        let mut scene = scene.lock().unwrap();
        scene.element.text = value.map(str::to_string);
        scene.element.value = value.map(str::to_string);
    };
    let (backend, scene, _) = MovingFocusBackend::new(file_name_field(""));
    let harness = WorkerTestHarness::new(backend);
    harness.send_event(in_dialog(layout_key(1, now_ms(), 0x43)));
    set_value(&scene, Some("c"));
    harness.send_event(in_dialog(value_change(2, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.send_event(dead_key(3));
    set_value(&scene, None);
    harness.send_event(in_dialog(value_change(4, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    set_value(&scene, Some("c"));
    harness.send_event(in_dialog(value_change(5, now_ms(), DIALOG)));
    thread::sleep(Duration::from_millis(150));
    harness.event_tx.send(WorkerMessage::EndTyping).unwrap();
    assert_eq!(
        types_and_keys(&harness.shutdown()),
        vec!["type c", "key \u{b4}"]
    );
}
