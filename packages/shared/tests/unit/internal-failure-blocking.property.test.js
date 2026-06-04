/**
 * internal-failure-blocking.property.test.js — Property test that an internal
 * detection / resolution failure BLOCKS the sync cycle rather than letting it
 * continue past a state that risks data loss, driving the real `sync()`
 * orchestrator.
 *
 * Requirement 16.2: "IF client-side conflict detection or Conflict_Resolution
 * fails, THEN THE Sync_Client SHALL block sync operations rather than continuing
 * with potential conflicts." The design encodes this as the "when in doubt,
 * preserve and block" backstop: the detection phase and its persist are wrapped
 * in a try/catch in `sync()`, and ANY throw before the single `saveSyncState`
 * commit point — whether the store load fails, detection throws, or the save
 * itself fails — aborts/blocks the whole cycle. The cycle then returns
 * `halted: true` with `haltReason: 'internal-error'`, the durable store is left
 * exactly as it was (never half-written), and the unchanged `localProjects` are
 * handed back (no partial merge).
 *
 * This property pins that guarantee over a large input space by injecting the
 * internal failure through the `SyncStore` adapter (the only seam where the
 * shared code is given an external object), across three distinct failure
 * points that all converge on the same try/catch boundary:
 *
 *   - `load-returns-throwing-state` — `store.load()` resolves to a state object
 *     whose property access throws (a corrupt/unreadable persisted blob). The
 *     throw lands inside `loadSyncState`, BEFORE detection.
 *   - `baselines-throw-on-access`   — `store.load()` resolves to a well-formed
 *     state whose `baselines` map throws on enumeration/read. The throw lands
 *     DURING detection (`applyAutomaticOutcomes` reads the baselines).
 *   - `save-throws`                 — detection completes, but `store.save()`
 *     throws at the single persist point, AFTER detection.
 *
 * For every failure point and over arbitrary local projects, server payloads,
 * and a seeded durable `SyncState`, the test asserts:
 *   (A) the cycle blocks — `halted: true`, `haltReason: 'internal-error'`;
 *   (B) the durable state is preserved — the committed persisted `SyncState`
 *       equals the pre-sync seed (the store is never half-written), and for the
 *       load/detection failures `save()` is never even reached;
 *   (C) the local projects are returned unchanged (the exact input reference —
 *       no partial merge), and no Review/Conflict/pull is reported.
 *
 * The pre-flight live-work gate is permissive (capture inactive, nothing locked,
 * nothing pending) and push + pull both succeed, so the ONLY halt that can occur
 * is the internal-error block under test (never a gate or auth halt).
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / `no-discard-no-overwrite`
 * (`makeResponse`-style Response stubs). Uses the Node.js built-in test runner +
 * fast-check v4 (`fc.uuid({ version: 7 })` supplies manifest ids that pass the
 * UUIDv7 guard).
 *
 * **Validates: Requirements 16.2**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 30: Internal detection or resolution failure blocks sync

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

// ─── fetch double (mirrors sync-client.test.js / no-discard-no-overwrite) ────

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Installs a mock `fetch` where push + pull always SUCCEED, so the cycle always
 * reaches the reconciliation phase (the only place an internal failure under
 * test can occur):
 *   - PUT (push)        → 200.
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload (404 if unknown).
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, object>} payloadById
 */
function installOkFetch(manifest, payloadById) {
  globalThis.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') return makeResponse(200, { ok: true });
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    const id = decodeURIComponent(url.split('/').pop());
    const payload = payloadById.get(id);
    return payload ? makeResponse(200, payload) : makeResponse(404);
  };
}

// ─── adapters (LiveState + the failing SyncStore) ─────────────────────────────

/**
 * A permissive {@link LiveState}: capture inactive, nothing locked, nothing
 * pending — so the pre-flight gate always passes and the only possible halt is
 * the internal-error block under test.
 *
 * @returns {import('../../sync-types.js').LiveState}
 */
function makeIdleLiveState() {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(),
    recordingsWithPendingActions: () => new Set(),
  };
}

/**
 * A Proxy whose every property read AND key enumeration throws. Models an
 * adapter that yields an unreadable / corrupt object: any attempt to interpret
 * it as a SyncState (or a SyncState map) fails internally.
 *
 * @param {string} label - included in the thrown error for traceability
 * @returns {object}
 */
function makeThrowingObject(label) {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`injected ${label} read failure`);
      },
      ownKeys() {
        throw new Error(`injected ${label} enumeration failure`);
      },
      getOwnPropertyDescriptor() {
        throw new Error(`injected ${label} descriptor failure`);
      },
    },
  );
}

/**
 * A fake {@link SyncStore} that injects an internal failure at a chosen point,
 * while tracking the COMMITTED durable state (updated only by a fully-successful
 * `save`) so the test can prove the failure left it untouched.
 *
 *   - `'load-returns-throwing-state'` — `load()` resolves to a whole-state object
 *     whose property access throws (fails inside `loadSyncState`).
 *   - `'baselines-throw-on-access'`   — `load()` resolves to a well-formed state
 *     whose `baselines` map throws on read/enumeration (fails during detection).
 *   - `'save-throws'`                 — `load()` is normal; `save()` throws BEFORE
 *     committing (fails at the persist point, after detection).
 *
 * @param {import('../../sync-types.js').SyncState} seedState
 * @param {('load-returns-throwing-state'|'baselines-throw-on-access'|'save-throws')} mode
 */
function makeFailingStore(seedState, mode) {
  // The durable persisted state. Only a fully-successful save() updates it, so
  // after any injected failure it must still equal the original seed.
  let committed = structuredClone(seedState);
  const calls = { loads: 0, saves: 0 };

  const store = {
    async load() {
      calls.loads += 1;
      if (mode === 'load-returns-throwing-state') {
        // The whole state object is unreadable.
        return makeThrowingObject('state');
      }
      if (mode === 'baselines-throw-on-access') {
        // Well-formed everywhere except the baselines map, which throws the
        // moment detection enumerates/reads it.
        return {
          schema: committed.schema,
          baselines: makeThrowingObject('baselines'),
          snapshots: structuredClone(committed.snapshots),
          reviews: structuredClone(committed.reviews),
          conflicts: structuredClone(committed.conflicts),
        };
      }
      // 'save-throws' — a normal, readable load.
      return structuredClone(committed);
    },
    async save(state) {
      calls.saves += 1;
      if (mode === 'save-throws') {
        // Throw BEFORE committing — the durable blob is left untouched.
        throw new Error('injected save failure');
      }
      committed = structuredClone(state);
    },
  };

  /** The state currently committed to durable storage (a fresh clone). */
  const currentPersisted = () => structuredClone(committed);
  return { store, calls, currentPersisted };
}

/** Accepts every payload — the block path is the focus, not validation. */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── allowlisted projection + payload builders (mirror sync-client.js) ────────

/** @param {object} r */
function recordingProjection(r) {
  return {
    recording_id: r.recording_id,
    name: r.name,
    created_at: r.created_at,
    ...(r.metadata && { metadata: r.metadata }),
    steps: r.steps ?? [],
  };
}

/** Build a Full_Project_Payload around a clean project object. */
function buildPayload(project) {
  return {
    docent_format: { ...LOCAL_STAMP },
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
      ...(project.metadata && { metadata: project.metadata }),
    },
    recordings: (project.recordings ?? []).map(recordingProjection),
  };
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbId = fc.uuid();
// Manifest project_ids must be well-formed UUIDv7 or the pull path skips them.
const arbId7 = fc.uuid({ version: 7 });

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

// JSON-safe leaves only, so structuredClone + the store's JSON-ish round-trip
// are exact.
const arbLeaf = fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.constant(null));
const arbMetadata = fc.dictionary(fc.constantFrom('owner', 'count', 'flag', 'note'), arbLeaf, {
  maxKeys: 3,
});

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
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    metadata: arbMetadata,
    steps: fc.array(arbStep, { maxLength: 3 }),
  },
  { requiredKeys: ['recording_id', 'name', 'created_at', 'steps'] },
);

/** A project projection with an ordered list of recordings (metadata optional). */
const arbProjectCopy = fc.record(
  {
    project_id: arbId,
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    metadata: arbMetadata,
    recordings: fc.array(arbRecordingCopy, { maxLength: 3 }),
  },
  { requiredKeys: ['project_id', 'name', 'created_at', 'recordings'] },
);

/** A recoverable Unit copy: project-level or recording-level. */
const arbUnitCopy = fc.oneof(arbProjectCopy, arbRecordingCopy);

/** A `unitRef`: `"<project_id>"` or `"<project_id>:<recording_id>"`. */
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

/** Build a `unitRef`-keyed map, normalizing each record to agree with its key. */
function arbUnitKeyedMap(valueGen) {
  return fc.dictionary(arbUnitRef, valueGen, { maxKeys: 3 }).map((dict) => {
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

const arbBaselineRecord = fc.record({
  digest: arbId,
  agreedState: arbProjectCopy,
  agreedAt: arbIso,
});

const arbSnapshotRecord = fc.record({
  payload: arbProjectCopy,
  pulledAt: arbIso,
});

/**
 * An arbitrary, well-formed {@link SyncState} carrying all four kinds of durable
 * state. This is exactly what the internal-error block must preserve untouched.
 */
const arbSyncState = fc.record({
  schema: fc.integer({ min: 1, max: 3 }),
  baselines: fc.dictionary(arbId, arbBaselineRecord, { maxKeys: 3 }),
  snapshots: fc.dictionary(arbId, arbSnapshotRecord, { maxKeys: 3 }),
  reviews: arbUnitKeyedMap(arbReviewItem),
  conflicts: arbUnitKeyedMap(arbConflictItem),
});

/** A local project to drive push + reconciliation. */
const arbLocalProject = fc.record({
  project_id: arbId7,
  name: fc.string({ maxLength: 20 }),
  created_at: arbIso,
  recordings: fc.uniqueArray(arbRecordingCopy, {
    selector: (r) => r.recording_id,
    maxLength: 2,
  }),
});

/** A server project (becomes a manifest entry + a per-id payload). */
const arbServerProject = fc.record({
  project_id: arbId7,
  name: fc.string({ maxLength: 20 }),
  created_at: arbIso,
  recordings: fc.uniqueArray(arbRecordingCopy, {
    selector: (r) => r.recording_id,
    maxLength: 2,
  }),
});

/**
 * A full block scenario: the injected failure mode plus the cycle inputs. The
 * local / server project lists may be empty — the reconciliation phase (and thus
 * every failure point) is reached regardless, since `sync()` always loads the
 * store, retains snapshots, and runs detection when a store is supplied.
 */
const arbScenario = fc.record({
  mode: fc.constantFrom('load-returns-throwing-state', 'baselines-throw-on-access', 'save-throws'),
  localProjects: fc.uniqueArray(arbLocalProject, { selector: (p) => p.project_id, maxLength: 3 }),
  serverProjects: fc.uniqueArray(arbServerProject, {
    selector: (p) => p.project_id,
    maxLength: 3,
  }),
  state: arbSyncState,
});

// ─── shared assertion ─────────────────────────────────────────────────────────

/**
 * Assert the block contract for one cycle: it halted with `internal-error`, the
 * durable state was preserved untouched, and the local projects were returned
 * unchanged with no partial merge reported.
 */
function assertBlocked({
  result,
  projects,
  localProjects,
  calls,
  currentPersisted,
  seedBefore,
  mode,
}) {
  // (A) R16.2 — the cycle BLOCKS rather than continuing.
  assert.equal(result.halted, true, 'an internal failure blocks the cycle');
  assert.equal(result.haltReason, 'internal-error', 'haltReason is internal-error');

  // (B) Durable state preserved: the committed persisted SyncState is byte-equal
  // to the pre-sync seed — the store is never half-written.
  assert.deepStrictEqual(
    currentPersisted(),
    seedBefore,
    'durable SyncState is preserved (store never half-written)',
  );
  if (mode === 'save-throws') {
    // Detection completed and the single persist point WAS reached, but it threw
    // before committing — so the durable state is still the seed (asserted above).
    assert.equal(calls.saves, 1, 'save() was attempted exactly once');
  } else {
    // The failure occurred before the persist point, so save() is never reached.
    assert.equal(calls.saves, 0, 'save() is never reached when load/detection fails');
  }

  // (C) No partial merge: the exact local input is handed back and nothing is
  // reported as pulled/reviewed/conflicted.
  assert.equal(projects, localProjects, 'the unchanged local projects are returned (no merge)');
  assert.deepEqual(result.pulled, [], 'nothing is reported pulled on a block');
  assert.deepEqual(result.review, [], 'nothing is reported in review on a block');
  assert.deepEqual(result.conflicts, [], 'nothing is reported in conflict on a block');
}

// ─── Property 30 ──────────────────────────────────────────────────────────────

describe('Property 30: Internal detection or resolution failure blocks sync', () => {
  it('an internal failure at load, during detection, or at save blocks the cycle and preserves all state', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ mode, localProjects, serverProjects, state }) => {
        // Build manifest + payloads from the server projects.
        const manifest = serverProjects.map((p) => ({ project_id: p.project_id, name: p.name }));
        const payloadById = new Map(serverProjects.map((p) => [p.project_id, buildPayload(p)]));
        installOkFetch(manifest, payloadById);

        // Snapshot the seed so the comparison is against an untouched copy.
        const seedBefore = structuredClone(state);
        const { store, calls, currentPersisted } = makeFailingStore(state, mode);

        const { result, projects } = await sync(
          'https://srv.test',
          'api-key',
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeIdleLiveState(),
        );

        // The reconciliation phase was actually reached (load attempted).
        assert.ok(calls.loads >= 1, 'the store load was attempted (reconciliation reached)');

        assertBlocked({
          result,
          projects,
          localProjects,
          calls,
          currentPersisted,
          seedBefore,
          mode,
        });
      }),
      { numRuns: 200 },
    );
  });

  // ─── Deterministic regression examples (one per failure point) ──────────────

  /** A small but non-empty seed state to assert preservation against. */
  function seedState() {
    return {
      schema: 1,
      baselines: {
        'proj-1': {
          digest: 'd-1',
          agreedState: {
            project_id: 'proj-1',
            name: 'Checkout',
            created_at: '2024-01-01T00:00:00.000Z',
            recordings: [],
          },
          agreedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      snapshots: {
        'proj-1': {
          payload: {
            project_id: 'proj-1',
            name: 'Checkout',
            created_at: '2024-01-01T00:00:00.000Z',
            recordings: [],
          },
          pulledAt: '2024-02-01T00:00:00.000Z',
        },
      },
      reviews: {
        'proj-1:rec-2': {
          kind: 'review',
          unitRef: 'proj-1:rec-2',
          project_id: 'proj-1',
          recording_id: 'rec-2',
          incoming: {
            recording_id: 'rec-2',
            name: 'Server change',
            created_at: '2024-01-02T00:00:00.000Z',
            steps: [],
          },
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
          local: {
            recording_id: 'rec-1',
            name: 'Local',
            created_at: '2024-01-02T00:00:00.000Z',
            steps: [],
          },
          incoming: {
            recording_id: 'rec-1',
            name: 'Server',
            created_at: '2024-01-02T00:00:00.000Z',
            steps: [],
          },
          detectedAt: '2024-03-02T00:00:00.000Z',
        },
      },
    };
  }

  const localProjects = [
    {
      project_id: '0190a1b2-0000-7000-8000-000000000001',
      name: 'P1',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [],
    },
  ];
  const manifest = [{ project_id: '0190a1b2-0000-7000-8000-000000000011', name: 'Srv1' }];
  const payloadById = new Map([
    [
      '0190a1b2-0000-7000-8000-000000000011',
      buildPayload({
        project_id: '0190a1b2-0000-7000-8000-000000000011',
        name: 'Srv1',
        created_at: '2026-01-01T00:00:00.000Z',
        recordings: [],
      }),
    ],
  ]);

  it('a store whose load() returns an unreadable state blocks before detection', async () => {
    const seed = seedState();
    installOkFetch(manifest, payloadById);
    const { store, calls, currentPersisted } = makeFailingStore(
      seed,
      'load-returns-throwing-state',
    );

    const { result, projects } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'internal-error');
    assert.equal(calls.saves, 0, 'save is never reached when load fails');
    assert.deepStrictEqual(currentPersisted(), seed);
    assert.equal(projects, localProjects);
  });

  it('a baselines map that throws during detection blocks the cycle', async () => {
    const seed = seedState();
    installOkFetch(manifest, payloadById);
    const { store, calls, currentPersisted } = makeFailingStore(seed, 'baselines-throw-on-access');

    const { result, projects } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'internal-error');
    assert.equal(calls.saves, 0, 'save is never reached when detection throws');
    assert.deepStrictEqual(currentPersisted(), seed);
    assert.equal(projects, localProjects);
  });

  it('a save() that throws at the persist point blocks the cycle, leaving the store untouched', async () => {
    const seed = seedState();
    installOkFetch(manifest, payloadById);
    const { store, calls, currentPersisted } = makeFailingStore(seed, 'save-throws');

    const { result, projects } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'internal-error');
    assert.equal(calls.saves, 1, 'the single persist point was attempted');
    assert.deepStrictEqual(currentPersisted(), seed, 'the failed save committed nothing');
    assert.equal(projects, localProjects);
  });
});
