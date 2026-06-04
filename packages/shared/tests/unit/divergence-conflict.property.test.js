/**
 * divergence-conflict.property.test.js — Property test that a DIVERGED Unit
 * records a Conflict retaining BOTH versions, deferred to the user, driving the
 * full `sync()` orchestrator (not the detector in isolation).
 *
 * When the Conflict_Detector classifies a Unit as `diverged` — both the local
 * and the incoming version differ, and both differ from the Sync_Baseline (the
 * concurrent-push overwrite case, R18.1) — the cycle must:
 *
 *   - record a Conflict for that Unit (R5.1), keyed by its `unitRef`, with the
 *     `unitRef` surfaced in `result.conflicts`;
 *   - retain BOTH the local and the incoming version in recoverable form on the
 *     Conflict record (R5.2);
 *   - apply NO version to the Unit during the cycle — local data is left
 *     byte-identical, the incoming change is never adopted automatically; a
 *     version is applied only as the explicit outcome of Conflict_Resolution
 *     (R5.4, R9.5, R15.2); and
 *   - leave the per-project Sync_Baseline UNCHANGED (a divergence is not an
 *     agreement, so the baseline never advances for it).
 *
 * The property is exercised at BOTH granularities a divergence can take:
 *
 *   - recording-level divergence — a project present on both sides whose
 *     recording moved on both sides from a common baseline (baseline `base`,
 *     local `loc`, server `srv`); the recording is one diverged Unit.
 *   - project-level (metadata) divergence — the project's own name/metadata
 *     moved on both sides from the baseline; the project-metadata Unit is one
 *     diverged Unit (its retained copies are the WHOLE project, per
 *     `unitCopyForSide`).
 *
 * Each generated project carries at least one diverged Unit (a diverged
 * recording and/or diverged metadata) and may also carry converged recordings
 * (identical on both sides), which must be omitted from every deferral and never
 * disturb the baseline. The property asserts the stored `conflicts` map and the
 * reported `result.conflicts` set equal EXACTLY the diverged units, that
 * `result.review` is empty (a pure-divergence cycle defers nothing to
 * Review-and-Accept), that every Conflict retains the correct local/incoming
 * copies, that the merged local version is byte-identical, and that each
 * project's baseline is untouched.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling
 * orchestrator property tests (`makeResponse`-style Response stubs) and
 * dispatches per project_id; the validator passes; an in-memory `SyncStore`
 * (seeded with the baselines) captures the saved `SyncState`; a permissive
 * `LiveState` (capture inactive, nothing locked, nothing pending) lets the cycle
 * run to completion.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard; `fc.uuid()` supplies recording ids).
 *
 * **Validates: Requirements 5.1, 5.2, 5.4, 9.5, 15.2**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 11: Divergence records a Conflict retaining both versions, deferred to the user

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
 * project_id:
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
 * In-memory {@link SyncStore}. Seeded with an initial SyncState (the baselines)
 * and captures the last saved state so the test can inspect baselines / reviews
 * / conflicts after the cycle. Clones in and out so no reference is shared.
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

/** A validator that accepts every payload (divergence handling is the focus). */
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
 * JSON-string comparisons below aligned with the values the store retains.
 */
function cleanRecording({ recording_id, name, created_at, steps }) {
  return JSON.parse(JSON.stringify({ recording_id, name, created_at, steps }));
}

/** Build a clean project object from id/name/created_at and clean recordings. */
function cleanProject(id, name, created_at, recordings) {
  return {
    project_id: id,
    name,
    created_at,
    recordings: recordings.map(cleanRecording),
  };
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

/**
 * One recording spec: a stable identity (`recording_id`, `created_at`) and a
 * shared committed `steps` history reused across all three of its versions, plus
 * a `diverged` flag. A diverged recording moved on both sides from the baseline;
 * a non-diverged recording is identical on every side (converged).
 */
const arbRecSpec = fc.record({
  recording_id: fc.uuid(),
  created_at: arbIso,
  steps: fc.array(arbStep, { maxLength: 3 }),
  diverged: fc.boolean(),
});

/**
 * One project spec: a UUIDv7 id (so it passes the manifest guard), a stable
 * `created_at`, a `metaDiverged` flag (whether the project's own name/metadata
 * moved on both sides), and 1..4 recordings with unique ids.
 */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  created_at: arbIso,
  metaDiverged: fc.boolean(),
  recordings: fc.uniqueArray(arbRecSpec, {
    selector: (r) => r.recording_id,
    minLength: 1,
    maxLength: 4,
  }),
});

/** A scenario: 1..4 projects with unique ids, each carrying ≥1 diverged Unit. */
const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 4,
});

/**
 * Materialize a scenario into the inputs `sync()` needs plus the per-project
 * expectations. Versions of one Unit share its identity and differ only by a
 * content marker carried in `name` — the digest folds name into content identity
 * (R2.8), so a marker change is an ordinary content change:
 *
 *   marker 'base' — the agreed (baseline) content
 *   marker 'loc'  — a local-side change
 *   marker 'srv'  — a server-side change
 *   marker 'same' — converged (identical on both sides and the baseline)
 *
 * Each project is forced to carry at least one diverged Unit: if neither its
 * metadata nor any recording would diverge, the first recording is made diverged
 * (so the project is "present on both sides but differing" and the detector
 * descends into it).
 */
function materialize(specs) {
  const seed = createEmptySyncState();
  const manifest = [];
  const payloadById = new Map();
  const localProjects = [];
  const expectations = [];

  for (const s of specs) {
    const pid = s.project_id;
    const ca = s.created_at;

    const recs = s.recordings.map((r) => ({ ...r }));
    // Guarantee at least one diverged Unit so the project is not fully converged
    // (which would otherwise advance its baseline and defer nothing).
    if (!s.metaDiverged && !recs.some((r) => r.diverged)) {
      recs[0].diverged = true;
    }
    const metaDiverged = s.metaDiverged;

    // When metadata diverges, the project name carries the per-side marker;
    // otherwise the name is identical on every side (metadata converged).
    const projName = (marker) => (metaDiverged ? `${marker}-proj` : 'Project');

    const recVersion = (r, marker) =>
      cleanRecording({
        recording_id: r.recording_id,
        name: marker,
        created_at: r.created_at,
        steps: r.steps,
      });

    const localRecs = [];
    const serverRecs = [];
    const baselineRecs = [];
    const divergedRecIds = [];

    for (const r of recs) {
      if (r.diverged) {
        localRecs.push(recVersion(r, 'loc'));
        serverRecs.push(recVersion(r, 'srv'));
        baselineRecs.push(recVersion(r, 'base'));
        divergedRecIds.push(r.recording_id);
      } else {
        // Converged: identical content on every side ⇒ already-converged ⇒ omitted.
        localRecs.push(recVersion(r, 'same'));
        serverRecs.push(recVersion(r, 'same'));
        baselineRecs.push(recVersion(r, 'same'));
      }
    }

    const localProject = cleanProject(pid, projName('loc'), ca, localRecs);
    const serverProject = cleanProject(pid, projName('srv'), ca, serverRecs);
    const agreedProject = cleanProject(pid, projName('base'), ca, baselineRecs);

    // Seed the per-project Sync_Baseline (the last mutually-agreed state).
    advanceBaseline(seed, pid, projectProjection(agreedProject));

    localProjects.push(localProject);
    manifest.push({ project_id: pid, name: serverProject.name });
    payloadById.set(pid, buildPayload(serverProject));

    expectations.push({
      project_id: pid,
      metaDiverged,
      divergedRecIds,
      localProject,
      serverProject,
    });
  }

  return { seed, manifest, payloadById, localProjects, expectations };
}

// ─── Property 11 ──────────────────────────────────────────────────────────────

describe('Property 11: Divergence records a Conflict retaining both versions, deferred to the user', () => {
  it('records a Conflict (both versions retained) for every diverged Unit, applies no version, and leaves the baseline unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (specs) => {
        const { seed, manifest, payloadById, localProjects, expectations } = materialize(specs);

        // Snapshot the seeded baselines BEFORE the cycle so the "baseline
        // unchanged by a divergence" assertion compares against a stable copy.
        const seededBaselines = structuredClone(seed.baselines);
        const store = makeStore(seed);

        installMockFetch(manifest, payloadById);

        const { result, projects } = await sync(
          'https://srv.test',
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );

        // A divergence never halts the cycle — it is recorded and deferred.
        assert.equal(result.halted, false);
        assert.equal(result.haltReason, null);

        const state = store.getState();
        const mergedById = new Map(projects.map((p) => [p.project_id, p]));

        // The diverged units this scenario produces, at both granularities.
        const expectedConflicts = [];
        for (const e of expectations) {
          if (e.metaDiverged) expectedConflicts.push(e.project_id);
          for (const rid of e.divergedRecIds) expectedConflicts.push(`${e.project_id}:${rid}`);
        }

        // The reported and stored Conflict sets equal EXACTLY the diverged units;
        // a pure-divergence cycle defers nothing to Review-and-Accept (R5.1).
        assert.deepEqual(
          [...result.conflicts].sort(),
          [...expectedConflicts].sort(),
          'reported conflicts equal exactly the diverged units',
        );
        assert.deepEqual(
          Object.keys(state.conflicts).sort(),
          [...expectedConflicts].sort(),
          'stored Conflict items equal exactly the diverged units',
        );
        assert.deepEqual([...result.review].sort(), [], 'no Review items reported');
        assert.deepEqual(Object.keys(state.reviews), [], 'no Review items stored');

        for (const e of expectations) {
          const merged = mergedById.get(e.project_id);
          assert.ok(merged, `project ${e.project_id} is still present after the cycle`);

          // R9.5 / R5.4 — no version is applied to the project during the cycle:
          // the merged project is byte-identical to the local version.
          assert.equal(
            JSON.stringify(projectProjection(merged)),
            JSON.stringify(projectProjection(e.localProject)),
            'merged project equals local (no incoming version applied)',
          );

          // The Sync_Baseline is never advanced by a divergence.
          assert.deepEqual(
            state.baselines[e.project_id],
            seededBaselines[e.project_id],
            'baseline is unchanged by a divergence',
          );

          // ── Project-level (metadata) divergence ──
          if (e.metaDiverged) {
            const item = state.conflicts[e.project_id];
            assert.ok(item, `project-level Conflict recorded for ${e.project_id}`);
            assert.equal(item.kind, 'conflict');
            assert.equal(item.recording_id, null);
            // Both whole-project versions retained in recoverable form (R5.2).
            assert.equal(
              JSON.stringify(item.local),
              JSON.stringify(projectProjection(e.localProject)),
              'project Conflict retains the local version',
            );
            assert.equal(
              JSON.stringify(item.incoming),
              JSON.stringify(projectProjection(e.serverProject)),
              'project Conflict retains the incoming version',
            );
          } else {
            assert.equal(
              state.conflicts[e.project_id],
              undefined,
              'no project-level Conflict when metadata did not diverge',
            );
          }

          // ── Recording-level divergence ──
          const localRecById = new Map(e.localProject.recordings.map((r) => [r.recording_id, r]));
          const serverRecById = new Map(e.serverProject.recordings.map((r) => [r.recording_id, r]));
          const mergedRecById = new Map(merged.recordings.map((r) => [r.recording_id, r]));

          for (const rid of e.divergedRecIds) {
            const unitRef = `${e.project_id}:${rid}`;
            const item = state.conflicts[unitRef];
            assert.ok(item, `recording-level Conflict recorded for ${unitRef}`);
            assert.equal(item.kind, 'conflict');
            assert.equal(item.recording_id, rid);
            // Both recording versions retained in recoverable form (R5.2).
            assert.equal(
              JSON.stringify(item.local),
              JSON.stringify(recordingProjection(localRecById.get(rid))),
              'recording Conflict retains the local version',
            );
            assert.equal(
              JSON.stringify(item.incoming),
              JSON.stringify(recordingProjection(serverRecById.get(rid))),
              'recording Conflict retains the incoming version',
            );
            // The local recording is preserved unchanged in the merged list (R9.5).
            assert.equal(
              JSON.stringify(recordingProjection(mergedRecById.get(rid))),
              JSON.stringify(recordingProjection(localRecById.get(rid))),
              'merged recording equals local (no incoming version applied)',
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ──────────────────────────────────────

  const ID = '018f0000-0000-7000-8000-000000000010';

  function rec(recording_id, name) {
    return {
      recording_id,
      name,
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }],
    };
  }

  it('a diverged recording records a Conflict retaining both versions, leaving local untouched and the baseline unchanged', async () => {
    const RID = '018f0000-0000-7000-8000-0000000000a1';

    // Baseline 'base'; local moved to 'loc'; server moved to 'srv' — divergence.
    const localRec = rec(RID, 'loc');
    const serverRec = rec(RID, 'srv');
    const localProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [localRec],
    };
    const serverProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [serverRec],
    };
    const agreedProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [rec(RID, 'base')],
    };

    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(agreedProject));
    const seededBaseline = structuredClone(seed.baselines[ID]);
    const store = makeStore(seed);
    installMockFetch([{ project_id: ID, name: 'P' }], new Map([[ID, buildPayload(serverProject)]]));

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.review, [], 'a divergence is never a Review');
    assert.deepEqual(result.conflicts, [`${ID}:${RID}`], 'only the diverged recording conflicts');

    const state = store.getState();
    const conflict = state.conflicts[`${ID}:${RID}`];
    assert.ok(conflict, 'conflict recorded for the diverged recording');
    assert.equal(conflict.kind, 'conflict');
    assert.equal(JSON.stringify(conflict.local), JSON.stringify(recordingProjection(localRec)));
    assert.equal(JSON.stringify(conflict.incoming), JSON.stringify(recordingProjection(serverRec)));

    // No version applied: the merged recording equals local.
    const merged = projects.find((p) => p.project_id === ID);
    const mergedRec = merged.recordings.find((r) => r.recording_id === RID);
    assert.equal(
      JSON.stringify(recordingProjection(mergedRec)),
      JSON.stringify(recordingProjection(localRec)),
    );

    // Baseline unchanged by the divergence.
    assert.deepEqual(state.baselines[ID], seededBaseline, 'baseline unchanged');
  });

  it('a project whose metadata diverged on both sides records a project-level Conflict retaining both whole-project versions', async () => {
    // The single recording is identical on every side (converged); only the
    // project NAME diverges, so the lone diverged Unit is the project itself.
    const RID = '018f0000-0000-7000-8000-0000000000b1';
    const sharedRec = rec(RID, 'same');

    const localProject = {
      project_id: ID,
      name: 'loc-proj',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [sharedRec],
    };
    const serverProject = {
      project_id: ID,
      name: 'srv-proj',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [sharedRec],
    };
    const agreedProject = {
      project_id: ID,
      name: 'base-proj',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [sharedRec],
    };

    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(agreedProject));
    const seededBaseline = structuredClone(seed.baselines[ID]);
    const store = makeStore(seed);
    installMockFetch(
      [{ project_id: ID, name: 'srv-proj' }],
      new Map([[ID, buildPayload(serverProject)]]),
    );

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.review, []);
    // Exactly one conflict: the project-level (metadata) Unit. The converged
    // recording is omitted entirely.
    assert.deepEqual(result.conflicts, [ID], 'only the project-metadata Unit conflicts');

    const state = store.getState();
    assert.equal(
      state.conflicts[`${ID}:${RID}`],
      undefined,
      'the converged recording is not a conflict',
    );
    const conflict = state.conflicts[ID];
    assert.ok(conflict, 'project-level conflict recorded');
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.recording_id, null);
    // The retained copies are the WHOLE project on each side (R5.2).
    assert.equal(JSON.stringify(conflict.local), JSON.stringify(projectProjection(localProject)));
    assert.equal(
      JSON.stringify(conflict.incoming),
      JSON.stringify(projectProjection(serverProject)),
    );

    // No version applied: the merged project equals local.
    const merged = projects.find((p) => p.project_id === ID);
    assert.equal(
      JSON.stringify(projectProjection(merged)),
      JSON.stringify(projectProjection(localProject)),
    );

    // Baseline unchanged by the divergence.
    assert.deepEqual(state.baselines[ID], seededBaseline, 'baseline unchanged');
  });
});
