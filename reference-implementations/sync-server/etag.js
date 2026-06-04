/**
 * etag.js — deterministic, content-derived ETag for the Reference Sync Server.
 *
 * The optional conditional-write enhancement (docent#152) needs a stable,
 * opaque entity-tag the server can advertise on reads and check on `If-Match`
 * writes. `deriveETag` produces that tag deterministically from a project's
 * content, so two reads of the same unchanged project return the same ETag, and
 * any change to the content yields a different one (Requirements 6.1, 6.6).
 *
 * Derivation: canonical JSON (object keys sorted at every depth, array order
 * preserved, `undefined` dropped) → SHA-256 (`node:crypto`, standard library,
 * Requirement 8.1) → the hex digest wrapped in double quotes per the HTTP ETag
 * syntax (RFC 9110 §8.8.3).
 *
 * Canonicalization source: to stay faithful to the client's notion of content
 * identity (Requirement 8.2), this module uses `packages/shared`'s
 * `canonicalize` WHEN it can be imported, and falls back to a local key-sorted
 * canonicalizer when it cannot — so the reference server keeps working when it
 * is copied out of the monorepo on its own (Requirement 8.2: the shared helpers
 * MAY be used but are never a hard dependency). Either canonicalizer is
 * deterministic for a given content, which is all the ETag contract requires
 * (the tag is opaque to clients; only stability and change-sensitivity matter).
 *
 * The ETag is derived from the payload content ONLY — never from the
 * server-maintained `last_modified`, which is stored alongside the payload and
 * is not part of it (Requirement 6.1).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module etag
 */

import { createHash } from 'node:crypto';

/**
 * Local key-sorted canonicalizer — the graceful fallback used when the shared
 * `canonicalize` cannot be imported. Mirrors the shared helper's behavior:
 * object keys are emitted in sorted order at every depth, array element order is
 * preserved (array order is semantically meaningful), and `undefined`-valued
 * object properties are dropped so they cannot create non-determinism.
 *
 * @param {unknown} value - any JSON-serializable value
 * @returns {unknown} a structurally-canonical clone of `value`
 */
function localCanonicalForm(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((element) => localCanonicalForm(element));
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) continue;
    result[key] = localCanonicalForm(child);
  }
  return result;
}

/**
 * Produce a deterministic, key-order-independent JSON string for any
 * JSON-serializable value (local fallback implementation).
 *
 * @param {unknown} value - any JSON-serializable value
 * @returns {string} canonical JSON
 */
function localCanonicalize(value) {
  return JSON.stringify(localCanonicalForm(value));
}

/**
 * The canonicalizer used to project a payload before hashing. Resolved once at
 * module load: the shared `canonicalize` when importable, the local fallback
 * otherwise. Top-level `await` keeps `deriveETag` itself synchronous.
 *
 * @type {(value: unknown) => string}
 */
let canonicalize = localCanonicalize;
try {
  // Soft dependency: relative path from this file up to the monorepo's shared
  // package. Absent when the reference server is used standalone — the catch
  // then leaves the local fallback in place (Requirement 8.2).
  ({ canonicalize } = await import('../../packages/shared/sync-digest.js'));
} catch {
  canonicalize = localCanonicalize;
}

/**
 * Derive a deterministic, opaque ETag from a stored payload's content
 * (Requirements 6.1, 6.6).
 *
 * Canonical JSON → SHA-256 → quoted hex. Two reads of the same unchanged
 * project yield the same ETag; any content change yields a different one. The
 * tag is derived from the payload content only, never from `last_modified`.
 *
 * @param {object} payload - the verbatim Full_Project_Payload
 * @returns {string} the ETag, e.g. `"a1b2c3…"` (quoted per HTTP ETag syntax)
 */
export function deriveETag(payload) {
  const canonical = canonicalize(payload);
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `"${hex}"`;
}
