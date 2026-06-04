/**
 * resolve-conflict-fixtures.test.js — Regression fixtures for tricky step
 * histories resolved through Conflict_Resolution (`resolveConflict`).
 *
 * Where the sibling PROPERTY tests
 * (`resolution-append-only-tombstone.property.test.js`,
 * `resolve-explicit-logical-id.property.test.js`) drive `resolveConflict` over
 * randomized histories, this file pins a set of CONCRETE, hand-built scenarios
 * that have historically been easy to get wrong:
 *
 *   1. INTERLEAVED RE-RECORDS — several version records per `logical_id` split
 *      across the local and incoming sides, where the globally-latest record
 *      (highest `uuid`) for a logical step alternates which side it came from.
 *      The adopted Active View must surface exactly the latest LIVE version per
 *      `logical_id`, sorted by `step_number` (R11.1, R11.3).
 *
 *   2. TOMBSTONES AT VARIOUS POSITIONS — a tombstone that is the latest version
 *      of a logical step (the step must stay deleted), and a tombstone buried in
 *      the MIDDLE of a history that is later superseded by a live re-record (the
 *      step must re-surface). A deleted step is never resurrected by resolution,
 *      and a re-recorded step is never wrongly suppressed (R11.2).
 *
 *   3. DELETE-VS-CHANGE — a Unit deleted on one side and changed on the other,
 *      in both directions (local-deleted / server-changed and
 *      server-deleted / local-changed) and at both granularities (recording and
 *      project). For each, the two explicit outcomes are exercised: KEEP the
 *      surviving changed version (supply it as the resolved state) and ACCEPT the
 *      deletion (the {@link DELETE_RESOLUTION} sentinel). Resolution defaults to
 *      neither (R19.5).
 *
 * Each fixture records a Conflict via `upsertConflict` (retaining both versions,
 * R5.2), resolves it through `resolveConflict`, then asserts the adopted state,
 * its Active View via `resolveActiveSteps`, the Conflict being cleared, and the
 * baseline outcome.
 *
 * Uses the Node.js built-in test runner (`node --test`), matching the rest of
 * `packages/shared/tests/unit`.
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 19.5**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConflict, DELETE_RESOLUTION } from '../../conflict-resolution.js';
import { createEmptySyncState, upsertConflict, getItem } from '../../sync-store.js';
import { getBaseline, advanceBaseline } from '../../sync-baseline.js';
import { digestProject } from '../../sync-digest.js';
import { resolveActiveSteps } from '../../lib/session.js';

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';
// A fixed clock so any baseline `agreedAt` stamp is deterministic; the fixtures
// assert nothing about its value, only the resolution / Active-View outcomes.
const FIXED_NOW = () => 0;

// ─── Builders ─────────────────────────────────────────────────────────────────

/** Build a step record. `uuid`s are zero-padded so lexicographic order (used by
 *  `resolveActiveSteps` to pick the latest version per `logical_id`) matches the
 *  intended chronological order. */
function step(uuid, logical_id, step_number, deleted = false) {
  return { uuid, logical_id, step_number, deleted };
}

function buildRecording(recording_id, steps) {
  return { recording_id, name: `rec-${recording_id}`, created_at: FIXED_CREATED_AT, steps };
}

function buildProject(project_id, recordings) {
  return { project_id, name: `proj-${project_id}`, created_at: FIXED_CREATED_AT, recordings };
}

/** Deep, plain-prototype copy via a JSON round-trip — matches how recoverable
 *  copies are actually stored, so `deepStrictEqual` compares VALUES. */
function jsonNormalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function findProject(projects, project_id) {
  return projects.find((p) => p && p.project_id === project_id);
}

function findRecording(project, recording_id) {
  return project.recordings.find((r) => r && r.recording_id === recording_id);
}

/** Assert a recording's Active View is exactly `expected` (ordered list of
 *  `[logical_id, uuid]`), and that it holds at most one active step per
 *  `logical_id` with no tombstones (R11.2, R11.3). */
function assertActiveView(recording, expected) {
  const active = resolveActiveSteps(recording);
  assert.deepStrictEqual(
    active.map((s) => [s.logical_id, s.uuid]),
    expected,
    'Active View must surface the latest live version per logical_id, ordered by step_number',
  );
  // No logical_id appears twice and no surfaced step is a tombstone.
  const seen = new Set();
  for (const s of active) {
    assert.ok(
      !seen.has(s.logical_id),
      `logical_id ${s.logical_id} appears twice in the Active View`,
    );
    seen.add(s.logical_id);
    assert.notEqual(s.deleted, true, 'an Active View step must never be a tombstone');
  }
}

/** Assert every input step uuid survives into the resolved history (append-only,
 *  R11.1). */
function assertAppendOnly(resolvedSteps, ...inputHistories) {
  const present = new Set(resolvedSteps.map((s) => s.uuid));
  for (const history of inputHistories) {
    for (const s of history) {
      assert.ok(present.has(s.uuid), `step ${s.uuid} must survive into the resolved history`);
    }
  }
}

// ─── 1. Interleaved re-records (R11.1, R11.3) ──────────────────────────────────

describe('resolveConflict — interleaved re-records resolve to the correct Active View (R11.1, R11.3)', () => {
  it('surfaces the globally-latest live version per logical_id, alternating which side won, sorted by step_number', () => {
    const PROJECT = 'p-interleave';
    const RECORDING = 'r-interleave';
    const unitRef = `${PROJECT}:${RECORDING}`;

    // logical 'a': created locally (u01), then re-recorded TWICE on the server
    // (u02, u03), then re-recorded AGAIN locally (u04). Globally-latest = u04
    // (local), even though the server has the most records. step_number 2.
    // logical 'b': created locally (u05) and re-recorded on the server (u06).
    // Globally-latest = u06 (incoming). step_number 1 — so it sorts BEFORE 'a'.
    const localSteps = [step('u01', 'a', 2), step('u04', 'a', 2), step('u05', 'b', 1)];
    const incomingSteps = [step('u02', 'a', 2), step('u03', 'a', 2), step('u06', 'b', 1)];
    // The user's chosen resolution is the explicit append-only superset of both.
    const resolvedSteps = [...localSteps, ...incomingSteps];

    const localRec = buildRecording(RECORDING, localSteps);
    const incomingRec = buildRecording(RECORDING, incomingSteps);
    const resolvedRec = buildRecording(RECORDING, resolvedSteps);
    const localProjects = [buildProject(PROJECT, [localRec])];

    const m = jsonNormalize({ localRec, incomingRec, resolvedRec, localProjects });

    const state = createEmptySyncState();
    upsertConflict(state, unitRef, m.localRec, m.incomingRec, FIXED_NOW);

    const result = resolveConflict(state, m.localProjects, unitRef, m.resolvedRec, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true, 'an append-only superset must be adopted');
    assert.equal(result.reason, null);
    assert.notEqual(result.removed, true);

    const rec = findRecording(findProject(result.projects, PROJECT), RECORDING);
    assert.deepStrictEqual(rec, m.resolvedRec, 'the adopted recording must equal the chosen state');

    // Every interleaved record from both sides survives (append-only, R11.1).
    assertAppendOnly(rec.steps, m.localRec.steps, m.incomingRec.steps);
    // 'b' (step_number 1, latest = incoming u06) sorts before 'a' (step_number 2,
    // latest = local u04). Both latest versions are live (R11.3).
    assertActiveView(rec, [
      ['b', 'u06'],
      ['a', 'u04'],
    ]);

    assert.equal(getItem(state, unitRef), null, 'the resolved Conflict must be cleared');
    const baseline = getBaseline(state, PROJECT);
    assert.ok(baseline, 'the baseline must advance to the resolved-against incoming version');
    // Per-unit resolved-against baseline (R1.4, R1.9): advance to the INCOMING
    // version the user resolved against (not the adopted/merged state), so a merge
    // reads as changed-local-outgoing next cycle and is pushed (R20.5).
    assert.equal(baseline.digest, digestProject(buildProject(PROJECT, [m.incomingRec])));
  });
});

// ─── 2. Tombstones at various positions (R11.2) ────────────────────────────────

describe('resolveConflict — tombstones stay tombstoned wherever they sit in history (R11.2)', () => {
  it('keeps a latest-version tombstone deleted and re-surfaces a step whose tombstone was later superseded', () => {
    const PROJECT = 'p-tomb';
    const RECORDING = 'r-tomb';
    const unitRef = `${PROJECT}:${RECORDING}`;

    // logical 'a': created locally (u01), re-recorded on server (u02), then
    //   TOMBSTONED on server (u03) — the tombstone is the LATEST version, so 'a'
    //   must NOT surface.
    // logical 'b': a plain live step (u04). Must surface.
    // logical 'c': created locally (u05), TOMBSTONED locally (u06) — a tombstone
    //   in the MIDDLE — then re-recorded live on the server (u07), the latest
    //   version. 'c' must re-surface (the buried tombstone must not suppress it).
    const localSteps = [
      step('u01', 'a', 1),
      step('u04', 'b', 2),
      step('u05', 'c', 3),
      step('u06', 'c', 3, true),
    ];
    const incomingSteps = [step('u02', 'a', 1), step('u03', 'a', 1, true), step('u07', 'c', 3)];
    const resolvedSteps = [...localSteps, ...incomingSteps];

    const localRec = buildRecording(RECORDING, localSteps);
    const incomingRec = buildRecording(RECORDING, incomingSteps);
    const resolvedRec = buildRecording(RECORDING, resolvedSteps);
    const localProjects = [buildProject(PROJECT, [localRec])];

    const m = jsonNormalize({ localRec, incomingRec, resolvedRec, localProjects });

    const state = createEmptySyncState();
    upsertConflict(state, unitRef, m.localRec, m.incomingRec, FIXED_NOW);

    const result = resolveConflict(state, m.localProjects, unitRef, m.resolvedRec, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    const rec = findRecording(findProject(result.projects, PROJECT), RECORDING);

    // All seven records survive, including both tombstones (append-only, R11.1).
    assertAppendOnly(rec.steps, m.localRec.steps, m.incomingRec.steps);
    assert.equal(rec.steps.length, 7);

    // 'a' is tombstoned (latest = u03 deleted) → absent.
    // 'b' is live → surfaces (step_number 2).
    // 'c' was tombstoned mid-history (u06) but the latest version (u07) is live
    //     → re-surfaces (step_number 3).
    assertActiveView(rec, [
      ['b', 'u04'],
      ['c', 'u07'],
    ]);

    assert.equal(getItem(state, unitRef), null);
  });

  it('resolves an all-tombstoned-latest recording to an empty Active View without dropping any record', () => {
    const PROJECT = 'p-empty';
    const RECORDING = 'r-empty';
    const unitRef = `${PROJECT}:${RECORDING}`;

    // Both sides agree the single logical step ends tombstoned, via different
    // record uuids — a delete-vs-delete-on-step within a diverged recording.
    const localSteps = [step('u01', 'a', 1), step('u02', 'a', 1, true)];
    const incomingSteps = [step('u01', 'a', 1), step('u03', 'a', 1, true)];
    const resolvedSteps = [
      step('u01', 'a', 1),
      step('u02', 'a', 1, true),
      step('u03', 'a', 1, true),
    ];

    const localRec = buildRecording(RECORDING, localSteps);
    const incomingRec = buildRecording(RECORDING, incomingSteps);
    const resolvedRec = buildRecording(RECORDING, resolvedSteps);
    const localProjects = [buildProject(PROJECT, [localRec])];

    const m = jsonNormalize({ localRec, incomingRec, resolvedRec, localProjects });

    const state = createEmptySyncState();
    upsertConflict(state, unitRef, m.localRec, m.incomingRec, FIXED_NOW);

    const result = resolveConflict(state, m.localProjects, unitRef, m.resolvedRec, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    const rec = findRecording(findProject(result.projects, PROJECT), RECORDING);
    assertAppendOnly(rec.steps, m.localRec.steps, m.incomingRec.steps);
    // Latest version of 'a' (u03) is a tombstone → no active steps (R11.2).
    assertActiveView(rec, []);
  });
});

// ─── 3. Delete-vs-change at the recording level (R19.5) ────────────────────────

describe('resolveConflict — recording-level delete-vs-change: local deleted, server changed (R19.5)', () => {
  // Baseline recording had logical 'a' (u01). The SERVER appended logical 'b'
  // (u02) — the changed version — while LOCAL deleted the whole recording. The
  // Conflict retains both: `local` = the pre-deletion (baseline) copy, `incoming`
  // = the server's changed copy. The local project still exists (with an
  // unrelated recording) but no longer holds the deleted recording.
  const PROJECT = 'p-dvc-1';
  const DELETED = 'r-deleted';
  const KEPT = 'r-untouched';
  const unitRef = `${PROJECT}:${DELETED}`;

  function seed() {
    const localCopy = buildRecording(DELETED, [step('u01', 'a', 1)]); // what local had before deleting
    const incomingCopy = buildRecording(DELETED, [step('u01', 'a', 1), step('u02', 'b', 2)]); // server change
    const untouched = buildRecording(KEPT, [step('k01', 'x', 1)]);
    const localProjects = [buildProject(PROJECT, [untouched])]; // recording already deleted locally

    const m = jsonNormalize({ localCopy, incomingCopy, localProjects });
    const state = createEmptySyncState();
    // Faithful to the orchestrator: a locally-deleted recording is stored with a
    // NULL local side (the recording is absent locally); the incoming side holds
    // the server's changed version.
    upsertConflict(state, unitRef, null, m.incomingCopy, FIXED_NOW);
    return { state, m };
  }

  it('KEEP the changed version — re-adds the recording with the server change and surfaces both steps', () => {
    const { state, m } = seed();
    // The user keeps the surviving (changed) version: supply it as the resolution.
    const result = resolveConflict(state, m.localProjects, unitRef, m.incomingCopy, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.notEqual(result.removed, true, 'keeping the changed version is not a removal');

    const project = findProject(result.projects, PROJECT);
    const rec = findRecording(project, DELETED);
    assert.ok(rec, 'the kept recording must be re-added to the project');
    assert.deepStrictEqual(
      rec,
      m.incomingCopy,
      'the kept recording must equal the changed version',
    );
    assertActiveView(rec, [
      ['a', 'u01'],
      ['b', 'u02'],
    ]);
    // The unrelated recording is untouched.
    assert.ok(findRecording(project, KEPT), 'an unrelated recording must be untouched');

    assert.equal(getItem(state, unitRef), null, 'the Conflict must be cleared');
    const baseline = getBaseline(state, PROJECT);
    assert.ok(baseline, 'the baseline advances per-unit to the resolved-against incoming version');
    // Per-unit resolved-against (R1.4, R1.9): the resolved-against incoming side is
    // the server's CHANGE (not a deletion), so the recording's baseline entry is
    // set to it; the kept (re-added) recording then reads as already-converged.
    assert.ok(
      findRecording(baseline.agreedState, DELETED),
      'the baseline entry must be the resolved-against incoming (changed) recording',
    );
  });

  it('ACCEPT the deletion via DELETE_RESOLUTION — the recording stays absent and the local deletion propagates next cycle', () => {
    const { state, m } = seed();
    const result = resolveConflict(state, m.localProjects, unitRef, DELETE_RESOLUTION, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.removed, true, 'accepting the deletion flags a removal');

    const project = findProject(result.projects, PROJECT);
    assert.equal(findRecording(project, DELETED), undefined, 'the deleted recording stays absent');
    assert.ok(findRecording(project, KEPT), 'the unrelated recording is untouched');

    assert.equal(getItem(state, unitRef), null, 'the Conflict must be cleared');
    const baseline = getBaseline(state, PROJECT);
    assert.ok(baseline, 'the baseline advances per-unit to the resolved-against incoming version');
    // Per-unit resolved-against (R1.4): the resolved-against incoming side is the
    // server's CHANGE (not a deletion), so the baseline entry is set to it. With
    // the recording absent locally, the next cycle reads this as a one-sided local
    // deletion (deleted-local-clean) and propagates it — rather than resurrecting
    // the server's version as brand-new (which clearing the baseline would cause).
    assert.equal(
      baseline.agreedState.recordings.some((r) => r.recording_id === DELETED),
      true,
      'the baseline entry holds the resolved-against incoming (changed) recording',
    );
  });

  it('defaults to NEITHER — an absent resolution is rejected and leaves the Conflict pending (R19.5)', () => {
    const { state, m } = seed();
    const result = resolveConflict(state, m.localProjects, unitRef, null, { now: FIXED_NOW });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-resolution');
    assert.ok(state.conflicts[unitRef], 'the delete-vs-change Conflict must remain pending');
    assert.equal(getBaseline(state, PROJECT), null, 'no baseline may be advanced without a choice');
  });
});

describe('resolveConflict — recording-level delete-vs-change: server deleted, local changed (R19.5)', () => {
  // The mirror direction: LOCAL changed the recording (appended logical 'b'),
  // the SERVER deleted it. The recording IS present locally with the change.
  const PROJECT = 'p-dvc-2';
  const RECORDING = 'r-srv-deleted';
  const unitRef = `${PROJECT}:${RECORDING}`;

  function seed() {
    const localChanged = buildRecording(RECORDING, [step('u01', 'a', 1), step('u02', 'b', 2)]);
    const agreed = buildRecording(RECORDING, [step('u01', 'a', 1)]); // last-agreed (pre-change) copy
    const localProjects = [buildProject(PROJECT, [localChanged])];

    const m = jsonNormalize({ localChanged, agreed, localProjects });
    const state = createEmptySyncState();
    // Seed the last-agreed baseline (the recording existed and was agreed), so the
    // per-unit removal of its baseline entry is observable.
    advanceBaseline(state, PROJECT, buildProject(PROJECT, [m.agreed]), FIXED_NOW);
    // Faithful to the orchestrator: the SERVER deletion is a NULL incoming side;
    // the local side holds the changed recording.
    upsertConflict(state, unitRef, m.localChanged, null, FIXED_NOW);
    return { state, m };
  }

  it('KEEP the changed version — the locally-changed recording is retained with both steps', () => {
    const { state, m } = seed();
    const result = resolveConflict(state, m.localProjects, unitRef, m.localChanged, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.notEqual(result.removed, true);
    const rec = findRecording(findProject(result.projects, PROJECT), RECORDING);
    assert.deepStrictEqual(rec, m.localChanged);
    assertActiveView(rec, [
      ['a', 'u01'],
      ['b', 'u02'],
    ]);
    assert.equal(getItem(state, unitRef), null);
    // Per-unit resolved-against (R1.4, R1.10): the resolved-against incoming side is
    // a DELETION, so the recording's baseline entry is REMOVED — the kept survivor
    // reads as local-new next cycle and is re-pushed (re-propagating it).
    const baseline = getBaseline(state, PROJECT);
    assert.ok(baseline, 'the project baseline is retained (only the entry is removed)');
    assert.equal(
      baseline.agreedState.recordings.some((r) => r.recording_id === RECORDING),
      false,
      'the resolved-against deletion removes the recording from the baseline',
    );
  });

  it('ACCEPT the deletion via DELETE_RESOLUTION — the present recording is removed from the project', () => {
    const { state, m } = seed();
    const result = resolveConflict(state, m.localProjects, unitRef, DELETE_RESOLUTION, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    const project = findProject(result.projects, PROJECT);
    assert.equal(findRecording(project, RECORDING), undefined, 'the recording must be removed');
    assert.equal(getItem(state, unitRef), null);
    const baseline = getBaseline(state, PROJECT);
    assert.ok(baseline);
    assert.equal(
      baseline.agreedState.recordings.some((r) => r.recording_id === RECORDING),
      false,
      'the accepted deletion must be reflected in the baseline',
    );
  });
});

// ─── 4. Delete-vs-change at the project level (R19.5) ──────────────────────────

describe('resolveConflict — project-level delete-vs-change (R19.5)', () => {
  // The whole PROJECT diverged as delete-vs-change: LOCAL changed it (a recording
  // gained logical 'b'), the SERVER deleted the project. The Conflict retains the
  // changed local project and the pre-deletion (baseline) project.
  const PROJECT = 'p-dvc-proj';
  const RECORDING = 'r-1';
  const unitRef = PROJECT; // project-level unitRef has no recording segment

  function seed() {
    const localChanged = buildProject(PROJECT, [
      buildRecording(RECORDING, [step('u01', 'a', 1), step('u02', 'b', 2)]),
    ]);
    const agreed = buildProject(PROJECT, [buildRecording(RECORDING, [step('u01', 'a', 1)])]);
    const localProjects = [localChanged];

    const m = jsonNormalize({ localChanged, agreed, localProjects });
    const state = createEmptySyncState();
    // Seed the last-agreed baseline so the project deletion's effect on it is
    // observable.
    advanceBaseline(state, PROJECT, m.agreed, FIXED_NOW);
    // Faithful to the orchestrator: the SERVER deleted the whole project, so the
    // incoming side is NULL; the local side holds the changed project.
    upsertConflict(state, unitRef, m.localChanged, null, FIXED_NOW);
    return { state, m };
  }

  it('KEEP the changed version — adopts the whole changed project and its Active View', () => {
    const { state, m } = seed();
    const result = resolveConflict(state, m.localProjects, unitRef, m.localChanged, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.notEqual(result.removed, true);
    const project = findProject(result.projects, PROJECT);
    assert.deepStrictEqual(project, m.localChanged);
    assertActiveView(findRecording(project, RECORDING), [
      ['a', 'u01'],
      ['b', 'u02'],
    ]);
    assert.equal(getItem(state, unitRef), null);
    // Per-unit resolved-against (R1.4): a project-level Unit advances the whole
    // project baseline to the resolved-against incoming version; that side is a
    // DELETION, so the project baseline is CLEARED — the kept project then reads as
    // local-new next cycle and is re-pushed (re-propagating it).
    assert.equal(
      getBaseline(state, PROJECT),
      null,
      'the resolved-against project deletion clears the baseline',
    );
  });

  it('ACCEPT the deletion via DELETE_RESOLUTION — the whole project is removed and its baseline cleared', () => {
    const { state, m } = seed();
    const result = resolveConflict(state, m.localProjects, unitRef, DELETE_RESOLUTION, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(findProject(result.projects, PROJECT), undefined, 'the project must be removed');
    assert.equal(getItem(state, unitRef), null);
    assert.equal(
      getBaseline(state, PROJECT),
      null,
      'an accepted project deletion clears its baseline',
    );
  });
});
