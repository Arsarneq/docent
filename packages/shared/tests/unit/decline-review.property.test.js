/**
 * decline-review.property.test.js — Property test for declining a
 * Review-and-Accept item (revised resolution semantics).
 *
 * When the user declines a Review-and-Accept item, the incoming change is the
 * one thing that must NOT be applied: the author has judged that it does not fit
 * their narrative. Declining is a *dismissal*, never a way to overwrite the
 * server change with the local version. Four guarantees follow:
 *
 *   1. KEEP LOCAL / NEVER PUSH — the local version is left completely
 *      untouched and is never pushed over the incoming server change.
 *      `declineReview` never applies the incoming change, so the local `projects`
 *      array comes back byte-identical (and, in fact, the very same array
 *      reference), and the result reports no adoption/removal. The declined
 *      incoming Sync_Snapshot is retained for later recovery (the retained
 *      project-level snapshot when one landed on pull, otherwise the item's own
 *      recoverable incoming copy).
 *   2. DISMISS THE EXACT VERSION — the canonical digest of the declined
 *      incoming version is recorded in `dismissedIncoming`, so a subsequent cycle
 *      that pulls the SAME incoming version does not re-offer it as a fresh
 *      Review item.
 *   3. ONLY THAT VERSION — the dismissal applies ONLY to the exact
 *      declined version: a DIFFERENT incoming version (a different digest) is not
 *      suppressed and is classified afresh.
 *   4. NO BASELINE ADVANCE — declining adopts nothing, so the Sync_Baseline
 *      for the affected project is never advanced (or fabricated).
 *
 * The Review item itself is cleared, returning the Unit to the NONE
 * state for deferred items (its dismissal lives on in `dismissedIncoming`).
 *
 * The property drives `declineReview` over arbitrary local projects and arbitrary
 * Review items (project-level and recording-level, with and without a retained
 * project snapshot and with and without a pre-existing baseline) and asserts all
 * four guarantees, plus that an unrelated deferred item is never disturbed.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generators in sync-store-roundtrip.property.test.js.
 *
 */

// Declining a Review item keeps local, dismisses the incoming version, and never pushes

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { declineReview, itemKind } from '../../conflict-resolution.js';
import {
  createEmptySyncState,
  upsertReview,
  getItem,
  isDismissedIncoming,
} from '../../sync-store.js';
import { advanceBaseline, getBaseline } from '../../sync-baseline.js';
import { digestProject, digestRecording } from '../../sync-digest.js';

// ─── Generators (mirroring sync-store-roundtrip.property.test.js) ────────────

const arbId = fc.uuid();

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

// JSON-safe leaf values only, so any inequality after a clone is a real fault
// rather than a JSON artifact (e.g. -0 from arbitrary doubles).
const arbLeaf = fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.constant(null));

// Optional, JSON-serializable metadata with prototype-safe keys.
const arbMetadata = fc.dictionary(
  fc.constantFrom('owner', 'count', 'flag', 'note', 'tag'),
  arbLeaf,
  {
    maxKeys: 4,
  },
);

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: arbId,
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 20 }),
  deleted: fc.boolean(),
});

/** A recording projection (full committed step history; metadata optional). */
const arbRecordingCopy = fc.record(
  {
    recording_id: arbId,
    name: fc.string({ maxLength: 30 }),
    created_at: arbIso,
    metadata: arbMetadata,
    steps: fc.array(arbStep, { maxLength: 5 }),
  },
  { requiredKeys: ['recording_id', 'name', 'created_at', 'steps'] },
);

/** A project projection with an ordered list of recordings (metadata optional). */
const arbProjectCopy = fc.record(
  {
    project_id: arbId,
    name: fc.string({ maxLength: 30 }),
    created_at: arbIso,
    metadata: arbMetadata,
    recordings: fc.array(arbRecordingCopy, { maxLength: 3 }),
  },
  { requiredKeys: ['project_id', 'name', 'created_at', 'recordings'] },
);

// ─── Scenario ────────────────────────────────────────────────────────────────

// A decline scenario: an arbitrary local projects array, one target Review item
// (project- or recording-level) whose retained incoming copy matches its
// granularity, optionally a retained project-level Sync_Snapshot for the target
// project, optionally a pre-existing baseline for the target project (to confirm
// the decline leaves it untouched), and optionally a second unrelated Review item
// that must survive the decline untouched.
const arbScenario = fc.record({
  projects: fc.array(arbProjectCopy, { maxLength: 4 }),
  projectId: arbId,
  // null ⇒ a project-level review; otherwise a recording-level review.
  recordingId: fc.option(arbId, { nil: null }),
  // The recoverable incoming version stored on the Review item, one per
  // granularity; the test body selects the one matching `recordingId` so the
  // declined version's digest is computed at the item's own granularity (exactly
  // as `declineReview` records it).
  incomingProject: arbProjectCopy,
  incomingRecording: arbRecordingCopy,
  // A retained pulled snapshot for the target project (present iff includeSnapshot).
  includeSnapshot: fc.boolean(),
  snapshotPayload: arbProjectCopy,
  snapshotPulledAt: arbIso,
  // A pre-existing baseline for the target project (present iff includeBaseline).
  includeBaseline: fc.boolean(),
  baselinePayload: arbProjectCopy,
  // An unrelated review to confirm decline clears ONLY the target item.
  otherProjectId: arbId,
  otherIncoming: arbRecordingCopy,
  includeOther: fc.boolean(),
});

/** Build the target unitRef from the scenario's project/recording ids. */
function unitRefOf(scenario) {
  return scenario.recordingId == null
    ? scenario.projectId
    : `${scenario.projectId}:${scenario.recordingId}`;
}

// A fixed clock for seeding a deterministic pre-existing baseline.
const FIXED_NOW = 1700000000000;

describe('Declining a Review item keeps local, dismisses the incoming version, and never pushes', () => {
  it('after a decline the local projects are byte-identical and never pushed, the exact declined incoming version is dismissed (a different one is not), the snapshot stays recoverable, and the baseline is not advanced', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const {
          projects,
          projectId,
          includeSnapshot,
          snapshotPayload,
          snapshotPulledAt,
          includeBaseline,
          baselinePayload,
        } = scenario;
        const unitRef = unitRefOf(scenario);
        const isRecordingLevel = scenario.recordingId != null;
        // The incoming version stored on the item, at the item's own granularity.
        const incoming = isRecordingLevel ? scenario.incomingRecording : scenario.incomingProject;

        // ── Arrange: seed the store with the target Review item (via the real
        //    idempotent upsert path), an optional retained project snapshot, an
        //    optional pre-existing baseline, and an optional unrelated Review
        //    item. ──────────────────────────────────────────────────────────
        const state = createEmptySyncState();
        upsertReview(state, unitRef, incoming);

        if (includeSnapshot) {
          state.snapshots[projectId] = { payload: snapshotPayload, pulledAt: snapshotPulledAt };
        }

        if (includeBaseline) {
          advanceBaseline(state, projectId, baselinePayload, () => FIXED_NOW);
        }

        // Add an unrelated review only when its unitRef differs from the target's.
        const otherUnitRef = scenario.otherProjectId;
        const hasOther = scenario.includeOther && otherUnitRef !== unitRef;
        if (hasOther) {
          upsertReview(state, otherUnitRef, scenario.otherIncoming);
        }

        // The canonical digest the decline must record as dismissed,
        // computed at the item's own granularity exactly as `declineReview` does.
        const dismissedDigest = isRecordingLevel
          ? digestRecording(incoming)
          : digestProject(incoming);
        // A guaranteed-DIFFERENT incoming version: changing the name changes the
        // content digest, so this stands in for "a later pull brought a different
        // incoming version".
        const differentIncoming = { ...incoming, name: `${incoming.name}\u0001changed` };
        const differentDigest = isRecordingLevel
          ? digestRecording(differentIncoming)
          : digestProject(differentIncoming);

        // Capture pre-decline references and prototype-agnostic content snapshots.
        // `declineReview` never clones or replaces the snapshot/item/baseline
        // objects, so reference identity is the faithful "unchanged" check; a JSON
        // string captures content so an in-place mutation would still be caught.
        // (deepStrictEqual is avoided here because fast-check may produce
        // null-prototype objects, which deep-strict equality treats as unequal to
        // their structuredClone — a harness artifact, not a behavior under test.)
        const projectsJsonBefore = JSON.stringify(projects);
        const itemIncomingRef = state.reviews[unitRef].incoming;
        const snapshotRef = includeSnapshot ? state.snapshots[projectId] : undefined;
        const snapshotJsonBefore = includeSnapshot
          ? JSON.stringify(state.snapshots[projectId])
          : undefined;
        const baselineRef = includeBaseline ? getBaseline(state, projectId) : null;
        const baselineJsonBefore = includeBaseline ? JSON.stringify(baselineRef) : undefined;
        const otherRef = hasOther ? state.reviews[otherUnitRef] : undefined;
        const otherJsonBefore = hasOther ? JSON.stringify(state.reviews[otherUnitRef]) : undefined;

        // ── Act ───────────────────────────────────────────────────────────────
        const result = declineReview(state, projects, unitRef);

        // ── Assert: the decline succeeded on a review item. ─────────────────────
        assert.equal(result.ok, true, 'declining a Review item should succeed');
        assert.equal(result.kind, 'review');
        assert.equal(result.reason, null);

        // KEEP LOCAL / NEVER PUSH — the incoming change is never applied and
        //        the local version is never pushed over the server change. The
        //        returned array is the same reference, its content is unchanged,
        //        and the result reports no adoption/removal of any Unit.
        assert.equal(
          result.projects,
          projects,
          'decline must return the local array unchanged (same ref) — never pushed',
        );
        assert.equal(
          JSON.stringify(projects),
          projectsJsonBefore,
          'local projects must not be mutated',
        );
        assert.notEqual(result.removed, true, 'decline must not adopt a deletion (no push/apply)');

        // RETAIN THE SNAPSHOT — the declined incoming change stays
        //        recoverable and is surfaced on the result.
        assert.notEqual(
          result.retained,
          null,
          'a recoverable copy of the declined change must be surfaced',
        );
        assert.notEqual(result.retained, undefined);
        if (includeSnapshot) {
          assert.equal(
            state.snapshots[projectId],
            snapshotRef,
            'the retained Sync_Snapshot must remain in the store',
          );
          assert.equal(
            JSON.stringify(state.snapshots[projectId]),
            snapshotJsonBefore,
            'the retained Sync_Snapshot content must be unchanged',
          );
          assert.equal(
            result.retained,
            snapshotRef,
            'the surfaced recovery handle must be the retained Sync_Snapshot',
          );
        } else {
          assert.equal(
            result.retained,
            itemIncomingRef,
            'with no project snapshot, the item incoming copy must stay recoverable',
          );
          assert.equal(
            state.snapshots[projectId],
            undefined,
            'declining must not fabricate a snapshot entry',
          );
        }

        // The Review item is cleared, returning the Unit to NONE for
        //         deferred items.
        assert.equal(itemKind(state, unitRef), null, 'the declined Review item must be cleared');
        assert.equal(getItem(state, unitRef), null);
        assert.equal(state.reviews[unitRef], undefined);

        // The EXACT declined incoming version is recorded as dismissed, so a
        //        later cycle that pulls the same version does not re-offer it.
        assert.equal(
          isDismissedIncoming(state, unitRef, dismissedDigest),
          true,
          'the declined incoming version must be recorded as dismissed',
        );

        // The dismissal applies ONLY to the exact declined version — a
        //         DIFFERENT incoming version is not suppressed.
        assert.notEqual(
          dismissedDigest,
          differentDigest,
          'sanity: the modified incoming version must have a different digest',
        );
        assert.equal(
          isDismissedIncoming(state, unitRef, differentDigest),
          false,
          'a different incoming version must NOT be suppressed by the dismissal',
        );

        // The baseline is not advanced (nor fabricated) by a decline.
        if (includeBaseline) {
          assert.equal(
            getBaseline(state, projectId),
            baselineRef,
            'decline must not advance/replace the baseline',
          );
          assert.equal(
            JSON.stringify(getBaseline(state, projectId)),
            baselineJsonBefore,
            'the pre-existing baseline content must be unchanged',
          );
        } else {
          assert.equal(
            getBaseline(state, projectId),
            null,
            'decline must not fabricate a baseline',
          );
        }

        // An unrelated deferred item is never disturbed by the decline.
        if (hasOther) {
          assert.equal(
            state.reviews[otherUnitRef],
            otherRef,
            'an unrelated item must be untouched',
          );
          assert.equal(JSON.stringify(state.reviews[otherUnitRef]), otherJsonBefore);
        }
      }),
      { numRuns: 200 },
    );
  });

  // ─── Regression examples ──────────────────────────────────────────────────

  it('declining a recording-level review keeps local, dismisses the exact incoming version, retains the snapshot, and leaves the baseline untouched (regression example)', () => {
    const local = {
      project_id: 'proj-1',
      name: 'Checkout',
      created_at: '2024-01-01T00:00:00.000Z',
      recordings: [
        {
          recording_id: 'rec-1',
          name: 'Add to cart',
          created_at: '2024-01-02T00:00:00.000Z',
          steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
        },
      ],
    };
    const projects = [local];
    const projectsBefore = structuredClone(projects);

    const state = createEmptySyncState();
    const incoming = {
      recording_id: 'rec-1',
      name: 'Add to cart (server)',
      created_at: '2024-01-02T00:00:00.000Z',
      steps: [{ uuid: 'u2', logical_id: 'a', step_number: 0, deleted: false }],
    };
    upsertReview(state, 'proj-1:rec-1', incoming);
    state.snapshots['proj-1'] = {
      payload: { ...local, name: 'Checkout (server)' },
      pulledAt: '2024-02-01T00:00:00.000Z',
    };
    const snapshotBefore = structuredClone(state.snapshots['proj-1']);
    // Seed a pre-existing baseline; declining must not advance it.
    advanceBaseline(state, 'proj-1', local, () => FIXED_NOW);
    const baselineBefore = structuredClone(getBaseline(state, 'proj-1'));

    const result = declineReview(state, projects, 'proj-1:rec-1');

    assert.equal(result.ok, true);
    // Local untouched and never pushed.
    assert.deepStrictEqual(projects, projectsBefore);
    assert.equal(result.projects, projects);
    // Item cleared; snapshot retained and surfaced.
    assert.equal(itemKind(state, 'proj-1:rec-1'), null);
    assert.deepStrictEqual(state.snapshots['proj-1'], snapshotBefore);
    assert.deepStrictEqual(result.retained, snapshotBefore);
    // The exact incoming version is dismissed.
    assert.equal(isDismissedIncoming(state, 'proj-1:rec-1', digestRecording(incoming)), true);
    // A different incoming version is not suppressed.
    assert.equal(
      isDismissedIncoming(state, 'proj-1:rec-1', digestRecording({ ...incoming, name: 'other' })),
      false,
    );
    // Baseline untouched.
    assert.deepStrictEqual(getBaseline(state, 'proj-1'), baselineBefore);
  });

  it('declining a project-level review with no snapshot surfaces the item incoming copy, dismisses it, and creates no baseline (regression example)', () => {
    const projects = [];
    const state = createEmptySyncState();
    const incoming = {
      project_id: 'proj-9',
      name: 'New from server',
      created_at: '2024-03-01T00:00:00.000Z',
      recordings: [],
    };
    upsertReview(state, 'proj-9', incoming);
    const itemIncomingBefore = structuredClone(state.reviews['proj-9'].incoming);

    const result = declineReview(state, projects, 'proj-9');

    assert.equal(result.ok, true);
    assert.equal(itemKind(state, 'proj-9'), null);
    // No project snapshot ⇒ fall back to the item's recoverable incoming copy.
    assert.deepStrictEqual(result.retained, itemIncomingBefore);
    assert.equal(state.snapshots['proj-9'], undefined);
    // The exact incoming project version is dismissed (project granularity).
    assert.equal(isDismissedIncoming(state, 'proj-9', digestProject(incoming)), true);
    // A different incoming version is not suppressed.
    assert.equal(
      isDismissedIncoming(state, 'proj-9', digestProject({ ...incoming, name: 'changed' })),
      false,
    );
    // No baseline fabricated.
    assert.equal(getBaseline(state, 'proj-9'), null);
  });
});
