/**
 * sync-baseline.js — Last mutually-agreed state per project (Sync_Baseline)
 *
 * The Sync_Baseline is the retained last *mutually agreed* (last-synced) state
 * of a project — a state confirmed common to both the local side and the
 * Sync_Server, NOT merely the state this client last pushed. It is what lets the
 * Conflict_Detector tell brand-new work apart from work that changed since the
 * last agreement, even when another client pushed concurrently (R1).
 *
 * This module is pure logic over the single durable {@link SyncState} object
 * (its `baselines` map); persistence is the platform `SyncStore` adapter's job
 * (see sync-store.js). It exposes three helpers:
 *
 *   - `getBaseline`               — read the per-project BaselineRecord, or null.
 *   - `advanceBaseline`           — record agreement: store a content digest plus
 *                                   a recoverable copy of the agreed project.
 *   - `getRecordingBaselineDigest`— derive a recording-level agreed digest from
 *                                   the per-project baseline (baseline is stored
 *                                   per project; recording agreement is derived).
 *
 * Design invariants:
 *   - A baseline stores a content digest PLUS a recoverable copy of the agreed
 *     project, so detection and recovery never depend on re-fetching (R1.1).
 *   - `getBaseline` returns null where no baseline exists, so the detector treats
 *     the project as having no last-agreed state (R1.6).
 *   - `advanceBaseline` is advanced ONLY on confirmed agreement or adoption
 *     (pull-confirmed equality R1.3, Review/Conflict adoption R1.4, brand-new
 *     auto-add R3.3). It is NEVER invoked from the push path, because a push is
 *     not confirmation of agreement — a concurrent client may overwrite the
 *     pushed state before this client observes it (R1.2). This module cannot see
 *     its call site, so that guarantee is upheld by the push phase never calling
 *     this function (see sync-client.js push phase).
 *   - The recoverable copy is a deep, independent clone so later mutation of the
 *     caller's object can never corrupt the recorded baseline (R1.1, R1.7).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { digestProject, digestRecording } from './sync-digest.js';

/**
 * Deep, independent copy of an allowlisted, JSON-serializable projection
 * ({@link ProjectCopy}/{@link RecordingCopy}). A JSON round-trip is sufficient
 * and deterministic here because baseline state is always an allowlisted copy of
 * the agreed project (never raw server JSON, never functions/cycles), so the
 * stored baseline cannot be mutated through the caller's reference afterwards.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Read the recorded Sync_Baseline for a project.
 *
 * Returns `null` when no baseline has been recorded for the project, so the
 * Conflict_Detector treats the project as having no last-agreed state (R1.6).
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState (the
 *   in-memory store object whose `baselines` map holds the records)
 * @param {string} project_id
 * @returns {import('./sync-types.js').BaselineRecord | null}
 */
export function getBaseline(state, project_id) {
  if (!state || !state.baselines) return null;
  return state.baselines[project_id] ?? null;
}

/**
 * Record agreement on a project's state by advancing its Sync_Baseline.
 *
 * Stores a content digest of the agreed project plus a recoverable (deep-cloned)
 * copy of it, so detection and recovery never depend on re-fetching (R1.1). The
 * baseline is keyed by `project_id` in `state.baselines`; calling again for the
 * same project replaces the prior record with the newly-agreed state, which also
 * repairs a stale or absent baseline to the confirmed-agreed state (R1.3).
 *
 * MUST be called only on confirmed agreement or adoption — pull-confirmed
 * equality (R1.3), adoption via Review-and-Accept / Conflict_Resolution (R1.4),
 * or auto-add of a brand-new unit (R3.3). MUST NOT be called from the push path
 * (R1.2): a push is not confirmation of agreement.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState; its
 *   `baselines` map is mutated in place
 * @param {string} project_id
 * @param {import('./sync-types.js').ProjectCopy} agreedState - the agreed project
 *   as an allowlisted, canonicalizable copy
 * @param {() => number} [now=Date.now] - clock source (injectable for tests);
 *   used only to stamp the informational `agreedAt`
 * @returns {void}
 */
export function advanceBaseline(state, project_id, agreedState, now = Date.now) {
  if (!state.baselines) state.baselines = {};
  state.baselines[project_id] = {
    digest: digestProject(agreedState),
    agreedState: deepCopy(agreedState),
    agreedAt: new Date(now()).toISOString(),
  };
}

/**
 * Derive the agreed content digest of a single recording from a per-project
 * Sync_Baseline. The baseline is stored per project (a recoverable copy of the
 * whole agreed project); recording-level agreement is derived from it rather than
 * stored separately.
 *
 * Returns `null` when there is no baseline, when the baseline carries no agreed
 * recordings, or when the recording is absent from the agreed project (e.g. a
 * recording that never existed in, or was deleted from, the last-agreed state).
 *
 * @param {import('./sync-types.js').BaselineRecord | null} baseline - a
 *   per-project baseline record (typically from {@link getBaseline}), or null
 * @param {string} recording_id
 * @returns {string | null} the recording's agreed digest, or null
 */
export function getRecordingBaselineDigest(baseline, recording_id) {
  if (!baseline || !baseline.agreedState) return null;
  const recordings = baseline.agreedState.recordings;
  if (!Array.isArray(recordings)) return null;
  const recording = recordings.find((r) => r && r.recording_id === recording_id);
  if (!recording) return null;
  return digestRecording(recording);
}
