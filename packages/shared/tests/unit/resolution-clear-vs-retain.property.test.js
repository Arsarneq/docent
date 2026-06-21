/**
 * resolution-clear-vs-retain.property.test.js — Property test for the
 * clear-vs-retain contract of the user-gated Conflict_Resolution workflow.
 *
 * Resolution is the ONLY place a deferred Unit's data is finally adopted, so its
 * bookkeeping must be exact in both directions:
 *
 *   - COMPLETING a resolution clears the corresponding deferred record, returning
 *     the Unit to the NONE state. If a completed resolution left the
 *     record behind, a later sync cycle would re-surface an already-handled item
 *     as a phantom duplicate.
 *   - A resolution that FAILS or is ABANDONED retains the corresponding record and
 *     leaves all state unchanged. If a failed/abandoned resolution cleared
 *     (or partially applied) the record, the deferred work would be silently lost
 *     even though the user never resolved it.
 *
 * "Completing" spans every successful outcome of the three resolution entry
 * points: accepting a Review (`acceptReview`), declining a Review
 * (`declineReview`), adopting a chosen version of a Conflict (`resolveConflict`
 * keep/merge), and accepting a deletion (`resolveConflict` with DELETE_RESOLUTION).
 * "Failing or abandoning" spans every non-ok outcome: opening an item with the
 * wrong interface, resolving a Conflict with no explicit choice
 * (`no-resolution` — the abandon case), supplying a state that would drop a
 * version (`not-appendable`), and a version that cannot be applied
 * (`apply-failed`).
 *
 * The property drives a generated scenario for each of these cases, then asserts
 * the single invariant: ok ⇒ the target Unit is cleared to NONE (and unrelated
 * deferred items survive); not-ok ⇒ the target record is retained and the whole
 * SyncState (and the local projects array) is byte-for-byte unchanged.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generators in the sibling resolution property tests.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Completing resolution clears state; failing or abandoning retains it

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  acceptReview,
  declineReview,
  resolveConflict,
  DELETE_RESOLUTION,
  itemKind,
} from '../../conflict-resolution.js';
import { createEmptySyncState, upsertReview, upsertConflict, getItem } from '../../sync-store.js';

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';
// A fixed clock so any baseline `agreedAt` stamp written on a successful accept
// or resolve is deterministic; the property asserts nothing about its value.
const FIXED_NOW = () => 0;

// ─── Generators ──────────────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 10 }),
  deleted: fc.boolean(),
});

/** A short, possibly-empty committed step history. */
const arbSteps = fc.array(arbStep, { maxLength: 4 });

/**
 * Every resolution case, paired with whether its outcome should COMPLETE
 * (ok=true → cleared) or FAIL/ABANDON (ok=false → retained):
 *
 *   completing:
 *     - accept-success         accept a Review item
 *     - decline-success        decline a Review item
 *     - resolve-keep-success   adopt an append-only superset of a Conflict
 *     - resolve-delete-success accept the deletion of a Conflict (DELETE_RESOLUTION)
 *   failing / abandoning:
 *     - accept-wrong-interface   accept on a Conflict (wrong interface)
 *     - decline-wrong-interface  decline on a Conflict (wrong interface)
 *     - resolve-wrong-interface  resolveConflict on a Review (wrong interface)
 *     - resolve-no-resolution    resolveConflict with no explicit choice (abandon)
 *     - resolve-not-appendable   resolved state drops a version's step records
 *     - resolve-apply-failed     resolved version cannot be applied (no local project)
 *     - accept-apply-failed      accepted recording has no local project to apply into
 */
const COMPLETING = new Set([
  'accept-success',
  'decline-success',
  'resolve-keep-success',
  'resolve-delete-success',
]);

const arbScenario = fc.record({
  caseType: fc.constantFrom(
    'accept-success',
    'decline-success',
    'resolve-keep-success',
    'resolve-delete-success',
    'accept-wrong-interface',
    'decline-wrong-interface',
    'resolve-wrong-interface',
    'resolve-no-resolution',
    'resolve-not-appendable',
    'resolve-apply-failed',
    'accept-apply-failed',
  ),
  level: fc.constantFrom('recording', 'project'),
  project_id: fc.uuid(),
  recording_id: fc.uuid(),
  localSteps: arbSteps,
  incomingSteps: arbSteps,
  // An unrelated, project-level Review item that must survive every outcome
  // (only the TARGET Unit is ever cleared).
  otherProjectId: fc.uuid(),
  includeOther: fc.boolean(),
});

// ─── Builders (plain-prototype copies) ───────────────────────────────────────

/** Deep, plain-prototype copy via a JSON round-trip. */
function jsonNormalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function recCopy(recording_id, nameSuffix, steps) {
  return { recording_id, name: `rec-${nameSuffix}`, created_at: FIXED_CREATED_AT, steps };
}

function projCopy(project_id, nameSuffix, recordings) {
  return { project_id, name: `proj-${nameSuffix}`, created_at: FIXED_CREATED_AT, recordings };
}

/**
 * Prepend a guaranteed, uniquely-identified step so a history is never empty —
 * this makes the `not-appendable` failure deterministic (an empty resolved state
 * always drops at least this record) and gives the keep/merge superset something
 * concrete to retain on both sides.
 */
function withGuaranteed(prefix, recording_id, steps) {
  return [
    { uuid: `${prefix}-${recording_id}`, logical_id: 'a', step_number: 0, deleted: false },
    ...steps,
  ];
}

/** A recoverable Unit copy at the Unit's own granularity, carrying `steps`. */
function unitCopy(level, ids, nameSuffix, steps) {
  if (level === 'recording') return recCopy(ids.recording_id, nameSuffix, steps);
  return projCopy(ids.project_id, nameSuffix, [recCopy(ids.recording_id, nameSuffix, steps)]);
}

/** The idempotency key for the target Unit. */
function unitRefOf(level, ids) {
  return level === 'recording' ? `${ids.project_id}:${ids.recording_id}` : ids.project_id;
}

/**
 * Materialize a scenario into concrete inputs and the expected outcome.
 * Returns `{ state, projects, unitRef, otherRef, expectSuccess, invoke }` where
 * `invoke()` calls the right resolution entry point against `state`/`projects`.
 */
function materialize(scenario) {
  const { caseType, project_id, recording_id } = scenario;
  const ids = { project_id, recording_id };

  // Two cases are meaningful only at recording granularity (a project-level
  // accept/resolve always finds a home — it adds the project when absent), so
  // force recording-level for the "no local project to apply into" failures.
  const level =
    caseType === 'accept-apply-failed' || caseType === 'resolve-apply-failed'
      ? 'recording'
      : scenario.level;

  const localSteps = withGuaranteed('L', recording_id, scenario.localSteps);
  const incomingSteps = withGuaranteed('I', recording_id, scenario.incomingSteps);

  const localVer = jsonNormalize(unitCopy(level, ids, 'local', localSteps));
  const incomingVer = jsonNormalize(unitCopy(level, ids, 'incoming', incomingSteps));
  const unitRef = unitRefOf(level, ids);

  // A local project that holds the target Unit, present for cases that need a
  // home to apply into, and deliberately ABSENT for the apply-failed cases.
  const includeProject = caseType !== 'accept-apply-failed' && caseType !== 'resolve-apply-failed';
  const targetLocalProject = projCopy(project_id, 'localproj', [
    recCopy(recording_id, 'local', localSteps),
  ]);
  const projects = jsonNormalize(includeProject ? [targetLocalProject] : []);

  // Seed the store with the target deferred record. Review-targeted cases seed a
  // Review; Conflict-targeted cases seed a Conflict — chosen so the failure cases
  // that hinge on the routing guard open the item with the *wrong* interface.
  const state = createEmptySyncState();
  const seedReview =
    caseType === 'accept-success' ||
    caseType === 'decline-success' ||
    caseType === 'accept-apply-failed' ||
    caseType === 'resolve-wrong-interface';
  if (seedReview) {
    upsertReview(state, unitRef, incomingVer, FIXED_NOW);
  } else {
    upsertConflict(state, unitRef, localVer, incomingVer, FIXED_NOW);
  }

  // An unrelated, project-level Review that must be untouched by any outcome.
  const otherRef = scenario.otherProjectId;
  const hasOther = scenario.includeOther && otherRef !== unitRef && otherRef !== project_id;
  if (hasOther) {
    upsertReview(state, otherRef, jsonNormalize(projCopy(otherRef, 'other', [])), FIXED_NOW);
  }

  // An append-only superset of both histories (retains every step uuid), used as
  // the chosen resolved state for keep/merge and apply-failed.
  const mergedSteps = [...localSteps, ...incomingSteps];
  const supersetResolved = jsonNormalize(unitCopy(level, ids, 'merged', mergedSteps));
  // An empty resolved state that DROPS every step uuid → not-appendable.
  const emptyResolved = jsonNormalize(
    level === 'recording' ? recCopy(recording_id, 'empty', []) : projCopy(project_id, 'empty', []),
  );

  let invoke;
  switch (caseType) {
    case 'accept-success':
    case 'accept-wrong-interface':
    case 'accept-apply-failed':
      invoke = () => acceptReview(state, projects, unitRef, { now: FIXED_NOW });
      break;
    case 'decline-success':
    case 'decline-wrong-interface':
      invoke = () => declineReview(state, projects, unitRef);
      break;
    case 'resolve-keep-success':
    case 'resolve-apply-failed':
    case 'resolve-wrong-interface':
      invoke = () =>
        resolveConflict(state, projects, unitRef, supersetResolved, { now: FIXED_NOW });
      break;
    case 'resolve-delete-success':
      invoke = () =>
        resolveConflict(state, projects, unitRef, DELETE_RESOLUTION, { now: FIXED_NOW });
      break;
    case 'resolve-no-resolution':
      invoke = () => resolveConflict(state, projects, unitRef, null, { now: FIXED_NOW });
      break;
    case 'resolve-not-appendable':
      invoke = () => resolveConflict(state, projects, unitRef, emptyResolved, { now: FIXED_NOW });
      break;
    default:
      throw new Error(`unhandled caseType: ${caseType}`);
  }

  return {
    state,
    projects,
    unitRef,
    otherRef: hasOther ? otherRef : null,
    expectSuccess: COMPLETING.has(caseType),
    invoke,
    caseType,
  };
}

// The non-ok reasons a failed/abandoned resolution may report.
const FAILURE_REASONS = new Set([
  'wrong-interface',
  'no-resolution',
  'not-appendable',
  'apply-failed',
]);

describe('Completing resolution clears state; failing or abandoning retains it', () => {
  it('a completed resolution clears the target item; a failed or abandoned one retains it and changes nothing', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const m = materialize(scenario);

        // Snapshot the full store and the local projects array BEFORE acting, so
        // a failed/abandoned resolution can be proven to change nothing.
        const stateBefore = JSON.stringify(m.state);
        const projectsBefore = JSON.stringify(m.projects);

        const result = m.invoke();

        if (m.expectSuccess) {
          // ── completing resolution clears the deferred record ───────
          assert.equal(result.ok, true, `${m.caseType} should complete successfully`);
          assert.equal(
            getItem(m.state, m.unitRef),
            null,
            `${m.caseType}: a completed resolution must clear the item (Unit → NONE)`,
          );
          assert.equal(
            itemKind(m.state, m.unitRef),
            null,
            `${m.caseType}: the cleared Unit must route to neither interface`,
          );

          // Only the target Unit is cleared — an unrelated deferred item survives.
          if (m.otherRef) {
            assert.notEqual(
              getItem(m.state, m.otherRef),
              null,
              `${m.caseType}: an unrelated deferred item must survive`,
            );
          }
        } else {
          // ── a failed/abandoned resolution retains the record ───────
          assert.equal(result.ok, false, `${m.caseType} should not complete`);
          assert.ok(
            FAILURE_REASONS.has(result.reason),
            `${m.caseType}: unexpected failure reason ${result.reason}`,
          );

          const retained = getItem(m.state, m.unitRef);
          assert.notEqual(
            retained,
            null,
            `${m.caseType}: a failed/abandoned resolution must retain the item`,
          );

          // The whole store is byte-for-byte unchanged — nothing applied, no
          // baseline advanced, no record cleared or rewritten.
          assert.equal(
            JSON.stringify(m.state),
            stateBefore,
            `${m.caseType}: a failed/abandoned resolution must leave state unchanged`,
          );
          // The local projects array is neither mutated nor replaced.
          assert.equal(
            JSON.stringify(m.projects),
            projectsBefore,
            `${m.caseType}: the local projects array must be unchanged`,
          );
          assert.equal(
            JSON.stringify(result.projects),
            projectsBefore,
            `${m.caseType}: the returned projects must equal the unchanged input`,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  // ─── Regression examples ──────────────────────────────────────────────────

  it('accepting a Review clears it; declining a Review clears it (completing → NONE)', () => {
    const incoming = {
      recording_id: 'rec-1',
      name: 'Add to cart (server)',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const project = {
      project_id: 'proj-1',
      name: 'Checkout',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'rec-1',
          name: 'Add to cart',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'u0', logical_id: 'a', step_number: 0, deleted: false }],
        },
      ],
    };

    const accepted = createEmptySyncState();
    upsertReview(accepted, 'proj-1:rec-1', incoming, FIXED_NOW);
    const acc = acceptReview(accepted, [project], 'proj-1:rec-1', { now: FIXED_NOW });
    assert.equal(acc.ok, true);
    assert.equal(getItem(accepted, 'proj-1:rec-1'), null);

    const declined = createEmptySyncState();
    upsertReview(declined, 'proj-1:rec-1', incoming, FIXED_NOW);
    const dec = declineReview(declined, [project], 'proj-1:rec-1');
    assert.equal(dec.ok, true);
    assert.equal(getItem(declined, 'proj-1:rec-1'), null);
  });

  it('abandoning a Conflict with no choice retains it and changes nothing (no-resolution → retained)', () => {
    const local = {
      recording_id: 'rec-1',
      name: 'local',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'L-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const incoming = {
      recording_id: 'rec-1',
      name: 'incoming',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'I-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', local, incoming, FIXED_NOW);
    const before = JSON.stringify(state);

    const result = resolveConflict(state, [], 'proj-1:rec-1', null, { now: FIXED_NOW });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-resolution');
    assert.notEqual(getItem(state, 'proj-1:rec-1'), null);
    assert.equal(JSON.stringify(state), before);
  });

  it('a not-appendable resolution that would drop a version retains the Conflict (not-appendable → retained)', () => {
    const local = {
      recording_id: 'rec-1',
      name: 'local',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'L-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const incoming = {
      recording_id: 'rec-1',
      name: 'incoming',
      created_at: FIXED_CREATED_AT,
      steps: [{ uuid: 'I-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', local, incoming, FIXED_NOW);
    const before = JSON.stringify(state);

    // An empty resolved recording drops both 'L-1' and 'I-1' → not-appendable.
    const empty = { recording_id: 'rec-1', name: 'empty', created_at: FIXED_CREATED_AT, steps: [] };
    const result = resolveConflict(state, [], 'proj-1:rec-1', empty, { now: FIXED_NOW });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-appendable');
    assert.notEqual(getItem(state, 'proj-1:rec-1'), null);
    assert.equal(JSON.stringify(state), before);
  });
});
