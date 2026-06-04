/**
 * locked-recording-push-preservation.property.test.js — Property test for the
 * outbound-push preservation of a Locked_Recording at its agreed-or-pulled
 * version.
 *
 * The push is a *whole-project write*: the server stores the `Full_Project_Payload`
 * VERBATIM, so whatever recordings the payload omits would read to other clients
 * as a deliberate recording deletion. A recording open in the Recording_View is
 * locked — its *inbound* merge is excluded — but it must still be present in the
 * *outbound* payload, and crucially at the version most recently AGREED-OR-PULLED
 * for it: its Sync_Snapshot version when one was pulled this cycle, otherwise its
 * Sync_Baseline version, NEVER its un-reconciled live local edits and NEVER
 * omitted (Requirement 6.4). The lock excludes the inbound merge, not the
 * outbound presence, and the per-unit push assembly (task 22.3) selects the
 * version: a locked recording is sent like any deferred unit — at the server's
 * agreed-or-pulled copy — so the whole-project write cannot clobber a concurrent
 * server change this client has not reconciled.
 *
 * This property pins that contract over a large input space: for ANY local
 * projects pulled this cycle and ANY locked-recording set (capture inactive and
 * no unprotected Pending Actions, so the pre-flight gate lets the cycle proceed),
 * every locked recording appears in its project's pushed PUT body at the SERVER
 * (Sync_Snapshot) version — distinct from both its local edits and its baseline —
 * and no recording present on any side is ever omitted. Non-locked siblings are
 * `already-converged` (identical on both sides) so the only version-swapped units
 * are the locked ones, isolating the property.
 *
 * `fetch` is mocked as in `per-unit-push-assembly.property.test.js`: GET /projects
 * serves the manifest, GET /projects/:id serves each project's Full_Project_Payload
 * (so the pull retains a Sync_Snapshot of the server version), and PUT (push)
 * returns 200 with its body captured in push order. A persistent in-memory
 * `SyncStore` is seeded with the baselines; a `LiveState` reports the locked set
 * (capture inactive, nothing pending).
 *
 * Deterministic regression examples additionally cover the BASELINE branch (a
 * locked recording whose project is NOT pulled this cycle is pushed at its
 * Sync_Baseline version) and the FALLBACK case (a locked recording with neither
 * a snapshot nor a baseline is pushed at its local version — there is nothing on
 * the server to clobber — and is still never omitted).
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 35: A locked recording is preserved in the outbound push at its agreed-or-pulled version

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

// ─── fetch double (mirrors per-unit-push-assembly.property.test.js) ──────────

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
 *   - GET /projects/:id → the project's Full_Project_Payload (so the pull retains
 *                         a Sync_Snapshot of the server version).
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

/** A validator that accepts every payload (the push assembly is the focus). */
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
 * One recording spec. `locked` marks the recording as open in the Recording_View
 * this cycle (a Locked_Recording). The recording_id is assigned in
 * {@link materialize} so it is GLOBALLY unique (locks are keyed by recording_id
 * across all projects, so a duplicate id would otherwise lock its namesake in
 * another project). The steps are shared across a locked recording's three
 * versions so only the recording `name` drives the version difference (R2.8).
 */
const arbRecordingSpec = fc.record({
  steps: fc.array(arbStep, { maxLength: 3 }),
  locked: fc.boolean(),
});

const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recordings: fc.array(arbRecordingSpec, { minLength: 1, maxLength: 5 }),
});

const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 3,
});

/**
 * Materialize a scenario into the `sync()` inputs plus the per-recording
 * expectations. Every project is present on BOTH sides (pulled this cycle) with
 * IDENTICAL project metadata (so the project-metadata Unit is always converged
 * and never deferred). Every project also gets a mandatory
 * `changed-local-outgoing` recording (`clo-*`: local moved, server still at
 * baseline) so the project always has a content-differing unit to write and is
 * never skipped (R20.4) — this is what keeps the locked recording's preserved
 * wire-version observable in the push, now that an `already-converged` sibling
 * equals the server and is no longer a reason to write.
 *
 * A LOCKED recording gets three DISTINCT versions — baseline `base-*`, local
 * `local-*`, server `server-*` — so its agreed-or-pulled (server snapshot) push
 * version is provably neither its local edits nor its baseline. A NON-locked
 * recording is `already-converged` (baseline == local == server), present only
 * to prove a converged sibling is still emitted (no omission) and pushed at the
 * server-equal version.
 */
function materialize(projectSpecs) {
  const seed = createEmptySyncState();
  const localProjects = [];
  const payloadById = new Map();
  const manifest = [];
  const locked = [];
  // Per project_id → { recExpect: Map(recording_id → {...}), allRecIds: Set }.
  const expectations = new Map();

  for (const pspec of projectSpecs) {
    const pid = pspec.project_id;
    const pname = `Project ${pid.slice(0, 8)}`;

    const baselineRecs = [];
    const localRecs = [];
    const serverRecs = [];
    const recExpect = new Map();
    const allRecIds = new Set();

    // Mandatory changed-local-outgoing recording: local moved, server still at
    // baseline ⇒ a genuine content difference, so the project is always pushed
    // (R20.4). Pushed at its local version.
    const cloId = `${pid}-clo`;
    allRecIds.add(cloId);
    baselineRecs.push(rec(cloId, `clo-base-${cloId}`, []));
    localRecs.push(rec(cloId, `clo-local-${cloId}`, []));
    serverRecs.push(rec(cloId, `clo-base-${cloId}`, [])); // server == baseline
    recExpect.set(cloId, {
      locked: false,
      expectedKey: projKey(rec(cloId, `clo-local-${cloId}`, [])),
      localKey: projKey(rec(cloId, `clo-local-${cloId}`, [])),
    });

    pspec.recordings.forEach((rspec, i) => {
      const rid = `${pid}-r${i}`; // globally unique
      allRecIds.add(rid);

      if (rspec.locked) {
        const baseline = rec(rid, `base-${rid}`, rspec.steps);
        const local = rec(rid, `local-${rid}`, rspec.steps);
        const server = rec(rid, `server-${rid}`, rspec.steps);
        baselineRecs.push(baseline);
        localRecs.push(local);
        serverRecs.push(server);
        locked.push(rid);
        recExpect.set(rid, {
          locked: true,
          // Pulled this cycle ⇒ agreed-or-pulled is the Sync_Snapshot (server) version.
          expectedKey: projKey(server),
          localKey: projKey(local),
        });
      } else {
        // already-converged: identical on every side ⇒ emitted at the server-equal
        // version (not itself a reason to write).
        const v = rec(rid, `conv-${rid}`, rspec.steps);
        baselineRecs.push(v);
        localRecs.push(v);
        serverRecs.push(v);
        recExpect.set(rid, {
          locked: false,
          expectedKey: projKey(v),
          localKey: projKey(v),
        });
      }
    });

    // Baseline: the last-agreed project, holding the agreed version of every
    // recording. Project metadata matches local/server exactly.
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

// ─── Property 35 ──────────────────────────────────────────────────────────────

describe('Property 35: A locked recording is preserved in the outbound push at its agreed-or-pulled version', () => {
  it('pushes every locked recording at its agreed-or-pulled (snapshot) version, never the local edits, omitting none', async () => {
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

        // Every local project is pushed exactly once: each carries a mandatory
        // changed-local-outgoing recording whose local version differs from the
        // server, so the project always has something to write and is never
        // skipped (R20.4).
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

          // The PUT targets this project's resource and carries the whole project.
          assert.equal(body.project.project_id, pid, 'PUT carries the project it targets');

          const { recExpect, allRecIds } = expectations.get(pid);
          const pushedById = new Map(body.recordings.map((r) => [r.recording_id, r]));

          // ── No accidental deletion (R6.4) ──────────────────────────────────
          // Every recording present on any side appears in the pushed payload —
          // locked recordings included; the verbatim-store server can never read
          // the write as a deletion.
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

          // ── A locked recording is pushed at its agreed-or-pulled version ────
          for (const [rid, exp] of recExpect) {
            const pushed = pushedById.get(rid);
            const pushedKey = projKey(pushed);

            assert.equal(
              pushedKey,
              exp.expectedKey,
              `recording ${rid} pushed at the ${exp.locked ? 'agreed-or-pulled (snapshot)' : 'local'} version`,
            );

            // The teeth of R6.4 / R20.3: a locked recording is sent at the
            // server's agreed-or-pulled version, NEVER its un-reconciled live
            // local edits — so the whole-project write cannot clobber the
            // concurrent server change this client has not reconciled.
            if (exp.locked) {
              assert.notEqual(
                pushedKey,
                exp.localKey,
                `locked recording ${rid} must NOT push its live local edits over the server's copy`,
              );
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  // ── Deterministic regression examples ────────────────────────────────────

  it('snapshot branch: a locked recording pulled this cycle is pushed at the server (snapshot) version, not the local edits', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000001';
    const lockedId = 'r-open';
    const cloId = 'r-clo';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(lockedId, 'base', steps), rec(cloId, 'clo-base', [])],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        // r-open has live local edits that must NOT be pushed; r-clo is a
        // changed-local-outgoing sibling (local moved, server at baseline) that
        // gives the project a reason to write so it is not skipped (R20.4).
        recordings: [rec(lockedId, 'local-edits', steps), rec(cloId, 'clo-local', [])],
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
          // The server's current version of r-open, pulled this cycle.
          recordings: [rec(lockedId, 'server-version', steps), rec(cloId, 'clo-base', [])],
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
      makeLiveState([lockedId]), // r-open is the Locked_Recording
    );

    assert.equal(result.halted, false);
    const puts = capturedPuts();
    assert.equal(puts.length, 1);
    const pushed = puts[0].body.recordings;
    const ids = pushed.map((r) => r.recording_id);
    assert.deepEqual(ids, [lockedId, cloId], 'the locked recording is preserved, not dropped');
    const lockedPushed = pushed.find((r) => r.recording_id === lockedId);
    assert.equal(
      lockedPushed.name,
      'server-version',
      'the locked recording is pushed at its pulled (Sync_Snapshot) version',
    );
    assert.notEqual(lockedPushed.name, 'local-edits', 'the live local edits never reach the wire');
  });

  it('baseline branch: a locked recording whose project is not pulled this cycle is pushed at its Sync_Baseline version, not the local edits', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000002';
    const lockedId = 'r-open';
    const cloId = 'r-clo';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(lockedId, 'baseline-version', steps), rec(cloId, 'clo-base', [])],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        // r-open has live local edits; r-clo is a changed-local-outgoing sibling
        // (local differs from the baseline) so the project has something to write.
        recordings: [rec(lockedId, 'local-edits', steps), rec(cloId, 'clo-local', [])],
      },
    ];
    // Project P is NOT in the manifest ⇒ no Sync_Snapshot is retained this cycle,
    // so the agreed-or-pulled source falls back to the Sync_Baseline.
    const manifest = [];
    const payloadById = new Map();
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([lockedId]),
    );

    assert.equal(result.halted, false);
    const puts = capturedPuts();
    assert.equal(
      puts.length,
      1,
      'the project is pushed (its clo sibling differs from the baseline)',
    );
    const pushed = puts[0].body.recordings;
    assert.ok(
      pushed.some((r) => r.recording_id === lockedId),
      'the locked recording is preserved, not dropped',
    );
    const lockedPushed = pushed.find((r) => r.recording_id === lockedId);
    assert.equal(
      lockedPushed.name,
      'baseline-version',
      'with no snapshot this cycle, the locked recording is pushed at its Sync_Baseline version',
    );
    assert.notEqual(lockedPushed.name, 'local-edits', 'the live local edits never reach the wire');
  });

  it('fallback: a locked recording with neither a snapshot nor a baseline is pushed at its local version and never omitted', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000003';
    const lockedId = 'r-open';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    // No baseline seeded, and the project is not pulled this cycle, so there is
    // no agreed-or-pulled version: the assembly falls back to local — there is
    // nothing on the server to clobber — and the recording is still not omitted.
    const seed = createEmptySyncState();
    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(lockedId, 'local-only', steps)],
      },
    ];
    installMockFetch([], new Map());

    const { result } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([lockedId]),
    );

    assert.equal(result.halted, false);
    const puts = capturedPuts();
    assert.equal(puts.length, 1);
    const lockedPushed = puts[0].body.recordings.find((r) => r.recording_id === lockedId);
    assert.ok(lockedPushed, 'a locked recording with no agreed-or-pulled version is still pushed');
    assert.equal(
      lockedPushed.name,
      'local-only',
      'with no snapshot and no baseline, the locked recording falls back to its local version',
    );
  });

  it('a project whose every recording is locked (each with an agreed-or-pulled version) is SKIPPED — nothing to write (R20.4)', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000004';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec('r1', 'base-1', steps), rec('r2', 'base-2', [])],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec('r1', 'local-1', steps), rec('r2', 'local-2', [])],
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
          recordings: [rec('r1', 'server-1', steps), rec('r2', 'server-2', [])],
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
      makeLiveState(['r1', 'r2']), // both recordings locked
    );

    assert.equal(result.halted, false);
    const puts = capturedPuts();
    // Every recording is locked, so each would be sent at its agreed-or-pulled
    // (server) version, and the project metadata converges — the WHOLE assembled
    // payload equals the server's own state. Per the maintainer's strict-R20.4
    // decision, the project is SKIPPED rather than re-sending the server's bytes.
    // The held-back local edits reach the server on a later cycle, once the
    // recordings are unlocked and reconciled; nothing is lost by the skip.
    assert.equal(
      puts.length,
      0,
      'a project whose only non-converged units are locked re-sends only the server state and is skipped (R20.4)',
    );
  });
});
