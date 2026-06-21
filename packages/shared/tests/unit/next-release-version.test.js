/**
 * next-release-version.test.js — Unit tests for the conventional-commit ->
 * semver bump classifier used by the next-release-version helper, plus the
 * semver increment arithmetic it relies on (https://semver.org/).
 *
 * The classifier is a release-version FLOOR, so its bias matches the schema
 * classifier's: only changes that clearly affect the public surface bump the
 * version; everything else is `none`. Breaking changes escalate to major.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCommit,
  parseCommitRecords,
  higher,
} from '../../../../scripts/next-release-version.js';
import { bumpVersion } from '../../../../scripts/auto-version-schemas.js';

describe('classifyCommit — conventional commit -> semver level', () => {
  it('feat -> minor (backward-compatible feature)', () => {
    assert.equal(classifyCommit('feat: add export button', ''), 'minor');
    assert.equal(classifyCommit('feat(desktop): add tray icon', ''), 'minor');
  });

  it('fix / perf -> patch (backward-compatible)', () => {
    assert.equal(classifyCommit('fix: stop dropping early events', ''), 'patch');
    assert.equal(classifyCommit('fix(extension): guard null target', ''), 'patch');
    assert.equal(classifyCommit('perf: cache locator lookups', ''), 'patch');
  });

  it('! marker -> major (breaking), regardless of type', () => {
    assert.equal(classifyCommit('feat!: drop legacy field', ''), 'major');
    assert.equal(classifyCommit('refactor(core)!: rename action type', ''), 'major');
  });

  it('BREAKING CHANGE footer -> major, regardless of type', () => {
    assert.equal(classifyCommit('fix: tweak', 'BREAKING CHANGE: removed field'), 'major');
    assert.equal(classifyCommit('feat: x', 'body\n\nBREAKING-CHANGE: changed semantics'), 'major');
  });

  it('non-release types -> none', () => {
    for (const subject of [
      'chore: bump deps',
      'docs: fix typo',
      'test(e2e): re-stamp fixtures',
      'ci(release): tweak workflow',
      'refactor: tidy internals',
      'style: format',
      'build: adjust config',
    ]) {
      assert.equal(classifyCommit(subject, ''), 'none', subject);
    }
  });

  it('non-conventional subjects -> none', () => {
    assert.equal(classifyCommit('Merge branch main', ''), 'none');
    assert.equal(classifyCommit('update stuff', ''), 'none');
  });
});

describe('semver increment (semver.org) — bumpVersion zeroes lower components', () => {
  it('major bump zeroes minor and patch', () => {
    assert.equal(bumpVersion('2.4.7', 'major'), '3.0.0');
  });

  it('minor bump zeroes patch', () => {
    assert.equal(bumpVersion('2.4.7', 'minor'), '2.5.0');
  });

  it('patch bump increments patch only', () => {
    assert.equal(bumpVersion('2.4.7', 'patch'), '2.4.8');
  });

  it('none leaves the version unchanged', () => {
    assert.equal(bumpVersion('2.4.7', 'none'), '2.4.7');
  });
});

describe('higher — semver level floor (never the lower of two signals)', () => {
  const cases = [
    ['none', 'none', 'none'],
    ['patch', 'none', 'patch'],
    ['none', 'patch', 'patch'],
    ['minor', 'patch', 'minor'],
    ['patch', 'minor', 'minor'],
    ['major', 'none', 'major'],
    ['major', 'patch', 'major'],
    ['minor', 'minor', 'minor'],
  ];
  for (const [a, b, want] of cases) {
    it(`higher(${a}, ${b}) === ${want}`, () => {
      assert.equal(higher(a, b), want);
    });
  }
});

describe('parseCommitRecords — git-log record parsing + aggregate floor', () => {
  const US = '\x1f';
  const RS = '\x1e';

  it('empty stream -> total 0, level none, no notable', () => {
    const r = parseCommitRecords('');
    assert.equal(r.total, 0);
    assert.equal(r.level, 'none');
    assert.deepEqual(r.notable, []);
    assert.equal(r.unrecognized, 0);
  });

  it('single record, no body', () => {
    const r = parseCommitRecords(`feat: add export${US}${RS}`);
    assert.equal(r.total, 1);
    assert.equal(r.level, 'minor');
    assert.deepEqual(
      r.notable.map((n) => n.subject),
      ['feat: add export'],
    );
  });

  it('two records: git prefixes a newline before the second; floor + order preserved', () => {
    // max(patch, minor) === minor
    const r = parseCommitRecords(`fix: a${US}${RS}\nfeat: b${US}${RS}`);
    assert.equal(r.total, 2);
    assert.equal(r.level, 'minor');
    assert.deepEqual(
      r.notable.map((n) => n.subject),
      ['fix: a', 'feat: b'],
    );
  });

  it('BREAKING CHANGE footer in the (un-trimmed) body escalates to major', () => {
    const r = parseCommitRecords(`fix: tweak${US}line one\n\nBREAKING CHANGE: removed field${RS}`);
    assert.equal(r.level, 'major');
  });

  it('counts non-conventional subjects as unrecognized (chore valid; wip / prose not)', () => {
    const r = parseCommitRecords(
      `chore: deps${US}${RS}\nwip: scratch${US}${RS}\nupdate stuff${US}${RS}`,
    );
    assert.equal(r.total, 3);
    assert.equal(r.level, 'none');
    assert.equal(r.unrecognized, 2);
  });
});
