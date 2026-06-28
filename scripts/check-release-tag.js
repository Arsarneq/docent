/**
 * check-release-tag.js — Enforce that a release's tag and its GitHub
 * "pre-release" flag agree.
 *
 * The publish workflows resolve their mode (final vs pre-release) from the
 * GitHub `release.prerelease` flag, while the tag drives the version string
 * (desktop carries the full `2.1.0-rc.1`; the extension strips the suffix). The
 * two signals are deliberately independent — so this guard keeps them honest:
 *
 *   A tag carries a semver pre-release suffix (a `-` after the version, e.g.
 *   `extension-v3.1.0-rc.1`) IF AND ONLY IF the release is flagged pre-release.
 *
 * A mismatch — a `-rc` tag published as a final release, or a clean `X.Y.Z` tag
 * marked pre-release — is a release mistake. Fail fast, before any build, so it
 * can't ship a beta to the store or a final as an unlisted pre-release.
 *
 * Reads from the environment (set by the publish workflows from the release event):
 *   RELEASE_TAG   — github.event.release.tag_name   (e.g. desktop-v2.1.0-rc.1)
 *   IS_PRERELEASE — github.event.release.prerelease  ('true' | 'false')
 *   TAG_PREFIX    — the platform tag prefix           (extension-v | desktop-v)
 *
 * Exits 0 when consistent, 1 with a clear `::error::` annotation when not.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { pathToFileURL } from 'node:url';

/**
 * Pure check, unit-testable in isolation.
 *
 * @param {{ tag: string, isPrerelease: boolean|string, prefix: string }} input
 * @returns {{ ok: boolean, hasSuffix: boolean, isPrerelease: boolean, version: string, message?: string }}
 */
export function checkReleaseTag({ tag, isPrerelease, prefix }) {
  const version = prefix && tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  // A semver pre-release suffix is the `-...` after `X.Y.Z` (build metadata uses `+`).
  const hasSuffix = version.includes('-');
  const pre = isPrerelease === true || isPrerelease === 'true';
  if (hasSuffix === pre) return { ok: true, hasSuffix, isPrerelease: pre, version };
  const message = hasSuffix
    ? `Release tag '${tag}' has a pre-release suffix but the GitHub release is NOT marked pre-release. ` +
      `Mark the release as a pre-release, or tag a final ${prefix}X.Y.Z instead.`
    : `Release tag '${tag}' is a final X.Y.Z but the GitHub release IS marked pre-release. ` +
      `Un-mark pre-release, or tag a pre-release ${prefix}X.Y.Z-rc.N instead.`;
  return { ok: false, hasSuffix, isPrerelease: pre, version, message };
}

function run() {
  const tag = process.env.RELEASE_TAG || '';
  const result = checkReleaseTag({
    tag,
    isPrerelease: process.env.IS_PRERELEASE,
    prefix: process.env.TAG_PREFIX || '',
  });
  if (result.ok) {
    console.log(`✓ tag/pre-release consistent: ${tag} (prerelease=${result.isPrerelease})`);
    return;
  }
  console.error(`::error::${result.message}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
