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
 *      composed from schemas/**), `releasePipeline` on each job whose suite
 *      reads the release-pipeline sources as files — reference-server-tests
 *      (release-exclusion) and unit-tests (the disposition suite's weld between
 *      the publish workflows and the automation branch) — `referenceServer` on
 *      unit-tests as well (its shared suite walks reference-implementations/
 *      for the resolution-procedure tokens no shipped file may carry) — and, on
 *      unit-tests alone, the narrow flags for the files only its suites hold:
 *      `contractDocs` (the surfaces that suite welds itself to in each
 *      contributor contract file — the governance line both show, the per-doc
 *      grammar forms both show, the standing mutation sentence both spell,
 *      CONTRIBUTING's exemption paragraph, and the shipped template's inert
 *      guidance comments),
 *      `dispositionWorkflow` (the guard-step env block in
 *      .github/workflows/docs-disposition.yml),
 *      and `suiteHeld` (the files whose content a suite or a step of that job
 *      asserts over — the clause registry's carriers as a class, each held by
 *      the preamble suite's raw registry link, and the files held from
 *      outside the registry; `SUITE_HELD_HOLDINGS` below states each entry's
 *      own holding beside it).
 *   4. `.github/actions/**` is in ciCore (composite actions are used by nearly
 *      every job).
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
 *  10. The `suiteHeld` filter and `SUITE_HELD_HOLDINGS` name the same set both
 *      ways: a file joins the flag only with the holding that earns it stated
 *      beside it, and a holding that ends takes its entry with it.
 *  11. No filter lists the same entry more than once. A repeat matches
 *      nothing the single entry does not, and no leg above reports it as a
 *      repeat — the set comparisons collapse it, and the per-entry legs
 *      answer the same for each copy — so the repeat itself survives them all
 *      while the map states one entry more than once.
 *
 * Usage: node scripts/check-ci-filter.js   # or: npm run lint:ci-filter
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
// Shared readers only — that module imports node builtins and nothing else, so
// this command line inherits no parser or heavy module it does not use (the
// lean-closure principle scripts/governance-data.js states).
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
//   reference-server-tests — its release-exclusion suite readFileSyncs the
//     publish workflows + the release-output guard (the `releasePipeline` flag).
//   unit-tests — its disposition suite readFileSyncs both publish workflows to
//     hold them to the automation branch the release guards key on, so a PR
//     touching only a publish workflow must still run it (same flag). It also
//     gates on `referenceServer`: its shared suite walks
//     reference-implementations/ for the resolution-procedure tokens no shipped
//     file may carry — a holding the heavy jobs that flag reaches do not carry,
//     so an edit there must run this job too. It also holds files no other
//     job's suite holds: the contributor contract files, welded surface by
//     surface — this file's header enumerates those surfaces where it states
//     the `contractDocs` gate, which is the one place they are listed;
//     docs-disposition.yml, whose guard step's env block is held to the inputs
//     the head-ref derivation is written against; and the documents and
//     workflow files a suite or a step of this job asserts over, the clause
//     registry's carriers among them as a class. Each takes a narrow flag of
//     its own (`contractDocs`, `dispositionWorkflow`, `suiteHeld`) gating this
//     job alone, so an edit to those files reaches the suite that holds them
//     and no heavy job beyond it.
const REQUIRED_JOB_FLAGS = {
  'desktop-rust-tests': ['schema'],
  'desktop-corpus-diff': ['schema'],
  'reference-server-tests': ['releasePipeline'],
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
  '.github/workflows/scorecard.yml':
    "the disposition suite's schedule welds — the cron field, its comment, and the guide's row and section",
  'README.md': "the version-sync step's table",
  'docs/api/dispatch.md': "the preamble suite's registry link and its clause-text anchors",
  'docs/api/sync-protocol.md': "the preamble suite's registry link",
  'docs/architecture/application/desktop/windows/application-shell.md':
    "the preamble suite's registry link, and the command-surface suite's sentence anchor and single-problem pin",
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
  'docs/test/integration/desktop.md': "the integration-suite locks' shared-helpers paragraph",
  'docs/test/strategy/coverage.md': "the preamble suite's registry link",
  'docs/test/strategy/mutation.md':
    "the preamble suite's registry link and the disposition suite's cadence clause",
  'docs/verification/scripted-truth-corpus.md':
    "the preamble suite's registry link and the inventory suite's literal anchors",
  'docs/verification/sufficiency-lint.md':
    "the preamble suite's registry link and the inventory suite's literal anchors",
};
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
 * The filter job's paths-filter step, or undefined when the job is absent, runs
 * no steps, or runs no step whose `uses:` names the filter action. One locator,
 * so every reader of the filter map reaches the same step.
 * @param {object | undefined} job the parsed job
 * @returns {object | undefined} the filter step
 */
function pathsFilterStep(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps.find((s) => typeof s?.uses === 'string' && s.uses.includes(PATHS_FILTER_USES));
}

/** Normalise an absolute path to a repo-relative, forward-slash path. */
function rel(abs) {
  return abs.slice(ROOT.length + 1).replace(/\\/g, '/');
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

/**
 * Resolve a job's `run:` command strings to the script ENTRY files it executes
 * directly. Recognised forms: `npm run <k>` (resolved via package.json, then
 * recursed), and `node [--flags] <path.js>`. Forms deliberately NOT traversed —
 * `npx playwright`/`cargo`/a sub-package `npm test` — reach only build-schemas.js,
 * which is already in the closure via sync-shared.js (run by other jobs); every
 * such edge lands on an already-covered script, so skipping them cannot drop a
 * script from the union closure.
 */
function entryFilesFromCommand(cmd, scripts, seenKeys = new Set()) {
  const entries = new Set();
  for (const sub of cmd.split(/&&|\|\||;|\n/)) {
    const tokens = sub.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'npm' && tokens[1] === 'run' && tokens[2]) {
      const key = tokens[2];
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const script = scripts[key];
      if (script) for (const e of entryFilesFromCommand(script, scripts, seenKeys)) entries.add(e);
      continue;
    }
    if (tokens[0] === 'node') {
      const path = tokens.slice(1).find((t) => !t.startsWith('-') && /\.[cm]?js$/.test(t));
      if (path) entries.add(join(ROOT, path));
    }
  }
  return entries;
}

/**
 * Transitive scripts/-local closure of a set of entry files. Every `*.js`
 * string literal in a reachable file is resolved against both the file's own
 * directory and ROOT/scripts (covering static imports, `await import()`, and
 * the `execFileSync(process.execPath, [join(ROOT, 'scripts', '<x>.js')])`
 * spawn form); those that exist under scripts/ join the closure and are
 * themselves expanded.
 */
function scriptsClosure(entryFiles) {
  const scriptsDir = join(ROOT, 'scripts');
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
 * The buildScripts closure (repo-relative paths) the heavy jobs actually reach,
 * computed from the workflow + package.json script wrappers. Kept separate from
 * evaluateContract so the pure contract check can be unit-tested against
 * synthetic closures without touching disk.
 */
function computeBuildClosure(wf, scripts) {
  const entries = new Set();
  for (const job of Object.values(heavyJobs(wf))) {
    for (const step of job.steps || []) {
      if (typeof step.run === 'string')
        for (const e of entryFilesFromCommand(step.run, scripts)) entries.add(e);
    }
  }
  return new Set([...scriptsClosure(entries)].map(rel));
}

/**
 * Pure contract check: given the parsed workflow, its filter map, the computed
 * buildScripts `closure` (a Set of repo-relative script paths), an `isTracked`
 * predicate that answers true only for a path git tracks as a file, and
 * `registryDocs` (the documents the clause registry's prefix map names), return
 * the list of violations — empty means the contract holds. The inputs that
 * stand for state outside the workflow — the tracked-file predicate and the
 * registry's document list — are required rather than defaulted, so a caller
 * that forgets one throws instead of skipping the invariant it feeds. No IO of
 * its own, so the unit test drives every invariant with synthetic inputs.
 */
function evaluateContract({ wf, filters, closure, isTracked, registryDocs }) {
  if (typeof isTracked !== 'function')
    throw new TypeError('evaluateContract: isTracked is required');
  if (!Array.isArray(registryDocs))
    throw new TypeError('evaluateContract: registryDocs is required');
  const problems = [];
  const jobs = wf.jobs || {};
  const heavy = heavyJobs(wf);

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
  // environment-wide globs `CI_CORE_GLOBS` states.
  for (const [id, job] of Object.entries(heavy)) {
    if (jobFlags(job).has('ci'))
      problems.push(`heavy job \`${id}\` gates on the broad \`ci\` flag (scripts/**)`);
  }
  if (!has(CI_CORE_FLAG)) {
    problems.push(`the \`${CHANGES_JOB_ID}\` job defines no \`${CI_CORE_FLAG}\` filter`);
  } else if (!sameSet(new Set(globs(CI_CORE_FLAG)), new Set(CI_CORE_GLOBS))) {
    problems.push(
      `${CI_CORE_FLAG} globs must be exactly [${CI_CORE_GLOBS.join(', ')}]; found [${globs(CI_CORE_FLAG).join(', ')}]`,
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

  // Invariant 4: .github/actions/** is covered by ciCore.
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

  // Invariant 10: the `suiteHeld` filter and SUITE_HELD_HOLDINGS name the same
  // set both ways — a file joins the flag only with the holding that earns it
  // stated beside it, and a holding that ends takes its entry with it.
  for (const entry of held) {
    if (!Object.prototype.hasOwnProperty.call(SUITE_HELD_HOLDINGS, entry))
      problems.push(`the \`${SUITE_HELD_FLAG}\` filter lists \`${entry}\`, which SUITE_HELD_HOLDINGS states no holding for`); // prettier-ignore
  }
  for (const entry of Object.keys(SUITE_HELD_HOLDINGS)) {
    if (!held.has(entry))
      problems.push(`SUITE_HELD_HOLDINGS states a holding for \`${entry}\`, which the \`${SUITE_HELD_FLAG}\` filter does not list`); // prettier-ignore
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

  return problems;
}

/**
 * Every input {@link evaluateContract} takes, read from the tree: the parsed
 * workflow and its filter map, the buildScripts closure the heavy jobs reach,
 * the tracked-file predicate invariant 8 asks about each literal entry, and the
 * documents the clause registry's prefix map names. One reader, so the suite
 * that drives the contract over the shipped tree observes the inputs this
 * command line evaluates rather than a rebuild of them.
 */
function loadInputs() {
  const { wf, filters } = loadWorkflow();
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {};
  // Git's own listing, read once.
  const tracked = new Set(trackedFilesUnder('.', { cwd: ROOT }));
  return {
    wf,
    filters,
    closure: computeBuildClosure(wf, scripts),
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
  loadWorkflow,
  loadInputs,
  pathsFilterStep,
  jobFlags,
  heavyJobs,
  entryFilesFromCommand,
  scriptsClosure,
  computeBuildClosure,
  evaluateContract,
};
