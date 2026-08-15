/**
 * governance-data.js — the data access the governance checks share: the clause
 * registry's path, the refusal a bad read raises, the loader that turns the
 * committed file into rows, and the tree reader whose answer says which of the
 * things a read can find it found.
 *
 * This module is deliberately lean: it imports node builtins and nothing else.
 * A check that wants only the registry's data takes it from here and inherits
 * exactly that, which is what keeps the import closure of a command line free
 * of the markdown parser the registry check itself needs for its own legs.
 *
 * It is data access, not a check — it has no CLI and holds nothing on its own.
 * What each consumer does with what it reads stays that check's own subject.
 *
 * Two neighbours a reader arriving here will want. The AREA MAP's loader is
 * deliberately not here: it lives with its own check
 * ([`check-area-map.js`](./check-area-map.js)), which is already
 * dependency-free, so moving it would buy nothing and cost a redirection.
 * And this module has no suite of its own — its pins sit beside the consumers
 * that exercise it, in `packages/shared/tests/unit/check-clause-registry.test.js`
 * (the loader family and the discriminated reader's contract).
 */

import { readFileSync } from 'node:fs';

/**
 * Repo-relative path of the clause registry. Every check that reads the
 * registry takes this constant rather than restating the literal, so the path
 * a check names in its output is the path it read.
 */
export const REGISTRY_PATH = 'docs/clause-registry.json';

/** `name` of the refusal {@link loadRegistry} raises on a file that is not the registry. */
export const REGISTRY_INPUT_ERROR_NAME = 'ClauseRegistryInputError';

/** What the registry is read for, stated on every refusal its read can raise. */
const REGISTRY_READ_FOR =
  `every clause row a consumer reads there (the doc that states the clause, how it is ` +
  `verified, and what it cites) is read from this file, so restore it before any clause ` +
  `can be held`;

/**
 * The refusal {@link loadRegistry} raises when the committed registry cannot be
 * turned into rows — whether the file could not be read at all or its text is
 * not JSON. Its message is the complete verdict — the file, which of the two it
 * was, the underlying reason, and what every consumer reads there — so a caller
 * prints the message as its own red without re-deriving anything, and `name`
 * identifies the refusal without depending on a shared class instance.
 */
export class ClauseRegistryInputError extends Error {
  /** @param {string} problem what the file turned out to be, with its underlying reason */
  constructor(problem) {
    super(`✗ ${REGISTRY_PATH} ${problem} — ${REGISTRY_READ_FOR}`);
    this.name = REGISTRY_INPUT_ERROR_NAME;
    this.problem = problem;
  }
}

/**
 * Read the registry from disk and parse it — the step that turns the committed
 * file into the rows the command lines that load it through here read. The read
 * is inside the guarded region with the parse: a file that cannot be read at all
 * and a file whose text is not JSON are both refused with a named verdict about
 * the check's own input, each saying which of the two it was. Holding both in
 * one home is what keeps the command lines that load the registry through this
 * loader from answering a broken file differently. The read seam is a parameter
 * so the decision can be exercised without touching the tree.
 * @param {(path: string) => string} [read] how the file's text is read
 * @throws {ClauseRegistryInputError} when the file cannot be read, or its text is not JSON
 * @returns {any} the parsed registry
 */
export function loadRegistry(read = (p) => readFileSync(p, 'utf8')) {
  let text;
  try {
    text = read(REGISTRY_PATH);
  } catch (err) {
    throw new ClauseRegistryInputError(`could not be read — ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ClauseRegistryInputError(`does not read as JSON — ${err.message}`);
  }
}

/**
 * The refusal posture every command line that loads the registry through this
 * home shares, in one home so they cannot answer differently: a file that does
 * not read as the registry is breakage on the check's own input, so the caller
 * prints the refusal's own message and ends red on the ordinary red path, while
 * anything else it caught is rethrown untouched. The printing and exiting seams
 * are parameters so the decision can be exercised without ending the process.
 * @param {unknown} err the error a caller caught around the registry read
 * @param {object} [io] the print and exit seams
 * @param {(message: string) => void} [io.error] where the refusal is printed
 * @param {(code: number) => void} [io.exit] how the run ends
 * @throws {unknown} whatever it was handed, when that is not the refusal
 * @returns {void}
 */
export function refuseOnRegistryError(
  err,
  { error = (m) => console.error(m), exit = (c) => process.exit(c) } = {},
) {
  if (err?.name !== REGISTRY_INPUT_ERROR_NAME) throw err;
  error(err.message);
  exit(1);
}

/**
 * Read a file for a check that reads many of them, discriminating the three
 * answers a read has: the file's text, `''` for a file that is there and empty,
 * and `null` for one that could not be read at all. The three are distinct at
 * the boundary because a consumer's diagnosis differs — an empty surface is a
 * document that lost its content, an unreadable one is a file the tree cannot
 * hand over, and a reader that answers `''` to both makes the second
 * indistinguishable from the first for every guard downstream.
 *
 * A check whose whole run depends on one file refuses loudly instead (the
 * registry's loader above is the model); this reader is for the checks that
 * read a surface at a time and report per surface.
 * @param {string} path the path to read, as the caller resolves it
 * @returns {string | null} the text, or `null` when the file could not be read
 */
export function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
