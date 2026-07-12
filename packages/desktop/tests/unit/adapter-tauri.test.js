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
import { composePlatform, locatorStrategyDefs } from '../../../../scripts/build-schemas.js';
import { valueDerivedStrategies } from '../../../../scripts/sufficiency-lint.js';

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
const {
  default: adapter,
  commitWithCompleteness,
  _testOnly,
} = await import('../../src/adapter-tauri.js');

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
    await adapter.saveSettings('https://api.test', 'secret');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    assert.ok(saveCall);
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.endpointUrl, 'https://api.test');
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
    await adapter.saveSyncSettings('https://sync.test', 'key');
    const saveCall = mockInvoke.mock.calls.find((c) => c.arguments[0] === 'save_state');
    const saved = JSON.parse(saveCall.arguments[1].data);
    assert.equal(saved.settings.syncUrl, 'https://sync.test');
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
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    resetMocks();
    _testOnly.resetReorderState();
    adapter.clearPendingActions();
  });

  it('invokes commit_barrier (not get_max_sequence_number)', async () => {
    mockInvoke.mock.mockImplementation(async () => ({ barrier_id: 0, wedged_workers: 0 }));
    await commitWithCompleteness();
    const commands = mockInvoke.mock.calls.map((c) => c.arguments[0]);
    assert.ok(commands.includes('commit_barrier'), 'should invoke commit_barrier');
    assert.ok(
      !commands.includes('get_max_sequence_number'),
      'should NOT invoke the removed get_max_sequence_number',
    );
  });

  it('strips _seq and returns immediately when there is no active capture (barrier_id 0)', async () => {
    mockInvoke.mock.mockImplementation(async () => ({ barrier_id: 0, wedged_workers: 0 }));
    _testOnly.insertOrdered({ type: 'click', sequence_id: 1, timestamp: 1, element: {} });
    await commitWithCompleteness();
    const actions = adapter.getPendingActions();
    assert.equal(actions.length, 1);
    assert.equal(actions[0]._seq, undefined, '_seq should be stripped');
  });

  // Regression: #298 — the barrier must wait for the delivery sentinel, not just
  // the command return. An in-flight action delivered AFTER commit_barrier
  // resolves but BEFORE the sentinel must still be captured in the committed
  // step. (A naive `await invoke('commit_barrier')` alone would drop it, because
  // the command-return and event-emit IPC channels have no mutual ordering.)
  // https://github.com/Arsarneq/docent/issues/298
  it('regression_298_waits_for_the_delivery_sentinel', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'commit_barrier') return { barrier_id: 7, wedged_workers: 0 };
      return undefined;
    });

    const commit = commitWithCompleteness();
    let resolved = false;
    commit.then(() => {
      resolved = true;
    });

    // The command has resolved; deliver a late in-flight action (no sentinel yet).
    await tick();
    _testOnly.handleCaptureAction({ type: 'click', sequence_id: 9, timestamp: 1, element: {} });
    await tick();
    assert.equal(resolved, false, 'commit must not resolve before the sentinel arrives');

    // The sentinel is emitted LAST on the stream → commit resolves.
    _testOnly.handleCaptureAction({ type: 'barrier_complete', barrier_id: 7 });
    await commit;

    const actions = adapter.getPendingActions();
    assert.equal(actions.length, 1, 'the late in-flight action must be in the committed step');
    assert.equal(actions[0].type, 'click');
    assert.equal(actions[0]._seq, undefined, '_seq should be stripped after commit');
  });

  it('resolves when the sentinel arrived before the waiter registered', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'commit_barrier') return { barrier_id: 3, wedged_workers: 0 };
      return undefined;
    });
    // Sentinel arrives before commit is even called (parked in _seenBarriers).
    _testOnly.handleCaptureAction({ type: 'barrier_complete', barrier_id: 3 });
    await commitWithCompleteness(); // must not hang
  });

  it('warns but proceeds when workers were wedged', async () => {
    mockInvoke.mock.mockImplementation(async (cmd) => {
      if (cmd === 'commit_barrier') return { barrier_id: 4, wedged_workers: 2 };
      return undefined;
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const commit = commitWithCompleteness();
      await tick();
      _testOnly.handleCaptureAction({ type: 'barrier_complete', barrier_id: 4 });
      await commit;
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((w) => w.includes('2 worker')),
      'should warn about wedged workers',
    );
  });
});

// ─── _redactSensitive: locator pass-through (docent#138/#139) ─────────────────
// First regression coverage for the redaction chokepoint. Locator entries are
// identity-derived on desktop (ids, control types, labels, tree paths — the
// signals detection keys on), so they pass through UNTOUCHED while the value
// and text are masked. Masking a label would destroy the locator and mask a
// non-secret.

describe('_redactSensitive leaves locators and provider facts untouched', () => {
  function sensitiveAction() {
    return {
      type: 'type',
      timestamp: 1000,
      sequence_id: 1,
      value: '4111 1111 1111 1111',
      element: {
        tag: 'Edit',
        id: 'card_number',
        name: 'card_number',
        role: 'edit',
        type: null,
        text: '4111 1111 1111 1111',
        selector: 'Window:Checkout > Edit:Card number',
        position_in_set: 2,
        size_of_set: 4,
        level: 1,
        framework_id: 'WPF',
        described_after_ms: 42,
        locators: [
          { strategy: 'automation_id', value: 'card_number', match_count: 1, match_index: 0 },
          {
            strategy: 'role_name',
            role: 'Edit',
            name: 'Card number',
            match_count: 2,
            match_index: 1,
          },
          { strategy: 'class_name', value: 'Edit', match_count: 6, match_index: 3 },
          { strategy: 'labeled_by', value: 'Card number' },
          { strategy: 'tree_path', value: 'Window:Checkout > Edit:Card number' },
        ],
      },
    };
  }

  it('masks value/text and flags redacted, but locators + facts are deep-equal untouched', () => {
    adapter.clearPendingActions();
    _testOnly.resetReorderState();
    const original = sensitiveAction();
    const expectedLocators = structuredClone(original.element.locators);
    _testOnly.insertOrdered(sensitiveAction());

    const [stored] = adapter.getPendingActions();
    assert.notEqual(stored.value, '4111 1111 1111 1111');
    assert.equal(stored.element.text, null);
    assert.equal(stored.element.redacted, true);
    assert.deepStrictEqual(stored.element.locators, expectedLocators);
    assert.equal(stored.element.position_in_set, 2);
    assert.equal(stored.element.size_of_set, 4);
    assert.equal(stored.element.level, 1);
    assert.equal(stored.element.framework_id, 'WPF');
    assert.equal(stored.element.described_after_ms, 42);
    const masked = stored.element.locators.some((l) => l.masked);
    assert.equal(masked, false, 'no desktop locator entry may carry masked');
  });

  it("drift guard: the masked set equals the schema's x-value-derived strategies (empty)", () => {
    // The schema annotates every desktop strategy `x-value-derived: false` —
    // the chokepoint masks none of them. This drives the REAL _redactSensitive
    // on a sensitive element carrying one entry per emitted strategy (built
    // from the composed schema, so a new strategy joins automatically) and
    // checks the two sides of the seam: if the code starts masking an entry
    // the schema does not annotate — or a def gets annotated true while the
    // code stays hands-off — this fails, forcing the two to move together.
    // The annotated set comes from valueDerivedStrategies — the exact reader
    // the sufficiency lint's masked-locator-honesty predicate enforces.
    const defs = locatorStrategyDefs(composePlatform('desktop-windows')).map(({ def }) => def);
    const annotated = [...valueDerivedStrategies('desktop-windows')];
    const entryFor = (def) => {
      const entry = {};
      for (const [prop, shape] of Object.entries(def.properties)) {
        if (prop === 'strategy') entry.strategy = shape.const;
        else if (prop === 'match_count') entry.match_count = 1;
        else if (prop === 'match_index') entry.match_index = 0;
        else if (prop !== 'masked') entry[prop] = `probe-${prop}`;
      }
      return entry;
    };

    const action = {
      type: 'type',
      timestamp: 1000,
      value: '4111 1111 1111 1111',
      element: {
        tag: 'Edit',
        id: 'card_number',
        name: 'card_number',
        role: 'edit',
        type: null,
        text: '4111 1111 1111 1111',
        selector: 'Window:Checkout > Edit:Card number',
        locators: defs.map(entryFor),
      },
    };
    const expectedLocators = structuredClone(action.element.locators);
    const out = _testOnly.redactSensitive(action);

    assert.equal(out.element.redacted, true, 'the fixture must be genuinely sensitive');
    const maskedStrategies = out.element.locators
      .filter((loc) => loc.masked === true)
      .map((loc) => loc.strategy);
    assert.deepStrictEqual(maskedStrategies.sort(), [...annotated].sort());
    // Byte-identical pass-through is TODAY'S desktop contract, pinned because
    // the annotated set is empty. A desktop strategy becoming value-derived
    // changes this contract: update this pin (to the per-entry shape the
    // extension guard uses) together with the annotation and the chokepoint.
    assert.deepStrictEqual(
      out.element.locators,
      expectedLocators,
      'today no desktop strategy is value-derived, so redaction must pass every locator entry through byte-identical — if a strategy just became value-derived, update this pin alongside the annotation',
    );
  });

  it('leaves a non-sensitive action entirely untouched', () => {
    adapter.clearPendingActions();
    _testOnly.resetReorderState();
    const action = {
      type: 'click',
      timestamp: 1000,
      sequence_id: 1,
      x: 1,
      y: 2,
      element: {
        tag: 'Button',
        id: 'btnSave',
        name: 'Save',
        role: 'button',
        type: null,
        text: 'Save',
        selector: 'Window:App > Button:Save',
        described_after_ms: 0,
        locators: [{ strategy: 'automation_id', value: 'btnSave', match_count: 1, match_index: 0 }],
      },
    };
    const expected = structuredClone(action);
    delete expected.sequence_id; // stripped before storage
    _testOnly.insertOrdered(action);

    const [stored] = adapter.getPendingActions();
    // `_seq` is the adapter's transient reorder marker (stripped at commit
    // time by _stripSeqFields) — not part of the redaction contract under test.
    const { _seq, ...storedWithoutSeq } = stored;
    assert.deepStrictEqual(storedWithoutSeq, expected);
  });
});
