/**
 * resolution-recoverability.property.test.js — Property test for recoverability
 * of BOTH versions through a successful Conflict_Resolution (`resolveConflict`).
 *
 * A Conflict defers a Unit that diverged on both sides since the last-agreed
 * Sync_Baseline. It is resolved only by an explicit user choice, and
 * `resolveConflict`'s keep/merge path is the single place a diverged Unit's local
 * data is changed. The whole point of the append-only model is that adopting a
 * resolution NEVER discards a version: the user encodes their per-`logical_id`
 * choice by which record is the active (latest-`uuid`) version, NOT by dropping
 * records. The chosen resolved state must therefore be an append-only SUPERSET of
 * both conflicting histories, so every committed step record from the local
 * version AND from the incoming version survives into the adopted history.
 *
 * This property pins the post-condition of any SUCCESSFUL keep/merge resolution,
 * over arbitrary conflicts at both granularities (recording-level and
 * project-level), with and without a retained project-level Sync_Snapshot:
 *
 *   - RECOVERABLE LOCAL — every step record (by `uuid`) present in the local
 *     version is still present in the adopted Unit's committed history after
 *     resolution, so the local version remains recoverable (R9.3).
 *   - RECOVERABLE INCOMING — every step record (by `uuid`) present in the incoming
 *     version is still present in the adopted Unit's committed history, so the
 *     incoming version remains recoverable (R9.3).
 *   - The adopted history is thus a superset of the union of both versions'
 *     records — neither version loses a record as a result of resolution.
 *   - SNAPSHOT RETAINED — the retained project-level Sync_Snapshot (landed on
 *     pull) is preserved unchanged in the store and surfaced on the result as an
 *     additional recovery handle for the incoming version; resolution never
 *     clears it.
 *
 * It also pins that everything not targeted is left untouched: every other local
 * project remains byte-identical, and the input `projects` array is never mutated
 * in place.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generator conventions in the sibling property tests.
 *
 * **Validates: Requirements 9.3**
 */

// Feature: sync-conflict-resolution, Property 18: Resolution keeps both versions recoverable

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { resolveConflict, itemKind } from '../../conflict-resolution.js';
import { createEmptySyncState, upsertConflict, getItem } from '../../sync-store.js';

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';

// A fixed clock so the baseline `agreedAt` stamp is deterministic; the property
// asserts nothing about its value, only that both versions stay recoverable.
const FIXED_NOW = () => 0;

// ─── Generators ──────────────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c', 'd'),
  step_number: fc.integer({ min: 0, max: 10 }),
  deleted: fc.boolean(),
});

/** A committed step history with distinct `uuid`s (records never share a uuid). */
const arbHistory = fc.uniqueArray(arbStep, { selector: (s) => s.uuid, maxLength: 5 });

// A whole resolution scenario. `level` selects a recording-level or project-level
// Conflict; `localSteps`/`incomingSteps` are the two diverging histories;
// `extraSteps` are brand-new merged records the user may add on top (the adopted
// state can be a strict superset of the union, not just the union); `others` are
// untouched sibling projects; `includeSnapshot` controls whether a project-level
// Sync_Snapshot was retained on pull.
const arbScenario = fc.record({
  level: fc.constantFrom('recording', 'project'),
  project_id: fc.uuid(),
  recording_id: fc.uuid(),
  localSteps: arbHistory,
  incomingSteps: arbHistory,
  extraSteps: fc.uniqueArray(arbStep, { selector: (s) => s.uuid, maxLength: 3 }),
  others: fc.uniqueArray(fc.record({ id: fc.uuid(), steps: arbHistory }), {
    selector: (p) => p.id,
    maxLength: 2,
  }),
  includeSnapshot: fc.boolean(),
});

/** Build a RecordingCopy from an id and a committed step history. */
function recording(recording_id, steps) {
  return { recording_id, name: `rec-${recording_id}`, created_at: FIXED_CREATED_AT, steps };
}

/** Build a ProjectCopy from an id and an ordered recording list. */
function project(project_id, recordings) {
  return { project_id, name: `proj-${project_id}`, created_at: FIXED_CREATED_AT, recordings };
}

/**
 * Concatenate step histories, de-duplicating by `uuid` (keeping the first record
 * seen for a uuid, earlier arrays first). This is the minimal append-only
 * SUPERSET of its inputs: it retains every step record present in any input, so
 * a resolved state built from it can never drop a version's record.
 */
function unionByUuid(...histories) {
  const seen = new Set();
  const out = [];
  for (const history of histories) {
    for (const step of history) {
      if (!seen.has(step.uuid)) {
        seen.add(step.uuid);
        out.push(step);
      }
    }
  }
  return out;
}

/**
 * Collect the set of step-record `uuid`s contained in a Unit copy, across both
 * granularities (a recording's own `steps`, and every recording's `steps` inside
 * a project) — the same faithful "which committed records this version contains"
 * notion the module uses for its append-only safety check.
 */
function collectUuids(unitCopy) {
  const uuids = new Set();
  if (!unitCopy || typeof unitCopy !== 'object') return uuids;
  if (Array.isArray(unitCopy.steps)) {
    for (const step of unitCopy.steps) if (step && step.uuid != null) uuids.add(step.uuid);
  }
  if (Array.isArray(unitCopy.recordings)) {
    for (const rec of unitCopy.recordings) {
      if (rec && Array.isArray(rec.steps)) {
        for (const step of rec.steps) if (step && step.uuid != null) uuids.add(step.uuid);
      }
    }
  }
  return uuids;
}

/** Find a project by id in a projects array. */
function findProject(projects, project_id) {
  return projects.find((p) => p && p.project_id === project_id);
}

/**
 * Materialize a scenario into the concrete inputs: the local projects array, the
 * conflict's recoverable local & incoming versions, the chosen append-only
 * superset `resolvedState`, the target `unitRef`, and the untouched other
 * projects. Defensively excludes any generated id colliding with the target ids
 * so the target Unit is unambiguous.
 */
function materialize(scenario) {
  const { project_id, recording_id, localSteps, incomingSteps, extraSteps } = scenario;

  // Other local projects (never colliding with the target project_id).
  const others = scenario.others
    .filter((p) => p.id !== project_id)
    .map((p) => project(p.id, [recording(`${p.id}-rec`, p.steps)]));

  // The chosen resolved history retains every record from BOTH sides (plus any
  // brand-new merged records the user added on top) — an append-only superset.
  const mergedSteps = unionByUuid(localSteps, incomingSteps, extraSteps);

  if (scenario.level === 'recording') {
    const unitRef = `${project_id}:${recording_id}`;
    const localVer = recording(recording_id, localSteps);
    const incomingVer = recording(recording_id, incomingSteps);
    const resolvedState = recording(recording_id, mergedSteps);

    // The local project that holds the target recording, alongside the others.
    const localTargetProject = project(project_id, [recording(recording_id, localSteps)]);
    const localProjects = [...others, localTargetProject];

    return {
      level: 'recording',
      project_id,
      recording_id,
      unitRef,
      localVer,
      incomingVer,
      resolvedState,
      localProjects,
      others,
    };
  }

  // Project-level: both versions and the resolved state are whole ProjectCopies.
  const unitRef = project_id;
  const localVer = project(project_id, [recording(recording_id, localSteps)]);
  const incomingVer = project(project_id, [recording(recording_id, incomingSteps)]);
  const resolvedState = project(project_id, [recording(recording_id, mergedSteps)]);

  const localProjects = [...others, project(project_id, [recording(recording_id, localSteps)])];

  return {
    level: 'project',
    project_id,
    recording_id,
    unitRef,
    localVer,
    incomingVer,
    resolvedState,
    localProjects,
    others,
  };
}

/** The adopted target Unit (recording or project) from the resolved projects. */
function adoptedUnit(m, projects) {
  const proj = findProject(projects, m.project_id);
  if (!proj) return null;
  if (m.level === 'recording') {
    return proj.recordings.find((r) => r && r.recording_id === m.recording_id) ?? null;
  }
  return proj;
}

// ─── Property 18 ──────────────────────────────────────────────────────────────

describe('Property 18: Resolution keeps both versions recoverable', () => {
  it('a successful keep/merge resolution retains every step record of BOTH the local and incoming versions, and preserves the retained snapshot', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const m = materialize(scenario);

        // Seed the store with exactly this Conflict (via the real idempotent
        // upsert path), retaining recoverable copies of both versions (R5.2).
        const state = createEmptySyncState();
        upsertConflict(state, m.unitRef, m.localVer, m.incomingVer, FIXED_NOW);

        // Optionally seed a retained project-level Sync_Snapshot (landed on pull),
        // so we can prove resolution preserves it as a recovery handle (R9.3).
        let snapshotRef;
        let snapshotJsonBefore;
        if (scenario.includeSnapshot) {
          state.snapshots[m.project_id] = {
            payload: m.incomingVer.recordings
              ? m.incomingVer
              : project(m.project_id, [m.incomingVer]),
            pulledAt: FIXED_CREATED_AT,
          };
          snapshotRef = state.snapshots[m.project_id];
          snapshotJsonBefore = JSON.stringify(snapshotRef);
        }

        // The recoverable uuids each version contributes (computed independently
        // of the module under test).
        const localUuids = collectUuids(m.localVer);
        const incomingUuids = collectUuids(m.incomingVer);

        // Snapshot the input projects to prove the array is not mutated in place.
        const inputJsonBefore = JSON.stringify(m.localProjects);

        const result = resolveConflict(state, m.localProjects, m.unitRef, m.resolvedState, {
          now: FIXED_NOW,
        });

        // ── Outcome shape: a keep/merge resolution succeeds (not a deletion) ──
        assert.equal(result.ok, true, 'a valid keep/merge resolution must succeed');
        assert.equal(result.kind, 'conflict');
        assert.equal(result.reason, null);
        assert.notEqual(result.removed, true, 'a keep/merge resolution does not remove the Unit');

        // The Conflict is cleared, confirming this was a completed resolution.
        assert.equal(getItem(state, m.unitRef), null, 'the resolved Conflict must be cleared');

        // ── The adopted history is a superset of BOTH versions' records ───────
        const unit = adoptedUnit(m, result.projects);
        assert.ok(unit, 'the resolved target Unit must be present after resolution');
        const adoptedUuids = collectUuids(unit);

        // RECOVERABLE LOCAL (R9.3): every local step record survives.
        for (const uuid of localUuids) {
          assert.ok(
            adoptedUuids.has(uuid),
            `local step record ${uuid} must remain recoverable in the adopted history`,
          );
        }
        // RECOVERABLE INCOMING (R9.3): every incoming step record survives.
        for (const uuid of incomingUuids) {
          assert.ok(
            adoptedUuids.has(uuid),
            `incoming step record ${uuid} must remain recoverable in the adopted history`,
          );
        }

        // ── SNAPSHOT RETAINED — never cleared by resolution (R9.3) ────────────
        if (scenario.includeSnapshot) {
          assert.equal(
            state.snapshots[m.project_id],
            snapshotRef,
            'the retained Sync_Snapshot must remain in the store after resolution',
          );
          assert.equal(
            JSON.stringify(state.snapshots[m.project_id]),
            snapshotJsonBefore,
            'the retained Sync_Snapshot content must be unchanged',
          );
          assert.equal(
            result.retained,
            snapshotRef,
            'the surfaced recovery handle must be the retained Sync_Snapshot',
          );
        } else {
          assert.equal(result.retained, null, 'no snapshot ⇒ no project-level recovery handle');
        }

        // ── Nothing else is disturbed ─────────────────────────────────────────
        for (const other of m.others) {
          const otherAfter = findProject(result.projects, other.project_id);
          const otherBefore = findProject(m.localProjects, other.project_id);
          assert.deepStrictEqual(otherAfter, otherBefore, 'other projects must be untouched');
        }
        // The input projects array is not mutated in place.
        assert.equal(
          JSON.stringify(m.localProjects),
          inputJsonBefore,
          'the input projects array must not be mutated in place',
        );
      }),
      { numRuns: 200 },
    );
  });

  // ─── Regression examples ──────────────────────────────────────────────────

  it('resolving a recording-level conflict with a union superset keeps both histories recoverable (regression example)', () => {
    const localVer = {
      recording_id: 'rec-1',
      name: 'Add to cart (local)',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const incomingVer = {
      recording_id: 'rec-1',
      name: 'Add to cart (server)',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'u2', logical_id: 'a', step_number: 0, deleted: false }],
    };
    // The user's chosen resolution retains BOTH version records (append-only).
    const resolvedState = {
      recording_id: 'rec-1',
      name: 'Add to cart (merged)',
      created_at: FIXED_CREATED_AT,
      steps: [
        { uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'u2', logical_id: 'a', step_number: 0, deleted: false },
      ],
    };
    const localProjects = [
      {
        project_id: 'proj-1',
        name: 'Checkout',
        created_at: FIXED_CREATED_AT,
        recordings: [localVer],
      },
    ];

    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', localVer, incomingVer, FIXED_NOW);
    state.snapshots['proj-1'] = {
      payload: {
        project_id: 'proj-1',
        name: 'Checkout (server)',
        created_at: FIXED_CREATED_AT,
        recordings: [incomingVer],
      },
      pulledAt: FIXED_CREATED_AT,
    };
    const snapshotBefore = structuredClone(state.snapshots['proj-1']);

    const result = resolveConflict(state, localProjects, 'proj-1:rec-1', resolvedState, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(itemKind(state, 'proj-1:rec-1'), null);

    const applied = result.projects[0].recordings.find((r) => r.recording_id === 'rec-1');
    const uuids = new Set(applied.steps.map((s) => s.uuid));
    assert.ok(uuids.has('u1'), 'local record u1 must remain recoverable');
    assert.ok(uuids.has('u2'), 'incoming record u2 must remain recoverable');

    // The retained snapshot is preserved and surfaced.
    assert.deepStrictEqual(state.snapshots['proj-1'], snapshotBefore);
    assert.equal(result.retained, state.snapshots['proj-1']);
  });

  it('resolving a project-level conflict retains step records from both sides across recordings (regression example)', () => {
    const localVer = {
      project_id: 'proj-9',
      name: 'P (local)',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'rec-a',
          name: 'A',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'L1', logical_id: 'a', step_number: 0, deleted: false }],
        },
      ],
    };
    const incomingVer = {
      project_id: 'proj-9',
      name: 'P (server)',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'rec-a',
          name: 'A',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'R1', logical_id: 'a', step_number: 0, deleted: false }],
        },
      ],
    };
    const resolvedState = {
      project_id: 'proj-9',
      name: 'P (merged)',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'rec-a',
          name: 'A',
          created_at: FIXED_CREATED_AT,
          steps: [
            { uuid: 'L1', logical_id: 'a', step_number: 0, deleted: false },
            { uuid: 'R1', logical_id: 'a', step_number: 0, deleted: false },
          ],
        },
      ],
    };

    const state = createEmptySyncState();
    upsertConflict(state, 'proj-9', localVer, incomingVer, FIXED_NOW);

    const result = resolveConflict(state, [localVer], 'proj-9', resolvedState, { now: FIXED_NOW });

    assert.equal(result.ok, true);
    assert.equal(getItem(state, 'proj-9'), null);

    const proj = result.projects.find((p) => p.project_id === 'proj-9');
    const uuids = new Set(proj.recordings.flatMap((r) => r.steps.map((s) => s.uuid)));
    assert.ok(uuids.has('L1'), 'local record L1 must remain recoverable');
    assert.ok(uuids.has('R1'), 'incoming record R1 must remain recoverable');
    // No snapshot seeded ⇒ no project-level recovery handle surfaced.
    assert.equal(result.retained, null);
  });
});
