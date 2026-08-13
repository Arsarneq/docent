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
import {
  MAP_PATH,
  compileMap,
  expandBraces,
  globToRegExp,
  refuseOnShapeError,
  resolveFile,
} from './check-area-map.js';
import { splitCitationTokens } from './check-clause-registry.js';

/**
 * Repo-relative path of the map whose resolution this check reads — the map's
 * own constant, re-exported rather than restated, so the path this check names
 * in its output is the path it resolves against.
 */
export { MAP_PATH };
/** Repo-relative path of the clause registry this check reads. */
export const REGISTRY_PATH = 'docs/clause-registry.json';

/**
 * A repository-path token as a clause row cites one: an optional directory
 * prefix then a filename with an extension. Directory-less (`README.md`) and
 * `dist/*`-shaped tokens included — the same extraction the review-time
 * citation sweep used.
 *
 * Exported as the single home for the shape: this check reads it to find the
 * paths a row cites, and [`check-schema-echo.js`](./check-schema-echo.js)
 * reads it to find the surfaces the authority row enumerates. Both scan the
 * same rows, so the shape they admit is one decision, not two.
 *
 * [`check-clause-registry.js`](./check-clause-registry.js) scans those rows
 * too and deliberately does NOT read this shape: it GATES citations — every
 * token it admits must resolve against the tree or the build reds — while this
 * FINDER casts wide precisely because an over-collected token resolves to no
 * governance and costs nothing. Neither admission set contains the other: this
 * shape takes the separator-less dotted names that gate leaves unvalidated, and
 * that gate takes trailing-slash directory citations, `npm run` targets, and
 * lock ordinals this shape has no form for.
 *
 * A citation naming files by PATTERN is read by three surfaces, each stating
 * the same split. This finder and that gate both RESOLVE a separator-carrying
 * pattern against the tracked set — every file it names becomes a governance
 * edge here, and there it must name at least one tracked file — which is why
 * the DIRECTORY segments below admit the pattern characters: a mid-path glob
 * reads whole, instead of being read from the last glob-free boundary as a
 * shorter path than the text names. [`check-schema-echo.js`](./check-schema-echo.js),
 * which reads this shape to enumerate the surfaces one row registers, REFUSES
 * a pattern by design — it matches surfaces one literal path at a time against
 * a register, and a set of files is not something that register answers. The
 * SEPARATOR-LESS pattern (`*.test.js`) is the residue of all three: outside
 * that gate's path shape, left unexpanded here, and refused there only in the
 * shape that reaches for Markdown — one naming no Markdown at all is outside
 * that leg entirely, since the row cites other files for other reasons.
 *
 * Because those directory segments admit the brace-alternation characters, a
 * lone comma reaches this shape too, and an unspaced `a/x.js,b/y.js` matches as
 * ONE token. A comma between two citations is a separator, while a comma inside
 * a brace alternation belongs to the pattern — the rule the gate already
 * states, whose one implementation
 * ([`check-clause-registry.js`](./check-clause-registry.js)'s
 * `splitCitationTokens`) every reader of this shape applies before it resolves
 * anything, so the three cannot disagree about how many citations a text makes.
 * What the directory segments deliberately do NOT admit is the bracket
 * characters: the map's pattern language is closed at `*`, `**`, and brace
 * alternation, so a bracket buys no pattern there and would only weld a
 * Markdown link's label to the path that follows it — `[docs/x.md](docs/x.md)`
 * read as one token that then misreports as a refused pattern.
 *
 * Two purposes, two shapes; this stays the single home of the finder shape, and
 * that check's header records the same split from its side.
 */
export const CITED_PATH_RE = /(?:[A-Za-z0-9_\-.*{},]+\/)*[A-Za-z0-9_\-.*{},[\]]+\.[A-Za-z0-9]+/g;

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
 *   3. The format-authority echo surfaces whose area-supplied governance
 *      does not already include the format doc (the other registered
 *      surfaces resolve to it and need no entry). The echo itself is held
 *      by the schema-echo check, which reads each of them, so what stays
 *      open here is only the governance edge, for the reason each entry
 *      states: a repo-wide doc, which this check does not credit as
 *      governance, or a doc whose areas supply other governing docs.
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
    'CP-2\tpackages/extension/tests/e2e/specs/side-effect-capture.spec.js',
    "an extension end-to-end negative CP-2 names as its stream-level coverage; CP-2's system-capture doc is repo-wide, so it takes a disposition line only when itself edited (as for every capture file), and this spec is governed — and so primed on any edit — by the extension capture doc and the e2e suite doc that inventory it",
  ],
  [
    'CP-2\tpackages/extension/tests/e2e/specs/interactions.spec.js',
    "an extension end-to-end negative CP-2 names as its stream-level coverage; CP-2's system-capture doc is repo-wide, so it takes a disposition line only when itself edited (as for every capture file), and this spec is governed — and so primed on any edit — by the extension capture doc and the e2e suite doc that inventory it",
  ],
  [
    'CP-2\tpackages/extension/tests/e2e/specs/keyboard.spec.js',
    "an extension end-to-end negative CP-2 names as its stream-level coverage; CP-2's system-capture doc is repo-wide, so it takes a disposition line only when itself edited (as for every capture file), and this spec is governed — and so primed on any edit — by the extension capture doc and the e2e suite doc that inventory it",
  ],
  [
    'CP-2\tpackages/extension/tests/e2e/specs/navigation.spec.js',
    "an extension end-to-end negative CP-2 names as its stream-level coverage; CP-2's system-capture doc is repo-wide, so it takes a disposition line only when itself edited (as for every capture file), and this spec is governed — and so primed on any edit — by the extension capture doc and the e2e suite doc that inventory it",
  ],
  [
    'DI-3\tpackages/shared/lib/format-stamp.js',
    "the stamp-source implementation DI-3 names; DI-3's wrapper contract is asserted per-diff by the contract, dispatch, and export test suites that carry the dispatch doc, and this file is exercised by the schema-composition suites — the citation names the site, not a per-file governance edge",
  ],
  // Class 3 — format-authority echo surfaces. Each echoes the session-format
  // ordering clause and is held by the schema-echo check; what stays open is
  // only the governance edge, for the reason each entry states.
  [
    'SF-1\tdocs/README.md',
    'the docs index echoes the session-format ordering clause, and the schema-echo check holds that echo; the edge stays open because a repo-wide doc is not credited as governance, and the index takes a disposition line only when itself edited',
  ],
  [
    'SF-1\tREADME.md',
    'the root README echoes the session-format ordering clause, and the schema-echo check holds that echo; the edge stays open because a repo-wide doc is not credited as governance, and the README takes a disposition line only when itself edited',
  ],
  [
    'SF-1\tdocs/api/sync-protocol.md',
    'the sync protocol defers the step structure to the schemas, echoing the ordering clause; the schema-echo check holds that echo, and the protocol doc is governed by the areas that own the protocol rather than by the format doc it defers to',
  ],
  [
    'SF-1\treference-implementations/sync-server/README.md',
    'the reference server index defers the payload shape to the schemas, echoing the ordering clause; the schema-echo check holds that echo, and the file is governed by the sync area’s docs rather than by the format doc it defers to (it is also a runnable example artifact, never shipped)',
  ],
]);

/** What makes a cited token name a set of files rather than one. */
const PATTERN_CHAR_RE = /[*{}]/;

/**
 * The tracked files a pattern token names, expanded and compiled through the
 * map's own helpers so a citation is read exactly as an ownership pattern is.
 * A pattern the compiler refuses names nothing — the citation gate is where an
 * unusable pattern reds; here it simply contributes no edge.
 * @param {string} token a separator-carrying pattern token
 * @param {string[]} files git-tracked repo-relative paths
 * @returns {string[]} the tracked files it names, in tracked order
 */
function expandPattern(token, files) {
  let compiled;
  try {
    compiled = expandBraces(token).map((expanded) => globToRegExp(expanded));
  } catch {
    return [];
  }
  return files.filter((f) => compiled.some((re) => re.test(f)));
}

/**
 * Extract the citations a clause row makes, deduplicated by the token as
 * written and split on the commas that separate two citations written without
 * a space ({@link splitCitationTokens}, the gate's one home for that rule):
 * a literal token names the one tracked file it is, and a
 * separator-carrying pattern names every tracked file it expands to, so a
 * mid-path glob contributes an edge per match rather than none. A
 * SEPARATOR-LESS pattern is left unexpanded — it is the residue this check
 * shares with its siblings, stated in {@link CITED_PATH_RE}'s header. A token
 * that names no tracked file at all — an untracked literal, an uncompilable
 * pattern, a pattern matching nothing — is no citation here, the same silence
 * an untracked path has always had: resolvability is the citation gate's to
 * red on.
 * @param {object} row a clause-registry row
 * @param {Set<string>} tracked git-tracked repo-relative paths
 * @param {string[]} [files] the same set in tracked order, for pattern expansion
 * @returns {{ token: string, paths: string[], pattern: boolean }[]} one entry
 *   per cited token, in first-seen order
 */
export function citedPaths(row, tracked, files = [...tracked]) {
  const text = [row['check-ref'], row.justification].filter(Boolean).join(' ');
  const out = [];
  const seen = new Set();
  for (const raw of text.match(CITED_PATH_RE) ?? []) {
    // The directory segments admit a comma, so an unspaced `a/x.js,b/y.js`
    // arrives as one token; splitting it here — through the gate's own
    // implementation of the rule — is what keeps the second citation from
    // vanishing into the first, while a comma inside a brace alternation stays
    // with the pattern it belongs to.
    for (const part of splitCitationTokens(raw)) {
      // An asterisk run at the token's LEADING edge is Markdown emphasis, not a
      // pattern — now that the directory segments admit pattern characters, the
      // run would otherwise be read as part of the first segment and the whole
      // citation lost. The gate reads emphasis the same way, from its side.
      const tok = part.replace(/^\*+/, '');
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      if (!PATTERN_CHAR_RE.test(tok)) {
        if (tracked.has(tok)) out.push({ token: tok, paths: [tok], pattern: false });
        continue;
      }
      if (!tok.includes('/')) continue;
      const paths = expandPattern(tok, files);
      if (paths.length) out.push({ token: tok, paths, pattern: true });
    }
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
 * @returns {{ citations: number, exempted: number, newMisses: string[], staleAllowlist: string[] }}
 *   citations: cited TOKENS, so a pattern counts once however many files it names
 *   exempted: the tokens among them carrying at least one allowlisted file — counted in the
 *     same unit, so `citations - exempted` is the tokens that resolve on their own governance
 *     and the summary can state covered, total, and exceptions without arithmetic that lies
 *   newMisses: `"<clause> (<doc>) -> <path>"` for uncovered, non-allowlisted citations —
 *     one line per pattern token, naming the pattern and the files under it that are uncovered
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
  let exempted = 0;
  const newMisses = [];
  const hitAllow = new Set();
  for (const row of registry.clauses ?? []) {
    // One citation is one cited TOKEN: a pattern names a set, and reporting it
    // file by file would turn a single citation into a wall of findings that
    // all say the same thing. The allowlist stays keyed by the file it records
    // an open coupling for, so an exception inside a pattern's set is honoured
    // without exempting the rest of the set.
    for (const citation of citedPaths(row, tracked, files)) {
      citations++;
      const uncovered = [];
      let leansOnAllowlist = false;
      for (const path of citation.paths) {
        const governing = new Set(resolveFile(path, compiled, contentOf(path)).docs);
        if (governing.has(row.doc)) continue;
        const key = `${row.clause}\t${path}`;
        if (allowlist.has(key)) {
          hitAllow.add(key);
          leansOnAllowlist = true;
        } else uncovered.push(path);
      }
      // A token that leans on a recorded exception for any of its files is not
      // one that resolves on its own governance, so it is counted apart rather
      // than folded into the covered total.
      if (leansOnAllowlist) exempted++;
      if (!uncovered.length) continue;
      newMisses.push(
        citation.pattern
          ? `${row.clause} (${row.doc}) -> ${citation.token} (uncovered: ${uncovered.join(', ')})`
          : `${row.clause} (${row.doc}) -> ${uncovered[0]}`,
      );
    }
  }
  const staleAllowlist = [...allowlist.keys()].filter((k) => !hitAllow.has(k));
  return { citations, exempted, newMisses, staleAllowlist };
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

  let audited;
  try {
    audited = auditClauseGovernance({ registry, map, files, readFile });
  } catch (err) {
    // A map that no longer fits the shape this check reads it through is a
    // refusal on the check's own input: the red is that named verdict, printed
    // as the refusal states it on the ordinary red path — never a stack trace.
    refuseOnShapeError(err);
  }
  const { citations, exempted, newMisses, staleAllowlist } = audited;

  let failed = false;
  if (newMisses.length) {
    failed = true;
    console.error(
      `✗ ${REGISTRY_PATH} has clause citations the cited file's governance does not cover:\n` +
        newMisses.map((m) => `    ${m}`).join('\n') +
        `\n\n  Each names a citation whose governing docs omit the clause's doc, in one of two\n` +
        `  shapes: a single-file finding names the one file the clause cites, and a pattern\n` +
        `  finding names the pattern the clause cites and, after it, the files under that\n` +
        `  pattern left uncovered — the rest of its set already resolves or is recorded.\n` +
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
  // A pattern token counts as ONE citation here, however many tracked files it
  // names — the same unit the findings above are reported in, and the unit both
  // numbers below are counted in: the exempted tokens are the ones leaning on a
  // recorded exception, so they are subtracted rather than claimed as resolving.
  console.log(
    `✓ clause citations governed: ${citations - exempted} of ${citations} cited token(s) resolve ` +
      `to the clause's doc, a pattern counting once for the set it names; ` +
      `${exempted} carry a recorded exception, out of ${ALLOWLIST.size} recorded, none stale.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
