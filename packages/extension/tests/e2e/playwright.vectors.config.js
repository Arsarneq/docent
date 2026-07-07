/**
 * Vectors variant of the corpus config: the same corpus run with conformance-
 * vector production and the produced==committed oracle enabled (a superset of
 * truth production). CORPUS_VECTORS is set HERE — before the corpus spec module
 * loads, and re-applied in each worker that loads this config — rather than as
 * an inline shell env var, so `npm run vectors:*` stays cross-platform.
 */

process.env.CORPUS_VECTORS = '1';

export { default } from './playwright.corpus.config.js';
