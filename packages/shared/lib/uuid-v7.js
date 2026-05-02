/**
 * Docent — UUID v7 generation
 * Time-ordered UUIDs for step versioning and history tracking.
 *
 * Structure (128 bits):
 *   [48 bits unix_ts_ms] [4 bits ver=7] [12 bits rand_a] [2 bits variant=10] [62 bits rand_b]
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * Generates a UUID v7.
 * @returns {string} e.g. "018f4e2a-1234-7abc-8def-000000000000"
 */
export function uuidv7() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ms = BigInt(Date.now());

  // Timestamp — 48 bits
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n)  & 0xffn);
  bytes[5] = Number(ms          & 0xffn);

  // Version — 4 bits set to 0111 (7)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Variant — 2 bits set to 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Extracts the embedded timestamp from a UUID v7.
 * @param {string} uuid
 * @returns {Date}
 */
export function uuidv7ToDate(uuid) {
  const hex = uuid.replace(/-/g, '').slice(0, 12);
  return new Date(parseInt(hex, 16));
}

/**
 * Compares two UUID v7 strings chronologically.
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareUuidv7(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
