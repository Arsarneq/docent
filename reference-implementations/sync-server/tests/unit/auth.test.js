import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { checkAuth } from '../../auth.js';

/**
 * Tests for optional Bearer authentication.
 *
 * `checkAuth` reads only `req.headers.authorization`, so a request can be
 * faked with a plain object carrying a `headers` map — no real socket needed.
 */

/** Build a minimal http.IncomingMessage-like stub. */
function fakeReq(authorization) {
  const headers = {};
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return { headers };
}

const TOKEN = 's3cr3t-static-token';

describe('checkAuth — open server (no Static_Token configured)', () => {
  it('passes when no token is configured and no header is present', () => {
    assert.deepEqual(checkAuth(null, fakeReq()), { ok: true });
  });

  it('passes and ignores any Authorization header when open', () => {
    assert.deepEqual(checkAuth(null, fakeReq('Bearer anything-at-all')), {
      ok: true,
    });
    assert.deepEqual(checkAuth(null, fakeReq('not-even-bearer')), {
      ok: true,
    });
  });

  it('treats an empty-string token as open (no token configured)', () => {
    assert.deepEqual(checkAuth('', fakeReq('Bearer whatever')), { ok: true });
  });
});

describe('checkAuth — authenticated server (Static_Token configured)', () => {
  it('returns 401 when the Authorization header is missing', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq()), {
      ok: false,
      status: 401,
    });
  });

  it('returns 403 when the Bearer token does not match', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq('Bearer wrong-token')), {
      ok: false,
      status: 403,
    });
  });

  it('returns 403 when the header is present but not a Bearer scheme', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq('Basic dXNlcjpwYXNz')), {
      ok: false,
      status: 403,
    });
  });

  it('passes when the Bearer token matches the Static_Token', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq(`Bearer ${TOKEN}`)), {
      ok: true,
    });
  });

  it('accepts a case-insensitive Bearer scheme name with the matching token', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq(`bearer ${TOKEN}`)), {
      ok: true,
    });
  });
});

describe('checkAuth — Bearer parsing is linear (regression: CodeQL js/polynomial-redos)', () => {
  it('extracts the token across a multi-space/tab separator run', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq(`Bearer \t  \t${TOKEN}`)), {
      ok: true,
    });
  });

  it('does not backtrack polynomially on a pathological whitespace header', () => {
    // Pre-fix the scheme was matched with /^Bearer[ \t]+(.*)$/i, whose `[ \t]+`
    // and `(.*)` overlap (`.` also matches space/tab). A long tab run before a
    // `$`-defeating newline made it backtrack quadratically (ReDoS). The fix
    // matches only the non-overlapping scheme prefix and slices the remainder,
    // so this stays linear — it returns promptly (and rejects).
    const evil = `Bearer ${'\t'.repeat(100000)}\nx`;
    const start = performance.now();
    const result = checkAuth(TOKEN, fakeReq(evil));
    const elapsed = performance.now() - start;
    assert.deepEqual(result, { ok: false, status: 403 });
    assert.ok(
      elapsed < 1000,
      `Bearer parse took ${elapsed.toFixed(1)}ms — possible ReDoS regression`,
    );
  });
});
