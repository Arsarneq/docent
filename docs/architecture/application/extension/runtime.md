# Runtime Architecture — Chrome Extension

The Manifest V3 runtime that the extension's capture and UI surfaces run on:

- the service-worker lifecycle and the persisted-state model that survives it;
- the message protocol between the side panel, the recorder and the service worker;
- the `chrome.storage` key inventory and its write-ownership contract.

Its companion, [Capture Principles — Chrome Extension](capture-principles.md), governs what may enter a recording. This document governs how the capturing runtime is wired. [Permissions](permissions.md) lists the permission surface it all runs on.

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
identifiers reflect minting order and can appear out of numeric sequence.

---

## Components

The extension is three runtime surfaces:

| Surface        | Entry                                         | Runs                                                                                                                                                |
| -------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service worker | `background/service-worker.js`                | Event-driven, suspended when idle. Hosts the message dispatcher, the browser-chrome proxies, injection, and the background Auto-Sync host.          |
| Recorder       | `content/recorder.js`                         | In the content-script isolated world of recorded frames; presence and the idle surface are governed by [ECP-2](capture-principles.md#architecture). |
| Side panel     | `sidepanel/index.html` + `sidepanel/panel.js` | The UI. Talks to the worker through the platform adapter (`sidepanel/adapter-chrome.js`): request/response messages plus watched storage keys.      |

The toolbar button opens the panel (`chrome.action.onClicked` → `chrome.sidePanel.open`). The panel never operates on the recording model directly. Every model mutation goes as a message to the service worker, which owns the model keys in storage (the [write-ownership contract](#storage-keys-and-write-ownership) below).

The side panel also hosts the opt-in [local control channel](../../../api/control-channel.md): one outward WebSocket to the loopback address. Through it a paired local process triggers the panel's own structuring actions and, if a person allows it at turn-on, the build behind the panel's Export button. The channel adds nothing to the surfaces this document specifies:

| Runtime surface      | What the channel adds                                             |
| -------------------- | ----------------------------------------------------------------- |
| Service worker state | Nothing — the worker is not told the channel exists               |
| Message protocol     | No message type — a command sends the messages a click sends      |
| Storage keys         | No key — the channel's whole state is in the panel page's memory  |
| Permissions          | None — the panel page's content security policy names the address |

---

## Lifecycle and the persisted-state model

An MV3 service worker is event-driven: the browser starts it to deliver an event and suspends it again after an idle period. The extension makes a suspension invisible to the user: capture, the pending buffer and background sync all survive it.

**ERT-1.** Every fact the user's work depends on across a worker suspension
MUST be held in `chrome.storage`, never only in worker memory. The worker's
in-memory state is limited to four classes, each safe to lose with the
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
  registry [ECP-3](capture-principles.md#frame-trust-and-readiness) states,
  rebuildable from the browser's frame table.
- **Correlation markers** — the tab-lifecycle suppression timestamps and ids,
  whose meaning expires within the timing windows centralized in
  [`lib/capture-timing.js`](../../../../packages/extension/lib/capture-timing.js),
  and the programmatic-tab set, whose membership lasts as long as its tab
  (the entry is deleted as its tab closes) — losing it to a suspension
  degrades capture to the heuristic boundary those detections already admit
  ([ECP-12](capture-principles.md#exceptions-within-the-surface)). The
  correlation signals that must outlive a single worker instance or cross
  contexts (`lastUserActionTimestamp`, `lastTabNavUrl`) are persisted
  instead.
- **Transient coordination state** — the serialized write queue through which
  the worker orders its pending-buffer writes; it holds no data of its own,
  only the order of writes to persisted keys.

A change that introduces worker in-memory state MUST place it in one of
these classes or extend this enumeration in the same change.

**ERT-5.** The worker also assigns an introspection handle over the
rebuildable-state class and one correlation marker — the frame registry and the
programmatic-tab set — on its own `globalThis` (`__docentCaptureBookkeeping` in
`background/service-worker.js`): it reads facts — the two structures, and the
tabs a record-start seed would target, answered by running the seed's own
query so an observer of what a clear spared never restates that set — plants
entries, and simulates suspension loss with raw wipes run outside any
production trigger; each structure's removal paths run from production events
— the registry's at the sites that implement the departures
[ECP-3](capture-principles.md#frame-trust-and-readiness) states, the
recording-flag watch included (Injection, below; which clears run on which
flag change is stated at
[ECP-3](capture-principles.md#frame-trust-and-readiness)), the set's by the
per-tab delete stated above — the wipes from none. Each structure's writers
likewise run from production events — the registry's the ones
[ECP-3](capture-principles.md#frame-trust-and-readiness) states, the on-load
registration included (Injection, below), the set's the tab-created
suppression decision behind the correlation marker above — the plants from
none. It decides nothing and holds no state of its own — the structures it
reaches are the ones placed above, and it adds none — so it introduces no
worker in-memory state for
[ERT-1](#lifecycle-and-the-persisted-state-model)'s placement rule to place, and
the worker's global scope is reachable only at DevTools level, never from pages
or content scripts — so the handle is not a page-visible surface, held to the
same page-visibility test as the readiness beacon
([ECP-3](capture-principles.md#frame-trust-and-readiness)).

The handle's member surface is the table below, stated closed: each member
reaches exactly the worker bindings its row names — a structure the clause
places the handle over, a function it runs to reach one, or a query of its
own that touches no placed structure, and the handle assigns no member the
table does not carry. A change that adds, removes, or renames a member, or
gives one a reach the table does not state, MUST update the table in the
same change. A row states what its member reaches by the worker's own
binding names, backticked, separated by commas — or `none`, where the member
reaches no worker binding at all and stands on a platform call alone.

| Member                 | Reaches                  | What it does                                                                                                                     |
| ---------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `frameRegistry`        | `activeFrames`           | Answers a snapshot of the registry, as frame ids per tab.                                                                        |
| `programmaticTabs`     | `programmaticTabs`       | Answers a snapshot of the set, as tab ids.                                                                                       |
| `captureTargetTabIds`  | `queryCaptureTargetTabs` | Answers the tab ids a record-start would target, by running the record-start seed's own query, reaching no structure of its own. |
| `plantFrame`           | `registerFrame`          | Adds a (tab, frame) entry the way a production registration does.                                                                |
| `plantProgrammaticTab` | `programmaticTabs`       | Adds a tab id to the set.                                                                                                        |
| `wipeFrameRegistry`    | `activeFrames`           | Empties the registry directly, outside any production trigger, simulating suspension loss.                                       |
| `wipeProgrammaticTabs` | `programmaticTabs`       | Empties the set the same way, for the same purpose.                                                                              |

**ERT-6.** The handle ships in release builds: the packaged extension carries
the worker as written, so a released build assigns the members the table
states. What that grants is what access to the worker's own global scope
already grants — the structures are the worker's, the reads answer what it
holds at that moment, and the plants and wipes reach what a caller standing in
that scope reaches directly — so the handle widens no boundary the runtime
draws. Each other extension surface runs in a global scope of its own, the
recorder's content-script world among them: a handle mention written there
names a binding that scope has never held, and is a defect rather than a use.

### Startup

The worker's startup surface is exactly two blocks:

- **`chrome.runtime.onInstalled`.** On first install (`reason: "install"`), it seeds the empty model keys (`projects`, `pendingActions`, `pendingCount`).
- **The module-scope restore block** runs at every worker start (first start or wake from suspension). It:
  - restores the model working copy from storage;
  - seeds the in-memory `recording` mirror;
  - rehydrates the storage-pressure gate from its published key;
  - reconciles the background Auto-Sync trigger with the persisted setting;
  - re-evaluates storage pressure against actual usage.

The message that woke the worker is delivered before the restore block has read storage. Every panel request waits for the restore before it is handled, and so does a background Auto-Sync cycle: a request handled on the empty working copy would act on no projects, and the restore would then replace what the request did. Where the read of the stored state fails, the worker does not know its projects: it answers every panel request with the error `Stored state could not be read`, runs no sync cycle, and writes nothing over the stored model.

The worker never writes the `recording` flag at startup. The user controls capture, so a recording in progress continues across a suspension or a browser restart. The browser persists the Auto-Sync backstop alarm (`chrome.alarms`, ~60 s), which re-wakes the worker. So background sync also continues with the panel closed ([Sync Protocol — Automatic sync](../../../api/sync-protocol.md#automatic-sync-auto-sync)).

[ECP-1](capture-principles.md#architecture) governs the worker's module imports: the MV3 constraint and its guards.

---

## Injection

How the recorder reaches pages. [ECP-2 through ECP-5](capture-principles.md#architecture) are the governing rules: injection only while recording, frame trust and readiness, the readiness latency bound, and the `<all_urls>` decision. This section is the event wiring that implements them:

- **Record-start.** The worker clears the frame registry, injects `content/recorder.js` into every frame of every open http/https tab that the browser lets the extension reach (`chrome.scripting.executeScript` with `injectImmediately`), and seeds the registry from the browser's frame table. The record-start message handlers run this sequence. The recording-flag watch runs the same sequence whenever the flag becomes true. So injection behaves identically however the flag changes: through the worker's own write path or through a writer outside the extension (a test harness driving the browser). The recorder's `__docentLoaded` guard makes the overlap idempotent per document.
- **During the recording.** `webNavigation.onCompleted` injects the recorder into each frame as it finishes loading (main frames, srcdoc iframes, dynamically created subframes), whenever the browser lets the extension reach it. It registers each injected frame as trusted. `webNavigation.onBeforeNavigate` drops a navigating subframe's registration, since its recorder unloads with the old document and the following `onCompleted` re-injects.
- **Record-stop.** Every stop path clears the frame registry synchronously, before it clears the `recording` flag in storage. The recording-flag watch also clears the registry whenever the flag becomes false, on the same mirrors reading as the record-start half above ([ERT-1](#lifecycle-and-the-persisted-state-model)). [ECP-3](capture-principles.md#frame-trust-and-readiness) states which clears run on which flag change. Already-injected recorders go inactive through their own `recording` watch. [ECP-2](capture-principles.md#architecture) governs the resulting idle surface.

Once all its listeners are wired, each injected recorder sends the worker a `FRAME_READY` message. This is the readiness beacon [ECP-3](capture-principles.md#frame-trust-and-readiness) states. The e2e harness keys its waits on it ([e2e — readiness](../../../test/e2e.md#readiness--frame_ready-never-a-page-flag)).

---

## Message protocol

Transport is `chrome.runtime.sendMessage` into the worker's single `onMessage` dispatcher. One request goes the other way: `END_TYPING`, which the worker sends by `chrome.tabs.sendMessage` to one frame at a time and the recorder's own `onMessage` listener answers ([capture path](#capture-path)). Message types are `UPPER_SNAKE_CASE` string constants declared at their call sites. The panel↔worker surface has exactly two channels: the request/response messages below, and the watched storage keys listed under [Storage keys](#storage-keys-and-write-ownership).

**ERT-4.** The dispatcher's serviced surface is exactly the two enumerations
this section states — the capture-path table's message types, serviced by the
listener's dedicated guards ahead of the dispatcher switch, and the panel
protocol's closed set, serviced by that switch's cases. The two enumerations
are disjoint, and a type outside them is answered with
[ERT-2](#response-contract)'s error envelope. A change that adds, removes, or
renames a serviced message type MUST update the matching enumeration in the
same change.

The panel states its half of that surface literally: each type of the
[panel protocol](#panel-protocol)'s closed set has at least one send written as
an object literal whose top-level `type` property carries the type name as a
string literal. A change that leaves an enumerated type without one MUST update
this statement and the check that holds it in the same change.

The recorder states its half the same way, payload included: each type of the
[capture path](#capture-path)'s table is sent at least once from an object
literal whose top-level `type` property carries the type name as a string
literal, and that type's Payload cell states the message's remaining top-level
keys — each a bare name, backticked together as one object shape, or the lone
marker `—`, itself one backticked span, where the message carries none. The
Response column states in prose what the worker answers the sender. A change
that leaves a stated type without such a send, or that moves a key on one side
alone, MUST update this statement and the check that holds it in the same
change.

### Capture path

Sent by the recorder to the worker:

| Type              | Payload            | Response                                                                                                                                       |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET_TAB_ID`      | `—`                | `{ tabId }`, answered synchronously — the sender's tab identity exists only on the dispatcher's `sender` argument.                             |
| `FRAME_READY`     | `{ readyAt, url }` | None — a one-way readiness beacon ([ECP-3](capture-principles.md#frame-trust-and-readiness)).                                                  |
| `APPEND_ACTION`   | `{ action }`       | The [response envelope](#response-contract) below.                                                                                             |
| `POINTER_PRESSED` | `—`                | None. A one-way signal that the pointer was pressed in the sender's frame; the worker asks the tab's other frames to end their typing (below). |

`APPEND_ACTION` is the single path a captured action takes into storage. The worker:

- validates the sender against the frame registry ([ECP-3](capture-principles.md#frame-trust-and-readiness));
- stamps `context_id` from the trusted sender ([ECP-4](capture-principles.md#frame-trust-and-readiness));
- applies the storage chokepoint ([ECP-9](capture-principles.md#sensitive-value-redaction));
- appends to the pending buffer through a serialized write queue gated by storage pressure ([ECP-11](capture-principles.md#storage-pressure)).

Sent by the worker to a recorder, one frame at a time, is the single request
`END_TYPING`: the frame writes a key press it still holds back to learn
whether it was text, as the `key` it was, and then the entry typed into the
field in focus and into editable content, through `APPEND_ACTION` as any action, and answers
`{ ok: true }` once the worker has answered those appends. The worker sends
it to every registered frame ahead of a step commit and ahead of a stop, and
waits for the answers up to a bound, so the step and the recording hold the
entry; and to the other frames of a tab on `POINTER_PRESSED`, held to the
sender test of `APPEND_ACTION` (the lazy reseed included), where the worker
holds the appends that arrive next from the pressing frame until those frames
have answered, up to the same bound, so what the press made them write is
stored ahead of the press's own `click`
([ECP-6](capture-principles.md#capture-surface)). A sender test that runs as
the worker wakes waits for the stored recording flag to be read back first.

### Panel protocol

The closed set of request types the panel sends, by group:

| Group             | Types                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects          | `PROJECTS_LIST`, `PROJECTS_GET_ALL`, `PROJECTS_SET`, `PROJECT_CREATE`, `PROJECT_OPEN`, `PROJECT_GET`, `PROJECT_DELETE`, `PROJECT_RENAME`, `PROJECT_SET_METADATA` |
| Recordings        | `RECORDING_CREATE`, `RECORDING_OPEN`, `RECORDING_DELETE`, `RECORDING_RENAME`, `RECORDING_SET_METADATA`                                                           |
| Recording control | `RECORDING_START`, `RECORDING_STOP`, `RECORDING_CLEAR`, `STORAGE_RESUME`                                                                                         |
| Steps             | `STEP_COMMIT`, `STEP_DELETE`, `STEPS_REORDER`                                                                                                                    |
| Import / export   | `PROJECT_IMPORT`, `PROJECT_EXPORT`                                                                                                                               |

Each open panel shows a project of its own and, in the recording view, a recording. Capture, by contrast, is one per browser. Captured actions go to the worker's active project and recording (`activeProjectId`, `activeRecordingId`). These follow whichever panel last opened or created a project or a recording: `PROJECT_CREATE`, `PROJECT_OPEN`, `RECORDING_CREATE` and `RECORDING_OPEN` make the project or recording they create or open the active one.

Capture runs only while there is an active recording. `PROJECT_CREATE` and `PROJECT_OPEN` stop it. So do `PROJECT_DELETE` of the active project, `RECORDING_DELETE` of the active recording, and a `PROJECTS_SET` that leaves the active recording out. None of them changes the pending buffer.

Every other message about one project or recording names it by ids. The `project_id` is that of the project the sending panel shows (for `PROJECT_DELETE`, the project it deletes). For a recording or its steps, the `recording_id` is that of the recording the action is for: the one the recording view shows, or a row of the project view's recording list. The worker reads its target from those ids alone:

- **Resolved by the ids it carries.** `PROJECT_GET`, `PROJECT_RENAME`, `PROJECT_SET_METADATA`, `RECORDING_CREATE`, `RECORDING_OPEN`, `RECORDING_DELETE`, `RECORDING_RENAME`, `RECORDING_SET_METADATA`, `STEP_DELETE`, `STEPS_REORDER` and `PROJECT_EXPORT` act on the stored project and recording they name, or answer `{ ok: false, error: 'Project not found' }` or `{ ok: false, error: 'Recording not found' }` and change nothing.
- **Refused unless they name the active ones.** `RECORDING_START`, `RECORDING_STOP`, `RECORDING_CLEAR` and `STEP_COMMIT` act on the capture state and the pending buffer, which belong to the active recording. Each is carried out only when its `project_id` and `recording_id` are the active project and recording. A missing `recording_id` matches only when no recording is active. Otherwise the message is answered `{ ok: false, error: 'Not the active recording' }` and changes nothing. A `RECORDING_STOP` while capture is off has no capture to protect, so it is carried out whatever it names, and changes nothing. A panel whose recording is no longer the active one learns it from that answer. The panel drops its own capture state and ends a re-record under way. Opening the recording again makes it the active one.

The panel reads `ok` on every answer before it uses the answer's fields. When the worker does not accept a message, the action it belongs to changes nothing in the panel. A click tells the person `<Action> failed: <error>` (the sync and resolution flows use their own `Sync failed` and `Could not resolve` wording). After a not-found answer, the panel shows the open project as the worker now holds it, or the projects list when the project is gone. Two things stand apart from that rule:

- The panel drops its capture state on `Not the active recording`, as stated above.
- The stop the panel sends when the person leaves reports no failure, since a refused stop there means capture belongs to another panel. After the person leaves a recording through a breadcrumb, the panel shows no capture whatever the answer. Cancelling a re-record ends the re-record whatever the answer.

A stop that an action sends first, as creating a recording does, stands when the action then fails.

A successful response to a message in the worker's data-event set (`STEP_COMMIT`, `RECORDING_STOP`, `PROJECT_CREATE`, `PROJECT_DELETE`, `RECORDING_CREATE`, `RECORDING_DELETE`) also fires a background Auto-Sync trigger. A `RECORDING_STOP` fires it whether refused or not: a refused stop comes only while capture runs, when the scheduler drops the trigger. The set stands in for the six events [SP-21](../../../api/sync-protocol.md#automatic-sync-auto-sync) enumerates. `RECORDING_STOP` is sent more widely than the clause's recording close; SP-21 records that departure.

### Response contract

**ERT-2.** Every [panel-protocol](#panel-protocol) request, plus
`APPEND_ACTION`, resolves with exactly one response envelope:
`{ ok: true, … }` on success (result data rides beside `ok`) or
`{ ok: false, error }` on failure. Failures MUST be returned in-band — the
dispatcher never throws through the message port — and a message type outside
the enumerations above is answered `{ ok: false, error }`. The other three
capture-path messages answer as their [table rows](#capture-path) state:
`GET_TAB_ID` with the bare `{ tabId }` shape, `FRAME_READY` and
`POINTER_PRESSED` with no response at all. `APPEND_ACTION` acknowledges a trust-gate drop with `{ ok: true }`:
the acknowledgment confirms delivery, not acceptance
(the drop itself is stated at
[ECP-3](capture-principles.md#frame-trust-and-readiness)), and `{ ok: false }`
is reserved for storage failures.

---

## Storage keys and write ownership

**ERT-3.** The tables below are the extension's complete `chrome.storage`
surface, and each key's "Written by" column names exactly the write sites in
the extension's own code. A change that introduces a key, or a new writer
for an existing key, MUST extend these tables in the same change.

`chrome.storage.local`:

| Key                       | Holds                                                                                                                                                                                                                                                                           | Written by                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `projects`                | The full project/recording model                                                                                                                                                                                                                                                | Service worker                                                                                  |
| `activeProjectId`         | The id of the project last opened or created in a panel, or of the one holding the recording last opened or created; none once that project is deleted ([Panel protocol](#panel-protocol))                                                                                      | Service worker                                                                                  |
| `activeRecordingId`       | The id of the recording last opened or created in a panel, which captured actions go to; none once a project is opened or created, or `RECORDING_DELETE` or `PROJECT_DELETE` removes that recording or its project; a `PROJECTS_SET` without it stops capture and leaves the id | Service worker                                                                                  |
| `recording`               | The capture flag: recorders capture and chrome proxies are recorded only while `true`                                                                                                                                                                                           | Service worker                                                                                  |
| `pendingActions`          | The pending buffer — actions captured since the last step boundary, already redacted at the chokepoint ([ECP-9](capture-principles.md#sensitive-value-redaction))                                                                                                               | Service worker                                                                                  |
| `pendingCount`            | `pendingActions.length`, maintained beside every buffer write                                                                                                                                                                                                                   | Service worker                                                                                  |
| `lastUserActionTimestamp` | Recent in-page-action signal the worker's effect suppression reads ([ECP-8](capture-principles.md#filtering-approach))                                                                                                                                                          | Recorder                                                                                        |
| `lastTabNavUrl`           | Navigation dedup marker, self-clearing (~5 s)                                                                                                                                                                                                                                   | Service worker                                                                                  |
| `docentStorageQuota`      | Published storage-pressure state ([ECP-11](capture-principles.md#storage-pressure))                                                                                                                                                                                             | Service worker                                                                                  |
| `docentEndpointUrl`       | Dispatch endpoint URL                                                                                                                                                                                                                                                           | Side panel                                                                                      |
| `docentApiKey`            | Dispatch API key, stored as an encrypted envelope ([security policy](../../../../.github/SECURITY.md#protecting-stored-credentials))                                                                                                                                            | Side panel                                                                                      |
| `docentSyncUrl`           | Sync server URL                                                                                                                                                                                                                                                                 | Side panel                                                                                      |
| `docentSyncApiKey`        | Sync API key, stored as an encrypted envelope                                                                                                                                                                                                                                   | Side panel                                                                                      |
| `docentTheme`             | Theme setting                                                                                                                                                                                                                                                                   | Side panel                                                                                      |
| `docentRecordingMode`     | Default step-context mode (narration / simple)                                                                                                                                                                                                                                  | Side panel                                                                                      |
| `docentSyncState`         | The durable sync reconcile state blob: baselines, snapshots, reviews, conflicts and sync settings among them — the sync-state store holds the set                                                                                                                               | Side panel and service worker, each through the shared sync-store helpers over the same adapter |

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

Five keys double as change signals, watched through `chrome.storage.onChanged`:

| Watcher                | Key                  | Drives                                                      |
| ---------------------- | -------------------- | ----------------------------------------------------------- |
| Panel                  | `pendingActions`     | The live captured-actions list                              |
| Panel                  | `pendingCount`       | Commit-button state                                         |
| Panel                  | `docentStorageQuota` | The pressure banner                                         |
| Panel                  | `docentSyncState`    | Sync attention indicators and settings state                |
| Worker                 | `recording`          | Injection, the frame-registry clear, and the capture mirror |
| Worker                 | `docentSyncState`    | The Auto-Sync trigger                                       |
| Each injected recorder | `recording`          | Activating and deactivating the recorder in place           |
