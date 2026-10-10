/**
 * conditional-write.js — the explicit If-Match / ETag gate for the Reference
 * Sync Server (optional optimistic concurrency, docent#152).
 *
 * The conditional-write behavior lives in a
 * clearly identified, explicitly named unit rather than as an implicit side
 * effect of normal write handling. This module is that unit: the PUT handler
 * calls `evaluateConditionalWrite` BEFORE storing, and acts on its decision.
 *
 * Decision table (the sync protocol's SP-14 conditional-write rule):
 *
 *   | If-Match header | stored project | result                    |
 *   | --------------- | -------------- | ------------------------- |
 *   | absent          | any            | proceed (last-write-wins) |
 *   | present         | matches ETag   | proceed                   |
 *   | present (`*`)   | stored         | proceed                   |
 *   | present         | ETag mismatch  | reject 412                |
 *   | present         | absent (null)  | reject 412                |
 *
 * "Matches" is HTTP's If-Match rule (RFC 9110 §13.1.1): `*` matches when a
 * project is stored under the request's id, and an entity-tag list matches
 * when a member equals the current ETag under strong comparison (§8.8.3.2) —
 * a weak tag never matches. An empty list has no member to match (§13.1.1,
 * its second evaluation step), and a value that does not parse as `*` or an
 * entity-tag list matches nothing (its last step: otherwise the condition is
 * false).
 *
 * An entity-tag list is evaluated against the stored project's CURRENT ETag,
 * derived from its content only via `deriveETag(existing.payload)` — never from
 * the server-maintained `last_modified`; `*` needs no ETag, a stored project
 * being enough. When the request
 * carries no `If-Match`, the write is an ordinary last-write-wins write and the
 * stored ETag is irrelevant. When an `If-Match` is present
 * but no project is stored, the precondition cannot match and the write is
 * rejected with 412; a first-time create normally arrives
 * with no `If-Match` and is allowed by the absent-header branch.
 *
 * Producing the observable 412 here (and the fresh ETag from the PUT handler)
 * keeps the behavior visible to a client without inspecting server internals.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module conditional-write
 */

import { deriveETag } from './etag.js';

/**
 * @typedef {import('./storage/provider.js').StoredProject} StoredProject
 */

/**
 * The result of evaluating the conditional-write precondition.
 *
 * @typedef {{ proceed: true } | { proceed: false, status: 412 }} ConditionalWriteDecision
 */

/** The whole value is `*`, with optional space or tab on either side (RFC 9110 §13.1.1). */
const WILDCARD = /^[ \t]*\*[ \t]*$/;

/**
 * One member of an If-Match entity-tag list, at the start of the rest of the value; members are
 * matched in place, not split on commas: a comma is legal inside an opaque-tag (RFC 9110 §8.8.3).
 */
const ENTITY_TAG = /(W\/)?"[\x21\x23-\x7E\x80-\xFF]*"/y;

/** Advance past optional whitespace (RFC 9110 OWS: space and tab). */
function skipOws(value, i) {
  while (i < value.length && (value[i] === ' ' || value[i] === '\t')) i++;
  return i;
}

/**
 * Parse an `If-Match` field value (RFC 9110 §13.1.1: `"*" / #entity-tag`).
 *
 * Space, tab and empty list members are skipped before and after each member, as HTTP's list
 * syntax allows; an empty value is an empty list.
 *
 * @param {string} value  the raw header value
 * @returns {'*' | Array<{ weak: boolean, opaque: string }> | null}
 *   `'*'`, the list's members, or null when the value is neither.
 */
function parseIfMatch(value) {
  if (WILDCARD.test(value)) return '*';
  const members = [];
  let i = skipOws(value, 0);
  while (i < value.length) {
    if (value[i] === ',') {
      i = skipOws(value, i + 1);
      continue;
    }
    ENTITY_TAG.lastIndex = i;
    const match = ENTITY_TAG.exec(value);
    if (match === null) return null;
    const weak = match[1] !== undefined;
    members.push({ weak, opaque: match[0].slice(weak ? 2 : 0) });
    i = skipOws(value, ENTITY_TAG.lastIndex);
    if (i < value.length && value[i] !== ',') return null;
  }
  return members;
}

/**
 * Evaluate the optional conditional-write precondition (docent#152) for a
 * `PUT /projects/:id` request.
 *
 * This is a pure decision function: it reads no I/O and mutates nothing, so the
 * PUT handler stays in control of when (and whether) the store is touched. A
 * `{ proceed: false }` result means the handler must reject with the given
 * status and leave stored data unchanged.
 *
 * @param {string|null|undefined} ifMatch
 *   The raw `If-Match` request header value, or null/undefined when the request
 *   omits the header (absent → last-write-wins).
 * @param {StoredProject|null} existing
 *   The currently stored project record (`{ payload, last_modified }`), or null
 *   when no project is stored for this id. The ETag is derived from
 *   `existing.payload` (content only).
 * @returns {ConditionalWriteDecision}
 *   - `If-Match` absent                                   → `{ proceed: true }`
 *   - `If-Match` present and matching                     → `{ proceed: true }`
 *   - `If-Match` present and not matching (incl. no project) → `{ proceed: false, status: 412 }`
 */
export function evaluateConditionalWrite(ifMatch, existing) {
  // no If-Match header → last-write-wins. The write proceeds regardless of
  // the stored project's current ETag (which may be anything, or absent).
  if (ifMatch === undefined || ifMatch === null) {
    return { proceed: true };
  }

  // An If-Match is present. if nothing is stored, the precondition cannot
  // match — reject with 412 and store nothing.
  if (existing === null || existing === undefined) {
    return { proceed: false, status: 412 };
  }

  const parsed = parseIfMatch(ifMatch);
  if (parsed === '*') {
    return { proceed: true };
  }

  // Compare the request's If-Match value against the stored project's CURRENT
  // ETag, derived from its content only (never last_modified).
  const currentETag = deriveETag(existing.payload);
  if (parsed !== null && parsed.some((m) => !m.weak && m.opaque === currentETag)) {
    return { proceed: true };
  }

  return { proceed: false, status: 412 };
}
