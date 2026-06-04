/**
 * sync-scheduler.test.js — Unit tests for the shared cooldown-debounced
 * Auto-Sync scheduler (Requirement 23: R23.7, R23.8, R23.9, R23.13, R23.14).
 *
 * Uses an injectable clock and deferred cycle promises so coalescing and the
 * never-overlap guarantee can be exercised deterministically without real timers.
 * (Property 41 in task 24.3 covers the trigger behavior exhaustively; these are
 * focused example/edge-case checks of the scheduler's coalescing state machine.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncScheduler,
  createSyncTrigger,
  BACKSTOP_INTERVAL_MS,
} from '../../sync-scheduler.js';

/** A controllable clock: returns whatever `t` is set to. */
function fakeClock(start = 1000) {
  const state = { t: start };
  return {
    now: () => state.t,
    advance: (ms) => {
      state.t += ms;
    },
  };
}

/** A manually-resolvable promise. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush all pending microtasks (the scheduler chains then/catch/finally). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A cycle runner that records each invocation and lets the test settle them
 * one at a time, so the never-overlap guarantee is observable.
 */
function makeCycleRunner() {
  const cycles = [];
  const runCycle = () => {
    const d = deferred();
    cycles.push(d);
    return d.promise;
  };
  return {
    runCycle,
    count: () => cycles.length,
    settle: async (i = cycles.length - 1) => {
      cycles[i].resolve();
      await flush();
    },
  };
}

describe('createSyncScheduler', () => {
  it('exposes the ~60s backstop interval constant', () => {
    assert.equal(BACKSTOP_INTERVAL_MS, 60000);
  });

  it('ignores triggers before start (disabled)', () => {
    const sched = createSyncScheduler({ now: fakeClock().now });
    assert.equal(sched.notify(), 'disabled');
    assert.equal(sched.isActive(), false);
  });

  it('start requires a runCycle function', () => {
    const sched = createSyncScheduler();
    assert.throws(() => sched.start(null), TypeError);
  });

  it('dispatches a cycle on the first trigger after start (R23.7)', () => {
    const clock = fakeClock();
    const { runCycle, count } = makeCycleRunner();
    const sched = createSyncScheduler({ cooldownMs: 5000, now: clock.now });
    sched.start(runCycle);

    assert.equal(sched.notify(), 'dispatched');
    assert.equal(count(), 1);
    assert.equal(sched.isRunning(), true);
  });

  it('coalesces triggers fired during an in-flight cycle into one follow-up (R23.14)', async () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    const sched = createSyncScheduler({ cooldownMs: 5000, now: clock.now });
    sched.start(runner.runCycle);

    assert.equal(sched.notify(), 'dispatched');
    // Three more triggers while the first cycle is still running.
    assert.equal(sched.notify(), 'coalesced');
    assert.equal(sched.notify(), 'coalesced');
    assert.equal(sched.notify(), 'coalesced');
    assert.equal(sched.hasPending(), true);
    assert.equal(runner.count(), 1); // never overlapped

    // Let the cooldown elapse, then settle the first cycle: exactly one follow-up.
    clock.advance(5000);
    await runner.settle(0);
    assert.equal(runner.count(), 2);
    assert.equal(sched.isRunning(), true);
    assert.equal(sched.hasPending(), false);
  });

  it('never starts a second concurrent cycle while one is in flight (R23.14)', async () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    const sched = createSyncScheduler({ cooldownMs: 0, now: clock.now });
    sched.start(runner.runCycle);

    sched.notify();
    sched.notify(); // coalesced behind the in-flight cycle
    assert.equal(runner.count(), 1);
    assert.equal(sched.isRunning(), true);

    await runner.settle(0); // first settles → follow-up dispatches
    assert.equal(runner.count(), 2);
  });

  it('defers a trigger inside the cooldown window and runs one cycle per window (R23.8)', async () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    const sched = createSyncScheduler({ cooldownMs: 5000, now: clock.now });
    sched.start(runner.runCycle);

    sched.notify(); // dispatched, markSent at t=1000
    await runner.settle(0); // cycle done, but still within the cooldown window
    assert.equal(runner.count(), 1);

    // A trigger 2s later is inside the 5s window → deferred, not a new cycle.
    clock.advance(2000);
    assert.equal(sched.notify(), 'deferred');
    assert.equal(runner.count(), 1);
    assert.equal(sched.hasPending(), true);

    // Once the window elapses, the next trigger dispatches the deferred follow-up.
    clock.advance(3000);
    assert.equal(sched.notify(), 'dispatched');
    assert.equal(runner.count(), 2);
  });

  it('drops triggers while capture is active, never queueing them (R23.9)', () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    let capturing = true;
    const sched = createSyncScheduler({
      cooldownMs: 5000,
      now: clock.now,
      isCaptureActive: () => capturing,
    });
    sched.start(runner.runCycle);

    assert.equal(sched.notify(), 'capture-dropped');
    assert.equal(sched.notify(), 'capture-dropped');
    assert.equal(runner.count(), 0);
    assert.equal(sched.hasPending(), false); // dropped, not queued

    // When capture ends, a fresh trigger dispatches normally.
    capturing = false;
    assert.equal(sched.notify(), 'dispatched');
    assert.equal(runner.count(), 1);
  });

  it('survives a throwing cycle and stays enabled to retry (R23.12)', async () => {
    const clock = fakeClock();
    let calls = 0;
    const runCycle = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('transient'));
      return Promise.resolve();
    };
    const sched = createSyncScheduler({ cooldownMs: 0, now: clock.now });
    sched.start(runCycle);

    sched.notify();
    await flush();
    assert.equal(sched.isRunning(), false);
    assert.equal(sched.isActive(), true); // still enabled after the failure

    assert.equal(sched.notify(), 'dispatched'); // retries on the next trigger
    assert.equal(calls, 2);
  });

  it('stop clears the pending follow-up and disables further triggers (R23.3, R23.11)', () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    const sched = createSyncScheduler({ cooldownMs: 5000, now: clock.now });
    sched.start(runner.runCycle);

    sched.notify(); // in flight
    sched.notify(); // coalesced
    assert.equal(sched.hasPending(), true);

    sched.stop();
    assert.equal(sched.isActive(), false);
    assert.equal(sched.hasPending(), false);
    assert.equal(sched.notify(), 'disabled');
  });

  it('does not dispatch a coalesced follow-up after stop, even when an in-flight cycle settles', async () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    const sched = createSyncScheduler({ cooldownMs: 0, now: clock.now });
    sched.start(runner.runCycle);

    sched.notify();
    sched.notify(); // coalesced behind the in-flight cycle
    sched.stop(); // disable while the first cycle is still running

    await runner.settle(0);
    assert.equal(runner.count(), 1); // no follow-up after stop
  });
});

describe('createSyncTrigger', () => {
  it('requires a wire(notify) function', () => {
    assert.throws(() => createSyncTrigger({}), TypeError);
  });

  it('wires platform triggers on start and tears them down on stop (R23.13, R23.3)', () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    let registered = null;
    let torn = false;

    const trigger = createSyncTrigger({
      cooldownMs: 0,
      now: clock.now,
      wire: (notify) => {
        registered = notify; // platform would attach this to chrome.alarms / a timer
        return () => {
          torn = true;
        };
      },
    });

    trigger.start(runner.runCycle);
    assert.equal(typeof registered, 'function');

    registered(); // a platform event fires
    assert.equal(runner.count(), 1);

    trigger.stop();
    assert.equal(torn, true);
  });

  it('uses a supplied scheduler when provided', () => {
    const clock = fakeClock();
    const runner = makeCycleRunner();
    const scheduler = createSyncScheduler({ cooldownMs: 0, now: clock.now });
    let notify;
    const trigger = createSyncTrigger({
      scheduler,
      wire: (n) => {
        notify = n;
      },
    });

    trigger.start(runner.runCycle);
    notify();
    assert.equal(scheduler.isRunning(), true);
    assert.equal(runner.count(), 1);
  });
});
