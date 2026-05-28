/**
 * completeness.test.js — Tests for the commitWithCompleteness guarantee.
 *
 * Validates that the completeness mechanism:
 * - Resolves immediately when all events have arrived
 * - Waits for missing events within the timeout
 * - Times out gracefully when events never arrive
 * - Strips _seq fields after completion
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Replicate the completeness logic from adapter-tauri.js ───────────────────

let pendingActions;
let highestSeenSeq;

function reset() {
  pendingActions = [];
  highestSeenSeq = 0;
}

function insertOrdered(action) {
  const seqId = action.sequence_id;
  const { sequence_id, ...cleanAction } = action;

  if (seqId == null) {
    pendingActions.push(cleanAction);
  } else {
    if (seqId > highestSeenSeq) highestSeenSeq = seqId;
    cleanAction._seq = seqId;
    let insertIdx = pendingActions.length;
    while (insertIdx > 0 && (pendingActions[insertIdx - 1]._seq || 0) > seqId) {
      insertIdx--;
    }
    pendingActions.splice(insertIdx, 0, cleanAction);
  }
}

function stripSeqFields() {
  for (const action of pendingActions) {
    delete action._seq;
  }
}

async function commitWithCompleteness(maxSeq, timeoutMs = 200) {
  if (maxSeq === 0 || highestSeenSeq >= maxSeq) {
    stripSeqFields();
    return;
  }

  const deadline = Date.now() + timeoutMs;

  await new Promise((resolve) => {
    const check = () => {
      if (highestSeenSeq >= maxSeq || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });

  stripSeqFields();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('commitWithCompleteness', () => {
  beforeEach(reset);

  it('resolves immediately when maxSeq is 0 (no events dispatched)', async () => {
    const start = Date.now();
    await commitWithCompleteness(0);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `Should resolve immediately, took ${elapsed}ms`);
  });

  it('resolves immediately when all events already received', async () => {
    insertOrdered({ type: 'click', sequence_id: 1 });
    insertOrdered({ type: 'type', sequence_id: 2 });
    insertOrdered({ type: 'key', sequence_id: 3 });

    const start = Date.now();
    await commitWithCompleteness(3);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `Should resolve immediately, took ${elapsed}ms`);
  });

  it('waits for missing events and resolves when they arrive', async () => {
    insertOrdered({ type: 'click', sequence_id: 1 });
    // sequence_id 2 is missing

    // Simulate delayed arrival
    setTimeout(() => {
      insertOrdered({ type: 'type', sequence_id: 2 });
    }, 50);

    const start = Date.now();
    await commitWithCompleteness(2, 500);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 40, `Should have waited for event, took ${elapsed}ms`);
    assert.ok(elapsed < 200, `Should not have timed out, took ${elapsed}ms`);
    assert.equal(pendingActions.length, 2);
  });

  it('times out gracefully when events never arrive', async () => {
    insertOrdered({ type: 'click', sequence_id: 1 });
    // sequence_id 2 never arrives

    const start = Date.now();
    await commitWithCompleteness(2, 100); // 100ms timeout
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 90, `Should have waited for timeout, took ${elapsed}ms`);
    assert.ok(elapsed < 200, `Should not exceed timeout significantly, took ${elapsed}ms`);
    // Still has the one event that did arrive
    assert.equal(pendingActions.length, 1);
  });

  it('strips _seq fields from all actions after completion', async () => {
    insertOrdered({ type: 'click', sequence_id: 1 });
    insertOrdered({ type: 'type', sequence_id: 2 });

    await commitWithCompleteness(2);

    for (const action of pendingActions) {
      assert.equal(action._seq, undefined, `_seq should be stripped: ${JSON.stringify(action)}`);
      assert.equal(action.sequence_id, undefined, `sequence_id should be stripped`);
    }
  });

  it('strips _seq fields even on timeout', async () => {
    insertOrdered({ type: 'click', sequence_id: 1 });
    // sequence_id 2 never arrives

    await commitWithCompleteness(2, 50);

    for (const action of pendingActions) {
      assert.equal(action._seq, undefined, '_seq should be stripped even on timeout');
    }
  });

  it('handles out-of-order arrival correctly', async () => {
    // Events arrive: 3, 1, 2
    insertOrdered({ type: 'key', sequence_id: 3 });
    insertOrdered({ type: 'click', sequence_id: 1 });
    insertOrdered({ type: 'type', sequence_id: 2 });

    await commitWithCompleteness(3);

    // Should be in order after insertion
    assert.equal(pendingActions[0].type, 'click');
    assert.equal(pendingActions[1].type, 'type');
    assert.equal(pendingActions[2].type, 'key');
  });
});
