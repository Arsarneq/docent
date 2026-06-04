/**
 * locked-recording-exclusion.property.test.js — Property test that a
 * Locked_Recording is excluded from the INBOUND merge while every other Unit in
 * the same cycle still reconciles normally.
 *
 * A recording open in the Recording_View is a Locked_Recording. The sync cycle
 * must neither apply nor offer any incoming change to it (R6.1, R6.3) — and that
 * exclusion covers EVERY inbound outcome a non-locked recording could take this
 * cycle: a deferred Review-and-Accept, a deferred Conflict, a settings-gated
 * AUTO-APPLIED fast-forward update, and a settings-gated AUTO-APPLIED server
 * deletion. None of these may touch a locked recording. Meanwhile the cycle must
 * keep syncing all OTHER projects and recordings (R6.2). Because the lock is
 * consulted only this cycle, and detection runs only on committed
 * `recording.steps`, a locked recording is also kept out of detection/merge
 * (R8.3) — a hard exclusion, not an advisory check (R15.4).
 *
 * The exclusion is INBOUND-ONLY. A locked recording is STILL PRESENT in the
 * outbound push at its agreed-or-pulled version (Property 35, task 22.3) — it is
 * never dropped — but it receives no inbound change. This test pins the inbound
 * half of that contract: the locked recording gets no Review, no Conflict, no
 * auto-apply, and its LOCAL data is left untouched in the merged-projects list,
 * while the outbound presence is covered by `locked-recording-push-preservation`.
 *
 * This property drives the full `sync()` orchestrator (not the detector in
 * isolation) with BOTH reconciliation-policy toggles ON
 * (`autoAcceptUpdates` + `autoAcceptDeletions`), so the settings-gated auto-apply
 * paths are live and the test can prove the lock suppresses them too. One
 * existing project is populated with recordings of mixed FATES against a seeded
 * Sync_Baseline:
 *
 *   - `locked-ff-update`      — server fast-forwarded it (append-only superset),
 *                               local unchanged, but LOCKED. Absent the lock and
 *                               with the toggle ON this would AUTO-APPLY; locked,
 *                               it is `locked-skipped`.
 *   - `locked-nonff-change`   — server changed it NON-fast-forward (a step uuid
 *                               dropped), local unchanged, but LOCKED. Absent the
 *                               lock this would be a Review even with the toggle
 *                               ON; locked, it is skipped.
 *   - `locked-diverged`       — both sides moved from baseline, but LOCKED. Absent
 *                               the lock this would be a Conflict; locked, skipped.
 *   - `locked-server-deletion`— server deleted it, local == baseline, but LOCKED.
 *                               Absent the lock and with the toggle ON this would
 *                               AUTO-APPLY the deletion (removed from the merged
 *                               list); locked, it STAYS present at its local copy.
 *   - `nonlocked-ff-update`   — fast-forward ⇒ AUTO-APPLIED update (toggle ON):
 *                               the incoming version is adopted, baseline advances.
 *   - `nonlocked-nonff-change`— non-fast-forward ⇒ a Review item (toggle ON does
 *                               not auto-apply a non-fast-forward), local untouched.
 *   - `nonlocked-diverged`    — diverged ⇒ a Conflict retaining both versions.
 *   - `nonlocked-converged`   — identical on both sides ⇒ already-converged.
 *   - `nonlocked-brandnew`    — server-only sibling ⇒ auto-added to the project.
 *   - `nonlocked-server-deletion` — server deleted it ⇒ AUTO-APPLIED deletion
 *                               (toggle ON): removed from the merged list and
 *                               cleared from the baseline.
 *
 * After one cycle the property asserts, for EVERY locked recording, that:
 *   - it is STILL PRESENT in the merged projects at its local version, byte for
 *     byte (no incoming change applied, not removed by an auto-deletion), and
 *   - no Review, no Conflict, no auto-applied-update, and no auto-applied-deletion
 *     references it (its change is neither applied nor offered), and
 *   - its Sync_Baseline entry is unchanged (no advance, no clear).
 * And, for the non-locked recordings, that each reconciled exactly as its fate
 * dictates — so the locked exclusion is total across every inbound outcome while
 * the rest of the cycle is unaffected. The four reported sets
 * (`review`/`conflicts`/`autoAppliedUpdates`/`autoAppliedDeletions`) and the
 * stored `reviews`/`conflicts` maps are checked to equal EXACTLY the non-locked
 * outcomes, which is the strongest statement that no locked unit leaked in.
 *
 * Note on snapshot retention: pull lands each accepted payload into a
 * PROJECT-level Sync_Snapshot (R9.1); retaining the incoming copy is harmless
 * because the lock's guarantee is that no incoming change is ever *applied or
 * offered* for the locked recording — which is exactly what is asserted here.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` (`makeResponse`-style
 * Response stubs) and dispatches per project_id; the validator passes; an
 * in-memory `SyncStore` (seeded with the baseline and both toggles ON) captures
 * the saved `SyncState`; a `LiveState` reports the locked set (capture inactive,
 * nothing pending) so the pre-flight gate lets the cycle proceed.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4:
 * `fc.uuid({ version: 7 })` supplies a project id that passes the manifest's
 * UUIDv7 guard; `fc.uuid()` supplies recording ids; `fc.uniqueArray` keeps step
 * uuids distinct so a dropped step truly removes a uuid for the non-fast-forward
 * fates).
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 8.3, 15.4**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 13: Locked recordings are excluded from inbound merge while other units still reconcile

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
 * In-memory {@link SyncStore}. Seeded with an initial SyncState (the baseline +
 * settings) and captures the last saved state so the test can inspect baselines
 * / reviews / conflicts after the cycle. Clones in and out so no reference is
 * shared.
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
 * A {@link LiveState} that reports the generated locked set. Capture is inactive
 * (so a cycle runs) and there are no Pending Actions (so the pending-actions
 * safety assertion never fires) — the only thing under test is the inbound
 * exclusion of the locked recordings.
 *
 * @param {string[]} locked - recording_ids open in the Recording_View
 * @returns {import('../../sync-types.js').LiveState}
 */
function makeLiveState(locked) {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(locked),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload. */
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
 * Normalize a recording into a plain, allowlisted object. fast-check builds
 * records with a `null` prototype and may produce keys in any order; a JSON
 * round-trip yields plain objects matching the real on-the-wire / in-store data
 * path, so digests and `deepEqual`/JSON comparisons line up with the values the
 * orchestrator stores.
 */
function cleanRecording({ recording_id, name, created_at, steps }) {
  return JSON.parse(JSON.stringify({ recording_id, name, created_at, steps }));
}

/** Compare two recording-shaped values by their allowlisted projection (prototype-agnostic). */
function sameRecording(a, b) {
  return JSON.stringify(recordingProjection(a)) === JSON.stringify(recordingProjection(b));
}

/** Find a recording inside a baseline `agreedState` by id (or null). */
function baselineRecording(state, project_id, recording_id) {
  const recs = state.baselines?.[project_id]?.agreedState?.recordings ?? [];
  return recs.find((r) => r.recording_id === recording_id) ?? null;
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

/** Every reconciliation fate a recording can take this cycle. */
const FATES = [
  'locked-ff-update',
  'locked-nonff-change',
  'locked-diverged',
  'locked-server-deletion',
  'nonlocked-ff-update',
  'nonlocked-nonff-change',
  'nonlocked-diverged',
  'nonlocked-converged',
  'nonlocked-brandnew',
  'nonlocked-server-deletion',
];

/** True when a fate is a locked-recording fate. */
const isLockedFate = (fate) => fate.startsWith('locked-');

/**
 * One recording spec: a stable identity (`recording_id`, `created_at`), a
 * committed `steps` history (unique step uuids so a dropped step truly removes a
 * uuid for the non-fast-forward fates), and the FATE that decides how its
 * local/incoming/baseline versions relate.
 */
const arbRecSpec = fc.record({
  recording_id: fc.uuid(),
  created_at: arbIso,
  steps: fc.uniqueArray(arbStep, { selector: (s) => s.uuid, maxLength: 3 }),
  fate: fc.constantFrom(...FATES),
});

/**
 * A scenario: one existing project plus 2..6 recordings with unique ids and
 * mixed fates. The `.map` coerces the set to ALWAYS contain at least one locked
 * recording (the property requires a non-empty locked set) and at least one
 * non-locked recording (so "every other Unit still reconciles" is exercised),
 * then materializes the local / server / baseline views.
 */
const arbScenario = fc
  .record({
    project_id: fc.uuid({ version: 7 }),
    created_at: arbIso,
    recordings: fc.uniqueArray(arbRecSpec, {
      selector: (r) => r.recording_id,
      minLength: 2,
      maxLength: 6,
    }),
  })
  .map(({ project_id, created_at, recordings }) => {
    const recs = recordings.map((r) => ({ ...r }));
    // Guarantee both groups are non-empty without dropping generated variety.
    if (!recs.some((r) => isLockedFate(r.fate))) recs[0].fate = 'locked-ff-update';
    if (!recs.some((r) => !isLockedFate(r.fate))) {
      recs[recs.length - 1].fate = 'nonlocked-ff-update';
    }
    return materialize(project_id, created_at, recs);
  });

/** A guaranteed-present step so a recording's baseline history is non-empty. */
function seedStep(rid) {
  return { uuid: `seed-${rid}`, logical_id: 'a', step_number: 0, deleted: false };
}

/** A guaranteed-novel step (its uuid is absent from any generated history). */
function extraStep(rid) {
  return { uuid: `ff-extra-${rid}`, logical_id: 'b', step_number: 99, deleted: false };
}

/**
 * Materialize a scenario into the inputs `sync()` needs plus the per-recording
 * expectations. A recording's identity (`recording_id`, `created_at`) is fixed
 * across its versions; the versions differ in content via a `name` marker (the
 * digest folds name into content identity, R2.8) and/or via the committed step
 * history. The markers are:
 *
 *   marker 'base' — the agreed (baseline) content
 *   marker 'loc'  — a local-side change
 *   marker 'srv'  — a server-side change
 *   marker 'same' — converged (identical on both sides)
 *   marker 'new'  — a brand-new server-only recording
 *
 * Step histories drive the fast-forward distinction:
 *   - a fast-forward incoming RETAINS every baseline step uuid and adds one
 *     ({@link extraStep}) — an append-only superset that the orchestrator
 *     auto-applies when Auto-Accept-Updates is ON;
 *   - a non-fast-forward incoming DROPS a baseline step uuid — held for Review
 *     even when the toggle is ON.
 */
function materialize(project_id, created_at, recs) {
  const PROJECT_NAME = 'Project';
  const localRecs = [];
  const serverRecs = [];
  const baselineRecs = [];
  const lockedIds = [];
  const expectations = [];

  const ver = (rid, ca, marker, steps) =>
    cleanRecording({ recording_id: rid, name: marker, created_at: ca, steps });

  for (const r of recs) {
    const { recording_id: rid, created_at: ca, steps, fate } = r;
    const unitRef = `${project_id}:${rid}`;
    // A baseline history guaranteed non-empty, so a non-fast-forward incoming
    // can drop a real uuid (dropping from an empty history would still be a
    // superset of nothing and would auto-apply).
    const baseSteps = steps.length ? steps : [seedStep(rid)];
    const ffSteps = [...baseSteps, extraStep(rid)]; // append-only superset
    const nonffSteps = baseSteps.slice(1); // drops one baseline uuid

    switch (fate) {
      case 'locked-ff-update': {
        const local = ver(rid, ca, 'base', baseSteps);
        const agreed = ver(rid, ca, 'base', baseSteps);
        const incoming = ver(rid, ca, 'base', ffSteps);
        localRecs.push(local);
        serverRecs.push(incoming);
        baselineRecs.push(agreed);
        lockedIds.push(rid);
        expectations.push({ rid, fate, unitRef, local, agreed });
        break;
      }
      case 'locked-nonff-change': {
        const local = ver(rid, ca, 'base', baseSteps);
        const agreed = ver(rid, ca, 'base', baseSteps);
        const incoming = ver(rid, ca, 'base', nonffSteps);
        localRecs.push(local);
        serverRecs.push(incoming);
        baselineRecs.push(agreed);
        lockedIds.push(rid);
        expectations.push({ rid, fate, unitRef, local, agreed });
        break;
      }
      case 'locked-diverged': {
        const local = ver(rid, ca, 'loc', baseSteps);
        const agreed = ver(rid, ca, 'base', baseSteps);
        const incoming = ver(rid, ca, 'srv', baseSteps);
        localRecs.push(local);
        serverRecs.push(incoming);
        baselineRecs.push(agreed);
        lockedIds.push(rid);
        expectations.push({ rid, fate, unitRef, local, agreed });
        break;
      }
      case 'locked-server-deletion': {
        const local = ver(rid, ca, 'base', baseSteps);
        const agreed = ver(rid, ca, 'base', baseSteps);
        // Absent on the server (deleted there); present locally and in baseline.
        localRecs.push(local);
        baselineRecs.push(agreed);
        lockedIds.push(rid);
        expectations.push({ rid, fate, unitRef, local, agreed });
        break;
      }
      case 'nonlocked-ff-update': {
        const local = ver(rid, ca, 'base', baseSteps);
        const incoming = ver(rid, ca, 'base', ffSteps);
        localRecs.push(local);
        serverRecs.push(incoming);
        baselineRecs.push(ver(rid, ca, 'base', baseSteps));
        expectations.push({ rid, fate, unitRef, local, incoming });
        break;
      }
      case 'nonlocked-nonff-change': {
        const local = ver(rid, ca, 'base', baseSteps);
        const incoming = ver(rid, ca, 'base', nonffSteps);
        localRecs.push(local);
        serverRecs.push(incoming);
        baselineRecs.push(ver(rid, ca, 'base', baseSteps));
        expectations.push({ rid, fate, unitRef, local, incoming });
        break;
      }
      case 'nonlocked-diverged': {
        const local = ver(rid, ca, 'loc', baseSteps);
        const incoming = ver(rid, ca, 'srv', baseSteps);
        localRecs.push(local);
        serverRecs.push(incoming);
        baselineRecs.push(ver(rid, ca, 'base', baseSteps));
        expectations.push({ rid, fate, unitRef, local, incoming });
        break;
      }
      case 'nonlocked-converged': {
        const local = ver(rid, ca, 'same', baseSteps);
        const incoming = ver(rid, ca, 'same', baseSteps);
        localRecs.push(local);
        serverRecs.push(incoming);
        baselineRecs.push(ver(rid, ca, 'same', baseSteps));
        expectations.push({ rid, fate, unitRef, local });
        break;
      }
      case 'nonlocked-brandnew': {
        const incoming = ver(rid, ca, 'new', baseSteps);
        // Present only on the server; absent locally and absent from the baseline.
        serverRecs.push(incoming);
        expectations.push({ rid, fate, unitRef, incoming });
        break;
      }
      case 'nonlocked-server-deletion': {
        const local = ver(rid, ca, 'base', baseSteps);
        // Absent on the server (deleted there); present locally and in baseline.
        localRecs.push(local);
        baselineRecs.push(ver(rid, ca, 'base', baseSteps));
        expectations.push({ rid, fate, unitRef, local });
        break;
      }
      default:
        break;
    }
  }

  const meta = { project_id, name: PROJECT_NAME, created_at };
  const localProject = { ...meta, recordings: localRecs };
  const serverProject = { ...meta, recordings: serverRecs };
  const agreedProject = { ...meta, recordings: baselineRecs };

  return { project_id, localProject, serverProject, agreedProject, lockedIds, expectations };
}

/** Seed a SyncState with the agreed baseline and BOTH auto-accept toggles ON. */
function seedState(project_id, agreedProject) {
  const seed = createEmptySyncState();
  seed.settings.autoAcceptUpdates = true;
  seed.settings.autoAcceptDeletions = true;
  advanceBaseline(seed, project_id, projectProjection(agreedProject));
  return seed;
}

// ─── Property 13 ──────────────────────────────────────────────────────────────

describe('Property 13: Locked recordings are excluded from inbound merge while other units still reconcile', () => {
  it('applies and offers NOTHING to a locked recording (no review/conflict/auto-apply, local untouched) while non-locked units reconcile', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { project_id, localProject, serverProject, agreedProject, lockedIds, expectations } =
          scenario;

        const store = makeStore(seedState(project_id, agreedProject));

        installMockFetch(
          [{ project_id, name: localProject.name }],
          new Map([[project_id, buildPayload(serverProject)]]),
        );

        const { result, projects } = await sync(
          'https://srv.test',
          null,
          [localProject],
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(lockedIds),
        );

        // The cycle runs to completion — a locked recording never halts it (R6.2).
        assert.equal(result.halted, false);
        assert.equal(result.haltReason, null);

        const state = store.getState();
        const merged = projects.find((p) => p.project_id === project_id);
        assert.ok(merged, 'the existing project is still present after the cycle');
        const mergedById = new Map(merged.recordings.map((r) => [r.recording_id, r]));
        const lockedSet = new Set(lockedIds);

        // The four reported sets must equal EXACTLY the non-locked outcomes: no
        // locked recording appears in ANY inbound set, and every non-locked one
        // reconciles as its fate dictates (R6.1, R6.2, R6.3, R15.4).
        const refsForFate = (fate) =>
          expectations
            .filter((e) => e.fate === fate)
            .map((e) => e.unitRef)
            .sort();

        const expectedReview = refsForFate('nonlocked-nonff-change');
        const expectedConflicts = refsForFate('nonlocked-diverged');
        const expectedAutoUpdates = refsForFate('nonlocked-ff-update');
        const expectedAutoDeletions = refsForFate('nonlocked-server-deletion');

        assert.deepEqual([...result.review].sort(), expectedReview, 'reported review set');
        assert.deepEqual([...result.conflicts].sort(), expectedConflicts, 'reported conflict set');
        assert.deepEqual(
          [...result.autoAppliedUpdates].sort(),
          expectedAutoUpdates,
          'reported auto-applied-update set',
        );
        assert.deepEqual(
          [...result.autoAppliedDeletions].sort(),
          expectedAutoDeletions,
          'reported auto-applied-deletion set',
        );
        assert.deepEqual(
          Object.keys(state.reviews).sort(),
          expectedReview,
          'stored Review items equal exactly the non-locked non-fast-forward changes',
        );
        assert.deepEqual(
          Object.keys(state.conflicts).sort(),
          expectedConflicts,
          'stored Conflict items equal exactly the non-locked diverged units',
        );

        for (const e of expectations) {
          if (lockedSet.has(e.rid)) {
            // ── Locked recording: fully excluded from the INBOUND merge ──
            // (a) Still PRESENT at its local version — no incoming change applied
            //     and not removed by an auto-applied deletion (R6.3, R8.3).
            const mergedRec = mergedById.get(e.rid);
            assert.ok(
              mergedRec,
              `locked recording ${e.rid} stays present (inbound exclusion is not a deletion)`,
            );
            assert.ok(
              sameRecording(mergedRec, e.local),
              'locked recording is byte-identical to local (no inbound change applied)',
            );
            // (b) No inbound outcome of any kind references it (R6.1, R6.3).
            assert.ok(!result.review.includes(e.unitRef), 'locked recording not offered as Review');
            assert.ok(
              !result.conflicts.includes(e.unitRef),
              'locked recording not recorded as Conflict',
            );
            assert.ok(
              !result.autoAppliedUpdates.includes(e.unitRef),
              'locked recording not auto-applied as an update',
            );
            assert.ok(
              !result.autoAppliedDeletions.includes(e.unitRef),
              'locked recording not auto-applied as a deletion',
            );
            assert.equal(state.reviews[e.unitRef], undefined, 'no Review item stored for it');
            assert.equal(state.conflicts[e.unitRef], undefined, 'no Conflict item stored for it');
            // (c) Its baseline entry is unchanged — no advance, no clear (R8.3).
            const base = baselineRecording(state, project_id, e.rid);
            assert.ok(base, 'locked recording stays recorded in the baseline (not cleared)');
            assert.ok(
              sameRecording(base, e.agreed),
              'locked recording baseline is unchanged (no advance toward incoming)',
            );
            continue;
          }

          // ── Non-locked recordings: reconcile normally ──
          switch (e.fate) {
            case 'nonlocked-ff-update': {
              // Auto-applied: the incoming version is adopted into the merged list
              // and the baseline advances to it (toggle ON + fast-forward).
              assert.ok(
                sameRecording(mergedById.get(e.rid), e.incoming),
                'fast-forward update is auto-applied (incoming adopted)',
              );
              assert.equal(
                state.reviews[e.unitRef],
                undefined,
                'no Review for an auto-applied update',
              );
              assert.equal(state.conflicts[e.unitRef], undefined);
              const base = baselineRecording(state, project_id, e.rid);
              assert.ok(
                base && sameRecording(base, e.incoming),
                'baseline advances to the adopted incoming version',
              );
              break;
            }
            case 'nonlocked-nonff-change': {
              const item = state.reviews[e.unitRef];
              assert.ok(item, `non-fast-forward change ${e.rid} produces a Review item`);
              assert.equal(item.kind, 'review');
              assert.equal(
                JSON.stringify(item.incoming),
                JSON.stringify(recordingProjection(e.incoming)),
                'Review retains the incoming version',
              );
              // Local data is preserved unchanged for a deferred Unit (R9.5).
              assert.ok(sameRecording(mergedById.get(e.rid), e.local), 'local untouched on review');
              break;
            }
            case 'nonlocked-diverged': {
              const item = state.conflicts[e.unitRef];
              assert.ok(item, `diverged ${e.rid} produces a Conflict`);
              assert.equal(item.kind, 'conflict');
              assert.equal(
                JSON.stringify(item.local),
                JSON.stringify(recordingProjection(e.local)),
                'Conflict retains the local version',
              );
              assert.equal(
                JSON.stringify(item.incoming),
                JSON.stringify(recordingProjection(e.incoming)),
                'Conflict retains the incoming version',
              );
              assert.ok(
                sameRecording(mergedById.get(e.rid), e.local),
                'local untouched on conflict',
              );
              break;
            }
            case 'nonlocked-converged': {
              assert.equal(state.reviews[e.unitRef], undefined);
              assert.equal(state.conflicts[e.unitRef], undefined);
              assert.ok(
                sameRecording(mergedById.get(e.rid), e.local),
                'converged recording stays at its (equal) local version',
              );
              break;
            }
            case 'nonlocked-brandnew': {
              assert.equal(state.reviews[e.unitRef], undefined);
              assert.equal(state.conflicts[e.unitRef], undefined);
              const mergedRec = mergedById.get(e.rid);
              assert.ok(mergedRec, `brand-new recording ${e.rid} is auto-added as a sibling`);
              assert.ok(
                sameRecording(mergedRec, e.incoming),
                'brand-new recording equals the pulled projection',
              );
              const inBaseline = baselineRecording(state, project_id, e.rid);
              assert.ok(inBaseline, 'brand-new recording is recorded in the baseline');
              break;
            }
            case 'nonlocked-server-deletion': {
              // Auto-applied deletion (toggle ON): removed from the merged list and
              // cleared from the baseline.
              assert.equal(
                mergedById.get(e.rid),
                undefined,
                'server deletion is auto-applied (recording removed from the merged list)',
              );
              assert.ok(
                result.autoAppliedDeletions.includes(e.unitRef),
                'the deletion is reported as auto-applied',
              );
              assert.equal(
                state.reviews[e.unitRef],
                undefined,
                'no Review for an auto-applied deletion',
              );
              assert.equal(state.conflicts[e.unitRef], undefined);
              assert.equal(
                baselineRecording(state, project_id, e.rid),
                null,
                'baseline is cleared for the auto-applied deletion',
              );
              break;
            }
            default:
              break;
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ──────────────────────────────────────

  const ID = '018f0000-0000-7000-8000-000000000010';

  /** A recording carrying the given step history. */
  function rec(recording_id, name, steps) {
    return { recording_id, name, created_at: '2026-01-01T00:00:00.000Z', steps };
  }

  const S0 = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];
  const S1 = [...S0, { uuid: 's2', logical_id: 'b', step_number: 1, deleted: false }];

  function seedWith(agreedProject) {
    const seed = createEmptySyncState();
    seed.settings.autoAcceptUpdates = true;
    seed.settings.autoAcceptDeletions = true;
    advanceBaseline(seed, ID, projectProjection(agreedProject));
    return seed;
  }

  it('a locked fast-forward update is skipped while a sibling fast-forward update is auto-applied', async () => {
    const LOCKED = '018f0000-0000-7000-8000-0000000000a1';
    const OPEN = '018f0000-0000-7000-8000-0000000000a2';

    // Baseline + local agree (steps S0); the server fast-forwarded BOTH to S1.
    const baseLocked = rec(LOCKED, 'base', S0);
    const baseOpen = rec(OPEN, 'base', S0);
    const localProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [baseLocked, baseOpen],
    };
    const serverProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [rec(LOCKED, 'base', S1), rec(OPEN, 'base', S1)],
    };

    const store = makeStore(seedWith(localProject));
    installMockFetch([{ project_id: ID, name: 'P' }], new Map([[ID, buildPayload(serverProject)]]));

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState([LOCKED]), // LOCKED is open in the Recording_View
    );

    const state = store.getState();
    const merged = projects.find((p) => p.project_id === ID);
    const byId = new Map(merged.recordings.map((r) => [r.recording_id, r]));

    // Locked recording: untouched, NOT auto-applied, baseline not advanced.
    assert.ok(sameRecording(byId.get(LOCKED), baseLocked), 'locked recording untouched');
    assert.ok(!result.autoAppliedUpdates.includes(`${ID}:${LOCKED}`), 'locked not auto-applied');
    assert.ok(
      sameRecording(baselineRecording(state, ID, LOCKED), baseLocked),
      'locked baseline unchanged',
    );

    // Non-locked sibling: the fast-forward IS auto-applied and the baseline advances.
    assert.deepEqual(
      result.autoAppliedUpdates,
      [`${ID}:${OPEN}`],
      'only the open recording auto-applies',
    );
    assert.ok(
      sameRecording(byId.get(OPEN), rec(OPEN, 'base', S1)),
      'open recording adopts incoming',
    );
    assert.ok(
      sameRecording(baselineRecording(state, ID, OPEN), rec(OPEN, 'base', S1)),
      'open recording baseline advances to incoming',
    );
  });

  it('a locked server-deletion stays present while a sibling server-deletion is auto-applied', async () => {
    const LOCKED = '018f0000-0000-7000-8000-0000000000b1';
    const OPEN = '018f0000-0000-7000-8000-0000000000b2';

    // Baseline + local hold BOTH recordings; the server deleted BOTH.
    const baseLocked = rec(LOCKED, 'base', S0);
    const baseOpen = rec(OPEN, 'base', S0);
    const localProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [baseLocked, baseOpen],
    };
    // Server payload omits both recordings (deleted server-side).
    const serverProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [],
    };

    const store = makeStore(seedWith(localProject));
    installMockFetch([{ project_id: ID, name: 'P' }], new Map([[ID, buildPayload(serverProject)]]));

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState([LOCKED]),
    );

    const state = store.getState();
    const merged = projects.find((p) => p.project_id === ID);
    const byId = new Map(merged.recordings.map((r) => [r.recording_id, r]));

    // Locked recording: STILL present at its local version, NOT auto-deleted,
    // baseline NOT cleared — the inbound exclusion is not a deletion.
    assert.ok(byId.get(LOCKED), 'locked recording remains in the merged project');
    assert.ok(sameRecording(byId.get(LOCKED), baseLocked), 'locked recording untouched');
    assert.ok(
      !result.autoAppliedDeletions.includes(`${ID}:${LOCKED}`),
      'locked recording deletion not auto-applied',
    );
    assert.ok(
      sameRecording(baselineRecording(state, ID, LOCKED), baseLocked),
      'locked recording still in baseline',
    );

    // Non-locked sibling: the server deletion IS auto-applied (removed + cleared).
    assert.deepEqual(
      result.autoAppliedDeletions,
      [`${ID}:${OPEN}`],
      'only the open recording deletion auto-applies',
    );
    assert.equal(byId.get(OPEN), undefined, 'open recording removed from the merged project');
    assert.equal(baselineRecording(state, ID, OPEN), null, 'open recording cleared from baseline');
  });

  it('a locked diverged recording is skipped while a sibling diverged recording becomes a Conflict', async () => {
    const LOCKED = '018f0000-0000-7000-8000-0000000000d1';
    const OPEN = '018f0000-0000-7000-8000-0000000000d2';

    // Baseline 'base'; local moved to 'loc'; server moved to 'srv' (divergence).
    const localLocked = rec(LOCKED, 'loc', S0);
    const localOpen = rec(OPEN, 'loc', S0);
    const localProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [localLocked, localOpen],
    };
    const serverProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [rec(LOCKED, 'srv', S0), rec(OPEN, 'srv', S0)],
    };
    const agreedProject = {
      project_id: ID,
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [rec(LOCKED, 'base', S0), rec(OPEN, 'base', S0)],
    };

    const store = makeStore(seedWith(agreedProject));
    installMockFetch([{ project_id: ID, name: 'P' }], new Map([[ID, buildPayload(serverProject)]]));

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [localProject],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState([LOCKED]),
    );

    const state = store.getState();
    const merged = projects.find((p) => p.project_id === ID);
    const byId = new Map(merged.recordings.map((r) => [r.recording_id, r]));

    // Locked recording: untouched, no Conflict (a Conflict is never auto-resolved
    // either, so the toggle is irrelevant here — the lock alone excludes it).
    assert.ok(sameRecording(byId.get(LOCKED), localLocked), 'locked recording untouched');
    assert.equal(state.conflicts[`${ID}:${LOCKED}`], undefined, 'locked recording not in conflict');
    assert.ok(!result.conflicts.includes(`${ID}:${LOCKED}`));

    // Non-locked sibling: a Conflict retaining both versions, local untouched.
    assert.deepEqual(result.conflicts, [`${ID}:${OPEN}`], 'only the open recording conflicts');
    const conflict = state.conflicts[`${ID}:${OPEN}`];
    assert.ok(conflict, 'conflict recorded for the open recording');
    assert.equal(JSON.stringify(conflict.local), JSON.stringify(recordingProjection(localOpen)));
    assert.equal(
      JSON.stringify(conflict.incoming),
      JSON.stringify(recordingProjection(rec(OPEN, 'srv', S0))),
    );
    assert.ok(
      sameRecording(byId.get(OPEN), localOpen),
      'open recording local preserved on conflict',
    );
  });
});
