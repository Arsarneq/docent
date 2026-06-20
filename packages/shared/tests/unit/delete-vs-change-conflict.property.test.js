/**
 * delete-vs-change-conflict.property.test.js — Property test that a sync cycle
 * defers a DELETE-vs-CHANGE Unit to the user as a Conflict, driving the full
 * `sync()` orchestrator over a large space of delete-vs-change scenarios.
 *
 * The data model has step-level tombstones but NO recording-level or
 * project-level tombstone, so a Unit "absent on a side but present in the
 * Sync_Baseline" is a deliberate deletion. When the OTHER side changed that same
 * Unit since the baseline, neither answer is safe automatically: re-adding it
 * would resurrect a deletion, dropping it would discard the change. The cycle
 * must therefore record a `conflict-delete-vs-change` Conflict and apply NO
 * outcome — the choice between keeping the changed version and accepting the
 * deletion is the user's, made later through Conflict_Resolution.
 *
 * Two directions, each at BOTH granularities (project-level and recording-level):
 *
 *   - local-deleted / server-changed — present in the baseline, absent
 *     locally, and CHANGED on the server (incoming != baseline): a Conflict whose
 *     LOCAL (deletion) side carries no version (null) and whose INCOMING side
 *     retains the changed server version.
 *   - server-deleted / local-changed — present in the baseline, CHANGED
 *     locally, and absent on the server (incoming == null): a Conflict whose
 *     INCOMING (deletion) side carries no version (null) and whose LOCAL side
 *     retains the changed local version.
 *
 * For every delete-vs-change Unit the property pins that the cycle:
 *   - records exactly ONE Conflict (its unitRef is in `result.conflicts` and in
 *     `state.conflicts`), never a Review (mutual exclusion);
 *   - retains the changed side and stores `null` for the deletion side;
 *   - leaves LOCAL data unchanged — a locally-deleted Unit is NOT resurrected and
 *     a server-deleted (locally-changed) Unit is NOT silently removed;
 *   - leaves the BASELINE unchanged (the conflict is deferred, not propagated);
 *   - never halts and never auto-resolves.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / `deletion-propagation`
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

// Delete-vs-change is a conflict deferred to the user

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

// ─── fetch double (mirrors sync-client.test.js / deletion-propagation) ───────

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

/** A validator that accepts every payload (delete-vs-change handling is the focus). */
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
 * Deep, JSON-normalized copy — matches the deep clone the store/baseline apply to
 * every retained version, so `deepStrictEqual` compares like-for-like (plain
 * objects, no null-prototype records).
 */
function cleanCopy(value) {
  return JSON.parse(JSON.stringify(value));
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
 * step records. In production every recording crosses JSON on the wire and in
 * the store, so this matches the real data path.
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

/**
 * A content change that is GUARANTEED to differ from the original: appending a
 * marker to the (digest-folded) name always yields a different canonical digest
 * (name is part of Unit identity), so the changed side reliably diverges
 * from the baseline.
 */
const CHANGE_MARKER = '\u0394'; // "Δ"

// ─── Block A — project-level delete-vs-change (both directions) ───────────────

/**
 * A whole project present in the baseline (the last-agreed state) that realizes
 * one delete-vs-change direction:
 *   - 'local-deleted'  — absent locally; present + CHANGED on the server.
 *   - 'server-deleted' — present + CHANGED locally; absent on the server.
 */
const arbProjectDvcSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  name: fc.string({ maxLength: 20 }),
  created_at: arbIso,
  recordings: fc.uniqueArray(arbRecording, { selector: (r) => r.recording_id, maxLength: 3 }),
  direction: fc.constantFrom('local-deleted', 'server-deleted'),
});

const arbProjectDvcScenario = fc.uniqueArray(arbProjectDvcSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 6,
});

/**
 * Materialize a project-level delete-vs-change scenario: every project is seeded
 * into the baseline as the last-agreed state, then one side is deleted while the
 * other side is changed, per its direction.
 */
function materializeProjectScenario(specs) {
  const seed = createEmptySyncState();
  const payloadById = new Map();
  const manifest = [];
  const localProjects = [];
  const expectations = [];

  for (const s of specs) {
    const agreed = cleanProject(s.project_id, s.name, s.created_at, s.recordings);
    advanceBaseline(seed, s.project_id, projectProjection(agreed));

    const changed = cleanProject(s.project_id, s.name + CHANGE_MARKER, s.created_at, s.recordings);

    if (s.direction === 'local-deleted') {
      // Absent locally; present + CHANGED on the server (incoming != baseline).
      payloadById.set(s.project_id, buildPayload(changed));
      manifest.push({ project_id: s.project_id, name: changed.name });
      expectations.push({
        project_id: s.project_id,
        direction: s.direction,
        expectedLocal: null,
        expectedIncoming: cleanCopy(projectProjection(changed)),
        expectedBaseline: cleanCopy(projectProjection(agreed)),
      });
    } else {
      // server-deleted: present + CHANGED locally; absent on the server.
      localProjects.push(changed);
      expectations.push({
        project_id: s.project_id,
        direction: s.direction,
        expectedLocal: cleanCopy(projectProjection(changed)),
        expectedIncoming: null,
        expectedBaseline: cleanCopy(projectProjection(agreed)),
      });
    }
  }

  return { seed, payloadById, manifest, localProjects, expectations };
}

describe('Delete-vs-change is a conflict deferred to the user', () => {
  it('project-level: delete-vs-change records a deferred Conflict, retains the changed side, and never applies an outcome', async () => {
    await fc.assert(
      fc.asyncProperty(arbProjectDvcScenario, async (specs) => {
        const { seed, payloadById, manifest, localProjects, expectations } =
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

        assert.equal(result.halted, false, 'a delete-vs-change outcome never halts');
        assert.equal(result.haltReason, null);
        assert.deepEqual(result.review, [], 'a delete-vs-change Unit is never a Review');
        // Every delete-vs-change project is reported as a Conflict, and nothing else is.
        assert.deepEqual(
          [...result.conflicts].sort(),
          expectations.map((e) => e.project_id).sort(),
          'exactly the delete-vs-change projects are surfaced as Conflicts',
        );

        const state = store.getState();
        const mergedById = new Map(projects.map((p) => [p.project_id, p]));

        for (const exp of expectations) {
          const { project_id } = exp;

          // ── A durable Conflict is recorded (never a Review). ──
          const conflict = state.conflicts?.[project_id];
          assert.ok(conflict, `delete-vs-change ${project_id} must record a Conflict`);
          assert.equal(conflict.kind, 'conflict');
          assert.equal(conflict.recording_id, null, 'a project-level conflict has no recording_id');
          assert.equal(
            state.reviews?.[project_id],
            undefined,
            'review and conflict are mutually exclusive',
          );

          // ── The deletion side carries no version; the changed side is retained. ──
          assert.deepEqual(
            conflict.local,
            exp.expectedLocal,
            'the local version (null when deleted locally) is retained as-is',
          );
          assert.deepEqual(
            conflict.incoming,
            exp.expectedIncoming,
            'the incoming version (null when deleted on the server) is retained as-is',
          );

          // ── Local data is unchanged: no outcome is applied automatically. ──
          if (exp.direction === 'local-deleted') {
            assert.ok(
              !mergedById.has(project_id),
              'a locally-deleted project is NOT resurrected into the merged list',
            );
          } else {
            const merged = mergedById.get(project_id);
            assert.ok(merged, 'a server-deleted project is NOT silently removed from local');
            assert.deepEqual(
              cleanCopy(projectProjection(merged)),
              exp.expectedLocal,
              'the local project is preserved unchanged (the deletion is not applied)',
            );
          }

          // ── The baseline is unchanged: the conflict is deferred, not propagated. ──
          const baseline = state.baselines?.[project_id];
          assert.ok(baseline, 'the baseline is retained while the conflict is pending');
          assert.deepEqual(
            baseline.agreedState,
            exp.expectedBaseline,
            'the baseline still holds the last-agreed state (neither cleared nor advanced)',
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  // ─── Block B — recording-level delete-vs-change (both directions) ───────────

  /**
   * A project present on BOTH sides (so the detector descends into recordings),
   * carrying a converged sibling recording plus one delete-vs-change target.
   * Direction selects which side deleted the target and which side changed it.
   */
  const arbRecordingDvcSpec = fc.record({
    project_id: fc.uuid({ version: 7 }),
    pname: fc.string({ maxLength: 20 }),
    created_at: arbIso,
    // Exactly two distinct recordings: [0] = converged sibling, [1] = target.
    recs: fc.uniqueArray(arbRecording, {
      selector: (r) => r.recording_id,
      minLength: 2,
      maxLength: 2,
    }),
    direction: fc.constantFrom('local-deleted', 'server-deleted'),
  });

  const arbRecordingDvcScenario = fc.uniqueArray(arbRecordingDvcSpec, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 4,
  });

  /**
   * Materialize a recording-level delete-vs-change scenario. The project metadata
   * is identical across local/server/baseline (so it converges and is never a
   * project-level conflict), the sibling recording is identical everywhere (so it
   * is already-converged and omitted), and only the target recording realizes the
   * delete-vs-change direction.
   */
  function materializeRecordingScenario(specs) {
    const seed = createEmptySyncState();
    const payloadById = new Map();
    const manifest = [];
    const localProjects = [];
    const expectations = [];

    for (const s of specs) {
      const sibling = cleanRecording(s.recs[0]);
      const targetOriginal = cleanRecording(s.recs[1]);
      const targetChanged = cleanRecording({ ...s.recs[1], name: s.recs[1].name + CHANGE_MARKER });
      const unitRef = `${s.project_id}:${targetOriginal.recording_id}`;

      // Baseline (last agreed): the project with [sibling, targetOriginal].
      const agreed = cleanProject(s.project_id, s.pname, s.created_at, [sibling, targetOriginal]);
      advanceBaseline(seed, s.project_id, projectProjection(agreed));

      if (s.direction === 'local-deleted') {
        // Local dropped the target ([sibling]); the server CHANGED it.
        localProjects.push(cleanProject(s.project_id, s.pname, s.created_at, [sibling]));
        payloadById.set(
          s.project_id,
          buildPayload(cleanProject(s.project_id, s.pname, s.created_at, [sibling, targetChanged])),
        );
        manifest.push({ project_id: s.project_id, name: s.pname });
        expectations.push({
          project_id: s.project_id,
          unitRef,
          direction: s.direction,
          siblingId: sibling.recording_id,
          targetId: targetOriginal.recording_id,
          expectedLocal: null,
          expectedIncoming: cleanCopy(recordingProjection(targetChanged)),
          expectedBaseline: cleanCopy(projectProjection(agreed)),
        });
      } else {
        // server-deleted: local CHANGED the target; the server dropped it.
        localProjects.push(
          cleanProject(s.project_id, s.pname, s.created_at, [sibling, targetChanged]),
        );
        payloadById.set(
          s.project_id,
          buildPayload(cleanProject(s.project_id, s.pname, s.created_at, [sibling])),
        );
        manifest.push({ project_id: s.project_id, name: s.pname });
        expectations.push({
          project_id: s.project_id,
          unitRef,
          direction: s.direction,
          siblingId: sibling.recording_id,
          targetId: targetOriginal.recording_id,
          expectedLocal: cleanCopy(recordingProjection(targetChanged)),
          expectedIncoming: null,
          expectedBaseline: cleanCopy(projectProjection(agreed)),
        });
      }
    }

    return { seed, payloadById, manifest, localProjects, expectations };
  }

  it('recording-level: delete-vs-change records a deferred Conflict while the converged sibling still reconciles', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecordingDvcScenario, async (specs) => {
        const { seed, payloadById, manifest, localProjects, expectations } =
          materializeRecordingScenario(specs);
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
        assert.equal(result.haltReason, null);
        assert.deepEqual(result.review, [], 'a delete-vs-change recording is never a Review');
        assert.deepEqual(
          [...result.conflicts].sort(),
          expectations.map((e) => e.unitRef).sort(),
          'exactly the delete-vs-change recordings are surfaced as Conflicts',
        );

        const state = store.getState();
        const byId = new Map(projects.map((p) => [p.project_id, p]));

        for (const exp of expectations) {
          // ── A durable, recording-level Conflict is recorded (never a Review). ──
          const conflict = state.conflicts?.[exp.unitRef];
          assert.ok(conflict, `delete-vs-change recording ${exp.unitRef} must record a Conflict`);
          assert.equal(conflict.kind, 'conflict');
          assert.equal(conflict.recording_id, exp.targetId);
          assert.equal(
            state.reviews?.[exp.unitRef],
            undefined,
            'review and conflict are mutually exclusive',
          );

          // ── The deletion side carries no version; the changed side is retained. ──
          assert.deepEqual(conflict.local, exp.expectedLocal, 'local version retained as-is');
          assert.deepEqual(
            conflict.incoming,
            exp.expectedIncoming,
            'incoming version retained as-is',
          );

          const merged = byId.get(exp.project_id);
          assert.ok(merged, 'the project remains present');
          const mergedRecIds = new Set(merged.recordings.map((r) => r.recording_id));

          // The converged sibling is always reconciled/kept while the target defers.
          assert.ok(mergedRecIds.has(exp.siblingId), 'the converged sibling recording remains');

          // ── Local data unchanged: no outcome is applied automatically. ──
          if (exp.direction === 'local-deleted') {
            assert.ok(
              !mergedRecIds.has(exp.targetId),
              'a locally-deleted recording is NOT resurrected into local',
            );
          } else {
            assert.ok(
              mergedRecIds.has(exp.targetId),
              'a server-deleted (locally-changed) recording is NOT silently removed',
            );
            const mergedTarget = merged.recordings.find((r) => r.recording_id === exp.targetId);
            assert.deepEqual(
              cleanCopy(recordingProjection(mergedTarget)),
              exp.expectedLocal,
              'the local recording is preserved unchanged (the deletion is not applied)',
            );
          }

          // ── Baseline unchanged: still holds the sibling AND the original target. ──
          const baseline = state.baselines?.[exp.project_id];
          assert.ok(baseline, 'the baseline is retained while the conflict is pending');
          assert.deepEqual(
            baseline.agreedState,
            exp.expectedBaseline,
            'the baseline still holds the last-agreed state (neither cleared nor advanced)',
          );
        }
      }),
      { numRuns: 150 },
    );
  });

  // ─── Deterministic regression examples (one per direction × granularity) ─────

  it('project-level: deleted locally, changed on the server → a deferred Conflict, local not resurrected', async () => {
    const ID = '018f0000-0000-7000-8000-000000000020';
    const agreed = cleanProject(ID, 'Agreed', '2026-01-01T00:00:00.000Z', [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000a1',
        name: 'r',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ]);
    const changed = cleanProject(ID, 'Agreed (server edit)', '2026-01-01T00:00:00.000Z', [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000a1',
        name: 'r',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(agreed));
    installMockFetch(
      [{ project_id: ID, name: changed.name }],
      new Map([[ID, buildPayload(changed)]]),
    );

    const store = makeStore(seed);
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [], // absent locally
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, [ID]);
    assert.deepEqual(projects, [], 'the locally-deleted project is not re-added');

    const state = store.getState();
    const conflict = state.conflicts[ID];
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.local, null, 'the deletion (local) side carries no version');
    assert.deepEqual(
      conflict.incoming,
      cleanCopy(projectProjection(changed)),
      'the changed server version is retained',
    );
    assert.deepEqual(
      state.baselines[ID].agreedState,
      cleanCopy(projectProjection(agreed)),
      'baseline unchanged',
    );
  });

  it('project-level: deleted on the server, changed locally → a deferred Conflict, local preserved', async () => {
    const ID = '018f0000-0000-7000-8000-000000000021';
    const agreed = cleanProject(ID, 'Agreed', '2026-01-01T00:00:00.000Z', [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000b1',
        name: 'r',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ]);
    const changedLocal = cleanProject(ID, 'Agreed (local edit)', '2026-01-01T00:00:00.000Z', [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000b1',
        name: 'r',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(agreed));
    // Server does NOT list the project (it was deleted there); local still has it (changed).
    installMockFetch([], new Map());

    const store = makeStore(seed);
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [changedLocal],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, [ID]);
    assert.deepEqual(
      projects.map((p) => p.project_id),
      [ID],
      'the local project is not silently removed',
    );
    assert.deepEqual(
      cleanCopy(projectProjection(projects[0])),
      cleanCopy(projectProjection(changedLocal)),
      'the local project is preserved unchanged',
    );

    const state = store.getState();
    const conflict = state.conflicts[ID];
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.incoming, null, 'the deletion (server) side carries no version');
    assert.deepEqual(
      conflict.local,
      cleanCopy(projectProjection(changedLocal)),
      'the changed local version is retained',
    );
    assert.deepEqual(
      state.baselines[ID].agreedState,
      cleanCopy(projectProjection(agreed)),
      'baseline unchanged',
    );
  });

  it('recording-level: deleted locally, changed on the server → a deferred Conflict, sibling still converges', async () => {
    const ID = '018f0000-0000-7000-8000-000000000022';
    const SIB = '018f0000-0000-7000-8000-0000000000c1';
    const TGT = '018f0000-0000-7000-8000-0000000000c2';
    const sibling = {
      recording_id: SIB,
      name: 'sibling',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const targetOriginal = {
      recording_id: TGT,
      name: 'target',
      created_at: '2026-01-02T00:00:00.000Z',
      steps: [],
    };
    const targetChanged = {
      recording_id: TGT,
      name: 'target (server edit)',
      created_at: '2026-01-02T00:00:00.000Z',
      steps: [],
    };

    const agreed = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [sibling, targetOriginal]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(agreed));

    const local = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [sibling]); // target deleted on disk
    const server = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [sibling, targetChanged]);
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

    const unitRef = `${ID}:${TGT}`;
    assert.equal(result.halted, false);
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, [unitRef]);

    const merged = projects.find((p) => p.project_id === ID);
    const ids = merged.recordings.map((r) => r.recording_id);
    assert.ok(ids.includes(SIB), 'the converged sibling recording remains');
    assert.ok(!ids.includes(TGT), 'the locally-deleted recording is not resurrected');

    const state = store.getState();
    const conflict = state.conflicts[unitRef];
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.recording_id, TGT);
    assert.equal(conflict.local, null, 'the deletion (local) side carries no version');
    assert.deepEqual(
      conflict.incoming,
      cleanCopy(recordingProjection(targetChanged)),
      'the changed server recording is retained',
    );
    // Baseline still holds both the sibling and the ORIGINAL target.
    const baselineRecIds = state.baselines[ID].agreedState.recordings.map((r) => r.recording_id);
    assert.deepEqual([...baselineRecIds].sort(), [SIB, TGT].sort(), 'baseline unchanged');
  });

  it('recording-level: deleted on the server, changed locally → a deferred Conflict, local recording preserved', async () => {
    const ID = '018f0000-0000-7000-8000-000000000023';
    const SIB = '018f0000-0000-7000-8000-0000000000d1';
    const TGT = '018f0000-0000-7000-8000-0000000000d2';
    const sibling = {
      recording_id: SIB,
      name: 'sibling',
      created_at: '2026-01-01T00:00:00.000Z',
      steps: [],
    };
    const targetOriginal = {
      recording_id: TGT,
      name: 'target',
      created_at: '2026-01-02T00:00:00.000Z',
      steps: [],
    };
    const targetChanged = {
      recording_id: TGT,
      name: 'target (local edit)',
      created_at: '2026-01-02T00:00:00.000Z',
      steps: [],
    };

    const agreed = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [sibling, targetOriginal]);
    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, projectProjection(agreed));

    const local = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [sibling, targetChanged]); // changed locally
    const server = cleanProject(ID, 'P', '2026-01-01T00:00:00.000Z', [sibling]); // deleted on server
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

    const unitRef = `${ID}:${TGT}`;
    assert.equal(result.halted, false);
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, [unitRef]);

    const merged = projects.find((p) => p.project_id === ID);
    const ids = merged.recordings.map((r) => r.recording_id);
    assert.ok(ids.includes(SIB), 'the converged sibling recording remains');
    assert.ok(
      ids.includes(TGT),
      'the server-deleted (locally-changed) recording is not silently removed',
    );
    const mergedTarget = merged.recordings.find((r) => r.recording_id === TGT);
    assert.deepEqual(
      cleanCopy(recordingProjection(mergedTarget)),
      cleanCopy(recordingProjection(targetChanged)),
      'local recording preserved unchanged',
    );

    const state = store.getState();
    const conflict = state.conflicts[unitRef];
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.recording_id, TGT);
    assert.equal(conflict.incoming, null, 'the deletion (server) side carries no version');
    assert.deepEqual(
      conflict.local,
      cleanCopy(recordingProjection(targetChanged)),
      'the changed local recording is retained',
    );
    const baselineRecIds = state.baselines[ID].agreedState.recordings.map((r) => r.recording_id);
    assert.deepEqual([...baselineRecIds].sort(), [SIB, TGT].sort(), 'baseline unchanged');
  });
});
