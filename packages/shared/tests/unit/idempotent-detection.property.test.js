/**
 * idempotent-detection.property.test.js — Property test that graded detection is
 * IDEMPOTENT across repeated sync cycles, driving the full `sync()` orchestrator
 * with a PERSISTENT store against unchanging server payloads.
 *
 * Conflict and Review state must be durable AND must not multiply: running the
 * same detection again over the same inputs may NOT accumulate duplicate records,
 * may NOT flip a Unit between Review and Conflict, and may NOT lose state that
 * already exists. The store keys every deferred record by `unitRef`
 * (`"<project_id>"` or `"<project_id>:<recording_id>"`) and the upsert helpers are
 * idempotent, so re-detecting the same Unit refreshes its single record (keeping
 * the original `detectedAt`) rather than appending a second one (R10.3, R10.4,
 * R10.5).
 *
 * This property pins that by running `sync()` THREE times in a row with the SAME
 * `localProjects`, the SAME mocked server payloads, and a single PERSISTENT
 * in-memory `SyncStore` carried across the cycles. The scenario mixes, per
 * recording, every Unit state the detector can settle into across cycles:
 *
 *   - `converged`               — NONE state (R10.4): local == incoming == baseline;
 *                                 never a Review and never a Conflict.
 *   - `review-changed`          — Review (changed-incoming): local == baseline,
 *                                 incoming differs.
 *   - `conflict-diverged`       — Conflict (diverged): local and incoming both
 *                                 differ from the baseline and from each other.
 *   - `review-remote-delete`    — Review (deleted-remote-review): in the baseline,
 *                                 local unchanged, absent on the server.
 *   - `conflict-delete-change`  — Conflict (conflict-delete-vs-change): in the
 *                                 baseline, changed locally, absent on the server.
 *
 * After EACH cycle the assertions are:
 *   - the set of Review `unitRef`s and the set of Conflict `unitRef`s are exactly
 *     the expected sets, with one record each (counts never grow → no duplicates);
 *   - Review and Conflict are mutually exclusive per `unitRef`;
 *   - NONE (converged) Units never appear as a Review or a Conflict;
 *   - the reported `result.review` / `result.conflicts` equal the same sets.
 *
 * To prove `detectedAt` is PRESERVED (not regenerated) across cycles, every
 * record's `detectedAt` is overwritten with a sentinel after cycle 1; if a later
 * cycle re-stamped it with `Date.now()` the sentinel would be lost, so asserting
 * the sentinel survives cycles 2 and 3 is a deterministic preservation check.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / `brand-new-auto-add`
 * (`makeResponse`-style Response stubs) and dispatches per project_id; the
 * validator passes; an in-memory `SyncStore` (seeded with the baselines) persists
 * across cycles; a permissive `LiveState` (capture inactive, nothing locked,
 * nothing pending) lets each cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * **Validates: Requirements 10.3, 10.4, 10.5**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 19: Detection is idempotent across repeated cycles

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

// A clearly-not-"now" timestamp used to prove detectedAt is preserved, not
// regenerated: if a later cycle re-stamped detectedAt with Date.now() this
// sentinel would vanish.
const SENTINEL_DETECTED_AT = '1999-01-01T00:00:00.000Z';

// ─── fetch double (mirrors sync-client.test.js / brand-new-auto-add) ─────────

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
 * by project_id:
 *   - PUT (push)        → 200 (the push phase always succeeds).
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload.
 *
 * The same mock serves every cycle, so the server side is unchanging across the
 * repeated syncs — exactly the "same inputs" Property 19 quantifies over.
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
 * In-memory {@link SyncStore}, seeded with an initial SyncState and PERSISTING
 * across cycles (the same `saved` blob is loaded by each `sync()` and rewritten
 * on save). Clones on the way in and out so no reference is shared with a cycle.
 * `mutate` lets the test reach into the persisted blob between cycles (used only
 * to plant the detectedAt sentinel).
 *
 * @param {import('../../sync-types.js').SyncState} [initial]
 */
function makeStore(initial) {
  let saved = initial ? structuredClone(initial) : null;
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
    mutate(fn) {
      if (saved) fn(saved);
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

/** A validator that accepts every payload (idempotent detection is the focus). */
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

// ─── generators ──────────────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 20 }),
  deleted: fc.boolean(),
});

/**
 * One recording, tagged with the Unit state it should settle into. The version
 * differences are driven purely by the recording `name` (folded into the content
 * digest, R2.8): the baseline always holds the `'base'` version, and a category's
 * local/server names decide its classification. Steps are shared across versions
 * so only the intended field varies.
 */
const arbRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  steps: fc.array(arbStep, { maxLength: 2 }),
  outcome: fc.constantFrom(
    'converged',
    'review-changed',
    'conflict-diverged',
    'review-remote-delete',
    'conflict-delete-change',
  ),
});

const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recordings: fc.uniqueArray(arbRecordingSpec, {
    selector: (r) => r.recording_id,
    minLength: 1,
    maxLength: 4,
  }),
});

const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 4,
});

const REC_CREATED = '2026-02-01T00:00:00.000Z';
const PROJ_CREATED = '2026-01-01T00:00:00.000Z';

/** Build a plain recording literal at a given version name. */
function rec(recording_id, name, steps) {
  return { recording_id, name, created_at: REC_CREATED, steps };
}

/**
 * Materialize a scenario into the `sync()` inputs plus the derived expectations.
 *
 * Every project is present on BOTH sides with IDENTICAL project metadata (so the
 * project-metadata Unit is always converged and never deferred); each recording
 * realizes its tagged outcome. The seeded baseline holds the `'base'` version of
 * every recording, so a recording absent on the server is seen as a deletion
 * (not brand-new), and a locally-unchanged recording stays equal to the baseline.
 */
function materialize(projectSpecs) {
  const seed = createEmptySyncState();
  const localProjects = [];
  const payloadById = new Map();
  const manifest = [];
  const expectedReview = [];
  const expectedConflict = [];
  const convergedRefs = [];

  for (const pspec of projectSpecs) {
    const pid = pspec.project_id;
    const pname = `Project ${pid.slice(0, 8)}`;

    const baselineRecs = [];
    const localRecs = [];
    const serverRecs = [];

    for (const rspec of pspec.recordings) {
      const rid = rspec.recording_id;
      const steps = rspec.steps;
      const ref = `${pid}:${rid}`;

      // The baseline always remembers the agreed 'base' version of the recording.
      baselineRecs.push(rec(rid, 'base', steps));

      switch (rspec.outcome) {
        case 'converged':
          // local == incoming == baseline → already-converged (NONE state).
          localRecs.push(rec(rid, 'base', steps));
          serverRecs.push(rec(rid, 'base', steps));
          convergedRefs.push(ref);
          break;
        case 'review-changed':
          // local == baseline, incoming differs → changed-incoming (Review).
          localRecs.push(rec(rid, 'base', steps));
          serverRecs.push(rec(rid, 'server', steps));
          expectedReview.push(ref);
          break;
        case 'conflict-diverged':
          // local and incoming both differ from baseline and each other → diverged.
          localRecs.push(rec(rid, 'local', steps));
          serverRecs.push(rec(rid, 'server', steps));
          expectedConflict.push(ref);
          break;
        case 'review-remote-delete':
          // local == baseline, absent on the server → deleted-remote-review (Review).
          localRecs.push(rec(rid, 'base', steps));
          // server omits the recording
          expectedReview.push(ref);
          break;
        case 'conflict-delete-change':
          // changed locally, absent on the server → conflict-delete-vs-change.
          localRecs.push(rec(rid, 'local', steps));
          // server omits the recording
          expectedConflict.push(ref);
          break;
        default:
          break;
      }
    }

    // Baseline: the last-agreed project, holding the 'base' version of every rec.
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
  }

  return {
    seed,
    localProjects,
    payloadById,
    manifest,
    expectedReview,
    expectedConflict,
    convergedRefs,
  };
}

// ─── assertion helpers ────────────────────────────────────────────────────────

/** Run one full sync cycle against the persistent store with the same inputs. */
async function runCycle(store, localProjects) {
  return sync(
    'https://srv.test',
    null,
    localProjects,
    STUB_SCHEMA,
    passValidator,
    store,
    makeLiveState(),
  );
}

/** Sorted keys of the reviews / conflicts maps in the persisted state. */
function recordKeys(state) {
  return {
    reviewKeys: Object.keys(state.reviews ?? {}).sort(),
    conflictKeys: Object.keys(state.conflicts ?? {}).sort(),
  };
}

/** Assert an actual unitRef array equals the expected set (no dupes, same members). */
function assertSet(actual, expectedSorted, label) {
  const sorted = [...actual].sort();
  assert.equal(sorted.length, expectedSorted.length, `${label}: count (no duplicates)`);
  assert.deepEqual(sorted, expectedSorted, `${label}: members`);
}

describe('Property 19: Detection is idempotent across repeated cycles', () => {
  it('keeps exactly one record per Unit across repeated cycles, preserves detectedAt, and never duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (projectSpecs) => {
        const {
          seed,
          localProjects,
          payloadById,
          manifest,
          expectedReview,
          expectedConflict,
          convergedRefs,
        } = materialize(projectSpecs);
        installMockFetch(manifest, payloadById);

        // A SINGLE store persisted across all three cycles.
        const store = makeStore(seed);

        const expReview = [...expectedReview].sort();
        const expConflict = [...expectedConflict].sort();

        // ── Cycle 1 — initial detection produces exactly the expected records ──
        const r1 = await runCycle(store, localProjects);
        assert.equal(r1.result.halted, false, 'cycle 1 runs to completion');
        assertSet(r1.result.review, expReview, 'cycle 1 result.review');
        assertSet(r1.result.conflicts, expConflict, 'cycle 1 result.conflicts');

        let state = store.getState();
        let keys = recordKeys(state);
        assert.deepEqual(keys.reviewKeys, expReview, 'cycle 1: review records');
        assert.deepEqual(keys.conflictKeys, expConflict, 'cycle 1: conflict records');
        // Mutual exclusion (R10.3): no unitRef is in both maps.
        for (const k of keys.reviewKeys) {
          assert.equal(state.conflicts?.[k], undefined, `cycle 1: ${k} not in both maps`);
        }
        // NONE Units are processed normally — never spuriously deferred (R10.4).
        for (const ref of convergedRefs) {
          assert.equal(state.reviews?.[ref], undefined, `converged ${ref} is not a Review`);
          assert.equal(state.conflicts?.[ref], undefined, `converged ${ref} is not a Conflict`);
        }

        // Plant a sentinel detectedAt so a later regeneration would be detectable.
        store.mutate((s) => {
          for (const k of Object.keys(s.reviews)) s.reviews[k].detectedAt = SENTINEL_DETECTED_AT;
          for (const k of Object.keys(s.conflicts))
            s.conflicts[k].detectedAt = SENTINEL_DETECTED_AT;
        });

        // ── Cycles 2 and 3 — re-detection must be a no-op on the record SET ──
        for (let cycle = 2; cycle <= 3; cycle++) {
          const r = await runCycle(store, localProjects);
          assert.equal(r.result.halted, false, `cycle ${cycle} runs to completion`);
          assertSet(r.result.review, expReview, `cycle ${cycle} result.review`);
          assertSet(r.result.conflicts, expConflict, `cycle ${cycle} result.conflicts`);

          state = store.getState();
          keys = recordKeys(state);

          // Same sets, same counts — nothing accumulated (R10.3).
          assert.deepEqual(keys.reviewKeys, expReview, `cycle ${cycle}: review set stable`);
          assert.deepEqual(keys.conflictKeys, expConflict, `cycle ${cycle}: conflict set stable`);
          assert.equal(
            keys.reviewKeys.length,
            expReview.length,
            `cycle ${cycle}: no review duplicates`,
          );
          assert.equal(
            keys.conflictKeys.length,
            expConflict.length,
            `cycle ${cycle}: no conflict duplicates`,
          );

          for (const k of keys.reviewKeys) {
            // Single record, correct kind, mutually exclusive, detectedAt preserved.
            assert.equal(state.reviews[k].kind, 'review', `cycle ${cycle}: ${k} stays a Review`);
            assert.equal(
              state.conflicts?.[k],
              undefined,
              `cycle ${cycle}: ${k} not also a Conflict`,
            );
            assert.equal(
              state.reviews[k].detectedAt,
              SENTINEL_DETECTED_AT,
              `cycle ${cycle}: Review ${k} detectedAt preserved (R10.5)`,
            );
          }
          for (const k of keys.conflictKeys) {
            assert.equal(
              state.conflicts[k].kind,
              'conflict',
              `cycle ${cycle}: ${k} stays a Conflict`,
            );
            assert.equal(state.reviews?.[k], undefined, `cycle ${cycle}: ${k} not also a Review`);
            assert.equal(
              state.conflicts[k].detectedAt,
              SENTINEL_DETECTED_AT,
              `cycle ${cycle}: Conflict ${k} detectedAt preserved (R10.5)`,
            );
          }
          for (const ref of convergedRefs) {
            assert.equal(
              state.reviews?.[ref],
              undefined,
              `cycle ${cycle}: converged ${ref} still NONE`,
            );
            assert.equal(
              state.conflicts?.[ref],
              undefined,
              `cycle ${cycle}: converged ${ref} still NONE`,
            );
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  // ─── Deterministic regression examples ──────────────────────────────────────

  it('a Review and a Conflict each stay a single record with a stable detectedAt across three cycles', async () => {
    const PID = '018f0000-0000-7000-8000-000000000201';
    const REVIEW_REC = '018f0000-0000-7000-8000-0000000000a1';
    const CONFLICT_REC = '018f0000-0000-7000-8000-0000000000a2';
    const reviewRef = `${PID}:${REVIEW_REC}`;
    const conflictRef = `${PID}:${CONFLICT_REC}`;

    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    // Baseline holds both recordings at 'base'.
    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      PID,
      projectProjection({
        project_id: PID,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(REVIEW_REC, 'base', steps), rec(CONFLICT_REC, 'base', steps)],
      }),
    );

    // Local: review rec unchanged ('base'); conflict rec changed ('local').
    const local = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [rec(REVIEW_REC, 'base', steps), rec(CONFLICT_REC, 'local', steps)],
    };
    // Server: review rec changed ('server'); conflict rec changed differently ('server').
    const server = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [rec(REVIEW_REC, 'server', steps), rec(CONFLICT_REC, 'server', steps)],
    };
    installMockFetch([{ project_id: PID, name: 'P' }], new Map([[PID, buildPayload(server)]]));

    const store = makeStore(seed);

    const r1 = await runCycle(store, [local]);
    assert.equal(r1.result.halted, false);
    assert.deepEqual([...r1.result.review].sort(), [reviewRef]);
    assert.deepEqual([...r1.result.conflicts].sort(), [conflictRef]);

    store.mutate((s) => {
      s.reviews[reviewRef].detectedAt = SENTINEL_DETECTED_AT;
      s.conflicts[conflictRef].detectedAt = SENTINEL_DETECTED_AT;
    });

    for (let cycle = 2; cycle <= 3; cycle++) {
      const r = await runCycle(store, [local]);
      assert.equal(r.result.halted, false);
      const state = store.getState();
      // Exactly one Review and one Conflict, never duplicated, never swapped.
      assert.deepEqual(Object.keys(state.reviews), [reviewRef]);
      assert.deepEqual(Object.keys(state.conflicts), [conflictRef]);
      assert.equal(state.reviews[reviewRef].kind, 'review');
      assert.equal(state.conflicts[conflictRef].kind, 'conflict');
      // detectedAt preserved across cycles (R10.5).
      assert.equal(state.reviews[reviewRef].detectedAt, SENTINEL_DETECTED_AT);
      assert.equal(state.conflicts[conflictRef].detectedAt, SENTINEL_DETECTED_AT);
    }
  });

  it('preserves a pre-existing Conflict when a later cycle re-syncs without re-detecting it (R10.5)', async () => {
    // A project that is now FULLY converged on both sides: the cycle advances its
    // baseline (already-converged) but does NOT re-detect the recording, so a
    // Conflict already recorded for it must be left untouched — clearing happens
    // only via resolution, never silently during a sync cycle.
    const PID = '018f0000-0000-7000-8000-000000000202';
    const REC_ID = '018f0000-0000-7000-8000-0000000000b1';
    const ref = `${PID}:${REC_ID}`;
    const steps = [{ uuid: 'c1', logical_id: 'a', step_number: 0, deleted: false }];

    const converged = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [rec(REC_ID, 'base', steps)],
    };

    // Seed: baseline agrees with both sides, PLUS a pre-existing Conflict record.
    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(converged));
    seed.conflicts[ref] = {
      kind: 'conflict',
      unitRef: ref,
      project_id: PID,
      recording_id: REC_ID,
      local: recordingProjection(rec(REC_ID, 'old-local', steps)),
      incoming: recordingProjection(rec(REC_ID, 'old-incoming', steps)),
      detectedAt: SENTINEL_DETECTED_AT,
    };

    installMockFetch([{ project_id: PID, name: 'P' }], new Map([[PID, buildPayload(converged)]]));

    const store = makeStore(seed);

    for (let cycle = 1; cycle <= 3; cycle++) {
      const r = await runCycle(store, [converged]);
      assert.equal(r.result.halted, false);
      // The converged project produces no new deferral this cycle.
      assert.deepEqual(r.result.review, []);
      assert.deepEqual(r.result.conflicts, []);

      const state = store.getState();
      // The pre-existing Conflict survives every cycle, content and timestamp intact.
      const item = state.conflicts[ref];
      assert.ok(item, `cycle ${cycle}: pre-existing Conflict preserved`);
      assert.equal(item.kind, 'conflict');
      assert.equal(item.detectedAt, SENTINEL_DETECTED_AT, `cycle ${cycle}: detectedAt preserved`);
      assert.deepEqual(item.local, recordingProjection(rec(REC_ID, 'old-local', steps)));
      assert.deepEqual(item.incoming, recordingProjection(rec(REC_ID, 'old-incoming', steps)));
      // It is never promoted to a Review.
      assert.equal(state.reviews?.[ref], undefined, `cycle ${cycle}: not flipped to a Review`);
    }
  });
});
