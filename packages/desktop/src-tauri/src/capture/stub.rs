// Placeholder capture layer for platforms whose native backend is not yet
// implemented (Linux/X11 — #84; Wayland — #85).
//
// This exists so the crate **compiles and `cargo check`s on every target**,
// keeping the cross-platform seam honest as the codebase is prepared for
// Linux support (#97). It implements the platform-agnostic [`CaptureLayer`]
// trait but performs no capture: `start` returns a `CaptureError::Platform`
// error, `check_permissions` reports "not granted", and the remaining methods
// are inert. No platform SDKs are referenced, so it builds with zero system
// dependencies.
//
// When a real backend lands for a platform, point that platform's `Capture`
// alias in `mod.rs` at the new type instead of this stub.
//
// (macOS is intentionally not a target — see #83: no free code-signing path
// exists and unsigned macOS apps are unusable for Docent's non-technical
// audience.)

use std::sync::mpsc::Sender;

use super::{ActionEvent, BarrierReport, CaptureError, CaptureLayer, PermissionStatus, WindowInfo};

/// A no-op [`CaptureLayer`] for not-yet-supported platforms.
#[derive(Default)]
pub struct UnsupportedCapture;

impl UnsupportedCapture {
    pub fn new() -> Self {
        Self
    }

    /// Human-readable name of the current (unsupported) platform.
    fn platform() -> &'static str {
        if cfg!(target_os = "macos") {
            "macOS"
        } else if cfg!(target_os = "linux") {
            "Linux"
        } else {
            "this platform"
        }
    }
}

impl CaptureLayer for UnsupportedCapture {
    fn start(&mut self, _sender: Sender<ActionEvent>) -> Result<(), CaptureError> {
        Err(CaptureError::Platform(format!(
            "native capture is not yet implemented for {}",
            Self::platform()
        )))
    }

    fn stop(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }

    fn is_active(&self) -> bool {
        false
    }

    fn check_permissions(&self) -> PermissionStatus {
        PermissionStatus {
            granted: false,
            message: Some(format!(
                "native capture is not yet implemented for {}",
                Self::platform()
            )),
        }
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        Ok(Vec::new())
    }

    fn set_excluded_pid(&mut self, _pid: Option<u32>) {}

    fn set_included_pid(&mut self, _pid: Option<u32>) {}

    fn commit_barrier(&self) -> Result<BarrierReport, CaptureError> {
        // No capture backend on this platform, so nothing is ever buffered.
        Ok(BarrierReport {
            barrier_id: 0,
            wedged_workers: 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn start_reports_unsupported_platform() {
        let mut capture = UnsupportedCapture::new();
        let (tx, _rx) = mpsc::channel::<ActionEvent>();
        let err = capture.start(tx).unwrap_err();
        assert!(matches!(err, CaptureError::Platform(_)));
    }

    #[test]
    fn inert_methods_have_safe_defaults() {
        let mut capture = UnsupportedCapture::new();
        assert!(!capture.is_active());
        assert!(!capture.check_permissions().granted);
        assert_eq!(capture.list_windows().unwrap().len(), 0);
        // The commit barrier is a no-op on an unsupported platform.
        let report = capture.commit_barrier().unwrap();
        assert_eq!(report.barrier_id, 0);
        assert_eq!(report.wedged_workers, 0);
        // Inert setters must not panic.
        capture.set_excluded_pid(Some(1));
        capture.set_included_pid(None);
        assert!(capture.stop().is_ok());
    }
}
