# Manual Tests — Desktop Capture

## Side-Effect Capture Test

**File:** `side-effect-capture.test.ps1`

Tests whether the desktop capture layer records only direct user actions or
also captures programmatic side-effects (value changes, focus moves, window
lifecycle events triggered by application code rather than user input).

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

5. The test window "Docent Side-Effect Capture Test" will appear.
6. Click each test button **once**, waiting for the side-effect to complete
   (watch the UI change) before moving to the next test.
7. After all 8 tests, go back to Docent Desktop and commit the step.
8. Inspect the captured actions in the step detail view.

### Expected Results (Ideal)

Each test button click should produce **exactly 1 click action**. Any
additional actions are unwanted side-effects being captured:

| Test | Button Click | Unwanted Side-Effects |
|------|-------------|----------------------|
| 1. Programmatic Focus | 1 click | focus on textbox |
| 2. Programmatic Value Change | 1 click | type/value-change |
| 3. Programmatic Selection | 1 click | select |
| 4. Window Open/Close | 1 click | context_open, context_close |
| 5. Foreground Steal | 1 click | context_switch (×2) |
| 6. Timer Value Updates | 1 click | multiple type/value-change |
| 7. Rapid Focus Moves | 1 click | 3× focus |
| 8. Programmatic Scroll | 1 click | scroll |

### What This Tests

The desktop capture layer uses Windows `SetWinEventHook` and low-level input
hooks. These OS-level notifications fire for **all** state changes regardless
of whether they were user-initiated or programmatic. This test verifies
whether the capture layer correctly distinguishes the two.

Key Windows events under test:
- `EVENT_OBJECT_FOCUS` — fires for both user and programmatic focus
- `EVENT_OBJECT_VALUECHANGE` — fires for any value mutation
- `EVENT_OBJECT_SELECTION` — fires for any selection change
- `EVENT_OBJECT_CREATE` / `EVENT_OBJECT_DESTROY` — fires for all windows
- `EVENT_SYSTEM_FOREGROUND` — fires for any foreground change
