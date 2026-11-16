/**
 * pairing.js: the pairing's pure parts, for the local process side of the
 * local control channel (docs/api/control-channel.md): the shape of a pairing
 * code a person typed, the local process's nonce, and the HMAC-SHA256 proofs
 * in both directions (control-channel LC-4).
 *
 * Plain data in and out, with node:crypto as the only dependency. Nothing here
 * logs, and no value it returns repeats a code or a proof it was given.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The 32 characters a pairing code is drawn from (control-channel LC-4). */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters in a pairing code, hyphens not counted. */
export const PAIRING_CODE_LENGTH = 16;

/** Bytes of randomness in a nonce: 32 hexadecimal characters. */
const NONCE_BYTES = 16;

// The code as the panel shows it (four groups of four, hyphenated) or without
// its hyphens, which are display only.
const BARE_CODE = new RegExp(`^[${CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);
const GROUPED_CODE = new RegExp(`^[${CODE_ALPHABET}]{4}(?:-[${CODE_ALPHABET}]{4}){3}$`);

/** The form of a nonce, either side's (control-channel LC-4). */
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** The form of a proof: 64 lowercase hexadecimal characters. */
const PROOF_PATTERN = /^[0-9a-f]{64}$/;

/** Each direction's label, written ahead of the other side's nonce. */
const PROOF_LABELS = Object.freeze({ local: 'local:', panel: 'panel:' });

/**
 * Check the shape of a pairing code a person typed, before anything is sent
 * or opened, and return the code as the proofs are keyed by it: its 16
 * characters, without the hyphens. Surrounding whitespace is dropped and
 * letters are read as the panel shows them, in uppercase. A refusal carries
 * no detail, so it never repeats what was typed.
 *
 * @param {unknown} typed
 * @returns {{ok: true, code: string} | {ok: false}}
 */
export function normalizePairingCode(typed) {
  if (typeof typed !== 'string') return { ok: false };
  const text = typed.trim().toUpperCase();
  if (BARE_CODE.test(text)) return { ok: true, code: text };
  if (GROUPED_CODE.test(text)) return { ok: true, code: text.replaceAll('-', '') };
  return { ok: false };
}

/**
 * Draw the local process's nonce for one connection (control-channel LC-4:
 * from a cryptographically strong random source, anew for each connection).
 *
 * @param {(size: number) => Uint8Array} [source] - returns `size` random
 *   bytes; node:crypto's randomBytes unless a test supplies its own
 * @returns {string|null} 32 lowercase hexadecimal characters, or null when
 *   the source throws or gives anything but exactly 16 bytes
 */
export function generateNonce(source = randomBytes) {
  let bytes;
  try {
    bytes = source(NONCE_BYTES);
  } catch {
    return null;
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== NONCE_BYTES) return null;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/**
 * Whether a value is a nonce of the stated form.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNonce(value) {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

/**
 * One direction's proof: HMAC-SHA256 keyed by the code's 16 characters (UTF-8)
 * over the direction's label followed by the other side's nonce, in lowercase
 * hexadecimal (control-channel LC-4). The local process proves over the
 * panel's nonce (`local`); the panel over the local process's (`panel`).
 *
 * @param {string} code - the code without hyphens
 * @param {string} nonce - the other side's nonce
 * @param {'local'|'panel'} side - whose proof this is
 * @returns {string}
 */
export function computeProof(code, nonce, side) {
  if (!Object.hasOwn(PROOF_LABELS, side)) throw new TypeError('Unknown proof direction');
  return createHmac('sha256', Buffer.from(code, 'utf8'))
    .update(`${PROOF_LABELS[side]}${nonce}`, 'utf8')
    .digest('hex');
}

/**
 * Check the panel's proof over the local process's nonce. A proof not of the
 * stated form is refused before any comparison; the comparison itself takes
 * the same time wherever the first difference falls.
 *
 * @param {{code: string, nonce: string, proof: unknown}} params - `nonce` is
 *   the local process's own
 * @returns {boolean}
 */
export function verifyPanelProof({ code, nonce, proof }) {
  if (typeof proof !== 'string' || !PROOF_PATTERN.test(proof)) return false;
  const expected = Buffer.from(computeProof(code, nonce, 'panel'), 'utf8');
  return timingSafeEqual(expected, Buffer.from(proof, 'utf8'));
}
