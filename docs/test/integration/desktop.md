# Desktop Integration Tests

Playwright tests that drive the desktop application's **real frontend** with
its **Tauri backend mocked** — the integration layer of
[the test pyramid](../strategy/test-pyramid.md) for the desktop surface. They
verify the panel UI, persistence flows, dispatch and sync behaviour, and
accessibility, without a Rust process; the native capture backend has its own
suites ([Desktop Rust tests](../desktop-rust.md)).

The suite lives in `packages/desktop/tests/integration/`.

## How the Tauri backend is mocked

`tauri-mock-fixture.js` owns the mock and the server for the whole suite: a
spec calls `installTauriMockServer()` once, and gets a local HTTP server that
serves the built frontend bundle (`packages/desktop/dist/`) into headless
Chromium, rewritten on the way out so the mock can stand in for the backend:

- a `window.__TAURI__` **mock script** is injected at the end of `<head>` —
  ahead of `panel.js`, and past the page's Content-Security-Policy element, so
  the policy governs it. The page keeps that policy exactly as shipped, and the
  mock is served as a same-origin external file because `script-src 'self'`
  admits one and would refuse an inline script there — so the suite drives the
  panel, and the mock, under the same policy the application ships;
- the mock implements the Tauri v2 surface the frontend calls:
  `core.invoke` handles the backend commands (`load_state`/`save_state`
  persist to an in-memory string; `start_capture`, `set_target_pid`,
  `set_self_capture_exclusion`, and `set_auto_sync_keepalive` accept and
  return; `stop_capture` and `commit_barrier` answer the zero barrier report
  the backend returns when no capture was active, so no barrier engages;
  `list_windows` returns the windows a spec supplies, and an empty list where
  it supplies none; `import_file` returns a spec-controlled payload;
  `export_file` records what it was handed, for a spec to read back;
  `sync_http_request` — the native HTTP transport — is adapted onto the page's
  `window.fetch`, so a spec's fetch stubs service the real transport path),
  and `event.listen` records each handler so a spec can fire `capture:action`
  events directly, simulating captured input arriving from the backend.

Because the mock is suite-wide, so are its affordances: every spec can read the
recorded invoke traffic (`_getInvokeCalls` / `_clearInvokeCalls`) and drive the
spec-controlled hooks (`_setWindows`, `_setImportResult`, `_getLastExport`) on
`window.__TAURI__`.

**Unknown invokes fail loudly.** An invoke of a command the mock does not
service is recorded and rejects, and after every test the fixture asserts the
page recorded none — so a command the frontend grows, or one the mock stops
servicing, surfaces as a red test naming it rather than as a panel-side catch
swallowing the drift. The same hook asserts that a document this server injected
the mock into really carries it, so a mock that never installed cannot pass as
an empty record. Both assertions read the document the page holds when the test
ends, so a test that navigates away leaves the earlier document's record behind,
and the guard speaks about the commands the frontend actually invokes on a path
some spec exercises. Holding the crate's registered command surface against its
own table is
[DSH-1](../../architecture/application/desktop/windows/application-shell.md#the-command-surface)'s
job, and the clause registry records the check intended for it.

**Per-spec behaviour rides an override seam.** `installTauriMockServer({ overrides })`
replaces a single command's behaviour with spec-supplied source — how
`panel-commit-completeness-barrier.spec.js` has `stop_capture` return a real
barrier report whose sentinel the spec then delivers itself. Naming a command
the canonical mock does not service is an error, so an override can only
restate a serviced command, never widen the surface behind the fail-loud
contract. The fixture also resolves the source in the test process and refuses a
value that does not come out a function; because the source resolves there as
well as in the page, an override reaches page globals from inside the function
it resolves to, never while constructing itself. The case that refusal alone catches is
source that resolves but is not a function: the mock would install cleanly and
the failure would land at invoke time on a command the mock does service, where
the unknown-invoke guard has nothing to say. Source that resolves there but
throws in the page gets past the refusal and aborts the served mock script,
which the mock-presence assertion above reports.

`sync-samples.spec.js` goes one step further: it runs a real reference sync
server as a child process and reverse-proxies the protocol paths through the
same-origin dist server (a plain page enforces CORS that the Tauri webview
does not, so the proxy keeps the test faithful to the app's real sync path).
It slots that proxy in through the fixture's `routeRequest` option, which
answers a request ahead of the served frontend files.

## What the suite covers

The suite is exactly the test files below — the fixtures and configs beside them
are helpers, not specs; a new spec joins this table in the same change that adds
it, and a CI lint holds the two in agreement.

| Spec                                        | Covers                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel-desktop.spec.js`                     | Core panel UI: project/recording creation, view transitions, step commit via simulated `capture:action` events.                                                                    |
| `panel-commit-completeness-barrier.spec.js` | Step-commit completeness: a normal recording commit engages the fused stop-path flush barrier and waits for its `barrier_complete` sentinel before finalizing the step.            |
| `panel-dispatch-sync.spec.js`               | Dispatch confirmation flow, settings persistence, sync button behaviour, re-record flow, project deletion.                                                                         |
| `panel-advanced-flows.spec.js`              | Dispatch send with stubbed fetch, sync flow, inline rename, the multi-recording dispatch selector, re-record cancel.                                                               |
| `panel-coverage-boost.spec.js`              | Metadata CRUD, import (including duplicate-project copies), export, sync partial-success and auth-error paths, "Send all", target-app selector, self-capture toggle, drag reorder. |
| `import-export-rerecord-desktop.spec.js`    | Import/export round-trips (format stamp derived from the composed schema, never hardcoded), re-record, drag reorder persistence.                                                   |
| `accessibility-desktop.spec.js`             | axe-core WCAG 2.1 AA scan of each major panel view (machine-detectable issues only).                                                                                               |
| `sync-samples.spec.js`                      | The real desktop client pulls the bundled `desktop-windows` seed sample from a running reference sync server and rejects the `extension`-stamped one.                              |

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

`playwright.config.js` keeps the suite deterministic: every spec or test file
Playwright's default discovery finds under the directory, at any depth, 15 s
per-test timeout, 1 retry, a single worker, headless.
Its `globalTeardown` converts the raw V8 coverage collected per page by
`coverage-fixture.js` into one lcov report, uploaded under the
`integration,javascript` coverage flag. The files it reports on are a
closed, hard-coded list — see
[coverage reporting](../strategy/coverage.md#closed-world-tracked-file-lists-e2e-and-desktop-integration)
for the mechanism and the maintenance rule. A new spec imports `test`/`expect`
from `./coverage-fixture.js` (not `@playwright/test` directly) so its pages
contribute coverage, and calls `installTauriMockServer()` from
`./tauri-mock-fixture.js` for the mocked backend — the mock fixture registers
its hooks on that same `test`, so the two compose without a spec choosing
between coverage and the mock.
