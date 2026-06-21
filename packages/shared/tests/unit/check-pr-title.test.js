/**
 * check-pr-title.test.js — Unit tests for the Conventional Commits PR-title
 * validator that gates merges. Docent squash-merges, so the validated title
 * becomes the commit subject on main (see scripts/next-release-version.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTitle, ALLOWED_TYPES } from '../../../../scripts/check-pr-title.js';

describe('isValidTitle — Conventional Commit PR titles', () => {
  it('accepts type: summary', () => {
    assert.ok(isValidTitle('feat: add export button'));
    assert.ok(isValidTitle('fix: stop dropping early events'));
  });

  it('accepts an optional scope and the breaking-change marker', () => {
    assert.ok(isValidTitle('feat(extension): add button'));
    assert.ok(isValidTitle('fix(desktop)!: rename action type'));
    assert.ok(isValidTitle('chore!: drop Node 18'));
  });

  it('accepts every allowed type', () => {
    for (const t of ALLOWED_TYPES) assert.ok(isValidTitle(`${t}: something`), t);
  });

  it('rejects a missing or unknown type', () => {
    assert.equal(isValidTitle('add export button'), false);
    assert.equal(isValidTitle('Update stuff'), false);
    assert.equal(isValidTitle('feature: x'), false);
    assert.equal(isValidTitle('fixup: x'), false);
  });

  it('rejects a missing ": " separator or empty summary', () => {
    assert.equal(isValidTitle('feat add button'), false);
    assert.equal(isValidTitle('feat:x'), false);
    assert.equal(isValidTitle('feat: '), false);
  });

  it('rejects non-strings and empty input', () => {
    assert.equal(isValidTitle(undefined), false);
    assert.equal(isValidTitle(null), false);
    assert.equal(isValidTitle(''), false);
  });

  it('requires a same-line summary (the summary "." does not match a newline)', () => {
    assert.equal(isValidTitle('feat: \nx'), false);
    assert.ok(isValidTitle('feat: a\nb'));
  });

  it('accepts lowercase "revert:" but rejects GitHub\'s auto-generated `Revert "..."`', () => {
    assert.ok(isValidTitle('revert: "feat: thing"'));
    assert.equal(isValidTitle('Revert "feat: thing"'), false);
  });
});
