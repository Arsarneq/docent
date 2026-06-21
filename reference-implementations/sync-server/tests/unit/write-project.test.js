import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeProject } from '../../handlers/write-project.js';
import { FileStorageProvider } from '../../storage/file-provider.js';
import { deriveETag } from '../../etag.js';

/**
 * Tests for the `PUT /projects/:id` handler.
 *
 * The handler is exercised against the real `FileStorageProvider` over a fresh
 * temp dir per test (no mocks), so create/replace, verbatim storage, and the
 * "store unchanged on rejection" guarantees are validated against real I/O. The
 * HTTP edges are driven with a minimal fake request (a Readable carrying the
 * body + headers) and a fake response that captures status, headers, and body.
 */

/** A representative Full_Project_Payload-shaped object. */
function samplePayload(id = '0192f0a0-0000-7000-8000-000000000001') {
  return {
    docent_format: { platform: 'extension', schema_version: '2.0.0' },
    project: {
      project_id: id,
      name: 'Demo Project',
      created_at: '2026-06-04T10:00:00.000Z',
    },
    recordings: [
      {
        recording_id: '0192f0a0-0000-7000-8000-0000000000aa',
        name: 'First recording',
        steps: [{ logical_id: 'a', uuid: 'u1', text: 'hello' }],
      },
    ],
    unrecognized_top_level: { kept: true },
  };
}

/** Build a fake IncomingMessage carrying `bodyString` and `headers`. */
function fakeReq(bodyString, headers = {}) {
  const req = Readable.from([Buffer.from(bodyString, 'utf8')]);
  req.headers = headers;
  return req;
}

/** A fake ServerResponse capturing status, headers, and the body. */
function fakeRes() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk;
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

let storage;
let storageDir;

beforeEach(async () => {
  storageDir = await mkdtemp(path.join(os.tmpdir(), 'write-project-test-'));
  storage = new FileStorageProvider(storageDir);
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('writeProject — create', () => {
  it('stores a new project and responds 201 with { ok: true } and an ETag', async () => {
    const payload = samplePayload();
    const res = fakeRes();

    await writeProject(storage, fakeReq(JSON.stringify(payload)), res, payload.project.project_id);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.equal(res.headers.ETag, deriveETag(payload));

    const stored = await storage.read(payload.project.project_id);
    assert.deepEqual(stored.payload, payload);
  });
});

describe('writeProject — replace', () => {
  it('replaces an existing project and responds 200', async () => {
    const id = '0192f0a0-0000-7000-8000-000000000001';
    await storage.put(id, samplePayload(id), '2020-01-01T00:00:00.000Z');

    const updated = samplePayload(id);
    updated.project.name = 'Renamed';
    const res = fakeRes();

    await writeProject(storage, fakeReq(JSON.stringify(updated)), res, id);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(res.headers.ETag, deriveETag(updated));

    const stored = await storage.read(id);
    assert.equal(stored.payload.project.name, 'Renamed');
  });
});

describe('writeProject — server-set last_modified', () => {
  it('records a fresh server timestamp, not anything from the payload', async () => {
    const payload = samplePayload();
    const before = Date.now();
    const res = fakeRes();

    await writeProject(storage, fakeReq(JSON.stringify(payload)), res, payload.project.project_id);

    const stored = await storage.read(payload.project.project_id);
    const stamp = Date.parse(stored.last_modified);
    assert.ok(stamp >= before && stamp <= Date.now());
    // The verbatim payload must not gain a last_modified field.
    assert.equal('last_modified' in stored.payload, false);
  });
});

describe('writeProject — invalid JSON', () => {
  it('responds 400 and leaves stored data unchanged', async () => {
    const res = fakeRes();
    await writeProject(storage, fakeReq('{ not valid json'), res, 'some-id');

    assert.equal(res.statusCode, 400);
    assert.deepEqual(await storage.list(), []);
  });
});

describe('writeProject — path/body id mismatch', () => {
  it('responds 400 when the path id differs from body project_id, store unchanged', async () => {
    const payload = samplePayload('0192f0a0-0000-7000-8000-000000000001');
    const res = fakeRes();

    await writeProject(storage, fakeReq(JSON.stringify(payload)), res, 'a-different-id');

    assert.equal(res.statusCode, 400);
    assert.deepEqual(await storage.list(), []);
  });

  it('responds 400 when the body has no project object', async () => {
    const res = fakeRes();
    await writeProject(storage, fakeReq(JSON.stringify({ hello: 'world' })), res, 'some-id');

    assert.equal(res.statusCode, 400);
    assert.deepEqual(await storage.list(), []);
  });
});

describe('writeProject — conditional write', () => {
  it('proceeds and returns a fresh ETag when If-Match matches the stored ETag', async () => {
    const id = '0192f0a0-0000-7000-8000-000000000001';
    const original = samplePayload(id);
    await storage.put(id, original, '2020-01-01T00:00:00.000Z');

    const updated = samplePayload(id);
    updated.project.name = 'Updated';
    const res = fakeRes();

    await writeProject(
      storage,
      fakeReq(JSON.stringify(updated), { 'if-match': deriveETag(original) }),
      res,
      id,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.ETag, deriveETag(updated));
    assert.equal((await storage.read(id)).payload.project.name, 'Updated');
  });

  it('rejects with 412 on a stale If-Match and leaves stored data unchanged', async () => {
    const id = '0192f0a0-0000-7000-8000-000000000001';
    const original = samplePayload(id);
    await storage.put(id, original, '2020-01-01T00:00:00.000Z');

    const updated = samplePayload(id);
    updated.project.name = 'ShouldNotApply';
    const res = fakeRes();

    await writeProject(
      storage,
      fakeReq(JSON.stringify(updated), { 'if-match': '"stale-etag"' }),
      res,
      id,
    );

    assert.equal(res.statusCode, 412);
    assert.equal((await storage.read(id)).payload.project.name, 'Demo Project');
  });

  it('rejects a create with 412 when an If-Match is present but nothing is stored', async () => {
    const payload = samplePayload();
    const res = fakeRes();

    await writeProject(
      storage,
      fakeReq(JSON.stringify(payload), { 'if-match': '"anything"' }),
      res,
      payload.project.project_id,
    );

    assert.equal(res.statusCode, 412);
    assert.deepEqual(await storage.list(), []);
  });

  it('overwrites unconditionally when no If-Match is present (last-write-wins)', async () => {
    const id = '0192f0a0-0000-7000-8000-000000000001';
    await storage.put(id, samplePayload(id), '2020-01-01T00:00:00.000Z');

    const updated = samplePayload(id);
    updated.project.name = 'Overwritten';
    const res = fakeRes();

    await writeProject(storage, fakeReq(JSON.stringify(updated)), res, id);

    assert.equal(res.statusCode, 200);
    assert.equal((await storage.read(id)).payload.project.name, 'Overwritten');
  });
});

describe('writeProject — verbatim storage', () => {
  it('stores the payload verbatim including unrecognized top-level fields', async () => {
    const payload = samplePayload();
    const res = fakeRes();

    await writeProject(storage, fakeReq(JSON.stringify(payload)), res, payload.project.project_id);

    const stored = await storage.read(payload.project.project_id);
    assert.deepEqual(stored.payload, payload);
    assert.deepEqual(stored.payload.unrecognized_top_level, { kept: true });
  });
});
