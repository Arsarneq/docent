/**
 * auth-failure-halt.property.test.js — Property test for the auth-failure sync
 * halt and the preservation of all durable deferred state.
 *
 * The opaque Sync_Server can reject a request with HTTP 401/403 at several
 * points in a cycle (the pull manifest GET, any per-project pull GET, or the
 * push PUT). When it does, `sync()` must HALT the whole cycle (`halted: true`,
 * `haltReason: 'auth'`) and leave every Conflict and Review-and-Accept item
 * recoverable (Requirements 14.3, 14.4, 14.5).
 *
 * In the PULL-FIRST cycle order (pull + snapshot → reconcile → persist → push,
 * Requirement 20.1) the guarantee is delivered two different ways depending on
 * where the auth failure lands:
 *
 *   - **Auth failure on the pull (manifest or per-project GET).** The cycle
 *     halts BEFORE reconciliation, and the durable `store` is read/written ONLY
 *     in the reconcile phase, so `store.save()` is never reached. The persisted
 *     SyncState is therefore byte-for-byte the pre-sync seed — every baseline,
 *     snapshot, Conflict, and Review untouched (R14.3–14.5, R20.6).
 *   - **Auth failure on the push PUT.** Pull + reconcile already completed and
 *     the store was already persisted (the persist is atomic and the sole write
 *     point), so the auth failure cannot corrupt it. The cycle still halts with
 *     `haltReason: 'auth'`, and every Conflict / Review unit remains recoverable
 *     — reconciliation only ever refreshes a deferred item in place or moves it
 *     between Review and Conflict (mutual exclusion), never silently drops it —
 *     so the set of deferred unitRefs is preserved (R14.3–14.5). Baselines may
 *     have advanced and new deferrals may have been recorded, so byte-for-byte
 *     seed equality is NOT asserted for this point.
 *
 * This property pins that contract over a large input space:
 *   - seed an in-memory store with an ARBITRARY SyncState (baselines, snapshots,
 *     reviews, conflicts);
 *   - drive a fake `fetch` that returns 401 or 403 at an arbitrary point (pull
 *     manifest, a per-project pull, or the push PUT);
 *   - assert the cycle halts with `haltReason: 'auth'`, and that the deferred
 *     Conflict/Review state is preserved per the phase-specific guarantee above.
 *
 * `LiveState` reports capture inactive with no locked or pending recordings, so
 * the pre-flight gate always passes and the ONLY halt that can occur is the auth
 * halt under test (never `capture-active` or `pending-actions-unprotected`).
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` (`makeResponse`). Uses
 * the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()` /
 * `fc.uuid({ version: 7 })` supply the hyphenated-hex ids the convention wants).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 27: Auth failure halts and preserves all deferred state

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// ─── fetch double (mirrors sync-client.test.js) ──────────────────────────────

/** Records every fetch call so we can confirm the auth path was reached. */
let fetchCalls = [];

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

/**
 * Installs a mock `fetch` that returns an auth-failure status (401/403) at a
 * chosen point in the cycle and 2xx everywhere else:
 *   - `'pull-manifest'` — the GET /projects manifest returns auth (the very
 *     first request in pull-first order; nothing else runs).
 *   - `'pull-project'`  — the manifest succeeds; the per-project GET returns auth.
 *   - `'push'`          — pull + reconcile succeed; the PUT (push) — the LAST
 *     phase in pull-first order — returns the auth status on the first project.
 *
 * @param {{ authStatus: number, failurePoint: string, manifest: object[] }} cfg
 */
function installAuthFetch({ authStatus, failurePoint, manifest }) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    const method = (options && options.method) || 'GET';

    if (method === 'PUT') {
      // Push phase.
      return failurePoint === 'push' ? makeResponse(authStatus) : makeResponse(200, { ok: true });
    }

    // GET — manifest vs. individual project.
    if (url.endsWith('/projects')) {
      return failurePoint === 'pull-manifest'
        ? makeResponse(authStatus)
        : makeResponse(200, manifest);
    }

    // Per-project pull GET /projects/:id.
    return failurePoint === 'pull-project'
      ? makeResponse(authStatus)
      : makeResponse(200, { project: {}, recordings: [] });
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── adapters (LiveState + SyncStore) ────────────────────────────────────────

/**
 * A fake {@link LiveState} that reports no live work: capture inactive, no
 * locked recordings, and no recordings holding Pending Actions. This guarantees
 * the pre-flight gate passes, so the only halt that can occur in the cycle is
 * the auth halt under test.
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
 * A fake {@link SyncStore} seeded with `seedState`, persisting through a JSON
 * blob exactly like the real platform adapters (extension `chrome.storage.local`,
 * desktop Tauri `load_state`/`save_state`). It counts `load`/`save` calls so the
 * test can prove the auth halt never touches durable state.
 *
 * @param {import('../../sync-types.js').SyncState} seedState
 */
function makeSeededStore(seedState) {
  let blob = JSON.stringify(seedState);
  const calls = { loads: 0, saves: 0 };
  const store = {
    async load() {
      calls.loads += 1;
      return JSON.parse(blob);
    },
    async save(state) {
      calls.saves += 1;
      blob = JSON.stringify(state);
    },
  };
  /** The state currently persisted in the store (parsed from the blob). */
  const currentPersisted = () => JSON.parse(blob);
  return { store, calls, currentPersisted };
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbId = fc.uuid();
// Manifest project_ids must be well-formed UUIDv7 or the pull path skips them
// (recorded as an error, not fetched), which would never reach a per-project
// auth failure. `fc.uuid({ version: 7 })` produces ids that pass isValidUuidv7.
const arbUuidV7 = fc.uuid({ version: 7 });

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

// JSON-safe leaves only, so the JSON blob round-trip in the fake store is exact.
const arbLeaf = fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.constant(null));

const arbMetadata = fc.dictionary(
  fc.constantFrom('owner', 'count', 'flag', 'note', 'tag'),
  arbLeaf,
  {
    maxKeys: 3,
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
    steps: fc.array(arbStep, { maxLength: 4 }),
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

/**
 * Build a `unitRef`-keyed map, normalizing each record's `unitRef` /
 * `project_id` / `recording_id` to agree with its key (as the upsert helpers
 * would produce them).
 */
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
 * deferred state. These are exactly the things the auth halt must preserve.
 */
const arbSyncState = fc.record({
  schema: fc.integer({ min: 1, max: 3 }),
  baselines: fc.dictionary(arbId, arbBaselineRecord, { maxKeys: 3 }),
  snapshots: fc.dictionary(arbId, arbSnapshotRecord, { maxKeys: 3 }),
  reviews: arbUnitKeyedMap(arbReviewItem),
  conflicts: arbUnitKeyedMap(arbConflictItem),
});

/** A minimal local project to drive the push phase. */
const arbLocalProject = fc.record({
  project_id: arbId,
  name: fc.string({ maxLength: 30 }),
  created_at: arbIso,
  recordings: fc.array(arbRecordingCopy, { maxLength: 2 }),
});

/** A manifest entry for the pull phase (valid UUIDv7 id). */
const arbManifestEntry = fc.record({
  project_id: arbUuidV7,
  name: fc.string({ maxLength: 20 }),
});

/**
 * A full auth-failure scenario. `localProjects` always has at least one project
 * (so the push phase fires) and `manifest` always has at least one valid entry
 * (so a per-project pull GET is attempted), making every `failurePoint`
 * reachable regardless of which one is chosen.
 */
const arbScenario = fc.record({
  authStatus: fc.constantFrom(401, 403),
  failurePoint: fc.constantFrom('push', 'pull-manifest', 'pull-project'),
  localProjects: fc.array(arbLocalProject, { minLength: 1, maxLength: 3 }),
  manifest: fc.array(arbManifestEntry, { minLength: 1, maxLength: 3 }),
  state: arbSyncState,
});

/** Permissive validator — auth halts return before any payload is validated. */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── Property 27 ──────────────────────────────────────────────────────────────

describe('Property 27: Auth failure halts and preserves all deferred state', () => {
  it('a 401/403 at any point halts with haltReason "auth" and leaves all durable state untouched', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { authStatus, failurePoint, localProjects, manifest, state } = scenario;

        // Snapshot the seed so the comparison is against an untouched copy.
        const seedBefore = structuredClone(state);

        installAuthFetch({ authStatus, failurePoint, manifest });
        const { store, calls, currentPersisted } = makeSeededStore(state);

        const { result, projects } = await sync(
          'https://srv.test',
          'some-key',
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeIdleLiveState(),
        );

        // The auth path was actually exercised (not short-circuited by a gate).
        assert.ok(fetchCalls.length >= 1, 'at least one request was made');

        // R14.3 — the cycle halts on the auth failure (never a live-work gate,
        // never an internal-error from reconcile).
        assert.equal(result.halted, true, 'cycle halts on 401/403');
        assert.equal(result.haltReason, 'auth', 'halt reason is auth');

        const persisted = currentPersisted();

        if (failurePoint === 'push') {
          // Auth failure on the PUSH (the last phase). Pull + reconcile already
          // completed and the store was already persisted, so `save()` ran. The
          // auth failure cannot corrupt durable state: every seeded Conflict and
          // Review-and-Accept unit is still recoverable in the persisted state
          // (reconciliation only refreshes a deferred item in place or moves it
          // between the mutually-exclusive Review/Conflict maps — it never drops
          // one). R14.4 + R14.5.
          assert.ok(calls.saves >= 1, 'reconcile persisted before the push auth failure');
          for (const ref of Object.keys(seedBefore.conflicts)) {
            assert.ok(
              persisted.conflicts[ref] || persisted.reviews[ref],
              `seeded Conflict ${ref} remains recoverable after a push auth halt`,
            );
          }
          for (const ref of Object.keys(seedBefore.reviews)) {
            assert.ok(
              persisted.reviews[ref] || persisted.conflicts[ref],
              `seeded Review ${ref} remains recoverable after a push auth halt`,
            );
          }
        } else {
          // Auth failure on the PULL (manifest or per-project GET). The cycle
          // halts BEFORE reconciliation, so the store is never written and the
          // persisted SyncState is byte-for-byte the pre-sync seed — every
          // baseline, snapshot, Conflict, and Review untouched. R14.3–14.5.
          assert.equal(calls.saves, 0, 'store.save() is never called on a pull auth halt');
          assert.deepStrictEqual(
            persisted,
            seedBefore,
            'persisted SyncState equals the pre-sync state',
          );
          // Local data is returned unchanged as well (the halt returns the input).
          assert.equal(projects, localProjects, 'local projects returned unmerged on a pull halt');
        }
      }),
      { numRuns: 100 },
    );
  });

  // ── Deterministic regression examples (one per failure point) ──────────────

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
    { project_id: 'p1', name: 'P1', created_at: '2026-01-01T00:00:00.000Z', recordings: [] },
  ];
  const manifest = [{ project_id: '0190a1b2-0000-7000-8000-000000000011', name: 'Srv1' }];

  it('401 on push halts after pull+reconcile persisted, keeping deferred state recoverable', async () => {
    const seed = seedState();
    installAuthFetch({ authStatus: 401, failurePoint: 'push', manifest });
    const { store, calls, currentPersisted } = makeSeededStore(seed);

    const { result } = await sync(
      'https://srv.test',
      'bad-key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'auth');
    // Pull-first: pull + reconcile ran and persisted BEFORE the push auth
    // failure, so the store was written and the deferred items remain
    // recoverable (the seeded Conflict and Review survive untouched).
    assert.ok(calls.saves >= 1, 'reconcile persisted before the push auth failure');
    const persisted = currentPersisted();
    assert.ok(persisted.conflicts['proj-1:rec-1'], 'seeded Conflict preserved');
    assert.ok(persisted.reviews['proj-1:rec-2'], 'seeded Review preserved');
    // The push that returned 401 is not counted as pushed.
    assert.deepEqual(result.pushed, []);
    // Order: pull manifest GET first, the push PUT last.
    assert.equal(fetchCalls[0].options.method, 'GET');
    assert.equal(fetchCalls[fetchCalls.length - 1].options.method, 'PUT');
  });

  it('403 on the pull manifest halts before reconcile and preserves deferred state byte-for-byte', async () => {
    const seed = seedState();
    installAuthFetch({ authStatus: 403, failurePoint: 'pull-manifest', manifest });
    const { store, calls, currentPersisted } = makeSeededStore(seed);

    const { result } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'auth');
    assert.deepEqual(result.pushed, [], 'nothing pushed: the manifest auth failure precedes push');
    assert.equal(calls.saves, 0, 'store never written when the pull halts before reconcile');
    assert.deepStrictEqual(currentPersisted(), seed);
    // The manifest GET is the very first (and only) request.
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'GET');
  });

  it('403 on a per-project pull halts before reconcile and preserves deferred state byte-for-byte', async () => {
    const seed = seedState();
    installAuthFetch({ authStatus: 403, failurePoint: 'pull-project', manifest });
    const { store, calls, currentPersisted } = makeSeededStore(seed);

    const { result } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'auth');
    assert.deepEqual(result.pushed, [], 'nothing pushed: the pull auth failure precedes push');
    assert.equal(calls.saves, 0);
    assert.deepStrictEqual(currentPersisted(), seed);
  });
});
