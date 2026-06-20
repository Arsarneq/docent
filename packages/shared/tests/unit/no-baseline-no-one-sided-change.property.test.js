/**
 * no-baseline-no-one-sided-change.property.test.js — Property test that graded
 * classification never produces a ONE-SIDED change when the project has NO
 * recorded Sync_Baseline (no "phantom baseline").
 *
 * The two one-sided classifications are the cases that attribute a change to a
 * single side and treat it as safe/routine:
 *   - `changed-incoming` — hands an incoming change to the user as a
 *     Review-and-Accept item *because the local copy is provably unchanged since
 *     the last agreement*. It requires `digest_local == digest_baseline`
 *     AND `digest_incoming != digest_baseline`.
 *   - `changed-local-outgoing` — treats the local copy as a routine outgoing
 *     change to push automatically *because the server is provably still at the
 *     last agreement*. It requires `digest_incoming == digest_baseline`
 *     AND `digest_local != digest_baseline`.
 *
 * Both judgements are only meaningful when there IS a last-agreed state: each one
 * needs one side to MATCH the baseline so the change can be attributed to the
 * other side. When no baseline exists, there is no last-agreed state to match.
 * A correct detector must therefore treat a missing baseline as ABSENCE,
 * not as a digest that one side happens to equal — otherwise a "phantom baseline"
 * would mis-route a genuine two-sided divergence into a one-sided change and risk
 * silently adopting incoming work over unconfirmed local work, or silently
 * overwriting an un-reconciled server change with local work.
 *
 * With no baseline, the only reachable classifications are `already-converged`
 * (both sides equal), `brand-new` (no local counterpart), `diverged` (both
 * present and differing), or — for a locked recording — `locked-skipped`; never
 * `changed-incoming` and never `changed-local-outgoing`. In particular a
 * local≠incoming Unit with no baseline must be `diverged`.
 *
 * This test drives both the shared core `classifyUnit` (baseline digest fixed to
 * `null`) and the full `classifyProject` (baseline argument fixed to `null`) over
 * a wide input space and asserts no Unit is ever classified as a one-sided change.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generators in classify-decision-table.property.test.js.
 *
 */

// Classification with no baseline never yields a one-sided change via a phantom baseline

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { classifyProject, classifyUnit } from '../../conflict-detector.js';

// The one-sided classifications that must NEVER arise without a baseline: each
// attributes the change to a single side by matching the OTHER side to the
// last-agreed state, which a missing baseline cannot provide.
const ONE_SIDED_KINDS = new Set(['changed-incoming', 'changed-local-outgoing']);

// The classifications reachable when there is NO baseline. The one-sided kinds
// are deliberately absent: each requires a last-agreed state to match, which a
// missing baseline does not provide. Deletion cases also require a
// baseline counterpart, so they too are unreachable here.
const KINDS_REACHABLE_WITHOUT_BASELINE = new Set([
  'already-converged',
  'brand-new',
  'diverged',
  'locked-skipped',
]);

// ─── Generators (mirroring the decision-table test) ───────────────

// Digest symbols (plus null for absence) so every equality relationship between
// local and incoming arises frequently in the classifyUnit lattice.
const arbDigest = fc.constantFrom(null, 'A', 'B', 'C');

// Content variants used to build recordings/projects whose digests are equal iff
// the (id, variant) are equal — lets `classifyProject` compute real digests.
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
// variant (or absent) on the local and incoming sides, plus whether it is
// locked. There is intentionally NO baseline side — this scenario has no
// recorded Sync_Baseline at all.
const arbSlot = fc.record({
  recording_id: fc.uuid(),
  local: fc.option(arbVariant, { nil: null }),
  incoming: fc.option(arbVariant, { nil: null }),
  locked: fc.boolean(),
});

// A whole no-baseline scenario: a shared project_id, per-side presence of the
// project, a per-side project-name variant (to exercise project-metadata
// classification), and a set of recording slots with unique recording_ids.
const arbScenario = fc.record({
  project_id: fc.uuid(),
  localPresent: fc.boolean(),
  incomingPresent: fc.boolean(),
  projNameLocal: arbVariant,
  projNameIncoming: arbVariant,
  slots: fc.uniqueArray(arbSlot, {
    selector: (s) => s.recording_id,
    minLength: 0,
    maxLength: 3,
  }),
});

/** Materialize a scenario into (local, incoming, lockedRecordingIds); baseline is always null. */
function materialize(scenario) {
  const { project_id, localPresent, incomingPresent, projNameLocal, projNameIncoming, slots } =
    scenario;

  const recsFor = (side) =>
    slots.filter((s) => s[side] != null).map((s) => buildRecording(s.recording_id, s[side]));

  const local = localPresent ? buildProject(project_id, projNameLocal, recsFor('local')) : null;
  const incoming = incomingPresent
    ? buildProject(project_id, projNameIncoming, recsFor('incoming'))
    : null;

  const lockedRecordingIds = new Set(slots.filter((s) => s.locked).map((s) => s.recording_id));

  return { local, incoming, lockedRecordingIds };
}

describe('Classification with no baseline never yields a one-sided change via a phantom baseline', () => {
  it('classifyUnit with a null baseline never returns a one-sided change, for any local/incoming/lock', () => {
    fc.assert(
      fc.property(arbDigest, arbDigest, fc.boolean(), (dl, di, locked) => {
        // Baseline digest is null: there is no last-agreed state.
        const kind = classifyUnit(dl, di, null, locked);
        assert.ok(
          !ONE_SIDED_KINDS.has(kind),
          `null baseline yielded one-sided ${kind} for (local=${dl}, incoming=${di}, locked=${locked})`,
        );
        assert.ok(
          KINDS_REACHABLE_WITHOUT_BASELINE.has(kind),
          `null baseline produced an unexpected kind ${kind} for (local=${dl}, incoming=${di}, locked=${locked})`,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('classifyUnit is exhaustively free of one-sided changes over the entire null-baseline lattice', () => {
    const pool = [null, 'A', 'B', 'C'];
    for (const dl of pool) {
      for (const di of pool) {
        for (const locked of [false, true]) {
          const kind = classifyUnit(dl, di, null, locked);
          assert.ok(
            !ONE_SIDED_KINDS.has(kind),
            `one-sided ${kind} for (local=${dl}, incoming=${di}, locked=${locked})`,
          );
          assert.ok(
            KINDS_REACHABLE_WITHOUT_BASELINE.has(kind),
            `unexpected kind ${kind} for (${dl},${di},null,${locked})`,
          );
        }
      }
    }
  });

  it('classifyProject with a null baseline never classifies any Unit as a one-sided change', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { local, incoming, lockedRecordingIds } = materialize(scenario);
        // No recorded Sync_Baseline for this project.
        const results = classifyProject(local, incoming, null, lockedRecordingIds);

        for (const c of results) {
          assert.equal(
            c.digestBaseline,
            null,
            `a no-baseline Unit reported a non-null baseline digest for ${c.unitRef}`,
          );
          assert.ok(
            !ONE_SIDED_KINDS.has(c.kind),
            `classifyProject produced one-sided ${c.kind} for ${c.unitRef} with no baseline`,
          );
          assert.ok(
            KINDS_REACHABLE_WITHOUT_BASELINE.has(c.kind),
            `classifyProject produced an unexpected kind ${c.kind} for ${c.unitRef} with no baseline`,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a missing baseline is treated as absence, not as a digest either side matches (the phantom-baseline contrast)', () => {
    // WITH a baseline equal to local (and incoming moved), the same digests are
    // changed-incoming — local is provably unchanged since agreement.
    assert.equal(classifyUnit('A', 'B', 'A', false), 'changed-incoming');
    // WITH a baseline equal to incoming (and local moved), the same digests are
    // changed-local-outgoing — the server is provably still at agreement.
    assert.equal(classifyUnit('B', 'A', 'A', false), 'changed-local-outgoing');
    // WITHOUT a baseline, those identical local/incoming digests must fall
    // through to diverged, never to a one-sided change: there is no last-agreed
    // state for either side to match, so no phantom baseline is invented and the
    // two-sided-unknown case is divergence.
    assert.equal(classifyUnit('A', 'B', null, false), 'diverged');
    assert.equal(classifyUnit('B', 'A', null, false), 'diverged');

    // Sanity on the other no-baseline branches:
    assert.equal(classifyUnit('A', 'A', null, false), 'already-converged'); // both equal
    assert.equal(classifyUnit(null, 'A', null, false), 'brand-new'); // no local counterpart
  });
});
