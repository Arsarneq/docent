/**
 * check-proptest-seeds.js — Hold every committed proptest regression-seed file
 * to a reviewed form.
 *
 * proptest persists each input that falsifies a property to a seed file, and
 * replays every seed in it before generating new cases
 * (docs/test/desktop-rust.md). Where the file goes follows from where the
 * test's source file sits, in one of two layouts: for a source file one of
 * whose ancestor directories holds `lib.rs` or `main.rs`, a `.txt` file under
 * a `proptest-regressions/` directory in the crate; for any other source file
 * (an integration test under `tests/`), a `*.proptest-regressions` file beside
 * it. The tracked set is both layouts, so a seed is held in whichever one
 * proptest writes it. The file only grows:
 * proptest appends a `cc` line per new failure and never prunes one, so a seed a
 * run left behind — under load, or from a local mutation run — is committed with
 * whatever change happens to carry it, and replays from then on. This check
 * makes each seed a reviewed decision: every tracked seed file under the
 * desktop crate holds
 *
 *   - proptest's own header, the six `#` lines it writes when it creates the
 *     file, verbatim; and then
 *   - zero or more seed lines, each of the form
 *     `cc <64-hex seed> # shrinks to <value> # reviewed <YYYY-MM-DD>: <why kept>`
 *     — the line proptest writes, followed by a dated review note.
 *
 * A header-only file holds zero seed lines and passes, counted in the green
 * line's file count. A header that diverges from proptest's is reported once,
 * at its first diverging line, with the line expected and the one found; from
 * it only the `#` lines are passed over, and every other line is audited — a
 * `cc ` line as a seed, anything else as a line of no seed shape. A line that
 * opens `cc ` without the seed form is reported with the line quoted: as
 * carrying a seed out of form when its seed is not 64 lowercase hexadecimal
 * characters, as carrying a review note not in that form when it carries
 * `# reviewed`, and as carrying no review note in it otherwise; a reviewed
 * line whose note's date names no calendar day is reported with the line
 * quoted as well; any other line is a problem naming its file:line. The
 * closing advice has four kinds, joined when several kinds reddened: restore
 * the header verbatim for a header problem; review the seed, keeping it with a
 * note at the end of its own line, for a seed line carrying no note or one out
 * of form; correct or delete the line for a seed out of form or a note dated
 * on no calendar day; and delete the line or make it a seed line for a line
 * of no seed shape. proptest reads a seed line up to its first `#`, so the review note is inert to it, and a note survives
 * every later run because proptest only appends; a line proptest appends
 * arrives without a note, and reds here until someone reviews it — keeping it
 * with a note, or deleting it.
 *
 * Zero tracked seed files is a legitimate pass, and the green line states the
 * count either way. A tracked file that cannot be read is the machinery
 * verdict, on this check's own exit code (exit 2), never a pass and never a
 * seed problem (exit 1).
 *
 * Usage: node scripts/check-proptest-seeds.js   # or: npm run lint:proptest-seeds
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The two tracked-file readers live in check-test-inventory.js, whose own
// imports load the markdown parser it reads tables with, so this command line
// inherits that parser.
import { selfPath, trackedFilesUnder } from './check-test-inventory.js';

const SELF_PATH = selfPath(import.meta.filename);
const ROOT = resolve(import.meta.dirname, '..');

/** The tree whose seed files this check holds. */
export const CRATE_ROOT = 'packages/desktop/src-tauri';
/** The suffix proptest names a seed file with, in the beside-the-test layout. */
export const SEED_SUFFIX = '.proptest-regressions';
/** The directory proptest keeps `.txt` seed files under, in the in-crate layout. */
export const SEED_DIR = 'proptest-regressions';

/** The header proptest writes when it creates a seed file, line by line. */
export const PROPTEST_HEADER = [
  '# Seeds for failure cases proptest has generated in the past. It is',
  '# automatically read and these particular cases re-run before any',
  '# novel cases are generated.',
  '#',
  '# It is recommended to check this file in to source control so that',
  '# everyone who runs the test benefits from these saved cases.',
];

/** A reviewed seed line: proptest's own line, then the dated review note. */
const REVIEWED_SEED_RE = /^cc [0-9a-f]{64} # shrinks to .+? # reviewed (\d{4}-\d{2}-\d{2}): \S.*$/;
/** A seed as proptest writes it: 64 lowercase hexadecimal characters. */
const SEED_TOKEN_RE = /^[0-9a-f]{64}$/;
/** The form a reviewed seed line takes, as a problem message states it. */
export const REVIEWED_FORM = 'cc <seed> # shrinks to <value> # reviewed <YYYY-MM-DD>: <why kept>';

/**
 * An input this check reads that answered with something other than what it
 * reads there — reported on the check's own exit code.
 */
export class InputError extends Error {}

/**
 * Whether a `YYYY-MM-DD` string names a real calendar day.
 * @param {string} date the date text
 * @returns {boolean}
 */
function isCalendarDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * One seed file's problems, each naming the 1-based line it stands on.
 * @param {string} text the file's text
 * @returns {{ seeds: number, problems: Array<{ line: number, message: string,
 *   kind: 'header' | 'seed' | 'form' | 'line' }> }}
 *   the reviewed seed lines counted, and the problems found
 */
export function auditSeedFile(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const problems = [];
  const diverges = PROPTEST_HEADER.findIndex((expected, i) => lines[i] !== expected);
  if (diverges !== -1) {
    const found = lines[diverges];
    problems.push({
      line: diverges + 1,
      kind: 'header',
      message: `the proptest header's line ${diverges + 1} must read ${JSON.stringify(PROPTEST_HEADER[diverges])}; found ${found === undefined ? 'the end of the file' : JSON.stringify(found)}`,
    });
  }
  let seeds = 0;
  // A header that diverged is reported once, above; past that point only the
  // `#` lines are passed over, and every other line is audited.
  const from = diverges === -1 ? PROPTEST_HEADER.length : diverges;
  lines.slice(from).forEach((text, i) => {
    const line = from + i + 1;
    if (diverges !== -1 && text.startsWith('#')) return;
    const quoted = JSON.stringify(text);
    const reviewed = REVIEWED_SEED_RE.exec(text);
    if (reviewed && isCalendarDate(reviewed[1])) {
      seeds++;
    } else if (reviewed) {
      problems.push({ line, kind: 'form', message: `the line ${quoted} carries a review note dated ${reviewed[1]}, which is not a calendar day` }); // prettier-ignore
    } else if (text.startsWith('cc ') && !SEED_TOKEN_RE.test(text.split(' ')[1] ?? '')) {
      problems.push({ line, kind: 'form', message: `the line ${quoted} carries a seed not in the form \`${REVIEWED_FORM}\`, whose seed is 64 lowercase hexadecimal characters` }); // prettier-ignore
    } else if (text.startsWith('cc ') && text.includes('# reviewed')) {
      problems.push({ line, kind: 'seed', message: `the line ${quoted} carries a review note not in the form \`${REVIEWED_FORM}\`` }); // prettier-ignore
    } else if (text.startsWith('cc ')) {
      problems.push({ line, kind: 'seed', message: `the line ${quoted} does not carry a review note in the form \`${REVIEWED_FORM}\`` }); // prettier-ignore
    } else {
      problems.push({ line, kind: 'line', message: `not a seed line: ${quoted}` });
    }
  });
  return { seeds, problems };
}

/**
 * The verdict over every seed file the listing names.
 * @param {object} seams the reads this audit is taken through
 * @param {() => string[]} seams.listFiles the repo-relative seed files
 * @param {(path: string) => string} seams.readFile repo-relative reader
 * @returns {{ fileCount: number, seedCount: number,
 *             problems: Array<{ file: string, line: number, message: string }> }}
 * @throws {InputError} when a listed file cannot be read
 */
export function auditSeeds({ listFiles, readFile }) {
  const files = listFiles();
  const problems = [];
  let seedCount = 0;
  for (const file of files) {
    let text;
    try {
      text = readFile(file);
    } catch (error) {
      throw new InputError(`${file} is tracked but cannot be read: ${error.message}`);
    }
    const audit = auditSeedFile(text);
    seedCount += audit.seeds;
    for (const p of audit.problems) problems.push({ file, ...p });
  }
  return { fileCount: files.length, seedCount, problems };
}

/**
 * Whether a repo-relative path is a seed file in either of proptest's layouts:
 * a `*.proptest-regressions` file, or a `.txt` file under a
 * `proptest-regressions/` directory.
 * @param {string} path the repo-relative path
 * @returns {boolean}
 */
export function isSeedFile(path) {
  if (path.endsWith(SEED_SUFFIX)) return true;
  return path.endsWith('.txt') && path.split('/').slice(0, -1).includes(SEED_DIR);
}

/**
 * The tracked seed files under the desktop crate, repo-relative, in both
 * layouts.
 * @param {string} [cwd] the repository to list (default: this one)
 * @returns {string[]}
 */
export function trackedSeedFiles(cwd = ROOT) {
  return trackedFilesUnder(CRATE_ROOT, { cwd }).filter(isSeedFile);
}

/**
 * The command line's verdict over the given seams, as its exit code.
 * @param {object} seams the reads {@link auditSeeds} takes, plus the output sinks
 * @param {(line: string) => void} seams.log the green-line sink
 * @param {(line: string) => void} seams.error the red-line sink
 * @returns {number} 0 when every seed is reviewed, 1 on a problem, 2 on an unreadable input
 */
export function main({ listFiles, readFile, log, error }) {
  let audit;
  try {
    audit = auditSeeds({ listFiles, readFile });
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    error(`✗ an input this check reads could not be read:\n    ${e.message}`);
    return 2;
  }
  if (audit.problems.length > 0) {
    for (const { file, line, message } of audit.problems) error(`✗ ${file}:${line} — ${message}`);
    const kinds = new Set(audit.problems.map((p) => p.kind));
    const advice = [];
    if (kinds.has('header')) advice.push("Restore proptest's header verbatim.");
    if (kinds.has('seed'))
      advice.push(
        'Review each seed proptest appended: keep it with a ' +
          '`# reviewed <YYYY-MM-DD>: <why kept>` note at the end of its own line, or delete the line.',
      );
    if (kinds.has('form'))
      advice.push(
        'Correct or delete each line whose seed is out of form or whose note names no calendar day.',
      );
    if (kinds.has('line'))
      advice.push('Delete each line of no seed shape, or make it a seed line.');
    error(
      `\n${audit.problems.length} problem${audit.problems.length === 1 ? '' : 's'}. ` +
        `${advice.join(' ')} See ${SELF_PATH} and docs/test/desktop-rust.md.`,
    );
    return 1;
  }
  log(
    `✓ ${audit.fileCount} tracked proptest seed file(s) under ${CRATE_ROOT}/, ` +
      `${audit.seedCount} seed line(s), each carrying a dated review note.`,
  );
  return 0;
}

/* c8 ignore start -- CLI wrapper: main() is unit-tested over injected seams;
 * this glue binds it to the tracked tree and the process. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main({
    listFiles: () => trackedSeedFiles(),
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
/* c8 ignore stop */
