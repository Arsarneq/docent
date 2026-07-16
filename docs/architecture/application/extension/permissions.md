# Permissions — Chrome Extension

The extension's complete permission surface, with each entry's rationale
traced to the runtime code that needs it. This document covers the
manifest's permission-bearing entries — `permissions` and
`host_permissions` — plus the two resource-exposure facts the manifest
states. The runtime architecture behind the rationales is in
[Runtime Architecture](runtime.md); the capture rules are in
[Capture Principles — Chrome Extension](capture-principles.md).

Each rule carries a stable identifier (**EPM-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../../clause-registry.json). The
key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

**EPM-1.** The [manifest](../../../../packages/extension/manifest.json) is
the admission test: the enumeration below is closed — the extension requests
exactly the permissions and host permissions listed in this document — and a
change to the manifest's permission surface MUST extend this document in the
same change. A permission change also needs its Chrome Web Store
privacy-practices justification filled before the next release
([PUBLISHING](../../../../.github/PUBLISHING.md#chrome-web-store-privacy-practices-manual)).

---

## Permissions

| Permission      | What Docent does with it                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alarms`        | The ~60 s background Auto-Sync backstop: a `chrome.alarms` alarm is persisted by the browser and re-wakes the suspended service worker, so background sync keeps running with the panel closed and across browser restarts ([runtime — lifecycle](runtime.md#lifecycle-and-the-persisted-state-model); [Sync Protocol — Automatic sync](../../../api/sync-protocol.md#automatic-sync-auto-sync)).                                  |
| `scripting`     | Programmatic recorder injection (`chrome.scripting.executeScript`): into every open http/https tab at record-start, and into each frame as it finishes loading during a recording ([ECP-2](capture-principles.md#architecture); [runtime — injection](runtime.md#injection)).                                                                                                                                                      |
| `storage`       | All persisted state: the project model, the pending capture buffer, settings, and sync state in `chrome.storage.local`; the ephemeral secret key in `chrome.storage.session`; and `chrome.storage.onChanged` as the panel/worker change-signal bus. The complete key inventory and its write-ownership contract are in [runtime — storage keys](runtime.md#storage-keys-and-write-ownership).                                      |
| `sidePanel`     | The extension's UI is a side panel (the manifest's `side_panel.default_path`); the service worker opens it when the toolbar button is clicked (`chrome.sidePanel.open`).                                                                                                                                                                                                                                                           |
| `tabs`          | Tab metadata and lifecycle for the browser-chrome proxies ([ECP-7](capture-principles.md#browser-chrome-proxies)): `tabs.onActivated` / `onCreated` / `onRemoved` drive `context_switch` / `context_open` / `context_close`, `tabs.get` reads the switched-to tab's URL and title, and `tabs.query` enumerates the http/https tabs for record-start injection and frame-registry seeding.                                          |
| `webNavigation` | Navigation and frame visibility: `onCommitted` drives the `navigate` proxies ([ECP-7](capture-principles.md#browser-chrome-proxies)), `onCompleted` triggers per-frame recorder injection ([ECP-2](capture-principles.md#architecture)), `onBeforeNavigate` prunes a navigating subframe's trust registration, and `getAllFrames` seeds and reseeds the frame registry ([ECP-3](capture-principles.md#frame-trust-and-readiness)). |

## Host permissions

| Host permission | What Docent does with it                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<all_urls>`    | Lets the service worker inject the recorder into any open http/https page the moment recording starts — a recording follows the user to any site without a per-site grant. Retaining the broad grant alongside programmatic injection is the decision recorded in [ECP-2](capture-principles.md#architecture). |

## Resource exposure stated by the manifest

- **Content security policy** — the manifest declares no
  `content_security_policy` key, so Chrome's Manifest V3 default policy
  applies to the extension's pages unmodified.
- **`web_accessible_resources`** — declared empty: the extension exposes no
  resource to web pages.
