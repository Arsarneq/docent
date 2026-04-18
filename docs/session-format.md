# Docent — Session Format

Version: 1.0.0

This document defines the `.docent.json` export format.
It is the contract between the Chrome extension and any downstream system.

Breaking changes increment the version number.

---

## Data hierarchy

```
Project
  └── Recording[]
        └── Step[] (all version records)
```

---

## Top-level structure

```json
{
  "project":    { ... },
  "recordings": [ ... ]
}
```

`project` contains metadata only (id, name, created_at). `recordings` is the full array — each entry contains all step version records in `steps`, plus a pre-resolved `activeSteps` array containing only the current active steps in order.

---

## Project object

| Field        | Type   | Description                              |
|--------------|--------|------------------------------------------|
| `project_id` | string | UUID v7 — unique project identifier      |
| `name`       | string | Human-readable project name              |
| `created_at` | string | ISO 8601 timestamp                       |

---

## Recording object (in `recordings` array)

| Field           | Type   | Description                                       |
|-----------------|--------|---------------------------------------------------|
| `recording_id`  | string | UUID v7 — unique recording identifier             |
| `name`          | string | Human-readable recording name                     |
| `created_at`    | string | ISO 8601 timestamp                                |
| `steps`         | array  | All step records for this recording (all versions)|
| `activeSteps`   | array  | Pre-resolved active steps, sorted by step_number  |

---

## Step record

| Field              | Type    | Description                                                    |
|--------------------|---------|----------------------------------------------------------------|
| `uuid`             | string  | UUID v7 — unique record ID, embeds creation timestamp          |
| `logical_id`       | string  | UUID v7 — groups all versions of the same logical step         |
| `step_number`      | number  | Position in the sequence (1-based)                             |
| `created_at`       | string  | ISO 8601 — when this version record was created                |
| `narration`        | string  | Natural language description of the step                       |
| `narration_source` | string  | Always `"typed"`                                               |
| `actions`          | array   | Ordered browser actions captured during this step              |
| `deleted`          | boolean | `true` if this record is a soft-delete tombstone               |

### Versioning rules

- Multiple records sharing the same `logical_id` are versions of the same step
- The record with the **latest `uuid`** (UUID v7 is time-ordered) is active
- Records with `deleted: true` are tombstones — the step is considered removed
- Restoring a step creates a new record copying old narration/actions with a fresh `uuid`

---

## Action types

### `navigate`
```json
{
  "type":      "navigate",
  "nav_type":  "link",
  "timestamp": 1713261600000,
  "url":       "https://app.example.com/dashboard",
  "tab_id":    42,
  "frame_src": null
}
```

`nav_type` values: `link`, `typed`, `reload`, `back_forward`, `spa` (in-page SPA navigation), `auto_bookmark`, `generated`, `start_page`, `form_submit`, `keyword`

### `tab_switch`
```json
{
  "type":      "tab_switch",
  "timestamp": 1713261620000,
  "tab_id":    43,
  "url":       "https://other-app.example.com/",
  "title":     "Other App"
}
```

### `tab_open`
```json
{
  "type":          "tab_open",
  "timestamp":     1713261625000,
  "tab_id":        44,
  "opener_tab_id": 42,
  "url":           null
}
```

### `tab_close`
```json
{
  "type":           "tab_close",
  "timestamp":      1713261630000,
  "tab_id":         44,
  "window_closing": false
}
```

### `click`
```json
{
  "type":      "click",
  "timestamp": 1713261603200,
  "tab_id":    42,
  "frame_src": null,
  "x": 540, "y": 320,
  "element": {
    "tag": "BUTTON", "id": "btn-new-project", "name": null,
    "role": "button", "type": "submit",
    "text": "New Project", "selector": "#btn-new-project"
  }
}
```

### `type`
```json
{
  "type":      "type",
  "timestamp": 1713261615200,
  "tab_id":    42,
  "frame_src": null,
  "element": {
    "tag": "INPUT", "id": "project-name", "name": "projectName",
    "role": null, "type": "text", "text": "", "selector": "#project-name"
  },
  "value": "Website Redesign"
}
```

### `select`
```json
{
  "type":      "select",
  "timestamp": 1713261616800,
  "tab_id":    42,
  "frame_src": null,
  "element": {
    "tag": "SELECT", "id": "project-template", "name": "template",
    "role": null, "type": null,
    "text": "Agile Board", "selector": "#project-template"
  },
  "value": "Agile Board"
}
```

### `key`
```json
{
  "type":      "key",
  "timestamp": 1713261610000,
  "tab_id":    42,
  "frame_src": null,
  "key":       "Enter",
  "modifiers": { "ctrl": false, "shift": false, "alt": false, "meta": false },
  "element": { "tag": "INPUT", "selector": "#search-box", ... }
}
```

### `right_click`
```json
{
  "type":      "right_click",
  "timestamp": 1713261611000,
  "tab_id":    42,
  "frame_src": null,
  "x": 400, "y": 200,
  "element": { "tag": "IMG", "selector": "img:nth-of-type(1)", ... }
}
```

### `focus`
```json
{
  "type":      "focus",
  "timestamp": 1713261612000,
  "tab_id":    42,
  "frame_src": null,
  "element": { "tag": "INPUT", "id": "search", "selector": "#search", ... }
}
```

### `file_upload`
```json
{
  "type":      "file_upload",
  "timestamp": 1713261613000,
  "tab_id":    42,
  "frame_src": null,
  "element":   { "tag": "INPUT", "type": "file", "selector": "#avatar-upload", ... },
  "files": [
    { "name": "photo.jpg", "size": 204800, "mime": "image/jpeg" }
  ]
}
```

### `drag_start`
```json
{
  "type":      "drag_start",
  "timestamp": 1713261614000,
  "tab_id":    42,
  "frame_src": null,
  "element":   { "tag": "LI", "selector": "li:nth-of-type(2)", ... }
}
```

### `drop`
```json
{
  "type":           "drop",
  "timestamp":      1713261615000,
  "tab_id":         42,
  "frame_src":      null,
  "x":              300, "y": 500,
  "element":        { "tag": "UL", "selector": "#done-column", ... },
  "source_element": { "tag": "LI", "selector": "li:nth-of-type(2)", ... }
}
```

### `scroll`
```json
{
  "type":        "scroll",
  "timestamp":   1713261616000,
  "tab_id":      42,
  "frame_src":   null,
  "element":     null,
  "scroll_top":  1200,
  "scroll_left": 0,
  "delta_y":     800,
  "delta_x":     0
}
```

> `element` is `null` for page-level scroll. `frame_src` is `null` for the top frame and the iframe URL for embedded frames.

---

## Resolution algorithm

To resolve active steps from a raw recording (for systems that read `project.recordings`
rather than the pre-resolved `recordings[].activeSteps`):

```js
function resolveActiveSteps(recording) {
  const groups = new Map();
  for (const step of recording.steps) {
    const existing = groups.get(step.logical_id);
    if (!existing || step.uuid > existing.uuid) {
      groups.set(step.logical_id, step);
    }
  }
  return Array.from(groups.values())
    .filter(step => !step.deleted)
    .sort((a, b) => a.step_number - b.step_number);
}
```

---

## File naming convention

```
{project_name}_{unix_timestamp}.docent.json
```

Example: `Acme_CRM_1713261700000.docent.json`

---

## Version history

| Version | Change |
|---------|--------|
| 1.0.0   | Initial release |
