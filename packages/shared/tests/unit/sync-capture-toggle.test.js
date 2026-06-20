/**
 * sync-capture-toggle.test.js — mid-cycle capture-toggle timing (Capture-Active Sync Halt).
 *
 * Capture-Active Sync Halt:
 *   "IF Capture_Active begins while a sync cycle is in progress, THEN THE
 *    Sync_Client SHALL complete the current unit of work and start no new work
 *    until Capture_Active ends."
 *
 * The two halves of the Capture-Active Sync Halt are:
 *   (a) complete the current unit of work — a unit already in flight when
 *       capture begins is not corrupted or aborted; it finishes; and
 *   (b) start no new work — once capture is active, no new unit of work begins.
 *
 * ── Granularity note (current sync() structure) ──────────────────────────────
 * The current `sync()` evaluates the capture signal as a SINGLE pre-flight gate
 * (`evaluatePreflightGate`) before any push/pull. It does not yet re-check
 * `isCaptureActive()` per-Unit mid-cycle — that finer-grained checkpoint is
 * slated for the orchestrator detection wiring. Consequently the halt
 * is enforced today at the **sync-cycle granularity**: a cycle that started
 * before capture was active runs to completion (its unit of work finishes), and
 * the next cycle starts no new work because the pre-flight gate halts it.
 *
 * This test therefore models "the first Unit completes, then capture begins" as
 * a cycle boundary — the smallest unit boundary the current sync() observes the
 * capture signal across — using a fake LiveState whose `isCaptureActive()` flips
 * to true after the first unit completes, and a fake fetch that counts the units
 * (project pushes) actually processed. When the per-Unit mid-cycle checkpoint is
 * wired in later, this test's intent (current unit finishes, no new unit starts)
 * still holds; only the unit boundary tightens from cycle-level to Unit-level.
 *
 * Determinism: capture toggling is driven by a counter incremented inside the
 * mocked `globalThis.fetch`, the established pattern in sync-client.test.js — no
 * timers, no wall-clock thresholds, nothing timing-flaky.
 *
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sync } from '../../sync-client.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a minimal valid project object (one "unit of work" on push). */
function makeProject(id, name, recordings = []) {
  return {
    project_id: id,
    name: name ?? `Project ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    recordings,
  };
}

/** Permissive stub validator — this test exercises gate timing, not validation. */
function passValidator() {
  return true;
}
passValidator.errors = [];

/** A fresh empty SyncState, matching the documented store shape (sync-types.js). */
function emptyState() {
  return { schema: 1, baselines: {}, snapshots: {}, reviews: {}, conflicts: {} };
}

/** Minimal in-memory SyncStore stub. The pre-flight gate never touches it, but
 * `sync()` takes it as the 6th positional arg ahead of `liveState`. */
function makeNoopStore() {
  let state = emptyState();
  return {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
}

let fetchCalls = [];

function mockFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return handler(url, options);
  };
}

function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── mid-cycle capture toggle ──────────────────────────────────────────

describe('mid-cycle capture-toggle timing', () => {
  it('the in-progress unit of work completes, and once capture is active no new unit starts', async () => {
    // A LiveState whose capture signal flips ON only AFTER the first unit of
    // work completes — modelling the user starting capture mid-flight. Nothing
    // is locked and there are no pending actions, so the only gate in play is
    // the Capture-Active halt.
    let unitsProcessed = 0;
    let captureActive = false;

    const liveState = {
      isCaptureActive: () => captureActive,
      getLockedRecordingIds: () => new Set(),
      recordingsWithPendingActions: () => new Set(),
    };

    // Fake fetch observes how many units are processed: each project push
    // (PUT /projects/:id) is one unit. Capture begins right after the first
    // unit completes. GET /projects (the pull manifest) is empty so the cycle
    // has nothing to merge back.
    mockFetch((url, opts) => {
      if (opts.method === 'PUT') {
        unitsProcessed += 1;
        if (unitsProcessed === 1) {
          // Capture begins after the first unit of work completes.
          captureActive = true;
        }
        return makeResponse(200, { ok: true });
      }
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, []);
      return makeResponse(404);
    });

    const store = makeNoopStore();
    const local = [makeProject('p1'), makeProject('p2')];

    // ── Cycle 1 ──────────────────────────────────────────────────────────────
    // Capture was inactive at the pre-flight gate, so the cycle runs. Capture
    // flipping mid-cycle must not corrupt or abort the in-flight work: the
    // current unit of work completes (the "complete current unit" half).
    const first = await sync(
      'https://srv.test',
      null,
      local,
      STUB_SCHEMA,
      passValidator,
      store,
      liveState,
    );

    assert.equal(
      first.result.halted,
      false,
      'a cycle that started before capture was active completes — it is not halted',
    );
    assert.ok(unitsProcessed >= 1, 'at least the first unit of work is processed and finishes');
    assert.equal(liveState.isCaptureActive(), true, 'capture has begun after the first unit');

    const unitsAfterFirstCycle = unitsProcessed;

    // ── Cycle 2 ──────────────────────────────────────────────────────────────
    // Capture is now active. The next sync cycle must start no new unit of work
    // (the "start no new work" half): the pre-flight gate halts immediately with reason
    // 'capture-active' and the fake fetch observes zero further units.
    fetchCalls = [];
    const second = await sync(
      'https://srv.test',
      null,
      first.projects,
      STUB_SCHEMA,
      passValidator,
      store,
      liveState,
    );

    assert.equal(second.result.halted, true, 'no new cycle proceeds while capture is active');
    assert.equal(
      second.result.haltReason,
      'capture-active',
      'the halt reason is the capture-active gate',
    );
    assert.equal(second.result.pushed.length, 0, 'no project is pushed while capture is active');
    assert.equal(second.result.pulled.length, 0, 'no project is pulled while capture is active');
    assert.equal(
      fetchCalls.length,
      0,
      'no transport at all — no new unit of work is started while capture is active',
    );
    assert.equal(
      unitsProcessed,
      unitsAfterFirstCycle,
      'no further units are processed once capture is active',
    );
    // Local state is returned unchanged when the cycle is gated.
    assert.deepEqual(second.projects, first.projects, 'gated cycle leaves projects unchanged');
  });

  it('the capture gate is re-evaluated each cycle: it re-enables once capture ends', async () => {
    // Companion to the timing case: confirms the gate is checked per cycle, so
    // "start no new work UNTIL Capture_Active ends" is satisfied — when capture
    // ends, the very next cycle is allowed to start work again.
    let captureActive = true; // capture is active to begin with

    const liveState = {
      isCaptureActive: () => captureActive,
      getLockedRecordingIds: () => new Set(),
      recordingsWithPendingActions: () => new Set(),
    };

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, []);
      return makeResponse(404);
    });

    const store = makeNoopStore();
    const local = [makeProject('p1')];

    // While capture is active: gated, no work started.
    const gated = await sync(
      'https://srv.test',
      null,
      local,
      STUB_SCHEMA,
      passValidator,
      store,
      liveState,
    );
    assert.equal(gated.result.halted, true);
    assert.equal(gated.result.haltReason, 'capture-active');
    assert.equal(fetchCalls.length, 0, 'no unit of work starts while capture is active');

    // Capture ends; the next cycle is allowed to start work again.
    captureActive = false;
    fetchCalls = [];
    const resumed = await sync(
      'https://srv.test',
      null,
      local,
      STUB_SCHEMA,
      passValidator,
      store,
      liveState,
    );
    assert.equal(resumed.result.halted, false, 'a new cycle is allowed once capture ends');
    assert.deepEqual(resumed.result.pushed, ['p1'], 'work resumes — the project is pushed');
    assert.ok(fetchCalls.length >= 1, 'transport resumes once capture has ended');
  });
});
