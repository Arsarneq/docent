/**
 * check-test-inventory.js — the test-suite documents' inventories describe the
 * suites as they are, the coverage plumbing's hand-maintained file lists
 * identify real sources, the registered suites are the ones this repository
 * really selects, no test binary sits where the pipeline that runs the suite
 * cannot see it, and the mutation kill sets and the mutate scope name test
 * files and modules the tree really carries. The closures, all committed data
 * that can rot:
 *
 *   (a) suite tables — each suite document devotes a named section to the
 *       tables whose first column enumerates the suite's test files. That
 *       column and the suite's own members are held in one-to-one agreement: a
 *       member with no row is red, a row naming a non-member is red, and a
 *       member carrying two rows is red. Membership is decided per suite by the
 *       discovery rule its entry registers below, which mirrors whatever
 *       actually selects that suite's tests here. Selection is the line, not
 *       execution — a selected test that some CI run then skips is still a
 *       member.
 *   (b) coverage lists — every entry of the registered hand-maintained
 *       `TRACKED_FILES` lists (the extension e2e and desktop integration
 *       coverage plumbing) identifies one tracked source file: the path the
 *       entry converts against, together with the URL suffix the suite matches
 *       on where the entry carries one, since an entry whose two halves name
 *       different files collects nothing while looking well-formed.
 *   (c) suite registration, for the one class an admission test can state: a
 *       suite selected with `node --test` from a script of an ADMITTED
 *       manifest — the root `package.json` plus every `package.json` tracked
 *       under `packages/`. Every such invocation resolves against the
 *       directory of the manifest that carries it and must land inside a
 *       registered suite: a glob's directory is the `dir` of exactly one
 *       registered entry whose descriptor states the same basename pattern,
 *       and a literal argument is a member invocation of a registered
 *       directory, selected by that entry's own rule. In the other direction a
 *       registered node-test entry stays live only while some admitted script
 *       still names its glob; a literal member invocation confers no liveness.
 *       The admission rule is what a reader derives the boundary from; the
 *       recorded rationale for drawing it there is the test area's charter —
 *       these documents cover Docent's own suites, not the runnable example
 *       artifacts beside them (docs/test/README.md).
 *   (d) discovery admission, over the tree and the crate manifest the cargo
 *       entry's suite lives in: an undiscovered test binary — one Cargo runs
 *       under local `cargo test` while CI's discovery never sees it — by
 *       either route: the directory form `tests/<name>/main.rs`, or a crate
 *       manifest stating the test targets itself, in any spelling Cargo reads
 *       as that statement (a `[[test]]` stanza, the same array written as a
 *       root-table `test = [ … ]` value, or a `[package]` `autotests` key)
 *       — is refused by name, each route carrying its own fix.
 *       Top-level-only selection is deliberate doctrine; the surfaces that
 *       state or hold it are named by the desktop Rust suite document's
 *       binaries paragraph (docs/test/desktop-rust.md), and this leg is what
 *       holds the tree and the manifest to it, so a binary introduced either
 *       way cannot run on a developer's machine and be absent from CI with
 *       nothing red anywhere. A nested non-`main.rs` file stays green: it is
 *       shared module code — the `tests/common/mod.rs` convention — which runs
 *       nowhere on its own. Benches and examples are outside the class: a
 *       widened lint builds them, and no test run selects them.
 *   (e) mutation kill sets — the test lists the weekly mutation run
 *       executes, held for STALENESS: every file argument of the JavaScript
 *       configurations' command lists identifies a tracked test file, or, where
 *       the argument is a glob, selects at least one; and every binary the
 *       cargo-mutants configuration's `--test` entries name — in either
 *       spelling Cargo reads as that selection — is reachable by one of the two
 *       routes a test binary lives at. Beside them the mutate scope, held on
 *       both its surfaces: the set that cargo configuration states and the
 *       module table the mutation-strategy document states name the same
 *       modules, in both directions and neither one twice, and each module the
 *       configuration states is a source the tree carries. Which files a kill
 *       set OUGHT to list is not held here — see the remainder below.
 *
 * Why the always-on `lint` job: the diff that stales a suite inventory is
 * frequently docs-only, and a docs-only PR skips every path-filtered test job.
 * A guard living in one of those jobs would be skipped by exactly the change it
 * exists to catch, so this one runs on every pull request.
 *
 * Extraction is deliberately structural rather than textual. Suite names are
 * read from parsed table rows in the document section that makes the
 * enumeration claim, so prose elsewhere — `e2e.md` names `corpus/corpus.spec.js`,
 * which lives outside the documented directory — is never mistaken for an
 * inventory entry, and a name inside a fenced code block is never read as a
 * row. The `TRACKED_FILES` entries are read from a tokenized scan of the array
 * literal, so reformatting a list cannot change what this check sees. The
 * registration closure reads manifest scripts, the workflow step that discovers
 * the Rust binaries, and the browser-driven suites' default configurations the
 * same way. The discovery admission reads the tracked-file list for its path
 * route, and the crate manifest for its declaration route through a scan that
 * drops commented text first and tracks the table each line sits in, so a
 * declaration a comment holds is never read as a live one and a `test` key in
 * `[features]` is the feature it is. The kill sets are read the same way on
 * both sides: the JavaScript list through the tokenizer, as the property array
 * its configuration states, and the command it joins to through the one reader
 * that already models a `node --test` invocation; the Rust list through the
 * same comment-dropping, table-aware manifest scan, paired flag to target in
 * either spelling Cargo accepts for the pairing.
 * Every way any of it can fail to reach its
 * whole subject — a renamed section or column, a relocated or renamed list, an
 * element form or a surrounding expression this reader does not model, a
 * manifest that will not parse or will not read at all, a renamed workflow
 * step, a configuration whose directory this reader cannot resolve — is itself
 * red: a check that silently reads part of a surface, or none of it, would
 * pass forever.
 *
 * What this check deliberately cannot see: whether a row's DESCRIPTION is still
 * true (it compares names, never prose); the two directions of the coverage
 * lists that are not entry-shaped — a source file the suites load that no list
 * names (the deliberate subset stated in docs/test/strategy/coverage.md), and
 * an entry naming a tracked source the suites never load, which is well-formed
 * here and simply collects nothing; and a coverage list that exists but is
 * named in TRACKED_LISTS below by no entry is outside this gate until it is
 * registered there, which a new list's change has to do for itself. The same
 * holds one closure further on: WHICH test files a mutation kill set lists is a
 * curation nothing here decides — the lists are curated subsets of their
 * packages' suites, closure (e) holds only that what they name is there, and a
 * suite that never joins a kill set is invisible to every leg of this check.
 * Closure (c)
 * leaves a named remainder open too, because no admission test here states it:
 * which cargo-run and browser-driven suites must be registered (their
 * membership rules are held above, their registration is hand-held — the corpus
 * spec tree is the live example of a Playwright suite in no entry); the
 * `node --test` invocations that reach the runner from somewhere other than an
 * admitted manifest script, namely the workflow's own inline steps and the
 * mutation configurations' per-file lists — those lists' ENTRIES are held for
 * staleness by closure (e), while the invocations carrying them stay
 * unregistered here, so the lists remain part of this remainder; and the
 * manifests the admission rule does not admit.
 *
 * Usage:
 *   node scripts/check-test-inventory.js      # or: npm run lint:test-inventory
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Playwright's default `testMatch` — the files it collects under its `testDir`,
 * at any depth. Both browser-driven suites leave that default in place.
 */
const PLAYWRIGHT_TEST_FILE = /(^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/;

/** The runner each discovery descriptor names, one constant per selecting form. */
export const RUNNERS = {
  node: 'node --test',
  cargo: 'cargo',
  playwright: 'playwright',
};

/** The last segment of a repo-relative path (the whole path when it has one segment). */
function basename(path) {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Everything before a path's last segment, `''` when it has only one. */
function dirname(path) {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/** A literal string as a regular-expression source, every metacharacter escaped. */
const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Collapse a joined path's `.` and `..` segments into the repo-relative form
 * the tracked-file list spells, so a directory written `./specs` from its
 * configuration and one written `specs` compare equal.
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  const out = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * The anchored pattern a basename glob selects: `*` stands for any run of
 * characters within one path segment, so a glob written for the top of a
 * directory never reaches a file one level deeper. Only `*` is modelled —
 * every other character is matched literally, the separator included, so a
 * multi-segment pattern is held segment for segment against a whole path.
 * @param {string} pattern a glob, e.g. `*.test.js` or `src/capture/*.rs`
 * @returns {RegExp}
 */
export function basenameGlobToRegExp(pattern) {
  const body = pattern.split('*').map(escapeForRegExp).join('[^/]*');
  return new RegExp(`^${body}$`);
}

/**
 * The membership rule a discovery descriptor states — the one place a
 * registered entry's `selects` comes from, so the rule the check demands a row
 * for and the invocation it is read against can never be stated twice:
 *
 *   - `node --test` selects the files a basename glob matches at the top of the
 *     suite directory (the runner expands the glob; a file one level deeper is
 *     not a member).
 *   - `cargo` selects one test binary per file the CI layer-discovery step's
 *     glob matches at the top of `tests/`. Top-level-only is deliberate, and
 *     the routes past it — the directory form `tests/<name>/main.rs`, and the
 *     crate manifest the descriptor's `manifest` names stating the test targets
 *     itself — are refused by the discovery-admission leg below, so the rule
 *     tracks the pipeline and the tree is held to the same line. Widening the
 *     discovery to Cargo's own capability is a deliberate change; which
 *     surfaces it must move is not this comment's to state — the desktop Rust
 *     suite document's binaries paragraph (docs/test/desktop-rust.md) is where
 *     that rule and its surfaces live, and this descriptor is one of them.
 *   - `playwright` selects Playwright's own default `testMatch` under the
 *     configured `testDir`, at any depth.
 *
 * @param {{ runner: string, pattern?: string, glob?: string }} discovery
 * @returns {(name: string) => boolean}
 */
export function selectsFor(discovery) {
  if (discovery.runner === RUNNERS.playwright) return (name) => PLAYWRIGHT_TEST_FILE.test(name);
  const pattern = discovery.runner === RUNNERS.cargo ? basename(discovery.glob) : discovery.pattern;
  const re = basenameGlobToRegExp(pattern);
  return (name) => !name.includes('/') && re.test(name);
}

/**
 * An entry as the audits read it: the registration plus, where it states a
 * discovery descriptor, the membership rule that descriptor states. An entry
 * stating none keeps no `selects`, so it reaches the registration closure's
 * refusal by name rather than failing where it is built.
 * @param {object} entry a registration as it is written below
 * @returns {object} the entry the audits read
 */
export const registered = (entry) =>
  entry.discovery ? { ...entry, selects: selectsFor(entry.discovery) } : { ...entry };

/**
 * The suite documents and the suites they enumerate. `section` is the `##`
 * heading whose tables make the enumeration claim and `column` their first
 * header cell — together they identify the inventory tables, so a table added
 * elsewhere in the document is free to name whatever it documents, and several
 * suites may share one document, each taking its own section. `dir` is the
 * directory the suite lives in, and `discovery` states how this repository
 * selects that suite's tests: `selects` is derived from it (see
 * {@link selectsFor}), so what the check demands a row for is what gets
 * selected, and the registration closure reads the same descriptor against the
 * invocation itself. A member is named in the table by its path from `dir`.
 */
export const DOC_INVENTORIES = [
  registered({
    doc: 'docs/test/e2e.md',
    section: 'What the suite covers',
    column: 'Spec',
    dir: 'packages/extension/tests/e2e/specs',
    discovery: { runner: RUNNERS.playwright, workdir: 'packages/extension/tests/e2e' },
  }),
  registered({
    doc: 'docs/test/desktop-rust.md',
    section: 'Suite layout',
    column: 'Test file',
    dir: 'packages/desktop/src-tauri/tests',
    discovery: {
      runner: RUNNERS.cargo,
      workflow: '.github/workflows/test.yml',
      step: 'Discover Rust test layers',
      glob: 'tests/*.rs',
      manifest: 'packages/desktop/src-tauri/Cargo.toml',
    },
  }),
  registered({
    doc: 'docs/test/integration/desktop.md',
    section: 'What the suite covers',
    column: 'Spec',
    dir: 'packages/desktop/tests/integration',
    discovery: { runner: RUNNERS.playwright, workdir: 'packages/desktop/tests/integration' },
  }),
  registered({
    doc: 'docs/test/unit.md',
    section: 'Shared modules',
    column: 'Test file',
    dir: 'packages/shared/tests/unit',
    discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
  }),
  registered({
    doc: 'docs/test/unit.md',
    section: 'Desktop application',
    column: 'Test file',
    dir: 'packages/desktop/tests/unit',
    discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
  }),
  registered({
    doc: 'docs/test/unit.md',
    section: 'Chrome extension',
    column: 'Test file',
    dir: 'packages/extension/tests/unit',
    discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
  }),
];

/**
 * The hand-maintained coverage file lists. `root` is the directory each entry
 * is written relative to. A list whose entries are objects names the property
 * carrying the source path (`pathField`) and, where the entry also carries the
 * served-URL suffix the suite matches on, the property carrying it
 * (`matchField`); a list of plain strings names neither.
 */
export const TRACKED_LISTS = [
  {
    file: 'packages/desktop/tests/integration/coverage-fixture.js',
    name: 'TRACKED_FILES',
    root: 'packages/desktop/src',
  },
  {
    file: 'packages/extension/tests/e2e/global-teardown.js',
    name: 'TRACKED_FILES',
    root: 'packages/extension',
    pathField: 'src',
    matchField: 'match',
  },
];

/* ── Markdown tables ─────────────────────────────────────────────────────── */

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const DELIMITER_CELL_RE = /^:?-+:?$/;
const BACKTICKED_NAME_RE = /^`([^`]+)`$/;

const isRow = (line) => typeof line === 'string' && line.trim().startsWith('|');

/**
 * Split one table line into trimmed cells. The outer pipes are structural; an
 * escaped `\|` inside a cell is content, not a separator.
 * @param {string} line
 * @returns {string[]}
 */
export function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const isDelimiterRow = (line) => {
  if (!isRow(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL_RE.test(cell));
};

/**
 * Parse the tables out of a Markdown document, each tagged with the `##`
 * section it sits in (deeper headings stay inside their section; a `#` heading
 * starts document-level text again). A table is a header row followed by a
 * delimiter row and the body rows after it; fenced content is blanked first
 * (via {@link stripFences} — the one fence model), so a table-shaped example
 * inside a fence is never read as one.
 * @param {string} markdown
 * @returns {{ section: string | null, header: string[], rows: string[][] }[]}
 */
export function parseTables(markdown) {
  const lines = stripFences(markdown).split('\n');
  const tables = [];
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (level === 2) section = headingMatch[2];
      else if (level < 2) section = null;
      continue;
    }
    if (!isRow(line) || !isDelimiterRow(lines[i + 1])) continue;
    const header = splitRow(line);
    const rows = [];
    let j = i + 2;
    while (j < lines.length && isRow(lines[j])) rows.push(splitRow(lines[j++]));
    tables.push({ section, header, rows });
    i = j - 1;
  }
  return tables;
}

/**
 * The file name a table's first cell names: exactly one backticked token and
 * nothing else. Null when the cell is not a bare file name.
 * @param {string} cell
 * @returns {string | null}
 */
export function backtickedName(cell) {
  const match = BACKTICKED_NAME_RE.exec((cell ?? '').trim());
  return match ? match[1] : null;
}

/**
 * Report the elements of `a` missing from `b`, one problem line per name —
 * the both-way set-diff wording model the surface checks share.
 * @param {string[]} a names present here…
 * @param {string[]} b …must each be present here
 * @param {string} where description of the gap
 * @returns {string[]} problem lines
 */
export function missingFrom(a, b, where) {
  const bSet = new Set(b);
  return [...new Set(a)].filter((x) => !bSet.has(x)).map((x) => `\`${x}\` ${where}`);
}

/**
 * Report duplicate names within one extracted list — the one drift the
 * deduplicating set diffs above cannot see.
 * @param {string[]} names an extracted name list
 * @param {string} what description of the surface
 * @returns {string[]} problem lines
 */
export function duplicatesIn(names, what) {
  const seen = new Set();
  const dup = new Set();
  for (const n of names) (seen.has(n) ? dup : seen).add(n);
  return [...dup].map((n) => `\`${n}\` appears more than once in ${what}`);
}

/**
 * Blank out fenced code blocks (``` or ~~~, each closed by its own marker),
 * preserving newlines, so a marker, heading, table, or token inside an
 * illustrative fence is never read as live doc text. This is the same fence
 * model `parseTables` applies internally — exported so every doc-scanning
 * check agrees on what a fence is.
 * @param {string} markdown
 * @returns {string} the text with fence lines and fenced content blanked
 */
export function stripFences(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  return lines
    .map((line) => {
      const open = FENCE_RE.exec(line);
      if (open) {
        if (fence === null) fence = open[1];
        else if (line.trim().startsWith(fence)) fence = null;
        return '';
      }
      return fence !== null ? '' : line;
    })
    .join('\n');
}

/**
 * Slice a doc's text to one clause's scope: from its bolded marker
 * (`**ID.**`) to the next clause marker or heading — the scope rule the
 * clause-bearing docs state. Fences are stripped first (via
 * {@link stripFences}), so fenced examples can neither anchor nor truncate
 * the slice.
 * @param {string} markdown the doc's text
 * @param {string} clauseId a clause id, e.g. 'DSH-1'
 * @returns {string} the clause's text, or '' when the marker is absent
 */
export function extractClauseSection(markdown, clauseId) {
  const defenced = stripFences(markdown);
  const marker = `**${clauseId}.**`;
  const start = defenced.indexOf(marker);
  if (start === -1) return '';
  const rest = defenced.slice(start + marker.length);
  const end = rest.search(/\n#{1,6}\s|\*\*[A-Z][A-Z0-9]*-[1-9][0-9]*\.\*\*/);
  return end === -1 ? defenced.slice(start) : defenced.slice(start, start + marker.length + end);
}

/* ── JavaScript array literals ───────────────────────────────────────────── */

const WORD_CHAR_RE = /[A-Za-z0-9_$]/;
const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * Tokenize JavaScript source far enough to read a data literal out of it:
 * quoted strings (quote style and escapes honoured), template literals,
 * identifier-ish words, and single punctuation characters. Comments and
 * whitespace are dropped, so a commented-out or documented occurrence of a name
 * is never mistaken for the declaration.
 *
 * A template literal is modelled as its own token type. Its text arrives as
 * `template` tokens carrying flat string values — one per run of literal text,
 * so a `string` token is always a quoted literal — and each `${…}`
 * interpolation's contents are tokenized as the code they are, in source order
 * between the template tokens either side of them. Interpolation nesting is
 * tracked by brace depth, so a brace written inside an interpolation closes
 * what it opened, the `${` and `}` delimiters themselves never reach the
 * stream, and a nested template's text is text rather than code. A reader that
 * accepts a `string` token therefore accepts a quoted literal and nothing else,
 * and one that wants to name a template in a refusal has its flat value to
 * print.
 * @param {string} source
 * @returns {{ type: 'word' | 'string' | 'template' | 'punct', value: string }[]}
 */
export function tokenizeJs(source) {
  const tokens = [];
  // One entry per open `${…}` interpolation, each holding the brace depth
  // reached inside it. A `}` whose entry stands at zero closes the
  // interpolation and resumes its template's text; any other brace is ordinary
  // punctuation that moves the depth.
  const interpolations = [];
  let i = 0;
  /**
   * Consume a run of template text from `at`, emit it as one `template` token,
   * and answer the index just past whatever ended the run: the closing
   * backtick, the `${` that opens an interpolation (pushed on the stack), or
   * the end of an unterminated literal.
   * @param {number} at index of the run's first character
   * @returns {number}
   */
  const readTemplateText = (at) => {
    let value = '';
    let k = at;
    while (k < source.length) {
      const ch = source[k];
      if (ch === '\\') {
        value += source[k + 1] ?? '';
        k += 2;
        continue;
      }
      if (ch === '`') {
        k++;
        break;
      }
      if (ch === '$' && source[k + 1] === '{') {
        interpolations.push(0);
        k += 2;
        break;
      }
      value += ch;
      k++;
    }
    tokens.push({ type: 'template', value });
    return k;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '`') {
      i = readTemplateText(i + 1);
      continue;
    }
    if (interpolations.length > 0 && (ch === '{' || ch === '}')) {
      const open = interpolations.length - 1;
      if (ch === '}' && interpolations[open] === 0) {
        interpolations.pop();
        i = readTemplateText(i + 1);
        continue;
      }
      interpolations[open] += ch === '{' ? 1 : -1;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let value = '';
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
        } else {
          value += source[i++];
        }
      }
      i++; // closing quote (or end of source, on an unterminated literal)
      tokens.push({ type: 'string', value });
      continue;
    }
    if (WORD_CHAR_RE.test(ch)) {
      let value = '';
      while (i < source.length && WORD_CHAR_RE.test(source[i])) value += source[i++];
      tokens.push({ type: 'word', value });
      continue;
    }
    if (!/\s/.test(ch)) tokens.push({ type: 'punct', value: ch });
    i++;
  }
  return tokens;
}

/**
 * Read whether the token at `at` is a string literal standing alone as the
 * whole value — the question every scan asks at a value position, over one
 * token window: the literal itself, and then the punctuation that proves
 * nothing was built around it. `followers` is that proof, spelled as the
 * characters the caller accepts, so `'a' + b` is refused rather than credited
 * with its leading piece.
 *
 * The answer is facts, never a verdict and never a message. Each caller keeps
 * its own refusal text, its own order of precedence among the facts, and its
 * own rendering of a stream that ran out: `token` and `follower` are `null`
 * exactly where there is no such token, which is what a caller that
 * distinguishes truncation keys on. The candidate's token KIND travels with
 * the rest, so a caller naming a template literal as a template reads it from
 * this answer rather than reaching back into the stream beside the call — a
 * template's flat value is a run of its literal text, which is what a refusal
 * that printed the token alone would state as the whole argument.
 *
 * Who reads a value position without this helper, and why. The emit-site scan
 * and the mock's serviced-case scan ask the same question with regular
 * expressions — one over Rust text, one over raw JavaScript text — so neither
 * holds a token stream to hand it. The whole-expression pair asks a different
 * question over a different window: what follows a list literal's own closing
 * bracket, rather than what follows a value inside it, and its two copies
 * deliberately accept different followers because one reads a standalone
 * declaration and the other a property inside a literal.
 * @param {{ type: string, value: string }[]} tokens the token stream
 * @param {number} at index of the candidate value token
 * @param {string} followers the punctuation characters that prove the literal
 *   lone (`',)'` for a call argument, `',}'` inside an object literal)
 * @returns {{ lone: boolean, value: string | null, token: string | null,
 *   kind: string | null, isString: boolean, follower: string | null }} `lone`
 *   is true exactly when the token is a string literal and its follower is one
 *   of `followers`; `value` is the literal then and `null` otherwise; `kind` is
 *   the candidate token's own type, `null` where the stream carries no such
 *   token
 */
export function readLoneStringLiteral(tokens, at, followers) {
  const candidate = tokens[at];
  const next = tokens[at + 1];
  const isString = candidate?.type === 'string';
  const lone = isString && next?.type === 'punct' && followers.includes(next.value);
  return {
    lone,
    value: lone ? candidate.value : null,
    token: candidate ? candidate.value : null,
    kind: candidate ? candidate.type : null,
    isString,
    follower: next ? next.value : null,
  };
}

/**
 * Read the entries of the array literal assigned to `name`. With no `fields`,
 * the entries are the array's own string elements; with them, each element is
 * an object literal and the entry is a record of those properties. The whole
 * literal is read or none of it is: an element this reader does not model, a
 * literal that never closes, a literal embedded in a larger expression, a
 * record missing a requested property, and an empty result each return an
 * `error`, so a list that moved, was renamed, or was restructured fails loudly
 * instead of passing on the part that still parses. Inside a record that
 * totality is scoped to the REQUESTED properties: each one's value must be a
 * string the separator or the closing brace follows, so a value assembled from
 * an expression is refused rather than recorded as its leading string, while a
 * property nobody asked for keeps whatever shape it likes.
 * @param {string} source JavaScript source text
 * @param {string} name the declared identifier
 * @param {string[] | null} [fields] properties to read from object elements
 * @returns {{ entries: (string | Record<string, string>)[] } | { error: string }}
 */
export function readListEntries(source, name, fields = null) {
  const tokens = tokenizeJs(source);
  let open = -1;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (
      tokens[i].type === 'word' &&
      tokens[i].value === name &&
      tokens[i + 1].type === 'punct' &&
      tokens[i + 1].value === '=' &&
      tokens[i + 2].type === 'punct' &&
      tokens[i + 2].value === '['
    ) {
      open = i + 2;
      break;
    }
  }
  if (open === -1) return { error: `no \`${name} = [...]\` array literal found` };
  const unreadable = (what) =>
    `the \`${name}\` array literal holds ${what}, which this reader does not model`;

  const entries = [];
  let record = null;
  let depth = 1;
  let i = open + 1;
  for (; i < tokens.length && depth > 0; i++) {
    const token = tokens[i];
    const isOpener = token.type === 'punct' && OPENERS.includes(token.value);
    const isCloser = token.type === 'punct' && CLOSERS.includes(token.value);
    if (isOpener) {
      if (depth === 1) {
        if (fields === null || token.value !== '{')
          return { error: unreadable(`\`${token.value}\``) };
        record = {};
      }
      depth++;
      continue;
    }
    if (isCloser) {
      depth--;
      if (depth === 1 && record !== null) {
        entries.push(record);
        record = null;
      }
      continue;
    }
    if (depth === 1) {
      // At the element level only the separator and, for a plain list, the
      // elements themselves are modelled — anything else (a spread, a variable,
      // a call) is an element form this reader would otherwise skip in silence.
      if (token.type === 'punct' && token.value === ',') continue;
      if (fields === null && token.type === 'string') {
        entries.push(token.value);
        continue;
      }
      // A template literal is named as one, the way a requested property's
      // value already is: its token value is a run of its literal text, so
      // printing the token alone would state an element the source never
      // writes — and an interpolated one, a name nothing can ever match.
      if (token.type === 'template') {
        return { error: unreadable(`a template literal (\`${token.value}\`)`) };
      }
      return { error: unreadable(`\`${token.value}\``) };
    }
    if (depth === 2 && record !== null && (token.type === 'string' || token.type === 'template')) {
      const key = tokens[i - 2];
      const colon = tokens[i - 1];
      if (
        colon?.type === 'punct' &&
        colon.value === ':' &&
        key?.type === 'word' &&
        fields.includes(key.value)
      ) {
        if (token.type === 'template') {
          // A template literal standing where a requested value goes is named
          // here: recording nothing would report the property missing from a
          // record that states it, which names a cause the source does not have.
          return {
            error: `the \`${name}\` array literal's \`${key.value}\` property is a template literal (\`${token.value}\`), and this reader reads a quoted string literal`,
          };
        }
        record[key.value] = token.value;
        // The value is the whole value: a requested property's string must be
        // followed by the separator or the record's closing brace. Anything
        // else — a concatenation, a call, a conditional — is an expression this
        // reader would otherwise record as its leading string, silently.
        const read = readLoneStringLiteral(tokens, i, ',}');
        if (!read.lone) {
          return {
            error: `the \`${name}\` array literal's \`${key.value}\` property is followed by \`${read.follower ?? 'end of source'}\`, so its value is not the string this reader read`,
          };
        }
      }
    }
  }
  if (depth > 0) return { error: `the \`${name}\` array literal is never closed` };
  const follower = tokens[i];
  if (follower && !(follower.type === 'punct' && follower.value === ';')) {
    return {
      error: `the \`${name}\` array literal is part of a larger expression, which this reader does not model`,
    };
  }
  if (entries.length === 0) return { error: `the \`${name}\` array literal holds no entries` };
  for (const entry of entries) {
    for (const field of fields ?? []) {
      if (!(field in entry))
        return { error: `an entry of \`${name}\` has no \`${field}\` property` };
    }
  }
  return { entries };
}

/**
 * Whether a coverage entry's two halves name one file: the suite keeps an entry
 * whose served URL ends in `/<match>` and reports it against the source at
 * `<path>`, so they agree exactly when that file's own URL — its path under the
 * served root — ends in `/<match>`. A `match` longer than the path it converts
 * therefore names a file the suite can never see, however plausible it reads.
 * @param {string} match the served-URL suffix the suite matches on
 * @param {string} path the source path it reports coverage against
 * @returns {boolean}
 */
export function identifiesSameFile(match, path) {
  return match === path || path.endsWith(`/${match}`);
}

/* ── The audit ───────────────────────────────────────────────────────────── */

/**
 * Pure core: audit the inventories against the tracked-file universe.
 * @param {object} opts
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable)
 * @param {typeof DOC_INVENTORIES} [opts.inventories]
 * @param {typeof TRACKED_LISTS} [opts.lists]
 * @returns {{ unreadable: string[], unparsed: string[], undocumented: string[],
 *             absent: string[], duplicated: string[], missingSource: string[],
 *             splitEntry: string[] }}
 */
export function auditInventories({
  files,
  readFile,
  inventories = DOC_INVENTORIES,
  lists = TRACKED_LISTS,
}) {
  const result = {
    unreadable: [],
    unparsed: [],
    undocumented: [],
    absent: [],
    duplicated: [],
    missingSource: [],
    splitEntry: [],
  };
  const tracked = new Set(files);

  for (const inventory of inventories) {
    const { doc, section, column, dir, selects } = inventory;
    // An entry stating no discovery descriptor derives no membership rule. The
    // registration closure is the one place that names that refusal, so this
    // audit passes the entry by rather than raising a second verdict on it —
    // or, reading it anyway, dying on the rule that is not there.
    if (typeof selects !== 'function') continue;
    const content = readFile(doc);
    if (content == null) {
      result.unreadable.push(`${doc}: inventory document could not be read`);
      continue;
    }
    const tables = parseTables(content).filter(
      (t) => t.section === section && t.header[0] === column,
    );
    if (tables.length === 0) {
      result.unparsed.push(
        `${doc}: no inventory table found (expected a table under "## ${section}" whose first column is headed "${column}")`,
      );
      continue;
    }
    const documented = new Set();
    for (const table of tables) {
      for (const row of table.rows) {
        const name = backtickedName(row[0]);
        if (name === null) {
          result.unparsed.push(
            `${doc}: inventory row first cell "${row[0]}" is not a single backticked file name`,
          );
          continue;
        }
        if (documented.has(name)) {
          result.duplicated.push(`${doc}: \`${name}\` has more than one row`);
        }
        documented.add(name);
      }
    }
    // The suite is the tracked files under `dir` its registered rule selects,
    // so the fixtures and configs beside them are helpers, not suite members.
    const prefix = `${dir}/`;
    const present = new Set(
      files
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .filter((name) => selects(name)),
    );
    for (const name of [...present].sort()) {
      if (!documented.has(name)) {
        result.undocumented.push(`${prefix}${name} is in the suite but has no row in ${doc}`);
      }
    }
    for (const name of [...documented].sort()) {
      if (!present.has(name)) {
        result.absent.push(
          `${doc} lists \`${name}\`, which is not a member of the suite in ${prefix}`,
        );
      }
    }
  }

  for (const list of lists) {
    const { file, name, root, pathField = null, matchField = null } = list;
    const source = readFile(file);
    if (source == null) {
      result.unreadable.push(`${file}: coverage list source could not be read`);
      continue;
    }
    const fields = pathField === null ? null : [pathField, ...(matchField ? [matchField] : [])];
    const read = readListEntries(source, name, fields);
    if (read.error) {
      result.unparsed.push(`${file}: ${read.error}`);
      continue;
    }
    for (const entry of read.entries) {
      const value = fields === null ? entry : entry[pathField];
      const path = `${root}/${value}`;
      if (!tracked.has(path)) {
        result.missingSource.push(
          `${file}: \`${name}\` entry "${value}" names ${path}, which is not a tracked file`,
        );
      }
      if (matchField !== null && !identifiesSameFile(entry[matchField], value)) {
        result.splitEntry.push(
          `${file}: \`${name}\` entry matches URLs ending "/${entry[matchField]}" but reports coverage against "${value}" — one entry, two files`,
        );
      }
    }
  }

  return result;
}

/* ── The registration closure ────────────────────────────────────────────── */

/**
 * The manifests the registration closure reads: the root `package.json` plus
 * every `package.json` tracked under `packages/`. That admission rule is the
 * closure's boundary, so it is stated once — here — and computed from the
 * tracked-file list rather than kept as a hand list that could go stale.
 * @param {string[]} files all git-tracked repo-relative paths
 * @returns {string[]} the admitted manifest paths, in tracked order
 */
export function admittedManifests(files) {
  return files.filter(
    (f) => f === 'package.json' || (f.startsWith('packages/') && f.endsWith('/package.json')),
  );
}

/** The command separators a script's segments are split on. */
const SEPARATORS = new Set(['&&', '||', ';', '|']);

/** The characters that make an argument or a listed entry a glob rather than one file. */
const GLOB_CHAR_RE = /[*?[\]]/;

/** The shell loop a workflow step discovers through, with the words it iterates. */
const FOR_LOOP_RE = /\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+([^;\n]+);\s*do\b/g;

/**
 * The arguments every `node --test` invocation in one script command states.
 * The command is read as whitespace-separated tokens: between `node` and
 * `--test` sit the runtime's own flags, which are skipped so a flagged
 * invocation is read rather than passed over, and everything from `--test` to
 * the next command separator is the runner's own. Four shapes are refused
 * rather than read: an invocation reached after a `cd`, whose arguments resolve
 * against a working directory this reader does not follow (a `cd` moves the
 * rest of the command, not just its own segment); one whose flag scan stops on
 * a non-flag token while a `--test` still stands later in the same segment —
 * a runtime flag's separate-token value, which this reader does not model and
 * would otherwise leave the whole invocation unread; one carrying a flag after
 * `--test`, whose separate-token value this reader would otherwise collect as a
 * path; and one stating no argument at all — what it selects is then the
 * runner's own default rather than a stated suite.
 * @param {string} command one manifest script's command line
 * @returns {{ args: string[] } | { error: string }}
 */
export function nodeTestArguments(command) {
  const tokens = command.split(/\s+/).filter(Boolean);
  const args = [];
  let relocated = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'cd') {
      relocated = true;
      continue;
    }
    if (tokens[i] !== 'node') continue;
    let at = i + 1;
    while (at < tokens.length && tokens[at] !== '--test' && tokens[at].startsWith('-')) at++;
    if (tokens[at] !== '--test') {
      // The scan stopped on a token that is not a flag. If `--test` still stands
      // later in this segment, that token is a runtime flag's separate-token
      // value: reading on would be guessing, and skipping the invocation would
      // drop a run suite in silence, so it is refused by name.
      let rest = at;
      while (rest < tokens.length && !SEPARATORS.has(tokens[rest]) && tokens[rest] !== '--test')
        rest++;
      if (tokens[rest] === '--test') {
        return {
          error: `runs \`node\` with \`${tokens[at]}\` before \`--test\`, which this reader does not model — a runtime flag's separate-token value, and reading past it would take that value for the suite's`,
        };
      }
      continue;
    }
    if (relocated) {
      return {
        error: 'runs `node --test` in a directory a `cd` moved, which this reader does not model',
      };
    }
    const collected = [];
    for (i = at + 1; i < tokens.length && !SEPARATORS.has(tokens[i]); i++) {
      if (tokens[i].startsWith('-')) {
        return {
          error: `runs \`node --test\` with the flag \`${tokens[i]}\`, which this reader does not model — a flag taking a separate token would leave that token read as a suite argument`,
        };
      }
      collected.push(tokens[i]);
    }
    i--;
    if (collected.length === 0) {
      return { error: 'runs `node --test` with no argument, so it states no suite' };
    }
    args.push(...collected);
  }
  return { args };
}

/**
 * What one resolved `node --test` argument names: a GLOB over a directory, or a
 * LITERAL member of one. A glob sitting in a directory segment selects across
 * directories, which no registered membership rule models, so it is refused.
 * @param {string} path a repo-relative path
 * @returns {{ kind: string, dir: string, pattern?: string, name?: string } | { error: string }}
 */
export function classifyArgument(path) {
  const dir = dirname(path);
  const name = basename(path);
  if (GLOB_CHAR_RE.test(dir)) {
    return { error: `globs across directories in \`${path}\`, which this reader does not model` };
  }
  return GLOB_CHAR_RE.test(name)
    ? { kind: 'glob', dir, pattern: name }
    : { kind: 'literal', dir, name };
}

/**
 * The body of one workflow step: from its `- name:` line to the next step at
 * the same indentation. Null when no step carries that name, so a renamed step
 * is a refusal rather than an empty read.
 * @param {string} workflow the workflow file's text
 * @param {string} stepName the step's `name:` value
 * @returns {string | null}
 */
export function extractStepBody(workflow, stepName) {
  const marker = `- name: ${stepName}`;
  const at = workflow.indexOf(marker);
  if (at === -1) return null;
  const lineStart = workflow.lastIndexOf('\n', at) + 1;
  const indent = workflow.slice(lineStart, at);
  if (/\S/.test(indent)) return null;
  const rest = workflow.slice(at + marker.length);
  const next = rest.search(new RegExp(`\\n${indent}- `));
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The words the shell `for` loops of a workflow step iterate over — the globs
 * that step discovers through.
 * @param {string} stepBody
 * @returns {string[]}
 */
export function extractLoopGlobs(stepBody) {
  const globs = [];
  for (const match of stepBody.matchAll(FOR_LOOP_RE)) globs.push(...match[1].trim().split(/\s+/));
  return globs;
}

/**
 * The token following each `<key>:` in a configuration source, read through the
 * same tokenizer the list reader uses, so a mention in a comment or a string is
 * never taken for a setting.
 * @param {string} source JavaScript source text
 * @param {string} key the property name
 * @returns {{ type: string, value: string }[]}
 */
export function configValues(source, key) {
  const tokens = tokenizeJs(source);
  const values = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (
      tokens[i].type === 'word' &&
      tokens[i].value === key &&
      tokens[i + 1].type === 'punct' &&
      tokens[i + 1].value === ':'
    ) {
      values.push(tokens[i + 2]);
    }
  }
  return values;
}

/**
 * Pure core: audit the registered suites' own registration against the surfaces
 * that select them. Its inputs are its own — the registered list, the tracked
 * files the admitted manifest set is computed from, and one reader for every
 * surface — so the inventory-agreement audit's entry contract is untouched by
 * anything decided here.
 *
 * The node-test class is closed in both directions (see the module header):
 * every glob and every literal argument of an admitted manifest script lands
 * inside a registered suite, and every registered node-test entry is still
 * named by one of those globs — a literal member invocation confers no
 * liveness, because a suite nothing globs is a suite nothing runs. The cargo
 * and Playwright entries are held to their mirror claims: the workflow step
 * still discovers through the registered glob, and each registered
 * browser-driven suite's working directory still reaches its default
 * configuration, whose `testDir` is the registered directory and whose
 * `testMatch` is unset. The cargo entry is held to one claim more — the
 * discovery admission over the tree and the crate manifest (see
 * {@link readCargoDiscoveryAdmission}), which is an admission test on what the
 * suite may contain rather than a mirror of what selects it. Which cargo-run
 * and browser-driven suites must be registered stays outside this closure.
 * @param {object} opts
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable)
 * @param {typeof DOC_INVENTORIES} [opts.inventories]
 * @returns {{ undescribed: string[], unregisteredSuite: string[], unregisteredMember: string[],
 *             patternMismatch: string[], deadRegistration: string[], mirrorDrift: string[],
 *             undiscoveredBinary: string[], unreadableClosure: string[] }}
 */
export function auditRegistrationClosure({ files, readFile, inventories = DOC_INVENTORIES }) {
  const result = {
    undescribed: [],
    unregisteredSuite: [],
    unregisteredMember: [],
    patternMismatch: [],
    deadRegistration: [],
    mirrorDrift: [],
    undiscoveredBinary: [],
    unreadableClosure: [],
  };
  const named = (entry) => `${entry.doc} ("## ${entry.section}")`;

  // A descriptor is required on every registered entry: it is what the closure
  // reads an entry through, so an entry without one is refused by name rather
  // than skipped into silence.
  const described = [];
  for (const entry of inventories) {
    if (entry.discovery) described.push(entry);
    else result.undescribed.push(`${named(entry)} registers ${entry.dir}/ with no discovery descriptor`); // prettier-ignore
  }
  const nodeEntries = described.filter((e) => e.discovery.runner === RUNNERS.node);
  const live = new Set();

  const manifests = admittedManifests(files);
  if (manifests.length === 0) {
    result.unreadableClosure.push(
      'no admitted manifest is tracked, so the registration closure has nothing to read',
    );
  }
  for (const manifest of manifests) {
    const source = readFile(manifest);
    if (source == null) {
      result.unreadableClosure.push(`${manifest}: admitted manifest could not be read`);
      continue;
    }
    let scripts;
    try {
      scripts = JSON.parse(source).scripts;
    } catch {
      result.unreadableClosure.push(`${manifest}: admitted manifest is not readable JSON`);
      continue;
    }
    if (scripts === null || typeof scripts !== 'object') {
      result.unreadableClosure.push(`${manifest}: admitted manifest states no \`scripts\` map`);
      continue;
    }
    const root = dirname(manifest);
    for (const [script, command] of Object.entries(scripts)) {
      if (typeof command !== 'string') {
        result.unreadableClosure.push(`${manifest}: script \`${script}\` is not a command string`);
        continue;
      }
      const read = nodeTestArguments(command);
      if (read.error) {
        result.unreadableClosure.push(`${manifest}: script \`${script}\` ${read.error}`);
        continue;
      }
      for (const arg of read.args) {
        // Arguments are the manifest's own: they resolve against the directory
        // of the manifest whose script states them, never against the root.
        const path = normalizePath(`${root}/${arg}`);
        const argument = classifyArgument(path);
        if (argument.error) {
          result.unreadableClosure.push(`${manifest}: script \`${script}\` ${argument.error}`);
          continue;
        }
        // A directory belongs to exactly one registered suite: no entry leaves
        // the invocation unregistered, and two leave it ambiguous — which entry
        // states the rule the argument is read against would then be an
        // accident of order.
        const matches = nodeEntries.filter((e) => e.dir === argument.dir);
        if (matches.length !== 1) {
          const registrars = matches.length === 0 ? 'no entry registers it' : `${matches.map(named).join(' and ')} both register it`; // prettier-ignore
          const target = argument.kind === 'glob' ? `over ${argument.dir}/` : `on ${path}, whose directory is ${argument.dir}/`; // prettier-ignore
          const bucket = argument.kind === 'glob' ? result.unregisteredSuite : result.unregisteredMember; // prettier-ignore
          bucket.push(`${manifest}: script \`${script}\` runs \`node --test\` ${target} — ${registrars}`); // prettier-ignore
          continue;
        }
        const entry = matches[0];
        if (argument.kind === 'glob') {
          live.add(entry.dir);
          if (entry.discovery.pattern !== argument.pattern) {
            result.patternMismatch.push(
              `${manifest}: script \`${script}\` selects \`${argument.pattern}\` in ${argument.dir}/, but ${named(entry)} registers \`${entry.discovery.pattern}\``,
            );
          }
          continue;
        }
        if (!entry.selects(argument.name)) {
          result.unregisteredMember.push(
            `${manifest}: script \`${script}\` runs \`node --test\` on ${path}, which the suite ${named(entry)} enumerates does not select`,
          );
        }
      }
    }
  }

  for (const entry of nodeEntries) {
    if (!live.has(entry.dir)) {
      result.deadRegistration.push(
        `${named(entry)} registers ${entry.dir}/, whose \`${entry.discovery.pattern}\` no admitted manifest script runs`,
      );
    }
  }

  for (const entry of described) {
    if (entry.discovery.runner === RUNNERS.cargo) {
      readCargoMirror(entry, readFile, named, result);
      readCargoDiscoveryAdmission(entry, files, readFile, named, result);
    } else if (entry.discovery.runner === RUNNERS.playwright) {
      readPlaywrightMirror(entry, readFile, named, result);
    }
  }

  return result;
}

/** The cargo entry's mirror claim: CI still discovers its binaries through the registered glob. */
function readCargoMirror(entry, readFile, named, result) {
  const { workflow, step, glob } = entry.discovery;
  const source = readFile(workflow);
  if (source == null) {
    result.unreadableClosure.push(`${workflow}: the workflow ${named(entry)} mirrors could not be read`); // prettier-ignore
    return;
  }
  const body = extractStepBody(source, step);
  if (body === null) {
    result.unreadableClosure.push(
      `${workflow}: no step is named "${step}", so the discovery ${named(entry)} mirrors is not where this reader looks for it`,
    );
    return;
  }
  const globs = extractLoopGlobs(body);
  if (globs.length === 0) {
    result.unreadableClosure.push(
      `${workflow}: the "${step}" step iterates over nothing this reader can read as a discovery glob`,
    );
    return;
  }
  if (globs.length !== 1 || globs[0] !== glob) {
    result.mirrorDrift.push(
      `${workflow}: the "${step}" step discovers \`${globs.join(' ')}\`, but ${named(entry)} registers \`${glob}\``,
    );
  }
}

/**
 * The ONE table each target-selecting key is Cargo's own in. The two are
 * disjoint, and each was read off Cargo rather than inferred from the other:
 * the `test` array of tables is a ROOT-table value (a `[package]` `test` draws
 * "unused manifest key: package.test" and builds no target), while
 * `autotests` is a `[package]` key (a root-table `autotests` draws "unused
 * manifest key: autotests" and changes no binary). The same key in the other
 * table is not Cargo's target selection, so it stays green.
 */
const TARGET_KEY_TABLES = { test: '', autotests: 'package' };

/**
 * The crate-manifest statements that make the manifest, rather than the
 * discovery step, the place deciding which test binaries exist: a `[[test]]`
 * stanza, the same array of tables written as a `test = [ … ]` value, and an
 * `autotests` key. Each is read in the table it sits in (see
 * {@link TARGET_KEY_TABLES}), so a `test` key inside `[features]` — or a key
 * an unrelated table happens to name `autotests` — is that table's own and
 * stays green. What a declared entry names is a target, not necessarily a
 * file elsewhere: an entry stating `path` puts its binary wherever that names,
 * while a path-less one resolves onto the conventional file for its name. What
 * every route shares is the deciding: the manifest states the target set that
 * a local `cargo test` then runs, so the path route alone would leave the
 * hazard open by the side door.
 */
const MANIFEST_ROUTES = [
  {
    matches: (read) => read.array === true && read.header === 'test',
    states: 'a `[[test]]` stanza, which names a test target explicitly',
  },
  {
    matches: (read, table) => read.key === 'test' && table === TARGET_KEY_TABLES.test,
    states:
      'a `test =` target array, the same declaration written as a value, naming its test targets explicitly',
  },
  {
    matches: (read, table) => read.key === 'autotests' && table === TARGET_KEY_TABLES.autotests,
    states: "an `autotests` key, which puts Cargo's own target selection in the manifest",
  },
];

/**
 * One manifest line's live text: a `#` outside a basic or literal string opens
 * a TOML comment, so a commented-out declaration is never read as a live one
 * and a `#` inside a value never truncates the line early. A multi-line
 * string's inner lines are read as lines of their own, which can only
 * over-report — the declarations this scan looks for are refusals, so its one
 * inaccuracy is a red a reader dismisses rather than a silent pass.
 * @param {string} line one line of a TOML manifest
 * @returns {string} the line's live text, trimmed
 */
export function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i).trim();
  }
  return line.trim();
}

/** A TOML key as written: the same key whether it is spelled bare or quoted. */
const unquoteTomlKey = (key) => {
  const text = key.trim();
  const quoted = /^"(.*)"$/.exec(text) ?? /^'(.*)'$/.exec(text);
  return quoted ? quoted[1] : text;
};

/**
 * The segments of a TOML dotted key, each unquoted. A `.` inside a quoted
 * segment belongs to that key rather than separating two, so `"a.b"` is one
 * segment and `package.autotests` is two.
 * @param {string} text a key or table name as written
 * @returns {string[]}
 */
function dottedKeySegments(text) {
  const segments = [];
  let current = '';
  let quote = null;
  for (const ch of text.trim()) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '.') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.map(unquoteTomlKey);
}

/**
 * One comment-stripped manifest line, read structurally: the table `header` it
 * opens (with `array` true for the `[[…]]` array-of-tables form), the `key` it
 * assigns together with the table `within` the current one that key's leading
 * dotted segments name, or null for a line that is neither. A quoted spelling
 * is the key TOML reads it as, so `[["test"]]` opens the same table as
 * `[[test]]`; a dotted key names its own table, so `package.autotests` written
 * at the root assigns `autotests` inside `[package]` exactly as the sectioned
 * spelling does.
 * @param {string} line one line's live text, as {@link stripTomlComment} returns it
 * @returns {{ header: string, array: boolean } | { key: string, within: string } | null}
 */
export function readTomlLine(line) {
  const arrayHeader = /^\[\[([^[\]]*)\]\]$/.exec(line);
  if (arrayHeader) return { header: dottedKeySegments(arrayHeader[1]).join('.'), array: true };
  const tableHeader = /^\[([^[\]]*)\]$/.exec(line);
  if (tableHeader) return { header: dottedKeySegments(tableHeader[1]).join('.'), array: false };
  const assignment = /^([^=]+?)\s*=/.exec(line);
  if (!assignment) return null;
  const segments = dottedKeySegments(assignment[1]);
  return { key: segments[segments.length - 1], within: segments.slice(0, -1).join('.') };
}

/**
 * The cargo entry's discovery admission: the tree and the crate manifest hold
 * no undiscovered test binary — one Cargo runs under local `cargo test` while
 * CI's discovery never sees it — by either route: the directory form
 * `tests/<name>/main.rs`, or the crate manifest stating the test targets
 * itself (see {@link MANIFEST_ROUTES}). The manifest is the descriptor's own —
 * the entry names the file it is held against, so the one place stating what
 * the registration covers stays the one place naming it. The path route reads
 * the tracked files exactly one level below the registered directory, which is
 * as deep as Cargo's own auto-discovery builds a binary: a nested non-`main.rs`
 * file is shared module code and a deeper `main.rs` is nothing, so both stay
 * green. Each red carries its own fix, because the routes are undone
 * differently; the alternative they share — widening the discovery on purpose
 * — is the report block's, and the surfaces such a widening moves are named by
 * the desktop Rust suite document's binaries paragraph
 * (docs/test/desktop-rust.md). An unreadable manifest is a refusal, never a
 * skip: this leg's whole subject is what that file states.
 */
function readCargoDiscoveryAdmission(entry, files, readFile, named, result) {
  const nested = new RegExp(`^${escapeForRegExp(entry.dir)}/[^/]+/main\\.rs$`);
  for (const file of files.filter((f) => nested.test(f))) {
    result.undiscoveredBinary.push(
      `${file}: Cargo builds this as a test binary, and the discovery ${named(entry)} registers never sees it — move it to a top-level \`.rs\` in ${entry.dir}/`,
    );
  }
  const manifest = entry.discovery.manifest;
  const source = readFile(manifest);
  if (source == null) {
    result.unreadableClosure.push(`${manifest}: the crate manifest the discovery admission for ${named(entry)} reads could not be read`); // prettier-ignore
    return;
  }
  // The scan is table-aware: a route's key is Cargo's own only in the table it
  // names, so the current `[table]` header travels with each line — extended,
  // for a dotted key, by the table its own leading segments name. A route
  // states itself once however many lines spell it — the fix is the same one.
  let table = '';
  const stated = new Set();
  for (const line of source.split(/\r?\n/).map(stripTomlComment)) {
    const read = readTomlLine(line);
    if (read === null) continue;
    if (read.header !== undefined) table = read.header;
    const at = read.within ? `${table ? `${table}.` : ''}${read.within}` : table;
    for (const route of MANIFEST_ROUTES) if (route.matches(read, at)) stated.add(route);
  }
  for (const route of MANIFEST_ROUTES) {
    if (!stated.has(route)) continue;
    result.undiscoveredBinary.push(
      `${manifest}: states ${route.states} — which test binaries exist is then this manifest's to decide rather than the discovery ${named(entry)} registers; drop it and let auto-discovery select a top-level \`.rs\` in ${entry.dir}/`,
    );
  }
}

/**
 * A Playwright entry's mirror claim: the registered working directory's `npm
 * test` still runs Playwright with no `--config`, so the configuration that
 * collects the suite is that directory's default one — and that configuration
 * still leaves `testMatch` at Playwright's default and points `testDir` at the
 * registered directory.
 */
function readPlaywrightMirror(entry, readFile, named, result) {
  const { workdir } = entry.discovery;
  const manifestPath = `${workdir}/package.json`;
  const manifestSource = readFile(manifestPath);
  if (manifestSource == null) {
    result.unreadableClosure.push(`${manifestPath}: working-directory manifest could not be read`);
    return;
  }
  let test;
  try {
    test = JSON.parse(manifestSource).scripts?.test;
  } catch {
    result.unreadableClosure.push(`${manifestPath}: working-directory manifest is not readable JSON`); // prettier-ignore
    return;
  }
  if (typeof test !== 'string' || !/\bplaywright\s+test\b/.test(test)) {
    result.unreadableClosure.push(
      `${manifestPath}: its \`test\` script does not run Playwright, so ${named(entry)}'s configuration cannot be identified from the invocation`,
    );
    return;
  }
  if (/(^|\s)--config(=|\s|$)/.test(test)) {
    result.mirrorDrift.push(
      `${manifestPath}: its \`test\` script now names a configuration explicitly, so the default configuration is no longer the one collecting the suite ${named(entry)} enumerates`,
    );
    return;
  }
  const configPath = `${workdir}/playwright.config.js`;
  const config = readFile(configPath);
  if (config == null) {
    result.unreadableClosure.push(`${configPath}: default configuration could not be read`);
    return;
  }
  if (configValues(config, 'testMatch').length > 0) {
    result.mirrorDrift.push(
      `${configPath}: states \`testMatch\`, but ${named(entry)} registers Playwright's default selection`,
    );
  }
  const dirs = configValues(config, 'testDir');
  if (dirs.length === 1 && dirs[0].type === 'template') {
    // Naming the template is the diagnosis: counting it among the unreadable
    // values would report a `testDir` the configuration states as one it does
    // not, which names a cause the source does not have.
    result.unreadableClosure.push(
      `${configPath}: states its \`testDir\` as a template literal (\`${dirs[0].value}\`), and this reader reads a quoted string literal, so the directory it collects cannot be read`,
    );
    return;
  }
  if (dirs.length !== 1 || dirs[0].type !== 'string') {
    result.unreadableClosure.push(
      `${configPath}: states ${dirs.length} readable \`testDir\` value(s), so the directory it collects cannot be read`,
    );
    return;
  }
  const resolved = normalizePath(`${workdir}/${dirs[0].value}`);
  if (resolved !== entry.dir) {
    result.mirrorDrift.push(
      `${configPath}: collects ${resolved}/, but ${named(entry)} registers ${entry.dir}/`,
    );
  }
}

/* ── The mutation kill sets ──────────────────────────────────────────────── */

/**
 * The JavaScript mutation configurations, discovered rather than listed: every
 * tracked file the `glob` names states its kill set as the `property` array,
 * so a configuration added beside them joins this closure by existing. The glob
 * is read exactly as the area map reads the identical pattern in its own
 * entries — `*` stays inside one path segment — so both surfaces name the same
 * set of files. The arguments in that array are repository-relative, which is
 * what the runner resolves them against: these configurations are run from the
 * repository root by the manifest scripts that name them.
 */
export const JS_KILL_SETS = { glob: 'stryker.*.mjs', property: 'command' };

/**
 * The Rust mutation kill set: the `flag` entries of the cargo-mutants
 * configuration's `key` list each name a test binary, which lives at either of
 * the two places Cargo builds one from — the file `<dir>/<name><suffix>`, or
 * the directory form `<dir>/<name>/<main>`. A target is resolved through both
 * routes and is red only when neither reaches it, so a binary that moved into a
 * directory of its own stays the live target it is.
 *
 * The two sides fail differently, which is why the JavaScript leg is the
 * primary one. `node --test` runs the paths it finds and reports nothing for
 * one that is not there (observed: an invocation naming a live file and a
 * missing one exits 0 and runs the live file alone), so a stale entry there
 * drops a whole file out of the weekly run in silence. Cargo refuses outright
 * (`error: no test target named …`, before it builds anything), so a stale
 * entry here reddens the weekly run rather than hiding — what this leg adds on
 * that side is the same finding at lint time, in the same shape as its
 * sibling's.
 */
export const RUST_KILL_SET = {
  config: 'packages/desktop/src-tauri/.cargo/mutants.toml',
  key: 'additional_cargo_test_args',
  flag: '--test',
  dir: 'packages/desktop/src-tauri/tests',
  suffix: '.rs',
  main: 'main.rs',
};

/**
 * The mutate scope, stated twice: as `key` in the cargo-mutants configuration,
 * and as the table under `column` inside `clause`'s scope in `doc`. The scope
 * is a curated enumeration — nothing derives it from a module's properties — so
 * the two statements of it are held to each other in both directions, neither
 * of them stating one module twice, and the document names each module exactly
 * as the configuration does. The entries are written against the crate, so
 * `root` is what they resolve under: each one is held to the tree there, since
 * two surfaces edited in step — or left stale in step — agree with each other
 * about a module that is no longer anywhere.
 */
export const MUTATE_SCOPE = {
  config: 'packages/desktop/src-tauri/.cargo/mutants.toml',
  key: 'examine_globs',
  root: 'packages/desktop/src-tauri',
  doc: 'docs/test/strategy/mutation.md',
  clause: 'MUT-3',
  column: 'Module',
};

/**
 * Read the string elements of the array literal one object property states —
 * the shape a mutation configuration's command list has, whose literal carries
 * a trailing `.join(…)`. The whole literal is read or none of it is, on the
 * same terms as {@link readListEntries}: an element this reader does not model,
 * a literal that never closes, an empty one, a property stated more than once
 * (which literal states the list would be an accident of order), and a trailing
 * expression other than the joining call each return an `error`. The joining
 * call is modelled because it does not change the set; any other call could.
 * @param {string} source JavaScript source text
 * @param {string} key the property name
 * @returns {{ entries: string[] } | { error: string }}
 */
export function readPropertyStringArray(source, key) {
  const tokens = tokenizeJs(source);
  const opens = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (
      tokens[i].type === 'word' &&
      tokens[i].value === key &&
      tokens[i + 1].type === 'punct' &&
      tokens[i + 1].value === ':' &&
      tokens[i + 2].type === 'punct' &&
      tokens[i + 2].value === '['
    ) {
      opens.push(i + 2);
    }
  }
  if (opens.length === 0) return { error: `no \`${key}: [...]\` array literal found` };
  if (opens.length > 1) {
    return {
      error: `states \`${key}: [...]\` ${opens.length} times, so which literal states the list cannot be read`,
    };
  }
  const entries = [];
  let depth = 1;
  let i = opens[0] + 1;
  for (; i < tokens.length && depth > 0; i++) {
    const token = tokens[i];
    if (token.type === 'punct' && OPENERS.includes(token.value)) {
      // Every element of this list is a string, so an opener names a nested
      // structure — an element form this reader would otherwise walk into and
      // read the strings out of, flattening what it found into the list.
      return {
        error: `the \`${key}\` array literal holds \`${token.value}\`, which this reader does not model`,
      };
    }
    if (token.type === 'punct' && CLOSERS.includes(token.value)) {
      depth--;
      continue;
    }
    if (token.type === 'punct' && token.value === ',') continue;
    if (token.type === 'string') {
      entries.push(token.value);
      continue;
    }
    return {
      error: `the \`${key}\` array literal holds \`${token.value}\`, which this reader does not model`,
    };
  }
  if (depth > 0) return { error: `the \`${key}\` array literal is never closed` };
  if (entries.length === 0) return { error: `the \`${key}\` array literal holds no entries` };
  // What follows the literal decides whether the entries ARE the list: the
  // joining call leaves the set alone, and anything else — a filter, a slice, a
  // concatenation — would make this reader's answer a part of the real one.
  const [dot, call, paren] = [tokens[i], tokens[i + 1], tokens[i + 2]];
  const joined =
    dot?.type === 'punct' &&
    dot.value === '.' &&
    call?.type === 'word' &&
    call.value === 'join' &&
    paren?.type === 'punct' &&
    paren.value === '(';
  const separator = dot?.type === 'punct' && [',', ';', '}', ')', ']'].includes(dot.value);
  if (!joined && !separator && dot !== undefined) {
    return {
      error: `the \`${key}\` array literal is followed by \`${dot.value}\`, so the entries this reader read are not the list the property states`,
    };
  }
  return { entries };
}

/**
 * Read the string values of a root-table TOML array — the shape both
 * cargo-mutants lists have. Comments are dropped and the table each line sits
 * in travels with it (as in {@link readCargoDiscoveryAdmission}), so a
 * commented-out list is never read as the live one and a same-named key inside
 * another table stays that table's. The array is read whole or not at all: a
 * missing assignment, a value that is not an array literal, an unterminated
 * string, a value form this reader does not model, an array that never closes,
 * and an empty one each return an `error`.
 * @param {string} source the manifest's text
 * @param {string} key the root-table key
 * @returns {{ values: string[] } | { error: string }}
 */
export function readTomlStringArray(source, key) {
  const lines = source.split(/\r?\n/).map(stripTomlComment);
  let table = '';
  let start = -1;
  for (let i = 0; i < lines.length && start === -1; i++) {
    const read = readTomlLine(lines[i]);
    if (read === null) continue;
    if (read.header !== undefined) {
      table = read.header;
      continue;
    }
    const at = read.within ? `${table ? `${table}.` : ''}${read.within}` : table;
    if (read.key === key && at === '') start = i;
  }
  if (start === -1) return { error: `no root-table \`${key} = [ … ]\` assignment found` };
  // TOML puts a value's first character on the assignment line, so the literal
  // this reader models is one opening there. Reading a scalar as a one-value
  // array would be exactly the silent partial read the check refuses.
  const head = lines[start].slice(lines[start].indexOf('=') + 1).trim();
  if (!head.startsWith('[')) {
    return {
      error: `\`${key}\` is assigned \`${head || 'nothing'}\`, which is not the array literal this reader models`,
    };
  }
  const text = [head, ...lines.slice(start + 1)].join('\n');
  const values = [];
  let depth = 0;
  let closed = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let value = '';
      i++;
      while (i < text.length && text[i] !== ch) {
        if (ch === '"' && text[i] === '\\') {
          value += text[i + 1] ?? '';
          i += 2;
        } else value += text[i++];
      }
      if (i >= text.length) return { error: `the \`${key}\` array holds an unterminated string` };
      i++;
      values.push(value);
      continue;
    }
    if (ch === '[') {
      depth++;
      // A nested array is a shape whose values this reader would otherwise
      // flatten into the list beside the ones the list itself states.
      if (depth > 1) {
        return { error: `the \`${key}\` array holds a nested array, which this reader does not model` }; // prettier-ignore
      }
      i++;
      continue;
    }
    if (ch === ']') {
      closed = true;
      break;
    }
    if (ch === ',' || /\s/.test(ch)) {
      i++;
      continue;
    }
    return { error: `the \`${key}\` array holds \`${ch}\`, which this reader does not model` };
  }
  if (!closed) return { error: `the \`${key}\` array is never closed` };
  if (values.length === 0) return { error: `the \`${key}\` array holds no values` };
  return { values };
}

/**
 * The targets a flag selects in a cargo test-argument list: each `flag` takes
 * the value after it, or carries that value joined to it by `=` — the two
 * spellings Cargo reads as the same selection, so a list is read whichever one
 * it uses. A valueless flag beside them is another option this leg does not
 * read. A non-flag value nobody's flag claimed is refused by name — it is a
 * flag's separate-token value, which would otherwise be read as a test target —
 * as is a `flag` with nothing after it in either spelling, and a list selecting
 * no target at all, which would leave this leg holding nothing.
 * @param {string[]} values the list's values, in order
 * @param {string} flag the selecting flag, e.g. `--test`
 * @returns {{ targets: string[] } | { error: string }}
 */
export function killSetTargets(values, flag) {
  const joined = `${flag}=`;
  const noTarget = (spelling) => ({
    error: `states \`${spelling}\` with no target after it, so which binary it names cannot be read`,
  });
  const targets = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === flag) {
      const target = values[i + 1];
      if (target === undefined || target.startsWith('-')) return noTarget(flag);
      targets.push(target);
      i++;
      continue;
    }
    if (value.startsWith(joined)) {
      // The joined spelling carries its own value, so nothing after it is
      // claimed — reading it as a flag would leave the target unread, and this
      // list's own option to skip would swallow it whole.
      const target = value.slice(joined.length);
      if (target === '') return noTarget(value);
      targets.push(target);
      continue;
    }
    if (value.startsWith('-')) continue;
    return { error: `states \`${value}\`, which this reader does not model — a flag's separate-token value would otherwise be read as a test target` }; // prettier-ignore
  }
  if (targets.length === 0) {
    return { error: `states no \`${flag}\` entry, so it names no test binary to hold` };
  }
  return { targets };
}

/**
 * The modules a document's mutate-scope table names, read through the clause's
 * own scope so a table elsewhere in the document names whatever it documents.
 * @param {string} markdown the document's text
 * @param {string} clause the clause whose scope carries the table
 * @param {string} column the table's first header cell
 * @returns {{ modules: string[] } | { error: string }}
 */
export function readScopeTable(markdown, clause, column) {
  const section = extractClauseSection(markdown, clause);
  if (section === '') return { error: `states no \`**${clause}.**\` marker, so the table this leg reads has no scope to sit in` }; // prettier-ignore
  const tables = parseTables(section).filter((t) => t.header[0] === column);
  if (tables.length === 0) {
    return { error: `states no table headed "${column}" inside §${clause}, where this leg reads the mutate scope` }; // prettier-ignore
  }
  const modules = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const name = backtickedName(row[0]);
      if (name === null) {
        return { error: `§${clause} states the scope row "${row[0]}", whose first cell is not a single backticked module path` }; // prettier-ignore
      }
      modules.push(name);
    }
  }
  return { modules };
}

/**
 * Pure core: audit the mutation kill sets and the mutate scope. Staleness only,
 * and deliberately so — the lists are curated subsets, and no surface states
 * which files belong in one, so what is held here is that every listed entry
 * identifies a file that exists. A test file no kill set names is invisible to
 * this audit by design, and the module header records that limit beside the
 * others.
 *
 * Every declared surface is read at its own path: the reads are memoized per
 * call, so two entries naming one file cost one read, and two entries naming
 * different files are two reads. Reusing a neighbouring entry's content would
 * let a refusal name a file this audit never opened, and let an agreement pass
 * on a list it never read.
 * @param {object} opts
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable)
 * @param {typeof JS_KILL_SETS} [opts.jsKillSets]
 * @param {typeof RUST_KILL_SET} [opts.rustKillSet]
 * @param {typeof MUTATE_SCOPE} [opts.mutateScope]
 * @returns {{ staleKillSetEntry: string[], mutateScopeDrift: string[],
 *             deadScopeModule: string[], unreadableKillSet: string[] }}
 */
export function auditMutationKillSets({
  files,
  readFile,
  jsKillSets = JS_KILL_SETS,
  rustKillSet = RUST_KILL_SET,
  mutateScope = MUTATE_SCOPE,
}) {
  const result = {
    staleKillSetEntry: [],
    mutateScopeDrift: [],
    deadScopeModule: [],
    unreadableKillSet: [],
  };
  const tracked = new Set(files);
  const sources = new Map();
  const readSource = (path) => {
    if (!sources.has(path)) sources.set(path, readFile(path));
    return sources.get(path);
  };

  const configPattern = basenameGlobToRegExp(jsKillSets.glob);
  const configs = files.filter((f) => configPattern.test(f));
  if (configs.length === 0) {
    result.unreadableKillSet.push(
      `no tracked file matches \`${jsKillSets.glob}\`, so the JavaScript kill sets this leg holds are not where it reads them`,
    );
  }
  for (const config of configs) {
    const source = readSource(config);
    if (source == null) {
      result.unreadableKillSet.push(`${config}: mutation configuration could not be read`);
      continue;
    }
    const read = readPropertyStringArray(source, jsKillSets.property);
    if (read.error) {
      result.unreadableKillSet.push(`${config}: ${read.error}`);
      continue;
    }
    // The list joins into the command the runner is given, so the arguments are
    // read through the one reader that models such an invocation.
    const invocation = nodeTestArguments(read.entries.join(' '));
    if (invocation.error) {
      result.unreadableKillSet.push(
        `${config}: its \`${jsKillSets.property}\` ${invocation.error}`,
      );
      continue;
    }
    if (invocation.args.length === 0) {
      result.unreadableKillSet.push(
        `${config}: its \`${jsKillSets.property}\` states no \`node --test\` invocation, so the kill set this leg holds is not where it reads it`,
      );
      continue;
    }
    for (const arg of invocation.args) {
      // An argument is a file or a glob over one directory, on the same terms
      // the registration closure reads a `node --test` argument: the runner
      // expands a glob, so holding one to identity would report a live entry as
      // a dead one, with an explanation that is not even true of it.
      const path = normalizePath(arg);
      const argument = classifyArgument(path);
      if (argument.error) {
        result.unreadableKillSet.push(
          `${config}: its \`${jsKillSets.property}\` ${argument.error}`,
        );
        continue;
      }
      if (argument.kind === 'glob') {
        const selects = basenameGlobToRegExp(argument.pattern);
        const selected = files.some(
          (f) => dirname(f) === argument.dir && selects.test(basename(f)),
        );
        if (!selected) {
          result.staleKillSetEntry.push(
            `${config}: \`${jsKillSets.property}\` states the glob ${path}, which selects no tracked file — the runner expands it against the tree, so the weekly mutation run takes no test from this entry`,
          );
        }
        continue;
      }
      if (!tracked.has(path)) {
        result.staleKillSetEntry.push(
          `${config}: \`${jsKillSets.property}\` names ${path}, which is not a tracked file — the weekly mutation run drops it in silence, since \`node --test\` runs the paths it finds and reports nothing for the one it does not`,
        );
      }
    }
  }

  const manifest = readSource(rustKillSet.config);
  if (manifest == null) {
    result.unreadableKillSet.push(
      `${rustKillSet.config}: the mutation configuration this leg reads could not be read`,
    );
  } else {
    const read = readTomlStringArray(manifest, rustKillSet.key);
    if (read.error) result.unreadableKillSet.push(`${rustKillSet.config}: ${read.error}`);
    else {
      const selected = killSetTargets(read.values, rustKillSet.flag);
      if (selected.error) {
        result.unreadableKillSet.push(
          `${rustKillSet.config}: \`${rustKillSet.key}\` ${selected.error}`,
        );
      } else {
        for (const target of selected.targets) {
          // Both routes Cargo builds a test binary from, because a target is
          // live at either: holding only the file route would call a binary
          // that moved into a directory of its own a target that is not there.
          const routes = [
            `${rustKillSet.dir}/${target}${rustKillSet.suffix}`,
            `${rustKillSet.dir}/${target}/${rustKillSet.main}`,
          ];
          if (!routes.some((path) => tracked.has(path))) {
            result.staleKillSetEntry.push(
              `${rustKillSet.config}: \`${rustKillSet.key}\` names \`${rustKillSet.flag} ${target}\`, which is no tracked binary at ${routes.join(' or at ')} — cargo refuses a target that is not there, so the weekly run fails on it; this names it at lint time instead`,
            );
          }
        }
      }
    }
  }

  const scopeSource = readSource(mutateScope.config);
  const docSource = readSource(mutateScope.doc);
  const scopeRead = scopeSource == null ? null : readTomlStringArray(scopeSource, mutateScope.key);
  if (scopeSource == null) {
    result.unreadableKillSet.push(
      `${mutateScope.config}: the mutate scope this leg reads could not be read`,
    );
  } else if (scopeRead.error) {
    result.unreadableKillSet.push(`${mutateScope.config}: ${scopeRead.error}`);
  }
  let stated = null;
  if (docSource == null) {
    result.unreadableKillSet.push(
      `${mutateScope.doc}: the document stating the mutate scope could not be read`,
    );
  } else {
    const table = readScopeTable(docSource, mutateScope.clause, mutateScope.column);
    if (table.error) result.unreadableKillSet.push(`${mutateScope.doc}: ${table.error}`);
    else stated = table.modules;
  }
  if (stated !== null && scopeRead?.values) {
    // Both statements of one curated set are read on the same terms, repeats
    // included: a repeat costs cargo nothing, but a set diff cannot see one,
    // and a scope that names a module twice is a scope one of its two surfaces
    // has been edited past.
    result.mutateScopeDrift.push(...duplicatesIn(stated, `${mutateScope.doc} §${mutateScope.clause}`)); // prettier-ignore
    result.mutateScopeDrift.push(...duplicatesIn(scopeRead.values, `\`${mutateScope.key}\` in ${mutateScope.config}`)); // prettier-ignore
    result.mutateScopeDrift.push(
      ...missingFrom(
        scopeRead.values,
        stated,
        `is in \`${mutateScope.key}\` in ${mutateScope.config} but has no row in ${mutateScope.doc} §${mutateScope.clause}`,
      ),
    );
    result.mutateScopeDrift.push(
      ...missingFrom(
        stated,
        scopeRead.values,
        `is a row of ${mutateScope.doc} §${mutateScope.clause} but is not in \`${mutateScope.key}\` in ${mutateScope.config}`,
      ),
    );
  }
  // The agreement above holds the two surfaces to each other; this holds the
  // set they agree on to the tree. A module deleted with both surfaces edited
  // in step — or left stale on both — is a scope they agree about and nothing
  // mutates, which no diff between them can see.
  for (const value of scopeRead?.values ?? []) {
    const surfaces =
      stated !== null && stated.includes(value)
        ? `both this configuration and ${mutateScope.doc} §${mutateScope.clause} state it`
        : 'this configuration states it';
    const path = `${mutateScope.root}/${value}`;
    if (GLOB_CHAR_RE.test(value)) {
      // A pattern entry names a set, so what it is held to is selecting one:
      // the red names the form it found rather than a path nobody wrote.
      const selects = basenameGlobToRegExp(path);
      if (!files.some((f) => selects.test(f))) {
        result.deadScopeModule.push(
          `${mutateScope.config}: \`${mutateScope.key}\` states the pattern ${value}, which selects no tracked source under ${mutateScope.root}/ — ${surfaces}`,
        );
      }
      continue;
    }
    if (!tracked.has(path)) {
      result.deadScopeModule.push(
        `${mutateScope.config}: \`${mutateScope.key}\` names ${value}, which is no tracked source at ${path} — ${surfaces}`,
      );
    }
  }

  return result;
}

/**
 * The red wording for each problem class an audit can report: what the class
 * says about the count it carries, and the fix. Keyed by the result field, so
 * a class the audit grows and this table has not learned is reported as itself
 * rather than dropped — the report is driven by the result, never by a
 * hand-kept list of the classes worth printing.
 */
const PROBLEM_BLOCKS = {
  unreadable: {
    heading: (n) => `${n} inventory source(s) could not be read`,
    fix: `repoint the moved file in DOC_INVENTORIES / TRACKED_LISTS in scripts/check-test-inventory.js.`,
  },
  unparsed: {
    heading: (n) => `${n} inventory source(s) could not be read as an inventory`,
    fix:
      `restore the shape the check reads — an inventory table in the documented section,\n` +
      `  its first column the documented header with one backticked file name per row, and a\n` +
      `  TRACKED_FILES array literal whose elements are string paths or object records carrying\n` +
      `  the named properties — or update scripts/check-test-inventory.js to the new shape.`,
  },
  undocumented: {
    heading: (n) => `${n} test file(s) are in a suite but in no document`,
    fix: `add a row for each to the suite document's coverage table, in the same change.`,
  },
  absent: {
    heading: (n) => `${n} documented test file(s) are not in the suite`,
    fix:
      `repoint each row at the file the suite now carries, or drop the row — the file\n` +
      `  was renamed, removed, or moved outside what this suite's rule selects.`,
  },
  duplicated: {
    heading: (n) => `${n} test file(s) have more than one inventory row`,
    fix: `keep one row per test file — the table is the suite's enumeration.`,
  },
  missingSource: {
    heading: (n) => `${n} coverage list entr(ies) name a file that is not tracked`,
    fix:
      `repoint each entry at the source file's current path, or remove it — an entry\n` +
      `  matching nothing collects no coverage and states a file that is not there.`,
  },
  splitEntry: {
    heading: (n) => `${n} coverage list entr(ies) name two different files`,
    fix:
      `give both halves of the entry the same file — the URL the suite matches and the\n` +
      `  source it converts against are one file, and a split entry silently collects nothing.`,
  },
  undescribed: {
    heading: (n) => `${n} registered suite entr(ies) state no discovery descriptor`,
    fix:
      `give the entry a \`discovery\` descriptor in DOC_INVENTORIES in\n` +
      `  scripts/check-test-inventory.js — it is what states how this repository selects the\n` +
      `  suite, and the entry's membership rule is derived from it.`,
  },
  unregisteredSuite: {
    heading: (n) => `${n} node-test suite(s) are run but registered by no single entry`,
    fix:
      `register the suite in DOC_INVENTORIES in scripts/check-test-inventory.js — a document\n` +
      `  section, the directory, and the descriptor stating the glob that selects it — and give\n` +
      `  that section an inventory table, or stop running the suite from an admitted manifest.\n` +
      `  One directory takes one entry: two entries over it leave the rule ambiguous.`,
  },
  unregisteredMember: {
    heading: (n) => `${n} node-test argument(s) name a file no registered suite selects`,
    fix:
      `point the argument at a file of a registered suite, or register the directory it\n` +
      `  names — a named file is a member invocation of a suite, never a suite of its own.`,
  },
  patternMismatch: {
    heading: (n) => `${n} discovery descriptor(s) no longer state what selects the suite`,
    fix:
      `bring the descriptor's pattern and the manifest script's glob back together — the\n` +
      `  descriptor is what decides which files this check demands a row for.`,
  },
  deadRegistration: {
    heading: (n) => `${n} registered node-test suite(s) are run by no admitted manifest script`,
    fix:
      `restore the script that runs the suite, or drop the entry — an entry naming a suite\n` +
      `  nothing runs documents a suite that is not there. A script naming one file of the\n` +
      `  suite is a member invocation and does not run the suite.`,
  },
  undiscoveredBinary: {
    heading: (n) => `${n} place(s) where the discovery step does not decide which test binaries exist`, // prettier-ignore
    fix:
      `each red above states its own fix, because the routes to an undiscovered binary\n` +
      `  are undone differently. The alternative they share is to widen the discovery on\n` +
      `  purpose, which moves every surface that states or holds the top-level-only rule —\n` +
      `  the desktop Rust suite document's binaries paragraph (docs/test/desktop-rust.md)\n` +
      `  is where that rule and those surfaces are named.`,
  },
  mirrorDrift: {
    heading: (n) => `${n} registered discovery claim(s) no longer match the surface they mirror`,
    fix:
      `repoint the entry's descriptor at what now selects the suite, or restore the surface —\n` +
      `  a membership rule that has drifted from its discovery lets a collected test sit with\n` +
      `  no row while this check stays green.`,
  },
  unreadableClosure: {
    heading: (n) => `${n} registration-closure source(s) could not be read as what they state`,
    fix:
      `restore the shape the closure reads — an admitted manifest whose \`scripts\` map holds\n` +
      `  command strings, a workflow step discovering through a shell loop under its registered\n` +
      `  name, and a browser-driven suite reached through its working directory's default\n` +
      `  configuration — or update scripts/check-test-inventory.js to the new shape.`,
  },
  staleKillSetEntry: {
    heading: (n) => `${n} mutation kill-set entr(ies) name no test file that is there`,
    fix:
      `repoint each entry at the file's current path, or remove the entry — a renamed or\n` +
      `  deleted test the list still names runs against no mutant, and which files a kill set\n` +
      `  lists is curated in the configuration itself, so neither repair is this check's to pick.`,
  },
  mutateScopeDrift: {
    heading: (n) => `${n} mutate-scope module(s) are stated by one surface and not the other, or stated twice by one`, // prettier-ignore
    fix:
      `state the scope the same way in both — the cargo-mutants configuration decides what is\n` +
      `  mutated, and the mutation-strategy document's table is what a reader is given; a module\n` +
      `  joins or leaves the scope in one edit to the two of them, and takes one place on each.`,
  },
  deadScopeModule: {
    heading: (n) => `${n} mutate-scope entr(ies) name no source the tree carries`,
    fix:
      `repoint each entry at the module's current path, or drop it from the scope — and drop\n` +
      `  the strategy document's row with it where it has one, since the two surfaces state one\n` +
      `  set. A module that is not there is mutated by nothing, so a scope still naming it\n` +
      `  reads as wider than the run it configures.`,
  },
  unreadableKillSet: {
    heading: (n) => `${n} mutation kill-set or mutate-scope source(s) could not be read as what they state`, // prettier-ignore
    fix:
      `restore the shape this closure reads — a mutation configuration stating its test list as\n` +
      `  the registered property's array of strings, a cargo-mutants manifest stating its lists\n` +
      `  as root-table arrays of strings, and the mutate-scope table under its registered heading\n` +
      `  inside its clause — or update scripts/check-test-inventory.js to the new shape.`,
  },
};

/**
 * Render an audit result as red output: one block per populated problem class,
 * each enumerating its exact mismatches and naming the fix.
 * @param {ReturnType<typeof auditInventories> | ReturnType<typeof auditRegistrationClosure>} result
 * @returns {string[]} problem blocks (empty when the inventories and the
 *   registration hold)
 */
export function formatProblems(result) {
  const list = (entries) => entries.map((e) => `    ${e}`).join('\n');
  const blocks = [];
  for (const [name, entries] of Object.entries(result)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const block = PROBLEM_BLOCKS[name];
    const heading = block
      ? block.heading(entries.length)
      : `${entries.length} problem(s) of class "${name}", which this report has no wording for`;
    const fix = block
      ? block.fix
      : `add a "${name}" entry to PROBLEM_BLOCKS in scripts/check-test-inventory.js.`;
    blocks.push(`✗ ${heading}:\n` + list(entries) + `\n\n  Fix: ${fix}`);
  }
  return blocks;
}

/* c8 ignore start — the CLI wrapper reads the tracked-file list from git and the
 * inventory sources from disk, then prints; the parsing and audit logic it
 * delegates to (parseTables, readListEntries, auditInventories,
 * auditRegistrationClosure, formatProblems) is unit-tested. */
function run() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const problems = [
    ...formatProblems(auditInventories({ files, readFile })),
    ...formatProblems(auditRegistrationClosure({ files, readFile })),
    ...formatProblems(auditMutationKillSets({ files, readFile })),
  ];
  if (problems.length) {
    console.error(problems.join('\n\n'));
    process.exit(1);
  }
  // The numbers come from the registered data, so they stay true as suites join
  // it — entries and the documents they are spread across are two counts now.
  const documents = new Set(DOC_INVENTORIES.map((inventory) => inventory.doc)).size;
  const globbed = DOC_INVENTORIES.filter((i) => i.discovery.runner === RUNNERS.node).length;
  const admitted = DOC_INVENTORIES.filter((i) => i.discovery.runner === RUNNERS.cargo).length;
  const jsPattern = basenameGlobToRegExp(JS_KILL_SETS.glob);
  const jsConfigs = files.filter((f) => jsPattern.test(f)).length;
  console.log(
    `✓ test inventories current: ${DOC_INVENTORIES.length} registered suite(s) across ` +
      `${documents} document(s) enumerate their suites exactly, ${TRACKED_LISTS.length} coverage ` +
      `list(s) identify tracked sources, ${globbed} node-test suite(s) are each run by an ` +
      `admitted manifest script, ${admitted} cargo suite(s) hide no test binary from CI in ` +
      `their tree or their crate manifest, and the kill sets of ${jsConfigs} discovered ` +
      `JavaScript configuration(s) and the cargo-mutants list name test files that are there, ` +
      `over a mutate scope its configuration and the strategy document state alike and the ` +
      `tree carries module for module.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
