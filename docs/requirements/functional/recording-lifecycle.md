# Recording Lifecycle — Functional Requirements

The recording-authoring contract as it ships on both platforms: what a user
can do at each stage of a recording's life, and what the system guarantees at
each stage. Every rule cited here is owned elsewhere — by a format,
protocol, architecture, requirements, or guide document — this is the
requirements-level enumeration, not a second home for the rules. The step-by-step workflows are the user guides'
([extension](../../user/extension.md),
[desktop](../../user/desktop-windows.md)); that both platforms honour the
same contract is held by
[Shared Core §SC-1](../../architecture/system/shared-core.md#the-parity-rule)
— the behaviour-defining logic below is implemented once.

## Create

- A user can create projects, and recordings inside a project. Each carries
  a time-ordered unique identity, a name, a creation timestamp, and optional
  user-defined metadata — the shapes are the
  [Session Format](../../technical/session-format.md)'s.
- On the desktop, the user selects a target application from the running
  windows before capturing
  ([desktop guide](../../user/desktop-windows.md#record-a-workflow)).

## Capture into pending

- While a recording is open, captured interactions accumulate as the step's
  **pending actions**; they enter the recording only when the user commits
  the step. The pending-list rules (commit, clear, pause, discard on
  re-entry) are the
  [extension guide's](../../user/extension.md#pending-actions).
- Guarantee: only real user actions enter the stream, with sensitive values
  masked at capture time —
  [Capture Principles](../../architecture/system/capture-principles.md).
- Pending survival is a deliberate platform difference — persisted on the
  extension, memory-only on the desktop — owned by
  [Persistence](../../architecture/system/persistence.md#deliberately-ephemeral-state).

## Commit steps

- Committing pairs the pending actions with step context in one of two
  modes — a free-text narration, or a structured action/validation
  classification — the two modes
  [Product Positioning](../business/positioning.md#example-consumers)
  defines. The platform's default mode is a setting, supplied through the
  [adapter seam](../../architecture/system/shared-core.md#the-adapter-seam).
- A commit requires at least one captured action (and narration text, in
  narration mode — [extension guide](../../user/extension.md#pending-actions));
  the committed step joins the recording's history.

## Edit, re-record, delete, reorder

- A user can view a committed step's actions read-only, re-record a step
  (replacing its narration and actions), view its full version history,
  soft-delete it, and reorder steps
  ([extension guide — edit steps](../../user/extension.md#edit-steps)).
- Guarantee: the step history is **append-only** — every mutation appends a
  new version record, a deletion appends a content-preserving tombstone, and
  the committed view is resolved from the history. The format rules are
  [session-format §SF-8 and §SF-9](../../technical/session-format.md#steps);
  this document does not restate them.

## Export and import

- A user can export a project as a `.docent.json` file carrying the full
  step history and the self-describing `docent_format` stamp
  ([Session Format](../../technical/session-format.md#format-stamp)).
- A user can import a previously exported file. Guarantee: a file is
  accepted only after the ingestion bounds and schema validation, including
  the version-stamp gate —
  [session-format §SF-13](../../technical/session-format.md#import-acceptance)
  — and an import never overwrites or merges an existing project
  ([extension guide — import](../../user/extension.md#import)).

## Dispatch

- A user can send one or more of a project's recordings to a configured
  HTTP endpoint, after a confirmation of the endpoint, selection, and step
  count. Eligibility, the endpoint URL policy, retries, and the post-send
  cooldown are the [Dispatch Protocol](../../api/dispatch.md)'s contract.

Keeping the authored data in step across machines is a separate contract,
the [Sync Protocol](../../api/sync-protocol.md); its user-facing controls
are the [extension guide's Sync section](../../user/extension.md#sync).
