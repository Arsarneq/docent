/**
 * resolution-append-only-tombstone.property.test.js — Property test for the
 * append-only and tombstone safety guarantees of Conflict_Resolution
 * (`resolveConflict`).
 *
 * Resolving a recording adopts the user's explicitly chosen resolved state. That
 * adoption must never corrupt the append-only step model that the rest of Docent
 * depends on (`session.js`): the resolved history must RETAIN every step record
 * present in both conflicting histories (it is expressed through the latest
 * active version per `logical_id` over an append-only history, never by dropping
 * records), and any step tombstoned in the chosen state must STAY tombstoned —
 * a deleted step is never resurrected back into the user-visible Active View.
 *
 * This property drives `resolveConflict` over arbitrary CONFLICTING step
 * histories — built with re-records (multiple version records sharing a
 * `logical_id`) and tombstones (`deleted: true` records) split across the local
 * and incoming sides — and a chosen resolved state that is an append-only
 * superset of both. For any such resolution it asserts:
 *
 *   1. APPEND-ONLY (R11.1) — the resolved recording's step history is a superset
 *      of the input records: every step `uuid` present in either conflicting
 *      history survives into the resolved history. A chosen state that DROPS a
 *      record from the conflicting histories is rejected as `not-appendable` and
 *      leaves the store and projects entirely unchanged (a second property).
 *   2. AT MOST ONE ACTIVE STEP PER `logical_id` (R11.3) — the Active View produced
 *      by `resolveActiveSteps` contains no `logical_id` twice.
 *   3. TOMBSTONES STAY TOMBSTONED (R11.2) — for every `logical_id` whose latest
 *      version (highest `uuid`) in the chosen state is a tombstone, that
 *      `logical_id` is absent from the Active View; and every `logical_id` whose
 *      latest version is live surfaces, as that exact active version.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generator conventions in the sibling property tests.
 *
 * **Validates: Requirements 11.1, 11.2, 11.3**
 */

// Feature: sync-conflict-resolution, Property 20: Resolution preserves append-only history and never resurrects tombstones

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { resolveConflict } from '../../conflict-resolution.js';
import { createEmptySyncState, upsertConflict, getItem } from '../../sync-store.js';
import { getBaseline } from '../../sync-baseline.js';
import { resolveActiveSteps } from '../../lib/session.js';

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';

// A fixed clock so the baseline `agreedAt` stamp is deterministic; the property
// asserts nothing about its value, only the append-only / tombstone invariants.
const FIXED_NOW = () => 0;

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * A pool record: a committed step version plus a `role` saying which side(s) of
 * the conflict it belongs to. A small `logical_id` alphabet forces re-records
 * (several version records per logical step); a free `deleted` flag produces
 * tombstones, including cases where the latest version of a logical step is a
 * tombstone. `uuid`s are globally unique across the pool so "latest version per
 * `logical_id`" (max `uuid`) is unambiguous.
 *
 *   - role 'local'    → appears only in the local history
 *   - role 'incoming' → appears only in the incoming history
 *   - role 'both'     → a converged record present in both histories
 *   - role 'extra'    → an additional record the chosen state appended on top of
 *                       both histories (a strict append-only superset)
 */
const arbPoolRecord = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 8 }),
  deleted: fc.boolean(),
  role: fc.constantFrom('local', 'incoming', 'both', 'extra'),
});

/** A pool record without a `local`/`incoming`/`both` distinction → always present. */
const arbPresentRecord = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 8 }),
  deleted: fc.boolean(),
  role: fc.constantFrom('local', 'incoming', 'both'),
});

/** Strip the generator-only `role` field, leaving a clean step record. */
function strip({ uuid, logical_id, step_number, deleted }) {
  return { uuid, logical_id, step_number, deleted };
}

/** Build a RecordingCopy from an id and a committed step history. */
function buildRecording(recording_id, steps) {
  return {
    recording_id,
    name: `rec-${recording_id.slice(0, 8)}`,
    created_at: FIXED_CREATED_AT,
    steps,
  };
}

/** Build a single-recording ProjectCopy holding `recording`. */
function buildProject(project_id, recording) {
  return {
    project_id,
    name: `proj-${project_id.slice(0, 8)}`,
    created_at: FIXED_CREATED_AT,
    recordings: [recording],
  };
}

/** Deep, plain-prototype copy via a JSON round-trip (matches how the module stores copies). */
function jsonNormalize(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The latest (highest-`uuid`) version record per `logical_id` in a step history.
 * This is the independent reference for "active version per `logical_id`",
 * computed exactly as `session.js` defines it (max `uuid` by string order), used
 * to verify the Active View rather than reproduce its array.
 */
function latestPerLogicalId(steps) {
  const latest = new Map();
  for (const step of steps) {
    const existing = latest.get(step.logical_id);
    if (!existing || step.uuid > existing.uuid) latest.set(step.logical_id, step);
  }
  return latest;
}

/**
 * Assert the append-only / tombstone invariants for one resolved recording
 * against its two conflicting input histories.
 */
function assertResolvedRecording(resolved, localSteps, incomingSteps) {
  // (1) APPEND-ONLY (R11.1): every input step uuid survives into the resolved history.
  const present = new Set(resolved.steps.map((s) => s.uuid));
  for (const s of localSteps) {
    assert.ok(present.has(s.uuid), `local step ${s.uuid} must survive into the resolved history`);
  }
  for (const s of incomingSteps) {
    assert.ok(
      present.has(s.uuid),
      `incoming step ${s.uuid} must survive into the resolved history`,
    );
  }

  const active = resolveActiveSteps(resolved);

  // (2) AT MOST ONE ACTIVE STEP PER logical_id (R11.3) + every active step is live.
  const seen = new Set();
  for (const s of active) {
    assert.ok(
      !seen.has(s.logical_id),
      `logical_id ${s.logical_id} appears more than once in the Active View`,
    );
    seen.add(s.logical_id);
    assert.notEqual(s.deleted, true, 'an Active View step must never be a tombstone');
  }
  // Active View is ordered by step_number ascending.
  for (let i = 1; i < active.length; i++) {
    assert.ok(
      active[i - 1].step_number <= active[i].step_number,
      'Active View must be sorted by step_number',
    );
  }

  // (3) TOMBSTONES STAY TOMBSTONED (R11.2) + live latest versions surface exactly.
  const latest = latestPerLogicalId(resolved.steps);
  for (const [logical_id, record] of latest) {
    const inActive = active.find((a) => a.logical_id === logical_id);
    if (record.deleted) {
      assert.equal(
        inActive,
        undefined,
        `tombstoned logical_id ${logical_id} must be absent from the Active View`,
      );
    } else {
      assert.ok(inActive, `live logical_id ${logical_id} must surface in the Active View`);
      assert.equal(
        inActive.uuid,
        record.uuid,
        'the surfaced active version must be the latest (highest-uuid) record',
      );
    }
  }
}

// ─── Property 20: success path ────────────────────────────────────────────────

describe('Property 20: Resolution preserves append-only history and never resurrects tombstones', () => {
  it('resolving to an append-only superset keeps every record, yields ≤1 active step per logical_id, and keeps tombstones tombstoned', () => {
    fc.assert(
      fc.property(
        fc.record({
          project_id: fc.uuid(),
          recording_id: fc.uuid(),
          pool: fc.uniqueArray(arbPoolRecord, { selector: (s) => s.uuid, maxLength: 16 }),
        }),
        (scenario) => {
          const { project_id, recording_id, pool } = scenario;
          const unitRef = `${project_id}:${recording_id}`;

          // Conflicting histories: local = local|both, incoming = incoming|both,
          // resolved = the full append-only superset (everything, incl. extras).
          const localSteps = pool.filter((r) => r.role === 'local' || r.role === 'both').map(strip);
          const incomingSteps = pool
            .filter((r) => r.role === 'incoming' || r.role === 'both')
            .map(strip);
          const resolvedSteps = pool.map(strip);

          const localRec = buildRecording(recording_id, localSteps);
          const incomingRec = buildRecording(recording_id, incomingSteps);
          const resolvedRec = buildRecording(recording_id, resolvedSteps);
          const localProjects = [buildProject(project_id, localRec)];

          const m = jsonNormalize({ localRec, incomingRec, resolvedRec, localProjects });

          // Record the diverged Conflict retaining both histories (R5.2).
          const state = createEmptySyncState();
          upsertConflict(state, unitRef, m.localRec, m.incomingRec, FIXED_NOW);

          const inputSnapshot = structuredClone(m.localProjects);

          const result = resolveConflict(state, m.localProjects, unitRef, m.resolvedRec, {
            now: FIXED_NOW,
          });

          // ── Resolution succeeds on the keep/merge path (not a deletion). ────
          assert.equal(result.ok, true, 'resolving to an append-only superset must succeed');
          assert.equal(result.kind, 'conflict');
          assert.equal(result.reason, null);
          assert.notEqual(result.removed, true, 'the keep path must not flag a removal');

          // The chosen state is applied verbatim to the affected recording.
          const proj = result.projects.find((p) => p.project_id === project_id);
          assert.ok(proj, 'the affected project must be present after resolution');
          const rec = proj.recordings.find((r) => r.recording_id === recording_id);
          assert.ok(rec, 'the affected recording must be present after resolution');
          assert.deepStrictEqual(
            rec,
            m.resolvedRec,
            'the resolved recording must equal the chosen state',
          );

          // ── The append-only / tombstone invariants (R11.1, R11.2, R11.3). ──
          assertResolvedRecording(rec, m.localRec.steps, m.incomingRec.steps);

          // The Conflict is cleared and the input projects array is untouched.
          assert.equal(getItem(state, unitRef), null, 'a resolved Conflict must be cleared');
          assert.deepStrictEqual(
            m.localProjects,
            inputSnapshot,
            'input projects must not be mutated in place',
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // ─── Property 20: a record-dropping state is rejected (append-only guard) ────

  it('rejects a chosen state that drops a conflicting record as not-appendable, leaving the store and projects unchanged', () => {
    fc.assert(
      fc.property(
        fc.record({
          project_id: fc.uuid(),
          recording_id: fc.uuid(),
          pool: fc.uniqueArray(arbPresentRecord, {
            selector: (s) => s.uuid,
            minLength: 1,
            maxLength: 12,
          }),
          dropIndex: fc.nat(),
        }),
        (scenario) => {
          const { project_id, recording_id, pool, dropIndex } = scenario;
          const unitRef = `${project_id}:${recording_id}`;

          const localSteps = pool.filter((r) => r.role === 'local' || r.role === 'both').map(strip);
          const incomingSteps = pool
            .filter((r) => r.role === 'incoming' || r.role === 'both')
            .map(strip);

          // Drop exactly one record that exists in the conflicting histories; its
          // uuid is unique, so the resolved history is genuinely missing it.
          const dropAt = dropIndex % pool.length;
          const resolvedSteps = pool.filter((_, i) => i !== dropAt).map(strip);

          const localRec = buildRecording(recording_id, localSteps);
          const incomingRec = buildRecording(recording_id, incomingSteps);
          const resolvedRec = buildRecording(recording_id, resolvedSteps);
          const localProjects = [buildProject(project_id, localRec)];

          const m = jsonNormalize({ localRec, incomingRec, resolvedRec, localProjects });

          const state = createEmptySyncState();
          upsertConflict(state, unitRef, m.localRec, m.incomingRec, FIXED_NOW);
          const stateBefore = structuredClone(state);

          const result = resolveConflict(state, m.localProjects, unitRef, m.resolvedRec, {
            now: FIXED_NOW,
          });

          // The dropped record would lose a version → rejected, nothing changed.
          assert.equal(result.ok, false, 'dropping a conflicting record must be rejected');
          assert.equal(result.kind, 'conflict');
          assert.equal(result.reason, 'not-appendable');
          assert.equal(
            result.projects,
            m.localProjects,
            'projects must be returned unchanged (same ref)',
          );

          // The Conflict is left pending and the store is byte-identical (R9.4, R12.6).
          const item = getItem(state, unitRef);
          assert.ok(item && item.kind === 'conflict', 'the Conflict must remain pending');
          assert.deepStrictEqual(state, stateBefore, 'the store must be left entirely unchanged');
          assert.equal(
            getBaseline(state, project_id),
            null,
            'no baseline must be advanced on a rejected resolution',
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // ─── Regression examples ──────────────────────────────────────────────────

  it('keeps a step tombstoned in the chosen state out of the Active View (regression example)', () => {
    // logical 'a': created (u1), re-recorded (u2), then tombstoned (u3) — latest is the tombstone.
    // logical 'b': created (u4) and live.
    const localRec = {
      recording_id: 'rec-1',
      name: 'Local',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const incomingRec = {
      recording_id: 'rec-1',
      name: 'Incoming',
      created_at: FIXED_CREATED_AT,
      steps: [
        { uuid: 'u2', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'u3', logical_id: 'a', step_number: 0, deleted: true },
        { uuid: 'u4', logical_id: 'b', step_number: 1, deleted: false },
      ],
    };
    // The user's chosen append-only superset: all four records retained.
    const resolvedRec = {
      recording_id: 'rec-1',
      name: 'Resolved',
      created_at: FIXED_CREATED_AT,
      steps: [
        { uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'u2', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'u3', logical_id: 'a', step_number: 0, deleted: true },
        { uuid: 'u4', logical_id: 'b', step_number: 1, deleted: false },
      ],
    };

    const project = {
      project_id: 'proj-1',
      name: 'P',
      created_at: FIXED_CREATED_AT,
      recordings: [localRec],
    };
    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', localRec, incomingRec, FIXED_NOW);

    const result = resolveConflict(state, [project], 'proj-1:rec-1', resolvedRec, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    const rec = result.projects[0].recordings.find((r) => r.recording_id === 'rec-1');
    // All input records survive (append-only).
    assert.deepStrictEqual(rec.steps.map((s) => s.uuid).sort(), ['u1', 'u2', 'u3', 'u4']);
    const active = resolveActiveSteps(rec);
    // The tombstoned step 'a' is NOT resurrected; only the live 'b' surfaces.
    assert.deepStrictEqual(
      active.map((s) => s.logical_id),
      ['b'],
    );
    assert.equal(active[0].uuid, 'u4');
    assertResolvedRecording(rec, localRec.steps, incomingRec.steps);
  });

  it('preserves append-only history and tombstones for a project-level conflict (regression example)', () => {
    // Recording r1: latest version of 'a' is a tombstone → must not surface.
    // Recording r2: a simple live step.
    const localProject = {
      project_id: 'proj-2',
      name: 'Local',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'r1',
          name: 'R1',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'a1', logical_id: 'a', step_number: 0, deleted: false }],
        },
        {
          recording_id: 'r2',
          name: 'R2',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'b1', logical_id: 'x', step_number: 0, deleted: false }],
        },
      ],
    };
    const incomingProject = {
      project_id: 'proj-2',
      name: 'Incoming',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'r1',
          name: 'R1',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'a2', logical_id: 'a', step_number: 0, deleted: true }],
        },
        {
          recording_id: 'r2',
          name: 'R2',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'b2', logical_id: 'x', step_number: 0, deleted: false }],
        },
      ],
    };
    // Chosen append-only superset across both recordings.
    const resolvedProject = {
      project_id: 'proj-2',
      name: 'Resolved',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'r1',
          name: 'R1',
          created_at: FIXED_CREATED_AT,
          steps: [
            { uuid: 'a1', logical_id: 'a', step_number: 0, deleted: false },
            { uuid: 'a2', logical_id: 'a', step_number: 0, deleted: true },
          ],
        },
        {
          recording_id: 'r2',
          name: 'R2',
          created_at: FIXED_CREATED_AT,
          steps: [
            { uuid: 'b1', logical_id: 'x', step_number: 0, deleted: false },
            { uuid: 'b2', logical_id: 'x', step_number: 0, deleted: false },
          ],
        },
      ],
    };

    const state = createEmptySyncState();
    upsertConflict(state, 'proj-2', localProject, incomingProject, FIXED_NOW);

    const result = resolveConflict(state, [localProject], 'proj-2', resolvedProject, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    const proj = result.projects.find((p) => p.project_id === 'proj-2');
    assert.deepStrictEqual(proj, resolvedProject);

    const r1 = proj.recordings.find((r) => r.recording_id === 'r1');
    const r2 = proj.recordings.find((r) => r.recording_id === 'r2');

    // r1: tombstone (a2) is the latest version of 'a' → Active View is empty.
    assert.deepStrictEqual(resolveActiveSteps(r1), []);
    assertResolvedRecording(
      r1,
      localProject.recordings[0].steps,
      incomingProject.recordings[0].steps,
    );

    // r2: latest version of 'x' (b2) is live → surfaces, both records retained.
    const r2Active = resolveActiveSteps(r2);
    assert.deepStrictEqual(
      r2Active.map((s) => s.logical_id),
      ['x'],
    );
    assert.equal(r2Active[0].uuid, 'b2');
    assertResolvedRecording(
      r2,
      localProject.recordings[1].steps,
      incomingProject.recordings[1].steps,
    );

    assert.equal(getItem(state, 'proj-2'), null);
  });
});
