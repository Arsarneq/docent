/**
 * sync-client.js — Platform-agnostic remote sync logic
 *
 * Contains push/pull operations, payload construction, and error types
 * for bidirectional HTTP synchronization of Docent projects with a remote server.
 * Uses fetch API only — no DOM, no platform APIs.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { isValidUuidv7 } from './lib/uuid-v7.js';
import { stampFromSchema, checkStampCompatibility } from './lib/format-stamp.js';
import { validatePayload } from './lib/validate-import.js';
import { httpRequest } from './lib/http-transport.js';
import {
  loadSyncState,
  saveSyncState,
  upsertReview,
  upsertConflict,
  getSettings,
  isDismissedIncoming,
} from './sync-store.js';
import { classifyProject } from './conflict-detector.js';
import { getBaseline, advanceBaseline } from './sync-baseline.js';
import { isAppendOnlySuperset, incomingDismissalDigest } from './conflict-resolution.js';
import { digestRecording, digestProjectMetadata } from './sync-digest.js';

/**
 * Error thrown by sync operations for HTTP or network failures.
 */
export class SyncError extends Error {
  /**
   * @param {string} message
   * @param {number|null} status — HTTP status code, or null for network errors
   * @param {string|null} projectName — which project failed, or null for manifest
   */
  constructor(message, status, projectName) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.projectName = projectName;
  }
}

/**
 * Why a sync cycle halted, or `null` when it ran to completion. Mirrors the
 * `HaltReason` contract in sync-types.js:
 *   - `'auth'`                        — server returned 401/403 (R14.3–14.5)
 *   - `'capture-active'`              — capture is running; no cycle starts (R7.1)
 *   - `'pending-actions-unprotected'` — a recording holding Pending Actions was
 *                                       neither locked nor capture-halted (R8.4)
 *   - `'internal-error'`              — detection threw internally, or a version
 *                                       could not be retained while recording a
 *                                       Conflict; the entire sync aborts/blocks
 *                                       with all durable state preserved
 *                                       (R5.3, R16.2)
 *
 * @typedef {('auth'|'capture-active'|'pending-actions-unprotected'|'internal-error'|null)} HaltReason
 */

/**
 * @typedef {Object} SyncResult
 * @property {string[]} pushed - project_ids successfully pushed
 * @property {string[]} pulled - project_ids successfully pulled
 * @property {SyncError[]} errors - errors encountered (non-fatal per-project)
 * @property {SyncError[]} mismatched - projects skipped on pull due to a
 *   docent_format platform/version mismatch (distinct from `errors` so the UI
 *   can present them as a compatibility issue, not a failure)
 * @property {import('./sync-types.js').UnitRef[]} review - unitRefs newly in, or
 *   kept in, Review-and-Accept (empty until the deferral phase is wired in)
 * @property {import('./sync-types.js').UnitRef[]} conflicts - unitRefs newly in,
 *   or kept in, Conflict (empty until the deferral phase is wired in)
 * @property {import('./sync-types.js').UnitRef[]} autoAppliedUpdates - unitRefs
 *   auto-applied as fast-forward updates because Auto-Accept-Updates is ON and the
 *   incoming version is an append-only superset of the baseline (R4.2, R22.4)
 * @property {import('./sync-types.js').UnitRef[]} autoAppliedDeletions - unitRefs
 *   auto-applied as server-side deletions because Auto-Accept-Deletions is ON
 *   (R19.4, R22.5)
 * @property {boolean} halted - true on auth failure, capture-active, a
 *   pending-actions safety halt, or an internal detection/abort failure
 * @property {HaltReason} haltReason - why the cycle halted, or null when it completed
 */

/**
 * Builds request headers for sync operations.
 * Includes Bearer token when apiKey is non-null.
 * @param {string|null} apiKey
 * @returns {object}
 */
export function buildHeaders(apiKey) {
  const headers = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Constructs the Full_Project_Payload shape for a project.
 * Sends full step history without filtering.
 *
 * The payload carries the self-describing `docent_format` stamp (read off the
 * composed schema, the single source of truth). Sync used to omit the stamp,
 * but with client auto-update two clients on one server can be on different
 * schema versions/platforms; the stamp lets the puller detect that. See
 * SECURITY_BACKLOG S12 and docs/sync-protocol.md.
 *
 * ── Per-unit assembly mode (R20.3, R6.4) ─────────────────────────────────────
 * The push is a whole-project write the server stores VERBATIM, so two rules
 * govern what the payload may contain:
 *   - it must never OMIT a recording that still exists on any side, because the
 *     verbatim store would read the omission as a deliberate deletion (R6.4); and
 *   - it must not OVERWRITE the server's copy of a recording that this client has
 *     not reconciled — a deferred (Review/Conflict) or Locked recording must be
 *     sent at the version most recently agreed-or-pulled for it, not at the
 *     un-reconciled local edits (R20.3).
 * When an `assembly` is supplied (the conflict-aware push path), it carries the
 * already-resolved per-unit project metadata and recordings, so this function
 * just stamps and wraps them. When `assembly` is omitted (the legacy
 * whole-project push, and direct callers), the project's own metadata and every
 * one of its recordings are sent at their committed local state — `steps` is the
 * full committed history; Pending Actions live elsewhere and are never part of
 * the payload (R8.1).
 *
 * @param {object} project - the project whose identity (and, without an
 *   `assembly`, whose recordings) are pushed
 * @param {object} schema - the composed platform schema (source of the stamp)
 * @param {{projectMeta: object, recordings: import('./sync-types.js').RecordingCopy[]}} [assembly]
 *   pre-resolved per-unit payload parts from {@link buildProjectPushAssembly};
 *   when present, `projectMeta` and `recordings` are used verbatim (already
 *   allowlisted projections) instead of the project's own local versions
 * @returns {object} { docent_format, project: {...}, recordings: [...] }
 */
export function buildPayloadForProject(project, schema, assembly = null) {
  return {
    docent_format: stampFromSchema(schema),
    project: assembly ? assembly.projectMeta : projectMetaSkeleton(project),
    recordings: assembly
      ? assembly.recordings
      : (project.recordings ?? []).map(recordingProjection),
  };
}

/**
 * The project to SOURCE agreed-or-pulled versions from for a deferred or locked
 * Unit (R6.4, R20.3). "Agreed-or-pulled" is, in precedence:
 *   1. the project's retained Sync_Snapshot payload when it was PULLED this cycle
 *      (the server's current state we just observed); else
 *   2. the project's Sync_Baseline `agreedState` (the last mutually-agreed copy).
 * Returns `null` when neither exists — a Unit that has never been agreed and was
 * not pulled this cycle (e.g. brand-new local work that is also locked), in which
 * case the assembly safely falls back to the local version (there is no server
 * copy to clobber).
 *
 * @param {import('./sync-types.js').SyncState} state - persisted SyncState
 * @param {string} project_id
 * @returns {import('./sync-types.js').ProjectCopy | null}
 */
function agreedOrPulledSource(state, project_id) {
  const snapshot = state?.snapshots?.[project_id];
  if (snapshot && snapshot.payload) return snapshot.payload;
  const baseline = getBaseline(state, project_id);
  return baseline?.agreedState ?? null;
}

/**
 * Assemble the per-unit push parts for ONE project (R20.3, R6.4) — the
 * conflict-aware push body. Iterates the project's recordings as they stand in
 * the reconciled merged-projects list (so any auto-applied update, auto-added
 * brand-new sibling, or auto-applied deletion is already reflected) and, for
 * each Unit, chooses which version goes on the wire:
 *
 *   - a recording that is DEFERRED (an active Review or Conflict for its
 *     `unitRef`) or LOCKED (open in the Recording_View) carries the version most
 *     recently agreed-or-pulled for it ({@link agreedOrPulledSource}), NOT its
 *     un-reconciled local edits — so the whole-project write cannot overwrite a
 *     concurrent server change this client has not reconciled (R6.4, R20.3). When
 *     no agreed-or-pulled version exists, it falls back to the local version
 *     (nothing on the server to clobber).
 *   - every other recording (clean-local-new, `changed-local-outgoing`,
 *     `already-converged`, or an auto-applied incoming version) carries its
 *     local/merged version, so the local edit reaches the wire (R20.2).
 *
 * The project metadata Unit is treated the same way: a project-level deferral
 * (a project-metadata Review/Conflict) sends the agreed-or-pulled metadata; an
 * unconflicted project sends its local metadata.
 *
 * No recording present in the merged project is omitted (R6.4): every recording
 * is emitted, only its VERSION is swapped for the deferred/locked ones. A
 * recording the user has intentionally removed (a propagated or auto-applied
 * deletion) is already absent from the merged project and is therefore correctly
 * not re-sent — the deletion propagates rather than being resurrected.
 *
 * ── `writeNeeded` (the "nothing to write" signal, R20.4) ─────────────────────
 *
 * Alongside the assembled parts, this returns whether the project actually has
 * anything to write — decided by CONTENT, not by which classification a unit
 * fell into. For each unit the wire-version (what this function puts in the
 * payload) is compared by canonical digest against the AGREED-OR-PULLED server
 * version of that same unit ({@link agreedOrPulledSource}); the unit is a reason
 * to write iff the two differ. `writeNeeded` is the OR of those per-unit
 * comparisons (project metadata + every recording).
 *
 * This makes R20.4 literal: a project is skipped only when its WHOLE assembled
 * payload already equals the server's agreed-or-pulled state, so pushing would
 * merely re-send the server's own bytes. It naturally covers every case:
 *   - a `changed-local-outgoing` / clean-local-new recording, or changed local
 *     metadata, differs from the server ⇒ a write;
 *   - an `already-converged` recording equals the server ⇒ not a write;
 *   - a deferred (Review/Conflict) or Locked recording carries the
 *     agreed-or-pulled version, which equals the server ⇒ not a write;
 *   - a deferred/locked recording that FELL BACK to local (no agreed-or-pulled
 *     copy) has no server counterpart to equal ⇒ a write (its local content must
 *     still reach the server).
 * When NO agreed-or-pulled source exists at all (a brand-new local project never
 * pulled and with no baseline), every unit is treated as a write — there is
 * nothing on the server to compare against, so the local work must be sent.
 *
 * A project whose only non-converged unit is a Locked recording (its live edits
 * held back, sent at the agreed-or-pulled version) and whose every other unit
 * equals the server is therefore SKIPPED this cycle (strict R20.4): nothing on
 * the wire would differ from the server, and the held-back edits reach the server
 * on a later cycle, after the recording is unlocked and reconciled. No data is
 * lost by the skip.
 *
 * @param {import('./sync-types.js').SyncState} state - the persisted, reconciled
 *   SyncState (read-only): baselines, snapshots, reviews, and conflicts
 * @param {object} project - the reconciled (merged) project to assemble for
 * @param {Set<string>} lockedRecordingIds - the Locked_Recording set (R6)
 * @returns {{ projectMeta: object, recordings: import('./sync-types.js').RecordingCopy[], writeNeeded: boolean }}
 */
function buildProjectPushAssembly(state, project, lockedRecordingIds) {
  const project_id = project.project_id;
  const locked = lockedRecordingIds instanceof Set ? lockedRecordingIds : new Set();
  const source = agreedOrPulledSource(state, project_id);

  const isDeferred = (unitRef) =>
    Boolean(state?.reviews?.[unitRef]) || Boolean(state?.conflicts?.[unitRef]);

  // True once any unit's wire-version differs (by canonical digest) from the
  // server's agreed-or-pulled version of that same unit — i.e. the assembly is
  // not a pure re-send of the server's state. Drives the caller's
  // skip-nothing-to-write decision by CONTENT, not by classification (R20.4).
  let writeNeeded = false;

  // Project metadata: a project-level deferral sends the agreed-or-pulled
  // metadata so a project-metadata change under review/conflict is not clobbered;
  // otherwise the local metadata. Either way, it is a reason to write only if
  // what we send differs from the server's agreed-or-pulled metadata.
  let projectMeta;
  if (isDeferred(project_id) && source) {
    projectMeta = projectMetaSkeleton(source);
  } else {
    projectMeta = projectMetaSkeleton(project);
  }
  if (digestProjectMetadata(projectMeta) !== digestProjectMetadata(source)) {
    writeNeeded = true;
  }

  const recordings = (project.recordings ?? []).map((rec) => {
    const unitRef = `${project_id}:${rec.recording_id}`;
    const agreed = source ? findRecordingById(source, rec.recording_id) : null;

    let wire;
    if (locked.has(rec.recording_id) || isDeferred(unitRef)) {
      // Deferred/locked: re-send the server's agreed-or-pulled version when one
      // exists (so a whole-project write cannot clobber a concurrent server
      // change this client has not reconciled); otherwise fall back to local
      // (nothing on the server to clobber).
      wire = recordingProjection(agreed ?? rec);
    } else {
      // Clean / changed-local-outgoing / already-converged / auto-applied → local.
      wire = recordingProjection(rec);
    }

    // A reason to write iff the wire-version differs from the server's
    // agreed-or-pulled version of this recording. A recording with no
    // agreed-or-pulled counterpart (brand-new local, or a deferred/locked
    // fallback-to-local) has nothing to equal on the server ⇒ it must be sent.
    if (!agreed || digestRecording(wire) !== digestRecording(agreed)) {
      writeNeeded = true;
    }
    return wire;
  });

  return { projectMeta, recordings, writeNeeded };
}

/**
 * Returns true if the status code indicates an auth failure (401 or 403).
 * @param {number|null} status
 * @returns {boolean}
 */
function isAuthError(status) {
  return status === 401 || status === 403;
}

/**
 * Normalize a value that should be a `Set<string>` of `recording_id`s into a
 * real Set. `LiveState` is platform-provided, so it is treated defensively: a
 * Set is taken as-is, an array is wrapped, and anything else (null/undefined,
 * or a malformed adapter) yields an empty set so a missing signal never
 * accidentally protects or exposes a recording.
 *
 * @param {unknown} value - the raw return of a LiveState id-set accessor
 * @returns {Set<string>}
 */
function toIdSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

/**
 * Pre-flight live-work gate (R7, R8) — evaluated before any push/pull/merge so a
 * gate is a hard block, not an advisory check (R15.5).
 *
 * Two-tier live-work protection, in order:
 *   1. **Capture-Active halt (R7.1, R7.2).** While capture is running, no sync
 *      cycle starts: no push, no pull, no merge. Because capture always occurs
 *      inside an Open_Recording, the capture halt protects every recording that
 *      holds Pending Actions, so the pending-actions assertion below is moot and
 *      is intentionally skipped.
 *   2. **Pending-Actions safety assertion (R8.2, R8.4).** When capture is not
 *      active, every recording that holds uncommitted Pending Actions must be
 *      protected by the Locked_Recording exclusion (the only protection left
 *      once the capture halt is off). If any such recording is unprotected, all
 *      sync halts immediately — without trying to re-engage either protection
 *      mechanism or otherwise recover (R8.4).
 *
 * The gate operates purely on the synchronous `LiveState` signals; it never
 * inspects Pending Actions content. Sync reads only committed `recording.steps`
 * (R8.1), and this gate is what guarantees an unprotected pending recording is
 * never reached by the later phases.
 *
 * @param {import('./sync-types.js').LiveState} liveState - platform live-work signals
 * @returns {{ halted: boolean, haltReason: HaltReason, lockedRecordingIds: Set<string> }}
 *   `halted`/`haltReason` describe a blocking gate (or `{ halted: false }` to
 *   proceed); `lockedRecordingIds` is the computed Locked_Recording set for the
 *   phases that follow.
 */
function evaluatePreflightGate(liveState) {
  // Tier 1 — Capture-Active halt (R7.1, R7.2). No cycle starts at all.
  if (liveState.isCaptureActive()) {
    return { halted: true, haltReason: 'capture-active', lockedRecordingIds: new Set() };
  }

  // Compute the Locked_Recording set once for the assertion and the later phases.
  const lockedRecordingIds = toIdSet(liveState.getLockedRecordingIds());

  // Tier 2 — Pending-Actions safety assertion (R8.2, R8.4). With the capture
  // halt off, a recording holding Pending Actions is safe only if it is locked.
  const pendingRecordingIds = toIdSet(liveState.recordingsWithPendingActions());
  for (const recordingId of pendingRecordingIds) {
    if (!lockedRecordingIds.has(recordingId)) {
      return {
        halted: true,
        haltReason: 'pending-actions-unprotected',
        lockedRecordingIds,
      };
    }
  }

  return { halted: false, haltReason: null, lockedRecordingIds };
}

/**
 * Deep, independent copy of an allowlisted, JSON-serializable projection. A JSON
 * round-trip is sufficient and deterministic here because every value retained
 * as a snapshot is an allowlisted {@link import('./sync-types.js').ProjectCopy}
 * reconstruction (built by {@link pullProjects}), never raw server JSON and never
 * a value with functions/cycles. The copy guarantees the retained snapshot can
 * never be mutated through a reference shared with the merged-projects list.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Land each accepted pulled payload into a retained Sync_Snapshot in the
 * {@link import('./sync-types.js').SyncState}, keyed by `project_id` (R9.1).
 *
 * Pull never overwrites local data directly: instead, every payload that passed
 * the stamp-compatibility and schema-validation safeguards (i.e. every project in
 * `pullResult.projects`) is retained here as a recoverable copy. Retaining the
 * incoming version is the precursor to detection/classification (wired in a later
 * task); for now the snapshot simply guarantees the incoming version stays
 * recoverable rather than being silently dropped or applied.
 *
 * Stamp-incompatible (`mismatched`) and schema-invalid (`errors`) projects are
 * NOT present in `pulledProjects`, so they are never retained as snapshots — they
 * remain compatibility skips / errors and never become snapshots or conflicts
 * (R14.1, R14.2).
 *
 * The snapshot map is keyed by `project_id`, so re-pulling the same project on a
 * later cycle refreshes its snapshot rather than accumulating duplicates.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState; its
 *   `snapshots` map is mutated in place
 * @param {object[]} pulledProjects - accepted pulled projects (allowlisted copies)
 * @param {() => number} [now=Date.now] - clock source (injectable for tests);
 *   used only to stamp the informational `pulledAt`
 * @returns {void}
 */
function retainSnapshots(state, pulledProjects, now = Date.now) {
  if (!state.snapshots) state.snapshots = {};
  const pulledAt = new Date(now()).toISOString();
  for (const project of pulledProjects) {
    state.snapshots[project.project_id] = {
      payload: deepCopy(project),
      pulledAt,
    };
  }
}

/**
 * Push projects to the server.
 * Sends PUT /projects/:id for each project with a Full_Project_Payload body.
 * Non-auth errors on one project do not prevent other projects from being processed.
 *
 * Per-unit conflict-aware push (R20.3, R6.4): when `assemblyByProjectId` is
 * supplied (the orchestrator's store path), each project's payload is built from
 * its pre-resolved per-unit assembly — local versions for pushable recordings,
 * agreed-or-pulled versions for deferred/locked recordings — instead of its raw
 * local versions. When it is omitted (the legacy whole-project push and direct
 * callers), every project is pushed at its committed local state, unchanged.
 *
 * The caller decides WHICH projects to push: a project with nothing to write is
 * simply not present in `projects` (R20.4). This function never advances the
 * Sync_Baseline (R1.2).
 *
 * @param {string} serverUrl - base URL of the sync server
 * @param {string|null} apiKey - Bearer token, or null for unauthenticated
 * @param {object[]} projects - array of (reconciled) project objects to push
 * @param {object} schema - composed platform schema (for the docent_format stamp)
 * @param {Map<string, {projectMeta: object, recordings: import('./sync-types.js').RecordingCopy[]}>} [assemblyByProjectId]
 *   per-project pre-resolved push assemblies; when present, the assembly for a
 *   project_id is used to build its payload (R20.3)
 * @returns {Promise<{pushed: string[], errors: SyncError[], halted: boolean}>}
 */
export async function pushProjects(
  serverUrl,
  apiKey,
  projects,
  schema,
  assemblyByProjectId = null,
) {
  const pushed = [];
  const errors = [];

  for (const project of projects) {
    const assembly = assemblyByProjectId
      ? (assemblyByProjectId.get(project.project_id) ?? null)
      : null;
    const payload = buildPayloadForProject(project, schema, assembly);
    const url = `${serverUrl}/projects/${encodeURIComponent(project.project_id)}`;
    const headers = {
      ...buildHeaders(apiKey),
      'Content-Type': 'application/json',
    };

    let response;
    try {
      response = await httpRequest(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const syncErr = new SyncError(
        `Network error pushing "${project.name}": ${err.message}`,
        null,
        project.name,
      );
      errors.push(syncErr);
      continue;
    }

    if (isAuthError(response.status)) {
      const syncErr = new SyncError(
        `Authentication failed (${response.status}) pushing "${project.name}"`,
        response.status,
        project.name,
      );
      errors.push(syncErr);
      return { pushed, errors, halted: true };
    }

    if (response.ok) {
      pushed.push(project.project_id);
    } else {
      const syncErr = new SyncError(
        `Push failed for "${project.name}" with status ${response.status}`,
        response.status,
        project.name,
      );
      errors.push(syncErr);
    }
  }

  return { pushed, errors, halted: false };
}

/**
 * Pull all projects from the server.
 * Fetches GET /projects for the manifest, then GET /projects/:id for each entry.
 * Non-auth errors on one project do not prevent other projects from being fetched.
 *
 * Each pulled payload is checked in two stages before being accepted:
 *   1. **Stamp compatibility** — its `docent_format` must match this client's
 *      platform + schema version. A platform/version mismatch is rejected with
 *      an actionable reason (the producing client is a different platform, or a
 *      different schema version → update or pin). See the sync schema-mismatch
 *      handling follow-up to S12.
 *   2. **Schema validation** — the full payload must validate against the
 *      generated platform validator (S12).
 *
 * Both are reject-but-log and per-project: a rejected project is skipped and
 * reported (mismatches in `mismatched`, other failures in `errors`); the rest
 * of the pull continues.
 *
 * @param {string} serverUrl - base URL of the sync server
 * @param {string|null} apiKey - Bearer token, or null for unauthenticated
 * @param {(data: unknown) => boolean & { errors?: object[] }} validator -
 *   generated platform validator for the full `.docent.json` envelope
 * @param {{ platform: string, schema_version: string }} localStamp -
 *   this client's expected stamp (from stampFromSchema of its own schema)
 * @returns {Promise<{projects: object[], errors: SyncError[], mismatched: SyncError[], halted: boolean}>}
 */
export async function pullProjects(serverUrl, apiKey, validator, localStamp) {
  const projects = [];
  const errors = [];
  const mismatched = [];
  const headers = buildHeaders(apiKey);

  // Fetch manifest
  let manifestResponse;
  try {
    manifestResponse = await httpRequest(`${serverUrl}/projects`, {
      method: 'GET',
      headers,
      // Bypass the HTTP cache. The extension transport is the webview's `fetch`,
      // which otherwise lets the browser serve a STALE manifest/project payload
      // (the reference server, and adopter servers, may send an ETag but no
      // Cache-Control) — making the client miss a concurrent server change and
      // skip the review/conflict it should raise. The desktop's native transport
      // ignores this field (it has no shared browser cache).
      cache: 'no-store',
    });
  } catch (err) {
    const syncErr = new SyncError(
      `Network error fetching project manifest: ${err.message}`,
      null,
      null,
    );
    errors.push(syncErr);
    return { projects, errors, mismatched, halted: false };
  }

  if (isAuthError(manifestResponse.status)) {
    const syncErr = new SyncError(
      `Authentication failed (${manifestResponse.status}) fetching project manifest`,
      manifestResponse.status,
      null,
    );
    errors.push(syncErr);
    return { projects, errors, mismatched, halted: true };
  }

  if (!manifestResponse.ok) {
    const syncErr = new SyncError(
      `Failed to fetch project manifest with status ${manifestResponse.status}`,
      manifestResponse.status,
      null,
    );
    errors.push(syncErr);
    return { projects, errors, mismatched, halted: false };
  }

  const manifest = await manifestResponse.json();

  // Fetch each project by id
  for (const entry of manifest) {
    // The manifest comes from the server (untrusted). Validate the id shape
    // before interpolating it into the request path — a malformed or hostile
    // id must not be able to reshape the authenticated request URL (the Bearer
    // token rides along). See SECURITY_BACKLOG S15.
    if (!entry || typeof entry !== 'object' || !isValidUuidv7(entry.project_id)) {
      errors.push(
        new SyncError(`Skipped manifest entry with invalid project_id`, null, entry?.name ?? null),
      );
      continue;
    }
    const url = `${serverUrl}/projects/${encodeURIComponent(entry.project_id)}`;

    let response;
    try {
      response = await httpRequest(url, {
        method: 'GET',
        headers,
        // Bypass the HTTP cache so the webview `fetch` (extension) always reads
        // the server's current bytes — a stale cached project payload here reads
        // as already-converged and silently drops an incoming change. See the
        // manifest fetch above.
        cache: 'no-store',
      });
    } catch (err) {
      const syncErr = new SyncError(
        `Network error fetching project "${entry.name}": ${err.message}`,
        null,
        entry.name,
      );
      errors.push(syncErr);
      continue;
    }

    if (isAuthError(response.status)) {
      const syncErr = new SyncError(
        `Authentication failed (${response.status}) fetching project "${entry.name}"`,
        response.status,
        entry.name,
      );
      errors.push(syncErr);
      return { projects, errors, mismatched, halted: true };
    }

    if (!response.ok) {
      const syncErr = new SyncError(
        `Failed to fetch project "${entry.name}" with status ${response.status}`,
        response.status,
        entry.name,
      );
      errors.push(syncErr);
      continue;
    }

    const payload = await response.json();

    // Stage 1 — stamp compatibility. Reject a project whose docent_format does
    // not match this client's platform/schema version, with an actionable
    // reason, before the generic schema check (which would only say "invalid").
    // Recorded in `mismatched`, not `errors`, so the UI can phrase it as a
    // compatibility issue rather than a failure. Skipped only when localStamp is
    // unavailable (defensive — callers always provide it).
    if (localStamp) {
      const stampCheck = checkStampCompatibility(payload, localStamp);
      if (!stampCheck.compatible) {
        mismatched.push(
          new SyncError(`Skipped "${entry.name}": ${stampCheck.message}`, null, entry.name),
        );
        continue;
      }
    }

    // Stage 2 — schema validation against the platform validator (S12). A
    // malformed payload is skipped and reported (reject-but-log); the rest of
    // the pull continues.
    const { valid, errors: validationErrors } = validatePayload(validator, payload);
    if (!valid) {
      errors.push(
        new SyncError(
          `Pulled project "${entry.name}" failed schema validation: ${validationErrors.join('; ')}`,
          null,
          entry.name,
        ),
      );
      continue;
    }

    // Reconstruct project from Full_Project_Payload shape using an explicit
    // field allowlist — never spread untrusted JSON into stored state.
    const project = {
      project_id: payload.project.project_id,
      name: payload.project.name,
      created_at: payload.project.created_at,
      ...(payload.project.metadata && { metadata: payload.project.metadata }),
      recordings: (payload.recordings ?? []).map((r) => ({
        recording_id: r.recording_id,
        name: r.name,
        created_at: r.created_at,
        ...(r.metadata && { metadata: r.metadata }),
        steps: r.steps ?? [],
      })),
    };
    projects.push(project);
  }

  return { projects, errors, mismatched, halted: false };
}

// ─── Graded detection — automatic outcomes (R1.3, R2, R3, R6, R19) ───────────

/**
 * Allowlisted projection of a recording, matching the exact field allowlist the
 * pull path uses when it reconstructs a project (see {@link pullProjects}). Used
 * to land an incoming recording into the merged-projects list and the baseline
 * as a clean {@link import('./sync-types.js').RecordingCopy} — never raw server
 * JSON, and unrecognized top-level fields dropped (R18.3).
 *
 * @param {object} recording
 * @returns {import('./sync-types.js').RecordingCopy}
 */
function recordingProjection(recording) {
  return {
    recording_id: recording.recording_id,
    name: recording.name,
    created_at: recording.created_at,
    ...(recording.metadata && { metadata: recording.metadata }),
    steps: recording.steps ?? [],
  };
}

/**
 * Allowlisted projection of a project's own scalar identity fields (no
 * recordings). The base for assembling a per-project baseline's agreed state.
 *
 * @param {object} project
 * @returns {{project_id: string, name: string, created_at: string, metadata?: object}}
 */
function projectMetaSkeleton(project) {
  return {
    project_id: project.project_id,
    name: project.name,
    created_at: project.created_at,
    ...(project.metadata && { metadata: project.metadata }),
  };
}

/**
 * Full allowlisted projection of a project (scalar identity + ordered recording
 * copies), matching the pull reconstruction allowlist. Used when auto-adding a
 * brand-new project to the merged list and recording it as the agreed baseline.
 *
 * @param {object} project
 * @returns {import('./sync-types.js').ProjectCopy}
 */
function projectProjection(project) {
  return {
    ...projectMetaSkeleton(project),
    recordings: (project.recordings ?? []).map(recordingProjection),
  };
}

/**
 * Find a recording by id within a project, or null when absent.
 *
 * @param {object|null} project
 * @param {string} recording_id
 * @returns {object|null}
 */
function findRecordingById(project, recording_id) {
  if (!project) return null;
  const recordings = Array.isArray(project.recordings) ? project.recordings : [];
  return recordings.find((r) => r && r.recording_id === recording_id) ?? null;
}

/**
 * Record (or refresh) a single recording in a project's Sync_Baseline as agreed
 * state (R3.3). The baseline is per-project, so a recording is recorded by
 * splicing it into the agreed project's recordings — preserving the other agreed
 * recordings — and re-advancing the baseline (which re-digests and deep-clones).
 * When the project has no baseline yet, a fresh agreed-project skeleton is built
 * from the project's own metadata so the new recording has somewhere to live.
 *
 * @param {import('./sync-types.js').SyncState} state - mutated in place
 * @param {string} project_id
 * @param {object} metaSource - a project to source the agreed metadata from when
 *   no baseline exists (the local, or failing that the incoming, project)
 * @param {import('./sync-types.js').RecordingCopy} recordingCopy - the agreed recording
 * @returns {void}
 */
function recordRecordingInBaseline(state, project_id, metaSource, recordingCopy) {
  const existing = getBaseline(state, project_id);
  const recordings = existing?.agreedState?.recordings ? [...existing.agreedState.recordings] : [];
  const idx = recordings.findIndex((r) => r && r.recording_id === recordingCopy.recording_id);
  if (idx >= 0) recordings[idx] = recordingCopy;
  else recordings.push(recordingCopy);
  const meta = projectMetaSkeleton(existing?.agreedState ?? metaSource);
  advanceBaseline(state, project_id, { ...meta, recordings });
}

/**
 * Clear a single recording from a project's Sync_Baseline (R19.1, R19.6). Used
 * to propagate a deletion: the recording is removed from the agreed state so it
 * is no longer considered last-agreed. A no-op when the project has no baseline.
 *
 * @param {import('./sync-types.js').SyncState} state - mutated in place
 * @param {string} project_id
 * @param {string} recording_id
 * @returns {void}
 */
function clearRecordingFromBaseline(state, project_id, recording_id) {
  const existing = getBaseline(state, project_id);
  if (!existing || !existing.agreedState) return;
  const recordings = (existing.agreedState.recordings ?? []).filter(
    (r) => r && r.recording_id !== recording_id,
  );
  advanceBaseline(state, project_id, {
    ...projectMetaSkeleton(existing.agreedState),
    recordings,
  });
}

/**
 * Build the recoverable {@link import('./sync-types.js').UnitCopy} for ONE side
 * of a deferred Unit, at the Unit's own granularity:
 *
 *   - project-level Unit (`recording_id == null`) → the full
 *     {@link import('./sync-types.js').ProjectCopy} via {@link projectProjection};
 *   - recording-level Unit → the {@link import('./sync-types.js').RecordingCopy}
 *     for that recording within the side's project via {@link recordingProjection}.
 *
 * Returns `null` when the Unit is ABSENT on this side — either the whole project
 * is missing, or the project is present but the recording is gone. A `null` copy
 * is the faithful representation of a deletion side of a `deleted-remote-review`
 * Review or a `conflict-delete-vs-change` Conflict: there is no version to
 * retain on that side, and the downstream resolution/UI already treat a `null`
 * version as "deleted (no version on this side)".
 *
 * Every returned copy is an allowlisted projection (never raw server JSON), so
 * the idempotent store helpers can retain it as a deep, JSON-serializable copy
 * (R5.2, R4.6, R18.3).
 *
 * @param {object|null} sideProject - the local (or incoming) project for the Unit
 * @param {string|null} recording_id - the recording id, or null for a project Unit
 * @returns {import('./sync-types.js').UnitCopy|null}
 */
function unitCopyForSide(sideProject, recording_id) {
  if (sideProject == null) return null;
  if (recording_id == null) return projectProjection(sideProject);
  const recording = findRecordingById(sideProject, recording_id);
  return recording ? recordingProjection(recording) : null;
}

/**
 * The last-agreed version of ONE Unit, taken from its per-project Sync_Baseline,
 * at the Unit's own granularity:
 *
 *   - project-level Unit (`recording_id == null`) → the whole agreed
 *     {@link import('./sync-types.js').ProjectCopy};
 *   - recording-level Unit → the agreed {@link import('./sync-types.js').RecordingCopy}
 *     for that recording within the agreed project.
 *
 * Returns `null` when there is no baseline, no agreed state, or no agreed entry
 * for the recording. This is the `base` side of the fast-forward
 * ({@link isAppendOnlySuperset}) check the reconcile phase uses to decide whether
 * a `changed-incoming` version may be auto-applied (R4.2, R22.4): the incoming
 * version is auto-applied only when it RETAINS every committed step record present
 * in this last-agreed version (a true append-only fast-forward).
 *
 * @param {import('./sync-types.js').BaselineRecord | null} baseline - the per-project baseline
 * @param {string|null} recording_id - the recording id, or null for a project Unit
 * @returns {import('./sync-types.js').UnitCopy|null}
 */
function baselineUnitCopy(baseline, recording_id) {
  const agreed = baseline?.agreedState;
  if (agreed == null) return null;
  if (recording_id == null) return agreed;
  return findRecordingById(agreed, recording_id);
}

/**
 * Run the Conflict_Detector over every Unit and apply ONLY the AUTOMATIC
 * outcomes, producing the merged-projects list. This replaces the legacy
 * server-wins merge whenever a durable `store` is supplied: instead of
 * overwriting local data with the server copy, each Unit is classified against
 * its Sync_Baseline and reconciled by what is provably safe to do without the
 * user (design phase 6–7).
 *
 * The reconciliation set is the union of project ids across the local projects,
 * the accepted pulled projects, and the recorded baselines — so a project absent
 * on one side but present in the baseline is still seen as a deletion case (R19)
 * rather than being missed. A local project with no baseline that is simply not
 * present on the server this cycle yields no classification and is kept as-is
 * (it has nothing inbound to reconcile and no agreed state marking a deletion).
 *
 * Automatic outcomes applied here:
 *   - `locked-skipped`        — excluded from the merge entirely; the recording's
 *                               incoming change is neither applied nor offered
 *                               (R6.1, R6.2, R6.3, R8.3, R15.4). Because the lock
 *                               is only consulted this cycle, the recording
 *                               becomes eligible again next cycle (R6.5).
 *   - `already-converged`     — advance/repair the per-project baseline to the
 *                               confirmed-agreed state (R1.3); local is kept (it
 *                               is content-identical to incoming).
 *   - `brand-new`             — auto-add the Unit (a project appended whole, a
 *                               recording appended as a new sibling) and record
 *                               it in the baseline (R2.6, R3.1, R3.2, R3.3); a
 *                               failed add is isolated so the cycle continues
 *                               (R3.4, R14.6).
 *   - `deleted-local-clean` /
 *     `deleted-both`          — propagate the deletion: the Unit is absent
 *                               locally, so it is simply not re-added, and it is
 *                               cleared from the baseline (R19.1, R19.6).
 *   - `changed-local-outgoing`— a routine one-sided LOCAL change (local moved,
 *                               the server is still at the last-agreed state):
 *                               kept as-is in the merged list so the local
 *                               version is pushed on the outbound phase, with NO
 *                               baseline advance — the baseline advances only
 *                               when a later pull confirms incoming == local
 *                               (R2.5, R21.1, R21.2).
 *
 * SETTINGS-GATED automatic outcomes (the orchestrator reads the client-local
 * reconciliation-policy settings here via {@link getSettings}; the classifier
 * itself stays settings-independent, R22.6):
 *   - `changed-incoming`      — auto-applied (the incoming version replaces the
 *                               local one in the merged list, and the per-Unit
 *                               baseline advances to it) ONLY when
 *                               Auto-Accept-Updates is ON AND the incoming version
 *                               is an append-only superset of the baseline (a true
 *                               fast-forward via {@link isAppendOnlySuperset}); the
 *                               `unitRef` is reported in `autoAppliedUpdates`
 *                               (R4.2, R22.4). Otherwise — the setting is OFF, the
 *                               incoming version is NOT a fast-forward (R4.3), or
 *                               the exact incoming version was previously dismissed
 *                               by a decline (R4.9, R4.10) — a Review-and-Accept
 *                               item is recorded instead and local data is left
 *                               unchanged (R4.1). A dismissed-incoming version is
 *                               neither auto-applied nor re-offered.
 *   - `deleted-remote-review` — auto-applied (the recording/project is removed
 *                               from the merged list and cleared from the baseline)
 *                               ONLY when Auto-Accept-Deletions is ON; the
 *                               `unitRef` is reported in `autoAppliedDeletions`
 *                               (R19.4, R22.5). The removed Unit stays recoverable
 *                               as the retained Sync_Baseline copy and Sync_Snapshot.
 *                               Otherwise — the setting is OFF, or the exact
 *                               deletion was previously dismissed — a
 *                               Review-and-Accept item is recorded and local data
 *                               is left unchanged (R19.3).
 *
 * DEFERRED outcomes are recorded as durable, idempotent store items, never
 * auto-applied (design phase 7):
 *   - `changed-incoming` / `deleted-remote-review` → a Review-and-Accept item
 *     (`upsertReview`) holding the recoverable incoming version, recorded only
 *     when the settings-gated auto-apply above did NOT fire; the incoming change
 *     is never applied automatically (R4.1, R9.5, R15.2, R19.3).
 *   - `diverged` / `conflict-delete-vs-change` → a Conflict
 *     (`upsertConflict`) retaining BOTH the local and incoming versions. No
 *     setting ever auto-resolves these (R5.1, R5.2, R19.2, R19.4, R22.6).
 * Both helpers are idempotent and keyed by `unitRef`, so re-detecting the same
 * Unit across repeated cycles keeps exactly ONE record (with mutual exclusion
 * between Review and Conflict) rather than accumulating duplicates (R10.3,
 * R10.4, R10.5). For every deferred Unit the LOCAL data is left unchanged in the
 * merged-projects list (R9.5): the merged project keeps its local version and no
 * incoming change is applied. The deferred `unitRef`s are collected into the
 * returned `review`/`conflicts` arrays so the SyncResult counts reflect them
 * (R10.5, R13.2, R15.2). No version is ever discarded except via resolution.
 *
 * @param {import('./sync-types.js').SyncState} state - loaded SyncState; its
 *   `baselines`, `reviews`, and `conflicts` maps are mutated in place as outcomes
 *   are applied. Read-only access to `settings` and `dismissedIncoming` drives the
 *   settings-gated auto-apply and dismissal honoring.
 * @param {object[]} localProjects - the local projects (never mutated)
 * @param {object[]} pulledProjects - the accepted pulled projects (incoming side)
 * @param {Set<string>} lockedRecordingIds - Locked_Recording ids to exclude (R6)
 * @returns {{ mergedProjects: object[], review: import('./sync-types.js').UnitRef[], conflicts: import('./sync-types.js').UnitRef[], autoAppliedUpdates: import('./sync-types.js').UnitRef[], autoAppliedDeletions: import('./sync-types.js').UnitRef[] }}
 */
function applyAutomaticOutcomes(state, localProjects, pulledProjects, lockedRecordingIds) {
  // Deferral sets returned to the orchestrator so the SyncResult counts reflect
  // the Review-and-Accept and Conflict records produced this cycle (R13.2).
  const review = [];
  const conflicts = [];
  // Settings-gated auto-apply sets (R4.2/R22.4 updates, R19.4/R22.5 deletions).
  const autoAppliedUpdates = [];
  const autoAppliedDeletions = [];

  // The ORCHESTRATOR reads the client-local reconciliation-policy settings here
  // and applies the policy; the classifier stayed settings-independent (R22.6).
  // A pre-R1 / absent `settings` normalizes to both toggles OFF, so the default
  // behavior gates every incoming change and deletion for review (R22.1, R22.2).
  const settings = getSettings(state);

  // Ordered, lazily-cloned merged-projects structure seeded from local projects.
  // A project object is cloned (with a fresh recordings array) only when it is
  // actually modified, so untouched local projects — and their recordings — are
  // never mutated (sibling recordings stay byte-identical).
  const mergedById = new Map();
  const order = [];
  for (const project of localProjects) {
    mergedById.set(project.project_id, project);
    order.push(project.project_id);
  }
  const cloned = new Set();
  const getMutableProject = (project_id) => {
    let project = mergedById.get(project_id);
    if (!cloned.has(project_id)) {
      project = { ...project, recordings: [...(project.recordings ?? [])] };
      mergedById.set(project_id, project);
      cloned.add(project_id);
    }
    return project;
  };

  // Remove a recording from the merged project (used by an auto-applied server
  // deletion). A no-op when the project or recording is already absent locally.
  const removeRecordingFromMerged = (project_id, recording_id) => {
    if (!mergedById.has(project_id)) return;
    const merged = getMutableProject(project_id);
    merged.recordings = merged.recordings.filter((r) => r && r.recording_id !== recording_id);
  };

  // Replace (or append) a recording in the merged project with an incoming copy
  // (used by an auto-applied fast-forward update).
  const applyRecordingToMerged = (project_id, recordingCopy) => {
    const merged = mergedById.has(project_id) ? getMutableProject(project_id) : null;
    if (!merged) return;
    const idx = merged.recordings.findIndex(
      (r) => r && r.recording_id === recordingCopy.recording_id,
    );
    if (idx >= 0) merged.recordings[idx] = recordingCopy;
    else merged.recordings.push(recordingCopy);
  };

  // Union of project ids: local first, then pulled, then baseline-only.
  const localById = new Map(localProjects.map((p) => [p.project_id, p]));
  const incomingById = new Map(pulledProjects.map((p) => [p.project_id, p]));
  const projectIds = [];
  const seen = new Set();
  const addId = (id) => {
    if (id != null && !seen.has(id)) {
      seen.add(id);
      projectIds.push(id);
    }
  };
  for (const p of localProjects) addId(p.project_id);
  for (const p of pulledProjects) addId(p.project_id);
  for (const id of Object.keys(state.baselines ?? {})) addId(id);

  for (const project_id of projectIds) {
    const local = localById.get(project_id) ?? null;
    const incoming = incomingById.get(project_id) ?? null;
    const baseline = getBaseline(state, project_id);

    const classifications = classifyProject(local, incoming, baseline, lockedRecordingIds);

    for (const classification of classifications) {
      const { kind, recording_id, unitRef } = classification;

      switch (kind) {
        case 'already-converged': {
          // Project-level agreement (both sides fully equal). Advance/repair the
          // baseline to the confirmed-agreed state; local is kept unchanged since
          // it is content-identical to incoming (R1.3, R2.2).
          advanceBaseline(state, project_id, projectProjection(incoming ?? local));
          break;
        }

        case 'brand-new': {
          if (recording_id == null) {
            // Brand-new project: auto-add it whole and record it as agreed
            // (R3.1, R3.3). The baseline write is done first because its deep
            // clone is the only step that can fail; isolating that failure keeps
            // a single bad Unit from aborting the cycle (R3.4, R14.6).
            try {
              const added = projectProjection(incoming);
              advanceBaseline(state, project_id, added);
              if (!mergedById.has(project_id)) {
                mergedById.set(project_id, added);
                order.push(project_id);
              }
            } catch {
              // Leave this Unit unsynced and continue with the rest.
            }
          } else {
            // Brand-new recording within an existing local project: append it as
            // a new sibling and record it in the baseline (R3.2, R3.3). Sibling
            // recordings are untouched.
            const incomingRecording = findRecordingById(incoming, recording_id);
            if (incomingRecording) {
              try {
                const recordingCopy = recordingProjection(incomingRecording);
                recordRecordingInBaseline(state, project_id, local ?? incoming, recordingCopy);
                const merged = getMutableProject(project_id);
                if (!merged.recordings.some((r) => r && r.recording_id === recording_id)) {
                  merged.recordings.push(recordingCopy);
                }
              } catch {
                // Isolate the failed add; the rest of the cycle proceeds (R3.4).
              }
            }
          }
          break;
        }

        case 'deleted-local-clean':
        case 'deleted-both': {
          // Propagate a clean local/agreed deletion (R19.1, R19.6). The Unit is
          // absent locally, so there is nothing to remove from the merged list —
          // the work is to NOT re-add it (no resurrection) and to clear it from
          // the baseline so it is no longer considered last-agreed.
          if (recording_id == null) {
            if (state.baselines) delete state.baselines[project_id];
          } else {
            clearRecordingFromBaseline(state, project_id, recording_id);
          }
          break;
        }

        case 'locked-skipped':
          // Excluded from the merge this cycle (R6.1–6.3, R8.3, R15.4). No change
          // is applied or offered; the recording becomes eligible next cycle once
          // the lock is gone (R6.5).
          break;

        case 'changed-local-outgoing': {
          // A routine ONE-SIDED local change: the local version moved while the
          // server is still at the last-agreed baseline (R2.5, R21). It is an
          // AUTOMATIC, non-deferred outcome (R21.1, R21.4) — never a Review or a
          // Conflict — so nothing is recorded in the store. The local version is
          // already present unchanged in the merged-projects list, which is what
          // the push phase sends, so this Unit's local edit reaches the server
          // automatically. The baseline is deliberately NOT advanced here: a push
          // is not confirmation of mutual agreement, so the baseline advances only
          // when a later pull confirms incoming == local (R21.2, R1.3).
          //
          // The per-unit conflict-aware push assembly (task 22.3, R20.3) reads
          // this classification's effect: the recording stays at its LOCAL
          // version in the merged list, which the assembly sends on the wire as
          // the "push the local version" case. Leaving the merged list and
          // baseline untouched here is the correct behavior.
          break;
        }

        // ── Reconcile outcomes for local-unchanged incoming change / deletion ──
        // These two cases are LOCAL-UNCHANGED (only the server side moved), so
        // the client-local reconciliation-policy settings decide auto-apply vs
        // defer (R22.4, R22.5, R22.6). The settings affect ONLY these cases —
        // they never auto-resolve a `diverged` or `conflict-delete-vs-change`
        // Unit (handled below, R22.6). When NOT auto-applied, the Unit becomes a
        // durable, idempotent Review-and-Accept item keyed by `unitRef`
        // (single record per Unit, Review/Conflict mutual exclusion, R10.3–10.5)
        // and LOCAL data is left unchanged in the merged list (R4.1, R9.5, R19.3).

        case 'changed-incoming': {
          // An incoming change to a recording whose LOCAL copy is unchanged since
          // the baseline (R2.4). The incoming version is retained (the local one
          // is untouched). A version previously DISMISSED by a decline of the
          // exact same incoming version is never re-offered NOR auto-applied
          // (R4.9, R4.10): it is dropped from this cycle's attention entirely.
          const incomingCopy = unitCopyForSide(incoming, recording_id);
          const dismissalDigest = incomingDismissalDigest(incomingCopy, recording_id);
          if (isDismissedIncoming(state, unitRef, dismissalDigest)) {
            // The user already declined this exact incoming version — keep local
            // unchanged and do not re-offer (R4.9). A DIFFERENT incoming version
            // would not match the recorded digest and would be classified afresh.
            break;
          }

          // Auto-apply ONLY when Auto-Accept-Updates is ON AND the incoming
          // version is an append-only superset of the baseline — a true
          // fast-forward that drops no committed step record (R4.2, R22.4). A
          // non-fast-forward incoming change is held for Review even when the
          // setting is ON (R4.3).
          //
          // The fast-forward (append-only superset) predicate is a STEP-HISTORY
          // concept, so auto-apply is scoped to RECORDING-level units. A
          // project-level `changed-incoming` is a project-metadata change (its
          // recordings are reconciled as their own Units); auto-applying it would
          // mean replacing the whole project and could clobber a sibling
          // recording's independent outcome, so it always defers to Review.
          const base = baselineUnitCopy(baseline, recording_id);
          const isFastForward = recording_id != null && isAppendOnlySuperset(base, incomingCopy);
          if (settings.autoAcceptUpdates && isFastForward) {
            // Adopt the incoming recording into the merged list and advance the
            // per-Unit baseline to it (R4.2) — siblings untouched (R1.9).
            applyRecordingToMerged(project_id, incomingCopy);
            recordRecordingInBaseline(state, project_id, local ?? incoming, incomingCopy);
            autoAppliedUpdates.push(unitRef);
          } else {
            // Defer: Auto-Accept-Updates OFF, a non-fast-forward change, or a
            // project-metadata change (R4.1, R4.3). Record a Review item retaining
            // the incoming version; local data is untouched (R9.5).
            upsertReview(state, unitRef, incomingCopy);
            review.push(unitRef);
          }
          break;
        }

        case 'deleted-remote-review': {
          // A server-side deletion of a Unit whose LOCAL copy is unchanged since
          // the baseline (R19.3). The incoming side is absent, so there is no
          // incoming version to retain — a declined deletion is keyed by the
          // stable deletion sentinel (R4.9).
          const deletionDigest = incomingDismissalDigest(null, recording_id);
          if (isDismissedIncoming(state, unitRef, deletionDigest)) {
            // The user already declined this server deletion — keep local and do
            // not re-offer (R4.9, R4.10).
            break;
          }

          if (settings.autoAcceptDeletions) {
            // Auto-apply the deletion (R19.4, R22.5): remove the Unit from the
            // merged list and clear it from the baseline. The removed Unit stays
            // recoverable as the retained Sync_Baseline copy (read BEFORE the
            // clear) and the Sync_Snapshot, so no authored work is lost.
            if (recording_id == null) {
              // Whole-project deletion: drop the project from the merged list and
              // clear its baseline.
              if (mergedById.has(project_id)) {
                mergedById.delete(project_id);
                const idx = order.indexOf(project_id);
                if (idx >= 0) order.splice(idx, 1);
              }
              if (state.baselines) delete state.baselines[project_id];
            } else {
              removeRecordingFromMerged(project_id, recording_id);
              clearRecordingFromBaseline(state, project_id, recording_id);
            }
            autoAppliedDeletions.push(unitRef);
          } else {
            // Defer the deletion to Review-and-Accept (R19.3). The incoming side
            // is absent, so the retained copy is null — the resolution/UI already
            // represent a null version as "deleted".
            upsertReview(state, unitRef, null);
            review.push(unitRef);
          }
          break;
        }

        case 'diverged':
        case 'conflict-delete-vs-change': {
          // Conflict: both sides moved (R5.1), or a delete-vs-change case
          // (R19.2, R19.4). BOTH the local and incoming versions are retained in
          // recoverable form so neither is lost while resolution is deferred
          // (R5.2); for a delete-vs-change Unit the deletion side is absent, so
          // that side's retained copy is null (the deletion is itself the
          // version on that side). Local data stays unchanged in the merged list
          // until the user resolves (R9.5).
          const localCopy = unitCopyForSide(local, recording_id);
          const incomingCopy = unitCopyForSide(incoming, recording_id);
          upsertConflict(state, unitRef, localCopy, incomingCopy);
          conflicts.push(unitRef);
          break;
        }

        default:
          break;
      }
    }
  }

  const mergedProjects = order.map((id) => mergedById.get(id));
  return { mergedProjects, review, conflicts, autoAppliedUpdates, autoAppliedDeletions };
}

/**
 * Execute a full sync cycle in PULL-FIRST order: pre-flight gate → pull +
 * snapshot → reconcile → persist → push (Requirement 20.1). Pulling and
 * reconciling BEFORE pushing is the precondition for detecting a concurrent
 * server change: a push-first order would set the server equal to local before
 * the pull observed it, so `incoming == local` would always hold and a
 * divergence could never be detected (this is the defect this ordering fixes).
 * 401/403 on any request halts the cycle (R14.3).
 *
 * Before any transport work, a **pre-flight live-work gate** runs (R7, R8,
 * R15.5). It is a hard block, not an advisory check: while capture is active no
 * cycle starts at all (`haltReason: 'capture-active'`), and any recording that
 * holds uncommitted Pending Actions without being locked halts sync immediately
 * (`haltReason: 'pending-actions-unprotected'`). The gate runs only when a
 * `liveState` adapter is supplied; callers that do not pass one (the original
 * 5-argument form) keep the prior behavior unchanged.
 *
 * The `store` adapter drives the reconciliation phase. When a `store` is
 * supplied, the legacy server-wins merge is replaced by GRADED DETECTION: each
 * accepted pulled payload is first landed into a retained `Sync_Snapshot` keyed
 * by `project_id` (R9.1), then `classifyProject` classifies every Unit against
 * its Sync_Baseline and only the AUTOMATIC outcomes are applied — auto-add a
 * brand-new project/recording and record it in the baseline (R2.6, R3.1–3.3);
 * advance/repair the baseline on confirmed agreement (R1.3); propagate a clean
 * local/agreed deletion and clear it from the baseline (R19.1, R19.6); and skip
 * locked recordings entirely (R6.1–6.3), which makes them eligible again next
 * cycle (R6.5). Deferred outcomes are recorded as durable, idempotent store
 * items and surfaced in the result counts: `changed-incoming` /
 * `deleted-remote-review` become Review-and-Accept items and `diverged` /
 * `conflict-delete-vs-change` become Conflicts, each kept as a single record per
 * Unit across repeated cycles (R4.1, R5.1, R10.3, R10.5, R19.2–19.4). No
 * incoming change is ever auto-applied and local data is preserved unchanged for
 * a deferred Unit (R9.5). When NO `store` is supplied
 * (the original 5-argument callers), the prior server-wins merge is preserved
 * unchanged for backward compatibility. The store is read and written ONLY in
 * the reconcile phase, which runs AFTER a successful pull and BEFORE any push.
 * An auth halt on the pull therefore returns before the store is touched and
 * preserves all existing baselines, conflicts, and reviews (R14.3–14.5); a push
 * runs only after reconcile + persist complete without halting (R20.6), so an
 * auth halt on the push happens after the store has already been persisted and
 * likewise preserves all durable state.
 *
 * **Abort / block with state preserved (R5.3, R16.2).** The detection phase and
 * its persist are wrapped so the cycle can never leave a PARTIAL state. Because
 * `applyAutomaticOutcomes` mutates only the in-memory `state` and `saveSyncState`
 * is the sole persistence point, any throw before the save — whether a version
 * that cannot be retained while recording a Conflict (`upsertConflict`'s deep
 * clone throws, R5.3) or an unexpected internal failure in detection (R16.2) —
 * aborts/blocks the whole sync: it returns `halted: true` with
 * `haltReason: 'internal-error'`, the store untouched (all baselines, snapshots,
 * conflicts, and reviews preserved), and the unchanged `localProjects` handed
 * back (no partial merge). This is the "when in doubt, preserve and block"
 * backstop — the store transitions atomically from its prior state to the
 * fully-reconciled state, or not at all.
 *
 * **Reported counts (R13.2).** The returned `SyncResult` reports the sets the
 * cycle actually produced: `pushed` / `pulled` project ids, `mismatched`
 * (stamp-incompatible skips) and `errors` (incl. schema-invalid) per-project, and
 * the `review` / `conflicts` `unitRef`s recorded this cycle.
 *
 * **Gating parity (R15.1–15.3).** `sync()` has a SINGLE code path regardless of
 * how it was triggered — there is no manual-vs-automatic branch — so the
 * Locked_Recording exclusion and the Capture_Active halt apply identically to
 * manually and automatically triggered cycles (R15.3). The whole reconciliation
 * path (transport, detection, push, brand-new auto-add) is non-interactive: it
 * invokes no user-input hook, so automatic operations complete without user
 * interaction (R15.1), and an incoming change to an existing recording is only
 * ever DEFERRED to a durable Review/Conflict, never adopted here (R15.2);
 * adoption happens solely in the separate, user-driven resolution workflow.
 *
 * @param {string} serverUrl - base URL of the sync server
 * @param {string|null} apiKey - Bearer token, or null for unauthenticated
 * @param {object[]} localProjects - array of local project objects (full shape)
 * @param {object} schema - composed platform schema (for the docent_format stamp on push)
 * @param {(data: unknown) => boolean & { errors?: object[] }} validator -
 *   generated platform validator applied to each pulled payload
 * @param {import('./sync-types.js').SyncStore} [store] - durable conflict-handling
 *   state adapter; when supplied, drives snapshot retention + graded detection
 * @param {import('./sync-types.js').LiveState} [liveState] - synchronous live-work
 *   signals (open-recording / capture-active / pending-actions). When omitted, the
 *   pre-flight gate is skipped and prior behavior is preserved.
 * @returns {Promise<{result: SyncResult, projects: object[]}>}
 */
export async function sync(serverUrl, apiKey, localProjects, schema, validator, store, liveState) {
  const allErrors = [];
  const allMismatched = [];

  // 0. Pre-flight live-work gate (R7, R8, R15.5). Runs before any transport so
  // a gate is a hard block, not an advisory check. Skipped entirely when no
  // liveState adapter is supplied, preserving the original 5-argument behavior.
  // The computed Locked_Recording set is threaded into the detection phase so
  // locked recordings are excluded from the inbound merge (R6).
  let lockedRecordingIds = new Set();
  if (liveState) {
    const gate = evaluatePreflightGate(liveState);
    if (gate.halted) {
      return {
        result: {
          pushed: [],
          pulled: [],
          errors: allErrors,
          mismatched: allMismatched,
          review: [],
          conflicts: [],
          autoAppliedUpdates: [],
          autoAppliedDeletions: [],
          halted: true,
          haltReason: gate.haltReason,
        },
        projects: localProjects,
      };
    }
    lockedRecordingIds = gate.lockedRecordingIds;
  }

  // The stamp this client expects on any project it accepts. Derived from its
  // own composed schema (the single source of truth), so it can never drift.
  const localStamp = stampFromSchema(schema);

  // 1. Pull phase (R20.1). Pull-first is the precondition for detecting a
  // concurrent server change: the pull observes the server state BEFORE this
  // client's push can overwrite it, so a divergence can be classified instead of
  // being silently last-write-wins clobbered. A 401/403 here HALTS the cycle
  // before any reconcile or push runs, so the durable `store` is never touched
  // and ALL existing baselines, Conflicts, and Review-and-Accept items are
  // preserved exactly as they were (R14.3–14.5, R20.6).
  const pullResult = await pullProjects(serverUrl, apiKey, validator, localStamp);
  allErrors.push(...pullResult.errors);
  allMismatched.push(...pullResult.mismatched);

  if (pullResult.halted) {
    return {
      result: {
        pushed: [],
        pulled: [],
        errors: allErrors,
        mismatched: allMismatched,
        review: [],
        conflicts: [],
        autoAppliedUpdates: [],
        autoAppliedDeletions: [],
        halted: true,
        haltReason: 'auth',
      },
      projects: localProjects,
    };
  }

  // 2. Reconcile pulled projects into the local list.
  //
  // Two paths, selected by whether a durable `store` adapter is supplied:
  //
  //   • NO store (the original 5-argument callers) — the legacy server-wins
  //     merge is preserved verbatim: a pulled project with a matching id
  //     replaces the local one, a new id is appended. There is nowhere to retain
  //     a Sync_Baseline or a Sync_Snapshot without a store, so this path keeps
  //     the prior behavior unchanged for backward compatibility.
  //
  //   • WITH a store — GRADED DETECTION replaces server-wins. The pull is first
  //     landed into retained Sync_Snapshots (R9.1), then `classifyProject`
  //     classifies every Unit against its Sync_Baseline and the AUTOMATIC
  //     outcomes are applied (auto-add brand-new, advance/repair the baseline on
  //     agreement, propagate a clean deletion, skip locked recordings). Local
  //     work is never blindly overwritten; deferred outcomes are recorded as
  //     durable, idempotent Review-and-Accept / Conflict store items (their
  //     unitRefs returned in `review`/`conflicts`) and leave local data
  //     untouched until the user resolves (R4.1, R5.1, R9.5, R10.3).
  //     The store is touched ONLY here, after a successful pull and before any
  //     push, so an auth halt on the pull returns before this point and
  //     preserves all existing baselines/conflicts/reviews (R14.3–14.5).
  //     Stamp-incompatible (`mismatched`) and schema-invalid (`errors`) projects
  //     never reach `pullResult.projects`, so they are never snapshotted,
  //     classified, or turned into conflicts (R14.1, R14.2).
  const pulled = pullResult.projects.map((p) => p.project_id);

  let mergedProjects;
  let review = [];
  let conflicts = [];
  let autoAppliedUpdates = [];
  let autoAppliedDeletions = [];
  // The per-project conflict-aware push assembly (R20.3, R6.4) and the list of
  // projects that actually have something to write (R20.4). Built in the store
  // path below from the PERSISTED, reconciled `state` so the deferred/locked
  // version-selection reads the same store the reconcile phase just saved. Left
  // null/undefined for the legacy no-store path, which pushes whole local
  // projects unchanged.
  let assemblyByProjectId = null;
  let projectsToPush;

  if (store) {
    // The detection phase + persist are wrapped so the cycle never leaves a
    // PARTIAL state behind (R5.3, R16.2). Two failure modes converge here:
    //
    //   • ABORT-ON-UNRETAINABLE (R5.3) — while recording a Conflict, a version
    //     that cannot be retained in recoverable form makes `upsertConflict`'s
    //     deep clone throw. Per the design, the ENTIRE sync must abort with
    //     prior state intact rather than half-record the Conflict.
    //   • BLOCK-ON-INTERNAL-FAILURE (R16.2) — any unexpected throw from
    //     `classifyProject`/`applyAutomaticOutcomes` (or the save) blocks sync
    //     rather than continuing with potential conflicts or a partial merge.
    //
    // Both surface identically at this boundary: a throw out of the block.
    // Crucially, `applyAutomaticOutcomes` mutates only the IN-MEMORY `state`
    // loaded from the store; `saveSyncState` is the sole persistence point. So
    // returning here WITHOUT having reached `saveSyncState` leaves every
    // persisted baseline / snapshot / conflict / review exactly as it was
    // before this cycle (R5.3, R16.2). The merged-projects list is also
    // discarded — the caller is handed back the unchanged `localProjects`, so
    // no partial merge is ever written to local storage either.
    try {
      const state = await loadSyncState(store);
      // 3a. Snapshot retention (R9.1) — keep every accepted incoming version
      // recoverable before any reconciliation touches the merged list.
      retainSnapshots(state, pullResult.projects);
      // 3b. Detection + automatic outcomes (R1.3, R2, R3, R6, R19). Mutates the
      // baselines in `state` as agreements/additions/deletions are applied.
      const outcome = applyAutomaticOutcomes(
        state,
        localProjects,
        pullResult.projects,
        lockedRecordingIds,
      );
      mergedProjects = outcome.mergedProjects;
      review = outcome.review;
      conflicts = outcome.conflicts;
      autoAppliedUpdates = outcome.autoAppliedUpdates;
      autoAppliedDeletions = outcome.autoAppliedDeletions;
      // 3c. Persist ONLY on success. Reached only when detection completed
      // without a throw, so the store transitions atomically from its prior
      // state to the fully-reconciled state — never a partial write.
      await saveSyncState(store, state);

      // 3d. Per-unit conflict-aware push assembly (R20.3, R6.4, R20.4). Built
      // here, from the just-persisted reconciled `state`, so the push phase
      // (which runs after this block, where `state` is out of scope) has the
      // pre-resolved payload parts. For each reconciled project, assemble its
      // payload per recording — local version for pushable/clean/auto-applied
      // units, agreed-or-pulled version for deferred (Review/Conflict) and
      // locked units — and decide whether the project has anything to write:
      //   - a project AUTO-ADDED from the server this cycle (present in the
      //     merged list but NOT among the local projects, e.g. a brand-new-remote
      //     project) is already on the server verbatim, so it is never re-pushed
      //     (R20.4); and
      //   - a project whose whole assembled payload is just the agreed-or-pulled
      //     server state (`writeNeeded === false`) has nothing local to
      //     propagate and is skipped (R20.4).
      // Every project that survives carries at least one local unit and is
      // pushed at its per-unit assembly.
      assemblyByProjectId = new Map();
      const localProjectIds = new Set(localProjects.map((p) => p.project_id));
      projectsToPush = [];
      for (const project of mergedProjects) {
        const assembly = buildProjectPushAssembly(state, project, lockedRecordingIds);
        // Skip a project that was auto-added from the server (nothing local to
        // send) or whose assembly is a pure agreed-or-pulled re-send (R20.4).
        if (!localProjectIds.has(project.project_id) || !assembly.writeNeeded) continue;
        assemblyByProjectId.set(project.project_id, {
          projectMeta: assembly.projectMeta,
          recordings: assembly.recordings,
        });
        projectsToPush.push(project);
      }
    } catch {
      // Abort/block: return halted with ALL durable state preserved (the store
      // was never written) and the local projects unchanged (no partial merge).
      // Reconcile runs before push, so nothing has been pushed yet.
      return {
        result: {
          pushed: [],
          pulled: [],
          errors: allErrors,
          mismatched: allMismatched,
          review: [],
          conflicts: [],
          autoAppliedUpdates: [],
          autoAppliedDeletions: [],
          halted: true,
          haltReason: 'internal-error',
        },
        projects: localProjects,
      };
    }
  } else {
    // Legacy server-wins merge (no durable store available): same project_id
    // replaces the local one, a new project_id is appended. With no store there
    // is no per-unit assembly and no deferral state, so the whole merged list is
    // pushed as before (the original 5-argument behavior is preserved).
    mergedProjects = [...localProjects];
    for (const pulledProject of pullResult.projects) {
      const localIndex = mergedProjects.findIndex((p) => p.project_id === pulledProject.project_id);
      if (localIndex >= 0) {
        mergedProjects[localIndex] = pulledProject;
      } else {
        mergedProjects.push(pulledProject);
      }
    }
    projectsToPush = localProjects;
  }

  // 3. Push phase (R6.4, R1.2, R20.2–20.4, R20.6). Runs ONLY after the pull and
  // reconcile phases of the same cycle completed without halting (R20.6) —
  // pulling and reconciling first is what lets a concurrent server change be
  // detected and deferred before this client's push, instead of being silently
  // overwritten.
  //
  // The push is a whole-project write the server stores VERBATIM, so the payload
  // is assembled PER-UNIT (R20.3, R6.4) rather than re-sending raw local edits:
  //   - a pushable recording (clean-local-new, `changed-local-outgoing`,
  //     `already-converged`, or an auto-applied incoming version) is sent at its
  //     LOCAL/merged version, so the local edit reaches the server (R20.2); and
  //   - a deferred (Review/Conflict) or Locked recording is sent at the version
  //     most recently AGREED-OR-PULLED for it (its Sync_Snapshot version when
  //     pulled this cycle, else its Sync_Baseline version), NOT its un-reconciled
  //     local edits — so the whole-project write cannot clobber a concurrent
  //     server change this client has not reconciled, and a Locked_Recording is
  //     never dropped (which the verbatim store would read as a deletion, R6.4).
  // No recording present in a pushed project is ever omitted; only its VERSION
  // is swapped for the deferred/locked ones. The lock excludes the *inbound*
  // merge (the reconcile phase above), never the recording's *outbound* presence.
  //
  // Only projects with something to write are pushed (R20.4): a project
  // auto-added from the server this cycle, or one whose assembled payload would
  // be a pure re-send of the agreed-or-pulled server state, is skipped rather
  // than re-sending an unchanged payload. `projectsToPush` and
  // `assemblyByProjectId` were computed in the reconcile block from the
  // just-persisted reconciled `state` (which is out of scope here); the legacy
  // no-store path leaves the assembly null and pushes the local projects whole.
  //
  // Push reads only committed `recording.steps`; Pending Actions live in a
  // separate store and are never part of the payload (R8.1).
  //
  // Push never advances the Sync_Baseline. A push is not confirmation of mutual
  // agreement — a concurrent client may overwrite the pushed state before this
  // client observes it — so the baseline persisted in the reconcile phase above
  // is intentionally left untouched here; the baseline advances only on a
  // pull-confirmed agreement or an adoption (R1.2).
  const pushResult = await pushProjects(
    serverUrl,
    apiKey,
    projectsToPush,
    schema,
    assemblyByProjectId,
  );
  allErrors.push(...pushResult.errors);

  if (pushResult.halted) {
    // Auth failure on the push (R14.3). The pull and reconcile already completed
    // and the store was already persisted (R20.6), so all durable state is
    // preserved; the merged projects reflect the completed reconciliation. We
    // simply halt and report what was pulled and deferred this cycle.
    return {
      result: {
        pushed: pushResult.pushed,
        pulled,
        errors: allErrors,
        mismatched: allMismatched,
        review,
        conflicts,
        autoAppliedUpdates,
        autoAppliedDeletions,
        halted: true,
        haltReason: 'auth',
      },
      projects: mergedProjects,
    };
  }

  return {
    result: {
      pushed: pushResult.pushed,
      pulled,
      errors: allErrors,
      mismatched: allMismatched,
      review,
      conflicts,
      autoAppliedUpdates,
      autoAppliedDeletions,
      halted: false,
      haltReason: null,
    },
    projects: mergedProjects,
  };
}
