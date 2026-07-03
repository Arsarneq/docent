// Native element mapping completeness
//
//
// For any set of platform-provided accessibility element properties (tag,
// AutomationId, Name, LocalizedControlType, ValuePattern value), the element
// mapping function produces an `ElementDescription` with all required fields
// populated according to the mapping rules.

use docent_desktop_lib::capture::element_mapping::{map_element, NativeElementProperties};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// Strategy for control-type tags: a mix of representative platform tags and
/// arbitrary non-empty strings. The platform supplies this string (each
/// platform maps its own role system to a tag), so `map_element` treats it as
/// an opaque non-empty label — the generator therefore never yields "".
fn arb_tag() -> impl Strategy<Value = String> {
    prop_oneof![
        // Representative tags a platform backend might supply.
        Just("Button".to_string()),
        Just("Edit".to_string()),
        Just("ComboBox".to_string()),
        Just("TreeItem".to_string()),
        Just("Window".to_string()),
        Just("Unknown".to_string()),
        // Arbitrary non-empty tag-like strings.
        "[A-Za-z][A-Za-z0-9]{0,20}",
    ]
}

/// Strategy for optional string fields (AutomationId, Name, LocalizedControlType, value).
/// Produces a mix of empty strings and non-empty arbitrary strings.
fn arb_optional_string() -> impl Strategy<Value = String> {
    prop_oneof![Just(String::new()), "[a-zA-Z0-9_ ]{1,200}",]
}

/// Strategy for tree path segments.
fn arb_tree_path() -> impl Strategy<Value = Vec<String>> {
    prop::collection::vec("[A-Za-z]+:[A-Za-z0-9 ]*", 0..=5)
}

/// Strategy for a complete `NativeElementProperties` struct.
fn arb_native_properties() -> impl Strategy<Value = NativeElementProperties> {
    (
        arb_tag(),
        arb_optional_string(),
        arb_optional_string(),
        arb_optional_string(),
        any::<bool>(),
        arb_optional_string(),
        arb_tree_path(),
    )
        .prop_map(
            |(tag, automation_id, name, localized_control_type, is_password, value, tree_path)| {
                NativeElementProperties {
                    tag,
                    automation_id,
                    name,
                    localized_control_type,
                    is_password,
                    value,
                    tree_path,
                    ..Default::default()
                }
            },
        )
}

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Native element mapping completeness
    ///
    /// For any random property set, `map_element` produces an
    /// `ElementDescription` where:
    /// - `tag` is copied verbatim from the platform-supplied `tag`
    /// - `selector` is always a String (may be empty for empty tree_path)
    /// - When `is_password` is true, `element_type` is `Some("password")` and
    ///   `text` is `None`
    /// - When `is_password` is false and value/name are non-empty, `text` is
    ///   `Some(...)` with length ≤ 101 chars (100 + ellipsis)
    /// - `id` is `Some(...)` iff `automation_id` is non-empty
    /// - `name` is `Some(...)` iff `name` is non-empty
    /// - `role` is `Some(...)` iff `localized_control_type` is non-empty
    #[test]
    fn element_mapping_completeness(props in arb_native_properties()) {
        let el = map_element(&props);

        // -- tag is copied verbatim from the platform-supplied tag ----------
        prop_assert!(!el.tag.is_empty(), "tag must be non-empty");
        prop_assert_eq!(
            &el.tag,
            &props.tag,
            "tag must be copied verbatim from props.tag"
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
