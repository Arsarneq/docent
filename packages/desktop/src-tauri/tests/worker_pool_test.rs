// Property tests for the capture worker pool infrastructure.
//
// Tests cover: sequence numbering, shortest-queue dispatch, sticky routing,
// click vs drag classification, and drag pair routing.

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
// Click vs drag classification
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50))]

    /// Click vs drag
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

    /// Click vs drag
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

use docent_desktop_lib::capture::worker_pool::{worker_loop, AccessibilityBackend, PendingBuffers};
use docent_desktop_lib::capture::{ActionPayload, CaptureError, CaptureMode, ElementDescription};

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
            let pending = std::sync::Arc::new(Mutex::new(PendingBuffers::default()));
            worker_loop(0, backend, event_rx, ql, action_tx, ep, pending, None);
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
        self.event_tx
            .send(WorkerMessage::Event(Box::new(event)))
            .unwrap();
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

    // Send scroll events that exceed the threshold (total > 200px).
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
