// Property 3: Capture mode selection
//
// **Validates: Requirements 2a.2, 2a.3, 2a.8**
//
// For any positional interaction where the accessibility API resolves a
// specific control type (not a top-level window or generic pane), the
// resulting action has `capture_mode: "accessibility"`. For any positional
// interaction where the accessibility API resolves only a top-level window
// or generic pane, the resulting action has `capture_mode: "coordinate"`.

use docent_desktop_lib::capture::coordinate::determine_capture_mode;
use docent_desktop_lib::capture::CaptureMode;
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Constants — Windows UIA control type IDs for generic containers
// ---------------------------------------------------------------------------

/// Windows UIA control type ID for `Window`.
const UIA_WINDOW_CONTROL_TYPE_ID: i32 = 50032;

/// Windows UIA control type ID for `Pane`.
const UIA_PANE_CONTROL_TYPE_ID: i32 = 50033;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// Strategy for specific (non-generic) control type IDs.
///
/// Generates IDs from the known UIA range (50000–50040) excluding the two
/// generic container types (Window=50032, Pane=50033), plus arbitrary i32
/// values that are also not 50032 or 50033.
fn arb_specific_control_type_id() -> impl Strategy<Value = i32> {
    prop_oneof![
        // Known specific control type IDs (50000–50031, 50034–50040)
        (50000..=50031i32),
        (50034..=50040i32),
        // Arbitrary IDs that are not generic containers
        prop::num::i32::ANY
            .prop_filter("must not be Window or Pane", |id| {
                *id != UIA_WINDOW_CONTROL_TYPE_ID && *id != UIA_PANE_CONTROL_TYPE_ID
            }),
    ]
}

/// Strategy for generic container control type IDs (Window or Pane).
fn arb_generic_control_type_id() -> impl Strategy<Value = i32> {
    prop_oneof![
        Just(UIA_WINDOW_CONTROL_TYPE_ID),
        Just(UIA_PANE_CONTROL_TYPE_ID),
    ]
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Feature: desktop-capture, Property 3: Capture mode selection
    ///
    /// **Validates: Requirements 2a.2, 2a.3, 2a.8**
    ///
    /// For any specific control type ID (not Window=50032 or Pane=50033),
    /// `determine_capture_mode` returns `CaptureMode::Accessibility`.
    #[test]
    fn specific_control_produces_accessibility_mode(id in arb_specific_control_type_id()) {
        let mode = determine_capture_mode(id);
        prop_assert_eq!(
            mode,
            CaptureMode::Accessibility,
            "control type {} should produce Accessibility mode",
            id
        );
    }

    /// Feature: desktop-capture, Property 3: Capture mode selection
    ///
    /// **Validates: Requirements 2a.2, 2a.3, 2a.8**
    ///
    /// For any generic container control type ID (Window=50032 or Pane=50033),
    /// `determine_capture_mode` returns `CaptureMode::Coordinate`.
    #[test]
    fn generic_container_produces_coordinate_mode(id in arb_generic_control_type_id()) {
        let mode = determine_capture_mode(id);
        prop_assert_eq!(
            mode,
            CaptureMode::Coordinate,
            "control type {} should produce Coordinate mode",
            id
        );
    }
}
