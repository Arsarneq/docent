/**
 * check-workflow-bounds.js — admission test for what the tracked workflows
 * state about time and about caching. Its legs read the workflow files
 * themselves — tracked YAML directly under .github/workflows/, the boundary
 * scripts/check-doc-closure.js states for the guides' workflow inventory and
 * this check reads the same set through — and, for the cache legs, the two
 * guides that describe what those files cache.
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
 * The CACHE legs, over the workflows' cache steps and the two tables
 * docs/guides/ci.md (§What the caches key on) states about them. Both tables
 * are recomputed both ways — an entry no row describes reds, and so does a row
 * describing no entry:
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
 *      apart; one stem over one input is a single entry with two writers.
 *   4. pinned tools — every cache entry that IS such a single file takes a row
 *      stating the tool, the version segment of its key, the version its job's
 *      `cargo install` pins, and the version the local-CI guide states beside
 *      that tool's own name. The segment is held to the pin, and the guide's
 *      version — where the guide states one — to the pin as well, so the three
 *      move together or red.
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
 * other than once or that states no row, a guide subsection the doc-mention
 * read is scoped to that is not there, and either cache class yielding no entry
 * at all. A subsection that IS there and
 * states no version for a tool is not in that class: the doc-mention column
 * records what the guide states, so a version un-backticked or a sentence
 * dropped reds on the cell.
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

/** The deeper heading inside it that states the two cache tables. */
export const CACHES_SUBSECTION = 'What the caches key on';

/** The local-CI guide's `##` section, and the subsection the tool versions sit in. */
export const LOCAL_CI_SECTION = 'Running one gate directly';
export const MUTATION_RUNS_SUBSECTION = 'The mutation runs';

/**
 * The guide surfaces stating what these legs hold, named beside a drift red.
 * Both are named because both are read: the CI guide states the two cache
 * tables, and the local-CI guide states the version the doc-mention column
 * carries.
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

/** The two save postures a cell can state without spelling an expression. */
export const SPLIT_GATE = 'main ref + exact miss';
export const COMBINED_GATE = 'every run (post-job save)';

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
 * states for the guides' workflow inventory, decided once for both. The two
 * guide paths come from there for the same reason.
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
 * Both bounds legs over every workflow a listing yields.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {() => string[]} listWorkflows returns repo-relative workflow paths
 * @returns {{ problems: string[], workflowCount: number, boundedJobs: number,
 *             callerJobs: number }}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditTree(readFile, listWorkflows) {
  const paths = readWorkflowPaths(listWorkflows);
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

/* ── The cache legs ──────────────────────────────────────────────────────── */

/** The workflow paths a listing yields, refused where it yields none. */
function readWorkflowPaths(listWorkflows) {
  const paths = workflowPaths(listWorkflows());
  if (paths.length === 0) {
    throw new InputError(`the tracked listing under ${WORKFLOWS_DIR}/ yielded no workflow file — this check reads every job's bound and every cache step from that listing`); // prettier-ignore
  }
  return paths;
}

/** A literal for a regular expression built around a name. */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A key's trailing `${{ hashFiles(...) }}` expression, and the family before it. */
const FAMILY_KEY_RE = /^(.*?)(\$\{\{\s*hashFiles\([^)]*\)\s*\}\})$/;

/** A trailing `${{ ... }}` expression on a cache path, as the tool caches write one. */
const PATH_SUFFIX_EXPRESSION_RE = /\$\{\{[^}]*\}\}$/;

/** A `cargo install <tool> --version <v>`, as the install steps spell one. */
const installPinRe = (tool) => new RegExp(`cargo install ${escapeRe(tool)} --version (\\S+)`, 'g');

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
 * The cache steps one job states, each read into the fields the legs compare.
 * @param {string} path the workflow's repo-relative path
 * @param {string} id the job id
 * @param {unknown} job the job's mapping
 * @returns {{ kind: string, stepId: string|null, key: string, paths: string[],
 *             restoreKeys: string[], gate: string|null }[]}
 * @throws {InputError} for a shape this leg does not read
 */
export function cacheSteps(path, id, job) {
  if (!isMapping(job)) {
    throw new InputError(`${path} job \`${id}\` is not a mapping — this leg reads its cache steps there`); // prettier-ignore
  }
  const steps = job.steps;
  if (steps === undefined) return [];
  if (!Array.isArray(steps)) {
    throw new InputError(`${path} job \`${id}\` states \`steps\` as something other than a list — this leg reads its cache steps there`); // prettier-ignore
  }
  const found = [];
  steps.forEach((step, index) => {
    if (!isMapping(step)) {
      throw new InputError(`${path} job \`${id}\` step ${index + 1} is not a mapping — this leg reads its cache steps there`); // prettier-ignore
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
      gate = saves[0].gate === splitGateFor(source.stepId) ? SPLIT_GATE : (saves[0].gate ?? 'unconditional'); // prettier-ignore
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
 * The two classes of cache entry the tables describe, read from every workflow
 * a listing yields.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {string[]} paths the workflow paths
 * @returns {{ families: object[], tools: object[], pathDrift: string[] }}
 * @throws {InputError} for a shape these legs do not read
 */
export function readCacheClasses(readFile, paths) {
  const families = [];
  const tools = [];
  const pathDrift = [];
  for (const path of paths) {
    const jobs = readJobs(readFile, path);
    for (const [id, job] of Object.entries(jobs)) {
      for (const entry of cacheEntries(path, id, cacheSteps(path, id, job))) {
        if (entry.pathDrift) pathDrift.push(entry.pathDrift);
        if (isToolCache(entry)) tools.push(readToolEntry(entry, job));
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

/** A tool entry: the tool its path names, its key's version segment, and its pin. */
function readToolEntry(entry, job) {
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
  for (const step of job.steps ?? []) {
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
 * example inside one is never read as the section's own prose.
 * @param {string} markdown the document
 * @param {object} where the section and the deeper heading inside it
 * @returns {string} the subsection's own lines, headings excluded
 */
export function subsectionText(markdown, { section, subsection }) {
  const lines = stripFences(markdown).split('\n');
  const collected = [];
  let current = null;
  let deeper = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level <= 2) {
        current = level === 2 ? heading[2] : null;
        deeper = null;
      } else deeper = heading[2];
      continue;
    }
    if (current === section && deeper === subsection) collected.push(line);
  }
  return collected.join('\n');
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
    new RegExp(`(?<![-\\w])${escapeRe(tool)}(?![-\\w])`, 'g'),
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
 * and each cell that disagrees with the surface it describes. `expected`
 * returns one `[text, surface]` pair per column, so a red names the surface
 * that answers for that cell — the step for most of them, a guide subsection
 * for the doc-mention column — rather than one source for the whole row.
 * @param {object} how the table, its entries, and how each is rendered
 * @returns {string[]} problem lines
 */
export function compareRows({ table, docPath, entries, identity, key, expected, what }) {
  const problems = [];
  const byName = new Map(entries.map((entry) => [entry[key], entry]));
  const named = new Set();
  for (const row of table.rows) {
    const cell = (row[identity] ?? '').trim();
    const match = /^`([^`]+)`$/.exec(cell);
    if (match === null) {
      problems.push(`${docPath} states a ${what} row whose \`${table.header[identity]}\` cell is not one backticked name: ${cell === '' ? 'an empty cell' : cell}`); // prettier-ignore
      continue;
    }
    const name = match[1];
    const entry = byName.get(name);
    if (entry === undefined) {
      problems.push(`${docPath} states a ${what} row for \`${name}\`, which the tracked workflows state no such cache for`); // prettier-ignore
      continue;
    }
    named.add(name);
    expected(entry).forEach(([want, surface], column) => {
      const have = flattenWhitespace(row[column] ?? '');
      if (have !== want) {
        const stated = have === '' ? 'an empty cell' : `"${have}"`;
        problems.push(`${docPath} ${what} row \`${name}\` states \`${table.header[column]}\` as ${stated} where ${surface} states "${want}"`); // prettier-ignore
      }
    });
  }
  for (const entry of entries) {
    if (!named.has(entry[key])) {
      problems.push(`${entry.workflow} job \`${entry.job}\` states a ${what} cache for \`${entry[key]}\` that no ${what} row describes`); // prettier-ignore
    }
  }
  return problems;
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
 * Two states red inside a group. A stem nesting inside another: the shorter
 * one's prefix fallback reaches the longer one's entries. And one stem shared by
 * two writers whose keys hash the SAME input: their keys are then equal, so the
 * two jobs write and read a single entry. A stem shared over DIFFERENT inputs is
 * how two writers honestly sit in one group — the hash is what tells their
 * entries apart — and is left alone.
 * @param {object[]} families the family entries
 * @returns {string[]} problem lines
 */
export function prefixFreeProblems(families) {
  const groups = new Map();
  for (const entry of families) {
    const group = pathListKey(entry);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  const problems = [];
  for (const group of groups.values()) {
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
 * Both cache legs over every workflow a listing yields and the two guides that
 * describe what they cache.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {() => string[]} listWorkflows returns repo-relative workflow paths
 * @returns {{ problems: string[], familyCount: number, toolCount: number }}
 * @throws {InputError} naming the input that is in a shape it does not read
 */
export function auditCaches(readFile, listWorkflows) {
  const paths = readWorkflowPaths(listWorkflows);
  const { families, tools, pathDrift } = readCacheClasses(readFile, paths);
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
    ...compareRows({
      table: familiesTable,
      docPath: CI_DOC_PATH,
      entries: families,
      identity: FAMILIES_HEADER.indexOf('Writer job'),
      key: 'job',
      what: 'key families',
      expected: (entry) => {
        const step = `${entry.workflow} job \`${entry.job}\``;
        return [
          [renderOne(entry.family), step],
          [renderOne(entry.suffix), step],
          [renderList(entry.paths), step],
          [renderOne(entry.job), step],
          [renderList(entry.restoreKeys), step],
          [entry.gate, step],
        ];
      },
    }),
    ...compareRows({
      table: toolsTable,
      docPath: CI_DOC_PATH,
      entries: tools,
      identity: TOOLS_HEADER.indexOf('Tool'),
      key: 'tool',
      what: 'pinned tools',
      expected: (entry) => {
        const step = `${entry.workflow} job \`${entry.job}\``;
        return [
          [renderOne(entry.tool), step],
          [renderOne(entry.keyVersion), step],
          [renderOne(entry.pin), step],
          [renderOne(guideVersions.get(entry.tool)), guideWhere],
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
 * Every leg over the real tree at `root` — the one listing the CLI and the
 * suite's real-tree lock share, so the lock exercises exactly what CI runs.
 * The listing is git-tracked, so an untracked local `.yml` cannot red a run CI
 * would pass.
 * @param {string} root repository root (absolute or relative)
 * @returns {ReturnType<typeof auditTree> & ReturnType<typeof auditCaches>}
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
  const readFile = (path) => readFileSync(join(root, path), 'utf8');
  const bounds = auditTree(readFile, listWorkflows);
  const caches = auditCaches(readFile, listWorkflows);
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
        `  selects other than once or that states no row; and a guide subsection the\n` +
        `  doc-mention read is scoped to that is not there — is this verdict, and the file\n` +
        `  can be perfectly legal for the platform. Exit 2 keeps that apart from a bound or\n` +
        `  a cache claim that drifted (exit 1).\n`,
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
        `  one stem there hash different inputs — a tool's key version segment equal to\n` +
        `  the version its install pins, and a version a guide states beside a tool equal\n` +
        `  to that same pin.\n` +
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
