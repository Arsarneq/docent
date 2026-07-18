/**
 * persistence.js — Filesystem Session Persistence (Desktop)
 *
 * Manages loading and saving session state to the filesystem via
 * Tauri commands. The Rust backend handles the actual file I/O at
 * %APPDATA%/com.docent.desktop/session.json.
 *
 * This module provides:
 *   - loadSessionState()  — read persisted state on startup
 *   - saveSessionState()  — write state on every mutation
 *   - serializeState()    — convert state to JSON string (pure, testable)
 *   - deserializeState()  — parse JSON string to state (pure, testable)
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// ─── Default empty state ──────────────────────────────────────────────────────

/**
 * Returns a fresh empty session state.
 * @returns {SessionState}
 */
export function emptyState() {
  return {
    projects: [],
    settings: {
      endpointUrl: null,
      apiKey: null,
      theme: 'auto',
      selfCaptureExclusion: true,
      syncUrl: null,
      syncApiKey: null,
      recordingMode: 'narration',
    },
  };
}

// ─── Pure serialization / deserialization ──────────────────────────────────────

/**
 * Serialize session state to a JSON string.
 * This is a pure function suitable for property-based testing.
 *
 * @param {SessionState} state
 * @returns {string}
 */
export function serializeState(state) {
  return JSON.stringify(state);
}

/**
 * Deserialize a JSON string back to session state.
 * Returns the parsed state, or null if the JSON is invalid.
 * This is a pure function suitable for property-based testing.
 *
 * @param {string} json
 * @returns {SessionState|null}
 */
export function deserializeState(json) {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Tauri-backed persistence ─────────────────────────────────────────────────

/**
 * Load session state from the filesystem via Tauri invoke("load_state").
 * Reads from %APPDATA%/com.docent.desktop/session.json.
 *
 * - If the file is missing, returns empty state.
 * - If the file is corrupted (invalid JSON), returns empty state and logs a warning.
 *
 * @param {Function} invoke — Tauri invoke function (injected for testability)
 * @returns {Promise<SessionState>}
 */
export async function loadSessionState(invoke) {
  try {
    const json = await invoke('load_state');
    const parsed = deserializeState(json);
    if (parsed === null) {
      console.warn('[Docent] Corrupted session file — starting with empty state');
      return emptyState();
    }
    // Ensure required structure exists, preserving the full shipped shape.
    return {
      projects: parsed.projects ?? [],
      // Durable conflict-handling state (baselines/snapshots/reviews/conflicts)
      // for graded sync. Preserved verbatim; the shared loadSyncState normalizes
      // it (or undefined) into a complete SyncState shape when sync reads it.
      syncState: parsed.syncState ?? undefined,
      settings: {
        endpointUrl: parsed.settings?.endpointUrl ?? null,
        apiKey: parsed.settings?.apiKey ?? null,
        theme: parsed.settings?.theme ?? 'auto',
        selfCaptureExclusion: parsed.settings?.selfCaptureExclusion ?? true,
        syncUrl: parsed.settings?.syncUrl ?? null,
        syncApiKey: parsed.settings?.syncApiKey ?? null,
        recordingMode: parsed.settings?.recordingMode ?? 'narration',
      },
    };
  } catch {
    // File missing or invoke failed — start with empty state
    return emptyState();
  }
}

/**
 * Save session state to the filesystem via Tauri invoke("save_state").
 * Writes to %APPDATA%/com.docent.desktop/session.json.
 *
 * @param {Function} invoke — Tauri invoke function (injected for testability)
 * @param {SessionState} state
 * @returns {Promise<void>}
 */
export async function saveSessionState(invoke, state) {
  const json = serializeState(state);
  await invoke('save_state', { data: json });
}

/**
 * @typedef {Object} SessionState
 * @property {Array} projects
 * @property {Object} [syncState] durable graded-sync conflict state (baselines, snapshots, reviews, conflicts)
 * @property {Object} settings
 * @property {string|null} settings.endpointUrl
 * @property {string|null} settings.apiKey
 * @property {string} settings.theme
 * @property {boolean} settings.selfCaptureExclusion
 * @property {string|null} settings.syncUrl
 * @property {string|null} settings.syncApiKey
 * @property {string} settings.recordingMode
 */
