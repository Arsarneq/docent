/**
 * pending-action-protection.property.test.js — Property test for the sync()
 * pre-flight Pending-Actions safety gate.
 *
 * Pending Actions are uncommitted captured actions that have not yet been folded
 * into a recording's committed `steps` history. The protection rule keeps them out of
 * sync entirely: sync reads only committed `recording.steps` and never the
 * Pending Actions, and a recording that holds Pending Actions must stay protected
 * by either the Locked_Recording exclusion or the Capture_Active halt. If neither
 * protection engages for a pending-holding recording, sync must halt immediately
 * — before any transport — rather than read or overwrite uncommitted work.
 *
 * This property pins that contract on the implemented pre-flight gate
 * (`evaluatePreflightGate` inside `sync()`):
 *
 *   - HALT     — if ANY recording holds Pending Actions while neither locked nor
 *                capture-halted, sync returns immediately with
 *                `halted: true`, `haltReason: 'pending-actions-unprotected'`,
 *                performs NO network work (fetch is never called), and leaves the
 *                durable store untouched and the projects unchanged.
 *   - NO-TRIP  — if EVERY pending-holding recording is protected (locked, or
 *                capture is active), the pending-actions gate never trips: the
 *                halt reason is never 'pending-actions-unprotected'. Capture-active
 *                halts for its own reason; an otherwise-clean cycle proceeds.
 *   - COMMITTED-ONLY — when a cycle does proceed, every pushed payload carries
 *                exactly the recording's committed `steps`; there is no channel
 *                through which Pending Actions could be observed, because
 *                `LiveState` only exposes pending-holding recording *ids*, never
 *                their content.
 *
 * Uses Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()` for
 * ids), with a fake `LiveState` and a fake `fetch`.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Pending Actions are never observed; an unprotected pending recording halts sync

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// ─── Test doubles ─────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A Response-like object, matching the shape sync-client consumes. */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

/**
 * Install a fake `fetch` that records every call. PUTs (push) succeed and have
 * their bodies captured; the GET manifest returns an empty list so the pull
 * phase does no per-project work. If the gate halts correctly, `calls` stays
 * empty — that emptiness is the "no network work" assertion.
 */
function installFakeFetch() {
  const calls = [];
  const putBodies = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options?.method === 'PUT') {
      putBodies.push({ url, body: JSON.parse(options.body) });
      return makeResponse(200, { ok: true });
    }
    // GET ${serverUrl}/projects — the manifest. Empty ⇒ no project fetches.
    return makeResponse(200, []);
  };
  return { calls, putBodies };
}

/**
 * A fake `LiveState`. It exposes ONLY recording ids for the locked set and the
 * pending-holding set — never any Pending Action content — exactly like the real
 * platform adapters, so there is structurally no way for sync to "observe" a
 * Pending Action.
 *
 * @param {{ captureActive: boolean, lockedIds: Iterable<string>, pendingIds: Iterable<string> }} cfg
 * @returns {import('../../sync-types.js').LiveState}
 */
function makeLiveState({ captureActive, lockedIds, pendingIds }) {
  return {
    isCaptureActive: () => captureActive,
    getLockedRecordingIds: () => new Set(lockedIds),
    recordingsWithPendingActions: () => new Set(pendingIds),
  };
}

/**
 * A spy `SyncStore`. The pre-flight gate must not touch durable state on a halt;
 * this records load/save calls so the test can assert the store was untouched.
 *
 * @returns {import('../../sync-types.js').SyncStore & { calls: { load: number, save: number } }}
 */
function makeSpyStore() {
  const calls = { load: 0, save: 0 };
  return {
    calls,
    async load() {
      calls.load++;
      return null;
    },
    async save() {
      calls.save++;
    },
  };
}

const SERVER = 'https://srv.test';
const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';

function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── Generators ──────────────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 10 }),
  deleted: fc.boolean(),
});

/**
 * One recording: a unique id, a committed step history, whether it holds
 * Pending Actions, whether it is locked, and which project bucket it lands in.
 */
const arbRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  steps: fc.array(arbStep, { maxLength: 4 }),
  holdsPending: fc.boolean(),
  locked: fc.boolean(),
  projectBucket: fc.integer({ min: 0, max: 2 }),
});

const arbScenario = fc.record({
  // Globally-unique recording ids so the locked / pending sets (keyed by id) are
  // unambiguous; at least one recording so a "victim" always exists.
  recordings: fc.uniqueArray(arbRecordingSpec, {
    selector: (r) => r.recording_id,
    minLength: 1,
    maxLength: 6,
  }),
  // Three distinct project ids; recordings land in buckets 0..2.
  projectIds: fc.uniqueArray(fc.uuid(), { minLength: 3, maxLength: 3 }),
  captureActive: fc.boolean(),
});

/** Materialize recording specs into the local project list sync() consumes. */
function buildProjects(recordings, projectIds) {
  const byProject = new Map();
  for (const r of recordings) {
    const project_id = projectIds[r.projectBucket];
    if (!byProject.has(project_id)) byProject.set(project_id, []);
    byProject.get(project_id).push({
      recording_id: r.recording_id,
      name: `rec-${r.recording_id}`,
      created_at: FIXED_CREATED_AT,
      steps: r.steps,
    });
  }
  return [...byProject.entries()].map(([project_id, recs]) => ({
    project_id,
    name: `proj-${project_id}`,
    created_at: FIXED_CREATED_AT,
    recordings: recs,
  }));
}

/**
 * Map of recording_id → committed steps, for the committed-only assertion. The
 * steps are JSON-normalized (the same round-trip the wire — and the fake fetch —
 * applies) so the comparison is about step *content*, not the prototype identity
 * of the freshly-generated objects.
 */
function committedStepsById(recordings) {
  const map = new Map();
  for (const r of recordings) map.set(r.recording_id, JSON.parse(JSON.stringify(r.steps)));
  return map;
}

describe('Pending Actions are never observed; an unprotected pending recording halts sync', () => {
  it('halts immediately with no network work when any pending recording is unprotected', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, fc.nat(), async (scenario, victimSeed) => {
        // Force the unprotected-pending condition: capture off, and at least one
        // recording holds Pending Actions while NOT locked. The victim is an
        // arbitrary recording from the generated set.
        const recordings = scenario.recordings.map((r) => ({ ...r }));
        const victimIndex = victimSeed % recordings.length;
        recordings[victimIndex] = {
          ...recordings[victimIndex],
          holdsPending: true,
          locked: false,
        };
        const captureActive = false;

        const lockedIds = recordings.filter((r) => r.locked).map((r) => r.recording_id);
        const pendingIds = recordings.filter((r) => r.holdsPending).map((r) => r.recording_id);

        const projects = buildProjects(recordings, scenario.projectIds);
        const liveState = makeLiveState({ captureActive, lockedIds, pendingIds });
        const store = makeSpyStore();
        const { calls } = installFakeFetch();

        const { result, projects: returned } = await sync(
          SERVER,
          null,
          projects,
          STUB_SCHEMA,
          passValidator,
          store,
          liveState,
        );

        // Halts for exactly the pending-actions reason …
        assert.equal(result.halted, true);
        assert.equal(result.haltReason, 'pending-actions-unprotected');
        // … before any transport (no fetch) …
        assert.equal(calls.length, 0, 'no network work may occur on a pending-actions halt');
        // … without touching durable state …
        assert.equal(store.calls.load, 0);
        assert.equal(store.calls.save, 0);
        // … and without disturbing the local projects.
        assert.deepStrictEqual(returned, projects);
        // Nothing is pushed/pulled/deferred on a halt.
        assert.deepStrictEqual(result.pushed, []);
        assert.deepStrictEqual(result.pulled, []);
        assert.deepStrictEqual(result.review, []);
        assert.deepStrictEqual(result.conflicts, []);
      }),
      { numRuns: 200 },
    );
  });

  it('never trips the pending-actions gate when every pending recording is protected', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        // Enforce protection: when capture is NOT active, every pending-holding
        // recording is locked (the only protection left). When capture IS active,
        // the capture halt protects all of them, so locks are irrelevant.
        const recordings = scenario.recordings.map((r) => ({
          ...r,
          locked: scenario.captureActive ? r.locked : r.holdsPending || r.locked,
        }));
        const captureActive = scenario.captureActive;

        const lockedIds = recordings.filter((r) => r.locked).map((r) => r.recording_id);
        const pendingIds = recordings.filter((r) => r.holdsPending).map((r) => r.recording_id);

        const projects = buildProjects(recordings, scenario.projectIds);
        const liveState = makeLiveState({ captureActive, lockedIds, pendingIds });
        const store = makeSpyStore();
        const { calls } = installFakeFetch();

        const { result } = await sync(
          SERVER,
          null,
          projects,
          STUB_SCHEMA,
          passValidator,
          store,
          liveState,
        );

        // The pending-actions gate never trips when all pending recordings are
        // protected — regardless of how the cycle otherwise ends.
        assert.notEqual(result.haltReason, 'pending-actions-unprotected');

        if (captureActive) {
          // Capture protects everything: the cycle halts for capture, not pending,
          // and still does no network work.
          assert.equal(result.halted, true);
          assert.equal(result.haltReason, 'capture-active');
          assert.equal(calls.length, 0);
        } else {
          // No unprotected pending recording ⇒ the gate lets the cycle proceed to
          // real transport work.
          assert.equal(result.halted, false);
          assert.equal(result.haltReason, null);
          assert.ok(calls.length > 0, 'a proceeding cycle performs network work');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('pushes only committed recording.steps — Pending Actions are never observed', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        // A proceeding cycle: capture off and every pending recording locked, so
        // the gate passes and push runs. Whatever a recording's pending status,
        // the pushed payload must carry exactly its committed steps.
        const recordings = scenario.recordings.map((r) => ({
          ...r,
          locked: r.holdsPending || r.locked,
        }));
        const captureActive = false;

        const lockedIds = recordings.filter((r) => r.locked).map((r) => r.recording_id);
        const pendingIds = recordings.filter((r) => r.holdsPending).map((r) => r.recording_id);

        const projects = buildProjects(recordings, scenario.projectIds);
        const expectedSteps = committedStepsById(recordings);
        const liveState = makeLiveState({ captureActive, lockedIds, pendingIds });
        const store = makeSpyStore();
        const { putBodies } = installFakeFetch();

        const { result } = await sync(
          SERVER,
          null,
          projects,
          STUB_SCHEMA,
          passValidator,
          store,
          liveState,
        );

        assert.equal(result.haltReason, null);

        // Every recording in every pushed payload carries exactly its committed
        // step history — there is no path for Pending Action content to appear.
        for (const { body } of putBodies) {
          for (const rec of body.recordings) {
            assert.deepStrictEqual(
              rec.steps,
              expectedSteps.get(rec.recording_id),
              `recording ${rec.recording_id} pushed steps must equal its committed steps`,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ─── Deterministic regression examples ──────────────────────────────────────

  it('regression: a single unprotected pending recording halts with no fetch', async () => {
    const projects = [
      {
        project_id: 'p1',
        name: 'P1',
        created_at: FIXED_CREATED_AT,
        recordings: [{ recording_id: 'r1', name: 'R1', created_at: FIXED_CREATED_AT, steps: [] }],
      },
    ];
    const liveState = makeLiveState({
      captureActive: false,
      lockedIds: [],
      pendingIds: ['r1'],
    });
    const store = makeSpyStore();
    const { calls } = installFakeFetch();

    const { result } = await sync(
      SERVER,
      null,
      projects,
      STUB_SCHEMA,
      passValidator,
      store,
      liveState,
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'pending-actions-unprotected');
    assert.equal(calls.length, 0);
    assert.equal(store.calls.save, 0);
  });

  it('regression: a pending recording that is locked does not trip the gate', async () => {
    const projects = [
      {
        project_id: 'p1',
        name: 'P1',
        created_at: FIXED_CREATED_AT,
        recordings: [{ recording_id: 'r1', name: 'R1', created_at: FIXED_CREATED_AT, steps: [] }],
      },
    ];
    const liveState = makeLiveState({
      captureActive: false,
      lockedIds: ['r1'],
      pendingIds: ['r1'],
    });
    const store = makeSpyStore();
    const { calls } = installFakeFetch();

    const { result } = await sync(
      SERVER,
      null,
      projects,
      STUB_SCHEMA,
      passValidator,
      store,
      liveState,
    );

    assert.notEqual(result.haltReason, 'pending-actions-unprotected');
    assert.equal(result.halted, false);
    assert.ok(calls.length > 0);
  });

  it('regression: an unprotected pending recording is shielded by the capture-active halt', async () => {
    const projects = [
      {
        project_id: 'p1',
        name: 'P1',
        created_at: FIXED_CREATED_AT,
        recordings: [{ recording_id: 'r1', name: 'R1', created_at: FIXED_CREATED_AT, steps: [] }],
      },
    ];
    // Capture active, recording holds pending and is NOT locked: capture protects
    // it, so the pending-actions gate is moot.
    const liveState = makeLiveState({
      captureActive: true,
      lockedIds: [],
      pendingIds: ['r1'],
    });
    const store = makeSpyStore();
    const { calls } = installFakeFetch();

    const { result } = await sync(
      SERVER,
      null,
      projects,
      STUB_SCHEMA,
      passValidator,
      store,
      liveState,
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'capture-active');
    assert.notEqual(result.haltReason, 'pending-actions-unprotected');
    assert.equal(calls.length, 0);
  });
});
