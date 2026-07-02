// Coordinate helper correctness — PURE-HELPER property tests.
//
// SCOPE (be precise about what this suite proves): these tests exercise the
// coordinate module's pure functions (`relative_coordinates`,
// `fallback_element`, `create_window_rect`) **in isolation**, feeding each
// helper's output into the next. The production wiring is deliberately NOT in
// the loop here — and in the live pipeline `relative_coordinates` currently
// has no callers at all: emitted actions and `coord:` selectors carry raw
// SCREEN coordinates, not window-relative ones (issue #141 tracks wiring
// window-relative capture under new named fields). The pipeline-level truth is
// locked by worker_pool_test.rs, which uses a non-origin mock window rect so
// screen and window-relative values can never be confused.
//
// What these properties DO prove, for same-space inputs:
// - `relative_coordinates(abs, win)` is (abs_x - win_x, abs_y - win_y).
// - `window_rect` round-trips { x, y, width, height } verbatim.
// - The fallback `element` has tag: "unknown", name: window_title, id: null,
//   role: null, type: null, text: null, and selector: "coord:{x},{y}" encoding
//   exactly the point it was given.

use docent_desktop_lib::capture::coordinate::{
    create_window_rect, fallback_element, relative_coordinates,
};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// Strategy for coordinate values — covers a wide range including negatives
/// (windows can be positioned off-screen on multi-monitor setups).
fn arb_coord() -> impl Strategy<Value = i32> {
    -10_000..=10_000i32
}

/// Strategy for positive dimension values (width, height).
fn arb_dimension() -> impl Strategy<Value = i32> {
    1..=10_000i32
}

/// Strategy for window titles — mix of empty, ASCII, and Unicode strings.
fn arb_window_title() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(String::new()),
        "[a-zA-Z0-9 _\\-\\.]{1,100}",
        "\\PC{1,50}",
    ]
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Coordinate fallback correctness
    ///
    /// For any (abs_x, abs_y, win_x, win_y, win_w, win_h, title) tuple:
    /// - `relative_coordinates` returns (abs_x - win_x, abs_y - win_y)
    /// - `create_window_rect` returns a rect matching the input values
    /// - `fallback_element` returns an element with the correct fallback fields
    #[test]
    fn coordinate_fallback_correctness(
        abs_x in arb_coord(),
        abs_y in arb_coord(),
        win_x in arb_coord(),
        win_y in arb_coord(),
        win_w in arb_dimension(),
        win_h in arb_dimension(),
        title in arb_window_title(),
    ) {
        // -- Relative coordinates -------------------------------------------
        let (rel_x, rel_y) = relative_coordinates(abs_x, abs_y, win_x, win_y);
        let expected_rx = abs_x - win_x;
        let expected_ry = abs_y - win_y;

        prop_assert_eq!(
            rel_x, expected_rx,
            "rel_x: expected {} (abs_x={} - win_x={}), got {}",
            expected_rx, abs_x, win_x, rel_x
        );
        prop_assert_eq!(
            rel_y, expected_ry,
            "rel_y: expected {} (abs_y={} - win_y={}), got {}",
            expected_ry, abs_y, win_y, rel_y
        );

        // -- Window rect ----------------------------------------------------
        let rect = create_window_rect(win_x, win_y, win_w, win_h);

        prop_assert_eq!(rect.x, win_x, "window_rect.x must equal win_x");
        prop_assert_eq!(rect.y, win_y, "window_rect.y must equal win_y");
        prop_assert_eq!(rect.width, win_w, "window_rect.width must equal win_w");
        prop_assert_eq!(rect.height, win_h, "window_rect.height must equal win_h");

        // -- Fallback element -----------------------------------------------
        let el = fallback_element(&title, rel_x, rel_y);

        prop_assert_eq!(
            &el.tag, "unknown",
            "fallback element tag must be \"unknown\""
        );
        prop_assert_eq!(
            el.name.as_deref(),
            Some(title.as_str()),
            "fallback element name must equal the window title"
        );
        prop_assert!(
            el.id.is_none(),
            "fallback element id must be None"
        );
        prop_assert!(
            el.role.is_none(),
            "fallback element role must be None"
        );
        prop_assert!(
            el.element_type.is_none(),
            "fallback element type must be None"
        );
        prop_assert!(
            el.text.is_none(),
            "fallback element text must be None"
        );

        let expected_selector = format!("coord:{},{}", rel_x, rel_y);
        prop_assert_eq!(
            &el.selector, &expected_selector,
            "fallback element selector must be \"coord:{},{}\"",
            rel_x, rel_y
        );
    }
}
