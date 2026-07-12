/**
 * reorder-buffer.test.js — Property and unit tests for the ordered insertion
 * logic in adapter-tauri.js.
 *
 * Events from the worker pool may arrive out of order. The adapter inserts
 * each event at the correct position in the pending actions list based on
 * its sequence_id, delivering immediately (no buffering). These tests verify
 * ordering, completeness, and sequence_id stripping.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// ─── Mock Tauri globals before importing adapter-tauri.js ─────────────────────

globalThis.window = {
  __TAURI__: {
    core: { invoke: async () => ({}) },
    event: { listen: async () => () => {} },
  },
};

// Dynamic import after globals are set up
const { _testOnly } = await import('../../src/adapter-tauri.js');

const { resetReorderState, insertOrdered, stripSeqFields } = _testOnly;

const adapterModule = await import('../../src/adapter-tauri.js');
const adapter = adapterModule.default;

const { SENSITIVE_MASK } = await import('../../shared/lib/field-sensitivity.js');

// ─── Events are delivered in sequence order ───────────────────────
// Reorder buffer ordering

describe('Reorder buffer emits events in sequence order', () => {
  beforeEach(() => {
    resetReorderState();
    adapter.clearPendingActions();
  });

  it('any permutation of sequence_ids 1..N results in correctly ordered pending actions', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        resetReorderState();
        adapter.clearPendingActions();

        // Create events with sequence_ids 1..N
        const events = Array.from({ length: n }, (_, i) => ({
          type: 'click',
          timestamp: 1000 + i,
          sequence_id: i + 1,
          element: { selector: `#el-${i + 1}` },
        }));

        // Shuffle to create a random permutation
        const shuffled = [...events];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        // Insert all events in shuffled order
        for (const event of shuffled) {
          insertOrdered(event);
        }

        // Strip _seq fields (as commitWithCompleteness would)
        stripSeqFields();

        // Verify output order is strictly 1, 2, 3, ..., N by timestamp
        const delivered = adapter.getPendingActions();
        assert.strictEqual(
          delivered.length,
          n,
          `Expected ${n} delivered actions, got ${delivered.length}`,
        );

        for (let i = 0; i < delivered.length; i++) {
          assert.strictEqual(
            delivered[i].timestamp,
            1000 + i,
            `Action at index ${i} should have timestamp ${1000 + i}, got ${delivered[i].timestamp}`,
          );
        }
      }),
      { numRuns: 20 },
    );
  });
});

// The step-commit completeness guarantee is no longer a frontend
// highest-sequence poll — it is the backend flush barrier (docent#298), whose
// delivery-sentinel behaviour is covered by adapter-tauri.test.js's
// commitWithCompleteness suite. These tests cover only the ordered-insertion
// half that still lives in this module.

// ─── sequence_id stripped before delivery ────────────────────────
// sequence_id stripped

describe('sequence_id stripped before delivery', () => {
  beforeEach(() => {
    resetReorderState();
    adapter.clearPendingActions();
  });

  it('delivered actions do not contain sequence_id field after stripSeqFields', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
        resetReorderState();
        adapter.clearPendingActions();

        for (let i = 1; i <= n; i++) {
          insertOrdered({
            type: 'click',
            timestamp: i * 100,
            sequence_id: i,
            element: { selector: `#el-${i}` },
            capture_mode: 'accessibility',
          });
        }

        stripSeqFields();

        const delivered = adapter.getPendingActions();
        assert.strictEqual(delivered.length, n);

        for (const action of delivered) {
          assert.ok(
            !('sequence_id' in action),
            `sequence_id should be stripped: ${JSON.stringify(action)}`,
          );
          assert.ok(!('_seq' in action), `_seq should be stripped: ${JSON.stringify(action)}`);
        }
      }),
      { numRuns: 20 },
    );
  });
});

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('Ordered insertion unit tests', () => {
  beforeEach(() => {
    resetReorderState();
    adapter.clearPendingActions();
  });

  it('reset is safe and insertion continues to work afterwards', () => {
    insertOrdered({ type: 'click', timestamp: 300, sequence_id: 3, element: { selector: '#a' } });
    assert.strictEqual(adapter.getPendingActions().length, 1);

    resetReorderState();
    adapter.clearPendingActions();

    insertOrdered({ type: 'click', timestamp: 100, sequence_id: 1, element: { selector: '#b' } });
    assert.strictEqual(adapter.getPendingActions().length, 1);
    assert.strictEqual(adapter.getPendingActions()[0]._seq, 1);
  });

  it('events without sequence_id pass through directly', () => {
    insertOrdered({ type: 'click', timestamp: 100, element: { selector: '#no-seq' } });

    const delivered = adapter.getPendingActions();
    assert.strictEqual(delivered.length, 1);
    assert.strictEqual(delivered[0].timestamp, 100);
    assert.ok(!('sequence_id' in delivered[0]));
  });

  it('consecutive in-order events are delivered immediately', () => {
    insertOrdered({ type: 'click', timestamp: 100, sequence_id: 1, element: { selector: '#a' } });
    assert.strictEqual(adapter.getPendingActions().length, 1);

    insertOrdered({ type: 'click', timestamp: 200, sequence_id: 2, element: { selector: '#b' } });
    assert.strictEqual(adapter.getPendingActions().length, 2);

    insertOrdered({ type: 'click', timestamp: 300, sequence_id: 3, element: { selector: '#c' } });
    assert.strictEqual(adapter.getPendingActions().length, 3);
  });

  it('out-of-order events are inserted at the correct position', () => {
    // Insert seq 3, then 1, then 2
    insertOrdered({ type: 'click', timestamp: 300, sequence_id: 3, element: { selector: '#c' } });
    insertOrdered({ type: 'click', timestamp: 100, sequence_id: 1, element: { selector: '#a' } });
    insertOrdered({ type: 'click', timestamp: 200, sequence_id: 2, element: { selector: '#b' } });

    const delivered = adapter.getPendingActions();
    assert.strictEqual(delivered.length, 3, 'All 3 should be delivered immediately');

    // Verify correct order by _seq (internal sorting field)
    assert.strictEqual(delivered[0]._seq, 1);
    assert.strictEqual(delivered[1]._seq, 2);
    assert.strictEqual(delivered[2]._seq, 3);
  });

  it('all events delivered immediately regardless of arrival order', () => {
    // Insert 5, 3, 1, 4, 2
    insertOrdered({ type: 'click', timestamp: 500, sequence_id: 5, element: { selector: '#e' } });
    assert.strictEqual(adapter.getPendingActions().length, 1);

    insertOrdered({ type: 'click', timestamp: 300, sequence_id: 3, element: { selector: '#c' } });
    assert.strictEqual(adapter.getPendingActions().length, 2);

    insertOrdered({ type: 'click', timestamp: 100, sequence_id: 1, element: { selector: '#a' } });
    assert.strictEqual(adapter.getPendingActions().length, 3);

    insertOrdered({ type: 'click', timestamp: 400, sequence_id: 4, element: { selector: '#d' } });
    assert.strictEqual(adapter.getPendingActions().length, 4);

    insertOrdered({ type: 'click', timestamp: 200, sequence_id: 2, element: { selector: '#b' } });
    assert.strictEqual(adapter.getPendingActions().length, 5);

    // All delivered, in correct order
    const delivered = adapter.getPendingActions();
    assert.strictEqual(delivered[0]._seq, 1);
    assert.strictEqual(delivered[1]._seq, 2);
    assert.strictEqual(delivered[2]._seq, 3);
    assert.strictEqual(delivered[3]._seq, 4);
    assert.strictEqual(delivered[4]._seq, 5);
  });
});

// ─── sensitive-value redaction at the desktop storage chokepoint ─────────
// _insertOrdered runs the shared field-sensitivity util before an action enters
// the pending list (and so the stored recording). The Rust layer masks passwords
// natively; this covers cc/ssn/secret fields named in the accessibility tree and
// sets the `redacted` marker (single-sourced with the extension).

describe('_insertOrdered redacts sensitive field values', () => {
  beforeEach(() => {
    resetReorderState();
    adapter.clearPendingActions();
  });

  it('masks a sensitive (cc-named) field value, nulls its text, and flags it redacted', () => {
    insertOrdered({
      type: 'type',
      timestamp: 1,
      element: { tag: 'Edit', name: 'creditCardNumber', selector: 'x', text: '4111111111111111' },
      value: '4111111111111111',
    });
    const a = adapter.getPendingActions()[0];
    assert.equal(a.value, SENSITIVE_MASK);
    assert.equal(a.element.text, null);
    assert.equal(a.element.redacted, true);
  });

  it('flags a password element (type=password) redacted', () => {
    insertOrdered({
      type: 'type',
      timestamp: 1,
      element: { tag: 'Edit', name: 'pw', type: 'password', selector: 'x', text: null },
      value: SENSITIVE_MASK, // Rust already masked the value
    });
    assert.equal(adapter.getPendingActions()[0].element.redacted, true);
  });

  it('leaves a normal field untouched (no over-masking)', () => {
    insertOrdered({
      type: 'type',
      timestamp: 1,
      element: { tag: 'Edit', name: 'username', selector: 'x', text: 'alice' },
      value: 'alice',
    });
    const a = adapter.getPendingActions()[0];
    assert.equal(a.value, 'alice');
    assert.equal(a.element.text, 'alice');
    assert.equal(a.element.redacted, undefined);
  });
});
