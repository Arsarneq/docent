/**
 * no-discard-no-overwrite.property.test.js — Property test that a full sync cycle
 * DISCARDS NOTHING and OVERWRITES NOTHING without resolution, driving the real
 * `sync()` orchestrator over an arbitrary mix of project- and recording-level
 * fates.
 *
 * The whole feature exists to replace the legacy silent server-wins merge, where
 * a pulled project could overwrite committed local work. Property 17 pins the
 * three guarantees that replace it (R9):
 *
 *   - R9.1 — pulled data lands in a retained `Sync_Snapshot` keyed by
 *     `project_id`, rather than overwriting local data directly. Every accepted
 *     incoming project is therefore recoverable from the snapshot map after the
 *     cycle, and the local list is never blindly replaced.
 *   - R9.2 — no local or incoming version is discarded except as the explicit
 *     outcome of the (separate, user-driven) Conflict_Resolution workflow. A sync
 *     cycle runs no resolution, so NOTHING may be discarded: every committed
 *     local version that existed before the cycle is still recoverable afterwards
 *     (it is kept in the merged local list), and every incoming version is
 *     retained (as a snapshot, and additionally on the Review/Conflict record).
 *   - R9.5 — for any Unit deferred to Review-and-Accept or Conflict, the LOCAL
 *     data is preserved byte-identical (no incoming change is applied to it).
 *
 * The property exercises a rich mix of fates so the invariant is not an artifact
 * of one shape. Whole-project fates: `converged`, `brand-new` (server only),
 * `local-only` (no baseline, never pushed back inbound), `remote-deleted`
 * (project absent on the server → Review). `descend` projects are present on both
 * sides with a per-project metadata fate (`converged` / `changed-incoming` /
 * `diverged`) plus recordings each carrying a fate (`converged`, `brand-new`,
 * `changed-incoming`, `diverged`, `remote-deleted`). Deterministic regression
 * examples additionally cover the delete-vs-change Conflict cases (R19.2, R19.4)
 * that the generator does not produce.
 *
 * After the cycle the test asserts, across every fate:
 *   (A) the cycle completes (no halt — the live-work gate is permissive);
 *   (B) every accepted pulled project landed in `state.snapshots` byte-equal to
 *       its allowlisted projection (R9.1 — retained, not applied over local);
 *   (C) every committed local version that existed before the cycle is still
 *       present in the merged list, byte-identical (R9.2 — nothing discarded);
 *   (D) for every deferred Unit (Review or Conflict) the local data is unchanged
 *       and both versions are retained in recoverable form (R9.5, R9.2).
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / `brand-new-auto-add` /
 * `deletion-propagation` (`makeResponse`-style Response stubs) and dispatches per
 * project_id; the validator passes; an in-memory `SyncStore` (seeded with the
 * baselines) captures the saved `SyncState`; a permissive `LiveState` (capture
 * inactive, nothing locked, nothing pending) lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * **Validates: Requirements 9.1, 9.2, 9.5**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 17: A sync cycle discards nothing and overwrites nothing without resolution

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
 *   - GET /projects     → the manifest array (server-present projects only).
 *   - GET /projects/:id → the project's Full_Project_Payload.
 *
 * A project absent on the server side is simply not in the manifest and has no
 * payload, so the pull never returns it (incoming === null for it).
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
 * In-memory {@link SyncStore}, optionally seeded with an initial SyncState and
 * capturing the last saved state so the test can inspect snapshots / baselines /
 * reviews / conflicts after the cycle. Clones on the way in and out so no
 * reference is shared with the cycle.
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

/** A validator that accepts every payload (the no-loss invariant is the focus). */
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

/** The project's own scalar identity (no recordings). */
function metaSkeleton(p) {
  return {
    project_id: p.project_id,
    name: p.name,
    created_at: p.created_at,
    ...(p.metadata && { metadata: p.metadata }),
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

/** Split a unitRef into project_id and (optional) recording_id (first colon). */
function parseRef(ref) {
  const i = ref.indexOf(':');
  if (i === -1) return { pid: ref, rid: null };
  return { pid: ref.slice(0, i), rid: ref.slice(i + 1) };
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
 * A recording spec. `steps` and `created_at` are SHARED across the recording's
 * three role variants (base / local / server) so digest variance comes purely
 * from the role-dependent `name` (computed by {@link recName}) — which is what
 * makes each fate's classification deterministic.
 */
const arbRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  created_at: arbIso,
  steps: fc.array(arbStep, { maxLength: 3 }),
  fate: fc.constantFrom('converged', 'brand-new', 'changed-incoming', 'diverged', 'remote-deleted'),
});

/**
 * A project spec. `descend` projects are present on both sides; their metadata
 * fate plus their recordings' fates drive the per-Unit classifications.
 */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  created_at: arbIso,
  fate: fc.constantFrom('converged', 'brand-new', 'local-only', 'remote-deleted', 'descend'),
  metaFate: fc.constantFrom('converged', 'changed-incoming', 'diverged'),
  recordings: fc.uniqueArray(arbRecordingSpec, { selector: (r) => r.recording_id, maxLength: 4 }),
});

const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 5,
});

// ─── content-by-role helpers ──────────────────────────────────────────────────

/**
 * The recording `name` for a given role, encoding the fate's three-way content
 * relationship. `null` means the recording is ABSENT on that side. Equal names
 * ⇒ equal digests (recording_id / created_at / steps are shared), so:
 *   - converged        — same name everywhere (local == server == baseline)
 *   - changed-incoming — local == baseline, server differs
 *   - diverged         — all three distinct
 *   - remote-deleted   — base == local, server absent
 *   - brand-new        — server only, no base / no local
 *
 * @param {{recording_id: string, fate: string}} spec
 * @param {'base'|'local'|'server'} role
 * @returns {string|null}
 */
function recName(spec, role) {
  const rid = spec.recording_id;
  switch (spec.fate) {
    case 'converged':
      return `${rid}-conv`;
    case 'changed-incoming':
      return role === 'server' ? `${rid}-ci-srv` : `${rid}-ci`;
    case 'diverged':
      return `${rid}-div-${role}`;
    case 'remote-deleted':
      return role === 'server' ? null : `${rid}-rd`;
    case 'brand-new':
      return role === 'server' ? `${rid}-bn` : null;
    default:
      return null;
  }
}

/** The project `name` for a given role, per its metadata fate. */
function projName(pid, metaFate, role) {
  switch (metaFate) {
    case 'changed-incoming':
      return role === 'server' ? `${pid}-meta-srv` : `${pid}-meta`;
    case 'diverged':
      return `${pid}-meta-${role}`;
    case 'converged':
    default:
      return `${pid}-meta`;
  }
}

/**
 * Build the clean recording for a role, or `null` when absent. JSON-normalized so
 * nested step records are plain objects (fast-check builds null-prototype
 * records, which `deepStrictEqual` treats as unequal to the JSON-cloned copies
 * the store/baseline produce). In production every recording crosses JSON on the
 * wire and in the store, so this matches the real data path.
 */
function buildRec(spec, role) {
  const name = recName(spec, role);
  if (name == null) return null;
  return JSON.parse(
    JSON.stringify({
      recording_id: spec.recording_id,
      name,
      created_at: spec.created_at,
      steps: spec.steps,
    }),
  );
}

/** Build a clean project object for a role from already-built recordings. */
function buildProj(pid, name, created_at, recordings) {
  return { project_id: pid, name, created_at, recordings };
}

/** Collect a role's recordings (dropping the absent ones). */
function recsForRole(specs, role) {
  return specs.map((s) => buildRec(s, role)).filter((r) => r != null);
}

/**
 * Materialize a scenario into the `sync()` inputs (seeded store, mock fetch) plus
 * the derived expectations: the local projects passed in, and the server-side
 * projections expected to land in the snapshot map.
 */
function materialize(specs) {
  const seed = createEmptySyncState();
  const payloadById = new Map();
  const manifest = [];
  const localProjects = [];
  /** @type {Map<string, object>} server-present clean projects, by id */
  const expectedServerById = new Map();

  for (const s of specs) {
    const pid = s.project_id;

    if (s.fate === 'converged') {
      // Present + equal on both sides, with a matching baseline. Build three
      // independent (but content-identical) instances so no reference is shared.
      const name = `${pid}-conv`;
      const local = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'base'));
      const server = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'base'));
      const baseline = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'base'));
      advanceBaseline(seed, pid, projectProjection(baseline));
      localProjects.push(local);
      payloadById.set(pid, buildPayload(server));
      manifest.push({ project_id: pid, name });
      expectedServerById.set(pid, server);
      continue;
    }

    if (s.fate === 'brand-new') {
      // Server only — no local, no baseline.
      const name = `${pid}-bn`;
      const server = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'server'));
      payloadById.set(pid, buildPayload(server));
      manifest.push({ project_id: pid, name });
      expectedServerById.set(pid, server);
      continue;
    }

    if (s.fate === 'local-only') {
      // Local only — no baseline, never returned by the server.
      const name = `${pid}-lo`;
      localProjects.push(buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'local')));
      continue;
    }

    if (s.fate === 'remote-deleted') {
      // Local + baseline, absent on the server (whole-project server deletion).
      const name = `${pid}-rd`;
      const local = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'local'));
      const baseline = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'local'));
      advanceBaseline(seed, pid, projectProjection(baseline));
      localProjects.push(local);
      continue;
    }

    // s.fate === 'descend' — present on both sides + baseline, with per-Unit fates.
    const local = buildProj(
      pid,
      projName(pid, s.metaFate, 'local'),
      s.created_at,
      recsForRole(s.recordings, 'local'),
    );
    const server = buildProj(
      pid,
      projName(pid, s.metaFate, 'server'),
      s.created_at,
      recsForRole(s.recordings, 'server'),
    );
    const baseline = buildProj(
      pid,
      projName(pid, s.metaFate, 'base'),
      s.created_at,
      recsForRole(s.recordings, 'base'),
    );
    advanceBaseline(seed, pid, projectProjection(baseline));
    localProjects.push(local);
    payloadById.set(pid, buildPayload(server));
    manifest.push({ project_id: pid, name: server.name });
    expectedServerById.set(pid, server);
  }

  return { seed, payloadById, manifest, localProjects, expectedServerById };
}

// ─── Property 17 ──────────────────────────────────────────────────────────────

describe('Property 17: A sync cycle discards nothing and overwrites nothing without resolution', () => {
  it('retains pulled data in snapshots, discards no local version, and leaves deferred local data unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (specs) => {
        const { seed, payloadById, manifest, localProjects, expectedServerById } =
          materialize(specs);
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

        // (A) The cycle completes — the live-work gate is permissive and a sync
        // cycle never runs resolution, so it must not halt.
        assert.equal(result.halted, false, 'a permissive sync cycle never halts');
        assert.equal(result.haltReason, null);

        const state = store.getState();
        const mergedById = new Map(projects.map((p) => [p.project_id, p]));
        const localById = new Map(localProjects.map((p) => [p.project_id, p]));

        // (B) R9.1 — every accepted pulled project landed in a retained snapshot,
        // byte-equal to its allowlisted projection, rather than overwriting local.
        for (const [pid, server] of expectedServerById) {
          const snap = state.snapshots?.[pid];
          assert.ok(snap, `pulled project ${pid} must land in a Sync_Snapshot (R9.1)`);
          assert.deepEqual(
            snap.payload,
            projectProjection(server),
            'the snapshot retains the incoming version verbatim',
          );
        }

        // (C) R9.2 — every committed local version that existed before the cycle
        // is still recoverable: present in the merged list, byte-identical. A
        // sync cycle runs no resolution, so nothing may be discarded.
        for (const lp of localProjects) {
          const mp = mergedById.get(lp.project_id);
          assert.ok(mp, `local project ${lp.project_id} must not be discarded`);
          assert.deepEqual(
            metaSkeleton(mp),
            metaSkeleton(lp),
            'local project identity is never overwritten',
          );
          for (const lr of lp.recordings) {
            const mr = mp.recordings.find((r) => r.recording_id === lr.recording_id);
            assert.ok(mr, `local recording ${lr.recording_id} must not be discarded`);
            assert.deepEqual(
              recordingProjection(mr),
              recordingProjection(lr),
              'local recording is preserved byte-identical (not overwritten)',
            );
          }
        }

        // (D) R9.5 / R9.2 — for every deferred Unit the local data is unchanged
        // and both versions are retained in recoverable form.
        const assertLocalUnchanged = (ref) => {
          const { pid, rid } = parseRef(ref);
          const lp = localById.get(pid);
          if (!lp) return; // no local counterpart (e.g. a remote-only deferral)
          const mp = mergedById.get(pid);
          assert.ok(mp, `merged project ${pid} for a deferred Unit must exist`);
          if (rid == null) {
            assert.deepEqual(
              metaSkeleton(mp),
              metaSkeleton(lp),
              'deferred project metadata is preserved unchanged (R9.5)',
            );
          } else {
            const lr = lp.recordings.find((r) => r.recording_id === rid);
            if (!lr) return; // local side absent (delete-vs-change R19.2)
            const mr = mp.recordings.find((r) => r.recording_id === rid);
            assert.ok(mr, `deferred local recording ${rid} must remain in the merged project`);
            assert.deepEqual(
              recordingProjection(mr),
              recordingProjection(lr),
              'deferred recording local data is preserved unchanged (R9.5)',
            );
          }
        };

        for (const ref of result.review) {
          const item = state.reviews?.[ref];
          assert.ok(item, `Review record for ${ref} must be retained`);
          assert.ok('incoming' in item, 'the incoming version is retained on the Review record');
          assertLocalUnchanged(ref);
        }
        for (const ref of result.conflicts) {
          const item = state.conflicts?.[ref];
          assert.ok(item, `Conflict record for ${ref} must be retained`);
          assert.ok(
            'local' in item && 'incoming' in item,
            'both versions are retained on the Conflict record (R9.2)',
          );
          assertLocalUnchanged(ref);
        }

        // Review and Conflict are mutually exclusive — no version is ambiguously
        // tracked, which is part of "nothing discarded".
        for (const ref of result.review) {
          assert.equal(state.conflicts?.[ref], undefined, 'a deferred Unit is review XOR conflict');
        }
      }),
      { numRuns: 200 },
    );
  });

  // ─── Deterministic regression examples ──────────────────────────────────────

  it('a diverged recording keeps local byte-identical, retains both versions, and snapshots the incoming (R9.1, R9.2, R9.5)', async () => {
    const PID = '018f0000-0000-7000-8000-000000000201';
    const RID = '018f0000-0000-7000-8000-0000000000a1';
    const created = '2026-01-01T00:00:00.000Z';
    const mk = (name, sn) => ({
      recording_id: RID,
      name,
      created_at: created,
      steps: [{ uuid: sn, logical_id: 'a', step_number: 0, deleted: false }],
    });

    const baseRec = mk('base', 's-base');
    const localRec = mk('local', 's-local');
    const serverRec = mk('server', 's-server');

    const baseline = buildProj(PID, `${PID}-meta`, created, [baseRec]);
    const local = buildProj(PID, `${PID}-meta`, created, [localRec]);
    const server = buildProj(PID, `${PID}-meta`, created, [serverRec]);

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baseline));
    installMockFetch(
      [{ project_id: PID, name: server.name }],
      new Map([[PID, buildPayload(server)]]),
    );

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
    const ref = `${PID}:${RID}`;
    assert.deepEqual(result.conflicts, [ref], 'the diverged recording is a Conflict');
    assert.deepEqual(result.review, []);

    // Local preserved byte-identical (R9.5).
    const merged = projects.find((p) => p.project_id === PID);
    const mergedRec = merged.recordings.find((r) => r.recording_id === RID);
    assert.deepEqual(recordingProjection(mergedRec), recordingProjection(localRec));

    const state = store.getState();
    // Incoming retained as a snapshot (R9.1) AND on the conflict record (R9.2).
    assert.deepEqual(state.snapshots[PID].payload, projectProjection(server));
    assert.deepEqual(state.conflicts[ref].local, recordingProjection(localRec));
    assert.deepEqual(state.conflicts[ref].incoming, recordingProjection(serverRec));
  });

  it('a changed-incoming recording leaves local untouched and retains the incoming snapshot (R9.1, R9.5)', async () => {
    const PID = '018f0000-0000-7000-8000-000000000202';
    const RID = '018f0000-0000-7000-8000-0000000000b1';
    const created = '2026-01-01T00:00:00.000Z';
    const mk = (name) => ({ recording_id: RID, name, created_at: created, steps: [] });

    const agreedRec = mk('agreed'); // base == local
    const serverRec = mk('server-changed');
    const baseline = buildProj(PID, `${PID}-meta`, created, [agreedRec]);
    const local = buildProj(PID, `${PID}-meta`, created, [mk('agreed')]);
    const server = buildProj(PID, `${PID}-meta`, created, [serverRec]);

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baseline));
    installMockFetch(
      [{ project_id: PID, name: server.name }],
      new Map([[PID, buildPayload(server)]]),
    );

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
    const ref = `${PID}:${RID}`;
    assert.deepEqual(result.review, [ref], 'the changed-incoming recording is a Review');
    assert.deepEqual(result.conflicts, []);

    // Local untouched: the incoming change is NOT applied (R9.5).
    const merged = projects.find((p) => p.project_id === PID);
    const mergedRec = merged.recordings.find((r) => r.recording_id === RID);
    assert.deepEqual(recordingProjection(mergedRec), recordingProjection(mk('agreed')));

    const state = store.getState();
    assert.deepEqual(state.snapshots[PID].payload, projectProjection(server));
    assert.deepEqual(state.reviews[ref].incoming, recordingProjection(serverRec));
  });

  it('delete-vs-change (deleted locally, changed on server) records a Conflict retaining the incoming (R9.2, R19.2)', async () => {
    const PID = '018f0000-0000-7000-8000-000000000203';
    const RID = '018f0000-0000-7000-8000-0000000000c1';
    const created = '2026-01-01T00:00:00.000Z';
    const mk = (name) => ({ recording_id: RID, name, created_at: created, steps: [] });

    const baseRec = mk('agreed');
    const serverRec = mk('server-changed'); // changed vs baseline
    const baseline = buildProj(PID, `${PID}-meta`, created, [baseRec]);
    const local = buildProj(PID, `${PID}-meta`, created, []); // recording deleted locally
    const server = buildProj(PID, `${PID}-meta`, created, [serverRec]);

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baseline));
    installMockFetch(
      [{ project_id: PID, name: server.name }],
      new Map([[PID, buildPayload(server)]]),
    );

    const store = makeStore(seed);
    const { result } = await sync(
      'https://srv.test',
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    const ref = `${PID}:${RID}`;
    assert.deepEqual(result.conflicts, [ref], 'delete-vs-change is a Conflict');

    const state = store.getState();
    // Local side was absent (deleted) → null; the incoming change is retained,
    // never discarded (R9.2). The pulled project is also snapshotted (R9.1).
    assert.equal(state.conflicts[ref].local, null, 'the deleted local side carries no version');
    assert.deepEqual(state.conflicts[ref].incoming, recordingProjection(serverRec));
    assert.deepEqual(state.snapshots[PID].payload, projectProjection(server));
  });

  it('delete-vs-change (deleted on server, changed locally) keeps local recoverable in the conflict (R9.2, R9.5, R19.4)', async () => {
    const PID = '018f0000-0000-7000-8000-000000000204';
    const RID = '018f0000-0000-7000-8000-0000000000d1';
    const created = '2026-01-01T00:00:00.000Z';
    const mk = (name) => ({ recording_id: RID, name, created_at: created, steps: [] });

    const baseRec = mk('agreed');
    const localRec = mk('local-changed'); // changed vs baseline
    const baseline = buildProj(PID, `${PID}-meta`, created, [baseRec]);
    const local = buildProj(PID, `${PID}-meta`, created, [localRec]);
    const server = buildProj(PID, `${PID}-meta`, created, []); // recording deleted on server

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baseline));
    installMockFetch(
      [{ project_id: PID, name: server.name }],
      new Map([[PID, buildPayload(server)]]),
    );

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
    const ref = `${PID}:${RID}`;
    assert.deepEqual(result.conflicts, [ref], 'delete-vs-change is a Conflict');

    // Local is preserved byte-identical (the server deletion is NOT applied).
    const merged = projects.find((p) => p.project_id === PID);
    const mergedRec = merged.recordings.find((r) => r.recording_id === RID);
    assert.deepEqual(recordingProjection(mergedRec), recordingProjection(localRec));

    const state = store.getState();
    // Local retained on the conflict; the deleted server side carries no version.
    assert.deepEqual(state.conflicts[ref].local, recordingProjection(localRec));
    assert.equal(state.conflicts[ref].incoming, null, 'the deleted server side carries no version');
  });
});
