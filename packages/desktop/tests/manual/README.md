# Manual Tests — Desktop Capture

Tests that require a human and real applications. The core capture logic is
verified by 53+ integration tests in `src-tauri/tests/capture_integration.rs`
and 26+ worker pool unit tests in `src-tauri/tests/worker_pool_test.rs`.

## Remaining Manual Tests

These require real OS interactions that can't be reliably simulated in CI:

| #   | Test                    | Why manual                                 |
| --- | ----------------------- | ------------------------------------------ |
| 5   | File dialog navigation  | Complex WinEvent sequence from real dialog |
| 11  | Taskbar click           | Requires computed taskbar coordinates      |
| 12  | Start menu / Win key    | Requires real Start menu interaction       |
| 15  | System tray interaction | Requires computed tray coordinates         |

These will be retired when #57 is completed (Enigo + computed coordinates).

## Retired Tests (now automated or logic-tested)

| #   | Test                          | Covered by                                                                                             |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Type and Save                 | `capture_integration.rs::typing_is_captured` + `select_suppressed_after_click`                         |
| 2   | Title bar buttons             | `capture_integration.rs::title_bar_close_button_click`                                                 |
| 3   | Window move (title bar drag)  | `capture_integration.rs::drag_is_captured`                                                             |
| 4   | Window resize (edge drag)     | `capture_integration.rs::drag_is_captured`                                                             |
| 6   | Double-click to open folder   | `capture_integration.rs::double_click_not_misclassified_as_drag`                                       |
| 7   | Multi-window workflow         | `capture_integration.rs::alt_tab_produces_context_switch` + `context_id_is_consistent_for_same_window` |
| 8   | Right-click context menu      | `capture_integration.rs::right_click_produces_context_switch_for_menu`                                 |
| 9   | Copy-paste between apps       | `capture_integration.rs::right_click_is_captured` + `context_switches`                                 |
| 10  | Custom-rendered window click  | `capture_integration.rs::coordinate_fallback_for_plain_window`                                         |
| 13  | Win+D (show desktop)          | OS-level suppression — hook never receives it                                                          |
| 14  | Win+L (lock screen)           | OS-level suppression — `worker_pool_test::win_l_key_combo_is_captured_if_received` documents behaviour |
| 16  | Ctrl+Shift+Esc (Task Manager) | OS-level suppression — `worker_pool_test::modifier_only_keys_produce_no_events`                        |
| 17  | Win+Arrow (snap/resize)       | `capture_integration.rs::modifier_key_combo_is_captured`                                               |

## How to Run (remaining 4 tests)

1. Build and launch the desktop app: `cargo tauri dev` from `packages/desktop/src-tauri/`
2. Create a project + recording, start recording
3. Perform each test scenario, commit a step after each
4. Export and inspect the captured actions

### Test 5 — File Dialog Navigation

Open File > Open, click through folders, select a file, click Open.
**Expected:** Clicks on tree items (no duplicate select events), no context_close from folder refresh.

### Test 11 — Taskbar Click

Click a taskbar button to switch apps.
**Expected:** context_switch + click.

### Test 12 — Start Menu / Win Key

Press Win key, type to search, press Enter.
**Expected:** Key events for search text, context_switch to search window.

### Test 15 — System Tray Interaction

Click a system tray icon (clock, volume, network).
**Expected:** context_switch + click on tray button.
