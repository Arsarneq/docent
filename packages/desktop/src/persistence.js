/**
 * persistence.js — Filesystem Session Persistence (Desktop)
 *
 * Manages loading and saving session state to the filesystem via
 * Tauri commands. The Rust backend handles the actual file I/O at
 * %APPDATA%/com.docent.desktop/session.json.
 *
 * This module provides:
 *   - loadSessionState()  — read persisted state on startup, with what went
 *                           wrong when the file could not be used
 *   - loadProblemMessage() — the words the panel tells the user then
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Tauri-backed persistence ─────────────────────────────────────────────────

/**
 * What went wrong when the session file could not be used at startup.
 *
 * @typedef {Object} LoadProblem
 * @property {'set_aside'|'kept_in_place'|'unknown'} kind
 *   `set_aside`: the backend moved the file to `keptAs` and saving goes on to
 *   a new file. `kept_in_place`: the file stays at `path`, and the backend
 *   refuses every save for the rest of the run. `unknown`: anything else; the
 *   panel stops saving too, since nothing says the file is out of the way.
 * @property {string|null} path    where the session file is
 * @property {string|null} keptAs  where the file was moved (set_aside only)
 * @property {boolean} savingStopped  whether the panel must not save this run
 */

/**
 * Read the backend's rejection of `load_state` (commands.rs `LoadError`,
 * sent as `{ kind, path, kept_as, reason }`) as a LoadProblem.
 *
 * @param {unknown} err
 * @returns {LoadProblem}
 */
function loadProblemFrom(err) {
  const kind = typeof err === 'object' && err !== null ? err.kind : undefined;
  if (kind === 'set_aside' && typeof err.kept_as === 'string') {
    return { kind, path: err.path ?? null, keptAs: err.kept_as, savingStopped: false };
  }
  if (kind === 'kept_in_place') {
    return { kind, path: err.path ?? null, keptAs: null, savingStopped: true };
  }
  return { kind: 'unknown', path: null, keptAs: null, savingStopped: true };
}

/**
 * Load session state from the filesystem via Tauri invoke("load_state").
 * Reads from %APPDATA%/com.docent.desktop/session.json.
 *
 * - A missing file reads as `{}`: empty state, no problem.
 * - A file the backend could not use is never written over: the backend
 *   either moved it aside or refuses saves (application-shell §DSH-3). The
 *   state is empty and `problem` says which, for the panel to tell the user.
 * - An answer that is not a JSON object is a problem too, with saving
 *   stopped, so the empty state never replaces what the file held.
 *
 * @param {Function} invoke — Tauri invoke function (injected for testability)
 * @returns {Promise<{ state: SessionState, problem: LoadProblem|null }>}
 */
export async function loadSessionState(invoke) {
  let json;
  try {
    json = await invoke('load_state');
  } catch (err) {
    console.warn('[Docent] The session file could not be used:', err?.kind ?? err);
    const problem = loadProblemFrom(err);
    // A set-aside hands back the state a missing file reads as, with the
    // credential-store keys in it; starting from that keeps the next save
    // from clearing them. Without a usable one, saving stops instead.
    const start = problem.kind === 'set_aside' ? deserializeState(err.state) : null;
    if (problem.kind === 'set_aside' && start === null) problem.savingStopped = true;
    return { state: start ? withDefaults(start) : emptyState(), problem };
  }
  const parsed = deserializeState(json);
  if (parsed === null) {
    console.warn('[Docent] The session file is not a JSON object — saving stopped for this run');
    return { state: emptyState(), problem: loadProblemFrom(null) };
  }
  return { state: withDefaults(parsed), problem: null };
}

/**
 * The full shipped state shape over a parsed session object, defaults filled.
 *
 * @param {Object} parsed
 * @returns {SessionState}
 */
function withDefaults(parsed) {
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
}

/**
 * The message the panel shows the user at startup for a LoadProblem.
 *
 * @param {LoadProblem} problem
 * @returns {string}
 */
export function loadProblemMessage(problem) {
  if (problem.kind === 'set_aside') {
    return (
      'Docent could not read your saved projects, so it has started with none.\n\n' +
      `The file it could not read is kept, unchanged, at:\n${problem.keptAs}\n\n` +
      'New work is saved as usual.'
    );
  }
  const where = problem.path ? ` at:\n${problem.path}\n\nThe file is left as it is.` : '.';
  return (
    `Docent could not read your saved projects${where}\n\n` +
    'To keep them safe, Docent will not save anything until you restart it, ' +
    'so changes you make now will be lost.'
  );
}

/**
 * Words for an error a `load_state` or `save_state` invoke rejected with: a
 * backend LoadError reads as the startup message does, an Error as its
 * message, anything else as its text.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function loadErrorText(err) {
  if (typeof err === 'object' && err !== null && typeof err.kind === 'string') {
    return loadProblemMessage(loadProblemFrom(err));
  }
  if (err instanceof Error) return err.message;
  return String(err);
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
