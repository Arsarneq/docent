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
 * `suiteHeld` filter omits, a `suiteHeld` entry parted from the holdings map,
 * a filter entry stated more than once) and that the closure resolver follows
 * the npm-run and compound-command forms. The inputs that stand for state
 * outside the workflow — the tracked-file predicate and the registry's document
 * list — are proven required rather than defaulted. A real-tree lock proves the
 * shipped test.yml satisfies the contract over the inputs the command line
 * itself reads, with each of those inputs observed on its own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CI_CORE_GLOBS,
  GLOB_CHARS,
  SUITE_HELD_HOLDINGS,
  jobFlags,
  heavyJobs,
  entryFilesFromCommand,
  evaluateContract,
  pathsFilterStep,
  loadInputs,
} from '../../../../scripts/check-ci-filter.js';
import { blankJsLiterals } from '../../../../scripts/check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** The files the holdings map states a holding for — the `suiteHeld` set. */
const HELD_FILES = Object.keys(SUITE_HELD_HOLDINGS);

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
    releasePipeline: ['.github/workflows/publish.yml'],
    contractDocs: ['.github/CONTRIBUTING.md'],
    dispositionWorkflow: ['.github/workflows/docs-disposition.yml'],
    // The shipped holdings map, which invariant 10 holds the filter to: it
    // reads the shipped map, so a fixture stating any other list reds every
    // case that asserts the whole problem list — the compliant baseline, the
    // holdings-direction case that keeps this list, and the duplicate cases
    // among them — while a case stating its own `suiteHeld`, or asserting only
    // that a problem is present, stays green.
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
 * The CI guide's `suiteHeld` bullet, from its opening marker to the blank line
 * that ends it, with its wrapping collapsed so a phrase the guide breaks across
 * lines reads as one string.
 */
const CI_GUIDE_SUITE_HELD_BULLET = (() => {
  const guide = readFileSync(resolve(ROOT, 'docs/guides/ci.md'), 'utf8');
  const start = guide.indexOf('- `suiteHeld` —');
  return guide.slice(start, guide.indexOf('\n\n', start)).replace(/\s+/g, ' ');
})();

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
    assert.ok(CHECK_SOURCE.includes('closure: computeBuildClosure('), 'the closure is computed, not read off the filter map'); // prettier-ignore
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
});
