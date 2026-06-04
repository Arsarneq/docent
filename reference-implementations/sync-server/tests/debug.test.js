/**
 * tests/debug.test.js — integration suite for the non-protocol Debug_Affordances
 * (Requirement 12), driven end-to-end over HTTP through the test harness.
 *
 * Unlike `handlers/debug.test.js` (which unit-tests the handler functions against
 * a `FileStorageProvider` with fake req/res), this suite spins the REAL server on
 * an ephemeral port and exercises the affordances exactly as a tester would: via
 * `POST /__debug/reset`, `GET /__debug/dump`, and `POST /__debug/seed`, observing
 * the effects through the protocol endpoints (`GET /projects`, `GET /projects/:id`).
 *
 * Coverage (one or more cases per requirement):
 *   - reset (R12.3): empties the store → a subsequent GET /projects returns `[]`,
 *     and the response is `{ ok: true, cleared: <n> }`.
 *   - dump (R12.4): returns `count` + per-project `last_modified` + `etag` WITHOUT
 *     mutating the store; the dump `etag` matches the `ETag` header from
 *     GET /projects/:id.
 *   - seed with caller payloads (R12.5): stores each payload without a client PUT;
 *     response `{ ok: true, seeded: <n> }`; observable via the manifest and reads.
 *   - seed with `{ samples: true }` (R12.6, R12.7): stores BOTH an `extension`- and
 *     a `desktop-windows`-stamped sample, content-equivalent to the bundled files.
 *   - seed with invalid JSON (R12.8): 400, store unchanged.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/debug.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startTestServer, request } from './harness.js';

/** Absolute path to the bundled `samples/` directory, relative to this test. */
const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

/**
 * Build a representative Full_Project_Payload-shaped object. The server stores
 * it verbatim and opaquely — these tests never rely on the server interpreting
 * any field beyond `project.project_id` / `project.name`.
 *
 * @param {string} id   The `project_id`.
 * @param {string} name The project name.
 * @returns {object} A whole-project payload.
 */
function samplePayload(id, name) {
  return {
    docent_format: { platform: 'extension', schema_version: '2.0.0' },
    project: { project_id: id, name, created_at: '2026-06-04T10:00:00.000Z' },
    recordings: [
      {
        recording_id: `${id}-rec-1`,
        name: 'First recording',
        steps: [{ logical_id: 'a', uuid: 'u1', step_number: 1, narration: 'hello' }],
      },
    ],
    unrecognized_top_level: { kept: true },
  };
}

/**
 * Read a bundled sample payload file and parse it, so seeded-then-read-back
 * payloads can be compared content-equivalent to the on-disk samples.
 *
 * @param {string} file The sample filename under `samples/`.
 * @returns {Promise<object>} The parsed sample payload.
 */
async function loadSample(file) {
  return JSON.parse(await readFile(path.join(SAMPLES_DIR, file), 'utf8'));
}

describe('debug: reset — POST /__debug/reset (R12.3)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('empties the store and reports the count cleared; a later GET /projects is []', async () => {
    // Stage two projects via the seed affordance (no client PUT needed).
    const seed = await request(server.baseUrl, 'POST', '/__debug/seed', {
      body: [samplePayload('reset-a', 'Reset A'), samplePayload('reset-b', 'Reset B')],
    });
    assert.equal(seed.status, 200);
    assert.deepEqual(seed.body, { ok: true, seeded: 2 });

    // The manifest now lists both.
    const before = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(before.status, 200);
    assert.equal(before.body.length, 2);

    // Reset clears them and reports how many were removed (R12.3).
    const reset = await request(server.baseUrl, 'POST', '/__debug/reset');
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body, { ok: true, cleared: 2 });

    // A subsequent GET /projects returns an empty array (R12.3).
    const after = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, []);
  });

  it('reports cleared: 0 on an already-empty store', async () => {
    // The store is empty after the previous test's reset.
    const reset = await request(server.baseUrl, 'POST', '/__debug/reset');
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body, { ok: true, cleared: 0 });
  });
});

describe('debug: dump — GET /__debug/dump (R12.4)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('returns count + per-project last_modified + etag without mutating the store', async () => {
    // Seed two known projects.
    const a = samplePayload('dump-a', 'Dump A');
    const b = samplePayload('dump-b', 'Dump B');
    await request(server.baseUrl, 'POST', '/__debug/seed', { body: [a, b] });

    // Capture a read BEFORE the dump to confirm the dump does not mutate.
    const readBefore = await request(server.baseUrl, 'GET', '/projects/dump-a');
    assert.equal(readBefore.status, 200);

    const dump = await request(server.baseUrl, 'GET', '/__debug/dump');
    assert.equal(dump.status, 200);

    // count matches the number of stored projects (R12.4).
    assert.equal(dump.body.count, 2);
    assert.equal(dump.body.projects.length, 2);

    // Each entry carries project_id, name, last_modified, and etag (R12.4).
    for (const entry of dump.body.projects) {
      assert.ok(typeof entry.project_id === 'string' && entry.project_id.length > 0);
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0);
      // last_modified is a server-maintained, parseable ISO timestamp.
      assert.ok(typeof entry.last_modified === 'string');
      assert.ok(Number.isFinite(Date.parse(entry.last_modified)));
      // etag is the content-derived, quoted entity-tag string.
      assert.ok(typeof entry.etag === 'string' && entry.etag.length > 0);
    }

    const dumpA = dump.body.projects.find((p) => p.project_id === 'dump-a');
    assert.ok(dumpA, 'expected dump to include dump-a');
    assert.equal(dumpA.name, 'Dump A');

    // The dump did NOT mutate the store: a read after the dump is unchanged, and
    // count still matches the stored projects (R12.4).
    const readAfter = await request(server.baseUrl, 'GET', '/projects/dump-a');
    assert.equal(readAfter.status, 200);
    assert.deepEqual(readAfter.body, readBefore.body);
    assert.deepEqual(readAfter.body, a);

    // Cross-check: the dump etag for a project equals the ETag header that
    // GET /projects/:id advertises for it (fetch lower-cases header keys).
    assert.equal(dumpA.etag, readAfter.headers.etag);

    // The manifest is still intact after the dump (no mutation).
    const manifest = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(manifest.body.length, 2);
  });

  it('returns count: 0 and an empty list on an empty store', async () => {
    await request(server.baseUrl, 'POST', '/__debug/reset');
    const dump = await request(server.baseUrl, 'GET', '/__debug/dump');
    assert.equal(dump.status, 200);
    assert.deepEqual(dump.body, { count: 0, projects: [] });
  });
});

describe('debug: seed with caller payloads — POST /__debug/seed (R12.5)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('stores each payload without a client PUT and reports the count seeded', async () => {
    const a = samplePayload('seed-a', 'Seed A');
    const b = samplePayload('seed-b', 'Seed B');

    const seed = await request(server.baseUrl, 'POST', '/__debug/seed', { body: [a, b] });
    assert.equal(seed.status, 200);
    assert.deepEqual(seed.body, { ok: true, seeded: 2 });

    // Observable via the manifest: one entry per seeded project (R12.5).
    const manifest = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(manifest.status, 200);
    const ids = manifest.body.map((e) => e.project_id).sort();
    assert.deepEqual(ids, ['seed-a', 'seed-b']);

    // And via GET /projects/:id: each payload is stored verbatim (R12.5, R12.6).
    const readA = await request(server.baseUrl, 'GET', '/projects/seed-a');
    assert.equal(readA.status, 200);
    assert.deepEqual(readA.body, a);

    const readB = await request(server.baseUrl, 'GET', '/projects/seed-b');
    assert.equal(readB.status, 200);
    assert.deepEqual(readB.body, b);
  });
});

describe('debug: seed with { samples: true } — POST /__debug/seed (R12.6, R12.7)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('stores both an extension- and a desktop-windows-stamped project, content-equivalent to the samples', async () => {
    const extension = await loadSample('extension-sample.json');
    const desktop = await loadSample('desktop-windows-sample.json');

    const seed = await request(server.baseUrl, 'POST', '/__debug/seed', {
      body: { samples: true },
    });
    assert.equal(seed.status, 200);
    assert.deepEqual(seed.body, { ok: true, seeded: 2 });

    // Both appear in the manifest (R12.7).
    const manifest = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(manifest.status, 200);
    const ids = manifest.body.map((e) => e.project_id);
    assert.ok(ids.includes(extension.project.project_id), 'extension sample in manifest');
    assert.ok(ids.includes(desktop.project.project_id), 'desktop-windows sample in manifest');

    // Read back content-equivalent to the bundled sample files (R12.6) — the
    // server stored them verbatim, never interpreting the docent_format stamp.
    const readExtension = await request(
      server.baseUrl,
      'GET',
      `/projects/${extension.project.project_id}`,
    );
    assert.equal(readExtension.status, 200);
    assert.deepEqual(readExtension.body, extension);
    assert.equal(readExtension.body.docent_format.platform, 'extension');

    const readDesktop = await request(
      server.baseUrl,
      'GET',
      `/projects/${desktop.project.project_id}`,
    );
    assert.equal(readDesktop.status, 200);
    assert.deepEqual(readDesktop.body, desktop);
    assert.equal(readDesktop.body.docent_format.platform, 'desktop-windows');
  });
});

describe('debug: seed with invalid JSON — POST /__debug/seed (R12.8)', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('responds 400 and leaves stored data unchanged', async () => {
    // Stage a known project first so we can confirm the store is untouched.
    await request(server.baseUrl, 'POST', '/__debug/seed', {
      body: [samplePayload('keep-me', 'Keep Me')],
    });
    const before = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(before.body.length, 1);

    // A malformed body (sent as-is by the harness) is rejected with 400 (R12.8).
    const seed = await request(server.baseUrl, 'POST', '/__debug/seed', {
      body: '{ not valid json',
    });
    assert.equal(seed.status, 400);

    // The store is unchanged: the pre-existing project is still the only one.
    const after = await request(server.baseUrl, 'GET', '/projects');
    assert.deepEqual(after.body, before.body);

    // And the staged project still reads back verbatim.
    const read = await request(server.baseUrl, 'GET', '/projects/keep-me');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, samplePayload('keep-me', 'Keep Me'));
  });
});
