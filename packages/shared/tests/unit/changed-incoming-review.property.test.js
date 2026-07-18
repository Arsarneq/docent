/**
 * changed-incoming-review.property.test.js — Property test that a recording
 * classified `changed-incoming` is DEFERRED to Review-and-Accept and is NEVER
 * auto-applied WHEN Auto-Accept-Updates is OFF, OR when it is ON but the incoming
 * version is NOT an append-only superset of the baseline (not a fast-forward).
 *
 * `changed-incoming` is the canonical "only the author can judge this" case: a
 * recording the user already has, whose LOCAL copy is unchanged since the last
 * mutually-agreed Sync_Baseline, while the SERVER copy moved. Whether such
 * an incoming change may be adopted automatically is a client-local POLICY
 * decision, applied by the orchestrator (the classifier stays settings-independent):
 *   - the incoming version is auto-applied ONLY when Auto-Accept-Updates is ON
 *     AND the incoming version is an append-only superset of the baseline — a
 *     true fast-forward that drops no committed step record; and
 *   - OTHERWISE — the toggle is OFF, or the incoming version is NOT a fast-forward
 *     (history was rewritten or step records were dropped) — the cycle must DEFER
 *     it to Review-and-Accept rather than apply it (the automatic/user-gated
 *     boundary).
 *
 * This property exercises exactly the DEFER branch. For every generated cycle it
 * holds the orchestrator to one of two settings/shape arms, both of which MUST
 * defer:
 *   - **toggle OFF** — Auto-Accept-Updates is OFF, so EVERY `changed-incoming`
 *     defers regardless of shape, INCLUDING an incoming version that IS a clean
 *     fast-forward (which would auto-apply were the toggle ON). This is what
 *     proves the toggle, not the shape, gates the OFF case.
 *   - **toggle ON, non-fast-forward** — Auto-Accept-Updates is ON, but the
 *     incoming version drops a committed step record present in the baseline, so
 *     it is NOT an append-only superset and is held for Review even with the
 *     setting ON.
 *
 * Concretely, under either arm the cycle:
 *   - places the incoming change in a durable Review-and-Accept item instead of
 *     applying it — the item is in `state.reviews` and its `unitRef` is
 *     reported in `result.review`;
 *   - reports NOTHING in `result.autoAppliedUpdates` (and nothing in
 *     `autoAppliedDeletions`): the change is provably never auto-applied;
 *   - leaves the LOCAL recording byte-identical in the merged-projects list (the
 *     incoming version is never written over local data); and
 *   - leaves the project's Sync_Baseline UNCHANGED (a deferral never advances the
 *     baseline — only confirmed agreement or adoption does), so the
 *     incoming change has provably not been adopted.
 *
 * The property drives the full `sync()` orchestrator (not the detector in
 * isolation) over a large input space. Each generated project is present on BOTH
 * sides with identical project metadata, carries at least one `changed-incoming`
 * recording (local == baseline, incoming differs), and optionally some
 * `converged` siblings (local == incoming). Converged siblings stay byte-identical
 * and are neither reviewed nor conflicted, proving the deferral is scoped to
 * exactly the changed recordings.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling property
 * tests (`makeResponse`-style stubs dispatched per project_id; PUT → 200), the
 * validator passes, an in-memory `SyncStore` (seeded with the agreed baselines
 * AND the chosen reconciliation-policy settings) captures the saved `SyncState`,
 * and a permissive `LiveState` (capture inactive, nothing locked, nothing
 * pending) lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4:
 * `fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Changed-incoming creates a Review item and never auto-applies (toggle OFF or non-fast-forward)

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { digestProject } from '../../sync-digest.js';
import { createEmptySyncState, setSettings, upsertReview } from '../../sync-store.js';
import { deriveIndicators } from '../../sync-conflict-ui.js';
import { advanceBaseline, getBaseline } from '../../sync-baseline.js';
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
 * In-memory {@link SyncStore} seeded with an initial SyncState; captures the
 * last saved state so the test can inspect reviews/conflicts/baselines after the
 * cycle. Clones on the way in and out so no reference is shared with the cycle.
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

/** A validator that accepts every payload (deferral, not validation, is the focus). */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── allowlisted projections (mirror sync-client.js exactly) ──────────────────
// The orchestrator lands incoming Units and baselines through these same
// allowlists, so the expected merged/review/baseline shapes are computed with
// identical projections.

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
 * Strip to the allowlisted recording shape and JSON-normalize it. fast-check
 * builds records with a `null` prototype and nested step records that
 * `deepStrictEqual` would treat as unequal to the JSON-cloned copies the
 * store/baseline/pull-path produce; in production every recording crosses JSON
 * on the wire and in the store, so this matches the real data path rather than
 * masking anything.
 *
 * @param {object} r
 */
function cleanRecording(r) {
  return JSON.parse(
    JSON.stringify({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      steps: r.steps ?? [],
    }),
  );
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

/**
 * Build a committed step record deterministically from a unique integer key and
 * a prefix. The SAME key+prefix always yields the SAME record, so an append-only
 * fast-forward (which RETAINS the exact baseline records and adds new ones) can
 * be assembled by REUSING the baseline's step keys, while the two prefixes (`b`
 * for baseline records, `x` for incoming-only records) guarantee the appended
 * records carry uuids disjoint from the baseline's — so dropping a baseline key
 * provably removes it from the incoming set (a true non-fast-forward).
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
 * One `changed-incoming` recording spec. The local/baseline side carries
 * `baseKeys` (≥1, so a non-fast-forward incoming can always be formed by dropping
 * one). `extraKeys` are appended-only records on the incoming side (disjoint
 * uuids). `changeMarker` is appended to the incoming name so the incoming version
 * is ALWAYS distinct from the baseline/local version (a guaranteed change, even
 * for a pure fast-forward). `fastForwardWhenOff` only matters when the toggle is
 * OFF: it picks whether the OFF-arm incoming is a clean fast-forward or a
 * history-dropping non-fast-forward (both must still defer).
 */
const arbChangedRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  name: fc.string({ maxLength: 12 }),
  created_at: arbIso,
  baseKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 4 }),
  extraKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
  changeMarker: fc.integer({ min: 1, max: 100000 }),
  fastForwardWhenOff: fc.boolean(),
});

/** One `converged` recording spec (local == incoming, byte-identical, untouched). */
const arbConvergedRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  name: fc.string({ maxLength: 12 }),
  created_at: arbIso,
  keys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
});

/** One project spec: present on both sides, with ≥1 changed-incoming recording. */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  name: fc.string({ maxLength: 12 }),
  created_at: arbIso,
  changed: fc.uniqueArray(arbChangedRecordingSpec, {
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
 * A scenario: the two reconciliation-policy toggles plus 1..3 projects with
 * unique ids. `autoAcceptUpdates` selects the property arm:
 *   - OFF → every changed-incoming defers regardless of shape (incl. fast-forward);
 *   - ON  → the incoming version is forced NON-fast-forward, so it still defers.
 * `autoAcceptDeletions` is threaded purely to show it never matters here (no
 * deletions are generated).
 */
const arbScenario = fc.record({
  autoAcceptUpdates: fc.boolean(),
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
 *   - `localProjects` — each project at its baseline state (every recording's
 *     local copy equals its agreed copy);
 *   - the server view — each project with its `changed-incoming` recordings moved
 *     (fast-forward when the toggle is OFF and the spec asks for it; otherwise a
 *     history-dropping non-fast-forward, which is ALWAYS used when the toggle is
 *     ON) and its `converged` recordings unchanged;
 *   - `seed` — a SyncState whose per-project baseline equals the local project
 *     (so local == baseline for every recording) AND whose settings carry the
 *     chosen toggles, so the orchestrator's settings-gated auto-apply is exercised.
 *
 * Every project keeps identical project metadata across local/incoming/baseline,
 * so the project-metadata Unit converges and the recording change alone drives
 * the classification.
 */
function materialize(scenario) {
  const toggle = scenario.autoAcceptUpdates;
  const localProjects = [];
  const manifest = [];
  const payloadById = new Map();
  const seed = createEmptySyncState();
  const expectations = [];

  for (const s of scenario.projects) {
    const localRecs = [];
    const incomingRecs = [];
    const changedRefs = []; // { recording_id, unitRef, expectedLocal, expectedIncoming }
    const convergedIds = [];
    const usedIds = new Set();

    for (const r of s.changed) {
      usedIds.add(r.recording_id);
      const baseSteps = r.baseKeys.map((k) => stepFromKey('b', k));
      const extraSteps = r.extraKeys.map((k) => stepFromKey('x', k));

      // A fast-forward is only permitted when the toggle is OFF (where it must
      // STILL defer). With the toggle ON we force a non-fast-forward (drop the
      // first baseline step record), so the change is held for Review.
      const makeFastForward = !toggle && r.fastForwardWhenOff;
      const incomingSteps = makeFastForward
        ? [...baseSteps, ...extraSteps] // retains every baseline record ⇒ superset
        : [...baseSteps.slice(1), ...extraSteps]; // drops base[0] ⇒ NOT a superset

      const base = cleanRecording({
        recording_id: r.recording_id,
        name: `rec-${r.name}`,
        created_at: r.created_at,
        steps: baseSteps,
      });
      // Incoming name carries a marker suffix, so it is ALWAYS distinct from the
      // baseline/local name → digestIncoming !== digestBaseline, even for
      // a pure fast-forward, while local stays byte-identical to baseline.
      const incoming = cleanRecording({
        recording_id: r.recording_id,
        name: `rec-${r.name}#${r.changeMarker}`,
        created_at: r.created_at,
        steps: incomingSteps,
      });

      localRecs.push(base);
      incomingRecs.push(incoming);
      changedRefs.push({
        recording_id: r.recording_id,
        unitRef: `${s.project_id}:${r.recording_id}`,
        expectedLocal: cleanRecording(base),
        expectedIncoming: recordingProjection(incoming),
      });
    }

    for (const r of s.converged) {
      // Skip a converged spec whose id collides with a changed recording (the two
      // arrays are generated independently); the changed one already owns the id.
      if (usedIds.has(r.recording_id)) continue;
      usedIds.add(r.recording_id);
      const base = cleanRecording({
        recording_id: r.recording_id,
        name: `rec-${r.name}`,
        created_at: r.created_at,
        steps: r.keys.map((k) => stepFromKey('b', k)),
      });
      localRecs.push(base);
      incomingRecs.push(cleanRecording(base)); // independent byte-identical clone
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
    const agreed = projectProjection(localProject);
    advanceBaseline(seed, s.project_id, agreed);

    expectations.push({
      project_id: s.project_id,
      baselineDigest: digestProject(agreed),
      changedRefs,
      convergedIds,
    });
  }

  // Seed the chosen reconciliation-policy settings into the persisted state.
  setSettings(seed, {
    autoAcceptUpdates: scenario.autoAcceptUpdates,
    autoAcceptDeletions: scenario.autoAcceptDeletions,
  });

  return { localProjects, manifest, payloadById, seed, expectations, toggle };
}

describe('Changed-incoming creates a Review item and never auto-applies (toggle OFF or non-fast-forward)', () => {
  it('defers every changed-incoming recording to a Review item, never auto-applies, keeps local byte-identical, and never advances the baseline', async () => {
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

        // The cycle runs to completion — a deferral is not a halt.
        assert.equal(result.halted, false, 'a changed-incoming cycle never halts');
        assert.equal(result.haltReason, null);

        const state = store.getState();
        const byId = new Map(projects.map((p) => [p.project_id, p]));

        // The set of all expected changed-incoming unitRefs across the scenario.
        const allChangedRefs = expectations.flatMap((e) => e.changedRefs.map((c) => c.unitRef));

        // ── NEVER auto-applied (the core of the revised property):
        //    a changed-incoming under toggle OFF, or a non-fast-forward under
        //    toggle ON, is deferred — nothing is reported as auto-applied. ──
        assert.deepEqual(
          result.autoAppliedUpdates,
          [],
          'no changed-incoming is auto-applied as a fast-forward update',
        );
        assert.deepEqual(
          result.autoAppliedDeletions,
          [],
          'no deletion is auto-applied (none are generated)',
        );

        // ── No Conflicts anywhere: a changed-incoming recording is a Review,
        //    never a Conflict. ──
        assert.deepEqual(result.conflicts, [], 'no conflict unitRefs reported');
        assert.deepEqual(
          Object.keys(state.conflicts ?? {}),
          [],
          'no Conflict items recorded for changed-incoming',
        );

        // ── result.review equals exactly the changed-incoming unitRefs. ──
        assert.deepEqual(
          new Set(result.review),
          new Set(allChangedRefs),
          'result.review is exactly the set of changed-incoming unitRefs',
        );
        assert.equal(
          result.review.length,
          allChangedRefs.length,
          'no duplicate review unitRefs are reported',
        );
        assert.deepEqual(
          new Set(Object.keys(state.reviews ?? {})),
          new Set(allChangedRefs),
          'state.reviews holds exactly the changed-incoming unitRefs',
        );

        for (const { project_id, baselineDigest, changedRefs, convergedIds } of expectations) {
          const merged = byId.get(project_id);
          assert.ok(merged, `project ${project_id} must still be present locally`);

          // ── each changed-incoming recording is placed in a PENDING
          //    Review-and-Accept item retaining the incoming version. ──
          for (const { recording_id, unitRef, expectedLocal, expectedIncoming } of changedRefs) {
            const review = state.reviews?.[unitRef];
            assert.ok(review, `a Review item must exist for ${unitRef}`);
            assert.equal(review.kind, 'review');
            assert.equal(review.status, 'PENDING', 'a freshly-detected review is PENDING');
            assert.equal(review.project_id, project_id);
            assert.equal(review.recording_id, recording_id);
            assert.ok(
              !(unitRef in (state.conflicts ?? {})),
              `${unitRef} must not also be a Conflict (mutual exclusion)`,
            );

            // The retained incoming version is the moved server recording:
            // the change is captured for review, not dropped.
            assert.deepEqual(
              review.incoming,
              expectedIncoming,
              'the Review retains the incoming (server) version',
            );

            // ── the merged LOCAL recording is byte-identical and
            //    the incoming change is NOT adopted. ──
            const mergedRec = merged.recordings.find((r) => r.recording_id === recording_id);
            assert.ok(mergedRec, `recording ${recording_id} must remain in the merged project`);
            assert.deepEqual(
              mergedRec,
              expectedLocal,
              'the local recording is left byte-identical (incoming never applied)',
            );
            assert.notDeepEqual(
              mergedRec,
              expectedIncoming,
              'the incoming change is NOT adopted into local data',
            );
          }

          // ── Converged siblings are untouched and never deferred. ──
          for (const recId of convergedIds) {
            const mergedRec = merged.recordings.find((r) => r.recording_id === recId);
            assert.ok(mergedRec, `converged recording ${recId} must remain`);
            const localRec = localProjects
              .find((p) => p.project_id === project_id)
              .recordings.find((r) => r.recording_id === recId);
            assert.deepEqual(mergedRec, localRec, 'a converged sibling is left byte-identical');
            const ref = `${project_id}:${recId}`;
            assert.ok(!(ref in (state.reviews ?? {})), 'a converged sibling is not reviewed');
            assert.ok(!(ref in (state.conflicts ?? {})), 'a converged sibling is not conflicted');
          }

          // ── a deferral never advances the baseline: it still
          //    equals the seeded agreed state, proving the incoming change has
          //    NOT been adopted. ──
          const baseline = getBaseline(state, project_id);
          assert.ok(baseline, `project ${project_id} keeps its baseline`);
          assert.equal(
            baseline.digest,
            baselineDigest,
            'the baseline is unchanged by a changed-incoming deferral',
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression example: toggle OFF, fast-forward incoming ──────
  // Auto-Accept-Updates is OFF, so even a clean append-only fast-forward (which
  // would auto-apply were the toggle ON) is deferred to Review.

  it('toggle OFF: an append-only fast-forward still becomes a PENDING Review, untouched local + baseline', async () => {
    const ID = '018f0000-0000-7000-8000-000000000001';
    const REC = '018f0000-0000-7000-8000-0000000000a1';
    const SIB = '018f0000-0000-7000-8000-0000000000a2';

    const localRec = {
      recording_id: REC,
      name: 'rec-local',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const sibling = {
      recording_id: SIB,
      name: 'rec-sib',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'x1', logical_id: 'b', step_number: 0, deleted: false }],
    };
    // Server moved REC by APPENDING a committed step (retains s1) → a true
    // fast-forward — and left SIB converged.
    const incomingRec = {
      recording_id: REC,
      name: 'rec-local',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { uuid: 's1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 's2', logical_id: 'a', step_number: 1, deleted: false },
      ],
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
    setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });
    const baselineDigest = digestProject(projectProjection(localProject));

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
    assert.deepEqual(result.autoAppliedUpdates, [], 'toggle OFF never auto-applies a fast-forward');
    assert.deepEqual(result.review, [unitRef], 'only the changed recording is reviewed');

    const state = store.getState();
    const review = state.reviews[unitRef];
    assert.equal(review.kind, 'review');
    assert.equal(review.status, 'PENDING');
    assert.deepEqual(review.incoming, recordingProjection(incomingRec));

    // Local recording is byte-identical; the incoming change was not adopted.
    const merged = projects.find((p) => p.project_id === ID);
    assert.deepEqual(
      merged.recordings.find((r) => r.recording_id === REC),
      recordingProjection(localRec),
    );
    assert.notDeepEqual(
      merged.recordings.find((r) => r.recording_id === REC),
      recordingProjection(incomingRec),
    );
    // Sibling untouched.
    assert.deepEqual(
      merged.recordings.find((r) => r.recording_id === SIB),
      recordingProjection(sibling),
    );

    // Baseline unchanged.
    assert.equal(getBaseline(state, ID).digest, baselineDigest);
  });

  // ── Deterministic regression example: toggle ON, non-fast-forward incoming ───
  // Auto-Accept-Updates is ON, but the incoming version DROPS a committed step
  // record present in the baseline, so it is not an append-only superset and is
  // held for Review rather than auto-applied.

  it('toggle ON: a non-fast-forward (history-dropping) incoming change still becomes a PENDING Review', async () => {
    const ID = '018f0000-0000-7000-8000-000000000011';
    const REC = '018f0000-0000-7000-8000-0000000000b1';

    const localRec = {
      recording_id: REC,
      name: 'rec-local',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { uuid: 's1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 's2', logical_id: 'a', step_number: 1, deleted: false },
      ],
    };
    // Server REWROTE history: s1 is gone (a record present in the baseline was
    // dropped), s3 added → NOT an append-only superset of the baseline.
    const incomingRec = {
      recording_id: REC,
      name: 'rec-local',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { uuid: 's2', logical_id: 'a', step_number: 1, deleted: false },
        { uuid: 's3', logical_id: 'a', step_number: 2, deleted: false },
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
    // Toggle ON — the auto-apply path is enabled, but the non-fast-forward shape
    // must still gate this change for review.
    setSettings(seed, { autoAcceptUpdates: true, autoAcceptDeletions: true });
    const baselineDigest = digestProject(projectProjection(localProject));

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
      'a non-fast-forward change is NOT auto-applied even with the toggle ON',
    );
    assert.deepEqual(result.review, [unitRef], 'the non-fast-forward change is reviewed');

    const state = store.getState();
    const review = state.reviews[unitRef];
    assert.equal(review.kind, 'review');
    assert.equal(review.status, 'PENDING');
    assert.deepEqual(review.incoming, recordingProjection(incomingRec));

    // Local recording is byte-identical; the incoming change was not adopted.
    const merged = projects.find((p) => p.project_id === ID);
    assert.deepEqual(
      merged.recordings.find((r) => r.recording_id === REC),
      recordingProjection(localRec),
    );
    assert.notDeepEqual(
      merged.recordings.find((r) => r.recording_id === REC),
      recordingProjection(incomingRec),
    );

    // Baseline unchanged.
    assert.equal(getBaseline(state, ID).digest, baselineDigest);
  });

  // ── Deterministic regression: auto-apply clears a lingering Review ───────────
  // A Review recorded in a prior cycle (e.g. while Auto-Accept-Updates was off, or
  // the change was not yet a fast-forward) must be cleared when the same Unit's
  // incoming later becomes a fast-forward and is auto-applied — otherwise the
  // adopted Unit keeps a PENDING Review whose attention badge never clears
  // (deriveIndicators reads state.reviews unconditionally). No GitHub issue — a
  // confirmed defect worked from the local backlog.
  it('regression_noissue_autoapply_clears_lingering_review', async () => {
    const ID = '018f0000-0000-7000-8000-0000000000c1';
    const REC = '018f0000-0000-7000-8000-0000000000d1';
    const unitRef = `${ID}:${REC}`;

    const localRec = {
      recording_id: REC,
      name: 'rec',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    // Server APPENDED a committed step (retains s1) → a true fast-forward.
    const incomingRec = {
      recording_id: REC,
      name: 'rec',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [
        { uuid: 's1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 's2', logical_id: 'a', step_number: 1, deleted: false },
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
    // A Review lingering from a prior cycle for this exact Unit.
    upsertReview(seed, unitRef, recordingProjection(incomingRec));
    assert.ok(seed.reviews[unitRef], 'precondition: a Review exists before the cycle');

    installMockFetch(
      [{ project_id: ID, name: 'Project' }],
      new Map([[ID, buildPayload(incomingProject)]]),
    );

    const store = makeStore(seed);
    const { result } = await sync(
      SERVER,
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    const state = store.getState();
    // The fast-forward IS auto-applied — the very branch that must also clear the item.
    assert.deepEqual(result.autoAppliedUpdates, [unitRef]);
    // The defect: the adopted Unit kept its prior Review; after the fix it is
    // returned to NONE and no attention indicator lingers.
    assert.equal(state.reviews[unitRef], undefined, 'the adopted Unit no longer has a Review');
    assert.deepEqual(deriveIndicators(state), [], 'no attention indicator lingers');
  });
});
