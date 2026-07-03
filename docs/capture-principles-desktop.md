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

| Mode            | When                                        | Element description                           |
| --------------- | ------------------------------------------- | --------------------------------------------- |
| `accessibility` | ElementFromPoint returns a specific control | Full: tag, id, name, role, text, tree path    |
| `coordinate`    | ElementFromPoint returns Window/Pane only   | Fallback: tag="unknown", selector="coord:x,y" |

A single recording can mix both modes.

---

## Capture Surface

The capture surface is enumerated positively and treated as **closed**: the
two low-level input hooks (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`), the correlated
WinEvent classes in the [Input Correlation](#input-correlation) table, and the
OS/shell proxies in the table below. An interaction that reaches none of them
is not captured — no per-case listing needed. The only negative entries kept
are the [exceptions within the surface](#exceptions-within-the-surface):
interactions that would appear to be covered by this description but are not.

---

## OS/Shell Proxies

These user actions happen outside the hooks' visibility:

| User action               | Captured as      |
| ------------------------- | ---------------- |
| Click a different window  | `context_switch` |
| Alt+Tab                   | `context_switch` |
| Click title bar close (X) | `context_close`  |
| File dialog selection     | `file_dialog`    |

---

## Input Correlation

The Input_Thread distinguishes user-caused state changes from programmatic
ones using **input correlation**: WinEvent callbacks are only dispatched when
correlated with a preceding low-level input event.

| WinEvent                   | Correlation source  | Additional filter                                                          |
| -------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `EVENT_SYSTEM_FOREGROUND`  | Any low-level input | —                                                                          |
| `EVENT_OBJECT_FOCUS`       | Any low-level input | Suppressed after click (redundant)                                         |
| `EVENT_OBJECT_CREATE`      | Any low-level input | —                                                                          |
| `EVENT_OBJECT_DESTROY`     | Any low-level input | Only if previously opened                                                  |
| `EVENT_OBJECT_VALUECHANGE` | Keyboard input only | Same root window as keyboard                                               |
| `EVENT_OBJECT_SELECTION`   | Any low-level input | Same root window as the input; suppressed ≤200ms after a click (redundant) |

**Window-scoping:** Value changes and selections are only correlated with
input from the same root window — value changes against the keyboard input's
root, selections against the root of the most recent input of any kind. This
prevents dialog initialization noise (e.g. Ctrl+S in Notepad does not
correlate with the Save As dialog's filename field pre-fill or its pre-selected
filename ComboBox — the dialog's root received no input yet). "Any low-level
input" means button presses and releases, key presses, and wheel — all of
which refresh the correlation state.

**Printable key buffering:** Printable keystrokes are buffered. If a
value-change event arrives (producing a `type` action), the buffered keys
are discarded (superseded). If no value-change arrives (non-editable control
like Calculator), the keys are emitted individually.

Timing constants and correlation windows live in `src/capture/timing.rs`.

---

## Sensitive-value redaction

The native capture layer masks password fields directly from the UIA
`IsPassword` signal. Other sensitive values — credit-card, SSN, and secret fields
identified by their accessibility name — are masked at the adapter chokepoint
before an action enters the pending list, so they never reach the stored or
exported recording. A redacted element has its value masked and its `text`
nulled, and is flagged `redacted`. The detection rules are shared with the
extension (a single util), so both platforms mask the same fields. (Tokened-URL
redaction is extension-only, since the desktop app has no captured URLs.)

Locator candidates (`locators[]`) pass the redaction chokepoint untouched by
design: every desktop strategy is identity-derived — ids, control types,
labels, and tree paths, the very signals the detection keys on — never the
typed value, which lives in `value`/`text` and is masked as above. Masking a
label would both destroy the locator and mask a non-secret; redaction stays
conservative. Locator match statistics are measured on the worker at the
moment the element is described (asynchronously, after the input that caused
it), never inside the low-level input hook — hook-described click elements
carry candidate values only, with the pair absent.

That describe moment is itself exported as an observed fact: every
accessibility-described element carries `described_after_ms`, the measured gap
between the input and the moment its description was captured — `0` for
hook-described clicks, the real gap for worker describes (which can grow under
queue backlog; the number says so instead of hiding it). Coordinate-mode
elements make no element-identity claims at all: locators, provider facts, and
the describe latency are absent there — coordinate mode records where the user
acted, not which element the accessibility layer resolved.

---

## Exceptions Within the Surface

Interactions that would appear to be inside the
[capture surface](#capture-surface) above but are not captured. An entry
belongs here only when the surface description alone would mislead:

- Win+D (show desktop) — a keypress, but the system intercepts it before the
  hooks
- Win+L (lock screen) — a keypress, but the system intercepts it before the
  hooks
- Ctrl+Shift+Esc (Task Manager) — a keypress, but the system intercepts it
  before the hooks
- Assistive-technology-driven actions that call UI Automation patterns
  directly (voice control, screen readers invoking `SelectionItem.Select`)
  — they produce correlated-looking WinEvents but no low-level input, so the
  input-correlation gates above classify their effects as programmatic. A
  known limitation of the correlation doctrine, affecting every correlated
  event class equally.
