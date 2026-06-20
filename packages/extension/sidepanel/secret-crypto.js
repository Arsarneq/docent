/**
 * secret-crypto.js — At-rest encryption for extension API keys
 *
 * The dispatch and sync API keys were previously written verbatim into
 * chrome.storage.local. Anyone able to read the extension's storage on disk
 * (another local user, backup/forensic tooling, a profile copy) could lift the
 * keys straight out.
 *
 * This module encrypts those keys with AES-GCM (Web Crypto) before they are
 * written to chrome.storage.local. The AES key itself is kept in
 * chrome.storage.session, which is held in memory by the browser and cleared
 * when the browser restarts — it never touches disk.
 *
 * THREAT MODEL — what this does and does NOT protect against:
 *   ✓ At-rest exposure: the on-disk chrome.storage.local no longer holds the
 *     plaintext key, only ciphertext that is useless without the in-memory key.
 *   ✗ A compromised extension: code running as the extension can read the
 *     session key and decrypt, exactly as it could read the plaintext before.
 *     Narrowing the content-script attack surface is tracked separately.
 *
 * CONSEQUENCE: because the AES key is ephemeral, encrypted keys cannot be
 * decrypted after a browser restart. The adapter treats an undecryptable value
 * as "no key configured", so the user re-enters the key. This is the price of
 * keeping the key off disk; it is intentional, not a bug.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Key under which the ephemeral AES key (as raw bytes) lives in session storage.
const SESSION_KEY_NAME = 'docentSecretKey';

const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV, the AES-GCM standard

// ─── base64 helpers (work on ArrayBuffer / Uint8Array) ────────────────────────

function bytesToBase64(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Ephemeral key management ─────────────────────────────────────────────────

/**
 * Get the ephemeral AES key from session storage, creating and persisting a
 * new one if none exists. The key is stored as raw bytes (base64) so it can
 * round-trip through chrome.storage.session.
 *
 * @returns {Promise<CryptoKey>}
 */
async function getOrCreateSessionKey() {
  const existing = await chrome.storage.session.get(SESSION_KEY_NAME);
  if (existing[SESSION_KEY_NAME]) {
    const raw = base64ToBytes(existing[SESSION_KEY_NAME]);
    return crypto.subtle.importKey('raw', raw, { name: ALGO }, true, ['encrypt', 'decrypt']);
  }

  const key = await crypto.subtle.generateKey({ name: ALGO, length: KEY_LENGTH }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.session.set({ [SESSION_KEY_NAME]: bytesToBase64(raw) });
  return key;
}

/**
 * Fetch the ephemeral AES key without creating one. Returns null when no key
 * exists (e.g. after a browser restart cleared session storage).
 *
 * @returns {Promise<CryptoKey|null>}
 */
async function getSessionKey() {
  const existing = await chrome.storage.session.get(SESSION_KEY_NAME);
  if (!existing[SESSION_KEY_NAME]) return null;
  const raw = base64ToBytes(existing[SESSION_KEY_NAME]);
  return crypto.subtle.importKey('raw', raw, { name: ALGO }, true, ['encrypt', 'decrypt']);
}

// ─── Encrypt / decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext secret. Returns an envelope object
 * `{ v: 1, iv: <base64>, ct: <base64> }` suitable for JSON storage.
 *
 * @param {string} plaintext
 * @returns {Promise<{ v: number, iv: string, ct: string }>}
 */
async function encryptSecret(plaintext) {
  const key = await getOrCreateSessionKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  return {
    v: 1,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(cipher),
  };
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Returns null if the
 * envelope is malformed or the ephemeral key is unavailable / wrong (e.g. after
 * a browser restart). Callers treat null as "no key configured".
 *
 * @param {{ v?: number, iv?: string, ct?: string }} envelope
 * @returns {Promise<string|null>}
 */
async function decryptSecret(envelope) {
  if (!envelope || typeof envelope !== 'object' || !envelope.iv || !envelope.ct) {
    return null;
  }
  const key = await getSessionKey();
  if (!key) return null;

  try {
    const iv = base64ToBytes(envelope.iv);
    const ct = base64ToBytes(envelope.ct);
    const plain = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
    return new TextDecoder().decode(plain);
  } catch {
    // Wrong key (restart) or tampered ciphertext — treat as no usable secret.
    return null;
  }
}

/**
 * Heuristic: does a stored value look like an encryption envelope (vs a
 * legacy plaintext string)? Used so reads degrade gracefully on values that
 * predate encryption.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnvelope(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.iv === 'string' &&
    typeof value.ct === 'string'
  );
}

export { encryptSecret, decryptSecret, isEnvelope, SESSION_KEY_NAME };
