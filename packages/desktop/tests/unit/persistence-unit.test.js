/**
 * Unit tests for persistence.js — Desktop session persistence
 *
 * Tests the full public API: emptyState, serializeState, deserializeState,
 * loadSessionState, loadProblemMessage, and saveSessionState.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import {
  emptyState,
  serializeState,
  deserializeState,
  loadSessionState,
  saveSessionState,
  loadProblemMessage,
  loadErrorText,
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
    // An array is no session state: reading it as one would start the app
    // empty over a file that held something else.
    assert.strictEqual(deserializeState('[1,2,3]'), null);
  });
});

// ─── loadSessionState() ───────────────────────────────────────────────────────

describe('loadSessionState()', () => {
  // The backend answers a missing file with "{}" and rejects for a file it
  // could not use (commands.rs, LoadError): the rejection names what it did
  // with the file, and the panel needs that to tell the user and to know
  // whether saving may go on.
  const KEPT_AS =
    'C:\\Users\\me\\AppData\\Roaming\\com.docent.desktop\\session.unreadable-20261121T171500Z.json';
  const PATH = 'C:\\Users\\me\\AppData\\Roaming\\com.docent.desktop\\session.json';

  it('reports no problem for a file that loads', async () => {
    const invoke = mock.fn(async () => '{}');
    const { state, problem } = await loadSessionState(invoke);
    assert.deepStrictEqual(state.projects, []);
    assert.deepStrictEqual(state.settings, emptyState().settings);
    assert.strictEqual(problem, null);
  });

  it('starts empty and keeps saving on when the backend set the file aside', async () => {
    const invoke = mock.fn(async () => {
      throw {
        kind: 'set_aside',
        path: PATH,
        kept_as: KEPT_AS,
        reason: 'it is not valid JSON',
        state: '{}',
      };
    });
    const { state, problem } = await loadSessionState(invoke);
    assert.deepStrictEqual(state.projects, []);
    assert.deepStrictEqual(state.settings, emptyState().settings);
    assert.deepStrictEqual(problem, {
      kind: 'set_aside',
      path: PATH,
      keptAs: KEPT_AS,
      savingStopped: false,
    });
  });

  it('starts from the stored keys the backend handed back with a set-aside', async () => {
    // The keys live in the credential store, not in the file: starting from a
    // bare empty state would make the first save clear them.
    const invoke = mock.fn(async () => {
      throw {
        kind: 'set_aside',
        path: PATH,
        kept_as: KEPT_AS,
        reason: 'it is not valid JSON',
        state: JSON.stringify({ settings: { apiKey: 'stored', syncApiKey: 'stored-sync' } }),
      };
    });
    const { state, problem } = await loadSessionState(invoke);
    assert.deepStrictEqual(state.projects, []);
    assert.strictEqual(state.settings.apiKey, 'stored');
    assert.strictEqual(state.settings.syncApiKey, 'stored-sync');
    assert.strictEqual(problem.savingStopped, false);
  });

  it('stops saving when a set-aside comes without a usable starting state', async () => {
    const invoke = mock.fn(async () => {
      throw { kind: 'set_aside', path: PATH, kept_as: KEPT_AS, reason: 'r', state: 'not json' };
    });
    const { state, problem } = await loadSessionState(invoke);
    assert.deepStrictEqual(state, emptyState());
    assert.strictEqual(problem.savingStopped, true);
    const text = loadProblemMessage(problem);
    assert.ok(text.includes(KEPT_AS), text);
    assert.match(text, /will not save anything until you restart it/);
    assert.doesNotMatch(text, /saved as usual/);
  });

  it('starts empty and stops saving when the backend left the file in place', async () => {
    const invoke = mock.fn(async () => {
      throw { kind: 'kept_in_place', path: PATH, reason: 'it could not be read' };
    });
    const { state, problem } = await loadSessionState(invoke);
    assert.deepStrictEqual(state, emptyState());
    assert.deepStrictEqual(problem, {
      kind: 'kept_in_place',
      path: PATH,
      keptAs: null,
      savingStopped: true,
    });
  });

  it('stops saving on any other load failure', async () => {
    for (const thrown of [
      { kind: 'no_location', reason: 'APPDATA environment variable not set' },
      new Error('invoke failed'),
      'a bare string',
    ]) {
      const invoke = mock.fn(async () => {
        throw thrown;
      });
      const { state, problem } = await loadSessionState(invoke);
      assert.deepStrictEqual(state, emptyState());
      assert.deepStrictEqual(problem, {
        kind: 'unknown',
        path: null,
        keptAs: null,
        savingStopped: true,
      });
    }
  });

  it('stops saving when the answer is not a JSON object', async () => {
    for (const answer of ['not valid json', '[1,2,3]', 'null']) {
      const invoke = mock.fn(async () => answer);
      const { state, problem } = await loadSessionState(invoke);
      assert.deepStrictEqual(state, emptyState());
      assert.strictEqual(problem.savingStopped, true, answer);
      assert.strictEqual(problem.kind, 'unknown', answer);
    }
  });

  it('returns parsed state with defaults filled in when invoke returns valid JSON', async () => {
    const partial = { projects: [{ project_id: 'p1' }] };
    const invoke = mock.fn(async () => JSON.stringify(partial));
    const { state } = await loadSessionState(invoke);

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
    const { state } = await loadSessionState(invoke);

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
    const { state } = await loadSessionState(invoke);
    assert.strictEqual(state.settings.syncUrl, 'https://sync.example.com');
    assert.strictEqual(state.settings.syncApiKey, 'sk');
    assert.strictEqual(state.settings.recordingMode, 'simple');
    assert.deepStrictEqual(state.syncState, full.syncState);
  });
});

// ─── loadProblemMessage() ─────────────────────────────────────────────────────

describe('loadProblemMessage()', () => {
  it('names where a set-aside file was kept and that saving goes on', () => {
    const text = loadProblemMessage({
      kind: 'set_aside',
      path: 'C:\\d\\session.json',
      keptAs: 'C:\\d\\session.unreadable-20261121T171500Z.json',
      savingStopped: false,
    });
    assert.match(text, /could not read your saved projects/);
    assert.ok(text.includes('C:\\d\\session.unreadable-20261121T171500Z.json'), text);
    assert.match(text, /saved as usual/);
  });

  it('names the file left in place and that nothing will be saved', () => {
    const text = loadProblemMessage({
      kind: 'kept_in_place',
      path: 'C:\\d\\session.json',
      keptAs: null,
      savingStopped: true,
    });
    assert.ok(text.includes('C:\\d\\session.json'), text);
    assert.match(text, /will not save anything until you restart it/);
  });

  it('says nothing will be saved when the cause is unknown', () => {
    const text = loadProblemMessage({
      kind: 'unknown',
      path: null,
      keptAs: null,
      savingStopped: true,
    });
    assert.match(text, /could not read your saved projects/);
    assert.match(text, /will not save anything until you restart it/);
  });
});

// ─── loadErrorText() ──────────────────────────────────────────────────────────

describe('loadErrorText()', () => {
  it('words a rejection of load_state as the startup message does', () => {
    const err = { kind: 'kept_in_place', path: 'C:\\d\\session.json', reason: 'r' };
    assert.strictEqual(
      loadErrorText(err),
      loadProblemMessage({
        kind: 'kept_in_place',
        path: 'C:\\d\\session.json',
        keptAs: null,
        savingStopped: true,
      }),
    );
  });

  it('gives an Error its message and anything else its text', () => {
    assert.strictEqual(loadErrorText(new Error('boom')), 'boom');
    assert.strictEqual(
      loadErrorText('Not saved: the session file could not be read'),
      'Not saved: the session file could not be read',
    );
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
