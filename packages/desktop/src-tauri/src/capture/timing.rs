// Central timing configuration — single source of truth for all timing
// constants used by the desktop capture layer.
//
// This is the desktop equivalent of the extension's `lib/capture-timing.js`.
// All timing-related constants live here so they can be tuned in one place.

use std::time::Duration;

// ─── Input Correlation Windows ──────────────────────────────────────────────
// Maximum time (ms) between a low-level input event and a correlated
// WinEvent for the WinEvent to be considered user-caused.

/// Foreground correlation window. Click → foreground change is nearly instant
/// (<50ms typically). 100ms covers slow machines.
pub const FOREGROUND_CORRELATION_MS: u64 = 100;

/// Window lifecycle (create/destroy) correlation window. User action → window
/// create/destroy can involve application processing time.
pub const WINDOW_LIFECYCLE_CORRELATION_MS: u64 = 200;

/// Focus correlation window. Click/Tab → focus change is nearly instant.
pub const FOCUS_CORRELATION_MS: u64 = 100;

/// Value-change correlation window. Keystroke → value change involves:
/// OS processes key → app receives WM_CHAR → app updates text → accessibility
/// fires EVENT_OBJECT_VALUECHANGE. This chain can take 200-400ms on slow apps.
pub const VALUE_CHANGE_CORRELATION_MS: u64 = 500;

// ─── Scroll ─────────────────────────────────────────────────────────────────

/// Debounce interval in milliseconds. A scroll action is emitted only after
/// no scroll event arrives for this duration.
pub const SCROLL_DEBOUNCE_MS: u64 = 300;

/// Minimum scroll distance (in pixels) required in at least one axis for the
/// scroll to be recorded. Sequences where both `|total_delta_x|` and
/// `|total_delta_y|` are ≤ this threshold are discarded.
pub const SCROLL_MIN_DISTANCE_PX: f64 = 200.0;

// ─── Type Coalescing ────────────────────────────────────────────────────────

/// Debounce interval for coalescing rapid value-change events into a single
/// type action (milliseconds).
pub const TYPE_DEBOUNCE_MS: u64 = 500;

// ─── Worker ─────────────────────────────────────────────────────────────────

/// Timeout for worker `recv_timeout` — used for periodic flush of scroll and
/// type buffers.
pub const WORKER_RECV_TIMEOUT_MS: u64 = 50;

/// `WORKER_RECV_TIMEOUT_MS` as a `Duration` for direct use with `recv_timeout`.
pub const WORKER_RECV_TIMEOUT: Duration = Duration::from_millis(WORKER_RECV_TIMEOUT_MS);
