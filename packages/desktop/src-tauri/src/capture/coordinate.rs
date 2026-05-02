// Coordinate fallback — pure-Rust logic for per-action capture mode
// determination, relative coordinate calculation, and fallback element
// descriptions.
//
// This module contains NO Windows API calls so it can be compiled and tested
// on any platform. The actual `ElementFromPoint` call lives in `windows.rs`.

use super::{CaptureMode, ElementDescription, WindowRect};

// ---------------------------------------------------------------------------
// Control-type IDs for generic containers
// ---------------------------------------------------------------------------

/// Windows UIA control type ID for `Window`.
const UIA_WINDOW_CONTROL_TYPE_ID: i32 = 50032;

/// Windows UIA control type ID for `Pane`.
const UIA_PANE_CONTROL_TYPE_ID: i32 = 50033;

// ---------------------------------------------------------------------------
// Capture mode determination
// ---------------------------------------------------------------------------

/// Determine the capture mode for a positional interaction based on the
/// control type ID returned by `ElementFromPoint`.
///
/// - If the resolved element is a **specific control** (i.e. not a top-level
///   window or generic pane), the action should be captured in accessibility
///   mode.
/// - If the resolved element is only the **top-level window** (`50032`) or a
///   **generic pane** (`50033`), the accessibility API could not identify a
///   specific child element at those coordinates, so coordinate fallback mode
///   is used.
///
/// # Requirements
/// - 2a.2: Specific control → accessibility mode
/// - 2a.3: Top-level window / generic pane → coordinate mode
/// - 2a.8: `capture_mode` field with `"accessibility"` or `"coordinate"`
pub fn determine_capture_mode(control_type_id: i32) -> CaptureMode {
    match control_type_id {
        UIA_WINDOW_CONTROL_TYPE_ID | UIA_PANE_CONTROL_TYPE_ID => CaptureMode::Coordinate,
        _ => CaptureMode::Accessibility,
    }
}

// ---------------------------------------------------------------------------
// Relative coordinate calculation
// ---------------------------------------------------------------------------

/// Calculate coordinates relative to the application window's top-left corner.
///
/// All values are in **logical pixels** (DPI-scaled, not physical pixels) as
/// required by Requirement 2a.10.
///
/// Returns `(rel_x, rel_y)` where:
/// - `rel_x = abs_x - win_x`
/// - `rel_y = abs_y - win_y`
///
/// # Requirements
/// - 2a.4: Coordinates relative to window origin
/// - 2a.10: Logical pixels (DPI-scaled)
pub fn relative_coordinates(abs_x: i32, abs_y: i32, win_x: i32, win_y: i32) -> (i32, i32) {
    (abs_x - win_x, abs_y - win_y)
}

// ---------------------------------------------------------------------------
// Fallback element description
// ---------------------------------------------------------------------------

/// Create a fallback [`ElementDescription`] for coordinate-mode actions.
///
/// When the accessibility API resolves only a top-level window or generic
/// pane, we cannot describe the specific element under the cursor. Instead
/// we record:
/// - `tag`: `"unknown"`
/// - `name`: the window title
/// - `id`: `None`
/// - `role`: `None`
/// - `element_type`: `None`
/// - `text`: `None`
/// - `selector`: `"coord:{rel_x},{rel_y}"`
///
/// # Requirements
/// - 2a.6: Fallback element description
pub fn fallback_element(window_title: &str, rel_x: i32, rel_y: i32) -> ElementDescription {
    ElementDescription {
        tag: "unknown".to_string(),
        name: Some(window_title.to_string()),
        id: None,
        role: None,
        element_type: None,
        text: None,
        selector: format!("coord:{rel_x},{rel_y}"),
    }
}

// ---------------------------------------------------------------------------
// Window rectangle
// ---------------------------------------------------------------------------

/// Create a [`WindowRect`] from the window's position and size.
///
/// All values are in **logical pixels** (DPI-scaled).
///
/// # Requirements
/// - 2a.5: Record window size and position at capture time
/// - 2a.10: Logical pixels
pub fn create_window_rect(x: i32, y: i32, width: i32, height: i32) -> WindowRect {
    WindowRect {
        x,
        y,
        width,
        height,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- determine_capture_mode --------------------------------------------

    #[test]
    fn window_control_type_returns_coordinate_mode() {
        assert_eq!(
            determine_capture_mode(UIA_WINDOW_CONTROL_TYPE_ID),
            CaptureMode::Coordinate
        );
    }

    #[test]
    fn pane_control_type_returns_coordinate_mode() {
        assert_eq!(
            determine_capture_mode(UIA_PANE_CONTROL_TYPE_ID),
            CaptureMode::Coordinate
        );
    }

    #[test]
    fn button_control_type_returns_accessibility_mode() {
        assert_eq!(determine_capture_mode(50000), CaptureMode::Accessibility);
    }

    #[test]
    fn edit_control_type_returns_accessibility_mode() {
        assert_eq!(determine_capture_mode(50004), CaptureMode::Accessibility);
    }

    #[test]
    fn unknown_control_type_returns_accessibility_mode() {
        // An unknown control type is still a specific element, not a generic
        // container, so accessibility mode is appropriate.
        assert_eq!(determine_capture_mode(99999), CaptureMode::Accessibility);
    }

    // -- relative_coordinates ----------------------------------------------

    #[test]
    fn relative_coords_basic() {
        let (rx, ry) = relative_coordinates(500, 400, 100, 50);
        assert_eq!(rx, 400);
        assert_eq!(ry, 350);
    }

    #[test]
    fn relative_coords_at_origin() {
        let (rx, ry) = relative_coordinates(100, 50, 100, 50);
        assert_eq!(rx, 0);
        assert_eq!(ry, 0);
    }

    #[test]
    fn relative_coords_negative_result() {
        // Click outside the window (above/left of origin) produces negative
        // relative coordinates. This is valid — the caller decides how to
        // handle it.
        let (rx, ry) = relative_coordinates(50, 30, 100, 50);
        assert_eq!(rx, -50);
        assert_eq!(ry, -20);
    }

    // -- fallback_element --------------------------------------------------

    #[test]
    fn fallback_element_basic() {
        let el = fallback_element("Notepad", 120, 340);
        assert_eq!(el.tag, "unknown");
        assert_eq!(el.name, Some("Notepad".to_string()));
        assert_eq!(el.id, None);
        assert_eq!(el.role, None);
        assert_eq!(el.element_type, None);
        assert_eq!(el.text, None);
        assert_eq!(el.selector, "coord:120,340");
    }

    #[test]
    fn fallback_element_with_zero_coords() {
        let el = fallback_element("App", 0, 0);
        assert_eq!(el.selector, "coord:0,0");
        assert_eq!(el.name, Some("App".to_string()));
    }

    #[test]
    fn fallback_element_with_empty_title() {
        let el = fallback_element("", 10, 20);
        assert_eq!(el.name, Some(String::new()));
        assert_eq!(el.selector, "coord:10,20");
    }

    // -- create_window_rect ------------------------------------------------

    #[test]
    fn window_rect_basic() {
        let rect = create_window_rect(100, 50, 1200, 800);
        assert_eq!(rect.x, 100);
        assert_eq!(rect.y, 50);
        assert_eq!(rect.width, 1200);
        assert_eq!(rect.height, 800);
    }

    #[test]
    fn window_rect_at_origin() {
        let rect = create_window_rect(0, 0, 800, 600);
        assert_eq!(rect.x, 0);
        assert_eq!(rect.y, 0);
        assert_eq!(rect.width, 800);
        assert_eq!(rect.height, 600);
    }
}
