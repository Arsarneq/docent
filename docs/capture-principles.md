# Capture Principles

The core rules for how Docent captures user interactions. Applies to both
the Chrome extension and the desktop application.

Platform-specific details:

- [Extension](capture-principles-extension.md)
- [Desktop](capture-principles-desktop.md)

---

## Core Rule

**Capture what the user did — not what the code did.**

This is an inclusion filter on the action stream: effects, code-driven events, and
guessed intent never enter it. A small amount of observed context is recorded
_alongside_ the actions to describe them faithfully — proxies for actions that happen
outside the capture layer's view (see [Proxy Capture](#proxy-capture)) and ambient
facts such as the window rectangle. That context is always kept distinct from the
actions themselves; it is never invented and never treated as something the user did.

---

## What IS a User Action

A physical input the user deliberately performed:

- Mouse: left-click, right-click, middle-click, double-click, drag, scroll
- Keyboard: control keys, F-keys, modifier combos, typing text
- Interactions: selecting from a dropdown, confirming a dialog, choosing a file

---

## What is NOT a User Action

Things that happen as a consequence of a user action or from application code:

- Focus/value/selection changes triggered by code
- Windows/tabs opening or closing from code
- Navigations triggered by code (redirects, pushState, window.location)
- Scrolls triggered by code
- Synthetic/generated events from the platform
- Timer-driven UI updates
- Notifications appearing

---

## Proxy Capture

Some user actions happen outside the capture layer's visibility (browser
chrome, OS shell, window title bar). For these, capture the **immediate
effect** as a proxy:

1. Only the **immediate** effect — not cascading effects
2. Only **one** proxy per user action — no duplicates
3. The proxy must **identify** what the user did

---

## Sensitive Values

Capture the action — mask the sensitive value. Docent records that the user typed
into a field, but when the field is sensitive (a password, or a credit-card / SSN
/ secret field) the value itself is redacted at capture time and the element is
flagged `redacted`; the action stays in the stream, the secret does not enter it.
Detection is deliberately conservative — over-masking a legitimate field would
degrade the captured workflow — so only strong signals trigger it. Platform
specifics (and tokened-URL redaction, which is browser-only) are in the
[extension](capture-principles-extension.md) and [desktop](capture-principles-desktop.md)
docs.

---

## Distinguishing Action from Effect

| Signal                                           | User action | Effect                 |
| ------------------------------------------------ | ----------- | ---------------------- |
| Low-level input hook fired                       | ✅          | —                      |
| `event.isTrusted === false`                      | —           | ✅                     |
| No preceding user input                          | —           | ✅ Likely programmatic |
| Platform identifies cause (transitionType, etc.) | Depends     | Depends                |
