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
 *      section's prose OUTSIDE its table names that channel in backticks and
 *      names no other channel-shaped token, so a rename that updates the table
 *      and the backend while leaving the adapter or the prose behind reds, and
 *      a stale channel left standing beside an updated one reds beside it —
 *      the two are separate problems, and prose that names a foreign channel
 *      and never the table's own states both. The row deriving the channel is
 *      itself held to the shape that weld reads by, so a channel the weld
 *      could not see fails the row rather than leaving the leg standing green
 *      and holding nothing. An emit-family or `listen(` call whose channel
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
 * is a call site like any other); how the shared tokenizer reads a
 * regular-expression literal, with the shapes where that reading and the
 * grammar part, is stated at {@link tokenizeJs} in
 * [`check-test-inventory.js`](./check-test-inventory.js), and those shapes
 * reach the caller scans in BOTH directions — the pattern a literal read as
 * division puts into the stream is read as the code that text spells, so a
 * call written inside one is CREDITED as a call site and a command nothing
 * really invokes stays green on it, while past an UNMATCHED quote written in
 * such a pattern the stream stays out of step to the end of that file, and a
 * call site standing beyond such a quote, or
 * inside what a division read as a literal takes out of the stream (at most the
 * rest of its own line), is not seen: SILENTLY where another site names the
 * same command, and LOUDLY where it was the only one, since the caller sets are
 * diffed both ways and the command then reds as one no call site names — a
 * mismatch naming a command the frontend does call; the
 * Rust anchors — the `#[tauri::command]` attribute, the `generate_handler!`
 * list, and the emit-family call sites — are found on a view of each source
 * whose string-literal contents are blanked, so what a diagnostic message says
 * about the surface never counts as the surface itself, while each emit's
 * channel is read from the intact text at the same offset; a `#[tauri::command]` declared inside a
 * test-only module would count as shipped surface; the clause's section cannot
 * name a grant-shaped identifier the capability files do not hold (an
 * illustrative mention outside a fence reds the gate); the prose weld reads
 * every WHOLE backticked token of the clause section's non-table prose that is
 * channel-shaped and not grant-shaped, and each one must be the channel the
 * table states, so a stale second channel standing beside an updated first
 * reds by name. What that read leaves outside itself stays review-held, and
 * these are the forms of it observed so far: a channel written inside a LARGER
 * backticked span (a call site quoted into the prose, say) is not a whole
 * token and is unread, the same mechanism that keeps the crate's
 * `#[tauri::command]` attribute out of the read; an unbackticked mention is
 * unread; a mention in a table cell is dropped with the line it sits on, this
 * weld's own scope choice; and a token NEITHER the channel shape nor the grant
 * shape covers is read by neither this weld nor the grants leg, so a stale
 * mention written that way stands unread — stated as that property rather than
 * as the ways a token can fall there, and true of a mention alone: the channel
 * itself can never be such a token, the event row deriving it being held to
 * the same pairing. The gaps that run the other way red rather than passing: a
 * token of the channel shape naming something else — a script or npm target, a
 * URL scheme, or a capability grant the grant shape misses — reads here as a
 * foreign channel, so the clause's prose names such a token in some form other
 * than a bare backticked token, and the red is the prompt to write it that way
 * rather than a claim the token is a channel. Mentions of the channel
 * outside the clause section — sibling
 * documents, the integration-suite document, workflow comments — are not held
 * here either.
 * The table's Direction / What-it-does / Who-calls-it columns
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

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  backtickedTokens,
  blankJsLiterals,
  blankRustStrings,
  duplicateSurfaceProblems,
  emptySurfaceProblems,
  extractClauseSection,
  formatProblemBlock,
  missingFrom,
  namedLiteral,
  parseTables,
  readListEntries,
  readLoneStringLiteral,
  stripRustComments,
  switchCaseLabels,
  tokenizeJs,
  trackedFilesUnder,
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
 * An event-channel identifier, in the shape the channel is written in: a
 * namespace and a name joined by a single colon, each of the two segments
 * opening on a lowercase letter or a digit and carrying lowercase letters,
 * digits, `-`, or `_` after it. It is read PAIRED with {@link GRANT_RE},
 * which the grants leg reads by — a token that shape covers is read as a grant
 * by the grants leg, and the prose weld leaves it alone — and
 * {@link isChannelShaped} is that pairing, which both sides of the weld go
 * through.
 *
 * The pairing is two narrow shapes, not a partition of the tokens a section
 * can carry, and what it leaves between them is stated as a property rather
 * than as ways a token can fall there. A token NEITHER shape covers is read
 * by neither leg, so a stale mention written that way stands unread — while
 * the channel itself can never be one, because the doc's event row is held to
 * this same pairing and reds where it is not. A token this shape covers that
 * names something other than a channel — a script or npm target, a URL scheme
 * — is read here as channel-shaped and reds as a foreign channel; a
 * capability grant the grant shape misses is that same case arriving from the
 * grants leg. Such a token belongs in the clause's prose in some form other
 * than a bare backticked token, and its red is the prompt to write it that
 * way or to state the shape differently — never a claim that the token is an
 * event channel.
 */
const CHANNEL_TOKEN_RE = /^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/;

/**
 * How the channel shape reads in a refusal — spelled once, so the two
 * refusals naming it cannot drift from each other or from the shape itself.
 */
const CHANNEL_SHAPE_PHRASE =
  'a namespace and a name joined by a single colon, each of the two segments opening on a lowercase letter or a digit and carrying lowercase letters, digits, `-`, or `_` after it, the capability-grant shape excluded';

/**
 * Is this token one the prose weld reads as a channel? The pairing of the two
 * shapes, in one place: {@link CHANNEL_TOKEN_RE} covers it and
 * {@link GRANT_RE} does not. BOTH sides of the weld are held to it — the
 * tokens the clause's prose is read for, and the channel the doc's event row
 * derives — which is what makes the residue statements true by construction
 * rather than by assumption: the row cannot state a channel the read is blind
 * to, so the weld can never stand green while holding nothing.
 * @param {string} token a whole backticked token
 * @returns {boolean} whether the prose weld reads it as a channel
 */
function isChannelShaped(token) {
  return CHANNEL_TOKEN_RE.test(token) && !GRANT_RE.test(token);
}

// Both Rust views moved down to the shared-primitive home when the kill-set
// membership legs — which read Rust `use` declarations through them and cannot
// import from here, since that module deliberately carries node builtins and
// nothing else — needed them: the comment-stripped view first, and the
// string-blanked one with it, once a `use` written inside a string literal
// proved readable as an edge. These re-exports keep the names resolving where
// their readers already ask for them, while each view has one home.
export { blankRustStrings, stripRustComments };

/**
 * Extract the function names declared with a `#[tauri::command]` attribute.
 * The attribute and the declaration are anchors — what the source DOES — so
 * they are found on the strings-blanked view, and a declaration quoted inside a
 * string literal is text rather than a command.
 * @param {string} blankedSource comment-stripped, strings-blanked Rust source
 * @returns {string[]} command function names, in source order
 */
export function extractCommandFns(blankedSource) {
  const re =
    /#\[tauri::command(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g;
  return [...blankedSource.matchAll(re)].map((m) => m[1]);
}

/**
 * Extract the command names registered in the `generate_handler!` list. The
 * macro invocation is an anchor — what the source DOES — so the lists are found
 * on the strings-blanked view, which is what keeps a quoted list from standing
 * in for the real one and from counting as a second registration.
 * @param {string} blankedLib comment-stripped, strings-blanked lib.rs source
 * @returns {{ commands: string[], occurrences: number }} last-segment names
 *   and how many generate_handler! lists the source carries
 */
export function extractHandlerCommands(blankedLib) {
  const lists = [...blankedLib.matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)];
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
  // Deduplicated: a grant named twice in the prose is one grant, and the diff
  // legs over this surface are set diffs.
  return backtickedTokens(section, { shape: GRANT_RE, dedupe: true });
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
 * Extract the channel-shaped tokens the clause section's prose names in
 * backticks: every WHOLE backticked span {@link isChannelShaped} admits. Read
 * whole, the way {@link extractDocGrants} reads a grant, so a channel standing
 * inside a larger backticked span is no more a token here than the crate's
 * attribute is a grant there.
 * @param {string} prose the clause section's non-table text
 * @returns {string[]} channel-shaped tokens in first-appearance order, deduplicated
 */
export function extractProseChannelTokens(prose) {
  return backtickedTokens(prose, { shape: isChannelShaped, dedupe: true });
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
 * @param {Map<string, string>} [blankedByPath] path → that source with string
 *   contents blanked; the anchors are found there, and the channel is read
 *   from the intact text at the same offset
 * @returns {{ path: string, method: string, channel: string | null, line: number }[]}
 */
export function extractEmitSites(strippedByPath, blankedByPath) {
  const sites = [];
  const STR = /^\s*"((?:[^"\\]|\\.)*)"(?=\s*[,)])/;
  const SECOND_STR = /^\s*"(?:[^"\\]|\\.)*"\s*,\s*"((?:[^"\\]|\\.)*)"(?=\s*[,)])/;
  const FAMILY = /\.(emit|emit_str|emit_to|emit_str_to|emit_filter|emit_str_filter)\s*\(/g;
  for (const [path, source] of strippedByPath) {
    const anchored = blankedByPath.get(path) ?? blankRustStrings(source);
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
 * a literal this reader does not read by its kind, with what the source wrote
 * beside it — a template's leading run of literal text, a regular expression's
 * literal as written — and every other token by the token itself.
 * @param {{ argToken: string, argKind?: string | null }} site
 * @returns {string}
 */
function argLabel(site) {
  return namedLiteral(site.argKind, site.argToken);
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
 * services — the `case 'name':` labels of the `switch (cmd)` body, bounded by
 * that switch's own braces. The bound matters both ways: a live case written
 * after the `default:` arm is serviced at runtime, so reading only the text
 * before that arm reds a command the mock really does service and passes over
 * a stale one written there.
 *
 * The mock's script is a template the fixture injects, so the switch is text
 * a literal CARRIES — invisible to a token stream, which hands a template
 * over as one token. The scan therefore takes that token's text and reads it
 * as the script it becomes: its own comments blanked, its own string literals
 * standing (a label IS one). A fixture that states the switch outright rather
 * than through a template is read the same way, on its own text. A missing
 * switch, one carrying a second switch at its own depth, and an unclosed body
 * each yield no labels AND a refusal naming which it was — the refusal is the
 * caller's to report, so the reader never states a structural failure as an
 * empty read.
 * @param {string} fixtureSource tauri-mock-fixture.js source
 * @returns {{ cases: string[], problems: string[] }} serviced case labels in
 *   switch order, and the refusals that stopped the read
 */
export function extractMockServicedCases(fixtureSource) {
  const carrier = tokenizeJs(fixtureSource).find(
    (token) => token.type === 'template' && token.value.includes(MOCK_SWITCH_ANCHOR),
  );
  // Where a template carries the switch, that template's text IS the script;
  // where the fixture states the switch outright, the source is.
  const script = carrier === undefined ? fixtureSource : carrier.value;
  const read = switchCaseLabels(blankJsLiterals(script, { literals: false }), MOCK_SWITCH_ANCHOR);
  return { cases: read.labels, problems: read.problems };
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
 * @param {string} s.sectionProse the clause section's text with its table lines removed — the family's one raw-text surface key, admitted because both reads over it are relative to the channel derived in-core below (the shared rule is stated at `emptySurfaceProblems` in scripts/check-test-inventory.js)
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

  const empty = emptySurfaceProblems(s, EMPTY_SURFACES);
  if (empty.length > 0) {
    problems.push(...empty);
    return problems; // empty parses make set diffs meaningless
  }

  // A scalar count, guarded fail-closed on the `!== 1` form the shared rule
  // states (`emptySurfaceProblems` in scripts/check-test-inventory.js): an
  // extraction that produced no count hands this `undefined`, which is not 1,
  // so the guard reds instead of passing over a read that answered nothing.
  if (s.handlerOccurrences !== 1) {
    problems.push(
      `${LIB_PATH} carries ${s.handlerOccurrences} generate_handler! lists — the registration must live in exactly one`,
    );
  }

  problems.push(...duplicateSurfaceProblems(s, DUPLICATE_SURFACES));

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
  // The row derives the channel, so it is held to the shape the prose weld
  // reads BY: a channel the weld cannot see would leave that leg standing
  // green while holding nothing, and a stale mention of it unread beside it.
  if (!isChannelShaped(channel)) {
    problems.push(`the ${CLAUSE_ID} table's event row states \`${channel}\`, which is not a channel the clause-prose weld can read — it reads a whole backticked token that is ${CHANNEL_SHAPE_PHRASE} — so a stale mention of this channel in the clause's prose would stand unread and that leg would hold nothing: state the channel in that shape, or widen the shape the weld reads in the same change`); // prettier-ignore
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
  // The prose weld runs in both directions over the same read, and the two
  // directions are independent problems: prose that names a foreign channel
  // and never the table's own is missing the mention AND carrying a stale
  // token, and says both.
  if (!s.sectionProse.includes(`\`${channel}\``)) {
    problems.push(`the ${CLAUSE_ID} section's prose outside its table never names \`${channel}\` in backticks — the channel the table states is stated in the clause's own prose too`); // prettier-ignore
  }
  for (const token of extractProseChannelTokens(s.sectionProse).filter((t) => t !== channel)) {
    problems.push(`the ${CLAUSE_ID} section's prose outside its table names \`${token}\` in backticks — a whole backticked token shaped like \`${channel}\`, the channel the table states (${CHANNEL_SHAPE_PHRASE}) — and the clause's prose names that channel and no other token of that shape: a token of the shape that names something else (a script or npm target, a URL scheme) belongs in this prose in some form other than a bare backticked token, while a second channel that really is one is a contract change this clause and this check take together`); // prettier-ignore
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
  // The anchors every Rust leg finds are found on ONE view per source: the
  // comment-stripped text with its string-literal contents blanked. Computing
  // it here rather than inside each leg is what keeps the legs reading the
  // same view of the same file — and stops one file being blanked once per
  // leg that reads it.
  const blankedByPath = new Map(
    [...strippedByPath].map(([path, source]) => [path, blankRustStrings(source)]),
  );
  const callerSources = new Map(jsFiles.map((p) => [p, readFile(p).replace(/\r\n/g, '\n')]));
  const invokeSites = extractCallSites(callerSources, 'invoke');
  const listenSites = extractCallSites(callerSources, 'listen');
  const docText = readFile(DOC_PATH).replace(/\r\n/g, '\n');
  const section = extractDsh1Section(docText);
  const { commands: docCommands, events: docEvents, unreadable: docUnreadableRows } = extractDocRows(section); // prettier-ignore
  const { commands: handlerCommands, occurrences: handlerOccurrences } = extractHandlerCommands(
    blankedByPath.get(LIB_PATH) ?? '',
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
  // The serviced-case read states WHY it stopped, and that verdict is more
  // use than the empty-surface guard it would otherwise reach as: a refusal
  // names the shape it found, where the guard can only say the surface parsed
  // to nothing.
  const mockCasesRead = extractMockServicedCases(mockSource);
  for (const problem of mockCasesRead.problems) {
    collectionProblems.push(`${MOCK_PATH}: ${problem}`);
  }
  const switchCount = mockSource.split(MOCK_SWITCH_ANCHOR).length - 1;
  if (switchCount !== 1) {
    collectionProblems.push(`${MOCK_PATH} carries ${switchCount} \`${MOCK_SWITCH_ANCHOR}\` blocks — the serviced-case scan models exactly one`); // prettier-ignore
  }

  const s = {
    commandFns: [...blankedByPath.values()].flatMap((src) => extractCommandFns(src)),
    handlerCommands,
    handlerOccurrences,
    docCommands,
    docEvents,
    docUnreadableRows,
    sectionProse: extractSectionProse(section),
    emitSites: extractEmitSites(strippedByPath, blankedByPath),
    fileGrants,
    docGrants: extractDocGrants(section),
    mockCommands: mockRead.commands,
    mockCases: mockCasesRead.cases,
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
  const rustFiles = trackedFilesUnder(SRC_DIR, { extensions: ['.rs'] });
  const capabilityFiles = trackedFilesUnder(CAPABILITIES_DIR);
  const jsFiles = trackedFilesUnder(FRONTEND_DIR, { extensions: ['.js'] });
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
      formatProblemBlock(
        'the desktop command surface drifted from its committed contract',
        problems,
        `  The DSH-1 table (${DOC_PATH}), the #[tauri::command] set, the generate_handler!\n` +
          `  registration, the frontend's invoke( call sites, and the capability grants must\n` +
          `  state the same surface, updated together in the same change (${DOC_PATH}\n` +
          `  §DSH-1); the integration mock's serviced-command list is held equal to that\n` +
          `  surface by the desktop integration suite's contract\n` +
          `  (docs/test/integration/desktop.md).\n`,
      ),
    );
    process.exit(1);
  }
  console.log(
    `✓ desktop command surface consistent: ${commandCount} commands agree across the crate, ` +
      `the registration, the doc table, the frontend's invoke( call sites, and the integration ` +
      `mock; one ${channel} emit site, one frontend listener, and the clause's prose names that ` +
      `channel and no other channel-shaped token; ${grantCount} grants match the doc.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
