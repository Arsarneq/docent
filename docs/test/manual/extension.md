# Manual Capture Tests

All extension manual tests have been retired. The logic that previously
required manual verification is now covered by unit tests.

_Test paths below are relative to `packages/extension/tests/`._

## Retired Tests (now automated)

| Test | Action                        | Automated in                                                              |
| ---- | ----------------------------- | ------------------------------------------------------------------------- |
| 1    | Bookmark click                | `unit/navigation-logic.test.js` (auto_bookmark transition type)           |
| 2    | Right-click → Open in new tab | `e2e/specs/browser-chrome.spec.js`                                        |
| 3    | Ctrl+L then Escape            | `e2e/specs/browser-chrome.spec.js`                                        |
| 4    | Select: click, ↓↓, Enter      | `e2e/specs/browser-chrome.spec.js`                                        |
| 5    | Ctrl+T                        | `e2e/specs/browser-chrome.spec.js`                                        |
| 6    | Ctrl+N                        | `e2e/specs/browser-chrome.spec.js`                                        |
| 7    | Ctrl+W                        | `e2e/specs/browser-chrome.spec.js`                                        |
| 8    | Ctrl+Shift+T                  | `unit/navigation-logic.test.js` (shouldCaptureTabCreated session restore) |
| 9    | Click a tab                   | `e2e/specs/browser-chrome.spec.js` + `e2e/specs/navigation.spec.js`       |
| 10   | Ctrl+X (cut)                  | `e2e/specs/browser-chrome.spec.js`                                        |

### Why tests 1 and 8 are considered retired

These tests verified that browser chrome interactions (bookmark click, session
restore) produce the correct captured action. The underlying decision logic is
now unit-tested via `shouldCaptureNavigation` (auto_bookmark) and
`shouldCaptureTabCreated` (session restore). The remaining untested layer is
Chrome's event delivery — that the browser actually fires the expected
`webNavigation.onCommitted` or `tabs.onCreated` event — which is Chrome's API
contract, not our code.
