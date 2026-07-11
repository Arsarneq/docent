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
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

Platform-specific details:

- [Extension](../../architecture/application/extension/capture-principles.md)
- [Desktop](../../architecture/application/desktop/windows/capture-principles.md)

---

## Core Rule

**CP-1.** Capture what the user did — not what the code did.

**CP-2.** The core rule is an inclusion filter on the action stream: effects,
code-driven events, and guessed intent MUST NOT enter it.

**CP-3.** A small amount of observed context MAY be recorded _alongside_ the
actions to describe them faithfully — proxies for actions that happen outside
the capture layer's view (see [Proxy Capture](#proxy-capture)) and ambient
facts such as the window rectangle.

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
application code are not user actions and MUST NOT be captured as actions:

- Focus/value/selection changes triggered by code
- Windows/tabs opening or closing from code
- Navigations triggered by code (redirects, pushState, window.location)
- Scrolls triggered by code
- Synthetic/generated events from the platform
- Timer-driven UI updates
- Notifications appearing

The enumerated classes illustrate the category; they do not close it. A novel
consequence is judged against the category definition above.

---

## Proxy Capture

**CP-7.** Some user actions happen outside the capture layer's visibility
(browser chrome, OS shell, window title bar). These are captured by proxy:
the **immediate effect** stands in for the user action.

Every proxy is bound by three rules:

**CP-8.** A proxy MUST record only the **immediate** effect — never cascading
effects.

**CP-9.** A user action MUST produce at most **one** proxy — no duplicates.

**CP-10.** A proxy MUST **identify** what the user did.

---

## Sensitive Values

**CP-11.** Capture the action — mask the sensitive value. Docent records that
the user typed into a field, but when the field is sensitive (a password, or a
credit-card / SSN / secret field) the value MUST be redacted at capture time
and the element flagged `redacted`; the action stays in the stream, the secret
MUST NOT enter it.

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
