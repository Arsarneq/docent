/**
 * bump-schema.js — Bumps a platform schema version and propagates it.
 *
 * ⚠️ RELEASE-TIME ONLY. Bumps the `version` field in the named platform's slim
 * delta (schemas/<platform>.delta.json — the version source of truth), then
 * recomposes the published schemas (build-schemas.js) so the bump lands in the
 * build output, then runs update-version-table.js — which propagates that
 * version not just to the README + session-format version tables, but also to
 * the README desktop badge/release link AND the platform app manifests
 * (manifest.json, tauri.conf.json). Because it writes app/release versions, do
 * NOT run it on a content or docs branch — only when cutting a release. A
 * description-only schema edit does not need a manual bump; flag it and let it
 * ride the next release bump. See update-version-table.js for the full list of
 * files written.
 *
 * Usage:
 *   node scripts/bump-schema.js <platform> <level>
 *
 *   platform: extension | desktop-windows
 *   level:    patch | minor | major
 *
 * Examples:
 *   node scripts/bump-schema.js extension minor
 *   node scripts/bump-schema.js desktop-windows major
 *
 * Or via npm:
 *   npm run bump:schema -- extension minor
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Parse args ───────────────────────────────────────────────────────────────

const [platform, level] = process.argv.slice(2);

const VALID_PLATFORMS = ['extension', 'desktop-windows'];
const VALID_LEVELS = ['patch', 'minor', 'major'];

if (!VALID_PLATFORMS.includes(platform)) {
  console.error(`Error: platform must be one of: ${VALID_PLATFORMS.join(', ')}`);
  console.error(`Got: ${platform ?? '(none)'}`);
  process.exit(1);
}

if (!VALID_LEVELS.includes(level)) {
  console.error(`Error: level must be one of: ${VALID_LEVELS.join(', ')}`);
  console.error(`Got: ${level ?? '(none)'}`);
  process.exit(1);
}

// ─── Bump version ─────────────────────────────────────────────────────────────

// The version source of truth is the slim platform delta. The published
// schemas/<platform>.schema.json is build output (composed from shared base +
// delta by build-schemas.js), so writing the bumped version there would be
// overwritten on the next compose. Bump the delta, then recompose below.
const deltaPath = join(ROOT, 'schemas', `${platform}.delta.json`);
const delta = JSON.parse(readFileSync(deltaPath, 'utf8'));

const oldVersion = delta.version;
if (!oldVersion) {
  console.error(`Error: schema delta ${platform}.delta.json has no "version" field`);
  process.exit(1);
}

const parts = oldVersion.split('.').map(Number);
if (parts.length !== 3 || parts.some(isNaN)) {
  console.error(`Error: version "${oldVersion}" is not valid semver`);
  process.exit(1);
}

let [major, minor, patch] = parts;

switch (level) {
  case 'major':
    major++;
    minor = 0;
    patch = 0;
    break;
  case 'minor':
    minor++;
    patch = 0;
    break;
  case 'patch':
    patch++;
    break;
}

const newVersion = `${major}.${minor}.${patch}`;
delta.version = newVersion;

writeFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n', 'utf8');
console.log(`✓ ${platform}.delta.json: ${oldVersion} → ${newVersion}`);

// ─── Recompose published schemas so the bumped version lands in build output ──

execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-schemas.js')], {
  stdio: 'inherit',
});

// ─── Update documentation tables ─────────────────────────────────────────────

execFileSync(process.execPath, [join(ROOT, 'scripts', 'update-version-table.js')], {
  stdio: 'inherit',
});
