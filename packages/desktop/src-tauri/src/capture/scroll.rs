// Scroll debounce/threshold filtering, the platform-agnostic PID-exclusion
// base rule, the executable-name ground of DCP-5's self-capture exclusion
// (the whole-name comparison against the webview runtime's file name and
// Docent's own binary name), and the keyboard hook's key attribution
// (DCP-14: which window a keydown is attributed to, or none) — pure-Rust
// logic for capture noise reduction and scoping.
//
// This module contains NO platform API calls so it can be compiled and tested
// on any target. Platform-specific concerns layer on top elsewhere: the actual
// `WM_MOUSEWHEEL` monitoring, the WebView2 process-tree filtering, and the
// Windows wrapper that reads a process's executable name live in `windows.rs`.
//
// Requirements (the shared debounce/coalesce rule, core CP-16; the window's
// and the floor's values, and the floor's units, are `timing.rs`'s):
// - Debounce scroll events — record only after scrolling stops for
//   `SCROLL_DEBOUNCE_MS`.
// - Discard scroll events whose net displacement stays within
//   `SCROLL_MIN_DISTANCE_PX` on both axes.

// ---------------------------------------------------------------------------
// Constants (imported from timing.rs — single source of truth)
// ---------------------------------------------------------------------------

use super::timing::{
    debounce_elapsed, SCROLL_DEBOUNCE_MS as DEBOUNCE_MS,
    SCROLL_MIN_DISTANCE_PX as MIN_SCROLL_DISTANCE_PX,
};

// ---------------------------------------------------------------------------
// Scroll event
// ---------------------------------------------------------------------------

/// A single raw scroll event with a timestamp and per-axis deltas.
///
/// Both deltas are the values the platform's input layer feeds, unconverted:
/// native wheel-delta units, not pixels, signed by the platform's wheel
/// convention — the units and sign the exported scroll action's
/// `delta_x`/`delta_y` carry (`schemas/shared.schema.json`, `action_scroll`).
/// Windows feeds the raw `WM_MOUSEHWHEEL` delta to `delta_x` (positive = wheel
/// tilted right) and the raw `WM_MOUSEWHEEL` delta to `delta_y` (positive =
/// wheel rotated forward, away from the user, i.e. scrolling up).
#[derive(Debug, Clone)]
pub struct RawScrollEvent {
    /// Unix millisecond timestamp of this scroll event.
    pub timestamp: u64,
    /// Horizontal scroll delta.
    pub delta_x: f64,
    /// Vertical scroll delta.
    pub delta_y: f64,
}

// ---------------------------------------------------------------------------
// Scroll accumulator result
// ---------------------------------------------------------------------------

/// The result of processing a scroll sequence through debounce + threshold.
///
/// Each total is the signed sum of the sequence's [`RawScrollEvent`] deltas on
/// that axis, summed unchanged — so in the units and sign that
/// [`RawScrollEvent`] states.
#[derive(Debug, Clone, PartialEq)]
pub struct ScrollResult {
    /// Net horizontal displacement: the sequence's summed `delta_x`.
    pub total_delta_x: f64,
    /// Net vertical displacement: the sequence's summed `delta_y`.
    pub total_delta_y: f64,
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/// Process a sequence of raw scroll events and determine which scroll actions
/// should be emitted.
///
/// The algorithm:
/// 1. Group consecutive events into "sequences" separated by gaps ≥ `DEBOUNCE_MS`.
/// 2. For each sequence, sum the deltas across all events.
/// 3. Discard sequences where `|total_delta_x| ≤ MIN_SCROLL_DISTANCE_PX` AND
///    `|total_delta_y| ≤ MIN_SCROLL_DISTANCE_PX`.
/// 4. Return the surviving sequences as [`ScrollResult`]s.
///
/// `DEBOUNCE_MS` and `MIN_SCROLL_DISTANCE_PX` are this module's aliases of
/// [`SCROLL_DEBOUNCE_MS`](super::timing::SCROLL_DEBOUNCE_MS) and
/// [`SCROLL_MIN_DISTANCE_PX`](super::timing::SCROLL_MIN_DISTANCE_PX), whose
/// docs own the values and the floor's units.
///
/// The input events MUST be sorted by timestamp (ascending). If they are not,
/// the behaviour is undefined (but will not panic).
pub fn process_scroll_events(events: &[RawScrollEvent]) -> Vec<ScrollResult> {
    if events.is_empty() {
        return Vec::new();
    }

    let mut results = Vec::new();
    let mut seq_start = 0;

    for i in 1..=events.len() {
        // Check if this is the end of a sequence (gap ≥ DEBOUNCE_MS or end of input).
        let is_end = if i == events.len() {
            true
        } else {
            debounce_elapsed(events[i].timestamp, events[i - 1].timestamp, DEBOUNCE_MS)
        };

        if is_end {
            // Sum deltas for this sequence.
            let (total_dx, total_dy) = events[seq_start..i]
                .iter()
                .fold((0.0_f64, 0.0_f64), |(dx, dy), e| {
                    (dx + e.delta_x, dy + e.delta_y)
                });

            // Apply threshold filter: emit only if at least one axis exceeds
            // the minimum distance.
            if total_dx.abs() > MIN_SCROLL_DISTANCE_PX || total_dy.abs() > MIN_SCROLL_DISTANCE_PX {
                results.push(ScrollResult {
                    total_delta_x: total_dx,
                    total_delta_y: total_dy,
                });
            }

            seq_start = i;
        }
    }

    results
}

// ---------------------------------------------------------------------------
// Stateful accumulator (for use by the capture thread)
// ---------------------------------------------------------------------------

/// Accumulates scroll events and determines when to emit a scroll action.
///
/// Used by the Windows capture thread to track the current scroll sequence.
/// Call `push()` for each `WM_MOUSEWHEEL` event and `try_flush()` periodically
/// (e.g. on a timer tick) to check if the debounce interval has elapsed.
#[derive(Debug)]
pub struct ScrollAccumulator {
    /// Buffered events in the current sequence.
    buffer: Vec<RawScrollEvent>,
}

impl Default for ScrollAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl ScrollAccumulator {
    /// Create a new empty accumulator.
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    /// Push a new scroll event into the accumulator.
    pub fn push(&mut self, event: RawScrollEvent) {
        self.buffer.push(event);
    }

    /// Check if the debounce interval has elapsed since the last event.
    ///
    /// `now` is the current Unix millisecond timestamp.
    ///
    /// Returns `Some(ScrollResult)` if a scroll action should be emitted
    /// (debounce elapsed AND threshold exceeded), or `None` if not.
    pub fn try_flush(&mut self, now: u64) -> Option<ScrollResult> {
        if self.buffer.is_empty() {
            return None;
        }

        let last_ts = self.buffer.last().unwrap().timestamp;
        if !debounce_elapsed(now, last_ts, DEBOUNCE_MS) {
            return None; // Still within debounce window.
        }

        // Debounce elapsed — sum deltas and check threshold.
        let (total_dx, total_dy) = self.buffer.iter().fold((0.0_f64, 0.0_f64), |(dx, dy), e| {
            (dx + e.delta_x, dy + e.delta_y)
        });

        // Clear the buffer regardless of threshold.
        self.buffer.clear();

        // Apply threshold filter.
        if total_dx.abs() > MIN_SCROLL_DISTANCE_PX || total_dy.abs() > MIN_SCROLL_DISTANCE_PX {
            Some(ScrollResult {
                total_delta_x: total_dx,
                total_delta_y: total_dy,
            })
        } else {
            None
        }
    }

    /// Discard all buffered events without emitting.
    pub fn clear(&mut self) {
        self.buffer.clear();
    }

    /// Returns `true` if there are buffered events waiting for debounce.
    pub fn has_pending(&self) -> bool {
        !self.buffer.is_empty()
    }
}

// ---------------------------------------------------------------------------
// PID filtering (pure logic)
// ---------------------------------------------------------------------------

/// Determine whether an event should be kept or discarded based on PID
/// exclusion rules.
///
/// Returns `true` if the event should be **kept** (not filtered out).
///
/// This is the platform-agnostic base filter: it drops PID 0 (invalid /
/// already-destroyed window) and the excluded PID itself, and keeps everything
/// when exclusion is disabled. Platform modules layer their own process-tree
/// filtering (e.g. Windows WebView2 child processes, owned system dialogs) on
/// top of this base rule — that logic lives in each platform's module.
///
/// # Arguments
/// - `event_pid`: The process ID that generated the event.
/// - `excluded_pid`: The PID to exclude (if any).
///
/// # Requirements
/// - Exclude events from the app's own process by default.
/// - When exclusion is disabled (excluded_pid is None), keep all events.
pub fn should_keep_event(event_pid: u32, excluded_pid: Option<u32>) -> bool {
    // PID 0 means the window was already destroyed or invalid — skip it.
    if event_pid == 0 {
        return false;
    }
    match excluded_pid {
        Some(excl) => event_pid != excl,
        None => true,
    }
}

/// The webview runtime's executable file name (DCP-5's executable-name ground).
pub const WEBVIEW_RUNTIME_EXE: &str = "msedgewebview2.exe";

/// The executable-name ground of self-capture exclusion (DCP-5) as pure logic:
/// `true` when `exe_name` is the webview runtime's file name or Docent's own
/// binary name, `own_exe_name` — the running process's own executable file
/// name, so the dev binary, the bundled binary and every test binary each
/// recognize themselves without a hard-coded product name. Whole-name,
/// case-insensitive comparison (Windows file names are case-insensitive); a
/// name that merely contains either one is not recognized.
pub fn is_recognized_exe_name(exe_name: &str, own_exe_name: Option<&str>) -> bool {
    let lower = exe_name.to_lowercase();
    lower == WEBVIEW_RUNTIME_EXE || own_exe_name.is_some_and(|own| lower == own.to_lowercase())
}

/// Which window a keydown the keyboard hook sees is attributed to (desktop
/// capture DCP-14), and so whether it is kept at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAttribution {
    /// Kept, attributed to the foreground window.
    ForegroundWindow,
    /// Kept, attributed to no window.
    NoWindow,
    /// Not kept.
    Dropped,
}

/// The keyboard hook's attribution of a keydown as pure logic (DCP-14,
/// DCP-5). `foreground_kept` is the scope filters' verdict on the foreground
/// window's process `foreground_pid`; `key_code` and `modifiers` (ctrl,
/// shift, alt, meta, as the hook reads them) say whether the system takes the
/// key ([`system_takes_key`]).
///
/// A key the foreground window's verdict keeps stays on that window. A key
/// the system takes is kept with no window when the verdict dropped the
/// foreground window on the self-capture exclusion's grounds alone — no
/// target set, so the target filter dropped nothing; the exclusion on; a
/// resolvable foreground process, so the resolvable-window skip dropped
/// nothing. Every other dropped key stays dropped.
pub fn keyboard_attribution(
    key_code: u32,
    modifiers: (bool, bool, bool, bool),
    foreground_pid: u32,
    included_pid: Option<u32>,
    excluded_pid: Option<u32>,
    foreground_kept: bool,
) -> KeyAttribution {
    if foreground_kept {
        return KeyAttribution::ForegroundWindow;
    }
    if system_takes_key(key_code, modifiers)
        && included_pid.is_none()
        && excluded_pid.is_some()
        && foreground_pid != 0
    {
        KeyAttribution::NoWindow
    } else {
        KeyAttribution::Dropped
    }
}

/// Whether the system, not the foreground window, acts on a keydown (DCP-14):
/// the Windows key, or any key while it is held; Escape with Ctrl held and
/// Alt not (Ctrl+Esc opens Start); Tab or Escape with Alt held (Alt+Tab and
/// Alt+Esc switch windows). An Alt keydown alone is none of these.
pub fn system_takes_key(key_code: u32, modifiers: (bool, bool, bool, bool)) -> bool {
    let (ctrl, _shift, alt, meta) = modifiers;
    meta || key_code == VK_LWIN
        || key_code == VK_RWIN
        || (key_code == VK_ESCAPE && ctrl && !alt)
        || ((key_code == VK_TAB || key_code == VK_ESCAPE) && alt)
}

/// The virtual-key codes [`system_takes_key`] reads.
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_TAB: u32 = 0x09;
const VK_ESCAPE: u32 = 0x1B;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- keyboard_attribution ------------------------------------------------

    const DOCENT: u32 = 100;
    const OTHER_APP: u32 = 200;
    /// Modifier states as the hook reads them: (ctrl, shift, alt, meta).
    const NONE: (bool, bool, bool, bool) = (false, false, false, false);
    const WIN: (bool, bool, bool, bool) = (false, false, false, true);
    const CTRL: (bool, bool, bool, bool) = (true, false, false, false);
    const CTRL_SHIFT: (bool, bool, bool, bool) = (true, true, false, false);
    const ALT: (bool, bool, bool, bool) = (false, false, true, false);
    const ALT_SHIFT: (bool, bool, bool, bool) = (false, true, true, false);
    const CTRL_ALT: (bool, bool, bool, bool) = (true, false, true, false);
    const VK_MENU: u32 = 0x12;
    const VK_LMENU: u32 = 0xA4;
    const VK_R: u32 = 0x52;

    // Regression: #687 — a Windows key press made while Docent's own window
    // was in front was dropped as input to Docent, although the shell acts on
    // it, so the recording began inside Start search with no key opening it.
    // https://github.com/Arsarneq/docent/issues/687
    #[test]
    fn regression_687_win_key_over_docent_is_kept_with_no_window() {
        // No target ("All applications"), exclusion on, Docent in front: the
        // scope filters drop the foreground window's process.
        for vk in [VK_LWIN, VK_RWIN] {
            assert_eq!(
                keyboard_attribution(vk, NONE, DOCENT, None, Some(DOCENT), false),
                KeyAttribution::NoWindow
            );
        }
        // Win+R: R pressed while the Windows key is held.
        assert_eq!(
            keyboard_attribution(VK_R, WIN, DOCENT, None, Some(DOCENT), false),
            KeyAttribution::NoWindow
        );
    }

    // Regression: #687 — Ctrl+Esc opens Start exactly as the Windows key
    // does, and pressed over Docent's own window it was dropped the same way.
    // https://github.com/Arsarneq/docent/issues/687
    #[test]
    fn regression_687_ctrl_esc_over_docent_is_kept_with_no_window() {
        assert_eq!(
            keyboard_attribution(VK_ESCAPE, CTRL, DOCENT, None, Some(DOCENT), false),
            KeyAttribution::NoWindow
        );
        // Ctrl+Shift+Esc too, whenever the hook sees it.
        assert_eq!(
            keyboard_attribution(VK_ESCAPE, CTRL_SHIFT, DOCENT, None, Some(DOCENT), false),
            KeyAttribution::NoWindow
        );
    }

    #[test]
    fn alt_tab_and_alt_esc_over_docent_are_kept_with_no_window() {
        for mods in [ALT, ALT_SHIFT, CTRL_ALT] {
            for vk in [VK_TAB, VK_ESCAPE] {
                assert_eq!(
                    keyboard_attribution(vk, mods, DOCENT, None, Some(DOCENT), false),
                    KeyAttribution::NoWindow,
                    "vk {vk:#x} with {mods:?}"
                );
            }
        }
    }

    #[test]
    fn keys_the_system_does_not_take_over_docent_stay_dropped() {
        let cases = [
            (VK_LMENU, ALT),   // the Alt keydown alone
            (VK_MENU, ALT),    // the generic Alt code alone
            (VK_ESCAPE, NONE), // Escape alone
            (VK_TAB, NONE),    // Tab alone
            (VK_TAB, CTRL),    // Ctrl+Tab is the window's own
            (VK_TAB, CTRL_SHIFT),
            (VK_R, CTRL), // a Ctrl shortcut
            (VK_R, ALT),  // an Alt shortcut
        ];
        for (vk, mods) in cases {
            assert_eq!(
                keyboard_attribution(vk, mods, DOCENT, None, Some(DOCENT), false),
                KeyAttribution::Dropped,
                "vk {vk:#x} with {mods:?}"
            );
        }
    }

    #[test]
    fn a_key_over_docent_without_the_windows_key_is_dropped() {
        assert_eq!(
            keyboard_attribution(VK_R, NONE, DOCENT, None, Some(DOCENT), false),
            KeyAttribution::Dropped
        );
    }

    #[test]
    fn a_system_key_with_a_target_set_is_not_the_targets_input() {
        // Docent in front, a target selected: the system key is dropped.
        assert_eq!(
            keyboard_attribution(VK_LWIN, NONE, DOCENT, Some(OTHER_APP), Some(DOCENT), false),
            KeyAttribution::Dropped
        );
        // Another out-of-target window in front, exclusion off: dropped too.
        assert_eq!(
            keyboard_attribution(VK_LWIN, NONE, OTHER_APP, Some(DOCENT), None, false),
            KeyAttribution::Dropped
        );
    }

    #[test]
    fn a_system_key_with_no_resolvable_foreground_window_is_dropped() {
        assert_eq!(
            keyboard_attribution(VK_LWIN, NONE, 0, None, Some(DOCENT), false),
            KeyAttribution::Dropped
        );
        assert_eq!(
            keyboard_attribution(VK_LWIN, NONE, 0, None, None, false),
            KeyAttribution::Dropped
        );
    }

    #[test]
    fn a_kept_foreground_window_keeps_every_key_on_it() {
        for (vk, mods) in [(VK_LWIN, NONE), (VK_R, WIN), (VK_R, NONE)] {
            assert_eq!(
                keyboard_attribution(vk, mods, OTHER_APP, None, Some(DOCENT), true),
                KeyAttribution::ForegroundWindow
            );
        }
    }

    // -- process_scroll_events ---------------------------------------------

    #[test]
    fn empty_input_produces_no_results() {
        assert!(process_scroll_events(&[]).is_empty());
    }

    #[test]
    fn single_large_scroll_is_emitted() {
        let events = vec![RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 300.0,
        }];
        let results = process_scroll_events(&events);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].total_delta_y, 300.0);
    }

    #[test]
    fn single_small_scroll_is_discarded() {
        let events = vec![RawScrollEvent {
            timestamp: 1000,
            delta_x: 50.0,
            delta_y: 100.0,
        }];
        let results = process_scroll_events(&events);
        assert!(results.is_empty());
    }

    #[test]
    fn displacement_at_floor_is_discarded() {
        let events = vec![RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 200.0,
        }];
        let results = process_scroll_events(&events);
        assert!(
            results.is_empty(),
            "exactly 200 wheel-delta units should be discarded (≤ 200)"
        );
    }

    #[test]
    fn displacement_just_over_floor_is_emitted() {
        let events = vec![RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 200.1,
        }];
        let results = process_scroll_events(&events);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn rapid_events_accumulate_into_one_sequence() {
        // Events within 300ms of each other form one sequence.
        let events = vec![
            RawScrollEvent {
                timestamp: 1000,
                delta_x: 0.0,
                delta_y: 80.0,
            },
            RawScrollEvent {
                timestamp: 1050,
                delta_x: 0.0,
                delta_y: 80.0,
            },
            RawScrollEvent {
                timestamp: 1100,
                delta_x: 0.0,
                delta_y: 80.0,
            },
        ];
        let results = process_scroll_events(&events);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].total_delta_y, 240.0);
    }

    #[test]
    fn gap_splits_into_two_sequences() {
        let events = vec![
            // Sequence 1: total_y = 250 (emitted)
            RawScrollEvent {
                timestamp: 1000,
                delta_x: 0.0,
                delta_y: 125.0,
            },
            RawScrollEvent {
                timestamp: 1050,
                delta_x: 0.0,
                delta_y: 125.0,
            },
            // Gap of 300ms
            // Sequence 2: total_y = 50 (discarded)
            RawScrollEvent {
                timestamp: 1400,
                delta_x: 0.0,
                delta_y: 50.0,
            },
        ];
        let results = process_scroll_events(&events);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].total_delta_y, 250.0);
    }

    #[test]
    fn horizontal_scroll_exceeding_threshold_is_emitted() {
        let events = vec![RawScrollEvent {
            timestamp: 1000,
            delta_x: 250.0,
            delta_y: 0.0,
        }];
        let results = process_scroll_events(&events);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].total_delta_x, 250.0);
    }

    #[test]
    fn negative_deltas_accumulate_correctly() {
        let events = vec![
            RawScrollEvent {
                timestamp: 1000,
                delta_x: 0.0,
                delta_y: -150.0,
            },
            RawScrollEvent {
                timestamp: 1050,
                delta_x: 0.0,
                delta_y: -100.0,
            },
        ];
        let results = process_scroll_events(&events);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].total_delta_y, -250.0);
    }

    // -- ScrollAccumulator -------------------------------------------------

    #[test]
    fn accumulator_empty_flush_returns_none() {
        let mut acc = ScrollAccumulator::new();
        assert!(acc.try_flush(5000).is_none());
    }

    #[test]
    fn accumulator_within_debounce_returns_none() {
        let mut acc = ScrollAccumulator::new();
        acc.push(RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 300.0,
        });
        // Only 100ms later — still within debounce.
        assert!(acc.try_flush(1100).is_none());
    }

    #[test]
    fn accumulator_after_debounce_emits_if_threshold_met() {
        let mut acc = ScrollAccumulator::new();
        acc.push(RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 300.0,
        });
        let result = acc.try_flush(1300);
        assert!(result.is_some());
        assert_eq!(result.unwrap().total_delta_y, 300.0);
        // Buffer should be cleared.
        assert!(!acc.has_pending());
    }

    #[test]
    fn accumulator_after_debounce_discards_if_threshold_not_met() {
        let mut acc = ScrollAccumulator::new();
        acc.push(RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 50.0,
        });
        let result = acc.try_flush(1300);
        assert!(result.is_none());
        assert!(!acc.has_pending());
    }

    #[test]
    fn accumulator_clear_discards_pending() {
        let mut acc = ScrollAccumulator::new();
        acc.push(RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 500.0,
        });
        acc.clear();
        assert!(!acc.has_pending());
        assert!(acc.try_flush(2000).is_none());
    }

    // -- is_recognized_exe_name (DCP-5 executable-name ground) ------------

    #[test]
    fn recognized_exe_name_matches_own_name_whole_and_case_insensitively() {
        assert!(is_recognized_exe_name(
            "Docent-Desktop.EXE",
            Some("docent-desktop.exe")
        ));
        assert!(is_recognized_exe_name(
            "Docent Desktop.exe",
            Some("Docent Desktop.exe")
        ));
    }

    #[test]
    fn recognized_exe_name_matches_the_webview_runtime_whole_name() {
        assert!(is_recognized_exe_name("MSEdgeWebView2.exe", None));
        assert!(is_recognized_exe_name(
            "msedgewebview2.exe",
            Some("docent-desktop.exe")
        ));
    }

    // Regression: a third-party binary whose name merely contains "docent" was
    // excluded by the substring match. No GitHub issue — found reconciling
    // DCP-5's "binary name" against the code.
    #[test]
    fn regression_noissue_exe_name_only_containing_docent_is_kept() {
        assert!(!is_recognized_exe_name(
            "docent-helper.exe",
            Some("docent-desktop.exe")
        ));
        assert!(!is_recognized_exe_name("docentcloud.exe", None));
        assert!(!is_recognized_exe_name(
            "old-docent-desktop.exe",
            Some("docent-desktop.exe")
        ));
    }

    // Regression: a binary whose name merely contains "msedgewebview2" (an
    // updater, say) was excluded by the substring match. No GitHub issue — the
    // same reconcile.
    #[test]
    fn regression_noissue_exe_name_only_containing_the_runtime_name_is_kept() {
        assert!(!is_recognized_exe_name("msedgewebview2_updater.exe", None));
        assert!(!is_recognized_exe_name("x_msedgewebview2.exe", None));
    }

    // -- should_keep_event (PID filtering) ---------------------------------

    #[test]
    fn event_from_excluded_pid_is_filtered() {
        assert!(!should_keep_event(1234, Some(1234)));
    }

    #[test]
    fn event_from_different_pid_is_kept() {
        assert!(should_keep_event(5678, Some(1234)));
    }

    #[test]
    fn no_exclusion_keeps_all_events() {
        assert!(should_keep_event(1234, None));
    }

    #[test]
    fn pid_zero_is_always_filtered() {
        // PID 0 means the window was already destroyed or invalid — always skip.
        assert!(!should_keep_event(0, None));
        assert!(!should_keep_event(0, Some(1234)));
    }
}
