# Capture Principles — Chrome Extension

Platform-specific details for the extension. See [core rules](../../../architecture/system/capture-principles.md).

Each rule carries a stable identifier (**ECP-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../../clause-registry.json). The
key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and can appear out of numeric sequence.

---

## Architecture

1. **Recorder** (`content/recorder.js`) — DOM events in the page, running in the
   content-script isolated world
2. **Service worker** (`background/service-worker.js`) — Chrome APIs for browser chrome proxies

**ECP-1.** The service worker imports everything it needs **statically at
module scope** — a Manifest V3 service worker cannot use dynamic `import()`
(it throws at runtime). A lint rule on the background layer and a guard test
enforce this at the worker's entry module.

**ECP-2.** The recorder is **not** a passive `<all_urls>` content script. It
is injected programmatically by the service worker, and **only while a
recording is active**:

- On record-start, the service worker injects the recorder into every open
  http/https tab and frame.
- For the rest of the recording, each frame is injected as it finishes loading
  (`webNavigation.onCompleted`), so newly opened tabs, navigations, and
  dynamically created iframes are covered as they appear.

When no recording is running, nothing is injected and nothing captures: the
service worker injects no recorder, and recorder instances a prior recording
left in still-open documents are inactive — each deactivates in place through
its `recording` watch — until navigation replaces their documents. The idle
surface that acts is just the service worker. (The
`host_permissions: <all_urls>` grant is retained by decision: it is what lets
the service worker inject into any page the moment recording starts.)

### Frame trust and readiness

**ECP-3.** Because actions arrive at the service worker as messages, the
service worker validates every inbound `APPEND_ACTION` against an in-memory
**active-frame registry** (tab → frames): a message MUST be accepted only when
it comes from this extension, during a live recording, from a (tab, frame)
pair present in the registry. Anything else — an embedded ad, analytics, or
third-party widget that can reach the message port — is dropped.
The registry is seeded from the browser's own frame table
(`webNavigation.getAllFrames`) at record-start, and is written one frame at a
time by two further paths: the on-load registration that follows each
successful injection made as a frame finishes loading while recording, and
each injected recorder's readiness beacon. Neither is bounded by the set that
seed targets — each writes the (tab, frame) pair its own event carries — so a
tab that joins the recording after the seed ran is registered like any other.
Because it is in-memory and the service worker can be suspended, it is also
lazily reseeded from the same frame table when an append arrives from a tab
with no registry entry at all (the missing-entry signature: a suspension is
one cause, a clear whose seed does not re-cover that tab another), rather than
false-rejecting a legitimate frame whose registration is gone. An entry
departs along the registry's own routes: a subframe is dropped as it navigates
away (a main frame is left in place — its registration follows on the load), a
closed tab's frames go with the tab, and the whole registry is cleared at
record-start, ahead of the registry seed, and again on every record-stop path
— a clear the recording-flag watch repeats when one of those routes
transitions the flag, and runs alone when a writer outside them transitions
it. Whichever route runs it, that whole-registry clear is the backstop: a
frame that reaches neither the navigate-away drop nor the tab-close drop — a
subframe destroyed with its parent's navigation, say, or removed from the DOM
— keeps its entry until the next clear runs.

Each injected recorder reports readiness back to the service worker with a
`FRAME_READY` message rather than setting a page-visible flag — the recorder runs
in the isolated world, so a `window` flag would both be invisible to the service
worker and leak recording state to the page.

**ECP-4.** The action's `context_id` is stamped from the **trusted sender**,
never from the message body, so a frame cannot claim to be a different tab.

**ECP-5.** Injecting only while recording costs no capture fidelity because of
a measured bound: from a frame finishing load to the recorder reporting ready
MUST complete within half the ~200 ms deliberate-action floor — the shortest
gap in which a human plausibly performs a deliberate action — so a frame is
capture-ready before anyone can act in it (in practice the gap is well under
the bound). The floor and the
recorder's other timing windows are **causality proxies**, centralized with
their doctrine in [`lib/capture-timing.js`](../../../../packages/extension/lib/capture-timing.js);
an end-to-end spec enforces the readiness bound.

---

## Capture Surface

**ECP-6.** This platform's capture surface applies
[core CP-14](../../../architecture/system/capture-principles.md#capture-surface)'s
closed positive-enumeration principle. The recorder listens on `document`, in
the capture phase, for exactly these DOM events:

- `mousedown` — the press ahead of a click, held so a blur-caused `change` can
  be attributed to the element the user moved to
- `click` — activation of the clicked element or its nearest interactive
  ancestor
- `contextmenu` — the right-click
- `keydown` — the keys in the captured keyboard set
- `change` — a committed value: a `select` choice, an `input`/`textarea` entry,
  and a file chosen through the OS dialog
- `focusin` — a focus move, recorded only when it follows a Tab key press
- `dragstart` — the start of a drag, which names the drag source
- `dragover` — the target tracking the browser requires before a drop can fire
- `drop` — the end of a drag, paired with the source the drag started from
- `dragend` — the drag's terminal signal, which releases the source
- `scroll` — a scroll gesture, debounced and coalesced into one action
- `input` — in-progress editing of a `contenteditable` host, debounced
- `blur` — the flush that commits pending `contenteditable` editing

The service worker captures the browser-chrome proxies in the table below, each
row naming the worker event it is captured from.
[`check-capture-surface.js`](../../../../scripts/check-capture-surface.js)
holds the recorder's and the service worker's own registrations to the
enumerations above and below, in both directions, and closes the same question
over every JavaScript module the extension package ships: a `chrome.*`
registration the service worker makes is a capture proxy where the table below
names it and an admitted non-capture role otherwise, and one any other module
makes is held to that same admission list, keyed by the file that makes it;
the DOM listeners this enumeration describes are the recorder's, so a
`document` or `window` listener registered in any other module is capture it
does not describe.
Interactions that would appear covered but are not are kept as
[exceptions within the surface](#exceptions-within-the-surface) (core
[CP-15](../../../architecture/system/capture-principles.md#capture-surface)).

---

## Browser Chrome Proxies

**ECP-7.** These user actions happen in browser chrome (not visible to the
content script) and are captured by proxy as follows. The Event source column
names the registration each proxy is captured from — a service-worker event,
or, where the immediate effect lands in the page instead, one of the recorder's
[enumerated DOM events](#capture-surface):

| User action                   | Captured as                       | Event source                                                   |
| ----------------------------- | --------------------------------- | -------------------------------------------------------------- |
| Type URL + Enter              | `navigate` (typed/generated)      | `chrome.webNavigation.onCommitted`                             |
| Click back/forward            | `navigate` (back_forward)         | `chrome.webNavigation.onCommitted`                             |
| Click bookmark                | `navigate` (auto_bookmark)        | `chrome.webNavigation.onCommitted`                             |
| F5 / Ctrl+R                   | `navigate` (reload)               | `chrome.webNavigation.onCommitted`                             |
| Click a tab                   | `context_switch`                  | `chrome.tabs.onActivated`                                      |
| Ctrl+T / Ctrl+N               | `context_open`                    | `chrome.tabs.onCreated`                                        |
| Ctrl+W / click X              | `context_close`                   | `chrome.tabs.onRemoved`                                        |
| Ctrl+Shift+T                  | `context_open`                    | `chrome.tabs.onCreated`                                        |
| Select file in OS dialog      | `file_upload`                     | `change` (the recorder's own surface, correlated with a click) |
| Right-click → Open in new tab | `context_open` + `navigate(link)` | `chrome.tabs.onCreated` + `chrome.webNavigation.onCommitted`   |

---

## Filtering Approach

**ECP-8.** Programmatic events are filtered from the action stream by
observable signals:

- `event.isTrusted` rejects programmatic DOM events
- Chrome's `transitionType` identifies browser chrome navigations vs effects
- `programmaticTabs` set tracks tabs from `window.open()`
- Timing windows centralized in `lib/capture-timing.js` (see code for values)
- SPA navigation capture removed entirely (all are effects of captured clicks/keys)

---

## Sensitive-value redaction

**ECP-9.** Password fields are masked from the field's own signal
(`type="password"`) when the element is described. The remaining sensitive
classes — payment fields designated by their `autocomplete` tokens, and fields
whose name/id matches the shared financial/secret/SSN pattern — are masked at
the service worker's **storage chokepoint**, which processes each action's
`element` (and its `value`/`url`) before the action is stored. Both the shared
detection and the redaction shape are the cross-platform rule
([core CP-11](../../../architecture/system/capture-principles.md#sensitive-values)).

Locator candidates pass the chokepoint with one exception: the `text` strategy
is value-derived, so its value is masked in place (`masked: true`) on
sensitive elements; the derived `css` value is structural by construction —
ids, test attributes, tag names and positions — and carries no rendered text.
(Which strategies are value-derived is declared per strategy by the schema's
`x-value-derived` annotation — [locator-resolution §LR-24](../../../technical/locator-resolution.md).)

**ECP-10.** Captured URLs are redacted by query-parameter name — the
**tokened-URL redaction** the [core rules](../../../architecture/system/capture-principles.md)
name as browser-only: the values of known-sensitive parameters in a `navigate`
action's `url` are masked before storage, and other parameters are preserved
so the workflow stays reproducible. The exact masked-parameter names are
enumerated by the schema's `url` description and pinned to the shared
detection set by a composition test.

---

## Storage pressure

**ECP-11.** Captured actions live in `chrome.storage.local` (10 MiB quota)
until committed, and capture pauses under storage pressure rather than failing
mid-write: at 8 MiB in use, new captures stop being appended and the user sees
a storage warning with an explicit resume control; capture resumes
automatically once usage drops below 7.5 MiB (hysteresis, so the state cannot
flap at the boundary). A write that throws `QuotaExceededError` pauses
capture the same way (the `exceeded` band — nothing writes past a physically
full quota), and pressure never evicts: stored projects and the
already-captured buffer are left untouched, with space freed only by the
user's own actions. Actions performed while paused are not captured — the
pause is user-visible for exactly that reason. End-to-end specs pin the state
machine, including live-capture behaviour at the boundary.

---

## Exceptions Within the Surface

**ECP-12.** This platform's exceptions within the surface (core
[CP-15](../../../architecture/system/capture-principles.md#capture-surface)) —
interactions that would appear to be inside the
[capture surface](#capture-surface) above but are not captured (or are captured
with a caveat):

- Keyboard shortcuts not in `CAPTURE_KEYS` are not captured as key events —
  the keyboard surface is the whitelist, not all keys
- Arrow keys in native `<select>` are swallowed by the browser before the
  recorder's listeners see them
- `window.open()` detection uses a timing window (see `capture-timing.js`)
- `window.close()` detection uses a timing window on programmatic tabs
- Scroll gestures are debounced and coalesced with a sub-threshold discard —
  the shared rule in
  [core CP-16](../../../architecture/system/capture-principles.md#capture-surface)
- Actions performed during a [storage-pressure pause](#storage-pressure) are
  not captured
