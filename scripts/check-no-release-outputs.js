/**
 * check-no-release-outputs.js — CI guard for release-output changes on PRs.
 *
 * Two complementary modes, selected by the PR head branch (PR_HEAD_REF):
 *
 *   NEGATIVE (every normal feature branch) — FAIL if the branch touches a
 *   release-only output. Release outputs (the composed schemas under
 *   schemas/dist/ and the leaf delta `version` fields) are produced by the
 *   release pipeline, not by feature work; a change to them means a release-only
 *   command (auto-version-schemas.js / bump-schema.js) almost certainly leaked
 *   onto the branch. This catches that before it merges.
 *
 *   POSITIVE (the automated/version-table-update branch ONLY) — this is the
 *   branch the release pipeline itself opens to commit the regenerated outputs,
 *   so those changes are EXPECTED here. Rather than forbidding them, verify the
 *   PR is EXACTLY that and nothing more:
 *     1. every changed file is within the known release-output set (nothing
 *        unrelated rode along on the automation branch), and
 *     2. the committed schemas/dist/ is the faithful composition of the source
 *        layers (recompose + assert no drift).
 *   So the release PR's CI is green when legitimate and red when tampered.
 *
 * Compares the current ref against a base ref (default: origin/main). Pass a
 * different base as argv[2]. Skips entirely in a release context
 * (DOCENT_RELEASE=1 / release event / tag), where these changes are expected and
 * are not mediated by a PR.
 *
 * Usage:
 *   node scripts/check-no-release-outputs.js [baseRef]
 *   PR_HEAD_REF=<branch> node scripts/check-no-release-outputs.js [baseRef]
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isReleaseContext } from './release-context.js';

const ROOT = resolve(import.meta.dirname, '..');

// The branch the release pipeline opens to land the regenerated release outputs.
// On this branch the guard runs in POSITIVE mode (see file header).
export const AUTOMATED_BRANCH = 'automated/version-table-update';

// ── The release-output surface ────────────────────────────────────────────────
//
// Single source of truth for "what the release-output mechanism may touch",
// used by BOTH modes:
//   • NEGATIVE mode forbids the subset only the pipeline may change — the
//     composed dist/ and any delta `version` bump.
//   • POSITIVE mode requires EVERY changed file to be inside the full set below,
//     so nothing unrelated can ride along on the automation branch.
//
// Entries ending in `/` are directory prefixes; the rest are exact paths. The
// leaf delta files are matched separately via DELTA_RE (their `version` is the
// thing the pipeline bumps).
//
// LOCKSTEP: this set must mirror what the pipeline actually writes onto the
// branch — extend it in the same change as any new pipeline output that falls
// outside the existing paths/prefixes. The documented invariant lives in
// .github/PUBLISHING.md ("Test gating and the version PR").
const FORBIDDEN_PATHS = ['schemas/dist/'];
export const DELTA_RE = /^schemas\/.*\.delta\.json$/;

const ALLOWED_RELEASE_OUTPUTS = [
  'schemas/dist/', // composed published schemas (build artifacts)
  'README.md', // version table + desktop badge
  'docs/technical/session-format.md', // version table
  'packages/extension/manifest.json', // extension app version
  'packages/desktop/src-tauri/tauri.conf.json', // desktop app version
  'packages/desktop/src-tauri/Cargo.toml', // desktop crate version (lockstep w/ tauri.conf.json)
  'packages/desktop/src-tauri/Cargo.lock', // desktop crate version (regenerated from Cargo.toml)
  'reference-implementations/sync-server/samples/extension-sample.json', // seed-sample stamp
  'reference-implementations/sync-server/samples/desktop-windows-sample.json',
];

/** True if `f` is part of the legitimate release-output surface. */
export function isAllowedReleaseOutput(f) {
  if (DELTA_RE.test(f)) return true;
  return ALLOWED_RELEASE_OUTPUTS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
}

/**
 * Pure core of NEGATIVE mode: the violations a feature branch's changed files
 * carry. `versionAt(ref, file)` supplies a delta file's `version` at a ref
 * (null when the file is absent there) — injected so the rule is testable
 * without git.
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @param {string} opts.baseRef the base ref name (passed through to versionAt)
 * @param {(ref: string, file: string) => (string | null)} opts.versionAt
 * @returns {string[]} violation lines (empty when clean)
 */
export function featureBranchViolations({ files, baseRef, versionAt }) {
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

  return violations;
}

/**
 * Pure core of POSITIVE mode's ride-along rule: files changed on the automation
 * branch that are not release outputs. (The dist-recomposition drift check is
 * inherently impure — it rebuilds the schemas — and stays in the CLI wrapper.)
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @returns {string[]} violation lines (empty when clean)
 */
export function automatedBranchViolations({ files }) {
  const violations = [];
  for (const f of files) {
    if (!isAllowedReleaseOutput(f)) {
      violations.push(`${f} (not a release output — must not change on ${AUTOMATED_BRANCH})`);
    }
  }
  return violations;
}

/**
 * Parse `git status --porcelain` output into paths: strip the 2-char status +
 * separating space. Used with `--porcelain` (not `diff`) so a NEVER-COMMITTED
 * file surfaces as untracked (`??`) and is still caught.
 * @param {string} output raw porcelain output
 * @returns {string[]}
 */
export function parsePorcelainPaths(output) {
  return output
    .split('\n')
    .map((s) => s.slice(3).trim())
    .filter(Boolean);
}

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

/** Base-ref availability — both modes need a base to diff against. */
function baseAvailable(baseRef) {
  try {
    git(['rev-parse', '--verify', baseRef]);
    return true;
  } catch {
    return false;
  }
}

// ── NEGATIVE mode: feature branches must not touch release-only outputs ────────
function guardFeatureBranch(baseRef) {
  const violations = featureBranchViolations({ files: changedFiles(baseRef), baseRef, versionAt });

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

// ── POSITIVE mode: the automated/version-table-update PR must be EXACTLY the ───
//    mechanical regeneration — only release outputs, and a dist/ that faithfully
//    composes from the source layers.
/* c8 ignore start — this wrapper rebuilds the schemas and inspects the working
 * tree, so it cannot run deterministically in a unit test; its decision rules
 * (automatedBranchViolations, parsePorcelainPaths) are unit-tested above, and
 * the wrapper itself runs for real on every release automation PR. */
function validateAutomatedBranch(baseRef) {
  // 1. Nothing unrelated may ride along on the automation branch.
  const violations = automatedBranchViolations({ files: changedFiles(baseRef) });

  // 2. Committed dist/ must be the faithful composition of the source layers:
  //    recompose and assert no drift against what the PR committed. Use
  //    `git status --porcelain` (not `git diff`) so a NEVER-COMMITTED dist file —
  //    e.g. a new platform's composed schema the PR forgot to stage — surfaces as
  //    untracked (`??`) and is still caught, rather than silently passing.
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-schemas.js')], {
    stdio: 'inherit',
  });
  const drifted = parsePorcelainPaths(git(['status', '--porcelain', '--', 'schemas/dist/']));
  for (const f of drifted) {
    violations.push(`${f} (committed dist/ does not match the composed source layers)`);
  }

  if (violations.length > 0) {
    console.error(`✗ The ${AUTOMATED_BRANCH} PR is not a clean release-output regeneration:\n`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\nThis branch is opened by the release pipeline to land ONLY the regenerated\n' +
        'release outputs (schemas/dist/, leaf delta versions, version tables, app\n' +
        'manifests, seed-sample stamps). A change outside that set, or a dist/ that no\n' +
        'longer composes from the source layers, means something other than the\n' +
        'mechanical regeneration reached this branch.',
    );
    process.exit(1);
  }

  console.log(`✓ ${AUTOMATED_BRANCH} PR is a clean release-output regeneration.`);
}
/* c8 ignore stop */

function run() {
  const baseRef = process.argv[2] || 'origin/main';
  const headRef = process.env.PR_HEAD_REF || '';

  if (isReleaseContext()) {
    console.log('✓ Release context — release-output changes are expected, skipping guard.');
    return;
  }

  if (!baseAvailable(baseRef)) {
    console.log(`⚠ Base ref "${baseRef}" not available — skipping release-output guard.`);
    return;
  }

  if (headRef === AUTOMATED_BRANCH) {
    validateAutomatedBranch(baseRef);
  } else {
    guardFeatureBranch(baseRef);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
