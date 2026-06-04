/**
 * conflict-resolution.js — User-gated outcome application (Conflict_Resolution)
 *
 * The resolution half of the conflict-handling feature. Where the
 * Conflict_Detector decides what must be deferred, this module is the user-gated
 * workflow that finally *adopts* a version — and it is the ONLY place a deferred
 * version is ever applied to local data (R9.2, R15.2). It never runs during a
 * sync cycle; it is invoked from the UI when the user acts on a deferred item
 * (R2.7, R10.2, R12).
 *
 * Two concerns live here:
 *
 *   1. **Routing guard** ({@link itemKind}) — report whether a Unit's deferred
 *      item is a Review-and-Accept item or a Conflict, so a Review can only be
 *      opened with the accept/decline interface and a Conflict only with the
 *      local-vs-incoming chooser. Opening an item with the wrong interface is
 *      rejected (R12.4). `acceptReview` / `declineReview` use this guard, so they
 *      refuse to act on a Conflict (or a Unit with no deferral).
 *
 *   2. **Review adoption** ({@link acceptReview}, {@link declineReview}) — the
 *      user-gated outcomes for a Review-and-Accept item:
 *        • accept  → apply the retained incoming snapshot to the affected Unit,
 *                    advance the affected Unit's baseline entry **per-unit** to the
 *                    resolved-against incoming version (siblings untouched), mark
 *                    the item APPLIED, and clear it (R4.5–4.7, R1.4, R1.9, R12.5).
 *        • decline → keep the local version untouched, record the declined
 *                    incoming version as dismissed so it is not re-offered, retain
 *                    the incoming Sync_Snapshot for recovery, then clear the item;
 *                    declining advances no baseline and pushes nothing
 *                    (R4.8–4.10, R1.8, R12.5).
 *      Conflict resolution ({@link resolveConflict}) — adopting a chosen version
 *      of a *diverged* Unit with append-only step safety and the delete-vs-change
 *      choice — advances the affected Unit's baseline entry **per-unit** to the
 *      resolved-against incoming version (removing the entry when that side is a
 *      deletion) and pushes nothing; the adopted state propagates on the next
 *      pull-first cycle (R1.4, R1.9, R1.10, R20.5).
 *
 * The shared **fast-forward predicate** ({@link isAppendOnlySuperset}) is also
 * exported here for the orchestrator's Auto-Accept-Updates auto-apply path.
 *
 * ── State model & atomicity (consistent with sync-store.js / sync-baseline.js) ─
 * Like its sibling modules, this module is pure logic over the in-memory
 * {@link SyncState}: the helpers mutate `state` (advance the baseline via
 * `advanceBaseline`, clear the item via `clearItem`) and return a plain
 * {@link ResolutionResult}. Durable persistence is the caller's job — the panel
 * persists the mutated `state` through its `SyncStore` adapter (`saveSyncState`)
 * exactly as it does after detection — so resolution stays platform-independent
 * and parity-bearing (R17.1).
 *
 * Every recoverable copy is built BEFORE any part of `state` is mutated, so if a
 * version cannot be retained (a clone throws) the operation aborts with the store
 * left entirely unchanged and the item still pending — "clear the item only on
 * success" (R12.5, R12.6). The local projects array is never mutated in place: an
 * accept returns a NEW projects array with the affected project (and, within it,
 * the affected recording) replaced, so a caller's prior reference is never
 * corrupted and a decline leaves it byte-identical (R4.6, R9.5).
 *
 * ── Note on the signature ─────────────────────────────────────────────────────
 * The design sketch lists `acceptReview(state, store, unitRef)`. Applying the
 * incoming change to the affected recording AND advancing the baseline to the
 * *accepted project state* both require the local project, so — following the
 * synchronous, persistence-separate pattern already used by `advanceBaseline`
 * and the `upsert*` helpers (which take the in-memory `state`, not the adapter) —
 * these helpers take the local `projects` and return the updated `projects` in
 * the result. The caller persists `state` separately. Making the application an
 * explicit, returned result (rather than relying on a caller to re-derive it)
 * keeps adoption the single, auditable place a version is applied (R9.2).
 *
 * Design references: R4.2, R4.3, R4.4, R4.5, R4.6, R12.4, R12.5, R12.6, R17.1.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { advanceBaseline } from './sync-baseline.js';
import { clearItem, recordDismissedIncoming } from './sync-store.js';
import { digestProject, digestRecording } from './sync-digest.js';
import { resolveActiveSteps } from './lib/session.js';
import { uuidv7 } from './lib/uuid-v7.js';

/**
 * Why a resolution did not apply, or `null` on success.
 *
 *   - `'not-found'`        the Unit has no active deferred item (NONE state).
 *   - `'wrong-interface'`  the item exists but is the other kind — e.g. opening a
 *                          Conflict with the Review interface (R12.4).
 *   - `'no-resolution'`    a Conflict was opened with no explicit resolved state.
 *                          Resolution never defaults to keep-or-delete — the user
 *                          must choose — so an absent choice is rejected without
 *                          touching state (R19.5).
 *   - `'not-appendable'`   the chosen resolved recording would drop step records
 *                          that exist in the conflicting histories, i.e. it is not
 *                          an append-only superset of both sides. Adopting it
 *                          would lose a version, so the resolution aborts and the
 *                          Conflict is left unresolved (R11.1, R9.4).
 *   - `'apply-failed'`     a version could not be retained/applied (e.g. a missing
 *                          local project, a malformed resolved state, or an
 *                          unclonable copy); the store and projects are left
 *                          unchanged (R9.4, R12.6).
 *
 * @typedef {('not-found'|'wrong-interface'|'no-resolution'|'not-appendable'|'apply-failed'|null)} ResolutionFailure
 */

/**
 * The outcome of a resolution action. On success `ok` is true, `projects` is the
 * resulting projects array (a new array for an accept; the input array unchanged
 * for a decline), and `item` is the item in its final form (status `APPLIED` for
 * an accepted Review). On failure `ok` is false, `reason` says why, `projects` is
 * the unchanged input array, and `state` is left untouched (R12.6).
 *
 * @typedef {Object} ResolutionResult
 * @property {boolean} ok - true when the resolution applied
 * @property {('review'|'conflict'|null)} kind - the item's actual kind at call time
 * @property {ResolutionFailure} reason - why it failed, or null on success
 * @property {(import('./sync-types.js').ReviewItem|import('./sync-types.js').ConflictItem|null)} item
 *   the item in its final form (APPLIED for an accepted Review), the untouched
 *   item on a wrong-interface rejection, or null when none was found
 * @property {object[]} projects - the resulting local projects array
 * @property {(import('./sync-types.js').SnapshotRecord|import('./sync-types.js').UnitCopy|null)} [retained]
 *   on a decline, the retained recoverable incoming version (the project-level
 *   Sync_Snapshot when present, else the item's incoming copy) (R4.6)
 * @property {boolean} [removed]
 *   true when a Conflict was resolved by accepting a deletion — the Unit was
 *   removed from `projects` and cleared from the adopted baseline (R19.5)
 */

/**
 * Deep, independent copy of an allowlisted, JSON-serializable projection
 * ({@link ProjectCopy}/{@link RecordingCopy}). A JSON round-trip is sufficient
 * and deterministic because the versions stored on a deferred item are always
 * allowlisted copies (never raw server JSON, never functions/cycles), so the
 * applied data can never be mutated through the caller's reference afterwards.
 * Matches the clone strategy in sync-store.js and sync-baseline.js. Throws if the
 * value is not JSON-serializable, which the callers use as the abort signal
 * BEFORE any state mutation (R12.6).
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Report the kind of the active deferred item for a Unit — the routing guard
 * (R12.4). Conflicts are checked before reviews; the two maps are mutually
 * exclusive per `unitRef` (guaranteed by sync-store.js), so a Unit resolves to at
 * most one kind. Returns `null` for a Unit in the NONE state (no active item),
 * which lets a caller open neither interface.
 *
 * This is the single source of truth the resolution interfaces consult: the
 * accept/decline path acts only when this returns `'review'`, and the
 * local-vs-incoming path acts only when it returns `'conflict'`, so an item can
 * never be opened with the other type's interface.
 *
 * @param {import('./sync-types.js').SyncState | null | undefined} state - the loaded SyncState
 * @param {import('./sync-types.js').UnitRef} unitRef - the Unit's idempotency key
 * @returns {('review'|'conflict'|null)}
 */
export function itemKind(state, unitRef) {
  if (!state) return null;
  if (state.conflicts && state.conflicts[unitRef]) return 'conflict';
  if (state.reviews && state.reviews[unitRef]) return 'review';
  return null;
}

/**
 * Return a copy of `project` with the recording matching `recordingCopy`'s id
 * replaced by `recordingCopy`; if no such recording exists locally the recording
 * is appended as a new sibling. The project object and its `recordings` array are
 * rebuilt (never mutated in place) so a caller's prior reference stays intact.
 *
 * @param {object} project - the local project to apply into
 * @param {import('./sync-types.js').RecordingCopy} recordingCopy - the incoming recording
 * @returns {object} a new project object with the recording applied
 */
function applyRecordingToProject(project, recordingCopy) {
  const recordings = Array.isArray(project.recordings) ? project.recordings : [];
  const index = recordings.findIndex(
    (recording) => recording && recording.recording_id === recordingCopy.recording_id,
  );
  const nextRecordings =
    index >= 0
      ? recordings.map((recording, i) => (i === index ? recordingCopy : recording))
      : [...recordings, recordingCopy];
  return { ...project, recordings: nextRecordings };
}

/**
 * Allowlisted projection of a project's own scalar identity fields (no
 * recordings) — the base for assembling a per-project baseline's agreed state.
 * Mirrors `projectMetaSkeleton` in sync-client.js so a baseline written from the
 * resolution path is shaped exactly like one written from the sync cycle.
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
 * Advance ONLY one recording's entry within the per-project Sync_Baseline to the
 * **resolved-against incoming** recording, leaving every sibling recording's
 * baseline entry unchanged (R1.9). This is the per-unit baseline rule shared by
 * `acceptReview` and `resolveConflict`: resolving one recording must never mark a
 * locally-changed sibling as agreed (the latent bug this revision fixes).
 *
 *   - `incomingRecordingCopy` present → the recording's baseline entry is set to
 *     that resolved-against incoming version (replacing the prior agreed entry,
 *     or inserting one when the project's baseline had none for it).
 *   - `incomingRecordingCopy` is `null` → the resolved-against incoming side is a
 *     deletion, so the recording's baseline entry is REMOVED (R1.4, R1.10), so the
 *     surviving/kept local version reads as a one-sided change (changed-local-
 *     outgoing, or local-new when no project baseline remains) and is pushed on
 *     the next cycle. A removal when no baseline exists at all is a no-op.
 *
 * The agreed project's metadata is taken from the current agreed project when a
 * baseline exists (so it is literally "the current agreed project with one
 * recording replaced", R1.9), otherwise from `metaSource` (the adopted project),
 * so a recording resolved before its project ever had a baseline still records
 * agreement on just that recording.
 *
 * @param {import('./sync-types.js').SyncState} state - mutated in place
 * @param {string} project_id
 * @param {string} recording_id
 * @param {import('./sync-types.js').RecordingCopy | null} incomingRecordingCopy
 * @param {object|null} metaSource - project to source agreed metadata from when no baseline exists
 * @param {() => number} now - clock source for the baseline stamp
 * @returns {void}
 */
function advanceRecordingBaselineEntry(
  state,
  project_id,
  recording_id,
  incomingRecordingCopy,
  metaSource,
  now,
) {
  const existing = state.baselines ? state.baselines[project_id] : undefined;
  // Nothing to remove when the resolved-against side is a deletion and there is
  // no agreed state at all.
  if (incomingRecordingCopy == null && !existing) return;

  const baseRecordings = existing?.agreedState?.recordings
    ? [...existing.agreedState.recordings]
    : [];
  const idx = baseRecordings.findIndex((r) => r && r.recording_id === recording_id);

  if (incomingRecordingCopy == null) {
    // Resolved-against incoming side is a deletion → remove the entry (R1.10).
    if (idx >= 0) baseRecordings.splice(idx, 1);
  } else if (idx >= 0) {
    baseRecordings[idx] = incomingRecordingCopy;
  } else {
    baseRecordings.push(incomingRecordingCopy);
  }

  // Source the agreed project's metadata from the current agreed project when a
  // baseline exists (so it is literally "the agreed project with one recording
  // replaced", R1.9), else from the adopted project; fall back to a minimal
  // skeleton keyed by `project_id` so a recording resolved before its project
  // ever had a baseline (and with no adopted project to source from) still
  // records agreement without throwing.
  const meta = projectMetaSkeleton(existing?.agreedState ?? metaSource ?? { project_id });
  advanceBaseline(state, project_id, { ...meta, recordings: baseRecordings }, now);
}

/**
 * Advance a whole-project Sync_Baseline to the **resolved-against incoming**
 * project, or clear it when the resolved-against incoming side is a deletion
 * (R1.4, R1.9). Used for project-level Units, where the resolved-against version
 * is the entire incoming project (or its absence).
 *
 * @param {import('./sync-types.js').SyncState} state - mutated in place
 * @param {string} project_id
 * @param {import('./sync-types.js').ProjectCopy | null} incomingProjectCopy
 * @param {() => number} now - clock source for the baseline stamp
 * @returns {void}
 */
function advanceProjectBaselineEntry(state, project_id, incomingProjectCopy, now) {
  if (incomingProjectCopy == null) {
    if (state.baselines) delete state.baselines[project_id];
    return;
  }
  advanceBaseline(state, project_id, incomingProjectCopy, now);
}

/**
 * Report whether `candidate` is an **append-only superset** of `base` — i.e. it
 * RETAINS every committed step record (by `uuid`) present in `base`. This is the
 * **fast-forward** predicate the orchestrator's Auto-Accept-Updates path uses to
 * decide whether a `changed-incoming` recording may be auto-applied: an incoming
 * version is auto-applied only when it is a true fast-forward of the Sync_Baseline
 * (it adds records but drops none); a non-superset incoming version (history
 * rewritten or records dropped) is still held for explicit Review (R4.2, R4.3,
 * R22.4).
 *
 * Exported for reuse by the orchestrator. It is total over both granularities
 * (recording- and project-level {@link UnitCopy}) via {@link collectStepUuids},
 * and treats a `null`/absent `base` as having no records (so anything is a
 * superset of nothing).
 *
 * @param {import('./sync-types.js').UnitCopy | null | undefined} base - the baseline version
 * @param {import('./sync-types.js').UnitCopy | null | undefined} candidate - the incoming version
 * @returns {boolean} true iff `candidate` retains every step record present in `base`
 */
export function isAppendOnlySuperset(base, candidate) {
  const present = collectStepUuids(candidate);
  for (const uuid of collectStepUuids(base)) {
    if (!present.has(uuid)) return false;
  }
  return true;
}

/**
 * Accept a PENDING Review-and-Accept item: adopt the retained incoming change.
 *
 * Steps (R4.5–4.7, R1.4, R1.9, R12.5), in an order that keeps the store untouched
 * on any failure (R12.6):
 *   1. Routing guard — act only on a Review item; reject a Conflict or a
 *      NONE-state Unit (R12.4).
 *   2. Build the adopted local state from recoverable copies, with no state
 *      mutation:
 *        • recording-level item → apply the incoming {@link RecordingCopy} into
 *          its project (replacing the unchanged-since-baseline local recording),
 *          or, when the incoming side is a deletion (`deleted-remote-review`,
 *          `incoming == null`), REMOVE the recording from its project (R19.3);
 *        • project-level item → the incoming {@link ProjectCopy} *is* the adopted
 *          project state, or the project slot becomes `null` when the incoming
 *          side is a whole-project deletion.
 *      A missing local project (recording-level) or an unclonable copy aborts
 *      with `reason: 'apply-failed'`, store unchanged.
 *   3. Advance the baseline **per-unit** to the **resolved-against incoming
 *      version** (R1.4, R1.9) — NOT to the adopted local state: a recording-level
 *      accept updates ONLY that recording's entry in the per-project baseline
 *      (leaving siblings untouched), removing the entry when the incoming side is
 *      a deletion (R1.10); a project-level accept advances (or clears) the whole
 *      project baseline. For an accept the resolved-against version equals the
 *      adopted state, so the Unit reads as `already-converged` on a subsequent
 *      identical pull and nothing is pushed (R20.5). Accepting pushes nothing.
 *   4. Mark the item APPLIED (R4.7) and clear it from the store (R12.5).
 *
 * The affected recording in the returned `projects` equals the incoming version
 * (R4.5); sibling recordings and every other Unit's local data and baseline entry
 * are untouched (R1.9). Persistence of the mutated `state` is the caller's
 * responsibility (see module header).
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState; its
 *   `baselines` and `reviews` maps are mutated in place on success
 * @param {object[]} projects - the local projects array (never mutated in place)
 * @param {import('./sync-types.js').UnitRef} unitRef - the Unit to accept
 * @param {{ now?: () => number }} [options] - clock source for the baseline stamp
 *   (injectable for tests); defaults to `Date.now`
 * @returns {ResolutionResult}
 */
export function acceptReview(state, projects, unitRef, options = {}) {
  const now = options.now ?? Date.now;
  const currentProjects = Array.isArray(projects) ? projects : [];

  // 1. Routing guard (R12.4): act only on a Review item.
  const kind = itemKind(state, unitRef);
  if (kind !== 'review') {
    return {
      ok: false,
      kind,
      reason: kind === null ? 'not-found' : 'wrong-interface',
      item: kind === 'conflict' ? state.conflicts[unitRef] : null,
      projects: currentProjects,
    };
  }

  const item = state.reviews[unitRef];
  const isRecordingLevel = item.recording_id != null;
  // A `deleted-remote-review` item carries no incoming version: the resolved-
  // against incoming side is a deletion (R19.3). Accepting it adopts the deletion.
  const isDeletion = item.incoming == null;

  // 2. Build the adopted local state from recoverable copies BEFORE mutating
  //    state, so any failure here aborts with the store unchanged (R12.6). Also
  //    capture the resolved-against incoming version (a deep copy, or null for a
  //    deletion) used to advance the baseline per-unit in step 3 (R1.4, R1.9).
  let incomingCopy = null;
  let adoptedProject; // recording-level metadata source for the per-unit baseline
  let nextProjects;
  try {
    if (!isDeletion) incomingCopy = deepCopy(item.incoming);

    if (isRecordingLevel) {
      const index = currentProjects.findIndex(
        (project) => project && project.project_id === item.project_id,
      );
      if (index < 0) {
        // No local project to apply the recording change into — cannot adopt
        // without risking an inconsistent state, so abort unchanged (R12.6).
        return {
          ok: false,
          kind: 'review',
          reason: 'apply-failed',
          item,
          projects: currentProjects,
        };
      }
      adoptedProject = isDeletion
        ? removeRecordingFromProject(currentProjects[index], item.recording_id)
        : applyRecordingToProject(currentProjects[index], incomingCopy);
      nextProjects = currentProjects.map((project, i) => (i === index ? adoptedProject : project));
    } else {
      // Project-level review.
      const index = currentProjects.findIndex(
        (project) => project && project.project_id === item.project_id,
      );
      if (isDeletion) {
        // Adopt the whole-project deletion: the project slot becomes null (the
        // platform's projects list normalizes a null slot away). A no-op when the
        // project is already absent locally.
        nextProjects =
          index >= 0
            ? currentProjects.map((project, i) => (i === index ? null : project))
            : currentProjects;
      } else {
        // The incoming copy is the adopted project state.
        nextProjects =
          index >= 0
            ? currentProjects.map((project, i) => (i === index ? incomingCopy : project))
            : [...currentProjects, incomingCopy];
      }
    }
  } catch {
    // A version that cannot be retained as a recoverable copy aborts the accept
    // with the store and projects left unchanged (R12.6).
    return { ok: false, kind: 'review', reason: 'apply-failed', item, projects: currentProjects };
  }

  // 3. Advance the baseline PER-UNIT to the resolved-against incoming version
  //    (R1.4, R1.9), not to the adopted state. A recording-level accept touches
  //    only that recording's baseline entry (siblings untouched), removing it for
  //    a deletion (R1.10); a project-level accept advances/clears the whole
  //    project baseline. Accepting never pushes (R20.5).
  if (isRecordingLevel) {
    advanceRecordingBaselineEntry(
      state,
      item.project_id,
      item.recording_id,
      incomingCopy,
      adoptedProject,
      now,
    );
  } else {
    advanceProjectBaselineEntry(state, item.project_id, incomingCopy, now);
  }

  // 4. Transition the item to APPLIED (R4.7), then clear it (R12.5). The cleared
  //    item is returned in its APPLIED form so the caller can observe the
  //    transition even though it no longer needs attention.
  const appliedItem = { ...item, status: 'APPLIED' };
  clearItem(state, unitRef);

  return { ok: true, kind: 'review', reason: null, item: appliedItem, projects: nextProjects };
}

/**
 * Canonical digest of a Review item's retained incoming version, at the item's
 * own granularity, used to record a decline as a dismissal (R4.9). A
 * recording-level item digests its {@link RecordingCopy} with
 * {@link digestRecording} (which matches the `digestIncoming` the
 * Conflict_Detector computes for that recording, so the orchestrator re-offers
 * the SAME incoming version as dismissed and a DIFFERENT one afresh, R4.10); a
 * project-level item digests its {@link ProjectCopy} with {@link digestProject}.
 *
 * A `deleted-remote-review` item carries no incoming version (`incoming == null`)
 * — the resolved-against incoming side is a deletion — so its dismissal is keyed
 * by the stable {@link DISMISSED_DELETION_DIGEST} sentinel, letting a declined
 * server deletion stay suppressed while a later, non-deletion incoming version is
 * classified afresh.
 *
 * @param {import('./sync-types.js').ReviewItem} item
 * @returns {string} the canonical dismissal digest for the item's incoming version
 */
function dismissedIncomingDigest(item) {
  return incomingDismissalDigest(item.incoming, item.recording_id);
}

/**
 * Stable sentinel digest recorded when a server-side deletion Review
 * (`deleted-remote-review`, whose incoming version is absent) is declined. It is
 * deliberately not a value any real Unit projection can produce, so it can never
 * collide with a content digest (R4.9). Exported so the orchestrator's reconcile
 * phase can recognize a dismissed server deletion with the same sentinel the
 * decline path records (R4.9, R4.10).
 *
 * @type {string}
 */
export const DISMISSED_DELETION_DIGEST = '\u0000deleted-incoming';

/**
 * Canonical dismissal digest for a retained incoming version at its own
 * granularity — the single source of truth shared by the decline path
 * ({@link declineReview}) and the orchestrator's reconcile phase, so a version
 * dismissed by a decline is recognized as the SAME version when a later cycle
 * re-pulls it (R4.9, R4.10).
 *
 *   - a recording-level incoming version → {@link digestRecording} (matches the
 *     `digestIncoming` the Conflict_Detector computes for that recording);
 *   - a project-level incoming version → {@link digestProject};
 *   - an absent incoming version (a `deleted-remote-review`) → the stable
 *     {@link DISMISSED_DELETION_DIGEST} sentinel.
 *
 * @param {import('./sync-types.js').UnitCopy | null | undefined} incoming - the retained incoming version, or null for a deletion
 * @param {string|null} recording_id - the Unit's recording id, or null for a project-level Unit
 * @returns {string} the canonical dismissal digest
 */
export function incomingDismissalDigest(incoming, recording_id) {
  if (incoming == null) return DISMISSED_DELETION_DIGEST;
  return recording_id == null ? digestProject(incoming) : digestRecording(incoming);
}

/**
 * Decline a Review-and-Accept item: keep the local version, record the declined
 * incoming version as dismissed, and retain the incoming Sync_Snapshot for later
 * recovery (R4.8, R4.9, R4.10, R12.5). Declining advances NO baseline (R1.8) and
 * pushes NOTHING — it is a dismissal, never a way to overwrite the server change
 * with the local version (R4.8).
 *
 * The local `projects` are returned unchanged (the incoming change is never
 * applied) and the project-level retained `Sync_Snapshot` is left in place, so
 * the declined incoming change stays recoverable. Before the Review item is
 * cleared (R12.5), the canonical digest of the declined incoming version is
 * recorded in `dismissedIncoming` (R4.9) so a later cycle that pulls the SAME
 * incoming version does not re-offer it as a fresh Review item; a later cycle
 * that pulls a DIFFERENT incoming version finds no digest match and classifies it
 * afresh (R4.10). `snapshots` is intentionally not touched. The retained
 * recoverable version is surfaced on the result for the caller's recovery
 * affordances — the project-level snapshot when one was retained on pull,
 * otherwise the item's own incoming copy.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState; its
 *   `reviews` and `dismissedIncoming` maps are mutated in place on success
 *   (snapshots are preserved)
 * @param {object[]} projects - the local projects array (returned unchanged)
 * @param {import('./sync-types.js').UnitRef} unitRef - the Unit to decline
 * @returns {ResolutionResult}
 */
export function declineReview(state, projects, unitRef) {
  const currentProjects = Array.isArray(projects) ? projects : [];

  // Routing guard (R12.4): act only on a Review item.
  const kind = itemKind(state, unitRef);
  if (kind !== 'review') {
    return {
      ok: false,
      kind,
      reason: kind === null ? 'not-found' : 'wrong-interface',
      item: kind === 'conflict' ? state.conflicts[unitRef] : null,
      projects: currentProjects,
    };
  }

  const item = state.reviews[unitRef];

  // The declined incoming change must stay recoverable (R4.8). The retained
  // project-level Sync_Snapshot is the durable recovery point; fall back to the
  // item's own incoming copy when no project snapshot was retained. Neither is
  // removed here — only the Review item is cleared.
  const retained = (state.snapshots && state.snapshots[item.project_id]) ?? item.incoming ?? null;

  // Compute the dismissal digest from the item BEFORE clearing it (the item is
  // captured above, so the digest survives the clear).
  const declinedDigest = dismissedIncomingDigest(item);

  // Keep the local version unchanged; do NOT push and do NOT advance the baseline
  // (R4.8, R1.8). Clear the Review item FIRST: `clearItem` returns the Unit fully
  // to NONE, which also wipes any prior dismissed-incoming marker for it (R12.5).
  clearItem(state, unitRef);

  // Record the declined incoming version as dismissed AFTER the clear, so the
  // dismissal survives and the same incoming version is not re-offered next cycle
  // (R4.9, R4.10). Recording before the clear would be immediately wiped by
  // `clearItem`'s R12.5 dismissal-clearing clause.
  recordDismissedIncoming(state, unitRef, declinedDigest);

  return { ok: true, kind: 'review', reason: null, item, projects: currentProjects, retained };
}

// ─── Conflict resolution (resolveConflict) ────────────────────────────────────

/**
 * Deletion sentinel for {@link resolveConflict}. Passing a `resolvedState` whose
 * `deleted` flag is `true` selects the "accept the deletion" outcome of a
 * delete-vs-change Conflict: the Unit is removed from `projects` and cleared from
 * the adopted baseline (R19.5).
 *
 * Detection is by the `deleted === true` flag, NOT by object identity, so a
 * caller may pass this frozen constant or any `{ deleted: true }`-shaped value
 * (e.g. one rebuilt after a structured-clone across a message boundary). A
 * recording/project copy never carries a top-level `deleted` flag (only its
 * individual step records do), so the sentinel can never be mistaken for a
 * chosen resolved state.
 *
 * Resolution NEVER defaults to a deletion: an absent `resolvedState` is rejected
 * as `no-resolution`, so the keep-vs-delete choice for a delete-vs-change
 * Conflict is always explicit and defaults to neither (R19.5).
 *
 * @type {{ deleted: true }}
 */
export const DELETE_RESOLUTION = Object.freeze({ deleted: true });

/**
 * Collect the set of step-record `uuid`s contained in a {@link UnitCopy}, across
 * both granularities: a recording copy's own `steps`, and every recording's
 * `steps` inside a project copy. Step `uuid`s are globally unique (UUIDv7), so a
 * single flat set is a faithful identity for "which committed step records this
 * version contains" regardless of which recording a record sits in.
 *
 * This is the basis of the append-only safety check: a resolved state is safe to
 * adopt only when it RETAINS every step record present in the conflicting
 * histories (R11.1) — the append-only model never drops a version record, it
 * only changes which record is the active version per `logical_id`.
 *
 * @param {import('./sync-types.js').UnitCopy | null | undefined} unitCopy
 * @returns {Set<string>}
 */
function collectStepUuids(unitCopy) {
  const uuids = new Set();
  if (!unitCopy || typeof unitCopy !== 'object') return uuids;
  if (Array.isArray(unitCopy.steps)) {
    for (const step of unitCopy.steps) {
      if (step && step.uuid != null) uuids.add(step.uuid);
    }
  }
  if (Array.isArray(unitCopy.recordings)) {
    for (const recording of unitCopy.recordings) {
      if (recording && Array.isArray(recording.steps)) {
        for (const step of recording.steps) {
          if (step && step.uuid != null) uuids.add(step.uuid);
        }
      }
    }
  }
  return uuids;
}

/**
 * Derive the Active View of every recording in a resolved {@link UnitCopy} via
 * {@link resolveActiveSteps}, the same function the rest of Docent uses (R11.1).
 * Running the chosen state through `resolveActiveSteps` is what gives append-only
 * resolution its two structural guarantees for free: the view is the latest
 * non-deleted version per `logical_id`, so it holds at most one active step per
 * `logical_id` (R11.3) and any step tombstoned in the chosen state stays
 * tombstoned and absent from the view (R11.2).
 *
 * Returns `true` when the active view of every resolved recording can be derived,
 * and `false` when a resolved recording is structurally malformed (its `steps` is
 * not an array, so an Active View cannot be expressed) — which the caller treats
 * as an `apply-failed` abort rather than committing an inadmissible state.
 *
 * @param {import('./sync-types.js').UnitCopy} resolvedCopy - the chosen resolved state
 * @param {boolean} isRecordingLevel - true when the copy is a recording, false for a project
 * @returns {boolean}
 */
function canDeriveActiveView(resolvedCopy, isRecordingLevel) {
  try {
    if (isRecordingLevel) {
      if (!Array.isArray(resolvedCopy.steps)) return false;
      resolveActiveSteps(resolvedCopy);
      return true;
    }
    const recordings = Array.isArray(resolvedCopy.recordings) ? resolvedCopy.recordings : [];
    for (const recording of recordings) {
      if (!recording || !Array.isArray(recording.steps)) return false;
      resolveActiveSteps(recording);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a copy of `project` with the recording matching `recording_id` removed.
 * The project object and its `recordings` array are rebuilt (never mutated in
 * place) so a caller's prior reference stays intact. Used to express "accept the
 * deletion" of a recording as the adopted project state for the baseline (R19.5).
 *
 * @param {object} project
 * @param {string} recording_id
 * @returns {object} a new project object without the named recording
 */
function removeRecordingFromProject(project, recording_id) {
  const recordings = Array.isArray(project.recordings) ? project.recordings : [];
  return {
    ...project,
    recordings: recordings.filter(
      (recording) => !(recording && recording.recording_id === recording_id),
    ),
  };
}

/**
 * Resolve a Conflict by adopting the user's explicitly chosen resolved state for
 * a diverged (or delete-vs-change) Unit. This is the ONLY place a conflicted
 * Unit's local data is changed, and it acts only on an explicit user choice — it
 * never runs during a sync cycle and never auto-decides an outcome (R5.4, R11.4,
 * R11.5, R19.5).
 *
 * The caller supplies `resolvedState`, the state the user chose:
 *   - **Keep / merge** — a recording copy (recording-level Conflict) or a project
 *     copy (project-level Conflict) whose committed `steps` history is the chosen
 *     resolution, expressed through the latest active version per `logical_id`
 *     over an APPEND-ONLY history. The user encodes their per-`logical_id` choice
 *     by which record is the active (latest-`uuid`) version; they NEVER express it
 *     by dropping records. Accordingly the chosen state must RETAIN every step
 *     record present in both conflicting histories — it must be an append-only
 *     superset of the local and incoming versions. A state that would drop a
 *     record is rejected as `not-appendable`, because adopting it would lose a
 *     version (R11.1, R11.4, R11.5, R9.4). "Keep the changed version" in a
 *     delete-vs-change Conflict is just this path with the surviving version as
 *     the chosen state.
 *   - **Accept the deletion** — the {@link DELETE_RESOLUTION} sentinel (any value
 *     with `deleted === true`). The Unit is removed from `projects` and the
 *     baseline advances **per-unit** to the resolved-against incoming version
 *     (or the entry is removed when that side is a deletion) (R1.4, R1.9, R19.5).
 *
 * In every case the baseline advances to the **resolved-against incoming
 * version** (`item.incoming`), applied **per-unit** — NOT to the adopted
 * keep/merge/delete state (R1.4, R1.9). A recording-level resolution touches only
 * that recording's baseline entry (siblings untouched), removing it when the
 * resolved-against incoming side is a deletion (R1.10); a project-level resolution
 * advances (or clears) the whole project baseline. Consequently a keep-incoming
 * choice reads as `already-converged` next cycle (nothing pushed), a keep-local or
 * merge choice reads as `changed-local-outgoing` (pushed), and a delete-vs-change
 * keep-survivor reads as local-new (pushed, re-propagating the survivor) — and a
 * server that moved again re-classifies as a fresh Conflict (R20.5, R18.3).
 * Resolution itself pushes nothing (R20.5).
 *
 * Resolution defaults to NEITHER: an absent `resolvedState` is rejected as
 * `no-resolution` without touching state, so the choice is always explicit
 * (R11.4, R11.5, R19.5).
 *
 * Ordering for atomicity (R5.5, R9.4, R12.5, R12.6): the routing guard, the
 * explicit-input check, the recoverable clone of the chosen state, the
 * append-only superset check, and the Active-View derivation all run BEFORE any
 * part of `state` or `projects` is mutated. If any of them fails the resolution
 * aborts with the store and projects left entirely unchanged and the Conflict
 * still pending — recoverability of both versions is therefore guaranteed before
 * the baseline is advanced and the item cleared. On the keep path both versions
 * remain recoverable AFTER resolution because the adopted append-only history is
 * a superset of both (R9.3); the retained incoming Sync_Snapshot, when present,
 * is surfaced on the result as an additional recovery handle.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState; its
 *   `baselines` and `conflicts` maps are mutated in place only on success
 * @param {object[]} projects - the local projects array (never mutated in place)
 * @param {import('./sync-types.js').UnitRef} unitRef - the Unit to resolve
 * @param {(import('./sync-types.js').UnitCopy | { deleted: true } | null)} resolvedState
 *   the chosen resolved state, the {@link DELETE_RESOLUTION} sentinel, or null/
 *   undefined to reject as `no-resolution`
 * @param {{ now?: () => number }} [options] - clock source for the baseline stamp
 *   (injectable for tests); defaults to `Date.now`
 * @returns {ResolutionResult}
 */
export function resolveConflict(state, projects, unitRef, resolvedState, options = {}) {
  const now = options.now ?? Date.now;
  const currentProjects = Array.isArray(projects) ? projects : [];

  // 1. Routing guard (R12.4): act only on a Conflict item.
  const kind = itemKind(state, unitRef);
  if (kind !== 'conflict') {
    return {
      ok: false,
      kind,
      reason: kind === null ? 'not-found' : 'wrong-interface',
      item: kind === 'review' ? state.reviews[unitRef] : null,
      projects: currentProjects,
    };
  }

  const item = state.conflicts[unitRef];
  const isRecordingLevel = item.recording_id != null;

  // 2. Require an explicit choice (R11.4, R11.5, R19.5): resolution never defaults
  //    to keep or delete, so an absent resolved state is rejected unchanged.
  if (resolvedState == null) {
    return {
      ok: false,
      kind: 'conflict',
      reason: 'no-resolution',
      item,
      projects: currentProjects,
    };
  }

  // The retained incoming Sync_Snapshot (landed on pull) stays in place through
  // resolution and is surfaced as a recovery handle (R9.3). It is never cleared
  // here — only the Conflict item is cleared on success.
  const retained = (state.snapshots && state.snapshots[item.project_id]) ?? null;

  // ── Accept-the-deletion path (R19.5) ────────────────────────────────────────
  if (resolvedState.deleted === true) {
    // The local project (when present) is the metadata source for a per-unit
    // baseline advance; a delete-vs-change Conflict keeps the project present on
    // both sides, so it is normally found.
    const localProject =
      currentProjects.find((project) => project && project.project_id === item.project_id) ?? null;

    if (isRecordingLevel) {
      // Remove the recording from its project (idempotent if already absent).
      const index = currentProjects.findIndex(
        (project) => project && project.project_id === item.project_id,
      );
      let nextProjects = currentProjects;
      if (index >= 0) {
        const adoptedProject = removeRecordingFromProject(
          currentProjects[index],
          item.recording_id,
        );
        nextProjects = currentProjects.map((project, i) =>
          i === index ? adoptedProject : project,
        );
      }
      // Advance the baseline PER-UNIT to the RESOLVED-AGAINST INCOMING version,
      // not to the adopted (deletion) state (R1.4, R1.9): set the recording's
      // baseline entry to `item.incoming`, or REMOVE it when the resolved-against
      // incoming side is itself a deletion (R1.10) so the settled deletion (or
      // the kept survivor) reads correctly on the next cycle. Siblings untouched.
      advanceRecordingBaselineEntry(
        state,
        item.project_id,
        item.recording_id,
        item.incoming,
        localProject,
        now,
      );
      clearItem(state, unitRef);
      return {
        ok: true,
        kind: 'conflict',
        reason: null,
        item,
        projects: nextProjects,
        removed: true,
        retained,
      };
    }

    // Project-level deletion: remove the whole project locally. Advance the
    // project baseline PER-UNIT to the resolved-against incoming project, or
    // clear it when the resolved-against incoming side is a deletion (R1.4, R1.9).
    const nextProjects = currentProjects.filter(
      (project) => !(project && project.project_id === item.project_id),
    );
    advanceProjectBaselineEntry(state, item.project_id, item.incoming, now);
    clearItem(state, unitRef);
    return {
      ok: true,
      kind: 'conflict',
      reason: null,
      item,
      projects: nextProjects,
      removed: true,
      retained,
    };
  }

  // ── Keep / merge path: adopt the chosen resolved state ──────────────────────

  // Build a recoverable copy of the chosen state BEFORE any mutation. A state
  // that cannot be retained (not JSON-serializable) aborts as `apply-failed`
  // with the store and projects unchanged (R9.4, R12.6).
  let resolvedCopy;
  try {
    resolvedCopy = deepCopy(resolvedState);
  } catch {
    return { ok: false, kind: 'conflict', reason: 'apply-failed', item, projects: currentProjects };
  }

  // Structural check: the chosen state must carry the history at the right
  // granularity (a recording's `steps` / a project's `recordings`). A malformed
  // chosen state aborts unchanged (R12.6).
  if (
    isRecordingLevel ? !Array.isArray(resolvedCopy.steps) : !Array.isArray(resolvedCopy.recordings)
  ) {
    return { ok: false, kind: 'conflict', reason: 'apply-failed', item, projects: currentProjects };
  }

  // Append-only safety (R11.1, R11.5): the chosen state must retain every step
  // record present in BOTH conflicting histories. Dropping any record would lose
  // a version, so such a state is rejected as `not-appendable` and the Conflict
  // is left unresolved (R9.4). Histories are never auto-unioned here — the caller
  // supplies the explicit superset that encodes the user's per-`logical_id`
  // active-version choice (R11.4, R11.5).
  const present = collectStepUuids(resolvedCopy);
  for (const uuid of collectStepUuids(item.local)) {
    if (!present.has(uuid)) {
      return {
        ok: false,
        kind: 'conflict',
        reason: 'not-appendable',
        item,
        projects: currentProjects,
      };
    }
  }
  for (const uuid of collectStepUuids(item.incoming)) {
    if (!present.has(uuid)) {
      return {
        ok: false,
        kind: 'conflict',
        reason: 'not-appendable',
        item,
        projects: currentProjects,
      };
    }
  }

  // Express the resolved state through the latest active version per `logical_id`
  // via resolveActiveSteps (R11.1): this keeps tombstoned steps tombstoned (R11.2)
  // and yields at most one active step per `logical_id` (R11.3). A state whose
  // Active View cannot be derived is malformed and aborts unchanged (R12.6).
  if (!canDeriveActiveView(resolvedCopy, isRecordingLevel)) {
    return { ok: false, kind: 'conflict', reason: 'apply-failed', item, projects: currentProjects };
  }

  // Build the adopted full-project state from the recoverable copy.
  let adoptedProject;
  let nextProjects;
  if (isRecordingLevel) {
    const index = currentProjects.findIndex(
      (project) => project && project.project_id === item.project_id,
    );
    if (index < 0) {
      // No local project to apply the resolved recording into — cannot adopt
      // without risking an inconsistent state, so abort unchanged (R12.6).
      return {
        ok: false,
        kind: 'conflict',
        reason: 'apply-failed',
        item,
        projects: currentProjects,
      };
    }
    adoptedProject = applyRecordingToProject(currentProjects[index], resolvedCopy);
    nextProjects = currentProjects.map((project, i) => (i === index ? adoptedProject : project));

    // Advance the baseline PER-UNIT to the RESOLVED-AGAINST INCOMING version
    // (R1.4, R1.9) — NOT to the adopted (kept/merged) state. For a keep-incoming
    // choice the incoming version equals the adopted state, so the Unit becomes
    // `already-converged` next cycle and nothing is pushed; for a keep-local or
    // merge choice the adopted state differs from `item.incoming`, so the Unit
    // reads as `changed-local-outgoing` next cycle and is pushed (R20.5). When the
    // resolved-against incoming side is a deletion (`item.incoming == null`, the
    // keep-survivor path of a delete-vs-change Conflict), the recording's baseline
    // entry is REMOVED so the kept survivor reads as local-new and is re-pushed
    // (R1.10). Sibling baseline entries are untouched.
    advanceRecordingBaselineEntry(
      state,
      item.project_id,
      item.recording_id,
      item.incoming,
      adoptedProject,
      now,
    );
  } else {
    adoptedProject = resolvedCopy;
    const index = currentProjects.findIndex(
      (project) => project && project.project_id === item.project_id,
    );
    nextProjects =
      index >= 0
        ? currentProjects.map((project, i) => (i === index ? adoptedProject : project))
        : [...currentProjects, adoptedProject];

    // Project-level Unit: advance the whole project baseline to the resolved-
    // against incoming project, or clear it when the resolved-against incoming
    // side is a deletion (R1.4, R1.9).
    advanceProjectBaselineEntry(state, item.project_id, item.incoming, now);
  }

  // Clear the Conflict only now that adoption is guaranteed to succeed (R12.5).
  // Resolution pushes nothing; the adopted state propagates on the next cycle
  // (R20.5).
  clearItem(state, unitRef);

  return { ok: true, kind: 'conflict', reason: null, item, projects: nextProjects, retained };
}

// ─── Keep-a-side resolution builder (for the local-vs-incoming chooser) ───────

/**
 * Merge the full step histories of two recording versions into a single
 * append-only history that RETAINS every record from both sides, with `keep`'s
 * records placed first. Used so a "keep this side" resolution never drops a
 * version record from the other side (R11.1) — the chooser adopts one side's
 * narrative while both histories remain recoverable (R9.3).
 *
 * @param {object[]} keepSteps - the chosen side's step records (placed first)
 * @param {object[]} otherSteps - the other side's step records
 * @returns {object[]} the append-only union (deduped by `uuid`)
 */
function mergeStepHistories(keepSteps, otherSteps) {
  const present = new Set();
  const merged = [];
  for (const step of [...(keepSteps ?? []), ...(otherSteps ?? [])]) {
    if (!step || step.uuid == null || present.has(step.uuid)) continue;
    present.add(step.uuid);
    merged.push(step);
  }
  return merged;
}

/**
 * For each `logical_id` in the chosen side's Active View, re-stamp that active
 * record with a FRESH `uuid` so it becomes the globally-latest version of its
 * logical step in the merged history. This is what makes "keep this side"
 * actually win: `resolveActiveSteps` selects the active version per `logical_id`
 * by highest `uuid` regardless of array order (see lib/session.js), so without
 * re-stamping, whichever side happened to have the higher original `uuid` would
 * win — which could silently surface the OTHER side's content. Re-stamping
 * follows the same append-only pattern as `deleteStep`/`reorderSteps`: it appends
 * a new version record rather than mutating or dropping any existing record, so
 * the other side's records stay recoverable (R9.3, R11.1) but the chosen side's
 * narrative is the Active View (R11.4 — the user's explicit per-`logical_id`
 * choice).
 *
 * Tombstones in the chosen Active View are preserved as tombstones in their fresh
 * record so a deleted step stays deleted (R11.2). Records whose `logical_id` is
 * not in the chosen Active View are left as-is (they are superseded history).
 *
 * @param {object[]} mergedSteps - the append-only union of both histories
 * @param {object[]} keepActiveSteps - the chosen side's Active View records
 * @param {() => string} newId - id source (injectable for tests); defaults to uuidv7
 * @returns {object[]} the history with fresh winning records appended
 */
function restampWinningActiveSteps(mergedSteps, keepActiveSteps, newId) {
  const winners = [];
  for (const active of keepActiveSteps) {
    winners.push({ ...active, uuid: newId() });
  }
  return [...mergedSteps, ...winners];
}

/**
 * Build the explicit, append-only resolved state for a "keep `keep`" outcome of a
 * Conflict — the resolved state the local-vs-incoming chooser supplies to
 * {@link resolveConflict} (R11.4, R11.5, R19.5). The result:
 *
 *   - RETAINS every step record from BOTH the kept and the other side, so it is
 *     an append-only superset that `resolveConflict` will accept and both
 *     versions stay recoverable (R9.3, R11.1);
 *   - makes the KEPT side's Active View the resolved Active View by appending a
 *     fresh-`uuid` winning record per kept-active `logical_id` (see
 *     {@link restampWinningActiveSteps}), so keeping a side never silently adopts
 *     the other side's content even when the other side had higher original
 *     `uuid`s;
 *   - preserves tombstones from the kept side (R11.2).
 *
 * A recording-level Conflict folds over the single recording; a project-level
 * Conflict folds per recording across the UNION of recordings on both sides
 * (recordings present only on the other side are retained intact so no recording
 * is lost). When the kept side is absent (`null`, the deletion side of a
 * delete-vs-change Conflict), the caller should instead pass
 * {@link DELETE_RESOLUTION} to `resolveConflict`; this builder returns `keep`
 * unchanged for a `null` other side (nothing to merge).
 *
 * @param {import('./sync-types.js').UnitCopy} keep - the side to adopt
 * @param {import('./sync-types.js').UnitCopy | null | undefined} other - the other side
 * @param {{ newId?: () => string }} [options] - id source for the winning records
 *   (injectable for tests); defaults to uuidv7
 * @returns {import('./sync-types.js').UnitCopy} the append-only resolved state
 */
export function buildKeepResolution(keep, other, options = {}) {
  const newId = options.newId ?? uuidv7;
  if (!keep || !other) return keep;

  // Recording-level Unit.
  if (Array.isArray(keep.steps)) {
    const merged = mergeStepHistories(keep.steps, other.steps ?? []);
    const keepActive = resolveActiveStepsForCopy(keep);
    return { ...keep, steps: restampWinningActiveSteps(merged, keepActive, newId) };
  }

  // Project-level Unit: fold per recording across the union of both sides.
  if (Array.isArray(keep.recordings)) {
    const otherById = new Map((other.recordings ?? []).map((r) => [r.recording_id, r]));
    const seen = new Set();
    const recordings = keep.recordings.map((rec) => {
      seen.add(rec.recording_id);
      const otherRec = otherById.get(rec.recording_id);
      if (!otherRec) return rec;
      const merged = mergeStepHistories(rec.steps ?? [], otherRec.steps ?? []);
      const keepActive = resolveActiveStepsForCopy(rec);
      return { ...rec, steps: restampWinningActiveSteps(merged, keepActive, newId) };
    });
    // Retain recordings that exist only on the other side so no version is lost.
    for (const otherRec of other.recordings ?? []) {
      if (!seen.has(otherRec.recording_id)) recordings.push(otherRec);
    }
    return { ...keep, recordings };
  }

  return keep;
}

/**
 * The Active View of a recording-shaped copy, tolerating a malformed `steps`
 * (returns an empty view rather than throwing) so the keep-resolution builder is
 * total over any stored copy.
 *
 * @param {{steps?: object[]}} recordingCopy
 * @returns {object[]}
 */
function resolveActiveStepsForCopy(recordingCopy) {
  if (!recordingCopy || !Array.isArray(recordingCopy.steps)) return [];
  try {
    return resolveActiveSteps(recordingCopy);
  } catch {
    return [];
  }
}
