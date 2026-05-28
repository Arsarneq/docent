/**
 * Unit tests for dispatch.js — Desktop dispatch service
 *
 * Tests desktop-specific functions: loadDispatchSettings, saveDispatchSettings,
 * loadReadingGuidance, and loadSchema.
 *
 * dispatch.js accesses window.__TAURI__.core.invoke at module level, so we
 * set up globalThis.window before the dynamic import.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// ─── Global mocks ─────────────────────────────────────────────────────────────

let mockInvoke;
let mockFetch;

// Set up globals before importing dispatch.js
mockInvoke = mock.fn();
mockFetch = mock.fn();

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: mockInvoke,
    },
  },
};
globalThis.fetch = mockFetch;

// Dynamic import after globals are set up
const { loadDispatchSettings, saveDispatchSettings, loadReadingGuidance, loadSchema } =
  await import('../../src/dispatch.js');

// ─── loadDispatchSettings() ───────────────────────────────────────────────────

describe('loadDispatchSettings()', () => {
  beforeEach(() => {
    mockInvoke.mock.resetCalls();
    mockFetch.mock.resetCalls();
  });

  it('returns { endpointUrl, apiKey } from saved state', async () => {
    const state = {
      settings: {
        endpointUrl: 'https://api.example.com',
        apiKey: 'my-secret-key',
      },
    };
    mockInvoke.mock.mockImplementation(async () => JSON.stringify(state));

    const result = await loadDispatchSettings();
    assert.strictEqual(result.endpointUrl, 'https://api.example.com');
    assert.strictEqual(result.apiKey, 'my-secret-key');
  });

  it('returns { null, null } when invoke throws', async () => {
    mockInvoke.mock.mockImplementation(async () => {
      throw new Error('File not found');
    });

    const result = await loadDispatchSettings();
    assert.strictEqual(result.endpointUrl, null);
    assert.strictEqual(result.apiKey, null);
  });

  it('returns { null, null } when state has no settings', async () => {
    const state = { projects: [] };
    mockInvoke.mock.mockImplementation(async () => JSON.stringify(state));

    const result = await loadDispatchSettings();
    assert.strictEqual(result.endpointUrl, null);
    assert.strictEqual(result.apiKey, null);
  });
});

// ─── saveDispatchSettings() ───────────────────────────────────────────────────

describe('saveDispatchSettings()', () => {
  beforeEach(() => {
    mockInvoke.mock.resetCalls();
    mockFetch.mock.resetCalls();
  });

  it('reads existing state, merges settings, saves back', async () => {
    const existingState = {
      projects: [{ project_id: 'p1' }],
      settings: { theme: 'dark' },
    };

    // First call: load_state returns existing state
    // Second call: save_state succeeds
    let callCount = 0;
    mockInvoke.mock.mockImplementation(async (cmd, args) => {
      callCount++;
      if (cmd === 'load_state') return JSON.stringify(existingState);
      if (cmd === 'save_state') return undefined;
      throw new Error(`Unexpected command: ${cmd}`);
    });

    await saveDispatchSettings('https://new-url.com', 'new-key');

    // Verify save_state was called
    const saveCalls = mockInvoke.mock.calls.filter((c) => c.arguments[0] === 'save_state');
    assert.strictEqual(saveCalls.length, 1);

    const savedData = JSON.parse(saveCalls[0].arguments[1].data);
    assert.strictEqual(savedData.settings.endpointUrl, 'https://new-url.com');
    assert.strictEqual(savedData.settings.apiKey, 'new-key');
    // Existing data preserved
    assert.deepStrictEqual(savedData.projects, [{ project_id: 'p1' }]);
  });

  it('creates fresh state when load fails', async () => {
    let callCount = 0;
    mockInvoke.mock.mockImplementation(async (cmd, args) => {
      callCount++;
      if (cmd === 'load_state') throw new Error('File not found');
      if (cmd === 'save_state') return undefined;
      throw new Error(`Unexpected command: ${cmd}`);
    });

    await saveDispatchSettings('https://url.com', 'key123');

    const saveCalls = mockInvoke.mock.calls.filter((c) => c.arguments[0] === 'save_state');
    assert.strictEqual(saveCalls.length, 1);

    const savedData = JSON.parse(saveCalls[0].arguments[1].data);
    assert.strictEqual(savedData.settings.endpointUrl, 'https://url.com');
    assert.strictEqual(savedData.settings.apiKey, 'key123');
    assert.deepStrictEqual(savedData.projects, []);
  });
});

// ─── loadReadingGuidance() ────────────────────────────────────────────────────

describe('loadReadingGuidance()', () => {
  beforeEach(() => {
    mockInvoke.mock.resetCalls();
    mockFetch.mock.resetCalls();
  });

  it('returns text content on success', async () => {
    mockFetch.mock.mockImplementation(async () => ({
      ok: true,
      text: async () => '# Reading Guidance\n\nSome content here.',
    }));

    const result = await loadReadingGuidance();
    assert.strictEqual(result, '# Reading Guidance\n\nSome content here.');
  });

  it('returns empty string on fetch failure', async () => {
    mockFetch.mock.mockImplementation(async () => ({
      ok: false,
      status: 404,
    }));

    const result = await loadReadingGuidance();
    assert.strictEqual(result, '');
  });

  it('returns empty string when fetch throws', async () => {
    mockFetch.mock.mockImplementation(async () => {
      throw new Error('Network error');
    });

    const result = await loadReadingGuidance();
    assert.strictEqual(result, '');
  });
});

// ─── loadSchema() ─────────────────────────────────────────────────────────────

describe('loadSchema()', () => {
  beforeEach(() => {
    mockInvoke.mock.resetCalls();
    mockFetch.mock.resetCalls();
  });

  it('returns parsed JSON on success', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    mockFetch.mock.mockImplementation(async () => ({
      ok: true,
      json: async () => schema,
    }));

    const result = await loadSchema();
    assert.deepStrictEqual(result, schema);
  });

  it('returns empty object on fetch failure', async () => {
    mockFetch.mock.mockImplementation(async () => ({
      ok: false,
      status: 500,
    }));

    const result = await loadSchema();
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when fetch throws', async () => {
    mockFetch.mock.mockImplementation(async () => {
      throw new Error('Network error');
    });

    const result = await loadSchema();
    assert.deepStrictEqual(result, {});
  });
});
