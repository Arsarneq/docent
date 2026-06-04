/**
 * auto-sync-host.js — Desktop background Auto-Sync host (R23.7, R23.9, R23.10,
 * R23.13, R23.15, R23.16)
 *
 * This is the desktop counterpart of the extension's background service-worker
 * host. Auto-Sync changes only *what triggers* a cycle; every cycle it starts
 * runs the same shared `sync()` and passes through the identical live-work gates
 * as a manual cycle (R15.3, R23.13). The platform-specific seam is the
 * `SyncTrigger` — a ~60s backstop timer plus local data-event hooks — routed
 * through the shared cooldown-debounced scheduler so a burst coalesces into at
 * most one cycle per window and cycles never overlap (R23.7, R23.8, R23.14).
 *
 * **Why this is a separate module, not inline in panel.js.** R23.15/23.16 require
 * the triggered cycle to run in a context that stays live when the window is
 * closed/minimized, reading the SAME `SyncStore`, `LiveState`, schema, and
 * validator the manual path uses. On desktop the design's chosen keep-alive is
 * "the Tauri webview kept alive": the webview (and therefore this JS host's timer
 * + event hooks + `sync()` invocation) keeps running when the window is hidden
 * rather than destroyed (see `src-tauri/src/lib.rs` — the close request hides the
 * window while Auto-Sync keep-alive is armed, and a tray icon restores/quits it).
 * Hosting the trigger in this module — owned by the panel but free of any DOM
 * dependency — keeps the headless cycle decoupled from the UI surface while still
 * sharing one persisted `SyncState` the panel renders indicators from when shown
 * (R23.10, R23.16).
 *
 * **What this module does NOT do.** It performs no reconciliation, no detection,
 * and no resolution itself — all of that stays in shared `sync()`/`SyncStore`.
 * The manual Sync button and the Conflict_Resolution UI remain in the panel; this
 * host only decides *when* to invoke the shared cycle and persists the result so
 * the panel can surface attention indicators later (R23.10).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { sync } from '../shared/sync-client.js';
import { createSyncTrigger, BACKSTOP_INTERVAL_MS } from '../shared/sync-scheduler.js';

/**
 * Wire the desktop platform trigger sources against the shared scheduler's
 * `notify`: a ~60s backstop interval (R23.7b) plus a hook the panel calls on
 * meaningful local data events (step commit, recording close, project/recording
 * create/delete — R23.7a). The scheduler owns the cooldown-debounce and the
 * never-overlap guarantee; this wiring only registers and tears down the raw
 * sources (R23.13).
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
    // forwards to the scheduler's notify (R23.7a). The panel keeps a single
    // active callback; we hand it one bound to this trigger's notify.
    let dataHookActive = true;
    const dataHandler = () => {
      if (dataHookActive) notify();
    };
    if (typeof onDataEvent === 'function') {
      onDataEvent(dataHandler);
    }

    // (b) ~60s periodic backstop so a locally-idle client still pulls others'
    // changes (R23.7b). Routed through the same notify, so it coalesces with
    // data events into at most one cycle per cooldown window (R23.8).
    const intervalHandle = setIntervalFn(() => notify(), backstopIntervalMs);

    // Teardown: stop the backstop and disarm the data hook (R23.3, R23.11).
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
 * manual path passes (R23.16). The host is deliberately ignorant of the DOM: it
 * is given small callbacks to fetch the current local projects, persist the
 * merged projects, fetch the schema/validator, and observe the cycle result —
 * so it can run whether or not the window is visible (R23.10, R23.15).
 *
 * **Failure policy (R23.11, R23.12).** After each cycle the host inspects the
 * result: an `auth` halt (HTTP 401/403) disables Auto-Sync and reports it so the
 * panel can flag Settings for a re-test, then `stop()`s the trigger so it does
 * not keep retrying bad credentials on the interval (R23.11). Every other
 * outcome — a transient error, a live-work halt, or a clean cycle — leaves the
 * host enabled to retry on the next trigger (R23.12). The scheduler already
 * swallows thrown/rejected cycles so the host survives them (R23.12).
 *
 * @param {object} deps
 * @param {string} deps.serverUrl — sync endpoint (assumed present; the enable
 *   rule checks this before starting, R23.2/R23.17).
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
 *   auth halt disables Auto-Sync (R23.11); the caller persists `autoSync=false`
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
   * manual cycles are identical apart from origin (R23.13, R23.16).
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
    // overwrite in that case (R23.9, R15.3).
    await setProjects(mergedProjects);

    if (typeof onCycleComplete === 'function') {
      await onCycleComplete({ result });
    }

    // Failure policy (R23.11): an auth halt disables Auto-Sync and stops the
    // trigger so we don't keep retrying bad credentials on the interval. A
    // transient/live-work halt or a clean cycle leaves the host enabled (R23.12).
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
    // Drop-not-queue optimization while capturing (R23.9); the gate inside
    // sync() remains authoritative.
    isCaptureActive: () => liveState.isCaptureActive(),
  });

  return {
    /** Begin background scheduling: ~60s backstop + data-event hooks (R23.7). */
    start() {
      trigger.start(runCycle);
    },
    /** Tear down on disable / settings change / auth-disable (R23.3, R23.11). */
    stop() {
      trigger.stop();
    },
    /** Run one cycle immediately, bypassing the trigger (tests / explicit kick). */
    runCycleNow: runCycle,
  };
}
