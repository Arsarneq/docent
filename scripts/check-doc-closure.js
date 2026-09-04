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
 *     markdown is admitted to the leg when the register below carries it —
 *     shape first, register second, so a colon-named thing that is not a
 *     script is left alone whatever its leading segment reads as. An
 *     admitted token must itself be a defined key, so a renamed script's
 *     leftover cite reds even when the family it was named in is renamed
 *     with it; a defined key cited without being registered reds so the
 *     register grows with the citations; and a registered token nothing
 *     cites reds so it cannot outlive them;
 *   - the runner and act-verdict cells: each table's runner column states
 *     the labels the workflow runs that job on, read through that table's
 *     own spelling of a matrix, and the act table's verdict agrees with what
 *     the workflow makes derivable — a Windows-only runner, a mixed matrix
 *     whose Linux leg alone runs locally, an artifact only a Windows job
 *     produces, or a repository secret. Recomputed rather than merely
 *     present, so a cell that is deleted reds exactly as a falsified one
 *     does.
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
 * its legs: a row whose local command is not an `npm run` form is held to
 * naming live Where jobs only — whether such a job still runs that gate, and
 * in what step form, stays review-held, unless a gate of its own holds those
 * jobs to carrying the step, as the clippy-invocation check does for the
 * Clippy row, which leaves the rustfmt row held the first way. An `npm run` row
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
 * review-held. Back among the review-held claims:
 * npm-run citations resolve against the union of every tracked manifest's
 * script keys, so which package a doc means is review-held; a bare cite of a
 * family no manifest defines any more is unread, and so is a bare family
 * stem, which the colon-cite grammar deliberately does not admit — that leg
 * names keys, never stems; and a tracked YAML nested below the workflows
 * directory is not a workflow the platform runs. The runner leg has its own
 * three: that `act` runs Linux containers is the premise the guide states in
 * prose and the derivation stands on, never a fact read from the tree; the
 * REASON a pinned image is pinned, like every other parenthetical a runner
 * cell carries, is prose beside a recomputed label; and the two
 * recommendation verdicts — a job not worth running locally, a job with
 * nothing of its own to run — are advice, admitted wherever the tree says
 * the job CAN run and held no further. One derivation boundary rides with
 * them: a job that downloads its artifacts by PATTERN states no artifact
 * name to join to a producer, so its verdict stands on the other facts. The line scans are shaped to test.yml's committed
 * layout — the shared top-level `jobs:` anchor and the two-space job keys
 * they read — and each refuses the file loudly, naming itself, if the anchor
 * vanishes.
 *
 * Usage:
 *   node scripts/check-doc-closure.js  # or: npm run lint:doc-closure
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  backtickedName,
  duplicateSurfaceProblems,
  emptySurfaceProblems,
  escapeForRegExp,
  flattenWhitespace,
  missingFrom,
  parseTables,
  selfPath,
  stripFences,
  trackedFilesUnder,
} from './check-test-inventory.js';
import {
  CHANGES_JOB_ID,
  PATHS_FILTER_USES,
  jobFlags,
  jobSteps,
  pathsFilterStep,
} from './check-ci-filter.js';

export const SELF_PATH = selfPath(import.meta.filename);
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
 * The pathspec a tracked listing of the workflow files is taken over. It sits
 * beside the boundary it feeds because the two are one decision: the pathspec
 * is what git is asked for, and {@link workflowPaths} is what the answer is
 * held to. Every check that reads this file set takes both from here.
 */
export const WORKFLOW_PATHSPEC = `${WORKFLOWS_DIR}/*.y*ml`;

/**
 * The workflow files among a listing, paths intact: tracked YAML directly under
 * the workflows directory. Applying {@link WORKFLOW_FILE_RE} here is what keeps
 * the boundary — git's pathspec `*` crosses `/`, so the listing itself sweeps
 * nested YAML in. Exported so every check reading this file set applies one
 * filter, and so the suites can drive it on the listing path rather than only
 * on the pattern.
 * @param {string[]} paths repo-relative paths from the listing
 * @returns {string[]} the workflow files among them, paths intact
 */
export function workflowPaths(paths) {
  return paths.filter((path) => WORKFLOW_FILE_RE.test(path));
}

/**
 * The workflow basenames a raw listing yields — {@link workflowPaths} read for
 * the names the inventory table states rather than for the paths themselves.
 * @param {string[]} paths repo-relative paths from the listing
 * @returns {string[]} basenames of the workflow files among them
 */
export function workflowBasenames(paths) {
  return workflowPaths(paths).map((path) => path.split('/').pop());
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
 * its own tokens stay held by the citation leg. The cell itself rides along
 * as `commandCell`, so a neighbouring check reading more of that cell reads
 * the cell this reader selected rather than selecting one of its own. The Where cell is read
 * positively: every backticked span matching the job-id grammar is a named
 * job and any non-backticked remainder is qualifier prose, so only a cell
 * naming no job at all is refused. A row with an unreadable gate cell, a
 * Where cell naming nothing, or no backticked command is refused rather than
 * skipped, and a table with no `Where` column is refused as a whole.
 * @param {string} docText
 * @returns {{ rows: { gate: string, tokens: string[], where: string[], command: string,
 *                     commandCell: string }[],
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
      rows.push({ gate, tokens, where, command, commandCell });
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
 * What the line-based job scan says when the workflow carries no anchor to
 * read job ids under. Stated once and matched through
 * {@link isJobAnchorProblem}, so the words live in one place among the checks
 * and a reader routing this condition never restates them.
 */
const JOB_ANCHOR_PROBLEM = 'carries no top-level `jobs:` key';

/**
 * Whether a problem {@link extractJobIds} reported is that anchor condition —
 * the workflow carrying no top-level `jobs:` key at all — rather than any
 * other problem this extractor may grow later. A caller routing the anchor
 * condition to a verdict of its own asks here instead of matching on the
 * diagnosis's words, so rewording the diagnosis moves both sides at once and
 * a problem grown later keeps the route it has today.
 * @param {string} problem one problem string as this module reported it
 * @returns {boolean}
 */
export function isJobAnchorProblem(problem) {
  return problem.includes(JOB_ANCHOR_PROBLEM);
}

/**
 * The `jobs:` anchor read: the index of the top-level `jobs:` line, or -1
 * with a diagnosis naming the failing scan. Its caller is
 * {@link extractJobIds}, which passes its own scan name, so a change to what
 * counts as the anchor is one edit here and the diagnosis keeps naming the
 * scan that asked.
 * @param {string[]} lines
 * @param {string} scan the calling scan's name, for the diagnosis
 * @returns {{ start: number, problem: string | null }}
 */
function findJobsBlock(lines, scan) {
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start === -1) {
    return { start, problem: `${TEST_WORKFLOW_PATH} ${JOB_ANCHOR_PROBLEM} — the ${scan} cannot anchor` }; // prettier-ignore
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
 * The runner columns, one grammar per table: which document states them, the
 * table each sits in, and the conjunction that table writes a matrix job's
 * several runners with. Their differing spellings are the reason the grammar is
 * per-table rather than one house form — each document writes the same fact
 * the way its own prose reads, and the recompute holds the FACT, never the
 * spelling.
 */
export const RUNNER_TABLES = [
  {
    doc: CI_DOC_PATH,
    section: GATES_SECTION,
    header: JOBS_TABLE_HEADER,
    column: 'Runner',
    conjunction: /\s*\+\s*/,
  },
  {
    doc: LOCAL_CI_DOC_PATH,
    section: ACT_SECTION,
    header: ACT_HEADER,
    column: 'CI runner',
    conjunction: /\s*\*\*and\*\*\s*/,
  },
];

/** The act table's verdict column, the one cell this check recomputes a class for. */
export const ACT_VERDICT_HEADER = 'Runs under `act`?';

/**
 * The verdict classes an act row can open with, and what each states. Two of
 * them are RECOMMENDATIONS rather than boundary facts: a job that could run
 * under act, which the guide tells a reader not to bother with, or which has
 * nothing of its own to run. Those are review-held prose — the tree cannot
 * derive advice — so the leg admits them wherever a job CAN run, and holds
 * the boundary markers exactly.
 */
export const ACT_VERDICTS = [
  ['yes', '✅'],
  ['no', '❌'],
  ['unneeded', 'unneeded'],
  ['nothing to run', 'nothing to run'],
];

/** What an act cell states for the one job whose matrix runs on both platforms. */
export const ACT_PARTIAL_PHRASE = 'the ubuntu leg only';

/** A trailing parenthetical rationale a runner cell carries after its label. */
const RUNNER_RATIONALE_RE = /\s*\([^)]*\)\s*$/;
/** The word a runner cell may close a matrix statement with. */
const MATRIX_WORD_RE = /\s+matrix$/;

/** The action a step uploads an artifact through, as its `uses` names it. */
const UPLOAD_ARTIFACT_USES = 'upload-artifact';
/** The action a step downloads an artifact through, as its `uses` names it. */
const DOWNLOAD_ARTIFACT_USES = 'download-artifact';
/** A reference to a repository secret, anywhere in a job's own text. */
const SECRET_REFERENCE_RE = /secrets\./;
/** The runner family a Windows runner label opens with. */
const WINDOWS_RUNNER_PREFIX = 'windows';
/** A runner label stating no version, which the shorthand `-latest` completes. */
const BARE_RUNNER_RE = /^[a-z]+$/;
/** A `runs-on` deferring to the matrix, naming the key that carries the runner. */
const MATRIX_RUNNER_RE = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/;

/**
 * The runner labels one parsed job runs on: its `runs-on`, or — where that
 * defers to the matrix — the label each matrix leg states. A matrix is what
 * makes a job's runner a SET rather than one label, which is the fact both
 * runner columns state in their own spelling.
 * @param {any} job one parsed job
 * @returns {string[]} the labels, in the order the workflow states them
 */
function runnersOf(job) {
  const runsOn = String(job?.['runs-on'] ?? '');
  const deferred = MATRIX_RUNNER_RE.exec(runsOn);
  if (deferred === null) return runsOn === '' ? [] : [runsOn];
  // The expression names WHICH matrix key carries the runner, so a leg's other
  // keys — a display label, a feature flag — are never read as runners.
  const key = deferred[1];
  const legs = Array.isArray(job?.strategy?.matrix?.include) ? job.strategy.matrix.include : [];
  return legs
    .map((leg) => (leg === null || typeof leg !== 'object' ? '' : String(leg[key] ?? '')))
    .filter((label) => label !== '');
}

/**
 * The artifact names a job's steps name through one artifact action. A step
 * that names its artifacts by PATTERN states no name here: the producer of a
 * pattern's artifacts cannot be joined by name, which is this leg's own
 * recorded boundary — a job that consumes by pattern is read as consuming
 * nothing, so its verdict stands on the facts that are derivable.
 * @param {any[]} steps the job's steps
 * @param {string} uses the artifact action's name fragment
 * @returns {string[]} the artifact names, in step order
 */
function artifactNames(steps, uses) {
  return steps
    .filter((step) => String(step?.uses ?? '').includes(uses))
    .map((step) => String(step?.with?.name ?? ''))
    .filter((name) => name !== '');
}

/**
 * Read one document's runner column through its own grammar: each row's job,
 * the runner labels its cell states, and whether the cell carried a
 * parenthetical rationale (which stays prose — the pinned image's REASON is
 * not derivable, only the label is). A cell the grammar cannot read is
 * returned unreadable, never skipped.
 * @param {string} docText the document's text
 * @param {typeof RUNNER_TABLES[number]} grammar the table's own grammar
 * @returns {{ rows: { job: string, runners: string[], rationale: boolean }[], unreadable: string[] }}
 */
export function extractRunnerCells(docText, grammar) {
  const rows = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== grammar.section || table.header[0] !== grammar.header) continue;
    const column = table.header.indexOf(grammar.column);
    if (column === -1) {
      unreadable.push(`${grammar.doc}: the ${grammar.section} table states no \`${grammar.column}\` column`); // prettier-ignore
      continue;
    }
    for (const row of table.rows) {
      const job = backtickedName(row[0]);
      const cell = (row[column] ?? '').trim();
      if (job === null || !JOB_ID_RE.test(job)) continue;
      if (cell === '') {
        unreadable.push(`${grammar.doc}: \`${job}\` states an empty ${grammar.column} cell`);
        continue;
      }
      const rationale = RUNNER_RATIONALE_RE.test(cell);
      const labels = cell
        .replace(RUNNER_RATIONALE_RE, '')
        .replace(MATRIX_WORD_RE, '')
        .split(grammar.conjunction)
        .map((label) => label.trim())
        .filter(Boolean);
      rows.push({ job, runners: labels.map(completeRunnerLabel), rationale });
    }
  }
  return { rows, unreadable };
}

/**
 * A runner label as the workflow spells it: a cell may write the shorthand a
 * reader says out loud (`ubuntu`), and the workflow states the image
 * (`ubuntu-latest`). Completing the shorthand is what lets the two be
 * compared without either side restating the other's spelling.
 * @param {string} label a runner label as a cell states it
 * @returns {string}
 */
export function completeRunnerLabel(label) {
  return BARE_RUNNER_RE.test(label) ? `${label}-latest` : label;
}

/**
 * Read the act table's verdict column as the class each row opens with.
 * @param {string} docText the local-CI guide's text
 * @returns {{ rows: { job: string, verdict: string | null }[], unreadable: string[] }}
 */
export function extractActVerdicts(docText) {
  const rows = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== ACT_SECTION || table.header[0] !== ACT_HEADER) continue;
    const column = table.header.indexOf(ACT_VERDICT_HEADER);
    if (column === -1) {
      unreadable.push(`${LOCAL_CI_DOC_PATH}: the act table states no \`${ACT_VERDICT_HEADER}\` column`); // prettier-ignore
      continue;
    }
    for (const row of table.rows) {
      const job = backtickedName(row[0]);
      const cell = (row[column] ?? '').trim();
      if (job === null || !JOB_ID_RE.test(job)) continue;
      const match = ACT_VERDICTS.find(([, opening]) => cell.startsWith(opening));
      if (match === undefined) {
        unreadable.push(`${LOCAL_CI_DOC_PATH}: \`${job}\` opens its act verdict "${cell}", which is none of ${ACT_VERDICTS.map(([, o]) => `"${o}"`).join(', ')}`); // prettier-ignore
        continue;
      }
      rows.push({ job, verdict: match[0], partial: cell.includes(ACT_PARTIAL_PHRASE) });
    }
  }
  return { rows, unreadable };
}

/**
 * What the tree says about running one job under act — the boundary facts a
 * workflow states, and nothing beyond them. Act runs Linux containers, which
 * is the premise the guide states in prose and this derivation stands on: a
 * job every runner of which is Windows cannot run, one whose matrix has a
 * Linux leg runs that leg only, a job consuming an artifact only a Windows
 * job produces cannot run, and a job reaching for a repository secret is
 * outside the boundary a local run can reproduce. Everything else can run —
 * whether it is WORTH running is the guide's own advice, not a fact here.
 * @param {{ id: string, runners: string[], downloads: string[], usesSecret: boolean }} job
 * @param {{ id: string, runners: string[], uploads: string[] }[]} jobs every parsed job
 * @returns {'yes' | 'no' | 'partial'}
 */
export function deriveActVerdict(job, jobs) {
  const isWindows = (label) => label.startsWith(WINDOWS_RUNNER_PREFIX);
  const windows = job.runners.filter(isWindows);
  if (job.runners.length > 0 && windows.length === job.runners.length) return 'no';
  if (windows.length > 0) return 'partial';
  if (job.usesSecret) return 'no';
  const producedOnWindows = job.downloads.some((name) =>
    jobs.some(
      (other) =>
        other.uploads.includes(name) && other.runners.length > 0 && other.runners.every(isWindows),
    ),
  );
  return producedOnWindows ? 'no' : 'yes';
}

/**
 * The `npm run` tokens one parsed job's steps run, read from the step
 * commands the workflow parse already yields — the same text the runner
 * executes, so a token written in a step's display name, in a YAML comment,
 * or as an action input is not read as a command the job runs. A job the
 * parse does not carry is the caller's own problem, named where the parsed
 * jobs are read.
 * @param {{ id: string, stepLines: string[] }[]} jobs the parsed jobs
 * @param {string} jobId
 * @returns {{ tokens: string[], problems: string[] }}
 */
export function jobNpmRunTokens(jobs, jobId) {
  const job = jobs.find((j) => j.id === jobId);
  if (job === undefined) {
    return { tokens: [], problems: [`${TEST_WORKFLOW_PATH} has no \`${jobId}\` job — its step commands cannot be read`] }; // prettier-ignore
  }
  const tokens = [];
  for (const line of job.stepLines) {
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
  const jobs = Object.entries(jobsMap).map(([id, job]) => ({
    id,
    flags: [...jobFlags(job)],
    condition: job?.if === undefined ? null : String(job.if),
    stepLines: jobSteps(job)
      .filter((step) => typeof step?.run === 'string')
      .flatMap((step) => step.run.split(/\r?\n/))
      .filter((line) => line.trim() !== ''),
    runners: runnersOf(job),
    uploads: artifactNames(jobSteps(job), UPLOAD_ARTIFACT_USES),
    downloads: artifactNames(jobSteps(job), DOWNLOAD_ARTIFACT_USES),
    usesSecret: SECRET_REFERENCE_RE.test(JSON.stringify(job ?? null)),
  }));
  const changes = jobsMap[CHANGES_JOB_ID];
  const filterStep = pathsFilterStep(changes);
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
 * The script-key citations this check holds, by name. Admission is shape
 * first and this register second: a colon-bearing backticked token enters the
 * leg only if it is written here, so a colon-named thing that is not a script
 * — an event channel, a capability grant, a YAML key, a URL scheme — is left
 * alone however its leading segment happens to read, and a token whose family
 * is renamed away is still held rather than falling out of the leg with it.
 *
 * The register is held in both directions below: every token here names a
 * defined script key, and every token here is cited by some tracked document
 * — so the list cannot outlive the citations it exists for.
 */
export const REGISTERED_COLON_CITES = [
  'corpus:check:desktop',
  'lint:area-map',
  'lint:clause-governance',
  'lint:clause-preamble',
  'lint:clause-registry',
  'lint:js',
  'lint:links',
  'lint:reachability',
  'sufficiency:check',
  'vectors:assemble:desktop',
  'vectors:produce:desktop',
];

/**
 * The citations the register admits, out of every colon-shaped token the scan
 * read. An unregistered token names something this check does not read and is
 * left alone; an admitted one is then held to being a defined key exactly.
 * @param {{ path: string, line: number, token: string }[]} cites
 * @param {string[]} [registered] the register to admit against
 * @returns {{ path: string, line: number, token: string }[]}
 */
export function admitColonCites(cites, registered = REGISTERED_COLON_CITES) {
  const admitted = new Set(registered);
  return cites.filter((cite) => admitted.has(cite.token));
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
 * surface. Both shared guard loops below are handed this projection per entry,
 * so a surface of records is counted and de-duplicated by the name it carries
 * rather than by its shape, and a key with no entry here is read off the
 * surfaces directly.
 */
const SURFACE_LISTS = {
  scriptKeys: (s) => [...s.scriptKeys],
  gateRows: (s) => s.gateRows.map((row) => row.gate),
  jobsTableRows: (s) => s.jobsTableRows.map((row) => row.job),
  colonCites: (s) => s.colonCites.map((cite) => cite.token),
};

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
  ['colonCites', `no registered script-key citation found in tracked markdown — the register or the scan that feeds it is broken`], // prettier-ignore
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
 * end of line, in the same pass as the quoting so an apostrophe inside one
 * cannot open a quote over the commands that follow it; and the remainder splits on `&&`, `||`, `;`, `|`, and newline.
 * A leading `(` — the subshell form — is stripped so the segment still opens
 * with the command it runs.
 * @param {string} text one step's `run:` line or block
 * @returns {string[]} the trimmed, non-empty segments
 */
export function commandSegments(text) {
  let bare = '';
  let quote = null;
  let comment = false;
  let previous = '\n';
  for (const char of text) {
    if (comment) {
      // A comment runs to end of line; nothing inside it is a command, and
      // nothing inside it opens a quote — an apostrophe in prose would
      // otherwise swallow the commands on the lines after it.
      if (char !== '\n') continue;
      comment = false;
      bare += char;
      previous = char;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        bare += char;
        quote = null;
      }
      previous = char;
      continue; // quoted text is data the shell passes on, never a command
    }
    if (char === '#' && /[\s]/.test(previous)) {
      comment = true;
      previous = char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    bare += char;
    previous = char;
  }
  return bare
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
  const invocation = new RegExp(`^npm run ${escapeForRegExp(token)}(?![A-Za-z0-9:_-])`);
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
 * @param {{ doc: string, rows: { job: string, runners: string[] }[] }[]} s.runnerCells each table's runner column
 * @param {string[]} s.runnerCellsUnreadable the runner cells the grammar cannot read
 * @param {{ job: string, verdict: string, partial: boolean }[]} s.actVerdicts the act verdict classes
 * @param {string[]} s.actVerdictsUnreadable the act verdicts the grammar cannot read
 * @param {{ path: string, line: number, token: string }[]} s.colonCites registered script cites
 * @param {{ path: string, line: number, token: string }[]} s.allColonCites every colon-shaped token read
 * @param {string[]} s.registeredColonCites the register admission runs against
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
  for (const cell of s.runnerCellsUnreadable) {
    problems.push(`runner cell the scan cannot read — ${cell}`);
  }
  for (const cell of s.actVerdictsUnreadable) {
    problems.push(`act verdict the scan cannot read — ${cell}`);
  }

  // Both guards run through the shared loops, each entry carrying its own
  // projection: the projector an entry supplies is what the loop applies, and
  // a key with none is read off the surfaces directly. `scriptKeys` is a Set,
  // so its projection is what makes its length readable at all.
  const empty = emptySurfaceProblems(
    s,
    EMPTY_SURFACES.map(([key, message]) => [key, message, SURFACE_LISTS[key]]),
  );
  if (empty.length > 0) {
    problems.push(...empty);
    return problems; // empty parses make the closure diffs meaningless
  }

  problems.push(
    ...duplicateSurfaceProblems(
      s,
      DUPLICATE_SURFACES.map(([key, what]) => [key, what, SURFACE_LISTS[key]]),
    ),
  );

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

  problems.push(...evaluateJobPartition(s), ...evaluateGateLiveness(s), ...evaluateRunnerCells(s));

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

  // The register's own directions, then the citations it admits. A
  // registered token that is no longer a defined key reds wherever it is
  // cited, whatever became of the family it was named in; a defined key cited
  // in prose without being registered reds so the register grows with the
  // citations; and a registered token nothing cites reds so it cannot outlive
  // them. Every other colon-shaped token in the tree is outside the leg.
  const registered = new Set(s.registeredColonCites);
  const citedTokens = new Set(s.allColonCites.map((cite) => cite.token));
  for (const cite of s.colonCites) {
    if (!s.scriptKeys.has(cite.token)) {
      problems.push(`${cite.path}:${cite.line} cites \`${cite.token}\`, a registered script-key citation, but no tracked package.json defines that script key`); // prettier-ignore
    }
  }
  for (const cite of s.allColonCites) {
    if (!registered.has(cite.token) && s.scriptKeys.has(cite.token)) {
      problems.push(`${cite.path}:${cite.line} cites \`${cite.token}\`, which is a defined script key, but ${SELF_PATH}'s register does not carry it — register it, or the day that key is renamed this citation goes stale in silence`); // prettier-ignore
    }
  }
  for (const token of s.registeredColonCites) {
    if (!citedTokens.has(token)) {
      problems.push(`${SELF_PATH}'s register carries \`${token}\` but no tracked markdown cites it — drop it, so the register states the citations this check holds and nothing else`); // prettier-ignore
    }
  }

  return problems;
}

/**
 * The runner legs: every runner cell states the labels the workflow runs that
 * job on — read through each table's own grammar, so a matrix each document
 * spells its own way is one fact — and every act verdict agrees with what the tree makes
 * derivable. The recommendation verdicts are admitted wherever the job
 * CAN run, since advice is not a fact this check derives; the boundary
 * verdicts are held exactly, in both directions.
 * @param {object} s the extracted surfaces
 * @returns {string[]} problems
 */
export function evaluateRunnerCells(s) {
  const problems = [];
  const byId = new Map(s.workflowJobs.map((job) => [job.id, job]));
  for (const { doc, rows } of s.runnerCells) {
    for (const { job, runners } of rows) {
      const parsed = byId.get(job);
      if (parsed === undefined) continue; // the job-set legs above name this
      problems.push(
        ...missingFrom(runners, parsed.runners, `is a runner ${doc} states for \`${job}\` but ${TEST_WORKFLOW_PATH} does not run it there`), // prettier-ignore
        ...missingFrom(parsed.runners, runners, `is a runner ${TEST_WORKFLOW_PATH} runs \`${job}\` on but ${doc} does not state it`), // prettier-ignore
      );
    }
  }
  for (const { job, verdict, partial } of s.actVerdicts) {
    const parsed = byId.get(job);
    if (parsed === undefined) continue;
    const derived = deriveActVerdict(parsed, s.workflowJobs);
    if (derived === 'no' && verdict !== 'no') {
      problems.push(`${LOCAL_CI_DOC_PATH} states \`${job}\` as "${verdict}" under act, but ${TEST_WORKFLOW_PATH} puts it outside what a Linux container can run — a Windows-only runner, an artifact only a Windows job produces, or a repository secret`); // prettier-ignore
    }
    if (derived !== 'no' && verdict === 'no') {
      problems.push(`${LOCAL_CI_DOC_PATH} states \`${job}\` as not runnable under act, but ${TEST_WORKFLOW_PATH} states no boundary this check derives for it`); // prettier-ignore
    }
    if (derived === 'partial' && !partial) {
      problems.push(`${LOCAL_CI_DOC_PATH} states \`${job}\` without "${ACT_PARTIAL_PHRASE}", but its matrix runs a Linux leg beside a Windows one — only the Linux leg runs locally`); // prettier-ignore
    }
    if (derived !== 'partial' && partial) {
      problems.push(`${LOCAL_CI_DOC_PATH} states "${ACT_PARTIAL_PHRASE}" for \`${job}\`, whose matrix ${TEST_WORKFLOW_PATH} does not split across platforms`); // prettier-ignore
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
      problems.push(`\`${job.id}\` gates on no \`${CHANGES_JOB_ID}\` flag, but its \`if:\` condition — ${flattenWhitespace(String(job.condition))} — is neither absent nor \`always()\`, so which side of ${CI_DOC_PATH} it belongs on is gating this check does not model`); // prettier-ignore
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
  const steps = jobNpmRunTokens(gating.jobs, LINT_JOB_ID);
  // Keyed by path, so a grammar naming a third document reads THAT document
  // rather than falling through to whichever side an either/or defaulted to.
  const guideTexts = new Map([
    [CI_DOC_PATH, ciDoc],
    [LOCAL_CI_DOC_PATH, localCiDoc],
  ]);
  const runnerCells = RUNNER_TABLES.map((grammar) => ({
    doc: grammar.doc,
    ...extractRunnerCells(guideTexts.get(grammar.doc) ?? readFile(grammar.doc), grammar),
  }));
  const actVerdicts = extractActVerdicts(localCiDoc);
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
    runnerCells,
    runnerCellsUnreadable: runnerCells.flatMap((t) => t.unreadable),
    actVerdicts: actVerdicts.rows,
    actVerdictsUnreadable: actVerdicts.unreadable,
    cites,
    citeUnreadable,
    colonCites: admitColonCites(colonCites),
    allColonCites: colonCites,
    registeredColonCites: REGISTERED_COLON_CITES,
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
  // Through the shared population reader, whose docblock in
  // scripts/check-test-inventory.js states the quotepath policy.
  const gitList = (pathspec) => trackedFilesUnder(pathspec, { cwd: root });
  return auditTree(
    (path) => {
      try {
        return readFileSync(resolvePath(path), 'utf8');
      } catch {
        return ''; // an unreadable surface fails the non-empty guards loudly
      }
    },
    () => workflowBasenames(gitList(WORKFLOW_PATHSPEC)),
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
  console.log(`✓ doc closure holds: ${surfaces.workflowFiles.length} workflows, ${surfaces.jobIds.length} jobs, ${surfaces.gateRows.length} gate rows, ${surfaces.cites.length} npm-run citations, ${surfaces.colonCites.length} script-key citations, and the runner and act-verdict cells of ${surfaces.runnerCells.reduce((n, t) => n + t.rows.length, 0)} table rows agree with the tree.`); // prettier-ignore
}
/* c8 ignore stop */
