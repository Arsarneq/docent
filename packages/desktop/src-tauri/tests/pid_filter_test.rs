// Self-capture PID filtering
//
// `should_keep_event` is the platform-agnostic base rule behind the desktop
// capture layer's self-capture-exclusion and resolvable-window scope filters
// (DCP-5). It keeps an event exactly when both rules admit it:
//
// - **Resolvable window** — PID 0 names a window that was already destroyed or
//   could not be resolved, so an event carrying it is always discarded,
//   whether or not self-capture exclusion is enabled.
// - **Self-capture exclusion** — while exclusion is enabled (the excluded PID
//   is `Some`), events from that process are discarded; with exclusion
//   disabled (`None`), every resolvable PID is kept.
//
// The Windows module applies this base rule first and layers the rest of the
// platform's self-capture grounds on top — Docent's own process tree,
// processes recognized by executable name, and processes whose window is owned
// by an excluded process's window — alongside the target-application filter,
// which is its own PID comparison there.

use docent_desktop_lib::capture::scroll::should_keep_event;
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Self-capture PID filtering
    ///
    /// When exclusion is enabled (excluded_pid is Some) and the event PID
    /// matches the excluded PID, the event is discarded (should_keep_event
    /// returns false). The claim is true across the whole PID domain — at
    /// PID 0 both rules agree on discarding — while this strategy's draws are
    /// effectively all nonzero; `pid_zero_is_always_discarded` is what pins
    /// the PID-0 case.
    #[test]
    fn matching_pid_is_discarded(pid in any::<u32>()) {
        let result = should_keep_event(pid, Some(pid));
        prop_assert!(
            !result,
            "event from PID {} should be discarded when excluded PID is {}",
            pid, pid
        );
    }

    /// Self-capture PID filtering
    ///
    /// When exclusion is enabled but a resolvable (nonzero) event PID does
    /// NOT match the excluded PID, the event is kept.
    #[test]
    fn nonzero_non_matching_pid_is_kept(
        event_pid in 1..=u32::MAX,
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

    /// Self-capture PID filtering
    ///
    /// When exclusion is disabled (excluded_pid is None), every event from a
    /// resolvable (nonzero) PID is kept.
    #[test]
    fn no_exclusion_keeps_all_nonzero_pids(event_pid in 1..=u32::MAX) {
        let result = should_keep_event(event_pid, None);
        prop_assert!(
            result,
            "event from PID {} should be kept when exclusion is disabled",
            event_pid
        );
    }

    /// Self-capture PID filtering — the resolvable-window rule
    ///
    /// PID 0 (a destroyed or unresolvable window) is discarded for every
    /// exclusion setting, so no excluded-PID value can make such an event
    /// enter the recording.
    #[test]
    fn pid_zero_is_always_discarded(excluded in any::<Option<u32>>()) {
        let result = should_keep_event(0, excluded);
        prop_assert!(
            !result,
            "event from PID 0 should be discarded when excluded PID is {:?}",
            excluded
        );
    }

    /// Self-capture PID filtering
    ///
    /// For any (event_pid, excluded_pid, exclusion_enabled) triple, the
    /// filtering decision matches the total model: an event is kept iff its
    /// PID is nonzero AND exclusion is disabled or the PIDs differ. The event
    /// PID is drawn from a strategy that includes 0 outright — `any::<u32>()`
    /// alone effectively never draws it, which would leave the
    /// resolvable-window half of the model unexercised.
    #[test]
    fn filtering_is_consistent(
        event_pid in prop_oneof![1 => Just(0u32), 4 => any::<u32>()],
        excluded_pid in any::<u32>(),
        exclusion_enabled in any::<bool>(),
    ) {
        let excluded = if exclusion_enabled {
            Some(excluded_pid)
        } else {
            None
        };

        let result = should_keep_event(event_pid, excluded);

        let expected = event_pid != 0 && (!exclusion_enabled || event_pid != excluded_pid);

        prop_assert_eq!(
            result,
            expected,
            "should_keep_event({}, {:?}) = {} but expected {}",
            event_pid, excluded, result, expected
        );
    }
}
