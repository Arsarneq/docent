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
 *      pairwise difference is reported in both directions;
 *   2. the doc's one event row names `capture:action`, and the crate sources
 *      contain exactly one emit-family call site (`emit` / `emit_to` /
 *      `emit_filter`) whose channel is that literal (sources are
 *      comment-stripped first, so doc comments naming the channel never
 *      count); an emit-family call whose channel the scan cannot read as a
 *      string literal fails the check rather than passing;
 *   3. the grants declared by the tracked capability files under
 *      `capabilities/` equal the grant identifiers the clause's section names
 *      in backticks — the admission shape is a namespaced identifier ending
 *      in `:default`, `:allow-…`, or `:deny-…`, so other backticked tokens
 *      (command names, the event channel) never read as grants — again in
 *      both directions;
 *   4. the desktop integration suite's mock command list
 *      (`tauri-mock-fixture.js` `CANONICAL_COMMANDS`) equals the crate's
 *      command set, so the suite's one drift-visible consumer of the surface
 *      can neither lag a command the crate gains nor keep servicing one it
 *      loses (that leg's doctrine home is docs/test/integration/desktop.md).
 *
 * Every extracted set must be non-empty — a parse that finds nothing is a
 * broken read of the surface (or a moved surface) and fails loudly rather
 * than passing vacuously.
 *
 * Honest limits: an emit issued through a wrapping helper rather than an
 * Emitter-family method is invisible to the scan, and the table's
 * Direction / What-it-does / Who-calls-it prose is review-held, never parsed.
 *
 * Usage:
 *   node scripts/check-command-surface.js   # or: npm run lint:command-surface
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Repo-relative path of the doc whose DSH-1 table states the contract. */
export const DOC_PATH = 'docs/architecture/application/desktop/windows/application-shell.md';
/** Repo-relative path of the crate entry point carrying generate_handler!. */
export const LIB_PATH = 'packages/desktop/src-tauri/src/lib.rs';
/** Repo-relative directory of the crate sources the command/emit scans read. */
export const SRC_DIR = 'packages/desktop/src-tauri/src';
/** Repo-relative directory of the capability files naming the plugin grants. */
export const CAPABILITIES_DIR = 'packages/desktop/src-tauri/capabilities';
/** Repo-relative path of the integration suite's Tauri mock fixture. */
export const MOCK_PATH = 'packages/desktop/tests/integration/tauri-mock-fixture.js';

/** The one event channel the backend emits, per the doc's event row. */
export const EVENT_CHANNEL = 'capture:action';

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
    if (c === '/' && next === '/') {
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
 * Slice the doc text to the DSH-1 clause's scope: from its marker to the next
 * clause marker or heading (the doc's own scope rule).
 * @param {string} docText the application-shell doc
 * @returns {string} the clause's text, or '' when the marker is absent
 */
export function extractDsh1Section(docText) {
  const marker = '**DSH-1.**';
  const start = docText.indexOf(marker);
  if (start === -1) return '';
  const rest = docText.slice(start + marker.length);
  const end = rest.search(/\n#{2,}\s|\*\*[A-Z][A-Z0-9]*-[1-9][0-9]*\.\*\*/);
  return end === -1 ? docText.slice(start) : docText.slice(start, start + marker.length + end);
}

/**
 * Parse the DSH-1 table's first column into command rows and event rows.
 * Header and separator rows carry no backticked first cell and are skipped.
 * @param {string} section the DSH-1 clause text
 * @returns {{ commands: string[], events: string[] }} names in table order
 */
export function extractDocRows(section) {
  const commands = [];
  const events = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*(\(event\))?\s*\|/);
    if (!m) continue;
    (m[2] ? events : commands).push(m[1]);
  }
  return { commands, events };
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
 * Find emit-family call sites (`.emit(…)`, `.emit_to(…)`, `.emit_filter(…)`)
 * in comment-stripped crate sources. The channel is the first string-literal
 * argument (`emit`/`emit_filter`) or the second (`emit_to`, whose first
 * argument is the target); a call whose channel cannot be read as a string
 * literal is recorded with `channel: null` and fails the evaluation loudly.
 * @param {Map<string, string>} strippedByPath path → comment-stripped source
 * @returns {{ path: string, method: string, channel: string | null, line: number }[]}
 */
export function extractEmitSites(strippedByPath) {
  const sites = [];
  const STR = /^\s*"((?:[^"\\]|\\.)*)"/;
  const SECOND_STR = /^\s*"(?:[^"\\]|\\.)*"\s*,\s*"((?:[^"\\]|\\.)*)"/;
  for (const [path, source] of strippedByPath) {
    for (const m of source.matchAll(/\.(emit|emit_to|emit_filter)\s*\(/g)) {
      const line = source.slice(0, m.index).split('\n').length;
      const rest = source.slice(m.index + m[0].length);
      const arg = rest.match(m[1] === 'emit_to' ? SECOND_STR : STR);
      sites.push({ path, method: m[1], channel: arg ? arg[1] : null, line });
    }
  }
  return sites;
}

/**
 * Parse the mock fixture's `CANONICAL_COMMANDS` array literal.
 * @param {string} fixtureSource tauri-mock-fixture.js source
 * @returns {string[]} the serviced command names, in list order
 */
export function extractMockCommands(fixtureSource) {
  const m = fixtureSource.match(/CANONICAL_COMMANDS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
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
 * @param {{ path: string, method: string, channel: string | null, line: number }[]} s.emitSites
 * @param {string[]} s.fileGrants permissions across the tracked capability files
 * @param {string[]} s.docGrants grant identifiers the doc section names
 * @param {string[]} s.mockCommands the mock fixture's serviced commands
 * @returns {string[]} problems; empty when the contract holds
 */
export function evaluateCommandSurface(s) {
  const problems = [];

  const surfaces = [
    [s.commandFns, `no #[tauri::command] functions found under ${SRC_DIR} — the scan is broken or the commands moved`], // prettier-ignore
    [s.handlerCommands, `no generate_handler! registrations found in ${LIB_PATH}`],
    [s.docCommands, `no command rows found in the DSH-1 table of ${DOC_PATH}`],
    [s.docEvents, `no event row found in the DSH-1 table of ${DOC_PATH}`],
    [s.fileGrants, `no permissions found under ${CAPABILITIES_DIR}`],
    [s.docGrants, `no grant identifiers found in the DSH-1 section of ${DOC_PATH}`],
    [s.mockCommands, `no CANONICAL_COMMANDS entries found in ${MOCK_PATH}`],
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
  ]) {
    problems.push(...duplicatesIn(list, what));
  }

  problems.push(
    ...missingFrom(s.commandFns, s.handlerCommands, `has #[tauri::command] but is not registered in generate_handler! (${LIB_PATH})`), // prettier-ignore
    ...missingFrom(s.handlerCommands, s.commandFns, `is registered in generate_handler! but no #[tauri::command] function defines it`), // prettier-ignore
    ...missingFrom(s.commandFns, s.docCommands, `has #[tauri::command] but no row in the DSH-1 table (${DOC_PATH})`), // prettier-ignore
    ...missingFrom(s.docCommands, s.commandFns, `has a DSH-1 table row but no #[tauri::command] function defines it`), // prettier-ignore
    ...missingFrom(s.commandFns, s.mockCommands, `has #[tauri::command] but the integration mock services no such command (${MOCK_PATH})`), // prettier-ignore
    ...missingFrom(s.mockCommands, s.commandFns, `is serviced by the integration mock but no #[tauri::command] function defines it`), // prettier-ignore
  );

  const badEventRows = s.docEvents.filter((e) => e !== EVENT_CHANNEL);
  for (const e of badEventRows) {
    problems.push(`the DSH-1 table carries an event row \`${e}\` — the one backend event channel is \`${EVENT_CHANNEL}\``); // prettier-ignore
  }
  if (s.docEvents.length > 1) {
    problems.push(`the DSH-1 table carries ${s.docEvents.length} event rows — the contract states exactly one event channel`); // prettier-ignore
  }
  for (const e of s.emitSites.filter((x) => x.channel === null)) {
    problems.push(`${e.path}:${e.line} calls .${e.method}( with a channel the scan cannot read as a string literal — event channels must be literal so the single-channel contract stays checkable`); // prettier-ignore
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
    ...missingFrom(s.fileGrants, s.docGrants, `is granted under ${CAPABILITIES_DIR} but the DSH-1 section does not name it`), // prettier-ignore
    ...missingFrom(s.docGrants, s.fileGrants, `is named as a grant in the DSH-1 section but no tracked capability file grants it`), // prettier-ignore
  );

  return problems;
}

/**
 * Read every surface from the working tree and evaluate the contract.
 * @param {(f: string) => string} readFile repo-relative content reader
 * @param {string[]} rustFiles repo-relative crate source paths to scan
 * @param {string[]} capabilityFiles repo-relative capability .json paths
 * @returns {{ problems: string[], commandCount: number, grantCount: number }}
 */
export function auditTree(readFile, rustFiles, capabilityFiles) {
  const strippedByPath = new Map(
    rustFiles.map((p) => [p, stripRustComments(readFile(p).replace(/\r\n/g, '\n'))]),
  );
  const docText = readFile(DOC_PATH).replace(/\r\n/g, '\n');
  const section = extractDsh1Section(docText);
  const { commands: docCommands, events: docEvents } = extractDocRows(section);
  const { commands: handlerCommands, occurrences: handlerOccurrences } = extractHandlerCommands(
    strippedByPath.get(LIB_PATH) ?? '',
  );

  // Union the grants across every tracked capability file — Tauri loads the
  // whole directory, so a second file widens the webview surface exactly like
  // an entry added to the first. Parse and shape failures are contract
  // problems in their own right, never a thrown stack.
  const collectionProblems = [];
  const fileGrants = [];
  for (const file of capabilityFiles) {
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

  const s = {
    commandFns: [...strippedByPath.values()].flatMap((src) => extractCommandFns(src)),
    handlerCommands,
    handlerOccurrences,
    docCommands,
    docEvents,
    emitSites: extractEmitSites(strippedByPath),
    fileGrants,
    docGrants: extractDocGrants(section),
    mockCommands: extractMockCommands(readFile(MOCK_PATH).replace(/\r\n/g, '\n')),
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
  const capabilityFiles = lsFiles(CAPABILITIES_DIR).filter((f) => f.endsWith('.json'));
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
