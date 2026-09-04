/**
 * check-ci-filter.test.js — Unit tests for the CI path-filter admission test
 * (scripts/check-ci-filter.js) that gates CI. The test.yml filter split is a
 * committed contract, so every way it can rot must fail loud: these tests prove
 * each red path fires on synthetic input (missing/extraneous buildScripts, a
 * heavy job on the broad `ci` bucket, wrong ciCore globs, a missing schema gate,
 * a broken produce/diff co-fire, a gate on a filter the `changes` block never
 * defines, a broken hop between the filter map and the `changes` job's outputs,
 * a literal filter entry naming no tracked file, a clause-registry document the
 * `suiteHeld` filter omits) and that the closure resolver follows the npm-run
 * and compound-command forms. The two inputs standing for state outside the
 * workflow — the tracked-file predicate and the registry's document list — are
 * proven required rather than defaulted. A real-tree lock proves the shipped
 * test.yml satisfies the contract, over the shipped tree and the shipped
 * registry, with each of those inputs observed on its own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CI_CORE_GLOBS,
  GLOB_CHARS,
  jobFlags,
  jobSteps,
  heavyJobs,
  entryFilesFromCommand,
  computeBuildClosure,
  evaluateContract,
  pathsFilterStep,
  loadWorkflow,
} from '../../../../scripts/check-ci-filter.js';
import { trackedFilesUnder } from '../../../../scripts/check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** Build a job `if:` string from a flag list (+ the usual event OR-terms). */
function ifFrom(flags) {
  return [
    ...flags.map((f) => `needs.changes.outputs.${f} == 'true'`),
    "github.event_name == 'push'",
  ].join(' ||\n');
}

/**
 * The filter map the compliant baseline states. Every flag the baseline jobs
 * gate on is defined here: a gate on a filter the `changes` block never defines
 * is itself a violation (invariant 6).
 */
function defaultFilters() {
  return {
    extension: ['packages/extension/**'],
    desktop: ['packages/desktop/**'],
    shared: ['packages/shared/**'],
    schema: ['schemas/**'],
    referenceServer: ['reference-implementations/**'],
    corpus: ['corpus/**'],
    releasePipeline: ['.github/workflows/publish.yml'],
    contractDocs: ['.github/CONTRIBUTING.md'],
    dispositionWorkflow: ['.github/workflows/docs-disposition.yml'],
    suiteHeld: ['docs/a.md', 'docs/b.md'],
    ciCore: [...CI_CORE_GLOBS],
    buildScripts: ['scripts/a.js', 'scripts/b.js'],
    ci: ['scripts/**', '.c8rc.json'],
  };
}

/**
 * The files git tracks in the fixture's tree: every glob-free entry the
 * baseline filters state. A filter override that adds a literal beyond this set
 * names no tracked file, which is how invariant 8's red path is driven.
 */
const FIXTURE_FILES = new Set(
  Object.values(defaultFilters())
    .flat()
    .filter((entry) => !GLOB_CHARS.test(entry)),
);

/** A minimal well-formed workflow + filter map that satisfies every invariant. */
function makeWorkflow(overrides = {}) {
  const jobFlagsMap = {
    'unit-tests': ['extension', 'desktop', 'shared', 'schema', 'referenceServer', 'corpus', 'ci', 'ciCore', 'releasePipeline', 'contractDocs', 'dispositionWorkflow', 'suiteHeld'], // prettier-ignore
    'extension-e2e-tests': ['extension', 'shared', 'schema', 'referenceServer', 'corpus', 'ciCore', 'buildScripts'], // prettier-ignore
    'desktop-rust-tests': ['desktop', 'shared', 'corpus', 'schema', 'ciCore', 'buildScripts'],
    'desktop-corpus-diff': ['desktop', 'shared', 'corpus', 'schema', 'ciCore', 'buildScripts'],
    'desktop-vectors-produce': ['desktop', 'shared', 'corpus', 'ciCore', 'buildScripts'],
    'desktop-vectors-diff': ['desktop', 'shared', 'corpus', 'ciCore', 'buildScripts'],
    'desktop-cross-compile': ['desktop', 'shared', 'ciCore'],
    'desktop-integration-tests': ['desktop', 'shared', 'schema', 'referenceServer', 'ciCore', 'buildScripts'], // prettier-ignore
    'reference-server-tests': ['referenceServer', 'schema', 'shared', 'ciCore', 'buildScripts', 'releasePipeline'], // prettier-ignore
  };
  const filters = { ...defaultFilters(), ...(overrides.filters || {}) };
  const jobs = {
    changes: {
      // One output per filter, each binding its own name through the filter
      // step's own id — the hop invariant 7 walks.
      outputs: Object.fromEntries(
        Object.keys(filters).map((f) => [f, `\${{ steps.filter.outputs.${f} }}`]),
      ),
      steps: [
        { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' },
        { id: 'filter', uses: 'dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d' },
      ],
    },
    lint: { needs: ['changes'] },
  };
  for (const [id, flags] of Object.entries(jobFlagsMap)) jobs[id] = { if: ifFrom(flags) };
  const wf = { jobs, ...(overrides.wf || {}) };
  const closure = overrides.closure || new Set(['scripts/a.js', 'scripts/b.js']);
  const isTracked = overrides.isTracked || ((p) => FIXTURE_FILES.has(p));
  // Derived from the MERGED filters: a case that wants the registry to outrun
  // the flag deletes `filters.suiteHeld` after construction; an override of
  // `{ suiteHeld: undefined }` reaches invariant 8 first and throws there
  // instead of exercising invariant 9.
  const registryDocs = overrides.registryDocs || [...(filters.suiteHeld || [])];
  return { wf, filters, closure, isTracked, registryDocs };
}

/** Evaluate the fixture with the overrides applied — the short form of a case. */
function evaluate(overrides = {}) {
  return evaluateContract(makeWorkflow(overrides));
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

  it('fires when unit-tests does not gate on releasePipeline', () => {
    // The disposition suite unit-tests runs reads committed files rather than
    // executing them — both publish workflows, and the contributor contract
    // files whose governance-line copies it pins to the check's own constant;
    // without this flag a PR touching only one of them skips the very suite
    // welding it.
    const base = withJobFlags(makeWorkflow(), 'unit-tests', [
      'extension',
      'desktop',
      'shared',
      'schema',
      'referenceServer',
      'corpus',
      'ci',
      'ciCore',
      'suiteHeld',
    ]);
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('unit-tests') && p.includes('`releasePipeline`')));
  });

  it('fires when unit-tests does not gate on contractDocs', () => {
    // The disposition suite unit-tests runs reads the contributor contract
    // files as files, holding their governance-line copies to the check's own
    // constant; no other job's suite reads them, so without this flag a PR
    // touching one alone skips the very suite welding it.
    const base = withJobFlags(makeWorkflow(), 'unit-tests', [
      'extension',
      'desktop',
      'shared',
      'schema',
      'referenceServer',
      'corpus',
      'ci',
      'ciCore',
      'releasePipeline',
      'dispositionWorkflow',
      'suiteHeld',
    ]);
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('unit-tests') && p.includes('`contractDocs`')));
  });

  it('fires when unit-tests does not gate on dispositionWorkflow', () => {
    // The release-guard suite unit-tests runs reads docs-disposition.yml as a
    // file, holding its guard step's env block to the inputs the head-ref
    // derivation is written against; no other flag watches that workflow, so
    // without this one a PR touching it alone skips the suite holding it.
    const base = withJobFlags(makeWorkflow(), 'unit-tests', [
      'extension',
      'desktop',
      'shared',
      'schema',
      'referenceServer',
      'corpus',
      'ci',
      'ciCore',
      'releasePipeline',
      'contractDocs',
      'suiteHeld',
    ]);
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('unit-tests') && p.includes('`dispositionWorkflow`')),
    );
  });

  it('fires when unit-tests does not gate on suiteHeld', () => {
    // The files that flag names are ones a suite or a step of this job asserts
    // over, in a way no always-on gate holds; without the flag an edit to one
    // reds this job on the push run to `main` instead of on the PR.
    const base = withJobFlags(makeWorkflow(), 'unit-tests', [
      'extension',
      'desktop',
      'shared',
      'schema',
      'referenceServer',
      'corpus',
      'ci',
      'ciCore',
      'releasePipeline',
      'contractDocs',
      'dispositionWorkflow',
    ]);
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('unit-tests') && p.includes('`suiteHeld`')));
  });

  it('fires when unit-tests does not gate on referenceServer', () => {
    // Its shared suite walks reference-implementations/ for the
    // resolution-procedure tokens no shipped file may carry — a holding the
    // heavy jobs that flag reaches do not carry.
    const base = withJobFlags(makeWorkflow(), 'unit-tests', [
      'extension',
      'desktop',
      'shared',
      'schema',
      'corpus',
      'ci',
      'ciCore',
      'releasePipeline',
      'contractDocs',
      'dispositionWorkflow',
      'suiteHeld',
    ]);
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('unit-tests') && p.includes('`referenceServer`')));
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

describe('evaluateContract — invariant 6 (every gated flag is a defined filter)', () => {
  it('fires when a job gates on a flag the `changes` block does not define', () => {
    // A gate on an undefined filter reads as a well-formed condition and is
    // always false: the job silently never fires for the input it watches.
    const base = withJobFlags(makeWorkflow(), 'desktop-cross-compile', [
      'desktop',
      'shared',
      'ciKore',
    ]);
    const problems = evaluateContract(base);
    assert.ok(
      problems.some(
        (p) =>
          p.includes('desktop-cross-compile') &&
          p.includes('`ciKore`') &&
          p.includes('does not define'),
      ),
      problems.join('\n'),
    );
  });

  it('holds every job, not only the heavy ones', () => {
    const base = makeWorkflow();
    base.wf.jobs['unit-tests'] = { if: ifFrom(['ci', 'ciKore']) };
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('unit-tests') && p.includes('`ciKore`')),
      problems.join('\n'),
    );
  });
});

describe('evaluateContract — invariant 7 (the flag hops through the changes job)', () => {
  it('fires when a defined filter has no output', () => {
    // Nothing can gate on a filter the `changes` job never exports.
    const base = makeWorkflow();
    delete base.wf.jobs.changes.outputs.corpus;
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('`corpus`') && p.includes('no output')),
      problems.join('\n'),
    );
  });

  it('fires when an output names no filter', () => {
    const base = makeWorkflow();
    base.wf.jobs.changes.outputs.ghostFlag = '${{ steps.filter.outputs.ghostFlag }}';
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('`ghostFlag`') && p.includes('names no filter')),
      problems.join('\n'),
    );
  });

  it('fires when an output binds another step', () => {
    const base = makeWorkflow();
    base.wf.jobs.changes.outputs.corpus = '${{ steps.other.outputs.corpus }}';
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('`corpus`') && p.includes('`other`')),
      problems.join('\n'),
    );
  });

  it('fires when an output binds another filter of the same step', () => {
    // The gate stays well-formed and follows the other filter's paths: the job
    // stops firing for the files the flag exists to watch.
    const base = makeWorkflow();
    base.wf.jobs.changes.outputs.corpus = '${{ steps.filter.outputs.ci }}';
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('`corpus`') && p.includes('binds the `ci` filter')),
      problems.join('\n'),
    );
  });

  it('fires when an output is not a step-output expression', () => {
    const base = makeWorkflow();
    base.wf.jobs.changes.outputs.corpus = 'true';
    const problems = evaluateContract(base);
    assert.ok(
      problems.some((p) => p.includes('`corpus`') && p.includes('not a step-output expression')),
      problems.join('\n'),
    );
  });

  it('fires when a filter no job gates on is defined', () => {
    // Exported and inert: a flag nothing reads.
    const problems = evaluate({ filters: { ghostFlag: ['docs/a.md'] } });
    assert.ok(
      problems.some((p) => p.includes('`ghostFlag`') && p.includes('no job gates on it')),
      problems.join('\n'),
    );
  });

  it('fires when the workflow defines no changes job', () => {
    const base = makeWorkflow();
    delete base.wf.jobs.changes;
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('no `changes` job')), problems.join('\n')); // prettier-ignore
    assert.equal(problems.length, 1, problems.join('\n'));
  });

  it('fires when the changes job runs no paths-filter step', () => {
    const base = makeWorkflow();
    base.wf.jobs.changes.steps = [{ uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' }]; // prettier-ignore
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('no paths-filter step')), problems.join('\n')); // prettier-ignore
    assert.equal(problems.length, 1, problems.join('\n'));
  });

  it('fires when the paths-filter step declares no id', () => {
    const base = makeWorkflow();
    delete base.wf.jobs.changes.steps[1].id;
    const problems = evaluateContract(base);
    assert.ok(problems.some((p) => p.includes('declares no `id`')), problems.join('\n')); // prettier-ignore
    assert.equal(problems.length, 1, problems.join('\n'));
  });
});

describe('evaluateContract — invariant 8 (literal entries git tracks)', () => {
  it('fires when a literal filter entry names no tracked file', () => {
    // A literal entry is one rename away from matching nothing, silently.
    const problems = evaluate({
      filters: { contractDocs: ['.github/CONTRIBUTING.md', '.github/CONTRIBUTING_GONE.md'] },
    });
    assert.ok(
      problems.some(
        (p) => p.includes('`contractDocs`') && p.includes('.github/CONTRIBUTING_GONE.md'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when a literal entry names a directory rather than a file', () => {
    // A directory can exist on disk and still match nothing in the paths
    // filter, so what the entry is held to is trackedness as a FILE.
    const problems = evaluate({
      filters: { contractDocs: ['.github/CONTRIBUTING.md', 'docs'] },
    });
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`contractDocs`') && p.includes('`docs`') && p.includes('not a tracked file'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when a literal entry carries a trailing slash', () => {
    // `docs/a.md/` names no tracked file: what git tracks is the path without
    // the slash, and the paths filter matches nothing on the slashed form.
    const problems = evaluate({
      filters: { contractDocs: ['.github/CONTRIBUTING.md', 'docs/a.md/'] },
    });
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`contractDocs`') &&
          p.includes('`docs/a.md/`') &&
          p.includes('not a tracked file'),
      ),
      problems.join('\n'),
    );
  });

  it("the literal/glob split is the filter action's glob alphabet, character by character", () => {
    for (const char of ['*', '?', '[', ']', '{', '}', '!'])
      assert.ok(GLOB_CHARS.test(`docs/a${char}.md`), char);
    assert.ok(!GLOB_CHARS.test('docs/guides/ci.md'));
    assert.ok(!GLOB_CHARS.test('.github/workflows/test.yml'));
  });

  it('leaves glob entries alone — the predicate is never asked about one', () => {
    const asked = [];
    const problems = evaluate({
      isTracked: (path) => {
        asked.push(path);
        return FIXTURE_FILES.has(path);
      },
    });
    assert.deepEqual(problems, []);
    assert.ok(asked.includes('.github/CONTRIBUTING.md'), asked.join(', '));
    assert.ok(!asked.some((path) => GLOB_CHARS.test(path)), asked.join(', '));
  });
});

describe('jobSteps — the step reader this check and check-doc-closure.js share', () => {
  it('answers the job’s own steps, whole and in order', () => {
    const steps = [{ uses: 'actions/checkout@abc' }, { run: 'npm ci' }, { run: 'npm test' }];
    assert.deepEqual(jobSteps({ steps }), steps);
  });

  it('answers an empty list for a job that is absent, runs no steps, or states `steps:` as a non-list', () => {
    assert.deepEqual(jobSteps(undefined), []);
    assert.deepEqual(jobSteps({}), []);
    assert.deepEqual(jobSteps({ steps: 'not a list' }), []);
  });

  it('answers an empty list for a `steps:` block written as a mapping', () => {
    // A mapping parses to a plain object, which is not iterable — a walk
    // reading `job.steps ?? []` ends its run in a type error on this input;
    // reading through the accessor is what survives it.
    assert.deepEqual(jobSteps({ steps: { setup: { run: 'npm ci' } } }), []);
  });
});

describe('pathsFilterStep — the one locator both filter-map readers use', () => {
  const step = (uses) => ({ uses });

  it('finds the filter step by its `uses:` substring, whatever the owner', () => {
    const job = { steps: [step('actions/checkout@abc'), step('acme/paths-filter-fork@v1')] };
    assert.equal(pathsFilterStep(job).uses, 'acme/paths-filter-fork@v1');
  });

  it('answers undefined for a job that is absent, runs no steps, or runs no filter step', () => {
    assert.equal(pathsFilterStep(undefined), undefined);
    assert.equal(pathsFilterStep({}), undefined);
    assert.equal(pathsFilterStep({ steps: 'not a list' }), undefined);
    assert.equal(pathsFilterStep({ steps: [{ uses: 42 }, { run: 'echo' }] }), undefined);
  });
});

describe('evaluateContract — invariant 9 (the clause registry is a suiteHeld subset)', () => {
  it('fires when a document the registry names is absent from suiteHeld', () => {
    // The preamble suite holds that carrier's registry link as raw text, so a
    // carrier the flag omits reds unit-tests on `main` alone.
    const problems = evaluate({ registryDocs: ['docs/a.md', 'docs/b.md', 'docs/c.md'] });
    assert.ok(
      problems.some((p) => p.includes('docs/c.md') && p.includes('`suiteHeld`')),
      problems.join('\n'),
    );
  });

  it('fires for every registry document when suiteHeld is not defined at all', () => {
    const base = makeWorkflow();
    delete base.filters.suiteHeld;
    const problems = evaluateContract(base);
    for (const doc of base.registryDocs) {
      assert.ok(
        problems.some((p) => p.includes(doc) && p.includes('`suiteHeld`')),
        `${doc}: ${problems.join('\n')}`,
      );
    }
  });
});

describe('evaluateContract — the inputs it refuses to default', () => {
  it('throws when isTracked is missing', () => {
    const { wf, filters, closure, registryDocs } = makeWorkflow();
    assert.throws(() => evaluateContract({ wf, filters, closure, registryDocs }), {
      name: 'TypeError',
      message: 'evaluateContract: isTracked is required',
    });
  });

  it('throws when registryDocs is missing', () => {
    const { wf, filters, closure, isTracked } = makeWorkflow();
    assert.throws(() => evaluateContract({ wf, filters, closure, isTracked }), {
      name: 'TypeError',
      message: 'evaluateContract: registryDocs is required',
    });
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

/**
 * The shipped tree as git tracks it, built the way `run()` builds the same
 * predicate: the shared population reader, read once over the repository root.
 */
const REAL_TRACKED = new Set(trackedFilesUnder('.', { cwd: ROOT }));
const REAL_IS_TRACKED = (path) => REAL_TRACKED.has(path);

/** The documents the shipped clause registry's prefix map names. */
const REAL_REGISTRY_DOCS = Object.values(
  JSON.parse(readFileSync(resolve(ROOT, 'docs/clause-registry.json'), 'utf8')).prefixes,
);

/** The committed workflow, its filter map, and its computed script closure. */
function realInputs() {
  const { wf, filters } = loadWorkflow();
  const scripts = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts || {};
  return { wf, filters, closure: computeBuildClosure(wf, scripts) };
}

describe('real-tree lock', () => {
  it('the shipped test.yml satisfies the path-filter contract', () => {
    assert.deepEqual(
      evaluateContract({
        ...realInputs(),
        isTracked: REAL_IS_TRACKED,
        registryDocs: REAL_REGISTRY_DOCS,
      }),
      [],
      'scripts/check-ci-filter.js must pass on the committed test.yml',
    );
  });

  it('the predicate the lock passes answers for the shipped tree', () => {
    assert.equal(REAL_IS_TRACKED('docs/ghost.md'), false);
    // A directory that exists on disk, and is no tracked file.
    assert.equal(REAL_IS_TRACKED('docs'), false);
    assert.equal(REAL_IS_TRACKED('README.md'), true);
  });

  it("the registry list the lock passes is the shipped registry's own documents", () => {
    assert.ok(REAL_REGISTRY_DOCS.includes('docs/api/dispatch.md'), REAL_REGISTRY_DOCS.join(', '));
    for (const doc of REAL_REGISTRY_DOCS) assert.ok(REAL_IS_TRACKED(doc), doc);
  });

  it('reds on the committed workflow when no literal entry resolves', () => {
    const inputs = realInputs();
    const literals = Object.values(inputs.filters)
      .flat()
      .filter((entry) => !GLOB_CHARS.test(entry));
    assert.ok(literals.length, 'the committed filter map states literal entries');
    const problems = evaluateContract({
      ...inputs,
      isTracked: () => false,
      registryDocs: REAL_REGISTRY_DOCS,
    });
    for (const entry of literals) {
      assert.ok(problems.some((p) => p.includes(entry)), `${entry}: ${problems.join('\n')}`); // prettier-ignore
    }
  });

  it('reds on the committed workflow when the registry names one more document', () => {
    const problems = evaluateContract({
      ...realInputs(),
      isTracked: REAL_IS_TRACKED,
      registryDocs: [...REAL_REGISTRY_DOCS, 'docs/ghost.md'],
    });
    assert.ok(
      problems.some((p) => p.includes('docs/ghost.md') && p.includes('`suiteHeld`')),
      problems.join('\n'),
    );
  });

  it('the buildScripts closure is exactly the scripts the heavy jobs run', () => {
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
