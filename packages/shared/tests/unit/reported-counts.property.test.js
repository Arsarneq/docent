/**
 * reported-counts.property.test.js — Property test that a completed sync cycle's
 * REPORTED counts equal the sets the cycle ACTUALLY produced.
 *
 * When a sync cycle completes, `sync()` returns a {@link SyncResult} carrying the
 * eight sets the UI surfaces: the projects `pushed`, the projects
 * `pulled`, the stamp-incompatible-skipped projects (`mismatched`), the errored
 * projects (`errors`), the `review` / `conflicts` `unitRef`s recorded this cycle,
 * and the `autoAppliedUpdates` / `autoAppliedDeletions` `unitRef`s applied this
 * cycle. This property pins that none of those reports drifts from reality: each
 * reported set equals exactly the set of things that actually happened in the
 * cycle.
 *
 * "Actually happened" is measured at the source for every dimension:
 *   - `pushed`     — exactly the local projects that HAD something to write
 * and whose PUT the server accepted. A project whose
 *                    only change is a deferred project-metadata change and that
 *                    has no pushable recordings is SKIPPED (no PUT at all under
 *                    the per-unit push), so it appears in neither `pushed` nor
 *                    `errors`.
 *   - `pulled`     — exactly the projects that passed BOTH safeguards (stamp
 *                    compatibility + schema validation) and were accepted.
 *   - `mismatched` — exactly the projects skipped for a docent_format stamp
 *                    mismatch (by name).
 *   - `errors`     — exactly the union of push failures (only for projects that
 *                    were actually pushed) and pull failures (schema-invalid +
 *                    non-auth fetch error), by name.
 *   - `review`     — exactly `Object.keys(state.reviews)`: the Review-and-Accept
 *                    records actually persisted in the store.
 *   - `conflicts`  — exactly `Object.keys(state.conflicts)`: the Conflict records
 *                    actually persisted in the store.
 *   - `autoAppliedUpdates`   — exactly the recording units that were a
 *                    fast-forward `changed-incoming` and were auto-applied because
 *                    Auto-Accept-Updates is ON; verified by the incoming version
 *                    landing in the merged project.
 *   - `autoAppliedDeletions` — exactly the recording units that were a
 *                    server-side deletion of a local-unchanged unit and were
 *                    auto-applied because Auto-Accept-Deletions is ON; verified by
 *                    the recording's absence from the merged project.
 *
 * The property drives the full `sync()` orchestrator (not a sub-component) over an
 * arbitrary mix of per-project FATES, so the eight dimensions are exercised
 * together and a miscount in any one is caught:
 *   - `push-only`        — local project, not on the server; pushed (or push-errored).
 *   - `brand-new`        — server-only, accepted; pulled, auto-added (no deferral).
 *   - `converged`        — local == incoming; pulled, baseline advanced (no deferral).
 *   - `changed-incoming` — local == baseline, incoming differs (project-metadata)
 *                          → a Review. Its project-metadata Unit is DEFERRED, so
 *                          under the per-unit push the project is pushed ONLY when
 *                          it still has a pushable recording.
 *   - `diverged`         — local/incoming/baseline all differ (project-metadata)
 *                          → a Conflict; same per-unit push skip rule as above.
 *   - `auto-update`      — converged project metadata + a recording that is a
 *                          fast-forward `changed-incoming` → an auto-applied update
 *                          (Auto-Accept-Updates ON); pulled and pushed.
 *   - `auto-delete`      — converged project metadata + a recording deleted on the
 *                          server with the local copy unchanged → an auto-applied
 *                          deletion (Auto-Accept-Deletions ON); pulled and pushed.
 *   - `stamp-incompatible` — server-only; skipped as `mismatched`.
 *   - `schema-invalid`   — server-only, fails the validator; reported in `errors`.
 *   - `fetch-error`      — server-only, GET 500 (non-auth); reported in `errors`.
 * Each local project independently may have its PUT rejected (a non-auth 500), so
 * `pushed` is a genuine subset of the local projects, not trivially all of them.
 *
 * Both reconciliation-policy toggles are seeded ON so the settings-gated automatic
 * outcomes actually fire: a fast-forward `changed-incoming` recording auto-applies
 * and a server-deletion of a local-unchanged recording auto-applies.
 * The toggles affect ONLY those two recording-level cases; a
 * project-METADATA `changed-incoming` still defers to Review (it is never a
 * fast-forward) and a `diverged` project is always a Conflict, so the
 * `review` / `conflicts` dimensions stay exact.
 *
 * The deferred Units use a project-metadata change (a project-name marker folded
 * into content identity) so each `changed-incoming` / `diverged` project
 * yields exactly one project-level `unitRef` (the `project_id`), keeping the
 * expected `review` / `conflicts` sets exact; their other recordings are identical
 * on every side so they never add stray deferrals. The `auto-update` /
 * `auto-delete` projects keep their metadata and sibling recordings converged so
 * each yields exactly one auto-applied recording `unitRef`.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling orchestrator
 * property tests (`makeResponse`-style Response stubs): PUT is dispatched per id
 * to model push acceptance/rejection, GET /projects serves the manifest, and
 * GET /projects/:id serves each project's payload (or a non-auth 500). A fake
 * validator rejects the schema-invalid ids; an in-memory `SyncStore` (seeded with
 * the baselines and the auto-accept settings) captures the saved `SyncState`; a
 * permissive `LiveState` lets the cycle run to completion.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard; `fc.uuid()` supplies recording ids).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Reported counts equal the sets actually produced

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { createEmptySyncState, setSettings } from '../../sync-store.js';
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
 *   - PUT (push)        → 200 when `pushOkById.get(id)` is true, else a non-auth
 *                         500 (a push rejection that lands the project in errors).
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's payload, or a non-auth 500 for the
 *                         `fetch-error` category (so the cycle must continue).
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, {category: string, payload: object|null}>} byId
 * @param {Map<string, boolean>} pushOkById
 */
function installMockFetch(manifest, byId, pushOkById) {
  globalThis.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') {
      const id = decodeURIComponent(url.split('/').pop());
      return pushOkById.get(id) ? makeResponse(200, { ok: true }) : makeResponse(500);
    }
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    const id = decodeURIComponent(url.split('/').pop());
    const entry = byId.get(id);
    if (!entry) return makeResponse(404);
    if (entry.category === 'error') return makeResponse(500); // non-auth per-project error
    return makeResponse(200, entry.payload);
  };
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore}. Seeded with an initial SyncState (the baselines
 * and settings) and captures the last saved state so the test can inspect
 * reviews / conflicts after the cycle. Clones in and out so no reference is
 * shared with the cycle.
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

/**
 * A fake platform validator. Rejects payloads whose `project.project_id` is in
 * the schema-invalid set (reported as errors after passing the stamp check);
 * accepts everything else.
 *
 * @param {Set<string>} invalidIds
 */
function makeValidator(invalidIds) {
  const validator = (payload) => !invalidIds.has(payload?.project?.project_id);
  validator.errors = [{ instancePath: '/project', message: 'stub schema rejection' }];
  return validator;
}

// ─── allowlisted projections (mirror sync-client.js exactly) ──────────────────

/** @param {object} r */
function recordingProjection(r) {
  return {
    recording_id: r.recording_id,
    name: r.name,
    created_at: r.created_at,
    steps: r.steps ?? [],
  };
}

/** @param {object} p */
function projectProjection(p) {
  return {
    project_id: p.project_id,
    name: p.name,
    created_at: p.created_at,
    recordings: (p.recordings ?? []).map(recordingProjection),
  };
}

/** Build a Full_Project_Payload around a (clean) project, with a given stamp. */
function buildPayload(project, stamp = LOCAL_STAMP) {
  return {
    docent_format: { ...stamp },
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
    },
    recordings: (project.recordings ?? []).map(recordingProjection),
  };
}

/** A stamp incompatible with LOCAL_STAMP in the requested dimension. */
function incompatibleStamp(mismatchKind) {
  return mismatchKind === 'platform'
    ? { platform: 'other-platform', schema_version: LOCAL_STAMP.schema_version }
    : { platform: LOCAL_STAMP.platform, schema_version: '9.9.9-other' };
}

/** JSON-normalize a recording spec into the allowlisted shape (plain objects). */
function cleanRecording({ recording_id, name, created_at, steps }) {
  return JSON.parse(JSON.stringify({ recording_id, name, created_at, steps }));
}

/** Assemble a clean project object from id/name/created_at and clean recordings. */
function makeProject(project_id, name, created_at, recordings) {
  return { project_id, name, created_at, recordings: recordings.map(cleanRecording) };
}

// ─── auto-apply marker recordings (updates and deletions) ──

const MARKER_CA = '2026-01-01T00:00:00.000Z';

/** The recording_id of the fast-forward (auto-update) marker for a project. */
function autoUpdateRecId(project_id) {
  return `${project_id}-au-rec`;
}

/** The recording_id of the server-deletion (auto-delete) marker for a project. */
function autoDeleteRecId(project_id) {
  return `${project_id}-ad-rec`;
}

/** A committed step record with a stable, project-derived uuid. */
function markerStep(project_id, n) {
  return { uuid: `${project_id}-s${n}`, logical_id: 'a', step_number: n, deleted: false };
}

/**
 * Local/baseline version of the fast-forward marker — one committed step. Equal
 * on the local and baseline sides so the unit classifies `changed-incoming`
 * (local unchanged from the agreed state) rather than `diverged`.
 */
function ffMarkerBase(project_id) {
  return {
    recording_id: autoUpdateRecId(project_id),
    name: 'ff',
    created_at: MARKER_CA,
    steps: [markerStep(project_id, 0)],
  };
}

/**
 * Server version of the fast-forward marker — an append-only SUPERSET of the
 * base (it retains step 0 and appends step 1), so it is a TRUE fast-forward and
 * is eligible to auto-apply when Auto-Accept-Updates is ON.
 */
function ffMarkerServer(project_id) {
  return {
    recording_id: autoUpdateRecId(project_id),
    name: 'ff',
    created_at: MARKER_CA,
    steps: [markerStep(project_id, 0), markerStep(project_id, 1)],
  };
}

/**
 * Local/baseline version of the auto-delete marker (absent on the server side).
 * Local == baseline so the server's absence classifies `deleted-remote-review`,
 * which auto-applies when Auto-Accept-Deletions is ON.
 */
function delMarker(project_id) {
  return {
    recording_id: autoDeleteRecId(project_id),
    name: 'del',
    created_at: MARKER_CA,
    steps: [markerStep(project_id, 0)],
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

/** A small, identical-on-every-side recording set for a project. */
const arbRecordings = fc.uniqueArray(
  fc.record({
    recording_id: fc.uuid(),
    name: fc.string({ maxLength: 12 }),
    created_at: arbIso,
    steps: fc.array(arbStep, { maxLength: 3 }),
  }),
  { selector: (r) => r.recording_id, maxLength: 3 },
);

/** The ten per-project fates this property mixes. */
const arbRole = fc.constantFrom(
  'push-only',
  'brand-new',
  'converged',
  'changed-incoming',
  'diverged',
  'auto-update',
  'auto-delete',
  'stamp-incompatible',
  'schema-invalid',
  'fetch-error',
);

/** One project spec: a UUIDv7 id, a fate, a push outcome, and identical recordings. */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  role: arbRole,
  pushOk: fc.boolean(),
  mismatchKind: fc.constantFrom('platform', 'version'),
  created_at: arbIso,
  recordings: arbRecordings,
});

/** A scenario: 1..10 projects with unique ids and a mix of fates. */
const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (s) => s.project_id,
  minLength: 1,
  maxLength: 10,
});

/**
 * Materialize a scenario into the inputs `sync()` needs plus the per-dimension
 * expectations. Names embed the id so every project name is globally unique,
 * which keeps `mismatched` / `errors` attribution (which is BY NAME) exact.
 *
 * Both reconciliation toggles are seeded ON so the `auto-update` / `auto-delete`
 * recording-level fates actually auto-apply; the toggles never change a
 * project-metadata `changed-incoming` (always a Review) or a `diverged` project
 * (always a Conflict).
 */
function materialize(specs) {
  const seed = createEmptySyncState();
  setSettings(seed, { autoAcceptUpdates: true, autoAcceptDeletions: true });
  const manifest = [];
  const byId = new Map();
  const pushOkById = new Map();
  const localProjects = [];
  const schemaInvalidIds = new Set();

  const expected = {
    pushed: new Set(),
    pulled: new Set(),
    review: new Set(),
    conflicts: new Set(),
    autoUpdates: new Set(),
    autoDeletions: new Set(),
    mismatchedNames: new Set(),
    errorNames: new Set(), // push failures (only for pushed projects) ∪ pull failures
  };

  /**
   * Register a local project + its push fate. `writeNeeded` reflects the
   * per-unit push decision: a project with nothing to write is NOT
   * pushed, so it lands in neither `pushed` nor `errors`.
   */
  const addLocal = (project, pushOk, writeNeeded = true) => {
    localProjects.push(project);
    pushOkById.set(project.project_id, pushOk);
    if (!writeNeeded) return; // skipped by the per-unit push — no PUT, no push error
    if (pushOk) expected.pushed.add(project.project_id);
    else expected.errorNames.add(project.name); // a rejected push lands in errors
  };

  for (const s of specs) {
    const id = s.project_id;
    const ca = s.created_at;
    const recs = s.recordings;

    switch (s.role) {
      case 'push-only': {
        // Local only (not on the server): pushed (or push-errored), never pulled.
        addLocal(makeProject(id, `local-${id}`, ca, recs), s.pushOk);
        break;
      }

      case 'brand-new': {
        // Server only, accepted: pulled and auto-added (no deferral, no local push).
        const server = makeProject(id, `srv-${id}`, ca, recs);
        manifest.push({ project_id: id, name: server.name });
        byId.set(id, { category: 'accept', payload: buildPayload(server) });
        expected.pulled.add(id);
        break;
      }

      case 'converged': {
        // local == incoming (identical): pulled, baseline advanced, no deferral.
        // The whole assembled payload equals the server's agreed-or-pulled state,
        // so the project is SKIPPED — nothing to write.
        const proj = makeProject(id, `same-${id}`, ca, recs);
        addLocal(proj, s.pushOk, false);
        manifest.push({ project_id: id, name: proj.name });
        byId.set(id, { category: 'accept', payload: buildPayload(proj) });
        expected.pulled.add(id);
        break;
      }

      case 'changed-incoming': {
        // local == baseline, incoming differs (project-metadata change) → a Review.
        // The project-metadata Unit is DEFERRED, so it re-sends the agreed-or-pulled
        // metadata; the recordings here are identical on every side (converged), so
        // each equals the server too. The whole assembled payload therefore equals
        // the server and the project is SKIPPED, regardless of recs.
        const baseProj = makeProject(id, `base-${id}`, ca, recs);
        const localProj = makeProject(id, `base-${id}`, ca, recs);
        const serverProj = makeProject(id, `srv-${id}`, ca, recs);
        advanceBaseline(seed, id, projectProjection(baseProj));
        addLocal(localProj, s.pushOk, false);
        manifest.push({ project_id: id, name: serverProj.name });
        byId.set(id, { category: 'accept', payload: buildPayload(serverProj) });
        expected.pulled.add(id);
        expected.review.add(id);
        break;
      }

      case 'diverged': {
        // local / incoming / baseline all differ (project-metadata) → a Conflict.
        // The deferred project-metadata re-sends agreed-or-pulled; the recordings
        // converge (equal the server). Whole payload equals the server ⇒ SKIPPED.
        const baseProj = makeProject(id, `base-${id}`, ca, recs);
        const localProj = makeProject(id, `loc-${id}`, ca, recs);
        const serverProj = makeProject(id, `srv-${id}`, ca, recs);
        advanceBaseline(seed, id, projectProjection(baseProj));
        addLocal(localProj, s.pushOk, false);
        manifest.push({ project_id: id, name: serverProj.name });
        byId.set(id, { category: 'accept', payload: buildPayload(serverProj) });
        expected.pulled.add(id);
        expected.conflicts.add(id);
        break;
      }

      case 'auto-update': {
        // Converged project metadata + a recording that is a fast-forward
        // `changed-incoming` → an auto-applied UPDATE (Auto-Accept-Updates ON).
        // After the auto-apply the merged recording EQUALS the server's version
        // and the sibling `recs` + metadata converge, so the whole assembled
        // payload equals the server ⇒ SKIPPED.
        const marker = ffMarkerBase(id);
        const baseProj = makeProject(id, `au-${id}`, ca, [marker, ...recs]);
        const localProj = makeProject(id, `au-${id}`, ca, [marker, ...recs]);
        const serverProj = makeProject(id, `au-${id}`, ca, [ffMarkerServer(id), ...recs]);
        advanceBaseline(seed, id, projectProjection(baseProj));
        addLocal(localProj, s.pushOk, false);
        manifest.push({ project_id: id, name: serverProj.name });
        byId.set(id, { category: 'accept', payload: buildPayload(serverProj) });
        expected.pulled.add(id);
        expected.autoUpdates.add(`${id}:${autoUpdateRecId(id)}`);
        break;
      }

      case 'auto-delete': {
        // Converged project metadata + a recording absent on the server with the
        // local copy unchanged → an auto-applied DELETION (Auto-Accept-Deletions
        // ON). After the deletion the merged project equals the server (marker
        // absent on both, siblings + metadata converge) ⇒ SKIPPED.
        const marker = delMarker(id);
        const baseProj = makeProject(id, `ad-${id}`, ca, [marker, ...recs]);
        const localProj = makeProject(id, `ad-${id}`, ca, [marker, ...recs]);
        const serverProj = makeProject(id, `ad-${id}`, ca, recs); // marker ABSENT on server
        advanceBaseline(seed, id, projectProjection(baseProj));
        addLocal(localProj, s.pushOk, false);
        manifest.push({ project_id: id, name: serverProj.name });
        byId.set(id, { category: 'accept', payload: buildPayload(serverProj) });
        expected.pulled.add(id);
        expected.autoDeletions.add(`${id}:${autoDeleteRecId(id)}`);
        break;
      }

      case 'stamp-incompatible': {
        // Server only, incompatible stamp → skipped as `mismatched` (by name).
        const server = makeProject(id, `proj-${id}`, ca, recs);
        manifest.push({ project_id: id, name: server.name });
        byId.set(id, {
          category: 'stamp',
          payload: buildPayload(server, incompatibleStamp(s.mismatchKind)),
        });
        expected.mismatchedNames.add(server.name);
        break;
      }

      case 'schema-invalid': {
        // Server only, compatible stamp but fails the validator → reported in errors.
        const server = makeProject(id, `proj-${id}`, ca, recs);
        manifest.push({ project_id: id, name: server.name });
        byId.set(id, { category: 'schema', payload: buildPayload(server) });
        schemaInvalidIds.add(id);
        expected.errorNames.add(server.name);
        break;
      }

      case 'fetch-error': {
        // Server only, GET 500 (non-auth) → reported in errors.
        const name = `proj-${id}`;
        manifest.push({ project_id: id, name });
        byId.set(id, { category: 'error', payload: null });
        expected.errorNames.add(name);
        break;
      }

      default:
        break;
    }
  }

  return { seed, manifest, byId, pushOkById, localProjects, schemaInvalidIds, expected };
}

/** Sorted array helper for set comparisons. */
function sorted(iterable) {
  return [...iterable].sort();
}

/** Find a project by id within a merged-projects list, or null when absent. */
function findProject(projects, project_id) {
  return projects.find((p) => p.project_id === project_id) ?? null;
}

/** Split a unitRef into project_id and (optional) recording_id (first colon). */
function parseRef(ref) {
  const i = ref.indexOf(':');
  return i === -1 ? { pid: ref, rid: null } : { pid: ref.slice(0, i), rid: ref.slice(i + 1) };
}

describe('Reported counts equal the sets actually produced', () => {
  it('reports pushed / pulled / mismatched / errors / review / conflicts / autoAppliedUpdates / autoAppliedDeletions equal to the sets the cycle actually produced', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (specs) => {
        const { seed, manifest, byId, pushOkById, localProjects, schemaInvalidIds, expected } =
          materialize(specs);
        installMockFetch(manifest, byId, pushOkById);

        const store = makeStore(seed);
        const validator = makeValidator(schemaInvalidIds);

        const { result, projects } = await sync(
          'https://srv.test',
          null,
          localProjects,
          STUB_SCHEMA,
          validator,
          store,
          makeLiveState(),
        );

        // No auth failure / no live-work gate → the cycle runs to completion.
        assert.equal(result.halted, false, 'a non-auth cycle never halts');
        assert.equal(result.haltReason, null);

        const state = store.getState();

        // ── review / conflicts — the reported sets equal what is ACTUALLY in the
        // store (the durable Review / Conflict records produced this cycle). ──
        assert.deepEqual(
          sorted(result.review),
          sorted(Object.keys(state.reviews)),
          'reported review equals the Review records actually in state',
        );
        assert.deepEqual(
          sorted(result.conflicts),
          sorted(Object.keys(state.conflicts)),
          'reported conflicts equals the Conflict records actually in state',
        );

        // ── every reported set equals the set the scenario actually produced. ──
        assert.deepEqual(sorted(result.pushed), sorted(expected.pushed), 'pushed set is exact');
        assert.deepEqual(sorted(result.pulled), sorted(expected.pulled), 'pulled set is exact');
        assert.deepEqual(
          sorted(result.mismatched.map((e) => e.projectName)),
          sorted(expected.mismatchedNames),
          'mismatched set is exact',
        );
        assert.deepEqual(
          sorted(result.errors.map((e) => e.projectName)),
          sorted(expected.errorNames),
          'errors set is exact',
        );
        assert.deepEqual(sorted(result.review), sorted(expected.review), 'review set is exact');
        assert.deepEqual(
          sorted(result.conflicts),
          sorted(expected.conflicts),
          'conflicts set is exact',
        );
        assert.deepEqual(
          sorted(result.autoAppliedUpdates),
          sorted(expected.autoUpdates),
          'autoAppliedUpdates set is exact',
        );
        assert.deepEqual(
          sorted(result.autoAppliedDeletions),
          sorted(expected.autoDeletions),
          'autoAppliedDeletions set is exact',
        );

        // ── each auto-applied UPDATE actually landed the incoming version in the
        // merged project (the server's fast-forward marker has two steps). ──
        for (const ref of result.autoAppliedUpdates) {
          const { pid, rid } = parseRef(ref);
          const proj = findProject(projects, pid);
          assert.ok(proj, `auto-applied update ${ref} keeps its project in the merged list`);
          const rec = (proj.recordings ?? []).find((r) => r.recording_id === rid);
          assert.ok(rec, `auto-applied update ${ref} keeps its recording in the merged list`);
          assert.equal(
            (rec.steps ?? []).length,
            2,
            'the auto-applied update carries the incoming (fast-forward) version',
          );
        }

        // ── each auto-applied DELETION actually removed the recording from the
        // merged project (while the project itself remains). ──
        for (const ref of result.autoAppliedDeletions) {
          const { pid, rid } = parseRef(ref);
          const proj = findProject(projects, pid);
          assert.ok(proj, `auto-applied deletion ${ref} keeps its project in the merged list`);
          assert.ok(
            !(proj.recordings ?? []).some((r) => r.recording_id === rid),
            'the auto-applied deletion removed the recording from the merged project',
          );
        }

        // ── the COUNTS equal the set sizes. ──
        assert.equal(result.pushed.length, expected.pushed.size, 'pushed count');
        assert.equal(result.pulled.length, expected.pulled.size, 'pulled count');
        assert.equal(result.mismatched.length, expected.mismatchedNames.size, 'mismatched count');
        assert.equal(result.errors.length, expected.errorNames.size, 'errors count');
        assert.equal(result.review.length, Object.keys(state.reviews).length, 'review count');
        assert.equal(
          result.conflicts.length,
          Object.keys(state.conflicts).length,
          'conflicts count',
        );
        assert.equal(
          result.autoAppliedUpdates.length,
          expected.autoUpdates.size,
          'autoAppliedUpdates count',
        );
        assert.equal(
          result.autoAppliedDeletions.length,
          expected.autoDeletions.size,
          'autoAppliedDeletions count',
        );
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression example: one of every fate at once ─────────────

  it('reports each dimension exactly for a mix of all ten fates', async () => {
    const PUSH_ONLY = '018f0000-0000-7000-8000-000000000001';
    const BRAND_NEW = '018f0000-0000-7000-8000-000000000002';
    const CONVERGED = '018f0000-0000-7000-8000-000000000003';
    const CHANGED = '018f0000-0000-7000-8000-000000000004';
    const DIVERGED = '018f0000-0000-7000-8000-000000000005';
    const STAMP_BAD = '018f0000-0000-7000-8000-000000000006';
    const SCHEMA_BAD = '018f0000-0000-7000-8000-000000000007';
    const FETCH_BAD = '018f0000-0000-7000-8000-000000000008';
    const PUSH_FAIL = '018f0000-0000-7000-8000-000000000009';
    const AUTO_UPD = '018f0000-0000-7000-8000-00000000000a';
    const AUTO_DEL = '018f0000-0000-7000-8000-00000000000b';

    const ca = '2026-01-01T00:00:00.000Z';
    const recs = [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000a1',
        name: 'r',
        created_at: ca,
        steps: [],
      },
    ];

    const pushOnly = makeProject(PUSH_ONLY, `local-${PUSH_ONLY}`, ca, recs);
    const pushFail = makeProject(PUSH_FAIL, `local-${PUSH_FAIL}`, ca, recs);
    const converged = makeProject(CONVERGED, `same-${CONVERGED}`, ca, recs);
    const changedLocal = makeProject(CHANGED, `base-${CHANGED}`, ca, recs);
    const changedServer = makeProject(CHANGED, `srv-${CHANGED}`, ca, recs);
    const divergedLocal = makeProject(DIVERGED, `loc-${DIVERGED}`, ca, recs);
    const divergedBase = makeProject(DIVERGED, `base-${DIVERGED}`, ca, recs);
    const divergedServer = makeProject(DIVERGED, `srv-${DIVERGED}`, ca, recs);
    const brandNew = makeProject(BRAND_NEW, `srv-${BRAND_NEW}`, ca, recs);
    const stampBad = makeProject(STAMP_BAD, `proj-${STAMP_BAD}`, ca, recs);
    const schemaBad = makeProject(SCHEMA_BAD, `proj-${SCHEMA_BAD}`, ca, recs);

    // auto-update: converged metadata + a fast-forward changed-incoming recording.
    const autoUpdLocal = makeProject(AUTO_UPD, `au-${AUTO_UPD}`, ca, [ffMarkerBase(AUTO_UPD)]);
    const autoUpdServer = makeProject(AUTO_UPD, `au-${AUTO_UPD}`, ca, [ffMarkerServer(AUTO_UPD)]);
    // auto-delete: converged metadata + a recording deleted on the server.
    const autoDelLocal = makeProject(AUTO_DEL, `ad-${AUTO_DEL}`, ca, [delMarker(AUTO_DEL)]);
    const autoDelServer = makeProject(AUTO_DEL, `ad-${AUTO_DEL}`, ca, []);

    const seed = createEmptySyncState();
    setSettings(seed, { autoAcceptUpdates: true, autoAcceptDeletions: true });
    advanceBaseline(seed, CHANGED, projectProjection(changedLocal)); // local == baseline
    advanceBaseline(seed, DIVERGED, projectProjection(divergedBase));
    advanceBaseline(seed, AUTO_UPD, projectProjection(autoUpdLocal));
    advanceBaseline(seed, AUTO_DEL, projectProjection(autoDelLocal));

    const localProjects = [
      pushOnly,
      pushFail,
      converged,
      changedLocal,
      divergedLocal,
      autoUpdLocal,
      autoDelLocal,
    ];
    const pushOkById = new Map([
      [PUSH_ONLY, true],
      [PUSH_FAIL, false],
      [CONVERGED, true],
      [CHANGED, true],
      [DIVERGED, true],
      [AUTO_UPD, true],
      [AUTO_DEL, true],
    ]);
    const manifest = [
      { project_id: BRAND_NEW, name: brandNew.name },
      { project_id: CONVERGED, name: converged.name },
      { project_id: CHANGED, name: changedServer.name },
      { project_id: DIVERGED, name: divergedServer.name },
      { project_id: AUTO_UPD, name: autoUpdServer.name },
      { project_id: AUTO_DEL, name: autoDelServer.name },
      { project_id: STAMP_BAD, name: stampBad.name },
      { project_id: SCHEMA_BAD, name: schemaBad.name },
      { project_id: FETCH_BAD, name: `proj-${FETCH_BAD}` },
    ];
    const byId = new Map([
      [BRAND_NEW, { category: 'accept', payload: buildPayload(brandNew) }],
      [CONVERGED, { category: 'accept', payload: buildPayload(converged) }],
      [CHANGED, { category: 'accept', payload: buildPayload(changedServer) }],
      [DIVERGED, { category: 'accept', payload: buildPayload(divergedServer) }],
      [AUTO_UPD, { category: 'accept', payload: buildPayload(autoUpdServer) }],
      [AUTO_DEL, { category: 'accept', payload: buildPayload(autoDelServer) }],
      [
        STAMP_BAD,
        { category: 'stamp', payload: buildPayload(stampBad, incompatibleStamp('platform')) },
      ],
      [SCHEMA_BAD, { category: 'schema', payload: buildPayload(schemaBad) }],
      [FETCH_BAD, { category: 'error', payload: null }],
    ]);
    installMockFetch(manifest, byId, pushOkById);

    const store = makeStore(seed);
    const { result, projects } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      makeValidator(new Set([SCHEMA_BAD])),
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);

    assert.deepEqual(
      sorted(result.pushed),
      sorted([PUSH_ONLY]),
      'pushed = only the local-only project whose PUT succeeded and content-differs; converged / changed-incoming / diverged / auto-applied all equal the server and are skipped',
    );
    assert.deepEqual(
      sorted(result.pulled),
      sorted([BRAND_NEW, CONVERGED, CHANGED, DIVERGED, AUTO_UPD, AUTO_DEL]),
      'pulled = the accepted projects',
    );
    assert.deepEqual(
      result.mismatched.map((e) => e.projectName),
      [stampBad.name],
    );
    assert.deepEqual(
      sorted(result.errors.map((e) => e.projectName)),
      sorted([`local-${PUSH_FAIL}`, schemaBad.name, `proj-${FETCH_BAD}`]),
      'errors = push failure ∪ schema-invalid ∪ fetch error',
    );
    assert.deepEqual(result.review, [CHANGED], 'review = the changed-incoming project');
    assert.deepEqual(result.conflicts, [DIVERGED], 'conflicts = the diverged project');
    assert.deepEqual(
      result.autoAppliedUpdates,
      [`${AUTO_UPD}:${autoUpdateRecId(AUTO_UPD)}`],
      'autoAppliedUpdates = the fast-forward changed-incoming recording',
    );
    assert.deepEqual(
      result.autoAppliedDeletions,
      [`${AUTO_DEL}:${autoDeleteRecId(AUTO_DEL)}`],
      'autoAppliedDeletions = the server-deleted recording',
    );

    // The auto-applied update landed the incoming (two-step) version; the
    // auto-applied deletion removed the recording from the merged project.
    const mergedUpd = findProject(projects, AUTO_UPD);
    const updRec = mergedUpd.recordings.find((r) => r.recording_id === autoUpdateRecId(AUTO_UPD));
    assert.equal(updRec.steps.length, 2, 'the auto-applied update carries the incoming version');
    const mergedDel = findProject(projects, AUTO_DEL);
    assert.ok(
      !mergedDel.recordings.some((r) => r.recording_id === autoDeleteRecId(AUTO_DEL)),
      'the auto-applied deletion removed the recording from the merged project',
    );

    const state = store.getState();
    assert.deepEqual(sorted(result.review), sorted(Object.keys(state.reviews)));
    assert.deepEqual(sorted(result.conflicts), sorted(Object.keys(state.conflicts)));
  });
});
