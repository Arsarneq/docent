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
value change, window lifecycle, selection) are only dispatched when correlated
with a preceding low-level input event.

| WinEvent | Correlation source | Window | Additional filter |
|---|---|---|---|
| `EVENT_SYSTEM_FOREGROUND` | Any low-level input | 100ms | — |
| `EVENT_OBJECT_FOCUS` | Any low-level input | 100ms | Suppressed after click (redundant) |
| `EVENT_OBJECT_CREATE` | Any low-level input | 200ms | — |
| `EVENT_OBJECT_DESTROY` | Any low-level input | 200ms | Only if previously opened |
| `EVENT_OBJECT_VALUECHANGE` | Keyboard input only | 1000ms | Same root window as keyboard |
| `EVENT_OBJECT_SELECTION` | — | — | Suppressed after click; same root window |

**Window-scoping:** Value changes and selections are only correlated with
input from the same root window. This prevents dialog initialization noise
(e.g. Ctrl+S in Notepad does not correlate with Save As dialog's filename
field pre-fill).

**Printable key buffering:** Printable keystrokes are buffered for
`TYPE_DEBOUNCE_MS`. If a value-change event arrives (producing a `type`
action), the buffered keys are discarded (superseded). If no value-change
arrives (non-editable control like Calculator), the keys are emitted
individually.

Timing constants live in `src/capture/timing.rs` (single source of truth).

---

## Not Capturable (OS-Level)

- Taskbar button clicks (captured as click on taskbar button — proxy)
- Start menu / Win key (search box keystrokes captured)
- Win+D, Win+L, Win+Arrow
- System tray interactions
- Ctrl+Shift+Esc (Task Manager)
