/**
 * sync-baseline.test.js — Unit tests for the Sync_Baseline helpers
 * (sync-baseline.js): getBaseline, advanceBaseline, getRecordingBaselineDigest.
 *
 * The Sync_Baseline is the retained last *mutually agreed* state per project.
 * These tests cover the three read/advance helpers:
 *
 *   - getBaseline                — returns null when no baseline exists (R1.6),
 *                                  otherwise the recorded BaselineRecord.
 *   - advanceBaseline            — stores a content digest plus a recoverable
 *                                  deep-copy of the agreed project, so later
 *                                  mutation of the caller's object cannot corrupt
 *                                  the recorded baseline (R1.1, R1.7, R3.3).
 *   - getRecordingBaselineDigest — derives a recording-level agreed digest from
 *                                  the per-project baseline, or null when absent.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getBaseline, advanceBaseline, getRecordingBaselineDigest } from '../../sync-baseline.js';
import { digestProject, digestRecording } from '../../sync-digest.js';
import { createEmptySyncState } from '../../sync-store.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Build a fresh, fully-independent agreed-project copy shaped like the
 * allowlisted ProjectCopy projection. Returned fresh each call so a test that
 * mutates it cannot leak into another test.
 */
function makeAgreedProject() {
  return {
    project_id: 'proj-1',
    name: 'Checkout Flows',
    created_at: '2024-01-01T00:00:00.000Z',
    metadata: { owner: 'alice' },
    recordings: [
      {
        recording_id: 'rec-1',
        name: 'Add to cart',
        created_at: '2024-01-02T00:00:00.000Z',
        steps: [
          { logical_id: 'log-1', uuid: 'uuid-1', kind: 'click', target: '#cart' },
          { logical_id: 'log-2', uuid: 'uuid-2', kind: 'type', value: 'qty' },
        ],
      },
      {
        recording_id: 'rec-2',
        name: 'Checkout',
        created_at: '2024-01-03T00:00:00.000Z',
        steps: [{ logical_id: 'log-3', uuid: 'uuid-3', kind: 'click', target: '#pay' }],
      },
    ],
  };
}

// ─── getBaseline ──────────────────────────────────────────────────────────────

describe('getBaseline', () => {
  it('returns null when no baseline exists for the project', () => {
    const state = createEmptySyncState();
    assert.equal(getBaseline(state, 'proj-1'), null);
  });

  it('returns null when the baselines map is missing entirely', () => {
    assert.equal(getBaseline({}, 'proj-1'), null);
  });

  it('returns null when state is null or undefined', () => {
    assert.equal(getBaseline(null, 'proj-1'), null);
    assert.equal(getBaseline(undefined, 'proj-1'), null);
  });

  it('returns the recorded record after advanceBaseline', () => {
    const state = createEmptySyncState();
    const agreed = makeAgreedProject();
    advanceBaseline(state, 'proj-1', agreed);

    const record = getBaseline(state, 'proj-1');
    assert.ok(record);
    assert.equal(record.digest, digestProject(agreed));
    assert.deepEqual(record.agreedState, agreed);
  });

  it('returns null for a different project than the one recorded', () => {
    const state = createEmptySyncState();
    advanceBaseline(state, 'proj-1', makeAgreedProject());
    assert.equal(getBaseline(state, 'proj-OTHER'), null);
  });
});

// ─── advanceBaseline ────────────────────────────────────────────────────────

describe('advanceBaseline', () => {
  it('stores the digest of the agreed project', () => {
    const state = createEmptySyncState();
    const agreed = makeAgreedProject();
    advanceBaseline(state, 'proj-1', agreed);

    assert.equal(state.baselines['proj-1'].digest, digestProject(agreed));
  });

  it('stores a recoverable deep copy of the agreed project (not the same reference)', () => {
    const state = createEmptySyncState();
    const agreed = makeAgreedProject();
    advanceBaseline(state, 'proj-1', agreed);

    const stored = state.baselines['proj-1'].agreedState;
    assert.deepEqual(stored, agreed);
    // A deep copy, not the caller's object or its nested references.
    assert.notEqual(stored, agreed);
    assert.notEqual(stored.recordings, agreed.recordings);
    assert.notEqual(stored.recordings[0], agreed.recordings[0]);
    assert.notEqual(stored.recordings[0].steps, agreed.recordings[0].steps);
  });

  it('stamps an ISO agreedAt timestamp from the injected clock', () => {
    const state = createEmptySyncState();
    const fixed = Date.parse('2024-06-15T12:30:00.000Z');
    advanceBaseline(state, 'proj-1', makeAgreedProject(), () => fixed);

    assert.equal(state.baselines['proj-1'].agreedAt, '2024-06-15T12:30:00.000Z');
  });

  it('does not corrupt the recorded baseline when the source is mutated afterward', () => {
    const state = createEmptySyncState();
    const agreed = makeAgreedProject();
    const expectedDigest = digestProject(agreed);
    advanceBaseline(state, 'proj-1', agreed);

    // Mutate every level of the caller's object after recording.
    agreed.name = 'MUTATED';
    agreed.metadata.owner = 'mallory';
    agreed.recordings.push({
      recording_id: 'rec-injected',
      name: 'Injected',
      created_at: '2024-09-09T00:00:00.000Z',
      steps: [],
    });
    agreed.recordings[0].name = 'Tampered';
    agreed.recordings[0].steps.push({ logical_id: 'evil', uuid: 'evil', kind: 'click' });

    const stored = state.baselines['proj-1'].agreedState;
    assert.equal(stored.name, 'Checkout Flows');
    assert.equal(stored.metadata.owner, 'alice');
    assert.equal(stored.recordings.length, 2);
    assert.equal(stored.recordings[0].name, 'Add to cart');
    assert.equal(stored.recordings[0].steps.length, 2);
    // The stored digest still reflects the original agreed state.
    assert.equal(state.baselines['proj-1'].digest, expectedDigest);
  });

  it('initializes the baselines map when it is missing', () => {
    const state = {}; // no baselines map
    advanceBaseline(state, 'proj-1', makeAgreedProject());
    assert.ok(state.baselines);
    assert.ok(state.baselines['proj-1']);
  });

  it('replaces a prior record, repairing a stale baseline to the newly-agreed state', () => {
    const state = createEmptySyncState();

    // Record an initial (now stale) agreed state.
    const stale = makeAgreedProject();
    stale.name = 'Old Name';
    advanceBaseline(state, 'proj-1', stale);
    const staleDigest = state.baselines['proj-1'].digest;

    // Advance to a fresh agreed state for the same project.
    const fresh = makeAgreedProject();
    fresh.name = 'New Agreed Name';
    advanceBaseline(state, 'proj-1', fresh);

    assert.notEqual(state.baselines['proj-1'].digest, staleDigest);
    assert.equal(state.baselines['proj-1'].digest, digestProject(fresh));
    assert.equal(state.baselines['proj-1'].agreedState.name, 'New Agreed Name');
  });

  it('keeps baselines for distinct projects independent', () => {
    const state = createEmptySyncState();
    const a = makeAgreedProject();
    const b = makeAgreedProject();
    b.project_id = 'proj-2';
    b.name = 'Second Project';

    advanceBaseline(state, 'proj-1', a);
    advanceBaseline(state, 'proj-2', b);

    assert.equal(state.baselines['proj-1'].digest, digestProject(a));
    assert.equal(state.baselines['proj-2'].digest, digestProject(b));
  });
});

// ─── getRecordingBaselineDigest ───────────────────────────────────────────────

describe('getRecordingBaselineDigest', () => {
  it('derives the correct recording digest from the per-project baseline', () => {
    const state = createEmptySyncState();
    const agreed = makeAgreedProject();
    advanceBaseline(state, 'proj-1', agreed);

    const baseline = getBaseline(state, 'proj-1');
    const derived = getRecordingBaselineDigest(baseline, 'rec-1');

    assert.equal(derived, digestRecording(agreed.recordings[0]));
  });

  it('derives the digest for each recording in the agreed project', () => {
    const state = createEmptySyncState();
    const agreed = makeAgreedProject();
    advanceBaseline(state, 'proj-1', agreed);

    const baseline = getBaseline(state, 'proj-1');
    assert.equal(
      getRecordingBaselineDigest(baseline, 'rec-2'),
      digestRecording(agreed.recordings[1]),
    );
  });

  it('returns null when the recording is absent from the agreed project', () => {
    const state = createEmptySyncState();
    advanceBaseline(state, 'proj-1', makeAgreedProject());

    const baseline = getBaseline(state, 'proj-1');
    assert.equal(getRecordingBaselineDigest(baseline, 'rec-MISSING'), null);
  });

  it('returns null when the baseline is null (no baseline recorded)', () => {
    assert.equal(getRecordingBaselineDigest(null, 'rec-1'), null);
  });

  it('returns null when the baseline carries no agreedState', () => {
    assert.equal(getRecordingBaselineDigest({ digest: 'x' }, 'rec-1'), null);
  });

  it('returns null when the agreed project has a non-array recordings field', () => {
    const baseline = { digest: 'x', agreedState: { project_id: 'proj-1' } };
    assert.equal(getRecordingBaselineDigest(baseline, 'rec-1'), null);
  });
});
