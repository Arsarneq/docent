/**
 * check-workflow-bounds.js — admission test for what the tracked workflows
 * state about time and about caching. Its legs read the workflow files
 * themselves — tracked YAML directly under .github/workflows/, the boundary
 * scripts/check-doc-closure.js states for the guides' workflow inventory and
 * this check reads the same set through — and, for the cache legs, the guides
 * that describe what those files cache.
 *
 * The BOUNDS legs, over the workflows alone:
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
 * The CACHE legs, over the workflows' cache steps and the tables docs/guides/ci.md
 * (§What the caches key on) states about them. Both tables are recomputed both
 * ways — an entry no row describes reds, and so does a row describing no entry:
 *
 *   3. key families — every cache entry whose path list is not a single file
 *      under ~/.cargo/bin takes a row stating its family prefix, the key
 *      suffix appended to it, its path list, its writing job, its
 *      `restore-keys`, and its save posture. Beside the row diff, the families
 *      are grouped by their EXACT path list — a restore candidate, exact or by
 *      prefix, comes only from an entry saved under the same one, so a group is
 *      the whole of what one family's keys can reach — and inside each group
 *      the family stems are held pairwise prefix-free: no stem nests inside
 *      another. Two writers may share one stem inside a group only where their
 *      keys hash DIFFERENT inputs, which is then what tells their entries
 *      apart; one stem over one input is a single entry with two writers. The
 *      `restore-keys` are held too — the ordering for every entry, the reach
 *      inside that same group: where an entry states any, the first is its own
 *      family prefix, whatever its group holds beside it, since the list is
 *      tried in order and anything ahead of that prefix either serves a
 *      sibling's newer entry or reaches nothing; and inside one group, an entry
 *      sharing its stem with another states none reaching that other entry,
 *      since the hash is the whole of what tells the two apart and a prefix
 *      drops it. A fallback reaching a DIFFERENT stem in the
 *      group is left alone: that is the warm start the Fallback column
 *      records.
 *   4. pinned tools — every cache entry that IS such a single file takes a row
 *      stating the tool, the version segment of its key, the version its job's
 *      `cargo install` pins, and the version the local-CI guide states beside
 *      that tool's own name. The segment is held to the pin, and the guide's
 *      version — where the guide states one — to the pin as well, so the
 *      segment, the pin and the guide's version move together or red.
 *
 * Each table admits one entry per its OWN identity column, and their identity
 * columns differ: the families table keys on the writing job's NAME, read bare
 * across the tracked population, so a family name may take two rows while a job
 * name takes one — two jobs sharing a name may not both write a family cache;
 * the tools table keys on the tool, so one tool may not be cached by two jobs.
 * Either shape is a refusal (exit 2), never a pass — the guide has no row to
 * describe it with. Both limits are stated in the guide's own prose beside the
 * tables they bind.
 *
 * The numbers themselves live in the workflow files: a bound is a ceiling
 * above what its work has been measured to take, and raising one is an edit to
 * its own line. Where a workflow header frames its numbers — the headers of
 * .github/workflows/test.yml and .github/workflows/mutation.yml do — that
 * header is where the framing is stated; this check holds the properties above
 * and states no number of its own.
 *
 * What this check reads is literal: positive numeric bounds, and cache steps
 * written as the shapes below. An input written in a shape it does not read is
 * the machinery verdict on this check's own exit code (exit 2), never a silent
 * pass and never drift (exit 1) — and such a file can be perfectly legal for
 * the platform. That class, in full: a workflow that cannot be read, one that
 * reads empty, one that does not parse as YAML, a `jobs` that is not a map or
 * that is an empty one, a job that is not a map, a `steps` that is not a list,
 * a step that is not a map, a bound (job or step) that is not a number — an
 * expression among them — or that is not positive, a tracked listing that
 * cannot be taken, and one that yields no workflow file; and, for the cache
 * legs, a cache step whose `with` block, `path`, or `key` is not the shape they
 * read, a `restore-keys` that is not a string, a key group that is neither one
 * combined step nor one restore paired with one save, a split whose restore
 * states no `id`, a family key that does not end in a `hashFiles` expression, a
 * tool cache path under ~/.cargo/bin/ that names no tool, a tool key that does
 * not name its own tool and a version after it, a tool whose job states other
 * than one matching `cargo install`, two entries claiming one row identity, a
 * guide that cannot be read, one that reads empty, a table its header selects
 * other than once or that states no row, a table stating no column one of its
 * cells is read by name from, one stating a column no such read answers for,
 * one whose header states a column name more than once, a guide subsection the
 * doc-mention read is scoped to that is not there, and either cache class
 * yielding no entry at all. A subsection that IS there and
 * states no version for a tool is not in that class: the doc-mention column
 * records what the guide states, so a version un-backticked or a sentence
 * dropped reds on the cell.
 *
 * A refusal never depends on drift state: a job's step shapes are read whether
 * or not the job states a bound of its own, and a refusal ends the run on exit
 * 2 even where a bound is missing beside it — so restoring a bound can never
 * be what first surfaces a shape this check does not read. Nor does it depend
 * on a file the run has not reached: the workflow population is read lazily, in
 * listing order, so the refusal a run raises is the first one its legs reach,
 * in leg order and then listing order; within a leg, a later file's shape never
 * stands in front of an earlier file's.
 *
 * Honest limits: this check reads the bounds, never their sizes — whether a
 * number sits far enough above its measurements is the reviewed judgment the
 * note beside it records. Whether the platform admits `timeout-minutes` on a
 * given job is actionlint's own verdict; this check reads the job-level
 * `uses:` shape to know which jobs state a bound of their own. On the cache
 * side it reads what the steps STATE, never what a run restores: whether an
 * entry is resident, and what a fallback actually served, are facts of the
 * platform's cache store. The doc-mention read is scoped to one guide
 * subsection and takes the first version-shaped backticked token after the
 * tool's own name there, so a second tool named in that subsection without a
 * version of its own would read the next tool's — reported as a disagreeing
 * cell rather than passed over.
 *
 * Usage:
 *   node scripts/check-workflow-bounds.js  # or: npm run lint:workflow-bounds
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  escapeForRegExp,
  extractHeadingSection,
  flattenWhitespace,
  selectTablesByHeader,
  selfPath,
  stripFences,
  trackedFilesUnder,
} from './check-test-inventory.js';
import {
  CI_DOC_PATH,
  LOCAL_CI_DOC_PATH,
  WORKFLOWS_DIR,
  WORKFLOW_PATHSPEC,
  workflowPaths,
} from './check-doc-closure.js';

export const SELF_PATH = selfPath(import.meta.filename);

/** The `##` section of the CI guide the bounds and the cache tables sit in. */
export const BOUNDS_SECTION = 'Job bounds and caches';

/** The deeper heading inside it that states the key-families and pinned-tools tables. */
export const CACHES_SUBSECTION = 'What the caches key on';

/** The local-CI guide's `##` section, and the subsection the tool versions sit in. */
export const LOCAL_CI_SECTION = 'Running one gate directly';
export const MUTATION_RUNS_SUBSECTION = 'The mutation runs';

/**
 * The guide surfaces stating what these legs hold, named beside a drift red.
 * Both are named because both are read: the CI guide states the key-families
 * and pinned-tools tables, and the local-CI guide states the version the
 * doc-mention column carries.
 */
export const GUIDE_SECTION =
  `${CI_DOC_PATH} (§${BOUNDS_SECTION}) and ` +
  `${LOCAL_CI_DOC_PATH} (§${MUTATION_RUNS_SUBSECTION})`;

/** The key a job and a step each state their bound under. */
export const BOUND_KEY = 'timeout-minutes';

/** The header of the key-families table, whole, as the selector matches it. */
export const FAMILIES_HEADER = ['Family', 'Key suffix', 'Paths', 'Writer job', 'Fallback', 'Save'];

/** The header of the pinned-tools table, whole. */
export const TOOLS_HEADER = ['Tool', 'Key version segment', 'Install pin', 'Doc mention'];

/** The directory a pinned tool's install leaves its one file in. */
export const TOOL_CACHE_DIR = '~/.cargo/bin/';

/** What a cell states where the step states no list at all. */
export const NO_ENTRY = 'none';

/**
 * The save postures a cell states in place of spelling the step's gate out —
 * the ones with names here: a split whose save carries the canonical gate
 * {@link splitGateFor} builds, the combined step's post-job save, and a split
 * whose save states no gate at all. Any other gate goes into the cell as the
 * expression the step spells.
 */
export const SPLIT_GATE = 'main ref + exact miss';
export const COMBINED_GATE = 'every run (post-job save)';
export const UNGATED_SAVE = 'unconditional';

/** The actions a cache step is written through, as its `uses` names them. */
export const CACHE_USES = {
  'actions/cache': 'combined',
  'actions/cache/restore': 'restore',
  'actions/cache/save': 'save',
};

/**
 * The pathspec the tracked listing is taken over, and the filter its answer is
 * held to — both re-exported rather than restated, so the workflow set this
 * check reads is the one [`check-doc-closure.js`](./check-doc-closure.js)
 * states for the guides' workflow inventory, decided once for both. The guide
 * paths come from there for the same reason.
 */
export { WORKFLOW_PATHSPEC, workflowPaths, CI_DOC_PATH, LOCAL_CI_DOC_PATH };

/**
 * An input this check reads that is in a shape it does not read — machinery
 * breakage, reported on the check's own exit code so it is never read as
 * drift.
 */
export class InputError extends Error {}

/** A YAML mapping, as every leg here reads one. */
const isMapping = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A bound this check can compare with another: a literal, positive number. */
const isBound = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * One job's `steps` as a list, read through the one place every walk over them
 * reads it. The bounds walk reads a job's steps once here, and the cache leg
 * reads them once here too — that single read serving both of the walks the leg
 * runs over them, its cache walk and the install-pin walk inside a tool entry,
 * which reads no `steps` block of its own. A block in a shape neither reading
 * admits is refused here by name: the fold turns a type error a future caller
 * or a reordering would hit into this check's own exit code, where a type error
 * would be exit 1 with a stack trace — this check's DRIFT verdict — and the
 * shape belongs on exit 2. Each read states in its own clause what it reads
 * there, so a refusal still names the reading that raised it.
 *
 * Not the `jobSteps` [`check-ci-filter.js`](./check-ci-filter.js) exports and
 * [`check-doc-closure.js`](./check-doc-closure.js) reads through: that one
 * takes a block in a shape it does not read as no steps, which is the silent
 * pass this check's own contract rules out. The readers are named apart because
 * their postures differ.
 * @param {string} where the workflow and the job, as a message names them
 * @param {unknown} steps the job's `steps` value
 * @param {string} reads what the calling walk reads in that block
 * @returns {unknown[]} the steps, empty where the job states none
 * @throws {InputError} for a `steps` that is not a list
 */
function readSteps(where, steps, reads) {
  if (steps === undefined) return [];
  if (!Array.isArray(steps)) {
    throw new InputError(`${where} states \`steps\` as something other than a list — ${reads}`);
  }
  return steps;
}

/**
 * One job's shape, guarded, and the prefix every message over that job names it
 * by. Both walks that read a job come through here — the bounds legs and the
 * cache leg's steps read — each with its own clause, so how a job-shape refusal
 * reads is written once and a refusal still names the walk that raised it.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown} job the job's mapping
 * @param {string} reads what the calling walk reads in that job
 * @returns {string} the workflow and the job, as a message names them
 * @throws {InputError} for a job that is not a mapping
 */
function readJobMapping(path, id, job, reads) {
  const where = `${path} job \`${id}\``;
  if (!isMapping(job)) {
    throw new InputError(`${where} is not a mapping — ${reads}`);
  }
  return where;
}

/**
 * One job's admitted `steps` list: the job-shape guard and the read of that
 * block, together, so a walk over a job's steps performs one read behind one
 * guard. Both refusals carry the caller's own clause — what that walk reads in
 * the block it asked for — so a refusal names the reading that raised it
 * whichever of the two shapes was wrong.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown} job the job's mapping
 * @param {string} reads what the calling walk reads in that block
 * @returns {unknown[]} the job's steps, empty where it states none
 * @throws {InputError} for a job that is not a mapping, and for a `steps` block
 *   that is not a list
 */
function readJobSteps(path, id, job, reads) {
  return readSteps(readJobMapping(path, id, job, reads), job.steps, reads);
}

/**
 * The offending value as a message names it. JSON carries the spelling where it
 * can — so a quoted `'5'` is not named as the number 5 — and where it cannot, the
 * value's own spelling stands: an infinite or not-a-number bound is rendered as
 * `null` by JSON, which is not what the file states.
 */
const renderBound = (value) =>
  typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);

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
 * One workflow's `jobs` map at a path, read once per run however many legs ask
 * for it. Both audits below read every workflow the listing yields, so a reader
 * of their own has each file opened and parsed once per leg; one reader handed
 * to both has it opened and parsed once.
 *
 * The read is lazy and keyed on the path, so the order the files are read in —
 * and with it the refusal a bad one raises, and the point in the run it is
 * raised at — is exactly what an unshared reader raises. A second ask for a
 * path already read is the only call this answers without reading.
 * @param {(path: string) => string} readFile repo-relative reader
 * @returns {(path: string) => Record<string, unknown>} that path's jobs map
 * @throws {InputError} whatever {@link readJobs} raises for the file, on the
 *   first ask for it
 */
export function jobsReader(readFile) {
  const parsed = new Map();
  return (path) => {
    if (!parsed.has(path)) parsed.set(path, readJobs(readFile, path));
    return parsed.get(path);
  };
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
  const where = `${path} job \`${id}\``;
  const bounds = [];
  readSteps(where, steps, "this check reads each step's bound there").forEach((step, index) => {
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
 * Both bounds legs over one job. The step shapes are read first, so a refusal
 * never depends on whether the job states a bound: a step this check does not
 * read is exit 2 whether or not the bound beside it went missing.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown} job the job's mapping
 * @returns {{ problems: string[], callsReusableWorkflow: boolean, bounded: boolean }}
 * @throws {InputError} for a shape these legs do not read
 */
export function evaluateJob(path, id, job) {
  const where = readJobMapping(path, id, job, 'this check reads its bound and its steps there');
  const callsReusableWorkflow = typeof job.uses === 'string';
  const bounds = stepBounds(path, id, job.steps);
  const bound = job[BOUND_KEY];
  if (bound === undefined) {
    const problems = callsReusableWorkflow ? [] : [`${where} states no \`${BOUND_KEY}\` bound`];
    return { problems, callsReusableWorkflow, bounded: false };
  }
  if (!isBound(bound)) {
    throw new InputError(`${where} states \`${BOUND_KEY}: ${renderBound(bound)}\`, which this check does not read — it reads literal, positive numbers`); // prettier-ignore
  }
  const problems = [];
  if (bounds.length > 0) {
    const sum = bounds.reduce((total, each) => total + each, 0);
    if (sum >= bound) {
      problems.push(`${where} bounds its steps at ${bounds.join(' + ')} = ${sum} minute(s), which its own bound of ${bound} does not stand above`); // prettier-ignore
    }
  }
  return { problems, callsReusableWorkflow, bounded: true };
}

/**
 * Both bounds legs over every workflow a listing yields, read through the jobs
 * reader they are handed — so a run reading both these legs and the cache legs
 * hands one reader to both and each file is read once.
 * @param {(path: string) => Record<string, unknown>} jobsAt a jobs reader
 * @param {() => string[]} listWorkflows returns repo-relative workflow paths
 * @returns {{ problems: string[], workflowCount: number, boundedJobs: number,
 *             callerJobs: number }}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditTreeOver(jobsAt, listWorkflows) {
  const paths = readWorkflowPaths(listWorkflows);
  const problems = [];
  let boundedJobs = 0;
  let callerJobs = 0;
  for (const path of paths) {
    const jobs = jobsAt(path);
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
 * The bounds legs through a reader of their own. The one read each workflow
 * gets is the whole of what this adds; the legs and the refusals they raise are
 * {@link auditTreeOver}'s. This seam is for a caller holding a file reader that
 * wants these legs alone — the suite's own cases over them, and the name the
 * sibling check scripts' whole-tree audits are reached by. A caller running
 * both leg sets takes {@link auditTreeAt}, which builds one reader for both.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {() => string[]} listWorkflows returns repo-relative workflow paths
 * @returns {ReturnType<typeof auditTreeOver>}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditTree(readFile, listWorkflows) {
  return auditTreeOver(jobsReader(readFile), listWorkflows);
}

/* ── The cache legs ──────────────────────────────────────────────────────── */

/** The workflow paths a listing yields, refused where it yields none. */
function readWorkflowPaths(listWorkflows) {
  const paths = workflowPaths(listWorkflows());
  if (paths.length === 0) {
    throw new InputError(`the tracked listing under ${WORKFLOWS_DIR}/ yielded no workflow file — this check reads every job's bound and every cache step from that listing`); // prettier-ignore
  }
  return paths;
}

/** A key's trailing `${{ hashFiles(...) }}` expression, and the family before it. */
const FAMILY_KEY_RE = /^(.*?)(\$\{\{\s*hashFiles\([^)]*\)\s*\}\})$/;

/** A trailing `${{ ... }}` expression on a cache path, as the tool caches write one. */
const PATH_SUFFIX_EXPRESSION_RE = /\$\{\{[^}]*\}\}$/;

/** A `cargo install <tool> --version <v>`, as the install steps spell one. */
const installPinRe = (tool) =>
  new RegExp(`cargo install ${escapeForRegExp(tool)} --version (\\S+)`, 'g');

/** A version a guide sentence or a key segment states. */
const VERSION_RE = /^\d+(?:\.\d+)+$/;

/** The action a `uses:` names, with its pin dropped. */
const usesAction = (uses) => (uses.includes('@') ? uses.slice(0, uses.indexOf('@')) : uses);

/** A `path:` block as its own list: one entry per non-empty line. */
const pathList = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** A cell rendering a list of tokens, or `none` where the step states no list. */
const renderList = (items) =>
  items.length === 0 ? NO_ENTRY : items.map((item) => `\`${item}\``).join(', ');

/** A cell rendering one token. */
const renderOne = (value) => (value === null ? NO_ENTRY : `\`${value}\``);

/** The exact path list an entry is saved under, as the grouping keys on it. */
const pathListKey = (entry) => entry.paths.join('\n');

/** The arguments a key's trailing `hashFiles` expression states. */
const HASH_INPUTS_RE = /hashFiles\(([^)]*)\)/;

/**
 * What a family key's suffix hashes: the `hashFiles` arguments, whitespace
 * flattened, so a difference here is a difference in what the key is computed
 * FROM rather than in how the expression is spelled. Every family entry carries
 * that expression by construction — `readFamilyEntry` refuses a key without one
 * — and the whole suffix stands in only if some caller hands over another shape.
 */
const hashInputs = (suffix) => flattenWhitespace(HASH_INPUTS_RE.exec(suffix)?.[1] ?? suffix);

/** The `if:` a gated save states, as this leg spells the split posture. */
const splitGateFor = (restoreId) =>
  `github.ref == 'refs/heads/main' && steps.${restoreId}.outputs.cache-hit != 'true'`;

/**
 * What the cache walk states it reads, for the caller that wants the cache
 * steps alone: the clause the exported {@link cacheSteps} hands both the job's
 * own read and the walk over the steps it admits. A caller reading the block
 * for more than this walk hands its own clause down instead.
 */
const CACHE_STEPS_CLAUSE = 'this leg reads its cache steps there';

/**
 * The cache steps an admitted `steps` list states, each read into the fields the
 * legs compare. The list is one {@link readJobSteps} has already admitted, so
 * this walk asks nothing of the job itself. The clause travels with the list:
 * the step-shape refusal below carries what the caller's own read states it
 * reads there, so the words a refusal prints are the caller's whichever seam
 * reached this walk.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown[]} steps the job's admitted steps
 * @param {string} reads what the calling read states it reads in that block
 * @returns {{ kind: string, stepId: string|null, key: string, paths: string[],
 *             restoreKeys: string[], gate: string|null }[]}
 * @throws {InputError} for a shape this leg does not read
 */
function cacheStepsOf(path, id, steps, reads) {
  const found = [];
  steps.forEach((step, index) => {
    if (!isMapping(step)) {
      // The tree walk refuses a step in this shape first, so no run of the CLI
      // arrives here; this stands for a direct caller.
      throw new InputError(`${path} job \`${id}\` step ${index + 1} is not a mapping — ${reads}`); // prettier-ignore
    }
    if (typeof step.uses !== 'string') return;
    const kind = CACHE_USES[usesAction(step.uses)];
    if (kind === undefined) return;
    const where = `${path} job \`${id}\` step ${index + 1} (\`${usesAction(step.uses)}\`)`;
    if (!isMapping(step.with)) {
      throw new InputError(`${where} states no \`with\` map — this leg reads its path list and its key there`); // prettier-ignore
    }
    if (typeof step.with.path !== 'string' || pathList(step.with.path).length === 0) {
      throw new InputError(`${where} states no \`path\` this leg reads — it reads one or more non-empty lines`); // prettier-ignore
    }
    if (typeof step.with.key !== 'string' || step.with.key.trim() === '') {
      throw new InputError(`${where} states no \`key\` this leg reads — it reads a non-empty string`); // prettier-ignore
    }
    const restoreKeysValue = step.with['restore-keys'];
    if (restoreKeysValue !== undefined && typeof restoreKeysValue !== 'string') {
      throw new InputError(`${where} states \`restore-keys\` as something other than a string — this leg reads one key per line`); // prettier-ignore
    }
    found.push({
      kind,
      stepId: typeof step.id === 'string' ? step.id : null,
      key: step.with.key.trim(),
      paths: pathList(step.with.path),
      restoreKeys: restoreKeysValue === undefined ? [] : pathList(restoreKeysValue),
      gate: typeof step.if === 'string' ? flattenWhitespace(step.if) : null,
    });
  });
  return found;
}

/**
 * The cache steps one job states — the job's own shape read first, then the walk
 * over the steps it admits. A caller wanting the same job's install pins too
 * takes {@link readJobSteps} itself and hands the admitted list to both walks,
 * which is what the cache classes below do; this seam is for a caller that wants
 * the cache steps alone.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown} job the job's mapping
 * @returns {ReturnType<typeof cacheStepsOf>}
 * @throws {InputError} for a shape this leg does not read
 */
export function cacheSteps(path, id, job) {
  const steps = readJobSteps(path, id, job, CACHE_STEPS_CLAUSE);
  return cacheStepsOf(path, id, steps, CACHE_STEPS_CLAUSE);
}

/**
 * One job's cache steps grouped into entries by key: a combined step stands
 * alone, and a restore is paired with the save writing the same key. Any other
 * grouping is a shape this leg does not read.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {ReturnType<typeof cacheSteps>} steps that job's cache steps
 * @returns {{ workflow: string, job: string, key: string, paths: string[],
 *             restoreKeys: string[], gate: string, pathDrift: string|null }[]}
 * @throws {InputError} for a grouping this leg does not read
 */
export function cacheEntries(path, id, steps) {
  const byKey = new Map();
  for (const step of steps) {
    if (!byKey.has(step.key)) byKey.set(step.key, []);
    byKey.get(step.key).push(step);
  }
  const entries = [];
  for (const [key, group] of byKey) {
    const where = `${path} job \`${id}\` cache key \`${key}\``;
    const combined = group.filter((s) => s.kind === 'combined');
    const restores = group.filter((s) => s.kind === 'restore');
    const saves = group.filter((s) => s.kind === 'save');
    let source;
    let gate;
    if (combined.length === 1 && group.length === 1) {
      source = combined[0];
      gate = source.gate ?? COMBINED_GATE;
    } else if (restores.length === 1 && saves.length === 1 && group.length === 2) {
      source = restores[0];
      if (source.stepId === null) {
        throw new InputError(`${where} is a restore/save split whose restore states no \`id\` — this leg reads the save's gate against that id`); // prettier-ignore
      }
      gate = saves[0].gate === splitGateFor(source.stepId) ? SPLIT_GATE : (saves[0].gate ?? UNGATED_SAVE); // prettier-ignore
    } else {
      throw new InputError(`${where} is stated by ${group.length} cache step(s) this leg cannot group — it reads one combined step, or one restore paired with one save`); // prettier-ignore
    }
    const other = group.find((s) => s !== source);
    const pathDrift =
      other && other.paths.join('\n') !== source.paths.join('\n')
        ? `${where} states different path lists on its restore and its save — ${renderList(source.paths)} against ${renderList(other.paths)}` // prettier-ignore
        : null;
    entries.push({
      workflow: path,
      job: id,
      key,
      paths: source.paths,
      restoreKeys: source.restoreKeys,
      gate,
      pathDrift,
    });
  }
  return entries;
}

/** A cache entry storing one pinned tool's single installed file. */
const isToolCache = (entry) =>
  entry.paths.length === 1 && entry.paths[0].startsWith(TOOL_CACHE_DIR);

/**
 * The classes of cache entry the tables describe — key families and pinned
 * tools — read from every workflow a listing yields.
 *
 * `jobsAt` answers a path with that workflow's jobs map, never with its text: a
 * file reader handed over in its place answers with a string, whose entries are
 * its characters, and the job-shape guard below refuses the first of them as
 * "job `0` is not a mapping". That refusal is the tell.
 *
 * Each job's `steps` block is read once here, and the admitted list serves both
 * of the walks this leg runs over it — the cache walk and, for a tool entry, the
 * install-pin walk — so the clause the refusals carry names both.
 * @param {(path: string) => Record<string, unknown>} jobsAt answers a path with
 *   that workflow's jobs map
 * @param {string[]} paths the workflow paths
 * @returns {{ families: object[], tools: object[], pathDrift: string[] }}
 * @throws {InputError} for a shape these legs do not read
 */
export function readCacheClasses(jobsAt, paths) {
  const families = [];
  const tools = [];
  const pathDrift = [];
  const reads = 'this leg reads its cache steps and install pins there';
  for (const path of paths) {
    const jobs = jobsAt(path);
    for (const [id, job] of Object.entries(jobs)) {
      const steps = readJobSteps(path, id, job, reads);
      for (const entry of cacheEntries(path, id, cacheStepsOf(path, id, steps, reads))) {
        if (entry.pathDrift) pathDrift.push(entry.pathDrift);
        if (isToolCache(entry)) tools.push(readToolEntry(entry, steps));
        else families.push(readFamilyEntry(entry));
      }
    }
  }
  refuseDuplicateIdentity(families, 'job', 'key family');
  refuseDuplicateIdentity(tools, 'tool', 'pinned tool cache');
  return { families, tools, pathDrift };
}

/** The row identity each table keys on must name one entry, or nothing can. */
function refuseDuplicateIdentity(entries, field, what) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry[field])) {
      throw new InputError(`\`${entry[field]}\` names more than one ${what} entry — the table keys its rows on that name, so this leg reads one entry per name`); // prettier-ignore
    }
    seen.add(entry[field]);
  }
}

/** A family entry: its key split into the prefix a fallback names and the suffix. */
function readFamilyEntry(entry) {
  const match = FAMILY_KEY_RE.exec(entry.key);
  if (match === null) {
    throw new InputError(`${entry.workflow} job \`${entry.job}\` states the key \`${entry.key}\`, which this leg does not read — a family key is a prefix followed by a \`hashFiles\` expression`); // prettier-ignore
  }
  return { ...entry, family: match[1], suffix: match[2] };
}

/**
 * A tool entry: the tool its path names, its key's version segment, and its pin.
 * The steps are the ones its job's read already admitted, so the install-pin
 * walk reads no `steps` block of its own.
 */
function readToolEntry(entry, steps) {
  const file = entry.paths[0].slice(TOOL_CACHE_DIR.length);
  const tool = file.replace(PATH_SUFFIX_EXPRESSION_RE, '').replace(/\.exe$/, '');
  if (tool === '') {
    throw new InputError(`${entry.workflow} job \`${entry.job}\` caches \`${entry.paths[0]}\`, which names no tool this leg can read under ${TOOL_CACHE_DIR}`); // prettier-ignore
  }
  const prefix = `\${{ runner.os }}-${tool}-`;
  if (!entry.key.startsWith(prefix) || entry.key.length === prefix.length) {
    throw new InputError(`${entry.workflow} job \`${entry.job}\` states the key \`${entry.key}\` for tool \`${tool}\`, which this leg does not read — a tool key is \`${prefix}\` followed by the version`); // prettier-ignore
  }
  const pins = [];
  for (const step of steps) {
    if (!isMapping(step) || typeof step.run !== 'string') continue;
    for (const match of step.run.matchAll(installPinRe(tool))) pins.push(match[1]);
  }
  if (pins.length !== 1) {
    throw new InputError(`${entry.workflow} job \`${entry.job}\` states ${pins.length} \`cargo install ${tool} --version\` command(s) — this leg reads the pin from exactly one`); // prettier-ignore
  }
  return { ...entry, tool, keyVersion: entry.key.slice(prefix.length), pin: pins[0] };
}

/**
 * One guide's text, or the refusal that it is not where this check reads it.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {string} path the guide's repo-relative path
 * @returns {string}
 * @throws {InputError} naming the guide and what it answered with
 */
export function readGuide(readFile, path) {
  let text;
  try {
    text = readFile(path);
  } catch (error) {
    throw new InputError(`${path} could not be read — ${error.message}`);
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new InputError(`${path} read empty — this check reads its cache claims from that text`);
  }
  return text;
}

/**
 * The lines of one deeper heading inside one `##` section, fences blanked so an
 * example inside one is never read as the section's own prose. Both cuts are
 * the shared {@link extractHeadingSection} — the one heading slice, in
 * `check-test-inventory.js`, which finds both of its boundaries on the
 * fence-stripped view (the one fence model, `stripFences`) and returns the raw
 * lines between them — so a `#` line inside an illustrative fence neither opens
 * a section nor ends one here either. What this reading states of its own is
 * the pattern pairs, the blanking, and which run wins: the `##` section is
 * written out in full and ends at the next heading of level one or two, the
 * deeper heading inside it is any level below `##` and ends at a heading of any
 * level, the slice comes back through `stripFences` because this reader's caller
 * reads the subsection as the section's own prose, and a heading stated more
 * than once yields its FIRST run — each cut opens at the first line matching its
 * own pattern, so a second `## Job bounds and caches`, or a second deeper
 * heading inside the one that opened, is text after the boundary rather than
 * more of the slice.
 * @param {string} markdown the document
 * @param {object} where the section and the deeper heading inside it
 * @returns {string} the subsection's own lines, headings excluded
 */
export function subsectionText(markdown, { section, subsection }) {
  const sectionBody = extractHeadingSection(
    markdown,
    new RegExp(`^##\\s+${escapeForRegExp(section)}\\s*$`),
    /^#{1,2}\s/,
  );
  if (sectionBody === null) return '';
  const body = extractHeadingSection(
    sectionBody,
    new RegExp(`^#{3,6}\\s+${escapeForRegExp(subsection)}\\s*$`),
    /^#{1,6}\s/,
  );
  return body === null ? '' : stripFences(body);
}

/**
 * The one table a header tuple selects inside a subsection, refused where it
 * selects any other number or states no row: a leg over no rows holds nothing.
 * @param {string} docText the document
 * @param {string} docPath the document's repo-relative path
 * @param {string[]} header the whole header this table states
 * @param {string} what how the report names this table
 * @returns {{ header: string[], rows: string[][] }}
 * @throws {InputError} where the selection is not exactly one non-empty table
 */
export function selectOneTable(docText, docPath, header, what) {
  const { tables, matches } = selectTablesByHeader(docText, {
    header,
    section: BOUNDS_SECTION,
    subsection: CACHES_SUBSECTION,
  });
  if (matches !== 1) {
    throw new InputError(`${docPath} (§${CACHES_SUBSECTION}) states ${matches} table(s) headed \`${header.join(' | ')}\` — this leg reads the ${what} from exactly one`); // prettier-ignore
  }
  if (tables[0].rows.length === 0) {
    throw new InputError(`${docPath} (§${CACHES_SUBSECTION}) states the ${what} table with no rows — this leg reads its claims from those rows`); // prettier-ignore
  }
  return tables[0];
}

/**
 * The version one guide subsection states beside a tool's own name: the first
 * version-shaped backticked token after a whole-word occurrence of the name.
 * Null where the subsection states none — because it never names the tool, or
 * because it names it and no version token follows. Null is what a `none` cell
 * states, so un-backticking a version, or dropping the sentence carrying it,
 * is drift the Doc mention column reds on rather than a shape this leg
 * refuses: the column records what the guide states, and the guide then states
 * nothing.
 * @param {string} tool the tool's name
 * @param {string} text the subsection's own text
 * @returns {string | null}
 */
export function guideVersionFor(tool, text) {
  const flat = flattenWhitespace(text);
  const versions = [...flat.matchAll(/`([^`]+)`/g)]
    .filter((match) => VERSION_RE.test(match[1]))
    .map((match) => ({ token: match[1], at: match.index }));
  for (const occurrence of flat.matchAll(
    new RegExp(`(?<![-\\w])${escapeForRegExp(tool)}(?![-\\w])`, 'g'),
  )) {
    const after = occurrence.index + tool.length;
    const next = versions.find((version) => version.at >= after);
    if (next) return next.token;
  }
  return null;
}

/**
 * One table's rows against the entries they describe, both ways: an entry no
 * row names, a row naming no entry, a row whose identity cell is unreadable,
 * and each cell that disagrees with the surface it describes. Every cell is
 * addressed by its COLUMN NAME — `identity` names the column carrying the row's
 * own name, and `expected` returns one `[column, text, surface]` claim per
 * column — so a red names the surface that answers for that cell (the step for
 * most of them, a guide subsection for the doc-mention column) and the column
 * the caller asked for, never whichever column happens to sit at an index.
 *
 * The columns are held both ways, as the rows are: a claim naming a column the
 * table does not state, and a column the table states that no claim answers
 * for, are each a refusal naming that column — the second because a column no
 * claim answers for would carry an unrecomputed cell. Both are decided off the
 * claims read up front, so neither waits on a row naming an entry, and the
 * coverage is held per entry: each entry's claims answer for every column the
 * table states, so claims that vary from entry to entry cannot stop recomputing
 * a column for part of the table. A header stating one column name more than
 * once is refused on that name as well — a cell is read by the column that
 * names it, so the repeat would leave the column it shadows recomputed by
 * nothing. Each refusal is source-guarded: a column set changes only when the
 * header constant here and the guide's own table are edited together, so no
 * document alone can reach one and there is none to hunt for.
 * @param {object} how the table, its entries, and how each is rendered
 * @returns {string[]} problem lines
 * @throws {InputError} naming a column one side states and the other does not,
 *   and a column name the header states more than once
 */
export function compareRows({ table, docPath, entries, identity, key, expected, what }) {
  const columns = new Map();
  for (const [index, cell] of table.header.entries()) {
    const column = cell.trim();
    if (columns.has(column)) {
      throw new InputError(`${docPath} states the ${what} table with a repeated \`${column}\` column — a cell is read by the column that names it, so one name over more than one column leaves a cell recomputed by nothing`); // prettier-ignore
    }
    columns.set(column, index);
  }
  const columnOf = (column) => {
    const index = columns.get(column);
    if (index === undefined) {
      throw new InputError(`${docPath} states the ${what} table with no \`${column}\` column — this leg reads that cell from every row of it`); // prettier-ignore
    }
    return index;
  };
  const identityColumn = columnOf(identity);
  // Every claim is read once here and its column resolved beside the identity
  // column, so a claim naming a column the table does not state is refused
  // whether or not a row names that entry — and the row loop below reads the
  // index this resolved rather than asking again.
  const claims = new Map(
    entries.map((entry) => [
      entry[key],
      expected(entry).map(([column, want, surface]) => [columnOf(column), column, want, surface]),
    ]),
  );
  // The coverage is held per entry, so every column the table states is
  // recomputed on every row. With no entry at all it holds nothing — which
  // through `auditCaches` is unreachable: its empty-class guards refuse a class
  // with no entry before either table is read.
  for (const entryClaims of claims.values()) {
    const answered = new Set([identity, ...entryClaims.map(([, column]) => column)]);
    for (const column of columns.keys()) {
      if (!answered.has(column)) {
        throw new InputError(`${docPath} states a \`${column}\` column in the ${what} table that this leg reads no claim for — every cell of these tables is recomputed, so a column nothing answers for would state a claim no surface is held to`); // prettier-ignore
      }
    }
  }
  const problems = [];
  const named = new Set();
  for (const row of table.rows) {
    const cell = (row[identityColumn] ?? '').trim();
    const match = /^`([^`]+)`$/.exec(cell);
    if (match === null) {
      problems.push(`${docPath} states a ${what} row whose \`${identity}\` cell is not one backticked name: ${cell === '' ? 'an empty cell' : cell}`); // prettier-ignore
      continue;
    }
    const name = match[1];
    const entryClaims = claims.get(name);
    if (entryClaims === undefined) {
      problems.push(`${docPath} states a ${what} row for \`${name}\`, which the tracked workflows state no such cache for`); // prettier-ignore
      continue;
    }
    named.add(name);
    for (const [index, column, want, surface] of entryClaims) {
      const have = flattenWhitespace(row[index] ?? '');
      if (have !== want) {
        const stated = have === '' ? 'an empty cell' : `"${have}"`;
        problems.push(`${docPath} ${what} row \`${name}\` states \`${column}\` as ${stated} where ${surface} states "${want}"`); // prettier-ignore
      }
    }
  }
  for (const entry of entries) {
    if (!named.has(entry[key])) {
      problems.push(`${entry.workflow} job \`${entry.job}\` states a ${what} cache for \`${entry[key]}\` that no ${what} row describes`); // prettier-ignore
    }
  }
  return problems;
}

/**
 * The family entries grouped by their EXACT path list — the unit both grouped
 * legs below reason over, since a restore candidate, exact or by prefix, comes
 * only from an entry saved under the same list.
 * @param {object[]} families the family entries
 * @returns {object[][]} one array per path list
 */
function groupByPathList(families) {
  const groups = new Map();
  for (const entry of families) {
    const group = pathListKey(entry);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  return [...groups.values()];
}

/**
 * The family stems held pairwise prefix-free inside each path-list group. A
 * restore candidate — exact or by prefix — comes only from an entry saved under
 * the same path list, so families sharing one EXACT path list are the whole of
 * what each other's keys can reach; families whose lists differ at all reach
 * nothing of one another's, however their names relate, and nothing is asked of
 * them. Grouping by identity is what makes a red here a reach that exists: two
 * lists that merely overlap are still two stores.
 *
 * What reds inside a group: a stem nesting inside another, where the shorter
 * one's prefix fallback reaches the longer one's entries; and one stem shared by
 * two writers whose keys hash the SAME input: their keys are then equal, so the
 * two jobs write and read a single entry. A stem shared over DIFFERENT inputs is
 * how two writers honestly sit in one group — the hash is what tells their
 * entries apart — and is left alone.
 * @param {object[]} families the family entries
 * @returns {string[]} problem lines
 */
export function prefixFreeProblems(families) {
  const problems = [];
  for (const group of groupByPathList(families)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        const under = `both saved under the path list ${renderList(a.paths)}`;
        if (a.family === b.family) {
          if (hashInputs(a.suffix) === hashInputs(b.suffix)) {
            problems.push(`the family names \`${a.family}\` (job \`${a.job}\`) and \`${b.family}\` (job \`${b.job}\`) are one stem hashing one input (\`${hashInputs(a.suffix)}\`), ${under} — the two jobs state one key and share one entry`); // prettier-ignore
          }
        } else if (a.family.startsWith(b.family) || b.family.startsWith(a.family)) {
          problems.push(`the family names \`${a.family}\` (job \`${a.job}\`) and \`${b.family}\` (job \`${b.job}\`) nest, ${under} — inside one path list a prefix fallback reaches the other family's entries`); // prettier-ignore
        }
      }
    }
  }
  return problems;
}

/**
 * What each family's `restore-keys` reaches, held to the properties below —
 * ones the review has been carrying by eye. The list is tried IN ORDER, and each
 * prefix serves the most recent entry matching it, so order and width are both
 * load-bearing:
 *
 *   1. own prefix first — where an entry states any fallback, the first one is
 *      its own family prefix. A wider prefix ahead of it matches this family's
 *      own entries too, and would serve a sibling's newer entry while the
 *      family's own sits unused; its own prefix first makes the widening a
 *      widening.
 *   2. no fallback across a shared stem — inside one path-list group, an entry
 *      whose stem another entry also states may name no fallback that reaches
 *      that other entry. Two writers share a stem only where their keys hash
 *      DIFFERENT inputs (`prefixFreeProblems` admits exactly that), so the hash
 *      is the whole of what tells their entries apart, and a prefix fallback
 *      drops it: the fallback would serve the OTHER writer's artifact under a
 *      key naming this writer's input. A shared stem therefore carries no
 *      fallback at all — its own prefix included, which is the one property 1
 *      would otherwise ask for.
 *
 * A fallback reaching a DIFFERENT stem inside one group is left alone: that is
 * a warm start from a related tree, it is the shipped cargo families' stated
 * design, and the Fallback column records it for review. What is held here is
 * the reach no review can read as deliberate.
 * @param {object[]} families the family entries
 * @returns {string[]} problem lines
 */
export function fallbackReachProblems(families) {
  const problems = [];
  for (const group of groupByPathList(families)) {
    for (const entry of group) {
      const keys = entry.restoreKeys;
      const where = `${entry.workflow} job \`${entry.job}\``;
      if (keys.length > 0 && keys[0] !== entry.family) {
        problems.push(`${where} states \`${keys[0]}\` as its first restore key while its family is \`${entry.family}\` — the list is tried in order, so the first restore key is the family's own prefix; anything else ahead of it either reaches a sibling's entry or reaches nothing`); // prettier-ignore
      }
      for (const other of group) {
        if (other === entry || other.family !== entry.family) continue;
        for (const key of keys) {
          if (!other.key.startsWith(key)) continue;
          problems.push(`${where} states the restore key \`${key}\`, which reaches job \`${other.job}\`'s entry under the shared stem \`${entry.family}\`, both saved under the path list ${renderList(entry.paths)} — the hash is the whole of what tells those two entries apart, and a prefix fallback drops it`); // prettier-ignore
        }
      }
    }
  }
  return problems;
}

/**
 * Both cache legs over every workflow a listing yields and the guides that
 * describe what they cache. The workflows are read through the jobs reader
 * these legs are handed; the guides through the file reader beside it.
 * @param {(path: string) => Record<string, unknown>} jobsAt a jobs reader
 * @param {(path: string) => string} readFile repo-relative reader, for the guides
 * @param {() => string[]} listWorkflows returns repo-relative workflow paths
 * @returns {{ problems: string[], familyCount: number, toolCount: number }}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditCachesOver(jobsAt, readFile, listWorkflows) {
  const paths = readWorkflowPaths(listWorkflows);
  const { families, tools, pathDrift } = readCacheClasses(jobsAt, paths);
  if (families.length === 0) {
    throw new InputError(`the tracked workflows state no cache outside ${TOOL_CACHE_DIR} — the key-families leg would hold nothing over them`); // prettier-ignore
  }
  if (tools.length === 0) {
    throw new InputError(`the tracked workflows state no single-file cache under ${TOOL_CACHE_DIR} — the pinned-tools leg would hold nothing over them`); // prettier-ignore
  }
  const ciDoc = readGuide(readFile, CI_DOC_PATH);
  const localDoc = readGuide(readFile, LOCAL_CI_DOC_PATH);
  const mutationRuns = subsectionText(localDoc, {
    section: LOCAL_CI_SECTION,
    subsection: MUTATION_RUNS_SUBSECTION,
  });
  const guideWhere = `${LOCAL_CI_DOC_PATH} (§${MUTATION_RUNS_SUBSECTION})`;
  if (flattenWhitespace(mutationRuns) === '') {
    throw new InputError(`${guideWhere} is not there, or states nothing — this leg reads each tool's doc mention from it`); // prettier-ignore
  }
  const familiesTable = selectOneTable(ciDoc, CI_DOC_PATH, FAMILIES_HEADER, 'key families');
  const toolsTable = selectOneTable(ciDoc, CI_DOC_PATH, TOOLS_HEADER, 'pinned tools');
  const guideVersions = new Map(
    tools.map((tool) => [tool.tool, guideVersionFor(tool.tool, mutationRuns)]),
  );
  const problems = [
    ...pathDrift,
    ...prefixFreeProblems(families),
    ...fallbackReachProblems(families),
    ...compareRows({
      table: familiesTable,
      docPath: CI_DOC_PATH,
      entries: families,
      identity: 'Writer job',
      key: 'job',
      what: 'key families',
      expected: (entry) => {
        const step = `${entry.workflow} job \`${entry.job}\``;
        return [
          ['Family', renderOne(entry.family), step],
          ['Key suffix', renderOne(entry.suffix), step],
          ['Paths', renderList(entry.paths), step],
          ['Writer job', renderOne(entry.job), step],
          ['Fallback', renderList(entry.restoreKeys), step],
          ['Save', entry.gate, step],
        ];
      },
    }),
    ...compareRows({
      table: toolsTable,
      docPath: CI_DOC_PATH,
      entries: tools,
      identity: 'Tool',
      key: 'tool',
      what: 'pinned tools',
      expected: (entry) => {
        const step = `${entry.workflow} job \`${entry.job}\``;
        return [
          ['Tool', renderOne(entry.tool), step],
          ['Key version segment', renderOne(entry.keyVersion), step],
          ['Install pin', renderOne(entry.pin), step],
          ['Doc mention', renderOne(guideVersions.get(entry.tool)), guideWhere],
        ];
      },
    }),
  ];
  for (const tool of tools) {
    if (tool.keyVersion !== tool.pin) {
      problems.push(`${tool.workflow} job \`${tool.job}\` keys \`${tool.tool}\` on version \`${tool.keyVersion}\` while its install pins \`${tool.pin}\` — a hit would serve a binary the key does not name`); // prettier-ignore
    }
    const stated = guideVersions.get(tool.tool);
    if (stated !== null && stated !== tool.pin) {
      problems.push(`${guideWhere} states \`${stated}\` beside \`${tool.tool}\` while ${tool.workflow} job \`${tool.job}\` pins \`${tool.pin}\``); // prettier-ignore
    }
  }
  return { problems, familyCount: families.length, toolCount: tools.length };
}

/**
 * The cache legs through a reader of their own. The one read each workflow
 * gets is the whole of what this adds; the legs and the refusals they raise are
 * {@link auditCachesOver}'s. Like {@link auditTree} beside it, this seam is for
 * a caller holding a file reader that wants these legs alone — the suite's own
 * cases over them; a caller running both leg sets takes {@link auditTreeAt}.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {() => string[]} listWorkflows returns repo-relative workflow paths
 * @returns {ReturnType<typeof auditCachesOver>}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditCaches(readFile, listWorkflows) {
  return auditCachesOver(jobsReader(readFile), readFile, listWorkflows);
}

/**
 * Every leg over the real tree at `root` — the one listing the CLI and the
 * suite's real-tree lock share, so the lock exercises exactly what CI runs.
 * The listing is git-tracked, so an untracked local `.yml` cannot red a run CI
 * would pass.
 * @param {string} root repository root (absolute or relative)
 * @returns {ReturnType<typeof auditTreeOver> & ReturnType<typeof auditCachesOver>}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditTreeAt(root) {
  // Both sets of legs ask for the listing and read every workflow it yields, so
  // a run takes the listing once and reads each file once: the answers are held
  // here, where the run's own readers are built, rather than by either set. An
  // ask not yet answered still does the work it always did, in the order it
  // always did it, so no refusal moves.
  //
  // The listing goes through the shared population reader, whose docblock in
  // scripts/check-test-inventory.js states the quotepath policy.
  let listed = null;
  const listWorkflows = () => {
    if (listed !== null) return listed;
    try {
      listed = trackedFilesUnder(WORKFLOW_PATHSPEC, { cwd: root });
    } catch (error) {
      throw new InputError(`the tracked listing under ${WORKFLOWS_DIR}/ could not be taken at \`${root}\` — ${error.message}`); // prettier-ignore
    }
    return listed;
  };
  const readFile = (path) => readFileSync(join(root, path), 'utf8');
  const jobsAt = jobsReader(readFile);
  const bounds = auditTreeOver(jobsAt, listWorkflows);
  const caches = auditCachesOver(jobsAt, readFile, listWorkflows);
  return {
    ...bounds,
    ...caches,
    problems: [...bounds.problems, ...caches.problems],
  };
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
        `  This check reads literal, positive numeric bounds, and cache steps written as\n` +
        `  one combined step or one restore paired with one save. An input written in a\n` +
        `  shape it does not read — a bound as an expression or another non-number, or one\n` +
        `  that is not positive; a jobs or job block that is not a map, or an empty jobs\n` +
        `  map; a steps block that is not a list or a step that is not a map; a cache step\n` +
        `  stating no \`with\` map, no path list, or no key; a key group it cannot pair; a\n` +
        `  split whose restore states no id; a family key not ending in a hashFiles\n` +
        `  expression, or a tool key not naming its tool and a version; a job stating\n` +
        `  other than one matching cargo install for a tool it caches; two entries claiming\n` +
        `  one row identity; a file it cannot read, one that reads empty, or one whose text\n` +
        `  does not parse as YAML; a tracked listing it cannot take, or one that yields no\n` +
        `  workflow file; a cache class with no entry at all; a guide table its header\n` +
        `  selects other than once or that states no row, one stating no column a cell\n` +
        `  is read by name from, one stating a column no such read answers for, or one\n` +
        `  whose header states a column name more than once; and a guide subsection the\n` +
        `  doc-mention read is scoped to that is not there — is this verdict, and the\n` +
        `  file can be perfectly legal for the platform. Exit 2 keeps that apart from a\n` +
        `  bound or a cache claim that drifted (exit 1).\n`,
    );
    process.exit(2);
  }
  if (audit.problems.length > 0) {
    console.error(
      `✗ the tracked workflows' bounds and cache claims:\n` +
        audit.problems.map((problem) => `    ${problem}`).join('\n') +
        `\n\n  Every job states a \`${BOUND_KEY}\` bound — a ceiling above what that job has\n` +
        `  been measured to take, so work that stops making progress ends as a failure\n` +
        `  there. The one shape that states none is a job calling a reusable workflow: the\n` +
        `  platform admits no bound there, and the called workflow's own job bounds bound\n` +
        `  that work. Where a job's steps state bounds, they add up to LESS than the\n` +
        `  job's, so each step bound is what ends its own step and the steps after it\n` +
        `  still run. Raise the job's bound on its own line, against measurement, rather\n` +
        `  than shaving a step below what it takes.\n` +
        `  Every cache step is described by a row of the guide's own tables, and every row\n` +
        `  describes a step: fix whichever side is wrong, and keep a family stem from\n` +
        `  nesting inside another saved under the same path list — two writers sharing\n` +
        `  one stem there hash different inputs — each family's own prefix first in its\n` +
        `  \`restore-keys\` and no fallback reaching an entry under a shared stem, a\n` +
        `  tool's key version segment equal to the version its install pins, and a\n` +
        `  version a guide states beside a tool equal to that same pin.\n` +
        `  See ${SELF_PATH} for what these legs hold, and ${GUIDE_SECTION} for the\n` +
        `  surfaces they read.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ workflow bounds hold across ${audit.workflowCount} tracked workflow(s): ` +
      `${audit.boundedJobs} job(s) state a \`${BOUND_KEY}\` bound; ${audit.callerJobs} job(s) ` +
      `call a reusable workflow; every job whose steps state bounds keeps their sum below ` +
      `its own. The cache claims hold with them: the guide's tables describe ` +
      `${audit.familyCount} key famil(y/ies), whose stems are pairwise prefix-free inside ` +
      `each path-list group — equal stems admitted only where their keys hash different ` +
      `inputs — and ${audit.toolCount} pinned tool cache(s) whose key segments, install ` +
      `pins, and stated versions agree.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
