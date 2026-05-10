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

// ─── Settings keys ────────────────────────────────────────────────────────────

const ENDPOINT_KEY = 'docentEndpointUrl';
const API_KEY_KEY  = 'docentApiKey';
const THEME_KEY    = 'docentTheme';
const RECORDING_MODE_KEY = 'docentRecordingMode';

// Sync settings are stored separately from dispatch settings (R1-AC1)
const SYNC_URL_KEY     = 'docentSyncUrl';
const SYNC_API_KEY_KEY = 'docentSyncApiKey';

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
        apiKey:      result[API_KEY_KEY] ?? null,
      };
    } catch {
      return { endpointUrl: null, apiKey: null };
    }
  },

  async saveSettings(endpointUrl, apiKey) {
    const urlError = _validateEndpointUrl(endpointUrl);
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
      await chrome.storage.local.set({ [API_KEY_KEY]: apiKey });
    }
  },

  // ── Sync settings ───────────────────────────────────────────────────────────

  async loadSyncSettings() {
    try {
      const result = await chrome.storage.local.get([SYNC_URL_KEY, SYNC_API_KEY_KEY]);
      return {
        serverUrl: result[SYNC_URL_KEY] ?? null,
        apiKey:    result[SYNC_API_KEY_KEY] ?? null,
      };
    } catch {
      return { serverUrl: null, apiKey: null };
    }
  },

  async saveSyncSettings(serverUrl, apiKey) {
    const urlError = _validateEndpointUrl(serverUrl);
    if (serverUrl !== '' && urlError !== null) {
      throw new Error(urlError);
    }

    if (serverUrl === '') {
      // Clear both sync URL and API key when serverUrl is empty (R1-AC3)
      await chrome.storage.local.remove([SYNC_URL_KEY, SYNC_API_KEY_KEY]);
    } else {
      await chrome.storage.local.set({ [SYNC_URL_KEY]: serverUrl });
      if (apiKey === '') {
        await chrome.storage.local.remove(SYNC_API_KEY_KEY);
      } else {
        await chrome.storage.local.set({ [SYNC_API_KEY_KEY]: apiKey });
      }
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
          try { callback(newActions[i]); } catch { /* ignore */ }
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

  // ── Platform capabilities ─────────────────────────────────────────────────

  hasNativeFileDialog: false,
};

export default chromeAdapter;
