# Capture Principles

This document defines how Docent captures user interactions. It applies to
both the Chrome extension and the desktop application.

---

## Core Rule

**Capture exactly what the user did. Nothing else.**

Docent records the user's direct actions — not what happens as a result of
those actions. If a user clicks a button and that button's handler opens a
new tab, Docent captures the click. The tab opening is a side-effect and is
not captured.

---

## What Counts as a User Action

A user action is a physical input that the user deliberately performed:

- Clicking an element
- Right-clicking an element
- Pressing a key (Enter, Escape, Tab, Arrow keys)
- Typing text into an input field
- Selecting an option from a dropdown
- Dragging and dropping an element
- Scrolling the page
- Uploading a file (selecting it in the OS file dialog)

---

## What Does NOT Count as a User Action

These are effects — things that happen as a consequence of a user action:

- A page navigating after a link click or form submit
- A new tab/window opening after `window.open()` is called
- Focus moving to an element after JavaScript calls `.focus()`
- An input value changing because JavaScript set it
- A selection changing because JavaScript set it
- A redirect chain (302, meta refresh, `window.location`)
- A tab closing after JavaScript calls `window.close()`
- A scroll triggered by `scrollIntoView()` or `scrollBy()`
- A synthetic click fired by the browser when Enter is pressed on a button

---

## Browser Chrome Exception

Some user actions happen in browser chrome — outside the page DOM where
Docent has no visibility:

- Typing a URL in the address bar
- Clicking the back/forward button
- Clicking a bookmark
- Pressing F5 or Ctrl+R to reload
- Clicking a tab to switch to it
- Selecting a file in the OS file dialog

For these actions, Docent captures the **immediate effect** as a proxy for
what the user did. This is the only signal available:

| User action (in browser chrome) | Captured as |
|---|---|
| Type URL in address bar + Enter | `navigate` (nav_type: typed) |
| Click back button | `navigate` (nav_type: back_forward) |
| Click forward button | `navigate` (nav_type: back_forward) |
| Click bookmark | `navigate` (nav_type: auto_bookmark) |
| Press F5 / Ctrl+R | `navigate` (nav_type: reload) |
| Click a tab | `context_switch` |
| Ctrl+T / Ctrl+N (new tab/window) | `context_open` |
| Ctrl+W / click X (close tab) | `context_close` |
| Ctrl+Shift+T (reopen tab) | `context_open` |
| Select file in OS dialog | `file_upload` |
| Right-click → context menu selection | `context_open` + `navigate(link)` on new tab |

Only the immediate effect is captured — not any cascading effects that
follow (e.g. a page's autofocus on load, SPA router firing on navigation,
or a redirect chain after the initial navigate).

---

## How to Distinguish Action from Effect

The key question: **did the user physically do this, or did it happen because
of something the user did?**

Examples:

| Scenario | User action | Effect (not captured) |
|---|---|---|
| User clicks a link | `click` on the link | Page navigates |
| User presses Enter on a form | `key(Enter)` | Form submits, page navigates |
| User clicks "Open" button | `click` on the button | File dialog opens, new window appears |
| User types in a search box | `type` (value on change) | Autocomplete suggestions appear, focus moves |
| User presses Ctrl+T | *(browser chrome — not capturable)* | New tab opens → captured as `context_open` proxy |
| User types URL and presses Enter | *(browser chrome — not capturable)* | Page navigates → captured as `navigate(typed)` proxy |
| Timer updates a progress bar | *(no user action)* | Value changes — NOT captured |
| JavaScript calls `element.focus()` | *(no user action)* | Focus moves — NOT captured |

---

## Platform-Specific Notes

### Chrome Extension

The extension captures via two mechanisms:

1. **Content script** — listens to DOM events (click, keydown, change,
   focusin, scroll, dragstart, drop) in the page context
2. **Service worker** — listens to Chrome APIs (webNavigation, tabs) for
   browser chrome actions that produce navigations and tab lifecycle events

The content script captures direct user actions. The service worker captures
the immediate effects of browser chrome actions (the proxy signals).

### Desktop Application (Windows)

The desktop app captures via:

1. **Low-level input hooks** (WH_MOUSE_LL, WH_KEYBOARD_LL) — captures mouse
   clicks, keyboard input, and scroll wheel events
2. **WinEvent hooks** (SetWinEventHook) — captures focus changes, value
   changes, selection changes, and window lifecycle events
3. **Accessibility API** (IUIAutomation) — resolves element descriptions for
   captured events

The low-level hooks capture direct user input. The WinEvent hooks capture
both user actions and programmatic changes indiscriminately — filtering is
required to distinguish the two.

---

## Implications for Implementation

To correctly implement these principles, the capture layer must:

1. **Check `event.isTrusted`** on DOM events (extension) — programmatic
   `.click()`, `.dispatchEvent()` produce untrusted events
2. **Use platform signals to distinguish action from effect** — Chrome's
   `transitionType` (typed, reload, back_forward, auto_bookmark) identifies
   browser chrome navigations; `link`, `form_submit`, `generated` identify
   effects of in-page actions
3. **Filter browser-generated synthetic events** — Enter on a button fires a
   synthetic click at (0,0); this is not a user action
4. **Ignore programmatic state changes** — value changes, focus moves, and
   selection changes triggered by JavaScript are not user actions
5. **Capture browser chrome effects only once** — a single address bar
   navigation should produce exactly one `navigate` action, not duplicates
   from both the service worker and content script
6. **Track programmatic tabs** — tabs opened by `window.open()` are
   side-effects; their lifecycle (open, close) should not be captured
