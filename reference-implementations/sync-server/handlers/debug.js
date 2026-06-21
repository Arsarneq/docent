/**
 * debug.js — the non-protocol Debug_Affordances for the Reference Sync Server,
 * all served under the distinct `/__debug/` path prefix.
 *
 * These routes exist purely to ease manual end-to-end testing; they are NOT part
 * of the Sync_Protocol and a protocol-only client never depends on them.
 * They live behind the `/__debug/` prefix so they can
 * never be confused with the three protocol endpoints, and the router applies
 * the same Bearer-token auth to them as to protocol routes, so
 * a configured token leaves no unauthenticated state-mutating endpoint.
 *
 * Three affordances:
 *
 *   - POST /__debug/reset → clear every stored project and report the count
 *                           removed: `{ ok: true, cleared: <n> }`.
 *   - GET  /__debug/dump  → a read-only per-project summary
 *                           `{ count, projects: [{ project_id, name,
 *                           last_modified, etag }] }`, WITHOUT mutating stored
 *                           state. The full payload is obtained through
 *                           `GET /projects/:id`, not here.
 *   - POST /__debug/seed  → store one or more payloads directly through the
 *                           Storage_Provider exactly as a PUT would (verbatim,
 *                           opaque, server-set `last_modified`) WITHOUT a client
 *                           push. The body is either an array of caller
 *                           payloads or `{ samples: true }` to use the bundled
 *                           both-platform sample payloads. Invalid JSON
 *                           → 400, store unchanged. The server never
 *                           reads the `docent_format` stamp of a seeded payload.
 *
 * Opacity: like the protocol handlers, the seed path reads ONLY
 * `payload.project.project_id` (to derive the storage id, exactly as a PUT
 * does) and nothing else — never the `docent_format` stamp, recordings, or
 * steps.
 *
 * Calling convention: the router resolves the storage seam and the `/__debug/`
 * sub-path, then calls `handleDebug(storage, req, res, subPath)` where `subPath`
 * is the segment after `/__debug/` (e.g. `'reset'`, `'dump'`, `'seed'`). This
 * mirrors the `(storage, req, res, …)` shape of the read/write handlers so the
 * router composes the protocol and debug handlers uniformly. `handleDebug`
 * itself validates the method for each known sub-path (405 on a mismatch) and
 * returns 404 for an unknown debug sub-path, so the whole `/__debug/*` namespace
 * can be delegated to it. The individual route functions are also exported for
 * direct use/testing.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module handlers/debug
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveETag } from '../etag.js';

/**
 * @typedef {import('../storage/provider.js').StorageProvider} StorageProvider
 */

/** Absolute path to the bundled `samples/` directory, relative to this module. */
const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

/** The bundled both-platform sample filenames used by `{ samples: true }`. */
const SAMPLE_FILES = ['extension-sample.json', 'desktop-windows-sample.json'];

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
 * @param {Record<string,string>} [extraHeaders]
 */
function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

/**
 * Handle `POST /__debug/reset`: clear every stored project and report how many
 * were removed, so a tester can return the server to a known empty state and a
 * subsequent `GET /projects` returns `[]`.
 *
 * @param {StorageProvider} storage The injected Storage_Provider.
 * @param {import('node:http').IncomingMessage} _req Unused; reset takes no body.
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function debugReset(storage, _req, res) {
  const cleared = await storage.clear();
  sendJson(res, 200, { ok: true, cleared });
}

/**
 * Handle `GET /__debug/dump`: return a read-only per-project summary of the
 * current stored state — for each project its `project_id`, `name`,
 * server-maintained `last_modified`, and current `etag` — WITHOUT altering
 * stored data. The summary is derived through the storage
 * seam: `list()` for the manifest fields and `read()` per project to compute the
 * content-derived ETag (`deriveETag`). It returns this summary, not verbatim
 * payloads — a full payload is fetched through `GET /projects/:id`.
 *
 * @param {StorageProvider} storage The injected Storage_Provider.
 * @param {import('node:http').IncomingMessage} _req Unused; dump takes no body.
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function debugDump(storage, _req, res) {
  const entries = await storage.list();
  const projects = [];
  for (const entry of entries) {
    // Read the verbatim payload only to derive its content ETag; this is a pure
    // read and never mutates the stored record.
    const record = await storage.read(entry.project_id);
    projects.push({
      project_id: entry.project_id,
      name: entry.name,
      last_modified: entry.last_modified,
      etag: record ? deriveETag(record.payload) : undefined,
    });
  }
  sendJson(res, 200, { count: projects.length, projects });
}

/**
 * Load the bundled both-platform sample payloads (one stamped `extension`, one
 * stamped `desktop-windows`) for the `{ samples: true }` seed path.
 * Read with `fs.readFile` + `JSON.parse` so the affordance
 * stays portable if the server is copied out of the monorepo.
 *
 * @returns {Promise<object[]>} The parsed sample payloads.
 */
async function loadSamplePayloads() {
  const payloads = [];
  for (const file of SAMPLE_FILES) {
    const contents = await readFile(path.join(SAMPLES_DIR, file), 'utf8');
    payloads.push(JSON.parse(contents));
  }
  return payloads;
}

/**
 * Handle `POST /__debug/seed`: store one or more payloads directly through the
 * Storage_Provider, exactly as a `PUT` would (verbatim, opaque, with a
 * server-set `last_modified`), WITHOUT requiring a client push (Requirement
 * 12.5). The body is parsed as JSON and must be either:
 *
 *   - an array of caller-supplied Full_Project_Payloads, or
 *   - `{ samples: true }` to seed the bundled both-platform samples.
 *
 * Invalid JSON is rejected with HTTP 400 and leaves stored data unchanged — the
 * parse happens before any write, so nothing is stored on the 400 path.
 * A valid-JSON body that is neither an array nor
 * `{ samples: true }` is likewise a malformed seed request → 400.
 *
 * The storage id for each payload is derived from `payload.project.project_id`,
 * exactly as the write handler derives it; the server reads nothing else from a
 * seeded payload and never inspects its `docent_format` stamp (Requirement
 * 12.6). Responds `{ ok: true, seeded: <n> }`.
 *
 * @param {StorageProvider} storage The injected Storage_Provider.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function debugSeed(storage, req, res) {
  // ── Parse the body. Invalid JSON → 400, store unchanged: the parse
  // precedes every write, so a rejection never touches the store.
  const raw = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Seed request body is not valid JSON.' });
    return;
  }

  // ── Resolve the payloads to seed: an explicit array, or the bundled samples
  // when `{ samples: true }`. Anything else is a malformed seed shape → 400.
  let payloads;
  if (Array.isArray(parsed)) {
    payloads = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && parsed.samples === true) {
    payloads = await loadSamplePayloads();
  } else {
    sendJson(res, 400, {
      error: 'Seed body must be an array of payloads or { "samples": true }.',
    });
    return;
  }

  // ── Store each payload exactly as a PUT would: verbatim and opaque, with a
  // server-set `last_modified`, without a client push. The id is
  // derived solely from `payload.project.project_id`, like the write handler.
  let seeded = 0;
  for (const payload of payloads) {
    const id =
      payload && typeof payload === 'object' && payload.project
        ? payload.project.project_id
        : undefined;
    const lastModified = new Date().toISOString();
    await storage.put(id, payload, lastModified);
    seeded += 1;
  }

  sendJson(res, 200, { ok: true, seeded });
}

/**
 * Dispatch a `/__debug/*` request to the matching affordance.
 *
 * The router resolves the storage seam and the sub-path after `/__debug/`, then
 * delegates the whole debug namespace here. This validates the HTTP method for
 * each known sub-path (405 on a mismatch) and returns 404 for an unknown debug
 * sub-path, keeping all debug routing in one place.
 *
 * @param {StorageProvider} storage The injected Storage_Provider.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} subPath The path segment after `/__debug/`
 *   (e.g. `'reset'`, `'dump'`, `'seed'`).
 * @returns {Promise<void>}
 */
export async function handleDebug(storage, req, res, subPath) {
  const method = req.method;

  switch (subPath) {
    case 'reset':
      if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
      return debugReset(storage, req, res);
    case 'dump':
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
      return debugDump(storage, req, res);
    case 'seed':
      if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
      return debugSeed(storage, req, res);
    default:
      return sendJson(res, 404, { error: 'Unknown debug affordance.' });
  }
}
