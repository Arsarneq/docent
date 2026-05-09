# Manual Capture Tests

7 tests that require a human — they involve browser chrome interactions
that Playwright cannot automate via CDP.

## Test File

**`browser-chrome.html`** — Bookmark clicks, context menu selections, address
bar, native select widgets, Tab on body, back/forward buttons, Ctrl+T lifecycle.

## How to Run

1. Reload the extension in `chrome://extensions`
2. Open `browser-chrome.html` in Chrome (refresh if already open)
3. Open the Docent side panel, create a project + recording, start recording
4. Perform each test, commit a step after each
5. Export and inspect the captured actions

## Quick Reference

| Test | Action | Expected capture |
|------|--------|-----------------|
| 1 | Bookmark click + Back | navigate(auto_bookmark) + navigate(back_forward) |
| 2 | Right-click → Open in new tab | right_click + navigate(link) on new tab |
| 3 | Ctrl+L then Escape | Nothing |
| 4 | Select: click, ↓↓, Enter | click + select |
| 5 | Click background, Tab | key(Tab) on body |
| 6 | Back button | navigate(back_forward) |
| 7 | Ctrl+T, close tab, return | context_open + context_close + context_switch |
