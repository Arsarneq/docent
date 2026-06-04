import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleManifest } from '../../handlers/manifest.js';

/**
 * Tests for the `GET /projects` manifest handler (Requirement 1).
 *
 * The handler reads only from the injected Storage_Provider's `list()` and
 * writes the response via `res.writeHead`/`res.end`, so both can be faked with
 * tiny stubs — no real socket or filesystem needed.
 */

/**
 * Build a minimal http.ServerResponse-like stub that records what the handler
 * wrote: the status code, the response headers, and the body string.
 */
function fakeRes() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** Build a Storage_Provider stub whose `list()` resolves to `entries`. */
function fakeStorage(entries) {
  return {
    async list() {
      return entries;
    },
  };
}

describe('handleManifest — GET /projects', () => {
  it('responds 200 with an empty array when no projects are stored (R1.1, R1.3)', async () => {
    const res = fakeRes();
    await handleManifest(fakeStorage([]), {}, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(res.body), []);
  });

  it('responds 200 with one entry per stored project (R1.1, R1.2)', async () => {
    const entries = [
      {
        project_id: '0190aaaa-bbbb-7ccc-8ddd-000000000001',
        name: 'First Project',
        last_modified: '2026-06-04T10:00:00.000Z',
      },
      {
        project_id: '0190aaaa-bbbb-7ccc-8ddd-000000000002',
        name: 'Second Project',
        last_modified: '2026-06-04T11:30:00.000Z',
      },
    ];
    const res = fakeRes();
    await handleManifest(fakeStorage(entries), {}, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(res.body), entries);
  });

  it('passes the manifest straight through without reshaping (R1.2, R1.4)', async () => {
    // The handler must not add, drop, or rename fields — it serializes exactly
    // what storage.list() returns, which carries only the three manifest fields.
    const entries = [
      {
        project_id: '0190aaaa-bbbb-7ccc-8ddd-000000000003',
        name: 'Verbatim',
        last_modified: '2026-06-04T12:00:00.000Z',
      },
    ];
    const res = fakeRes();
    await handleManifest(fakeStorage(entries), {}, res);

    const parsed = JSON.parse(res.body);
    assert.deepEqual(Object.keys(parsed[0]).sort(), ['last_modified', 'name', 'project_id']);
  });
});
