/**
 * adapter-chrome.test.js — Unit tests for the Chrome extension adapter
 *
 * Tests all methods of the chromeAdapter: loadSettings, saveSettings,
 * loadSyncSettings, saveSyncSettings, loadTheme, saveTheme,
 * loadRecordingMode, saveRecordingMode, loadReadingGuidance, loadSchema,
 * onPendingCountChange, onActionEvent, getPendingCount, and send.
 *
 * Mocks chrome.storage.local, chrome.storage.onChanged, chrome.runtime.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// ─── Chrome API mocks ─────────────────────────────────────────────────────────

let storageData = {};
let storageListeners = [];
let mockSendMessage;
let mockFetch;

function resetStorage() {
  storageData = {};
  storageListeners = [];
  // Restore the standard mock implementation
  globalThis.chrome.storage.local.get = mock.fn(async (keys) => {
    const keyArr = Array.isArray(keys) ? keys : [keys];
    const result = {};
    for (const k of keyArr) {
      if (k in storageData) result[k] = storageData[k];
    }
    return result;
  });
  globalThis.chrome.storage.local.set = mock.fn(async (obj) => {
    Object.assign(storageData, obj);
  });
  globalThis.chrome.storage.local.remove = mock.fn(async (keys) => {
    const keyArr = Array.isArray(keys) ? keys : [keys];
    for (const k of keyArr) {
      delete storageData[k];
    }
  });
}

globalThis.chrome = {
  storage: {
    local: {
      get: mock.fn(async (keys) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const k of keyArr) {
          if (k in storageData) result[k] = storageData[k];
        }
        return result;
      }),
      set: mock.fn(async (obj) => {
        Object.assign(storageData, obj);
      }),
      remove: mock.fn(async (keys) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keyArr) {
          delete storageData[k];
        }
      }),
    },
    onChanged: {
      addListener: (fn) => storageListeners.push(fn),
    },
  },
  runtime: {
    sendMessage: null,
    getURL: (path) => `chrome-extension://fake-id/${path}`,
  },
};

mockSendMessage = mock.fn(async () => ({}));
globalThis.chrome.runtime.sendMessage = mockSendMessage;

mockFetch = mock.fn(async () => ({ ok: true, text: async () => '', json: async () => ({}) }));
globalThis.fetch = mockFetch;

// Dynamic import after globals are set up
const { default: adapter } = await import('../../sidepanel/adapter-chrome.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('adapter.send()', () => {
  beforeEach(() => {
    mockSendMessage.mock.resetCalls();
  });

  it('delegates to chrome.runtime.sendMessage', async () => {
    mockSendMessage.mock.mockImplementation(async () => ({ ok: true }));
    const result = await adapter.send({ type: 'GET_STATE' });
    assert.deepEqual(result, { ok: true });
    assert.equal(mockSendMessage.mock.calls.length, 1);
    assert.deepEqual(mockSendMessage.mock.calls[0].arguments[0], { type: 'GET_STATE' });
  });
});

describe('adapter.loadSettings()', () => {
  beforeEach(resetStorage);

  it('returns endpointUrl and apiKey from storage', async () => {
    storageData = { docentEndpointUrl: 'https://api.test', docentApiKey: 'key1' };
    const result = await adapter.loadSettings();
    assert.equal(result.endpointUrl, 'https://api.test');
    assert.equal(result.apiKey, 'key1');
  });

  it('returns nulls when storage is empty', async () => {
    const result = await adapter.loadSettings();
    assert.equal(result.endpointUrl, null);
    assert.equal(result.apiKey, null);
  });

  it('returns nulls when storage.get throws', async () => {
    const originalGet = globalThis.chrome.storage.local.get;
    globalThis.chrome.storage.local.get = mock.fn(async () => {
      throw new Error('quota exceeded');
    });
    const result = await adapter.loadSettings();
    assert.equal(result.endpointUrl, null);
    assert.equal(result.apiKey, null);
    // Restore
    globalThis.chrome.storage.local.get = originalGet;
  });
});

describe('adapter.saveSettings()', () => {
  beforeEach(resetStorage);

  it('saves endpointUrl and apiKey to storage', async () => {
    await adapter.saveSettings('https://api.test', 'secret');
    assert.equal(storageData.docentEndpointUrl, 'https://api.test');
    assert.equal(storageData.docentApiKey, 'secret');
  });

  it('removes keys when values are empty strings', async () => {
    storageData = { docentEndpointUrl: 'old', docentApiKey: 'old' };
    await adapter.saveSettings('', '');
    assert.equal(storageData.docentEndpointUrl, undefined);
    assert.equal(storageData.docentApiKey, undefined);
  });

  it('throws for invalid URL', async () => {
    await assert.rejects(() => adapter.saveSettings('ftp://bad', 'key'), /http/i);
  });
});

describe('adapter.loadSyncSettings()', () => {
  beforeEach(resetStorage);

  it('returns serverUrl and apiKey from storage', async () => {
    storageData = { docentSyncUrl: 'https://sync.test', docentSyncApiKey: 'sk' };
    const result = await adapter.loadSyncSettings();
    assert.equal(result.serverUrl, 'https://sync.test');
    assert.equal(result.apiKey, 'sk');
  });

  it('returns nulls when storage is empty', async () => {
    const result = await adapter.loadSyncSettings();
    assert.equal(result.serverUrl, null);
    assert.equal(result.apiKey, null);
  });
});

describe('adapter.saveSyncSettings()', () => {
  beforeEach(resetStorage);

  it('saves sync URL and apiKey', async () => {
    await adapter.saveSyncSettings('https://sync.test', 'key');
    assert.equal(storageData.docentSyncUrl, 'https://sync.test');
    assert.equal(storageData.docentSyncApiKey, 'key');
  });

  it('clears both keys when serverUrl is empty', async () => {
    storageData = { docentSyncUrl: 'old', docentSyncApiKey: 'old' };
    await adapter.saveSyncSettings('', '');
    assert.equal(storageData.docentSyncUrl, undefined);
    assert.equal(storageData.docentSyncApiKey, undefined);
  });

  it('throws for invalid URL', async () => {
    await assert.rejects(() => adapter.saveSyncSettings('not-a-url', 'key'), /http/i);
  });
});

describe('adapter.loadTheme()', () => {
  beforeEach(resetStorage);

  it('returns theme from storage', async () => {
    storageData = { docentTheme: 'dark' };
    const result = await adapter.loadTheme();
    assert.equal(result, 'dark');
  });

  it('returns auto when not set', async () => {
    const result = await adapter.loadTheme();
    assert.equal(result, 'auto');
  });
});

describe('adapter.saveTheme()', () => {
  beforeEach(resetStorage);

  it('saves theme to storage', async () => {
    await adapter.saveTheme('dark');
    assert.equal(storageData.docentTheme, 'dark');
  });
});

describe('adapter.loadRecordingMode()', () => {
  beforeEach(resetStorage);

  it('returns recording mode from storage', async () => {
    storageData = { docentRecordingMode: 'simple' };
    const result = await adapter.loadRecordingMode();
    assert.equal(result, 'simple');
  });

  it('returns narration when not set', async () => {
    const result = await adapter.loadRecordingMode();
    assert.equal(result, 'narration');
  });
});

describe('adapter.saveRecordingMode()', () => {
  beforeEach(resetStorage);

  it('saves recording mode to storage', async () => {
    await adapter.saveRecordingMode('simple');
    assert.equal(storageData.docentRecordingMode, 'simple');
  });
});

describe('adapter.loadReadingGuidance()', () => {
  beforeEach(() => mockFetch.mock.resetCalls());

  it('returns text content on success', async () => {
    mockFetch.mock.mockImplementation(async () => ({
      ok: true,
      text: async () => '# Guidance\n\nContent here.',
    }));
    const result = await adapter.loadReadingGuidance();
    assert.equal(result, '# Guidance\n\nContent here.');
  });

  it('returns empty string on fetch failure', async () => {
    mockFetch.mock.mockImplementation(async () => ({ ok: false, status: 404 }));
    const result = await adapter.loadReadingGuidance();
    assert.equal(result, '');
  });

  it('returns empty string when fetch throws', async () => {
    mockFetch.mock.mockImplementation(async () => {
      throw new Error('Network error');
    });
    const result = await adapter.loadReadingGuidance();
    assert.equal(result, '');
  });
});

describe('adapter.loadSchema()', () => {
  beforeEach(() => mockFetch.mock.resetCalls());

  it('returns parsed JSON on success', async () => {
    const schema = { type: 'object' };
    mockFetch.mock.mockImplementation(async () => ({
      ok: true,
      json: async () => schema,
    }));
    const result = await adapter.loadSchema();
    assert.deepEqual(result, schema);
  });

  it('returns empty object on failure', async () => {
    mockFetch.mock.mockImplementation(async () => ({ ok: false, status: 500 }));
    const result = await adapter.loadSchema();
    assert.deepEqual(result, {});
  });

  it('returns empty object when fetch throws', async () => {
    mockFetch.mock.mockImplementation(async () => {
      throw new Error('Network error');
    });
    const result = await adapter.loadSchema();
    assert.deepEqual(result, {});
  });
});

describe('adapter.onPendingCountChange()', () => {
  it('fires callback when pendingCount changes in storage', () => {
    let received = null;
    adapter.onPendingCountChange((count) => {
      received = count;
    });

    // Simulate storage change
    for (const listener of storageListeners) {
      listener({ pendingCount: { newValue: 5 } }, 'local');
    }

    assert.equal(received, 5);
  });

  it('fires callback with 0 when pendingCount newValue is undefined', () => {
    let received = null;
    adapter.onPendingCountChange((count) => {
      received = count;
    });

    for (const listener of storageListeners) {
      listener({ pendingCount: { newValue: undefined } }, 'local');
    }

    assert.equal(received, 0);
  });

  it('does not fire for non-local area changes', () => {
    let received = null;
    adapter.onPendingCountChange((count) => {
      received = count;
    });

    for (const listener of storageListeners) {
      listener({ pendingCount: { newValue: 99 } }, 'sync');
    }

    // Should not have fired (area is 'sync', not 'local')
    assert.equal(received, null);
  });
});

describe('adapter.onActionEvent()', () => {
  it('fires callback for each new action added to pendingActions', () => {
    const received = [];
    adapter.onActionEvent((action) => {
      received.push(action);
    });

    // Simulate first batch of actions
    for (const listener of storageListeners) {
      listener(
        {
          pendingActions: {
            newValue: [
              { type: 'click', timestamp: 1000, element: { text: 'A' } },
              { type: 'type', timestamp: 2000, element: { text: 'B' }, value: 'hi' },
            ],
          },
        },
        'local',
      );
    }

    assert.equal(received.length, 2);
    assert.equal(received[0].type, 'click');
    assert.equal(received[1].type, 'type');
  });

  it('fires only for newly added actions (not existing ones)', () => {
    const received = [];
    adapter.onActionEvent((action) => {
      received.push(action);
    });

    // First update: 1 action
    for (const listener of storageListeners) {
      listener({ pendingActions: { newValue: [{ type: 'click', timestamp: 1000 }] } }, 'local');
    }

    const countAfterFirst = received.length;

    // Second update: 2 actions (1 existing + 1 new)
    for (const listener of storageListeners) {
      listener(
        {
          pendingActions: {
            newValue: [
              { type: 'click', timestamp: 1000 },
              { type: 'scroll', timestamp: 2000 },
            ],
          },
        },
        'local',
      );
    }

    // Should only have fired for the new action
    assert.equal(received.length - countAfterFirst, 1);
    assert.equal(received[received.length - 1].type, 'scroll');
  });
});

describe('adapter.getPendingCount()', () => {
  beforeEach(resetStorage);

  it('returns pendingCount from storage', async () => {
    storageData = { pendingCount: 7 };
    const count = await adapter.getPendingCount();
    assert.equal(count, 7);
  });

  it('returns 0 when not set', async () => {
    const count = await adapter.getPendingCount();
    assert.equal(count, 0);
  });
});

describe('adapter.hasNativeFileDialog', () => {
  it('is false for the Chrome extension', () => {
    assert.equal(adapter.hasNativeFileDialog, false);
  });
});
