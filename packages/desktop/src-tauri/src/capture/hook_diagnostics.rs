// What the low-level mouse hook saw and how long it took, for diagnosis
// (docent#741).
//
// Windows passes input on without a low-level hook that does not return
// within the system's hook timeout, and, it is understood though not
// verified, can remove the hook after that (the capture pipeline's pre-capture
// section, "What the budget buys"). A click lost before the hook and a click lost after it look the
// same in a recording; these counters tell them apart: how many left presses
// and releases the hook was handed, how many clicks it dispatched, the
// longest single hook call, the longest click pre-capture, and whether a hook
// call ever ran inside another (a hook call dispatched while the thread waited
// inside an earlier one). The input thread's WinEvent callbacks run on the
// same thread, so their longest call is counted too: a slow callback delays
// the hook calls queued behind it.
//
// Every click the pre-capture gave no element is counted by why (DCP-13): no
// answer within the budget, an answer that describes nothing, or no
// pre-capture running. The pre-capture's own outcome counts (answered,
// overran, waited out for a held application or for a free describer,
// describers left to an application, clients not built) are stored here as
// the input thread ends. The session's hook timeout and budget are stored at
// start, so the line logged at stop tells the designed late path (a click
// whose element its worker describes) from a hook call that reached the
// system's timeout.
//
// Process-wide atomics, reset when a capture session starts and kept after it
// stops, so a test can read them once `stop()` has returned. Relaxed atomics:
// counts for a person or a test to read, never a synchronisation point.
// Platform-agnostic, so the report's wording and its threshold are tested
// without Windows.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::pre_capture::PreCaptureCounts;
use super::timing::HOOK_TIMEOUT_DEFAULT_MS;

/// Serialises the tests that touch the process-wide counters.
#[cfg(test)]
pub(crate) static TEST_COUNTERS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Why a click got the element it got from the pre-capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreCaptureOutcome {
    /// An answer within the budget that describes an element.
    Element,
    /// An answer within the budget that describes nothing (the point gave no
    /// element, the description failed, or the describer has no client).
    AnsweredWithoutElement,
    /// No answer within the budget.
    NoAnswer,
    /// No pre-capture running (it did not start).
    NoPreCapture,
}

static HOOK_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURE_BUDGET_MS: AtomicU64 = AtomicU64::new(0);
static MOUSE_CALLS: AtomicU64 = AtomicU64::new(0);
static LEFT_DOWNS: AtomicU64 = AtomicU64::new(0);
static LEFT_UPS: AtomicU64 = AtomicU64::new(0);
static LEFT_CLICKS_DISPATCHED: AtomicU64 = AtomicU64::new(0);
static LONGEST_MOUSE_CALL_US: AtomicU64 = AtomicU64::new(0);
static SLOW_MOUSE_CALLS: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES: AtomicU64 = AtomicU64::new(0);
static LONGEST_PRE_CAPTURE_US: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_WITHOUT_ELEMENT: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_ANSWERED_WITHOUT_ELEMENT: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_WITHOUT_PRE_CAPTURE: AtomicU64 = AtomicU64::new(0);
static DEEPEST_MOUSE_NESTING: AtomicU64 = AtomicU64::new(0);
static LONGEST_WIN_EVENT_US: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_ANSWERED: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_OVERRAN: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_SKIPPED_HELD: AtomicU64 = AtomicU64::new(0);
static PRE_CAPTURES_SKIPPED_BUSY: AtomicU64 = AtomicU64::new(0);
static DESCRIBERS_ABANDONED: AtomicU64 = AtomicU64::new(0);
static DESCRIBER_CLIENTS_NOT_BUILT: AtomicU64 = AtomicU64::new(0);
static INPUT_METHOD_READ_LIMIT_MS: AtomicU64 = AtomicU64::new(0);
static INPUT_METHOD_READS: AtomicU64 = AtomicU64::new(0);
static INPUT_METHOD_READS_ANSWERED: AtomicU64 = AtomicU64::new(0);
static INPUT_METHOD_READS_OPEN_STATUS_ALONE: AtomicU64 = AtomicU64::new(0);
static INPUT_METHOD_READS_UNANSWERED: AtomicU64 = AtomicU64::new(0);
static INPUT_METHOD_READS_WITHOUT_WINDOW: AtomicU64 = AtomicU64::new(0);
static LONGEST_INPUT_METHOD_READ_US: AtomicU64 = AtomicU64::new(0);

/// How the keyboard hook's read of the input method at one key press ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMethodReadOutcome {
    /// Both questions were answered.
    Answered,
    /// The open status was answered, the conversion mode was not.
    OpenStatusAlone,
    /// The first question got no answer within the limit, or was refused.
    NoAnswer,
    /// The control had no input-method window, so nothing was asked.
    NoWindow,
}

/// A snapshot of the counters.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct HookDiagnostics {
    /// The session's low-level hook timeout, in milliseconds (0 before a
    /// session sets it).
    pub hook_timeout_ms: u64,
    /// The session's pre-capture budget, in milliseconds.
    pub pre_capture_budget_ms: u64,
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
    /// Mouse hook calls that took the hook timeout or longer.
    pub slow_mouse_calls: u64,
    /// Click pre-captures asked for.
    pub pre_captures: u64,
    /// The longest a hook waited for a pre-capture, in microseconds.
    pub longest_pre_capture_us: u64,
    /// Pre-captures that gave the click no element, for any reason: the
    /// clicks that took the late path.
    pub pre_captures_without_element: u64,
    /// Of those, answers within the budget that described nothing.
    pub pre_captures_answered_without_element: u64,
    /// Of those, clicks with no pre-capture running.
    pub pre_captures_without_pre_capture: u64,
    /// The deepest a mouse hook call ran inside another (1 = never nested).
    pub deepest_mouse_nesting: u64,
    /// The longest single WinEvent callback on the input thread, in
    /// microseconds.
    pub longest_win_event_us: u64,
    /// Pre-captures answered within the budget, with or without an element.
    pub pre_captures_answered: u64,
    /// Pre-captures whose answer did not come within the budget.
    pub pre_captures_overran: u64,
    /// Pre-captures that waited out the budget for their application to
    /// release a describer.
    pub pre_captures_skipped_held: u64,
    /// Pre-captures that waited out the budget for a describer to come free.
    pub pre_captures_skipped_busy: u64,
    /// Describers left to an application that did not answer.
    pub describers_abandoned: u64,
    /// Describers whose accessibility client could not be built.
    pub describer_clients_not_built: u64,
    /// The session's time limit for one question to an input-method window,
    /// in milliseconds; 0 where the session asks none.
    pub input_method_read_limit_ms: u64,
    /// Key presses the keyboard hook read the input method at, however the
    /// read ended. A session whose limit is 0 has none.
    pub input_method_reads: u64,
    /// Of those, reads with both answers.
    pub input_method_reads_answered: u64,
    /// Of those, reads with the open status and no conversion mode.
    pub input_method_reads_open_status_alone: u64,
    /// Of those, reads whose first question got no answer.
    pub input_method_reads_unanswered: u64,
    /// Of those, key presses on a control with no input-method window.
    pub input_method_reads_without_window: u64,
    /// The longest the keyboard hook spent on one read, in microseconds.
    pub longest_input_method_read_us: u64,
}

fn micros(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX)
}

/// The hook timeout the slow bound uses: the session's, or the default
/// before a session set one.
fn slow_bound_ms(hook_timeout_ms: u64) -> u64 {
    if hook_timeout_ms == 0 {
        HOOK_TIMEOUT_DEFAULT_MS
    } else {
        hook_timeout_ms
    }
}

/// Zero every counter: a capture session starts.
pub fn reset() {
    for counter in [
        &HOOK_TIMEOUT_MS,
        &PRE_CAPTURE_BUDGET_MS,
        &MOUSE_CALLS,
        &LEFT_DOWNS,
        &LEFT_UPS,
        &LEFT_CLICKS_DISPATCHED,
        &LONGEST_MOUSE_CALL_US,
        &SLOW_MOUSE_CALLS,
        &PRE_CAPTURES,
        &LONGEST_PRE_CAPTURE_US,
        &PRE_CAPTURES_WITHOUT_ELEMENT,
        &PRE_CAPTURES_ANSWERED_WITHOUT_ELEMENT,
        &PRE_CAPTURES_WITHOUT_PRE_CAPTURE,
        &DEEPEST_MOUSE_NESTING,
        &LONGEST_WIN_EVENT_US,
        &PRE_CAPTURES_ANSWERED,
        &PRE_CAPTURES_OVERRAN,
        &PRE_CAPTURES_SKIPPED_HELD,
        &PRE_CAPTURES_SKIPPED_BUSY,
        &DESCRIBERS_ABANDONED,
        &DESCRIBER_CLIENTS_NOT_BUILT,
        &INPUT_METHOD_READ_LIMIT_MS,
        &INPUT_METHOD_READS,
        &INPUT_METHOD_READS_ANSWERED,
        &INPUT_METHOD_READS_OPEN_STATUS_ALONE,
        &INPUT_METHOD_READS_UNANSWERED,
        &INPUT_METHOD_READS_WITHOUT_WINDOW,
        &LONGEST_INPUT_METHOD_READ_US,
    ] {
        counter.store(0, Ordering::Relaxed);
    }
}

/// The counters as they stand.
pub fn snapshot() -> HookDiagnostics {
    HookDiagnostics {
        hook_timeout_ms: HOOK_TIMEOUT_MS.load(Ordering::Relaxed),
        pre_capture_budget_ms: PRE_CAPTURE_BUDGET_MS.load(Ordering::Relaxed),
        mouse_calls: MOUSE_CALLS.load(Ordering::Relaxed),
        left_downs: LEFT_DOWNS.load(Ordering::Relaxed),
        left_ups: LEFT_UPS.load(Ordering::Relaxed),
        left_clicks_dispatched: LEFT_CLICKS_DISPATCHED.load(Ordering::Relaxed),
        longest_mouse_call_us: LONGEST_MOUSE_CALL_US.load(Ordering::Relaxed),
        slow_mouse_calls: SLOW_MOUSE_CALLS.load(Ordering::Relaxed),
        pre_captures: PRE_CAPTURES.load(Ordering::Relaxed),
        longest_pre_capture_us: LONGEST_PRE_CAPTURE_US.load(Ordering::Relaxed),
        pre_captures_without_element: PRE_CAPTURES_WITHOUT_ELEMENT.load(Ordering::Relaxed),
        pre_captures_answered_without_element: PRE_CAPTURES_ANSWERED_WITHOUT_ELEMENT
            .load(Ordering::Relaxed),
        pre_captures_without_pre_capture: PRE_CAPTURES_WITHOUT_PRE_CAPTURE.load(Ordering::Relaxed),
        deepest_mouse_nesting: DEEPEST_MOUSE_NESTING.load(Ordering::Relaxed),
        longest_win_event_us: LONGEST_WIN_EVENT_US.load(Ordering::Relaxed),
        pre_captures_answered: PRE_CAPTURES_ANSWERED.load(Ordering::Relaxed),
        pre_captures_overran: PRE_CAPTURES_OVERRAN.load(Ordering::Relaxed),
        pre_captures_skipped_held: PRE_CAPTURES_SKIPPED_HELD.load(Ordering::Relaxed),
        pre_captures_skipped_busy: PRE_CAPTURES_SKIPPED_BUSY.load(Ordering::Relaxed),
        describers_abandoned: DESCRIBERS_ABANDONED.load(Ordering::Relaxed),
        describer_clients_not_built: DESCRIBER_CLIENTS_NOT_BUILT.load(Ordering::Relaxed),
        input_method_read_limit_ms: INPUT_METHOD_READ_LIMIT_MS.load(Ordering::Relaxed),
        input_method_reads: INPUT_METHOD_READS.load(Ordering::Relaxed),
        input_method_reads_answered: INPUT_METHOD_READS_ANSWERED.load(Ordering::Relaxed),
        input_method_reads_open_status_alone: INPUT_METHOD_READS_OPEN_STATUS_ALONE
            .load(Ordering::Relaxed),
        input_method_reads_unanswered: INPUT_METHOD_READS_UNANSWERED.load(Ordering::Relaxed),
        input_method_reads_without_window: INPUT_METHOD_READS_WITHOUT_WINDOW
            .load(Ordering::Relaxed),
        longest_input_method_read_us: LONGEST_INPUT_METHOD_READ_US.load(Ordering::Relaxed),
    }
}

/// Store the session's hook timeout, pre-capture budget and time limit for
/// one question to an input-method window: a session starts.
pub fn session_bounds(
    hook_timeout_ms: u64,
    pre_capture_budget_ms: u64,
    input_method_read_limit_ms: u64,
) {
    HOOK_TIMEOUT_MS.store(hook_timeout_ms, Ordering::Relaxed);
    PRE_CAPTURE_BUDGET_MS.store(pre_capture_budget_ms, Ordering::Relaxed);
    INPUT_METHOD_READ_LIMIT_MS.store(input_method_read_limit_ms, Ordering::Relaxed);
}

/// The keyboard hook read the input method at a key press, which took
/// `elapsed` and ended as `outcome`.
pub fn input_method_read(elapsed: Duration, outcome: InputMethodReadOutcome) {
    INPUT_METHOD_READS.fetch_add(1, Ordering::Relaxed);
    LONGEST_INPUT_METHOD_READ_US.fetch_max(micros(elapsed), Ordering::Relaxed);
    let counter = match outcome {
        InputMethodReadOutcome::Answered => &INPUT_METHOD_READS_ANSWERED,
        InputMethodReadOutcome::OpenStatusAlone => &INPUT_METHOD_READS_OPEN_STATUS_ALONE,
        InputMethodReadOutcome::NoAnswer => &INPUT_METHOD_READS_UNANSWERED,
        InputMethodReadOutcome::NoWindow => &INPUT_METHOD_READS_WITHOUT_WINDOW,
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

/// Store the pre-capture's outcome counts: its input thread ends.
pub fn pre_capture_outcomes(counts: PreCaptureCounts) {
    PRE_CAPTURES_ANSWERED.store(counts.answered, Ordering::Relaxed);
    PRE_CAPTURES_OVERRAN.store(counts.overran, Ordering::Relaxed);
    PRE_CAPTURES_SKIPPED_HELD.store(counts.skipped_held, Ordering::Relaxed);
    PRE_CAPTURES_SKIPPED_BUSY.store(counts.skipped_busy, Ordering::Relaxed);
    DESCRIBERS_ABANDONED.store(counts.abandoned, Ordering::Relaxed);
    DESCRIBER_CLIENTS_NOT_BUILT.store(counts.clients_not_built, Ordering::Relaxed);
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
    let slow = Duration::from_millis(slow_bound_ms(HOOK_TIMEOUT_MS.load(Ordering::Relaxed)));
    if elapsed >= slow {
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

/// A pre-capture took `elapsed` and ended with `outcome`.
pub fn pre_capture(elapsed: Duration, outcome: PreCaptureOutcome) {
    PRE_CAPTURES.fetch_add(1, Ordering::Relaxed);
    LONGEST_PRE_CAPTURE_US.fetch_max(micros(elapsed), Ordering::Relaxed);
    if outcome != PreCaptureOutcome::Element {
        PRE_CAPTURES_WITHOUT_ELEMENT.fetch_add(1, Ordering::Relaxed);
    }
    match outcome {
        PreCaptureOutcome::AnsweredWithoutElement => {
            PRE_CAPTURES_ANSWERED_WITHOUT_ELEMENT.fetch_add(1, Ordering::Relaxed);
        }
        PreCaptureOutcome::NoPreCapture => {
            PRE_CAPTURES_WITHOUT_PRE_CAPTURE.fetch_add(1, Ordering::Relaxed);
        }
        PreCaptureOutcome::Element | PreCaptureOutcome::NoAnswer => {}
    }
}

/// A WinEvent callback on the input thread returned after `elapsed`.
pub fn win_event_returned(elapsed: Duration) {
    LONGEST_WIN_EVENT_US.fetch_max(micros(elapsed), Ordering::Relaxed);
}

impl HookDiagnostics {
    /// Whether something in the session could have cost input: a hook call
    /// or a WinEvent callback that took the session's hook timeout or longer
    /// (the designed wait, the budget, ends a margin before it), or a hook
    /// call that ran inside another.
    pub fn is_anomalous(&self) -> bool {
        let slow = slow_bound_ms(self.hook_timeout_ms) * 1000;
        self.longest_mouse_call_us >= slow
            || self.longest_win_event_us >= slow
            || self.longest_input_method_read_us >= slow
            || self.deepest_mouse_nesting > 1
    }

    /// Clicks that took the late path: the pre-capture gave them no element,
    /// for any reason, and their workers describe them (DCP-1, DCP-13).
    pub fn late_path_clicks(&self) -> u64 {
        self.pre_captures_without_element
    }

    /// Key presses that carry less than the whole read of the input method
    /// because a question got no answer: the open status alone, or nothing.
    pub fn keys_short_of_an_answer(&self) -> u64 {
        self.input_method_reads_unanswered + self.input_method_reads_open_status_alone
    }

    /// The one line logged at stop: a warning when the session [is
    /// anomalous](Self::is_anomalous), a note when it is not but clicks took
    /// the late path or an input-method window left a question unanswered,
    /// `None` otherwise.
    pub fn report(&self) -> Option<String> {
        let counts = format!(
            "hook timeout {} ms, pre-capture budget {} ms; left presses {}, left \
             releases {}, left clicks dispatched {}, hook calls {} ({} slow, \
             longest {} ms, deepest nesting {}), pre-captures {} ({} without an \
             element: {} answered without one, {} with no pre-capture running; {} \
             answered, {} overran, {} waited out for a held application, {} \
             waited out for a free describer, longest {} ms; {} describers left \
             to an application, {} describer clients not built), longest \
             WinEvent callback {} ms, input-method reads {} (limit {} ms a \
             question; {} answered, {} with the open status alone, {} \
             unanswered, {} with no input-method window, longest {} ms)",
            self.hook_timeout_ms,
            self.pre_capture_budget_ms,
            self.left_downs,
            self.left_ups,
            self.left_clicks_dispatched,
            self.mouse_calls,
            self.slow_mouse_calls,
            self.longest_mouse_call_us / 1000,
            self.deepest_mouse_nesting,
            self.pre_captures,
            self.pre_captures_without_element,
            self.pre_captures_answered_without_element,
            self.pre_captures_without_pre_capture,
            self.pre_captures_answered,
            self.pre_captures_overran,
            self.pre_captures_skipped_held,
            self.pre_captures_skipped_busy,
            self.longest_pre_capture_us / 1000,
            self.describers_abandoned,
            self.describer_clients_not_built,
            self.longest_win_event_us / 1000,
            self.input_method_reads,
            self.input_method_read_limit_ms,
            self.input_method_reads_answered,
            self.input_method_reads_open_status_alone,
            self.input_method_reads_unanswered,
            self.input_method_reads_without_window,
            self.longest_input_method_read_us / 1000,
        );
        if self.is_anomalous() {
            Some(format!(
                "[WindowsCapture] Warning: a hook call reached the system's \
                 hook timeout this session (input may have been passed on without \
                 it): {counts}"
            ))
        } else if self.late_path_clicks() > 0 {
            Some(format!(
                "[WindowsCapture] {} click(s) got no pre-captured element and were \
                 described by their workers after the click: {counts}",
                self.late_path_clicks()
            ))
        } else if self.keys_short_of_an_answer() > 0 {
            Some(format!(
                "[WindowsCapture] {} key press(es) carry less than the whole read \
                 of the input method, a question to its window getting no answer \
                 in time: {counts}",
                self.keys_short_of_an_answer()
            ))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT_MS: u64 = 300;
    const BUDGET_MS: u64 = 250;

    fn quiet() -> HookDiagnostics {
        HookDiagnostics {
            hook_timeout_ms: TIMEOUT_MS,
            pre_capture_budget_ms: BUDGET_MS,
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
    fn a_hook_call_at_the_hook_timeout_is_reported_with_the_counts() {
        let diagnostics = HookDiagnostics {
            longest_mouse_call_us: TIMEOUT_MS * 1000,
            slow_mouse_calls: 1,
            left_ups: 1,
            ..quiet()
        };
        let line = diagnostics.report().expect("a slow hook call is reported");
        assert!(line.contains("left releases 1"), "{line}");
        assert!(line.contains("1 slow, longest 300 ms"), "{line}");
        assert!(
            line.contains("hook timeout 300 ms, pre-capture budget 250 ms"),
            "{line}"
        );
        assert!(line.contains("Warning"), "{line}");
        let just_under = HookDiagnostics {
            longest_mouse_call_us: TIMEOUT_MS * 1000 - 1,
            ..quiet()
        };
        assert_eq!(just_under.report(), None);
    }

    // Regression: #741 review — a click that waited out the whole pre-capture
    // budget is the designed late path, not a hook that may have cost input.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_a_hook_call_that_waited_out_the_budget_is_a_late_path_note_not_a_warning() {
        let late = HookDiagnostics {
            longest_mouse_call_us: (BUDGET_MS + 20) * 1000,
            longest_pre_capture_us: BUDGET_MS * 1000,
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
            line.contains("3 answered, 1 overran, 1 waited out for a held application"),
            "{line}"
        );
    }

    // Regression: #741 review — every click the pre-capture gave no element
    // is a late-path click, an answer that described nothing and a click with
    // no pre-capture running among them.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_clicks_answered_without_an_element_or_with_no_pre_capture_are_late_path_clicks(
    ) {
        let _counters = TEST_COUNTERS.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        pre_capture(Duration::from_millis(1), PreCaptureOutcome::Element);
        pre_capture(
            Duration::from_millis(1),
            PreCaptureOutcome::AnsweredWithoutElement,
        );
        pre_capture(Duration::from_millis(1), PreCaptureOutcome::NoPreCapture);
        pre_capture(Duration::from_millis(1), PreCaptureOutcome::NoAnswer);
        let seen = snapshot();
        reset();
        assert_eq!(seen.late_path_clicks(), 3, "{seen:?}");
        assert_eq!(
            (
                seen.pre_captures_answered_without_element,
                seen.pre_captures_without_pre_capture
            ),
            (1, 1)
        );
        let line = seen.report().expect("late-path clicks are noted");
        assert!(
            line.contains("3 click(s) got no pre-captured element"),
            "{line}"
        );
        assert!(
            line.contains(
                "3 without an element: 1 answered without one, 1 with no pre-capture running"
            ),
            "{line}"
        );
    }

    #[test]
    fn before_a_session_sets_its_timeout_the_default_is_the_slow_bound() {
        let unset = HookDiagnostics {
            hook_timeout_ms: 0,
            longest_mouse_call_us: HOOK_TIMEOUT_DEFAULT_MS * 1000,
            ..quiet()
        };
        assert!(unset.is_anomalous());
    }

    #[test]
    fn a_slow_win_event_callback_and_a_nested_hook_call_are_reported() {
        let slow_callback = HookDiagnostics {
            longest_win_event_us: TIMEOUT_MS * 1000,
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
        session_bounds(TIMEOUT_MS, BUDGET_MS, 20);
        mouse_call_entered(1);
        mouse_call_entered(2);
        mouse_call_returned(Duration::from_millis(TIMEOUT_MS + 50));
        mouse_call_returned(Duration::from_millis(BUDGET_MS + 10));
        left_down();
        left_up();
        left_click_dispatched();
        pre_capture(Duration::from_millis(120), PreCaptureOutcome::NoAnswer);
        win_event_returned(Duration::from_millis(7));
        input_method_read(Duration::from_micros(300), InputMethodReadOutcome::Answered);
        input_method_read(Duration::from_millis(21), InputMethodReadOutcome::NoAnswer);
        input_method_read(
            Duration::from_millis(20),
            InputMethodReadOutcome::OpenStatusAlone,
        );
        input_method_read(Duration::from_micros(5), InputMethodReadOutcome::NoWindow);
        pre_capture_outcomes(PreCaptureCounts {
            answered: 4,
            overran: 1,
            skipped_held: 2,
            skipped_busy: 3,
            abandoned: 1,
            clients_not_built: 2,
            longest_wait_us: 0,
        });
        let seen = snapshot();
        assert_eq!(
            seen,
            HookDiagnostics {
                hook_timeout_ms: TIMEOUT_MS,
                pre_capture_budget_ms: BUDGET_MS,
                mouse_calls: 2,
                left_downs: 1,
                left_ups: 1,
                left_clicks_dispatched: 1,
                longest_mouse_call_us: (TIMEOUT_MS + 50) * 1000,
                slow_mouse_calls: 1,
                pre_captures: 1,
                longest_pre_capture_us: 120_000,
                pre_captures_without_element: 1,
                pre_captures_answered_without_element: 0,
                pre_captures_without_pre_capture: 0,
                deepest_mouse_nesting: 2,
                longest_win_event_us: 7_000,
                pre_captures_answered: 4,
                pre_captures_overran: 1,
                pre_captures_skipped_held: 2,
                pre_captures_skipped_busy: 3,
                describers_abandoned: 1,
                describer_clients_not_built: 2,
                input_method_read_limit_ms: 20,
                input_method_reads: 4,
                input_method_reads_answered: 1,
                input_method_reads_open_status_alone: 1,
                input_method_reads_unanswered: 1,
                input_method_reads_without_window: 1,
                longest_input_method_read_us: 21_000,
            }
        );
        reset();
        assert_eq!(snapshot(), HookDiagnostics::default());
    }

    // Regression: #237 — the keyboard hook's waits on an input-method window
    // show in the line logged at stop: a question left unanswered is noted,
    // and a read that reached the hook timeout is a warning.
    // https://github.com/Arsarneq/docent/issues/237
    #[test]
    fn regression_237_input_method_reads_short_of_an_answer_are_noted_and_a_slow_one_warned_of() {
        let answered = HookDiagnostics {
            input_method_read_limit_ms: 20,
            input_method_reads: 5,
            input_method_reads_answered: 4,
            input_method_reads_without_window: 1,
            ..quiet()
        };
        assert_eq!(answered.report(), None);
        let short = HookDiagnostics {
            input_method_reads: 5,
            input_method_reads_answered: 2,
            input_method_reads_open_status_alone: 1,
            input_method_reads_unanswered: 2,
            input_method_reads_without_window: 0,
            longest_input_method_read_us: 40_000,
            ..answered
        };
        assert!(!short.is_anomalous());
        let line = short.report().expect("unanswered questions are noted");
        assert!(!line.contains("Warning"), "{line}");
        assert!(line.contains("3 key press(es) carry less"), "{line}");
        assert!(
            line.contains(
                "input-method reads 5 (limit 20 ms a question; 2 answered, 1 with the open \
                 status alone, 2 unanswered, 0 with no input-method window, longest 40 ms)"
            ),
            "{line}"
        );
        let slow = HookDiagnostics {
            longest_input_method_read_us: TIMEOUT_MS * 1000,
            ..answered
        };
        assert!(slow.is_anomalous());
        assert!(slow.report().unwrap().contains("Warning"));
    }
}
