/**
 * resolve-explicit-logical-id.property.test.js — Property test for explicit,
 * per-`logical_id` Conflict_Resolution (`resolveConflict`).
 *
 * When the local and incoming versions of a Unit contain DIFFERENT records for
 * the same `logical_id` (a genuine per-step divergence), the resolution must be
 * the user's: the Sync_Client never picks a winner on its own and never silently
 * combines the two histories. `resolveConflict` enforces this in two ways, both
 * pinned here:
 *
 *   1. EXPLICIT INPUT REQUIRED (R11.4) — a Conflict opened with no chosen
 *      `resolvedState` (null/undefined) is rejected as `no-resolution` and leaves
 *      every part of the store and the local projects entirely unchanged. There
 *      is no default winner for a differing `logical_id`; the user must choose.
 *
 *   2. HISTORIES ARE NEVER AUTO-UNIONED (R11.5) — `resolveConflict` never
 *      fabricates a combined history. It only ADOPTS the exact state the caller
 *      supplies, and it requires that state to retain every record from BOTH
 *      sides (an append-only superset). A chosen state that drops either side's
 *      records is rejected (`not-appendable`) rather than silently repaired by
 *      unioning the histories — so the only way the two histories are ever
 *      combined is when the user explicitly supplies that combination, and the
 *      adopted state is then byte-for-byte the state they supplied.
 *
 * The property drives arbitrary Conflicts (recording-level and project-level)
 * whose local and incoming versions hold different version records for the same
 * set of `logical_id`s, and asserts (1) and (2) on the same scenario.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generator conventions in the sibling property tests.
 *
 * **Validates: Requirements 11.4, 11.5**
 */

// Feature: sync-conflict-resolution, Property 21: Differing per-logical_id records require explicit input; histories are never auto-unioned

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { resolveConflict, DELETE_RESOLUTION } from '../../conflict-resolution.js';
import { createEmptySyncState, upsertConflict, getItem } from '../../sync-store.js';
import { getBaseline } from '../../sync-baseline.js';
import { digestProject } from '../../sync-digest.js';

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';
// A fixed clock so any baseline `agreedAt` stamp is deterministic; the property
// asserts nothing about its value, only that the baseline advanced (or did not).
const FIXED_NOW = () => 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deep, plain-prototype copy via a JSON round-trip (matches how recoverable
 *  copies are actually persisted, so `deepStrictEqual` compares VALUES not
 *  prototype artifacts of fast-check's null-prototype records). */
function jsonNormalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildRecording(recording_id, steps) {
  return { recording_id, name: 'rec', created_at: FIXED_CREATED_AT, steps };
}

function buildProject(project_id, recordings) {
  return { project_id, name: 'proj', created_at: FIXED_CREATED_AT, recordings };
}

function findProject(projects, project_id) {
  return projects.find((p) => p && p.project_id === project_id);
}

// ─── Generators ────────────────────────────────────────────────────────────────

// One shared logical step that has a DIFFERENT version record on each side.
const arbLogical = fc.record({
  logical_id: fc.uuid(),
  localNumber: fc.integer({ min: 0, max: 20 }),
  incomingNumber: fc.integer({ min: 0, max: 20 }),
  localDeleted: fc.boolean(),
  incomingDeleted: fc.boolean(),
});

// At least one shared logical_id so the two sides genuinely differ per-`logical_id`.
const arbLogicals = fc.uniqueArray(arbLogical, {
  selector: (l) => l.logical_id,
  minLength: 1,
  maxLength: 4,
});

// A pool of globally-distinct step uuids (as real UUIDv7s are): two per logical
// step (a local record uuid and a distinct incoming record uuid). 8 covers the
// max of 4 logical steps.
const arbUuidPool = fc.uniqueArray(fc.uuid(), { minLength: 8, maxLength: 8 });

const arbScenario = fc.record({
  level: fc.constantFrom('recording', 'project'),
  project_id: fc.uuid(),
  recording_id: fc.uuid(),
  otherProjectId: fc.uuid(),
  logicals: arbLogicals,
  uuidPool: arbUuidPool,
});

/**
 * Materialize a scenario into concrete inputs. Builds a local version and an
 * incoming version that share the same `logical_id`s but carry DIFFERENT record
 * uuids for each (per-`logical_id` divergence), plus three candidate resolved
 * states the test feeds to `resolveConflict`:
 *   - `unionResolved`        — the explicit append-only superset of BOTH sides
 *                              (the user's "combine both histories" choice).
 *   - `localOnlyResolved`    — only the local history (drops every incoming record).
 *   - `incomingOnlyResolved` — only the incoming history (drops every local record).
 *
 * All objects are JSON-normalized to a plain prototype so `deepStrictEqual`
 * compares values.
 */
function materialize(scenario) {
  const { project_id, recording_id, logicals, uuidPool } = scenario;

  const localSteps = logicals.map((l, i) => ({
    uuid: uuidPool[2 * i],
    logical_id: l.logical_id,
    step_number: l.localNumber,
    deleted: l.localDeleted,
  }));
  const incomingSteps = logicals.map((l, i) => ({
    uuid: uuidPool[2 * i + 1],
    logical_id: l.logical_id,
    step_number: l.incomingNumber,
    deleted: l.incomingDeleted,
  }));
  // The explicit superset: every record from both sides retained (append-only).
  const unionSteps = [...localSteps, ...incomingSteps];

  // An unrelated local project that must never be disturbed by a resolution.
  const otherProjectId =
    scenario.otherProjectId === project_id
      ? `${scenario.otherProjectId}-other`
      : scenario.otherProjectId;
  const otherProject = buildProject(otherProjectId, [
    buildRecording(`${otherProjectId}-rec`, [
      { uuid: `${otherProjectId}-u`, logical_id: 'x', step_number: 0, deleted: false },
    ]),
  ]);

  if (scenario.level === 'recording') {
    const unitRef = `${project_id}:${recording_id}`;
    const localCopy = buildRecording(recording_id, localSteps);
    const incomingCopy = buildRecording(recording_id, incomingSteps);
    const unionResolved = buildRecording(recording_id, unionSteps);
    const localOnlyResolved = buildRecording(recording_id, localSteps);
    const incomingOnlyResolved = buildRecording(recording_id, incomingSteps);

    const localProject = buildProject(project_id, [localCopy]);
    const localProjects = [otherProject, localProject];
    // Adopting the union replaces the target recording with the union recording.
    const expectedAdopted = buildProject(project_id, [unionResolved]);
    // Per-unit resolved-against baseline (R1.4, R1.9): the recording's baseline
    // entry advances to the INCOMING version the user resolved against — NOT the
    // adopted (union) state — so a merge choice reads as changed-local-outgoing
    // next cycle and is pushed. With no prior baseline, the agreed project carries
    // only the resolved recording at its incoming version.
    const expectedBaselineAgreed = buildProject(project_id, [incomingCopy]);

    return jsonNormalize({
      level: 'recording',
      unitRef,
      project_id,
      recording_id,
      otherProjectId,
      localCopy,
      incomingCopy,
      unionResolved,
      localOnlyResolved,
      incomingOnlyResolved,
      localProjects,
      expectedAdopted,
      expectedBaselineAgreed,
    });
  }

  // Project-level: the divergence lives inside a single recording shared by both
  // project copies.
  const unitRef = project_id;
  const localCopy = buildProject(project_id, [buildRecording(recording_id, localSteps)]);
  const incomingCopy = buildProject(project_id, [buildRecording(recording_id, incomingSteps)]);
  const unionResolved = buildProject(project_id, [buildRecording(recording_id, unionSteps)]);
  const localOnlyResolved = buildProject(project_id, [buildRecording(recording_id, localSteps)]);
  const incomingOnlyResolved = buildProject(project_id, [
    buildRecording(recording_id, incomingSteps),
  ]);

  const localProjects = [otherProject, localCopy];
  const expectedAdopted = unionResolved;
  // Per-unit resolved-against baseline (R1.4): a project-level resolution advances
  // the whole project baseline to the INCOMING project the user resolved against,
  // not the adopted (union) state.
  const expectedBaselineAgreed = incomingCopy;

  return jsonNormalize({
    level: 'project',
    unitRef,
    project_id,
    recording_id,
    otherProjectId,
    localCopy,
    incomingCopy,
    unionResolved,
    localOnlyResolved,
    incomingOnlyResolved,
    localProjects,
    expectedAdopted,
    expectedBaselineAgreed,
  });
}

/** Build a fresh store holding exactly this Conflict (no baseline). */
function seedConflict(m) {
  const state = createEmptySyncState();
  upsertConflict(state, m.unitRef, m.localCopy, m.incomingCopy, FIXED_NOW);
  return state;
}

// ─── Property 21 ─────────────────────────────────────────────────────────────

describe('Property 21: Differing per-logical_id records require explicit input; histories are never auto-unioned', () => {
  it('rejects absent resolution, refuses to silently union, and adopts exactly the explicit combined history', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const m = materialize(scenario);

        // ── (1) EXPLICIT INPUT REQUIRED (R11.4) ──────────────────────────────
        // For a Conflict with differing per-`logical_id` records, an absent
        // chosen state is rejected and leaves ALL state unchanged.
        for (const absent of [null, undefined]) {
          const state = seedConflict(m);
          const projectsBefore = JSON.stringify(m.localProjects);
          const conflictBefore = JSON.stringify(state.conflicts[m.unitRef]);

          const result = resolveConflict(state, m.localProjects, m.unitRef, absent, {
            now: FIXED_NOW,
          });

          assert.equal(result.ok, false, 'absent resolution must be rejected');
          assert.equal(result.kind, 'conflict');
          assert.equal(result.reason, 'no-resolution', 'reason must be no-resolution');
          // No winner was chosen: the Conflict is still pending, the baseline was
          // never advanced, and the local projects are untouched (same ref + value).
          assert.ok(state.conflicts[m.unitRef], 'the Conflict must remain pending');
          assert.equal(JSON.stringify(state.conflicts[m.unitRef]), conflictBefore);
          assert.equal(getBaseline(state, m.project_id), null, 'no baseline may be advanced');
          assert.equal(result.projects, m.localProjects, 'projects array returned unchanged (ref)');
          assert.equal(
            JSON.stringify(m.localProjects),
            projectsBefore,
            'projects unchanged (value)',
          );
        }

        // ── (2) HISTORIES ARE NEVER AUTO-UNIONED (R11.5) ─────────────────────
        // A chosen state that drops EITHER side's records is rejected, never
        // silently repaired by combining the histories.
        for (const dropping of [m.localOnlyResolved, m.incomingOnlyResolved]) {
          const state = seedConflict(m);
          const projectsBefore = JSON.stringify(m.localProjects);
          const conflictBefore = JSON.stringify(state.conflicts[m.unitRef]);

          const result = resolveConflict(state, m.localProjects, m.unitRef, dropping, {
            now: FIXED_NOW,
          });

          assert.equal(result.ok, false, 'a state dropping either side must be rejected');
          assert.equal(result.reason, 'not-appendable', 'reason must be not-appendable');
          // The store is not auto-unioned to repair the dropped side: the
          // Conflict is still pending and nothing was adopted.
          assert.ok(state.conflicts[m.unitRef], 'the Conflict must remain pending');
          assert.equal(JSON.stringify(state.conflicts[m.unitRef]), conflictBefore);
          assert.equal(getBaseline(state, m.project_id), null, 'no baseline may be advanced');
          assert.equal(result.projects, m.localProjects, 'projects array returned unchanged (ref)');
          assert.equal(
            JSON.stringify(m.localProjects),
            projectsBefore,
            'projects unchanged (value)',
          );
        }

        // ── (3) The combined history is adopted ONLY when explicitly supplied ─
        // Supplying the explicit append-only superset succeeds and adopts EXACTLY
        // that state — the combination exists only because the user supplied it.
        {
          const state = seedConflict(m);
          const result = resolveConflict(state, m.localProjects, m.unitRef, m.unionResolved, {
            now: FIXED_NOW,
          });

          assert.equal(result.ok, true, 'an explicit append-only superset must be adopted');
          assert.equal(result.kind, 'conflict');
          assert.equal(result.reason, null);

          // The adopted Unit equals the supplied state byte-for-byte (nothing the
          // module computed on its own).
          const adoptedProject = findProject(result.projects, m.project_id);
          assert.ok(adoptedProject, 'the affected project must be present after adoption');
          if (m.level === 'recording') {
            const adoptedRecording = adoptedProject.recordings.find(
              (r) => r.recording_id === m.recording_id,
            );
            assert.deepStrictEqual(
              adoptedRecording,
              m.unionResolved,
              'the adopted recording must equal the explicitly-supplied combined history',
            );
          } else {
            assert.deepStrictEqual(
              adoptedProject,
              m.unionResolved,
              'the adopted project must equal the explicitly-supplied combined history',
            );
          }
          assert.deepStrictEqual(
            adoptedProject,
            m.expectedAdopted,
            'the adopted project must equal exactly the supplied combined state',
          );

          // The baseline is advanced PER-UNIT to the RESOLVED-AGAINST INCOMING
          // version (R1.4, R1.9), NOT the adopted (union) state, and the Conflict
          // is cleared.
          const baseline = getBaseline(state, m.project_id);
          assert.ok(baseline, 'the baseline must be advanced to the resolved-against version');
          assert.deepStrictEqual(baseline.agreedState, m.expectedBaselineAgreed);
          assert.equal(baseline.digest, digestProject(m.expectedBaselineAgreed));
          assert.equal(getItem(state, m.unitRef), null, 'the resolved Conflict must be cleared');

          // The unrelated project is never disturbed.
          const otherBefore = findProject(m.localProjects, m.otherProjectId);
          assert.deepStrictEqual(
            findProject(result.projects, m.otherProjectId),
            otherBefore,
            'an unrelated project must be untouched',
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  // ─── Regression examples ──────────────────────────────────────────────────

  it('a differing recording-level Conflict has no default winner — absent resolution is rejected unchanged (regression example)', () => {
    const local = buildRecording('rec-1', [
      { uuid: 'u-local', logical_id: 'a', step_number: 0, deleted: false },
    ]);
    const incoming = buildRecording('rec-1', [
      { uuid: 'u-incoming', logical_id: 'a', step_number: 0, deleted: false },
    ]);
    const projects = [buildProject('proj-1', [local])];
    const projectsBefore = JSON.stringify(projects);

    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', local, incoming, FIXED_NOW);

    const result = resolveConflict(state, projects, 'proj-1:rec-1', null, { now: FIXED_NOW });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-resolution');
    assert.ok(state.conflicts['proj-1:rec-1'], 'the Conflict must remain pending');
    assert.equal(getBaseline(state, 'proj-1'), null);
    assert.equal(JSON.stringify(projects), projectsBefore, 'local projects must be unchanged');
  });

  it('supplying only one side of a differing Conflict is rejected, not silently unioned (regression example)', () => {
    const local = buildRecording('rec-1', [
      { uuid: 'u-local', logical_id: 'a', step_number: 0, deleted: false },
    ]);
    const incoming = buildRecording('rec-1', [
      { uuid: 'u-incoming', logical_id: 'a', step_number: 0, deleted: false },
    ]);
    const projects = [buildProject('proj-1', [local])];

    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', local, incoming, FIXED_NOW);

    // The user supplies only the local history — dropping the incoming record.
    const result = resolveConflict(state, projects, 'proj-1:rec-1', local, { now: FIXED_NOW });

    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      'not-appendable',
      'the module must not auto-union the dropped side',
    );
    assert.ok(state.conflicts['proj-1:rec-1'], 'the Conflict must remain pending');
    assert.equal(getBaseline(state, 'proj-1'), null);
  });

  it('the explicit append-only superset (combine both) is adopted exactly (regression example)', () => {
    const localStep = { uuid: 'u-local', logical_id: 'a', step_number: 0, deleted: false };
    const incomingStep = { uuid: 'u-incoming', logical_id: 'a', step_number: 0, deleted: false };
    const local = buildRecording('rec-1', [localStep]);
    const incoming = buildRecording('rec-1', [incomingStep]);
    const projects = [buildProject('proj-1', [local])];

    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', local, incoming, FIXED_NOW);

    // The user explicitly combines both histories.
    const combined = buildRecording('rec-1', [localStep, incomingStep]);
    const result = resolveConflict(state, projects, 'proj-1:rec-1', combined, { now: FIXED_NOW });

    assert.equal(result.ok, true);
    const adoptedRecording = result.projects[0].recordings.find((r) => r.recording_id === 'rec-1');
    assert.deepStrictEqual(
      adoptedRecording,
      combined,
      'the adopted recording must equal the supplied combined history',
    );
    assert.equal(getItem(state, 'proj-1:rec-1'), null, 'the resolved Conflict must be cleared');
    const baseline = getBaseline(state, 'proj-1');
    assert.ok(baseline);
    // Per-unit resolved-against baseline (R1.4, R1.9): the baseline advances to the
    // INCOMING recording the user resolved against, not the adopted (combined)
    // state, so the merged recording reads as changed-local-outgoing next cycle.
    assert.equal(baseline.digest, digestProject(buildProject('proj-1', [incoming])));
  });

  // Reference DELETE_RESOLUTION so the explicit-choice sentinel stays imported as
  // documentation that resolution defaults to neither keep nor delete (R11.4).
  it('DELETE_RESOLUTION is an explicit, deletion-only choice (not a default)', () => {
    assert.equal(DELETE_RESOLUTION.deleted, true);
  });
});
