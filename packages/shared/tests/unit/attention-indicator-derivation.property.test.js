/**
 * attention-indicator-derivation.property.test.js — Property test for the
 * derivation of sync-state attention indicators from a SyncState.
 *
 * The Docent_UI surfaces which Units need the user's attention and distinguishes
 * a Review-and-Accept item from a Conflict. `deriveIndicators` is the
 * pure half of that surface: from the durable `SyncState` it works out exactly
 * which Units need attention, labels each Review vs Conflict, and tags each with
 * the row it belongs on. The two lookups (`getProjectIndicator` /
 * `getRecordingIndicator`) then drive what each project row and recording row
 * shows. This must hold:
 *
 *   - EXACT + LABELLED — the indicators mark exactly the Units recorded
 *     in `reviews` ∪ `conflicts`, never more and never fewer, each labelled
 *     `'review'` or `'conflict'` by its record type and placed on the correct
 *     row level (`'project'` for a project Unit, `'recording'` for a recording).
 *   - RECORDING ALWAYS SHOWN — a recording needing attention always has
 *     a recording-level indicator, whether or not its project also needs one.
 *   - PROJECT-OWN INDICATOR — the project's OWN indicator
 *     (`getProjectIndicator`) shows iff the project Unit itself is in review or
 *     conflict; a project whose only attention is in a child recording gets NO
 *     project-OWN indicator.
 *   - PROJECT-ROW ROLL-UP — `getProjectRowIndicators` returns the
 *     full badge set for a project ROW: the project-own indicator (when present)
 *     plus a deduplicated rolled-up Conflict and/or Review indicator reflecting
 *     whether ANY child recording is in that state. At most one badge per kind,
 *     up to three total. The project-own badge opens its workflow; a roll-up
 *     opens the project.
 *
 * The expected indicator set is re-derived independently from the generated
 * scenario (not from the implementation) and used as the oracle.
 *
 * Uses Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()` for
 * ids).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Attention indicators are derived correctly and distinguish review from conflict

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  deriveIndicators,
  getProjectIndicator,
  getProjectRowIndicators,
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
 * what makes the two distinguishing cases (children-only, no project
 * badge; project + child both flagged) arise frequently.
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

/**
 * Independently re-derive the EXPECTED project-ROW badge set for one project from
 * the scenario (the oracle for {@link getProjectRowIndicators}). Mirrors
 * the project-own badge (when the project Unit itself has an item),
 * then a deduplicated recording Conflict roll-up (when any child is a conflict),
 * then a recording Review roll-up (when any child is a review) — in that order.
 *
 * @param {{project_id: string, projectItem: ('review'|'conflict'|null), recordings: {recording_id: string, kind: 'review'|'conflict'}[]}} proj
 * @returns {Array<{scope: string, kind: string, unitRef: string|null, project_id: string}>}
 */
function expectedRowBadges(proj) {
  const out = [];
  if (proj.projectItem != null) {
    out.push({
      scope: 'project-own',
      kind: proj.projectItem,
      unitRef: proj.project_id,
      project_id: proj.project_id,
    });
  }
  const recKinds = new Set(proj.recordings.map((r) => r.kind));
  if (recKinds.has('conflict')) {
    out.push({
      scope: 'recording-rollup',
      kind: 'conflict',
      unitRef: null,
      project_id: proj.project_id,
    });
  }
  if (recKinds.has('review')) {
    out.push({
      scope: 'recording-rollup',
      kind: 'review',
      unitRef: null,
      project_id: proj.project_id,
    });
  }
  return out;
}

describe('Attention indicators are derived correctly and distinguish review from conflict', () => {
  it('marks exactly the Units needing attention, each labelled and levelled correctly', () => {
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

  it('always shows a recording-level indicator for a recording needing attention', () => {
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

  it('shows a project-level indicator iff the project Unit itself needs attention', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const state = buildState(scenario);
        const indicators = deriveIndicators(state);

        for (const proj of scenario) {
          const projectInd = getProjectIndicator(indicators, proj.project_id);

          if (proj.projectItem != null) {
            // the project Unit itself needs attention: a project-level
            // indicator IS shown, labelled by the project item's own kind.
            assert.ok(projectInd, `expected a project indicator for ${proj.project_id}`);
            assert.equal(projectInd.level, 'project');
            assert.equal(projectInd.kind, proj.projectItem);
            assert.equal(projectInd.recording_id, null);

            // …and it is shown IN ADDITION to every recording-level indicator.
            for (const rec of proj.recordings) {
              assert.ok(
                getRecordingIndicator(indicators, proj.project_id, rec.recording_id),
                'both project-level and recording-level indicators must show',
              );
            }
          } else {
            // the project Unit itself does NOT need attention: NO
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

  it('child-only attention yields a recording indicator but NO project indicator', () => {
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

  it('project-and-child attention shows BOTH indicators, each by its own kind', () => {
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

  // ─── Project-ROW roll-up badges ──────────────────────────────

  describe('getProjectRowIndicators rolls up project + child attention', () => {
    it('returns exactly the deduplicated project-own + recording-rollup badge set, in order', () => {
      fc.assert(
        fc.property(arbScenario, (scenario) => {
          const state = buildState(scenario);
          const indicators = deriveIndicators(state);

          for (const proj of scenario) {
            const actual = getProjectRowIndicators(indicators, proj.project_id);
            const expected = expectedRowBadges(proj);

            // EXACT set + ORDER: the row badges equal the independently-derived
            // oracle, in the contract order (project-own, conflict roll-up,
            // review roll-up).
            assert.deepStrictEqual(
              actual,
              expected,
              `row badges for ${proj.project_id} must equal the oracle in order`,
            );

            // At most ONE badge per kind/scope pairing — never duplicated by N
            // child recordings of the same kind.
            const seen = new Set();
            for (const b of actual) {
              const key = `${b.scope}:${b.kind}`;
              assert.ok(!seen.has(key), `duplicate row badge ${key} for ${proj.project_id}`);
              seen.add(key);
            }
            assert.ok(actual.length <= 3, 'a project row shows at most three badges');

            // A recording roll-up never carries a unitRef (it is not a single
            // resolvable Unit); the project-own badge always does.
            for (const b of actual) {
              if (b.scope === 'recording-rollup') {
                assert.equal(b.unitRef, null, 'a roll-up badge has no unitRef (opens the project)');
              } else {
                assert.equal(
                  b.unitRef,
                  proj.project_id,
                  'the project-own badge carries its unitRef',
                );
              }
            }
          }
        }),
        { numRuns: 200 },
      );
    });

    it('child-only attention still yields a project-row badge — the recording roll-up — even with no project-own badge', () => {
      fc.assert(
        fc.property(arbScenario, (scenario) => {
          const state = buildState(scenario);
          const indicators = deriveIndicators(state);

          for (const proj of scenario) {
            const childKinds = new Set(proj.recordings.map((r) => r.kind));
            const rowBadges = getProjectRowIndicators(indicators, proj.project_id);

            // Whenever ANY child recording needs attention, the project ROW shows
            // a badge (so the user sees it without opening the project) —
            // even when the project Unit itself has none.
            if (childKinds.size > 0) {
              assert.ok(
                rowBadges.length > 0,
                `project ${proj.project_id} with child attention must show a row badge`,
              );
            }
            // The roll-up reflects exactly which child kinds are present.
            const rollupKinds = new Set(
              rowBadges.filter((b) => b.scope === 'recording-rollup').map((b) => b.kind),
            );
            assert.deepStrictEqual(
              [...rollupKinds].sort(),
              [...childKinds].sort(),
              'recording roll-up kinds must equal the distinct child-recording kinds',
            );
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  it('three conflicting child recordings collapse to a SINGLE conflict roll-up on the project row', () => {
    const state = {
      schema: 1,
      baselines: {},
      snapshots: {},
      reviews: {},
      conflicts: {
        'p1:r1': makeItem('conflict', 'p1:r1', 'p1', 'r1'),
        'p1:r2': makeItem('conflict', 'p1:r2', 'p1', 'r2'),
        'p1:r3': makeItem('conflict', 'p1:r3', 'p1', 'r3'),
      },
    };
    const indicators = deriveIndicators(state);
    const rowBadges = getProjectRowIndicators(indicators, 'p1');

    // No project-own item, three child conflicts → exactly ONE conflict roll-up.
    assert.equal(rowBadges.length, 1);
    assert.deepStrictEqual(rowBadges[0], {
      scope: 'recording-rollup',
      kind: 'conflict',
      unitRef: null,
      project_id: 'p1',
    });
  });

  it('a project with its own review + a child conflict + a child review shows all THREE row badges', () => {
    const state = {
      schema: 1,
      baselines: {},
      snapshots: {},
      reviews: {
        p9: makeItem('review', 'p9', 'p9', null),
        'p9:rR': makeItem('review', 'p9:rR', 'p9', 'rR'),
      },
      conflicts: {
        'p9:rC': makeItem('conflict', 'p9:rC', 'p9', 'rC'),
      },
    };
    const indicators = deriveIndicators(state);
    const rowBadges = getProjectRowIndicators(indicators, 'p9');

    // Order: project-own (review), recording conflict roll-up, recording review roll-up.
    assert.deepStrictEqual(rowBadges, [
      { scope: 'project-own', kind: 'review', unitRef: 'p9', project_id: 'p9' },
      { scope: 'recording-rollup', kind: 'conflict', unitRef: null, project_id: 'p9' },
      { scope: 'recording-rollup', kind: 'review', unitRef: null, project_id: 'p9' },
    ]);
  });

  it('a project with no attention has no row badges', () => {
    const state = { schema: 1, baselines: {}, snapshots: {}, reviews: {}, conflicts: {} };
    const indicators = deriveIndicators(state);
    assert.deepStrictEqual(getProjectRowIndicators(indicators, 'p-none'), []);
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
