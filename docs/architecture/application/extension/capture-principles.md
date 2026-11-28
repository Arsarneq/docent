# Capture Principles — Chrome Extension

Platform-specific details for the extension. See [core rules](../../../architecture/system/capture-principles.md).

Where to look:

| You want to know                                                                          | Read                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Which DOM events the recorder listens for                                                 | [Capture Surface](#capture-surface)                                                       |
| When a key press is a `key` and when it is text, dead keys                                | [Keys](#keys)                                                                             |
| What one typed entry is and when it is written, compositions                              | [Typing](#typing)                                                                         |
| Which clicks and requests for a context menu are written                                  | [Clicks and right-clicks](#clicks-and-right-clicks)                                       |
| For how long a key counts as held                                                         | [Held keys](#held-keys)                                                                   |
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

**ECP-3.** Because actions arrive at the service worker as messages, the service worker validates every inbound `APPEND_ACTION` against an in-memory **active-frame registry** (tab → frames). A message MUST be accepted only when all three hold:

- it comes from this extension;
- a recording is live;
- its (tab, frame) pair is present in the registry.

Anything else — for example an embedded ad, analytics, or third-party widget that can reach the message port — is dropped.

The registry is seeded from the browser's own frame table (`webNavigation.getAllFrames`) at record-start, and two further paths write it one frame at a time:

- the on-load registration that follows each successful injection made as a frame finishes loading while recording;
- each injected recorder's readiness beacon.

Neither of the two is bounded by the set the seed targets — each writes the (tab, frame) pair its own event carries — so a tab that joins the recording after the seed ran is registered like any other.

Because the registry is in-memory and the service worker can be suspended, a tab with no registry entry is also reseeded from the same frame table, in two cases:

- lazily, when an append or a pointer-press report arrives from a tab with no registry entry at all (the missing-entry signature: a suspension is one cause, a clear whose seed does not re-cover that tab another), rather than false-rejecting a legitimate frame whose registration is gone;
- ahead of a step commit and of a stop, for every tab the seed targets that has no registry entry, so the frames asked to end their typing include the tab typed into.

An entry departs along exactly three routes, the registry's own:

- a subframe is dropped as it navigates away (a main frame is left in place — its registration follows on the load);
- a closed tab's frames go with the tab;
- the whole registry is cleared at record-start, ahead of the registry seed, and again on every record-stop path — a clear the recording-flag watch repeats when record-start or a record-stop path transitions the flag, and runs alone when a writer outside those paths transitions it.

Whichever route runs it, that whole-registry clear is the backstop: a frame that reaches neither the navigate-away drop nor the tab-close drop — a subframe destroyed with its parent's navigation, say, or removed from the DOM — keeps its entry until the next clear runs.

Each injected recorder reports readiness back to the service worker with a
`FRAME_READY` message rather than setting a page-visible flag — the recorder runs
in the isolated world, so a `window` flag would both be invisible to the service
worker and leak recording state to the page.

**ECP-4.** The action's `context_id` is stamped from the **trusted sender**,
never from the message body, so a frame cannot claim to be a different tab.

The language facts are written in two places. The recorder reads the element's `language` with the rest of its description: the value of the `lang` attribute on the nearest element at or above the acted-on one that carries the attribute, as the page stands at the action. The service worker writes `preferred_languages` on every action as it stores it, the actions it records itself included, from the browser's `navigator.languages` as the worker reads it, so a frame cannot state another list for its actions ([Session Format — Shown text](../../../technical/session-format.md#shown-text)).

**ECP-5.** Injecting only while recording costs no capture fidelity because of
a measured bound: a frame MUST go from finishing load to its recorder reporting
ready within half the ~200 ms deliberate-action floor — the shortest
gap in which a human plausibly performs a deliberate action — so a frame is
capture-ready before anyone can act in it (in practice the gap is well under
the bound). The floor and the
recorder's other timing windows are **causality proxies**. The floor, with its
doctrine, and the windows the module declares live in
[`lib/capture-timing.js`](../../../../packages/extension/lib/capture-timing.js);
the recorder carries its windows inline — copies of the module's values it uses,
and windows of its own the module does not declare — and the service worker
carries an inline window of its own, the five-second repeat ECP-12 states; an
end-to-end spec enforces the readiness bound.

---

## Capture Surface

**ECP-6.** The extension's capture surface is a closed list of events, as [core CP-14](../../../architecture/system/capture-principles.md#capture-surface) requires. The recorder listens, in the capture phase, for exactly these DOM events, on `document` unless the item names `window`. Each item says what the event is to the recorder and, where another clause holds a rule for it, names that clause.

- `mousedown` is the press of a pointer button. It ends the typing done so far (ECP-15), and the press of the right button is written as the right-click (ECP-17).
- `click` is the activation of an element, written as a `click` unless a key caused it (ECP-17).
- `contextmenu` is the browser's request for a context menu. It is written as the right-click only where neither a press of the right button nor a key asked for the menu (ECP-17).
- `keydown` is a key press, written as a `key` unless it is text (ECP-13). A press written as a `key` ends the typing done before it (ECP-15).
- `keypress` is the character event of a key press, during which the browser enters the key's text. It writes nothing; with `keydown` it tells a key from text (ECP-13).
- `keyup` is the release of a key. It writes nothing, and the key is no longer held (ECP-18).
- `change` is a committed value: a `select` choice, an `input` or `textarea` entry (ECP-15), and a file chosen through the OS dialog. A checkbox or radio toggle is recorded by the `click` or the `key` that made it, so its `change` writes nothing.
- `focusin` is a focus move, recorded only when it follows a Tab key press.
- `dragstart` is the start of a drag, which names the drag source. No key is known to be down from here on (ECP-18).
- `dragover` is the target tracking the browser requires before a drop can fire.
- `drop` is the end of a drag, paired with the source the drag started from. No key is known to be down at it (ECP-18).
- `dragend` is the drag's terminal signal, which releases the source.
- `scroll` is a scroll gesture, debounced and coalesced into one action (ECP-12 states the floor).
- `input` is text entered into a field or a `contenteditable` host. It writes nothing by itself: the text is the field's `type` (ECP-13, ECP-15, ECP-16).
- `compositionstart` is the browser opening a composition in a field. It writes nothing by itself (ECP-16).
- `compositionend` is the end of the composition open for a field. It writes nothing by itself (ECP-16).
- `blur` is an `input`, a `textarea` or a `contenteditable` host losing the focus. The entry it holds is written (ECP-15).
- `blur` on `window` is the window losing the focus. A key press not yet written is written (ECP-13), and no key is known to be down in this document from then on (ECP-18).
- `focus` on `window` is the window taking the focus (ECP-18).
- `pagehide` on `window` is the page being left. A key press not yet written is written (ECP-13).

The service worker captures the browser-chrome proxies in the table of [Browser Chrome Proxies](#browser-chrome-proxies) (ECP-7), each row naming the worker event it is captured from.

[`check-capture-surface.js`](../../../../scripts/check-capture-surface.js) holds the recorder's and the service worker's own registrations to the list above and to that table, in both directions. It closes the same question over every JavaScript module the extension package ships, in two ways.

A `chrome.*` registration the service worker makes is a capture proxy where that table names it and an admitted non-capture role otherwise. One any other module makes is held to that same admission list, keyed by the file that makes it.

The DOM listeners this enumeration describes are the recorder's, so a `document` or `window` listener registered in any other module is capture it does not describe.

An interaction that looks covered by these lists and is not is one of the [exceptions within the surface](#exceptions-within-the-surface) (core [CP-15](../../../architecture/system/capture-principles.md#capture-surface)).

---

## Keys

**ECP-13.** A key press is written as a `key` unless it is text. The [session format](../../../technical/session-format.md#shared-both-platforms)'s `key` row states which presses are which and what the action carries. What the file holds for a press, a closed list in which the first row that fits, from the top, decides:

| The person presses                                                                                                                                                                                                                         | What the file holds                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shift, Ctrl, Alt or AltGr alone, or a key the input method takes                                                                                                                                                                           | Nothing (the `key` row)                                                                                                                                                                            |
| A shortcut, a key that enters no character, or a character key where no field takes it (a letter on a button)                                                                                                                              | The `key` (the `key` row)                                                                                                                                                                          |
| Space in a date or time field: an `input` of type `date`, `datetime-local`, `month`, `time` or `week`                                                                                                                                      | The `key`                                                                                                                                                                                          |
| Character keys in a date or time field, one after the other, up to the next other key, pointer press, action written, the window losing the focus, the page being left, a step commit or a stop                                            | The text where they gave the field a value; each the `key` it was where they gave none (the `key` row; ECP-12 for a field left half filled)                                                        |
| A character key in a field typing can change (a `textarea`, an `input` that takes text, or editable content), and text follows: the browser enters it, or the page does (an input mask), there or in the field the page moved the focus to | The text, in the field's `type` (ECP-15), and no `key`                                                                                                                                             |
| The same key, and no text follows (a read-only field)                                                                                                                                                                                      | The `key`, with the time and the held keys of the press, ahead of the action after it; also where the window loses the focus, the page is left, the step is committed or the recording stops first |

ECP-12 lists the presses that are lost, and ECP-9 states what a character key on a sensitive element is recorded as.

### Dead keys

**ECP-14.** A dead key enters nothing until the key after it. In a field typing can change, what the file holds is a closed list; anywhere else a dead key is ECP-13's second row.

| After the dead key                                                               | What the file holds                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A character key (´ and then e)                                                   | The text the two enter, in the field's `type`; both as `key` actions where no text follows                                                 |
| A key that enters no character (´ and then Enter)                                | The bare accent as text where the browser enters it, and the dead key as a `key` where it does not; then the other key as the `key` it was |
| A press ECP-13's first row writes nothing for                                    | Nothing for that press: the press after it decides, by the two rows above                                                                  |
| No key before a pointer press or one of the other ends ECP-13's fourth row names | The dead key as a `key`, ahead of that action                                                                                              |

In editable content the text typed before the dead key is a `type` of its own, ahead of the dead key and the key behind it.

The desktop records the same (desktop capture [DCP-17](../desktop/windows/capture-principles.md#dead-keys)).

---

## Typing

**ECP-15.** Text entered into a field is one `type`, written when the typing in the field ends. The [session format](../../../technical/session-format.md#shared-both-platforms)'s `type` row states what the action carries and that a pause between two keys ends nothing. A field here is an `input` or a `textarea`; editable content is a `contenteditable` host. What the file holds, a closed list:

| In the field                                                                                                                  | What the file holds                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The person types, pastes or composes text, and the typing ends                                                                | One `type` with the text, also where it equals what the field held before (typed again over itself, or again after an undo) |
| The person presses a character key that enters nothing, or gives a composition up (ECP-16 for one open when the typing ended) | No `type`                                                                                                                   |
| The page sets the value, with no key pressed in the field                                                                     | No `type`                                                                                                                   |

The typing ends at the first of these, a closed list, and the `type` stands ahead of the action that ended it:

- a pointer press anywhere in the tab, another frame included;
- a key press that is written as a `key`, whose time the `type` carries;
- the field or the host losing the focus, which a host also does when the window does;
- the browser committing the field's value;
- for editable content, typing beginning in another host;
- a step commit or a stop, as on the desktop: the text typed into a field that still has the focus is the person's input of that step and of that recording.

A `type` already written is not written again when the field then loses the focus or is committed. ECP-12 lists where the `type` is not written or stands behind the action: a press on a submit control of the field's own form, and typing in a frame that does not answer in time.

### Compositions

**ECP-16.** Text composed by an input method is recorded as the field's `type` and never as `key` actions (ECP-13). What the file holds, a closed list:

| The composition                                                                          | What the file holds                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ends with text                                                                           | The text, in the field's `type` (ECP-15)                                                                                                                                                            |
| Is given up, or the person removes its text, with no end of the typing while it was open | Nothing                                                                                                                                                                                             |
| Has its text removed by the page                                                         | The field's `type`, holding what the field then holds, ahead of the key that ends the typing                                                                                                        |
| Is open when the typing ends (a pointer press, a step commit or a stop)                  | The text it shows, in the field's `type`. Its end then writes the field's `type` again, holding what the field then holds, unless the text is confirmed as written with nothing composed in between |

Only what is composed while the recording is on counts: a composition open when a recording begins gives its text as the field's `type`, and one that ends while the recording is off gives nothing.

---

## Clicks and right-clicks

**ECP-17.** The [session format](../../../technical/session-format.md#shared-both-platforms)'s `click` and `right_click` rows state which clicks and which requests for a context menu are written, on which element, and what the actions carry. This platform adds no rule to those rows.

---

## Held keys

**ECP-18.** An action's `held_keys` names the keys that were down at it. The [session format](../../../technical/session-format.md#shared-both-platforms)'s `key` row states which keys are named, by which names and in which order, and its `click`, `right_click`, `drag_start` and `drop` rows state the moment the list is read.

The extension knows fewer keys to be down than the desktop does (the `key` row). The browser delivers a key's events to the focused document only, sends the page none while a drag lasts, and gives a page and an extension no interface that reads the keyboard's state. What the file holds, a closed list:

| The key was pressed                                                                    | An action names it in `held_keys`                                                                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| In the document of the action                                                          | Until its release, the window losing the focus, or the start or the end of a drag; after the last three, again from the key's next repeat |
| While the Meta key was held                                                            | Until the Meta key's release, since some systems send the page no release for such a key; then again from the key's next repeat           |
| In another recorded frame of the same tab                                              | Ahead of the action's own keys, until its release or the start of a drag, also where a press in a recorded frame moved the focus since    |
| In a document the focus then left in any other way than by a press in a recorded frame | No                                                                                                                                        |

The modifiers held at an action are exact wherever they were pressed, save a Ctrl or an Alt held with AltGr (ECP-12): `modifiers` carries them. The cases where a key held in another frame is missing or a released key is named are departures ECP-12 lists.

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

Where the page is sent the key press of such an action before the browser
acts on it (F5 and Ctrl+R reach the page), the press is a key press like any
other and is written as a `key` (ECP-13), with the proxy beside it; ECP-12
lists the pair.

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

The recorder masks the value of an entry it writes for such a field as well,
by a copy of the shared patterns that a test holds equal to them.

A `key` that enters a character names that character, so a character key pressed on a sensitive element with no shortcut modifier (ECP-13) is never stored as a `key`. The recorder tests the focused element itself, followed into shadow roots, and every shadow host the focus passes through on the way (a widget named as a one-time code whose cells carry no name), and writes the masked `type` of the innermost sensitive one in the key's place where the press entered no text; it does not name the key among the held keys of later actions either.

The chokepoint applies the same rule to every `key` it is sent, as a second test: a key whose name is one character, `Space` or a dead key, with no shortcut modifier, on a sensitive element is stored as the element's masked `type`. A masked `type` that follows another on the same element is already recorded by it and is not stored again: typing into a sensitive field is one masked `type`, and no key name carries a character typed into it.

A key that enters no character, and a shortcut, stays a `key`. A key of the numeric keypad pressed with Alt alone is treated as a character key on a sensitive element, though Alt makes a shortcut elsewhere: a run of such keys enters the character with that code.

**The control exception.** A key on a control that takes no typed text stays a `key` too: a checkbox named "Remember password" is ticked by its Space, not typed into. The desktop keeps the same rule by its own control types (DCP-11). On the extension these are the controls that take no typed text, a closed list:

- a link (an `a`), a `button` or a `summary`;
- an `input` that holds no entry: one of type `button`, `checkbox`, `file`, `image`, `radio`, `reset` or `submit`;
- an element with the role `button`, `checkbox`, `link`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `radio`, `switch` or `tab`.

The control exception has two limits:

- Under a sensitive shadow host it does not apply: a key pressed inside the host is recorded on the host, so a character key on a control inside it is the host's masked `type` too.
- A list is no such control on either platform: a character pressed on a `select`, or on an element with the option role, picks the entry that starts with it, and is masked.

Locator candidates pass the chokepoint with one exception: the value of a value-derived strategy is masked in place (`masked: true`) on sensitive elements. [Locator-resolution §LR-24](../../../technical/locator-resolution.md) is the home of which strategies are value-derived, declared per strategy by the schema's `x-value-derived` annotation.

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

**ECP-12.** This platform's exceptions within the surface (core [CP-15](../../../architecture/system/capture-principles.md#capture-surface)):

- A `key` states nothing of the input method, where the desktop writes `input_method_open` and `input_method_conversion_mode` on each `key`: the browser gives a page and an extension no interface that reads whether an input method is on or its mode. The extension reads the key's own event, whose `isComposing` says only that a composition is open; the input-method interface (`chrome.input.ime`) serves an extension that is itself the input method, on ChromeOS only. A difference that comes from the platforms themselves (core CP-19; [docent#237](https://github.com/Arsarneq/docent/issues/237)).
- A key the input method takes that enters text (a letter of a romanized reading, for example) is not written as a `key`: its text is in the field's `type` (ECP-16). The desktop writes such a key as a `key` where the field reports no value for it (DCP-13): a difference that comes from the platforms themselves (core CP-19).
- A key pressed inside a composition that enters no text (Space that converts, the Enter that confirms, Escape, an arrow in the candidate list or Backspace, for example) is not written, and a press whose composition is given up with no text leaves no record. The desktop writes these keys. A departure (core CP-18, CP-19; [docent#861](https://github.com/Arsarneq/docent/issues/861)).
- Character keys pressed in a date or time field whose parts made no value (a date left half filled) are written as `key` actions, though the field shows what was typed: the field has no value for a `type` to carry. A departure (core CP-18; [docent#847](https://github.com/Arsarneq/docent/issues/847)).
- A character key the page cancels and then enters into the field itself, where the recorder cannot tell (after the browser is done with the key, from a timer for example, or before the recorder sees the key), is written as the `key`, and the field's text as its `type` when the field is committed. A character key that entered nothing, pressed while the page changed the field's text for a reason of its own, is taken for text and not written as a `key`: the field's text alone tells a page's own entering of a character. A departure (core CP-18; [docent#847](https://github.com/Arsarneq/docent/issues/847)).
- A key press not yet written (ECP-13's fourth and last rows, ECP-14's last row), and an action the browser caused while it handled that press, are not written when capture is turned off by another route than a stop. A stop and a step commit write the press as the `key` it was. A departure (core CP-18; [docent#848](https://github.com/Arsarneq/docent/issues/848)).
- A character key that entered no text on a sensitive element is written as the element's masked `type`, not as a `key`, so the recording does not name a character of a sensitive value. A departure (core CP-18; [docent#849](https://github.com/Arsarneq/docent/issues/849)).
- A reload asked for with a key the page is sent (F5, Ctrl+R) is written as the `key` and as the `navigate` (reload) the browser reports: one press, two actions. A departure (core CP-18), and one from the desktop, which writes the `key` alone (core CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).
- A key the browser or the system takes before the page is sent its `keydown` (a browser shortcut the page is not offered, a system hotkey, an arrow key in the open list of a native `<select>`, for example) is not written. The desktop's keyboard hook is handed a browser shortcut and most system hotkeys and writes them (DCP-13 states the keys the system takes before the hooks, which are not written): a difference that comes from the platforms themselves (core CP-19). On a closed `<select>` each arrow key is written as the `key`, and the option it chooses as the `select`.
- The keys an action's `held_keys` can name are fewer than on the desktop, whose keyboard hook is handed every key wherever the focus is (ECP-18 states which keys the extension knows to be down): a difference that comes from the platforms themselves (core CP-19). Between recorded frames these departures remain (core CP-19; [docent#782](https://github.com/Arsarneq/docent/issues/782)). A key held in another frame is missing where:
  - the browser suspended the extension's worker;
  - the recording was stopped and started, or a frame of the tab started to navigate;
  - the frame that reported the key did not answer within 500 ms (`END_TYPING_BOUND`) at a pointer press, or within 250 ms (`HELD_KEYS_ASK_BOUND`) at any other action;
  - the key was released in its frame at about the moment of the action;
  - a press in another frame took the focus, and the browser reported the focus leaving first.
- A released key can be named in one case: the focus goes to the browser's own interface and comes back by a press in another frame while the page of the frame that held the key, in a process of its own, hangs the whole time and then answers that press in time. A departure (core CP-18, CP-19; [docent#782](https://github.com/Arsarneq/docent/issues/782)).
- A Ctrl or an Alt held together with AltGr is not written as the person held it: at a key press both are written `false`, and at a pointer action `ctrl` is written `true`, whether or not a Ctrl is held, and an Alt held with AltGr `false`. The desktop writes each as the person held it. The extension writes what the browser reports at the action, and these are what Chrome on Windows reported on the Danish layout. A departure (core CP-19; [docent#862](https://github.com/Arsarneq/docent/issues/862)).

- Back/forward between same-document entries (an SPA's history) is not written: only a back/forward that loads another document writes a `navigate` (ECP-7).
- Back/forward that moves only an embedded frame's document writes no `navigate`: only a tab's main-frame navigations are written.
- A second navigation to the same address within five seconds of the last recorded one in any tab, reloads excepted, is dropped as a repeat, and a re-navigation the user asked for with it. A departure (core CP-18; [docent#850](https://github.com/Arsarneq/docent/issues/850)).
- A browser-chrome navigation the browser marks as redirected by the server or the page writes no `navigate`, so a typed address the site redirects records none. A departure (core CP-18; [docent#850](https://github.com/Arsarneq/docent/issues/850)).
- A navigation into an internal scheme (exactly `chrome://`, `chrome-extension://` and `about:`), a typed address among them, is not written: the internal schemes are outside the surface.
- A tab the user opened (Ctrl+T, Ctrl+N or Ctrl+Shift+T, for example) within 500 ms after an in-page action writes no `context_open`: the tab is taken for a page-opened one. A departure (core CP-18; [docent#851](https://github.com/Arsarneq/docent/issues/851)).
- The close, within 2000 ms after an in-page action, of a tab the user opened within 500 ms after an in-page action is not written: the tab is taken for a page-opened one. A departure (core CP-18; [docent#851](https://github.com/Arsarneq/docent/issues/851)).
- The user's close (Ctrl+W or the tab's X), within 2000 ms after an in-page action, of a tab a page opened is not written: the close is taken for the page's `window.close()`. A departure (core CP-18; [docent#851](https://github.com/Arsarneq/docent/issues/851)).
- A click or right-click whose picked element is the body or the document element is not written. A departure (core CP-18; [docent#852](https://github.com/Arsarneq/docent/issues/852)).
- A context menu asked for with no press of the right button and no key (a long press on a touch screen) is written as a `right_click` at the browser's request for the menu, with the modifiers and held keys of that moment. A departure (core CP-18; [docent#852](https://github.com/Arsarneq/docent/issues/852)).
- A click on a `label` inside a closed shadow root is written twice, both against the shadow host: the label's click and the click the browser sends on to its control, since the closed root hides the label from the recorder. A departure (core CP-18; [docent#852](https://github.com/Arsarneq/docent/issues/852)).
- A click that carries no pointer and reaches the page outside a written key's events (an activation an assistive technology sends, for example) is written as a `click` with the coordinates its event carries, though no pointer was at that point. A departure (core CP-18; [docent#852](https://github.com/Arsarneq/docent/issues/852)). Two such clicks are not written: one on a native `select` that carries neither a pointer nor a click count, whoever sent it (an activation an assistive technology sends included), and the next entry's.
- A click that carries no click count, on whatever element, within 50 ms after the `change` of a `select` is not written: it is taken for an effect of the choice just made, and an activation that carries no click count, made in that time (one an assistive technology sends, for example), is dropped with it. A departure (core CP-18; [docent#852](https://github.com/Arsarneq/docent/issues/852)).
- A value entered with no key pressed in the field since it took focus (a paste from the context menu, a drop, an autofill) has its `type` written when the browser commits it, which can follow a key pressed after it. A departure (core CP-18; [docent#853](https://github.com/Arsarneq/docent/issues/853)).
- A key whose press also scrolls (an arrow key, or Space on a focused element it does not activate, a link for example) is written as the `key` and, where the scroll clears the floor (core CP-16), as a `scroll` too: one press, two actions. A departure (core CP-18), and one from the desktop, whose `scroll` comes from wheel input only (core CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).
- Text a page inserts in a field between a key the input method took there and the next key press is taken for that key's text, so what the field holds is written as an entry the person made, also where the key itself entered nothing: the browser's events do not tell the two inserts apart. A departure (core CP-18; [docent#847](https://github.com/Arsarneq/docent/issues/847)).
- The same text pasted over itself with no paste key (from a menu) is written, the browser naming the paste. The desktop, which knows a paste by its key or by a click on an element described as a menu item, writes none where it saw neither (DCP-13 lists the cases); and where the desktop, after a click on a menu item that pasted nothing, writes a repeated report of the field's value as a `type`, the extension writes none. A departure from the desktop (core CP-19; [docent#751](https://github.com/Arsarneq/docent/issues/751)).
- A value set again, by other means than typing, composing or pasting, to the entry last written for the field since it took the focus or, where none was, to what it held at focus (text dragged onto itself, for example) is not written. A departure (core CP-18; [docent#853](https://github.com/Arsarneq/docent/issues/853)).
- A `type` on an input or textarea is not written when a button or input marked `type="submit"` in the same form was pressed, with any mouse button, within 100 ms of the change, or of the field losing the focus where the browser sends no change (a `<button>` with no `type` attribute does not trigger the skip). A departure (core CP-18; [docent#223](https://github.com/Arsarneq/docent/issues/223)), and one from the desktop, which writes the `type` ahead of the click (core CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).
- The first activation of a tab opened in the background, when no tab was created after it, is not written. A departure (core CP-18; [docent#851](https://github.com/Arsarneq/docent/issues/851)).
- The activation of a tab with no address is not written. A departure (core CP-18; [docent#851](https://github.com/Arsarneq/docent/issues/851)).
- The activation of a `chrome://` or `chrome-extension://` tab is not written: these schemes are outside the surface. An `about:` tab's activation is written.
- A Tab-focus of a password field is not written. A departure (core CP-11; [docent#849](https://github.com/Arsarneq/docent/issues/849)).
- A Tab focus move onto an element other than an input, a textarea or a contenteditable host (a button, a link or a select, for example) writes no `focus`; the Tab `key` is written against the element it left. A departure (core CP-18), and one from the desktop, which writes the `focus` (core CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).
- A scroll follows [core CP-16](../../../architecture/system/capture-principles.md#capture-surface). The quantity here is the change in the scrolled container's offset in the document's layout pixels, and the floor is 200 (`SCROLL_MIN_DISTANCE_PX` in `lib/capture-timing.js`). The change is measured from the first scroll event to the last, so the first event's own movement is left out. A departure (core CP-18; [docent#251](https://github.com/Arsarneq/docent/issues/251)). A scroll that moves across containers gives the difference of two containers' offsets. A departure (core CP-18; [docent#863](https://github.com/Arsarneq/docent/issues/863)).
- Actions performed during a [storage-pressure pause](#storage-pressure) are not captured.
- A middle-button click is not recorded, though the browser reports it to the page; a tab it opens arrives as a `context_open` with no action behind it. The desktop records the click. A departure (core CP-19; [docent#707](https://github.com/Arsarneq/docent/issues/707)).
- A press of a mouse's back or forward button writes no action of its own, as on the desktop (DCP-13); the back or forward it causes is written as a `navigate` (ECP-7).
- A pointer drag that is not HTML5 drag-and-drop (a slider, a splitter, a text selection) is recorded as the click its release produces, not as a `drag_start`/`drop` pair, which the desktop records. A departure (core CP-19; [docent#707](https://github.com/Arsarneq/docent/issues/707)).
- Moving between two browser windows records no `context_switch`, though the browser reports the switch; the desktop records one between its windows. A departure (core CP-19; [docent#707](https://github.com/Arsarneq/docent/issues/707)).
- Closing a whole browser window records no `context_close`, though the browser reports each tab's removal; the desktop records one for a window the person closes. A departure (core CP-19; [docent#707](https://github.com/Arsarneq/docent/issues/707)).
- A file chosen without a trusted click on the input within the 10 s before the change (a click the page scripted on the input, or a choice made later) records no `file_upload`. A departure (core CP-18; [docent#853](https://github.com/Arsarneq/docent/issues/853)). The click the browser derives from Enter or Space on the input counts as that trusted click, so a chooser opened from the keyboard records its `file_upload`.
- Input in a page between its navigation and the completion of its load is not captured: the recorder is injected as the frame finishes loading (ECP-2). The desktop records input in a window that is still starting. A departure (core CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).
- Input in a page or frame the browser does not let the extension inject (the browser decides which: the Chrome Web Store, a PDF in the built-in viewer, a `file://` page while file access is off and a host an enterprise policy blocks, for example) is not captured; a browser-chrome navigation into it still is.
- A link followed in a page the extension cannot inject writes neither the click nor the `navigate`: the click reaches no recorder, and the navigation is taken for an in-page effect. A departure (core CP-18; [docent#850](https://github.com/Arsarneq/docent/issues/850)).
- A value committed in an input, textarea or select inside a shadow root writes no `type` or `select`: `change` does not cross the shadow boundary. The desktop records a field's `type` wherever the field sits. A departure (core CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).
- Typing in a frame whose page is busy for more than 500 ms is written out of place or lost. At a pointer press in another frame, its `type` is stored after that press's `click`. At a step commit and at a stop, it is no part of the step committed or the recording stopped: it goes into the next step where capture is on again when the page answers (after the panel's commit, or a pause and a resume), and is lost where capture is still off. The desktop writes the `type` in place in each of these cases. A departure (core CP-18, CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).
- Typing not yet written when capture is turned off by another route than a stop (a project created or opened, a recording opened, the active project or recording deleted) is written late or not at all: the entry of a `contenteditable` host is not written, and the entry of a field is written into the next capture if the field is still being typed into when its typing ends there. A departure (core CP-18; [docent#848](https://github.com/Arsarneq/docent/issues/848)).
- After the browser suspends the extension's worker, where another frame of the tab loads or has its recorder injected before any action comes from the tab, actions in the tab's other frames are dropped until the frame acted in loads again, has its recorder injected again, or the next record-start (ECP-3). A departure (core CP-18; [docent#854](https://github.com/Arsarneq/docent/issues/854)).
- Editing in a contenteditable host whose attribute is neither `""` nor lower-case `true` (`plaintext-only` or `TRUE`, for example), or in a host inside a shadow root, writes no `type`: it is not taken for a contenteditable host. A departure (core CP-18; [docent#853](https://github.com/Arsarneq/docent/issues/853)).
- Editing in a contenteditable host whose text exceeds 500 characters is captured with a caveat: the `type` value is cut at 500 characters with no mark of the cut. A departure (core CP-18; [docent#238](https://github.com/Arsarneq/docent/issues/238)).
