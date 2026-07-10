/**
 * check-cli-smoke.test.js — end-to-end smoke tests for the CI gate scripts'
 * command-line wrappers. Each invocation is deterministic-green against the
 * committed tree, so these prove the wrappers actually run (imports resolve,
 * exit code 0, the success line prints) — the red paths are proven by each
 * script's own unit tests on synthetic input. Under coverage runs the child
 * processes inherit instrumentation, keeping the wrappers inside the measured
 * set. Environment-sensitive scripts get their env pinned so the same path
 * runs on a laptop, a pull-request runner, and a release tag build alike.
 * Adding a smoke here? Pin EVERY env var the target script reads (check its
 * process.env read-set, including modules it imports) — an unpinned var is a
 * path that changes under someone else's environment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

/** Run a check script; throws (failing the test) on a non-zero exit. */
function runScript(script, { args = [], env = {} } = {}) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('check-script CLI smoke (deterministic green paths)', () => {
  it('check-version-sync: the committed version tables are in sync', () => {
    const out = runScript('check-version-sync.js');
    assert.match(out, /All version tables in sync/);
  });

  it('check-no-release-outputs: an empty diff (HEAD base) is clean', () => {
    // Env pinned: a release tag build sets GITHUB_REF=refs/tags/... which would
    // switch the script onto its skip path; force the ordinary PR shape.
    const out = runScript('check-no-release-outputs.js', {
      args: ['HEAD'],
      env: {
        PR_HEAD_REF: '',
        DOCENT_RELEASE: '',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/heads/smoke',
      },
    });
    assert.match(out, /No release-only outputs modified/);
  });

  it('check-doc-reachability: every committed doc is reachable', () => {
    const out = runScript('check-doc-reachability.js');
    assert.match(out, /documentation reachable/);
  });

  it('check-pr-title: accepts a Conventional Commit title', () => {
    const out = runScript('check-pr-title.js', { args: ['ci: smoke-test the title check'] });
    assert.match(out, /valid Conventional Commit/);
  });

  it('check-release-tag: accepts a consistent final tag', () => {
    const out = runScript('check-release-tag.js', {
      env: {
        RELEASE_TAG: 'extension-v9.9.9',
        IS_PRERELEASE: 'false',
        TAG_PREFIX: 'extension-v',
      },
    });
    assert.match(out, /tag\/pre-release consistent/);
  });

  it('check-action-pins: every committed workflow action is SHA-pinned', () => {
    const out = runScript('check-action-pins.js');
    assert.match(out, /pinned/i);
  });
});
