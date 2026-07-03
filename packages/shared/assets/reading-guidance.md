# Docent — Reading Guidance

This document describes the structure and meaning of a Docent dispatch payload.

---

## What you are receiving

A project recorded in a real browser or desktop application. The payload contains
one or more recordings, each with an ordered list of steps. Each step pairs context
with the exact actions recorded during that step.

Each step carries its context in one of two modes:

- **Narration mode** — a free-text, natural-language description of the step's intent (`narration`).
- **Simple mode** — a structured classification (`step_type`: `action` or `validation`; validation steps also carry an `expect` value such as `present` or `absent`).

A step has at least one of these; both may be present.

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

- Passwords are always captured as `"••••••••"`. Masked and redacted values in
  general are replay parameters: the recording states where a value goes (the
  element's identity and its `redacted`/`masked` flags), and the reader
  supplies the value itself when reproducing the session.
- `context_id` values are session-scoped identifiers (browser tab IDs or desktop window handles) — they are not persistent across restarts.
- `capture_mode` indicates how each action was captured: `"dom"` for browser, `"accessibility"` for native UI elements, or `"coordinate"` for fallback coordinate-based capture.
- Context lifecycle actions (`context_switch`, `context_open`, `context_close`) use a `source` field containing the page URL (browser) or executable path (desktop).
- Each step has a `deleted` boolean and a `uuid` for version ordering. Multiple steps can share a `logical_id` — these are versions of the same step.
- An element may include `locators` — observed ways the element could be addressed at capture time. Each entry may carry its own match statistics (`match_count` / `match_index`, measured at capture time; absent means not measured); the list order carries no ranking. Entries flagged `masked: true` had sensitive values masked in place.
- An element may include `described_after_ms` — how many milliseconds after the action's timestamp its description (and any match statistics) was observed. `0` means at the input itself; larger values mean the interface may already have reacted to the action.
