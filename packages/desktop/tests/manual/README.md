# Manual Tests — Desktop Capture

These PowerShell tests verify behaviour that cannot be automated with Enigo
(the cross-platform input simulation crate used in `src-tauri/tests/`).

## What's here vs automated

| Concern | Automated (Enigo) | Manual (PowerShell) |
|---------|-------------------|---------------------|
| Click, right-click, double-click, drag | ✅ | — |
| Key press, typing, modifiers, arrows | ✅ | — |
| Scroll | ✅ | — |
| Window switching via click | ✅ | — |
| Programmatic side-effect filtering | ✅ | — |
| File dialog (open, navigate, select, confirm) | — | ✅ |
| Real third-party app accessibility trees | — | ✅ |
| Coordinate fallback (owner-drawn windows) | — | ✅ |
| System tray interactions | — | ✅ |
| Taskbar clicks | — | ✅ |
| Win+Arrow window snap | — | ✅ |

## Structure

```
windows/
├── accessibility/    — Tests with standard WinForms controls (full UIA tree)
└── coordinate/       — Tests with owner-drawn rendering (coordinate fallback)
```

## When to run

Run these manually after changes to the Windows capture layer
(`src-tauri/src/capture/windows.rs`, `worker_pool.rs`, `element_mapping.rs`).
The automated Enigo tests cover the common cases; these cover edge cases
specific to real-world Windows applications.
