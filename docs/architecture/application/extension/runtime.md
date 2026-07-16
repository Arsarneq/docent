# Runtime Architecture — Chrome Extension

The Manifest V3 runtime the extension's capture and UI surfaces run on: the
service-worker lifecycle and the persisted-state model that survives it, the
message protocol connecting the side panel, the recorder, and the service
worker, and the `chrome.storage` key inventory with its write-ownership
contract. Companion to
[Capture Principles — Chrome Extension](capture-principles.md), which governs
what may enter a recording; this document governs how the runtime that does
the capturing is wired. The permission surface all of it runs on is
enumerated in [Permissions](permissions.md).

Each rule carries a stable identifier (**ERT-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../../clause-registry.json). The
key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

---

## Components

The extension is three runtime surfaces:

| Surface        | Entry                                         | Runs                                                                                                                                                |
| -------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service worker | `background/service-worker.js`                | Event-driven, suspended when idle. Hosts the message dispatcher, the browser-chrome proxies, injection, and the background Auto-Sync host.          |
| Recorder       | `content/recorder.js`                         | In the content-script isolated world of recorded frames; presence and the idle surface are governed by [ECP-2](capture-principles.md#architecture). |
| Side panel     | `sidepanel/index.html` + `sidepanel/panel.js` | The UI. Talks to the worker through the platform adapter (`sidepanel/adapter-chrome.js`): request/response messages plus watched storage keys.      |

The toolbar button opens the panel (`chrome.action.onClicked` →
`chrome.sidePanel.open`). The panel never operates on the recording model
directly: every model mutation flows as a message to the service worker,
which owns the model keys in storage (the
[write-ownership contract](#storage-keys-and-write-ownership) below).

---

## Lifecycle and the persisted-state model

An MV3 service worker is event-driven: the browser starts it to deliver an
event and suspends it again after an idle period. The extension is built so
that a suspension is invisible to the user — capture, the pending buffer, and
background sync all survive it.

**ERT-1.** Every fact the user's work depends on across a worker suspension
MUST be held in `chrome.storage`, never only in worker memory. The worker's
in-memory state is limited to three classes, each safe to lose with the
worker:

- **Mirrors of persisted keys** — the model working copy (`projects`,
  `activeProjectId`, `activeRecordingId`), the live `recording` flag, the
  storage-pressure gate
  ([ECP-11](capture-principles.md#storage-pressure)), and the Auto-Sync
  trigger wiring; each is restored or re-derived from storage at every
  worker start, and the `recording` and sync-state mirrors are additionally
  kept fresh by `chrome.storage.onChanged`, so the worker reacts identically
  however the key changes — its own write path, another extension surface's
  ([ERT-3](#storage-keys-and-write-ownership) names each key's writers), or
  a writer outside the extension entirely (a test harness driving the
  browser).
- **State rebuildable from the browser's own tables** — the active-frame
  registry [ECP-3](capture-principles.md#frame-trust-and-readiness) defines
  and governs, rebuildable from the browser's frame table.
- **Correlation markers** — the tab-lifecycle suppression timestamps, whose
  meaning expires within the timing windows centralized in
  [`lib/capture-timing.js`](../../../../packages/extension/lib/capture-timing.js),
  and the programmatic-tab set, whose membership lasts as long as its tab —
  losing it to a suspension degrades capture to the heuristic boundary those
  detections already admit
  ([ECP-12](capture-principles.md#exceptions-within-the-surface)). The
  correlation signals that must outlive a single worker instance or cross
  contexts (`lastUserActionTimestamp`, `lastTabNavUrl`) are persisted
  instead.

A change that introduces worker in-memory state MUST place it in one of
these classes or extend this enumeration in the same change.

### Startup

The worker's startup surface is exactly two blocks:

- **`chrome.runtime.onInstalled`** — on first install (`reason: "install"`),
  seeds the empty model keys (`projects`, `pendingActions`, `pendingCount`).
- **The module-scope restore block**, run at every worker start (first start
  or wake from suspension): restores the model working copy from storage,
  seeds the in-memory `recording` mirror, rehydrates the storage-pressure
  gate from its published key, reconciles the background Auto-Sync trigger
  with the persisted setting, and re-evaluates storage pressure against
  actual usage.

The worker never writes the `recording` flag at startup — the user controls
capture, so a recording in progress continues across a suspension or a
browser restart. The Auto-Sync backstop alarm (`chrome.alarms`, ~60 s) is
persisted by the browser and re-wakes the worker, so background sync also
continues with the panel closed
([Sync Protocol — Automatic sync](../../../api/sync-protocol.md#automatic-sync-auto-sync)).

The worker's module imports are governed by
[ECP-1](capture-principles.md#architecture) — the MV3 constraint and its
guards.

---

## Injection

How the recorder reaches pages. The governing rules — injection only while
recording, frame trust and readiness, the readiness latency bound, and the
`<all_urls>` decision — are
[ECP-2 through ECP-5](capture-principles.md#architecture); this section is
the event wiring that implements them:

- **Record-start** — the worker clears the frame registry, injects
  `content/recorder.js` into every open http/https tab across all frames
  (`chrome.scripting.executeScript` with `injectImmediately`), and seeds the
  registry from the browser's frame table. The record-start message handlers
  run this sequence, and the worker's `storage.onChanged` listener on the
  `recording` flag runs the same sequence whenever the flag becomes true, so
  the injection behaves identically however the flag changes — the worker's
  own write path or a writer outside the extension (a test harness driving
  the browser); the recorder's `__docentLoaded` guard makes the overlap
  idempotent per document.
- **During the recording** — `webNavigation.onCompleted` injects the
  recorder into each frame as it finishes loading (main frames, srcdoc
  iframes, dynamically created subframes) and registers it as trusted;
  `webNavigation.onBeforeNavigate` drops a navigating subframe's
  registration, since its recorder unloads with the old document and the
  following `onCompleted` re-injects.
- **Record-stop** — every stop path clears the frame registry synchronously
  and clears the `recording` flag in storage; already-injected recorders go
  inactive through their own `recording` watch. The resulting idle surface
  is governed by [ECP-2](capture-principles.md#architecture).

Once all its listeners are wired, each injected recorder sends the worker a
`FRAME_READY` message — the readiness beacon
[ECP-3](capture-principles.md#frame-trust-and-readiness) defines and
governs; the e2e harness keys its waits on it
([e2e — readiness](../../../test/e2e.md#readiness--frame_ready-never-a-page-flag)).

---

## Message protocol

Transport is `chrome.runtime.sendMessage` into the worker's single
`onMessage` dispatcher; message types are `UPPER_SNAKE_CASE` string constants
declared at their call sites. The panel↔worker surface has exactly two
channels: the request/response messages below, and the watched storage keys
listed under [Storage keys](#storage-keys-and-write-ownership).

### Capture path

Sent by the recorder to the worker:

| Type            | Payload            | Response                                                                                                           |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `GET_TAB_ID`    | —                  | `{ tabId }`, answered synchronously — the sender's tab identity exists only on the dispatcher's `sender` argument. |
| `FRAME_READY`   | `{ readyAt, url }` | None — a one-way readiness beacon ([ECP-3](capture-principles.md#frame-trust-and-readiness)).                      |
| `APPEND_ACTION` | `{ action }`       | The [response envelope](#response-contract) below.                                                                 |

`APPEND_ACTION` is the single path a captured action takes into storage: the
worker validates the sender against the frame registry
([ECP-3](capture-principles.md#frame-trust-and-readiness)), stamps
`context_id` from the trusted sender
([ECP-4](capture-principles.md#frame-trust-and-readiness)), applies the
storage chokepoint
([ECP-9](capture-principles.md#sensitive-value-redaction)), and appends to
the pending buffer through a serialized write queue gated by storage
pressure ([ECP-11](capture-principles.md#storage-pressure)).

### Panel protocol

The closed set of request types the panel sends, by group:

| Group             | Types                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects          | `PROJECTS_LIST`, `PROJECTS_GET_ALL`, `PROJECTS_SET`, `PROJECT_CREATE`, `PROJECT_OPEN`, `PROJECT_GET`, `PROJECT_DELETE`, `PROJECT_RENAME`, `PROJECT_SET_METADATA` |
| Recordings        | `RECORDING_CREATE`, `RECORDING_OPEN`, `RECORDING_DELETE`, `RECORDING_RENAME`, `RECORDING_SET_METADATA`                                                           |
| Recording control | `RECORDING_START`, `RECORDING_STOP`, `RECORDING_CLEAR`, `STORAGE_RESUME`                                                                                         |
| Steps             | `STEP_COMMIT`, `STEP_DELETE`, `STEPS_REORDER`                                                                                                                    |
| Import / export   | `PROJECT_IMPORT`, `PROJECT_EXPORT`                                                                                                                               |

A successful response to one of the data events
[SP-21](../../../api/sync-protocol.md#automatic-sync-auto-sync) enumerates —
as message types: `STEP_COMMIT`, `RECORDING_STOP`, `PROJECT_CREATE`,
`PROJECT_DELETE`, `RECORDING_CREATE`, `RECORDING_DELETE` — additionally
fires a background Auto-Sync trigger.

### Response contract

**ERT-2.** Every [panel-protocol](#panel-protocol) request, plus
`APPEND_ACTION`, resolves with exactly one response envelope:
`{ ok: true, … }` on success (result data rides beside `ok`) or
`{ ok: false, error }` on failure. Failures MUST be returned in-band — the
dispatcher never throws through the message port — and a message type outside
the enumerations above is answered `{ ok: false, error }`. The other two
capture-path messages answer as their [table rows](#capture-path) state:
`GET_TAB_ID` with the bare `{ tabId }` shape, `FRAME_READY` with no response
at all. `APPEND_ACTION` acknowledges a trust-gate drop with `{ ok: true }`:
the acknowledgment confirms delivery, not acceptance
([ECP-3](capture-principles.md#frame-trust-and-readiness) governs the drop
itself), and `{ ok: false }` is reserved for storage failures.

---

## Storage keys and write ownership

**ERT-3.** The tables below are the extension's complete `chrome.storage`
surface, and each key's "Written by" column names exactly the write sites in
the extension's own code. A change that introduces a key, or a new writer
for an existing key, MUST extend these tables in the same change.

`chrome.storage.local`:

| Key                       | Holds                                                                                                                                                             | Written by                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `projects`                | The full project/recording model                                                                                                                                  | Service worker                                                                                  |
| `activeProjectId`         | The open project's id                                                                                                                                             | Service worker                                                                                  |
| `activeRecordingId`       | The open recording's id                                                                                                                                           | Service worker                                                                                  |
| `recording`               | The capture flag: recorders capture and chrome proxies are recorded only while `true`                                                                             | Service worker                                                                                  |
| `pendingActions`          | The pending buffer — actions captured since the last step boundary, already redacted at the chokepoint ([ECP-9](capture-principles.md#sensitive-value-redaction)) | Service worker                                                                                  |
| `pendingCount`            | `pendingActions.length`, maintained beside every buffer write                                                                                                     | Service worker                                                                                  |
| `lastUserActionTimestamp` | Recent in-page-action signal the worker's effect suppression reads ([ECP-8](capture-principles.md#filtering-approach))                                            | Recorder                                                                                        |
| `lastTabNavUrl`           | Navigation dedup marker, self-clearing (~5 s)                                                                                                                     | Service worker                                                                                  |
| `docentStorageQuota`      | Published storage-pressure state ([ECP-11](capture-principles.md#storage-pressure))                                                                               | Service worker                                                                                  |
| `docentEndpointUrl`       | Dispatch endpoint URL                                                                                                                                             | Side panel                                                                                      |
| `docentApiKey`            | Dispatch API key, stored as an encrypted envelope ([security policy](../../../../.github/SECURITY.md#protecting-stored-credentials))                              | Side panel                                                                                      |
| `docentSyncUrl`           | Sync server URL                                                                                                                                                   | Side panel                                                                                      |
| `docentSyncApiKey`        | Sync API key, stored as an encrypted envelope                                                                                                                     | Side panel                                                                                      |
| `docentTheme`             | Theme setting                                                                                                                                                     | Side panel                                                                                      |
| `docentRecordingMode`     | Default step-context mode (narration / simple)                                                                                                                    | Side panel                                                                                      |
| `docentSyncState`         | The durable sync reconcile state blob: baselines, snapshots, reviews, conflicts, and sync settings                                                                | Side panel and service worker, each through the shared sync-store helpers over the same adapter |

`chrome.storage.session` (held in memory by the browser, cleared on browser
restart):

| Key               | Holds                                                   | Written by                   |
| ----------------- | ------------------------------------------------------- | ---------------------------- |
| `docentSecretKey` | The ephemeral AES key for the encrypted settings values | Side panel, on settings save |

Two consequences the rest of the runtime relies on: the model keys have a
single writer, so the panel mutates the model only through the
[panel protocol](#panel-protocol); and the pending buffer has a single
writer whose serialized queue maintains `pendingActions` and `pendingCount`
together, so they read as a consistent pair.

### Change signals

Five keys double as change signals watched via `chrome.storage.onChanged`:
the panel watches `pendingActions` (the live captured-actions list),
`pendingCount` (commit-button state), `docentStorageQuota` (the pressure
banner), and `docentSyncState` (sync attention indicators and settings
state); the worker watches `recording` (injection and the capture mirror)
and `docentSyncState` (the Auto-Sync trigger); each injected recorder
watches `recording` to activate and deactivate in place.
