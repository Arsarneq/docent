/**
 * next-release-version.test.js — Unit tests for the conventional-commit ->
 * semver bump classifier used by the next-release-version helper, plus the
 * semver increment arithmetic it relies on (https://semver.org/).
 *
 * The classifier is a release-version FLOOR, so its bias matches the schema
 * classifier's: only changes that clearly affect the public surface bump the
 * version; everything else is `none`. Breaking changes escalate to major.
 *
 * Also covered: version comparison, the release base the bump is applied to
 * (the last final release — the latest final tag, or the app file when no tag
 * is found), the per-platform suggestion built on it, and the git-log read over
 * a history whose output exceeds Node's default buffer.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyCommit,
  parseCommitRecords,
  higher,
  compareVersions,
  resolveReleaseBase,
  suggestRelease,
  commitsSince,
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

describe('compareVersions — semver precedence of final X.Y.Z versions', () => {
  it('orders by major, then minor, then patch (numerically, not lexically)', () => {
    assert.ok(compareVersions('3.1.0', '3.0.0') > 0);
    assert.ok(compareVersions('2.0.0', '10.0.0') < 0);
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
    assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  });
});

describe('resolveReleaseBase — the version the bump is applied to', () => {
  const file = 'packages/extension/manifest.json';

  it('tag and file agree -> that version, no note', () => {
    const r = resolveReleaseBase({
      fileVersion: '3.1.0',
      fileLabel: file,
      tag: 'extension-v3.1.0',
      tagVersion: '3.1.0',
    });
    assert.deepEqual(r, { version: '3.1.0', source: 'tag', note: null });
  });

  it('no final tag found -> the file version, no note (the commit line reports the missing tag)', () => {
    const r = resolveReleaseBase({
      fileVersion: '3.0.0',
      fileLabel: file,
      tag: null,
      tagVersion: null,
    });
    assert.deepEqual(r, { version: '3.0.0', source: 'file', note: null });
  });

  it('app file behind the tag -> the tag version, with a note naming why the file lags', () => {
    const r = resolveReleaseBase({
      fileVersion: '3.0.0',
      fileLabel: file,
      tag: 'extension-v3.1.0',
      tagVersion: '3.1.0',
    });
    assert.equal(r.version, '3.1.0');
    assert.equal(r.source, 'tag');
    assert.match(r.note, /manifest\.json reads 3\.0\.0, behind extension-v3\.1\.0/);
    assert.match(r.note, /carries the schema version/);
  });

  it('app file ahead of the latest final tag -> still the tag version, with a note naming the causes', () => {
    const r = resolveReleaseBase({
      fileVersion: '2.2.0',
      fileLabel: file,
      tag: 'desktop-v2.1.0',
      tagVersion: '2.1.0',
    });
    // App and schema versions are independent: a final tag, when one exists, is the base.
    assert.equal(r.version, '2.1.0');
    assert.equal(r.source, 'tag');
    assert.match(r.note, /reads 2\.2\.0, ahead of desktop-v2\.1\.0/);
    assert.match(r.note, /schema version ahead of the last app tag/);
    assert.match(r.note, /git fetch --tags/);
    assert.match(r.note, /Measured from the tag\.$/);
  });
});

describe('suggestRelease — the per-platform suggestion run() prints', () => {
  const ext = { tagPrefix: 'extension-v', fileLabel: 'packages/extension/manifest.json' };

  // Regression: #667 — the base was read from the app file, which carries the
  // schema version and so lags the last final tag, and the helper suggested a
  // tag that already existed.
  // https://github.com/Arsarneq/docent/issues/667
  it('regression_667_suggests_the_tag_after_the_last_final_tag_when_app_file_lags', () => {
    const s = suggestRelease({
      ...ext,
      fileVersion: '3.0.0',
      tag: 'extension-v3.1.0',
      schemaLevel: 'minor',
      commitLevel: 'minor',
    });
    assert.equal(s.suggestedTag, 'extension-v3.2.0');
    assert.equal(s.base.version, '3.1.0');
    assert.equal(s.level, 'minor');
    assert.equal(s.driver, 'schema + commits (minor)');
  });

  it('no bump indicated -> no suggested tag, base unchanged', () => {
    const s = suggestRelease({
      ...ext,
      fileVersion: '3.1.0',
      tag: 'extension-v3.1.0',
      schemaLevel: 'none',
      commitLevel: 'none',
    });
    assert.equal(s.suggestedTag, null);
    assert.equal(s.base.version, '3.1.0');
    assert.equal(s.driver, 'no version-affecting changes detected');
  });

  it('no tag found -> measured from the file, the schema diff drives', () => {
    const s = suggestRelease({
      ...ext,
      fileVersion: '3.0.0',
      tag: null,
      schemaLevel: 'patch',
      commitLevel: 'none',
    });
    assert.equal(s.base.source, 'file');
    assert.equal(s.suggestedTag, 'extension-v3.0.1');
    assert.equal(s.driver, 'schema diff (patch)');
  });
});

describe('commitsSince — reads the git log of a real repository', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A throwaway repository with deterministic, unsigned commits. */
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'next-release-version-'));
    dirs.push(dir);
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'tag.gpgsign=false',
          ...args,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
    git('init', '-q');
    return { dir, git };
  }

  function commit(r, name, message) {
    writeFileSync(join(r.dir, name), name);
    const msgFile = join(r.dir, '.msg');
    writeFileSync(msgFile, message);
    r.git('add', name);
    r.git('commit', '-q', '-F', msgFile);
  }

  // Regression: #665 — the log since the last tag exceeded the child-process
  // default output buffer (1 MiB) and the helper died with `spawnSync git ENOBUFS`.
  // https://github.com/Arsarneq/docent/issues/665
  it('regression_665_git_log_over_one_mebibyte_is_read_whole', () => {
    const r = repo();
    commit(r, 'a', 'chore: base');
    r.git('tag', 'x-v1.0.0');
    const body = 'x'.repeat(1024 * 1024 + 4096); // one commit body alone exceeds 1 MiB
    commit(r, 'b', `feat: big\n\n${body}\n`);
    commit(r, 'c', 'fix: small\n');
    const res = commitsSince('x-v1.0.0', ['.'], r.dir);
    assert.equal(res.total, 2);
    assert.equal(res.level, 'minor');
    assert.deepEqual(
      res.notable.map((n) => n.subject),
      ['fix: small', 'feat: big'],
    );
  });
});
