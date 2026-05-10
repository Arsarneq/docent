/**
 * sync-client.test.js — Unit tests for the shared sync-client module.
 *
 * Tests pushProjects, pullProjects, and sync functions with mocked fetch.
 * Uses Node.js built-in test runner and fast-check for property-based tests.
 *
 * Validates: Requirements R2, R3, R7, R8, R9
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  SyncError,
  sync,
  pushProjects,
  pullProjects,
  buildHeaders,
  buildPayloadForProject,
} from '../sync-client.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a minimal valid project object. */
function makeProject(id, name, recordings = []) {
  return {
    project_id: id,
    name: name ?? `Project ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    recordings,
  };
}

/** Creates a minimal recording object. */
function makeRecording(id, steps = []) {
  return {
    recording_id: id,
    name: `Recording ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    steps,
  };
}

/** Tracks fetch calls for assertions. */
let fetchCalls = [];

/** Installs a mock fetch on globalThis. */
function mockFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return handler(url, options);
  };
}

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── pushProjects ─────────────────────────────────────────────────────────────

describe('pushProjects', () => {
  it('sends PUT for each project with correct URL path /projects/:id', async () => {
    const projects = [makeProject('aaa'), makeProject('bbb'), makeProject('ccc')];
    mockFetch(() => makeResponse(200, { ok: true }));

    await pushProjects('https://srv.test', null, projects);

    assert.equal(fetchCalls.length, 3);
    assert.equal(fetchCalls[0].url, 'https://srv.test/projects/aaa');
    assert.equal(fetchCalls[1].url, 'https://srv.test/projects/bbb');
    assert.equal(fetchCalls[2].url, 'https://srv.test/projects/ccc');
    for (const call of fetchCalls) {
      assert.equal(call.options.method, 'PUT');
    }
  });

  /**
   * Property-based test: pushProjects payload matches Full_Project_Payload shape.
   * Validates: Requirements R2
   */
  it('payload matches Full_Project_Payload shape (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          project_id: fc.uuid(),
          name: fc.string({ minLength: 1, maxLength: 50 }),
          created_at: fc.constant('2026-01-01T00:00:00.000Z'),
          metadata: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()), { nil: undefined }),
          recordings: fc.array(
            fc.record({
              recording_id: fc.uuid(),
              name: fc.string({ minLength: 1, maxLength: 50 }),
              created_at: fc.constant('2026-01-01T00:00:00.000Z'),
              metadata: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()), { nil: undefined }),
              steps: fc.array(fc.record({ action: fc.string() }), { maxLength: 3 }),
            }),
            { maxLength: 3 }
          ),
        }),
        async (project) => {
          let capturedBody;
          mockFetch((_url, opts) => {
            capturedBody = JSON.parse(opts.body);
            return makeResponse(200, { ok: true });
          });

          await pushProjects('https://srv.test', null, [project]);

          // Verify Full_Project_Payload shape
          assert.ok(capturedBody.project, 'payload must have .project');
          assert.ok(Array.isArray(capturedBody.recordings), 'payload must have .recordings array');
          assert.equal(capturedBody.project.project_id, project.project_id);
          assert.equal(capturedBody.project.name, project.name);
          assert.equal(capturedBody.project.created_at, project.created_at);

          // Recordings match
          assert.equal(capturedBody.recordings.length, (project.recordings ?? []).length);
          for (let i = 0; i < capturedBody.recordings.length; i++) {
            const sent = capturedBody.recordings[i];
            const orig = project.recordings[i];
            assert.equal(sent.recording_id, orig.recording_id);
            assert.equal(sent.name, orig.name);
            assert.ok(Array.isArray(sent.steps), 'recording must have .steps array');
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it('includes Authorization header when apiKey provided', async () => {
    mockFetch(() => makeResponse(200, { ok: true }));
    await pushProjects('https://srv.test', 'my-secret-key', [makeProject('p1')]);

    assert.equal(fetchCalls[0].options.headers['Authorization'], 'Bearer my-secret-key');
  });

  it('omits Authorization header when apiKey is null', async () => {
    mockFetch(() => makeResponse(200, { ok: true }));
    await pushProjects('https://srv.test', null, [makeProject('p1')]);

    assert.equal(fetchCalls[0].options.headers['Authorization'], undefined);
  });

  it('returns pushed project_ids on 2xx responses', async () => {
    const projects = [makeProject('id1'), makeProject('id2')];
    mockFetch(() => makeResponse(201, { ok: true }));

    const result = await pushProjects('https://srv.test', null, projects);

    assert.deepEqual(result.pushed, ['id1', 'id2']);
    assert.equal(result.errors.length, 0);
  });

  it('collects SyncError for non-2xx responses without stopping other projects', async () => {
    const projects = [makeProject('ok1'), makeProject('fail1'), makeProject('ok2')];
    let callIndex = 0;
    mockFetch(() => {
      callIndex++;
      if (callIndex === 2) return makeResponse(500);
      return makeResponse(200, { ok: true });
    });

    const result = await pushProjects('https://srv.test', null, projects);

    assert.deepEqual(result.pushed, ['ok1', 'ok2']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 500);
    assert.equal(result.errors[0].projectName, 'Project fail1');
    assert.equal(result.halted, false);
  });

  it('Content-Type header is application/json on PUT requests', async () => {
    mockFetch(() => makeResponse(200, { ok: true }));
    await pushProjects('https://srv.test', null, [makeProject('p1')]);

    assert.equal(fetchCalls[0].options.headers['Content-Type'], 'application/json');
  });
});

// ─── pullProjects ─────────────────────────────────────────────────────────────

describe('pullProjects', () => {
  it('fetches manifest then each project by id', async () => {
    const manifest = [
      { project_id: 'x1', name: 'X1', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: 'x2', name: 'X2', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const payloads = {
      x1: { project: { project_id: 'x1', name: 'X1', created_at: '2026-01-01T00:00:00.000Z' }, recordings: [] },
      x2: { project: { project_id: 'x2', name: 'X2', created_at: '2026-01-01T00:00:00.000Z' }, recordings: [] },
    };

    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith('/projects/x1')) return makeResponse(200, payloads.x1);
      if (url.endsWith('/projects/x2')) return makeResponse(200, payloads.x2);
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null);

    // First call is manifest, then one per project
    assert.equal(fetchCalls.length, 3);
    assert.ok(fetchCalls[0].url.endsWith('/projects'));
    assert.ok(fetchCalls[1].url.endsWith('/projects/x1'));
    assert.ok(fetchCalls[2].url.endsWith('/projects/x2'));
    assert.equal(result.projects.length, 2);
    assert.equal(result.projects[0].project_id, 'x1');
    assert.equal(result.projects[1].project_id, 'x2');
  });
});

// ─── sync ─────────────────────────────────────────────────────────────────────

describe('sync', () => {
  it('merges pulled projects — same project_id replaces local (server-wins)', async () => {
    const localProjects = [makeProject('shared-id', 'Local Version', [makeRecording('r1')])];
    const manifest = [{ project_id: 'shared-id', name: 'Server Version', last_modified: '2026-06-01T00:00:00.000Z' }];
    const serverPayload = {
      project: { project_id: 'shared-id', name: 'Server Version', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [{ recording_id: 'r-server', name: 'Server Rec', created_at: '2026-01-01T00:00:00.000Z', steps: [] }],
    };

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith('/projects/shared-id')) return makeResponse(200, serverPayload);
      return makeResponse(404);
    });

    const { projects } = await sync('https://srv.test', null, localProjects);

    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'Server Version');
    assert.equal(projects[0].recordings[0].recording_id, 'r-server');
  });

  it('merges pulled projects — new project_id appended', async () => {
    const localProjects = [makeProject('local-only')];
    const manifest = [{ project_id: 'server-new', name: 'New From Server', last_modified: '2026-06-01T00:00:00.000Z' }];
    const serverPayload = {
      project: { project_id: 'server-new', name: 'New From Server', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    };

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith('/projects/server-new')) return makeResponse(200, serverPayload);
      return makeResponse(404);
    });

    const { projects } = await sync('https://srv.test', null, localProjects);

    assert.equal(projects.length, 2);
    assert.equal(projects[0].project_id, 'local-only');
    assert.equal(projects[1].project_id, 'server-new');
  });

  it('executes push before pull (push fetch calls precede pull fetch calls)', async () => {
    const localProjects = [makeProject('p1')];
    const manifest = [{ project_id: 'srv1', name: 'Srv1', last_modified: '2026-01-01T00:00:00.000Z' }];
    const serverPayload = {
      project: { project_id: 'srv1', name: 'Srv1', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    };

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith('/projects/srv1')) return makeResponse(200, serverPayload);
      return makeResponse(404);
    });

    await sync('https://srv.test', null, localProjects);

    // First call should be the PUT (push), then GET /projects (pull manifest)
    assert.equal(fetchCalls[0].options.method, 'PUT');
    assert.ok(fetchCalls[0].url.includes('/projects/p1'));
    assert.equal(fetchCalls[1].options.method, 'GET');
    assert.ok(fetchCalls[1].url.endsWith('/projects'));
  });

  it('401 on push halts sync, returns halted=true', async () => {
    const localProjects = [makeProject('p1')];

    mockFetch(() => makeResponse(401));

    const { result, projects } = await sync('https://srv.test', 'bad-key', localProjects);

    assert.equal(result.halted, true);
    assert.equal(result.pushed.length, 0);
    assert.equal(result.pulled.length, 0);
    // Projects unchanged
    assert.deepEqual(projects, localProjects);
    // No pull calls should have been made (only 1 push call)
    assert.equal(fetchCalls.length, 1);
  });

  it('403 on pull manifest halts sync, returns halted=true', async () => {
    const localProjects = [makeProject('p1')];

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      // Pull manifest returns 403
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(403);
      return makeResponse(404);
    });

    const { result, projects } = await sync('https://srv.test', 'key', localProjects);

    assert.equal(result.halted, true);
    assert.deepEqual(result.pushed, ['p1']);
    assert.equal(result.pulled.length, 0);
    assert.deepEqual(projects, localProjects);
  });

  it('network error (fetch throws) produces SyncError with null status', async () => {
    const localProjects = [makeProject('p1')];

    mockFetch(() => {
      throw new Error('Network unreachable');
    });

    const { result } = await sync('https://srv.test', null, localProjects);

    assert.equal(result.errors.length >= 1, true);
    const networkErr = result.errors.find(e => e.status === null);
    assert.ok(networkErr, 'should have a SyncError with null status');
    assert.ok(networkErr instanceof SyncError);
    assert.equal(networkErr.status, null);
  });
});
