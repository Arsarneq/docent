/**
 * abort-on-unretainable.property.test.js — Property test that an inability to
 * retain a version in recoverable form ABORTS the operation while PRESERVING
 * state, at both points a version is retained:
 *
 *   1. RECORDING a Conflict, inside the `sync()` orchestrator. When the
 *      Conflict_Detector classifies a Unit as `diverged`, the cycle records a
 *      Conflict by retaining recoverable (deep-cloned) copies of BOTH versions
 *      (`upsertConflict`). If a version cannot be retained — its deep clone
 *      throws — the ENTIRE sync aborts: it returns `halted: true` with
 *      `haltReason: 'internal-error'`, the durable store is left exactly as it
 *      was (it is never saved), and the caller is handed back the unchanged
 *      local projects (no partial merge).
 *
 *   2. RESOLVING a Conflict, inside `resolveConflict`. If the chosen resolved
 *      version cannot be retained (its deep clone throws), or it cannot be
 *      applied (a recording-level Conflict whose local project is absent), the
 *      resolution aborts with `ok: false`, `reason: 'apply-failed'`, the whole
 *      SyncState left byte-for-byte unchanged, the Conflict still pending, and
 *      the local projects array unchanged.
 *
 * ── How "a version cannot be retained" is forced deterministically ───────────
 * Retention is a JSON round-trip (`JSON.parse(JSON.stringify(version))`) — the
 * same clone strategy used across sync-store.js / sync-baseline.js /
 * conflict-resolution.js. A value is unretainable iff `JSON.stringify` throws on
 * it. This test forces that via a `metadata` object whose INHERITED (prototype)
 * `toJSON` throws:
 *
 *   - The classification digest canonicalizes through `canonicalForm`, which
 *     rebuilds objects from their OWN enumerable keys only — so the inherited
 *     `toJSON` is dropped and DETECTION SUCCEEDS (the Unit is classified
 *     `diverged`).
 *   - `deepCopy`'s `JSON.stringify` walks the prototype chain, finds `toJSON`,
 *     invokes it, and THROWS — so the version passes detection but CANNOT BE
 *     RETAINED when the Conflict is recorded.
 *
 * This isolates the abort to the retention step rather than the digest —
 * the abort-on-unretainable path of cycle atomicity (sync-protocol SP-19). For the
 * resolution facet, where no digest precedes the clone, an unclonable
 * `resolvedState` (a `BigInt` field, or the same throwing-`toJSON` metadata) is
 * sufficient on its own.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling
 * orchestrator property tests; an in-memory `SyncStore` (seeded with baselines
 * and unrelated durable state) captures whether/what was saved; a permissive
 * `LiveState` lets the cycle reach detection.
 *
 * Uses the Node.js built-in test runner + fast-check v4 (`fc.uuid({ version: 7 })`
 * for project ids that pass the manifest's UUIDv7 guard; `fc.uuid()` for
 * recording ids).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Inability to retain a version aborts (recording or resolving), preserving state

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { resolveConflict, itemKind } from '../../conflict-resolution.js';
import { classifyProject } from '../../conflict-detector.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { createEmptySyncState, upsertConflict, upsertReview, getItem } from '../../sync-store.js';
import { advanceBaseline, getBaseline } from '../../sync-baseline.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

const CA = '2024-01-01T00:00:00.000Z';
// A fixed clock so every `detectedAt` / `agreedAt` stamp is deterministic; the
// property asserts nothing about its value, only that state is preserved.
const FIXED_NOW = () => 0;

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

// ─── The unretainable value ───────────────────────────────────────────────────

/**
 * Build a `metadata` object that PASSES the classification digest but CANNOT be
 * retained as a recoverable copy. Its `toJSON` lives on the PROTOTYPE (inherited,
 * non-own): `canonicalForm` (used by the digest) rebuilds objects from own
 * enumerable keys only, so it drops the inherited `toJSON` and the digest
 * succeeds; `JSON.stringify` (used by `deepCopy`) walks the prototype chain,
 * invokes `toJSON`, and throws — so retaining this version fails.
 *
 * @param {string} tag - own enumerable content so the object is non-empty
 * @returns {object}
 */
function makeUnretainableMetadata(tag) {
  const proto = {
    toJSON() {
      throw new Error('unretainable: this version cannot be serialized into a recoverable copy');
    },
  };
  const metadata = Object.create(proto);
  metadata.tag = tag;
  return metadata;
}

// ─── fetch double (mirrors sync-client.test.js) ──────────────────────────────

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Installs a mock `fetch` serving a manifest plus per-project payloads keyed by
 * project_id. PUT (push) → 200; GET /projects → manifest; GET /projects/:id →
 * the project's Full_Project_Payload.
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
 * In-memory {@link SyncStore} that tracks whether `save` was ever called and
 * keeps the last persisted state. Clones in and out so no reference is shared.
 * On an abort the store must NEVER be saved, so `getSaveCount()` stays 0 and
 * `getState()` equals the seeded state.
 *
 * @param {import('../../sync-types.js').SyncState} initial
 */
function makeTrackingStore(initial) {
  let saved = structuredClone(initial);
  let saveCount = 0;
  return {
    async load() {
      return structuredClone(saved);
    },
    async save(state) {
      saveCount += 1;
      saved = structuredClone(state);
    },
    getState() {
      return saved;
    },
    getSaveCount() {
      return saveCount;
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

/** A validator that accepts every payload (retention failure is the focus). */
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

/** Deep, plain-prototype copy via a JSON round-trip. */
function jsonNormalize(value) {
  return JSON.parse(JSON.stringify(value));
}

// ════════════════════════════════════════════════════════════════════════════
//  Facet 1 — RECORDING a Conflict: an unretainable version aborts the whole sync
// ════════════════════════════════════════════════════════════════════════════

// A clean (server-/baseline-side) recording version carrying a content marker.
function recVersion(recording_id, marker) {
  return { recording_id, name: marker, created_at: CA, steps: [] };
}

/**
 * Materialize a sync-abort scenario. The target project has a `diverged`
 * recording (markers base/loc/srv, all distinct) whose LOCAL version carries
 * unretainable metadata, so recording the Conflict for it must throw and abort
 * the whole cycle. Optionally a CLEAN diverged sibling recording is placed
 * BEFORE it, so a Conflict is recorded in-memory before the throw — proving that
 * in-memory progress is discarded (the store is never saved). The seed also
 * carries unrelated durable state (another baseline, a pre-existing Conflict and
 * Review, a Snapshot) that must be preserved verbatim across the abort.
 */
function materializeSyncAbort(scenario) {
  const { project_id, recording_id } = scenario;
  const cleanRecId = scenario.cleanRecId;
  const includeClean = scenario.includeCleanDiverged && cleanRecId !== recording_id;

  const seed = createEmptySyncState();

  // ── Target project's agreed baseline (markers 'base'/'base2') ──
  const baselineRecs = [];
  if (includeClean) baselineRecs.push(recVersion(cleanRecId, 'base2'));
  baselineRecs.push(recVersion(recording_id, 'base'));
  const agreedProject = { project_id, name: 'P', created_at: CA, recordings: baselineRecs };
  advanceBaseline(seed, project_id, projectProjection(agreedProject), FIXED_NOW);

  // ── Unrelated durable state that MUST survive the abort ──
  const otherPid = scenario.otherProjectId;
  if (scenario.includeOtherState && otherPid !== project_id) {
    advanceBaseline(
      seed,
      otherPid,
      { project_id: otherPid, name: 'Other', created_at: CA, recordings: [] },
      FIXED_NOW,
    );
    seed.snapshots[otherPid] = {
      payload: { project_id: otherPid, name: 'Other', created_at: CA, recordings: [] },
      pulledAt: CA,
    };
    upsertReview(
      seed,
      otherPid,
      { project_id: otherPid, name: 'Other (incoming)', created_at: CA, recordings: [] },
      FIXED_NOW,
    );
    const otherConflictRef = `${otherPid}:${scenario.otherRecId}`;
    upsertConflict(
      seed,
      otherConflictRef,
      recVersion(scenario.otherRecId, 'pre-local'),
      recVersion(scenario.otherRecId, 'pre-incoming'),
      FIXED_NOW,
    );
  }

  // The seeded durable state is entirely clean (no unretainable metadata lives in
  // the store), so it can be snapshotted for the "preserved verbatim" assertion.
  const seededJson = JSON.stringify(seed);

  // ── Local projects (the only place the unretainable metadata lives) ──
  const localRecs = [];
  if (includeClean) localRecs.push(recVersion(cleanRecId, 'loc2'));
  // The poison local recording: its metadata's inherited toJSON throws on clone.
  localRecs.push({
    recording_id,
    name: 'loc',
    created_at: CA,
    steps: [],
    metadata: makeUnretainableMetadata('local'),
  });
  const localProject = { project_id, name: 'P', created_at: CA, recordings: localRecs };
  const localProjects = [localProject];

  // ── Server (incoming) project — clean (markers 'srv'/'srv2') ──
  const serverRecs = [];
  if (includeClean) serverRecs.push(recVersion(cleanRecId, 'srv2'));
  serverRecs.push(recVersion(recording_id, 'srv'));
  const serverProject = { project_id, name: 'P', created_at: CA, recordings: serverRecs };

  const manifest = [{ project_id, name: 'P' }];
  const payloadById = new Map([[project_id, buildPayload(serverProject)]]);

  return {
    seed,
    seededJson,
    localProjects,
    localProject,
    serverProject,
    manifest,
    payloadById,
    poisonUnitRef: `${project_id}:${recording_id}`,
    project_id,
    recording_id,
  };
}

const arbSyncAbort = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recording_id: fc.uuid(),
  includeCleanDiverged: fc.boolean(),
  cleanRecId: fc.uuid(),
  includeOtherState: fc.boolean(),
  otherProjectId: fc.uuid({ version: 7 }),
  otherRecId: fc.uuid(),
});

describe('(recording): an unretainable version aborts the whole sync, preserving all durable state', () => {
  it('aborts with halted/internal-error, never saves the store, and returns the unchanged local projects', async () => {
    await fc.assert(
      fc.asyncProperty(arbSyncAbort, async (scenario) => {
        const m = materializeSyncAbort(scenario);
        const store = makeTrackingStore(m.seed);
        installMockFetch(m.manifest, m.payloadById);

        const { result, projects } = await sync(
          'https://srv.test',
          null,
          m.localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );

        // ── The cycle aborts/blocks ──
        assert.equal(result.halted, true, 'an unretainable version must halt the cycle');
        assert.equal(result.haltReason, 'internal-error', 'the halt reason is internal-error');
        // The abort produces no deferral sets and no pulled ids.
        assert.deepEqual(result.conflicts, [], 'no conflicts are reported on an abort');
        assert.deepEqual(result.review, [], 'no reviews are reported on an abort');
        assert.deepEqual(result.pulled, [], 'no pulled ids are reported on an abort');

        // ── The durable store is preserved verbatim — it was NEVER saved ──
        assert.equal(store.getSaveCount(), 0, 'the store must never be saved on an abort');
        assert.equal(
          JSON.stringify(store.getState()),
          m.seededJson,
          'every baseline / snapshot / review / conflict is preserved verbatim',
        );

        // ── No partial merge: the caller gets the unchanged local projects ──
        assert.equal(projects, m.localProjects, 'the unchanged local projects array is returned');
        assert.equal(projects.length, 1);
        assert.equal(projects[0].project_id, m.project_id);
        const poisonRec = projects[0].recordings.find((r) => r.recording_id === m.recording_id);
        assert.ok(poisonRec, 'the local recording is still present');
        assert.equal(
          poisonRec.name,
          'loc',
          'the local recording is unchanged (no version applied)',
        );
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression: detection SUCCEEDS, the abort is at retention ──

  it('the unretainable version PASSES detection (classified diverged) but aborts when the Conflict is recorded', async () => {
    const PID = '018f0000-0000-7000-8000-000000000201';
    const RID = '018f0000-0000-7000-8000-0000000000c1';

    const seed = createEmptySyncState();
    const agreedProject = {
      project_id: PID,
      name: 'P',
      created_at: CA,
      recordings: [recVersion(RID, 'base')],
    };
    advanceBaseline(seed, PID, projectProjection(agreedProject), FIXED_NOW);
    const seededJson = JSON.stringify(seed);
    const store = makeTrackingStore(seed);

    const localProject = {
      project_id: PID,
      name: 'P',
      created_at: CA,
      recordings: [
        {
          recording_id: RID,
          name: 'loc',
          created_at: CA,
          steps: [],
          metadata: makeUnretainableMetadata('local'),
        },
      ],
    };
    const serverProject = {
      project_id: PID,
      name: 'P',
      created_at: CA,
      recordings: [recVersion(RID, 'srv')],
    };

    // DETECTION SUCCEEDS: the digest drops the inherited toJSON, so the poison
    // recording is classified `diverged` (the clone has not been attempted yet).
    const baseline = getBaseline(seed, PID);
    const classes = classifyProject(localProject, serverProject, baseline, new Set());
    const poisonClass = classes.find((c) => c.recording_id === RID);
    assert.ok(poisonClass, 'the poison recording is classified');
    assert.equal(poisonClass.kind, 'diverged', 'detection succeeds and classifies it diverged');

    // SYNC ABORTS: recording the Conflict tries to RETAIN the version and throws.
    installMockFetch(
      [{ project_id: PID, name: 'P' }],
      new Map([[PID, buildPayload(serverProject)]]),
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

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'internal-error');
    assert.equal(store.getSaveCount(), 0, 'the store must never be saved');
    assert.equal(JSON.stringify(store.getState()), seededJson, 'durable state preserved verbatim');
    // No partial merge: the caller is handed back the unchanged local projects.
    assert.deepEqual(projects, [localProject], 'the unchanged local projects array is returned');
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Facet 2 — RESOLVING a Conflict: an unretainable/unapplicable resolution
//            aborts (apply-failed), leaving the Conflict and all state unchanged
// ════════════════════════════════════════════════════════════════════════════

const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 10 }),
  deleted: fc.boolean(),
});
const arbSteps = fc.array(arbStep, { maxLength: 4 });

function recCopy(recording_id, nameSuffix, steps) {
  return { recording_id, name: `rec-${nameSuffix}`, created_at: CA, steps };
}
function projCopy(project_id, nameSuffix, recordings) {
  return { project_id, name: `proj-${nameSuffix}`, created_at: CA, recordings };
}

/**
 * Prepend a guaranteed, uniquely-identified step so a history is never empty —
 * giving the keep/merge superset (for the missing-project case) something
 * concrete to retain on both sides.
 */
function withGuaranteed(prefix, recording_id, steps) {
  return [
    { uuid: `${prefix}-${recording_id}`, logical_id: 'a', step_number: 0, deleted: false },
    ...steps,
  ];
}

const arbResolveAbort = fc.record({
  // 'unclonable-bigint' / 'unclonable-tojson' — the chosen resolved version
  //   cannot be retained (its deep clone throws) ⇒ apply-failed.
  // 'missing-project'    — a recording-level Conflict whose local project is
  //   absent: the (clonable, append-only-superset) resolved version cannot be
  //   APPLIED ⇒ apply-failed.
  mechanism: fc.constantFrom('unclonable-bigint', 'unclonable-tojson', 'missing-project'),
  level: fc.constantFrom('recording', 'project'),
  project_id: fc.uuid(),
  recording_id: fc.uuid(),
  localSteps: arbSteps,
  incomingSteps: arbSteps,
  includeOther: fc.boolean(),
  otherProjectId: fc.uuid(),
});

/**
 * Materialize a resolution-abort scenario: seed a Conflict (with clonable,
 * recoverable copies) plus an unrelated Review that must survive, and build the
 * inputs for the chosen failure mechanism.
 */
function materializeResolveAbort(scenario) {
  const { project_id, recording_id } = scenario;
  // 'missing-project' is meaningful only at recording granularity (a
  // project-level resolve appends the project when absent, so it never fails to
  // apply for a missing project).
  const level = scenario.mechanism === 'missing-project' ? 'recording' : scenario.level;

  const localSteps = withGuaranteed('L', recording_id, scenario.localSteps);
  const incomingSteps = withGuaranteed('I', recording_id, scenario.incomingSteps);

  const unitRef = level === 'recording' ? `${project_id}:${recording_id}` : project_id;

  const localVer =
    level === 'recording'
      ? recCopy(recording_id, 'local', localSteps)
      : projCopy(project_id, 'local', [recCopy(recording_id, 'local', localSteps)]);
  const incomingVer =
    level === 'recording'
      ? recCopy(recording_id, 'incoming', incomingSteps)
      : projCopy(project_id, 'incoming', [recCopy(recording_id, 'incoming', incomingSteps)]);

  const state = createEmptySyncState();
  upsertConflict(state, unitRef, jsonNormalize(localVer), jsonNormalize(incomingVer), FIXED_NOW);

  // An unrelated, project-level Review that must be untouched by any outcome.
  const otherRef = scenario.otherProjectId;
  const hasOther = scenario.includeOther && otherRef !== unitRef && otherRef !== project_id;
  if (hasOther) {
    upsertReview(state, otherRef, jsonNormalize(projCopy(otherRef, 'other', [])), FIXED_NOW);
  }

  // The target local project (present unless the missing-project mechanism).
  const targetProject = projCopy(project_id, 'localproj', [
    recCopy(recording_id, 'local', localSteps),
  ]);

  let projects;
  let resolvedState;
  const mergedSteps = [...localSteps, ...incomingSteps];

  if (scenario.mechanism === 'missing-project') {
    projects = jsonNormalize([]); // no local project to apply the resolution into
    resolvedState = jsonNormalize(recCopy(recording_id, 'merged', mergedSteps)); // valid superset
  } else {
    projects = jsonNormalize([targetProject]);
    const base =
      level === 'recording'
        ? recCopy(recording_id, 'merged', mergedSteps)
        : projCopy(project_id, 'merged', [recCopy(recording_id, 'merged', mergedSteps)]);
    if (scenario.mechanism === 'unclonable-bigint') {
      // A BigInt field makes JSON.stringify throw ⇒ the chosen version cannot be
      // retained as a recoverable copy.
      resolvedState = { ...base, evil: 10n };
    } else {
      // The inherited-throwing-toJSON metadata makes JSON.stringify throw.
      resolvedState = { ...base, metadata: makeUnretainableMetadata('resolved') };
    }
  }

  return { state, projects, unitRef, otherRef: hasOther ? otherRef : null, resolvedState };
}

describe('(resolving): an unretainable or unapplicable resolution aborts, leaving the Conflict and all state unchanged', () => {
  it('returns apply-failed, retains the Conflict, and leaves the SyncState and projects byte-for-byte unchanged', () => {
    fc.assert(
      fc.property(arbResolveAbort, (scenario) => {
        const m = materializeResolveAbort(scenario);

        // Snapshot the whole store and the projects array BEFORE resolving. Both
        // hold only clean (clonable) data — the unretainable value lives solely
        // in `resolvedState` — so they serialize safely for the comparison.
        const stateBefore = JSON.stringify(m.state);
        const projectsBefore = JSON.stringify(m.projects);

        const result = resolveConflict(m.state, m.projects, m.unitRef, m.resolvedState, {
          now: FIXED_NOW,
        });

        // ── The resolution aborts ──
        assert.equal(result.ok, false, 'an unretainable/unapplicable resolution must not succeed');
        assert.equal(result.reason, 'apply-failed', 'the failure reason is apply-failed');

        // ── The Conflict is retained, still routed to the conflict interface ──
        assert.notEqual(getItem(m.state, m.unitRef), null, 'the Conflict must remain pending');
        assert.equal(itemKind(m.state, m.unitRef), 'conflict', 'it is still a Conflict');

        // ── Nothing changed: state and projects are byte-for-byte unchanged ──
        assert.equal(JSON.stringify(m.state), stateBefore, 'the SyncState must be unchanged');
        assert.equal(
          JSON.stringify(m.projects),
          projectsBefore,
          'the input projects are unchanged',
        );
        assert.equal(
          JSON.stringify(result.projects),
          projectsBefore,
          'the returned projects equal the unchanged input',
        );

        // An unrelated deferred item is untouched (covered by the state check).
        if (m.otherRef) {
          assert.notEqual(getItem(m.state, m.otherRef), null, 'an unrelated item survives');
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ──────────────────────────────────────

  it('a chosen resolved version that cannot be retained (BigInt) aborts with apply-failed, state unchanged', () => {
    const localVer = {
      recording_id: 'rec-1',
      name: 'local',
      created_at: CA,
      steps: [{ uuid: 'L-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const incomingVer = {
      recording_id: 'rec-1',
      name: 'incoming',
      created_at: CA,
      steps: [{ uuid: 'I-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', localVer, incomingVer, FIXED_NOW);
    const before = JSON.stringify(state);

    const localProjects = [
      { project_id: 'proj-1', name: 'P', created_at: CA, recordings: [localVer] },
    ];
    const projectsBefore = JSON.stringify(localProjects);

    // An otherwise-valid append-only superset, made unretainable by a BigInt.
    const resolvedState = {
      recording_id: 'rec-1',
      name: 'merged',
      created_at: CA,
      steps: [
        { uuid: 'L-1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'I-1', logical_id: 'a', step_number: 0, deleted: false },
      ],
      evil: 9007199254740993n,
    };

    const result = resolveConflict(state, localProjects, 'proj-1:rec-1', resolvedState, {
      now: FIXED_NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'apply-failed');
    assert.notEqual(getItem(state, 'proj-1:rec-1'), null, 'the Conflict is retained');
    assert.equal(JSON.stringify(state), before, 'state unchanged');
    assert.equal(JSON.stringify(localProjects), projectsBefore, 'projects unchanged');
  });

  it('a recording-level Conflict with no local project to apply into aborts with apply-failed, state unchanged', () => {
    const localVer = {
      recording_id: 'rec-1',
      name: 'local',
      created_at: CA,
      steps: [{ uuid: 'L-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const incomingVer = {
      recording_id: 'rec-1',
      name: 'incoming',
      created_at: CA,
      steps: [{ uuid: 'I-1', logical_id: 'a', step_number: 0, deleted: false }],
    };
    const state = createEmptySyncState();
    upsertConflict(state, 'proj-1:rec-1', localVer, incomingVer, FIXED_NOW);
    const before = JSON.stringify(state);

    // A valid, clonable append-only superset — but there is no local project to
    // apply it into, so the resolution cannot complete.
    const resolvedState = {
      recording_id: 'rec-1',
      name: 'merged',
      created_at: CA,
      steps: [
        { uuid: 'L-1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'I-1', logical_id: 'a', step_number: 0, deleted: false },
      ],
    };

    const result = resolveConflict(state, [], 'proj-1:rec-1', resolvedState, { now: FIXED_NOW });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'apply-failed');
    assert.notEqual(getItem(state, 'proj-1:rec-1'), null, 'the Conflict is retained');
    assert.equal(JSON.stringify(state), before, 'state unchanged');
    assert.deepEqual(result.projects, [], 'the unchanged (empty) projects are returned');
  });
});
