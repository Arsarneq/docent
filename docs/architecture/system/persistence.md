# Persistence — Where Each Platform Keeps Its Data

The storage architecture on both platforms: what is persisted, where it lives, and which state is deliberately ephemeral. Its companion is [Shared Core](shared-core.md). The logic operating on this data is shared, while the storage substrate is per-platform. How each platform's model mutations and settings reach that substrate is stated at [Shared Core — the adapter seam](shared-core.md#the-adapter-seam).

The per-key and user-facing detail stays with the platform documents, and this document links both rather than duplicating their tables. The extension's complete key inventory and write-ownership contract is [runtime §ERT-3](../application/extension/runtime.md#storage-keys-and-write-ownership). The user-facing summary of the desktop's data locations is the [desktop guide's Your data section](../../user/desktop-windows.md#your-data).

---

## Extension — `chrome.storage`

The extension's service worker is suspended when idle, so every fact the user's work depends on across a suspension is persisted. [runtime §ERT-1](../application/extension/runtime.md#lifecycle-and-the-persisted-state-model) governs what may live in worker memory instead.

- **`chrome.storage.local`** holds:
  - the project/recording model and the active ids;
  - the pending capture buffer;
  - the capture-state keys: the recording flag and the last tab navigation, which the worker writes, and the last user-action timestamp, which the content recorder writes;
  - the dispatch and sync settings;
  - the theme and recording-mode preferences;
  - the published storage-pressure state;
  - the durable sync reconcile state.

  The complete key inventory (each key's contents, its writers, and the keys that double as change signals) is [runtime §ERT-3](../application/extension/runtime.md#storage-keys-and-write-ownership). Because the pending buffer is persisted, capture in progress survives a worker suspension. Across a browser restart the buffer is kept until a recording is opened or created, which discards it ([user guide — pending actions](../../user/extension.md#pending-actions)).

- **`chrome.storage.session`** holds the ephemeral AES key for the encrypted API-key values stored in `chrome.storage.local`. The browser keeps it in memory and clears it on browser restart. After that, a stored key no longer decrypts and reads back as "not configured", so the user re-enters it. When Auto-sync is on against a server that requires the key, the first background cycle after the restart is sent without it. That cycle fails authentication, turns Auto-sync off and records the failed test, so the user also re-tests the connection once the key is re-entered. The [security policy](../../../.github/SECURITY.md#protecting-stored-credentials) has the at-rest encryption design.

### Storage pressure

`chrome.storage.local` gives the extension a 10 MiB quota, and capture pauses under pressure rather than failing mid-write. [ECP-11](../application/extension/capture-principles.md#storage-pressure) is the doctrine. The bands and thresholds live with the pure classifier in [`packages/extension/lib/storage-quota.js`](../../../packages/extension/lib/storage-quota.js). The service worker (which writes the published state) and the panel adapter (which renders the banner from it) share it:

| Usage                               | Band       | What happens                                                                                                                                                                                                                  |
| ----------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| below 8 MiB                         | `ok`       | Normal capture.                                                                                                                                                                                                               |
| at/above 8 MiB (80% of quota)       | `warn`     | Capture auto-pauses and the panel warns, with an explicit keep-recording override; the band stays `warn` until usage drops below 7.5 MiB (75% — hysteresis, so the state cannot flap at the boundary), where capture resumes. |
| a write throws `QuotaExceededError` | `exceeded` | Capture always pauses — nothing writes past a physically full quota.                                                                                                                                                          |

The pressure machinery only gates new captures; ECP-11 owns that guarantee. Stored projects and the already-captured buffer are left untouched. Space is freed by the user's own actions (clearing pending actions, deleting recordings or projects).

---

## Desktop — the session file and the credential store

- **`%APPDATA%/com.docent.desktop/session.json`** is the single persisted blob: the projects and recordings, the settings, and the sync reconcile state (`syncState` rides the same blob). The active project/recording selection lives in the panel's memory only and is not persisted. The frontend writes the blob through the `save_state` command on every model mutation, and reads it through `load_state` at startup. A missing file starts the app with an empty state. A file that cannot be read or parsed is never written over: it is moved aside and the user is told where it was kept, or, when it cannot be moved, it stays in place and nothing is saved for the rest of the run ([application-shell §DSH-3](../application/desktop/windows/application-shell.md#session-persistence)). Every save goes to a temporary file first and then replaces the session file, so a save cut short leaves the previous file whole ([`panel.js`](../../../packages/desktop/src/panel.js), [`persistence.js`](../../../packages/desktop/src/persistence.js), [`commands.rs`](../../../packages/desktop/src-tauri/src/commands.rs)).
- **Windows Credential Manager** holds the two API keys: the dispatch `apiKey` and the sync `syncApiKey`. The `save_state`/`load_state` commands are the persistence chokepoint. On save, the keys are stripped out of the JSON and written to the credential store. On load they are re-injected, so the session file on disk never carries them. Clearing a key in Settings also deletes its credential entry ([`secret_store.rs`](../../../packages/desktop/src-tauri/src/secret_store.rs)). The operative rule, with its clear-vs-omit semantics, is [application-shell §DSH-2](../application/desktop/windows/application-shell.md#session-persistence). The user-facing statement is the [desktop guide's Your data section](../../user/desktop-windows.md#your-data).

---

## Deliberately ephemeral state

State each platform holds only in memory, by design, with the consequence of losing it:

- **Extension — the worker's in-memory state.** Limited to the classes [runtime §ERT-1](../application/extension/runtime.md#lifecycle-and-the-persisted-state-model) enumerates and governs, each safe to lose with a suspension.
- **Extension — the settings-encryption key** (`chrome.storage.session`, above). It is browser-restart-scoped by design. Losing it costs a key re-entry, never data (the `chrome.storage.session` bullet above states the Auto-sync consequence).
- **Desktop — the pending capture buffer.** Uncommitted captured actions live in the frontend adapter's memory, fed by the backend's `capture:action` events ([Shared Core — the adapter seam](shared-core.md#the-adapter-seam)). Committing a step moves them into the model, which persists through the session file. This is a deliberate platform difference. The extension's pending buffer must survive worker suspension, so it is persisted. The desktop frontend is a continuously running window, so its buffer lives in memory, and quitting the application discards uncommitted actions (committed steps are already in the session file). Across a restart the two platforms reach the same outcome for the user: the desktop's buffer is gone with the quit, and the extension's is discarded when a recording is opened or created. So the persisted buffer serves the extension's worker suspension, which a continuously running window has no counterpart of.
- **Desktop — the capture flag, the target application and the barrier state.** Whether capture is running, which process is hooked and the flush barrier's progress live in the window and the capture backend. Capture ends with the process, so a restart has nothing to keep. The desktop also has no storage-pressure gate: its session file is bounded by the disk, not by a quota ([storage pressure](#storage-pressure) is the extension's).
