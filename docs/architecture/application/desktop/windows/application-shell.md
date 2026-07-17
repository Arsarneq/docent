# Application Shell — Desktop Application

The Tauri shell the desktop application's capture and UI surfaces run on: the
command surface and event channel wiring the JavaScript frontend to the Rust
backend, the session-persistence commands and their credential-store
chokepoint, the tray keep-alive behind background Auto-Sync, the native HTTP
transport chokepoint, and the installer's declared file association. Companion
to [Capture Principles — Desktop Application](capture-principles.md), which
governs what may enter a recording, and to
[the capture pipeline](capture-pipeline.md), which owns how the
`capture:action` stream is produced; this document governs the shell those
surfaces are wired through. The cross-platform seams it implements are owned
elsewhere and cited in place:
[Shared Core](../../../../architecture/system/shared-core.md) (the adapter
seam), [Persistence](../../../../architecture/system/persistence.md) (where
each platform keeps its data), and the
[Dispatch Protocol](../../../../api/dispatch.md) (the transport policy).

Each rule carries a stable identifier (**DSH-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../../../clause-registry.json).
The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords
appear on a clause's operative requirement where it has one; definitional
clauses bind as stated without a keyword, and subsidiary absolutes inside a
clause inherit its force. A clause's scope runs from its marker to the next
marker or heading; identifiers reflect minting order and may appear out of
numeric sequence.

---

## Components

The application is one Tauri v2 crate hosting one webview window
(420×700 by default, resizable, under a strict `script-src 'self'` CSP —
[`tauri.conf.json`](../../../../../packages/desktop/src-tauri/tauri.conf.json)):

| Surface          | Entry                                                                                      | Runs                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust backend     | `src-tauri/src/main.rs` → [`lib.rs`](../../../../../packages/desktop/src-tauri/src/lib.rs) | The host process: the capture layer behind [the capture seam](../capture-seam.md), the commands and event channel below, the system tray, and the window-close handling.                                                                                                                                                          |
| Panel            | `src/index.html` + [`panel.js`](../../../../../packages/desktop/src/panel.js)              | In the webview. The panel driver owns the model: it holds the projects/settings state, mutates it locally, and persists it through the [session commands](#session-persistence) — the desktop half of the model-ownership split [Shared Core](../../../../architecture/system/shared-core.md#the-adapter-seam) states.            |
| Platform adapter | [`adapter-tauri.js`](../../../../../packages/desktop/src/adapter-tauri.js)                 | Implements the shared adapter seam over `invoke`/`listen`; holds the in-memory pending list fed by `capture:action`, and binds the shared HTTP transport at module load ([Native HTTP transport](#native-http-transport)).                                                                                                        |
| Tauri bridge     | [`tauri-bridge.js`](../../../../../packages/desktop/src/tauri-bridge.js)                   | The single access point to `invoke`/`listen`. The app ships `withGlobalTauri: false`, so the real Tauri API is never published to a `window` global — the shipped access path is this module's bundled ESM import (an injected global could at most interpose on the app's own calls; the CSP is what keeps injected script out). |

---

## The Command Surface

**DSH-1.** The table below is the complete contract the crate itself defines:
every `#[tauri::command]` the crate defines is registered in `lib.rs`'s
`generate_handler!` list and appears in the table, and `capture:action` is the
only event channel the backend emits. A change that adds, removes, or renames
a command or an event channel MUST update this table in the same change.

| Name                         | Direction | What it does                                                                                                                                                                                                                               | Who calls it                                                                                |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `start_capture`              | JS → Rust | Starts the capture layer streaming into `capture:action`. An optional `pid` arms self-capture exclusion for that process before starting — the shipped panel always passes `null` and arms exclusion through `set_self_capture_exclusion`. | `panel.js` recording start and re-record paths.                                             |
| `stop_capture`               | JS → Rust | Stops the capture layer; held completed actions are flushed before teardown ([DCP-12](capture-principles.md#worker-delivery-guarantees)).                                                                                                  | `panel.js` recording stop paths.                                                            |
| `list_windows`               | JS → Rust | Enumerates visible top-level windows (window id, title, process name, pid) for target-application selection.                                                                                                                               | `panel.js` target-application selector.                                                     |
| `check_permissions`          | JS → Rust | Reports whether the OS grants what capture needs (always granted on Windows).                                                                                                                                                              | Registered with no shipped frontend call site.                                              |
| `load_state`                 | JS → Rust | Reads the session file and re-injects the credential-store keys ([Session persistence](#session-persistence)); a missing or unreadable file reads as `{}`.                                                                                 | `panel.js` at startup and the adapter's settings loads.                                     |
| `save_state`                 | JS → Rust | Strips the credential keys into the credential store and writes the session file ([Session persistence](#session-persistence)).                                                                                                            | `panel.js` on every model mutation and the adapter's settings saves.                        |
| `get_self_pid`               | JS → Rust | Returns the application's own process id.                                                                                                                                                                                                  | Registered with no shipped frontend call site.                                              |
| `commit_barrier`             | JS → Rust | Runs the step-commit flush barrier ([DCP-2](capture-principles.md#architecture)) and returns `{ barrier_id, wedged_workers }`; the completion sentinel it triggers arrives on `capture:action`.                                            | The adapter's `commitWithCompleteness`, invoked by the panel's step commit.                 |
| `set_self_capture_exclusion` | JS → Rust | Arms or clears self-capture exclusion for the app's own process ([DCP-5](capture-principles.md#capture-surface)).                                                                                                                          | `panel.js`: the Settings toggle, and once at startup from the persisted setting.            |
| `set_target_pid`             | JS → Rust | Sets or clears the target-application filter ([DCP-5](capture-principles.md#capture-surface)); `null` or `0` clears it.                                                                                                                    | `panel.js` target-application selector.                                                     |
| `set_auto_sync_keepalive`    | JS → Rust | Arms or disarms the hide-on-close keep-alive ([Background Auto-Sync keep-alive](#background-auto-sync-keep-alive)).                                                                                                                        | `panel.js`, as the Auto-Sync host starts and stops.                                         |
| `export_file`                | JS → Rust | Opens the native save dialog and writes the export to the chosen path; cancelling writes nothing and is not an error.                                                                                                                      | `panel.js` export.                                                                          |
| `import_file`                | JS → Rust | Opens the native open dialog and returns the chosen file's contents, or `null` on cancel.                                                                                                                                                  | `panel.js` import.                                                                          |
| `sync_http_request`          | JS → Rust | The native HTTP transport ([Native HTTP transport](#native-http-transport)): issues one validated outbound request and returns a `fetch`-shaped response.                                                                                  | The adapter's bound transport — every shared sync, dispatch, and connection-test request.   |
| `capture:action` (event)     | Rust → JS | Streams every captured action (carrying the internal `sequence_id`) and the barrier-completion sentinel to the frontend, in the order the shared action channel received them.                                                             | Emitted by the forwarder thread `lib.rs` spawns; consumed by the adapter's single listener. |

The crate's commands are not the whole invokable surface: the webview can
also invoke the Tauri plugin commands granted by
[`capabilities/default.json`](../../../../../packages/desktop/src-tauri/capabilities/default.json)
— the `core:default` set and the dialog plugin's grants (`dialog:default`,
which resolves to the plugin's message, open, and save commands, plus the
explicit open/save allowances). The `core:default` grant is load-bearing:
the adapter's `capture:action` listener is itself an event-plugin
invocation that grant authorizes, exercised on every captured action. The
dialog grants are unused headroom today — no shipped frontend code invokes
the dialog plugin; the file dialogs are opened from Rust inside
`export_file`/`import_file`, which capabilities do not gate. The capability
file is the closed admission gate
for the plugin surface: a command outside the crate's table and the granted
set is not invokable, and widening a grant widens what the webview can
reach.

The `capture:action` channel is the shell's one backend→frontend event
surface; what rides it is the capture documents' territory. The adapter
splices each arriving action into the in-memory pending list by
`sequence_id` and applies the redaction chokepoint before anything is stored
([DCP-2](capture-principles.md#architecture),
[DCP-11](capture-principles.md#sensitive-value-redaction)); the
`barrier_complete` sentinel is consumed by the adapter to resolve a commit's
bounded wait and never enters the pending list or an export
([the capture pipeline](capture-pipeline.md)). The pending list itself is
deliberately ephemeral —
[Persistence](../../../../architecture/system/persistence.md#deliberately-ephemeral-state)
owns that platform difference.

---

## Session Persistence

[Persistence](../../../../architecture/system/persistence.md#desktop--the-session-file-and-the-credential-store)
owns the cross-platform picture of where data lives; this section owns the
command-level mechanics. The desktop persists one JSON blob —
`%APPDATA%/com.docent.desktop/session.json` — carrying `projects`,
`settings`, and the durable sync reconcile state (`syncState`); the active
project/recording selection lives in the panel's memory only and is not
persisted. The frontend serializes and writes the blob through `save_state`
on every model mutation (the panel's model writes and the adapter's settings
saves funnel into the same command) and reads it through `load_state` at
startup. The Rust side owns the path and the file I/O
([`commands.rs`](../../../../../packages/desktop/src-tauri/src/commands.rs));
a missing or unreadable file reads as `{}`, and JSON the frontend cannot parse
starts the app with an empty state (the `loadState` catch in
[`panel.js`](../../../../../packages/desktop/src/panel.js)).

**DSH-2.** `save_state`/`load_state` are the credential chokepoint: on save,
the two managed keys — `settings.apiKey` and `settings.syncApiKey` — are
stripped out of the JSON and written to Windows Credential Manager (service
`com.docent.desktop`,
[`secret_store.rs`](../../../../../packages/desktop/src-tauri/src/secret_store.rs));
on load they are re-injected, so the frontend sees an unchanged shape. On the
shipped Windows target the session file on disk MUST NOT carry either key.
Saving a key as empty or null deletes its credential entry (clearing a key in
Settings clears the credential), while a save whose JSON omits the field
leaves the stored credential untouched — a load/modify/save cycle cannot wipe
a configured key. On targets without a credential backend the store is
disabled and the keys stay inline in the JSON; desktop releases are scoped to
Windows ([Publishing](../../../../../.github/PUBLISHING.md)), so no shipped
build takes that path (the capture seam documents those targets'
[compile-only posture](../capture-seam.md)).

---

## Background Auto-Sync Keep-Alive

Automatic sync
([Sync Protocol — automatic sync](../../../../api/sync-protocol.md#automatic-sync-auto-sync))
needs a context that stays alive when the window is closed. The desktop's
keep-alive is the webview itself: while the panel has armed
`set_auto_sync_keepalive`, a window close request is intercepted in `lib.rs`
and the window is hidden instead of destroyed, so the frontend's Auto-Sync
timer and the shared `sync()` it invokes keep running headless. While
disarmed, the close proceeds normally and the application quits with its last
window. The panel arms the keep-alive exactly when it starts the Auto-Sync
host and disarms it when the host stops — reconciled with the persisted
Auto-sync setting and the configured endpoint at startup and on every settings
change.

The system tray owns the way back: its menu (also opened by a left click on
the icon) carries **Show Docent**, which re-shows and focuses the window, and
**Quit**, which exits the application regardless of the keep-alive. The
user-facing statement of this behaviour is the
[desktop guide's Sync section](../../../../user/desktop-windows.md#sync).

The host itself
([`auto-sync-host.js`](../../../../../packages/desktop/src/auto-sync-host.js))
is DOM-free so the cycle can run with the window hidden: a ~60-second backstop
timer plus a data-event hook the panel calls after meaningful local data
changes, both routed through the shared cooldown-debounced scheduler
([SP-22](../../../../api/sync-protocol.md#automatic-sync-auto-sync)). Every
cycle it triggers runs the same shared `sync()` with the same sync-state
store and live-state adapters as the manual Sync button; an auth halt disables
Auto-sync, stops the trigger, and flags Settings for a fresh connection test
([SP-23](../../../../api/sync-protocol.md#automatic-sync-auto-sync)).

One shipped defect fences the trigger sources: the panel nulls the registered
data-event hook immediately after starting the host (`startAutoSyncHost` in
`panel.js`), so the data-event trigger never fires and the ~60-second backstop
is the only thing driving desktop cycles today — the data events are wired at
every call site but severed at that one assignment.
[docent#342](https://github.com/Arsarneq/docent/issues/342) tracks the fix;
the extension is unaffected.

---

## Native HTTP Transport

The shared sync, dispatch, and connection-test code issues every HTTP request
through the shared transport seam
([dispatch §DI-12](../../../../api/dispatch.md#transport-seam)). The desktop
binds that seam once, at adapter module load — before the panel runs any sync
— to the `sync_http_request` command, and adapts the command's response back
into the seam's `fetch` subset (`ok`, `status`, `headers.get(name)` over
lower-cased header names, `json()`, `text()`). The seam's `signal` is not
forwarded across `invoke`; the command's own 30-second timeout is the
per-attempt bound.

The command
([`sync_http.rs`](../../../../../packages/desktop/src-tauri/src/sync_http.rs))
is the chokepoint [dispatch §DI-11](../../../../api/dispatch.md#endpoint-url-policy)
governs: the only native, CORS-free outbound HTTP primitive exposed to the UI
layer, re-enforcing its transport policy per request — `https://` to any
host, plaintext `http://` only to loopback, never a link-local address —
deliberately stricter at request time than the shared save-time rule
([DI-10](../../../../api/dispatch.md#endpoint-url-policy)). This document
adds no rule of its own there; the policy and its verification live with
those clauses.

The same reachability posture bounds what a webview foothold could touch:
with `withGlobalTauri: false` and the `script-src 'self'` CSP, the Tauri API —
the crate commands above and the granted plugin surface — is never published
to a `window` global and is reached through the bridge module's bundled ESM
import, and the CSP's `connect-src` independently constrains the webview's
own `fetch`.

---

## File Association — Declared, Not Consumed

The bundle configuration declares a file association for the `docent.json`
extension (MIME type `application/json`, description "Docent Recording") in
[`tauri.conf.json`](../../../../../packages/desktop/src-tauri/tauri.conf.json),
for the installer to register with Windows. The application contains no
handling for a file passed at launch: `main.rs` calls `run()` directly,
nothing reads the process arguments, and no file-open event is handled — the
only import path is the `import_file` dialog. A launch through the
association therefore cannot import the file. This is an admitted gap between
the installer's declaration and the application's behaviour: the association
exists in configuration; nothing consumes an opened file.
