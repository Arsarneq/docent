/**
 * update-version-table.js — Updates the version compatibility table in README.md
 *
 * Reads the current schema, extension, and desktop versions from their respective
 * config files, then updates the version compatibility table in README.md between
 * the VERSION_TABLE_START and VERSION_TABLE_END markers.
 *
 * If the top row already has the current schema version, no changes are made.
 * If the schema version is new, a new row is prepended to the table.
 *
 * Usage:
 *   node scripts/update-version-table.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// Read schema version from session.schema.json title field
const schemaPath = join(ROOT, 'packages', 'shared', 'session.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const schemaVersionMatch = schema.title.match(/v(\d+\.\d+\.\d+)/);
if (!schemaVersionMatch) {
  console.error('Could not parse schema version from title:', schema.title);
  process.exit(1);
}
const schemaVersion = schemaVersionMatch[1];

// Read extension version from manifest.json
const manifestPath = join(ROOT, 'packages', 'extension', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const extensionVersion = manifest.version;

// Read desktop version from tauri.conf.json
const tauriConfPath = join(ROOT, 'packages', 'desktop', 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
const desktopVersion = tauriConf.version;

// Read README.md
const readmePath = join(ROOT, 'README.md');
let readme = readFileSync(readmePath, 'utf-8');

const START_MARKER = '<!-- VERSION_TABLE_START -->';
const END_MARKER = '<!-- VERSION_TABLE_END -->';

const startIdx = readme.indexOf(START_MARKER);
const endIdx = readme.indexOf(END_MARKER);

if (startIdx === -1 || endIdx === -1) {
  console.error('Could not find VERSION_TABLE markers in README.md');
  process.exit(1);
}

// Extract existing table content
const tableContent = readme.slice(startIdx + START_MARKER.length, endIdx).trim();
const lines = tableContent.split('\n').filter(l => l.trim().length > 0);

// Check if the top data row already has the current schema version
// Table format: header, separator, data rows
// lines[0] = header, lines[1] = separator, lines[2+] = data rows
if (lines.length >= 3) {
  const topDataRow = lines[2];
  const cells = topDataRow.split('|').map(c => c.trim()).filter(c => c.length > 0);
  if (cells[0] === schemaVersion) {
    console.log(`Version table already up to date (schema ${schemaVersion})`);
    process.exit(0);
  }
}

// Build the new row
const newRow = `| ${schemaVersion}  | ${extensionVersion}+   | ${desktopVersion}+  |`;

// Rebuild the table
const header = '| Schema | Extension | Desktop |';
const separator = '|--------|-----------|---------|';

// Collect existing data rows (skip header and separator)
const existingDataRows = lines.length >= 3 ? lines.slice(2) : [];

// Prepend the new row
const allDataRows = [newRow, ...existingDataRows];

const newTable = [header, separator, ...allDataRows].join('\n');

// Replace the table content in README
const before = readme.slice(0, startIdx + START_MARKER.length);
const after = readme.slice(endIdx);
readme = before + '\n' + newTable + '\n' + after;

writeFileSync(readmePath, readme, 'utf-8');
console.log(`✓ Version table updated: schema ${schemaVersion}, extension ${extensionVersion}+, desktop ${desktopVersion}+`);
