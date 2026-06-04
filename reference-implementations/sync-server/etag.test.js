import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveETag } from './etag.js';

/**
 * Tests for deterministic, content-derived ETag derivation (Requirements 6.1,
 * 6.6, 8.1, 8.2).
 *
 * The contract is opaque: clients never parse the tag, so the tests assert only
 * the three properties that matter — same content yields the same tag, any
 * content change yields a different tag, and the output is a quoted string.
 */

/** A representative Full_Project_Payload-shaped object. */
function samplePayload() {
  return {
    docent_format: { platform: 'extension', version: 1 },
    project: {
      project_id: '0192f0a0-0000-7000-8000-000000000001',
      name: 'Demo Project',
      created_at: '2026-06-04T10:00:00.000Z',
    },
    recordings: [
      {
        recording_id: '0192f0a0-0000-7000-8000-0000000000aa',
        name: 'First recording',
        steps: [{ logical_id: 'a', uuid: 'u1', text: 'hello' }],
      },
    ],
  };
}

describe('deriveETag — determinism (R6.6)', () => {
  it('returns the same ETag for the same content across calls', () => {
    const payload = samplePayload();
    assert.equal(deriveETag(payload), deriveETag(payload));
  });

  it('returns the same ETag for two distinct objects with equal content', () => {
    assert.equal(deriveETag(samplePayload()), deriveETag(samplePayload()));
  });

  it('is independent of object key order (canonicalization)', () => {
    const a = { project: { name: 'X', project_id: 'p1' }, docent_format: { v: 1 } };
    const b = { docent_format: { v: 1 }, project: { project_id: 'p1', name: 'X' } };
    assert.equal(deriveETag(a), deriveETag(b));
  });
});

describe('deriveETag — change sensitivity (R6.6)', () => {
  it('returns a different ETag when a project field changes', () => {
    const before = samplePayload();
    const after = samplePayload();
    after.project.name = 'Renamed Project';
    assert.notEqual(deriveETag(before), deriveETag(after));
  });

  it('returns a different ETag when step content changes', () => {
    const before = samplePayload();
    const after = samplePayload();
    after.recordings[0].steps[0].text = 'goodbye';
    assert.notEqual(deriveETag(before), deriveETag(after));
  });

  it('returns a different ETag when a recording is added', () => {
    const before = samplePayload();
    const after = samplePayload();
    after.recordings.push({
      recording_id: '0192f0a0-0000-7000-8000-0000000000bb',
      name: 'Second recording',
      steps: [],
    });
    assert.notEqual(deriveETag(before), deriveETag(after));
  });
});

describe('deriveETag — output shape (R6.1, HTTP ETag syntax)', () => {
  it('returns a double-quoted string', () => {
    const tag = deriveETag(samplePayload());
    assert.equal(typeof tag, 'string');
    assert.match(tag, /^".*"$/);
  });

  it('wraps a 64-character SHA-256 hex digest in quotes', () => {
    const tag = deriveETag(samplePayload());
    // Quotes around 64 lowercase hex characters.
    assert.match(tag, /^"[0-9a-f]{64}"$/);
  });
});
