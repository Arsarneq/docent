// Action mapping — pure-Rust mapping from native interaction events to the
// platform-agnostic `ActionEvent` used in the v2.0.0 schema.
//
// This module contains NO Windows API calls so it can be compiled and tested
// on any platform. The actual native event detection lives in `windows.rs`.

use super::{
    ActionEvent, ActionPayload, CaptureMode, ElementDescription, Modifiers, WindowRect,
};

// ---------------------------------------------------------------------------
// Masked password value
// ---------------------------------------------------------------------------

/// The masked value used for password fields.
pub const PASSWORD_MASK: &str = "••••••••";

// ---------------------------------------------------------------------------
// Native event enum
// ---------------------------------------------------------------------------

/// Raw native events produced by the platform-specific capture layer.
///
/// Each variant represents a distinct interaction type detected by the OS
/// hooks and accessibility API. The `map_event` function converts these
/// into schema-compliant `ActionEvent`s.
#[derive(Debug, Clone)]
pub enum NativeEvent {
    /// Mouse click on an element.
    Click {
        x: f64,
        y: f64,
        element: ElementDescription,
    },
    /// Right-click (context menu) on an element.
    RightClick {
        x: f64,
        y: f64,
        element: ElementDescription,
    },
    /// Text input into an editable element.
    TextInput {
        element: ElementDescription,
        value: String,
        is_password: bool,
    },
    /// Selection change in a list, combo box, or tree view.
    Selection {
        element: ElementDescription,
        value: String,
    },
    /// Keyboard interaction (Enter, Escape, Tab, arrow keys, etc.).
    Keyboard {
        key: String,
        modifiers: Modifiers,
        element: ElementDescription,
    },
    /// Focus change on an element.
    Focus {
        element: ElementDescription,
    },
    /// Drag operation started.
    DragStart {
        element: ElementDescription,
    },
    /// Drop operation completed.
    Drop {
        x: f64,
        y: f64,
        element: ElementDescription,
        source_element: Option<ElementDescription>,
    },
    /// Scroll interaction (already debounced and threshold-filtered).
    Scroll {
        element: Option<ElementDescription>,
        scroll_top: f64,
        scroll_left: f64,
        delta_y: f64,
        delta_x: f64,
    },
    /// Window focus changed.
    WindowFocus {
        source: String,
        title: Option<String>,
    },
    /// Window opened.
    WindowOpen {
        opener_context_id: Option<i64>,
        source: Option<String>,
    },
    /// Window closed.
    WindowClose {
        window_closing: bool,
    },
    /// File dialog completed with a confirmed selection.
    FileDialogComplete {
        dialog_type: String,
        file_path: String,
        source: String,
    },
}

// ---------------------------------------------------------------------------
// Mapping function
// ---------------------------------------------------------------------------

/// Map a native event to a schema-compliant `ActionEvent`.
///
/// # Arguments
///
/// - `event`: The raw native event to map.
/// - `timestamp`: Unix milliseconds at the time of the event.
/// - `context_id`: The window handle (or equivalent) for the event source.
/// - `capture_mode`: Whether the event was captured via accessibility or
///   coordinate fallback.
/// - `window_rect`: The window's position and size at capture time (optional).
///
/// # Requirements
///
/// - 4.1:  click → `click`
/// - 4.2:  right-click → `right_click`
/// - 4.3:  text input → `type`
/// - 4.4:  selection → `select`
/// - 4.5:  keyboard → `key`
/// - 4.6:  focus → `focus`
/// - 4.7:  drag/drop → `drag_start` / `drop`
/// - 4.8:  scroll → `scroll`
/// - 4.9:  window focus → `context_switch`
/// - 4.10: window open → `context_open`
/// - 4.11: window close → `context_close`
/// - 4.12: timestamp as Unix milliseconds
/// - 4.13: `frame_src: null` for all desktop actions
/// - 4.15: `navigate` is never produced
/// - 4.16: file dialog → `file_dialog`
/// - 2.3:  password fields masked as `"••••••••"`
pub fn map_event(
    event: &NativeEvent,
    timestamp: u64,
    context_id: Option<i64>,
    capture_mode: CaptureMode,
    window_rect: Option<WindowRect>,
) -> ActionEvent {
    let payload = match event {
        NativeEvent::Click { x, y, element } => ActionPayload::Click {
            x: *x,
            y: *y,
            element: element.clone(),
        },
        NativeEvent::RightClick { x, y, element } => ActionPayload::RightClick {
            x: *x,
            y: *y,
            element: element.clone(),
        },
        NativeEvent::TextInput {
            element,
            value,
            is_password,
        } => {
            let masked_value = if *is_password {
                PASSWORD_MASK.to_string()
            } else {
                value.clone()
            };
            ActionPayload::Type {
                element: element.clone(),
                value: masked_value,
            }
        }
        NativeEvent::Selection { element, value } => ActionPayload::Select {
            element: element.clone(),
            value: value.clone(),
        },
        NativeEvent::Keyboard {
            key,
            modifiers,
            element,
        } => ActionPayload::Key {
            key: key.clone(),
            modifiers: modifiers.clone(),
            element: element.clone(),
        },
        NativeEvent::Focus { element } => ActionPayload::Focus {
            element: element.clone(),
        },
        NativeEvent::DragStart { element } => ActionPayload::DragStart {
            element: element.clone(),
        },
        NativeEvent::Drop {
            x,
            y,
            element,
            source_element,
        } => ActionPayload::Drop {
            x: *x,
            y: *y,
            element: element.clone(),
            source_element: source_element.clone(),
        },
        NativeEvent::Scroll {
            element,
            scroll_top,
            scroll_left,
            delta_y,
            delta_x,
        } => ActionPayload::Scroll {
            element: element.clone(),
            scroll_top: *scroll_top,
            scroll_left: *scroll_left,
            delta_y: *delta_y,
            delta_x: *delta_x,
        },
        NativeEvent::WindowFocus { source, title } => ActionPayload::ContextSwitch {
            source: source.clone(),
            title: title.clone(),
        },
        NativeEvent::WindowOpen {
            opener_context_id,
            source,
        } => ActionPayload::ContextOpen {
            opener_context_id: *opener_context_id,
            source: source.clone(),
        },
        NativeEvent::WindowClose { window_closing } => ActionPayload::ContextClose {
            window_closing: *window_closing,
        },
        NativeEvent::FileDialogComplete {
            dialog_type,
            file_path,
            source,
        } => ActionPayload::FileDialog {
            dialog_type: dialog_type.clone(),
            file_path: file_path.clone(),
            source: source.clone(),
        },
    };

    ActionEvent {
        timestamp,
        context_id,
        capture_mode,
        frame_src: None, // Always null for desktop actions (Req 4.13)
        window_rect,
        sequence_id: None,
        payload,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a minimal element description for tests.
    fn test_element() -> ElementDescription {
        ElementDescription {
            tag: "Button".to_string(),
            id: Some("btn1".to_string()),
            name: Some("OK".to_string()),
            role: Some("button".to_string()),
            element_type: None,
            text: Some("OK".to_string()),
            selector: "Window:App > Button:OK".to_string(),
        }
    }

    // -- Click mapping -----------------------------------------------------

    #[test]
    fn click_maps_to_click_payload() {
        let event = NativeEvent::Click {
            x: 100.0,
            y: 200.0,
            element: test_element(),
        };
        let action = map_event(&event, 1000, Some(42), CaptureMode::Accessibility, None);

        assert_eq!(action.timestamp, 1000);
        assert_eq!(action.context_id, Some(42));
        assert!(action.frame_src.is_none());
        match &action.payload {
            ActionPayload::Click { x, y, .. } => {
                assert_eq!(*x, 100.0);
                assert_eq!(*y, 200.0);
            }
            _ => panic!("expected Click payload"),
        }
    }

    // -- Right-click mapping -----------------------------------------------

    #[test]
    fn right_click_maps_to_right_click_payload() {
        let event = NativeEvent::RightClick {
            x: 50.0,
            y: 75.0,
            element: test_element(),
        };
        let action = map_event(&event, 2000, None, CaptureMode::Coordinate, None);

        match &action.payload {
            ActionPayload::RightClick { x, y, .. } => {
                assert_eq!(*x, 50.0);
                assert_eq!(*y, 75.0);
            }
            _ => panic!("expected RightClick payload"),
        }
    }

    // -- Text input mapping ------------------------------------------------

    #[test]
    fn text_input_maps_to_type_payload() {
        let event = NativeEvent::TextInput {
            element: test_element(),
            value: "hello".to_string(),
            is_password: false,
        };
        let action = map_event(&event, 3000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::Type { value, .. } => {
                assert_eq!(value, "hello");
            }
            _ => panic!("expected Type payload"),
        }
    }

    #[test]
    fn password_input_is_masked() {
        let event = NativeEvent::TextInput {
            element: test_element(),
            value: "s3cret!".to_string(),
            is_password: true,
        };
        let action = map_event(&event, 3000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::Type { value, .. } => {
                assert_eq!(value, PASSWORD_MASK);
            }
            _ => panic!("expected Type payload"),
        }
    }

    // -- Selection mapping -------------------------------------------------

    #[test]
    fn selection_maps_to_select_payload() {
        let event = NativeEvent::Selection {
            element: test_element(),
            value: "Option A".to_string(),
        };
        let action = map_event(&event, 4000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::Select { value, .. } => {
                assert_eq!(value, "Option A");
            }
            _ => panic!("expected Select payload"),
        }
    }

    // -- Keyboard mapping --------------------------------------------------

    #[test]
    fn keyboard_maps_to_key_payload() {
        let mods = Modifiers {
            ctrl: true,
            shift: false,
            alt: false,
            meta: false,
        };
        let event = NativeEvent::Keyboard {
            key: "Enter".to_string(),
            modifiers: mods.clone(),
            element: test_element(),
        };
        let action = map_event(&event, 5000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::Key { key, modifiers, .. } => {
                assert_eq!(key, "Enter");
                assert_eq!(modifiers.ctrl, true);
            }
            _ => panic!("expected Key payload"),
        }
    }

    // -- Focus mapping -----------------------------------------------------

    #[test]
    fn focus_maps_to_focus_payload() {
        let event = NativeEvent::Focus {
            element: test_element(),
        };
        let action = map_event(&event, 6000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::Focus { .. } => {}
            _ => panic!("expected Focus payload"),
        }
    }

    // -- Drag/Drop mapping -------------------------------------------------

    #[test]
    fn drag_start_maps_to_drag_start_payload() {
        let event = NativeEvent::DragStart {
            element: test_element(),
        };
        let action = map_event(&event, 7000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::DragStart { .. } => {}
            _ => panic!("expected DragStart payload"),
        }
    }

    #[test]
    fn drop_maps_to_drop_payload() {
        let event = NativeEvent::Drop {
            x: 300.0,
            y: 400.0,
            element: test_element(),
            source_element: Some(test_element()),
        };
        let action = map_event(&event, 8000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::Drop {
                x,
                y,
                source_element,
                ..
            } => {
                assert_eq!(*x, 300.0);
                assert_eq!(*y, 400.0);
                assert!(source_element.is_some());
            }
            _ => panic!("expected Drop payload"),
        }
    }

    // -- Scroll mapping ----------------------------------------------------

    #[test]
    fn scroll_maps_to_scroll_payload() {
        let event = NativeEvent::Scroll {
            element: Some(test_element()),
            scroll_top: 100.0,
            scroll_left: 0.0,
            delta_y: 50.0,
            delta_x: 0.0,
        };
        let action = map_event(&event, 9000, Some(1), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::Scroll {
                delta_y, delta_x, ..
            } => {
                assert_eq!(*delta_y, 50.0);
                assert_eq!(*delta_x, 0.0);
            }
            _ => panic!("expected Scroll payload"),
        }
    }

    // -- Window lifecycle mapping ------------------------------------------

    #[test]
    fn window_focus_maps_to_context_switch() {
        let event = NativeEvent::WindowFocus {
            source: "notepad.exe".to_string(),
            title: Some("Untitled - Notepad".to_string()),
        };
        let action = map_event(&event, 10000, Some(99), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::ContextSwitch { source, title } => {
                assert_eq!(source, "notepad.exe");
                assert_eq!(title.as_deref(), Some("Untitled - Notepad"));
            }
            _ => panic!("expected ContextSwitch payload"),
        }
    }

    #[test]
    fn window_open_maps_to_context_open() {
        let event = NativeEvent::WindowOpen {
            opener_context_id: Some(10),
            source: Some("calc.exe".to_string()),
        };
        let action = map_event(&event, 11000, Some(20), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::ContextOpen {
                opener_context_id,
                source,
            } => {
                assert_eq!(*opener_context_id, Some(10));
                assert_eq!(source.as_deref(), Some("calc.exe"));
            }
            _ => panic!("expected ContextOpen payload"),
        }
    }

    #[test]
    fn window_close_maps_to_context_close() {
        let event = NativeEvent::WindowClose {
            window_closing: true,
        };
        let action = map_event(&event, 12000, Some(20), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::ContextClose { window_closing } => {
                assert!(*window_closing);
            }
            _ => panic!("expected ContextClose payload"),
        }
    }

    // -- File dialog mapping -----------------------------------------------

    #[test]
    fn file_dialog_maps_to_file_dialog_payload() {
        let event = NativeEvent::FileDialogComplete {
            dialog_type: "save".to_string(),
            file_path: "C:\\Users\\test\\doc.txt".to_string(),
            source: "notepad.exe".to_string(),
        };
        let action = map_event(&event, 13000, Some(99), CaptureMode::Accessibility, None);

        match &action.payload {
            ActionPayload::FileDialog {
                dialog_type,
                file_path,
                source,
            } => {
                assert_eq!(dialog_type, "save");
                assert_eq!(file_path, "C:\\Users\\test\\doc.txt");
                assert_eq!(source, "notepad.exe");
            }
            _ => panic!("expected FileDialog payload"),
        }
    }

    // -- frame_src is always None ------------------------------------------

    #[test]
    fn frame_src_is_always_none() {
        let events = vec![
            NativeEvent::Click {
                x: 0.0,
                y: 0.0,
                element: test_element(),
            },
            NativeEvent::WindowFocus {
                source: "app.exe".to_string(),
                title: None,
            },
            NativeEvent::WindowClose {
                window_closing: false,
            },
        ];

        for event in &events {
            let action =
                map_event(event, 1000, None, CaptureMode::Accessibility, None);
            assert!(
                action.frame_src.is_none(),
                "frame_src must be None for all desktop actions"
            );
        }
    }
}
