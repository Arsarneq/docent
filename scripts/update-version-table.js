/**
 * update-version-table.js — Propagates schema versions into every version-bearing
 * doc and platform manifest.
 *
 * Source of truth: the `version` field of each platform schema in schemas/
 * (extension.schema.json, desktop-windows.schema.json). This script only READS
 * those — it never decides a version. Bump the schema first (see bump-schema.js),
 * then run this to propagate.
 *
 * ⚠️ Writes more than the compatibility tables. A single run edits ALL of:
 *   1. README.md                              — version compatibility table (between markers)
 *   2. docs/session-format.md                 — version table (between markers)
 *   3. README.md                              — desktop release BADGE (Desktop_Release-vX.Y.Z)
 *                                               and release LINK (…/releases/tag/desktop-vX.Y.Z)
 *   4. packages/extension/manifest.json       — extension APP version
 *   5. packages/desktop/src-tauri/tauri.conf.json — desktop APP version
 *
 * Items 4–5 are the trap: the script forces each app version to equal its
 * schema version. Those app/release versions are otherwise owned by the git tag
 * — the publish workflows run THIS step and then overwrite manifest.json /
 * tauri.conf.json from the release tag. So the app-version write is harmless
 * inside a release run but wrong anywhere else.
 *
 * RELEASE-TIME ONLY. Do not run on a content/docs branch (directly or via
 * bump-schema.js): it pre-empts an app/release version with no tag step to
 * correct it. If a change seems to warrant a version bump, flag it for a
 * maintainer to do at release time instead.
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

// ─── README badge versions ────────────────────────────────────────────────────

function updateBadgeVersion(filePath, badgePattern, newVersion) {
  const fullPath = join(ROOT, filePath);
  const content = readFileSync(fullPath, 'utf8');
  const updated = content.replace(badgePattern, newVersion);
  if (updated !== content) {
    writeFileSync(fullPath, updated, 'utf8');
    return true;
  }
  return false;
}

// Desktop badge: [![Desktop vX.Y.Z](https://img.shields.io/badge/Desktop_Release-vX.Y.Z-...
const desktopBadgePattern = /Desktop_Release-v[\d.]+/g;
if (updateBadgeVersion('README.md', desktopBadgePattern, `Desktop_Release-v${deskVersion}`)) {
  console.log(`✓ README.md desktop badge updated to v${deskVersion}`);
}

// Also update the desktop release link tag
const desktopLinkPattern = /desktop-v[\d.]+\)/g;
updateBadgeVersion('README.md', desktopLinkPattern, `desktop-v${deskVersion})`);

// ─── Platform config file versions ───────────────────────────────────────────

function updateJsonVersion(filePath, version) {
  const fullPath = join(ROOT, filePath);
  const json = JSON.parse(readFileSync(fullPath, 'utf8'));
  if (json.version !== version) {
    json.version = version;
    writeFileSync(fullPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    return true;
  }
  return false;
}

if (updateJsonVersion('packages/extension/manifest.json', extVersion)) {
  console.log(`✓ manifest.json version updated to ${extVersion}`);
}

if (updateJsonVersion('packages/desktop/src-tauri/tauri.conf.json', deskVersion)) {
  console.log(`✓ tauri.conf.json version updated to ${deskVersion}`);
}
