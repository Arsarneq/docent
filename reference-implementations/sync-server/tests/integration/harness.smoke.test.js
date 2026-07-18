import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

import { startTestServer, request } from './harness.js';

/**
 * Harness self-test.
 *
 * This is a minimal smoke test that the integration harness itself works — it
 * does NOT test protocol behavior (the integration suites own that). It confirms the
 * three things every later suite relies on:
 *
 *   1. `startTestServer()` brings the real server up on an ephemeral port with a
 *      fresh temp storage dir, and the `request` helper can drive it
 *      (GET /projects → 200 [] on an empty store).
 *   2. `close()` actually closes the server (a follow-up request fails to
 *      connect) AND removes the temp dir.
 *   3. `close()` is idempotent — calling it twice does not throw.
 */

describe('harness self-test', () => {
  it('starts the server on an ephemeral port and serves GET /projects → 200 []', async () => {
    const server = await startTestServer();
    try {
      assert.match(server.baseUrl, /^http:\/\/.+:\d+$/);
      const res = await request(server.baseUrl, 'GET', '/projects');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    } finally {
      await server.close();
    }
  });

  it('tears down: close() stops the server and removes the temp dir', async () => {
    const server = await startTestServer();
    const { baseUrl, tmpDir } = server;

    // Sanity: the temp dir exists while the server runs.
    await assert.doesNotReject(access(tmpDir));

    await server.close();

    // The temp dir is gone after teardown.
    await assert.rejects(access(tmpDir));

    // The server no longer accepts connections.
    await assert.rejects(request(baseUrl, 'GET', '/projects'));
  });

  it('close() is idempotent (safe to call more than once)', async () => {
    const server = await startTestServer();
    await server.close();
    await assert.doesNotReject(server.close());
  });

  it('honors a configured token (open vs gated is selectable per suite)', async () => {
    const server = await startTestServer({ token: 'smoke-token' });
    try {
      // No Authorization header → 401 when a token is configured.
      const unauthed = await request(server.baseUrl, 'GET', '/projects');
      assert.equal(unauthed.status, 401);

      // Correct Bearer token → served.
      const authed = await request(server.baseUrl, 'GET', '/projects', {
        headers: { authorization: 'Bearer smoke-token' },
      });
      assert.equal(authed.status, 200);
      assert.deepEqual(authed.body, []);
    } finally {
      await server.close();
    }
  });
});
