# Capture Principles

The core rules for how Docent captures user interactions. Applies to both
the Chrome extension and the desktop application. This document governs what
may enter a recording; its companion,
[Replay Sufficiency](../../requirements/replay-sufficiency.md), governs what the recording must
be sufficient for.

Each rule carries a stable identifier (**CP-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../clause-registry.json). The
key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and can appear out of numeric sequence.

Platform-specific details:

- [Extension](../../architecture/application/extension/capture-principles.md)
- [Desktop](../../architecture/application/desktop/windows/capture-principles.md)

---

## Core Rule

**CP-1.** Capture what the user did — not what the code did.

**CP-2.** The core rule is an inclusion filter on the action stream: CP-5's
definition decides what enters it, and two kinds of observed effect enter in a
defined role — a proxy standing in for a user action (CP-7) and
the entries of a context's establishment (CP-17). Any other effect, any other
code-driven event, and guessed intent MUST NOT enter it; CP-6's named kinds
illustrate what it keeps out,
save the establishment entries of a context code opens (CP-17).

**CP-3.** A small amount of observed context MAY be recorded _alongside_ the
actions to describe them faithfully — ambient facts such as the window
rectangle.

**CP-4.** Recorded context MUST be kept distinct from the actions themselves;
it MUST NOT be invented and MUST NOT be treated as something the user did.
Distinct means distinct in meaning, not merely in placement — a field kept
outside the actions that functions as an action entry violates this rule.

---

## Recorded Facts

**CP-18.** A recording carries the facts the capture layer observed, as it observed them. For every field the format has, the layer writes the fact it holds and makes no choice on behalf of whoever reads the recording or of the user whose work it records: it does not prune, rank or prefer among the facts it holds, save as the admission test below admits. Where a kind of fact has an unbounded solution space — a CSS selector, an accessibility tree path — one candidate is unavoidable; the layer then records the technically most stable candidate within that type, and the field's documentation discloses the selection.

The field's documentation is the field's row in the session-format document, or the platform capture document that states a bound of its own.

The admission test: a fact the layer observed about an action it records, for which the format has a field, MUST be written, save in exactly these classes:

- a fact a scope clause of this document leaves outside the recording. The scope clauses are these four groups:
  - what a user action is and is not: CP-5, CP-6, the scroll floor of CP-16, and each platform's surface enumeration with its exceptions under CP-14 and CP-15, less an exception the list marks as a departure;
  - what a proxy stands in for and records, at most one and never its cascades: CP-7 through CP-10;
  - which contexts take an establishment entry: CP-17;
  - the ambient context the format records: CP-3;
- a fact a masking clause masks, a marker keeping its place (CP-11, CP-12);
- a fact a limit the field's documentation discloses trims;
- one slot filled from several observed candidates by a rule the field's documentation discloses, where the format has no field for the unchosen candidates;
- a field set a platform's capture document conditions on a capture mode.

The classes are closed: a held fact left unwritten outside them is a defect.

---

## One Recording Across Platforms

**CP-19.** The same input is recorded the same way on every platform: the same action type, the same fields, the same values.

A key press that activates a control is a `key` on both platforms, and text typed into a field is that field's `type` on both.

The desktop departs from the second half where it read the field's value after later keys were pressed. It does so in two ways, both departures the desktop capture document lists (DCP-18; [docent#762](https://github.com/Arsarneq/docent/issues/762)):

- the keys typed since the last value the desktop read in time are written as `key` actions after the field's `type`, or alone where it read none in time;
- a key the value it took lacks, or text no key carries (a paste), can be in no action.

A difference between platforms is one of two kinds. One comes from the platforms themselves and is part of the format; the field's documentation states it. It is one of three, a closed list:

- an input the platform's own events never deliver to its capture layer,
  whatever the layer listens for;
- a fact about an input that the platform's events do not carry and that no
  interface open to the capture layer under CP-20 lets it read at any moment from
  the input until its action is written; the field's documentation also
  names the interface that is missing and what the layer tried. A fact the
  layer could have read at an earlier moment than the one it reads at is not
  of this kind, and leaving it out is a departure;
- a quantity that is each platform's own (CP-16's scroll deltas).

Every other difference — an
input both platforms' events deliver, which one records and the other does
not, or which they record differently — is a departure: a defect, stated as a
departure in the field's documentation or on the platform's exception list
(CP-15), beside the issue that tracks its removal. A change MUST NOT add a
departure: a change to what one platform records for an input the other
platform's events also deliver MUST change the other with it.

---

## Observing From Outside

**CP-20.** The capture layer observes a program and takes no part in it. What it does to a program it records is a closed list: it reads the events the platform delivers to a program that watches from outside, and it asks the questions the platform defines for such a watcher (the accessibility interface, a window message that reads a state). It MUST NOT do anything else to another program: loading code into one, starting a thread in one, writing into its memory, sending it input and sending it a message that changes it are all outside the list. On the desktop it therefore runs in Docent's own process alone. On the extension it runs where the browser places an extension's scripts, and there it MUST NOT change what the page does. Where a platform does more than the list today, that is a defect, stated on the platform's exception list with its tracking issue. A change MUST NOT add another.

A fact that only code inside the program is told is therefore not read. The recording says it is not known, in the value the format has for that (a key whose meaning is not known is `Unidentified`), and the field's documentation states both what is not read and this clause as the reason.

Two reasons hold the rule. What a program tells code inside it differs with how the program is built, so reading there is work that grows with every kind of program. And a tool that puts its code into other programs can break them and is what security software is set to stop, which costs the trust of the people and organizations that would install it.

---

## What IS a User Action

**CP-5.** A user action is a physical input the user deliberately performed:

- Mouse: left-click, right-click, middle-click, double-click, drag, scroll
- Keyboard: control keys, F-keys, modifier combos, typing text
- Interactions: selecting from a dropdown, confirming a dialog, choosing a file

The definition is the rule; the listed classes illustrate it and do not close
it. A novel input class is judged against the definition, not the list.

---

## What is NOT a User Action

**CP-6.** Things that happen as a consequence of a user action or from
application code are not user actions and MUST NOT be captured as actions,
save what CP-2 admits in a defined role (CP-7, CP-17):

- Focus/value/selection changes triggered by code
- Windows/tabs opening or closing from code
- Navigations triggered by code (redirects, pushState and window.location, for example)
- Scrolls triggered by code
- Synthetic/generated events from the platform
- Timer-driven UI updates
- Notifications appearing

The enumerated classes illustrate the category; they do not close it. A novel
consequence is judged against the category definition above.

---

## Proxy Capture

**CP-7.** Some user actions happen outside the capture layer's visibility
(browser chrome, the OS shell or a window title bar, for example). These are
captured by proxy:
the **immediate effect** stands in for the user action and enters the action
stream in its place (CP-2). A proxy that opens or switches into a
context records that context's establishment as CP-17 states it.

Every proxy is bound by three rules:

**CP-8.** A proxy MUST record only the **immediate** effect — never cascading
effects. Immediacy is causal, not temporal: the immediate effect is the first
link in the user action's causal chain; a cascading effect is any later link,
whenever it arrives.

**CP-9.** A user action MUST produce at most **one** proxy — no duplicates.

**CP-10.** A proxy MUST **identify** what the user did. Identity is at the
level of the action's effect, not its gesture: the proxy records the action's
kind and the parameters that define its effect, such as the context it acts on
or a navigation's destination. The activation recorded beside a click into
another window and beside an Alt+Tab `key`, which each switch the window in
focus, share one entry shape (CP-17); a typed address
and a bookmark to the same page share the navigation's shape, told apart by one
of its fields: a classification derived from the browser's transition type.

---

## Context Establishment

**CP-17.** A context opened, or an existing context switched into, in a user action's causal chain is either the context's establishment or a cascade. Its place among the chain's changes of context decides which (a close counts as a change of context, CP-8):

| The change of context                                                                                                      | What it is    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| The first in the chain                                                                                                     | Establishment |
| A later one, into a context first appearing in the chain (session-format SF-10)                                            | Establishment |
| Any other later one, into a context the recording already introduced (such as the tab the browser activates after a close) | Cascade       |

An establishment's entries are its `context_open` or `context_switch` and, for a context opened at a destination the opening action names (a link's target, for example), the navigation that loads it; for the first change in the chain, together they are the action's immediate effect (CP-8). They enter beside the action when it is captured directly, and as its one proxy (CP-9) otherwise; the entries of a context first appearing later in the chain enter in the same role beside them, never as a further proxy (CP-8).

Whether the platform or the application's code opened the context does not change the entries: they record the context's existence for the actions that follow, never a second record of the action, and they are entries of the action stream in their own role under CP-2, not the recorded context CP-3 and CP-4 govern.

A context that materializes with no user action behind it (a notification window, or one a page's own interval opens, for example) is an effect under CP-6 until a user action is taken in it, and that action establishes it (SF-10); a timer a user action armed does not cut the chain (CP-8).

---

## Sensitive Values

**CP-11.** Capture the action — mask the sensitive value. Docent records that
the user typed into a field, but when the field is sensitive (a password, or a
field the shared sensitivity detection recognises — a card number, a
social-security or tax id, or a secret, for example) the value MUST be redacted
at capture time,
the element's `text` nulled, and the element flagged `redacted`; the action
stays in the stream, the secret MUST NOT enter it. Detection is a **single
shared implementation** used by both
platforms, applied to the field description each platform captures (ECP-9
and DCP-11 name the inputs), so each platform masks the fields its own
description reveals; the platforms differ in those inputs, in the native
signal each reads for password fields, and in where its capture path applies
the shared detection.

**CP-12.** Detection MUST be conservative — over-masking a legitimate field
would degrade the captured workflow — so only strong signals trigger masking.

Platform specifics (and tokened-URL redaction, which is browser-only) are in the
[extension](../../architecture/application/extension/capture-principles.md) and [desktop](../../architecture/application/desktop/windows/capture-principles.md)
docs.

---

## Distinguishing Action from Effect

**CP-13.** Whether something was a user action or an effect is read from
observable signals:

| Signal                                           | User action | Effect                 |
| ------------------------------------------------ | ----------- | ---------------------- |
| Low-level input hook fired                       | ✅          | —                      |
| `event.isTrusted === false`                      | —           | ✅                     |
| No preceding user input                          | —           | ✅ Likely programmatic |
| Platform identifies cause (transitionType, etc.) | Depends     | Depends                |

The signals are diagnostic guidance, not a decision procedure; a mixed case
(the table's Depends rows) or a signal the table does not list is a design
judgment.

---

## Capture Surface

**CP-14.** Each platform's capture surface is enumerated **positively** and
treated as **closed**: it lists a fixed set of trusted inputs and the proxies
that platform captures (the enumerations live in the
[extension](../../architecture/application/extension/capture-principles.md) and
[desktop](../../architecture/application/desktop/windows/capture-principles.md)
docs). An interaction that reaches none of the enumerated surface is **not
captured** — no per-case listing of what is ignored is needed, and nothing new
a platform grows is captured implicitly.

**CP-15.** The only negative entries a platform keeps are **exceptions within
the surface**: interactions that would appear to be covered by the surface
description but are not captured (or are captured with a caveat). An entry
belongs on a platform's exception list only when the surface description alone
would mislead — the closed positive enumeration otherwise answers whether an
interaction is captured. Each platform's exception list is complete against
this test: an interaction the test admits that the list omits is a
documentation defect.

**CP-16.** Scroll gestures are debounced (300 ms) and coalesced into one
`scroll` action per settled sequence; a sequence whose net displacement stays
within the floor on both axes is discarded
([docent#232](https://github.com/Arsarneq/docent/issues/232) tracks revising
the floor). The rule is the same on both platforms; the quantity it measures
is each platform's own — the extension's change in the scrolled container's
offset in layout pixels, the desktop's summed native wheel deltas — and each
platform's capture doc states it with its floor's home. The exported
`delta_x`/`delta_y` carry that quantity, as their schema descriptions state.
