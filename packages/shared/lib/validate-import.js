/**
 * validate-import.js — Schema-validate untrusted ingested data before persist.
 *
 * The platform-agnostic half of untrusted-input schema validation. Imported `.docent.json`
 * files and pulled sync payloads are untrusted input; before any of it is
 * written into stored state it must validate against the published platform
 * schema. The actual validator is generated (Ajv standalone, eval-free — see
 * scripts/build-validators.js) and injected here, so this module stays
 * platform-agnostic and testable with a stub validator.
 *
 * Design notes:
 *   - Reject-but-LOG: on failure we never persist, and we hand back the Ajv
 *     error list so the caller can surface it (console / SyncError) for
 *     traceability rather than failing silently.
 *   - Allowlist reconstruction: callers build the stored object from an explicit
 *     field allowlist rather than spreading `{...untrusted}`, so unknown/hostile
 *     top-level keys never reach storage even if a schema gap let them validate.
 *   - Bounds: a cheap size/− nesting guard runs before validation so a
 *     pathologically large or deep payload is rejected without doing the full
 *     (more expensive) schema walk.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** Max serialized size of a single ingested payload (10MB). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Max nesting depth allowed in an ingested payload. */
export const MAX_IMPORT_DEPTH = 64;

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors - human-readable error strings (empty when valid)
 */

/**
 * Compute the maximum nesting depth of a value. Bounded: stops descending once
 * `limit` is exceeded so a hostile deeply-nested payload can't make this
 * recursion itself the DoS. Returns `limit + 1` as soon as the limit is passed.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {number}
 */
function depthOf(value, limit) {
  if (value === null || typeof value !== 'object') return 0;
  let max = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const d = 1 + depthOf(child, limit);
    if (d > max) max = d;
    if (max > limit) return max; // short-circuit — no need to keep descending
  }
  return max;
}

/**
 * Format Ajv errors into short human-readable strings.
 * @param {Array<object>|null|undefined} ajvErrors
 * @returns {string[]}
 */
function formatAjvErrors(ajvErrors) {
  if (!Array.isArray(ajvErrors)) return ['unknown validation error'];
  return ajvErrors.map((e) => {
    const path = e.instancePath || '(root)';
    return `${path} ${e.message ?? 'is invalid'}`.trim();
  });
}

/**
 * Validate an ingested payload against a generated platform validator.
 *
 * Runs cheap bounds checks first (size, depth), then the schema validator.
 * Never throws on invalid input — returns a result the caller logs and acts on.
 *
 * @param {(data: unknown) => boolean & { errors?: object[] }} validator -
 *   a generated Ajv standalone validator (its `.errors` is read after a call)
 * @param {unknown} data - the untrusted parsed payload
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=MAX_IMPORT_BYTES]
 * @param {number} [opts.maxDepth=MAX_IMPORT_DEPTH]
 * @returns {ValidationResult}
 */
export function validatePayload(validator, data, opts = {}) {
  const { maxBytes = MAX_IMPORT_BYTES, maxDepth = MAX_IMPORT_DEPTH } = opts;

  if (data === null || typeof data !== 'object') {
    return { valid: false, errors: ['payload is not an object'] };
  }

  // Cheap bounds before the full schema walk.
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return { valid: false, errors: ['payload is not serializable (circular?)'] };
  }
  if (serialized.length > maxBytes) {
    return {
      valid: false,
      errors: [`payload exceeds ${maxBytes} bytes (${serialized.length})`],
    };
  }
  if (depthOf(data, maxDepth) > maxDepth) {
    return { valid: false, errors: [`payload nesting exceeds depth ${maxDepth}`] };
  }

  const ok = validator(data);
  if (!ok) {
    return { valid: false, errors: formatAjvErrors(validator.errors) };
  }
  return { valid: true, errors: [] };
}
