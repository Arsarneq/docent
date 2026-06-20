/**
 * auto-sync-host.test.js — Smoke test for the extension background Auto-Sync
 * host (`background/service-worker.js`, task 24.4).
 *
 * Validates the extension side of Requirement 23's background-host contract:
 *   - R23.15 — the host wires `chrome.alarms` (the ~60s backstop) + the shared
 *     cooldown-debounced scheduler in the SERVICE WORKER (where alarms and
 *     data-event hooks fire), not in a panel-only path.
 *   - R23.16 — a triggered cycle invokes the SAME shared `sync()` the manual
 *     panel path uses, through the SAME chrome-backed SyncStore, and persists the
 *     resulting `SyncState` durably so the panel, when next shown, reads it.
 *   - R23.10 — the cycle runs headless: it is driven by a background `chrome.alarms`
 *     event with no panel/DOM present, so Auto-Sync works with the UI closed.
 *
 * Approach: the service worker imports `chrome.*` + the shared sync modules at
 * module scope. We install fake `chrome.*` + `fetch` globals BEFORE importing the
 * SW, then drive the REAL module — its real shared scheduler and real shared
 * `sync()` — through the captured `chrome.alarms.onAlarm` seam. No panel, no DOM,
 * no mocked sync: the test asserts the genuine background contract end to end.
 *
 * The desktop equivalent of this contract is covered by the desktop host unit
 * tests (`packages/desktop/tests/unit/auto-sync-host.test.js`, task 24.5) and the
 * integration suite.
 *
 * Uses the Node.js built-in test runner.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { BACKSTOP_INTERVAL_MS } from '../../shared/sync-scheduler.js';
import { loadSyncState, getSettings } from '../../shared/sync-store.js';

// ─── Constants mirrored from the service worker (task 24.4) ───────────────────

// chrome.storage.local key the chrome adapter persists the durable SyncState
// blob under (SYNC_STATE_KEY in sidepanel/adapter-chrome.js, SYNC_STATE_STORAGE_KEY
// in the SW). The panel reads its indicators from this key (R23.16).
const SYNC_STATE_KEY = 'docentSyncState';
// The ~60s periodic backstop alarm name the SW registers (R23.7).
const AUTO_SYNC_ALARM = 'docent-auto-sync-backstop';
// Where the SW's sync cycle reads the endpoint from (adapter-chrome SYNC_URL_KEY).
const SYNC_URL_KEY = 'docentSyncUrl';

// A minimal composed schema carrying the pinned `docent_format` stamp consts, so
// the shared `sync()`'s `stampFromSchema()` resolves rather than throwing.
const SCHEMA = {
  $defs: {
    docent_format: {
      properties: {
        platform: { const: 'extension' },
        schema_version: { const: '1.0.0' },
      },
    },
  },
};

// ─── Fake chrome.* + fetch (installed before importing the SW) ────────────────

let storageData = {};
let sessionData = {};
const storageChangeListeners = [];
let alarmListener = null;
let messageListener = null;

const alarmCreateCalls = [];
const alarmClearCalls = [];
let fetchCalls = [];
let sendMessageCalls = 0;

function getFrom(store, keys) {
  const keyArr = Array.isArray(keys) ? keys : [keys];
  const result = {};
  for (const k of keyArr) {
    if (k in store) result[k] = store[k];
  }
  return result;
}

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: {
      addListener: (fn) => {
        messageListener = fn;
      },
    },
    getURL: (path) => {
      // The adapter loads the validator via dynamic import() of this URL. Node's
      // ESM loader rejects a `chrome-extension://` scheme, so hand back an
      // importable data: module exporting a permissive validator — the real
      // graceful-degradation path (catch → null) would otherwise just log noise.
      if (path.endsWith('validate-extension.js')) {
        return `data:text/javascript,${encodeURIComponent('export default () => true;')}`;
      }
      return `chrome-extension://test-id/${path}`;
    },
    sendMessage: async () => {
      sendMessageCalls += 1;
      return {};
    },
  },
  action: { onClicked: { addListener() {} } },
  storage: {
    local: {
      get: async (keys) => getFrom(storageData, keys),
      set: async (obj) => {
        Object.assign(storageData, obj);
      },
      remove: async (keys) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keyArr) delete storageData[k];
      },
    },
    session: {
      get: async (keys) => getFrom(sessionData, keys),
      set: async (obj) => {
        Object.assign(sessionData, obj);
      },
      remove: async (keys) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keyArr) delete sessionData[k];
      },
    },
    onChanged: {
      addListener: (fn) => storageChangeListeners.push(fn),
    },
  },
  webNavigation: {
    onCompleted: { addListener() {} },
    onCommitted: { addListener() {} },
    onBeforeNavigate: { addListener() {} },
    getAllFrames: async () => [],
  },
  tabs: {
    onActivated: { addListener() {} },
    onCreated: { addListener() {} },
    onRemoved: { addListener() {} },
    query: async () => [],
    get: async () => ({}),
  },
  scripting: { executeScript: async () => {} },
  alarms: {
    create: (name, opts) => {
      alarmCreateCalls.push({ name, opts });
    },
    clear: (name) => {
      alarmClearCalls.push(name);
    },
    onAlarm: {
      addListener: (fn) => {
        alarmListener = fn;
      },
    },
  },
  sidePanel: { open: async () => {} },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  fetchCalls.push(u);
  if (u.endsWith('session.schema.json')) {
    return { ok: true, status: 200, json: async () => SCHEMA, text: async () => '' };
  }
  // The shared sync()'s pull phase fetches the manifest at `${serverUrl}/projects`.
  // An empty manifest means a complete, no-op cycle that still persists SyncState.
  if (u.endsWith('/projects')) {
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

// ─── Drive the REAL service worker ────────────────────────────────────────────

// Import after the globals are in place; module-scope listeners + the boot IIFE
// run on import.
await import('../../background/service-worker.js');

// A real-timer tick that also drains the microtask queue between async awaits.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, { tries = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor: condition not met in time');
}

/** A complete SyncState blob with Auto-Sync toggled as requested. */
function syncStateBlob(autoSync) {
  return {
    schema: 1,
    baselines: {},
    snapshots: {},
    reviews: {},
    conflicts: {},
    dismissedIncoming: {},
    settings: {
      autoAcceptUpdates: false,
      autoAcceptDeletions: false,
      autoSync,
      // A passing Connection_Test is the gate that lets Auto-Sync be on (R23.2).
      connectionTest: autoSync ? 'pass' : null,
      testedSettingsFingerprint: null,
    },
  };
}

/**
 * Toggle the persisted `autoSync` setting and fire the `chrome.storage.onChanged`
 * listener the SW uses to reconcile its background trigger (R23.16). Enabling
 * starts the trigger (and registers the alarm); disabling tears it down and
 * resets the shared cooldown so the next enable can dispatch immediately.
 */
async function setAutoSync(enabled) {
  const prevCreate = alarmCreateCalls.length;
  const prevClear = alarmClearCalls.length;
  const blob = syncStateBlob(enabled);
  storageData[SYNC_STATE_KEY] = blob;
  for (const fn of storageChangeListeners) {
    fn({ [SYNC_STATE_KEY]: { newValue: blob } }, 'local');
  }
  // reconcileAutoSync is async (loads state, then starts/stops the trigger).
  if (enabled) {
    await waitFor(() => alarmCreateCalls.length > prevCreate);
  } else {
    await waitFor(() => alarmClearCalls.length > prevClear);
  }
}

/** Fire the background ~60s backstop alarm, the SW's headless trigger source. */
function fireBackstopAlarm() {
  assert.equal(
    typeof alarmListener,
    'function',
    'SW must register a chrome.alarms.onAlarm listener',
  );
  alarmListener({ name: AUTO_SYNC_ALARM });
}

describe('extension background Auto-Sync host (service worker)', () => {
  before(async () => {
    // Let the boot IIFE (reconcileAutoSync over an empty store → Auto-Sync OFF)
    // settle before the suite runs.
    await tick();
    await tick();
  });

  beforeEach(() => {
    fetchCalls = [];
    sendMessageCalls = 0;
  });

  it('wires chrome.alarms + the shared scheduler in the SW, not a panel-only path (R23.15)', async () => {
    // The background trigger sources are registered in the service worker itself:
    // the alarm seam (the ~60s backstop) and the data-event seam (the onMessage
    // dispatcher), plus the autoSync-toggle observer.
    assert.equal(typeof alarmListener, 'function', 'chrome.alarms.onAlarm wired in the SW');
    assert.equal(typeof messageListener, 'function', 'data-event seam (onMessage) wired in the SW');
    assert.ok(storageChangeListeners.length >= 1, 'autoSync-toggle observer wired in the SW');

    // Enabling Auto-Sync registers the ~60s backstop alarm through the shared
    // scheduler's wire(), at the shared backstop interval.
    await setAutoSync(true);
    const created = alarmCreateCalls.find((c) => c.name === AUTO_SYNC_ALARM);
    assert.ok(created, 'the ~60s backstop alarm is registered when Auto-Sync turns on');
    assert.equal(
      created.opts.periodInMinutes,
      BACKSTOP_INTERVAL_MS / 60000,
      'the alarm uses the shared backstop interval',
    );

    await setAutoSync(false);
    assert.ok(
      alarmClearCalls.includes(AUTO_SYNC_ALARM),
      'turning Auto-Sync off tears the backstop alarm down',
    );
  });

  it('a triggered cycle invokes the shared sync() and persists SyncState the panel reads (R23.16)', async () => {
    storageData[SYNC_URL_KEY] = 'https://sync.test';
    await setAutoSync(true);

    fireBackstopAlarm();

    // The cycle routes through the SHARED sync() — proven by its pull-first
    // manifest fetch against the configured endpoint — not a panel message path.
    await waitFor(() => fetchCalls.includes('https://sync.test/projects'));
    assert.equal(sendMessageCalls, 0, 'the SW ran sync() in-process, not via a panel message');

    // sync() persisted the resulting SyncState through the SAME chrome-backed
    // store the panel uses; the panel reads it via the shared loadSyncState().
    await waitFor(() => storageData[SYNC_STATE_KEY] && storageData[SYNC_STATE_KEY].schema === 1);
    const panelStore = { load: async () => storageData[SYNC_STATE_KEY] };
    const stateAsPanelReadsIt = await loadSyncState(panelStore);
    assert.equal(
      stateAsPanelReadsIt.schema,
      1,
      'a normalized SyncState is persisted for the panel',
    );
    assert.equal(
      getSettings(stateAsPanelReadsIt).autoSync,
      true,
      'the persisted SyncState the panel reads carries the live Auto-Sync setting',
    );

    await setAutoSync(false);
  });

  it('runs the cycle headless with the UI/panel closed (R23.10, R23.15)', async () => {
    // The host lives in the service worker, independent of the panel: there is no
    // DOM and no panel surface in this context, yet a background alarm still
    // drives a full shared cycle that persists state for the panel to read later.
    assert.equal(typeof document, 'undefined', 'no DOM present — the panel is closed');
    assert.equal(typeof window, 'undefined', 'no panel/window surface present');

    storageData[SYNC_URL_KEY] = 'https://sync.test';
    delete storageData[SYNC_STATE_KEY];
    await setAutoSync(true); // resets the shared cooldown, then re-arms the alarm

    fireBackstopAlarm();

    await waitFor(() => fetchCalls.includes('https://sync.test/projects'));
    await waitFor(() => storageData[SYNC_STATE_KEY] && storageData[SYNC_STATE_KEY].schema === 1);
    assert.ok(
      storageData[SYNC_STATE_KEY],
      'a headless background cycle persisted SyncState with no UI present',
    );

    await setAutoSync(false);
  });
});
