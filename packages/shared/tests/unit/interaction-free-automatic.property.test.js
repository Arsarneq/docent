/**
 * interaction-free-automatic.property.test.js — Property test that the AUTOMATIC
 * side of a sync cycle completes WITHOUT ANY user interaction (Property 28).
 *
 * The feature's north star draws a sharp line (R15): transport, detection, push
 * (including the push of a `changed-local-outgoing` Unit), the addition of
 * brand-new Units, fast-forward auto-applies, and auto-applied deletions are all
 * AUTOMATIC, while adopting a *deferred* incoming change into an existing
 * recording with a local counterpart (a Review held for review, or a Conflict) is
 * always USER-GATED. Property 28 pins the automatic half of that line from the
 * orchestrator's point of view:
 *
 *   - R15.1 — a full `sync()` cycle (pull, snapshot retention, detection, push,
 *     the addition of brand-new Units, settings-gated fast-forward auto-applies,
 *     auto-applied deletions, and deferral RECORDING) runs to completion (or halts
 *     at a pre-flight gate) without ever requesting user input. There is no
 *     prompt/confirm/accept hook anywhere on the sync path; deciding a Review or a
 *     Conflict is the separate, user-driven resolution workflow, never `sync()`.
 *   - R15.2 — `sync()` adopts NO *deferred* incoming change into an existing
 *     recording that has a local counterpart. Every Review/Conflict Unit is
 *     DEFERRED durably and its LOCAL data is left byte-identical in the merged
 *     list — the incoming version is recorded for later, never applied here.
 *   - R21.1 / R21.4 — a `changed-local-outgoing` Unit (local changed since the
 *     baseline, incoming still equals the baseline) is a NON-DEFERRED, AUTOMATIC
 *     outcome: its local version is pushed automatically (it reaches the wire),
 *     it is never recorded as a Review or a Conflict, and no user input is needed.
 *
 * How the property demonstrates "no user interaction": before the cycle we
 * install throwing/recording SENTINELS over every browser user-input surface a
 * misbehaving code path might reach for — `globalThis.prompt`, `globalThis.confirm`,
 * and `globalThis.alert`. Any call would both record itself AND throw, failing the
 * run. `fetch` is deliberately NOT sentineled to throw: transport is an automatic
 * operation that the cycle is SUPPOSED to perform (R15.1), so it is mocked to
 * serve the scenario, count its calls, and capture each PUT body so the property
 * can also assert WHAT reached the wire (a `changed-local-outgoing` Unit's local
 * version). After the cycle we assert the sentinel call-log is empty.
 *
 * The property drives the REAL `sync()` orchestrator over an arbitrary mix of
 * project- and recording-level fates (`converged`, `brand-new`, `local-only`,
 * `remote-deleted`, and `descend` projects whose metadata and recordings each
 * carry `converged` / `changed-incoming` / `changed-local-outgoing` / `diverged` /
 * `remote-deleted` / `brand-new` fates), an arbitrary live-work GATE mode, and an
 * arbitrary reconciliation-POLICY mode so the automatic outcomes that depend on a
 * setting are exercised:
 *   - gate `permissive`     — capture inactive, nothing locked → the cycle completes.
 *   - gate `locked`         — a subset of locally-present recordings are open in
 *                             the Recording_View → excluded, the cycle completes.
 *   - gate `capture-active` — capture is running → the cycle halts immediately.
 *   - policy `default`      — both toggles OFF: every incoming change/deletion to
 *                             an unchanged-local recording DEFERS to a Review, and
 *                             nothing is auto-applied.
 *   - policy `auto-accept`  — both toggles ON: a fast-forward `changed-incoming`
 *                             recording AUTO-APPLIES (reported in
 *                             `autoAppliedUpdates`) and a `deleted-remote-review`
 *                             AUTO-DELETES (reported in `autoAppliedDeletions`),
 *                             all without any user input.
 * In every mode the sentinels must stay untouched; whenever the cycle completes,
 * no deferred incoming change is adopted into a local recording, every
 * `changed-local-outgoing` Unit's local version is pushed, and the auto-applied
 * sets equal exactly the Units the policy is supposed to apply.
 *
 * `fetch` is mocked exactly as in the sibling orchestrator property tests
 * (`makeResponse`-style stubs dispatched per project_id; PUT → 200, body
 * captured); the validator passes; an in-memory `SyncStore` (seeded with the
 * agreed baselines and the policy settings) captures the saved `SyncState`; and
 * the `LiveState` is built from the gate mode.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * **Validates: Requirements 15.1, 15.2, 21.1, 21.4**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 28: Automatic operations complete without user interaction

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { createEmptySyncState, setSettings } from '../../sync-store.js';
import { advanceBaseline } from '../../sync-baseline.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

const SERVER = 'https://srv.test';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

// ─── fetch double (mirrors sync-client.test.js / sibling property tests) ──────

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
 * by project_id, counts every call on the returned counter, and captures each PUT
 * body so a test can assert WHAT was pushed:
 *   - PUT (push)        → 200 (the push phase always succeeds); the parsed body
 *                         is recorded in `pushedBodies` keyed by project_id.
 *   - GET /projects     → the manifest array (server-present projects only).
 *   - GET /projects/:id → the project's Full_Project_Payload.
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, object>} payloadById
 * @returns {{ counter: { count: number }, pushedBodies: Map<string, object> }}
 */
function installMockFetch(manifest, payloadById) {
  const counter = { count: 0 };
  const pushedBodies = new Map();
  globalThis.fetch = async (url, options) => {
    counter.count += 1;
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') {
      const id = decodeURIComponent(url.split('/').pop());
      try {
        pushedBodies.set(id, JSON.parse(options.body));
      } catch {
        /* a non-JSON body is never produced by sync(); ignore defensively */
      }
      return makeResponse(200, { ok: true });
    }
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    const id = decodeURIComponent(url.split('/').pop());
    const payload = payloadById.get(id);
    return payload ? makeResponse(200, payload) : makeResponse(404);
  };
  return { counter, pushedBodies };
}

// ─── user-input sentinels ─────────────────────────────────────────────────────

/**
 * Install throwing/recording sentinels over every browser user-input surface the
 * sync path must never touch (`prompt`, `confirm`, `alert`). Each records its
 * call into the shared `calls` log AND throws, so any interaction both fails the
 * run loudly and is visible in the log. Returns a `restore()` that puts the
 * original globals back (or deletes the sentinel when there was no original), so
 * sentinels never leak into other tests.
 *
 * `fetch` is intentionally left alone — transport is an AUTOMATIC operation the
 * cycle is supposed to perform (R15.1), not a user-input surface.
 *
 * @returns {{ calls: Array<[string, unknown[]]>, restore: () => void }}
 */
function installUserInputSentinels() {
  const calls = [];
  const surfaces = ['prompt', 'confirm', 'alert'];
  const had = {};
  const original = {};
  for (const name of surfaces) {
    had[name] = name in globalThis;
    original[name] = globalThis[name];
    globalThis[name] = (...args) => {
      calls.push([name, args]);
      throw new Error(`sync() must not request user input via ${name}() (R15.1)`);
    };
  }
  const restore = () => {
    for (const name of surfaces) {
      if (had[name]) globalThis[name] = original[name];
      else delete globalThis[name];
    }
  };
  return { calls, restore };
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

/**
 * Build a {@link LiveState} for a gate mode.
 *   - `permissive`     — capture inactive, nothing locked, nothing pending.
 *   - `locked`         — the given recording ids are open in the Recording_View.
 *   - `capture-active` — capture is running (the whole cycle halts).
 *
 * `recordingsWithPendingActions` is always empty so the only halt the property
 * exercises is the deterministic capture-active one (the pending-unprotected
 * halt is covered by a dedicated regression example below).
 *
 * @param {'permissive'|'locked'|'capture-active'} mode
 * @param {Set<string>} lockedIds
 */
function makeLiveState(mode, lockedIds = new Set()) {
  return {
    isCaptureActive: () => mode === 'capture-active',
    getLockedRecordingIds: () => (mode === 'locked' ? lockedIds : new Set()),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (interaction, not validation, is the focus). */
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

/** Split a unitRef into project_id and (optional) recording_id (first colon). */
function parseRef(ref) {
  const i = ref.indexOf(':');
  if (i === -1) return { pid: ref, rid: null };
  return { pid: ref.slice(0, i), rid: ref.slice(i + 1) };
}

/** Sorted array helper for set comparisons. */
function sorted(iterable) {
  return [...iterable].sort();
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
 * A recording spec. `steps` / `created_at` are SHARED across the recording's
 * three role variants (base / local / server) so digest variance comes purely
 * from the role-dependent `name` ({@link recName}). Because every role shares the
 * same step uuids, an incoming `changed-incoming` version is always an
 * append-only SUPERSET of the baseline — a true fast-forward — so under the
 * `auto-accept` policy it is eligible to auto-apply (R4.2, R22.4). `locked` marks
 * a recording the user has open in the Recording_View (only honored when it has a
 * local copy and the scenario gate mode is `locked`).
 */
const arbRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  created_at: arbIso,
  steps: fc.array(arbStep, { maxLength: 3 }),
  fate: fc.constantFrom(
    'converged',
    'brand-new',
    'changed-incoming',
    'changed-local-outgoing',
    'diverged',
    'remote-deleted',
  ),
  locked: fc.boolean(),
});

/** A project spec, present on both sides for `descend`, otherwise per its fate. */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  created_at: arbIso,
  fate: fc.constantFrom('converged', 'brand-new', 'local-only', 'remote-deleted', 'descend'),
  metaFate: fc.constantFrom('converged', 'changed-incoming', 'diverged'),
  recordings: fc.uniqueArray(arbRecordingSpec, { selector: (r) => r.recording_id, maxLength: 4 }),
});

/** A scenario: a mix of projects, the live-work gate mode, and the policy mode. */
const arbScenario = fc.record({
  projects: fc.uniqueArray(arbProjectSpec, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 5,
  }),
  gateMode: fc.constantFrom('permissive', 'locked', 'capture-active'),
  policyMode: fc.constantFrom('default', 'auto-accept'),
});

// ─── content-by-role helpers (mirror no-discard-no-overwrite) ─────────────────

/**
 * The recording `name` for a given role, encoding the fate's three-way content
 * relationship; `null` means ABSENT on that side. Equal names ⇒ equal digests.
 *
 *   - `converged`               — equal on every side.
 *   - `changed-incoming`        — local == base, server moved (R2.4).
 *   - `changed-local-outgoing`  — server == base, local moved (R2.5): a routine
 *                                 one-sided local change, pushed automatically.
 *   - `diverged`                — all three sides differ (R2.6).
 *   - `remote-deleted`          — absent on the server, local == base (R19.3).
 *   - `brand-new`               — server-only, no local/baseline (R3.2).
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
    case 'changed-local-outgoing':
      // local moved; base and server stay at the agreed version.
      return role === 'local' ? `${rid}-clo-local` : `${rid}-clo`;
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
 * nested step records are plain objects (matching the store/baseline/pull-path
 * copies, which all cross JSON).
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
 * Materialize a scenario into the `sync()` inputs (seeded store, mock fetch
 * manifest/payloads), the live-work gate, and the derived expectations: the local
 * projects passed in, the set of locked recording ids, and the policy-dependent
 * sets the cycle should produce (auto-applied updates/deletions, reviews,
 * conflicts, and the `changed-local-outgoing` Units whose local version must be
 * pushed).
 */
function materialize(scenario) {
  const { projects: specs, gateMode, policyMode } = scenario;
  const seed = createEmptySyncState();
  if (policyMode === 'auto-accept') {
    setSettings(seed, { autoAcceptUpdates: true, autoAcceptDeletions: true });
  }
  const payloadById = new Map();
  const manifest = [];
  const localProjects = [];
  const lockedIds = new Set();

  // Raw per-Unit info collected during the build; turned into policy/lock-aware
  // expectation sets after the loop (once the locked set is fully known).
  const descendRecInfos = []; // { project_id, recording_id, unitRef, fate, incomingProjection }
  const projectInfos = []; // { project_id, kind: 'meta-ci'|'meta-div'|'proj-rd' }

  for (const s of specs) {
    const pid = s.project_id;

    if (s.fate === 'converged') {
      const name = `${pid}-conv`;
      const local = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'base'));
      const server = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'base'));
      const baseline = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'base'));
      advanceBaseline(seed, pid, projectProjection(baseline));
      localProjects.push(local);
      payloadById.set(pid, buildPayload(server));
      manifest.push({ project_id: pid, name });
      continue;
    }

    if (s.fate === 'brand-new') {
      const name = `${pid}-bn`;
      const server = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'server'));
      payloadById.set(pid, buildPayload(server));
      manifest.push({ project_id: pid, name });
      continue;
    }

    if (s.fate === 'local-only') {
      const name = `${pid}-lo`;
      localProjects.push(buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'local')));
      continue;
    }

    if (s.fate === 'remote-deleted') {
      // Whole project deleted on the server, local == baseline → a project-level
      // `deleted-remote-review`: a Review under the default policy, an auto-applied
      // deletion under auto-accept (R19.3, R19.4).
      const name = `${pid}-rd`;
      const local = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'local'));
      const baseline = buildProj(pid, name, s.created_at, recsForRole(s.recordings, 'local'));
      advanceBaseline(seed, pid, projectProjection(baseline));
      localProjects.push(local);
      projectInfos.push({ project_id: pid, kind: 'proj-rd' });
      continue;
    }

    // s.fate === 'descend' — present on both sides + baseline, per-Unit fates.
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

    // Project-metadata Unit outcome (R2.10): a metadata change is its own Unit.
    if (s.metaFate === 'changed-incoming') projectInfos.push({ project_id: pid, kind: 'meta-ci' });
    else if (s.metaFate === 'diverged') projectInfos.push({ project_id: pid, kind: 'meta-div' });

    for (const r of s.recordings) {
      // A recording can be "open in the Recording_View" only when it has a local
      // copy; collect those marked `locked` so the gate excludes them.
      if (r.locked && buildRec(r, 'local') != null) lockedIds.add(r.recording_id);
      descendRecInfos.push({
        project_id: pid,
        recording_id: r.recording_id,
        unitRef: `${pid}:${r.recording_id}`,
        fate: r.fate,
        incomingProjection:
          r.fate === 'changed-incoming' ? recordingProjection(buildRec(r, 'server')) : null,
        localName: recName(r, 'local'),
      });
    }
  }

  // The locked set actually in force this cycle (only the `locked` gate honors it).
  const effectiveLocked = gateMode === 'locked' ? lockedIds : new Set();
  const auto = policyMode === 'auto-accept';

  // Policy- and lock-aware expectations.
  const expectAutoUpdates = new Set();
  const expectAutoDeletions = new Set();
  const expectReview = new Set();
  const expectConflicts = new Set();
  const cloRefs = []; // { project_id, recording_id, unitRef, localName }
  const autoUpdateExpectedIncoming = new Map(); // unitRef → incoming RecordingCopy

  for (const info of descendRecInfos) {
    // A locked recording is `locked-skipped` — excluded from the merge entirely,
    // so it produces no review/conflict/auto-apply outcome this cycle (R6.3).
    if (effectiveLocked.has(info.recording_id)) continue;
    switch (info.fate) {
      case 'changed-incoming':
        if (auto) {
          expectAutoUpdates.add(info.unitRef);
          autoUpdateExpectedIncoming.set(info.unitRef, info.incomingProjection);
        } else {
          expectReview.add(info.unitRef);
        }
        break;
      case 'remote-deleted':
        if (auto) expectAutoDeletions.add(info.unitRef);
        else expectReview.add(info.unitRef);
        break;
      case 'diverged':
        expectConflicts.add(info.unitRef);
        break;
      case 'changed-local-outgoing':
        cloRefs.push({
          project_id: info.project_id,
          recording_id: info.recording_id,
          unitRef: info.unitRef,
          localName: info.localName,
        });
        break;
      default:
        // `converged` (omitted) and `brand-new` (auto-added) need no deferral.
        break;
    }
  }

  for (const pinfo of projectInfos) {
    if (pinfo.kind === 'meta-ci') {
      // A project-METADATA change is never a fast-forward candidate (only
      // recording-level units are), so it always DEFERS to Review even under
      // auto-accept (R4.3).
      expectReview.add(pinfo.project_id);
    } else if (pinfo.kind === 'meta-div') {
      expectConflicts.add(pinfo.project_id);
    } else if (pinfo.kind === 'proj-rd') {
      if (auto) expectAutoDeletions.add(pinfo.project_id);
      else expectReview.add(pinfo.project_id);
    }
  }

  const liveState = makeLiveState(gateMode, lockedIds);
  return {
    seed,
    payloadById,
    manifest,
    localProjects,
    lockedIds,
    gateMode,
    policyMode,
    liveState,
    expectAutoUpdates,
    expectAutoDeletions,
    expectReview,
    expectConflicts,
    cloRefs,
    autoUpdateExpectedIncoming,
  };
}

// ─── Property 28 ────────────────────────────────────────────────────────────────

describe('Property 28: Automatic operations complete without user interaction', () => {
  it('runs a full sync cycle over an arbitrary mix of fates and policies without ever requesting user input — auto-pushing changed-local-outgoing units and running settings-gated auto-applies, while adopting no deferred change into a local recording', async () => {
    const { calls, restore } = installUserInputSentinels();
    try {
      await fc.assert(
        fc.asyncProperty(arbScenario, async (scenario) => {
          const {
            seed,
            payloadById,
            manifest,
            localProjects,
            gateMode,
            liveState,
            expectAutoUpdates,
            expectAutoDeletions,
            expectReview,
            expectConflicts,
            cloRefs,
            autoUpdateExpectedIncoming,
          } = materialize(scenario);
          const { counter: fetchCounter, pushedBodies } = installMockFetch(manifest, payloadById);
          const store = makeStore(seed);

          const { result, projects } = await sync(
            SERVER,
            null,
            localProjects,
            STUB_SCHEMA,
            passValidator,
            store,
            liveState,
          );

          // ── (A) No user-input surface was touched on ANY path (R15.1). ──
          assert.deepEqual(calls, [], `sync() requested user input: ${JSON.stringify(calls)}`);

          const localById = new Map(localProjects.map((p) => [p.project_id, p]));
          const mergedById = new Map(projects.map((p) => [p.project_id, p]));

          if (gateMode === 'capture-active') {
            // ── Halts via the capture-active gate (R15.5): no cycle, no
            //    transport, no auto-apply, local data returned unchanged. ──
            assert.equal(result.halted, true, 'capture-active halts the cycle');
            assert.equal(result.haltReason, 'capture-active');
            assert.equal(fetchCounter.count, 0, 'a capture-active halt performs no transport');
            assert.deepEqual(result.review, []);
            assert.deepEqual(result.conflicts, []);
            assert.deepEqual(result.autoAppliedUpdates, []);
            assert.deepEqual(result.autoAppliedDeletions, []);
            assert.deepEqual(projects, localProjects, 'local projects are returned unchanged');
            return;
          }

          // ── permissive / locked: the automatic cycle completes (R15.1). ──
          assert.equal(result.halted, false, 'an ungated automatic cycle completes');
          assert.equal(result.haltReason, null);

          const state = store.getState();

          // ── (B) The reported automatic-outcome sets equal exactly what the
          //    policy is supposed to produce — all reached with NO user input. ──
          assert.deepEqual(
            sorted(result.autoAppliedUpdates),
            sorted(expectAutoUpdates),
            'autoAppliedUpdates equals the fast-forward changed-incoming units the policy applies',
          );
          assert.deepEqual(
            sorted(result.autoAppliedDeletions),
            sorted(expectAutoDeletions),
            'autoAppliedDeletions equals the server-deletion units the policy applies',
          );
          assert.deepEqual(
            sorted(result.review),
            sorted(expectReview),
            'review equals exactly the deferred change/deletion units',
          );
          assert.deepEqual(
            sorted(result.conflicts),
            sorted(expectConflicts),
            'conflicts equals exactly the diverged units',
          );

          // ── (C) R21.1 / R21.4 — every changed-local-outgoing Unit is a
          //    NON-DEFERRED automatic outcome: never reviewed/conflicted/
          //    auto-applied, and its LOCAL version is pushed to the wire. ──
          for (const { project_id, recording_id, unitRef, localName } of cloRefs) {
            assert.ok(
              !result.review.includes(unitRef),
              `changed-local-outgoing ${unitRef} is never a Review`,
            );
            assert.ok(
              !result.conflicts.includes(unitRef),
              `changed-local-outgoing ${unitRef} is never a Conflict`,
            );
            assert.ok(
              !result.autoAppliedUpdates.includes(unitRef) &&
                !result.autoAppliedDeletions.includes(unitRef),
              `changed-local-outgoing ${unitRef} is not an auto-applied incoming outcome`,
            );
            assert.ok(
              !(unitRef in (state.reviews ?? {})) && !(unitRef in (state.conflicts ?? {})),
              `changed-local-outgoing ${unitRef} records nothing durable`,
            );

            // Its local version reaches the wire (R21.1): the project was pushed
            // and its pushed payload carries the recording at its LOCAL name.
            assert.ok(
              result.pushed.includes(project_id),
              `the project of changed-local-outgoing ${unitRef} is pushed`,
            );
            const body = pushedBodies.get(project_id);
            assert.ok(body, `a PUT body was captured for ${project_id}`);
            const pushedRec = (body.recordings ?? []).find((r) => r.recording_id === recording_id);
            assert.ok(pushedRec, `the pushed payload includes recording ${recording_id}`);
            assert.equal(
              pushedRec.name,
              localName,
              'the changed-local-outgoing recording is pushed at its LOCAL version (R21.1)',
            );
          }

          // ── (D) R4.2 / R22.4 — each auto-applied UPDATE replaced the local
          //    recording with the incoming version in the merged list. ──
          for (const unitRef of expectAutoUpdates) {
            const { pid, rid } = parseRef(unitRef);
            const mp = mergedById.get(pid);
            assert.ok(mp, `merged project ${pid} for an auto-applied update must exist`);
            const mr = mp.recordings.find((r) => r.recording_id === rid);
            assert.ok(mr, `auto-applied recording ${rid} must be present in the merged project`);
            assert.deepEqual(
              recordingProjection(mr),
              autoUpdateExpectedIncoming.get(unitRef),
              'an auto-applied update adopts the incoming version into the merged list',
            );
            assert.ok(
              !(unitRef in (state.reviews ?? {})),
              `auto-applied update ${unitRef} is not also a Review`,
            );
          }

          // ── (E) R19.4 / R22.5 — each auto-applied DELETION removed the Unit
          //    from the merged list. ──
          for (const unitRef of expectAutoDeletions) {
            const { pid, rid } = parseRef(unitRef);
            if (rid == null) {
              assert.ok(!mergedById.has(pid), `auto-deleted project ${pid} is removed from merged`);
            } else {
              const mp = mergedById.get(pid);
              if (mp) {
                assert.ok(
                  !mp.recordings.some((r) => r.recording_id === rid),
                  `auto-deleted recording ${rid} is removed from its merged project`,
                );
              }
            }
          }

          // ── (F) R15.2 — no DEFERRED incoming change is adopted into a local
          //    recording: for every Unit in Review or Conflict that has a local
          //    counterpart, the merged local data is byte-identical to the input
          //    (the incoming version is recorded, never applied). ──
          const assertLocalUnchanged = (ref) => {
            const { pid, rid } = parseRef(ref);
            const lp = localById.get(pid);
            if (!lp) return; // remote-only deferral: no local counterpart to protect
            const mp = mergedById.get(pid);
            assert.ok(mp, `merged project ${pid} for a deferred Unit must exist`);
            if (rid == null) {
              // project-level deferral: project identity preserved unchanged
              assert.deepEqual(
                {
                  project_id: mp.project_id,
                  name: mp.name,
                  created_at: mp.created_at,
                  ...(mp.metadata && { metadata: mp.metadata }),
                },
                {
                  project_id: lp.project_id,
                  name: lp.name,
                  created_at: lp.created_at,
                  ...(lp.metadata && { metadata: lp.metadata }),
                },
                'deferred project metadata is not adopted (R15.2)',
              );
              return;
            }
            const lr = lp.recordings.find((r) => r.recording_id === rid);
            if (!lr) return; // local side absent (delete-vs-change)
            const mr = mp.recordings.find((r) => r.recording_id === rid);
            assert.ok(mr, `deferred local recording ${rid} must remain in the merged project`);
            assert.deepEqual(
              recordingProjection(mr),
              recordingProjection(lr),
              'no deferred incoming change is adopted into a local recording (R15.2)',
            );
          };

          for (const ref of result.review) {
            assert.ok(state.reviews?.[ref], `Review record for ${ref} must be retained`);
            assertLocalUnchanged(ref);
          }
          for (const ref of result.conflicts) {
            assert.ok(state.conflicts?.[ref], `Conflict record for ${ref} must be retained`);
            assertLocalUnchanged(ref);
          }
        }),
        { numRuns: 200 },
      );
    } finally {
      restore();
    }
  });

  // ─── Deterministic regression examples ──────────────────────────────────────

  it('a permissive cycle auto-adds a brand-new project, defers a diverged recording, and never prompts', async () => {
    const NEW_PID = '018f0000-0000-7000-8000-000000000301';
    const DESC_PID = '018f0000-0000-7000-8000-000000000302';
    const RID = '018f0000-0000-7000-8000-0000000000a1';
    const created = '2026-01-01T00:00:00.000Z';
    const mk = (name) => ({ recording_id: RID, name, created_at: created, steps: [] });

    // Brand-new project (server-only) — automatic add, no interaction.
    const brandNew = buildProj(NEW_PID, `${NEW_PID}-bn`, created, [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000b1',
        name: 'r',
        created_at: created,
        steps: [],
      },
    ]);

    // Descend project with a diverged recording — deferred, never adopted.
    const baseRec = mk('agreed');
    const localRec = mk('local-changed');
    const serverRec = mk('server-changed');
    const baseline = buildProj(DESC_PID, `${DESC_PID}-meta`, created, [baseRec]);
    const local = buildProj(DESC_PID, `${DESC_PID}-meta`, created, [localRec]);
    const server = buildProj(DESC_PID, `${DESC_PID}-meta`, created, [serverRec]);

    const seed = createEmptySyncState();
    advanceBaseline(seed, DESC_PID, projectProjection(baseline));

    const { counter: fetchCounter } = installMockFetch(
      [
        { project_id: NEW_PID, name: brandNew.name },
        { project_id: DESC_PID, name: server.name },
      ],
      new Map([
        [NEW_PID, buildPayload(brandNew)],
        [DESC_PID, buildPayload(server)],
      ]),
    );

    const { calls, restore } = installUserInputSentinels();
    let result;
    let projects;
    try {
      ({ result, projects } = await sync(
        SERVER,
        null,
        [local],
        STUB_SCHEMA,
        passValidator,
        makeStore(seed),
        makeLiveState('permissive'),
      ));
    } finally {
      restore();
    }

    assert.deepEqual(calls, [], 'no user input was requested');
    assert.ok(fetchCounter.count > 0, 'transport ran automatically');
    assert.equal(result.halted, false);

    // Brand-new project was auto-added (R15.1) without any interaction.
    const mergedNew = projects.find((p) => p.project_id === NEW_PID);
    assert.ok(mergedNew, 'the brand-new project is auto-added');

    // The diverged recording is deferred and local is left untouched (R15.2).
    const ref = `${DESC_PID}:${RID}`;
    assert.deepEqual(result.conflicts, [ref]);
    const mergedDesc = projects.find((p) => p.project_id === DESC_PID);
    assert.deepEqual(
      recordingProjection(mergedDesc.recordings.find((r) => r.recording_id === RID)),
      recordingProjection(localRec),
      'the incoming change is not adopted into the local recording',
    );
  });

  it('a changed-local-outgoing recording is auto-pushed at its local version with no user interaction', async () => {
    const PID = '018f0000-0000-7000-8000-000000000310';
    const RID = '018f0000-0000-7000-8000-0000000000e1';
    const created = '2026-01-01T00:00:00.000Z';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    // local moved (name changed) while the server is still at the agreed baseline.
    const baseRec = { recording_id: RID, name: 'agreed', created_at: created, steps };
    const localRec = { recording_id: RID, name: 'local-moved', created_at: created, steps };
    const serverRec = { recording_id: RID, name: 'agreed', created_at: created, steps };
    const baseline = buildProj(PID, `${PID}-meta`, created, [baseRec]);
    const local = buildProj(PID, `${PID}-meta`, created, [localRec]);
    const server = buildProj(PID, `${PID}-meta`, created, [serverRec]);

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baseline));

    const { pushedBodies } = installMockFetch(
      [{ project_id: PID, name: server.name }],
      new Map([[PID, buildPayload(server)]]),
    );

    const store = makeStore(seed);
    const { calls, restore } = installUserInputSentinels();
    let result;
    let projects;
    try {
      ({ result, projects } = await sync(
        SERVER,
        null,
        [local],
        STUB_SCHEMA,
        passValidator,
        store,
        makeLiveState('permissive'),
      ));
    } finally {
      restore();
    }

    const unitRef = `${PID}:${RID}`;
    assert.deepEqual(calls, [], 'no user input was requested');
    assert.equal(result.halted, false);

    // Not deferred and not auto-applied — a routine outgoing change (R21.4).
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.autoAppliedUpdates, []);
    assert.deepEqual(result.autoAppliedDeletions, []);
    const finalState = store.getState();
    assert.ok(
      !(unitRef in (finalState.reviews ?? {})) && !(unitRef in (finalState.conflicts ?? {})),
      'changed-local-outgoing records nothing durable',
    );

    // The local version was pushed (R21.1).
    assert.ok(result.pushed.includes(PID), 'the project was pushed');
    const body = pushedBodies.get(PID);
    const pushedRec = body.recordings.find((r) => r.recording_id === RID);
    assert.equal(pushedRec.name, 'local-moved', 'the pushed recording is the LOCAL version');

    // Local data is unchanged in the merged list.
    const merged = projects.find((p) => p.project_id === PID);
    assert.deepEqual(
      recordingProjection(merged.recordings.find((r) => r.recording_id === RID)),
      recordingProjection(localRec),
    );
  });

  it('auto-accept policy applies a fast-forward update and a server deletion with no user interaction', async () => {
    const PID = '018f0000-0000-7000-8000-000000000311';
    const FF_RID = '018f0000-0000-7000-8000-0000000000f1'; // fast-forward changed-incoming
    const DEL_RID = '018f0000-0000-7000-8000-0000000000f2'; // server-deleted
    const created = '2026-01-01T00:00:00.000Z';

    const baseSteps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];
    // The incoming fast-forward RETAINS s1 and appends s2 (append-only superset).
    const ffSteps = [
      { uuid: 's1', logical_id: 'a', step_number: 0, deleted: false },
      { uuid: 's2', logical_id: 'a', step_number: 1, deleted: false },
    ];

    const ffBase = { recording_id: FF_RID, name: 'ff', created_at: created, steps: baseSteps };
    const ffLocal = { recording_id: FF_RID, name: 'ff', created_at: created, steps: baseSteps };
    const ffServer = { recording_id: FF_RID, name: 'ff', created_at: created, steps: ffSteps };
    const delRec = { recording_id: DEL_RID, name: 'doomed', created_at: created, steps: baseSteps };

    const baseline = buildProj(PID, `${PID}-meta`, created, [ffBase, delRec]);
    const local = buildProj(PID, `${PID}-meta`, created, [ffLocal, delRec]);
    // Server moved FF (append-only) and DELETED DEL_RID (absent from the payload).
    const server = buildProj(PID, `${PID}-meta`, created, [ffServer]);

    const seed = createEmptySyncState();
    setSettings(seed, { autoAcceptUpdates: true, autoAcceptDeletions: true });
    advanceBaseline(seed, PID, projectProjection(baseline));

    installMockFetch(
      [{ project_id: PID, name: server.name }],
      new Map([[PID, buildPayload(server)]]),
    );

    const { calls, restore } = installUserInputSentinels();
    let result;
    let projects;
    try {
      ({ result, projects } = await sync(
        SERVER,
        null,
        [local],
        STUB_SCHEMA,
        passValidator,
        makeStore(seed),
        makeLiveState('permissive'),
      ));
    } finally {
      restore();
    }

    const ffRef = `${PID}:${FF_RID}`;
    const delRef = `${PID}:${DEL_RID}`;

    assert.deepEqual(calls, [], 'no user input was requested on the auto-apply path');
    assert.equal(result.halted, false);

    // The fast-forward update auto-applied (R4.2/R22.4) — no review, no conflict.
    assert.deepEqual(result.autoAppliedUpdates, [ffRef]);
    assert.ok(!result.review.includes(ffRef) && !result.conflicts.includes(ffRef));
    const merged = projects.find((p) => p.project_id === PID);
    assert.deepEqual(
      recordingProjection(merged.recordings.find((r) => r.recording_id === FF_RID)),
      recordingProjection(ffServer),
      'the incoming fast-forward version was adopted',
    );

    // The server deletion auto-applied (R19.4/R22.5) — removed from the merged list.
    assert.deepEqual(result.autoAppliedDeletions, [delRef]);
    assert.ok(
      !merged.recordings.some((r) => r.recording_id === DEL_RID),
      'the auto-deleted recording is removed from the merged project',
    );

    // Nothing was deferred.
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.conflicts, []);
  });

  it('a capture-active cycle halts with no transport and no user interaction', async () => {
    const PID = '018f0000-0000-7000-8000-000000000303';
    const created = '2026-01-01T00:00:00.000Z';
    const local = buildProj(PID, `${PID}-meta`, created, [
      {
        recording_id: '018f0000-0000-7000-8000-0000000000c1',
        name: 'r',
        created_at: created,
        steps: [],
      },
    ]);

    // The server would offer a brand-new project, but capture-active must stop
    // the cycle before any transport occurs.
    const { counter: fetchCounter } = installMockFetch(
      [{ project_id: PID, name: local.name }],
      new Map([[PID, buildPayload(local)]]),
    );

    const { calls, restore } = installUserInputSentinels();
    let result;
    let projects;
    try {
      ({ result, projects } = await sync(
        SERVER,
        null,
        [local],
        STUB_SCHEMA,
        passValidator,
        makeStore(createEmptySyncState()),
        makeLiveState('capture-active'),
      ));
    } finally {
      restore();
    }

    assert.deepEqual(calls, [], 'no user input was requested on the halt path');
    assert.equal(fetchCounter.count, 0, 'capture-active performs no push/pull (R7.2)');
    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'capture-active');
    assert.deepEqual(projects, [local], 'local projects are returned unchanged');
  });

  it('a pending-actions-unprotected halt is reached without any user interaction', async () => {
    const PID = '018f0000-0000-7000-8000-000000000304';
    const RID = '018f0000-0000-7000-8000-0000000000d1';
    const created = '2026-01-01T00:00:00.000Z';
    const local = buildProj(PID, `${PID}-meta`, created, [
      { recording_id: RID, name: 'r', created_at: created, steps: [] },
    ]);

    const { counter: fetchCounter } = installMockFetch(
      [{ project_id: PID, name: local.name }],
      new Map([[PID, buildPayload(local)]]),
    );

    // A recording holds Pending Actions but is neither locked nor capture-halted
    // → the pre-flight safety assertion halts the cycle (R8.4) — still no input.
    const liveState = {
      isCaptureActive: () => false,
      getLockedRecordingIds: () => new Set(),
      recordingsWithPendingActions: () => new Set([RID]),
    };

    const { calls, restore } = installUserInputSentinels();
    let result;
    try {
      ({ result } = await sync(
        SERVER,
        null,
        [local],
        STUB_SCHEMA,
        passValidator,
        makeStore(createEmptySyncState()),
        liveState,
      ));
    } finally {
      restore();
    }

    assert.deepEqual(calls, [], 'no user input was requested on the safety-halt path');
    assert.equal(fetchCounter.count, 0, 'an unprotected pending recording halts before transport');
    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'pending-actions-unprotected');
  });
});
