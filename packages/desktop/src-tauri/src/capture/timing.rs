// Central timing configuration — single source of truth for all timing
// constants used by the desktop capture layer.
//
// This is the desktop equivalent of the extension's `lib/capture-timing.js`.
// All timing-related constants live here so they can be tuned in one place.

use std::time::Duration;

// ─── Input Correlation Windows ──────────────────────────────────────────────
// Maximum time (ms) between a low-level input event and a correlated
// WinEvent for the WinEvent to be considered user-caused.

/// Foreground correlation window. Click → foreground change is nearly instant
/// (<50ms typically). 100ms covers slow machines.
pub const FOREGROUND_CORRELATION_MS: u64 = 100;

/// Window lifecycle (create/destroy) correlation window. User action → window
/// create/destroy can involve application processing time.
pub const WINDOW_LIFECYCLE_CORRELATION_MS: u64 = 200;

/// Focus correlation window. Click/Tab → focus change is nearly instant.
pub const FOCUS_CORRELATION_MS: u64 = 100;

/// Value-change correlation window. Keystroke → value change involves:
/// OS processes key → app receives WM_CHAR → app updates text → accessibility
/// fires EVENT_OBJECT_VALUECHANGE. This chain can take 200-400ms on typical
/// apps, but UWP apps (Calculator, Settings) can take 500-800ms due to their
/// async rendering pipeline.
pub const VALUE_CHANGE_CORRELATION_MS: u64 = 1000;

/// Selection correlation window. Selection changes ride the same pipeline as
/// value changes (input → app updates selection state → accessibility fires
/// EVENT_OBJECT_SELECTION), so the same worst-case latency class applies —
/// including the UWP async-rendering lag; the alias keeps the two windows
/// coupled if that measurement is ever retuned. An uncorrelated selection
/// event is the application's own doing (timers, async loads, background
/// refresh) and must not be recorded as a user action.
pub const SELECTION_CORRELATION_MS: u64 = VALUE_CHANGE_CORRELATION_MS;

// ─── Scroll ─────────────────────────────────────────────────────────────────

/// Debounce interval in milliseconds. A scroll action is emitted only after
/// no scroll event arrives for this duration.
pub const SCROLL_DEBOUNCE_MS: u64 = 300;

/// Minimum scroll distance (in pixels) required in at least one axis for the
/// scroll to be recorded. Sequences where both `|total_delta_x|` and
/// `|total_delta_y|` are ≤ this threshold are discarded.
pub const SCROLL_MIN_DISTANCE_PX: f64 = 200.0;

// ─── Type Coalescing ────────────────────────────────────────────────────────

/// Debounce interval for coalescing rapid value-change events into a single
/// type action (milliseconds).
pub const TYPE_DEBOUNCE_MS: u64 = 500;

// ─── Worker ─────────────────────────────────────────────────────────────────

/// Timeout for worker `recv_timeout` — used for periodic flush of scroll and
/// type buffers.
pub const WORKER_RECV_TIMEOUT_MS: u64 = 50;

/// `WORKER_RECV_TIMEOUT_MS` as a `Duration` for direct use with `recv_timeout`.
pub const WORKER_RECV_TIMEOUT: Duration = Duration::from_millis(WORKER_RECV_TIMEOUT_MS);

// ─── Pure timing predicates ─────────────────────────────────────────────────
// Single source of truth for the two timing comparisons used across the capture
// layer. Extracted as pure functions so the exact boundary semantics (`<=` vs
// `<`) are testable in isolation, without standing up the Win32 hook machinery
// (correlation) or the worker pool (debounce). See #91.

/// Whether a WinEvent at `event_ms` is correlated with (caused by) a user input
/// at `last_input_ms`, given a correlation `window_ms`.
///
/// An event is **correlated** when it arrives within the window of the input:
/// `event_ms - last_input_ms <= window_ms`. Events outside the window are
/// treated as programmatic (not user-caused) and suppressed by the caller.
///
/// Saturating subtraction means an `event_ms` before `last_input_ms` (clock
/// skew / out-of-order) yields a gap of 0 — i.e. correlated. Callers gate on a
/// non-zero `last_input_ms` where "no input yet" must not correlate.
#[inline]
pub fn is_correlated(event_ms: u64, last_input_ms: u64, window_ms: u64) -> bool {
    event_ms.saturating_sub(last_input_ms) <= window_ms
}

/// Whether a debounce interval has elapsed: `now_ms` is at least `window_ms`
/// after the `last_ms` activity, i.e. `now_ms - last_ms >= window_ms`.
///
/// Used for scroll and type coalescing — the buffer is flushed once this
/// returns `true` (no further activity arrived within the window).
#[inline]
pub fn debounce_elapsed(now_ms: u64, last_ms: u64, window_ms: u64) -> bool {
    now_ms.saturating_sub(last_ms) >= window_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── is_correlated: correlated iff gap <= window ────────────────────────

    #[test]
    fn correlated_strictly_inside_window() {
        // gap = 99 < 100 → correlated
        assert!(is_correlated(199, 100, FOREGROUND_CORRELATION_MS));
    }

    #[test]
    fn correlated_exactly_at_window_boundary() {
        // gap = 100 == window → correlated (boundary is inclusive)
        assert!(is_correlated(200, 100, FOREGROUND_CORRELATION_MS));
    }

    #[test]
    fn not_correlated_one_past_window() {
        // gap = 101 > 100 → NOT correlated
        assert!(!is_correlated(201, 100, FOREGROUND_CORRELATION_MS));
    }

    #[test]
    fn correlated_handles_value_change_window() {
        // 1000ms window: 1000 correlates, 1001 does not.
        assert!(is_correlated(1000, 0, VALUE_CHANGE_CORRELATION_MS));
        assert!(!is_correlated(1001, 0, VALUE_CHANGE_CORRELATION_MS));
    }

    #[test]
    fn correlated_out_of_order_event_is_zero_gap() {
        // event before input (clock skew) saturates to gap 0 → correlated.
        assert!(is_correlated(50, 100, FOCUS_CORRELATION_MS));
    }

    // ─── debounce_elapsed: elapsed iff gap >= window ────────────────────────

    #[test]
    fn debounce_not_elapsed_one_before_boundary() {
        // gap = 299 < 300 → still within debounce
        assert!(!debounce_elapsed(1299, 1000, SCROLL_DEBOUNCE_MS));
    }

    #[test]
    fn debounce_elapsed_exactly_at_boundary() {
        // gap = 300 == window → elapsed (boundary flushes)
        assert!(debounce_elapsed(1300, 1000, SCROLL_DEBOUNCE_MS));
    }

    #[test]
    fn debounce_elapsed_one_past_boundary() {
        // gap = 301 > 300 → elapsed
        assert!(debounce_elapsed(1301, 1000, SCROLL_DEBOUNCE_MS));
    }

    #[test]
    fn type_debounce_boundary() {
        // 500ms type window: 499 not elapsed, 500 elapsed, 501 elapsed.
        assert!(!debounce_elapsed(10499, 10000, TYPE_DEBOUNCE_MS));
        assert!(debounce_elapsed(10500, 10000, TYPE_DEBOUNCE_MS));
        assert!(debounce_elapsed(10501, 10000, TYPE_DEBOUNCE_MS));
    }
}
