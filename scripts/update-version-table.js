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
 *   6. reference-implementations/sync-server/samples/<platform>-sample.json
 *                                               — the `docent_format.schema_version`
 *                                               stamp of each bundled seed sample
 *
 * Item 6 keeps the reference server's bundled seed samples (used by
 * `POST /__debug/seed { samples: true }`) version-stamped in lockstep with the
 * schema, so they never silently advertise a stale schema version that the
 * pulling client would reject. Only the version STRING is rewritten — never the
 * sample's shape; a shape change is caught earlier, on the feature PR, by the
 * sample-conformance and client-pull E2E tests. This is consistent with the
 * release-exclusion principle: that principle keeps the reference server out of
 * the shipped product BUILD, it does not stop release-time tooling from stamping
 * version-bearing material the repo owns.
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

// Badge ALT-TEXT (raw-markdown + screen-reader fallback). The image URL token and
// the release link are rewritten above, but each badge's alt-text is a separate
// string that otherwise drifts. Anchor on the markdown image opener `[![<Label> v…]`
// so no other "vX.Y.Z" prose in the README can be hit. Whole-token replace (no
// capture groups) mirrors the URL/link rewrites above.
//   • Desktop alt tracks deskVersion (same value as its URL token + link).
//   • Extension alt tracks extVersion deliberately: this describes the REPO/manifest
//     version, NOT the live Chrome Web Store version the dynamic CWS badge IMAGE
//     renders. The two legitimately diverge during a CWS review window — do not
//     "fix" that by pointing the alt-text at the store version.
updateBadgeVersion('README.md', /\[!\[Desktop v[\d.]+\]/g, `[![Desktop v${deskVersion}]`);
updateBadgeVersion('README.md', /\[!\[Extension v[\d.]+\]/g, `[![Extension v${extVersion}]`);

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

// ─── Desktop crate version: Cargo.toml + Cargo.lock ───────────────────────────
//
// Keep the Rust crate version in lockstep with the COMMITTED tauri.conf.json —
// both track the desktop SCHEMA version (deskVersion). Nothing else writes these,
// so without this the crate version drifts (the C-1 finding). Edited by surgical,
// single-match text replaces (Cargo.toml is TOML; Cargo.lock is a generated
// lockfile) — no toml/cargo dependency, no format churn — mirroring the seed-
// sample stamp replace below.
//
// CONSCIOUS DESIGN (mirrors tauri.conf.json exactly): the value written HERE is the
// COMMITTED one and tracks the SCHEMA version. The BUILT binary's crate version is
// overlaid from the release TAG by publish-desktop.yml's tag-bump step (build-only,
// never committed). On a release where tag != schema, committed and shipped crate
// versions differ — the same committed-vs-built split tauri.conf.json already has.
//
// LOCKSTEP: both paths are release outputs the version PR carries, so they MUST stay
// listed in ALLOWED_RELEASE_OUTPUTS in scripts/check-no-release-outputs.js, or that
// guard's POSITIVE mode rejects the pipeline's own PR.

function updateTomlPackageVersion(filePath, version) {
  const fullPath = join(ROOT, filePath);
  const content = readFileSync(fullPath, 'utf8');
  // Anchor on the line-start `version = "..."`: dependency versions are inline
  // (`tauri = { version = "2" }`), never at line start, so this hits only [package].
  const re = /^version = "[^"]*"/m;
  if (!re.test(content)) {
    throw new Error(`No [package] version line found in ${filePath}`);
  }
  const updated = content.replace(re, `version = "${version}"`);
  if (updated !== content) {
    writeFileSync(fullPath, updated, 'utf8');
    return true;
  }
  return false;
}

function updateCargoLockCrateVersion(filePath, crate, version) {
  const fullPath = join(ROOT, filePath);
  const content = readFileSync(fullPath, 'utf8');
  // Anchor on the crate's own [[package]] block — its name line immediately
  // followed by its version line — so we can never hit a DIFFERENT crate that
  // shares the same version string. (`\r?\n` tolerates a CRLF checkout.)
  const pattern = `(name = "${crate}"\\r?\\nversion = ")[^"]*(")`;
  const matches = content.match(new RegExp(pattern, 'g')) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one "${crate}" package block in ${filePath}, found ${matches.length}.`,
    );
  }
  const updated = content.replace(new RegExp(pattern), `$1${version}$2`);
  if (updated !== content) {
    writeFileSync(fullPath, updated, 'utf8');
    return true;
  }
  return false;
}

if (updateTomlPackageVersion('packages/desktop/src-tauri/Cargo.toml', deskVersion)) {
  console.log(`✓ Cargo.toml [package] version updated to ${deskVersion}`);
}

if (
  updateCargoLockCrateVersion(
    'packages/desktop/src-tauri/Cargo.lock',
    'docent-desktop',
    deskVersion,
  )
) {
  console.log(`✓ Cargo.lock docent-desktop version updated to ${deskVersion}`);
}

// ─── Reference-server seed samples: docent_format.schema_version ──────────────
//
// The bundled seed samples carry a `docent_format` stamp. Re-stamp ONLY the
// schema_version so a seeded sample never advertises a stale version the pulling
// client would reject. The sample's shape is intentionally left untouched —
// drift in shape is caught on the feature PR by the conformance + client-pull
// E2E tests, not here. Keyed by platform so each sample tracks its own schema.
//
// This is a SURGICAL text replace of just the version string, NOT a JSON
// round-trip: the samples contain prettier-inlined objects (e.g. `modifiers`,
// `tags`) that `JSON.stringify(…, 2)` would expand, producing format churn. The
// release pipeline's format step (`npm run format` = `prettier --write .`) DOES
// pass over the samples (they are not in .prettierignore), so the surgical
// replace must leave them prettier-clean — which it does, swapping only the
// version string and preserving every other byte. `schema_version` only ever
// appears inside the `docent_format` stamp, so a single-occurrence replace is
// safe.
//
// LOCKSTEP: these two sample paths are release outputs the version PR carries, so
// they must stay listed in ALLOWED_RELEASE_OUTPUTS in
// scripts/check-no-release-outputs.js (and in the seed-sample allowance in
// release-exclusion.test.js). Keep the three in sync.
const SCHEMA_VERSION_RE = /("schema_version":\s*")[^"]*(")/g;

function updateSampleStampVersion(filePath, version) {
  const fullPath = join(ROOT, filePath);
  const content = readFileSync(fullPath, 'utf8');

  const matches = content.match(SCHEMA_VERSION_RE) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one "schema_version" in ${filePath}, found ${matches.length}. ` +
        `The seed sample's docent_format stamp may have changed shape — update this script.`,
    );
  }

  const updated = content.replace(SCHEMA_VERSION_RE, `$1${version}$2`);
  if (updated !== content) {
    writeFileSync(fullPath, updated, 'utf8');
    return true;
  }
  return false;
}

if (
  updateSampleStampVersion(
    'reference-implementations/sync-server/samples/extension-sample.json',
    extVersion,
  )
) {
  console.log(`✓ extension-sample.json stamp updated to ${extVersion}`);
}

if (
  updateSampleStampVersion(
    'reference-implementations/sync-server/samples/desktop-windows-sample.json',
    deskVersion,
  )
) {
  console.log(`✓ desktop-windows-sample.json stamp updated to ${deskVersion}`);
}
