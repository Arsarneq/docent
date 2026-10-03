/**
 * check-proptest-seeds.test.js — Unit tests for the proptest seed-file check
 * (scripts/check-proptest-seeds.js): every committed seed file under the
 * desktop crate, in either of proptest's layouts, keeps proptest's header and
 * carries a dated review note on each seed line. The suite drives the command
 * line's verdicts through `main` over injected reads — an unmarked seed line
 * and an altered header each red naming file:line with the advice that fits, a
 * line of no seed shape reds, a review note dated on no calendar day reds with
 * its line quoted, a reviewed file passes, a header-only file passes with zero
 * seed lines, zero files passes stating the count, and an unreadable file is
 * the machinery verdict; a seed out of form (wrong length or case) is refused
 * with its line quoted, a header that diverges is reported once with the seed
 * lines from it on still audited, and the advice is pinned per kind — the
 * layouts' file selection is held, and a
 * scratch repository holds a seed file in the in-crate layout to the same
 * verdicts, and a real-tree case holds the committed seed files to passing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CRATE_ROOT,
  PROPTEST_HEADER,
  auditSeedFile,
  isSeedFile,
  main,
  trackedSeedFiles,
} from '../../../../scripts/check-proptest-seeds.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SEED = 'f'.repeat(64);
const FILE = `${CRATE_ROOT}/tests/x_test.proptest-regressions`;
const REVIEWED = `cc ${SEED} # shrinks to x = 1 # reviewed 2026-10-02: replays an input that once failed`;

/** A seed file's text: the header, then the given lines. */
const seedFile = (...lines) => [...PROPTEST_HEADER, ...lines, ''].join('\n');

/** The message a `cc ` line whose review note is not in the form takes, the line quoted. */
const badNote = (line) =>
  `the line ${JSON.stringify(line)} carries a review note not in the form \`cc <seed> # shrinks to <value> # reviewed <YYYY-MM-DD>: <why kept>\``;

/** The message a `cc ` line whose seed is out of form takes, the line quoted. */
const seedOut = (line) =>
  `the line ${JSON.stringify(line)} carries a seed not in the form \`cc <seed> # shrinks to <value> # reviewed <YYYY-MM-DD>: <why kept>\`, whose seed is 64 lowercase hexadecimal characters`;

/** The closing advice lines, by the problem kinds that reddened. */
const SEE = 'See scripts/check-proptest-seeds.js and docs/test/desktop-rust.md.';
const HEADER_ADVICE = "Restore proptest's header verbatim.";
const SEED_ADVICE =
  'Review each seed proptest appended: keep it with a `# reviewed <YYYY-MM-DD>: <why kept>` note at the end of its own line, or delete the line.';
const FORM_ADVICE =
  'Correct or delete each line whose seed is out of form or whose note names no calendar day.';
const LINE_ADVICE = 'Delete each line of no seed shape, or make it a seed line.';

/** The message an unreviewed `cc ` line takes, the line quoted. */
const noNote = (line) =>
  `the line ${JSON.stringify(line)} does not carry a review note in the form \`cc <seed> # shrinks to <value> # reviewed <YYYY-MM-DD>: <why kept>\``;

/**
 * The command line's verdict over one in-memory tree.
 * @param {Record<string, string | Error>} files path → text, or the read's error
 * @returns {{ code: number, out: string[], err: string[] }}
 */
function run(files) {
  const out = [];
  const err = [];
  const code = main({
    listFiles: () => Object.keys(files),
    readFile: (path) => {
      if (files[path] instanceof Error) throw files[path];
      return files[path];
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out, err };
}

describe('main — the verdicts the command line takes', () => {
  it('a reviewed file passes, stating the counts', () => {
    const { code, out, err } = run({ [FILE]: seedFile(REVIEWED, REVIEWED) });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out, [
      `✓ 1 tracked proptest seed file(s) under ${CRATE_ROOT}/, 2 seed line(s), each carrying a dated review note.`,
    ]);
  });

  it('a header-only file holds zero seed lines and passes, counted in the file count', () => {
    const { code, out, err } = run({ [FILE]: seedFile() });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out, [
      `✓ 1 tracked proptest seed file(s) under ${CRATE_ROOT}/, 0 seed line(s), each carrying a dated review note.`,
    ]);
  });

  it('zero tracked files passes, stating the count', () => {
    const { code, out } = run({});
    assert.equal(code, 0);
    assert.deepEqual(out, [
      `✓ 0 tracked proptest seed file(s) under ${CRATE_ROOT}/, 0 seed line(s), each carrying a dated review note.`,
    ]);
  });

  it('an unmarked seed line — the line proptest appends — reds naming file:line', () => {
    const unmarked = `cc ${SEED} # shrinks to x = 2`;
    const { code, err } = run({ [FILE]: seedFile(REVIEWED, unmarked) });
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${FILE}:8 — ${noNote(unmarked)}`);
    assert.equal(err[1], `\n1 problem. ${SEED_ADVICE} ${SEE}`);
  });

  it('a header problem and a seed problem take the combined advice', () => {
    const unmarked = `cc ${SEED} # shrinks to x = 2`;
    const text = seedFile(unmarked).replace('# novel cases are generated.', '# novel cases.');
    const { code, err } = run({ [FILE]: text });
    assert.equal(code, 1);
    assert.equal(err[2], `\n2 problems. ${HEADER_ADVICE} ${SEED_ADVICE} ${SEE}`);
  });

  it('a header missing its first line is reported once, and the seed after it is still audited', () => {
    const text = [...PROPTEST_HEADER.slice(1), REVIEWED, ''].join('\n');
    assert.deepEqual(auditSeedFile(text), {
      seeds: 1,
      problems: [
        {
          line: 1,
          kind: 'header',
          message: `the proptest header's line 1 must read ${JSON.stringify(PROPTEST_HEADER[0])}; found ${JSON.stringify(PROPTEST_HEADER[1])}`,
        },
      ],
    });
  });

  it('an altered header reds naming file:line', () => {
    const text = seedFile(REVIEWED).replace('# novel cases are generated.', '# novel cases.');
    const { code, err } = run({ [FILE]: text });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${FILE}:3 — the proptest header's line 3 must read "# novel cases are generated."; found "# novel cases."`,
    );
    assert.equal(
      err[1],
      `\n1 problem. Restore proptest's header verbatim. See scripts/check-proptest-seeds.js and docs/test/desktop-rust.md.`,
    );
  });

  it('a file shorter than the header reds at the first line it lacks', () => {
    const { code, err } = run({ [FILE]: PROPTEST_HEADER.slice(0, 2).join('\n') });
    assert.equal(code, 1);
    assert.match(err[0], new RegExp(`^✗ ${FILE}:3 — .*found the end of the file$`));
  });

  it('a line of no seed shape reds naming file:line', () => {
    const { code, err } = run({ [FILE]: seedFile(REVIEWED, '', 'note to self') });
    assert.equal(code, 1);
    assert.deepEqual(err.slice(0, 2), [
      `✗ ${FILE}:8 — not a seed line: ""`,
      `✗ ${FILE}:9 — not a seed line: "note to self"`,
    ]);
    assert.equal(err[2], `\n2 problems. ${LINE_ADVICE} ${SEE}`);
  });

  it('a review note dated on no calendar day reds', () => {
    const text = seedFile(REVIEWED.replace('2026-10-02', '2026-02-30'));
    const { code, err } = run({ [FILE]: text });
    assert.equal(code, 1);
    const line = REVIEWED.replace('2026-10-02', '2026-02-30');
    assert.equal(
      err[0],
      `✗ ${FILE}:7 — the line ${JSON.stringify(line)} carries a review note dated 2026-02-30, which is not a calendar day`,
    );
    assert.equal(err[1], `\n1 problem. ${FORM_ADVICE} ${SEE}`);
  });

  it('an uppercase-hex seed is a seed out of form, not a note out of form', () => {
    const line = `cc ${'F'.repeat(64)} # shrinks to x = 1 # reviewed 2026-10-02: replays an input`;
    const { code, err } = run({ [FILE]: seedFile(line) });
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${FILE}:7 — ${seedOut(line)}`);
    assert.equal(err[1], `\n1 problem. ${FORM_ADVICE} ${SEE}`);
  });

  it('a 65-character seed with a valid note is a seed out of form', () => {
    const line = `cc ${'f'.repeat(65)} # shrinks to x = 1 # reviewed 2026-10-02: replays an input`;
    const { code, err } = run({ [FILE]: seedFile(line) });
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${FILE}:7 — ${seedOut(line)}`);
  });

  it('an altered header and a stray line are both reported in one run', () => {
    const text = seedFile(REVIEWED, 'stray').replace(
      '# novel cases are generated.',
      '# novel cases.',
    );
    const { code, err } = run({ [FILE]: text });
    assert.equal(code, 1);
    assert.deepEqual(err, [
      `✗ ${FILE}:3 — the proptest header's line 3 must read "# novel cases are generated."; found "# novel cases."`,
      `✗ ${FILE}:8 — not a seed line: "stray"`,
      `\n2 problems. ${HEADER_ADVICE} ${LINE_ADVICE} ${SEE}`,
    ]);
  });

  it('a wholly missing header and an unreviewed first seed are both reported in one run', () => {
    const unmarked = `cc ${SEED} # shrinks to x = 2`;
    const { code, err } = run({ [FILE]: `${unmarked}\n` });
    assert.equal(code, 1);
    assert.deepEqual(err.slice(0, 2), [
      `✗ ${FILE}:1 — the proptest header's line 1 must read ${JSON.stringify(PROPTEST_HEADER[0])}; found ${JSON.stringify(unmarked)}`,
      `✗ ${FILE}:1 — ${noNote(unmarked)}`,
    ]);
  });

  it('a 63-character seed is refused and a 64-character one admitted', () => {
    const at = (seed) => `cc ${seed} # shrinks to x = 1 # reviewed 2026-10-02: replays an input`;
    const short = at('f'.repeat(63));
    assert.deepEqual(run({ [FILE]: seedFile(short) }).err[0], `✗ ${FILE}:7 — ${seedOut(short)}`);
    assert.deepEqual(auditSeedFile(seedFile(at('f'.repeat(64)))), { seeds: 1, problems: [] });
  });

  it('a seed shorter than 64 hex characters is refused, its line quoted', () => {
    const line = 'cc abc123 # shrinks to x = 1 # reviewed 2026-10-02: replays an input';
    const { code, err } = run({ [FILE]: seedFile(line) });
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${FILE}:7 — ${seedOut(line)}`);
  });

  it('a review note with no reason after the date is no reviewed line', () => {
    const line = `cc ${SEED} # shrinks to x = 1 # reviewed 2026-10-02:`;
    const { code, err } = run({ [FILE]: seedFile(line) });
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${FILE}:7 — ${badNote(line)}`);
  });

  it('a review note whose reason is only whitespace is no reviewed line', () => {
    const line = `cc ${SEED} # shrinks to x = 1 # reviewed 2026-10-02:   `;
    const { code, err } = run({ [FILE]: seedFile(line) });
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${FILE}:7 — ${badNote(line)}`);
  });

  it('a review note written `#reviewed`, with no space, is no reviewed line', () => {
    const line = `cc ${SEED} # shrinks to x = 1 #reviewed 2026-10-02: replays an input`;
    const { code, err } = run({ [FILE]: seedFile(line) });
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${FILE}:7 — ${noNote(line)}`);
  });

  it('a tracked file that cannot be read is the machinery verdict, exit 2', () => {
    const { code, out, err } = run({ [FILE]: new Error('EACCES') });
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(err[0], /is tracked but cannot be read: EACCES/);
  });

  it('rethrows an error that is not an input error', () => {
    assert.throws(
      () =>
        main({
          listFiles: () => {
            throw new TypeError('boom');
          },
          readFile: () => '',
          log: () => {},
          error: () => {},
        }),
      { name: 'TypeError', message: 'boom' },
    );
  });
});

describe('isSeedFile — the two layouts and nothing beside them', () => {
  it('holds no file under `proptest-regressions/` but a `.txt` one', () => {
    assert.equal(isSeedFile(`${CRATE_ROOT}/proptest-regressions/capture/worker.txt`), true);
    assert.equal(isSeedFile(`${CRATE_ROOT}/proptest-regressions/capture/worker.md`), false);
  });

  it('admits no file named `proptest-regressions` with no suffix', () => {
    assert.equal(isSeedFile(`${CRATE_ROOT}/tests/proptest-regressions`), false);
    assert.equal(isSeedFile(`${CRATE_ROOT}/tests/x_test.proptest-regressions`), true);
  });
});

describe('auditSeedFile — what proptest writes is what the check reads', () => {
  it('reads CRLF line endings as the same lines', () => {
    const crlf = [...PROPTEST_HEADER, REVIEWED, ''].join('\r\n');
    assert.deepEqual(auditSeedFile(crlf), { seeds: 1, problems: [] });
  });
});

/** A seed file in proptest's in-crate layout. */
const IN_CRATE_FILE = `${CRATE_ROOT}/proptest-regressions/capture/worker.txt`;

/**
 * A scratch git repository holding one seed file in proptest's in-crate layout
 * and a `.txt` file outside it, both tracked.
 * @param {string} seedText the in-crate-layout seed file's text
 * @returns {string} the repository's directory
 */
function makeInCrateLayoutRepo(seedText) {
  const dir = mkdtempSync(join(tmpdir(), 'proptest-seeds-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  write(IN_CRATE_FILE, seedText);
  write(`${CRATE_ROOT}/notes.txt`, 'not a seed file\n');
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['add', '--all'], { cwd: dir });
  return dir;
}

describe('the in-crate layout — a `.txt` file under `proptest-regressions/`', () => {
  /**
   * The command line's verdict over a scratch repository's own listing.
   * @param {string} seedText the in-crate-layout seed file's text
   */
  function runRepo(seedText) {
    const dir = makeInCrateLayoutRepo(seedText);
    try {
      const out = [];
      const err = [];
      const code = main({
        listFiles: () => trackedSeedFiles(dir),
        readFile: (rel) => readFileSync(join(dir, rel), 'utf8'),
        log: (line) => out.push(line),
        error: (line) => err.push(line),
      });
      return { code, out, err };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a reviewed file in the in-crate layout is tracked and passes', () => {
    const { code, out, err } = runRepo(seedFile(REVIEWED));
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out, [
      `✓ 1 tracked proptest seed file(s) under ${CRATE_ROOT}/, 1 seed line(s), each carrying a dated review note.`,
    ]);
  });

  it('an unmarked seed line in the in-crate layout reds naming file:line', () => {
    const unmarked = `cc ${SEED} # shrinks to x = 2`;
    const { code, err } = runRepo(seedFile(unmarked));
    assert.equal(code, 1);
    assert.equal(err[0], `✗ ${IN_CRATE_FILE}:7 — ${noNote(unmarked)}`);
  });
});

describe('real-tree lock', () => {
  it('every committed seed file passes', () => {
    const files = trackedSeedFiles();
    assert.ok(files.length > 0, 'the desktop crate commits a seed file');
    for (const file of files) {
      const { problems } = auditSeedFile(readFileSync(join(ROOT, file), 'utf8'));
      assert.deepEqual(problems, [], file);
    }
  });
});
