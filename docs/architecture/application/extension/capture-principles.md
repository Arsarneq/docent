# Capture Principles — Chrome Extension

Platform-specific details for the extension. See [core rules](../../../architecture/system/capture-principles.md).

Where to look:

| You want to know                                                                          | Read                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Which DOM events the recorder listens for, and what each records                          | [Capture Surface](#capture-surface)                                                       |
| What is left out inside that surface, or recorded differently                             | [Exceptions Within the Surface](#exceptions-within-the-surface)                           |
| How tab, navigation and other browser-chrome actions are captured                         | [Browser Chrome Proxies](#browser-chrome-proxies)                                         |
| How the recorder and the service worker split the work, and which frames may send actions | [Architecture](#architecture) and [Frame trust and readiness](#frame-trust-and-readiness) |
| Why an event the page's own code fires is not recorded                                    | [Filtering Approach](#filtering-approach)                                                 |
| Which values are masked, in fields and in URLs                                            | [Sensitive-value redaction](#sensitive-value-redaction)                                   |
| What happens when storage runs low                                                        | [Storage pressure](#storage-pressure)                                                     |

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
recording is active**, by exactly these two routes:

- On record-start, the service worker sweeps the open http/https tabs: the
  scheme test is the tab's — every frame of a swept tab that the browser lets
  the extension reach is injected, whatever scheme its own document carries.
- For the rest of the recording, each frame is injected as it finishes loading
  (`webNavigation.onCompleted`), whenever the browser lets the extension reach
  it — no scheme test on this path — so, for example, newly opened tabs,
  navigations, `srcdoc` frames, and dynamically created iframes are covered as
  they appear.

When no recording is running, nothing is injected and nothing captures: the
service worker injects no recorder, and recorder instances a prior recording
left in still-open documents are inactive — each deactivates in place through
its `recording` watch — until navigation replaces their documents. The idle
surface that acts is just the service worker. (The
`host_permissions: <all_urls>` grant is retained by decision: it is what lets
the service worker inject into any open http/https tab the moment recording
starts, and into each frame that finishes loading for the rest of the
recording, on whatever host the browser lets the extension reach.)

### Frame trust and readiness

**ECP-3.** Because actions arrive at the service worker as messages, the
service worker validates every inbound `APPEND_ACTION` against an in-memory
**active-frame registry** (tab → frames): a message MUST be accepted only when
it comes from this extension, during a live recording, from a (tab, frame)
pair present in the registry. Anything else — for example an embedded ad,
analytics, or third-party widget that can reach the message port — is dropped.
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
departs along exactly three routes, the registry's own: a subframe is dropped
as it navigates
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
recorder's other timing windows are **causality proxies**. The floor, with its
doctrine, and the windows the module declares live in
[`lib/capture-timing.js`](../../../../packages/extension/lib/capture-timing.js);
the recorder carries its windows inline — copies of the module's values it uses,
and windows of its own the module does not declare — and the service worker
carries an inline window of its own, the repeat window ECP-12 names; an
end-to-end spec enforces the readiness bound.

---

## Capture Surface

**ECP-6.** This platform's capture surface applies
[core CP-14](../../../architecture/system/capture-principles.md#capture-surface)'s
closed positive-enumeration principle. The recorder listens, in the capture
phase, for exactly these DOM events, on `document` unless the item names
`window`:

- `mousedown` — the press ahead of a click, held so a blur-caused `change` can
  be attributed to the element the user moved to
- `click` — activation of the clicked element or its nearest interactive
  ancestor (the set the recorder tests is stated in the session-format
  document's action table; core CP-18); a click on a `label` is the label's,
  and the click the browser sends on to the labelled control is part of it; a
  click the browser derives from a captured key press (Enter or Space on a
  button, an arrow key in a radio group, for example) is that key's effect
  (core CP-6) and writes nothing: it carries no pointer, and the browser sends
  it while it handles one of that key's events; the click a native `select`
  sends when its list closes from the keyboard is an effect of the same kind
  and writes nothing (the keys pressed inside the open list do not reach the
  page, so the closing leaves no other trace)
- `contextmenu` — the right-click, its element picked as for `click`
- `keydown` — the keys in the captured keyboard set: Enter, Escape, Tab and
  the four arrow keys on the focused element, and Space on a focused element
  that takes no typed text (in an `input` whose value is free text, a
  `textarea` or editable content the space is text, which the field's `type`
  records; on any other `input`, a date or number field included, it is a
  key press);
  each press is written with whether the browser's key repeat generated it:
  holding a key down is the person's input (core CP-5), and each repeated
  press is that hold as the browser reports it, written and marked so that it
  is told from a separate physical press; a press made while an `input` or
  `textarea` holds an entry not yet written writes that entry's `type` first,
  the entry being complete before the press that follows it; a value the page
  set, with no key pressed in the field, is not an entry, and an entry already
  written writes nothing again when the browser commits the field; each
  press is also written with `held_keys`, the other keys that are down and
  whose key-down was written as a `key` (the press, or the first repeat the
  document saw when it did not see the press; not yet released), by the names
  those `key` actions carry, in the order they went down, and a `click`, a
  `contextmenu`, a `dragstart` and a `drop` write the same list beside the
  modifier keys their event reports
- `keypress` — the character event of a captured key press, which writes
  nothing: with `keydown` and `keyup` it marks the task in which the browser
  derives a click from the key
- `keyup` — the release of a captured key, which writes nothing and ends the
  key's time among the held keys, while the recording is off as well; the
  browser derives the click of a Space press from it
- `change` — a committed value: a `select` choice, an `input`/`textarea` entry,
  and a file chosen through the OS dialog; a checkbox or radio toggle is
  recorded by the `click` or the `key` that made it, so its `change` writes
  nothing
- `focusin` — a focus move, recorded only when it follows a Tab key press; the
  value an `input` or `textarea` holds when it takes focus is noted, so an
  entry made since can be told from one already written
- `dragstart` — the start of a drag, which names the drag source; the browser
  sends the page no key events while a drag lasts, so no key is known to be
  down from here on, and the `drop` states none
- `dragover` — the target tracking the browser requires before a drop can fire
- `drop` — the end of a drag, paired with the source the drag started from
- `dragend` — the drag's terminal signal, which releases the source
- `scroll` — a scroll gesture, debounced and coalesced into one action
- `input` — in-progress editing of a `contenteditable` host, debounced
- `blur` — the flush that commits pending `contenteditable` editing
- `blur` on `window` — the window lost the focus, which writes nothing: a key
  released while another window has the focus sends its release there, so no
  key is known to be down from then on (the `held_keys` of later actions)

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

The table's user-action rows illustrate; its event sources are the fixed set
ECP-6 holds the worker's registrations to, as core CP-14 requires. Which
navigations get a proxy is decided by the service worker's committed-navigation
handler — its browser-chrome transition set, its redirect skip and its new-tab
exception among its rules; the context rows are the tab events the
capture-surface check holds the worker to under ECP-6, and the file-upload row
the DOM surface that clause lists.

The Right-click → Open in new tab row is
the menu pick's proxy as core CP-17 states it: the `context_open` and the
navigation that loads the link's destination together record the establishment.
A click on a link the browser opens in a new tab, and a click whose page opens a
window, are captured directly, and core CP-17 places the new context's entries
beside them; the worker's suppression of a tab created in correlation with an
in-page action (its recent-action test, ECP-8) withholds their `context_open`, a
capture gap against core CP-17, whose link half
[docent#252](https://github.com/Arsarneq/docent/issues/252) tracks.

---

## Filtering Approach

**ECP-8.** Programmatic events are filtered from the action stream by
observable signals:

- `event.isTrusted` rejects programmatic DOM events
- Chrome's `transitionType` identifies browser chrome navigations vs effects
- `programmaticTabs` set tracks every tab created within 500 ms after an
  in-page action (`window.open()` and its like)
- Timing windows (ECP-5 states where each lives; see code for values)

The listed signals illustrate how this clause reads the stream;
core CP-2 decides what the filter excludes: CP-6's effects, save a proxy (CP-7)
and a context's establishment entries (CP-17); ECP-12 lists the surface's
exceptions, and ECP-7 the establishment entries the worker withholds. Same-document (SPA) navigations are not
captured: navigate proxies come from committed navigations only, and no
history-state or fragment listener exists.

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
exactly ids, test attributes, tag names and positions — and carries no rendered
text.
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

- Keys and keyboard shortcuts outside the captured keyboard set ECP-6 states
  (`CAPTURE_KEYS`, and Space where it is not typed text) are not captured as
  key events — the keyboard surface is that set, not all keys; the desktop
  writes such a key press where it enters no text into a field, so this is a
  departure (core CP-19;
  [docent#702](https://github.com/Arsarneq/docent/issues/702))
- Arrow keys in native `<select>` are swallowed by the browser before the
  recorder's listeners see them
- A key that is down but was pressed while another document had the focus
  (another frame, another tab or window) is not among an action's `held_keys`,
  and no key is known to be down once the document's window loses the focus
  or a drag starts:
  the browser delivers a key's events to the focused document only, sends the
  page none while a drag lasts, and offers
  no reading of the keyboard's state. From the moment the focus leaves a
  document, nothing the browser delivers says whether a key that was down
  still is: its release can reach another frame, a page the extension does not
  run in, the browser's own interface or another program. Carrying the key
  over from the document that saw it go down would state a key as down that could already have been released, so it is not done. The desktop's keyboard hook is
  handed every key wherever the focus is and names such a key; the difference
  comes from the platforms themselves (core CP-19). A key still held when the
  focus returns or the drag has ended is named again from its next repeat
- Back/forward between same-document entries (an SPA's history) — a
  browser-chrome action; the worker's committed-navigation listener does not
  report it
- Back/forward that moves only an embedded frame's document — the committed
  navigation is the frame's, and the worker proxies a tab's main-frame
  navigations only, so no `navigate` is written
- A second navigation to the same address within the worker's repeat window
  (five seconds) of the last recorded one, reloads excepted — dropped as a
  repeat, a genuine re-navigation the user asked for dropped with it; a
  departure (core CP-18)
- A browser-chrome navigation the server or the page redirected — the
  committed navigation carries a redirect qualifier and the handler skips it,
  so a typed address the site redirects records no `navigate`; a departure
  (core CP-18)
- A navigation into an internal scheme (`chrome://`, `chrome-extension://`,
  `about:`), a typed address among them — the worker skips those schemes for
  every navigation, whatever its transition type, before any proxy is
  considered
- `window.open()` detection uses a timing window (see `capture-timing.js`)
- A tab the user opened (Ctrl+T, Ctrl+N, Ctrl+Shift+T) within 500 ms after an
  in-page action — no `context_open` written, the tab being taken for a
  page-opened one; a departure (core CP-18)
- `window.close()` detection uses a timing window on programmatic tabs
- The close, within 2000 ms after an in-page action, of a tab the user opened
  within 500 ms after an in-page action — not written, the tab being in the
  programmatic set; a departure (core CP-18)
- The user's close (Ctrl+W or the tab's X), within 2000 ms after an in-page
  action, of a tab a page opened — not written, the close being taken for the
  page's `window.close()`; a departure (core CP-18)
- A click or right-click whose picked element is the body or the document
  element — not written; a departure (core CP-18)
- A click on a `label` inside a closed shadow root — written twice, both
  against the shadow host: the label's click and the click the browser sends
  on to its control, since the closed root hides the label from the recorder;
  a departure (core CP-18)
- A captured key other than Tab while nothing is focused — not written; a
  departure (core CP-18), and one from the desktop, which writes the key on a
  stand-in element (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- A click that carries no pointer and reaches the page outside a captured
  key's events (an activation an assistive technology sends, or one a key
  outside the captured set causes, an `accesskey` shortcut for example) —
  written as a `click` with the coordinates its event carries, though no
  pointer was at that point; a departure (core CP-18). A native `select` is
  the exception: a click with no pointer on one is not written, whatever sent
  it, an activation an assistive technology sends to a `select` included
- A value entered with no key pressed in the field since it took focus (a
  paste from the context menu, a drop, an autofill) — its `type` is written
  when the browser commits it, which can follow a captured key pressed after
  it; a departure (core CP-18)
- A captured key whose press also scrolls (an arrow key, or Space on a focused
  element it does not activate, a link for example) — written as the `key`
  and, where the scroll clears the floor (core CP-16), as a `scroll` too: one
  press, two actions; a departure (core CP-18), and one from the desktop,
  whose `scroll` comes from wheel input only (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- A `type` on an input or textarea when a button or input marked
  `type="submit"` in the same form was pressed, with any mouse button, within
  100 ms of the change — not written (a `<button>` with no `type` attribute
  does not trigger the skip); a departure (core CP-18;
  [docent#223](https://github.com/Arsarneq/docent/issues/223))
- The first activation of a tab opened in the background, when no tab was
  created after it — not written; a departure (core CP-18)
- The activation of a tab with no address — not written; a departure
  (core CP-18)
- The activation of a `chrome://` or `chrome-extension://` tab — not written,
  the internal schemes being outside the surface as for a typed address
- A Tab-focus of a password field — not written; a departure (core CP-11)
- A Tab focus move onto an element other than an input, a textarea or a
  contenteditable host (a button, a link or a select, for example) — no
  `focus` is written; the Tab `key` is written against the element it left; a
  departure (core CP-18), and one from the desktop, which writes the `focus` (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- Scroll gestures are debounced and coalesced with a sub-threshold discard —
  the shared rule in
  [core CP-16](../../../architecture/system/capture-principles.md#capture-surface);
  the quantity here is the change in the scrolled container's offset in the
  document's layout pixels — read today from the first scroll event's target
  to the last event's, so the first event's own movement is left out and a
  sequence that moves across containers subtracts two targets' offsets, a
  departure ([docent#251](https://github.com/Arsarneq/docent/issues/251)) — and the floor is declared as
  `SCROLL_MIN_DISTANCE_PX` in `lib/capture-timing.js` and applied inline in
  the content script
- Actions performed during a [storage-pressure pause](#storage-pressure) are
  not captured
- A middle-button click — the recorder listens for no `auxclick`, so the click
  is not recorded; a tab it opens arrives as a `context_open` with no action
  behind it; the desktop records the click, so this is a departure (core CP-19;
  [docent#707](https://github.com/Arsarneq/docent/issues/707))
- A pointer drag that is not HTML5 drag-and-drop (a slider, a splitter, a text
  selection) — recorded as the click its release produces, not as a
  `drag_start`/`drop` pair, which the desktop records; a departure (core CP-19;
  [docent#707](https://github.com/Arsarneq/docent/issues/707))
- Moving between two browser windows — the worker listens for no
  `windows.onFocusChanged`, so the switch records no `context_switch`, which
  the desktop records between its windows; a departure (core CP-19;
  [docent#707](https://github.com/Arsarneq/docent/issues/707))
- Closing a whole browser window — the tab-removal listener skips tabs removed
  by a window close, so no `context_close` is recorded, which the desktop
  records for a window the person closes; a departure (core CP-19;
  [docent#707](https://github.com/Arsarneq/docent/issues/707))
- A file chosen without a trusted click on the input within the 10 s before
  the change — a click the page scripted on the input, or a choice made
  later — no `file_upload` is recorded; a departure (core CP-18). The click
  the browser derives from Enter or Space on the input counts as that trusted
  click, so a chooser opened from the keyboard records its `file_upload`
- Input in a page between its navigation and the completion of its load — the
  recorder is injected as the frame finishes loading (ECP-2), so an action
  taken while the page is still loading is not captured; ECP-5's readiness
  bound runs from that load completion; the desktop records input in a window
  that is still starting, so this is a departure (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- Input in a page or frame the browser does not let the extension inject (the
  browser decides which: the Chrome Web Store, a PDF in the built-in viewer, a
  `file://` page while file access is off and a host an enterprise policy
  blocks, for example) — not captured; a browser-chrome navigation into it
  still is
- A link followed in a page the extension cannot inject — the click reaches no
  recorder and the worker skips the `link` navigation as an in-page effect, so
  neither is written; a departure (core CP-18)
- A value committed in an input, textarea or select inside a shadow root —
  `change` does not cross the shadow boundary to the recorder's `document`
  listener, so no `type` or `select` is written; the desktop records a
  field's `type` wherever the field sits, so this is a departure (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- Actions in a tab after a service-worker suspension, once one frame of that
  tab has registered again and the frame acted in has not — the tab's registry
  entry exists, so no lazy reseed runs (ECP-3), and the frame-trust gate drops
  the actions until that frame registers again (as it finishes a load, or
  when its reinjected recorder reports ready) or the next record-start; a
  departure (core CP-18)
- Editing in a contenteditable host whose attribute is neither `""` nor
  lower-case `true` (`plaintext-only` or `TRUE`, for example), or in a host
  inside a shadow root — not taken for a contenteditable host, so no `type` is
  written; a departure (core CP-18)
- Editing in a contenteditable host whose text exceeds 500 characters —
  captured with a caveat: the `type` value is cut at 500 characters with no
  mark of the cut ([docent#238](https://github.com/Arsarneq/docent/issues/238));
  a departure (core CP-18)
- Text dragged from one contenteditable host into another — only the edit of
  the host whose `input` fired last is written, the other host's edit is not;
  a departure (core CP-18)
