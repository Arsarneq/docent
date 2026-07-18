/**
 * check-ci-filter.test.js — Unit tests for the CI path-filter admission test
 * (scripts/check-ci-filter.js) that gates CI. The test.yml filter split is a
 * committed contract, so every way it can rot must fail loud: these tests prove
 * each red path fires on synthetic input (missing/extraneous buildScripts, a
 * heavy job on the broad `ci` bucket, wrong ciCore globs, a missing schema gate,
 * a broken produce/diff co-fire) and that the closure resolver follows the
 * npm-run and compound-command forms. A real-tree lock proves the shipped
 * test.yml satisfies the contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CI_CORE_GLOBS,
  jobFlags,
  heavyJobs,
  entryFilesFromCommand,
  computeBuildClosure,
  evaluateContract,
  loadWorkflow,
} from '../../../../scripts/check-ci-filter.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** Build a job `if:` string from a flag list (+ the usual event OR-terms). */
function ifFrom(flags) {
  return [
    ...flags.map((f) => `needs.changes.outputs.${f} == 'true'`),
    "github.event_name == 'push'",
  ].join(' ||\n');
}

/** A minimal well-formed workflow + filter map that satisfies every invariant. */
function makeWorkflow(overrides = {}) {
  const jobFlagsMap = {
    'unit-tests': ['extension', 'desktop', 'shared', 'schema', 'corpus', 'ci', 'ciCore'],
    'extension-e2e-tests': ['extension', 'shared', 'schema', 'referenceServer', 'corpus', 'ciCore', 'buildScripts'], // prettier-ignore
    'desktop-rust-tests': ['desktop', 'shared', 'corpus', 'schema', 'ciCore', 'buildScripts'],
    'desktop-corpus-diff': ['desktop', 'shared', 'corpus', 'schema', 'ciCore', 'buildScripts'],
    'desktop-vectors-produce': ['desktop', 'shared', 'corpus', 'ciCore', 'buildScripts'],
    'desktop-vectors-diff': ['desktop', 'shared', 'corpus', 'ciCore', 'buildScripts'],
    'desktop-cross-compile': ['desktop', 'shared', 'ciCore'],
    'desktop-integration-tests': ['desktop', 'shared', 'schema', 'referenceServer', 'ciCore', 'buildScripts'], // prettier-ignore
    'reference-server-tests': ['referenceServer', 'schema', 'shared', 'ciCore', 'buildScripts', 'releasePipeline'], // prettier-ignore
  };
  const jobs = { changes: { steps: [] }, lint: { needs: ['changes'] } };
  for (const [id, flags] of Object.entries(jobFlagsMap)) jobs[id] = { if: ifFrom(flags) };
  const wf = { jobs, ...(overrides.wf || {}) };
  const filters = {
    ciCore: [...CI_CORE_GLOBS],
    buildScripts: ['scripts/a.js', 'scripts/b.js'],
    ci: ['scripts/**', '.c8rc.json'],
    ...(overrides.filters || {}),
  };
  const closure = overrides.closure || new Set(['scripts/a.js', 'scripts/b.js']);
  return { wf, filters, closure };
}

/** Replace one job's `if:` flag list in a fresh workflow. */
function withJobFlags(base, id, flags) {
  const wf = { jobs: { ...base.wf.jobs, [id]: { if: ifFrom(flags) } } };
  return { ...base, wf };
}

describe('evaluateContract — compliant baseline', () => {
  it('returns no problems when every invariant holds', () => {
    assert.deepEqual(evaluateContract(makeWorkflow()), []);
  });
});

describe('evaluateContract — invariant 1 (buildScripts set-equality)', () => {
  it('fires when the buildScripts filter is absent', () => {
    const base = makeWorkflow();
    delete base.filters.buildScripts;
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('no `buildScripts` filter')));
  });

  it('fires when a script the heavy jobs run is MISSING from buildScripts', () => {
    // Closure reaches c.js but the filter omits it.
    const base = makeWorkflow({
      closure: new Set(['scripts/a.js', 'scripts/b.js', 'scripts/c.js']),
    });
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('MISSING') && p.includes('scripts/c.js')));
  });

  it('fires when buildScripts lists a script no heavy job reaches', () => {
    const base = makeWorkflow({ filters: { buildScripts: ['scripts/a.js', 'scripts/b.js', 'scripts/z.js'] } }); // prettier-ignore
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('no heavy job reaches') && p.includes('scripts/z.js')),
    );
  });
});

describe('evaluateContract — invariant 2 (no broad ci / ciCore shape)', () => {
  it('fires when a heavy job gates on the broad `ci` flag', () => {
    const base = withJobFlags(makeWorkflow(), 'desktop-rust-tests', [
      'desktop',
      'shared',
      'corpus',
      'schema',
      'ciCore',
      'buildScripts',
      'ci',
    ]);
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('desktop-rust-tests') && p.includes('broad `ci`')));
  });

  it('does NOT flag unit-tests for gating on `ci` (it legitimately keeps scripts/**)', () => {
    // unit-tests already gates on `ci` in the baseline; the baseline is clean.
    assert.deepEqual(evaluateContract(makeWorkflow()), []);
  });

  it('fires when ciCore carries more than the four environment-wide globs', () => {
    const base = makeWorkflow({ filters: { ciCore: [...CI_CORE_GLOBS, '.github/workflows/**'] } });
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('ciCore globs must be exactly')));
  });
});

describe('evaluateContract — invariant 3 (required per-job flags)', () => {
  it('fires when desktop-corpus-diff does not gate on schema', () => {
    const base = withJobFlags(makeWorkflow(), 'desktop-corpus-diff', [
      'desktop',
      'shared',
      'corpus',
      'ciCore',
      'buildScripts',
    ]);
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('desktop-corpus-diff') && p.includes('`schema`')));
  });

  it('fires when desktop-rust-tests does not gate on schema', () => {
    const base = withJobFlags(makeWorkflow(), 'desktop-rust-tests', [
      'desktop',
      'shared',
      'corpus',
      'ciCore',
      'buildScripts',
    ]);
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('desktop-rust-tests') && p.includes('`schema`')));
  });

  it('fires when reference-server-tests does not gate on releasePipeline', () => {
    const base = withJobFlags(makeWorkflow(), 'reference-server-tests', [
      'referenceServer',
      'schema',
      'shared',
      'ciCore',
      'buildScripts',
    ]);
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('reference-server-tests') && p.includes('`releasePipeline`')),
    );
  });

  it('fires when a required job is missing from the workflow', () => {
    const base = makeWorkflow();
    delete base.wf.jobs['desktop-corpus-diff'];
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('desktop-corpus-diff') && p.includes('not found')));
  });
});

describe('evaluateContract — invariant 4 (.github/actions in ciCore)', () => {
  it('fires when ciCore omits .github/actions/**', () => {
    const base = makeWorkflow({
      filters: { ciCore: ['.github/workflows/test.yml', 'package.json', 'package-lock.json'] },
    });
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('.github/actions/**')));
  });
});

describe('evaluateContract — invariant 5 (produce/diff co-fire, both directions)', () => {
  it('fires when a diff job gates on a flag its producer lacks', () => {
    // Give desktop-vectors-diff a `schema` flag its producer does not carry.
    const base = withJobFlags(makeWorkflow(), 'desktop-vectors-diff', [
      'desktop',
      'shared',
      'corpus',
      'schema',
      'ciCore',
      'buildScripts',
    ]);
    const problems = evaluateContract(base);
    assert.ok(
      problems.some(
        (p) => p.includes('desktop-vectors-diff') && p.includes('desktop-vectors-produce'),
      ),
    );
  });

  it('fires when a producer gates on a flag its diff consumer lacks', () => {
    // Narrow the consumer so the producer carries a flag it does not.
    const base = withJobFlags(makeWorkflow(), 'desktop-corpus-diff', [
      'desktop',
      'shared',
      'corpus',
      'schema',
      'ciCore',
    ]);
    const problems = evaluateContract(base);
    assert.ok(
      problems.some(
        (p) =>
          p.includes('desktop-rust-tests') &&
          p.includes('desktop-corpus-diff') &&
          p.includes('buildScripts'),
      ),
    );
  });

  it('fires when a produce/diff pair references a missing job', () => {
    const base = makeWorkflow();
    delete base.wf.jobs['desktop-vectors-produce'];
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('references a missing job')));
  });
});

describe('jobFlags / heavyJobs', () => {
  it('extracts the change flags a job gates on', () => {
    const flags = jobFlags({ if: ifFrom(['desktop', 'schema', 'ciCore']) });
    assert.deepEqual([...flags].sort(), ['ciCore', 'desktop', 'schema']);
  });

  it('treats every path-filtered job except unit-tests as heavy', () => {
    const heavy = Object.keys(heavyJobs(makeWorkflow().wf)).sort();
    assert.ok(!heavy.includes('unit-tests'), 'unit-tests is excluded');
    assert.ok(!heavy.includes('lint'), 'always-on lint (no flags) is excluded');
    assert.ok(!heavy.includes('changes'), 'the changes producer is excluded');
    assert.ok(heavy.includes('desktop-rust-tests') && heavy.includes('reference-server-tests'));
  });
});

describe('entryFilesFromCommand', () => {
  it('resolves npm-run wrappers through package.json', () => {
    const entries = [...entryFilesFromCommand('npm run x', { x: 'node scripts/corpus-compare.js --lint' })]; // prettier-ignore
    assert.equal(entries.length, 1);
    assert.ok(entries[0].endsWith('corpus-compare.js'));
  });

  it('splits compound `&&` commands and finds each node entry', () => {
    const entries = [...entryFilesFromCommand('npm run s && node scripts/x.js', { s: 'node scripts/y.js' })]; // prettier-ignore
    const names = entries.map((e) => e.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, ['x.js', 'y.js']);
  });

  it('ignores non-node tools (cargo, npx, docker)', () => {
    const entries = [...entryFilesFromCommand('cargo test && npx playwright test', {})];
    assert.equal(entries.length, 0);
  });

  it('skips node flags to find the entry (node --test path.test.js)', () => {
    const entries = [...entryFilesFromCommand('node --test packages/x/y.test.js', {})];
    assert.equal(entries.length, 1);
    assert.ok(entries[0].endsWith('y.test.js'));
  });
});

describe('real-tree lock', () => {
  it('the shipped test.yml satisfies the path-filter contract', () => {
    const { wf, filters } = loadWorkflow();
    const scripts = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts || {};
    const closure = computeBuildClosure(wf, scripts);
    assert.deepEqual(
      evaluateContract({ wf, filters, closure }),
      [],
      'scripts/check-ci-filter.js must pass on the committed test.yml',
    );
  });

  it('the buildScripts closure is exactly the nine build-affecting scripts', () => {
    const { wf } = loadWorkflow();
    const scripts = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts || {};
    assert.deepEqual([...computeBuildClosure(wf, scripts)].sort(), [
      'scripts/build-desktop-dist.js',
      'scripts/build-schemas.js',
      'scripts/build-validators.js',
      'scripts/corpus-assemble-desktop-vectors.js',
      'scripts/corpus-assemble-desktop.js',
      'scripts/corpus-compare.js',
      'scripts/inject-shared-views.js',
      'scripts/sufficiency-lint.js',
      'scripts/sync-shared.js',
    ]);
  });
});
