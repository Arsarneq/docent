/**
 * check-ci-filter.js — Admission test for the test.yml path-filter contract.
 *
 * The `changes` job (dorny/paths-filter) decides which test jobs run for a
 * given diff. The filter is split so a change fires only the jobs that can
 * actually observe it:
 *
 *   - ciCore       — inputs every job's build/run depends on (this workflow,
 *                    the composite actions, the root npm manifests).
 *   - buildScripts — the scripts a NON-unit test job actually executes, plus
 *                    their scripts/-local import/spawn closure. This is the
 *                    only script set the heavy Windows/Playwright/corpus jobs
 *                    need; everything else under scripts/ reaches only the
 *                    always-on lint job or unit-tests (via check-*.test.js).
 *   - ci           — the broad scripts/** + .c8rc.json, gating unit-tests only.
 *
 * This guard fails CI when that contract rots. It is deliberately conservative:
 * it OVER-includes on any ambiguity (a `.js` literal that resolves under
 * scripts/ is treated as reached), so drift surfaces as a loud red, never a
 * silent under-trigger. The invariants it enforces:
 *
 *   1. buildScripts set-equality — the committed buildScripts globs equal the
 *      transitive scripts/-local closure of the scripts the heavy jobs run.
 *   2. No heavy job gates on the broad `ci` bucket (scripts/**), and ciCore
 *      carries exactly test.yml, the composite actions, and the root npm
 *      manifests.
 *   3. Each job gates on the flags it must because it exercises an input the
 *      buildScripts closure can't model: `schema` on desktop-rust-tests and
 *      desktop-corpus-diff (they validate the desktop corpus against the schema
 *      composed from schemas/**), `buildScripts` on reference-server-tests (its
 *      suites import scripts/build-schemas.js, reached through the
 *      sub-package `npm test` the job runs in its `working-directory`, a form
 *      the command model below reads as no invocation), `referenceServer` on
 *      unit-tests (its shared suite walks reference-implementations/ for the
 *      resolution-procedure tokens no shipped file may carry), and the held
 *      flags on the jobs whose suites hold their entries: `releasePipeline` on
 *      reference-server-tests and unit-tests, and, on unit-tests alone, the
 *      narrow flags `contractDocs`, `dispositionWorkflow` and `suiteHeld`.
 *      What holds each entry of those flags, in which job, is stated in
 *      `HELD_FLAG_HOLDINGS` and `SUITE_HELD_HOLDINGS` below, the home of the
 *      holdings.
 *   4. `.github/actions/**` is in ciCore (composite actions are used by nearly
 *      every job). Invariant 2 holds the ciCore filter to the `ciCoreGlobs`
 *      input, whose default is the `CI_CORE_GLOBS` constant, so what this leg
 *      adds is a pin on that list's membership: with `ciCoreGlobs` at its
 *      default, every red of this invariant is also a red of invariant 2, and
 *      this leg reds alone when the list and the filter drop the glob
 *      together.
 *   5. Each needs-chained produce/diff pair co-fires — identical trigger flags —
 *      so a diff job never fires without the producer whose artifact it
 *      downloads, nor the producer without the diff that consumes it.
 *   6. Every flag any job's `if:` gates on is one the `changes` job's
 *      paths-filter step defines.
 *      A gate on an undefined filter reads as a well-formed condition and is
 *      always false, so the job silently never fires for that input — the
 *      workflow-internal half of flag definedness, held here because this is
 *      where the parsed workflow and the filter map meet. (The other half —
 *      the flags docs/guides/ci.md states per job — is held by
 *      scripts/check-doc-closure.js, against the same filter map.)
 *   7. The hops a flag passes through inside the `changes` job: the
 *      paths-filter step's filter map and that job's `outputs:` block name the
 *      same set both ways, each output binds exactly `${{ steps.<the filter
 *      step's id>.outputs.<its own name> }}`, and every filter is gated on by
 *      some job's `if:`. Gates are read at job level, from the
 *      `needs.changes.outputs.<flag>` tokens of each job's own `if:`, so a
 *      step-level gate, or one reached through an intermediate expression, is
 *      not read. Its legs run once the paths-filter step is located, so a
 *      workflow without the `changes` job, the step, or its id gets one problem
 *      from this invariant — with the other invariants red beside it, the
 *      filter map being read from that same job. What this invariant alone
 *      holds: an output bound to another filter's result, a well-formed
 *      condition that follows the other filter's paths, so the job stops firing
 *      for the files the flag exists to watch and may fire for files it should
 *      not; and a filter no job gates on, inert with or without an output — a
 *      flag nothing reads. A flag a job gates on that the `outputs:` block does
 *      not declare is either no filter or a filter with no output, so it reds
 *      through invariant 6 and this one together, and again as a type error in
 *      the always-on actionlint job.
 *   8. Every glob-free filter entry names a file git tracks. A literal entry is
 *      one rename away from matching nothing, silently — and an existing
 *      directory, a trailing-slash path, or an untracked file present on disk
 *      matches nothing in the paths filter either, so only a tracked file
 *      passes.
 *   9. Every document the clause registry's prefix map names is a `suiteHeld`
 *      entry. The preamble suite holds each carrier's registry link as raw
 *      text, so a carrier the flag omits reds unit-tests on `main` alone.
 *  10. Each held flag — `releasePipeline`, `contractDocs` and
 *      `dispositionWorkflow` with their `HELD_FLAG_HOLDINGS` maps, and
 *      `suiteHeld` with `SUITE_HELD_HOLDINGS` — names the same set as its
 *      holdings map, both ways: a file joins the flag only with the holding
 *      that earns it stated beside it, and a holding that ends takes its entry
 *      with it; a holdings map for a flag the filter does not define reds as
 *      well. The maps are hand-stated: a suite that begins reading a new file
 *      is a holding a reviewer adds to the map with its entry, since this check
 *      reads the maps and the filter, never the suites' reads.
 *  11. No filter lists the same entry more than once. A repeat matches
 *      nothing the single entry does not, and no leg above reports it as a
 *      repeat — the set comparisons collapse it, and the per-entry legs
 *      answer the same for each copy — so the repeat itself survives them all
 *      while the map states one entry more than once.
 *  12. Every heavy job whose own closure — the scripts/-local closure of the
 *      scripts that job alone runs, read by the command model below — is
 *      non-empty gates on `buildScripts`. The rule is one-directional: a
 *      non-empty closure demands the gate, and an empty one licenses nothing,
 *      because a script a job reaches through a form the command model does
 *      not read is outside that closure; such a job takes its gate in
 *      `REQUIRED_JOB_FLAGS` (invariant 3), as reference-server-tests does.
 *
 * The command model — how a `run:` string, and each package.json script an
 * `npm run` reaches, is read into entry files. The command is split into
 * segments at `&&`, `||`, `|&`, `;`, newline, `|` and `&` (the two-character
 * forms before the one-character ones). A segment whose first non-blank
 * character is `#` is a comment and reads as nothing; a `#` anywhere else is
 * ordinary text. Within a segment, tokens are split at whitespace, `<` and
 * `>`; each token loses a leading `(` or `$(` and a trailing `)`, and its
 * leading and trailing quote characters (`'` and `"`), paired or lone. The
 * invocation is the first token equal to `node`, or the first `npm` whose next
 * token after its own `-`-prefixed flags is `run` or `run-script`, the key
 * being the next token after that one's flags; whatever precedes the
 * invocation — an environment assignment, `env`, `time`, `xvfb-run` and its
 * options, a wrapper of any name, an opening quote — is passed over. After
 * `node`, a flag that carries a script value (`--import`, `--require`, `-r`,
 * `--loader`, spaced or `=`-joined) contributes that value as an entry, every
 * other flag is skipped, and the first remaining token naming a `.js`, `.cjs`
 * or `.mjs` file is the entry. An `npm run` key resolves through
 * package.json's scripts and its command is read by the same model, each key
 * once per command.
 *
 * The forms it reads are the ones above. Text inside quotes is read like the
 * rest, so a `node` word inside quoted prose, or a command string handed to
 * `sh -c`, counts as an invocation — the over-include this check accepts,
 * failing closed: the job's closure grows and invariant 12 demands its gate. An
 * invocation that carries no `node` or `npm run` token of its own is not
 * reached: a script file run through `sh` or `bash`, a shell function, an
 * alias, a heredoc, and `npx`, `cargo` or a sub-package `npm test` on their
 * own; a `node` token that follows `npx` or `cargo` is read like any other, the
 * wrapper passed over; and the spaced `npm --prefix <dir> run k` reads `<dir>`
 * as the verb, so it is not reached either. Some forms are misread rather than
 * missed: a sub-package `npm run` reached through `cd <dir> &&`,
 * `working-directory:` or the `=`-joined `npm --prefix=<dir> run k` is read
 * against the root manifest — an over-include when the key exists there,
 * nothing when it does not; and `node -e "import('./scripts/x.js')"` yields a
 * token naming no file, which the closure drops. A job that depends on a script
 * through any of these takes its flag in `REQUIRED_JOB_FLAGS`.
 *
 * The family's related reader is `commandSegments` in
 * scripts/check-doc-closure.js. Where this model differs from it: it splits at
 * `|&` and `&` as well, keeps quoted text, reads a comment only at a
 * segment's start, finds the invocation anywhere in the segment, strips `$(`
 * and a trailing `)`, and ends a token at `<` and `>`. check-doc-closure.js
 * imports this file, so the model is written here rather than imported from
 * there.
 *
 * Usage: node scripts/check-ci-filter.js   # or: npm run lint:ci-filter
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
// The two tracked-file readers live in check-test-inventory.js, whose own
// imports load the markdown parser it reads tables with (unified,
// remark-parse, unist-util-visit), so this command line inherits that parser.
import { selfPath, trackedFilesUnder } from './check-test-inventory.js';

const SELF_PATH = selfPath(import.meta.filename);

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'test.yml');
const CLAUSE_REGISTRY = join(ROOT, 'docs', 'clause-registry.json');

// The design contract, encoded once. These job ids ARE the point of the guard;
// a rename that leaves one dangling is itself a failure (checked below).
const UNIT_JOB = 'unit-tests';
// The flags this file reasons about by name at more than one site, encoded once.
const BUILD_SCRIPTS_FLAG = 'buildScripts';
const CI_CORE_FLAG = 'ciCore';
const SUITE_HELD_FLAG = 'suiteHeld';
// The workflow's own filter anchor, named once: the job that runs the filter,
// and the `uses:` substring its step is located by. Exported because the doc
// closure check reaches the same step to read the same map.
const CHANGES_JOB_ID = 'changes';
const PATHS_FILTER_USES = 'paths-filter';
const CI_CORE_GLOBS = [
  '.github/workflows/test.yml',
  '.github/actions/**',
  'package.json',
  'package-lock.json',
];
// Flags a job MUST gate on because it exercises inputs the buildScripts closure
// cannot model — a `schema` validation, or a source-read coupling. Pins the
// under-trigger fixes so a future edit can't silently drop them.
//   desktop-rust-tests / desktop-corpus-diff — validate the desktop corpus
//     against the schema composed from schemas/**.
//   reference-server-tests — `releasePipeline`, for the entries its suites
//     hold (HELD_FLAG_HOLDINGS states each holding); and `buildScripts`: its
//     suites import scripts/build-schemas.js through the `working-directory`
//     `npm test` the command model reads as no invocation, so its own closure
//     is empty while the job reads a build script (held here because
//     invariant 12 licenses nothing from an empty closure).
//   unit-tests — `releasePipeline`, `contractDocs`, `dispositionWorkflow` and
//     `suiteHeld`, for the entries its suites and steps hold
//     (HELD_FLAG_HOLDINGS and SUITE_HELD_HOLDINGS state each holding); the
//     last three gate this job alone, so an edit to those files reaches the
//     suite that holds them and no heavy job beyond it. And `referenceServer`:
//     its shared suite walks reference-implementations/ for the
//     resolution-procedure tokens no shipped file may carry — a holding the
//     heavy jobs that flag reaches do not carry, so an edit there must run
//     this job too.
const REQUIRED_JOB_FLAGS = {
  'desktop-rust-tests': ['schema'],
  'desktop-corpus-diff': ['schema'],
  'reference-server-tests': ['releasePipeline', BUILD_SCRIPTS_FLAG],
  'unit-tests': [
    'releasePipeline',
    'referenceServer',
    'contractDocs',
    'dispositionWorkflow',
    SUITE_HELD_FLAG,
  ],
};
// What holds each `suiteHeld` entry: the suite or step that asserts over its
// content, stated once, beside the entry it earns. Invariant 10 holds this map
// and the filter to the same set both ways. The clause registry's carriers are
// held as a class by the preamble suite's raw registry link, and several carry
// further holdings; the registry itself is where the carrier set lives
// (invariant 9 holds the filter to it).
const SUITE_HELD_HOLDINGS = {
  '.github/PUBLISHING.md': "the release-output suite's automation-branch tokens",
  '.github/workflows/docs-disposition-audit.yml':
    "the disposition suite's schedule welds — the cron field, its comment, and the guide's row and section",
  '.github/workflows/mutation.yml':
    "the disposition suite's schedule welds and the workflow-bounds suite's cargo-mutants version pin",
  '.github/workflows/pin-history.yml':
    "the disposition suite's schedule welds — the cron field, its comment, and the guide's row and section",
  '.github/workflows/scorecard.yml':
    "the disposition suite's schedule welds — the cron field, its comment, and the guide's row and section",
  'README.md': "the version-sync step's table",
  'docs/api/dispatch.md': "the preamble suite's registry link and its clause-text anchors",
  'docs/api/sync-protocol.md': "the preamble suite's registry link",
  'docs/architecture/application/desktop/windows/application-shell.md':
    "the preamble suite's registry link, and the command-surface suite's sentence anchor and single-problem pin and its item-removal pins — exactly one enumeration item opening on each grant they remove, `core:default` named again elsewhere in the section, and `dialog:allow-save` named nowhere else, held by the exact problem lists those cases assert",
  'docs/architecture/application/desktop/windows/capture-principles.md':
    "the preamble suite's registry link",
  'docs/architecture/application/extension/capture-principles.md':
    "the preamble suite's registry link",
  'docs/architecture/application/extension/permissions.md': "the preamble suite's registry link",
  'docs/architecture/application/extension/runtime.md': "the preamble suite's registry link",
  'docs/architecture/system/capture-principles.md': "the preamble suite's registry link",
  'docs/architecture/system/shared-core.md':
    "the preamble suite's registry link, and the adapter-surface suite's seam-link enumeration and heading coupling",
  'docs/clause-registry.json':
    "the disposition suite's example-anchor row and the schema-echo suite's check-ref literal",
  'docs/guides/ci.md':
    "the preamble suite's registry link, the disposition suite's cadence welds, the workflow-bounds suite's cargo-mutants version cell, and the path-filter suite's holdings-citation and flag-exception anchors",
  'docs/guides/local-ci.md':
    "the disposition suite's cadence cross-reference and heading, and the release-output suite's automation-branch tokens",
  'docs/technical/locator-resolution.md': "the preamble suite's registry link",
  'docs/technical/session-format.md':
    "the preamble suite's registry link and the version-sync step's table",
  'docs/test/README.md': "the disposition suite's bullet literal",
  'docs/test/e2e.md': "the test-inventory suite's inventory tables",
  'docs/test/integration/desktop.md':
    "the integration-suite locks' shared-helpers section and configuration sentence",
  'docs/test/strategy/coverage.md': "the preamble suite's registry link",
  'docs/test/strategy/mutation.md':
    "the preamble suite's registry link and the disposition suite's cadence clause",
  'docs/verification/scripted-truth-corpus.md':
    "the preamble suite's registry link and the inventory suite's literal anchors",
  'docs/verification/sufficiency-lint.md':
    "the preamble suite's registry link and the inventory suite's literal anchors",
};
// The flags whose entries a holder suite earns — `releasePipeline`,
// `contractDocs` and `dispositionWorkflow` — with what holds each entry: per
// flag, each entry and the job and suite whose assertions over its content earn
// it, stated once beside the entry. Invariant 10 holds each flag's map and its
// filter to the same set both ways, as it does `SUITE_HELD_HOLDINGS`. Each
// suite that holds an entry of `HELD_FLAG_HOLDINGS` names this map in its
// header, and `SUITE_HELD_HOLDINGS` too where it also holds one of those, as
// where the flags subscribing its job to the files it reads are stated, and
// lists no flag itself; this map is the home of the holdings.
// Hand-stated, like `SUITE_HELD_HOLDINGS`: a suite that begins reading a new
// file earns an entry here when the entry joins the filter.
const HELD_FLAG_HOLDINGS = {
  releasePipeline: {
    '.github/workflows/publish.yml':
      "reference-server-tests: the release-exclusion suite's packaging-scope assertions; unit-tests: the disposition suite's automation-branch and generated-body welds",
    '.github/workflows/publish-desktop.yml':
      "reference-server-tests: the release-exclusion suite's packaging-scope assertions; unit-tests: the disposition suite's automation-branch and generated-body welds",
    'scripts/check-no-release-outputs.js':
      "reference-server-tests: the release-exclusion suite's forbidden-path and seed-sample assertions (unit-tests reaches this file through the broad `ci` bucket)",
  },
  contractDocs: {
    '.github/CONTRIBUTING.md':
      "unit-tests: the disposition suite's welds — the fenced governance line, the per-doc grammar forms, the standing mutation sentence, and the exemption paragraph's fields and its citation of the release-output surface's home",
    '.github/PULL_REQUEST_TEMPLATE.md':
      "unit-tests: the disposition suite's welds — the scaffolded governance line, the per-doc grammar forms, the standing mutation sentence, and the shipped template's inert guidance comments",
  },
  dispositionWorkflow: {
    '.github/workflows/docs-disposition.yml':
      "unit-tests: the release-output suite's guard-step env block, held to the event fields the head-ref derivation is written against",
  },
};
// Every held flag with its holdings map and the map's name as a red line
// states it — the set invariant 10 walks.
const HELD_FLAG_MAPS = [
  ...Object.entries(HELD_FLAG_HOLDINGS).map(([flag, map]) => ({
    flag,
    map,
    name: `HELD_FLAG_HOLDINGS.${flag}`,
  })),
  { flag: SUITE_HELD_FLAG, map: SUITE_HELD_HOLDINGS, name: 'SUITE_HELD_HOLDINGS' },
];
// A filter entry carrying none of dorny's glob alphabet is read as a literal
// path and held to the tree by invariant 8; an entry carrying any of these
// characters is passed over by that leg. So an extglob opener the alphabet
// does not carry (`@(`, `+(`) is read as a literal and reds as a file git does
// not track, while a tracked file whose own name carried one of these
// characters would go unheld.
const GLOB_CHARS = /[*?[\]{}!]/;
const PRODUCE_DIFF_PAIRS = [
  ['desktop-rust-tests', 'desktop-corpus-diff'],
  ['desktop-vectors-produce', 'desktop-vectors-diff'],
];
/**
 * The `needs.<filter job>.outputs.<flag>` reference every gate is written as.
 * Global for `matchAll`, which clones the regex, so this module-scope
 * `lastIndex` never advances — a reader switching to `.test()` or `.exec()`
 * would inherit that state.
 */
const JOB_FLAG_RE = new RegExp(String.raw`needs\.${CHANGES_JOB_ID}\.outputs\.(\w+)`, 'g');

/**
 * A job's steps as a list: the steps it states, or the empty list when the job
 * is absent or states `steps` as anything but a list. Its readers: this file's
 * own legs — the filter-step locator and the build-closure walk — and
 * [`check-doc-closure.js`](./check-doc-closure.js), which imports it for its
 * step reads. Those readers take an absent or malformed block the same way, as
 * no steps.
 * @param {object | undefined} job the parsed job
 * @returns {object[]} the job's steps
 */
function jobSteps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

/**
 * The filter job's paths-filter step, or undefined when the job is absent, runs
 * no steps, or runs no step whose `uses:` names the filter action. One locator,
 * so every reader of the filter map reaches the same step.
 * @param {object | undefined} job the parsed job
 * @returns {object | undefined} the filter step
 */
function pathsFilterStep(job) {
  return jobSteps(job).find(
    (s) => typeof s?.uses === 'string' && s.uses.includes(PATHS_FILTER_USES),
  );
}

/**
 * Normalise an absolute path to a root-relative, forward-slash path.
 * @param {string} abs an absolute path under `root`
 * @param {string} [root] the tree the path is relative to (default: this repository)
 * @returns {string} the relative path
 */
function rel(abs, root = ROOT) {
  return abs.slice(root.length + 1).replace(/\\/g, '/');
}

/** Parse test.yml and the nested dorny filter block into structured data. */
function loadWorkflow() {
  const wf = yaml.load(readFileSync(WORKFLOW, 'utf8'));
  const filterStep = pathsFilterStep(wf.jobs?.[CHANGES_JOB_ID]);
  // The filter definitions are a YAML literal block inside `with.filters`.
  const filters = filterStep?.with?.filters ? yaml.load(filterStep.with.filters) : {};
  // Normalise each filter's globs to a string[] (dorny allows a bare string).
  for (const k of Object.keys(filters)) {
    filters[k] = Array.isArray(filters[k]) ? filters[k].map(String) : [String(filters[k])];
  }
  return { wf, filters };
}

/** The change-flags a job's `if:` gates on, read through {@link JOB_FLAG_RE}. */
function jobFlags(job) {
  const cond = typeof job?.if === 'string' ? job.if : '';
  return new Set([...cond.matchAll(JOB_FLAG_RE)].map((m) => m[1]));
}

/**
 * Heavy jobs: every path-filtered test job (its `if:` reads a changes flag)
 * except unit-tests, which legitimately keeps the broad scripts/** gate.
 */
function heavyJobs(wf) {
  const out = {};
  for (const [id, job] of Object.entries(wf.jobs || {})) {
    if (id === UNIT_JOB) continue;
    if (jobFlags(job).size > 0) out[id] = job;
  }
  return out;
}

/** The command model's segment separators, the two-character forms first. */
const SEGMENT_SEPARATORS = /&&|\|\||\|&|;|\n|\||&/;
/** The `node` flags whose value is a script the process loads. */
const NODE_SCRIPT_VALUE_FLAGS = new Set(['--import', '--require', '-r', '--loader']);
/** A token naming a script file. */
const SCRIPT_FILE_RE = /\.[cm]?js$/;

/**
 * One segment's tokens under the command model (this file's header): split at
 * whitespace, `<` and `>`, each token stripped of a leading `(` or `$(`, a
 * trailing `)`, and its leading and trailing quote characters.
 * @param {string} segment one command segment
 * @returns {string[]} the non-empty tokens
 */
function commandTokens(segment) {
  return segment
    .split(/[\s<>]+/)
    .map((token) => token.replace(/^(?:\$?\(|['"])+/, '').replace(/(?:\)|['"])+$/, ''))
    .filter(Boolean);
}

/**
 * The index of the first token after `from` that is not a `-`-prefixed flag.
 * @param {string[]} tokens the segment's tokens
 * @param {number} from the index to start at
 * @returns {number} that index, or `tokens.length` when every token is a flag
 */
function skipFlags(tokens, from) {
  let i = from;
  while (i < tokens.length && tokens[i].startsWith('-')) i++;
  return i;
}

/**
 * A segment's invocation under the command model: the first `node` token, or
 * the first `npm` followed (past its flags) by `run` or `run-script` and a key.
 * @param {string[]} tokens the segment's tokens
 * @returns {{ node: string[] } | { key: string } | null} the arguments after
 *   `node`, the `npm run` key, or null when the segment invokes neither
 */
function invocationIn(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'node') return { node: tokens.slice(i + 1) };
    if (tokens[i] !== 'npm') continue;
    const verb = skipFlags(tokens, i + 1);
    if (tokens[verb] !== 'run' && tokens[verb] !== 'run-script') continue;
    const key = skipFlags(tokens, verb + 1);
    if (key < tokens.length) return { key: tokens[key] };
  }
  return null;
}

/**
 * The script paths a `node` invocation loads: each script value a loading flag
 * carries, and the first non-flag token naming a script file.
 * @param {string[]} args the tokens after `node`
 * @returns {string[]} the paths, as written
 */
function nodeEntries(args) {
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      const flag = eq === -1 ? token : token.slice(0, eq);
      if (NODE_SCRIPT_VALUE_FLAGS.has(flag)) {
        const value = eq === -1 ? args[++i] : token.slice(eq + 1);
        if (value !== undefined && SCRIPT_FILE_RE.test(value)) paths.push(value);
      }
      continue;
    }
    if (SCRIPT_FILE_RE.test(token)) {
      paths.push(token);
      break;
    }
  }
  return paths;
}

/**
 * Resolve a command string to the script ENTRY files it executes directly,
 * read by the command model this file's header states: `node` invocations
 * contribute their script paths, and `npm run <k>` resolves through
 * package.json's scripts and is read again, each key once per command.
 * @param {string} cmd a `run:` string or a package.json script
 * @param {Record<string, string>} scripts package.json's scripts
 * @param {Set<string>} [seenKeys] the `npm run` keys already read
 * @param {string} [root] the tree paths resolve against (default: this repository)
 * @returns {Set<string>} the absolute entry paths
 */
function entryFilesFromCommand(cmd, scripts, seenKeys = new Set(), root = ROOT) {
  const entries = new Set();
  for (const segment of cmd.split(SEGMENT_SEPARATORS)) {
    if (segment.trimStart().startsWith('#')) continue;
    const call = invocationIn(commandTokens(segment));
    if (call === null) continue;
    if ('node' in call) {
      for (const path of nodeEntries(call.node)) entries.add(join(root, path));
      continue;
    }
    if (seenKeys.has(call.key)) continue;
    seenKeys.add(call.key);
    const script = Object.hasOwn(scripts, call.key) ? scripts[call.key] : undefined;
    if (typeof script === 'string')
      for (const e of entryFilesFromCommand(script, scripts, seenKeys, root)) entries.add(e);
  }
  return entries;
}

/**
 * Transitive scripts/-local closure of a set of entry files. Every `*.js`
 * string literal in a reachable file is resolved against both the file's own
 * directory and `<root>/scripts` (covering static imports, `await import()`,
 * and the `execFileSync(process.execPath, [join(ROOT, 'scripts', '<x>.js')])`
 * spawn form); those that exist under scripts/ join the closure and are
 * themselves expanded. The scripts/-relative reading over-includes — a literal
 * written relative to another directory that happens to name a script under
 * scripts/ joins too — which is the conservatism this file's header states.
 * @param {Iterable<string>} entryFiles absolute entry paths
 * @param {string} [root] the tree whose scripts/ directory bounds the closure
 * @returns {Set<string>} the absolute closure paths
 */
function scriptsClosure(entryFiles, root = ROOT) {
  const scriptsDir = join(root, 'scripts');
  const closure = new Set();
  const queue = [...entryFiles];
  const scanned = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (scanned.has(file) || !existsSync(file)) continue;
    scanned.add(file);
    // A scanned file that lives under scripts/ IS part of the closure — this
    // covers both the entry scripts a job runs directly and the scripts they
    // reach. (Entry test files outside scripts/ are scanned for scripts/ refs
    // but are not themselves closure members.)
    if (file.startsWith(scriptsDir + sep)) closure.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/['"]([^'"]*?\.[cm]?js)['"]/g)) {
      const literal = m[1];
      for (const cand of [resolve(dirname(file), literal), join(scriptsDir, literal)]) {
        if (cand.startsWith(scriptsDir + sep) && existsSync(cand) && !scanned.has(cand)) {
          queue.push(cand);
        }
      }
    }
  }
  return closure;
}

/**
 * The buildScripts closure (root-relative paths) the heavy jobs actually
 * reach, computed from the workflow + package.json script wrappers: each heavy
 * job's own closure, and their union. Kept separate from evaluateContract so
 * the pure contract check can be unit-tested against synthetic closures without
 * touching disk.
 * @param {object} wf the parsed workflow
 * @param {Record<string, string>} scripts package.json's scripts
 * @param {string} [root] the tree commands resolve against (default: this repository)
 * @returns {{ closure: Set<string>, jobClosures: Record<string, Set<string>> }}
 *   the union, and each heavy job's own closure by job id
 */
function computeBuildClosure(wf, scripts, root = ROOT) {
  const closure = new Set();
  const jobClosures = {};
  for (const [id, job] of Object.entries(heavyJobs(wf))) {
    const entries = new Set();
    for (const step of jobSteps(job)) {
      if (typeof step.run === 'string')
        for (const e of entryFilesFromCommand(step.run, scripts, new Set(), root)) entries.add(e);
    }
    jobClosures[id] = new Set([...scriptsClosure(entries, root)].map((abs) => rel(abs, root)));
    for (const script of jobClosures[id]) closure.add(script);
  }
  return { closure, jobClosures };
}

/**
 * Pure contract check: given the parsed workflow, its filter map, the computed
 * buildScripts `closure` (a Set of repo-relative script paths) and
 * `jobClosures` (each heavy job's own closure, by job id — both as
 * {@link computeBuildClosure} returns them), an `isTracked` predicate that
 * answers true only for a path git tracks as a file, `registryDocs` (the
 * documents the clause registry's prefix map names), and `ciCoreGlobs` (the
 * list invariant 2 holds the ciCore filter to, `CI_CORE_GLOBS` by default),
 * return the list of violations — empty means the contract holds. The inputs
 * that stand for state outside the workflow — the per-job closures, the
 * tracked-file predicate and the registry's document list — are required
 * rather than defaulted, so a caller that forgets one throws instead of
 * skipping the invariant it feeds, and `jobClosures` carries an entry for every
 * heavy job — a heavy job it omits throws, naming the job. No IO of its own, so
 * the unit test drives every invariant with synthetic inputs.
 */
function evaluateContract({
  wf,
  filters,
  closure,
  jobClosures,
  isTracked,
  registryDocs,
  ciCoreGlobs = CI_CORE_GLOBS,
}) {
  if (jobClosures === null || typeof jobClosures !== 'object')
    throw new TypeError('evaluateContract: jobClosures is required');
  if (typeof isTracked !== 'function')
    throw new TypeError('evaluateContract: isTracked is required');
  if (!Array.isArray(registryDocs))
    throw new TypeError('evaluateContract: registryDocs is required');
  const problems = [];
  const jobs = wf.jobs || {};
  const heavy = heavyJobs(wf);
  for (const id of Object.keys(heavy)) {
    if (!Object.hasOwn(jobClosures, id))
      throw new TypeError(`evaluateContract: jobClosures carries no entry for heavy job \`${id}\``);
  }

  const has = (flag) => Object.prototype.hasOwnProperty.call(filters, flag);
  const globs = (flag) => (has(flag) ? filters[flag] : []);
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  // Invariant 1: buildScripts set-equality with the heavy jobs' script closure.
  if (!has(BUILD_SCRIPTS_FLAG)) {
    problems.push(`the \`${CHANGES_JOB_ID}\` job defines no \`${BUILD_SCRIPTS_FLAG}\` filter`);
  } else {
    const declared = new Set(globs(BUILD_SCRIPTS_FLAG));
    if (!sameSet(closure, declared)) {
      const missing = [...closure].filter((s) => !declared.has(s)).sort();
      const extra = [...declared].filter((s) => !closure.has(s)).sort();
      if (missing.length)
        problems.push(
          `${BUILD_SCRIPTS_FLAG} is MISSING scripts the heavy jobs run: ${missing.join(', ')}`,
        );
      if (extra.length)
        problems.push(
          `${BUILD_SCRIPTS_FLAG} lists scripts no heavy job reaches: ${extra.join(', ')}`,
        );
    }
  }

  // Invariant 2: no heavy job gates on broad `ci`; ciCore is exactly the
  // environment-wide globs `ciCoreGlobs` states.
  for (const [id, job] of Object.entries(heavy)) {
    if (jobFlags(job).has('ci'))
      problems.push(`heavy job \`${id}\` gates on the broad \`ci\` flag (scripts/**)`);
  }
  if (!has(CI_CORE_FLAG)) {
    problems.push(`the \`${CHANGES_JOB_ID}\` job defines no \`${CI_CORE_FLAG}\` filter`);
  } else if (!sameSet(new Set(globs(CI_CORE_FLAG)), new Set(ciCoreGlobs))) {
    problems.push(
      `${CI_CORE_FLAG} globs must be exactly [${ciCoreGlobs.join(', ')}]; found [${globs(CI_CORE_FLAG).join(', ')}]`,
    );
  }

  // Invariant 3: each job gates on the flags it must (schema validation, or a
  // source-read coupling the buildScripts closure cannot model).
  for (const [id, required] of Object.entries(REQUIRED_JOB_FLAGS)) {
    if (!jobs[id]) {
      problems.push(`expected job \`${id}\` not found in test.yml`);
      continue;
    }
    const flags = jobFlags(jobs[id]);
    for (const flag of required) {
      if (!flags.has(flag)) problems.push(`job \`${id}\` must gate on the \`${flag}\` flag`);
    }
  }

  // Invariant 4: .github/actions/** is covered by ciCore. With `ciCoreGlobs` at
  // its default every red here is also a red of invariant 2; this leg reds
  // alone when the list and the filter drop the glob together.
  if (!globs(CI_CORE_FLAG).includes('.github/actions/**'))
    problems.push(
      `${CI_CORE_FLAG} must include \`.github/actions/**\` (composite actions are used everywhere)`,
    );

  // Invariant 5: each produce/diff pair co-fires — identical trigger sets, so
  // the diff never fires without its producer's artifact (and the producer is
  // not run to upload an artifact no diff consumes).
  for (const [producer, consumer] of PRODUCE_DIFF_PAIRS) {
    if (!jobs[producer] || !jobs[consumer]) {
      problems.push(`produce/diff pair \`${producer}\`->\`${consumer}\` references a missing job`);
      continue;
    }
    const pFlags = jobFlags(jobs[producer]);
    const cFlags = jobFlags(jobs[consumer]);
    const diff = [
      ...[...cFlags].filter((f) => !pFlags.has(f)),
      ...[...pFlags].filter((f) => !cFlags.has(f)),
    ];
    if (diff.length)
      problems.push(
        `produce/diff pair \`${producer}\`/\`${consumer}\` must co-fire (identical trigger flags); ` +
          `these differ: [${[...new Set(diff)].join(', ')}]`,
      );
  }

  // Invariant 6: every flag a job gates on is a filter the `changes` job's
  // paths-filter step defines. A gate on an undefined filter is always false,
  // so the job never fires for the input it was meant to watch — and reads as
  // correct.
  for (const [id, job] of Object.entries(jobs)) {
    for (const flag of jobFlags(job)) {
      if (!has(flag))
        problems.push(`job \`${id}\` gates on \`${flag}\`, which the \`${CHANGES_JOB_ID}\` job's ${PATHS_FILTER_USES} step does not define`); // prettier-ignore
    }
  }

  // Invariant 7: the hops a flag passes through inside the `changes` job — the
  // filter map and the job's `outputs:` block name the same set both ways, each
  // output binds its own filter through the filter step's own id, and no filter
  // sits inert. A hop that breaks reads as a correct workflow: the gate is
  // well-formed and simply watches the wrong paths, or nothing at all.
  const changes = jobs[CHANGES_JOB_ID];
  if (!changes) {
    problems.push(
      `the workflow defines no \`${CHANGES_JOB_ID}\` job, so no flag has an output to bind`,
    );
  } else {
    const outputs = changes.outputs || {};
    const filterStep = pathsFilterStep(changes);
    if (!filterStep) {
      problems.push(`the \`${CHANGES_JOB_ID}\` job runs no ${PATHS_FILTER_USES} step`);
    } else if (typeof filterStep.id !== 'string' || filterStep.id === '') {
      problems.push(`the \`${CHANGES_JOB_ID}\` job's ${PATHS_FILTER_USES} step declares no \`id\`, so no output can bind it`); // prettier-ignore
    } else {
      const stepId = filterStep.id;
      for (const flag of Object.keys(filters)) {
        if (!Object.prototype.hasOwnProperty.call(outputs, flag))
          problems.push(`filter \`${flag}\` has no output on the \`${CHANGES_JOB_ID}\` job, so no job can gate on it`); // prettier-ignore
      }
      for (const [name, value] of Object.entries(outputs)) {
        if (!has(name)) {
          problems.push(`output \`${name}\` of the \`${CHANGES_JOB_ID}\` job names no filter`);
          continue;
        }
        const bound = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.(\w+)\s*\}\}$/.exec(String(value));
        if (!bound) {
          problems.push(`output \`${name}\` of the \`${CHANGES_JOB_ID}\` job is not a step-output expression: \`${value}\``); // prettier-ignore
        } else if (bound[1] !== stepId) {
          problems.push(`output \`${name}\` of the \`${CHANGES_JOB_ID}\` job reads step \`${bound[1]}\`, not the ${PATHS_FILTER_USES} step \`${stepId}\``); // prettier-ignore
        } else if (bound[2] !== name) {
          problems.push(`output \`${name}\` of the \`${CHANGES_JOB_ID}\` job binds the \`${bound[2]}\` filter, not its own`); // prettier-ignore
        }
      }
      const gated = new Set();
      for (const job of Object.values(jobs)) for (const flag of jobFlags(job)) gated.add(flag);
      for (const flag of Object.keys(filters)) {
        if (!gated.has(flag)) problems.push(`filter \`${flag}\` is defined but no job gates on it`);
      }
    }
  }

  // Invariant 8: every glob-free filter entry names a file git tracks. A
  // literal entry is one rename away from matching nothing, silently — and an
  // existing directory, a trailing-slash path, or an untracked file present on
  // disk matches nothing in the paths filter either, so only a tracked file
  // passes.
  for (const [flag, entries] of Object.entries(filters)) {
    for (const entry of entries) {
      if (GLOB_CHARS.test(entry)) continue;
      if (!isTracked(entry))
        problems.push(`filter \`${flag}\` lists \`${entry}\`, which is not a tracked file`);
    }
  }

  // Invariant 9: every document the clause registry's prefix map names is a
  // `suiteHeld` entry — the preamble suite holds each carrier's registry link
  // as raw text, so a carrier the flag omits reds unit-tests on `main` alone.
  const held = new Set(globs(SUITE_HELD_FLAG));
  for (const doc of registryDocs) {
    if (!held.has(doc))
      problems.push(`the clause registry names \`${doc}\`, which the \`${SUITE_HELD_FLAG}\` filter does not list; the preamble suite holds its registry link`); // prettier-ignore
  }

  // Invariant 10: each held flag's filter and its holdings map name the same
  // set both ways — a file joins the flag only with the holding that earns it
  // stated beside it, and a holding that ends takes its entry with it. A map
  // for a flag the filter does not define is one problem, its entries unread.
  for (const { flag, map, name } of HELD_FLAG_MAPS) {
    if (!has(flag)) {
      problems.push(`${name} states holdings for \`${flag}\`, which the \`${CHANGES_JOB_ID}\` job's ${PATHS_FILTER_USES} step does not define`); // prettier-ignore
      continue;
    }
    const listed = new Set(globs(flag));
    for (const entry of listed) {
      if (!Object.prototype.hasOwnProperty.call(map, entry))
        problems.push(`the \`${flag}\` filter lists \`${entry}\`, which ${name} states no holding for`); // prettier-ignore
    }
    for (const entry of Object.keys(map)) {
      if (!listed.has(entry))
        problems.push(`${name} states a holding for \`${entry}\`, which the \`${flag}\` filter does not list`); // prettier-ignore
    }
  }

  // Invariant 11: no filter lists the same entry more than once. A repeat
  // matches nothing the single entry does not, and no leg above reports it as a
  // repeat — the set comparisons collapse it, and the per-entry legs answer the
  // same for each copy — so the repeat itself survives them all while the map
  // states one entry more than once. One problem per repeated entry, however
  // many times it is repeated, in first-occurrence order.
  for (const [flag, entries] of Object.entries(filters)) {
    const counts = new Map();
    for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
    for (const [entry, count] of counts) {
      if (count > 1) problems.push(`filter \`${flag}\` lists \`${entry}\` more than once`);
    }
  }

  // Invariant 12: every heavy job whose own closure is non-empty gates on
  // buildScripts. One-directional — an empty closure licenses nothing, since a
  // form the command model does not read is outside it (invariant 3 carries
  // those jobs' gates).
  for (const [id, job] of Object.entries(heavy)) {
    const own = jobClosures[id];
    if (own.size === 0 || jobFlags(job).has(BUILD_SCRIPTS_FLAG)) continue;
    problems.push(`heavy job \`${id}\` runs ${[...own].sort().join(', ')} but does not gate on the \`${BUILD_SCRIPTS_FLAG}\` flag`); // prettier-ignore
  }

  return problems;
}

/**
 * Every input {@link evaluateContract} takes, read from the tree: the parsed
 * workflow and its filter map, the buildScripts closure the heavy jobs reach
 * and each heavy job's own closure, the tracked-file predicate invariant 8
 * asks about each literal entry, and the documents the clause registry's
 * prefix map names. One reader, so the suite
 * that drives the contract over the shipped tree observes the inputs this
 * command line evaluates rather than a rebuild of them.
 */
function loadInputs() {
  const { wf, filters } = loadWorkflow();
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {};
  const build = computeBuildClosure(wf, scripts);
  // Git's own listing, read once.
  const tracked = new Set(trackedFilesUnder('.', { cwd: ROOT }));
  return {
    wf,
    filters,
    closure: build.closure,
    jobClosures: build.jobClosures,
    isTracked: (p) => tracked.has(p),
    registryDocs: Object.values(JSON.parse(readFileSync(CLAUSE_REGISTRY, 'utf8')).prefixes),
  };
}

function run() {
  const problems = evaluateContract(loadInputs());

  if (problems.length) {
    console.error('✗ test.yml path-filter contract violated:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\n${problems.length} violation${problems.length === 1 ? '' : 's'}. ` +
        `See ${SELF_PATH} and docs/guides/ci.md for the intended split.`,
    );
    process.exit(1);
  }
  console.log('✓ test.yml path-filter contract holds (buildScripts closure + gate invariants).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}

export {
  CI_CORE_GLOBS,
  CHANGES_JOB_ID,
  PATHS_FILTER_USES,
  GLOB_CHARS,
  SUITE_HELD_HOLDINGS,
  HELD_FLAG_HOLDINGS,
  loadWorkflow,
  loadInputs,
  jobSteps,
  pathsFilterStep,
  jobFlags,
  heavyJobs,
  entryFilesFromCommand,
  scriptsClosure,
  computeBuildClosure,
  evaluateContract,
};
