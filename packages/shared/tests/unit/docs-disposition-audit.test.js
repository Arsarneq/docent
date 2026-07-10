/**
 * docs-disposition-audit.test.js — Unit tests for the weekly disposition audit
 * (scripts/docs-disposition-audit.js). The audit labels an "unaffected" doc
 * judgment a probable miss when a later, area-overlapping PR edits that doc;
 * these tests prove the labeler fires on exactly that shape and stays quiet on
 * the guarded ones (doc-churn evidence PRs, non-overlapping areas, earlier
 * edits, updated judgments).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDocsPrimary,
  areasOfChange,
  labelProbableMisses,
  wilsonInterval,
} from '../../../../scripts/docs-disposition-audit.js';
import { compileMap } from '../../../../scripts/check-area-map.js';

const MAP = {
  description: 'test map',
  'repo-wide': { description: 'x', docs: ['README.md'] },
  areas: {
    alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md'] },
    beta: { code: ['packages/beta/**'], docs: ['docs/beta.md'] },
  },
  unassigned: [],
};

const disposition = (lines) => `## Docs disposition\n\n${lines.join('\n')}\n`;

const pr = (number, mergedAt, files, bodyLines) => ({
  number,
  mergedAt,
  files,
  body: bodyLines ? disposition(bodyLines) : '',
});

describe('isDocsPrimary', () => {
  it('is true only when docs/ files are the majority', () => {
    assert.equal(isDocsPrimary(['docs/a.md', 'docs/b.md', 'src/x.js']), true);
    assert.equal(isDocsPrimary(['docs/a.md', 'src/x.js']), false);
    assert.equal(isDocsPrimary([]), false);
  });
});

describe('areasOfChange', () => {
  it('resolves non-doc files only', () => {
    const areas = areasOfChange(['packages/alpha/x.js', 'docs/beta.md'], compileMap(MAP));
    assert.deepEqual([...areas], ['alpha']);
  });
});

describe('labelProbableMisses', () => {
  it('labels an unaffected judgment when a later overlapping PR edits the doc', () => {
    const r = labelProbableMisses({
      prs: [
        pr(
          1,
          '2026-07-01T00:00:00Z',
          ['packages/alpha/x.js'],
          ['unaffected: docs/alpha.md — cannot be affected'],
        ),
        pr(
          2,
          '2026-07-03T00:00:00Z',
          ['packages/alpha/y.js', 'docs/alpha.md'],
          ['updated: docs/alpha.md — corrected after all'],
        ),
      ],
      map: MAP,
    });
    assert.deepEqual(r.probableMisses, [{ pr: 1, doc: 'docs/alpha.md', byPr: 2 }]);
    assert.equal(r.unaffectedDocJudgments, 1);
  });

  it('does not use a docs-reorganisation PR as evidence', () => {
    const r = labelProbableMisses({
      prs: [
        pr(
          1,
          '2026-07-01T00:00:00Z',
          ['packages/alpha/x.js'],
          ['unaffected: docs/alpha.md — cannot be affected'],
        ),
        pr(
          2,
          '2026-07-03T00:00:00Z',
          ['docs/alpha.md', 'docs/beta.md', 'packages/alpha/y.js'],
          ['updated: docs/alpha.md — moved sections around'],
        ),
      ],
      map: MAP,
    });
    assert.deepEqual(r.probableMisses, []);
  });

  it('requires area overlap between the two PRs', () => {
    const r = labelProbableMisses({
      prs: [
        pr(
          1,
          '2026-07-01T00:00:00Z',
          ['packages/alpha/x.js'],
          ['unaffected: docs/alpha.md — cannot be affected'],
        ),
        pr(
          2,
          '2026-07-03T00:00:00Z',
          ['packages/beta/z.js', 'docs/alpha.md'],
          ['updated: docs/alpha.md — for unrelated reasons'],
        ),
      ],
      map: MAP,
    });
    assert.deepEqual(r.probableMisses, []);
  });

  it('ignores edits that happened before the judgment', () => {
    const r = labelProbableMisses({
      prs: [
        pr(
          2,
          '2026-07-03T00:00:00Z',
          ['packages/alpha/x.js'],
          ['unaffected: docs/alpha.md — cannot be affected'],
        ),
        pr(
          1,
          '2026-07-01T00:00:00Z',
          ['packages/alpha/y.js', 'docs/alpha.md'],
          ['updated: docs/alpha.md — earlier work'],
        ),
      ],
      map: MAP,
    });
    assert.deepEqual(r.probableMisses, []);
  });

  it('enrolls only doc-level judgments, once per doc, labeled at most once per (pr, doc)', () => {
    const r = labelProbableMisses({
      prs: [
        pr(
          1,
          '2026-07-01T00:00:00Z',
          ['packages/alpha/x.js'],
          [
            'unaffected: docs/alpha.md — cannot be affected',
            'unaffected: docs/alpha.md §AL-1 — nor this rule',
            'unaffected: docs/alpha.md §AL-2 — nor this one',
          ],
        ),
        pr(2, '2026-07-02T00:00:00Z', ['packages/alpha/y.js', 'docs/alpha.md'], []),
        pr(3, '2026-07-04T00:00:00Z', ['packages/alpha/z.js', 'docs/alpha.md'], []),
      ],
      map: MAP,
    });
    assert.equal(r.unaffectedDocJudgments, 1);
    assert.deepEqual(r.probableMisses, [{ pr: 1, doc: 'docs/alpha.md', byPr: 2 }]);
  });

  it('never labels a PR that itself updated the doc — clause-level unaffected lines ride along', () => {
    const r = labelProbableMisses({
      prs: [
        pr(
          1,
          '2026-07-01T00:00:00Z',
          ['packages/alpha/x.js', 'docs/alpha.md'],
          [
            'updated: docs/alpha.md — refreshed the rules',
            'unaffected: docs/alpha.md §AL-1 — this clause untouched',
          ],
        ),
        pr(2, '2026-07-03T00:00:00Z', ['packages/alpha/y.js', 'docs/alpha.md'], []),
      ],
      map: MAP,
    });
    assert.equal(r.unaffectedDocJudgments, 0);
    assert.deepEqual(r.probableMisses, []);
  });

  it('keeps scanning past a docs-reorganisation PR to later legitimate evidence', () => {
    const r = labelProbableMisses({
      prs: [
        pr(
          1,
          '2026-07-01T00:00:00Z',
          ['packages/alpha/x.js'],
          ['unaffected: docs/alpha.md — cannot be affected'],
        ),
        pr(2, '2026-07-02T00:00:00Z', ['docs/alpha.md', 'docs/beta.md', 'packages/alpha/y.js'], []),
        pr(3, '2026-07-04T00:00:00Z', ['packages/alpha/z.js', 'docs/alpha.md'], []),
      ],
      map: MAP,
    });
    assert.deepEqual(r.probableMisses, [{ pr: 1, doc: 'docs/alpha.md', byPr: 3 }]);
  });

  it('reports scan and disposition counts', () => {
    const r = labelProbableMisses({
      prs: [
        pr(1, '2026-07-01T00:00:00Z', ['packages/alpha/x.js'], ['unaffected: docs/alpha.md — x']),
        pr(2, '2026-07-02T00:00:00Z', ['packages/beta/y.js'], null),
      ],
      map: MAP,
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.withDispositions, 1);
  });
});

describe('wilsonInterval', () => {
  it('is 0–0 on an empty sample and brackets the point rate otherwise', () => {
    assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 0 });
    const { low, high } = wilsonInterval(2, 9);
    assert.equal(low > 0 && low < 2 / 9, true);
    assert.equal(high < 1 && high > 2 / 9, true);
  });

  it('narrows as the sample grows', () => {
    const small = wilsonInterval(2, 9);
    const large = wilsonInterval(20, 90);
    assert.equal(large.high - large.low < small.high - small.low, true);
  });
});
