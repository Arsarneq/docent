# Docent — Reading Guidance

This document describes the structure and meaning of a Docent dispatch payload.

---

## What you are receiving

A project recorded in a real browser or desktop application, with narration for each step.
The narration for each step was provided in natural language and then the actions were performed.
The payload contains one or more recordings, each with an ordered list of steps.
Each step pairs a natural language narration with the exact actions recorded.

The full step history is included — all versions of each step (re-recorded, deleted) are present.
To resolve the "active" view: group steps by `logical_id`, take the latest `uuid` per group,
and exclude those with `deleted: true`.

---

## Payload structure

The dispatch payload has four top-level fields:

- `reading_guidance` — this document (human-readable context)
- `schema` — the JSON Schema object describing the data structure
- `project` — project metadata (id, name, created_at)
- `recordings` — array of recordings, each with full step history

---

## Notes

- Passwords are always captured as `"••••••••"`.
- `context_id` values are session-scoped identifiers (browser tab IDs or desktop window handles) — they are not persistent across restarts.
- `capture_mode` indicates how each action was captured: `"dom"` for browser, `"accessibility"` for native UI elements, or `"coordinate"` for fallback coordinate-based capture.
- Context lifecycle actions (`context_switch`, `context_open`, `context_close`) use a `source` field containing the page URL (browser) or executable path (desktop).
- Each step has a `deleted` boolean and a `uuid` for version ordering. Multiple steps can share a `logical_id` — these are versions of the same step.
