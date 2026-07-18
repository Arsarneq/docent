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
 *   2. No broad `ci` (scripts/**), no sibling workflow, and no inert root
 *      config gates any heavy job — ciCore carries only test.yml, the composite
 *      actions, and the root npm manifests.
 *   3. Each job gates on the flags it must because it exercises an input the
 *      buildScripts closure can't model: `schema` on desktop-rust-tests and
 *      desktop-corpus-diff (they validate the desktop corpus against the schema
 *      composed from schemas/**), and `releasePipeline` on reference-server-tests
 *      (its release-exclusion suite readFileSyncs the publish workflows + the
 *      release-output guard).
 *   4. `.github/actions/**` is in ciCore (composite actions are used by nearly
 *      every job).
 *   5. Each needs-chained produce/diff pair co-fires — identical trigger flags —
 *      so a diff job never fires without the producer whose artifact it
 *      downloads, nor the producer without the diff that consumes it.
 *
 * Usage: node scripts/check-ci-filter.js   # or: npm run lint:ci-filter
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'test.yml');

// The design contract, encoded once. These job ids ARE the point of the guard;
// a rename that leaves one dangling is itself a failure (checked below).
const UNIT_JOB = 'unit-tests';
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
//   reference-server-tests — its release-exclusion suite readFileSyncs the two
//     publish workflows + the release-output guard (the `releasePipeline` flag).
const REQUIRED_JOB_FLAGS = {
  'desktop-rust-tests': ['schema'],
  'desktop-corpus-diff': ['schema'],
  'reference-server-tests': ['releasePipeline'],
};
const PRODUCE_DIFF_PAIRS = [
  ['desktop-rust-tests', 'desktop-corpus-diff'],
  ['desktop-vectors-produce', 'desktop-vectors-diff'],
];

/** Normalise an absolute path to a repo-relative, forward-slash path. */
function rel(abs) {
  return abs.slice(ROOT.length + 1).replace(/\\/g, '/');
}

/** Parse test.yml and the nested dorny filter block into structured data. */
function loadWorkflow() {
  const wf = yaml.load(readFileSync(WORKFLOW, 'utf8'));
  const changes = wf.jobs?.changes;
  const filterStep = (changes?.steps || []).find(
    (s) => typeof s.uses === 'string' && s.uses.includes('paths-filter'),
  );
  // The filter definitions are a YAML literal block inside `with.filters`.
  const filters = filterStep?.with?.filters ? yaml.load(filterStep.with.filters) : {};
  // Normalise each filter's globs to a string[] (dorny allows a bare string).
  for (const k of Object.keys(filters)) {
    filters[k] = Array.isArray(filters[k]) ? filters[k].map(String) : [String(filters[k])];
  }
  return { wf, filters };
}

/** The change-flags a job's `if:` gates on (needs.changes.outputs.<flag>). */
function jobFlags(job) {
  const cond = typeof job?.if === 'string' ? job.if : '';
  return new Set([...cond.matchAll(/needs\.changes\.outputs\.(\w+)/g)].map((m) => m[1]));
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
 * Pure contract check: given the parsed workflow, its filter map, and the
 * computed buildScripts `closure` (a Set of repo-relative script paths), return
 * the list of violations — empty means the contract holds. No IO, so the unit
 * test drives every invariant with synthetic inputs.
 */
function evaluateContract({ wf, filters, closure }) {
  const problems = [];
  const jobs = wf.jobs || {};
  const heavy = heavyJobs(wf);

  const has = (flag) => Object.prototype.hasOwnProperty.call(filters, flag);
  const globs = (flag) => (has(flag) ? filters[flag] : []);
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  // Invariant 1: buildScripts set-equality with the heavy jobs' script closure.
  if (!has('buildScripts')) {
    problems.push('the `changes` job defines no `buildScripts` filter');
  } else {
    const declared = new Set(globs('buildScripts'));
    if (!sameSet(closure, declared)) {
      const missing = [...closure].filter((s) => !declared.has(s)).sort();
      const extra = [...declared].filter((s) => !closure.has(s)).sort();
      if (missing.length)
        problems.push(`buildScripts is MISSING scripts the heavy jobs run: ${missing.join(', ')}`);
      if (extra.length)
        problems.push(`buildScripts lists scripts no heavy job reaches: ${extra.join(', ')}`);
    }
  }

  // Invariant 2: no heavy job gates on broad `ci`; ciCore is exactly the four
  // environment-wide globs (no sibling workflow, no inert config).
  for (const [id, job] of Object.entries(heavy)) {
    if (jobFlags(job).has('ci'))
      problems.push(`heavy job \`${id}\` gates on the broad \`ci\` flag (scripts/**)`);
  }
  if (!has('ciCore')) {
    problems.push('the `changes` job defines no `ciCore` filter');
  } else if (!sameSet(new Set(globs('ciCore')), new Set(CI_CORE_GLOBS))) {
    problems.push(
      `ciCore globs must be exactly [${CI_CORE_GLOBS.join(', ')}]; found [${globs('ciCore').join(', ')}]`,
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
  if (!globs('ciCore').includes('.github/actions/**'))
    problems.push(
      'ciCore must include `.github/actions/**` (composite actions are used everywhere)',
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

  return problems;
}

function run() {
  const { wf, filters } = loadWorkflow();
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {};
  const closure = computeBuildClosure(wf, scripts);
  const problems = evaluateContract({ wf, filters, closure });

  if (problems.length) {
    console.error('✗ test.yml path-filter contract violated:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\n${problems.length} violation${problems.length === 1 ? '' : 's'}. ` +
        `See scripts/check-ci-filter.js and docs/guides/ci.md for the intended split.`,
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
  loadWorkflow,
  jobFlags,
  heavyJobs,
  entryFilesFromCommand,
  scriptsClosure,
  computeBuildClosure,
  evaluateContract,
};
