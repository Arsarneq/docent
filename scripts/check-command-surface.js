/**
 * check-command-surface.js — admission test for the desktop application
 * shell's command-surface contract
 * (docs/architecture/application/desktop/windows/application-shell.md §DSH-1).
 *
 * The clause states one closed contract: every `#[tauri::command]` the crate
 * defines is registered in `lib.rs`'s `generate_handler!` list and appears in
 * the doc's table, and `capture:action` is the only event channel the backend
 * emits; the same section names the capability grants
 * (`capabilities/default.json`) that admit the plugin surface. This check
 * recomputes every leg from the tree and fails on any drift:
 *
 *   1. the `#[tauri::command]` function set, the `generate_handler!`
 *      registration, and the doc table's command rows are equal — each
 *      pairwise difference is reported in both directions, and a body row
 *      whose first cell is not a lone backticked name (optionally suffixed
 *      `(event)`) fails the check rather than being skipped;
 *   2. the doc's one event row names `capture:action`, and the crate sources
 *      contain exactly one emit-family call site — every emit method the
 *      Emitter trait exposes (`emit`, `emit_str`, `emit_to`, `emit_str_to`,
 *      `emit_filter`, `emit_str_filter`) — whose channel is that literal
 *      (sources are comment-stripped first, so doc comments naming the
 *      channel never count); an emit-family call whose channel the scan
 *      cannot read as a string literal fails the check rather than passing;
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
 *      loses (that leg's doctrine home is docs/test/integration/desktop.md).
 *
 * Every extracted set must be non-empty — a parse that finds nothing is a
 * broken read of the surface (or a moved surface) and fails loudly rather
 * than passing vacuously.
 *
 * Honest limits: an emit issued through a wrapping helper or through
 * non-method call syntax (`Emitter::emit(app, …)`) is invisible to the scan,
 * while the emit-method names are matched on any receiver, so an unrelated
 * type exposing `emit()` would red the gate (loud, reviewed away); a
 * `#[tauri::command]` declared inside a test-only module would count as
 * shipped surface; the clause's section cannot name a grant-shaped
 * identifier the capability files do not hold (an illustrative mention
 * outside a fence reds the gate); and the table's Direction / What-it-does /
 * Who-calls-it prose and the grants paragraph's plugin-resolution prose are
 * review-held, never parsed.
 *
 * Usage:
 *   node scripts/check-command-surface.js   # or: npm run lint:command-surface
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { extractClauseSection, parseTables, readListEntries } from './check-test-inventory.js';

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

/** The one event channel the backend emits, per the doc's event row. */
export const EVENT_CHANNEL = 'capture:action';
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
 * Extract the function names declared with a `#[tauri::command]` attribute.
 * @param {string} strippedSource comment-stripped Rust source
 * @returns {string[]} command function names, in source order
 */
export function extractCommandFns(strippedSource) {
  const re =
    /#\[tauri::command(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g;
  return [...strippedSource.matchAll(re)].map((m) => m[1]);
}

/**
 * Extract the command names registered in the `generate_handler!` list.
 * @param {string} strippedLib comment-stripped lib.rs source
 * @returns {{ commands: string[], occurrences: number }} last-segment names
 *   and how many generate_handler! lists the source carries
 */
export function extractHandlerCommands(strippedLib) {
  const lists = [...strippedLib.matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)];
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
 * Find emit-family call sites — every Emitter emit method (`emit`,
 * `emit_str`, `emit_to`, `emit_str_to`, `emit_filter`, `emit_str_filter`) —
 * in comment-stripped crate sources. The channel is the first string-literal
 * argument, except for `emit_to`/`emit_str_to` where it is the second (their
 * first argument is the target, which must also be a literal for the channel
 * to be readable); a call whose channel cannot be read is recorded with
 * `channel: null` and fails the evaluation loudly.
 * @param {Map<string, string>} strippedByPath path → comment-stripped source
 * @returns {{ path: string, method: string, channel: string | null, line: number }[]}
 */
export function extractEmitSites(strippedByPath) {
  const sites = [];
  const STR = /^\s*"((?:[^"\\]|\\.)*)"/;
  const SECOND_STR = /^\s*"(?:[^"\\]|\\.)*"\s*,\s*"((?:[^"\\]|\\.)*)"/;
  const FAMILY = /\.(emit|emit_str|emit_to|emit_str_to|emit_filter|emit_str_filter)\s*\(/g;
  for (const [path, source] of strippedByPath) {
    for (const m of source.matchAll(FAMILY)) {
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
 * Report the elements of `a` missing from `b`, as one problem line per name.
 * @param {string[]} a names present here…
 * @param {string[]} b …must each be present here
 * @param {string} where description of the gap ("in X but not Y")
 * @returns {string[]} problem lines
 */
function missingFrom(a, b, where) {
  const bSet = new Set(b);
  return [...new Set(a)].filter((x) => !bSet.has(x)).map((x) => `\`${x}\` ${where}`);
}

/**
 * Report duplicate names within one extracted list.
 * @param {string[]} names an extracted name list
 * @param {string} what description of the surface
 * @returns {string[]} problem lines
 */
function duplicatesIn(names, what) {
  const seen = new Set();
  const dup = new Set();
  for (const n of names) (seen.has(n) ? dup : seen).add(n);
  return [...dup].map((n) => `\`${n}\` appears more than once in ${what}`);
}

/**
 * Pure core: evaluate the whole command-surface contract.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.commandFns `#[tauri::command]` function names
 * @param {string[]} s.handlerCommands generate_handler! registrations
 * @param {number} s.handlerOccurrences how many generate_handler! lists exist
 * @param {string[]} s.docCommands the doc table's command rows
 * @param {string[]} s.docEvents the doc table's event rows
 * @param {string[]} s.docUnreadableRows table body-row first cells the row reader could not read — an empty cell arrives as the reader's `(empty first cell)` stand-in, never as a blank
 * @param {{ path: string, method: string, channel: string | null, line: number }[]} s.emitSites
 * @param {string[]} s.fileGrants permissions across the tracked capability files
 * @param {string[]} s.docGrants grant identifiers the doc section names
 * @param {string[]} s.mockCommands the mock's CANONICAL_COMMANDS entries
 * @param {string[]} s.mockCases the injected mock script's serviced case labels
 * @returns {string[]} problems; empty when the contract holds
 */
export function evaluateCommandSurface(s) {
  const problems = [];

  const surfaces = [
    [s.commandFns, `no #[tauri::command] functions found under ${SRC_DIR} — the scan is broken or the commands moved`], // prettier-ignore
    [s.handlerCommands, `no generate_handler! registrations found in ${LIB_PATH}`],
    [s.docCommands, `no command rows found in the ${CLAUSE_ID} table of ${DOC_PATH}`],
    [s.docEvents, `no event row found in the ${CLAUSE_ID} table of ${DOC_PATH}`],
    [s.fileGrants, `no permissions found under ${CAPABILITIES_DIR}`],
    [s.docGrants, `no grant identifiers found in the ${CLAUSE_ID} section of ${DOC_PATH}`],
    [s.mockCommands, `no CANONICAL_COMMANDS entries found in ${MOCK_PATH}`],
    [s.mockCases, `no serviced case labels found in the mock's invoke switch (${MOCK_PATH})`],
  ];
  for (const [list, message] of surfaces) {
    if (list.length === 0) problems.push(message);
  }
  if (problems.length) return problems; // empty parses make set diffs meaningless

  if (s.handlerOccurrences !== 1) {
    problems.push(
      `${LIB_PATH} carries ${s.handlerOccurrences} generate_handler! lists — the registration must live in exactly one`,
    );
  }

  for (const [list, what] of [
    [s.commandFns, `the #[tauri::command] set`],
    [s.handlerCommands, `the generate_handler! list`],
    [s.docCommands, `the doc table`],
    [s.mockCommands, `the mock's CANONICAL_COMMANDS list`],
    [s.mockCases, `the mock's invoke switch`],
  ]) {
    problems.push(...duplicatesIn(list, what));
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
  );

  for (const cell of s.docUnreadableRows) {
    problems.push(`the ${CLAUSE_ID} table carries a first cell the scan cannot read — ${cell} — rows are \`name\` or \`name\` (event), nothing else`); // prettier-ignore
  }
  const badEventRows = s.docEvents.filter((e) => e !== EVENT_CHANNEL);
  for (const e of badEventRows) {
    problems.push(`the ${CLAUSE_ID} table carries an event row \`${e}\` — the one backend event channel is \`${EVENT_CHANNEL}\``); // prettier-ignore
  }
  if (s.docEvents.length > 1) {
    problems.push(`the ${CLAUSE_ID} table carries ${s.docEvents.length} event rows — the contract states exactly one event channel`); // prettier-ignore
  }
  for (const e of s.emitSites.filter((x) => x.channel === null)) {
    const what =
      e.method === 'emit_to' || e.method === 'emit_str_to'
        ? 'a target/channel argument pair the scan cannot read as string literals — both must be literal'
        : 'a channel the scan cannot read as a string literal — the channel must be literal';
    problems.push(`${e.path}:${e.line} calls .${e.method}( with ${what} so the single-channel contract stays checkable`); // prettier-ignore
  }
  const readable = s.emitSites.filter((e) => e.channel !== null);
  const channelSites = readable.filter((e) => e.channel === EVENT_CHANNEL);
  const otherSites = readable.filter((e) => e.channel !== EVENT_CHANNEL);
  if (channelSites.length !== 1) {
    problems.push(
      `expected exactly one \`${EVENT_CHANNEL}\` emit site, found ${channelSites.length}` +
        (channelSites.length
          ? `: ${channelSites.map((e) => `${e.path}:${e.line}`).join(', ')}`
          : ''),
    );
  }
  for (const e of otherSites) {
    problems.push(`${e.path}:${e.line} emits on \`${e.channel}\` — \`${EVENT_CHANNEL}\` is the only event channel the backend emits`); // prettier-ignore
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
 * @returns {{ problems: string[], commandCount: number, grantCount: number }}
 */
export function auditTree(readFile, rustFiles, capabilityFiles) {
  const strippedByPath = new Map(
    rustFiles.map((p) => [p, stripRustComments(readFile(p).replace(/\r\n/g, '\n'))]),
  );
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
    emitSites: extractEmitSites(strippedByPath),
    fileGrants,
    docGrants: extractDocGrants(section),
    mockCommands: mockRead.commands,
    mockCases: extractMockServicedCases(mockSource),
  };
  return {
    problems: [...collectionProblems, ...evaluateCommandSurface(s)],
    commandCount: new Set(s.commandFns).size,
    grantCount: new Set(s.fileGrants).size,
  };
}

/* c8 ignore start — the CLI wrapper enumerates the tracked crate sources and
   formats the pass/fail output; the pure extraction and evaluation core above
   is unit-tested. */
function run() {
  const lsFiles = (dir) =>
    execFileSync('git', ['ls-files', dir], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const rustFiles = lsFiles(SRC_DIR).filter((f) => f.endsWith('.rs'));
  const capabilityFiles = lsFiles(CAPABILITIES_DIR);
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return ''; // an unreadable surface fails the non-empty guards loudly
    }
  };
  const { problems, commandCount, grantCount } = auditTree(readFile, rustFiles, capabilityFiles);

  if (problems.length) {
    console.error(
      `✗ the desktop command surface drifted from its committed contract:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  The DSH-1 table (${DOC_PATH}), the #[tauri::command] set, the generate_handler!\n` +
        `  registration, and the capability grants must state the same surface, updated\n` +
        `  together in the same change (${DOC_PATH} §DSH-1); the integration mock's\n` +
        `  serviced-command list is held equal to that surface by the desktop integration\n` +
        `  suite's contract (docs/test/integration/desktop.md).\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ desktop command surface consistent: ${commandCount} commands agree across the crate, ` +
      `the registration, the doc table, and the integration mock; one ${EVENT_CHANNEL} emit ` +
      `site; ${grantCount} grants match the doc.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
