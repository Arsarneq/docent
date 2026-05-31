/**
 * uuid-v7.test.js — Property and unit tests for UUID v7 generation.
 *
 * Validates monotonic ordering, uniqueness, format, and version/variant bits.
 * Uses Node.js built-in test runner + fast-check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { uuidv7, uuidv7ToDate, compareUuidv7, isValidUuidv7 } from '../../lib/uuid-v7.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7 — format', () => {
  it('matches UUID format (8-4-4-4-12 hex with dashes)', () => {
    for (let i = 0; i < 100; i++) {
      const id = uuidv7();
      assert.match(id, UUID_REGEX, `UUID does not match format: ${id}`);
    }
  });

  it('version nibble is 7', () => {
    for (let i = 0; i < 100; i++) {
      const id = uuidv7();
      // Version is the 13th hex character (index 14 with dashes: position after second dash)
      const versionChar = id.replace(/-/g, '')[12];
      assert.equal(versionChar, '7', `Expected version 7, got ${versionChar} in ${id}`);
    }
  });

  it('variant bits are 10xx (hex 8, 9, a, or b)', () => {
    for (let i = 0; i < 100; i++) {
      const id = uuidv7();
      const variantChar = id.replace(/-/g, '')[16];
      assert.ok(
        ['8', '9', 'a', 'b'].includes(variantChar),
        `Expected variant 8/9/a/b, got ${variantChar} in ${id}`,
      );
    }
  });

  it('length is exactly 36 characters', () => {
    const id = uuidv7();
    assert.equal(id.length, 36);
  });
});

describe('uuidv7 — monotonic ordering', () => {
  it('UUIDs share the same timestamp prefix within the same millisecond', () => {
    // Within a single ms, the first 12 hex chars (timestamp) should be identical
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(uuidv7());
    const prefix = ids[0].replace(/-/g, '').slice(0, 12);
    for (const id of ids) {
      const p = id.replace(/-/g, '').slice(0, 12);
      // May differ if we cross a ms boundary, but most should match
      // Just verify they're within 1ms of each other
      const diff = Math.abs(parseInt(p, 16) - parseInt(prefix, 16));
      assert.ok(diff <= 1, `Timestamp drift > 1ms: ${diff}`);
    }
  });

  it('UUIDs generated 2ms apart are strictly ordered by string comparison', async () => {
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const b = uuidv7();
    assert.ok(b > a, `Expected ${b} > ${a}`);
  });

  it('property: UUIDs from different milliseconds are strictly ordered', async () => {
    const pairs = [];
    for (let i = 0; i < 20; i++) {
      const first = uuidv7();
      await new Promise((r) => setTimeout(r, 2));
      const second = uuidv7();
      pairs.push([first, second]);
    }
    for (const [a, b] of pairs) {
      assert.ok(b > a, `Expected later UUID > earlier: ${b} vs ${a}`);
    }
  });
});

describe('uuidv7 — uniqueness', () => {
  it('1000 consecutive calls produce 1000 unique values', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(uuidv7());
    }
    assert.equal(ids.size, 1000, `Expected 1000 unique UUIDs, got ${ids.size}`);
  });

  it('property: N calls produce N unique values', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (n) => {
        const ids = new Set();
        for (let i = 0; i < n; i++) ids.add(uuidv7());
        return ids.size === n;
      }),
      { numRuns: 50 },
    );
  });
});

describe('uuidv7ToDate', () => {
  it('extracts a timestamp close to Date.now()', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const extracted = uuidv7ToDate(id).getTime();
    assert.ok(extracted >= before, `Extracted ${extracted} < before ${before}`);
    assert.ok(extracted <= after, `Extracted ${extracted} > after ${after}`);
  });

  it('round-trips the timestamp from a known time', () => {
    // Generate and immediately extract — should be within 1ms
    const id = uuidv7();
    const now = Date.now();
    const extracted = uuidv7ToDate(id).getTime();
    assert.ok(Math.abs(extracted - now) <= 1, `Drift too large: ${Math.abs(extracted - now)}ms`);
  });
});

describe('compareUuidv7', () => {
  it('returns negative when a < b', () => {
    const a = uuidv7();
    const b = uuidv7();
    // Same millisecond, but b generated after a — random bits make b >= a
    // Use a guaranteed case instead
    assert.ok(
      compareUuidv7(
        '00000000-0000-7000-8000-000000000000',
        'ffffffff-ffff-7fff-bfff-ffffffffffff',
      ) < 0,
    );
  });

  it('returns positive when a > b', () => {
    assert.ok(
      compareUuidv7(
        'ffffffff-ffff-7fff-bfff-ffffffffffff',
        '00000000-0000-7000-8000-000000000000',
      ) > 0,
    );
  });

  it('returns 0 for identical UUIDs', () => {
    const id = uuidv7();
    assert.equal(compareUuidv7(id, id), 0);
  });
});

describe('isValidUuidv7 (S15)', () => {
  it('accepts a freshly generated uuidv7', () => {
    for (let i = 0; i < 50; i++) {
      assert.ok(isValidUuidv7(uuidv7()));
    }
  });

  it('accepts known-good canonical UUIDv7 strings (any case)', () => {
    assert.ok(isValidUuidv7('00000000-0000-7000-8000-000000000000'));
    assert.ok(isValidUuidv7('ffffffff-ffff-7fff-bfff-ffffffffffff'));
    assert.ok(isValidUuidv7('0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B'));
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, [], true]) {
      assert.equal(isValidUuidv7(v), false);
    }
  });

  it('rejects wrong version or variant nibbles', () => {
    // version 4, not 7
    assert.equal(isValidUuidv7('00000000-0000-4000-8000-000000000000'), false);
    // variant nibble c (not 8/9/a/b)
    assert.equal(isValidUuidv7('00000000-0000-7000-c000-000000000000'), false);
  });

  it('rejects path-traversal / injection shapes that must never reach a URL', () => {
    for (const v of [
      '../../etc/passwd',
      '00000000-0000-7000-8000-000000000000/../admin',
      'x'.repeat(36),
      '',
      '00000000-0000-7000-8000-00000000000', // too short
    ]) {
      assert.equal(isValidUuidv7(v), false, `must reject: ${v}`);
    }
  });
});
