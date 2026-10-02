/**
 * vector-meta-schema.js — the code-side home of the conformance-vector
 * meta-schema (corpus/vector.schema.json): the outcome every shipped vector
 * states, and the one construction of the validator that holds a vector to the
 * meta-schema.
 *
 * The outcome a shipped vector carries is the meta-schema's own
 * `expected_outcome` const, and §STC-23 of
 * docs/verification/scripted-truth-corpus.md states it in prose (the
 * verification-inventory lint holds the two to each other). The emitters stamp
 * `SHIPPED_OUTCOME` rather than spelling the value, and a unit suite holds this
 * constant equal to the meta-schema's const.
 *
 * Every caller holds a vector to the meta-schema through `metaSchemaErrors`:
 * the extension corpus run and the desktop vectors assembler at the produce
 * stage, over every vector they emit, and the shared unit suite over the
 * committed vectors. The name says what it returns — an error list, empty when
 * valid — because an always-truthy array passes an existence check silently.
 *
 * Unlike snapshot-walker.js beside it, this module is never injected into a
 * page, so it imports freely. It is repo/CI machinery, excluded from every
 * release like the rest of corpus/.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/** The outcome every shipped conformance vector states under `expected_outcome`. */
export const SHIPPED_OUTCOME = 'resolved';

/** Absolute path of the vector meta-schema, resolved relative to this module. */
export const VECTOR_META_SCHEMA_PATH = fileURLToPath(
  new URL('../vector.schema.json', import.meta.url),
);

/**
 * Read and parse the vector meta-schema.
 *
 * @returns {object} the parsed meta-schema document
 */
export function loadVectorMetaSchema() {
  return JSON.parse(readFileSync(VECTOR_META_SCHEMA_PATH, 'utf8'));
}

let compiled = null;

/**
 * The vector's meta-schema errors — an array of Ajv's error objects, empty when
 * the vector is valid. Reports a vector's violations rather than throwing on
 * them: the caller picks the failure channel (an assertion message, a test
 * expectation, an exit code) and can report every vector of a run rather than
 * stopping at the first. The meta-schema is compiled once, on the first call,
 * with Ajv's 2020-12 dialect, `strict: false`, `allErrors: true` and the
 * ajv-formats keywords — the construction the hygiene suite used before this
 * module held it; an unreadable or uncompilable meta-schema throws on that
 * first call. The list is copied as defence; Ajv allocates a new one per call.
 *
 * @param {unknown} vector
 * @returns {object[]}
 */
export function metaSchemaErrors(vector) {
  if (compiled === null) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    compiled = ajv.compile(loadVectorMetaSchema());
  }
  return compiled(vector) ? [] : [...compiled.errors];
}

/**
 * Render an error list one error per line, for a failure message.
 *
 * @param {object[]} errors — as returned by `metaSchemaErrors`
 * @returns {string} every error as `<instance path> <message> <params> (<schema path>)`
 */
export function formatMetaSchemaErrors(errors) {
  return errors
    .map(
      (e) => `${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)} (${e.schemaPath})`,
    )
    .join('\n');
}
