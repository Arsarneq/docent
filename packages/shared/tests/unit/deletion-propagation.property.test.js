/**
 * deletion-propagation.property.test.js — Property test that a sync cycle never
 * silently RESURRECTS a deletion and never silently APPLIES one, driving the
 * full `sync()` orchestrator over a large space of deletion scenarios.
 *
 * The data model has step-level tombstones but NO recording-level or
 * project-level tombstone: `RECORDING_DELETE` removes the recording from the
 * array and project deletion removes the project. So a Unit that is "absent on a
 * side but present in the Sync_Baseline" is a deliberate deletion, not a
 * never-seen Unit. Without graded handling, the brand-new auto-add path would
 * re-add it — the Unit-level analogue of resurrecting a tombstoned step. This
 * property pins the three AUTOMATIC deletion outcomes the cycle must produce:
 *
 *   - `deleted-local-clean` — present in the baseline, absent locally,
 *     and UNCHANGED on the server (incoming == baseline): the deletion is
 *     propagated. The Unit is NOT re-added to the merged list and is cleared
 *     from the baseline; it is never a Review or a Conflict.
 *   - `deleted-both` — present in the baseline, absent on BOTH sides:
 *     the deletion is agreed and cleared from the baseline, with no Conflict
 *     (and no Review).
 *   - `deleted-remote-review` — present in the baseline, absent on the
 *     server, with the LOCAL version unchanged from baseline: the cycle creates
 *     a durable Review-and-Accept item for the deletion rather than removing the
 *     local Unit silently. Local data is left untouched; the deletion is NOT
 *     applied automatically.
 *
 * The property is exercised at BOTH granularities. Project-level Units cover all
 * three outcomes in one mixed scenario (it block A). Recording-level Units cover
 * `deleted-local-clean` (block B) and `deleted-remote-review` (block C) — the
 * two cases reachable when a project is present on both sides but differs in its
 * recording set, which is what makes the detector descend into recordings.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / `brand-new-auto-add`
 * (`makeResponse`-style Response stubs) and dispatches per project_id; the
 * validator passes; an in-memory `SyncStore` (seeded with the baselines) captures
 * the saved `SyncState`; a permissive `LiveState` (capture inactive, nothing
 * locked, nothing pending) lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Deletions are never silently resurrected or silently applied

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
 *   - GET /projects     → the manifest array (the server-present projects only).
 *   - GET /projects/:id → the project's Full_Project_Payload.
 *
 * A project that is absent on the server side is simply not in the manifest and
 * has no payload, so the pull never returns it (incoming === null for it).
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
 * In-memory {@link SyncStore}, seeded with an initial SyncState and capturing the
 * last saved state so the test can inspect baselines/reviews/conflicts after the
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

/** A validator that accepts every payload (deletion handling is the focus). */
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

const arbRecording = fc.record({
  recording_id: fc.uuid(),
  name: fc.string({ maxLength: 20 }),
  created_at: arbIso,
  steps: fc.array(arbStep, { maxLength: 3 }),
});

/**
 * JSON-normalize a recording spec into the allowlisted shape with plain-object
 * (not null-prototype) step records. In production every recording crosses JSON
 * on the wire and in the store, so this matches the real data path rather than
 * masking anything; it also keeps `deepStrictEqual` happy against the
 * JSON-cloned copies the store/baseline produce.
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

/** Build a clean project object from id/name/created_at and clean recordings. */
function cleanProject(id, name, created_at, recordings) {
  return {
    project_id: id,
    name,
    created_at,
    recordings: recordings.map(cleanRecording),
  };
}

// ─── Block A — project-level deletions (all three outcomes mixed) ─────────────

/**
 * A whole project that is present in the baseline (the last-agreed state) and
 * realizes one of the three automatic deletion outcomes:
 *   - 'local-clean'   — absent locally, returned UNCHANGED by the server.
 *   - 'both'          — absent on both the local and the server side.
 *   - 'remote-review' — present locally UNCHANGED, absent on the server.
 */
const arbProjectDeletionSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  name: fc.string({ maxLength: 20 }),
  created_at: arbIso,
  recordings: fc.uniqueArray(arbRecording, { selector: (r) => r.recording_id, maxLength: 3 }),
  outcome: fc.constantFrom('local-clean', 'both', 'remote-review'),
});

const arbProjectDeletionScenario = fc.uniqueArray(arbProjectDeletionSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 6,
});

/**
 * Materialize a project-level deletion scenario: every project is seeded into the
 * baseline as the last-agreed state, then placed local-side / server-side
 * according to its outcome.
 */
function materializeProjectScenario(specs) {
  const seed = createEmptySyncState();
  const payloadById = new Map();
  const manifest = [];
  const localProjects = [];
  const groups = { localClean: [], both: [], remoteReview: [] };

  for (const s of specs) {
    const project = cleanProject(s.project_id, s.name, s.created_at, s.recordings);
    // Every project is in the baseline (it was once mutually agreed).
    advanceBaseline(seed, s.project_id, projectProjection(project));

    if (s.outcome === 'local-clean') {
      // Absent locally; present on the server UNCHANGED (incoming === baseline).
      payloadById.set(s.project_id, buildPayload(project));
      manifest.push({ project_id: s.project_id, name: s.name });
      groups.localClean.push(s.project_id);
    } else if (s.outcome === 'both') {
      // Absent on both sides — only the baseline remembers it.
      groups.both.push(s.project_id);
    } else {
      // remote-review: present locally UNCHANGED, absent on the server.
      localProjects.push(project);
      groups.remoteReview.push(s.project_id);
    }
  }

  return { seed, payloadById, manifest, localProjects, groups };
}

describe('Deletions are never silently resurrected or silently applied', () => {
  it('project-level: propagates clean/agreed deletions and reviews a server-side deletion', async () => {
    await fc.assert(
      fc.asyncProperty(arbProjectDeletionScenario, async (specs) => {
        const { seed, payloadById, manifest, localProjects, groups } =
          materializeProjectScenario(specs);
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

        assert.equal(result.halted, false, 'an automatic deletion outcome never halts');
        assert.equal(result.haltReason, null);
        // No deletion outcome in this scenario is ever a Conflict.
        assert.deepEqual(result.conflicts, [], 'no deletion case produces a Conflict');

        const state = store.getState();
        const mergedIds = new Set(projects.map((p) => p.project_id));

        // ── deleted-local-clean: not re-added, cleared from baseline,
        // never deferred. ──
        for (const id of groups.localClean) {
          assert.ok(!mergedIds.has(id), `local-clean ${id} must NOT be resurrected into the list`);
          assert.equal(
            state.baselines?.[id],
            undefined,
            `local-clean ${id} must be cleared from the baseline`,
          );
          assert.equal(state.reviews?.[id], undefined, 'a clean local deletion is never a Review');
          assert.equal(
            state.conflicts?.[id],
            undefined,
            'a clean local deletion is never a Conflict',
          );
        }

        // ── deleted-both: cleared from baseline, no Conflict, no Review. ──
        for (const id of groups.both) {
          assert.ok(!mergedIds.has(id), `agreed deletion ${id} must not appear in the list`);
          assert.equal(
            state.baselines?.[id],
            undefined,
            `agreed deletion ${id} must be cleared from the baseline`,
          );
          assert.equal(state.reviews?.[id], undefined, 'an agreed deletion is never a Review');
          assert.equal(state.conflicts?.[id], undefined, 'an agreed deletion is never a Conflict');
        }

        // ── deleted-remote-review: local kept, Review created, deletion
        // not silently applied. ──
        for (const id of groups.remoteReview) {
          assert.ok(mergedIds.has(id), `local ${id} must NOT be silently removed`);
          const reviewItem = state.reviews?.[id];
          assert.ok(reviewItem, `server-side deletion of ${id} must create a Review item`);
          assert.equal(reviewItem.kind, 'review');
          assert.equal(
            reviewItem.incoming,
            null,
            'the incoming (deletion) side carries no version',
          );
          assert.equal(
            state.conflicts?.[id],
            undefined,
            'a remote deletion review is not a Conflict',
          );
          // The baseline is left intact for a deferred review (untouched by upsert).
          assert.ok(state.baselines?.[id], `baseline for reviewed ${id} is retained`);
        }

        // The reported review set is EXACTLY the server-side deletions; the
        // clean/agreed deletions are propagated automatically and never deferred.
        assert.deepEqual(
          [...result.review].sort(),
          [...groups.remoteReview].sort(),
          'only server-side deletions are surfaced as Reviews',
        );
      }),
      { numRuns: 200 },
    );
  });

  // ─── Block B — recording-level deleted-local-clean ──────────────────

  /**
   * A recording inside a project present on both sides. `deletedLocally` marks a
   * recording removed on disk but still agreed (in the baseline) and returned
   * UNCHANGED by the server — i.e. a clean local deletion to propagate.
   */
  const arbRecLocalClean = fc.record({
    recording_id: fc.uuid(),
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    steps: fc.array(arbStep, { maxLength: 3 }),
    deletedLocally: fc.boolean(),
  });

  const arbProjectWithLocalCleanRecs = fc.record({
    project_id: fc.uuid({ version: 7 }),
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    recordings: fc.uniqueArray(arbRecLocalClean, {
      selector: (r) => r.recording_id,
      minLength: 1,
      maxLength: 4,
    }),
  });

  const arbRecordingLocalCleanScenario = fc.uniqueArray(arbProjectWithLocalCleanRecs, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 3,
  });

  it('recording-level: a clean local recording deletion is propagated, not resurrected', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecordingLocalCleanScenario, async (specs) => {
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
          const agreed = cleanProject(s.project_id, s.name, s.created_at, allRecs);
          advanceBaseline(seed, s.project_id, projectProjection(agreed));
          payloadById.set(s.project_id, buildPayload(agreed));
          manifest.push({ project_id: s.project_id, name: s.name });

          localProjects.push(cleanProject(s.project_id, s.name, s.created_at, keptRecs));
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
              `deleted recording ${deletedId} must NOT be resurrected`,
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
          for (const keptId of keptIds) {
            assert.ok(baselineRecIds.has(keptId), `kept recording ${keptId} must stay in baseline`);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  // ─── Block C — recording-level deleted-remote-review ────────────────

  /**
   * A recording inside a project present on both sides. `deletedRemotely` marks a
   * recording deleted on the server while it remains locally UNCHANGED from the
   * baseline — i.e. a server-side deletion that must be reviewed, not applied.
   */
  const arbRecRemoteReview = fc.record({
    recording_id: fc.uuid(),
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    steps: fc.array(arbStep, { maxLength: 3 }),
    deletedRemotely: fc.boolean(),
  });

  const arbProjectWithRemoteReviewRecs = fc.record({
    project_id: fc.uuid({ version: 7 }),
    name: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    recordings: fc.uniqueArray(arbRecRemoteReview, {
      selector: (r) => r.recording_id,
      minLength: 1,
      maxLength: 4,
    }),
  });

  const arbRecordingRemoteReviewScenario = fc.uniqueArray(arbProjectWithRemoteReviewRecs, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 3,
  });

  it('recording-level: a server-side recording deletion is reviewed, never silently applied', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecordingRemoteReviewScenario, async (specs) => {
        const seed = createEmptySyncState();
        const payloadById = new Map();
        const manifest = [];
        const localProjects = [];
        const expectations = []; // { project_id, keptIds, remoteIds }
        const expectedReviewRefs = [];

        for (const s of specs) {
          const allRecs = s.recordings.map(cleanRecording);
          const keptRecs = s.recordings.filter((r) => !r.deletedRemotely).map(cleanRecording);
          const remoteIds = s.recordings
            .filter((r) => r.deletedRemotely)
            .map((r) => r.recording_id);

          // Baseline + local hold ALL recordings (local UNCHANGED from agreed);
          // the server holds only the kept ones (it deleted the rest).
          const agreed = cleanProject(s.project_id, s.name, s.created_at, allRecs);
          advanceBaseline(seed, s.project_id, projectProjection(agreed));
          payloadById.set(
            s.project_id,
            buildPayload(cleanProject(s.project_id, s.name, s.created_at, keptRecs)),
          );
          manifest.push({ project_id: s.project_id, name: s.name });

          localProjects.push(cleanProject(s.project_id, s.name, s.created_at, allRecs));
          expectations.push({
            project_id: s.project_id,
            keptIds: keptRecs.map((r) => r.recording_id),
            remoteIds,
          });
          for (const recId of remoteIds) expectedReviewRefs.push(`${s.project_id}:${recId}`);
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
        assert.deepEqual(result.conflicts, [], 'a server-side deletion review is never a Conflict');

        const byId = new Map(projects.map((p) => [p.project_id, p]));
        const state = store.getState();

        for (const { project_id, keptIds, remoteIds } of expectations) {
          const merged = byId.get(project_id);
          assert.ok(merged, `project ${project_id} must still be present`);

          const mergedRecIds = new Set(merged.recordings.map((r) => r.recording_id));
          // The server deletion is NOT applied: every locally-present recording
          // (kept AND server-deleted) is preserved in the merged list.
          for (const remoteId of remoteIds) {
            assert.ok(
              mergedRecIds.has(remoteId),
              `server-deleted recording ${remoteId} must NOT be silently removed from local`,
            );
            const unitRef = `${project_id}:${remoteId}`;
            const reviewItem = state.reviews?.[unitRef];
            assert.ok(reviewItem, `server deletion of ${remoteId} must create a Review item`);
            assert.equal(reviewItem.kind, 'review');
            assert.equal(reviewItem.incoming, null, 'the deletion side carries no version');
            assert.equal(
              state.conflicts?.[unitRef],
              undefined,
              'review and conflict are exclusive',
            );
          }
          for (const keptId of keptIds) {
            assert.ok(mergedRecIds.has(keptId), `converged recording ${keptId} must remain`);
          }
        }

        // The reported review set is EXACTLY the per-recording server deletions.
        assert.deepEqual(
          [...result.review].sort(),
          [...expectedReviewRefs].sort(),
          'every server-side recording deletion is surfaced as a Review and nothing else is',
        );
      }),
      { numRuns: 150 },
    );
  });

  // ─── Deterministic regression examples ──────────────────────────────────────

  it('a project absent locally but present in the baseline and unchanged on the server is propagated, not resurrected', async () => {
    const ID = '018f0000-0000-7000-8000-000000000010';
    const project = cleanProject(ID, 'Deleted Locally', '2026-01-01T00:00:00.000Z', [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000c1',
        name: 'r',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(project));
    installMockFetch(
      [{ project_id: ID, name: 'Deleted Locally' }],
      new Map([[ID, buildPayload(project)]]),
    );

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
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, []);
    assert.equal(store.getState().baselines[ID], undefined, 'baseline cleared, not resurrected');
  });

  it('a project deleted on both sides is treated as agreed and cleared from the baseline', async () => {
    const ID = '018f0000-0000-7000-8000-000000000011';
    const project = cleanProject(ID, 'Deleted Both', '2026-01-01T00:00:00.000Z', []);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(project));
    // Server does NOT list the project (absent on both sides).
    installMockFetch([], new Map());

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
    assert.deepEqual(projects, []);
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, [], 'an agreed deletion is never a Conflict');
    assert.equal(
      store.getState().baselines[ID],
      undefined,
      'agreed deletion cleared from baseline',
    );
  });

  it('a server-side project deletion of a locally-unchanged project becomes a Review, not a silent removal', async () => {
    const ID = '018f0000-0000-7000-8000-000000000012';
    const project = cleanProject(ID, 'Deleted On Server', '2026-01-01T00:00:00.000Z', [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000d1',
        name: 'r',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(project));
    // Server does NOT list the project (it was deleted there); local still has it.
    installMockFetch([], new Map());

    const store = makeStore(seed);
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [project],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    // Local is preserved — the deletion is NOT silently applied.
    assert.deepEqual(
      projects.map((p) => p.project_id),
      [ID],
      'the local project is not silently removed',
    );
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.review, [ID], 'the server-side deletion is surfaced as a Review');

    const state = store.getState();
    assert.equal(state.reviews[ID].kind, 'review');
    assert.equal(state.reviews[ID].incoming, null, 'the deletion side carries no version');
    assert.ok(state.baselines[ID], 'baseline retained while the review is pending');
  });

  it('a server-side recording deletion is reviewed while sibling recordings stay converged', async () => {
    const ID = '018f0000-0000-7000-8000-000000000013';
    const KEPT = '018f0000-0000-7000-8000-0000000000e1';
    const GONE = '018f0000-0000-7000-8000-0000000000e2';
    const keptRec = {
      recording_id: KEPT,
      name: 'kept',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'k1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const goneRec = {
      recording_id: GONE,
      name: 'gone',
      created_at: '2026-01-02T00:00:00.000Z',
      steps: [{ uuid: 'g1', logical_id: 'b', step_number: 0, deleted: false }],
    };

    const agreed = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [keptRec, goneRec]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(agreed));

    // Local keeps both recordings (unchanged); the server dropped GONE.
    const local = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [keptRec, goneRec]);
    const server = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [keptRec]);
    installMockFetch([{ project_id: ID, name: 'P' }], new Map([[ID, buildPayload(server)]]));

    const store = makeStore(seed);
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
    const merged = projects.find((p) => p.project_id === ID);
    const ids = merged.recordings.map((r) => r.recording_id);
    assert.ok(
      ids.includes(GONE),
      'the server-deleted recording is preserved locally (not applied)',
    );
    assert.ok(ids.includes(KEPT), 'the converged sibling recording remains');

    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.review, [`${ID}:${GONE}`], 'only the deleted recording is reviewed');
    assert.equal(store.getState().reviews[`${ID}:${GONE}`].kind, 'review');
  });
});
