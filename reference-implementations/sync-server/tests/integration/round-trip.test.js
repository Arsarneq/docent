/**
 * round-trip.test.js — the verbatim round-trip fidelity suite for the Reference
 * Sync Server.
 *
 * The server is opaque: a payload stored through `PUT /projects/:id` and read
 * back through `GET /projects/:id` must be content-equivalent to what was
 * written — the server must NOT validate, reshape, drop unknown fields,
 * meaningfully reorder, or inject any server-side metadata. This suite drives
 * the REAL server over HTTP via the integration harness and proves that
 * fidelity against a deliberately rich, representative payload:
 *
 *   - a `docent_format` stamp;
 *   - MULTIPLE recordings;
 *   - full step history INCLUDING deleted steps and re-recorded steps that
 *     reuse a `logical_id`;
 *   - an unrecognized/unknown top-level field the server does not understand
 *     (preserved verbatim).
 *
 * It also pins the `last_modified` isolation contract: the server-maintained
 * `last_modified` lives only in the
 * storage wrapper and surfaces in the manifest, but is NEVER merged into the
 * verbatim payload returned by `GET /projects/:id`.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/round-trip
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, request } from './harness.js';

const PROJECT_ID = '019e11fd-78ba-7fdb-8362-6fe9f697f641';

/**
 * Build a deliberately rich `Full_Project_Payload` (shape per
 * `docs/api/sync-protocol.md`) that exercises every fidelity concern:
 *
 *   - a `docent_format` stamp;
 *   - TWO recordings;
 *   - full step history with a `deleted: true` step and a re-recorded step that
 *     reuses an earlier step's `logical_id`;
 *   - a top-level field the server does not recognize, `x_custom_extension_field`
 * — the server must preserve it untouched.
 *
 * A fresh object is returned per call so a test can mutate its local copy
 * without affecting the value sent over the wire.
 *
 * @returns {object} the payload to PUT.
 */
function buildRichPayload() {
  return {
    docent_format: {
      platform: 'extension',
      schema_version: '2.0.0',
    },
    project: {
      project_id: PROJECT_ID,
      name: 'Expense report submission',
      created_at: '2026-05-10T13:04:44.730Z',
      metadata: {
        jira: 'EXP-123',
        tags: ['expenses', 'submission'],
      },
    },
    recordings: [
      {
        recording_id: '019e12a4-0278-7c8e-aae6-01c26f002efb',
        name: 'Submit a new expense report',
        created_at: '2026-05-10T16:06:38.968Z',
        metadata: { ticket: 'EXP-456' },
        steps: [
          // An original step.
          {
            uuid: '019e12a4-633d-74d2-acd5-584085fb57f9',
            logical_id: '019e12a4-633d-74d2-acd5-584085fb57f9',
            step_number: 1,
            created_at: '2026-05-10T16:06:39.000Z',
            narration: 'Open the expense form and enter the report details',
            narration_source: 'typed',
            actions: [
              {
                type: 'navigate',
                timestamp: 1715353599000,
                context_id: 1,
                capture_mode: 'dom',
                nav_type: 'typed',
                url: 'https://app.example.com/expenses',
              },
            ],
            deleted: false,
          },
          // A DELETED step — full history must be preserved verbatim.
          {
            uuid: '019e12a4-733d-74d2-acd5-584085fb5800',
            logical_id: '019e12a4-733d-74d2-acd5-584085fb5800',
            step_number: 2,
            created_at: '2026-05-10T16:06:40.000Z',
            narration: 'Old click on the wrong button',
            narration_source: 'typed',
            actions: [
              {
                type: 'click',
                timestamp: 1715353600000,
                context_id: 1,
                capture_mode: 'dom',
                x: 100,
                y: 200,
                element: {
                  tag: 'BUTTON',
                  id: 'cancel-btn',
                  name: null,
                  role: 'button',
                  type: 'button',
                  text: 'Cancel',
                  selector: '#cancel-btn',
                },
              },
            ],
            deleted: true,
          },
          // A RE-RECORDED step: a new uuid that REUSES the deleted step's
          // logical_id, representing a fresh recording of the same logical step.
          // The server must keep both versions, in order, untouched.
          {
            uuid: '019e12a4-833d-74d2-acd5-584085fb5901',
            logical_id: '019e12a4-733d-74d2-acd5-584085fb5800',
            step_number: 3,
            created_at: '2026-05-10T16:07:10.000Z',
            narration: 'Click the submit button',
            narration_source: 'typed',
            actions: [
              {
                type: 'click',
                timestamp: 1715353630000,
                context_id: 1,
                capture_mode: 'dom',
                x: 512,
                y: 340,
                element: {
                  tag: 'BUTTON',
                  id: 'submit-btn',
                  name: null,
                  role: 'button',
                  type: 'submit',
                  text: 'Submit report',
                  selector: '#submit-btn',
                },
              },
            ],
            deleted: false,
          },
        ],
      },
      {
        // A SECOND recording — including one with an empty step history,
        // which the server must also preserve verbatim.
        recording_id: '019e2b4a-1234-7abc-9def-abcdef012345',
        name: 'Logout flow',
        created_at: '2026-05-11T09:15:00.000Z',
        metadata: {},
        steps: [
          {
            uuid: '019e2b4a-2345-74d2-acd5-584085fbaa01',
            logical_id: '019e2b4a-2345-74d2-acd5-584085fbaa01',
            step_number: 1,
            created_at: '2026-05-11T09:15:01.000Z',
            step_type: 'validation',
            expect: 'present',
            actions: [
              {
                type: 'click',
                timestamp: 1715418901000,
                context_id: 1,
                capture_mode: 'dom',
                element: {
                  tag: 'A',
                  id: 'logout-link',
                  name: null,
                  role: 'link',
                  type: null,
                  text: 'Log out',
                  selector: '#logout-link',
                },
              },
            ],
            deleted: false,
          },
        ],
      },
    ],
    // An UNRECOGNIZED top-level field the server does not understand. A truly
    // opaque, verbatim store must preserve it exactly.
    x_custom_extension_field: {
      experimental_flag: true,
      nested: { count: 3, labels: ['a', 'b'], ratio: 0.75 },
      list: [1, 2, 3],
    },
  };
}

describe('round-trip fidelity', () => {
  let server;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it('returns a payload content-equivalent to what was written, incl. stamp, multiple recordings, deleted + re-recorded steps, and unknown top-level fields', async () => {
    const written = buildRichPayload();

    // PUT the rich payload (create → 201).
    const putRes = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: written,
    });
    assert.equal(putRes.status, 201, 'first write of a new project should be 201 Created');
    assert.deepEqual(putRes.body, { ok: true });

    // GET it back.
    const getRes = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.equal(getRes.status, 200);

    // Verbatim fidelity: the returned payload deep-equals what was written.
    // The server must not reshape, drop the unknown field, reorder
    // meaningfully, or inject any field.
    assert.deepEqual(
      getRes.body,
      written,
      'GET payload must be content-equivalent to the PUT body',
    );
  });

  it('preserves the docent_format stamp and the unrecognized top-level field verbatim', async () => {
    const written = buildRichPayload();
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: written });

    const { body } = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);

    assert.deepEqual(body.docent_format, written.docent_format, 'docent_format stamp preserved');
    assert.deepEqual(
      body.x_custom_extension_field,
      written.x_custom_extension_field,
      'unknown top-level field preserved verbatim',
    );
    // The exact set of top-level keys is preserved — nothing dropped, nothing added.
    assert.deepEqual(Object.keys(body).sort(), Object.keys(written).sort());
  });

  it('preserves the complete recordings array and full step history incl. deleted + re-recorded steps', async () => {
    const written = buildRichPayload();
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: written });

    const { body } = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);

    // Both recordings are returned, in order, with their full step history.
    assert.deepEqual(body.recordings, written.recordings);

    const [firstRecording] = body.recordings;
    assert.equal(firstRecording.steps.length, 3, 'all three steps retained, none filtered');

    // The deleted step is preserved (not dropped because deleted: true).
    const deletedStep = firstRecording.steps.find((s) => s.deleted === true);
    assert.ok(deletedStep, 'deleted step is preserved in the returned history');

    // The re-recorded step reuses the deleted step's logical_id but has its own
    // uuid — both versions survive the round trip.
    const sharedLogicalId = deletedStep.logical_id;
    const sameLogical = firstRecording.steps.filter((s) => s.logical_id === sharedLogicalId);
    assert.equal(sameLogical.length, 2, 're-recorded step shares logical_id with the deleted one');
    const uuids = new Set(sameLogical.map((s) => s.uuid));
    assert.equal(uuids.size, 2, 'the two versions have distinct uuids');
  });

  it('never injects the wrapper last_modified into the returned payload', async () => {
    const written = buildRichPayload();
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: written });

    const { body } = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);

    // The server-maintained `last_modified` lives only in the storage wrapper /
    // the manifest — it must NOT appear as a top-level payload field.
    assert.equal(
      'last_modified' in body,
      false,
      "the wrapper's last_modified must not leak into the verbatim payload",
    );

    // Sanity: the manifest DOES carry a server last_modified for this project,
    // confirming the field exists on the server side but is kept out of the payload.
    const manifest = await request(server.baseUrl, 'GET', '/projects');
    assert.equal(manifest.status, 200);
    const entry = manifest.body.find((e) => e.project_id === PROJECT_ID);
    assert.ok(entry, 'project appears in the manifest');
    assert.equal(typeof entry.last_modified, 'string', 'manifest carries a server last_modified');
  });

  it('survives a replace (PUT over an existing project) with full fidelity', async () => {
    // First write.
    await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, { body: buildRichPayload() });

    // A second, modified write (replace → 200) must also round-trip verbatim.
    const replacement = buildRichPayload();
    replacement.project.name = 'Expense report submission (v2)';
    replacement.recordings[0].steps.push({
      uuid: '019e12a4-933d-74d2-acd5-584085fb5a02',
      logical_id: '019e12a4-933d-74d2-acd5-584085fb5a02',
      step_number: 4,
      created_at: '2026-05-10T16:08:00.000Z',
      narration: 'Assert dashboard is visible',
      narration_source: 'typed',
      actions: [],
      deleted: false,
    });
    replacement.x_custom_extension_field.nested.count = 99;

    const putRes = await request(server.baseUrl, 'PUT', `/projects/${PROJECT_ID}`, {
      body: replacement,
    });
    assert.equal(putRes.status, 200, 'replacing an existing project should be 200 OK');

    const { body } = await request(server.baseUrl, 'GET', `/projects/${PROJECT_ID}`);
    assert.deepEqual(body, replacement, 'the replacement payload round-trips verbatim');
    assert.equal('last_modified' in body, false);
  });
});
