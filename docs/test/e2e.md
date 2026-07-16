# End-to-end tests — Chrome extension

Playwright tests that drive a real Chrome with the extension loaded and assert
what the extension captured, stored, and shows. The commands to run them are in
the [contributing guide](../../.github/CONTRIBUTING.md#running-tests)
(`npm run test:e2e`).

Everything lives under `packages/extension/tests/e2e/`:

- `specs/` — the suite this document covers, run by `npm run test:e2e`
  (`playwright.config.js`).
- `helpers/` — the shared harness: the extension fixture, the frame-readiness
  helpers, and the coverage plumbing.
- `corpus/` — the extension producer of the
  [scripted-truth corpus](../verification/scripted-truth-corpus.md), a separate
  run under its own configs (see
  [Runs sharing this tree](#runs-sharing-this-tree)).

## The shape of a capture test

1. Launch a headed Chromium **persistent context** with the extension loaded
   (`--load-extension`); extensions run neither headless nor in the default
   incognito context. Each test gets its own fresh context.
2. Serve the test page over loopback HTTP. The recorder is injected only into
   http/https pages, so `page.setContent` / `about:blank` content would never
   be captured; the shared fixture runs an in-process server on an ephemeral
   port, and `setTestContent(page, html)` navigates to a fresh URL served with
   exactly that HTML.
3. Start recording by flipping `recording: true` in `chrome.storage.local`
   from the service worker. The SW's `storage.onChanged` hook injects the
   recorder into the open frames and seeds the frame-trust registry
   ([extension capture principles](../architecture/application/extension/capture-principles.md#frame-trust-and-readiness)).
4. Wait for the recorder's readiness beacon —
   [`FRAME_READY`](#readiness--frame_ready-never-a-page-flag), never a fixed
   sleep.
5. Perform real user input through Playwright. Only trusted events count — the
   recorder rejects synthetic events, and that rejection is itself under test:
   most capture specs pair each positive case with its programmatic twin
   asserting nothing is captured.
6. Wait for the captured stream to [settle](#settle-waits), then read
   `pendingActions` from `chrome.storage.local` **via the service worker**
   (extension storage is reachable only from extension contexts).
7. Assert the captured actions — typically the exact action-type sequence plus
   the fields the scenario is about.

Panel and service-worker specs skip the page server: they open
`chrome-extension://<id>/sidepanel/index.html` directly and drive the real
panel UI, or `evaluate` against the service worker to exercise its message
protocol.

## Harness contract

### Readiness — FRAME_READY, never a page flag

The recorder runs in the content-script **isolated world**. The moment it
finishes wiring its listeners it reports readiness to the service worker with a
`FRAME_READY` message (`{ readyAt, url }`, `readyAt` stamped with the
recorder's `Date.now()`), and the service worker registers the sending
(tab, frame) pair in its frame-trust registry. The beacon is a production
signal, not test scaffolding.

Tests observe readiness **through the service worker**, keyed by frame URL:
`installReadyProbe(serviceWorker)` (`helpers/frame-ready.js`) adds a second
`chrome.runtime.onMessage` listener in the SW that records each frame's
`readyAt` — Chrome dispatches a message to every listener, so the probe rides
alongside the production handler without ever responding — and
`waitForFrameReady(serviceWorker, url)` polls that map. The map is
last-write-wins per URL: specs use a fresh URL per page, and a suite that
revisits stable URLs (the corpus) must use
`waitForFrameReadySince(serviceWorker, url, sinceTs)` after every navigation so
a stale pre-navigation timestamp cannot satisfy the wait.

The convention is deliberate. A `window` readiness flag would fail twice over:
set in the isolated world it is invisible to the page's main world, so a
Playwright main-world probe would hang; made page-visible it would leak
recording state to the page, letting a page behave differently while recorded —
the reasoning recorded alongside
[ECP-3](../architecture/application/extension/capture-principles.md#frame-trust-and-readiness).
Readiness flows recorder → service worker → test, never through the page.

Every wait for capture readiness goes through these helpers, after **every**
navigation — the old document's recorder dies with it, and the new document has
no recorder until the service worker re-injects on its
`webNavigation.onCompleted`. Acting before the beacon races the injection.

### Serialization

`workers: 1` — the specs run strictly one at a time. Captured state funnels
through `chrome.storage.local`, and the shared fixture keeps a module-level
service-worker handle for `setTestContent`; both assume no second test runs
concurrently. Isolation between tests comes from each test's fresh persistent
context, not from parallelism.

### Retries and timeouts

`retries: 3` (four attempts) with `trace: 'on-first-retry'`, and a 30-second
per-test timeout. Retries absorb real-input timing flakes; a genuine failure
stays red on every attempt. The consequence for authors: a test must be
self-contained and repeatable — every attempt starts from a fresh context, so
nothing may depend on state a previous attempt or test left behind.

### Settle waits

Captures are not all synchronous with the input: contenteditable typing
commits on a pause, scrolls on a settle timer, and browser-chrome proxies
arrive through service-worker listeners. Tests therefore assert only once the
stream is quiescent: `waitForActionsToSettle(serviceWorker, page)` polls the
`pendingActions` length (400 ms period by default) until it stops changing
between polls. There is no fixed side-effect delay to wait out — the wait ends
when the stream does.

### Fixtures and coverage collection

`helpers/extension-fixture.js` is the default entry point: its `test` export
provides `context` / `serviceWorker` / `testPage` fixtures (a `testPage`
arrives on a served URL with recording started and `FRAME_READY` observed),
plus `setTestContent`, `getPendingActions`, `clearPendingActions`, and
`waitForActionsToSettle`. Specs that need a different server shape — two
origins for cross-origin frames, per-path route tables, a spawned reference
sync server — define local fixtures in-file; the ones that drive page frames
install the same `FRAME_READY` probe before navigating, while a panel-only
spec (the spawned-server sync spec) skips it — the recorder never loads on
`chrome-extension://` pages, so a readiness wait there can never be satisfied.

The suite doubles as the e2e coverage source: the `testPage` fixture profiles
the page's extension scripts via CDP, `sidepanel-coverage.spec.js` adds
`page.coverage` for the panel and a raw-CDP connection for the service worker
(`helpers/cdp-sw-coverage.js`), and `global-teardown.js` merges everything into
`coverage/lcov.info`. How that reaches Codecov is in
[coverage reporting](strategy/coverage.md).

## What the suite covers

The `specs/` suite is exactly the files below; a new spec file joins this
enumeration in the same change that adds it.

### Capture behaviour — real input in, captured actions out

| Spec                          | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.js`               | A realistic browsing session: typed address-bar navigation, link click plus address-bar mix, a full search flow, back/forward, and a multi-site session asserting no side-effect leakage.                                                                                                                                                                                                                                                            |
| `interactions.spec.js`        | The interaction surface paired with its programmatic twins: file upload, drag-and-drop, same-origin (srcdoc) iframe clicks and programmatic iframe navigation, contenteditable typing (including `contenteditable=""`), password and sensitive-field masking, double-click, shadow DOM, programmatic `contextmenu` / `.click()` rejection, form submission (the click is captured; the navigation is an effect), and return-to-tab `context_switch`. |
| `keyboard.spec.js`            | The keyboard whitelist: Enter/Escape/Tab captured as `key` actions, Enter producing no synthetic click, typing producing `type` rather than key actions, F11/F12 producing nothing at all, whitelist-external combos (Ctrl+A/C/V/Z) emitting no `key` action, programmatic keydown rejected, and Enter on a link capturing the key only.                                                                                                             |
| `navigation.spec.js`          | `navigate` proxies (typed, reload, back/forward) and their negatives: programmatic `form.submit()`, `location.href`, an in-iframe meta refresh, and 302/multi-redirect chains produce no navigate beyond the user's click; background-tab value changes and a page-directed Ctrl+W keystroke produce nothing; switching tabs produces `context_switch`.                                                                                              |
| `side-effect-capture.spec.js` | Pure-effect rejection: programmatic focus, value, and selection changes, `pushState`, hash changes, programmatic scroll, the `window.open` lifecycle, timer-driven updates, and rapid focus cycling — none captured.                                                                                                                                                                                                                                 |
| `browser-chrome.spec.js`      | The browser-chrome proxies from the retired manual scenarios (see [manual tests](manual/extension.md)): right-click → open in new tab, address-bar focus-and-cancel, keyboard-driven select, Ctrl+T / Ctrl+N / Ctrl+W as `context_open` / `context_close`, tab click as `context_switch`, and Ctrl+X cut.                                                                                                                                            |
| `recorder-coverage.spec.js`   | Recorder edge paths: right-click target variants, arrow keys on listboxes and sliders, `select` capture, Tab↔focus correlation (with click-focus dedup and the password-field focus skip), stop/restart recording transitions, blur-on-submit change suppression, body/html click rejection, the double-injection guard, and contenteditable debounce plus blur flush.                                                                               |
| `iframe-capture.spec.js`      | Cross-origin, nested (two-level), and dynamically created iframes are captured with the right `frame_src`, alongside continued parent-page capture (#93).                                                                                                                                                                                                                                                                                            |
| `locators.spec.js`            | Locator emission on live pages: duplicate elements measured (`match_count` / `match_index`), a duplicated id counted while the derived selector still resolves uniquely, the unique-id fast path, and in-place masking of the value-derived `text` entry on a sensitive element.                                                                                                                                                                     |

### Harness-pinned bounds

| Spec                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `injection-latency.spec.js`          | The readiness bound of [ECP-5](../architecture/application/extension/capture-principles.md#frame-trust-and-readiness): for the main frame, a srcdoc iframe, and a dynamic subframe, `webNavigation.onCompleted` → `FRAME_READY` completes under half the ~200 ms deliberate-action floor (`lib/capture-timing.js`), both timestamps on one machine's clock.                               |
| `frame-trust.spec.js`                | The drop side of [ECP-3](../architecture/application/extension/capture-principles.md#frame-trust-and-readiness): a forged `APPEND_ACTION` from a non-frame sender is dropped end-to-end — pinning that every append routes through the trust gate — while a genuine recorded-frame action is appended; the gate's individual rejection branches are pinned by the frame-trust unit tests. |
| `storage-quota.spec.js`              | Quota exhaustion (#90) — failing writes corrupt no stored projects, export keeps working, clearing frees space — and the warn/pause machine of [ECP-11](../architecture/application/extension/capture-principles.md#storage-pressure) (#127): per-band panel banners, auto-pause at the warn threshold, user override, resume on freed space.                                             |
| `storage-quota-live-capture.spec.js` | The paused gate under live capture (#127): an action performed while paused is dropped; after the user's override the next action is captured.                                                                                                                                                                                                                                            |

### Panel UI

| Spec                             | Covers                                                                                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel-core-flows.spec.js`       | Narration commit flow and its gating, step-list accumulation, dispatch confirmation, clear, step detail, delete step/project, simple-mode commit through export, theme switching, step history, the projects/project/recording view scaffolding, breadcrumbs, and settings navigation. |
| `panel-simple-mode.spec.js`      | The recording-mode switch (narration vs simple), the validation `expect` group, simple-mode commit gating, and the metadata-editor UI.                                                                                                                                                 |
| `sidepanel-flows.spec.js`        | Panel flows against the real service worker: commit, deletes, step detail, settings persistence (dispatch endpoint, sync), clear, re-record with history, breadcrumbs, dispatch success and failure (mocked fetch), sync completion, export download, cancel paths, and metadata.      |
| `import-export-rerecord.spec.js` | Import of a `.docent.json` file into the project list, export of a valid `.docent.json` download, the re-record edit flow, and drag-reorder persistence.                                                                                                                               |
| `accessibility.spec.js`          | axe-core WCAG 2.1 AA scans of every major panel view (#29).                                                                                                                                                                                                                            |

### Service worker and cross-component

| Spec                               | Covers                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service-worker-coverage.spec.js`  | The SW message protocol end-to-end: project/recording CRUD and lifecycle, step commit / re-record / delete / reorder, import/export, metadata, error paths, `GET_TAB_ID`, the `APPEND_ACTION` drop acknowledgment, and the tab/webNavigation lifecycle handlers including programmatic-tab suppression. |
| `service-worker-lifecycle.spec.js` | Suspension survival: pending actions and project state persisted in `chrome.storage.local`, the message handler working after state is re-read from storage, and storage-usage sanity checks.                                                                                                           |
| `sync-samples.spec.js`             | Against a real spawned reference sync server seeded with the bundled samples: the extension pulls and reconciles its own platform's sample and rejects the other platform's as a stamp mismatch — the guard that a schema-shape change cannot ship beside a stale seed sample.                          |
| `sidepanel-coverage.spec.js`       | Exercises the basic panel flows (projects, settings, theme, recording creation) while collecting panel and SW coverage; the flows deliberately overlap the panel specs — this file exists for the coverage plumbing.                                                                                    |

## Adding a test

- **A capture scenario** extends the spec whose table row it belongs to (or a
  new file when it opens a genuinely new group). Import the shared fixture,
  take `testPage` and `serviceWorker`, call `setTestContent` with the minimal
  HTML the scenario needs, act with real input only, settle, then assert on
  `getPendingActions` — exact sequences over loose containment wherever the
  scenario allows. Pair the positive case with its programmatic twin when one
  exists.
- **After any further navigation**, wait for readiness again — a fresh URL plus
  `waitForFrameReady`, or `waitForFrameReadySince` when the URL repeats.
- **Panel or service-worker behaviour**: copy the `panelPage` fixture pattern
  (open `sidepanel/index.html` by extension id) or `evaluate` against the
  `serviceWorker` fixture directly.
- New files under `specs/` are picked up by `testDir` automatically; the only
  registry to update is this document's coverage tables.
- Write for four attempts: fresh context per attempt, no reliance on prior
  state, and waits keyed to observable signals (readiness, settle) rather than
  durations.

## Runs sharing this tree

`corpus/corpus.spec.js` is not part of `npm run test:e2e`: it is the extension
producer of the
[scripted-truth corpus](../verification/scripted-truth-corpus.md), run by
`npm run corpus:produce:extension` under `playwright.corpus.config.js` (fixed
viewport, the fixed-port corpus page server, the produce-stage oracle) and, in
conformance-vector mode, by `npm run vectors:produce:extension` under
`playwright.vectors.config.js`. It follows the same harness contract — one
worker, retries, the `FRAME_READY` discipline (the `Since` variant, because
corpus URLs are stable across loads).

How the e2e layer sits within the wider suite is in
[the test pyramid](strategy/test-pyramid.md); the retired manual scenarios and
the automated tests that replaced them are in
[manual tests — extension](manual/extension.md).
