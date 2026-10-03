/**
 * check-ci-filter.test.js — Unit tests for the CI path-filter admission test
 * (scripts/check-ci-filter.js) that gates CI. The test.yml filter split is a
 * committed contract, so every way it can rot must fail loud: these tests prove
 * each red path fires on synthetic input (missing/extraneous buildScripts, a
 * heavy job on the broad `ci` bucket, wrong ciCore globs, a missing schema gate,
 * a broken produce/diff co-fire, a gate on a filter the `changes` job's
 * paths-filter step never defines, a broken hop between the filter map and the
 * `changes` job's outputs,
 * a literal filter entry naming no tracked file, a clause-registry document the
 * `suiteHeld` filter omits, an entry of a held flag parted from its holdings
 * map, a filter entry stated more than once, a heavy job whose own closure is
 * non-empty gating on no `buildScripts`), the redundancy between the ciCore
 * legs, the command model's forms one by one, and the closure walk over a
 * synthetic tree on disk — the npm-run chain and its cycle guard, a flagged
 * `node` entry, the import and spawn edges, an entry outside scripts/, the
 * forms read as no invocation, and the scripts/-relative over-include. The
 * inputs that stand for state outside the workflow — the per-job closures, the
 * tracked-file predicate and the registry's document list — are proven required
 * rather than defaulted. The step reader and the filter-step locator both
 * filter-map readers share are held on their own, and a holdings map for a flag
 * the filter does not define reds. A real-tree lock proves the shipped test.yml
 * satisfies the contract over the inputs the command line itself reads, with
 * each of those inputs observed on its own; the CI guide's flag bullets and
 * flag-exception sentence are held to citing the holdings maps, and each holder
 * suite's header to naming the map it points at.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CI_CORE_GLOBS,
  GLOB_CHARS,
  HELD_FLAG_HOLDINGS,
  SUITE_HELD_HOLDINGS,
  jobFlags,
  jobSteps,
  heavyJobs,
  entryFilesFromCommand,
  computeBuildClosure,
  evaluateContract,
  pathsFilterStep,
  loadInputs,
} from '../../../../scripts/check-ci-filter.js';
import { blankJsLiterals } from '../../../../scripts/check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** The files the holdings map states a holding for — the `suiteHeld` set. */
const HELD_FILES = Object.keys(SUITE_HELD_HOLDINGS);

/** The files each flag in HELD_FLAG_HOLDINGS states a holding for, by flag. */
const HELD_FLAG_FILES = Object.fromEntries(
  Object.entries(HELD_FLAG_HOLDINGS).map(([flag, map]) => [flag, Object.keys(map)]),
);

/** Build a job `if:` string from a flag list (+ the usual event OR-terms). */
function ifFrom(flags) {
  return [
    ...flags.map((f) => `needs.changes.outputs.${f} == 'true'`),
    "github.event_name == 'push'",
  ].join(' ||\n');
}

/**
 * The filter map the compliant baseline states. Every flag the baseline jobs
 * gate on is defined here: a gate on a filter the `changes` job's paths-filter
 * step never defines is itself a violation (invariant 6).
 */
function defaultFilters() {
  return {
    extension: ['packages/extension/**'],
    desktop: ['packages/desktop/**'],
    shared: ['packages/shared/**'],
    schema: ['schemas/**'],
    referenceServer: ['reference-implementations/**'],
    corpus: ['corpus/**'],
    // The held flags state the shipped holdings maps, which invariant 10 holds
    // each filter to: it reads the shipped maps, so a fixture stating any other
    // list reds every case that asserts the whole problem list — the compliant
    // baseline, the holdings-direction cases that keep these lists, and the
    // duplicate cases among them — while a case stating its own list, or
    // asserting only that a problem is present, stays green.
    releasePipeline: [...HELD_FLAG_FILES.releasePipeline],
    contractDocs: [...HELD_FLAG_FILES.contractDocs],
    dispositionWorkflow: [...HELD_FLAG_FILES.dispositionWorkflow],
    suiteHeld: [...HELD_FILES],
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
  // Each heavy job's own closure: two jobs run scripts, the rest run none —
  // desktop-cross-compile among them, the one heavy job gating on no
  // buildScripts. Every heavy job carries an entry, as evaluateContract
  // requires; an override replaces the entries it states.
  const jobClosures = {
    ...Object.fromEntries(
      Object.keys(jobFlagsMap)
        .filter((id) => id !== 'unit-tests')
        .map((id) => [id, new Set()]),
    ),
    ...(overrides.jobClosures || {
      'extension-e2e-tests': new Set(['scripts/a.js', 'scripts/b.js']),
      'desktop-integration-tests': new Set(['scripts/a.js']),
    }),
  };
  const isTracked = overrides.isTracked || ((p) => FIXTURE_FILES.has(p));
  // Derived from the MERGED filters: a case that wants the registry to outrun
  // the flag deletes `filters.suiteHeld` after construction; an override of
  // `{ suiteHeld: undefined }` reaches invariant 8 first and throws there
  // instead of exercising invariant 9.
  const registryDocs = overrides.registryDocs || [...(filters.suiteHeld || [])];
  return { wf, filters, closure, jobClosures, isTracked, registryDocs };
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

  it('fires when reference-server-tests does not gate on buildScripts', () => {
    // Its suites import scripts/build-schemas.js through a sub-package
    // `npm test`, which the command model reads as no invocation, so its own
    // closure is empty and invariant 12 licenses nothing from it: this entry
    // is what holds the gate.
    const base = withJobFlags(makeWorkflow(), 'reference-server-tests', [
      'referenceServer',
      'schema',
      'shared',
      'ciCore',
      'releasePipeline',
    ]);
    assert.deepEqual(evaluateContract(base), [
      'job `reference-server-tests` must gate on the `buildScripts` flag',
    ]);
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
    // The release-output suite unit-tests runs reads docs-disposition.yml as a
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

  it('with ciCoreGlobs at its default, a filter dropping the glob reds invariants 2 and 4 together', () => {
    const filter = ['.github/workflows/test.yml', 'package.json', 'package-lock.json'];
    assert.deepEqual(evaluate({ filters: { ciCore: filter } }), [
      `ciCore globs must be exactly [${CI_CORE_GLOBS.join(', ')}]; found [${filter.join(', ')}]`,
      'ciCore must include `.github/actions/**` (composite actions are used everywhere)',
    ]);
  });

  it('with the list and the filter dropping the glob together, invariant 4 reds alone', () => {
    const list = CI_CORE_GLOBS.filter((glob) => glob !== '.github/actions/**');
    const base = makeWorkflow({ filters: { ciCore: [...list] } });
    assert.deepEqual(evaluateContract({ ...base, ciCoreGlobs: list }), [
      'ciCore must include `.github/actions/**` (composite actions are used everywhere)',
    ]);
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
  it("fires when a job gates on a flag the `changes` job's paths-filter step does not define", () => {
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
    const problems = evaluate({ registryDocs: [...HELD_FILES, 'docs/ghost.md'] });
    assert.deepEqual(problems, [
      'the clause registry names `docs/ghost.md`, which the `suiteHeld` filter does not list; the preamble suite holds its registry link',
    ]);
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

describe('evaluateContract — invariant 10 (the suiteHeld filter and its holdings)', () => {
  it('fires when the filter lists a file the holdings map states no holding for', () => {
    // Tracked, so invariant 8 is satisfied and the entry reaches this leg
    // alone: what it lacks is the holding that earns it the flag.
    const problems = evaluate({
      filters: { suiteHeld: [...HELD_FILES, 'docs/ghost.md'] },
      isTracked: (path) => FIXTURE_FILES.has(path) || path === 'docs/ghost.md',
    });
    assert.deepEqual(problems, [
      'the `suiteHeld` filter lists `docs/ghost.md`, which SUITE_HELD_HOLDINGS states no holding for',
    ]);
  });

  it('fires when a file the holdings map states a holding for is not in the filter', () => {
    const [dropped, ...rest] = HELD_FILES;
    const problems = evaluate({ filters: { suiteHeld: rest } });
    assert.deepEqual(problems, [
      `SUITE_HELD_HOLDINGS states a holding for \`${dropped}\`, which the \`suiteHeld\` filter does not list`,
    ]);
  });
});

describe('evaluateContract — invariant 10 (the held flags and their holdings)', () => {
  for (const [flag, files] of Object.entries(HELD_FLAG_FILES)) {
    const name = `HELD_FLAG_HOLDINGS.${flag}`;

    it(`fires when an entry of \`${flag}\` is deleted from the filter`, () => {
      for (const dropped of files) {
        const problems = evaluate({ filters: { [flag]: files.filter((f) => f !== dropped) } });
        assert.deepEqual(problems, [
          `${name} states a holding for \`${dropped}\`, which the \`${flag}\` filter does not list`,
        ]);
      }
    });

    it(`fires both ways when an entry of \`${flag}\` is swapped for a wrong tracked file`, () => {
      const [swapped, ...rest] = files;
      const problems = evaluate({
        filters: { [flag]: ['docs/README.md', ...rest] },
        isTracked: (path) => FIXTURE_FILES.has(path) || path === 'docs/README.md',
      });
      assert.deepEqual(problems, [
        `the \`${flag}\` filter lists \`docs/README.md\`, which ${name} states no holding for`,
        `${name} states a holding for \`${swapped}\`, which the \`${flag}\` filter does not list`,
      ]);
    });

    it(`fires both ways when an entry of \`${flag}\` is a glob typo`, () => {
      const [typoed, ...rest] = files;
      // A glob that matches nothing: a stray letter before the extension.
      const glob = typoed.replace(/(\.[a-z]+)$/, 'x*$1');
      const problems = evaluate({ filters: { [flag]: [glob, ...rest] } });
      assert.deepEqual(problems, [
        `the \`${flag}\` filter lists \`${glob}\`, which ${name} states no holding for`,
        `${name} states a holding for \`${typoed}\`, which the \`${flag}\` filter does not list`,
      ]);
    });
  }

  it('fires when a holdings map names a flag the filter does not define', () => {
    const base = makeWorkflow();
    delete base.filters.dispositionWorkflow;
    const problems = evaluateContract(base);
    assert.ok(
      problems.includes(
        "HELD_FLAG_HOLDINGS.dispositionWorkflow states holdings for `dispositionWorkflow`, which the `changes` job's paths-filter step does not define",
      ),
      problems.join('\n'),
    );
  });
});

describe('evaluateContract — invariant 12 (a job running build scripts gates on buildScripts)', () => {
  it('fires when a heavy job whose own closure is non-empty does not gate on buildScripts', () => {
    const base = withJobFlags(makeWorkflow(), 'desktop-integration-tests', [
      'desktop',
      'shared',
      'schema',
      'referenceServer',
      'ciCore',
    ]);
    assert.deepEqual(evaluateContract(base), [
      'heavy job `desktop-integration-tests` runs scripts/a.js but does not gate on the `buildScripts` flag',
    ]);
  });

  it('names every script the job runs, sorted', () => {
    const base = withJobFlags(makeWorkflow(), 'extension-e2e-tests', [
      'extension',
      'shared',
      'schema',
      'referenceServer',
      'corpus',
      'ciCore',
    ]);
    assert.deepEqual(evaluateContract(base), [
      'heavy job `extension-e2e-tests` runs scripts/a.js, scripts/b.js but does not gate on the `buildScripts` flag',
    ]);
  });

  it('an empty closure licenses nothing: a job running no script may gate on buildScripts or not', () => {
    // desktop-rust-tests gates on it with an empty closure, desktop-cross-compile
    // does not — both green in the baseline.
    const base = makeWorkflow();
    assert.equal(base.jobClosures['desktop-rust-tests'].size, 0);
    assert.ok(!jobFlags(base.wf.jobs['desktop-cross-compile']).has('buildScripts'));
    assert.deepEqual(evaluateContract(base), []);
    const emptied = makeWorkflow({ jobClosures: { 'desktop-cross-compile': new Set() } });
    assert.deepEqual(evaluateContract(emptied), []);
  });
});

describe('evaluateContract — invariant 11 (no filter lists an entry more than once)', () => {
  it('fires when a suiteHeld entry is stated more than once', () => {
    // The doubled list is the fixture's own set plus one repeat, so every leg
    // reading a filter as a set still holds and this one problem stands alone.
    const problems = evaluate({ filters: { suiteHeld: [...HELD_FILES, HELD_FILES[0]] } });
    assert.deepEqual(problems, [`filter \`suiteHeld\` lists \`${HELD_FILES[0]}\` more than once`]);
  });

  it('fires when a ciCore glob is stated more than once', () => {
    // The set comparison invariant 2 makes reads both lists as sets, so a
    // doubled glob passes it and this leg is what catches the duplicate.
    const problems = evaluate({ filters: { ciCore: [...CI_CORE_GLOBS, CI_CORE_GLOBS[0]] } });
    assert.deepEqual(problems, [`filter \`ciCore\` lists \`${CI_CORE_GLOBS[0]}\` more than once`]);
  });

  it('fires once when an entry is stated three times', () => {
    // One problem per repeated entry, however many times it is repeated: the
    // finding is that the list stopped being an enumeration, which a third
    // statement of the same entry does not make twice over.
    const problems = evaluate({
      filters: { suiteHeld: [...HELD_FILES, HELD_FILES[0], HELD_FILES[0]] },
    });
    assert.deepEqual(problems, [`filter \`suiteHeld\` lists \`${HELD_FILES[0]}\` more than once`]);
  });
});

describe('evaluateContract — the inputs it refuses to default', () => {
  it('throws when jobClosures is missing', () => {
    const { wf, filters, closure, isTracked, registryDocs } = makeWorkflow();
    assert.throws(() => evaluateContract({ wf, filters, closure, isTracked, registryDocs }), {
      name: 'TypeError',
      message: 'evaluateContract: jobClosures is required',
    });
  });

  it('throws naming the heavy job when jobClosures carries no entry for it', () => {
    const { wf, filters, closure, jobClosures, isTracked, registryDocs } = makeWorkflow();
    const rest = { ...jobClosures };
    delete rest['desktop-rust-tests'];
    assert.throws(
      () => evaluateContract({ wf, filters, closure, jobClosures: rest, isTracked, registryDocs }),
      {
        name: 'TypeError',
        message:
          'evaluateContract: jobClosures carries no entry for heavy job `desktop-rust-tests`',
      },
    );
  });

  it('throws when isTracked is missing', () => {
    const { wf, filters, closure, jobClosures, registryDocs } = makeWorkflow();
    assert.throws(() => evaluateContract({ wf, filters, closure, jobClosures, registryDocs }), {
      name: 'TypeError',
      message: 'evaluateContract: isTracked is required',
    });
  });

  it('throws when registryDocs is missing', () => {
    const { wf, filters, closure, jobClosures, isTracked } = makeWorkflow();
    assert.throws(() => evaluateContract({ wf, filters, closure, jobClosures, isTracked }), {
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
 * The entry files a command resolves to under the command model, as
 * root-relative paths against a synthetic root, sorted.
 * @param {string} cmd the command string
 * @param {Record<string, string>} [scripts] package.json's scripts
 * @returns {string[]} the resolved entries
 */
function entriesOf(cmd, scripts = {}) {
  const root = resolve('/world');
  return [...entryFilesFromCommand(cmd, scripts, new Set(), root)]
    .map((abs) => abs.slice(root.length + 1).replace(/\\/g, '/'))
    .sort();
}

describe('entryFilesFromCommand — the command model, form by form', () => {
  // Each form hides an invocation from a reader that splits at `&&`, `||`, `;`
  // and newline and reads only a segment's first token; the model reads each.
  const forms = [
    ['echo x | node scripts/p.js', ['scripts/p.js']],
    ['echo x |& node scripts/p.js', ['scripts/p.js']],
    ['(node scripts/p.js)', ['scripts/p.js']],
    ['(node scripts/p.js) 2>&1', ['scripts/p.js']],
    ['$(node scripts/p.js)', ['scripts/p.js']],
    ['node scripts/p.js>out', ['scripts/p.js']],
    ['node scripts/a.js & node scripts/p.js', ['scripts/a.js', 'scripts/p.js']],
    ['xvfb-run -a node scripts/p.js', ['scripts/p.js']],
    ['FOO=1 node scripts/p.js', ['scripts/p.js']],
    ['npm run --silent k', ['scripts/p.js']],
    ['npm run-script k', ['scripts/p.js']],
    ['npm --silent run k', ['scripts/p.js']],
    ['xvfb-run -a npm run k', ['scripts/p.js']],
    ['node scripts/p.js # note', ['scripts/p.js']],
    ['node scripts/a.js scripts/b.js', ['scripts/a.js']],
    ['node "scripts/p.js"', ['scripts/p.js']],
    ['node --import ./scripts/a.js scripts/p.js', ['scripts/a.js', 'scripts/p.js']],
    ['node --loader ./scripts/l.mjs scripts/p.js', ['scripts/l.mjs', 'scripts/p.js']],
    ['node -r ./scripts/r.js scripts/p.js', ['scripts/p.js', 'scripts/r.js']],
    ['node --require ./scripts/r.js scripts/p.js', ['scripts/p.js', 'scripts/r.js']],
    ['echo " #x"; node scripts/p.js', ['scripts/p.js']],
  ];
  for (const [cmd, expected] of forms) {
    it(`reads \`${cmd}\``, () => {
      assert.deepEqual(entriesOf(cmd, { k: 'node scripts/p.js' }), expected);
    });
  }

  it('reads an invocation inside quoted text — the stated over-include', () => {
    assert.deepEqual(entriesOf('echo "run node scripts/p.js now"'), ['scripts/p.js']);
    assert.deepEqual(entriesOf('sh -c "node scripts/p.js"'), ['scripts/p.js']);
  });

  it('reads a segment opening with `#` as a comment', () => {
    assert.deepEqual(entriesOf('# node scripts/p.js'), []);
    assert.deepEqual(entriesOf('npm ci\n  # node scripts/p.js\nnode scripts/a.js'), ['scripts/a.js']); // prettier-ignore
  });

  it('reads the stated misread and passed-over forms as the header says', () => {
    // A sub-package run is read against the root manifest: the root key when
    // there is one, nothing when there is none.
    assert.deepEqual(entriesOf('cd sub && npm run k', { k: 'node scripts/p.js' }), ['scripts/p.js']); // prettier-ignore
    assert.deepEqual(entriesOf('cd sub && npm run k', {}), []);
    assert.deepEqual(entriesOf('npm --prefix=sub run k', { k: 'node scripts/p.js' }), ['scripts/p.js']); // prettier-ignore
    // The spaced form takes `sub` as the verb, so it reads no invocation.
    assert.deepEqual(entriesOf('npm --prefix sub run k', { k: 'node scripts/p.js' }), []);
    // A `node` token after a wrapper is read like any other.
    assert.deepEqual(entriesOf('npx node scripts/p.js'), ['scripts/p.js']);
  });

  it('reads a `=`-joined script flag value as an entry', () => {
    assert.deepEqual(entriesOf('node --require=./scripts/a.js scripts/p.js'), ['scripts/a.js', 'scripts/p.js']); // prettier-ignore
  });

  it('the `&&` control reads both commands', () => {
    assert.deepEqual(entriesOf('node scripts/a.js && node scripts/p.js'), ['scripts/a.js', 'scripts/p.js']); // prettier-ignore
  });
});

/**
 * A synthetic tree on disk for the closure walk: a package.json-free world
 * whose scripts/ directory and one directory beside it hold the files each
 * case reads. Built once per case under a fresh temp root and removed after.
 * @param {(root: string) => void} fn the case body, handed the world's root
 */
function inWorld(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ci-filter-world-'));
  const files = {
    'scripts/chained.js': '',
    'scripts/flagged.js': '',
    'scripts/lib/importer.js': "import './helper.js';\n",
    'scripts/lib/helper.js': '',
    'scripts/sub/spawner.js':
      "execFileSync(process.execPath, [join(ROOT, 'scripts', 'spawned.js')]);\n",
    'scripts/spawned.js': '',
    'tests/outside.test.js': "import '../scripts/from-outside.js';\n",
    'scripts/from-outside.js': '',
    'tests/over.js': "const name = 'over-included.js';\n",
    'scripts/over-included.js': '',
    'scripts/npx-only.js': '',
    'scripts/cargo-only.js': '',
  };
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The union closure one heavy job's steps reach in a world.
 * @param {string} root the world's root
 * @param {object[]} steps the job's steps
 * @param {Record<string, string>} [scripts] package.json's scripts
 * @returns {string[]} the closure, sorted
 */
function worldClosure(root, steps, scripts = {}) {
  const wf = { jobs: { heavy: { if: "needs.changes.outputs.x == 'true'", steps } } };
  const { closure, jobClosures } = computeBuildClosure(wf, scripts, root);
  assert.deepEqual([...jobClosures.heavy].sort(), [...closure].sort());
  return [...closure].sort();
}

describe('computeBuildClosure — the closure walk over a synthetic tree', () => {
  it('drops the token an import inside a `node -e` expression yields, the file existing', () => {
    inWorld((root) => {
      assert.deepEqual(worldClosure(root, [{ run: `node -e "import('./scripts/chained.js')"` }]), []); // prettier-ignore
    });
  });

  it('follows an npm-run chain to the script it runs', () => {
    inWorld((root) => {
      const scripts = { chain: 'npm run leaf', leaf: 'node scripts/chained.js' };
      assert.deepEqual(worldClosure(root, [{ run: 'npm run chain' }], scripts), ['scripts/chained.js']); // prettier-ignore
    });
  });

  it('reads a key that runs itself once, and ends', () => {
    inWorld((root) => {
      assert.deepEqual(worldClosure(root, [{ run: 'npm run loop' }], { loop: 'npm run loop' }), []); // prettier-ignore
    });
  });

  it('takes a flagged node entry in a heavy job', () => {
    inWorld((root) => {
      const steps = [{ run: 'node --max-old-space-size=64 scripts/flagged.js' }];
      assert.deepEqual(worldClosure(root, steps), ['scripts/flagged.js']);
    });
  });

  it("follows an import edge resolved against the importing file's own directory", () => {
    inWorld((root) => {
      const steps = [{ run: 'node scripts/lib/importer.js' }];
      assert.deepEqual(worldClosure(root, steps), ['scripts/lib/helper.js', 'scripts/lib/importer.js']); // prettier-ignore
    });
  });

  it('follows a spawn literal resolved against scripts/', () => {
    inWorld((root) => {
      const steps = [{ run: 'node scripts/sub/spawner.js' }];
      assert.deepEqual(worldClosure(root, steps), ['scripts/spawned.js', 'scripts/sub/spawner.js']); // prettier-ignore
    });
  });

  it('scans an entry outside scripts/ for its references without making it a member', () => {
    inWorld((root) => {
      const steps = [{ run: 'node tests/outside.test.js' }];
      assert.deepEqual(worldClosure(root, steps), ['scripts/from-outside.js']);
    });
  });

  it('reads npx, cargo and a sub-package npm test as no invocation', () => {
    inWorld((root) => {
      const steps = [
        { run: 'npx tool scripts/npx-only.js' },
        { run: 'cargo xtask scripts/cargo-only.js' },
        { run: 'npm test', 'working-directory': 'scripts' },
      ];
      assert.deepEqual(worldClosure(root, steps), []);
    });
  });

  it('pins the scripts/-relative over-include: a bare literal outside scripts/ that names a script joins', () => {
    // The header's stated conservatism: a `.js` literal is tried against
    // scripts/ whatever directory wrote it.
    inWorld((root) => {
      const steps = [{ run: 'node tests/over.js' }];
      assert.ok(worldClosure(root, steps).includes('scripts/over-included.js'));
    });
  });
});

/**
 * The inputs the command line evaluates, read once through the check's own
 * reader — so these cases observe what `run()` hands the contract rather than a
 * rebuild of it.
 */
const REAL = loadInputs();

/**
 * The check's own source read through the `blankJsLiterals` view: comments
 * blanked, string and template contents blanked, and a regular-expression
 * literal's flag run blanked while its pattern text stands — the view's own
 * rules, stated in `blankJsLiterals`'s docblock in
 * scripts/check-test-inventory.js. This is what the input-reader lock is
 * matched against, and the pattern text standing is that lock's limit: a copy
 * of a locked call written inside a pattern would satisfy it.
 */
const CHECK_SOURCE = blankJsLiterals(
  readFileSync(resolve(ROOT, 'scripts/check-ci-filter.js'), 'utf8'),
);

/**
 * A CI guide flag bullet, from its opening marker to the next bullet or the
 * blank line that ends the list, whichever comes first, with its wrapping
 * collapsed so a phrase the guide breaks across lines reads as one string.
 * @param {string} flag the flag the bullet opens with
 * @returns {string} the bullet's text, or '' when the guide carries none
 */
function ciGuideFlagBullet(flag) {
  const guide = readFileSync(resolve(ROOT, 'docs/guides/ci.md'), 'utf8');
  const start = guide.indexOf(`- \`${flag}\` —`);
  if (start === -1) return '';
  const ends = [guide.indexOf('\n\n', start), guide.indexOf('\n- ', start + 1)].filter(
    (i) => i !== -1,
  );
  return guide.slice(start, Math.min(...ends)).replace(/\s+/g, ' ');
}

/** The CI guide's `suiteHeld` bullet. */
const CI_GUIDE_SUITE_HELD_BULLET = ciGuideFlagBullet('suiteHeld');

/**
 * The CI guide's flag-exception sentence, located on the whole guide with its
 * wrapping collapsed: from its lead-in to the first `. ` after it, or to the
 * end of the text.
 */
const CI_GUIDE_FLAG_EXCEPTION_SENTENCE = (() => {
  const guide = readFileSync(resolve(ROOT, 'docs/guides/ci.md'), 'utf8').replace(/\s+/g, ' ');
  const start = guide.indexOf('sets no flag, because that gate reds the same drift on every PR');
  const end = guide.indexOf('. ', start);
  return end === -1 ? guide.slice(start) : guide.slice(start, end + 1);
})();

/**
 * The backticked tokens that sentence states, and the ones a filter map lists:
 * a token equal to a filter entry, or to an entry's basename, is a file the
 * sentence names that the split gives a flag to.
 * @param {Record<string, string[]>} filters the filter map to compare against
 * @returns {{ tokens: string[], named: string[] }} the tokens and the hits
 */
function exceptionTokensAgainstFilters(filters) {
  const tokens = [...CI_GUIDE_FLAG_EXCEPTION_SENTENCE.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const named = [];
  for (const [flag, entries] of Object.entries(filters))
    for (const entry of entries)
      for (const token of tokens)
        if (token === entry || token === entry.split('/').pop())
          named.push(`${flag} lists \`${entry}\`, which the sentence names as \`${token}\``);
  return { tokens, named };
}

describe('real-tree lock', () => {
  it('the shipped test.yml satisfies the path-filter contract', () => {
    assert.deepEqual(
      evaluateContract(REAL),
      [],
      'scripts/check-ci-filter.js must pass on the committed test.yml',
    );
  });

  it('the predicate the lock passes answers for the shipped tree', () => {
    assert.equal(REAL.isTracked('docs/ghost.md'), false);
    // A directory that exists on disk, and is no tracked file.
    assert.equal(REAL.isTracked('docs'), false);
    assert.equal(REAL.isTracked('README.md'), true);
  });

  it("the registry list the lock passes is the shipped registry's own documents", () => {
    assert.ok(REAL.registryDocs.includes('docs/api/dispatch.md'), REAL.registryDocs.join(', '));
    for (const doc of REAL.registryDocs) assert.ok(REAL.isTracked(doc), doc);
  });

  it('reds on the committed workflow when no literal entry resolves', () => {
    const literals = Object.values(REAL.filters)
      .flat()
      .filter((entry) => !GLOB_CHARS.test(entry));
    assert.ok(literals.length, 'the committed filter map states literal entries');
    const problems = evaluateContract({ ...REAL, isTracked: () => false });
    for (const entry of literals) {
      assert.ok(problems.some((p) => p.includes(entry)), `${entry}: ${problems.join('\n')}`); // prettier-ignore
    }
  });

  it('reds on the committed workflow when the registry names one more document', () => {
    const problems = evaluateContract({
      ...REAL,
      registryDocs: [...REAL.registryDocs, 'docs/ghost.md'],
    });
    assert.ok(
      problems.some((p) => p.includes('docs/ghost.md') && p.includes('`suiteHeld`')),
      problems.join('\n'),
    );
  });

  it('reds when the committed filter carries a file no holding is stated for', () => {
    // A tracked file outside the holdings map: every other leg holds, so the
    // missing holding is the whole of what reds.
    const problems = evaluateContract({
      ...REAL,
      filters: {
        ...REAL.filters,
        suiteHeld: [...REAL.filters.suiteHeld, '.github/dependabot.yml'],
      },
    });
    assert.deepEqual(problems, [
      'the `suiteHeld` filter lists `.github/dependabot.yml`, which SUITE_HELD_HOLDINGS states no holding for',
    ]);
  });

  it('reds when the committed filter drops a file a holding is stated for', () => {
    const [dropped, ...rest] = REAL.filters.suiteHeld;
    const problems = evaluateContract({
      ...REAL,
      filters: { ...REAL.filters, suiteHeld: rest },
      registryDocs: REAL.registryDocs.filter((doc) => doc !== dropped),
    });
    assert.deepEqual(problems, [
      `SUITE_HELD_HOLDINGS states a holding for \`${dropped}\`, which the \`suiteHeld\` filter does not list`,
    ]);
  });

  it('reds on the committed workflow when desktop-integration-tests stops gating on buildScripts', () => {
    // The job runs build scripts and pairs with no other job, so invariant 12
    // is the whole of what reds.
    const job = REAL.wf.jobs['desktop-integration-tests'];
    const ungated = { ...job, if: job.if.replace(/\|\|\s*needs\.changes\.outputs\.buildScripts == 'true'/, '') }; // prettier-ignore
    assert.ok(!jobFlags(ungated).has('buildScripts'), ungated.if);
    const problems = evaluateContract({
      ...REAL,
      wf: { ...REAL.wf, jobs: { ...REAL.wf.jobs, 'desktop-integration-tests': ungated } },
    });
    const scripts = [...REAL.jobClosures['desktop-integration-tests']].sort();
    assert.ok(scripts.length, 'the job runs build scripts');
    assert.deepEqual(problems, [
      `heavy job \`desktop-integration-tests\` runs ${scripts.join(', ')} but does not gate on the \`buildScripts\` flag`,
    ]);
  });

  it('reds on the committed workflow when a held flag drops any entry', () => {
    for (const [flag, files] of Object.entries(HELD_FLAG_FILES)) {
      for (const dropped of files) {
        const problems = evaluateContract({
          ...REAL,
          filters: { ...REAL.filters, [flag]: REAL.filters[flag].filter((e) => e !== dropped) },
        });
        assert.deepEqual(problems, [
          `HELD_FLAG_HOLDINGS.${flag} states a holding for \`${dropped}\`, which the \`${flag}\` filter does not list`,
        ]);
      }
    }
  });

  it('every heavy job the reader hands a non-empty closure for gates on buildScripts', () => {
    const running = Object.entries(REAL.jobClosures)
      .filter(([, own]) => own.size > 0)
      .map(([id]) => id)
      .sort();
    assert.deepEqual(running, [
      'desktop-corpus-diff',
      'desktop-integration-tests',
      'desktop-vectors-diff',
      'extension-e2e-tests',
    ]);
    for (const id of running) assert.ok(jobFlags(REAL.wf.jobs[id]).has('buildScripts'), id);
  });

  it('the buildScripts closure the reader hands over is exactly the scripts the heavy jobs run', () => {
    assert.deepEqual([...REAL.closure].sort(), [
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

describe('loadInputs — the reader the command line and this suite share', () => {
  it('run() evaluates the contract over the reader, which computes the closure', () => {
    // Match form: plain substrings over the check's text read through
    // `blankJsLiterals`, so a quoted, templated, or commented-out copy of the
    // call cannot satisfy the lock. Its limit is the text alone: it cannot see
    // what a call is given, which is why each input's value is observed above —
    // and a closure the reader took from the filter map would satisfy invariant
    // 1 by construction, leaving the text as what holds it.
    assert.ok(CHECK_SOURCE.includes('evaluateContract(loadInputs())'), 'run() reads no input of its own'); // prettier-ignore
    assert.ok(CHECK_SOURCE.includes('const build = computeBuildClosure(wf, scripts);'), 'the closure is computed, not read off the filter map'); // prettier-ignore
    assert.ok(CHECK_SOURCE.includes('closure: build.closure,'), 'the union handed over is the computed one'); // prettier-ignore
    assert.ok(CHECK_SOURCE.includes('jobClosures: build.jobClosures,'), 'the per-job closures handed over are the computed ones'); // prettier-ignore
  });
});

describe("the CI guide's flag-exception sentence names no file a filter lists", () => {
  it('every backticked name the sentence states is outside every filter', () => {
    // Match form: the guide with its wrapping collapsed, the sentence located
    // by its lead-in, and its backticked tokens compared as plain strings.
    // Limits: literal entries and their basenames only, so a file a glob
    // covers passes; and the sentence's own names only, never the paragraph's
    // meaning.
    const { tokens, named } = exceptionTokensAgainstFilters(REAL.filters);
    assert.ok(tokens.length, CI_GUIDE_FLAG_EXCEPTION_SENTENCE);
    assert.ok(tokens.includes('cla.yml'), tokens.join(', '));
    assert.deepEqual(named, [], named.join('\n'));
  });
});

describe('the CI guide names the flag; the check states the holdings', () => {
  it('the guide bullet cites the holdings map and restates no holding itself', () => {
    // Match form: plain substrings over the bullet with its wrapping
    // collapsed, so a holding the guide breaks across lines is caught too. It
    // holds the `SUITE_HELD_HOLDINGS` token present and every map string
    // absent. Its limit is the map's strings verbatim: a holding restated in
    // other words, and the bullet's own class sentence about the registry
    // carriers, are outside what it matches; the bullet's own text ends at the
    // blank line after it.
    assert.ok(
      CI_GUIDE_SUITE_HELD_BULLET.includes('SUITE_HELD_HOLDINGS'),
      CI_GUIDE_SUITE_HELD_BULLET,
    );
    for (const [file, holding] of Object.entries(SUITE_HELD_HOLDINGS))
      assert.ok(!CI_GUIDE_SUITE_HELD_BULLET.includes(holding), `${file}: ${holding}`);
  });

  // The suites holding an entry of HELD_FLAG_HOLDINGS, each with the map names
  // its header points at. The list is hand-kept in step with the suites holding
  // an entry of `HELD_FLAG_HOLDINGS`. The hold is a plain substring over the
  // header text, taken up to the file's first block-comment close — the name
  // alone, not the sentence round it.
  const HOLDER_SUITE_POINTERS = {
    'packages/shared/tests/unit/check-docs-disposition.test.js': ['HELD_FLAG_HOLDINGS', 'SUITE_HELD_HOLDINGS'], // prettier-ignore
    'packages/shared/tests/unit/check-no-release-outputs.test.js': ['HELD_FLAG_HOLDINGS', 'SUITE_HELD_HOLDINGS'], // prettier-ignore
    'reference-implementations/sync-server/tests/unit/release-exclusion.test.js': ['HELD_FLAG_HOLDINGS'], // prettier-ignore
  };
  for (const [suite, names] of Object.entries(HOLDER_SUITE_POINTERS)) {
    it(`the holder suite ${suite} names ${names.join(' and ')} in its header`, () => {
      const header = readFileSync(resolve(ROOT, suite), 'utf8').split('*/')[0];
      for (const name of names) assert.ok(header.includes(name), `${suite}: ${name}`);
    });
  }

  for (const [flag, map] of Object.entries(HELD_FLAG_HOLDINGS)) {
    it(`the guide's \`${flag}\` bullet cites the held-flag holdings map and restates no holding itself`, () => {
      // Same match form and limit as the `suiteHeld` case above, over this
      // bullet, which ends at the next bullet.
      const bullet = ciGuideFlagBullet(flag);
      assert.ok(bullet.includes('HELD_FLAG_HOLDINGS'), bullet || `no \`${flag}\` bullet`);
      for (const [file, holding] of Object.entries(map))
        assert.ok(!bullet.includes(holding), `${file}: ${holding}`);
    });
  }
});
