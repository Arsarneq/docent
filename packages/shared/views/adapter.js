/**
 * adapter.js — Platform Adapter Interface
 *
 * Defines the contract that both Chrome and Tauri (desktop) adapters
 * must implement. Each platform's panel driver imports its concrete
 * adapter and reaches platform facilities through these methods
 * (extension: sidepanel/panel.js; desktop: src/panel.js), and the
 * extension's background service worker reuses the Chrome adapter for
 * a subset of them (which members, and why loadValidator is excluded,
 * is noted in the worker's own file, background/service-worker.js).
 * The shared rendering functions in render.js are pure HTML-string
 * functions — they never call the adapter.
 *
 * Each platform provides its own concrete adapter:
 *   - Chrome extension: adapter-chrome.js (chrome.runtime, chrome.storage)
 *   - Desktop (Tauri):  adapter-tauri.js  (invoke, listen, filesystem)
 *
 * Beyond this shared contract, each concrete adapter carries
 * platform-specific members its own platform's callers need. Those
 * members are documented in the concrete adapter files and are not part
 * of this typedef.
 *
 * Desktop caller model: the desktop panel hydrates its in-memory session
 * state from a persisted blob when it loads, and persists settings back
 * through its own session save. The desktop implementations of the
 * settings-persistence save members are load-mutate-save round-trips
 * over that same blob (their load counterparts read it and return), so a
 * desktop call to a save member interleaves with the panel's own saves.
 * The panel's sync-settings save takes that route today and mirrors the
 * result back into its in-memory state afterwards.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * @typedef {Object} DispatchSettings
 * @property {string|null} endpointUrl
 * @property {string|null} apiKey
 */

/**
 * @typedef {Object} SyncSettings
 * @property {string|null} serverUrl
 * @property {string|null} apiKey
 */

/**
 * @typedef {Object} PlatformAdapter
 *
 * @property {(message: Object) => Promise<Object>} send
 *   Send a message to the backend and return the response.
 *   Chrome: chrome.runtime.sendMessage
 *   Tauri:  invoke() for the message types it maps onto backend commands;
 *           the rest return an empty response, the desktop panel having
 *           handled them itself
 *
 * @property {() => Promise<DispatchSettings>} loadSettings
 *   Load persisted dispatch settings (endpoint URL and API key).
 *   Chrome: chrome.storage.local
 *   Tauri:  filesystem via invoke
 *
 * @property {(endpointUrl: string, apiKey: string) => Promise<void>} saveSettings
 *   Persist dispatch settings. Throws if endpointUrl is non-empty and invalid.
 *   Chrome: chrome.storage.local
 *   Tauri:  filesystem via invoke
 *
 * @property {() => Promise<string>} loadTheme
 *   Load the persisted theme preference ("auto", "light", or "dark").
 *   Returns "auto" when no preference is stored.
 *   Chrome: chrome.storage.local
 *   Tauri:  filesystem via invoke
 *
 * @property {(theme: string) => Promise<void>} saveTheme
 *   Persist the theme preference.
 *   Chrome: chrome.storage.local
 *   Tauri:  filesystem via invoke
 *
 * @property {() => Promise<string>} loadRecordingMode
 *   Load the persisted default step-context mode ("narration" or "simple").
 *   Returns "narration" when no preference is stored.
 *   Chrome: chrome.storage.local
 *   Tauri:  filesystem via invoke
 *   Caller note: the extension panel loads the mode through this method;
 *   the desktop panel reads settings.recordingMode from its in-memory
 *   session state (both back onto the same stored key). The split is the
 *   arrangement this seam settles on — the desktop caller model in this
 *   file's header states how the desktop side reaches that stored blob.
 *
 * @property {(mode: string) => Promise<void>} saveRecordingMode
 *   Persist the default step-context mode.
 *   Chrome: chrome.storage.local
 *   Tauri:  filesystem via invoke
 *   Caller note: the extension panel saves the mode through this method;
 *   the desktop panel writes settings.recordingMode through its own
 *   session save (both back onto the same stored key). The split is the
 *   arrangement this seam settles on — the desktop caller model in this
 *   file's header describes the round-trip these members perform there.
 *
 * @property {() => Promise<string>} loadReadingGuidance
 *   Load the bundled reading-guidance prose text (no schema embedded).
 *   Returns empty string on failure.
 *   Chrome: chrome.runtime.getURL + fetch
 *   Tauri:  read from synced shared/assets/
 *
 * @property {() => Promise<object>} loadSchema
 *   Load the platform-specific JSON Schema object.
 *   Returns empty object on failure.
 *   Chrome: chrome.runtime.getURL + fetch (extension schema)
 *   Tauri:  read the composed session.schema.json from the root of the
 *           synced shared/ tree (desktop-windows schema)
 *
 * @property {() => Promise<Function|null>} loadValidator
 *   Load the platform's generated import validator via dynamic import()
 *   from the synced shared/generated/ tree. Returns null on failure.
 *   Chrome: chrome.runtime.getURL + import() (validate-extension.js)
 *   Tauri:  import() relative to the adapter module (validate-desktop-windows.js)
 *
 * @property {(callback: (count: number) => void) => void} onPendingCountChange
 *   Subscribe to changes in the pending action count.
 *   The callback fires whenever the count changes.
 *   Chrome: chrome.storage.onChanged listener for pendingCount
 *   Tauri:  in-memory tracking driven by capture:action events
 *
 * @property {() => Promise<number>} getPendingCount
 *   Read the current pending action count.
 *   Chrome: chrome.storage.local.get('pendingCount')
 *   Tauri:  in-memory counter
 *
 * @property {((callback: (event: Object) => void) => void)} onActionEvent
 *   Subscribe to captured action events as they arrive.
 *   The callback fires with each individual action object.
 *   Chrome: chrome.storage.onChanged listener for pendingActions array
 *   Tauri:  in-memory tracking driven by capture:action events
 *
 * @property {() => Promise<SyncSettings>} loadSyncSettings
 *   Load persisted sync settings (server URL and API key).
 *   Sync settings are stored separately from dispatch settings —
 *   they configure the remote sync server, not the dispatch endpoint.
 *   Returns { serverUrl: null, apiKey: null } when no configuration exists.
 *   Chrome: chrome.storage.local (docentSyncUrl / docentSyncApiKey)
 *   Tauri:  filesystem via invoke (settings.syncUrl / settings.syncApiKey)
 *
 * @property {(serverUrl: string, apiKey: string) => Promise<void>} saveSyncSettings
 *   Persist sync settings. These are independent of dispatch settings.
 *   Throws if serverUrl is non-empty and the shared endpoint-URL
 *   validation refuses it.
 *   An empty serverUrl clears both the sync URL and API key from storage.
 *   Chrome: chrome.storage.local
 *   Tauri:  filesystem via invoke
 *
 * @property {boolean} hasNativeFileDialog
 *   Whether the platform provides native file dialogs for export/import.
 *   Chrome: false (uses browser download / file input)
 *   Tauri:  true  (native open/save dialogs via Tauri commands)
 */

export default undefined; // module exists only for the JSDoc type definition
