# Docent — Reading Guidance

This document describes the structure and meaning of a Docent dispatch payload.

---

## What you are receiving

A project recorded in a real browser, with narration for each step.
The narration for each step was provided in natural language and then the actions were performed.
The payload contains one or more recordings, each with an ordered list of steps.
Each step pairs a natural language narration with the exact browser actions recorded.

---

## Payload structure

```
reading_guidance  — this document

project
  project_id        — unique project identifier (UUID v7)
  name              — human-readable project name
  created_at        — ISO 8601 timestamp

recordings[]
  recording_id      — unique recording identifier (UUID v7)
  name              — human-readable recording name
  created_at        — ISO 8601 timestamp
  steps[]           — ordered steps for this recording
    logical_id      — unique step identifier (UUID v7)
    step_number     — position in the sequence (1-based)
    narration       — what was narrated for this step (natural language)
    actions[]       — browser actions recorded during this step, in order
      type          — action type (see below)
      timestamp     — unix milliseconds
      tab_id        — which browser tab the action occurred in
      frame_src     — iframe URL if action occurred inside an iframe, null for top frame
```

---

## Action types

### `navigate`
```
url       — the URL navigated to
nav_type  — how the navigation was triggered:
              link         — user clicked a link
              typed        — user typed in the address bar
              reload        — page was reloaded
              back_forward  — browser back or forward button
              spa           — in-page SPA navigation (pushState/popstate)
              form_submit   — form submission
              auto_bookmark, generated, start_page, keyword — other browser-initiated
```

### `click`
```
x, y      — viewport coordinates
element   — the clicked element (see Element below)
```

### `right_click`
```
x, y      — viewport coordinates
element   — the right-clicked element
```

### `type`
```
element   — the input element
value     — the value entered; passwords are always "••••••••"
```

### `select`
```
element   — the select element
value     — the visible text of the selected option
```

### `key`
```
key       — the key pressed: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight
modifiers — { ctrl, shift, alt, meta } booleans
element   — the element that had focus
```

### `focus`
```
element   — the input/textarea/contenteditable that received focus
```

### `file_upload`
```
element   — the file input element
files[]   — array of { name, size, mime } — file contents are never captured
```

### `drag_start`
```
element   — the element that was dragged
```

### `drop`
```
element        — the drop target
source_element — the element that was dragged (null if drag started before recording)
x, y           — drop coordinates
```

### `scroll`
```
element      — the scrolled element, null for page-level scroll
scroll_top   — final vertical scroll position
scroll_left  — final horizontal scroll position
delta_y      — vertical distance scrolled (positive = down)
delta_x      — horizontal distance scrolled (positive = right)
```

### `tab_switch`
```
tab_id  — the tab switched to
url     — URL of the tab
title   — page title of the tab
```

### `tab_open`
```
tab_id        — the new tab's ID
opener_tab_id — the tab that opened it, null if unknown
url           — initial URL, null if blank
```

### `tab_close`
```
tab_id         — the closed tab's ID
window_closing — true if the entire window was closed
```

---

## Element descriptor

Included on click, right_click, type, select, key, focus, file_upload, drag_start, drop actions.

```
tag       — HTML tag name (e.g. BUTTON, INPUT, A)
id        — element id attribute, null if absent
name      — name attribute, null if absent
role      — ARIA role attribute, null if absent
type      — type attribute (e.g. text, submit, checkbox), null if absent
text      — visible text content, truncated to 100 chars, null if empty
selector  — CSS selector — id-based when possible, otherwise nth-of-type path
```

---

## Notes

- Passwords are always captured as `"••••••••"`.
- `tab_id` values are Chrome's internal tab identifiers for the recording session — they are not persistent across browser restarts.
