import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkAuth } from '../../auth.js';

/**
 * Tests for optional Bearer authentication (Requirement 5).
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
  it('passes when no token is configured and no header is present (R5.4)', () => {
    assert.deepEqual(checkAuth(null, fakeReq()), { ok: true });
  });

  it('passes and ignores any Authorization header when open (R5.5)', () => {
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
  it('returns 401 when the Authorization header is missing (R5.2)', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq()), {
      ok: false,
      status: 401,
    });
  });

  it('returns 403 when the Bearer token does not match (R5.3)', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq('Bearer wrong-token')), {
      ok: false,
      status: 403,
    });
  });

  it('returns 403 when the header is present but not a Bearer scheme (R5.3)', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq('Basic dXNlcjpwYXNz')), {
      ok: false,
      status: 403,
    });
  });

  it('passes when the Bearer token matches the Static_Token (R5.1)', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq(`Bearer ${TOKEN}`)), {
      ok: true,
    });
  });

  it('accepts a case-insensitive Bearer scheme name with the matching token (R5.1)', () => {
    assert.deepEqual(checkAuth(TOKEN, fakeReq(`bearer ${TOKEN}`)), {
      ok: true,
    });
  });
});
