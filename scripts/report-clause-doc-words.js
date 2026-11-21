/**
 * report-clause-doc-words.js — Show, for each document that holds clauses, the
 * words it held at a base commit and the words it holds now.
 *
 * A document that holds rules is read by people, and a change that only adds
 * to it makes it slower to read. This report puts the size of that change in
 * front of the author and the reviewer: one row per document whose word count
 * changed, and a total when more than one did. It is shown and never a gate:
 * how long a document should be depends on what it has to say, so the report
 * exits 0 however much a document grew.
 *
 * The documents are the ones the clause registry (docs/clause-registry.json)
 * names. Words are counted as scripts/check-clause-form.js counts them: link
 * targets and code blocks left out, and a code span counted as one word. A
 * document the base does not hold counts from zero.
 *
 * The base is the commit the current one branched from: the merge base of the
 * given ref and HEAD. On a pull request the workflow passes the base branch.
 *
 * A registry that cannot be read, and a registered document that cannot be
 * read now, are the machinery verdict (exit 2).
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
import { REGISTRY_INPUT_ERROR_NAME, REGISTRY_PATH, loadRegistry } from './governance-data.js';

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
 * The report's lines over the registered documents.
 * @param {(path: string) => string} readFile repo-relative reader of the tree now
 * @param {(path: string) => string | null} readBaseFile the document's text at the base, or null when the base lacks it
 * @returns {string[]} one line when nothing changed, otherwise a markdown table
 * @throws {Error} the registry's own input error, or one naming a document that cannot be read
 */
function reportLines(readFile, readBaseFile) {
  const docs = [...new Set(loadRegistry(readFile).clauses.map(({ doc }) => doc))].sort();
  const rows = [];
  for (const doc of docs) {
    let now;
    try {
      now = readFile(doc);
    } catch (e) {
      throw new Error(`${doc} is registered but cannot be read: ${e.message}`, { cause: e });
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
  const base = git(['merge-base', process.argv[2] ?? 'origin/main', 'HEAD']).trim();
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  process.exitCode = main({
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    readBaseFile: (rel) => {
      try {
        return git(['show', `${base}:${rel}`]);
      } catch {
        return null;
      }
    },
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    appendSummary: summaryPath ? (text) => appendFileSync(summaryPath, text) : undefined,
  });
}
/* c8 ignore stop */
