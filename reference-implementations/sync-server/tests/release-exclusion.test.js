import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Release-exclusion guard (Task 11; Requirements 9.3, 9.4, 9.5).
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
 * reads the real workflow/guard files (it does NOT modify them — Task 11 only
 * verifies the existing exclusion).
 *
 * Repo-root-relative paths are resolved from this test file's location:
 *   .../docent/reference-implementations/sync-server/tests  → up 3 → repo root.
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..');

const PUBLISH_YML = resolve(REPO_ROOT, '.github/workflows/publish.yml');
const PUBLISH_DESKTOP_YML = resolve(REPO_ROOT, '.github/workflows/publish-desktop.yml');
const GUARD_JS = resolve(REPO_ROOT, 'scripts/check-no-release-outputs.js');

function read(path) {
  return readFileSync(path, 'utf8');
}

describe('release exclusion of reference-implementations/ (R9.3, R9.4, R9.5)', () => {
  it('publish.yml packages only packages/extension/ and never references reference-implementations (R9.3, R9.4)', () => {
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

  it('publish-desktop.yml builds only packages/desktop/ and never references reference-implementations (R9.3, R9.4)', () => {
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

  it('check-no-release-outputs.js guards only schemas/dist/ + delta versions and never references reference-implementations (R9.5)', () => {
    const js = read(GUARD_JS);

    // The guard scopes itself to the composed schemas and the delta versions.
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

    // The guard says nothing about reference-implementations/ — it is outside its
    // scope, so the reference server cannot trip it (R9.5).
    assert.doesNotMatch(
      js,
      /reference-implementations/,
      'check-no-release-outputs.js must NOT reference reference-implementations/ (it guards only release outputs)',
    );
  });
});
