# Capture Principles — Chrome Extension

Platform-specific details for the extension. See [core rules](capture-principles.md).

---

## Architecture

1. **Content script** (`content/recorder.js`) — DOM events in the page
2. **Service worker** (`background/service-worker.js`) — Chrome APIs for browser chrome proxies

---

## Browser Chrome Proxies

These user actions happen in browser chrome (not visible to the content script):

| User action | Captured as |
|---|---|
| Type URL + Enter | `navigate` (typed/generated) |
| Click back/forward | `navigate` (back_forward) |
| Click bookmark | `navigate` (auto_bookmark) |
| F5 / Ctrl+R | `navigate` (reload) |
| Click a tab | `context_switch` |
| Ctrl+T / Ctrl+N | `context_open` |
| Ctrl+W / click X | `context_close` |
| Ctrl+Shift+T | `context_open` |
| Select file in OS dialog | `file_upload` |
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
