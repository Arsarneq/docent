# Capture Principles — Chrome Extension

Platform-specific details for the extension. See [core rules](capture-principles.md).

---

## Architecture

1. **Recorder** (`content/recorder.js`) — DOM events in the page, running in the
   content-script isolated world
2. **Service worker** (`background/service-worker.js`) — Chrome APIs for browser chrome proxies

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

Because actions arrive at the service worker as messages, the service worker only
trusts the frames it actually injected into. It keeps an in-memory
**active-frame registry** (tab → injected frames) and validates every inbound
`APPEND_ACTION` against it: a message is accepted only when it comes from this
extension, during a live recording, from a frame the service worker injected.
Anything else — an embedded ad, analytics, or third-party widget that can reach
the message port — is dropped. The action's `context_id` is stamped from the
**trusted sender**, never from the message body, so a frame cannot claim to be a
different tab.

Each injected recorder reports readiness back to the service worker with a
`FRAME_READY` message rather than setting a page-visible flag — the recorder runs
in the isolated world, so a `window` flag would both be invisible to the service
worker and leak recording state to the page.

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

## Known Limitations

- Keyboard shortcuts not in `CAPTURE_KEYS` are not captured as key events
- Arrow keys in native `<select>` are swallowed by the browser
- `window.open()` detection uses a timing window (see `capture-timing.js`)
- `window.close()` detection uses a timing window on programmatic tabs
