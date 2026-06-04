/**
 * gating-parity.property.test.js — Property test that the live-work GATING is
 * identical for a "manually" triggered and an "automatically" triggered sync.
 *
 * Requirement 15.3 demands that the Locked_Recording exclusion and the
 * Capture_Active halt apply IDENTICALLY no matter how the cycle was triggered.
 * The orchestrator honors this structurally: `sync()` has a SINGLE code path and
 * takes NO trigger-type argument, so there is no manual-vs-automatic branch in
 * which the gating could diverge. There is therefore nothing to distinguish the
 * two triggers other than the call itself.
 *
 * This property pins that contract by MODELING "manual" and "automatic" as two
 * invocations of `sync()` with byte-identical inputs (same local projects, same
 * server payloads, same seeded Sync_Baseline, and — crucially — the same
 * `LiveState` gating conditions: capture-active flag, locked-recording set, and
 * pending-actions set). It then asserts the two invocations produce IDENTICAL
 * gating behavior:
 *
 *   - identical `halted` / `haltReason` — so the Capture_Active halt and the
 *     pending-actions safety halt fire (or not) the same for both triggers; and
 *   - identical reconciliation outcome when a cycle proceeds — identical merged
 *     projects, identical reported `review` / `conflicts` sets, and identical
 *     stored Review / Conflict keys — so the Locked_Recording exclusion removes
 *     EXACTLY the same recordings from the inbound merge regardless of trigger.
 *
 * The generated `LiveState` is deliberately unconstrained so all three gating
 * regimes are exercised across runs:
 *   - capture active            → both halt with `'capture-active'`;
 *   - capture off + an unlocked
 *     pending recording          → both halt with `'pending-actions-unprotected'`;
 *   - capture off + every pending
 *     recording locked           → both proceed and the locked set is excluded.
 *
 * Each "trigger" gets its OWN fresh store seeded identically (the first cycle
 * mutates its store, so a shared store would not be a fair identical-input
 * comparison) and its own freshly-installed `fetch` double. The fetch double
 * mirrors `sync-client.test.js` and serves fixed payloads, so both triggers see
 * identical server responses.
 *
 * Uses the Node.js built-in test runner + fast-check (v4: `fc.uuid({ version: 7 })`
 * supplies a project id passing the manifest's UUIDv7 guard; `fc.uuid()` supplies
 * recording ids).
 *
 * **Validates: Requirements 15.3**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 29: Gating is identical for manual and automatic triggers

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
 * project_id. The mock holds no server-side state (a PUT just returns 200), so
 * two cycles run back-to-back against it see identical responses.
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
 * In-memory {@link SyncStore} seeded with an initial SyncState (the baseline).
 * Captures the last saved state so the test can compare the two triggers'
 * resulting Review / Conflict keys. Clones in and out so no reference is shared.
 *
 * @param {import('../../sync-types.js').SyncState} initial
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
  };
}

/**
 * A {@link LiveState} reporting the generated gating conditions verbatim: the
 * capture-active flag, the locked-recording set, and the pending-actions set.
 * These are the ONLY signals the pre-flight gate reads, so generating them
 * freely lets a single property cover every gating regime.
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

/** A validator that accepts every payload. */
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
    },
    recordings: (project.recordings ?? []).map(recordingProjection),
  };
}

/**
 * Normalize a recording into a plain, allowlisted object. fast-check builds
 * records with a `null` prototype and may produce keys in any order; a JSON
 * round-trip yields plain objects matching the real on-the-wire / in-store data
 * path so comparisons line up.
 */
function cleanRecording({ recording_id, name, created_at, steps }) {
  return JSON.parse(JSON.stringify({ recording_id, name, created_at, steps }));
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

/** Every reconciliation fate a recording can take this cycle. */
const FATES = ['changed', 'diverged', 'converged', 'brandnew'];

/**
 * One recording spec: a stable identity (`recording_id`, `created_at`), a shared
 * committed `steps` history reused across its versions, the FATE that decides how
 * its local/incoming/baseline versions relate, and two independent live-work
 * flags (`locked`, `pending`) so the gating signals are unconstrained.
 */
const arbRecSpec = fc.record({
  recording_id: fc.uuid(),
  created_at: arbIso,
  steps: fc.array(arbStep, { maxLength: 3 }),
  fate: fc.constantFrom(...FATES),
  locked: fc.boolean(),
  pending: fc.boolean(),
});

/**
 * A scenario: one existing project plus 1..6 recordings with unique ids and
 * mixed fates, an arbitrary capture-active flag, and per-recording locked/pending
 * flags. Nothing is constrained, so across runs all three gating regimes
 * (capture halt, pending-unprotected halt, proceed-with-exclusion) occur.
 */
const arbScenario = fc
  .record({
    project_id: fc.uuid({ version: 7 }),
    created_at: arbIso,
    captureActive: fc.boolean(),
    recordings: fc.uniqueArray(arbRecSpec, {
      selector: (r) => r.recording_id,
      minLength: 1,
      maxLength: 6,
    }),
  })
  .map(({ project_id, created_at, captureActive, recordings }) =>
    materialize(project_id, created_at, captureActive, recordings),
  );

/**
 * Materialize a scenario into the inputs `sync()` needs. Versions of one
 * recording share its identity and steps and differ only by a content marker
 * carried in `name` — the digest folds name into content identity (R2.8), so a
 * marker change is an ordinary content change.
 *
 *   marker 'base' — the agreed (baseline) content
 *   marker 'loc'  — a local-side change
 *   marker 'srv'  — a server-side change
 *   marker 'same' — converged (identical on both sides)
 *   marker 'new'  — a brand-new server-only recording
 */
function materialize(project_id, created_at, captureActive, recs) {
  const PROJECT_NAME = 'Project';
  const localRecs = [];
  const serverRecs = [];
  const baselineRecs = [];
  const locked = [];
  const pending = [];

  const ver = (rid, ca, marker, steps) =>
    cleanRecording({ recording_id: rid, name: marker, created_at: ca, steps });

  for (const r of recs) {
    const { recording_id: rid, created_at: ca, steps, fate } = r;
    if (r.locked) locked.push(rid);
    if (r.pending) pending.push(rid);

    switch (fate) {
      case 'changed': {
        localRecs.push(ver(rid, ca, 'base', steps));
        serverRecs.push(ver(rid, ca, 'srv', steps));
        baselineRecs.push(ver(rid, ca, 'base', steps));
        break;
      }
      case 'diverged': {
        localRecs.push(ver(rid, ca, 'loc', steps));
        serverRecs.push(ver(rid, ca, 'srv', steps));
        baselineRecs.push(ver(rid, ca, 'base', steps));
        break;
      }
      case 'converged': {
        localRecs.push(ver(rid, ca, 'same', steps));
        serverRecs.push(ver(rid, ca, 'same', steps));
        baselineRecs.push(ver(rid, ca, 'same', steps));
        break;
      }
      case 'brandnew': {
        // Present only on the server; absent locally and from the baseline.
        serverRecs.push(ver(rid, ca, 'new', steps));
        break;
      }
      default:
        break;
    }
  }

  const meta = { project_id, name: PROJECT_NAME, created_at };
  return {
    project_id,
    captureActive,
    locked,
    pending,
    localProject: { ...meta, recordings: localRecs },
    serverProject: { ...meta, recordings: serverRecs },
    agreedProject: { ...meta, recordings: baselineRecs },
  };
}

/**
 * Run ONE sync cycle for the scenario with a fresh store + fetch double. This is
 * the single shared code path both "manual" and "automatic" triggers exercise —
 * there is no trigger argument, so a run is fully determined by the (identical)
 * inputs. Returns the gating-relevant outcome plus the resulting store keys.
 *
 * @param {ReturnType<typeof materialize>} scenario
 */
async function runCycle(scenario) {
  const { project_id, captureActive, locked, pending, localProject, serverProject, agreedProject } =
    scenario;

  // Fresh baseline seed per run — the first cycle would otherwise mutate a
  // shared store and break the identical-input premise.
  const seed = createEmptySyncState();
  advanceBaseline(seed, project_id, projectProjection(agreedProject));
  const store = makeStore(seed);

  installMockFetch(
    [{ project_id, name: localProject.name }],
    new Map([[project_id, buildPayload(serverProject)]]),
  );

  const { result, projects } = await sync(
    'https://srv.test',
    null,
    [localProject],
    STUB_SCHEMA,
    passValidator,
    store,
    makeLiveState({ captureActive, locked, pending }),
  );

  const state = store.getState();
  return {
    halted: result.halted,
    haltReason: result.haltReason,
    review: [...result.review].sort(),
    conflicts: [...result.conflicts].sort(),
    // Merged projects are built from fixed local/incoming projections (no clocks),
    // so their JSON is a stable, trigger-independent fingerprint of the merge.
    mergedJson: JSON.stringify(projects),
    // Store keys are clock-free; the timestamps inside items are not compared.
    reviewKeys: state ? Object.keys(state.reviews).sort() : [],
    conflictKeys: state ? Object.keys(state.conflicts).sort() : [],
  };
}

// ─── Property 29 ──────────────────────────────────────────────────────────────

describe('Property 29: Gating is identical for manual and automatic triggers', () => {
  it('two identical-input cycles (manual vs automatic) gate identically', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        // "Manual" and "automatic" are two invocations of the same single code
        // path with byte-identical inputs; sync() takes no trigger argument.
        const manual = await runCycle(scenario);
        const automatic = await runCycle(scenario);

        // ── Capture_Active halt + pending-actions halt: identical gating ──
        assert.equal(
          manual.halted,
          automatic.halted,
          'halted must be identical regardless of trigger',
        );
        assert.equal(
          manual.haltReason,
          automatic.haltReason,
          'haltReason must be identical regardless of trigger',
        );

        // ── Locked_Recording exclusion: identical reconciliation outcome ──
        // When a cycle proceeds, the same recordings are excluded from the merge
        // and the same deferrals are produced for both triggers; when it halts,
        // both produce empty sets and the untouched local projects.
        assert.deepEqual(
          manual.review,
          automatic.review,
          'reported review set is trigger-independent',
        );
        assert.deepEqual(
          manual.conflicts,
          automatic.conflicts,
          'reported conflict set is trigger-independent',
        );
        assert.deepEqual(
          manual.reviewKeys,
          automatic.reviewKeys,
          'stored Review keys are trigger-independent',
        );
        assert.deepEqual(
          manual.conflictKeys,
          automatic.conflictKeys,
          'stored Conflict keys are trigger-independent',
        );
        assert.equal(
          manual.mergedJson,
          automatic.mergedJson,
          'the merged projects (locked exclusion applied) are trigger-independent',
        );

        // ── Gating regime sanity: the generated conditions imply the outcome ──
        const lockedSet = new Set(scenario.locked);
        const hasUnprotectedPending = scenario.pending.some((rid) => !lockedSet.has(rid));
        if (scenario.captureActive) {
          assert.equal(manual.haltReason, 'capture-active', 'capture-active dominates the gate');
          assert.equal(manual.halted, true);
        } else if (hasUnprotectedPending) {
          assert.equal(
            manual.haltReason,
            'pending-actions-unprotected',
            'an unlocked pending recording halts the cycle',
          );
          assert.equal(manual.halted, true);
        } else {
          assert.equal(manual.halted, false, 'with no live-work blockers the cycle proceeds');
          assert.equal(manual.haltReason, null);
          // Whatever was deferred, no LOCKED recording may leak into a deferral —
          // the exclusion held for this (proceeding) cycle, identically for both.
          for (const rid of scenario.locked) {
            const unitRef = `${scenario.project_id}:${rid}`;
            assert.ok(!manual.review.includes(unitRef), 'locked recording never offered as Review');
            assert.ok(
              !manual.conflicts.includes(unitRef),
              'locked recording never recorded as Conflict',
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ──────────────────────────────────────

  const PID = '018f0000-0000-7000-8000-000000000020';

  function rec(recording_id, name) {
    return {
      recording_id,
      name,
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }],
    };
  }

  /** Build a minimal scenario object accepted by runCycle(). */
  function scenarioOf({ captureActive, locked, pending, localRecs, serverRecs, baselineRecs }) {
    const meta = { project_id: PID, name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    return {
      project_id: PID,
      captureActive,
      locked,
      pending,
      localProject: { ...meta, recordings: localRecs },
      serverProject: { ...meta, recordings: serverRecs },
      agreedProject: { ...meta, recordings: baselineRecs },
    };
  }

  it('capture active: both triggers halt identically with capture-active', async () => {
    const scenario = scenarioOf({
      captureActive: true,
      locked: [],
      pending: ['018f0000-0000-7000-8000-0000000000a1'],
      localRecs: [rec('018f0000-0000-7000-8000-0000000000a1', 'base')],
      serverRecs: [rec('018f0000-0000-7000-8000-0000000000a1', 'srv')],
      baselineRecs: [rec('018f0000-0000-7000-8000-0000000000a1', 'base')],
    });

    const manual = await runCycle(scenario);
    const automatic = await runCycle(scenario);

    assert.equal(manual.haltReason, 'capture-active');
    assert.equal(automatic.haltReason, 'capture-active');
    assert.equal(manual.halted, automatic.halted);
    assert.deepEqual(manual.review, automatic.review);
    assert.deepEqual(manual.conflicts, automatic.conflicts);
    assert.equal(manual.mergedJson, automatic.mergedJson);
  });

  it('unlocked pending: both triggers halt identically with pending-actions-unprotected', async () => {
    const REC = '018f0000-0000-7000-8000-0000000000b1';
    const scenario = scenarioOf({
      captureActive: false,
      locked: [], // pending recording is NOT locked → unprotected
      pending: [REC],
      localRecs: [rec(REC, 'base')],
      serverRecs: [rec(REC, 'srv')],
      baselineRecs: [rec(REC, 'base')],
    });

    const manual = await runCycle(scenario);
    const automatic = await runCycle(scenario);

    assert.equal(manual.haltReason, 'pending-actions-unprotected');
    assert.equal(automatic.haltReason, 'pending-actions-unprotected');
    assert.equal(manual.halted, automatic.halted);
    assert.deepEqual(manual.conflicts, automatic.conflicts);
    assert.equal(manual.mergedJson, automatic.mergedJson);
  });

  it('proceeding cycle: locked exclusion + deferrals are identical for both triggers', async () => {
    const LOCKED = '018f0000-0000-7000-8000-0000000000c1';
    const OPEN = '018f0000-0000-7000-8000-0000000000c2';
    // Both changed on the server; LOCKED is open in the Recording_View so it is
    // excluded, while OPEN becomes a Review — identically for both triggers.
    const scenario = scenarioOf({
      captureActive: false,
      locked: [LOCKED],
      pending: [], // nothing unprotected → the cycle proceeds
      localRecs: [rec(LOCKED, 'base'), rec(OPEN, 'base')],
      serverRecs: [rec(LOCKED, 'srv'), rec(OPEN, 'srv')],
      baselineRecs: [rec(LOCKED, 'base'), rec(OPEN, 'base')],
    });

    const manual = await runCycle(scenario);
    const automatic = await runCycle(scenario);

    assert.equal(manual.halted, false);
    assert.equal(automatic.halted, false);
    // Only the non-locked recording is offered as a Review, for both triggers.
    assert.deepEqual(manual.review, [`${PID}:${OPEN}`]);
    assert.deepEqual(manual.review, automatic.review);
    assert.deepEqual(manual.reviewKeys, automatic.reviewKeys);
    assert.ok(!manual.review.includes(`${PID}:${LOCKED}`), 'locked recording excluded');
    assert.equal(manual.mergedJson, automatic.mergedJson, 'identical merge for both triggers');
  });
});
