# Shared Interaction Model — Design Record

Why the two platforms feel like one product: the panel structure, the
workflow, and its vocabulary are a single design, implemented once and
rendered on both platforms. The [desktop guide](../../user/desktop-windows.md#record-a-workflow) states
the claim in one line — "the same workflow as the Chrome extension" — and
this record says what that means concretely, then names the deliberate platform
differences with the documents that own each. The mechanism holding the
parity is architecture territory:
[Shared Core §SC-1](../../architecture/system/shared-core.md#the-parity-rule)
— behaviour-defining logic implemented once, consumed through each
platform's adapter.

## One panel structure

Both platforms render the same panel markup: the single shared fragment
([`views.html`](../../../packages/shared/views/views.html)) is injected into
each platform's document shell at build time
([one fragment, two shells](../../architecture/system/shared-core.md#shared-views--one-fragment-two-shells)),
styled by the shared stylesheet and populated by the shared rendering
functions. The views are: the projects list, the new-project and
new-recording forms, the project view (recordings, export, send), the
recording view (step context input, captured actions, step list), step
history, step detail, the dispatch confirmation and result views, the
recording selector, the sync resolution view, and Settings. The desktop
assembly applies one deliberate text transform — the theme option "Follow
browser" becomes "Follow system"
([Shared Core](../../architecture/system/shared-core.md#shared-views--one-fragment-two-shells)
owns it).

## The same workflow verbs

The authoring workflow is one design; the user guides document it once, and
the desktop guide defers to the extension guide for the shared flows:

| Verb       | What it is                                                                                 | Owned by                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **record** | Create a project and recording; captured actions accumulate as pending until committed.    | [Extension guide](../../user/extension.md#record-steps); [desktop guide](../../user/desktop-windows.md#record-a-workflow) |
| **commit** | Pair the pending actions with step context — narration or action/validation — into a step. | [Extension guide](../../user/extension.md#record-steps); modes: [Positioning](../../requirements/business/positioning.md) |
| **edit**   | Re-record, view history, soft-delete, reorder committed steps.                             | [Extension guide](../../user/extension.md#edit-steps)                                                                     |
| **export** | Write (and import back) a `.docent.json` file.                                             | [Extension guide](../../user/extension.md#export)                                                                         |
| **send**   | Dispatch recordings to a configured endpoint.                                              | [Extension guide](../../user/extension.md#send); [Dispatch Protocol](../../api/dispatch.md)                               |
| **sync**   | Keep projects in step with a sync server.                                                  | [Extension guide](../../user/extension.md#sync); [Sync Protocol](../../api/sync-protocol.md)                              |

The behaviour behind every verb — the session model, import acceptance,
dispatch delivery, the sync cycle, and the step/action rendering — is the
shared layer's
([what the shared layer contains](../../architecture/system/shared-core.md#what-the-shared-layer-contains)).

## The deliberate platform differences

Each difference is deliberate, and each is owned by a document:

- **Capture source and target selection** — the extension captures the
  browser; the desktop captures native Windows applications and adds one
  workflow step, selecting a target application
  ([desktop guide](../../user/desktop-windows.md#record-a-workflow)). The
  capture layers themselves are platform-native and governed by their own
  documents
  ([extension](../../architecture/application/extension/capture-principles.md),
  [desktop](../../architecture/application/desktop/windows/capture-principles.md)).
- **File dialogs** — the desktop opens native save/open dialogs from the
  Rust shell
  ([application shell — command surface](../../architecture/application/desktop/windows/application-shell.md#the-command-surface));
  the extension uses the browser's download and file-picker flows. The
  adapter's `hasNativeFileDialog` capability flag selects the flow
  ([the adapter seam](../../architecture/system/shared-core.md#the-adapter-seam)).
- **Tray keep-alive** — with Auto-sync on, closing the desktop window hides
  it to the system tray so background cycles keep running
  ([application shell — keep-alive](../../architecture/application/desktop/windows/application-shell.md#background-auto-sync-keep-alive);
  [desktop guide — Sync](../../user/desktop-windows.md#sync)); the
  extension's background context is its service worker
  ([extension runtime](../../architecture/application/extension/runtime.md)).
- **Pending-buffer persistence** — the extension persists the pending
  capture buffer (it survives a worker suspension and a browser restart);
  the desktop holds it in memory, and quitting discards uncommitted
  actions. Owned by
  [Persistence](../../architecture/system/persistence.md#deliberately-ephemeral-state).
