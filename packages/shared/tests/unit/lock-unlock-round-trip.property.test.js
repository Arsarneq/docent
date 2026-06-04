/**
 * lock-unlock-round-trip.property.test.js — Property test for the lock/unlock
 * round trip: closing a lock makes a recording eligible again next cycle.
 *
 * A Locked_Recording is consulted only PER CYCLE: the orchestrator computes the
 * Locked_Recording set in its pre-flight gate and threads it into detection, so
 * a recording locked during cycle 1 is `locked-skipped` (excluded from the
 * inbound merge — no Review, no Conflict, no auto-add, local untouched), but the
 * lock leaves no durable mark. Once the recording is closed (the LiveState's
 * locked set no longer reports it), the very next cycle reconciles it normally
 * and produces whatever outcome its content warrants (R6.5).
 *
 * This property pins that round trip over a large input space by driving the
 * full `sync()` orchestrator twice against the SAME server payloads and the SAME
 * durable store, changing only the locked set between the two calls:
 *
 *   Cycle 1 — the target recording is LOCKED. It is excluded: no Review or
 *     Conflict is recorded or reported for it, it is not auto-added (brand-new
 *     case), and the local copy is left exactly as it was (R6.1–6.3, R6.5).
 *
 *   Cycle 2 — the lock is RELEASED (same inputs otherwise). The target now
 *     produces its expected outcome:
 *       • `changed-incoming` → a Review-and-Accept item appears (local still
 *         unchanged, only the incoming version retained);
 *       • `diverged`         → a Conflict appears, retaining both versions
 *         (local still unchanged);
 *       • `brand-new`        → the recording is appended to its project as a new
 *         sibling and recorded in the per-project baseline.
 *
 * The three outcome kinds are drawn by the generator so a single property covers
 * every eligibility path a closed lock can re-open.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling property
 * tests (`makeResponse`-style Response stubs, manifest + per-project payloads);
 * the validator passes; an in-memory `SyncStore` (seeded with the baseline)
 * persists across BOTH cycles; a `LiveState` reports the locked set, which is
 * the only thing that differs between cycle 1 and cycle 2.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4:
 * `fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * **Validates: Requirements 6.5**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 14: Closing a lock makes the recording eligible next cycle (lock/unlock round trip)

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { createEmptySyncState, getItem } from '../../sync-store.js';
import { advanceBaseline } from '../../sync-baseline.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

// ─── fetch double (mirrors sync-client.test.js) ──────────────────────────────

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
 * Installs a mock `fetch` that serves a manifest plus per-project payloads keyed
 * by project_id. The server view is identical across both cycles — only the
 * locked set changes — so PUT (push) → 200, GET /projects → manifest, and
 * GET /projects/:id → the project's Full_Project_Payload.
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, object>} payloadById
 */
function installMockFetch(manifest, payloadById) {
  globalThis.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') return makeResponse(200, { ok: true });
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    const id = decodeURIComponent(url.split('/').pop());
    const payload = payloadById.get(id);
    return payload ? makeResponse(200, payload) : makeResponse(404);
  };
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore} seeded with an initial SyncState and persisting
 * across cycles. Clones on the way in and out so no reference is shared with the
 * orchestrator — the round trip relies on the baseline surviving from cycle 1
 * into cycle 2 exactly as a real persisted store would.
 *
 * @param {import('../../sync-types.js').SyncState} initial
 */
function makeStore(initial) {
  let saved = structuredClone(initial);
  return {
    async load() {
      return structuredClone(saved);
    },
    async save(state) {
      saved = structuredClone(state);
    },
    getState() {
      return saved;
    },
  };
}

/**
 * A fake {@link LiveState}: capture inactive (a cycle runs), nothing pending
 * (the pending-actions assertion never fires), and `getLockedRecordingIds`
 * returns whatever locked set this cycle is given. The locked set is the ONLY
 * signal that differs between cycle 1 and cycle 2.
 *
 * @param {string[]} locked - recording_ids open in the Recording_View this cycle
 */
function makeLiveState(locked) {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(locked),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (eligibility, not validation, is the focus). */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── allowlisted projections (mirror sync-client.js / pull reconstruction) ────

/** @param {object} r */
function recordingProjection(r) {
  return {
    recording_id: r.recording_id,
    name: r.name,
    created_at: r.created_at,
    steps: r.steps ?? [],
  };
}

/** @param {object} p */
function projectProjection(p) {
  return {
    project_id: p.project_id,
    name: p.name,
    created_at: p.created_at,
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
    },
    recordings: (project.recordings ?? []).map(recordingProjection),
  };
}

/** JSON-normalize so nested fast-check records become plain objects (deepEqual-safe). */
function clean(value) {
  return JSON.parse(JSON.stringify(value));
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 20 }),
  deleted: fc.boolean(),
});

/**
 * A round-trip scenario. One project that exists on BOTH sides, carrying:
 *   - a STABLE sibling recording, identical on local / baseline / server
 *     (already-converged — it just rides along, untouched);
 *   - a TARGET recording whose eligibility we exercise. Its three content
 *     versions are distinguished by a guaranteed-distinct name suffix, so the
 *     `changed-incoming` / `diverged` / `brand-new` relationships hold no matter
 *     what steps fast-check draws.
 *
 * `kind` selects which eligibility path the closed lock must re-open.
 */
const arbScenario = fc
  .record({
    projectId: fc.uuid({ version: 7 }),
    projectName: fc.string({ maxLength: 20 }),
    projectCreatedAt: arbIso,

    siblingId: fc.uuid(),
    siblingName: fc.string({ maxLength: 20 }),
    siblingCreatedAt: arbIso,
    siblingSteps: fc.array(arbStep, { maxLength: 3 }),

    targetId: fc.uuid(),
    targetName: fc.string({ maxLength: 12 }),
    targetCreatedAt: arbIso,
    targetSteps: fc.array(arbStep, { maxLength: 3 }),

    kind: fc.constantFrom('changed-incoming', 'diverged', 'brand-new'),
  })
  .filter((s) => s.targetId !== s.siblingId);

/**
 * Materialize a scenario into the `sync()` inputs and the derived expectations.
 *
 * Returns:
 *   - `localProjects` — the local project (stable sibling + the target's local
 *     version, except `brand-new` where the target is absent locally);
 *   - `seed`          — a SyncState whose baseline is the agreed project (stable
 *     sibling + the target's agreed version, except `brand-new` where the target
 *     is absent from the baseline too);
 *   - `manifest` / `payloadById` — the server view (stable sibling + the
 *     target's server version);
 *   - `targetUnitRef` and the expected target projections per side.
 */
function materialize(s) {
  const sibling = clean({
    recording_id: s.siblingId,
    name: `${s.siblingName}::sibling`,
    created_at: s.siblingCreatedAt,
    steps: s.siblingSteps,
  });

  // Three content versions of the target, kept distinct by name suffix.
  const targetAgreed = clean({
    recording_id: s.targetId,
    name: `${s.targetName}::agreed`,
    created_at: s.targetCreatedAt,
    steps: s.targetSteps,
  });
  const targetLocal = clean({ ...targetAgreed, name: `${s.targetName}::local` });
  const targetServer = clean({ ...targetAgreed, name: `${s.targetName}::server` });

  const meta = { project_id: s.projectId, name: s.projectName, created_at: s.projectCreatedAt };

  let localRecs;
  let baselineRecs;
  let serverRecs;
  let expectedLocalTarget; // the target as it should remain locally (null = absent)
  let expectedIncomingTarget; // the target the server offers

  if (s.kind === 'changed-incoming') {
    // local == baseline (agreed); server moved → Review once eligible.
    localRecs = [sibling, targetAgreed];
    baselineRecs = [sibling, targetAgreed];
    serverRecs = [sibling, targetServer];
    expectedLocalTarget = recordingProjection(targetAgreed);
    expectedIncomingTarget = recordingProjection(targetServer);
  } else if (s.kind === 'diverged') {
    // local and server both moved off the agreed baseline → Conflict once eligible.
    localRecs = [sibling, targetLocal];
    baselineRecs = [sibling, targetAgreed];
    serverRecs = [sibling, targetServer];
    expectedLocalTarget = recordingProjection(targetLocal);
    expectedIncomingTarget = recordingProjection(targetServer);
  } else {
    // brand-new: target absent locally AND absent from the baseline; present
    // only on the server → auto-added as a sibling once eligible.
    localRecs = [sibling];
    baselineRecs = [sibling];
    serverRecs = [sibling, targetServer];
    expectedLocalTarget = null;
    expectedIncomingTarget = recordingProjection(targetServer);
  }

  const localProject = { ...meta, recordings: localRecs };
  const agreedProject = { ...meta, recordings: baselineRecs };
  const serverProject = { ...meta, recordings: serverRecs };

  const seed = createEmptySyncState();
  advanceBaseline(seed, s.projectId, projectProjection(agreedProject));

  const manifest = [{ project_id: s.projectId, name: s.projectName }];
  const payloadById = new Map([[s.projectId, buildPayload(serverProject)]]);

  return {
    kind: s.kind,
    projectId: s.projectId,
    siblingId: s.siblingId,
    targetId: s.targetId,
    targetUnitRef: `${s.projectId}:${s.targetId}`,
    localProjects: [localProject],
    seed,
    manifest,
    payloadById,
    expectedSibling: recordingProjection(sibling),
    expectedLocalTarget,
    expectedIncomingTarget,
  };
}

/** Find a recording by id in a project, or null. */
function findRec(project, recording_id) {
  return (project?.recordings ?? []).find((r) => r.recording_id === recording_id) ?? null;
}

// ─── Property 14 ──────────────────────────────────────────────────────────────

describe('Property 14: Closing a lock makes the recording eligible next cycle (lock/unlock round trip)', () => {
  it('excludes a locked recording in cycle 1, then reconciles it once unlocked in cycle 2', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const m = materialize(scenario);
        installMockFetch(m.manifest, m.payloadById);

        // A single durable store persists across BOTH cycles (the baseline must
        // survive cycle 1 → cycle 2 for the round trip to be faithful).
        const store = makeStore(m.seed);

        // ── Cycle 1 — target LOCKED ───────────────────────────────────────────
        const c1 = await sync(
          'https://srv.test',
          null,
          m.localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState([m.targetId]), // target is the Locked_Recording
        );

        assert.equal(c1.result.halted, false, 'cycle 1 runs (no live-work gate fires)');
        assert.equal(c1.result.haltReason, null);

        // The locked target is fully excluded: no Review/Conflict reported or recorded.
        assert.ok(
          !c1.result.review.includes(m.targetUnitRef),
          'cycle 1: locked target is not reported as a Review',
        );
        assert.ok(
          !c1.result.conflicts.includes(m.targetUnitRef),
          'cycle 1: locked target is not reported as a Conflict',
        );
        const state1 = store.getState();
        assert.equal(
          getItem(state1, m.targetUnitRef),
          null,
          'cycle 1: no deferred item is recorded for the locked target',
        );

        const c1Project = c1.projects.find((p) => p.project_id === m.projectId);
        assert.ok(c1Project, 'cycle 1: the project is still present');

        if (m.kind === 'brand-new') {
          // Locked ⇒ NOT auto-added, and absent from the baseline.
          assert.equal(
            findRec(c1Project, m.targetId),
            null,
            'cycle 1: a locked brand-new recording is not auto-added',
          );
          const b1 = state1.baselines?.[m.projectId];
          assert.ok(
            !(b1?.agreedState?.recordings ?? []).some((r) => r.recording_id === m.targetId),
            'cycle 1: a locked brand-new recording is not recorded in the baseline',
          );
        } else {
          // Locked ⇒ local copy left exactly as it was (no incoming change applied).
          assert.deepEqual(
            findRec(c1Project, m.targetId),
            m.expectedLocalTarget,
            'cycle 1: the locked target keeps its local version untouched',
          );
        }

        // ── Cycle 2 — lock RELEASED (same server, same store) ─────────────────
        // Feed cycle 1's merged output back in, exactly as a real round trip would.
        const c2 = await sync(
          'https://srv.test',
          null,
          c1.projects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState([]), // recording closed — nothing locked
        );

        assert.equal(c2.result.halted, false, 'cycle 2 runs');
        assert.equal(c2.result.haltReason, null);

        const state2 = store.getState();
        const c2Project = c2.projects.find((p) => p.project_id === m.projectId);
        assert.ok(c2Project, 'cycle 2: the project is still present');

        // The stable sibling rides along untouched in both cycles.
        assert.deepEqual(
          findRec(c2Project, m.siblingId),
          m.expectedSibling,
          'the stable sibling recording is never altered',
        );

        if (m.kind === 'changed-incoming') {
          // Now eligible ⇒ a Review appears; local stays unchanged; no Conflict.
          assert.ok(
            c2.result.review.includes(m.targetUnitRef),
            'cycle 2: the unlocked changed-incoming target becomes a Review',
          );
          assert.ok(!c2.result.conflicts.includes(m.targetUnitRef));
          const item = getItem(state2, m.targetUnitRef);
          assert.ok(item && item.kind === 'review', 'a Review item is recorded for the target');
          assert.deepEqual(
            item.incoming,
            m.expectedIncomingTarget,
            'the Review retains the incoming server version',
          );
          assert.deepEqual(
            findRec(c2Project, m.targetId),
            m.expectedLocalTarget,
            'cycle 2: local copy is still unchanged (Review never auto-applies)',
          );
        } else if (m.kind === 'diverged') {
          // Now eligible ⇒ a Conflict appears retaining both versions; local unchanged.
          assert.ok(
            c2.result.conflicts.includes(m.targetUnitRef),
            'cycle 2: the unlocked diverged target becomes a Conflict',
          );
          assert.ok(!c2.result.review.includes(m.targetUnitRef));
          const item = getItem(state2, m.targetUnitRef);
          assert.ok(item && item.kind === 'conflict', 'a Conflict item is recorded for the target');
          assert.deepEqual(item.local, m.expectedLocalTarget, 'Conflict retains the local version');
          assert.deepEqual(
            item.incoming,
            m.expectedIncomingTarget,
            'Conflict retains the incoming version',
          );
          assert.deepEqual(
            findRec(c2Project, m.targetId),
            m.expectedLocalTarget,
            'cycle 2: local copy is still unchanged (Conflict never auto-applies)',
          );
        } else {
          // brand-new: now eligible ⇒ appended as a sibling and recorded in the baseline.
          assert.ok(
            !c2.result.review.includes(m.targetUnitRef),
            'brand-new never defers to Review',
          );
          assert.ok(
            !c2.result.conflicts.includes(m.targetUnitRef),
            'brand-new never defers to Conflict',
          );
          assert.deepEqual(
            findRec(c2Project, m.targetId),
            m.expectedIncomingTarget,
            'cycle 2: the unlocked brand-new recording is auto-added as a sibling',
          );
          const b2 = state2.baselines?.[m.projectId];
          const inBaseline = (b2?.agreedState?.recordings ?? []).find(
            (r) => r.recording_id === m.targetId,
          );
          assert.deepEqual(
            inBaseline,
            m.expectedIncomingTarget,
            'cycle 2: the added recording is recorded in the baseline',
          );
        }
      }),
      { numRuns: 150 },
    );
  });

  // ── Deterministic regression examples ────────────────────────────────────

  const PID = '018f0000-0000-7000-8000-000000000010';
  const SIB = '018f0000-0000-7000-8000-0000000000a1';
  const TGT = '018f0000-0000-7000-8000-0000000000c2';

  function fixtureProject(targetRec) {
    return {
      project_id: PID,
      name: 'Round Trip',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [
        {
          recording_id: SIB,
          name: 'Sibling',
          created_at: '2026-01-01T00:00:00.000Z',
          steps: [{ uuid: 'sib1', logical_id: 'a', step_number: 0, deleted: false }],
        },
        ...(targetRec ? [targetRec] : []),
      ],
    };
  }

  it('a locked changed-incoming recording is skipped, then becomes a Review when unlocked', async () => {
    const agreed = {
      recording_id: TGT,
      name: 'Target::agreed',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 't1', logical_id: 'b', step_number: 0, deleted: false }],
    };
    const server = { ...agreed, name: 'Target::server' };

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(fixtureProject(agreed)));
    const store = makeStore(seed);

    installMockFetch(
      [{ project_id: PID, name: 'Round Trip' }],
      new Map([[PID, buildPayload(fixtureProject(server))]]),
    );

    const unitRef = `${PID}:${TGT}`;

    // Cycle 1 — locked.
    const c1 = await sync(
      'https://srv.test',
      null,
      [fixtureProject(agreed)],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState([TGT]),
    );
    assert.equal(c1.result.halted, false);
    assert.deepEqual(c1.result.review, [], 'cycle 1: nothing deferred while locked');
    assert.equal(getItem(store.getState(), unitRef), null);
    assert.deepEqual(
      findRec(c1.projects[0], TGT),
      recordingProjection(agreed),
      'cycle 1: local target untouched',
    );

    // Cycle 2 — unlocked.
    const c2 = await sync(
      'https://srv.test',
      null,
      c1.projects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState([]),
    );
    assert.equal(c2.result.halted, false);
    assert.deepEqual(c2.result.review, [unitRef], 'cycle 2: target is now a Review');
    const item = getItem(store.getState(), unitRef);
    assert.equal(item.kind, 'review');
    assert.deepEqual(item.incoming, recordingProjection(server));
    assert.deepEqual(
      findRec(c2.projects[0], TGT),
      recordingProjection(agreed),
      'cycle 2: local still unchanged (Review never auto-applies)',
    );
  });

  it('a locked brand-new recording is not added, then is auto-added when unlocked', async () => {
    const server = {
      recording_id: TGT,
      name: 'Brand New',
      created_at: '2026-02-01T00:00:00.000Z',
      steps: [{ uuid: 'n1', logical_id: 'c', step_number: 0, deleted: false }],
    };

    // Baseline + local hold only the sibling; the server adds the target.
    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(fixtureProject(null)));
    const store = makeStore(seed);

    installMockFetch(
      [{ project_id: PID, name: 'Round Trip' }],
      new Map([[PID, buildPayload(fixtureProject(server))]]),
    );

    const unitRef = `${PID}:${TGT}`;

    // Cycle 1 — locked: not added.
    const c1 = await sync(
      'https://srv.test',
      null,
      [fixtureProject(null)],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState([TGT]),
    );
    assert.equal(c1.result.halted, false);
    assert.deepEqual(c1.result.review, []);
    assert.deepEqual(c1.result.conflicts, []);
    assert.equal(findRec(c1.projects[0], TGT), null, 'cycle 1: locked brand-new not added');
    assert.ok(
      !(store.getState().baselines[PID].agreedState.recordings ?? []).some(
        (r) => r.recording_id === TGT,
      ),
      'cycle 1: locked brand-new not in baseline',
    );

    // Cycle 2 — unlocked: auto-added.
    const c2 = await sync(
      'https://srv.test',
      null,
      c1.projects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState([]),
    );
    assert.equal(c2.result.halted, false);
    assert.deepEqual(c2.result.review, []);
    assert.deepEqual(c2.result.conflicts, []);
    assert.deepEqual(
      findRec(c2.projects[0], TGT),
      recordingProjection(server),
      'cycle 2: brand-new recording auto-added as a sibling',
    );
    const inBaseline = store
      .getState()
      .baselines[PID].agreedState.recordings.find((r) => r.recording_id === TGT);
    assert.deepEqual(
      inBaseline,
      recordingProjection(server),
      'cycle 2: added recording in baseline',
    );
  });
});
