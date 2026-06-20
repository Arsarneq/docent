/**
 * failed-add-isolation.property.test.js — Property test that a FAILED brand-new
 * add is isolated so the rest of the sync cycle still completes.
 *
 * The isolation guarantee: "IF adding a brand-new Unit (a project or a recording) fails
 * for any reason (e.g. a storage error or insufficient disk space), THEN THE
 * Sync_Client SHALL leave that Unit unsynced and continue processing the
 * remaining Units in the sync cycle." The same guarantee holds
 * for any non-auth per-project problem.
 *
 * ── The failure-isolation mechanism under test ──────────────────────────────
 * In `applyAutomaticOutcomes` (sync-client.js) the brand-new auto-add wraps its
 * baseline write in a try/catch:
 *
 *     try {
 *       const added = projectProjection(incoming);
 *       advanceBaseline(state, project_id, added);   // digest + deep-clone + write
 *       if (!mergedById.has(project_id)) { mergedById.set(...); order.push(...); }
 *     } catch {
 *       // Leave this Unit unsynced and continue with the rest.
 *     }
 *
 * The design comment notes "the baseline write is done first because its deep
 * clone is the only step that can fail; isolating that failure keeps a single
 * bad Unit from aborting the cycle." The whole point is that a
 * throw here is swallowed and the loop continues to the next Unit.
 *
 * ── How the failure is triggered (and an honest limitation) ─────────────────
 * The design's literal example is an UNCLONEABLE payload (its deep clone fails).
 * That cannot be reached through the public `sync()` path: the pull stage runs
 * `validatePayload`, which performs its OWN `JSON.stringify` and rejects any
 * unserializable payload before reconciliation; and even if such a payload got
 * through, `classifyProject` digests the same content (also via JSON) BEFORE the
 * isolated add, so the throw would land outside the try/catch. In short, any
 * content whose clone would throw is filtered out earlier, so a content failure
 * can never reach the brand-new try/catch via `sync()`.
 *
 * The OTHER example — "a storage error" — IS reachable and is what this test
 * drives. The injected `SyncStore` returns a `baselines` map that throws on a
 * write for exactly one brand-new project id (simulating a per-key storage
 * failure). That write is `state.baselines[project_id] = {…}` inside
 * `advanceBaseline`, executed inside the brand-new try/catch — exactly the
 * failure the mechanism isolates. Every other Unit's baseline write succeeds, so
 * the property pins that the failed Unit is left unsynced while the rest of the
 * cycle still completes.
 *
 * ── The property ────────────────────────────────────────────────────────────
 * For a cycle pulling several brand-new projects (one of which fails its
 * baseline write) plus an existing project gaining several brand-new sibling
 * recordings:
 *   - the cycle COMPLETES (never halts);
 *   - the failed project is left UNSYNCED — absent from the merged projects and
 *     absent from the baselines (it will simply be retried next cycle);
 *   - the failure is silent: it is NOT recorded as an error;
 *   - EVERY other brand-new project is added and recorded in the baseline;
 *   - EVERY brand-new recording in the existing project is appended and the
 *     existing project's baseline is recorded;
 *   - pre-existing sibling recordings are untouched;
 *   - the failed project's pulled payload is still retained as a Sync_Snapshot
 *     (nothing is lost — only the add was skipped).
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` (`makeResponse`-style
 * Response stubs). Uses the Node.js built-in test runner + fast-check (v4:
 * `fc.uuid({ version: 7 })` supplies ids that pass the manifest's UUIDv7 guard),
 * running 200 iterations (minimum 100).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// A failed add is isolated and the cycle continues

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// The stamp this client expects — derived from the same schema sync() uses, so
// every payload built with it passes the pull stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';

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
 * Installs a mock `fetch` serving a manifest plus per-project payloads keyed by
 * project_id:
 *   - PUT (push)        → 200 (push always succeeds here).
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload.
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
 * In-memory {@link SyncStore} whose loaded `SyncState.baselines` is a Proxy that
 * THROWS when a baseline is written for `failingProjectId`, simulating a per-key
 * storage failure (the "storage error" example). Every other key writes
 * normally through to the target, which the test inspects afterwards.
 *
 * `recordingsWithPendingActions`/locking are not involved; the gate is permissive.
 *
 * @param {string|null} failingProjectId - the project id whose baseline write
 *   throws, or null for a store that never fails (used by the success regression)
 */
function makeStore(failingProjectId) {
  // The real backing object every successful baseline write lands in.
  const baselineTarget = {};
  const baselinesProxy = new Proxy(baselineTarget, {
    set(target, prop, value) {
      if (failingProjectId != null && prop === failingProjectId) {
        throw new Error(`simulated storage failure writing baseline for ${prop}`);
      }
      target[prop] = value;
      return true;
    },
  });

  let saved = null;
  const store = {
    async load() {
      // A fresh, empty SyncState whose `baselines` is the throwing proxy.
      return { schema: 1, baselines: baselinesProxy, snapshots: {}, reviews: {}, conflicts: {} };
    },
    async save(state) {
      saved = state;
    },
  };
  return { store, baselineTarget, getSaved: () => saved };
}

/** Permissive {@link LiveState}: capture inactive, nothing locked, nothing pending. */
function makeLiveState() {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (so the pull stage never filters). */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── builders ─────────────────────────────────────────────────────────────────

/** A committed step record so recording digests are non-trivial. */
function makeStep(recording_id) {
  return { uuid: recording_id, logical_id: 'a', step_number: 0, deleted: false };
}

/** A recording with one committed step. */
function makeRecording(recording_id) {
  return {
    recording_id,
    name: `rec-${recording_id}`,
    created_at: FIXED_CREATED_AT,
    steps: [makeStep(recording_id)],
  };
}

/** A project object (local/incoming shape). */
function makeProject(project_id, recordings) {
  return { project_id, name: `proj-${project_id}`, created_at: FIXED_CREATED_AT, recordings };
}

/** Wrap a project into a Full_Project_Payload with a compatible stamp. */
function toPayload(project) {
  return {
    docent_format: { ...LOCAL_STAMP },
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
    },
    recordings: project.recordings,
  };
}

/** Set of recording_ids on a project. */
function recordingIds(project) {
  return new Set((project.recordings ?? []).map((r) => r.recording_id));
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbV7 = fc.uuid({ version: 7 });

/**
 * A scenario: counts first, then exactly the unique ids needed (so all ids —
 * across the existing project, the brand-new projects, and the recordings — are
 * globally distinct). Layout of `ids`:
 *   [0]                              → the existing project P0
 *   [1 .. 1+B)                       → B brand-new project ids
 *   [1+B .. 1+B+E)                   → E existing (already-synced) recording ids
 *   [1+B+E .. end)                   → N brand-new recording ids (N >= 1)
 */
const arbScenario = fc
  .record({
    numBrandNewProjects: fc.integer({ min: 2, max: 4 }),
    numExistingRecs: fc.integer({ min: 0, max: 2 }),
    numNewRecs: fc.integer({ min: 1, max: 3 }),
    failingOffset: fc.nat(),
  })
  .chain((counts) => {
    const total = 1 + counts.numBrandNewProjects + counts.numExistingRecs + counts.numNewRecs;
    return fc
      .uniqueArray(arbV7, { minLength: total, maxLength: total })
      .map((ids) => ({ ...counts, ids }));
  });

/** Materialize a scenario into local/incoming projects and the failing id. */
function materialize(scenario) {
  const { ids, numBrandNewProjects, numExistingRecs, numNewRecs, failingOffset } = scenario;

  const p0Id = ids[0];
  const brandNewProjectIds = ids.slice(1, 1 + numBrandNewProjects);
  const existingRecIds = ids.slice(
    1 + numBrandNewProjects,
    1 + numBrandNewProjects + numExistingRecs,
  );
  const newRecIds = ids.slice(1 + numBrandNewProjects + numExistingRecs);

  const failingId = brandNewProjectIds[failingOffset % brandNewProjectIds.length];

  const existingRecs = existingRecIds.map(makeRecording);
  const newRecs = newRecIds.map(makeRecording);

  // P0 exists on both sides; incoming carries the brand-new sibling recordings.
  const p0Local = makeProject(p0Id, existingRecs);
  const p0Incoming = makeProject(p0Id, [...existingRecs, ...newRecs]);

  // Brand-new projects: present only on the server (no local, no baseline).
  const brandNewIncoming = brandNewProjectIds.map((id) => makeProject(id, []));

  const localProjects = [p0Local];
  const incomingProjects = [p0Incoming, ...brandNewIncoming];

  const manifest = incomingProjects.map((p) => ({ project_id: p.project_id, name: p.name }));
  const payloadById = new Map(incomingProjects.map((p) => [p.project_id, toPayload(p)]));

  return {
    p0Id,
    brandNewProjectIds,
    existingRecIds,
    newRecIds,
    failingId,
    localProjects,
    manifest,
    payloadById,
  };
}

describe('A failed add is isolated and the cycle continues', () => {
  it('one brand-new project failing its baseline write is left unsynced while every other unit is still processed', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const {
          p0Id,
          brandNewProjectIds,
          existingRecIds,
          newRecIds,
          failingId,
          localProjects,
          manifest,
          payloadById,
        } = materialize(scenario);

        installMockFetch(manifest, payloadById);
        const { store, baselineTarget, getSaved } = makeStore(failingId);

        const { result, projects } = await sync(
          'https://srv.test',
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );

        const successIds = brandNewProjectIds.filter((id) => id !== failingId);

        // ── The cycle completes; the failed add is silent (not an error). ──
        assert.equal(result.halted, false, 'a failed add never halts the cycle');
        assert.equal(result.haltReason, null);
        assert.deepEqual(result.errors, [], 'a failed add is silent, not an error');
        assert.deepEqual(result.review, [], 'no review items in a pure brand-new cycle');
        assert.deepEqual(result.conflicts, [], 'no conflicts in a pure brand-new cycle');

        // ── Every pulled project was fetched + validated (the failed one too). ──
        const pulledSet = new Set(result.pulled);
        const allIncomingIds = [p0Id, ...brandNewProjectIds];
        assert.deepEqual(
          [...pulledSet].sort(),
          [...allIncomingIds].sort(),
          'all incoming projects are pulled, including the one whose add fails',
        );

        // ── The failed project is left UNSYNCED: not merged, not in baselines. ──
        const mergedById = new Map(projects.map((p) => [p.project_id, p]));
        assert.ok(
          !mergedById.has(failingId),
          'the failed brand-new project is NOT added to local projects',
        );
        assert.ok(
          !(failingId in baselineTarget),
          'the failed brand-new project is NOT recorded in the baseline',
        );

        // ── Every OTHER brand-new project IS added and recorded in the baseline. ──
        for (const id of successIds) {
          assert.ok(mergedById.has(id), `brand-new project ${id} is auto-added`);
          assert.ok(id in baselineTarget, `brand-new project ${id} is recorded in the baseline`);
          assert.equal(
            baselineTarget[id].agreedState.project_id,
            id,
            'the recorded baseline is the agreed project',
          );
        }

        // ── The existing project still gains every brand-new sibling recording,
        //    untouched existing recordings, and a recorded baseline. ──
        const mergedP0 = mergedById.get(p0Id);
        assert.ok(mergedP0, 'the existing project is still present');
        const mergedP0Recs = recordingIds(mergedP0);
        for (const id of existingRecIds) {
          assert.ok(mergedP0Recs.has(id), `existing sibling recording ${id} is untouched`);
        }
        for (const id of newRecIds) {
          assert.ok(mergedP0Recs.has(id), `brand-new recording ${id} is appended as a sibling`);
        }
        assert.equal(
          mergedP0Recs.size,
          existingRecIds.length + newRecIds.length,
          'the existing project has exactly its existing + new recordings',
        );
        assert.ok(
          p0Id in baselineTarget,
          'the existing project gains a baseline from its brand-new recordings',
        );

        // ── Nothing pulled is lost: the failed project is still retained as a
        //    recoverable Sync_Snapshot even though its add was skipped. ──
        const saved = getSaved();
        const snapshotKeys = new Set(Object.keys(saved.snapshots ?? {}));
        for (const id of allIncomingIds) {
          assert.ok(snapshotKeys.has(id), `pulled project ${id} is retained as a snapshot`);
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ────────────────────────────────────

  it('the FIRST of two brand-new projects failing does not stop the second from being added', async () => {
    const FAIL = '018f0000-0000-7000-8000-000000000001';
    const OK = '018f0000-0000-7000-8000-000000000002';

    const manifest = [
      { project_id: FAIL, name: 'proj-fail' },
      { project_id: OK, name: 'proj-ok' },
    ];
    const payloadById = new Map([
      [FAIL, toPayload(makeProject(FAIL, []))],
      [OK, toPayload(makeProject(OK, []))],
    ]);
    installMockFetch(manifest, payloadById);

    const { store, baselineTarget } = makeStore(FAIL);
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.errors, []);
    const mergedIds = new Set(projects.map((p) => p.project_id));
    assert.ok(!mergedIds.has(FAIL), 'the failing project is left unsynced');
    assert.ok(mergedIds.has(OK), 'the second brand-new project is still added');
    assert.ok(!(FAIL in baselineTarget));
    assert.ok(OK in baselineTarget);
  });

  it('a failed brand-new project does not block brand-new recordings being appended to an existing project', async () => {
    const P0 = '018f0000-0000-7000-8000-00000000000a';
    const FAIL = '018f0000-0000-7000-8000-00000000000b';
    const REC_OLD = '018f0000-0000-7000-8000-00000000000c';
    const REC_NEW = '018f0000-0000-7000-8000-00000000000d';

    const p0Local = makeProject(P0, [makeRecording(REC_OLD)]);
    const p0Incoming = makeProject(P0, [makeRecording(REC_OLD), makeRecording(REC_NEW)]);
    const failProject = makeProject(FAIL, []);

    const manifest = [
      { project_id: P0, name: p0Incoming.name },
      { project_id: FAIL, name: failProject.name },
    ];
    const payloadById = new Map([
      [P0, toPayload(p0Incoming)],
      [FAIL, toPayload(failProject)],
    ]);
    installMockFetch(manifest, payloadById);

    const { store, baselineTarget } = makeStore(FAIL);
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [p0Local],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.errors, []);

    const mergedIds = new Set(projects.map((p) => p.project_id));
    assert.ok(!mergedIds.has(FAIL), 'the failing brand-new project is left unsynced');
    assert.ok(!(FAIL in baselineTarget));

    const mergedP0 = projects.find((p) => p.project_id === P0);
    const recs = recordingIds(mergedP0);
    assert.ok(recs.has(REC_OLD), 'the existing recording is untouched');
    assert.ok(recs.has(REC_NEW), 'the brand-new recording is still appended');
    assert.ok(P0 in baselineTarget, 'the existing project gains a baseline');
  });

  it('with no failure injected, every brand-new project and recording is added and the cycle completes', async () => {
    const P0 = '018f0000-0000-7000-8000-000000000010';
    const B1 = '018f0000-0000-7000-8000-000000000011';
    const B2 = '018f0000-0000-7000-8000-000000000012';
    const REC_NEW = '018f0000-0000-7000-8000-000000000013';

    const p0Local = makeProject(P0, []);
    const p0Incoming = makeProject(P0, [makeRecording(REC_NEW)]);

    const manifest = [
      { project_id: P0, name: p0Incoming.name },
      { project_id: B1, name: `proj-${B1}` },
      { project_id: B2, name: `proj-${B2}` },
    ];
    const payloadById = new Map([
      [P0, toPayload(p0Incoming)],
      [B1, toPayload(makeProject(B1, []))],
      [B2, toPayload(makeProject(B2, []))],
    ]);
    installMockFetch(manifest, payloadById);

    const { store, baselineTarget } = makeStore(null); // never throws
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [p0Local],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    const mergedIds = new Set(projects.map((p) => p.project_id));
    assert.ok(mergedIds.has(P0) && mergedIds.has(B1) && mergedIds.has(B2));
    assert.ok(B1 in baselineTarget && B2 in baselineTarget && P0 in baselineTarget);
    const mergedP0 = projects.find((p) => p.project_id === P0);
    assert.ok(recordingIds(mergedP0).has(REC_NEW), 'the brand-new recording is appended');
  });
});
