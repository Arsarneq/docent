/**
 * check-action-pins.test.js — Unit tests for the GitHub Actions SHA-pin guard
 * (S17/S18): every `uses:` must pin to a 40-char commit SHA; local `./…` refs are
 * exempt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findUnpinned } from '../../../../scripts/check-action-pins.js';

const SHA = 'a'.repeat(40);

describe('findUnpinned — SHA-pin enforcement for `uses:`', () => {
  it('accepts a 40-char commit SHA pin', () => {
    assert.deepEqual(findUnpinned(`      - uses: actions/checkout@${SHA} # v6`), []);
  });

  it('flags a mutable tag pin', () => {
    const r = findUnpinned('      - uses: actions/checkout@v6');
    assert.equal(r.length, 1);
    assert.equal(r[0].ref, 'actions/checkout@v6');
  });

  it('flags a branch ref', () => {
    assert.equal(findUnpinned('      - uses: dtolnay/rust-toolchain@stable').length, 1);
  });

  it('flags a missing ref', () => {
    assert.equal(findUnpinned('      - uses: actions/checkout').length, 1);
  });

  it('exempts local actions / reusable workflows', () => {
    assert.deepEqual(findUnpinned('      uses: ./.github/workflows/test.yml'), []);
    assert.deepEqual(findUnpinned('      - uses: ./.github/actions/debug-env'), []);
  });

  it('handles quotes and reports the 1-based line number', () => {
    const text = ['jobs:', '  x:', "    - uses: 'owner/repo@v1'"].join('\n');
    const r = findUnpinned(text);
    assert.equal(r.length, 1);
    assert.equal(r[0].line, 3);
    assert.equal(r[0].ref, 'owner/repo@v1');
  });

  it('requires a SHA on subpath actions too', () => {
    assert.equal(findUnpinned('      - uses: github/codeql-action/upload-sarif@v3').length, 1);
    assert.deepEqual(
      findUnpinned(`      - uses: github/codeql-action/upload-sarif@${SHA} # v3`),
      [],
    );
  });

  it('ignores an uppercase/short hex that is not a full SHA', () => {
    assert.equal(findUnpinned('      - uses: a/b@DEADBEEF').length, 1);
    assert.equal(findUnpinned('      - uses: a/b@abc123').length, 1);
  });
});
