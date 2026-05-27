/**
 * capture-timing.test.js — Unit tests for capture timing configuration.
 *
 * The timing constants in capture-timing.js define windows used to
 * distinguish user actions from side-effects. This file validates:
 * 1. All constants are positive numbers within sensible ranges
 * 2. Relative ordering constraints are maintained
 * 3. The timing logic (wasRecentUserAction pattern) works correctly
 *
 * End-to-end timing behaviour is validated by the Playwright specs:
 * - side-effect-capture.spec.js (programmatic events suppressed)
 * - navigation.spec.js (tab lifecycle timing)
 *
 * Uses Node.js built-in test runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTER_SYNTHETIC_CLICK_WINDOW,
  SELECT_SYNTHETIC_CLICK_WINDOW,
  TAB_FOCUS_CORRELATION_WINDOW,
  CLICK_FOCUS_DEDUP_WINDOW,
  TAB_CREATED_USER_ACTION_WINDOW,
  TAB_CLOSED_USER_ACTION_WINDOW,
  TAB_CREATED_SWITCH_SUPPRESSION,
  TAB_REMOVED_SWITCH_SUPPRESSION,
  TAB_CREATED_NAVIGATION_SUPPRESSION,
} from '../lib/capture-timing.js';

describe('capture-timing constants — validity', () => {
  const allConstants = {
    ENTER_SYNTHETIC_CLICK_WINDOW,
    SELECT_SYNTHETIC_CLICK_WINDOW,
    TAB_FOCUS_CORRELATION_WINDOW,
    CLICK_FOCUS_DEDUP_WINDOW,
    TAB_CREATED_USER_ACTION_WINDOW,
    TAB_CLOSED_USER_ACTION_WINDOW,
    TAB_CREATED_SWITCH_SUPPRESSION,
    TAB_REMOVED_SWITCH_SUPPRESSION,
    TAB_CREATED_NAVIGATION_SUPPRESSION,
  };

  for (const [name, value] of Object.entries(allConstants)) {
    it(`${name} is a positive integer`, () => {
      assert.equal(typeof value, 'number', `${name} should be a number`);
      assert.ok(Number.isInteger(value), `${name} should be an integer`);
      assert.ok(value > 0, `${name} should be positive`);
    });
  }

  it('all constants are under 10 seconds (sanity check)', () => {
    for (const [name, value] of Object.entries(allConstants)) {
      assert.ok(value <= 10000, `${name} = ${value}ms exceeds 10s — likely a bug`);
    }
  });
});

describe('capture-timing constants — relative ordering', () => {
  it('synthetic click windows are shorter than focus correlation', () => {
    assert.ok(ENTER_SYNTHETIC_CLICK_WINDOW <= TAB_FOCUS_CORRELATION_WINDOW);
    assert.ok(SELECT_SYNTHETIC_CLICK_WINDOW <= TAB_FOCUS_CORRELATION_WINDOW);
  });

  it('switch suppression windows are shorter than user action windows', () => {
    assert.ok(TAB_CREATED_SWITCH_SUPPRESSION < TAB_CREATED_USER_ACTION_WINDOW);
    assert.ok(TAB_REMOVED_SWITCH_SUPPRESSION < TAB_CREATED_USER_ACTION_WINDOW);
  });

  it('tab close window is longer than tab create window (delayed close is common)', () => {
    assert.ok(TAB_CLOSED_USER_ACTION_WINDOW >= TAB_CREATED_USER_ACTION_WINDOW);
  });

  it('navigation suppression is short (only catches immediate cascades)', () => {
    assert.ok(TAB_CREATED_NAVIGATION_SUPPRESSION <= 200);
  });
});

describe('capture-timing — wasRecentUserAction logic', () => {
  // Replicate the core timing logic from the service worker
  function wasRecentUserAction(lastTimestamp, now, windowMs) {
    return lastTimestamp != null && now - lastTimestamp < windowMs;
  }

  it('returns true when action is within the window', () => {
    const now = 1000;
    const lastAction = 800; // 200ms ago
    assert.ok(wasRecentUserAction(lastAction, now, TAB_CREATED_USER_ACTION_WINDOW));
  });

  it('returns false when action is outside the window', () => {
    const now = 1000;
    const lastAction = 100; // 900ms ago
    assert.ok(!wasRecentUserAction(lastAction, now, TAB_CREATED_USER_ACTION_WINDOW));
  });

  it('returns false when no previous action (null timestamp)', () => {
    assert.ok(!wasRecentUserAction(null, 1000, TAB_CREATED_USER_ACTION_WINDOW));
  });

  it('returns false when no previous action (undefined timestamp)', () => {
    assert.ok(!wasRecentUserAction(undefined, 1000, TAB_CREATED_USER_ACTION_WINDOW));
  });

  it('boundary: exactly at window edge returns false (not within)', () => {
    const now = 1000;
    const lastAction = 500; // exactly 500ms ago = TAB_CREATED_USER_ACTION_WINDOW
    assert.ok(!wasRecentUserAction(lastAction, now, TAB_CREATED_USER_ACTION_WINDOW));
  });

  it('boundary: 1ms inside window returns true', () => {
    const now = 1000;
    const lastAction = 501; // 499ms ago, within 500ms window
    assert.ok(wasRecentUserAction(lastAction, now, TAB_CREATED_USER_ACTION_WINDOW));
  });
});
