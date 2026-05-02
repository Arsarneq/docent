// Property 5: Native element mapping completeness
//
// **Validates: Requirements 3.1, 3.2**
//
// For any set of Windows UI Automation element properties (ControlType,
// AutomationId, Name, LocalizedControlType, ValuePattern value), the element
// mapping function produces an `ElementDescription` with all required fields
// populated according to the mapping rules.

use docent_desktop_lib::capture::element_mapping::{control_type_name, map_element, UiaProperties};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// Strategy for control type IDs: mix of known (50000–50040) and unknown values.
fn arb_control_type_id() -> impl Strategy<Value = i32> {
    prop_oneof![
        // Known control type IDs
        (50000..=50040i32),
        // Unknown / out-of-range IDs
        prop::num::i32::ANY,
    ]
}

/// Strategy for optional string fields (AutomationId, Name, LocalizedControlType, value).
/// Produces a mix of empty strings and non-empty arbitrary strings.
fn arb_optional_string() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(String::new()),
        "[a-zA-Z0-9_ ]{1,200}",
    ]
}

/// Strategy for tree path segments.
fn arb_tree_path() -> impl Strategy<Value = Vec<String>> {
    prop::collection::vec("[A-Za-z]+:[A-Za-z0-9 ]*", 0..=5)
}

/// Strategy for a complete `UiaProperties` struct.
fn arb_uia_properties() -> impl Strategy<Value = UiaProperties> {
    (
        arb_control_type_id(),
        arb_optional_string(),
        arb_optional_string(),
        arb_optional_string(),
        any::<bool>(),
        arb_optional_string(),
        arb_tree_path(),
    )
        .prop_map(
            |(control_type_id, automation_id, name, localized_control_type, is_password, value, tree_path)| {
                UiaProperties {
                    control_type_id,
                    automation_id,
                    name,
                    localized_control_type,
                    is_password,
                    value,
                    tree_path,
                }
            },
        )
}

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Feature: desktop-capture, Property 5: Native element mapping completeness
    ///
    /// **Validates: Requirements 3.1, 3.2**
    ///
    /// For any random UIA property set, `map_element` produces an
    /// `ElementDescription` where:
    /// - `tag` is always non-empty (derived from control_type_id)
    /// - `selector` is always a String (may be empty for empty tree_path)
    /// - When `is_password` is true, `element_type` is `Some("password")` and
    ///   `text` is `None`
    /// - When `is_password` is false and value/name are non-empty, `text` is
    ///   `Some(...)` with length ≤ 101 chars (100 + ellipsis)
    /// - `id` is `Some(...)` iff `automation_id` is non-empty
    /// - `name` is `Some(...)` iff `name` is non-empty
    /// - `role` is `Some(...)` iff `localized_control_type` is non-empty
    #[test]
    fn element_mapping_completeness(props in arb_uia_properties()) {
        let el = map_element(&props);

        // -- tag is always non-empty, derived from control_type_id ----------
        prop_assert!(!el.tag.is_empty(), "tag must be non-empty");
        prop_assert_eq!(
            &el.tag,
            control_type_name(props.control_type_id),
            "tag must match control_type_name({})",
            props.control_type_id
        );

        // -- selector is always a String ------------------------------------
        // (may be empty when tree_path is empty)
        if props.tree_path.is_empty() {
            prop_assert_eq!(&el.selector, "", "selector must be empty for empty tree_path");
        } else {
            let expected_selector = props.tree_path.join(" > ");
            prop_assert_eq!(
                &el.selector,
                &expected_selector,
                "selector must be tree_path segments joined with ' > '"
            );
        }

        // -- password handling ----------------------------------------------
        if props.is_password {
            prop_assert_eq!(
                el.element_type.as_deref(),
                Some("password"),
                "element_type must be Some(\"password\") when is_password is true"
            );
            prop_assert!(
                el.text.is_none(),
                "text must be None for password fields"
            );
        } else {
            prop_assert!(
                el.element_type.is_none(),
                "element_type must be None when is_password is false"
            );
        }

        // -- text truncation ------------------------------------------------
        if !props.is_password {
            let has_text_source = !props.value.is_empty() || !props.name.is_empty();
            if has_text_source {
                prop_assert!(
                    el.text.is_some(),
                    "text must be Some when value or name is non-empty (and not password)"
                );
                let text = el.text.as_ref().unwrap();
                let char_count = text.chars().count();
                prop_assert!(
                    char_count <= 101,
                    "text length ({} chars) must be ≤ 101 (100 + ellipsis)",
                    char_count
                );
                // If the source text is longer than 100 chars, it must end with '…'
                let source = if !props.value.is_empty() { &props.value } else { &props.name };
                if source.chars().count() > 100 {
                    prop_assert!(
                        text.ends_with('…'),
                        "truncated text must end with '…'"
                    );
                    prop_assert_eq!(
                        char_count, 101,
                        "truncated text must be exactly 101 chars (100 + ellipsis)"
                    );
                } else {
                    prop_assert_eq!(
                        text, source,
                        "text must equal source when source is ≤ 100 chars"
                    );
                }
            } else {
                prop_assert!(
                    el.text.is_none(),
                    "text must be None when both value and name are empty"
                );
            }
        }

        // -- id: Some iff automation_id is non-empty ------------------------
        if props.automation_id.is_empty() {
            prop_assert!(
                el.id.is_none(),
                "id must be None when automation_id is empty"
            );
        } else {
            prop_assert_eq!(
                el.id.as_deref(),
                Some(props.automation_id.as_str()),
                "id must be Some(automation_id) when automation_id is non-empty"
            );
        }

        // -- name: Some iff name is non-empty -------------------------------
        if props.name.is_empty() {
            prop_assert!(
                el.name.is_none(),
                "name must be None when name is empty"
            );
        } else {
            prop_assert_eq!(
                el.name.as_deref(),
                Some(props.name.as_str()),
                "name must be Some(name) when name is non-empty"
            );
        }

        // -- role: Some iff localized_control_type is non-empty -------------
        if props.localized_control_type.is_empty() {
            prop_assert!(
                el.role.is_none(),
                "role must be None when localized_control_type is empty"
            );
        } else {
            prop_assert_eq!(
                el.role.as_deref(),
                Some(props.localized_control_type.as_str()),
                "role must be Some(localized_control_type) when localized_control_type is non-empty"
            );
        }
    }
}
