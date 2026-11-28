//! The capture timings switch, read from the environment at capture start.
//!
//! One test in a binary of its own: it sets the process's environment, which
//! no other test may read at the same time.

use docent_desktop_lib::capture::timing_lines::{Timings, SWITCH_VARIABLE};

/// `1` turns the timings on; nothing, `0` or any other value leaves them off.
#[test]
fn the_timings_are_on_only_where_the_switch_is_1() {
    std::env::remove_var(SWITCH_VARIABLE);
    assert!(!Timings::from_environment().is_on(), "unset");
    for (value, on) in [("1", true), ("0", false), ("yes", false), (" 1", false)] {
        std::env::set_var(SWITCH_VARIABLE, value);
        assert_eq!(Timings::from_environment().is_on(), on, "{value:?}");
    }
    std::env::remove_var(SWITCH_VARIABLE);
}
