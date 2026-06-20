/**
 * tests/conditional-write.test.js — integration suite for the optional
 * conditional-write enhancement (docent#152) of the Reference
 * Sync Server.
 *
 * These are example/integration tests (design's Testing Strategy): each test
 * spins the REAL server on an ephemeral port over a fresh temp storage dir via
 * the shared harness, then drives it over HTTP with `fetch`. No mocks — the ETag
 * advertisement, `If-Match` precondition, 412 rejection, last-write-wins, and
 * ETag determinism are all observed exactly as a client would see them
 * (the behavior is visible without inspecting server
 * internals).
 *
 * Coverage:
 *   - a GET of a stored project carries an `ETag` response header.
 *   - a successful PUT carries an `ETag` reflecting the newly stored content.
 *   - a PUT whose `If-Match` matches the stored ETag proceeds (200/201).
 *   - a PUT whose `If-Match` is stale is rejected 412, store unchanged.
 *   - a PUT with NO `If-Match` overwrites (last-write-wins).
 *   - the ETag is identical across two unchanged reads and differs after a
 *           content change.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/conditional-write.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, request } from './harness.js';

/** The id used across the suite; matches the payload's `project.project_id`. */
const PROJECT_ID = '0192f0a0-0000-7000-8000-0000000000c1';

/**
 * Build a representative Full_Project_Payload. `project.project_id` MUST equal
 * the path `:id`, so it is parameterized; `name` is parameterized so tests can
 * produce a distinct content (and therefore a distinct ETag) on demand.
 *
 * @param {string} [id]    the project id (must match the PUT path)
 * @param {string} [name]  the project name, used to vary content
 * @returns {object} a whole-project payload
 */
function samplePayload(id = PROJECT_ID, name = 'Conditional-write demo') {
  return {
    docent_format: { platform: 'extension', schema_version: '2.0.0' },
    project: {
      project_id: id,
      name,
      created_at: '2026-06-04T10:00:00.000Z',
    },
    recordings: [
      {
        recording_id: '0192f0a0-0000-7000-8000-0000000000aa',
        name: 'First recording',
        steps: [{ logical_id: 'a', uuid: 'u1', narration: 'hello' }],
      },
    ],
  };
}

describe('conditional write (docent#152)', () => {
  let server;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('GET /projects/:id of a stored project yields an ETag response header', async () => {
    const created = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: samplePayload(),
    });
    assert.equal(created.status, 201);

    const read = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(read.status, 200);
    assert.ok(read.headers.etag, 'a stored project read must advertise an ETag header');
    // ETag syntax: an opaque, double-quoted entity-tag.
    assert.match(read.headers.etag, /^".+"$/);
  });

  it('a successful PUT advertises an ETag header for create (201) and replace (200)', async () => {
    const created = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: samplePayload(),
    });
    assert.equal(created.status, 201);
    assert.ok(created.headers.etag, 'a create response must carry a fresh ETag');

    const replaced = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: samplePayload(PROJECT_ID, 'Renamed'),
    });
    assert.equal(replaced.status, 200);
    assert.ok(replaced.headers.etag, 'a replace response must carry a fresh ETag');
    // Content changed → the replace ETag must differ from the create ETag.
    assert.notEqual(replaced.headers.etag, created.headers.etag);
  });

  it('PUT with a matching If-Match → 200 and a fresh ETag', async () => {
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: samplePayload() });

    const read = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    const etag = read.headers.etag;

    const updated = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      headers: { 'if-match': etag },
      body: samplePayload(PROJECT_ID, 'Updated via matching If-Match'),
    });

    assert.equal(updated.status, 200);
    assert.ok(updated.headers.etag, 'a conditional write that proceeds must return a fresh ETag');
    assert.notEqual(updated.headers.etag, etag, 'content changed → the new ETag must differ');

    // Confirm the write actually applied.
    const reread = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(reread.body.project.name, 'Updated via matching If-Match');
    assert.equal(reread.headers.etag, updated.headers.etag);
  });

  it('PUT with a stale If-Match → 412, and the stored content is unchanged', async () => {
    // Create, capture the original ETag.
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: samplePayload() });
    const firstRead = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    const originalEtag = firstRead.headers.etag;

    // Apply a successful conditional write so the original ETag becomes stale.
    const goodUpdate = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      headers: { 'if-match': originalEtag },
      body: samplePayload(PROJECT_ID, 'Last successful write'),
    });
    assert.equal(goodUpdate.status, 200);

    // Now PUT again using the NOW-STALE original ETag → must be rejected 412.
    const stale = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      headers: { 'if-match': originalEtag },
      body: samplePayload(PROJECT_ID, 'Should NOT apply'),
    });
    assert.equal(stale.status, 412);

    // The 412 must not have modified stored data: read-back is the last
    // successful write, with the ETag that write produced.
    const reread = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.body.project.name, 'Last successful write');
    assert.equal(reread.headers.etag, goodUpdate.headers.etag);
  });

  it('PUT with NO If-Match overwrites (last-write-wins) → 200', async () => {
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: samplePayload() });

    // No If-Match header at all → unconditional overwrite regardless of the
    // stored project's current ETag.
    const overwrite = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: samplePayload(PROJECT_ID, 'Overwritten unconditionally'),
    });
    assert.equal(overwrite.status, 200);

    const reread = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(reread.body.project.name, 'Overwritten unconditionally');
  });

  it('the ETag is identical across two unchanged reads, and different after a content change', async () => {
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: samplePayload() });

    // Two reads of the same unchanged project → same ETag (determinism).
    const readA = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    const readB = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.ok(readA.headers.etag);
    assert.equal(readA.headers.etag, readB.headers.etag);

    // Change the content → the ETag must change (change-sensitivity).
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: samplePayload(PROJECT_ID, 'Different content now'),
    });
    const readC = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.notEqual(readC.headers.etag, readA.headers.etag);
  });

  it('end-to-end optimistic-concurrency flow stays observable to the client', async () => {
    // 1. Create via PUT (no If-Match → 201).
    const create = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: samplePayload(PROJECT_ID, 'v1'),
    });
    assert.equal(create.status, 201);

    // 2. GET it, capture the ETag.
    const read1 = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(read1.status, 200);
    const etagV1 = read1.headers.etag;
    assert.ok(etagV1);

    // 3. Conditional PUT with the matching ETag → 200 + a NEW ETag.
    const update = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      headers: { 'if-match': etagV1 },
      body: samplePayload(PROJECT_ID, 'v2'),
    });
    assert.equal(update.status, 200);
    const etagV2 = update.headers.etag;
    assert.ok(etagV2);
    assert.notEqual(etagV2, etagV1);

    // 4. Re-GET confirms the content changed and the ETag changed.
    const read2 = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(read2.body.project.name, 'v2');
    assert.equal(read2.headers.etag, etagV2);
    assert.notEqual(read2.headers.etag, etagV1);

    // 5. Conditional PUT with the now-stale v1 ETag → 412, store unchanged.
    const stale = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      headers: { 'if-match': etagV1 },
      body: samplePayload(PROJECT_ID, 'v3-should-not-apply'),
    });
    assert.equal(stale.status, 412);

    const read3 = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(read3.body.project.name, 'v2', 'the 412 must not have modified stored data');
    assert.equal(read3.headers.etag, etagV2);

    // 6. Two GETs of the unchanged project return the same ETag.
    const read4 = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(read4.headers.etag, read3.headers.etag);
  });
});
