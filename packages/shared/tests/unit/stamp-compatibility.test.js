/**
 * stamp-compatibility.test.js — Unit tests for checkStampCompatibility
 * (sync schema-mismatch handling, follow-up to S12).
 *
 * The helper compares an incoming payload's docent_format stamp against the
 * local client's expected stamp and classifies any mismatch with an actionable
 * reason.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkStampCompatibility } from '../../lib/format-stamp.js';

const LOCAL = { platform: 'extension', schema_version: '2.0.0' };

describe('checkStampCompatibility', () => {
  it('accepts a matching stamp', () => {
    const r = checkStampCompatibility(
      { docent_format: { platform: 'extension', schema_version: '2.0.0' } },
      LOCAL,
    );
    assert.deepEqual(r, { compatible: true, reason: 'ok', message: null });
  });

  it('rejects a missing stamp', () => {
    const r = checkStampCompatibility({ project: {}, recordings: [] }, LOCAL);
    assert.equal(r.compatible, false);
    assert.equal(r.reason, 'missing');
    assert.match(r.message, /missing or malformed/);
  });

  it('rejects a malformed stamp (non-string fields)', () => {
    const r = checkStampCompatibility(
      { docent_format: { platform: 42, schema_version: null } },
      LOCAL,
    );
    assert.equal(r.compatible, false);
    assert.equal(r.reason, 'missing');
  });

  it('rejects a different platform with an actionable message', () => {
    const r = checkStampCompatibility(
      { docent_format: { platform: 'desktop-windows', schema_version: '2.0.0' } },
      LOCAL,
    );
    assert.equal(r.compatible, false);
    assert.equal(r.reason, 'platform');
    assert.match(r.message, /different Docent platform/);
    assert.match(r.message, /desktop-windows/);
    assert.match(r.message, /extension/);
  });

  it('rejects a different schema version with an update/pin hint', () => {
    const r = checkStampCompatibility(
      { docent_format: { platform: 'extension', schema_version: '3.0.0' } },
      LOCAL,
    );
    assert.equal(r.compatible, false);
    assert.equal(r.reason, 'version');
    assert.match(r.message, /3\.0\.0/);
    assert.match(r.message, /2\.0\.0/);
    assert.match(r.message, /update|pin/i);
  });

  it('checks platform before version (platform mismatch dominates)', () => {
    const r = checkStampCompatibility(
      { docent_format: { platform: 'desktop-windows', schema_version: '9.9.9' } },
      LOCAL,
    );
    assert.equal(r.reason, 'platform');
  });

  it('handles a null payload', () => {
    const r = checkStampCompatibility(null, LOCAL);
    assert.equal(r.compatible, false);
    assert.equal(r.reason, 'missing');
  });
});
