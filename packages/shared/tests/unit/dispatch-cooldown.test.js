/**
 * dispatch-cooldown.test.js — Unit tests for the post-send cooldown / rapid-
 * resend guard (panel layer).
 *
 * Uses an injectable clock so the cooldown can be exercised without timers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchCooldown, DISPATCH_COOLDOWN_MS } from '../../dispatch-cooldown.js';

/** A controllable clock: returns whatever `t` is set to. */
function fakeClock(start = 1000) {
  const state = { t: start };
  const now = () => state.t;
  const advance = (ms) => {
    state.t += ms;
  };
  return { now, advance };
}

describe('createDispatchCooldown', () => {
  it('permits sending before any dispatch', () => {
    const cd = createDispatchCooldown();
    assert.equal(cd.canSend(), true);
    assert.equal(cd.remainingMs(), 0);
  });

  it('blocks sending immediately after a dispatch', () => {
    const clock = fakeClock();
    const cd = createDispatchCooldown({ now: clock.now });
    cd.markSent();
    assert.equal(cd.canSend(), false);
    assert.equal(cd.remainingMs(), DISPATCH_COOLDOWN_MS);
  });

  it('reports a shrinking remaining window as time passes', () => {
    const clock = fakeClock();
    const cd = createDispatchCooldown({ cooldownMs: 5000, now: clock.now });
    cd.markSent();
    clock.advance(2000);
    assert.equal(cd.remainingMs(), 3000);
    assert.equal(cd.canSend(), false);
  });

  it('permits sending again once the cooldown elapses', () => {
    const clock = fakeClock();
    const cd = createDispatchCooldown({ cooldownMs: 5000, now: clock.now });
    cd.markSent();
    clock.advance(5000);
    assert.equal(cd.remainingMs(), 0);
    assert.equal(cd.canSend(), true);
  });

  it('treats the exact boundary as elapsed', () => {
    const clock = fakeClock();
    const cd = createDispatchCooldown({ cooldownMs: 1000, now: clock.now });
    cd.markSent();
    clock.advance(1000);
    assert.equal(cd.canSend(), true);
  });

  it('reset clears an active cooldown', () => {
    const clock = fakeClock();
    const cd = createDispatchCooldown({ now: clock.now });
    cd.markSent();
    assert.equal(cd.canSend(), false);
    cd.reset();
    assert.equal(cd.canSend(), true);
    assert.equal(cd.remainingMs(), 0);
  });

  it('never reports a negative wait when the clock goes backwards', () => {
    const clock = fakeClock();
    const cd = createDispatchCooldown({ cooldownMs: 5000, now: clock.now });
    cd.markSent();
    clock.advance(-2000); // clock skew
    assert.equal(cd.remainingMs(), 0);
    assert.equal(cd.canSend(), true);
  });

  it('defaults the cooldown window to 5 seconds', () => {
    assert.equal(DISPATCH_COOLDOWN_MS, 5000);
  });
});
