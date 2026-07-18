/**
 * tests/auth.test.js — the optional-Bearer-authentication integration suite for
 * the Reference Sync Server.
 *
 * This suite drives the REAL server end-to-end over HTTP (via the `harness.js`
 * harness) to confirm the auth gate the router applies before every handler:
 *
 *   - Open server (no Static_Token): every request is served and ANY
 *     `Authorization` header is ignored.
 *   - Gated server (Static_Token set): missing header → 401, wrong Bearer
 *     token → 403, correct Bearer token → served.
 *   - An internal handler error maps to HTTP 500 even when the server is open
 *     and no token is configured.
 *   - The non-protocol `/__debug/*` affordances are token-gated exactly like the
 *     protocol routes when a token is configured.
 *
 * Most cases use the harness `startTestServer`/`request`. The 500 case needs a
 * handler to actually throw, which the harness's `FileStorageProvider` will not
 * do on a healthy temp dir; so that single case starts the server directly via
 * `startServer` with an injected Storage_Provider stub whose methods throw, on
 * an ephemeral port (`port: 0`) with no token. The throwing-stub wiring stays
 * local to this test — no production module is modified.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/auth.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../../server.js';
import { startTestServer, request } from './harness.js';

/** A Static_Token used by the gated-server cases. */
const TOKEN = 'integration-test-token';

/**
 * Start the real server on an ephemeral port with NO token configured and a
 * Storage_Provider stub whose every method throws, so that any request that
 * reaches a handler triggers the router's top-level catch → HTTP 500. This is
 * the local wiring the 500 case needs without modifying any production
 * module; the stub satisfies the `Storage_Provider` shape (`list`/`read`/`put`/
 * `clear`) and there is no temp dir to clean up.
 *
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
async function startServerWithThrowingStorage() {
  const boom = () => {
    throw new Error('forced handler error');
  };
  const throwingStorage = {
    async list() {
      return boom();
    },
    async read() {
      return boom();
    },
    async put() {
      return boom();
    },
    async clear() {
      return boom();
    },
  };

  const { server, url } = await startServer({
    port: 0,
    token: null,
    storage: throwingStorage,
    log: () => {},
  });

  /**
   * Await the server's (callback-based) close. No temp dir is involved because
   * the throwing stub never touches the filesystem.
   *
   * @returns {Promise<void>}
   */
  function close() {
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { baseUrl: url, close };
}

describe('auth — open server (no Static_Token configured)', () => {
  it('serves a request with no Authorization header', async () => {
    const server = await startTestServer();
    try {
      const res = await request(server.baseUrl, 'GET', '/projects');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    } finally {
      await server.close();
    }
  });

  it('serves the request and ignores a Bearer Authorization header', async () => {
    const server = await startTestServer();
    try {
      const res = await request(server.baseUrl, 'GET', '/projects', {
        headers: { authorization: 'Bearer some-unconfigured-token' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    } finally {
      await server.close();
    }
  });

  it('serves the request and ignores a malformed Authorization header', async () => {
    const server = await startTestServer();
    try {
      const res = await request(server.baseUrl, 'GET', '/projects', {
        headers: { authorization: 'not-even-a-bearer-scheme' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    } finally {
      await server.close();
    }
  });
});

describe('auth — gated server (Static_Token configured)', () => {
  it('rejects a request with no Authorization header → 401', async () => {
    const server = await startTestServer({ token: TOKEN });
    try {
      const res = await request(server.baseUrl, 'GET', '/projects');
      assert.equal(res.status, 401);
    } finally {
      await server.close();
    }
  });

  it('rejects a wrong Bearer token → 403', async () => {
    const server = await startTestServer({ token: TOKEN });
    try {
      const res = await request(server.baseUrl, 'GET', '/projects', {
        headers: { authorization: 'Bearer the-wrong-token' },
      });
      assert.equal(res.status, 403);
    } finally {
      await server.close();
    }
  });

  it('accepts the correct Bearer token → 200', async () => {
    const server = await startTestServer({ token: TOKEN });
    try {
      const res = await request(server.baseUrl, 'GET', '/projects', {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    } finally {
      await server.close();
    }
  });
});

describe('auth — internal error mapping', () => {
  it('maps a handler-forced error to HTTP 500 even with no token configured', async () => {
    const { baseUrl, close } = await startServerWithThrowingStorage();
    try {
      // GET /projects reaches the manifest handler, which calls storage.list();
      // the stub throws there, so the router's top-level catch returns 500.
      const response = await fetch(new URL('/projects', baseUrl));
      assert.equal(response.status, 500);
    } finally {
      await close();
    }
  });
});

describe('auth — debug routes are token-gated when a token is set', () => {
  it('rejects POST /__debug/reset with no Authorization header → 401', async () => {
    const server = await startTestServer({ token: TOKEN });
    try {
      const res = await request(server.baseUrl, 'POST', '/__debug/reset');
      assert.equal(res.status, 401);
    } finally {
      await server.close();
    }
  });

  it('rejects POST /__debug/reset with a wrong Bearer token → 403', async () => {
    const server = await startTestServer({ token: TOKEN });
    try {
      const res = await request(server.baseUrl, 'POST', '/__debug/reset', {
        headers: { authorization: 'Bearer the-wrong-token' },
      });
      assert.equal(res.status, 403);
    } finally {
      await server.close();
    }
  });

  it('accepts POST /__debug/reset with the correct Bearer token → 200', async () => {
    const server = await startTestServer({ token: TOKEN });
    try {
      const res = await request(server.baseUrl, 'POST', '/__debug/reset', {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, cleared: 0 });
    } finally {
      await server.close();
    }
  });
});
