// What the low-level mouse hook saw and how long it took, for diagnosis
// (docent#741).
//
// Windows passes input on without a low-level hook that does not return
// within the system's hook timeout, and can remove the hook after that
// (DCP-1). A click lost before the hook and a click lost after it look the
// same in a recording; these counters tell them apart: how many left presses
// and releases the hook was handed, how many clicks it dispatched, the
// longest single hook call, the longest click pre-capture, and whether a hook
// call ever ran inside another (a hook call dispatched while the thread waited
// inside an earlier one). The input thread's WinEvent callbacks run on the
// same thread, so their longest call is counted too: a slow callback delays
// the hook calls queued behind it.
//
// The pre-capture's own outcome counts (answered, overran, skipped, describers
// left to an application) are stored here as the input thread ends, so the
// line logged at stop tells the designed late path (a click whose element its
// worker describes) from a hook slow enough to have cost input.
//
// Process-wide atomics, reset when a capture session starts and kept after it
// stops, so a test can read them once `stop()` has returned. Relaxed atomics:
// counts for a person or a test to read, never a synchronisation point.
// Platform-agnostic, so the report's wording and its threshold are tested
// without Windows.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::pre_capture::PreCaptureCounts;
use super::timing::PRE_CAPTURE_BUDGET_MS;

/// What a hook call may take beyond the pre-capture budget for its own work
/// and for scheduling on a loaded machine.
pub const SLOW_HOOK_SLACK: Duration = Duration::from_millis(150);

/// A hook call or callback this long is reported at stop as one that may
/// have cost input: past the pre-capture budget plus [`SLOW_HOOK_SLACK`], so
/// a click that waited out the whole budget (the designed late path) is not
/// reported as one, yet still under the system's hook timeout, so a report
/// comes before input is lost.
pub const SLOW_HOOK_CALL: Duration =
    Duration::from_millis(PRE_CAPTURE_BUDGET_MS + SLOW_HOOK_SLACK.as_millis() as u64);

/// Serialises the tests that touch the process-wide counters.
#[cfg(test)]
pub(crate) static TEST_COUNTERS: std::sync::Mutex<()> = std::sync::Mutex::new(());

static MOUSE_CALLS: AtomicU64 = AtomicU64::new(0);
static LEFT_DOWNS: AtomicU64 = AtomicU64::new(0);
static LEFT_UPS: AtomicU64 = AtomicU64::new(0);
static LEFT_CLICKS_DISPATCHED: AtomicU64 = AtomicU64::new(0);
static LONGEST_MOUSE_CALL_US: AtomicU64 = AtomicU64::new(0);
static SLOW_MOUSE_CALLS: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES: AtomicU64 = AtomicU64::new(0);
static LONGEST_PRE_CAPTURE_US: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_WITHOUT_ELEMENT: AtomicU64 = AtomicU64::new(0);
static DEEPEST_MOUSE_NESTING: AtomicU64 = AtomicU64::new(0);
static LONGEST_WIN_EVENT_US: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_ANSWERED: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_OVERRAN: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_SKIPPED_HELD: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_SKIPPED_BUSY: AtomicU64 = AtomicU64::new(0);
static DESCRIBERS_ABANDONED: AtomicU64 = AtomicU64::new(0);

/// A snapshot of the counters.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct HookDiagnostics {
    /// Mouse hook calls of any message, moves included.
    pub mouse_calls: u64,
    /// Left button presses the hook was handed.
    pub left_downs: u64,
    /// Left button releases the hook was handed.
    pub left_ups: u64,
    /// Left clicks the hook dispatched (a drag's release dispatches none).
    pub left_clicks_dispatched: u64,
    /// The longest single mouse hook call, in microseconds.
    pub longest_mouse_call_us: u64,
    /// Mouse hook calls that took [`SLOW_HOOK_CALL`] or longer.
    pub slow_mouse_calls: u64,
    /// Click pre-captures asked for.
    pub pre_captures: u64,
    /// The longest a hook waited for a pre-capture, in microseconds.
    pub longest_pre_capture_us: u64,
    /// Pre-captures that gave the click no element.
    pub pre_captures_without_element: u64,
    /// The deepest a mouse hook call ran inside another (1 = never nested).
    pub deepest_mouse_nesting: u64,
    /// The longest single WinEvent callback on the input thread, in
    /// microseconds.
    pub longest_win_event_us: u64,
    /// Pre-captures answered within the budget.
    pub pre_captures_answered: u64,
    /// Pre-captures whose answer did not come within the budget.
    pub pre_captures_overran: u64,
    /// Pre-captures not asked because the clicked application still held a
    /// describer.
    pub pre_captures_skipped_held: u64,
    /// Pre-captures not asked because no describer was free.
    pub pre_captures_skipped_busy: u64,
    /// Describers left to an application that did not answer.
    pub describers_abandoned: u64,
}

fn micros(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX)
}

/// Zero every counter: a capture session starts.
pub fn reset() {
    for counter in [
        &MOUSE_CALLS,
        &LEFT_DOWNS,
        &LEFT_UPS,
        &LEFT_CLICKS_DISPATCHED,
        &LONGEST_MOUSE_CALL_US,
        &SLOW_MOUSE_CALLS,
        &PRE_CAPTURES,
        &LONGEST_PRE_CAPTURE_US,
        &PRE_CAPTURES_WITHOUT_ELEMENT,
        &DEEPEST_MOUSE_NESTING,
        &LONGEST_WIN_EVENT_US,
        &PRE_CAPTURES_ANSWERED,
        &PRE_CAPTURES_OVERRAN,
        &PRE_CAPTURES_SKIPPED_HELD,
        &PRE_CAPTURES_SKIPPED_BUSY,
        &DESCRIBERS_ABANDONED,
    ] {
        counter.store(0, Ordering::Relaxed);
    }
}

/// The counters as they stand.
pub fn snapshot() -> HookDiagnostics {
    HookDiagnostics {
        mouse_calls: MOUSE_CALLS.load(Ordering::Relaxed),
        left_downs: LEFT_DOWNS.load(Ordering::Relaxed),
        left_ups: LEFT_UPS.load(Ordering::Relaxed),
        left_clicks_dispatched: LEFT_CLICKS_DISPATCHED.load(Ordering::Relaxed),
        longest_mouse_call_us: LONGEST_MOUSE_CALL_US.load(Ordering::Relaxed),
        slow_mouse_calls: SLOW_MOUSE_CALLS.load(Ordering::Relaxed),
        pre_captures: PRE_CAPTURES.load(Ordering::Relaxed),
        longest_pre_capture_us: LONGEST_PRE_CAPTURE_US.load(Ordering::Relaxed),
        pre_captures_without_element: PRE_CAPTURES_WITHOUT_ELEMENT.load(Ordering::Relaxed),
        deepest_mouse_nesting: DEEPEST_MOUSE_NESTING.load(Ordering::Relaxed),
        longest_win_event_us: LONGEST_WIN_EVENT_US.load(Ordering::Relaxed),
        pre_captures_answered: PRE_CAPTURES_ANSWERED.load(Ordering::Relaxed),
        pre_captures_overran: PRE_CAPTURES_OVERRAN.load(Ordering::Relaxed),
        pre_captures_skipped_held: PRE_CAPTURES_SKIPPED_HELD.load(Ordering::Relaxed),
        pre_captures_skipped_busy: PRE_CAPTURES_SKIPPED_BUSY.load(Ordering::Relaxed),
        describers_abandoned: DESCRIBERS_ABANDONED.load(Ordering::Relaxed),
    }
}

/// Store the pre-capture's outcome counts: its input thread ends.
pub fn pre_capture_outcomes(counts: PreCaptureCounts) {
    PRE_CAPTURES_ANSWERED.store(counts.answered, Ordering::Relaxed);
    PRE_CAPTURES_OVERRAN.store(counts.overran, Ordering::Relaxed);
    PRE_CAPTURES_SKIPPED_HELD.store(counts.skipped_held, Ordering::Relaxed);
    PRE_CAPTURES_SKIPPED_BUSY.store(counts.skipped_busy, Ordering::Relaxed);
    DESCRIBERS_ABANDONED.store(counts.abandoned, Ordering::Relaxed);
}

/// A mouse hook call is entered at nesting `depth` (1 for a call that runs
/// inside no other).
pub fn mouse_call_entered(depth: u64) {
    MOUSE_CALLS.fetch_add(1, Ordering::Relaxed);
    DEEPEST_MOUSE_NESTING.fetch_max(depth, Ordering::Relaxed);
}

/// A mouse hook call returned after `elapsed`.
pub fn mouse_call_returned(elapsed: Duration) {
    LONGEST_MOUSE_CALL_US.fetch_max(micros(elapsed), Ordering::Relaxed);
    if elapsed >= SLOW_HOOK_CALL {
        SLOW_MOUSE_CALLS.fetch_add(1, Ordering::Relaxed);
    }
}

/// The hook was handed a left press.
pub fn left_down() {
    LEFT_DOWNS.fetch_add(1, Ordering::Relaxed);
}

/// The hook was handed a left release.
pub fn left_up() {
    LEFT_UPS.fetch_add(1, Ordering::Relaxed);
}

/// The hook dispatched a left click.
pub fn left_click_dispatched() {
    LEFT_CLICKS_DISPATCHED.fetch_add(1, Ordering::Relaxed);
}

/// A pre-capture took `elapsed` and gave an element or not.
pub fn pre_capture(elapsed: Duration, gave_element: bool) {
    PRE_CAPTURES.fetch_add(1, Ordering::Relaxed);
    LONGEST_PRE_CAPTURE_US.fetch_max(micros(elapsed), Ordering::Relaxed);
    if !gave_element {
        PRE_CAPTURES_WITHOUT_ELEMENT.fetch_add(1, Ordering::Relaxed);
    }
}

/// A WinEvent callback on the input thread returned after `elapsed`.
pub fn win_event_returned(elapsed: Duration) {
    LONGEST_WIN_EVENT_US.fetch_max(micros(elapsed), Ordering::Relaxed);
}

impl HookDiagnostics {
    /// Whether something in the session could have cost input: a hook call
    /// or a WinEvent callback that took [`SLOW_HOOK_CALL`] or longer, or a
    /// hook call that ran inside another.
    pub fn is_anomalous(&self) -> bool {
        let slow = micros(SLOW_HOOK_CALL);
        self.longest_mouse_call_us >= slow
            || self.longest_win_event_us >= slow
            || self.deepest_mouse_nesting > 1
    }

    /// Clicks the pre-capture gave no element through the late path: an
    /// overrun or a skipped ask. Their workers describe them (DCP-1).
    pub fn late_path_clicks(&self) -> u64 {
        self.pre_captures_overran + self.pre_captures_skipped_held + self.pre_captures_skipped_busy
    }

    /// The one line logged at stop: a warning when the session [is
    /// anomalous](Self::is_anomalous), a note when it is not but clicks took
    /// the late path, `None` otherwise.
    pub fn report(&self) -> Option<String> {
        let counts = format!(
            "left presses {}, left releases {}, left clicks dispatched {}, hook \
             calls {} ({} slow, longest {} ms, deepest nesting {}), pre-captures \
             {} ({} answered, {} overran, {} skipped for a held application, {} \
             skipped with no describer free, {} without an element, longest {} \
             ms; {} describers left to an application), longest WinEvent \
             callback {} ms",
            self.left_downs,
            self.left_ups,
            self.left_clicks_dispatched,
            self.mouse_calls,
            self.slow_mouse_calls,
            self.longest_mouse_call_us / 1000,
            self.deepest_mouse_nesting,
            self.pre_captures,
            self.pre_captures_answered,
            self.pre_captures_overran,
            self.pre_captures_skipped_held,
            self.pre_captures_skipped_busy,
            self.pre_captures_without_element,
            self.longest_pre_capture_us / 1000,
            self.describers_abandoned,
            self.longest_win_event_us / 1000,
        );
        if self.is_anomalous() {
            Some(format!(
                "[WindowsCapture] Warning: the mouse hook was slow this session \
                 (input may have been passed on without it): {counts}"
            ))
        } else if self.late_path_clicks() > 0 {
            Some(format!(
                "[WindowsCapture] {} click(s) got no pre-captured element and were \
                 described by their workers after the click: {counts}",
                self.late_path_clicks()
            ))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet() -> HookDiagnostics {
        HookDiagnostics {
            mouse_calls: 12,
            left_downs: 5,
            left_ups: 5,
            left_clicks_dispatched: 5,
            longest_mouse_call_us: 4_000,
            slow_mouse_calls: 0,
            pre_captures: 5,
            longest_pre_capture_us: 3_000,
            pre_captures_without_element: 0,
            deepest_mouse_nesting: 1,
            longest_win_event_us: 2_000,
            pre_captures_answered: 5,
            ..HookDiagnostics::default()
        }
    }

    #[test]
    fn a_quiet_session_reports_nothing() {
        assert_eq!(quiet().report(), None);
    }

    #[test]
    fn a_hook_call_at_the_slow_bound_is_reported_with_the_counts() {
        let diagnostics = HookDiagnostics {
            longest_mouse_call_us: micros(SLOW_HOOK_CALL),
            slow_mouse_calls: 1,
            left_ups: 1,
            ..quiet()
        };
        let line = diagnostics.report().expect("a slow hook call is reported");
        assert!(line.contains("left releases 1"), "{line}");
        assert!(line.contains("1 slow, longest 250 ms"), "{line}");
        assert!(line.contains("Warning"), "{line}");
        let just_under = HookDiagnostics {
            longest_mouse_call_us: micros(SLOW_HOOK_CALL) - 1,
            ..quiet()
        };
        assert_eq!(just_under.report(), None);
    }

    // Regression: #741 review — a click that waited out the whole pre-capture
    // budget is the designed late path, not a hook that may have cost input.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_a_hook_call_that_waited_out_the_budget_is_a_late_path_note_not_a_warning() {
        assert!(
            SLOW_HOOK_CALL >= Duration::from_millis(PRE_CAPTURE_BUDGET_MS) + SLOW_HOOK_SLACK,
            "the slow bound leaves no room past the budget"
        );
        let late = HookDiagnostics {
            longest_mouse_call_us: (PRE_CAPTURE_BUDGET_MS + 20) * 1000,
            longest_pre_capture_us: PRE_CAPTURE_BUDGET_MS * 1000,
            pre_captures_answered: 3,
            pre_captures_overran: 1,
            pre_captures_skipped_held: 1,
            pre_captures_without_element: 2,
            ..quiet()
        };
        assert!(!late.is_anomalous());
        let line = late.report().expect("late-path clicks are noted");
        assert!(!line.contains("Warning"), "{line}");
        assert!(
            line.contains("2 click(s) got no pre-captured element"),
            "{line}"
        );
        assert!(
            line.contains("3 answered, 1 overran, 1 skipped for a held application"),
            "{line}"
        );
    }

    #[test]
    fn a_slow_win_event_callback_and_a_nested_hook_call_are_reported() {
        let slow_callback = HookDiagnostics {
            longest_win_event_us: micros(SLOW_HOOK_CALL),
            ..quiet()
        };
        assert!(slow_callback.is_anomalous());
        let nested = HookDiagnostics {
            deepest_mouse_nesting: 2,
            ..quiet()
        };
        assert!(nested.report().unwrap().contains("deepest nesting 2"));
    }

    #[test]
    fn the_recorders_feed_the_snapshot_and_reset_zeroes_it() {
        let _counters = TEST_COUNTERS.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        mouse_call_entered(1);
        mouse_call_entered(2);
        mouse_call_returned(Duration::from_millis(300));
        left_down();
        left_up();
        left_click_dispatched();
        pre_capture(Duration::from_millis(120), false);
        win_event_returned(Duration::from_millis(7));
        pre_capture_outcomes(PreCaptureCounts {
            answered: 4,
            overran: 1,
            skipped_held: 2,
            skipped_busy: 3,
            abandoned: 1,
            longest_wait_us: 0,
        });
        let seen = snapshot();
        assert_eq!(
            seen,
            HookDiagnostics {
                mouse_calls: 2,
                left_downs: 1,
                left_ups: 1,
                left_clicks_dispatched: 1,
                longest_mouse_call_us: 300_000,
                slow_mouse_calls: 1,
                pre_captures: 1,
                longest_pre_capture_us: 120_000,
                pre_captures_without_element: 1,
                deepest_mouse_nesting: 2,
                longest_win_event_us: 7_000,
                pre_captures_answered: 4,
                pre_captures_overran: 1,
                pre_captures_skipped_held: 2,
                pre_captures_skipped_busy: 3,
                describers_abandoned: 1,
            }
        );
        reset();
        assert_eq!(snapshot(), HookDiagnostics::default());
    }
}
