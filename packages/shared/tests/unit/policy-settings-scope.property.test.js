/**
 * policy-settings-scope.property.test.js — Property test that the two
 * reconciliation-policy settings (Auto-Accept-Updates / Auto-Accept-Deletions)
 * affect ONLY the local-unchanged cases and NEVER auto-resolve a divergence,
 * driving the full `sync()` orchestrator across all four settings combinations.
 *
 * The reconciliation-policy settings are a POLICY preference layered on top of a
 * settings-INDEPENDENT classifier: the Conflict_Detector classifies every
 * Unit the same way regardless of the toggles, and the orchestrator then decides
 * what an AUTOMATIC outcome may do for the two — and only the two — LOCAL-UNCHANGED
 * cases:
 *
 *   - `changed-incoming` (local == baseline, the server moved): auto-applied as a
 *     fast-forward update IFF Auto-Accept-Updates is ON (and the incoming version
 *     is an append-only superset of the baseline), otherwise held for Review;
 * and
 *   - `deleted-remote-review` (local == baseline, the server deleted it):
 *     auto-applied as a deletion IFF Auto-Accept-Deletions is ON, otherwise held
 *     for Review.
 *
 * The settings NEVER touch a BOTH-SIDES-CHANGED case. A `diverged` Unit (both
 * sides moved from a common baseline) and a `conflict-delete-vs-change` Unit
 * (deleted on one side, changed on the other) remain user-gated Conflicts in
 * ALL FOUR settings combinations — neither toggle, in any combination, ever
 * auto-applies, auto-resolves, or even reviews them. This is what
 * preserves no-silent-loss of authored work regardless of how aggressively a user
 * has opted into automation.
 *
 * The property drives the FULL `sync()` orchestrator (not the detector in
 * isolation). For every generated scenario it materializes one fixed set of
 * inputs — local projects, a server view, and seeded per-project baselines — and
 * runs the cycle FOUR times, once per (Auto-Accept-Updates, Auto-Accept-Deletions)
 * combination, over independent fresh stores. Each generated project carries one
 * of each Unit kind so all four interact in a single cycle:
 *
 *   - a `changed-incoming` fast-forward recording (local == baseline; the server
 *     appended a committed step → an append-only superset);
 *   - a `deleted-remote-review` recording (local == baseline; absent on the server);
 *   - a `diverged` recording (local, incoming, and baseline all distinct); and
 *   - a `conflict-delete-vs-change` recording (changed locally; absent on the
 *     server → server-deleted/local-changed);
 *   - optionally a converged sibling (identical on every side), which must stay
 *     byte-identical and never be reviewed, conflicted, or auto-applied under any
 *     setting.
 *
 * For each combination the property pins the EXACT outcome sets:
 *   - `result.autoAppliedUpdates` = the changed-incoming refs IFF updates ON, else ∅;
 *   - `result.autoAppliedDeletions` = the deletion refs IFF deletions ON, else ∅;
 *   - `result.review` = the changed-incoming refs (when updates OFF) ∪ the deletion
 *     refs (when deletions OFF) — the settings flip these local-unchanged Units
 *     between auto-applied and Review; and
 *   - `result.conflicts` = the diverged refs ∪ the delete-vs-change refs, IDENTICAL
 *     across all four combinations.
 *
 * It then proves the central claim directly: the Conflict outcome for the
 * both-sides-changed Units — the reported conflict set, each Conflict record's
 * retained local/incoming versions, and the byte-identical merged local data — is
 * deep-equal across ALL FOUR settings combinations. The toggles move only the
 * local-unchanged Units; the divergence outcome is invariant.
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` / the sibling orchestrator
 * property tests (`makeResponse`-style Response stubs dispatched per project_id;
 * PUT → 200). The validator passes, an in-memory `SyncStore` (seeded with the
 * agreed baselines plus the chosen reconciliation-policy settings) captures the
 * saved `SyncState`, and a permissive `LiveState` (capture inactive, nothing
 * locked, nothing pending) lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project ids that pass the manifest's
 * UUIDv7 guard; `fc.uuid()` supplies recording ids).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Reconciliation-policy settings only affect local-unchanged cases and never auto-resolve divergence

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

// The four (Auto-Accept-Updates, Auto-Accept-Deletions) combinations the property
// runs every scenario through.
const COMBINATIONS = [
  { autoAcceptUpdates: false, autoAcceptDeletions: false },
  { autoAcceptUpdates: true, autoAcceptDeletions: false },
  { autoAcceptUpdates: false, autoAcceptDeletions: true },
  { autoAcceptUpdates: true, autoAcceptDeletions: true },
];

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
 * Installs a mock `fetch` that serves a manifest plus per-project payloads keyed
 * by project_id:
 *   - PUT (push)        → 200 (the push phase always succeeds).
 *   - GET /projects     → the manifest array.
 *   - GET /projects/:id → the project's Full_Project_Payload.
 *
 * A recording absent on the server side is simply not in its project's payload,
 * so the pull reconstructs the project without it (incoming === null for it).
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
 * In-memory {@link SyncStore} seeded with an initial SyncState; captures the last
 * saved state so the test can inspect reviews/conflicts/baselines after the cycle.
 * Clones on the way in and out so no reference is shared with the cycle.
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

/** A validator that accepts every payload (policy scope, not validation, is the focus). */
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
 * JSON-normalize a recording spec into the allowlisted shape with plain-object
 * (not null-prototype) step records. In production every recording crosses JSON
 * on the wire and in the store, so this matches the real data path and keeps the
 * deep-equality comparisons aligned with the values the store/baseline/pull-path
 * produce.
 */
function cleanRecording({ recording_id, name, created_at, steps }) {
  return JSON.parse(JSON.stringify({ recording_id, name, created_at, steps }));
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

/** Deep, JSON-normalized copy — matches the deep clone the store/baseline apply. */
function cleanCopy(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbIso = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

/**
 * A committed step record built deterministically from a prefix + integer key.
 * The two prefixes keep uuid namespaces disjoint: `b-*` are the baseline/local
 * step records, `x-*` are the incoming-only appended records. So an append-only
 * fast-forward can REUSE the baseline keys (retaining every `b-*` uuid) and add
 * `x-*` records that are provably disjoint from the baseline.
 *
 * @param {'b'|'x'} prefix
 * @param {number} key
 */
function stepFromKey(prefix, key) {
  return {
    uuid: `${prefix}-${key}`,
    logical_id: ['a', 'b', 'c'][key % 3],
    step_number: key,
    deleted: false,
  };
}

/**
 * One project spec. Five distinct recording ids place exactly one of each Unit
 * kind (plus an optional converged sibling). `ciBaseKeys`/`ciExtraKeys` shape the
 * changed-incoming fast-forward (incoming = base records + appended `x-*`
 * records). The remaining `*Keys` are plain step histories for the other Units;
 * names carry per-side markers so the digest (which folds name into identity) distinguishes the versions.
 */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  created_at: arbIso,
  // 5 unique recording ids: [ci, del, div, dvc, sib].
  recIds: fc.uniqueArray(fc.uuid(), { minLength: 5, maxLength: 5 }),
  ciBaseKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 3 }),
  ciExtraKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 3 }),
  delKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
  divKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
  dvcKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
  sibKeys: fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 3 }),
  withSibling: fc.boolean(),
});

/** A scenario: 1..3 projects with unique ids. */
const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 3,
});

/**
 * Materialize a scenario into the FIXED inputs `sync()` needs (independent of the
 * settings combination) plus the per-project expectations. The baselines are
 * seeded WITHOUT settings; each combination clones this seed and stamps its own
 * settings, so the only difference across the four runs is the policy toggles.
 */
function materialize(specs) {
  const baselineSeed = createEmptySyncState();
  const manifest = [];
  const payloadById = new Map();
  const localProjects = [];
  const expectations = [];

  for (const s of specs) {
    const [ciId, delId, divId, dvcId, sibId] = s.recIds;
    const ca = s.created_at;

    const ciBaseSteps = s.ciBaseKeys.map((k) => stepFromKey('b', k));
    const ciExtraSteps = s.ciExtraKeys.map((k) => stepFromKey('x', k));

    // ── changed-incoming fast-forward (LOCAL-UNCHANGED) ──
    // local == baseline (name 'ci', base steps); incoming retains every baseline
    // step record and appends `x-*` records → an append-only superset.
    const ciLocal = cleanRecording({
      recording_id: ciId,
      name: 'ci',
      created_at: ca,
      steps: ciBaseSteps,
    });
    const ciIncoming = cleanRecording({
      recording_id: ciId,
      name: 'ci',
      created_at: ca,
      steps: [...ciBaseSteps, ...ciExtraSteps],
    });

    // ── deleted-remote-review (LOCAL-UNCHANGED) ──
    // local == baseline (name 'del'); absent on the server (incoming === null).
    const delLocal = cleanRecording({
      recording_id: delId,
      name: 'del',
      created_at: ca,
      steps: s.delKeys.map((k) => stepFromKey('b', k)),
    });

    // ── diverged (BOTH SIDES CHANGED) ──
    // base/local/incoming all distinct (distinct name markers, shared steps).
    const divSteps = s.divKeys.map((k) => stepFromKey('b', k));
    const divBase = cleanRecording({
      recording_id: divId,
      name: 'div-base',
      created_at: ca,
      steps: divSteps,
    });
    const divLocal = cleanRecording({
      recording_id: divId,
      name: 'div-loc',
      created_at: ca,
      steps: divSteps,
    });
    const divIncoming = cleanRecording({
      recording_id: divId,
      name: 'div-srv',
      created_at: ca,
      steps: divSteps,
    });

    // ── conflict-delete-vs-change (server-deleted / local-changed) ──
    // changed locally (name 'dvc-loc' ≠ baseline 'dvc-base'); absent on the server.
    const dvcSteps = s.dvcKeys.map((k) => stepFromKey('b', k));
    const dvcBase = cleanRecording({
      recording_id: dvcId,
      name: 'dvc-base',
      created_at: ca,
      steps: dvcSteps,
    });
    const dvcLocal = cleanRecording({
      recording_id: dvcId,
      name: 'dvc-loc',
      created_at: ca,
      steps: dvcSteps,
    });

    // ── optional converged sibling (identical on every side) ──
    const sibling = s.withSibling
      ? cleanRecording({
          recording_id: sibId,
          name: 'sib',
          created_at: ca,
          steps: s.sibKeys.map((k) => stepFromKey('b', k)),
        })
      : null;

    // Local project: present recordings (ci, del, div, dvc, [sib]).
    const localRecs = [ciLocal, delLocal, divLocal, dvcLocal, ...(sibling ? [sibling] : [])];
    // Server project: ci (moved), div (moved), [sib]. del + dvc are server-deleted.
    const serverRecs = [ciIncoming, divIncoming, ...(sibling ? [cleanRecording(sibling)] : [])];
    // Baseline (last-agreed): ci==local, del==local, div-base, dvc-base, [sib].
    const baselineRecs = [
      cleanRecording(ciLocal),
      cleanRecording(delLocal),
      divBase,
      dvcBase,
      ...(sibling ? [cleanRecording(sibling)] : []),
    ];

    // Project metadata is identical across all three sides (converged), so the
    // only Units are the recordings.
    const projName = 'Project';
    const localProject = cleanProject(s.project_id, projName, ca, localRecs);
    const serverProject = cleanProject(s.project_id, projName, ca, serverRecs);
    const agreedProject = cleanProject(s.project_id, projName, ca, baselineRecs);

    advanceBaseline(baselineSeed, s.project_id, projectProjection(agreedProject));
    localProjects.push(localProject);
    manifest.push({ project_id: s.project_id, name: projName });
    payloadById.set(s.project_id, buildPayload(serverProject));

    expectations.push({
      project_id: s.project_id,
      ci: {
        recording_id: ciId,
        unitRef: `${s.project_id}:${ciId}`,
        local: cleanCopy(recordingProjection(ciLocal)),
        incoming: cleanCopy(recordingProjection(ciIncoming)),
      },
      del: {
        recording_id: delId,
        unitRef: `${s.project_id}:${delId}`,
        local: cleanCopy(recordingProjection(delLocal)),
      },
      div: {
        recording_id: divId,
        unitRef: `${s.project_id}:${divId}`,
        local: cleanCopy(recordingProjection(divLocal)),
        incoming: cleanCopy(recordingProjection(divIncoming)),
      },
      dvc: {
        recording_id: dvcId,
        unitRef: `${s.project_id}:${dvcId}`,
        local: cleanCopy(recordingProjection(dvcLocal)),
      },
      sib: sibling
        ? {
            recording_id: sibId,
            unitRef: `${s.project_id}:${sibId}`,
            local: cleanCopy(recordingProjection(sibling)),
          }
        : null,
    });
  }

  return { baselineSeed, manifest, payloadById, localProjects, expectations };
}

/**
 * Run one full `sync()` cycle for a single settings combination over a fresh
 * store seeded from `baselineSeed` (cloned and stamped with `combo`). Returns the
 * cycle `result`, the merged `projects`, and the saved `state`.
 */
async function runCombo(combo, baselineSeed, localProjects) {
  const seed = structuredClone(baselineSeed);
  setSettings(seed, combo);
  const store = makeStore(seed);
  const { result, projects } = await sync(
    SERVER,
    null,
    structuredClone(localProjects),
    STUB_SCHEMA,
    passValidator,
    store,
    makeLiveState(),
  );
  return { result, projects, state: store.getState() };
}

/** Sorted shallow copy of an array of strings. */
function sorted(arr) {
  return [...arr].sort();
}

/**
 * The settings-INVARIANT Conflict outcome for the both-sides-changed Units: the
 * sorted conflict-ref set, each Conflict's retained local/incoming versions, and
 * the byte-identical merged local recordings. This projection must be deep-equal
 * across all four settings combinations.
 */
function conflictOutcome(result, state, projects, expectations) {
  const mergedRecById = new Map();
  for (const p of projects) {
    for (const r of p.recordings) mergedRecById.set(`${p.project_id}:${r.recording_id}`, r);
  }
  const records = {};
  const merged = {};
  for (const e of expectations) {
    for (const ref of [e.div.unitRef, e.dvc.unitRef]) {
      const c = state.conflicts?.[ref];
      records[ref] = c
        ? { kind: c.kind, recording_id: c.recording_id, local: c.local, incoming: c.incoming }
        : null;
      merged[ref] = cleanCopy(
        mergedRecById.get(ref) ? recordingProjection(mergedRecById.get(ref)) : null,
      );
    }
  }
  return { conflicts: sorted(result.conflicts), records, merged };
}

describe('Reconciliation-policy settings only affect local-unchanged cases and never auto-resolve divergence', () => {
  it('flips only changed-incoming/deleted-remote-review between auto-apply and Review; diverged & delete-vs-change stay identical Conflicts in all four combinations', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (specs) => {
        const { baselineSeed, manifest, payloadById, localProjects, expectations } =
          materialize(specs);
        installMockFetch(manifest, payloadById);

        // The settings-invariant expected sets.
        const allCiRefs = expectations.map((e) => e.ci.unitRef);
        const allDelRefs = expectations.map((e) => e.del.unitRef);
        const expectedConflictRefs = sorted(
          expectations.flatMap((e) => [e.div.unitRef, e.dvc.unitRef]),
        );

        // Capture the Conflict outcome of each combination to compare for equality.
        const conflictOutcomes = [];

        for (const combo of COMBINATIONS) {
          const { result, projects, state } = await runCombo(combo, baselineSeed, localProjects);

          // The cycle always runs to completion — policy is never a halt.
          assert.equal(result.halted, false, 'a policy-gated cycle never halts');
          assert.equal(result.haltReason, null);

          const byId = new Map(projects.map((p) => [p.project_id, p]));

          // ── EXACT outcome sets per combination ──
          assert.deepEqual(
            sorted(result.autoAppliedUpdates),
            combo.autoAcceptUpdates ? sorted(allCiRefs) : [],
            'changed-incoming fast-forwards are auto-applied iff Auto-Accept-Updates is ON',
          );
          assert.deepEqual(
            sorted(result.autoAppliedDeletions),
            combo.autoAcceptDeletions ? sorted(allDelRefs) : [],
            'deleted-remote-review Units are auto-applied iff Auto-Accept-Deletions is ON',
          );
          // The review set is exactly the local-unchanged Units whose toggle is OFF.
          const expectedReview = sorted([
            ...(combo.autoAcceptUpdates ? [] : allCiRefs),
            ...(combo.autoAcceptDeletions ? [] : allDelRefs),
          ]);
          assert.deepEqual(
            sorted(result.review),
            expectedReview,
            'Review holds exactly the local-unchanged Units whose toggle is OFF',
          );
          // The conflict set is INVARIANT: the diverged + delete-vs-change Units,
          // in every combination.
          assert.deepEqual(
            sorted(result.conflicts),
            expectedConflictRefs,
            'the conflict set is the diverged + delete-vs-change Units in every combination',
          );

          for (const e of expectations) {
            const merged = byId.get(e.project_id);
            assert.ok(merged, `project ${e.project_id} remains present`);
            const mergedRec = (rid) => merged.recordings.find((r) => r.recording_id === rid);

            // ── (B) changed-incoming fast-forward — settings DECIDE the outcome ──
            if (combo.autoAcceptUpdates) {
              // Auto-applied: the incoming version replaces local; reported as an
              // auto-applied update; never reviewed or conflicted.
              assert.ok(
                result.autoAppliedUpdates.includes(e.ci.unitRef),
                'the fast-forward is reported as an auto-applied update',
              );
              assert.ok(
                !result.review.includes(e.ci.unitRef),
                'an auto-applied update is not reviewed',
              );
              assert.equal(
                state.reviews?.[e.ci.unitRef],
                undefined,
                'no Review item for an auto-applied update',
              );
              assert.deepEqual(
                cleanCopy(recordingProjection(mergedRec(e.ci.recording_id))),
                e.ci.incoming,
                'the incoming fast-forward version is adopted into the merged list',
              );
            } else {
              // Held for Review: local is byte-identical; the Review retains the
              // incoming version; never auto-applied.
              assert.ok(
                result.review.includes(e.ci.unitRef),
                'the fast-forward is held for Review when the toggle is OFF',
              );
              assert.ok(
                !result.autoAppliedUpdates.includes(e.ci.unitRef),
                'not auto-applied when the toggle is OFF',
              );
              const review = state.reviews?.[e.ci.unitRef];
              assert.ok(review, 'a Review item exists');
              assert.equal(review.kind, 'review');
              assert.equal(review.status, 'PENDING');
              assert.deepEqual(
                review.incoming,
                e.ci.incoming,
                'the Review retains the incoming version',
              );
              assert.deepEqual(
                cleanCopy(recordingProjection(mergedRec(e.ci.recording_id))),
                e.ci.local,
                'local is left byte-identical when the change is deferred',
              );
            }

            // ── (C) deleted-remote-review — settings DECIDE the outcome ──
            if (combo.autoAcceptDeletions) {
              // Auto-applied: the recording is removed from the merged list and
              // reported as an auto-applied deletion; never reviewed or conflicted.
              assert.ok(
                result.autoAppliedDeletions.includes(e.del.unitRef),
                'the server deletion is reported as an auto-applied deletion',
              );
              assert.ok(
                !result.review.includes(e.del.unitRef),
                'an auto-applied deletion is not reviewed',
              );
              assert.equal(
                mergedRec(e.del.recording_id),
                undefined,
                'an auto-applied deletion removes the recording from the merged list',
              );
            } else {
              // Held for Review: the recording stays byte-identical locally; the
              // Review retains the deletion (incoming === null); never auto-applied.
              assert.ok(
                result.review.includes(e.del.unitRef),
                'the deletion is held for Review when the toggle is OFF',
              );
              assert.ok(
                !result.autoAppliedDeletions.includes(e.del.unitRef),
                'not auto-applied when the toggle is OFF',
              );
              const review = state.reviews?.[e.del.unitRef];
              assert.ok(review, 'a Review item exists for the deferred deletion');
              assert.equal(review.kind, 'review');
              assert.equal(
                review.incoming,
                null,
                'the deletion Review retains a null incoming version',
              );
              assert.deepEqual(
                cleanCopy(recordingProjection(mergedRec(e.del.recording_id))),
                e.del.local,
                'a deferred deletion keeps the local recording byte-identical',
              );
            }

            // ── (A) diverged & delete-vs-change — NEVER touched by any setting ──
            for (const both of [e.div, e.dvc]) {
              assert.ok(
                result.conflicts.includes(both.unitRef),
                'a both-sides-changed Unit is a Conflict in every combination',
              );
              assert.ok(
                !result.review.includes(both.unitRef),
                'a both-sides-changed Unit is never reviewed by any setting',
              );
              assert.ok(
                !result.autoAppliedUpdates.includes(both.unitRef) &&
                  !result.autoAppliedDeletions.includes(both.unitRef),
                'a both-sides-changed Unit is never auto-applied by any setting',
              );
              const conflict = state.conflicts?.[both.unitRef];
              assert.ok(conflict, `a Conflict is recorded for ${both.unitRef}`);
              assert.equal(conflict.kind, 'conflict');
              assert.equal(
                state.reviews?.[both.unitRef],
                undefined,
                'review/conflict mutual exclusion',
              );
            }
            // The diverged Conflict retains both versions; local is unchanged.
            assert.deepEqual(state.conflicts[e.div.unitRef].local, e.div.local);
            assert.deepEqual(state.conflicts[e.div.unitRef].incoming, e.div.incoming);
            assert.deepEqual(
              cleanCopy(recordingProjection(mergedRec(e.div.recording_id))),
              e.div.local,
              'the diverged local recording is untouched',
            );
            // The delete-vs-change Conflict retains the changed local side and a
            // null deletion side; local is NOT silently removed.
            assert.deepEqual(state.conflicts[e.dvc.unitRef].local, e.dvc.local);
            assert.equal(
              state.conflicts[e.dvc.unitRef].incoming,
              null,
              'the deletion side carries no version',
            );
            assert.deepEqual(
              cleanCopy(recordingProjection(mergedRec(e.dvc.recording_id))),
              e.dvc.local,
              'the server-deleted/local-changed recording is preserved unchanged',
            );

            // ── Converged sibling — never deferred, never auto-applied ──
            if (e.sib) {
              assert.ok(
                !result.review.includes(e.sib.unitRef),
                'a converged sibling is never reviewed',
              );
              assert.ok(
                !result.conflicts.includes(e.sib.unitRef),
                'a converged sibling is never conflicted',
              );
              assert.ok(
                !result.autoAppliedUpdates.includes(e.sib.unitRef) &&
                  !result.autoAppliedDeletions.includes(e.sib.unitRef),
                'a converged sibling is never auto-applied',
              );
              assert.deepEqual(
                cleanCopy(recordingProjection(mergedRec(e.sib.recording_id))),
                e.sib.local,
                'a converged sibling stays byte-identical under every setting',
              );
            }
          }

          conflictOutcomes.push(conflictOutcome(result, state, projects, expectations));
        }

        // ── The central claim: the Conflict outcome is IDENTICAL across all four
        //    settings combinations. The toggles moved only the
        //    local-unchanged Units; the divergence outcome is invariant. ──
        for (let i = 1; i < conflictOutcomes.length; i++) {
          assert.deepEqual(
            conflictOutcomes[i],
            conflictOutcomes[0],
            'the diverged / delete-vs-change Conflict outcome is identical under every settings combination',
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  // ── Deterministic regression example ────────────────────────────────────────
  // One project carrying all four Unit kinds, run through every settings
  // combination: the local-unchanged Units flip between auto-applied and Review
  // with the toggles, while the diverged and delete-vs-change Units stay Conflicts
  // with byte-identical outcomes in all four combinations.

  it('a fixed scenario: toggles flip only the local-unchanged Units; diverged & delete-vs-change Conflicts are invariant', async () => {
    const ID = '018f0000-0000-7000-8000-000000000040';
    const CI = '018f0000-0000-7000-8000-0000000000c1';
    const DEL = '018f0000-0000-7000-8000-0000000000d1';
    const DIV = '018f0000-0000-7000-8000-0000000000e1';
    const DVC = '018f0000-0000-7000-8000-0000000000f1';
    const CA = '2026-01-01T00:00:00.000Z';

    const s1 = { uuid: 'b-1', logical_id: 'a', step_number: 0, deleted: false };
    const s2 = { uuid: 'x-2', logical_id: 'a', step_number: 1, deleted: false };

    // changed-incoming fast-forward: local == baseline (only s1); server appends s2.
    const ciLocal = { recording_id: CI, name: 'ci', created_at: CA, steps: [s1] };
    const ciIncoming = { recording_id: CI, name: 'ci', created_at: CA, steps: [s1, s2] };
    // deleted-remote-review: local == baseline; absent on the server.
    const delLocal = { recording_id: DEL, name: 'del', created_at: CA, steps: [] };
    // diverged: base/local/incoming all distinct.
    const divBase = { recording_id: DIV, name: 'div-base', created_at: CA, steps: [] };
    const divLocal = { recording_id: DIV, name: 'div-loc', created_at: CA, steps: [] };
    const divIncoming = { recording_id: DIV, name: 'div-srv', created_at: CA, steps: [] };
    // delete-vs-change (server-deleted / local-changed).
    const dvcBase = { recording_id: DVC, name: 'dvc-base', created_at: CA, steps: [] };
    const dvcLocal = { recording_id: DVC, name: 'dvc-loc', created_at: CA, steps: [] };

    const localProject = cleanProject(ID, 'Project', CA, [ciLocal, delLocal, divLocal, dvcLocal]);
    const serverProject = cleanProject(ID, 'Project', CA, [ciIncoming, divIncoming]); // del + dvc deleted
    const agreedProject = cleanProject(ID, 'Project', CA, [ciLocal, delLocal, divBase, dvcBase]);

    const baselineSeed = createEmptySyncState();
    advanceBaseline(baselineSeed, ID, projectProjection(agreedProject));

    const manifest = [{ project_id: ID, name: 'Project' }];
    const payloadById = new Map([[ID, buildPayload(serverProject)]]);

    const ciRef = `${ID}:${CI}`;
    const delRef = `${ID}:${DEL}`;
    const divRef = `${ID}:${DIV}`;
    const dvcRef = `${ID}:${DVC}`;

    const expectedConflict = {
      [divRef]: {
        kind: 'conflict',
        recording_id: DIV,
        local: cleanCopy(recordingProjection(divLocal)),
        incoming: cleanCopy(recordingProjection(divIncoming)),
      },
      [dvcRef]: {
        kind: 'conflict',
        recording_id: DVC,
        local: cleanCopy(recordingProjection(dvcLocal)),
        incoming: null,
      },
    };

    for (const combo of COMBINATIONS) {
      installMockFetch(manifest, payloadById);
      const seed = structuredClone(baselineSeed);
      setSettings(seed, combo);
      const store = makeStore(seed);
      const { result, projects } = await sync(
        SERVER,
        null,
        structuredClone([localProject]),
        STUB_SCHEMA,
        passValidator,
        store,
        makeLiveState(),
      );
      const state = store.getState();
      const merged = projects.find((p) => p.project_id === ID);
      const mergedRec = (rid) => merged.recordings.find((r) => r.recording_id === rid);

      assert.equal(result.halted, false);
      // The conflict set is invariant.
      assert.deepEqual(sorted(result.conflicts), sorted([divRef, dvcRef]));
      // The diverged & delete-vs-change Conflict records are invariant.
      for (const ref of [divRef, dvcRef]) {
        const c = state.conflicts[ref];
        assert.deepEqual(
          { kind: c.kind, recording_id: c.recording_id, local: c.local, incoming: c.incoming },
          expectedConflict[ref],
          `Conflict for ${ref} is identical regardless of settings`,
        );
      }

      // changed-incoming flips with Auto-Accept-Updates.
      if (combo.autoAcceptUpdates) {
        assert.deepEqual(result.autoAppliedUpdates, [ciRef]);
        assert.ok(!result.review.includes(ciRef));
        assert.deepEqual(
          cleanCopy(recordingProjection(mergedRec(CI))),
          cleanCopy(recordingProjection(ciIncoming)),
        );
      } else {
        assert.deepEqual(result.autoAppliedUpdates, []);
        assert.ok(result.review.includes(ciRef));
        assert.deepEqual(
          cleanCopy(recordingProjection(mergedRec(CI))),
          cleanCopy(recordingProjection(ciLocal)),
        );
      }

      // deleted-remote-review flips with Auto-Accept-Deletions.
      if (combo.autoAcceptDeletions) {
        assert.deepEqual(result.autoAppliedDeletions, [delRef]);
        assert.ok(!result.review.includes(delRef));
        assert.equal(mergedRec(DEL), undefined, 'the deletion is applied to the merged list');
      } else {
        assert.deepEqual(result.autoAppliedDeletions, []);
        assert.ok(result.review.includes(delRef));
        assert.ok(mergedRec(DEL), 'the deletion is deferred; local recording kept');
      }
    }
  });
});
