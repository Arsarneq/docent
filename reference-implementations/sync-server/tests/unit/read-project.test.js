import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readProject } from '../../handlers/read-project.js';
import { deriveETag } from '../../etag.js';
import { StorageProvider } from '../../storage/provider.js';

/**
 * Tests for the `GET /projects/:id` read handler (Requirements 2.1, 2.2, 2.3,
 * 2.4, 6.1). They drive the handler directly with a tiny in-memory
 * Storage_Provider and a minimal fake ServerResponse that records the status,
 * headers, and body the handler writes.
 */

/** A representative Full_Project_Payload-shaped object. */
function samplePayload() {
  return {
    docent_format: { platform: 'extension', version: 1 },
    project: {
      project_id: '0192f0a0-0000-7000-8000-000000000001',
      name: 'Demo Project',
      created_at: '2026-06-04T10:00:00.000Z',
    },
    // An unrecognized top-level field must survive verbatim (R2.3).
    unknown_top_level: { keep: 'me' },
    recordings: [
      {
        recording_id: '0192f0a0-0000-7000-8000-0000000000aa',
        name: 'First recording',
        steps: [{ logical_id: 'a', uuid: 'u1', text: 'hello' }],
      },
    ],
  };
}

/** A Storage_Provider stub whose `read` returns whatever it is seeded with. */
class StubProvider extends StorageProvider {
  constructor(record) {
    super();
    this._record = record;
  }

  async read(_id) {
    return this._record;
  }
}

/** A minimal fake ServerResponse capturing status, headers, and body. */
function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

describe('readProject — stored project (R2.1, R2.4, R6.1)', () => {
  it('responds 200 with the verbatim payload as application/json', async () => {
    const payload = samplePayload();
    const storage = new StubProvider({ payload, last_modified: '2026-06-04T10:00:00.000Z' });
    const res = fakeResponse();

    await readProject(storage, {}, res, payload.project.project_id);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(res.body), payload);
  });

  it('sets an ETag header derived from the payload content (not last_modified)', async () => {
    const payload = samplePayload();
    const storage = new StubProvider({ payload, last_modified: '2026-06-04T10:00:00.000Z' });
    const res = fakeResponse();

    await readProject(storage, {}, res, payload.project.project_id);

    assert.equal(res.headers.ETag, deriveETag(payload));
  });

  it('produces the same ETag regardless of the stored last_modified', async () => {
    const payload = samplePayload();
    const resA = fakeResponse();
    const resB = fakeResponse();

    await readProject(
      new StubProvider({ payload, last_modified: '2026-06-04T10:00:00.000Z' }),
      {},
      resA,
      payload.project.project_id,
    );
    await readProject(
      new StubProvider({ payload, last_modified: '2099-01-01T00:00:00.000Z' }),
      {},
      resB,
      payload.project.project_id,
    );

    assert.equal(resA.headers.ETag, resB.headers.ETag);
  });

  it('does not leak the storage wrapper (no last_modified in the body)', async () => {
    const payload = samplePayload();
    const storage = new StubProvider({ payload, last_modified: '2026-06-04T10:00:00.000Z' });
    const res = fakeResponse();

    await readProject(storage, {}, res, payload.project.project_id);

    const parsed = JSON.parse(res.body);
    assert.equal('last_modified' in parsed, false);
  });
});

describe('readProject — not stored (R2.2)', () => {
  it('responds 404 when the provider returns null', async () => {
    const storage = new StubProvider(null);
    const res = fakeResponse();

    await readProject(storage, {}, res, 'missing-id');

    assert.equal(res.statusCode, 404);
    assert.equal(res.ended, true);
  });

  it('does not set an ETag header on a 404', async () => {
    const storage = new StubProvider(null);
    const res = fakeResponse();

    await readProject(storage, {}, res, 'missing-id');

    assert.equal('ETag' in res.headers, false);
  });
});
