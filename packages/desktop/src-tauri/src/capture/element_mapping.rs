// Element mapping — pure-Rust mapping from platform-provided accessibility
// properties to the platform-agnostic `ElementDescription` used in the v2.0.0
// schema.
//
// This module contains NO platform API calls and NO platform-specific
// constants, so it compiles and is testable on any target. Each platform
// retrieves its own native properties (and maps its own role/control-type
// system to a `tag` string) before handing a `NativeElementProperties` here.

use super::ElementDescription;

// ---------------------------------------------------------------------------
// Native element property bag
// ---------------------------------------------------------------------------

/// Platform-agnostic bag of accessibility properties for a single element.
///
/// Populated by the platform-specific capture code and handed to
/// [`map_element`] for conversion into an [`ElementDescription`]. Each platform
/// maps its own accessibility model onto these fields:
/// - `tag`: human-readable control type (Windows `ControlType`, macOS `AXRole`,
///   Linux AT-SPI2 role) — the platform resolves its native role to a string.
/// - `automation_id`: Windows `AutomationId` / macOS `AXIdentifier` / Linux id.
/// - `name`: accessible name.
/// - `localized_control_type`: localised role description.
/// - `is_password`: whether the element is a masked/password field.
/// - `value`: the element's text value.
/// - `tree_path`: accessibility tree path segments leading to this element.
#[derive(Debug, Clone)]
pub struct NativeElementProperties {
    /// Human-readable control-type tag (e.g. `"Button"`, `"Edit"`).
    /// The platform maps its native role/control-type system to this string.
    pub tag: String,
    /// The automation/accessibility id. May be empty.
    pub automation_id: String,
    /// The accessible name. May be empty.
    pub name: String,
    /// The localised control type (e.g. "button", "edit"). May be empty.
    pub localized_control_type: String,
    /// Whether the element is a password field.
    pub is_password: bool,
    /// The element's text value. May be empty.
    pub value: String,
    /// The accessibility tree path segments leading to this element.
    /// Each entry is `"Tag:Name"` (or just `"Tag"` when the name is empty).
    /// The last entry is the element itself.
    ///
    /// Example: `["Window:Notepad", "Edit:Text Editor"]`
    pub tree_path: Vec<String>,
}

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

/// Maximum length for the `text` field in an element description.
const MAX_TEXT_LENGTH: usize = 100;

/// Truncate `s` to at most [`MAX_TEXT_LENGTH`] characters.
///
/// If the string is longer than the limit it is cut at a character boundary
/// and `"…"` is appended (the total length may therefore be 101 visible
/// characters, but the semantic intent — "this was truncated" — is preserved).
fn truncate_text(s: &str) -> String {
    if s.chars().count() <= MAX_TEXT_LENGTH {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(MAX_TEXT_LENGTH).collect();
        format!("{truncated}…")
    }
}

// ---------------------------------------------------------------------------
// Core mapping
// ---------------------------------------------------------------------------

/// Convert raw native properties into a platform-agnostic [`ElementDescription`].
///
/// Rules:
/// - `tag` is taken directly from `props.tag` (the platform supplies it).
/// - `id` is `automation_id` when non-empty, otherwise `None`.
/// - `name` is the accessible `name` when non-empty, otherwise `None`.
/// - `role` is `localized_control_type` when non-empty, otherwise `None`.
/// - `element_type` is `Some("password")` when `is_password` is true.
/// - `text` is `None` for password fields; otherwise the `value` (or `name`
///   as fallback) truncated to 100 characters, or `None` if both are empty.
/// - `selector` is built from `tree_path` segments joined with `" > "`.
pub fn map_element(props: &NativeElementProperties) -> ElementDescription {
    let tag = props.tag.clone();

    let id = non_empty(&props.automation_id);
    let name = non_empty(&props.name);
    let role = non_empty(&props.localized_control_type);

    let element_type = if props.is_password {
        Some("password".to_string())
    } else {
        None
    };

    let text = if props.is_password {
        // Never expose password text.
        None
    } else {
        // Prefer the value; fall back to the name.
        let raw = if !props.value.is_empty() {
            &props.value
        } else if !props.name.is_empty() {
            &props.name
        } else {
            ""
        };
        non_empty_mapped(raw, truncate_text)
    };

    let selector = build_selector(&props.tree_path);

    ElementDescription {
        tag,
        id,
        name,
        role,
        element_type,
        text,
        selector,
    }
}

// ---------------------------------------------------------------------------
// Fallback mapping
// ---------------------------------------------------------------------------

/// Produce an [`ElementDescription`] for elements that have no accessible
/// name. Uses the control type and the element's position in the tree.
///
/// `control_type` is the human-readable tag (e.g. `"Button"`).
/// `position` is the `(child_index, sibling_count)` tuple — for example
/// `(2, 5)` means "the 3rd child out of 5 siblings of the same type".
pub fn map_element_fallback(control_type: &str, position: (i32, i32)) -> ElementDescription {
    let (index, _total) = position;
    let name_desc = format!("{control_type} #{}", index + 1);

    ElementDescription {
        tag: control_type.to_string(),
        id: None,
        name: Some(name_desc.clone()),
        role: None,
        element_type: None,
        text: None,
        selector: format!("{control_type}[{index}]"),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Return `Some(s.to_string())` when `s` is non-empty, `None` otherwise.
fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Apply `f` to `s` and return `Some(result)` when `s` is non-empty.
fn non_empty_mapped(s: &str, f: impl FnOnce(&str) -> String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(f(s))
    }
}

/// Build a selector string from accessibility tree path segments.
///
/// Segments are joined with `" > "`.  An empty path produces `""`.
fn build_selector(tree_path: &[String]) -> String {
    tree_path.join(" > ")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- truncate_text -----------------------------------------------------

    #[test]
    fn short_text_is_not_truncated() {
        let short = "hello";
        assert_eq!(truncate_text(short), "hello");
    }

    #[test]
    fn exactly_100_chars_is_not_truncated() {
        let s: String = "a".repeat(100);
        assert_eq!(truncate_text(&s), s);
    }

    #[test]
    fn text_over_100_chars_is_truncated_with_ellipsis() {
        let s: String = "b".repeat(150);
        let result = truncate_text(&s);
        assert!(result.starts_with(&"b".repeat(100)));
        assert!(result.ends_with('…'));
    }

    #[test]
    fn multibyte_text_truncates_at_char_boundary() {
        // 101 emoji characters — each is multi-byte in UTF-8.
        let s: String = "😀".repeat(101);
        let result = truncate_text(&s);
        // Should contain exactly 100 emoji + ellipsis.
        assert_eq!(result.chars().count(), 101); // 100 + '…'
        assert!(result.ends_with('…'));
    }

    // -- map_element -------------------------------------------------------

    #[test]
    fn basic_button_mapping() {
        let props = NativeElementProperties {
            tag: "Button".into(),
            automation_id: "btnSave".into(),
            name: "Save".into(),
            localized_control_type: "button".into(),
            is_password: false,
            value: String::new(),
            tree_path: vec!["Window:Notepad".into(), "Button:Save".into()],
        };

        let el = map_element(&props);
        assert_eq!(el.tag, "Button");
        assert_eq!(el.id, Some("btnSave".into()));
        assert_eq!(el.name, Some("Save".into()));
        assert_eq!(el.role, Some("button".into()));
        assert_eq!(el.element_type, None);
        // text falls back to name when value is empty.
        assert_eq!(el.text, Some("Save".into()));
        assert_eq!(el.selector, "Window:Notepad > Button:Save");
    }

    #[test]
    fn edit_field_with_value() {
        let props = NativeElementProperties {
            tag: "Edit".into(),
            automation_id: "txtSearch".into(),
            name: "Search".into(),
            localized_control_type: "edit".into(),
            is_password: false,
            value: "hello world".into(),
            tree_path: vec!["Window:App".into(), "Edit:Search".into()],
        };

        let el = map_element(&props);
        assert_eq!(el.tag, "Edit");
        assert_eq!(el.text, Some("hello world".into()));
    }

    #[test]
    fn password_field_hides_text() {
        let props = NativeElementProperties {
            tag: "Edit".into(),
            automation_id: "txtPassword".into(),
            name: "Password".into(),
            localized_control_type: "edit".into(),
            is_password: true,
            value: "s3cret!".into(),
            tree_path: vec!["Window:Login".into(), "Edit:Password".into()],
        };

        let el = map_element(&props);
        assert_eq!(el.element_type, Some("password".into()));
        assert_eq!(el.text, None);
    }

    #[test]
    fn empty_optional_fields_become_none() {
        let props = NativeElementProperties {
            tag: "Custom".into(),
            automation_id: String::new(),
            name: String::new(),
            localized_control_type: String::new(),
            is_password: false,
            value: String::new(),
            tree_path: vec![],
        };

        let el = map_element(&props);
        assert_eq!(el.tag, "Custom");
        assert_eq!(el.id, None);
        assert_eq!(el.name, None);
        assert_eq!(el.role, None);
        assert_eq!(el.element_type, None);
        assert_eq!(el.text, None);
        assert_eq!(el.selector, "");
    }

    #[test]
    fn long_value_is_truncated() {
        let long_value: String = "x".repeat(200);
        let props = NativeElementProperties {
            tag: "Edit".into(),
            automation_id: String::new(),
            name: String::new(),
            localized_control_type: "edit".into(),
            is_password: false,
            value: long_value,
            tree_path: vec!["Window:App".into(), "Edit".into()],
        };

        let el = map_element(&props);
        let text = el.text.unwrap();
        // 100 chars + ellipsis
        assert!(text.chars().count() == 101);
        assert!(text.ends_with('…'));
    }

    // -- map_element_fallback ----------------------------------------------

    #[test]
    fn fallback_produces_indexed_description() {
        let el = map_element_fallback("Button", (2, 5));
        assert_eq!(el.tag, "Button");
        assert_eq!(el.name, Some("Button #3".into()));
        assert_eq!(el.id, None);
        assert_eq!(el.role, None);
        assert_eq!(el.element_type, None);
        assert_eq!(el.text, None);
        assert_eq!(el.selector, "Button[2]");
    }

    #[test]
    fn fallback_first_child() {
        let el = map_element_fallback("Edit", (0, 1));
        assert_eq!(el.name, Some("Edit #1".into()));
        assert_eq!(el.selector, "Edit[0]");
    }

    // -- map_element with various control types ----------------------------

    #[test]
    fn combobox_mapping_with_value_and_tree_path() {
        let props = NativeElementProperties {
            tag: "ComboBox".into(),
            automation_id: "cmbCountry".into(),
            name: "Country".into(),
            localized_control_type: "combo box".into(),
            is_password: false,
            value: "Norway".into(),
            tree_path: vec![
                "Window:Settings".into(),
                "Group:Region".into(),
                "ComboBox:Country".into(),
            ],
        };

        let el = map_element(&props);
        assert_eq!(el.tag, "ComboBox");
        assert_eq!(el.id, Some("cmbCountry".into()));
        assert_eq!(el.name, Some("Country".into()));
        assert_eq!(el.role, Some("combo box".into()));
        assert_eq!(el.text, Some("Norway".into()));
        assert_eq!(
            el.selector,
            "Window:Settings > Group:Region > ComboBox:Country"
        );
    }

    #[test]
    fn hyperlink_mapping_uses_name_as_text_fallback() {
        let props = NativeElementProperties {
            tag: "Hyperlink".into(),
            automation_id: String::new(),
            name: "Click here".into(),
            localized_control_type: "hyperlink".into(),
            is_password: false,
            value: String::new(),
            tree_path: vec!["Window:Browser".into(), "Hyperlink:Click here".into()],
        };

        let el = map_element(&props);
        assert_eq!(el.tag, "Hyperlink");
        assert_eq!(el.id, None);
        assert_eq!(el.text, Some("Click here".into()));
    }

    #[test]
    fn tree_item_mapping() {
        let props = NativeElementProperties {
            tag: "TreeItem".into(),
            automation_id: "node_3".into(),
            name: "Documents".into(),
            localized_control_type: "tree item".into(),
            is_password: false,
            value: String::new(),
            tree_path: vec![
                "Window:Explorer".into(),
                "Tree:Folders".into(),
                "TreeItem:Documents".into(),
            ],
        };

        let el = map_element(&props);
        assert_eq!(el.tag, "TreeItem");
        assert_eq!(el.id, Some("node_3".into()));
        assert_eq!(el.name, Some("Documents".into()));
        assert_eq!(el.role, Some("tree item".into()));
        assert_eq!(el.text, Some("Documents".into()));
    }

    // -- map_element_fallback with various types ---------------------------

    #[test]
    fn fallback_large_index() {
        let el = map_element_fallback("ListItem", (99, 100));
        assert_eq!(el.name, Some("ListItem #100".into()));
        assert_eq!(el.selector, "ListItem[99]");
        assert_eq!(el.tag, "ListItem");
    }
}
