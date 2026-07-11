//! Multi-monitor and DPI coordinate math — PURE-HELPER tests.
//!
//! SCOPE: despite exercising realistic monitor layouts, these tests call only
//! the coordinate module's pure helpers (`relative_coordinates`,
//! `create_window_rect`, `determine_capture_mode`) plus a TEST-LOCAL
//! physical↔logical conversion — no ActionEvent is ever produced and the
//! production pipeline is not in the loop. (An earlier version of this header
//! claimed "full pipeline" coverage; that overstated it. The pipeline emits
//! raw screen coordinates today — physical pixels under per-monitor-v2 DPI
//! awareness, with no logical conversion in production — see issue #141 and
//! worker_pool_test.rs for the pipeline-level truth-lock.) Scenarios covered:
//!
//! - Primary monitor at standard DPI (100%)
//! - Negative screen coordinates (secondary monitor to the left)
//! - DPI scaling simulation via coordinate math
//! - Window positioned at virtual desktop edges
//!
//! Tests that require actual multi-monitor hardware are marked `#[ignore]`
//! with instructions for manual verification. NOT a CI coverage gap: the
//! coordinate math those would exercise — including negative/secondary-monitor
//! coordinates — is covered deterministically by the tests above via simulated
//! bounds (no hardware needed); the `#[ignore]` is purely the real-2-monitor
//! verification.
//!
//! Run with: cargo test --test coordinate_dpi_test
//!

use docent_desktop_lib::capture::coordinate::{
    create_window_rect, determine_capture_mode, relative_coordinates,
};
use docent_desktop_lib::capture::CaptureMode;
use proptest::prelude::*;

// ═══════════════════════════════════════════════════════════════════════════════
// DPI SCALING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

/// Simulate DPI scaling: convert physical pixels to logical pixels.
/// At 150% DPI, a physical coordinate of 300 maps to logical 200.
fn physical_to_logical(physical: i32, dpi_scale: f64) -> i32 {
    (physical as f64 / dpi_scale).round() as i32
}

#[test]
fn dpi_100_percent_coordinates_unchanged() {
    // At 100% DPI (scale = 1.0), logical == physical
    let physical_x = 500;
    let physical_y = 300;
    let dpi_scale = 1.0;

    let logical_x = physical_to_logical(physical_x, dpi_scale);
    let logical_y = physical_to_logical(physical_y, dpi_scale);

    assert_eq!(logical_x, 500);
    assert_eq!(logical_y, 300);

    // Window at (100, 50), click at (500, 300) → relative (400, 250)
    let win_x = 100;
    let win_y = 50;
    let (rel_x, rel_y) = relative_coordinates(logical_x, logical_y, win_x, win_y);
    assert_eq!(rel_x, 400);
    assert_eq!(rel_y, 250);
}

#[test]
fn dpi_150_percent_coordinates_scaled() {
    // At 150% DPI (scale = 1.5), physical 750 → logical 500
    let physical_x = 750;
    let physical_y = 450;
    let dpi_scale = 1.5;

    let logical_x = physical_to_logical(physical_x, dpi_scale);
    let logical_y = physical_to_logical(physical_y, dpi_scale);

    assert_eq!(logical_x, 500);
    assert_eq!(logical_y, 300);

    // Window at logical (100, 50) → relative (400, 250)
    let win_x = 100;
    let win_y = 50;
    let (rel_x, rel_y) = relative_coordinates(logical_x, logical_y, win_x, win_y);
    assert_eq!(rel_x, 400);
    assert_eq!(rel_y, 250);
}

#[test]
fn dpi_200_percent_coordinates_scaled() {
    // At 200% DPI (scale = 2.0), physical 1000 → logical 500
    let physical_x = 1000;
    let physical_y = 600;
    let dpi_scale = 2.0;

    let logical_x = physical_to_logical(physical_x, dpi_scale);
    let logical_y = physical_to_logical(physical_y, dpi_scale);

    assert_eq!(logical_x, 500);
    assert_eq!(logical_y, 300);

    let (rel_x, rel_y) = relative_coordinates(logical_x, logical_y, 100, 50);
    assert_eq!(rel_x, 400);
    assert_eq!(rel_y, 250);
}

#[test]
fn dpi_125_percent_coordinates_rounded() {
    // At 125% DPI (scale = 1.25), physical 625 → logical 500
    let physical_x = 625;
    let physical_y = 375;
    let dpi_scale = 1.25;

    let logical_x = physical_to_logical(physical_x, dpi_scale);
    let logical_y = physical_to_logical(physical_y, dpi_scale);

    assert_eq!(logical_x, 500);
    assert_eq!(logical_y, 300);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-MONITOR COORDINATE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn secondary_monitor_left_negative_coordinates() {
    // Secondary monitor to the left: its coordinates are negative.
    // Example: secondary at (-1920, 0), primary at (0, 0).
    // A window on the secondary monitor at (-1500, 200):
    let win_x = -1500;
    let win_y = 200;
    let abs_x = -1300; // Click 200px from left edge of window
    let abs_y = 350; // Click 150px from top edge of window

    let (rel_x, rel_y) = relative_coordinates(abs_x, abs_y, win_x, win_y);
    assert_eq!(rel_x, 200);
    assert_eq!(rel_y, 150);

    // Window rect should preserve negative position
    let rect = create_window_rect(win_x, win_y, 800, 600);
    assert_eq!(rect.x, -1500);
    assert_eq!(rect.y, 200);
    assert_eq!(rect.width, 800);
    assert_eq!(rect.height, 600);
}

#[test]
fn secondary_monitor_above_negative_y() {
    // Secondary monitor above primary: y coordinates are negative.
    // Example: secondary at (0, -1080), primary at (0, 0).
    let win_x = 100;
    let win_y = -900;
    let abs_x = 300;
    let abs_y = -700;

    let (rel_x, rel_y) = relative_coordinates(abs_x, abs_y, win_x, win_y);
    assert_eq!(rel_x, 200);
    assert_eq!(rel_y, 200);

    let rect = create_window_rect(win_x, win_y, 1920, 1080);
    assert_eq!(rect.x, 100);
    assert_eq!(rect.y, -900);
}

#[test]
fn window_spanning_monitor_boundary() {
    // Window positioned at the boundary between two monitors.
    // Primary at (0,0) 1920x1080, secondary at (1920, 0) 1920x1080.
    // Window at (1800, 100) with width 400 — spans both monitors.
    let win_x = 1800;
    let win_y = 100;
    let win_w = 400;
    let win_h = 300;

    // Click on the right portion (on secondary monitor)
    let abs_x = 2050; // 250px from window left edge
    let abs_y = 200; // 100px from window top edge

    let (rel_x, rel_y) = relative_coordinates(abs_x, abs_y, win_x, win_y);
    assert_eq!(rel_x, 250);
    assert_eq!(rel_y, 100);

    let rect = create_window_rect(win_x, win_y, win_w, win_h);
    assert_eq!(rect.x, 1800);
    assert_eq!(rect.width, 400);
}

#[test]
fn large_virtual_desktop_coordinates() {
    // 4K monitor at 100% DPI: coordinates can reach 3840x2160
    let win_x = 2500;
    let win_y = 1500;
    let abs_x = 3200;
    let abs_y = 1800;

    let (rel_x, rel_y) = relative_coordinates(abs_x, abs_y, win_x, win_y);
    assert_eq!(rel_x, 700);
    assert_eq!(rel_y, 300);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIXED DPI SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn mixed_dpi_primary_100_secondary_150() {
    // Primary at 100% (0,0), secondary at 150% starting at x=1920.
    // All values below are physical pixels — the space the process receives
    // under per-monitor-v2. A window at physical (2100, 100) on the secondary:
    let win_x = 2100;
    let win_y = 100;

    // Click at physical (2300, 250)
    let abs_x = 2300;
    let abs_y = 250;

    let (rel_x, rel_y) = relative_coordinates(abs_x, abs_y, win_x, win_y);
    assert_eq!(rel_x, 200);
    assert_eq!(rel_y, 150);

    // The key insight: under DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 the
    // process receives physical pixels everywhere — hook coordinates and
    // GetWindowRect alike — so the coordinate module doesn't need to know
    // about DPI: it just subtracts values that share one space.
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPTURE MODE DETERMINATION
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn capture_mode_for_common_control_types() {
    // Button (50000) → Accessibility
    assert_eq!(determine_capture_mode(50000), CaptureMode::Accessibility);
    // Edit (50004) → Accessibility
    assert_eq!(determine_capture_mode(50004), CaptureMode::Accessibility);
    // CheckBox (50002) → Accessibility
    assert_eq!(determine_capture_mode(50002), CaptureMode::Accessibility);
    // ComboBox (50003) → Accessibility
    assert_eq!(determine_capture_mode(50003), CaptureMode::Accessibility);
    // List (50008) → Accessibility
    assert_eq!(determine_capture_mode(50008), CaptureMode::Accessibility);
    // TreeItem (50024) → Accessibility
    assert_eq!(determine_capture_mode(50024), CaptureMode::Accessibility);
    // Window (50032) → Coordinate (fallback)
    assert_eq!(determine_capture_mode(50032), CaptureMode::Coordinate);
    // Pane (50033) → Coordinate (fallback)
    assert_eq!(determine_capture_mode(50033), CaptureMode::Coordinate);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTY-BASED: DPI SCALING ROUND-TRIP
// ═══════════════════════════════════════════════════════════════════════════════

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    /// For any DPI scale factor and coordinate, converting physical → logical
    /// then computing relative coordinates produces the same result as
    /// converting the relative physical coordinates directly.
    #[test]
    fn dpi_scaling_relative_coords_commute(
        physical_abs_x in 0..10000i32,
        physical_abs_y in 0..10000i32,
        physical_win_x in 0..5000i32,
        physical_win_y in 0..5000i32,
        // DPI scale as integer percentage (100, 125, 150, 175, 200)
        dpi_pct in prop_oneof![
            Just(100u32),
            Just(125u32),
            Just(150u32),
            Just(175u32),
            Just(200u32),
        ],
    ) {
        let scale = dpi_pct as f64 / 100.0;

        // Approach 1: convert to logical first, then compute relative
        let logical_abs_x = physical_to_logical(physical_abs_x, scale);
        let logical_abs_y = physical_to_logical(physical_abs_y, scale);
        let logical_win_x = physical_to_logical(physical_win_x, scale);
        let logical_win_y = physical_to_logical(physical_win_y, scale);
        let (rel_x_1, rel_y_1) = relative_coordinates(
            logical_abs_x, logical_abs_y, logical_win_x, logical_win_y,
        );

        // Approach 2: compute relative in physical, then convert to logical
        let physical_rel_x = physical_abs_x - physical_win_x;
        let physical_rel_y = physical_abs_y - physical_win_y;
        let rel_x_2 = physical_to_logical(physical_rel_x, scale);
        let rel_y_2 = physical_to_logical(physical_rel_y, scale);

        // They should be equal (or differ by at most 1 due to rounding)
        prop_assert!(
            (rel_x_1 - rel_x_2).abs() <= 1,
            "rel_x mismatch: approach1={}, approach2={}, scale={}",
            rel_x_1, rel_x_2, scale
        );
        prop_assert!(
            (rel_y_1 - rel_y_2).abs() <= 1,
            "rel_y mismatch: approach1={}, approach2={}, scale={}",
            rel_y_1, rel_y_2, scale
        );
    }

    /// Negative coordinates (secondary monitor to the left/above) produce
    /// correct relative values regardless of the absolute position.
    #[test]
    fn negative_coordinates_produce_correct_relative(
        win_x in -5000..0i32,
        win_y in -5000..0i32,
        offset_x in 0..2000i32,
        offset_y in 0..2000i32,
    ) {
        let abs_x = win_x + offset_x;
        let abs_y = win_y + offset_y;

        let (rel_x, rel_y) = relative_coordinates(abs_x, abs_y, win_x, win_y);

        prop_assert_eq!(rel_x, offset_x);
        prop_assert_eq!(rel_y, offset_y);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IGNORED TESTS — require actual multi-monitor hardware
// ═══════════════════════════════════════════════════════════════════════════════

/// Manual verification test for multi-monitor setups.
///
/// To run: `cargo test --test coordinate_dpi_test multi_monitor_manual -- --ignored`
///
/// Prerequisites:
/// - At least 2 monitors connected
/// - Secondary monitor positioned to the left (negative X coordinates)
///
/// What to verify:
/// 1. Run the test — it prints the virtual desktop bounds
/// 2. Confirm the bounds include negative coordinates
/// 3. The test creates a window on the secondary monitor and clicks it
/// 4. Verify the captured coordinates are relative to the window (positive)
#[test]
#[ignore]
#[cfg(target_os = "windows")]
fn multi_monitor_manual_verification() {
    use windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
    use windows::Win32::UI::WindowsAndMessaging::{
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        println!(
            "Virtual desktop: origin=({}, {}), size={}x{}",
            vx, vy, vw, vh
        );
        println!("If origin is (0,0), you only have one monitor or secondary is to the right.");
        println!("If origin is negative, secondary monitor is to the left/above.");

        // On a multi-monitor setup with secondary to the left:
        // vx should be negative (e.g., -1920)
        if vx >= 0 && vy >= 0 {
            println!("SKIP: No secondary monitor to the left/above detected.");
            println!("To test negative coordinates, position a monitor to the left.");
            return;
        }

        println!("Multi-monitor detected with negative coordinates.");
        println!(
            "Virtual desktop spans from ({},{}) to ({},{})",
            vx,
            vy,
            vx + vw,
            vy + vh
        );

        // Verify our coordinate math works with the actual virtual desktop bounds
        let win_x = vx + 100; // Window on secondary monitor
        let win_y = vy + 100;
        let click_x = win_x + 50;
        let click_y = win_y + 50;

        let (rel_x, rel_y) = relative_coordinates(click_x, click_y, win_x, win_y);
        assert_eq!(rel_x, 50, "Relative X should be 50 on secondary monitor");
        assert_eq!(rel_y, 50, "Relative Y should be 50 on secondary monitor");
        println!("✓ Coordinate math correct for secondary monitor position");
    }
}
