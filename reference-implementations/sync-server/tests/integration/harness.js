/**
 * tests/integration/harness.js — the integration-test harness for the Reference
 * Sync Server (design's Testing Strategy).
 *
 * This module is NOT a test file (no `.test.js` suffix, so `node --test` does
 * not run it directly). It exports the helpers the integration suites
 * (Tasks 10.2–10.6) import to drive the REAL server end-to-end:
 *
 *   - `startTestServer({ token } = {})` — spins the actual `http.Server` on an
 *     ephemeral port (`port: 0`) over a FRESH temp storage directory created
 *     with `fs.mkdtemp`, so suites never collide with each other or with a
 *     developer's running instance. It injects a `FileStorageProvider` pointed
 *     at that temp dir and silences startup logging. Returns the bound base URL
 *     plus a single awaitable `close()` that tears everything down.
 *
 *   - `request(baseUrl, method, path, { headers, body } = {})` — a thin `fetch`
 *     wrapper that returns `{ status, headers, body }`, JSON-parsing the
 *     response body when the server marks it `application/json`, so suites stay
 *     free of fetch/parse boilerplate.
 *
 * The harness uses only Node.js built-ins (`node:fs/promises`, `node:os`,
 * `node:path`) plus the global `fetch`, and the in-package `startServer` /
 * `FileStorageProvider`. It constructs nothing the server itself would not — it
 * simply runs the same server a deployment would, isolated per suite.
 *
 * Typical use in a suite:
 *
 *   import { describe, it, before, after } from 'node:test';
 *   import assert from 'node:assert/strict';
 *   import { startTestServer, request } from './harness.js';
 *
 *   describe('manifest', () => {
 *     let server;
 *     before(async () => { server = await startTestServer(); });
 *     after(async () => { await server.close(); });
 *
 *     it('starts empty', async () => {
 *       const res = await request(server.baseUrl, 'GET', '/projects');
 *       assert.equal(res.status, 200);
 *       assert.deepEqual(res.body, []);
 *     });
 *   });
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/integration/harness
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../../server.js';
import { FileStorageProvider } from '../../storage/file-provider.js';

/** Prefix for each suite's fresh temp storage directory under `os.tmpdir()`. */
const TMP_PREFIX = 'docent-sync-server-it-';

/**
 * @typedef {Object} TestServer
 * @property {string} baseUrl
 *   The bound base URL, e.g. `http://localhost:53124` (or `http://[::1]:…` on a
 *   dual-stack host). Suffix request paths onto it, or pass it to {@link request}.
 * @property {import('node:http').Server} server  The live HTTP server.
 * @property {import('../storage/file-provider.js').FileStorageProvider} storage
 *   The provider backing this server, over the suite's temp dir — useful for a
 *   suite that wants to seed or assert directly against storage.
 * @property {string} tmpDir  The absolute path to this suite's temp storage dir.
 * @property {() => Promise<void>} close
 *   Idempotent teardown: stops accepting connections, waits for the server to
 *   close, then removes the temp dir recursively. Safe to call more than once.
 */

/**
 * Start the real Reference Sync Server on an ephemeral port over a fresh temp
 * storage directory, ready to be driven over HTTP.
 *
 * Steps:
 *   1. Create a brand-new temp dir with `fs.mkdtemp` (unique per call).
 *   2. Construct a `FileStorageProvider` over that dir — so the suite's data is
 *      fully isolated from the default `<os.tmpdir()>/docent-reference-sync-server`
 *      directory and from every other suite.
 *   3. Call `startServer({ port: 0, token, storage, log: () => {} })` — `port: 0`
 *      binds an OS-chosen free port and the no-op `log` keeps the test output
 *      clean.
 *
 * @param {object} [options]
 * @param {string|null} [options.token]
 *   The Static_Token to configure, or null/undefined for an open server. Pass a
 *   token to exercise the auth-gated paths (Task 10.4).
 * @returns {Promise<TestServer>} The started server and its teardown handle.
 */
export async function startTestServer({ token = null } = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const storage = new FileStorageProvider(tmpDir);

  const { server, url } = await startServer({
    port: 0,
    token,
    storage,
    log: () => {},
  });

  let closed = false;
  /**
   * Tear the server and its temp dir down. Awaiting the server's `close` (which
   * is callback-based) before removing the directory avoids racing a pending
   * request against the `rm`. Guarded so a double `close()` (e.g. an `after`
   * hook plus a manual call) is a no-op rather than an error.
   *
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmpDir, { recursive: true, force: true });
  }

  return { baseUrl: url, server, storage, tmpDir, close };
}

/**
 * @typedef {Object} HarnessResponse
 * @property {number} status  The HTTP status code.
 * @property {Record<string, string>} headers
 *   The response headers as a plain lower-cased-key object (from `fetch`).
 * @property {*} body
 *   The parsed response body: a JS value when the response is
 *   `application/json`, the raw string for other non-empty bodies, or
 *   `undefined` for an empty body.
 */

/**
 * Issue a single HTTP request against a running test server and return a small,
 * already-parsed result so suites avoid repeating fetch/JSON boilerplate.
 *
 * Request body handling:
 *   - a string `body` is sent as-is (use this to test invalid-JSON paths);
 *   - any non-string `body` is `JSON.stringify`-ed and, unless the caller set a
 *     `content-type`, sent as `application/json`;
 *   - an omitted `body` sends no request body.
 *
 * Response body handling: the body is parsed as JSON when the response's
 * `Content-Type` contains `application/json`; otherwise the raw text is
 * returned, and an empty body yields `undefined`.
 *
 * @param {string} baseUrl  A base URL from {@link startTestServer}.
 * @param {string} method   The HTTP method, e.g. `'GET'` or `'PUT'`.
 * @param {string} path     The request path, e.g. `'/projects/abc'`.
 * @param {object} [options]
 * @param {Record<string, string>} [options.headers]  Extra request headers.
 * @param {string|object} [options.body]  The request body (see above).
 * @returns {Promise<HarnessResponse>}
 */
export async function request(baseUrl, method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };

  if (body !== undefined) {
    if (typeof body === 'string') {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      const hasContentType = Object.keys(init.headers).some(
        (key) => key.toLowerCase() === 'content-type',
      );
      if (!hasContentType) init.headers['content-type'] = 'application/json';
    }
  }

  const response = await fetch(new URL(path, baseUrl), init);

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  let parsedBody;
  if (text === '') {
    parsedBody = undefined;
  } else if (contentType.includes('application/json')) {
    parsedBody = JSON.parse(text);
  } else {
    parsedBody = text;
  }

  return { status: response.status, headers: responseHeaders, body: parsedBody };
}
