/**
 * classify-decision-table.property.test.js — Property test for the graded
 * classification decision table (the Conflict_Detector).
 *
 * The Conflict_Detector classifies each Unit (a Project, and each Recording
 * within it) on pull, against the project's last mutually-agreed Sync_Baseline,
 * into exactly one ClassKind. The classification is the safe-vs-ask decision
 * point of the whole feature, so it must be:
 *
 *   - TOTAL    — every combination of (local, incoming, baseline) presence and
 *                content-equality, with or without a lock, yields exactly one
 *                valid ClassKind (never undefined, never two).
 *   - CORRECT  — the assigned ClassKind matches the reference decision table and
 *                its precedence (Requirement 2.9): `locked-skipped` first; then
 *                `already-converged`; then the deletion cases (a side absent but
 *                present in the baseline, per Requirement 19); then `brand-new`
 *                (no local counterpart and no baseline); then `changed-incoming`
 *                (local == baseline, incoming differs); then `changed-local-outgoing`
 *                (incoming == baseline, local differs — a routine outgoing change,
 *                R2.5); then `diverged`. The `diverged` fall-through covers both
 *                the no-baseline local≠incoming case (R2.7) and the concurrent-push
 *                case where a second client overwrote the server copy from a common
 *                baseline (Requirement 18.1), so the overwritten client's work is
 *                surfaced rather than silently dropped.
 *
 * The reference decision table below (`referenceClassify`) is an INDEPENDENT
 * re-derivation from Requirements 2 and 19 — it is the oracle the implementation
 * is checked against, not a copy of the implementation.
 *
 * Uses Node.js built-in test runner + fast-check (fast-check v4: no
 * `fc.hexaString` — `fc.uuid()` is used for ids).
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.9, 2.10, 18.1**
 */

// Feature: sync-conflict-resolution, Property 1: Classification decision table is total and correct

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { classifyProject, classifyUnit } from '../../conflict-detector.js';
import { digestProject, digestRecording } from '../../sync-digest.js';

// ─── The exhaustive set of valid classifications (ClassKind) ─────────────────

const VALID_KINDS = new Set([
  'already-converged',
  'brand-new',
  'changed-incoming',
  'changed-local-outgoing',
  'diverged',
  'locked-skipped',
  'deleted-local-clean',
  'deleted-remote-review',
  'deleted-both',
  'conflict-delete-vs-change',
]);

// ─── Reference decision table (the oracle) ───────────────────────────────────

/**
 * Independent re-derivation of the classification decision table from
 * Requirements 2 and 19, applying the R2.9 precedence by evaluation order. Each
 * digest is a content string or `null` (absent). This is the source of truth the
 * implementation is checked against.
 *
 * @param {string|null} dl - local digest, or null if absent
 * @param {string|null} di - incoming digest, or null if absent
 * @param {string|null} db - baseline digest, or null if none (R1.6)
 * @param {boolean} locked - true when this Unit is a Locked_Recording (R6.3)
 * @returns {string}
 */
function referenceClassify(dl, di, db, locked) {
  // R6.3 — a locked recording is excluded from the merge regardless of any
  //        other signal (highest precedence).
  if (locked) return 'locked-skipped';

  const hasLocal = dl != null;
  const hasIncoming = di != null;
  const hasBaseline = db != null;

  // R2.2 — both sides present and equal ⇒ converged, regardless of baseline.
  if (hasLocal && hasIncoming && dl === di) return 'already-converged';

  // R19 — absent locally but present in baseline ⇒ a deliberate LOCAL deletion
  //       (the data model has no recording/project tombstone), never brand-new.
  if (!hasLocal && hasBaseline) {
    if (di === db) return 'deleted-local-clean'; // R19.1 — incoming unchanged ⇒ propagate
    if (!hasIncoming) return 'deleted-both'; // R19.7 — gone on both sides ⇒ agreed
    return 'conflict-delete-vs-change'; // R19.2 — deleted vs changed
  }

  // R19 — absent on the server but present in baseline ⇒ a SERVER deletion.
  if (!hasIncoming && hasBaseline) {
    if (dl === db) return 'deleted-remote-review'; // R19.3 — local unchanged ⇒ review
    return 'conflict-delete-vs-change'; // R19.5 — deleted vs changed
  }

  // R2.3 — no local counterpart and no baseline counterpart ⇒ genuinely new.
  if (!hasLocal) return 'brand-new';

  // R2.4 — local still matches baseline while incoming moved ⇒ review-and-accept.
  if (hasBaseline && dl === db && di !== db) return 'changed-incoming';

  // R2.5 — incoming still matches baseline while local moved ⇒ a routine outgoing
  //        change (the local side moved, the server is still at the last-agreed
  //        state). Pushed automatically, never deferred.
  if (hasBaseline && di === db && dl !== db) return 'changed-local-outgoing';

  // R2.6 / R2.7 / R18.1 — both present and differing, with both differing from the
  //                       baseline, OR no baseline at all (local != incoming with no
  //                       last-agreed state to attribute the change to either side)
  //                       ⇒ both sides moved / unknowable, including the
  //                       concurrent-push overwrite case.
  return 'diverged';
}

// ─── Generators ──────────────────────────────────────────────────────────────

// A small symbol pool for digests so every equality relationship between local,
// incoming and baseline (all equal, two equal, all different) arises frequently,
// plus `null` to exercise the absence (deletion / brand-new) branches.
const arbDigest = fc.constantFrom(null, 'A', 'B', 'C');

// Content variants used to build recordings/projects whose digests are equal iff
// the variant (and id) are equal — lets `classifyProject` compute real digests
// while the test still controls the equality lattice.
const arbVariant = fc.constantFrom('1', '2', '3');

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';

/** Build a recording whose digest is a deterministic function of (id, variant). */
function buildRecording(recording_id, variant) {
  return {
    recording_id,
    name: `rec-name-${variant}`,
    created_at: FIXED_CREATED_AT,
    steps: [
      { uuid: `uuid-${variant}`, logical_id: 'a', step_number: 0, actions: [], deleted: false },
    ],
  };
}

/** Build a project from a name variant and an ordered list of recordings. */
function buildProject(project_id, nameVariant, recordings) {
  return {
    project_id,
    name: `proj-name-${nameVariant}`,
    created_at: FIXED_CREATED_AT,
    recordings,
  };
}

// One recording "slot": a shared recording_id with an independently-chosen
// variant (or absent) on the local side, the incoming side, and the baseline,
// plus whether the recording is locked.
const arbSlot = fc.record({
  recording_id: fc.uuid(),
  local: fc.option(arbVariant, { nil: null }),
  incoming: fc.option(arbVariant, { nil: null }),
  baseline: fc.option(arbVariant, { nil: null }),
  locked: fc.boolean(),
});

// A whole scenario: a shared project_id, per-side presence of the project, a
// per-side project-name variant (to exercise project-metadata classification),
// and a set of recording slots with unique recording_ids.
const arbScenario = fc.record({
  project_id: fc.uuid(),
  localPresent: fc.boolean(),
  incomingPresent: fc.boolean(),
  baselinePresent: fc.boolean(),
  projNameLocal: arbVariant,
  projNameIncoming: arbVariant,
  projNameBaseline: arbVariant,
  slots: fc.uniqueArray(arbSlot, {
    selector: (s) => s.recording_id,
    minLength: 0,
    maxLength: 3,
  }),
});

/** Materialize a scenario into (local, incoming, baseline, lockedRecordingIds). */
function materialize(scenario) {
  const {
    project_id,
    localPresent,
    incomingPresent,
    baselinePresent,
    projNameLocal,
    projNameIncoming,
    projNameBaseline,
    slots,
  } = scenario;

  const recsFor = (side) =>
    slots.filter((s) => s[side] != null).map((s) => buildRecording(s.recording_id, s[side]));

  const local = localPresent ? buildProject(project_id, projNameLocal, recsFor('local')) : null;
  const incoming = incomingPresent
    ? buildProject(project_id, projNameIncoming, recsFor('incoming'))
    : null;
  const baselineProject = baselinePresent
    ? buildProject(project_id, projNameBaseline, recsFor('baseline'))
    : null;
  const baseline = baselineProject
    ? { digest: digestProject(baselineProject), agreedState: baselineProject }
    : null;

  const lockedRecordingIds = new Set(slots.filter((s) => s.locked).map((s) => s.recording_id));

  return { local, incoming, baseline, lockedRecordingIds };
}

// ─── Property 1 ───────────────────────────────────────────────────────────────

describe('Property 1: Classification decision table is total and correct', () => {
  it('classifyUnit assigns exactly one valid ClassKind matching the reference table for every digest/lock combination', () => {
    fc.assert(
      fc.property(arbDigest, arbDigest, arbDigest, fc.boolean(), (dl, di, db, locked) => {
        const kind = classifyUnit(dl, di, db, locked);
        // TOTAL: always a single valid classification.
        assert.ok(VALID_KINDS.has(kind), `classifyUnit produced an invalid kind: ${kind}`);
        // CORRECT: matches the independent reference decision table (incl. R2.7 precedence).
        assert.equal(kind, referenceClassify(dl, di, db, locked));
      }),
      { numRuns: 500 },
    );
  });

  it('classifyUnit is exhaustively correct over the entire (local, incoming, baseline, locked) lattice', () => {
    const pool = [null, 'A', 'B', 'C'];
    for (const dl of pool) {
      for (const di of pool) {
        for (const db of pool) {
          for (const locked of [false, true]) {
            const kind = classifyUnit(dl, di, db, locked);
            assert.ok(
              VALID_KINDS.has(kind),
              `invalid kind ${kind} for (${dl},${di},${db},${locked})`,
            );
            assert.equal(
              kind,
              referenceClassify(dl, di, db, locked),
              `mismatch for (local=${dl}, incoming=${di}, baseline=${db}, locked=${locked})`,
            );
          }
        }
      }
    }
  });

  it('classifyProject assigns each Unit exactly one valid classification consistent with the decision table', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { local, incoming, baseline, lockedRecordingIds } = materialize(scenario);
        const results = classifyProject(local, incoming, baseline, lockedRecordingIds);

        const seenRefs = new Set();
        for (const c of results) {
          // TOTAL: every emitted Unit carries a single valid classification.
          assert.ok(VALID_KINDS.has(c.kind), `classifyProject produced an invalid kind: ${c.kind}`);

          // Exactly one classification per Unit (no duplicate unitRefs).
          assert.ok(!seenRefs.has(c.unitRef), `duplicate classification for unitRef ${c.unitRef}`);
          seenRefs.add(c.unitRef);

          // CORRECT: the decision table applied to the digests classifyProject
          // reports for this Unit must reproduce the reported kind. A project-
          // level Unit is never locked; a recording-level Unit is locked iff its
          // id is in the locked set (R6.3).
          const locked = c.recording_id == null ? false : lockedRecordingIds.has(c.recording_id);
          assert.equal(
            c.kind,
            referenceClassify(c.digestLocal, c.digestIncoming, c.digestBaseline, locked),
            `classifyProject kind for ${c.unitRef} disagrees with the decision table`,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it('classifies the concurrent-push case as diverged (R18.1)', () => {
    // Two clients edit the same recording from a common baseline; client A edits
    // locally, client B overwrites the server. When A pulls: local != incoming,
    // local != baseline, incoming != baseline ⇒ diverged (A's work surfaced).
    const baseline = 'common-baseline';
    const localEdit = 'client-A-edit';
    const incomingOverwrite = 'client-B-overwrite';
    assert.equal(classifyUnit(localEdit, incomingOverwrite, baseline, false), 'diverged');
  });

  it('covers each decision-table branch with a concrete example', () => {
    // locked-skipped (R6.3) — beats every other signal, even full equality.
    assert.equal(classifyUnit('A', 'A', 'A', true), 'locked-skipped');
    // already-converged (R2.2) — equal regardless of baseline.
    assert.equal(classifyUnit('A', 'A', 'B', false), 'already-converged');
    assert.equal(classifyUnit('A', 'A', null, false), 'already-converged');
    // deleted-local-clean (R19.1) — absent local, incoming == baseline.
    assert.equal(classifyUnit(null, 'A', 'A', false), 'deleted-local-clean');
    // deleted-both (R19.7) — absent on both sides, present in baseline.
    assert.equal(classifyUnit(null, null, 'A', false), 'deleted-both');
    // conflict-delete-vs-change, local deleted (R19.2) — absent local, incoming changed.
    assert.equal(classifyUnit(null, 'B', 'A', false), 'conflict-delete-vs-change');
    // deleted-remote-review (R19.3) — absent incoming, local == baseline.
    assert.equal(classifyUnit('A', null, 'A', false), 'deleted-remote-review');
    // conflict-delete-vs-change, server deleted (R19.5) — absent incoming, local changed.
    assert.equal(classifyUnit('B', null, 'A', false), 'conflict-delete-vs-change');
    // brand-new (R2.3) — no local counterpart, no baseline.
    assert.equal(classifyUnit(null, 'A', null, false), 'brand-new');
    // changed-incoming (R2.4) — local == baseline, incoming moved.
    assert.equal(classifyUnit('A', 'B', 'A', false), 'changed-incoming');
    // changed-local-outgoing (R2.5) — incoming == baseline, local moved.
    assert.equal(classifyUnit('B', 'A', 'A', false), 'changed-local-outgoing');
    // diverged (R2.6) — both present, differ, both differ from baseline.
    assert.equal(classifyUnit('A', 'B', 'C', false), 'diverged');
    // diverged with no baseline (R2.7) — both present and differ, never agreed.
    assert.equal(classifyUnit('A', 'B', null, false), 'diverged');
  });
});
