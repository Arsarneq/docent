// Scroll debounce and threshold filtering — pure-Rust logic for scroll
// noise reduction.
//
// This module contains NO Windows API calls so it can be compiled and tested
// on any platform. The actual `WM_MOUSEWHEEL` monitoring lives in `windows.rs`.
//
// Requirements:
// - 13.1: Debounce scroll events — record only after scrolling stops for 300ms.
// - 13.2: Discard scroll events where total distance ≤ 200px in both axes.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Debounce interval in milliseconds. A scroll action is emitted only after
/// no scroll event arrives for this duration.
pub const DEBOUNCE_MS: u64 = 300;

/// Minimum scroll distance (in pixels) required in at least one axis for the
/// scroll to be recorded. Sequences where both `|total_delta_x|` and
/// `|total_delta_y|` are ≤ this threshold are discarded.
pub const MIN_SCROLL_DISTANCE_PX: f64 = 200.0;

// ---------------------------------------------------------------------------
// Scroll event
// ---------------------------------------------------------------------------

/// A single raw scroll event with a timestamp and per-axis deltas.
#[derive(Debug, Clone)]
pub struct RawScrollEvent {
    /// Unix millisecond timestamp of this scroll event.
    pub timestamp: u64,
    /// Horizontal scroll delta in pixels (positive = right).
    pub delta_x: f64,
    /// Vertical scroll delta in pixels (positive = down).
    pub delta_y: f64,
}

// ---------------------------------------------------------------------------
// Scroll accumulator result
// ---------------------------------------------------------------------------

/// The result of processing a scroll sequence through debounce + threshold.
#[derive(Debug, Clone, PartialEq)]
pub struct ScrollResult {
    /// Total horizontal scroll distance (sum of all `delta_x` in the sequence).
    pub total_delta_x: f64,
    /// Total vertical scroll distance (sum of all `delta_y` in the sequence).
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
/// 4. Return the surviving sequences as `ScrollResult`s.
///
/// The input events MUST be sorted by timestamp (ascending). If they are not,
/// the behaviour is undefined (but will not panic).
///
/// # Requirements
/// - 13.1: Debounce at 300ms
/// - 13.2: Discard ≤ 200px in both axes
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
            events[i].timestamp.saturating_sub(events[i - 1].timestamp) >= DEBOUNCE_MS
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
            if total_dx.abs() > MIN_SCROLL_DISTANCE_PX
                || total_dy.abs() > MIN_SCROLL_DISTANCE_PX
            {
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

impl ScrollAccumulator {
    /// Create a new empty accumulator.
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
        }
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
        if now.saturating_sub(last_ts) < DEBOUNCE_MS {
            return None; // Still within debounce window.
        }

        // Debounce elapsed — sum deltas and check threshold.
        let (total_dx, total_dy) = self
            .buffer
            .iter()
            .fold((0.0_f64, 0.0_f64), |(dx, dy), e| {
                (dx + e.delta_x, dy + e.delta_y)
            });

        // Clear the buffer regardless of threshold.
        self.buffer.clear();

        // Apply threshold filter.
        if total_dx.abs() > MIN_SCROLL_DISTANCE_PX
            || total_dy.abs() > MIN_SCROLL_DISTANCE_PX
        {
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
/// # Arguments
/// - `event_pid`: The process ID that generated the event.
/// - `excluded_pid`: The PID to exclude (if any).
///
/// # Requirements
/// - 16.1: Exclude events from the app's own process by default.
/// - 16.3: When exclusion is disabled (excluded_pid is None), keep all events.
pub fn should_keep_event(event_pid: u32, excluded_pid: Option<u32>) -> bool {
    // PID 0 means the window was already destroyed or invalid — skip it.
    if event_pid == 0 {
        return false;
    }
    match excluded_pid {
        Some(excl) => {
            if event_pid == excl {
                return false;
            }
            #[cfg(target_os = "windows")]
            {
                // Check if the process is part of the Docent process tree.
                // WebView2 spawns multiple levels of child processes, so we check
                // both the ancestor chain AND the process executable name.
                if is_descendant_of(event_pid, excl) {
                    return false;
                }
                // Fallback: check if the process is msedgewebview2.exe
                // (WebView2 renderer) — these are always Docent's children
                // when self-capture exclusion is enabled.
                if is_webview_process(event_pid) {
                    return false;
                }
            }
            true
        }
        None => true,
    }
}

/// Check if a process is a WebView2 renderer by its executable name.
#[cfg(target_os = "windows")]
fn is_webview_process(pid: u32) -> bool {
    if let Some(name) = get_process_exe_name(pid) {
        let lower = name.to_lowercase();
        lower.contains("msedgewebview2") || lower.contains("docent")
    } else {
        false
    }
}

/// Check if `pid` is a descendant (child, grandchild, etc.) of `ancestor_pid`.
/// Walks up the process tree via parent PIDs, up to 5 levels deep.
#[cfg(target_os = "windows")]
fn is_descendant_of(pid: u32, ancestor_pid: u32) -> bool {
    let mut current = pid;
    for _ in 0..5 {
        match get_parent_pid(current) {
            Some(parent) if parent == ancestor_pid => return true,
            Some(parent) if parent == 0 || parent == current => return false,
            Some(parent) => current = parent,
            None => return false,
        }
    }
    false
}

/// Get the executable name of a process by PID.
#[cfg(target_os = "windows")]
fn get_process_exe_name(pid: u32) -> Option<String> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == pid {
                    let _ = windows::Win32::Foundation::CloseHandle(snapshot);
                    let name = entry.szExeFile.iter()
                        .take_while(|&&c| c != 0)
                        .map(|&c| c as u8 as char)
                        .collect::<String>();
                    return Some(name);
                }
                if Process32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        None
    }
}

/// Public wrapper for debugging — get process exe name by PID.
#[cfg(target_os = "windows")]
pub fn get_process_exe_name_pub(pid: u32) -> Option<String> {
    get_process_exe_name(pid)
}

/// Get the parent PID of a process on Windows using CreateToolhelp32Snapshot.
#[cfg(target_os = "windows")]
fn get_parent_pid(pid: u32) -> Option<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == pid {
                    let _ = windows::Win32::Foundation::CloseHandle(snapshot);
                    return Some(entry.th32ParentProcessID);
                }
                if Process32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        None
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
    fn exactly_200px_is_discarded() {
        let events = vec![RawScrollEvent {
            timestamp: 1000,
            delta_x: 0.0,
            delta_y: 200.0,
        }];
        let results = process_scroll_events(&events);
        assert!(results.is_empty(), "exactly 200px should be discarded (≤ 200)");
    }

    #[test]
    fn just_over_200px_is_emitted() {
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
            RawScrollEvent { timestamp: 1000, delta_x: 0.0, delta_y: 80.0 },
            RawScrollEvent { timestamp: 1050, delta_x: 0.0, delta_y: 80.0 },
            RawScrollEvent { timestamp: 1100, delta_x: 0.0, delta_y: 80.0 },
        ];
        let results = process_scroll_events(&events);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].total_delta_y, 240.0);
    }

    #[test]
    fn gap_splits_into_two_sequences() {
        let events = vec![
            // Sequence 1: total_y = 250 (emitted)
            RawScrollEvent { timestamp: 1000, delta_x: 0.0, delta_y: 125.0 },
            RawScrollEvent { timestamp: 1050, delta_x: 0.0, delta_y: 125.0 },
            // Gap of 300ms
            // Sequence 2: total_y = 50 (discarded)
            RawScrollEvent { timestamp: 1400, delta_x: 0.0, delta_y: 50.0 },
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
            RawScrollEvent { timestamp: 1000, delta_x: 0.0, delta_y: -150.0 },
            RawScrollEvent { timestamp: 1050, delta_x: 0.0, delta_y: -100.0 },
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
        acc.push(RawScrollEvent { timestamp: 1000, delta_x: 0.0, delta_y: 300.0 });
        // Only 100ms later — still within debounce.
        assert!(acc.try_flush(1100).is_none());
    }

    #[test]
    fn accumulator_after_debounce_emits_if_threshold_met() {
        let mut acc = ScrollAccumulator::new();
        acc.push(RawScrollEvent { timestamp: 1000, delta_x: 0.0, delta_y: 300.0 });
        let result = acc.try_flush(1300);
        assert!(result.is_some());
        assert_eq!(result.unwrap().total_delta_y, 300.0);
        // Buffer should be cleared.
        assert!(!acc.has_pending());
    }

    #[test]
    fn accumulator_after_debounce_discards_if_threshold_not_met() {
        let mut acc = ScrollAccumulator::new();
        acc.push(RawScrollEvent { timestamp: 1000, delta_x: 0.0, delta_y: 50.0 });
        let result = acc.try_flush(1300);
        assert!(result.is_none());
        assert!(!acc.has_pending());
    }

    #[test]
    fn accumulator_clear_discards_pending() {
        let mut acc = ScrollAccumulator::new();
        acc.push(RawScrollEvent { timestamp: 1000, delta_x: 0.0, delta_y: 500.0 });
        acc.clear();
        assert!(!acc.has_pending());
        assert!(acc.try_flush(2000).is_none());
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
