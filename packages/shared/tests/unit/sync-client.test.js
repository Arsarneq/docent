/**
 * sync-client.test.js — Unit tests for the shared sync-client module.
 *
 * Tests pushProjects, pullProjects, and sync functions with mocked fetch.
 * Uses Node.js built-in test runner and fast-check for property-based tests.
 *
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
} from '../../sync-client.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

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

/** Permissive stub validator — these tests exercise sync mechanics, not schema validation. */
function passValidator() {
  return true;
}
passValidator.errors = [];

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

    await pushProjects('https://srv.test', null, projects, STUB_SCHEMA);

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
   */
  it('payload matches Full_Project_Payload shape (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          project_id: fc.uuid(),
          name: fc.string({ minLength: 1, maxLength: 50 }),
          created_at: fc.constant('2026-01-01T00:00:00.000Z'),
          metadata: fc.option(
            fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
            { nil: undefined },
          ),
          recordings: fc.array(
            fc.record({
              recording_id: fc.uuid(),
              name: fc.string({ minLength: 1, maxLength: 50 }),
              created_at: fc.constant('2026-01-01T00:00:00.000Z'),
              metadata: fc.option(
                fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
                { nil: undefined },
              ),
              steps: fc.array(fc.record({ action: fc.string() }), { maxLength: 3 }),
            }),
            { maxLength: 3 },
          ),
        }),
        async (project) => {
          let capturedBody;
          mockFetch((_url, opts) => {
            capturedBody = JSON.parse(opts.body);
            return makeResponse(200, { ok: true });
          });

          await pushProjects('https://srv.test', null, [project], STUB_SCHEMA);

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
        },
      ),
      { numRuns: 20 },
    );
  });

  it('includes Authorization header when apiKey provided', async () => {
    mockFetch(() => makeResponse(200, { ok: true }));
    await pushProjects('https://srv.test', 'my-secret-key', [makeProject('p1')], STUB_SCHEMA);

    assert.equal(fetchCalls[0].options.headers['Authorization'], 'Bearer my-secret-key');
  });

  it('omits Authorization header when apiKey is null', async () => {
    mockFetch(() => makeResponse(200, { ok: true }));
    await pushProjects('https://srv.test', null, [makeProject('p1')], STUB_SCHEMA);

    assert.equal(fetchCalls[0].options.headers['Authorization'], undefined);
  });

  it('returns pushed project_ids on 2xx responses', async () => {
    const projects = [makeProject('id1'), makeProject('id2')];
    mockFetch(() => makeResponse(201, { ok: true }));

    const result = await pushProjects('https://srv.test', null, projects, STUB_SCHEMA);

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

    const result = await pushProjects('https://srv.test', null, projects, STUB_SCHEMA);

    assert.deepEqual(result.pushed, ['ok1', 'ok2']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 500);
    assert.equal(result.errors[0].projectName, 'Project fail1');
    assert.equal(result.halted, false);
  });

  it('Content-Type header is application/json on PUT requests', async () => {
    mockFetch(() => makeResponse(200, { ok: true }));
    await pushProjects('https://srv.test', null, [makeProject('p1')], STUB_SCHEMA);

    assert.equal(fetchCalls[0].options.headers['Content-Type'], 'application/json');
  });
});

// ─── buildHeaders ─────────────────────────────────────────────────────────────

describe('buildHeaders', () => {
  it('returns empty object when apiKey is null', () => {
    const headers = buildHeaders(null);
    assert.deepEqual(headers, {});
  });

  it('returns empty object when apiKey is empty string', () => {
    const headers = buildHeaders('');
    assert.deepEqual(headers, {});
  });

  it('returns Authorization header when apiKey is provided', () => {
    const headers = buildHeaders('my-key');
    assert.equal(headers['Authorization'], 'Bearer my-key');
  });
});

// ─── buildPayloadForProject ───────────────────────────────────────────────────

describe('buildPayloadForProject', () => {
  it('builds correct shape with metadata', () => {
    const project = {
      ...makeProject('p1', 'Test'),
      metadata: { env: 'prod' },
      recordings: [
        { ...makeRecording('r1', [{ action: 'click' }]), metadata: { browser: 'chrome' } },
      ],
    };
    const payload = buildPayloadForProject(project, STUB_SCHEMA);
    assert.equal(payload.project.project_id, 'p1');
    assert.deepEqual(payload.project.metadata, { env: 'prod' });
    assert.equal(payload.recordings[0].recording_id, 'r1');
    assert.deepEqual(payload.recordings[0].metadata, { browser: 'chrome' });
    assert.deepEqual(payload.recordings[0].steps, [{ action: 'click' }]);
  });

  it('omits metadata when not present', () => {
    const project = makeProject('p1', 'Test');
    const payload = buildPayloadForProject(project, STUB_SCHEMA);
    assert.equal(payload.project.metadata, undefined);
  });

  it('handles project with no recordings', () => {
    const project = makeProject('p1', 'Empty');
    const payload = buildPayloadForProject(project, STUB_SCHEMA);
    assert.deepEqual(payload.recordings, []);
  });

  it('handles recording with no steps', () => {
    const project = { ...makeProject('p1'), recordings: [makeRecording('r1')] };
    const payload = buildPayloadForProject(project, STUB_SCHEMA);
    assert.deepEqual(payload.recordings[0].steps, []);
  });
});

// ─── pullProjects ─────────────────────────────────────────────────────────────

describe('pullProjects', () => {
  it('fetches manifest then each project by id', async () => {
    const X1 = '0190a1b2-0000-7000-8000-000000000001';
    const X2 = '0190a1b2-0000-7000-8000-000000000002';
    const manifest = [
      { project_id: X1, name: 'X1', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: X2, name: 'X2', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const payloads = {
      x1: {
        project: { project_id: X1, name: 'X1', created_at: '2026-01-01T00:00:00.000Z' },
        recordings: [],
      },
      x2: {
        project: { project_id: X2, name: 'X2', created_at: '2026-01-01T00:00:00.000Z' },
        recordings: [],
      },
    };

    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${X1}`)) return makeResponse(200, payloads.x1);
      if (url.endsWith(`/projects/${X2}`)) return makeResponse(200, payloads.x2);
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null, passValidator);

    // First call is manifest, then one per project
    assert.equal(fetchCalls.length, 3);
    assert.ok(fetchCalls[0].url.endsWith('/projects'));
    assert.ok(fetchCalls[1].url.endsWith(`/projects/${X1}`));
    assert.ok(fetchCalls[2].url.endsWith(`/projects/${X2}`));
    assert.equal(result.projects.length, 2);
    assert.equal(result.projects[0].project_id, X1);
    assert.equal(result.projects[1].project_id, X2);
  });

  it("issues every GET with cache: 'no-store' so the webview fetch can't serve a stale payload", async () => {
    // Regression: the extension transport is the browser's `fetch`. With a server
    // that sends an ETag but no Cache-Control (the reference server, and adopter
    // servers), the browser would serve a STALE cached project — the client then
    // sees already-converged and silently drops an incoming change/review. Every
    // GET (manifest + per-project) must opt out of the HTTP cache.
    const ID = '0190a1b2-0000-7000-8000-000000000009';
    const manifest = [{ project_id: ID, name: 'P', last_modified: '2026-01-01T00:00:00.000Z' }];
    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${ID}`))
        return makeResponse(200, {
          project: { project_id: ID, name: 'P', created_at: '2026-01-01T00:00:00.000Z' },
          recordings: [],
        });
      return makeResponse(404);
    });

    await pullProjects('https://srv.test', null, passValidator);

    assert.ok(fetchCalls.length >= 2, 'manifest + at least one project fetch');
    for (const call of fetchCalls) {
      assert.equal(call.options.method, 'GET');
      assert.equal(call.options.cache, 'no-store', `GET ${call.url} must set cache: 'no-store'`);
    }
  });

  it('network error on manifest returns error with halted=false', async () => {
    mockFetch(() => {
      throw new Error('DNS resolution failed');
    });

    const result = await pullProjects('https://srv.test', null, passValidator);

    assert.equal(result.projects.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, null);
    assert.ok(result.errors[0].message.includes('DNS resolution failed'));
    assert.equal(result.halted, false);
  });

  it('non-auth non-ok manifest response returns error with halted=false', async () => {
    mockFetch(() => makeResponse(500));

    const result = await pullProjects('https://srv.test', null, passValidator);

    assert.equal(result.projects.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 500);
    assert.equal(result.halted, false);
  });

  it('auth error on manifest returns halted=true', async () => {
    mockFetch(() => makeResponse(401));

    const result = await pullProjects('https://srv.test', 'bad-key', passValidator);

    assert.equal(result.projects.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 401);
    assert.equal(result.halted, true);
  });

  it('network error on individual project fetch continues to next project', async () => {
    const P1 = '0190a1b2-0000-7000-8000-000000000011';
    const P2 = '0190a1b2-0000-7000-8000-000000000012';
    const manifest = [
      { project_id: P1, name: 'P1', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: P2, name: 'P2', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const p2Payload = {
      project: { project_id: P2, name: 'P2', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    };

    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${P1}`)) throw new Error('Connection reset');
      if (url.endsWith(`/projects/${P2}`)) return makeResponse(200, p2Payload);
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null, passValidator);

    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].project_id, P2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, null);
    assert.equal(result.errors[0].projectName, 'P1');
    assert.equal(result.halted, false);
  });

  it('non-ok response on individual project fetch continues to next project', async () => {
    const P1 = '0190a1b2-0000-7000-8000-000000000011';
    const P2 = '0190a1b2-0000-7000-8000-000000000012';
    const manifest = [
      { project_id: P1, name: 'P1', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: P2, name: 'P2', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const p2Payload = {
      project: { project_id: P2, name: 'P2', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    };

    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${P1}`)) return makeResponse(500);
      if (url.endsWith(`/projects/${P2}`)) return makeResponse(200, p2Payload);
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null, passValidator);

    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].project_id, P2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 500);
    assert.equal(result.errors[0].projectName, 'P1');
    assert.equal(result.halted, false);
  });

  it('auth error on individual project fetch halts entire pull', async () => {
    const P1 = '0190a1b2-0000-7000-8000-000000000011';
    const P2 = '0190a1b2-0000-7000-8000-000000000012';
    const manifest = [
      { project_id: P1, name: 'P1', last_modified: '2026-01-01T00:00:00.000Z' },
      { project_id: P2, name: 'P2', last_modified: '2026-01-01T00:00:00.000Z' },
    ];

    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${P1}`)) return makeResponse(403);
      return makeResponse(200, { project: {}, recordings: [] });
    });

    const result = await pullProjects('https://srv.test', 'key', passValidator);

    assert.equal(result.projects.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 403);
    assert.equal(result.halted, true);
    // p2 should NOT have been fetched
    assert.equal(fetchCalls.length, 2); // manifest + p1 only
  });

  it('includes Authorization header when apiKey provided', async () => {
    mockFetch(() => makeResponse(200, []));

    await pullProjects('https://srv.test', 'my-token', passValidator);

    assert.equal(fetchCalls[0].options.headers['Authorization'], 'Bearer my-token');
  });
});

// ─── pushProjects — additional error paths ────────────────────────────────────

describe('pushProjects — network errors', () => {
  it('network error on push collects SyncError with null status and continues', async () => {
    const projects = [makeProject('ok1'), makeProject('fail1'), makeProject('ok2')];
    let callIndex = 0;
    mockFetch(() => {
      callIndex++;
      if (callIndex === 2) throw new Error('Connection refused');
      return makeResponse(200, { ok: true });
    });

    const result = await pushProjects('https://srv.test', null, projects, STUB_SCHEMA);

    assert.deepEqual(result.pushed, ['ok1', 'ok2']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, null);
    assert.ok(result.errors[0].message.includes('Connection refused'));
    assert.equal(result.halted, false);
  });

  it('auth error on push halts immediately', async () => {
    const projects = [makeProject('p1'), makeProject('p2')];
    mockFetch(() => makeResponse(401));

    const result = await pushProjects('https://srv.test', 'bad-key', projects, STUB_SCHEMA);

    assert.equal(result.pushed.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].status, 401);
    assert.equal(result.halted, true);
    // Only 1 fetch call — halted after first project
    assert.equal(fetchCalls.length, 1);
  });
});

// ─── sync ─────────────────────────────────────────────────────────────────────

describe('sync', () => {
  it('merges pulled projects — same project_id replaces local (server-wins)', async () => {
    const SHARED = '0190a1b2-0000-7000-8000-0000000000a1';
    const localProjects = [makeProject(SHARED, 'Local Version', [makeRecording('r1')])];
    const manifest = [
      {
        project_id: SHARED,
        name: 'Server Version',
        last_modified: '2026-06-01T00:00:00.000Z',
      },
    ];
    const serverPayload = {
      docent_format: { platform: 'stub', schema_version: '0.0.0-stub' },
      project: {
        project_id: SHARED,
        name: 'Server Version',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [
        {
          recording_id: 'r-server',
          name: 'Server Rec',
          created_at: '2026-01-01T00:00:00.000Z',
          steps: [],
        },
      ],
    };

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${SHARED}`)) return makeResponse(200, serverPayload);
      return makeResponse(404);
    });

    const { projects } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'Server Version');
    assert.equal(projects[0].recordings[0].recording_id, 'r-server');
  });

  it('merges pulled projects — new project_id appended', async () => {
    const SERVER_NEW = '0190a1b2-0000-7000-8000-0000000000b2';
    const localProjects = [makeProject('local-only')];
    const manifest = [
      {
        project_id: SERVER_NEW,
        name: 'New From Server',
        last_modified: '2026-06-01T00:00:00.000Z',
      },
    ];
    const serverPayload = {
      docent_format: { platform: 'stub', schema_version: '0.0.0-stub' },
      project: {
        project_id: SERVER_NEW,
        name: 'New From Server',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [],
    };

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${SERVER_NEW}`)) return makeResponse(200, serverPayload);
      return makeResponse(404);
    });

    const { projects } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(projects.length, 2);
    assert.equal(projects[0].project_id, 'local-only');
    assert.equal(projects[1].project_id, SERVER_NEW);
  });

  it('executes pull before push (pull fetch calls precede the push PUT)', async () => {
    const SRV1 = '0190a1b2-0000-7000-8000-0000000000c1';
    const localProjects = [makeProject('p1')];
    const manifest = [
      { project_id: SRV1, name: 'Srv1', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    const serverPayload = {
      project: { project_id: SRV1, name: 'Srv1', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    };

    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${SRV1}`)) return makeResponse(200, serverPayload);
      return makeResponse(404);
    });

    await sync('https://srv.test', null, localProjects, STUB_SCHEMA, passValidator);

    // Pull-first order: the GET /projects manifest and per-project pull
    // GET come first; the PUT (push) runs only after pull + reconcile complete.
    assert.equal(fetchCalls[0].options.method, 'GET');
    assert.ok(fetchCalls[0].url.endsWith('/projects'));
    assert.equal(fetchCalls[1].options.method, 'GET');
    assert.ok(fetchCalls[1].url.endsWith(`/projects/${SRV1}`));
    const putCall = fetchCalls.find((c) => c.options.method === 'PUT');
    assert.ok(putCall, 'a PUT (push) request was issued after the pull');
    assert.ok(putCall.url.includes('/projects/p1'));
    // The push PUT is the LAST request — it never precedes a pull GET.
    assert.equal(fetchCalls[fetchCalls.length - 1].options.method, 'PUT');
  });

  it('401 on the pull manifest (the first request) halts sync before any push', async () => {
    const localProjects = [makeProject('p1')];

    mockFetch(() => makeResponse(401));

    const { result, projects } = await sync(
      'https://srv.test',
      'bad-key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(result.halted, true);
    assert.equal(result.pushed.length, 0);
    assert.equal(result.pulled.length, 0);
    // Projects unchanged
    assert.deepEqual(projects, localProjects);
    // Pull-first: the manifest GET is the first request and fails, so no push
    // is ever attempted (only the 1 manifest call).
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'GET');
  });

  it('401 on push halts sync after a successful pull+reconcile (nothing pushed)', async () => {
    const localProjects = [makeProject('p1')];

    // Pull manifest succeeds with an empty server (no per-project GETs); the
    // push PUT then returns 401. In pull-first order the push runs last, so the
    // pull and reconcile have already completed when the auth failure occurs.
    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(401);
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, []);
      return makeResponse(404);
    });

    const { result, projects } = await sync(
      'https://srv.test',
      'key',
      localProjects,
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(result.halted, true);
    assert.equal(result.haltReason, 'auth');
    assert.deepEqual(result.pushed, [], 'the push that returned 401 is not counted as pushed');
    assert.equal(result.pulled.length, 0);
    assert.deepEqual(projects, localProjects);
    // Order: GET /projects (manifest), then PUT /projects/p1 (the auth failure).
    assert.equal(fetchCalls[0].options.method, 'GET');
    assert.equal(fetchCalls[fetchCalls.length - 1].options.method, 'PUT');
  });

  it('network error (fetch throws) produces SyncError with null status', async () => {
    const localProjects = [makeProject('p1')];

    mockFetch(() => {
      throw new Error('Network unreachable');
    });

    const { result } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(result.errors.length >= 1, true);
    const networkErr = result.errors.find((e) => e.status === null);
    assert.ok(networkErr, 'should have a SyncError with null status');
    assert.ok(networkErr instanceof SyncError);
    assert.equal(networkErr.status, null);
  });

  it('push payload includes project and recording metadata', async () => {
    const project = {
      ...makeProject('meta-proj', 'Meta Project'),
      metadata: { ticket: 'PROJ-42', tags: ['smoke', 'login'] },
      recordings: [
        {
          ...makeRecording('meta-rec'),
          metadata: { env: 'staging' },
        },
      ],
    };

    let capturedBody;
    mockFetch((_url, opts) => {
      if (opts.method === 'PUT') {
        capturedBody = JSON.parse(opts.body);
      }
      if (_url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, []);
      return makeResponse(200, { ok: true });
    });

    await sync('https://srv.test', null, [project], STUB_SCHEMA, passValidator);

    assert.deepStrictEqual(capturedBody.project.metadata, {
      ticket: 'PROJ-42',
      tags: ['smoke', 'login'],
    });
    assert.deepStrictEqual(capturedBody.recordings[0].metadata, { env: 'staging' });
  });

  it('pulled project with metadata preserves metadata in merged result', async () => {
    const SRV_META = '0190a1b2-0000-7000-8000-0000000000d1';
    const localProjects = [];
    const manifest = [
      { project_id: SRV_META, name: 'Srv', last_modified: '2026-06-01T00:00:00.000Z' },
    ];
    const serverPayload = {
      docent_format: { platform: 'stub', schema_version: '0.0.0-stub' },
      project: {
        project_id: SRV_META,
        name: 'Srv',
        created_at: '2026-01-01T00:00:00.000Z',
        metadata: { team: 'QA', sprint: '24' },
      },
      recordings: [
        {
          recording_id: 'r1',
          name: 'Flow',
          created_at: '2026-01-01T00:00:00.000Z',
          metadata: { browser: 'chrome' },
          steps: [],
        },
      ],
    };

    mockFetch((url, opts) => {
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${SRV_META}`)) return makeResponse(200, serverPayload);
      return makeResponse(200, { ok: true });
    });

    const { projects } = await sync(
      'https://srv.test',
      null,
      localProjects,
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(projects.length, 1);
    assert.deepStrictEqual(projects[0].metadata, { team: 'QA', sprint: '24' });
    assert.deepStrictEqual(projects[0].recordings[0].metadata, { browser: 'chrome' });
  });
});

// ─── sync — schema-mismatch handling ───────────────────────

describe('sync — pull stamp mismatch handling', () => {
  // The local client's stamp comes from STUB_SCHEMA: platform "stub",
  // schema_version "0.0.0-stub". A pulled payload whose stamp differs is
  // rejected per-project, reported in result.mismatched (not errors), and never
  // merged into local state.
  const LOCAL_ID = '0190a1b2-0000-7000-8000-0000000000c1';

  function mockPull(serverPayload) {
    const manifest = [
      { project_id: LOCAL_ID, name: 'Server', last_modified: '2026-06-01T00:00:00.000Z' },
    ];
    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${LOCAL_ID}`)) return makeResponse(200, serverPayload);
      return makeResponse(404);
    });
  }

  it('skips a project from a different platform and reports it in mismatched', async () => {
    mockPull({
      docent_format: { platform: 'desktop-windows', schema_version: '0.0.0-stub' },
      project: { project_id: LOCAL_ID, name: 'Server', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    });

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(projects.length, 0, 'mismatched project is not merged');
    assert.equal(result.pulled.length, 0);
    assert.equal(result.mismatched.length, 1);
    assert.match(result.mismatched[0].message, /different Docent platform/);
    assert.equal(result.errors.length, 0, 'a mismatch is not a generic error');
    assert.equal(result.halted, false);
  });

  it('skips a project with a different schema version and reports it', async () => {
    mockPull({
      docent_format: { platform: 'stub', schema_version: '9.9.9' },
      project: { project_id: LOCAL_ID, name: 'Server', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    });

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(projects.length, 0);
    assert.equal(result.mismatched.length, 1);
    assert.match(result.mismatched[0].message, /schema version 9\.9\.9/);
  });

  it('skips a project with no stamp and reports it as mismatched', async () => {
    mockPull({
      project: { project_id: LOCAL_ID, name: 'Server', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    });

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(projects.length, 0);
    assert.equal(result.mismatched.length, 1);
    assert.match(result.mismatched[0].message, /missing or malformed/);
  });

  it('accepts a project whose stamp matches the local client', async () => {
    mockPull({
      docent_format: { platform: 'stub', schema_version: '0.0.0-stub' },
      project: { project_id: LOCAL_ID, name: 'Server', created_at: '2026-01-01T00:00:00.000Z' },
      recordings: [],
    });

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
    );

    assert.equal(projects.length, 1);
    assert.deepEqual(result.pulled, [LOCAL_ID]);
    assert.equal(result.mismatched.length, 0);
  });

  it('merges compatible projects while skipping incompatible ones in the same pull', async () => {
    const GOOD = '0190a1b2-0000-7000-8000-0000000000c2';
    const BAD = '0190a1b2-0000-7000-8000-0000000000c3';
    const manifest = [
      { project_id: GOOD, name: 'Good', last_modified: '2026-06-01T00:00:00.000Z' },
      { project_id: BAD, name: 'Bad', last_modified: '2026-06-01T00:00:00.000Z' },
    ];
    mockFetch((url, opts) => {
      if (opts.method === 'PUT') return makeResponse(200, { ok: true });
      if (url.endsWith('/projects') && opts.method === 'GET') return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${GOOD}`))
        return makeResponse(200, {
          docent_format: { platform: 'stub', schema_version: '0.0.0-stub' },
          project: { project_id: GOOD, name: 'Good', created_at: '2026-01-01T00:00:00.000Z' },
          recordings: [],
        });
      if (url.endsWith(`/projects/${BAD}`))
        return makeResponse(200, {
          docent_format: { platform: 'desktop-windows', schema_version: '0.0.0-stub' },
          project: { project_id: BAD, name: 'Bad', created_at: '2026-01-01T00:00:00.000Z' },
          recordings: [],
        });
      return makeResponse(404);
    });

    const { result, projects } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      passValidator,
    );

    assert.deepEqual(
      projects.map((p) => p.project_id),
      [GOOD],
      'only the compatible project is merged',
    );
    assert.deepEqual(result.pulled, [GOOD]);
    assert.equal(result.mismatched.length, 1);
    assert.equal(result.mismatched[0].projectName, 'Bad');
  });
});
