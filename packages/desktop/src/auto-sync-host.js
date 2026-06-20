/**
 * auto-sync-host.js — Desktop background Auto-Sync host
 *
 * This is the desktop counterpart of the extension's background service-worker
 * host. Auto-Sync changes only *what triggers* a cycle; every cycle it starts
 * runs the same shared `sync()` and passes through the identical live-work gates
 * as a manual cycle. The platform-specific seam is the
 * `SyncTrigger` — a ~60s backstop timer plus local data-event hooks — routed
 * through the shared cooldown-debounced scheduler so a burst coalesces into at
 * most one cycle per window and cycles never overlap.
 *
 * **Why this is a separate module, not inline in panel.js.** Auto-Sync requires
 * the triggered cycle to run in a context that stays live when the window is
 * closed/minimized, reading the SAME `SyncStore`, `LiveState`, schema, and
 * validator the manual path uses. On desktop the design's chosen keep-alive is
 * "the Tauri webview kept alive": the webview (and therefore this JS host's timer
 * + event hooks + `sync()` invocation) keeps running when the window is hidden
 * rather than destroyed (see `src-tauri/src/lib.rs` — the close request hides the
 * window while Auto-Sync keep-alive is armed, and a tray icon restores/quits it).
 * Hosting the trigger in this module — owned by the panel but free of any DOM
 * dependency — keeps the headless cycle decoupled from the UI surface while still
 * sharing one persisted `SyncState` the panel renders indicators from when shown.
 *
 * **What this module does NOT do.** It performs no reconciliation, no detection,
 * and no resolution itself — all of that stays in shared `sync()`/`SyncStore`.
 * The manual Sync button and the Conflict_Resolution UI remain in the panel; this
 * host only decides *when* to invoke the shared cycle and persists the result so
 * the panel can surface attention indicators later.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { sync } from '../shared/sync-client.js';
import { createSyncTrigger, BACKSTOP_INTERVAL_MS } from '../shared/sync-scheduler.js';

/**
 * Wire the desktop platform trigger sources against the shared scheduler's
 * `notify`: a ~60s backstop interval plus a hook the panel calls on
 * meaningful local data events (step commit, recording close, project/recording
 * create/delete). The scheduler owns the cooldown-debounce and the
 * never-overlap guarantee; this wiring only registers and tears down the raw
 * sources.
 *
 * The returned `wire(notify)` matches the `createSyncTrigger` contract: it
 * registers the sources and returns a teardown that removes them on `stop()`.
 *
 * @param {object} hooks
 * @param {(notify: () => void) => void} hooks.onDataEvent — register a callback
 *   the panel invokes on a local data event; the host calls `notify` from it.
 * @param {number} [hooks.backstopIntervalMs=BACKSTOP_INTERVAL_MS] — backstop
 *   period (injectable for tests).
 * @param {(handler: () => void, ms: number) => unknown} [hooks.setIntervalFn=setInterval]
 * @param {(handle: unknown) => void} [hooks.clearIntervalFn=clearInterval]
 * @returns {(notify: () => void) => (() => void)}
 */
export function createDesktopWire({
  onDataEvent,
  backstopIntervalMs = BACKSTOP_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  return (notify) => {
    // (a) Local data events — the panel calls the registered callback, which
    // forwards to the scheduler's notify. The panel keeps a single
    // active callback; we hand it one bound to this trigger's notify.
    let dataHookActive = true;
    const dataHandler = () => {
      if (dataHookActive) notify();
    };
    if (typeof onDataEvent === 'function') {
      onDataEvent(dataHandler);
    }

    // (b) ~60s periodic backstop so a locally-idle client still pulls others'
    // changes. Routed through the same notify, so it coalesces with
    // data events into at most one cycle per cooldown window.
    const intervalHandle = setIntervalFn(() => notify(), backstopIntervalMs);

    // Teardown: stop the backstop and disarm the data hook.
    return () => {
      dataHookActive = false;
      clearIntervalFn(intervalHandle);
    };
  };
}

/**
 * Build the desktop Auto-Sync background host.
 *
 * The host wraps the shared cooldown-debounced scheduler (via `createSyncTrigger`)
 * and a `runCycle` that invokes the shared `sync()` with the SAME adapters the
 * manual path passes. The host is deliberately ignorant of the DOM: it
 * is given small callbacks to fetch the current local projects, persist the
 * merged projects, fetch the schema/validator, and observe the cycle result —
 * so it can run whether or not the window is visible.
 *
 * **Failure policy.** After each cycle the host inspects the
 * result: an `auth` halt (HTTP 401/403) disables Auto-Sync and reports it so the
 * panel can flag Settings for a re-test, then `stop()`s the trigger so it does
 * not keep retrying bad credentials on the interval. Every other
 * outcome — a transient error, a live-work halt, or a clean cycle — leaves the
 * host enabled to retry on the next trigger. The scheduler already
 * swallows thrown/rejected cycles so the host survives them.
 *
 * @param {object} deps
 * @param {string} deps.serverUrl — sync endpoint (assumed present; the enable
 *   rule checks this before starting).
 * @param {string|null} deps.apiKey — Bearer token, or null.
 * @param {() => object[]} deps.getProjects — current local projects (full shape).
 * @param {(projects: object[]) => (void | Promise<void>)} deps.setProjects —
 *   persist the merged projects (writes the same Tauri blob the panel uses).
 * @param {() => (object | Promise<object>)} deps.getSchema — composed platform schema.
 * @param {() => (Function | Promise<Function>)} deps.getValidator — generated validator.
 * @param {import('../shared/sync-types.js').SyncStore} deps.store — durable
 *   SyncState adapter (same one the panel passes).
 * @param {import('../shared/sync-types.js').LiveState} deps.liveState — live-work
 *   signals (same adapter the panel passes).
 * @param {(notify: () => void) => void} deps.onDataEvent — register the data-event hook.
 * @param {(info: { result: object }) => (void | Promise<void>)} [deps.onCycleComplete] —
 *   observe each completed cycle (e.g. to refresh indicators when shown).
 * @param {() => (void | Promise<void>)} [deps.onAuthDisable] — called when an
 *   auth halt disables Auto-Sync; the caller persists `autoSync=false`
 *   and flags Settings for re-test.
 * @param {object} [deps.scheduler] — injectable scheduler (tests).
 * @param {number} [deps.cooldownMs] — forwarded to the scheduler (tests).
 * @param {() => number} [deps.now] — clock (tests).
 * @param {number} [deps.backstopIntervalMs] — backstop period (tests).
 * @param {(handler: () => void, ms: number) => unknown} [deps.setIntervalFn] — tests.
 * @param {(handle: unknown) => void} [deps.clearIntervalFn] — tests.
 * @param {typeof sync} [deps.syncFn=sync] — the cycle function; defaults to the
 *   shared `sync()`. Injectable so the host's cycle/auth-disable logic can be
 *   unit-tested without real network I/O.
 * @returns {{ start: () => void, stop: () => void, runCycleNow: () => Promise<void> }}
 */
export function createAutoSyncHost(deps) {
  const {
    serverUrl,
    apiKey,
    getProjects,
    setProjects,
    getSchema,
    getValidator,
    store,
    liveState,
    onDataEvent,
    onCycleComplete,
    onAuthDisable,
    scheduler,
    cooldownMs,
    now,
    backstopIntervalMs,
    setIntervalFn,
    clearIntervalFn,
    syncFn = sync,
  } = deps;

  /**
   * Run one Auto-Sync cycle: invoke the shared `sync()` with the manual path's
   * adapters, persist the merged projects, and surface the result. Triggered and
   * manual cycles are identical apart from origin.
   *
   * @returns {Promise<object>} the SyncResult (also passed to onCycleComplete).
   */
  async function runCycle() {
    const schema = await getSchema();
    const validator = await getValidator();

    const { result, projects: mergedProjects } = await syncFn(
      serverUrl,
      apiKey,
      getProjects(),
      schema,
      validator,
      store,
      liveState,
    );

    // Persist the merged projects through the same seam the panel uses. A
    // live-work halt returns the projects unchanged, so this is a safe no-op
    // overwrite in that case.
    await setProjects(mergedProjects);

    if (typeof onCycleComplete === 'function') {
      await onCycleComplete({ result });
    }

    // Failure policy: an auth halt disables Auto-Sync and stops the
    // trigger so we don't keep retrying bad credentials on the interval. A
    // transient/live-work halt or a clean cycle leaves the host enabled.
    if (result.halted && result.haltReason === 'auth') {
      // Disable the trigger first so a coalesced follow-up cannot start.
      trigger.stop();
      if (typeof onAuthDisable === 'function') {
        await onAuthDisable();
      }
    }

    return result;
  }

  const wire = createDesktopWire({
    onDataEvent,
    backstopIntervalMs,
    setIntervalFn,
    clearIntervalFn,
  });

  const trigger = createSyncTrigger({
    wire,
    scheduler,
    cooldownMs,
    now,
    // Drop-not-queue optimization while capturing; the gate inside
    // sync() remains authoritative.
    isCaptureActive: () => liveState.isCaptureActive(),
  });

  return {
    /** Begin background scheduling: ~60s backstop + data-event hooks. */
    start() {
      trigger.start(runCycle);
    },
    /** Tear down on disable / settings change / auth-disable. */
    stop() {
      trigger.stop();
    },
    /** Run one cycle immediately, bypassing the trigger (tests / explicit kick). */
    runCycleNow: runCycle,
  };
}
