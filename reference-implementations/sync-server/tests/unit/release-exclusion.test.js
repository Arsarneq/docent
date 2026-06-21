import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Release-exclusion guard.
 *
 * The entire `reference-implementations/` tree is a repository/testing artifact
 * and must never ship in a product release. Rather than add an opt-out to the
 * publish pipelines, the exclusion is *structural*: the pipelines and the
 * release-output guard scope themselves to `packages/extension/`,
 * `packages/desktop/`, and `schemas/dist/` (+ delta versions) respectively, so
 * `reference-implementations/**` is simply never an input.
 *
 * This suite asserts that structural fact so a future change that broadens a
 * pipeline's scope to sweep in `reference-implementations/` is caught here. It
 * reads the real workflow/guard files (it does NOT modify them).
 *
 * One documented exception: the release-output guard's POSITIVE mode (run on the
 * pipeline's own `automated/version-table-update` PR) allow-lists the
 * reference-server seed-_sample_ stamps. Those are a release OUTPUT — re-stamped
 * at release by `update-version-table.js`, the same exception that lets release
 * tooling stamp version-bearing material the repo owns without shipping the
 * server. The seed-sample stamps are the ONLY reference-implementations mention
 * permitted in the guard; the publish BUILD pipelines stay free of it entirely.
 *
 * Repo-root-relative paths are resolved from this test file's location:
 *   .../docent/reference-implementations/sync-server/tests/unit  → up 4 → repo root.
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..', '..');

const PUBLISH_YML = resolve(REPO_ROOT, '.github/workflows/publish.yml');
const PUBLISH_DESKTOP_YML = resolve(REPO_ROOT, '.github/workflows/publish-desktop.yml');
const GUARD_JS = resolve(REPO_ROOT, 'scripts/check-no-release-outputs.js');

function read(path) {
  return readFileSync(path, 'utf8');
}

describe('release exclusion of reference-implementations/', () => {
  it('publish.yml packages only packages/extension/ and never references reference-implementations', () => {
    const yml = read(PUBLISH_YML);

    // The publish input is the extension package, and only that.
    assert.match(
      yml,
      /packages\/extension/,
      'publish.yml is expected to scope its packaging to packages/extension/',
    );
    assert.match(
      yml,
      /cd packages\/extension && zip -r \.\.\/\.\.\/extension\.zip \./,
      'publish.yml is expected to zip only the packages/extension/ directory',
    );

    // reference-implementations/ must never be an input to the publish pipeline.
    assert.doesNotMatch(
      yml,
      /reference-implementations/,
      'publish.yml must NOT reference reference-implementations/ (it is excluded from releases)',
    );
  });

  it('publish-desktop.yml builds only packages/desktop/ and never references reference-implementations', () => {
    const yml = read(PUBLISH_DESKTOP_YML);

    // The desktop build is rooted at packages/desktop, and only that.
    assert.match(
      yml,
      /projectPath: packages\/desktop/,
      'publish-desktop.yml is expected to build with projectPath: packages/desktop',
    );

    // reference-implementations/ must never be an input to the desktop pipeline.
    assert.doesNotMatch(
      yml,
      /reference-implementations/,
      'publish-desktop.yml must NOT reference reference-implementations/ (it is excluded from releases)',
    );
  });

  it('check-no-release-outputs.js: negative guard scopes to schemas/dist/ + delta versions; touches reference-implementations ONLY for the seed-sample stamps', () => {
    const js = read(GUARD_JS);

    // The NEGATIVE guard (what a feature branch may not touch) is still scoped to
    // the composed schemas and the delta versions — nothing broader.
    assert.match(
      js,
      /FORBIDDEN_PATHS = \['schemas\/dist\/'\]/,
      "check-no-release-outputs.js is expected to guard the 'schemas/dist/' release artifact",
    );
    assert.match(
      js,
      /DELTA_RE = \/\^schemas\\\/\.\*\\\.delta\\\.json\$\//,
      'check-no-release-outputs.js is expected to guard schemas/*.delta.json versions',
    );

    // The POSITIVE mode (the automated/version-table-update PR) allow-lists every
    // release output, which includes the reference-server seed-sample stamps —
    // those ARE a release output (re-stamped by update-version-table.js). So a
    // reference-implementations mention is permitted HERE, but ONLY for those
    // seed-sample files — never the server or the tree at large.
    const refMentions = js.match(/reference-implementations[^\s'"]*/g) || [];
    for (const m of refMentions) {
      assert.match(
        m,
        /^reference-implementations\/sync-server\/samples\/[a-z-]+-sample\.json$/,
        `check-no-release-outputs.js may reference reference-implementations ONLY for seed-sample stamps, not "${m}"`,
      );
    }
  });
});
