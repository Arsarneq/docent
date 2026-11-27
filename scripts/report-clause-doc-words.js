/**
 * report-clause-doc-words.js — Show, for each document that holds clauses, the
 * words it held at a base commit and the words it holds now.
 *
 * The report prints one row per document whose word count changed, and a
 * total when more than one did. It exits 0 however much a document grew. The
 * docs-governance guide (docs/guides/docs-governance.md, "Words before and
 * after") holds why the numbers are shown and who reads them.
 *
 * The documents are the ones the clause registry (docs/clause-registry.json)
 * names now or named at the base, so a document that was removed, renamed or
 * left the registry shows with the words it lost. Words are counted as
 * scripts/check-clause-form.js counts them: link targets and code blocks left
 * out, and a code span counted as one word. A document one side does not
 * hold counts as zero words on that side.
 *
 * The base is the commit the current one branched from: the merge base of the
 * given ref and HEAD. On a pull request the workflow passes the base branch.
 *
 * A base ref with no merge base, a registry that cannot be read now, and a
 * document the registry names now that cannot be read, are the machinery
 * verdict (exit 2).
 *
 * Usage: node scripts/report-clause-doc-words.js [baseRef]   # default origin/main
 *        npm run report:clause-doc-words
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clauseWords } from './check-clause-form.js';
import { stripFences } from './check-test-inventory.js';
import {
  REGISTRY_INPUT_ERROR_NAME,
  REGISTRY_PATH,
  baseFileReader,
  loadRegistry,
} from './governance-data.js';

const ROOT = resolve(import.meta.dirname, '..');
const HEADING = '### Words in the documents that hold clauses';
const NO_CHANGE = 'No document that holds clauses changed its word count.';

/**
 * The words a reader reads in a document.
 * @param {string} text the document's markdown
 * @returns {number}
 */
function countWords(text) {
  return clauseWords(stripFences(text)).length;
}

/**
 * A difference with its sign written out.
 * @param {number} change words now minus words at the base
 * @returns {string}
 */
function signed(change) {
  return change > 0 ? `+${change}` : `${change}`;
}

/**
 * The documents a registry names.
 * @param {(path: string) => string} read repo-relative reader of the tree the registry is in
 * @returns {string[]}
 */
function registeredDocs(read) {
  return loadRegistry(read).clauses.map(({ doc }) => doc);
}

/**
 * The documents the base's registry names; none when the base holds no
 * registry or one that cannot be read.
 * @param {(path: string) => string | null} readBaseFile the file's text at the base, or null
 * @returns {string[]}
 */
function baseRegisteredDocs(readBaseFile) {
  try {
    return registeredDocs((path) => {
      const text = readBaseFile(path);
      if (text === null) throw new Error(`the base does not hold ${path}`);
      return text;
    });
  } catch {
    return [];
  }
}

/**
 * The report's lines over the documents the registry names now or named at
 * the base.
 * @param {(path: string) => string} readFile repo-relative reader of the tree now
 * @param {(path: string) => string | null} readBaseFile the file's text at the base, or null when the base lacks it
 * @returns {string[]} one line when nothing changed, otherwise a markdown table
 * @throws {Error} the registry's own input error, or one naming a document that cannot be read
 */
function reportLines(readFile, readBaseFile) {
  const registered = new Set(registeredDocs(readFile));
  const docs = [...new Set([...registered, ...baseRegisteredDocs(readBaseFile)])].sort();
  const rows = [];
  for (const doc of docs) {
    let now;
    try {
      now = readFile(doc);
    } catch (e) {
      // A document only the base registered may be gone: it holds no words now.
      if (!registered.has(doc)) now = '';
      else throw new Error(`${doc} is registered but cannot be read: ${e.message}`, { cause: e });
    }
    const before = countWords(readBaseFile(doc) ?? '');
    const after = countWords(now);
    if (before !== after) rows.push({ doc, before, after });
  }
  if (rows.length === 0) return [NO_CHANGE];
  if (rows.length > 1) {
    rows.push({
      doc: 'Total',
      before: rows.reduce((sum, row) => sum + row.before, 0),
      after: rows.reduce((sum, row) => sum + row.after, 0),
    });
  }
  return [
    '| Document | Before | After | Change |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(
      ({ doc, before, after }) => `| ${doc} | ${before} | ${after} | ${signed(after - before)} |`,
    ),
  ];
}

/**
 * The command line's verdict.
 * @param {object} seams the injected edges
 * @param {(path: string) => string} seams.readFile repo-relative reader of the tree now
 * @param {(path: string) => string | null} seams.readBaseFile the document's text at the base, or null
 * @param {(line: string) => void} seams.log the report's sink
 * @param {(line: string) => void} seams.error the red-line sink
 * @param {(text: string) => void} [seams.appendSummary] the job summary's sink, when the run has one
 * @returns {number} 0 when the report was written, 2 on an input that could not be read
 */
export function main({ readFile, readBaseFile, log, error, appendSummary }) {
  let lines;
  try {
    lines = reportLines(readFile, readBaseFile);
  } catch (e) {
    const what =
      e?.name === REGISTRY_INPUT_ERROR_NAME ? `${REGISTRY_PATH} ${e.problem}` : e.message;
    error(`✗ an input this report reads could not be read:\n    ${what}`);
    return 2;
  }
  for (const line of lines) log(line);
  appendSummary?.(`${HEADING}\n\n${lines.join('\n')}\n`);
  return 0;
}

/* c8 ignore start -- CLI wrapper: main() is unit-tested over injected seams;
 * this glue binds it to git, the tree and the process. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const baseRef = process.argv[2] ?? 'origin/main';
  let readBaseFile;
  try {
    readBaseFile = baseFileReader(git, baseRef);
  } catch (e) {
    console.error(`✗ an input this report reads could not be read:\n    ${e.message}`);
    process.exit(2);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  process.exitCode = main({
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    readBaseFile,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    appendSummary: summaryPath ? (text) => appendFileSync(summaryPath, text) : undefined,
  });
}
/* c8 ignore stop */
