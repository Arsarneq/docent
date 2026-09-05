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
 *       configuration states is a source the tree carries.
 *   (f) kill-set MEMBERSHIP — which surfaces each list ought to state, derived
 *       rather than curated, against the criterion the mutation-strategy
 *       document states (docs/test/strategy/mutation.md §MUT-7). Two legs, both
 *       engines, each diffed in both directions. The test-surface leg
 *       classifies the population each engine's own registered RUNNER selects:
 *       on the JavaScript side every member of the registered `node --test`
 *       suites under that package — today exactly the unit suites those
 *       documents enumerate — and on the Rust side every binary of the
 *       registered cargo suite. Each engine then has a class of its own taken
 *       out of that population by classification, the two standing in the same
 *       place: the property suites on the JavaScript side, the binaries an
 *       `enigo` import classifies as integration on the Rust side. What is left
 *       to decide on either is reaching the configuration's mutate scope or not
 *       reaching it, and the list is held to the reaching members: one that
 *       belongs and is not listed reds, and a listed one that does not belong
 *       reds carrying the reason it does not. The module leg
 *       holds every module of a mutate scope, the globs expanded against the
 *       tracked set, to being reached by at least one LISTED test surface; the
 *       Rust in-module entry does not satisfy it, and its own presence is
 *       asserted instead, since dropping it would take every `#[cfg(test)]`
 *       block out of the run while the rest of the list still read complete.
 *       Reachability is transitive import reach confined to the surface's own
 *       package tree, read over a comment-stripped view and over literal
 *       specifiers only, resolved BY PATH SHAPE so the answer is the same in
 *       every checkout; on the Rust side it is `use` paths alone, read over a
 *       view with comments stripped and string-literal contents blanked, so a
 *       declaration a source merely QUOTES is the text it is rather than an edge
 *       or a refusal, and a `mod` declaration states where a module LIVES rather
 *       than what it needs. A crate module under `src/` is read as the compiled
 *       crate carries it — without `--cfg test`, so the items a bare
 *       `cfg(test)` attribute gates state no edges — the attribute written
 *       `#[cfg(test)]` before an item or block, or `#![cfg(test)]` inside a
 *       block or at the top of a file, with a narrower predicate such as
 *       `#[cfg(all(test, …))]` still stating them — while an integration
 *       target under `tests/` is read whole, since it IS compiled with it;
 *       the `pub use` refusal reads the whole source either way.
 *       What the criterion leaves to judgment
 *       — whether a surface is fast, and whether it is deterministic outside
 *       the property runner the clause names — is recorded per entry in
 *       MEMBERSHIP_ALLOWLIST below, held live from both sides.
 *
 * Why the always-on `lint` job: the diff that stales a suite inventory is
 * frequently docs-only, and a PR that sets none of the workflow's change
 * flags — usually a docs-only one — skips every path-filtered test job.
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
 * registered there, which a new list's change has to do for itself. One closure
 * further on, what closure (f) leaves open is stated where it is decided rather
 * than derived: which surfaces belong to a kill set is answered from the tree,
 * but whether an entry the criterion places there is fast enough and
 * deterministic enough to run once per mutant is a review judgment, recorded as
 * a reasoned exclusion; and the property arm ADMITS surfaces whose property
 * cases sit beside plain ones, which the check enumerates rather than hides.
 * Closure (c)
 * leaves a named remainder open too, because no admission test here states it:
 * which cargo-run and browser-driven suites must be registered (their
 * membership rules are held above, their registration is hand-held — the corpus
 * spec tree is the live example of a Playwright suite in no entry); the
 * `node --test` invocations that reach the runner from somewhere other than an
 * admitted manifest script, namely the workflow's own inline steps and the
 * mutation configurations' per-file lists — those lists' ENTRIES are held for
 * staleness by closure (e) and their membership by closure (f), while the
 * invocations carrying them stay unregistered here, so the lists remain part of
 * this remainder; and the manifests the admission rule does not admit.
 *
 * This file is also the SHARED-PRIMITIVE HOME the sibling checks read through:
 * the Markdown table parser and its selectors, the whole-span and list-item
 * readers, the JavaScript tokenizer and the blanked views it renders, the two
 * Rust views beside them — comments stripped, and string contents blanked — the
 * object-literal walk and the switch-case collector, the literal-to-pattern
 * escape, the set-diff and duplicate reporters, the report block, and the one
 * tracked-file population read. Anything exported here is therefore
 * load-bearing well beyond this check — the sibling check scripts and the
 * suites import from it — so a change to an exported reader's behaviour or
 * wording is a change to every leg that reads through it, and the blast radius
 * is the offer's price.
 *
 * Usage:
 *   node scripts/check-test-inventory.js      # or: npm run lint:test-inventory
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
// Aliased: this module states its own repo-relative `basename` below, which
// reads a posix path, while this one reads the platform's own file path.
import { basename as fileBasename } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Playwright's default `testMatch` — the files it collects under its `testDir`,
 * at any depth. Both browser-driven suites leave that default in place.
 */
const PLAYWRIGHT_TEST_FILE = /(^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/;

/**
 * The repo-relative path of the calling check, DERIVED from the file it is
 * written in rather than written out: the path a verdict names is then the file
 * that printed it, and a rename carries the value with the file instead of
 * leaving a literal behind. Called as `selfPath(import.meta.filename)`, so the
 * file the value names is the caller's, not this module's.
 *
 * The `node scripts/<name>.js` usage line in each check's header is a comment
 * and stays hand-written — that is the stated boundary of this derivation.
 *
 * @param {string} metaFilename the caller's own `import.meta.filename`
 * @returns {string} `scripts/<basename>`, POSIX-separated on every platform
 */
export function selfPath(metaFilename) {
  return `scripts/${fileBasename(metaFilename)}`;
}

const SELF_PATH = selfPath(import.meta.filename);

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

/**
 * A literal string as a regular-expression source, every metacharacter escaped,
 * so a pattern built around it matches that text and nothing else.
 *
 * The one home of the escape: a check building a pattern around a name, a path,
 * a title or a marker calls this rather than writing the character class out a
 * second time. A hand-copied class drifts one character at a time, and the
 * failure is silent in both directions — a metacharacter left unescaped makes a
 * pattern that matches text the caller never meant, and an over-escaped one
 * makes a pattern that matches nothing while looking well-formed. This export
 * is that one home, which the
 * `escapeForRegExp — the one home of the literal-to-pattern escape` describe in
 * `packages/shared/tests/unit/check-test-inventory.test.js` holds.
 * @param {string} text the literal to embed
 * @returns {string} that literal as regular-expression source
 */
export const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
 * heading whose tables make the enumeration claim and `header` their whole
 * header — together they identify the inventory tables, so a table added
 * elsewhere in the document, or one under the same heading written to a
 * different header, is free to name whatever it documents, and several
 * suites may share one document, each taking its own section. A section
 * stating its inventory as several tables of one header is read as the one
 * inventory it is. `dir` is the
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
    header: ['Spec', 'Covers'],
    dir: 'packages/extension/tests/e2e/specs',
    discovery: { runner: RUNNERS.playwright, workdir: 'packages/extension/tests/e2e' },
  }),
  registered({
    doc: 'docs/test/desktop-rust.md',
    section: 'Suite layout',
    header: ['Test file', 'Covers'],
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
    header: ['Spec', 'Covers'],
    dir: 'packages/desktop/tests/integration',
    discovery: { runner: RUNNERS.playwright, workdir: 'packages/desktop/tests/integration' },
  }),
  registered({
    doc: 'docs/test/unit.md',
    section: 'Shared modules',
    header: ['Test file', 'Covers'],
    dir: 'packages/shared/tests/unit',
    discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
  }),
  registered({
    doc: 'docs/test/unit.md',
    section: 'Desktop application',
    header: ['Test file', 'Covers'],
    dir: 'packages/desktop/tests/unit',
    discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
  }),
  registered({
    doc: 'docs/test/unit.md',
    section: 'Chrome extension',
    header: ['Test file', 'Covers'],
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

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * How far past its opener's own indent a closing fence marker may sit. Markdown
 * measures a closer's indent from the block the fence is written in, not from
 * the left margin; reading line by line, the opener's indent is the only stand-
 * in for that block, so a closer is admitted up to this far past it — enough
 * for a fence written inside a list item, and not enough for a marker buried in
 * the fenced text.
 */
const CLOSER_INDENT_SLACK = 3;

/**
 * A fence marker's indent in columns. Markdown measures indentation in columns
 * and a tab advances to the next four-column stop, so counting the indent's
 * characters would read a tab-indented marker three columns further left than
 * it sits — and `CLOSER_INDENT_SLACK` is a column count.
 * @param {string} indent the whitespace run before a fence marker
 * @returns {number} how many columns it occupies
 */
const indentColumns = (indent) => {
  let columns = 0;
  for (const character of indent) columns += character === '\t' ? 4 - (columns % 4) : 1;
  return columns;
};
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
 * starts document-level text again) and with the deeper heading it sits under
 * inside that section, its `subsection` — null until the section states one.
 * The subsection is what makes same-header tables of one section
 * addressable: without it a selector can only take them all or none, however
 * exactly it states the header. A table is a header row followed by a
 * delimiter row and the body rows after it; fenced content is blanked first
 * (via {@link stripFences} — the one fence model), so a table-shaped example
 * inside a fence is never read as one.
 * @param {string} markdown
 * @returns {{ section: string | null, subsection: string | null, header: string[], rows: string[][] }[]}
 */
export function parseTables(markdown) {
  const lines = stripFences(markdown).split('\n');
  const tables = [];
  let section = null;
  let subsection = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (level === 2) {
        section = headingMatch[2];
        subsection = null;
      } else if (level < 2) {
        section = null;
        subsection = null;
      } else subsection = headingMatch[2];
      continue;
    }
    if (!isRow(line) || !isDelimiterRow(lines[i + 1])) continue;
    const header = splitRow(line);
    const rows = [];
    let j = i + 2;
    while (j < lines.length && isRow(lines[j])) rows.push(splitRow(lines[j++]));
    tables.push({ section, subsection, header, rows });
    i = j - 1;
  }
  return tables;
}

/**
 * Select a document's tables by their WHOLE header — not the first cell alone,
 * so a sibling table under the same heading can never be conscripted by
 * sharing one column name — optionally bounded to a `##` section and to a
 * deeper heading inside it. Every match is returned, with the count, so the
 * caller states its own posture: a register that must address exactly one
 * table refuses anything else by count, while an inventory a document
 * deliberately writes as several tables reads them together.
 * @param {string} docText the document (or the slice) to select in
 * @param {object} where the selection
 * @param {string[]} where.header the exact header cells
 * @param {string} [where.section] the `##` section the table sits in
 * @param {string} [where.subsection] the deeper heading inside that section
 * @returns {{ tables: { section: string | null, subsection: string | null, header: string[], rows: string[][] }[], matches: number }}
 */
export function selectTablesByHeader(docText, { header, section, subsection }) {
  const tables = parseTables(docText).filter(
    (t) =>
      (section === undefined || t.section === section) &&
      (subsection === undefined || t.subsection === subsection) &&
      t.header.length === header.length &&
      t.header.every((cell, i) => cell.trim() === header[i]),
  );
  return { tables, matches: tables.length };
}

/**
 * Read one column of selected tables as names, collecting the cells that do
 * not read as one rather than skipping them — the pairing every table
 * inventory needs: a renamed or re-shaped cell must red loudly instead of
 * leaving the scanned set quietly smaller.
 * @param {{ header: string[], rows: string[][] }[]} tables the selected tables
 * @param {object} how the column and its grammar
 * @param {string} how.empty what an empty cell is called in the report
 * @param {number|((table: { header: string[] }) => number)} [how.column] the column, per table
 * @param {(cell: string) => (string | null)} [how.read] the cell grammar; null = unreadable
 * @returns {{ names: string[], unreadable: string[] }}
 */
export function readTableColumn(tables, { empty, column = 0, read = backtickedName }) {
  const names = [];
  const unreadable = [];
  for (const table of tables) {
    const index = typeof column === 'function' ? column(table) : column;
    if (index === -1) continue;
    for (const row of table.rows) {
      const cell = (row[index] ?? '').trim();
      const name = read(cell);
      if (name !== null) names.push(name);
      else unreadable.push(cell === '' ? empty : cell);
    }
  }
  return { names, unreadable };
}

/**
 * Every WHOLE backticked span of a text, in document order — the read the
 * enumeration collectors share. Whole is the property: the predicate judges a
 * span's entire content, so a token embedded in a longer span (a call, a
 * sentence, an example) is never collected, and a caller can state a token in
 * running prose without it counting as an entry.
 *
 * The scope is the caller's: this reads the text it is handed, so slicing a
 * clause, dropping table lines, and stripping fences stay decisions each
 * collector makes for its own leg. Dedup is the caller's too — a repeat is
 * noise to a set-diff and the whole subject of a duplicate leg.
 * @param {string} text pre-sliced, fence-stripped text
 * @param {object} [how] the predicate and the dedup posture
 * @param {RegExp|((token: string) => boolean)} [how.shape] which spans count
 * @param {boolean} [how.dedupe] keep the first appearance of a repeat only
 * @returns {string[]} the collected spans, in first-appearance order
 */
export function backtickedTokens(text, { shape, dedupe = false } = {}) {
  const matches = (token) =>
    shape === undefined ? true : shape instanceof RegExp ? shape.test(token) : shape(token);
  const out = [];
  for (const [, token] of (text ?? '').matchAll(/`([^`]+)`/g)) {
    if (!matches(token)) continue;
    if (dedupe && out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * The top-level `- ` list items of a text, each bounded to its own lines: an
 * item runs from its `- ` marker through the continuation lines indented under
 * it, and ends at the first blank line or unindented line — so the paragraph
 * that follows a list is never absorbed into its last item.
 * @param {string} text a clause section's or document's text
 * @returns {string[]} one flattened string per item (marker stripped)
 */
export function topLevelListItems(text) {
  const items = [];
  let current = null;
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (/^- \S/.test(line)) {
      current = [line.slice(2).trim()];
      items.push(current);
    } else if (current !== null && /^\s+\S/.test(line)) {
      current.push(line.trim());
    } else {
      current = null;
    }
  }
  return items.map((parts) => parts.join(' '));
}

/**
 * The tracked files a pathspec names, as `git ls-files` lists them — the one
 * population read the checks that scan a tree share. The argument is a
 * PATHSPEC, so a directory, a glob, or a bare name all reach the same reader.
 *
 * `core.quotepath` is off, so a path carrying a non-ASCII byte arrives as
 * itself rather than quoted and escaped, which every filter a caller applies
 * would otherwise drop in silence — a file present in the tree and absent from
 * the scan. This paragraph is the policy's one home: no other script under
 * `scripts/` carries a second copy of this clause, which the
 * `quotepath policy — one home, no second copy` describe in
 * `packages/shared/tests/unit/check-test-inventory.test.js` holds; the checks
 * that cite it do so instead of copying it.
 *
 * Both filters are the caller's to state and both are optional: `extensions`
 * keeps the files whose name ends in one of them, and `exclude` drops the ones
 * under a directory the caller does not scan.
 * @param {string} pathspec what to enumerate — a directory, a glob, or a name
 * @param {object} [how] the caller's filters and where to run
 * @param {string[]} [how.extensions] keep only files ending in one of these
 * @param {string} [how.exclude] drop files under this directory
 * @param {string} [how.cwd] the directory to enumerate from (default: the process's)
 * @returns {string[]} repo-relative paths, in `git ls-files` order
 */
export function trackedFilesUnder(pathspec, { extensions, exclude, cwd } = {}) {
  return execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', pathspec], {
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => extensions === undefined || extensions.some((ext) => file.endsWith(ext)))
    .filter((file) => exclude === undefined || !file.startsWith(`${exclude}/`));
}

/**
 * The case labels one `switch` services, bounded by the switch's own BRACES
 * rather than by its `default:` arm — which is the difference between reading
 * a switch and reading the text before a keyword: a live case written after
 * the default arm is serviced at runtime and must be read, and a stale one
 * written there must be seen rather than passed over.
 *
 * The scan reads text, so its caller states which VIEW: comments blanked, so
 * a commented-out label is never read as serviced, and the switch's own text
 * standing. Where a template literal CARRIES the switch — a script a test
 * injects — the caller hands over that template's own text, since a view of
 * the source around it leaves the script's comments standing as the literal
 * text they are at that level. A second `switch` standing at this switch's own
 * depth — where an arm's statements stand — is refused rather than read past:
 * its labels are not this switch's surface, and the refusal names the anchor
 * instead of guessing. One written deeper, inside a braced arm, sits past the
 * bound and is never reached, so its labels are not credited either.
 * @param {string} view the text to read, with comments already blanked
 * @param {string} anchor the switch statement's own text, e.g. `switch (cmd)`
 * @returns {{ labels: string[], hasDefault: boolean, problems: string[] }}
 */
export function switchCaseLabels(view, anchor) {
  const at = view.indexOf(anchor);
  if (at === -1) return { labels: [], hasDefault: false, problems: [`no \`${anchor}\` statement found`] }; // prettier-ignore
  const open = view.indexOf('{', at + anchor.length);
  if (open === -1) return { labels: [], hasDefault: false, problems: [`\`${anchor}\` opens no body the scan can read`] }; // prettier-ignore
  const labels = [];
  let hasDefault = false;
  let depth = 1;
  for (let i = open + 1; i < view.length && depth > 0; i++) {
    const ch = view[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    const rest = view.slice(i);
    const secondSwitch = /^switch\s*\(/.exec(rest);
    if (secondSwitch) {
      return { labels: [], hasDefault, problems: [`\`${anchor}\` carries a second switch at this switch's own depth — the serviced labels of one switch are what this scan reads`] }; // prettier-ignore
    }
    const label = CASE_LABEL_RE.exec(rest);
    if (label) {
      labels.push(label[1]);
      i += label[0].length - 1;
      continue;
    }
    if (DEFAULT_ARM_RE.test(rest)) hasDefault = true;
  }
  if (depth > 0) {
    return { labels: [], hasDefault, problems: [`\`${anchor}\` never closes — the serviced labels cannot be read`] }; // prettier-ignore
  }
  return { labels, hasDefault, problems: [] };
}

/** A `case` arm labelled by a quoted name, as the scan reads one. */
const CASE_LABEL_RE = /^case\s+['"]([A-Za-z0-9_]+)['"]\s*:/;
/** A `default` arm, which a switch the scan reads is required to carry. */
const DEFAULT_ARM_RE = /^default\s*:/;

/**
 * Walk the TOP-LEVEL properties of an object literal in a token stream, from
 * its opening brace: the skeleton the object-literal readers share. Depth is
 * counted over every bracket pair, so a nested literal, call, or array is
 * passed through whole, and a property start is the first token after the
 * brace or after a depth-1 comma.
 *
 * What a property IS stays the caller's: the walk hands its policy the index
 * of each property-start token and reads nothing itself, so one caller can
 * read member names where another reads keys and their values, each keeping
 * its own accumulators and its own refusal wording.
 *
 * One decision the merged skeleton fixes: a comma standing where a property
 * would start is read as the separator it is, never handed to the policy —
 * so a doubled comma states no property rather than an unmodelled one.
 * @param {{ type: string, value: string }[]} tokens the tokenized source
 * @param {number} open index of the literal's `{`
 * @param {(index: number, token: { type: string, value: string }) => void} onProperty the policy
 * @returns {{ closed: boolean, end: number }} whether the literal closed, and where the walk stopped
 */
export function walkObjectLiteral(tokens, open, onProperty) {
  let depth = 1;
  let atPropertyStart = true;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i];
    const startsProperty = depth === 1 && atPropertyStart;
    if (t.type === 'punct' && '([{'.includes(t.value)) {
      if (startsProperty) onProperty(i, t);
      depth++;
      atPropertyStart = false;
    } else if (t.type === 'punct' && ')]}'.includes(t.value)) {
      depth--;
      // A trailing comma leaves the property start open — closing it is not a
      // property.
      if (depth === 0) return { closed: true, end: i };
    } else if (depth === 1 && t.type === 'punct' && t.value === ',') {
      atPropertyStart = true;
    } else {
      if (startsProperty) onProperty(i, t);
      atPropertyStart = false;
    }
  }
  return { closed: false, end: tokens.length };
}

/**
 * One line of text with every run of whitespace collapsed to a single space
 * and the ends trimmed — so an anchor phrase is found whatever line the prose
 * wraps on, and a re-wrap never changes what a scan reads.
 * @param {string} text
 * @returns {string}
 */
export function flattenWhitespace(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
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
 *
 * Feed it what the surface ENUMERATES, never the raw text a reader lifted the
 * enumeration out of: a command's argument list repeats its flag token by that
 * list's own grammar (`--test a --test b` states two targets, not a repeat),
 * so a raw-list reading reds a healthy tree, while the projection — the
 * targets, the files, the entries — is the list whose repeat is drift.
 * @param {string[]} names an extracted name list, as the surface enumerates it
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
 * Blank out fenced code blocks (``` or ~~~), preserving newlines, so a marker,
 * heading, table, or token inside an illustrative fence is never read as live
 * doc text. This is the same fence model `parseTables` applies internally —
 * exported so every doc-scanning check agrees on what a fence is.
 *
 * A fence closes on the closing rule Markdown itself states: a marker line of
 * the SAME character, at least as long as the opener's run, carrying nothing
 * after it, and indented no further past the opener's own indent than a
 * Markdown closer may sit. So a shorter marker line inside a longer fence is
 * content — a three-backtick example nested inside a four-backtick fence keeps
 * its headings, tables, and clause markers fenced — while an opener's own
 * indent still travels with it, so a fence written inside a list item closes
 * where it is written. A fence never closed runs to the end of the text, as it
 * always has.
 *
 * The model's known limits: at the top level a marker indented four columns or
 * more opens a fence here, where CommonMark reads a line indented that far as
 * an indented code block instead; a backtick opener whose trailing text carries
 * a backtick opens one here too, where CommonMark reads that line as text
 * rather than as a fence at all; a fence written inside a block quote, and one
 * opened on a list-marker line, are not seen as fences here, so what they hold
 * reads as live doc text; and the closer's window is measured from the opener's
 * own column, which stands in for the indent of the block the fence sits in, so
 * a closer written inside that window closes the fence here, while CommonMark,
 * measuring from the margin at top level, may read that marker as content and
 * keep reading.
 * @param {string} markdown
 * @returns {string} the text with fence lines and fenced content blanked
 */
export function stripFences(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  return lines
    .map((line) => {
      const marker = FENCE_RE.exec(line);
      if (marker) {
        const [, indent, run, after] = marker;
        const columns = indentColumns(indent);
        if (fence === null) fence = { char: run[0], length: run.length, indent: columns };
        else if (
          run[0] === fence.char &&
          run.length >= fence.length &&
          columns <= fence.indent + CLOSER_INDENT_SLACK &&
          after.trim() === ''
        )
          fence = null;
        return '';
      }
      return fence !== null ? '' : line;
    })
    .join('\n');
}

/**
 * A heading's section body: the lines between the heading line `heading`
 * matches and the next line `boundary` matches, or the end of the text. Both
 * patterns are applied to the fence-stripped view (via {@link stripFences},
 * which blanks fenced lines and keeps the line count), so a `#` line inside an
 * illustrative fence neither opens a section nor ends one, and a fence left
 * open runs to the end of the text, putting every heading below it inside it.
 * The body itself is sliced from the RAW text by line — a line index found on
 * the view addresses the raw text too — so everything the author fenced comes
 * back in it.
 *
 * The two readings that take this primitive differ only in those two patterns,
 * and each states its own: a pull-request body's `## `-headed section is found
 * by a title without its markers and ends at the next `## ` line
 * (`extractSection` in `check-docs-disposition.js`), while a guide section is
 * found by a heading written out in full and ends at a heading of any level.
 * Each pattern is matched a line at a time, and is rebuilt without the global
 * and sticky flags on entry, so a pattern carrying either answers the same on
 * every call.
 * @param {string} markdown
 * @param {RegExp} heading the heading line, matched one line at a time
 * @param {RegExp} boundary the heading shape that ends the section
 * @returns {string | null} the raw lines between, or null when no line matches
 *   `heading`
 */
export function extractHeadingSection(markdown, heading, boundary) {
  const perLine = (pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  const headingLine = perLine(heading);
  const boundaryLine = perLine(boundary);
  const view = stripFences(markdown).split('\n');
  const start = view.findIndex((line) => headingLine.test(line));
  if (start === -1) return null;
  let end = view.length;
  for (let i = start + 1; i < view.length; i++) {
    if (boundaryLine.test(view[i])) {
      end = i;
      break;
    }
  }
  return markdown
    .split('\n')
    .slice(start + 1, end)
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
 * The words a regular-expression literal may stand directly after: the
 * keywords an expression can start after. Every other word is a value — an
 * identifier, a number, `this`, `super` — and a `/` written after a value
 * divides.
 */
const REGEX_START_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'default',
  'do',
  'else',
  'extends',
  'yield',
  'await',
  'throw',
]);

/**
 * The punctuation a `/` divides after — the closers that end a value. After
 * every other punctuator an expression may start, so a `/` opens a literal.
 */
const DIVIDES_AFTER = new Set([')', ']']);

/**
 * Whether a `/` written after `token` opens a regular-expression literal rather
 * than dividing, `before` being the token ahead of `token`. This is the whole
 * of the decision, and it has one home because each rendering of the scan asks
 * it: {@link tokenizeJs}, which answers with a token stream, and
 * {@link blankJsLiterals}, which answers with an offset-preserving view.
 *
 * A word a `.` precedes is a property name, and therefore a value however it is
 * spelled — `o.in / 2` divides — which is the same member rule the declarator
 * reading in `check-clause-registry.js` applies. A `}` is read as the end of a
 * statement rather than of an object literal, the reading that lets a literal
 * open after one.
 * @param {{ type: string, value: string } | null | undefined} token the token
 *   the `/` follows, absent at the start of the source
 * @param {{ type: string, value: string } | null | undefined} before the token
 *   ahead of `token`
 * @returns {boolean}
 */
function regexCanFollow(token, before) {
  if (!token) return true;
  if (token.type === 'word') {
    const property = before?.type === 'punct' && before.value === '.';
    return !property && REGEX_START_WORDS.has(token.value);
  }
  if (token.type === 'punct') return !DIVIDES_AFTER.has(token.value);
  return false;
}

/**
 * Read the extent of the regular-expression literal opening at `at`, the index
 * of its `/`. Escapes are consumed in pairs; an unescaped `[` opens a character
 * class and an unescaped `]` closes it, so a `/` written inside one is ordinary
 * pattern text; the literal closes at the first unescaped `/` outside a class,
 * and the flag run after it is a run of word characters.
 *
 * A literal may not cross a line terminator, so a run that reaches one is
 * ABANDONED — the answer is `null` and the caller reads the `/` as the
 * punctuation it was. That bound is what caps a `/` read as a literal by
 * mistake at the line it is written on.
 *
 * A character class is tracked as open-or-not rather than by depth, which finds
 * the closing delimiter of every valid literal: the flag that admits a nested
 * class forbids an unescaped `/` inside one. The extent is all this reads — a
 * pattern is never compiled, so what it would match is not this scan's
 * question.
 * @param {string} source
 * @param {number} at index of the opening `/`
 * @returns {{ close: number, end: number } | null} `close` indexes the closing
 *   `/`, `end` the character just past the flag run
 */
function readRegexLiteral(source, at) {
  let k = at + 1;
  let inClass = false;
  while (k < source.length) {
    const ch = source[k];
    if (ch === '\n' || ch === '\r') return null;
    if (ch === '\\') {
      const next = source[k + 1];
      if (next === undefined || next === '\n' || next === '\r') return null;
      k += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      const close = k;
      k++;
      while (k < source.length && WORD_CHAR_RE.test(source[k])) k++;
      return { close, end: k };
    }
    k++;
  }
  return null;
}

/**
 * Tokenize JavaScript source far enough to read a data literal out of it:
 * quoted strings (quote style and escapes honoured), template literals,
 * regular-expression literals, identifier-ish words, and single punctuation
 * characters. Comments and whitespace are dropped, so a commented-out or
 * documented occurrence of a name is never mistaken for the declaration; a
 * leading `#!` line is a comment of that kind and is skipped.
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
 *
 * A regular-expression literal is modelled as its own token type too, carrying
 * the literal exactly as written — both delimiters and the flag run — where a
 * `string` or `template` token carries contents: a pattern's escapes are its
 * meaning and no contents reading survives stripping them, so a refusal naming
 * one prints the pattern the source states. Whether a
 * `/` opens such a literal or divides is the decision the grammar makes with a
 * parser this scanner does not have, so it is made from the token before, by
 * {@link regexCanFollow}: a literal may open where an expression may start — at
 * the start of the source, after a punctuator other than `)` or `]`, after one
 * of the keywords an expression can start after, and at the start of a `${…}`
 * interpolation — while after a value, meaning an identifier, a number, a
 * string, a template, a literal already read, or a property name a `.`
 * precedes, the `/` divides. What the literal spans is {@link readRegexLiteral}.
 *
 * Where that rule and the grammar part, each shape is named here. A literal
 * written directly after the `)` closing an `if`/`for`/`while` head reads as
 * division, and its pattern then enters the stream as the code that text
 * spells: a call, a registration, or a declaration written inside a pattern is
 * read as one the file makes. Quotes written in such a pattern are read as the
 * quotes they look like — a matched pair opens and closes a string inside the
 * pattern's own text, and the stream comes back into step at the literal's end,
 * while an UNMATCHED one opens a string that runs to the next quote wherever in
 * the file it stands, leaving the stream out of step from there to the end of
 * the file. The other shape is a `/` that divides standing where an expression
 * could start — after a `}`, after one of the words above written as an
 * identifier, or after a postfix `++` or `--` — which reads as a literal
 * instead and takes with it at most the rest of the line it is written on: the
 * run closes at the next `/` on that line, and one that reaches the line
 * terminator is abandoned, the `/` read as punctuation again. That line is the
 * bound of this second shape alone. A scan over this stream states what those
 * shapes cost IT, and cites this model rather than restating it.
 * @param {string} source
 * @returns {{ type: 'word' | 'string' | 'template' | 'regex' | 'punct', value: string }[]}
 */
export function tokenizeJs(source) {
  const tokens = [];
  // One entry per open `${…}` interpolation, each holding the brace depth
  // reached inside it. A `}` whose entry stands at zero closes the
  // interpolation and resumes its template's text; any other brace is ordinary
  // punctuation that moves the depth.
  const interpolations = [];
  let i = 0;
  // A leading `#!` line is a comment: skipped whole, so its path never reads as
  // a literal opening at the `/` of `/usr`.
  if (source.startsWith('#!')) {
    while (i < source.length && source[i] !== '\n') i++;
  }
  // Whether a `/` reached now opens a regular-expression literal. Recomputed
  // from the token just emitted and the one before it, so the rule lives in one
  // place and is asked the same way here and in the blanked view.
  let regexOk = true;
  /**
   * Emit a token and recompute whether a `/` may open a literal after it.
   * @param {{ type: string, value: string }} token
   * @returns {void}
   */
  const emit = (token) => {
    const before = tokens[tokens.length - 1];
    tokens.push(token);
    regexOk = regexCanFollow(token, before);
  };
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
    let opened = false;
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
        opened = true;
        break;
      }
      value += ch;
      k++;
    }
    emit({ type: 'template', value });
    // An interpolation opens at an expression start, whatever text preceded it.
    if (opened) regexOk = true;
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
    // After the comment branches, which own `//` and `/*`: neither can open a
    // literal, so what reaches here is a `/` that divides or opens one.
    if (ch === '/' && regexOk) {
      const literal = readRegexLiteral(source, i);
      if (literal) {
        emit({ type: 'regex', value: source.slice(i, literal.end) });
        i = literal.end;
        continue;
      }
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
      emit({ type: 'string', value });
      continue;
    }
    if (WORD_CHAR_RE.test(ch)) {
      let value = '';
      while (i < source.length && WORD_CHAR_RE.test(source[i])) value += source[i++];
      emit({ type: 'word', value });
      continue;
    }
    if (!/\s/.test(ch)) emit({ type: 'punct', value: ch });
    i++;
  }
  return tokens;
}

/**
 * Blank out every comment, and the CONTENTS of every quoted string and every
 * template literal — replacing each character with a space while keeping the
 * literal's delimiters, every other character's offset, and every newline. The
 * view is the source's own length, line for line, so an offset or a line number
 * computed on it addresses the same character of the source it was made from,
 * and a regular expression written against the source's shape still matches.
 *
 * A regular-expression literal keeps its delimiters and its PATTERN TEXT, and
 * gives up its flag run. What a guard reads this view for is a REFERENCE — a
 * name the code uses — and a pattern is where a source states the names it
 * handles, so a mention written there stays visible and reds wherever a guard
 * forbids that name: for a guard that asserts an absence, a mention reported is
 * the answer a reviewer can weigh, and one kept in view is what makes the
 * report possible. The flag run goes because it is word-shaped literal data,
 * and a view that left it standing would hand such a guard an identifier the
 * source never wrote.
 *
 * The JavaScript sibling of the comment-stripped and string-blanked Rust views
 * in [`check-command-surface.js`](./check-command-surface.js), which stand
 * beside each other there for the same reason: a scan looking for what a source
 * DOES wants the calls it makes with the text of what it says about them left
 * out. It is one function rather than that pair because in JavaScript those
 * questions cannot be
 * separated — whether a `/` opens a comment, a literal, or a division is
 * decidable only while strings, templates and regular expressions are all being
 * tracked, so one scan produces both answers at once.
 *
 * It is a second rendering of {@link tokenizeJs}'s scanning rules, not a second
 * grammar: the comment branches, the string branch, the template model with its
 * interpolations left as the code they are, and the regular-expression branch
 * all read the same way, and the decisions that could drift —
 * {@link regexCanFollow} and {@link readRegexLiteral} — are shared outright, so
 * a guard searching this view and a reader of the token stream find the same
 * literals in the same places. What differs is what each answer is FOR: a token
 * carries a literal's value, so a `regex` token states the pattern as written,
 * while this view is a source a text search runs over, so it leaves the pattern
 * where it stands and blanks what a search could otherwise read as code.
 * One view serves two readings. By default a literal's contents go with the
 * comments, which is what a scan for CODE wants. A caller reading code a
 * literal CARRIES — the script an integration mock injects as a template —
 * asks for the other by stating `literals: false`: the comments still go, so a
 * commented-out line is never read as live, and the literal text stands.
 * @param {string} source JavaScript source text
 * @param {{ literals?: boolean }} [view] whether literal contents are blanked too
 * @returns {string} the source with comments — and, by default, string and
 *   template contents and regular-expression flag runs — blanked
 */
export function blankJsLiterals(source, { literals = true } = {}) {
  const out = source.split('');
  const n = source.length;
  /**
   * Blank `[from, to)`, keeping newlines so the view stays line for line.
   * @param {number} from
   * @param {number} to
   * @returns {void}
   */
  const blank = (from, to) => {
    for (let k = Math.max(from, 0); k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  /**
   * Blank a literal's contents, unless this view keeps them: a caller reading
   * code a literal CARRIES — a script a test injects as a template, say —
   * needs the comments gone and the text standing.
   * @param {number} from
   * @param {number} to
   * @returns {void}
   */
  const blankLiteral = (from, to) => {
    if (literals) blank(from, to);
  };
  // The same interpolation bookkeeping tokenizeJs keeps, for the same reason.
  const interpolations = [];
  let i = 0;
  if (source.startsWith('#!')) {
    while (i < n && source[i] !== '\n') i++;
    blank(0, i);
  }
  let regexOk = true;
  let last = null;
  let before = null;
  /**
   * Record the token the scan just passed, and recompute whether a `/` reached
   * now opens a literal — tokenizeJs's `emit`, with nothing collected.
   * @param {{ type: string, value: string }} token
   * @returns {void}
   */
  const seen = (token) => {
    before = last;
    last = token;
    regexOk = regexCanFollow(last, before);
  };
  /**
   * Blank a run of template text from `at` and answer the index just past what
   * ended it: the closing backtick, the `${` opening an interpolation, or the
   * end of an unterminated literal. The `$` and `{` are delimiters and stay
   * visible, like the backtick and like a quote.
   * @param {number} at
   * @returns {number}
   */
  const readTemplateText = (at) => {
    let k = at;
    while (k < n) {
      const ch = source[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '`') {
        blankLiteral(at, k);
        seen({ type: 'template', value: '' });
        return k + 1;
      }
      if (ch === '$' && source[k + 1] === '{') {
        interpolations.push(0);
        blankLiteral(at, k);
        seen({ type: 'template', value: '' });
        regexOk = true;
        return k + 2;
      }
      k++;
    }
    blankLiteral(at, n);
    seen({ type: 'template', value: '' });
    return n;
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const from = i;
      while (i < n && source[i] !== '\n') i++;
      blank(from, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const from = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      blank(from, i);
      continue;
    }
    if (ch === '/' && regexOk) {
      const literal = readRegexLiteral(source, i);
      if (literal) {
        // Both delimiters and the pattern between them stand; the flag run
        // after the closing delimiter is what goes.
        blankLiteral(literal.close + 1, literal.end);
        i = literal.end;
        seen({ type: 'regex', value: '' });
        continue;
      }
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
      const from = i;
      i++;
      while (i < n && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      blankLiteral(from + 1, Math.min(i, n));
      i = Math.min(i + 1, n); // closing quote (or end of source)
      seen({ type: 'string', value: '' });
      continue;
    }
    if (WORD_CHAR_RE.test(ch)) {
      const from = i;
      while (i < n && WORD_CHAR_RE.test(source[i])) i++;
      seen({ type: 'word', value: source.slice(from, i) });
      continue;
    }
    if (!/\s/.test(ch)) seen({ type: 'punct', value: ch });
    i++;
  }
  return out.join('');
}

/**
 * Blank out Rust comments (line `//…` and nested block `/* … *\/`) while
 * preserving every non-comment character's offset and every newline, so
 * line numbers computed on the stripped text match the source. String
 * literals — `"…"` with escapes and raw `r"…"` / `r#"…"#` forms — are
 * honoured so comment markers inside them survive.
 *
 * The Rust counterpart of {@link blankJsLiterals}'s comment half, and the view
 * every Rust-reading scan here shares: the kill-set membership legs read a
 * binary's `use` statements through it, and the sibling checks that read the
 * desktop crate reach it through
 * [`check-command-surface.js`](./check-command-surface.js), which re-exports it
 * for them. It sits in this module, its string-blanking twin
 * {@link blankRustStrings} beside it, because this one carries node builtins and
 * nothing else, so every check — this one included — can read through either
 * without inheriting a sibling's closure.
 *
 * @param {string} source Rust source text
 * @returns {string} the source with comment characters replaced by spaces
 */
export function stripRustComments(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "'") {
      // A simple char literal ('x', '\n', '\'') is skipped wholesale so a
      // quote inside one cannot open a phantom string; a lifetime tick ('a)
      // falls through and is treated as an ordinary character.
      const lit = /^'(?:\\.|[^\\'])'/.exec(source.slice(i, i + 4));
      i += lit ? lit[0].length : 1;
    } else if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (source[j] === '*' && source[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
    } else if (c === 'r' && (next === '"' || next === '#')) {
      // Possible raw string: r"…" or r#"…"# with any number of hashes.
      let hashes = 0;
      let j = i + 1;
      while (source[j] === '#') {
        hashes++;
        j++;
      }
      if (source[j] === '"') {
        const closer = '"' + '#'.repeat(hashes);
        const end = source.indexOf(closer, j + 1);
        i = end === -1 ? n : end + closer.length;
      } else {
        i++;
      }
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') {
        j += source[j] === '\\' ? 2 : 1;
      }
      i = Math.min(j + 1, n);
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Blank out the CONTENTS of Rust string literals — `"…"` with escapes, the raw
 * forms `r"…"` and `r#"…"#`, and char literals — replacing every character
 * they carry with a space while keeping the quotes themselves, every other
 * character's offset, and every newline. An offset computed on this view
 * therefore addresses the same character of the source it was made from.
 *
 * It stands BESIDE {@link stripRustComments} rather than inside it, because the
 * two views answer different questions and one scan needs both. Comment
 * stripping keeps string contents on purpose: a channel name is a string
 * literal, and reading it is the point. What a scan looking for an ANCHOR wants
 * is the opposite — the calls the source makes, with the text of what it says
 * about them left out — which is this view. A scan that anchors here and then
 * reads a literal reads it from the intact text at the same offset.
 *
 * It sits in this module for the same reason its twin does: the kill-set
 * membership legs read a Rust binary's `use` declarations through both views —
 * a `use` written inside a string literal is text, not an edge, and a `pub use`
 * written there is not the re-export that refuses the mapping — and this module
 * carries node builtins and nothing else, so every check can read through it
 * without inheriting a sibling's closure.
 * [`check-command-surface.js`](./check-command-surface.js) re-exports it for the
 * readers that already ask it for this view.
 * @param {string} source Rust source text
 * @returns {string} the source with string-literal contents replaced by spaces
 */
export function blankRustStrings(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "'") {
      // A char literal's own content is blanked; a lifetime tick ('a) matches
      // no literal shape and falls through as an ordinary character.
      const lit = /^'(?:\\.|[^\\'])'/.exec(source.slice(i, i + 4));
      if (lit) {
        blank(i + 1, i + lit[0].length - 1);
        i += lit[0].length;
      } else {
        i++;
      }
    } else if (c === '/' && next === '/') {
      // Comment text is not this view's subject, but a quote inside one would
      // otherwise open a literal that never closes, so a comment is skipped
      // whole and left exactly as it arrived.
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (source[j] === '*' && source[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      i = j;
    } else if (c === 'r' && (next === '"' || next === '#')) {
      let hashes = 0;
      let j = i + 1;
      while (source[j] === '#') {
        hashes++;
        j++;
      }
      if (source[j] === '"') {
        const closer = '"' + '#'.repeat(hashes);
        const end = source.indexOf(closer, j + 1);
        blank(j + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + closer.length;
      } else {
        i++;
      }
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') {
        j += source[j] === '\\' ? 2 : 1;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
    } else {
      i++;
    }
  }
  return out.join('');
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
 * that printed the token alone would state as the whole argument. A
 * regular-expression literal is named from the same fact, and its value is the
 * literal as written, so a refusal naming one prints the pattern the source
 * states.
 *
 * Who reads a value position without this helper, and why. The emit-site scan
 * and the mock's serviced-case scan ask the same question with regular
 * expressions — one over Rust text, one over raw JavaScript text — so neither
 * holds a token stream to hand it. The whole-expression pair asks a different
 * question over a different window: what follows a list literal's own closing
 * bracket, rather than what follows a value inside it, and its two copies
 * deliberately accept different followers because one reads a standalone
 * declaration and the other a property inside a literal — each stating its own
 * window where it stands.
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
 * The literal kinds a reader of quoted strings does not read. {@link tokenizeJs}
 * emits `word`, `string`, `template`, `regex`, and `punct`; of those, the two
 * named here are literals whose token value is not the value the source states —
 * a template's flat run of text, a regular expression's own literal text. Every
 * refusal that turns on "a literal this reader does not read" asks here, so a
 * literal kind the tokenizer grows is learned by all of them at once.
 * @param {string | null | undefined} kind a token kind, as the tokenizer states it
 * @returns {boolean}
 */
export function isUnreadLiteralKind(kind) {
  return kind === 'template' || kind === 'regex';
}

/**
 * How a literal a reader of quoted strings does not read is named in a refusal:
 * by its kind, with what the source wrote beside it — a template's flat run of
 * text, a regular expression's literal as written. Naming the kind is what
 * keeps such a refusal on the shape that stopped the read, where counting the
 * literal among the values a reader could not read would state a cause the
 * source does not have; any other token is named by itself, which says it
 * already.
 *
 * The kind and the text are taken apart rather than as one token, because the
 * readers that call this carry them under their own names — a lone-literal
 * read's `kind`/`token`, a tokenizer token's `type`/`value` — and this is the
 * one home of the phrases either way.
 * @param {string | null | undefined} kind the literal's kind, as the tokenizer states it
 * @param {string} text what the source wrote there
 * @returns {string}
 */
export function namedLiteral(kind, text) {
  if (kind === 'template') return `a template literal (\`${text}\`)`;
  if (kind === 'regex') return `a regular-expression literal (\`${text}\`)`;
  return `\`${text}\``;
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
      return { error: unreadable(namedLiteral(token.type, token.value)) };
    }
    if (
      depth === 2 &&
      record !== null &&
      // Every literal kind, the readable one INCLUDED: what follows decides
      // whether this one is read or named, and a string that is not lone is
      // refused there too.
      (token.type === 'string' || isUnreadLiteralKind(token.type))
    ) {
      const key = tokens[i - 2];
      const colon = tokens[i - 1];
      if (
        colon?.type === 'punct' &&
        colon.value === ':' &&
        key?.type === 'word' &&
        fields.includes(key.value)
      ) {
        if (token.type !== 'string') {
          // A literal this reader does not read, standing where a requested
          // value goes, is named here: recording nothing would report the
          // property missing from a record that states it, which names a cause
          // the source does not have.
          return {
            error: `the \`${name}\` array literal's \`${key.value}\` property is ${namedLiteral(token.type, token.value)}, and this reader reads a quoted string literal`,
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
  // The window here is the WHOLE DECLARATION, so only a statement end proves
  // the entries read are the list the declaration states: the accept set is
  // the end of the stream and `;`, and nothing else. Its sibling guard — over
  // a list stated as a property INSIDE a literal — accepts strictly more,
  // because more can legally follow a property's value there. The two are not
  // opposite readings of one window; they are two windows, and unifying them
  // would widen this one to followers a declaration cannot have.
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
 *             absent: string[], duplicated: string[], duplicatedEntry: string[],
 *             missingSource: string[], splitEntry: string[] }}
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
    duplicatedEntry: [],
    missingSource: [],
    splitEntry: [],
  };
  const tracked = new Set(files);

  for (const inventory of inventories) {
    const { doc, section, header, dir, selects } = inventory;
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
    const { tables } = selectTablesByHeader(content, { section, header });
    if (tables.length === 0) {
      result.unparsed.push(
        `${doc}: no inventory table found (expected a table under "## ${section}" headed ${header.map((cell) => `"${cell}"`).join(' | ')})`,
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
    // The list is an enumeration, so a file stated twice is edit slop the
    // tracked-set diffs below cannot see: they collect the entry once.
    result.duplicatedEntry.push(
      ...duplicatesIn(
        read.entries.map((entry) => (fields === null ? entry : entry[pathField])),
        `\`${name}\` in ${file}`,
      ),
    );
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
  if (dirs.length === 1 && isUnreadLiteralKind(dirs[0].type)) {
    // Naming the literal is the diagnosis: counting it among the unreadable
    // values would report a `testDir` the configuration states as one it does
    // not, which names a cause the source does not have.
    result.unreadableClosure.push(
      `${configPath}: states its \`testDir\` as ${namedLiteral(dirs[0].type, dirs[0].value)}, and this reader reads a quoted string literal, so the directory it collects cannot be read`,
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
 * The two paths Cargo builds one test target from, in the order a diagnosis
 * names them: the file `<dir>/<name><suffix>` and the directory form
 * `<dir>/<name>/<main>`. ONE statement of that pair, because both legs over the
 * cargo list stand on it — the staleness leg asking whether a listed target is
 * still there, and the membership leg asking which binaries the tree carries to
 * classify — and a leg reading only the file route would call a binary that
 * moved into a directory of its own a target that is not there, or leave it out
 * of the population entirely.
 * @param {string} target the cargo target name
 * @param {typeof RUST_KILL_SET} [killSet] the tree shape the routes are read by
 * @returns {string[]} the candidate repo-relative paths, file route first
 */
export function cargoTargetRoutes(target, killSet = RUST_KILL_SET) {
  return [`${killSet.dir}/${target}${killSet.suffix}`, `${killSet.dir}/${target}/${killSet.main}`];
}

/**
 * The mutate scope, stated twice: as `key` in the cargo-mutants configuration,
 * and as the table `header` heads inside `clause`'s scope in `doc`. The scope
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
  header: ['Module', 'What it carries'],
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
  // The window here is ONE PROPERTY, so the accept set is the punctuation that
  // can end a property's value — `,`, `}`, `)`, `]`, `;`, the end of the
  // stream — plus the one call modelled because it cannot change the set. Its
  // sibling guard — over a list stated as a standalone declaration — accepts
  // strictly less, and deliberately: a declaration ends at a statement end.
  //
  // What follows the literal decides whether the entries ARE the list: the
  // joining call leaves the set alone, and anything else — a filter, a slice, a
  // concatenation — would make this reader's answer a part of the real one. The
  // live shape it is modelled for is a mutation configuration's command list,
  // which states `].join(' ')` and whose consumer re-joins the entries itself.
  // The test is a three-token prefix, so it bounds the FIRST call only: a
  // chained `.join(' ').concat(x)` is accepted where `.filter(` and `.length`
  // are refused — the residue of modelling one call rather than an expression.
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
 * @param {string[]} header the table's whole header
 * @returns {{ modules: string[] } | { error: string }}
 */
export function readScopeTable(markdown, clause, header) {
  const section = extractClauseSection(markdown, clause);
  if (section === '') return { error: `states no \`**${clause}.**\` marker, so the table this leg reads has no scope to sit in` }; // prettier-ignore
  const { tables } = selectTablesByHeader(section, { header });
  if (tables.length === 0) {
    return { error: `states no table headed ${header.map((cell) => `"${cell}"`).join(' | ')} inside §${clause}, where this leg reads the mutate scope` }; // prettier-ignore
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
 * @returns {{ staleKillSetEntry: string[], duplicatedEntry: string[],
 *             mutateScopeDrift: string[], deadScopeModule: string[],
 *             unreadableKillSet: string[] }}
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
    duplicatedEntry: [],
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
    // The flip reads the ARGUMENTS the invocation states, not the raw list:
    // the flags a command repeats are its grammar, and only a repeated target
    // is a curated list stating one file twice.
    result.duplicatedEntry.push(
      ...duplicatesIn(
        invocation.args.map((arg) => normalizePath(arg)),
        `\`${jsKillSets.property}\`'s \`node --test\` arguments in ${config}`,
      ),
    );
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
        // The projection, never the raw values: `--test` itself repeats once
        // per target by the grammar of a cargo argument list, so the targets
        // are what a curated list can state twice.
        result.duplicatedEntry.push(
          ...duplicatesIn(
            selected.targets,
            `\`${rustKillSet.key}\`'s \`${rustKillSet.flag}\` targets in ${rustKillSet.config}`,
          ),
        );
        for (const target of selected.targets) {
          // Both routes Cargo builds a test binary from, because a target is
          // live at either — the one statement of that pair, which the
          // membership leg reads its own population through.
          const routes = cargoTargetRoutes(target, rustKillSet);
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
    const table = readScopeTable(docSource, mutateScope.clause, mutateScope.header);
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

/* ── The kill-set membership criterion ───────────────────────────────────── */

/**
 * The membership criterion the mutation-strategy document states
 * (docs/test/strategy/mutation.md §MUT-7) reads a package's own tree through
 * these constants. `scopeProperty` is the array a JavaScript configuration
 * states its mutate scope as — read through the SAME tokenizer surface the
 * staleness half reads its command list through, never a second model of the
 * same file. The rest describe the shapes the specifier walk resolves by:
 * `packages` is the directory each platform package sits under, `syncedTree`
 * the per-package copy of the shared source the build writes there, and
 * `generatedRoot` the import validators that build generates. The property
 * classifier's own constants sit beside them: `propertyClass` is the filename
 * class a suite declares itself a property suite by, `propertyRunner` the
 * package whose runner carries no regression-persistence mechanism, and
 * `runnerAssertion` the member call through which that runner drives a case.
 * `caseCalls` names the calls a test case is declared by — the same
 * declaration model the clause-registry check resolves a row's named cases
 * through.
 */
export const JS_MEMBERSHIP = {
  scopeProperty: 'mutate',
  packages: 'packages',
  syncedTree: 'shared',
  generatedRoot: 'packages/shared/generated',
  generatedSegment: 'generated',
  propertyClass: '*.property.test.js',
  propertyRunner: 'fast-check',
  runnerAssertion: 'assert',
  caseCalls: ['it', 'test'],
};

/**
 * The Rust side of the same criterion. `manifest` states the crate's library
 * name, which is the root a test binary reaches the crate's modules through;
 * `src` is the module tree those paths resolve into, `mod` the file a directory
 * module is written in, and `suffix` the one a file module is. `lib` is the
 * fixed in-module entry of the cargo kill set — a member that is not a test
 * surface — and `integrationImport` the crate whose import classifies a binary
 * as one that synthesises real OS input, which the strategy document states as
 * the reason those binaries stay out of the per-mutant runs.
 */
export const RUST_MEMBERSHIP = {
  manifest: 'packages/desktop/src-tauri/Cargo.toml',
  src: 'src',
  mod: 'mod.rs',
  suffix: '.rs',
  lib: '--lib',
  integrationImport: 'enigo',
};

/**
 * The membership allowlist: the entries the criterion places on one side and
 * review has ruled onto the other, each with the ground that ruling stands on.
 * `surface` is the configuration the entry answers for, `leg` which of the two
 * legs it excuses, and `entry` the test surface or module it names.
 *
 * An entry is held from both sides: it excuses what it names, and it is itself
 * held live — an entry no leg needs any more is reported as stale, so an
 * exclusion outlives its reason no more quietly than the drift it was recorded
 * against.
 */
export const MEMBERSHIP_ALLOWLIST = [
  {
    surface: 'stryker.config.mjs',
    leg: 'test-surface',
    entry: 'packages/shared/tests/unit/performance.test.js',
    reason:
      'asserts wall-clock budgets over the shared data layer, so what kills a mutant there is the machine the run happens to be on rather than the fault — fast, and for that reason not deterministic',
  },
  {
    surface: 'stryker.config.mjs',
    leg: 'module',
    entry: 'packages/shared/views/adapter.js',
    reason:
      'the file declares the PlatformAdapter typedef and carries no runtime behaviour, so it states nothing a mutant can change and nothing a test could kill',
  },
  {
    surface: 'packages/desktop/src-tauri/.cargo/mutants.toml',
    leg: 'test-surface',
    entry: 'capture_lifecycle_test',
    reason:
      'it drives the capture layer through process-global input hooks and runs serially against them, so it is not runnable once per mutant',
  },
];

/** The two legs an allowlist entry can excuse, named where they are computed. */
const MEMBERSHIP_LEGS = { surface: 'test-surface', module: 'module' };

/**
 * Compile a path glob to an anchored matcher: `*` stays inside one path
 * segment, `**` as a WHOLE segment crosses any depth. It answers with an
 * `error` rather than throwing, because a pattern this reader does not model
 * has to red as machinery in the middle of a run rather than abort it — which
 * is the one difference from the area map's own compiler, which takes these
 * `*`/`**` semantics from here for the map's patterns and refuses a pattern
 * outside that closed world outright, as a shape error
 * ([`check-area-map.js`](./check-area-map.js)).
 * @param {string} pattern a path glob, e.g. `packages/shared/lib/**\/*.js`
 * @returns {{ regex: RegExp } | { error: string }}
 */
export function pathGlobToRegExp(pattern) {
  if (/[?[\]{}!]/.test(pattern)) {
    return { error: `carries syntax this reader does not model — it reads \`*\` inside one path segment and \`**\` as a whole segment` }; // prettier-ignore
  }
  const segments = pattern.split('/');
  let source = '^';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === '**') {
      source += last ? '(?:.*)?' : '(?:[^/]+/)*';
      continue;
    }
    if (segment.includes('**')) {
      return { error: `writes \`**\` inside the segment \`${segment}\`, and this reader models it only as a whole segment` }; // prettier-ignore
    }
    source += segment.split('*').map(escapeForRegExp).join('[^/]*');
    if (!last) source += '/';
  }
  return { regex: new RegExp(`${source}$`) };
}

/** The package a repo-relative path belongs to, or null for one outside them all. */
function packageOf(path, packages) {
  const segments = path.split('/');
  return segments[0] === packages && segments.length > 1 ? `${packages}/${segments[1]}` : null;
}

/**
 * The LITERAL module specifiers a JavaScript source states — a static `import`,
 * a dynamic `import()`, and the re-exporting `export … from '…'` — read off the
 * token stream, which drops comments, so a JSDoc `import()` annotation is never
 * an edge.
 *
 * A re-export is an edge like any other: a file reaches, through a barrel, every
 * module the barrel re-exports, and a walk blind to that form would classify a
 * surface that really does exercise a mutated module as reaching nothing. That
 * is a SILENT PASS in the unlisted-members direction — the surface simply never
 * belongs, so nothing reds — as well as a false red in the module-leg direction,
 * which is why it is read rather than left as a limit. It is recognised by
 * shape: `export` followed by `*` or by a clause in braces, whose specifier is
 * the string literal a `from` stands immediately before, so `export { local }`
 * and `export const …` — which name no module — contribute none.
 *
 * One named honest limit, a silence rather than a guess: a dynamic `import()`
 * whose argument is not a string literal states no specifier this scan can read,
 * so it is a NON-EDGE and is counted rather than refused — the module it loads
 * is chosen at runtime and no static reader can name it.
 * @param {string} source JavaScript source text
 * @returns {{ literal: string[], computed: number }}
 */
export function importSpecifiers(source) {
  const tokens = tokenizeJs(source);
  const literal = [];
  let computed = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'word') continue;
    const next = tokens[i + 1];
    if (next === undefined) continue;
    if (tokens[i].value === 'export') {
      // Only the two re-exporting shapes name a module; every other `export`
      // states something the file itself declares.
      if (next.type !== 'punct' || (next.value !== '*' && next.value !== '{')) continue;
      for (let j = i + 2; j < tokens.length; j++) {
        const token = tokens[j];
        if (token.type === 'punct' && token.value === ';') break;
        if (token.type === 'word' && (token.value === 'import' || token.value === 'export')) break;
        if (token.type === 'string') {
          // The `from` is what makes the literal a specifier rather than the
          // next statement's own string, which a clause without one runs into.
          if (tokens[j - 1]?.type === 'word' && tokens[j - 1].value === 'from') {
            literal.push(token.value);
          }
          break;
        }
      }
      continue;
    }
    if (tokens[i].value !== 'import') continue;
    // `import.meta` is a property access, not an import declaration.
    if (next.type === 'punct' && next.value === '.') continue;
    if (next.type === 'punct' && next.value === '(') {
      const argument = tokens[i + 2];
      if (argument?.type === 'string') literal.push(argument.value);
      else computed++;
      continue;
    }
    // A static declaration's specifier is the first string literal standing
    // before the declaration ends — the clause list between them is bindings.
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (token.type === 'string') {
        literal.push(token.value);
        break;
      }
      if (token.type === 'punct' && token.value === ';') break;
      if (token.type === 'word' && (token.value === 'import' || token.value === 'export')) break;
    }
  }
  return { literal, computed };
}

/** The classes a specifier resolves into — total by construction, one of these always. */
export const SPECIFIER_CLASSES = {
  dependency: 'dependency',
  followed: 'followed',
  outOfPackage: 'out-of-package',
  syncedShared: 'synced-shared',
  generated: 'generated',
  unresolved: 'unresolved',
};

/**
 * Classify one import specifier, by PATH SHAPE rather than by disk state, so
 * the answer is the same in every checkout:
 *
 *   - a BARE specifier — one opening on neither `./` nor `../` — is the
 *     dependency class (a node builtin, an installed package), terminated by
 *     definition, since only a relative specifier resolves into this tree;
 *   - a relative specifier resolving to a GENERATED validator, in the shared
 *     tree or in a synced copy of it, is terminated-known: a build product
 *     whose source is the schema layers;
 *   - one resolving into a package's SYNCED `shared/` copy is terminated-known,
 *     resolved by the sync doctrine to its tracked source and then terminated
 *     as that other package's file;
 *   - one resolving to a tracked file in the importer's OWN package is
 *     followed — the only class that extends reachability;
 *   - one resolving to a tracked file in another package or outside them all is
 *     terminated-known;
 *   - anything left is UNRESOLVED, which the walk refuses as machinery.
 *
 * Confinement has precedence over the terminated classes: they exist to keep a
 * known specifier out of the refusal, never to extend reach. A kill set is
 * per-package, so a file in another package's tree reaches nothing in this
 * one's scope, whichever of the terminated classes named it.
 * @param {string} specifier the specifier as written
 * @param {string} from the repo-relative path of the file stating it
 * @param {Set<string>} tracked every tracked repo-relative path
 * @param {typeof JS_MEMBERSHIP} shape the tree shapes the classes are read by
 * @returns {{ class: string, path?: string }}
 */
export function classifySpecifier(specifier, from, tracked, shape = JS_MEMBERSHIP) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return { class: SPECIFIER_CLASSES.dependency };
  }
  const path = normalizePath(`${dirname(from)}/${specifier}`);
  const segments = path.split('/');
  const synced =
    segments[0] === shape.packages && segments.length > 3 && segments[2] === shape.syncedTree;
  if (
    path.startsWith(`${shape.generatedRoot}/`) ||
    (synced && segments[3] === shape.generatedSegment)
  ) {
    // prettier-ignore
    return { class: SPECIFIER_CLASSES.generated, path };
  }
  if (synced) return { class: SPECIFIER_CLASSES.syncedShared, path };
  if (!tracked.has(path)) return { class: SPECIFIER_CLASSES.unresolved, path };
  const home = packageOf(path, shape.packages);
  return home !== null && home === packageOf(from, shape.packages)
    ? { class: SPECIFIER_CLASSES.followed, path }
    : { class: SPECIFIER_CLASSES.outOfPackage, path };
}

/**
 * The files one JavaScript entry point reaches: transitive import reachability
 * confined to the entry's own package tree, walked breadth-first over the
 * followed class alone. The entry itself is in the answer, which costs nothing
 * — a test file is never a mutated module — and keeps the walk's own bookkeeping
 * the set it returns.
 * @param {string} entry the repo-relative path to walk from
 * @param {object} how the walk's inputs
 * @param {Set<string>} how.tracked every tracked repo-relative path
 * @param {(f: string) => ({ literal: string[], computed: number } | null)} how.specifiers
 *   one file's specifiers, or null where it could not be read
 * @param {typeof JS_MEMBERSHIP} [how.shape]
 * @returns {{ reached: Set<string>, refusals: string[] }}
 */
export function reachableFiles(entry, { tracked, specifiers, shape = JS_MEMBERSHIP }) {
  const reached = new Set([entry]);
  const refusals = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    const stated = specifiers(file);
    if (stated === null) {
      refusals.push(`${file}: reached by the import walk but could not be read, so what it reaches is unknown`); // prettier-ignore
      continue;
    }
    for (const specifier of stated.literal) {
      const read = classifySpecifier(specifier, file, tracked, shape);
      if (read.class === SPECIFIER_CLASSES.unresolved) {
        refusals.push(`${file}: states \`${specifier}\`, which resolves by path shape to ${read.path} — no tracked file, no synced \`${shape.syncedTree}/\` copy, and no generated validator, so it falls into no class this walk reads`); // prettier-ignore
        continue;
      }
      if (read.class !== SPECIFIER_CLASSES.followed) continue;
      if (reached.has(read.path)) continue;
      reached.add(read.path);
      queue.push(read.path);
    }
  }
  return { reached, refusals };
}

/**
 * Classify a JavaScript test surface against the property runner, with
 * DECLARED CLASS FIRST: a file in the `*.property.test.js` class is a property
 * suite by its own declaration, whatever plain cases it also carries, and its
 * plain cases are that suite's scaffolding. Outside the class the file is
 * judged by content — every case driving the unseeded runner makes the file
 * one too; a MIXED file, whose property cases sit beside plain ones, is
 * admitted on its plain cases, and the residual property cases are the named,
 * accepted residue the leg enumerates rather than hides.
 *
 * What "unseeded" names is the runner's own mechanism, never a file's state: a
 * property runner that carries no regression-persistence mechanism replays no
 * failure it once found, so a case it drives answers differently from run to
 * run by construction.
 * @param {string} file the repo-relative path (its name declares the class)
 * @param {string} source the file's text
 * @param {typeof JS_MEMBERSHIP} [shape]
 * @returns {{ kind: 'declared'|'all-property'|'mixed'|'plain', property: number,
 *   cases: number } | { error: string }}
 */
export function classifyTestSurface(file, source, shape = JS_MEMBERSHIP) {
  if (basenameGlobToRegExp(shape.propertyClass).test(basename(file))) {
    return { kind: 'declared', property: 0, cases: 0 };
  }
  const tokens = tokenizeJs(source);
  let binding = null;
  let importsRunner = false;
  for (let i = 0; i + 3 < tokens.length; i++) {
    if (tokens[i].type !== 'word' || tokens[i].value !== 'import') continue;
    const specifier = tokens[i + 3];
    if (specifier?.type !== 'string' || specifier.value !== shape.propertyRunner) continue;
    importsRunner = true;
    if (tokens[i + 1].type === 'word' && tokens[i + 2].value === 'from') binding = tokens[i + 1].value; // prettier-ignore
  }
  if (!importsRunner) {
    for (const specifier of importSpecifiers(source).literal) {
      if (specifier === shape.propertyRunner) importsRunner = true;
    }
  }
  if (importsRunner && binding === null) {
    return { error: `imports \`${shape.propertyRunner}\` in a form this reader cannot bind to a name — it reads the default import \`import <name> from '${shape.propertyRunner}'\`, and without the name it cannot tell a property case from a plain one` }; // prettier-ignore
  }
  let cases = 0;
  let property = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'word' || !shape.caseCalls.includes(token.value)) continue;
    // A bare call declares a case; a member call — `it.skip`, `it.only`,
    // another object's own `it` — declares none, which is the declaration model
    // the registry's own case reader states.
    if (tokens[i + 1]?.type !== 'punct' || tokens[i + 1].value !== '(') continue;
    if (tokens[i - 1]?.type === 'punct' && tokens[i - 1].value === '.') continue;
    cases++;
    let depth = 0;
    let drivesRunner = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const inner = tokens[j];
      if (inner.type === 'punct' && OPENERS.includes(inner.value)) depth++;
      else if (inner.type === 'punct' && CLOSERS.includes(inner.value)) {
        depth--;
        if (depth === 0) break;
      } else if (
        binding !== null &&
        inner.type === 'word' &&
        inner.value === binding &&
        tokens[j + 1]?.value === '.' &&
        tokens[j + 2]?.value === shape.runnerAssertion
      ) {
        drivesRunner = true;
      }
    }
    if (drivesRunner) property++;
  }
  if (cases === 0) {
    return { error: `states no test case this reader can see — a case is a bare \`${shape.caseCalls.join('`/`')}\` call, and a surface stating none cannot be classified against the property runner` }; // prettier-ignore
  }
  if (property === cases) return { kind: 'all-property', property, cases };
  return { kind: property > 0 ? 'mixed' : 'plain', property, cases };
}

/**
 * A `cfg(test)` attribute applied to the bare predicate `test`, with the
 * whitespace Rust allows around each token, in both spellings the attribute is
 * written in: the outer `#[cfg(test)]`, which gates the item written after it,
 * and the inner `#![cfg(test)]`, which gates what it is written INSIDE — the
 * enclosing block, where one is open at that point, and the rest of the file
 * where none is. `#[cfg(all(test, …))]` is left out even though it is test-only
 * too, and `#[cfg(any(…, test))]`, `#[cfg(not(test))]` and `#[cfg_attr(test, …)]`
 * are left out because they are NOT: the `any`, `not` and `cfg_attr` forms gate
 * an item INTO a non-test build (or, for `cfg_attr`, gate no item at all — only
 * an attribute on one that always compiles), so blanking them would take a real
 * edge out of the view. The two directions fail differently, which is what
 * fixes the width of this match: reading one edge too many credits a binary
 * with reach the compiled crate does not give it and hides a gap, while reading
 * one edge too few reds a scope module the kill set really does exercise. `cfg(all(test, …))`
 * has a ground of its own for standing outside the match: the compound forms are
 * absent from the crate today, and a predicate reader for a shape that has not
 * appeared would be an untested surface of this check, so the match is held to
 * the bare predicate until the shape is written.
 */
const RUST_CFG_TEST_RE = /#\s*!?\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;

/**
 * What an inner `#![cfg(test)]` at `index` gates, as a half-open character
 * range: the block still open around it — from its `{` through the `}` that
 * closes it, or to the end of a view that never closes it — and, where no block
 * is open there, the attribute's own file from the attribute onward.
 * @param {string} view a comment-stripped, string-blanked Rust view
 * @param {number} index where the attribute starts in it
 * @returns {[number, number]} the range to blank, start inclusive, end exclusive
 */
function innerAttributeExtent(view, index) {
  const open = [];
  for (let i = 0; i < index; i++) {
    if (view[i] === '{') open.push(i);
    else if (view[i] === '}') open.pop();
  }
  if (open.length === 0) return [index, view.length];
  const start = open[open.length - 1];
  let depth = 0;
  for (let i = start; i < view.length; i++) {
    if (view[i] === '{') depth++;
    else if (view[i] === '}') {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  return [start, view.length];
}

/**
 * Blank what a `cfg(test)` attribute gates — the item an outer `#[cfg(test)]`
 * is written before, and what an inner `#![cfg(test)]` is written inside — on
 * the comment-stripped, string-blanked view, keeping every other character's
 * offset and every newline the way the views this runs on do.
 *
 * The reach walk asks what a TEST BINARY reaches through the crate, and the
 * crate is compiled as that binary's dependency — without `--cfg test` — so an
 * item inside a `#[cfg(test)]` block is not in the binary it links. A `use` read
 * there is an edge the compiled binary does not have, and crediting it both
 * places a listed binary in the kill set on reach it lacks and calls a
 * mutate-scope module reached when nothing the kill set runs exercises it —
 * a gap reported as covered, which is the failure this view exists to avoid.
 *
 * What an OUTER attribute gates is found by shape rather than parsed: from the
 * end of the attribute the scan runs to the first `;` outside every bracket —
 * the item form that ends in one, `use …;` and `mod …;` among them — or to the
 * `}` that closes the first `{` it opens, which is the block form,
 * `mod tests { … }` among them. Stacked attributes need no case of their own:
 * `#[allow(…)]` between the gate and its item opens and closes its own bracket
 * and the scan runs on through it. An item that never closes blanks to the end
 * of the file, which is the conservative direction for a source no compiler
 * would take.
 *
 * An INNER attribute is read from the other side, since what it gates is
 * written around it: where a `{` is still open at that point, its block is
 * blanked from that brace through the `}` that closes it, and where none is —
 * the attribute at the top of a file — the blanking runs from the attribute to
 * the end of the view, which is the whole of what a file-level gate takes.
 * @param {string} view a comment-stripped, string-blanked Rust view
 * @returns {string} the same view with what each `cfg(test)` attribute gates
 *   blanked
 */
function stripRustCfgTest(view) {
  const out = view.split('');
  const n = view.length;
  const blank = (from, to) => {
    for (let k = from; k < Math.min(to, n); k++) if (out[k] !== '\n') out[k] = ' ';
  };
  for (const match of view.matchAll(RUST_CFG_TEST_RE)) {
    if (match[0].includes('!')) {
      blank(...innerAttributeExtent(view, match.index));
      continue;
    }
    let depth = 0;
    let opened = false;
    let i = match.index + match[0].length;
    for (; i < n; i++) {
      const c = view[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === '{') {
        depth++;
        opened = true;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && opened) {
          i++;
          break;
        }
      } else if (c === ';' && depth === 0) {
        i++;
        break;
      }
    }
    blank(match.index, i);
  }
  return out.join('');
}

/** A `use` declaration as the module walk reads one, on a comment-stripped view. */
const RUST_USE_RE = /(^|[\s{};])(pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/g;

/**
 * The module paths one `use` declaration's path text names: the path itself,
 * and — where it opens a brace group — each item inside it joined to the prefix,
 * since a group can name modules as readily as items. A trailing `as` rename
 * and a trailing glob are dropped, both naming the same module either way.
 * @param {string} text one declaration's path text, without `use` and `;`
 * @returns {string[]} candidate `::`-joined paths
 */
export function useTargets(text) {
  const flat = flattenWhitespace(text);
  const open = flat.indexOf('{');
  const strip = (path) => path.replace(/\s+as\s+\w+$/, '').replace(/::\s*\*$/, '').trim(); // prettier-ignore
  if (open === -1) return flat === '' ? [] : [strip(flat)];
  const prefix = flat.slice(0, open).trim();
  // The prefix names a module in its own right — `use super::{A, B}` reaches
  // the parent whatever the braces then take from it — so it is emitted
  // without the separator that introduces the group.
  const head = prefix.replace(/::$/, '').trim();
  const targets = head === '' ? [] : [strip(head)];
  let depth = 0;
  let item = '';
  for (let i = open; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (item.trim() !== '') targets.push(...useTargets(`${prefix}${item.trim()}`));
        break;
      }
    } else if (ch === ',' && depth === 1) {
      if (item.trim() !== '') targets.push(...useTargets(`${prefix}${item.trim()}`));
      item = '';
      continue;
    }
    item += ch;
  }
  return [...new Set(targets.filter((t) => t !== '' && !t.endsWith('::')))];
}

/**
 * The `use` declarations a Rust source states, read on a view with comments
 * stripped AND string-literal contents blanked, so neither a doc comment naming
 * a crate nor a `use` line quoted inside a string is read as a declaration this
 * file makes. Both views are needed and neither answers for the other: a
 * declaration is what the source DOES, and the text it merely quotes about one —
 * a fixture source a test carries, an error message spelling a `use` line — is
 * not that. `reexports` counts the `pub use` declarations, which the module
 * mapping's soundness premise forbids: a re-export lets a `use` path name an
 * item some other module defines, and the mapping from a path to the module file
 * that answers it would then be wrong rather than merely incomplete — so a
 * quoted `pub use` refusing the whole Rust relation would be a refusal standing
 * on text.
 *
 * `skipCfgTest` takes what a `cfg(test)` attribute gates out of the view the
 * EDGE walk reads ({@link stripRustCfgTest}), which is what a source compiled
 * WITHOUT `--cfg test` states — the crate as a test binary links it. It is off
 * by default and asked for per file, because the same reader answers for both
 * sides of the walk and they are compiled differently: an integration binary IS
 * built with `--cfg test`, so a block inside one is code it really carries.
 * One scan over the blanked source answers both readings: a `pub use` counts
 * toward the re-export total wherever it is written — the rule is stated on the
 * source text, so a test-only re-export is refused with the rest rather than
 * modelled — while every other declaration states an edge only where the
 * declaration's own text still stands at its offset in the gated reading. That
 * comparison runs from `use`, past the separator character the pattern took
 * ahead of it, since the blanking can consume that separator while the
 * declaration after it still stands; {@link stripRustCfgTest} blanks in place,
 * so one offset addresses both views.
 * @param {string} source Rust source text
 * @param {object} [how] how the source is read
 * @param {boolean} [how.skipCfgTest] read its edges as compiled without `--cfg test`
 * @returns {{ targets: string[], reexports: number }}
 */
export function rustUseTargets(source, { skipCfgTest = false } = {}) {
  const blanked = blankRustStrings(stripRustComments(source));
  const view = skipCfgTest ? stripRustCfgTest(blanked) : blanked;
  const targets = [];
  let reexports = 0;
  for (const match of blanked.matchAll(RUST_USE_RE)) {
    if (match[2] !== undefined) {
      reexports++;
      continue;
    }
    if (view.startsWith(match[0].slice(match[1].length), match.index + match[1].length))
      targets.push(...useTargets(match[3]));
  }
  return { targets: [...new Set(targets)], reexports };
}

/**
 * Resolve one `use` path to the crate module file that answers it, by the
 * longest prefix the tree carries a module for. A `mod` declaration states
 * where a module LIVES rather than what it needs, so it is not an edge:
 * following one would let any path into a parent module reach every child, and
 * the reaching arm would be near-total.
 *
 * A path rooted at `crate`, at the crate's library name, at `self`, or at
 * `super` is resolved from the crate root down, the root itself included — a
 * path naming an item the root module states resolves to that module. A UNIFORM
 * path — the form that names a crate-root module without a `crate::` prefix —
 * is resolved only where its FIRST segment names a module of this crate, since
 * every external crate's path is written the same way and resolving down to the
 * root would otherwise claim them all as crate edges.
 * @param {string} path a `::`-joined use path
 * @param {string[] | null} from the module path of the file stating it, or null
 *   for a test binary, which reaches the crate only through its library name
 * @param {object} how the crate's shape
 * @param {string[]} how.roots the path roots that enter the crate (`crate`, the library name)
 * @param {Map<string, string>} how.modules module path (`::`-joined) → repo-relative file
 * @returns {string | null} the module file, or null for a path outside the crate
 */
export function resolveUsePath(path, from, { roots, modules }) {
  const segments = path.split('::').map((s) => s.trim()).filter(Boolean); // prettier-ignore
  if (segments.length === 0) return null;
  let base = [];
  let rest = segments;
  let floor = 0;
  if (roots.includes(segments[0])) rest = segments.slice(1);
  else if (from === null) return null;
  else if (segments[0] === 'self') {
    base = from;
    rest = segments.slice(1);
  } else if (segments[0] === 'super') {
    base = from;
    rest = segments;
    while (rest[0] === 'super' && base.length > 0) {
      base = base.slice(0, -1);
      rest = rest.slice(1);
    }
    if (rest[0] === 'super') return null; // past the crate root
  } else {
    floor = 1; // a uniform path, held to naming a crate module outright
  }
  const candidate = [...base, ...rest];
  for (let k = candidate.length; k >= floor; k--) {
    const file = modules.get(candidate.slice(0, k).join('::'));
    if (file !== undefined) return file;
  }
  return null;
}

/**
 * The crate's library name, which is the root a test binary reaches its modules
 * through: the `[lib]` table's `name` where the manifest states one, and
 * otherwise the package name with `-` read as `_`, which is what Cargo derives.
 * @param {string} manifest the crate manifest's text
 * @returns {{ name: string } | { error: string }}
 */
export function crateLibraryName(manifest) {
  const lines = manifest.split(/\r?\n/).map(stripTomlComment);
  const named = { lib: null, package: null };
  let table = '';
  for (const line of lines) {
    const read = readTomlLine(line);
    if (read === null) continue;
    if (read.header !== undefined) {
      table = read.header;
      continue;
    }
    const at = read.within ? `${table ? `${table}.` : ''}${read.within}` : table;
    if (read.key !== 'name' || !(at in named) || named[at] !== null) continue;
    const value = /^\s*['"]([^'"]*)['"]/.exec(line.slice(line.indexOf('=') + 1));
    if (value !== null) named[at] = value[1];
  }
  if (named.lib !== null) return { name: named.lib };
  if (named.package !== null) return { name: named.package.replace(/-/g, '_') };
  return { error: `states no \`name\` in its \`[lib]\` or \`[package]\` table, so the root a test binary reaches this crate's modules through cannot be read` }; // prettier-ignore
}

/**
 * Pure core: audit the kill-set MEMBERSHIP the staleness half deliberately
 * leaves open. Two legs, both engines, each diffed in both directions:
 *
 *   - the TEST-SURFACE leg classifies the population each engine's own
 *     registered RUNNER selects — on JavaScript every member of the registered
 *     `node --test` suites under that package, on Rust every binary of the
 *     registered cargo suite — each with a class of its own taken out by
 *     classification, the two standing in the same place: the property suites
 *     there, the `enigo`-classified integration binaries here. What is left to
 *     decide on either is reaching or not-reaching, and the configuration's list
 *     is held to the reaching members: one that belongs and is not listed reds,
 *     and a listed one that does not belong reds with the reason it does not;
 *   - the MODULE leg holds every module of a configuration's mutate scope to
 *     being reached by at least one LISTED test surface, so a module nothing in
 *     the kill set exercises cannot sit in the scope silently. On the Rust side
 *     the in-module entry does not satisfy it: a module's own `#[cfg(test)]`
 *     block would make that leg green by construction, and a module only its own
 *     in-module tests exercise is a decision to take rather than one to hide.
 *
 * Both legs are excused only through {@link MEMBERSHIP_ALLOWLIST}, whose
 * entries are themselves held live.
 * @param {object} opts
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable)
 * @param {typeof JS_KILL_SETS} [opts.jsKillSets]
 * @param {typeof RUST_KILL_SET} [opts.rustKillSet]
 * @param {typeof MUTATE_SCOPE} [opts.mutateScope]
 * @param {typeof JS_MEMBERSHIP} [opts.jsMembership]
 * @param {typeof RUST_MEMBERSHIP} [opts.rustMembership]
 * @param {typeof MEMBERSHIP_ALLOWLIST} [opts.allowlist]
 * @param {typeof DOC_INVENTORIES} [opts.inventories]
 * @returns {{ unlistedMember: string[], listedNonMember: string[],
 *             unreachableScopeModule: string[], staleMembershipAllowlist: string[],
 *             unreadableMembership: string[], admittedMixed: Record<string, string[]> }}
 */
export function auditKillSetMembership({
  files,
  readFile,
  jsKillSets = JS_KILL_SETS,
  rustKillSet = RUST_KILL_SET,
  mutateScope = MUTATE_SCOPE,
  jsMembership = JS_MEMBERSHIP,
  rustMembership = RUST_MEMBERSHIP,
  allowlist = MEMBERSHIP_ALLOWLIST,
  inventories = DOC_INVENTORIES,
}) {
  const result = {
    unlistedMember: [],
    listedNonMember: [],
    unreachableScopeModule: [],
    staleMembershipAllowlist: [],
    unreadableMembership: [],
    // The accepted, named residue, stated rather than hidden: the mixed
    // surfaces the property arm admits on their plain cases, whose remaining
    // property cases answer differently from run to run. It is an object, not a
    // list, so the report driver — which renders every list field as a problem
    // class — passes over it and the caller states it as the residue it is.
    admittedMixed: {},
  };
  const tracked = new Set(files);
  const sources = new Map();
  const readSource = (path) => {
    if (!sources.has(path)) sources.set(path, readFile(path));
    return sources.get(path);
  };
  const specifierCache = new Map();
  const specifiers = (path) => {
    if (!specifierCache.has(path)) {
      const source = readSource(path);
      specifierCache.set(path, source == null ? null : importSpecifiers(source));
    }
    return specifierCache.get(path);
  };
  const used = new Set();
  /** The recorded exclusion for one entry, marked live by the asking. */
  const excuse = (surface, leg, entry) => {
    const found = allowlist.find(
      (a) => a.surface === surface && a.leg === leg && a.entry === entry,
    );
    if (found === undefined) return null;
    used.add(found);
    return found;
  };
  /** Expand one glob-or-literal scope entry against the tree, or refuse it. */
  const expand = (pattern, where) => {
    const compiled = pathGlobToRegExp(pattern);
    if (compiled.error) {
      result.unreadableMembership.push(`${where}: the pattern ${pattern} ${compiled.error}`);
      return [];
    }
    const selected = files.filter((f) => compiled.regex.test(f));
    if (selected.length === 0) {
      result.unreadableMembership.push(`${where}: the pattern ${pattern} expands against the tree to no tracked file, so the scope this leg holds is empty where it reads it`); // prettier-ignore
    }
    return selected;
  };

  /* ── JavaScript: one configuration at a time ───────────────────────────── */
  const configPattern = basenameGlobToRegExp(jsKillSets.glob);
  for (const config of files.filter((f) => configPattern.test(f))) {
    const source = readSource(config);
    if (source == null) continue; // the staleness leg reports the unreadable file
    const scope = readPropertyStringArray(source, jsMembership.scopeProperty);
    if (scope.error) {
      result.unreadableMembership.push(`${config}: ${scope.error}, so the mutate scope both legs are measured against is not where they read it`); // prettier-ignore
      continue;
    }
    const scopeFiles = new Set(scope.entries.flatMap((p) => expand(p, config)));
    if (scopeFiles.size === 0) continue;
    const homes = new Set([...scopeFiles].map((f) => packageOf(f, jsMembership.packages)));
    if (homes.size !== 1 || homes.has(null)) {
      result.unreadableMembership.push(`${config}: its \`${jsMembership.scopeProperty}\` scope spans ${homes.size} package tree(s) (${[...homes].join(', ')}), and a kill set is per-package, so which package's suite this configuration answers for cannot be read`); // prettier-ignore
      continue;
    }
    const home = [...homes][0];
    const suites = inventories.filter(
      (i) => i.discovery?.runner === RUNNERS.node && i.dir.startsWith(`${home}/`),
    );
    if (suites.length === 0) {
      result.unreadableMembership.push(`${config}: no registered node-test suite lives under ${home}/, so the population of test surfaces this configuration's list is held against is not where this leg reads it`); // prettier-ignore
      continue;
    }
    const candidates = [];
    for (const suite of suites) {
      for (const file of files) {
        if (dirname(file) === suite.dir && suite.selects(basename(file))) candidates.push(file);
      }
    }
    if (candidates.length === 0) {
      result.unreadableMembership.push(`${config}: the registered suite(s) under ${home}/ select no tracked file, so this leg would hold the list against nothing`); // prettier-ignore
      continue;
    }

    const belongs = new Set();
    const reason = new Map();
    const reachedBy = new Map();
    for (const candidate of candidates) {
      const text = readSource(candidate);
      if (text == null) {
        result.unreadableMembership.push(`${candidate}: a member of a registered suite this configuration's kill set is held against, which could not be read`); // prettier-ignore
        continue;
      }
      const classified = classifyTestSurface(candidate, text, jsMembership);
      if (classified.error) {
        result.unreadableMembership.push(`${candidate}: ${classified.error}`);
        continue;
      }
      if (classified.kind === 'declared' || classified.kind === 'all-property') {
        reason.set(candidate, classified.kind === 'declared'
          ? `is a \`${jsMembership.propertyClass}\` file, so it declares itself a property suite driven by an unseeded runner`
          : `states only cases driving the unseeded \`${jsMembership.propertyRunner}\` runner, so nothing in it answers the same way twice`); // prettier-ignore
        continue;
      }
      const walk = reachableFiles(candidate, { tracked, specifiers, shape: jsMembership });
      result.unreadableMembership.push(...walk.refusals);
      const reaches = [...walk.reached].some((f) => scopeFiles.has(f));
      reachedBy.set(candidate, walk.reached);
      if (!reaches) {
        reason.set(candidate, `reaches no module of this configuration's \`${jsMembership.scopeProperty}\` scope, so no mutant it seeds can fail it`); // prettier-ignore
        continue;
      }
      // A recorded exclusion is consulted HERE, where the criterion would place
      // the surface in — which is what makes the entry live while the ruling it
      // records still has something to rule on, and stale the moment it does not.
      const ruled = excuse(config, MEMBERSHIP_LEGS.surface, candidate);
      if (ruled !== null) {
        reason.set(candidate, ruled.reason);
        continue;
      }
      if (classified.kind === 'mixed') (result.admittedMixed[config] ??= []).push(candidate);
      belongs.add(candidate);
    }

    const command = readPropertyStringArray(source, jsKillSets.property);
    if (command.error) continue; // the staleness leg reports an unreadable list
    const invocation = nodeTestArguments(command.entries.join(' '));
    if (invocation.error || (invocation.args ?? []).length === 0) continue; // reported there too
    const listed = new Set();
    for (const argument of invocation.args) {
      const path = normalizePath(argument);
      const read = classifyArgument(path);
      if (read.error) continue; // the staleness leg reports it
      if (read.kind === 'glob') {
        const selects = basenameGlobToRegExp(read.pattern);
        for (const file of files) {
          if (dirname(file) === read.dir && selects.test(basename(file))) listed.add(file);
        }
        continue;
      }
      listed.add(path);
    }

    for (const member of candidates) {
      if (!belongs.has(member) || listed.has(member)) continue;
      result.unlistedMember.push(`${member} reaches this configuration's \`${jsMembership.scopeProperty}\` scope and is a fast, deterministic member of a registered suite, but ${config}'s \`${jsKillSets.property}\` does not list it — so the weekly run seeds mutants no test of it can kill`); // prettier-ignore
    }
    for (const entry of listed) {
      if (belongs.has(entry)) continue;
      const why = reason.get(entry) ?? `is not a member of any registered suite under ${home}/, so this leg cannot classify it against the criterion`; // prettier-ignore
      result.listedNonMember.push(`${config}'s \`${jsKillSets.property}\` lists ${entry}, which ${why}`); // prettier-ignore
    }

    for (const module of scopeFiles) {
      const reached = [...listed].some((entry) => reachedBy.get(entry)?.has(module));
      if (reached) continue;
      if (excuse(config, MEMBERSHIP_LEGS.module, module) !== null) continue;
      result.unreachableScopeModule.push(`${module} is in ${config}'s \`${jsMembership.scopeProperty}\` scope, and no test surface its \`${jsKillSets.property}\` lists reaches it — every mutant seeded there survives by construction`); // prettier-ignore
    }
  }

  /* ── Rust: the crate's binaries against the same criterion ─────────────── */
  const cargo = inventories.find((i) => i.discovery?.runner === RUNNERS.cargo);
  const manifestSource = readSource(rustMembership.manifest);
  const scopeSource = readSource(mutateScope.config);
  const killSetSource = readSource(rustKillSet.config);
  if (cargo === undefined) {
    result.unreadableMembership.push(`${SELF_PATH}: no registered cargo suite states the tree the Rust kill set's members live in, so this leg has no population to classify`); // prettier-ignore
  } else if (manifestSource == null) {
    result.unreadableMembership.push(`${rustMembership.manifest}: the crate manifest this leg reads the library name from could not be read`); // prettier-ignore
  } else if (scopeSource != null && killSetSource != null) {
    const library = crateLibraryName(manifestSource);
    const scope = readTomlStringArray(scopeSource, mutateScope.key);
    const list = readTomlStringArray(killSetSource, rustKillSet.key);
    if (library.error)
      result.unreadableMembership.push(`${rustMembership.manifest}: ${library.error}`); // prettier-ignore
    else if (scope.error || list.error) {
      // The staleness leg reports an unreadable list; this leg simply has none.
    } else {
      const crateRoot = `${mutateScope.root}/${rustMembership.src}`;
      const modules = new Map();
      for (const file of files) {
        if (!file.startsWith(`${crateRoot}/`) || !file.endsWith(rustMembership.suffix)) continue;
        const relative = file.slice(crateRoot.length + 1);
        const segments = relative.split('/');
        const last = segments[segments.length - 1];
        const path =
          last === rustMembership.mod
            ? segments.slice(0, -1)
            : [...segments.slice(0, -1), last.slice(0, -rustMembership.suffix.length)];
        modules.set(path.join('::'), file);
      }
      const roots = ['crate', library.name];
      const usesCache = new Map();
      // A crate module is read as the compiled crate states it — a test binary
      // links the library built WITHOUT `--cfg test`, so what a `#[cfg(test)]`
      // block there declares is not an edge that binary has. The binary's own
      // file is read whole: an integration target IS built with `--cfg test`,
      // and the kill set's fixed `--lib` entry, which runs the crate's in-module
      // blocks, deliberately answers for no module of this leg either way.
      const uses = (file) => {
        if (!usesCache.has(file)) {
          const text = readSource(file);
          const skipCfgTest = file.startsWith(`${crateRoot}/`);
          usesCache.set(file, text == null ? null : rustUseTargets(text, { skipCfgTest }));
        }
        return usesCache.get(file);
      };
      for (const [path, file] of modules) {
        const read = uses(file);
        if (read === null) {
          result.unreadableMembership.push(`${file}: a crate module this leg walks, which could not be read`); // prettier-ignore
        } else if (read.reexports > 0) {
          result.unreadableMembership.push(`${file}: states ${read.reexports} \`pub use\` declaration(s) under ${crateRoot}/, and this leg maps a \`use\` path to the module that DEFINES what it names — a re-export makes that mapping wrong rather than incomplete, and the rule is stated on the source text, so a test-only re-export is refused with the rest rather than modelled and the reaching relation cannot be read while one stands${path === '' ? '' : ` (module \`${path}\`)`}`); // prettier-ignore
        }
      }
      // The module path each module file states, so the walk carries the `super`
      // and `self` frame of the file it is standing in without searching for it.
      const modulePathOf = new Map([...modules].map(([path, file]) => [file, path]));
      /** Every crate module a Rust file reaches, over use edges only. */
      const reachFrom = (entry, from) => {
        const reached = new Set();
        const queue = [[entry, from]];
        while (queue.length > 0) {
          const [file, module] = queue.shift();
          const read = uses(file);
          if (read === null) continue;
          for (const target of read.targets) {
            const resolved = resolveUsePath(target, module, { roots, modules });
            if (resolved === null || reached.has(resolved)) continue;
            reached.add(resolved);
            const key = modulePathOf.get(resolved) ?? '';
            queue.push([resolved, key === '' ? [] : key.split('::')]);
          }
        }
        return reached;
      };
      // Expanded against the tracked set through the SAME reader the JavaScript
      // side uses, an empty expansion refused as machinery there too: the cargo
      // configuration's entries are globs as readily as literal paths — the
      // staleness leg already models both — and a pattern left unexpanded would
      // be a scope module nothing can ever reach, reported as a gap in the
      // suites when it is really a string the leg never resolved.
      const scopeModules = [
        ...new Set(
          scope.values.flatMap((v) => expand(`${mutateScope.root}/${v}`, mutateScope.config)),
        ),
      ];
      // The population is the TARGETS the crate's test tree carries, resolved
      // through the same two routes the staleness leg reads a listed target by
      // ({@link cargoTargetRoutes}) rather than through the file route alone: a
      // candidate name is taken off the tree's shape — a file directly in the
      // suite's directory, or a directory sitting there — and the shared
      // resolution decides which of those names Cargo actually builds a binary
      // for and which file answers for it. Reading only the file form would
      // leave a binary that moved into a directory of its own outside the
      // classified population while the list still named it, and the leg would
      // then red it as no binary of the suite at all.
      const candidateTargets = new Set();
      for (const file of files) {
        const home = dirname(file);
        if (home === cargo.dir && cargo.selects(basename(file))) {
          candidateTargets.add(basename(file).slice(0, -rustMembership.suffix.length));
        } else if (dirname(home) === cargo.dir) {
          candidateTargets.add(basename(home));
        }
      }
      // The routes are read against the registered suite's own directory, which
      // is the tree this population comes off; the shape is otherwise the kill
      // set's, so the two legs resolve a target the same way.
      const routeShape = { ...rustKillSet, dir: cargo.dir };
      const binaries = [];
      for (const name of [...candidateTargets].sort()) {
        const route = cargoTargetRoutes(name, routeShape).find((path) => tracked.has(path));
        if (route !== undefined) binaries.push([name, route]);
      }
      const belongs = new Set();
      const reason = new Map();
      const reachedBy = new Map();
      for (const [target, binary] of binaries) {
        const read = uses(binary);
        if (read === null) {
          result.unreadableMembership.push(`${binary}: a member of the registered cargo suite this leg classifies, which could not be read`); // prettier-ignore
          continue;
        }
        if (read.targets.some((t) => t.split('::')[0] === rustMembership.integrationImport)) {
          reason.set(target, `imports \`${rustMembership.integrationImport}\` and so synthesises real OS input, which the strategy document states as the class kept out of the per-mutant runs`); // prettier-ignore
          continue;
        }
        const reached = reachFrom(binary, null);
        reachedBy.set(target, reached);
        if (!scopeModules.some((m) => reached.has(m))) {
          reason.set(target, `reaches no module of \`${mutateScope.key}\` over \`use\` edges, so no mutant seeded in the scope can fail it`); // prettier-ignore
          continue;
        }
        // Consulted where the criterion would place the binary in, on the same
        // terms as the JavaScript leg: an entry is live while it still rules.
        const ruled = excuse(rustKillSet.config, MEMBERSHIP_LEGS.surface, target);
        if (ruled !== null) reason.set(target, ruled.reason);
        else belongs.add(target);
      }
      const selected = killSetTargets(list.values, rustKillSet.flag);
      if (!selected.error) {
        const listed = new Set(selected.targets);
        if (!list.values.includes(rustMembership.lib)) {
          result.unlistedMember.push(`${rustKillSet.config}'s \`${rustKillSet.key}\` states no \`${rustMembership.lib}\`, which is the kill set's fixed in-module entry — dropping it takes every \`#[cfg(test)]\` block out of the per-mutant runs while the \`${rustKillSet.flag}\` list still reads complete`); // prettier-ignore
        }
        for (const target of belongs) {
          if (listed.has(target)) continue;
          result.unlistedMember.push(`\`${target}\` reaches \`${mutateScope.key}\` over \`use\` edges and is a fast, deterministic binary of the registered cargo suite, but ${rustKillSet.config}'s \`${rustKillSet.key}\` does not list it — so the weekly run seeds mutants no test of it can kill`); // prettier-ignore
        }
        for (const target of listed) {
          if (belongs.has(target)) continue;
          const why = reason.get(target) ?? `is no binary of the registered cargo suite in ${cargo.dir}/, so this leg cannot classify it against the criterion`; // prettier-ignore
          result.listedNonMember.push(`${rustKillSet.config}'s \`${rustKillSet.key}\` lists \`${rustKillSet.flag} ${target}\`, which ${why}`); // prettier-ignore
        }
        for (const module of scopeModules) {
          // The in-module entry deliberately does not satisfy this leg: a
          // module's own `#[cfg(test)]` block would answer for it by
          // construction, and what the leg asks is which TEST SURFACE exercises
          // it.
          if ([...listed].some((target) => reachedBy.get(target)?.has(module))) continue;
          if (excuse(rustKillSet.config, MEMBERSHIP_LEGS.module, module) !== null) continue;
          result.unreachableScopeModule.push(`${module} is in \`${mutateScope.key}\` in ${mutateScope.config}, and no test binary ${rustKillSet.config}'s \`${rustKillSet.key}\` lists reaches it over \`use\` edges — every mutant seeded there survives unless an in-module block happens to catch it`); // prettier-ignore
        }
      }
    }
  }

  for (const entry of allowlist) {
    if (used.has(entry)) continue;
    result.staleMembershipAllowlist.push(`${entry.surface}'s ${entry.leg} leg carries an allowlist entry for \`${entry.entry}\` that nothing needs — the criterion already places it where the entry puts it, or the entry names something the leg no longer sees`); // prettier-ignore
  }

  // A refusal is a fact about a membership source read for one criterion, so a
  // file that many surfaces reach states it once however many walks met it. The
  // refusal text carries what distinguishes one refusal from another — the file
  // it is about, and the specifier where one is involved — so the set is keyed
  // by that text and taken here, where the result is complete and the writers of
  // the field are behind it, in the order they were found. What the report
  // counts is the distinct refusals to fix, never how many walks met them, and
  // one source can state more than one refusal.
  result.unreadableMembership = [...new Set(result.unreadableMembership)];

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
    fix: `repoint the moved file in DOC_INVENTORIES / TRACKED_LISTS in ${SELF_PATH}.`,
  },
  unparsed: {
    heading: (n) => `${n} inventory source(s) could not be read as an inventory`,
    fix:
      `restore the shape the check reads — an inventory table in the documented section,\n` +
      `  its first column the documented header with one backticked file name per row, and a\n` +
      `  TRACKED_FILES array literal whose elements are string paths or object records carrying\n` +
      `  the named properties — or update ${SELF_PATH} to the new shape.`,
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
  duplicatedEntry: {
    heading: (n) => `${n} enumerated entr(ies) are stated more than once`,
    fix:
      `keep one entry per file — each of these lists is a curated enumeration, so a\n` +
      `  repeat collects once and every diff that holds the list deduplicates before\n` +
      `  comparing, which is the one drift those diffs cannot see.`,
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
      `  ${SELF_PATH} — it is what states how this repository selects the\n` +
      `  suite, and the entry's membership rule is derived from it.`,
  },
  unregisteredSuite: {
    heading: (n) => `${n} node-test suite(s) are run but registered by no single entry`,
    fix:
      `register the suite in DOC_INVENTORIES in ${SELF_PATH} — a document\n` +
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
      `  configuration — or update ${SELF_PATH} to the new shape.`,
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
      `  inside its clause — or update ${SELF_PATH} to the new shape.`,
  },
  unlistedMember: {
    heading: (n) => `${n} test surface(s) belong to a kill set that does not list them`,
    fix:
      `list each one in the configuration named beside it, or — where it is fast but not\n` +
      `  deterministic, or not runnable once per mutant — record it in MEMBERSHIP_ALLOWLIST in\n` +
      `  ${SELF_PATH} with the ground that ruling stands on. Membership is\n` +
      `  the criterion the mutation-strategy document states, not a list's own opinion of itself.`,
  },
  listedNonMember: {
    heading: (n) => `${n} kill-set entr(ies) name a test surface that does not belong`,
    fix:
      `drop each entry, or make it belong — a surface that reaches no mutated module runs\n` +
      `  against every mutant and kills none of them, and one driving an unseeded property runner\n` +
      `  answers differently from run to run, so a mutant it "kills" is not evidence. Where the\n` +
      `  entry is deliberate, record it in MEMBERSHIP_ALLOWLIST in ${SELF_PATH}.`,
  },
  unreachableScopeModule: {
    heading: (n) => `${n} mutate-scope module(s) are reached by no listed test surface`,
    fix:
      `list a test surface that exercises the module, or narrow the scope so it stops naming a\n` +
      `  module the kill set cannot answer for — every mutant seeded in one nothing reaches\n` +
      `  survives by construction and reports as a gap in the suites rather than in the scope.\n` +
      `  Where the module carries nothing a mutant can change, record it in\n` +
      `  MEMBERSHIP_ALLOWLIST in ${SELF_PATH} with that reason.`,
  },
  staleMembershipAllowlist: {
    heading: (n) => `${n} membership allowlist entr(ies) excuse nothing`,
    fix:
      `remove each entry from MEMBERSHIP_ALLOWLIST in ${SELF_PATH} — an\n` +
      `  exclusion whose reason has expired is a ruling nobody made, and the criterion already\n` +
      `  places what it names where the entry was putting it.`,
  },
  unreadableMembership: {
    heading: (n) =>
      `${n} membership refusal(s): a source could not be read as what the criterion needs`,
    fix:
      `restore the shape the membership legs read — a JavaScript configuration stating its\n` +
      `  mutate scope as an array of patterns over one package's tree, a crate manifest stating\n` +
      `  its library name, a specifier resolving into a class the walk models, a test surface\n` +
      `  declaring its cases as bare calls, and no \`pub use\` under the crate's source — or\n` +
      `  update ${SELF_PATH} to the new shape.`,
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
  const blocks = [];
  for (const [name, entries] of Object.entries(result)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const block = PROBLEM_BLOCKS[name];
    const heading = block
      ? block.heading(entries.length)
      : `${entries.length} problem(s) of class "${name}", which this report has no wording for`;
    const fix = block ? block.fix : `add a "${name}" entry to PROBLEM_BLOCKS in ${SELF_PATH}.`;
    blocks.push(formatProblemBlock(heading, entries, `  Fix: ${fix}`));
  }
  return blocks;
}

/**
 * One red block: the heading a reader scans, the findings indented under it,
 * and the closing paragraph that says what to do about them. Every check that
 * prints a red prints this shape, so the reports stay one report however many
 * checks a run puts side by side, and the shape is unit-testable rather than
 * spelled inside a command line's own glue.
 * @param {string} heading what drifted, without the leading mark
 * @param {string[]} problems the findings, one per line
 * @param {string} closing the paragraph after them, already indented as it reads
 * @returns {string} the rendered block
 */
export function formatProblemBlock(heading, problems, closing) {
  return `✗ ${heading}:\n` + problems.map((p) => `    ${p}`).join('\n') + `\n\n${closing}`;
}

/**
 * The empty-surface guard every surface check runs before its diffs: a
 * surface that parsed to nothing makes every diff over it vacuously true, so
 * the guard names each empty surface and the caller stops there.
 *
 * A guard entry states the surface key and its message, and may state a
 * PROJECTOR where the surface is derived rather than read — which is what
 * lets one loop serve a check whose guarded list is computed from the
 * surfaces rather than sitting on them. Membership is what the guard states:
 * the messages come back in the order the entries are written, and no caller
 * reads more into that than which surfaces were empty.
 *
 * An entry naming a key the surfaces do not carry, with no projector to derive
 * one, is a different finding from an empty surface and is reported as its own:
 * the guard read for that key, the extraction handed it an object stating none,
 * and the entry supplies no other route to the list — so the caller is told
 * what the entry asked for and what the extraction stated, rather than being
 * told a document went empty. It is this guard's own table disagreeing with its
 * extraction, never a verdict about a file the check read.
 *
 * ## What a surface key carries, and how each shape is guarded
 *
 * This block is the family's one home for that rule; each guard elsewhere
 * points here rather than restating it.
 *
 * - **List keys** — a surface extracted as a list of names is guarded through
 *   this helper and its twin {@link duplicateSurfaceProblems}, so a check
 *   states its guarded surfaces as a table and reads them through one loop.
 * - **Scalar counts** — a surface extracted as a NUMBER (how many registration
 *   lists a file carries, how many tables match a header tuple, how many times
 *   a document makes a claim) has no length for those loops to read, so its
 *   guard is written out. It is written FAIL-CLOSED — `!(n >= 1)` where any
 *   count is enough, `n !== 1` where exactly one is — because a surface that
 *   states the key on nothing hands the guard `undefined`, and `undefined` is
 *   neither `>= 1` nor `=== 1`: both of those forms then red, while the
 *   forms that read as their opposites (`n === 0`, `n < 1`) pass an
 *   extraction that produced no count at all.
 * - **Raw-text keys** — a surface put on the object as text, read inside the
 *   evaluator rather than extracted ahead of it, is for the one case where the
 *   read cannot be taken earlier: the read is relative to a value the evaluator
 *   itself derives. The command surface's clause prose is that case — the
 *   channel its two prose reads are relative to is derived in-core from the
 *   doc's own event row, so the extraction has nothing to key a read on yet.
 * @param {object} surfaces the extracted surfaces
 * @param {[string, string, ((s: object) => unknown[])?][]} entries the guard's tuples
 * @returns {string[]} one message per empty surface, in entry order
 */
export function emptySurfaceProblems(surfaces, entries) {
  const problems = [];
  for (const [key, message, project] of entries) {
    if (project === undefined && !(key in (surfaces ?? {}))) {
      problems.push(`the empty-surface guard reads \`${key}\`, and the extraction it was handed states that key on nothing and the entry states no projector to derive it — the guard reads each surface from one of those two, so this is the guard's own table and its extraction disagreeing, not a document that went empty`); // prettier-ignore
      continue;
    }
    const list = project === undefined ? surfaces[key] : project(surfaces);
    if ((list ?? []).length === 0) problems.push(message);
  }
  return problems;
}

/**
 * The duplicate-surface guard's twin of {@link emptySurfaceProblems}: the same
 * `[key, what, project?]` tuples, read the same way, with each surface's own
 * repeated entries reported through {@link duplicatesIn}. Having the projector
 * SUPPLIED by an entry and APPLIED here is what lets a check whose guarded list
 * is derived — a set to spread, a table to project — share the one loop with
 * the checks whose lists sit on the surfaces directly.
 *
 * Reading them the same way includes the same discriminator: an entry naming a
 * key the surfaces do not carry, with no projector to derive one, is this
 * guard's table disagreeing with its extraction rather than a surface with no
 * repeats, and is reported as its own finding — what the entry asked for beside
 * what the extraction stated. Without it the guard reads `undefined` as an
 * empty list and answers "no duplicates" for a key the extraction stopped
 * stating at all — the one shape a duplicate loop cannot otherwise see, since a
 * surface that is really free of repeats answers the same way.
 * @param {object} surfaces the extracted surfaces
 * @param {[string, string, ((s: object) => unknown[])?][]} entries the guard's tuples
 * @returns {string[]} one message per repeated entry, in entry order
 */
export function duplicateSurfaceProblems(surfaces, entries) {
  const problems = [];
  for (const [key, what, project] of entries) {
    if (project === undefined && !(key in (surfaces ?? {}))) {
      problems.push(`the duplicate-surface guard reads \`${key}\`, and the extraction it was handed states that key on nothing and the entry states no projector to derive it — the guard reads each surface from one of those two, so this is the guard's own table and its extraction disagreeing, not a surface free of repeats`); // prettier-ignore
      continue;
    }
    const list = project === undefined ? surfaces[key] : project(surfaces);
    problems.push(...duplicatesIn(list ?? [], what));
  }
  return problems;
}

/* c8 ignore start — the CLI wrapper reads the tracked-file list from git and the
 * inventory sources from disk, then prints; the parsing and audit logic it
 * delegates to (parseTables, readListEntries, auditInventories,
 * auditRegistrationClosure, formatProblems) is unit-tested. */
function run() {
  // Through this module's own population reader, whose docblock states the
  // quotepath policy.
  const files = trackedFilesUnder('.');
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const membership = auditKillSetMembership({ files, readFile });
  const problems = [
    ...formatProblems(auditInventories({ files, readFile })),
    ...formatProblems(auditRegistrationClosure({ files, readFile })),
    ...formatProblems(auditMutationKillSets({ files, readFile })),
    ...formatProblems(membership),
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
      `tree carries module for module — and each of those kill sets lists exactly the surfaces ` +
      `the membership criterion places in it, over a scope every module of which a listed ` +
      `surface reaches, with ${MEMBERSHIP_ALLOWLIST.length} recorded exclusion(s).`,
  );
  // The accepted residue, stated rather than left implicit: each admitted
  // surface whose property cases sit beside the plain ones its membership
  // stands on.
  for (const [config, admittedMixed] of Object.entries(membership.admittedMixed)) {
    console.log(
      `  residue — ${config} admits on their plain cases, with unseeded property cases beside them: ` +
        admittedMixed.join(', '),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
