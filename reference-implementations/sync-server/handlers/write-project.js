/**
 * write-project.js — the `PUT /projects/:id` handler for the Reference Sync
 * Server (plus the optional conditional write).
 *
 * This is a whole-project write: the client always sends a complete
 * `Full_Project_Payload`, and the server stores it VERBATIM, replacing any prior
 * stored copy. The handler never validates, reshapes, or
 * interprets the `docent_format` stamp, recordings, or steps — the only field it
 * reads from the body is `project.project_id`, solely to confirm it matches the
 * path `:id`.
 *
 * Processing order (the router applies auth → routing before this handler runs):
 *
 *   1. Read + parse the request body.       invalid JSON              → 400
 *   2. Confirm path `:id` == body project id. mismatch                → 400
 *   3. Load the currently stored record.
 *   4. Evaluate the conditional-write gate.   If-Match mismatch        → 412
 *   5. Store the payload verbatim with a server-set `last_modified`.
 *   6. Respond 201 (create) / 200 (replace) + fresh `ETag` + `{ ok: true }`.
 *
 * A request rejected at steps 1, 2, or 4 never touches the store, so stored data
 * is left unchanged on every 400/412 path.
 *
 * The conditional-write decision is delegated to the explicitly named
 * `evaluateConditionalWrite` unit, never inlined here as a
 * hidden side effect.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module handlers/write-project
 */

import { deriveETag } from '../etag.js';
import { evaluateConditionalWrite } from '../conditional-write.js';

/**
 * @typedef {import('../storage/provider.js').StorageProvider} StorageProvider
 */

/**
 * Buffer the full request body as a UTF-8 string.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>} The raw request body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Write a JSON response with the given status code and optional extra headers.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body            JSON-serializable response body.
 * @param {Record<string,string>} [extraHeaders] Additional response headers
 *   (e.g. an `ETag`), merged on top of `Content-Type: application/json`.
 */
function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/**
 * Handle `PUT /projects/:id` — create-or-replace a project's verbatim payload.
 *
 * @param {StorageProvider} storage
 *   The injected Storage_Provider; the only path to stored projects.
 * @param {import('node:http').IncomingMessage} req
 *   The incoming request. Its body is buffered + parsed as JSON, and the
 *   `If-Match` header (`req.headers['if-match']`) feeds the conditional-write
 *   gate.
 * @param {import('node:http').ServerResponse} res
 *   The response, written via `res.writeHead` / `res.end`.
 * @param {string} id
 *   The path `:id` parameter, already extracted by the router.
 * @returns {Promise<void>}
 */
export async function writeProject(storage, req, res, id) {
  // ── Step 1: read + parse the body. Invalid JSON → 400, store unchanged.
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Request body is not valid JSON.' });
    return;
  }

  // ── Step 2: the path `:id` must equal the body's `project.project_id`
  // (Full_Project_Payload shape). Any mismatch — including a body that is not an
  // object or is missing `project` — is rejected with 400, store unchanged.
  // The server reads ONLY this field from the body; everything else is
  // opaque.
  const bodyProjectId =
    payload && typeof payload === 'object' && payload.project
      ? payload.project.project_id
      : undefined;
  if (bodyProjectId !== id) {
    sendJson(res, 400, {
      error: 'Path id does not match the project_id in the request body.',
    });
    return;
  }

  // ── Step 3: load the currently stored record (null when absent).
  const existing = await storage.read(id);

  // ── Step 4: the explicit conditional-write gate (docent#152). On an
  // If-Match mismatch this returns { proceed: false, status: 412 }; we reject and
  // leave stored data untouched. An absent If-Match is last-write-wins;
  // a matching If-Match proceeds.
  const ifMatch = req.headers['if-match'];
  const decision = evaluateConditionalWrite(ifMatch, existing);
  if (!decision.proceed) {
    sendJson(res, decision.status, {
      error: 'If-Match precondition failed: stored ETag does not match.',
    });
    return;
  }

  // ── Step 5: store the payload verbatim with a server-set `last_modified`
  // timestamp. The timestamp is server metadata kept alongside the
  // payload by the provider; it is never merged into the payload itself.
  const lastModified = new Date().toISOString();
  const { created } = await storage.put(id, payload, lastModified);

  // ── Step 6: respond 201 (create) / 200 (replace) with a fresh ETag reflecting
  // the newly stored content and the minimal `{ ok: true }` body.
  // The ETag is derived from the stored payload content only.
  const etag = deriveETag(payload);
  sendJson(res, created ? 201 : 200, { ok: true }, { ETag: etag });
}
