/**
 * conflict-detector.js — Graded classification (the Conflict_Detector)
 *
 * The Conflict_Detector classifies each Unit (a Project, and each Recording
 * within it) on pull, against the project's last mutually-agreed Sync_Baseline,
 * into exactly one of the classifications in {@link ClassKind}. Classification
 * is the safe-vs-ask decision point of the whole feature: it decides what the
 * orchestrator may apply automatically (auto-add a brand-new unit, advance a
 * baseline on agreement, propagate an agreed deletion) versus what must be
 * deferred to the user (Review-and-Accept for an incoming change to an existing
 * recording, a Conflict for a divergence or a delete-vs-change).
 *
 * This module is PURE LOGIC (R2.9, R10.2). `classifyProject` takes only data —
 * the local project, the incoming (pulled) project, the per-project
 * {@link BaselineRecord}, and the set of locked recording ids — and returns
 * {@link UnitClassification} records. It performs no I/O, invokes no user-input
 * hook, and is deterministic: identical inputs always yield identical output, so
 * the Chrome extension and the desktop app classify identically (R2.11, R17.3).
 *
 * ── Content identity, not timestamps ────────────────────────────────────────
 * Against an opaque last-write-wins server, `last_modified` is unreliable, so
 * classification compares canonical CONTENT DIGESTS (see sync-digest.js). A
 * Unit's name and metadata are folded into its digest, so a name-only or
 * metadata-only change is classified by the same rules as any other change
 * (R2.10).
 *
 * ── Unit decomposition ──────────────────────────────────────────────────────
 * A project is reconciled at two granularities so each outcome is unambiguous
 * and never double-counted:
 *
 *   - Whole-project lifecycle. When a project is brand-new, deleted on a side,
 *     or fully converged, the whole project is one Unit (full `digestProject`):
 *     a brand-new project is auto-added with all its recordings; a deleted
 *     project is removed with all its recordings; a fully-converged project
 *     advances/repairs its baseline (R1.3, R2.2, R2.3, R19).
 *
 *   - Sub-units, when the project is present on BOTH sides but differs. Then the
 *     project decomposes into:
 *       • a project-metadata Unit (name + metadata only, recordings excluded),
 *         so a project metadata change is classified independently of any
 *         recording change (R2.8); and
 *       • one Unit per recording (`digestRecording`), so each recording is
 *         reconciled on its own.
 *     This keeps the units DISJOINT — the project-metadata digest and each
 *     recording digest measure non-overlapping slices of content — which is what
 *     lets a single recording change become exactly one recording-level outcome
 *     rather than also dragging the whole project into a deferral.
 *
 * ── Precedence (R2.9) ───────────────────────────────────────────────────────
 * For every Unit the decision table in {@link classifyUnit} applies the most
 * specific match in this order, encoded by evaluation order:
 *   1. `locked-skipped`            — a locked recording is never touched (R6.3)
 *   2. `already-converged`         — local and incoming present and equal,
 *                                    regardless of baseline (R2.2)
 *   3. deletion cases              — a side absent but the Unit is present in the
 *                                    baseline: `deleted-local-clean` (R19.1),
 *                                    `deleted-both` (R19.7),
 *                                    `deleted-remote-review` (R19.3),
 *                                    `conflict-delete-vs-change` (R19.2, R19.5)
 *   4. `brand-new`                 — no local counterpart and no baseline (R2.3)
 *   5. `changed-incoming`          — local == baseline, incoming differs (R2.4)
 *   6. `changed-local-outgoing`    — incoming == baseline, local differs ⇒ a
 *                                    routine outgoing change to push, never a
 *                                    deferral (R2.5, R21)
 *   7. `diverged`                  — both present and differing, both differ
 *                                    from the baseline, OR there is no baseline
 *                                    and local != incoming (R2.6, R2.7), which
 *                                    also covers the concurrent-push case where a
 *                                    second client overwrote the server copy from
 *                                    a common baseline (R18.1)
 *
 * The local-counterpart change cases (steps 5–6) and `diverged` (step 7) are
 * exactly the cases in which the Unit is present on both sides; their order is
 * what distinguishes a one-sided change (only local moved, or only incoming
 * moved) from a both-sides divergence.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { digestProject, digestRecording, digestProjectMetadata } from './sync-digest.js';
import { getRecordingBaselineDigest } from './sync-baseline.js';

/**
 * The pure decision table over a Unit's three content digests. Returns the one
 * {@link ClassKind} that applies, following the precedence in R2.9 (encoded by
 * evaluation order). Any of the digests may be `null`: a `null` local digest
 * means the Unit has no local counterpart, a `null` incoming digest means it is
 * absent on the server side, and a `null` baseline digest means there is no
 * last-agreed state for it (R1.6).
 *
 * This function has no notion of projects vs recordings — it is the shared core
 * applied to every Unit at every granularity — which is what guarantees
 * identical, deterministic classification across platforms (R2.11, R17.3).
 *
 * @param {string|null} digestLocal - digest of the local version, or null if absent
 * @param {string|null} digestIncoming - digest of the incoming version, or null if absent
 * @param {string|null} digestBaseline - digest from the baseline, or null if none (R1.6)
 * @param {boolean} [locked=false] - true when this Unit is a Locked_Recording (R6.3)
 * @returns {import('./sync-types.js').ClassKind}
 */
export function classifyUnit(digestLocal, digestIncoming, digestBaseline, locked = false) {
  // 1. A locked recording is excluded from the merge regardless of any other
  //    signal — highest precedence (R6.3).
  if (locked) return 'locked-skipped';

  const hasLocal = digestLocal != null;
  const hasIncoming = digestIncoming != null;
  const hasBaseline = digestBaseline != null;

  // 2. already-converged: both sides present and equal, regardless of the
  //    baseline — identical content means the sides agree even if neither
  //    matches the recorded baseline (R2.2).
  if (hasLocal && hasIncoming && digestLocal === digestIncoming) {
    return 'already-converged';
  }

  // 3a. Absent locally but present in the baseline ⇒ a deliberate LOCAL deletion
  //     (the data model has no recording/project tombstone), never brand-new (R19).
  if (!hasLocal && hasBaseline) {
    // Incoming unchanged from the agreed state ⇒ propagate the deletion (R19.1).
    if (digestIncoming === digestBaseline) return 'deleted-local-clean';
    // Gone on both sides ⇒ the deletion is agreed (R19.7).
    if (!hasIncoming) return 'deleted-both';
    // Deleted locally, changed on the server ⇒ delete-vs-change Conflict (R19.2).
    return 'conflict-delete-vs-change';
  }

  // 3b. Absent on the server but present in the baseline ⇒ a SERVER deletion (R19).
  if (!hasIncoming && hasBaseline) {
    // Local unchanged from the agreed state ⇒ review the deletion (R19.3).
    if (digestLocal === digestBaseline) return 'deleted-remote-review';
    // Deleted on the server, changed locally ⇒ delete-vs-change Conflict (R19.5).
    return 'conflict-delete-vs-change';
  }

  // 4. No local counterpart and no baseline counterpart ⇒ genuinely new,
  //    never previously agreed (R2.3).
  if (!hasLocal) {
    return 'brand-new';
  }

  // 5. Local still matches the baseline while the incoming version moved ⇒ an
  //    incoming change to an unchanged local recording (R2.4).
  if (hasBaseline && digestLocal === digestBaseline && digestIncoming !== digestBaseline) {
    return 'changed-incoming';
  }

  // 6. Incoming still matches the baseline while the local version moved ⇒ a
  //    routine outgoing change: the local side moved, the server is still at the
  //    last-agreed state. Pushed automatically, never deferred (R2.5, R21).
  if (hasBaseline && digestIncoming === digestBaseline && digestLocal !== digestBaseline) {
    return 'changed-local-outgoing';
  }

  // 7. Both sides present and differing, with both diverging from the baseline,
  //    OR no baseline at all (local != incoming with no last-agreed state to
  //    attribute the change to either side) ⇒ both sides moved / unknowable,
  //    treated as divergence (R2.6, R2.7), including the concurrent-push
  //    overwrite case (R18.1).
  return 'diverged';
}

/**
 * Collect the de-duplicated, deterministically-ordered list of `recording_id`s
 * present across the given projects (local first, then incoming, then the agreed
 * baseline). Order is derived solely from the inputs, so the enumeration — and
 * therefore `classifyProject`'s output order — is deterministic (R2.11, R17.3).
 *
 * @param {...(object|null)} projects - projects to scan, in priority order
 * @returns {string[]} unique recording ids in first-seen order
 */
function collectRecordingIds(...projects) {
  const ids = [];
  const seen = new Set();
  for (const project of projects) {
    const recordings = Array.isArray(project?.recordings) ? project.recordings : [];
    for (const recording of recordings) {
      const id = recording?.recording_id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Find a recording by id within a project, or null when absent (or when the
 * project itself is absent).
 *
 * @param {object|null} project
 * @param {string} recording_id
 * @returns {object|null}
 */
function findRecording(project, recording_id) {
  const recordings = Array.isArray(project?.recordings) ? project.recordings : [];
  return (
    recordings.find((recording) => recording && recording.recording_id === recording_id) ?? null
  );
}

/**
 * Build a {@link UnitClassification} record. `recording_id` is `null` for a
 * project-level Unit, in which case the `unitRef` is just the `project_id`;
 * otherwise the `unitRef` is `"<project_id>:<recording_id>"` (R10.3 keying).
 *
 * @param {string} project_id
 * @param {string|null} recording_id
 * @param {import('./sync-types.js').ClassKind} kind
 * @param {string|null} digestLocal
 * @param {string|null} digestIncoming
 * @param {string|null} digestBaseline
 * @returns {import('./sync-types.js').UnitClassification}
 */
function makeClassification(
  project_id,
  recording_id,
  kind,
  digestLocal,
  digestIncoming,
  digestBaseline,
) {
  const unitRef = recording_id == null ? project_id : `${project_id}:${recording_id}`;
  return { unitRef, project_id, recording_id, kind, digestLocal, digestIncoming, digestBaseline };
}

/**
 * Classify one project and the recordings within it against its Sync_Baseline.
 *
 * Returns one {@link UnitClassification} per Unit that needs the orchestrator to
 * act or to record agreement. The result is the input to every automatic and
 * deferred outcome the orchestrator applies; it never mutates its arguments and
 * never performs I/O (R2.9, R10.2).
 *
 * What is returned, by case:
 *   - Whole-project converged (both present, full digests equal) ⇒ a single
 *     project-level `already-converged` (so the baseline is advanced/repaired,
 *     R1.3, R2.2). No sub-units are emitted.
 *   - A side is absent (deletion or brand-new project) ⇒ a single project-level
 *     classification from the decision table (R2.3, R19). No sub-units are
 *     emitted: a brand-new project carries its recordings with it and a deleted
 *     project removes them. A project present only locally with no baseline is
 *     purely local-new work and yields NO classification (it is just pushed).
 *   - Project present on both sides but differing ⇒ a project-metadata Unit
 *     (emitted only when the metadata itself changed, so an unchanged project is
 *     never spuriously treated as converged — the per-project baseline is
 *     repaired only when the WHOLE project converges) plus one Unit per
 *     recording that needs an outcome. A locked recording is always surfaced as
 *     `locked-skipped` so the orchestrator can record that it was excluded
 *     (R6.3); a non-locked recording that needs no action (`already-converged`)
 *     and a recording that exists only locally with no baseline (local-new work)
 *     are omitted.
 *
 * @param {import('./sync-types.js').ProjectCopy | object | null} local - the
 *   local project, or null when there is no local counterpart
 * @param {import('./sync-types.js').ProjectCopy | object | null} incoming - the
 *   pulled project, or null when it is absent on the server side
 * @param {import('./sync-types.js').BaselineRecord | null} baseline - the
 *   per-project baseline (typically from `getBaseline`), or null when none (R1.6)
 * @param {Set<string>} [lockedRecordingIds] - the set of `recording_id`s open in
 *   the Recording_View; each is a Locked_Recording excluded from the merge (R6.3)
 * @returns {import('./sync-types.js').UnitClassification[]}
 */
export function classifyProject(local, incoming, baseline, lockedRecordingIds) {
  const locked = lockedRecordingIds instanceof Set ? lockedRecordingIds : new Set();
  const results = [];

  const localPresent = local != null;
  const incomingPresent = incoming != null;
  const hasBaseline = baseline != null;

  const project_id =
    local?.project_id ?? incoming?.project_id ?? baseline?.agreedState?.project_id ?? null;
  const baselineDigest = hasBaseline ? (baseline.digest ?? null) : null;

  // ── (1) Whole-project convergence ──────────────────────────────────────────
  // Both sides present and fully equal: the project (metadata AND every
  // recording) agrees, so advance/repair the baseline to this agreed state
  // (R2.2, R1.3). No sub-units are needed.
  if (localPresent && incomingPresent) {
    const fullLocal = digestProject(local);
    const fullIncoming = digestProject(incoming);
    if (fullLocal === fullIncoming) {
      results.push(
        makeClassification(
          project_id,
          null,
          'already-converged',
          fullLocal,
          fullIncoming,
          baselineDigest,
        ),
      );
      return results;
    }
  }

  // ── (2) Whole-project lifecycle when a side is absent ───────────────────────
  // A project absent on one side is a brand-new project (no baseline) or a
  // deliberate deletion (present in the baseline) — handled at whole-project
  // granularity (R2.3, R19). A project present only locally with no baseline is
  // local-new work with nothing inbound to reconcile, so it yields nothing.
  if (!localPresent || !incomingPresent) {
    if (incomingPresent || hasBaseline) {
      const dl = localPresent ? digestProject(local) : null;
      const di = incomingPresent ? digestProject(incoming) : null;
      const kind = classifyUnit(dl, di, baselineDigest, false);
      results.push(makeClassification(project_id, null, kind, dl, di, baselineDigest));
    }
    return results;
  }

  // ── (3) Project present on both sides but differing ⇒ descend ───────────────
  // (a) Project-metadata Unit (recordings excluded). Emitted only when the
  //     metadata changed, so an unchanged project is never reported as converged
  //     here — whole-project convergence (and its baseline repair) is owned by
  //     case (1) above (R2.10).
  const metaLocal = digestProjectMetadata(local);
  const metaIncoming = digestProjectMetadata(incoming);
  const metaBaseline = hasBaseline ? digestProjectMetadata(baseline.agreedState) : null;
  const metaKind = classifyUnit(metaLocal, metaIncoming, metaBaseline, false);
  if (metaKind !== 'already-converged') {
    results.push(
      makeClassification(project_id, null, metaKind, metaLocal, metaIncoming, metaBaseline),
    );
  }

  // (b) Recording-level Units across the union of local, incoming, and agreed
  //     recording ids.
  const baselineProject = hasBaseline ? baseline.agreedState : null;
  for (const recording_id of collectRecordingIds(local, incoming, baselineProject)) {
    const localRec = findRecording(local, recording_id);
    const incomingRec = findRecording(incoming, recording_id);
    const dl = localRec ? digestRecording(localRec) : null;
    const di = incomingRec ? digestRecording(incomingRec) : null;
    const db = getRecordingBaselineDigest(baseline, recording_id);

    // A recording present only locally with no agreed state is local-new work:
    // nothing inbound to reconcile and no baseline indicating a deletion, so it
    // is simply pushed on the outbound phase and not classified here.
    if (di == null && db == null) continue;

    const isLocked = locked.has(recording_id);
    const kind = classifyUnit(dl, di, db, isLocked);

    // Omit a recording that needs no action; a locked recording is `locked-skipped`
    // (not `already-converged`) and is always surfaced so the orchestrator records
    // its exclusion (R6.3).
    if (kind === 'already-converged') continue;

    results.push(makeClassification(project_id, recording_id, kind, dl, di, db));
  }

  return results;
}
