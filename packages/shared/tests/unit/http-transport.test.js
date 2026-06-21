/**
 * http-transport.test.js — the platform HTTP transport seam.
 *
 * Verifies that the shared HTTP code's indirection point:
 *   - defaults to `globalThis.fetch` when no transport is bound (the extension
 *     and every shared test rely on this — they stub `globalThis.fetch`);
 *   - routes through a bound transport when one is set (the desktop's native
 *     Rust-backed transport);
 *   - reads `globalThis.fetch` lazily (per call), so a test that swaps the
 *     global after import still takes effect;
 *   - treats a non-function binding as "unbound" and `resetHttpTransport`
 *     restores the default.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { httpRequest, setHttpTransport, resetHttpTransport } from '../../lib/http-transport.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  resetHttpTransport();
  globalThis.fetch = originalFetch;
});

describe('httpRequest — default (unbound)', () => {
  it('forwards to globalThis.fetch with the same arguments', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    };

    const res = await httpRequest('https://example.com/projects', { method: 'GET' });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.com/projects');
    assert.deepEqual(calls[0].options, { method: 'GET' });
  });

  it('reads globalThis.fetch lazily (a later swap takes effect)', async () => {
    // Bind nothing; swap the global AFTER import — the lazy default must use it.
    let used = 'none';
    globalThis.fetch = async () => {
      used = 'swapped';
      return { ok: true, status: 204 };
    };
    const res = await httpRequest('https://example.com');
    assert.equal(used, 'swapped');
    assert.equal(res.status, 204);
  });
});

describe('httpRequest — bound transport', () => {
  it('routes through the bound transport instead of fetch', async () => {
    globalThis.fetch = async () => {
      throw new Error('fetch must not be called when a transport is bound');
    };
    const seen = [];
    setHttpTransport(async (url, options) => {
      seen.push({ url, options });
      return { ok: true, status: 201, json: async () => ({ ok: true }) };
    });

    const res = await httpRequest('https://sync.example.com/projects/1', {
      method: 'PUT',
      body: '{}',
    });

    assert.equal(res.status, 201);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://sync.example.com/projects/1');
    assert.equal(seen[0].options.method, 'PUT');
  });

  it('resetHttpTransport restores the globalThis.fetch default', async () => {
    setHttpTransport(async () => ({ ok: true, status: 418 }));
    resetHttpTransport();

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200 };
    };

    await httpRequest('https://example.com');
    assert.ok(fetchCalled, 'after reset, the default global fetch is used again');
  });

  it('treats a non-function binding as unbound (falls back to fetch)', async () => {
    setHttpTransport(/** @type {any} */ (null));
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200 };
    };
    await httpRequest('https://example.com');
    assert.ok(fetchCalled);
  });
});
