/**
 * release-context.js — Guard for release-only operations.
 *
 * Some scripts write version-bearing RELEASE OUTPUTS — bumping a schema
 * version, recomposing schemas/dist/, rewriting the README/session-format
 * version tables, and the app manifests. Those must only happen in the release
 * pipeline, never on a feature branch (a stray local run leaks release state
 * into a PR — which is exactly the mistake this guard prevents).
 *
 * A run counts as a release context when ANY of these is true:
 *   - DOCENT_RELEASE=1            — explicit opt-in (the publish workflows set this)
 *   - GITHUB_EVENT_NAME=release   — GitHub Actions release event
 *   - GITHUB_REF=refs/tags/...    — a tag build
 *
 * Outside a release context the guarded script aborts with a clear message
 * instead of mutating release outputs. Read-only modes (e.g. `--check`) must
 * NOT call this — they are safe to run anywhere.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * @returns {boolean} true if the current process is running in a release context
 */
export function isReleaseContext() {
  const env = process.env;
  if (env.DOCENT_RELEASE === '1') return true;
  if (env.GITHUB_EVENT_NAME === 'release') return true;
  if (typeof env.GITHUB_REF === 'string' && env.GITHUB_REF.startsWith('refs/tags/')) return true;
  return false;
}

/**
 * Abort the process unless running in a release context.
 *
 * @param {string} action - short description of the release-only action, for the message
 */
export function assertReleaseContext(action) {
  if (isReleaseContext()) return;
  console.error(
    `✗ Refusing to ${action} outside a release context.\n` +
      '  This writes release-only outputs (version bumps, schemas/dist/, version\n' +
      '  tables, app manifests) that must be produced by the release pipeline, not\n' +
      '  committed to a feature branch.\n\n' +
      '  If you really mean to run this locally (e.g. to preview a release), set\n' +
      '  DOCENT_RELEASE=1. To only SEE what would change without writing, use the\n' +
      "  script's read-only mode where available (e.g. `--check`).",
  );
  process.exit(1);
}
