/**
 * bump-schema.js — Bumps a platform schema version and updates documentation.
 *
 * Only run at release time. Bumps the version field in the schema file,
 * then runs update-version-table to propagate to README.md and docs/session-format.md.
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

const schemaPath = join(ROOT, 'schemas', `${platform}.schema.json`);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const oldVersion = schema.version;
if (!oldVersion) {
  console.error(`Error: schema ${platform}.schema.json has no "version" field`);
  process.exit(1);
}

const parts = oldVersion.split('.').map(Number);
if (parts.length !== 3 || parts.some(isNaN)) {
  console.error(`Error: version "${oldVersion}" is not valid semver`);
  process.exit(1);
}

let [major, minor, patch] = parts;

switch (level) {
  case 'major': major++; minor = 0; patch = 0; break;
  case 'minor': minor++; patch = 0; break;
  case 'patch': patch++; break;
}

const newVersion = `${major}.${minor}.${patch}`;
schema.version = newVersion;

writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n', 'utf8');
console.log(`✓ ${platform}.schema.json: ${oldVersion} → ${newVersion}`);

// ─── Update documentation tables ─────────────────────────────────────────────

execFileSync(process.execPath, [join(ROOT, 'scripts', 'update-version-table.js')], { stdio: 'inherit' });
