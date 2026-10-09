/**
 * check-npm-advisories.js — the npm advisory gate: every high or critical
 * advisory `npm audit` reports over the root lockfile fails the build unless
 * the in-file ignore list below names it, with its reason and its `until` day,
 * and the entry still holds — the verdicts below say when a listed advisory
 * still reds.
 *
 * The audit is `npm audit --json --package-lock-only`, read at the gate's level
 * (high and critical; advisories below `high` are not read). npm's report
 * keeps one entry per vulnerable package, and each entry's `via` array holds
 * the ROOT advisories filed against that package (objects carrying the
 * advisory's url, title and severity) and the names of the vulnerable packages
 * it inherits from (strings). This check reads the root advisories, keys each
 * by the GHSA id at the end of its url to the set of packages the audit files
 * it against, and holds them to IGNORED_ADVISORIES from both sides. This header
 * is the home of the verdicts; the workflow step and the CI guide point here.
 *
 * Exit 1, one line per finding:
 *
 *   - unlisted: a high or critical root advisory the list does not name,
 *     printed with its id, packages, severity, title and url;
 *   - stale: a listed advisory the audit no longer reports at high or
 *     critical — delete the entry;
 *   - expired: an entry held through its `until`, the last day the entry
 *     holds, which has passed — re-check the advisory and renew or delete the
 *     entry;
 *   - wrong package: an entry naming a package the audit does not file its
 *     advisory against — correct the entry;
 *   - fix available: a listed advisory one of whose packages' audit entries
 *     carries `fixAvailable: true`, printed with those packages — refresh the
 *     lockfile; the entry goes once the advisory is no longer reported at high
 *     or critical (an object value names a semver-major change of another
 *     package, which is not counted as a fix).
 *
 * Exit 2, the machinery verdict, which keeps a read this check could not take
 * whole apart from an advisory the gate holds: a malformed list (a missing or
 * empty field, an id not of the GHSA form, a duplicate id, an `until` that is
 * not a calendar day); audit output that does not run, is not JSON, carries
 * npm's own `error` object (quoted), or lacks a field this check reads; an
 * unexplained chain; a `metadata` count that disagrees with the entries read;
 * and any other error the run meets.
 *
 * Each list entry is `{ id, package, reason, until }`: the GHSA id, a package
 * the advisory is filed against, why the advisory is waved through, and
 * `until`, the last day the entry holds (a calendar day, YYYY-MM-DD, UTC; the
 * gate reds the day after). An entry is added with the id from the red line's
 * url, the package, the reason, and an `until` no more than one month out, and
 * renewed the same way. This paragraph is the upkeep rule's one home: a stale
 * entry is deleted; an expired entry is re-checked — renewed with a new day and
 * its reason revisited while `fixAvailable` is `true` for none of the packages
 * the advisory is filed against, and otherwise given the fix-available remedy;
 * for a fix-available entry the lockfile is refreshed first, and the entry is
 * deleted once the advisory is no longer reported at high or critical; an entry
 * naming a wrong package is corrected. The list is the npm counterpart of the
 * advisory ignore list in packages/desktop/src-tauri/deny.toml on the Rust
 * side.
 *
 * Limit: transitive vulnerabilities are judged through their root advisories,
 * so a listed root advisory clears every vulnerable package whose `via` chain
 * leads to it. That is sound only while every such entry leads to a root
 * advisory, so each one at the gate's level is held to it: an entry whose
 * chain reaches no root advisory at the gate's level is reported as
 * unexplained.
 *
 * Usage: node scripts/check-npm-advisories.js   # or: npm run check:npm-advisories
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The severities this gate reads; anything below `high` is outside it. */
export const GATE_SEVERITIES = ['high', 'critical'];

/** The audit this check reads: the root lockfile, without an install. */
export const AUDIT_COMMAND = 'npm audit --json --package-lock-only';

/**
 * The advisories this gate waves through, each by name. Every entry carries the
 * reason it is waved through and the last day it holds; a stale or expired
 * entry reds, so the list states what is waved through today and nothing else.
 */
export const IGNORED_ADVISORIES = [
  {
    id: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    reason:
      'No patched release is published: the vulnerable range (<= 3.0.3) covers braces 3.0.3, the ' +
      'latest version. braces is reached only through development tooling, and no available ' +
      'remedy clears it: the fixes npm audit offers are semver-major downgrades of stylelint, ' +
      'stylelint-config-standard and remark-cli, and the update it offers for markdownlint-cli2 ' +
      'addresses another advisory while keeping micromatch 4.0.8, which depends on braces.',
    until: '2026-11-03',
  },
];

/** The fields every list entry carries, each a non-empty string. */
const ENTRY_FIELDS = ['id', 'package', 'reason', 'until'];

/** The fields every root advisory at the gate's level carries, each a string. */
const ROOT_FIELDS = ['name', 'title', 'url', 'severity'];

/** A GitHub advisory id, as it ends an advisory url. */
const GHSA_RE = /^GHSA(-[0-9a-z]{4}){3}$/;

/** The advisory url form npm reports, ending in the GHSA id. */
const ADVISORY_URL_RE = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})$/;

/**
 * An input this check reads that answered with something other than the surface
 * it reads there — machinery breakage, reported on the check's own exit code so
 * it is never read as an advisory the gate holds.
 */
export class InputError extends Error {}

/**
 * Whether a string is a real calendar day written YYYY-MM-DD.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

/**
 * Hold the ignore list to its shape: every entry an object carrying the four
 * fields as non-empty strings, an id of the GHSA form, an `until` that is a
 * calendar day, and no id twice.
 * @param {Array<object>} list the ignore list
 * @throws {InputError} naming the first malformed entry
 */
export function checkList(list) {
  if (!Array.isArray(list)) throw new InputError('the ignore list is not an array');
  const seen = new Set();
  list.forEach((entry, i) => {
    const at = `ignore-list entry ${i + 1}`;
    if (entry === null || typeof entry !== 'object') throw new InputError(`${at} is not an object`);
    for (const field of ENTRY_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new InputError(`${at} lacks \`${field}\` — every entry carries ${ENTRY_FIELDS.join(', ')} as non-empty text`); // prettier-ignore
      }
    }
    if (!GHSA_RE.test(entry.id)) throw new InputError(`${at} has id ${entry.id}, which is not a GHSA id`); // prettier-ignore
    if (!isCalendarDay(entry.until)) {
      throw new InputError(`${at} (${entry.id}) has until ${entry.until}, which is not a calendar day written YYYY-MM-DD`); // prettier-ignore
    }
    if (seen.has(entry.id)) throw new InputError(`${at} repeats id ${entry.id}`);
    seen.add(entry.id);
  });
}

/**
 * Whether `value` is a plain object (not null, not an array).
 * @param {unknown} value
 * @returns {boolean}
 */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Read npm's audit report: the root advisories at the gate's level, keyed by
 * GHSA id to the set of packages each is filed against, and the count of
 * vulnerable packages at that level. Root advisories below the gate's level are
 * skipped before their shape is read. Every entry at the gate's level must lead,
 * through its `via` chain, to a root advisory at that level, and the report's
 * own counts must agree with the entries read. The result does not depend on
 * the order of the report's keys.
 * @param {string} text the audit command's standard output
 * @returns {{ vulnerableCount: number,
 *             roots: Map<string, { id: string, packages: string[], severity: string,
 *                                  title: string, url: string, fixPackages: string[] }> }}
 * @throws {InputError} when the text is not the report this check reads
 */
export function readReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new InputError('the audit output is not JSON');
  }
  if (isObject(report?.error)) {
    const { code, summary } = report.error;
    throw new InputError(`npm audit reported an error: ${code ?? '(no code)'}: ${summary ?? '(no summary)'}`); // prettier-ignore
  }
  const vulnerabilities = report?.vulnerabilities;
  if (!isObject(vulnerabilities)) {
    throw new InputError('the audit output carries no `vulnerabilities` object');
  }
  const counts = report.metadata?.vulnerabilities;
  if (!isObject(counts) || GATE_SEVERITIES.some((s) => !Number.isInteger(counts[s]))) {
    throw new InputError(`the audit output carries no \`metadata.vulnerabilities\` count for each of ${GATE_SEVERITIES.join(', ')}`); // prettier-ignore
  }

  const roots = new Map();
  const gated = [];
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!isObject(entry) || typeof entry.severity !== 'string' || !Array.isArray(entry.via)) {
      throw new InputError(`the audit entry for ${name} carries no \`severity\` text and \`via\` array`); // prettier-ignore
    }
    if (GATE_SEVERITIES.includes(entry.severity)) gated.push(name);
    for (const via of entry.via) {
      if (typeof via === 'string') continue;
      if (!isObject(via)) throw new InputError(`a \`via\` member under ${name} is neither a name nor an advisory`); // prettier-ignore
      if (!GATE_SEVERITIES.includes(via.severity)) continue;
      if (ROOT_FIELDS.some((f) => typeof via[f] !== 'string')) {
        throw new InputError(
          `a root advisory under ${name} lacks one of ${ROOT_FIELDS.join(', ')}`,
        );
      }
      const m = via.url.match(ADVISORY_URL_RE);
      if (!m) throw new InputError(`a root advisory under ${name} has url ${via.url}, which names no GHSA id`); // prettier-ignore
      const id = m[1];
      const root = roots.get(id) ?? { id, byPackage: new Map(), severities: new Set(), fixPackages: new Set() }; // prettier-ignore
      root.byPackage.set(via.name, { title: via.title, url: via.url });
      root.severities.add(via.severity);
      if (vulnerabilities[via.name]?.fixAvailable === true) root.fixPackages.add(via.name);
      roots.set(id, root);
    }
  }

  // Each gated entry must reach a root advisory at the gate's level, or the
  // judgment through root advisories would leave it unread.
  const reachesRoot = (name, seen) => {
    if (seen.has(name)) return false;
    seen.add(name);
    const entry = vulnerabilities[name];
    if (!entry) return false;
    return entry.via.some((via) =>
      typeof via === 'string' ? reachesRoot(via, seen) : GATE_SEVERITIES.includes(via.severity),
    );
  };
  for (const name of gated) {
    if (!reachesRoot(name, new Set())) {
      throw new InputError(`the audit entry for ${name} is ${vulnerabilities[name].severity} but its \`via\` chain reaches no root advisory at the gate's level — it is unexplained`); // prettier-ignore
    }
  }

  const counted = GATE_SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
  if (counted !== gated.length) {
    throw new InputError(`the audit's metadata counts ${counted} ${GATE_SEVERITIES.join(' or ')} vulnerabilities but its entries carry ${gated.length}`); // prettier-ignore
  }

  // Order-independent: ids sorted, packages sorted, the highest severity kept,
  // and the title and url taken from the first package by name.
  const ordered = new Map();
  for (const id of [...roots.keys()].sort()) {
    const r = roots.get(id);
    const severity = r.severities.has('critical') ? 'critical' : 'high';
    const packages = [...r.byPackage.keys()].sort();
    const { title, url } = r.byPackage.get(packages[0]);
    const fixPackages = [...r.fixPackages].sort();
    ordered.set(id, { id, packages, severity, title, url, fixPackages });
  }
  return { vulnerableCount: gated.length, roots: ordered };
}

/**
 * Judge the reported root advisories against the ignore list, from both sides.
 * Each entry lands in exactly one verdict, checked in this order: stale,
 * expired, wrong package, fix available, ignored.
 * @param {object} input
 * @param {Map<string, { id: string, packages: string[], fixPackages: string[] }>} input.roots
 *   the reported root advisories
 * @param {Array<{ id: string, package: string, until: string }>} input.list the ignore list
 * @param {string} input.today the current calendar day, YYYY-MM-DD (UTC)
 * @returns {{ unlisted: object[], stale: object[], expired: object[],
 *             mismatched: Array<{ entry: object, root: object }>,
 *             fixable: Array<{ entry: object, root: object }>, ignored: object[] }}
 */
export function judge({ roots, list, today }) {
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const result = { unlisted: [], stale: [], expired: [], mismatched: [], fixable: [], ignored: [] };
  for (const root of roots.values()) if (!byId.has(root.id)) result.unlisted.push(root);
  for (const entry of list) {
    const root = roots.get(entry.id);
    if (!root) result.stale.push(entry);
    else if (entry.until < today) result.expired.push(entry);
    else if (!root.packages.includes(entry.package)) result.mismatched.push({ entry, root });
    else if (root.fixPackages.length > 0) result.fixable.push({ entry, root });
    else result.ignored.push(entry);
  }
  return result;
}

/**
 * Run the audit and return its standard output. npm exits 1 when it reports a
 * vulnerability and still prints the report, so 0 and 1 are both a report.
 * @param {object} [seams]
 * @param {typeof spawnSync} [seams.spawn] the process runner
 * @returns {string} the audit's standard output
 * @throws {InputError} when the command does not run or prints nothing
 */
export function runAudit({ spawn = spawnSync } = {}) {
  const result = spawn(AUDIT_COMMAND, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new InputError(`\`${AUDIT_COMMAND}\` did not run: ${result.error.message}`); // prettier-ignore
  if (result.status !== 0 && result.status !== 1) {
    throw new InputError(`\`${AUDIT_COMMAND}\` exited ${result.status}: ${(result.stderr ?? '').trim()}`); // prettier-ignore
  }
  if (!result.stdout || result.stdout.trim() === '') {
    throw new InputError(`\`${AUDIT_COMMAND}\` printed no report`);
  }
  return result.stdout;
}

/**
 * The red lines for a verdict, one per finding.
 * @param {ReturnType<typeof judge>} verdict
 * @returns {string[]}
 */
function redLines(verdict) {
  return [
    ...verdict.unlisted.map(
      (r) => `✗ ${r.id} (${r.packages.join(', ')}; ${r.severity}) is not on the ignore list: ${r.title} — ${r.url}`, // prettier-ignore
    ),
    ...verdict.stale.map(
      (e) => `✗ ignore-list entry ${e.id} (${e.package}) is stale: the audit no longer reports it at high or critical — delete the entry`, // prettier-ignore
    ),
    ...verdict.expired.map(
      (e) => `✗ ignore-list entry ${e.id} (${e.package}) held through ${e.until} and has expired — re-check the advisory and renew or delete the entry`, // prettier-ignore
    ),
    ...verdict.mismatched.map(
      ({ entry, root }) => `✗ ignore-list entry ${entry.id} names package ${entry.package}, but the audit files it against ${root.packages.join(', ')} — correct the entry`, // prettier-ignore
    ),
    ...verdict.fixable.map(
      ({ entry, root }) => `✗ ignore-list entry ${entry.id} (${entry.package}): a fix is available for ${root.fixPackages.join(', ')} — refresh the lockfile; the entry goes once the advisory is no longer reported at high or critical`, // prettier-ignore
    ),
  ];
}

/**
 * The gate: hold the list to its shape, read the audit, judge, and print. Any
 * error the run meets ends on the machinery verdict (exit 2), never an uncaught
 * exception.
 * @param {object} [seams]
 * @param {() => string} [seams.audit] returns the audit's standard output
 * @param {string} [seams.today] the current calendar day, YYYY-MM-DD (UTC)
 * @param {Array<object>} [seams.list] the ignore list
 * @param {(line: string) => void} [seams.out] the green line's sink
 * @param {(line: string) => void} [seams.err] the red lines' sink
 * @returns {0 | 1 | 2} the exit code
 */
export function main({
  audit = runAudit,
  today = new Date().toISOString().slice(0, 10),
  list = IGNORED_ADVISORIES,
  out = console.log,
  err = console.error,
} = {}) {
  let report;
  let verdict;
  try {
    checkList(list);
    report = readReport(audit());
    verdict = judge({ roots: report.roots, list, today });
  } catch (error) {
    const what =
      error instanceof InputError
        ? `an input this check reads answered with something other than what it reads there`
        : `the check met an error it does not model`;
    err(
      `✗ ${what}:\n` +
        `    ${error?.message ?? String(error)}\n\n` +
        `  The advisories and the ignore list are judged only from a report and a list this\n` +
        `  check could read whole, so this is not a clean bill. Exit 2 keeps that apart from\n` +
        `  an advisory the gate holds (exit 1).\n`,
    );
    return 2;
  }
  const lines = redLines(verdict);
  if (lines.length > 0) {
    for (const line of lines) err(line);
    err(
      `\nThe ignore list is IGNORED_ADVISORIES in scripts/check-npm-advisories.js: each entry ` +
        `names one advisory with its reason and the last day it holds.`,
    );
    return 1;
  }
  const n = report.roots.size;
  const ignored = verdict.ignored.map((e) => `${e.id} holds through ${e.until}`).join(', ');
  out(
    n === 0
      ? `✓ npm audit reported no high or critical advisory over the root lockfile, and the ignore list is empty.` // prettier-ignore
      : `✓ npm audit reported ${n} high or critical root advisor${n === 1 ? 'y' : 'ies'} across ` +
          `${report.vulnerableCount} vulnerable package(s); every one is on the ignore list and ` +
          `holds today (ignored: ${ignored}).`,
  );
  return 0;
}

/* c8 ignore start -- CLI wrapper: main() and its seams are unit-tested in
 * packages/shared/tests/unit; this glue runs the real audit and exits. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
/* c8 ignore stop */
