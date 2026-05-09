# Manual Capture Tests

These tests cover browser chrome interactions that cannot be automated with
Playwright. All other capture tests (48 of 54 total) are in `../automated/`.

## Test File

- **`browser-chrome.html`** — 7 tests involving bookmark clicks, context menu
  selections, address bar interactions, native select widgets, browser
  navigation buttons, and keyboard shortcuts that can't be dispatched via CDP.

## How to Run

1. Load the extension in Chrome (`chrome://extensions` → Load unpacked → select `packages/extension/`)
2. Open the Docent side panel and create a project + recording
3. Start recording
4. Open `browser-chrome.html` in Chrome
5. Perform each test as described, committing a step after each
6. Export the recording and inspect the captured actions

## What to Look For

**Capture exactly what the user did, nothing else.**

- Browser chrome interactions (bookmark click, back button) should produce
  the appropriate navigate action but no click events
- Context menu selections should not produce tab lifecycle side-effects
- Keyboard shortcuts intercepted by the browser should not leak to the page
