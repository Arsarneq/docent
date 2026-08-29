/**
 * check-tracked-ignored.test.js — Unit tests for the tracked-but-ignored lint
 * (scripts/check-tracked-ignored.js) that gates CI. The check is two questions
 * put to git plus the reading of their answers, and every half is pinned here:
 * each question — the exact flag set, including the deliberate absence of the
 * one that would let a contributor's own excludes decide the ignore verdict,
 * and the deliberate absence of the two that would scope the mode question to
 * the same narrowed set — and each answer: a NUL-separated payload parsed into
 * the paths git spelled, including the non-ASCII one git would otherwise render
 * quoted; an index listing parsed into the entries whose mode is a symbolic
 * link; the ignore question's empty answer as a pass, against the mode
 * question's empty answer and its unmodelled record, both refused as reads that
 * found nothing; and a red message naming every offender and the fix, the
 * link's target text deliberately absent from it. The synthetic payloads stand
 * in for git's output; the shipped tree's own verdict comes from running the
 * check for real, which the command-line smoke beside this file does on every
 * unit run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GIT_ARGS,
  GIT_MODE_ARGS,
  InputError,
  SELF_PATH,
  SYMLINK_MODE,
  countIndexEntries,
  formatProblem,
  formatSymlinkProblem,
  parseFileList,
  parseSymlinkPaths,
} from '../../../../scripts/check-tracked-ignored.js';

/** One index record as `git ls-files -s` writes it: `<mode> <object> <stage>\t<path>`. */
const record = (mode, path) => `${mode} 0123456789abcdef0123456789abcdef01234567 0\t${path}`;

describe('parseFileList — reading git ls-files output', () => {
  it('returns nothing for the empty answer (the healthy state)', () => {
    assert.deepEqual(parseFileList(''), []);
    assert.deepEqual(parseFileList('\0'), []);
  });

  it('splits the NUL-separated payload into paths', () => {
    assert.deepEqual(parseFileList('a/b.js\0c/d.txt\0'), ['a/b.js', 'c/d.txt']);
  });

  it('reports a non-ASCII path literally — the reason for NUL separation', () => {
    // Without -z, git renders the whole path quoted — "dir/caf\303\251.log" —
    // and the report would name a path the suggested `git rm --cached` misses.
    assert.deepEqual(parseFileList('dir/café.log\0'), ['dir/café.log']);
  });

  it('reports each path exactly as git spelled it, spaces included', () => {
    assert.deepEqual(parseFileList('dir/a file.txt\0dir/trailing .txt\0'), [
      'dir/a file.txt',
      'dir/trailing .txt',
    ]);
  });

  it('sorts the offenders so the report is stable', () => {
    assert.deepEqual(parseFileList('z.txt\0a.txt\0m.txt\0'), ['a.txt', 'm.txt', 'z.txt']);
  });
});

describe('formatProblem — the red output', () => {
  it('returns null when nothing is tracked-and-ignored', () => {
    assert.equal(formatProblem([]), null);
  });

  it('names every offending path and the fix', () => {
    const message = formatProblem(['packages/desktop/dist/panel.js', 'coverage/lcov.info']);
    assert.match(message, /^✗ 2 tracked file\(s\) match a \.gitignore rule/);
    assert.match(message, /packages\/desktop\/dist\/panel\.js/);
    assert.match(message, /coverage\/lcov\.info/);
    assert.match(message, /git rm --cached/);
    assert.match(message, /Fix:/);
  });
});

describe('parseSymlinkPaths — reading the index listing', () => {
  it('returns nothing for an index carrying only regular files', () => {
    assert.deepEqual(parseSymlinkPaths(''), []);
    assert.deepEqual(
      parseSymlinkPaths([record('100644', 'a.js'), record('100755', 'run.sh'), ''].join('\0')),
      [],
    );
  });

  it('names the entries whose mode is a symbolic link, and only those', () => {
    const stdout = [
      record('100644', 'a.js'),
      record(SYMLINK_MODE, 'link-to-b'),
      record('100644', 'c.js'),
      record(SYMLINK_MODE, 'dir/another-link'),
      '',
    ].join('\0');
    assert.deepEqual(parseSymlinkPaths(stdout), ['dir/another-link', 'link-to-b']);
  });

  it('reads the path after the tab, so a path holding a space survives', () => {
    assert.deepEqual(parseSymlinkPaths(record(SYMLINK_MODE, 'dir/a link.txt')), ['dir/a link.txt']);
  });

  it('reads a non-ASCII path literally — the reason for NUL separation', () => {
    assert.deepEqual(parseSymlinkPaths(record(SYMLINK_MODE, 'dir/café-link')), ['dir/café-link']);
  });

  it('refuses a symlink-mode record carrying no tab, rather than reading it as a path', () => {
    // Without the refusal the whole record — mode, object and stage included —
    // becomes the "path" the verdict names and the fix tells someone to untrack.
    assert.throws(
      () => parseSymlinkPaths(`${SYMLINK_MODE} 0123456789abcdef0123456789abcdef01234567 0`),
      (error) => error instanceof InputError && /carrying no tab/.test(error.message),
    );
  });
});

describe('countIndexEntries — the mode question’s own vacuity refusal', () => {
  it('counts the entries the payload states', () => {
    assert.equal(countIndexEntries([record('100644', 'a.js'), record('100755', 'run.sh'), ''].join('\0')), 2); // prettier-ignore
  });

  it('refuses a payload naming no entry at all', () => {
    // Unlike the ignore question, whose empty answer IS the green, this one is
    // asked over the whole index: a checkout tracking anything answers with a
    // record apiece, so nothing coming back is the read having failed.
    for (const payload of ['', '\0']) {
      assert.throws(
        () => countIndexEntries(payload),
        (error) =>
          error instanceof InputError && /answered with no index entry/.test(error.message),
      );
    }
  });

  it('names the question it asked of git, so the refusal says what came back to what', () => {
    assert.throws(
      () => countIndexEntries(''),
      (error) => error.message.includes(`git ${GIT_MODE_ARGS.join(' ')}`),
    );
  });
});

describe('formatSymlinkProblem — the red output', () => {
  it('returns null when the index carries no link', () => {
    assert.equal(formatSymlinkProblem([]), null);
  });

  it('names each path and its mode, and never the link target', () => {
    const message = formatSymlinkProblem(['tools/local-link', 'docs/shortcut.md']);
    assert.match(message, /^✗ 2 tracked entries are a symbolic link \(index mode 120000\)/);
    assert.match(message, /tools\/local-link/);
    assert.match(message, /docs\/shortcut\.md/);
    assert.match(message, /git rm --cached/);
    // The admission route names this check by its DERIVED path, so a rename
    // carries the value rather than leaving a literal behind in the fix.
    assert.match(SELF_PATH, /^scripts\/check-[a-z-]+\.js$/);
    assert.ok(message.includes(SELF_PATH), message);
    // The target text is what a machine-local absolute path would ride in on,
    // and it is not part of what this check reads or prints.
    assert.doesNotMatch(message, /->|=>/);
  });

  it('states why the ignore question above cannot answer this one', () => {
    const message = formatSymlinkProblem(['link']);
    assert.match(message, /trailing slash/);
    assert.match(message, /^✗ 1 tracked entry is a symbolic link/);
  });
});

describe('GIT_ARGS / GIT_MODE_ARGS — the questions asked of git', () => {
  it('scopes the ignore question to the .gitignore files, NUL-separated', () => {
    // Deliberately NOT --exclude-standard: that adds the machine's global
    // excludes and the local info/exclude, so a contributor's personal ignore
    // list could red a file this repository deliberately commits. What decides
    // the verdict is the .gitignore files in the tree, nothing outside it.
    assert.deepEqual(GIT_ARGS, [
      'ls-files',
      '-z',
      '-i',
      '-c',
      '--exclude-per-directory=.gitignore',
    ]);
  });

  it('asks the mode question over the whole index, NUL-separated', () => {
    // Deliberately without `-i` and `-c`: those two are what narrow the first
    // question to the tracked files a .gitignore rule matches. This one is
    // about every entry the index carries, whatever any rule says about its
    // path, so it takes the listing with modes and nothing else.
    assert.deepEqual(GIT_MODE_ARGS, ['ls-files', '-z', '-s']);
    assert.ok(!GIT_MODE_ARGS.includes('-i'));
    assert.ok(!GIT_MODE_ARGS.includes('-c'));
  });
});
