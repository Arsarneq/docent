/**
 * check-clause-form.test.js — Unit tests for the clause-form check
 * (scripts/check-clause-form.js): a rule has one home, and a clause is written
 * in units a reader can take in. The suite drives the verdicts through `main`
 * over an injected registry, injected documents and an injected baseline — an
 * issue linked from two clauses, a run of words standing in two clauses and a
 * unit over the word limit each red naming the clauses, a baseline entry
 * admits exactly the case it names, a baseline entry the tree no longer needs
 * reds until it is removed or lowered, and an unreadable document or a baseline
 * out of shape is the machinery verdict — and a real-tree case holds the
 * committed documents and the committed baseline to passing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BASELINE_PATH,
  RUN_WORDS,
  UNIT_WORD_LIMIT,
  clauseUnits,
  clauseWords,
  issueLinks,
  main,
} from '../../../../scripts/check-clause-form.js';
import { REGISTRY_PATH } from '../../../../scripts/governance-data.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const DOC_A = 'docs/a.md';
const DOC_B = 'docs/b.md';
const ISSUE = (n) => `[docent#${n}](https://github.com/Arsarneq/docent/issues/${n})`;
const EMPTY = { 'issue-homes': {}, 'shared-text': [], 'long-units': {} };
const SEE = `See scripts/check-clause-form.js and ${BASELINE_PATH}.`;

/** `count` distinct words, so no run of them repeats by accident. */
const words = (count, stem) => Array.from({ length: count }, (_, i) => `${stem}${i}`).join(' ');

/** A registry naming the given clauses, each in its document. */
const registry = (rows) =>
  JSON.stringify({ clauses: Object.entries(rows).map(([clause, doc]) => ({ clause, doc })) });

/**
 * The command line's verdict over one in-memory tree.
 * @param {object} tree the inputs
 * @param {Record<string, string>} tree.rows clause id → document path
 * @param {Record<string, string | Error>} tree.docs document path → text, or the read's error
 * @param {object | string} [tree.baseline] the baseline, or its raw text
 * @returns {{ code: number, out: string[], err: string[] }}
 */
function run({ rows, docs, baseline = EMPTY }) {
  const out = [];
  const err = [];
  const files = {
    ...docs,
    [REGISTRY_PATH]: registry(rows),
    [BASELINE_PATH]: typeof baseline === 'string' ? baseline : JSON.stringify(baseline),
  };
  const code = main({
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      if (files[path] instanceof Error) throw files[path];
      return files[path];
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out, err };
}

const TWO = { 'AA-1': DOC_A, 'BB-1': DOC_B };

describe('main — one home for a linked issue', () => {
  it('an issue linked from one clause passes, stating the counts', () => {
    const { code, out, err } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n`,
        [DOC_B]: '**BB-1.** Another rule.\n',
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out, [
      `✓ 2 clause(s) in 2 document(s): no issue linked from two clauses, no run of ${RUN_WORDS} words standing in two clauses and no unit over ${UNIT_WORD_LIMIT} words, beyond the 0 case(s) ${BASELINE_PATH} lists.`,
    ]);
  });

  it('an issue linked from two clauses reds naming both', () => {
    const { code, err } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n`,
        [DOC_B]: `**BB-1.** The same gap again (${ISSUE(7)}).\n`,
      },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      '✗ docent#7 is linked from AA-1 and BB-1 — a departure or an open case is stated in one clause, and any other clause cites that clause',
    );
    assert.equal(err[1], `\n1 problem. ${SEE}`);
  });

  it('a link repeated inside one clause is one home', () => {
    const { code } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** A rule (${ISSUE(7)}), and its other half (${ISSUE(7)}).\n`,
        [DOC_B]: '**BB-1.** Another rule.\n',
      },
    });
    assert.equal(code, 0);
  });

  it('a baseline entry admits the clauses it names and no further one', () => {
    const rows = { ...TWO, 'BB-2': DOC_B };
    const docs = {
      [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n`,
      [DOC_B]: `**BB-1.** Again (${ISSUE(7)}).\n\n**BB-2.** Something else.\n`,
    };
    const baseline = { ...EMPTY, 'issue-homes': { 7: ['AA-1', 'BB-1'] } };
    assert.equal(run({ rows, docs, baseline }).code, 0);
    docs[DOC_B] = `**BB-1.** Again (${ISSUE(7)}).\n\n**BB-2.** And again (${ISSUE(7)}).\n`;
    const { code, err } = run({ rows, docs, baseline });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ docent#7 is linked from BB-2 as well as the clauses ${BASELINE_PATH} lists for it (AA-1, BB-1) — a departure or an open case is stated in one clause, and any other clause cites that clause`,
    );
  });

  it('a baseline entry naming a clause that no longer links the issue reds until it is removed', () => {
    const { code, err } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n`,
        [DOC_B]: '**BB-1.** Another rule, citing AA-1.\n',
      },
      baseline: { ...EMPTY, 'issue-homes': { 7: ['AA-1', 'BB-1'] } },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} lists docent#7 for AA-1, BB-1, and it is now linked from AA-1 only — remove the entry`,
    );
  });
});

describe('main — one home for a run of words', () => {
  const shared = words(RUN_WORDS, 'same');

  it(`a run of ${RUN_WORDS} words standing in two clauses reds, the run quoted`, () => {
    const { code, err } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** First ${shared} here.\n`,
        [DOC_B]: `**BB-1.** Second ${shared} there.\n`,
      },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ AA-1 and BB-1 both state "${shared}" — a rule is stated in one clause, and any other clause cites that clause`,
    );
  });

  it(`a run one word short of ${RUN_WORDS} passes`, () => {
    const short = words(RUN_WORDS - 1, 'same');
    const { code } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** First ${short} here.\n`,
        [DOC_B]: `**BB-1.** Second ${short} there.\n`,
      },
    });
    assert.equal(code, 0);
  });

  it('text before the first clause is no clause and is not compared', () => {
    const { code } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `Preamble ${shared}.\n\n**AA-1.** A rule.\n`,
        [DOC_B]: `Preamble ${shared}.\n\n**BB-1.** Another rule.\n`,
      },
    });
    assert.equal(code, 0);
  });

  it('a link target and a fenced block are not words of the clause', () => {
    const target = '(https://example.test/a/b/c/d/e/f/g/h/i/j)';
    const fence = `\n\`\`\`text\n${shared}\n\`\`\`\n`;
    const { code } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** See [one]${target}.${fence}`,
        [DOC_B]: `**BB-1.** See [two]${target}.${fence}`,
      },
    });
    assert.equal(code, 0);
  });

  it('a baseline pair admits the two clauses, and reds once they share nothing', () => {
    const baseline = { ...EMPTY, 'shared-text': ['AA-1|BB-1'] };
    const docs = {
      [DOC_A]: `**AA-1.** First ${shared} here.\n`,
      [DOC_B]: `**BB-1.** Second ${shared} there.\n`,
    };
    assert.equal(run({ rows: TWO, docs, baseline }).code, 0);
    docs[DOC_B] = '**BB-1.** Second, citing AA-1.\n';
    const { code, err } = run({ rows: TWO, docs, baseline });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} lists AA-1|BB-1 as sharing text, and they share no run of ${RUN_WORDS} words now — remove the entry`,
    );
  });
});

describe('main — units a reader can take in', () => {
  const over = words(UNIT_WORD_LIMIT + 1, 'w');
  const at = words(UNIT_WORD_LIMIT, 'w');

  it(`a paragraph over ${UNIT_WORD_LIMIT} words reds naming the clause and how it opens`, () => {
    const { code, err } = run({
      rows: { 'AA-1': DOC_A },
      docs: { [DOC_A]: `**AA-1.** Short lead.\n\n${over}\n` },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ AA-1 holds 1 unit(s) over ${UNIT_WORD_LIMIT} words (a paragraph, a list item or a table row) — split it into paragraphs or a list; the longest runs ${UNIT_WORD_LIMIT + 1} words and opens "w0 w1 w2 w3 w4 w5"`,
    );
  });

  it(`a paragraph of exactly ${UNIT_WORD_LIMIT} words passes`, () => {
    const { code } = run({
      rows: { 'AA-1': DOC_A },
      docs: { [DOC_A]: `**AA-1.** Short lead.\n\n${at}\n` },
    });
    assert.equal(code, 0);
  });

  it('each list item and each table row is a unit of its own', () => {
    const item = words(UNIT_WORD_LIMIT - 10, 'i');
    const doc = `**AA-1.** Lead:\n\n- ${item}\n- ${item}\n\n| a | b |\n| --- | --- |\n| ${item} | x |\n| ${item} | y |\n`;
    assert.equal(run({ rows: { 'AA-1': DOC_A }, docs: { [DOC_A]: doc } }).code, 0);
    assert.equal(clauseUnits(doc).length, 6);
  });

  it('the baseline admits the count it states, reds above it, and reds below it until lowered', () => {
    const rows = { 'AA-1': DOC_A };
    const baseline = { ...EMPTY, 'long-units': { 'AA-1': 1 } };
    assert.equal(
      run({ rows, docs: { [DOC_A]: `**AA-1.** Lead.\n\n${over}\n` }, baseline }).code,
      0,
    );
    const two = run({
      rows,
      docs: { [DOC_A]: `**AA-1.** Lead.\n\n${over}\n\n${over}\n` },
      baseline,
    });
    assert.equal(two.code, 1);
    assert.match(
      two.err[0],
      /^✗ AA-1 holds 2 unit\(s\) over 150 words .* where scripts\/clause-form-baseline\.json admits 1 — /,
    );
    const none = run({ rows, docs: { [DOC_A]: '**AA-1.** Lead.\n' }, baseline });
    assert.equal(none.code, 1);
    assert.equal(
      none.err[0],
      `✗ ${BASELINE_PATH} admits 1 unit(s) over ${UNIT_WORD_LIMIT} words in AA-1, and it holds 0 now — remove the entry`,
    );
  });

  it('a count that fell but not to zero asks for the entry to be lowered', () => {
    const { err } = run({
      rows: { 'AA-1': DOC_A },
      docs: { [DOC_A]: `**AA-1.** Lead.\n\n${over}\n` },
      baseline: { ...EMPTY, 'long-units': { 'AA-1': 2 } },
    });
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} admits 2 unit(s) over ${UNIT_WORD_LIMIT} words in AA-1, and it holds 1 now — lower the entry to 1`,
    );
  });
});

describe('main — refusals on the check’s own inputs', () => {
  const docs = { [DOC_A]: '**AA-1.** A rule.\n' };
  const rows = { 'AA-1': DOC_A };

  it('a registered document that cannot be read is the machinery verdict', () => {
    const { code, err } = run({ rows, docs: { [DOC_A]: new Error('EACCES') } });
    assert.equal(code, 2);
    assert.match(err[0], /^✗ an input this check reads could not be read:\n {4}docs\/a\.md/);
  });

  it('a registered clause whose marker the document does not carry is the machinery verdict', () => {
    const { code, err } = run({ rows, docs: { [DOC_A]: 'No marker here.\n' } });
    assert.equal(code, 2);
    assert.match(err[0], /AA-1/);
  });

  it('a baseline that is not JSON, or lacks a list, is the machinery verdict', () => {
    assert.equal(run({ rows, docs, baseline: '{' }).code, 2);
    assert.equal(run({ rows, docs, baseline: { 'issue-homes': {} } }).code, 2);
  });

  it('a baseline entry naming a clause the registry does not hold reds', () => {
    const { code, err } = run({
      rows,
      docs,
      baseline: { ...EMPTY, 'long-units': { 'ZZ-9': 1 } },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} names ZZ-9, which is no registered clause — remove the entry`,
    );
  });
});

describe('main — the remaining verdicts', () => {
  it('a baseline entry for an issue no clause links any more reds until it is removed', () => {
    const { code, err } = run({
      rows: TWO,
      docs: { [DOC_A]: '**AA-1.** A rule.\n', [DOC_B]: '**BB-1.** Another rule.\n' },
      baseline: { ...EMPTY, 'issue-homes': { 7: ['AA-1', 'BB-1'] } },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} lists docent#7 for AA-1, BB-1, and it is now linked from no clause — remove the entry`,
    );
  });

  it('a registry that is not JSON is the machinery verdict', () => {
    const err = [];
    const code = main({
      readFile: (path) => (path === BASELINE_PATH ? JSON.stringify(EMPTY) : '{'),
      log: () => {},
      error: (line) => err.push(line),
    });
    assert.equal(code, 2);
    assert.equal(err.length, 1);
    assert.equal(err[0].split(REGISTRY_PATH).length, 2);
    assert.match(
      err[0],
      /^✗ an input this check reads could not be read:\n {4}docs\/clause-registry\.json does not read as JSON/,
    );
  });

  it('rethrows an error that is not an input error', () => {
    assert.throws(
      () =>
        main({
          readFile: (path) => {
            if (path === BASELINE_PATH) return JSON.stringify(EMPTY);
            return '{"clauses":null}';
          },
          log: () => {},
          error: () => {},
        }),
      TypeError,
    );
  });

  it('a clause set in a blockquote is read without its quote marks', () => {
    assert.deepEqual(clauseUnits('> **AA-1.** One line\n> and its next.\n>\n> - An item.\n'), [
      '**AA-1.** One line and its next.',
      'An item.',
    ]);
  });
});

describe('main — the baseline is held to its shape and to what the tree needs', () => {
  const rows = { 'AA-1': DOC_A, 'BB-1': DOC_B };
  const docs = { [DOC_A]: '**AA-1.** A rule.\n', [DOC_B]: '**BB-1.** Another rule.\n' };
  const withBaseline = (part) => run({ rows, docs, baseline: { ...EMPTY, ...part } });

  it('an entry of the wrong type is the machinery verdict, never a pass', () => {
    assert.equal(withBaseline({ 'long-units': { 'AA-1': 'many' } }).code, 2);
    assert.equal(withBaseline({ 'long-units': { 'AA-1': 1.5 } }).code, 2);
    assert.equal(withBaseline({ 'long-units': null }).code, 2);
    assert.equal(withBaseline({ 'issue-homes': { 7: 'AA-1 BB-1' } }).code, 2);
    assert.equal(withBaseline({ 'issue-homes': { 7: ['AA-1', 2] } }).code, 2);
    assert.equal(withBaseline({ 'shared-text': {} }).code, 2);
    assert.equal(withBaseline({ 'shared-text': [7] }).code, 2);
  });

  it('an entry that admits nothing reds until it is removed', () => {
    const one = withBaseline({ 'issue-homes': { 7: ['AA-1'] } });
    assert.equal(one.code, 1);
    assert.equal(
      one.err[0],
      `✗ ${BASELINE_PATH} lists docent#7 for one clause, which admits nothing — remove the entry`,
    );
    const zero = withBaseline({ 'long-units': { 'AA-1': 0 } });
    assert.equal(zero.code, 1);
    assert.equal(
      zero.err[0],
      `✗ ${BASELINE_PATH} admits 0 unit(s) over ${UNIT_WORD_LIMIT} words in AA-1, which admits nothing — remove the entry`,
    );
  });

  it('a pair listed twice, or out of order, reds', () => {
    const twice = withBaseline({ 'shared-text': ['AA-1|BB-1', 'AA-1|BB-1'] });
    assert.equal(twice.code, 1);
    assert.ok(twice.err.includes(`✗ ${BASELINE_PATH} lists AA-1|BB-1 twice — remove one entry`));
    const swapped = withBaseline({ 'shared-text': ['BB-1|AA-1'] });
    assert.equal(swapped.code, 1);
    assert.equal(
      swapped.err[0],
      `✗ ${BASELINE_PATH} lists BB-1|AA-1, and a pair is written with its two clauses in order — write it AA-1|BB-1`,
    );
  });

  it('the longest of several long units is the one quoted', () => {
    const { err } = run({
      rows: { 'AA-1': DOC_A },
      docs: {
        [DOC_A]: `**AA-1.** Lead.\n\n${words(UNIT_WORD_LIMIT + 1, 'a')}\n\n${words(UNIT_WORD_LIMIT + 9, 'b')}\n`,
      },
    });
    assert.match(err[0], /the longest runs 159 words and opens "b0 b1 b2 b3 b4 b5"$/);
  });
});

describe('the readers', () => {
  it('clauseWords drops link targets and keeps link text and code words', () => {
    assert.deepEqual(clauseWords('A `held_keys` rule, see [the row](x.md#key).'), [
      'a',
      '`held_keys`',
      'rule',
      'see',
      'the',
      'row',
    ]);
  });

  it('issueLinks reads the issue number from any link to an issue of this repository', () => {
    assert.deepEqual(
      [...issueLinks(`One ${ISSUE(12)} and [this](https://github.com/Arsarneq/docent/issues/34).`)],
      ['12', '34'],
    );
    assert.deepEqual(
      [
        ...issueLinks(
          'A [comment](https://github.com/arsarneq/docent/issues/5#issuecomment-1), <https://github.com/Arsarneq/docent/issues/7> and\n\n[r]: https://github.com/Arsarneq/docent/issues/8 "t"',
        ),
      ],
      ['5', '7', '8'],
    );
    assert.deepEqual([...issueLinks('Another repository: https://github.com/x/y/issues/9')], []);
  });

  it('clauseUnits reads `1)` items apart and keeps an item with its indented continuation', () => {
    assert.deepEqual(clauseUnits('1) First item.\n2) Second item.\n'), [
      'First item.',
      'Second item.',
    ]);
    assert.deepEqual(clauseUnits('- An item.\n\n  Its second paragraph.\n\nA paragraph.\n'), [
      'An item. Its second paragraph.',
      'A paragraph.',
    ]);
  });
});

describe('real-tree lock', () => {
  it('the committed clauses pass against the committed baseline', () => {
    const out = [];
    const err = [];
    const code = main({
      readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    assert.deepEqual(err, []);
    assert.equal(code, 0);
  });
});
