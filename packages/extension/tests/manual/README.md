# Manual Capture Tests

2 tests that require a human — they involve browser chrome interactions
that cannot be automated via Playwright or the chrome.tabs/windows API.

These will be retired when #32 (extract navigation capture logic) is completed.

## Remaining Manual Tests

| Test | Action         | Expected                | Why manual                                      |
| ---- | -------------- | ----------------------- | ----------------------------------------------- |
| 1    | Bookmark click | navigate(auto_bookmark) | Requires real bookmark bar interaction          |
| 8    | Ctrl+Shift+T   | context_open            | Requires real session restore (chrome.sessions) |

## Retired Tests (now automated)

| Test | Action                        | Automated in                                                |
| ---- | ----------------------------- | ----------------------------------------------------------- |
| 2    | Right-click → Open in new tab | `specs/browser-chrome.spec.js`                              |
| 3    | Ctrl+L then Escape            | `specs/browser-chrome.spec.js`                              |
| 4    | Select: click, ↓↓, Enter      | `specs/browser-chrome.spec.js`                              |
| 5    | Ctrl+T                        | `specs/browser-chrome.spec.js`                              |
| 6    | Ctrl+N                        | `specs/browser-chrome.spec.js`                              |
| 7    | Ctrl+W                        | `specs/browser-chrome.spec.js`                              |
| 9    | Click a tab                   | `specs/browser-chrome.spec.js` + `specs/navigation.spec.js` |
| 10   | Ctrl+X (cut)                  | `specs/browser-chrome.spec.js`                              |

## How to Run (remaining 2 tests)

1. Reload the extension in `chrome://extensions`
2. Open any page in Chrome
3. Open the Docent side panel, create a project + recording, start recording
4. **Test 1**: Click a bookmark in the bookmark bar → commit step → verify `navigate(auto_bookmark)`
5. **Test 8**: Close a tab, then Ctrl+Shift+T to restore it → commit step → verify `context_open`
6. Export and inspect the captured actions
