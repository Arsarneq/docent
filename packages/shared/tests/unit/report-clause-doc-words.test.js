/**
 * report-clause-doc-words.test.js — Unit tests for the word report
 * (scripts/report-clause-doc-words.js): for each document that holds clauses,
 * the words it held at the base and the words it holds now. The suite drives
 * `main` over an injected registry, injected current documents and injected
 * base documents — a document that grew, one that shrank, one that is new, one
 * that did not change, and one the base registered that is gone, renamed or no
 * longer registered, the total over several, the copy written to the job
 * summary, and the exit code, which growth never changes. Two real-tree cases
 * run the script itself: against the checked-out commit, and against a base
 * ref git cannot resolve. The last block pins the shared reader of files at
 * the merge base (`baseFileReader` in scripts/governance-data.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { main } from '../../../../scripts/report-clause-doc-words.js';
import { REGISTRY_PATH, baseFileReader } from '../../../../scripts/governance-data.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const DOC_A = 'docs/a.md';
const DOC_B = 'docs/b.md';

/** `count` words of text. */
const words = (count) => Array.from({ length: count }, (_, i) => `w${i}`).join(' ');

/** A registry naming the given clauses, each in its document. */
const registry = (rows) =>
  JSON.stringify({ clauses: Object.entries(rows).map(([clause, doc]) => ({ clause, doc })) });

/**
 * The report over one in-memory tree.
 * @param {object} tree the inputs
 * @param {Record<string, string>} tree.rows clause id → document path
 * @param {Record<string, string | Error>} tree.now document path → its text now, or the read's error
 * @param {Record<string, string>} tree.base document path → its text at the base; absent when the base lacks it
 * @param {string} [tree.registryText] the registry's raw text, in place of `rows`
 * @param {Record<string, string>} [tree.baseRows] clause id → document path in the base's registry; absent when the base holds no registry
 * @param {string} [tree.baseRegistryText] the base registry's raw text, in place of `baseRows`
 * @returns {{ code: number, out: string[], err: string[], summary: string[] }}
 */
function run({ rows = {}, now = {}, base = {}, registryText, baseRows, baseRegistryText }) {
  const out = [];
  const err = [];
  const summary = [];
  const files = { ...now, [REGISTRY_PATH]: registryText ?? registry(rows) };
  const code = main({
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      if (value instanceof Error) throw value;
      return value;
    },
    readBaseFile: (path) => {
      if (path === REGISTRY_PATH) return baseRegistryText ?? (baseRows ? registry(baseRows) : null);
      return base[path] ?? null;
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    appendSummary: (text) => summary.push(text),
  });
  return { code, out, err, summary };
}

describe('report-clause-doc-words', () => {
  it('shows a document that grew with its words before, after and the difference', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(25) },
      base: { [DOC_A]: words(10) },
    });
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(`| ${DOC_A} | 10 | 25 | +15 |`), r.out.join('\n'));
  });

  it('shows a document that shrank with a negative difference', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(10) },
      base: { [DOC_A]: words(25) },
    });
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(`| ${DOC_A} | 25 | 10 | -15 |`), r.out.join('\n'));
  });

  it('counts a document the base does not hold from zero', () => {
    const r = run({ rows: { 'AA-1': DOC_A }, now: { [DOC_A]: words(7) } });
    assert.ok(r.out.includes(`| ${DOC_A} | 0 | 7 | +7 |`), r.out.join('\n'));
  });

  it('leaves out a document whose word count did not change', () => {
    const r = run({
      rows: { 'AA-1': DOC_A, 'BB-1': DOC_B },
      now: { [DOC_A]: words(12), [DOC_B]: words(30) },
      base: { [DOC_A]: words(10), [DOC_B]: words(30) },
    });
    assert.ok(!r.out.some((line) => line.includes(DOC_B)), r.out.join('\n'));
    assert.ok(r.out.some((line) => line.includes(DOC_A)));
  });

  it('says so in one line when no document changed length', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(10) },
      base: { [DOC_A]: words(10) },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['No document that holds clauses changed its word count.']);
  });

  it('lists a document once however many clauses it holds', () => {
    const r = run({
      rows: { 'AA-1': DOC_A, 'AA-2': DOC_A, 'AA-3': DOC_A },
      now: { [DOC_A]: words(12) },
      base: { [DOC_A]: words(10) },
    });
    assert.equal(r.out.filter((line) => line.includes(DOC_A)).length, 1);
  });

  it('adds a total row when more than one document changed', () => {
    const r = run({
      rows: { 'AA-1': DOC_A, 'BB-1': DOC_B },
      now: { [DOC_A]: words(25), [DOC_B]: words(5) },
      base: { [DOC_A]: words(10), [DOC_B]: words(9) },
    });
    assert.ok(r.out.includes('| Total | 19 | 30 | +11 |'), r.out.join('\n'));
    const one = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(25) },
      base: { [DOC_A]: words(10) },
    });
    assert.ok(!one.out.some((line) => line.includes('Total')));
  });

  it('counts the words a reader reads: a link target and a fenced block add none', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: {
        [DOC_A]: 'one [two](https://example.com/a/b/c) three\n\n```\nfour five six\n```\n',
      },
    });
    assert.ok(r.out.includes(`| ${DOC_A} | 0 | 3 | +3 |`), r.out.join('\n'));
  });

  it('writes the same table to the job summary under a heading', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(25) },
      base: { [DOC_A]: words(10) },
    });
    assert.equal(r.summary.length, 1);
    assert.match(r.summary[0], /^### Words in the documents that hold clauses\n\n/);
    for (const line of r.out) assert.ok(r.summary[0].includes(line), line);
  });

  it('exits 0 however much a document grew: the report is shown and never a gate', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(50000) },
      base: { [DOC_A]: words(10) },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.err, []);
  });

  it('exits 2 naming the registry when it cannot be read as JSON', () => {
    const r = run({ registryText: '{ not json' });
    assert.equal(r.code, 2);
    assert.match(r.err.join('\n'), new RegExp(REGISTRY_PATH.replaceAll('.', '\\.')));
    assert.deepEqual(r.out, []);
  });

  it('exits 2 naming a registered document that cannot be read now', () => {
    const r = run({ rows: { 'AA-1': DOC_A }, now: { [DOC_A]: new Error('EACCES') } });
    assert.equal(r.code, 2);
    assert.match(r.err.join('\n'), /docs\/a\.md/);
  });

  it('shows a document the base registered and the tree no longer holds with 0 words now', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(10) },
      baseRows: { 'AA-1': DOC_A, 'BB-1': DOC_B },
      base: { [DOC_A]: words(10), [DOC_B]: words(9) },
    });
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(`| ${DOC_B} | 9 | 0 | -9 |`), r.out.join('\n'));
  });

  it('shows a renamed document as its old path emptied and its new path filled', () => {
    const r = run({
      rows: { 'AA-1': DOC_B },
      now: { [DOC_B]: words(12) },
      baseRows: { 'AA-1': DOC_A },
      base: { [DOC_A]: words(10) },
    });
    assert.ok(r.out.includes(`| ${DOC_A} | 10 | 0 | -10 |`), r.out.join('\n'));
    assert.ok(r.out.includes(`| ${DOC_B} | 0 | 12 | +12 |`), r.out.join('\n'));
    assert.ok(r.out.includes('| Total | 10 | 12 | +2 |'), r.out.join('\n'));
  });

  it('counts a document that left the registry and is still in the tree as it is now', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(10), [DOC_B]: words(4) },
      baseRows: { 'AA-1': DOC_A, 'BB-1': DOC_B },
      base: { [DOC_A]: words(10), [DOC_B]: words(9) },
    });
    assert.ok(r.out.includes(`| ${DOC_B} | 9 | 4 | -5 |`), r.out.join('\n'));
  });

  it('reads a base whose registry cannot be read as a base that registered nothing', () => {
    const r = run({
      rows: { 'AA-1': DOC_A },
      now: { [DOC_A]: words(12) },
      baseRegistryText: '{ not json',
      base: { [DOC_A]: words(10) },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.err, []);
    assert.ok(r.out.includes(`| ${DOC_A} | 10 | 12 | +2 |`), r.out.join('\n'));
  });

  it('real tree: against its own commit the report prints its table or its one line and exits 0', () => {
    // A working tree with an uncommitted edit to a clause document differs from
    // its own commit, so either output is the report working.
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'report-clause-doc-words.js'), 'HEAD'],
      { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    assert.match(
      out,
      /^(\| Document \| Before \| After \| Change \|\n|No document that holds clauses changed its word count\.\n$)/,
    );
  });

  it('real tree: a base ref git cannot resolve exits 2 and names the ref', () => {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'report-clause-doc-words.js'), 'no-such-ref'],
      { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no merge base of no-such-ref and HEAD/);
    assert.equal(r.stdout, '');
  });
});

describe('baseFileReader', () => {
  /** A git that knows one merge base and the files it holds. */
  const fakeGit = (files) => (args) => {
    if (args[0] === 'merge-base' && args[1] === 'origin/main') return 'abc123\n';
    if (args[0] === 'show' && args[1].startsWith('abc123:')) {
      const text = files[args[1].slice('abc123:'.length)];
      if (text !== undefined) return text;
    }
    throw new Error(`git ${args.join(' ')} failed`);
  };

  it('reads a file as the merge base of the ref and HEAD holds it', () => {
    const read = baseFileReader(fakeGit({ 'docs/a.md': 'one two' }), 'origin/main');
    assert.equal(read('docs/a.md'), 'one two');
  });

  it('answers null for a file the base does not hold', () => {
    const read = baseFileReader(fakeGit({}), 'origin/main');
    assert.equal(read('docs/a.md'), null);
  });

  it('throws naming the ref when git finds no merge base', () => {
    assert.throws(
      () => baseFileReader(fakeGit({}), 'no-such-ref'),
      /no merge base of no-such-ref and HEAD/,
    );
  });
});
