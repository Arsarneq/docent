/**
 * service-worker-navigation.test.js — The service worker's navigation proxy,
 * driven through its registered listeners.
 *
 * The navigation decision rules are unit-tested in navigation-logic.test.js;
 * this suite drives the worker's own webNavigation.onCommitted and
 * tabs.onCreated listeners to hold what the worker owns around those rules:
 * the duplicate check against the last-URL marker read inside its write queue
 * (core capture-principles CP-9 — at most one proxy per user action), the
 * marker written from the normalised URL, its self-clear (extension runtime
 * ERT-3, the `lastTabNavUrl` row), the reload exemption keyed on the classified
 * nav type, the new-tab link path that appends with no duplicate check and
 * no marker, and a dropped append advancing no marker (#127 review). No
 * end-to-end spec repeats a non-reload URL, so these cases are where the
 * duplicate check is exercised.
 *
 * Approach: fake `chrome.*` globals with an in-memory `storage.local` are
 * installed BEFORE the worker is imported, and the onCommitted and onCreated
 * listeners it registers are captured and called directly. Node's mock timers
 * (`setTimeout` and `Date`) are enabled before the import too, so the 5 s
 * marker clear and the 100 ms new-tab window run on a clock the cases advance.
 * The clock starts away from zero so no commit falls inside a new-tab window
 * by accident.
 *
 * Uses the Node.js built-in test runner.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });

const storageData = {};
let onCommitted = null;
let onCreated = null;
let onMessage = null;
// Set to make the next pendingActions write fail with a quota error.
let failPendingWrite = false;

function getFrom(store, keys) {
  const keyArr = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
  const result = {};
  for (const k of keyArr) if (k in store) result[k] = store[k];
  return result;
}

const noListener = { addListener() {} };

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    onInstalled: noListener,
    onMessage: {
      addListener: (fn) => {
        onMessage = fn;
      },
    },
    getURL: (p) => p,
    sendMessage: async () => ({}),
  },
  action: { onClicked: noListener },
  storage: {
    local: {
      get: async (keys) => getFrom(storageData, keys),
      set: async (items) => {
        if (failPendingWrite && 'pendingActions' in items) {
          failPendingWrite = false;
          throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        }
        Object.assign(storageData, items);
      },
      // Usage reads as empty, so the worker's start-up pressure check leaves
      // capture unpaused; the stub must exist, or the re-evaluation after
      // STORAGE_RESUME cannot measure usage and the pause stays.
      getBytesInUse: async () => 0,
      remove: async (keys) => {
        for (const k of [].concat(keys)) delete storageData[k];
      },
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: noListener,
  },
  webNavigation: {
    onCompleted: noListener,
    onCommitted: {
      addListener: (fn) => {
        onCommitted = fn;
      },
    },
    onBeforeNavigate: noListener,
    getAllFrames: async () => [],
  },
  tabs: {
    onActivated: noListener,
    onCreated: {
      addListener: (fn) => {
        onCreated = fn;
      },
    },
    onRemoved: noListener,
    query: async () => [],
    get: async () => ({}),
  },
  scripting: { executeScript: async () => {} },
  alarms: { create() {}, clear() {}, onAlarm: noListener },
  sidePanel: { open: async () => {} },
};

// Module-scope listeners register on import.
await import('../../background/service-worker.js');

const TAB = 7;
const NEW_TAB = 9;

/** The navigate entries in the pending buffer. */
const navigates = () => (storageData.pendingActions ?? []).filter((a) => a.type === 'navigate');

/** Commit a main-frame navigation through the worker's listener. */
const commit = (url, transitionType, extra = {}) =>
  onCommitted({ frameId: 0, tabId: TAB, url, transitionType, transitionQualifiers: [], ...extra });

/** Send a runtime message to the worker's listener and await its response. */
const sendMessage = (message) => new Promise((resolve) => onMessage(message, {}, resolve));

/** Drain pending promise chains after a timer callback runs. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('service worker — navigation proxy through its registered listeners', () => {
  beforeEach(async () => {
    for (const k of Object.keys(storageData)) delete storageData[k];
    storageData.recording = true;
    // Leave any new-tab window an earlier case opened.
    mock.timers.tick(200);
    await flush();
  });

  it('records the same URL committed twice once', async () => {
    await commit('https://a.example/one', 'typed');
    await commit('https://a.example/one', 'typed');
    assert.equal(navigates().length, 1);
  });

  it('treats a trailing slash as the same URL, in either order', async () => {
    await commit('https://a.example/x/', 'typed');
    await commit('https://a.example/x', 'typed');
    await commit('https://a.example/x/', 'typed');
    assert.equal(navigates().length, 1);
  });

  it('records a reload of the last recorded URL', async () => {
    await commit('https://a.example/three', 'typed');
    await commit('https://a.example/three', 'reload');
    assert.equal(navigates().length, 2);
  });

  it('records a link commit in a just-opened tab with nav_type link and no marker', async () => {
    await onCreated({ id: NEW_TAB, url: '' });
    await commit('https://a.example/four', 'link', { tabId: NEW_TAB });
    const navs = navigates();
    assert.equal(navs.length, 1);
    assert.equal(navs[0].nav_type, 'link');
    assert.equal('lastTabNavUrl' in storageData, false);
  });

  it('does not deduplicate the new-tab link commit against the marker', async () => {
    storageData.lastTabNavUrl = 'https://a.example/four';
    await onCreated({ id: NEW_TAB, url: '' });
    await commit('https://a.example/four', 'link', { tabId: NEW_TAB });
    assert.equal(navigates().length, 1);
  });

  it('deduplicates a forward_back-qualified reload (the exemption keys on the nav type)', async () => {
    await commit('https://a.example/five', 'typed');
    await commit('https://a.example/five', 'reload', { transitionQualifiers: ['forward_back'] });
    assert.equal(navigates().length, 1);
  });

  it('clears the marker after 5 s, not before', async () => {
    await commit('https://a.example/six/', 'typed');
    mock.timers.tick(4900);
    await flush();
    await commit('https://a.example/six', 'typed');
    assert.equal(navigates().length, 1);
    mock.timers.tick(200);
    await flush();
    await commit('https://a.example/six', 'typed');
    assert.equal(navigates().length, 2);
  });

  it('advances no marker when the append is dropped, so a re-navigation records', async () => {
    // A quota failure drops the navigation and pauses capture; the marker must
    // stay unset, or the re-navigation would be skipped as a phantom duplicate.
    // STORAGE_RESUME lifts the pause, so the re-navigation is appended.
    failPendingWrite = true;
    await commit('https://a.example/ten', 'typed');
    assert.equal(navigates().length, 0);
    assert.equal('lastTabNavUrl' in storageData, false);
    assert.deepEqual(await sendMessage({ type: 'STORAGE_RESUME' }), { ok: true });
    await commit('https://a.example/ten', 'typed');
    assert.equal(navigates().length, 1);
  });
});
