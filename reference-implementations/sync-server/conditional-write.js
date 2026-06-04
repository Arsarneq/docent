/**
 * conditional-write.js — the explicit If-Match / ETag gate for the Reference
 * Sync Server (optional optimistic concurrency, docent#152).
 *
 * Requirement 11.1 demands that the conditional-write behavior live in a
 * clearly identified, explicitly named unit rather than as an implicit side
 * effect of normal write handling. This module is that unit: the PUT handler
 * calls `evaluateConditionalWrite` BEFORE storing, and acts on its decision.
 *
 * Decision table (Requirements 6.3, 6.4, 6.5):
 *
 *   | If-Match header | stored project | result                        |
 *   | --------------- | -------------- | ----------------------------- |
 *   | absent          | any            | proceed (last-write-wins, 6.5)|
 *   | present         | matches ETag   | proceed (6.3)                 |
 *   | present         | ETag mismatch  | reject 412 (6.4)              |
 *   | present         | absent (null)  | reject 412 (6.4)              |
 *
 * The precondition is evaluated against the stored project's CURRENT ETag,
 * derived from its content only via `deriveETag(existing.payload)` — never from
 * the server-maintained `last_modified` (Requirement 6.1). When the request
 * carries no `If-Match`, the write is an ordinary last-write-wins write and the
 * stored ETag is irrelevant (Requirement 6.5). When an `If-Match` is present
 * but no project is stored, the precondition cannot match and the write is
 * rejected with 412 (Requirement 6.4); a first-time create normally arrives
 * with no `If-Match` and is allowed by the absent-header branch.
 *
 * Producing the observable 412 here (and the fresh ETag from the PUT handler)
 * keeps the behavior visible to a client without inspecting server internals
 * (Requirement 11.3).
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

/**
 * Evaluate the optional conditional-write precondition (docent#152,
 * Requirement 6) for a `PUT /projects/:id` request.
 *
 * This is a pure decision function: it reads no I/O and mutates nothing, so the
 * PUT handler stays in control of when (and whether) the store is touched. A
 * `{ proceed: false }` result means the handler must reject with the given
 * status and leave stored data unchanged (Requirement 6.4).
 *
 * @param {string|null|undefined} ifMatch
 *   The raw `If-Match` request header value, or null/undefined when the request
 *   omits the header (absent → last-write-wins, Requirement 6.5).
 * @param {StoredProject|null} existing
 *   The currently stored project record (`{ payload, last_modified }`), or null
 *   when no project is stored for this id. The ETag is derived from
 *   `existing.payload` (content only, Requirement 6.1).
 * @returns {ConditionalWriteDecision}
 *   - `If-Match` absent                                   → `{ proceed: true }` (R6.5)
 *   - `If-Match` present and matching                     → `{ proceed: true }` (R6.3)
 *   - `If-Match` present and not matching (incl. no project) → `{ proceed: false, status: 412 }` (R6.4)
 */
export function evaluateConditionalWrite(ifMatch, existing) {
  // R6.5: no If-Match header → last-write-wins. The write proceeds regardless of
  // the stored project's current ETag (which may be anything, or absent).
  if (ifMatch === undefined || ifMatch === null) {
    return { proceed: true };
  }

  // An If-Match is present. R6.4: if nothing is stored, the precondition cannot
  // match — reject with 412 and store nothing.
  if (existing === null || existing === undefined) {
    return { proceed: false, status: 412 };
  }

  // R6.3 / R6.4: compare the request's If-Match value against the stored
  // project's CURRENT ETag, derived from its content only (never last_modified).
  const currentETag = deriveETag(existing.payload);
  if (ifMatch === currentETag) {
    return { proceed: true };
  }

  return { proceed: false, status: 412 };
}
