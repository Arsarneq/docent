/**
 * check-clause-governance.js — every repository path a clause row cites (in its
 * `check-ref` or `justification`) must be GOVERNED BY the doc that states the
 * clause: the citing doc must appear in the cited file's governing set under the
 * area map ([`check-area-map.js`](./check-area-map.js) `resolveFile`).
 *
 * Why this exists: a clause points at the code that implements or guards it, but
 * nothing forced that code to owe the clause's doc a disposition line. So a diff
 * to the cited file could change what the clause stands on without ever priming
 * the doc that states the clause — the code and its governing doctrine drift
 * apart silently. This closes that gap: a citation is a governance edge, and this
 * check holds the edge true.
 *
 * The check is deliberately LOCKED IN BOTH DIRECTIONS against a fixed, justified
 * ALLOWLIST of the couplings left open on the record (below):
 *   - a NEW uncovered citation (a cited file whose governance omits the citing
 *     doc, not on the allowlist) is red — the coupling must be closed (declare
 *     the file's governance, add a `// see` pointer, or record it here with a
 *     reason);
 *   - a STALE allowlist entry (an allowlisted coupling that now resolves) is red
 *     too — the exception is no longer needed and must be removed, so the
 *     allowlist cannot rot into a silent blanket.
 *
 * Governance here is exactly `resolveFile(path).docs` (area membership,
 * declared-governance, and `// see` pointers) — repo-wide docs are NOT credited,
 * because a repo-wide doc takes a disposition line only when itself edited, so it
 * does not couple a cited file to the clause's doc on a normal diff.
 *
 * This checks the governance edge only — whether a cited file *should* implement
 * or guard the clause, and whether a justification is adequate, is judged in
 * review, never here.
 *
 * Usage:
 *   node scripts/check-clause-governance.js    # or: npm run lint:clause-governance
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileMap, resolveFile } from './check-area-map.js';

/** Repo-relative path of the map whose resolution this check reads. */
export const MAP_PATH = 'scripts/area-map.json';
/** Repo-relative path of the clause registry this check reads. */
export const REGISTRY_PATH = 'docs/clause-registry.json';

/**
 * A repository-path token: an optional directory prefix then a filename with an
 * extension. Directory-less (`README.md`) and `dist/*`-shaped tokens included —
 * the same extraction the review-time citation sweep used.
 */
const PATH_RE = /(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.*{},[\]]+\.[A-Za-z0-9]+/g;

/**
 * Couplings deliberately left open, each keyed `"<clause>\t<path>"`. Every entry
 * carries the recorded reason it is not an edge this check should force closed.
 * Three adjudicated classes (2026-07-17):
 *   1. Verification scripts (`sufficiency-lint.js`, `corpus-compare.js`) that
 *      implement or preserve a clause's contract. Their OWN governing docs
 *      restate the contract with clause cites, and the registry rows couple
 *      clause↔script by name; a `// see` pointer would drag the format area's
 *      whole bundle onto every lint/comparator diff. The maintainer's recorded
 *      call is to leave these open.
 *   2. Cited implementation or util files whose clause is verified elsewhere —
 *      the citation names the site for orientation, not a per-file governance
 *      edge. Each entry's reason states where the verification actually lives:
 *      a registered guard suite that carries the doc, or — when the clause's
 *      doc is repo-wide — the repo-wide "line only when itself edited" rule
 *      plus the end-to-end checks.
 *   3. The format-authority echo surfaces — the root README and the docs index
 *      carry the session-format ordering clause's echo; the intended
 *      consistency check for those echoes is tracked separately.
 */
export const ALLOWLIST = new Map([
  // Class 1 — verification scripts (declined coupling; maintainer's open call).
  [
    'CP-2\tscripts/corpus-compare.js',
    'corpus comparator preserves the capture-completeness contract; governed by the corpus doctrine that cites it by name',
  ],
  [
    'CP-11\tscripts/corpus-compare.js',
    'corpus comparator preserves the masking contract; governed by the corpus doctrine that cites it by name',
  ],
  [
    'CP-11\tscripts/sufficiency-lint.js',
    'sufficiency lint enforces the masking predicate; governed by the sufficiency-lint doc that cites it',
  ],
  [
    'LR-5\tscripts/sufficiency-lint.js',
    'sufficiency lint enforces the locator predicate; governed by the sufficiency-lint doc that cites it',
  ],
  [
    'LR-24\tscripts/sufficiency-lint.js',
    'sufficiency lint enforces the locator predicate; governed by the sufficiency-lint doc that cites it',
  ],
  [
    'SF-10\tscripts/sufficiency-lint.js',
    'sufficiency lint enforces a normative-field predicate; governed by the sufficiency-lint doc that cites it',
  ],
  [
    'ECP-8\tscripts/corpus-compare.js',
    'corpus comparator preserves the extension capture-completeness contract; governed by the corpus doctrine that cites it',
  ],
  [
    'ECP-9\tscripts/sufficiency-lint.js',
    'sufficiency lint enforces the extension sufficiency predicate; governed by the sufficiency-lint doc that cites it',
  ],
  [
    'DCP-11\tscripts/sufficiency-lint.js',
    'sufficiency lint enforces the desktop sufficiency predicate; governed by the sufficiency-lint doc that cites it',
  ],
  // Class 2 — cited implementation/util sites; verification lives elsewhere.
  [
    'CP-11\tpackages/shared/lib/field-sensitivity.js',
    "the shared masking-detection util CP-11 names; CP-11's system-capture doc is repo-wide, so it takes a disposition line only when itself edited (as for every capture file), and the masking is verified per-diff by the corpus redaction sessions and the util's own unit test",
  ],
  [
    'DI-3\tpackages/shared/lib/format-stamp.js',
    "the stamp-source implementation DI-3 names; DI-3's wrapper contract is asserted per-diff by the contract, dispatch, and export test suites that carry the dispatch doc, and this file is exercised by the schema-composition suites — the citation names the site, not a per-file governance edge",
  ],
  // Class 3 — format-authority echo surfaces (intended consistency check tracked separately).
  [
    'SF-1\tdocs/README.md',
    'the docs index echoes the session-format ordering clause; the echo-surface consistency check is tracked separately',
  ],
  [
    'SF-1\tREADME.md',
    'the root README echoes the session-format ordering clause; the echo-surface consistency check is tracked separately',
  ],
]);

/**
 * Extract the tracked repository paths a clause row cites, deduplicated.
 * @param {object} row a clause-registry row
 * @param {Set<string>} tracked git-tracked repo-relative paths
 * @returns {string[]} cited tracked paths, unique, in first-seen order
 */
export function citedPaths(row, tracked) {
  const text = [row['check-ref'], row.justification].filter(Boolean).join(' ');
  const out = [];
  const seen = new Set();
  for (const tok of text.match(PATH_RE) ?? []) {
    if (seen.has(tok) || !tracked.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Pure core: audit clause citations against the map's governance.
 * @param {object} opts
 * @param {any} opts.registry parsed clause-registry.json
 * @param {any} opts.map parsed area-map.json
 * @param {string[]} opts.files git-tracked repo-relative paths
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable)
 * @param {Map<string,string>} [opts.allowlist] override (tests); defaults to ALLOWLIST
 * @returns {{ citations: number, newMisses: string[], staleAllowlist: string[] }}
 *   newMisses: `"<clause> (<doc>) -> <path>"` for uncovered, non-allowlisted citations
 *   staleAllowlist: allowlist keys whose coupling now resolves (or whose citation is gone)
 */
export function auditClauseGovernance({ registry, map, files, readFile, allowlist = ALLOWLIST }) {
  const compiled = compileMap(map);
  const tracked = new Set(files);
  const contentCache = new Map();
  const contentOf = (p) => {
    if (!contentCache.has(p)) contentCache.set(p, readFile(p));
    return contentCache.get(p);
  };

  let citations = 0;
  const newMisses = [];
  const hitAllow = new Set();
  for (const row of registry.clauses ?? []) {
    for (const path of citedPaths(row, tracked)) {
      citations++;
      const governing = new Set(resolveFile(path, compiled, contentOf(path)).docs);
      if (governing.has(row.doc)) continue;
      const key = `${row.clause}\t${path}`;
      if (allowlist.has(key)) {
        hitAllow.add(key);
      } else {
        newMisses.push(`${row.clause} (${row.doc}) -> ${path}`);
      }
    }
  }
  const staleAllowlist = [...allowlist.keys()].filter((k) => !hitAllow.has(k));
  return { citations, newMisses, staleAllowlist };
}

/* c8 ignore start — the CLI wrapper reads the registry, map, and git file list
   and formats the pass/fail output; the pure audit core above is unit-tested. */
function run() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const { citations, newMisses, staleAllowlist } = auditClauseGovernance({
    registry,
    map,
    files,
    readFile,
  });

  let failed = false;
  if (newMisses.length) {
    failed = true;
    console.error(
      `✗ ${REGISTRY_PATH} has clause citations the cited file's governance does not cover:\n` +
        newMisses.map((m) => `    ${m}`).join('\n') +
        `\n\n  Each names a file a clause cites whose governing docs omit the clause's doc.\n` +
        `  Close the edge — give the file a declared-governance entry or a \`// see\` pointer\n` +
        `  to the clause's doc in ${MAP_PATH} — or, if the coupling is deliberately left open,\n` +
        `  record it in the ALLOWLIST in scripts/check-clause-governance.js with its reason.\n`,
    );
  }
  if (staleAllowlist.length) {
    failed = true;
    console.error(
      `✗ scripts/check-clause-governance.js ALLOWLIST has stale entries (the coupling now resolves,\n` +
        `  or the citation is gone) — remove them so the allowlist stays honest:\n` +
        staleAllowlist.map((k) => `    ${k.replace(/\t/g, ' -> ')}`).join('\n') +
        '\n',
    );
  }
  if (failed) process.exit(1);
  console.log(
    `✓ clause citations governed: ${citations - ALLOWLIST.size} of ${citations} tracked cited ` +
      `path(s) resolve to the clause's doc; ${ALLOWLIST.size} recorded exception(s), none stale.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
