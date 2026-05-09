# Manual Capture Tests

9 tests that require a human — they involve browser chrome interactions
that Playwright cannot automate via CDP, or clipboard operations that
don't trigger real value changes in automated mode.

## Test File

**`browser-chrome.html`** — Each test verifies a single browser chrome action.

## How to Run

1. Reload the extension in `chrome://extensions`
2. Open `browser-chrome.html` in Chrome (refresh if already open)
3. Open the Docent side panel, create a project + recording, start recording
4. Perform each test, commit a step after each
5. Export and inspect the captured actions

## Quick Reference

| Test | Action | Expected |
|------|--------|----------|
| 1 | Bookmark click | navigate(auto_bookmark) |
| 2 | Right-click → Open in new tab | right_click + context_open + navigate(link) |
| 3 | Ctrl+L then Escape | Nothing |
| 4 | Select: click, ↓↓, Enter | click + select |
| 5 | Ctrl+T | context_open |
| 6 | Ctrl+N | context_open |
| 7 | Ctrl+W | context_close |
| 8 | Ctrl+Shift+T | context_open |
| 9 | Click a tab | context_switch |
| 10 | Ctrl+X (cut) | click + type (empty value) |
