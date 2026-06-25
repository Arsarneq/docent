# Docent Session Format

The `.docent.json` format is the contract between Docent and any downstream system.
This document is the formal specification.

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

**Version bumps** are determined **mechanically at release time** by
[`scripts/auto-version-schemas.js`](../scripts/auto-version-schemas.js), which
diffs the last released schema (`schemas/dist/<platform>.schema.json`) against
the schema composed from the current source layers and classifies the change:

- **Patch** (x.x.1): documentation-only changes (description clarifications)
- **Minor** (x.1.0): new optional fields, new action types, new enum values on existing fields
- **Major** (1.0.0): new required fields, removed fields, renamed fields, changed semantics, changed types, removed enum values, tightened constraints

The classifier is intentionally conservative: anything it cannot confidently
place as patch or minor is escalated to **major**, so a release can never
silently under-version a breaking change. Contributors do not bump versions by
hand during development — the release pipeline does it. (To force a level for a
semantic change the structural diff cannot see — same shape, changed meaning —
use `scripts/bump-schema.js`.)

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
Follow the [development installation steps](../README.md#installation-development),
but check out the tag that produces the schema version you need before syncing
and loading:

```bash
git checkout extension-v2.0.0   # or any release tag
```

Chrome will not auto-update an unpacked extension. When you are ready to adopt a
newer schema version, check out the corresponding tag and reload.

Every exported file carries the `docent_format` stamp, so a consumer can always
detect which schema version produced a file and fail loudly on a mismatch rather
than silently misinterpreting data.

---

## Dispatch payload structure

When Docent dispatches to an endpoint, the HTTP POST body is:

```json
{
  "reading_guidance": "(string) Human-readable prose explaining the payload",
  "schema": { "(object) The JSON Schema for this platform" },
  "docent_format": { "platform": "(string)", "schema_version": "(string)" },
  "project": { ... },
  "recordings": [ ... ]
}
```

| Field              | Type   | Description                                                                                        |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| `reading_guidance` | string | Prose explanation of the payload. Designed for LLM context.                                        |
| `schema`           | object | The full JSON Schema for the sending platform. Consumers can use this for validation or ignore it. |
| `docent_format`    | object | Self-describing stamp: `{ platform, schema_version }`. See [Format stamp](#format-stamp).          |
| `project`          | object | Project metadata.                                                                                  |
| `recordings`       | array  | Array of recording objects.                                                                        |

The `.docent.json` export file contains `docent_format`, `project`, and
`recordings` (no `reading_guidance` or `schema` wrapper).

---

## Format stamp

Every `.docent.json` export and every dispatch payload carries a required
`docent_format` object at its root — for example (the `schema_version` shown is
illustrative, not the current version):

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

The stamp makes every file self-describing: a consumer can pick the correct
schema and route migrations without inspecting the contents or guessing. In each
published schema both values are fixed as `const`, so the stamp is validated, not
just carried — a file whose stamp does not match a schema's platform/version will
not validate against it. (Docent's own backward-compatibility test corpus relaxes
the `schema_version` `const` to validate older exports by _shape_ across versions
— a test-harness convenience that never weakens the published contract a consumer
receives.) The values are sourced from the schema itself (the single source of
truth), never hand-written.

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

| Field          | Type     | Required | Description                     |
| -------------- | -------- | -------- | ------------------------------- |
| `recording_id` | UUIDv7   | yes      | Time-ordered unique identifier. |
| `name`         | string   | yes      | Human-readable recording name.  |
| `created_at`   | ISO 8601 | yes      | Creation timestamp.             |
| `metadata`     | object   | no       | User-defined key-value pairs.   |
| `steps`        | array    | yes      | Full step history (see below).  |

---

## Steps

The `steps` array contains the **full version history** of all steps in the
recording. This includes re-recorded versions and soft-deleted steps.

To resolve the "active" view (what the user last committed):

1. Group steps by `logical_id`
2. Within each group, take the step with the latest `uuid` (UUIDv7 is time-ordered)
3. Exclude steps where `deleted: true`
4. Sort by `step_number`

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

| Field              | Type                         | Required       | Description                                              |
| ------------------ | ---------------------------- | -------------- | -------------------------------------------------------- |
| `uuid`             | UUIDv7                       | yes            | Unique version identifier. Later UUID = newer version.   |
| `logical_id`       | UUIDv7                       | yes            | Groups versions of the same step.                        |
| `step_number`      | integer ≥ 1                  | yes            | Display order.                                           |
| `created_at`       | ISO 8601                     | yes            | When this version was created.                           |
| `narration`        | string (min 1 char)          | one of         | Free-text intent description. Present in narration mode. |
| `narration_source` | `"typed"`                    | with narration | How narration was provided.                              |
| `step_type`        | `"action"` \| `"validation"` | one of         | Step classification. Present in simple mode.             |
| `expect`           | `"present"` \| `"absent"`    | no             | Assertion type for validation steps.                     |
| `actions`          | array                        | yes            | Captured user interactions.                              |
| `deleted`          | boolean                      | yes            | Soft-delete marker.                                      |

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

### Platform-specific fields

**Extension only:**

- `frame_src` (string \| null) — iframe URL, or null for top frame.

**Desktop (Windows) only:**

- `window_rect` (object \| null) — window position/size `{x, y, width, height}`, or null for accessibility-mode actions.

### Capture modes

| Platform  | Values            | Description                                                           |
| --------- | ----------------- | --------------------------------------------------------------------- |
| Extension | `"dom"`           | Always DOM-based capture.                                             |
| Desktop   | `"accessibility"` | Native UI Automation API. Full element description.                   |
| Desktop   | `"coordinate"`    | Fallback. Element lacks accessibility data. `window_rect` is present. |

---

## Action types

### Shared (both platforms)

| Type             | Key fields                                                   | Description                                                                                                                                           |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click`          | `x`, `y`, `element`                                          | Left-click on an element.                                                                                                                             |
| `right_click`    | `x`, `y`, `element`                                          | Right-click on an element.                                                                                                                            |
| `type`           | `element`, `value`                                           | Text entered into a field. Sensitive values (passwords, credit-card/SSN/secret fields) are masked as `"••••••••"` and the element flagged `redacted`. |
| `select`         | `element`, `value`                                           | Option selected from a dropdown/list.                                                                                                                 |
| `key`            | `key`, `modifiers`, `element`                                | Keyboard input. `modifiers`: `{ctrl, shift, alt, meta}`.                                                                                              |
| `focus`          | `element`                                                    | Element received focus (non-redundant cases only).                                                                                                    |
| `drag_start`     | `element`                                                    | Drag operation began.                                                                                                                                 |
| `drop`           | `x`, `y`, `element`, `source_element`                        | Drop completed. `source_element` is the dragged item.                                                                                                 |
| `scroll`         | `element`, `scroll_top`, `scroll_left`, `delta_y`, `delta_x` | Scroll gesture (debounced).                                                                                                                           |
| `context_switch` | `source`, `title`                                            | User switched to a different window/tab.                                                                                                              |
| `context_open`   | `opener_context_id`, `source`                                | New window/tab opened.                                                                                                                                |
| `context_close`  | `window_closing`                                             | Window/tab closed.                                                                                                                                    |

### Extension only

| Type          | Key fields         | Description                                                                                                                               |
| ------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`    | `nav_type`, `url`  | Page navigation. `nav_type`: link, typed, reload, back_forward, spa, form_submit, etc. Auth-token query-param values in `url` are masked. |
| `file_upload` | `element`, `files` | File(s) selected via input. `files`: `[{name, size, mime}]`.                                                                              |

### Desktop (Windows) only

| Type          | Key fields                           | Description                                                |
| ------------- | ------------------------------------ | ---------------------------------------------------------- |
| `file_dialog` | `dialog_type`, `file_path`, `source` | File dialog completed. `dialog_type`: open, save, save_as. |

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

| Field          | Type           | Required | Description                                                                                                                                |
| -------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tag`          | string         | yes      | HTML tag name (extension) / UIA ControlType, e.g. `Button`, `Edit` (desktop). `"unknown"` in coordinate mode.                              |
| `id`           | string \| null | no       | DOM `id` attribute (extension) / UIA AutomationId, developer-assigned and session-stable (desktop).                                        |
| `name`         | string \| null | no       | `name` attribute (extension) / UIA Name (desktop).                                                                                         |
| `role`         | string \| null | no       | ARIA role (extension) / localized UIA control type (desktop).                                                                              |
| `type`         | string \| null | no       | Input type attribute (extension) / control subtype, e.g. `"password"` (desktop).                                                           |
| `autocomplete` | string \| null | no       | HTML `autocomplete` token, e.g. `"cc-number"` (extension). Used to detect sensitive payment fields. Null/absent on desktop.                |
| `text`         | string \| null | no       | Visible text (truncated to 100 chars). Null for sensitive fields (passwords, credit-card/SSN/secret), where it is also flagged `redacted`. |
| `selector`     | string         | yes      | CSS selector (extension) / accessibility tree path joined with `" > "`, or `coord:x,y` in coordinate mode (desktop).                       |
| `redacted`     | boolean        | no       | `true` when the value/text was redacted because the field was sensitive (password, payment, or other PII). Absent otherwise.               |

---

## JSON Schema files

Machine-readable schemas for validation:

- [`schemas/dist/extension.schema.json`](../schemas/dist/extension.schema.json) — Chrome extension
- [`schemas/dist/desktop-windows.schema.json`](../schemas/dist/desktop-windows.schema.json) — Windows desktop
- [`schemas/shared.schema.json`](../schemas/shared.schema.json) — Shared definitions (not used directly for validation)

---

## Field stability

All fields documented above are **stable** — they will not be removed or have
their semantics changed without a major version bump.

Fields may be **added** in minor versions. Consumers should ignore unknown fields
rather than failing on them.
