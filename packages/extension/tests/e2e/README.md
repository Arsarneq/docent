# Automated Capture Tests

Playwright-based tests that verify the extension's event capture behaviour.

## Prerequisites

- Node.js 18+
- Playwright (`npm install` in this directory)

## How It Works

1. Launches Chromium with the extension loaded via `--load-extension`
2. Sets up minimal HTML with the specific elements needed for each test
3. Performs a user action (click, type, drag, etc.)
4. Waits for the side-effect delay to complete
5. Reads `pendingActions` from `chrome.storage.local` via the extension's service worker
6. Asserts the captured actions match expectations exactly

## Running

```bash
npx playwright test
```

## Coverage

These tests cover the ~48 automatable scenarios from the manual test suite.
The remaining ~6 tests (bookmark clicks, context menu selections, etc.) require
manual verification as they involve browser chrome that Playwright cannot access.
