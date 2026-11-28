# Desktop Integration Tests

Playwright tests that drive the desktop application's **real frontend** with its **Tauri backend mocked**. They are the integration layer of [the test pyramid](../strategy/test-pyramid.md) for the desktop surface. They verify the panel UI, persistence flows, dispatch and sync behavior, and accessibility, without a Rust process. The native capture backend has its own suites ([Desktop Rust tests](../desktop-rust.md)).

The suite lives in `packages/desktop/tests/integration/`.

## How the Tauri backend is mocked

`tauri-mock-fixture.js` owns the mock and the server for the whole suite. A spec calls `installTauriMockServer()` once and gets a local HTTP server. It serves the built frontend bundle (`packages/desktop/dist/`) into headless Chromium, rewritten on the way out so the mock can stand in for the backend:

- A `window.__TAURI__` **mock script** is injected at the end of `<head>`, ahead of `panel.js` and past the page's Content-Security-Policy element, so the policy governs it. The page keeps that policy exactly as shipped. The mock is a same-origin external file, because `script-src 'self'` admits one and would refuse an inline script there. So the suite drives the panel, and the mock, under the same policy the application ships.
- The mock implements the Tauri v2 surface the frontend calls. `core.invoke` handles the backend commands:
  - `load_state`/`save_state` persist to a blob in the page's own tab storage, so it outlives the document. Opening the panel again in the same tab reads back what was last saved (the restart a persistence assertion needs). A fresh test page starts from the empty state.
  - `start_capture`, `set_target_pid`, `set_self_capture_exclusion` and `set_auto_sync_keepalive` accept and return.
  - `stop_capture` and `commit_barrier` answer the zero barrier report the backend returns when no capture was active, so no barrier engages.
  - `list_windows` returns the windows a spec supplies, and an empty list where it supplies none.
  - `import_file` returns a spec-controlled payload.
  - `export_file` records what it was handed, for a spec to read back.
  - `sync_http_request` (the native HTTP transport) is adapted onto the page's `window.fetch`, so a spec's fetch stubs service the real transport path.

  `event.listen` records each handler, so a spec can fire `capture:action` events directly to simulate captured input arriving from the backend.

- The mock also replaces `window.confirm` the way the dialog plugin does in the application: the call answers with a Promise of the choice, never the boolean itself. The dialog is still the browser's own, so a spec answers it through the page's `dialog` event.

Because the mock is suite-wide, so are its affordances. A spec reads the recorded invoke traffic through the fixture's readers (`invokedCommands`, `invokesOf` and `clearInvokes`). It reads the persisted blob itself through `_getSavedState` (what `load_state` would answer), without adding an invoke to the record. It drives the spec-controlled hooks (`_setWindows`, `_setImportResult`, `_getLastExport`) on `window.__TAURI__`. The one spec-side read of the record itself is the settle probe in the dispatch and sync spec, which needs the invoke count and the saved blob from one page turn. The integration-suite locks name it as the allowance.

**The helpers specs share.** Each carries the property a spec must not re-implement, so a wrong-reason pass fails at the helper:

- `openPanel` is the panel-open preamble. It navigates, then waits for the projects view as the panel rendered it, which is observable only once the startup invokes are recorded. So a spec's first action meets the started panel, with only what startup set running (such as an Auto-Sync cycle) still in flight.
- `createProject` walks the new-project form to the project view from a panel standing on its rendered projects view, and holds the view to the name it typed.
- `seedRecordedStep` walks an open panel to a committed step (project, recording, delivered actions, narration and commit, each leg skipped by `null`) and holds the step list to the step it committed. `SUBMIT_CLICK` is the stock action such a run-up delivers.
- `fireCaptureActions` delivers captured actions through the registered `capture:action` listener. Where the page has none, it throws and names the absent listener, so a delivery that would have reached nothing fails there and does not leave an assertion to hold for the wrong reason.
- The readers over the mock's invoke record, where the read itself is what a spec must not re-implement: `invokedCommands` returns the command names in order, `invokesOf` one command's records with their arguments, and `clearInvokes` drops the record while the unknown-invoke list stands.

The fixture keeps a page-error watch armed on the test's page for the test's whole run. An uncaught exception or unhandled rejection in the panel fails the test that provoked it, after the unknown-invoke guard has had its say.

**Unknown invokes fail loudly.** An invoke of a command the mock does not service is recorded and rejects. After every test the fixture asserts the page recorded none. So a command the frontend grows, or one the mock stops servicing, surfaces as a red test naming it, not as a panel-side catch swallowing the drift. The same hook asserts that a document this server injected the mock into really carries it, so a mock that never installed cannot pass as an empty record. Both assertions read the document the page holds when the test ends. So a test that navigates away leaves the earlier document's record behind, and the guard speaks about the commands the frontend actually invokes on a path some spec exercises.

Holding the crate's registered command surface against its own table is [DSH-1](../../architecture/application/desktop/windows/application-shell.md#the-command-surface)'s job, done by the command-surface admission test its registry row names. The same check holds the mock's serviced-command surface (the override allow-list and the canonical switch's case labels alike) equal to the crate's registered surface. So the mock services every crate command, and a backend command cannot land without this suite seeing it.

**Per-spec behavior rides an override seam.** `installTauriMockServer({ overrides })` replaces one command's behavior with spec-supplied source. For example, `panel-commit-completeness-barrier.spec.js` has `stop_capture` return a real barrier report whose sentinel the spec then delivers itself. That spec also raises the adapter's sentinel wait bound through the served module's test-only seam, so under the suite's timeouts no fallback can finalize the step inside the test. The seam works under these rules:

- Naming a command the canonical mock does not service is an error. An override can only restate a serviced command, never widen the surface behind the fail-loud contract.
- The fixture resolves the source in the test process and refuses a value that does not come out a function. The source resolves in the test process as well as in the page, so an override reaches page globals from inside the function it resolves to, never while constructing itself.
- Only that refusal catches source that resolves but is not a function. Without it, the mock would install cleanly and the failure would land at invoke time on a command the mock does service, where the unknown-invoke guard has nothing to say.
- Source that resolves there but throws in the page gets past the refusal and aborts the served mock script, which the mock-presence assertion above reports.

`sync-samples.spec.js` goes one step further. It runs a real reference sync server as a child process and reverse-proxies the protocol paths through the same-origin dist server. A plain page enforces CORS that the Tauri webview does not, so the proxy keeps the test faithful to the app's real sync path. The spec slots that proxy in through the fixture's `routeRequest` option, which answers a request ahead of the served frontend files.

## What the suite covers

The suite is exactly the test files below: every spec or test file Playwright's default discovery finds under `packages/desktop/tests/integration/`, at any depth. A new one joins this table in the same change that adds it, and a CI lint holds the two in agreement. No two specs here, and no spec twice, declare the same `describe > test` path; a real-tree lock in the shared unit suite holds this. A describe title alone may repeat, so a case moved between specs takes its full path into the directory's one set of paths, where it must stay distinct.

| Spec                                        | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `panel-desktop.spec.js`                     | Core panel UI: project/recording creation, view transitions, step commit via simulated `capture:action` events, re-record entry, pause and resume, project and recording deletion; and a `RECORDING_START` sent through the adapter seam, which reaches `start_capture` and clears the reorder state.                                                                                                                                      |
| `panel-commit-completeness-barrier.spec.js` | Step-commit completeness: a normal recording commit engages the fused stop-path flush barrier and waits for its `barrier_complete` sentinel before finalizing the step.                                                                                                                                                                                                                                                                    |
| `panel-startup.spec.js`                     | The panel-open gate: with a slowed `load_state`, `openPanel` returns only once the panel has applied what it loaded, rendered its projects view and made its startup invokes.                                                                                                                                                                                                                                                              |
| `panel-session-file-unreadable.spec.js`     | A session file the backend could not use ([application-shell §DSH-3](../../architecture/application/desktop/windows/application-shell.md#session-persistence)): moved aside, the user is told where it was kept and the panel goes on saving; left in place, the user is told nothing will be saved and the panel invokes no `save_state`; a file that loads shows no message.                                                             |
| `panel-dispatch-sync.spec.js`               | Dispatch and sync settings saved, rejected when invalid, and read back; sync settings also read back after the panel is opened again as a fresh document, saved and cleared; the connection-test status after a save and the Auto-Sync enable; the sync button gate; the dispatch button gate and confirmation flow.                                                                                                                       |
| `panel-advanced-flows.spec.js`              | Dispatch send with stubbed fetch, sync flow, inline rename, the multi-recording dispatch selector, re-record cancel; project and recording creation by the Enter key; cancelling the new-project and new-recording forms.                                                                                                                                                                                                                  |
| `panel-coverage-boost.spec.js`              | Metadata CRUD, import (including duplicate-project copies), export, sync partial-success and auth-error paths, "Send all", target-app selector, self-capture toggle, drag reorder.                                                                                                                                                                                                                                                         |
| `import-export-rerecord-desktop.spec.js`    | Import/export round-trips (format stamp derived from the composed schema, never hardcoded), re-record (and leaving one through a breadcrumb cancelling it, so the next recording's step gets its own logical id and none of the actions captured for it), drag reorder persistence.                                                                                                                                                        |
| `panel-rerecord-leave-drain.spec.js`        | Leaving a re-record through either breadcrumb, against a mocked `stop_capture` that delivers a drained action after its result: the panel waits for the stop's sentinel, so the drained action is discarded with the re-record and is never pending in the recording opened next.                                                                                                                                                          |
| `panel-rerecord-timings.spec.js`            | Through `set_capture_timings_measuring`, the panel holds the capture timings from the opening of a re-record, through a pause, a commit in either recording mode, a leave, a cancel and a sync that ends while it records, to the next start of a capture that is not a re-record's, which measures; a re-record cancelled while it records measures again in the capture it leaves running; the recording before a re-record is measured. |
| `panel-confirm-dialogs.spec.js`             | The confirmations before Clear (both recording modes) and before deleting a step, a recording or a project: answered Cancel, nothing is cleared or deleted; Clear in simple mode answered OK clears; and the mock's `confirm` answering with a Promise, as the dialog plugin's does.                                                                                                                                                       |
| `accessibility-desktop.spec.js`             | axe-core WCAG 2.1 AA scan of each major panel view (machine-detectable issues only).                                                                                                                                                                                                                                                                                                                                                       |
| `sync-samples.spec.js`                      | The real desktop client pulls the bundled `desktop-windows` seed sample from a running reference sync server and rejects the `extension`-stamped one.                                                                                                                                                                                                                                                                                      |

## Running the suite

```bash
# One-time / after shared or frontend changes: assemble the dist the server serves
npm run sync-shared && npm run build:desktop-dist

# Install suite dependencies (own package.json)
cd packages/desktop/tests/integration && npm ci && npx playwright install chromium

# From the repository root
npm run test:integration
```

`npm run test:integration` runs `npm test` in the suite directory (plain `npx playwright test`). `npm run test:headed` opens a visible browser. In CI the suite runs in the `desktop-integration-tests` job on Linux.

## Adding a test

- **A panel or flow scenario** extends the spec whose table row it belongs to (or a new file when it opens a genuinely new group). It uses the fixtures [Configuration and coverage](#configuration-and-coverage) names: `test` and `expect` from `./coverage-fixture.js`, the backend from `installTauriMockServer()`.
- **To reach the state a scenario starts from**, use the shared helpers [the mock section](#how-the-tauri-backend-is-mocked) names: `openPanel`, `createProject`, `seedRecordedStep`, and `fireCaptureActions` for captured input. Read what the panel did through its invoke-record readers and `window.__TAURI__` hooks.
- **A command answering differently for one spec** takes the override seam, which restates a command the mock services and never adds one.
- A new spec or test file joins the table in [What the suite covers](#what-the-suite-covers) in the same change that adds it. What it and its clause rows must also satisfy is in [Extending the docs governance](../../guides/docs-governance.md#what-each-kind-of-change-keeps-green).

## Configuration and coverage

`playwright.config.js` keeps the suite deterministic: 15 s per-test timeout, 1 retry, a single worker, headless. Its `globalTeardown` converts the raw V8 coverage that `coverage-fixture.js` collects per page into one lcov report, uploaded under the `integration,javascript` coverage flag. The files it reports on are a closed, hard-coded list; [coverage reporting](../strategy/coverage.md#closed-world-tracked-file-lists-e2e-and-desktop-integration) has the mechanism and the maintenance rule. The run-scoped dump naming and tolerant sweep behind that conversion live in the shared contract module `packages/shared/tests/support/coverage-run.js`, shared with [the extension e2e suite](../e2e.md).

A new spec imports `test`/`expect` from `./coverage-fixture.js` (not `@playwright/test` directly) so its pages contribute coverage, and calls `installTauriMockServer()` from `./tauri-mock-fixture.js` for the mocked backend. The mock fixture registers its hooks on that same `test`, so the two compose without a spec choosing between coverage and the mock.
