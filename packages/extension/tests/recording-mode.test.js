/**
 * recording-mode.test.js — Unit tests for recording mode persistence.
 *
 * Tests loadRecordingMode/saveRecordingMode on the Chrome adapter.
 * Uses Node.js built-in test runner.
 */

// ── Mock chrome.storage.local ──────────────────────────────────────────────
let storageData = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map(k => [k, storageData[k]]));
        }
        return { [keys]: storageData[keys] };
      },
      set: async (items) => { Object.assign(storageData, items); },
      remove: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        ks.forEach(k => delete storageData[k]);
      },
    },
    onChanged: {
      addListener: () => {},
    },
  },
  runtime: {
    getURL: (path) => `chrome-extension://test-id/${path}`,
  },
};

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import chromeAdapter from '../sidepanel/adapter-chrome.js';

describe('Recording mode persistence', () => {
  beforeEach(() => { storageData = {}; });

  test('loadRecordingMode returns "narration" by default', async () => {
    const mode = await chromeAdapter.loadRecordingMode();
    assert.strictEqual(mode, 'narration');
  });

  test('saveRecordingMode persists "simple" and loadRecordingMode retrieves it', async () => {
    await chromeAdapter.saveRecordingMode('simple');
    const mode = await chromeAdapter.loadRecordingMode();
    assert.strictEqual(mode, 'simple');
  });

  test('saveRecordingMode persists "narration" and loadRecordingMode retrieves it', async () => {
    await chromeAdapter.saveRecordingMode('narration');
    const mode = await chromeAdapter.loadRecordingMode();
    assert.strictEqual(mode, 'narration');
  });

  test('recording mode round-trip preserves value', async () => {
    for (const value of ['narration', 'simple']) {
      storageData = {};
      await chromeAdapter.saveRecordingMode(value);
      const loaded = await chromeAdapter.loadRecordingMode();
      assert.strictEqual(loaded, value, `Expected ${value}, got ${loaded}`);
    }
  });

  test('recording mode is independent of other settings', async () => {
    await chromeAdapter.saveSettings('http://localhost:3000', 'key123');
    await chromeAdapter.saveTheme('dark');
    await chromeAdapter.saveRecordingMode('simple');

    const mode = await chromeAdapter.loadRecordingMode();
    const theme = await chromeAdapter.loadTheme();
    const settings = await chromeAdapter.loadSettings();

    assert.strictEqual(mode, 'simple');
    assert.strictEqual(theme, 'dark');
    assert.strictEqual(settings.endpointUrl, 'http://localhost:3000');
  });
});
