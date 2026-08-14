/**
 * check-command-surface.js — admission test for the desktop application
 * shell's command-surface contract
 * (docs/architecture/application/desktop/windows/application-shell.md §DSH-1).
 *
 * The clause states one closed contract: every `#[tauri::command]` the crate
 * defines is registered in `lib.rs`'s `generate_handler!` list and appears in
 * the doc's table, and the doc's one event row states the only event channel
 * the backend emits; the same section names the capability grants
 * (`capabilities/default.json`) that admit the plugin surface. This check
 * recomputes every leg from the tree and fails on any drift:
 *
 *   1. the `#[tauri::command]` function set, the `generate_handler!`
 *      registration, and the doc table's command rows are equal — each
 *      pairwise difference is reported in both directions, and a body row
 *      whose first cell is not a lone backticked name (optionally suffixed
 *      `(event)`) fails the check rather than being skipped;
 *   2. the doc's one event row DERIVES the channel every other side of this
 *      leg is held against, each of them named here. The crate sources contain
 *      exactly one emit-family call site — every emit method the Emitter trait
 *      exposes (`emit`, `emit_str`, `emit_to`, `emit_str_to`, `emit_filter`,
 *      `emit_str_filter`) — whose channel is that literal (sources are
 *      comment-stripped first, so doc comments naming the channel never
 *      count); the tracked desktop frontend JavaScript carries exactly one
 *      `listen(` call site CARRYING that channel — a readable listen site on
 *      another channel is outside this leg, neither counted nor redded on its
 *      own, and the zero case names any such site it found; and the clause
 *      section's prose OUTSIDE its table names that channel in backticks, so a
 *      rename that updates the table and the backend while leaving the adapter
 *      or the prose behind reds. An emit-family or `listen(` call whose channel
 *      the scan cannot read as a LONE string literal — one the argument
 *      separator or the call's closing parenthesis follows — fails the check
 *      rather than passing;
 *   3. the grants declared by the tracked capability files under
 *      `capabilities/` equal the grant identifiers the clause's section names
 *      in backticks — the admission shape is a namespaced identifier ending
 *      in `:default`, `:allow-…`, or `:deny-…`, so other backticked tokens
 *      (command names, the event channel) never read as grants — again in
 *      both directions;
 *   4. the desktop integration suite's mock serviced-command surface — both
 *      the `CANONICAL_COMMANDS` override allow-list and the injected mock
 *      script's `case` labels (`tauri-mock-fixture.js`) — equals the crate's
 *      command set, so the suite's one drift-visible consumer of the surface
 *      can neither lag a command the crate gains nor keep servicing one it
 *      loses (that leg's doctrine home is docs/test/integration/desktop.md);
 *   5. the crate's command set and the command names the frontend's own
 *      `invoke(` call sites state are equal, diffed in both directions — the
 *      caller closure (a crate command no literal invoke names reds) and the
 *      direct-invoke closure (an invoke literal naming no crate command
 *      reds). The scanned surface is the tracked JavaScript under
 *      `packages/desktop/src` — `git ls-files` over that directory, recursive,
 *      filtered to `.js`, the bridge module included — read through the shared
 *      comment-safe tokenizer, so a commented-out or documented call never
 *      counts. What the scan skips is a SHAPE, not a file: a match whose
 *      preceding token is `function` is a declaration, which states the
 *      transport rather than using it. The bridge module is where that shape
 *      lives, and the forwarding call inside it reaches the API through an
 *      expression no word-then-paren pair matches, so an `invoke(` or
 *      `listen(` written there is a call site like any other. An `invoke(`
 *      call site whose first argument the scan cannot read as a lone string
 *      literal — a concatenation, say — is refused by name rather than
 *      skipped.
 *
 * Every extracted set must be non-empty — a parse that finds nothing is a
 * broken read of the surface (or a moved surface) and fails loudly rather
 * than passing vacuously.
 *
 * Honest limits: an emit issued through a wrapping helper or through
 * non-method call syntax (`Emitter::emit(app, …)`) is invisible to the scan,
 * while the emit-method names are matched on any receiver, so an unrelated
 * type exposing `emit()` would red the gate (loud, reviewed away); a call
 * that reaches the backend through a wrapper, or through a call shape the
 * `invoke(`/`listen(` scan does not model, is invisible to it the same way;
 * the caller scans read the call token, not the binding behind it, so a
 * locally bound or injected `invoke` counts as a caller-closure witness
 * (`packages/desktop/src/persistence.js` takes its `invoke` as a parameter);
 * which module carries the single listener is review-held — this check counts
 * the listen sites across the scanned surface, never which file holds one; a
 * command name and an event channel are each read as a quoted string literal,
 * so a call written with a template literal is refused by name (the shared
 * tokenizer gives a template a type of its own, and tokenizes each `${…}`
 * interpolation's contents as the code they are, so a call written inside one
 * is a call site like any other); the shared tokenizer does not model
 * regular-expression literals, so a quote inside one desynchronizes the token
 * stream for the rest of that file — in these whole-file scans that corruption
 * is SILENT, the call sites past it simply not seen rather than refused; the
 * Rust anchors — the `#[tauri::command]` attribute, the `generate_handler!`
 * list, and the emit-family call sites — are found on a view of each source
 * whose string-literal contents are blanked, so what a diagnostic message says
 * about the surface never counts as the surface itself, while each emit's
 * channel is read from the intact text at the same offset; a `#[tauri::command]` declared inside a
 * test-only module would count as shipped surface; the clause's section cannot
 * name a grant-shaped identifier the capability files do not hold (an
 * illustrative mention outside a fence reds the gate); one backticked mention
 * of the channel in the clause section's non-table prose satisfies the weld,
 * so a second, stale mention standing beside an updated first stays
 * review-held, and mentions of the channel outside the clause section —
 * sibling documents, the integration-suite document, workflow comments — are
 * not held here. The table's Direction / What-it-does / Who-calls-it columns
 * are still never parsed: the caller closure and the single-listener
 * consumption those columns describe are clause-stated and held by legs 2 and
 * 5 above, and the columns' remaining prose stays review-held. The grants
 * paragraph narrows the same way: the direct-invoke closure is clause-stated
 * and held by leg 5 — a granted plugin command invoked directly from the
 * frontend reds — while the paragraph's remaining grant-resolution prose stays
 * review-held, never parsed.
 *
 * Usage:
 *   node scripts/check-command-surface.js   # or: npm run lint:command-surface
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  duplicatesIn,
  extractClauseSection,
  missingFrom,
  parseTables,
  readListEntries,
  readLoneStringLiteral,
  tokenizeJs,
} from './check-test-inventory.js';

/** Repo-relative path of the doc whose DSH-1 table states the contract. */
export const DOC_PATH = 'docs/architecture/application/desktop/windows/application-shell.md';
/** Repo-relative path of the crate entry point carrying generate_handler!. */
export const LIB_PATH = 'packages/desktop/src-tauri/src/lib.rs';
/** Repo-relative directory of the crate sources the command/emit scans read. */
export const SRC_DIR = 'packages/desktop/src-tauri/src';
/** Repo-relative directory of the capability files naming the plugin grants. */
export const CAPABILITIES_DIR = 'packages/desktop/src-tauri/capabilities';
/** Repo-relative path of the Tauri config, which may inline capabilities. */
export const TAURI_CONF_PATH = 'packages/desktop/src-tauri/tauri.conf.json';
/** Repo-relative path of the integration suite's Tauri mock fixture. */
export const MOCK_PATH = 'packages/desktop/tests/integration/tauri-mock-fixture.js';
/** Repo-relative directory of the desktop frontend the caller scans read. */
export const FRONTEND_DIR = 'packages/desktop/src';

/** The clause id the whole contract is anchored to. */
export const CLAUSE_ID = 'DSH-1';
/** The one invoke-switch anchor the mock's serviced-case scan is keyed on. */
export const MOCK_SWITCH_ANCHOR = 'switch (cmd)';

/**
 * A capability-grant identifier: one or more namespace segments ending in
 * `:default`, `:allow-…`, or `:deny-…` (e.g. `core:default`,
 * `core:event:allow-listen`). Deliberately narrower than "anything with a
 * colon" so the event channel and command names in the same section never
 * read as grants.
 */
const GRANT_RE =
  /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*:(?:default|allow-[a-z0-9-]+|deny-[a-z0-9-]+)$/;

/**
 * Blank out Rust comments (line `//…` and nested block `/* … *\/`) while
 * preserving every non-comment character's offset and every newline, so
 * line numbers computed on the stripped text match the source. String
 * literals — `"…"` with escapes and raw `r"…"` / `r#"…"#` forms — are
 * honoured so comment markers inside them survive.
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
 * Extract the function names declared with a `#[tauri::command]` attribute.
 * The attribute and the declaration are anchors — what the source DOES — so
 * they are found on the strings-blanked view, and a declaration quoted inside a
 * string literal is text rather than a command.
 * @param {string} strippedSource comment-stripped Rust source
 * @returns {string[]} command function names, in source order
 */
export function extractCommandFns(strippedSource) {
  const re =
    /#\[tauri::command(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g;
  return [...blankRustStrings(strippedSource).matchAll(re)].map((m) => m[1]);
}

/**
 * Extract the command names registered in the `generate_handler!` list. The
 * macro invocation is an anchor — what the source DOES — so the lists are found
 * on the strings-blanked view, which is what keeps a quoted list from standing
 * in for the real one and from counting as a second registration.
 * @param {string} strippedLib comment-stripped lib.rs source
 * @returns {{ commands: string[], occurrences: number }} last-segment names
 *   and how many generate_handler! lists the source carries
 */
export function extractHandlerCommands(strippedLib) {
  const lists = [...blankRustStrings(strippedLib).matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)];
  const commands = (lists[0]?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => entry.split('::').pop());
  return { commands, occurrences: lists.length };
}

/**
 * Slice the doc text to the clause's scope, through the shared fence-aware
 * clause-section extractor — from the marker to the next clause marker or
 * heading, with fenced examples unable to anchor or truncate the slice.
 * @param {string} docText the application-shell doc
 * @returns {string} the clause's text, or '' when the marker is absent
 */
export function extractDsh1Section(docText) {
  return extractClauseSection(docText, CLAUSE_ID);
}

/**
 * Parse the clause table's first column into command rows and event rows,
 * through the shared fence-aware table parser. Header and separator rows are
 * consumed by that parser, so every body row's first cell must be `name` or
 * `name` (event); any other shape — annotated, un-backticked, empty — is
 * returned as unreadable (an empty cell as the stand-in `(empty first
 * cell)`, so the gate line never renders a blank), and no row can slip past
 * either leg silently.
 * @param {string} section the clause's text
 * @returns {{ commands: string[], events: string[], unreadable: string[] }}
 */
export function extractDocRows(section) {
  const commands = [];
  const events = [];
  const unreadable = [];
  for (const table of parseTables(section)) {
    for (const row of table.rows) {
      const cell = (row[0] ?? '').trim();
      const m = cell.match(/^`([^`]+)`\s*(\(event\))?$/);
      if (!m) {
        unreadable.push(cell === '' ? '(empty first cell)' : cell);
        continue;
      }
      (m[2] ? events : commands).push(m[1]);
    }
  }
  return { commands, events, unreadable };
}

/**
 * Extract the grant identifiers the DSH-1 section names in backticks.
 * @param {string} section the DSH-1 clause text
 * @returns {string[]} grant identifiers in first-appearance order, deduplicated
 */
export function extractDocGrants(section) {
  const out = [];
  for (const m of section.matchAll(/`([^`]+)`/g)) {
    if (GRANT_RE.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * A Markdown table line, in the shape the shared table parser reads one: a
 * line whose first non-blank character is the structural pipe. Stated here
 * because this check strips those lines rather than parsing them.
 */
const TABLE_LINE_RE = /^\s*\|/;

/**
 * The clause section's prose: its text with every table line removed. The
 * event-channel weld reads this rather than the whole section, so the
 * requirement that the clause's own prose names the channel cannot be
 * satisfied by the very table cell the channel is derived from.
 * @param {string} section the clause's text (already fence-stripped)
 * @returns {string} the section's non-table lines, newline-joined
 */
export function extractSectionProse(section) {
  return section
    .split('\n')
    .filter((line) => !TABLE_LINE_RE.test(line))
    .join('\n');
}

/**
 * Find emit-family call sites — every Emitter emit method (`emit`,
 * `emit_str`, `emit_to`, `emit_str_to`, `emit_filter`, `emit_str_filter`) —
 * in comment-stripped crate sources. The channel is the first string-literal
 * argument, except for `emit_to`/`emit_str_to` where it is the second (their
 * first argument is the target, which must also be a literal for the channel
 * to be readable). The channel literal must be LONE — the argument separator
 * or the call's closing parenthesis follows it — so a channel built around a
 * literal (`"capture:action".to_string()`) is refused rather than credited
 * with its leading piece; a call whose channel cannot be read is recorded with
 * `channel: null` and fails the evaluation loudly.
 *
 * The scan reads both views of each file, one per question. The call sites are
 * anchors — what the source DOES — so they are found on the strings-blanked
 * view, where an emit written inside a diagnostic message is text rather than a
 * call site. The channel is a string literal, so it is read from the intact
 * comment-stripped text at the same offset, which the blanked view preserves
 * character for character.
 * @param {Map<string, string>} strippedByPath path → comment-stripped source
 * @returns {{ path: string, method: string, channel: string | null, line: number }[]}
 */
export function extractEmitSites(strippedByPath) {
  const sites = [];
  const STR = /^\s*"((?:[^"\\]|\\.)*)"(?=\s*[,)])/;
  const SECOND_STR = /^\s*"(?:[^"\\]|\\.)*"\s*,\s*"((?:[^"\\]|\\.)*)"(?=\s*[,)])/;
  const FAMILY = /\.(emit|emit_str|emit_to|emit_str_to|emit_filter|emit_str_filter)\s*\(/g;
  for (const [path, source] of strippedByPath) {
    const anchored = blankRustStrings(source);
    for (const m of anchored.matchAll(FAMILY)) {
      const line = source.slice(0, m.index).split('\n').length;
      const rest = source.slice(m.index + m[0].length);
      const second = m[1] === 'emit_to' || m[1] === 'emit_str_to';
      const arg = rest.match(second ? SECOND_STR : STR);
      sites.push({ path, method: m[1], channel: arg ? arg[1] : null, line });
    }
  }
  return sites;
}

/**
 * Find the call sites of one named function in JavaScript sources, read
 * through the shared comment-safe tokenizer so a commented-out or documented
 * call never counts. A site is the token pair `<name> (`; its first argument
 * is read when it is a LONE string literal — the token right after it must be
 * the argument separator or the call's closing parenthesis, so a literal
 * feeding an expression (`'load_state' + suffix`) is refused rather than
 * credited with its leading piece. Anything else is recorded as `name: null`
 * with the token that stands where the lone literal would — for a literal
 * inside an expression, the literal and the follower that gives it away — so
 * an unreadable call is refused by name rather than skipped. The token's kind
 * travels with it in `argKind`, so a call written with a template literal is
 * named as one: a template's token value is a run of its literal text, which
 * printed alone would state a command name the source never writes. A
 * declaration is not a call: a match whose preceding token is `function`
 * states the transport rather than using it, and is skipped by that shape —
 * which is why no module needs excluding by path, the bridge included. Sites
 * are numbered per file, in source order, which is how the output names one.
 * @param {Map<string, string>} sourceByPath path → JavaScript source
 * @param {string} fn the called function's name
 * @returns {{ path: string, ordinal: number, name: string | null, argToken: string,
 *   argKind: string | null }[]}
 */
export function extractCallSites(sourceByPath, fn) {
  const sites = [];
  for (const [path, source] of sourceByPath) {
    const tokens = tokenizeJs(source);
    let ordinal = 0;
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i].type !== 'word' || tokens[i].value !== fn) continue;
      if (tokens[i + 1].type !== 'punct' || tokens[i + 1].value !== '(') continue;
      if (i > 0 && tokens[i - 1].type === 'word' && tokens[i - 1].value === 'function') continue;
      ordinal += 1;
      const read = readLoneStringLiteral(tokens, i + 2, ',)');
      let argToken;
      if (read.token === null || (read.isString && read.follower === null))
        argToken = '(end of source)';
      else if (read.isString && !read.lone) argToken = `${read.token} ${read.follower}`;
      else argToken = read.token;
      sites.push({ path, ordinal, name: read.value, argToken, argKind: read.kind });
    }
  }
  return sites;
}

/**
 * How a call site is named in the check's output: its file and its position
 * among that file's call sites of the same function, comments excluded.
 * @param {{ path: string, ordinal: number }} site
 * @param {string} fn the called function's name
 * @returns {string}
 */
function siteLabel(site, fn) {
  return `${site.path} (${fn}( call site ${site.ordinal})`;
}

/**
 * How the argument a refused call site passed is named in the check's output:
 * a template literal by its kind, with its leading run of literal text beside
 * it, and every other token by the token itself.
 * @param {{ argToken: string, argKind?: string | null }} site
 * @returns {string}
 */
function argLabel(site) {
  return site.argKind === 'template'
    ? `a template literal (\`${site.argToken}\`)`
    : `\`${site.argToken}\``;
}

/**
 * Read the mock fixture's `CANONICAL_COMMANDS` array through the shared
 * loud-on-anything-unmodelled list reader: a spread, a variable, or a
 * restructured literal is an error, never a silently partial read.
 * @param {string} fixtureSource tauri-mock-fixture.js source
 * @returns {{ commands: string[], error: string | null }}
 */
export function extractMockCommands(fixtureSource) {
  const read = readListEntries(fixtureSource, 'CANONICAL_COMMANDS');
  return 'error' in read
    ? { commands: [], error: read.error }
    : { commands: read.entries, error: null };
}

/**
 * Extract the command names the injected mock script's invoke switch actually
 * services — the `case 'name':` labels between `switch (cmd)` and its
 * `default:` arm in the fixture's script template. A missing switch or
 * default anchor yields an empty list, which the evaluation reds as a
 * structural failure rather than passing vacuously.
 * @param {string} fixtureSource tauri-mock-fixture.js source
 * @returns {string[]} serviced case labels, in switch order
 */
export function extractMockServicedCases(fixtureSource) {
  const start = fixtureSource.indexOf(MOCK_SWITCH_ANCHOR);
  if (start === -1) return [];
  const end = fixtureSource.indexOf('default:', start);
  if (end === -1) return [];
  const body = fixtureSource.slice(start, end);
  return [...body.matchAll(/^\s*case '([A-Za-z0-9_]+)':/gm)].map((m) => m[1]);
}

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this
 * list — a leg added here is exercised automatically, and the suite holds
 * the list non-empty and its diagnoses distinct.
 */
export const EMPTY_SURFACES = [
  ['commandFns', `no #[tauri::command] functions found under ${SRC_DIR} — the scan is broken or the commands moved`], // prettier-ignore
  ['handlerCommands', `no generate_handler! registrations found in ${LIB_PATH}`],
  ['docCommands', `no command rows found in the ${CLAUSE_ID} table of ${DOC_PATH}`],
  ['docEvents', `no event row found in the ${CLAUSE_ID} table of ${DOC_PATH}`],
  ['fileGrants', `no permissions found under ${CAPABILITIES_DIR}`],
  ['docGrants', `no grant identifiers found in the ${CLAUSE_ID} section of ${DOC_PATH}`],
  ['mockCommands', `no CANONICAL_COMMANDS entries found in ${MOCK_PATH}`],
  ['mockCases', `no serviced case labels found in the mock's invoke switch (${MOCK_PATH})`],
  ['invokeLiterals', `no invoke( call site naming a command in a string literal found in the tracked ${FRONTEND_DIR} JavaScript`], // prettier-ignore
];

/**
 * The duplicates guard's legs — the drift the deduplicating set diffs
 * cannot see. Exported for the suite's generated family plus the
 * fixture-key equality lock its hand-written fixtures need. The invoke
 * literals are deliberately absent: one command invoked from several call
 * sites is ordinary code shape, and `auditTree` deduplicates them into the set
 * the closure diffs run over (the extractor keeps every site, which is how a
 * site is named in a refusal).
 */
export const DUPLICATE_SURFACES = [
  ['commandFns', `the #[tauri::command] set`],
  ['handlerCommands', `the generate_handler! list`],
  ['docCommands', `the doc table`],
  ['mockCommands', `the mock's CANONICAL_COMMANDS list`],
  ['mockCases', `the mock's invoke switch`],
];

/**
 * Pure core: evaluate the whole command-surface contract.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.commandFns `#[tauri::command]` function names
 * @param {string[]} s.handlerCommands generate_handler! registrations
 * @param {number} s.handlerOccurrences how many generate_handler! lists exist
 * @param {string[]} s.docCommands the doc table's command rows
 * @param {string[]} s.docEvents the doc table's event rows
 * @param {string[]} s.docUnreadableRows table body-row first cells the row reader could not read — an empty cell arrives as the reader's `(empty first cell)` stand-in, never as a blank
 * @param {string} s.sectionProse the clause section's text with its table lines removed
 * @param {{ path: string, method: string, channel: string | null, line: number }[]} s.emitSites
 * @param {string[]} s.fileGrants permissions across the tracked capability files
 * @param {string[]} s.docGrants grant identifiers the doc section names
 * @param {string[]} s.mockCommands the mock's CANONICAL_COMMANDS entries
 * @param {string[]} s.mockCases the injected mock script's serviced case labels
 * @param {string[]} s.invokeLiterals command names the frontend's invoke( call sites state, deduplicated
 * @param {{ path: string, ordinal: number, name: string | null, argToken: string, argKind?: string | null }[]} s.invokeSites every frontend invoke( call site, readable or not
 * @param {{ path: string, ordinal: number, name: string | null, argToken: string, argKind?: string | null }[]} s.listenSites every frontend listen( call site, readable or not
 * @returns {string[]} problems; empty when the contract holds
 */
export function evaluateCommandSurface(s) {
  const problems = [];

  // Unreadable rows and call sites are reported ahead of the vacuous guards:
  // the likeliest cause of an empty parse is a surface that stopped being
  // readable, so the most useful line must survive the early return.
  for (const cell of s.docUnreadableRows) {
    problems.push(`the ${CLAUSE_ID} table carries a first cell the scan cannot read — ${cell} — rows are \`name\` or \`name\` (event), nothing else`); // prettier-ignore
  }
  for (const site of s.invokeSites.filter((x) => x.name === null)) {
    problems.push(`${siteLabel(site, 'invoke')} passes ${argLabel(site)} where the command name goes — the scan reads a lone string literal, so the caller closure stays checkable`); // prettier-ignore
  }
  for (const site of s.listenSites.filter((x) => x.name === null)) {
    problems.push(`${siteLabel(site, 'listen')} passes ${argLabel(site)} where the event channel goes — the scan reads a lone string literal, so the single-listener pin stays checkable`); // prettier-ignore
  }

  let vacuous = false;
  for (const [key, message] of EMPTY_SURFACES) {
    if (s[key].length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make set diffs meaningless

  if (s.handlerOccurrences !== 1) {
    problems.push(
      `${LIB_PATH} carries ${s.handlerOccurrences} generate_handler! lists — the registration must live in exactly one`,
    );
  }

  for (const [key, what] of DUPLICATE_SURFACES) {
    problems.push(...duplicatesIn(s[key], what));
  }

  problems.push(
    ...missingFrom(s.commandFns, s.handlerCommands, `has #[tauri::command] but is not registered in generate_handler! (${LIB_PATH})`), // prettier-ignore
    ...missingFrom(s.handlerCommands, s.commandFns, `is registered in generate_handler! but no #[tauri::command] function defines it`), // prettier-ignore
    ...missingFrom(s.commandFns, s.docCommands, `has #[tauri::command] but no row in the ${CLAUSE_ID} table (${DOC_PATH})`), // prettier-ignore
    ...missingFrom(s.docCommands, s.commandFns, `has a ${CLAUSE_ID} table row but no #[tauri::command] function defines it`), // prettier-ignore
    ...missingFrom(s.commandFns, s.mockCommands, `has #[tauri::command] but the mock's CANONICAL_COMMANDS list does not carry it (${MOCK_PATH})`), // prettier-ignore
    ...missingFrom(s.mockCommands, s.commandFns, `is in the mock's CANONICAL_COMMANDS list but no #[tauri::command] function defines it`), // prettier-ignore
    ...missingFrom(s.commandFns, s.mockCases, `has #[tauri::command] but the mock's invoke switch has no case servicing it (${MOCK_PATH})`), // prettier-ignore
    ...missingFrom(s.mockCases, s.commandFns, `is serviced by the mock's invoke switch but no #[tauri::command] function defines it`), // prettier-ignore
    ...missingFrom(s.commandFns, s.invokeLiterals, `has #[tauri::command] but no invoke( call site in the tracked ${FRONTEND_DIR} JavaScript names it`), // prettier-ignore
    ...missingFrom(s.invokeLiterals, s.commandFns, `is invoked from the frontend but no #[tauri::command] function defines it — a granted plugin command invoked directly is a contract change that extends the ${CLAUSE_ID} clause and this check together`), // prettier-ignore
  );

  // The doc's event row is the channel every other side is held against, so a
  // rename lands in the table first and propagates from there.
  const channel = s.docEvents[0];
  if (s.docEvents.length > 1) {
    problems.push(`the ${CLAUSE_ID} table carries ${s.docEvents.length} event rows (${s.docEvents.map((e) => `\`${e}\``).join(', ')}) — the contract states exactly one event channel, and the first row is the channel every other side is held against`); // prettier-ignore
  }
  for (const e of s.emitSites.filter((x) => x.channel === null)) {
    const what =
      e.method === 'emit_to' || e.method === 'emit_str_to'
        ? 'a target/channel argument pair the scan cannot read as string literals — both must be literal'
        : 'a channel the scan cannot read as a string literal — the channel must be literal';
    problems.push(`${e.path}:${e.line} calls .${e.method}( with ${what} so the single-channel contract stays checkable`); // prettier-ignore
  }
  const readable = s.emitSites.filter((e) => e.channel !== null);
  const channelSites = readable.filter((e) => e.channel === channel);
  const otherSites = readable.filter((e) => e.channel !== channel);
  if (channelSites.length !== 1) {
    problems.push(
      `expected exactly one \`${channel}\` emit site, found ${channelSites.length}` +
        (channelSites.length
          ? `: ${channelSites.map((e) => `${e.path}:${e.line}`).join(', ')}`
          : ''),
    );
  }
  for (const e of otherSites) {
    problems.push(`${e.path}:${e.line} emits on \`${e.channel}\` — \`${channel}\` is the only event channel the backend emits`); // prettier-ignore
  }

  // The listen leg is scoped to the derived channel: a readable listen site on
  // another channel is another surface's business, so it is neither counted
  // here nor redded on its own — but the zero case names it, because a rename
  // that left the listener behind is exactly what that case looks like.
  const channelListeners = s.listenSites.filter((x) => x.name === channel);
  const offChannel = s.listenSites.filter((x) => x.name !== null && x.name !== channel);
  if (channelListeners.length !== 1) {
    let detail = '';
    if (channelListeners.length) {
      detail = `: ${channelListeners.map((x) => siteLabel(x, 'listen')).join(', ')}`;
    } else if (offChannel.length) {
      detail = ` — the listen sites found listen elsewhere: ${offChannel.map((x) => `${siteLabel(x, 'listen')} on \`${x.name}\``).join(', ')}`; // prettier-ignore
    }
    problems.push(
      `expected exactly one listen( call site on \`${channel}\` in the tracked ${FRONTEND_DIR} JavaScript, found ${channelListeners.length}${detail}`,
    );
  }
  if (!s.sectionProse.includes(`\`${channel}\``)) {
    problems.push(`the ${CLAUSE_ID} section's prose outside its table never names \`${channel}\` in backticks — the channel the table states is stated in the clause's own prose too`); // prettier-ignore
  }

  problems.push(
    ...missingFrom(s.fileGrants, s.docGrants, `is granted under ${CAPABILITIES_DIR} but the ${CLAUSE_ID} section does not name it`), // prettier-ignore
    ...missingFrom(s.docGrants, s.fileGrants, `is named as a grant in the ${CLAUSE_ID} section but no tracked capability file grants it`), // prettier-ignore
  );

  return problems;
}

/**
 * Read every surface from the working tree and evaluate the contract.
 * @param {(f: string) => string} readFile repo-relative content reader
 * @param {string[]} rustFiles repo-relative crate source paths to scan
 * @param {string[]} capabilityFiles every tracked path under the capability
 *   directory, whatever its extension — non-JSON entries are refused loudly
 * @param {string[]} jsFiles the tracked desktop frontend JavaScript paths the
 *   caller scans read — every one of them, the bridge module included; what
 *   the scan passes over is the declaration shape, never a path
 * @returns {{ problems: string[], commandCount: number, grantCount: number, channel: string, invokeLiterals: string[] }}
 *   `invokeLiterals` is the deduplicated caller-side set the closure diffs run
 *   over — returned so the suite can observe the deduplication a repeated
 *   invoke of one command relies on
 */
export function auditTree(readFile, rustFiles, capabilityFiles, jsFiles) {
  const strippedByPath = new Map(
    rustFiles.map((p) => [p, stripRustComments(readFile(p).replace(/\r\n/g, '\n'))]),
  );
  const callerSources = new Map(jsFiles.map((p) => [p, readFile(p).replace(/\r\n/g, '\n')]));
  const invokeSites = extractCallSites(callerSources, 'invoke');
  const listenSites = extractCallSites(callerSources, 'listen');
  const docText = readFile(DOC_PATH).replace(/\r\n/g, '\n');
  const section = extractDsh1Section(docText);
  const { commands: docCommands, events: docEvents, unreadable: docUnreadableRows } = extractDocRows(section); // prettier-ignore
  const { commands: handlerCommands, occurrences: handlerOccurrences } = extractHandlerCommands(
    strippedByPath.get(LIB_PATH) ?? '',
  );

  // Union the grants across every tracked capability file — Tauri loads the
  // whole directory, so a second file widens the webview surface exactly like
  // an entry added to the first. A capability source the scan cannot read —
  // a non-JSON capability file (Tauri also accepts .json5 and .toml), a
  // capability inlined in tauri.conf.json, a parse failure, an entry of an
  // unknown shape — is a contract problem in its own right, never a thrown
  // stack and never silently invisible.
  const collectionProblems = [];
  const fileGrants = [];
  for (const file of capabilityFiles) {
    if (!file.endsWith('.json')) {
      collectionProblems.push(`${file} is a capability file in a format the scan does not read (Tauri also loads .json5/.toml) — convert it to .json or extend the check`); // prettier-ignore
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFile(file));
    } catch {
      collectionProblems.push(`${file} does not parse as JSON — the grant leg cannot be evaluated`); // prettier-ignore
      continue;
    }
    for (const entry of parsed.permissions ?? []) {
      if (typeof entry === 'string') {
        fileGrants.push(entry);
      } else if (entry && typeof entry.identifier === 'string') {
        fileGrants.push(entry.identifier);
      } else {
        collectionProblems.push(`${file} carries a permissions entry the scan cannot read (${JSON.stringify(entry)})`); // prettier-ignore
      }
    }
  }
  try {
    const conf = JSON.parse(readFile(TAURI_CONF_PATH));
    const inlined = conf?.app?.security?.capabilities;
    if (Array.isArray(inlined) && inlined.length > 0) {
      collectionProblems.push(`${TAURI_CONF_PATH} inlines capabilities under app.security.capabilities, which the scan does not read — move them to ${CAPABILITIES_DIR} or extend the check`); // prettier-ignore
    }
  } catch {
    collectionProblems.push(`${TAURI_CONF_PATH} does not parse as JSON — the inlined-capability guard cannot run`); // prettier-ignore
  }

  const mockSource = readFile(MOCK_PATH).replace(/\r\n/g, '\n');
  const mockRead = extractMockCommands(mockSource);
  if (mockRead.error) collectionProblems.push(`${MOCK_PATH}: ${mockRead.error}`);
  const switchCount = mockSource.split(MOCK_SWITCH_ANCHOR).length - 1;
  if (switchCount !== 1) {
    collectionProblems.push(`${MOCK_PATH} carries ${switchCount} \`${MOCK_SWITCH_ANCHOR}\` blocks — the serviced-case scan models exactly one`); // prettier-ignore
  }

  const s = {
    commandFns: [...strippedByPath.values()].flatMap((src) => extractCommandFns(src)),
    handlerCommands,
    handlerOccurrences,
    docCommands,
    docEvents,
    docUnreadableRows,
    sectionProse: extractSectionProse(section),
    emitSites: extractEmitSites(strippedByPath),
    fileGrants,
    docGrants: extractDocGrants(section),
    mockCommands: mockRead.commands,
    mockCases: extractMockServicedCases(mockSource),
    invokeLiterals: [...new Set(invokeSites.filter((x) => x.name !== null).map((x) => x.name))],
    invokeSites,
    listenSites,
  };
  return {
    problems: [...collectionProblems, ...evaluateCommandSurface(s)],
    commandCount: new Set(s.commandFns).size,
    grantCount: new Set(s.fileGrants).size,
    channel: s.docEvents[0] ?? '(none)',
    invokeLiterals: s.invokeLiterals,
  };
}

/* c8 ignore start — the CLI wrapper enumerates the tracked crate sources and
   formats the pass/fail output; the pure extraction and evaluation core above
   is unit-tested. */
function run() {
  // `core.quotepath` off: a path carrying a non-ASCII byte arrives as itself
  // rather than quoted and escaped, which the extension filters below would
  // drop in silence.
  const lsFiles = (dir) =>
    execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', dir], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const rustFiles = lsFiles(SRC_DIR).filter((f) => f.endsWith('.rs'));
  const capabilityFiles = lsFiles(CAPABILITIES_DIR);
  const jsFiles = lsFiles(FRONTEND_DIR).filter((f) => f.endsWith('.js'));
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return ''; // an unreadable surface fails the non-empty guards loudly
    }
  };
  const { problems, commandCount, grantCount, channel } = auditTree(
    readFile,
    rustFiles,
    capabilityFiles,
    jsFiles,
  );

  if (problems.length) {
    console.error(
      `✗ the desktop command surface drifted from its committed contract:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  The DSH-1 table (${DOC_PATH}), the #[tauri::command] set, the generate_handler!\n` +
        `  registration, the frontend's invoke( call sites, and the capability grants must\n` +
        `  state the same surface, updated together in the same change (${DOC_PATH}\n` +
        `  §DSH-1); the integration mock's serviced-command list is held equal to that\n` +
        `  surface by the desktop integration suite's contract\n` +
        `  (docs/test/integration/desktop.md).\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ desktop command surface consistent: ${commandCount} commands agree across the crate, ` +
      `the registration, the doc table, the frontend's invoke( call sites, and the integration ` +
      `mock; one ${channel} emit site, one frontend listener, and the clause's prose names the ` +
      `channel; ${grantCount} grants match the doc.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
