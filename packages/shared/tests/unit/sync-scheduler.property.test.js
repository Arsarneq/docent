/**
 * sync-scheduler.property.test.js — Property test for the shared cooldown-debounced
 * Auto-Sync scheduler (`createSyncScheduler` in `../../sync-scheduler.js`).
 *
 * (sync-protocol SP-22): *For any* sequence of Auto-Sync triggers (local data
 * events and the ~60s backstop), the scheduler coalesces them through the
 * cooldown so at most one cycle runs per window and never two concurrently; a
 * trigger that fires while capture is active starts no cycle and is dropped (not
 * queued); a failing cycle leaves the scheduler enabled to retry; and the
 * scheduler owns only the decision *when* to run — it never interprets a cycle's
 * result, so its enabled state changes only via start()/stop(), never because a
 * cycle succeeded, failed, or capture is active (the gates inside `sync()` decide
 * *whether* to proceed).
 *
 * Strategy: drive a real scheduler over an arbitrary sequence of operations
 * (notify, advance the injectable clock, settle the in-flight cycle as a resolve
 * or a reject, toggle capture, stop, restart) using deferred cycle promises so
 * coalescing and the never-overlap guarantee are fully deterministic — the same
 * injectable-clock + deferred-promise pattern as the focused unit tests in
 * `sync-scheduler.test.js`. After EVERY operation the test asserts the
 * scheduler's invariants hold, so a single property exercises every interleaving.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Auto-Sync triggering reuses the gates and never starts overlapping or capture-time cycles

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createSyncScheduler } from '../../sync-scheduler.js';

// ─── deterministic test doubles (mirror sync-scheduler.test.js) ───────────────

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

/** Flush all pending microtasks (the scheduler chains then/catch on settle). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A cycle runner that records every invocation as a deferred promise and lets the
 * test settle the single in-flight cycle one at a time (resolve OR reject), so the
 * never-overlap guarantee and the failure-retry behavior are both observable.
 *
 * `started - settled` is the number of cycles currently in flight; the scheduler
 * must keep this at most 1.
 */
function makeCycleRunner() {
  const cycles = [];
  let settled = 0;
  const runCycle = () => {
    const d = deferred();
    cycles.push(d);
    return d.promise;
  };
  return {
    runCycle,
    count: () => cycles.length,
    inFlight: () => cycles.length - settled,
    /** Settle the oldest still-pending cycle; resolves or rejects per `outcome`. */
    settleOldest: async (outcome) => {
      if (cycles.length - settled <= 0) return false;
      const d = cycles[settled];
      settled += 1;
      if (outcome === 'reject') d.reject(new Error('transient'));
      else d.resolve();
      await flush();
      return true;
    },
  };
}

// ─── operation generators ─────────────────────────────────────────────────────

/**
 * One driver operation. `notify` and `advance` are weighted higher so most runs
 * spend their length actually triggering and crossing cooldown boundaries rather
 * than churning capture/stop state.
 */
const arbOp = fc.oneof(
  { arbitrary: fc.constant({ type: 'notify' }), weight: 5 },
  {
    arbitrary: fc.record({ type: fc.constant('advance'), ms: fc.integer({ min: 0, max: 12000 }) }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      type: fc.constant('settle'),
      outcome: fc.constantFrom('resolve', 'reject'),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ type: fc.constant('setCapture'), value: fc.boolean() }), weight: 2 },
  { arbitrary: fc.constant({ type: 'stop' }), weight: 1 },
  { arbitrary: fc.constant({ type: 'restart' }), weight: 1 },
);

const arbScenario = fc.record({
  cooldownMs: fc.integer({ min: 0, max: 10000 }),
  startClock: fc.integer({ min: 0, max: 100000 }),
  ops: fc.array(arbOp, { minLength: 1, maxLength: 40 }),
});

describe('Auto-Sync triggering reuses the gates and never overlaps', () => {
  it('coalesces, never overlaps, drops on capture, retries on failure, and clears on stop', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ cooldownMs, startClock, ops }) => {
        const clock = fakeClock(startClock);
        const runner = makeCycleRunner();
        // Capture state is mutable and read live by the scheduler's predicate —
        // exactly how a platform's `isCaptureActive` probe behaves.
        const capture = { active: false };

        const sched = createSyncScheduler({
          cooldownMs,
          now: clock.now,
          isCaptureActive: () => capture.active,
        });

        // The scheduler is enabled (started) at the outset; `enabled` is the model
        // of its enablement, which may ONLY change via stop()/restart below.
        sched.start(runner.runCycle);
        let enabled = true;

        /**
         * Invariants that must hold after EVERY operation (the heart of this property).
         */
        const checkInvariants = () => {
          // cycles never overlap: at most one cycle is ever in flight,
          // and the scheduler's own running flag agrees with reality.
          const live = runner.inFlight();
          assert.ok(live === 0 || live === 1, `at most one cycle in flight, saw ${live}`);
          assert.equal(sched.isRunning(), live === 1, 'isRunning tracks the in-flight cycle');

          // the scheduler decides WHEN, not WHETHER: its
          // enabled state is governed solely by start()/stop(); it never disables
          // itself because a cycle failed, succeeded, or capture is active.
          assert.equal(sched.isActive(), enabled, 'enablement changes only via start/stop');

          // the follow-up is a single boolean: at most one pending
          // cycle is ever queued, and a stopped scheduler holds nothing pending.
          assert.equal(typeof sched.hasPending(), 'boolean', 'pending is a single flag');
          if (!enabled) {
            assert.equal(sched.hasPending(), false, 'stop() leaves nothing pending');
          }
        };

        checkInvariants();

        for (const op of ops) {
          switch (op.type) {
            case 'notify': {
              const beforeCount = runner.count();
              const beforePending = sched.hasPending();
              const beforeLive = runner.inFlight();
              const outcome = sched.notify();

              if (!enabled) {
                // A stopped scheduler ignores every trigger.
                assert.equal(outcome, 'disabled', 'disabled scheduler ignores triggers');
                assert.equal(runner.count(), beforeCount, 'no cycle starts while disabled');
                assert.equal(sched.hasPending(), false, 'nothing queued while disabled');
              } else if (capture.active) {
                // drop, NOT queue: no cycle starts and the pending flag is
                // not advanced by a trigger that arrives during capture.
                assert.equal(outcome, 'capture-dropped', 'capture trigger is dropped');
                assert.equal(runner.count(), beforeCount, 'no cycle starts during capture');
                assert.equal(
                  sched.hasPending(),
                  beforePending,
                  'a capture-dropped trigger is not queued',
                );
              } else if (beforeLive === 1) {
                // a trigger during an in-flight cycle never starts a second
                // concurrent cycle; it folds into the single follow-up.
                assert.equal(outcome, 'coalesced', 'in-flight trigger coalesces');
                assert.equal(runner.count(), beforeCount, 'no overlapping cycle is started');
                assert.equal(sched.hasPending(), true, 'the single follow-up is now queued');
              } else {
                // Idle: either a leading-edge dispatch or a cooldown-deferred follow-up.
                assert.ok(
                  outcome === 'dispatched' || outcome === 'deferred',
                  `idle trigger dispatches or defers, saw ${outcome}`,
                );
                if (outcome === 'dispatched') {
                  assert.equal(runner.count(), beforeCount + 1, 'leading edge starts one cycle');
                  assert.equal(runner.inFlight(), 1, 'the dispatched cycle is in flight');
                } else {
                  assert.equal(runner.count(), beforeCount, 'a deferred trigger starts no cycle');
                  assert.equal(sched.hasPending(), true, 'a deferred trigger queues the follow-up');
                }
              }
              break;
            }

            case 'advance': {
              clock.advance(op.ms);
              break;
            }

            case 'settle': {
              const beforeCount = runner.count();
              const had = runner.inFlight() === 1;
              const dispatched = await runner.settleOldest(op.outcome);
              if (had) {
                assert.equal(dispatched, true, 'an in-flight cycle was settled');
                // At most ONE follow-up may start when a cycle settles;
                // and a settle while disabled must start none (via stop()).
                if (enabled) {
                  assert.ok(
                    runner.count() <= beforeCount + 1,
                    'a settling cycle starts at most one follow-up',
                  );
                } else {
                  assert.equal(
                    runner.count(),
                    beforeCount,
                    'a cycle settling after stop() starts no follow-up',
                  );
                }
              }
              break;
            }

            case 'setCapture': {
              capture.active = op.value;
              break;
            }

            case 'stop': {
              sched.stop();
              enabled = false;
              // stop disables and clears the pending follow-up.
              assert.equal(sched.isActive(), false, 'stop disables the scheduler');
              assert.equal(sched.hasPending(), false, 'stop clears the pending follow-up');
              assert.equal(sched.notify(), 'disabled', 'a stopped scheduler ignores triggers');
              break;
            }

            case 'restart': {
              sched.start(runner.runCycle);
              enabled = true;
              break;
            }

            default:
              throw new Error(`unknown op ${op.type}`);
          }

          checkInvariants();
        }
      }),
      { numRuns: 300 },
    );
  });

  // ── Deterministic regression examples (named scenarios) ──

  /** A cycle runner whose single in-flight cycle the test settles on demand. */
  function runnerWithSettle() {
    const cycles = [];
    let settled = 0;
    return {
      runCycle: () => {
        const d = deferred();
        cycles.push(d);
        return d.promise;
      },
      count: () => cycles.length,
      settle: async () => {
        cycles[settled].resolve();
        settled += 1;
        await flush();
      },
    };
  }

  it('a burst during one window collapses to one in-flight + at most one follow-up', async () => {
    const clock = fakeClock();
    const runner = runnerWithSettle();
    const sched = createSyncScheduler({ cooldownMs: 5000, now: clock.now });
    sched.start(runner.runCycle);

    // A burst of ten triggers inside one cooldown window.
    assert.equal(sched.notify(), 'dispatched');
    for (let i = 0; i < 9; i += 1) sched.notify();
    assert.equal(runner.count(), 1, 'the burst started exactly one cycle');
    assert.equal(sched.hasPending(), true, 'and queued a single follow-up');

    // Cooldown elapses, the cycle settles: exactly one follow-up, never a pile-up.
    clock.advance(5000);
    await runner.settle();
    assert.equal(runner.count(), 2, 'one coalesced follow-up ran, not nine');
    assert.equal(sched.hasPending(), false);
  });

  it('triggers during capture are dropped, never queued', () => {
    const clock = fakeClock();
    const runner = runnerWithSettle();
    let capturing = true;
    const sched = createSyncScheduler({
      cooldownMs: 0,
      now: clock.now,
      isCaptureActive: () => capturing,
    });
    sched.start(runner.runCycle);

    for (let i = 0; i < 5; i += 1) assert.equal(sched.notify(), 'capture-dropped');
    assert.equal(runner.count(), 0, 'no cycle started during capture');
    assert.equal(sched.hasPending(), false, 'and nothing was queued for later');

    capturing = false;
    assert.equal(sched.notify(), 'dispatched', 'a fresh trigger after capture dispatches normally');
    assert.equal(runner.count(), 1);
  });

  it('a failing cycle leaves the scheduler enabled to retry', async () => {
    const clock = fakeClock();
    let calls = 0;
    const runCycle = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
    };
    const sched = createSyncScheduler({ cooldownMs: 0, now: clock.now });
    sched.start(runCycle);

    sched.notify();
    await flush();
    assert.equal(sched.isActive(), true, 'a transient failure does not disable the scheduler');
    assert.equal(sched.isRunning(), false);
    assert.equal(sched.notify(), 'dispatched', 'the next trigger retries');
    assert.equal(calls, 2);
  });
});
