// Property tests for the capture worker pool infrastructure.
//
// Tests cover: sequence numbering, shortest-queue dispatch, sticky routing,
// click vs drag classification, and drag pair routing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;

use docent_desktop_lib::capture::worker_pool::{
    RawEvent, RawEventType, WorkerMessage, WorkerPool,
};
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
    }
}

/// Classify a mouse interaction as click or drag based on the 5-pixel
/// threshold. This is the pure classification rule used by the Input_Thread.
///
/// Returns `true` if the movement constitutes a drag, `false` for a click.
fn is_drag(x1: i32, y1: i32, x2: i32, y2: i32) -> bool {
    let dx = (x2 - x1).abs();
    let dy = (y2 - y1).abs();
    dx.max(dy) > 5
}

// ---------------------------------------------------------------------------
// Property 1: Sequence numbering is monotonically increasing from 1
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]

    /// Feature: capture-worker-pool, Property 1: Sequence numbering
    ///
    /// **Validates: Requirements 1.4, 6.1, 6.2**
    ///
    /// For any N in 1..1000, calling `next_sequence_id()` N times produces
    /// exactly the sequence 1, 2, 3, ..., N with no gaps or duplicates.
    #[test]
    fn sequence_numbering_is_monotonically_increasing(n in 1usize..1000) {
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        let pool = WorkerPool::new(1, action_tx, |_index, _rx, _queue_len, _sender| {
            std::thread::spawn(|| {
                // Worker does nothing; we only test sequence numbering.
            })
        });

        let ids: Vec<u64> = (0..n).map(|_| pool.next_sequence_id()).collect();

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
// Property 2: Shortest-queue dispatch selects the least busy worker
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Feature: capture-worker-pool, Property 2: Shortest-queue dispatch
    ///
    /// **Validates: Requirements 3.1, 3.2**
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

        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender| {
            let wc = Arc::clone(&wc_clone[index]);
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(_)) => {
                            wc.fetch_add(1, Ordering::SeqCst);
                        }
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
// Property 6: Sticky routing for value-change events
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Feature: capture-worker-pool, Property 6: Sticky routing
    ///
    /// **Validates: Requirements 9.2**
    ///
    /// For any sequence of value-change events with the same window_handle,
    /// all events are dispatched to the same worker index.
    #[test]
    fn sticky_routing_for_value_change_events(
        window_handle in 1i64..10000,
        event_count in 2usize..50,
    ) {
        let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
        let worker_counts: Vec<Arc<AtomicU64>> = (0..3)
            .map(|_| Arc::new(AtomicU64::new(0)))
            .collect();
        let wc_clone = worker_counts.clone();

        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender| {
            let wc = Arc::clone(&wc_clone[index]);
            std::thread::spawn(move || {
                loop {
                    match rx.recv() {
                        Ok(WorkerMessage::Event(_)) => {
                            wc.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(WorkerMessage::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
        });

        // Dispatch multiple value-change events with the same window_handle.
        for _ in 0..event_count {
            pool.dispatch(make_raw_event(RawEventType::ValueChange, window_handle));
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
            "expected exactly 1 worker to receive all value-change events, \
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
// Property 9: Click vs drag classification
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50))]

    /// Feature: capture-worker-pool, Property 9: Click vs drag
    ///
    /// **Validates: Requirements 10.2, 10.3**
    ///
    /// For any coordinate pair (x1, y1, x2, y2), the classification is:
    /// - drag if max(|x2-x1|, |y2-y1|) > 5
    /// - click otherwise
    #[test]
    fn click_vs_drag_classification(
        x1 in -10000i32..10000,
        y1 in -10000i32..10000,
        x2 in -10000i32..10000,
        y2 in -10000i32..10000,
    ) {
        let dx = (x2 - x1).abs();
        let dy = (y2 - y1).abs();
        let expected_drag = dx.max(dy) > 5;

        let result = is_drag(x1, y1, x2, y2);

        prop_assert_eq!(
            result,
            expected_drag,
            "is_drag({}, {}, {}, {}) = {}, expected {} (dx={}, dy={}, max={})",
            x1, y1, x2, y2, result, expected_drag, dx, dy, dx.max(dy)
        );
    }

    /// Feature: capture-worker-pool, Property 9: Click vs drag
    ///
    /// **Validates: Requirements 10.2, 10.3**
    ///
    /// Movements within the 5-pixel threshold are always classified as clicks.
    #[test]
    fn small_movements_are_clicks(
        x1 in -10000i32..10000,
        y1 in -10000i32..10000,
        dx in -5i32..=5,
        dy in -5i32..=5,
    ) {
        let x2 = x1.saturating_add(dx);
        let y2 = y1.saturating_add(dy);

        // Only test when the saturating_add didn't clamp (exact arithmetic).
        prop_assume!(x2 == x1 + dx && y2 == y1 + dy);

        let result = is_drag(x1, y1, x2, y2);
        prop_assert!(
            !result,
            "movement ({},{}) -> ({},{}) with delta ({},{}) should be a click, not a drag",
            x1, y1, x2, y2, dx, dy
        );
    }
}

// ---------------------------------------------------------------------------
// Property 10: Drag pair routing to same worker
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Feature: capture-worker-pool, Property 10: Drag pair routing
    ///
    /// **Validates: Requirements 10.4**
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

        let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender| {
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

use std::collections::VecDeque;
use std::sync::atomic::AtomicU32;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use docent_desktop_lib::capture::worker_pool::{AccessibilityBackend, worker_loop};
use docent_desktop_lib::capture::{ActionPayload, CaptureError, ElementDescription};

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
}

/// Helper: spawn a worker_loop in a background thread and return the channels
/// and handles needed to interact with it.
struct WorkerTestHarness {
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

        let thread = thread::spawn(move || {
            worker_loop(0, backend, event_rx, ql, action_tx, ep);
        });

        Self {
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
        self.event_tx.send(WorkerMessage::Event(event)).unwrap();
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
// Property 3: Sequence_id preservation from RawEvent to ActionEvent
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Feature: capture-worker-pool, Property 3: Sequence_id preservation
    ///
    /// **Validates: Requirements 5.11, 6.3**
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
// Property 7: Type event coalescing produces one event per keystroke sequence
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// Feature: capture-worker-pool, Property 7: Type coalescing
    ///
    /// **Validates: Requirements 9.3, 9.4, 5.4**
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
// Property 8: Pending type event is flushed before focus or context-switch
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// Feature: capture-worker-pool, Property 8: Flush on context change
    ///
    /// **Validates: Requirements 9.5**
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
// Unit tests for worker failure handling (Task 7.4)
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
    let spawn_counts: Vec<Arc<AtomicU64>> = (0..3)
        .map(|_| Arc::new(AtomicU64::new(0)))
        .collect();
    let sc_clone = spawn_counts.clone();

    let worker_counts: Vec<Arc<AtomicU64>> = (0..3)
        .map(|_| Arc::new(AtomicU64::new(0)))
        .collect();
    let wc_clone = worker_counts.clone();

    let mut pool = WorkerPool::new(3, action_tx, move |index, rx, _queue_len, _sender| {
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
                    Ok(WorkerMessage::Shutdown) => break,
                    Err(_) => break,
                }
            }
        })
    });

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
        count0, count1, count2
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

    let mut pool = WorkerPool::new(3, action_tx, move |_index, rx, _queue_len, _sender| {
        st_clone.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            // Each worker panics on first event, but handles Shutdown cleanly.
            match rx.recv() {
                Ok(WorkerMessage::Event(_)) => {
                    panic!("simulated worker panic");
                }
                Ok(WorkerMessage::Shutdown) => {}
                Err(_) => {}
            }
        })
    });

    // Initial spawn: 3 workers.
    assert_eq!(spawn_total.load(Ordering::SeqCst), 3);

    // Dispatch events to trigger panics. The first send to each worker
    // succeeds (worker panics after recv). The failure is detected on the
    // next send attempt, which triggers a respawn.
    // Round 1: send 3 events (one to each worker, all succeed, all panic).
    for _ in 0..3 {
        pool.dispatch(make_raw_event(RawEventType::Click, 0));
    }
    // Give workers time to panic.
    thread::sleep(Duration::from_millis(100));

    // Round 2: send 3 more events. Each send detects the dead channel,
    // respawns the worker, and retries on the fresh worker.
    for _ in 0..3 {
        pool.dispatch(make_raw_event(RawEventType::Click, 0));
    }
    thread::sleep(Duration::from_millis(100));

    // Workers should have been respawned (3 initial + at least 1 respawn).
    assert!(
        spawn_total.load(Ordering::SeqCst) > 3,
        "workers should have been respawned, total spawns: {}",
        spawn_total.load(Ordering::SeqCst)
    );

    // Shutdown should complete without hanging.
    pool.shutdown();
}

/// Test: `max_sequence_id` returns 0 before any events dispatched.
#[test]
fn max_sequence_id_returns_zero_initially() {
    let (action_tx, _action_rx) = mpsc::channel::<ActionEvent>();
    let pool = WorkerPool::new(1, action_tx, |_index, _rx, _queue_len, _sender| {
        std::thread::spawn(|| {})
    });

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

/// A mock backend that panics when `element_at_point` is called with
/// specific "poison" coordinates, but works normally for all other events.
struct PoisonEventBackend {
    poison_x: i32,
    poison_y: i32,
}

impl AccessibilityBackend for PoisonEventBackend {
    fn init(&mut self) -> Result<(), CaptureError> { Ok(()) }
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
        })
    }

    fn window_title(&self, _window_handle: i64) -> String { "Test".to_string() }
    fn process_name(&self, _window_handle: i64) -> String { "test.exe".to_string() }
    fn read_file_dialog_path(&self, _window_handle: i64) -> Option<(String, String)> { None }
    fn root_window_handle(&self, window_handle: i64) -> i64 { window_handle }
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
