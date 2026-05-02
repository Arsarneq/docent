// Property 12: Self-capture PID filtering
//
// **Validates: Requirements 16.1, 16.3**
//
// For any action event, when self-capture exclusion is enabled and the
// event's source process ID matches the excluded PID, the event shall be
// discarded. When self-capture exclusion is disabled, no events shall be
// discarded based on PID.

use docent_desktop_lib::capture::scroll::should_keep_event;
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Feature: desktop-capture, Property 12: Self-capture PID filtering
    ///
    /// **Validates: Requirements 16.1, 16.3**
    ///
    /// When exclusion is enabled (excluded_pid is Some) and the event PID
    /// matches the excluded PID, the event is discarded (should_keep_event
    /// returns false).
    #[test]
    fn matching_pid_is_discarded(pid in any::<u32>()) {
        let result = should_keep_event(pid, Some(pid));
        prop_assert!(
            !result,
            "event from PID {} should be discarded when excluded PID is {}",
            pid, pid
        );
    }

    /// Feature: desktop-capture, Property 12: Self-capture PID filtering
    ///
    /// **Validates: Requirements 16.1, 16.3**
    ///
    /// When exclusion is enabled but the event PID does NOT match the
    /// excluded PID, the event is kept.
    #[test]
    fn non_matching_pid_is_kept(
        event_pid in any::<u32>(),
        excluded_pid in any::<u32>(),
    ) {
        prop_assume!(event_pid != excluded_pid);
        let result = should_keep_event(event_pid, Some(excluded_pid));
        prop_assert!(
            result,
            "event from PID {} should be kept when excluded PID is {}",
            event_pid, excluded_pid
        );
    }

    /// Feature: desktop-capture, Property 12: Self-capture PID filtering
    ///
    /// **Validates: Requirements 16.3**
    ///
    /// When exclusion is disabled (excluded_pid is None), ALL events are
    /// kept regardless of their PID.
    #[test]
    fn no_exclusion_keeps_all(event_pid in any::<u32>()) {
        let result = should_keep_event(event_pid, None);
        prop_assert!(
            result,
            "event from PID {} should be kept when exclusion is disabled",
            event_pid
        );
    }

    /// Feature: desktop-capture, Property 12: Self-capture PID filtering
    ///
    /// **Validates: Requirements 16.1, 16.3**
    ///
    /// For any (event_pid, excluded_pid, exclusion_enabled) triple, the
    /// filtering decision is consistent: discard iff exclusion is enabled
    /// AND PIDs match.
    #[test]
    fn filtering_is_consistent(
        event_pid in any::<u32>(),
        excluded_pid in any::<u32>(),
        exclusion_enabled in any::<bool>(),
    ) {
        let excluded = if exclusion_enabled {
            Some(excluded_pid)
        } else {
            None
        };

        let result = should_keep_event(event_pid, excluded);

        let expected = if exclusion_enabled {
            event_pid != excluded_pid
        } else {
            true
        };

        prop_assert_eq!(
            result,
            expected,
            "should_keep_event({}, {:?}) = {} but expected {}",
            event_pid, excluded, result, expected
        );
    }
}
