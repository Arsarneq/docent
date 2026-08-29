/**
 * check-workflow-bounds.test.js — Unit tests for the workflow-bounds admission
 * test (scripts/check-workflow-bounds.js). The bounds are committed data that
 * nothing else reads, so every direction must fail loud: these tests prove the
 * presence leg (a job stating no bound reds by name; a job calling a reusable
 * workflow, where the platform admits no bound, is not asked for one), the
 * composition leg (a bounded step set reaching its job's bound reds with its
 * addends, its sum, and that bound; a set below it passes; a step stating no
 * bound stays outside the sum), the workflow-file boundary this check reads
 * through, and every input shape it refuses on its own exit code rather than
 * passing vacuously — a workflow it cannot read, one that reads empty, one that
 * does not parse as YAML, a `jobs` that is not a map or is an empty one, a job
 * or step that is not a map, a `steps` that is not a list, a bound that is not
 * a literal positive number (an expression, a string, zero, a negative that
 * would otherwise cancel inside a sum), a listing that cannot be taken, and one
 * that yields no workflow file. The refusal ordering is pinned too: step shapes
 * are read whether or not the job states a bound, so a refusal never waits on
 * drift being fixed first. The CLI's own verdicts are pinned at the process
 * boundary over copies of the committed workflows, with each defect planted in
 * the copy; the tree itself is never broken to produce one. A real-tree lock
 * closes the set: the shipped workflows satisfy both legs.
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
  GUIDE_SECTION,
  InputError,
  SELF_PATH,
  WORKFLOW_PATHSPEC,
  auditTree,
  auditTreeAt,
  evaluateJob,
  readJobs,
  stepBounds,
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
    // summed, so the job passes on a bound the three together could exceed.
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

describe('real-tree lock', () => {
  it('the shipped workflows satisfy both legs — through the CLI’s own tree listing', () => {
    const audit = auditTreeAt(ROOT);
    assert.deepEqual(audit.problems, []);
    assert.ok(audit.workflowCount > 0);
    assert.ok(audit.boundedJobs > 0);
    assert.ok(audit.callerJobs > 0, 'the tree carries the shape the platform bounds elsewhere');
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
  // the population CI reads.
  const TRACKED = trackedFilesUnder(WORKFLOW_PATHSPEC, { cwd: ROOT });
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
    assert.match(stderr, /does not parse as YAML/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /bounds its steps/);
  });

  it('exit 2 where the tracked listing cannot be taken at all', () => {
    const { status, stderr } = run(caseDir('bare-'));
    assert.equal(status, 2);
    assert.match(stderr, /shape it does not read/);
  });
});
