/**
 * fast-forward-superset.property.test.js — Property test that an auto-applied
 * fast-forward requires an append-only superset (Property 42, R1 / task 22.17).
 *
 * Auto-Accept-Updates is a POLICY preference that lets the orchestrator adopt an
 * incoming change to a recording the user has NOT themselves touched (local ==
 * baseline) WITHOUT a Review — but ONLY when the adoption is provably lossless: a
 * true **fast-forward**, where the incoming version is an append-only superset of
 * the Sync_Baseline (it RETAINS every committed step record present in the
 * baseline and merely adds more). A non-superset incoming version — history
 * rewritten, or a committed step record dropped — is surprising enough that it is
 * STILL held for Review even with the toggle ON, because silently adopting it
 * could discard a committed record (R4.2, R4.3, R22.4).
 *
 * This property drives the FULL `sync()` orchestrator with Auto-Accept-Updates
 * ON over a large space of `changed-incoming` recordings, each of which is EITHER
 * a clean fast-forward (incoming retains every baseline step uuid, plus appends
 * ≥1 new one) OR a non-fast-forward (incoming DROPS a baseline step uuid). For
 * every generated cycle it pins the exact split:
 *
 *   - `result.autoAppliedUpdates` = EXACTLY the append-only-superset unitRefs, and
 *     nothing else — a non-superset is never auto-applied (R4.2, R22.4);
 *   - `result.review` = EXACTLY the non-superset unitRefs — held for Review even
 *     though the toggle is ON (R4.3); and
 *   - `result.conflicts` = ∅ — a local-unchanged incoming change is never a
 *     Conflict.
 *
 * For each auto-applied (superset) recording the merged local recording equals
 * the incoming version and that recording's per-project baseline entry advances
 * to it; for each deferred (non-superset) recording the merged local recording is
 * left byte-identical, a PENDING Review retains the incoming version, and that
 * recording's baseline entry is UNCHANGED — proving the incoming change was not
 * adopted. Converged siblings stay byte-identical and are never auto-applied,
 * reviewed, or conflicted, proving the split is scoped to the changed recordings.
 *
 * The file also directly unit-tests the exported `isAppendOnlySuperset` predicate
 * — the single source of truth the orchestrator's gate consults — proving its
 * defining property: a candidate is a superset of a base IFF it retains every
 * step-record uuid present in the base, across both recording- and project-level
 * UnitCopies, with a null/absent base treated as having no records (anything is a
 * superset of nothing).
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling property
 * tests (`makeResponse`-style stubs dispatched per project_id; PUT → 200), the
 * validator passes, an in-memory `SyncStore` (seeded with the agreed baselines
 * AND `autoAcceptUpdates: true`) captures the saved `SyncState`, and a permissive
 * `LiveState` (capture inactive, nothing locked, nothing pending) lets the cycle
 * run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard; `fc.uuid()` supplies recording ids).
 *
 * **Validates: Requirements 4.2, 4.3, 22.4**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 42: Auto-applied fast-forward requires an append-only superset

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { isAppendOnlySuperset } from '../../conflict-resolution.js';
import { digestRecording } from '../../sync-digest.js';
import { createEmptySyncState, setSettings } from '../../sync-store.js';
import { advanceBaseline, getBaseline, getRecordingBaselineDigest } from '../../sync-baseline.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

const SERVER = 'https://srv.test';

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
 * by project_id:
 *   - PUT (push)        → 200 (the push phase always succeeds).
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
 * In-memory {@link SyncStore} seeded with an initial SyncState; captures the last
 * saved state so the test can inspect reviews/conflicts/baselines after the cycle.
 * Clones on the way in and out so no reference is shared with the cycle.
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

/** Permissive {@link LiveState}: capture inactive, nothing locked, nothing pending. */
function makeLiveState() {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (the fast-forward gate, not validation, is the focus). */
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

/**
 * JSON-normalize a recording spec into the allowlisted shape with plain-object
 * (not null-prototype) step records. In production every recording crosses JSON
 * on the wire and in the store, so this matches the real data path and keeps the
 * deep-equality comparisons aligned with the values the store/baseline/pull-path
 * produce.
 *
 * @param {{recording_id: string, name: string, created_at: string, steps: object[]}} spec
 */
function cleanRecording({ recording_id, name, created_at, steps }) {
  return JSON.parse(JSON.stringify({ recording_id, name, created_at, steps }));
}

/** Deep, JSON-normalized copy — matches the deep clone the store/baseline apply. */
function cleanCopy(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

/**
 * A committed step record built deterministically from a prefix + integer key.
 * The two prefixes keep uuid namespaces disjoint: `b-*` are the baseline/local
 * step records and `x-*` are the incoming-only appended records. So an
 * append-only fast-forward can REUSE the baseline keys (retaining every `b-*`
 * uuid) and append `x-*` records that are provably disjoint from the baseline,
 * while a non-fast-forward provably removes a `b-*` uuid by DROPPING a baseline
 * key from the incoming set.
 *
 * @param {'b'|'x'} prefix
 * @param {number} key
 */
function stepFromKey(prefix, key) {
  return {
    uuid: `${prefix}-${key}`,
    logical_id: ['a', 'b', 'c'][key % 3],
    step_number: key,
    deleted: false,
  };
}

/**
 * One append-only-superset (fast-forward) recording spec. The local/baseline side
 * carries `baseKeys` (≥0). The incoming side RETAINS every baseline record and
 * appends `extraKeys` (≥1, disjoint `x-*` uuids) — so it is an append-only
 * superset that nonetheless differs from the baseline (it has ≥1 step the
 * baseline lacks), guaranteeing a `changed-incoming` classification that the
 * toggle-ON gate must auto-apply (R4.2, R22.4).
 */
const arbSupersetRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  name: fc.string({ maxLength: 12 }),
  created_at: arbIso,
  baseKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 4 }),
  extraKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 3 }),
});

/**
 * One NON-superset (history-dropping) recording spec. The local/baseline side
 * carries `baseKeys` (≥1, so a baseline record can always be dropped). The
 * incoming side drops the FIRST baseline record and appends `extraKeys` (≥0,
 * disjoint `x-*` uuids) — so it is NOT an append-only superset of the baseline
 * and must be held for Review even with the toggle ON (R4.3).
 */
const arbNonSupersetRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  name: fc.string({ maxLength: 12 }),
  created_at: arbIso,
  baseKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 4 }),
  extraKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
});

/** One `converged` recording spec (local == incoming, byte-identical, untouched). */
const arbConvergedRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  name: fc.string({ maxLength: 12 }),
  created_at: arbIso,
  keys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
});

/**
 * One project spec: present on both sides with identical project metadata, with
 * ≥1 superset recording AND ≥1 non-superset recording so a single cycle exercises
 * both arms of the gate, plus optional converged siblings.
 */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  name: fc.string({ maxLength: 12 }),
  created_at: arbIso,
  superset: fc.uniqueArray(arbSupersetRecordingSpec, {
    selector: (r) => r.recording_id,
    minLength: 1,
    maxLength: 3,
  }),
  nonSuperset: fc.uniqueArray(arbNonSupersetRecordingSpec, {
    selector: (r) => r.recording_id,
    minLength: 1,
    maxLength: 3,
  }),
  converged: fc.uniqueArray(arbConvergedRecordingSpec, {
    selector: (r) => r.recording_id,
    minLength: 0,
    maxLength: 2,
  }),
});

/**
 * A scenario: 1..3 projects with unique ids. `autoAcceptDeletions` is threaded
 * purely to show it never matters here (no deletions are generated);
 * `autoAcceptUpdates` is forced ON in `materialize` because it is the precondition
 * of Property 42.
 */
const arbScenario = fc.record({
  autoAcceptDeletions: fc.boolean(),
  projects: fc.uniqueArray(arbProjectSpec, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 3,
  }),
});

/**
 * Materialize a scenario into the inputs `sync()` needs plus the derived
 * expectations:
 *   - `localProjects` — each project at its baseline state (local == baseline for
 *     every recording);
 *   - the server view — each project with its superset recordings moved to an
 *     append-only superset and its non-superset recordings moved to a
 *     history-dropping (non-superset) version, converged siblings unchanged;
 *   - `seed` — a SyncState whose per-project baseline equals the local project AND
 *     whose settings carry `autoAcceptUpdates: true` so the toggle-ON gate runs.
 *
 * Project metadata is identical across local/incoming/baseline, so the
 * project-metadata Unit converges and only the recording changes drive the gate.
 */
function materialize(scenario) {
  const localProjects = [];
  const manifest = [];
  const payloadById = new Map();
  const seed = createEmptySyncState();
  const expectations = [];

  for (const s of scenario.projects) {
    const localRecs = [];
    const incomingRecs = [];
    const supersetRefs = []; // { recording_id, unitRef, expectedLocal, expectedIncoming }
    const nonSupersetRefs = []; // { recording_id, unitRef, expectedLocal, expectedIncoming }
    const convergedIds = [];
    const usedIds = new Set();

    // ── append-only-superset (fast-forward) recordings ──
    for (const r of s.superset) {
      usedIds.add(r.recording_id);
      const baseSteps = r.baseKeys.map((k) => stepFromKey('b', k));
      const extraSteps = r.extraKeys.map((k) => stepFromKey('x', k));

      const local = cleanRecording({
        recording_id: r.recording_id,
        name: `ff-${r.name}`,
        created_at: r.created_at,
        steps: baseSteps,
      });
      // Incoming RETAINS every baseline step record and appends ≥1 new one → a
      // true append-only superset that still differs from the baseline.
      const incoming = cleanRecording({
        recording_id: r.recording_id,
        name: `ff-${r.name}`,
        created_at: r.created_at,
        steps: [...baseSteps, ...extraSteps],
      });

      localRecs.push(local);
      incomingRecs.push(incoming);
      supersetRefs.push({
        recording_id: r.recording_id,
        unitRef: `${s.project_id}:${r.recording_id}`,
        expectedLocal: cleanCopy(recordingProjection(local)),
        expectedIncoming: cleanCopy(recordingProjection(incoming)),
      });
    }

    // ── non-superset (history-dropping) recordings ──
    for (const r of s.nonSuperset) {
      if (usedIds.has(r.recording_id)) continue; // id already owned by a superset rec
      usedIds.add(r.recording_id);
      const baseSteps = r.baseKeys.map((k) => stepFromKey('b', k));
      const extraSteps = r.extraKeys.map((k) => stepFromKey('x', k));

      const local = cleanRecording({
        recording_id: r.recording_id,
        name: `nf-${r.name}`,
        created_at: r.created_at,
        steps: baseSteps,
      });
      // Incoming DROPS the first baseline step record (and may append disjoint
      // `x-*` records) → NOT an append-only superset of the baseline.
      const incoming = cleanRecording({
        recording_id: r.recording_id,
        name: `nf-${r.name}`,
        created_at: r.created_at,
        steps: [...baseSteps.slice(1), ...extraSteps],
      });

      localRecs.push(local);
      incomingRecs.push(incoming);
      nonSupersetRefs.push({
        recording_id: r.recording_id,
        unitRef: `${s.project_id}:${r.recording_id}`,
        expectedLocal: cleanCopy(recordingProjection(local)),
        expectedIncoming: cleanCopy(recordingProjection(incoming)),
      });
    }

    // ── converged siblings (identical on every side) ──
    for (const r of s.converged) {
      if (usedIds.has(r.recording_id)) continue;
      usedIds.add(r.recording_id);
      const rec = cleanRecording({
        recording_id: r.recording_id,
        name: `cv-${r.name}`,
        created_at: r.created_at,
        steps: r.keys.map((k) => stepFromKey('b', k)),
      });
      localRecs.push(rec);
      incomingRecs.push(cleanRecording(rec)); // independent byte-identical clone
      convergedIds.push(r.recording_id);
    }

    const localProject = {
      project_id: s.project_id,
      name: `proj-${s.name}`,
      created_at: s.created_at,
      recordings: localRecs,
    };
    const incomingProject = {
      project_id: s.project_id,
      name: `proj-${s.name}`,
      created_at: s.created_at,
      recordings: incomingRecs,
    };

    localProjects.push(localProject);
    payloadById.set(s.project_id, buildPayload(incomingProject));
    manifest.push({ project_id: s.project_id, name: incomingProject.name });

    // Baseline == the local project, so local == baseline for every recording.
    advanceBaseline(seed, s.project_id, projectProjection(localProject));

    expectations.push({
      project_id: s.project_id,
      supersetRefs,
      nonSupersetRefs,
      convergedIds,
    });
  }

  // Property 42 precondition: Auto-Accept-Updates ON.
  setSettings(seed, {
    autoAcceptUpdates: true,
    autoAcceptDeletions: scenario.autoAcceptDeletions,
  });

  return { localProjects, manifest, payloadById, seed, expectations };
}

// ─── Property 42 ──────────────────────────────────────────────────────────────

describe('Property 42: Auto-applied fast-forward requires an append-only superset', () => {
  it('with Auto-Accept-Updates ON, auto-applies ONLY the append-only-superset incoming versions and defers every non-superset to Review', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { localProjects, manifest, payloadById, seed, expectations } = materialize(scenario);
        installMockFetch(manifest, payloadById);

        const store = makeStore(seed);

        const { result, projects } = await sync(
          SERVER,
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );

        // A fast-forward auto-apply / deferral is never a halt.
        assert.equal(result.halted, false, 'a changed-incoming cycle never halts');
        assert.equal(result.haltReason, null);

        const state = store.getState();
        const byId = new Map(projects.map((p) => [p.project_id, p]));

        // The settings-invariant expected split across the whole scenario.
        const allSupersetRefs = expectations.flatMap((e) => e.supersetRefs.map((c) => c.unitRef));
        const allNonSupersetRefs = expectations.flatMap((e) =>
          e.nonSupersetRefs.map((c) => c.unitRef),
        );

        // ── The CORE of Property 42 (R4.2, R4.3, R22.4): with the toggle ON, the
        //    auto-applied set is EXACTLY the append-only-superset units, and the
        //    review set is EXACTLY the non-superset units. ──
        assert.deepEqual(
          new Set(result.autoAppliedUpdates),
          new Set(allSupersetRefs),
          'auto-applied updates are exactly the append-only-superset units',
        );
        assert.equal(
          result.autoAppliedUpdates.length,
          allSupersetRefs.length,
          'no duplicate auto-applied unitRefs',
        );
        assert.deepEqual(
          new Set(result.review),
          new Set(allNonSupersetRefs),
          'review holds exactly the non-superset units (deferred even with the toggle ON)',
        );
        assert.equal(
          result.review.length,
          allNonSupersetRefs.length,
          'no duplicate review unitRefs',
        );

        // A local-unchanged incoming change is never a Conflict, and never an
        // auto-applied deletion (none are generated).
        assert.deepEqual(
          result.conflicts,
          [],
          'no conflicts for a local-unchanged incoming change',
        );
        assert.deepEqual(Object.keys(state.conflicts ?? {}), [], 'no Conflict items recorded');
        assert.deepEqual(
          result.autoAppliedDeletions,
          [],
          'no deletion is auto-applied (none exist)',
        );

        // state.reviews holds exactly the non-superset units.
        assert.deepEqual(
          new Set(Object.keys(state.reviews ?? {})),
          new Set(allNonSupersetRefs),
          'state.reviews holds exactly the non-superset unitRefs',
        );

        for (const { project_id, supersetRefs, nonSupersetRefs, convergedIds } of expectations) {
          const merged = byId.get(project_id);
          assert.ok(merged, `project ${project_id} must still be present locally`);
          const mergedRec = (rid) => merged.recordings.find((r) => r.recording_id === rid);
          const baseline = getBaseline(state, project_id);
          assert.ok(baseline, `project ${project_id} keeps a baseline`);

          // ── Superset units: AUTO-APPLIED (R4.2, R22.4). ──
          for (const { recording_id, unitRef, expectedIncoming } of supersetRefs) {
            assert.ok(
              result.autoAppliedUpdates.includes(unitRef),
              `${unitRef} (append-only superset) is auto-applied`,
            );
            assert.ok(
              !(unitRef in (state.reviews ?? {})),
              'an auto-applied fast-forward has no Review item',
            );
            // The incoming version is adopted into the merged local data.
            assert.deepEqual(
              cleanCopy(recordingProjection(mergedRec(recording_id))),
              expectedIncoming,
              'the incoming fast-forward version is adopted into the merged list (R4.2)',
            );
            // The per-recording baseline entry advances to the incoming version.
            assert.equal(
              getRecordingBaselineDigest(baseline, recording_id),
              digestRecording(expectedIncoming),
              'the per-unit baseline advances to the auto-applied version (R4.2)',
            );
          }

          // ── Non-superset units: DEFERRED to Review even with the toggle ON. ──
          for (const {
            recording_id,
            unitRef,
            expectedLocal,
            expectedIncoming,
          } of nonSupersetRefs) {
            assert.ok(
              !result.autoAppliedUpdates.includes(unitRef),
              `${unitRef} (non-superset) is NOT auto-applied even with the toggle ON (R4.3)`,
            );
            const review = state.reviews?.[unitRef];
            assert.ok(review, `a Review item must exist for ${unitRef}`);
            assert.equal(review.kind, 'review');
            assert.equal(review.status, 'PENDING', 'a freshly-detected review is PENDING');
            assert.equal(review.project_id, project_id);
            assert.equal(review.recording_id, recording_id);
            assert.deepEqual(
              review.incoming,
              expectedIncoming,
              'the Review retains the incoming (non-superset) version',
            );
            assert.ok(
              !(unitRef in (state.conflicts ?? {})),
              'a deferred non-superset is a Review, never a Conflict',
            );
            // Local data is left byte-identical; the incoming change is not adopted.
            assert.deepEqual(
              cleanCopy(recordingProjection(mergedRec(recording_id))),
              expectedLocal,
              'the local recording is left byte-identical (incoming never applied, R9.5)',
            );
            // The per-recording baseline entry is UNCHANGED (still the local/agreed
            // version), proving the incoming change was not adopted.
            assert.equal(
              getRecordingBaselineDigest(baseline, recording_id),
              digestRecording(expectedLocal),
              'a deferred non-superset never advances its baseline entry',
            );
          }

          // ── Converged siblings are untouched and never deferred/auto-applied. ──
          for (const recId of convergedIds) {
            const rec = mergedRec(recId);
            assert.ok(rec, `converged recording ${recId} must remain`);
            const localRec = localProjects
              .find((p) => p.project_id === project_id)
              .recordings.find((r) => r.recording_id === recId);
            assert.deepEqual(rec, localRec, 'a converged sibling is left byte-identical');
            const ref = `${project_id}:${recId}`;
            assert.ok(
              !result.autoAppliedUpdates.includes(ref),
              'a converged sibling is not auto-applied',
            );
            assert.ok(!(ref in (state.reviews ?? {})), 'a converged sibling is not reviewed');
            assert.ok(!(ref in (state.conflicts ?? {})), 'a converged sibling is not conflicted');
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression example: toggle ON, append-only superset ────────
  // Auto-Accept-Updates is ON and the incoming version retains every baseline
  // step record and appends one → a true fast-forward, auto-applied (R4.2, R22.4).

  it('toggle ON: an append-only superset is auto-applied and advances the per-unit baseline', async () => {
    const ID = '018f0000-0000-7000-8000-000000000001';
    const REC = '018f0000-0000-7000-8000-0000000000a1';
    const SIB = '018f0000-0000-7000-8000-0000000000a2';

    const localRec = {
      recording_id: REC,
      name: 'rec',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'b-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    // Server APPENDED a committed step (retains b-1) → append-only superset.
    const incomingRec = {
      recording_id: REC,
      name: 'rec',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { uuid: 'b-1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'x-1', logical_id: 'a', step_number: 1, deleted: false },
      ],
    };
    const sibling = {
      recording_id: SIB,
      name: 'sib',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'b-9', logical_id: 'b', step_number: 0, deleted: false }],
    };

    const localProject = {
      project_id: ID,
      name: 'Project',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [localRec, sibling],
    };
    const incomingProject = { ...localProject, recordings: [incomingRec, sibling] };

    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(localProject));
    setSettings(seed, { autoAcceptUpdates: true, autoAcceptDeletions: false });

    installMockFetch(
      [{ project_id: ID, name: 'Project' }],
      new Map([[ID, buildPayload(incomingProject)]]),
    );

    const store = makeStore(seed);
    const { result, projects } = await sync(
      SERVER,
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    const unitRef = `${ID}:${REC}`;
    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.review, [], 'a fast-forward is not reviewed');
    assert.deepEqual(result.autoAppliedUpdates, [unitRef], 'the fast-forward is auto-applied');

    const state = store.getState();
    assert.equal(state.reviews?.[unitRef], undefined, 'no Review item for an auto-applied update');

    // The incoming version is adopted; the sibling is untouched.
    const merged = projects.find((p) => p.project_id === ID);
    assert.deepEqual(
      merged.recordings.find((r) => r.recording_id === REC),
      recordingProjection(incomingRec),
    );
    assert.deepEqual(
      merged.recordings.find((r) => r.recording_id === SIB),
      recordingProjection(sibling),
    );

    // The per-unit baseline advanced to the incoming version; the sibling's entry
    // is unchanged.
    const baseline = getBaseline(state, ID);
    assert.equal(
      getRecordingBaselineDigest(baseline, REC),
      digestRecording(recordingProjection(incomingRec)),
    );
    assert.equal(
      getRecordingBaselineDigest(baseline, SIB),
      digestRecording(recordingProjection(sibling)),
    );
  });

  // ── Deterministic regression example: toggle ON, non-superset incoming ───────
  // Auto-Accept-Updates is ON, but the incoming version DROPS a committed step
  // record present in the baseline, so it is not an append-only superset and is
  // held for Review rather than auto-applied (R4.3, R22.4).

  it('toggle ON: a non-superset (history-dropping) incoming change is held for Review, baseline unchanged', async () => {
    const ID = '018f0000-0000-7000-8000-000000000011';
    const REC = '018f0000-0000-7000-8000-0000000000b1';

    const localRec = {
      recording_id: REC,
      name: 'rec',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { uuid: 'b-1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'b-2', logical_id: 'a', step_number: 1, deleted: false },
      ],
    };
    // Server REWROTE history: b-1 is dropped, x-1 added → NOT a superset.
    const incomingRec = {
      recording_id: REC,
      name: 'rec',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { uuid: 'b-2', logical_id: 'a', step_number: 1, deleted: false },
        { uuid: 'x-1', logical_id: 'a', step_number: 2, deleted: false },
      ],
    };

    const localProject = {
      project_id: ID,
      name: 'Project',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [localRec],
    };
    const incomingProject = { ...localProject, recordings: [incomingRec] };

    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(localProject));
    setSettings(seed, { autoAcceptUpdates: true, autoAcceptDeletions: true });
    const baselineDigestBefore = getRecordingBaselineDigest(getBaseline(seed, ID), REC);

    installMockFetch(
      [{ project_id: ID, name: 'Project' }],
      new Map([[ID, buildPayload(incomingProject)]]),
    );

    const store = makeStore(seed);
    const { result, projects } = await sync(
      SERVER,
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    const unitRef = `${ID}:${REC}`;
    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(
      result.autoAppliedUpdates,
      [],
      'a non-superset change is NOT auto-applied even with the toggle ON (R4.3)',
    );
    assert.deepEqual(result.review, [unitRef], 'the non-superset change is reviewed');

    const state = store.getState();
    const review = state.reviews[unitRef];
    assert.equal(review.kind, 'review');
    assert.equal(review.status, 'PENDING');
    assert.deepEqual(review.incoming, recordingProjection(incomingRec));

    // Local recording byte-identical; baseline entry unchanged.
    const merged = projects.find((p) => p.project_id === ID);
    assert.deepEqual(
      merged.recordings.find((r) => r.recording_id === REC),
      recordingProjection(localRec),
    );
    assert.equal(getRecordingBaselineDigest(getBaseline(state, ID), REC), baselineDigestBefore);
  });
});

// ─── isAppendOnlySuperset predicate (direct unit + property coverage) ─────────
// The exported predicate is the single source of truth the toggle-ON gate
// consults. Its defining property: a candidate is a superset of a base IFF it
// retains every step-record uuid present in the base.

/** Build a recording-level UnitCopy whose steps carry exactly the given uuids. */
function recordingWithUuids(uuids) {
  return {
    recording_id: 'r',
    name: 'r',
    created_at: '2026-01-01T00:00:00.000Z',
    steps: uuids.map((u, i) => ({ uuid: u, logical_id: 'a', step_number: i, deleted: false })),
  };
}

/**
 * Build a project-level UnitCopy that SPREADS the given uuids across two
 * recordings, so the predicate's project-level uuid collection (which flattens
 * across recordings) is exercised, not just the single-recording path.
 */
function projectWithUuids(uuids) {
  const half = Math.ceil(uuids.length / 2);
  return {
    project_id: 'p',
    name: 'p',
    created_at: '2026-01-01T00:00:00.000Z',
    recordings: [recordingWithUuids(uuids.slice(0, half)), recordingWithUuids(uuids.slice(half))],
  };
}

describe('isAppendOnlySuperset: a candidate is a superset iff it retains every base step uuid', () => {
  it('holds for arbitrary base/candidate uuid sets (recording- and project-level)', () => {
    const arbUuids = fc.uniqueArray(
      fc.integer({ min: 0, max: 40 }).map((n) => `u-${n}`),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(arbUuids, arbUuids, fc.boolean(), (baseUuids, candUuids, asProject) => {
        const baseSet = new Set(baseUuids);
        const candSet = new Set(candUuids);
        const expected = [...baseSet].every((u) => candSet.has(u));

        const base = asProject ? projectWithUuids(baseUuids) : recordingWithUuids(baseUuids);
        const candidate = asProject ? projectWithUuids(candUuids) : recordingWithUuids(candUuids);

        assert.equal(
          isAppendOnlySuperset(base, candidate),
          expected,
          'superset iff every base uuid is retained by the candidate',
        );
      }),
      { numRuns: 500 },
    );
  });

  it('a candidate retaining every base uuid (with extras) is a superset', () => {
    const base = recordingWithUuids(['b-1', 'b-2']);
    const candidate = recordingWithUuids(['b-1', 'b-2', 'x-1']);
    assert.equal(isAppendOnlySuperset(base, candidate), true);
  });

  it('a candidate that drops a base uuid is NOT a superset', () => {
    const base = recordingWithUuids(['b-1', 'b-2']);
    const candidate = recordingWithUuids(['b-2', 'x-1']);
    assert.equal(isAppendOnlySuperset(base, candidate), false);
  });

  it('an identical candidate is a (non-strict) superset', () => {
    const base = recordingWithUuids(['b-1', 'b-2']);
    assert.equal(isAppendOnlySuperset(base, recordingWithUuids(['b-1', 'b-2'])), true);
  });

  it('a null/absent base is treated as having no records (anything is a superset of nothing)', () => {
    assert.equal(isAppendOnlySuperset(null, recordingWithUuids(['x-1'])), true);
    assert.equal(isAppendOnlySuperset(undefined, recordingWithUuids([])), true);
    assert.equal(isAppendOnlySuperset(recordingWithUuids([]), null), true);
  });

  it('a non-empty base is never a subset of an empty/absent candidate', () => {
    const base = recordingWithUuids(['b-1']);
    assert.equal(isAppendOnlySuperset(base, recordingWithUuids([])), false);
    assert.equal(isAppendOnlySuperset(base, null), false);
  });
});
