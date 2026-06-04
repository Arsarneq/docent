/**
 * router.js — auth-first request dispatch for the Reference Sync Server
 * (Requirements 5.6, 5.7, 12.2).
 *
 * The router is the single composition point that turns an incoming HTTP
 * request into one of the four handlers. It enforces the design's precedence
 * rule for the routing-level concerns:
 *
 *   auth (401/403)  →  routing (404 / 405)  →  handler
 *
 * and wraps the whole dispatch in a top-level try/catch that maps any unhandled
 * error to HTTP 500 (Requirement 5.6) — even when no Static_Token is configured.
 *
 * Auth runs FIRST for EVERY request, protocol routes and `/__debug/*` alike
 * (Requirement 5.7): a configured token leaves no unauthenticated endpoint, and
 * an auth failure short-circuits before any handler is reached, so a rejected
 * request never touches stored data. The debug affordances stay behind their
 * own `/__debug/` prefix (Requirement 12.2); this router only detects the prefix
 * and delegates the whole namespace to `handleDebug`, which self-guards the
 * method (405) and unknown sub-paths (404).
 *
 * All four handlers share one calling convention — `(storage, req, res, …)`,
 * storage first — so the router dispatches uniformly:
 *   - `handleManifest(storage, req, res)`        — GET /projects
 *   - `readProject(storage, req, res, id)`       — GET /projects/:id
 *   - `writeProject(storage, req, res, id)`      — PUT /projects/:id
 *   - `handleDebug(storage, req, res, subPath)`  — /__debug/<sub>
 *
 * Uses only Node.js built-ins (`node:http` request/response, the WHATWG `URL`).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module router
 */

import { checkAuth } from './auth.js';
import { handleManifest } from './handlers/manifest.js';
import { readProject } from './handlers/read-project.js';
import { writeProject } from './handlers/write-project.js';
import { handleDebug } from './handlers/debug.js';

/** The distinct prefix under which all non-protocol debug routes live (R12.2). */
const DEBUG_PREFIX = '/__debug/';

/**
 * Write a minimal JSON response with the given status code, but only if the
 * response has not already started. The router uses this for its own
 * status-only responses (auth failures, 404/405, 500); handlers write their own
 * bodies directly. The `headersSent` guard keeps the 500 wrapper safe even if a
 * handler threw after it had begun responding.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body JSON-serializable response body.
 */
function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Build the request listener for the Reference Sync Server.
 *
 * The returned function is suitable as the `http.createServer` handler: the
 * server entry point (`server.js`, Task 8.2) constructs the default
 * `File_Storage_Provider` and the configured token, then passes them here.
 *
 * @param {object} config
 * @param {import('./storage/provider.js').StorageProvider} config.storage
 *   The injected Storage_Provider — the only path to stored projects (R7.1).
 * @param {string|null|undefined} [config.token]
 *   The Static_Token, or null/undefined/empty when the server is open (R5.4).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   An async request listener.
 */
export function createRouter({ storage, token }) {
  return async function route(req, res) {
    // Everything is wrapped so that ANY unhandled error — including one thrown
    // by a handler or the storage seam — becomes HTTP 500, even when no token
    // is configured (Requirement 5.6).
    try {
      // ── Step 1: auth FIRST, for every request — protocol and /__debug/* alike
      // (Requirements 5.7, 12.2). On failure, write 401/403 and stop before any
      // dispatch, so a rejected request never reaches a handler or the store.
      const auth = checkAuth(token, req);
      if (!auth.ok) {
        sendJson(res, auth.status, {
          error: auth.status === 401 ? 'unauthorized' : 'forbidden',
        });
        return;
      }

      // ── Step 2: resolve the path. A base is required because req.url is a
      // path, not an absolute URL; only `pathname` is used for dispatch.
      const { pathname } = new URL(req.url, 'http://localhost');
      const method = req.method;

      // ── Debug namespace: detect the `/__debug/` prefix and delegate the whole
      // namespace to handleDebug, which self-guards method (405) and unknown
      // sub-paths (404). `subPath` is the remainder after the prefix.
      if (pathname.startsWith(DEBUG_PREFIX)) {
        const subPath = pathname.slice(DEBUG_PREFIX.length);
        await handleDebug(storage, req, res, subPath);
        return;
      }

      // ── Protocol routes. Split into non-empty segments so that `/projects`
      // and `/projects/` are treated identically as the collection path, and
      // `/projects/<id>` is the item path.
      const segments = pathname.split('/').filter(Boolean);

      // Collection path: /projects (and /projects/).
      if (segments.length === 1 && segments[0] === 'projects') {
        if (method === 'GET') {
          await handleManifest(storage, req, res);
          return;
        }
        // Known path, unsupported method → 405.
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      // Item path: /projects/:id.
      if (segments.length === 2 && segments[0] === 'projects') {
        const id = decodeURIComponent(segments[1]);
        if (method === 'GET') {
          await readProject(storage, req, res, id);
          return;
        }
        if (method === 'PUT') {
          await writeProject(storage, req, res, id);
          return;
        }
        // Known path, unsupported method → 405.
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      // ── Anything else is an unknown path → 404.
      sendJson(res, 404, { error: 'not_found' });
    } catch {
      // Requirement 5.6: any internal error maps to 500, even when open. The
      // sendJson headersSent guard avoids a double-write if a handler had
      // already started the response before throwing.
      sendJson(res, 500, { error: 'internal_server_error' });
    }
  };
}
