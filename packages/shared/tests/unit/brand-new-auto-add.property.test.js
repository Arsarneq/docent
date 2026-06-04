/**
 * brand-new-auto-add.property.test.js — Property test that BRAND-NEW Units are
 * auto-added by a sync cycle and recorded in the per-project Sync_Baseline,
 * while a Unit absent locally but present in the baseline is NEVER resurrected.
 *
 * Brand-new is the one inbound case the cycle applies WITHOUT the user (design
 * phase 7, R15.1): a pulled project with no local counterpart and no baseline
 * counterpart is added whole (R3.1); a pulled recording with no local
 * counterpart inside an EXISTING local project is appended as a new sibling
 * (R3.2); and either addition is recorded in the per-project baseline as the new
 * last-agreed state (R3.3). The complement is just as important: a Unit absent
 * locally but PRESENT in the baseline is a deliberate deletion, not a never-seen
 * Unit, so it must never be re-classified brand-new and never auto-re-added —
 * the Unit-level analogue of not resurrecting a tombstoned step (R2.6, R19).
 *
 * This property pins all of that over a large input space by driving the full
 * `sync()` orchestrator (not the detector in isolation):
 *
 *   Part A+B — auto-add. For a manifest mixing EXISTING projects (some receiving
 *   brand-new recordings on the server) and BRAND-NEW projects, after the cycle:
 *     - every brand-new project is present locally and byte-equal to the pulled
 *       (allowlisted) projection, and recorded in the baseline (R3.1, R3.3);
 *     - every brand-new recording is appended to its existing project as a new
 *       sibling, the project's pre-existing recordings are untouched, and the
 *       new recording is recorded in that project's baseline (R3.2, R3.3);
 *     - nothing is ever deferred (no Review, no Conflict) — brand-new and
 *       already-converged are the only outcomes in play.
 *
 *   Part C — no silent resurrection (R2.6, R19.1). For a project (or a single
 *   recording) that is present in the baseline, absent locally, and unchanged on
 *   the server, after the cycle the Unit is NOT re-added and is cleared from the
 *   baseline; it is never treated as brand-new.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` (`makeResponse`-style
 * Response stubs) and dispatches per project_id; the validator passes; an
 * in-memory `SyncStore` captures the saved `SyncState`; a permissive `LiveState`
 * (capture inactive, nothing locked, nothing pending) lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4:
 * `fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 2.6**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 6: Brand-new units are auto-added and recorded in the baseline

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { digestProject } from '../../sync-digest.js';
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
 * In-memory {@link SyncStore}. Optionally seeded with an initial SyncState;
 * captures the last saved state so the test can inspect baselines after the
 * cycle. Clones on the way in and out so no reference is shared with the cycle.
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

/** A validator that accepts every payload (brand-new acceptance is the focus). */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── allowlisted projections (mirror sync-client.js exactly) ──────────────────
// The orchestrator lands incoming Units through these same allowlists, so the
// expected merged/baseline shapes are computed with identical projections.

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
 * One recording spec. `isNew` partitions a project's recordings into the local
 * side (already on disk → already-converged with the server) and the brand-new
 * side (present only on the server → to be auto-added).
 */
const arbRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  name: fc.string({ maxLength: 20 }),
  created_at: arbIso,
  steps: fc.array(arbStep, { maxLength: 3 }),
  isNew: fc.boolean(),
});

/**
 * Strip generator-only fields, leaving the allowlisted recording shape. The
 * result is JSON-normalized so nested step records are plain objects (fast-check
 * builds records with a `null` prototype, which `deepStrictEqual` would treat as
 * unequal to the JSON-cloned copies the store/baseline produce). In production
 * every recording crosses JSON on the wire and in the store, so this matches the
 * real data path rather than masking anything.
 */
function cleanRecording(spec) {
  return JSON.parse(
    JSON.stringify({
      recording_id: spec.recording_id,
      name: spec.name,
      created_at: spec.created_at,
      steps: spec.steps,
    }),
  );
}

/**
 * One project spec. `kind === 'existing'` lives locally and is also on the
 * server (its `isNew` recordings are the brand-new siblings); `kind ===
 * 'brand-new'` is on the server only (a whole brand-new project, no baseline).
 */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  name: fc.string({ maxLength: 20 }),
  created_at: arbIso,
  kind: fc.constantFrom('existing', 'brand-new'),
  recordings: fc.uniqueArray(arbRecordingSpec, {
    selector: (r) => r.recording_id,
    maxLength: 4,
  }),
});

/** A manifest of 1..5 projects with unique ids and a mix of kinds. */
const arbAutoAddScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 5,
});

/**
 * Materialize an auto-add scenario into the inputs `sync()` needs plus the
 * derived expectations:
 *   - `localProjects` — the EXISTING projects, holding only their non-`isNew`
 *     recordings (the brand-new siblings are not on disk yet).
 *   - the server view — every project's full payload (existing projects carry
 *     their existing recordings PLUS the brand-new ones).
 */
function materializeAutoAdd(specs) {
  const localProjects = [];
  const payloadById = new Map();
  const manifest = [];
  const brandNewProjects = []; // { project_id, expectedProjection }
  const existingWithNewRecs = []; // { project_id, localRecs, newRecs }

  for (const s of specs) {
    const allRecs = s.recordings.map(cleanRecording);
    const serverProject = {
      project_id: s.project_id,
      name: s.name,
      created_at: s.created_at,
      recordings: allRecs,
    };
    payloadById.set(s.project_id, buildPayload(serverProject));
    manifest.push({ project_id: s.project_id, name: s.name });

    if (s.kind === 'brand-new') {
      brandNewProjects.push({
        project_id: s.project_id,
        expectedProjection: projectProjection(serverProject),
      });
    } else {
      const localRecs = s.recordings.filter((r) => !r.isNew).map(cleanRecording);
      const newRecs = s.recordings.filter((r) => r.isNew).map(cleanRecording);
      localProjects.push({
        project_id: s.project_id,
        name: s.name,
        created_at: s.created_at,
        recordings: localRecs,
      });
      if (newRecs.length > 0) {
        existingWithNewRecs.push({ project_id: s.project_id, localRecs, newRecs });
      }
    }
  }

  return { localProjects, payloadById, manifest, brandNewProjects, existingWithNewRecs };
}

// ─── Property 6 — auto-add (Parts A + B) ──────────────────────────────────────

describe('Property 6: Brand-new units are auto-added and recorded in the baseline', () => {
  it('auto-adds brand-new projects and brand-new recordings, records them in the baseline, and never defers', async () => {
    await fc.assert(
      fc.asyncProperty(arbAutoAddScenario, async (specs) => {
        const { localProjects, payloadById, manifest, brandNewProjects, existingWithNewRecs } =
          materializeAutoAdd(specs);
        installMockFetch(manifest, payloadById);

        const store = makeStore(); // empty: brand-new is genuinely never-agreed

        const { result, projects } = await sync(
          'https://srv.test',
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );

        // The cycle runs to completion — brand-new is an automatic outcome.
        assert.equal(result.halted, false, 'auto-add never halts the cycle');
        assert.equal(result.haltReason, null);

        // Nothing is ever deferred: brand-new auto-adds and already-converged
        // advances the baseline; neither produces a Review or a Conflict (R15.1).
        const state = store.getState();
        assert.deepEqual(result.review, [], 'no review unitRefs reported');
        assert.deepEqual(result.conflicts, [], 'no conflict unitRefs reported');
        assert.deepEqual(Object.keys(state.reviews ?? {}), [], 'no Review items recorded');
        assert.deepEqual(Object.keys(state.conflicts ?? {}), [], 'no Conflict items recorded');

        const byId = new Map(projects.map((p) => [p.project_id, p]));

        // ── R3.1 + R3.3 — every brand-new project is auto-added whole and
        // recorded in the baseline as the agreed state. ──
        for (const { project_id, expectedProjection } of brandNewProjects) {
          const merged = byId.get(project_id);
          assert.ok(merged, `brand-new project ${project_id} must be present locally`);
          assert.deepEqual(
            merged,
            expectedProjection,
            'auto-added project equals the pulled allowlisted projection',
          );

          const baseline = state.baselines?.[project_id];
          assert.ok(baseline, `brand-new project ${project_id} must be recorded in the baseline`);
          assert.deepEqual(
            baseline.agreedState,
            expectedProjection,
            'baseline agreedState equals the auto-added project',
          );
          assert.equal(
            baseline.digest,
            digestProject(expectedProjection),
            'baseline digest is the digest of the agreed project',
          );
        }

        // ── R3.2 + R3.3 — every brand-new recording is appended to its existing
        // project as a new sibling, the pre-existing recordings are untouched,
        // and the addition is recorded in the project's baseline. ──
        for (const { project_id, localRecs, newRecs } of existingWithNewRecs) {
          const merged = byId.get(project_id);
          assert.ok(merged, `existing project ${project_id} must still be present`);

          // Sibling recordings stay byte-identical and keep their leading order.
          assert.deepEqual(
            merged.recordings.slice(0, localRecs.length),
            localRecs.map(recordingProjection),
            'pre-existing sibling recordings are untouched',
          );

          const baseline = state.baselines?.[project_id];
          assert.ok(baseline, `project ${project_id} gaining a recording must have a baseline`);

          for (const newRec of newRecs) {
            const expected = recordingProjection(newRec);
            const appended = merged.recordings.find((r) => r.recording_id === newRec.recording_id);
            assert.ok(
              appended,
              `brand-new recording ${newRec.recording_id} must be appended as a sibling`,
            );
            assert.deepEqual(appended, expected, 'appended recording equals the pulled projection');

            const inBaseline = (baseline.agreedState.recordings ?? []).find(
              (r) => r.recording_id === newRec.recording_id,
            );
            assert.ok(
              inBaseline,
              `brand-new recording ${newRec.recording_id} must be recorded in the baseline`,
            );
            assert.deepEqual(inBaseline, expected, 'baseline records the added recording');
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Part C — no silent resurrection (R2.6, R19.1) ─────────────────────────

  /**
   * A project-level resurrection scenario: a set of projects present in the
   * baseline, absent locally, and returned UNCHANGED by the server. Each is a
   * deliberate local deletion (deleted-local-clean), never brand-new.
   */
  const arbDeletedProject = fc.record({
    project_id: fc.uuid({ version: 7 }),
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    recordings: fc.uniqueArray(
      fc.record({
        recording_id: fc.uuid(),
        name: fc.string({ maxLength: 20 }),
        created_at: arbIso,
        steps: fc.array(arbStep, { maxLength: 3 }),
      }),
      { selector: (r) => r.recording_id, maxLength: 3 },
    ),
  });

  const arbDeletedProjectScenario = fc.uniqueArray(arbDeletedProject, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 4,
  });

  it('never re-adds a whole project that is absent locally but present in the baseline (no resurrection)', async () => {
    await fc.assert(
      fc.asyncProperty(arbDeletedProjectScenario, async (projects) => {
        // Seed a baseline for every deleted project (the last-agreed state).
        const seed = createEmptySyncState();
        const payloadById = new Map();
        const manifest = [];
        for (const p of projects) {
          const agreed = projectProjection(p);
          advanceBaseline(seed, p.project_id, agreed);
          // Server returns the project UNCHANGED (incoming === baseline).
          payloadById.set(p.project_id, buildPayload(p));
          manifest.push({ project_id: p.project_id, name: p.name });
        }
        installMockFetch(manifest, payloadById);

        const store = makeStore(seed);

        // No local counterpart for any of them — they were deleted locally.
        const { result, projects: merged } = await sync(
          'https://srv.test',
          null,
          [],
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );

        assert.equal(result.halted, false);
        // A deletion-propagation is automatic: never a Review or a Conflict.
        assert.deepEqual(result.review, []);
        assert.deepEqual(result.conflicts, []);

        // No deleted project is resurrected into the local list...
        assert.deepEqual(merged, [], 'no absent-but-baselined project is re-added');

        // ...and each is cleared from the baseline (deletion propagated, R19.1).
        const state = store.getState();
        for (const p of projects) {
          assert.equal(
            state.baselines?.[p.project_id],
            undefined,
            `deleted project ${p.project_id} is cleared from the baseline, not resurrected`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * A recording-level resurrection scenario: an EXISTING project whose baseline
   * (and server copy) hold recordings that are absent locally. `deletedLocally`
   * recordings were removed on disk but remain agreed + on the server unchanged.
   */
  const arbProjectWithDeletedRecs = fc.record({
    project_id: fc.uuid({ version: 7 }),
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    recordings: fc.uniqueArray(
      fc.record({
        recording_id: fc.uuid(),
        name: fc.string({ maxLength: 20 }),
        created_at: arbIso,
        steps: fc.array(arbStep, { maxLength: 3 }),
        deletedLocally: fc.boolean(),
      }),
      { selector: (r) => r.recording_id, minLength: 1, maxLength: 4 },
    ),
  });

  const arbRecordingDeletionScenario = fc.uniqueArray(arbProjectWithDeletedRecs, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 3,
  });

  it('never re-adds a recording absent locally but present in the baseline (no resurrection)', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecordingDeletionScenario, async (specs) => {
        const seed = createEmptySyncState();
        const payloadById = new Map();
        const manifest = [];
        const localProjects = [];
        const expectations = []; // { project_id, keptIds, deletedIds }

        for (const s of specs) {
          const allRecs = s.recordings.map(cleanRecording);
          const keptRecs = s.recordings.filter((r) => !r.deletedLocally).map(cleanRecording);
          const deletedIds = s.recordings
            .filter((r) => r.deletedLocally)
            .map((r) => r.recording_id);

          // Baseline + server hold ALL recordings (the agreed state); local holds
          // only the kept ones (the deleted-locally recordings are off disk).
          const agreedProject = {
            project_id: s.project_id,
            name: s.name,
            created_at: s.created_at,
            recordings: allRecs,
          };
          advanceBaseline(seed, s.project_id, projectProjection(agreedProject));
          payloadById.set(s.project_id, buildPayload(agreedProject));
          manifest.push({ project_id: s.project_id, name: s.name });

          localProjects.push({
            project_id: s.project_id,
            name: s.name,
            created_at: s.created_at,
            recordings: keptRecs,
          });

          expectations.push({
            project_id: s.project_id,
            keptIds: keptRecs.map((r) => r.recording_id),
            deletedIds,
          });
        }
        installMockFetch(manifest, payloadById);

        const store = makeStore(seed);

        const { result, projects } = await sync(
          'https://srv.test',
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );

        assert.equal(result.halted, false);
        assert.deepEqual(result.review, [], 'a clean recording deletion is never a Review');
        assert.deepEqual(result.conflicts, [], 'a clean recording deletion is never a Conflict');

        const byId = new Map(projects.map((p) => [p.project_id, p]));
        const state = store.getState();

        for (const { project_id, keptIds, deletedIds } of expectations) {
          const merged = byId.get(project_id);
          assert.ok(merged, `project ${project_id} must still be present`);

          const mergedRecIds = new Set(merged.recordings.map((r) => r.recording_id));
          for (const deletedId of deletedIds) {
            assert.ok(
              !mergedRecIds.has(deletedId),
              `deleted recording ${deletedId} must not be resurrected into the project`,
            );
          }
          for (const keptId of keptIds) {
            assert.ok(mergedRecIds.has(keptId), `kept recording ${keptId} must remain`);
          }

          // The baseline keeps the kept recordings and drops the deleted ones.
          const baseline = state.baselines?.[project_id];
          assert.ok(baseline, `project ${project_id} must still have a baseline`);
          const baselineRecIds = new Set(
            (baseline.agreedState.recordings ?? []).map((r) => r.recording_id),
          );
          for (const deletedId of deletedIds) {
            assert.ok(
              !baselineRecIds.has(deletedId),
              `deleted recording ${deletedId} must be cleared from the baseline`,
            );
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  // ── Deterministic regression examples ──────────────────────────────────────

  it('a lone brand-new project is auto-added whole and recorded in the baseline', async () => {
    const ID = '018f0000-0000-7000-8000-000000000001';
    const REC = '018f0000-0000-7000-8000-0000000000a1';
    const project = {
      project_id: ID,
      name: 'New Project',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [
        {
          recording_id: REC,
          name: 'Rec 1',
          created_at: '2026-01-01T00:00:00.000Z',
          steps: [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }],
        },
      ],
    };
    installMockFetch(
      [{ project_id: ID, name: 'New Project' }],
      new Map([[ID, buildPayload(project)]]),
    );

    const store = makeStore();
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    const expected = projectProjection(project);
    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.review, []);
    assert.deepEqual(projects, [expected], 'the brand-new project is auto-added');
    const state = store.getState();
    assert.deepEqual(state.baselines[ID].agreedState, expected);
    assert.equal(state.baselines[ID].digest, digestProject(expected));
  });

  it('a brand-new recording is appended to an existing project as a sibling, leaving the existing one untouched', async () => {
    const ID = '018f0000-0000-7000-8000-000000000002';
    const OLD = '018f0000-0000-7000-8000-0000000000b1';
    const NEW = '018f0000-0000-7000-8000-0000000000b2';
    const oldRec = {
      recording_id: OLD,
      name: 'Existing',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'o1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const newRec = {
      recording_id: NEW,
      name: 'Server sibling',
      created_at: '2026-01-02T00:00:00.000Z',
      steps: [{ uuid: 'n1', logical_id: 'b', step_number: 0, deleted: false }],
    };
    const local = {
      project_id: ID,
      name: 'Project',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [oldRec],
    };
    const server = { ...local, recordings: [oldRec, newRec] };
    installMockFetch([{ project_id: ID, name: 'Project' }], new Map([[ID, buildPayload(server)]]));

    const store = makeStore();
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.review, []);

    const merged = projects.find((p) => p.project_id === ID);
    assert.deepEqual(
      merged.recordings.map((r) => r.recording_id),
      [OLD, NEW],
      'the existing recording is kept first and the new one appended',
    );
    assert.deepEqual(merged.recordings[0], recordingProjection(oldRec), 'sibling untouched');
    assert.deepEqual(merged.recordings[1], recordingProjection(newRec), 'new sibling appended');

    const baseline = store.getState().baselines[ID];
    const inBaseline = baseline.agreedState.recordings.find((r) => r.recording_id === NEW);
    assert.deepEqual(
      inBaseline,
      recordingProjection(newRec),
      'the added recording is in the baseline',
    );
  });

  it('a project absent locally but present in the baseline is not resurrected', async () => {
    const ID = '018f0000-0000-7000-8000-000000000003';
    const project = {
      project_id: ID,
      name: 'Deleted',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [],
    };
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(project));
    installMockFetch([{ project_id: ID, name: 'Deleted' }], new Map([[ID, buildPayload(project)]]));

    const store = makeStore(seed);
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(projects, [], 'the deleted project is not re-added');
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.review, []);
    assert.equal(store.getState().baselines[ID], undefined, 'baseline cleared, not resurrected');
  });
});
