/**
 * item-type-routing-guard.property.test.js — Property test for the
 * Conflict_Resolution routing guard (`itemKind` + the accept/decline/resolve
 * entry points).
 *
 * A deferred Unit is EITHER a Review-and-Accept item (an incoming change to a
 * locally-unchanged Unit) or a Conflict (a two-sided divergence) — never both,
 * and the two are resolved through different interfaces: a Review opens the
 * accept/decline view, a Conflict opens the local-vs-incoming chooser. Opening an
 * item with the OTHER type's interface must be rejected and redirected to the
 * correct one. If the guard ever let a Conflict be "accepted" through the
 * Review interface (or a Review be "resolved" through the Conflict chooser), a
 * version could be adopted without the user making the choice that interface is
 * meant to capture — silent data loss.
 *
 * `itemKind` is the single source of truth the two interfaces consult:
 *   - it reports `'review'` for a Review Unit, `'conflict'` for a Conflict Unit,
 *     and `null` for a Unit in the NONE state (no active item); and
 *   - `acceptReview` / `declineReview` act only when it returns `'review'`, while
 *     `resolveConflict` acts only when it returns `'conflict'`.
 * So opening an item with the wrong interface is rejected with
 * `reason: 'wrong-interface'` (and a NONE Unit with `reason: 'not-found'`),
 * WITHOUT mutating any state — the guard returns before any version is applied,
 * any baseline advanced, or any item cleared.
 *
 * This test seeds arbitrary mixes of Review and Conflict items into a SyncState
 * through the same `upsert*` helpers the orchestrator uses, then asserts for
 * every seeded Unit that `itemKind` routes it to its own interface, the matching
 * interface is NOT rejected as wrong-interface, and the OTHER interface is
 * rejected as wrong-interface while leaving the store byte-for-byte unchanged.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generators in sync-store-roundtrip.property.test.js.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Item-type routing guard rejects the wrong interface

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createEmptySyncState, upsertReview, upsertConflict } from '../../sync-store.js';
import {
  itemKind,
  acceptReview,
  declineReview,
  resolveConflict,
} from '../../conflict-resolution.js';

// ─── Generators ──────────────────────────────────────────────────────────────

const arbId = fc.uuid();
const FIXED_ISO = '2024-01-01T00:00:00.000Z';

// A Unit is project-level (`recording_id == null`) or recording-level. The
// `unitRef` convention is `"<project_id>"` or `"<project_id>:<recording_id>"`.
const arbUnitSpec = fc.record({
  project_id: arbId,
  recording_id: fc.option(arbId, { nil: null }),
});

/** The idempotency key for a Unit (see sync-types.js UnitRef convention). */
function unitRefOf(spec) {
  return spec.recording_id == null ? spec.project_id : `${spec.project_id}:${spec.recording_id}`;
}

/** An allowlisted project copy (the granularity of a project-level Unit). */
function buildProjectCopy(project_id) {
  return {
    project_id,
    name: `proj-${project_id.slice(0, 8)}`,
    created_at: FIXED_ISO,
    recordings: [],
  };
}

/** An allowlisted recording copy (the granularity of a recording-level Unit). */
function buildRecordingCopy(recording_id) {
  return {
    recording_id,
    name: `rec-${recording_id.slice(0, 8)}`,
    created_at: FIXED_ISO,
    steps: [{ uuid: `u-${recording_id}`, logical_id: 'a', step_number: 0, deleted: false }],
  };
}

/** A recoverable Unit copy at the Unit's own granularity. */
function unitCopyFor(spec) {
  return spec.recording_id == null
    ? buildProjectCopy(spec.project_id)
    : buildRecordingCopy(spec.recording_id);
}

// One seeded deferred item: a Unit plus which kind of record it holds.
const arbEntry = fc.record({
  spec: arbUnitSpec,
  type: fc.constantFrom('review', 'conflict'),
});

// A set of deferred items with distinct unitRefs (a single Unit can hold only
// one record — reviews and conflicts are mutually exclusive per unitRef).
const arbEntries = fc.uniqueArray(arbEntry, {
  selector: (e) => unitRefOf(e.spec),
  minLength: 1,
  maxLength: 6,
});

/**
 * Seed a fresh SyncState with the given entries via the same upsert helpers the
 * orchestrator uses, so the state is exactly what detection would produce. A
 * Conflict gets a distinct incoming version so both versions are non-trivially
 * retained; a Review gets only the incoming copy.
 */
function seedState(entries) {
  const state = createEmptySyncState();
  for (const { spec, type } of entries) {
    const ref = unitRefOf(spec);
    const copy = unitCopyFor(spec);
    if (type === 'review') {
      upsertReview(state, ref, copy);
    } else {
      upsertConflict(state, ref, copy, { ...copy, name: `${copy.name}-server` });
    }
  }
  return state;
}

describe('Item-type routing guard rejects the wrong interface', () => {
  it('routes each deferred item to its own interface and rejects the other (no state change)', () => {
    fc.assert(
      fc.property(arbEntries, (entries) => {
        // The pristine state every clone is compared against; it is never mutated
        // by the assertions below (the matching interface is exercised on a clone
        // because accept/decline/resolve mutate on success).
        const state = seedState(entries);
        const projects = []; // local projects array; empty is enough for the guard

        for (const { spec, type } of entries) {
          const ref = unitRefOf(spec);

          // (a) itemKind routes the Unit to its own interface.
          assert.equal(itemKind(state, ref), type, `itemKind misrouted ${ref}`);

          if (type === 'review') {
            // (b) Wrong interface: a Review opened with the Conflict chooser is
            //     rejected — even when a fully-valid resolved state is supplied,
            //     the rejection is purely on item TYPE — and the store is
            //     untouched (the guard returns before any mutation).
            const before = structuredClone(state);
            const resolved = resolveConflict(before, projects, ref, unitCopyFor(spec));
            assert.equal(resolved.ok, false, `review wrongly resolvable via Conflict UI: ${ref}`);
            assert.equal(resolved.reason, 'wrong-interface', `expected wrong-interface for ${ref}`);
            assert.equal(resolved.kind, 'review', `wrong reported kind for ${ref}`);
            assert.deepStrictEqual(before, state, `wrong-interface mutated state for ${ref}`);

            // (c) Matching interface: accept/decline are NOT rejected as
            //     wrong-interface (they route to the Review item). Run on clones
            //     since a successful accept/decline mutates state.
            const acc = acceptReview(structuredClone(state), projects, ref);
            assert.equal(acc.kind, 'review', `acceptReview misrouted ${ref}`);
            assert.notEqual(
              acc.reason,
              'wrong-interface',
              `acceptReview rejected a Review: ${ref}`,
            );

            const dec = declineReview(structuredClone(state), projects, ref);
            assert.equal(dec.kind, 'review', `declineReview misrouted ${ref}`);
            assert.equal(dec.ok, true, `declineReview should accept a Review: ${ref}`);
            assert.notEqual(
              dec.reason,
              'wrong-interface',
              `declineReview rejected a Review: ${ref}`,
            );
          } else {
            // (b) Wrong interface: a Conflict opened with the accept/decline view
            //     is rejected by BOTH review entry points, store untouched.
            const beforeAccept = structuredClone(state);
            const acc = acceptReview(beforeAccept, projects, ref);
            assert.equal(acc.ok, false, `conflict wrongly acceptable via Review UI: ${ref}`);
            assert.equal(acc.reason, 'wrong-interface', `expected wrong-interface for ${ref}`);
            assert.equal(acc.kind, 'conflict', `wrong reported kind for ${ref}`);
            assert.deepStrictEqual(beforeAccept, state, `acceptReview mutated state for ${ref}`);

            const beforeDecline = structuredClone(state);
            const dec = declineReview(beforeDecline, projects, ref);
            assert.equal(dec.ok, false, `conflict wrongly declinable via Review UI: ${ref}`);
            assert.equal(dec.reason, 'wrong-interface', `expected wrong-interface for ${ref}`);
            assert.equal(dec.kind, 'conflict', `wrong reported kind for ${ref}`);
            assert.deepStrictEqual(beforeDecline, state, `declineReview mutated state for ${ref}`);

            // (c) Matching interface: resolveConflict routes to the Conflict
            //     chooser (it is not rejected as wrong-interface — a null choice
            //     is rejected as no-resolution, which is still correct routing).
            const res = resolveConflict(structuredClone(state), projects, ref, null);
            assert.equal(res.kind, 'conflict', `resolveConflict misrouted ${ref}`);
            assert.notEqual(
              res.reason,
              'wrong-interface',
              `resolveConflict rejected a Conflict as wrong-interface: ${ref}`,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a Unit with no deferred item is routed to neither interface (NONE → not-found)', () => {
    fc.assert(
      fc.property(arbEntries, arbUnitSpec, (entries, noneSpec) => {
        const state = seedState(entries);
        const noneRef = unitRefOf(noneSpec);
        // Guard against the astronomically-unlikely id collision with a seeded
        // Unit: only assert the NONE contract when the Unit truly has no record.
        fc.pre(itemKind(state, noneRef) === null);

        const projects = [];
        const before = structuredClone(state);

        for (const op of [
          acceptReview(before, projects, noneRef),
          declineReview(before, projects, noneRef),
          resolveConflict(before, projects, noneRef, unitCopyFor(noneSpec)),
        ]) {
          assert.equal(op.ok, false, `a NONE Unit must not resolve: ${noneRef}`);
          assert.equal(op.reason, 'not-found', `expected not-found for NONE Unit ${noneRef}`);
          assert.equal(op.kind, null, `a NONE Unit has no kind: ${noneRef}`);
        }
        // None of the not-found rejections touched the store.
        assert.deepStrictEqual(before, state, `not-found rejection mutated state for ${noneRef}`);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects the wrong interface for a fixed Review and Conflict (regression example)', () => {
    const state = createEmptySyncState();
    const review = {
      project_id: 'proj-1',
      name: 'Checkout',
      created_at: FIXED_ISO,
      recordings: [],
    };
    const localRec = {
      recording_id: 'rec-1',
      name: 'Add to cart',
      created_at: FIXED_ISO,
      steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    upsertReview(state, 'proj-1', review);
    upsertConflict(state, 'proj-2:rec-1', localRec, { ...localRec, name: 'Add to cart (server)' });

    // Routing.
    assert.equal(itemKind(state, 'proj-1'), 'review');
    assert.equal(itemKind(state, 'proj-2:rec-1'), 'conflict');
    assert.equal(itemKind(state, 'proj-9'), null);

    // Review opened with the Conflict chooser → rejected, even with a valid choice.
    const r = resolveConflict(state, [], 'proj-1', review);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wrong-interface');
    assert.equal(r.kind, 'review');

    // Conflict opened with the accept/decline view → rejected by both entry points.
    const a = acceptReview(state, [], 'proj-2:rec-1');
    assert.equal(a.ok, false);
    assert.equal(a.reason, 'wrong-interface');
    assert.equal(a.kind, 'conflict');

    const d = declineReview(state, [], 'proj-2:rec-1');
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'wrong-interface');
    assert.equal(d.kind, 'conflict');

    // The rejections left both records intact.
    assert.equal(itemKind(state, 'proj-1'), 'review');
    assert.equal(itemKind(state, 'proj-2:rec-1'), 'conflict');
  });
});
