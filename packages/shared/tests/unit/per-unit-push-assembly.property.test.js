/**
 * per-unit-push-assembly.property.test.js — Property test for the per-unit
 * assembly of the outbound push payload.
 *
 * The push is a *whole-project write*: the server stores the `Full_Project_Payload`
 * VERBATIM. That makes the payload's per-recording contents load-bearing in two
 * opposite directions at once:
 *
 *   - **No accidental deletion (R6.4).** A recording present on ANY side (local,
 *     server, or baseline) that the payload omits would read to other clients as
 *     a deliberate recording deletion. So every such recording must appear in the
 *     pushed body.
 *   - **No clobber of an un-reconciled server change (R20.3).** A recording this
 *     client has NOT reconciled — a deferred (Review/Conflict) unit or a Locked
 *     recording — must be sent at the version most recently *agreed-or-pulled* for
 *     it (its Sync_Snapshot version when pulled this cycle, else its Sync_Baseline
 *     version), NOT the un-reconciled live local edits, so the whole-project write
 *     cannot overwrite the concurrent server change.
 *
 * Property 37 (design): "For any project pushed in a cycle, the assembled
 * `Full_Project_Payload` contains, for each recording: the local version when the
 * recording is clean-local-new, `changed-local-outgoing`, or `already-converged`;
 * and the agreed-or-pulled version when the recording is deferred (Review/Conflict)
 * or locked. No recording present locally, on the server, or in the baseline is
 * omitted from the payload."
 *
 * **Validates: Requirements 20.3, 6.4**
 *
 * ── How the invariant is pinned ──────────────────────────────────────────────
 * The test drives the REAL `sync()` (pull → reconcile → per-unit push) with a
 * mock `fetch` that serves a full manifest + per-project payloads on GET and
 * captures every PUT body in order. Each project is generated with a MIX of
 * recordings, one per classification the assembly must treat differently:
 *
 *   - `changed-local-outgoing` — local moved, server still at baseline → push the
 *                                LOCAL edit (it must reach the wire).
 *   - `already-converged`      — local == server == baseline → push local (== both).
 *   - `clean-local-new`        — local-only, no baseline, not on server → push local.
 *   - `brand-new-remote`       — server-only → auto-added, pushed at the merged
 *                                (incoming) version, and NOT omitted.
 *   - `diverged` (Conflict)    — local and server both moved → deferred; push the
 *                                AGREED-OR-PULLED (server snapshot) version, never
 *                                the divergent local edits (the no-clobber case).
 *   - `changed-incoming` (Review) — server moved, local unchanged, Auto-Accept OFF
 *                                → deferred; push the agreed-or-pulled version.
 *   - `locked`                 — open in the Recording_View → excluded from the
 *                                inbound merge, but present in the push at its
 *                                agreed-or-pulled version, never the local edits.
 *
 * Version differences are driven by the recording `name` (folded into the content
 * digest, R2.8) so each category settles into its intended classification. For
 * EVERY pushed recording the test asserts the pushed projection deep-equals the
 * EXPECTED source version (local for clean/outgoing/converged/new/auto-added,
 * server for deferred/locked), that no recording present on any side is omitted,
 * and — the teeth of R20.3 — that a deferred or locked recording's pushed version
 * is the server's (agreed-or-pulled) one, never the divergent local edits.
 *
 * `fetch` is mocked exactly as in the sibling sync property tests
 * (`idempotent-detection` / `no-permanent-loss`): `makeResponse`-style Response
 * stubs dispatching per project_id; the validator passes; a persistent in-memory
 * `SyncStore` is seeded with the baselines; a `LiveState` reports the locked set
 * (capture inactive, nothing pending) so the pre-flight gate lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 37: The push payload is assembled per-unit (no clobber, no accidental deletion)

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

// ─── fetch double (mirrors idempotent-detection / no-permanent-loss) ─────────

/** Records every fetch call so PUT (push) bodies can be inspected in order. */
let fetchCalls = [];

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
 * by project_id and records every call:
 *   - PUT (push)        → 200 (the push phase always succeeds), body captured.
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload.
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, object>} payloadById
 */
function installMockFetch(manifest, payloadById) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') return makeResponse(200, { ok: true });
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    const id = decodeURIComponent(url.split('/').pop());
    const payload = payloadById.get(id);
    return payload ? makeResponse(200, payload) : makeResponse(404);
  };
}

/** The PUT bodies captured during a push, in push order, with their target URL. */
function capturedPuts() {
  return fetchCalls
    .filter((c) => c.options && c.options.method === 'PUT')
    .map((c) => ({ url: c.url, body: JSON.parse(c.options.body) }));
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore} seeded with an initial SyncState. Clones on the way
 * in and out so no reference is shared with the code under test.
 *
 * @param {import('../../sync-types.js').SyncState} initial
 */
function makeStore(initial) {
  let saved = structuredClone(initial);
  return {
    async load() {
      return saved ? structuredClone(saved) : null;
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
 * A {@link LiveState}: capture inactive (so a cycle runs), `getLockedRecordingIds`
 * returns the generated locked set, and nothing is pending (so the pending-actions
 * assertion never fires). These are the only signals the pre-flight gate reads.
 *
 * @param {string[]} locked - recording_ids open in the Recording_View
 */
function makeLiveState(locked) {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(locked),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (the assembly is the focus). */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── allowlisted projections (mirror sync-client.js exactly) ──────────────────

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

/** Build a plain recording literal at a given version name + steps. */
function rec(recording_id, name, steps) {
  return { recording_id, name, created_at: REC_CREATED, steps };
}

/** Stable JSON identity for a recording projection (prototype-agnostic). */
function projKey(recording) {
  return JSON.stringify(recordingProjection(recording));
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
 * One recording, tagged with the classification it should settle into. Each
 * outcome maps to a (baseline, local, server) version triple in {@link versionsFor};
 * the steps are shared across versions so only the recording `name` drives the
 * intended classification (R2.8). The recording_id is a plain uuid (recording ids
 * are not subject to the manifest's UUIDv7 guard — only project_ids are).
 */
const arbRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  steps: fc.array(arbStep, { maxLength: 3 }),
  outcome: fc.constantFrom(
    'changed-local-outgoing',
    'already-converged',
    'clean-local-new',
    'brand-new-remote',
    'diverged',
    'changed-incoming',
    'locked',
  ),
});

const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recordings: fc.uniqueArray(arbRecordingSpec, {
    selector: (r) => r.recording_id,
    minLength: 1,
    maxLength: 5,
  }),
});

const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 3,
});

/**
 * The (baseline, local, server) version triple for a recording outcome, plus
 * which side the per-unit push assembly is expected to send:
 *   - `expect: 'local'`  — push the local/merged version (clean/outgoing/converged/new).
 *   - `expect: 'server'` — push the agreed-or-pulled (server snapshot) version
 *                          (deferred Review/Conflict, locked, or auto-added remote).
 *   - `locked: true`     — recording is open in the Recording_View this cycle.
 *
 * @param {string} outcome
 * @param {string} rid
 * @param {object[]} steps
 */
function versionsFor(outcome, rid, steps) {
  switch (outcome) {
    case 'changed-local-outgoing':
      // local moved, server still at the agreed baseline → push the LOCAL edit.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'clo-local', steps),
        server: rec(rid, 'base', steps),
        expect: 'local',
      };
    case 'already-converged':
      // local == server == baseline → push local (identical to both).
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'base', steps),
        server: rec(rid, 'base', steps),
        expect: 'local',
      };
    case 'clean-local-new':
      // local-only new work (no baseline, absent on server) → push the LOCAL version.
      return { baseline: null, local: rec(rid, 'new-local', steps), server: null, expect: 'local' };
    case 'brand-new-remote':
      // server-only new work → auto-added to the merged list and pushed at the
      // merged (incoming) version; must NOT be omitted.
      return {
        baseline: null,
        local: null,
        server: rec(rid, 'bnr-server', steps),
        expect: 'server',
      };
    case 'diverged':
      // both sides moved from the baseline → Conflict (deferred); push the
      // AGREED-OR-PULLED (server) version, NEVER the divergent local edits.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'div-local', steps),
        server: rec(rid, 'div-server', steps),
        expect: 'server',
      };
    case 'changed-incoming':
      // server moved, local unchanged, Auto-Accept-Updates OFF → Review (deferred);
      // push the agreed-or-pulled (server) version.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'base', steps),
        server: rec(rid, 'ci-server', steps),
        expect: 'server',
      };
    case 'locked':
      // open in the Recording_View → excluded from the inbound merge but present
      // in the push at its agreed-or-pulled (server) version, never local edits.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'lock-local', steps),
        server: rec(rid, 'lock-server', steps),
        expect: 'server',
        locked: true,
      };
    default:
      throw new Error(`unknown outcome ${outcome}`);
  }
}

/**
 * Materialize a scenario into the `sync()` inputs plus the per-recording
 * expectations. Every project is present on BOTH sides with IDENTICAL project
 * metadata (so the project-metadata Unit is always converged and never deferred);
 * the seeded baseline holds the agreed version of every recording that has one.
 */
function materialize(projectSpecs) {
  const seed = createEmptySyncState();
  const localProjects = [];
  const payloadById = new Map();
  const manifest = [];
  const locked = [];
  // Per project_id → Map(recording_id → { expectedKey, expectKind, localKey, isDeferredOrLocked }).
  const expectations = new Map();

  for (const pspec of projectSpecs) {
    const pid = pspec.project_id;
    const pname = `Project ${pid.slice(0, 8)}`;

    const baselineRecs = [];
    const localRecs = [];
    const serverRecs = [];
    const recExpect = new Map();
    // Every recording id present on ANY side — the no-omission universe (R6.4).
    const allRecIds = new Set();

    for (const rspec of pspec.recordings) {
      const rid = rspec.recording_id;
      const v = versionsFor(rspec.outcome, rid, rspec.steps);
      allRecIds.add(rid);

      if (v.baseline) baselineRecs.push(v.baseline);
      if (v.local) localRecs.push(v.local);
      if (v.server) serverRecs.push(v.server);
      if (v.locked) locked.push(rid);

      const expectedSource = v.expect === 'server' ? v.server : v.local;
      recExpect.set(rid, {
        outcome: rspec.outcome,
        expectKind: v.expect,
        expectedKey: projKey(expectedSource),
        // The local version's key (when local exists) — used to prove a deferred
        // or locked recording is NOT pushed at its un-reconciled local edits.
        localKey: v.local ? projKey(v.local) : null,
        deferredOrLocked: v.expect === 'server' && v.outcome !== 'brand-new-remote',
      });
    }

    // Baseline: the last-agreed project, holding the agreed version of every
    // recording that has one. Project metadata matches local/server exactly.
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

    expectations.set(pid, { recExpect, allRecIds });
  }

  return { seed, localProjects, payloadById, manifest, locked, expectations };
}

// ─── Property 37 ──────────────────────────────────────────────────────────────

describe('Property 37: The push payload is assembled per-unit (no clobber, no accidental deletion)', () => {
  it('pushes each recording at the correct per-unit version, omitting none and never clobbering a deferred/locked unit with local edits', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (projectSpecs) => {
        const { seed, localProjects, payloadById, manifest, locked, expectations } =
          materialize(projectSpecs);
        installMockFetch(manifest, payloadById);
        const store = makeStore(seed);

        const { result } = await sync(
          'https://srv.test',
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(locked),
        );

        // The cycle ran to completion (no live-work gate, no abort).
        assert.equal(result.halted, false);
        assert.equal(result.haltReason, null);

        // Every local project is pushed exactly once: its project-metadata Unit
        // is converged (local-carrying), so the project always has something to
        // write and is never skipped (R20.4).
        const puts = capturedPuts();
        const putByProjectId = new Map();
        for (const put of puts) {
          assert.ok(Array.isArray(put.body.recordings), 'payload has a recordings array');
          putByProjectId.set(put.body.project.project_id, put.body);
        }
        assert.equal(puts.length, localProjects.length, 'exactly one PUT per local project');

        for (const project of localProjects) {
          const pid = project.project_id;
          const body = putByProjectId.get(pid);
          assert.ok(body, `project ${pid} was pushed`);

          const { recExpect, allRecIds } = expectations.get(pid);
          const pushedById = new Map(body.recordings.map((r) => [r.recording_id, r]));

          // ── No accidental deletion (R6.4) ──────────────────────────────────
          // Every recording present on ANY side (local, server, or baseline) is
          // present in the pushed payload; the verbatim-store server can never
          // read the write as a deletion.
          assert.equal(
            pushedById.size,
            allRecIds.size,
            'pushed recording count equals the union present on any side (no omission, no extras)',
          );
          for (const rid of allRecIds) {
            assert.ok(
              pushedById.has(rid),
              `recording ${rid} present on some side must appear in the push (no accidental deletion)`,
            );
          }

          // ── Per-unit version selection + no clobber (R20.3) ─────────────────
          for (const [rid, exp] of recExpect) {
            const pushed = pushedById.get(rid);
            const pushedKey = projKey(pushed);

            // The pushed version is exactly the expected source version: local
            // for clean-local-new / changed-local-outgoing / already-converged;
            // agreed-or-pulled (server) for deferred (Review/Conflict), locked,
            // or auto-added remote recordings.
            assert.equal(
              pushedKey,
              exp.expectedKey,
              `recording ${rid} (${exp.outcome}) pushed at the ${exp.expectKind} version`,
            );

            // The teeth of R20.3: a deferred or locked recording is sent at the
            // server's agreed-or-pulled version, NEVER its un-reconciled local
            // edits — so the whole-project write cannot clobber the concurrent
            // server change this client has not reconciled.
            if (exp.deferredOrLocked && exp.localKey !== null) {
              assert.notEqual(
                pushedKey,
                exp.localKey,
                `deferred/locked recording ${rid} (${exp.outcome}) must NOT push its local edits over the server's copy`,
              );
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ────────────────────────────────────

  it('a diverged (Conflict) recording is pushed at the server version, not the divergent local edits', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000001';
    const rid = 'rec-div';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'base', steps)],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'local', steps)],
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
          recordings: [rec(rid, 'server', steps)],
        }),
      ],
    ]);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([]),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, [`${pid}:${rid}`], 'the diverged recording is a Conflict');

    const puts = capturedPuts();
    assert.equal(puts.length, 1);
    const pushed = puts[0].body.recordings.find((r) => r.recording_id === rid);
    assert.equal(pushed.name, 'server', 'pushed at the agreed-or-pulled (server) version');
    assert.notEqual(
      pushed.name,
      'local',
      'the divergent local edits never clobber the server copy',
    );
  });

  it('a changed-local-outgoing recording is pushed at the local version', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000002';
    const rid = 'rec-clo';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'base', steps)],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'edited', steps)],
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
          recordings: [rec(rid, 'base', steps)], // server still at baseline
        }),
      ],
    ]);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([]),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, [], 'a one-sided local change is never a Conflict');
    assert.deepEqual(result.review, [], 'a one-sided local change is never a Review');

    const puts = capturedPuts();
    assert.equal(puts.length, 1);
    const pushed = puts[0].body.recordings.find((r) => r.recording_id === rid);
    assert.equal(pushed.name, 'edited', 'the local edit reaches the wire (R20.2)');
  });

  it('an auto-applied fast-forward update is pushed at the adopted (incoming) version', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000003';
    const rid = 'rec-ff';
    const s1 = { uuid: 's1', logical_id: 'a', step_number: 0, deleted: false };
    const s2 = { uuid: 's2', logical_id: 'a', step_number: 1, deleted: false };

    const seed = createEmptySyncState();
    seed.settings.autoAcceptUpdates = true; // opt into fast-forward auto-apply (R22.4)
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'base', [s1])],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'base', [s1])],
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
          // incoming is an append-only superset of the baseline (adds s2).
          recordings: [rec(rid, 'base', [s1, s2])],
        }),
      ],
    ]);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([]),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(
      result.autoAppliedUpdates,
      [`${pid}:${rid}`],
      'the fast-forward was auto-applied',
    );

    const puts = capturedPuts();
    assert.equal(puts.length, 1);
    const pushed = puts[0].body.recordings.find((r) => r.recording_id === rid);
    assert.equal(
      JSON.stringify(pushed.steps),
      JSON.stringify([s1, s2]),
      'the adopted (incoming) version is pushed as the merged local version',
    );
  });
});
