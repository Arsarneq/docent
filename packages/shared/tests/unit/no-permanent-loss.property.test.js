/**
 * no-permanent-loss.property.test.js — Property test that across an arbitrary
 * sequence of sync cycles INTERLEAVED with user resolutions, no committed local
 * step record is ever PERMANENTLY lost. This is the end-to-end, whole-feature
 * invariant that ties the sync orchestrator (`sync-client.js` `sync()`) together
 * with the user-gated resolution workflow (`conflict-resolution.js`
 * `acceptReview` / `declineReview` / `resolveConflict`).
 *
 * Property 31 (design): "For any sequence of sync cycles — including concurrent
 * changes by another client against the opaque last-write-wins server — every
 * committed local version of a Unit remains recoverable (as live local data, a
 * retained Sync_Snapshot, a baseline copy, or a Conflict record) until the user
 * explicitly discards it through Conflict_Resolution. Because pull-then-push
 * detects a divergence before the local version is pushed and a deferred unit is
 * never pushed, no client's local work is overwritten on the server without first
 * surfacing as a Conflict." (R18.2, R20.2)
 *
 * ── Pull-first recovery model (the post-revision invariant) ──────────────────
 * The orchestrator runs PULL → reconcile → per-unit PUSH (R20.1). Pulling first
 * is what lets a concurrent server change be classified as a `diverged` Conflict
 * BEFORE this client's push could last-write-wins clobber it; a deferred (Review/
 * Conflict) or locked unit is then pushed only at its agreed-or-pulled version,
 * never at the un-reconciled local edits (R20.2, R20.3). So a committed local
 * step is preserved across a cycle (it stays live + retained on the Conflict/
 * snapshot/baseline), and a resolved or `changed-local-outgoing` unit propagates
 * as the LOCAL version on a subsequent cycle (R20.2, R20.5) rather than being
 * silently dropped.
 *
 * Crucially, "keep local" in a resolution keeps the user's CURRENT live work, not
 * the version captured when the Conflict was first detected: a sibling unit's own
 * resolution may have appended records to the live project since detection, and
 * keeping local must carry those forward so the kept local change propagates
 * (R20.2). The captured `item.local`/`item.incoming` are recovery handles; the
 * live unit is what is re-adopted.
 *
 * ── How the invariant is pinned ──────────────────────────────────────────────
 * The test drives the REAL `sync()` over a persistent `SyncStore`, interleaving
 * arbitrary sync cycles (each against a freshly-generated server view of the
 * current local projects — converge / change a recording / delete a recording /
 * delete a whole project) with arbitrary resolution actions on whatever items are
 * pending (accept/decline a Review; keep-local / keep-incoming / accept-deletion
 * a Conflict). Step records carry globally-unique uuids, so "which committed
 * records exist" is a faithful set identity.
 *
 * It tracks two sets across the whole sequence:
 *   - `committedLocal` — every step uuid that has ever appeared in a committed
 *     LOCAL recording (the universe of committed local work).
 *   - `discarded` — step uuids the user EXPLICITLY discarded through resolution:
 *     the local side of a Conflict resolved by accepting a deletion, or the local
 *     side of a Review the user accepted (adopting the incoming version over the
 *     local one). These are the only sanctioned ways committed local work leaves
 *     the recoverable set (R18.2's "until the user explicitly discards it").
 *
 * A step uuid is RECOVERABLE when it is present in any of: the live local
 * projects, a retained Sync_Snapshot, a baseline copy, a Conflict record (either
 * version), or a Review record's retained incoming version.
 *
 * After EVERY operation the test asserts the whole-feature invariant:
 *
 *     committedLocal ⊆ recoverable ∪ discarded
 *
 * The teeth come from WHEN `discarded` may grow:
 *   - A SYNC CYCLE never grows `discarded`, so the assertion proves a cycle loses
 *     NOTHING — every committed local record stays recoverable across the cycle,
 *     even when another client overwrote the server copy (the diverged /
 *     concurrent-push case central to R18) and even though the server is opaque
 *     last-write-wins. Pull-first is what makes this hold: the concurrent change
 *     is detected as a Conflict before the push, so the local version is never
 *     clobbered (R20.1, R20.2).
 *   - A DECLINE or a KEEP/MERGE resolution never grows `discarded` either: a keep
 *     adopts the user's CURRENT live unit folded with the conflicting version's
 *     records (an append-only superset), so every committed local record it
 *     contained survives and the kept local change propagates next cycle rather
 *     than being dropped (R20.2). The assertion proves they lose nothing.
 *   - Only ACCEPT (a Review) and ACCEPT-DELETION (a Conflict) may grow
 *     `discarded`, and then only by the resolved Unit's own local side — so the
 *     assertion still proves every OTHER committed local record stays recoverable.
 *
 * `fetch` is mocked exactly as in the sibling sync property tests
 * (`makeResponse`-style Response stubs dispatching per project_id); the validator
 * passes; an in-memory `SyncStore` persists across the whole sequence; a
 * permissive `LiveState` (capture inactive, nothing locked, nothing pending) lets
 * every cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check v4
 * (`fc.uuid({ version: 7 })` supplies project/recording ids that pass the
 * manifest's UUIDv7 guard).
 *
 * **Validates: Requirements 18.2, 20.2**
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Feature: sync-conflict-resolution, Property 31: No committed local work is ever permanently lost

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { createEmptySyncState, loadSyncState, saveSyncState } from '../../sync-store.js';
import { advanceBaseline } from '../../sync-baseline.js';
import {
  acceptReview,
  declineReview,
  resolveConflict,
  buildKeepResolution,
  DELETE_RESOLUTION,
} from '../../conflict-resolution.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// The stamp this client expects — derived from the same schema sync() uses, so a
// pulled payload built with it always passes the stamp-compatibility check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA);

// A fixed clock so the baseline `agreedAt` stamp is deterministic; the property
// asserts nothing about its value, only that committed local work stays
// recoverable.
const FIXED_NOW = () => 0;

const PROJ_CREATED = '2026-01-01T00:00:00.000Z';
const REC_CREATED = '2026-02-01T00:00:00.000Z';

// ─── fetch double (mirrors sync-client.test.js / idempotent-detection) ───────

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
 * In-memory {@link SyncStore} seeded with an initial SyncState and PERSISTING
 * across the whole operation sequence (the same `saved` blob is loaded by each
 * `sync()` / resolution and rewritten on save). Clones on the way in and out so
 * no reference is shared with the code under test.
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

// ─── recoverability bookkeeping ───────────────────────────────────────────────

/**
 * Collect the set of step-record `uuid`s contained in a Unit copy, across both
 * granularities (a recording's own `steps`, and every recording's `steps` inside
 * a project) — the same faithful "which committed records this version contains"
 * notion the modules use for their append-only safety checks. Tolerates `null`
 * (the deletion side of a delete-vs-change Unit carries no version).
 *
 * @param {object|null|undefined} copy
 * @returns {Set<string>}
 */
function uuidsInUnitCopy(copy) {
  const out = new Set();
  if (!copy || typeof copy !== 'object') return out;
  if (Array.isArray(copy.steps)) {
    for (const step of copy.steps) if (step && step.uuid != null) out.add(step.uuid);
  }
  if (Array.isArray(copy.recordings)) {
    for (const rec of copy.recordings) {
      if (rec && Array.isArray(rec.steps)) {
        for (const step of rec.steps) if (step && step.uuid != null) out.add(step.uuid);
      }
    }
  }
  return out;
}

/** All step uuids present in a live local projects array. */
function uuidsInProjects(projects) {
  const out = new Set();
  for (const project of projects ?? []) {
    for (const uuid of uuidsInUnitCopy(project)) out.add(uuid);
  }
  return out;
}

/**
 * Drop `null`/`undefined` entries from a projects array. `acceptReview` on a
 * project-level `deleted-remote-review` adopts the incoming (absent) version by
 * replacing the project slot with `null` — i.e. the user accepted the whole
 * project's deletion. A `null` slot is not committed local work (it carries no
 * steps) and is the explicit-discard outcome, so the platform's projects list
 * normalizes it away; the harness models that so the next cycle/op sees a clean
 * list. The discarded local records are tracked in `discarded` separately, so
 * this never hides a loss.
 *
 * @param {object[]} projects
 * @returns {object[]}
 */
function normalizeProjects(projects) {
  return (projects ?? []).filter((p) => p != null);
}

/**
 * The full recoverable set: every step uuid reachable from any recovery handle
 * the design names — live local data, a retained Sync_Snapshot, a baseline copy,
 * a Conflict record (either version), or a Review record's retained incoming
 * version (R18.2).
 *
 * @param {import('../../sync-types.js').SyncState} state
 * @param {object[]} projects
 * @returns {Set<string>}
 */
function recoverableUuids(state, projects) {
  const out = uuidsInProjects(projects);
  for (const snap of Object.values(state.snapshots ?? {})) {
    if (snap && snap.payload) for (const u of uuidsInUnitCopy(snap.payload)) out.add(u);
  }
  for (const baseline of Object.values(state.baselines ?? {})) {
    if (baseline && baseline.agreedState) {
      for (const u of uuidsInUnitCopy(baseline.agreedState)) out.add(u);
    }
  }
  for (const conflict of Object.values(state.conflicts ?? {})) {
    for (const u of uuidsInUnitCopy(conflict?.local)) out.add(u);
    for (const u of uuidsInUnitCopy(conflict?.incoming)) out.add(u);
  }
  for (const review of Object.values(state.reviews ?? {})) {
    for (const u of uuidsInUnitCopy(review?.incoming)) out.add(u);
  }
  return out;
}

/** The live local Unit (project for a project-level ref, recording otherwise). */
function liveUnit(projects, project_id, recording_id) {
  const project = (projects ?? []).find((p) => p && p.project_id === project_id);
  if (!project) return null;
  if (recording_id == null) return project;
  return (project.recordings ?? []).find((r) => r && r.recording_id === recording_id) ?? null;
}

// ─── generators ──────────────────────────────────────────────────────────────

/** A committed step record spec (the uuid is assigned uniquely at materialize). */
const arbStepSpec = fc.record({
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 5 }),
  deleted: fc.boolean(),
});

/**
 * A recording spec. `divergeBaseline` seeds the baseline with an EXTRA agreed
 * step the local side lacks, so the recording starts already differing from its
 * baseline — the precondition that lets a server change classify as a `diverged`
 * Conflict (the concurrent-overwrite case central to R18), not merely a Review.
 */
const arbRecSpec = fc.record({
  recording_id: fc.uuid({ version: 7 }),
  steps: fc.array(arbStepSpec, { minLength: 1, maxLength: 3 }),
  divergeBaseline: fc.boolean(),
});

const arbProjSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  recordings: fc.uniqueArray(arbRecSpec, {
    selector: (r) => r.recording_id,
    minLength: 1,
    maxLength: 3,
  }),
});

const arbInitial = fc.uniqueArray(arbProjSpec, {
  selector: (p) => p.project_id,
  minLength: 1,
  maxLength: 3,
});

/** A sync cycle, with the server's transform of the current local projects. */
const arbCycleOp = fc.record({
  type: fc.constant('cycle'),
  mode: fc.constantFrom('none', 'changeRec', 'deleteRec', 'absentProject'),
  target: fc.nat({ max: 1000 }),
});

/** A resolution action on whatever item the (modular) index picks. */
const arbResolveOp = fc.record({
  type: fc.constant('resolve'),
  itemIndex: fc.nat({ max: 1000 }),
  action: fc.constantFrom('keepLocal', 'keepIncoming', 'delete', 'accept', 'decline'),
});

const arbScenario = fc.record({
  initial: arbInitial,
  // Up to 8 ops so a sequence can interleave a cycle, a sibling resolution that
  // evolves the live project, and a later resolution of a still-pending overlapping
  // (project-level) Conflict — the multi-resolution shape that exposed the
  // stale-captured-version recovery bug this revision fixes.
  ops: fc.array(fc.oneof(arbCycleOp, arbResolveOp), { minLength: 1, maxLength: 8 }),
});

// ─── materialization ──────────────────────────────────────────────────────────

/**
 * Materialize the initial local projects and the seeded SyncState (baselines).
 * Step uuids are assigned from the shared monotonic `nextUuid` so every committed
 * record — local, baseline-only, and (later) server-only — is globally unique.
 *
 * @param {object[]} initialSpec
 * @param {() => string} nextUuid
 * @returns {{ seed: import('../../sync-types.js').SyncState, projects: object[] }}
 */
function materializeInitial(initialSpec, nextUuid) {
  const seed = createEmptySyncState();
  const projects = [];

  for (const pspec of initialSpec) {
    const recordings = pspec.recordings.map((rspec) => ({
      recording_id: rspec.recording_id,
      name: `rec-${rspec.recording_id.slice(0, 8)}`,
      created_at: REC_CREATED,
      steps: rspec.steps.map((s) => ({
        uuid: nextUuid(),
        logical_id: s.logical_id,
        step_number: s.step_number,
        deleted: s.deleted,
      })),
    }));

    const project = {
      project_id: pspec.project_id,
      name: `proj-${pspec.project_id.slice(0, 8)}`,
      created_at: PROJ_CREATED,
      recordings,
    };
    projects.push(project);

    // Baseline: the agreed state, optionally carrying an extra agreed step the
    // local side lacks (so local already differs from baseline → diverged later).
    const baselineRecordings = recordings.map((rec, i) => {
      const steps = [...rec.steps];
      if (pspec.recordings[i].divergeBaseline) {
        steps.push({ uuid: nextUuid(), logical_id: 'base-only', step_number: 99, deleted: false });
      }
      return { ...rec, steps };
    });
    advanceBaseline(
      seed,
      project.project_id,
      projectProjection({ ...project, recordings: baselineRecordings }),
      FIXED_NOW,
    );
  }

  return { seed, projects };
}

/** Flat list of {pIdx, rIdx} addresses for every recording in the projects. */
function flatUnits(projects) {
  const units = [];
  projects.forEach((p, pIdx) => {
    (p.recordings ?? []).forEach((_r, rIdx) => units.push({ pIdx, rIdx }));
  });
  return units;
}

/**
 * Build the server view for one cycle from the CURRENT local projects, applying
 * the op's transform to a single target Unit (all others converge):
 *   - 'none'          — every project mirrors local exactly (all converged).
 *   - 'changeRec'     — one recording's steps are REPLACED by a fresh server step
 *                       (drops the local steps from the incoming version, so the
 *                       incoming side cannot itself stand in for the local
 *                       records — recoverability must come from a deferral or the
 *                       baseline / live local).
 *   - 'deleteRec'     — one recording is omitted from its project's payload.
 *   - 'absentProject' — one whole project is omitted from the manifest.
 *
 * @param {object[]} projects
 * @param {{mode: string, target: number}} op
 * @param {() => string} nextUuid
 * @returns {{ manifest: object[], payloadById: Map<string, object> }}
 */
function buildServerForCycle(projects, op, nextUuid) {
  const manifest = [];
  const payloadById = new Map();
  if (projects.length === 0) return { manifest, payloadById };

  let absentPid = null;
  let changeAddr = null;
  let deleteAddr = null;

  if (op.mode === 'absentProject') {
    absentPid = projects[op.target % projects.length].project_id;
  } else if (op.mode === 'changeRec' || op.mode === 'deleteRec') {
    const units = flatUnits(projects);
    if (units.length > 0) {
      const addr = units[op.target % units.length];
      if (op.mode === 'changeRec') changeAddr = addr;
      else deleteAddr = addr;
    }
  }

  projects.forEach((project, pIdx) => {
    if (project.project_id === absentPid) return; // omit whole project

    let recs = (project.recordings ?? []).map(recordingProjection);
    if (changeAddr && changeAddr.pIdx === pIdx) {
      recs = recs.map((rec, rIdx) =>
        rIdx === changeAddr.rIdx
          ? {
              ...rec,
              steps: [{ uuid: nextUuid(), logical_id: 'srv', step_number: 0, deleted: false }],
            }
          : rec,
      );
    }
    if (deleteAddr && deleteAddr.pIdx === pIdx) {
      recs = recs.filter((_rec, rIdx) => rIdx !== deleteAddr.rIdx);
    }

    const serverProject = {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
      ...(project.metadata && { metadata: project.metadata }),
      recordings: recs,
    };
    manifest.push({ project_id: project.project_id, name: project.name });
    payloadById.set(project.project_id, buildPayload(serverProject));
  });

  return { manifest, payloadById };
}

// ─── resolution drivers ───────────────────────────────────────────────────────

/**
 * Union an arbitrary set of Unit copies (recording- or project-level) into ONE
 * Unit by step `uuid`. Used as the "other" side of {@link buildKeepResolution} so
 * a keep resolution retains every committed record from the CURRENT live unit AND
 * from both captured conflicting versions — an append-only superset that
 * `resolveConflict` accepts and that keeps all three recoverable (R9.3). Project
 * copies are unioned per recording (by `recording_id`, steps unioned by `uuid`);
 * recording copies are unioned by their own `steps`. Null entries are tolerated.
 *
 * @param {boolean} isProject - true for project-level Units, false for recordings
 * @param {...(object|null)} units - the Unit copies to fold together
 * @returns {object|null} the folded Unit, or null when every input is absent
 */
function unionUnit(isProject, ...units) {
  const present = units.filter((u) => u != null);
  if (present.length === 0) return null;

  if (!isProject) {
    const seen = new Set();
    const steps = [];
    for (const u of present) {
      for (const s of u.steps ?? []) {
        if (!s || s.uuid == null || seen.has(s.uuid)) continue;
        seen.add(s.uuid);
        steps.push(s);
      }
    }
    return { ...present[0], steps };
  }

  const byId = new Map();
  for (const u of present) {
    for (const rec of u.recordings ?? []) {
      if (!rec || rec.recording_id == null) continue;
      const prev = byId.get(rec.recording_id);
      if (!prev) {
        byId.set(rec.recording_id, { ...rec, steps: [...(rec.steps ?? [])] });
      } else {
        const seen = new Set(prev.steps.map((s) => s && s.uuid));
        for (const s of rec.steps ?? []) {
          if (s && s.uuid != null && !seen.has(s.uuid)) {
            seen.add(s.uuid);
            prev.steps.push(s);
          }
        }
      }
    }
  }
  return { ...present[0], recordings: [...byId.values()] };
}

/**
 * Resolve a Conflict with the chosen action, returning the result and the set of
 * step uuids the action explicitly discards.
 *
 * ── Post-revision (pull-first) recovery model ────────────────────────────────
 * A "keep" resolution must keep the user's CURRENT live work, not the version
 * captured when the Conflict was first detected: a sibling Unit's own resolution
 * may have appended records to the live project since detection (e.g. a
 * keep-local on one recording restamps a fresh winning step), and keeping local
 * must carry those forward so the kept local change PROPAGATES rather than being
 * silently dropped (R20.2). So every keep/merge action adopts an append-only
 * SUPERSET that folds the live unit together with both captured versions: the
 * live work survives, and both captured versions stay recoverable (R9.3). Only an
 * accept-deletion explicitly discards the current local work in the Unit (R18.2).
 */
function doResolveConflict(state, projects, ref, item, action, nextUuid) {
  const isProject = item.recording_id == null;
  // The CURRENT live unit (may have evolved since the Conflict was detected via a
  // sibling resolution) — the version a "keep local" must actually preserve.
  const live = liveUnit(projects, item.project_id, item.recording_id);
  const hasAny = live != null || item.local != null || item.incoming != null;

  // Fold the live unit and both captured versions into one append-only "other"
  // side, so any keep/merge resolution retains every committed record from all
  // three (R9.3, R20.2).
  const fold = unionUnit(isProject, live, item.local, item.incoming);

  let resolvedState;
  let discardedUuids = new Set();

  if (action === 'delete') {
    resolvedState = DELETE_RESOLUTION;
    // Accepting the deletion is the user explicitly discarding the current local
    // work in this Unit (R18.2 "until the user explicitly discards it") — both
    // the live copy and the version captured when the Conflict was detected.
    discardedUuids = new Set([...uuidsInUnitCopy(live), ...uuidsInUnitCopy(item.local)]);
  } else if (!hasAny) {
    // Degenerate — both sides and the live unit are absent; nothing to keep or
    // discard. (`resolveConflict` will treat this as the deletion outcome.)
    resolvedState = DELETE_RESOLUTION;
  } else {
    // keepLocal / keepIncoming / any keep-style action: adopt a superset that
    // keeps the live work recoverable. The winner side differs only cosmetically
    // (keep-incoming makes the incoming version the active view) — recoverability
    // is identical, since every record from the live unit, the captured local,
    // and the captured incoming is retained. Keeping discards NOTHING (R20.2).
    const keep =
      action === 'keepIncoming'
        ? (item.incoming ?? live ?? item.local)
        : (live ?? item.local ?? item.incoming);
    resolvedState = buildKeepResolution(keep, fold, { newId: nextUuid });
  }

  const result = resolveConflict(state, projects, ref, resolvedState, { now: FIXED_NOW });
  return { result, discardedUuids };
}

/**
 * Resolve a Review with the chosen action. Accepting adopts the incoming version
 * over the local one, explicitly discarding the resolved Unit's local side;
 * declining (and any non-accept action) keeps local and discards nothing.
 */
function doResolveReview(state, projects, ref, item, action) {
  if (action === 'accept') {
    const discardedUuids = uuidsInUnitCopy(liveUnit(projects, item.project_id, item.recording_id));
    const result = acceptReview(state, projects, ref, { now: FIXED_NOW });
    return { result, discardedUuids };
  }
  const result = declineReview(state, projects, ref);
  return { result, discardedUuids: new Set() };
}

// ─── Property 31 ──────────────────────────────────────────────────────────────

describe('Property 31: No committed local work is ever permanently lost', () => {
  it('keeps every committed local step recoverable across arbitrary sync cycles and resolutions, except where the user explicitly discards it', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ initial, ops }) => {
        // A shared monotonic uuid source so every committed step record — local,
        // baseline-only, and server-only — is globally unique across the run.
        let counter = 0;
        const nextUuid = () => {
          counter += 1;
          return `00000000-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
        };

        const { seed, projects: initialProjects } = materializeInitial(initial, nextUuid);
        let projects = initialProjects;
        const store = makeStore(seed);

        // The universe of committed local work, and the records the user has
        // explicitly discarded through resolution.
        const committedLocal = new Set();
        const discarded = new Set();

        const trackLocal = () => {
          for (const uuid of uuidsInProjects(projects)) committedLocal.add(uuid);
        };

        /** The whole-feature invariant: committedLocal ⊆ recoverable ∪ discarded. */
        const assertInvariant = (label) => {
          const state = store.getState() ?? createEmptySyncState();
          const recoverable = recoverableUuids(state, projects);
          for (const uuid of committedLocal) {
            assert.ok(
              recoverable.has(uuid) || discarded.has(uuid),
              `${label}: committed local step ${uuid} must remain recoverable (live, snapshot, baseline, conflict, or review) or have been explicitly discarded through resolution`,
            );
          }
        };

        trackLocal();
        assertInvariant('initial');

        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];

          if (op.type === 'cycle') {
            const { manifest, payloadById } = buildServerForCycle(projects, op, nextUuid);
            installMockFetch(manifest, payloadById);

            const { result, projects: merged } = await sync(
              'https://srv.test',
              null,
              projects,
              STUB_SCHEMA,
              passValidator,
              store,
              makeLiveState(),
            );

            // A permissive cycle never halts.
            assert.equal(result.halted, false, `op ${i} (cycle:${op.mode}) must not halt`);
            assert.equal(result.haltReason, null);

            projects = normalizeProjects(merged);
            trackLocal();
            // `discarded` is UNCHANGED across a cycle, so this proves the cycle
            // lost nothing — every committed local record is still recoverable.
            assertInvariant(`op ${i} (cycle:${op.mode})`);
            continue;
          }

          // Resolution op — act on whatever item the index picks.
          const state = await loadSyncState(store);
          const refs = [
            ...Object.keys(state.conflicts ?? {}).map((ref) => ({ ref, kind: 'conflict' })),
            ...Object.keys(state.reviews ?? {}).map((ref) => ({ ref, kind: 'review' })),
          ];
          if (refs.length === 0) {
            assertInvariant(`op ${i} (resolve: none pending)`);
            continue;
          }

          const pick = refs[op.itemIndex % refs.length];
          const { result, discardedUuids } =
            pick.kind === 'conflict'
              ? doResolveConflict(
                  state,
                  projects,
                  pick.ref,
                  state.conflicts[pick.ref],
                  op.action,
                  nextUuid,
                )
              : doResolveReview(state, projects, pick.ref, state.reviews[pick.ref], op.action);

          if (result && result.ok) {
            projects = normalizeProjects(result.projects);
            await saveSyncState(store, state);
            for (const uuid of discardedUuids) discarded.add(uuid);
            trackLocal();
          }
          // For decline / keep resolutions `discarded` is unchanged → proves they
          // lose nothing. For accept / accept-deletion only the resolved Unit's
          // local side is added → proves every OTHER committed record survives.
          assertInvariant(`op ${i} (resolve ${pick.kind}:${op.action})`);
        }
      }),
      { numRuns: 200 },
    );
  });

  // ─── Deterministic regression examples ──────────────────────────────────────

  it('a diverged conflict (concurrent overwrite) keeps the local step recoverable through the cycle and a keep-local resolution (R18.1, R18.2)', async () => {
    const PID = '018f0000-0000-7000-8000-000000000301';
    const RID = '018f0000-0000-7000-8000-0000000000a1';
    const ref = `${PID}:${RID}`;
    const mkRec = (name, uuid) => ({
      recording_id: RID,
      name,
      created_at: REC_CREATED,
      steps: [{ uuid, logical_id: 'a', step_number: 0, deleted: false }],
    });

    // Baseline agreed on B1; local moved to L1 (changed since baseline); the
    // server was concurrently overwritten to S1. Three distinct versions ⇒
    // diverged, not changed-incoming.
    const local = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [mkRec('local', 'L1')],
    };
    const baselineProj = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [mkRec('base', 'B1')],
    };
    const serverProj = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [mkRec('server', 'S1')],
    };

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baselineProj), FIXED_NOW);
    const store = makeStore(seed);

    installMockFetch([{ project_id: PID, name: 'P' }], new Map([[PID, buildPayload(serverProj)]]));

    let { result, projects } = await sync(
      'https://srv.test',
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, [ref], 'the diverged recording is a Conflict');

    // After the cycle: the committed local step L1 is still recoverable (live +
    // conflict.local), even though the opaque server overwrote its copy.
    let recoverable = recoverableUuids(store.getState(), projects);
    assert.ok(recoverable.has('L1'), 'L1 recoverable after the diverged cycle');
    assert.ok(recoverable.has('S1'), 'the incoming S1 is also retained (snapshot + conflict)');

    // Resolve keep-local: append-only, so BOTH L1 and S1 stay recoverable.
    const state = await loadSyncState(store);
    const item = state.conflicts[ref];
    const resolved = resolveConflict(
      state,
      projects,
      ref,
      buildKeepResolution(item.local, item.incoming),
      { now: FIXED_NOW },
    );
    assert.equal(resolved.ok, true);
    await saveSyncState(store, state);
    projects = resolved.projects;

    recoverable = recoverableUuids(store.getState(), projects);
    assert.ok(recoverable.has('L1'), 'L1 still recoverable after keep-local resolution');
    assert.ok(recoverable.has('S1'), 'S1 still recoverable after keep-local resolution');
  });

  it('declining a changed-incoming Review keeps the local step recoverable; the cycle never auto-applies the incoming change (R18.2)', async () => {
    const PID = '018f0000-0000-7000-8000-000000000302';
    const RID = '018f0000-0000-7000-8000-0000000000b1';
    const ref = `${PID}:${RID}`;
    const mkRec = (name, uuid) => ({
      recording_id: RID,
      name,
      created_at: REC_CREATED,
      steps: [{ uuid, logical_id: 'a', step_number: 0, deleted: false }],
    });

    // local == baseline (unchanged), server changed ⇒ changed-incoming (Review).
    const local = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [mkRec('agreed', 'L1')],
    };
    const serverProj = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [mkRec('server', 'S1')],
    };

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(local), FIXED_NOW);
    const store = makeStore(seed);

    installMockFetch([{ project_id: PID, name: 'P' }], new Map([[PID, buildPayload(serverProj)]]));

    let { result, projects } = await sync(
      'https://srv.test',
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(result.halted, false);
    assert.deepEqual(result.review, [ref], 'the changed-incoming recording is a Review');

    // Local was not auto-applied: L1 is still in live local and the baseline.
    let recoverable = recoverableUuids(store.getState(), projects);
    assert.ok(recoverable.has('L1'), 'L1 recoverable after the changed-incoming cycle');

    // Decline: keeps local, discards nothing — L1 stays recoverable.
    const state = await loadSyncState(store);
    const declined = declineReview(state, projects, ref);
    assert.equal(declined.ok, true);
    await saveSyncState(store, state);
    projects = declined.projects;

    recoverable = recoverableUuids(store.getState(), projects);
    assert.ok(recoverable.has('L1'), 'L1 still recoverable after declining the Review');
  });

  it('accepting a deletion discards only the resolved Unit; a sibling project keeps its committed local work recoverable (R18.2)', async () => {
    const KEEP_PID = '018f0000-0000-7000-8000-000000000303';
    const DEL_PID = '018f0000-0000-7000-8000-000000000304';
    const KEEP_RID = '018f0000-0000-7000-8000-0000000000c1';
    const DEL_RID = '018f0000-0000-7000-8000-0000000000c2';
    const delRef = `${DEL_PID}:${DEL_RID}`;
    const mkRec = (rid, name, uuid) => ({
      recording_id: rid,
      name,
      created_at: REC_CREATED,
      steps: [{ uuid, logical_id: 'a', step_number: 0, deleted: false }],
    });

    // KEEP project: converges every cycle. DEL project: local changed (L_DEL)
    // from baseline (B_DEL) and the server deleted the recording ⇒ delete-vs-change.
    const keepProj = {
      project_id: KEEP_PID,
      name: 'Keep',
      created_at: PROJ_CREATED,
      recordings: [mkRec(KEEP_RID, 'k', 'K1')],
    };
    const delLocal = {
      project_id: DEL_PID,
      name: 'Del',
      created_at: PROJ_CREATED,
      recordings: [mkRec(DEL_RID, 'local', 'L_DEL')],
    };
    const delBaseline = {
      project_id: DEL_PID,
      name: 'Del',
      created_at: PROJ_CREATED,
      recordings: [mkRec(DEL_RID, 'base', 'B_DEL')],
    };
    const delServer = {
      project_id: DEL_PID,
      name: 'Del',
      created_at: PROJ_CREATED,
      recordings: [],
    };

    const seed = createEmptySyncState();
    advanceBaseline(seed, KEEP_PID, projectProjection(keepProj), FIXED_NOW);
    advanceBaseline(seed, DEL_PID, projectProjection(delBaseline), FIXED_NOW);
    const store = makeStore(seed);

    installMockFetch(
      [
        { project_id: KEEP_PID, name: 'Keep' },
        { project_id: DEL_PID, name: 'Del' },
      ],
      new Map([
        [KEEP_PID, buildPayload(keepProj)],
        [DEL_PID, buildPayload(delServer)],
      ]),
    );

    let { result, projects } = await sync(
      'https://srv.test',
      null,
      [keepProj, delLocal],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, [delRef], 'delete-vs-change is a Conflict');

    // Accept the deletion of the DEL recording: explicit discard of L_DEL.
    const state = await loadSyncState(store);
    const resolved = resolveConflict(state, projects, delRef, DELETE_RESOLUTION, {
      now: FIXED_NOW,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.removed, true);
    await saveSyncState(store, state);
    projects = resolved.projects;

    // The sibling KEEP project's committed local step survives; the explicitly
    // deleted DEL recording's local step is no longer in live local data.
    const recoverable = recoverableUuids(store.getState(), projects);
    assert.ok(
      recoverable.has('K1'),
      'the sibling project keeps its committed local work recoverable',
    );
    const liveDel = projects.find((p) => p.project_id === DEL_PID);
    const liveDelStillHas =
      liveDel && (liveDel.recordings ?? []).some((r) => r.recording_id === DEL_RID);
    assert.equal(
      liveDelStillHas,
      false,
      'the explicitly accepted deletion removed the local recording',
    );
  });

  it('a keep-local on a recording Conflict then a keep-local on a stale OVERLAPPING project Conflict keeps the restamped local work recoverable (pull-first; R18.2, R20.2)', async () => {
    // Regression for the intermittent failure under the pull-first model:
    // counterexample seed 1848596674 (absentProject → changeRec → keepLocal →
    // keepLocal → none). A whole-project absence then reappearance leaves an
    // overlapping project-level delete-vs-change Conflict AND a recording-level
    // diverged Conflict pending. Resolving the recording Conflict keep-local
    // restamps a fresh winning step into the LIVE project; resolving the stale
    // project-level Conflict keep-local must keep that CURRENT live work (not the
    // version captured when the project Conflict was first detected), so the
    // restamped step is never silently dropped (R20.2).
    const PID = '018f0000-0000-7000-8000-000000000305';
    const RID = '018f0000-0000-7000-8000-0000000000e1';
    const recRef = `${PID}:${RID}`;
    const mkRec = (uuid) => ({
      recording_id: RID,
      name: 'rec',
      created_at: REC_CREATED,
      steps: [{ uuid, logical_id: 'a', step_number: 0, deleted: false }],
    });

    // Baseline carries an extra agreed step the local side lacks, so local already
    // differs from baseline (the diverge precondition).
    const local = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [mkRec('L1')],
    };
    const baselineProj = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [
        {
          recording_id: RID,
          name: 'rec',
          created_at: REC_CREATED,
          steps: [
            { uuid: 'L1', logical_id: 'a', step_number: 0, deleted: false },
            { uuid: 'BASE', logical_id: 'base-only', step_number: 99, deleted: false },
          ],
        },
      ],
    };

    const seed = createEmptySyncState();
    advanceBaseline(seed, PID, projectProjection(baselineProj), FIXED_NOW);
    const store = makeStore(seed);

    const committedLocal = new Set(['L1']);
    const discarded = new Set();
    const assertInvariant = (label, projects) => {
      const recoverable = recoverableUuids(store.getState(), projects);
      for (const uuid of committedLocal) {
        assert.ok(
          recoverable.has(uuid) || discarded.has(uuid),
          `${label}: committed local step ${uuid} must remain recoverable`,
        );
      }
    };

    // op 0 — absentProject: the project is omitted from the manifest. Local
    // differs from baseline ⇒ a project-level delete-vs-change Conflict.
    installMockFetch([], new Map());
    let { result, projects } = await sync(
      'https://srv.test',
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    );
    assert.equal(result.halted, false);
    assert.deepEqual(
      result.conflicts,
      [PID],
      'a project-level delete-vs-change Conflict is recorded',
    );
    assertInvariant('after absentProject cycle', projects);

    // op 1 — changeRec: the project reappears with the recording REPLACED by a
    // fresh server step S1 ⇒ a recording-level diverged Conflict. The project-level
    // Conflict from op 0 still lingers (overlapping).
    const serverProj = {
      project_id: PID,
      name: 'P',
      created_at: PROJ_CREATED,
      recordings: [mkRec('S1')],
    };
    installMockFetch([{ project_id: PID, name: 'P' }], new Map([[PID, buildPayload(serverProj)]]));
    ({ result, projects } = await sync(
      'https://srv.test',
      null,
      projects,
      STUB_SCHEMA,
      passValidator,
      store,
      makeLiveState(),
    ));
    assert.equal(result.halted, false);
    assert.deepEqual(result.conflicts, [recRef], 'a recording-level diverged Conflict is recorded');
    for (const uuid of uuidsInProjects(projects)) committedLocal.add(uuid);
    assertInvariant('after changeRec cycle', projects);

    // op 2 — keep-local on the RECORDING Conflict: restamps a fresh winning step
    // into the live recording (so L1 + S1 + a new uuid are live).
    let state = await loadSyncState(store);
    let counter = 100;
    const nextUuid = () => `00000000-0000-7000-8000-${(counter++).toString(16).padStart(12, '0')}`;
    let res = doResolveConflict(
      state,
      projects,
      recRef,
      state.conflicts[recRef],
      'keepLocal',
      nextUuid,
    );
    assert.equal(res.result.ok, true);
    projects = normalizeProjects(res.result.projects);
    await saveSyncState(store, state);
    for (const uuid of res.discardedUuids) discarded.add(uuid);
    for (const uuid of uuidsInProjects(projects)) committedLocal.add(uuid);
    assertInvariant('after recording keep-local', projects);

    // op 3 — keep-local on the still-pending OVERLAPPING project-level Conflict.
    // It must keep the CURRENT live project (with the restamped step), not the
    // stale captured local from op 0, so nothing is dropped (R20.2).
    state = await loadSyncState(store);
    res = doResolveConflict(state, projects, PID, state.conflicts[PID], 'keepLocal', nextUuid);
    assert.equal(res.result.ok, true);
    projects = normalizeProjects(res.result.projects);
    await saveSyncState(store, state);
    for (const uuid of res.discardedUuids) discarded.add(uuid);
    for (const uuid of uuidsInProjects(projects)) committedLocal.add(uuid);
    assertInvariant('after project keep-local (no committed local work dropped)', projects);
  });
});
