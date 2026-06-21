/**
 * sync-scheduler.js — Shared cooldown-debounced Auto-Sync scheduler
 *
 * Auto-Sync only changes *what triggers* a sync cycle: every
 * cycle it starts calls the same shared `sync()` and passes through the identical
 * live-work gates (capture-halt, locked-recording exclusion, pending-actions
 * safety) as a manual cycle. The platform-specific seam is the
 * `SyncTrigger` adapter (typedef in `sync-types.js`) — `chrome.alarms` + event
 * hooks on the extension, a timer + event hooks on desktop.
 *
 * What is genuinely *shared* across both platforms is the coalescing logic: a
 * burst of local data events plus the periodic backstop must collapse into at
 * most one cycle per cooldown window, and cycles must never overlap. That logic lives here, decoupled from the actual timer/event
 * wiring, so both adapters debounce identically and parity is structural rather
 * than duplicated.
 *
 * Two pieces:
 *   - `createSyncScheduler(...)` — the pure state machine. Platform code feeds it
 *     `notify()` on every trigger (a data event or a backstop tick); it decides
 *     whether to dispatch a cycle now, coalesce it into a single follow-up, defer
 *     it behind the cooldown, or drop it while capture is active. It owns the
 *     decision *when* to run — never *whether to proceed* (the capture/lock gates
 *     inside `sync()` remain the source of truth; the optional capture predicate
 *     here is a drop-not-queue optimization).
 *   - `createSyncTrigger({ wire, ... })` — a thin convenience that wraps a
 *     scheduler in the `SyncTrigger` `start(runCycle)` / `stop()` shape, calling a
 *     platform-supplied `wire(notify)` to register the actual `chrome.alarms` /
 *     timer + event hooks and tearing them down on `stop()`.
 *
 * Time-injectable (via the underlying dispatch-cooldown clock) so coalescing can
 * be unit-/property-tested without real timers.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { createDispatchCooldown } from './dispatch-cooldown.js';

/**
 * The ~60s backstop interval for the periodic Auto-Sync trigger. Platform
 * adapters use this to set the `chrome.alarms` period (extension) or the timer
 * interval (desktop); it is exported here so both platforms use one value.
 *
 * @type {number}
 */
export const BACKSTOP_INTERVAL_MS = 60000;

/**
 * The outcome of a single {@link createSyncScheduler}.`notify` call. Pure
 * observability for tests and logging — platform adapters can ignore it.
 *
 *   - `'dispatched'`      a cycle was started now (leading edge).
 *   - `'coalesced'`       a cycle is already in flight; this trigger was folded
 *                         into the single pending follow-up.
 *   - `'deferred'`        within the cooldown window; folded into the single
 *                         pending follow-up that runs once the window elapses.
 *   - `'capture-dropped'` capture is active; the trigger was dropped, not queued.
 *   - `'disabled'`        the scheduler is stopped/not started; the trigger was
 *                         ignored.
 *
 * @typedef {('dispatched'|'coalesced'|'deferred'|'capture-dropped'|'disabled')} NotifyOutcome
 */

/**
 * Create the shared cooldown-debounced Auto-Sync scheduler.
 *
 * The scheduler is event-driven: it owns no real timer. Platform code calls
 * {@link notify} on every trigger source — local data events (step commit,
 * recording close, project/recording create/delete) and the ~60s backstop tick.
 * The scheduler collapses a burst into at most one cycle per cooldown
 * window and guarantees cycles never overlap:
 *
 *   - A trigger while a cycle is in flight sets a single pending follow-up; the
 *     follow-up runs when that cycle settles (subject to the cooldown), so N
 *     triggers during one cycle yield at most one follow-up.
 *   - A trigger inside the cooldown window sets the same single pending follow-up
 *     instead of starting a second cycle in the window. It is dispatched
 *     by the next trigger to arrive after the window elapses (the ~60s backstop
 *     guarantees one always does), or immediately when an in-flight cycle that
 *     outlasted the window settles.
 *   - A trigger while capture is active is dropped, not queued, when an
 *     `isCaptureActive` predicate is supplied.
 *
 * Failures from `runCycle` are caught so the scheduler survives them and stays
 * enabled (a transient error retries on the next trigger). An auth
 * failure that must disable Auto-Sync is the platform's responsibility:
 * its `runCycle` wrapper inspects the cycle result and calls {@link stop} — the
 * scheduler does not interpret cycle results itself, keeping it pure plumbing.
 *
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs] — coalescing window length; defaults to the
 *   dispatch-cooldown default. A burst within this window yields at most
 *   one cycle.
 * @param {() => number} [opts.now=Date.now] — clock source, injectable for tests.
 * @param {() => boolean} [opts.isCaptureActive] — optional synchronous capture
 *   probe; when it returns true, an arriving trigger is dropped (not queued) and
 *   no cycle starts. Defaults to never-active (the gate inside `sync()`
 *   remains authoritative).
 * @returns {{
 *   start: (runCycle: () => (void | Promise<void>)) => void,
 *   stop: () => void,
 *   notify: () => NotifyOutcome,
 *   isActive: () => boolean,
 *   isRunning: () => boolean,
 *   hasPending: () => boolean,
 * }}
 */
export function createSyncScheduler({ cooldownMs, now = Date.now, isCaptureActive } = {}) {
  const cooldown = createDispatchCooldown(cooldownMs === undefined ? { now } : { cooldownMs, now });
  const captureActive = typeof isCaptureActive === 'function' ? isCaptureActive : () => false;

  /** @type {(() => (void | Promise<void>)) | null} The bound cycle runner. */
  let runCycle = null;
  let enabled = false;
  let inFlight = false;
  /** A single coalesced follow-up is queued. */
  let pending = false;

  /**
   * Dispatch a cycle if every guard permits. Called after a trigger and again
   * when an in-flight cycle settles, so a coalesced follow-up runs as soon as the
   * scheduler is idle and out of cooldown.
   */
  function maybeRun() {
    if (!enabled || runCycle === null) return;
    if (inFlight) return; // never overlap
    if (!pending) return; // nothing requested
    if (captureActive()) return; // hold the follow-up until capture ends
    if (!cooldown.canSend()) return; // still inside the coalescing window

    pending = false;
    inFlight = true;
    cooldown.markSent();

    /** Mark the cycle settled and service any coalesced follow-up. */
    const settle = () => {
      inFlight = false;
      maybeRun();
    };

    let result;
    try {
      result = runCycle(); // start the cycle synchronously (leading edge)
    } catch {
      // A synchronous throw must not break the scheduler; retry next trigger.
      settle();
      return;
    }
    // Swallow async rejections too: a failing cycle stays enabled and retries on
    // the next trigger; auth-disable is the platform's job — its runCycle
    // wrapper inspects the result and calls stop().
    Promise.resolve(result).then(settle, settle);
  }

  return {
    /**
     * Begin scheduling. Stores the cycle runner and enables triggers. Does not
     * itself dispatch a cycle — platform code calls {@link notify} (an initial
     * event or the first backstop tick) to start one.
     *
     * @param {() => (void | Promise<void>)} cycle — invokes the shared `sync()`.
     */
    start(cycle) {
      if (typeof cycle !== 'function') {
        throw new TypeError('createSyncScheduler.start requires a runCycle function');
      }
      runCycle = cycle;
      enabled = true;
    },

    /**
     * Tear down scheduling on disable, a server-settings change, or a 401/403
     * auto-disable. Clears the pending follow-up and resets the
     * cooldown so a later {@link start} can dispatch immediately. An already
     * in-flight cycle is left to settle (a remote `sync()` cannot be aborted
     * mid-write); its completion will not dispatch a follow-up because the
     * scheduler is now disabled.
     */
    stop() {
      enabled = false;
      pending = false;
      runCycle = null;
      cooldown.reset();
    },

    /**
     * Record that a trigger fired (a local data event or a backstop tick) and
     * dispatch/coalesce per the cooldown and in-flight guards.
     *
     * @returns {NotifyOutcome}
     */
    notify() {
      if (!enabled || runCycle === null) return 'disabled';
      if (captureActive()) return 'capture-dropped'; // drop, not queue

      const wasRunning = inFlight;
      const inCooldown = !inFlight && !cooldown.canSend();
      pending = true;
      maybeRun();

      if (wasRunning) return 'coalesced';
      if (inCooldown) return 'deferred';
      // If maybeRun dispatched, `pending` was cleared and a cycle is in flight.
      return pending ? 'deferred' : 'dispatched';
    },

    /** True while scheduling is enabled (between start and stop). */
    isActive() {
      return enabled;
    },

    /** True while a cycle is currently in flight. */
    isRunning() {
      return inFlight;
    },

    /** True while a single follow-up cycle is coalesced and waiting. */
    hasPending() {
      return pending;
    },
  };
}

/**
 * Build a {@link import('./sync-types.js').SyncTrigger} from a shared scheduler
 * and a platform-supplied wiring function. This is the turnkey adapter shape the
 * extension service worker (`chrome.alarms` + event hooks) and the desktop timer
 * both target: the shared coalescing lives in the scheduler, and only the actual
 * event/timer registration differs per platform.
 *
 * `wire(notify)` is invoked on `start` and must register the platform's trigger
 * sources — each calling the passed `notify` — and return a teardown function
 * that removes them; the teardown runs on `stop`.
 *
 * @param {object} opts
 * @param {(notify: () => void) => (void | (() => void))} opts.wire — registers
 *   platform trigger sources against `notify`; returns an optional teardown.
 * @param {ReturnType<typeof createSyncScheduler>} [opts.scheduler] — a scheduler
 *   to use; one is created from the remaining options when omitted.
 * @param {number} [opts.cooldownMs] — forwarded to {@link createSyncScheduler}.
 * @param {() => number} [opts.now] — forwarded to {@link createSyncScheduler}.
 * @param {() => boolean} [opts.isCaptureActive] — forwarded to {@link createSyncScheduler}.
 * @returns {import('./sync-types.js').SyncTrigger}
 */
export function createSyncTrigger({ wire, scheduler, cooldownMs, now, isCaptureActive }) {
  if (typeof wire !== 'function') {
    throw new TypeError('createSyncTrigger requires a wire(notify) function');
  }
  const sched = scheduler || createSyncScheduler({ cooldownMs, now, isCaptureActive });
  /** @type {(() => void) | null} */
  let unwire = null;

  return {
    /**
     * Begin firing `runCycle` on platform triggers, cooldown-debounced.
     * @param {() => (void | Promise<void>)} runCycle
     */
    start(runCycle) {
      sched.start(runCycle);
      const teardown = wire(() => sched.notify());
      unwire = typeof teardown === 'function' ? teardown : null;
    },

    /** Tear the trigger down on disable / settings change / auth-disable. */
    stop() {
      if (unwire) {
        unwire();
        unwire = null;
      }
      sched.stop();
    },
  };
}
