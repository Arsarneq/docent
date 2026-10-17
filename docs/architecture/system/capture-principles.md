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
another window and Alt+Tab's proxy, which each switch the window in focus,
share one entry shape (CP-17); a typed address
and a bookmark to the same page share the navigation's shape, told apart by one
of its fields: a classification derived from the browser's transition type.

---

## Context Establishment

**CP-17.** A context's establishment is a context opened, or an existing
context switched into, as the first change of context in a user action's causal
chain (a close counting as a change of context, CP-8), or as a later change in
that chain into a context first appearing there (session-format SF-10); any
other later change in that chain,
into a context the recording already introduced, such as the tab the browser
activates after a close, is a cascade. Its entries are the establishment's
`context_open` or `context_switch` and, for a context opened at a destination
the opening action names (a link's target, for example), the navigation that
loads it; for the first change in the chain, together they are the action's
immediate effect (CP-8). They enter
beside the action when it is captured directly, and as its one proxy (CP-9)
otherwise; the entries of a context first appearing later in the chain enter in
the same role beside them, never as a further proxy (CP-8). Whether the
platform or the application's code opened the context does not change the
entries: they record the context's existence for the actions that follow, never
a second record of the action, and they are entries of the action stream in
their own role under CP-2, not the recorded context CP-3 and CP-4 govern. A
context that materializes with no user action behind it (a notification
window, or one a page's own interval opens, for example) is an effect under
CP-6 until a user action is taken in it, and that action establishes it
(SF-10); a timer a user action armed does not cut the chain (CP-8).

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
platforms, applied to the field description each platform captures — the
extension's form name, DOM id and `autocomplete` token, the desktop's
accessible name and automation id — so each platform masks the fields its own
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
