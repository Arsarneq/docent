// Capture layer — platform-agnostic trait and shared data types.
//
// Each platform (Windows, macOS, Linux) implements the `CaptureLayer` trait.
// Data structures here map directly to the v2.0.0 schema contract at
// `packages/shared/session.schema.json`.

pub mod action_mapping;
pub mod coordinate;
pub mod element_mapping;
pub mod scroll;
pub mod timing;
pub mod worker_pool;

#[cfg(target_os = "windows")]
pub mod windows;

// Placeholder backend for platforms without a native implementation yet
// (Linux/X11 #84, Wayland #85). Keeps the crate compiling on every
// target while the cross-platform seam is prepared (#97). (macOS is out of
// scope — see #83.)
#[cfg(not(target_os = "windows"))]
pub mod stub;

/// The platform-specific capture implementation for the current target.
///
/// Each platform module exposes a struct implementing [`CaptureLayer`]; this
/// alias lets the rest of the crate refer to it without `#[cfg]` at every use
/// site. New platforms add their own `#[cfg(target_os = ...)]` arm here —
/// replace the [`stub::UnsupportedCapture`] fallback with the real type once a
/// native backend lands.
#[cfg(target_os = "windows")]
pub type Capture = windows::WindowsCapture;

/// Fallback for not-yet-supported platforms (Linux). See [`stub`].
#[cfg(not(target_os = "windows"))]
pub type Capture = stub::UnsupportedCapture;

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

    /// Set the process ID to include (target app filtering).
    /// When set, only events from this PID are captured.
    /// Pass `None` to capture all applications.
    fn set_included_pid(&mut self, pid: Option<u32>);

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

/// Window position and size at capture time, in **physical pixels** — the
/// values come from `GetWindowRect` under per-monitor-v2 DPI awareness, the
/// same space as the input hook's screen coordinates. (Earlier docs claimed
/// logical pixels; issue #141 tracks stating space + unit on every
/// coordinate-bearing field.)
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

/// Measured match statistics for a locator candidate — mirrors the
/// `locator_match_count` / `locator_match_index` definitions in the platform
/// schema. Both fields are independently optional: an absent field means
/// "not measured", never a guess.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq, Default)]
pub struct LocatorMatch {
    /// How many elements the candidate matched in its stated scope.
    /// `None` = not measured (key absent in the emitted JSON).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_count: Option<u32>,
    /// Zero-based position of the acted-on element among the matches.
    /// Outer `None` = not measured (key absent). `Some(None)` = JSON `null`
    /// (the candidate did not match the acted-on element). `Some(Some(i))` =
    /// the ordinal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_index: Option<Option<u32>>,
}

/// One `locators[]` entry. Variants mirror the per-strategy shapes in
/// `schemas/desktop-windows.delta.json` exactly; the declaration order here is
/// the schema's `oneOf` order — a serialization convention that carries no
/// ranking. `LabeledBy` and `TreePath` carry no stats field: their pair is
/// never measured (the schema's cheapness rule), which this representation
/// makes unrepresentable rather than merely unlikely. `masked` is deliberately
/// not modeled: no desktop strategy is value-derived, so it can never be true
/// in the current contract.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum LocatorEntry {
    AutomationId {
        value: String,
        #[serde(flatten)]
        stats: LocatorMatch,
    },
    RoleName {
        role: String,
        name: String,
        #[serde(flatten)]
        stats: LocatorMatch,
    },
    ClassName {
        value: String,
        #[serde(flatten)]
        stats: LocatorMatch,
    },
    LabeledBy {
        value: String,
    },
    TreePath {
        value: String,
    },
}

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
/// - `position_in_set`/`size_of_set`/`level`: provider-reported set ordinals
///   (Windows UIA PositionInSet/SizeOfSet/Level); absent when not reported.
/// - `framework_id`: per-element UI-framework identity (Windows UIA
///   FrameworkId, e.g. "Win32"/"WPF"/"XAML"); absent when not reported.
/// - `locators`: locator candidates (docent#139); omitted entirely when none
///   were observed (e.g. coordinate mode, fallback descriptions).
#[derive(Debug, Serialize, Clone, PartialEq, Eq, Default)]
pub struct ElementDescription {
    pub tag: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
    #[serde(rename = "type")]
    pub element_type: Option<String>,
    pub text: Option<String>,
    pub selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_in_set: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_of_set: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<LocatorEntry>,
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
// Variants embed full `ElementDescription` values (Drop carries two); events
// occur at human-input rate, so the variant-size spread is not worth boxing
// every construction and match site.
#[allow(clippy::large_enum_variant)]
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
    Focus { element: ElementDescription },
    /// Drag operation started.
    DragStart { element: ElementDescription },
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
    ContextClose { window_closing: bool },
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
    /// Platform-opaque window identifier.
    /// - Windows: `HWND` cast to `i64`
    /// - Linux (future): X11 window id / Wayland surface id
    pub window_id: i64,
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
