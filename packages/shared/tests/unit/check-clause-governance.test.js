/**
 * check-clause-governance.test.js — Unit tests for the clause-governance check
 * (scripts/check-clause-governance.js) that gates CI. A clause cites the code
 * that implements or guards it; this check holds that citation to a real
 * governance edge — the cited file must owe the clause's doc under the area map.
 * These tests prove every way the edge can rot fails loud (an uncovered
 * citation, a repo-wide doc that does not couple, a stale allowlist entry) and
 * that a deliberately-recorded exception is honoured — keyed by the citation
 * token the check reads and reports, so an exception recorded for a pattern
 * token answers for
 * the whole set that token names, and an entry is hit only where the citation
 * needs it, which is what keeps "stale" meaning no citation leans on the entry
 * — its coupling now resolving on its own governance, its citation gone, or
 * its key being something other than the citation token the check reports.
 * A citation naming files
 * by PATTERN gets the same treatment through its expansion: a mid-path glob
 * contributes an edge per tracked file it names, the files left uncovered
 * under it report as one finding naming the pattern and them, and the summary
 * counts that token once — while a pattern naming nothing, one that does not
 * compile, and a separator-less one contribute no edge at all, the same
 * silence an untracked path has always had. Two citations written without a
 * space between them arrive as one token and are read as the two they are, and
 * a token leaning on a recorded exception is counted apart from the ones that
 * resolve on their own governance. A final baseline lock runs the
 * check over the real tree so the committed allowlist stays exactly the
 * recorded couplings — no more, no fewer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  citedPaths,
  auditClauseGovernance,
  ALLOWLIST,
} from '../../../../scripts/check-clause-governance.js';

/** A minimal map: one area 'alpha', one 'tooling', one repo-wide doc. */
function makeMap(overrides = {}) {
  return {
    description: 'test map',
    'repo-wide': { description: 'x', docs: ['docs/repowide.md'] },
    areas: {
      alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md'] },
      tooling: { code: ['scripts/**'], docs: ['docs/tooling.md'] },
    },
    unassigned: [],
    'declared-governance': [],
    'governance-partitions': [],
    ...overrides,
  };
}

const FILES = [
  'docs/alpha.md',
  'docs/tooling.md',
  'docs/repowide.md',
  'README.md',
  'packages/alpha/x.js',
  'scripts/y.js',
];

function audit({ clauses, map = makeMap(), allowlist = new Map(), contents = {} } = {}) {
  return auditClauseGovernance({
    registry: { clauses },
    map,
    files: FILES,
    readFile: (f) => contents[f] ?? null,
    allowlist,
  });
}

describe('citedPaths', () => {
  const tracked = new Set(FILES);
  /** The tokens cited, each with the tracked files it names. */
  const cited = (row) => citedPaths(row, tracked, FILES).map((c) => [c.token, c.paths, c.pattern]);

  it('extracts directory-qualified and directory-less tracked paths', () => {
    const row = { 'check-ref': 'guard packages/alpha/x.js and README.md' };
    assert.deepEqual(cited(row), [
      ['packages/alpha/x.js', ['packages/alpha/x.js'], false],
      ['README.md', ['README.md'], false],
    ]);
  });
  it('deduplicates repeated citations and drops untracked tokens', () => {
    const row = {
      'check-ref': 'packages/alpha/x.js twice packages/alpha/x.js',
      justification: 'and untracked/z.js',
    };
    assert.deepEqual(cited(row), [['packages/alpha/x.js', ['packages/alpha/x.js'], false]]);
  });
  it('reads both check-ref and justification', () => {
    const row = { 'check-ref': 'packages/alpha/x.js', justification: 'scripts/y.js too' };
    assert.deepEqual(cited(row), [
      ['packages/alpha/x.js', ['packages/alpha/x.js'], false],
      ['scripts/y.js', ['scripts/y.js'], false],
    ]);
  });

  it('reads a mid-path glob whole and names every tracked file under it', () => {
    const row = { 'check-ref': 'guarded by docs/*.md' };
    assert.deepEqual(cited(row), [
      ['docs/*.md', ['docs/alpha.md', 'docs/tooling.md', 'docs/repowide.md'], true],
    ]);
  });

  it('reads a brace alternation as the pattern it is', () => {
    const row = { 'check-ref': 'guarded by docs/{alpha,tooling}.md' };
    assert.deepEqual(cited(row), [
      ['docs/{alpha,tooling}.md', ['docs/alpha.md', 'docs/tooling.md'], true],
    ]);
  });

  it('leaves a separator-less pattern unexpanded — the residue it shares with its siblings', () => {
    assert.deepEqual(cited({ 'check-ref': 'every *.md in the tree' }), []);
    // The brace form is the one that REACHES the separator-less guard: the
    // leading-star form loses its star to the emphasis strip first and never
    // gets there, so both spellings are pinned rather than one standing in for
    // the other.
    assert.deepEqual(cited({ 'check-ref': 'every {alpha,tooling}.md in the tree' }), []);
  });

  it('reads a comma as a separator, so an unspaced pair contributes both edges', () => {
    // The directory segments admit a comma, so this arrives as ONE token; the
    // split is what keeps the second citation from vanishing into the first.
    const row = { 'check-ref': 'see packages/alpha/x.js,scripts/y.js' };
    assert.deepEqual(cited(row), [
      ['packages/alpha/x.js', ['packages/alpha/x.js'], false],
      ['scripts/y.js', ['scripts/y.js'], false],
    ]);
  });

  it('reads through Markdown emphasis to the citation inside it', () => {
    // The leading run is emphasis, not a pattern segment: the edge it carries
    // must survive, exactly as the citation gate reads the same token.
    const row = { 'check-ref': 'guarded by **packages/alpha/x.js**' };
    assert.deepEqual(cited(row), [['packages/alpha/x.js', ['packages/alpha/x.js'], false]]);
  });

  it('reads a Markdown link’s label as the citation it is, brackets and all', () => {
    // No segment of the shape admits a bracket, so the label names the file
    // rather than arriving welded to the bracket before it — which resolves
    // against no tracked path and would drop the edge entirely.
    assert.deepEqual(cited({ 'check-ref': 'held by [README.md] alone' }), [
      ['README.md', ['README.md'], false],
    ]);
    assert.deepEqual(cited({ 'check-ref': 'held by [README.md](README.md)' }), [
      ['README.md', ['README.md'], false],
    ]);
  });

  it('names nothing for a pattern that matches no tracked file, or does not compile', () => {
    assert.deepEqual(cited({ 'check-ref': 'guarded by docs/gone/*.md' }), []);
    assert.deepEqual(cited({ 'check-ref': 'guarded by docs/{alpha.md' }), []);
    assert.deepEqual(cited({ 'check-ref': 'guarded by do**cs/alpha.md' }), []);
  });
});

describe('auditClauseGovernance', () => {
  it('passes a citation whose cited file is governed by the clause doc', () => {
    const r = audit({
      clauses: [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see packages/alpha/x.js' }],
    });
    assert.equal(r.citations, 1);
    assert.equal(r.exempted, 0, 'nothing here leans on a recorded exception');
    assert.deepEqual(r.newMisses, []);
    assert.deepEqual(r.staleAllowlist, []);
  });

  it('reports both halves of an unspaced comma pair as their own citations', () => {
    const r = audit({
      clauses: [
        {
          doc: 'docs/repowide.md',
          clause: 'RW-1',
          'check-ref': 'see packages/alpha/x.js,scripts/y.js',
        },
      ],
    });
    assert.equal(r.citations, 2, 'one token, two citations');
    assert.deepEqual(r.newMisses, [
      'RW-1 (docs/repowide.md) -> packages/alpha/x.js',
      'RW-1 (docs/repowide.md) -> scripts/y.js',
    ]);
  });

  it('flags a citation whose cited file omits the clause doc', () => {
    const r = audit({
      clauses: [{ doc: 'docs/tooling.md', clause: 'TL-1', 'check-ref': 'see packages/alpha/x.js' }],
    });
    assert.deepEqual(r.newMisses, ['TL-1 (docs/tooling.md) -> packages/alpha/x.js']);
  });

  it('does NOT credit a repo-wide doc — it must couple through an area', () => {
    const r = audit({
      clauses: [
        { doc: 'docs/repowide.md', clause: 'RW-1', 'check-ref': 'see packages/alpha/x.js' },
      ],
    });
    assert.deepEqual(r.newMisses, ['RW-1 (docs/repowide.md) -> packages/alpha/x.js']);
  });

  it('honours an allowlisted coupling (no miss) and marks it hit', () => {
    const r = audit({
      clauses: [{ doc: 'docs/tooling.md', clause: 'TL-1', 'check-ref': 'see packages/alpha/x.js' }],
      allowlist: new Map([['TL-1\tpackages/alpha/x.js', 'recorded reason']]),
    });
    assert.deepEqual(r.newMisses, []);
    assert.deepEqual(r.staleAllowlist, []);
    assert.deepEqual(
      [r.citations, r.exempted],
      [1, 1],
      'the token leans on the exception, so it is not counted as resolving',
    );
  });

  it('flags a stale allowlist entry whose coupling now resolves', () => {
    const r = audit({
      clauses: [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see packages/alpha/x.js' }],
      allowlist: new Map([['AL-1\tpackages/alpha/x.js', 'no longer needed — AL-1 is covered']]),
    });
    assert.deepEqual(r.newMisses, []);
    assert.deepEqual(r.staleAllowlist, ['AL-1\tpackages/alpha/x.js']);
  });

  it('flags a stale allowlist entry whose citation is gone entirely', () => {
    const r = audit({
      clauses: [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see packages/alpha/x.js' }],
      allowlist: new Map([['ZZ-9\tpackages/alpha/x.js', 'clause ZZ-9 was retired']]),
    });
    assert.deepEqual(r.staleAllowlist, ['ZZ-9\tpackages/alpha/x.js']);
  });

  it('resolves a // see pointer when crediting governance', () => {
    const r = audit({
      clauses: [{ doc: 'docs/tooling.md', clause: 'TL-1', 'check-ref': 'see packages/alpha/x.js' }],
      contents: { 'packages/alpha/x.js': '// see docs/tooling.md\ncode();\n' },
    });
    assert.deepEqual(r.newMisses, []); // the pointer pulls docs/tooling.md into governance
  });

  it('handles a registry with no clauses array', () => {
    const r = audit({ clauses: undefined });
    assert.equal(r.citations, 0);
    assert.deepEqual(r.newMisses, []);
    assert.deepEqual(r.staleAllowlist, []);
  });
});

describe('auditClauseGovernance — citations naming files by pattern', () => {
  it('holds every file a mid-path glob names, and counts the token once', () => {
    // The glob names all three docs: the citing doc governs itself, and the
    // other two do not owe it — so ONE finding names the pattern and both.
    const r = audit({
      clauses: [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see docs/*.md' }],
    });
    assert.equal(r.citations, 1, 'a pattern token is one citation, whatever it names');
    assert.deepEqual(r.newMisses, ['AL-1 (docs/alpha.md) -> docs/*.md (uncovered: docs/tooling.md, docs/repowide.md)']); // prettier-ignore
  });

  it('passes a pattern whose every file is governed by the citing doc', () => {
    const map = makeMap({
      areas: {
        alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md'] },
        tooling: { code: ['scripts/**'], docs: ['docs/alpha.md'] },
      },
    });
    const r = audit({
      clauses: [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see packages/alpha/*.js' }],
      map,
    });
    assert.deepEqual(r.newMisses, []);
    assert.equal(r.citations, 1);
  });

  it('honours an exception recorded for the pattern token, over the whole set it names', () => {
    // The key is the citation token the check reports, so one entry answers
    // for every file that pattern names — the set as it stands, and what the
    // tree grows under it later.
    const clauses = [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see docs/*.md' }];
    const r = audit({ clauses, allowlist: new Map([['AL-1\tdocs/*.md', 'recorded reason']]) });
    assert.deepEqual(r.newMisses, []);
    assert.deepEqual(r.staleAllowlist, []);
    assert.deepEqual(
      [r.citations, r.exempted],
      [1, 1],
      'the exempted count is in tokens too — one pattern the exception answers for is one',
    );
  });

  it('leaves an entry keyed by a file inside the set unhit — the citation is what is keyed', () => {
    const clauses = [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see docs/*.md' }];
    const r = audit({
      clauses,
      allowlist: new Map([['AL-1\tdocs/repowide.md', 'recorded for one file']]),
    });
    assert.deepEqual(r.newMisses, ['AL-1 (docs/alpha.md) -> docs/*.md (uncovered: docs/tooling.md, docs/repowide.md)']); // prettier-ignore
    assert.deepEqual(r.staleAllowlist, ['AL-1\tdocs/repowide.md']);
  });

  it('leaves a pattern-token entry stale when the set resolves on its own governance', () => {
    // Coverage is computed before the key is consulted, so an exception that
    // is no longer needed reads as stale rather than as a token it answered
    // for — which is what "stale" has always meant here.
    const map = makeMap({
      areas: {
        alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md'] },
        tooling: { code: ['scripts/**'], docs: ['docs/alpha.md'] },
      },
    });
    const r = audit({
      clauses: [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see packages/alpha/*.js' }],
      map,
      allowlist: new Map([['AL-1\tpackages/alpha/*.js', 'no longer needed']]),
    });
    assert.deepEqual(r.newMisses, []);
    assert.deepEqual(r.staleAllowlist, ['AL-1\tpackages/alpha/*.js']);
    assert.deepEqual([r.citations, r.exempted], [1, 0]);
  });

  it('contributes no edge for a match-less, uncompilable, or separator-less pattern', () => {
    // `{alpha,tooling}.md` is the separator-less case that actually reaches the
    // guard; `*.md` loses its star to the emphasis strip before it gets there.
    for (const ref of [
      'see docs/gone/*.md',
      'see docs/{alpha.md',
      'see *.md',
      'see {alpha,tooling}.md',
    ]) {
      const r = audit({
        clauses: [{ doc: 'docs/tooling.md', clause: 'TL-1', 'check-ref': ref }],
      });
      assert.deepEqual([r.citations, r.newMisses], [0, []], ref);
    }
  });
});

describe('auditClauseGovernance — governance declared by the map', () => {
  // A cited file whose governing set comes from a `declared-governance` entry
  // rather than its covering area: the credit must follow the DECLARED set, in
  // both the literal and the area-reference form the map can write it in.
  const CITATION = [
    { doc: 'docs/tooling.md', clause: 'TL-1', 'check-ref': 'see packages/alpha/x.js' },
  ];
  const MISS = ['TL-1 (docs/tooling.md) -> packages/alpha/x.js'];
  const declMap = (governedBy) =>
    makeMap({
      'declared-governance': [
        { path: 'packages/alpha/x.js', reason: 'a declared suite', 'governed-by': governedBy },
      ],
    });

  it('credits a declaration that names the citing doc as a literal path', () => {
    // The file's covering area (alpha) supplies docs/alpha.md only; the
    // declaration is what puts the citing doc in its governing set.
    assert.deepEqual(audit({ clauses: CITATION, map: declMap(['docs/tooling.md']) }).newMisses, []);
  });

  it('flags a declaration whose literal paths omit the citing doc', () => {
    assert.deepEqual(audit({ clauses: CITATION, map: declMap(['docs/alpha.md']) }).newMisses, MISS);
  });

  it('credits a declaration that reaches the citing doc through an area reference', () => {
    assert.deepEqual(audit({ clauses: CITATION, map: declMap(['area:tooling']) }).newMisses, []);
  });

  it('flags an area reference whose expansion omits the citing doc', () => {
    assert.deepEqual(audit({ clauses: CITATION, map: declMap(['area:alpha']) }).newMisses, MISS);
  });
});

describe('baseline lock (real tree)', () => {
  it('the committed allowlist is exactly the current couplings — no new miss, none stale', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const registry = JSON.parse(readFileSync('docs/clause-registry.json', 'utf8'));
    const map = JSON.parse(readFileSync('scripts/area-map.json', 'utf8'));
    const readFile = (f) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    };
    const r = auditClauseGovernance({ registry, map, files, readFile, allowlist: ALLOWLIST });
    assert.deepEqual(
      r.newMisses,
      [],
      'a clause cites a file whose governance omits its doc — close the edge or record it in the ALLOWLIST',
    );
    assert.deepEqual(
      r.staleAllowlist,
      [],
      'an ALLOWLIST entry is stale (its coupling now resolves) — remove it',
    );
  });
});
