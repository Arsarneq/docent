/**
 * attention-indicator-derivation.property.test.js — Property test for the
 * derivation of sync-state attention indicators from a SyncState.
 *
 * The Docent_UI surfaces which Units need the user's attention and distinguishes
 * a Review-and-Accept item from a Conflict (R13.1). `deriveIndicators` is the
 * pure half of that surface: from the durable `SyncState` it works out exactly
 * which Units need attention, labels each Review vs Conflict, and tags each with
 * the row it belongs on. The two lookups (`getProjectIndicator` /
 * `getRecordingIndicator`) then drive what each project row and recording row
 * shows. This must hold:
 *
 *   - EXACT + LABELLED (R13.1) — the indicators mark exactly the Units recorded
 *     in `reviews` ∪ `conflicts`, never more and never fewer, each labelled
 *     `'review'` or `'conflict'` by its record type and placed on the correct
 *     row level (`'project'` for a project Unit, `'recording'` for a recording).
 *   - RECORDING ALWAYS SHOWN (R13.4) — a recording needing attention always has
 *     a recording-level indicator, whether or not its project also needs one.
 *   - PROJECT ONLY WHEN THE PROJECT UNIT ITSELF NEEDS ATTENTION (R13.4 / R13.5) —
 *     a project row shows an indicator iff the project Unit itself is in review
 *     or conflict. A project whose only attention is in a child recording gets
 *     NO project-level indicator (R13.4); a project that itself needs attention
 *     shows the project-level indicator in addition to any recording-level ones
 *     (R13.5).
 *
 * The expected indicator set is re-derived independently from the generated
 * scenario (not from the implementation) and used as the oracle.
 *
 * Uses Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()` for
 * ids).
 *
 * **Validates: Requirements 13.1, 13.4, 13.5**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 24: Attention indicators are derived correctly and distinguish review from conflict

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  deriveIndicators,
  getProjectIndicator,
  getRecordingIndicator,
} from '../../sync-conflict-ui.js';

// ─── Generators ──────────────────────────────────────────────────────────────

const FIXED_AT = '2024-01-01T00:00:00.000Z';

/** A deferred item is either a Review-and-Accept item or a Conflict. */
const arbKind = fc.constantFrom('review', 'conflict');

/**
 * One project's attention picture:
 *   - `projectItem`  — `null` when the project Unit itself needs NO attention,
 *                      otherwise the kind of the project-level deferred item.
 *   - `recordings`   — the recording-level deferred items under this project,
 *                      each with a unique recording_id and its own kind.
 *
 * Drawing the project-level item independently of the recording-level items is
 * what makes the two distinguishing cases (R13.4: children-only, no project
 * badge; R13.5: project + child both flagged) arise frequently.
 */
const arbProjectAttention = fc.record({
  project_id: fc.uuid(),
  projectItem: fc.option(arbKind, { nil: null }),
  recordings: fc.uniqueArray(fc.record({ recording_id: fc.uuid(), kind: arbKind }), {
    selector: (r) => r.recording_id,
    maxLength: 4,
  }),
});

/** A whole scenario: several distinct projects, each with its attention picture. */
const arbScenario = fc.uniqueArray(arbProjectAttention, {
  selector: (p) => p.project_id,
  maxLength: 4,
});

// ─── Materialization: scenario → well-formed SyncState ───────────────────────

/** A recoverable recording copy (only its shape matters; ignored by derivation). */
function recordingCopy(recording_id) {
  return {
    recording_id,
    name: `rec-${recording_id.slice(0, 4)}`,
    created_at: FIXED_AT,
    steps: [],
  };
}

/** A recoverable project copy. */
function projectCopy(project_id) {
  return {
    project_id,
    name: `proj-${project_id.slice(0, 4)}`,
    created_at: FIXED_AT,
    recordings: [],
  };
}

/** Build a Review-and-Accept or Conflict record for a Unit. */
function makeItem(kind, unitRef, project_id, recording_id) {
  const copy = recording_id == null ? projectCopy(project_id) : recordingCopy(recording_id);
  if (kind === 'conflict') {
    return {
      kind: 'conflict',
      unitRef,
      project_id,
      recording_id,
      local: copy,
      incoming: copy,
      detectedAt: FIXED_AT,
    };
  }
  return {
    kind: 'review',
    unitRef,
    project_id,
    recording_id,
    incoming: copy,
    status: 'PENDING',
    detectedAt: FIXED_AT,
  };
}

/**
 * Materialize a scenario into a well-formed {@link SyncState}. `reviews` and
 * `conflicts` are kept mutually exclusive per `unitRef` (each Unit is placed in
 * exactly one bucket), exactly as sync-store guarantees in production.
 */
function buildState(scenario) {
  const reviews = {};
  const conflicts = {};
  const place = (kind, item) => {
    (kind === 'conflict' ? conflicts : reviews)[item.unitRef] = item;
  };
  for (const proj of scenario) {
    if (proj.projectItem != null) {
      place(proj.projectItem, makeItem(proj.projectItem, proj.project_id, proj.project_id, null));
    }
    for (const rec of proj.recordings) {
      const unitRef = `${proj.project_id}:${rec.recording_id}`;
      place(rec.kind, makeItem(rec.kind, unitRef, proj.project_id, rec.recording_id));
    }
  }
  return { schema: 1, baselines: {}, snapshots: {}, reviews, conflicts };
}

/**
 * Independently re-derive the EXPECTED indicator set from the scenario (the
 * oracle). Each AttentionIndicator carries exactly these five fields.
 */
function expectedIndicators(scenario) {
  const out = [];
  for (const proj of scenario) {
    if (proj.projectItem != null) {
      out.push({
        unitRef: proj.project_id,
        project_id: proj.project_id,
        recording_id: null,
        level: 'project',
        kind: proj.projectItem,
      });
    }
    for (const rec of proj.recordings) {
      out.push({
        unitRef: `${proj.project_id}:${rec.recording_id}`,
        project_id: proj.project_id,
        recording_id: rec.recording_id,
        level: 'recording',
        kind: rec.kind,
      });
    }
  }
  return out;
}

const byUnitRef = (a, b) => a.unitRef.localeCompare(b.unitRef);

// ─── Property 24 ───────────────────────────────────────────────────────────────

describe('Property 24: Attention indicators are derived correctly and distinguish review from conflict', () => {
  it('marks exactly the Units needing attention, each labelled and levelled correctly (R13.1)', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const state = buildState(scenario);
        const actual = deriveIndicators(state);

        // EXACT + LABELLED + LEVELLED: the derived set equals the independently
        // re-derived oracle, field-for-field, ignoring order. This pins that the
        // indicators mark exactly the Units in reviews ∪ conflicts (never more,
        // never fewer), label each Review/Conflict by its record type, and place
        // each on the project vs recording row by whether it has a recording_id.
        const expected = expectedIndicators(scenario);
        assert.deepStrictEqual([...actual].sort(byUnitRef), [...expected].sort(byUnitRef));
      }),
      { numRuns: 200 },
    );
  });

  it('always shows a recording-level indicator for a recording needing attention (R13.4)', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const state = buildState(scenario);
        const indicators = deriveIndicators(state);

        for (const proj of scenario) {
          for (const rec of proj.recordings) {
            // A recording needing attention ALWAYS resolves to a recording-level
            // indicator — independent of whether its project also needs one.
            const ind = getRecordingIndicator(indicators, proj.project_id, rec.recording_id);
            assert.ok(
              ind,
              `missing recording indicator for ${proj.project_id}:${rec.recording_id}`,
            );
            assert.equal(ind.level, 'recording');
            assert.equal(ind.kind, rec.kind);
            assert.equal(ind.recording_id, rec.recording_id);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('shows a project-level indicator iff the project Unit itself needs attention (R13.4 / R13.5)', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const state = buildState(scenario);
        const indicators = deriveIndicators(state);

        for (const proj of scenario) {
          const projectInd = getProjectIndicator(indicators, proj.project_id);

          if (proj.projectItem != null) {
            // R13.5 — the project Unit itself needs attention: a project-level
            // indicator IS shown, labelled by the project item's own kind.
            assert.ok(projectInd, `expected a project indicator for ${proj.project_id}`);
            assert.equal(projectInd.level, 'project');
            assert.equal(projectInd.kind, proj.projectItem);
            assert.equal(projectInd.recording_id, null);

            // …and it is shown IN ADDITION to every recording-level indicator.
            for (const rec of proj.recordings) {
              assert.ok(
                getRecordingIndicator(indicators, proj.project_id, rec.recording_id),
                'R13.5: both project-level and recording-level indicators must show',
              );
            }
          } else {
            // R13.4 — the project Unit itself does NOT need attention: NO
            // project-level indicator, even when child recordings need one.
            assert.equal(
              projectInd,
              null,
              `no project indicator expected for ${proj.project_id} (attention is child-only)`,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ─── Regression examples pinning the two distinguishing cases ───────────────

  it('child-only attention yields a recording indicator but NO project indicator (R13.4)', () => {
    const state = {
      schema: 1,
      baselines: {},
      snapshots: {},
      reviews: {},
      conflicts: {
        'p1:r1': makeItem('conflict', 'p1:r1', 'p1', 'r1'),
      },
    };
    const indicators = deriveIndicators(state);

    assert.equal(getProjectIndicator(indicators, 'p1'), null);
    const recInd = getRecordingIndicator(indicators, 'p1', 'r1');
    assert.ok(recInd);
    assert.equal(recInd.level, 'recording');
    assert.equal(recInd.kind, 'conflict');
  });

  it('project-and-child attention shows BOTH indicators, each by its own kind (R13.5)', () => {
    const state = {
      schema: 1,
      baselines: {},
      snapshots: {},
      reviews: {
        p2: makeItem('review', 'p2', 'p2', null),
      },
      conflicts: {
        'p2:r2': makeItem('conflict', 'p2:r2', 'p2', 'r2'),
      },
    };
    const indicators = deriveIndicators(state);

    const projInd = getProjectIndicator(indicators, 'p2');
    assert.ok(projInd);
    assert.equal(projInd.level, 'project');
    assert.equal(projInd.kind, 'review');

    const recInd = getRecordingIndicator(indicators, 'p2', 'r2');
    assert.ok(recInd);
    assert.equal(recInd.level, 'recording');
    assert.equal(recInd.kind, 'conflict');
  });

  it('an empty or absent SyncState yields no indicators', () => {
    assert.deepStrictEqual(
      deriveIndicators({ schema: 1, baselines: {}, snapshots: {}, reviews: {}, conflicts: {} }),
      [],
    );
    assert.deepStrictEqual(deriveIndicators(null), []);
    assert.deepStrictEqual(deriveIndicators(undefined), []);
  });
});
