import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateConditionalWrite } from './conditional-write.js';
import { deriveETag } from './etag.js';

/**
 * Tests for the explicit conditional-write gate (Requirements 6.3, 6.4, 6.5,
 * 11.1, 11.3).
 *
 * `evaluateConditionalWrite` is a pure decision function over two inputs — the
 * raw `If-Match` header value and the currently stored project record — so the
 * branches can be exercised directly without an HTTP server. The stored ETag is
 * derived from `existing.payload` via the shared `deriveETag`, so the tests
 * build the matching/stale `If-Match` values from the same helper.
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

/** Wrap a payload as a StoredProject record (payload + server last_modified). */
function storedRecord(payload) {
  return { payload, last_modified: '2026-06-04T10:00:00.000Z' };
}

describe('evaluateConditionalWrite — absent If-Match (last-write-wins, R6.5)', () => {
  it('proceeds when If-Match is undefined, even with a stored project', () => {
    const existing = storedRecord(samplePayload());
    assert.deepEqual(evaluateConditionalWrite(undefined, existing), {
      proceed: true,
    });
  });

  it('proceeds when If-Match is null', () => {
    const existing = storedRecord(samplePayload());
    assert.deepEqual(evaluateConditionalWrite(null, existing), {
      proceed: true,
    });
  });

  it('proceeds on a first-time create (no header, no stored project)', () => {
    assert.deepEqual(evaluateConditionalWrite(undefined, null), {
      proceed: true,
    });
  });
});

describe('evaluateConditionalWrite — present and matching If-Match (R6.3)', () => {
  it('proceeds when If-Match equals the stored project current ETag', () => {
    const payload = samplePayload();
    const existing = storedRecord(payload);
    const matching = deriveETag(payload);
    assert.deepEqual(evaluateConditionalWrite(matching, existing), {
      proceed: true,
    });
  });

  it('derives the comparison ETag from payload content only, not last_modified', () => {
    const payload = samplePayload();
    const matching = deriveETag(payload);
    // Two records with the same payload but different last_modified both match,
    // confirming last_modified does not participate in the comparison (R6.1).
    const recordA = { payload, last_modified: '2026-06-04T10:00:00.000Z' };
    const recordB = { payload, last_modified: '2030-01-01T00:00:00.000Z' };
    assert.deepEqual(evaluateConditionalWrite(matching, recordA), {
      proceed: true,
    });
    assert.deepEqual(evaluateConditionalWrite(matching, recordB), {
      proceed: true,
    });
  });
});

describe('evaluateConditionalWrite — present and mismatching If-Match (412, R6.4)', () => {
  it('rejects with 412 when If-Match does not match the stored ETag', () => {
    const existing = storedRecord(samplePayload());
    assert.deepEqual(evaluateConditionalWrite('"stale-etag-value"', existing), {
      proceed: false,
      status: 412,
    });
  });

  it('rejects with 412 when the stored content has changed since the tag was issued', () => {
    const before = samplePayload();
    const staleTag = deriveETag(before);
    const after = samplePayload();
    after.project.name = 'Renamed Project';
    const existing = storedRecord(after);
    assert.deepEqual(evaluateConditionalWrite(staleTag, existing), {
      proceed: false,
      status: 412,
    });
  });

  it('rejects with 412 when If-Match is present but no project is stored', () => {
    assert.deepEqual(evaluateConditionalWrite('"any-etag-value"', null), {
      proceed: false,
      status: 412,
    });
  });
});
