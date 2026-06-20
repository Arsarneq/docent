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
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sync, pushProjects, pullProjects } from '../../sync-client.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(id, name, recordings = []) {
  return {
    project_id: id,
    name: name ?? `Project ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    recordings,
  };
}

/** Permissive stub validator — these tests exercise sync mechanics, not schema validation. */
function passValidator() {
  return true;
}
passValidator.errors = [];

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

    const result = await pushProjects('https://srv.test', null, local, STUB_SCHEMA);

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

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      local,
      STUB_SCHEMA,
      passValidator,
    );

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
    const A = '0190a1b2-0000-7000-8000-0000000000aa';
    const B = '0190a1b2-0000-7000-8000-0000000000bb';
    const C = '0190a1b2-0000-7000-8000-0000000000cc';
    const manifest = [
      { project_id: A, name: 'A', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: B, name: 'B', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: C, name: 'C', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const payload = (id) => ({
      project: { project_id: id, name: 'P', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    });

    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${B}`)) return timeoutAfterStart();
      if (url.endsWith(`/projects/${A}`)) return makeResponse(200, payload(A));
      if (url.endsWith(`/projects/${C}`)) return makeResponse(200, payload(C));
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null, passValidator);

    // a and c pulled cleanly; b reported as a network error; not halted.
    assert.equal(result.projects.length, 2);
    assert.deepEqual(result.projects.map((p) => p.project_id).sort(), [A, C].sort());
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

    const result = await pullProjects('https://srv.test', null, passValidator);

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
    const SHARED = '0190a1b2-0000-7000-8000-0000000000e1';
    const local = [makeProject(SHARED, 'Local name')];

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects')) {
        return makeResponse(200, [
          { project_id: SHARED, name: 'Server name', last_modified: '2026-02-02T00:00:00.000Z' },
        ]);
      }
      if (url.endsWith(`/projects/${SHARED}`)) {
        return makeResponse(200, {
          docent_format: { platform: 'stub', schema_version: '0.0.0-stub' },
          project: {
            project_id: SHARED,
            name: 'Server name',
            created_at: '2026-01-01T00:00:00.000Z',
          },
          recordings: [],
        });
      }
      return makeResponse(404);
    });

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      local,
      STUB_SCHEMA,
      passValidator,
    );

    // Exactly one project with the shared id — replaced, not duplicated.
    const shared = projects.filter((p) => p.project_id === SHARED);
    assert.equal(shared.length, 1, 'same project_id must not produce a duplicate');
    assert.equal(shared[0].name, 'Server name', 'server-wins replaces local copy');
    assert.deepEqual(result.pulled, [SHARED]);
  });

  it('two concurrent sync cycles do not produce duplicate projects in either result', async () => {
    const REMOTE1 = '0190a1b2-0000-7000-8000-0000000000f1';
    const serverManifest = [
      { project_id: REMOTE1, name: 'Remote 1', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const remotePayload = {
      docent_format: { platform: 'stub', schema_version: '0.0.0-stub' },
      project: { project_id: REMOTE1, name: 'Remote 1', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    };

    // Stateless mock server — safe to serve two interleaved syncs.
    globalThis.fetch = async (url, options) => {
      if (options.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects')) return makeResponse(200, serverManifest);
      if (url.endsWith(`/projects/${REMOTE1}`)) return makeResponse(200, remotePayload);
      return makeResponse(404);
    };

    const localA = [makeProject('localA')];
    const localB = [makeProject('localB')];

    // Fire two sync cycles concurrently against the same server state.
    const [a, b] = await Promise.all([
      sync('https://srv.test', null, localA, STUB_SCHEMA, passValidator),
      sync('https://srv.test', null, localB, STUB_SCHEMA, passValidator),
    ]);

    for (const { projects } of [a, b]) {
      const ids = projects.map((p) => p.project_id);
      const unique = new Set(ids);
      assert.equal(ids.length, unique.size, `no duplicate project_ids: got ${ids.join(', ')}`);
      assert.ok(ids.includes(REMOTE1), 'each sync pulled the remote project');
    }
    // Each sync kept its own local project distinct.
    assert.ok(a.projects.some((p) => p.project_id === 'localA'));
    assert.ok(b.projects.some((p) => p.project_id === 'localB'));
  });
});

// ─── project_id URL encoding + manifest validation ──────────────────────

describe('sync URL safety', () => {
  it('encodeURIComponent is applied to project_id on push', async () => {
    // A push payload built from a project whose id contains URL-significant
    // characters must not be able to reshape the request path.
    const weird = makeProject('a/b?c#d', 'Weird');
    mockFetch(() => makeResponse(200, { ok: true }));

    await pushProjects('https://srv.test', null, [weird], STUB_SCHEMA);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://srv.test/projects/a%2Fb%3Fc%23d');
  });

  it('pull skips manifest entries whose project_id is not a valid UUIDv7', async () => {
    const manifest = [
      { project_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', name: 'Good' },
      { project_id: '../../admin', name: 'Evil path' },
      { project_id: 12345, name: 'Wrong type' },
    ];
    const good = {
      project: {
        project_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        name: 'Good',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [],
    };

    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith('/projects/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')) {
        return makeResponse(200, good);
      }
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null, passValidator);

    // Only the valid project is fetched + returned; the two bad ids are skipped
    // (never interpolated into a request URL) and reported as errors.
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].project_id, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    assert.equal(result.errors.length, 2);
    // The only project fetch made was for the good id — no request for the
    // malicious path segment.
    const fetchedPaths = fetchCalls.map((c) => c.url);
    assert.ok(!fetchedPaths.some((u) => u.includes('admin')));
  });
});
