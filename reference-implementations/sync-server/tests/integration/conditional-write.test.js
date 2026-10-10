/**
 * tests/conditional-write.test.js — integration suite for the optional
 * conditional-write enhancement (docent#152) of the Reference
 * Sync Server.
 *
 * These are example/integration tests: each test
 * spins the REAL server on an ephemeral port over a fresh temp storage dir via
 * the shared harness, then drives it over HTTP with `fetch`; a case that needs
 * repeated header lines on the wire sends them with `node:http`, since `fetch`
 * joins header values before they leave the client. No mocks — the ETag
 * advertisement, `If-Match` precondition, 412 rejection, last-write-wins, and
 * ETag determinism are all observed exactly as a client would see them
 * (the behavior is visible without inspecting server
 * internals).
 *
 * Coverage:
 *   - a GET of a stored project carries an `ETag` response header.
 *   - a successful PUT carries an `ETag` reflecting the newly stored content.
 *   - a PUT whose `If-Match` matches the stored ETag proceeds (200).
 *   - an entity-tag list holding the current ETag proceeds, and `*` on a
 *           stored project proceeds.
 *   - an entity-tag list holding a weak tag beside the current ETag proceeds.
 *   - repeated `If-Match` lines, the current ETag between stale tags,
 *           proceed: the lines are read as one list.
 *   - repeated `If-Match` lines holding only stale tags are rejected 412,
 *           store unchanged.
 *   - a PUT whose `If-Match` is stale is rejected 412, store unchanged.
 *   - a weak tag of the current ETag is rejected 412, store unchanged.
 *   - a PUT carrying an `If-Match` for an id with nothing stored is rejected
 *           412, and the store still holds nothing for that id.
 *   - `*` for an id with nothing stored is rejected 412, the store still
 *           holding nothing for that id.
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
import http from 'node:http';

import { startTestServer, request } from './harness.js';

/** The id used across the suite; matches the payload's `project.project_id`. */
const PROJECT_ID = '0192f0a0-0000-7000-8000-0000000000c1';

/**
 * A second id, deliberately never stored, for the no-project-stored row of the
 * `If-Match` decision table.
 */
const UNSTORED_PROJECT_ID = '0192f0a0-0000-7000-8000-0000000000c2';

/**
 * A syntactically valid entity-tag no stored project can carry, for a
 * precondition that is present and cannot match.
 */
const UNMATCHABLE_ETAG = '"an-etag-no-stored-project-carries"';

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

/**
 * Store a project, then PUT it again carrying the If-Match value `formOf`
 * builds from its current ETag, sent by `send`; return the PUT's status and the
 * read-back.
 *
 * @param {{ baseUrl: string }} server  a started test server
 * @param {(etag: string) => string | string[]} formOf  builds the If-Match
 *   value (an array is one value per header line, for a sender that writes it so)
 * @param {typeof request} [send]  sends the PUT; the harness `request` by default
 * @returns {Promise<{ status: number, name: string, etagBefore: string, etagAfter: string }>}
 */
async function putWithFormOfCurrentETag(server, formOf, send = request) {
  await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: samplePayload() });
  const before = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
  const put = await send(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
    headers: { 'if-match': formOf(before.headers.etag) },
    body: samplePayload(PROJECT_ID, 'Written under the If-Match form'),
  });
  const after = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
  return {
    status: put.status,
    name: after.body.project.name,
    etagBefore: before.headers.etag,
    etagAfter: after.headers.etag,
  };
}

/**
 * Send a JSON request with `node:http`, taking the harness `request`'s
 * arguments, and writing each member of an array header value as its own
 * header line (`fetch` joins header values on the client before they reach the
 * wire, so it cannot send repeated lines).
 *
 * @param {string} baseUrl  the server's base URL
 * @param {string} method  the HTTP method
 * @param {string} path  the request path
 * @param {{ headers?: Record<string, string | string[]>, body: object }} options
 *   the request headers and the JSON body
 * @returns {Promise<{ status: number }>} the response status
 */
function sendWithRepeatedHeaderLines(baseUrl, method, path, { headers = {}, body }) {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, baseUrl),
      {
        method,
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

/**
 * Seed one unrelated project with an unconditional PUT, then PUT a project under
 * the never-stored id carrying `ifMatch`; return the PUT's status, the
 * read-back status of the refused id and the ids the manifest holds.
 *
 * The seed makes the manifest assertion measure preservation rather than an
 * empty store, and lets a `*` that passes whenever the store holds anything
 * show itself.
 *
 * @param {{ baseUrl: string }} server  a started test server
 * @param {string} ifMatch  the If-Match value
 * @returns {Promise<{ status: number, readStatus: number, manifestIds: string[] }>}
 */
async function putWithNoProjectStored(server, ifMatch) {
  const seeded = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
    body: samplePayload(PROJECT_ID, 'Stored before the refused write'),
  });
  assert.equal(seeded.status, 201);

  const put = await request(server.baseUrl, 'PUT', `/projects/${UNSTORED_PROJECT_ID}`, {
    headers: { 'if-match': ifMatch },
    body: samplePayload(UNSTORED_PROJECT_ID, 'Should NOT be created'),
  });

  // The store is read back through the same HTTP surface a client has.
  const read = await request(server.baseUrl, 'GET', `/projects/${UNSTORED_PROJECT_ID}`);
  const manifest = await request(server.baseUrl, 'GET', '/projects');
  assert.equal(manifest.status, 200);
  return {
    status: put.status,
    readStatus: read.status,
    manifestIds: manifest.body.map((entry) => entry.project_id),
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

  it('PUT with an If-Match and no project stored → 412, and nothing is created', async () => {
    // The no-project-stored row of SP-14's If-Match table, observed end-to-end
    // over HTTP: an `If-Match` names a stored version to write against, and the
    // store holds none for this id, so the precondition fails and the write is
    // refused.
    const r = await putWithNoProjectStored(server, UNMATCHABLE_ETAG);
    assert.equal(r.status, 412);

    // The store is unchanged: the refused id reads as absent, and the manifest
    // holds exactly the ids that were stored before the refused write (here,
    // the seeded one).
    assert.equal(r.readStatus, 404, 'the refused write stored no project');
    assert.deepEqual(
      r.manifestIds,
      [PROJECT_ID],
      'the refused write added no manifest entry and removed none',
    );
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

  it('PUT with an entity-tag list holding the current ETag → 200', async () => {
    const r = await putWithFormOfCurrentETag(server, (etag) => `"other", ${etag}`);
    assert.equal(r.status, 200);
    assert.equal(r.name, 'Written under the If-Match form');
    assert.notEqual(r.etagAfter, r.etagBefore, 'content changed → a fresh ETag');
  });

  it('PUT with an entity-tag list holding a weak tag and the current ETag → 200', async () => {
    const r = await putWithFormOfCurrentETag(server, (etag) => `W/"other", ${etag}`);
    assert.equal(r.status, 200);
    assert.equal(r.name, 'Written under the If-Match form');
    assert.notEqual(r.etagAfter, r.etagBefore, 'content changed → a fresh ETag');
  });

  it('PUT with repeated If-Match lines, the current ETag between stale tags → 200', async () => {
    const r = await putWithFormOfCurrentETag(
      server,
      (etag) => ['"a"', etag, '"b"'],
      sendWithRepeatedHeaderLines,
    );
    assert.equal(r.status, 200);
    assert.equal(r.name, 'Written under the If-Match form');
    assert.notEqual(r.etagAfter, r.etagBefore, 'content changed → a fresh ETag');
  });

  it('PUT with repeated stale If-Match lines → 412, and the stored content is unchanged', async () => {
    const r = await putWithFormOfCurrentETag(
      server,
      () => ['"a"', '"b"'],
      sendWithRepeatedHeaderLines,
    );
    assert.equal(r.status, 412);
    assert.equal(r.name, 'Conditional-write demo');
    assert.equal(r.etagAfter, r.etagBefore);
  });

  it('PUT with If-Match: * on a stored project → 200', async () => {
    const r = await putWithFormOfCurrentETag(server, () => '*');
    assert.equal(r.status, 200);
    assert.equal(r.name, 'Written under the If-Match form');
    assert.notEqual(r.etagAfter, r.etagBefore, 'content changed → a fresh ETag');
  });

  it('PUT with a weak If-Match of the current ETag → 412, and the stored content is unchanged', async () => {
    const r = await putWithFormOfCurrentETag(server, (etag) => `W/${etag}`);
    assert.equal(r.status, 412);
    assert.equal(r.name, 'Conditional-write demo');
    assert.equal(r.etagAfter, r.etagBefore);
  });

  it('PUT with If-Match: * and no project stored → 412, and nothing is created', async () => {
    // `*` matches only when a project is stored under the request's id; the
    // seeded project sits under another id.
    const r = await putWithNoProjectStored(server, '*');
    assert.equal(r.status, 412);
    assert.equal(r.readStatus, 404, 'the refused write stored no project');
    assert.deepEqual(
      r.manifestIds,
      [PROJECT_ID],
      'the refused write added no manifest entry and removed none',
    );
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
