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
 * A vector's element_facts and locators are the recorded element split in two,
 * and the meta-schema leaves their shape to the platform's .docent.json schema.
 * `elementCheckErrors` holds them to the element check: the platform's composed
 * element definition (scripts/build-schemas.js) plus the locator pair rule.
 * The rule's ordering half — a numeric match_index only beside a match_count
 * and below it — is the sufficiency lint's `locator-pair-invariants`
 * predicate; its other half — each match_count and match_index a finite
 * integer where present — is this module's own finiteness check, the schema
 * holding integrality. Its callers are the extension corpus
 * run and the desktop vectors assembler at the produce stage, each over every
 * vector it emits that passes the meta-schema, and the hygiene suite
 * (packages/shared/tests/unit/conformance-vectors.test.js) over every
 * committed vector that passes the meta-schema (its case returns early
 * otherwise). The list it returns is the matching locator member's
 * schema errors (with the element facts' own); then, when those are empty, one
 * `finite` error per non-finite match_count or match_index, else the pair
 * rule's first finding. The finiteness error can fire only in the hygiene
 * suite, on a hand-edited committed file: both production sites validate the bytes
 * they write, and JSON.stringify writes a non-finite number as null, while a
 * parsed `1e400` is Infinity, which the schema's integer admits.
 *
 * `committedVectorFiles` is the one walk of the committed vectors
 * (corpus/sessions/<id>/vectors/<key>.vector.json), each parsed, that the
 * desktop assembler's completeness pass and both unit suites read them
 * through.
 *
 * Unlike snapshot-walker.js beside it, this module is never injected into a
 * page, so it imports freely. It is repository and CI machinery, never shipped
 * — the corpus doctrine (docs/verification/scripted-truth-corpus.md) states
 * that posture for corpus/.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { composePlatform } from '../../scripts/build-schemas.js';
import { PREDICATES } from '../../scripts/sufficiency-lint.js';

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

/** Absolute path of corpus/sessions, resolved relative to this module. */
const SESSIONS_DIR = fileURLToPath(new URL('../sessions/', import.meta.url));

/**
 * Every committed conformance vector, parsed, in session then key order: each
 * `<key>.vector.json` under corpus/sessions/<session>/vectors/. A file that
 * does not parse throws (JSON.parse's SyntaxError), so the caller's own failure
 * channel reports it.
 *
 * @returns {{ session: string, key: string, path: string, vector: unknown }[]}
 */
export function committedVectorFiles() {
  const found = [];
  for (const session of readdirSync(SESSIONS_DIR).sort()) {
    const dir = join(SESSIONS_DIR, session, 'vectors');
    if (!existsSync(dir)) continue;
    const keys = readdirSync(dir)
      .filter((name) => name.endsWith('.vector.json'))
      .map((name) => name.slice(0, -'.vector.json'.length))
      .sort();
    for (const key of keys) {
      const path = join(dir, `${key}.vector.json`);
      found.push({ session, key, path, vector: JSON.parse(readFileSync(path, 'utf8')) });
    }
  }
  return found;
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

const elementValidators = new Map();

/**
 * The schema half of the element check: Ajv's errors for the rejoined element
 * against the platform's composed element definition. One validator per
 * platform, compiled on first use, with the meta-schema's Ajv construction plus
 * `discriminator: true`, and the locator definition carrying a discriminator on
 * `strategy` — so a locator is validated against the one union member whose
 * `strategy` const matches and only that member's errors are reported.
 * `composePlatform` returns a fresh object per call, so the spread shows the
 * one override and nothing is written.
 *
 * @param {object} vector — a meta-schema-valid vector
 * @returns {object[]}
 */
function elementSchemaErrors(vector) {
  let validate = elementValidators.get(vector.platform);
  if (!validate) {
    const composed = composePlatform(vector.platform);
    const ajv = new Ajv({ strict: false, allErrors: true, discriminator: true });
    addFormats(ajv);
    validate = ajv.compile({
      $schema: composed.$schema,
      $ref: '#/$defs/element',
      $defs: {
        ...composed.$defs,
        locator: { ...composed.$defs.locator, discriminator: { propertyName: 'strategy' } },
      },
    });
    elementValidators.set(vector.platform, validate);
  }
  return validate({ ...vector.element_facts, locators: vector.locators })
    ? []
    : [...validate.errors];
}

const LOCATOR_PAIR_PREDICATE_ID = 'locator-pair-invariants';
const locatorPairInvariants = PREDICATES.find((p) => p.id === LOCATOR_PAIR_PREDICATE_ID);
if (!locatorPairInvariants) {
  throw new Error(
    `vector-meta-schema: the sufficiency lint has no "${LOCATOR_PAIR_PREDICATE_ID}" predicate`,
  );
}

/**
 * The vector's element-check errors — Ajv-shaped error objects, empty when its
 * element_facts + locators pass: the schema half's errors when there are any;
 * otherwise one `finite` error per non-finite match_count / match_index, and
 * when every member is finite the pair predicate's first finding as one error
 * at `/locators`. Call it only on a meta-schema-valid vector: an unknown
 * platform throws.
 *
 * @param {object} vector
 * @returns {object[]}
 */
export function elementCheckErrors(vector) {
  const schemaErrors = elementSchemaErrors(vector);
  if (schemaErrors.length > 0) return schemaErrors;
  const finiteErrors = [];
  vector.locators.forEach((locator, i) => {
    for (const key of ['match_count', 'match_index']) {
      if (typeof locator[key] === 'number' && !Number.isFinite(locator[key])) {
        finiteErrors.push({
          instancePath: `/locators/${i}/${key}`,
          schemaPath: 'finite',
          keyword: 'finite',
          params: {},
          message: 'must be finite',
        });
      }
    }
  });
  if (finiteErrors.length > 0) return finiteErrors;
  const finding = locatorPairInvariants.check({ element: { locators: vector.locators } });
  if (finding === null) return [];
  return [
    {
      instancePath: '/locators',
      schemaPath: `scripts/sufficiency-lint.js#${LOCATOR_PAIR_PREDICATE_ID}`,
      keyword: LOCATOR_PAIR_PREDICATE_ID,
      params: {},
      message: finding,
    },
  ];
}

/**
 * Render an error list one error per line, for a failure message.
 *
 * @param {object[]} errors — as returned by `metaSchemaErrors` or `elementCheckErrors`
 * @returns {string} every error as `<instance path> <message> <params> (<schema path>)`
 */
export function formatMetaSchemaErrors(errors) {
  return errors
    .map(
      (e) => `${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)} (${e.schemaPath})`,
    )
    .join('\n');
}
