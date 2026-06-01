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
