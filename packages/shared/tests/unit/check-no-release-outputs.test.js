/**
 * check-no-release-outputs.test.js — Unit tests for the release-output guard
 * (scripts/check-no-release-outputs.js) that gates CI. Its two modes protect
 * the release pipeline's outputs: feature branches must not touch them, and the
 * pipeline's own automation branch must contain nothing else. These tests prove
 * the classification red paths fire (a dist/ touch, a delta version bump, a
 * ride-along file on the automation branch) and that the deliberate green edges
 * stay green (delta content changes, added/deleted deltas).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedReleaseOutput,
  featureBranchViolations,
  automatedBranchViolations,
  parsePorcelainPaths,
  AUTOMATED_BRANCH,
  DELTA_RE,
} from '../../../../scripts/check-no-release-outputs.js';

/** versionAt stub from a { 'ref:file': version } table (missing key = absent file). */
const versionTable = (entries) => (ref, file) => entries[`${ref}:${file}`] ?? null;

describe('featureBranchViolations — the guard has teeth', () => {
  it('flags any change under schemas/dist/', () => {
    const violations = featureBranchViolations({
      files: ['schemas/dist/extension.schema.json', 'packages/shared/lib/session.js'],
      baseRef: 'origin/main',
      versionAt: versionTable({}),
    });
    assert.deepEqual(violations, [
      'schemas/dist/extension.schema.json (composed schema is a release artifact)',
    ]);
  });

  it('flags a delta version bump, naming both versions', () => {
    const violations = featureBranchViolations({
      files: ['schemas/extension.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({
        'origin/main:schemas/extension.delta.json': '3.0.0',
        'HEAD:schemas/extension.delta.json': '3.1.0',
      }),
    });
    assert.deepEqual(violations, [
      'schemas/extension.delta.json (version bumped 3.0.0 → 3.1.0 — release pipeline owns this)',
    ]);
  });

  it('allows a delta content change that does not bump the version', () => {
    const violations = featureBranchViolations({
      files: ['schemas/extension.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({
        'origin/main:schemas/extension.delta.json': '3.0.0',
        'HEAD:schemas/extension.delta.json': '3.0.0',
      }),
    });
    assert.deepEqual(violations, []);
  });

  it('allows a brand-new delta (absent at base) and a deleted delta (absent at HEAD)', () => {
    const added = featureBranchViolations({
      files: ['schemas/desktop-linux.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({ 'HEAD:schemas/desktop-linux.delta.json': '1.0.0' }),
    });
    assert.deepEqual(added, []);

    const deleted = featureBranchViolations({
      files: ['schemas/old.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({ 'origin/main:schemas/old.delta.json': '1.0.0' }),
    });
    assert.deepEqual(deleted, []);
  });

  it('reports nothing for ordinary source changes', () => {
    const violations = featureBranchViolations({
      files: ['packages/extension/content/recorder.js', 'schemas/shared.schema.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({}),
    });
    assert.deepEqual(violations, []);
  });
});

describe('automatedBranchViolations — nothing rides along', () => {
  it('flags a file outside the release-output set', () => {
    const violations = automatedBranchViolations({
      files: ['README.md', 'packages/shared/lib/session.js'],
    });
    assert.deepEqual(violations, [
      `packages/shared/lib/session.js (not a release output — must not change on ${AUTOMATED_BRANCH})`,
    ]);
  });

  it('accepts the full legitimate regeneration set', () => {
    const violations = automatedBranchViolations({
      files: [
        'schemas/dist/extension.schema.json',
        'schemas/extension.delta.json',
        'README.md',
        'docs/technical/session-format.md',
        'packages/extension/manifest.json',
        'packages/desktop/src-tauri/tauri.conf.json',
        'packages/desktop/src-tauri/Cargo.toml',
        'packages/desktop/src-tauri/Cargo.lock',
        'reference-implementations/sync-server/samples/extension-sample.json',
        'reference-implementations/sync-server/samples/desktop-windows-sample.json',
      ],
    });
    assert.deepEqual(violations, []);
  });
});

describe('isAllowedReleaseOutput / DELTA_RE', () => {
  it('treats any schemas/*.delta.json as a release-output surface', () => {
    assert.equal(DELTA_RE.test('schemas/extension.delta.json'), true);
    assert.equal(DELTA_RE.test('schemas/desktop-windows.delta.json'), true);
    assert.equal(DELTA_RE.test('schemas/shared.schema.json'), false);
    assert.equal(isAllowedReleaseOutput('schemas/extension.delta.json'), true);
  });

  it('matches directory prefixes and exact paths, not lookalikes', () => {
    assert.equal(isAllowedReleaseOutput('schemas/dist/anything.json'), true);
    assert.equal(isAllowedReleaseOutput('README.md'), true);
    assert.equal(isAllowedReleaseOutput('docs/README.md'), false);
    assert.equal(isAllowedReleaseOutput('README.md.bak'), false);
  });
});

describe('parsePorcelainPaths', () => {
  it('strips the 2-char status and keeps untracked (??) entries', () => {
    const out = ' M schemas/dist/extension.schema.json\n?? schemas/dist/new-platform.schema.json\n';
    assert.deepEqual(parsePorcelainPaths(out), [
      'schemas/dist/extension.schema.json',
      'schemas/dist/new-platform.schema.json',
    ]);
  });

  it('returns nothing for empty output', () => {
    assert.deepEqual(parsePorcelainPaths(''), []);
    assert.deepEqual(parsePorcelainPaths('\n'), []);
  });
});
