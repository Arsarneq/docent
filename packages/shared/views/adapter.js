/**
 * adapter.js — Platform Adapter Interface
 *
 * Defines the contract that both Chrome and Tauri (desktop) adapters
 * must implement. The shared view logic in render.js calls these
 * methods instead of touching platform APIs directly.
 *
 * Each platform provides its own concrete adapter:
 *   - Chrome extension: adapter-chrome.js (chrome.runtime, chrome.storage)
 *   - Desktop (Tauri):  adapter-tauri.js  (invoke, listen, filesystem)
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
 * @typedef {Object} PlatformAdapter
 *
 * @property {(message: Object) => Promise<Object>} send
 *   Send a message to the backend and return the response.
 *   Chrome: chrome.runtime.sendMessage
 *   Tauri:  invoke()
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
 * @property {() => Promise<string>} loadReadingGuidance
 *   Load the bundled reading-guidance markdown text.
 *   Returns empty string on failure.
 *   Chrome: chrome.runtime.getURL + fetch
 *   Tauri:  read from synced shared/assets/
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
 * @property {((callback: (event: Object) => void) => void)|undefined} [onActionEvent]
 *   Subscribe to captured action events streamed from the backend.
 *   Optional — only used by the desktop adapter (Tauri events).
 *   The Chrome extension does not use this; actions flow through
 *   the content script → storage → service worker path instead.
 *
 * @property {boolean} hasNativeFileDialog
 *   Whether the platform provides native file dialogs for export/import.
 *   Chrome: false (uses browser download / file input)
 *   Tauri:  true  (native open/save dialogs via Tauri commands)
 */

export default undefined; // module exists only for the JSDoc type definition
