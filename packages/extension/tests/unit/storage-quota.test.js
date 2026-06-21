/**
 * storage-quota.test.js — Unit tests for the chrome.storage.local pressure
 * classifier (#127): the warn band threshold and the resume hysteresis. Pure
 * logic (no chrome APIs / real storage). The pause + user-override decisions are
 * layered on the band by the service worker and covered by the e2e spec.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStoragePressure,
  QUOTA_BYTES,
  WARN_BYTES,
  RESUME_BYTES,
} from '../../lib/storage-quota.js';

describe('storage-quota thresholds', () => {
  it('orders the thresholds: RESUME < WARN < QUOTA', () => {
    assert.ok(RESUME_BYTES < WARN_BYTES, 'resume sits below warn (hysteresis band)');
    assert.ok(WARN_BYTES < QUOTA_BYTES, 'warn sits below the hard quota');
  });
});

describe('classifyStoragePressure', () => {
  it('is ok below the warn threshold', () => {
    assert.equal(classifyStoragePressure(0, false), 'ok');
    assert.equal(classifyStoragePressure(WARN_BYTES - 1, false), 'ok');
  });

  it('warns at/above the warn threshold', () => {
    assert.equal(classifyStoragePressure(WARN_BYTES, false), 'warn');
    assert.equal(classifyStoragePressure(QUOTA_BYTES, false), 'warn');
  });

  it('hysteresis: between RESUME and WARN, the prior band holds', () => {
    const mid = RESUME_BYTES + 1; // above resume, below warn
    assert.equal(classifyStoragePressure(mid, true), 'warn', 'stays warn once warned');
    assert.equal(classifyStoragePressure(mid, false), 'ok', 'stays ok if not yet warned');
  });

  it('clears warn only once usage drops below the resume threshold', () => {
    assert.equal(classifyStoragePressure(RESUME_BYTES - 1, true), 'ok');
    assert.equal(classifyStoragePressure(RESUME_BYTES, true), 'warn', 'at RESUME, still warn');
  });

  it('a QuotaExceededError short-circuits to exceeded', () => {
    assert.equal(classifyStoragePressure(0, false, true), 'exceeded');
    assert.equal(classifyStoragePressure(QUOTA_BYTES, true, true), 'exceeded');
  });
});
