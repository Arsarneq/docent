/**
 * check-version-sync.test.js — Unit tests for the version-table sync check
 * (scripts/check-version-sync.js) that gates CI. It keeps the version tables in
 * README.md and the session-format doc equal to the schema versions in the leaf
 * delta files; these tests prove its red paths fire (missing markers, a stale
 * extension or desktop version, a delta with no version field) and pin the
 * exact messages the CLI prints.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readVersionFrom,
  checkVersionTable,
  CHECKED_FILES,
} from '../../../../scripts/check-version-sync.js';

const table = (body) =>
  `# Doc\n\n<!-- VERSION_TABLE_START -->\n${body}\n<!-- VERSION_TABLE_END -->\n`;

describe('readVersionFrom', () => {
  it('returns the version when present', () => {
    assert.deepEqual(readVersionFrom({ version: '3.0.0' }, 'schemas/x.delta.json'), {
      version: '3.0.0',
    });
  });

  it('returns the exact error line when the version field is missing', () => {
    assert.deepEqual(readVersionFrom({}, 'schemas/x.delta.json'), {
      error: '✗ schemas/x.delta.json is missing a "version" field',
    });
  });
});

describe('checkVersionTable', () => {
  it('passes when both versions appear between the markers', () => {
    const { ok, messages } = checkVersionTable(
      table('| Ext | 3.0.0 |\n| Desk | 2.0.0 |'),
      'README.md',
      '3.0.0',
      '2.0.0',
    );
    assert.equal(ok, true);
    assert.deepEqual(messages, ['✓ README.md: versions match (extension: 3.0.0, desktop: 2.0.0)']);
  });

  it('fails with the exact message when the markers are missing', () => {
    const { ok, messages } = checkVersionTable('# Doc without a table\n', 'README.md', '1', '2');
    assert.equal(ok, false);
    assert.deepEqual(messages, ['✗ README.md: missing VERSION_TABLE markers']);
  });

  it('fails naming the stale extension version', () => {
    const { ok, messages } = checkVersionTable(
      table('| Ext | 2.9.0 |\n| Desk | 2.0.0 |'),
      'docs/technical/session-format.md',
      '3.0.0',
      '2.0.0',
    );
    assert.equal(ok, false);
    assert.deepEqual(messages, [
      '✗ docs/technical/session-format.md: expected extension version "3.0.0" not found in version table',
    ]);
  });

  it('fails naming both versions when both are stale, extension first', () => {
    const { ok, messages } = checkVersionTable(table('| old |'), 'README.md', '3.0.0', '2.0.0');
    assert.equal(ok, false);
    assert.deepEqual(messages, [
      '✗ README.md: expected extension version "3.0.0" not found in version table',
      '✗ README.md: expected desktop version "2.0.0" not found in version table',
    ]);
  });

  it('only reads the section between the markers', () => {
    // The expected version appears in prose OUTSIDE the markers — still a red.
    const content = `Version 3.0.0 is mentioned here.\n${table('| Desk | 2.0.0 |')}`;
    const { ok } = checkVersionTable(content, 'README.md', '3.0.0', '2.0.0');
    assert.equal(ok, false);
  });
});

describe('CHECKED_FILES', () => {
  it('covers the README and the session-format doc', () => {
    assert.deepEqual(CHECKED_FILES, ['README.md', 'docs/technical/session-format.md']);
  });
});
