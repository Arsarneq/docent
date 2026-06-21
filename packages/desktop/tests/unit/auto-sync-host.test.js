/**
 * auto-sync-host.test.js — Unit tests for the desktop background Auto-Sync host
 * (`src/auto-sync-host.js`).
 *
 * Validates the desktop side of Auto-Sync: the host invokes the SAME shared
 * `sync()` with the SAME adapters the manual path uses, routes
 * the ~60s backstop + data-event triggers through the shared cooldown-debounced
 * scheduler so a burst coalesces into one cycle and cycles never overlap, drops triggers while capture is active, and applies the
 * auth-disable / transient-retry failure policy.
 *
 * All collaborators are injected fakes — no Tauri, no network — so the host's
 * orchestration logic is exercised deterministically (injected clock + a
 * settle-able cycle, mirroring sync-scheduler.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAutoSyncHost, createDesktopWire } from '../../src/auto-sync-host.js';

// ─── deterministic test doubles ───────────────────────────────────────────────

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

/** Flush pending microtasks (the scheduler chains then/catch/finally). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A LiveState double; capture flag is mutable so tests can toggle it. */
function fakeLiveState({ capturing = false } = {}) {
  const state = { capturing };
  return {
    state,
    isCaptureActive: () => state.capturing,
    getLockedRecordingIds: () => new Set(),
    recordingsWithPendingActions: () => new Set(),
  };
}

/**
 * Build a host wired to fakes. `getDataHook()` returns the scheduler-bound
 * notify the host registered through `onDataEvent` once `start()` has run.
 */
function makeHost(overrides = {}) {
  const calls = { sync: 0, setProjects: [], cycleComplete: [], authDisable: 0, lastArgs: null };
  const live = overrides.liveState ?? fakeLiveState();
  let dataHook = null;

  const host = createAutoSyncHost({
    serverUrl: 'https://sync.test',
    apiKey: 'tok',
    getProjects: () => overrides.projects ?? [{ project_id: 'p1' }],
    setProjects: (merged) => {
      calls.setProjects.push(merged);
    },
    getSchema: () => ({ schema: true }),
    getValidator: () => () => true,
    store: { async load() {}, async save() {} },
    liveState: live,
    onDataEvent: (notify) => {
      dataHook = notify;
    },
    onCycleComplete: (info) => {
      calls.cycleComplete.push(info);
    },
    onAuthDisable: () => {
      calls.authDisable += 1;
    },
    cooldownMs: overrides.cooldownMs ?? 0,
    now: overrides.now,
    // No real backstop timer in these tests — use a no-op interval.
    setIntervalFn: () => 0,
    clearIntervalFn: () => {},
    syncFn: async (serverUrl, apiKey, projects) => {
      calls.sync += 1;
      calls.lastArgs = { serverUrl, apiKey, projects };
      return {
        result: overrides.syncResult ?? { halted: false, pushed: [], pulled: [] },
        projects: overrides.mergedProjects ?? projects,
      };
    },
  });

  return { host, calls, live, getDataHook: () => dataHook };
}

// ─── createAutoSyncHost ─────────────────────────────────────────────────────────

describe('createAutoSyncHost', () => {
  it('runs one shared cycle on a data event with the manual-path adapters', async () => {
    const { host, calls, getDataHook } = makeHost();
    host.start();

    getDataHook()();
    await flush();

    assert.equal(calls.sync, 1, 'shared sync() invoked exactly once');
    assert.deepEqual(calls.lastArgs.projects, [{ project_id: 'p1' }]);
    assert.equal(calls.lastArgs.serverUrl, 'https://sync.test');
    assert.equal(calls.setProjects.length, 1, 'merged projects persisted');
    assert.equal(calls.cycleComplete.length, 1, 'cycle-complete observed');
    host.stop();
  });

  it('coalesces a burst of data events into one cycle per cooldown window', async () => {
    const clock = fakeClock();
    const { host, calls, getDataHook } = makeHost({ cooldownMs: 5000, now: clock.now });
    host.start();
    const dataHook = getDataHook();

    dataHook();
    dataHook();
    dataHook();
    await flush();

    assert.equal(calls.sync, 1, 'a burst within the cooldown yields a single cycle');
    host.stop();
  });

  it('drops triggers while capture is active, re-enabling when it ends', async () => {
    const live = fakeLiveState({ capturing: true });
    const { host, calls, getDataHook } = makeHost({ liveState: live });
    host.start();
    const dataHook = getDataHook();

    dataHook();
    await flush();
    assert.equal(calls.sync, 0, 'no cycle starts while capture is active');

    live.state.capturing = false;
    dataHook();
    await flush();
    assert.equal(calls.sync, 1, 'a trigger after capture ends runs a cycle');
    host.stop();
  });

  it('disables Auto-Sync on an auth halt and stops triggering', async () => {
    const { host, calls, getDataHook } = makeHost({
      syncResult: { halted: true, haltReason: 'auth', pushed: [], pulled: [] },
    });
    host.start();
    const dataHook = getDataHook();

    dataHook();
    await flush();

    assert.equal(calls.sync, 1, 'the auth cycle ran once');
    assert.equal(calls.authDisable, 1, 'onAuthDisable invoked');

    // The host stopped itself; a subsequent trigger must not start a cycle.
    dataHook();
    await flush();
    assert.equal(calls.sync, 1, 'no further cycles after auth-disable');
  });

  it('stays enabled and retries after a transient error', async () => {
    const clock = fakeClock();
    const { host, calls, getDataHook } = makeHost({
      cooldownMs: 0,
      now: clock.now,
      syncResult: { halted: false, errors: [{ project_id: 'p1', message: '500' }] },
    });
    host.start();
    const dataHook = getDataHook();

    dataHook();
    await flush();
    assert.equal(calls.sync, 1);
    assert.equal(calls.authDisable, 0, 'a transient error does not disable Auto-Sync');

    dataHook();
    await flush();
    assert.equal(calls.sync, 2, 'a later trigger retries');
    host.stop();
  });

  it('runCycleNow invokes the shared cycle directly, bypassing the trigger', async () => {
    const { host, calls } = makeHost();
    host.start();

    const result = await host.runCycleNow();

    assert.equal(calls.sync, 1);
    assert.equal(result.halted, false);
    host.stop();
  });
});

// ─── createDesktopWire ──────────────────────────────────────────────────────────

describe('createDesktopWire', () => {
  it('fires the periodic backstop through notify and tears it down', () => {
    let intervalCb = null;
    let cleared = false;
    let notifies = 0;

    const wire = createDesktopWire({
      onDataEvent: () => {},
      backstopIntervalMs: 60000,
      setIntervalFn: (cb) => {
        intervalCb = cb;
        return 'handle';
      },
      clearIntervalFn: (h) => {
        cleared = h === 'handle';
      },
    });

    const teardown = wire(() => {
      notifies += 1;
    });

    assert.equal(typeof intervalCb, 'function', 'a backstop interval was registered');
    intervalCb();
    assert.equal(notifies, 1, 'the backstop tick calls notify');

    teardown();
    assert.equal(cleared, true, 'teardown clears the backstop interval');
  });

  it('disarms the data hook on teardown so a late data event does not notify', () => {
    let dataCb = null;
    let notifies = 0;

    const wire = createDesktopWire({
      onDataEvent: (cb) => {
        dataCb = cb;
      },
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });

    const teardown = wire(() => {
      notifies += 1;
    });

    dataCb();
    assert.equal(notifies, 1, 'data event notifies while wired');

    teardown();
    dataCb();
    assert.equal(notifies, 1, 'data event is a no-op after teardown');
  });
});
