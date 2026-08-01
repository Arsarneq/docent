/**
 * check-tracked-ignored.test.js — Unit tests for the tracked-but-ignored lint
 * (scripts/check-tracked-ignored.js) that gates CI. The check is one question
 * put to git plus the reading of its answer, and both halves are pinned here:
 * the question — the exact flag set, including the deliberate absence of the
 * one that would let a contributor's own excludes decide the verdict — and the
 * answer: a NUL-separated payload parsed into the paths git spelled, including
 * the non-ASCII one git would otherwise render quoted; an empty answer as a
 * pass; and a red message naming every offender and the fix. The synthetic
 * payloads stand in for git's output; the shipped tree's own verdict comes from
 * running the check for real, which the command-line smoke beside this file
 * does on every unit run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GIT_ARGS,
  formatProblem,
  parseFileList,
} from '../../../../scripts/check-tracked-ignored.js';

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

describe('GIT_ARGS — the question asked of git', () => {
  it('scopes the question to the .gitignore files, NUL-separated', () => {
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
});
