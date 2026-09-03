/**
 * check-version-sync.js — Verifies version tables in docs match the schema
 * versions.
 *
 * The version source of truth is each platform's leaf delta
 * (schemas/<platform>.delta.json) — that is where bump-schema.js writes and
 * where the composed schema's version comes from. This reads those and checks
 * that README.md and docs/technical/session-format.md state them between their
 * markers.
 *
 * The tables are read as TABLES, row by row, rather than searched for the
 * version text: each document's table is selected by the header its writer
 * states, each expected platform must have exactly one row there, that row's
 * version cell must EQUAL the delta's version, and a row naming a platform this
 * check reads no version for is refused. Reading the rows is what distinguishes
 * the shapes a text search cannot: two platforms' versions swapped between
 * their rows, a row stated twice, a platform whose row is gone while another
 * carries its number, and a version that is only a substring of the one stated.
 *
 * The expectations are keyed by platform NAME, mirroring the writer's own
 * per-platform rows ([`update-version-table.js`](./update-version-table.js)),
 * so a platform added there is added here in the same change and the two stay
 * in lockstep.
 *
 * Exits with code 1 if any mismatch is found. Used by CI to catch drift.
 *
 * Usage:
 *   node scripts/check-version-sync.js
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLATFORM_SURFACES } from './build-schemas.js';
import { parseTables } from './check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..');

const START_MARKER = '<!-- VERSION_TABLE_START -->';
const END_MARKER = '<!-- VERSION_TABLE_END -->';

/**
 * The platforms whose schema version the tables state, each with the leaf delta
 * that version is read from and the NAME its row is keyed by — the roster the
 * schema builder states, re-exported rather than restated so this check and the
 * version-table writer read one platform list between them.
 */
export const PLATFORMS = PLATFORM_SURFACES;

/**
 * The docs whose version tables must match the schema versions, each with the
 * shape its own table is written in: the header row that selects it, and where
 * in a row the platform name and the version stand. The two differ — the README
 * states platform and version alone, the session-format doc leads with the
 * schema file — so a row read has to know which document it is reading. The
 * platform column, never column 0, is what a row is keyed on.
 */
export const CHECKED_FILES = [
  {
    path: 'README.md',
    header: ['Platform', 'Schema version'],
    platformColumn: 0,
    versionColumn: 1,
  },
  {
    path: 'docs/technical/session-format.md',
    header: ['Schema file', 'Platform', 'Current'],
    platformColumn: 1,
    versionColumn: 2,
  },
];

/**
 * Pure core: read the schema version out of a parsed delta file.
 * @param {any} delta parsed schemas/<platform>.delta.json content
 * @param {string} deltaPath repo-relative path, for the error message
 * @returns {{ version: string } | { error: string }}
 */
export function readVersionFrom(delta, deltaPath) {
  if (!delta.version) return { error: `✗ ${deltaPath} is missing a "version" field` };
  return { version: delta.version };
}

/** One table's cells as text: trimmed, so the writer's column padding is inert. */
const cells = (row) => row.map((cell) => (cell ?? '').trim());

/**
 * Pure core: check one doc's version table states each expected platform once,
 * with the version that platform's leaf delta carries.
 * `doc` is the descriptor from {@link CHECKED_FILES}; its `path` composes the
 * messages the CLI prints.
 * @param {string} content the doc's full text
 * @param {{ path: string, header: string[], platformColumn: number, versionColumn: number }} doc
 * @param {{ name: string, version: string }[]} expected the platforms and their versions
 * @returns {{ ok: boolean, messages: string[] }} the error lines when not ok,
 *   the single success line when ok
 */
export function checkVersionTable(content, doc, expected) {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    return { ok: false, messages: [`✗ ${doc.path}: missing VERSION_TABLE markers`] };
  }

  // Only the marker slice is read, so the same version written in prose
  // elsewhere in the document answers for nothing.
  const heading = doc.header.join(' | ');
  const tables = parseTables(content.slice(startIdx, endIdx)).filter(
    (table) => cells(table.header).join(' | ') === heading,
  );
  if (tables.length !== 1) {
    return {
      ok: false,
      messages: [
        `✗ ${doc.path}: ${tables.length} table(s) between the markers carry the header \`${heading}\` — this check reads exactly one`,
      ],
    };
  }

  const rows = tables[0].rows.map(cells);
  const messages = [];
  for (const { name, version } of expected) {
    const stated = rows.filter((row) => (row[doc.platformColumn] ?? '') === name);
    if (stated.length !== 1) {
      messages.push(
        `✗ ${doc.path}: the version table states ${stated.length} row(s) for "${name}" — each platform states exactly one`,
      );
      continue;
    }
    const cell = stated[0][doc.versionColumn] ?? '';
    if (cell !== version) {
      messages.push(
        `✗ ${doc.path}: the version table states "${cell}" for "${name}", and its leaf delta carries "${version}"`,
      );
    }
  }
  const names = expected.map((platform) => platform.name);
  for (const row of rows) {
    const name = row[doc.platformColumn] ?? '';
    if (!names.includes(name)) {
      messages.push(
        `✗ ${doc.path}: the version table states a row for "${name}", which is not a platform this check reads a version for`,
      );
    }
  }

  if (messages.length > 0) return { ok: false, messages };
  return {
    ok: true,
    messages: [
      `✓ ${doc.path}: versions match (${expected.map((p) => `${p.name}: ${p.version}`).join(', ')})`,
    ],
  };
}

function run() {
  // Fail fast on a missing version field, in read order, before any table
  // checks — a delta without a version has no truth to sync to.
  const readVersion = (deltaPath) => {
    const result = readVersionFrom(
      JSON.parse(readFileSync(join(ROOT, deltaPath), 'utf8')),
      deltaPath,
    );
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    return result.version;
  };

  const expected = PLATFORMS.map(({ name, delta }) => ({ name, version: readVersion(delta) }));

  let allOk = true;
  for (const doc of CHECKED_FILES) {
    const content = readFileSync(join(ROOT, doc.path), 'utf8');
    const { ok, messages } = checkVersionTable(content, doc, expected);
    for (const message of messages) (ok ? console.log : console.error)(message);
    allOk = ok && allOk;
  }

  if (!allOk) {
    console.error('\nVersion mismatch detected. Run `npm run update-version-table` to fix.');
    process.exit(1);
  }

  console.log('\n✓ All version tables in sync with schema files.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
