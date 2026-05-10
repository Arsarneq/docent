# Manual Tests — Desktop Capture

Tests that require a human and real applications. Everything else is automated
in `src-tauri/tests/capture_integration.rs` (53 tests).

These scenarios apply cross-platform (Windows, macOS, Linux) — the specific
apps differ but the test concepts are the same.

## When to run

After changes to the platform capture layer (`src-tauri/src/capture/`).

---

## Accessibility Mode Tests

Use Notepad (or any app with a full accessibility tree).

### 1. Type and Save

1. Click text area, type "Hello World"
2. Press Ctrl+S, navigate Save As dialog, click Save

**Expected:**
- click + type("Hello World") + key(Ctrl+S)
- Save As dialog: NO type/select events from dialog initialization (filename field pre-fill is filtered)
- Click on file + click Save button
- Confirm overwrite: click "Yes"

### 2. Title Bar Buttons

1. Click minimize, restore from taskbar, maximize, restore, close

**Expected:** Each produces a click on the button. No extra context_switch/focus noise.

### 3. Window Move (Title Bar Drag)

1. Drag the title bar to move a window

**Expected:** drag_start + drop. NOT a single click.

### 4. Window Resize (Edge Drag)

1. Drag a window edge to resize

**Expected:** drag_start + drop. NOT a click on the wrong window.

### 5. File Dialog Navigation

1. Open File > Open, click through folders in the tree, select a file, click Open

**Expected:**
- Clicks on tree items (no duplicate select events)
- No context_close events from folder view refreshing
- No redundant focus events after clicks
- Click on file + click Open button

### 6. Double-Click to Open Folder

1. In a file dialog, double-click a folder to open it

**Expected:** Two click events. NOT drag_start + drop.

### 7. Multi-Window Workflow

1. Open Notepad + Calculator
2. Click between them, type in each, Alt+Tab

**Expected:**
- context_switch when switching apps
- Correct context_id per window
- Calculator keyboard input: individual key events with display value in element text
- Notepad keyboard input: coalesced type event with final value

### 8. Right-Click Context Menu

1. Right-click in an app, then click a menu item

**Expected:** right_click + context_switch (menu window) + click (menu item)

### 9. Copy-Paste Between Apps

1. Right-click Calculator display → Copy
2. Right-click Notepad text area → Paste

**Expected:** right_click + click(Copy) + right_click + click(Paste)

---

## Coordinate Fallback Tests

Use any app with custom-rendered UI (Discord, games, Electron apps without accessibility).

### 10. Click in Custom-Rendered Window

1. Click various areas in an app that doesn't expose accessibility

**Expected:** `capture_mode: "coordinate"`, element has `tag: "Window"` or `tag: "Pane"`

---

## Not Capturable (Verify Nothing Leaks)

### 11. Taskbar Click

1. Click a taskbar button to switch apps

**Expected:** context_switch + click on taskbar button. No extra noise.

### 12. Start Menu / Win Key

1. Press Win key, type to search, press Enter

**Expected:** Key events for the search text. context_switch to search window.
