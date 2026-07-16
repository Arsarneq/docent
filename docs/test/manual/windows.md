# Manual Tests — Desktop Capture

All desktop manual tests have been retired. The capture logic is verified by
the real-input integration suite in `src-tauri/tests/capture_integration.rs`
(63 tests), the worker pool property tests in
`src-tauri/tests/worker_pool_test.rs` (33 tests), and — locally only — the
file-dialog navigation test in `src-tauri/tests/file_dialog_test.rs`, which
carries the `ci-skip` marker and never runs in CI (it launches Notepad and a
real file dialog); the suppressions it exercises are pinned on CI by the
`deduplication` tests in `capture_integration.rs`. The whole Rust suite is
oriented in [Desktop Rust tests](../desktop-rust.md).

_Test paths below are relative to `packages/desktop/`._

## Retired Tests (now automated or logic-tested)

| #   | Test                          | Covered by                                                                                                                                                                   |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Type and Save                 | `capture_integration.rs::typing_is_captured` + `select_suppressed_after_click`                                                                                               |
| 2   | Title bar buttons             | `capture_integration.rs::title_bar_close_button_click`                                                                                                                       |
| 3   | Window move (title bar drag)  | `capture_integration.rs::drag_is_captured`                                                                                                                                   |
| 4   | Window resize (edge drag)     | `capture_integration.rs::drag_is_captured`                                                                                                                                   |
| 5   | File dialog navigation        | CI: `capture_integration.rs::deduplication` tests (the underlying suppressions); locally also `file_dialog_test.rs::folder_navigation_produces_no_spurious_events` (ci-skip) |
| 6   | Double-click to open folder   | `capture_integration.rs::double_click_not_misclassified_as_drag`                                                                                                             |
| 7   | Multi-window workflow         | `capture_integration.rs::alt_tab_produces_context_switch` + `context_id_is_consistent_for_same_window`                                                                       |
| 8   | Right-click context menu      | `capture_integration.rs::right_click_produces_context_switch_for_menu`                                                                                                       |
| 9   | Copy-paste between apps       | `capture_integration.rs::right_click_is_captured` + `context_switches`                                                                                                       |
| 10  | Custom-rendered window click  | `capture_integration.rs::coordinate_fallback_for_plain_window`                                                                                                               |
| 11  | Taskbar click                 | `capture_integration.rs::taskbar_click_produces_context_switch`                                                                                                              |
| 12  | Start menu / Win key          | `capture_integration.rs::win_key_opens_start_and_typing_captured`                                                                                                            |
| 13  | Win+D (show desktop)          | OS-level suppression — hook never receives it                                                                                                                                |
| 14  | Win+L (lock screen)           | OS-level suppression — `worker_pool_test::win_l_key_combo_is_captured_if_received` documents behaviour                                                                       |
| 15  | System tray interaction       | `capture_integration.rs::system_tray_click_is_captured`                                                                                                                      |
| 16  | Ctrl+Shift+Esc (Task Manager) | OS-level suppression — `worker_pool_test::modifier_only_keys_produce_no_events`                                                                                              |
| 17  | Win+Arrow (snap/resize)       | `capture_integration.rs::modifier_key_combo_is_captured`                                                                                                                     |
