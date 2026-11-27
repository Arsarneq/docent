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
carries an inline window of its own, the repeat window ECP-12 names; an
end-to-end spec enforces the readiness bound.

---

## Capture Surface

**ECP-6.** The extension's capture surface is a closed list of events, as [core CP-14](../../../architecture/system/capture-principles.md#capture-surface) requires. The recorder listens, in the capture phase, for exactly these DOM events, on `document` unless the item names `window`. Each item says what the event is to the recorder and, where another clause holds a rule for it, names that clause.

- `mousedown` is the press of a pointer button. It ends the typing done so far (ECP-15), and the press of the right button is written as the right-click (ECP-17).
- `click` is the activation of an element, written as a `click` unless a key caused it (ECP-17).
- `contextmenu` is the browser's request for a context menu. It is written as the right-click only where neither a press of the right button nor a key asked for the menu (ECP-17).
- `keydown` is a key press, written as a `key` unless it is text (ECP-13). A press written as a `key` ends the typing done before it (ECP-15).
- `keypress` is the character event of a key press, during which the browser enters the key's text. It writes nothing. The end of its handling ends the wait of a press held back (ECP-13), and with `keydown` and `keyup` it marks the task in which the browser derives a click from the key (ECP-17).
- `keyup` is the release of a key. It writes nothing. It ends the wait of a press held back (ECP-13) and the key's time among the held keys (ECP-18), and the browser derives the click of a Space press from it (ECP-17).
- `change` is a committed value: a `select` choice, an `input` or `textarea` entry (ECP-15), and a file chosen through the OS dialog. A checkbox or radio toggle is recorded by the `click` or the `key` that made it, so its `change` writes nothing. The `change` of a `select` starts the window in which a click with no click count is its effect (ECP-17).
- `focusin` is a focus move, recorded only when it follows a Tab key press. The value an `input` or `textarea` holds when it takes the focus is noted (ECP-15).
- `dragstart` is the start of a drag, which names the drag source. No key is known to be down from here on (ECP-18).
- `dragover` is the target tracking the browser requires before a drop can fire.
- `drop` is the end of a drag, paired with the source the drag started from. No key is known to be down at it (ECP-18).
- `dragend` is the drag's terminal signal, which releases the source.
- `scroll` is a scroll gesture, debounced and coalesced into one action (ECP-12 states the floor).
- `input` is text entered into a field or a `contenteditable` host. It writes nothing by itself. It is the sign that a press held back became text (ECP-13), it says which text makes what a field holds a new entry and which host is typed into (ECP-15), and it carries the text of a composition (ECP-16).
- `compositionstart` is the browser opening a composition in a field. It writes nothing by itself (ECP-16).
- `compositionend` is the end of the composition open for a field. It writes nothing by itself (ECP-16).
- `blur` is an `input`, a `textarea` or a `contenteditable` host losing the focus. The entry it holds is written (ECP-15).
- `blur` on `window` is the window losing the focus. It ends the wait of a press held back (ECP-13), and no key is known to be down in this document from then on (ECP-18).
- `focus` on `window` is the window taking the focus. Where it does so while a pointer press in it is handled, the keys held in the tab's other frames are released here from then on (ECP-18).
- `pagehide` on `window` is the page being left. It ends the wait of a press held back (ECP-13).

The service worker captures the browser-chrome proxies in the table of [Browser Chrome Proxies](#browser-chrome-proxies) (ECP-7), each row naming the worker event it is captured from.

[`check-capture-surface.js`](../../../../scripts/check-capture-surface.js) holds the recorder's and the service worker's own registrations to the list above and to that table, in both directions. It closes the same question over every JavaScript module the extension package ships, in two ways.

A `chrome.*` registration the service worker makes is a capture proxy where that table names it and an admitted non-capture role otherwise. One any other module makes is held to that same admission list, keyed by the file that makes it.

The DOM listeners this enumeration describes are the recorder's, so a `document` or `window` listener registered in any other module is capture it does not describe.

An interaction that looks covered by these lists and is not is one of the [exceptions within the surface](#exceptions-within-the-surface) (core [CP-15](../../../architecture/system/capture-principles.md#capture-surface)).

---

## Keys

**ECP-13.** A key press is written as a `key` unless it is text. The [session format](../../../technical/session-format.md#shared-both-platforms)'s `key` row states, for both platforms, which presses are a `key` and which are text, which modifiers make a shortcut, and what each field of the action carries. This clause states how the recorder tells the two apart, press by press.

The row names two presses that write nothing: Shift, Ctrl, Alt or AltGr pressed alone, and a key the input method takes. The recorder takes a key for one the input method takes by one of these four signs, a closed list:

- a composition is open at the press;
- the browser reports the press with key code 229;
- the key value is `Process`;
- the key value is empty.

A press can become text of a field when all three hold:

- the key enters a character: its key value is one character, or it is a dead key;
- no shortcut modifier is held;
- the focused element, followed into shadow roots, is one typing can change: a `textarea`, an `input` that holds an entry, or editable content.

Every other press is written at once: a shortcut, a key that enters no character, and a character key on an element typing cannot change (a letter on a button).

A press that can become text is held back until it is known which it was. It is text, which the field's `type` records, in one of these two cases, a closed list:

- the browser's `input` event for typed text follows the press, in that element or in the one the page moved the focus to from its key handler;
- the element holds other text once the wait ends than it held at the press (a page that cancels the key and enters the character itself, an input mask for example).

With neither (a character key in a read-only field, for example), the press is the `key` it was, written with the time and the held keys of the press. Whichever of these comes first ends the wait, a closed list:

- the end of the browser's handling of the press's `keypress`;
- the release of any key;
- the next key press;
- a pointer press, in this frame or in another frame of the tab (ECP-15);
- any other action written in a later task than the press, which is written behind the `key`;
- the window losing the focus;
- the page being left;
- a step commit or a stop (ECP-15).

An action the browser causes while it still handles the press ends nothing (a page that moves the focus from its key handler, for example). An entry among such actions goes out ahead of the press, and any other is written behind the press once it is known what the press was.

A press still held back when capture goes off by another route than a stop is not written, an exception ECP-12 lists. What a character key on a sensitive element is recorded as is ECP-9's to state.

Two kinds of press wait for more than themselves: the character keys pressed in a date or time field, below, and a dead key (ECP-14).

A date or time field is an `input` of one of these five types, a closed list: `date`, `datetime-local`, `month`, `time`, `week`. It is filled part by part. It has a value, for which the browser sends `input`, only once the parts make one. The character keys pressed in such a field one after the other wait together, and end as one of these two:

| What follows the keys           | The keys are          |
| ------------------------------- | --------------------- |
| An `input` for the field        | Text, all of them     |
| Any other end of the list above | Each the `key` it was |

Two ends of that list end nothing for these keys: the end of a `keypress` and the release of a key. Another press that can become text, in the same field, is no next key press for them: it waits with them. A space in such a field is no such press: it opens the field's picker and is written at once, as a shortcut is, and each ends the wait as the next key press. The keys of a field left half filled are an exception ECP-12 lists.

### Dead keys

**ECP-14.** A dead key enters nothing until the key after it is pressed. In a field typing can change, it waits for the next press in that field. Either of those two presses that write nothing (ECP-13) is no such press: the dead key waits on through them. Neither the browser being done with a `keypress` nor a key's release ends that wait, and the other ends of a wait apply (ECP-13). What the dead key is recorded as follows from that next press, which is one of these two:

| The next press        | The dead key is                                                                                                                            | The next press is                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| A character key       | Text or a `key`, together with that press (ECP-13)                                                                                         | Text or a `key`, together with the dead key   |
| A key of another kind | Text where the browser's `input` for typed text follows in the dead key's own field while the browser handles that key; a `key` without it | The `key` it was, written behind the dead key |

A key of another kind is the case where the browser can enter the bare accent while it handles that key (Enter after a dead key). That key waits behind the dead key. From then on the wait of both ends at the first of the ends ECP-13 lists, the end of a `keypress` and a key's release among them.

For a dead key with no key of another kind behind it, an `input` that carries composing text counts as the `input` for typed text does: a browser can show a dead key's character as a composition.

Two things do not make a dead key with a key of another kind behind it text:

- other text in the field, because the key behind it can change the field by itself;
- typed text that lands in another field, which is that key's own character, in the field the focus moved to.

Editable content has its text read when its entry is written, and the key behind a dead key is written only after the page has handled it. So the text is taken at that key's press, and the entry the key ends holds what the page saw. That entry stands ahead of the dead key where the dead key is a `key` too, and goes out ahead of the presses that still wait. Text the browser enters in the element after that press is its next entry, written behind the keys. What the page made of the element by itself is no entry.

The desktop decides the same question by the accent the field's value gained ([desktop capture DCP-17](../desktop/windows/capture-principles.md#dead-keys)).

---

## Typing

**ECP-15.** Text entered into a field is one `type`, written when the typing in the field ends. The [session format](../../../technical/session-format.md#shared-both-platforms)'s `type` row states what the action carries and that a pause between two keys ends nothing. This clause states what an entry is and what ends the typing. A field here is an `input` or a `textarea`; editable content is a `contenteditable` host.

The recorder notes the value a field holds when it takes the focus, and the entry last written for it, so an entry made since can be told from one already written.

What a field holds is a new entry when one of these happened in it, a closed list:

- text was entered with the keys (ECP-13);
- text the browser names as pasted was inserted;
- a composition ended with text (ECP-16);
- text was inserted right after a key the input method took in the field, before the next key was pressed.

A new entry is written also where it equals the value at focus or the entry written before: the same text typed over itself, or a value undone or removed and typed again.

A character key that entered nothing makes no new entry, and neither does a composition given up. A value the page set, with no key pressed in the field, is not an entry.

The typing ends, and the entry is written, at whichever of these comes first, a closed list:

- a pointer press, wherever it is, another frame of the tab included (below), whether the press takes the focus from the field or leaves it there. The entry stands ahead of the `click` of the press;
- a key press that is written as a `key`. The entry is complete before the press: it is written ahead of the `key` and carries the time of that press;
- the field or the host losing the focus, which a host also does when the window does. A field's entry is written also where the browser sends no `change` for it (an entry made again that equals what the field held before);
- the browser committing the field's value (`change`);
- for editable content, typing beginning in another host;
- a step commit or a stop (below).

An entry already written writes nothing again when the browser commits the field. One press is the exception: the press on a submit control of the field's own form writes no entry, a departure ECP-12 lists.

A pointer press ends the typing in the tab's other frames too. They see nothing of the press, so the recorder reports it to the worker, which asks them to end their typing (extension runtime ERT-4, `END_TYPING`). The worker stores what the pressing frame writes next behind their answers, for up to 500 ms (`END_TYPING_BOUND` in `lib/capture-timing.js`), so their entry stands ahead of the `click` of the press, however short the press was.

A step commit and a stop end the typing as on the desktop. The entry typed into a field or a host that still has the focus is the person's input of that step and of that recording, whether or not the focus left the page first (a press in the panel takes it; a commit sent through the control channel does not). The page is sent no event for either, so the worker asks every registered frame to end its typing ahead of the commit and ahead of the stop, and waits for the answers up to the same 500 ms. A frame asked writes a key press it still holds back first, as the `key` it was, and then its entries.

What happens to the entry of a frame that does not answer in that time (its page is busy with a long task) is an exception ECP-12 lists.

### Compositions

**ECP-16.** Text composed by an input method is recorded as the field's `type` and never as `key` actions (ECP-13). A composition is open for a field from the browser's `compositionstart` to its end. An `input` that carries composing text states the text the composition shows. It opens a composition for its field too, unless the composition last opened was that field's, which then goes on. None of these events writes anything by itself.

While a composition is open, the text it shows is typing not yet ended: a pointer press, a step commit or a stop writes the field's entry with it, as with typed text.

| How the composition ends | What it entered                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| With text                | A new entry (ECP-15). Text that an entry written during the composition already held is not entered again, unless other text was composed after that write |
| Given up                 | Nothing                                                                                                                                                    |

A composition whose text is removed with an editing key gets no end from the browser. It is over at the first of these two:

- the next `input` that carries no composing text, with nothing entered;
- the next key the input method does not take, where the text the composition showed is typing that key ends (ECP-15).

A `compositionend` counts only for a field with a composition open. The browser does not mark every composition end of its own as trusted, so the mark is not asked for. An end followed, with no start between, by more composing text or by a key pressed inside the composition was not the browser's, and is taken back.

An open composition is forgotten when a recording ends or begins.

---

## Clicks and right-clicks

**ECP-17.** The [session format](../../../technical/session-format.md#shared-both-platforms)'s `click` and `right_click` rows state which clicks and which requests for a context menu are written, on which element, and what the actions carry. This clause states the signs by which the recorder tells the cases of those rows apart. The recorder reads `mousedown`, `click` and `contextmenu` for this, by exactly these rows. For a `click` and for a `contextmenu` the first row that fits, from the top, decides:

| The event the recorder is sent                                                                         | The case of the rows it is taken for                                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| A `mousedown` of the right button                                                                      | The right-click                                                                                                   |
| A `contextmenu` that carries the right button                                                          | The menu request that follows a press of the right button (the first row)                                         |
| A `contextmenu` that carries no right button, sent while the browser handles an event of a written key | A menu asked for with a key                                                                                       |
| Any other `contextmenu`                                                                                | A menu asked for with no press and no key                                                                         |
| A `click` that carries no pointer, sent while the browser handles an event of a written key            | A click the browser derives from a key press                                                                      |
| A `click` that carries no pointer and no click count, on a native `select`, whatever sent it           | The click a `select` sends when its list closes                                                                   |
| A `click` that carries no click count, within 50 ms after the `change` of a `select`                   | An effect of the choice just made (core CP-6); nothing written                                                    |
| A `click` the browser sends on to the control of a `label` just clicked, before the next task          | The second click of a click on a `label`                                                                          |
| Any other `click`                                                                                      | A click, one that carries no pointer included (ECP-12). The rows say where a click is not written for its element |

The browser derives a key's click from whichever of the key's three events it acts on, so `keydown`, `keypress` and `keyup` each mark their task as one in which a written key is handled, until the next timer task. The 50 ms is `SELECT_SYNTHETIC_CLICK_WINDOW` in `lib/capture-timing.js`.

---

## Held keys

**ECP-18.** An action's `held_keys` names the keys that were down at it. The [session format](../../../technical/session-format.md#shared-both-platforms)'s `key` row states which keys are named, by which names and in which order, and its `click`, `right_click`, `drag_start` and `drop` rows state the moment the list is read. This clause states for how long the recorder knows a key to be down.

A key is among an action's `held_keys` only while its release is sure to reach a document the recorder runs in. The browser delivers a key's events to the focused document only, sends the page none while a drag lasts, and gives a page and an extension no interface that reads the keyboard's state or says where the focus came from. The desktop's keyboard hook is handed every key wherever the focus is; ECP-12 lists the difference.

In the document that saw it go down, a key is known to be down from its written press for as long as that document's window has the focus. Its time among the held keys ends at the first of these, a closed list:

- its release, while the recording is off as well;
- the release of the Meta key, for a key pressed while the Meta key was held, in whichever frame: some systems send the page no release for such a key;
- the window losing the focus;
- the start of a drag, and its end (the `drop`).

A key still held when the focus arrives or returns, when the drag has ended, or after the release of the Meta key is named again from its next repeat in the document that has the focus.

An action in another recorded frame of the same tab names the key too. Each recorder tells the worker the keys it names as held, their releases, its window's blur, a drag, and the focus a pointer press gives its window (`HELD_KEY`, beside the `POINTER_PRESSED` of the press; extension runtime ERT-4). The worker adds the keys held in the tab's other frames to an action, ahead of the action's own. Between frames these five rules hold:

- Where a pointer press in another recorded frame takes the focus, the keys go to that frame once it reports that focus. Their releases reach it from then on, and a recorder reports the release of a key it did not see go down.
- A frame's reports can reach the worker late (a busy page, a document that is being left), so a key of another frame is named only by what that frame's document has reported up to the action. The worker asks the frame: with the `END_TYPING` of a pointer press, and with `HELD_KEY_REPORTS` for any other action that would be given one of its keys. It stores the action once the report the frame names as its last has arrived.
- The worker forgets the keys of a frame that gives no answer in time or is gone, and those an earlier document of the frame reported. The time is the bound of the end of typing at a press (ECP-15) and half of that at any other action (`HELD_KEYS_ASK_BOUND` in `lib/capture-timing.js`). A key another frame reports released in that time is not named.
- What the acting frame writes waits behind the ask, a typed entry too, and such an entry is still stored ahead of the click of another frame's press.
- No key of a frame is known to be down once the focus leaves its document any other way than by such a press (to another tab, window or program, to a frame the extension does not run in, to another frame by the Tab key or a script), or a drag starts: the release can then reach something that does not report it. The worker forgets the keys held across frames when another tab or window takes the focus, which the browser itself tells it.

The modifiers held at an action are exact wherever they were pressed: the action's own event states them and `modifiers` carries them.

The cases where a key held in another frame is missing or a released key is named are departures ECP-12 lists.

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

- A key press is named by the browser's key value, which follows the layout
  and the shift state, where the desktop names it from the virtual-key code:
  a departure (core CP-19;
  [docent#717](https://github.com/Arsarneq/docent/issues/717))
- A `key` states nothing of the input method: the browser gives a page and
  an extension no interface that reads whether one is on or its mode, where
  the desktop writes `input_method_open` and `input_method_conversion_mode` on
  each `key` from what Windows tells it. What the layer reads is the key's
  own event, whose `isComposing` says a composition is open and nothing of
  whether an input method is on or of its mode; the extension interface that
  addresses an input method (`chrome.input.ime`) is for an extension that is
  the input method, on ChromeOS only. A difference that comes from the
  platforms themselves (core CP-19;
  [docent#237](https://github.com/Arsarneq/docent/issues/237))
- A key the input method takes: not written as a `key`. Its text arrives as
  a composition, which the field's `type` records, and a press whose
  composition is given up with no text leaves no record; a departure (core
  CP-18), and one from the desktop, which writes the keys pressed inside a
  composition as `key` actions (the desktop capture document, DCP-13, states
  why and which); the composed text is one `type` on both; a difference that
  comes from the platforms themselves (core CP-19;
  [docent#744](https://github.com/Arsarneq/docent/issues/744))
- Character keys pressed in a date or time field whose parts made no value
  (a date left half filled): written as `key` actions, though the field shows
  what was typed. The field has no value for a `type` to carry; a departure
  (core CP-18)
- A character key the page cancels and enters into the field where the
  recorder cannot tell (after the wait for it has ended, from a timer for
  example, or from a listener that runs ahead of the recorder's, so that the
  field already holds the character when the press is noted): written as the
  `key`,
  and the field's text as its `type` when the field is committed. And a
  character key that entered nothing, pressed while the page changed the
  field's text for a reason of its own: taken for text and not written as a
  `key`. The recorder tells a page's own entering of a character by the
  field's text alone; a departure (core CP-18)
- A key press still held back, and an action the browser caused while it
  handled that press, when capture is turned off by another route than a
  stop: not written. Only a stop and a step commit ask the frame to end what
  waits (both write the press as the `key` it was); a departure (core CP-18)
- A character key that entered no text on a sensitive element: written as
  the element's masked `type`, not as a `key`, so the recording does not name
  a character of a sensitive value; a departure (core CP-18)
- A reload asked for with a key the page is sent (F5, Ctrl+R): written as
  the `key` and as the `navigate` (reload) the browser reports. One press,
  two actions; a departure (core CP-18), and one from the desktop, which
  writes the `key` alone (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- A key the browser or the system takes before the page is sent its
  `keydown` (a browser shortcut the page is not offered, a system hotkey):
  not written, no event reaching the recorder. The desktop's keyboard hook is
  handed such a key and writes it; the difference comes from the platforms
  themselves (core CP-19)
- Arrow keys in the open list of a native `<select>` are swallowed by the
  browser before the recorder's listeners see them; on a closed `<select>`
  each arrow key reaches the page and is written as the `key`, and the option
  it chooses as the `select` its `change` commits
- The keys an action's `held_keys` can name are fewer than on the desktop, whose keyboard hook is handed every key wherever the focus is (ECP-18 states which keys the extension knows to be down); the difference comes from the platforms themselves (core CP-19). Between recorded frames these departures remain (core CP-19; [docent#782](https://github.com/Arsarneq/docent/issues/782)). A key held in another frame is missing where:
  - the worker, which keeps these keys in memory only, was suspended;
  - the recording was stopped and started, or a frame of the tab started
    to navigate;
  - the frame that reported the key gave no answer in time;
  - a release was reported while the action waited to be stored;
  - a frame's blur reached the worker ahead of the press that caused it.
- A released key can be named in one case: the focus goes to the
  browser's own interface and comes back by a press in another frame
  while the page of the frame that held the key, in a process of its own,
  hangs the whole time and then answers that press in time; its late blur
  is then taken for the press's own.

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
- A context menu asked for with no press of the right button and no key (a
  long press on a touch screen): written as a `right_click` at the browser's
  request for the menu, with the modifiers and held keys of that moment; a
  departure (core CP-18)
- A click on a `label` inside a closed shadow root — written twice, both
  against the shadow host: the label's click and the click the browser sends
  on to its control, since the closed root hides the label from the recorder;
  a departure (core CP-18)
- A click that carries no pointer and reaches the page outside a written
  key's events (an activation an assistive technology sends, for example) —
  written as a `click` with the coordinates its event carries, though no
  pointer was at that point; a departure (core CP-18). Two such clicks are
  not written. One is a click on a native `select` that carries neither a pointer nor a click count, whoever sent it, an activation an assistive technology sends to a `select` included. The other is the next item's
- A click that carries no click count, on whatever element, within 50 ms after the `change` of a `select` — not written, taken for an effect of the choice just made (ECP-17); an activation that carries no click count, made in that time (one an assistive technology sends, for example), is dropped with it; a departure (core CP-18)
- A value entered with no key pressed in the field since it took focus (a
  paste from the context menu, a drop, an autofill) — its `type` is written
  when the browser commits it, which can follow a key pressed after
  it; a departure (core CP-18)
- A key whose press also scrolls (an arrow key, or Space on a focused
  element it does not activate, a link for example) — written as the `key`
  and, where the scroll clears the floor (core CP-16), as a `scroll` too: one
  press, two actions; a departure (core CP-18), and one from the desktop,
  whose `scroll` comes from wheel input only (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- Text a page inserts in a field between a key the input method took there
  and the next key press — taken for that key's text, so what the field holds
  is written as an entry the person made, also where the key itself entered
  nothing; the browser's events do not tell the two inserts apart; a
  departure (core CP-18)
- The same text pasted over itself with no paste key (from a menu) —
  written, the browser naming the paste, where the desktop, which knows a
  paste by its key or by a click on an element described as a menu item,
  writes none where it saw neither (the desktop capture document lists the
  cases), and where the desktop, after a click on a menu item that pasted
  nothing, writes a repeated report of the field's value as a `type`, the
  extension writes none; a departure from the desktop (core CP-19;
  [docent#751](https://github.com/Arsarneq/docent/issues/751))
- A value set again, by other means than typing, composing or pasting, to
  the entry last written for the field since it took the focus or, where
  none was, to what it held at focus (text dragged onto itself, for example)
  — not written; a departure (core CP-18)
- A `type` on an input or textarea when a button or input marked
  `type="submit"` in the same form was pressed, with any mouse button, within
  100 ms of the change, or of the field losing the focus where the browser
  sends no change — not written (a `<button>` with no `type` attribute
  does not trigger the skip); a departure (core CP-18;
  [docent#223](https://github.com/Arsarneq/docent/issues/223)), and one from
  the desktop, which writes the `type` ahead of the click (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
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
- Typing in a frame that does not answer the worker's request to end it within
  500 ms (its page is busy). At a pointer press in another frame, its entry is
  stored behind the `click` of that press. At a step commit and at a stop, its
  entry is no part of the step committed or the recording stopped: the frame
  writes it when it gets to the request, and it is stored where capture is on
  again by then (in the next step, after the panel's commit or a pause and a
  resume) and dropped where capture is still off. The worker logs a warning
  naming the frames. The desktop writes the `type` in place in each of these
  cases; a departure (core CP-18; core CP-19,
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- Typing not yet written when capture is turned off by another route than a
  stop (a project created or opened, a recording opened, the active project
  or recording deleted) — no frame is asked. The entry of a `contenteditable`
  host is not written; the entry of a field is written into the next capture
  if the field is still being typed into when its typing ends there; a
  departure (core CP-18)
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
