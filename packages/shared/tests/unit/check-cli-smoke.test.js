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
    // Env pinned across this script's whole read-set, so the same path runs
    // everywhere. Its release-context import reads DOCENT_RELEASE,
    // GITHUB_EVENT_NAME and GITHUB_REF — a release tag build would switch the
    // script onto its skip path — and its head-ref derivation reads
    // PR_HEAD_REF, PR_HEAD_REPO, GITHUB_ACTIONS and GITHUB_REPOSITORY, which
    // together choose between the guard's modes. Pinned to the shape of an
    // ordinary feature-branch pull request run by hand.
    const out = runScript('check-no-release-outputs.js', {
      args: ['HEAD'],
      env: {
        PR_HEAD_REF: '',
        PR_HEAD_REPO: '',
        GITHUB_ACTIONS: '',
        GITHUB_REPOSITORY: '',
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

  it('check-test-inventory: the committed suite documents and coverage lists hold', () => {
    const out = runScript('check-test-inventory.js');
    assert.match(out, /test inventories current/);
  });

  it('check-command-surface: the committed desktop command surface satisfies its contract', () => {
    const out = runScript('check-command-surface.js');
    assert.match(out, /desktop command surface consistent/);
  });

  it('check-extension-surface: the committed extension surface satisfies both contracts', () => {
    const out = runScript('check-extension-surface.js');
    assert.match(out, /extension surface consistent/);
  });

  it('check-adapter-surface: the committed adapters satisfy the seam typedef', () => {
    const out = runScript('check-adapter-surface.js');
    assert.match(out, /adapter surface consistent/);
  });

  it('check-capture-surface: the committed capture surfaces satisfy their enumerations', () => {
    const out = runScript('check-capture-surface.js');
    assert.match(out, /capture surfaces consistent/);
  });

  it('check-clause-registry: the committed markers, rows, and citations agree', () => {
    // No env pinned: this check and its import closure (the area map's pattern
    // helpers, the command-surface Rust views, and the test-inventory
    // tokenizer) read no process.env, so no var can switch the path this runs.
    const out = runScript('check-clause-registry.js');
    assert.match(out, /clause registry consistent/);
  });

  it('check-clause-governance: every committed clause citation owes the clause’s doc', () => {
    // Same closure through the citation gate it shares its token reader with,
    // and the same absence of any process.env read in it.
    const out = runScript('check-clause-governance.js');
    assert.match(out, /clause citations governed/);
  });

  it('check-clause-preamble: the committed clause-bearing docs satisfy both legs', () => {
    const out = runScript('check-clause-preamble.js');
    assert.match(out, /clause preambles canonical/);
  });

  it('check-doc-closure: the committed guides satisfy every closure claim', () => {
    const out = runScript('check-doc-closure.js');
    assert.match(out, /doc closure holds/);
  });

  it('check-ci-filter: the committed path-filter split satisfies its contract', () => {
    // No env pinned: the script reads no process.env — its whole closure is the
    // workflow read, the root manifest read, and the YAML parser — so no var can
    // switch the path this runs. It is measured with the rest of the family, and
    // this is what exercises its wrapper.
    const out = runScript('check-ci-filter.js');
    assert.match(out, /path-filter contract holds/);
  });

  it('check-clippy-invocation: the committed guides state the invocation CI runs', () => {
    // No env pinned: this check and its import closure (the doc-closure gate's
    // table and step readers, the path-filter's job reader, and the
    // test-inventory tokenizer) read no process.env. Its externals are the YAML
    // parser and the `git ls-files` this family's tracked-file reader shells out
    // to — the same closure the clause-registry case above runs on.
    const out = runScript('check-clippy-invocation.js');
    assert.match(out, /clippy invocation single-sourced/);
  });

  it('check-schema-echo: the committed session-format document matches the composed schemas', () => {
    const out = runScript('check-schema-echo.js');
    assert.match(out, /schema echoes consistent/);
  });

  it('check-verification-inventory: the committed verification documents satisfy every pin', () => {
    // No env pinned: the script's whole import closure (this check plus
    // check-test-inventory, check-doc-closure, corpus-compare, sufficiency-lint,
    // build-schemas, sync-digest, field-sensitivity) reads no process.env, and
    // its only externals are the schema validator packages — so there is no
    // var whose value could switch the path this smoke runs.
    const out = runScript('check-verification-inventory.js');
    assert.match(out, /verification inventories current/);
  });

  it('check-tracked-ignored: no tracked file matches a .gitignore rule', () => {
    // Also the one place the git flag combination itself is exercised — the
    // whole check is that invocation, and a flag git rejects would otherwise
    // surface only in CI.
    const out = runScript('check-tracked-ignored.js');
    assert.match(out, /tracked files and ignore rules agree/);
  });
});
