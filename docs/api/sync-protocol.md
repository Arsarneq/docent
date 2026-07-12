# Docent Sync Protocol

The Docent sync protocol is a simple REST API that enables bidirectional
synchronization of projects and recordings between Docent clients and a remote
server. This document is the formal specification — it contains everything a
backend developer needs to implement a compatible sync server.

Each rule carries a stable identifier (**SP-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../clause-registry.json). The key
words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

**SP-1.** The server is **opaque**: it stores and returns each
`Full_Project_Payload` verbatim and holds no conflict state of its own. All conflict detection and
resolution is client-side. A server built against the
[Endpoints](#endpoints) and [Payload Shapes](#payload-shapes) sections below is
complete and correct regardless of how the client reconciles — the
[Sync Behavior](#sync-behavior) section documents the client cycle for context,
not as a server obligation.

---

## Overview

Sync may be triggered manually (a Sync button) or automatically (background
event and interval triggers). Either way, a full sync cycle runs three phases
**in order**:

1. **Pull** — the client fetches the project manifest, then retrieves each
   project's full data into a retained snapshot.
2. **Reconcile** — the client classifies every project and recording against the
   last state it mutually agreed on with the server (its _baseline_), applies the
   safe outcomes automatically, and defers the rest to the user.
3. **Push** — the client writes back each project whose local state needs to
   reach the server, assembling the payload **per recording**.

Conflict resolution is **graded**, not server-wins. Pulling first lets the
client observe a concurrent server change _before_ its own push can overwrite
it, so a divergence is detected and surfaced instead of silently lost. A unit
that only changed locally is pushed automatically; an incoming change to a
recording the user already has is held for review; a unit changed on both sides
becomes a conflict the user resolves. The server is never involved in any of
this — it only stores and returns payloads.

Docent's own clients surface the resulting reviews and conflicts as per-unit
**attention indicators**, derived identically on both platforms by the shared
[`sync-conflict-ui.js`](../../packages/shared/sync-conflict-ui.js): a recording
needing attention always shows a recording-level indicator; a project shows its own
indicator when the project unit itself needs attention, plus a rolled-up indicator
for any of its recordings that do — so a project row can carry both at once. This is
client presentation, not part of the wire protocol.

> **Replaces the legacy cycle.** Earlier versions pushed first and then pulled,
> and the pull did a **server-wins** merge: a pulled project replaced the local
> project entirely, so local work could be lost without warning. Pushing first
> also made divergence undetectable — the client's own push set the server equal
> to local before the pull could observe a concurrent change. The current cycle
> pulls first, reconciles, and pushes per-unit, and never discards authored work
> without the user's explicit choice.

---

## Server scope and CORS

A sync server is a **sync target for Docent clients**, not a consumer-facing read
API. Systems that consume recordings (an LLM/agentic pipeline, a code mapper, a
dashboard) SHOULD read from the server's underlying **storage** through their own
service, rather than calling these endpoints directly.

A compliant server therefore does **not** need to emit CORS headers: Docent's own
clients do not rely on the browser's cross-origin rules — the Chrome extension
uses its host permissions, and the desktop app issues requests natively rather
than through the webview. Adding permissive CORS (e.g.
`Access-Control-Allow-Origin: *`) to a server — especially one bound to localhost
or running without authentication — would let any website the user visits read
and overwrite their data from the browser. If you intentionally expose your
server to a trusted browser origin, you SHOULD scope CORS to that exact origin
and MUST NOT use `*` on an unauthenticated server.

---

## Authentication

**SP-2.** Authentication is optional. When the user configures an API key in
Docent, the client includes it as a Bearer token on every request:

```text
Authorization: Bearer <api_key>
```

When no API key is configured, the `Authorization` header is omitted entirely.

A server that does not require authentication MAY ignore this header. A server
that requires authentication SHOULD return `401` or `403` when the token is
missing or invalid — the client will halt the entire sync operation on either
status code (before any reconcile or push, so no local or durable state is
touched).

---

## Endpoints

The protocol uses three endpoints. They are unchanged from the legacy protocol —
the new reconciliation model is **entirely client-side** and adds no server-side
state, no new endpoints, and no new fields the server must understand.

### GET /projects

**SP-3.** Returns the project manifest — a JSON array listing all projects on
the server.

**Request:**

```http
GET /projects HTTP/1.1
Host: sync.example.com
Authorization: Bearer <api_key>
```

No request body. The `Authorization` header is present only when an API key is
configured.

This endpoint is also used by the client's **connection test**: a normal
successful response means the settings can reach the server; a `401`/`403` is
interpreted as an auth failure; a network or other error means unreachable. No
test-specific server support is required.

**Response (200 OK):**

```json
[
  {
    "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
    "name": "Expense report submission",
    "last_modified": "2026-05-10T18:30:00.000Z"
  },
  {
    "project_id": "019e2b4a-1234-7abc-9def-abcdef012345",
    "name": "Checkout flow",
    "last_modified": "2026-05-11T09:15:00.000Z"
  }
]
```

**Response fields (Project_Manifest entry):**

| Field           | Type              | Description                  |
| --------------- | ----------------- | ---------------------------- |
| `project_id`    | string (UUIDv7)   | Unique project identifier.   |
| `name`          | string            | Human-readable project name. |
| `last_modified` | string (ISO 8601) | Last modification timestamp. |

---

### GET /projects/:id

Returns the full data for a single project, including all recordings and their
complete step history.

**Request:**

```http
GET /projects/019e11fd-78ba-7fdb-8362-6fe9f697f641 HTTP/1.1
Host: sync.example.com
Authorization: Bearer <api_key>
```

No request body. The `Authorization` header is present only when an API key is
configured.

**Response (200 OK):**

Returns a `Full_Project_Payload` object (see [Payload Shapes](#full_project_payload)
below for the complete example).

---

### PUT /projects/:id

**SP-4.** Creates or updates a project on the server. The `:id` path
parameter MUST match the `project_id` inside the request body.

**Request:**

```http
PUT /projects/019e11fd-78ba-7fdb-8362-6fe9f697f641 HTTP/1.1
Host: sync.example.com
Content-Type: application/json
Authorization: Bearer <api_key>
```

The request body is a `Full_Project_Payload` object (see
[Payload Shapes](#full_project_payload) below). It is a **whole-project write**:
the client always sends the complete project (every recording, full step
history), and the server stores it verbatim, replacing any prior stored copy.
The client assembles the body per recording so that this whole-project write
never clobbers an un-reconciled server change and never omits a recording (see
[Push phase](#push-phase)) — but that assembly is invisible to the server, which
just stores what it receives.

The `Content-Type` header is always `application/json`. The `Authorization`
header is present only when an API key is configured.

**Response:**

The server SHOULD respond with `200 OK` when updating an existing project or
`201 Created` when storing a new project. The client treats any `2xx` status as
success and does not distinguish `200` from `201`, so the code is a recommended
create-vs-replace convention rather than a value the client depends on. The
response body is not consumed by the client — a minimal acknowledgment is
sufficient:

```json
{ "ok": true }
```

A server SHOULD reject a request whose body is not valid JSON, or whose
`project.project_id` does not match the path `:id`, with `400 Bad Request`,
leaving any stored project unchanged.

---

## Payload Shapes

### Full_Project_Payload

The canonical shape for a complete project with all its recordings and step
history. Used as the response body for `GET /projects/:id` and the request body
for `PUT /projects/:id`.

> **Note:** The sync payload carries the same `docent_format` stamp as a
> `.docent.json` export. A single server can hold projects from different Docent
> platforms (e.g. an extension project and a desktop project), and — once client
> auto-update is in play — clients on different schema versions. The stamp lets
> the pulling client identify each project's platform and schema version and
> validate or route it accordingly, instead of guessing. The server treats the
> payload as opaque — it stores and returns it verbatim and never reads the stamp.

The `schema_version` shown is illustrative, not the current version.

```json
{
  "docent_format": {
    "platform": "extension",
    "schema_version": "3.0.0"
  },
  "project": {
    "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
    "name": "Expense report submission",
    "created_at": "2026-05-10T13:04:44.730Z",
    "metadata": {
      "jira": "EXP-123",
      "tags": ["expenses", "submission"]
    }
  },
  "recordings": [
    {
      "recording_id": "019e12a4-0278-7c8e-aae6-01c26f002efb",
      "name": "Submit a new expense report",
      "created_at": "2026-05-10T16:06:38.968Z",
      "metadata": { "ticket": "EXP-456" },
      "steps": [
        {
          "uuid": "019e12a4-633d-74d2-acd5-584085fb57f9",
          "logical_id": "019e12a4-633d-74d2-acd5-584085fb57f9",
          "step_number": 1,
          "created_at": "2026-05-10T16:06:39.000Z",
          "narration": "Open the expense form and enter the report details",
          "narration_source": "typed",
          "actions": [
            {
              "type": "navigate",
              "timestamp": 1715353599000,
              "context_id": 1,
              "capture_mode": "dom",
              "nav_type": "typed",
              "url": "https://app.example.com/expenses"
            },
            {
              "type": "type",
              "timestamp": 1715353601000,
              "context_id": 1,
              "capture_mode": "dom",
              "element": {
                "tag": "INPUT",
                "id": "amount",
                "name": "amount",
                "role": "textbox",
                "type": "text",
                "text": null,
                "selector": "#amount"
              },
              "value": "129.99"
            }
          ],
          "deleted": false
        },
        {
          "uuid": "019e12a4-733d-74d2-acd5-584085fb5800",
          "logical_id": "019e12a4-733d-74d2-acd5-584085fb5800",
          "step_number": 2,
          "created_at": "2026-05-10T16:06:40.000Z",
          "step_type": "validation",
          "expect": "present",
          "actions": [
            {
              "type": "click",
              "timestamp": 1715353602000,
              "context_id": 1,
              "capture_mode": "dom",
              "x": 512,
              "y": 340,
              "element": {
                "tag": "BUTTON",
                "id": "submit-btn",
                "name": null,
                "role": "button",
                "type": "submit",
                "text": "Submit report",
                "selector": "#submit-btn"
              }
            }
          ],
          "deleted": false
        }
      ]
    }
  ]
}
```

**Top-level fields:**

| Field           | Type   | Required | Description                                                                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `docent_format` | object | yes      | Self-describing stamp `{ platform, schema_version }`. See [session format](../technical/session-format.md#format-stamp). |
| `project`       | object | yes      | Project metadata (see below).                                                                                            |
| `recordings`    | array  | yes      | Array of recording objects (see below).                                                                                  |

**Project fields:**

| Field        | Type              | Required | Description                                       |
| ------------ | ----------------- | -------- | ------------------------------------------------- |
| `project_id` | string (UUIDv7)   | yes      | Unique project identifier.                        |
| `name`       | string            | yes      | Human-readable project name.                      |
| `created_at` | string (ISO 8601) | yes      | Creation timestamp.                               |
| `metadata`   | object            | no       | User-defined key-value pairs. Omitted when empty. |

**Recording fields:**

| Field          | Type              | Required | Description                                                |
| -------------- | ----------------- | -------- | ---------------------------------------------------------- |
| `recording_id` | string (UUIDv7)   | yes      | Unique recording identifier.                               |
| `name`         | string            | yes      | Human-readable recording name.                             |
| `created_at`   | string (ISO 8601) | yes      | Creation timestamp.                                        |
| `metadata`     | object            | no       | User-defined key-value pairs. Omitted when empty.          |
| `steps`        | array             | yes      | Full step history including re-recorded and deleted steps. |

The `steps` array contains the **complete version history** — it is not filtered
to active steps only. See the [Docent Session Format](../technical/session-format.md)
documentation for the step structure (the per-platform schemas define it
authoritatively).

> **SP-5.** **Forward compatibility.** The client ignores any unrecognized top-level fields
> the server returns, so a future protocol version can add fields without
> breaking clients built against this specification. (The optional
> [conditional write](#optional-conditional-write) below adds no payload field —
> it rides entirely on HTTP headers.)

---

### Project_Manifest

The manifest is a JSON array returned by `GET /projects`. Each entry is a
lightweight summary used by the client to determine which projects to fetch.

```json
[
  {
    "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
    "name": "Expense report submission",
    "last_modified": "2026-05-10T18:30:00.000Z"
  },
  {
    "project_id": "019e2b4a-1234-7abc-9def-abcdef012345",
    "name": "Checkout flow",
    "last_modified": "2026-05-11T09:15:00.000Z"
  }
]
```

| Field           | Type              | Required | Description                                                      |
| --------------- | ----------------- | -------- | ---------------------------------------------------------------- |
| `project_id`    | string (UUIDv7)   | yes      | Unique project identifier. Used as `:id` in subsequent requests. |
| `name`          | string            | yes      | Human-readable project name.                                     |
| `last_modified` | string (ISO 8601) | yes      | Last modification timestamp.                                     |

---

## Response Codes

The client interprets the following HTTP status codes:

| Code | Meaning                                                            | Client behavior                                                                                                                       |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | OK — request succeeded                                             | Pull: payload snapshotted and reconciled. Push: project marked as pushed.                                                             |
| 201  | Created — new project stored                                       | Same as 200 (treated as success).                                                                                                     |
| 400  | Bad Request — invalid JSON body or path/body `project_id` mismatch | Server rejects the write; store unchanged. The client never sends such a request; a received 400 is non-fatal (skipped like 404/500). |
| 401  | Unauthorized — invalid or missing API key                          | Sync halted immediately. Error reported to user.                                                                                      |
| 403  | Forbidden — valid key but insufficient permissions                 | Sync halted immediately. Error reported to user.                                                                                      |
| 404  | Not found — project does not exist                                 | Error recorded for that project. Other projects continue.                                                                             |
| 500  | Internal server error                                              | Error recorded for that project. Other projects continue.                                                                             |

**Important:** A `401` or `403` response on any request (pull or push) causes the
client to halt the entire sync operation. A halt on the pull returns before any
reconcile or push runs, so all baselines, conflicts, and review items are
preserved exactly as they were. All other error codes are non-fatal — the client
skips the failing project and continues with the rest.

---

## Sync Behavior

**SP-6.** A sync cycle runs **pull → reconcile → push**, in that order. The ordering is the
whole point: pulling first lets the client observe a concurrent server change
before it pushes, which is the precondition for detecting a divergence rather
than overwriting it.

**SP-7.** Before any transport, three local protections apply (they block or
exclude, they do not merely warn):

- **Capture-active halt** — if a capture is running, no cycle starts.
- **Pending-actions safety halt** — a recording holding pending actions
  (actions captured but not yet committed into a step) is always protected:
  during capture, by the capture halt above; otherwise it MUST be locked
  (below), or the entire cycle halts (halt reason
  `pending-actions-unprotected`) rather than sync around it. This is the
  guarantee that uncommitted captured work is never reached by the later
  phases.
- **Locked recordings** — a recording open in the recording view is _locked_ and
  excluded from the inbound merge; every other unit still syncs.

### Pull phase

1. The client fetches `GET /projects` to retrieve the manifest.
2. For each entry, the client fetches `GET /projects/<project_id>` to retrieve the
   full payload.
3. **SP-8.** Each pulled payload is checked before it is accepted:
   - **Stamp compatibility** — the payload's `docent_format` MUST match the
     pulling client's platform and schema version. A project from a different
     platform, a different schema version, or with a missing stamp is **skipped
     and reported to the user** (not merged), with the reason (update the client
     or pin the producing version). A stamp-incompatible project is never turned
     into a conflict.
   - **Schema validation** — the payload MUST validate against the client's
     platform schema. An invalid payload is skipped and reported as an error
     (never as a conflict).
   - Both checks are per-project: one skipped project does not abort the pull.
4. Each accepted payload is landed into a retained **snapshot** rather than
   overwriting local data directly, so both the local version and the incoming
   version stay recoverable through reconciliation.

### Reconcile phase

**SP-9.** For every project and recording (the _units_), the client classifies
the unit by comparing three states: the **local** version, the **incoming**
(pulled) version, and the **baseline** — the last state this client and the
server mutually agreed on. Classification uses content equality (a canonical
digest of name, metadata, and full step history), not timestamps, because
`last_modified` is unreliable against an opaque store.

| Classification         | Condition                                                     | Outcome                                                                                                 |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Already-converged      | Incoming equals local                                         | Advance/repair baseline. Nothing to do.                                                                 |
| Brand-new              | No local counterpart and none in baseline                     | Auto-add the project/recording; record it in the baseline.                                              |
| Changed-local-outgoing | Local moved, incoming still equals baseline                   | Auto-push the local version (see [Push phase](#push-phase)).                                            |
| Changed-incoming       | Local equals baseline, incoming moved                         | Hold for **review-and-accept** (or auto-apply a fast-forward if the user opted in).                     |
| Diverged               | Both local and incoming differ from baseline (or no baseline) | Record a **conflict**; defer to the user.                                                               |
| Deletion case          | A unit present in baseline is absent on one side              | Propagate an agreed deletion, hold a server deletion for review, or record a delete-vs-change conflict. |

Key rules:

- **Safe outcomes are automatic** — adding brand-new units, advancing the
  baseline on agreement, and pushing changed-local-outgoing units never require
  user interaction.
- **Adopting an incoming change into an existing recording is always user-gated**
  — it happens only through review-and-accept (or the explicit conflict-resolution
  workflow), never silently. (Two opt-in client-local settings can auto-apply a
  fast-forward update or a server deletion of a unit the user has not changed, but
  these never auto-resolve a divergence.)
- **No silent data loss** — a local or incoming version is discarded only as the
  explicit outcome of resolution. Deferred units leave local data untouched.
- **Durable and idempotent** — conflict and review state persists across restarts
  and never multiplies across repeated syncs.
- **SP-10.** **Baseline advances only on confirmed agreement or adoption, never on push.** A
  push is not proof of agreement (a concurrent client may overwrite it first), so
  the baseline advances only when a later pull confirms incoming equals local, or
  when the user adopts a change. On adoption it advances to the **resolved-against
  incoming version**, so the adopted state is re-validated against the server (and
  re-detected as a conflict if another client moved it) on the next cycle.

A locked recording is skipped in this phase entirely: its incoming changes are
neither applied nor offered until it is closed.

#### What causes a conflict that must be resolved

**SP-11.** A **conflict** — the only outcome that forces the user to choose
between two versions — arises in exactly two situations. Everything else reconciles
automatically or is held as a non-blocking **review**.

A conflict is recorded when, for a single unit (a project's own
name+metadata, or one recording):

1. **Diverged — both sides changed.** The unit's content differs from the
   baseline on _both_ the local and the incoming side (and the two sides are not
   identical to each other). Neither change can be applied without discarding the
   other, so the user picks which version to keep.
   - The no-baseline case counts here too: if there is no agreed baseline for the
     unit and local ≠ incoming, the change cannot be attributed to one side, so it
     is treated as diverged.
2. **Delete-vs-change.** The unit existed in the baseline, and one side **deleted**
   it while the other side **changed** it. Deleting and editing are
   irreconcilable, so the user chooses delete or keep-the-change.

Because content identity is a canonical digest of **name + metadata + full step
history**, _any_ of those changing on both sides triggers a conflict — there is
nothing special about steps. Worked examples (all verified against the
classifier):

| Local change            | Incoming (server) change          | Result                            |
| ----------------------- | --------------------------------- | --------------------------------- |
| Edit recording steps    | Edit the same recording's steps   | **Conflict** (recording diverged) |
| Add recording metadata  | Rename the same recording         | **Conflict** (recording diverged) |
| Rename a recording      | Different rename, same recording  | **Conflict** (recording diverged) |
| Change project metadata | Different project-metadata change | **Conflict** (project diverged)   |
| Edit a recording        | Delete that recording             | **Conflict** (delete-vs-change)   |
| Delete a recording      | Edit that recording               | **Conflict** (delete-vs-change)   |

What is **NOT** a conflict (resolves without a forced choice):

- **Only one side changed.** A change on only the local side is auto-pushed
  (`changed-local-outgoing`); a change on only the incoming side is held as a
  **review** (`changed-incoming`) — a non-blocking prompt to accept, not a
  conflict. (With the opt-in "Auto-accept updates" setting, an append-only
  fast-forward review is applied automatically; it never auto-resolves a
  divergence.)
- **Both sides made the identical change.** Already-converged — the baseline is
  advanced, nothing to do.
- **Brand-new unit** on either side — auto-added.
- **Agreed deletion** — a unit deleted on one side and unchanged on the other is
  propagated (a server-side deletion of an unchanged unit is a **review**, not a
  conflict, unless "Auto-accept deletions" is on).
- **Same-metadata / same-rename on both sides** — identical content is convergence,
  not divergence.

The throughline: a conflict requires **two competing changes to the same unit**
(or a delete racing a change). One-sided changes, identical changes, and brand-new
units never force a choice.

#### What results in a non-blocking review

A **review** (review-and-accept) is the softer counterpart to a conflict: the
server has a change to a unit you have **not** touched locally, so there is no
competing local edit to weigh against it. Nothing is lost either way, so it is
surfaced as a non-blocking prompt — accept the incoming version, or decline to
keep your (unchanged-since-baseline) local one — rather than a forced choice. A
pending review never blocks the rest of the cycle, and the unit is never changed
until you act.

A review is recorded when, for a single unit (a project's own name+metadata, or
one recording), the **local side still equals the baseline** while the
**incoming side moved**:

1. **Changed-incoming.** Local content equals the last-agreed baseline; the
   server's version differs. The incoming change is held for accept/decline.
2. **Server deletion of an unchanged unit.** The unit existed in the baseline,
   the server deleted it, and your local copy is unchanged from the baseline. The
   deletion is held for review (accept the deletion, or keep your copy) rather
   than applied silently.

Worked examples (all verified against the classifier):

| Local side               | Incoming (server) change        | Result                           |
| ------------------------ | ------------------------------- | -------------------------------- |
| Unchanged since baseline | Recording's steps edited        | **Review** (changed-incoming)    |
| Unchanged since baseline | Recording renamed               | **Review** (changed-incoming)    |
| Unchanged since baseline | Recording metadata changed      | **Review** (changed-incoming)    |
| Unchanged since baseline | Project metadata changed        | **Review** (changed-incoming)    |
| Unchanged since baseline | Recording deleted on the server | **Review** (accept the deletion) |

Two opt-in, client-local settings turn specific reviews into **silent
auto-applies** (they change only what happens to a review — they never touch a
conflict):

- **SP-12.** **Auto-accept updates** — a `changed-incoming` review is applied automatically
  **only** when the incoming version is an _append-only fast-forward_ of your
  baseline: it strictly adds new step records, dropping none of the baseline's
  records (retention is checked by record identity), **and changes nothing
  else** — same name, same metadata. A change that drops or replaces step
  records, renames the unit, or edits metadata still becomes a review even with
  this on (a step append is lossless to adopt silently; a rename of a unit you
  may have open is a separate, surprising change).
- **Auto-accept deletions** — a server deletion of a unit you have not changed is
  applied automatically instead of being held for review.

Neither setting ever auto-resolves a **divergence**: if your local copy also
moved from the baseline, it is a conflict regardless of these toggles.

What is **NOT** a review:

- **You changed it too** — that is a conflict (diverged), not a review.
- **You changed it, the server didn't** — auto-pushed (`changed-local-outgoing`),
  no prompt.
- **Brand-new or agreed/identical** — auto-added or converged, nothing to review.

### Push phase

Push runs **only after** the pull and reconcile phases of the same cycle complete
without halting. A unit in an unresolved conflict or pending review is **never
pushed**; a resolved/accepted unit is pushed only on a _subsequent_ cycle (which
begins with a fresh pull, so a concurrent server change is re-detected rather than
overwritten).

**SP-13.** Because the server only offers a whole-project `PUT`, the client
assembles each project's payload **per recording**:

- A recording that is **pushable** — clean brand-new-local, changed-local-outgoing,
  already-converged, or an auto-applied incoming version — is sent at its **local**
  version, so the local edit reaches the server.
- A recording that is **deferred** (review or conflict) or **locked** is sent at
  the version most recently **agreed-or-pulled** for it (its snapshot version when
  it was pulled this cycle, otherwise its baseline version) — **not** its
  un-reconciled local edits. This keeps the whole-project write from clobbering a
  concurrent server change the client has not reconciled.
- **No recording is ever omitted.** Every recording present in the project is
  emitted; only its _version_ is swapped for the deferred/locked ones. Omitting a
  recording would read to other clients as a deliberate deletion (the data model
  has no recording-level tombstone). The project-metadata unit is treated the same
  way: a project-level deferral sends the agreed-or-pulled metadata.
- A propagated or auto-applied **deletion** is already absent from the assembled
  project, so it is correctly not re-sent — the deletion propagates rather than
  being resurrected.

A project with **nothing to write** is skipped rather than re-sending an unchanged
payload. "Nothing to write" is decided by **content**: a project is
skipped when every assembled unit's wire-version is content-identical (by
canonical digest) to the server's agreed-or-pulled version of that unit, so the
`PUT` would only re-send the server's own bytes. This covers a project
auto-added from the server this cycle, a fully-converged project, a project whose
only change is a deferred Review/Conflict (sent at the agreed-or-pulled version),
and a project whose only non-converged unit is a **locked** recording — its live
local edits are held back at the agreed-or-pulled version this cycle and reach the
server only on a later cycle, after the recording is unlocked and reconciled (no
authored work is lost). Push reads only committed `recording.steps`; uncommitted
captured actions live in a separate store and never enter the payload.

Push never advances the baseline.

---

## Known limitation: the last-write-wins window

In its baseline form the server is an opaque **last-write-wins** blob store:
every `PUT /projects/:id` is accepted unconditionally and overwrites whatever
was stored. A server without the optional
[conditional write](#optional-conditional-write) has no way to reject a write
that is based on a stale read.

Pull-then-push **narrows but does not fully eliminate** the overwrite window.
Between a client's pull and its push, another client can still write, and
the opaque server will accept the later write. The pull-first ordering bounds the
_consequence_ — no client's own committed local work is permanently lost, because:

- the divergence is detected on the _next_ cycle's pull (the late writer's change
  now differs from both this client's local version and its baseline, so it is
  classified as a conflict and surfaced), and
- a deferred unit is never pushed over an un-reconciled server change.

So the residual window can cause a redundant round-trip and a deferred conflict,
but not silent data loss.

Eliminating the window entirely requires **server-side optimistic concurrency
control** — a conditional write where the client sends the version it based its
edit on and the server rejects the write if its stored version has moved. The
protocol defines exactly that as the **optional
[conditional write](#optional-conditional-write)** below
([docent#152](https://github.com/Arsarneq/docent/issues/152) delivered its
server half; the reference server implements it). The shipped clients do not
yet send `If-Match`, so today the window **closes** only for a client that opts
in against a server implementing the capability; for everyone else the
pull-first ordering keeps narrowing it as described above.

---

## Optional conditional write

**SP-14.** A server MAY implement optimistic concurrency as follows. When the
`If-Match` request header is absent the server behaves as the plain
last-write-wins store above — the capability has no effect on clients that do not opt in, and a
server without it remains fully conformant.

- **ETag advertisement** — a successful `GET /projects/:id` and a successful
  `PUT /projects/:id` return an `ETag` header derived deterministically from the
  stored payload's content only (never from `last_modified`): two reads of the
  same unchanged project return the same value, and any change to the content
  yields a different one.
- **`If-Match` on `PUT /projects/:id`:**

| `If-Match` on the `PUT`                                              | Behavior                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Absent                                                               | Last-write-wins: the payload is stored per the normal `PUT` rules, regardless of the current ETag. |
| Present and matches the stored ETag                                  | The write proceeds (`200`/`201`) and returns a fresh `ETag`.                                       |
| Present and does **not** match (including when no project is stored) | `412 Precondition Failed`; the store is left unchanged.                                            |

The [reference server](../../reference-implementations/sync-server/README.md)
implements this capability; the shipped clients do not yet send `If-Match`.

---

## Implementation Notes

- The server stays **opaque and unchanged**. It stores the `Full_Project_Payload`
  as-is and returns it verbatim; it holds no conflict, baseline, or version state.
  All reconciliation — baseline tracking, classification, snapshot retention, and
  conflict resolution — is **client-side**. A compatible
  server needs only the three endpoints above.
- The client sends the complete project state on every push — there is no
  incremental/delta sync.
- The `last_modified` field in the manifest is informational. The client does not
  use it for conditional fetching or for classification (which relies on content
  equality, since `last_modified` is unreliable against an opaque store).
- The `metadata` field on projects and recordings is optional and may be absent
  from the payload. Treat missing `metadata` as an empty object.
- The `steps` array may be empty for recordings that have no captured steps yet.
- IDs use UUIDv7 format (time-ordered), but the server does not need to validate
  or generate them — they are always provided by the client.
- The server does not need to understand the internal structure of steps or
  actions. It stores and returns them verbatim.
- The `docent_format` stamp is part of the stored payload. The server treats it as
  opaque — it does not read or validate it. Only the pulling client uses it (to
  identify the platform/schema version and validate the payload before reconciling).
- A server MAY add optional top-level fields; the client ignores unrecognized
  fields, so this is non-breaking. (The optional
  [conditional write](#optional-conditional-write) needed none — it rides on
  HTTP headers.)

> **Working example.** For a small, runnable implementation of this contract, see
> the [Reference Sync Server](../../reference-implementations/sync-server/README.md).
