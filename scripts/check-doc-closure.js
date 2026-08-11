/**
 * check-doc-closure.js — admission test for the CI guides' closure claims:
 *
 *   - the workflow inventory (docs/guides/ci.md § The workflow inventory):
 *     every tracked workflow file directly under .github/workflows/ has a
 *     table row, and every row names a tracked workflow file;
 *   - the act table (docs/guides/local-ci.md § What can — and can't — run
 *     under `act`): the table keys exactly the job ids of test.yml, both
 *     ways;
 *   - the lint-gates table (docs/guides/ci.md): package.json's `lint` chain
 *     names exactly the `lint:*` script family, every `lint:*` script has a
 *     table row naming it, every `npm run` gate step of test.yml's lint job
 *     has a table row naming the same script, every job a row's Where cell
 *     names is a test.yml job, and a row whose gate claim is an `npm run`
 *     command resolves to a step one of those Where-named jobs runs. That
 *     table sits under the guide's lint-and-freshness-gates subsection; the
 *     scan anchors it by the enclosing `##` test-suite section — the title
 *     GATES_SECTION carries — plus the `Gate` header cell, because the
 *     shared parser's section model is `##`-level;
 *   - the job partition (docs/guides/ci.md): every test.yml job's side is
 *     derived from its own gating — a job that gates on no `changes` flag
 *     runs on every PR when it states no `if:` at all, or one whose whole
 *     condition is `always()`; a zero-flag job gated any other way is
 *     gating the two documented sides do not model, and is refused by name,
 *     with its condition, rather than placed. The always-run prose and the
 *     path-filtered jobs table must place each derivable job on its derived
 *     side; each table row states exactly the flags its job's `if:` gates
 *     on, both ways; and every flag word a row states is a filter the
 *     `changes` job's paths-filter step defines;
 *   - npm-run citations: every `npm run <token>` in tracked markdown names a
 *     script key in some tracked package.json (an elided family stem such as
 *     `npm run lint:…` passes only while at least one key starts with the
 *     stem);
 *   - script-key citations: a backticked colon-bearing token in tracked
 *     markdown is admitted to the leg when its leading segment plus `:`
 *     prefixes a script key — the admission test that tells a script
 *     citation from an event name, a capability grant, or a YAML key — and
 *     an admitted token must itself be a defined key, so a renamed script's
 *     leftover cite reds even where the old name prefixes the new one.
 *
 * Every parsed surface must be non-empty, an unreadable table cell is
 * refused rather than skipped, and the line scans require their shared
 * `jobs:` anchor — a broken read fails loudly instead of passing vacuously.
 * The gating legs read the workflow structurally instead: js-yaml over the
 * text the injected reader returns, with the per-job flag reader imported
 * from check-ci-filter.js, and the filter map reached in two stated hops —
 * the `changes` job's paths-filter step, located by its `uses`, then that
 * step's `with.filters` string parsed as its own document. A missing
 * `changes` job, a missing paths-filter step, and an unreadable filters
 * block are each their own anchor problem, distinct from the map parsing
 * empty. The line scans' job keys and the parsed workflow's jobs must name
 * the same set, so the two readers cannot drift apart in silence.
 *
 * Check boundary: this check holds the GUIDES' claims about the workflow.
 * The workflow's own internal contract — including that every flag a job
 * gates on is one the `changes` block defines — belongs to
 * check-ci-filter.js, which already receives the workflow and the filter map
 * together.
 *
 * Honest limits: the guides' prose paragraphs stay review-held — this check
 * reads tables, the always-run subsection's backticked job ids, and cited
 * commands and script keys, never sentence meaning. Among the claims outside
 * its legs: a row whose local command is not an `npm run` form (rustfmt,
 * clippy) is held to naming live Where jobs only — whether such a job still
 * runs that gate, and in what step form, stays review-held. An `npm run` row
 * is held further, and the two modelled step shapes are that leg's boundary
 * rather than a limit on it: the `npm run <token>` invocation, and the
 * token's own manifest command, each opening a command segment of a step one
 * of the row's Where jobs runs. A gate written in any other step form —
 * relocated into a composite action, say — REDS, and is answered by
 * re-shaping the row or the step, never by review. What that resolution does
 * not decide is WHICH step it found: any step of a Where job running the
 * command satisfies the claim, and step-level `if:` conditions are not read,
 * so a step gated to pull requests still resolves one. A row whose local
 * command is a reproduction or fix recipe rather than the gate's own
 * invocation — the sync-shared freshness row, whose gate is the `git diff`
 * following the sync — therefore resolves through the step that prepares the
 * check rather than the one that fails it, and its liveness stays
 * review-held like an other-form row's. Back among the review-held claims:
 * npm-run citations resolve against the union of every tracked manifest's
 * script keys, so which package a doc means is review-held; a bare cite of a
 * family no manifest defines any more is unread, and so is a bare family
 * stem, which the colon-cite grammar deliberately does not admit — that leg
 * names keys, never stems; the runner columns of the path-filtered jobs
 * table and the act table restate `runs-on`, which nothing here recomputes;
 * and a tracked YAML nested below the workflows directory is not a workflow
 * the platform runs. The line scans are shaped to test.yml's committed
 * layout — the shared top-level `jobs:` anchor and the two-space job keys
 * they read — and each refuses the file loudly, naming itself, if the anchor
 * vanishes.
 *
 * Usage:
 *   node scripts/check-doc-closure.js  # or: npm run lint:doc-closure
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  duplicatesIn,
  missingFrom,
  parseTables,
  backtickedName,
  stripFences,
} from './check-test-inventory.js';
import { jobFlags } from './check-ci-filter.js';

export const CI_DOC_PATH = 'docs/guides/ci.md';
export const LOCAL_CI_DOC_PATH = 'docs/guides/local-ci.md';
export const WORKFLOWS_DIR = '.github/workflows';
export const TEST_WORKFLOW_PATH = '.github/workflows/test.yml';
export const ROOT_MANIFEST_PATH = 'package.json';
export const WORKFLOW_SECTION = 'The workflow inventory';
export const WORKFLOW_HEADER = 'Workflow';
export const ACT_SECTION = "What can — and can't — run under `act`";
export const ACT_HEADER = 'Job (in `test.yml`)';
export const GATES_SECTION = 'The test suite (`test.yml`)';
export const GATES_HEADER = 'Gate';
export const GATES_WHERE_HEADER = 'Where';
export const JOBS_TABLE_HEADER = 'Job';
export const JOBS_FLAGS_HEADER = 'Runs on a PR when the diff sets';
export const ALWAYS_RUN_HEADING = 'Jobs that always run';
export const LINT_JOB_ID = 'lint';
export const LINT_CHAIN_KEY = 'lint';
export const LINT_FAMILY_PREFIX = 'lint:';
export const CHANGES_JOB_ID = 'changes';
export const PATHS_FILTER_USES = 'paths-filter';

const NPM_RUN_TOKEN_RE = /npm run ([A-Za-z0-9:_-]+)/g;
const NPM_RUN_COMMAND_RE = /^npm run ([A-Za-z0-9:_-]+)/;
const ELLIPSIS = '…';
const BACKTICKED_SPAN_RE = /`([^`]+)`/g;
const HEADING_LINE_RE = /^(#{1,6})\s+(.*?)\s*$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;
const FLAG_WORD_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const SAME_FLAGS_RE = /^after\s+`([A-Za-z0-9_-]+)`\s*,\s*same flags$/;
const COLON_TOKEN_RE = /^[a-z0-9-]+(?::[a-z0-9-]+)+$/;

/**
 * The backticked spans of one line or cell, in order — the one reader every
 * positive multi-token cell scan below shares.
 * @param {string} text
 * @returns {string[]}
 */
function backtickedSpans(text) {
  return [...(text ?? '').matchAll(BACKTICKED_SPAN_RE)].map((m) => m[1]);
}

/**
 * The files the workflow-inventory leg closes over: tracked YAML directly
 * under the workflows directory — a nested YAML is not a workflow the
 * platform runs. Exported so the suite can pin the boundary in both
 * directions.
 */
export const WORKFLOW_FILE_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * The workflow basenames a raw listing yields. Applying
 * {@link WORKFLOW_FILE_RE} here is what keeps the leg's boundary: git's
 * pathspec `*` crosses `/`, so the listing itself sweeps nested YAML in.
 * Exported so the suite drives the filter on the listing path, not only the
 * pattern.
 * @param {string[]} paths repo-relative paths from the listing
 * @returns {string[]} basenames of the workflow files among them
 */
export function workflowBasenames(paths) {
  return paths.filter((path) => WORKFLOW_FILE_RE.test(path)).map((path) => path.split('/').pop());
}

/**
 * A first cell of the workflow-inventory table: a backticked file name,
 * either bare or wrapped in a single markdown link. Null otherwise.
 * @param {string} cell
 * @returns {string | null}
 */
export function linkedFileName(cell) {
  const trimmed = (cell ?? '').trim();
  const linked = /^\[`([^`]+)`\]\([^()]*\)$/.exec(trimmed);
  if (linked) return linked[1];
  return backtickedName(trimmed);
}

/**
 * First-column names of the one table selected by section AND first header
 * cell — the house pattern, so a sibling table under the same section is
 * never conscripted. A first cell that is neither a bare backticked name nor
 * a link-wrapped one is returned as unreadable, so no row is skipped
 * silently.
 * @param {string} docText
 * @param {string} section the `##` section the table sits in
 * @param {string} headerCell the table's first header cell
 * @returns {{ names: string[], unreadable: string[] }}
 */
export function extractTableFileNames(docText, section, headerCell) {
  const names = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== section || table.header[0] !== headerCell) continue;
    for (const row of table.rows) {
      const name = linkedFileName(row[0]);
      if (name === null) unreadable.push(row[0]);
      else names.push(name);
    }
  }
  return { names, unreadable };
}

/**
 * The gates table's rows, read as gate name, the jobs its Where cell names,
 * its gate claim, and the `npm run` tokens of the Local-command column (the
 * last column; the Red-when prose column also carries tokens and is
 * deliberately not read).
 *
 * The gate CLAIM is that cell's leading backticked command: any trailing
 * remark — a fix-command parenthetical, a comma clause — is commentary, and
 * its own tokens stay held by the citation leg. The Where cell is read
 * positively: every backticked span matching the job-id grammar is a named
 * job and any non-backticked remainder is qualifier prose, so only a cell
 * naming no job at all is refused. A row with an unreadable gate cell, a
 * Where cell naming nothing, or no backticked command is refused rather than
 * skipped, and a table with no `Where` column is refused as a whole.
 * @param {string} docText
 * @returns {{ rows: { gate: string, tokens: string[], where: string[], command: string }[],
 *             unreadable: string[] }}
 */
export function extractGateRows(docText) {
  const rows = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== GATES_SECTION || table.header[0] !== GATES_HEADER) continue;
    const commandColumn = table.header.length - 1;
    const whereColumn = table.header.indexOf(GATES_WHERE_HEADER);
    if (whereColumn === -1) {
      unreadable.push(`${table.header.join(' | ')} — no \`${GATES_WHERE_HEADER}\` column`);
      continue;
    }
    for (const row of table.rows) {
      const gate = (row[0] ?? '').trim();
      const where = backtickedSpans(row[whereColumn]).filter((span) => JOB_ID_RE.test(span));
      const commandCell = (row[commandColumn] ?? '').trim();
      const [command] = backtickedSpans(commandCell);
      if (gate === '' || where.length === 0 || command === undefined) {
        unreadable.push(row.join(' | '));
        continue;
      }
      const tokens = [...commandCell.matchAll(NPM_RUN_TOKEN_RE)].map((m) => m[1]);
      rows.push({ gate, tokens, where, command });
    }
  }
  return { rows, unreadable };
}

/**
 * The path-filtered jobs table's rows: the job each row keys and the flag
 * set it states. Rows lead with a lone backticked job id; the flag column is
 * bare comma/`or`-separated words, or the `` after `<job>`, same flags ``
 * form, which defers to the named row and is resolved (and refused when it
 * names none) where the rows are compared. A first cell that is not a lone
 * backticked job id, a flag cell in neither form, and a table missing its
 * flag column are each refused rather than skipped.
 * @param {string} docText
 * @returns {{ rows: { job: string, flags: string[] | null, alias: string | null }[],
 *             unreadable: string[] }}
 */
export function extractJobsTableRows(docText) {
  const rows = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== GATES_SECTION || table.header[0] !== JOBS_TABLE_HEADER) continue;
    const flagsColumn = table.header.indexOf(JOBS_FLAGS_HEADER);
    if (flagsColumn === -1) {
      unreadable.push(`${table.header.join(' | ')} — no \`${JOBS_FLAGS_HEADER}\` column`);
      continue;
    }
    for (const row of table.rows) {
      const job = backtickedName(row[0]);
      const cell = (row[flagsColumn] ?? '').trim();
      if (job === null || !JOB_ID_RE.test(job)) {
        unreadable.push(row.join(' | '));
        continue;
      }
      const deferred = SAME_FLAGS_RE.exec(cell);
      if (deferred) {
        rows.push({ job, flags: null, alias: deferred[1] });
        continue;
      }
      const words = cell
        .split(/,|\bor\b/)
        .map((word) => word.trim())
        .filter(Boolean);
      if (words.length === 0 || !words.every((word) => FLAG_WORD_RE.test(word))) {
        unreadable.push(row.join(' | '));
        continue;
      }
      rows.push({ job, flags: words, alias: null });
    }
  }
  return { rows, unreadable };
}

/**
 * The job ids the always-run subsection names: every backticked token
 * matching the job-id grammar between that heading and the next one, so a
 * backticked token that is not a job id (the `if:` expression the sentence
 * quotes) is prose, not a claim. The heading's absence is the scan's own
 * loud problem.
 * @param {string} docText
 * @returns {{ ids: string[], problems: string[] }}
 */
export function extractAlwaysRunIds(docText) {
  const lines = stripFences(docText).split('\n');
  const headingOf = (line) => {
    const match = HEADING_LINE_RE.exec(line);
    return match ? match[2] : null;
  };
  const start = lines.findIndex((line) => headingOf(line) === ALWAYS_RUN_HEADING);
  if (start === -1) {
    return { ids: [], problems: [`${CI_DOC_PATH} carries no \`${ALWAYS_RUN_HEADING}\` heading — the always-run scan cannot anchor`] }; // prettier-ignore
  }
  const ids = [];
  for (let i = start + 1; i < lines.length && headingOf(lines[i]) === null; i++) {
    for (const span of backtickedSpans(lines[i])) if (JOB_ID_RE.test(span)) ids.push(span);
  }
  return { ids, problems: [] };
}

/**
 * The one `jobs:` anchor both workflow scans share: the index of the
 * top-level `jobs:` line, or -1 with a diagnosis naming the failing scan.
 * A change to what counts as the anchor lands in both scans structurally.
 * @param {string[]} lines
 * @param {string} scan the calling scan's name, for the diagnosis
 * @returns {{ start: number, problem: string | null }}
 */
function findJobsBlock(lines, scan) {
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start === -1) {
    return { start, problem: `${TEST_WORKFLOW_PATH} carries no top-level \`jobs:\` key — the ${scan} cannot anchor` }; // prettier-ignore
  }
  return { start, problem: null };
}

/**
 * The job ids of a workflow file: the two-space-indented keys of the
 * top-level `jobs:` block. Shaped to the committed layout — a missing
 * `jobs:` anchor is the extractor's own loud problem, never an empty green.
 * @param {string} yamlText
 * @returns {{ ids: string[], problems: string[] }}
 */
export function extractJobIds(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const block = findJobsBlock(lines, 'job scan');
  if (block.problem) return { ids: [], problems: [block.problem] };
  const ids = [];
  for (let i = block.start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key ends the block
    const match = /^ {2}([A-Za-z0-9_-]+):/.exec(line);
    if (match) ids.push(match[1]);
  }
  return { ids, problems: [] };
}

/**
 * The `npm run` tokens of one job's steps, bounded to that job's lines
 * (from its two-space key inside the `jobs:` block to the next one) — both
 * workflow scans share the one `jobs:` anchor, so a same-named key under an
 * earlier top-level block can never win. The anchor's or the job's absence
 * is the extractor's own problem.
 * @param {string} yamlText
 * @param {string} jobId
 * @returns {{ tokens: string[], problems: string[] }}
 */
export function extractJobNpmRunTokens(yamlText, jobId) {
  const lines = yamlText.split(/\r?\n/);
  const block = findJobsBlock(lines, 'step scan');
  if (block.problem) return { tokens: [], problems: [block.problem] };
  let start = -1;
  for (let i = block.start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (lines[i].startsWith(`  ${jobId}:`)) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return { tokens: [], problems: [`${TEST_WORKFLOW_PATH} has no \`${jobId}\` job — the step scan cannot anchor`] }; // prettier-ignore
  }
  const tokens = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {2}[A-Za-z0-9_-]+:/.test(line) || /^\S/.test(line)) break;
    for (const match of line.matchAll(NPM_RUN_TOKEN_RE)) tokens.push(match[1]);
  }
  return { tokens: [...new Set(tokens)], problems: [] };
}

/**
 * The gating facts the guides' job claims are held against, read
 * structurally from the workflow text the caller's reader returned: each
 * job's id, the `changes` flags its `if:` gates on (through the filter
 * check's own per-job reader, so one implementation decides what a gate
 * is), and its steps' `run:` lines. The filter map is reached in two hops —
 * the `changes` job's paths-filter step, located by its `uses`, then that
 * step's `with.filters` STRING parsed as its own document, since a single
 * top-level parse yields that block as text. Each hop that cannot be taken
 * is its own problem, distinct from a map that parses to no entries.
 * @param {string} yamlText
 * @returns {{ jobs: { id: string, flags: string[], condition: string | null,
 *                     stepLines: string[] }[],
 *             filterFlags: string[], problems: string[] }}
 */
export function extractWorkflowGating(yamlText) {
  let parsed;
  try {
    parsed = yaml.load(yamlText);
  } catch {
    return { jobs: [], filterFlags: [], problems: [`${TEST_WORKFLOW_PATH} does not parse as YAML — the gating scan cannot anchor`] }; // prettier-ignore
  }
  const jobsMap = parsed !== null && typeof parsed === 'object' ? parsed.jobs : null;
  if (jobsMap === null || typeof jobsMap !== 'object' || Array.isArray(jobsMap)) {
    return { jobs: [], filterFlags: [], problems: [`${TEST_WORKFLOW_PATH} carries no \`jobs:\` mapping — the gating scan cannot anchor`] }; // prettier-ignore
  }
  const problems = [];
  const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
  const jobs = Object.entries(jobsMap).map(([id, job]) => ({
    id,
    flags: [...jobFlags(job)],
    condition: job?.if === undefined ? null : String(job.if),
    stepLines: stepsOf(job)
      .filter((step) => typeof step?.run === 'string')
      .flatMap((step) => step.run.split(/\r?\n/))
      .filter((line) => line.trim() !== ''),
  }));
  const changes = jobsMap[CHANGES_JOB_ID];
  const filterStep = stepsOf(changes).find(
    (step) => typeof step?.uses === 'string' && step.uses.includes(PATHS_FILTER_USES),
  );
  let filterFlags = [];
  if (changes === undefined) {
    problems.push(`${TEST_WORKFLOW_PATH} has no \`${CHANGES_JOB_ID}\` job — the filter-map scan cannot anchor`); // prettier-ignore
  } else if (filterStep === undefined) {
    problems.push(`${TEST_WORKFLOW_PATH}'s \`${CHANGES_JOB_ID}\` job has no \`${PATHS_FILTER_USES}\` step — the filter-map scan cannot anchor`); // prettier-ignore
  } else if (typeof filterStep.with?.filters !== 'string') {
    problems.push(`${TEST_WORKFLOW_PATH}'s \`${PATHS_FILTER_USES}\` step carries no \`with.filters\` block — the filter-map scan cannot anchor`); // prettier-ignore
  } else {
    let map;
    try {
      map = yaml.load(filterStep.with.filters);
    } catch {
      map = null;
    }
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
      problems.push(`${TEST_WORKFLOW_PATH}'s \`with.filters\` block does not parse as a mapping — the filter-map scan cannot anchor`); // prettier-ignore
    } else {
      filterFlags = Object.keys(map);
    }
  }
  return { jobs, filterFlags, problems };
}

/**
 * The root manifest's `lint` chain tokens, its `lint:*` script family, and
 * its script commands — the commands are what lets a gate row claiming
 * `npm run <token>` resolve against a step that invokes the script
 * directly.
 * @param {string} manifestJson
 * @returns {{ chainTokens: string[], lintKeys: string[],
 *             commands: Record<string, string>, problems: string[] }}
 */
export function extractLintSurface(manifestJson) {
  let parsed;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return { chainTokens: [], lintKeys: [], commands: {}, problems: [`${ROOT_MANIFEST_PATH} does not parse as JSON`] }; // prettier-ignore
  }
  const scripts = parsed?.scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    return { chainTokens: [], lintKeys: [], commands: {}, problems: [`${ROOT_MANIFEST_PATH} carries no scripts object — the lint surface cannot be read`] }; // prettier-ignore
  }
  const problems = [];
  const chain = scripts[LINT_CHAIN_KEY];
  const chainTokens =
    typeof chain === 'string' ? [...chain.matchAll(NPM_RUN_TOKEN_RE)].map((m) => m[1]) : [];
  if (typeof chain !== 'string') {
    problems.push(`${ROOT_MANIFEST_PATH} has no \`${LINT_CHAIN_KEY}\` chain script`);
  }
  const lintKeys = Object.keys(scripts).filter((k) => k.startsWith(LINT_FAMILY_PREFIX));
  const commands = Object.fromEntries(
    Object.entries(scripts).filter(([, command]) => typeof command === 'string'),
  );
  return { chainTokens, lintKeys, commands, problems };
}

/**
 * Every `npm run <token>` citation in one markdown document, read from the
 * raw text (fences included — commands live inside them). A token whose
 * next character is `…` is an elided family stem (`npm run lint:…`) and is
 * marked so; a token ending in `:` with no elision is unreadable.
 * @param {string} docText
 * @param {string} docPath
 * @returns {{ cites: { path: string, line: number, token: string, elided: boolean }[],
 *             unreadable: string[] }}
 */
export function extractNpmRunCites(docText, docPath) {
  const cites = [];
  const unreadable = [];
  const lines = docText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(NPM_RUN_TOKEN_RE)) {
      const token = match[1];
      const elided = lines[i][match.index + match[0].length] === ELLIPSIS;
      if (token.endsWith(':') && !elided) {
        unreadable.push(`${docPath}:${i + 1} \`npm run ${token}\``);
      } else {
        cites.push({ path: docPath, line: i + 1, token, elided });
      }
    }
  }
  return { cites, unreadable };
}

/**
 * Every colon-bearing backticked token in one markdown document, read from
 * the raw text for the same reason the `npm run` scan is: a citation is
 * wherever it is written. The grammar admits a lowercase, colon-joined token
 * and nothing else, so a quoted expression, a path, or a version string can
 * never enter the leg; which of those tokens is a SCRIPT citation is then
 * decided by {@link admitColonCites}.
 * @param {string} docText
 * @param {string} docPath
 * @returns {{ path: string, line: number, token: string }[]}
 */
export function extractColonCites(docText, docPath) {
  const cites = [];
  const lines = docText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const span of backtickedSpans(lines[i])) {
      if (COLON_TOKEN_RE.test(span)) cites.push({ path: docPath, line: i + 1, token: span });
    }
  }
  return cites;
}

/**
 * The colon-bearing tokens that are script citations: those whose leading
 * segment plus `:` prefixes at least one defined script key, i.e. that name
 * a live script family. A token of no live family (an event channel, a
 * capability grant, a YAML key) names something this check does not read and
 * is left alone; an admitted one is then held to being a defined key
 * exactly.
 * @param {{ path: string, line: number, token: string }[]} cites
 * @param {Set<string>} scriptKeys
 * @returns {{ path: string, line: number, token: string }[]}
 */
export function admitColonCites(cites, scriptKeys) {
  const families = new Set(
    [...scriptKeys].filter((key) => key.includes(':')).map((key) => `${key.split(':')[0]}:`),
  );
  return cites.filter((cite) => families.has(`${cite.token.split(':')[0]}:`));
}

/**
 * The union of script keys across manifests, each read defensively.
 * @param {{ path: string, text: string }[]} manifests
 * @returns {{ keys: Set<string>, problems: string[] }}
 */
export function collectScriptKeys(manifests) {
  const keys = new Set();
  const problems = [];
  for (const { path, text } of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push(`${path} does not parse as JSON — its script keys cannot be read`);
      continue;
    }
    const scripts = parsed?.scripts;
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) continue;
    for (const key of Object.keys(scripts)) keys.add(key);
  }
  return { keys, problems };
}

/**
 * How a surface that is not a plain name list is read as one, keyed by
 * surface. Both guard loops below read through this projection, so a
 * surface of records is counted and de-duplicated by the name it carries
 * rather than by its shape.
 */
const SURFACE_LISTS = {
  scriptKeys: (s) => [...s.scriptKeys],
  gateRows: (s) => s.gateRows.map((row) => row.gate),
  jobsTableRows: (s) => s.jobsTableRows.map((row) => row.job),
  colonCites: (s) => s.colonCites.map((cite) => cite.token),
};

/** One surface as a list of names, through its projection where it has one. */
const surfaceList = (key, s) => (SURFACE_LISTS[key] ? SURFACE_LISTS[key](s) : s[key]);

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this
 * list — a leg added here is exercised automatically, and the suite holds
 * the list non-empty and its diagnoses distinct.
 */
export const EMPTY_SURFACES = [
  ['workflowFiles', `no tracked workflow files found under ${WORKFLOWS_DIR}`],
  ['workflowRows', `no workflow-inventory rows found in ${CI_DOC_PATH}`],
  ['jobIds', `no job ids found in ${TEST_WORKFLOW_PATH}`],
  ['actRows', `no act-table rows found in ${LOCAL_CI_DOC_PATH}`],
  ['gateRows', `no lint-gates rows found in ${CI_DOC_PATH}`],
  ['jobsTableRows', `no path-filtered jobs rows found in ${CI_DOC_PATH}`],
  ['alwaysRunIds', `no job ids found in ${CI_DOC_PATH}'s \`${ALWAYS_RUN_HEADING}\` subsection`],
  ['filterFlags', `no filters defined by ${TEST_WORKFLOW_PATH}'s \`${PATHS_FILTER_USES}\` step`],
  ['chainTokens', `no npm-run tokens found in ${ROOT_MANIFEST_PATH}'s \`lint\` chain`],
  ['lintKeys', `no \`${LINT_FAMILY_PREFIX}*\` scripts found in ${ROOT_MANIFEST_PATH}`],
  ['lintStepTokens', `no npm-run step tokens found in ${TEST_WORKFLOW_PATH}'s \`${LINT_JOB_ID}\` job`], // prettier-ignore
  ['cites', `no npm-run citations found in tracked markdown — the citation scan is broken`],
  ['colonCites', `no script-key citations found in tracked markdown — the family scan is broken`],
  ['scriptKeys', `no script keys found in any tracked package.json`],
];

/**
 * The duplicates guard's legs — the drift the deduplicating set diffs
 * cannot see. Exported for the same suite treatment as
 * {@link EMPTY_SURFACES}, plus the fixture-key equality lock its
 * hand-written fixtures need. Absent by design: script citations are cited by
 * as many documents as need them, and prose may name a job as often as the
 * sentence needs — a second row for one job is drift, a second mention is
 * not.
 */
export const DUPLICATE_SURFACES = [
  ['workflowRows', 'the workflow-inventory table'],
  ['actRows', 'the act table'],
  ['jobIds', `${TEST_WORKFLOW_PATH}'s job ids`],
  ['gateRows', 'the lint-gates table'],
  ['jobsTableRows', 'the path-filtered jobs table'],
  ['chainTokens', 'the `lint` chain'],
];

/** The two sides a job can be documented on, by the surface that states it. */
const ALWAYS_RUN_SIDE = 'the always-run prose';
const PATH_FILTERED_SIDE = 'the path-filtered jobs table';

/**
 * Whether a job carrying no `changes` flag genuinely runs on every PR: it
 * states no `if:` at all, or one whose whole condition is `always()` — the
 * `${{ … }}` wrapper and surrounding whitespace tolerated, since both forms
 * are the same condition. Any other condition is gating the guide's two
 * sides do not model, which the caller refuses by name rather than deriving
 * a side from a flag set that no longer decides it.
 * @param {string | null | undefined} condition the job's `if:`, or null
 * @returns {boolean}
 */
function runsAlways(condition) {
  if (condition === null || condition === undefined) return true;
  const text = condition.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  return /^always\s*\(\s*\)$/.test((wrapped ? wrapped[1] : text).trim());
}

/**
 * One step's text as the command segments a shell would run. Quoted spans
 * keep their delimiters and lose their CONTENTS, so an advisory
 * `echo 'npm run sync-shared'` names no command; a `#` comment is dropped to
 * end of line; and the remainder splits on `&&`, `||`, `;`, `|`, and newline.
 * A leading `(` — the subshell form — is stripped so the segment still opens
 * with the command it runs.
 * @param {string} text one step's `run:` line or block
 * @returns {string[]} the trimmed, non-empty segments
 */
function commandSegments(text) {
  let bare = '';
  let quote = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) {
        bare += char;
        quote = null;
      }
      continue; // quoted text is data the shell passes on, never a command
    }
    if (char === "'" || char === '"') quote = char;
    bare += char;
  }
  return bare
    .replace(/(^|\s)#.*$/gm, '$1')
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => segment.trim().replace(/^\(\s*/, ''))
    .filter((segment) => segment !== '');
}

/**
 * Whether one job's steps run a gate the guide claims as `npm run <token>`.
 * The gate must OPEN one of that job's command segments, in one of two
 * shapes: the `npm run <token>` invocation, or the token's own manifest
 * command. Both shapes end on the same boundary — the segment is the
 * invocation exactly, or the invocation followed by a separator, so extra
 * arguments still count while a longer command the claim merely prefixes
 * (`prettier --check .` against a step running `prettier --check ./docs`)
 * does not. The same text quoted inside another command (an advisory `echo`)
 * or sitting in a `#` comment does not count either. There is no family-key
 * escape — a row resolves only through the jobs its Where cell names.
 * @param {{ stepLines: string[] } | undefined} job
 * @param {string} token the gate claim's script key
 * @param {string | undefined} command that key's command in the root manifest
 * @returns {boolean}
 */
function runsGate(job, token, command) {
  if (job === undefined) return false;
  const invocation = new RegExp(
    `^npm run ${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9:_-])`,
  );
  const runsCommand =
    typeof command === 'string' && command !== ''
      ? (segment) =>
          segment === command || (segment.startsWith(command) && /\s/.test(segment[command.length]))
      : () => false;
  return job.stepLines
    .flatMap((line) => commandSegments(line))
    .some((segment) => invocation.test(segment) || runsCommand(segment));
}

/**
 * Pure core: evaluate every closure leg.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.workflowFiles basenames under .github/workflows/
 * @param {string[]} s.workflowRows the inventory table's file names
 * @param {string[]} s.workflowUnreadable its unreadable first cells
 * @param {string[]} s.jobIds test.yml's job ids
 * @param {string[]} s.actRows the act table's job ids
 * @param {string[]} s.actUnreadable its unreadable first cells
 * @param {{ gate: string, tokens: string[], where: string[], command: string }[]} s.gateRows
 * @param {string[]} s.gatesUnreadable its unreadable rows
 * @param {{ job: string, flags: string[] | null, alias: string | null }[]} s.jobsTableRows
 * @param {string[]} s.jobsTableUnreadable its unreadable rows
 * @param {string[]} s.alwaysRunIds the always-run subsection's job ids
 * @param {{ id: string, flags: string[], condition: string | null, stepLines: string[] }[]} s.workflowJobs
 * @param {string[]} s.filterFlags the filters the `changes` step defines
 * @param {string[]} s.chainTokens the `lint` chain's `npm run` tokens
 * @param {string[]} s.lintKeys the `lint:*` script keys
 * @param {string[]} s.lintStepTokens the lint job's `npm run` step tokens
 * @param {{ path: string, line: number, token: string, elided: boolean }[]} s.cites
 * @param {string[]} s.citeUnreadable unreadable citations
 * @param {{ path: string, line: number, token: string }[]} s.colonCites admitted script cites
 * @param {Set<string>} s.scriptKeys the union of tracked manifests' keys
 * @param {Record<string, string>} s.scriptCommands the root manifest's script commands
 * @returns {string[]} problems; empty when every closure holds
 */
export function evaluateDocClosure(s) {
  const problems = [];

  // Unreadable cells are reported ahead of the vacuous guards: the likeliest
  // cause of an empty parse is rows that stopped being readable, so the most
  // useful line must survive the early return.
  for (const cell of s.workflowUnreadable) {
    problems.push(`${CI_DOC_PATH} workflow-inventory first cell the scan cannot read — ${cell} — rows lead with a backticked file name, plain or linked`); // prettier-ignore
  }
  for (const cell of s.actUnreadable) {
    problems.push(`${LOCAL_CI_DOC_PATH} act-table first cell the scan cannot read — ${cell} — rows lead with a lone backticked job id`); // prettier-ignore
  }
  for (const row of s.gatesUnreadable) {
    problems.push(`${CI_DOC_PATH} lint-gates row the scan cannot read — ${row} — rows lead with a gate name, name at least one backticked job where the gate runs, and state a backticked local command`); // prettier-ignore
  }
  for (const row of s.jobsTableUnreadable) {
    problems.push(`${CI_DOC_PATH} path-filtered jobs row the scan cannot read — ${row} — rows lead with a lone backticked job id and state bare flag words, or defer to another row's flags in exactly this form: after \`<job>\`, same flags`); // prettier-ignore
  }
  for (const cite of s.citeUnreadable) {
    problems.push(`npm-run citation the scan cannot read — ${cite}`);
  }

  let vacuous = false;
  for (const [key, message] of EMPTY_SURFACES) {
    if (surfaceList(key, s).length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make the closure diffs meaningless

  for (const [key, what] of DUPLICATE_SURFACES) {
    problems.push(...duplicatesIn(surfaceList(key, s), what));
  }

  const gateTokens = new Set(s.gateRows.flatMap((r) => r.tokens));
  problems.push(
    ...missingFrom(s.workflowFiles, s.workflowRows, `is a workflow file but the ${CI_DOC_PATH} inventory table does not list it`), // prettier-ignore
    ...missingFrom(s.workflowRows, s.workflowFiles, `is listed in the ${CI_DOC_PATH} inventory table but no tracked workflow file matches it — the gate sees only tracked files directly under ${WORKFLOWS_DIR}`), // prettier-ignore
    ...missingFrom(s.jobIds, s.actRows, `is a ${TEST_WORKFLOW_PATH} job but the ${LOCAL_CI_DOC_PATH} act table does not key it`), // prettier-ignore
    ...missingFrom(s.actRows, s.jobIds, `is keyed by the ${LOCAL_CI_DOC_PATH} act table but is not a ${TEST_WORKFLOW_PATH} job`), // prettier-ignore
    ...missingFrom(s.chainTokens, s.lintKeys, `is run by the \`lint\` chain but is not a \`${LINT_FAMILY_PREFIX}*\` script`), // prettier-ignore
    ...missingFrom(s.lintKeys, s.chainTokens, `is a \`${LINT_FAMILY_PREFIX}*\` script but the \`lint\` chain does not run it`), // prettier-ignore
    ...missingFrom(s.lintKeys, [...gateTokens], `is a \`${LINT_FAMILY_PREFIX}*\` script but no lint-gates row names it (${CI_DOC_PATH})`), // prettier-ignore
    ...missingFrom(s.lintStepTokens, [...gateTokens], `is run by the \`${LINT_JOB_ID}\` job's steps but no lint-gates row names it (${CI_DOC_PATH})`), // prettier-ignore
  );

  problems.push(...evaluateJobPartition(s), ...evaluateGateLiveness(s));

  for (const cite of s.cites) {
    if (cite.elided) {
      const stem = cite.token;
      if (![...s.scriptKeys].some((k) => k.startsWith(stem))) {
        problems.push(`${cite.path}:${cite.line} cites the elided family \`npm run ${stem}${ELLIPSIS}\` but no script key starts with \`${stem}\``); // prettier-ignore
      }
    } else if (!s.scriptKeys.has(cite.token)) {
      problems.push(`${cite.path}:${cite.line} cites \`npm run ${cite.token}\` but no tracked package.json defines that script`); // prettier-ignore
    }
  }

  for (const cite of s.colonCites) {
    if (!s.scriptKeys.has(cite.token)) {
      problems.push(`${cite.path}:${cite.line} cites \`${cite.token}\`, whose family names live scripts, but no tracked package.json defines that script key`); // prettier-ignore
    }
  }

  return problems;
}

/**
 * The job legs: the two workflow readers agree on the job set, each job the
 * two sides model is documented on the side its own gating puts it on — a
 * zero-flag job conditioned other than by `always()` is refused by name
 * instead, since neither side describes it — each table row states exactly
 * the flags its job gates on, and every flag word a row states is a defined
 * filter.
 * @param {Parameters<typeof evaluateDocClosure>[0]} s
 * @returns {string[]} problems
 */
function evaluateJobPartition(s) {
  const problems = [];
  const jobs = new Map(s.workflowJobs.map((job) => [job.id, job]));
  const definedFlags = new Set(s.filterFlags);
  const placed = {
    [ALWAYS_RUN_SIDE]: new Set(s.alwaysRunIds),
    [PATH_FILTERED_SIDE]: new Set(s.jobsTableRows.map((row) => row.job)),
  };

  // The structural read and the line scan see the same file: if they ever
  // named different jobs, one of the two closures above would be measuring
  // a job set nothing else holds.
  problems.push(
    ...missingFrom(s.jobIds, [...jobs.keys()], `is a job key the ${TEST_WORKFLOW_PATH} line scan reads but the parsed workflow does not carry — the two readers disagree`), // prettier-ignore
    ...missingFrom([...jobs.keys()], s.jobIds, `is a job of the parsed ${TEST_WORKFLOW_PATH} but the line scan does not read it — the two readers disagree`), // prettier-ignore
  );

  for (const [side, named] of Object.entries(placed)) {
    for (const id of named) {
      if (!jobs.has(id)) {
        problems.push(`\`${id}\` is named by ${side} (${CI_DOC_PATH}) but is not a ${TEST_WORKFLOW_PATH} job`); // prettier-ignore
      }
    }
  }

  for (const job of s.workflowJobs) {
    if (job.flags.length === 0 && !runsAlways(job.condition)) {
      problems.push(`\`${job.id}\` gates on no \`${CHANGES_JOB_ID}\` flag, but its \`if:\` condition — ${String(job.condition).replace(/\s+/g, ' ').trim()} — is neither absent nor \`always()\`, so which side of ${CI_DOC_PATH} it belongs on is gating this check does not model`); // prettier-ignore
      continue;
    }
    const gating =
      job.flags.length === 0
        ? `gates on no \`${CHANGES_JOB_ID}\` flag and is conditioned no other way, so it runs on every PR`
        : `gates on \`${CHANGES_JOB_ID}\` flags, so it runs only when the diff sets one`;
    const side = job.flags.length === 0 ? ALWAYS_RUN_SIDE : PATH_FILTERED_SIDE;
    const other = side === ALWAYS_RUN_SIDE ? PATH_FILTERED_SIDE : ALWAYS_RUN_SIDE;
    if (placed[other].has(job.id)) {
      const both = placed[side].has(job.id) ? ' — and by both surfaces at once' : '';
      problems.push(`\`${job.id}\` ${gating}, but ${CI_DOC_PATH} places it in ${other} rather than ${side}${both}`); // prettier-ignore
    } else if (!placed[side].has(job.id)) {
      problems.push(`\`${job.id}\` ${gating}, but ${side} (${CI_DOC_PATH}) does not name it`);
    }
  }

  const byJob = new Map(s.jobsTableRows.map((row) => [row.job, row]));
  for (const row of s.jobsTableRows) {
    for (const flag of row.flags ?? []) {
      if (!definedFlags.has(flag)) {
        problems.push(`the ${CI_DOC_PATH} row for \`${row.job}\` states the flag \`${flag}\`, which the \`${CHANGES_JOB_ID}\` job's ${PATHS_FILTER_USES} step does not define`); // prettier-ignore
      }
    }
    let stated = row.flags;
    if (stated === null) {
      const deferred = byJob.get(row.alias);
      if (deferred === undefined || deferred.flags === null) {
        problems.push(`the ${CI_DOC_PATH} row for \`${row.job}\` defers to \`${row.alias}\`, which is no row of the same table stating its own flags`); // prettier-ignore
        continue;
      }
      stated = deferred.flags;
    }
    const job = jobs.get(row.job);
    if (job === undefined) continue; // already reported as naming no job
    problems.push(
      ...missingFrom(stated, job.flags, `is stated by the ${CI_DOC_PATH} row for \`${row.job}\` but that job's \`if:\` does not gate on it`), // prettier-ignore
      ...missingFrom(job.flags, stated, `gates \`${row.job}\` in ${TEST_WORKFLOW_PATH} but the ${CI_DOC_PATH} row for it does not state that flag`), // prettier-ignore
    );
  }

  return problems;
}

/**
 * The gates table's job legs: every job a Where cell names is a real job,
 * and a row claiming an `npm run` gate resolves through one of those jobs'
 * steps. A row whose local command takes another form states no `npm run`
 * claim, so only its Where jobs are held.
 * @param {Parameters<typeof evaluateDocClosure>[0]} s
 * @returns {string[]} problems
 */
function evaluateGateLiveness(s) {
  const problems = [];
  const jobs = new Map(s.workflowJobs.map((job) => [job.id, job]));
  for (const row of s.gateRows) {
    for (const id of row.where) {
      if (!jobs.has(id)) {
        problems.push(`the ${CI_DOC_PATH} lint-gates row \`${row.gate}\` runs in \`${id}\`, which is not a ${TEST_WORKFLOW_PATH} job`); // prettier-ignore
      }
    }
    const claim = NPM_RUN_COMMAND_RE.exec(row.command);
    if (claim === null) continue;
    const token = claim[1];
    const live = row.where.some((id) => runsGate(jobs.get(id), token, s.scriptCommands[token]));
    if (!live) {
      problems.push(`the ${CI_DOC_PATH} lint-gates row \`${row.gate}\` claims \`npm run ${token}\`, but no step of ${row.where.map((id) => `\`${id}\``).join(', ')} runs it`); // prettier-ignore
    }
  }
  return problems;
}

/**
 * Read every surface from a tree.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {() => string[]} listWorkflows returns workflow basenames
 * @param {() => string[]} listMarkdown returns tracked markdown paths
 * @param {() => string[]} listManifests returns tracked package.json paths
 * @returns {Parameters<typeof evaluateDocClosure>[0] & { counts: object }}
 */
export function auditTree(readFile, listWorkflows, listMarkdown, listManifests) {
  const ciDoc = readFile(CI_DOC_PATH);
  const localCiDoc = readFile(LOCAL_CI_DOC_PATH);
  const workflowYaml = readFile(TEST_WORKFLOW_PATH);
  const workflows = extractTableFileNames(ciDoc, WORKFLOW_SECTION, WORKFLOW_HEADER);
  const act = extractTableFileNames(localCiDoc, ACT_SECTION, ACT_HEADER);
  const gates = extractGateRows(ciDoc);
  const jobsTable = extractJobsTableRows(ciDoc);
  const alwaysRun = extractAlwaysRunIds(ciDoc);
  const jobs = extractJobIds(workflowYaml);
  const gating = extractWorkflowGating(workflowYaml);
  const steps = extractJobNpmRunTokens(workflowYaml, LINT_JOB_ID);
  const lint = extractLintSurface(readFile(ROOT_MANIFEST_PATH));
  const cites = [];
  const citeUnreadable = [];
  const colonCites = [];
  for (const path of listMarkdown()) {
    const text = readFile(path);
    const read = extractNpmRunCites(text, path);
    cites.push(...read.cites);
    citeUnreadable.push(...read.unreadable);
    colonCites.push(...extractColonCites(text, path));
  }
  const manifests = listManifests().map((path) => ({ path, text: readFile(path) }));
  const scripts = collectScriptKeys(manifests);
  return {
    workflowFiles: listWorkflows(),
    workflowRows: workflows.names,
    workflowUnreadable: workflows.unreadable,
    jobIds: jobs.ids,
    actRows: act.names,
    actUnreadable: act.unreadable,
    gateRows: gates.rows,
    gatesUnreadable: gates.unreadable,
    jobsTableRows: jobsTable.rows,
    jobsTableUnreadable: jobsTable.unreadable,
    alwaysRunIds: alwaysRun.ids,
    workflowJobs: gating.jobs,
    filterFlags: gating.filterFlags,
    chainTokens: lint.chainTokens,
    lintKeys: lint.lintKeys,
    lintStepTokens: steps.tokens,
    cites,
    citeUnreadable,
    colonCites: admitColonCites(colonCites, scripts.keys),
    scriptKeys: scripts.keys,
    scriptCommands: lint.commands,
    anchorProblems: [
      ...jobs.problems,
      ...gating.problems,
      ...alwaysRun.problems,
      ...steps.problems,
      ...lint.problems,
      ...scripts.problems,
    ],
  };
}

/**
 * Read every surface from the real tree at `root` — the one listing the CLI
 * and the suite's real-tree lock share, so the lock exercises exactly what
 * CI runs. All listings are git-tracked (the workflow leg included, so an
 * untracked local `.yml` cannot red a run CI would pass).
 * @param {string} root repository root (absolute or relative)
 * @returns {ReturnType<typeof auditTree>}
 */
export function treeSurfaces(root) {
  const resolvePath = (p) => join(root, p);
  const gitList = (pattern) =>
    execFileSync('git', ['ls-files', pattern], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  return auditTree(
    (path) => {
      try {
        return readFileSync(resolvePath(path), 'utf8');
      } catch {
        return '';
      }
    },
    () => workflowBasenames(gitList(`${WORKFLOWS_DIR}/*.y*ml`)),
    () => gitList('*.md'),
    () => gitList('*package.json').filter((p) => p.split('/').pop() === 'package.json'),
  );
}

/* c8 ignore start -- CLI wrapper: the pure pieces above are unit-tested; this
 * glue reads the real tree and formats the verdict. An unreadable surface
 * fails the non-empty guards loudly. */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const surfaces = treeSurfaces('.');
  const problems = [...surfaces.anchorProblems, ...evaluateDocClosure(surfaces)];
  if (problems.length > 0) {
    console.error('Doc-closure check failed:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`\n${problems.length} problem(s). The guides' closure tables and the tree must agree; fix whichever side is wrong.`); // prettier-ignore
    process.exit(1);
  }
  console.log(`✓ doc closure holds: ${surfaces.workflowFiles.length} workflows, ${surfaces.jobIds.length} jobs, ${surfaces.gateRows.length} gate rows, ${surfaces.cites.length} npm-run citations, and ${surfaces.colonCites.length} script-key citations agree with the tree.`); // prettier-ignore
}
/* c8 ignore stop */
