/**
 * read-project.js — the `GET /projects/:id` handler for the Reference Sync
 * Server (plus the ETag advertisement).
 *
 * The server is opaque: a stored project is returned EXACTLY as it was written,
 * with no validation, reshaping, or interpretation of the `docent_format`
 * stamp, recordings, or steps. The handler reads only
 * `record.payload` — the server-maintained `last_modified` lives in the storage
 * wrapper and is never merged into the returned payload.
 *
 * Behavior:
 *   - stored project  → 200, body = verbatim `record.payload`,
 *                       `Content-Type: application/json`,
 *                       and an `ETag` header derived from the payload content
 *                       only.
 *   - not stored      → 404.
 *
 * Calling convention: the router resolves the path `:id` and the storage seam,
 * then calls `readProject(storage, req, res, id)`. The handler talks only to the
 * injected `Storage_Provider` and writes the response itself,
 * matching the sibling handlers so the router (`router.js`) composes uniformly.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module handlers/read-project
 */

import { deriveETag } from '../etag.js';

/**
 * Handle a `GET /projects/:id` request.
 *
 * @param {import('../storage/provider.js').StorageProvider} storage
 *   The injected Storage_Provider; the only path to stored projects.
 * @param {import('node:http').IncomingMessage} req
 *   The incoming request. Not read here (the id is supplied separately by the
 *   router); accepted for a uniform handler signature.
 * @param {import('node:http').ServerResponse} res
 *   The response to write.
 * @param {string} id
 *   The `project_id` parsed from the request path by the router.
 * @returns {Promise<void>}
 */
export async function readProject(storage, req, res, id) {
  const record = await storage.read(id);

  // Nothing stored for this id → 404.
  if (record === null || record === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  // Return the verbatim payload as JSON with an
  // ETag derived from the payload content only (never `last_modified`). The
  // payload is serialized as-is — no validation or reshaping.
  const body = JSON.stringify(record.payload);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    ETag: deriveETag(record.payload),
    // Never let a browser-based client (the Chrome extension's webview `fetch`)
    // serve a STALE project from its HTTP cache: with an ETag but no freshness
    // header, the browser may reuse a prior body and the sync client would miss a
    // concurrent server change. The client also sends `cache: no-store`, but a
    // compliant server should not rely on that. (Docent clients are the only
    // intended consumers; this is not a CORS/consumer-API affordance.)
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
