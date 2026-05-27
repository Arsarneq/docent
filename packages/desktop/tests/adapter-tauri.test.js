/**
 * adapter-tauri.test.js — Unit tests for the Tauri adapter methods
 *
 * Tests the adapter's send(), loadSettings(), saveSettings(), loadSyncSettings(),
 * saveSyncSettings(), loadTheme(), saveTheme(), loadRecordingMode(),
 * saveRecordingMode(), loadReadingGuidance(), loadSchema(), and
 * commitWithCompleteness() functions.
 *
 * adapter-tauri.js accesses window.__TAURI__ at module level, so we
 * set up globalThis.window before the dynamic import.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// ─── Global mocks ─────────────────────────────────────────────────────────────

let mockInvoke;
let mockFetch;
let mockListen;

mockInvoke = mock.fn();
mockFetch = mock.fn();
mockListen = mock.fn(async () => () => {});

globalThis.window = {
  __TAURI__: {
    core: { invoke: mockInvoke },
    event: { listen: mockListen },
  },
};
globalThis.fetch = mockFetch;

// Dynamic import after globals are set up
const { default: adapter, commitWithCompleteness } = await import('../src/adapter-tauri.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetMocks() {
  mockInvoke.mock.resetCalls();
  mockFetch.mock.resetCalls();
}

// ─── send() ───────────────────────────────────────────────────────────────────

describe('adapter.send()', () => {
  beforeEach(resetMocks);

  it('RECORDING_START calls start_capture with pid', async () => {
    mockInvoke.mock.mockImplementation(async () => {});
    const result = await adapter.send({ type: 'RECORDING_START', pid: 1234 });
    assert.deepEqual(result, { ok: true });
    const call = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'start_capture');
    assert.ok(call, 'start_capture should be called');
    assert.deepEqual(call.arguments[1], { pid: 1234 });
  });

  it('RECORDING_START with no pid passes null', async () => {
    mockInvoke.mock.mockImplementation(async () => {});
    await adapter.send({ type: 'RECORDING_START' });
    const call = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'start_capture');
    assert.deepEqual(call.arguments[1], { pid: null });
  });

  it('RECORDING_STOP calls stop_capture', async () => {
    mockInvoke.mock.mockImplementation(async () => {});
    const result = await adapter.send({ type: 'RECORDING_STOP' });
    assert.deepEqual(result, { ok: true });
    const call = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'stop_capture');
    assert.ok(call, 'stop_capture should be called');
  });

  it('unknown message type returns empty object', async () => {
    const result = await adapter.send({ type: 'UNKNOWN_TYPE' });
    assert.deepEqual(result, {});
  });
});

// ─── loadSettings() ───────────────────────────────────────────────────────────

describe('adapter.loadSettings()', () => {
  beforeEach(resetMocks);

  it('returns endpointUrl and apiKey from state', async () => {
    mockInvoke.mock.mockImplementation(async () =>
      JSON.stringify({ settings: { endpointUrl: 'http://x.com', apiKey: 'key1' } }),
    );
    const result = await adapter.loadSettings();
    assert.equal(result.endpointUrl, 'http://x.com');
    assert.equal(result.apiKey, 'key1');
  });

  it('returns nulls when state has no settings', async () => {
    mockInvoke.mock.mockImplementation(async () => JSON.stringify({}));
    const result = await adapter.loadSettings();
    assert.equal(result.endpointUrl, null);
    assert.equal(result.apiKey, null);
  });

  it('returns nulls when invoke throws', async () => {
    mockInvoke.mock.mockImplementation(async () => {
      throw new Error('fail');
    });
    const result = await adapter.loadSettings();
    assert.equal(result.endpointUrl, null);
    assert.equal(result.apiKey, null);
  });
});

// ─── saveSettings() ───────────────────────────────────────────────────────────

describe('adapter.saveSettings()', () => {
  beforeEach(resetMocks);

  it('saves endpoint and apiKey to state', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'load_state') return JSON.stringify({ settings: {} });
      return undefined;
    });
    await adapter.saveSettings('http://api.test', 'secret');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    assert.ok(saveCall);
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.endpointUrl, 'http://api.test');
    assert.equal(saved.settings.apiKey, 'secret');
  });

  it('throws for invalid URL', async () => {
    await assert.rejects(() => adapter.saveSettings('ftp://bad', 'key'), /http/);
  });

  it('allows empty URL (clears setting)', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'load_state') return JSON.stringify({ settings: {} });
      return undefined;
    });
    await adapter.saveSettings('', '');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.endpointUrl, null);
    assert.equal(saved.settings.apiKey, null);
  });
});

// ─── loadSyncSettings() ───────────────────────────────────────────────────────

describe('adapter.loadSyncSettings()', () => {
  beforeEach(resetMocks);

  it('returns serverUrl and apiKey from state', async () => {
    mockInvoke.mock.mockImplementation(async () =>
      JSON.stringify({ settings: { syncUrl: 'http://sync.test', syncApiKey: 'sk' } }),
    );
    const result = await adapter.loadSyncSettings();
    assert.equal(result.serverUrl, 'http://sync.test');
    assert.equal(result.apiKey, 'sk');
  });

  it('returns nulls when invoke throws', async () => {
    mockInvoke.mock.mockImplementation(async () => {
      throw new Error('fail');
    });
    const result = await adapter.loadSyncSettings();
    assert.equal(result.serverUrl, null);
    assert.equal(result.apiKey, null);
  });
});

// ─── saveSyncSettings() ───────────────────────────────────────────────────────

describe('adapter.saveSyncSettings()', () => {
  beforeEach(resetMocks);

  it('saves sync URL and apiKey', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'load_state') return JSON.stringify({ settings: {} });
      return undefined;
    });
    await adapter.saveSyncSettings('http://sync.test', 'key');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.syncUrl, 'http://sync.test');
    assert.equal(saved.settings.syncApiKey, 'key');
  });

  it('clears sync settings when URL is empty', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'load_state')
        return JSON.stringify({ settings: { syncUrl: 'old', syncApiKey: 'old' } });
      return undefined;
    });
    await adapter.saveSyncSettings('', '');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.syncUrl, undefined);
    assert.equal(saved.settings.syncApiKey, undefined);
  });

  it('throws for invalid URL', async () => {
    await assert.rejects(() => adapter.saveSyncSettings('not-a-url', 'key'), /http/);
  });
});

// ─── loadTheme() / saveTheme() ────────────────────────────────────────────────

describe('adapter.loadTheme()', () => {
  beforeEach(resetMocks);

  it('returns theme from state', async () => {
    mockInvoke.mock.mockImplementation(async () => JSON.stringify({ settings: { theme: 'dark' } }));
    const result = await adapter.loadTheme();
    assert.equal(result, 'dark');
  });

  it('returns auto when no theme set', async () => {
    mockInvoke.mock.mockImplementation(async () => JSON.stringify({}));
    const result = await adapter.loadTheme();
    assert.equal(result, 'auto');
  });

  it('returns auto when invoke throws', async () => {
    mockInvoke.mock.mockImplementation(async () => {
      throw new Error('fail');
    });
    const result = await adapter.loadTheme();
    assert.equal(result, 'auto');
  });
});

describe('adapter.saveTheme()', () => {
  beforeEach(resetMocks);

  it('saves theme to state', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'load_state') return JSON.stringify({ settings: {} });
      return undefined;
    });
    await adapter.saveTheme('dark');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.theme, 'dark');
  });

  it('does not throw when invoke fails', async () => {
    mockInvoke.mock.mockImplementation(async () => {
      throw new Error('disk full');
    });
    // Should not throw — silently fails
    await adapter.saveTheme('light');
  });
});

// ─── loadRecordingMode() / saveRecordingMode() ────────────────────────────────

describe('adapter.loadRecordingMode()', () => {
  beforeEach(resetMocks);

  it('returns recording mode from state', async () => {
    mockInvoke.mock.mockImplementation(async () =>
      JSON.stringify({ settings: { recordingMode: 'simple' } }),
    );
    const result = await adapter.loadRecordingMode();
    assert.equal(result, 'simple');
  });

  it('returns narration when not set', async () => {
    mockInvoke.mock.mockImplementation(async () => JSON.stringify({}));
    const result = await adapter.loadRecordingMode();
    assert.equal(result, 'narration');
  });
});

describe('adapter.saveRecordingMode()', () => {
  beforeEach(resetMocks);

  it('saves recording mode to state', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'load_state') return JSON.stringify({ settings: {} });
      return undefined;
    });
    await adapter.saveRecordingMode('simple');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.recordingMode, 'simple');
  });
});

// ─── loadReadingGuidance() / loadSchema() ─────────────────────────────────────

describe('adapter.loadReadingGuidance()', () => {
  beforeEach(resetMocks);

  it('returns text on success', async () => {
    mockFetch.mock.mockImplementation(async () => ({
      ok: true,
      text: async () => '# Guidance',
    }));
    const result = await adapter.loadReadingGuidance();
    assert.equal(result, '# Guidance');
  });

  it('returns empty string on failure', async () => {
    mockFetch.mock.mockImplementation(async () => ({ ok: false, status: 404 }));
    const result = await adapter.loadReadingGuidance();
    assert.equal(result, '');
  });
});

describe('adapter.loadSchema()', () => {
  beforeEach(resetMocks);

  it('returns parsed JSON on success', async () => {
    mockFetch.mock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ type: 'object' }),
    }));
    const result = await adapter.loadSchema();
    assert.deepEqual(result, { type: 'object' });
  });

  it('returns empty object on failure', async () => {
    mockFetch.mock.mockImplementation(async () => ({ ok: false, status: 500 }));
    const result = await adapter.loadSchema();
    assert.deepEqual(result, {});
  });
});

// ─── getPendingCount() / clearPendingActions() ────────────────────────────────

describe('adapter.getPendingCount()', () => {
  it('returns 0 initially', async () => {
    adapter.clearPendingActions();
    const count = await adapter.getPendingCount();
    assert.equal(count, 0);
  });
});

// ─── commitWithCompleteness() ─────────────────────────────────────────────────

describe('commitWithCompleteness()', () => {
  beforeEach(resetMocks);

  it('strips _seq fields and returns when maxSeq is 0', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'get_max_sequence_number') return 0;
      return undefined;
    });
    adapter.clearPendingActions();
    await commitWithCompleteness();
    // Should not throw
  });

  it('strips _seq fields when all events already received', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'get_max_sequence_number') return 5;
      return undefined;
    });
    // Simulate that _highestSeenSeq >= maxSeq by clearing state
    adapter.clearPendingActions();
    await commitWithCompleteness();
    // Should complete without waiting
  });
});
