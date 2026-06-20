import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { debugReset, debugDump, debugSeed, handleDebug } from '../../handlers/debug.js';
import { FileStorageProvider } from '../../storage/file-provider.js';
import { deriveETag } from '../../etag.js';

/**
 * Tests for the `/__debug/*` Debug_Affordances.
 *
 * Each affordance is exercised against the real `FileStorageProvider` over a
 * fresh temp dir per test (no mocks), so reset/dump/seed are validated against
 * real file I/O. The HTTP edges are driven with a minimal fake request (a
 * Readable carrying the body) and a fake response capturing status/headers/body.
 */

const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples');

/** A representative Full_Project_Payload-shaped object. */
function samplePayload(id = '0192f0a0-0000-7000-8000-000000000001', name = 'Demo Project') {
  return {
    docent_format: { platform: 'extension', schema_version: '2.0.0' },
    project: { project_id: id, name, created_at: '2026-06-04T10:00:00.000Z' },
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

/** Build a fake IncomingMessage carrying `bodyString` and `method`/`headers`. */
function fakeReq(bodyString = '', { method = 'POST', headers = {} } = {}) {
  const req = Readable.from([Buffer.from(bodyString, 'utf8')]);
  req.method = method;
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
  storageDir = await mkdtemp(path.join(os.tmpdir(), 'debug-handler-test-'));
  storage = new FileStorageProvider(storageDir);
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('debugReset — POST /__debug/reset', () => {
  it('clears all stored projects and reports the count removed', async () => {
    await storage.put('id-1', samplePayload('id-1'), '2020-01-01T00:00:00.000Z');
    await storage.put('id-2', samplePayload('id-2'), '2020-01-02T00:00:00.000Z');

    const res = fakeRes();
    await debugReset(storage, fakeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, cleared: 2 });
    // A subsequent manifest is empty.
    assert.deepEqual(await storage.list(), []);
  });

  it('reports cleared: 0 on an already-empty store', async () => {
    const res = fakeRes();
    await debugReset(storage, fakeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, cleared: 0 });
  });
});

describe('debugDump — GET /__debug/dump', () => {
  it('returns count + per-project project_id/name/last_modified/etag', async () => {
    const payload = samplePayload('id-1', 'Dumped Project');
    await storage.put('id-1', payload, '2026-06-04T10:00:00.000Z');

    const res = fakeRes();
    await debugDump(storage, fakeReq('', { method: 'GET' }), res);

    assert.equal(res.statusCode, 200);
    const { count, projects } = res.json;
    assert.equal(count, 1);
    assert.equal(projects.length, 1);
    assert.deepEqual(projects[0], {
      project_id: 'id-1',
      name: 'Dumped Project',
      last_modified: '2026-06-04T10:00:00.000Z',
      etag: deriveETag(payload),
    });
  });

  it('returns count: 0 and an empty list on an empty store', async () => {
    const res = fakeRes();
    await debugDump(storage, fakeReq('', { method: 'GET' }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { count: 0, projects: [] });
  });

  it('does not mutate stored data', async () => {
    const payload = samplePayload('id-1');
    await storage.put('id-1', payload, '2026-06-04T10:00:00.000Z');
    const before = await storage.read('id-1');

    await debugDump(storage, fakeReq('', { method: 'GET' }), fakeRes());

    const after = await storage.read('id-1');
    assert.deepEqual(after, before);
    assert.deepEqual(after.payload, payload);
  });
});

describe('debugSeed — POST /__debug/seed with a caller array', () => {
  it('stores each payload verbatim with a server-set last_modified and reports the count', async () => {
    const a = samplePayload('seed-a', 'Seed A');
    const b = samplePayload('seed-b', 'Seed B');
    const before = Date.now();

    const res = fakeRes();
    await debugSeed(storage, fakeReq(JSON.stringify([a, b])), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, seeded: 2 });

    const storedA = await storage.read('seed-a');
    const storedB = await storage.read('seed-b');
    // Verbatim, opaque storage — the payload round-trips exactly.
    assert.deepEqual(storedA.payload, a);
    assert.deepEqual(storedB.payload, b);
    // A server-set last_modified is recorded, not pulled from the payload.
    const stampA = Date.parse(storedA.last_modified);
    assert.ok(stampA >= before && stampA <= Date.now());
    // last_modified is never merged into the verbatim payload.
    assert.equal('last_modified' in storedA.payload, false);
  });
});

describe('debugSeed — POST /__debug/seed with { samples: true }', () => {
  it('stores both an extension- and a desktop-windows-stamped project', async () => {
    const res = fakeRes();
    await debugSeed(storage, fakeReq(JSON.stringify({ samples: true })), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, seeded: 2 });

    // The two bundled samples are now stored; confirm both platforms are present
    // by reading the samples back and comparing verbatim (stored opaquely,
    // verbatim — the server never interprets the docent_format stamp).
    const extension = JSON.parse(
      await readFile(path.join(SAMPLES_DIR, 'extension-sample.json'), 'utf8'),
    );
    const desktop = JSON.parse(
      await readFile(path.join(SAMPLES_DIR, 'desktop-windows-sample.json'), 'utf8'),
    );

    const storedExtension = await storage.read(extension.project.project_id);
    const storedDesktop = await storage.read(desktop.project.project_id);

    assert.deepEqual(storedExtension.payload, extension);
    assert.deepEqual(storedDesktop.payload, desktop);
    assert.equal(storedExtension.payload.docent_format.platform, 'extension');
    assert.equal(storedDesktop.payload.docent_format.platform, 'desktop-windows');
  });
});

describe('debugSeed — invalid JSON', () => {
  it('responds 400 and leaves stored data unchanged', async () => {
    // Seed one project first so we can confirm the store is untouched.
    await storage.put('existing', samplePayload('existing'), '2020-01-01T00:00:00.000Z');
    const before = await storage.list();

    const res = fakeRes();
    await debugSeed(storage, fakeReq('{ not valid json'), res);

    assert.equal(res.statusCode, 400);
    // Store unchanged: the one pre-existing project is still the only one.
    assert.deepEqual(await storage.list(), before);
  });

  it('responds 400 for a valid-JSON body that is neither an array nor { samples: true }', async () => {
    const res = fakeRes();
    await debugSeed(storage, fakeReq(JSON.stringify({ nope: true })), res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(await storage.list(), []);
  });
});

describe('handleDebug — dispatch + method/path guards', () => {
  it('routes reset / dump / seed to their affordances', async () => {
    await storage.put('id-1', samplePayload('id-1'), '2026-06-04T10:00:00.000Z');

    const dumpRes = fakeRes();
    await handleDebug(storage, fakeReq('', { method: 'GET' }), dumpRes, 'dump');
    assert.equal(dumpRes.statusCode, 200);
    assert.equal(dumpRes.json.count, 1);

    const resetRes = fakeRes();
    await handleDebug(storage, fakeReq('', { method: 'POST' }), resetRes, 'reset');
    assert.equal(resetRes.statusCode, 200);
    assert.deepEqual(resetRes.json, { ok: true, cleared: 1 });
  });

  it('responds 405 for a known debug sub-path with the wrong method', async () => {
    const res = fakeRes();
    await handleDebug(storage, fakeReq('', { method: 'GET' }), res, 'reset');
    assert.equal(res.statusCode, 405);
  });

  it('responds 404 for an unknown debug sub-path', async () => {
    const res = fakeRes();
    await handleDebug(storage, fakeReq('', { method: 'GET' }), res, 'nope');
    assert.equal(res.statusCode, 404);
  });
});
