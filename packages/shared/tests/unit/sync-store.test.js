/**
 * sync-store.test.js — Unit tests for the idempotent deferred-item record
 * helpers in sync-store.js: upsertConflict, upsertReview, clearItem, getItem.
 *
 * These tests pin the durable-state invariants that keep repeated sync cycles
 * predictable:
 *
 *   - Idempotence        — re-detecting the same Unit across cycles keeps
 *                                  exactly ONE record per unitRef, refreshing the
 *                                  recoverable copies while preserving the
 *                                  original detectedAt timestamp.
 *   - Mutual exclusion   — a Unit is either in Conflict, in
 *                                  Review-and-Accept, or NONE; recording one
 *                                  removes the other for that unitRef.
 *   - NONE handling      — clearItem returns a Unit to NONE and getItem
 *                                  returns null for a NONE Unit so it is later
 *                                  processed normally rather than as a duplicate.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptySyncState,
  upsertConflict,
  upsertReview,
  clearItem,
  getItem,
  recordDismissedIncoming,
  isDismissedIncoming,
  getSettings,
  setSettings,
} from '../../sync-store.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PROJECT_REF = 'proj-1';
const RECORDING_REF = 'proj-1:rec-1';

/**
 * Build a fresh, fully-independent recording-shaped copy (RecordingCopy). A new
 * object each call so a test that mutates it cannot leak into another test.
 */
function makeRecordingCopy(overrides = {}) {
  return {
    recording_id: 'rec-1',
    name: 'Add to cart',
    created_at: '2024-01-02T00:00:00.000Z',
    steps: [
      { logical_id: 'log-1', uuid: 'uuid-1', kind: 'click', target: '#cart' },
      { logical_id: 'log-2', uuid: 'uuid-2', kind: 'type', value: 'qty' },
    ],
    ...overrides,
  };
}

/**
 * Build a fresh, fully-independent project-shaped copy (ProjectCopy).
 */
function makeProjectCopy(overrides = {}) {
  return {
    project_id: 'proj-1',
    name: 'Checkout Flows',
    created_at: '2024-01-01T00:00:00.000Z',
    metadata: { owner: 'alice' },
    recordings: [makeRecordingCopy()],
    ...overrides,
  };
}

// A simple monotonic clock factory so detectedAt values are deterministic and
// distinguishable between a first record and a later refresh.
function clockReturning(...isoStrings) {
  const times = isoStrings.map((s) => Date.parse(s));
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

// ─── upsertConflict: idempotence ──────────────────────────────────────────────

describe('upsertConflict — idempotence', () => {
  it('keeps exactly one conflict record after repeated upserts for the same unitRef', () => {
    const state = createEmptySyncState();
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy({ name: 'srv' }));
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy({ name: 'srv2' }));
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy({ name: 'srv3' }));

    assert.equal(Object.keys(state.conflicts).length, 1);
    assert.ok(state.conflicts[RECORDING_REF]);
  });

  it('preserves the original detectedAt across refreshes', () => {
    const state = createEmptySyncState();
    const clock = clockReturning('2024-01-01T00:00:00.000Z', '2024-06-15T12:30:00.000Z');

    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy(), clock);
    const firstDetectedAt = state.conflicts[RECORDING_REF].detectedAt;
    assert.equal(firstDetectedAt, '2024-01-01T00:00:00.000Z');

    // Re-detect later: detectedAt must stay the first-detected timestamp.
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy(), clock);
    assert.equal(state.conflicts[RECORDING_REF].detectedAt, firstDetectedAt);
  });

  it('refreshes the recoverable copies to the latest detected versions', () => {
    const state = createEmptySyncState();
    upsertConflict(
      state,
      RECORDING_REF,
      makeRecordingCopy({ name: 'local-v1' }),
      makeRecordingCopy({ name: 'incoming-v1' }),
    );
    upsertConflict(
      state,
      RECORDING_REF,
      makeRecordingCopy({ name: 'local-v2' }),
      makeRecordingCopy({ name: 'incoming-v2' }),
    );

    assert.equal(state.conflicts[RECORDING_REF].local.name, 'local-v2');
    assert.equal(state.conflicts[RECORDING_REF].incoming.name, 'incoming-v2');
  });

  it('stores independent deep copies of both versions (caller mutation cannot corrupt the record)', () => {
    const state = createEmptySyncState();
    const local = makeRecordingCopy({ name: 'local' });
    const incoming = makeRecordingCopy({ name: 'incoming' });
    upsertConflict(state, RECORDING_REF, local, incoming);

    // Mutate the caller's objects after recording.
    local.name = 'MUTATED';
    local.steps.push({ logical_id: 'evil', uuid: 'evil', kind: 'click' });
    incoming.name = 'MUTATED';

    assert.equal(state.conflicts[RECORDING_REF].local.name, 'local');
    assert.equal(state.conflicts[RECORDING_REF].local.steps.length, 2);
    assert.equal(state.conflicts[RECORDING_REF].incoming.name, 'incoming');
    assert.notEqual(state.conflicts[RECORDING_REF].local, local);
  });

  it('parses a recording-level unitRef into project_id and recording_id', () => {
    const state = createEmptySyncState();
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy());
    assert.equal(state.conflicts[RECORDING_REF].project_id, 'proj-1');
    assert.equal(state.conflicts[RECORDING_REF].recording_id, 'rec-1');
  });

  it('parses a project-level unitRef with a null recording_id', () => {
    const state = createEmptySyncState();
    upsertConflict(state, PROJECT_REF, makeProjectCopy(), makeProjectCopy({ name: 'srv' }));
    assert.equal(state.conflicts[PROJECT_REF].project_id, 'proj-1');
    assert.equal(state.conflicts[PROJECT_REF].recording_id, null);
  });
});

// ─── upsertReview: idempotence ────────────────────────────────────────────────

describe('upsertReview — idempotence', () => {
  it('keeps exactly one review record after repeated upserts for the same unitRef', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy({ name: 'srv1' }));
    upsertReview(state, RECORDING_REF, makeRecordingCopy({ name: 'srv2' }));
    upsertReview(state, RECORDING_REF, makeRecordingCopy({ name: 'srv3' }));

    assert.equal(Object.keys(state.reviews).length, 1);
    assert.ok(state.reviews[RECORDING_REF]);
  });

  it('preserves the original detectedAt across refreshes', () => {
    const state = createEmptySyncState();
    const clock = clockReturning('2024-02-02T00:00:00.000Z', '2024-08-08T08:08:08.000Z');

    upsertReview(state, RECORDING_REF, makeRecordingCopy(), clock);
    const firstDetectedAt = state.reviews[RECORDING_REF].detectedAt;
    assert.equal(firstDetectedAt, '2024-02-02T00:00:00.000Z');

    upsertReview(state, RECORDING_REF, makeRecordingCopy(), clock);
    assert.equal(state.reviews[RECORDING_REF].detectedAt, firstDetectedAt);
  });

  it('refreshes the incoming copy and keeps status PENDING on refresh', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy({ name: 'incoming-v1' }));

    // Simulate the resolution workflow having marked it APPLIED, then re-detect.
    state.reviews[RECORDING_REF].status = 'APPLIED';
    upsertReview(state, RECORDING_REF, makeRecordingCopy({ name: 'incoming-v2' }));

    assert.equal(state.reviews[RECORDING_REF].incoming.name, 'incoming-v2');
    assert.equal(state.reviews[RECORDING_REF].status, 'PENDING');
  });

  it('stores only the incoming version (no local copy) for a review item', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy({ name: 'incoming' }));

    const item = state.reviews[RECORDING_REF];
    assert.equal(item.kind, 'review');
    assert.equal(item.incoming.name, 'incoming');
    assert.equal(item.local, undefined);
  });

  it('stores an independent deep copy of the incoming version', () => {
    const state = createEmptySyncState();
    const incoming = makeRecordingCopy({ name: 'incoming' });
    upsertReview(state, RECORDING_REF, incoming);

    incoming.name = 'MUTATED';
    incoming.steps.push({ logical_id: 'evil', uuid: 'evil', kind: 'click' });

    assert.equal(state.reviews[RECORDING_REF].incoming.name, 'incoming');
    assert.equal(state.reviews[RECORDING_REF].incoming.steps.length, 2);
  });
});

// ─── Mutual exclusion ─────────────────────────────────────────────────

describe('mutual exclusion between Conflict and Review', () => {
  it('upserting a conflict removes an existing review for the same unitRef', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy());
    assert.ok(state.reviews[RECORDING_REF]);

    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy({ name: 'srv' }));

    assert.equal(state.reviews[RECORDING_REF], undefined);
    assert.ok(state.conflicts[RECORDING_REF]);
    assert.equal(getItem(state, RECORDING_REF).kind, 'conflict');
  });

  it('upserting a review removes an existing conflict for the same unitRef', () => {
    const state = createEmptySyncState();
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy({ name: 'srv' }));
    assert.ok(state.conflicts[RECORDING_REF]);

    upsertReview(state, RECORDING_REF, makeRecordingCopy());

    assert.equal(state.conflicts[RECORDING_REF], undefined);
    assert.ok(state.reviews[RECORDING_REF]);
    assert.equal(getItem(state, RECORDING_REF).kind, 'review');
  });

  it('a unitRef never has both a conflict and a review at the same time', () => {
    const state = createEmptySyncState();
    // Flip-flop a few times; only one map ever holds the unitRef.
    upsertReview(state, RECORDING_REF, makeRecordingCopy());
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy());
    upsertReview(state, RECORDING_REF, makeRecordingCopy());

    const inConflict = Object.prototype.hasOwnProperty.call(state.conflicts, RECORDING_REF);
    const inReview = Object.prototype.hasOwnProperty.call(state.reviews, RECORDING_REF);
    assert.equal(inConflict && inReview, false);
    assert.ok(inReview);
  });

  it('keeps records for distinct unitRefs independent (exclusion is per-unitRef)', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy());
    upsertConflict(state, PROJECT_REF, makeProjectCopy(), makeProjectCopy({ name: 'srv' }));

    assert.ok(state.reviews[RECORDING_REF]);
    assert.ok(state.conflicts[PROJECT_REF]);
    assert.equal(getItem(state, RECORDING_REF).kind, 'review');
    assert.equal(getItem(state, PROJECT_REF).kind, 'conflict');
  });
});

// ─── clearItem → NONE ─────────────────────────────────────────

describe('clearItem — returns a Unit to NONE', () => {
  it('clears a conflict so the Unit is NONE', () => {
    const state = createEmptySyncState();
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy());
    clearItem(state, RECORDING_REF);

    assert.equal(state.conflicts[RECORDING_REF], undefined);
    assert.equal(getItem(state, RECORDING_REF), null);
  });

  it('clears a review so the Unit is NONE', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy());
    clearItem(state, RECORDING_REF);

    assert.equal(state.reviews[RECORDING_REF], undefined);
    assert.equal(getItem(state, RECORDING_REF), null);
  });

  it('is a no-op for a unitRef that is already NONE', () => {
    const state = createEmptySyncState();
    clearItem(state, RECORDING_REF);
    assert.equal(getItem(state, RECORDING_REF), null);
    assert.equal(Object.keys(state.conflicts).length, 0);
    assert.equal(Object.keys(state.reviews).length, 0);
  });

  it('clears only the targeted unitRef, leaving other records intact', () => {
    const state = createEmptySyncState();
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy());
    upsertReview(state, PROJECT_REF, makeProjectCopy());

    clearItem(state, RECORDING_REF);

    assert.equal(getItem(state, RECORDING_REF), null);
    assert.ok(getItem(state, PROJECT_REF));
  });

  it('also clears any recorded dismissed-incoming marker for the Unit', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy());
    recordDismissedIncoming(state, RECORDING_REF, 'digest-abc');
    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-abc'), true);

    clearItem(state, RECORDING_REF);

    // The resolved Unit returns FULLY to NONE: the deferred item is gone AND the
    // dismissal is gone, so a later identical incoming version is classified
    // afresh rather than suppressed by a stale dismissal.
    assert.equal(getItem(state, RECORDING_REF), null);
    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-abc'), false);
    assert.equal(state.dismissedIncoming[RECORDING_REF], undefined);
  });

  it('clears a standalone dismissed-incoming marker even with no deferred item', () => {
    const state = createEmptySyncState();
    recordDismissedIncoming(state, RECORDING_REF, 'digest-abc');

    clearItem(state, RECORDING_REF);

    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-abc'), false);
  });

  it('clears the dismissal only for the targeted unitRef, leaving others intact', () => {
    const state = createEmptySyncState();
    recordDismissedIncoming(state, RECORDING_REF, 'digest-abc');
    recordDismissedIncoming(state, PROJECT_REF, 'digest-xyz');

    clearItem(state, RECORDING_REF);

    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-abc'), false);
    assert.equal(isDismissedIncoming(state, PROJECT_REF, 'digest-xyz'), true);
  });
});

// ─── getItem ──────────────────────────────────────────────────────────

describe('getItem — reads the active deferred item or null for NONE', () => {
  it('returns null for a NONE Unit', () => {
    const state = createEmptySyncState();
    assert.equal(getItem(state, RECORDING_REF), null);
  });

  it('returns the active conflict record when present', () => {
    const state = createEmptySyncState();
    upsertConflict(state, RECORDING_REF, makeRecordingCopy(), makeRecordingCopy());

    const item = getItem(state, RECORDING_REF);
    assert.ok(item);
    assert.equal(item.kind, 'conflict');
    assert.equal(item.unitRef, RECORDING_REF);
  });

  it('returns the active review record when present', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy());

    const item = getItem(state, RECORDING_REF);
    assert.ok(item);
    assert.equal(item.kind, 'review');
    assert.equal(item.unitRef, RECORDING_REF);
  });

  it('returns null when state is null or undefined', () => {
    assert.equal(getItem(null, RECORDING_REF), null);
    assert.equal(getItem(undefined, RECORDING_REF), null);
  });

  it('returns null after a record is cleared (back to NONE)', () => {
    const state = createEmptySyncState();
    upsertReview(state, RECORDING_REF, makeRecordingCopy());
    assert.ok(getItem(state, RECORDING_REF));

    clearItem(state, RECORDING_REF);
    assert.equal(getItem(state, RECORDING_REF), null);
  });
});

// ─── recordDismissedIncoming / isDismissedIncoming ──────────────

describe('decline-dismissal of an incoming version', () => {
  it('records a dismissed incoming digest that isDismissedIncoming then reports', () => {
    const state = createEmptySyncState();
    recordDismissedIncoming(state, RECORDING_REF, 'digest-A');
    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-A'), true);
  });

  it('reports a DIFFERENT incoming version as not dismissed (classified afresh)', () => {
    const state = createEmptySyncState();
    recordDismissedIncoming(state, RECORDING_REF, 'digest-A');
    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-B'), false);
  });

  it('overwrites the prior dismissed digest so only the latest declined version is tracked', () => {
    const state = createEmptySyncState();
    recordDismissedIncoming(state, RECORDING_REF, 'digest-A');
    recordDismissedIncoming(state, RECORDING_REF, 'digest-B');

    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-A'), false);
    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-B'), true);
    assert.equal(Object.keys(state.dismissedIncoming).length, 1);
  });

  it('tracks dismissals independently per unitRef', () => {
    const state = createEmptySyncState();
    recordDismissedIncoming(state, RECORDING_REF, 'digest-A');
    recordDismissedIncoming(state, PROJECT_REF, 'digest-Z');

    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-A'), true);
    assert.equal(isDismissedIncoming(state, PROJECT_REF, 'digest-Z'), true);
    assert.equal(isDismissedIncoming(state, RECORDING_REF, 'digest-Z'), false);
  });

  it('isDismissedIncoming returns false for null/undefined state or missing map', () => {
    assert.equal(isDismissedIncoming(null, RECORDING_REF, 'd'), false);
    assert.equal(isDismissedIncoming(undefined, RECORDING_REF, 'd'), false);
    assert.equal(isDismissedIncoming({}, RECORDING_REF, 'd'), false);
  });
});

// ─── getSettings ────────────────────────────────────────

describe('getSettings — client-local settings with empty defaults', () => {
  it('returns the documented empty defaults for a fresh state', () => {
    const settings = getSettings(createEmptySyncState());
    assert.deepEqual(settings, {
      autoAcceptUpdates: false,
      autoAcceptDeletions: false,
      autoSync: false,
      connectionTest: null,
      testedSettingsFingerprint: null,
    });
  });

  it('normalizes a legacy state that lacks a settings field to defaults', () => {
    const settings = getSettings({ schema: 1, baselines: {} });
    assert.equal(settings.autoAcceptUpdates, false);
    assert.equal(settings.autoSync, false);
    assert.equal(settings.connectionTest, null);
  });

  it('returns an independent copy (mutating the result does not change the store)', () => {
    const state = createEmptySyncState();
    const settings = getSettings(state);
    settings.autoSync = true;
    assert.equal(state.settings.autoSync, false);
  });

  it('returns defaults for null/undefined state', () => {
    assert.equal(getSettings(null).autoSync, false);
    assert.equal(getSettings(undefined).autoAcceptUpdates, false);
  });
});

// ─── setSettings ────────────────────────────────────────

describe('setSettings — partial merge, normalized and client-local', () => {
  it('changes only the keys present in the partial, preserving the rest', () => {
    const state = createEmptySyncState();
    setSettings(state, { autoAcceptUpdates: true });

    assert.equal(state.settings.autoAcceptUpdates, true);
    assert.equal(state.settings.autoAcceptDeletions, false);
    assert.equal(state.settings.autoSync, false);
  });

  it('applies successive merges cumulatively', () => {
    const state = createEmptySyncState();
    setSettings(state, { autoAcceptUpdates: true });
    setSettings(state, { autoSync: true });

    assert.equal(state.settings.autoAcceptUpdates, true);
    assert.equal(state.settings.autoSync, true);
  });

  it('records a connection-test outcome and its tested settings fingerprint', () => {
    const state = createEmptySyncState();
    setSettings(state, { connectionTest: 'pass', testedSettingsFingerprint: 'fp-1' });

    assert.equal(state.settings.connectionTest, 'pass');
    assert.equal(state.settings.testedSettingsFingerprint, 'fp-1');
  });

  it('drops unrecognized keys and falls back wrong-typed values to defaults', () => {
    const state = createEmptySyncState();
    setSettings(state, { autoAcceptUpdates: 'yes', extra: 'nope' });

    assert.equal(state.settings.autoAcceptUpdates, false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.settings, 'extra'), false);
  });

  it('normalizes an invalid connectionTest value back to null', () => {
    const state = createEmptySyncState();
    setSettings(state, { connectionTest: 'bogus' });
    assert.equal(state.settings.connectionTest, null);
  });

  it('treats a non-object partial as a no-op', () => {
    const state = createEmptySyncState();
    setSettings(state, { autoSync: true });
    setSettings(state, null);
    assert.equal(state.settings.autoSync, true);
  });
});
