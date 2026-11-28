# Application Shell — Desktop Application

The Tauri shell the desktop application's capture and UI surfaces run on:

- the command surface and event channel that wire the JavaScript frontend to the Rust backend;
- the session-persistence commands and their credential-store chokepoint;
- the tray keep-alive behind background Auto-Sync;
- the native HTTP transport chokepoint;
- the installer's declared file association.

Its companions are [Capture Principles — Desktop Application](capture-principles.md), which governs what may enter a recording, and [the capture pipeline](capture-pipeline.md), which orients on the stages behind the `capture:action` stream. This document governs the shell those surfaces are wired through. Other documents own the cross-platform seams it implements, cited in place: [Shared Core](../../../../architecture/system/shared-core.md) (the adapter seam), [Persistence](../../../../architecture/system/persistence.md) (where each platform keeps its data), and the [Dispatch Protocol](../../../../api/dispatch.md) (the transport policy).

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
marker or heading; identifiers reflect minting order and can appear out of
numeric sequence.

---

## Components

The application is one Tauri v2 crate hosting one webview window (420×700 by default, resizable, under a strict `script-src 'self'` CSP, per [`tauri.conf.json`](../../../../../packages/desktop/src-tauri/tauri.conf.json)):

| Surface          | Entry                                                                                      | Runs                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust backend     | `src-tauri/src/main.rs` → [`lib.rs`](../../../../../packages/desktop/src-tauri/src/lib.rs) | The host process: the capture layer behind [the capture seam](../capture-seam.md), the commands and event channel below, the system tray, and the window-close handling.                                                                                                                                                          |
| Panel            | `src/index.html` + [`panel.js`](../../../../../packages/desktop/src/panel.js)              | In the webview. The panel driver owns the model: it holds the projects/settings state, mutates it locally, and persists it through the [session commands](#session-persistence). This is the desktop half of the model-ownership split [Shared Core](../../../../architecture/system/shared-core.md#the-adapter-seam) states.     |
| Platform adapter | [`adapter-tauri.js`](../../../../../packages/desktop/src/adapter-tauri.js)                 | Implements the shared adapter seam over `invoke`/`listen`; holds the in-memory pending list fed by `capture:action`, and binds the shared HTTP transport at module load ([Native HTTP transport](#native-http-transport)).                                                                                                        |
| Tauri bridge     | [`tauri-bridge.js`](../../../../../packages/desktop/src/tauri-bridge.js)                   | The single access point to `invoke`/`listen`. The app ships `withGlobalTauri: false`, so the real Tauri API is never published to a `window` global. The shipped access path is this module's bundled ESM import. (An injected global could at most interpose on the app's own calls; the CSP is what keeps injected script out.) |

---

## The Command Surface

**DSH-1.** The table below is the complete contract the crate itself defines:
every `#[tauri::command]` the crate defines is registered in `lib.rs`'s
`generate_handler!` list and appears in the table, and `capture:action` is the
only event channel the backend emits. A change that adds, removes, or renames
a command or an event channel MUST update this table in the same change, and
a change to the granted plugin surface MUST update this section's grant
enumeration likewise. This section's prose outside the table names that
channel and no other channel-shaped token, so a rename MUST land on the prose
and the table together.

The contract is closed on the caller side too. Every command the table states
is invoked from the desktop frontend's own modules — the caller closure — and
every direct `invoke` those modules issue names a command the table states —
the direct-invoke closure. The only granted plugin command the frontend
reaches is the event-plugin invocation behind the bridge's `listen`, which
`core:default` authorizes; no frontend module invokes a granted plugin command
directly, and a change that does MUST extend this clause and the check that
holds it in the same change. The `capture:action` channel has exactly one
frontend consumer — the adapter's single `listen` registration — and a change
that adds another MUST extend this clause and the check that holds it
likewise.

| Name                         | Direction | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Who calls it                                                                                                                                                                                                                                                 |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start_capture`              | JS → Rust | Starts the capture layer streaming into `capture:action`. An optional `pid` arms self-capture exclusion for that process before starting — the shipped panel always passes `null` and arms exclusion through `set_self_capture_exclusion`. A capture layer that cannot initialize its input observation (COM init, hook registration) fails the command with the platform error instead of starting a session that cannot capture.                                                             | `panel.js` recording start and re-record paths.                                                                                                                                                                                                              |
| `stop_capture`               | JS → Rust | Stops the capture layer; runs the in-order commit flush barrier as it stops — draining held completed actions behind the step and emitting the `barrier_complete` sentinel last — before teardown, and returns `{ barrier_id, wedged_workers, completion }`, where `completion` states whether the flush was exactly one of marker-ordered, recovered by fallback drain, or not run ([DCP-2](capture-principles.md#architecture), [DCP-12](capture-principles.md#worker-delivery-guarantees)). | `panel.js` recording stop paths; the adapter's `stopWithCompleteness`, invoked by the panel's step commit while recording and by a way out of the recording view while a step is being re-recorded, so what the stop drains is discarded with the re-record. |
| `list_windows`               | JS → Rust | Enumerates visible top-level windows (exactly its window id, title, process name and pid) for target-application selection.                                                                                                                                                                                                                                                                                                                                                                    | `panel.js` target-application selector.                                                                                                                                                                                                                      |
| `load_state`                 | JS → Rust | Reads the session file and re-injects the credential-store keys ([Session persistence](#session-persistence)); a missing file reads as `{}`, and a file it cannot use answers with an error and is never written over (DSH-3).                                                                                                                                                                                                                                                                 | `panel.js` at startup, and the adapter's settings members — every one of them reads through it, a save member as the first half of its round-trip.                                                                                                           |
| `save_state`                 | JS → Rust | Strips the credential keys into the credential store and writes the session file ([Session persistence](#session-persistence)).                                                                                                                                                                                                                                                                                                                                                                | `panel.js` on every model mutation, and the adapter's settings save members (the shipped panel takes the sync-settings save through the seam and holds the rest in its own model — the typedef's caller model).                                              |
| `commit_barrier`             | JS → Rust | Runs the step-commit flush barrier mid-capture without stopping ([DCP-2](capture-principles.md#architecture)) and returns `{ barrier_id, wedged_workers, completion }`; with no active capture no barrier runs and the command reports the `barrier_id: 0` no-op (completion `not_run`). The completion sentinel an active barrier triggers arrives on `capture:action`.                                                                                                                       | The adapter's `commitWithCompleteness` — the panel's step commit when capture is already stopped (a commit while recording flushes through `stop_capture` instead).                                                                                          |
| `set_self_capture_exclusion` | JS → Rust | Arms or clears self-capture exclusion for the app's own process ([DCP-5](capture-principles.md#capture-surface)).                                                                                                                                                                                                                                                                                                                                                                              | `panel.js`: the exclusion toggle in the panel's target-application controls, and once at startup from the persisted setting.                                                                                                                                 |
| `set_target_pid`             | JS → Rust | Sets or clears the target-application filter ([DCP-5](capture-principles.md#capture-surface)); `null` or `0` clears it.                                                                                                                                                                                                                                                                                                                                                                        | `panel.js` target-application selector.                                                                                                                                                                                                                      |
| `set_auto_sync_keepalive`    | JS → Rust | Arms or disarms the hide-on-close keep-alive ([Background Auto-Sync keep-alive](#background-auto-sync-keep-alive)).                                                                                                                                                                                                                                                                                                                                                                            | `panel.js`, as the Auto-Sync host starts and stops.                                                                                                                                                                                                          |
| `export_file`                | JS → Rust | Opens the native save dialog and writes the export to the chosen path; cancelling writes nothing and is not an error.                                                                                                                                                                                                                                                                                                                                                                          | `panel.js` export.                                                                                                                                                                                                                                           |
| `import_file`                | JS → Rust | Opens the native open dialog and returns the chosen file's contents, or `null` on cancel.                                                                                                                                                                                                                                                                                                                                                                                                      | `panel.js` import.                                                                                                                                                                                                                                           |
| `sync_http_request`          | JS → Rust | The native HTTP transport ([Native HTTP transport](#native-http-transport)): issues one validated outbound request and returns a `fetch`-shaped response.                                                                                                                                                                                                                                                                                                                                      | The adapter's bound transport — every request of exactly the shared sync, dispatch, and connection-test logic.                                                                                                                                               |
| `capture:action` (event)     | Rust → JS | Streams every captured action (carrying the internal `sequence_id`) and the barrier-completion sentinel to the frontend, in the order the shared action channel received them.                                                                                                                                                                                                                                                                                                                 | Emitted by the forwarder thread `lib.rs` spawns; consumed by the adapter's single listener.                                                                                                                                                                  |

The crate's commands are not the whole invokable surface: the webview can
also invoke the Tauri plugin commands granted by the capability files (today
[`capabilities/default.json`](../../../../../packages/desktop/src-tauri/capabilities/default.json)).
This section's grant enumeration is the list below, each item naming the grant
it lists as its first backticked token:

- `core:default` — the core set.
- `dialog:default` — the dialog plugin's default set, which resolves to exactly
  the plugin's message, open, and save commands.
- `dialog:allow-open` — the dialog plugin's explicit open allowance.
- `dialog:allow-save` — the dialog plugin's explicit save allowance.

The `core:default` grant is load-bearing: the adapter's `capture:action`
listener is itself an event-plugin invocation that grant authorizes,
exercised on every captured action. So is `dialog:default`: the dialog
plugin injects a script into the webview that replaces `window.alert` and
`window.confirm` with versions that invoke its message command, so every
`alert()` and `confirm()` the panel makes is a native dialog that grant
authorizes. The replacement `confirm()` is asynchronous: it answers with a
Promise of the user's choice, never the boolean itself, so the panel awaits it
before acting on the answer. The open and save grants are unused headroom
today — no shipped frontend code invokes the plugin's open or save command; the
file dialogs are opened from Rust inside `export_file`/`import_file`, which
capabilities do not gate. For the user the native dialogs stand in for the browser's
download and file-picker flows — Export writes the same file, Import picks a
file — a difference of mechanism, not of outcome, which the
[index of deliberate differences](../../../../design/ui_ux/shared-interaction-model.md#the-deliberate-platform-differences)
lists. The capability files are the closed admission gate for the
plugin surface: a command outside the crate's table and the granted set is
not invokable, and widening a grant widens what the webview can reach.

The `capture:action` channel is the shell's one backend→frontend event
surface; what rides it is the capture documents' territory. The adapter
splices each arriving action into the in-memory pending list by
`sequence_id` and applies the redaction chokepoint before anything is stored
([DCP-2](capture-principles.md#architecture),
[DCP-11](capture-principles.md#sensitive-value-redaction)); the
`barrier_complete` sentinel is consumed by the adapter to resolve a commit's
bounded wait and never enters the pending list or an export
([capture principles](capture-principles.md), DCP-2). The pending list itself is
deliberately ephemeral —
[Persistence](../../../../architecture/system/persistence.md#deliberately-ephemeral-state)
owns that platform difference.

---

## Session Persistence

[Persistence](../../../../architecture/system/persistence.md#desktop--the-session-file-and-the-credential-store) owns the cross-platform picture of where data lives. This section owns the command-level mechanics.

The desktop persists one JSON blob, `%APPDATA%/com.docent.desktop/session.json`, carrying `projects`, `settings`, and the durable sync reconcile state (`syncState`). The active project/recording selection lives in the panel's memory only and is not persisted. The frontend serializes and writes the blob through `save_state` on every model mutation (the panel's model writes and the adapter's settings saves funnel into the same command). It reads the blob through `load_state` at startup.

The two writers reach that command differently, and their order is part of the arrangement. The adapter's settings save is a load-mutate-save over the copy on disk. The panel's save is a whole-blob write of the copy in its memory. So after a seam save, the panel writes the same values into that memory copy, which is what carries them into the panel's next write. When the sync server URL is cleared, `saveSyncSettings` omits both keys from its write. When both fields are cleared, the panel's mirror-back writes them null, so on that path the panel's write satisfies DSH-2's clear branch. The seam declares the caller model this rests on in the `PlatformAdapter` typedef's header ([`adapter.js`](../../../../../packages/shared/views/adapter.js)).

The Rust side owns the path and the file I/O ([`commands.rs`](../../../../../packages/desktop/src-tauri/src/commands.rs)). A missing file reads as `{}`. A file it cannot use takes the path DSH-3 states.

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

**DSH-3.** A session file that exists but cannot be read, or that does not hold a JSON object, MUST NOT be written over. `load_state` moves it aside, to `session.unreadable-<UTC time>.json` in the same folder, and answers with an error that names where it was kept and carries `{}` with the credential-store keys re-injected; the panel starts from that state, so its next save keeps the stored keys (DSH-2's clear branch), tells the user the path, and saving goes on to a new session file. When the move fails as well, the file stays where it is, `load_state` answers with an error saying so, and `save_state` refuses every save for the rest of the run; every later `load_state` of the run answers with the same error without reading or moving the file, so it stays where the user was told it is. The panel tells the user that nothing will be saved until the app is restarted, and writes nothing itself. The refusal is not lifted during the run, since the panel's copy in memory started empty. `save_state` writes the blob to a temporary file in the same folder, flushes it to disk, and renames it over the session file, so a save cut short leaves the previous file whole. The answers reach the frontend as the command's error, tagged by `kind` (`set_aside`, `kept_in_place`, or `no_location` when the file's location is unknown, which refuses saves and later loads the same way), read in [`persistence.js`](../../../../../packages/desktop/src/persistence.js); a set-aside whose state cannot be read stops the panel's saves as well, and the message then says so.

---

## Background Auto-Sync Keep-Alive

Automatic sync ([Sync Protocol — automatic sync](../../../../api/sync-protocol.md#automatic-sync-auto-sync)) needs a context that stays alive when the window is closed. The desktop's keep-alive is the webview itself. While the panel has armed `set_auto_sync_keepalive`, `lib.rs` intercepts a window close request and hides the window instead of destroying it. So the frontend's Auto-Sync timer and the shared `sync()` it invokes keep running headless. While disarmed, the close proceeds normally and the application quits with its last window. The panel arms the keep-alive exactly when it starts the Auto-Sync host and disarms it when the host stops, reconciled with the persisted Auto-sync setting and the configured endpoint at startup and on every settings change.

The system tray owns the way back. Its menu (also opened by a left click on the icon) carries **Show Docent**, which re-shows and focuses the window, and **Quit**, which exits the application regardless of the keep-alive. The [desktop guide's Sync section](../../../../user/desktop-windows.md#sync) is the user-facing statement of this behavior. For the user the two platforms are equivalent (background cycles keep running on both), so the tray stands in for the browser's background context, its service worker. This is a difference of mechanism, not of outcome, which the [index of deliberate differences](../../../../design/ui_ux/shared-interaction-model.md#the-deliberate-platform-differences) lists.

The host itself ([`auto-sync-host.js`](../../../../../packages/desktop/src/auto-sync-host.js)) is DOM-free, so the cycle can run with the window hidden. It runs on a ~60-second backstop timer plus a data-event hook the panel calls after meaningful local data changes. Both route through the shared cooldown-debounced scheduler ([SP-22](../../../../api/sync-protocol.md#automatic-sync-auto-sync)). Every cycle it triggers runs the same shared `sync()`, with the same sync-state store and live-state adapters, as the manual Sync button. An auth halt disables Auto-sync, stops the trigger, and flags Settings for a fresh connection test ([SP-23](../../../../api/sync-protocol.md#automatic-sync-auto-sync)).

One shipped defect fences the trigger sources. The panel nulls the registered data-event hook immediately after starting the host (`startAutoSyncHost` in `panel.js`). So the data-event trigger never fires, and the ~60-second backstop is the only thing driving desktop cycles today. The data events are wired at every call site but severed at that one assignment. [docent#342](https://github.com/Arsarneq/docent/issues/342) tracks the fix; the extension is unaffected.

---

## Native HTTP Transport

The shared sync, dispatch, and connection-test code issues every HTTP request through the shared transport seam ([dispatch §DI-12](../../../../api/dispatch.md#transport-seam)). The desktop binds that seam to the `sync_http_request` command once, at adapter module load, before the panel runs any sync. It adapts the command's response back into the seam's `fetch` subset (`ok`, `status`, `headers.get(name)` over lower-cased header names, `json()`, `text()`). The seam's `signal` is not forwarded across `invoke`; the command's own 30-second timeout is the per-attempt bound.

The command ([`sync_http.rs`](../../../../../packages/desktop/src-tauri/src/sync_http.rs)) is the chokepoint [dispatch §DI-11](../../../../api/dispatch.md#endpoint-url-policy) governs. It is the only native, CORS-free outbound HTTP primitive exposed to the UI layer. It re-enforces DI-11's transport policy per request: `https://` to any host, plaintext `http://` only to loopback, never a link-local address. At request time it is deliberately stricter than the shared save-time rule ([DI-10](../../../../api/dispatch.md#endpoint-url-policy)). This document adds no rule of its own there; the policy and its verification live with those clauses.

The same reachability posture bounds what a webview foothold could touch. With `withGlobalTauri: false` and the `script-src 'self'` CSP, the Tauri API (the crate commands above and the granted plugin surface) is never published to a `window` global. It is reached through the bridge module's bundled ESM import. The CSP's `connect-src` independently constrains the webview's own `fetch`. That `connect-src` is narrower than the extension's for remote hosts: `https:` and loopback `http:`, beside the webview's own `'self'` and `ipc:` origins. This is because the shared sync and dispatch traffic leaves through the native command, never through the webview's `fetch`. The bridge module prefers an injected `window.__TAURI__` when one is present (the seam the integration suite's mock uses) before its bundled import.

---

## File Association — Declared, Not Consumed

The bundle configuration declares a file association for the `docent.json`
extension (MIME type `application/json`, description "Docent Recording") in
[`tauri.conf.json`](../../../../../packages/desktop/src-tauri/tauri.conf.json),
for the installer to register with Windows. The application contains no handling for a file passed at launch: `main.rs` calls `run()` directly, nothing reads the process arguments, and no file-open event is handled. The only import path is the `import_file` dialog. So a launch through the association cannot import the file. This is an admitted gap between the installer's declaration and the application's behavior.
