# Automated Capture Tests

Playwright-based tests that verify the extension's event capture behaviour. To run
them, see [Running Tests](../../.github/CONTRIBUTING.md#running-tests)
(`npm run test:e2e`).

## How It Works

1. Launches Chromium with the extension loaded via `--load-extension`
2. Sets up minimal HTML with the specific elements needed for each test
3. Performs a user action (click, type, drag, etc.)
4. Waits for the side-effect delay to complete
5. Reads `pendingActions` from `chrome.storage.local` via the extension's service worker
6. Asserts the captured actions match expectations exactly

## Coverage

These tests cover the ~48 automatable scenarios from the original test suite.
The remaining browser chrome interactions (bookmark clicks, session restore)
are now logic-tested via unit tests in
`packages/extension/tests/unit/navigation-logic.test.js`.
