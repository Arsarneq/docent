// Capture layer — platform-agnostic trait and shared data types.
//
// Each platform (Windows, macOS, Linux) implements the `CaptureLayer` trait.
// Data structures here map directly to the v2.0.0 schema contract at
// `packages/shared/session.schema.json`.

pub mod action_mapping;
pub mod coordinate;
pub mod element_mapping;
pub mod scroll;
pub mod worker_pool;

#[cfg(target_os = "windows")]
pub mod windows;

use serde::Serialize;
use std::sync::mpsc::Sender;

// ---------------------------------------------------------------------------
// CaptureLayer trait
// ---------------------------------------------------------------------------

/// Platform-agnostic capture layer trait.
///
/// Each platform (Windows, macOS, Linux) implements this trait to observe
/// native application interactions and forward structured `ActionEvent`s
/// to the frontend via the provided channel.
pub trait CaptureLayer: Send + 'static {
    /// Start capturing interactions.
    /// Actions are sent through the provided `Sender<ActionEvent>` channel.
    fn start(&mut self, sender: Sender<ActionEvent>) -> Result<(), CaptureError>;

    /// Stop capturing interactions.
    fn stop(&mut self) -> Result<(), CaptureError>;

    /// Check if capture is currently active.
    fn is_active(&self) -> bool;

    /// Check if required platform permissions are granted.
    fn check_permissions(&self) -> PermissionStatus;

    /// List visible windows for target application selection.
    fn list_windows(&self) -> Result<Vec<WindowInfo>, CaptureError>;

    /// Set the process ID to exclude from capture (self-capture exclusion).
    /// Pass `None` to disable exclusion.
    fn set_excluded_pid(&mut self, pid: Option<u32>);

    /// Return the current maximum sequence number assigned by the input thread.
    /// Returns 0 if no events have been dispatched in the current capture session.
    fn max_sequence_id(&self) -> u64;
}

// ---------------------------------------------------------------------------
// Capture mode
// ---------------------------------------------------------------------------

/// How an action was captured.
///
/// Serialises to lowercase strings matching the schema's `capture_mode` enum:
/// `"dom"`, `"accessibility"`, `"coordinate"`.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    /// Browser DOM capture (used by the Chrome extension).
    Dom,
    /// Native accessibility API capture.
    Accessibility,
    /// Coordinate-based fallback capture.
    Coordinate,
}

// ---------------------------------------------------------------------------
// Window rectangle
// ---------------------------------------------------------------------------

/// Window position and size at capture time (logical pixels, DPI-scaled).
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

// ---------------------------------------------------------------------------
// Element description
// ---------------------------------------------------------------------------

/// Description of a UI element, mapped from the platform's accessibility API.
///
/// Field mapping per platform:
/// - `tag`:      Windows `ControlType`, macOS `AXRole`, Linux AT-SPI2 `Role`
/// - `id`:       Windows `AutomationId`, macOS `AXIdentifier`, Linux `accessible_id`
/// - `name`:     Windows `Name`, macOS `AXTitle`/`AXDescription`, Linux `get_name()`
/// - `role`:     Localised role description
/// - `element_type`: Control subtype (e.g. `"password"`)
/// - `text`:     Visible text, truncated to 100 chars. Null for passwords.
/// - `selector`: Accessibility tree path or `"coord:{x},{y}"`
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ElementDescription {
    pub tag: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
    #[serde(rename = "type")]
    pub element_type: Option<String>,
    pub text: Option<String>,
    pub selector: String,
}

// ---------------------------------------------------------------------------
// Keyboard modifiers
// ---------------------------------------------------------------------------

/// Modifier key state at the time of a keyboard action.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

// ---------------------------------------------------------------------------
// Action payloads
// ---------------------------------------------------------------------------

/// Action-specific payload data.
///
/// Each variant corresponds to an action type in the v2.0.0 schema.
/// The variant is flattened into the parent `ActionEvent` during serialisation.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionPayload {
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
    /// Passwords are masked as `"••••••••"`.
    Type {
        element: ElementDescription,
        value: String,
    },
    /// Selection change in a list, combo box, or tree view.
    Select {
        element: ElementDescription,
        value: String,
    },
    /// Keyboard interaction (Enter, Escape, Tab, arrow keys).
    Key {
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
    /// Scroll interaction (debounced, threshold-filtered).
    Scroll {
        element: Option<ElementDescription>,
        scroll_top: f64,
        scroll_left: f64,
        delta_y: f64,
        delta_x: f64,
    },
    /// Window focus changed (analogous to browser tab switch).
    ContextSwitch {
        source: String,
        title: Option<String>,
    },
    /// Window opened.
    ContextOpen {
        opener_context_id: Option<i64>,
        source: Option<String>,
    },
    /// Window closed.
    ContextClose {
        window_closing: bool,
    },
    /// File dialog completed with a confirmed selection.
    FileDialog {
        dialog_type: String,
        file_path: String,
        source: String,
    },
}

// ---------------------------------------------------------------------------
// Action event
// ---------------------------------------------------------------------------

/// A single captured user interaction, ready for emission to the frontend.
///
/// Serialised and sent via Tauri's `app.emit("capture:action", event)`.
/// The `payload` field is flattened so the JSON matches the schema directly.
#[derive(Debug, Serialize, Clone)]
pub struct ActionEvent {
    pub timestamp: u64,
    pub context_id: Option<i64>,
    pub capture_mode: CaptureMode,
    /// Always `None` for desktop actions (no iframes in native apps).
    pub frame_src: Option<String>,
    pub window_rect: Option<WindowRect>,
    /// Monotonic sequence number for frontend reorder buffer.
    /// Internal to Rust-frontend communication; stripped before export.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence_id: Option<u64>,
    #[serde(flatten)]
    pub payload: ActionPayload,
}

// ---------------------------------------------------------------------------
// Window info
// ---------------------------------------------------------------------------

/// Information about a visible window, used for target application selection.
#[derive(Debug, Serialize, Clone)]
pub struct WindowInfo {
    pub hwnd: i64,
    pub title: String,
    pub process_name: String,
    pub pid: u32,
}

// ---------------------------------------------------------------------------
// Permission status
// ---------------------------------------------------------------------------

/// Result of a platform permission check.
///
/// On Windows, permissions are always granted (no special entitlements needed).
/// On macOS (future), the user must grant Accessibility permission.
/// On Linux (future), the AT-SPI2 service must be running.
#[derive(Debug, Serialize, Clone)]
pub struct PermissionStatus {
    pub granted: bool,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Capture errors
// ---------------------------------------------------------------------------

/// Errors that can occur during capture operations.
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("COM initialization failed: {0}")]
    ComInit(String),

    #[error("Event hook registration failed: {0}")]
    HookFailed(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Platform error: {0}")]
    Platform(String),
}
