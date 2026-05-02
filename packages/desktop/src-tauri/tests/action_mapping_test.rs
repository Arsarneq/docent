// Property 6: Action mapping invariants
//
// **Validates: Requirements 4.1–4.15**
//
// For any native interaction event processed by the Capture_Layer, the
// resulting `ActionEvent` shall:
// (a) include a `timestamp` field with a valid Unix millisecond value,
// (b) set `frame_src` to `null`,
// (c) never have `type` equal to `"navigate"`, and
// (d) have a `type` field matching one of the defined schema action types.

use docent_desktop_lib::capture::action_mapping::{map_event, NativeEvent};
use docent_desktop_lib::capture::{
    ActionPayload, CaptureMode, ElementDescription, Modifiers, WindowRect,
};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Valid schema action types
// ---------------------------------------------------------------------------

/// The set of action types defined in the v2.0.0 schema contract.
const VALID_ACTION_TYPES: &[&str] = &[
    "click",
    "right_click",
    "type",
    "select",
    "key",
    "focus",
    "drag_start",
    "drop",
    "scroll",
    "context_switch",
    "context_open",
    "context_close",
    "file_dialog",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the action type string from an `ActionPayload`.
///
/// This mirrors the `#[serde(tag = "type", rename_all = "snake_case")]`
/// attribute on `ActionPayload`.
fn payload_type_name(payload: &ActionPayload) -> &'static str {
    match payload {
        ActionPayload::Click { .. } => "click",
        ActionPayload::RightClick { .. } => "right_click",
        ActionPayload::Type { .. } => "type",
        ActionPayload::Select { .. } => "select",
        ActionPayload::Key { .. } => "key",
        ActionPayload::Focus { .. } => "focus",
        ActionPayload::DragStart { .. } => "drag_start",
        ActionPayload::Drop { .. } => "drop",
        ActionPayload::Scroll { .. } => "scroll",
        ActionPayload::ContextSwitch { .. } => "context_switch",
        ActionPayload::ContextOpen { .. } => "context_open",
        ActionPayload::ContextClose { .. } => "context_close",
        ActionPayload::FileDialog { .. } => "file_dialog",
    }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// Strategy for a minimal `ElementDescription`.
fn arb_element() -> impl Strategy<Value = ElementDescription> {
    (
        "[a-zA-Z]{1,20}",           // tag
        prop::option::of("[a-zA-Z0-9_]{1,20}"), // id
        prop::option::of("[a-zA-Z0-9 ]{1,30}"), // name
        prop::option::of("[a-z]{1,15}"),         // role
        prop::option::of("password"),            // element_type
        prop::option::of("[a-zA-Z0-9 ]{1,50}"), // text
        "[a-zA-Z0-9>: ]{0,60}",     // selector
    )
        .prop_map(|(tag, id, name, role, element_type, text, selector)| {
            ElementDescription {
                tag,
                id,
                name,
                role,
                element_type,
                text,
                selector,
            }
        })
}

/// Strategy for `Modifiers`.
fn arb_modifiers() -> impl Strategy<Value = Modifiers> {
    (any::<bool>(), any::<bool>(), any::<bool>(), any::<bool>()).prop_map(
        |(ctrl, shift, alt, meta)| Modifiers {
            ctrl,
            shift,
            alt,
            meta,
        },
    )
}

/// Strategy for `CaptureMode`.
fn arb_capture_mode() -> impl Strategy<Value = CaptureMode> {
    prop_oneof![
        Just(CaptureMode::Accessibility),
        Just(CaptureMode::Coordinate),
    ]
}

/// Strategy for an optional `WindowRect`.
fn arb_window_rect() -> impl Strategy<Value = Option<WindowRect>> {
    prop::option::of((
        -10_000..=10_000i32,
        -10_000..=10_000i32,
        1..=10_000i32,
        1..=10_000i32,
    )
        .prop_map(|(x, y, width, height)| WindowRect {
            x,
            y,
            width,
            height,
        }))
}

/// Strategy for a random `NativeEvent`.
fn arb_native_event() -> impl Strategy<Value = NativeEvent> {
    prop_oneof![
        // Click
        (any::<f64>(), any::<f64>(), arb_element())
            .prop_map(|(x, y, element)| NativeEvent::Click { x, y, element }),
        // RightClick
        (any::<f64>(), any::<f64>(), arb_element())
            .prop_map(|(x, y, element)| NativeEvent::RightClick { x, y, element }),
        // TextInput
        (arb_element(), "[a-zA-Z0-9 ]{0,50}", any::<bool>())
            .prop_map(|(element, value, is_password)| NativeEvent::TextInput {
                element,
                value,
                is_password,
            }),
        // Selection
        (arb_element(), "[a-zA-Z0-9 ]{0,50}")
            .prop_map(|(element, value)| NativeEvent::Selection { element, value }),
        // Keyboard
        (
            "[a-zA-Z]{1,10}",
            arb_modifiers(),
            arb_element(),
        )
            .prop_map(|(key, modifiers, element)| NativeEvent::Keyboard {
                key,
                modifiers,
                element,
            }),
        // Focus
        arb_element().prop_map(|element| NativeEvent::Focus { element }),
        // DragStart
        arb_element().prop_map(|element| NativeEvent::DragStart { element }),
        // Drop
        (
            any::<f64>(),
            any::<f64>(),
            arb_element(),
            prop::option::of(arb_element()),
        )
            .prop_map(|(x, y, element, source_element)| NativeEvent::Drop {
                x,
                y,
                element,
                source_element,
            }),
        // Scroll
        (
            prop::option::of(arb_element()),
            any::<f64>(),
            any::<f64>(),
            any::<f64>(),
            any::<f64>(),
        )
            .prop_map(
                |(element, scroll_top, scroll_left, delta_y, delta_x)| NativeEvent::Scroll {
                    element,
                    scroll_top,
                    scroll_left,
                    delta_y,
                    delta_x,
                },
            ),
        // WindowFocus
        ("[a-z_\\.]{1,30}", prop::option::of("[a-zA-Z0-9 ]{1,50}"))
            .prop_map(|(source, title)| NativeEvent::WindowFocus { source, title }),
        // WindowOpen
        (prop::option::of(any::<i64>()), prop::option::of("[a-z_\\.]{1,30}"))
            .prop_map(|(opener_context_id, source)| NativeEvent::WindowOpen {
                opener_context_id,
                source,
            }),
        // WindowClose
        any::<bool>()
            .prop_map(|window_closing| NativeEvent::WindowClose { window_closing }),
        // FileDialogComplete
        (
            prop_oneof![Just("open".to_string()), Just("save".to_string()), Just("save_as".to_string())],
            "[A-Z]:\\\\[a-zA-Z0-9\\\\]{1,50}",
            "[a-z_\\.]{1,30}",
        )
            .prop_map(|(dialog_type, file_path, source)| {
                NativeEvent::FileDialogComplete {
                    dialog_type,
                    file_path,
                    source,
                }
            }),
    ]
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Feature: desktop-capture, Property 6: Action mapping invariants
    ///
    /// **Validates: Requirements 4.1–4.15**
    ///
    /// For any random native event, the mapped `ActionEvent`:
    /// (a) has the provided timestamp,
    /// (b) has `frame_src` set to `None` (null),
    /// (c) never has type `"navigate"`,
    /// (d) has a type matching one of the defined schema action types.
    #[test]
    fn action_mapping_invariants(
        event in arb_native_event(),
        timestamp in any::<u64>(),
        context_id in prop::option::of(any::<i64>()),
        capture_mode in arb_capture_mode(),
        window_rect in arb_window_rect(),
    ) {
        let action = map_event(&event, timestamp, context_id, capture_mode, window_rect);

        // (a) Timestamp matches the provided value
        prop_assert_eq!(
            action.timestamp, timestamp,
            "timestamp must match the provided value"
        );

        // (b) frame_src is always None for desktop actions
        prop_assert!(
            action.frame_src.is_none(),
            "frame_src must be None for all desktop actions"
        );

        // (c) Action type is never "navigate"
        let action_type = payload_type_name(&action.payload);
        prop_assert_ne!(
            action_type, "navigate",
            "action type must never be \"navigate\""
        );

        // (d) Action type is one of the defined schema action types
        prop_assert!(
            VALID_ACTION_TYPES.contains(&action_type),
            "action type \"{}\" must be one of the defined schema action types: {:?}",
            action_type,
            VALID_ACTION_TYPES
        );
    }
}
