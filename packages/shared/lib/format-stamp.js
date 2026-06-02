/**
 * format-stamp.js — The self-describing `docent_format` stamp.
 *
 * Every `.docent.json` export and every dispatch payload carries a required
 * `docent_format: { platform, schema_version }` object at its root. It lets any
 * consumer pick the correct schema and route migrations without guessing which
 * Docent platform/version produced the file.
 *
 * The values are NOT hard-coded here — the composed platform schema is the
 * single source of truth. The composer pins `docent_format.platform` and
 * `docent_format.schema_version` as `const`s per platform (see
 * scripts/build-schemas.js); this helper reads them straight back off the schema
 * the producer already has in hand, so the stamp can never drift from the schema
 * it claims to conform to.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * Build the `docent_format` stamp by reading the pinned consts off a composed
 * platform schema.
 *
 * @param {object} schema - a composed platform schema (with $defs.docent_format)
 * @returns {{ platform: string, schema_version: string }}
 * @throws {Error} if the schema does not carry the pinned stamp consts
 */
export function stampFromSchema(schema) {
  const props = schema?.$defs?.docent_format?.properties;
  const platform = props?.platform?.const;
  const schema_version = props?.schema_version?.const;
  if (typeof platform !== 'string' || typeof schema_version !== 'string') {
    throw new Error(
      'Cannot build docent_format stamp: schema is missing docent_format platform/schema_version consts',
    );
  }
  return { platform, schema_version };
}

/**
 * @typedef {Object} StampCheck
 * @property {boolean} compatible - true when the payload's stamp matches the local platform + version
 * @property {'ok'|'missing'|'platform'|'version'} reason - why it is (in)compatible
 * @property {string|null} message - human-readable explanation, null when compatible
 */

/**
 * Compare an incoming payload's `docent_format` stamp against the stamp the
 * local client expects (read off its own composed schema). Used on the sync
 * pull path to give an actionable reason when a project cannot be accepted —
 * distinct from generic schema-shape validation, which would only say "invalid".
 *
 * Classifies the mismatch so the caller can tell the user *why*:
 *   - `missing`  — no/!malformed stamp on the payload
 *   - `platform` — a different Docent platform (e.g. desktop project on an extension client)
 *   - `version`  — same platform, different schema version (update or pin)
 *
 * @param {unknown} payload - the incoming payload (its `.docent_format` is read)
 * @param {{ platform: string, schema_version: string }} localStamp - from stampFromSchema(localSchema)
 * @returns {StampCheck}
 */
export function checkStampCompatibility(payload, localStamp) {
  const stamp = payload?.docent_format;
  if (!stamp || typeof stamp.platform !== 'string' || typeof stamp.schema_version !== 'string') {
    return {
      compatible: false,
      reason: 'missing',
      message: 'missing or malformed docent_format stamp',
    };
  }
  if (stamp.platform !== localStamp.platform) {
    return {
      compatible: false,
      reason: 'platform',
      message: `from a different Docent platform (${stamp.platform}; this client is ${localStamp.platform})`,
    };
  }
  if (stamp.schema_version !== localStamp.schema_version) {
    return {
      compatible: false,
      reason: 'version',
      message: `schema version ${stamp.schema_version} does not match this client's ${localStamp.schema_version} — update Docent or pin the producing version`,
    };
  }
  return { compatible: true, reason: 'ok', message: null };
}
