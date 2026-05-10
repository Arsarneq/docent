/**
 * check-version-sync.js — Verifies version tables in docs match schema files.
 *
 * Reads the version from each platform schema and checks that README.md and
 * docs/session-format.md contain matching version numbers between their markers.
 *
 * Exits with code 1 if any mismatch is found. Used by CI to catch drift.
 *
 * Usage:
 *   node scripts/check-version-sync.js
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Read versions from schema files ──────────────────────────────────────────

function readVersion(schemaPath) {
  const schema = JSON.parse(readFileSync(join(ROOT, schemaPath), 'utf8'));
  if (!schema.version) {
    console.error(`✗ Schema ${schemaPath} is missing a "version" field`);
    process.exit(1);
  }
  return schema.version;
}

const extVersion = readVersion('schemas/extension.schema.json');
const deskVersion = readVersion('schemas/desktop-windows.schema.json');

// ─── Check a file contains the expected versions between markers ──────────────

function checkFile(filePath, expectedExt, expectedDesk) {
  const fullPath = join(ROOT, filePath);
  const content = readFileSync(fullPath, 'utf8');

  const startMarker = '<!-- VERSION_TABLE_START -->';
  const endMarker = '<!-- VERSION_TABLE_END -->';

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error(`✗ ${filePath}: missing VERSION_TABLE markers`);
    return false;
  }

  const tableSection = content.slice(startIdx, endIdx);

  let ok = true;

  if (!tableSection.includes(expectedExt)) {
    console.error(`✗ ${filePath}: expected extension version "${expectedExt}" not found in version table`);
    ok = false;
  }

  if (!tableSection.includes(expectedDesk)) {
    console.error(`✗ ${filePath}: expected desktop version "${expectedDesk}" not found in version table`);
    ok = false;
  }

  if (ok) {
    console.log(`✓ ${filePath}: versions match (extension: ${expectedExt}, desktop: ${expectedDesk})`);
  }

  return ok;
}

// ─── Run checks ───────────────────────────────────────────────────────────────

let allOk = true;

allOk = checkFile('README.md', extVersion, deskVersion) && allOk;
allOk = checkFile('docs/session-format.md', extVersion, deskVersion) && allOk;

if (!allOk) {
  console.error('\nVersion mismatch detected. Run `npm run update-version-table` to fix.');
  process.exit(1);
}

console.log('\n✓ All version tables in sync with schema files.');
