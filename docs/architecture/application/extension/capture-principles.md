# Capture Principles — Chrome Extension

Platform-specific details for the extension. See [core rules](../../../architecture/system/capture-principles.md).

---

## Architecture

1. **Recorder** (`content/recorder.js`) — DOM events in the page, running in the
   content-script isolated world
2. **Service worker** (`background/service-worker.js`) — Chrome APIs for browser chrome proxies

The service worker imports everything it needs **statically at module scope** —
a Manifest V3 service worker cannot use dynamic `import()` (it throws at
runtime). A lint rule on the background layer and a guard test enforce this at
the worker's entry module.

The recorder is **not** a passive `<all_urls>` content script. It is injected
programmatically by the service worker, and **only while a recording is active**:

- On record-start, the service worker injects the recorder into every open
  http/https tab and frame.
- For the rest of the recording, each frame is injected as it finishes loading
  (`webNavigation.onCompleted`), so newly opened tabs, navigations, and
  dynamically created iframes are covered as they appear.

When no recording is running, no recorder is present on any page — the idle
surface is just the service worker. (The `host_permissions: <all_urls>` grant is
retained by decision: it is what lets the service worker inject into any page the
moment recording starts.)

### Frame trust and readiness

Because actions arrive at the service worker as messages, the service worker
validates every inbound `APPEND_ACTION` against an in-memory **active-frame
registry** (tab → frames): a message is accepted only when it comes from this
extension, during a live recording, from a (tab, frame) pair present in the
registry. The registry is seeded from the browser's own frame table
(`webNavigation.getAllFrames`) at record-start, updated as frames report ready,
and — because it is in-memory and the service worker can be suspended — lazily
reseeded from the same frame table when an append arrives from a tab with no
registry entry at all (the suspension signature), rather than false-rejecting a
legitimate frame whose registration was lost with the suspended worker.
Anything else — an embedded ad, analytics, or third-party widget that can reach
the message port — is dropped. The action's `context_id` is stamped from the
**trusted sender**, never from the message body, so a frame cannot claim to be a
different tab.

Each injected recorder reports readiness back to the service worker with a
`FRAME_READY` message rather than setting a page-visible flag — the recorder runs
in the isolated world, so a `window` flag would both be invisible to the service
worker and leak recording state to the page.

---

## Capture Surface

The capture surface is enumerated positively and treated as **closed**: the
recorder listens for a fixed set of trusted DOM events (the exact set lives in
`content/recorder.js`), and the service worker captures the browser-chrome
proxies in the table below. An interaction that reaches neither is not
captured — no per-case listing needed, and nothing new the platform grows is
captured implicitly. The only negative entries kept are the
[exceptions within the surface](#exceptions-within-the-surface): interactions
that would appear to be covered by this description but are not.

---

## Browser Chrome Proxies

These user actions happen in browser chrome (not visible to the content script):

| User action                   | Captured as                       |
| ----------------------------- | --------------------------------- |
| Type URL + Enter              | `navigate` (typed/generated)      |
| Click back/forward            | `navigate` (back_forward)         |
| Click bookmark                | `navigate` (auto_bookmark)        |
| F5 / Ctrl+R                   | `navigate` (reload)               |
| Click a tab                   | `context_switch`                  |
| Ctrl+T / Ctrl+N               | `context_open`                    |
| Ctrl+W / click X              | `context_close`                   |
| Ctrl+Shift+T                  | `context_open`                    |
| Select file in OS dialog      | `file_upload`                     |
| Right-click → Open in new tab | `context_open` + `navigate(link)` |

---

## Filtering Approach

- `event.isTrusted` rejects programmatic DOM events
- Chrome's `transitionType` identifies browser chrome navigations vs effects
- `programmaticTabs` set tracks tabs from `window.open()`
- Timing windows centralized in `lib/capture-timing.js` (see code for values)
- SPA navigation capture removed entirely (all are effects of captured clicks/keys)

---

## Exceptions Within the Surface

Interactions that would appear to be inside the
[capture surface](#capture-surface) above but are not captured (or are
captured with a caveat). An entry belongs here only when the surface
description alone would mislead:

- Keyboard shortcuts not in `CAPTURE_KEYS` are not captured as key events —
  the keyboard surface is the whitelist, not all keys
- Arrow keys in native `<select>` are swallowed by the browser before the
  recorder's listeners see them
- `window.open()` detection uses a timing window (see `capture-timing.js`)
- `window.close()` detection uses a timing window on programmatic tabs
