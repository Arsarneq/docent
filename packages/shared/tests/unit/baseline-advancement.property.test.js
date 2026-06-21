/**
 * baseline-advancement.property.test.js — Property test for the Sync_Baseline
 * advancement rules.
 *
 * The Sync_Baseline is the last *mutually agreed* state per project — a state
 * confirmed common to BOTH the local side and the Sync_Server, never merely the
 * state this client last pushed. A push is NOT confirmation of agreement:
 * a concurrent client may overwrite the pushed state before this client observes
 * it, so the baseline must never advance just because a project was pushed.
 * It advances ONLY when:
 *   - a pull confirms the incoming version equals the local version
 *     (`already-converged`), repairing a stale or absent baseline to that
 *     confirmed-agreed state; or
 *   - a brand-new unit is auto-added; or
 *   - a `changed-incoming` recording is auto-applied as a true fast-forward
 *     because Auto-Accept-Updates is ON and the incoming version is an
 *     append-only superset of the baseline; or
 *   - an incoming change is adopted through Review-and-Accept or
 *     Conflict_Resolution, in which case it advances PER-UNIT to the
 *     **resolved-against incoming version** — the incoming version the user
 *     resolved against — NOT to the adopted local-or-merged state.
 * And when a pull-confirmation applies to a project, the baseline is set to the
 * pull-confirmed agreed state, overwriting any prior recorded baseline.
 *
 * It NEVER advances on push, for a `changed-local-outgoing` unit, or on a
 * decline:
 *   - a unit pushed (a `local-only-new` project, or a `changed-local-outgoing`
 *     recording whose local side moved while the server stayed at baseline) is
 *     sent on the wire but its baseline is left exactly where it was — the
 *     headline guarantee that a push alone never advances the baseline; the baseline advances only once a LATER pull confirms incoming ==
 *     local;
 *   - a unit deferred to Review or Conflict leaves the baseline unchanged;
 * and
 *   - declining a Review keeps local and advances NO baseline.
 *
 * This file pins those rules over a large input space, in three parts.
 *
 * **Part A — a whole sync cycle (with Auto-Accept-Updates ON).** For ANY mix of
 * projects across eight categories, after one `sync()` cycle (pull, reconcile,
 * then push):
 *   - `local-only-new` (present locally, absent on the server, no baseline) is
 *     PUSHED yet gets NO baseline — a push alone never advances it;
 *   - `converged` / `converged-stale-baseline` (local equals incoming) advance
 *     the baseline to the pull-confirmed agreed state, repairing/overwriting any
 *     stale recorded baseline;
 *   - `brand-new-incoming` (absent locally, present on the server, no baseline)
 *     advances the baseline to the auto-added state;
 *   - `changed-local-outgoing` (local moved, server still at baseline) is PUSHED
 *     but the baseline is left UNCHANGED — a routine outgoing push never advances
 *     it;
 *   - `changed-incoming-fast-forward` (local unchanged, incoming an append-only
 *     superset of the baseline) is auto-applied and the baseline advances PER-UNIT
 *     to that incoming version;
 *   - `changed-incoming-review` (local unchanged, incoming NOT a fast-forward) and
 *     `diverged` (both sides moved) are deferred (Review / Conflict) but leave the
 *     baseline UNCHANGED — a push plus a deferral never advances it.
 *
 * **Part B — adoption (outside a cycle) advances to the resolved-against
 * incoming version.** For ANY PENDING Review item or Conflict, accepting the
 * review (`acceptReview`) or resolving the conflict (`resolveConflict`) advances
 * the affected Unit's baseline entry PER-UNIT to the **resolved-against incoming
 * version** — for an accept that equals the adopted state, but for a merge
 * resolution it is the incoming version, NOT the merged state the user adopted.
 * Adoption does so with NO sync transport at all (no push/pull).
 *
 * **Part C — declining (outside a cycle) advances NOTHING.** Declining a Review
 * keeps the local version and leaves the baseline exactly where it was — absent
 * if there was none, unchanged if one existed — and touches no network.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling property
 * tests (`makeResponse`-style stubs dispatched per project_id), PUT bodies are
 * logged to prove a project was pushed, an in-memory `SyncStore` captures the
 * saved `SyncState`, and a permissive `LiveState` lets the cycle run. Parts B and
 * C install a `fetch` that records whether it was called, to prove adoption and
 * decline never touch the network.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4:
 * `fc.uuid({ version: 7 })` supplies ids that pass the manifest's UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Baseline advances only on confirmed agreement or adoption, never on push

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { acceptReview, declineReview, resolveConflict } from '../../conflict-resolution.js';
import {
  createEmptySyncState,
  setSettings,
  upsertReview,
  upsertConflict,
  getItem,
} from '../../sync-store.js';
import { advanceBaseline, getBaseline, getRecordingBaselineDigest } from '../../sync-baseline.js';
import { digestProject, digestRecording } from '../../sync-digest.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

const SERVER = 'https://srv.test';
const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';
// A fixed clock so the baseline `agreedAt` stamp is deterministic; nothing here
// asserts on its value — only that the baseline did (or did not) advance.
const FIXED_NOW = () => 0;

// The stamp this client expects — derived from the same schema sync() uses, so
// every server payload below carries a compatible stamp and is accepted.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

// ─── fetch double (mirrors sync-client.test.js) ──────────────────────────────

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

/**
 * Installs a mock `fetch` that logs PUT (push) target URLs and serves a
 * controllable manifest plus per-project payloads keyed by project_id:
 *   - PUT (push)        → 200, URL recorded in `putLog`.
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's payload, or 404 when absent.
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, object>} payloadById
 * @param {string[]} putLog - mutated: each pushed URL is appended in push order
 */
function installMockFetch(manifest, payloadById, putLog) {
  globalThis.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') {
      putLog.push(url);
      return makeResponse(200, { ok: true });
    }
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    const id = decodeURIComponent(url.split('/').pop());
    const payload = payloadById.get(id);
    if (!payload) return makeResponse(404);
    return makeResponse(200, payload);
  };
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore} seeded with `initialState`; captures the last
 * saved {@link SyncState} so baselines can be inspected after the cycle.
 *
 * @param {import('../../sync-types.js').SyncState} initialState
 */
function makeStore(initialState) {
  let saved = initialState;
  return {
    async load() {
      return saved;
    },
    async save(state) {
      saved = state;
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

// ─── content builders (allowlisted Unit shapes) ───────────────────────────────

/** A recording copy; the `marker` flows into the name so distinct markers ⇒ distinct digests. */
function recOf(recording_id, marker, steps) {
  return { recording_id, name: `rec-${marker}`, created_at: FIXED_CREATED_AT, steps };
}

/** A project copy. `nameMarker` lets a stale baseline differ in project identity too. */
function projOf(project_id, recordings, nameMarker = '') {
  return {
    project_id,
    name: `proj-${project_id}${nameMarker}`,
    created_at: FIXED_CREATED_AT,
    recordings,
  };
}

/** Wrap a project copy in the Full_Project_Payload shape the server stores. */
function buildPayload(project) {
  return {
    docent_format: { ...LOCAL_STAMP },
    project: { project_id: project.project_id, name: project.name, created_at: project.created_at },
    recordings: project.recordings.map((r) => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      steps: r.steps,
    })),
  };
}

/** Find a project by id in a projects array. */
function findProject(projects, project_id) {
  return projects.find((p) => p && p.project_id === project_id);
}

/** Find a recording by id within a project. */
function findRecording(project, recording_id) {
  return (project?.recordings ?? []).find((r) => r && r.recording_id === recording_id) ?? null;
}

/**
 * Deep, plain-prototype copy via a JSON round-trip. fast-check builds records
 * with a null prototype; the modules under test store recoverable copies via a
 * JSON round-trip (plain prototype), and `deepStrictEqual` is prototype-sensitive
 * — so normalizing generated step arrays here keeps the comparison about VALUES
 * rather than prototype artifacts, matching how the copies are actually stored.
 */
function jsonNormalize(value) {
  return JSON.parse(JSON.stringify(value));
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbId = fc.uuid({ version: 7 });

/** A committed step record (append-only version entry). */
const arbStep = fc.record({
  uuid: arbId,
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 10 }),
  deleted: fc.boolean(),
});

const arbSteps = fc.array(arbStep, { maxLength: 4 });

const arbCategory = fc.constantFrom(
  'local-only-new',
  'converged',
  'converged-stale-baseline',
  'brand-new-incoming',
  'changed-local-outgoing',
  'changed-incoming-fast-forward',
  'changed-incoming-review',
  'diverged',
);

/**
 * One project's spec: unique ids, a category, and the step content it carries.
 * The fast-forward "extra" step and the non-fast-forward "sentinel" step use
 * deterministic literal uuids (see `materialize`) that can never collide with a
 * generated UUIDv7, so those step-history classifications stay deterministic.
 */
const arbProjectSpec = fc.record({
  project_id: arbId,
  recording_id: arbId,
  category: arbCategory,
  steps: arbSteps,
});

/** A scenario: 1..8 projects with unique ids and a mix of categories. */
const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (s) => s.project_id,
  minLength: 1,
  maxLength: 8,
});

/**
 * Materialize a scenario into the concrete sync inputs (local projects, server
 * manifest + payloads, seeded SyncState) plus an independently-computed
 * expectation per project describing how its baseline must (or must not) move.
 *
 * Auto-Accept-Updates is seeded ON for the cycle so the fast-forward category
 * auto-applies; the setting affects ONLY the two `changed-incoming` cases
 * (a fast-forward auto-applies, a non-fast-forward still defers to Review) and never any other category.
 *
 * Project metadata is held identical across local/incoming/baseline for the
 * present-on-both-sides categories (only the recording markers/steps differ), so
 * the project-metadata sub-unit converges and the recording alone drives the
 * classification.
 */
function materialize(specs) {
  const localProjects = [];
  const manifest = [];
  const payloadById = new Map();
  const seedState = createEmptySyncState();
  // Auto-Accept-Updates ON so a fast-forward `changed-incoming` auto-applies and
  // advances the baseline per-unit. Persisted client-locally.
  setSettings(seedState, { autoAcceptUpdates: true });
  const expectations = [];

  for (const { project_id, recording_id, category, steps } of specs) {
    const onServer = (project) => {
      manifest.push({ project_id, name: project.name });
      payloadById.set(project_id, buildPayload(project));
    };

    switch (category) {
      case 'local-only-new': {
        // Present locally, absent on the server, no baseline → pushed, but a
        // push must NOT create a baseline.
        const local = projOf(project_id, [recOf(recording_id, 'base', steps)]);
        localProjects.push(local);
        expectations.push({ project_id, recording_id, category, pushed: true, baseline: 'absent' });
        break;
      }

      case 'converged': {
        // Local equals incoming → pull confirms agreement → advance to it.
        // The assembled payload equals the server, so the project is skipped.
        const local = projOf(project_id, [recOf(recording_id, 'base', steps)]);
        localProjects.push(local);
        onServer(local);
        expectations.push({
          project_id,
          recording_id,
          category,
          pushed: false,
          baseline: 'advance',
          expectedDigest: digestProject(local),
        });
        break;
      }

      case 'converged-stale-baseline': {
        // Local equals incoming, but a STALE baseline is on record → the pull
        // confirmation must repair/overwrite it to the agreed state.
        // The wire payload equals the server, so the project is skipped.
        const local = projOf(project_id, [recOf(recording_id, 'base', steps)]);
        const stale = projOf(project_id, [recOf(recording_id, 'STALE', steps)], '-stale');
        localProjects.push(local);
        onServer(local);
        advanceBaseline(seedState, project_id, stale, FIXED_NOW);
        expectations.push({
          project_id,
          recording_id,
          category,
          pushed: false,
          baseline: 'advance',
          expectedDigest: digestProject(local),
          forbiddenDigests: [digestProject(stale)],
        });
        break;
      }

      case 'brand-new-incoming': {
        // Absent locally, present on the server, no baseline → auto-add and
        // record it in the baseline. Not local ⇒ not pushed.
        const incoming = projOf(project_id, [recOf(recording_id, 'base', steps)]);
        onServer(incoming);
        expectations.push({
          project_id,
          recording_id,
          category,
          pushed: false,
          baseline: 'advance',
          expectedDigest: digestProject(incoming),
        });
        break;
      }

      case 'changed-local-outgoing': {
        // Local moved since the baseline while the server is STILL at the agreed
        // baseline (incoming == baseline) → a routine outgoing change: pushed
        // automatically, but the baseline is NOT advanced on the push. The
        // baseline stays exactly at the prior agreed state.
        const baseline = projOf(project_id, [recOf(recording_id, 'base', steps)]);
        const local = projOf(project_id, [recOf(recording_id, 'loc', steps)]);
        const incoming = projOf(project_id, [recOf(recording_id, 'base', steps)]); // == baseline
        localProjects.push(local);
        onServer(incoming);
        advanceBaseline(seedState, project_id, baseline, FIXED_NOW);
        expectations.push({
          project_id,
          recording_id,
          category,
          pushed: true,
          baseline: 'unchanged',
          expectedDigest: digestProject(baseline),
          forbiddenDigests: [digestProject(local)],
        });
        break;
      }

      case 'changed-incoming-fast-forward': {
        // Local unchanged since baseline; incoming is an APPEND-ONLY SUPERSET of
        // the baseline (a true fast-forward). With Auto-Accept-Updates ON it is
        // auto-applied and the baseline advances PER-UNIT to the incoming version.
        // The appended step uses a literal uuid that can never collide
        // with a generated UUIDv7, so the superset relation is deterministic.
        const extraStep = {
          uuid: '__ff_extra__',
          logical_id: 'z',
          step_number: 99,
          deleted: false,
        };
        const baselineRec = recOf(recording_id, 'ff', steps);
        const local = projOf(project_id, [recOf(recording_id, 'ff', steps)]); // == baseline rec
        const incomingRec = recOf(recording_id, 'ff', [...steps, extraStep]); // superset
        const incoming = projOf(project_id, [incomingRec]);
        const baseline = projOf(project_id, [baselineRec]);
        localProjects.push(local);
        onServer(incoming);
        advanceBaseline(seedState, project_id, baseline, FIXED_NOW);
        // Per-unit advance: the agreed project with ONLY this recording's entry
        // replaced by the resolved-against (incoming) version.
        const advanced = projOf(project_id, [incomingRec]);
        expectations.push({
          project_id,
          recording_id,
          category,
          // After the auto-apply the merged local recording EQUALS the incoming
          // (server) version, so the wire payload equals the server and the
          // project is skipped.
          pushed: false,
          baseline: 'advance',
          expectedDigest: digestProject(advanced),
          expectedRecordingDigest: digestRecording(incomingRec),
          forbiddenDigests: [digestProject(baseline)],
        });
        break;
      }

      case 'changed-incoming-review': {
        // Local unchanged since baseline; incoming differs but is NOT a
        // fast-forward (it DROPS the baseline's sentinel step), so even with
        // Auto-Accept-Updates ON it is held for Review and the baseline is left
        // UNCHANGED. The sentinel uses a literal uuid that can never
        // collide with a generated UUIDv7, guaranteeing the non-superset.
        const sentinel = { uuid: '__sentinel__', logical_id: 'z', step_number: 99, deleted: false };
        const baselineRec = recOf(recording_id, 'ci', [...steps, sentinel]);
        const local = projOf(project_id, [recOf(recording_id, 'ci', [...steps, sentinel])]); // == baseline
        const incomingRec = recOf(recording_id, 'ci-inc', [...steps]); // drops sentinel ⇒ not FF
        const incoming = projOf(project_id, [incomingRec]);
        const baseline = projOf(project_id, [baselineRec]);
        localProjects.push(local);
        onServer(incoming);
        advanceBaseline(seedState, project_id, baseline, FIXED_NOW);
        expectations.push({
          project_id,
          recording_id,
          category,
          // The deferred recording re-sends the agreed-or-pulled (server) version
          // and local metadata converges, so the wire payload equals the server:
          // the project is skipped.
          pushed: false,
          baseline: 'unchanged',
          expectedDigest: digestProject(baseline),
          forbiddenDigests: [digestProject(incoming)],
          defer: 'review',
        });
        break;
      }

      case 'diverged': {
        // Both sides moved from a common baseline → Conflict, baseline left
        // UNCHANGED (including the concurrent-push case). No setting
        // auto-resolves a divergence.
        const baseline = projOf(project_id, [recOf(recording_id, 'base', steps)]);
        const local = projOf(project_id, [recOf(recording_id, 'loc', steps)]);
        const incoming = projOf(project_id, [recOf(recording_id, 'inc', steps)]);
        localProjects.push(local);
        onServer(incoming);
        advanceBaseline(seedState, project_id, baseline, FIXED_NOW);
        expectations.push({
          project_id,
          recording_id,
          category,
          // The diverged recording re-sends the agreed-or-pulled (server) version
          // and local metadata converges, so the wire payload equals the server:
          // the project is skipped.
          pushed: false,
          baseline: 'unchanged',
          expectedDigest: digestProject(baseline),
          forbiddenDigests: [digestProject(local), digestProject(incoming)],
          defer: 'conflict',
        });
        break;
      }

      default:
        break;
    }
  }

  return { localProjects, manifest, payloadById, seedState, expectations };
}

// ─── Part A: a sync cycle ─────────────────────────────────────────

describe('Baseline advances only on confirmed agreement or adoption, never on push', () => {
  it('a sync cycle advances the baseline only for confirmed agreement, brand-new auto-add, or a fast-forward auto-apply — never merely on push or for a changed-local-outgoing unit', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (specs) => {
        const { localProjects, manifest, payloadById, seedState, expectations } =
          materialize(specs);

        const putLog = [];
        installMockFetch(manifest, payloadById, putLog);
        const store = makeStore(seedState);

        const { result } = await sync(
          SERVER,
          null,
          localProjects,
          STUB_SCHEMA,
          () => true,
          store,
          makeLiveState(),
        );

        // The cycle ran to completion (no live-work gate, no auth failure).
        assert.equal(result.halted, false, 'a clean cycle never halts');
        assert.equal(result.haltReason, null);

        const state = store.getState();
        const reviewSet = new Set(result.review);
        const conflictSet = new Set(result.conflicts);

        for (const exp of expectations) {
          const { project_id, recording_id } = exp;
          const recordingRef = `${project_id}:${recording_id}`;
          const baseline = getBaseline(state, project_id);

          // A project is pushed IFF its assembled payload differs from the
          // server's agreed-or-pulled state. With one recording per
          // project here, that is exactly `local-only-new` (no server
          // counterpart) and `changed-local-outgoing` (local moved, server at
          // baseline); a converged, auto-applied-fast-forward, deferred
          // (Review/Conflict), or brand-new-remote project re-sends only the
          // server's own bytes and is skipped. Wherever the baseline did NOT
          // advance below for a PUSHED project, it is despite the push.
          const wasPushed = putLog.includes(`${SERVER}/projects/${encodeURIComponent(project_id)}`);
          assert.equal(
            wasPushed,
            exp.pushed,
            `${exp.category} project ${project_id} push expectation`,
          );

          switch (exp.baseline) {
            case 'absent': {
              // Pushed a brand-new local project ⇒ NO baseline is created on
              // push; it can only gain one from a later confirmed pull.
              assert.equal(
                baseline,
                null,
                `push alone must not create a baseline for ${exp.category} ${project_id}`,
              );
              break;
            }

            case 'advance': {
              // Confirmed agreement, brand-new auto-add, or a fast-forward
              // auto-apply ⇒ baseline advanced to the agreed/added/incoming
              // state, with a recoverable copy retained.
              assert.ok(baseline, `${exp.category} ${project_id} must have a baseline`);
              assert.equal(
                baseline.digest,
                exp.expectedDigest,
                `${exp.category} ${project_id} baseline must equal the agreed/advanced state`,
              );
              assert.ok(baseline.agreedState, 'baseline must retain a recoverable agreed copy');
              assert.equal(
                digestProject(baseline.agreedState),
                exp.expectedDigest,
                'retained agreedState must match the recorded digest',
              );
              // For a fast-forward auto-apply, the per-unit recording baseline
              // entry equals the resolved-against incoming version.
              if (exp.expectedRecordingDigest) {
                assert.equal(
                  getRecordingBaselineDigest(baseline, recording_id),
                  exp.expectedRecordingDigest,
                  `${exp.category} ${project_id} recording baseline entry must equal the incoming version`,
                );
              }
              for (const forbidden of exp.forbiddenDigests ?? []) {
                assert.notEqual(
                  baseline.digest,
                  forbidden,
                  `${exp.category} ${project_id} must not keep a stale/other digest`,
                );
              }
              // An advanced (agreed) project is never simultaneously deferred.
              assert.ok(!reviewSet.has(project_id), 'agreed project is not a project review');
              assert.ok(!conflictSet.has(project_id), 'agreed project is not a project conflict');
              break;
            }

            case 'unchanged': {
              // Pushed (a changed-local-outgoing push) OR deferred (Review/
              // Conflict) ⇒ the baseline is left at its prior recorded value and
              // never advances to the local or incoming version.
              assert.ok(baseline, `${exp.category} ${project_id} keeps its prior baseline`);
              assert.equal(
                baseline.digest,
                exp.expectedDigest,
                `${exp.category} ${project_id} baseline must be unchanged`,
              );
              for (const forbidden of exp.forbiddenDigests ?? []) {
                assert.notEqual(
                  baseline.digest,
                  forbidden,
                  `${exp.category} ${project_id} baseline must not advance on push/deferral`,
                );
              }
              if (exp.defer === 'review') {
                assert.ok(
                  reviewSet.has(recordingRef),
                  `${exp.category} ${project_id} must be deferred to Review`,
                );
              } else if (exp.defer === 'conflict') {
                assert.ok(
                  conflictSet.has(recordingRef),
                  `${exp.category} ${project_id} must be deferred to Conflict`,
                );
              } else {
                // A changed-local-outgoing unit is a routine automatic push, never
                // a deferral.
                assert.ok(
                  !reviewSet.has(recordingRef),
                  `${exp.category} ${project_id} must not be a Review`,
                );
                assert.ok(
                  !conflictSet.has(recordingRef),
                  `${exp.category} ${project_id} must not be a Conflict`,
                );
              }
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

  // ── Part B: adoption (outside a cycle) advances to resolved-against incoming ─

  /** A step record for the adoption scenarios. */
  const arbAdoptStep = fc.record({
    uuid: arbId,
    logical_id: fc.constantFrom('a', 'b', 'c'),
    step_number: fc.integer({ min: 0, max: 10 }),
    deleted: fc.boolean(),
  });

  const arbAdoption = fc.record({
    project_id: arbId,
    recording_id: arbId,
    mode: fc.constantFrom('accept', 'resolve-merge'),
    localSteps: fc.array(arbAdoptStep, { maxLength: 3 }),
    incomingSteps: fc.array(arbAdoptStep, { maxLength: 3 }),
    seedStaleBaseline: fc.boolean(),
  });

  it('adopting a change (accept review / resolve conflict) advances the baseline PER-UNIT to the resolved-against incoming version, not to the adopted state, with no transport', async () => {
    await fc.assert(
      fc.asyncProperty(arbAdoption, async (scenario) => {
        const { project_id, recording_id, mode, seedStaleBaseline } = scenario;
        // Normalize generated step arrays to plain prototype so deepStrictEqual
        // compares values, not fast-check's null-prototype artifacts.
        const localSteps = jsonNormalize(scenario.localSteps);
        const incomingSteps = jsonNormalize(scenario.incomingSteps);
        const unitRef = `${project_id}:${recording_id}`;

        const localRecording = recOf(recording_id, 'local', localSteps);
        const localProject = projOf(project_id, [localRecording]);
        // The resolved-against incoming version — the version the user resolves
        // against. Its name marker ('incoming') makes its digest distinct from
        // the adopted recording's, so the test can prove the baseline advances to
        // THIS version and not to whatever the user adopted.
        const incomingRecording = recOf(recording_id, 'incoming', incomingSteps);

        const state = createEmptySyncState();
        let staleBaselineRec = null;
        if (seedStaleBaseline) {
          // A stale prior baseline so we can prove adoption OVERWRITES the
          // affected recording's entry to the resolved-against incoming version.
          staleBaselineRec = recOf(recording_id, 'stale', localSteps);
          advanceBaseline(state, project_id, projOf(project_id, [staleBaselineRec]), FIXED_NOW);
        }

        // Adoption must never reach the network — record any fetch call.
        let fetchCalled = false;
        globalThis.fetch = async () => {
          fetchCalled = true;
          return makeResponse(200, null);
        };

        let result;
        let adoptedRecording;
        if (mode === 'accept') {
          // A PENDING Review item; accepting it adopts the incoming change. The
          // adopted recording EQUALS the resolved-against incoming version.
          upsertReview(state, unitRef, incomingRecording, FIXED_NOW);
          result = acceptReview(state, [localProject], unitRef, { now: FIXED_NOW });
          adoptedRecording = incomingRecording;
        } else {
          // A Conflict resolved by MERGING — the user adopts an append-only
          // superset of both histories. The merged recording's name marker
          // ('merged') makes it DISTINCT from the resolved-against incoming
          // version, so the baseline advancing to the incoming version is
          // observably different from advancing to the adopted (merged) state.
          upsertConflict(state, unitRef, localRecording, incomingRecording, FIXED_NOW);
          const merged = recOf(recording_id, 'merged', [...localSteps, ...incomingSteps]);
          result = resolveConflict(state, [localProject], unitRef, merged, { now: FIXED_NOW });
          adoptedRecording = merged;
        }

        // Adoption happened entirely client-side — no push, no pull.
        assert.equal(fetchCalled, false, 'adoption must not perform any sync transport');

        // Adoption succeeded and cleared the deferred item.
        assert.equal(result.ok, true, 'adoption of a pending item must succeed');
        assert.equal(getItem(state, unitRef), null, 'the adopted item is cleared');

        // The adopted recording is present in the returned projects.
        const adoptedProject = findProject(result.projects, project_id);
        assert.ok(adoptedProject, 'the adopted project is present after adoption');
        const recInProjects = findRecording(adoptedProject, recording_id);
        assert.deepStrictEqual(
          recInProjects,
          adoptedRecording,
          'the adopted recording is applied to local data',
        );

        // The baseline advanced PER-UNIT to the RESOLVED-AGAINST INCOMING version,
        // NOT to the adopted state.
        const baseline = getBaseline(state, project_id);
        assert.ok(baseline, 'a baseline exists after adoption');
        assert.equal(
          getRecordingBaselineDigest(baseline, recording_id),
          digestRecording(incomingRecording),
          'baseline must advance per-unit to the resolved-against incoming version',
        );

        if (mode === 'resolve-merge') {
          // The distinguishing guarantee: the baseline is the INCOMING version,
          // never the merged state the user actually adopted.
          assert.notEqual(
            getRecordingBaselineDigest(baseline, recording_id),
            digestRecording(adoptedRecording),
            'baseline must NOT advance to the adopted (merged) state',
          );
        }

        // The stale prior entry, when seeded, was overwritten by the
        // resolved-against incoming version.
        if (seedStaleBaseline) {
          assert.notEqual(
            getRecordingBaselineDigest(baseline, recording_id),
            digestRecording(staleBaselineRec),
            'the stale baseline entry must be overwritten on adoption',
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Part C: declining (outside a cycle) advances NOTHING ───────────

  const arbDecline = fc.record({
    project_id: arbId,
    recording_id: arbId,
    localSteps: fc.array(arbAdoptStep, { maxLength: 3 }),
    incomingSteps: fc.array(arbAdoptStep, { maxLength: 3 }),
    seedStaleBaseline: fc.boolean(),
  });

  it('declining a Review keeps local and advances NO baseline, with no transport', async () => {
    await fc.assert(
      fc.asyncProperty(arbDecline, async (scenario) => {
        const { project_id, recording_id, seedStaleBaseline } = scenario;
        // Normalize generated step arrays to plain prototype (see Part B).
        const localSteps = jsonNormalize(scenario.localSteps);
        const incomingSteps = jsonNormalize(scenario.incomingSteps);
        const unitRef = `${project_id}:${recording_id}`;

        const localProject = projOf(project_id, [recOf(recording_id, 'local', localSteps)]);
        const incomingRecording = recOf(recording_id, 'incoming', incomingSteps);

        const state = createEmptySyncState();
        let staleBaselineProject = null;
        if (seedStaleBaseline) {
          staleBaselineProject = projOf(project_id, [recOf(recording_id, 'stale', localSteps)]);
          advanceBaseline(state, project_id, staleBaselineProject, FIXED_NOW);
        }

        // Declining must never reach the network — record any fetch call.
        let fetchCalled = false;
        globalThis.fetch = async () => {
          fetchCalled = true;
          return makeResponse(200, null);
        };

        upsertReview(state, unitRef, incomingRecording, FIXED_NOW);
        const result = declineReview(state, [localProject], unitRef);

        // Declining is entirely client-side and never pushes.
        assert.equal(fetchCalled, false, 'decline must not perform any sync transport');
        assert.equal(result.ok, true, 'declining a PENDING review must succeed');

        // Local is kept unchanged — the incoming change was not applied.
        const keptProject = findProject(result.projects, project_id);
        assert.deepStrictEqual(keptProject, localProject, 'declining keeps local unchanged');

        // The baseline did NOT advance: absent stays absent; a prior
        // baseline stays exactly where it was.
        const baseline = getBaseline(state, project_id);
        if (seedStaleBaseline) {
          assert.ok(baseline, 'a previously-recorded baseline survives a decline');
          assert.equal(
            baseline.digest,
            digestProject(staleBaselineProject),
            'declining must not advance the recorded baseline',
          );
        } else {
          assert.equal(baseline, null, 'declining must not create a baseline');
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ─────────────────────────────────────

  it('a brand-new local project is pushed but receives no baseline', async () => {
    const ID = '018f0000-0000-7000-8000-000000000001';
    const local = projOf(ID, [recOf('018f0000-0000-7000-8000-0000000000a1', 'base', [])]);
    const putLog = [];
    installMockFetch([], new Map(), putLog); // empty server manifest
    const store = makeStore(createEmptySyncState());

    const { result } = await sync(
      SERVER,
      null,
      [local],
      STUB_SCHEMA,
      () => true,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    assert.ok(
      putLog.includes(`${SERVER}/projects/${encodeURIComponent(ID)}`),
      'the project was pushed',
    );
    assert.equal(getBaseline(store.getState(), ID), null, 'push created no baseline');
  });

  it('an already-converged project repairs a stale baseline to the pull-confirmed agreed state', async () => {
    const ID = '018f0000-0000-7000-8000-000000000002';
    const RID = '018f0000-0000-7000-8000-0000000000b2';
    const agreed = projOf(ID, [recOf(RID, 'agreed', [])]);
    const stale = projOf(ID, [recOf(RID, 'stale', [])], '-stale');

    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, stale, FIXED_NOW);
    assert.notEqual(digestProject(agreed), digestProject(stale));

    const putLog = [];
    installMockFetch(
      [{ project_id: ID, name: agreed.name }],
      new Map([[ID, buildPayload(agreed)]]),
      putLog,
    );
    const store = makeStore(seed);

    await sync(SERVER, null, [agreed], STUB_SCHEMA, () => true, store, makeLiveState());

    const baseline = getBaseline(store.getState(), ID);
    assert.equal(baseline.digest, digestProject(agreed), 'baseline repaired to the agreed state');
    assert.notEqual(baseline.digest, digestProject(stale), 'the stale baseline was overwritten');
  });

  it('a changed-local-outgoing unit is pushed but its baseline is NOT advanced', async () => {
    const ID = '018f0000-0000-7000-8000-000000000004';
    const RID = '018f0000-0000-7000-8000-0000000000d4';
    // Last-agreed baseline == the server's current state; local has moved on.
    const baselineProject = projOf(ID, [recOf(RID, 'base', [])]);
    const local = projOf(ID, [
      recOf(RID, 'local-edit', [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }]),
    ]);

    const seed = createEmptySyncState();
    advanceBaseline(seed, ID, baselineProject, FIXED_NOW);

    const putLog = [];
    installMockFetch(
      [{ project_id: ID, name: baselineProject.name }],
      new Map([[ID, buildPayload(baselineProject)]]), // server still at baseline
      putLog,
    );
    const store = makeStore(seed);

    const { result } = await sync(
      SERVER,
      null,
      [local],
      STUB_SCHEMA,
      () => true,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    // The local edit was pushed automatically ...
    assert.ok(
      putLog.includes(`${SERVER}/projects/${encodeURIComponent(ID)}`),
      'the changed-local-outgoing unit was pushed',
    );
    // ... but the baseline stayed at the prior agreed state.
    const baseline = getBaseline(store.getState(), ID);
    assert.equal(
      baseline.digest,
      digestProject(baselineProject),
      'the baseline is unchanged after a push',
    );
    assert.notEqual(
      baseline.digest,
      digestProject(local),
      'the baseline did not advance to the pushed local state',
    );
    // The unit is a routine push, never a deferral.
    assert.equal(result.review.length, 0, 'changed-local-outgoing is not a Review');
    assert.equal(result.conflicts.length, 0, 'changed-local-outgoing is not a Conflict');
  });

  it('a fast-forward changed-incoming auto-applies and advances the baseline to the incoming version', async () => {
    const ID = '018f0000-0000-7000-8000-000000000005';
    const RID = '018f0000-0000-7000-8000-0000000000e5';
    const baseStep = { uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false };
    const extraStep = { uuid: 'u2', logical_id: 'a', step_number: 1, deleted: false };

    // Last-agreed baseline == local (unchanged locally); incoming appends a step
    // (a true append-only fast-forward).
    const baselineProject = projOf(ID, [recOf(RID, 'ff', [baseStep])]);
    const local = projOf(ID, [recOf(RID, 'ff', [baseStep])]);
    const incomingRec = recOf(RID, 'ff', [baseStep, extraStep]);
    const incoming = projOf(ID, [incomingRec]);

    const seed = createEmptySyncState();
    setSettings(seed, { autoAcceptUpdates: true }); // the auto-accept path requires the toggle ON
    advanceBaseline(seed, ID, baselineProject, FIXED_NOW);

    const putLog = [];
    installMockFetch(
      [{ project_id: ID, name: incoming.name }],
      new Map([[ID, buildPayload(incoming)]]),
      putLog,
    );
    const store = makeStore(seed);

    const { result } = await sync(
      SERVER,
      null,
      [local],
      STUB_SCHEMA,
      () => true,
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    // The fast-forward was auto-applied (not deferred to Review).
    assert.deepStrictEqual(result.autoAppliedUpdates, [`${ID}:${RID}`]);
    assert.equal(result.review.length, 0, 'a fast-forward is auto-applied, not reviewed');

    const baseline = getBaseline(store.getState(), ID);
    // The recording's baseline entry advanced PER-UNIT to the incoming version.
    assert.equal(
      getRecordingBaselineDigest(baseline, RID),
      digestRecording(incomingRec),
      'baseline advanced to the incoming (fast-forward) version',
    );
    assert.notEqual(
      getRecordingBaselineDigest(baseline, RID),
      digestRecording(recOf(RID, 'ff', [baseStep])),
      'baseline no longer holds the pre-fast-forward version',
    );
  });

  it('accepting a review advances the baseline to the incoming (resolved-against) version', () => {
    const ID = '018f0000-0000-7000-8000-000000000003';
    const RID = '018f0000-0000-7000-8000-0000000000c3';
    const local = projOf(ID, [
      recOf(RID, 'local', [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }]),
    ]);
    const incoming = recOf(RID, 'incoming', [
      { uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false },
      { uuid: 'u2', logical_id: 'a', step_number: 0, deleted: false },
    ]);

    const state = createEmptySyncState();
    upsertReview(state, `${ID}:${RID}`, incoming, FIXED_NOW);

    const result = acceptReview(state, [local], `${ID}:${RID}`, { now: FIXED_NOW });

    assert.equal(result.ok, true);
    const baseline = getBaseline(state, ID);
    // For an accept the resolved-against version equals the adopted version, so
    // the recording's baseline entry is the incoming recording.
    assert.equal(getRecordingBaselineDigest(baseline, RID), digestRecording(incoming));
    // The accepted recording in local data equals the incoming version.
    const acceptedRec = findRecording(findProject(result.projects, ID), RID);
    assert.deepStrictEqual(acceptedRec, incoming);
  });

  it('resolving a conflict by merging advances the baseline to the resolved-against incoming version, not the merged state', () => {
    const ID = '018f0000-0000-7000-8000-000000000006';
    const RID = '018f0000-0000-7000-8000-0000000000f6';
    const localStep = { uuid: 'uL', logical_id: 'a', step_number: 0, deleted: false };
    const incomingStep = { uuid: 'uI', logical_id: 'b', step_number: 0, deleted: false };

    const localRec = recOf(RID, 'local', [localStep]);
    const local = projOf(ID, [localRec]);
    const incomingRec = recOf(RID, 'incoming', [incomingStep]);
    // The user adopts an append-only superset of BOTH sides — a genuine merge,
    // distinct from the resolved-against incoming version.
    const merged = recOf(RID, 'merged', [localStep, incomingStep]);

    const state = createEmptySyncState();
    upsertConflict(state, `${ID}:${RID}`, localRec, incomingRec, FIXED_NOW);

    const result = resolveConflict(state, [local], `${ID}:${RID}`, merged, { now: FIXED_NOW });

    assert.equal(result.ok, true);
    // The merged state is what landed in local data ...
    assert.deepStrictEqual(findRecording(findProject(result.projects, ID), RID), merged);

    const baseline = getBaseline(state, ID);
    // ... but the baseline advanced to the RESOLVED-AGAINST INCOMING version,
    // so the merged state reads as changed-local-outgoing next cycle.
    assert.equal(getRecordingBaselineDigest(baseline, RID), digestRecording(incomingRec));
    assert.notEqual(
      getRecordingBaselineDigest(baseline, RID),
      digestRecording(merged),
      'baseline must not advance to the adopted (merged) state',
    );
  });

  it('declining a review does not advance the baseline', () => {
    const ID = '018f0000-0000-7000-8000-000000000007';
    const RID = '018f0000-0000-7000-8000-000000000a07';
    const local = projOf(ID, [recOf(RID, 'local', [])]);
    const incoming = recOf(RID, 'incoming', [
      { uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false },
    ]);

    const state = createEmptySyncState();
    upsertReview(state, `${ID}:${RID}`, incoming, FIXED_NOW);

    const result = declineReview(state, [local], `${ID}:${RID}`);

    assert.equal(result.ok, true);
    // No baseline was created by declining.
    assert.equal(getBaseline(state, ID), null, 'declining advances no baseline');
    // Local is kept unchanged.
    assert.deepStrictEqual(findProject(result.projects, ID), local);
  });
});
