/**
 * sync-settings-state-machine.test.js — Render-with-seeded-settings example
 * tests for the two reconciliation-policy toggles and the Auto-Sync
 * enable/disable state machine.
 *
 * Both platform panels (extension `sidepanel/panel.js`, desktop `src/panel.js`)
 * use top-level `await` and DOM globals, so they cannot be imported under
 * `node --test`. Following the established `packages/extension/tests/unit/panel.test.js`
 * convention, the panel's settings state-machine logic is MIRRORED here as small
 * pure functions and driven against the REAL shared layer that owns the state —
 * the `sync-store` settings helpers (`getSettings`/`setSettings`), the
 * `connection-test` helpers (`testConnection`/`settingsFingerprint`), and the
 * `sync-scheduler` — so the test validates the shared logic the UI relies on
 * rather than DOM wiring (identical behavior on both
 * platforms given identical settings + inputs).
 *
 * The mirrored functions reproduce, line-for-line in behavior, the panel's:
 *   - reconciliation-policy toggle render
 *   - `canEnableAutoSync` enable rule
 *   - Auto-Sync controls render incl. the active status indicator
 *   - manual Sync button render (hidden while active)
 *   - the settings-change invalidation and the 401/403 auto-disable +
 *     needs-retest transitions
 *
 * Coverage:
 *   - both Auto-Accept toggles render and persist their state.
 *   - Auto-Sync enables ONLY with an endpoint present AND a
 *     passing Connection_Test for the current settings.
 *   - a settings change (endpoint or plaintext API key) invalidates the
 *     prior pass via the fingerprint and disables Auto-Sync.
 *   - the manual Sync button is hidden and the active
 *     indicator shown while Auto-Sync is active; the reverse when off.
 *   - a 401/403 auto-disable forces OFF + needs-retest, blocking
 *     re-enable until a fresh pass.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createEmptySyncState, getSettings, setSettings } from '../../sync-store.js';
import { testConnection, settingsFingerprint } from '../../connection-test.js';
import { createSyncScheduler } from '../../sync-scheduler.js';

// ─── Mirrored panel logic (verbatim behavior of panel.js) ─────────────────────
//
// These reproduce the settings state machine in both panels. They read only a
// `syncSettings` ({ serverUrl, apiKey }) snapshot and the durable `syncState`,
// exactly as the panels do, and never touch the DOM.

/**
 * Render state for the two reconciliation-policy toggles. Mirrors
 * the first lines of `updateAutoSyncControls()` in both panels.
 *
 * @param {import('../../sync-types.js').SyncState} syncState
 * @returns {{ autoAcceptUpdatesChecked: boolean, autoAcceptDeletionsChecked: boolean }}
 */
function renderPolicyToggles(syncState) {
  const settings = getSettings(syncState);
  return {
    autoAcceptUpdatesChecked: settings.autoAcceptUpdates === true,
    autoAcceptDeletionsChecked: settings.autoAcceptDeletions === true,
  };
}

/**
 * The Auto-Sync enable rule. Mirrors `canEnableAutoSync()`
 * (extension) / `hasPassingConnectionTest()` (desktop): an endpoint must be
 * present AND a Connection_Test must have PASSED for the CURRENT settings, which
 * is enforced by matching the stored `testedSettingsFingerprint` against the
 * fingerprint of the settings held now.
 *
 * @param {{ serverUrl: string|null, apiKey: string|null }} syncSettings
 * @param {import('../../sync-types.js').SyncState} syncState
 * @returns {boolean}
 */
function canEnableAutoSync(syncSettings, syncState) {
  if (!syncSettings.serverUrl) return false; // endpoint-present precondition
  const settings = getSettings(syncState);
  return (
    settings.connectionTest === 'pass' &&
    settings.testedSettingsFingerprint ===
      settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey)
  );
}

/**
 * Render state for the Auto-Sync toggle + its status indicator.
 * Mirrors the Auto-Sync half of `updateAutoSyncControls()` in both panels:
 *   - the toggle reflects the persisted `autoSync` value;
 *   - it is interactive only when enableable OR already on;
 *   - the "Auto-sync active" status indicator shows only while active;
 *   - the Connection_Test button is meaningful only with an endpoint configured.
 *
 * @param {{ serverUrl: string|null, apiKey: string|null }} syncSettings
 * @param {import('../../sync-types.js').SyncState} syncState
 * @returns {{ toggleChecked: boolean, toggleDisabled: boolean, statusIndicatorHidden: boolean, testButtonDisabled: boolean }}
 */
function renderAutoSyncControls(syncSettings, syncState) {
  const settings = getSettings(syncState);
  const active = settings.autoSync === true;
  const enableable = canEnableAutoSync(syncSettings, syncState);
  return {
    toggleChecked: active,
    toggleDisabled: !active && !enableable,
    statusIndicatorHidden: !active,
    testButtonDisabled: !syncSettings.serverUrl,
  };
}

/**
 * Render state for the manual Sync button. Mirrors
 * `updateSyncButton()` in both panels: hidden while Auto-Sync is active (no
 * manual force-sync affordance), shown and endpoint-gated otherwise.
 *
 * @param {{ serverUrl: string|null, apiKey: string|null }} syncSettings
 * @param {import('../../sync-types.js').SyncState} syncState
 * @param {boolean} [isSyncing=false]
 * @returns {{ hidden: boolean, disabled: boolean }}
 */
function renderSyncButton(syncSettings, syncState, isSyncing = false) {
  const active = getSettings(syncState).autoSync === true;
  return {
    hidden: active,
    disabled: active || !syncSettings.serverUrl || isSyncing,
  };
}

/**
 * Apply a server-settings change exactly as the panel's Save handler does:
 * if the fingerprint of the new (endpoint, plaintext key) differs from
 * the previous one, the prior Connection_Test is invalidated and Auto-Sync is
 * forced OFF until a fresh test passes. An unchanged fingerprint leaves the
 * prior pass intact.
 *
 * @param {import('../../sync-types.js').SyncState} syncState
 * @param {{ serverUrl: string|null, apiKey: string|null }} prevSettings
 * @param {{ serverUrl: string|null, apiKey: string|null }} nextSettings
 * @returns {void}
 */
function applyServerSettingsChange(syncState, prevSettings, nextSettings) {
  const prev = settingsFingerprint(prevSettings.serverUrl, prevSettings.apiKey);
  const next = settingsFingerprint(nextSettings.serverUrl, nextSettings.apiKey);
  if (next !== prev) {
    setSettings(syncState, {
      autoSync: false,
      connectionTest: null,
      testedSettingsFingerprint: null,
    });
  }
}

/**
 * Record a Connection_Test outcome into the durable settings exactly as the
 * panel's Test-connection handler does: store the outcome reason
 * together with the fingerprint of the settings it was taken against.
 *
 * @param {import('../../sync-types.js').SyncState} syncState
 * @param {{ serverUrl: string|null, apiKey: string|null }} syncSettings
 * @param {('pass'|'auth'|'unreachable')} reason
 * @returns {void}
 */
function recordConnectionTest(syncState, syncSettings, reason) {
  setSettings(syncState, {
    connectionTest: reason,
    testedSettingsFingerprint: settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey),
  });
}

/**
 * The 401/403 auto-disable + needs-retest transition. Mirrors the
 * desktop `disableAutoSync({ needsRetest: true })` and the extension service
 * worker's background auto-disable: persist `autoSync:false`, flag the prior
 * test as an auth failure, and clear the tested fingerprint so the enable rule
 * demands a fresh pass.
 *
 * @param {import('../../sync-types.js').SyncState} syncState
 * @returns {void}
 */
function applyAuthAutoDisable(syncState) {
  setSettings(syncState, {
    autoSync: false,
    connectionTest: 'auth',
    testedSettingsFingerprint: null,
  });
}

// ─── Mocked fetch (mirrors connection-test.test.js conventions) ───────────────

const originalFetch = globalThis.fetch;

/** Installs a mock fetch that delegates to `handler`. */
function mockFetch(handler) {
  globalThis.fetch = async (url, options) => handler(url, options);
}

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SERVER = 'https://sync.test';
const KEY = 'secret-key';

/** A syncSettings snapshot, as the panel holds it in memory. */
function settingsFor(serverUrl, apiKey = null) {
  return { serverUrl, apiKey };
}

/**
 * Seed a SyncState carrying a PASSING Connection_Test for the given settings, so
 * the enable rule is satisfied. Built through the real store helpers so the
 * shape is exactly production's.
 */
function seedPassed(syncSettings, overrides = {}) {
  const state = createEmptySyncState();
  setSettings(state, {
    connectionTest: 'pass',
    testedSettingsFingerprint: settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey),
    ...overrides,
  });
  return state;
}

// ─── reconciliation-policy toggles render & persist ───────────

describe('Auto-Accept policy toggles render with seeded settings', () => {
  it('both toggles default OFF on a fresh state', () => {
    const state = createEmptySyncState();
    assert.deepEqual(renderPolicyToggles(state), {
      autoAcceptUpdatesChecked: false,
      autoAcceptDeletionsChecked: false,
    });
  });

  it('renders each toggle independently from the seeded settings', () => {
    const updatesOnly = createEmptySyncState();
    setSettings(updatesOnly, { autoAcceptUpdates: true });
    assert.deepEqual(renderPolicyToggles(updatesOnly), {
      autoAcceptUpdatesChecked: true,
      autoAcceptDeletionsChecked: false,
    });

    const deletionsOnly = createEmptySyncState();
    setSettings(deletionsOnly, { autoAcceptDeletions: true });
    assert.deepEqual(renderPolicyToggles(deletionsOnly), {
      autoAcceptUpdatesChecked: false,
      autoAcceptDeletionsChecked: true,
    });

    const both = createEmptySyncState();
    setSettings(both, { autoAcceptUpdates: true, autoAcceptDeletions: true });
    assert.deepEqual(renderPolicyToggles(both), {
      autoAcceptUpdatesChecked: true,
      autoAcceptDeletionsChecked: true,
    });
  });

  it('toggling a policy setting persists it without touching the other', () => {
    const state = createEmptySyncState();

    // Turn Auto-Accept-Updates ON (the toggle's change handler).
    setSettings(state, { autoAcceptUpdates: true });
    assert.equal(getSettings(state).autoAcceptUpdates, true);
    assert.equal(getSettings(state).autoAcceptDeletions, false);

    // Turn Auto-Accept-Deletions ON; the first stays ON.
    setSettings(state, { autoAcceptDeletions: true });
    assert.equal(getSettings(state).autoAcceptUpdates, true);
    assert.equal(getSettings(state).autoAcceptDeletions, true);

    // Turn Auto-Accept-Updates back OFF; deletions unaffected.
    setSettings(state, { autoAcceptUpdates: false });
    assert.equal(getSettings(state).autoAcceptUpdates, false);
    assert.equal(getSettings(state).autoAcceptDeletions, true);
  });

  it('policy toggles are independent of Auto-Sync (a policy toggle never enables Auto-Sync)', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const state = createEmptySyncState();
    setSettings(state, { autoAcceptUpdates: true, autoAcceptDeletions: true });

    // No Connection_Test recorded, so Auto-Sync stays not-enableable.
    assert.equal(canEnableAutoSync(syncSettings, state), false);
    assert.equal(renderAutoSyncControls(syncSettings, state).toggleDisabled, true);
  });
});

// ─── Auto-Sync enable rule ───────────────────────────────────

describe('Auto-Sync enable rule', () => {
  it('is not enableable without an endpoint, even with a stored pass', () => {
    const noEndpoint = settingsFor('', null);
    // A pass on record but no endpoint configured now.
    const state = createEmptySyncState();
    setSettings(state, {
      connectionTest: 'pass',
      testedSettingsFingerprint: settingsFingerprint('', null),
    });
    assert.equal(canEnableAutoSync(noEndpoint, state), false);

    const controls = renderAutoSyncControls(noEndpoint, state);
    assert.equal(controls.toggleDisabled, true);
    assert.equal(controls.testButtonDisabled, true, 'no endpoint → test button disabled');
  });

  it('is not enableable with an endpoint but no passing test', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const untested = createEmptySyncState();
    assert.equal(canEnableAutoSync(syncSettings, untested), false);

    for (const reason of ['auth', 'unreachable']) {
      const failed = createEmptySyncState();
      recordConnectionTest(failed, syncSettings, reason);
      assert.equal(
        canEnableAutoSync(syncSettings, failed),
        false,
        `a '${reason}' result must not enable Auto-Sync`,
      );
    }
  });

  it('is enableable with an endpoint AND a passing test for the current settings', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const state = seedPassed(syncSettings);
    assert.equal(canEnableAutoSync(syncSettings, state), true);

    const controls = renderAutoSyncControls(syncSettings, state);
    assert.equal(controls.toggleDisabled, false, 'enableable → toggle interactive');
    assert.equal(controls.testButtonDisabled, false);
  });

  it('a pass recorded against DIFFERENT settings does not count (stale fingerprint)', () => {
    const tested = settingsFor(SERVER, KEY);
    const state = seedPassed(tested); // passed for (SERVER, KEY)

    // The endpoint changed since the test — the stored fingerprint no longer matches.
    assert.equal(canEnableAutoSync(settingsFor('https://other.test', KEY), state), false);
    // The API key changed since the test — same outcome.
    assert.equal(canEnableAutoSync(settingsFor(SERVER, 'different-key'), state), false);
    // Unchanged settings still count.
    assert.equal(canEnableAutoSync(tested, state), true);
  });

  it('enable rule holds across arbitrary endpoint/key combinations (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          serverUrl: fc.webUrl(),
          apiKey: fc.option(fc.string(), { nil: null }),
        }),
        fc.constantFrom('pass', 'auth', 'unreachable', null),
        fc.boolean(),
        (tested, reason, settingsDrift) => {
          const state = createEmptySyncState();
          if (reason) recordConnectionTest(state, tested, reason);

          // Optionally drift the API key so the fingerprint no longer matches.
          const current = settingsDrift
            ? settingsFor(tested.serverUrl, `${tested.apiKey ?? ''}-drift`)
            : tested;

          const expected = !!current.serverUrl && reason === 'pass' && !settingsDrift; // a drift makes the stored fingerprint stale
          assert.equal(canEnableAutoSync(current, state), expected);
        },
      ),
    );
  });
});

// ─── a settings change invalidates a prior pass ───────────────────────

describe('Server-settings change invalidates a prior pass and disables Auto-Sync', () => {
  it('changing the endpoint forces Auto-Sync OFF and clears the test', () => {
    const prev = settingsFor(SERVER, KEY);
    const state = seedPassed(prev, { autoSync: true });
    assert.equal(canEnableAutoSync(prev, state), true);

    const next = settingsFor('https://moved.test', KEY);
    applyServerSettingsChange(state, prev, next);

    const settings = getSettings(state);
    assert.equal(settings.autoSync, false, 'Auto-Sync disabled on a settings change');
    assert.equal(settings.connectionTest, null, 'prior test invalidated');
    assert.equal(settings.testedSettingsFingerprint, null);
    assert.equal(canEnableAutoSync(next, state), false, 'not re-enableable until a fresh pass');
  });

  it('changing the plaintext API key forces Auto-Sync OFF', () => {
    const prev = settingsFor(SERVER, KEY);
    const state = seedPassed(prev, { autoSync: true });

    const next = settingsFor(SERVER, 'rotated-key');
    applyServerSettingsChange(state, prev, next);

    assert.equal(getSettings(state).autoSync, false);
    assert.equal(canEnableAutoSync(next, state), false);
  });

  it('saving the SAME settings leaves a prior pass intact (no spurious invalidation)', () => {
    const prev = settingsFor(SERVER, KEY);
    const state = seedPassed(prev, { autoSync: true });

    // Same values re-supplied as fresh strings (mirrors a re-decrypted key across
    // a restart) — the fingerprint is unchanged, so nothing is invalidated.
    const next = settingsFor(['https://', 'sync.test'].join(''), ['secret', '-key'].join(''));
    applyServerSettingsChange(state, prev, next);

    const settings = getSettings(state);
    assert.equal(settings.autoSync, true, 'unchanged settings keep Auto-Sync active');
    assert.equal(settings.connectionTest, 'pass');
    assert.equal(canEnableAutoSync(next, state), true);
  });
});

// ─── hidden Sync button + active status indicator ─────

describe('Manual Sync button + Auto-Sync active indicator', () => {
  it('while Auto-Sync is OFF: manual button shown (endpoint-gated), no active indicator', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const state = seedPassed(syncSettings); // enableable but not yet on

    const button = renderSyncButton(syncSettings, state);
    assert.equal(button.hidden, false, 'manual Sync button is shown while Auto-Sync is OFF');
    assert.equal(button.disabled, false, 'enabled — endpoint present, not syncing');

    const controls = renderAutoSyncControls(syncSettings, state);
    assert.equal(controls.statusIndicatorHidden, true, 'no active indicator while OFF');
    assert.equal(controls.toggleChecked, false);
  });

  it('while Auto-Sync is ACTIVE: manual button hidden, active indicator shown', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const state = seedPassed(syncSettings, { autoSync: true });

    const button = renderSyncButton(syncSettings, state);
    assert.equal(button.hidden, true, 'manual Sync button hidden while active');
    assert.equal(button.disabled, true, 'disabled while active — no manual force-sync affordance');

    const controls = renderAutoSyncControls(syncSettings, state);
    assert.equal(controls.statusIndicatorHidden, false, 'active indicator shown');
    assert.equal(controls.toggleChecked, true);
    assert.equal(controls.toggleDisabled, false, 'an active toggle stays interactive to turn off');
  });

  it('the manual button stays disabled while a manual sync is in flight (OFF)', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const state = seedPassed(syncSettings);
    assert.equal(renderSyncButton(syncSettings, state, true).disabled, true);
  });

  it('with no endpoint, the manual button is shown but disabled (OFF)', () => {
    const syncSettings = settingsFor('', null);
    const state = createEmptySyncState();
    const button = renderSyncButton(syncSettings, state);
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, true, 'no endpoint → manual button disabled');
  });
});

// ─── 401/403 auto-disable + needs-retest ─────────────────────────────

describe('401/403 auto-disable forces OFF + needs-retest', () => {
  it('disables Auto-Sync, flags auth, and blocks re-enable until a fresh pass', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const state = seedPassed(syncSettings, { autoSync: true });
    assert.equal(getSettings(state).autoSync, true);

    // A background cycle got a 401/403.
    applyAuthAutoDisable(state);

    const settings = getSettings(state);
    assert.equal(settings.autoSync, false, 'auto-disabled');
    assert.equal(settings.connectionTest, 'auth', 'flagged for re-test');
    assert.equal(settings.testedSettingsFingerprint, null, 'prior fingerprint cleared');
    assert.equal(
      canEnableAutoSync(syncSettings, state),
      false,
      'not re-enableable on the same bad credentials until a fresh pass',
    );

    // The active indicator is gone; the manual button is back.
    assert.equal(renderAutoSyncControls(syncSettings, state).statusIndicatorHidden, true);
    assert.equal(renderSyncButton(syncSettings, state).hidden, false);
  });

  it('a fresh passing test after an auth disable re-enables the rule', () => {
    const syncSettings = settingsFor(SERVER, KEY);
    const state = seedPassed(syncSettings, { autoSync: true });
    applyAuthAutoDisable(state);
    assert.equal(canEnableAutoSync(syncSettings, state), false);

    // User fixes the key and re-tests successfully against the (now correct) settings.
    const fixed = settingsFor(SERVER, 'corrected-key');
    recordConnectionTest(state, fixed, 'pass');
    assert.equal(canEnableAutoSync(fixed, state), true, 'a fresh pass clears needs-retest');
  });
});

// ─── Connection_Test drives the state machine end-to-end ───────

describe('Connection_Test outcome drives the enable rule', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('a passing testConnection makes Auto-Sync enableable', async () => {
    const syncSettings = settingsFor(SERVER, KEY);
    mockFetch(() => makeResponse(200, []));

    const state = createEmptySyncState();
    const { reason } = await testConnection(syncSettings.serverUrl, syncSettings.apiKey);
    recordConnectionTest(state, syncSettings, reason);

    assert.equal(reason, 'pass');
    assert.equal(canEnableAutoSync(syncSettings, state), true);
  });

  it('an auth failure keeps Auto-Sync disabled and shows the failure on record', async () => {
    const syncSettings = settingsFor(SERVER, 'bad-key');
    mockFetch(() => makeResponse(401, null));

    const state = createEmptySyncState();
    const { reason } = await testConnection(syncSettings.serverUrl, syncSettings.apiKey);
    recordConnectionTest(state, syncSettings, reason);

    assert.equal(reason, 'auth');
    assert.equal(getSettings(state).connectionTest, 'auth');
    assert.equal(canEnableAutoSync(syncSettings, state), false);
  });

  it('an unreachable server keeps Auto-Sync disabled', async () => {
    const syncSettings = settingsFor(SERVER, KEY);
    mockFetch(() => makeResponse(500, null));

    const state = createEmptySyncState();
    const { reason } = await testConnection(syncSettings.serverUrl, syncSettings.apiKey);
    recordConnectionTest(state, syncSettings, reason);

    assert.equal(reason, 'unreachable');
    assert.equal(canEnableAutoSync(syncSettings, state), false);
  });
});

// ─── Scheduler reflects the enable/disable lifecycle ──────────
//
// The Auto-Sync state machine arms the shared Sync_Trigger/scheduler when the
// setting becomes active and tears it down when it goes off. These assert the
// scheduler honors that start/stop lifecycle (the trigger mechanism the state
// machine drives); coalescing details are covered by sync-scheduler.test.js.

describe('Auto-Sync state machine arms/disarms the shared scheduler', () => {
  it('a disabled scheduler ignores triggers; starting it lets a cycle dispatch', () => {
    let cycles = 0;
    const sched = createSyncScheduler({ cooldownMs: 0, now: () => 1000 });

    // OFF (state machine has not armed it): triggers are ignored.
    assert.equal(sched.isActive(), false);
    assert.equal(sched.notify(), 'disabled');

    // Auto-Sync becomes active → the panel arms the scheduler.
    sched.start(() => {
      cycles += 1;
    });
    assert.equal(sched.isActive(), true);
    assert.equal(sched.notify(), 'dispatched');
    assert.equal(cycles, 1);

    // Auto-Sync turned OFF (or auth auto-disable) → the panel stops it.
    sched.stop();
    assert.equal(sched.isActive(), false);
    assert.equal(sched.notify(), 'disabled');
    assert.equal(cycles, 1, 'no further cycles after disable');
  });
});
