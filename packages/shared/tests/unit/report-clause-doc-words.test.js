/**
 * report-clause-doc-words.test.js — Unit tests for the word report
 * (scripts/report-clause-doc-words.js): for each document that holds clauses,
 * the words it held at the base and the words it holds now. The suite drives
 * `main` over an injected registry, injected current documents and injected
 * base documents — a document that grew, one that shrank, one that is new and
 * one that did not change, the total over several, the copy written to the job
 * summary, and the exit code, which growth never changes — and a real-tree
 * case runs the report against the checked-out commit itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { main } from '../../../../scripts/report-clause-doc-words.js';
import { REGISTRY_PATH } from '../../../../scripts/governance-data.js';

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
 * @returns {{ code: number, out: string[], err: string[], summary: string[] }}
 */
function run({ rows = {}, now = {}, base = {}, registryText }) {
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
    readBaseFile: (path) => base[path] ?? null,
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

  it('real tree: against its own commit the report finds no change and exits 0', () => {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'report-clause-doc-words.js'), 'HEAD'],
      { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    assert.match(out, /\| Document \| Before \| After \| Change \||No document that holds clauses/);
  });
});
