/**
 * coverage-run.js — the run-scoped naming contract for raw coverage dumps,
 * shared by the two Playwright suites that convert V8 coverage to lcov: the
 * extension e2e suite and the desktop integration suite (see
 * docs/test/e2e.md and docs/test/integration/desktop.md).
 *
 * Simultaneous runs of a suite share that suite's raw-dump directory: every
 * dump name carries the run id the suite's global setup mints (inherited by
 * every worker process through the environment) plus the writing process's
 * pid, so names stay unique across worker processes and across runs. A
 * suite's teardown merges and sweeps only its own run's dumps — the
 * prefix-anchored predicate `ownDumpMatcher` builds is the one ownership
 * form — and ages out stale leftovers from runs that died before their own
 * sweep. The run id is read lazily on every use, never cached at module
 * load, so an import that precedes the global setup (the setup itself, or
 * the teardown module in the same runner process) still sees the minted id.
 */

import fs from 'fs';
import path from 'path';

// An externally supplied id is honored only in this filename-safe shape: the
// id lands inside every dump's filename, so a stray path separator would
// otherwise write dumps outside the raw directory — where the teardown would
// silently merge and sweep nothing. The ids `ensureRunId` mints always fit
// the shape.
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

let warnedUnsafeId = false;

/**
 * This run's id: the environment-carried value where it is filename-safe,
 * else `unscoped` — which appears only when a writer runs outside its suite
 * config, or when a supplied id fails the shape above.
 *
 * @returns {string}
 */
export function runId() {
  const id = process.env.DOCENT_COVERAGE_RUN;
  if (id === undefined) return 'unscoped';
  if (!SAFE_RUN_ID.test(id)) {
    if (!warnedUnsafeId) {
      warnedUnsafeId = true;
      console.warn(
        `[coverage] ignoring unsafe DOCENT_COVERAGE_RUN value; dumps are written and merged as 'unscoped'`,
      );
    }
    return 'unscoped';
  }
  return id;
}

/**
 * Mint this run's id into the environment — called from a suite's Playwright
 * global setup, whose main-process env every worker inherits. `??=` keeps an
 * externally supplied id (and a re-entrant setup) intact.
 */
export function ensureRunId() {
  process.env.DOCENT_COVERAGE_RUN ??= `${Date.now().toString(36)}-${process.pid}`;
}

/**
 * Write one raw coverage dump under the run-scoped name
 * `<prefix>-<runId>-<pid>-<n>.json`. The directory is (re)created before
 * every write, because a simultaneous run's teardown may have just removed
 * it.
 *
 * @param {string} rawDir - The suite's shared raw-dump directory
 * @param {string} prefix - The writer's dump family (e.g. `content`)
 * @param {number} n - The writer's own counter for this dump
 * @param {unknown} data - JSON-serializable coverage entries
 * @returns {string} The written file's path
 */
export function writeRawDump(rawDir, prefix, n, data) {
  fs.mkdirSync(rawDir, { recursive: true });
  const file = path.join(rawDir, `${prefix}-${runId()}-${process.pid}-${n}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

/**
 * Build the ownership predicate for this run's dumps — the only files a
 * teardown merges, and the only files it sweeps. The form is
 * prefix-anchored: a name is owned when it starts with
 * `<prefix>-<runId>-` for one of the suite's declared writer families and
 * ends in `.json`. The caller states its complete family list; a family
 * omitted there is never merged, and its dumps are aged out unmerged later.
 *
 * @param {string[]} prefixes - The suite's writer families
 * @returns {(name: string) => boolean}
 */
export function ownDumpMatcher(prefixes) {
  return (name) =>
    name.endsWith('.json') && prefixes.some((p) => name.startsWith(`${p}-${runId()}-`));
}

// Raw dumps from runs that died before their teardown could sweep them are
// aged out by any later run once they are this old. Age is the only signal:
// a run somehow held open past this bound (a debugger pause) would lose its
// early dumps to a sibling's sweep and report thinner coverage — a trade
// accepted for unattended cleanup, with the bound roughly seven times the
// longer suite's measured wall time.
const STALE_DUMP_MS = 60 * 60 * 1000;

/**
 * Age out leftovers from runs that died before their own sweep. Only clearly
 * stale files go: a fresh file that is not this run's belongs to a
 * simultaneous run whose own teardown sweeps it.
 *
 * @param {string} rawDir - The suite's shared raw-dump directory
 * @param {string[]} allFiles - The directory listing to consider
 * @param {(name: string) => boolean} isOwn - This run's ownership predicate
 */
export function ageOutForeignDumps(rawDir, allFiles, isOwn) {
  const now = Date.now();
  for (const f of allFiles) {
    if (isOwn(f) || !f.endsWith('.json')) continue;
    try {
      if (now - fs.statSync(path.join(rawDir, f)).mtimeMs > STALE_DUMP_MS) {
        fs.rmSync(path.join(rawDir, f), { force: true });
      }
    } catch {
      // raced by another run's teardown — fine
    }
  }
}

/**
 * Read one raw dump's entries, skipping an unreadable file with a warning
 * naming it instead of failing the run.
 *
 * @param {string} rawDir - The suite's shared raw-dump directory
 * @param {string} file - The dump's filename
 * @returns {unknown[] | null} The parsed entries, or null when unreadable
 */
export function readRawDump(rawDir, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf-8'));
  } catch (err) {
    console.warn(`[coverage] skipping unreadable raw dump ${file}: ${err.message}`);
    return null;
  }
}
