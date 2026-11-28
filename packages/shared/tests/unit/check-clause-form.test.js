/**
 * check-clause-form.test.js — Unit tests for the clause-form check
 * (scripts/check-clause-form.js): a rule has one home, and a unit of a
 * clause that grew is listed for review. The suite drives the verdicts through
 * `main` over an injected registry, injected documents and an injected baseline
 * — an issue linked from two clauses and a run of words standing in two clauses
 * each red naming the clauses, a baseline entry admits exactly the case it
 * names, a baseline entry the tree no longer needs reds until it is removed,
 * a unit of any length passes and its growth since the base is listed without
 * failing, and an unreadable document or a baseline out of shape is the
 * machinery verdict — and a real-tree case holds the committed documents and
 * the committed baseline to passing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BASELINE_PATH,
  RUN_WORDS,
  clauseUnits,
  clauseWords,
  issueLinks,
  main,
} from '../../../../scripts/check-clause-form.js';
import { GROWTH_ANSWER, REGISTRY_PATH, summaryCell } from '../../../../scripts/governance-data.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const DOC_A = 'docs/a.md';
const DOC_B = 'docs/b.md';
const ISSUE = (n) => `[docent#${n}](https://github.com/Arsarneq/docent/issues/${n})`;
const EMPTY = { 'issue-homes': {}, 'shared-text': [] };
const BASE_REF = 'origin/main';
const SEE = `Fix the clause; do not add an entry to ${BASELINE_PATH}. scripts/check-clause-form.js holds the rules.`;
const ONE_DOC = { 'AA-1': DOC_A, 'AA-2': DOC_A };

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
 * @param {object | string | null} [tree.base] the baseline at the base commit, its raw text, or null when the base holds none; absent when the run has no base
 * @param {Record<string, string>} [tree.baseDocs] document path → its text at the base commit; a path it lacks is a document the base does not hold. Given without `base`, the base holds no baseline
 * @returns {{ code: number, out: string[], err: string[], summary: string[] }}
 */
function run({ rows, docs, baseline = EMPTY, base, baseDocs }) {
  const out = [];
  const err = [];
  const summary = [];
  const hasBase = base !== undefined || baseDocs !== undefined;
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
    readBaseFile: !hasBase
      ? undefined
      : (path) => {
          if (path !== BASELINE_PATH) return baseDocs?.[path] ?? null;
          if (base === null || base === undefined) return null;
          return typeof base === 'string' ? base : JSON.stringify(base);
        },
    baseRef: hasBase ? BASE_REF : undefined,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    summary: (markdown) => summary.push(markdown),
  });
  return { code, out, err, summary };
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
      `✓ 2 clause(s) in 2 document(s): no issue linked from two clauses of one document and no run of ${RUN_WORDS} words standing in two clauses, beyond the 0 case(s) ${BASELINE_PATH} lists.`,
    ]);
  });

  it('an issue linked from two clauses of one document reds naming both and the document', () => {
    const { code, err } = run({
      rows: ONE_DOC,
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n\n**AA-2.** The same gap again (${ISSUE(7)}).\n`,
      },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ docent#7 is linked from AA-1 and AA-2 in ${DOC_A} — within one document a departure or an open case is linked from one clause, and any other clause cites that clause`,
    );
    assert.equal(err[1], `\n1 problem. ${SEE}`);
  });

  it('an issue linked from one clause in each of two documents passes', () => {
    const { code, err } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n`,
        [DOC_B]: `**BB-1.** The same gap on this side (${ISSUE(7)}).\n`,
      },
    });
    assert.deepEqual(err, []);
    assert.equal(code, 0);
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
    const rows = { ...ONE_DOC, 'AA-3': DOC_A };
    const two = `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n\n**AA-2.** Again (${ISSUE(7)}).\n\n`;
    const docs = { [DOC_A]: `${two}**AA-3.** Something else.\n` };
    const baseline = { ...EMPTY, 'issue-homes': { 7: ['AA-1', 'AA-2'] } };
    assert.equal(run({ rows, docs, baseline }).code, 0);
    docs[DOC_A] = `${two}**AA-3.** And again (${ISSUE(7)}).\n`;
    const { code, err } = run({ rows, docs, baseline });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ docent#7 is linked from AA-3 in ${DOC_A} as well as the clauses ${BASELINE_PATH} lists for it (AA-1, AA-2) — within one document a departure or an open case is linked from one clause, and any other clause cites that clause`,
    );
  });

  it('a baseline entry naming a clause that no longer links the issue reds until it is removed', () => {
    const { code, err } = run({
      rows: ONE_DOC,
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n\n**AA-2.** Another rule, citing AA-1.\n`,
      },
      baseline: { ...EMPTY, 'issue-homes': { 7: ['AA-1', 'AA-2'] } },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} lists docent#7 for AA-1, AA-2, and no two clauses of one document link it now — remove the entry`,
    );
  });

  it('a baseline entry naming more clauses than still link the issue asks for the entry to be cut to them', () => {
    const { code, err } = run({
      rows: { ...ONE_DOC, 'AA-3': DOC_A },
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n\n**AA-2.** Again (${ISSUE(7)}).\n\n**AA-3.** Another rule.\n`,
      },
      baseline: { ...EMPTY, 'issue-homes': { 7: ['AA-1', 'AA-2', 'AA-3'] } },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} lists docent#7 for AA-1, AA-2, AA-3, and it is now linked from AA-1, AA-2 only — cut the entry to those`,
    );
  });

  it('a baseline entry naming clauses of two documents admits nothing and reds', () => {
    const { code, err } = run({
      rows: TWO,
      docs: {
        [DOC_A]: `**AA-1.** A rule, tracked in ${ISSUE(7)}.\n`,
        [DOC_B]: `**BB-1.** The same gap on this side (${ISSUE(7)}).\n`,
      },
      baseline: { ...EMPTY, 'issue-homes': { 7: ['AA-1', 'BB-1'] } },
    });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} lists docent#7 for AA-1, BB-1, and no two clauses of one document link it now — remove the entry`,
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
      `✗ AA-1 (${DOC_A}) and BB-1 (${DOC_B}) both state "${shared}" — a rule is stated in one clause, and any other clause cites that clause`,
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

describe('main — a unit of any length passes', () => {
  it('a paragraph of 500 words passes, and without a base no note is printed', () => {
    const { code, out, err, summary } = run({
      rows: { 'AA-1': DOC_A },
      docs: { [DOC_A]: `**AA-1.** Short lead.\n\n${words(500, 'w')}\n` },
    });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
    assert.match(out[0], /^✓ 1 clause\(s\) in 1 document\(s\)/);
    assert.deepEqual(summary, []);
  });
});

describe('main — the units of a clause that grew since the base', () => {
  const rows = { 'AA-1': DOC_A, 'AA-2': DOC_A, 'BB-1': DOC_B };
  const docA = (one, two) => `# A\n\nPreamble.\n\n**AA-1.** Lead.\n\n${one}\n\n**AA-2.** ${two}\n`;
  const docB = (text) => `**BB-1.** ${text}\n`;
  const UNIT = 'a unit (a paragraph, a list item or a table row)';
  const NONE = `note: no unit of a clause grew since ${BASE_REF}.`;
  const heading = (count) =>
    `note: ${count} unit(s) of a clause grew since ${BASE_REF}. ${GROWTH_ANSWER}`;
  const grew = (line, was, now, doc = DOC_A, clause = 'AA-1') =>
    `  ${doc}:${line}: ${clause}: ${UNIT} grew from ${was} to ${now} words`;
  const one = (now, base, doc = DOC_A) =>
    run({ rows: { 'AA-1': doc }, docs: { [doc]: now }, baseDocs: { [doc]: base } });
  /** A clause of a lead and three paragraphs, on lines 1, 3, 5 and 7. */
  const three = (a, b, c) => `**AA-1.** Lead.\n\n${a}\n\n${b}\n\n${c}\n`;

  // A marker such as **BB-1.** counts as two words of its paragraph.
  it('lists each grown unit as doc:line: with both counts, and passes', () => {
    const { code, out, err } = run({
      rows,
      docs: { [DOC_A]: docA(words(30, 'w'), words(9, 'x')), [DOC_B]: docB(words(12, 'y')) },
      baseDocs: { [DOC_A]: docA(words(20, 'w'), words(9, 'x')), [DOC_B]: docB(words(11, 'y')) },
    });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out.slice(0, 3), [
      heading(2),
      grew(7, 20, 30),
      grew(1, 13, 14, DOC_B, 'BB-1'),
    ]);
    assert.match(out[3], /^✓ 3 clause\(s\) in 2 document\(s\)/);
    assert.equal(out.length, 4);
  });

  it('says so when no unit grew, so the log shows the clauses were compared', () => {
    const docs = { [DOC_A]: docA(words(20, 'w'), words(9, 'x')), [DOC_B]: docB(words(11, 'y')) };
    const { code, out, summary } = run({ rows, docs, baseDocs: docs });
    assert.equal(code, 0);
    assert.equal(out[0], NONE);
    assert.equal(out.length, 2);
    assert.deepEqual(summary, []);
  });

  it('a unit that is not the longest is listed when it grew', () => {
    const doc = (second) => `**AA-1.** Lead.\n\n${words(300, 'w')}\n\n- ${second}\n- Short.\n`;
    const { out } = one(doc(words(294, 'x')), doc(words(104, 'x')));
    assert.deepEqual(out.slice(0, 2), [heading(1), grew(5, 104, 294)]);
  });

  it('a cut in one unit does not hide growth in another that shares no word with it', () => {
    const { out } = one(
      three(words(150, 'a'), words(30, 'b'), words(90, 'c')),
      three(words(150, 'a'), words(100, 'b'), words(40, 'c')),
    );
    assert.deepEqual(out.slice(0, 2), [heading(1), grew(7, 40, 90)]);
    assert.equal(out.length, 3);
  });

  it('the grown unit is the one named, not a unit that shrank to its earlier length', () => {
    const { out } = one(
      three(words(82, 'a'), words(120, 'b'), 'End.'),
      three(words(122, 'a'), words(80, 'b'), 'End.'),
    );
    assert.deepEqual(out.slice(0, 2), [heading(1), grew(5, 80, 120)]);
    assert.equal(out.length, 3);
  });

  it('a unit replaced by other words, and an added unit, are listed as grown from 0', () => {
    const replaced = one(
      `**AA-1.** Lead.\n\n- ${words(9, 'x')}\n- ${words(9, 'new')}\n`,
      `**AA-1.** Lead.\n\n- ${words(9, 'x')}\n- ${words(9, 'old')}\n`,
    );
    assert.deepEqual(replaced.out.slice(0, 2), [heading(1), grew(4, 0, 9)]);
    const added = one(
      `**AA-1.** Lead.\n\n${words(20, 'w')}\n\nNew one.\n`,
      `**AA-1.** Lead.\n\n${words(20, 'w')}\n`,
    );
    assert.deepEqual(added.out.slice(0, 2), [heading(1), grew(5, 0, 2)]);
  });

  it('every grown unit of a clause gets a line', () => {
    const { out } = one(
      three(words(12, 'a'), words(25, 'b'), 'End.'),
      three(words(10, 'a'), words(20, 'b'), 'End.'),
    );
    assert.deepEqual(out.slice(0, 3), [heading(2), grew(3, 10, 12), grew(5, 20, 25)]);
  });

  it('an added unit that shares words with the units beside it is still listed as added', () => {
    const base = '**AA-1.** Lead.\n\nThe cat sat on the mat today and stayed there.\n';
    const { out } = one(`${base}\nThe dog sat on the mat.\n`, base);
    assert.deepEqual(out.slice(0, 2), [heading(1), grew(5, 0, 6)]);
    assert.equal(out.length, 3);
  });

  it('a base unit is the match of one unit, so of a unit split in two the part that shares fewer words with it is listed as added', () => {
    const { out } = one(
      `**AA-1.** Lead.\n\n${words(12, 'w')}\n\n${words(8, 'x')}\n`,
      `**AA-1.** Lead.\n\n${words(12, 'w')} ${words(8, 'x')}\n`,
    );
    assert.deepEqual(out.slice(0, 2), [heading(1), grew(5, 0, 8)]);
  });

  it('a unit written over a unit that left is compared with that unit', () => {
    const doc = (item) => `**AA-1.** Lead.\n\n- ${words(9, 'x')}\n- ${item}\n`;
    assert.equal(one(doc('the gate stays shut'), doc('the gate is open at night')).out[0], NONE);
    const longer = one(doc('the gate stays shut from dusk to dawn'), doc('the gate is open'));
    assert.deepEqual(longer.out.slice(0, 2), [heading(1), grew(4, 4, 8)]);
  });

  it('not seen: a unit that grew beside a cut unit, when it shares more words with the cut unit’s earlier text than with its own', () => {
    const lead = '**AA-1.** The recorder keeps the file.';
    const base = [
      lead,
      'When the person stops the recording, the application writes the file to the folder the person chose, and the file holds each step in the order the person took it, so that the person can read the steps and see what the recording holds.',
      'The file is never changed after that.',
    ].join('\n\n');
    const now = [
      lead,
      'The application writes the file when the recording stops.',
      'The file is never changed after that, and when the person opens the folder the application shows the file and each step in the order the person took it, so that the person can see what the file holds.',
    ].join('\n\n');
    // The third paragraph grew from 7 to 39 words, and the list names the cut paragraph instead.
    const { out } = one(`${now}\n`, `${base}\n`);
    assert.deepEqual(out.slice(0, 2), [heading(1), grew(3, 7, 9)]);
    assert.equal(out.length, 3);
  });

  it('a unit sharing as many words with two base units is compared with the longer', () => {
    const base = `**AA-1.** Lead.\n\n${words(10, 'w')}\n\n${words(10, 'w')} ${words(10, 'x')}\n`;
    // 12 words, 10 of them in both base units: against the 20-word unit it did not grow.
    assert.equal(one(`**AA-1.** Lead.\n\n${words(10, 'w')} more words\n`, base).out[0], NONE);
  });

  it('a word counts as shared as many times as both units hold it', () => {
    // "go go go" shares two words with "go go" and one with "go on now".
    const { out } = one(
      '**AA-1.** Lead.\n\n- go go go\n',
      '**AA-1.** Lead.\n\n- go on now\n- go go\n',
    );
    assert.deepEqual(out.slice(0, 2), [heading(1), grew(3, 2, 3)]);
  });

  it('a unit that shrank, a unit that left and the same words in another order are not listed', () => {
    const base = `**AA-1.** Lead.\n\n${words(20, 'w')}\n\n- ${words(9, 'x')}\n`;
    const shrank = `**AA-1.** Lead.\n\n${words(19, 'w')}\n\n- ${words(9, 'x')}\n`;
    const turned = `**AA-1.** Lead.\n\n${words(20, 'w').split(' ').reverse().join(' ')}\n\n- ${words(9, 'x')}\n`;
    assert.equal(one(shrank, base).out[0], NONE);
    assert.equal(one(`**AA-1.** Lead.\n\n${words(20, 'w')}\n`, base).out[0], NONE);
    assert.equal(one(turned, base).out[0], NONE);
  });

  it('a clause the base does not hold in that document is not listed', () => {
    const docs = { [DOC_A]: docA(words(30, 'w'), words(9, 'x')), [DOC_B]: docB(words(40, 'y')) };
    // The base holds neither document.
    assert.equal(run({ rows, docs, baseDocs: {} }).out[0], NONE);
    // The base holds the documents without these clauses' markers.
    const bare = { [DOC_A]: '# A\n\nPreamble.\n', [DOC_B]: `**AA-1.** ${words(5, 'w')}\n` };
    assert.equal(run({ rows, docs, baseDocs: bare }).out[0], NONE);
  });

  it('a marker inside a fenced block is not the clause, now or at the base', () => {
    const fence =
      '```text\n**AA-1.** An example of a marker, with many more words than the clause.\n```\n\n';
    const { out } = one(
      `${fence}**AA-1.** ${words(8, 'w')}\n`,
      `${fence}**AA-1.** ${words(5, 'w')}\n`,
    );
    assert.equal(out[1], grew(5, 7, 10));
  });

  it('the list is printed beside a problem, and the problem still reds', () => {
    const shared = words(RUN_WORDS, 'same');
    const { code, out, err } = run({
      rows: TWO,
      docs: { [DOC_A]: `**AA-1.** First ${shared} here.\n`, [DOC_B]: docB(`Second ${shared}.`) },
      baseDocs: { [DOC_A]: '**AA-1.** First.\n', [DOC_B]: docB(`Second ${shared}.`) },
    });
    assert.equal(code, 1);
    assert.deepEqual(out, [heading(1), grew(1, 3, RUN_WORDS + 4)]);
    assert.match(err[0], /^✗ AA-1 \(docs\/a\.md\) and BB-1 \(docs\/b\.md\) both state/);
  });

  it('the grown units go to the job summary as a table, a pipe and a backslash in a name escaped', () => {
    const odd = 'docs/a|b\\c.md';
    const { summary } = one(
      `Top.\n\n**AA-1.** ${words(8, 'w')}\n`,
      `Top.\n\n**AA-1.** ${words(5, 'w')}\n`,
      odd,
    );
    assert.deepEqual(summary, [
      [
        `### Units of a clause that grew since ${BASE_REF}`,
        '',
        GROWTH_ANSWER,
        '',
        '| Document | Line | Clause | Before | Now |',
        '| --- | --- | --- | --- | --- |',
        '| `docs/a\\|b\\\\c.md` | 3 | AA-1 | 7 | 10 |',
        '',
      ].join('\n'),
    ]);
  });
});

describe('what the two growth lists share', () => {
  it('the answer names who answers a list and where the rule stands', () => {
    assert.equal(
      GROWTH_ANSWER,
      "This does not fail: the pull request's reviewer answers each (docs/guides/docs-governance.md, Writing docs).",
    );
  });

  it('summaryCell escapes a backslash and then a pipe, and writes other values as text', () => {
    assert.equal(summaryCell('a|b'), 'a\\|b');
    assert.equal(summaryCell('a\\|b'), 'a\\\\\\|b');
    assert.equal(summaryCell(12), '12');
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
      baseline: { ...EMPTY, 'shared-text': ['AA-1|ZZ-9'] },
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
      `✗ ${BASELINE_PATH} lists docent#7 for AA-1, BB-1, and no two clauses of one document link it now — remove the entry`,
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
});

describe('main — the baseline admits no more than the base it is compared with', () => {
  const shared = words(RUN_WORDS, 'same');
  const rows = { ...ONE_DOC, 'BB-1': DOC_B };
  const docs = {
    [DOC_A]: `**AA-1.** First ${shared}, see ${ISSUE(7)}.\n\n**AA-2.** Again, see ${ISSUE(7)}.\n`,
    [DOC_B]: `**BB-1.** Second ${shared}.\n`,
  };
  const baseline = {
    'issue-homes': { 7: ['AA-1', 'AA-2'] },
    'shared-text': ['AA-1|BB-1'],
  };

  it('a baseline equal to the base passes, and so does one that admits less', () => {
    assert.equal(run({ rows, docs, baseline, base: baseline }).code, 0);
    const wider = {
      'issue-homes': { 7: ['AA-1', 'AA-2'], 9: ['AA-1', 'AA-2'] },
      'shared-text': ['AA-1|BB-1', 'AA-2|BB-1'],
    };
    assert.equal(run({ rows, docs, baseline, base: wider }).code, 0);
  });

  it('a base baseline that still holds a list this check no longer reads is compared on the two it reads', () => {
    const older = { ...baseline, 'long-units': { 'AA-2': 1 } };
    assert.equal(run({ rows, docs, baseline, base: older }).code, 0);
  });

  it('a pair the base does not list reds though the baseline lists it', () => {
    const { code, err } = run({ rows, docs, baseline, base: { ...baseline, 'shared-text': [] } });
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ ${BASELINE_PATH} lists AA-1|BB-1 as sharing text, which the base does not — the list only shrinks: fix the clause and take the new entry out`,
    );
    assert.equal(err[1], `\n1 problem. ${SEE}`);
  });

  it('a clause the base does not list under an issue reds the same way', () => {
    const issue = run({ rows, docs, baseline, base: { ...baseline, 'issue-homes': {} } });
    assert.equal(issue.code, 1);
    assert.equal(
      issue.err[0],
      `✗ ${BASELINE_PATH} lists docent#7 for AA-1, AA-2, which the base does not — the list only shrinks: fix the clause and take the new entry out`,
    );
  });

  it('a new entry reds even when another entry left the list, so the totals do not grow', () => {
    const other = {
      'issue-homes': { 9: ['AA-1', 'AA-2'] },
      'shared-text': ['AA-2|BB-1'],
    };
    const { code, err } = run({ rows, docs, baseline, base: other });
    assert.equal(code, 1);
    assert.equal(err.filter((line) => line.includes('the list only shrinks')).length, 2);
  });

  it('a base that holds no baseline is not compared', () => {
    assert.equal(run({ rows, docs, baseline, base: null }).code, 0);
  });

  it('a base baseline out of shape is the machinery verdict', () => {
    const { code, err } = run({ rows, docs, baseline, base: '{ not json' });
    assert.equal(code, 2);
    assert.match(err.join('\n'), /at the base/);
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

  it('clauseUnits reads each list item and each table row as a unit of its own', () => {
    assert.deepEqual(
      clauseUnits('**AA-1.** Lead:\n\n- One.\n- Two.\n\n| a | b |\n| --- | --- |\n| c | d |\n'),
      ['**AA-1.** Lead:', 'One.', 'Two.', '| a | b |', '| c | d |'],
    );
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
