// Element mapping — pure-Rust mapping from platform-provided accessibility
// properties to the platform-agnostic `ElementDescription` used in the v2.0.0
// schema.
//
// This module contains NO platform API calls and NO platform-specific
// constants, so it compiles and is testable on any target. Each platform
// retrieves its own native properties (and maps its own role/control-type
// system to a `tag` string) before handing a `NativeElementProperties` here.
//
// see docs/technical/session-format.md — the element descriptions and locator candidates mapped here are .docent.json fields; the per-platform schemas are authoritative for field semantics.

use super::{ElementDescription, LocatorEntry, LocatorMatch};

// ---------------------------------------------------------------------------
// Locator measurement results (filled by the platform, consumed here)
// ---------------------------------------------------------------------------

/// Outcome of the bounded identity scan for one measured candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeasuredIndex {
    /// The acted-on element was found at this zero-based position.
    Found(u32),
    /// The full match list was scanned and the element was not in it
    /// (serializes as `match_index: null`).
    NotMatched,
    /// The list was longer than the scan cap and the element was not found
    /// within it — the ordinal was not measured (key absent).
    NotMeasured,
}

/// A measured `match_count` plus the scan outcome for one candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeasuredPair {
    pub count: u32,
    pub index: MeasuredIndex,
}

/// Per-candidate measurement results gathered by the platform layer.
/// `None` = the candidate was not measured at all (query failed, zero-length
/// result, or the describing path deliberately skips measurement — e.g. the
/// input-hook pre-capture path, which must stay fast).
#[derive(Debug, Clone, Copy, Default)]
pub struct LocatorMeasurements {
    pub automation_id: Option<MeasuredPair>,
    pub role_name: Option<MeasuredPair>,
    pub class_name: Option<MeasuredPair>,
}

impl MeasuredPair {
    /// Convert to the schema-shaped stats (see [`LocatorMatch`]'s field docs
    /// for the absent / null / index encoding).
    fn to_stats(self) -> LocatorMatch {
        LocatorMatch {
            match_count: Some(self.count),
            match_index: match self.index {
                MeasuredIndex::Found(i) => Some(Some(i)),
                MeasuredIndex::NotMatched => Some(None),
                MeasuredIndex::NotMeasured => None,
            },
        }
    }
}

fn stats_of(measurement: Option<MeasuredPair>) -> LocatorMatch {
    measurement.map(MeasuredPair::to_stats).unwrap_or_default()
}

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
#[derive(Debug, Clone, Default)]
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
    /// The element's window class name (Windows UIA ClassName). May be empty.
    pub class_name: String,
    /// Per-element UI-framework identity (Windows UIA FrameworkId,
    /// e.g. "Win32"/"WPF"/"XAML"). May be empty.
    pub framework_id: String,
    /// Accessible name of the element referenced by the LabeledBy property.
    /// Empty when the provider reports no label relation.
    pub labeled_by: String,
    /// Provider-reported one-based set ordinals; 0 = not reported (the
    /// platform property default).
    pub position_in_set: i32,
    pub size_of_set: i32,
    pub level: i32,
    /// Index into `tree_path` of the top-level window segment, when the
    /// ancestor walk positively identified the window root. `None` when the
    /// walk was cap-terminated or the root could not be confirmed — the
    /// `tree_path` locator entry is then omitted (its value must never
    /// contradict the schema's "from the window root" wording).
    pub window_root_offset: Option<usize>,
    /// Match statistics measured by the platform layer (absent per candidate
    /// when not measured).
    pub measurements: LocatorMeasurements,
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
        position_in_set: (props.position_in_set >= 1).then_some(props.position_in_set),
        size_of_set: (props.size_of_set >= 1).then_some(props.size_of_set),
        level: (props.level >= 1).then_some(props.level),
        framework_id: non_empty(&props.framework_id),
        locators: build_locators(props),
        // Stamped by the worker at the describe site (docent#220) — the
        // mapping layer has no clock and no event timestamp.
        described_after_ms: None,
    }
}

// ---------------------------------------------------------------------------
// Locator candidates (docent#139)
// ---------------------------------------------------------------------------

/// Assemble the element's locator candidates from the gathered properties and
/// the platform-measured match statistics.
///
/// Entries follow the schema's `oneOf` declaration order (a serialization
/// convention, no ranking): automation_id, role_name, class_name, labeled_by,
/// tree_path. Empty-valued candidates are omitted entirely. `role_name.role`
/// is the NON-localized control-type tag (the same value measurement
/// conditions match on via the raw control-type id); `role_name` is gated on a
/// non-empty Name. The `tree_path` entry is emitted only when the window root
/// was positively identified, with the path taken FROM that root — never a
/// fragment that silently contradicts the schema wording.
pub fn build_locators(props: &NativeElementProperties) -> Vec<LocatorEntry> {
    let mut locators = Vec::new();

    if !props.automation_id.is_empty() {
        locators.push(LocatorEntry::AutomationId {
            value: props.automation_id.clone(),
            stats: stats_of(props.measurements.automation_id),
        });
    }

    if !props.name.is_empty() {
        locators.push(LocatorEntry::RoleName {
            role: props.tag.clone(),
            name: props.name.clone(),
            stats: stats_of(props.measurements.role_name),
        });
    }

    if !props.class_name.is_empty() {
        locators.push(LocatorEntry::ClassName {
            value: props.class_name.clone(),
            stats: stats_of(props.measurements.class_name),
        });
    }

    if !props.labeled_by.is_empty() {
        locators.push(LocatorEntry::LabeledBy {
            value: props.labeled_by.clone(),
        });
    }

    if let Some(offset) = props.window_root_offset {
        if offset < props.tree_path.len() {
            locators.push(LocatorEntry::TreePath {
                value: props.tree_path[offset..].join(" > "),
            });
        }
    }

    locators
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
        // Fallback descriptions carry no provider facts and no locators.
        ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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

    // -- locator candidates (docent#139) ------------------------------------

    fn full_props() -> NativeElementProperties {
        NativeElementProperties {
            tag: "Button".to_string(),
            automation_id: "btnSave".to_string(),
            name: "Save".to_string(),
            localized_control_type: "button".to_string(),
            class_name: "Button".to_string(),
            framework_id: "WPF".to_string(),
            labeled_by: "Actions".to_string(),
            position_in_set: 2,
            size_of_set: 5,
            level: 1,
            tree_path: vec![
                "Window:App".to_string(),
                "Pane:Toolbar".to_string(),
                "Button:Save".to_string(),
            ],
            window_root_offset: Some(0),
            measurements: LocatorMeasurements {
                automation_id: Some(MeasuredPair {
                    count: 1,
                    index: MeasuredIndex::Found(0),
                }),
                role_name: Some(MeasuredPair {
                    count: 3,
                    index: MeasuredIndex::Found(1),
                }),
                class_name: Some(MeasuredPair {
                    count: 7,
                    index: MeasuredIndex::NotMeasured,
                }),
            },
            ..Default::default()
        }
    }

    #[test]
    fn locators_follow_schema_declaration_order() {
        let el = map_element(&full_props());
        let strategies: Vec<&str> = el
            .locators
            .iter()
            .map(|l| match l {
                LocatorEntry::AutomationId { .. } => "automation_id",
                LocatorEntry::RoleName { .. } => "role_name",
                LocatorEntry::ClassName { .. } => "class_name",
                LocatorEntry::LabeledBy { .. } => "labeled_by",
                LocatorEntry::TreePath { .. } => "tree_path",
            })
            .collect();
        assert_eq!(
            strategies,
            vec![
                "automation_id",
                "role_name",
                "class_name",
                "labeled_by",
                "tree_path"
            ]
        );
    }

    #[test]
    fn measured_index_states_map_to_the_schema_encoding() {
        let el = map_element(&full_props());
        // Found(i) -> Some(Some(i))
        let LocatorEntry::AutomationId { stats, .. } = &el.locators[0] else {
            panic!("expected automation_id first");
        };
        assert_eq!(stats.match_count, Some(1));
        assert_eq!(stats.match_index, Some(Some(0)));
        // NotMeasured on the ordinal only: count present, index key absent.
        let LocatorEntry::ClassName { stats, .. } = &el.locators[2] else {
            panic!("expected class_name third");
        };
        assert_eq!(stats.match_count, Some(7));
        assert_eq!(stats.match_index, None);
    }

    #[test]
    fn not_matched_serializes_as_null_and_unmeasured_omits_both() {
        let mut props = full_props();
        props.measurements.automation_id = Some(MeasuredPair {
            count: 2,
            index: MeasuredIndex::NotMatched,
        });
        props.measurements.role_name = None; // not measured at all
        let el = map_element(&props);
        let json = serde_json::to_value(&el).unwrap();
        let locators = json.get("locators").unwrap().as_array().unwrap();
        assert_eq!(locators[0]["match_count"], 2);
        assert!(locators[0]["match_index"].is_null());
        assert!(
            locators[0].get("match_index").is_some(),
            "null must be PRESENT"
        );
        assert!(
            locators[1].get("match_count").is_none(),
            "unmeasured pair is absent"
        );
        assert!(locators[1].get("match_index").is_none());
    }

    #[test]
    fn empty_values_omit_their_entries() {
        let props = NativeElementProperties {
            tag: "Pane".to_string(),
            ..Default::default()
        };
        let el = map_element(&props);
        assert!(el.locators.is_empty());
        // And the empty array is omitted from the JSON entirely.
        let json = serde_json::to_value(&el).unwrap();
        assert!(json.get("locators").is_none());
    }

    #[test]
    fn role_name_is_gated_on_a_non_empty_name() {
        let mut props = full_props();
        props.name = String::new();
        let el = map_element(&props);
        assert!(!el
            .locators
            .iter()
            .any(|l| matches!(l, LocatorEntry::RoleName { .. })));
    }

    #[test]
    fn tree_path_entry_requires_an_identified_window_root() {
        let mut props = full_props();
        props.window_root_offset = None;
        let el = map_element(&props);
        assert!(!el
            .locators
            .iter()
            .any(|l| matches!(l, LocatorEntry::TreePath { .. })));
    }

    #[test]
    fn tree_path_value_starts_at_the_window_root_offset() {
        let mut props = full_props();
        props.window_root_offset = Some(1); // skip a segment above the window
        let el = map_element(&props);
        let Some(LocatorEntry::TreePath { value }) = el
            .locators
            .iter()
            .find(|l| matches!(l, LocatorEntry::TreePath { .. }))
        else {
            panic!("expected a tree_path entry");
        };
        assert_eq!(value, "Pane:Toolbar > Button:Save");
    }

    #[test]
    fn provider_ordinals_zero_means_absent() {
        let mut props = full_props();
        props.position_in_set = 0;
        props.size_of_set = 0;
        props.level = 0;
        props.framework_id = String::new();
        let el = map_element(&props);
        assert_eq!(el.position_in_set, None);
        assert_eq!(el.size_of_set, None);
        assert_eq!(el.level, None);
        assert_eq!(el.framework_id, None);
        let json = serde_json::to_value(&el).unwrap();
        for key in ["position_in_set", "size_of_set", "level", "framework_id"] {
            assert!(json.get(key).is_none(), "{key} must be absent, not null");
        }
    }

    #[test]
    fn described_after_ms_pins_absent_by_default_and_zero_when_stamped() {
        // The mapping layer never stamps it (docent#220): key absent.
        let el = map_element(&full_props());
        assert_eq!(el.described_after_ms, None);
        let json = serde_json::to_value(&el).unwrap();
        assert!(
            json.get("described_after_ms").is_none(),
            "described_after_ms must be absent, not null"
        );
        // Stamped 0 (hook pre-capture) serializes as a literal 0, not absent.
        let mut el = el;
        el.described_after_ms = Some(0);
        let json = serde_json::to_value(&el).unwrap();
        assert_eq!(json["described_after_ms"], 0);
    }

    #[test]
    fn provider_ordinals_positive_are_carried() {
        let el = map_element(&full_props());
        assert_eq!(el.position_in_set, Some(2));
        assert_eq!(el.size_of_set, Some(5));
        assert_eq!(el.level, Some(1));
        assert_eq!(el.framework_id, Some("WPF".into()));
    }

    #[test]
    fn password_element_keeps_identity_locators_and_no_text() {
        let mut props = full_props();
        props.is_password = true;
        props.value = "secret".to_string();
        let el = map_element(&props);
        assert_eq!(el.text, None);
        assert!(el
            .locators
            .iter()
            .any(|l| matches!(l, LocatorEntry::AutomationId { .. })));
        assert!(el
            .locators
            .iter()
            .any(|l| matches!(l, LocatorEntry::RoleName { .. })));
    }

    #[test]
    fn fallback_description_emits_no_locators_or_facts() {
        let el = map_element_fallback("Button", (0, 3));
        assert!(el.locators.is_empty());
        assert_eq!(el.position_in_set, None);
        assert_eq!(el.framework_id, None);
    }

    // -- serde pinning: exact JSON for each variant -------------------------

    #[test]
    fn serde_pins_the_exact_locator_entry_json() {
        use super::super::{LocatorEntry, LocatorMatch};
        let auto = LocatorEntry::AutomationId {
            value: "btnSave".to_string(),
            stats: LocatorMatch {
                match_count: Some(3),
                match_index: Some(Some(1)),
            },
        };
        assert_eq!(
            serde_json::to_value(&auto).unwrap(),
            serde_json::json!({
                "strategy": "automation_id",
                "value": "btnSave",
                "match_count": 3,
                "match_index": 1
            })
        );

        let role = LocatorEntry::RoleName {
            role: "Button".to_string(),
            name: "Delete".to_string(),
            stats: LocatorMatch {
                match_count: Some(5),
                match_index: Some(None),
            },
        };
        assert_eq!(
            serde_json::to_value(&role).unwrap(),
            serde_json::json!({
                "strategy": "role_name",
                "role": "Button",
                "name": "Delete",
                "match_count": 5,
                "match_index": null
            })
        );

        let labeled = LocatorEntry::LabeledBy {
            value: "Amount".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&labeled).unwrap(),
            serde_json::json!({ "strategy": "labeled_by", "value": "Amount" })
        );

        let tree = LocatorEntry::TreePath {
            value: "Window:App > Button:Save".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&tree).unwrap(),
            serde_json::json!({ "strategy": "tree_path", "value": "Window:App > Button:Save" })
        );

        let class_unmeasured = LocatorEntry::ClassName {
            value: "Edit".to_string(),
            stats: LocatorMatch::default(),
        };
        assert_eq!(
            serde_json::to_value(&class_unmeasured).unwrap(),
            serde_json::json!({ "strategy": "class_name", "value": "Edit" })
        );
    }
}
