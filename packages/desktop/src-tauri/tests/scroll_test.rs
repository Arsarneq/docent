// Property 2: Scroll debounce and threshold filtering
//
// **Validates: Requirements 2.7, 13.1, 13.2**
//
// For any sequence of scroll events with timestamps, the capture layer shall
// emit a scroll action only when (a) no scroll event occurs for 300ms after
// the last event in the sequence, AND (b) the total scroll distance exceeds
// 200 pixels in at least one axis. Sequences that do not meet both conditions
// shall produce no scroll action.

use docent_desktop_lib::capture::scroll::{
    process_scroll_events, RawScrollEvent, ScrollAccumulator, DEBOUNCE_MS,
    MIN_SCROLL_DISTANCE_PX,
};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// Strategy for a single raw scroll event.
#[allow(dead_code)]
fn arb_scroll_event(base_ts: u64) -> impl Strategy<Value = RawScrollEvent> {
    (
        0..600u64,       // offset from base timestamp (0–600ms range)
        -500.0..500.0f64, // delta_x
        -500.0..500.0f64, // delta_y
    )
        .prop_map(move |(offset, delta_x, delta_y)| RawScrollEvent {
            timestamp: base_ts + offset,
            delta_x,
            delta_y,
        })
}

/// Strategy for a sequence of scroll events sorted by timestamp.
fn arb_scroll_sequence() -> impl Strategy<Value = Vec<RawScrollEvent>> {
    // Generate 1–20 events with increasing timestamps.
    prop::collection::vec(
        (
            1..200u64,        // inter-event gap in ms
            -500.0..500.0f64, // delta_x
            -500.0..500.0f64, // delta_y
        ),
        1..20,
    )
    .prop_map(|tuples| {
        let mut events = Vec::new();
        let mut ts = 1000u64;
        for (gap, dx, dy) in tuples {
            ts += gap;
            events.push(RawScrollEvent {
                timestamp: ts,
                delta_x: dx,
                delta_y: dy,
            });
        }
        events
    })
}

/// Strategy for a single scroll sequence that stays within the debounce window
/// (all events within 300ms of each other).
fn arb_tight_sequence() -> impl Strategy<Value = Vec<RawScrollEvent>> {
    prop::collection::vec(
        (
            1..50u64,         // small inter-event gap (well within 300ms)
            -500.0..500.0f64, // delta_x
            -500.0..500.0f64, // delta_y
        ),
        1..15,
    )
    .prop_map(|tuples| {
        let mut events = Vec::new();
        let mut ts = 1000u64;
        for (gap, dx, dy) in tuples {
            ts += gap;
            events.push(RawScrollEvent {
                timestamp: ts,
                delta_x: dx,
                delta_y: dy,
            });
        }
        events
    })
}

// ---------------------------------------------------------------------------
// Helper: manually compute expected results for a sequence
// ---------------------------------------------------------------------------

/// Split events into sequences by DEBOUNCE_MS gaps, then apply threshold.
fn expected_results(events: &[RawScrollEvent]) -> Vec<(f64, f64)> {
    if events.is_empty() {
        return Vec::new();
    }

    let mut results = Vec::new();
    let mut seq_start = 0;

    for i in 1..=events.len() {
        let is_end = if i == events.len() {
            true
        } else {
            events[i].timestamp.saturating_sub(events[i - 1].timestamp) >= DEBOUNCE_MS
        };

        if is_end {
            let total_dx: f64 = events[seq_start..i].iter().map(|e| e.delta_x).sum();
            let total_dy: f64 = events[seq_start..i].iter().map(|e| e.delta_y).sum();

            if total_dx.abs() > MIN_SCROLL_DISTANCE_PX
                || total_dy.abs() > MIN_SCROLL_DISTANCE_PX
            {
                results.push((total_dx, total_dy));
            }

            seq_start = i;
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Feature: desktop-capture, Property 2: Scroll debounce and threshold filtering
    ///
    /// **Validates: Requirements 2.7, 13.1, 13.2**
    ///
    /// For any sequence of scroll events, the number of emitted scroll actions
    /// matches the expected count based on debounce grouping and threshold
    /// filtering.
    #[test]
    fn scroll_sequence_produces_correct_results(events in arb_scroll_sequence()) {
        let results = process_scroll_events(&events);
        let expected = expected_results(&events);

        prop_assert_eq!(
            results.len(),
            expected.len(),
            "expected {} scroll results but got {} for {} events",
            expected.len(),
            results.len(),
            events.len()
        );

        for (i, (result, (exp_dx, exp_dy))) in results.iter().zip(expected.iter()).enumerate() {
            prop_assert!(
                (result.total_delta_x - exp_dx).abs() < 1e-10,
                "result[{}] delta_x mismatch: got {}, expected {}",
                i, result.total_delta_x, exp_dx
            );
            prop_assert!(
                (result.total_delta_y - exp_dy).abs() < 1e-10,
                "result[{}] delta_y mismatch: got {}, expected {}",
                i, result.total_delta_y, exp_dy
            );
        }
    }

    /// Feature: desktop-capture, Property 2: Scroll debounce and threshold filtering
    ///
    /// **Validates: Requirements 13.2**
    ///
    /// For any emitted scroll result, at least one axis must exceed the
    /// 200px threshold.
    #[test]
    fn emitted_scrolls_always_exceed_threshold(events in arb_scroll_sequence()) {
        let results = process_scroll_events(&events);

        for (i, result) in results.iter().enumerate() {
            prop_assert!(
                result.total_delta_x.abs() > MIN_SCROLL_DISTANCE_PX
                    || result.total_delta_y.abs() > MIN_SCROLL_DISTANCE_PX,
                "result[{}] does not exceed threshold: dx={}, dy={}",
                i, result.total_delta_x, result.total_delta_y
            );
        }
    }

    /// Feature: desktop-capture, Property 2: Scroll debounce and threshold filtering
    ///
    /// **Validates: Requirements 13.1**
    ///
    /// For a tight sequence (all events within debounce window), at most one
    /// scroll result is produced.
    #[test]
    fn tight_sequence_produces_at_most_one_result(events in arb_tight_sequence()) {
        let results = process_scroll_events(&events);
        prop_assert!(
            results.len() <= 1,
            "tight sequence should produce at most 1 result, got {}",
            results.len()
        );
    }

    /// Feature: desktop-capture, Property 2: Scroll debounce and threshold filtering
    ///
    /// **Validates: Requirements 13.2**
    ///
    /// Empty input produces no scroll results.
    #[test]
    fn empty_input_produces_no_results(_dummy in 0..1u32) {
        let results = process_scroll_events(&[]);
        prop_assert!(results.is_empty());
    }

    /// Feature: desktop-capture, Property 2: Scroll debounce and threshold filtering
    ///
    /// **Validates: Requirements 13.1, 13.2**
    ///
    /// The ScrollAccumulator produces the same results as process_scroll_events
    /// for a single tight sequence when flushed after the debounce interval.
    #[test]
    fn accumulator_matches_batch_for_tight_sequence(events in arb_tight_sequence()) {
        let batch_results = process_scroll_events(&events);

        let mut acc = ScrollAccumulator::new();
        for event in &events {
            acc.push(event.clone());
        }

        // Flush after debounce interval.
        let flush_time = events.last().map_or(0, |e| e.timestamp) + DEBOUNCE_MS;
        let acc_result = acc.try_flush(flush_time);

        match (batch_results.len(), acc_result) {
            (0, None) => {} // Both agree: no result.
            (1, Some(result)) => {
                let batch = &batch_results[0];
                prop_assert!(
                    (result.total_delta_x - batch.total_delta_x).abs() < 1e-10
                        && (result.total_delta_y - batch.total_delta_y).abs() < 1e-10,
                    "accumulator result ({}, {}) differs from batch ({}, {})",
                    result.total_delta_x, result.total_delta_y,
                    batch.total_delta_x, batch.total_delta_y
                );
            }
            (batch_len, acc) => {
                prop_assert!(
                    false,
                    "mismatch: batch produced {} results, accumulator produced {:?}",
                    batch_len, acc
                );
            }
        }
    }
}
