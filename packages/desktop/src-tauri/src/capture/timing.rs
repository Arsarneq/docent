// Central timing configuration — single source of truth for the capture
// layer's correlation windows, the click-redundancy window, debounce intervals
// and worker tick (the pool's flush and shutdown bounds live in
// `worker_pool.rs`; the capture-start bounds are `windows.rs`'s own module
// constants).
//
// This is the desktop equivalent of the extension's `lib/capture-timing.js`.
// All of those live here so they can be tuned in one place.

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

// ─── Click Redundancy ───────────────────────────────────────────────────────

/// Click-redundancy window. A focus or selection WinEvent arriving within this
/// many ms of the most recent left click (stamped at left button-down and
/// again when the release classifies as a click) is the click's own effect —
/// the click action already records the interaction — so the Input_Thread
/// suppresses it as redundant. The boundary is inclusive; the gate is
/// [`is_click_redundant`].
pub const CLICK_REDUNDANCY_MS: u64 = 200;

/// Whether a focus or selection WinEvent at `event_ms` is redundant with the
/// left click stamped at `last_click_ms`: `true` when a click has been stamped
/// and the event arrives within [`CLICK_REDUNDANCY_MS`] of it, the boundary
/// inclusive (through [`is_correlated`]). A `last_click_ms` of 0 means no click
/// has been stamped, and nothing is redundant with it.
#[inline]
pub fn is_click_redundant(event_ms: u64, last_click_ms: u64) -> bool {
    last_click_ms > 0 && is_correlated(event_ms, last_click_ms, CLICK_REDUNDANCY_MS)
}

// ─── Scroll ─────────────────────────────────────────────────────────────────

/// Debounce interval in milliseconds. A scroll action is emitted only after
/// no scroll event arrives for this duration.
pub const SCROLL_DEBOUNCE_MS: u64 = 300;

/// Minimum scroll distance required in at least one axis for the scroll to be
/// recorded, in the native wheel-delta units the platform's input layer feeds
/// (not pixels — the `_PX` suffix is historical; Windows feeds 120 per wheel
/// detent, so 200 is ~1.7 detents). Sequences where both `|total_delta_x|`
/// and `|total_delta_y|` are ≤ this threshold are discarded.
pub const SCROLL_MIN_DISTANCE_PX: f64 = 200.0;

// ─── Typing ─────────────────────────────────────────────────────────────────

/// How long a typing key waits for the value change that makes it text
/// (milliseconds). With none by then, the control took no text from the key
/// and it is written as a key. The wait ends nothing else: a field's `type`
/// is written when the typing in it ends, however long the pauses in it.
pub const KEY_TEXT_WAIT_MS: u64 = 500;

/// The most the keyboard hook waits for each of the two answers of a key
/// press's input-method read (milliseconds). The read asks the focused
/// control's input-method window, which the program's own thread answers;
/// with no answer by then the key is dispatched with no input-method state.
pub const INPUT_METHOD_READ_TIMEOUT_MS: u64 = 20;

/// How long the keyboard hook waits for each answer of the input-method
/// read, given the system's low-level hook timeout:
/// [`INPUT_METHOD_READ_TIMEOUT_MS`], or an eighth of the hook timeout where
/// that is less, so the two waits take at most a quarter of it. 0 means the
/// hook does not read at all (a hook timeout too short to wait in).
pub fn input_method_read_timeout_ms(hook_timeout_ms: u64) -> u64 {
    INPUT_METHOD_READ_TIMEOUT_MS.min(hook_timeout_ms / 8)
}

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
/// `event_ms - last_input_ms <= window_ms`. What a caller does with the answer
/// is its own: the correlation gates admit a correlated event to the arm's
/// remaining filters and suppress an uncorrelated one as programmatic (DCP-7);
/// the click-redundancy gate suppresses a correlated focus or selection event
/// as redundant (`CLICK_REDUNDANCY_MS`).
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

// ─── Click pre-capture ─────────────────────────────────────────────────────
//
// The low-level mouse hook waits for the click pre-capture's answer (DCP-1)
// for at most a budget set at start from the system's low-level hook
// timeout: the time Windows gives a low-level hook to return before it passes
// the input on without it (and, it is understood though not verified, can
// remove the hook). The budget is that timeout less a margin for the hook's
// own work, so the hook returns before the timeout whatever the clicked
// application does, and Windows does not pass the clicks after a slow one on
// unrecorded. A click whose description takes longer than the budget takes
// the late path (DCP-13); when the hook made the call itself, that click was
// still recorded with its element, while the clicks after it, made as the
// call ran past the timeout, were passed on unrecorded.

/// The user's low-level hook timeout setting as the registry holds it
/// (`HKCU\Control Panel\Desktop\LowLevelHooksTimeout`), in milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookTimeoutSetting {
    /// No value, or one that could not be read.
    Absent,
    /// A `REG_DWORD` value.
    Number(u32),
    /// A `REG_SZ` value, decimal text. Whether Windows honours a `REG_SZ`
    /// here is not verified, so its value is taken only up to
    /// [`HOOK_TIMEOUT_DEFAULT_MS`]: no greater than the timeout Windows uses
    /// either way.
    Text(String),
}

/// The most Windows allows the low-level hook timeout to be, from Windows 10
/// version 1709: a larger setting is treated as this.
pub const HOOK_TIMEOUT_CAP_MS: u64 = 1000;

/// The timeout assumed when the setting is absent, zero or not a number.
/// Chosen, not read from Microsoft's documentation, which could not be
/// checked when it was set; unverified. Too high a value lets a hook call run
/// past the system's real timeout, where the clicks after it are passed on
/// unrecorded and, it is understood, the hook can be removed; too low a value
/// sends a click whose description would have come in time down the late
/// path. Losing the hook costs every click after it, the late path one
/// click's element, so the value errs low.
pub const HOOK_TIMEOUT_DEFAULT_MS: u64 = 300;

/// What the budget leaves of the hook timeout for the hook's own work around
/// the wait (reading the window under the pointer and its process, the scope
/// filter, dispatching the click) and for scheduling on a loaded machine.
pub const HOOK_WORK_MARGIN_MS: u64 = 50;

/// The low-level hook timeout, in milliseconds, that a setting gives: a
/// `REG_DWORD` value capped at [`HOOK_TIMEOUT_CAP_MS`], a `REG_SZ` value
/// capped at [`HOOK_TIMEOUT_DEFAULT_MS`], or [`HOOK_TIMEOUT_DEFAULT_MS`] when
/// the setting is absent, zero or not a decimal number.
pub fn hook_timeout_ms(setting: &HookTimeoutSetting) -> u64 {
    let (value, cap) = match setting {
        HookTimeoutSetting::Absent => (None, HOOK_TIMEOUT_CAP_MS),
        HookTimeoutSetting::Number(n) => (Some(u64::from(*n)), HOOK_TIMEOUT_CAP_MS),
        HookTimeoutSetting::Text(text) => {
            (text.trim().parse::<u64>().ok(), HOOK_TIMEOUT_DEFAULT_MS)
        }
    };
    match value {
        Some(ms) if ms > 0 => ms.min(cap),
        _ => HOOK_TIMEOUT_DEFAULT_MS,
    }
}

/// The longest the mouse hook waits for a click's pre-capture, given the
/// hook timeout: the timeout less [`HOOK_WORK_MARGIN_MS`], or half the
/// timeout when it is too short to leave the margin and as much again.
///
/// The answer is the whole description a describer builds: `ElementFromPoint`,
/// then the element's property reads, its `LabeledBy` label and its ancestor
/// walk (up to `MAX_TREE_PATH_ANCESTORS`, 20, parents), every call a request
/// to the clicked application. No distribution of description times is
/// recorded; the hook diagnostics' longest pre-capture and its outcome counts,
/// logged at stop when a click took the late path, are the measurement.
pub fn pre_capture_budget_ms(hook_timeout_ms: u64) -> u64 {
    if hook_timeout_ms >= 2 * HOOK_WORK_MARGIN_MS {
        hook_timeout_ms - HOOK_WORK_MARGIN_MS
    } else {
        hook_timeout_ms / 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── the hook timeout and the pre-capture budget ────────────────────────

    #[test]
    fn regression_237_the_input_method_read_waits_within_a_quarter_of_the_hook_timeout() {
        assert_eq!(input_method_read_timeout_ms(HOOK_TIMEOUT_DEFAULT_MS), 20);
        assert_eq!(input_method_read_timeout_ms(HOOK_TIMEOUT_CAP_MS), 20);
        assert_eq!(input_method_read_timeout_ms(160), 20);
        assert_eq!(input_method_read_timeout_ms(80), 10);
        assert_eq!(input_method_read_timeout_ms(7), 0);
        for timeout in 1..=HOOK_TIMEOUT_CAP_MS {
            assert!(
                2 * input_method_read_timeout_ms(timeout) <= timeout / 4,
                "{timeout}"
            );
        }
    }

    // Regression: #741 review — the budget follows the system's hook timeout,
    // so the hook waits for a click's description as long as the system
    // lets it.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_the_hook_timeout_is_read_from_either_value_type_and_capped() {
        assert_eq!(hook_timeout_ms(&HookTimeoutSetting::Number(600)), 600);
        assert_eq!(hook_timeout_ms(&HookTimeoutSetting::Number(5000)), 1000);
        assert_eq!(
            hook_timeout_ms(&HookTimeoutSetting::Text(" 200 ".into())),
            200
        );
    }

    // Regression: #741 review — whether Windows honours a text value here is
    // not verified, so a text value above the default could set a budget past
    // the timeout Windows actually uses, and the hook could be held past it.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_a_text_hook_timeout_is_taken_only_up_to_the_default() {
        for text in ["750", "5000"] {
            assert_eq!(
                hook_timeout_ms(&HookTimeoutSetting::Text(text.into())),
                HOOK_TIMEOUT_DEFAULT_MS,
                "{text}"
            );
        }
    }

    #[test]
    fn an_absent_zero_or_unreadable_hook_timeout_is_the_default() {
        for setting in [
            HookTimeoutSetting::Absent,
            HookTimeoutSetting::Number(0),
            HookTimeoutSetting::Text("0".into()),
            HookTimeoutSetting::Text("".into()),
            HookTimeoutSetting::Text("0x200".into()),
            HookTimeoutSetting::Text("-5".into()),
        ] {
            assert_eq!(
                hook_timeout_ms(&setting),
                HOOK_TIMEOUT_DEFAULT_MS,
                "{setting:?}"
            );
        }
    }

    #[test]
    fn the_budget_is_the_hook_timeout_less_the_margin_and_never_more_than_half_a_short_one() {
        assert_eq!(pre_capture_budget_ms(1000), 1000 - HOOK_WORK_MARGIN_MS);
        assert_eq!(
            pre_capture_budget_ms(HOOK_TIMEOUT_DEFAULT_MS),
            HOOK_TIMEOUT_DEFAULT_MS - HOOK_WORK_MARGIN_MS
        );
        assert_eq!(
            pre_capture_budget_ms(2 * HOOK_WORK_MARGIN_MS),
            HOOK_WORK_MARGIN_MS
        );
        assert_eq!(pre_capture_budget_ms(60), 30);
        assert_eq!(pre_capture_budget_ms(1), 0);
        for timeout in 1..=HOOK_TIMEOUT_CAP_MS {
            assert!(pre_capture_budget_ms(timeout) < timeout, "{timeout}");
        }
    }

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

    // ─── click redundancy: suppressed iff a click is stamped and gap <= CLICK_REDUNDANCY_MS ───

    #[test]
    fn click_redundancy_inside_window_suppresses() {
        // gap one short of the window → redundant (suppressed)
        assert!(is_click_redundant(10_000 + CLICK_REDUNDANCY_MS - 1, 10_000));
    }

    // Regression: a focus or selection event exactly CLICK_REDUNDANCY_MS after a
    // click was dispatched — the gates compared strictly. No GitHub issue —
    // found reconciling DCP-7's window against the code.
    #[test]
    fn regression_noissue_click_redundancy_boundary_is_inclusive() {
        assert!(is_click_redundant(10_000 + CLICK_REDUNDANCY_MS, 10_000));
    }

    #[test]
    fn click_redundancy_one_past_window_dispatches() {
        // gap = window + 1 → not redundant (dispatched)
        assert!(!is_click_redundant(10_001 + CLICK_REDUNDANCY_MS, 10_000));
    }

    #[test]
    fn click_redundancy_never_clicked_dispatches() {
        // last click 0 = no click stamped → nothing is redundant with it
        assert!(!is_click_redundant(0, 0));
        assert!(!is_click_redundant(CLICK_REDUNDANCY_MS, 0));
        assert!(!is_click_redundant(u64::MAX, 0));
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
    fn key_text_wait_boundary() {
        // 500ms key wait: 499 not elapsed, 500 elapsed, 501 elapsed.
        assert!(!debounce_elapsed(10499, 10000, KEY_TEXT_WAIT_MS));
        assert!(debounce_elapsed(10500, 10000, KEY_TEXT_WAIT_MS));
        assert!(debounce_elapsed(10501, 10000, KEY_TEXT_WAIT_MS));
    }
}
