/**
 * sync-store-roundtrip.property.test.js — Property test for SyncState
 * persistence round-trip through the SyncStore adapter.
 *
 * All conflict-handling state (baselines, retained snapshots, Review-and-Accept
 * items, and Conflicts) is persisted as one `SyncState` object through the
 * injected {@link SyncStore} adapter. Durability is what lets pending Conflicts
 * and Reviews survive an application restart and be resolved later,
 * and what lets each Sync_Baseline survive a restart so the
 * last-agreed state is not lost.
 *
 * This property pins that contract: for any well-formed SyncState, saving it
 * through the adapter and loading it back yields an equal SyncState. The fake
 * adapter serializes through a JSON string in a closed-over variable, mirroring
 * the real platform seams (the extension's `chrome.storage.local` blob and the
 * desktop app's Tauri `load_state` / `save_state` JSON blob) so the round-trip
 * exercises real persistence semantics rather than holding the same reference.
 *
 * Uses Node.js built-in test runner + fast-check.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// SyncState survives a save/load round-trip

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  loadSyncState,
  saveSyncState,
  createEmptySyncState,
  SYNC_STATE_SCHEMA_VERSION,
} from '../../sync-store.js';

// ─── In-memory fake SyncStore adapter ────────────────────────────────────────

/**
 * A fake {@link SyncStore} backed by a single closed-over variable. Crucially it
 * serializes to a JSON string on save and parses on load, exactly like the real
 * platform adapters persist their blob — so the value loaded back is a fresh,
 * structurally-independent object, never the same reference that was saved. A
 * store that "round-trips" only by handing back the same object reference would
 * pass a naive test but fail in production; this fake makes the test honest.
 *
 * @returns {import('../../sync-types.js').SyncStore}
 */
function makeInMemoryStore() {
  /** @type {string|null} */
  let blob = null;
  return {
    async load() {
      return blob === null ? null : JSON.parse(blob);
    },
    async save(state) {
      blob = JSON.stringify(state);
    },
  };
}

// ─── Generators ──────────────────────────────────────────────────────────────

const arbId = fc.uuid();

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

// A `unitRef` is `"<project_id>"` (project-level) or `"<project_id>:<recording_id>"`
// (recording-level). fast-check v4 removed `fc.hexaString`; `fc.uuid()` supplies
// the hyphenated-hex ids the convention expects.
const arbUnitRef = fc.oneof(
  arbId,
  fc.tuple(arbId, arbId).map(([p, r]) => `${p}:${r}`),
);

/** Split a unitRef on its FIRST colon (ids are colon-free UUIDs). */
function parseUnitRef(unitRef) {
  const i = unitRef.indexOf(':');
  return i === -1
    ? { project_id: unitRef, recording_id: null }
    : { project_id: unitRef.slice(0, i), recording_id: unitRef.slice(i + 1) };
}

// JSON-safe leaf values only: strings/booleans/integers/null round-trip exactly
// through JSON.stringify→JSON.parse, so any inequality after the round-trip is a
// store fault rather than a JSON artifact (e.g. -0 from arbitrary doubles).
const arbLeaf = fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.constant(null));

// Metadata is an optional, JSON-serializable object. Keys are drawn from a small
// safe set to avoid prototype-polluting keys (e.g. "__proto__") that JSON.parse
// would materialize differently from a plain literal.
const arbMetadata = fc.dictionary(
  fc.constantFrom('owner', 'count', 'flag', 'note', 'tag'),
  arbLeaf,
  { maxKeys: 4 },
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

/** A recoverable Unit copy: project-level or recording-level. */
const arbUnitCopy = fc.oneof(arbProjectCopy, arbRecordingCopy);

/** A BaselineRecord: content digest + recoverable agreed project + timestamp. */
const arbBaselineRecord = fc.record({
  digest: arbId,
  agreedState: arbProjectCopy,
  agreedAt: arbIso,
});

/** A SnapshotRecord: a retained pulled project + timestamp. */
const arbSnapshotRecord = fc.record({
  payload: arbProjectCopy,
  pulledAt: arbIso,
});

/**
 * Build a `unitRef`-keyed map from a value generator, normalizing each record's
 * `unitRef`/`project_id`/`recording_id` to agree with its key so the generated
 * items are internally consistent (as the upsert helpers would produce them).
 */
function arbUnitKeyedMap(valueGen) {
  return fc.dictionary(arbUnitRef, valueGen, { maxKeys: 4 }).map((dict) => {
    const out = {};
    for (const [unitRef, rec] of Object.entries(dict)) {
      const { project_id, recording_id } = parseUnitRef(unitRef);
      out[unitRef] = { ...rec, unitRef, project_id, recording_id };
    }
    return out;
  });
}

const arbReviewItem = fc.record({
  kind: fc.constant('review'),
  incoming: arbUnitCopy,
  status: fc.constantFrom('PENDING', 'APPLIED'),
  detectedAt: arbIso,
});

const arbConflictItem = fc.record({
  kind: fc.constant('conflict'),
  local: arbUnitCopy,
  incoming: arbUnitCopy,
  detectedAt: arbIso,
});

// `dismissedIncoming` is a `unitRef`-keyed map of the exact declined incoming
// content digest per Unit, so a later cycle that pulls the same
// incoming version does not re-offer it. The value is a single digest string;
// `fc.uuid()` supplies the hyphenated-hex digest shape used elsewhere here.
const arbDismissedIncoming = fc.dictionary(arbUnitRef, arbId, { maxKeys: 4 });

// `connectionTest` holds the last Connection_Test outcome, or `null` when
// untested. These are exactly the values `loadSyncState` preserves verbatim; any
// other value is normalized back to `null`, so generating only these keeps each
// generated SyncState a fixed point of normalization.
const arbConnectionTest = fc.constantFrom('pass', 'auth', 'unreachable', null);

// `settings` is the client-local reconciliation-policy + Auto-Sync block:
// three boolean toggles, the Connection_Test outcome, and the fingerprint
// the test was taken against (a string, or `null` when untested). All five keys
// are always present with valid-typed values so the generated object survives the
// load/save normalization unchanged.
const arbSettings = fc.record({
  autoAcceptUpdates: fc.boolean(),
  autoAcceptDeletions: fc.boolean(),
  autoSync: fc.boolean(),
  connectionTest: arbConnectionTest,
  testedSettingsFingerprint: fc.oneof(fc.string(), fc.constant(null)),
});

/**
 * An arbitrary, well-formed {@link SyncState}: a positive schema version plus all
 * six keyed/recoverable parts populated — the four deferred-state maps
 * (baselines, snapshots, reviews, conflicts) plus the later additions
 * `dismissedIncoming` (declined incoming digests) and `settings` (client-local
 * reconciliation-policy + Auto-Sync). `schema` ranges over a few positive
 * versions to exercise forward-migration values, which `loadSyncState` must
 * preserve verbatim.
 */
const arbSyncState = fc.record({
  schema: fc.integer({ min: 1, max: 3 }),
  baselines: fc.dictionary(arbId, arbBaselineRecord, { maxKeys: 3 }),
  snapshots: fc.dictionary(arbId, arbSnapshotRecord, { maxKeys: 3 }),
  reviews: arbUnitKeyedMap(arbReviewItem),
  conflicts: arbUnitKeyedMap(arbConflictItem),
  dismissedIncoming: arbDismissedIncoming,
  settings: arbSettings,
});

describe('SyncState survives a save/load round-trip', () => {
  it('saving an arbitrary SyncState then loading it back yields an equal SyncState', async () => {
    await fc.assert(
      fc.asyncProperty(arbSyncState, async (state) => {
        const store = makeInMemoryStore();
        // Snapshot the input so the round-trip is compared against an untouched
        // copy even if save/load were to mutate their argument.
        const original = structuredClone(state);

        await saveSyncState(store, state);
        const loaded = await loadSyncState(store);

        // Every part — baselines, snapshots, reviews, conflicts, the declined
        // dismissedIncoming digests, the client-local settings, and the schema
        // version — comes back equal, so all deferred state and policy persists
        // across a restart.
        assert.deepStrictEqual(loaded, original);
      }),
      { numRuns: 100 },
    );
  });

  it('an empty SyncState round-trips unchanged (regression example)', async () => {
    const store = makeInMemoryStore();
    const empty = createEmptySyncState();

    await saveSyncState(store, empty);
    const loaded = await loadSyncState(store);

    assert.deepStrictEqual(loaded, empty);
    assert.equal(loaded.schema, SYNC_STATE_SCHEMA_VERSION);
  });

  it('a populated SyncState with one baseline, review, conflict, dismissal, and settings round-trips (regression example)', async () => {
    const store = makeInMemoryStore();
    const recording = {
      recording_id: 'rec-1',
      name: 'Add to cart',
      created_at: '2024-01-02T00:00:00.000Z',
      steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const project = {
      project_id: 'proj-1',
      name: 'Checkout',
      created_at: '2024-01-01T00:00:00.000Z',
      recordings: [recording],
    };
    const state = {
      schema: SYNC_STATE_SCHEMA_VERSION,
      baselines: {
        'proj-1': { digest: 'd-1', agreedState: project, agreedAt: '2024-01-01T00:00:00.000Z' },
      },
      snapshots: {
        'proj-1': { payload: project, pulledAt: '2024-02-01T00:00:00.000Z' },
      },
      reviews: {
        'proj-1:rec-2': {
          kind: 'review',
          unitRef: 'proj-1:rec-2',
          project_id: 'proj-1',
          recording_id: 'rec-2',
          incoming: { ...recording, recording_id: 'rec-2' },
          status: 'PENDING',
          detectedAt: '2024-03-01T00:00:00.000Z',
        },
      },
      conflicts: {
        'proj-1:rec-1': {
          kind: 'conflict',
          unitRef: 'proj-1:rec-1',
          project_id: 'proj-1',
          recording_id: 'rec-1',
          local: recording,
          incoming: { ...recording, name: 'Add to cart (server)' },
          detectedAt: '2024-03-02T00:00:00.000Z',
        },
      },
      dismissedIncoming: {
        'proj-1:rec-3': 'digest-declined-1',
      },
      settings: {
        autoAcceptUpdates: true,
        autoAcceptDeletions: false,
        autoSync: true,
        connectionTest: 'pass',
        testedSettingsFingerprint: 'fp-1',
      },
    };

    await saveSyncState(store, state);
    const loaded = await loadSyncState(store);

    assert.deepStrictEqual(loaded, state);
  });
});
