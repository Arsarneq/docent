/**
 * auto-version-schemas.js — Mechanically bumps each platform schema's version
 * based on the diff between the last RELEASED schema (schemas/dist/) and the
 * candidate composed from the current source layers.
 *
 * This is the payoff of separating source layers from the committed build
 * output: schemas/dist/<platform>.schema.json IS the last released contract, so
 * we can diff it against composePlatform(<platform>) and classify the change
 * (none/patch/minor/major) per docs/session-format.md, then bump the version in
 * the leaf delta to match — no human guesswork.
 *
 * The version stored in the delta is the source of truth. When a delta's
 * declared version is already AHEAD of what the diff implies (a maintainer bumped
 * deliberately), we keep the higher version and never lower it.
 *
 * Modes:
 *   (default)   apply — write the computed version into each leaf delta that
 *               needs a bump, then recompose schemas/dist/ and propagate version
 *               tables. Intended for the release pipeline.
 *   --check     report only; exit 1 if any delta's declared version is LOWER
 *               than the change requires (i.e. a release would ship an
 *               under-versioned schema). Intended as a CI advisory gate.
 *
 * Usage:
 *   node scripts/auto-version-schemas.js            # apply bumps + propagate
 *   node scripts/auto-version-schemas.js --check    # CI: fail if under-versioned
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PLATFORMS, composePlatform } from './build-schemas.js';
import { classifyChange } from './classify-schema-change.js';

const ROOT = resolve(import.meta.dirname, '..');
const SCHEMAS_DIR = join(ROOT, 'schemas');
const DIST_DIR = join(SCHEMAS_DIR, 'dist');

// platform key → leaf delta filename (the version source of truth).
const DELTA_FILE = {
  extension: 'extension.delta.json',
  'desktop-windows': 'desktop-windows.delta.json',
};

const checkOnly = process.argv.includes('--check');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseSemver(v) {
  const parts = String(v).split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver: "${v}"`);
  }
  const [major, minor, patch] = parts;
  return { major, minor, patch };
}

/**
 * Apply a bump level to a semver string. 'none' returns the input unchanged.
 */
export function bumpVersion(version, level) {
  const { major, minor, patch } = parseSemver(version);
  switch (level) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'none':
      return version;
    default:
      throw new Error(`Unknown bump level: "${level}"`);
  }
}

function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * Compute the per-platform versioning plan without writing anything.
 *
 * For each platform: diff the released dist schema against the freshly composed
 * candidate, classify the change, and derive the version the release SHOULD
 * carry — max(released + implied bump, version already declared in the delta).
 *
 * @returns {Array<{platform, level, releasedVersion, declaredVersion, requiredVersion, reasons}>}
 */
export function plan() {
  const results = [];

  for (const platform of Object.keys(PLATFORMS)) {
    const candidate = composePlatform(platform);
    const declaredVersion = candidate.version;
    const distPath = join(DIST_DIR, `${platform}.schema.json`);

    // First release for a platform (no dist yet): keep the declared version.
    if (!existsSync(distPath)) {
      results.push({
        platform,
        level: 'none',
        releasedVersion: null,
        declaredVersion,
        requiredVersion: declaredVersion,
        reasons: [{ level: 'none', message: 'no released schema yet (first release)' }],
      });
      continue;
    }

    const released = readJson(distPath);
    const { level, reasons } = classifyChange(released, candidate);

    // The version the release must carry from the diff, relative to what was
    // last RELEASED (dist), not what the delta currently declares.
    const bumpedFromReleased = bumpVersion(released.version, level);

    // Never lower a deliberately higher declared version; never ship lower than
    // the diff requires.
    const requiredVersion =
      cmpSemver(declaredVersion, bumpedFromReleased) >= 0 ? declaredVersion : bumpedFromReleased;

    results.push({
      platform,
      level,
      releasedVersion: released.version,
      declaredVersion,
      requiredVersion,
      reasons,
    });
  }

  return results;
}

function printReasons(entry) {
  const top = entry.reasons.slice(0, 12);
  for (const r of top) console.log(`      [${r.level}] ${r.message}`);
  if (entry.reasons.length > top.length) {
    console.log(`      … and ${entry.reasons.length - top.length} more`);
  }
}

function run() {
  const entries = plan();
  let needWrite = false;
  let underVersioned = false;

  for (const e of entries) {
    const tag = e.releasedVersion === null ? 'first release' : `${e.level} change`;
    console.log(
      `• ${e.platform}: released=${e.releasedVersion ?? '—'} declared=${e.declaredVersion} → required=${e.requiredVersion} (${tag})`,
    );
    if (e.level !== 'none') printReasons(e);

    if (cmpSemver(e.declaredVersion, e.requiredVersion) < 0) {
      underVersioned = true;
      if (e.declaredVersion !== e.requiredVersion) needWrite = true;
    }
  }

  if (checkOnly) {
    if (underVersioned) {
      console.error(
        '\n✗ One or more schemas are under-versioned for the changes they contain.\n' +
          '  Run `node scripts/auto-version-schemas.js` to bump, or bump the delta manually.',
      );
      process.exit(1);
    }
    console.log('\n✓ All schema versions are sufficient for their changes.');
    return;
  }

  if (!needWrite) {
    console.log('\n✓ No version bumps needed.');
    return;
  }

  for (const e of entries) {
    if (cmpSemver(e.declaredVersion, e.requiredVersion) >= 0) continue;
    const deltaPath = join(SCHEMAS_DIR, DELTA_FILE[e.platform]);
    const delta = readJson(deltaPath);
    delta.version = e.requiredVersion;
    writeFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n', 'utf8');
    console.log(`✓ ${DELTA_FILE[e.platform]}: ${e.declaredVersion} → ${e.requiredVersion}`);
  }

  // Recompose dist with the new versions, then propagate to doc tables/manifests.
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-schemas.js')], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'update-version-table.js')], {
    stdio: 'inherit',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
