/**
 * check-workflow-bounds.test.js — Unit tests for the workflow-bounds and
 * cache-claims admission test (scripts/check-workflow-bounds.js). Both subjects
 * are committed data that nothing else reads, so every direction must fail
 * loud.
 *
 * The bounds legs: the presence leg (a job stating no bound reds by name; a job
 * calling a reusable workflow, where the platform admits no bound, is not asked
 * for one), the composition leg (a bounded step set reaching its job's bound
 * reds with its addends, its sum, and that bound; a set below it passes; a step
 * stating no bound stays outside the sum), and the workflow-file boundary this
 * check reads through.
 *
 * The cache legs, over the workflows' cache steps and the tables the CI guide
 * states about them: a family entry or a tool cache no row describes, a row
 * describing neither, a row whose identity cell is not one backticked name,
 * and every cell held against the surface that answers for it — the step for
 * most, the local-CI guide's own subsection for the doc-mention column, so
 * un-backticking a version there reds against a cell still stating it. Beside
 * the row diffs: a restore and its save stating different path lists, two
 * family stems nesting inside one path-list group (with the same nesting across
 * groups left alone, where no prefix reaches another list, and overlapping lists
 * still two groups), one stem stated twice in a group over one hash input (with
 * the same stem over different inputs — the shipped Playwright pair's shape —
 * left alone), a family whose first restore key is not its own prefix — held of
 * an entry alone in its group as of one sharing it — a fallback reaching
 * another writer's entry under a stem the two share (with one reaching a
 * different stem left alone), a key's version segment parting from the version
 * its install pins, and a guide's version parting from that pin.
 *
 * And every input shape the check refuses on its own exit code rather than
 * passing vacuously — a workflow it cannot read, one that reads empty, one that
 * does not parse as YAML, a `jobs` that is not a map or is an empty one, a job
 * or step that is not a map, a `steps` that is not a list, a bound that is not
 * a literal positive number (an expression, a string, zero, a negative that
 * would otherwise cancel inside a sum), a listing that cannot be taken, and one
 * that yields no workflow file; a cache step stating no `with` map, no path
 * list, no key, or a `restore-keys` that is not a string, a key group it cannot
 * pair, a split whose restore states no id, a family key not ending in a
 * `hashFiles` expression, a tool key not naming its tool and a version, a job
 * stating other than one matching `cargo install` for a tool it caches, two
 * entries claiming one row identity, a guide it cannot read or that reads
 * empty, a table its header selects other than once or that states no row, one
 * stating no column a claim names, one stating a column no claim answers for,
 * one whose header states a column name more than once, a missing doc-mention
 * subsection, and either cache class yielding no entry at all.
 *
 * The refusal ordering is pinned too, both of the orderings a run has: step
 * shapes are read whether or not the job states a bound, so a refusal never
 * waits on drift being fixed first; and the population is read lazily, so the
 * refusal a run raises is the first one its legs reach — in leg order, and in
 * listing order within a leg. The
 * CLI's own verdicts are pinned at the process boundary over copies of the
 * committed workflows AND the committed guides, with each defect planted in
 * the copy; the tree itself is never broken to produce one. A real-tree lock
 * closes the set: the shipped workflows and guides satisfy every leg.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { trackedFilesUnder } from '../../../../scripts/check-test-inventory.js';
import {
  BOUND_KEY,
  CACHES_SUBSECTION,
  CI_DOC_PATH,
  FAMILIES_HEADER,
  GUIDE_SECTION,
  InputError,
  LOCAL_CI_DOC_PATH,
  MUTATION_RUNS_SUBSECTION,
  SELF_PATH,
  SPLIT_GATE,
  TOOLS_HEADER,
  WORKFLOW_PATHSPEC,
  auditCaches,
  auditCachesOver,
  auditTree,
  auditTreeAt,
  auditTreeOver,
  COMBINED_GATE,
  cacheEntries,
  cacheSteps,
  compareRows,
  evaluateJob,
  guideVersionFor,
  fallbackReachProblems,
  jobsReader,
  prefixFreeProblems,
  readCacheClasses,
  readJobs,
  stepBounds,
  subsectionText,
  workflowPaths,
} from '../../../../scripts/check-workflow-bounds.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const WORKFLOW = '.github/workflows/sample.yml';

/** A reader over a fixture map; an absent path refuses the way `fs` does. */
const readerOver = (files) => (path) => {
  if (!(path in files)) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  return files[path];
};

/** The audit over a fixture map, listing exactly its own paths. */
const auditOver = (files) => auditTree(readerOver(files), () => Object.keys(files));

/** One workflow's text, from a jobs block. */
const workflow = (jobsBlock) => `name: Sample\n\njobs:\n${jobsBlock}`;

/** A job stating a bound and a list of step bounds (null for an unbounded step). */
const job = (id, bound, steps = [{ run: true }]) =>
  `  ${id}:\n` +
  (bound === null ? '' : `    ${BOUND_KEY}: ${bound}\n`) +
  `    runs-on: ubuntu-latest\n` +
  `    steps:\n` +
  steps
    .map(
      (stepBound, index) =>
        `      - name: step ${index + 1}\n` +
        (typeof stepBound === 'number' ? `        ${BOUND_KEY}: ${stepBound}\n` : '') +
        `        run: echo ${index + 1}\n`,
    )
    .join('');

/** A job that calls a reusable workflow — the shape the platform bounds elsewhere. */
const callerJob = (id, extra = '') => `  ${id}:\n    uses: ./.github/workflows/test.yml\n${extra}`;

describe('workflowPaths — the boundary this check reads through', () => {
  it('keeps tracked YAML directly under the workflows directory', () => {
    assert.deepEqual(
      workflowPaths([
        '.github/workflows/test.yml',
        '.github/workflows/publish.yaml',
        '.github/workflows/nested/inner.yml',
        '.github/actions/debug-env/action.yml',
        '.github/workflows/notes.md',
      ]),
      ['.github/workflows/test.yml', '.github/workflows/publish.yaml'],
    );
  });

  it('yields nothing from a listing that names no workflow file', () => {
    assert.deepEqual(workflowPaths(['docs/guides/ci.md', 'package.json']), []);
  });
});

describe('presence leg', () => {
  it('passes a job that states a bound', () => {
    assert.deepEqual(auditOver({ [WORKFLOW]: workflow(job('lint', 15)) }).problems, []);
  });

  it('reds a job that states none, naming the workflow and the job', () => {
    const { problems } = auditOver({ [WORKFLOW]: workflow(job('lint', null)) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\.github\/workflows\/sample\.yml/);
    assert.match(problems[0], /job `lint`/);
    assert.match(problems[0], /states no `timeout-minutes` bound/);
  });

  it('asks no bound of a job that calls a reusable workflow', () => {
    const { problems, callerJobs } = auditOver({
      [WORKFLOW]: workflow(callerJob('test') + job('publish', 30)),
    });
    assert.deepEqual(problems, []);
    assert.equal(callerJobs, 1);
  });

  it('reds every unbounded job in the file, not just the first', () => {
    const { problems } = auditOver({
      [WORKFLOW]: workflow(job('lint', null) + job('audit', null) + job('tests', 20)),
    });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((problem) => problem.includes('`lint`')));
    assert.ok(problems.some((problem) => problem.includes('`audit`')));
  });

  it('leaves a caller job that also states a bound to the platform’s own verdict', () => {
    // Whether the key is admitted there is actionlint's, which refuses the file;
    // this check reads the shape to know which jobs state a bound of their own,
    // and a stated one satisfies the presence leg wherever it sits.
    const { problems } = auditOver({
      [WORKFLOW]: workflow(callerJob('test', `    ${BOUND_KEY}: 30\n`)),
    });
    assert.deepEqual(problems, []);
  });
});

describe('composition leg', () => {
  it('passes step bounds that add up below the job bound', () => {
    assert.deepEqual(auditOver({ [WORKFLOW]: workflow(job('e2e', 40, [10, 25])) }).problems, []);
  });

  it('reds a sum that reaches the job bound, naming the addends, the sum, and the bound', () => {
    const { problems } = auditOver({ [WORKFLOW]: workflow(job('e2e', 40, [10, 30])) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /job `e2e`/);
    assert.match(problems[0], /10 \+ 30 = 40 minute\(s\)/);
    assert.match(problems[0], /own bound of 40 does not stand above/);
  });

  it('reds a sum above the job bound', () => {
    const { problems } = auditOver({ [WORKFLOW]: workflow(job('e2e', 20, [15, 10])) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /15 \+ 10 = 25 minute\(s\)/);
  });

  it('leaves a step stating no bound outside the sum', () => {
    // Two unbounded steps beside one bounded step: only the bounded one is
    // summed, so the job passes on a bound its steps together could exceed.
    assert.deepEqual(
      auditOver({ [WORKFLOW]: workflow(job('tests', 10, [null, 9, null])) }).problems,
      [],
    );
  });

  it('passes a job whose steps state no bounds at all', () => {
    assert.deepEqual(
      auditOver({ [WORKFLOW]: workflow(job('tests', 5, [null, null])) }).problems,
      [],
    );
  });

  it('holds each job separately', () => {
    const { problems } = auditOver({
      [WORKFLOW]: workflow(job('fine', 30, [10, 15]) + job('tight', 30, [30])),
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /job `tight`/);
  });
});

describe('counts the verdict reports', () => {
  it('counts workflows, bounded jobs, and reusable-workflow callers', () => {
    const audit = auditOver({
      [WORKFLOW]: workflow(job('lint', 15) + callerJob('test')),
      '.github/workflows/other.yml': workflow(job('publish', 30)),
    });
    assert.deepEqual(audit.problems, []);
    assert.equal(audit.workflowCount, 2);
    assert.equal(audit.boundedJobs, 2);
    assert.equal(audit.callerJobs, 1);
  });
});

describe('shapes this check does not read — its own exit code, never drift', () => {
  const refuses = (files, pattern) => {
    assert.throws(
      () => auditOver(files),
      (error) => {
        assert.ok(error instanceof InputError, `expected an InputError, got ${error}`);
        assert.match(error.message, pattern);
        return true;
      },
    );
  };

  it('refuses a listing that yields no workflow file', () => {
    assert.throws(
      () => auditTree(readerOver({}), () => ['docs/guides/ci.md']),
      (error) => error instanceof InputError && /yielded no workflow file/.test(error.message),
    );
  });

  it('refuses a workflow it cannot read', () => {
    assert.throws(
      () => auditTree(readerOver({}), () => [WORKFLOW]),
      (error) => error instanceof InputError && /could not be read/.test(error.message),
    );
  });

  it('refuses a workflow that reads empty', () => {
    refuses({ [WORKFLOW]: '   \n' }, /read empty/);
  });

  it('refuses text that does not parse as YAML', () => {
    refuses({ [WORKFLOW]: 'jobs:\n  lint:\n   - [unclosed\n' }, /does not parse as YAML/);
  });

  it('refuses a document stating no jobs map', () => {
    refuses({ [WORKFLOW]: 'name: Sample\non: push\n' }, /states no `jobs` map/);
  });

  it('refuses a jobs key that is a list', () => {
    refuses({ [WORKFLOW]: 'jobs:\n  - lint\n' }, /states no `jobs` map/);
  });

  it('refuses an explicitly empty jobs map', () => {
    // A file that parses and states the key, with nothing under it: the same
    // family as a missing map, and refused the same way rather than counted as
    // a workflow whose every job is bounded.
    refuses({ [WORKFLOW]: 'name: Sample\njobs: {}\n' }, /states an empty `jobs` map/);
  });

  it('refuses a job that is not a mapping', () => {
    refuses({ [WORKFLOW]: 'jobs:\n  lint: run-it\n' }, /job `lint` is not a mapping/);
  });

  it('refuses a job bound written as an expression', () => {
    refuses(
      { [WORKFLOW]: `jobs:\n  lint:\n    ${BOUND_KEY}: \${{ inputs.cap }}\n` },
      /which this check does not read — it reads literal, positive numbers/,
    );
  });

  it('refuses a job bound of zero, and one YAML reads as infinite', () => {
    refuses(
      { [WORKFLOW]: `jobs:\n  lint:\n    ${BOUND_KEY}: 0\n` },
      /states `timeout-minutes: 0`, which this check does not read/,
    );
    // Named as the file spells it, not as the `null` JSON would render it.
    refuses({ [WORKFLOW]: `jobs:\n  lint:\n    ${BOUND_KEY}: .inf\n` }, /timeout-minutes: Infinity/); // prettier-ignore
  });

  it('refuses step bounds that would cancel each other inside a sum', () => {
    // A negative bound and a positive one add to something the job bound stands
    // above, so the composition leg would pass a job whose real step bound is
    // unheld. The shape is refused instead of summed.
    refuses(
      { [WORKFLOW]: workflow(job('tests', 10, [-100, 100])) },
      /step 1 states `timeout-minutes: -100`, which this check does not read/,
    );
  });

  it('refuses a steps key that is not a list', () => {
    refuses(
      { [WORKFLOW]: `jobs:\n  lint:\n    ${BOUND_KEY}: 10\n    steps: none\n` },
      /states `steps` as something other than a list/,
    );
  });

  it('refuses a step that is not a mapping', () => {
    refuses(
      { [WORKFLOW]: `jobs:\n  lint:\n    ${BOUND_KEY}: 10\n    steps:\n      - echo hi\n` },
      /step 1 is not a mapping/,
    );
  });

  it('refuses a step bound it cannot add up', () => {
    refuses(
      {
        [WORKFLOW]:
          `jobs:\n  lint:\n    ${BOUND_KEY}: 10\n    steps:\n` +
          `      - run: echo one\n      - run: echo two\n        ${BOUND_KEY}: '5'\n`,
      },
      /step 2 states `timeout-minutes: "5"`, which this check does not read/,
    );
  });

  it('names the file it refused', () => {
    assert.throws(
      () => auditOver({ '.github/workflows/broken.yml': 'name: x\n' }),
      /\.github\/workflows\/broken\.yml/,
    );
  });
});

describe('refusals do not depend on drift state', () => {
  it('refuses a step shape in a job that also states no bound', () => {
    // The job owes a bound AND carries a step this check does not read. The
    // refusal wins: it is raised whether or not the bound is there, so
    // restoring the bound is never what first surfaces the shape.
    assert.throws(
      () =>
        auditOver({
          [WORKFLOW]: `jobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - echo hi\n`,
        }),
      (error) => error instanceof InputError && /step 1 is not a mapping/.test(error.message),
    );
  });

  it('refuses the same shape once the bound is restored', () => {
    assert.throws(
      () =>
        auditOver({
          [WORKFLOW]: `jobs:\n  lint:\n    ${BOUND_KEY}: 10\n    steps:\n      - echo hi\n`,
        }),
      (error) => error instanceof InputError && /step 1 is not a mapping/.test(error.message),
    );
  });
});

describe('jobsReader — the one read a run gives each workflow', () => {
  it('answers a repeat ask without reading the file again', () => {
    let reads = 0;
    const jobsAt = jobsReader((path) => {
      reads += 1;
      assert.equal(path, WORKFLOW);
      return workflow(job('lint', 15));
    });
    const first = jobsAt(WORKFLOW);
    assert.equal(jobsAt(WORKFLOW), first, 'the second ask answers with the first read');
    assert.equal(reads, 1);
  });

  it('reads each path it is asked about on its own', () => {
    const other = '.github/workflows/other.yml';
    const read = [];
    const jobsAt = jobsReader((path) => {
      read.push(path);
      return workflow(job('lint', 15));
    });
    jobsAt(WORKFLOW);
    jobsAt(other);
    jobsAt(WORKFLOW);
    assert.deepEqual(read, [WORKFLOW, other]);
  });

  it('gives both sets of legs one read per workflow rather than one each', () => {
    const files = cacheFiles();
    const reads = new Map();
    const reader = readerOver(files);
    const counting = (path) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return reader(path);
    };
    const listWorkflows = () => Object.keys(files);
    const jobsAt = jobsReader(counting);
    auditTreeOver(jobsAt, listWorkflows);
    auditCachesOver(jobsAt, counting, listWorkflows);
    assert.equal(reads.get(WORKFLOW), 1, 'the workflow is read once for both sets of legs');
  });

  it('leaves each leg reading its own reader where a run hands it none', () => {
    // The wrappers keep their own reader, so a caller of one set alone is
    // unchanged — and pays the read it always paid.
    const files = cacheFiles();
    const reads = new Map();
    const reader = readerOver(files);
    const counting = (path) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return reader(path);
    };
    const listWorkflows = () => Object.keys(files);
    auditTree(counting, listWorkflows);
    auditCaches(counting, listWorkflows);
    assert.equal(reads.get(WORKFLOW), 2);
  });

  it('leaves the first refusal where an unshared read raises it: the earlier file wins', () => {
    // Reading every workflow up front would answer with the LATER file's parse
    // refusal instead, because it reads that file before the bounds legs reach
    // the earlier one. Read lazily, the order the legs read in is the order the
    // refusals come in.
    const early = '.github/workflows/aaa.yml';
    const late = '.github/workflows/zzz.yml';
    const files = {
      [early]: workflow(
        `  lint:\n    ${BOUND_KEY}: "\${{ env.T }}"\n    steps:\n      - run: echo hi\n`,
      ),
      [late]: 'jobs:\n  lint:\n   - [unclosed\n',
    };
    assert.throws(
      () => auditTreeOver(jobsReader(readerOver(files)), () => Object.keys(files)),
      (error) => error instanceof InputError && /aaa\.yml job `lint` states/.test(error.message),
    );
  });
});

describe('readJobs, stepBounds, evaluateJob — the pieces the audit composes', () => {
  it('readJobs returns the jobs map as parsed', () => {
    const jobs = readJobs(() => workflow(job('lint', 15)), WORKFLOW);
    assert.deepEqual(Object.keys(jobs), ['lint']);
    assert.equal(jobs.lint[BOUND_KEY], 15);
  });

  it('stepBounds reads the bounded steps in order and skips the rest', () => {
    assert.deepEqual(
      stepBounds(WORKFLOW, 'lint', [
        { run: 'a' },
        { run: 'b', [BOUND_KEY]: 3 },
        { run: 'c', [BOUND_KEY]: 4 },
      ]),
      [3, 4],
    );
  });

  it('stepBounds reads an absent steps key as no bounded steps', () => {
    assert.deepEqual(stepBounds(WORKFLOW, 'lint', undefined), []);
  });

  it('evaluateJob reports what the job is, beside its problems', () => {
    assert.deepEqual(evaluateJob(WORKFLOW, 'test', { uses: './.github/workflows/test.yml' }), {
      problems: [],
      callsReusableWorkflow: true,
      bounded: false,
    });
  });
});

/* ── The cache legs ──────────────────────────────────────────────────────── */

/** A pin, as every fixture `uses:` carries one. */
const SHA = '@1111111111111111111111111111111111111111';

/**
 * One workflow stating both cache classes: a `builder` job whose registry
 * cache is a restore/save split under its own family, and a `tooling` job
 * caching one pinned tool's single installed file beside the install that
 * pins it.
 */
const SAMPLE_CACHE_WORKFLOW = [
  'name: Sample',
  '',
  'jobs:',
  '  builder:',
  '    timeout-minutes: 30',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Restore cargo registry',
  '        id: cargo-cache',
  `        uses: actions/cache/restore${SHA}`,
  '        with:',
  '          path: |',
  '            ~/.cargo/registry',
  '            ~/.cargo/git',
  "          key: ${{ runner.os }}-cargo-builder-${{ hashFiles('Cargo.lock') }}",
  '          restore-keys: |',
  '            ${{ runner.os }}-cargo-builder-',
  '            ${{ runner.os }}-cargo-',
  '      - name: Build',
  '        run: cargo build',
  '      - name: Save cargo registry',
  "        if: github.ref == 'refs/heads/main' && steps.cargo-cache.outputs.cache-hit != 'true'",
  `        uses: actions/cache/save${SHA}`,
  '        with:',
  '          path: |',
  '            ~/.cargo/registry',
  '            ~/.cargo/git',
  "          key: ${{ runner.os }}-cargo-builder-${{ hashFiles('Cargo.lock') }}",
  '  tooling:',
  '    timeout-minutes: 20',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Cache widget',
  '        id: cache-widget',
  `        uses: actions/cache${SHA}`,
  '        with:',
  '          path: ~/.cargo/bin/widget',
  '          key: ${{ runner.os }}-widget-2.3.4',
  '      - name: Install widget',
  "        if: steps.cache-widget.outputs.cache-hit != 'true'",
  '        run: cargo install widget --version 2.3.4 --locked',
  '',
].join('\n');

/** The CI guide's cache tables, as the fixture workflow makes them true. */
const SAMPLE_CI_DOC = [
  '# Guide',
  '',
  '## Job bounds and caches',
  '',
  `### ${CACHES_SUBSECTION}`,
  '',
  `| ${FAMILIES_HEADER.join(' | ')} |`,
  '| --- | --- | --- | --- | --- | --- |',
  "| `${{ runner.os }}-cargo-builder-` | `${{ hashFiles('Cargo.lock') }}` | " +
    '`~/.cargo/registry`, `~/.cargo/git` | `builder` | ' +
    '`${{ runner.os }}-cargo-builder-`, `${{ runner.os }}-cargo-` | main ref + exact miss |',
  '',
  `| ${TOOLS_HEADER.join(' | ')} |`,
  '| --- | --- | --- | --- |',
  '| `widget` | `2.3.4` | `2.3.4` | `2.3.4` |',
  '',
].join('\n');

/** The local-CI guide's subsection the doc-mention column is read from. */
const SAMPLE_LOCAL_DOC = [
  '# Local',
  '',
  '## Running one gate directly',
  '',
  `### ${MUTATION_RUNS_SUBSECTION}`,
  '',
  'Install widget (the job pins `2.3.4`), then run it.',
  '',
].join('\n');

/** The fixture files, with one mutation applied to the map. */
const cacheFiles = (mutate) => {
  const files = {
    [WORKFLOW]: SAMPLE_CACHE_WORKFLOW,
    [CI_DOC_PATH]: SAMPLE_CI_DOC,
    [LOCAL_CI_DOC_PATH]: SAMPLE_LOCAL_DOC,
  };
  return mutate ? mutate(files) || files : files;
};

/** The cache legs over a fixture map, listing exactly its own paths. */
const cacheAudit = (mutate) => {
  const files = cacheFiles(mutate);
  return auditCaches(readerOver(files), () => Object.keys(files));
};

/** Replace once inside one fixture file, asserting the anchor was there. */
const edit = (files, path, from, to) => {
  assert.ok(files[path].includes(from), `the fixture anchor "${from}" moved`);
  files[path] = files[path].replace(from, to);
};

/**
 * Replace EVERY occurrence — what a key edit needs, since a restore and its
 * save spell the same key and changing one alone is a different defect.
 */
const editAll = (files, path, from, to) => {
  assert.ok(files[path].includes(from), `the fixture anchor "${from}" moved`);
  files[path] = files[path].replaceAll(from, to);
};

/** The `builder` job's own path list, so a second writer can share its group. */
const BUILDER_PATHS = ['~/.cargo/registry', '~/.cargo/git'];

/**
 * A second workflow stating one family cache and nothing else. Its path list
 * defaults to the `builder` job's, so the two sit in ONE path-list group unless
 * a case hands over another list.
 */
const familyWorkflow = (job, family, paths = BUILDER_PATHS, hash = 'Cargo.lock') =>
  [
    'name: Second',
    '',
    'jobs:',
    `  ${job}:`,
    '    timeout-minutes: 10',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Restore',
    `        id: ${job}-cache`,
    `        uses: actions/cache/restore${SHA}`,
    '        with:',
    '          path: |',
    ...paths.map((path) => `            ${path}`),
    `          key: ${family}\${{ hashFiles('${hash}') }}`,
    '      - name: Save',
    `        if: github.ref == 'refs/heads/main' && steps.${job}-cache.outputs.cache-hit != 'true'`,
    `        uses: actions/cache/save${SHA}`,
    '        with:',
    '          path: |',
    ...paths.map((path) => `            ${path}`),
    `          key: ${family}\${{ hashFiles('${hash}') }}`,
    '',
  ].join('\n');

/**
 * A family entry as the leg reads one, for the grouping cases — every field a
 * real entry carries, the literal `key` and the save posture included, so a
 * case here exercises what `readCacheClasses` produces rather than a subset of
 * it.
 */
const familyEntry = (job, family, paths, hash = 'Cargo.lock', restoreKeys = []) => {
  const suffix = `\${{ hashFiles('${hash}') }}`;
  return {
    workflow: WORKFLOW,
    job,
    family,
    paths,
    restoreKeys,
    suffix,
    key: `${family}${suffix}`,
    gate: SPLIT_GATE,
    pathDrift: null,
  };
};

describe('the cache legs — the shipped fixture agrees with itself', () => {
  it('passes a workflow and guides that state the same caches', () => {
    const audit = cacheAudit();
    assert.deepEqual(audit.problems, []);
    assert.equal(audit.familyCount, 1);
    assert.equal(audit.toolCount, 1);
  });
});

describe('key families leg', () => {
  it('reds a Paths cell the step does not state, naming both sides', () => {
    const { problems } = cacheAudit(
      (files) =>
      edit(files, CI_DOC_PATH, '`~/.cargo/registry`, `~/.cargo/git` | `builder`', '`~/.cargo/registry` | `builder`'), // prettier-ignore
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /key families row `builder` states `Paths`/);
    assert.match(problems[0], /states "`~\/\.cargo\/registry`, `~\/\.cargo\/git`"/);
  });

  it('reds a Fallback cell that drops one restore key', () => {
    const { problems } = cacheAudit((files) =>
      edit(files, CI_DOC_PATH, ', `${{ runner.os }}-cargo-` | main ref', ' | main ref'),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states `Fallback`/);
  });

  it('reds a Save cell once the save loses its cache-hit conjunct', () => {
    const { problems } = cacheAudit((files) =>
      edit(files, WORKFLOW, " && steps.cargo-cache.outputs.cache-hit != 'true'", ''),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states `Save` as "main ref \+ exact miss"/);
    assert.match(problems[0], /states "github\.ref == 'refs\/heads\/main'"/);
  });

  it('reds a family entry no row describes', () => {
    const { problems } = cacheAudit((files) =>
      edit(files, CI_DOC_PATH, '| `builder` |', '| `other-job` |'),
    );
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => /row for `other-job`, which the tracked workflows state no such cache for/.test(p))); // prettier-ignore
    assert.ok(problems.some((p) => /`builder` that no key families row describes/.test(p)));
  });

  it('reds a row whose Writer job cell is not one backticked name', () => {
    const { problems } = cacheAudit((files) =>
      edit(files, CI_DOC_PATH, '| `builder` |', '| the builder job |'),
    );
    assert.ok(problems.some((p) => /`Writer job` cell is not one backticked name: the builder job/.test(p))); // prettier-ignore
  });

  it('reds a restore and a save stating different path lists', () => {
    const { problems } = cacheAudit((files) =>
      edit(
        files,
        WORKFLOW,
        "        with:\n          path: |\n            ~/.cargo/registry\n            ~/.cargo/git\n          key: ${{ runner.os }}-cargo-builder-${{ hashFiles('Cargo.lock') }}\n  tooling:",
        "        with:\n          path: |\n            ~/.cargo/registry\n          key: ${{ runner.os }}-cargo-builder-${{ hashFiles('Cargo.lock') }}\n  tooling:",
      ),
    );
    assert.ok(problems.some((p) => /different path lists on its restore and its save/.test(p)));
  });

  it('reds two family stems that nest inside one path-list group', () => {
    // A second writer under the SAME path list whose family is a PREFIX of the
    // first's: inside that group its fallback reaches the other's entries.
    const { problems } = cacheAudit((files) => {
      files['.github/workflows/second.yml'] = familyWorkflow('second', '${{ runner.os }}-cargo-');
    });
    assert.ok(problems.some((p) => /nest, both saved under the path list/.test(p)));
    assert.ok(problems.some((p) => /`\$\{\{ runner\.os \}\}-cargo-builder-` \(job `builder`\)/.test(p))); // prettier-ignore
  });

  it('leaves the same nesting alone across groups — no prefix reaches another list', () => {
    const { problems } = cacheAudit((files) => {
      files['.github/workflows/second.yml'] = familyWorkflow('second', '${{ runner.os }}-cargo-', [
        '~/.cache/ms-playwright',
      ]);
    });
    assert.deepEqual(
      problems.filter((p) => /nest, both saved under|one stem hashing one input/.test(p)),
      [],
    );
  });

  it('groups by the EXACT path list — overlapping lists are still two stores', () => {
    const together = [
      familyEntry('one', 'Linux-cargo-', ['~/.cargo/registry', '~/.cargo/git']),
      familyEntry('two', 'Linux-cargo-extra-', ['~/.cargo/registry', '~/.cargo/git']),
    ];
    assert.equal(prefixFreeProblems(together).length, 1);
    assert.match(prefixFreeProblems(together)[0], /`Linux-cargo-` \(job `one`\)/);
    // The same two names where one list is a SUBSET of the other: no restore
    // candidate crosses between the two stores, so nothing is asked of them.
    const apart = [together[0], { ...together[1], paths: ['~/.cargo/registry'] }];
    assert.deepEqual(prefixFreeProblems(apart), []);
    // And the shipped registry-only-beside-registry-and-target relation, taken
    // to its limit: even ONE stem stated on both sides asks nothing, because
    // the shorter list is a store of its own that nothing else can reach.
    assert.deepEqual(
      prefixFreeProblems([
        familyEntry('build', 'Linux-cargo-', [...together[0].paths, 'target']),
        familyEntry('registry-only', 'Linux-cargo-', together[0].paths),
      ]),
      [],
    );
  });

  it('admits one stem twice in a group over different hash inputs, and reds one input', () => {
    // The shipped Playwright pair's shape: one family prefix, one path list,
    // and the lockfile each key hashes is what tells their entries apart.
    const PLAYWRIGHT = ['~/.cache/ms-playwright'];
    const stem = 'Linux-playwright-';
    assert.deepEqual(
      prefixFreeProblems([
        familyEntry('e2e', stem, PLAYWRIGHT, 'e2e/package-lock.json'),
        familyEntry('integration', stem, PLAYWRIGHT, 'integration/package-lock.json'),
      ]),
      [],
    );
    const collided = prefixFreeProblems([
      familyEntry('e2e', stem, PLAYWRIGHT, 'e2e/package-lock.json'),
      familyEntry('integration', stem, PLAYWRIGHT, 'e2e/package-lock.json'),
    ]);
    assert.equal(collided.length, 1);
    assert.match(collided[0], /one stem hashing one input \(`'e2e\/package-lock\.json'`\)/);
    assert.match(collided[0], /state one key and share one entry/);
  });

  it('reads a split whose save states no gate at all as unconditional', () => {
    // Not the split posture and not an expression either: the save states no
    // `if:`, so it writes on every run and the cell that claims otherwise reds.
    const { problems } = cacheAudit(
      (files) =>
      edit(files, WORKFLOW, "        if: github.ref == 'refs/heads/main' && steps.cargo-cache.outputs.cache-hit != 'true'\n", ''), // prettier-ignore
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states `Save` as "main ref \+ exact miss"/);
    assert.match(problems[0], /states "unconditional"/);
  });

  it('reds a row whose cells run out before its identity column', () => {
    // A row too short to state a `Writer job` cell at all: the identity read
    // finds nothing there, which is the unreadable-cell red — and the entry
    // that row was describing is then a cache no row describes.
    const { problems } = cacheAudit(
      (files) =>
      edit(files, CI_DOC_PATH, ' | `builder` | ' + '`${{ runner.os }}-cargo-builder-`, `${{ runner.os }}-cargo-` | main ref + exact miss |', ' |'), // prettier-ignore
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /row whose `Writer job` cell is not one backticked name: an empty cell/); // prettier-ignore
    assert.match(problems[1], /states a key families cache for `builder` that no key families row describes/); // prettier-ignore
  });

  it('reds each cell a row runs out before, naming the column it never states', () => {
    // The identity cell is there, so the row is matched to its entry — and the
    // columns after it that the row never states read as empty cells rather
    // than as agreement.
    const { problems } = cacheAudit(
      (files) =>
      edit(files, CI_DOC_PATH, ' | `${{ runner.os }}-cargo-builder-`, `${{ runner.os }}-cargo-` | main ref + exact miss |', ' |'), // prettier-ignore
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /row `builder` states `Fallback` as an empty cell/);
    assert.match(problems[1], /row `builder` states `Save` as an empty cell/);
  });

  it('hashes the whole suffix where a caller hands over one stating no hashFiles', () => {
    // `readFamilyEntry` admits no such key, so this is the shape only a direct
    // caller can hand this leg: the whole suffix stands in as what the key is
    // computed from, and two stems over it are still one entry.
    const paths = ['~/.cargo/registry'];
    const problems = prefixFreeProblems([
      { job: 'one', family: 'Linux-cargo-', paths, suffix: 'v1' },
      { job: 'two', family: 'Linux-cargo-', paths, suffix: 'v1' },
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /one stem hashing one input \(`v1`\)/);
  });

  it('reds a wider prefix stated ahead of the family\u2019s own', () => {
    // The list is tried in order, so the bare `-cargo-` first would serve a
    // sibling's newer entry before this family's. The Fallback cell is moved
    // with it, so the row diff is silent and the ordering leg is what reds.
    const { problems } = cacheAudit((files) => {
      edit(
        files,
        WORKFLOW,
        '            ${{ runner.os }}-cargo-builder-\n            ${{ runner.os }}-cargo-',
        '            ${{ runner.os }}-cargo-\n            ${{ runner.os }}-cargo-builder-',
      );
      edit(
        files,
        CI_DOC_PATH,
        '`${{ runner.os }}-cargo-builder-`, `${{ runner.os }}-cargo-` | main ref',
        '`${{ runner.os }}-cargo-`, `${{ runner.os }}-cargo-builder-` | main ref',
      );
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states `\$\{\{ runner\.os \}\}-cargo-` as its first restore key/);
    assert.match(problems[0], /its family is `\$\{\{ runner\.os \}\}-cargo-builder-`/);
  });

  it('reds a fallback reaching an entry under a SHARED stem', () => {
    // The shipped Playwright pair's shape with a prefix added: the two keys
    // differ only in the hash, so a prefix on the stem drops the one thing
    // telling the entries apart and serves the other writer's artifact.
    const PLAYWRIGHT = ['~/.cache/ms-playwright'];
    const stem = 'Linux-playwright-';
    const reaching = fallbackReachProblems([
      familyEntry('e2e', stem, PLAYWRIGHT, 'e2e/package-lock.json', [stem]),
      familyEntry('integration', stem, PLAYWRIGHT, 'integration/package-lock.json'),
    ]);
    assert.equal(reaching.length, 1);
    assert.match(reaching[0], /job `e2e` states the restore key `Linux-playwright-`/);
    assert.match(reaching[0], /reaches job `integration`'s entry under the shared stem/);
    // With no fallback stated, the shared stem is the admitted shape it is.
    assert.deepEqual(
      fallbackReachProblems([
        familyEntry('e2e', stem, PLAYWRIGHT, 'e2e/package-lock.json'),
        familyEntry('integration', stem, PLAYWRIGHT, 'integration/package-lock.json'),
      ]),
      [],
    );
  });

  it('leaves a fallback on a shared stem that reaches no entry of it to the ordering leg', () => {
    // A key narrower than the stem: not the family's own prefix, so the ordering
    // property reds on it \u2014 while the other writer's key does not open with it,
    // so the reach property has nothing to say. One problem, not a pair.
    const PLAYWRIGHT = ['~/.cache/ms-playwright'];
    const stem = 'Linux-playwright-';
    const problems = fallbackReachProblems([
      familyEntry('e2e', stem, PLAYWRIGHT, 'e2e/package-lock.json', [`${stem}deadbeef`]),
      familyEntry('integration', stem, PLAYWRIGHT, 'integration/package-lock.json'),
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states `Linux-playwright-deadbeef` as its first restore key/);
  });

  it('leaves a fallback reaching a DIFFERENT stem alone \u2014 the shipped cargo shape', () => {
    const paths = ['~/.cargo/registry', '~/.cargo/git'];
    assert.deepEqual(
      fallbackReachProblems([
        familyEntry('one', 'Linux-cargo-rust-tests-', paths, 'Cargo.lock', [
          'Linux-cargo-rust-tests-',
          'Linux-cargo-',
        ]),
        familyEntry('two', 'Linux-cargo-vectors-', paths, 'Cargo.lock', [
          'Linux-cargo-vectors-',
          'Linux-cargo-',
        ]),
      ]),
      [],
    );
    // And across path-list groups the reach property has nothing to say: one
    // stem, but each entry saved under a list of its own, so neither fallback
    // reaches the other's entry.
    assert.deepEqual(
      fallbackReachProblems([
        familyEntry('one', 'Linux-playwright-', ['~/.cache/ms-playwright'], 'a.json', [
          'Linux-playwright-',
        ]),
        familyEntry('two', 'Linux-playwright-', ['~/.cache/other'], 'b.json'),
      ]),
      [],
    );
    // The ordering property is not group-scoped the way the reach property is:
    // an entry alone in its own group is held to it too.
    const lone = fallbackReachProblems([
      familyEntry('one', 'Linux-playwright-', ['~/.cache/ms-playwright'], 'a.json', ['Linux-']),
      familyEntry('two', 'Linux-playwright-', ['~/.cache/other'], 'b.json'),
    ]);
    assert.equal(lone.length, 1);
    assert.match(lone[0], /job `one` states `Linux-` as its first restore key/);
    assert.match(lone[0], /its family is `Linux-playwright-`/);
  });

  it('carries the COMBINED save posture into the Save cell', () => {
    // A family cache written as one combined step rather than a split: what
    // writes it is the action's own post-job save, on every run. The posture
    // exists in the check and this is the cell that states it.
    const combine = (files) => {
      edit(files, WORKFLOW, 'uses: actions/cache/restore', 'uses: actions/cache');
      edit(
        files,
        WORKFLOW,
        [
          '      - name: Save cargo registry',
          "        if: github.ref == 'refs/heads/main' && steps.cargo-cache.outputs.cache-hit != 'true'",
          `        uses: actions/cache/save${SHA}`,
          '        with:',
          '          path: |',
          '            ~/.cargo/registry',
          '            ~/.cargo/git',
          "          key: ${{ runner.os }}-cargo-builder-${{ hashFiles('Cargo.lock') }}",
          '',
        ].join('\n'),
        '',
      );
    };
    const drifted = cacheAudit(combine);
    assert.equal(drifted.problems.length, 1);
    assert.match(drifted.problems[0], /states `Save` as "main ref \+ exact miss"/);
    assert.match(drifted.problems[0], /states "every run \(post-job save\)"/);
    // The cell moved with it, and the posture round-trips.
    const agreed = cacheAudit((files) => {
      combine(files);
      edit(files, CI_DOC_PATH, '| main ref + exact miss |', `| ${COMBINED_GATE} |`);
    });
    assert.deepEqual(agreed.problems, []);
  });
});

describe('pinned tools leg', () => {
  it('reds an Install pin cell the step does not state', () => {
    const { problems } = cacheAudit(
      (files) =>
      edit(files, CI_DOC_PATH, '| `widget` | `2.3.4` | `2.3.4` |', '| `widget` | `2.3.4` | `9.9.9` |'), // prettier-ignore
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /pinned tools row `widget` states `Install pin` as "`9\.9\.9`"/);
  });

  it('reds a key version segment parting from the version the install pins', () => {
    const { problems } = cacheAudit(
      (files) =>
      edit(files, WORKFLOW, 'cargo install widget --version 2.3.4', 'cargo install widget --version 2.4.0'), // prettier-ignore
    );
    assert.ok(problems.some((p) => /keys `widget` on version `2\.3\.4` while its install pins `2\.4\.0`/.test(p))); // prettier-ignore
    assert.ok(problems.some((p) => /`2\.3\.4` beside `widget` while/.test(p)));
  });

  it('reds the Doc mention once the guide un-backticks its version', () => {
    const { problems } = cacheAudit((files) =>
      edit(files, LOCAL_CI_DOC_PATH, 'pins `2.3.4`', 'pins 2.3.4'),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`Doc mention` as "`2\.3\.4`"/);
    assert.match(problems[0], new RegExp(`${MUTATION_RUNS_SUBSECTION}\\) states "none"`));
  });

  it('reads `none` for a tool the subsection never names', () => {
    const { problems } = cacheAudit((files) => {
      edit(files, LOCAL_CI_DOC_PATH, 'Install widget (the job pins `2.3.4`), then run it.', 'Nothing here.'); // prettier-ignore
      edit(files, CI_DOC_PATH, '| `2.3.4` |\n', '| none |\n');
    });
    assert.deepEqual(problems, []);
  });

  it('reds a tool cache no row describes', () => {
    const { problems } = cacheAudit((files) => edit(files, CI_DOC_PATH, '| `widget` |', '| `gadget` |')); // prettier-ignore
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => /pinned tools cache for `widget` that no pinned tools row describes/.test(p))); // prettier-ignore
  });
});

describe('compareRows — every cell addressed by the column that names it', () => {
  /** One family entry, and the claims a caller states per column over it. */
  const ENTRY = {
    job: 'builder',
    workflow: WORKFLOW,
    family: 'stem-',
    gate: 'main ref + exact miss',
  };
  const claims = (entry) => [
    ['Family', `\`${entry.family}\``, 'the step'],
    ['Writer job', `\`${entry.job}\``, 'the step'],
    ['Save', entry.gate, 'the step'],
  ];

  /** The comparison over one hand-built table: a header, and one body row. */
  const over = (header, cells, expected = claims) =>
    compareRows({
      table: { header, rows: [cells] },
      docPath: CI_DOC_PATH,
      entries: [ENTRY],
      identity: 'Writer job',
      key: 'job',
      expected,
      what: 'key families',
    });

  const refuses = (call, pattern) =>
    assert.throws(call, (error) => {
      assert.ok(error instanceof InputError, `refused with ${error.constructor.name}`);
      assert.match(error.message, pattern);
      return true;
    });

  it('reads each cell by name, whatever order the header states the columns in', () => {
    assert.deepEqual(
      over(['Family', 'Writer job', 'Save'], ['`stem-`', '`builder`', 'main ref + exact miss']),
      [],
    );
    assert.deepEqual(
      over(['Save', 'Writer job', 'Family'], ['main ref + exact miss', '`builder`', '`stem-`']),
      [],
    );
  });

  it('names the column a cell disagrees on, not the one sitting at its index', () => {
    const problems = over(['Save', 'Writer job', 'Family'], ['always', '`builder`', '`stem-`']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /key families row `builder` states `Save` as "always"/);
  });

  it('names the identity column on a cell that is not one backticked name', () => {
    const problems = over(['Save', 'Writer job', 'Family'], ['main ref + exact miss', '', '`stem-`']); // prettier-ignore
    assert.ok(problems.some((problem) => /row whose `Writer job` cell is not one backticked name: an empty cell/.test(problem))); // prettier-ignore
  });

  it('refuses a table stating no column a claim names', () => {
    refuses(() => over(['Family', 'Writer job'], ['`stem-`', '`builder`']), /no `Save` column/);
  });

  it('refuses a claim naming a column the table does not state, whatever the rows name', () => {
    // The row names no entry, so no cell of it is ever read — and the claim
    // naming a column this header does not state is refused all the same,
    // rather than passing as the drift a row naming nothing would otherwise be.
    refuses(() => over(['Family', 'Writer job'], ['`stem-`', '`other-job`']), /no `Save` column/);
  });

  it('refuses a header stating one column name more than once', () => {
    // A cell is read by the column that names it, so the later `Save` would
    // stand for the name and the earlier one would be recomputed by nothing —
    // the unheld cell the coverage refusal beside it exists to rule out.
    refuses(
      () =>
        over(
          ['Family', 'Writer job', 'Save', 'Save'],
          ['`stem-`', '`builder`', 'not the posture', 'main ref + exact miss'],
        ),
      /with a repeated `Save` column/,
    );
  });

  it('refuses a table stating no column the row identity is read from', () => {
    const without = (entry) => claims(entry).filter(([column]) => column !== 'Writer job');
    refuses(
      () => over(['Family', 'Save'], ['`stem-`', 'main ref + exact miss'], without),
      /no `Writer job` column/,
    );
  });

  it('refuses a table stating a column no claim answers for', () => {
    refuses(
      () =>
        over(
          ['Family', 'Writer job', 'Save', 'Notes'],
          ['`stem-`', '`builder`', 'main ref + exact miss', 'free text'],
        ),
      /states a `Notes` column in the key families table that this leg reads no claim for/,
    );
  });
});

describe('cache shapes this check does not read — its own exit code', () => {
  const refuses = (mutate, pattern) => {
    assert.throws(
      () => cacheAudit(mutate),
      (error) => {
        assert.ok(error instanceof InputError, `expected an InputError, got ${error}`);
        assert.match(error.message, pattern);
        return true;
      },
    );
  };

  it('refuses a cache step stating no `with` map', () => {
    refuses(
      (files) =>
        edit(files, WORKFLOW, '        with:\n          path: ~/.cargo/bin/widget\n', '        env:\n          A: b\n'), // prettier-ignore
      /states no `with` map/,
    );
  });

  it('refuses a cache step stating no path this leg reads', () => {
    refuses(
      (files) => edit(files, WORKFLOW, '          path: ~/.cargo/bin/widget\n', '          path: |\n\n'), // prettier-ignore
      /states no `path` this leg reads/,
    );
  });

  it('refuses a cache step stating no key', () => {
    refuses(
      (files) => edit(files, WORKFLOW, '          key: ${{ runner.os }}-widget-2.3.4\n', ''),
      /states no `key` this leg reads/,
    );
  });

  it('refuses `restore-keys` written as something other than a string', () => {
    refuses(
      (files) =>
        edit(files, WORKFLOW, '          restore-keys: |\n            ${{ runner.os }}-cargo-builder-\n            ${{ runner.os }}-cargo-\n', '          restore-keys:\n            - a\n'), // prettier-ignore
      /states `restore-keys` as something other than a string/,
    );
  });

  it('refuses a key group it cannot pair — a restore with no save', () => {
    refuses(
      (files) =>
        edit(files, WORKFLOW, `      - name: Save cargo registry\n        if: github.ref == 'refs/heads/main' && steps.cargo-cache.outputs.cache-hit != 'true'\n        uses: actions/cache/save${SHA}\n`, '      - name: Save cargo registry\n        run: echo nothing\n'), // prettier-ignore
      /is stated by 1 cache step\(s\) this leg cannot group/,
    );
  });

  it('refuses a split whose restore states no id', () => {
    refuses(
      (files) => edit(files, WORKFLOW, '        id: cargo-cache\n', ''),
      /restore\/save split whose restore states no `id`/,
    );
  });

  it('refuses a family key that does not end in a hashFiles expression', () => {
    refuses(
      (files) =>
        editAll(files, WORKFLOW, "${{ runner.os }}-cargo-builder-${{ hashFiles('Cargo.lock') }}", '${{ runner.os }}-cargo-builder-v1'), // prettier-ignore
      /a family key is a prefix followed by a `hashFiles` expression/,
    );
  });

  it('refuses a tool key that does not name its own tool and a version', () => {
    refuses(
      (files) => edit(files, WORKFLOW, '          key: ${{ runner.os }}-widget-2.3.4', '          key: ${{ runner.os }}-tools-2.3.4'), // prettier-ignore
      /a tool key is `\$\{\{ runner\.os \}\}-widget-` followed by the version/,
    );
  });

  it('refuses a tool whose job states no matching cargo install', () => {
    refuses(
      (files) => edit(files, WORKFLOW, 'cargo install widget --version 2.3.4 --locked', 'echo skipped'), // prettier-ignore
      /states 0 `cargo install widget --version` command\(s\)/,
    );
  });

  it('refuses a single-file cache under ~/.cargo/bin that names no tool', () => {
    refuses(
      (files) => edit(files, WORKFLOW, '          path: ~/.cargo/bin/widget\n', '          path: ~/.cargo/bin/\n'), // prettier-ignore
      /caches `~\/\.cargo\/bin\/`, which names no tool this leg can read/,
    );
  });

  it('refuses two entries claiming one row identity', () => {
    assert.throws(
      () => {
        const files = cacheFiles();
        files['.github/workflows/other.yml'] = SAMPLE_CACHE_WORKFLOW;
        return auditCaches(readerOver(files), () => Object.keys(files));
      },
      (error) => error instanceof InputError && /names more than one key family entry/.test(error.message), // prettier-ignore
    );
  });

  it('refuses a guide it cannot read, and one that reads empty', () => {
    assert.throws(
      () => {
        const files = cacheFiles();
        delete files[CI_DOC_PATH];
        return auditCaches(readerOver(files), () => Object.keys(files));
      },
      (error) => error instanceof InputError && /ci\.md could not be read/.test(error.message),
    );
    refuses((files) => {
      files[LOCAL_CI_DOC_PATH] = '  \n';
    }, /local-ci\.md read empty/);
  });

  it('refuses a table its header selects other than once', () => {
    refuses(
      (files) => edit(files, CI_DOC_PATH, '| Family |', '| Families |'),
      /states 0 table\(s\) headed `Family \| Key suffix/,
    );
    refuses((files) => {
      files[CI_DOC_PATH] =
        `${SAMPLE_CI_DOC}\n${SAMPLE_CI_DOC.split('## Job bounds and caches')[1]}`;
    }, /states 2 table\(s\) headed/);
  });

  it('refuses a table that states no row', () => {
    refuses(
      (files) => edit(files, CI_DOC_PATH, '| `widget` | `2.3.4` | `2.3.4` | `2.3.4` |\n', ''),
      /states the pinned tools table with no rows/,
    );
  });

  it('refuses a doc-mention subsection that is not there', () => {
    refuses(
      (files) => edit(files, LOCAL_CI_DOC_PATH, `### ${MUTATION_RUNS_SUBSECTION}`, '### Elsewhere'),
      /is not there, or states nothing/,
    );
  });

  it('refuses a tree stating no cache of one class', () => {
    // The tooling job dropped: nothing under ~/.cargo/bin left to hold.
    refuses((files) => {
      files[WORKFLOW] = SAMPLE_CACHE_WORKFLOW.split('  tooling:')[0];
    }, /state no single-file cache under ~\/\.cargo\/bin\//);
    // The builder job dropped: nothing outside it left to hold.
    refuses((files) => {
      files[WORKFLOW] = `name: Sample\n\njobs:\n  tooling:${SAMPLE_CACHE_WORKFLOW.split('  tooling:')[1]}`; // prettier-ignore
    }, /state no cache outside ~\/\.cargo\/bin\//);
  });
});

describe('subsectionText, guideVersionFor, cacheSteps — the pieces the cache legs compose', () => {
  it('subsectionText takes one deeper heading inside one section, fences blanked', () => {
    const doc = [
      '## Elsewhere',
      '',
      '### The mutation runs',
      'wrong section',
      '',
      '## Running one gate directly',
      '',
      '### The mutation runs',
      'the text',
      '```bash',
      'not the text',
      '```',
      '',
      '### After',
      'also not',
    ].join('\n');
    const text = subsectionText(doc, {
      section: 'Running one gate directly',
      subsection: MUTATION_RUNS_SUBSECTION,
    });
    assert.match(text, /the text/);
    assert.doesNotMatch(text, /not the text/);
    assert.doesNotMatch(text, /wrong section/);
    assert.doesNotMatch(text, /also not/);
  });

  it('subsectionText answers with nothing where either heading is absent', () => {
    const section = 'Running one gate directly';
    const at = (markdown) => subsectionText(markdown, { section, subsection: MUTATION_RUNS_SUBSECTION }); // prettier-ignore
    // No such `##` section: there is nothing to cut the deeper heading out of.
    assert.equal(at(`## Elsewhere\n\n### ${MUTATION_RUNS_SUBSECTION}\nbody\n`), '');
    // The section is there and states no such deeper heading inside it.
    assert.equal(at(`## ${section}\n\nbody\n`), '');
  });

  it('subsectionText answers with the FIRST run of a heading stated more than once', () => {
    // Each cut opens at the first line matching its own pattern, so a repeated
    // heading is text after the boundary rather than more of the slice. The
    // reader this replaced joined the runs, which is what this case reds
    // against.
    const section = 'Running one gate directly';
    const doc = [
      `## ${section}`,
      '',
      `### ${MUTATION_RUNS_SUBSECTION}`,
      'the first run',
      '',
      '### Between',
      'neither run',
      '',
      `### ${MUTATION_RUNS_SUBSECTION}`,
      'the later run',
      '',
    ].join('\n');
    const text = subsectionText(doc, { section, subsection: MUTATION_RUNS_SUBSECTION });
    assert.match(text, /the first run/);
    assert.doesNotMatch(text, /the later run/);
    assert.doesNotMatch(text, /neither run/);
  });

  it('guideVersionFor takes the first version token after a WHOLE-WORD name', () => {
    assert.equal(guideVersionFor('widget', 'the `1.2` job `widget` pins `3.4.5` today'), '3.4.5');
    // A name inside a longer token is not the tool being named.
    assert.equal(guideVersionFor('widget', 'the `widget-runner` job pins `3.4.5`'), null);
    assert.equal(guideVersionFor('widget', 'nothing about it'), null);
    // Named, with no version after it anywhere: the guide states none.
    assert.equal(guideVersionFor('widget', 'install `9.9.9` before widget'), null);
  });

  it('cacheSteps skips a step that uses no cache action, and cacheEntries pairs by key', () => {
    const jobs = readJobs(() => SAMPLE_CACHE_WORKFLOW, WORKFLOW);
    const steps = cacheSteps(WORKFLOW, 'builder', jobs.builder);
    assert.deepEqual(
      steps.map((step) => step.kind),
      ['restore', 'save'],
    );
    const entries = cacheEntries(WORKFLOW, 'builder', steps);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].paths, ['~/.cargo/registry', '~/.cargo/git']);
    assert.equal(entries[0].gate, 'main ref + exact miss');
    assert.equal(entries[0].pathDrift, null);
  });

  it('cacheSteps reads a combined step as its own entry, saved every run', () => {
    const jobs = readJobs(() => SAMPLE_CACHE_WORKFLOW, WORKFLOW);
    const entries = cacheEntries(
      WORKFLOW,
      'tooling',
      cacheSteps(WORKFLOW, 'tooling', jobs.tooling),
    );
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].paths, ['~/.cargo/bin/widget']);
    assert.deepEqual(entries[0].restoreKeys, []);
    assert.equal(entries[0].gate, COMBINED_GATE);
  });

  it('every walk over a job’s steps refuses a block that is not a list, by name', () => {
    // Two readings take a job's `steps` through the one reader: the bounds
    // walk, and the cache leg's single read — which serves that leg's cache
    // walk and the install-pin walk inside a tool entry, so the install-pin
    // walk reads no block of its own. A block in a shape neither reading admits
    // is this check's own exit code at each of them, and each refusal names
    // what its own reading reads there; the clause the cache leg's whole-tree
    // read carries is pinned by the case below.
    const mapping = { 'cache widget': { uses: 'actions/cache' } };
    assert.throws(
      () => stepBounds(WORKFLOW, 'tooling', mapping),
      (error) =>
        error instanceof InputError &&
        error.message ===
          `${WORKFLOW} job \`tooling\` states \`steps\` as something other than a list — this check reads each step's bound there`, // prettier-ignore
    );
    assert.throws(
      () => cacheSteps(WORKFLOW, 'tooling', { steps: mapping }),
      (error) =>
        error instanceof InputError &&
        error.message ===
          `${WORKFLOW} job \`tooling\` states \`steps\` as something other than a list — this leg reads its cache steps there`, // prettier-ignore
    );
    // And a job stating none is an empty walk at each of them, never a refusal.
    assert.deepEqual(stepBounds(WORKFLOW, 'tooling', undefined), []);
    assert.deepEqual(cacheSteps(WORKFLOW, 'tooling', { 'runs-on': 'ubuntu-latest' }), []);
  });

  it('cacheSteps refuses a job that is not a mapping, and a step that is not one', () => {
    assert.throws(
      () => cacheSteps(WORKFLOW, 'tooling', 5),
      (error) =>
        error instanceof InputError &&
        /job `tooling` is not a mapping — this leg reads its cache steps there/.test(error.message), // prettier-ignore
    );
    assert.throws(
      () => cacheSteps(WORKFLOW, 'tooling', { steps: [{ run: 'ok' }, 5] }),
      (error) =>
        error instanceof InputError &&
        /job `tooling` step 2 is not a mapping — this leg reads its cache steps there/.test(error.message), // prettier-ignore
    );
  });

  it('the cache leg refuses a job it cannot read the block from, through each seam it is reached by', () => {
    // From the CLI the bounds walk refuses these shapes first, so the seams the
    // cache leg is reached through — `readCacheClasses` and `auditCaches` — are
    // what a case has to drive. The leg reads a job's steps ONCE, behind the
    // job-shape guard, and its clause names what that read serves, so the
    // job-shape refusal and the steps-shape refusal carry the same words.
    const clause = 'this leg reads its cache steps and install pins there';
    const jobShaped = (block) => `name: Sample\n\njobs:\n  tooling:${block}`;
    const refusals = [
      ['a null job', '\n', `job \`tooling\` is not a mapping — ${clause}`],
      ['a scalar job', ' 5\n', `job \`tooling\` is not a mapping — ${clause}`],
      ['a string job', ' steps\n', `job \`tooling\` is not a mapping — ${clause}`],
      ['a list-shaped job', '\n    - run: ok\n', `job \`tooling\` is not a mapping — ${clause}`],
      [
        'a mapping-shaped steps block',
        '\n    steps:\n      build: true\n',
        `job \`tooling\` states \`steps\` as something other than a list — ${clause}`,
      ],
    ];
    for (const [what, block, tail] of refusals) {
      const files = { [WORKFLOW]: jobShaped(block) };
      const refuses = (call) =>
        assert.throws(call, (error) => {
          assert.ok(error instanceof InputError, `${what} refused with ${error.constructor.name}`);
          assert.equal(error.message, `${WORKFLOW} ${tail}`, what);
          return true;
        });
      refuses(() => readCacheClasses(jobsReader(readerOver(files)), [WORKFLOW]));
      refuses(() => auditCaches(readerOver(files), () => Object.keys(files)));
    }
  });

  it('takes a tool’s install pin from the same steps block the cache walk read', () => {
    // The install-pin walk reads the block through the one reader too, so the
    // pin comes from exactly the list that was admitted: there is no second,
    // unvalidated read of `steps` left for that walk to end in a type error on.
    const files = cacheFiles();
    const { tools } = readCacheClasses(jobsReader(readerOver(files)), [WORKFLOW]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool, 'widget');
    assert.equal(tools[0].pin, '2.3.4');
  });
});

describe('real-tree lock', () => {
  it('the shipped workflows and guides satisfy every leg — through the CLI’s own tree listing', () => {
    const audit = auditTreeAt(ROOT);
    assert.deepEqual(audit.problems, []);
    assert.ok(audit.workflowCount > 0);
    assert.ok(audit.boundedJobs > 0);
    assert.ok(audit.callerJobs > 0, 'the tree carries the shape the platform bounds elsewhere');
    assert.ok(audit.familyCount > 0, 'the tree carries key families for their table to hold');
    assert.ok(audit.toolCount > 0, 'the tree carries pinned tool caches for their table to hold');
  });

  it('a root with no tracked workflows is refused, never passed vacuously', () => {
    // A tracked subdirectory is a working git cwd where the workflows listing
    // finds nothing — the refusal the empty listing raises, rather than a green
    // run over no files at all.
    assert.throws(
      () => auditTreeAt(resolve(ROOT, 'docs')),
      (error) => error instanceof InputError && /yielded no workflow file/.test(error.message),
    );
  });

  it('the constants still point where the check reads', () => {
    // SELF_PATH is derived from the file the check is written in, so reading it
    // back cannot fail while that file is the one being imported. What it does
    // hold — and what a bad derivation would break — is the SHAPE the verdicts
    // print: a repo-relative path under `scripts/`, resolving inside this tree,
    // with the platform's own separator nowhere in it.
    assert.match(SELF_PATH, /^scripts\/check-[a-z-]+\.js$/);
    assert.ok(readFileSync(resolve(ROOT, SELF_PATH), 'utf8').length > 0);
    assert.match(WORKFLOW_PATHSPEC, /^\.github\/workflows\//);
  });
});

describe('the CLI’s verdicts, over copies of the committed workflows', () => {
  const SCRIPT = join(ROOT, 'scripts', 'check-workflow-bounds.js');
  // The same tracked listing the check itself takes, so the copies are exactly
  // the population CI reads — plus the guides the cache legs read the
  // committed cache claims from, which the same copies have to carry.
  const TRACKED = [...trackedFilesUnder(WORKFLOW_PATHSPEC, { cwd: ROOT }), CI_DOC_PATH, LOCAL_CI_DOC_PATH]; // prettier-ignore
  let root = null;

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A fresh case directory under this suite's one throwaway root. */
  const caseDir = (prefix) => {
    root ??= mkdtempSync(join(tmpdir(), 'docent-bounds-cli-'));
    return mkdtempSync(join(root, prefix));
  };

  /** A throwaway git tree holding copies of the tracked workflows. */
  function tree(mutate = null) {
    const dir = caseDir('case-');
    const files = new Map(TRACKED.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
    if (mutate) mutate(files);
    for (const [rel, text] of files) {
      const target = join(dir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q', '-b', 'main']);
    git(['add', '.']);
    return dir;
  }

  /** Run the real CLI against a throwaway tree. */
  function run(dir) {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /** The line range one job occupies, by its own key. */
  const jobLines = (lines, jobId) => {
    const start = lines.findIndex((line) => line === `  ${jobId}:`);
    assert.notEqual(start, -1, `the job \`${jobId}\` moved`);
    const after = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
    return [start, after === -1 ? lines.length : after];
  };

  /** Delete one job's own bound line, the way a careless edit would. */
  const dropBound = (text, jobId) => {
    const lines = text.split('\n');
    const [start, end] = jobLines(lines, jobId);
    const bound = lines.findIndex(
      (line, index) => index > start && index < end && line.trim().startsWith(`${BOUND_KEY}:`),
    );
    assert.notEqual(bound, -1, `the job \`${jobId}\` states no bound to drop`);
    lines.splice(bound, 1);
    return lines.join('\n');
  };

  /** Raise one bound inside one job, anchored to that job rather than the file. */
  const raiseBound = (text, jobId, from, to) => {
    const lines = text.split('\n');
    const [start, end] = jobLines(lines, jobId);
    const at = lines.findIndex(
      (line, index) => index > start && index < end && line.trim() === `${BOUND_KEY}: ${from}`,
    );
    assert.notEqual(at, -1, `the job \`${jobId}\` states no bound of ${from} to raise`);
    lines[at] = lines[at].replace(`${BOUND_KEY}: ${from}`, `${BOUND_KEY}: ${to}`);
    return lines.join('\n');
  };

  it('exit 0 over pristine copies of the workflows it reads', () => {
    const { status, stdout } = run(tree());
    assert.equal(status, 0, stdout);
    assert.match(stdout, /workflow bounds hold/);
    // The cache verdict is asserted beside the bounds one: without it the
    // success line could lose the cache sentence and leave this lock green over
    // a check running half its legs.
    assert.match(stdout, /cache claims hold with them/);
  });

  it('exit 0 with an unbounded job in a nested YAML the boundary leaves outside', () => {
    // Tracked, and swept in by the listing's own pathspec, but not a workflow
    // the platform runs — so the boundary, not just the predicate, is observed
    // end to end.
    const { status, stdout } = run(
      tree((files) =>
        files.set(
          '.github/workflows/nested/inner.yml',
          'name: Nested\n\njobs:\n  unbounded:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
        ),
      ),
    );
    assert.equal(status, 0, stdout);
    assert.match(stdout, /workflow bounds hold/);
    assert.match(stdout, /cache claims hold with them/);
  });

  it('exit 1 naming the workflow and the job when a job bound is dropped', () => {
    const { status, stderr } = run(
      tree((files) => {
        const path = '.github/workflows/test.yml';
        files.set(path, dropBound(files.get(path), 'desktop-integration-tests'));
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /\.github\/workflows\/test\.yml/);
    assert.match(stderr, /job `desktop-integration-tests` states no `timeout-minutes` bound/);
    // The pointer the red carries to where these legs live.
    assert.ok(stderr.includes(SELF_PATH), 'the red names the check');
    assert.ok(stderr.includes(GUIDE_SECTION), 'the red names the guide section');
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /shape it does not read/);
  });

  it('exit 1 naming the sum and the bound when a step bound reaches its job’s', () => {
    const { status, stderr } = run(
      tree((files) => {
        const path = '.github/workflows/test.yml';
        files.set(path, raiseBound(files.get(path), 'extension-e2e-tests', 25, 30));
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /job `extension-e2e-tests` bounds its steps at 10 \+ 30 = 40 minute\(s\)/);
    assert.match(stderr, /own bound of 40 does not stand above/);
  });

  it('exit 2 with the machinery verdict when a workflow will not parse', () => {
    const { status, stderr } = run(
      tree((files) => files.set('.github/workflows/test.yml', 'jobs:\n  lint:\n   - [unclosed\n')),
    );
    assert.equal(status, 2);
    assert.match(stderr, /shape it does not read/);
    // Named by its file: the epilogue every exit-2 prints states the phrase
    // "does not parse as YAML" on its own, so only the path discriminates.
    assert.match(stderr, /test\.yml does not parse as YAML/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /bounds its steps/);
  });

  it('exit 2 where the tracked listing cannot be taken at all', () => {
    const { status, stderr } = run(caseDir('bare-'));
    assert.equal(status, 2);
    assert.match(stderr, /shape it does not read/);
  });

  it('exit 1 naming the guide, the row, and the column when a cache cell is falsified', () => {
    const { status, stderr } = run(
      tree((files) => {
        const before = files.get(CI_DOC_PATH);
        const after = before.replace('| `cargo-mutants`  | `27.1.0`', '| `cargo-mutants`  | `27.0.0`'); // prettier-ignore
        assert.notEqual(after, before, 'the pinned-tools row moved');
        files.set(CI_DOC_PATH, after);
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /pinned tools row `cargo-mutants` states `Key version segment`/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /shape it does not read/);
  });

  it('exit 2 with the machinery verdict when a cache table’s header is renamed', () => {
    const { status, stderr } = run(
      tree((files) => {
        const before = files.get(CI_DOC_PATH);
        const after = before.replace('| Family  ', '| Familie ');
        assert.notEqual(after, before, 'the key-families header moved');
        files.set(CI_DOC_PATH, after);
      }),
    );
    assert.equal(status, 2);
    assert.match(stderr, /shape it does not read/);
    assert.match(stderr, /states 0 table\(s\) headed/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /bounds its steps/);
  });

  it('exit 2 naming the earlier file’s bound, not the later file’s parse failure', () => {
    // The refusal a run raises is the FIRST one its legs reach, in the order
    // the listing yields. Reading every workflow before the legs run — the
    // shape a "parse each file once" rewrite reaches for first — replaces this
    // refusal with the later file's, so this case pins the reading order the
    // one-read-per-file seam has to keep.
    const EARLY = '.github/workflows/cla.yml';
    const LATE = '.github/workflows/test.yml';
    const listed = trackedFilesUnder(WORKFLOW_PATHSPEC, { cwd: ROOT });
    const at = (path) => {
      const index = listed.indexOf(path);
      assert.notEqual(index, -1, `${path} is no longer a tracked workflow this case can plant in`);
      return index;
    };
    assert.ok(at(EARLY) < at(LATE), `${EARLY} no longer precedes ${LATE}`);
    const { status, stderr } = run(
      tree((files) => {
        files.set(EARLY, raiseBound(files.get(EARLY), 'cla_assistant', 10, '"${{ env.T }}"'));
        files.set(LATE, 'jobs:\n  lint:\n   - [unclosed\n');
      }),
    );
    assert.equal(status, 2);
    assert.match(stderr, /shape it does not read/);
    assert.match(stderr, /cla\.yml job `cla_assistant` states `timeout-minutes: "\$\{\{ env\.T \}\}"`/); // prettier-ignore
    // The refusal reading the whole population up front would raise instead.
    // Named by its file: the epilogue every exit-2 prints states the phrase
    // "does not parse as YAML" on its own, so only the path discriminates.
    assert.doesNotMatch(stderr, /\.github\/workflows\/test\.yml/);
  });
});
