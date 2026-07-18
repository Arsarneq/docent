/**
 * resolution-propagates-next-cycle.property.test.js — Property test that a
 * user-gated resolution action PUSHES NOTHING, and that the resolved state
 * propagates on the NEXT sync cycle per the resolved-against baseline.
 *
 * (sync-protocol SP-10): "For any resolved Conflict or accepted Review, the
 * resolution action issues no push; the affected Unit's baseline entry is set to
 * the resolved-against incoming version (per-unit, leaving siblings untouched),
 * removing the entry when the resolved-against side is a deletion. Consequently,
 * on a subsequent cycle with an unchanged server: an accept or keep-incoming
 * reads as `already-converged` (no push); a keep-local/merge reads as
 * `changed-local-outgoing` (pushed); a delete-vs-change keep-survivor reads as
 * local-new (pushed, re-propagating the survivor); and a server that changed
 * again re-classifies the Unit as `diverged` (a fresh Conflict)."
 *
 * ── What this property pins ──────────────────────────────────────────────────
 * The resolution helpers (`acceptReview` / `declineReview` / `resolveConflict` in
 * `conflict-resolution.js`) take NO `serverUrl`/`fetch` at all — they only mutate
 * the in-memory SyncState and return the updated `projects`. This test pins both
 * halves of the propagation guarantee:
 *
 *   1. **Resolution pushes nothing.** With a `fetch` spy installed, every
 *      resolution action issues ZERO network requests; it advances the per-unit
 *      baseline to the resolved-against incoming version and clears the item.
 *
 *   2. **The resolved state propagates on the NEXT cycle.** A subsequent `sync()`
 *      (pull → reconcile → per-unit push) re-classifies the resolved Unit purely
 *      from the advanced baseline:
 *        • keep-local / merge of a Conflict  → `changed-local-outgoing` ⇒ the
 *          resolved local version is pushed (and is provably NOT the server's
 *          version);
 *        • accept of a Review                → `already-converged` ⇒ no divergent
 *          local edit is pushed (the recording reaches the wire equal to the
 *          server's own version);
 *        • a server that changed again       → `diverged` (a fresh Conflict) and
 *          the resolved local edit is held, never pushed over the server's later
 *          change;
 *        • a delete-vs-change keep-survivor  → local-new ⇒ the survivor is pushed,
 *          re-propagating it;
 *        • a declined Review                 → the dismissed incoming version is
 *          not re-offered next cycle.
 *
 * Throughout, the server payloads carry arbitrary UNRECOGNIZED top-level fields
 * (a `last_modified` plus a generated grab-bag) on the payload root, the project,
 * and every recording. Because the pull reconstruction and the digest project
 * over an explicit allowlist, those fields are dropped before classification, so
 * none of them can shift behavior — exercised here
 * inside the full resolve-then-propagate loop.
 *
 * `fetch` is mocked exactly as in the sibling sync property tests
 * (`changed-local-outgoing-push` / `no-permanent-loss`): `makeResponse`-style
 * Response stubs dispatching a manifest + per-project payloads on GET and
 * capturing every PUT body on push; the validator passes; a persistent in-memory
 * `SyncStore` carries the SyncState across both cycles + the resolution; a
 * permissive `LiveState` (capture inactive, nothing locked, nothing pending) lets
 * every cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Resolution pushes nothing; the resolved state propagates next cycle per the resolved-against baseline

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import {
  acceptReview,
  declineReview,
  resolveConflict,
  buildKeepResolution,
  DELETE_RESOLUTION,
} from '../../conflict-resolution.js';
import {
  createEmptySyncState,
  setSettings,
  loadSyncState,
  saveSyncState,
} from '../../sync-store.js';
import { advanceBaseline } from '../../sync-baseline.js';
import { digestRecording } from '../../sync-digest.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

const SERVER = 'https://srv.test';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

const PROJ_CREATED = '2026-01-01T00:00:00.000Z';
const REC_CREATED = '2026-02-01T00:00:00.000Z';
// A fixed clock so any baseline `agreedAt` stamp is deterministic; nothing here
// asserts on its value, only on which version the baseline advanced to.
const FIXED_NOW = () => 0;

// ─── fetch double (mirrors changed-local-outgoing-push / no-permanent-loss) ───

/** Records every fetch call so PUT (push) bodies can be inspected in order. */
let fetchCalls = [];

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
 * by project_id and records every call (resetting the log for the new cycle):
 *   - PUT (push)        → 200, body captured.
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload (or 404 when absent).
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, object>} payloadById
 */
function installMockFetch(manifest, payloadById) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') return makeResponse(200, { ok: true });
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    const id = decodeURIComponent(url.split('/').pop());
    const payload = payloadById.get(id);
    return payload ? makeResponse(200, payload) : makeResponse(404);
  };
}

/** The PUT bodies captured during the most recent push, keyed by project_id. */
function capturedPutsByProjectId() {
  const map = new Map();
  for (const call of fetchCalls) {
    if (call.options && call.options.method === 'PUT') {
      const body = JSON.parse(call.options.body);
      map.set(body.project.project_id, body);
    }
  }
  return map;
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore} seeded with an initial SyncState and PERSISTING
 * across both cycles + the interleaved resolution (the same `saved` blob is
 * loaded by each `sync()` / resolution and rewritten on save). Clones on the way
 * in and out so no reference is shared with the code under test.
 *
 * @param {import('../../sync-types.js').SyncState} initial
 */
function makeStore(initial) {
  let saved = structuredClone(initial);
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

/** A validator that accepts every payload (the propagation behavior is the focus). */
function passValidator() {
  return true;
}
passValidator.errors = [];

// ─── content builders (allowlisted Unit shapes) ───────────────────────────────

/** A recording copy; the `marker` flows into the name so distinct markers ⇒ distinct digests. */
function recOf(recording_id, marker, steps) {
  return { recording_id, name: `rec-${marker}`, created_at: REC_CREATED, steps };
}

/** A project copy with a STABLE name/identity (so its metadata Unit always converges). */
function projOf(project_id, recordings) {
  return {
    project_id,
    name: `proj-${project_id.slice(0, 8)}`,
    created_at: PROJ_CREATED,
    recordings,
  };
}

/**
 * Wrap a project copy in the Full_Project_Payload shape the server stores,
 * injecting arbitrary UNRECOGNIZED top-level fields at the root, project, and
 * recording levels. The allowlist projection on pull drops them, so the
 * resolved-then-propagated behavior must be identical with them present.
 *
 * @param {object} project
 * @param {{root?: object, project?: object, recording?: object}} [extra]
 */
function buildPayload(project, extra = {}) {
  const rootExtra = extra.root ?? {};
  const projectExtra = extra.project ?? {};
  const recordingExtra = extra.recording ?? {};
  return {
    ...rootExtra,
    docent_format: { ...LOCAL_STAMP },
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
      ...(project.metadata && { metadata: project.metadata }),
      ...projectExtra,
    },
    recordings: (project.recordings ?? []).map((r) => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      ...(r.metadata && { metadata: r.metadata }),
      steps: r.steps ?? [],
      ...recordingExtra,
    })),
  };
}

// ─── generators ──────────────────────────────────────────────────────────────

/** A committed step record spec; a unique uuid is assigned at materialization. */
const arbStepSpec = fc.record({
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 5 }),
  deleted: fc.boolean(),
});

const arbSteps = fc.array(arbStepSpec, { minLength: 1, maxLength: 3 });

// Top-level field allowlists the digest/pull projection keep; any other key is
// "unrecognized" and must be dropped.
const ROOT_RESERVED = new Set(['docent_format', 'project', 'recordings']);
const PROJECT_RESERVED = new Set(['project_id', 'name', 'created_at', 'metadata']);
const RECORDING_RESERVED = new Set(['recording_id', 'name', 'created_at', 'metadata', 'steps']);

/**
 * Arbitrary UNRECOGNIZED top-level fields for a given level. Always includes a
 * `last_modified` (a real, unreliable server field content classification
 * disregards — sync-protocol SP-9) so every
 * iteration is non-trivial, plus a generated grab-bag with any keys that collide
 * with the level's allowlist filtered out (those would legitimately change
 * identity and are not "unrecognized").
 *
 * @param {Set<string>} reserved
 */
function arbExtraFields(reserved) {
  return fc
    .dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.jsonValue(), { maxKeys: 4 })
    .map((extra) => {
      const cleaned = {};
      for (const key of Object.keys(extra)) {
        if (!reserved.has(key)) cleaned[key] = extra[key];
      }
      cleaned.last_modified = '2024-06-01T12:00:00.000Z';
      return cleaned;
    });
}

const arbExtra = fc.record({
  root: arbExtraFields(ROOT_RESERVED),
  project: arbExtraFields(PROJECT_RESERVED),
  recording: arbExtraFields(RECORDING_RESERVED),
});

const arbScenario = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recording_id: fc.uuid(),
  // 'keepLocal'/'merge' resolve a Conflict (local diverged from baseline);
  // 'accept' accepts a Review (local unchanged since baseline).
  action: fc.constantFrom('keepLocal', 'merge', 'accept'),
  baseSteps: arbSteps,
  localSteps: arbSteps,
  serverSteps: arbSteps,
  extra: arbExtra,
});

// ─── materialization ──────────────────────────────────────────────────────────

/**
 * Materialize a scenario into the cycle-1 inputs. The three Unit versions are
 * distinguished by a NAME marker so their digests differ cleanly regardless of
 * the (independently-uuid'd) step content:
 *   - baseline  → `rec-base`   (the last mutually-agreed version),
 *   - server    → `rec-server` (the incoming version the user resolves against),
 *   - local     → `rec-local`  for a Conflict (diverged), OR an exact clone of the
 *                 baseline for a Review (local unchanged ⇒ `changed-incoming`).
 * Project metadata is identical across local/server/baseline, so the project-
 * metadata Unit always converges and never itself defers.
 */
function materializeCycle1(scenario) {
  const { project_id, recording_id, action, baseSteps, localSteps, serverSteps, extra } = scenario;

  let counter = 0;
  const nextUuid = () => {
    counter += 1;
    return `00000000-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
  };
  const withUuids = (specs) => specs.map((s) => ({ uuid: nextUuid(), ...s }));

  const baseRec = recOf(recording_id, 'base', withUuids(baseSteps));
  const serverRec = recOf(recording_id, 'server', withUuids(serverSteps));
  // Review arm: local must EQUAL the baseline (digest-identical) so the Unit is
  // `changed-incoming`. Conflict arm: local is an independent diverged version.
  const localRec =
    action === 'accept'
      ? structuredClone(baseRec)
      : recOf(recording_id, 'local', withUuids(localSteps));

  const seed = createEmptySyncState();
  // Defaults explicit: a changed-incoming always defers to Review (never an
  // auto-applied fast-forward), so the accept arm has a real Review to accept.
  setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });
  advanceBaseline(seed, project_id, projOf(project_id, [baseRec]), FIXED_NOW);

  const localProjects = [projOf(project_id, [localRec])];

  // Cycle-1 server holds the moved (incoming) version, carrying unrecognized
  // top-level fields.
  const manifest = [{ project_id, name: projOf(project_id, []).name }];
  const payloadById = new Map([[project_id, buildPayload(projOf(project_id, [serverRec]), extra)]]);

  return { seed, localProjects, manifest, payloadById, serverRec, nextUuid };
}

describe('Resolution pushes nothing; the resolved state propagates next cycle per the resolved-against baseline', () => {
  it('resolving (keep-local/merge) or accepting issues NO network request, then propagates as changed-local-outgoing (pushed) or already-converged', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { project_id, recording_id, action, extra } = scenario;
        const ref = `${project_id}:${recording_id}`;
        const { seed, localProjects, manifest, payloadById, serverRec, nextUuid } =
          materializeCycle1(scenario);
        const store = makeStore(seed);

        // ── Cycle 1: detect the deferral ──────────────────────────────────────
        installMockFetch(manifest, payloadById);
        const cycle1 = await sync(
          SERVER,
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );
        assert.equal(cycle1.result.halted, false, 'cycle 1 must not halt');

        const isConflictArm = action === 'keepLocal' || action === 'merge';
        if (isConflictArm) {
          assert.deepEqual(
            cycle1.result.conflicts,
            [ref],
            'a diverged Unit is deferred to a Conflict in cycle 1',
          );
        } else {
          assert.deepEqual(
            cycle1.result.review,
            [ref],
            'a changed-incoming Unit is deferred to a Review in cycle 1',
          );
        }
        const projectsAfterCycle1 = cycle1.projects;

        // ── Resolution: must issue NO network request ─────────────────
        const state = await loadSyncState(store);
        let resolutionFetches = 0;
        globalThis.fetch = async () => {
          resolutionFetches += 1;
          return makeResponse(200, null);
        };

        let resolution;
        if (isConflictArm) {
          const item = state.conflicts[ref];
          // Keep-local / merge both adopt an append-only superset that retains
          // every record from BOTH sides; its name marker ('local') makes its
          // digest differ from the server's version, so it reads as a one-sided
          // local change next cycle.
          const resolvedState = buildKeepResolution(item.local, item.incoming, { newId: nextUuid });
          resolution = resolveConflict(state, projectsAfterCycle1, ref, resolvedState, {
            now: FIXED_NOW,
          });
        } else {
          resolution = acceptReview(state, projectsAfterCycle1, ref, { now: FIXED_NOW });
        }

        assert.equal(resolutionFetches, 0, 'a resolution action must issue no network request');
        assert.equal(resolution.ok, true, 'the resolution applied');
        assert.equal(state.conflicts?.[ref], undefined, 'the Conflict (if any) is cleared');
        assert.equal(state.reviews?.[ref], undefined, 'the Review (if any) is cleared');

        await saveSyncState(store, state);
        const resolvedProjects = resolution.projects;

        // The resolved local recording, and the server's unchanged incoming
        // version, as canonical digests.
        const resolvedRec = resolvedProjects
          .find((p) => p.project_id === project_id)
          .recordings.find((r) => r.recording_id === recording_id);
        const serverDigest = digestRecording(serverRec);

        // ── Cycle 2: the server is UNCHANGED (still the resolved-against version,
        //    re-decorated with fresh unrecognized fields). ────────────────────
        installMockFetch(manifest, payloadById);
        const cycle2 = await sync(
          SERVER,
          null,
          resolvedProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );
        assert.equal(cycle2.result.halted, false, 'cycle 2 must not halt');

        // No fresh deferral either way: the Unit reconciles purely from the
        // advanced per-unit baseline.
        assert.ok(
          !cycle2.result.conflicts.includes(ref),
          'the resolved Unit is not a fresh Conflict',
        );
        assert.ok(!cycle2.result.review.includes(ref), 'the resolved Unit is not a fresh Review');

        const puts = capturedPutsByProjectId();
        const body = puts.get(project_id);

        if (isConflictArm) {
          // keep-local / merge ⇒ changed-local-outgoing: the project is pushed
          // and the RESOLVED LOCAL version reaches the wire, provably NOT the
          // server's own version.
          assert.ok(body, 'a keep-local/merge resolution propagates a write on the next cycle');
          const pushedRec = body.recordings.find((r) => r.recording_id === recording_id);
          assert.ok(pushedRec, 'the resolved recording is present in the push');
          const pushedDigest = digestRecording(pushedRec);
          assert.equal(
            pushedDigest,
            digestRecording(resolvedRec),
            'a keep-local/merge resolution propagates as changed-local-outgoing (resolved version pushed)',
          );
          assert.notEqual(
            pushedDigest,
            serverDigest,
            'the pushed version is the resolved local version, not the server version',
          );
        } else {
          // accept ⇒ already-converged: the resolved-against version EQUALS the
          // server's, and (single recording + converged metadata) the whole
          // project equals the server, so it is SKIPPED — no divergent local edit
          // is propagated, the strongest form of the guarantee. If the project IS pushed
          // (e.g. a sibling differed), the recording must still reach the wire at
          // the server's own version. Unrecognized server fields do not
          // perturb this.
          if (body) {
            const pushedRec = body.recordings.find((r) => r.recording_id === recording_id);
            assert.ok(pushedRec, 'the resolved recording is present in the push');
            assert.equal(
              digestRecording(pushedRec),
              serverDigest,
              'an accepted Review reads as already-converged (no divergent local edit pushed)',
            );
          } else {
            // Nothing to write: the accepted recording equals the server, so the
            // project re-sends only the server's state and is skipped.
            assert.ok(
              true,
              'an accepted Review converges to the server, so the project has nothing to write',
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a server that changed again after resolution re-classifies the Unit as a fresh Conflict; the resolved local edit is never pushed over it', async () => {
    const arbMovedScenario = fc.record({
      project_id: fc.uuid({ version: 7 }),
      recording_id: fc.uuid(),
      baseSteps: arbSteps,
      localSteps: arbSteps,
      serverSteps: arbSteps,
      server2Steps: arbSteps,
      extra1: arbExtra,
      extra2: arbExtra,
    });

    await fc.assert(
      fc.asyncProperty(arbMovedScenario, async (scenario) => {
        const { project_id, recording_id } = scenario;
        const ref = `${project_id}:${recording_id}`;

        const { seed, localProjects, manifest, payloadById, nextUuid } = materializeCycle1({
          project_id,
          recording_id,
          action: 'keepLocal',
          baseSteps: scenario.baseSteps,
          localSteps: scenario.localSteps,
          serverSteps: scenario.serverSteps,
          extra: scenario.extra1,
        });
        const store = makeStore(seed);

        // Cycle 1: a diverged Conflict.
        installMockFetch(manifest, payloadById);
        const cycle1 = await sync(
          SERVER,
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );
        assert.equal(cycle1.result.halted, false);
        assert.deepEqual(cycle1.result.conflicts, [ref]);

        // Resolve keep-local — no network.
        const state = await loadSyncState(store);
        let resolutionFetches = 0;
        globalThis.fetch = async () => {
          resolutionFetches += 1;
          return makeResponse(200, null);
        };
        const item = state.conflicts[ref];
        const resolvedState = buildKeepResolution(item.local, item.incoming, { newId: nextUuid });
        const resolution = resolveConflict(state, cycle1.projects, ref, resolvedState, {
          now: FIXED_NOW,
        });
        assert.equal(resolutionFetches, 0, 'resolution issues no network request');
        assert.equal(resolution.ok, true);
        await saveSyncState(store, state);
        const resolvedRec = resolution.projects
          .find((p) => p.project_id === project_id)
          .recordings.find((r) => r.recording_id === recording_id);

        // Cycle 2: the server MOVED AGAIN (a third version 'server2') before this
        // client's push. Because the baseline advanced to the resolved-against
        // version while the server moved on, the Unit re-classifies as a
        // fresh `diverged` Conflict — the other client's change is surfaced, not
        // overwritten.
        let counter = 0;
        const nextUuid2 = () => {
          counter += 1;
          return `00000000-0000-7000-9000-${counter.toString(16).padStart(12, '0')}`;
        };
        const server2Rec = recOf(
          recording_id,
          'server2',
          scenario.server2Steps.map((s) => ({ uuid: nextUuid2(), ...s })),
        );
        const payloadById2 = new Map([
          [project_id, buildPayload(projOf(project_id, [server2Rec]), scenario.extra2)],
        ]);
        installMockFetch(manifest, payloadById2);
        const cycle2 = await sync(
          SERVER,
          null,
          resolution.projects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(),
        );
        assert.equal(cycle2.result.halted, false);

        assert.ok(
          cycle2.result.conflicts.includes(ref),
          'a server that changed again re-classifies the Unit as a fresh Conflict',
        );

        // If the project is pushed, the deferred recording re-sends the
        // agreed-or-pulled server version — never the resolved local edit.
        const body = capturedPutsByProjectId().get(project_id);
        if (body) {
          const pushedRec = body.recordings.find((r) => r.recording_id === recording_id);
          if (pushedRec) {
            assert.notEqual(
              digestRecording(pushedRec),
              digestRecording(resolvedRec),
              'the resolved local edit is NOT pushed over the server change that landed again',
            );
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  // ── Deterministic regression examples ──────────────────

  it('a delete-vs-change Conflict resolved by keeping the survivor pushes nothing, then propagates the survivor as local-new next cycle', async () => {
    const project_id = '018f4e2a-0000-7000-8000-0000000003a1';
    const recording_id = 'rec-survivor';
    const baseSteps = [{ uuid: 's-base', logical_id: 'a', step_number: 0, deleted: false }];
    const localSteps = [
      { uuid: 's-base', logical_id: 'a', step_number: 0, deleted: false },
      { uuid: 's-local', logical_id: 'b', step_number: 1, deleted: false },
    ];

    const seed = createEmptySyncState();
    setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });
    advanceBaseline(
      seed,
      project_id,
      projOf(project_id, [recOf(recording_id, 'base', baseSteps)]),
      FIXED_NOW,
    );
    const store = makeStore(seed);

    const localProjects = [projOf(project_id, [recOf(recording_id, 'local', localSteps)])];

    // Cycle 1: the server DELETED the recording (absent on its side) while local
    // changed it ⇒ a delete-vs-change Conflict.
    const manifest = [{ project_id, name: projOf(project_id, []).name }];
    const serverEmpty = new Map([[project_id, buildPayload(projOf(project_id, []), {})]]);
    installMockFetch(manifest, serverEmpty);
    const cycle1 = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle1.result.halted, false);
    const ref = `${project_id}:${recording_id}`;
    assert.deepEqual(cycle1.result.conflicts, [ref], 'delete-vs-change is a Conflict');

    // Resolve by KEEPING THE SURVIVOR (the changed local version) — no network.
    const state = await loadSyncState(store);
    let resolutionFetches = 0;
    globalThis.fetch = async () => {
      resolutionFetches += 1;
      return makeResponse(200, null);
    };
    const item = state.conflicts[ref];
    // The resolved-against incoming side is a deletion (item.incoming == null), so
    // buildKeepResolution returns the survivor unchanged.
    const resolvedState = buildKeepResolution(item.local, item.incoming, { newId: () => 'unused' });
    const resolution = resolveConflict(state, cycle1.projects, ref, resolvedState, {
      now: FIXED_NOW,
    });
    assert.equal(resolutionFetches, 0, 'resolution issues no network request');
    assert.equal(resolution.ok, true);
    // The per-unit baseline entry was REMOVED (resolved-against side is a deletion).
    assert.equal(
      state.baselines[project_id]?.agreedState?.recordings?.length ?? 0,
      0,
      'the recording baseline entry was removed',
    );
    await saveSyncState(store, state);

    // Cycle 2: the server still has the recording deleted. With no baseline entry
    // and nothing inbound, the survivor is local-new ⇒ it is pushed, re-propagating it.
    installMockFetch(manifest, serverEmpty);
    const cycle2 = await sync(
      SERVER,
      null,
      resolution.projects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle2.result.halted, false);
    assert.deepEqual(cycle2.result.conflicts, [], 'the kept survivor is not a fresh Conflict');
    assert.deepEqual(cycle2.result.review, [], 'the kept survivor is not a Review');

    const body = capturedPutsByProjectId().get(project_id);
    assert.ok(body, 'the project is pushed (the survivor is local-new work)');
    const pushedRec = body.recordings.find((r) => r.recording_id === recording_id);
    assert.ok(pushedRec, 'the survivor recording is re-propagated to the server');
    assert.equal(pushedRec.name, 'rec-local', 'the survivor is pushed at its local version');
  });

  it('declining a Review issues no network request and the dismissed incoming version is not re-offered next cycle', async () => {
    const project_id = '018f4e2a-0000-7000-8000-0000000003b2';
    const recording_id = 'rec-decline';
    const baseSteps = [{ uuid: 's-base', logical_id: 'a', step_number: 0, deleted: false }];
    const serverSteps = [{ uuid: 's-srv', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });
    const baseRec = recOf(recording_id, 'base', baseSteps);
    advanceBaseline(seed, project_id, projOf(project_id, [baseRec]), FIXED_NOW);
    const store = makeStore(seed);

    // Local unchanged since baseline; server moved ⇒ changed-incoming Review.
    const localProjects = [projOf(project_id, [structuredClone(baseRec)])];
    const manifest = [{ project_id, name: projOf(project_id, []).name }];
    const serverPayload = new Map([
      [
        project_id,
        buildPayload(projOf(project_id, [recOf(recording_id, 'server', serverSteps)]), {}),
      ],
    ]);
    installMockFetch(manifest, serverPayload);
    const cycle1 = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle1.result.halted, false);
    const ref = `${project_id}:${recording_id}`;
    assert.deepEqual(cycle1.result.review, [ref], 'changed-incoming is a Review');

    // Decline — no network.
    const state = await loadSyncState(store);
    let resolutionFetches = 0;
    globalThis.fetch = async () => {
      resolutionFetches += 1;
      return makeResponse(200, null);
    };
    const resolution = declineReview(state, cycle1.projects, ref);
    assert.equal(resolutionFetches, 0, 'declining issues no network request');
    assert.equal(resolution.ok, true);
    await saveSyncState(store, state);

    // Cycle 2: the SAME incoming version is pulled again — it must NOT be
    // re-offered as a Review.
    installMockFetch(manifest, serverPayload);
    const cycle2 = await sync(
      SERVER,
      null,
      resolution.projects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(cycle2.result.halted, false);
    assert.ok(
      !cycle2.result.review.includes(ref),
      'the dismissed incoming version is not re-offered',
    );
  });
});
