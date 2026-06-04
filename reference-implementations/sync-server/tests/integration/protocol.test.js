/**
 * tests/protocol.test.js — manifest, read, and write integration suites for the
 * Reference Sync Server (Task 10.2).
 *
 * These are example/integration tests (per the design's Testing Strategy): each
 * suite spins the REAL server on an ephemeral port over a fresh temp storage dir
 * via the harness, then drives the three protocol endpoints over HTTP. Nothing
 * is mocked — the harness runs the same server a deployment would.
 *
 * Coverage:
 *   - Manifest  (GET /projects)      — Requirements 1.1, 1.2, 1.3, 1.4
 *   - Read      (GET /projects/:id)  — Requirements 2.1, 2.2, 2.4
 *   - Write     (PUT /projects/:id)  — Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/protocol
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, request } from './harness.js';

/**
 * Build a valid Full_Project_Payload inline. The `project.project_id` must match
 * the PUT path id, so callers pass the same id used in the request path.
 *
 * The payload carries a `docent_format` stamp and a recording with full step
 * history — the server must store these verbatim and NEVER read them for the
 * manifest (only `project.project_id` / `project.name` are read). The payload
 * carries `created_at`, NOT `last_modified` (the server maintains that itself,
 * per Requirements 1.4 / 3.7).
 *
 * @param {string} id    The `project_id`, identical to the PUT path id.
 * @param {string} name  The project name surfaced in the manifest.
 * @returns {object} A whole-project payload.
 */
function makePayload(id, name) {
  return {
    docent_format: {
      platform: 'extension',
      schema_version: '2.0.0',
    },
    project: {
      project_id: id,
      name,
      created_at: '2026-05-10T13:04:44.730Z',
      metadata: { tags: ['integration', 'protocol'] },
    },
    recordings: [
      {
        recording_id: '019e3a01-2f10-7b3c-9c4d-58a1b2c3d4e5',
        name: 'Happy path',
        created_at: '2026-05-10T16:06:38.968Z',
        steps: [
          {
            uuid: '019e3a01-633d-74d2-acd5-584085fb57f9',
            logical_id: '019e3a01-633d-74d2-acd5-584085fb57f9',
            step_number: 1,
            created_at: '2026-05-10T16:06:39.000Z',
            narration: 'Navigate to the login page',
            narration_source: 'typed',
            actions: [
              {
                type: 'navigate',
                timestamp: 1715353599000,
                context_id: 1,
                capture_mode: 'dom',
                nav_type: 'typed',
                url: 'https://app.example.com/login',
              },
            ],
            deleted: false,
          },
        ],
      },
    ],
  };
}

const PROJECT_A = '019e3a01-1c2d-7e44-8a1b-2f6c9d0e5a73';
const PROJECT_B = '019e3b02-4d5e-7f66-8b2c-3a7d0e1f6b84';

describe('protocol — manifest (GET /projects)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('returns 200 and an empty array on an empty store (R1.1, R1.3)', async () => {
    const res = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.deepEqual(res.body, []);
  });

  it('returns one entry per stored project, derived only from project_id/name + server last_modified (R1.2, R1.4)', async () => {
    // Store two distinct projects through the protocol.
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_A}`, {
      body: makePayload(PROJECT_A, 'Project A'),
    });
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_B}`, {
      body: makePayload(PROJECT_B, 'Project B'),
    });

    const res = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);

    const byId = new Map(res.body.map((entry) => [entry.project_id, entry]));
    const entryA = byId.get(PROJECT_A);
    const entryB = byId.get(PROJECT_B);
    assert.ok(entryA, 'manifest contains project A');
    assert.ok(entryB, 'manifest contains project B');

    assert.equal(entryA.name, 'Project A');
    assert.equal(entryB.name, 'Project B');

    // last_modified is a server-maintained timestamp (NOT in the payload, which
    // carries created_at). It must be present and a valid ISO timestamp (R1.4).
    assert.ok(entryA.last_modified, 'project A has a server last_modified');
    assert.equal(
      Number.isNaN(Date.parse(entryA.last_modified)),
      false,
      'last_modified parses as a date',
    );
  });

  it('exposes ONLY project_id/name/last_modified — never the docent_format stamp or steps (R1.4)', async () => {
    const res = await request(server.baseUrl, 'GET', '/projects');
    for (const entry of res.body) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['last_modified', 'name', 'project_id'],
        'manifest entry has exactly the three manifest fields',
      );
      // The opaque stamp and step internals are never reflected into the entry.
      assert.equal(entry.docent_format, undefined);
      assert.equal(entry.recordings, undefined);
      assert.equal(entry.created_at, undefined);
    }
  });
});

describe('protocol — read (GET /projects/:id)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('returns 200, the exact stored payload, and Content-Type application/json (R2.1, R2.4)', async () => {
    const payload = makePayload(PROJECT_A, 'Readable Project');
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_A}`, { body: payload });

    const res = await request(server.baseUrl, 'GET', `/projects/${PROJECT_A}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json');
    // The payload is returned verbatim — content-equivalent to what was stored.
    assert.deepEqual(res.body, payload);
  });

  it('returns 404 for an unknown project_id (R2.2)', async () => {
    const res = await request(
      server.baseUrl,
      'GET',
      '/projects/00000000-0000-7000-8000-000000000000',
    );
    assert.equal(res.status, 404);
  });
});

describe('protocol — write (PUT /projects/:id)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('creates a new project → 201 with { ok: true } (R3.1, R3.6)', async () => {
    const res = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_A}`, {
      body: makePayload(PROJECT_A, 'Created'),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { ok: true });
  });

  it('replaces an existing project → 200 with { ok: true } (R3.2, R3.6)', async () => {
    // First write created it (above precedes this in declaration order, but be
    // self-contained: ensure it exists, then replace).
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_A}`, {
      body: makePayload(PROJECT_A, 'Created'),
    });

    const res = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_A}`, {
      body: makePayload(PROJECT_A, 'Replaced'),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    // The replacement is what subsequent reads return.
    const read = await request(server.baseUrl, 'GET', `/projects/${PROJECT_A}`);
    assert.equal(read.body.project.name, 'Replaced');
  });

  it('rejects a path-id ≠ body project_id mismatch → 400, store unchanged (R3.3)', async () => {
    const before = await request(server.baseUrl, 'GET', '/projects');

    // Body's project_id deliberately differs from the path id.
    const res = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_B}`, {
      body: makePayload('019e9999-9999-7999-8999-999999999999', 'Mismatched'),
    });
    assert.equal(res.status, 400);

    const after = await request(server.baseUrl, 'GET', '/projects');
    assert.deepEqual(after.body, before.body, 'manifest unchanged after 400');
    // The path id was never created.
    const read = await request(server.baseUrl, 'GET', `/projects/${PROJECT_B}`);
    assert.equal(read.status, 404);
  });

  it('rejects an invalid-JSON body → 400, store unchanged (R3.4)', async () => {
    const before = await request(server.baseUrl, 'GET', '/projects');

    const res = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_B}`, {
      // A raw string body is sent as-is by the harness (not JSON.stringify'd).
      body: '{ this is not valid json ',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 400);

    const after = await request(server.baseUrl, 'GET', '/projects');
    assert.deepEqual(after.body, before.body, 'manifest unchanged after 400');
  });

  it('surfaces last_modified in the manifest but NEVER in the read-back payload (R3.7, R1.4)', async () => {
    const payload = makePayload(PROJECT_A, 'Timestamped');
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_A}`, { body: payload });

    // Manifest entry carries a server last_modified.
    const manifest = await request(server.baseUrl, 'GET', '/projects');
    const entry = manifest.body.find((e) => e.project_id === PROJECT_A);
    assert.ok(entry, 'project present in manifest');
    assert.ok(entry.last_modified, 'manifest entry has last_modified');

    // The read-back payload is verbatim: it has no top-level last_modified, and
    // the project object still carries only created_at (never last_modified).
    const read = await request(server.baseUrl, 'GET', `/projects/${PROJECT_A}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.last_modified, undefined, 'no top-level last_modified in payload');
    assert.equal(
      read.body.project.last_modified,
      undefined,
      'no last_modified injected into project',
    );
    assert.deepEqual(read.body, payload, 'payload returned verbatim');
  });
});
