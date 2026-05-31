/**
 * sync-interruption.test.js — Sync protocol network-interruption & conflict
 * edge cases (#86).
 *
 * Complements sync-client.test.js (happy paths + auth failures) with the
 * partial-failure and conflict scenarios: connection drop mid-push, timeout
 * during pull, accurate per-project success/failure reporting, and concurrent
 * sync not producing duplicate projects.
 *
 * Determinism: failures are injected through a mocked `globalThis.fetch` (the
 * established pattern in sync-client.test.js) — connection drops are modelled
 * as a rejected fetch, timeouts as a rejected fetch after an awaited tick. No
 * real sockets, no wall-clock thresholds, so nothing here is timing-flaky.
 *
 * Validates: #86 acceptance criteria.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sync, pushProjects, pullProjects } from '../../sync-client.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(id, name, recordings = []) {
  return {
    project_id: id,
    name: name ?? `Project ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    recordings,
  };
}

let fetchCalls = [];

function mockFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return handler(url, options);
  };
}

function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

/** A rejected fetch — models a dropped connection / DNS failure. */
function connectionDrop(message = 'socket hang up') {
  return Promise.reject(new Error(message));
}

/**
 * A fetch that rejects only after yielding to the event loop — models a
 * request that begins, hangs, and then errors (a timeout) without using any
 * real timer or wall-clock threshold.
 */
async function timeoutAfterStart(message = 'request timed out') {
  await Promise.resolve(); // let the request "begin"
  throw new Error(message);
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Partial push failure ───────────────────────────────────────────────────

describe('#86 partial push failure preserves local state and reports accurately', () => {
  it('connection drop on the 2nd of 3 projects: other two push, local state untouched', async () => {
    const local = [makeProject('p1'), makeProject('p2'), makeProject('p3')];
    const localSnapshot = JSON.parse(JSON.stringify(local));

    mockFetch((url) => {
      if (url.endsWith('/projects/p2')) return connectionDrop();
      return makeResponse(200, { ok: true });
    });

    const result = await pushProjects('https://srv.test', null, local);

    // p1 and p3 pushed; p2 recorded as a network error (status null).
    assert.deepEqual(result.pushed, ['p1', 'p3']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, null, 'connection drop is a network error (null status)');
    assert.equal(result.errors[0].projectName, 'Project p2');
    assert.equal(result.halted, false, 'a non-auth failure does not halt the push');

    // Local state must be byte-for-byte unchanged by a failed push.
    assert.deepEqual(local, localSnapshot, 'push must not mutate local projects');
  });

  it('sync result reports exactly which projects succeeded and which failed', async () => {
    const local = [makeProject('ok1'), makeProject('bad'), makeProject('ok2')];

    mockFetch((url, opts) => {
      // Push phase (PUT). Fail only "bad". Pull manifest is empty.
      if (opts.method === 'PUT') {
        if (url.endsWith('/projects/bad')) return makeResponse(500);
        return makeResponse(200, { ok: true });
      }
      // Pull manifest → empty (nothing to pull back).
      return makeResponse(200, []);
    });

    const { result, projects } = await sync('https://srv.test', null, local);

    assert.deepEqual(result.pushed, ['ok1', 'ok2'], 'only successful pushes are reported');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 500);
    assert.equal(result.errors[0].projectName, 'Project bad');
    assert.equal(result.halted, false);
    // Local projects preserved through the cycle (empty pull merges nothing).
    assert.equal(projects.length, 3);
  });
});

// ─── Pull interruption ────────────────────────────────────────────────────────

describe('#86 pull interruption does not corrupt already-pulled projects', () => {
  it('timeout on the 2nd project keeps the 1st and 3rd, reports the failure', async () => {
    const manifest = [
      { project_id: 'a', name: 'A', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: 'b', name: 'B', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: 'c', name: 'C', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const payload = (id) => ({
      project: { project_id: id, name: id.toUpperCase(), created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    });

    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith('/projects/b')) return timeoutAfterStart();
      if (url.endsWith('/projects/a')) return makeResponse(200, payload('a'));
      if (url.endsWith('/projects/c')) return makeResponse(200, payload('c'));
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null);

    // a and c pulled cleanly; b reported as a network error; not halted.
    assert.equal(result.projects.length, 2);
    assert.deepEqual(result.projects.map((p) => p.project_id).sort(), ['a', 'c']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, null);
    assert.equal(result.errors[0].projectName, 'B');
    assert.equal(result.halted, false);
  });

  it('manifest fetch timeout yields zero projects, not a crash', async () => {
    mockFetch((url) => {
      if (url.endsWith('/projects')) return timeoutAfterStart('manifest timed out');
      return makeResponse(200, {});
    });

    const result = await pullProjects('https://srv.test', null);

    assert.equal(result.projects.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, null);
    assert.equal(
      result.halted,
      false,
      'a network timeout on the manifest is recoverable, not halted',
    );
  });
});

// ─── Conflict / concurrency ────────────────────────────────────────────────────

describe('#86 conflict and concurrency edge cases', () => {
  it('server-wins: a pulled project with the same id replaces the local one (no duplicate)', async () => {
    const local = [makeProject('shared', 'Local name')];

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects')) {
        return makeResponse(200, [
          { project_id: 'shared', name: 'Server name', last_modified: '2026-02-02T00:00:00.000Z' },
        ]);
      }
      if (url.endsWith('/projects/shared')) {
        return makeResponse(200, {
          project: {
            project_id: 'shared',
            name: 'Server name',
            created_at: '2026-01-01T00:00:00.000Z',
          },
          recordings: [],
        });
      }
      return makeResponse(404);
    });

    const { result, projects } = await sync('https://srv.test', null, local);

    // Exactly one project with id "shared" — replaced, not duplicated.
    const shared = projects.filter((p) => p.project_id === 'shared');
    assert.equal(shared.length, 1, 'same project_id must not produce a duplicate');
    assert.equal(shared[0].name, 'Server name', 'server-wins replaces local copy');
    assert.deepEqual(result.pulled, ['shared']);
  });

  it('two concurrent sync cycles do not produce duplicate projects in either result', async () => {
    const serverManifest = [
      { project_id: 'remote1', name: 'Remote 1', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const remotePayload = {
      project: { project_id: 'remote1', name: 'Remote 1', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    };

    // Stateless mock server — safe to serve two interleaved syncs.
    globalThis.fetch = async (url, options) => {
      if (options.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects')) return makeResponse(200, serverManifest);
      if (url.endsWith('/projects/remote1')) return makeResponse(200, remotePayload);
      return makeResponse(404);
    };

    const localA = [makeProject('localA')];
    const localB = [makeProject('localB')];

    // Fire two sync cycles concurrently against the same server state.
    const [a, b] = await Promise.all([
      sync('https://srv.test', null, localA),
      sync('https://srv.test', null, localB),
    ]);

    for (const { projects } of [a, b]) {
      const ids = projects.map((p) => p.project_id);
      const unique = new Set(ids);
      assert.equal(ids.length, unique.size, `no duplicate project_ids: got ${ids.join(', ')}`);
      assert.ok(ids.includes('remote1'), 'each sync pulled the remote project');
    }
    // Each sync kept its own local project distinct.
    assert.ok(a.projects.some((p) => p.project_id === 'localA'));
    assert.ok(b.projects.some((p) => p.project_id === 'localB'));
  });
});
