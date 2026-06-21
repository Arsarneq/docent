/**
 * changed-local-outgoing-push.property.test.js — Property test that a
 * `changed-local-outgoing` Unit is AUTO-PUSHED at its local version, that ONLY
 * pushable Units (changed-local-outgoing plus clean/already-converged/resolved)
 * reach the wire as local while a deferred (Review/Conflict) or Locked Unit never
 * does, and that a project with nothing to write is skipped entirely.
 *
 * `changed-local-outgoing` is the routine one-sided local edit: the LOCAL version
 * moved since the last mutually-agreed Sync_Baseline while the incoming (server)
 * version still EQUALS that baseline. It is an AUTOMATIC, non-deferred
 * outcome — never a Review or a Conflict — so its local edit must reach the
 * server on this very cycle, without a prompt and without advancing the baseline
 * (the baseline advances only when a later pull confirms incoming == local).
 *
 * (design): "For any sync cycle, a Unit classified
 * `changed-local-outgoing` has its local version included in the push, and no
 * Unit in an unresolved Conflict or pending Review state has its local version
 * pushed; a project with no pushable, deferred, or locked unit requiring a write
 * is not pushed at all."
 *
 * ── What this property pins (and how it differs from per-unit-push-assembly) ──
 * (`per-unit-push-assembly`) pins the COMPLETENESS of the assembled
 * payload (no recording present on any side is omitted; no clobber). THIS
 * property pins the OUTBOUND-ELIGIBILITY rule and the
 * skip-rule:
 *
 *   - a `changed-local-outgoing` recording's LOCAL edit reaches the wire — the routine outgoing change is pushed automatically;
 *   - the other versions that reach the wire AS LOCAL are exactly the clean ones:
 *     `already-converged` and clean-local-new (and, by the same baseline rule, a
 *     *resolved* unit on the cycle after resolution, which reads as
 *     `changed-local-outgoing` or `already-converged`);
 *   - a DEFERRED unit (an active Review or Conflict) and a LOCKED recording NEVER
 *     push their un-reconciled local edits — they re-send the agreed-or-pulled
 *     (server) version instead, so the local edit provably does NOT reach the
 *     wire for them; and
 *   - a project that is present locally but has NO unit requiring a write — its
 *     project metadata is itself deferred AND every recording is deferred/locked,
 *     so the whole assembled payload would be a pure re-send of the
 *     agreed-or-pulled server state — is SKIPPED rather than re-sent.
 *
 * ── How the invariant is driven ─────────────────────────────────────────────
 * The test drives the REAL `sync()` (pull → reconcile → per-unit push) with a
 * mock `fetch` that serves a manifest + per-project payloads on GET and captures
 * every PUT body in order. Two kinds of project are generated:
 *
 *   - a PUSHABLE project: identical project metadata on both sides (so the
 *     project-metadata Unit is `already-converged` and local-carrying ⇒ the
 *     project always has something to write), carrying at least one
 *     `changed-local-outgoing` recording plus an arbitrary mix of
 *     `already-converged`, clean-local-new, `diverged` (Conflict),
 *     `changed-incoming` (Review, Auto-Accept-Updates OFF), and `locked`
 *     recordings. It MUST be pushed, and each recording's pushed version is
 *     checked against the side the eligibility rule requires;
 *   - a NOTHING-TO-WRITE project: project metadata diverges on both sides (a
 *     project-level Conflict) and every recording diverges too (recording-level
 *     Conflicts), so the entire assembled payload is agreed-or-pulled and the
 *     project is SKIPPED.
 *
 * Version differences are driven by the recording/project `name` (folded into
 * the content digest) so each category settles into its intended
 * classification. The settings are left at the documented defaults
 * (Auto-Accept-Updates / Deletions OFF), so a `changed-incoming` recording always
 * defers to Review and is never auto-applied.
 *
 * `fetch` is mocked exactly as in the sibling sync property tests
 * (`per-unit-push-assembly` / `changed-incoming-review`): `makeResponse`-style
 * Response stubs dispatching per project_id; the validator passes; a persistent
 * in-memory `SyncStore` is seeded with the baselines + settings; a permissive
 * `LiveState` reports the locked set (capture inactive, nothing pending) so the
 * pre-flight gate lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Changed-local-outgoing is auto-pushed and only it (plus clean/resolved) reaches the wire

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { createEmptySyncState, setSettings } from '../../sync-store.js';
import { advanceBaseline } from '../../sync-baseline.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

const SERVER = 'https://srv.test';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

const PROJ_CREATED = '2026-01-01T00:00:00.000Z';
const REC_CREATED = '2026-02-01T00:00:00.000Z';

// ─── fetch double (mirrors per-unit-push-assembly / changed-incoming-review) ──

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
 * by project_id and records every call:
 *   - PUT (push)        → 200 (the push phase always succeeds), body captured.
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload.
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

/** The PUT bodies captured during a push, in push order, with their target URL. */
function capturedPuts() {
  return fetchCalls
    .filter((c) => c.options && c.options.method === 'PUT')
    .map((c) => ({ url: c.url, body: JSON.parse(c.options.body) }));
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore} seeded with an initial SyncState. Clones on the way
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

/**
 * A {@link LiveState}: capture inactive (so a cycle runs), `getLockedRecordingIds`
 * returns the generated locked set, and nothing is pending (so the pending-actions
 * assertion never fires). These are the only signals the pre-flight gate reads.
 *
 * @param {string[]} locked - recording_ids open in the Recording_View
 */
function makeLiveState(locked) {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(locked),
    recordingsWithPendingActions: () => new Set(),
  };
}

/** A validator that accepts every payload (the push eligibility is the focus). */
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

/** Build a plain recording literal at a given version name + steps. */
function rec(recording_id, name, steps) {
  return { recording_id, name, created_at: REC_CREATED, steps };
}

/** Stable JSON identity for a recording projection (prototype-agnostic). */
function projKey(recording) {
  return JSON.stringify(recordingProjection(recording));
}

// ─── generators ──────────────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 20 }),
  deleted: fc.boolean(),
});

/**
 * Outcomes for a recording in a PUSHABLE project. Each maps to a (baseline,
 * local, server) version triple in {@link versionsFor}; steps are shared across
 * versions so only the recording `name` drives the intended classification.
 *   - `changed-local-outgoing` — the property's headline case (push local).
 *   - `already-converged`      — clean: local == server == baseline (push local).
 *   - `clean-local-new`        — local-only new work (push local).
 *   - `diverged`               — Conflict (deferred): NEVER push local edits.
 *   - `changed-incoming`       — Review (deferred, toggle OFF): NEVER push local.
 *   - `locked`                 — excluded from the merge: NEVER push local edits.
 */
const arbPushableRecordingSpec = fc.record({
  recording_id: fc.uuid(),
  steps: fc.array(arbStep, { maxLength: 3 }),
  outcome: fc.constantFrom(
    'changed-local-outgoing',
    'already-converged',
    'clean-local-new',
    'diverged',
    'changed-incoming',
    'locked',
  ),
});

/**
 * A pushable project: a MANDATORY `changed-local-outgoing` recording (so the
 * property always exercises the headline auto-push case) plus 0..4 extra
 * recordings of any pushable outcome.
 */
const arbPushableProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  headline: fc.record({ recording_id: fc.uuid(), steps: fc.array(arbStep, { maxLength: 3 }) }),
  extras: fc.uniqueArray(arbPushableRecordingSpec, {
    selector: (r) => r.recording_id,
    minLength: 0,
    maxLength: 4,
  }),
});

/**
 * A NOTHING-TO-WRITE project: its project metadata diverges on both sides AND
 * every recording diverges, so the whole assembled payload is a pure
 * agreed-or-pulled re-send (`writeNeeded === false`) and the project is skipped.
 * 1..2 diverged recordings.
 */
const arbNothingProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recordings: fc.uniqueArray(
    fc.record({ recording_id: fc.uuid(), steps: fc.array(arbStep, { maxLength: 3 }) }),
    { selector: (r) => r.recording_id, minLength: 1, maxLength: 2 },
  ),
});

const arbScenario = fc.record({
  pushable: fc.uniqueArray(arbPushableProjectSpec, {
    selector: (p) => p.project_id,
    minLength: 1,
    maxLength: 3,
  }),
  nothing: fc.uniqueArray(arbNothingProjectSpec, {
    selector: (p) => p.project_id,
    minLength: 0,
    maxLength: 2,
  }),
});

/**
 * The (baseline, local, server) version triple for a pushable recording outcome,
 * plus which side the push assembly must send:
 *   - `expect: 'local'`  — push the local version (changed-local-outgoing,
 *                          already-converged, clean-local-new).
 *   - `expect: 'server'` — re-send the agreed-or-pulled (server) version
 *                          (deferred Review/Conflict, or locked).
 *   - `locked: true`     — recording is open in the Recording_View this cycle.
 *
 * @param {string} outcome
 * @param {string} rid
 * @param {object[]} steps
 */
function versionsFor(outcome, rid, steps) {
  switch (outcome) {
    case 'changed-local-outgoing':
      // local moved, server still at the agreed baseline → push the LOCAL edit.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'clo-local', steps),
        server: rec(rid, 'base', steps),
        expect: 'local',
      };
    case 'already-converged':
      // local == server == baseline → push local (identical to both).
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'base', steps),
        server: rec(rid, 'base', steps),
        expect: 'local',
      };
    case 'clean-local-new':
      // local-only new work (no baseline, absent on server) → push the LOCAL version.
      return { baseline: null, local: rec(rid, 'new-local', steps), server: null, expect: 'local' };
    case 'diverged':
      // both sides moved from the baseline → Conflict (deferred); push the
      // AGREED-OR-PULLED (server) version, NEVER the divergent local edits.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'div-local', steps),
        server: rec(rid, 'div-server', steps),
        expect: 'server',
        deferred: 'conflict',
      };
    case 'changed-incoming':
      // server moved, local unchanged, Auto-Accept-Updates OFF → Review (deferred);
      // re-send the agreed-or-pulled (server) version, never the local copy.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'base', steps),
        server: rec(rid, 'ci-server', steps),
        expect: 'server',
        deferred: 'review',
      };
    case 'locked':
      // open in the Recording_View → excluded from the inbound merge but present
      // in the push at its agreed-or-pulled (server) version, never local edits.
      return {
        baseline: rec(rid, 'base', steps),
        local: rec(rid, 'lock-local', steps),
        server: rec(rid, 'lock-server', steps),
        expect: 'server',
        locked: true,
      };
    default:
      throw new Error(`unknown outcome ${outcome}`);
  }
}

/**
 * Materialize a scenario into `sync()` inputs plus per-project expectations.
 *
 * Pushable projects keep IDENTICAL project metadata across local/server/baseline
 * (so the project-metadata Unit is always converged and local-carrying ⇒ the
 * project always has something to write). Nothing-to-write projects make the
 * project metadata AND every recording diverge, so the whole assembled payload is
 * agreed-or-pulled and the project is skipped.
 */
function materialize(scenario) {
  const seed = createEmptySyncState();
  // Settings explicit at the documented defaults: a changed-incoming always
  // defers to Review and is never auto-applied; no deletions are generated.
  setSettings(seed, { autoAcceptUpdates: false, autoAcceptDeletions: false });

  const localProjects = [];
  const payloadById = new Map();
  const manifest = [];
  const locked = [];
  const usedProjectIds = new Set();

  // pid → Map(recording_id → { outcome, expectKind, expectedKey, localKey, deferredOrLocked }).
  const pushableExpect = new Map();
  const pushableIds = new Set();
  const nothingIds = new Set();
  // unitRefs the cycle MUST report as Review / Conflict (deferral sanity check).
  const expectedReview = new Set();
  const expectedConflicts = new Set();

  for (const pspec of scenario.pushable) {
    const pid = pspec.project_id;
    if (usedProjectIds.has(pid)) continue;
    usedProjectIds.add(pid);
    pushableIds.add(pid);
    const pname = `Project ${pid.slice(0, 8)}`;

    const baselineRecs = [];
    const localRecs = [];
    const serverRecs = [];
    const recExpect = new Map();

    // The mandatory headline changed-local-outgoing recording.
    const headlineSpecs = [
      {
        recording_id: pspec.headline.recording_id,
        steps: pspec.headline.steps,
        outcome: 'changed-local-outgoing',
      },
      ...pspec.extras.filter((e) => e.recording_id !== pspec.headline.recording_id),
    ];

    for (const rspec of headlineSpecs) {
      const rid = rspec.recording_id;
      const v = versionsFor(rspec.outcome, rid, rspec.steps);

      if (v.baseline) baselineRecs.push(v.baseline);
      if (v.local) localRecs.push(v.local);
      if (v.server) serverRecs.push(v.server);
      if (v.locked) locked.push(rid);

      const unitRef = `${pid}:${rid}`;
      if (v.deferred === 'review') expectedReview.add(unitRef);
      if (v.deferred === 'conflict') expectedConflicts.add(unitRef);

      const expectedSource = v.expect === 'server' ? v.server : v.local;
      recExpect.set(rid, {
        outcome: rspec.outcome,
        expectKind: v.expect,
        expectedKey: projKey(expectedSource),
        // The local version's key — used to prove a deferred/locked recording is
        // NOT pushed at its un-reconciled local edits.
        localKey: v.local ? projKey(v.local) : null,
        deferredOrLocked: v.expect === 'server',
      });
    }

    // Baseline: the last-agreed project, holding the agreed version of every
    // recording that has one. Project metadata matches local/server exactly, so
    // the metadata Unit converges and stays local-carrying.
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: pname,
        created_at: PROJ_CREATED,
        recordings: baselineRecs,
      }),
    );

    localProjects.push({
      project_id: pid,
      name: pname,
      created_at: PROJ_CREATED,
      recordings: localRecs,
    });
    payloadById.set(
      pid,
      buildPayload({
        project_id: pid,
        name: pname,
        created_at: PROJ_CREATED,
        recordings: serverRecs,
      }),
    );
    manifest.push({ project_id: pid, name: pname });

    pushableExpect.set(pid, recExpect);
  }

  for (const pspec of scenario.nothing) {
    const pid = pspec.project_id;
    if (usedProjectIds.has(pid)) continue;
    usedProjectIds.add(pid);
    nothingIds.add(pid);
    const short = pid.slice(0, 8);

    const baselineRecs = [];
    const localRecs = [];
    const serverRecs = [];
    for (const r of pspec.recordings) {
      // Every recording diverges → a recording-level Conflict (deferred).
      baselineRecs.push(rec(r.recording_id, 'base', r.steps));
      localRecs.push(rec(r.recording_id, 'div-local', r.steps));
      serverRecs.push(rec(r.recording_id, 'div-server', r.steps));
      expectedConflicts.add(`${pid}:${r.recording_id}`);
    }

    // Project metadata diverges too (all three names distinct) → a project-level
    // Conflict, so the project-metadata Unit is deferred and re-sends the
    // agreed-or-pulled metadata. With every recording also deferred, the whole
    // assembled payload is agreed-or-pulled ⇒ writeNeeded === false ⇒ skipped.
    expectedConflicts.add(pid);
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: `nothing ${short}-base`,
        created_at: PROJ_CREATED,
        recordings: baselineRecs,
      }),
    );
    localProjects.push({
      project_id: pid,
      name: `nothing ${short}-local`,
      created_at: PROJ_CREATED,
      recordings: localRecs,
    });
    payloadById.set(
      pid,
      buildPayload({
        project_id: pid,
        name: `nothing ${short}-server`,
        created_at: PROJ_CREATED,
        recordings: serverRecs,
      }),
    );
    manifest.push({ project_id: pid, name: `nothing ${short}-server` });
  }

  return {
    seed,
    localProjects,
    payloadById,
    manifest,
    locked,
    pushableExpect,
    pushableIds,
    nothingIds,
    expectedReview,
    expectedConflicts,
  };
}

describe('Changed-local-outgoing is auto-pushed and only it (plus clean/resolved) reaches the wire', () => {
  it('pushes changed-local-outgoing (and clean) units at the local version, never pushes a deferred/locked unit at its local edits, and skips a nothing-to-write project', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const {
          seed,
          localProjects,
          payloadById,
          manifest,
          locked,
          pushableExpect,
          pushableIds,
          nothingIds,
          expectedReview,
          expectedConflicts,
        } = materialize(scenario);
        installMockFetch(manifest, payloadById);
        const store = makeStore(seed);

        const { result } = await sync(
          SERVER,
          null,
          localProjects,
          STUB_SCHEMA,
          passValidator,
          store,
          makeLiveState(locked),
        );

        // The cycle ran to completion (no live-work gate, no abort).
        assert.equal(result.halted, false);
        assert.equal(result.haltReason, null);

        const puts = capturedPuts();
        const putByProjectId = new Map();
        for (const put of puts) {
          assert.ok(Array.isArray(put.body.recordings), 'payload has a recordings array');
          putByProjectId.set(put.body.project.project_id, put.body);
        }

        // ── exactly the pushable projects reach the wire; every
        //    nothing-to-write project is skipped. ──
        const pushedIds = new Set(putByProjectId.keys());
        assert.deepEqual(
          pushedIds,
          pushableIds,
          'exactly the pushable projects are pushed (nothing-to-write projects skipped)',
        );
        assert.equal(puts.length, pushableIds.size, 'exactly one PUT per pushable project');
        for (const nid of nothingIds) {
          assert.ok(!pushedIds.has(nid), `nothing-to-write project ${nid} is not pushed`);
        }

        // ── Deferral sanity: the units we expect deferred ARE reported as
        //    Review / Conflict, so the "never push a deferred unit's local
        //    edits" assertion below is exercised against truly-deferred units. ──
        assert.deepEqual(
          new Set(result.review),
          expectedReview,
          'result.review is exactly the changed-incoming unitRefs',
        );
        assert.deepEqual(
          new Set(result.conflicts),
          expectedConflicts,
          'result.conflicts is exactly the diverged unitRefs (recording- and project-level)',
        );
        assert.deepEqual(
          result.autoAppliedUpdates,
          [],
          'no changed-incoming is auto-applied (Auto-Accept-Updates OFF)',
        );

        // ── Per-pushable-project: each recording reaches the wire at the side
        //    the eligibility rule requires; a deferred/locked unit never pushes local. ──
        for (const [pid, recExpect] of pushableExpect) {
          const body = putByProjectId.get(pid);
          assert.ok(body, `pushable project ${pid} was pushed`);
          const pushedById = new Map(body.recordings.map((r) => [r.recording_id, r]));

          for (const [rid, exp] of recExpect) {
            const pushed = pushedById.get(rid);
            assert.ok(pushed, `recording ${rid} (${exp.outcome}) is present in the push`);
            const pushedKey = projKey(pushed);

            // The pushed version is exactly the expected source: LOCAL for
            // changed-local-outgoing / already-converged / clean-local-new;
            // agreed-or-pulled (server) for a deferred (Review/Conflict) or
            // locked recording.
            assert.equal(
              pushedKey,
              exp.expectedKey,
              `recording ${rid} (${exp.outcome}) pushed at the ${exp.expectKind} version`,
            );

            // The teeth of the rule: a deferred or locked unit NEVER
            // pushes its un-reconciled local edits over the server's copy.
            if (exp.deferredOrLocked && exp.localKey !== null) {
              assert.notEqual(
                pushedKey,
                exp.localKey,
                `deferred/locked recording ${rid} (${exp.outcome}) must NOT push its local edits`,
              );
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ────────────────────────────────────

  it('a changed-local-outgoing recording is auto-pushed at the local version', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000101';
    const rid = 'rec-clo';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'base', steps)],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(rid, 'edited', steps)],
      },
    ];
    const manifest = [{ project_id: pid, name: 'P' }];
    const payloadById = new Map([
      [
        pid,
        buildPayload({
          project_id: pid,
          name: 'P',
          created_at: PROJ_CREATED,
          recordings: [rec(rid, 'base', steps)], // server still at the agreed baseline
        }),
      ],
    ]);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([]),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, [], 'a one-sided local change is never a Conflict');
    assert.deepEqual(result.review, [], 'a one-sided local change is never a Review');

    const puts = capturedPuts();
    assert.equal(puts.length, 1, 'the project is pushed (it has a local edit to write)');
    const pushed = puts[0].body.recordings.find((r) => r.recording_id === rid);
    assert.equal(pushed.name, 'edited', 'the local edit reaches the wire');
  });

  it('in one project, the changed-local-outgoing sibling pushes local while the Conflict sibling re-sends the server version', async () => {
    const pid = '018f4e2a-0000-7000-8000-000000000102';
    const clo = 'rec-clo';
    const div = 'rec-div';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    advanceBaseline(
      seed,
      pid,
      projectProjection({
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(clo, 'base', steps), rec(div, 'base', steps)],
      }),
    );

    const localProjects = [
      {
        project_id: pid,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(clo, 'clo-local', steps), rec(div, 'div-local', steps)],
      },
    ];
    const manifest = [{ project_id: pid, name: 'P' }];
    const payloadById = new Map([
      [
        pid,
        buildPayload({
          project_id: pid,
          name: 'P',
          created_at: PROJ_CREATED,
          recordings: [rec(clo, 'base', steps), rec(div, 'div-server', steps)],
        }),
      ],
    ]);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([]),
    );

    assert.equal(result.halted, false);
    assert.deepEqual(
      result.conflicts,
      [`${pid}:${div}`],
      'only the diverged sibling is a Conflict',
    );
    assert.deepEqual(result.review, []);

    const puts = capturedPuts();
    assert.equal(puts.length, 1);
    const pushedClo = puts[0].body.recordings.find((r) => r.recording_id === clo);
    const pushedDiv = puts[0].body.recordings.find((r) => r.recording_id === div);
    assert.equal(pushedClo.name, 'clo-local', 'the changed-local-outgoing edit reaches the wire');
    assert.equal(pushedDiv.name, 'div-server', 'the Conflict sibling re-sends the server version');
    assert.notEqual(
      pushedDiv.name,
      'div-local',
      'the Conflict sibling never pushes its local edits',
    );
  });

  it('a project whose metadata and every recording diverge is skipped, while a pushable project alongside it is pushed', async () => {
    const skip = '018f4e2a-0000-7000-8000-000000000201';
    const push = '018f4e2a-0000-7000-8000-000000000202';
    const skipRec = 'rec-skip';
    const pushRec = 'rec-push';
    const steps = [{ uuid: 's1', logical_id: 'a', step_number: 0, deleted: false }];

    const seed = createEmptySyncState();
    // Nothing-to-write project: metadata + recording both diverge.
    advanceBaseline(
      seed,
      skip,
      projectProjection({
        project_id: skip,
        name: 'skip-base',
        created_at: PROJ_CREATED,
        recordings: [rec(skipRec, 'base', steps)],
      }),
    );
    // Pushable project: converged metadata, one changed-local-outgoing recording.
    advanceBaseline(
      seed,
      push,
      projectProjection({
        project_id: push,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(pushRec, 'base', steps)],
      }),
    );

    const localProjects = [
      {
        project_id: skip,
        name: 'skip-local',
        created_at: PROJ_CREATED,
        recordings: [rec(skipRec, 'div-local', steps)],
      },
      {
        project_id: push,
        name: 'P',
        created_at: PROJ_CREATED,
        recordings: [rec(pushRec, 'edited', steps)],
      },
    ];
    const manifest = [
      { project_id: skip, name: 'skip-server' },
      { project_id: push, name: 'P' },
    ];
    const payloadById = new Map([
      [
        skip,
        buildPayload({
          project_id: skip,
          name: 'skip-server',
          created_at: PROJ_CREATED,
          recordings: [rec(skipRec, 'div-server', steps)],
        }),
      ],
      [
        push,
        buildPayload({
          project_id: push,
          name: 'P',
          created_at: PROJ_CREATED,
          recordings: [rec(pushRec, 'base', steps)],
        }),
      ],
    ]);
    installMockFetch(manifest, payloadById);

    const { result } = await sync(
      SERVER,
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
      makeStore(seed),
      makeLiveState([]),
    );

    assert.equal(result.halted, false);

    const puts = capturedPuts();
    const pushedIds = new Set(puts.map((p) => p.body.project.project_id));
    assert.deepEqual(
      pushedIds,
      new Set([push]),
      'only the pushable project is pushed; the all-deferred project is skipped',
    );
    const pushed = puts.find((p) => p.body.project.project_id === push);
    assert.equal(
      pushed.body.recordings.find((r) => r.recording_id === pushRec).name,
      'edited',
      'the pushable project sends its local edit',
    );
  });
});
