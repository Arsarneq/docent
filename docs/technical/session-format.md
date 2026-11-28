# Docent Session Format

The `.docent.json` format is Docent's contract with anything that consumes a
recording. It is defined per platform by independently versioned JSON Schemas —
the authoritative source of truth for the format. This document is the
companion prose that orients a reader in both schemas, with annotated
examples.

Where to look:

| You want to                                        | Read                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read a recording                                   | [Overview](#overview), then the sections from [Format stamp](#format-stamp) through [Locator candidates](#locator-candidates-locators), which follow the file's nesting |
| Validate a file, or find the schema for a platform | [Format stamp](#format-stamp), [JSON Schema files](#json-schema-files) and [Import acceptance](#import-acceptance)                                                      |
| Know what can change between versions              | [Versioning](#versioning) and [Field stability](#field-stability)                                                                                                       |
| Add a field                                        | [Adding a field](#adding-a-field)                                                                                                                                       |
| Receive a recording over dispatch                  | [Dispatch payload structure](#dispatch-payload-structure)                                                                                                               |

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

| Field                 | Type                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                | string                   | Action type identifier.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `timestamp`           | integer                  | Unix milliseconds when the action occurred.                                                                                                                                                                                                                                                                                                                                                                                              |
| `context_id`          | integer \| null          | Session-scoped window/tab identifier.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `capture_mode`        | string                   | How the action was captured (platform-specific).                                                                                                                                                                                                                                                                                                                                                                                         |
| `preferred_languages` | array of strings \| null | The user's ordered language preference that applications are offered, as language tags, most preferred first: the browser's `navigator.languages` on the extension, the user's preferred UI languages as Windows lists them on the desktop. Null when the platform could not read it. Optional: a recording made before the field was added carries none. Recorded context beside the action (core CP-3); see [Shown text](#shown-text). |

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

| Platform  | Values            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension | `"dom"`           | Always DOM-based capture.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Desktop   | `"accessibility"` | Native UI Automation API. Full element description.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Desktop   | `"coordinate"`    | Fallback: no specific control resolved at the point. The element describes the container the point fell in — the window or generic pane that resolved (its control type, `Window` or `Pane`, with its tree path) — or carries `tag: "unknown"` with a `coord:x,y` selector when nothing did; either way it makes no element-identity claims (no locators, no provider facts, no describe latency; the field set this mode leaves out, with `language` stated as null, core CP-18). |

---

## Action types

### Shared (both platforms)

Where the base schema's `description` stays platform-neutral, these rows carry
the per-platform meaning.

| Type             | Key fields                                                                                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click`          | `x`, `y`, `modifiers`, `held_keys`, `element`                                                                     | Left-click on an element; the desktop also records a middle-button press as a `click` (DCP-10), an input the extension does not capture — a departure the extension capture document lists (ECP-12). The extension's `element` is the clicked element or its nearest interactive ancestor: an `a`, `button`, `label` or `select`, an element with role `button`, `option`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `listitem`, `tab`, `checkbox`, `radio`, `switch`, `treeitem` or `gridcell`, or an `input` of type submit, button, checkbox, radio or reset (core CP-18). On the extension a click on a `label` is written once, against its picked element as any click is, the click the browser sends on to the labelled control not being written again. On the extension the click the browser derives from a key press (Enter or Space on a button, an arrow key in a radio group, for example) is that key's effect and is not written, the `key` being the record. The extension capture document's [ECP-12](../architecture/application/extension/capture-principles.md#exceptions-within-the-surface) lists the clicks the extension writes otherwise or not at all. `modifiers` is the modifier keys held, as on `key`, and `held_keys` the other keys that were down, as `key` states them. Both stand as they were at the release of the left button, which is when the browser sends the extension its `click` event; on the desktop's middle-button `click` they stand as they were at the press of that button.                                                                                                                                                                                                                                                                                                                                                                                      |
| `right_click`    | `x`, `y`, `modifiers`, `held_keys`, `element`                                                                     | Right-click on an element; the extension picks its `element` as for `click`. `modifiers` is the modifier keys held, as on `key`, and `held_keys` the other keys that were down, as `key` states them. The action stands for the press of the right button on both platforms: `timestamp`, `x`, `y`, `modifiers` and `held_keys` are those of the press, whether the system opens its menu at the press or at the release. A context menu asked for with a key is recorded as that `key` alone. The extension capture document's [ECP-12](../architecture/application/extension/capture-principles.md#exceptions-within-the-surface) lists the right-clicks the extension writes otherwise or not at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `type`           | `element`, `value`                                                                                                | Text entered into a field. Sensitive values (passwords, credit-card/SSN/secret fields) are masked as `"••••••••"` and the element flagged `redacted`. On the extension an input's or textarea's `value` is written whole, a contenteditable's is trimmed and cut at 500 characters with no mark; on the desktop `value` is the element's accessibility Value (an element that has none gives no `type`), cut at 100 characters with a truncation mark; on both platforms a field that was emptied is a `type` whose `value` is the empty string, and text typed into one field is one `type` however long the pauses between its keys (save on the desktop where the field's value was read after later keys were pressed: the keys typed since the last value read in time are then `key` actions after its `type`, or alone, a departure the desktop capture document lists): the `type` is written when the typing in the field ends (a key that enters no text or a pointer press, for example; each platform's capture document states its list); [docent#238](https://github.com/Arsarneq/docent/issues/238) holds each cut as a defect, the entered value being the fact the format carries rather than a described text (core CP-18). On the extension a key pressed after the entry (Enter or Tab, for example) is written after the `type` that entry gives; the `type` is not written after a same-form submit press, a departure the extension capture document lists; on the desktop a value the person types is written each time it is typed, also where it equals the one written before; a value change that repeats the value just taken for the field, with no typing key, paste key or menu item click for it (for a password field, every such change after the first), or a change on an element the accessibility layer cannot describe, is not written — departures the desktop capture document lists. |
| `select`         | `element`, `value`                                                                                                | Option selected from a dropdown/list. On the extension `value` is the text of the first selected option (a multiple select's other selected options are not written), else the control's `value`. On the desktop the element and `value` come from the first that applies: for a focused list, combo box, tree or data grid, the first item of its current selection (its UIA Name as `value`), else that container with its name; for any other focused element, the element with its text; when the focused element could not be described, the first item of the selection the accessibility layer still reports on it; else a constructed stand-in (`tag` `ListItem`, `role` `listitem`, empty `selector`, the window title as `name`) with an empty `value` — a departure, its tag and role not observed facts (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `key`            | `key`, `modifiers`, `repeat`, `code`, `input_method_open`, `input_method_conversion_mode`, `held_keys`, `element` | A key press that is not text, on both platforms. [The `key` action](#the-key-action) below is this row's description: which presses are which, and what each field states.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `focus`          | `element`                                                                                                         | Element received focus (non-redundant cases only). On the extension a focus event a script sends is written too, whether or not the focus moved: a departure from core CP-1 ([docent#868](https://github.com/Arsarneq/docent/issues/868)). The platform capture documents list the focuses that are not written ([ECP-12](../architecture/application/extension/capture-principles.md#exceptions-within-the-surface); [DCP-13](../architecture/application/desktop/windows/capture-principles.md#exceptions-within-the-surface) and [DCP-21](../architecture/application/desktop/windows/capture-principles.md#which-focus-is-written-and-where)). On the desktop `context_id` and `window_rect` are those of the window the focused element is in, as its description resolved it, and those of the window the focus event named where the description resolved no window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `drag_start`     | `modifiers`, `held_keys`, `element`                                                                               | Drag operation began. On the desktop, when no control resolves at the point, the element is the coordinate-mode fallback (`tag` `unknown`, selector `coord:x,y`) written under `capture_mode: accessibility` — a departure (core CP-18). The desktop pair's `context_id` and `window_rect` are the release point's window, and `drag_start`'s `timestamp` is the release moment — departures (core CP-18). `modifiers` is the modifier keys held, as on `key`, and `held_keys` the other keys that were down, as `key` states them. Both stand as they were when the drag started: on the extension at the browser's `dragstart` event, on the desktop at the first pointer position past its drag threshold after the button-down, though the desktop action's `timestamp` is the release moment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `drop`           | `x`, `y`, `modifiers`, `held_keys`, `element`, `source_element`                                                   | Drop completed. On the desktop the element falls back as for `drag_start` — a departure (core CP-18); on the extension a drop a script sends is written like the person's own while a drag the person started in the same document is in flight: a departure from core CP-1 ([docent#868](https://github.com/Arsarneq/docent/issues/868)). `source_element` is the dragged item; null when no drag start was observed for it (a drag begun before recording, or outside the capturing document or worker). `modifiers` is the modifier keys held, as on `key`, and `held_keys` the other keys that were down, as `key` states them, both as they stood at the release that dropped the item. On the extension `held_keys` is empty at a `drop`: the browser sends a page no key events while a drag lasts and gives it no interface that reads the keyboard's state, so no key is known to be down at its end, where the desktop's keyboard hook still names the keys — a difference that comes from the platforms themselves (core CP-19); the extension capture document (ECP-18) states what the browser gives the extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scroll`         | `element`, `scroll_top`, `scroll_left`, `delta_y`, `delta_x`                                                      | Scroll gesture (debounced). `delta_y`/`delta_x` carry the sequence's net displacement (core CP-16); the extension reads its start offset from the first scroll event's target, after that event's movement, and its end offset from the last event's target, so the first increment is not included and a sequence that moves across containers subtracts two targets' offsets — a departure from the quantity core CP-16 names ([docent#251](https://github.com/Arsarneq/docent/issues/251)). The extension writes a scroll without a trust or input test — a departure from core CP-1 ([docent#224](https://github.com/Arsarneq/docent/issues/224)); the desktop writes `scroll_top` and `scroll_left` as 0 and `element` as null, identifying no scrolled container ([docent#228](https://github.com/Arsarneq/docent/issues/228)), and a scroll flushed with no arriving event (its timer, or a buffer drain at a flush barrier, a fallback drain, a worker's rescue or respawn, or shutdown) carries `context_id` and `window_rect` as null and the flush time as its `timestamp` ([docent#225](https://github.com/Arsarneq/docent/issues/225)) — departures (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `context_switch` | `source`, `title`                                                                                                 | User switched to a different window/tab; on the extension a switch between browser windows records no action — a departure the extension capture document lists (ECP-12). `source` is the tab URL on the extension; on the desktop the process executable name, or `pid:<n>` when the process cannot be read, `<n>` being the process id read with the switch. `title` is the tab title on the extension (null when the browser reports none; an empty title passes through as an empty string) and the window title on the desktop, read with the switch, so a window that closes before the switch is written keeps it, or, where that read gave no title, read as the switch is written (null when empty; at most 511 UTF-16 units, as for the executable path behind `source`; a longer executable path leaves a fragment of it as the name — core CP-18). On the desktop the two foreground activations core CP-17 calls cascades — the activation of a window whose `context_open` the same action records, and the system's activation of an already-introduced window after a close — are written as `context_switch` — a capture gap against core CP-17, as the desktop capture document states. On the desktop a `context_switch` is also written, with the action's timestamp, before the first action taken in a window whose context the capture session has not introduced, as the desktop capture document states in [DCP-20](../architecture/application/desktop/windows/capture-principles.md), with the switches into the same window that can follow. The extension capture document's [ECP-12](../architecture/application/extension/capture-principles.md#exceptions-within-the-surface) lists the tab activations the extension does not write.                                                                                                                                                           |
| `context_open`   | `opener_context_id`, `source`                                                                                     | New window/tab opened. `opener_context_id` is the opening tab's id on the extension when the browser reports one, else null; always null on the desktop. `source` is the tab URL (or null) on the extension; on the desktop the process executable name (`pid:<n>` when the process cannot be read, `<n>` being the id of the window's process as the open is written; the executable read is `context_switch`'s), or null when it is empty (core CP-18). On the extension no `context_open` is written for a tab created within 500 ms after an in-page action — for a tab the page opened, a capture gap against core CP-17 ([docent#252](https://github.com/Arsarneq/docent/issues/252)); for a tab the user opened, a departure the extension capture document lists; `source` is null where the browser reported only a pending URL — a departure (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `context_close`  | `window_closing`                                                                                                  | Window/tab closed. `window_closing` is false on the extension (a tab closed within a surviving window; a whole-window close records no action — a departure the extension capture document lists) and true on the desktop, where the context is the window. On the extension the close of a tab created within 500 ms after an in-page action is not written when it comes within 2000 ms after an in-page action — an exception the extension capture document lists, with the departures it marks for a tab the user opened and for the user's close of a tab a page opened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### The `key` action

The shortcut modifiers are Meta, Ctrl held without Alt or AltGr, and Alt held without Ctrl or AltGr (AltGr, and Ctrl and Alt held together, enter characters of the layout). On the extension running on a Mac, Alt alone is the Option key, which enters characters, and is no shortcut modifier.

The first row that fits, from the top, decides what is written for a press:

| The press                                                                               | What is written                                                                                                                                                |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A press of Shift, Ctrl, Alt or AltGr                                                    | Nothing: the actions made while it is held state it                                                                                                            |
| A press of the Meta key                                                                 | A `key`, the system acting on that key by itself                                                                                                               |
| A key that enters a character, pressed with no shortcut modifier on a sensitive element | Never a `key`, on either platform: where it entered text, that field's `type`; where it entered none, the element's masked `type`                              |
| A character key pressed with a shortcut modifier                                        | A `key`: it is a shortcut                                                                                                                                      |
| A dead key                                                                              | Part of the field's `type` when the character key after it enters text, and a `key` otherwise                                                                  |
| A key that enters a character, pressed with no shortcut modifier                        | Part of the field's `type` where a field took it, and a `key` where none did (on a button, in a read-only field, on a page that cancels it and enters nothing) |
| A context menu asked for with a key (the Menu key, Shift+F10)                           | That `key` alone, on both platforms                                                                                                                            |
| Any other press                                                                         | A `key`                                                                                                                                                        |

Some presses are written differently on one platform:

- On the desktop, the keys typed into a field since the last value taken of it are `key` actions after its `type`, and the keys alone where no value was taken: a departure the desktop capture document lists ([DCP-18](../architecture/application/desktop/windows/capture-principles.md#a-value-read-after-later-keys) states when a value is taken).
- On the extension the character keys typed into a date or time field are text once the field has a value and `key` actions where they gave it none (ECP-13 states which keys count together), and a key the input method takes is not written (its text arrives as a composition the field's `type` records): the extension capture document's ECP-12 states which of these is a departure.
- On the desktop a key pressed where an input method was read as on is named `Unidentified`, where the extension names a key the input method did not take: a difference that comes from the platforms themselves (core CP-19), which `input_method_open` below states.

**`key`** names the press as [Key names](#key-names) states, the same on both platforms but for the differences and departures the desktop capture document lists (DCP-13).

**`modifiers`** is the modifier keys held, as [Modifiers](#modifiers) states.

**`repeat`** is true on a press the platform's key repeat generated while the key was held down and false on the press itself. Both platforms write it on every `key`; on the desktop a press of a key already down is a repeat.

**`code`** names the physical key that was pressed, by the W3C UI Events `code` values (`KeyA`, `Minus`, `NumpadEnter`): the key's place on the keyboard, the same whatever the active keyboard layout makes of it, so the two Enter keys differ in it and a key relabeled by a layout does not. Both platforms write it; the desktop writes the name a browser gives the same physical key. It is absent on a press with no physical key the platform could name: on the desktop a keystroke injected as a character and a key whose scan code has no such name (zero among them, which software sending a key by its virtual-key code alone can give), on the extension a press the browser names no key for. A character key recorded as an element's masked `type` carries no `code`.

**`input_method_open`** and **`input_method_conversion_mode`** state what the desktop read of the input method (the system's own entry of composed text, as for Japanese, Chinese or Korean) at the press, before the key took effect: whether an input method was on for the control that held the keyboard focus, and its conversion mode, the number Windows gave. In that number a set bit means:

| Bit    | Meaning                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `1`    | The language's own characters (clear for alphanumeric input)                                                                        |
| `2`    | Katakana                                                                                                                            |
| `8`    | Full-width characters                                                                                                               |
| `16`   | Romanized input                                                                                                                     |
| `32`   | Input by character code                                                                                                             |
| `64`   | Hanja conversion                                                                                                                    |
| `128`  | The soft keyboard or, in an input method that uses the bit so, symbols of the language's own set (Windows gives the bit both names) |
| `256`  | No conversion                                                                                                                       |
| `512`  | End-user-defined characters                                                                                                         |
| `1024` | Symbols                                                                                                                             |
| `2048` | A fixed conversion                                                                                                                  |

The five highest bits, the four Windows reserves among them, are not written.

An input method that is on can take a key press for a text it composes. Only code inside the program is told of every key whether it did, and the desktop runs none there (core CP-20; the desktop capture document's DCP-13 holds the measurements). So a press at which the desktop read an input method as on (`input_method_open` true) is written with `key` `Unidentified`, whatever the key, Enter, Tab, an arrow or a shortcut among them: nothing says whether the program got the key or the input method took it. Its `code` still names the physical key where the press has one; an injected character has none, and its action then says only that a key was pressed.

Where the state was not read the key keeps its name, and nothing says that no input method was on. The conversion mode is written only beside the open status. Both are absent:

- where the focused control had no input-method window;
- where that window gave no answer within `min(20 ms, hook timeout / 8)` (the system's low-level hook timeout, in whole ms; under 8 ms that is 0 and nothing is read; DCP-19), or refused the read (as Windows lets a program running with higher rights refuse a message);
- on a key attributed to no window;
- on a key recorded as a masked `type`.

The conversion mode alone is absent where the open status was read and the mode was not. The state read can be that of a moment before an earlier key took effect, on a program that runs behind the typing.

On every `key` of the extension both are absent, the browser giving no interface that reads the input method's state (the extension capture document, ECP-12, names what the extension reads): a difference that comes from the platforms themselves (core CP-19).

**`held_keys`** names the keys that were down at the press, other than the modifiers and the key itself: each a key whose own key-down is a `key` action of the recording, on the desktop of the step (its press, or the first key-down of it that was recorded when the press was not), by the name that action carries, in the order they went down; empty when none was. A key whose press was recorded as text (part of a `type`) or was not recorded is not named, so a key that is not among an action's `held_keys` is not thereby shown to have been up. On the extension a key is known to be down only while its release is sure to reach a recorded document of the same tab (the extension capture document states when that ends, ECP-18, and the departures that remain between a tab's frames, ECP-12); on the desktop every key held since the start of each step's capture is known, wherever the focus is: a difference that comes from the platforms themselves (core CP-19).

**`element`** where nothing is focused, or the focused element could not be described:

| Where                                                                                                                                                                                                                            | The `element`                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop, nothing focused or the focused element could not be described                                                                                                                                                           | A constructed stand-in (`tag` `Unknown`, empty `selector`, the window title as `name`, no locator candidates) written under `capture_mode: accessibility`: a departure (core CP-18) |
| Desktop, a key attributed to no window (a key the system acts on, such as the Windows key, Ctrl+Esc or Alt+Tab, while the self-capture exclusion excludes the window in front: the desktop capture document's DCP-14 lists them) | That stand-in with a null `name`, and a null `context_id` and `window_rect`                                                                                                         |
| Extension, nothing focused                                                                                                                                                                                                       | The body, described with the locators any element carries: a departure (core CP-18)                                                                                                 |

The stand-in carries no locator candidates because Windows gives a key without the element it went to, and that element can be gone by the time the desktop describes it, while the browser gives a key's element with the key. That is a departure (core CP-19; [docent#713](https://github.com/Arsarneq/docent/issues/713)): the platform lets the focused element be described at the press.

### Key names

`key` is what the press means on the active keyboard layout, named by the W3C
UI Events `key` values. `held_keys` names a key the same way.

| The press                                              | `key`                                             |
| ------------------------------------------------------ | ------------------------------------------------- |
| A key that gives one character with the modifiers held | The character: `a`, `A`, `?`, `æ`, `€` with AltGr |
| A space                                                | `Space`, so that a lone space is not lost         |
| A key with a name of its own                           | The W3C name: `Enter`, `ArrowLeft`, `F5`          |
| A dead key                                             | `Dead`                                            |
| The key pressed behind a dead key                      | The one character the two make: `é`, not `e`      |
| A key the rows above give no name                      | `Unidentified`                                    |

While an input method is on, what a press means is the input method's to decide and not the layout's, and the desktop cannot read what it decided ([The `key` action](#the-key-action) states why). What the layout gives the key is then not the press's meaning and is not written: on the desktop a key pressed where an input method was read as on is `Unidentified` whatever the rows give it.

A key that gives no character with the modifiers held (Ctrl with A) is named
by trying, in order:

1. the modifiers as held, AltGr counted as Ctrl and Alt together;
2. the Shift and Caps Lock state of the press, with no other modifier (`a`
   for Ctrl with A, `A` for Ctrl and Shift with A);
3. no modifier.

The first that gives one character or a dead key names the key. A key that
gives two or more characters at once is tried the same way.

A dead key's accent waits for the next key that gives something on the
layout, and that key takes it:

| The key behind the dead key                            | `key`                                     | The accent           |
| ------------------------------------------------------ | ----------------------------------------- | -------------------- |
| Gives a character the accent makes one character with  | That character: `é`, `Á`, `´` for a space | Used                 |
| Gives a character the accent makes nothing with        | Its own: `q`, `1`                         | Used                 |
| Gives a character the accent makes another accent with | Its own                                   | The new accent waits |
| Another dead key                                       | `Dead`, or what the two accents make      | Used                 |
| Gives a control character: Enter, Escape               | Its own: `Enter`, `Escape`                | Used                 |
| Ctrl with a letter key, no Alt held                    | Its own: `a`                              | Waits on             |
| Gives nothing: an arrow key, a function key, Shift     | Its own                                   | Waits on             |

On the desktop the key behind a dead key is named by what the two make only
where both were pressed in the same thread of a program, with no key that
gives something pressed in another thread between them, on any layout. The
thread is that of the foreground window at the key-down. Programs differ in
whether an accent begun in one window is used in another, and a program can
hold an accent from before the recording started; the desktop can read
neither. So where it does not know whether an accent waits for a key, a key
that some dead key of its layout makes one character or an accent with is
`Unidentified`, and every other key keeps its own name; where the key may
have made an accent, the key behind it is not known either. That is so for
the first key that gives something in each thread:

- after the recording started, and so for the key behind a dead key that was
  the first key in its thread;
- after the keys changed thread behind a dead key;
- after the other cases the desktop capture document lists among its
  departures (DCP-13).

A thread counts as new again once 32 other threads have had such a key. A
key-down in a window the recording leaves out (DCP-14) takes or sets a waiting
accent as any key does, and counts as down for `repeat` while it is held
(DCP-19); nothing else of it is written or logged.

A key held down is named in `held_keys` as its own `key` was.

The numeric keypad has no rule of its own. The system sends a keypad key as
a character key or as a navigation key, by Num Lock and Shift, and the key
is named as what was sent: `1`, the layout's decimal character, `End`,
`Clear`, `Delete`.

The extension writes the browser's value, a space as `Space`.

The desktop names a key from what Windows gives it:

- A key with a name of its own is named by its virtual-key code. A few codes
  are named by the language of the layout (the Korean and Japanese mode
  keys).
- Any other key, the space bar among them, is looked up in a table the
  desktop keeps for each keyboard layout: what the layout gives each key
  with each combination of Shift, Ctrl, Alt and Caps Lock.
- The press is looked up by its virtual-key code, the modifiers and the Caps
  Lock state the keyboard hook read at the press, and the keyboard layout of
  the foreground window's thread, read at the press too.
- Where no layout was read for the press, where the layout's table could not
  be built yet because an accent was waiting, and on Windows before
  10.0.14393, which has no read that leaves the keyboard state alone, a key
  with no name of its own is `Unidentified`, and the space bar is `Space`.
  The extension writes the character there, so the platforms differ for
  such a press: a departure the desktop capture document lists (DCP-13;
  core CP-19).
- A keystroke injected as Unicode (`VK_PACKET`) is the character it carried,
  a space as `Space`, or `Unidentified` for a code unit that is no character
  on its own (half of a surrogate pair, or a control character), and
  `Unidentified` like every key while an input method was read as on.
- The key behind a dead key is named from the keys in the order pressed.
  The desktop follows which accent waits on each keyboard layout, and reads
  what an accent and a character make together from the layout's own list.
  Nothing is read from the program typed into, and no time is counted. The
  layout's file is never loaded or run. The desktop capture document lists
  what is written where the list cannot be read, and where the name differs
  from the extension's (DCP-13).

### Modifiers

`modifiers` states the modifier keys held at the action, each `true` when its key was held: `ctrl`, `shift`, `alt`, `meta` and `alt_graph`. It is the same object on every action that carries it, and this rule holds on each of them.

`alt_graph` is `true` when the AltGr key was held and the system held it as AltGr. `ctrl` and `alt` state a Ctrl and an Alt held, as the system holds them, save the Ctrl and the Alt that Windows hands programs for AltGr itself: those are not written as `ctrl` and `alt`. So:

| The person holds                             | `ctrl`  | `alt`   | `alt_graph` |
| -------------------------------------------- | ------- | ------- | ----------- |
| AltGr                                        | `false` | `false` | `true`      |
| Ctrl and AltGr                               | `true`  | `false` | `true`      |
| Alt and AltGr                                | `false` | `true`  | `true`      |
| Ctrl and Alt                                 | `true`  | `true`  | `false`     |
| The right Alt key, on a layout with no AltGr | `false` | `true`  | `false`     |

Ctrl and Alt held without AltGr are written as Ctrl and Alt, also where the layout then enters the character AltGr would: Ctrl and Alt with E give `€` on the Danish layout, as AltGr with E does.

On Windows the right Alt key is AltGr only while the Ctrl that Windows holds for it is down. A key Windows took as AltGr when it was pressed stays AltGr while that holds, also where the layout changes under it. Where that Ctrl has gone up with the key still held (a left Ctrl pressed and let go within AltGr takes it along), the program is given the key as an Alt, and so it is written: `alt` `true`, `alt_graph` `false`. Where AltGr is let go with a Ctrl still held, `ctrl` is written as Windows then holds it.

Both platforms write the same for the same input, save where the browser gives the extension less with AltGr held; the extension capture document states what it then writes, as a departure (ECP-12, [#862](https://github.com/Arsarneq/docent/issues/862)). The desktop capture document states the cases where the desktop cannot know AltGr, or a left Ctrl held with it (DCP-13).

A recording made before `alt_graph` existed carries none, and its `ctrl` and `alt` are not by this rule: for AltGr the desktop wrote both `true`, the same as for Ctrl and Alt held together, and the extension wrote what that departure states.

### Extension only

| Type          | Key fields         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`    | `nav_type`, `url`  | Page navigation. `nav_type` is one of the schema's closed set: `link`, `typed`, `reload`, `back_forward`, `spa`, `auto_bookmark`, `generated`, `start_page`, `form_submit`, `keyword`; it is derived from the browser's transition type, a back/forward qualifier taking precedence over the type it rides on (core CP-18). Values of known-sensitive query parameters in `url` (authentication and session tokens, keys and secrets, passwords, one-time codes, signatures) are masked; the schema's `url` description enumerates the exact parameter names. The masking re-serializes the whole query as `application/x-www-form-urlencoded` once any name matches — names and values re-encoded with only alphanumerics and `*-._` left bare, spaces as `+`, an escaped unreserved character decoded, a bare flag gaining `=`, repeated masked pairs collapsing, the mask itself encoded — a departure (core CP-18). A navigation the server or the page redirected is not written, a departure the extension capture document lists; a navigation to the address of the last recorded one within 5000 ms of it, reloads excepted, is not written in any tab, an exception that document lists with the departure it marks for a genuine repeat. |
| `file_upload` | `element`, `files` | File(s) selected via input. `files`: `[{name, size, mime}]`. On the extension a file change is written when the input took the person's click within the 10 s before the change (a click on the input, or Enter or Space on it). A change a script sends in that time is written too: a departure from core CP-1 ([docent#868](https://github.com/Arsarneq/docent/issues/868)). A file change is not written otherwise, a departure the extension capture document lists ([ECP-12](../architecture/application/extension/capture-principles.md#exceptions-within-the-surface)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Desktop (Windows) only

| Type          | Key fields                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file_dialog` | `dialog_type`, `file_path`, `source` | File dialog completed: written beside a left-button `click` on the dialog's Save or Open button, and beside the second `click` of a left double-click on a file in the dialog's item view, which the desktop capture document states with its caveat; there the fields are the dialog's as read at the double-click's first click, and `context_id` and `window_rect` are the dialog's window's. `dialog_type` is read from the dialog's lower-cased window title: `save_as` when it contains "save as", else `save` when it contains "save", else `open` when it contains "open"; a dialog whose title contains none of these records no `file_dialog`. `source` is the opening application's executable file name — the last segment of the path the `context_switch` read holds — or `pid:<n>` when the process cannot be read; `file_path` is, for an Open dialog, the path of the file on disk the text of the dialog's File name box names — that text lacks the file's extension where the shell hides it — when it names exactly one; else, and for every Save and Save As, the directory the dialog's address band shows, without the label the band puts before it, and that text, joined with a backslash, or that text alone when it is a full path or the directory could not be read (core CP-18), a departure the desktop capture document states with how the file is found (core CP-18); a dialog whose File name box is empty records no `file_dialog`. |

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

| Field                | Type            | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag`                | string          | yes      | HTML tag name (extension) / UIA ControlType, e.g. `Button`, `Edit` (desktop). In coordinate mode: the control type of the window or generic pane the point resolved to (`Window` or `Pane`), `"unknown"` when nothing did.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `id`                 | string \| null  | no       | DOM `id` attribute (extension) / UIA AutomationId, developer-assigned and session-stable (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `name`               | string \| null  | no       | `name` attribute (extension) / UIA Name (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `role`               | string \| null  | no       | ARIA role (extension) / localized UIA control type (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `type`               | string \| null  | no       | Input type attribute (extension) / control subtype, e.g. `"password"` (desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `autocomplete`       | string \| null  | no       | HTML `autocomplete` token, e.g. `"cc-number"` (extension). Used to detect sensitive payment fields. Null/absent on desktop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `text`               | string \| null  | no       | Visible text, truncated to 100 characters: the extension's `innerText` (a `select`'s is every option's text; the `value` fallback applies only to an element with no `innerText` property, so an input's empty rendered text yields null), trimmed and cut at 100 UTF-16 code units with no mark; the desktop's UIA Value, else its Name, cut at 100 characters with a truncation mark appended (core CP-18). Null for sensitive fields (passwords, credit-card/SSN/secret), where it is also flagged `redacted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `selector`           | string          | yes      | CSS selector, derived as the `css` candidate states (extension) / accessibility tree path from the topmost ancestor reached to the element, each segment `Type:Name` (`Type` when the name is empty), joined with `" > "`; the walk climbs at most 20 ancestors and can pass above the window, so the path can carry ancestors above the window root and, for a deeper element, starts at its 20th ancestor (desktop; core CP-18). In coordinate mode: the tree path of the window or generic pane the point resolved to, or `coord:x,y` when nothing did.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `redacted`           | boolean         | no       | `true` when the value/text was redacted because the field was sensitive (password, payment, or other PII). Absent otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `position_in_set`    | integer \| null | no       | One-based position within the element's logical set of peers (UIA PositionInSet, desktop). Provider-reported; the logical set can differ from what is rendered (virtualized lists). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `size_of_set`        | integer \| null | no       | Size of that logical set (UIA SizeOfSet, desktop). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `level`              | integer \| null | no       | One-based hierarchical depth (UIA Level, desktop — e.g. tree-item depth). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `framework_id`       | string \| null  | no       | Per-element UI-framework identity (UIA FrameworkId, desktop — e.g. `Win32`, `WPF`, `XAML`; apps can mix frameworks). Null/absent on extension or when not reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `language`           | string \| null  | no       | The language the application declares for the element, as the application states it. Extension: the value of the `lang` attribute, as written (an empty value included, which declares the language unknown), on the nearest element at or above this one that carries the attribute, passing from a shadow tree to its host and staying within the element's own document; null when no such element carries one. Desktop: the UIA Culture, as its Windows locale name (e.g. `da-DK`), of the nearest element at or above this one, up to its top-level window and within the 20-ancestor walk, that reports one; an ancestor's culture is taken only when the walk confirmed the window root, and a culture that names no language of its own (the user, system and custom defaults, which stand for the machine's setting, and the invariant locale) counts as none. Null when none is reported, in coordinate mode, and on constructed stand-in and fallback elements. A recording made before the field was added carries no `language`. A declaration, not a measurement of the text shown; see [Shown text](#shown-text). |
| `locators`           | array           | no       | Locator candidates — observed facts about how the element could be addressed at capture time (core CP-18). See [Locator candidates](#locator-candidates-locators).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `described_after_ms` | integer \| null | no       | Observed gap between the action's `timestamp` and the moment this element description (including any locator measurements) was captured. `0` = described at the input itself (desktop input-hook pre-capture). Null/absent on extension and in coordinate mode. On the desktop the stamp is also written on the constructed stand-in and fallback elements, where no description was observed — a departure (core CP-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
focus, scroll settle, the end of contenteditable typing — the extension's recorder decides which
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

### Shown text

Some recorded facts are text the application shows, and so follow the application's language:

- **Extension:** the `text`, `placeholder`, `title` and `alt_text` candidates and the element's `text`; the `role_name` and `label` candidates the schema reserves carry shown text too, and the extension writes neither today.
- **Desktop:** the `name` of a `role_name` candidate, the `labeled_by` and `tree_path` candidates, the element's `name`, `role`, `text` and `selector`, and a `file_dialog`'s `dialog_type`, which is read from the dialog's title.
- **Both platforms:** a `select`'s `value` and a `context_switch`'s `title`.

Reproduction assumes the application shows the language it showed at capture ([Replay Sufficiency — Scope Boundaries](../requirements/replay-sufficiency.md#scope-boundaries)). Two fields state what each platform observed about that language: the element's `language` ([Element](#element)) and the action's `preferred_languages` ([Actions](#actions)).

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

### Adding a field

A new field is added in a source layer: the base when every platform records
it, a family or leaf layer when it belongs to one. Six things travel with it
in the same change:

- **Its version level.** A new optional field is a minor change and a new
  required field a major one; [Versioning](#versioning) states the levels, and
  the release tooling applies them.
- **Base wording names no platform.** The definitions under the base's `$defs`
  stay free of platform and technology words; the word list is held by
  [`schema-composition.test.js`](../../packages/shared/tests/unit/schema-composition.test.js),
  which fails the shared unit suite on a base definition that uses one.
  Platform-specific wording goes in the family or leaf layer.
- **Its place in the field taxonomy.** Whether the replay-sufficiency guarantee
  stands on the field is classified in
  [Replay Sufficiency — Field Taxonomy](../requirements/replay-sufficiency.md#field-taxonomy--normative-vs-informative);
  a new field enters as informative unless that taxonomy says otherwise.
- **Its row in this document's field tables.** `npm run lint:schema-echo`
  holds some of the `Field`-headed tables to the composed schemas, and
  [`check-schema-echo.js`](../../scripts/check-schema-echo.js) lists the
  others as `UNHELD_FIELD_TABLES`. Tables in another shape (the action-type
  and strategy tables) are held by review alone.
- **The corpus truths.** When a recorder starts writing the field, that
  platform's scripted-truth corpus check goes red until the affected truth
  files state it or, where a baseline entry quotes an affected action, until
  the baseline is regenerated:
  [when a capture change turns the check red](../verification/scripted-truth-corpus.md#when-a-capture-change-turns-the-check-red).
- **Every platform that holds the fact.** Once the format has a field for a
  fact, a platform that observes that fact about an action it records writes
  it, save in the classes core CP-18 lists. Each other platform
  follows core CP-19: it writes the field in the same change, or the field's
  documentation states a difference of a kind CP-19 lists.

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
