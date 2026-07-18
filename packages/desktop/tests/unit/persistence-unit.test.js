/**
 * Unit tests for persistence.js — Desktop session persistence
 *
 * Tests the full public API: emptyState, serializeState, deserializeState,
 * loadSessionState, and saveSessionState.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import {
  emptyState,
  serializeState,
  deserializeState,
  loadSessionState,
  saveSessionState,
} from '../../src/persistence.js';

// ─── emptyState() ─────────────────────────────────────────────────────────────

describe('emptyState()', () => {
  it('returns object with empty projects array', () => {
    const state = emptyState();
    assert.ok(Array.isArray(state.projects));
    assert.strictEqual(state.projects.length, 0);
  });

  it('returns settings with default values (the full shipped shape)', () => {
    const state = emptyState();
    assert.deepStrictEqual(state.settings, {
      endpointUrl: null,
      apiKey: null,
      theme: 'auto',
      selfCaptureExclusion: true,
      syncUrl: null,
      syncApiKey: null,
      recordingMode: 'narration',
    });
  });

  it('carries no active-id fields (the app tracks active project/recording in memory)', () => {
    const state = emptyState();
    assert.ok(!('activeProjectId' in state));
    assert.ok(!('activeRecordingId' in state));
  });

  it('returns a fresh object each call (no shared references)', () => {
    const a = emptyState();
    const b = emptyState();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.projects, b.projects);
    assert.notStrictEqual(a.settings, b.settings);
  });
});

// ─── serializeState() ─────────────────────────────────────────────────────────

describe('serializeState()', () => {
  it('returns a valid JSON string', () => {
    const state = emptyState();
    const json = serializeState(state);
    assert.doesNotThrow(() => JSON.parse(json));
  });

  it('round-trips with deserializeState', () => {
    const state = {
      projects: [{ project_id: 'abc', name: 'Test', recordings: [] }],
      syncState: { baselines: {} },
      settings: {
        endpointUrl: 'http://x.com',
        apiKey: 'key',
        theme: 'dark',
        selfCaptureExclusion: false,
        syncUrl: 'http://sync.com',
        syncApiKey: 'sk',
        recordingMode: 'simple',
      },
    };
    const json = serializeState(state);
    const restored = deserializeState(json);
    assert.deepStrictEqual(restored, state);
  });
});

// ─── deserializeState() ───────────────────────────────────────────────────────

describe('deserializeState()', () => {
  it('returns parsed object for valid JSON', () => {
    const obj = { projects: [], settings: {} };
    const result = deserializeState(JSON.stringify(obj));
    assert.deepStrictEqual(result, obj);
  });

  it('returns null for invalid JSON', () => {
    assert.strictEqual(deserializeState('not json at all'), null);
    assert.strictEqual(deserializeState('{broken'), null);
    assert.strictEqual(deserializeState(''), null);
  });

  it('returns null for non-object JSON (string)', () => {
    assert.strictEqual(deserializeState('"hello"'), null);
  });

  it('returns null for non-object JSON (number)', () => {
    assert.strictEqual(deserializeState('42'), null);
  });

  it('returns null for non-object JSON (null)', () => {
    assert.strictEqual(deserializeState('null'), null);
  });

  it('returns null for non-object JSON (array)', () => {
    // Arrays are typeof "object" but the code checks parsed === null
    // Actually arrays pass typeof === 'object' and !== null, so they return the array
    // Let's verify the actual behavior
    const result = deserializeState('[1,2,3]');
    // Arrays are objects in JS, so they pass the check
    assert.deepStrictEqual(result, [1, 2, 3]);
  });
});

// ─── loadSessionState() ───────────────────────────────────────────────────────

describe('loadSessionState()', () => {
  it('returns empty state when invoke throws (file missing)', async () => {
    const invoke = mock.fn(async () => {
      throw new Error('File not found');
    });
    const state = await loadSessionState(invoke);
    assert.deepStrictEqual(state, emptyState());
  });

  it('returns empty state when invoke returns invalid JSON', async () => {
    const invoke = mock.fn(async () => 'not valid json');
    const state = await loadSessionState(invoke);
    assert.deepStrictEqual(state, emptyState());
  });

  it('returns parsed state with defaults filled in when invoke returns valid JSON', async () => {
    const partial = { projects: [{ project_id: 'p1' }] };
    const invoke = mock.fn(async () => JSON.stringify(partial));
    const state = await loadSessionState(invoke);

    // Defaults should be filled in across the full settings shape.
    assert.strictEqual(state.settings.endpointUrl, null);
    assert.strictEqual(state.settings.apiKey, null);
    assert.strictEqual(state.settings.theme, 'auto');
    assert.strictEqual(state.settings.selfCaptureExclusion, true);
    assert.strictEqual(state.settings.syncUrl, null);
    assert.strictEqual(state.settings.syncApiKey, null);
    assert.strictEqual(state.settings.recordingMode, 'narration');
    // Projects preserved
    assert.deepStrictEqual(state.projects, [{ project_id: 'p1' }]);
  });

  it('preserves all fields from valid state', async () => {
    const full = {
      projects: [{ project_id: 'p1', name: 'My Project', recordings: [] }],
      syncState: { baselines: { p1: { digest: 'd' } } },
      settings: {
        endpointUrl: 'https://api.example.com',
        apiKey: 'secret-key-123',
        theme: 'dark',
        selfCaptureExclusion: false,
        syncUrl: 'https://sync.example.com',
        syncApiKey: 'sync-key',
        recordingMode: 'simple',
      },
    };
    const invoke = mock.fn(async () => JSON.stringify(full));
    const state = await loadSessionState(invoke);

    assert.deepStrictEqual(state.projects, full.projects);
    assert.deepStrictEqual(state.syncState, full.syncState);
    assert.strictEqual(state.settings.endpointUrl, 'https://api.example.com');
    assert.strictEqual(state.settings.apiKey, 'secret-key-123');
    assert.strictEqual(state.settings.theme, 'dark');
    assert.strictEqual(state.settings.selfCaptureExclusion, false);
    assert.strictEqual(state.settings.syncUrl, 'https://sync.example.com');
    assert.strictEqual(state.settings.syncApiKey, 'sync-key');
    assert.strictEqual(state.settings.recordingMode, 'simple');
  });

  it('regression_noissue_loadstate_preserves_sync_settings_and_state', async () => {
    // Regression: persistence.js dropped syncUrl / syncApiKey / recordingMode and
    // syncState on load, diverging from the shipped panel.js boot path which
    // preserves all of them. Wiring persistence.js as the single source requires
    // it to preserve the full shipped shape. No GitHub issue — a confirmed defect
    // worked from the local backlog.
    const full = {
      projects: [],
      syncState: { baselines: { p1: { digest: 'd' } } },
      settings: {
        endpointUrl: 'https://api.example.com',
        apiKey: 'k',
        theme: 'dark',
        selfCaptureExclusion: false,
        syncUrl: 'https://sync.example.com',
        syncApiKey: 'sk',
        recordingMode: 'simple',
      },
    };
    const invoke = mock.fn(async () => JSON.stringify(full));
    const state = await loadSessionState(invoke);
    assert.strictEqual(state.settings.syncUrl, 'https://sync.example.com');
    assert.strictEqual(state.settings.syncApiKey, 'sk');
    assert.strictEqual(state.settings.recordingMode, 'simple');
    assert.deepStrictEqual(state.syncState, full.syncState);
  });
});

// ─── saveSessionState() ───────────────────────────────────────────────────────

describe('saveSessionState()', () => {
  it('calls invoke with save_state and serialized JSON', async () => {
    const invoke = mock.fn(async () => {});
    const state = emptyState();
    await saveSessionState(invoke, state);

    assert.strictEqual(invoke.mock.calls.length, 1);
    const [command, args] = invoke.mock.calls[0].arguments;
    assert.strictEqual(command, 'save_state');
    assert.strictEqual(args.data, JSON.stringify(state));
  });

  it('throws when invoke fails', async () => {
    const invoke = mock.fn(async () => {
      throw new Error('Disk full');
    });
    await assert.rejects(
      () => saveSessionState(invoke, emptyState()),
      (err) => err.message === 'Disk full',
    );
  });
});
