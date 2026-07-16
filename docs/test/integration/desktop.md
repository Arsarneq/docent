# Desktop Integration Tests

Playwright tests that drive the desktop application's **real frontend** with
its **Tauri backend mocked** — the integration layer of
[the test pyramid](../strategy/test-pyramid.md) for the desktop surface. They
verify the panel UI, persistence flows, dispatch and sync behaviour, and
accessibility, without a Rust process; the native capture backend has its own
suites ([Desktop Rust tests](../desktop-rust.md)).

The suite lives in `packages/desktop/tests/integration/`.

## How the Tauri backend is mocked

Each spec starts a local HTTP server that serves the built frontend bundle
(`packages/desktop/dist/`) into headless Chromium, with two injections on the
way out:

- the page's strict Content-Security-Policy `<meta>` tag is stripped, and a
  `window.__TAURI__` **mock script** is injected ahead of `panel.js` — served
  as a same-origin external file so it runs where an inline script could not;
- the mock implements the Tauri v2 surface the frontend calls:
  `core.invoke` handles the backend commands (`load_state`/`save_state`
  persist to an in-memory string; `start_capture`/`stop_capture`,
  `commit_barrier`, `set_self_capture_exclusion`, and `export_file` are no-ops
  that can be asserted on; `list_windows` returns an empty list; `import_file`
  returns a spec-controlled payload; `sync_http_request` — the native HTTP transport —
  is adapted onto the page's `window.fetch`, so a spec's fetch stubs service
  the real transport path), and `event.listen` records each handler so a spec
  can fire `capture:action` events directly, simulating captured input
  arriving from the backend.

`sync-samples.spec.js` goes one step further: it runs a real reference sync
server as a child process and reverse-proxies the protocol paths through the
same-origin dist server (a plain page enforces CORS that the Tauri webview
does not, so the proxy keeps the test faithful to the app's real sync path).

## What the suite covers

| Spec                                     | Covers                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel-desktop.spec.js`                  | Core panel UI: project/recording creation, view transitions, step commit via simulated `capture:action` events.                                                                    |
| `panel-dispatch-sync.spec.js`            | Dispatch confirmation flow, settings persistence, sync button behaviour, re-record flow, project deletion.                                                                         |
| `panel-advanced-flows.spec.js`           | Dispatch send with stubbed fetch, sync flow, inline rename, the multi-recording dispatch selector, re-record cancel.                                                               |
| `panel-coverage-boost.spec.js`           | Metadata CRUD, import (including duplicate-project copies), export, sync partial-success and auth-error paths, "Send all", target-app selector, self-capture toggle, drag reorder. |
| `import-export-rerecord-desktop.spec.js` | Import/export round-trips (format stamp derived from the composed schema, never hardcoded), re-record, drag reorder persistence.                                                   |
| `accessibility-desktop.spec.js`          | axe-core WCAG 2.1 AA scan of each major panel view (machine-detectable issues only).                                                                                               |
| `sync-samples.spec.js`                   | The real desktop client pulls the bundled `desktop-windows` seed sample from a running reference sync server and rejects the `extension`-stamped one.                              |

## Running the suite

```bash
# One-time / after shared or frontend changes: assemble the dist the server serves
npm run sync-shared && npm run build:desktop-dist

# Install suite dependencies (own package.json)
cd packages/desktop/tests/integration && npm ci && npx playwright install chromium

# From the repository root
npm run test:integration
```

`npm run test:integration` runs `npm test` in the suite directory (plain
`npx playwright test`; `npm run test:headed` opens a visible browser). In CI
the suite runs in the `desktop-integration-tests` job on Linux.

## Configuration and coverage

`playwright.config.js` keeps the suite deterministic: every `*.spec.js` in the
directory, 15 s per-test timeout, 1 retry, a single worker, headless.
Its `globalTeardown` converts the raw V8 coverage collected per page by
`coverage-fixture.js` into one lcov report, uploaded under the
`integration,javascript` coverage flag. The files it reports on are a
closed, hard-coded list — see
[coverage reporting](../strategy/coverage.md#closed-world-tracked-file-lists-e2e-and-desktop-integration)
for the mechanism and the maintenance rule. A new spec imports `test`/`expect`
from `./coverage-fixture.js` (not `@playwright/test` directly) so its pages
contribute coverage.
