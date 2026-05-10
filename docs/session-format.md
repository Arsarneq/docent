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
| Schema file | Platform | Current |
|---|---|---|
| `schemas/extension.schema.json` | Chrome extension | 2.0.0 |
| `schemas/desktop-windows.schema.json` | Windows desktop | 1.0.0 |
<!-- VERSION_TABLE_END -->

**Version bumps:**
- **Patch** (x.x.1): documentation-only changes, description clarifications
- **Minor** (x.1.0): new optional fields, new action types, new enum values on existing fields
- **Major** (1.0.0): new required fields, removed fields, renamed fields, changed semantics of existing fields, changed type of existing fields

The shared definitions (`schemas/shared.schema.json`) are not versioned
independently — they change when a platform schema changes.

---

## Dispatch payload structure

When Docent dispatches to an endpoint, the HTTP POST body is:

```json
{
  "reading_guidance": "(string) Human-readable prose explaining the payload",
  "schema": { "(object) The JSON Schema for this platform" },
  "project": { ... },
  "recordings": [ ... ]
}
```

| Field | Type | Description |
|---|---|---|
| `reading_guidance` | string | Prose explanation of the payload. Designed for LLM context. |
| `schema` | object | The full JSON Schema for the sending platform. Consumers can use this for validation or ignore it. |
| `project` | object | Project metadata. |
| `recordings` | array | Array of recording objects. |

The `.docent.json` export file contains only `project` and `recordings` (no
`reading_guidance` or `schema` wrapper).

---

## Project

```json
{
  "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
  "name": "Login regression suite",
  "created_at": "2026-05-10T13:04:44.730Z",
  "metadata": {
    "jira": "PROJ-123",
    "tags": ["regression", "login"]
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `project_id` | UUIDv7 | yes | Time-ordered unique identifier. |
| `name` | string | yes | Human-readable project name. |
| `created_at` | ISO 8601 | yes | Creation timestamp. |
| `metadata` | object | no | User-defined key-value pairs. Values are strings or arrays of strings. |

---

## Recording

```json
{
  "recording_id": "019e12a4-0278-7c8e-aae6-01c26f002efb",
  "name": "Happy path login",
  "created_at": "2026-05-10T16:06:38.968Z",
  "metadata": { "zephyr": "TC-456" },
  "steps": [ ... ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `recording_id` | UUIDv7 | yes | Time-ordered unique identifier. |
| `name` | string | yes | Human-readable recording name. |
| `created_at` | ISO 8601 | yes | Creation timestamp. |
| `metadata` | object | no | User-defined key-value pairs. |
| `steps` | array | yes | Full step history (see below). |

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
  "narration": "Navigate to login page and enter credentials",
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

| Field | Type | Required | Description |
|---|---|---|---|
| `uuid` | UUIDv7 | yes | Unique version identifier. Later UUID = newer version. |
| `logical_id` | UUIDv7 | yes | Groups versions of the same step. |
| `step_number` | integer ≥ 1 | yes | Display order. |
| `created_at` | ISO 8601 | yes | When this version was created. |
| `narration` | string (min 1 char) | one of | Free-text intent description. Present in narration mode. |
| `narration_source` | `"typed"` | with narration | How narration was provided. |
| `step_type` | `"action"` \| `"validation"` | one of | Step classification. Present in simple mode. |
| `expect` | `"present"` \| `"absent"` | no | Assertion type for validation steps. |
| `actions` | array | yes | Captured user interactions. |
| `deleted` | boolean | yes | Soft-delete marker. |

"one of" means at least one of `narration` or `step_type` must be present.

---

## Actions

Every action has:

| Field | Type | Description |
|---|---|---|
| `type` | string | Action type identifier. |
| `timestamp` | integer | Unix milliseconds when the action occurred. |
| `context_id` | integer \| null | Session-scoped window/tab identifier. |
| `capture_mode` | string | How the action was captured (platform-specific). |

### Platform-specific fields

**Extension only:**
- `frame_src` (string \| null) — iframe URL, or null for top frame.

**Desktop (Windows) only:**
- `window_rect` (object \| null) — window position/size `{x, y, width, height}`, or null for accessibility-mode actions.

### Capture modes

| Platform | Values | Description |
|---|---|---|
| Extension | `"dom"` | Always DOM-based capture. |
| Desktop | `"accessibility"` | Native UI Automation API. Full element description. |
| Desktop | `"coordinate"` | Fallback. Element lacks accessibility data. `window_rect` is present. |

---

## Action types

### Shared (both platforms)

| Type | Key fields | Description |
|---|---|---|
| `click` | `x`, `y`, `element` | Left-click on an element. |
| `right_click` | `x`, `y`, `element` | Right-click on an element. |
| `type` | `element`, `value` | Text entered into a field. Passwords masked as `"••••••••"`. |
| `select` | `element`, `value` | Option selected from a dropdown/list. |
| `key` | `key`, `modifiers`, `element` | Keyboard input. `modifiers`: `{ctrl, shift, alt, meta}`. |
| `focus` | `element` | Element received focus (non-redundant cases only). |
| `drag_start` | `element` | Drag operation began. |
| `drop` | `x`, `y`, `element`, `source_element` | Drop completed. `source_element` is the dragged item. |
| `scroll` | `element`, `scroll_top`, `scroll_left`, `delta_y`, `delta_x` | Scroll gesture (debounced). |
| `context_switch` | `source`, `title` | User switched to a different window/tab. |
| `context_open` | `opener_context_id`, `source` | New window/tab opened. |
| `context_close` | `window_closing` | Window/tab closed. |

### Extension only

| Type | Key fields | Description |
|---|---|---|
| `navigate` | `nav_type`, `url` | Page navigation. `nav_type`: link, typed, reload, back_forward, spa, form_submit, etc. |
| `file_upload` | `element`, `files` | File(s) selected via input. `files`: `[{name, size, mime}]`. |

### Desktop (Windows) only

| Type | Key fields | Description |
|---|---|---|
| `file_dialog` | `dialog_type`, `file_path`, `source` | File dialog completed. `dialog_type`: open, save, save_as. |

---

## Element

Describes the UI element an action targeted.

```json
{
  "tag": "BUTTON",
  "id": "submit-btn",
  "name": null,
  "role": "button",
  "type": "submit",
  "text": "Log in",
  "selector": "#submit-btn"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `tag` | string | yes | HTML tag or accessibility role name. |
| `id` | string \| null | no | Element ID attribute. |
| `name` | string \| null | no | Name attribute or accessibility name. |
| `role` | string \| null | no | ARIA role or accessibility role. |
| `type` | string \| null | no | Input type attribute. |
| `text` | string \| null | no | Visible text (truncated to 100 chars). Null for passwords. |
| `selector` | string | yes | CSS selector (extension) or accessibility tree path (desktop). |

---

## JSON Schema files

Machine-readable schemas for validation:

- [`schemas/extension.schema.json`](../schemas/extension.schema.json) — Chrome extension
- [`schemas/desktop-windows.schema.json`](../schemas/desktop-windows.schema.json) — Windows desktop
- [`schemas/shared.schema.json`](../schemas/shared.schema.json) — Shared definitions (not used directly for validation)

---

## Field stability

All fields documented above are **stable** — they will not be removed or have
their semantics changed without a major version bump.

Fields may be **added** in minor versions. Consumers should ignore unknown fields
rather than failing on them.
