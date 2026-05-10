/**
 * adapter-tauri.js — Tauri Desktop Platform Adapter
 *
 * Implements the PlatformAdapter interface (see shared/views/adapter.js)
 * using Tauri v2 APIs: window.__TAURI__.core.invoke for commands,
 * window.__TAURI__.event.listen for events, and filesystem persistence
 * via Tauri commands.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { validateEndpointUrl as _validateEndpointUrl } from '../shared/dispatch-core.js';

// ─── Tauri globals ────────────────────────────────────────────────────────────
// Tauri v2 with `withGlobalTauri: true` exposes APIs on window.__TAURI__

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ─── In-memory pending actions ────────────────────────────────────────────────
// Unlike the Chrome extension (which uses chrome.storage.local for
// pendingActions), the desktop app tracks pending actions in JS memory.
// The Rust backend streams capture:action events; we count them here.

let _pendingActions = [];
let _pendingCountCallbacks = [];

function _notifyPendingCount() {
  const count = _pendingActions.length;
  for (const cb of _pendingCountCallbacks) {
    try { cb(count); } catch { /* ignore */ }
  }
}

// ─── Ordered Insertion ────────────────────────────────────────────────────────
// Events from the worker pool may arrive out of order due to variable
// accessibility query times. Instead of holding events in a buffer until
// gaps are filled (which causes lag), we deliver every event immediately
// and insert it at the correct position in the pending actions list based
// on its sequence_id. This means the UI updates instantly — no waiting
// for slow workers. The final committed step always has correct order.

let _highestSeenSeq = 0;

function _resetReorderState() {
  _highestSeenSeq = 0;
}

function _insertOrdered(action) {
  const seqId = action.sequence_id;

  // Strip sequence_id before adding to pending actions
  const { sequence_id, ...cleanAction } = action;

  if (seqId == null) {
    // No sequence_id — append to end
    _pendingActions.push(cleanAction);
  } else {
    // Track highest seen for completeness guarantee
    if (seqId > _highestSeenSeq) {
      _highestSeenSeq = seqId;
    }

    // Find the correct insertion position by sequence_id.
    // Events mostly arrive in order, so searching from the end is fast.
    // We store the sequence_id temporarily on the action for sorting,
    // then strip it.
    cleanAction._seq = seqId;
    let insertIdx = _pendingActions.length;
    while (insertIdx > 0 && (_pendingActions[insertIdx - 1]._seq || 0) > seqId) {
      insertIdx--;
    }
    _pendingActions.splice(insertIdx, 0, cleanAction);
  }

  _notifyPendingCount();
  for (const cb of _actionEventCallbacks) {
    try { cb(cleanAction); } catch { /* ignore */ }
  }
}

// ─── Completeness Guarantee ───────────────────────────────────────────────────
// On step commit, wait for all events up to the max sequence number
// to arrive before collecting pending actions. Then strip internal _seq
// fields from all pending actions.

async function commitWithCompleteness() {
  const maxSeq = await invoke('get_max_sequence_number');

  if (maxSeq === 0 || _highestSeenSeq >= maxSeq) {
    // All events already received — strip _seq and return
    _stripSeqFields();
    return;
  }

  const deadline = Date.now() + 5000; // 5 second timeout

  await new Promise((resolve) => {
    const check = () => {
      if (_highestSeenSeq >= maxSeq || Date.now() >= deadline) {
        if (Date.now() >= deadline && _highestSeenSeq < maxSeq) {
          console.warn(`[Docent] Completeness timeout: seen seq ${_highestSeenSeq}, max was ${maxSeq}`);
        }
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });

  _stripSeqFields();
}

function _stripSeqFields() {
  for (const action of _pendingActions) {
    delete action._seq;
  }
}

// ─── Action event listeners ───────────────────────────────────────────────────

let _actionEventCallbacks = [];

// Start listening for capture:action events from the Rust backend
listen('capture:action', (event) => {
  const action = event.payload;
  _insertOrdered(action);
});

// ─── Adapter ──────────────────────────────────────────────────────────────────

/** @type {import('../shared/views/adapter.js').PlatformAdapter} */
const tauriAdapter = {

  // ── Message passing ───────────────────────────────────────────────────────

  /**
   * Send a command to the Tauri backend via invoke().
   * The desktop app handles session state in the frontend (unlike the
   * extension which delegates to the service worker), so most messages
   * are handled locally. This method is provided for commands that need
   * the Rust backend (start_capture, stop_capture, list_windows, etc.).
   */
  async send(message) {
    // Map message types to Tauri commands where applicable
    switch (message.type) {
      case 'RECORDING_START':
        _resetReorderState();
        await invoke('start_capture', { pid: message.pid ?? null });
        return { ok: true };
      case 'RECORDING_STOP':
        await invoke('stop_capture');
        return { ok: true };
      default:
        // Other messages are handled locally by panel.js
        return {};
    }
  },

  // ── Dispatch settings ─────────────────────────────────────────────────────

  async loadSettings() {
    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      return {
        endpointUrl: state?.settings?.endpointUrl ?? null,
        apiKey:      state?.settings?.apiKey ?? null,
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

    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      if (!state.settings) state.settings = {};
      state.settings.endpointUrl = endpointUrl || null;
      state.settings.apiKey = apiKey || null;
      await invoke('save_state', { data: JSON.stringify(state) });
    } catch (err) {
      throw new Error(`Failed to save settings: ${err.message || err}`);
    }
  },

  // ── Sync settings ───────────────────────────────────────────────────────────

  async loadSyncSettings() {
    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      return {
        serverUrl: state?.settings?.syncUrl ?? null,
        apiKey:    state?.settings?.syncApiKey ?? null,
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

    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      if (!state.settings) state.settings = {};

      if (serverUrl === '') {
        // Clear both sync URL and API key when serverUrl is empty (R1-AC3)
        delete state.settings.syncUrl;
        delete state.settings.syncApiKey;
      } else {
        state.settings.syncUrl = serverUrl;
        state.settings.syncApiKey = apiKey || null;
      }

      await invoke('save_state', { data: JSON.stringify(state) });
    } catch (err) {
      throw new Error(`Failed to save sync settings: ${err.message || err}`);
    }
  },

  // ── Theme ─────────────────────────────────────────────────────────────────

  async loadTheme() {
    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      return state?.settings?.theme ?? 'auto';
    } catch {
      return 'auto';
    }
  },

  async saveTheme(theme) {
    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      if (!state.settings) state.settings = {};
      state.settings.theme = theme;
      await invoke('save_state', { data: JSON.stringify(state) });
    } catch {
      // Silently fail — theme is non-critical
    }
  },

  // ── Recording mode ────────────────────────────────────────────────────────

  async loadRecordingMode() {
    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      return state?.settings?.recordingMode ?? 'narration';
    } catch {
      return 'narration';
    }
  },

  async saveRecordingMode(mode) {
    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      if (!state.settings) state.settings = {};
      state.settings.recordingMode = mode;
      await invoke('save_state', { data: JSON.stringify(state) });
    } catch {
      // Silently fail — recording mode is non-critical
    }
  },

  // ── Reading guidance ──────────────────────────────────────────────────────

  async loadReadingGuidance() {
    try {
      const response = await fetch('../shared/assets/reading-guidance.md');
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
      const response = await fetch('../shared/session.schema.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      console.warn('[Docent] Failed to load schema:', err);
      return {};
    }
  },

  // ── Pending action count ──────────────────────────────────────────────────

  onPendingCountChange(callback) {
    _pendingCountCallbacks.push(callback);
  },

  async getPendingCount() {
    return _pendingActions.length;
  },

  // ── Action events ─────────────────────────────────────────────────────────

  onActionEvent(callback) {
    _actionEventCallbacks.push(callback);
  },

  // ── Pending actions management ────────────────────────────────────────────
  // Desktop-specific: direct access to the pending actions array

  getPendingActions() {
    return _pendingActions;
  },

  clearPendingActions() {
    _pendingActions = [];
    _notifyPendingCount();
  },

  // ── Platform capabilities ─────────────────────────────────────────────────

  hasNativeFileDialog: true,
};

export default tauriAdapter;

export { commitWithCompleteness };

export function getHighestSeenSeq() {
  return _highestSeenSeq;
}

// Test-only exports for reorder internals
export const _testOnly = {
  get highestSeenSeq() { return _highestSeenSeq; },
  resetReorderState: _resetReorderState,
  insertOrdered: _insertOrdered,
  stripSeqFields: _stripSeqFields,
};
