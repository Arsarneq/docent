/**
 * check-version-sync.js — Verifies version tables in docs match the schema
 * versions.
 *
 * The version source of truth is each platform's leaf delta
 * (schemas/<platform>.delta.json) — that is where bump-schema.js writes and
 * where the composed schema's version comes from. This reads those and checks
 * that README.md and docs/technical/session-format.md contain matching version numbers
 * between their markers.
 *
 * Exits with code 1 if any mismatch is found. Used by CI to catch drift.
 *
 * Usage:
 *   node scripts/check-version-sync.js
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');

const START_MARKER = '<!-- VERSION_TABLE_START -->';
const END_MARKER = '<!-- VERSION_TABLE_END -->';

/** The docs whose version tables must match the schema versions. */
export const CHECKED_FILES = ['README.md', 'docs/technical/session-format.md'];

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

/**
 * Pure core: check one doc's version table contains both expected versions.
 * `filePath` is used only to compose the messages the CLI prints.
 * @param {string} content the doc's full text
 * @param {string} filePath repo-relative path, for the messages
 * @param {string} expectedExt expected extension schema version
 * @param {string} expectedDesk expected desktop schema version
 * @returns {{ ok: boolean, messages: string[] }} the error lines when not ok,
 *   the single success line when ok
 */
export function checkVersionTable(content, filePath, expectedExt, expectedDesk) {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    return { ok: false, messages: [`✗ ${filePath}: missing VERSION_TABLE markers`] };
  }

  const tableSection = content.slice(startIdx, endIdx);
  const messages = [];

  if (!tableSection.includes(expectedExt)) {
    messages.push(
      `✗ ${filePath}: expected extension version "${expectedExt}" not found in version table`,
    );
  }
  if (!tableSection.includes(expectedDesk)) {
    messages.push(
      `✗ ${filePath}: expected desktop version "${expectedDesk}" not found in version table`,
    );
  }

  if (messages.length > 0) return { ok: false, messages };
  return {
    ok: true,
    messages: [
      `✓ ${filePath}: versions match (extension: ${expectedExt}, desktop: ${expectedDesk})`,
    ],
  };
}

function run() {
  // Fail fast on a missing version field, in read order (extension first),
  // before any table checks — a delta without a version has no truth to sync to.
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

  const extVersion = readVersion('schemas/extension.delta.json');
  const deskVersion = readVersion('schemas/desktop-windows.delta.json');

  let allOk = true;
  for (const filePath of CHECKED_FILES) {
    const content = readFileSync(join(ROOT, filePath), 'utf8');
    const { ok, messages } = checkVersionTable(content, filePath, extVersion, deskVersion);
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
