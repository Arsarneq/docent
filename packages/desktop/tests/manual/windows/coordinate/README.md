# Manual Tests — Desktop Capture (Coordinate Fallback)

## Side-Effect Capture Test

**File:** `side-effect-capture.test.ps1`

Tests whether the desktop capture layer records side-effects when operating
in **coordinate fallback mode** — the mode Docent uses when the accessibility
API cannot identify a specific UI element (resolves only to a top-level
Window or Pane).

### How This Differs from the Accessibility Test

| Aspect | Accessibility Test | This Test (Coordinate) |
|--------|-------------------|------------------------|
| UI controls | Standard WinForms (TextBox, ComboBox, etc.) | Owner-drawn (GDI paint, no child controls) |
| UIA tree | Full element tree exposed | Only top-level Window visible |
| `capture_mode` | `"accessibility"` | `"coordinate"` |
| `selector` | Tree path (e.g. `Window:App > Button:OK`) | `"coord:x,y"` |
| Focus/value events | Worker resolves via `focused_element()` | Worker gets `None` → events dropped |
| Window lifecycle | Captured | Captured (same hooks) |

Because the accessibility API can't resolve elements in this window, the
worker's `handle_focus`, `handle_value_change`, and `handle_selection`
functions return early (they call `backend.focused_element()` which returns
`None`). This means **focus, type, and select side-effects should NOT appear**
in coordinate mode — they're naturally filtered.

However, **window lifecycle events** (`context_open`, `context_close`,
`context_switch`) and **low-level input hook events** (mouse clicks, scroll)
still fire regardless of accessibility support. These are the events this
test targets.

### Prerequisites

- Windows 10/11
- PowerShell 5.1+ (pre-installed on Windows)
- Docent Desktop built and running

### How to Run

1. Build and launch Docent Desktop.
2. Create or open a project and recording.
3. Start recording.
4. Open a terminal and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File side-effect-capture.test.ps1
   ```

5. The test window "Docent Coordinate Fallback Test" will appear.
   Note: the "buttons" are painted regions, not real controls.
6. Click each painted button **once**, waiting for the status to update
   before moving to the next test.
7. After all 4 tests, go back to Docent Desktop and commit the step.
8. Inspect the captured actions in the step detail view.

### Expected Results (Ideal)

Each click should produce **exactly 1 click action** with
`capture_mode: "coordinate"` and `selector: "coord:x,y"`. Any additional
actions are unwanted side-effects:

| Test | User Action | Unwanted Side-Effects |
|------|------------|----------------------|
| 1. Window Open/Close | 1 click (coordinate) | context_open, context_close |
| 2. Foreground Steal | 1 click (coordinate) | context_switch (×2) |
| 3. Programmatic Scroll | 1 click (coordinate) | scroll, context_open/close |
| 4. Synthetic Mouse Click | 1 click (coordinate) | additional click from SendInput |

### What This Tests

**Test 1 & 2** — Window lifecycle events (`EVENT_OBJECT_CREATE`,
`EVENT_OBJECT_DESTROY`, `EVENT_SYSTEM_FOREGROUND`) fire at the OS level
regardless of whether the source application exposes an accessibility tree.
These tests verify that programmatic window creation and foreground changes
are not captured as user actions.

**Test 3** — Programmatic scrolling via `AutoScrollPosition` does not go
through the low-level mouse hook (no `WM_MOUSEWHEEL`), but may trigger
`EVENT_OBJECT_VALUECHANGE` on scrollbar elements. This test verifies that
such programmatic scrolls are not captured.

**Test 4** — `SendInput` injects synthetic mouse events that are
indistinguishable from real hardware input at the low-level hook level.
The `KBDLLHOOKSTRUCT.flags` field has a `LLMHF_INJECTED` flag that could
theoretically be used to filter these, but the current implementation does
not check it. This test verifies whether synthetic clicks are captured.

### Key Architectural Insight

The coordinate fallback mode is actually *better* at filtering side-effects
for focus/value/selection events because the worker naturally drops them
when `focused_element()` returns `None`. The remaining side-effect vectors
are:
- Window lifecycle (OS-level, no element resolution needed)
- Low-level input hooks (mouse/keyboard — captures everything including
  synthetic input from `SendInput`)
