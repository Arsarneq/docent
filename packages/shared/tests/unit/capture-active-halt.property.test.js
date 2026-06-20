/**
 * capture-active-halt.property.test.js — Property test for the Capture-Active
 * sync halt (the first tier of the two-tier live-work protection).
 *
 * A recording is the author's live narrative. While capture is running, sync
 * must not touch the machine at all: the pre-flight gate is a *hard block*, not
 * an advisory check. So `sync()` must return immediately with
 * `halted: true` and `haltReason: 'capture-active'`, performing NO push, NO
 * pull, and NO merge for any Unit — observable as "no `fetch` ever happened and
 * the local projects come back untouched". The moment
 * capture ends, the very same state must be allowed to sync again.
 *
 * This property pins both halves of that contract over a large input space:
 *   - for ANY local projects and ANY locked/pending live-state, while capture is
 *     active sync starts no cycle (no fetch, projects unchanged); and
 *   - the SAME state, once capture ends, is allowed to proceed (a cycle runs,
 *     and it does not halt for `capture-active`).
 *
 * The capture-active flag is generated to dominate every other live signal: even
 * when there are locked recordings or recordings holding Pending Actions, the
 * capture halt fires first (it short-circuits before the pending-actions
 * assertion), which is exactly why pending work is safe during capture.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` (`mockFetch`,
 * `makeResponse`) so we can assert no network work occurs while capture is
 * active. An in-memory `SyncStore` records whether `save()` was ever called, to
 * confirm the gate leaves durable state untouched.
 *
 * Uses Node.js built-in test runner + fast-check (fast-check v4: no
 * `fc.hexaString` — `fc.uuid()` supplies ids).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Capture-active blocks all sync work; ending capture re-enables it

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// ─── fetch double (mirrors sync-client.test.js) ──────────────────────────────

/** Records every fetch call so we can assert no network work occurs. */
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
 * Installs a mock `fetch` on globalThis and resets the call log. The handler
 * returns 200 for PUT (push) and an empty manifest for GET /projects, so when a
 * cycle IS allowed to run it completes cleanly (no auth halt) — the only halt
 * left to observe is the capture-active gate itself.
 */
function installMockFetch() {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (options && options.method === 'PUT') return makeResponse(200, { ok: true });
    // GET /projects manifest — empty so no per-project fetches follow.
    return makeResponse(200, []);
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── adapters (LiveState + SyncStore) ────────────────────────────────────────

/**
 * A fake {@link LiveState}. `isCaptureActive` returns the generated flag;
 * `getLockedRecordingIds` / `recordingsWithPendingActions` return the generated
 * sets. These are the only signals the pre-flight gate reads.
 *
 * @param {{ captureActive: boolean, locked: string[], pending: string[] }} cfg
 * @returns {import('../../sync-types.js').LiveState}
 */
function makeLiveState({ captureActive, locked, pending }) {
  return {
    isCaptureActive: () => captureActive,
    getLockedRecordingIds: () => new Set(locked),
    recordingsWithPendingActions: () => new Set(pending),
  };
}

/**
 * A fake {@link SyncStore} that records whether `save()` was ever called. The
 * capture-active gate must not write durable state, so `saved` must stay false
 * across a blocked cycle.
 */
function makeRecordingStore() {
  const calls = { saved: false };
  const store = {
    async load() {
      return null;
    },
    async save() {
      calls.saved = true;
    },
  };
  return { store, calls };
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbId = fc.uuid();

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

/** A committed step record (append-only version entry). */
const arbStep = fc.record({
  uuid: arbId,
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 20 }),
  deleted: fc.boolean(),
});

/** A recording with a committed step history. */
const arbRecording = fc.record({
  recording_id: arbId,
  name: fc.string({ maxLength: 30 }),
  created_at: arbIso,
  steps: fc.array(arbStep, { maxLength: 4 }),
});

/** A project with recordings. */
const arbProject = fc.record({
  project_id: arbId,
  name: fc.string({ maxLength: 30 }),
  created_at: arbIso,
  recordings: fc.array(arbRecording, { maxLength: 3 }),
});

/**
 * A live-state scenario. `locked` is an arbitrary id set; `pending` is drawn as
 * a SUBSET of `locked`. The subset relation matters for the "capture ends"
 * branch: with capture off, a recording holding Pending Actions is safe only if
 * it is locked, so keeping `pending ⊆ locked` guarantees the
 * re-enabled cycle is gated by capture alone and not by the pending-actions
 * assertion — isolating exactly the behavior this property is about.
 */
const arbScenario = fc
  .record({
    projects: fc.array(arbProject, { maxLength: 3 }),
    locked: fc.array(arbId, { maxLength: 4 }),
  })
  .chain(({ projects, locked }) =>
    fc.record({
      projects: fc.constant(projects),
      locked: fc.constant(locked),
      pending: fc.subarray(locked),
    }),
  );

describe('Capture-active blocks all sync work; ending capture re-enables it', () => {
  it('while capture is active sync does no work; the same state proceeds once capture ends', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ projects, locked, pending }) => {
        // Snapshot the input (as JSON) so we can prove the blocked cycle changed
        // nothing. JSON is used rather than structuredClone + deepStrictEqual so
        // the comparison is prototype-agnostic: fast-check can generate
        // null-prototype records, and only the *content* matters here.
        const projectsBeforeJson = JSON.stringify(projects);

        // ── Capture ACTIVE: hard block ───────────────────────────────────────
        // Capture dominates every other signal, so locked/pending are passed
        // through as-is (even an otherwise-"unprotected" pending recording must
        // not matter while capture is running).
        installMockFetch();
        const { store: blockedStore, calls: blockedCalls } = makeRecordingStore();
        const activeLive = makeLiveState({ captureActive: true, locked, pending });

        const blocked = await sync(
          'https://srv.test',
          null,
          projects,
          STUB_SCHEMA,
          () => true,
          blockedStore,
          activeLive,
        );

        // no cycle started: no push, no pull, no merge.
        assert.equal(fetchCalls.length, 0, 'no fetch may occur while capture is active');
        assert.equal(blocked.result.halted, true);
        assert.equal(blocked.result.haltReason, 'capture-active');
        assert.deepEqual(blocked.result.pushed, []);
        assert.deepEqual(blocked.result.pulled, []);
        // Local data is returned untouched (gate is a block, not a merge).
        assert.equal(blocked.projects, projects, 'projects are returned by reference, unmerged');
        assert.equal(
          JSON.stringify(blocked.projects),
          projectsBeforeJson,
          'projects are unchanged',
        );
        // Durable state was never written by the gate.
        assert.equal(blockedCalls.saved, false, 'the store is left untouched');

        // ── Capture ENDS: a new cycle is allowed ────────────────────────────
        // Same projects, same locked/pending sets — only the capture flag flips.
        installMockFetch();
        const { store: openStore } = makeRecordingStore();
        const endedLive = makeLiveState({ captureActive: false, locked, pending });

        const proceeded = await sync(
          'https://srv.test',
          null,
          projects,
          STUB_SCHEMA,
          () => true,
          openStore,
          endedLive,
        );

        // once capture ends, a cycle runs: transport happens (at minimum
        // the pull manifest GET) and it does NOT halt for capture-active.
        assert.ok(fetchCalls.length >= 1, 'a cycle runs once capture ends');
        assert.notEqual(proceeded.result.haltReason, 'capture-active');
        assert.equal(proceeded.result.halted, false);
        assert.equal(proceeded.result.haltReason, null);
      }),
      { numRuns: 100 },
    );
  });

  // ── Deterministic regression examples ────────────────────────────────────

  it('capture active halts immediately even with an otherwise-unprotected pending recording', async () => {
    installMockFetch();
    const { store, calls } = makeRecordingStore();
    const live = makeLiveState({
      captureActive: true,
      locked: [],
      pending: ['rec-unprotected'], // would be 'pending-actions-unprotected' if capture were off
    });

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [{ project_id: 'p1', name: 'P1', created_at: '2026-01-01T00:00:00.000Z', recordings: [] }],
      STUB_SCHEMA,
      () => true,
      store,
      live,
    );

    assert.equal(result.halted, true);
    assert.equal(
      result.haltReason,
      'capture-active',
      'capture halt wins over the pending assertion',
    );
    assert.equal(fetchCalls.length, 0);
    assert.equal(calls.saved, false);
    assert.equal(projects.length, 1);
  });

  it('capture inactive (no live work) lets the cycle proceed', async () => {
    installMockFetch();
    const { store } = makeRecordingStore();
    const live = makeLiveState({ captureActive: false, locked: [], pending: [] });

    const { result } = await sync(
      'https://srv.test',
      null,
      [{ project_id: 'p1', name: 'P1', created_at: '2026-01-01T00:00:00.000Z', recordings: [] }],
      STUB_SCHEMA,
      () => true,
      store,
      live,
    );

    assert.equal(result.halted, false);
    assert.equal(result.haltReason, null);
    assert.ok(fetchCalls.length >= 1, 'push and/or pull transport occurred');
  });
});
