# Manual Capture Tests

9 tests that require a human — they involve browser chrome interactions
that Playwright cannot automate via CDP.

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
| 2 | Right-click → Open in new tab | right_click + navigate(link) |
| 3 | Ctrl+L then Escape | Nothing |
| 4 | Select: click, ↓↓, Enter | click + select |
| 5 | Click background, Tab | key(Tab) |
| 6 | Back button | navigate(back_forward) |
| 7 | Ctrl+T | context_open + context_switch (return) |
| 8 | Ctrl+W | context_close + context_switch |
| 9 | Click a tab | context_switch |
