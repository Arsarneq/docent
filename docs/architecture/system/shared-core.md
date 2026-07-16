# Shared Core — One Implementation on Both Platforms

Docent's two platforms present the same recording model, panel behaviour,
sync, and dispatch. That parity is held by construction, not by convention:
the behaviour-defining logic is implemented once, in `packages/shared/`, and
each platform consumes it through a thin platform adapter. This document
covers the two halves of that arrangement — the **runtime architecture**
(what the shared layer contains, and the adapter seam it is consumed
through) and the **build-time mechanism** (`npm run sync-shared`, which
places the shared source inside each platform package). Its companion,
[Persistence](persistence.md), covers where each platform keeps the data
this logic operates on.

Each rule carries a stable identifier (**SC-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../clause-registry.json). The
key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

---

## The parity rule

**SC-1.** Behaviour-defining logic — logic that determines what a recording
contains, how the project/recording model mutates, how sync reconciles, how
dispatch delivers, or how a step or action is rendered — lives in
`packages/shared/`, and each platform MUST run that one implementation,
reaching platform facilities through its platform adapter
([the adapter seam](#the-adapter-seam)) rather than forking the logic. The
definition is the rule; the listed domains illustrate it and do not close it
— a novel kind of behaviour is judged against the definition, not the list.
A platform-local reimplementation of behaviour the shared layer
defines is a defect, not an alternative: one implementation is what keeps
the platforms from drifting apart. Where a cross-platform rule requires a single shared implementation —
the sensitive-field detection of
[core CP-11](capture-principles.md#sensitive-values) is the named example —
this architecture is what supplies it.

---

## What the shared layer contains

| Group                            | Modules                                                                                                                                                                                                      | Defines                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session model & format machinery | `lib/session.js`, `lib/export-project.js`, `lib/import-project.js`, `lib/validate-import.js`, `lib/format-stamp.js`, `lib/uuid-v7.js`                                                                        | The append-only step history and active-view resolution ([session-format §SF-8/SF-9](../../technical/session-format.md#steps)), export assembly, import acceptance with its bounds ([§SF-13](../../technical/session-format.md#import-acceptance)), and the schema-sourced format stamp |
| Sensitive-field detection        | `lib/field-sensitivity.js`                                                                                                                                                                                   | The single shared detection [core CP-11](capture-principles.md#sensitive-values) requires, applied by each platform's redaction chokepoint                                                                                                                                              |
| Sync client                      | `sync-client.js`, `conflict-detector.js`, `conflict-resolution.js`, `sync-digest.js`, `sync-baseline.js`, `sync-store.js`, `sync-scheduler.js`, `sync-types.js`, `sync-conflict-ui.js`, `connection-test.js` | The client half of the [Sync Protocol](../../api/sync-protocol.md): the pull/reconcile/push cycle, conflict classification and resolution, the sync-state store, scheduling, and the connection test                                                                                    |
| Dispatch core                    | `dispatch-core.js`, `dispatch-cooldown.js`                                                                                                                                                                   | The client half of the [Dispatch Protocol](../../api/dispatch.md): payload assembly, endpoint-URL validation, retries, and the send cooldown                                                                                                                                            |
| HTTP seam                        | `lib/http-transport.js`                                                                                                                                                                                      | The settable transport the shared sync and dispatch code issue requests through ([dispatch §DI-12](../../api/dispatch.md#transport-seam))                                                                                                                                               |
| Views                            | `views/views.html`, `views/panel.css`, `views/render.js`, `views/adapter.js`                                                                                                                                 | The panel's HTML structure and styles, the pure rendering functions, and the platform-adapter interface declaration                                                                                                                                                                     |
| Bundled assets                   | `assets/` (`icons/icon.svg`, `reading-guidance.md`)                                                                                                                                                          | Product assets riding the copy: the dispatch payload's reading guidance ([dispatch §DI-5](../../api/dispatch.md#reading-guidance)) is loaded by both adapters from the synced tree; the icon set's consumers read the source path                                                       |

The shared package also carries its own unit suites
(`packages/shared/tests/`, run by `npm run test:shared` against the source in
place); tests are excluded from the platform copies.

---

## The adapter seam

The adapter's core surface is declared as the `PlatformAdapter` typedef in
[`packages/shared/views/adapter.js`](../../../packages/shared/views/adapter.js);
two of the obligations below — the default step-context mode and the
platform's generated import validator — are implemented by both adapters
beyond the typedef. Each platform implements the seam once:
[`adapter-chrome.js`](../../../packages/extension/sidepanel/adapter-chrome.js)
over Chrome extension APIs, and
[`adapter-tauri.js`](../../../packages/desktop/src/adapter-tauri.js) over
Tauri v2 `invoke`/`listen`. The shared modules themselves are
platform-call-free: each platform's panel driver consumes the adapter to
wire the shared views and modules to platform facilities, and where shared
code itself must reach platform behaviour it does so through the two
injected seams below — the sync-state store it is handed, and the
rebindable HTTP transport. What the seam requires of an adapter:

- **Backend messaging** — `send(message)` delivers a request to the
  platform's backend and returns its response.
- **Settings persistence** — load/save for dispatch settings, sync settings,
  the theme, and the default step-context mode, each backed by the
  platform's own storage ([Persistence](persistence.md)).
- **Bundled assets** — the reading-guidance prose, the platform's composed
  schema, and the platform's generated import validator, each loaded from
  the synced `shared/` tree (below).
- **The capture feed** — `onActionEvent` delivers each captured action to
  the panel as it arrives, with `getPendingCount`/`onPendingCountChange`
  beside it.
- **Capability flags** — `hasNativeFileDialog` selects the export/import
  file flow.

Two further shared seams bind per platform alongside the adapter: the
sync-state store (`sync-store.js`'s `load`/`save` interface — the extension
folds it into its platform adapter; the desktop panel binds it to the
`syncState` member of its session blob), and the HTTP transport
(`lib/http-transport.js` defaults to `fetch`, which the extension keeps
under its host permissions; the desktop rebinds it at adapter load to the
native `sync_http_request` command, since a webview `fetch` would be
CORS-blocked against a non-CORS server).

What stays platform-local, by design:

- **The panel driver** — each platform's `panel.js` wires the shared views
  and modules to its adapter and owns the DOM event handling. On the
  extension, every model mutation flows as a message to the service worker,
  which owns the model keys
  ([runtime architecture](../application/extension/runtime.md)); on the
  desktop, the frontend holds the model and persists it through the session
  commands ([Persistence](persistence.md)).
- **Capture delivery** — how captured actions reach the pending list: the
  extension's service worker appends to the persisted pending buffer and
  the panel watches its storage key
  ([runtime §ERT-3](../application/extension/runtime.md#storage-keys-and-write-ownership));
  the desktop adapter receives `capture:action` events from the Rust
  backend, splices each into the pending list by `sequence_id`, applies the
  desktop redaction chokepoint
  ([desktop DCP-11](../application/desktop/windows/capture-principles.md#sensitive-value-redaction)),
  and holds the list in memory.
- **The capture layers themselves** — platform-native by nature (content
  script + service worker; low-level hooks + UI Automation workers) and
  governed by their own documents:
  [extension](../application/extension/capture-principles.md),
  [desktop](../application/desktop/windows/capture-principles.md).

---

## Shared views — one fragment, two shells

[`scripts/inject-shared-views.js`](../../../scripts/inject-shared-views.js)
assembles each platform's panel page from two committed sources: the
platform's document shell (`index.shell.html`) and the single shared
fragment `packages/shared/views/views.html`, which replaces the shell's
`<!-- SHARED_VIEWS -->` marker. The desktop assembly applies one transform —
the theme option label "Follow browser" becomes "Follow system". Both panels
therefore render the same view markup, styled by the shared
`views/panel.css` and populated by the rendering functions in
`views/render.js` — pure HTML-string functions with no DOM manipulation and
no platform calls, so how a step or action is rendered is defined once. The
assembled `index.html` files are committed build output (see
[freshness](#the-outputs-and-their-freshness) below).

---

## Build time — `npm run sync-shared`

### Why a copy

A Chrome extension — like other sandboxed runtimes — cannot import modules
from outside its own root directory, so the platforms cannot import
`packages/shared/` in place.
[`scripts/sync-shared.js`](../../../scripts/sync-shared.js) copies it into
each platform package instead, where relative imports like
`../shared/lib/session.js` resolve at runtime.

### What a sync does

Each run (steps 2–4 per target — `extension`, `desktop`; both by default;
steps 1 and 5 once per invocation):

1. regenerates the per-platform import validators once up front
   (`scripts/build-validators.js` → `packages/shared/generated/`);
2. deletes and re-copies `packages/shared/` → `packages/<target>/shared/`,
   excluding `tests/` and `generated/`;
3. writes `packages/<target>/shared/session.schema.json`, composed in memory
   from the schema source layers — never copied from `schemas/dist/`, which
   is release output and can lag the source layers within a PR
   ([session-format — JSON Schema files](../../technical/session-format.md#json-schema-files));
4. copies only the target's own generated validator into
   `shared/generated/`;
5. runs the [shared-views injection](#shared-views--one-fragment-two-shells)
   after the target loop — it reassembles **both** platforms' `index.html`
   regardless of which targets were requested.

### The outputs and their freshness

**SC-2.** The synced trees (`packages/extension/shared/`,
`packages/desktop/shared/`) and the two assembled `index.html` panel pages
are `sync-shared` output and MUST NOT be hand-edited — edits go to the
shared source and the shells, and a re-run regenerates everything. The
synced trees are gitignored; the assembled `index.html` files are
deliberately committed (an ignore rule on an already-tracked file is inert
and would only mask staleness), and the committed copies MUST match what
`sync-shared` produces from the current tree — CI re-runs the sync and fails
on any diff (the `Verify sync-shared output is fresh` step in
[`test.yml`](../../../.github/workflows/test.yml), part of the paths-filtered
unit-tests job: it runs on every push to `main` and on every PR that touches
an input able to stale the outputs; a docs-only PR skips it).

The freshness rule in practice: after editing anything under
`packages/shared/` or a shell, re-run `npm run sync-shared` before loading
the extension, building the desktop app, or running platform tests
([Contributing — Project Structure](../../../.github/CONTRIBUTING.md#project-structure)).
The pipelines never trust a stale copy either: the CI test jobs re-run the
sync before exercising platform code, and each release pipeline syncs before
packaging, so a shipped artifact always embeds the shared source at its
release commit ([Publishing](../../../.github/PUBLISHING.md)).
