# Manual Tests — Desktop Capture

Tests that require a human. Everything else is automated in
`src-tauri/tests/capture_integration.rs`.

These scenarios apply cross-platform (Windows, macOS, Linux) — the specific
apps differ but the test concepts are the same.

## When to run

After changes to the platform capture layer (`src-tauri/src/capture/`).

---

## Accessibility Mode Tests

Verify capture against real apps with full accessibility trees.

### 1. Notepad — Type and Save

1. Target Notepad, click text area, type "Hello World"
2. Press Ctrl+S, type filename, click Save

**Expected:** click + type + key(Ctrl+S) + file_dialog(save)

### 2. Title Bar Buttons

1. Click minimize (—), restore from taskbar, maximize (□), restore (⧉), close (×)

**Expected:** Each click captured. Window state changes are effects.

### 3. Window Move (Title Bar Drag)

1. Drag the title bar to move a window

**Expected:** drag_start + drop

### 4. Window Resize (Edge Drag)

1. Drag a window edge to resize

**Expected:** drag_start + drop

### 5. File Dialog Navigation

1. Open File > Open, navigate folders, select file, click Open

**Expected:** file_dialog with selected path. Intermediate clicks captured.

### 6. Multi-Window Workflow

1. Open Notepad + Calculator, click between them, type in each, Alt+Tab

**Expected:** Correct context_id per window. context_switch when switching.

### 7. Right-Click Context Menu

1. Right-click, then click a menu item

**Expected:** right_click + click (menu item)

---

## Coordinate Fallback Tests

Verify capture when accessibility can't resolve elements (owner-drawn windows).

### 8. Click in Owner-Drawn Window

1. Use any app with custom-rendered UI (or a GDI-painted test window)
2. Click various areas

**Expected:** `capture_mode: "coordinate"`, `selector: "coord:x,y"`

### 9. Type in Owner-Drawn Window

1. With an owner-drawn window focused, type text

**Expected:** Key events captured. No type events (no accessible edit control).

---

## Not Capturable (Verify Nothing Leaks)

### 10. Taskbar Click

1. Click a taskbar button to switch apps

**Expected:** context_switch only (proxy). No click event (taskbar is OS chrome).
