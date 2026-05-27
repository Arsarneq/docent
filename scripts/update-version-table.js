/**
 * update-version-table.js — Updates version compatibility tables from schema files.
 *
 * Reads the `version` field from each platform schema in schemas/ and updates
 * the version tables in README.md and docs/session-format.md between their
 * respective markers.
 *
 * Usage:
 *   node scripts/update-version-table.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Read versions from schema files ──────────────────────────────────────────

function readVersion(schemaPath) {
  const schema = JSON.parse(readFileSync(join(ROOT, schemaPath), 'utf8'));
  if (!schema.version) {
    throw new Error(`Schema ${schemaPath} is missing a "version" field`);
  }
  return schema.version;
}

const extVersion = readVersion('schemas/extension.schema.json');
const deskVersion = readVersion('schemas/desktop-windows.schema.json');

// ─── Update a file between markers ───────────────────────────────────────────

function updateBetweenMarkers(filePath, startMarker, endMarker, newContent) {
  const fullPath = join(ROOT, filePath);
  let content = readFileSync(fullPath, 'utf8');

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Could not find markers in ${filePath}: "${startMarker}" / "${endMarker}"`);
  }

  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);

  content = before + '\n' + newContent + '\n' + after;
  writeFileSync(fullPath, content, 'utf8');
}

// ─── README table ─────────────────────────────────────────────────────────────

const readmeTable = `| Extension Schema | Extension | Desktop Schema | Desktop |
|-----------------|-----------|----------------|---------|
| ${extVersion}           | ${extVersion}+    | ${deskVersion}          | ${deskVersion}+  |`;

updateBetweenMarkers(
  'README.md',
  '<!-- VERSION_TABLE_START -->',
  '<!-- VERSION_TABLE_END -->',
  readmeTable,
);
console.log(`✓ README.md updated (extension: ${extVersion}, desktop: ${deskVersion})`);

// ─── docs/session-format.md table ─────────────────────────────────────────────

const specTable = `| Schema file | Platform | Current |
|---|---|---|
| \`schemas/extension.schema.json\` | Chrome extension | ${extVersion} |
| \`schemas/desktop-windows.schema.json\` | Windows desktop | ${deskVersion} |`;

updateBetweenMarkers(
  'docs/session-format.md',
  '<!-- VERSION_TABLE_START -->',
  '<!-- VERSION_TABLE_END -->',
  specTable,
);
console.log(`✓ docs/session-format.md updated`);
