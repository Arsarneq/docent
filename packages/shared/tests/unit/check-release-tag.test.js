/**
 * check-release-tag.test.js — Unit tests for the release tag <-> pre-release flag
 * consistency guard used by the publish workflows.
 *
 * Invariant under test: a tag has a pre-release suffix (`X.Y.Z-rc.N`) IFF the
 * GitHub release is flagged pre-release. Either mismatch is a release mistake.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkReleaseTag } from '../../../../scripts/check-release-tag.js';

describe('checkReleaseTag — tag suffix <-> prerelease flag', () => {
  it('final tag + not-prerelease is consistent', () => {
    const r = checkReleaseTag({
      tag: 'extension-v3.1.0',
      isPrerelease: 'false',
      prefix: 'extension-v',
    });
    assert.equal(r.ok, true);
    assert.equal(r.hasSuffix, false);
    assert.equal(r.version, '3.1.0');
  });

  it('pre-release tag + prerelease flag is consistent', () => {
    const r = checkReleaseTag({
      tag: 'desktop-v2.1.0-rc.1',
      isPrerelease: 'true',
      prefix: 'desktop-v',
    });
    assert.equal(r.ok, true);
    assert.equal(r.hasSuffix, true);
    assert.equal(r.version, '2.1.0-rc.1');
  });

  it('pre-release tag published as a FINAL release is rejected', () => {
    const r = checkReleaseTag({
      tag: 'desktop-v2.1.0-rc.1',
      isPrerelease: 'false',
      prefix: 'desktop-v',
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /pre-release suffix but the GitHub release is NOT marked pre-release/);
  });

  it('final tag marked as a PRE-release is rejected', () => {
    const r = checkReleaseTag({
      tag: 'extension-v3.1.0',
      isPrerelease: 'true',
      prefix: 'extension-v',
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /final X\.Y\.Z but the GitHub release IS marked pre-release/);
  });

  it('accepts a real boolean for isPrerelease (not just the string)', () => {
    assert.equal(
      checkReleaseTag({ tag: 'desktop-v1.0.0-rc.2', isPrerelease: true, prefix: 'desktop-v' }).ok,
      true,
    );
    assert.equal(
      checkReleaseTag({ tag: 'desktop-v1.0.0', isPrerelease: false, prefix: 'desktop-v' }).ok,
      true,
    );
  });
});
