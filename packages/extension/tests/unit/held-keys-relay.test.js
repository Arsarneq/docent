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

  it('forgets a key at the release of the Meta key it went down under, in whichever frame', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a', underMeta: true });
    relay.report(TAB, TOP, { event: 'down', code: 'KeyB', key: 'b' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.report(TAB, INNER, { event: 'focus' });
    relay.report(TAB, INNER, { event: 'metaup' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['b']);
  });

  it('forgets a handed-over key with the frame that first reported it', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, INNER, { event: 'focus' });
    // The first frame never said what it saw of the key before the focus left it.
    relay.forgetFrame(TAB, TOP);
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
  });

  describe('a watch: the keys held elsewhere at an action that is stored later', () => {
    it('keeps a key the action’s own frame releases afterwards', () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
      relay.report(TAB, INNER, { event: 'press' });
      relay.report(TAB, TOP, { event: 'blur' });
      relay.report(TAB, INNER, { event: 'focus' });
      const watch = relay.watch(TAB, INNER);
      relay.report(TAB, INNER, { event: 'up', code: 'KeyA' });
      relay.report(TAB, INNER, { event: 'blur' });
      relay.report(TAB, INNER, { event: 'clear' });
      assert.deepEqual(watch.take(), ['a']);
      assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
    });

    it('loses a key another frame reports released: when is not known', () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
      relay.report(TAB, TOP, { event: 'down', code: 'KeyB', key: 'b' });
      const watch = relay.watch(TAB, INNER);
      relay.report(TAB, TOP, { event: 'up', code: 'KeyA' });
      assert.deepEqual(watch.take(), ['b']);
    });

    it('loses a key whose frame loses the focus, is gone, or drags', () => {
      for (const lose of [
        (relay) => relay.report(TAB, TOP, { event: 'blur' }),
        (relay) => relay.report(TAB, TOP, { event: 'clear' }),
        (relay) => relay.report(TAB, TOP, { event: 'metaup' }),
        (relay) => relay.forgetFrame(TAB, TOP),
        (relay) => relay.forgetTab(TAB),
        (relay) => relay.forgetAll(),
      ]) {
        const relay = createHeldKeysRelay();
        relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a', underMeta: true });
        const watch = relay.watch(TAB, INNER);
        lose(relay);
        assert.deepEqual(watch.take(), []);
      }
    });

    it('keeps a key for an action made at the press that then took the focus', () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
      relay.report(TAB, INNER, { event: 'press' });
      // A right-click is written at its press, ahead of the blur it causes.
      const atPress = relay.watch(TAB, INNER);
      const elsewhere = relay.watch(TAB, OTHER);
      relay.report(TAB, TOP, { event: 'blur' });
      assert.deepEqual(atPress.take(), ['a']);
      assert.deepEqual(elsewhere.take(), []);
    });

    it('does not gain a key that goes down afterwards', () => {
      const relay = createHeldKeysRelay();
      const watch = relay.watch(TAB, INNER);
      relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
      assert.deepEqual(watch.take(), []);
    });

    it('leaves out the key the action is about, and is over once taken', () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
      relay.report(TAB, TOP, { event: 'down', code: 'KeyB', key: 'b' });
      const watch = relay.watch(TAB, INNER, 'KeyA');
      assert.deepEqual(watch.take(), ['b']);
      relay.report(TAB, TOP, { event: 'up', code: 'KeyB' });
      assert.deepEqual(watch.take(), ['b']);
    });
  });

  it('names the frames whose keys an action of another frame would be given', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, OTHER, { event: 'down', code: 'KeyB', key: 'b' });
    assert.deepEqual(relay.framesHoldingFor(TAB, INNER), [TOP, OTHER]);
    assert.deepEqual(relay.framesHoldingFor(TAB, TOP), [OTHER]);
    // A key handed over is the frame's own to release: nobody is to be asked.
    relay.forgetFrame(TAB, OTHER);
    relay.report(TAB, INNER, { event: 'press' });
    relay.report(TAB, TOP, { event: 'blur' });
    relay.report(TAB, INNER, { event: 'focus' });
    assert.deepEqual(relay.framesHoldingFor(TAB, INNER), []);
    assert.deepEqual(relay.framesHoldingFor(TAB + 1, INNER), []);
  });

  describe('the order of one recorder’s reports', () => {
    const numbered = (seq, report) => ({ ...report, recorder: 'r1', seq });

    it('drops a report that is not later than the last one taken', () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, numbered(2, { event: 'down', code: 'KeyB', key: 'b' }));
      relay.report(TAB, TOP, numbered(1, { event: 'down', code: 'KeyA', key: 'a' }));
      relay.report(TAB, TOP, numbered(2, { event: 'up', code: 'KeyB' }));
      assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['b']);
    });

    it('starts over with a new recorder in the frame', () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, numbered(5, { event: 'down', code: 'KeyB', key: 'b' }));
      relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a', recorder: 'r2', seq: 1 });
      assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['b', 'a']);
    });

    it('says when the report a frame names as its last has been taken', async () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, numbered(1, { event: 'down', code: 'KeyA', key: 'a' }));
      let seen = false;
      const waiting = relay.whenSeen(TAB, TOP, 'r1', 2).then(() => (seen = true));
      await Promise.resolve();
      assert.equal(seen, false);
      relay.report(TAB, TOP, numbered(2, { event: 'up', code: 'KeyA' }));
      await waiting;
      assert.equal(seen, true);
      // One already taken is seen at once.
      await relay.whenSeen(TAB, TOP, 'r1', 1);
    });

    it('takes what a recorder it has not heard from names as its last for the start', async () => {
      const relay = createHeldKeysRelay();
      await relay.whenSeen(TAB, TOP, 'r1', 3);
      // A report sent before that answer, arriving after it.
      relay.report(TAB, TOP, numbered(3, { event: 'down', code: 'KeyA', key: 'a' }));
      assert.deepEqual(relay.heldElsewhere(TAB, INNER), []);
      relay.report(TAB, TOP, numbered(4, { event: 'down', code: 'KeyB', key: 'b' }));
      assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['b']);
    });

    it('lets go of whoever waits when the frame is forgotten', async () => {
      const relay = createHeldKeysRelay();
      relay.report(TAB, TOP, numbered(1, { event: 'down', code: 'KeyA', key: 'a' }));
      const waiting = relay.whenSeen(TAB, TOP, 'r1', 2);
      relay.forgetFrameAndItsRecorder(TAB, TOP);
      await waiting;
      // The frame's numbering starts over.
      relay.report(TAB, TOP, numbered(1, { event: 'down', code: 'KeyB', key: 'b' }));
      assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['b']);
    });
  });

  it('ignores a report it cannot read', () => {
    const relay = createHeldKeysRelay();
    relay.report(TAB, TOP, { event: 'down', code: 'KeyA', key: 'a' });
    relay.report(TAB, TOP, null);
    relay.report(TAB, TOP, { event: 'down', code: 7, key: 'x' });
    relay.report(TAB, TOP, { event: 'down', code: 'KeyX', key: '' });
    relay.report(TAB, TOP, { event: 'down', code: '', key: 'x' });
    relay.report(TAB, TOP, { event: 'other' });
    relay.report(null, TOP, { event: 'clear' });
    assert.deepEqual(relay.heldElsewhere(TAB, INNER), ['a']);
  });
});
