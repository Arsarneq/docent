# Docent Session Format

The `.docent.json` format is Docent's contract with anything that consumes a
recording. It is defined per platform by independently versioned JSON Schemas —
the authoritative source of truth for the format. This document is the
companion prose that orients a reader in both schemas, with annotated
examples.

Each rule this document makes in its own right carries a stable identifier
(**SF-n**) so other documents, reviews, and checks can cite it precisely.
Identifiers are never renumbered; a retired identifier stays reserved and is
never reused. How each rule is verified — by an existing named check, by a
check that could be built, or by judgment — is recorded per rule in the
[clause registry](../clause-registry.json). The key words MUST, MUST NOT,
SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and can appear out of numeric sequence.

**SF-1.** Where this prose and a schema disagree, the schema governs.

The format is not Docent's only external contract: sync servers implement the [Sync Protocol](../api/sync-protocol.md)
and treat this format as an opaque payload, and dispatch endpoints receive it
inside the [Dispatch Protocol](../api/dispatch.md)'s payload wrapper. All of
Docent's external contracts
are data — versioned schemas and documented protocols — never shipped code or
a shipped consumer. What a recording must be sufficient _for_ is defined by
the [Replay Sufficiency](../requirements/replay-sufficiency.md) principle.

---

## Overview

A `.docent.json` file describes a project containing one or more recordings.
Each recording contains an ordered list of steps. Each step pairs either a
free-text narration or a structured action/validation classification with the
exact user interactions captured during that step.

The format is platform-specific. The Chrome extension and the Windows desktop
application each produce a slightly different schema (different action types,
different fields). Both are documented here.

---

## Versioning

Schemas are versioned independently per platform:

<!-- VERSION_TABLE_START -->

| Schema file                                | Platform          | Current |
| ------------------------------------------ | ----------------- | ------- |
| `schemas/dist/extension.schema.json`       | Chrome Extension  | 3.0.0   |
| `schemas/dist/desktop-windows.schema.json` | Desktop (Windows) | 2.0.0   |

<!-- VERSION_TABLE_END -->

**SF-2.** **Version bumps** are determined **mechanically at release time** by
[`scripts/auto-version-schemas.js`](../../scripts/auto-version-schemas.js), which diffs the last
released schema (`schemas/dist/<platform>.schema.json`) against the schema composed from the current
source layers and classifies the change, through
[`scripts/classify-schema-change.js`](../../scripts/classify-schema-change.js), into exactly one of
three levels — that classifier is the complete statement of which change takes which level, and the
kinds below name each level's:

- **Patch** (x.x.1): documentation-only changes (description clarifications)
- **Minor** (x.1.0): new optional fields, new action types, new enum values on existing fields, pure type widenings (the old accepted type set is kept and extended — e.g. a string field additionally allowing null), and `additionalProperties` relaxations (a closed object opting to accept unknown keys)
- **Major** (1.0.0): new required fields, removed or renamed fields, changed semantics, changed or narrowed types, removed enum values, added/removed/changed value constraints, and any change to a field's required status in either direction (a field no longer guaranteed present changes what a consumer may rely on)

**SF-3.** `x-`-prefixed keys on schema definitions are **annotations** — machine-read
contract markers, not validation keywords (validators ignore them; `x-value-derived` below
is one). Introducing an annotation the classifier knows documents behaviour that already
ships (patch); changing or removing one, or introducing a kind the classifier has never
judged, rewrites what the contract says and escalates to major. A kind enters the
classifier's known set only together with a drift guard that pins the annotation against
the behaviour it documents — for `x-value-derived`, the per-platform guards pin it against
the real redaction code.

**SF-4.** The classifier is intentionally conservative: anything it cannot
confidently place as patch or minor is escalated to **major**, so a release can
never silently under-version a breaking change. Contributors MUST NOT bump
versions by hand during development — the release pipeline does it. (A level for a
semantic change the structural diff cannot see — same shape, changed meaning —
is forced with `scripts/bump-schema.js`, a release-time tool: it refuses to run
outside a release context, and the release-output guard refuses its output on a
feature branch, so the forced level is applied at release time, never ahead of
it.)

The base (`schemas/shared.schema.json`) and the desktop-family layer
(`schemas/desktop.shared.schema.json`) are not versioned independently — the
`version` lives in each per-surface leaf (`schemas/<surface>.delta.json`). A
change to the base or a family layer is reflected in every published schema it
feeds, and each is versioned according to its own resulting diff.

### Schema version pinning

The Chrome extension is distributed via the Chrome Web Store, which pushes
updates automatically. There is no built-in mechanism to hold the emitted schema
version back when a new release bumps it — the extension always emits the schema
version it ships with.

**Desktop** users are unaffected: the desktop app has no auto-updater (it is
intentionally disabled — there is no updater plugin configured), so you control
which binary you run and can stay on any version indefinitely.

**Extension** users whose downstream consumers depend on a specific schema
version can pin by installing from source instead of the Chrome Web Store.
Follow the [development installation steps](../../README.md#installation-development),
but check out the tag that produces the schema version you need before syncing
and loading:

```bash
git checkout extension-v2.0.0   # or any release tag
```

Chrome will not auto-update an unpacked extension. When you are ready to adopt a
newer schema version, check out the corresponding tag and reload.

Pre-release tags (`extension-vX.Y.Z-rc.N` / `desktop-vX.Y.Z-rc.N`) are **beta
builds** that commit no schema version bump: the candidate's artifact carries
the schema version the release tooling computes for it (a preview of the next
release's), while the committed version stays as it was — the publishing guide's
[pre-release section](../../.github/PUBLISHING.md#pre-release-rc-builds) owns
the rule. Pin to a **final** release tag, not a pre-release.

Every exported file carries the `docent_format` stamp, so a consumer can always
detect which schema version produced a file and fail loudly on a mismatch rather
than silently misinterpreting data.

---

## Dispatch payload structure

When Docent dispatches to a configured endpoint, the HTTP POST body wraps the
schema-governed data in additional fields. That wrapper's defining
specification — its fields, the transport contract around it, and the
obligation that the shipped `reading_guidance` prose track the schemas — is
the [Dispatch Protocol](../api/dispatch.md). The `.docent.json` export file
contains `docent_format`, `project`, and `recordings` (no `reading_guidance`
or `schema` wrapper).

---

## Format stamp

Every `.docent.json` export and every dispatch payload carries a required
`docent_format` object at its root — for example (the `schema_version` shown is
an example value; the composed schema's `docent_format` const, not this page,
states the current one):

```json
{
  "docent_format": {
    "platform": "extension",
    "schema_version": "3.0.0"
  }
}
```

| Field            | Type   | Required | Description                                                                    |
| ---------------- | ------ | -------- | ------------------------------------------------------------------------------ |
| `platform`       | string | yes      | Which Docent platform produced the file (e.g. `extension`, `desktop-windows`). |
| `schema_version` | string | yes      | The schema version the file conforms to.                                       |

**SF-7.** The stamp makes every file self-describing: a consumer can pick the
correct schema and route migrations without inspecting the contents or
guessing. In each published schema both values are fixed as `const`, so the
stamp is validated, not just carried — a file whose stamp does not match a schema's platform/version will
not validate against it. (Docent's own test and verification harnesses relax the
`schema_version` `const` to validate recordings by _shape_ across schema versions
— a harness-local convenience that never weakens the published contract a
consumer receives.) The values are sourced from the schema itself (the single
source of truth), never hand-written.

---

## Project

```json
{
  "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
  "name": "Expense report submission",
  "created_at": "2026-05-10T13:04:44.730Z",
  "metadata": {
    "jira": "EXP-123",
    "tags": ["expenses", "submission"]
  }
}
```

| Field        | Type     | Required | Description                                                            |
| ------------ | -------- | -------- | ---------------------------------------------------------------------- |
| `project_id` | UUIDv7   | yes      | Time-ordered unique identifier.                                        |
| `name`       | string   | yes      | Human-readable project name.                                           |
| `created_at` | ISO 8601 | yes      | Creation timestamp.                                                    |
| `metadata`   | object   | no       | User-defined key-value pairs. Values are strings or arrays of strings. |

---

## Recording

```json
{
  "recording_id": "019e12a4-0278-7c8e-aae6-01c26f002efb",
  "name": "Submit a new expense report",
  "created_at": "2026-05-10T16:06:38.968Z",
  "metadata": { "ticket": "EXP-456" },
  "steps": [ ... ]
}
```

| Field          | Type     | Required | Description                                                            |
| -------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `recording_id` | UUIDv7   | yes      | Time-ordered unique identifier.                                        |
| `name`         | string   | yes      | Human-readable recording name.                                         |
| `created_at`   | ISO 8601 | yes      | Creation timestamp.                                                    |
| `metadata`     | object   | no       | User-defined key-value pairs. Values are strings or arrays of strings. |
| `steps`        | array    | yes      | Full step history (see below).                                         |

---

## Steps

The `steps` array contains the **full version history** of all steps in the
recording. This includes re-recorded versions and soft-deleted steps.

**SF-8.** To resolve the "active" view (what the user last committed):

1. Group steps by `logical_id`
2. Within each group, take the step with the latest `uuid` (UUIDv7 is time-ordered)
3. Exclude steps where `deleted: true`
4. Sort by `step_number`

**SF-9.** The step history is append-only: a producer MUST NOT edit a version
record in place. Every mutation appends a new record with a fresh `uuid` — for
example, a re-record appends the replacement version; a deletion appends a
**tombstone**, a full copy of the last active version with a fresh `uuid`, a
fresh `created_at`, and `deleted: true` (content preserved, so history stays
recoverable); a reorder appends new records only for the steps whose
`step_number` changed.

The history and its tombstones are the recording's audit trail: every version
that was committed and every change made to it, in the order it happened.
Docent never prunes that trail — which parts of a record stop being worth
keeping is an opinionated call about someone else's work, and the format does
not make it. The consequence is disclosed rather than designed away: a
long-lived recording's history can grow past the size the validated ingestion
paths accept — import, and the sync pull (both scoped in
[Import acceptance](#import-acceptance)) — so a file can be exportable and
still not accepted back. That bound is a safety valve on ingestion, not a
bound on the format.

### Step modes

A step is either **narration mode** or **simple mode**. At least one of
`narration` or `step_type` must be present.

**Narration mode** — free-text description of intent:

```json
{
  "uuid": "019e12a4-633d-74d2-acd5-584085fb57f9",
  "logical_id": "019e12a4-633d-74d2-acd5-584085fb57f9",
  "step_number": 1,
  "created_at": "2026-05-10T16:06:39.000Z",
  "narration": "Open the expense form and enter the report details",
  "narration_source": "typed",
  "actions": [ ... ],
  "deleted": false
}
```

**Simple mode** — structured action/validation classification:

```json
{
  "uuid": "019e12a4-733d-74d2-acd5-584085fb5800",
  "logical_id": "019e12a4-733d-74d2-acd5-584085fb5800",
  "step_number": 2,
  "created_at": "2026-05-10T16:06:40.000Z",
  "step_type": "validation",
  "expect": "present",
  "actions": [ ... ],
  "deleted": false
}
```

### Step fields

| Field              | Type                         | Required | Description                                                                                             |
| ------------------ | ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `uuid`             | UUIDv7                       | yes      | Unique version identifier. Later UUID = newer version.                                                  |
| `logical_id`       | UUIDv7                       | yes      | Groups versions of the same step.                                                                       |
| `step_number`      | integer ≥ 1                  | yes      | Display order.                                                                                          |
| `created_at`       | ISO 8601                     | yes      | When this version was created.                                                                          |
| `narration`        | string (min 1 char)          | one of   | Free-text intent description. Present in narration mode.                                                |
| `narration_source` | `"typed"`                    | no       | How narration was provided. Written at capture alongside narration; the pairing is not schema-enforced. |
| `step_type`        | `"action"` \| `"validation"` | one of   | Step classification. Present in simple mode.                                                            |
| `expect`           | `"present"` \| `"absent"`    | no       | Assertion type for validation steps.                                                                    |
| `actions`          | array                        | yes      | Captured user interactions.                                                                             |
| `deleted`          | boolean                      | yes      | Soft-delete marker.                                                                                     |

"one of" means at least one of `narration` or `step_type` must be present.

---

## Actions

Every action has:

| Field          | Type            | Description                                      |
| -------------- | --------------- | ------------------------------------------------ |
| `type`         | string          | Action type identifier.                          |
| `timestamp`    | integer         | Unix milliseconds when the action occurred.      |
| `context_id`   | integer \| null | Session-scoped window/tab identifier.            |
| `capture_mode` | string          | How the action was captured (platform-specific). |

**SF-10.** Contexts are introduced in order: reading the full step history's
actions in serialization order, every non-null `context_id` is either the
recording's initial context (the first one observed) or first appears on a
`context_open` or `context_switch` action. A context that materializes mid-stream on any other
action type has no introduction, and the recording fails the sufficiency
lint's fail-class `context-introduced` check
([static sufficiency lint](../verification/sufficiency-lint.md), implemented
by [`scripts/sufficiency-lint.js`](../../scripts/sufficiency-lint.js)).

The rule is stated over the **full** step history — superseded and
soft-deleted versions included — because the history stays recoverable: a
version that can be read later must be as well-formed as one read today. The
resolved active view ([SF-8](#steps)) is a projection a consumer applies, and
it lies outside this rule's domain rather than inside it as a narrower case:
satisfying the rule over the full history makes no claim about the projection,
whose introducing action a later deletion can remove.

### Platform-specific fields

**Extension only:**

- `frame_src` (string \| null) — iframe URL, or null for the top frame; absent on the actions the extension's worker records (`navigate` and the context lifecycle) — a departure for `navigate`, always a top-frame navigation whose null the worker could write (core CP-18).

**Desktop (Windows) only:**

- `window_rect` (object \| null) — window position/size `{x, y, width, height}` in physical screen pixels, resolved from the action's window handle regardless of capture mode; null when no window handle was resolvable, the rectangle could not be read, or it read as empty (a read rectangle left unwritten — a departure; core CP-18).

**Coordinate spaces:** each coordinate and scroll-geometry field's space and unit is stated by its schema description — in summary, extension `x`/`y` are viewport coordinates of the capturing frame (CSS pixels), and desktop `x`/`y` are physical screen pixels, the same space as `window_rect`.

### Capture modes

| Platform  | Values            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension | `"dom"`           | Always DOM-based capture.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Desktop   | `"accessibility"` | Native UI Automation API. Full element description.                                                                                                                                                                                                                                                                                                                                                                                                |
| Desktop   | `"coordinate"`    | Fallback: no specific control resolved at the point. The element describes the container the point fell in — the window or generic pane that resolved (its control type, `Window` or `Pane`, with its tree path) — or carries `tag: "unknown"` with a `coord:x,y` selector when nothing did; either way it makes no element-identity claims (no locators, no provider facts, no describe latency; the field set this mode leaves out, core CP-18). |

---

## Action types

### Shared (both platforms)

Where the base schema's `description` stays platform-neutral, these rows carry
the per-platform meaning.

| Type             | Key fields                                                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `click`          | `x`, `y`, `element`                                          | Left-click on an element; the desktop also records a middle-button press as a `click` (DCP-10), an input the extension does not capture (ECP-12). The extension's `element` is the clicked element or its nearest interactive ancestor: an `a`, `button`, `label` or `select`, an element with role `button`, `option`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `listitem`, `tab`, `checkbox`, `radio`, `switch`, `treeitem` or `gridcell`, or an `input` of type submit, button, checkbox, radio or reset (core CP-18). On the extension a click picked on the body or the document element is not written — a departure the extension capture document lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `right_click`    | `x`, `y`, `element`                                          | Right-click on an element; the extension picks its `element` as for `click`, and writes nothing when that element is the body or the document element — a departure the extension capture document lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `type`           | `element`, `value`                                           | Text entered into a field. Sensitive values (passwords, credit-card/SSN/secret fields) are masked as `"••••••••"` and the element flagged `redacted`. On the extension an input's or textarea's `value` is written whole, a contenteditable's is trimmed and cut at 500 characters with no mark; on the desktop `value` is the element's text — its accessibility Value, else its Name, so an emptied field records its label — cut at 100 characters with a truncation mark; [docent#238](https://github.com/Arsarneq/docent/issues/238) holds each cut as a defect, the entered value being the fact the format carries rather than a described text (core CP-18). On the extension the `type` is not written after a same-form submit press, a departure the extension capture document lists; a checkbox or radio change writes a `type` whose value is the control's `value` attribute, not its checked state — a departure (core CP-18); on the desktop a value equal to the worker's last for the same selector (for a password field, every entry after the first), or a change on an element the accessibility layer cannot describe, is not written — departures the desktop capture document lists.                                                                                                                                                                                                                       |
| `select`         | `element`, `value`                                           | Option selected from a dropdown/list. On the extension `value` is the text of the first selected option (a multiple select's other selected options are not written), else the control's `value`. On the desktop the element and `value` come from the first that applies: for a focused list, combo box, tree or data grid, the first item of its current selection (its UIA Name as `value`), else that container with its name; for any other focused element, the element with its text; when the focused element could not be described, the first item of the selection the accessibility layer still reports on it; else a constructed stand-in (`tag` `ListItem`, `role` `listitem`, empty `selector`, the window title as `name`) with an empty `value` — a departure, its tag and role not observed facts (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `key`            | `key`, `modifiers`, `element`                                | Keyboard input. `modifiers`: `{ctrl, shift, alt, meta}`. `key` is the browser's key value on the extension; on the desktop it is derived from the virtual-key code — a letter or digit by its code (letters uppercase whatever the shift state), a punctuation key by one US-layout character whatever the active keyboard layout, a numeric-keypad key by a `Numpad` name (`Numpad0`–`Numpad9`, `Multiply`, `Add`, `Subtract`, `Decimal`, `Divide`), a control key by its standard name, an unmapped code as `VK_0x..` — a departure from the character-value rule the schema states (core CP-18). When nothing is focused on the desktop, or the focused element could not be described, the element is a constructed stand-in (`tag` `Unknown`, empty `selector`, the window title as `name`) written under `capture_mode: accessibility` — a departure (core CP-18). On the extension a captured key other than Tab is not written while nothing is focused, a departure the extension capture document lists; a Tab on the body carries a `body` element with no locators, and on the desktop a Space inside a typing burst flushes the pending `type` and stands as a `key` between two `type` actions — departures (core CP-18); a keystroke injected as Unicode is written on the desktop as a `key` beside the coalesced `type` — a departure from core CP-1 ([docent#260](https://github.com/Arsarneq/docent/issues/260)). |
| `focus`          | `element`                                                    | Element received focus (non-redundant cases only). On the extension a focus is written without the trust test the other listeners apply — a departure from core CP-1 — and the focus of a password field is not written, a departure from core CP-11 the extension capture document lists; on the desktop a focus whose selector equals the worker's last, or on an element the accessibility layer cannot describe, is not written — departures the desktop capture document lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `drag_start`     | `element`                                                    | Drag operation began. On the desktop, when no control resolves at the point, the element is the coordinate-mode fallback (`tag` `unknown`, selector `coord:x,y`) written under `capture_mode: accessibility` — a departure (core CP-18). The desktop pair's `context_id` and `window_rect` are the release point's window, and `drag_start`'s `timestamp` is the release moment — departures (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `drop`           | `x`, `y`, `element`, `source_element`                        | Drop completed. On the desktop the element falls back as for `drag_start` — a departure (core CP-18); on the extension a drop is written without the trust test while a drag is in flight — a departure from core CP-1. `source_element` is the dragged item; null when no drag start was observed for it (a drag begun before recording, or outside the capturing document or worker).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `scroll`         | `element`, `scroll_top`, `scroll_left`, `delta_y`, `delta_x` | Scroll gesture (debounced). `delta_y`/`delta_x` carry the sequence's net displacement (core CP-16); the extension reads its start offset from the first scroll event's target, after that event's movement, and its end offset from the last event's target, so the first increment is not included and a sequence that moves across containers subtracts two targets' offsets — a departure from the quantity core CP-16 names ([docent#251](https://github.com/Arsarneq/docent/issues/251)). The extension writes a scroll without a trust or input test — a departure from core CP-1 ([docent#224](https://github.com/Arsarneq/docent/issues/224)); the desktop writes `scroll_top` and `scroll_left` as 0 and `element` as null, identifying no scrolled container ([docent#228](https://github.com/Arsarneq/docent/issues/228)), and a scroll its timer flushes carries `context_id` and `window_rect` as null and the flush time as its `timestamp` ([docent#225](https://github.com/Arsarneq/docent/issues/225)) — departures (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                   |
| `context_switch` | `source`, `title`                                            | User switched to a different window/tab; on the extension a switch between browser windows records no action (ECP-12). `source` is the tab URL on the extension; on the desktop the process executable name, or `pid:<n>` when the process cannot be read. `title` is the tab title on the extension (null when the browser reports none; an empty title passes through as an empty string) and the window title on the desktop (null when empty; read, as the executable path behind `source` is, into a 512-unit buffer, so at most 511 UTF-16 units; a longer executable path leaves a fragment of it as the name — core CP-18). On the desktop the two foreground activations core CP-17 calls cascades — the activation of a window whose `context_open` the same action records, and the system's activation of an already-introduced window after a close — are written as `context_switch` — a capture gap against core CP-17, as the desktop capture document states. On the extension the first activation of a tab opened in the background, when no tab was created after it, and the activation of a tab with no address are not written — departures the extension capture document lists; the activation of a `chrome://` or `chrome-extension://` tab is not written, an exception that document lists.                                                                                                              |
| `context_open`   | `opener_context_id`, `source`                                | New window/tab opened. `opener_context_id` is the opening tab's id on the extension when the browser reports one, else null; always null on the desktop. `source` is the tab URL (or null) on the extension; on the desktop the process executable name (`pid:<n>` when the process cannot be read; the read is `context_switch`'s), or null when it is empty (core CP-18). On the extension no `context_open` is written for a tab created within 500 ms after an in-page action — for a tab the page opened, a capture gap against core CP-17 ([docent#252](https://github.com/Arsarneq/docent/issues/252)); for a tab the user opened, a departure the extension capture document lists; `source` is null where the browser reported only a pending URL — a departure (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `context_close`  | `window_closing`                                             | Window/tab closed. `window_closing` is false on the extension (a tab closed within a surviving window; a whole-window close records no action) and true on the desktop, where the context is the window. On the extension the close of a tab created within 500 ms after an in-page action is not written when it comes within 2000 ms after an in-page action — an exception the extension capture document lists, with the departure it marks for a tab the user opened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Extension only

| Type          | Key fields         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`    | `nav_type`, `url`  | Page navigation. `nav_type` is one of the schema's closed set: `link`, `typed`, `reload`, `back_forward`, `spa`, `auto_bookmark`, `generated`, `start_page`, `form_submit`, `keyword`; it is derived from the browser's transition type, a back/forward qualifier taking precedence over the type it rides on (core CP-18). Values of known-sensitive query parameters in `url` (authentication and session tokens, keys and secrets, passwords, one-time codes, signatures) are masked; the schema's `url` description enumerates the exact parameter names. The masking re-serializes the whole query as `application/x-www-form-urlencoded` once any name matches — names and values re-encoded with only alphanumerics and `*-._` left bare, spaces as `+`, an escaped unreserved character decoded, a bare flag gaining `=`, repeated masked pairs collapsing, the mask itself encoded — a departure (core CP-18). A navigation the server or the page redirected is not written, a departure the extension capture document lists; a navigation to the address of the last recorded one within 5000 ms of it, reloads excepted, is not written in any tab, an exception that document lists with the departure it marks for a genuine repeat. |
| `file_upload` | `element`, `files` | File(s) selected via input. `files`: `[{name, size, mime}]`. On the extension a file change is written without the trust test when the input saw a trusted click within 10 s — a departure from core CP-1 — and not written otherwise, a departure the extension capture document lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Desktop (Windows) only

| Type          | Key fields                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file_dialog` | `dialog_type`, `file_path`, `source` | File dialog completed. `dialog_type` is read from the dialog's lower-cased window title: `save_as` when it contains "save as", else `save` when it contains "save", else `open` when it contains "open"; a dialog whose title contains none of these records no `file_dialog`. `source` is the opening application's executable file name — the last segment of the path the `context_switch` read holds — or `pid:<n>` when the process cannot be read; `file_path` is the directory the dialog shows and the file name, joined with a backslash, or the file name alone when the directory could not be read (core CP-18). |

---

## Element

Describes the UI element an action targeted.

The per-platform JSON Schema is authoritative for field semantics; this table
summarizes it. Several fields carry different meanings per platform — the
extension reads the DOM, the desktop app reads the Windows UI Automation (UIA)
tree.

```json
{
  "tag": "BUTTON",
  "id": "submit-btn",
  "name": null,
  "role": "button",
  "type": "submit",
  "text": "Submit report",
  "selector": "#submit-btn"
}
```

| Field                | Type            | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`                | string          | yes      | HTML tag name (extension) / UIA ControlType, e.g. `Button`, `Edit` (desktop). In coordinate mode: the control type of the window or generic pane the point resolved to (`Window` or `Pane`), `"unknown"` when nothing did.                                                                                                                                                                                                                                                                                                                                 |
| `id`                 | string \| null  | no       | DOM `id` attribute (extension) / UIA AutomationId, developer-assigned and session-stable (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `name`               | string \| null  | no       | `name` attribute (extension) / UIA Name (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `role`               | string \| null  | no       | ARIA role (extension) / localized UIA control type (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `type`               | string \| null  | no       | Input type attribute (extension) / control subtype, e.g. `"password"` (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `autocomplete`       | string \| null  | no       | HTML `autocomplete` token, e.g. `"cc-number"` (extension). Used to detect sensitive payment fields. Null/absent on desktop.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `text`               | string \| null  | no       | Visible text, truncated to 100 characters: the extension's `innerText` (a `select`'s is every option's text; the `value` fallback applies only to an element with no `innerText` property, so an input's empty rendered text yields null), trimmed and cut at 100 UTF-16 code units with no mark; the desktop's UIA Value, else its Name, cut at 100 characters with a truncation mark appended (core CP-18). Null for sensitive fields (passwords, credit-card/SSN/secret), where it is also flagged `redacted`.                                          |
| `selector`           | string          | yes      | CSS selector, derived as the `css` candidate states (extension) / accessibility tree path from the topmost ancestor reached to the element, each segment `Type:Name` (`Type` when the name is empty), joined with `" > "`; the walk climbs at most 20 ancestors and can pass above the window, so the path can carry ancestors above the window root and, for a deeper element, starts at its 20th ancestor (desktop; core CP-18). In coordinate mode: the tree path of the window or generic pane the point resolved to, or `coord:x,y` when nothing did. |
| `redacted`           | boolean         | no       | `true` when the value/text was redacted because the field was sensitive (password, payment, or other PII). Absent otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `position_in_set`    | integer \| null | no       | One-based position within the element's logical set of peers (UIA PositionInSet, desktop). Provider-reported; the logical set can differ from what is rendered (virtualized lists). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                         |
| `size_of_set`        | integer \| null | no       | Size of that logical set (UIA SizeOfSet, desktop). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `level`              | integer \| null | no       | One-based hierarchical depth (UIA Level, desktop — e.g. tree-item depth). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `framework_id`       | string \| null  | no       | Per-element UI-framework identity (UIA FrameworkId, desktop — e.g. `Win32`, `WPF`, `XAML`; apps can mix frameworks). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                                                                                        |
| `locators`           | array           | no       | Locator candidates — observed facts about how the element could be addressed at capture time (core CP-18). See [Locator candidates](#locator-candidates-locators).                                                                                                                                                                                                                                                                                                                                                                                         |
| `described_after_ms` | integer \| null | no       | Observed gap between the action's `timestamp` and the moment this element description (including any locator measurements) was captured. `0` = described at the input itself (desktop input-hook pre-capture). Null/absent on extension and in coordinate mode. On the desktop the stamp is also written on the constructed stand-in and fallback elements, where no description was observed — a departure (core CP-18).                                                                                                                                  |

---

## Locator candidates (`locators`)

Each entry in `locators` is a **candidate**: an observed fact about how the acted-on element
could be addressed, recorded together with how ambiguous that candidate was at capture time (core CP-18).
Entries are per-strategy shapes discriminated on `strategy` (the same pattern actions use for
`type`); the set of valid strategies is platform-specific.

```json
{
  "strategy": "test_id",
  "attribute": "data-testid",
  "value": "add-to-cart",
  "match_count": 3,
  "match_index": 1
}
```

### Shared fields (every entry)

| Field         | Type            | Required | Description                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy`    | string          | yes      | Which entry shape applies (see the per-platform tables below).                                                                                                                                                                                                                                                                                                                    |
| `match_count` | integer ≥ 1     | no       | How many elements the candidate matched in its stated scope. Present only where cheap to measure; absent means not measured, never a guess. The format writes a candidate measured and matching nothing as `match_index: null` with no `match_count`; today both platforms write no pair in that case — a departure — so an absent pair also covers a measured zero (core CP-18). |
| `match_index` | integer \| null | no       | Zero-based position of the acted-on element among the matches (`0 <= match_index < match_count`). `null`: the candidate did not match the acted-on element (today written only beside a `match_count`, when other elements matched). On the desktop the index is measured over at most 50 elements and absent past them (core CP-18).                                             |
| `masked`      | boolean         | no       | `true` when the value derived from sensitive content and was masked in place. The entry is kept, never omitted; the pair was measured pre-masking.                                                                                                                                                                                                                                |

Which strategies `masked` can honestly apply to is stated by the contract itself: every
strategy definition declares the **`x-value-derived`** annotation (boolean) — `true` means
the redaction chokepoint masks that strategy's value in place when the element is sensitive.
It is an operational marker of what redaction does today, not a data-safety claim; the
[Value-Derived Strategies](../technical/locator-resolution.md#value-derived-strategies) section of the
resolution procedure defines it, and the sufficiency lint enforces the masking it promises.

### Measurement semantics

**SF-11.** The pair is a snapshot — valid at the recorded `timestamp`, in the stated scope and
order, measured **at the moment the acted-on element is described for capture**. On the extension,
that is inside the capture handler (before the action's effects run) for immediately-captured
actions, and at capture-commit for deliberately debounced or deferred captures (Tab-correlated
focus, scroll settle, contenteditable typing pauses — the extension's recorder decides which
captures it defers). On desktop, elements are described asynchronously on a worker after the input
that caused them, so the measurement reflects the tree as it stands when the description is built —
the action's effects may already be underway; desktop click actions whose element was described
directly at input time carry candidate values only, with the pair absent (not measured). How long
after the input the description (and so the pair) was actually captured is exported per element as
`described_after_ms` — `0` for input-time describes, the real observed gap for worker describes — so
a consumer can apply its own staleness judgement instead of trusting an implicit one:

| Platform  | Scope                                                                                | Order                                                                                                        |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Extension | The capturing frame's document root (the same boundary selector derivation stops at) | Document order; standard non-piercing matching (shadow roots are not descended into)                         |
| Desktop   | The acted-on element's top-level window (the window itself included)                 | Depth-first pre-order (tree order, as returned by the automation engine) over the UI Automation Control view |

**SF-12.** The order of entries in `locators` is the fixed order the strategy definitions
are declared in the platform schema — a serialization convention that carries **no
preference or ranking** (core CP-18; the consumer-side rule is
[locator-resolution §LR-3](locator-resolution.md)).
Candidates whose value was empty are omitted rather than included empty; the whole array is
omitted when no candidates were observed (e.g. coordinate mode).

What "the recording's locators resolve correctly" means — and the conformance-vector scope —
is defined by the [reference resolution procedure](../technical/locator-resolution.md).

Note: the provider-reported set ordinals (`position_in_set`/`size_of_set`) and a measured
`match_count` can legitimately disagree — under UI virtualization only realized items exist in
the walked tree, while the provider reports the logical set. The disagreement is itself
signal that the container is virtualized.

### Extension strategies

| `strategy`    | Fields (beyond the shared ones) | Derived from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `value`                         | The `id` attribute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test_id`     | `attribute`, `value`            | The first with a non-empty value among `data-testid`, `data-test`, `data-test-id`, `data-qa` and `data-cy`; `attribute` records which one. The others are not written although the format admits an entry per attribute (LR-6) — a departure (core CP-18)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `name`        | `value`                         | The `name` attribute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tag_name`    | `value`                         | The tag name (lower-cased; case preserved for foreign elements)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `role_name`   | `role`, `name`                  | The element's role and accessible name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `label`       | `mechanism`, `value`            | An associated label; `mechanism` is `for`, `wrapped`, or `aria-labelledby`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `text`        | `value`                         | Rendered text, whitespace-normalized; omitted when none or > 100 chars. The pair counts same-tag elements with equal normalized text, absent when more than 100 same-tag elements would be compared (core CP-18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `placeholder` | `value`                         | The `placeholder` attribute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `title`       | `value`                         | The `title` attribute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `alt_text`    | `value`                         | The `alt` attribute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `css`         | `value`                         | A CSS selector derived from observed attributes and structure: per-level segments (`#id`, else `tag[test-attr="value"]` for the first test attribute with a non-empty value, else the tag) built upward from the element until the path matches it uniquely in the document, a unique id ending the walk; `:nth-of-type` positions only when no semantic path is unique, deepest level first, within 25 uniqueness probes in all; failing both, the fully positional path. The order prefers the path least tied to layout; the budget arm writes the positional path even where a unique semantic path lies beyond the 25 checks — a departure from the most-stable rule (core CP-18) |

### Desktop strategies

| `strategy`      | Fields (beyond the shared ones) | Derived from                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation_id` | `value`                         | UIA AutomationId (developer-assigned; never the session-scoped RuntimeId)                                                                                                                                                                                                                                                    |
| `role_name`     | `role`, `name`                  | Non-localized UIA control type name + UIA Name (localized)                                                                                                                                                                                                                                                                   |
| `class_name`    | `value`                         | UIA ClassName                                                                                                                                                                                                                                                                                                                |
| `labeled_by`    | `value`                         | UIA Name of the element referenced by the LabeledBy property                                                                                                                                                                                                                                                                 |
| `tree_path`     | `value`                         | Control types and names from the window root to the element, each `Type:Name` (`Type` when the name is empty), joined with `" > "`; the walk climbs at most 20 ancestors, and the entry is omitted when it did not confirm the window root — an element deeper than that, or a root the walk could not identify (core CP-18) |

---

## JSON Schema files

The published schemas under `schemas/dist/` are **build output**, composed by
[`scripts/build-schemas.js`](../../scripts/build-schemas.js) from a layered chain: a
platform-agnostic base (`schemas/shared.schema.json`), an optional family layer
(`schemas/desktop.shared.schema.json`, shared by all desktop surfaces), and a
per-surface leaf (`schemas/<surface>.delta.json`). Edit a source layer — never a
file under `schemas/dist/` directly: the `dist/` copies are regenerated by the
release pipeline, while day-to-day tooling composes each schema from the source
layers in-memory.

The layers compose base-first, and each may add to or replace what an earlier
layer set:

- **`$defs` are merged key-by-key.** A family or leaf may add a new `$def` or
  replace an earlier one outright — the replacement is whole-def, not a deep merge,
  so a layer that redefines a shared `$def` restates all of it.
- **The structural envelope comes from the base.** The top-level `type`,
  `required`, `additionalProperties`, and `properties` are the base's; family and
  leaf layers contribute `$defs`, not a new envelope.
- **Identity metadata comes from the leaf.** `$id`, `title`, `version`, and
  `description` are taken from the last layer that sets them, so a leaf is
  **identity-only by default** — carrying those four, the `platform` const the
  stamp is pinned from, and anything genuinely unique to that one surface (the extension leaf, having no family layer, also
  carries its browser-only defs). Versions are set by the release tooling (see
  [Versioning](#versioning)), never edited in a leaf by hand.
- **The per-action context field is injected once.** Each chain names its
  per-action context property — `frame_src` on the extension, `window_rect` on
  desktop — a single time via `actionContextProperty`, and `build-schemas.js`
  injects it into every action `$def`; no layer repeats it on the individual
  action defs.

Machine-readable schemas for validation:

- [`schemas/dist/extension.schema.json`](../../schemas/dist/extension.schema.json) — Chrome extension
- [`schemas/dist/desktop-windows.schema.json`](../../schemas/dist/desktop-windows.schema.json) — Windows desktop
- [`schemas/shared.schema.json`](../../schemas/shared.schema.json) — Shared definitions (not used directly for validation)

---

## Import acceptance

**SF-13.** Whenever the validator packaged with the importing platform is
available, a `.docent.json` file is accepted for import only after validating
against the importing platform's schema — including the stamp's `const`
version gate, so after a schema version bump previously exported files stop
importing by design (pin the producing version — see
[Schema version pinning](#schema-version-pinning) — or re-export). Two bounds run before validation:
payloads whose compact serialization exceeds the 10 MiB bound — the extension
platform's local-storage quota, which the importer applies to the re-serialized
form's length counted in UTF-16 code units, as DI-9 counts its outbound bound —
and JSON
nested deeper than 64 levels are rejected
outright. One declared exception: when that packaged validator itself is
unavailable, the import proceeds unvalidated and the degradation is logged.
Pulled sync payloads run those same bounds and that same schema validation,
applied to each payload's known-field projection — the transport layer where
the [Sync Protocol](../api/sync-protocol.md)'s pull phase delivers its
forward-compatibility rule, so identical bytes can be accepted on pull and
refused on import.

---

## Field stability

**SF-14.** All fields documented above are **stable** — they will not be
removed or have their semantics changed without a major version bump. Fields
may be **added** in minor versions; consumers SHOULD ignore unknown fields
rather than failing on them. The schemas state where unknown keys validate:
**action objects accept unknown fields** (the additive evolution surface — new
action fields arrive without failing an old validator), and the user-defined
`metadata` maps accept arbitrary keys with typed values (a data surface, not
an evolution surface). Every other object is closed
(`additionalProperties: false`), so unknown keys there are validation errors,
not extensions. The `oneOf` hosts that discriminate the action and locator
shapes sit outside that split without widening it: each states no
`additionalProperties` of its own, because the member it selects carries the
posture — an instance is judged by its member's declaration.

Which fields the replay-sufficiency guarantee stands on — the normative subset
versus informative evidence and context — is classified in
[Replay Sufficiency — Field Taxonomy](../requirements/replay-sufficiency.md#field-taxonomy--normative-vs-informative).
