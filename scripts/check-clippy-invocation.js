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
 *   2. the row — the ci.md gates table's Clippy row states that command as its
 *      own local command and that directory as the one it runs from, and the
 *      jobs it names are exactly the jobs carrying such a step, both ways;
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
 * exactly what this check picks up. Its readers are the ones this check reads
 * through: the row comes from that check's own `extractGateRows`, a step's
 * commands from its `commandSegments`, and a line's spans from the shared
 * `backtickedTokens` — so what counts as a row, a command, or a span is decided
 * in one place for both. It reads surfaces, never the tool: whether these are
 * the RIGHT flags is a review judgment, and whether the crate is clippy-clean is
 * the gate's own job in CI.
 *
 * Honest limits, in the order a drift would escape them, and in the forms
 * observed so far rather than as a closed set. The workflow read is the TEST
 * workflow alone, so a clippy step in a sibling workflow states nothing this
 * check sees. Inside that file the read is structural (js-yaml, then the
 * neighbour's shell-segment model), so a clippy invocation reaching the crate
 * some other way — from a composite action, a cargo alias, a script a step
 * calls — is equally invisible, and the row leg would report the job carrying
 * it as one the workflow gives no clippy step. Where the two sides cannot be
 * compared faithfully the comparison is refused rather than guessed: the
 * segment model blanks quoted contents and a documentation span is read as
 * written, so a clippy command carrying a quote on either side is named and
 * refused. That test is the clippy command's own — a quote survives blanking as
 * the character it is — so a quoted argument to some OTHER command sharing the
 * step is none of this check's business and refuses nothing. The stated-invocation
 * leg reads tracked markdown only, on the view its fenced blocks are stripped
 * from, and only a span that OPENS with the command: the same command inside a
 * longer span, spelled without backticks, written inside a fence, or stated in
 * a non-markdown file is outside it — the conservative direction for a scan
 * whose register would otherwise have to carry every prose mention of the tool,
 * and the reason the span reader runs a line at a time, where a span's two
 * backticks are on one line or are not a span. Flags are compared as written:
 * two spellings cargo treats alike but that differ as text — a reordered pair,
 * a long form against its short one — read as drift, which is a false red
 * rather than a false green, and the register records one if it ever happens.
 * One asymmetry sits outside every leg and is recorded here rather than papered
 * over: the jobs running these steps install their Rust toolchain separately
 * and only one of them requests the `clippy` component, the other's step
 * running green all the same. This check holds what the jobs RUN, never how the
 * tool came to be there, so a component list that changes underneath the run
 * lines stays review-held.
 *
 * Usage:
 *   node scripts/check-clippy-invocation.js  # or: npm run check:clippy-invocation
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  backtickedTokens,
  flattenWhitespace,
  stripFences,
  trackedFilesUnder,
} from './check-test-inventory.js';
import {
  CI_DOC_PATH,
  TEST_WORKFLOW_PATH,
  commandSegments,
  extractGateRows,
} from './check-doc-closure.js';

const ROOT = join(import.meta.dirname, '..');

/** This check's own path, as its reds name the register that lives here. */
export const SELF_PATH = 'scripts/check-clippy-invocation.js';

/**
 * The surfaces, re-exported rather than restated, so the paths this check names
 * in its output are the paths its neighbour names.
 */
export { CI_DOC_PATH, TEST_WORKFLOW_PATH };

/** The gates-table row this check reads, by the name that table gives it. */
export const CLIPPY_GATE = 'Clippy';

/** The command a run segment or a stated span opens with to be read as one. */
export const CLIPPY_COMMAND = 'cargo clippy';

/**
 * A workflow expression, stripped before any command is compared — and before
 * the command is split into segments, because an expression of the shipped
 * shape carries a `||` a shell split would otherwise cut it on. Lazy to the
 * first `}}`, so an expression carrying a `}` of its own still ends where it
 * ends.
 */
const EXPRESSION_RE = /\$\{\{[\s\S]*?\}\}/g;

/** How the row states the directory its command runs from. */
const STATED_DIRECTORY_RE = /\(from\s+`([^`]+)`\)/;

/**
 * A quote surviving expression-stripping. The workflow side reads a step through
 * the neighbour's shell-segment model, which blanks quoted CONTENTS by design;
 * a documentation span is read as written. Rather than compare two texts read
 * by different rules — where a quoted flag argument would make the truthful
 * statement red and a hollowed one green — a clippy command carrying a quote on
 * either side is refused by name.
 */
const QUOTE_RE = /['"]/;

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
 * Every clippy command a parsed workflow's steps run: the job carrying it, the
 * command itself (normalized), and the directory it runs from — the step's own
 * `working-directory` where it states one, else the job's default. A step's
 * `run:` is read through the neighbour's shell-segment model, so a clippy call
 * inside a multi-line block is a site exactly as a one-line `run:` is.
 * @param {object} wf the parsed workflow
 * @returns {{ job: string, command: string, directory: string | null }[]}
 */
export function workflowClippySites(wf) {
  const runDirectory = (spec) => spec?.defaults?.run?.['working-directory'] ?? null;
  const workflowDirectory = runDirectory(wf);
  const sites = [];
  for (const [job, spec] of Object.entries(wf?.jobs ?? {})) {
    const jobDirectory = runDirectory(spec) ?? workflowDirectory;
    for (const step of spec?.steps ?? []) {
      const directory = step?.['working-directory'] ?? jobDirectory;
      for (const segment of commandSegments((step?.run ?? '').replace(EXPRESSION_RE, ' '))) {
        const command = flattenWhitespace(segment);
        if (!command.startsWith(CLIPPY_COMMAND)) continue;
        if (QUOTE_RE.test(command))
          throw new InputError(
            `${TEST_WORKFLOW_PATH}'s \`${job}\` runs a clippy command carrying a quote ` +
              `(\`${command}\`, its quoted contents already blanked) — the workflow and ` +
              `documentation sides are read by different rules about quoting, so this check ` +
              `refuses the comparison rather than making one of the two spellings un-greenable`,
          );
        sites.push({ job, command, directory });
      }
    }
  }
  return sites;
}

/**
 * The gates table's Clippy row, read through the doc-closure reader that owns
 * that table: the jobs its Where cell names, the command its local-command cell
 * leads with, and the directory that cell states as the one the command runs
 * from — the `(from …)` form the row uses, read as that form rather than as any
 * span of the cell, so the field and the clause say the same thing.
 * @param {string} ciDocText
 * @returns {{ where: string[], command: string, directory: string | null }}
 */
export function clippyGateRow(ciDocText) {
  const row = extractGateRows(ciDocText).rows.find((r) => r.gate === CLIPPY_GATE);
  if (row === undefined)
    throw new InputError(
      `${CI_DOC_PATH} states no readable \`${CLIPPY_GATE}\` row in its lint-gates table — the row ` +
        `this check reads the stated invocation from`,
    );
  const stated = STATED_DIRECTORY_RE.exec(row.commandCell);
  return {
    where: row.where,
    command: normalizeCommand(row.command),
    directory: stated === null ? null : stated[1],
  };
}

/**
 * Every backticked span of the given documents that opens with the clippy
 * command, as {doc, span} pairs in document order.
 * @param {string[]} docs repo-relative paths
 * @param {(doc: string) => string} read
 * @returns {{ doc: string, span: string }[]}
 */
export function statedInvocations(docs, read) {
  const opensWithCommand = (token) => normalizeCommand(token).startsWith(CLIPPY_COMMAND);
  const stated = [];
  for (const doc of docs)
    for (const line of stripFences(read(doc)).split('\n'))
      for (const span of backtickedTokens(line, { shape: opensWithCommand })) {
        if (QUOTE_RE.test(span))
          throw new InputError(
            `${doc} states a clippy command carrying a quote (\`${span}\`) — the workflow and ` +
              `documentation sides are read by different rules about quoting, so this check ` +
              `refuses the comparison rather than making one of the two spellings un-greenable`,
          );
        stated.push({ doc, span: normalizeCommand(span) });
      }
  return stated;
}

/**
 * The complete red set, given the surfaces already read.
 * @param {{ sites: { job: string, command: string, directory: string | null }[],
 *           row: { where: string[], command: string, directory: string | null },
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

  if (executed !== undefined && row.command !== executed)
    problems.push(
      `${CI_DOC_PATH}'s \`${CLIPPY_GATE}\` row leads with \`${row.command}\`, which is not the ` +
        `command ${TEST_WORKFLOW_PATH} runs (\`${executed}\`) — that row's local command is the ` +
        `invocation's one home, so it states the command the steps run`,
    );

  const directories = [...new Set(sites.map((s) => s.directory))];
  if (directories.length > 1)
    problems.push(
      `${TEST_WORKFLOW_PATH} runs clippy from more than one directory — ` +
        directories.map((d) => `\`${d ?? '(the checkout root)'}\``).join(' vs '),
    );
  else if (directories.length === 1 && directories[0] !== row.directory)
    problems.push(
      `${TEST_WORKFLOW_PATH} runs clippy from ` +
        `${directories[0] === null ? 'the checkout root' : `\`${directories[0]}\``}, while ` +
        `${CI_DOC_PATH}'s \`${CLIPPY_GATE}\` row states ` +
        `${row.directory === null ? 'none' : `\`${row.directory}\``} — the row states the ` +
        `directory its command runs from, in the \`(from …)\` form`,
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
 * The tree as this check reads it: the readers bound to a checkout. Separated
 * from {@link checkClippyInvocation} so the suite drives the same reads the
 * command line does, refusals included, without building a temporary tree.
 * @param {string} [root]
 * @returns {{ readFile: (path: string) => string, listMarkdown: () => string[] }}
 */
export function treeSurfaces(root = ROOT) {
  return {
    readFile: (path) => readFileSync(join(root, path), 'utf8'),
    listMarkdown: () => trackedFilesUnder('*.md', { cwd: root }),
  };
}

/**
 * Read every surface and evaluate.
 * @param {{ readFile?: (path: string) => string, listMarkdown?: () => string[] }} [surfaces]
 * @returns {string[]}
 */
export function checkClippyInvocation({ readFile, listMarkdown } = treeSurfaces()) {
  /** Every read and parse this check makes, so a broken surface is machinery
   *  breakage on its own exit code rather than a stack trace on the exit code a
   *  real disagreement uses. */
  const surface = (what, take) => {
    try {
      return take();
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError(`${what} could not be read: ${error.message}`);
    }
  };

  const wf = surface(TEST_WORKFLOW_PATH, () => yaml.load(readFile(TEST_WORKFLOW_PATH)));
  const sites = workflowClippySites(wf);
  if (sites.length === 0)
    throw new InputError(
      `${TEST_WORKFLOW_PATH} states no \`${CLIPPY_COMMAND}\` step — the run lines this check ` +
        `reads the executed invocation from`,
    );

  const row = clippyGateRow(surface(CI_DOC_PATH, () => readFile(CI_DOC_PATH)));

  const docs = surface('the tracked markdown listing', () => listMarkdown());
  if (!docs.includes(CI_DOC_PATH))
    throw new InputError(
      `the tracked markdown listing does not carry ${CI_DOC_PATH} (${docs.length} file(s)) — a ` +
        `listing that has stopped naming the guide it must scan would pass this leg holding ` +
        `nothing`,
    );

  return evaluate({
    sites,
    row,
    stated: statedInvocations(docs, (doc) => surface(doc, () => readFile(doc))),
  });
}

/* c8 ignore start — the CLI wrapper prints and exits; the smoke suite runs it
   green over the committed tree, and the cases above drive every red and every
   refusal on synthetic input. */
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
