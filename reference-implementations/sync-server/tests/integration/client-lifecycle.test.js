/**
 * client-lifecycle.test.js — END-TO-END sync lifecycle, real client ↔ real server.
 *
 * This is the automated replacement for the manual conflict-resolution test pass.
 * Unlike the shared unit suites (which drive the classifier/resolution/orchestrator
 * with a MOCKED fetch), this suite runs the actual shared `sync()` + resolution
 * code against a REAL Reference Sync Server instance over real HTTP — the same
 * thing a human exercises by hand: stage a server change, sync, assert the
 * review/conflict, resolve, assert convergence/push.
 *
 * It covers the full matrix manual testing walked through:
 *   - brand-new push → converge (baseline recorded on agreement, not on push)
 *   - review (server-only change) → accept / decline
 *   - conflict (both sides change) → resolve-to-server / resolve-to-local (push next cycle)
 *   - delete-vs-change conflict → accept-the-deletion
 *   - cross-platform stamp-mismatch skip (reported, never a conflict)
 *
 * Server-spawn is the shared `startTestServer` harness (ephemeral port, fresh temp
 * storage). The client side uses an in-memory `SyncStore`, the composed platform
 * schema (`composePlatform`), and the production standalone validator — no UI, so
 * it runs headless in `node --test`, fast.
 *
 * This file is a repository/testing artifact (it lives under
 * `reference-implementations/`, excluded from every release).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, request } from './harness.js';
import { sync } from '../../../../packages/shared/sync-client.js';
import { loadSyncState, saveSyncState } from '../../../../packages/shared/sync-store.js';
import {
  itemKind,
  acceptReview,
  declineReview,
  resolveConflict,
  DELETE_RESOLUTION,
} from '../../../../packages/shared/conflict-resolution.js';
import { composePlatform } from '../../../../scripts/build-schemas.js';
import validateExtension from '../../../../packages/shared/generated/validate-extension.js';

// ─── Fixtures & client wiring ─────────────────────────────────────────────────

const EXT_SCHEMA = composePlatform('extension');
const PID = '019ed000-0000-7000-8000-000000000001';
const RID = '019ed000-0000-7000-8000-0000000000a1';
const RID2 = '019ed000-0000-7000-8000-0000000000a2';

/** A minimal, schema-valid extension project with one recording / one step. */
function freshProject({ name = 'Lifecycle project', recName = 'rec one' } = {}) {
  return {
    project_id: PID,
    name,
    created_at: '2026-06-01T00:00:00.000Z',
    recordings: [
      {
        recording_id: RID,
        name: recName,
        created_at: '2026-06-01T00:00:01.000Z',
        steps: [
          {
            uuid: '019ed000-0000-7000-8000-0000000000b1',
            logical_id: '019ed000-0000-7000-8000-0000000000b1',
            step_number: 1,
            created_at: '2026-06-01T00:00:02.000Z',
            narration: 'do the thing',
            narration_source: 'typed',
            deleted: false,
            actions: [
              {
                type: 'navigate',
                timestamp: 1781720357843,
                context_id: 1,
                capture_mode: 'dom',
                frame_src: null,
                nav_type: 'typed',
                url: 'https://app.example.com/',
              },
            ],
          },
        ],
      },
    ],
  };
}

/** An in-memory SyncStore (the `{ load, save }` adapter `sync()` persists through). */
function makeStore() {
  let blob = null;
  return {
    load: async () => blob,
    save: async (s) => {
      blob = s;
    },
  };
}

const deep = (v) => JSON.parse(JSON.stringify(v));
const unitRef = (pid, rid) => `${pid}:${rid}`;
const recName = (projects, pid, rid) =>
  projects.find((p) => p.project_id === pid)?.recordings.find((r) => r.recording_id === rid)?.name;

let server;
before(async () => {
  server = await startTestServer();
});
after(async () => {
  await server?.close();
});
beforeEach(async () => {
  // Each scenario starts from an empty server (fresh storage) and a fresh store.
  await request(server.baseUrl, 'POST', '/__debug/reset');
});

/** Run one real `sync()` cycle for an extension client; returns `{ result, projects }`. */
async function runCycle(store, localProjects, { apiKey = null } = {}) {
  return sync(server.baseUrl, apiKey, localProjects, EXT_SCHEMA, validateExtension, store);
}

/**
 * Sync until fully converged (nothing pushed/reviewed/conflicted), returning the
 * settled local projects. A brand-new local project takes TWO cycles to settle:
 * cycle 1 PUSHES it (a push never records a baseline — agreement isn't proven
 * yet); cycle 2 PULLS it back, sees local == incoming, and records the baseline.
 * Establishing that baseline is the precondition for a later one-sided server
 * change to classify as a review rather than a no-baseline divergence.
 */
async function converge(store, localProjects) {
  let p = localProjects;
  for (let i = 0; i < 4; i++) {
    const { result, projects } = await runCycle(store, p);
    p = projects;
    if (!result.pushed.length && !result.review.length && !result.conflicts.length) return p;
  }
  throw new Error('did not converge within 4 cycles');
}

/** GET the verbatim project payload currently stored on the server (or null/404). */
async function serverProject(id) {
  const res = await request(server.baseUrl, 'GET', `/projects/${id}`);
  return res.status === 200 ? res.body : null;
}

/** Mutate the server's stored copy of a recording's name (a server-side edit). */
async function renameOnServer(id, recId, newName) {
  const payload = await serverProject(id);
  payload.recordings.find((r) => r.recording_id === recId).name = newName;
  const res = await request(server.baseUrl, 'PUT', `/projects/${id}`, { body: payload });
  assert.ok(res.status === 200 || res.status === 201, `server PUT ${res.status}`);
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

describe('client ↔ real server: sync lifecycle', () => {
  it('brand-new local project is pushed, then converges with a baseline recorded on agreement', async () => {
    const store = makeStore();

    // Cycle 1 PUSHES the brand-new project (records no baseline — a push is not
    // proof of agreement).
    const c1 = await runCycle(store, [freshProject()]);
    assert.deepEqual(c1.result.conflicts, []);
    assert.deepEqual(c1.result.review, []);
    assert.ok(c1.result.pushed.includes(PID), 'brand-new project pushed');
    assert.equal((await serverProject(PID)).recordings[0].name, 'rec one', 'server holds it');

    // Cycle 2 PULLS it back, sees local == incoming → records the baseline and
    // pushes nothing (the converged no-op).
    const c2 = await runCycle(store, c1.projects);
    assert.deepEqual(c2.result.conflicts, []);
    assert.deepEqual(c2.result.review, []);
    assert.deepEqual(c2.result.pushed, [], 'converged project is not re-pushed');
    assert.ok((await loadSyncState(store)).baselines[PID], 'baseline recorded on agreement');
  });

  it('server-only change surfaces a REVIEW (not a conflict) and does not push', async () => {
    const store = makeStore();
    const projects = await converge(store, [freshProject()]);

    await renameOnServer(PID, RID, 'rec one [SERVER]');

    const c = await runCycle(store, projects);
    assert.deepEqual(c.result.conflicts, [], 'a one-sided change is never a conflict');
    assert.deepEqual(c.result.review, [unitRef(PID, RID)], 'recording held for review');
    // No push: a deferred review leaves the server copy untouched.
    assert.equal((await serverProject(PID)).recordings[0].name, 'rec one [SERVER]');
  });

  it('accepting a review adopts the incoming version and converges', async () => {
    const store = makeStore();
    let projects = await converge(store, [freshProject()]);
    await renameOnServer(PID, RID, 'rec one [SERVER]');
    projects = (await runCycle(store, projects)).projects; // raises the review

    const state = await loadSyncState(store);
    assert.equal(itemKind(state, unitRef(PID, RID)), 'review');
    const res = acceptReview(state, projects, unitRef(PID, RID));
    assert.equal(res.ok, true);
    await saveSyncState(store, state);
    projects = res.projects;

    assert.equal(recName(projects, PID, RID), 'rec one [SERVER]', 'local adopted incoming');
    assert.equal(itemKind(await loadSyncState(store), unitRef(PID, RID)), null, 'review cleared');

    const c = await runCycle(store, projects);
    assert.deepEqual(c.result.review, []);
    assert.deepEqual(c.result.conflicts, []);
    assert.deepEqual(c.result.pushed, []);
  });

  it('declining a review keeps local, never pushes, and does not re-offer the same incoming', async () => {
    const store = makeStore();
    let projects = await converge(store, [freshProject()]);
    await renameOnServer(PID, RID, 'rec one [SERVER]');
    projects = (await runCycle(store, projects)).projects; // raises the review

    const state = await loadSyncState(store);
    const res = declineReview(state, projects, unitRef(PID, RID));
    assert.equal(res.ok, true);
    await saveSyncState(store, state);
    projects = res.projects;

    assert.equal(recName(projects, PID, RID), 'rec one', 'local kept');
    assert.equal(itemKind(await loadSyncState(store), unitRef(PID, RID)), null, 'review cleared');

    // Re-syncing does NOT re-raise a review for the same (declined) incoming.
    const c = await runCycle(store, projects);
    assert.deepEqual(c.result.review, [], 'declined incoming is not re-offered');
    assert.deepEqual(c.result.conflicts, []);
  });

  it('both sides change the same recording → CONFLICT; resolving to server converges', async () => {
    const store = makeStore();
    let projects = await converge(store, [freshProject()]);

    // Local edit + a DIFFERENT server edit to the same recording.
    projects = deep(projects);
    projects.find((p) => p.project_id === PID).recordings[0].name = 'rec one [LOCAL]';
    await renameOnServer(PID, RID, 'rec one [SERVER]');

    const c = await runCycle(store, projects);
    assert.deepEqual(c.result.review, []);
    assert.deepEqual(c.result.conflicts, [unitRef(PID, RID)], 'two-sided change is a conflict');

    // Resolve to the server (incoming) version.
    const state = await loadSyncState(store);
    const item = state.conflicts[unitRef(PID, RID)];
    const res = resolveConflict(state, c.projects, unitRef(PID, RID), item.incoming);
    assert.equal(res.ok, true);
    await saveSyncState(store, state);
    projects = res.projects;
    assert.equal(recName(projects, PID, RID), 'rec one [SERVER]');

    const c2 = await runCycle(store, projects);
    assert.deepEqual(c2.result.conflicts, []);
    assert.deepEqual(c2.result.pushed, [], 'resolved-to-server needs no push');
  });

  it('resolving a conflict to LOCAL pushes the local version up on the next cycle (#3)', async () => {
    const store = makeStore();
    let projects = await converge(store, [freshProject()]);

    projects = deep(projects);
    projects.find((p) => p.project_id === PID).recordings[0].name = 'rec one [LOCAL]';
    await renameOnServer(PID, RID, 'rec one [SERVER]');
    const c = await runCycle(store, projects); // conflict
    assert.deepEqual(c.result.conflicts, [unitRef(PID, RID)]);

    // Resolve to keep LOCAL.
    const state = await loadSyncState(store);
    const item = state.conflicts[unitRef(PID, RID)];
    const res = resolveConflict(state, c.projects, unitRef(PID, RID), item.local);
    assert.equal(res.ok, true);
    await saveSyncState(store, state);
    projects = res.projects;
    assert.equal(recName(projects, PID, RID), 'rec one [LOCAL]');

    // Resolution pushes nothing itself; the NEXT cycle pushes local up.
    const c2 = await runCycle(store, projects);
    assert.ok(c2.result.pushed.includes(PID), 'kept-local version is pushed next cycle');
    assert.equal(
      (await serverProject(PID)).recordings[0].name,
      'rec one [LOCAL]',
      'server now holds the local version',
    );
  });

  it('delete-vs-change is a CONFLICT; accept-the-deletion removes the recording (#4)', async () => {
    const store = makeStore();
    // Two recordings so deleting one leaves a valid project.
    const base = freshProject();
    base.recordings.push({ ...deep(base.recordings[0]), recording_id: RID2, name: 'rec two' });
    let projects = await converge(store, [base]);

    // Local DELETES rec two; server CHANGES rec two → delete-vs-change.
    projects = deep(projects);
    const proj = projects.find((p) => p.project_id === PID);
    proj.recordings = proj.recordings.filter((r) => r.recording_id !== RID2);
    await renameOnServer(PID, RID2, 'rec two [SERVER]');

    const c = await runCycle(store, projects);
    assert.deepEqual(
      c.result.conflicts,
      [unitRef(PID, RID2)],
      'delete-vs-change on rec two is a conflict',
    );

    // Accept the deletion (the DELETE_RESOLUTION sentinel).
    const state = await loadSyncState(store);
    const res = resolveConflict(state, c.projects, unitRef(PID, RID2), DELETE_RESOLUTION);
    assert.equal(res.ok, true);
    await saveSyncState(store, state);
    projects = res.projects;
    const recIds = projects.find((p) => p.project_id === PID).recordings.map((r) => r.recording_id);
    assert.ok(!recIds.includes(RID2), 'deleted recording stays deleted after resolution');
  });

  it('a project from another platform is SKIPPED and reported, never turned into a conflict', async () => {
    const store = makeStore();

    // Seed a desktop-windows project directly on the server.
    const desktopProject = {
      docent_format: { platform: 'desktop-windows', schema_version: '1.0.0' },
      project: {
        project_id: '019ed000-0000-7000-8000-0000000000ff',
        name: 'Desktop thing',
        created_at: '2026-06-01T00:00:00.000Z',
      },
      recordings: [],
    };
    const seed = await request(server.baseUrl, 'POST', '/__debug/seed', { body: [desktopProject] });
    assert.equal(seed.body.seeded, 1);

    const c = await runCycle(store, []);
    assert.deepEqual(c.result.conflicts, [], 'a stamp mismatch is never a conflict');
    assert.deepEqual(c.result.review, [], 'a stamp mismatch is never a review');
    assert.equal(c.result.mismatched.length, 1, 'reported as a skipped/mismatched project');
  });
});
