/**
 * check-clause-registry.test.js — Unit tests for the clause-registry parity
 * check (scripts/check-clause-registry.js) that gates CI. Docs state clauses
 * as bold stable identifiers (**CP-3.**) and docs/clause-registry.json records
 * how each is verified; these tests prove every way the pairing can rot fails
 * loud: unregistered markers, one-sided clauses, missing justifications or
 * check-refs, check-refs naming dead scripts, and reuse of retired ids. The
 * AST cases prove a marker quoted in a fenced code block is never counted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClauseMarkers,
  extractCheckRefTargets,
  auditClauseRegistry,
} from '../../../../scripts/check-clause-registry.js';

/** A minimal consistent registry + doc pair, for overriding per test. */
function makeRegistry(overrides = {}) {
  return {
    description: 'test registry',
    prefixes: { TP: 'docs/testable.md' },
    retired: { TP: [] },
    clauses: [
      {
        doc: 'docs/testable.md',
        clause: 'TP-1',
        tag: 'judgment-only',
        justification: 'a person decides',
      },
      {
        doc: 'docs/testable.md',
        clause: 'TP-2',
        tag: 'check-exists',
        'check-ref': 'Guarded by scripts/real-check.js via npm run real:check.',
      },
    ],
    ...overrides,
  };
}

const BASE_DOC = '# Testable\n\n**TP-1.** First rule.\n\n**TP-2.** Second rule.\n';

function audit({
  registry = makeRegistry(),
  files = ['docs/testable.md', 'scripts/real-check.js', 'package.json'],
  contents = { 'docs/testable.md': BASE_DOC },
  packageScripts = ['real:check'],
} = {}) {
  return auditClauseRegistry({
    registry,
    files,
    readFile: (f) => contents[f] ?? null,
    packageScripts,
  });
}

const flatten = (r) => Object.values(r).flat();

describe('extractClauseMarkers', () => {
  it('extracts bold identifier-period markers in order', () => {
    assert.deepEqual(extractClauseMarkers(BASE_DOC), ['TP-1', 'TP-2']);
  });

  it('does not match prose mentions without a number or period', () => {
    const md = 'Each rule carries an identifier (**CP-n**), and **CP-1** is bold prose.\n';
    assert.deepEqual(extractClauseMarkers(md), []);
  });

  it('does not match a marker quoted inside a fenced code block (AST correctness)', () => {
    const md = 'Example:\n\n```md\n**TP-9.** quoted, not stated\n```\n\n**TP-1.** real.\n';
    assert.deepEqual(extractClauseMarkers(md), ['TP-1']);
  });

  it('preserves duplicates so callers can flag them', () => {
    assert.deepEqual(extractClauseMarkers('**TP-1.** a\n\n**TP-1.** again\n'), ['TP-1', 'TP-1']);
  });
});

describe('extractCheckRefTargets', () => {
  it('pulls script paths and npm run names out of prose', () => {
    const ref =
      'Intended: scripts/next-check.js. Interim probe: scripts/other.js via npm run corpus:check and npm run lint.';
    assert.deepEqual(extractCheckRefTargets(ref), {
      scriptPaths: ['scripts/next-check.js', 'scripts/other.js'],
      npmScripts: ['corpus:check', 'lint'],
      filePaths: [],
    });
  });
});

describe('auditClauseRegistry — green path', () => {
  it('reports nothing when docs and registry agree', () => {
    assert.deepEqual(flatten(audit()), []);
  });
});

describe('auditClauseRegistry — marker/registry parity', () => {
  it('flags a doc clause the registry has no row for', () => {
    const contents = { 'docs/testable.md': BASE_DOC + '\n**TP-3.** Unregistered rule.\n' };
    const r = audit({ contents });
    assert.deepEqual(r.markerErrors, [
      'docs/testable.md states clause "TP-3" but the registry has no row for it',
    ]);
  });

  it('flags a registry row whose clause the doc no longer states', () => {
    const contents = { 'docs/testable.md': '# Testable\n\n**TP-1.** Only rule now.\n' };
    const r = audit({ contents });
    assert.deepEqual(r.markerErrors, [
      'registry has a row for "TP-2" but docs/testable.md states no such clause',
    ]);
  });

  it('flags a marker with an unregistered prefix — in any tracked Markdown file', () => {
    const r = audit({
      files: ['docs/testable.md', 'docs/newcomer.md', 'scripts/real-check.js', 'package.json'],
      contents: {
        'docs/testable.md': BASE_DOC,
        'docs/newcomer.md': '**ZZ-1.** A clause nobody registered.\n',
      },
    });
    assert.deepEqual(r.markerErrors, [
      'docs/newcomer.md states clause "ZZ-1" with unregistered prefix "ZZ"',
    ]);
  });

  it("flags a marker sitting outside its prefix's registered doc", () => {
    const r = audit({
      files: ['docs/testable.md', 'docs/elsewhere.md', 'scripts/real-check.js', 'package.json'],
      contents: {
        'docs/testable.md': BASE_DOC,
        'docs/elsewhere.md': '**TP-7.** Stated in the wrong doc.\n',
      },
    });
    assert.deepEqual(r.markerErrors, [
      'docs/elsewhere.md states clause "TP-7" but prefix "TP" registers docs/testable.md',
    ]);
  });

  it('flags the same clause stated twice in one doc', () => {
    const contents = { 'docs/testable.md': BASE_DOC + '\n**TP-2.** Stated again.\n' };
    const r = audit({ contents });
    assert.deepEqual(r.markerErrors, ['docs/testable.md states clause "TP-2" more than once']);
  });
});

describe('auditClauseRegistry — row well-formedness', () => {
  it('flags a judgment-only row with no justification', () => {
    const registry = makeRegistry();
    delete registry.clauses[0].justification;
    const r = audit({ registry });
    assert.deepEqual(r.rowErrors, ['clause "TP-1" is judgment-only but states no justification']);
  });

  it('flags a checkable/check-exists row with no check-ref', () => {
    const registry = makeRegistry();
    delete registry.clauses[1]['check-ref'];
    const r = audit({ registry });
    assert.deepEqual(r.rowErrors, ['clause "TP-2" is check-exists but states no check-ref']);
  });

  it('flags an invalid tag, a duplicate row, and a doc/prefix mismatch', () => {
    const registry = makeRegistry();
    registry.clauses[0].tag = 'someday-maybe';
    registry.clauses.push({ ...registry.clauses[1] });
    registry.clauses.push({
      doc: 'docs/other.md',
      clause: 'TP-3',
      tag: 'judgment-only',
      justification: 'x',
    });
    const contents = { 'docs/testable.md': BASE_DOC + '\n**TP-3.** Third.\n' };
    const r = audit({ registry, contents });
    assert.equal(
      r.rowErrors.some((e) => e.includes('invalid tag')),
      true,
    );
    assert.equal(
      r.rowErrors.some((e) => e.includes('duplicate registry row for clause "TP-2"')),
      true,
    );
    assert.equal(
      r.rowErrors.some((e) =>
        e.includes('clause "TP-3" names doc "docs/other.md" but prefix "TP" registers'),
      ),
      true,
    );
  });
});

describe('auditClauseRegistry — check-ref resolvability', () => {
  it('flags a check-ref naming an untracked script', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Guarded by scripts/imaginary-check.js.';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, [
      'clause "TP-2" check-ref names untracked scripts/imaginary-check.js',
    ]);
  });

  it('flags a check-exists row whose check-ref names nothing runnable', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'A check somewhere in CI guards this.';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, [
      'clause "TP-2" is check-exists but its check-ref names no script, npm run target, or tracked check file',
    ]);
  });

  it('allows a checkable row to describe an intended check in prose', () => {
    const registry = makeRegistry();
    registry.clauses[1].tag = 'checkable';
    registry.clauses[1]['check-ref'] =
      'Intended: a static scan of event registrations (not yet built).';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, []);
  });

  it('flags a check-ref naming a missing npm script', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Run npm run does:not:exist to verify.';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, [
      'clause "TP-2" check-ref names missing npm script "does:not:exist"',
    ]);
  });
});

describe('auditClauseRegistry — retirement', () => {
  it('flags a retired id that still has an active row or marker', () => {
    const registry = makeRegistry({ retired: { TP: ['TP-2'] } });
    const r = audit({ registry });
    assert.equal(
      r.retiredErrors.includes('retired clause "TP-2" has an active registry row'),
      true,
    );
    assert.equal(r.retiredErrors.includes('docs/testable.md states retired clause "TP-2"'), true);
  });

  it('flags retired ids under the wrong or an unregistered prefix', () => {
    const registry = makeRegistry({ retired: { TP: ['XX-1'], QQ: ['QQ-1'] } });
    const r = audit({ registry });
    assert.equal(
      r.retiredErrors.includes('retired id "XX-1" does not belong to prefix "TP"'),
      true,
    );
    assert.equal(r.retiredErrors.includes('retired list for unregistered prefix "QQ"'), true);
  });
});

describe('auditClauseRegistry — shape', () => {
  it('flags a prefix registering an untracked doc', () => {
    const registry = makeRegistry({ prefixes: { TP: 'docs/never-committed.md' } });
    const r = audit({ registry });
    assert.equal(
      r.shapeErrors.includes('prefix "TP" registers untracked doc "docs/never-committed.md"'),
      true,
    );
  });

  it('flags missing top-level structure without throwing', () => {
    const r = audit({ registry: { description: 'x' } });
    assert.notEqual(r.shapeErrors.length, 0);
    assert.deepEqual(r.markerErrors, []);
  });
});

describe('extractCheckRefTargets: tracked check-file paths', () => {
  it('extracts paths under packages/, corpus/, and reference-implementations/', () => {
    const { filePaths } = extractCheckRefTargets(
      'pinned by packages/shared/tests/unit/foo.test.js and corpus/vectors-coverage.json; ' +
        'the server side by reference-implementations/sync-server/tests/integration/bar.test.js',
    );
    assert.deepEqual(filePaths, [
      'packages/shared/tests/unit/foo.test.js',
      'corpus/vectors-coverage.json',
      'reference-implementations/sync-server/tests/integration/bar.test.js',
    ]);
  });

  it('does not extract from mid-token prefixes', () => {
    const { filePaths, scriptPaths } = extractCheckRefTargets(
      'see sub-packages/foo.js and scripted-truth-corpus/vectors.json and packages/x/scripts/real.js',
    );
    assert.deepEqual(filePaths, ['packages/x/scripts/real.js']);
    assert.deepEqual(scriptPaths, []);
  });

  it('an untracked path reddens a checkable row too', () => {
    const registry = {
      description: 'd',
      prefixes: { T: 'docs/t.md' },
      retired: { T: [] },
      clauses: [
        {
          doc: 'docs/t.md',
          clause: 'T-1',
          tag: 'checkable',
          'check-ref': 'Interim probe: packages/shared/tests/unit/gone.test.js.',
        },
      ],
    };
    const r = auditClauseRegistry({
      registry,
      files: ['docs/t.md'],
      readFile: (f) => (f === 'docs/t.md' ? '**T-1.** rule' : null),
      packageScripts: [],
    });
    assert.equal(r.refErrors.length, 1);
    assert.ok(r.refErrors[0].includes('untracked'));
  });

  it('ignores bare filenames without a directory separator', () => {
    const { filePaths } = extractCheckRefTargets('see foo.test.js and vector-measurement.js');
    assert.deepEqual(filePaths, []);
  });

  it('a tracked file path satisfies check-exists on its own', () => {
    const registry = {
      description: 'd',
      prefixes: { T: 'docs/t.md' },
      retired: { T: [] },
      clauses: [
        {
          doc: 'docs/t.md',
          clause: 'T-1',
          tag: 'check-exists',
          'check-ref': 'pinned by packages/shared/tests/unit/foo.test.js.',
        },
      ],
    };
    const r = auditClauseRegistry({
      registry,
      files: ['docs/t.md', 'packages/shared/tests/unit/foo.test.js'],
      readFile: (f) => (f === 'docs/t.md' ? '**T-1.** rule' : null),
      packageScripts: [],
    });
    assert.deepEqual(r.refErrors, []);
  });

  it('an untracked named check file reddens', () => {
    const registry = {
      description: 'd',
      prefixes: { T: 'docs/t.md' },
      retired: { T: [] },
      clauses: [
        {
          doc: 'docs/t.md',
          clause: 'T-1',
          tag: 'check-exists',
          'check-ref': 'pinned by packages/shared/tests/unit/gone.test.js.',
        },
      ],
    };
    const r = auditClauseRegistry({
      registry,
      files: ['docs/t.md'],
      readFile: (f) => (f === 'docs/t.md' ? '**T-1.** rule' : null),
      packageScripts: [],
    });
    assert.equal(r.refErrors.length, 1);
    assert.ok(r.refErrors[0].includes('untracked packages/shared/tests/unit/gone.test.js'));
  });
});
