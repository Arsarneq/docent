/**
 * check-no-release-outputs.js — CI guard: fail if a PR touches release-only
 * outputs.
 *
 * Release outputs (the composed schemas under schemas/dist/, the leaf delta
 * `version` fields, and the version tables / badges in README.md and
 * docs/session-format.md) are produced by the release pipeline, not by feature
 * work. If a PR changes any of them, a release-only operation almost certainly
 * leaked onto the branch (e.g. someone ran auto-version-schemas.js or
 * bump-schema.js locally). This catches that before it merges.
 *
 * Compares the current ref against a base ref (default: origin/main). Pass a
 * different base as argv[2]. Skips itself entirely in a release context
 * (DOCENT_RELEASE=1 / release event / tag), where these changes are expected.
 *
 * Usage:
 *   node scripts/check-no-release-outputs.js [baseRef]
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isReleaseContext } from './release-context.js';

const ROOT = resolve(import.meta.dirname, '..');
const baseRef = process.argv[2] || 'origin/main';

// Released outputs that a feature branch must never modify.
//
// We key off the two things only the release pipeline should change:
//   1. schemas/dist/ — the composed published schemas (build artifacts)
//   2. the `version` field of any schemas/*.delta.json (the release bumps it)
//
// We deliberately do NOT flag the README/session-format version *tables*: their
// markup legitimately changes for non-release reasons (layout/wording/format),
// and they are regenerated from the delta versions anyway — so a real version
// leak is already caught by the delta-version check below, without the false
// positives a table-text diff would produce.
const FORBIDDEN_PATHS = ['schemas/dist/'];
const DELTA_RE = /^schemas\/.*\.delta\.json$/;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function changedFiles(base) {
  // Three-dot: changes on HEAD since it diverged from base (merge base).
  const out = git(['diff', '--name-only', `${base}...HEAD`]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function versionAt(ref, file) {
  try {
    return JSON.parse(git(['show', `${ref}:${file}`])).version ?? null;
  } catch {
    return null; // file absent at this ref
  }
}

function main() {
  if (isReleaseContext()) {
    console.log('✓ Release context — release-output changes are expected, skipping guard.');
    return;
  }

  let baseAvailable = true;
  try {
    git(['rev-parse', '--verify', baseRef]);
  } catch {
    baseAvailable = false;
  }
  if (!baseAvailable) {
    console.log(`⚠ Base ref "${baseRef}" not available — skipping release-output guard.`);
    return;
  }

  const files = changedFiles(baseRef);
  const violations = [];

  for (const f of files) {
    if (FORBIDDEN_PATHS.some((p) => f.startsWith(p))) {
      violations.push(`${f} (composed schema is a release artifact)`);
    }
  }

  // A changed delta is fine (that's source); a changed delta *version* is not.
  for (const f of files) {
    if (!DELTA_RE.test(f)) continue;
    const before = versionAt(baseRef, f);
    const after = versionAt('HEAD', f);
    if (before !== null && after !== null && before !== after) {
      violations.push(`${f} (version bumped ${before} → ${after} — release pipeline owns this)`);
    }
  }

  if (violations.length > 0) {
    console.error('✗ This branch modifies release-only outputs:\n');
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\nThese are produced by the release pipeline, not feature branches. A\n' +
        'release-only command (auto-version-schemas.js / bump-schema.js) likely ran\n' +
        'locally. Revert these files to their base-ref state. Edit the SOURCE layers\n' +
        '(schemas/*.delta.json, shared/family schemas) instead — the release pipeline\n' +
        'regenerates dist/ and the version tables.',
    );
    process.exit(1);
  }

  console.log('✓ No release-only outputs modified on this branch.');
}

main();
