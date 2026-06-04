/**
 * write-project.js — the `PUT /projects/:id` handler for the Reference Sync
 * Server (Requirement 3, plus the optional conditional write of Requirement 6).
 *
 * This is a whole-project write: the client always sends a complete
 * `Full_Project_Payload`, and the server stores it VERBATIM, replacing any prior
 * stored copy (Requirements 3.5, 4). The handler never validates, reshapes, or
 * interprets the `docent_format` stamp, recordings, or steps — the only field it
 * reads from the body is `project.project_id`, solely to confirm it matches the
 * path `:id` (Requirement 3.3).
 *
 * Processing order (matching the design's request flow and precedence rule):
 *
 *   1. Read + parse the request body.       invalid JSON              → 400 (R3.4)
 *   2. Confirm path `:id` == body project id. mismatch                → 400 (R3.3)
 *   3. Load the currently stored record.
 *   4. Evaluate the conditional-write gate.   If-Match mismatch        → 412 (R6.4)
 *   5. Store the payload verbatim with a server-set `last_modified`.   (R3.5, R3.7)
 *   6. Respond 201 (create) / 200 (replace) + fresh `ETag` + `{ ok: true }`.
 *                                                       (R3.1, R3.2, R3.6, R6.2)
 *
 * A request rejected at steps 1, 2, or 4 never touches the store, so stored data
 * is left unchanged on every 400/412 path (Requirements 3.3, 3.4, 6.4).
 *
 * The conditional-write decision is delegated to the explicitly named
 * `evaluateConditionalWrite` unit (Requirement 11.1), never inlined here as a
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
 *   The injected Storage_Provider; the only path to stored projects
 *   (Requirement 7.1).
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
  // ── Step 1: read + parse the body. Invalid JSON → 400, store unchanged (R3.4).
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
  // object or is missing `project` — is rejected with 400, store unchanged
  // (R3.3). The server reads ONLY this field from the body; everything else is
  // opaque (R3.5).
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

  // ── Step 4: the explicit conditional-write gate (docent#152, R11.1). On an
  // If-Match mismatch this returns { proceed: false, status: 412 }; we reject and
  // leave stored data untouched (R6.4). An absent If-Match is last-write-wins
  // (R6.5); a matching If-Match proceeds (R6.3).
  const ifMatch = req.headers['if-match'];
  const decision = evaluateConditionalWrite(ifMatch, existing);
  if (!decision.proceed) {
    sendJson(res, decision.status, {
      error: 'If-Match precondition failed: stored ETag does not match.',
    });
    return;
  }

  // ── Step 5: store the payload verbatim with a server-set `last_modified`
  // timestamp (R3.5, R3.7). The timestamp is server metadata kept alongside the
  // payload by the provider; it is never merged into the payload itself.
  const lastModified = new Date().toISOString();
  const { created } = await storage.put(id, payload, lastModified);

  // ── Step 6: respond 201 (create) / 200 (replace) with a fresh ETag reflecting
  // the newly stored content (R6.2) and the minimal `{ ok: true }` body (R3.6).
  // The ETag is derived from the stored payload content only (R6.1, R6.6).
  const etag = deriveETag(payload);
  sendJson(res, created ? 201 : 200, { ok: true }, { ETag: etag });
}
