# Capture Principles

The core rules for how Docent captures user interactions. Applies to both
the Chrome extension and the desktop application.

Platform-specific details:
- [Extension](capture-principles-extension.md)
- [Desktop](capture-principles-desktop.md)

---

## Core Rule

**Capture exactly what the user did. Nothing else.**

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

## Distinguishing Action from Effect

| Signal | User action | Effect |
|--------|-------------|--------|
| Low-level input hook fired | ✅ | — |
| `event.isTrusted === false` | — | ✅ |
| No preceding user input | — | ✅ Likely programmatic |
| Platform identifies cause (transitionType, etc.) | Depends | Depends |
