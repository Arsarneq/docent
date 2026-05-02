// Property 1: Password masking
//
// **Validates: Requirements 2.3**
//
// For any text input action where the target element is a password field,
// the recorded `value` field shall always be `"••••••••"` regardless of
// the actual input content.

use docent_desktop_lib::capture::action_mapping::{map_event, NativeEvent, PASSWORD_MASK};
use docent_desktop_lib::capture::{ActionPayload, CaptureMode, ElementDescription};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// Strategy for a minimal password-field `ElementDescription`.
fn arb_password_element() -> impl Strategy<Value = ElementDescription> {
    (
        "[a-zA-Z]{1,20}",                       // tag
        prop::option::of("[a-zA-Z0-9_]{1,20}"), // id
        prop::option::of("[a-zA-Z0-9 ]{1,30}"), // name
        prop::option::of("[a-z]{1,15}"),         // role
        prop::option::of("[a-zA-Z0-9 ]{1,50}"), // text
        "[a-zA-Z0-9>: ]{0,60}",                 // selector
    )
        .prop_map(|(tag, id, name, role, text, selector)| ElementDescription {
            tag,
            id,
            name,
            role,
            element_type: Some("password".to_string()),
            text,
            selector,
        })
}

/// Strategy for random password values — any non-empty string content.
fn arb_password_value() -> impl Strategy<Value = String> {
    prop_oneof![
        // Short passwords
        "[a-zA-Z0-9!@#$%^&*]{1,20}",
        // Long passwords
        "[a-zA-Z0-9!@#$%^&*]{20,200}",
        // Empty string (edge case)
        Just(String::new()),
        // Unicode passwords
        "\\PC{1,50}",
    ]
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Feature: desktop-capture, Property 1: Password masking
    ///
    /// **Validates: Requirements 2.3**
    ///
    /// For any random password value, when the native event indicates a
    /// password field (`is_password: true`), the mapped action's `value`
    /// field is always `"••••••••"`.
    #[test]
    fn password_value_is_always_masked(
        element in arb_password_element(),
        password in arb_password_value(),
        timestamp in any::<u64>(),
        context_id in prop::option::of(any::<i64>()),
    ) {
        let event = NativeEvent::TextInput {
            element,
            value: password.clone(),
            is_password: true,
        };

        let action = map_event(
            &event,
            timestamp,
            context_id,
            CaptureMode::Accessibility,
            None,
        );

        match &action.payload {
            ActionPayload::Type { value, .. } => {
                prop_assert_eq!(
                    value.as_str(),
                    PASSWORD_MASK,
                    "password value must be masked as \"{}\" but got \"{}\" (original: \"{}\")",
                    PASSWORD_MASK,
                    value,
                    password
                );
            }
            other => {
                prop_assert!(
                    false,
                    "expected Type payload for TextInput event, got {:?}",
                    std::mem::discriminant(other)
                );
            }
        }
    }

    /// Feature: desktop-capture, Property 1: Password masking (non-password control)
    ///
    /// **Validates: Requirements 2.3**
    ///
    /// For any text input on a non-password field, the value is preserved
    /// as-is (not masked).
    #[test]
    fn non_password_value_is_preserved(
        value in "[a-zA-Z0-9 ]{0,100}",
        timestamp in any::<u64>(),
    ) {
        let element = ElementDescription {
            tag: "Edit".to_string(),
            id: None,
            name: None,
            role: Some("edit".to_string()),
            element_type: None,
            text: None,
            selector: String::new(),
        };

        let event = NativeEvent::TextInput {
            element,
            value: value.clone(),
            is_password: false,
        };

        let action = map_event(
            &event,
            timestamp,
            None,
            CaptureMode::Accessibility,
            None,
        );

        match &action.payload {
            ActionPayload::Type {
                value: recorded_value,
                ..
            } => {
                prop_assert_eq!(
                    recorded_value.as_str(),
                    value.as_str(),
                    "non-password value must be preserved as-is"
                );
            }
            other => {
                prop_assert!(
                    false,
                    "expected Type payload for TextInput event, got {:?}",
                    std::mem::discriminant(other)
                );
            }
        }
    }
}
