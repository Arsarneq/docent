import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createRouter } from './router.js';
import { FileStorageProvider } from './storage/file-provider.js';
import { deriveETag } from './etag.js';

/**
 * Tests for the auth-first router (Requirements 5.6, 5.7, 12.2).
 *
 * The router is driven directly with fake `req`/`res` objects — no real socket
 * or `http.Server` is needed. A fake `req` is a `Readable` carrying the body (so
 * the PUT/seed body handlers can consume it) with `method`, `url`, and `headers`
 * assigned. The fake `res` records the status, headers, and body the router
 * writes. Storage is a real `FileStorageProvider` over a fresh temp dir per
 * test, so routing is verified against genuine handler behavior — not mocks.
 */

const TOKEN = 's3cr3t-static-token';

/**
 * Build a fake `http.IncomingMessage`: a Readable stream carrying `body` with
 * `method`, `url`, and `headers` assigned, mirroring the fields the router and
 * the body-reading handlers actually touch.
 *
 * The body is eagerly pushed into a plain `Readable` (no-op `read`) rather than
 * built with `Readable.from`. `Readable.from` is backed by an async generator;
 * for the GET requests whose handlers never consume the body, that would leave
 * a dangling async iterator and trip Node's async-context teardown. Eager
 * `push` buffers the body synchronously and is safe whether or not it is read.
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.url
 * @param {Record<string,string>} [opts.headers]
 * @param {string} [opts.body]
 */
function fakeReq({ method, url, headers = {}, body = '' }) {
  const req = new Readable({ read() {} });
  req.push(body);
  req.push(null);
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

/**
 * Build a fake `http.ServerResponse` that records what the router/handlers
 * write. Tracks `headersSent` like the real response so the 500 wrapper's guard
 * is exercised faithfully. Resolves `done` when `end()` is called.
 */
function fakeRes() {
  const res = {
    statusCode: undefined,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this._resolveDone();
    },
  };
  res.done = new Promise((resolve) => {
    res._resolveDone = resolve;
  });
  return res;
}

/** Drive the router with a fake req/res and wait for the response to finish. */
async function drive(router, reqOpts) {
  const req = fakeReq(reqOpts);
  const res = fakeRes();
  await router(req, res);
  await res.done;
  return res;
}

/** A representative Full_Project_Payload-shaped object. */
function samplePayload(id = '0192f0a0-0000-7000-8000-000000000001', name = 'Demo') {
  return {
    docent_format: { platform: 'extension', version: 1 },
    project: { project_id: id, name, created_at: '2026-06-04T10:00:00.000Z' },
    recordings: [
      {
        recording_id: '0192f0a0-0000-7000-8000-0000000000aa',
        name: 'First recording',
        steps: [{ logical_id: 'a', uuid: 'u1', text: 'hello' }],
      },
    ],
  };
}

let tmpDir;
let storage;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'router-test-'));
  storage = new FileStorageProvider(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('router — auth-first (R5.7, 12.2)', () => {
  it('returns 401 when a token is set and the Authorization header is missing', async () => {
    const router = createRouter({ storage, token: TOKEN });
    const res = await drive(router, { method: 'GET', url: '/projects' });
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when a token is set and the Bearer token is wrong', async () => {
    const router = createRouter({ storage, token: TOKEN });
    const res = await drive(router, {
      method: 'GET',
      url: '/projects',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('passes through to the handler when the Bearer token matches', async () => {
    const router = createRouter({ storage, token: TOKEN });
    const res = await drive(router, {
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });

  it('gates the /__debug/* routes behind auth too (R5.7) — 401 without a header', async () => {
    const router = createRouter({ storage, token: TOKEN });
    const res = await drive(router, { method: 'POST', url: '/__debug/reset' });
    assert.equal(res.statusCode, 401);
  });

  it('gates the /__debug/* routes behind auth too (R5.7) — 403 with a wrong token', async () => {
    const router = createRouter({ storage, token: TOKEN });
    const res = await drive(router, {
      method: 'POST',
      url: '/__debug/reset',
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('serves every request when no token is configured (open server)', async () => {
    const router = createRouter({ storage, token: null });
    const res = await drive(router, { method: 'GET', url: '/projects' });
    assert.equal(res.statusCode, 200);
  });
});

describe('router — dispatch to each handler', () => {
  it('routes GET /projects to the manifest handler', async () => {
    const router = createRouter({ storage });
    await storage.put('p1', samplePayload('p1', 'One'), '2026-06-04T10:00:00.000Z');
    const res = await drive(router, { method: 'GET', url: '/projects' });
    assert.equal(res.statusCode, 200);
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].project_id, 'p1');
    assert.equal(manifest[0].name, 'One');
  });

  it('treats /projects/ identically to /projects (collection path)', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'GET', url: '/projects/' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });

  it('routes GET /projects/:id to the read handler (200 + ETag for a stored project)', async () => {
    const router = createRouter({ storage });
    const payload = samplePayload('p1', 'One');
    await storage.put('p1', payload, '2026-06-04T10:00:00.000Z');
    const res = await drive(router, { method: 'GET', url: '/projects/p1' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), payload);
    assert.equal(res.headers.ETag, deriveETag(payload));
  });

  it('routes GET /projects/:id to the read handler (404 for an unknown project)', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'GET', url: '/projects/missing' });
    assert.equal(res.statusCode, 404);
  });

  it('decodes a percent-encoded :id before dispatch', async () => {
    const router = createRouter({ storage });
    const payload = samplePayload('id with space', 'Spaced');
    await storage.put('id with space', payload, '2026-06-04T10:00:00.000Z');
    const res = await drive(router, { method: 'GET', url: '/projects/id%20with%20space' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), payload);
  });

  it('routes PUT /projects/:id to the write handler (201 create + {ok:true})', async () => {
    const router = createRouter({ storage });
    const payload = samplePayload('p1', 'One');
    const res = await drive(router, {
      method: 'PUT',
      url: '/projects/p1',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    // Confirm the write actually reached the store.
    const stored = await storage.read('p1');
    assert.deepEqual(stored.payload, payload);
  });

  it('routes a second PUT /projects/:id to a replace (200)', async () => {
    const router = createRouter({ storage });
    await storage.put('p1', samplePayload('p1', 'One'), '2026-06-04T10:00:00.000Z');
    const res = await drive(router, {
      method: 'PUT',
      url: '/projects/p1',
      body: JSON.stringify(samplePayload('p1', 'Renamed')),
    });
    assert.equal(res.statusCode, 200);
  });

  it('routes /__debug/<sub> to the debug handler with the sub-path', async () => {
    const router = createRouter({ storage });
    await storage.put('p1', samplePayload('p1', 'One'), '2026-06-04T10:00:00.000Z');
    const res = await drive(router, { method: 'POST', url: '/__debug/reset' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, cleared: 1 });
    assert.deepEqual(await storage.list(), []);
  });

  it('lets the debug handler self-guard unknown sub-paths (404)', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'GET', url: '/__debug/nope' });
    assert.equal(res.statusCode, 404);
  });

  it('lets the debug handler self-guard the method (405 for wrong method on a known sub-path)', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'GET', url: '/__debug/reset' });
    assert.equal(res.statusCode, 405);
  });
});

describe('router — 405 for a known path with an unsupported method', () => {
  it('returns 405 for POST /projects', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'POST', url: '/projects' });
    assert.equal(res.statusCode, 405);
  });

  it('returns 405 for DELETE /projects/:id', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'DELETE', url: '/projects/p1' });
    assert.equal(res.statusCode, 405);
  });
});

describe('router — 404 for an unknown path', () => {
  it('returns 404 for a path outside the protocol and debug namespaces', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'GET', url: '/totally/unknown' });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 for the root path', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'GET', url: '/' });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 for a deep /projects/:id/extra path', async () => {
    const router = createRouter({ storage });
    const res = await drive(router, { method: 'GET', url: '/projects/p1/extra' });
    assert.equal(res.statusCode, 404);
  });
});

describe('router — 500 wrapper (R5.6)', () => {
  /** A storage stub whose every method throws, to force a handler error. */
  function throwingStorage() {
    return {
      async list() {
        throw new Error('boom');
      },
      async read() {
        throw new Error('boom');
      },
      async put() {
        throw new Error('boom');
      },
      async clear() {
        throw new Error('boom');
      },
    };
  }

  it('returns 500 when a handler throws, even with no token configured', async () => {
    const router = createRouter({ storage: throwingStorage(), token: null });
    const res = await drive(router, { method: 'GET', url: '/projects' });
    assert.equal(res.statusCode, 500);
  });

  it('returns 500 when the read handler throws', async () => {
    const router = createRouter({ storage: throwingStorage(), token: null });
    const res = await drive(router, { method: 'GET', url: '/projects/p1' });
    assert.equal(res.statusCode, 500);
  });
});
