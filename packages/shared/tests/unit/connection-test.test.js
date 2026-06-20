/**
 * connection-test.test.js — Unit tests for the Connection_Test helper and the
 * Auto-Sync settings fingerprint.
 *
 * Covers `testConnection` (the GET /projects probe classified as
 * pass/auth/unreachable) with a mocked fetch, and `settingsFingerprint` (the
 * stable, plaintext-key fingerprint that invalidates a passing test when the
 * endpoint or API key changes).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { testConnection, settingsFingerprint } from '../../connection-test.js';

// ─── Mocked fetch (mirrors sync-client.test.js conventions) ──────────────────

/** Tracks fetch calls for assertions. */
let fetchCalls = [];

/** Installs a mock fetch on globalThis that records calls and delegates to `handler`. */
function mockFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return handler(url, options);
  };
}

/** Installs a mock fetch that always rejects (network failure). */
function mockFetchReject(error) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    throw error;
  };
}

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── testConnection — request shape ──────────────────────────

describe('testConnection request shape', () => {
  it('issues a single GET to the existing /projects endpoint', async () => {
    mockFetch(() => makeResponse(200, []));

    await testConnection('https://srv.test', null);

    assert.equal(fetchCalls.length, 1, 'exactly one request');
    assert.equal(fetchCalls[0].url, 'https://srv.test/projects');
    assert.equal(fetchCalls[0].options.method, 'GET');
  });

  it('does not send a body on the probe (read-through)', async () => {
    mockFetch(() => makeResponse(200, []));

    await testConnection('https://srv.test', null);

    assert.equal(fetchCalls[0].options.body, undefined, 'GET probe carries no body');
  });

  it('includes the Bearer token when an apiKey is provided', async () => {
    mockFetch(() => makeResponse(200, []));

    await testConnection('https://srv.test', 'secret-key');

    assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer secret-key');
  });

  it('omits the Authorization header when apiKey is null', async () => {
    mockFetch(() => makeResponse(200, []));

    await testConnection('https://srv.test', null);

    assert.equal(fetchCalls[0].options.headers.Authorization, undefined);
  });

  it('reuses the configured endpoint verbatim (assumes non-empty serverUrl)', async () => {
    mockFetch(() => makeResponse(200, []));

    await testConnection('https://srv.test/base', null);

    assert.equal(fetchCalls[0].url, 'https://srv.test/base/projects');
  });
});

// ─── testConnection — outcome classification ──────────────────

describe('testConnection outcome classification', () => {
  it('classifies a 200 OK as pass', async () => {
    mockFetch(() => makeResponse(200, []));

    const result = await testConnection('https://srv.test', null);

    assert.deepEqual(result, { ok: true, reason: 'pass' });
  });

  it('classifies any 2xx success (e.g. 204) as pass', async () => {
    mockFetch(() => makeResponse(204, null));

    const result = await testConnection('https://srv.test', null);

    assert.deepEqual(result, { ok: true, reason: 'pass' });
  });

  it('classifies 401 as an auth failure', async () => {
    mockFetch(() => makeResponse(401, null));

    const result = await testConnection('https://srv.test', 'bad-key');

    assert.deepEqual(result, { ok: false, reason: 'auth' });
  });

  it('classifies 403 as an auth failure', async () => {
    mockFetch(() => makeResponse(403, null));

    const result = await testConnection('https://srv.test', 'bad-key');

    assert.deepEqual(result, { ok: false, reason: 'auth' });
  });

  it('classifies a network failure (thrown fetch) as unreachable', async () => {
    mockFetchReject(new TypeError('Failed to fetch'));

    const result = await testConnection('https://srv.test', null);

    assert.deepEqual(result, { ok: false, reason: 'unreachable' });
  });

  it('classifies a 404 (reachable, non-success) as unreachable, not auth', async () => {
    mockFetch(() => makeResponse(404, null));

    const result = await testConnection('https://srv.test', null);

    assert.deepEqual(result, { ok: false, reason: 'unreachable' });
  });

  it('classifies a 500 (reachable, server error) as unreachable, not auth', async () => {
    mockFetch(() => makeResponse(500, null));

    const result = await testConnection('https://srv.test', null);

    assert.deepEqual(result, { ok: false, reason: 'unreachable' });
  });
});

// ─── settingsFingerprint — determinism & sensitivity ─────────────────

describe('settingsFingerprint determinism and sensitivity', () => {
  it('is deterministic for identical settings', () => {
    const a = settingsFingerprint('https://srv.test', 'key-1');
    const b = settingsFingerprint('https://srv.test', 'key-1');

    assert.equal(a, b);
  });

  it('returns a string', () => {
    assert.equal(typeof settingsFingerprint('https://srv.test', 'key-1'), 'string');
  });

  it('changes when the endpoint changes (invalidates a prior test)', () => {
    const a = settingsFingerprint('https://srv.test', 'key-1');
    const b = settingsFingerprint('https://other.test', 'key-1');

    assert.notEqual(a, b);
  });

  it('changes when the apiKey changes (invalidates a prior test)', () => {
    const a = settingsFingerprint('https://srv.test', 'key-1');
    const b = settingsFingerprint('https://srv.test', 'key-2');

    assert.notEqual(a, b);
  });

  it('distinguishes "no key" from a present key', () => {
    const none = settingsFingerprint('https://srv.test', null);
    const withKey = settingsFingerprint('https://srv.test', 'key-1');

    assert.notEqual(none, withKey);
  });

  it('treats undefined and null apiKey as the same "no key" state', () => {
    const undef = settingsFingerprint('https://srv.test', undefined);
    const nul = settingsFingerprint('https://srv.test', null);

    assert.equal(undef, nul);
  });

  it('is stable across repeated calls regardless of argument identity', () => {
    // Same plaintext values supplied as fresh strings each call (mirrors a
    // re-derived/re-decrypted key across a restart) — the fingerprint must not
    // change, so a still-valid Connection_Test is not spuriously invalidated.
    const url = ['https://', 'srv.test'].join('');
    const key = ['sec', 'ret'].join('');
    const first = settingsFingerprint('https://srv.test', 'secret');
    const second = settingsFingerprint(url, key);

    assert.equal(first, second);
  });

  it('does not collide when endpoint and key are swapped', () => {
    const a = settingsFingerprint('alpha', 'beta');
    const b = settingsFingerprint('beta', 'alpha');

    assert.notEqual(a, b);
  });
});
