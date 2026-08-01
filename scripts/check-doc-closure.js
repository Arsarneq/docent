/**
 * check-doc-closure.js — admission test for the CI guides' closure claims:
 *
 *   - the workflow inventory (docs/guides/ci.md § The workflow inventory):
 *     every tracked workflow file directly under .github/workflows/ has a
 *     table row, and every row names a tracked workflow file;
 *   - the act table (docs/guides/local-ci.md § What can — and can't — run
 *     under `act`): the table keys exactly the job ids of test.yml, both
 *     ways;
 *   - the lint-gates table (docs/guides/ci.md § The lint and freshness
 *     gates): package.json's `lint` chain names exactly the `lint:*` script
 *     family, every `lint:*` script has a table row naming it, and every
 *     `npm run` gate step of test.yml's lint job has a table row naming the
 *     same script;
 *   - npm-run citations: every `npm run <token>` in tracked markdown names a
 *     script key in some tracked package.json (an elided family stem such as
 *     `npm run lint:…` passes only while at least one key starts with the
 *     stem).
 *
 * Every parsed surface must be non-empty, an unreadable table cell is
 * refused rather than skipped, and both workflow scans require their shared
 * `jobs:` anchor — a broken read fails loudly instead of passing vacuously.
 *
 * Honest limits: the guides' prose paragraphs stay review-held — this check
 * reads the inventory tables, the gates table's Local-command column, the
 * job keys, and `npm run` tokens, never sentence meaning; the guide's other
 * job-naming surfaces — among them the path-filtered jobs table, the
 * always-run prose, and the gates table's Where column — are outside its
 * legs, as is a tracked YAML nested below the workflows directory (not a
 * workflow the platform runs). The check holds the gates table to three
 * properties: the `lint` chain runs exactly the `lint:*` family, the family
 * and the lint job's `npm run` steps each have a row, and every `npm run`
 * command a row cites names a real script (the last held by the citation
 * leg over all tracked markdown). Whether any given row still corresponds
 * to a gate that runs is held by review, for every row, whatever form its
 * local command takes. A script name cited outside the `npm run` form (a
 * bare backticked key) is outside the citation leg. The workflow scans are
 * shaped to test.yml's committed layout — the shared top-level `jobs:`
 * anchor, and the job scan's two-space job keys — and each refuses the
 * file loudly, naming itself, if the anchor vanishes. Npm-run citations are
 * resolved against the union of every tracked manifest's script keys, so
 * which package a doc means is review-held — the leg catches a token no
 * manifest defines, not a token cited against the wrong package.
 *
 * Usage:
 *   node scripts/check-doc-closure.js  # or: npm run lint:doc-closure
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { duplicatesIn, missingFrom, parseTables, backtickedName } from './check-test-inventory.js';

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
export const LINT_JOB_ID = 'lint';
export const LINT_CHAIN_KEY = 'lint';
export const LINT_FAMILY_PREFIX = 'lint:';

const NPM_RUN_TOKEN_RE = /npm run ([A-Za-z0-9:_-]+)/g;
const ELLIPSIS = '…';

/**
 * The files the workflow-inventory leg closes over: tracked YAML directly
 * under the workflows directory — a nested YAML is not a workflow the
 * platform runs. Exported so the suite can pin the boundary in both
 * directions.
 */
export const WORKFLOW_FILE_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

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
 * The gates table's rows, read as gate name + the `npm run` tokens of the
 * Local-command column (the last column; the Red-when prose column also
 * carries tokens and is deliberately not read). A row with an unreadable
 * gate cell is refused.
 * @param {string} docText
 * @returns {{ rows: { gate: string, tokens: string[] }[], unreadable: string[] }}
 */
export function extractGateRows(docText) {
  const rows = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== GATES_SECTION || table.header[0] !== GATES_HEADER) continue;
    const commandColumn = table.header.length - 1;
    for (const row of table.rows) {
      const gate = (row[0] ?? '').trim();
      if (gate === '') {
        unreadable.push(row.join(' | '));
        continue;
      }
      const tokens = [...(row[commandColumn] ?? '').matchAll(NPM_RUN_TOKEN_RE)].map((m) => m[1]);
      rows.push({ gate, tokens });
    }
  }
  return { rows, unreadable };
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
 * The root manifest's `lint` chain tokens and its `lint:*` script family.
 * @param {string} manifestJson
 * @returns {{ chainTokens: string[], lintKeys: string[], problems: string[] }}
 */
export function extractLintSurface(manifestJson) {
  let parsed;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return { chainTokens: [], lintKeys: [], problems: [`${ROOT_MANIFEST_PATH} does not parse as JSON`] }; // prettier-ignore
  }
  const scripts = parsed?.scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    return { chainTokens: [], lintKeys: [], problems: [`${ROOT_MANIFEST_PATH} carries no scripts object — the lint surface cannot be read`] }; // prettier-ignore
  }
  const problems = [];
  const chain = scripts[LINT_CHAIN_KEY];
  const chainTokens =
    typeof chain === 'string' ? [...chain.matchAll(NPM_RUN_TOKEN_RE)].map((m) => m[1]) : [];
  if (typeof chain !== 'string') {
    problems.push(`${ROOT_MANIFEST_PATH} has no \`${LINT_CHAIN_KEY}\` chain script`);
  }
  const lintKeys = Object.keys(scripts).filter((k) => k.startsWith(LINT_FAMILY_PREFIX));
  return { chainTokens, lintKeys, problems };
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
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this
 * list — a leg added here is exercised automatically, and the suite holds
 * the list non-empty and its diagnoses distinct. One leg is not an array:
 * `scriptKeys` is a Set, and the loop reads it through its own projection.
 */
export const EMPTY_SURFACES = [
  ['workflowFiles', `no tracked workflow files found under ${WORKFLOWS_DIR}`],
  ['workflowRows', `no workflow-inventory rows found in ${CI_DOC_PATH}`],
  ['jobIds', `no job ids found in ${TEST_WORKFLOW_PATH}`],
  ['actRows', `no act-table rows found in ${LOCAL_CI_DOC_PATH}`],
  ['gateRows', `no lint-gates rows found in ${CI_DOC_PATH}`],
  ['chainTokens', `no npm-run tokens found in ${ROOT_MANIFEST_PATH}'s \`lint\` chain`],
  ['lintKeys', `no \`${LINT_FAMILY_PREFIX}*\` scripts found in ${ROOT_MANIFEST_PATH}`],
  ['lintStepTokens', `no npm-run step tokens found in ${TEST_WORKFLOW_PATH}'s \`${LINT_JOB_ID}\` job`], // prettier-ignore
  ['cites', `no npm-run citations found in tracked markdown — the citation scan is broken`],
  ['scriptKeys', `no script keys found in any tracked package.json`],
];

/**
 * The duplicates guard's legs — the drift the deduplicating set diffs
 * cannot see. `gateRows` is read by its gate names. Exported for the same
 * suite treatment as {@link EMPTY_SURFACES}, plus the fixture-key equality
 * lock its hand-written fixtures need.
 */
export const DUPLICATE_SURFACES = [
  ['workflowRows', 'the workflow-inventory table'],
  ['actRows', 'the act table'],
  ['jobIds', `${TEST_WORKFLOW_PATH}'s job ids`],
  ['gateRows', 'the lint-gates table'],
  ['chainTokens', 'the `lint` chain'],
];

/**
 * Pure core: evaluate every closure leg.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.workflowFiles basenames under .github/workflows/
 * @param {string[]} s.workflowRows the inventory table's file names
 * @param {string[]} s.workflowUnreadable its unreadable first cells
 * @param {string[]} s.jobIds test.yml's job ids
 * @param {string[]} s.actRows the act table's job ids
 * @param {string[]} s.actUnreadable its unreadable first cells
 * @param {{ gate: string, tokens: string[] }[]} s.gateRows the gates table
 * @param {string[]} s.gatesUnreadable its unreadable rows
 * @param {string[]} s.chainTokens the `lint` chain's `npm run` tokens
 * @param {string[]} s.lintKeys the `lint:*` script keys
 * @param {string[]} s.lintStepTokens the lint job's `npm run` step tokens
 * @param {{ path: string, line: number, token: string, elided: boolean }[]} s.cites
 * @param {string[]} s.citeUnreadable unreadable citations
 * @param {Set<string>} s.scriptKeys the union of tracked manifests' keys
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
    problems.push(`${CI_DOC_PATH} lint-gates row the scan cannot read — ${row}`);
  }
  for (const cite of s.citeUnreadable) {
    problems.push(`npm-run citation the scan cannot read — ${cite}`);
  }

  let vacuous = false;
  for (const [key, message] of EMPTY_SURFACES) {
    const list = key === 'scriptKeys' ? [...s.scriptKeys] : s[key];
    if (list.length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make the closure diffs meaningless

  for (const [key, what] of DUPLICATE_SURFACES) {
    const list = key === 'gateRows' ? s.gateRows.map((r) => r.gate) : s[key];
    problems.push(...duplicatesIn(list, what));
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
  const jobs = extractJobIds(workflowYaml);
  const steps = extractJobNpmRunTokens(workflowYaml, LINT_JOB_ID);
  const lint = extractLintSurface(readFile(ROOT_MANIFEST_PATH));
  const cites = [];
  const citeUnreadable = [];
  for (const path of listMarkdown()) {
    const read = extractNpmRunCites(readFile(path), path);
    cites.push(...read.cites);
    citeUnreadable.push(...read.unreadable);
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
    chainTokens: lint.chainTokens,
    lintKeys: lint.lintKeys,
    lintStepTokens: steps.tokens,
    cites,
    citeUnreadable,
    scriptKeys: scripts.keys,
    anchorProblems: [...jobs.problems, ...steps.problems, ...lint.problems, ...scripts.problems],
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
    () =>
      gitList(`${WORKFLOWS_DIR}/*.y*ml`)
        .filter((p) => WORKFLOW_FILE_RE.test(p))
        .map((p) => p.split('/').pop()),
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
  console.log(`✓ doc closure holds: ${surfaces.workflowFiles.length} workflows, ${surfaces.jobIds.length} jobs, ${surfaces.gateRows.length} gate rows, and ${surfaces.cites.length} npm-run citations agree with the tree.`); // prettier-ignore
}
/* c8 ignore stop */
