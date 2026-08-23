/**
 * check-workflow-bounds.js — admission test for the time bounds the tracked
 * workflows carry. Two legs over the workflow files themselves — tracked YAML
 * directly under .github/workflows/, the boundary
 * scripts/check-doc-closure.js states for the guides' workflow inventory and
 * this check reads the same set through:
 *
 *   1. presence — every job states a `timeout-minutes` bound, so work that
 *      stops making progress ends as a failure at a stated ceiling. One shape
 *      states none: a job that calls a reusable workflow, written as a
 *      job-level `uses:`. The platform admits no `timeout-minutes` on such a
 *      job, and actionlint refuses a file that writes the key there, so what
 *      bounds that work is the called workflow's own job bounds.
 *   2. composition — where a job's steps state bounds of their own, those
 *      bounds add up to less than the job's. A job bound its step bounds can
 *      reach can fire before the last bounded step's own bound does: that step
 *      then ends by the job's cancellation rather than by its own bound, and
 *      the steps after it never run. Strictly below is what keeps each step
 *      bound the thing that ends its own step. A step stating no bound is
 *      outside the sum by construction, so this leg is a necessary condition
 *      on the bounded steps rather than a budget for the job.
 *
 * The numbers themselves live in the workflow files: a bound is a ceiling
 * above what its work has been measured to take, and raising one is an edit to
 * its own line. Where a workflow header frames its numbers — the headers of
 * .github/workflows/test.yml and .github/workflows/mutation.yml do — that
 * header is where the framing is stated; this check holds the two properties
 * above and states no number of its own.
 *
 * What this check reads is literal, positive numeric bounds. An input written
 * in a shape it does not read is the machinery verdict on this check's own
 * exit code (exit 2), never a silent pass and never drift (exit 1) — and such
 * a file can be perfectly legal for the platform. That class, in full: a
 * workflow that cannot be read, one that reads empty, one that does not parse
 * as YAML, a `jobs` that is not a map or that is an empty one, a job that is
 * not a map, a `steps` that is not a list, a step that is not a map, a bound
 * (job or step) that is not a number — an expression among them — or that is
 * not positive, a tracked listing that cannot be taken, and one that yields no
 * workflow file.
 *
 * A refusal never depends on drift state: a job's step shapes are read whether
 * or not the job states a bound of its own, and a refusal ends the run on exit
 * 2 even where a bound is missing beside it — so restoring a bound can never
 * be what first surfaces a shape this check does not read.
 *
 * Honest limits: this check reads the bounds, never their sizes — whether a
 * number sits far enough above its measurements is the reviewed judgment the
 * note beside it records. Whether the platform admits `timeout-minutes` on a
 * given job is actionlint's own verdict; this check reads the job-level
 * `uses:` shape to know which jobs state a bound of their own.
 *
 * Usage:
 *   node scripts/check-workflow-bounds.js  # or: npm run lint:workflow-bounds
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { trackedFilesUnder } from './check-test-inventory.js';
import { WORKFLOWS_DIR, WORKFLOW_FILE_RE } from './check-doc-closure.js';

/** This check's own path, as its verdict names where these legs live. */
export const SELF_PATH = 'scripts/check-workflow-bounds.js';

/** The guide section stating what these legs hold, named beside a drift red. */
export const GUIDE_SECTION = 'docs/guides/ci.md (§Job bounds and caches)';

/** The key a job and a step each state their bound under. */
export const BOUND_KEY = 'timeout-minutes';

/** The pathspec the tracked listing is taken over. */
export const WORKFLOW_PATHSPEC = `${WORKFLOWS_DIR}/*.y*ml`;

/**
 * An input this check reads that is in a shape it does not read — machinery
 * breakage, reported on the check's own exit code so it is never read as
 * drift.
 */
export class InputError extends Error {}

/** A YAML mapping, as both legs read one. */
const isMapping = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A bound this check can compare with another: a literal, positive number. */
const isBound = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The offending value as a message names it. JSON carries the spelling where it
 * can — so a quoted `'5'` is not named as the number 5 — and where it cannot, the
 * value's own spelling stands: an infinite or not-a-number bound is rendered as
 * `null` by JSON, which is not what the file states.
 */
const renderBound = (value) =>
  typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);

/**
 * The workflow files among a listing: tracked YAML directly under the
 * workflows directory. The boundary has one home — `WORKFLOW_FILE_RE` in
 * scripts/check-doc-closure.js, where the guides' workflow-inventory closure
 * states it — so this reads the same set through it. Applying it here is what
 * keeps the boundary: git's pathspec `*` crosses `/`, so the listing itself
 * sweeps nested YAML in.
 * @param {string[]} paths repo-relative paths from the listing
 * @returns {string[]} the workflow files among them, paths intact
 */
export function workflowPaths(paths) {
  return paths.filter((path) => WORKFLOW_FILE_RE.test(path));
}

/**
 * One workflow's `jobs` map, read through the reader it is handed.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {string} path the workflow's repo-relative path
 * @returns {Record<string, unknown>} the jobs map
 * @throws {InputError} naming the file and the shape it is in instead
 */
export function readJobs(readFile, path) {
  let text;
  try {
    text = readFile(path);
  } catch (error) {
    throw new InputError(`${path} could not be read — ${error.message}`);
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new InputError(`${path} read empty — this check reads its jobs' bounds from that text`);
  }
  let doc;
  try {
    doc = yaml.load(text);
  } catch (error) {
    throw new InputError(`${path} does not parse as YAML — ${error.message}`);
  }
  const jobs = doc?.jobs;
  if (!isMapping(jobs)) {
    throw new InputError(
      `${path} states no \`jobs\` map — this check reads each job's bound there`,
    );
  }
  if (Object.keys(jobs).length === 0) {
    throw new InputError(`${path} states an empty \`jobs\` map — this check reads each job's bound there`); // prettier-ignore
  }
  return jobs;
}

/**
 * The bounds one job's steps state, in step order.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown} steps the job's `steps` value
 * @returns {number[]} the bounds the bounded steps state
 * @throws {InputError} for a shape this leg does not read
 */
export function stepBounds(path, id, steps) {
  if (steps === undefined) return [];
  if (!Array.isArray(steps)) {
    throw new InputError(`${path} job \`${id}\` states \`steps\` as something other than a list — this check reads each step's bound there`); // prettier-ignore
  }
  const bounds = [];
  steps.forEach((step, index) => {
    if (!isMapping(step)) {
      throw new InputError(`${path} job \`${id}\` step ${index + 1} is not a mapping — this check reads its bound there`); // prettier-ignore
    }
    const bound = step[BOUND_KEY];
    if (bound === undefined) return;
    if (!isBound(bound)) {
      throw new InputError(`${path} job \`${id}\` step ${index + 1} states \`${BOUND_KEY}: ${renderBound(bound)}\`, which this check does not read — it reads literal, positive numbers`); // prettier-ignore
    }
    bounds.push(bound);
  });
  return bounds;
}

/**
 * Both legs over one job. The step shapes are read first, so a refusal never
 * depends on whether the job states a bound: a step this check does not read
 * is exit 2 whether or not the bound beside it went missing.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown} job the job's mapping
 * @returns {{ problems: string[], callsReusableWorkflow: boolean, bounded: boolean }}
 * @throws {InputError} for a shape these legs do not read
 */
export function evaluateJob(path, id, job) {
  if (!isMapping(job)) {
    throw new InputError(`${path} job \`${id}\` is not a mapping — this check reads its bound and its steps there`); // prettier-ignore
  }
  const callsReusableWorkflow = typeof job.uses === 'string';
  const bounds = stepBounds(path, id, job.steps);
  const bound = job[BOUND_KEY];
  if (bound === undefined) {
    const problems = callsReusableWorkflow
      ? []
      : [`${path} job \`${id}\` states no \`${BOUND_KEY}\` bound`];
    return { problems, callsReusableWorkflow, bounded: false };
  }
  if (!isBound(bound)) {
    throw new InputError(`${path} job \`${id}\` states \`${BOUND_KEY}: ${renderBound(bound)}\`, which this check does not read — it reads literal, positive numbers`); // prettier-ignore
  }
  const problems = [];
  if (bounds.length > 0) {
    const sum = bounds.reduce((total, each) => total + each, 0);
    if (sum >= bound) {
      problems.push(`${path} job \`${id}\` bounds its steps at ${bounds.join(' + ')} = ${sum} minute(s), which its own bound of ${bound} does not stand above`); // prettier-ignore
    }
  }
  return { problems, callsReusableWorkflow, bounded: true };
}

/**
 * Both legs over every workflow a listing yields.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {() => string[]} listWorkflows returns repo-relative workflow paths
 * @returns {{ problems: string[], workflowCount: number, boundedJobs: number,
 *             callerJobs: number }}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditTree(readFile, listWorkflows) {
  const paths = workflowPaths(listWorkflows());
  if (paths.length === 0) {
    throw new InputError(`the tracked listing under ${WORKFLOWS_DIR}/ yielded no workflow file — this check reads every job's bound from that listing`); // prettier-ignore
  }
  const problems = [];
  let boundedJobs = 0;
  let callerJobs = 0;
  for (const path of paths) {
    const jobs = readJobs(readFile, path);
    for (const [id, job] of Object.entries(jobs)) {
      const verdict = evaluateJob(path, id, job);
      problems.push(...verdict.problems);
      if (verdict.bounded) boundedJobs += 1;
      if (verdict.callsReusableWorkflow) callerJobs += 1;
    }
  }
  return { problems, workflowCount: paths.length, boundedJobs, callerJobs };
}

/**
 * Both legs over the real tree at `root` — the one listing the CLI and the
 * suite's real-tree lock share, so the lock exercises exactly what CI runs.
 * The listing is git-tracked, so an untracked local `.yml` cannot red a run CI
 * would pass.
 * @param {string} root repository root (absolute or relative)
 * @returns {ReturnType<typeof auditTree>}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditTreeAt(root) {
  // Through the shared population reader, so this listing states the same
  // quotepath policy every other tree scan does.
  const listWorkflows = () => {
    try {
      return trackedFilesUnder(WORKFLOW_PATHSPEC, { cwd: root });
    } catch (error) {
      throw new InputError(`the tracked listing under ${WORKFLOWS_DIR}/ could not be taken at \`${root}\` — ${error.message}`); // prettier-ignore
    }
  };
  return auditTree((path) => readFileSync(join(root, path), 'utf8'), listWorkflows);
}

/* c8 ignore start -- CLI wrapper: the legs above are unit-tested, and the
 * wrapper's exit codes are pinned at the process boundary by the spawned-CLI
 * cases in packages/shared/tests/unit; this glue reads the real tree and
 * formats the verdict. */
function run() {
  let audit;
  try {
    audit = auditTreeAt('.');
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(
      `✗ an input this check reads is in a shape it does not read:\n` +
        `    ${error.message}\n\n` +
        `  This check reads literal, positive numeric bounds. An input written in a shape\n` +
        `  it does not read — a bound as an expression or another non-number, or one that\n` +
        `  is not positive; a jobs or job block that is not a map, or an empty jobs map; a\n` +
        `  steps block that is not a list or a step that is not a map; a file it cannot\n` +
        `  read, one that reads empty, or one whose text does not parse as YAML; a tracked\n` +
        `  listing it cannot take, or one that yields no workflow file — is this verdict,\n` +
        `  and the file can be perfectly legal for the platform. Exit 2 keeps that apart\n` +
        `  from a bound that drifted (exit 1).\n`,
    );
    process.exit(2);
  }
  if (audit.problems.length > 0) {
    console.error(
      `✗ the tracked workflows' bounds:\n` +
        audit.problems.map((problem) => `    ${problem}`).join('\n') +
        `\n\n  Every job states a \`${BOUND_KEY}\` bound — a ceiling above what that job has\n` +
        `  been measured to take, so work that stops making progress ends as a failure\n` +
        `  there. The one shape that states none is a job calling a reusable workflow: the\n` +
        `  platform admits no bound there, and the called workflow's own job bounds bound\n` +
        `  that work. Where a job's steps state bounds, they add up to LESS than the\n` +
        `  job's, so each step bound is what ends its own step and the steps after it\n` +
        `  still run. Raise the job's bound on its own line, against measurement, rather\n` +
        `  than shaving a step below what it takes.\n` +
        `  See ${SELF_PATH} and ${GUIDE_SECTION} for what these legs hold.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ workflow bounds hold across ${audit.workflowCount} tracked workflow(s): ` +
      `${audit.boundedJobs} job(s) state a \`${BOUND_KEY}\` bound; ${audit.callerJobs} job(s) ` +
      `call a reusable workflow; every job whose steps state bounds keeps their sum below ` +
      `its own.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
