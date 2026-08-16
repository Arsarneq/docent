/**
 * check-clippy-invocation.js — admission test for the Clippy gate's single
 * stated invocation (docs/guides/ci.md §CI-1).
 *
 * The gate itself runs `cargo clippy` in the workflow; what this check holds is
 * the AGREEMENT between the surfaces that state that command and the steps that
 * run it, over the workflow and the tracked documentation:
 *
 *   1. the run lines — every `cargo clippy` step of the test workflow states
 *      the same command once its `${{ … }}` expressions are stripped, and every
 *      one of them runs from the same working directory;
 *   2. the row — the jobs the ci.md gates table's Clippy row names are exactly
 *      the jobs carrying such a step, both ways, and the directory those steps
 *      run from is one that row's local-command cell names;
 *   3. the stated invocations — every backticked span of tracked markdown that
 *      opens with the clippy command spells the run lines' command exactly,
 *      unless {@link STATED_INVOCATION_EXCEPTIONS} records why that span states
 *      something other than the gate's own invocation. That register is held
 *      both ways: an entry no span matches any more reds as surely as an
 *      unregistered variant does.
 *
 * Which surface this guards, next to its neighbour: check-doc-closure.js holds
 * the same row to naming live jobs and stops there — a row whose local command
 * is not an `npm run` form is review-held in it, and that documented residue is
 * exactly what this check picks up. It reads surfaces, never the tool: whether
 * these are the RIGHT flags is a review judgment, and whether the crate is
 * clippy-clean is the gate's own job in CI.
 *
 * Honest limits: the run lines are read structurally (js-yaml over the
 * workflow), so a clippy invocation reaching the crate some other way — from a
 * composite action, a cargo alias, a script a step calls — states nothing this
 * check can see, and the row leg would report the job carrying it as one the
 * workflow gives no clippy step. The stated-invocation leg reads tracked
 * markdown only, on the view its fenced blocks are stripped from, and only a
 * span that OPENS with the command: the same command inside a longer span,
 * spelled without backticks, written inside a fence, or stated in a
 * non-markdown file (a workflow comment, a composite action's description) is
 * outside it — the conservative direction for a scan whose register would
 * otherwise have to carry every prose mention of the tool, and the reason the
 * span reader runs a line at a time, where a span's two backticks are on one
 * line or are not a span. Flags are compared
 * as written: two spellings cargo treats alike but that differ as text — a
 * reordered pair, a long form against its short one — read as drift, which is a
 * false red rather than a false green, and the register records one if it ever
 * happens. One asymmetry sits outside every leg and is recorded here rather
 * than papered over: the jobs running these steps install their Rust toolchain
 * separately and only one of them requests the `clippy` component, the other's
 * step running green all the same. This check holds what the jobs RUN, never
 * how the tool came to be there, so a component list that changes underneath
 * the run lines stays review-held.
 *
 * Usage:
 *   node scripts/check-clippy-invocation.js  # or: npm run check:clippy-invocation
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  flattenWhitespace,
  parseTables,
  stripFences,
  trackedFilesUnder,
} from './check-test-inventory.js';
import {
  CI_DOC_PATH,
  GATES_HEADER,
  GATES_SECTION,
  TEST_WORKFLOW_PATH,
  extractGateRows,
} from './check-doc-closure.js';

const ROOT = join(import.meta.dirname, '..');

/** This check's own path, as its reds name the register that lives here. */
export const SELF_PATH = 'scripts/check-clippy-invocation.js';

/**
 * The surfaces and the table selectors, re-exported rather than restated, so
 * the paths this check names in its output are the paths its neighbour names
 * and the row it reads is the row that neighbour reads.
 */
export { CI_DOC_PATH, TEST_WORKFLOW_PATH, GATES_SECTION, GATES_HEADER };

/** The gates-table row this check reads, by the name that table gives it. */
export const CLIPPY_GATE = 'Clippy';

/** The command a run line or a stated span opens with to be read as one. */
export const CLIPPY_COMMAND = 'cargo clippy';

/** A workflow expression, stripped before any command is compared. */
const EXPRESSION_RE = /\$\{\{[^}]*\}\}/g;

const BACKTICKED_SPAN_RE = /`([^`]+)`/g;

/**
 * The stated spans that are deliberately not the gate's own invocation, each
 * with the reason it states something else. The list is a negative one, so it
 * carries its own admission test: an entry whose span no document states any
 * more is red, because a register outliving its subject silently admits a
 * variant nobody reviewed.
 */
export const STATED_INVOCATION_EXCEPTIONS = [
  {
    doc: 'docs/guides/local-ci.md',
    span: 'cargo clippy -v',
    reason:
      "The debug-knob list's entry: the verbose form the workflow's own runner-debug expression adds, named beside the other tools' debug flags. It states what that knob turns on, never the invocation the gate runs.",
  },
];

/** Machinery breakage — a surface this check reads could not be used. */
export class InputError extends Error {}

/**
 * A command as this check compares it: workflow expressions removed, then every
 * whitespace run collapsed. Two spellings differing only in wrapping, or in an
 * expression the runner substitutes, are the same command.
 * @param {string} text
 * @returns {string}
 */
export function normalizeCommand(text) {
  return flattenWhitespace((text ?? '').replace(EXPRESSION_RE, ' '));
}

/**
 * The backticked spans of one line or cell, in order.
 * @param {string} text
 * @returns {string[]}
 */
export function backtickedSpans(text) {
  return [...(text ?? '').matchAll(BACKTICKED_SPAN_RE)].map((m) => m[1]);
}

/**
 * Every clippy step of a parsed workflow: the job carrying it, the command it
 * runs (normalized), and the directory it runs from — the step's own
 * `working-directory` where it states one, else the job's default.
 * @param {object} wf the parsed workflow
 * @returns {{ job: string, command: string, directory: string | null }[]}
 */
export function workflowClippySites(wf) {
  const sites = [];
  for (const [job, spec] of Object.entries(wf?.jobs ?? {})) {
    const jobDirectory = spec?.defaults?.run?.['working-directory'] ?? null;
    for (const step of spec?.steps ?? []) {
      const command = normalizeCommand(step?.run ?? '');
      if (!command.startsWith(CLIPPY_COMMAND)) continue;
      sites.push({ job, command, directory: step?.['working-directory'] ?? jobDirectory });
    }
  }
  return sites;
}

/**
 * The gates table's Clippy row: the jobs its Where cell names and the command
 * its local-command cell leads with, read through the doc-closure reader that
 * owns that table, plus every backticked span of that same cell — the directory
 * the row states sits among them.
 * @param {string} ciDocText
 * @returns {{ where: string[], command: string, spans: string[] }}
 */
export function clippyGateRow(ciDocText) {
  const row = extractGateRows(ciDocText).rows.find((r) => r.gate === CLIPPY_GATE);
  if (row === undefined)
    throw new InputError(
      `${CI_DOC_PATH} states no \`${CLIPPY_GATE}\` row in its lint-gates table — the row this ` +
        `check reads the stated invocation from`,
    );
  const spans = [];
  for (const table of parseTables(ciDocText)) {
    if (table.section !== GATES_SECTION || table.header[0] !== GATES_HEADER) continue;
    for (const cells of table.rows)
      if ((cells[0] ?? '').trim() === CLIPPY_GATE)
        spans.push(...backtickedSpans(cells[table.header.length - 1]));
  }
  return { where: row.where, command: normalizeCommand(row.command), spans };
}

/**
 * Every backticked span of the given documents that opens with the clippy
 * command, as {doc, span} pairs in document order.
 * @param {string[]} docs repo-relative paths
 * @param {(doc: string) => string} read
 * @returns {{ doc: string, span: string }[]}
 */
export function statedInvocations(docs, read) {
  const stated = [];
  for (const doc of docs)
    for (const line of stripFences(read(doc)).split('\n'))
      for (const span of backtickedSpans(line)) {
        const command = normalizeCommand(span);
        if (command.startsWith(CLIPPY_COMMAND)) stated.push({ doc, span: command });
      }
  return stated;
}

/**
 * The complete red set, given the surfaces already read.
 * @param {{ sites: { job: string, command: string, directory: string | null }[],
 *           row: { where: string[], command: string, spans: string[] },
 *           stated: { doc: string, span: string }[] }} input
 * @returns {string[]} one problem per finding, each naming the surface stating it
 */
export function evaluate({ sites, row, stated }) {
  const problems = [];

  const commands = [...new Set(sites.map((s) => s.command))];
  if (commands.length > 1)
    problems.push(
      `${TEST_WORKFLOW_PATH} runs more than one clippy command — ` +
        commands.map((c) => `\`${c}\``).join(' vs ') +
        ' — where the gate has one invocation every step spells',
    );
  const executed = commands.length === 1 ? commands[0] : undefined;

  const directories = [...new Set(sites.map((s) => s.directory))];
  if (directories.length > 1)
    problems.push(
      `${TEST_WORKFLOW_PATH} runs clippy from more than one directory — ` +
        directories.map((d) => `\`${d ?? '(the checkout root)'}\``).join(' vs '),
    );
  else if (
    directories.length === 1 &&
    directories[0] !== null &&
    !row.spans.includes(directories[0])
  )
    // prettier-ignore
    problems.push(
      `${TEST_WORKFLOW_PATH} runs clippy from \`${directories[0]}\`, which ${CI_DOC_PATH}'s ` +
        `\`${CLIPPY_GATE}\` row does not name — state that directory in the row's local-command cell`,
    );

  const documented = [...new Set(row.where)].sort();
  const running = [...new Set(sites.map((s) => s.job))].sort();
  for (const job of documented)
    if (!running.includes(job))
      problems.push(
        `${CI_DOC_PATH}'s \`${CLIPPY_GATE}\` row names \`${job}\`, which ${TEST_WORKFLOW_PATH} ` +
          `gives no \`${CLIPPY_COMMAND}\` step — name the jobs that run it, or restore the step`,
      );
  for (const job of running)
    if (!documented.includes(job))
      problems.push(
        `${TEST_WORKFLOW_PATH}'s \`${job}\` runs \`${CLIPPY_COMMAND}\`, which ${CI_DOC_PATH}'s ` +
          `\`${CLIPPY_GATE}\` row does not name — add it to that row's Where cell`,
      );

  const excepted = new Set();
  for (const { doc, span } of stated) {
    const exception = STATED_INVOCATION_EXCEPTIONS.find((e) => e.doc === doc && e.span === span);
    if (exception) {
      excepted.add(exception);
      continue;
    }
    if (executed !== undefined && span !== executed)
      problems.push(
        `${doc} states \`${span}\`, which is not the command ${TEST_WORKFLOW_PATH} runs ` +
          `(\`${executed}\`) — repeat the run lines' command, or record in ${SELF_PATH} why this ` +
          `span states something else`,
      );
  }
  for (const exception of STATED_INVOCATION_EXCEPTIONS)
    if (!excepted.has(exception))
      problems.push(
        `${SELF_PATH} records an exception for \`${exception.span}\` in ${exception.doc}, which ` +
          `states it no longer — remove the entry`,
      );

  return problems;
}

/**
 * Read every surface and evaluate. Separated from the wrapper so the suite
 * drives the same reads the command line does.
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function checkClippyInvocation({ root = ROOT } = {}) {
  const wf = yaml.load(readFileSync(join(root, TEST_WORKFLOW_PATH), 'utf8'));
  const sites = workflowClippySites(wf);
  if (sites.length === 0)
    throw new InputError(
      `${TEST_WORKFLOW_PATH} states no \`${CLIPPY_COMMAND}\` step — the run lines this check ` +
        `reads the executed invocation from`,
    );

  const row = clippyGateRow(readFileSync(join(root, CI_DOC_PATH), 'utf8'));

  const docs = trackedFilesUnder('*.md', { cwd: root });
  if (docs.length === 0)
    throw new InputError('the tracked markdown listing came back empty — nothing to scan');

  return evaluate({
    sites,
    row,
    stated: statedInvocations(docs, (doc) => readFileSync(join(root, doc), 'utf8')),
  });
}

/* c8 ignore start — the CLI wrapper reads the tracked tree and exits; the smoke
   suite runs it green over the committed tree, and the cases above drive every
   red path on synthetic input. */
function run() {
  let problems;
  try {
    problems = checkClippyInvocation();
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(`✗ ${SELF_PATH} could not read a surface it holds:\n\n  - ${error.message}`);
    process.exit(2);
  }
  if (problems.length) {
    console.error("✗ the Clippy gate's stated invocation and the tree disagree:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      `\n${problems.length} disagreement${problems.length === 1 ? '' : 's'}. ` +
        `${CI_DOC_PATH} §CI-1 states the rule; ${SELF_PATH} is the home of the complete red set.`,
    );
    process.exit(1);
  }
  console.log('✓ clippy invocation single-sourced: the stated command is the command CI runs.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
