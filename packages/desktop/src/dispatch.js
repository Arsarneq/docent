/**
 * dispatch.js — Dispatch Service Module (Desktop)
 *
 * Re-exports platform-agnostic dispatch logic from shared.
 * Provides desktop-specific settings persistence (via Tauri invoke)
 * and reading guidance loading (from synced shared/assets/).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// ─── Re-exports from shared dispatch-core ─────────────────────────────────────

export {
  buildPayload,
  sendPayload,
  DispatchError,
  validateEndpointUrl,
} from '../shared/dispatch-core.js';

// ─── Tauri globals ────────────────────────────────────────────────────────────

const { invoke } = window.__TAURI__.core;

// ─── Settings persistence via filesystem (Tauri invoke) ───────────────────────

/**
 * Load dispatch settings (endpoint URL and API key) from the persisted
 * session state on the filesystem via Tauri's load_state command.
 *
 * @returns {Promise<{ endpointUrl: string|null, apiKey: string|null }>}
 */
export async function loadDispatchSettings() {
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
}

/**
 * Save dispatch settings (endpoint URL and API key) to the persisted
 * session state on the filesystem via Tauri's save_state command.
 *
 * Performs a read-modify-write cycle to preserve other state fields.
 *
 * @param {string} endpointUrl
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
export async function saveDispatchSettings(endpointUrl, apiKey) {
  try {
    let state = {};
    try {
      const json = await invoke('load_state');
      state = JSON.parse(json);
    } catch {
      // Missing or corrupted — start with empty state
      state = { projects: [], settings: {} };
    }

    if (!state.settings) state.settings = {};
    state.settings.endpointUrl = endpointUrl || null;
    state.settings.apiKey      = apiKey || null;

    await invoke('save_state', { data: JSON.stringify(state) });
  } catch (err) {
    throw new Error(`Failed to save dispatch settings: ${err.message || err}`);
  }
}

// ─── Reading guidance ─────────────────────────────────────────────────────────

/**
 * Load the reading guidance markdown from the synced shared/assets/ directory.
 * Returns empty string on failure.
 *
 * @returns {Promise<string>}
 */
export async function loadReadingGuidance() {
  try {
    const response = await fetch('../shared/assets/reading-guidance.md');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    console.warn('[Docent] Failed to load reading guidance:', err);
    return '';
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * Load the platform-specific JSON Schema from the synced shared/ directory.
 * Returns empty object on failure.
 *
 * @returns {Promise<object>}
 */
export async function loadSchema() {
  try {
    const response = await fetch('../shared/session.schema.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn('[Docent] Failed to load schema:', err);
    return {};
  }
}
