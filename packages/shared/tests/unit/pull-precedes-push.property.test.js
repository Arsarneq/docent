/**
 * pull-precedes-push.property.test.js — Property test for the pull-first cycle
 * ordering and the push-only-after-a-non-halting-reconcile guarantee.
 *
 * `sync()` runs a cycle in a fixed order: pre-flight gate → pull + snapshot →
 * reconcile (classify + apply automatic outcomes + record deferrals) → persist →
 * push. Two requirements ride on that order:
 *
 *   - **R20.1 — pull precedes push.** Every pull request (the GET /projects
 *     manifest and every per-project GET /projects/:id) is issued BEFORE any
 *     push request (a PUT /projects/:id). Pulling first is the precondition for
 *     detecting a concurrent server change: a push-first order would set the
 *     server equal to local before the pull observed it, so `incoming == local`
 *     would always hold and a divergence could never be detected.
 *   - **R20.6 — push only after a non-halting reconcile.** A push runs only once
 *     the pull and reconciliation phases of the SAME cycle have completed without
 *     an aborting/halting error. If the cycle halts before reconciliation
 *     completes — an auth halt on the pull (401/403), or an internal-error abort
 *     while loading the store / running detection / persisting — NO push PUT is
 *     ever issued.
 *
 * ── How the invariant is pinned ──────────────────────────────────────────────
 * The test drives the REAL `sync()` with a mock `fetch` and a mock `SyncStore`
 * that together write to a single ORDERED event log: every fetch records its
 * method + url, and every `store.save()` records a SAVE marker. Three halt modes
 * are exercised over arbitrary projects:
 *
 *   - `none`           — pull + reconcile + push all succeed. Assert: every GET
 *                        precedes every PUT (R20.1); a SAVE (the reconcile
 *                        persist) precedes the first PUT (R20.6, the positive
 *                        case — push runs only after a non-halting reconcile +
 *                        persist); and at least one PUT is issued (the push path
 *                        is really exercised).
 *   - `pull-auth`      — the manifest GET or a per-project GET returns 401/403.
 *                        Assert: the cycle halts with `haltReason: 'auth'`, NO
 *                        PUT is issued, and the store is never persisted (the
 *                        halt precedes reconcile). R20.6.
 *   - `internal-error` — the store throws while loading, during detection, or at
 *                        the persist point. Assert: the cycle halts with
 *                        `haltReason: 'internal-error'` and NO PUT is issued.
 *                        R20.6.
 *
 * Across EVERY mode the universal ordering invariant is asserted: no pull GET is
 * ever issued after a push PUT.
 *
 * `fetch` and the adapters are mocked exactly as in the sibling sync property
 * tests (`per-unit-push-assembly` / `auth-failure-halt` / `internal-failure-blocking`):
 * `makeResponse`-style Response stubs dispatching per project_id, a persistent
 * in-memory `SyncStore`, and a `LiveState` reporting capture inactive with
 * nothing locked or pending so the pre-flight gate always lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * **Validates: Requirements 20.1, 20.6**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 38: Pull precedes push; push runs only after a non-halting reconcile

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { createEmptySyncState } from '../../sync-store.js';
import { advanceBaseline } from '../../sync-baseline.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

const PROJ_CREATED = '2026-01-01T00:00:00.000Z';
const REC_CREATED = '2026-02-01T00:00:00.000Z';

// ─── ordered event log (fetch calls + store saves, interleaved) ──────────────

/**
 * The single ordered log of side effects the cycle produces:
 *   - `{ kind: 'GET', url }`  — a pull request (manifest or per-project).
 *   - `{ kind: 'PUT', url }`  — a push request.
 *   - `{ kind: 'SAVE' }`      — the reconcile persist point (`store.save`).
 * Reset at the start of every scenario by `installMockFetch`.
 */
let events = [];

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
 * Installs a mock `fetch` that records every call into the shared event log and
 * serves a manifest plus per-project payloads keyed by project_id. An optional
 * auth failure can be injected at the manifest GET or the per-project GET to
 * exercise a pull halt:
 *   - PUT (push)        → 200 (the push phase, when reached, always succeeds).
 *   - GET /projects     → the manifest array (or `authStatus` when `failurePoint`
 *                         is `'pull-manifest'`).
 *   - GET /projects/:id → the project's Full_Project_Payload (or `authStatus`
 *                         when `failurePoint` is `'pull-project'`).
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, object>} payloadById
 * @param {{ authStatus?: number|null, failurePoint?: string|null }} [authCfg]
 */
function installMockFetch(manifest, payloadById, { authStatus = null, failurePoint = null } = {}) {
  events = [];
  globalThis.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    events.push({ kind: method, url });

    if (method === 'PUT') return makeResponse(200, { ok: true });

    if (url.endsWith('/projects')) {
      return failurePoint === 'pull-manifest'
        ? makeResponse(authStatus)
        : makeResponse(200, manifest);
    }

    // Per-project pull GET /projects/:id.
    if (failurePoint === 'pull-project') return makeResponse(authStatus);
    const id = decodeURIComponent(url.split('/').pop());
    const payload = payloadById.get(id);
    return payload ? makeResponse(200, payload) : makeResponse(404);
  };
}

// ─── event-log views + ordering assertions ───────────────────────────────────

/** Every push PUT in the log, in order. */
function puts() {
  return events.filter((e) => e.kind === 'PUT');
}

/**
 * The universal ordering invariant (R20.1): no pull GET is ever issued after a
 * push PUT. Holds vacuously when no PUT (or no GET) was issued.
 */
function assertNoGetAfterPut() {
  let seenPut = false;
  for (const e of events) {
    if (e.kind === 'PUT') seenPut = true;
    else if (e.kind === 'GET') {
      assert.ok(!seenPut, 'a pull GET must never be issued after a push PUT (R20.1)');
    }
  }
}

/**
 * The positive R20.6 case: a push runs only after the reconcile persist. When at
 * least one PUT was issued, a SAVE (the sole persist point) must appear before
 * the FIRST PUT.
 */
function assertPushFollowsPersist() {
  const firstPutIdx = events.findIndex((e) => e.kind === 'PUT');
  if (firstPutIdx === -1) return; // no push this cycle — nothing to order.
  const persistedBeforePush = events.slice(0, firstPutIdx).some((e) => e.kind === 'SAVE');
  assert.ok(
    persistedBeforePush,
    'a push runs only after a non-halting reconcile persisted (SAVE precedes the first PUT) (R20.6)',
  );
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * A Proxy whose every property read AND key enumeration throws — models a
 * corrupt/unreadable persisted blob or map (mirrors internal-failure-blocking).
 *
 * @param {string} label
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
 * In-memory {@link SyncStore} seeded with an initial SyncState. Records a SAVE
 * marker in the shared event log at the persist point so push-after-persist
 * ordering can be asserted. An optional `failMode` injects an internal failure:
 *   - `'load-throws'`     — `load()` resolves to an unreadable state (fails in
 *     `loadSyncState`, BEFORE detection).
 *   - `'baselines-throw'` — `load()` resolves to a state whose `baselines` map
 *     throws on read (fails DURING detection).
 *   - `'save-throws'`     — `save()` throws at the single persist point (AFTER
 *     detection).
 *
 * @param {import('../../sync-types.js').SyncState} initial
 * @param {('load-throws'|'baselines-throw'|'save-throws'|null)} [failMode]
 */
function makeStore(initial, failMode = null) {
  let saved = structuredClone(initial);
  return {
    async load() {
      if (failMode === 'load-throws') return makeThrowingObject('state');
      if (failMode === 'baselines-throw') {
        return {
          schema: saved.schema,
          baselines: makeThrowingObject('baselines'),
          snapshots: structuredClone(saved.snapshots),
          reviews: structuredClone(saved.reviews),
          conflicts: structuredClone(saved.conflicts),
        };
      }
      return structuredClone(saved);
    },
    async save(state) {
      events.push({ kind: 'SAVE' });
      if (failMode === 'save-throws') throw new Error('injected save failure');
      saved = structuredClone(state);
    },
  };
}

/**
 * A {@link LiveState}: capture inactive, nothing locked, nothing pending — so
 * the pre-flight gate always passes and the only halt that can occur is the auth
 * or internal-error halt under test.
 */
function makeIdleLiveState() {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (ordering is the focus). */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── allowlisted projections + payload builders (mirror sync-client.js) ───────

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

/** @param {object} p */
function projectProjection(p) {
  return {
    project_id: p.project_id,
    name: p.name,
    created_at: p.created_at,
    ...(p.metadata && { metadata: p.metadata }),
    recordings: (p.recordings ?? []).map(recordingProjection),
  };
}

/** Build a Full_Project_Payload around a (clean) project object. */
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

/** A plain recording literal at a given version name + steps. */
function rec(recording_id, name, steps) {
  return { recording_id, name, created_at: REC_CREATED, steps };
}

// ─── generators ──────────────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 20 }),
  deleted: fc.boolean(),
});

/**
 * One recording in a project present on both sides, tagged with the outcome it
 * should settle into. Only the recording `name` drives the classification (the
 * steps are shared across versions, R2.8):
 *   - `converged` — local == server == baseline.
 *   - `clo`       — local moved, server still at baseline (changed-local-outgoing).
 *   - `diverged`  — local and server both moved (a Conflict, deferred).
 * All three keep the project's metadata Unit converged, so the project is always
 * a push candidate; the mix simply makes reconcile do real work before the push.
 */
const arbBothRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  steps: fc.array(arbStep, { maxLength: 3 }),
  outcome: fc.constantFrom('converged', 'clo', 'diverged'),
});

const arbBothProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recordings: fc.uniqueArray(arbBothRecordingSpec, {
    selector: (r) => r.recording_id,
    maxLength: 4,
  }),
});

/** A server-only project (brand-new-remote): pulled + auto-added, never pushed. */
const arbServerOnlyProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recordings: fc.uniqueArray(
    fc.record({ recording_id: fc.uuid(), steps: fc.array(arbStep, { maxLength: 3 }) }),
    { selector: (r) => r.recording_id, maxLength: 3 },
  ),
});

/** The halt mode for a scenario (and the parameters needed to inject it). */
const arbHaltMode = fc.oneof(
  { weight: 2, arbitrary: fc.record({ mode: fc.constant('none') }) },
  {
    weight: 1,
    arbitrary: fc.record({
      mode: fc.constant('pull-auth'),
      authStatus: fc.constantFrom(401, 403),
      failurePoint: fc.constantFrom('pull-manifest', 'pull-project'),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      mode: fc.constant('internal-error'),
      failMode: fc.constantFrom('load-throws', 'baselines-throw', 'save-throws'),
    }),
  },
);

const arbScenario = fc.record({
  halt: arbHaltMode,
  // At least one project present on both sides guarantees a per-project pull GET
  // (so 'pull-project' is reachable) and a push PUT in the 'none' case.
  bothProjects: fc.uniqueArray(arbBothProjectSpec, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 3,
  }),
  serverOnlyProjects: fc.uniqueArray(arbServerOnlyProjectSpec, {
    selector: (p) => p.project_id,
    maxLength: 2,
  }),
});

/**
 * Materialize a scenario into the `sync()` inputs: the seed SyncState (with
 * baselines), local projects, the server manifest, and the per-id payload map.
 */
function materialize({ bothProjects, serverOnlyProjects }) {
  const seed = createEmptySyncState();
  const localProjects = [];
  const payloadById = new Map();
  const manifest = [];

  const bothIds = new Set(bothProjects.map((p) => p.project_id));

  for (const pspec of bothProjects) {
    const pid = pspec.project_id;
    const pname = `Project ${pid.slice(0, 8)}`;
    const baselineRecs = [];
    const localRecs = [];
    const serverRecs = [];

    for (const rspec of pspec.recordings) {
      const rid = rspec.recording_id;
      const steps = rspec.steps;
      switch (rspec.outcome) {
        case 'converged':
          baselineRecs.push(rec(rid, 'base', steps));
          localRecs.push(rec(rid, 'base', steps));
          serverRecs.push(rec(rid, 'base', steps));
          break;
        case 'clo':
          baselineRecs.push(rec(rid, 'base', steps));
          localRecs.push(rec(rid, 'local', steps));
          serverRecs.push(rec(rid, 'base', steps));
          break;
        case 'diverged':
          baselineRecs.push(rec(rid, 'base', steps));
          localRecs.push(rec(rid, 'local', steps));
          serverRecs.push(rec(rid, 'server', steps));
          break;
        default:
          throw new Error(`unknown outcome ${rspec.outcome}`);
      }
    }

    if (baselineRecs.length > 0) {
      advanceBaseline(
        seed,
        pid,
        projectProjection({
          project_id: pid,
          name: pname,
          created_at: PROJ_CREATED,
          recordings: baselineRecs,
        }),
      );
    }

    localProjects.push({
      project_id: pid,
      name: pname,
      created_at: PROJ_CREATED,
      recordings: localRecs,
    });
    payloadById.set(
      pid,
      buildPayload({
        project_id: pid,
        name: pname,
        created_at: PROJ_CREATED,
        recordings: serverRecs,
      }),
    );
    manifest.push({ project_id: pid, name: pname });
  }

  for (const pspec of serverOnlyProjects) {
    const pid = pspec.project_id;
    if (bothIds.has(pid)) continue; // keep ids unique across both lists.
    const pname = `Remote ${pid.slice(0, 8)}`;
    const serverRecs = pspec.recordings.map((r) => rec(r.recording_id, 'srv', r.steps));
    payloadById.set(
      pid,
      buildPayload({
        project_id: pid,
        name: pname,
        created_at: PROJ_CREATED,
        recordings: serverRecs,
      }),
    );
    manifest.push({ project_id: pid, name: pname });
  }

  return { seed, localProjects, payloadById, manifest };
}

// ─── Property 38 ──────────────────────────────────────────────────────────────

describe('Property 38: Pull precedes push; push runs only after a non-halting reconcile', () => {
  it('issues every pull before any push, and never pushes when the cycle halts before reconcile completes', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { seed, localProjects, payloadById, manifest } = materialize(scenario);
        const { halt } = scenario;

        const failMode = halt.mode === 'internal-error' ? halt.failMode : null;
        installMockFetch(manifest, payloadById, {
          authStatus: halt.mode === 'pull-auth' ? halt.authStatus : null,
          failurePoint: halt.mode === 'pull-auth' ? halt.failurePoint : null,
        });
        const store = makeStore(seed, failMode);

        const { result } = await sync(
          'https://srv.test',
          'api-key',
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeIdleLiveState(),
        );

        // ── Universal ordering invariant (R20.1): no GET after any PUT ────────
        assertNoGetAfterPut();

        if (halt.mode === 'none') {
          // Non-halting cycle: pull + reconcile + push all ran.
          assert.equal(result.halted, false, 'a clean cycle does not halt');
          assert.equal(result.haltReason, null, 'no halt reason on a clean cycle');
          // The push path was really exercised (≥1 local project → ≥1 PUT).
          assert.ok(puts().length >= 1, 'at least one project was pushed');
          // R20.6 positive: a push runs only after the reconcile persisted.
          assertPushFollowsPersist();
        } else if (halt.mode === 'pull-auth') {
          // A 401/403 on the pull halts BEFORE reconcile (R20.6): no push, and
          // the store is never persisted.
          assert.equal(result.halted, true, 'a pull auth failure halts the cycle');
          assert.equal(result.haltReason, 'auth', 'halt reason is auth');
          assert.equal(puts().length, 0, 'no push PUT is issued when the pull halts (R20.6)');
          assert.ok(
            !events.some((e) => e.kind === 'SAVE'),
            'the store is never persisted when the pull halts before reconcile',
          );
        } else {
          // An internal failure (load / detection / persist) aborts the cycle
          // (R20.6 / R16.2): no push is ever issued.
          assert.equal(result.halted, true, 'an internal failure halts the cycle');
          assert.equal(result.haltReason, 'internal-error', 'halt reason is internal-error');
          assert.equal(puts().length, 0, 'no push PUT is issued when reconcile aborts (R20.6)');
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ──────────────────────────────────────

  /** Seed + inputs for a single converged project present on both sides. */
  function oneProjectInputs(pid) {
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];
    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec('rec-1', 'base', steps)],
      }),
    );
    const localProjects = [
      // local moved → changed-local-outgoing → a real push.
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec('rec-1', 'local', steps)],
      },
    ];
    const manifest = [{ project_id: pid, name: 'P' }];
    const payloadById = new Map([
      [
        pid,
        buildPayload({
          project_id: pid,
          name: 'P',
          created_at: PROJ_CREATED,
          recordings: [rec('rec-1', 'base', steps)], // server still at baseline
        }),
      ],
    ]);
    return { seed, localProjects, manifest, payloadById };
  }

  it('a clean cycle issues the pull manifest GET first and the push PUT last, after the persist', async () => {
    const pid = '018f4e2a-0000-7000-8000-0000000000a1';
    const { seed, localProjects, manifest, payloadById } = oneProjectInputs(pid);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeIdleLiveState(),
    );

    assert.equal(result.halted, false);
    assert.equal(result.haltReason, null);

    // The very first request is the manifest GET; the last is the push PUT.
    assert.equal(events[0].kind, 'GET');
    assert.ok(events[0].url.endsWith('/projects'), 'pull manifest GET is first');
    const last = events[events.length - 1];
    assert.equal(last.kind, 'PUT', 'the push PUT is the last request');

    assertNoGetAfterPut();
    assertPushFollowsPersist();
    assert.deepEqual(result.pushed, [pid], 'the changed-local-outgoing project was pushed');
  });

  it('a 401 on the pull manifest halts with no push and no persist', async () => {
    const pid = '018f4e2a-0000-7000-8000-0000000000a2';
    const { seed, localProjects, manifest, payloadById } = oneProjectInputs(pid);
    installMockFetch(manifest, payloadById, { authStatus: 401, failurePoint: 'pull-manifest' });

    const { result } = await sync(
      'https://srv.test',
      'bad-key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'auth');
    assert.equal(puts().length, 0, 'no push when the manifest pull halts');
    assert.ok(!events.some((e) => e.kind === 'SAVE'), 'the store is never persisted');
    // The manifest GET was the only request.
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'GET');
  });

  it('a 403 on a per-project pull halts after the manifest but before any push', async () => {
    const pid = '018f4e2a-0000-7000-8000-0000000000a3';
    const { seed, localProjects, manifest, payloadById } = oneProjectInputs(pid);
    installMockFetch(manifest, payloadById, { authStatus: 403, failurePoint: 'pull-project' });

    const { result } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'auth');
    assert.equal(puts().length, 0, 'no push when a per-project pull halts');
    assert.ok(!events.some((e) => e.kind === 'SAVE'), 'the store is never persisted');
    assertNoGetAfterPut();
  });

  it('an internal-error abort during reconcile issues no push', async () => {
    const pid = '018f4e2a-0000-7000-8000-0000000000a4';
    const { seed, localProjects, manifest, payloadById } = oneProjectInputs(pid);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed, 'baselines-throw'),
      makeIdleLiveState(),
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'internal-error');
    assert.equal(puts().length, 0, 'no push when reconcile aborts');
    // The pull completed (manifest + per-project GET) before the abort.
    assert.ok(
      events.some((e) => e.kind === 'GET' && e.url.endsWith('/projects')),
      'the pull manifest GET ran before the reconcile abort',
    );
    assertNoGetAfterPut();
  });
});
