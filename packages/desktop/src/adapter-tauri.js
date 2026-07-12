/**
 * adapter-tauri.js — Tauri Desktop Platform Adapter
 *
 * Implements the PlatformAdapter interface (see shared/views/adapter.js)
 * using Tauri v2 APIs via the `tauri-bridge.js` seam: `invoke` for
 * commands and `listen` for events (the bridge reaches them through an ESM
 * import of `@tauri-apps/api`, since the app ships with `withGlobalTauri: false`),
 * plus filesystem persistence via Tauri commands.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */
// see docs/technical/session-format.md — the actions this adapter collects and redacts become .docent.json data; the per-platform schemas are authoritative for field semantics.

import { validateEndpointUrl as _validateEndpointUrl } from '../shared/dispatch-core.js';
import { setHttpTransport } from '../shared/lib/http-transport.js';
import { isSensitiveField, SENSITIVE_MASK } from '../shared/lib/field-sensitivity.js';
import { invoke, listen } from './tauri-bridge.js';

// ─── Native HTTP transport ──────────────────────────────────────────────
// The desktop issues sync / dispatch / connection-test requests through the
// native `sync_http_request` command (Rust) instead of the webview's `fetch`,
// which would be CORS-blocked against a non-CORS server (the reference server,
// any correctly-scoped adopter backend). Binding it here — once, at module load,
// before the panel runs any sync — routes the shared HTTP code through Rust on
// this platform while the extension keeps using `globalThis.fetch`
// (host-permission-backed).

/** Normalize the shared callers' header object into a plain `Record<string,string>`. */
function _headersToRecord(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    // A Headers instance (the shared code passes plain objects, but be safe).
    const record = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return { ...headers };
}

/**
 * `fetch`-shaped transport backed by the native `sync_http_request` command.
 * Returns the strict response subset the shared HTTP code uses
 * (`ok`/`status`/`headers.get`/`json`/`text`). The webview `signal` is not
 * plumbed through `invoke`; the native command enforces its own timeout.
 *
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: string|null}} [options]
 * @returns {Promise<object>} a `fetch`-shaped response
 */
async function tauriRequest(url, options = {}) {
  const { method = 'GET', headers = {}, body = null } = options;
  const result = await invoke('sync_http_request', {
    method,
    url,
    headers: _headersToRecord(headers),
    body: body ?? null,
  });
  const headerMap = result?.headers ?? {};
  const status = result?.status ?? 0;
  const bodyText = result?.body ?? '';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headerMap[String(name).toLowerCase()] ?? null },
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
  };
}

setHttpTransport(tauriRequest);

// ─── In-memory pending actions ────────────────────────────────────────────────
// Unlike the Chrome extension (which uses chrome.storage.local for
// pendingActions), the desktop app tracks pending actions in JS memory.
// The Rust backend streams capture:action events; we count them here.

let _pendingActions = [];
const _pendingCountCallbacks = [];

function _notifyPendingCount() {
  const count = _pendingActions.length;
  for (const cb of _pendingCountCallbacks) {
    try {
      cb(count);
    } catch {
      /* ignore */
    }
  }
}

// ─── Ordered Insertion ────────────────────────────────────────────────────────
// Events from the worker pool may arrive out of order due to variable
// accessibility query times. Instead of holding events in a buffer until
// gaps are filled (which causes lag), we deliver every event immediately
// and insert it at the correct position in the pending actions list based
// on its sequence_id. This means the UI updates instantly — no waiting
// for slow workers. The final committed step always has correct order.

// The step-commit flush barrier (docent#298) confirms delivery via a
// `barrier_complete` sentinel the backend emits LAST on the capture:action
// stream. `_barrierResolvers` holds the waiter for an in-flight commit keyed by
// barrier id; a sentinel that arrives before its waiter is registered is parked
// in `_seenBarriers`.
const _barrierResolvers = new Map();
const _seenBarriers = new Set();

function _resetReorderState() {
  _barrierResolvers.clear();
  _seenBarriers.clear();
}

// Sensitive-data redaction at the desktop storage chokepoint. The Rust
// capture layer masks passwords (native UIA `IsPassword` signal); this catches
// the rest with the SHARED field-sensitivity util — a cc/ssn/secret field named
// in the accessibility tree — before the action enters the pending list (and so
// the stored/exported recording). `isSensitiveField` also matches the
// password element_type, so this is also where the desktop `redacted` marker is
// set, keeping the marker single-sourced with the extension. Mutates in place.
//
// `element.locators` passes through UNTOUCHED by design: every desktop locator
// strategy is identity-derived (ids, control types, labels, tree paths — the
// very signals the detection keys on), never the typed value, which lives in
// `action.value`/`element.text` and is masked here. Masking a label would both
// destroy the locator and mask a non-secret — redaction stays conservative.
function _redactSensitive(action) {
  const el = action && action.element;
  if (el && typeof el === 'object' && !el.redacted && isSensitiveField(el)) {
    if (typeof action.value === 'string') action.value = SENSITIVE_MASK;
    el.text = null;
    el.redacted = true;
  }
  return action;
}

function _insertOrdered(action) {
  const seqId = action.sequence_id;

  // Strip sequence_id before adding to pending actions
  const { sequence_id: _seq, ...cleanAction } = action;
  _redactSensitive(cleanAction);

  if (seqId == null) {
    // No sequence_id — append to end
    _pendingActions.push(cleanAction);
  } else {
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
    try {
      cb(cleanAction);
    } catch {
      /* ignore */
    }
  }
}

// ─── Completeness Guarantee ───────────────────────────────────────────────────
// On step commit, run the backend flush barrier (docent#298): the Rust worker
// pool drains every worker's completed-but-held actions into this same
// capture:action stream and then emits a `barrier_complete` sentinel LAST.
// Waiting for that sentinel — not merely for the command to return — guarantees
// every drained action has already been inserted before we collect the step
// (the command-return and event-emit IPC channels have no mutual ordering).
// Then strip the internal _seq fields from all pending actions.

/** Resolve (or park) the delivery sentinel for a completed barrier. */
function _resolveBarrier(barrierId) {
  const resolve = _barrierResolvers.get(barrierId);
  if (resolve) {
    _barrierResolvers.delete(barrierId);
    resolve();
  } else {
    // Arrived before the waiter registered — remember it.
    _seenBarriers.add(barrierId);
  }
}

/**
 * Wait for the `barrier_complete` sentinel for `barrierId` to arrive on the
 * capture:action stream. Bounded so a lost sentinel can never hang a commit.
 */
function _waitForBarrierSentinel(barrierId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (_seenBarriers.delete(barrierId)) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      _barrierResolvers.delete(barrierId);
      resolve();
    };
    _barrierResolvers.set(barrierId, done);
    setTimeout(done, timeoutMs);
  });
}

async function commitWithCompleteness() {
  const report = await invoke('commit_barrier');

  // No active capture (barrier_id 0) or an unsupported platform — nothing was
  // flushed; collect what we have.
  if (!report || !report.barrier_id) {
    _stripSeqFields();
    return;
  }

  if (report.wedged_workers > 0) {
    console.warn(
      `[Docent] Commit barrier: ${report.wedged_workers} worker(s) did not flush in time; their buffered actions were rescued.`,
    );
  }

  await _waitForBarrierSentinel(report.barrier_id);
  _stripSeqFields();
}

function _stripSeqFields() {
  for (const action of _pendingActions) {
    delete action._seq;
  }
}

// ─── Action event listeners ───────────────────────────────────────────────────

const _actionEventCallbacks = [];

// Handle one message from the capture:action stream. The step-commit flush
// barrier (docent#298) rides this same stream: a `barrier_complete` sentinel is
// consumed here to resolve the pending commit and is never inserted or exported.
function _handleCaptureAction(action) {
  if (action && action.type === 'barrier_complete') {
    _resolveBarrier(action.barrier_id);
    return;
  }
  _insertOrdered(action);
}

// Start listening for capture:action events from the Rust backend
listen('capture:action', (event) => {
  _handleCaptureAction(event.payload);
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
        apiKey: state?.settings?.apiKey ?? null,
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

    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      if (!state.settings) state.settings = {};
      state.settings.endpointUrl = endpointUrl || null;
      state.settings.apiKey = apiKey || null;
      await invoke('save_state', { data: JSON.stringify(state) });
    } catch (err) {
      throw new Error(`Failed to save settings: ${err.message || err}`, { cause: err });
    }
  },

  // ── Sync settings ───────────────────────────────────────────────────────────

  async loadSyncSettings() {
    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      return {
        serverUrl: state?.settings?.syncUrl ?? null,
        apiKey: state?.settings?.syncApiKey ?? null,
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

    try {
      const json = await invoke('load_state');
      const state = JSON.parse(json);
      if (!state.settings) state.settings = {};

      if (serverUrl === '') {
        // Clear both sync URL and API key when serverUrl is empty
        delete state.settings.syncUrl;
        delete state.settings.syncApiKey;
      } else {
        state.settings.syncUrl = serverUrl;
        state.settings.syncApiKey = apiKey || null;
      }

      await invoke('save_state', { data: JSON.stringify(state) });
    } catch (err) {
      throw new Error(`Failed to save sync settings: ${err.message || err}`, { cause: err });
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

  // ── Import validator ────────────────────────────────────────────────────────

  async loadValidator() {
    try {
      const mod = await import('../shared/generated/validate-desktop-windows.js');
      return mod.default;
    } catch (err) {
      console.warn('[Docent] Failed to load import validator:', err);
      return null;
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

// Test-only exports for reorder internals, the redaction chokepoint, and the
// commit-barrier sentinel path (docent#298).
export const _testOnly = {
  resetReorderState: _resetReorderState,
  insertOrdered: _insertOrdered,
  handleCaptureAction: _handleCaptureAction,
  stripSeqFields: _stripSeqFields,
  redactSensitive: _redactSensitive,
};
