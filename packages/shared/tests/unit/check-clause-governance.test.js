/**
 * check-clause-governance.test.js — Unit tests for the clause-governance check
 * (scripts/check-clause-governance.js) that gates CI. A clause cites the code
 * that implements or guards it; this check holds that citation to a real
 * governance edge — the cited file must owe the clause's doc under the area map.
 * These tests prove every way the edge can rot fails loud (an uncovered
 * citation, a repo-wide doc that does not couple, a stale allowlist entry) and
 * that a deliberately-recorded exception is honoured. A final baseline lock runs
 * the check over the real tree so the committed allowlist stays exactly the
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
  it('extracts directory-qualified and directory-less tracked paths', () => {
    const row = { 'check-ref': 'guard packages/alpha/x.js and README.md' };
    assert.deepEqual(citedPaths(row, tracked), ['packages/alpha/x.js', 'README.md']);
  });
  it('deduplicates repeated citations and drops untracked tokens', () => {
    const row = {
      'check-ref': 'packages/alpha/x.js twice packages/alpha/x.js',
      justification: 'and untracked/z.js',
    };
    assert.deepEqual(citedPaths(row, tracked), ['packages/alpha/x.js']);
  });
  it('reads both check-ref and justification', () => {
    const row = { 'check-ref': 'packages/alpha/x.js', justification: 'scripts/y.js too' };
    assert.deepEqual(citedPaths(row, tracked), ['packages/alpha/x.js', 'scripts/y.js']);
  });
});

describe('auditClauseGovernance', () => {
  it('passes a citation whose cited file is governed by the clause doc', () => {
    const r = audit({
      clauses: [{ doc: 'docs/alpha.md', clause: 'AL-1', 'check-ref': 'see packages/alpha/x.js' }],
    });
    assert.equal(r.citations, 1);
    assert.deepEqual(r.newMisses, []);
    assert.deepEqual(r.staleAllowlist, []);
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
