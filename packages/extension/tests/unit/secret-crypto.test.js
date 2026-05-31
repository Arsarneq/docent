/**
 * secret-crypto.test.js — Unit tests for at-rest API-key encryption (S2)
 *
 * Exercises the AES-GCM helpers directly: envelope shape, plaintext absence,
 * round-trip, the post-restart (ephemeral key cleared) path, and rejection of
 * tampered ciphertext.
 *
 * Node 20 provides Web Crypto (crypto.subtle), btoa/atob, TextEncoder and
 * TextDecoder as globals, so only chrome.storage.session needs mocking.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// ─── chrome.storage.session mock (in-memory, like the browser) ────────────────

let sessionData = {};

globalThis.chrome = {
  storage: {
    session: {
      get: mock.fn(async (keys) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const k of keyArr) {
          if (k in sessionData) result[k] = sessionData[k];
        }
        return result;
      }),
      set: mock.fn(async (obj) => {
        Object.assign(sessionData, obj);
      }),
    },
  },
};

const { encryptSecret, decryptSecret, isEnvelope, SESSION_KEY_NAME } =
  await import('../../sidepanel/secret-crypto.js');

function resetSession() {
  sessionData = {};
}

// ─── encryptSecret() ──────────────────────────────────────────────────────────

describe('encryptSecret()', () => {
  beforeEach(resetSession);

  it('produces an {v, iv, ct} envelope that hides the plaintext', async () => {
    const env = await encryptSecret('super-secret-key');
    assert.equal(env.v, 1);
    assert.equal(typeof env.iv, 'string');
    assert.equal(typeof env.ct, 'string');
    assert.ok(!JSON.stringify(env).includes('super-secret-key'));
  });

  it('persists an ephemeral key in session storage', async () => {
    assert.equal(sessionData[SESSION_KEY_NAME], undefined);
    await encryptSecret('k');
    assert.ok(sessionData[SESSION_KEY_NAME], 'session key should be created');
  });

  it('uses a fresh IV per call (same plaintext → different ciphertext)', async () => {
    const a = await encryptSecret('same');
    const b = await encryptSecret('same');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  it('reuses the existing session key across calls', async () => {
    await encryptSecret('first');
    const keyAfterFirst = sessionData[SESSION_KEY_NAME];
    await encryptSecret('second');
    assert.equal(sessionData[SESSION_KEY_NAME], keyAfterFirst);
  });
});

// ─── decryptSecret() ──────────────────────────────────────────────────────────

describe('decryptSecret()', () => {
  beforeEach(resetSession);

  it('round-trips a value through encrypt/decrypt', async () => {
    const env = await encryptSecret('round-trip-value');
    const out = await decryptSecret(env);
    assert.equal(out, 'round-trip-value');
  });

  it('handles unicode plaintext', async () => {
    const secret = 'kéy-🔐-密钥';
    const out = await decryptSecret(await encryptSecret(secret));
    assert.equal(out, secret);
  });

  it('returns null after the ephemeral key is cleared (browser restart)', async () => {
    const env = await encryptSecret('will-be-lost');
    sessionData = {}; // simulate restart
    const out = await decryptSecret(env);
    assert.equal(out, null);
  });

  it('returns null for a malformed envelope', async () => {
    assert.equal(await decryptSecret(null), null);
    assert.equal(await decryptSecret({}), null);
    assert.equal(await decryptSecret({ iv: 'x' }), null);
    assert.equal(await decryptSecret('not-an-object'), null);
  });

  it('returns null for tampered ciphertext', async () => {
    const env = await encryptSecret('authentic');
    // Flip the ciphertext — AES-GCM auth tag check should fail.
    const tampered = { ...env, ct: env.ct.slice(0, -2) + (env.ct.endsWith('A') ? 'B' : 'A') + '=' };
    const out = await decryptSecret(tampered);
    assert.equal(out, null);
  });
});

// ─── isEnvelope() ─────────────────────────────────────────────────────────────

describe('isEnvelope()', () => {
  it('recognises an envelope and rejects plaintext / junk', async () => {
    resetSession();
    const env = await encryptSecret('x');
    assert.equal(isEnvelope(env), true);
    assert.equal(isEnvelope('plaintext'), false);
    assert.equal(isEnvelope(null), false);
    assert.equal(isEnvelope({ iv: 'a' }), false);
    assert.equal(isEnvelope({ ct: 'a' }), false);
  });
});
