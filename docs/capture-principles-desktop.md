# Capture Principles — Desktop Application

Platform-specific details for the desktop app (Windows). See [core rules](capture-principles.md).

---

## Architecture

1. **Input Thread** — low-level hooks (WH_MOUSE_LL, WH_KEYBOARD_LL), zero accessibility queries
2. **Worker Pool** (3 threads) — accessibility queries, produces ActionEvents
3. **Bridge Thread** — dispatches raw events from input thread to workers

Events may arrive out-of-order from workers. Frontend reorder buffer sorts
by `sequence_id` before committing.

---

## Capture Modes

| Mode | When | Element description |
|------|------|---------------------|
| `accessibility` | ElementFromPoint returns a specific control | Full: tag, id, name, role, text, tree path |
| `coordinate` | ElementFromPoint returns Window/Pane only | Fallback: tag="unknown", selector="coord:x,y" |

A single recording can mix both modes.

---

## OS/Shell Proxies

These user actions happen outside the hooks' visibility:

| User action | Captured as |
|---|---|
| Click a different window | `context_switch` |
| Alt+Tab | `context_switch` |
| Click title bar close (X) | `context_close` |
| File dialog selection | `file_dialog` |

---

## Input Correlation

The Input_Thread distinguishes user-caused state changes from programmatic
ones using **input correlation**: WinEvent callbacks (foreground, focus,
value change, window lifecycle) are only dispatched when correlated with a
preceding low-level input event within a configured time window.

| WinEvent | Correlation source | Window |
|---|---|---|
| `EVENT_SYSTEM_FOREGROUND` | Any low-level input | 100ms |
| `EVENT_OBJECT_FOCUS` | Any low-level input | 100ms |
| `EVENT_OBJECT_CREATE/DESTROY` | Any low-level input | 200ms |
| `EVENT_OBJECT_VALUECHANGE` | Keyboard input only | 500ms |

Timing constants live in `src/capture/timing.rs` (single source of truth).

---

## Not Capturable (OS-Level)

- Taskbar button clicks
- Start menu / Win key
- Win+D, Win+L, Win+Arrow
- System tray interactions
- Ctrl+Shift+Esc (Task Manager)
