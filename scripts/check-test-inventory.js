/**
 * check-test-inventory.js — the test-suite documents' inventories describe the
 * suites as they are, and the coverage plumbing's hand-maintained file lists
 * identify real sources. Two closures, both committed data that can rot:
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
 * literal, so reformatting a list cannot change what this check sees. Every way
 * the extraction can fail to reach its whole subject — a renamed section or
 * column, a relocated or renamed list, an element form or a surrounding
 * expression this reader does not model — is itself red: a check that silently
 * reads part of a list, or none of it, would pass forever.
 *
 * What this check deliberately cannot see: whether a row's DESCRIPTION is still
 * true (it compares names, never prose); the two directions of the coverage
 * lists that are not entry-shaped — a source file the suites load that no list
 * names (the deliberate subset stated in docs/test/strategy/coverage.md), and
 * an entry naming a tracked source the suites never load, which is well-formed
 * here and simply collects nothing; and its own registration — a suite document
 * or a coverage list that exists but is named in neither DOC_INVENTORIES nor
 * TRACKED_LISTS below is outside this gate until it is registered there, which
 * a new suite's change has to do for itself.
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

/**
 * The desktop crate's test binaries as CI's layer-discovery step reads them: one
 * per `.rs` file at the top of `tests/`. Cargo would also build one per
 * `tests/<name>/main.rs`, but that step (in `.github/workflows/test.yml`) globs
 * `tests/*.rs`, so that form is outside the suite the desktop document
 * enumerates — the rule here tracks the pipeline, not Cargo's full capability.
 */
const CARGO_TEST_BINARY = /^[^/]+\.rs$/;

/**
 * The suite documents and the suites they enumerate. `section` is the `##`
 * heading whose tables make the enumeration claim and `column` their first
 * header cell — together they identify the inventory tables, so a table added
 * elsewhere in the document is free to name whatever it documents. `dir` is the
 * directory the suite lives in, and `selects` decides which paths under it are
 * its members: it mirrors the discovery that actually selects this suite's tests
 * here — the test runner's own rule where nothing narrows it, and the CI step's
 * where one does (see `CARGO_TEST_BINARY`) — so what the check demands a row for
 * is what gets selected. A member is named in the table by its path from `dir`.
 */
export const DOC_INVENTORIES = [
  {
    doc: 'docs/test/e2e.md',
    section: 'What the suite covers',
    column: 'Spec',
    dir: 'packages/extension/tests/e2e/specs',
    selects: (name) => PLAYWRIGHT_TEST_FILE.test(name),
  },
  {
    doc: 'docs/test/desktop-rust.md',
    section: 'Suite layout',
    column: 'Test file',
    dir: 'packages/desktop/src-tauri/tests',
    selects: (name) => CARGO_TEST_BINARY.test(name),
  },
  {
    doc: 'docs/test/integration/desktop.md',
    section: 'What the suite covers',
    column: 'Spec',
    dir: 'packages/desktop/tests/integration',
    selects: (name) => PLAYWRIGHT_TEST_FILE.test(name),
  },
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
 * delimiter row and the body rows after it; fenced code blocks are skipped, so
 * a table-shaped example inside a fence is never read as one.
 * @param {string} markdown
 * @returns {{ section: string | null, header: string[], rows: string[][] }[]}
 */
export function parseTables(markdown) {
  const lines = markdown.split(/\r?\n/);
  const tables = [];
  let fence = null;
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
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

/* ── JavaScript array literals ───────────────────────────────────────────── */

const WORD_CHAR_RE = /[A-Za-z0-9_$]/;
const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * Tokenize JavaScript source far enough to read a data literal out of it:
 * strings (quote style and escapes honoured), identifier-ish words, and single
 * punctuation characters. Comments and whitespace are dropped, so a commented-out
 * or documented occurrence of a name is never mistaken for the declaration.
 * @param {string} source
 * @returns {{ type: 'word' | 'string' | 'punct', value: string }[]}
 */
export function tokenizeJs(source) {
  const tokens = [];
  let i = 0;
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
    if (ch === "'" || ch === '"' || ch === '`') {
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
 * Read the entries of the array literal assigned to `name`. With no `fields`,
 * the entries are the array's own string elements; with them, each element is
 * an object literal and the entry is a record of those properties. The whole
 * literal is read or none of it is: an element this reader does not model, a
 * literal that never closes, a literal embedded in a larger expression, a
 * record missing a requested property, and an empty result each return an
 * `error`, so a list that moved, was renamed, or was restructured fails loudly
 * instead of passing on the part that still parses.
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
      return { error: unreadable(`\`${token.value}\``) };
    }
    if (depth === 2 && record !== null && token.type === 'string') {
      const key = tokens[i - 2];
      const colon = tokens[i - 1];
      if (
        colon?.type === 'punct' &&
        colon.value === ':' &&
        key?.type === 'word' &&
        fields.includes(key.value)
      ) {
        record[key.value] = token.value;
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
};

/**
 * Render an audit result as red output: one block per populated problem class,
 * each enumerating its exact mismatches and naming the fix.
 * @param {ReturnType<typeof auditInventories>} result
 * @returns {string[]} problem blocks (empty when the inventories hold)
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
 * delegates to (parseTables, readListEntries, auditInventories, formatProblems)
 * is unit-tested. */
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

  const problems = formatProblems(auditInventories({ files, readFile }));
  if (problems.length) {
    console.error(problems.join('\n\n'));
    process.exit(1);
  }
  console.log(
    `✓ test inventories current: ${DOC_INVENTORIES.length} suite document(s) enumerate their ` +
      `suites exactly, and ${TRACKED_LISTS.length} coverage list(s) identify tracked sources.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
