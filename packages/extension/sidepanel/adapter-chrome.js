/**
 * adapter-chrome.js — Chrome Extension Platform Adapter
 *
 * Implements the PlatformAdapter interface (see shared/views/adapter.js)
 * using Chrome extension APIs: chrome.runtime.sendMessage,
 * chrome.storage.local, and chrome.storage.onChanged.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { validateEndpointUrl as _validateEndpointUrl } from '../shared/dispatch-core.js';
import { encryptSecret, decryptSecret } from './secret-crypto.js';
import { STORAGE_QUOTA_KEY } from '../lib/storage-quota.js';

// ─── Settings keys ────────────────────────────────────────────────────────────

const ENDPOINT_KEY = 'docentEndpointUrl';
const API_KEY_KEY = 'docentApiKey';
const THEME_KEY = 'docentTheme';
const RECORDING_MODE_KEY = 'docentRecordingMode';

// Sync settings are stored separately from dispatch settings
const SYNC_URL_KEY = 'docentSyncUrl';
const SYNC_API_KEY_KEY = 'docentSyncApiKey';

// Durable conflict-handling state (baselines, snapshots, reviews, conflicts).
// Persisted as one blob so it survives SW suspension and browser restarts.
// The shared sync-store module owns its shape; the adapter only
// reads/writes the raw value through chrome.storage.local.
const SYNC_STATE_KEY = 'docentSyncState';

// ─── Secret helpers ───────────────────────────────────────────────────────────

/**
 * Decode a stored API-key value for reading. Encrypted values are stored
 * as `{ v, iv, ct }` envelopes and decrypted here; a decrypt failure (e.g. the
 * ephemeral key was cleared by a browser restart) yields null, which callers
 * treat as "no key configured" so the user re-enters it. A bare string is
 * accepted as-is so a value that predates encryption still reads back.
 *
 * @param {unknown} stored
 * @returns {Promise<string|null>}
 */
async function _readSecret(stored) {
  if (stored == null) return null;
  if (typeof stored === 'string') return stored; // pre-encryption / legacy value
  return decryptSecret(stored);
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/** @type {import('../shared/views/adapter.js').PlatformAdapter} */
const chromeAdapter = {
  // ── Message passing ───────────────────────────────────────────────────────

  send(message) {
    return chrome.runtime.sendMessage(message);
  },

  // ── Dispatch settings ─────────────────────────────────────────────────────

  async loadSettings() {
    try {
      const result = await chrome.storage.local.get([ENDPOINT_KEY, API_KEY_KEY]);
      return {
        endpointUrl: result[ENDPOINT_KEY] ?? null,
        apiKey: await _readSecret(result[API_KEY_KEY]),
      };
    } catch {
      return { endpointUrl: null, apiKey: null };
    }
  },

  async saveSettings(endpointUrl, apiKey) {
    const urlError = _validateEndpointUrl(endpointUrl, { hasApiKey: !!apiKey });
    if (endpointUrl !== '' && urlError !== null) {
      throw new Error(urlError);
    }

    if (endpointUrl === '') {
      await chrome.storage.local.remove(ENDPOINT_KEY);
    } else {
      await chrome.storage.local.set({ [ENDPOINT_KEY]: endpointUrl });
    }

    if (apiKey === '') {
      await chrome.storage.local.remove(API_KEY_KEY);
    } else {
      await chrome.storage.local.set({ [API_KEY_KEY]: await encryptSecret(apiKey) });
    }
  },

  // ── Sync settings ───────────────────────────────────────────────────────────

  async loadSyncSettings() {
    try {
      const result = await chrome.storage.local.get([SYNC_URL_KEY, SYNC_API_KEY_KEY]);
      return {
        serverUrl: result[SYNC_URL_KEY] ?? null,
        apiKey: await _readSecret(result[SYNC_API_KEY_KEY]),
      };
    } catch {
      return { serverUrl: null, apiKey: null };
    }
  },

  async saveSyncSettings(serverUrl, apiKey) {
    const urlError = _validateEndpointUrl(serverUrl, { hasApiKey: !!apiKey });
    if (serverUrl !== '' && urlError !== null) {
      throw new Error(urlError);
    }

    if (serverUrl === '') {
      // Clear both sync URL and API key when serverUrl is empty
      await chrome.storage.local.remove([SYNC_URL_KEY, SYNC_API_KEY_KEY]);
    } else {
      await chrome.storage.local.set({ [SYNC_URL_KEY]: serverUrl });
      if (apiKey === '') {
        await chrome.storage.local.remove(SYNC_API_KEY_KEY);
      } else {
        await chrome.storage.local.set({ [SYNC_API_KEY_KEY]: await encryptSecret(apiKey) });
      }
    }
  },

  // ── Sync conflict-handling state (SyncStore adapter) ──────────────────────────

  /**
   * Load the persisted durable conflict-handling state blob. Returns the
   * raw stored value (or null when nothing is persisted yet); the shared
   * sync-store `loadSyncState` normalizes it into the full SyncState shape, so
   * the adapter never has to know the shape. A storage failure yields null so the
   * shared layer falls back to a fresh empty state rather than throwing.
   *
   * @returns {Promise<unknown>}
   */
  async loadSyncState() {
    try {
      const result = await chrome.storage.local.get(SYNC_STATE_KEY);
      return result[SYNC_STATE_KEY] ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Persist the durable conflict-handling state blob. The shared
   * sync-store `saveSyncState` passes the already-normalized SyncState here; the
   * adapter writes it verbatim under a single key.
   *
   * @param {object} state - the SyncState blob to persist
   * @returns {Promise<void>}
   */
  async saveSyncState(state) {
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: state });
  },

  /**
   * Subscribe to changes to the durable SyncState blob written by ANY context.
   * The background service worker hosts the Auto-Sync cycle and owns
   * the `chrome.alarms` trigger; when a background cycle records new
   * Review/Conflict items or auto-disables Auto-Sync after a 401/403,
   * it rewrites this blob. The panel watches it so its attention indicators and
   * its Settings state (the Auto-Sync toggle, the Connection_Test status, and
   * the manual Sync button's visibility) stay in agreement with what the SW just
   * did — even though the panel never owns the trigger itself. The callback
   * receives the new raw blob (or null when cleared); the shared `loadSyncState`
   * normalizes it.
   *
   * @param {(state: unknown) => void} callback
   * @returns {void}
   */
  onSyncStateChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SYNC_STATE_KEY]) {
        callback(changes[SYNC_STATE_KEY].newValue ?? null);
      }
    });
  },

  /**
   * Read a synchronous-friendly snapshot of the live-work signals the shared
   * `LiveState` adapter needs: the capture flag, the open recording
   * id, and the pending-action count. The service worker is the source of truth
   * for all three (it writes `recording`, `activeRecordingId`, and `pendingCount`
   * to chrome.storage.local), so reading them here keeps the live-work gate
   * correct even when the panel is not on the recording view. The panel snapshots
   * this once before each sync cycle and builds the synchronous `LiveState`
   * accessors over it. A storage failure yields a safe, fully-idle snapshot.
   *
   * @returns {Promise<{recording: boolean, activeRecordingId: string|null, pendingCount: number}>}
   */
  async loadLiveState() {
    try {
      const result = await chrome.storage.local.get([
        'recording',
        'activeRecordingId',
        'pendingCount',
      ]);
      return {
        recording: result.recording === true,
        activeRecordingId: result.activeRecordingId ?? null,
        pendingCount: result.pendingCount ?? 0,
      };
    } catch {
      return { recording: false, activeRecordingId: null, pendingCount: 0 };
    }
  },

  // ── Theme ─────────────────────────────────────────────────────────────────

  async loadTheme() {
    try {
      const result = await chrome.storage.local.get(THEME_KEY);
      return result[THEME_KEY] ?? 'auto';
    } catch {
      return 'auto';
    }
  },

  async saveTheme(theme) {
    await chrome.storage.local.set({ [THEME_KEY]: theme });
  },

  // ── Recording mode ────────────────────────────────────────────────────────

  async loadRecordingMode() {
    try {
      const result = await chrome.storage.local.get(RECORDING_MODE_KEY);
      return result[RECORDING_MODE_KEY] ?? 'narration';
    } catch {
      return 'narration';
    }
  },

  async saveRecordingMode(mode) {
    await chrome.storage.local.set({ [RECORDING_MODE_KEY]: mode });
  },

  // ── Reading guidance ──────────────────────────────────────────────────────

  async loadReadingGuidance() {
    try {
      const url = chrome.runtime.getURL('shared/assets/reading-guidance.md');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (err) {
      console.warn('[Docent] Failed to load reading guidance:', err);
      return '';
    }
  },

  // ── Schema ────────────────────────────────────────────────────────────────

  async loadSchema() {
    try {
      const url = chrome.runtime.getURL('shared/session.schema.json');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      console.warn('[Docent] Failed to load schema:', err);
      return {};
    }
  },

  // ── Import validator ────────────────────────────────────────────────────────

  async loadValidator() {
    try {
      const url = chrome.runtime.getURL('shared/generated/validate-extension.js');
      const mod = await import(url);
      return mod.default;
    } catch (err) {
      console.warn('[Docent] Failed to load import validator:', err);
      return null;
    }
  },

  // ── Pending action count ──────────────────────────────────────────────────

  onPendingCountChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.pendingCount) {
        callback(changes.pendingCount.newValue ?? 0);
      }
    });
  },

  /**
   * Subscribe to individual action events as they are captured.
   * Fires the callback with each new action added to pendingActions.
   */
  onActionEvent(callback) {
    let _lastLength = 0;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.pendingActions) {
        const newActions = changes.pendingActions.newValue ?? [];
        // Fire callback for each action added since last update
        for (let i = _lastLength; i < newActions.length; i++) {
          try {
            callback(newActions[i]);
          } catch {
            /* ignore */
          }
        }
        _lastLength = newActions.length;
        // Reset when cleared
        if (newActions.length === 0) _lastLength = 0;
      }
    });
  },

  async getPendingCount() {
    try {
      const { pendingCount } = await chrome.storage.local.get('pendingCount');
      return pendingCount ?? 0;
    } catch {
      return 0;
    }
  },

  // ── Storage quota pressure (#127) ─────────────────────────────────────────

  /**
   * Subscribe to storage-quota pressure changes the service worker publishes
   * (band: 'ok' | 'warn' | 'exceeded', plus whether capture is paused). The panel
   * surfaces a non-blocking banner from this. The callback receives the new state,
   * or null when the key is cleared.
   *
   * @param {(state: {band: string, paused: boolean, bytesInUse: number} | null) => void} callback
   */
  onStorageQuotaChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_QUOTA_KEY]) {
        callback(changes[STORAGE_QUOTA_KEY].newValue ?? null);
      }
    });
  },

  /** Read the current storage-quota pressure state (for the initial panel render). */
  async loadStorageQuota() {
    try {
      const { [STORAGE_QUOTA_KEY]: state } = await chrome.storage.local.get(STORAGE_QUOTA_KEY);
      return state ?? null;
    } catch {
      return null;
    }
  },

  // ── Platform capabilities ─────────────────────────────────────────────────

  hasNativeFileDialog: false,
};

export default chromeAdapter;
