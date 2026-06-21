/**
 * sync-digest.js — Canonical content identity for Units (projects & recordings)
 *
 * Graded classification needs a trustworthy notion of "are these two Units the
 * same content?" Against an opaque last-write-wins server, timestamps and
 * `last_modified` are unreliable, so the Conflict_Detector compares **canonical
 * content digests** instead (design: "content-hash equality drives
 * classification, not timestamps").
 *
 * This module is pure logic. It exposes three helpers:
 *
 *   - `canonicalize`     — deterministic, key-order-independent JSON for any
 *                          JSON-serializable value (object keys sorted at every
 *                          depth; array order preserved; `undefined` dropped
 *                          consistently).
 *   - `digestRecording`  — content digest of a recording, folding its name and
 *                          metadata into identity and covering the FULL committed
 *                          `steps` history sorted by `(logical_id, uuid)`.
 *   - `digestProject`    — content digest of a project, folding its name and
 *                          metadata into identity and composing the ordered
 *                          recording digests.
 *
 * Design decisions:
 *
 *   - **Allowlisted projection.** The digest is computed over the
 *     SAME explicit field allowlist the pull path uses when it reconstructs a
 *     project (see `pullProjects` in sync-client.js): project →
 *     `project_id`, `name`, `created_at`, `metadata?`, `recordings`; recording →
 *     `recording_id`, `name`, `created_at`, `metadata?`, `steps`. Any other
 *     top-level field (e.g. `last_modified`, or a future optional
 *     concurrency-control token) is dropped before hashing, so unrecognized
 *     server fields can never affect content identity — a future protocol
 *     version may add an optional token without breaking clients, and an
 *     unreliable `last_modified` never causes a spurious divergence.
 *
 *   - **Steps are authored content, included verbatim.** The pull reconstruction
 *     passes `steps` through without an inner allowlist, so the digest does too:
 *     every field of every step record is part of identity. The complete history
 *     (all version records AND tombstones) is included — not the Active View —
 *     so two recordings are equal iff their committed histories are equal. This
 *     is what makes `already-converged` detection robust regardless of baseline
 * and keeps tombstones/re-records part of identity.
 *
 *   - **Name and metadata are part of identity.** Both are folded into the
 *     digest, so a name-only or metadata-only change is classified by the same
 *     rules as any other change (already-converged / changed-incoming /
 *     diverged), with no project-vs-recording asymmetry.
 *
 *   - **The digest IS the canonical projection string.** Rather than a fixed-size
 *     hash, the "digest" is the canonical JSON of the allowlisted projection.
 *     Equality of digests is therefore EXACTLY equality of canonical content,
 *     with zero collision risk. This is deliberate: a hash collision in
 *     classification would manifest as exactly the silent data loss this feature
 *     exists to prevent, and shared code ships to the Chrome extension and the
 *     Tauri webview, where a synchronous strong hash (`node:crypto`) is not
 *     available. Trading a little storage for collision-free correctness is the
 *     right call here; the recoverable copies stored alongside each digest are
 *     already full projections, so the relative overhead is small.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * Recursively rebuild a JSON-serializable value into a canonical form: object
 * keys are emitted in sorted order at every depth, array element order is
 * preserved (array order is semantically meaningful), and `undefined`-valued
 * object properties are dropped so they cannot create non-determinism. Returned
 * value is fed straight to {@link canonicalize}'s `JSON.stringify`.
 *
 * @param {unknown} value
 * @returns {unknown} a structurally-canonical clone of `value`
 */
function canonicalForm(value) {
  // Primitives and null pass through unchanged; JSON.stringify renders them
  // deterministically.
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Arrays: preserve order, canonicalize each element.
  if (Array.isArray(value)) {
    return value.map((element) => canonicalForm(element));
  }

  // Plain objects: emit keys in sorted order so object key order can never
  // affect the result, dropping any `undefined` values for stability.
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) continue;
    result[key] = canonicalForm(child);
  }
  return result;
}

/**
 * Produce a deterministic, key-order-independent JSON string for any
 * JSON-serializable value. Two values that differ only in object key ordering
 * (at any depth) produce byte-identical output; arrays, being ordered, are
 * preserved as-is.
 *
 * @param {unknown} value - any JSON-serializable value
 * @returns {string} canonical JSON
 */
export function canonicalize(value) {
  return JSON.stringify(canonicalForm(value));
}

/**
 * Order two step records by `(logical_id, uuid)` so a recording's committed
 * history hashes identically regardless of the order records happen to arrive
 * in. Both keys are time-ordered UUIDv7 strings; missing keys sort first via the
 * empty-string fallback (defensive — committed records always carry both).
 *
 * @param {{logical_id?: string, uuid?: string}} a
 * @param {{logical_id?: string, uuid?: string}} b
 * @returns {number}
 */
function compareSteps(a, b) {
  const logicalA = a?.logical_id ?? '';
  const logicalB = b?.logical_id ?? '';
  if (logicalA < logicalB) return -1;
  if (logicalA > logicalB) return 1;
  const uuidA = a?.uuid ?? '';
  const uuidB = b?.uuid ?? '';
  if (uuidA < uuidB) return -1;
  if (uuidA > uuidB) return 1;
  return 0;
}

/**
 * Compute the canonical content digest of a single recording.
 *
 * Folds the recording's name and metadata into identity and covers the
 * FULL committed step history — every version record and tombstone — sorted by
 * `(logical_id, uuid)`, never the Active View and never Pending Actions.
 * Only the allowlisted recording fields are projected; any other top-level field
 * is dropped before hashing. `metadata` is included only when present,
 * matching the pull reconstruction allowlist exactly.
 *
 * @param {import('./sync-types.js').RecordingCopy | object} recording
 * @returns {string} the recording's canonical content digest
 */
export function digestRecording(recording) {
  const steps = Array.isArray(recording?.steps) ? [...recording.steps] : [];
  steps.sort(compareSteps);

  const projection = {
    recording_id: recording?.recording_id,
    name: recording?.name,
    created_at: recording?.created_at,
    ...(recording?.metadata && { metadata: recording.metadata }),
    steps,
  };

  return canonicalize(projection);
}

/**
 * Compute the canonical content digest of a project.
 *
 * Folds the project's name and metadata into identity and composes the
 * ordered recording digests (recording array order is preserved). Only the
 * allowlisted project fields are projected; any other top-level field is dropped
 * before hashing. `metadata` is included only when present, matching the
 * pull reconstruction allowlist exactly.
 *
 * @param {import('./sync-types.js').ProjectCopy | object} project
 * @returns {string} the project's canonical content digest
 */
export function digestProject(project) {
  const recordings = Array.isArray(project?.recordings) ? project.recordings : [];

  const projection = {
    project_id: project?.project_id,
    name: project?.name,
    created_at: project?.created_at,
    ...(project?.metadata && { metadata: project.metadata }),
    recordings: recordings.map((recording) => digestRecording(recording)),
  };

  return canonicalize(projection);
}

/**
 * Compute the canonical content digest of a project's OWN identity — its
 * allowlisted scalar fields (`project_id`, `name`, `created_at`, and `metadata`
 * when present) — with its recordings deliberately EXCLUDED. This isolates
 * project-scoped identity from recording-scoped identity so a project metadata
 * change is compared as its own Unit, matching the project-metadata Unit
 * the Conflict_Detector classifies. Uses the same allowlist and canonicalization
 * as {@link digestProject} (minus `recordings`), so unrecognized top-level fields
 * never affect it.
 *
 * @param {import('./sync-types.js').ProjectCopy | object | null} project
 * @returns {string|null} the project's metadata digest, or null when absent
 */
export function digestProjectMetadata(project) {
  if (project == null) return null;
  const projection = {
    project_id: project.project_id,
    name: project.name,
    created_at: project.created_at,
    ...(project.metadata && { metadata: project.metadata }),
  };
  return canonicalize(projection);
}
