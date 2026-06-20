/**
 * validate-import.test.js — Unit tests for the shared ingestion validator
 * wrapper.
 *
 * Exercises validatePayload's bounds checks and its delegation to an injected
 * (stub) Ajv-standalone-style validator. The generated validators themselves are
 * exercised against real fixtures in the per-platform schema-validation tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, MAX_IMPORT_BYTES, MAX_IMPORT_DEPTH } from '../../lib/validate-import.js';

/** A stub validator that always passes. */
function passValidator() {
  return true;
}
passValidator.errors = [];

/** A stub validator that always fails with a fixed Ajv-style error. */
function failValidator() {
  return false;
}
failValidator.errors = [{ instancePath: '/project', message: 'must have required property name' }];

const VALID = {
  docent_format: { platform: 'x', schema_version: '1' },
  project: {},
  recordings: [],
};

describe('validatePayload — non-object input', () => {
  it('rejects null', () => {
    const r = validatePayload(passValidator, null);
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /not an object/);
  });

  it('rejects a string', () => {
    const r = validatePayload(passValidator, 'nope');
    assert.equal(r.valid, false);
  });

  it('rejects a number', () => {
    const r = validatePayload(passValidator, 42);
    assert.equal(r.valid, false);
  });
});

describe('validatePayload — delegates to the schema validator', () => {
  it('returns valid when the validator passes', () => {
    const r = validatePayload(passValidator, VALID);
    assert.deepEqual(r, { valid: true, errors: [] });
  });

  it('returns the validator errors, formatted, when it fails', () => {
    const r = validatePayload(failValidator, VALID);
    assert.equal(r.valid, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /\/project must have required property name/);
  });

  it('handles a failing validator with no errors array', () => {
    const bare = () => false;
    const r = validatePayload(bare, VALID);
    assert.equal(r.valid, false);
    assert.ok(r.errors.length >= 1);
  });
});

describe('validatePayload — size bound', () => {
  it('rejects a payload over maxBytes before validating', () => {
    let called = false;
    const spy = (d) => {
      called = true;
      return true;
    };
    spy.errors = [];
    // A tiny maxBytes makes any object exceed it.
    const r = validatePayload(spy, VALID, { maxBytes: 4 });
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /exceeds 4 bytes/);
    assert.equal(called, false, 'should short-circuit before running the validator');
  });

  it('accepts a payload within maxBytes', () => {
    const r = validatePayload(passValidator, VALID, { maxBytes: MAX_IMPORT_BYTES });
    assert.equal(r.valid, true);
  });

  it('rejects a non-serializable (circular) payload', () => {
    const circular = { project: {}, recordings: [] };
    circular.self = circular;
    const r = validatePayload(passValidator, circular);
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /not serializable/);
  });
});

describe('validatePayload — depth bound', () => {
  it('rejects a payload nested deeper than maxDepth', () => {
    // Build an object nested well past a small limit.
    let nested = {};
    let cursor = nested;
    for (let i = 0; i < 20; i++) {
      cursor.child = {};
      cursor = cursor.child;
    }
    const r = validatePayload(passValidator, nested, { maxDepth: 5 });
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /nesting exceeds depth 5/);
  });

  it('accepts a payload within maxDepth', () => {
    const shallow = { a: { b: { c: 1 } } };
    const r = validatePayload(passValidator, shallow, { maxDepth: MAX_IMPORT_DEPTH });
    assert.equal(r.valid, true);
  });
});
