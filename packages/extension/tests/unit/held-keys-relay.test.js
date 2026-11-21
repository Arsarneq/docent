/**
 * held-keys-relay.test.js — Unit tests for the keys held across the frames of
 * a tab.
 *
 * A key's events reach the focused document only, so a frame does not see a
 * key that went down in another frame of its tab. Each frame reports the keys
 * it names as held, and the relay answers which of the tab's keys an action in
 * one frame may name beside its own. The rule the tests hold: a key is named
 * only while its release is sure to be reported.
 *
 * Uses Node.js built-in test runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHeldKeysRelay } from '../../lib/held-keys-relay.js';

const TAB = 7;
const TOP = 0;
const INNER = 42;
const OTHER = 43;

describe('createHeldKeysRelay', () => {
  it('names a key held in another frame of the tab', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['Escape']);
  });

  it('does not name to a frame the keys that frame reported itself', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    assert.deepEqual(relay.heldElsewhere(TAB, TOP), []);
  });

  it('names nothing in another tab', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    assert.deepEqual(relay.heldElsewhere(TAB + 1, TOP), []);
  });

  it('names the keys in the order they went down', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, TOP, { event: 'down', code: 'KeyB', key: 'b' });
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['b', 'a']);
  });

  it('forgets a key at its release, whichever frame reports it', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, TOP, { event: 'down', code: 'KeyB', key: 'b' });
    relay.report(TAB, INNER, { event: 'up', code: 'KeyA' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['b']);
    relay.report(TAB, TOP, { event: 'up', code: 'KeyB' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
  });

  it('leaves out the key the action itself is about', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, TOP, { event: 'down', code: 'KeyB', key: 'b' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER, 'KeyA'), ['b']);
  });

  it('forgets the keys of a frame whose window loses the focus with no press elsewhere', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, TOP, { event: 'blur' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
    // A press and its focus that come later take nothing over.
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, INNER, { event: 'focus' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
  });

  it('hands the keys to the frame a press moved the focus to, blur reported first', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.report(TAB, INNER, { event: 'focus' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['a']);
  });

  it('hands the keys to the frame a press moved the focus to, focus reported first', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, INNER, { event: 'focus' });
    relay.report(TAB, TOP, { event: 'blur' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['a']);
  });

  it('names no key between the blur of the frame that held it and the focus of the pressed frame', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
    assert.deepEqual(relay.heldElsewhere(TAB, OTHER), []);
  });

  it('keeps naming a key where the press did not move the focus', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['a']);
    relay.report(TAB, TOP, { event: 'up', code: 'KeyA' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
  });

  it('forgets handed-over keys when the frame that took them loses the focus', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.report(TAB, INNER, { event: 'focus' });
    relay.report(TAB, INNER, { event: 'blur' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
    assert.deepEqual(relay.heldElsewhere(TAB, TOP), []);
  });

  it('names a handed-over key to the tab’s other frames as well', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.report(TAB, INNER, { event: 'focus' });
    assert.deepEqual(relay.heldElsewhere(TAB, OTHER), ['a']);
  });

  it('hands a key on at a second press into a third frame', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.report(TAB, INNER, { event: 'focus' });
    relay.report(TAB, OTHER, { event: 'press' });
    relay.report(TAB, INNER, { event: 'blur' });
    relay.report(TAB, OTHER, { event: 'focus' });
    assert.deepEqual(relay.heldElsewhere(TAB, OTHER), ['a']);
  });

  it('drops keys that waited for a focus that never came, at the next press', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    // The focus left the page instead. A later press and its focus find nothing.
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, INNER, { event: 'focus' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
  });

  it('takes a key a frame saw go down again as that frame’s own', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.report(TAB, INNER, { event: 'focus' });
    // The key's repeat reached the frame, which now names it itself.
    relay.report(TAB, INNER, { event: 'down', code: 'KeyA', key: 'a' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
    assert.deepEqual(relay.heldElsewhere(TAB, TOP), ['a']);
  });

  it('forgets every key of the tab when a drag starts', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, OTHER, { event: 'down', code: 'KeyB', key: 'b' });
    relay.report(TAB, INNER, { event: 'clear' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
  });

  it('forgets the keys of a frame that is gone, and those waiting for it', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, OTHER, { event: 'down', code: 'KeyB', key: 'b' });
    relay.forgetFrame(TAB, OTHER);
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['a']);
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.forgetFrame(TAB, INNER);
    relay.report(TAB, INNER, { event: 'focus' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
  });

  it('forgets a tab, and everything', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB + 1, TOP, { event: 'down', code: 'KeyB', key: 'b' });
    relay.forgetTab(TAB);
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
    assert.deepEqual(relay.heldElsewhere(TAB + 1, INNER), ['b']);
    relay.forgetAll();
    assert.deepEqual(relay.heldElsewhere(TAB + 1, INNER), []);
  });

  it('ignores a report it cannot read', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, TOP, null);
    relay.report(TAB, TOP, { event: 'down', code: 7, key: 'x' });
    relay.report(TAB, TOP, { event: 'down', code: 'KeyX', key: '' });
    relay.report(TAB, TOP, { event: 'other' });
    relay.report(null, TOP, { event: 'clear' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['a']);
  });
});
