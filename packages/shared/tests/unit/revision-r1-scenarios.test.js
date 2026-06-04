/**
 * revision-r1-scenarios.test.js — Concrete, hand-built example scenarios that
 * drive the FULL `sync()` (pull → reconcile → per-unit push) and the user-gated
 * resolution workflow across MULTIPLE cycles, pinning the three timing/round-trip
 * behaviors that the pull-first reorder (Revision R1) enables. Where the sibling
 * PROPERTY tests pin universal invariants over randomized inputs, this file pins
 * the exact multi-cycle storylines from the design's "Unit / example tests":
 *
 *   1. **changed-local-outgoing convergence** — a local-only edit (incoming ==
 *      baseline, local moved) is pushed on this cycle WITHOUT advancing the
 *      baseline; a following cycle with the server now equal classifies the Unit
 *      `already-converged` and advances the baseline to the agreed state (the
 *      routine round-trip the pull-first order enables) (R2.5, R21.1, R20.5,
 *      R1.2, R1.3).
 *
 *   2. **resolve → next-cycle** — resolving a Conflict (keep-local / merge)
 *      issues NO push during the resolution action; the resolved state then
 *      propagates on the NEXT pull-first cycle as `changed-local-outgoing` and is
 *      pushed (R20.5). In the concurrent variant, when the server moved AGAIN
 *      before that next cycle's pull, the resolved Unit re-classifies as a FRESH
 *      Conflict rather than overwriting the other client's change (R18.3).
 *
 *   3. **decline re-offer suppression** — declining a `changed-incoming` Review
 *      records the dismissed incoming version, so a later cycle that re-pulls the
 *      SAME incoming version does NOT re-offer it; a later cycle that pulls a
 *      DIFFERENT incoming version classifies it afresh and offers a new Review
 *      (R4.9, R4.10).
 *
 * The cycles share ONE persistent in-memory `SyncStore` (so baselines, reviews,
 * conflicts, and dismissals carry across cycles exactly as on a real client) and
 * a mock `fetch` (re-served per cycle to model the server's state advancing).
 * Resolution is invoked the way a platform panel does it: load the state, run the
 * pure `resolveConflict` / `declineReview`, persist the mutated state — so the
 * "resolution pushes nothing" guarantee (no `fetch` at all during the resolve) is
 * exercised directly.
 *
 * Mirrors the sibling sync tests' doubles (`makeResponse` / `installMockFetch` /
 * `makeStore` / `makeLiveState` / `passValidator`) and uses the Node.js built-in
 * test runner (`node --test`). These are concrete example tests, so fast-check is
 * not used.
 *
 * **Validates: Requirements 2.5, 4.9, 4.10, 18.3, 20.5, 21.1**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sync } from '../../sync-client.js';
import { resolveConflict, declineReview } from '../../conflict-resolution.js';
import {
  createEmptySyncState,
  setSettings,
  loadSyncState,
  saveSyncState,
} from '../../sync-store.js';
import { advanceBaseline, getBaseline } from '../../sync-baseline.js';
import { digestProject, digestRecording } from '../../sync-digest.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

const SERVER = 'https://srv.test';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

const PROJ_CREATED = '2026-01-01T00:00:00.000Z';
const REC_CREATED = '2026-02-01T00:00:00.000Z';
// Fixed clock for deterministic baseline `agreedAt` stamps (never asserted on).
const FIXED_NOW = () => 0;

// ─── fetch double (mirrors the sibling sync tests) ────────────────────────────

/** Records every fetch call so PUT (push) bodies can be inspected per cycle. */
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
 * Install a mock `fetch` that serves a manifest plus per-project payloads keyed
 * by project_id and records every call. Resets the captured-call log so each
 * cycle's PUTs can be inspected in isolation.
 *   - PUT (push)        → 200, body captured.
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload (404 when unknown).
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

/** The PUT bodies captured since the last `installMockFetch`, in push order. */
function capturedPuts() {
  return fetchCalls
    .filter((c) => c.options && c.options.method === 'PUT')
    .map((c) => JSON.parse(c.options.body));
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore} that persists across cycles; clones on the way in
 * and out so no reference is shared with the code under test.
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

/** Permissive {@link LiveState}: capture inactive, nothing locked, nothing pending. */
function makeLiveState() {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (timing/round-trip, not validation, is the focus). */
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

// ─── tiny literal builders ────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
function step(uuid, logical_id, step_number, deleted = false) {
  return { uuid, logical_id, step_number, deleted };
}

/** A recording literal at a given version name + steps. */
function rec(recording_id, name, steps) {
  return { recording_id, name, created_at: REC_CREATED, steps };
}

/** A project literal. */
function proj(project_id, name, recordings) {
  return { project_id, name, created_at: PROJ_CREATED, recordings };
}

/** Find a recording within a pushed/merged project body. */
function findRec(project, recording_id) {
  return (project.recordings ?? []).find((r) => r && r.recording_id === recording_id);
}

// ─── Scenario 1: changed-local-outgoing convergence (R2.5, R21.1, R20.5) ──────

describe('Revision R1 example: changed-local-outgoing convergence round-trip', () => {
  const PID = '018f4e2a-0000-7000-8000-0000000000c1';
  const RID = 'rec-clo';
  const STEPS = [step('s1', 'a', 0)];

  it('pushes a local-only edit without advancing the baseline, then advances on the confirming pull', async () => {
    // Seed: the last-agreed baseline holds the recording at 'base'.
    const baselineProject = proj(PID, 'P', [rec(RID, 'base', STEPS)]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baselineProject), FIXED_NOW);
    setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });
    const baseDigest = digestProject(projectProjection(baselineProject));

    const store = makeStore(seed);

    // Local moved the recording to 'edited'; the server is still at 'base'.
    const localProjects = [proj(PID, 'P', [rec(RID, 'edited', STEPS)])];

    // ── Cycle 1: server still at the agreed baseline → changed-local-outgoing. ──
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'base', STEPS)]))]]),
    );

    const cycle1 = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(cycle1.result.halted, false);
    assert.deepEqual(cycle1.result.conflicts, [], 'a one-sided local change is never a Conflict');
    assert.deepEqual(cycle1.result.review, [], 'a one-sided local change is never a Review');
    assert.deepEqual(cycle1.result.autoAppliedUpdates, []);

    // The local edit reaches the wire automatically (R21.1, R20.2)…
    const puts1 = capturedPuts();
    assert.equal(puts1.length, 1, 'the project with a local edit is pushed');
    assert.equal(
      findRec(puts1[0], RID).name,
      'edited',
      'the changed-local-outgoing edit is pushed at the local version',
    );

    // …but the push does NOT advance the baseline (R1.2, R21.2): it still equals
    // the seeded agreed state, so agreement is not yet recorded.
    assert.equal(
      getBaseline(store.getState(), PID).digest,
      baseDigest,
      'the baseline is unchanged by a changed-local-outgoing push',
    );

    // ── Cycle 2: the server now holds the pushed 'edited' version → the pull
    //    confirms incoming == local → already-converged → the baseline advances. ──
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'edited', STEPS)]))]]),
    );

    const cycle2 = await sync(
      SERVER,
      null,
      cycle1.projects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(cycle2.result.halted, false);
    assert.deepEqual(cycle2.result.conflicts, []);
    assert.deepEqual(cycle2.result.review, []);

    // The baseline now equals the agreed (converged) state — the round-trip the
    // pull-first ordering enables (R1.3, R2.5).
    const convergedDigest = digestProject(
      projectProjection(proj(PID, 'P', [rec(RID, 'edited', STEPS)])),
    );
    assert.notEqual(
      convergedDigest,
      baseDigest,
      'the converged state differs from the old baseline',
    );
    assert.equal(
      getBaseline(store.getState(), PID).digest,
      convergedDigest,
      'the confirming pull advances the baseline to the agreed (pushed) state',
    );
  });
});

// ─── Scenario 2: resolve → next-cycle (R20.5, R18.3) ──────────────────────────

describe('Revision R1 example: resolve a Conflict, then the resolved state propagates next cycle', () => {
  const PID = '018f4e2a-0000-7000-8000-0000000000c2';
  const RID = 'rec-div';
  const unitRef = `${PID}:${RID}`;

  // Append-only histories: baseline [s1]; local appended s2; server appended s3.
  const BASE_STEPS = [step('s1', 'a', 0)];
  const LOCAL_STEPS = [step('s1', 'a', 0), step('s2', 'b', 1)];
  const SERVER_STEPS = [step('s1', 'a', 0), step('s3', 'c', 1)];
  // The user's chosen merge resolution: the explicit append-only superset of both
  // sides (retains s1, s2, s3) — accepted by resolveConflict (R11.1).
  const MERGED_STEPS = [step('s1', 'a', 0), step('s2', 'b', 1), step('s3', 'c', 1)];

  /**
   * Drive cycle 1 (which detects the divergence as a Conflict) and then resolve
   * it with the keep-local / merge resolution, asserting that the resolution
   * action issues NO push (R20.5). Returns the live store, the post-resolution
   * local projects, and the resolved-against incoming digest for later checks.
   */
  async function detectAndResolve() {
    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      PID,
      projectProjection(proj(PID, 'P', [rec(RID, 'base', BASE_STEPS)])),
      FIXED_NOW,
    );
    setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });
    const store = makeStore(seed);

    const localProjects = [proj(PID, 'P', [rec(RID, 'div-local', LOCAL_STEPS)])];

    // Cycle 1: both sides moved from the baseline → diverged → Conflict.
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'div-server', SERVER_STEPS)]))]]),
    );
    const cycle1 = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle1.result.halted, false);
    assert.deepEqual(
      cycle1.result.conflicts,
      [unitRef],
      'the divergence is recorded as a Conflict',
    );
    assert.deepEqual(cycle1.result.review, []);
    // The conflicted recording is never pushed at its local edits; it re-sends the
    // agreed-or-pulled (server) version (R20.2).
    const puts1 = capturedPuts();
    assert.equal(puts1.length, 1, 'the project is pushed (metadata converged)');
    assert.equal(
      findRec(puts1[0], RID).name,
      'div-server',
      'the Conflict recording re-sends the server version, never its local edits',
    );

    // Resolve through the workflow exactly as a panel would: load → resolve →
    // persist. Reset the captured calls FIRST, so the assertion that resolution
    // issues no push (R20.5) is exercised against an empty log.
    fetchCalls = [];
    const state = await loadSyncState(store);
    const resolvedRec = rec(RID, 'merged', MERGED_STEPS);
    const resolution = resolveConflict(state, cycle1.projects, unitRef, resolvedRec, {
      now: FIXED_NOW,
    });
    assert.equal(resolution.ok, true, 'the append-only merge is adopted');
    assert.equal(resolution.reason, null);
    await saveSyncState(store, state);

    // ── R20.5 — the resolve action issues NO push (and no fetch at all). ──
    assert.equal(fetchCalls.length, 0, 'resolution performs no transport — it pushes nothing');

    // The baseline advanced PER-UNIT to the resolved-against incoming version
    // (the server's 'div-server'), not to the adopted merged state (R1.4, R1.9).
    const resolvedAgainstDigest = digestRecording(
      recordingProjection(rec(RID, 'div-server', SERVER_STEPS)),
    );
    const baselineRec = getBaseline(store.getState(), PID).agreedState.recordings.find(
      (r) => r.recording_id === RID,
    );
    assert.equal(
      digestRecording(baselineRec),
      resolvedAgainstDigest,
      'the baseline advanced to the resolved-against incoming version',
    );

    return { store, resolvedProjects: resolution.projects, resolvedAgainstDigest };
  }

  it('propagates the resolved (merged) state as changed-local-outgoing and pushes it on the next cycle', async () => {
    const { store, resolvedProjects } = await detectAndResolve();

    // Cycle 2: the server is UNCHANGED since resolution (still 'div-server'). The
    // resolved-against baseline == incoming, while the merged local differs →
    // changed-local-outgoing → the resolved state is pushed (R20.5).
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'div-server', SERVER_STEPS)]))]]),
    );
    const cycle2 = await sync(
      SERVER,
      null,
      resolvedProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(cycle2.result.halted, false);
    assert.deepEqual(cycle2.result.conflicts, [], 'no new Conflict — the server did not move');
    assert.deepEqual(cycle2.result.review, []);

    const puts2 = capturedPuts();
    assert.equal(puts2.length, 1, 'the resolved unit is pushed on the next cycle');
    const pushed = findRec(puts2[0], RID);
    assert.equal(pushed.name, 'merged', 'the resolved (merged) state is what is pushed');
    assert.deepEqual(
      pushed.steps.map((s) => s.uuid),
      ['s1', 's2', 's3'],
      'the pushed resolution retains every step record from both sides (append-only)',
    );
  });

  it('produces a FRESH Conflict on the next cycle when the server moved again concurrently (R18.3)', async () => {
    const { store, resolvedProjects } = await detectAndResolve();

    // Cycle 2 (concurrent variant): a DIFFERENT client moved the server again to
    // 'div-server-2' before this client's next push. The resolved-against
    // baseline ('div-server') now differs from BOTH the merged local and the new
    // incoming version → the unit re-classifies as diverged, surfacing the other
    // client's change as a fresh Conflict rather than overwriting it (R18.3).
    const SERVER2_STEPS = [step('s1', 'a', 0), step('s4', 'd', 1)];
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'div-server-2', SERVER2_STEPS)]))]]),
    );
    const cycle2 = await sync(
      SERVER,
      null,
      resolvedProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(cycle2.result.halted, false);
    assert.deepEqual(
      cycle2.result.conflicts,
      [unitRef],
      'the concurrent server change is re-detected as a fresh Conflict (R18.3)',
    );
    assert.deepEqual(cycle2.result.review, []);

    // The fresh Conflict retains BOTH the merged local and the new incoming
    // version, and the resolved (merged) local edits are NOT pushed over the
    // server's newer change.
    const conflict = store.getState().conflicts[unitRef];
    assert.ok(conflict, 'a Conflict item is recorded for the unit');
    assert.equal(conflict.local.name, 'merged', 'the merged local version is retained');
    assert.equal(conflict.incoming.name, 'div-server-2', 'the newer server version is retained');

    const puts2 = capturedPuts();
    const pushed = puts2.length ? findRec(puts2[0], RID) : null;
    if (pushed) {
      assert.notEqual(
        pushed.name,
        'merged',
        'the resolved local edits are never pushed over the newer concurrent server change',
      );
    }
  });
});

// ─── Scenario 3: decline re-offer suppression (R4.9, R4.10) ───────────────────

describe('Revision R1 example: a declined incoming version is not re-offered, a different one is', () => {
  const PID = '018f4e2a-0000-7000-8000-0000000000c3';
  const RID = 'rec-ci';
  const unitRef = `${PID}:${RID}`;

  // local == baseline at 'base'; the server moves the recording on each cycle.
  const BASE_STEPS = [step('s1', 'a', 0)];
  const V2_STEPS = [step('s1', 'a', 0), step('s2', 'b', 1)];
  const V3_STEPS = [step('s1', 'a', 0), step('s2', 'b', 1), step('s3', 'c', 2)];

  it('suppresses the SAME declined incoming version next cycle but classifies a DIFFERENT one afresh', async () => {
    const baselineProject = proj(PID, 'P', [rec(RID, 'base', BASE_STEPS)]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baselineProject), FIXED_NOW);
    // Auto-Accept-Updates OFF so a changed-incoming always defers to Review.
    setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });
    const baseDigest = digestProject(projectProjection(baselineProject));

    const store = makeStore(seed);

    // Local stays unchanged at the baseline across every cycle.
    let localProjects = [proj(PID, 'P', [rec(RID, 'base', BASE_STEPS)])];

    // ── Cycle 1: the server moved to v2 → changed-incoming → Review recorded. ──
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'v2', V2_STEPS)]))]]),
    );
    const cycle1 = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle1.result.halted, false);
    assert.deepEqual(cycle1.result.review, [unitRef], 'the incoming change is offered for Review');
    assert.deepEqual(cycle1.result.conflicts, []);
    assert.ok(store.getState().reviews[unitRef], 'a Review item exists for the unit');

    // Decline the Review the way a panel does: load → decline → persist. The
    // declined incoming version (v2) is recorded as dismissed (R4.9); local is
    // left unchanged and nothing is pushed.
    const stateAfterDecline = await loadSyncState(store);
    const decline = declineReview(stateAfterDecline, cycle1.projects, unitRef);
    assert.equal(decline.ok, true, 'the Review is declined');
    await saveSyncState(store, stateAfterDecline);
    localProjects = decline.projects; // unchanged local
    assert.ok(
      store.getState().dismissedIncoming[unitRef],
      'the declined incoming version is recorded as dismissed',
    );

    // ── Cycle 2: the server still serves the SAME v2 → the dismissal suppresses
    //    it: no Review is re-offered, local + baseline untouched (R4.9). ──
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'v2', V2_STEPS)]))]]),
    );
    const cycle2 = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle2.result.halted, false);
    assert.deepEqual(
      cycle2.result.review,
      [],
      'the same declined incoming version is NOT re-offered (R4.9)',
    );
    assert.deepEqual(cycle2.result.conflicts, []);
    assert.ok(
      !store.getState().reviews[unitRef],
      'no Review item is re-created for the dismissed version',
    );
    assert.equal(
      getBaseline(store.getState(), PID).digest,
      baseDigest,
      'a suppressed incoming change never advances the baseline',
    );

    // ── Cycle 3: the server now serves a DIFFERENT version v3 → the dismissal no
    //    longer matches → the unit is classified afresh and offered for Review
    //    (R4.10). ──
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(proj(PID, 'P', [rec(RID, 'v3', V3_STEPS)]))]]),
    );
    const cycle3 = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle3.result.halted, false);
    assert.deepEqual(
      cycle3.result.review,
      [unitRef],
      'a DIFFERENT incoming version is classified afresh and offered (R4.10)',
    );
    assert.deepEqual(cycle3.result.conflicts, []);
    const review = store.getState().reviews[unitRef];
    assert.ok(review, 'a new Review item is recorded for the different incoming version');
    assert.equal(review.incoming.name, 'v3', 'the new Review retains the new incoming version');
  });
});
