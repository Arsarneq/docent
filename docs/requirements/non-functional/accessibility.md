# Accessibility — Non-Functional Requirements

The accessibility posture of Docent's own user interface, stated as it is
today. Docent has two distinct relationships to accessibility — the
accessibility of its own panels (this document), and the capture layer's
consumption of accessibility APIs as a data source (owned by the capture
documents and distinguished below). The panel UI both platforms render is
the shared views fragment and its rendering functions
([Shared Core — one fragment, two shells](../../architecture/system/shared-core.md#shared-views--one-fragment-two-shells));
this document claims nothing beyond what is in that markup, its stylesheet,
and those functions' output.

## Conformance posture

Docent states no accessibility conformance target for its own UI, and no
automated accessibility check runs in CI. What the shipped UI provides is
exactly the enumeration below.

## What the shipped panel provides

From [`views.html`](../../../packages/shared/views/views.html) and
[`panel.css`](../../../packages/shared/views/panel.css):

- Most interactive controls are native HTML elements — `<button>`,
  `<input>`, `<textarea>`, `<label>`, `<details>`/`<summary>` — reachable
  and activatable through the browser's or webview's native keyboard
  semantics. The fragment defines no `tabindex` of its own. Two documented
  interactions are mouse-only today: opening a step's recorded actions is a
  click on the narration text, rendered as a plain `<span>` with no keyboard
  path, and step reorder is drag-only (`draggable="true"`, no keyboard
  alternative).
- The four radio option groups (step type and expectation in the recording
  view; theme and recording mode in Settings) are native radio inputs
  grouped under `role="radiogroup"`, each group named by an `aria-label`.
- Decorative SVG icons carry `aria-hidden="true"`. In the fragment each icon
  sits beside a visible text label on its control; the icon-only row controls
  the rendering functions produce (re-record, history, and the delete
  controls) carry a `title` attribute and no other accessible name
  ([`render.js`](../../../packages/shared/views/render.js)).
- The sync resolution view's redirect notice is announced with
  `role="status"`
  ([sync-conflict-ui.js](../../../packages/shared/sync-conflict-ui.js)).
- Focus indication: text, textarea, and password inputs replace the default
  outline with an accent border plus a shadow ring; every other control
  keeps the browser's default focus outline (the stylesheet leaves it
  untouched).
- A theme setting offers light, dark, and follow-browser (relabelled
  follow-system on the desktop — the one assembly transform
  [Shared Core](../../architecture/system/shared-core.md#shared-views--one-fragment-two-shells)
  owns).

## Distinct: accessibility APIs as a capture data source

The desktop capture layer reads the Windows UI Automation tree to describe
acted-on elements, and the extension records ARIA roles and accessible
names among its locator candidates
([Session Format — element and locators](../../technical/session-format.md#element)).
That concerns the accessibility of the **applications being recorded**: the
richness of a recording depends on the target application's accessibility
data, and a desktop element without it falls back to coordinate capture
([desktop guide](../../user/desktop-windows.md#record-a-workflow)). It is a
separate property from the conformance posture of Docent's own panels,
which is only what the section above enumerates.
