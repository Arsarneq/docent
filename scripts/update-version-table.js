/**
 * update-version-table.js — Propagates schema versions into every version-bearing
 * doc and platform manifest.
 *
 * Source of truth: the `version` field of each platform's leaf delta in schemas/
 * (extension.delta.json, desktop-windows.delta.json). This script only READS
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

function readVersion(deltaPath) {
  const delta = JSON.parse(readFileSync(join(ROOT, deltaPath), 'utf8'));
  if (!delta.version) {
    throw new Error(`${deltaPath} is missing a "version" field`);
  }
  return delta.version;
}

const extVersion = readVersion('schemas/extension.delta.json');
const deskVersion = readVersion('schemas/desktop-windows.delta.json');

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

// ─── README + session-format version tables ──────────────────────────────────
//
// One row PER PLATFORM. Extension and desktop are versioned independently, so a
// single coupled row (the old "Ext Schema | Ext | Desktop Schema | Desktop"
// layout) repeated the unchanged platform's values on every single-platform
// bump and implied a cross-platform relationship that doesn't exist. A
// per-platform row changes only when that platform changes, and adding a new
// surface (e.g. Linux, #84) is just another entry in this list.
const platformRows = [
  {
    name: 'Chrome Extension',
    schemaFile: 'schemas/dist/extension.schema.json',
    version: extVersion,
  },
  {
    name: 'Desktop (Windows)',
    schemaFile: 'schemas/dist/desktop-windows.schema.json',
    version: deskVersion,
  },
];

// ─── README table ─────────────────────────────────────────────────────────────
//
// Platform · schema version only. App versions are driven by the git release
// tag and move independently of the schema, so listing them here (with a
// forward-range "+") would imply a coupling that doesn't exist and quickly go
// stale. Files are self-describing via the docent_format stamp, so the schema
// version is the fact worth publishing.
const readmeTable = [
  '| Platform | Schema version |',
  '| --- | --- |',
  ...platformRows.map((p) => `| ${p.name} | ${p.version} |`),
].join('\n');

updateBetweenMarkers(
  'README.md',
  '<!-- VERSION_TABLE_START -->',
  '<!-- VERSION_TABLE_END -->',
  readmeTable,
);
console.log(`✓ README.md updated (extension: ${extVersion}, desktop: ${deskVersion})`);

// ─── docs/session-format.md table ─────────────────────────────────────────────

const specTable = [
  '| Schema file | Platform | Current |',
  '|---|---|---|',
  ...platformRows.map((p) => `| \`${p.schemaFile}\` | ${p.name} | ${p.version} |`),
].join('\n');

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
