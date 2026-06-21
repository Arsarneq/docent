/**
 * frame-trust.test.js — Unit tests for isTrustedActionSender.
 *
 * The predicate decides whether an APPEND_ACTION message may be appended to a
 * recording: it must come from our own extension, during a live recording, from
 * a frame of a tab we are actively recording (the per-frame sender check that
 * closes the third-party-iframe action-injection surface).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedActionSender } from '../../lib/frame-trust.js';

const RUNTIME_ID = 'docent-extension-id';

function makeActiveFrames(tabId, frameIds) {
  return new Map([[tabId, new Set(frameIds)]]);
}

describe('isTrustedActionSender', () => {
  it('accepts a trusted same-tab frame in the active set', () => {
    const result = isTrustedActionSender({
      sender: { id: RUNTIME_ID, frameId: 0, tab: { id: 7 } },
      runtimeId: RUNTIME_ID,
      liveRecording: true,
      activeFrames: makeActiveFrames(7, [0]),
    });
    assert.equal(result, true);
  });

  it('accepts a recorded subframe (non-zero frameId) in the active set', () => {
    const result = isTrustedActionSender({
      sender: { id: RUNTIME_ID, frameId: 42, tab: { id: 7 } },
      runtimeId: RUNTIME_ID,
      liveRecording: true,
      activeFrames: makeActiveFrames(7, [0, 42]),
    });
    assert.equal(result, true);
  });

  it('rejects a frameId not in the active set (unknown / dynamically injected frame)', () => {
    const result = isTrustedActionSender({
      sender: { id: RUNTIME_ID, frameId: 99, tab: { id: 7 } },
      runtimeId: RUNTIME_ID,
      liveRecording: true,
      activeFrames: makeActiveFrames(7, [0, 42]),
    });
    assert.equal(result, false);
  });

  it('rejects a foreign sender.id (another extension / page on the message port)', () => {
    const result = isTrustedActionSender({
      sender: { id: 'some-other-extension', frameId: 0, tab: { id: 7 } },
      runtimeId: RUNTIME_ID,
      liveRecording: true,
      activeFrames: makeActiveFrames(7, [0]),
    });
    assert.equal(result, false);
  });

  it('rejects when liveRecording is false', () => {
    const result = isTrustedActionSender({
      sender: { id: RUNTIME_ID, frameId: 0, tab: { id: 7 } },
      runtimeId: RUNTIME_ID,
      liveRecording: false,
      activeFrames: makeActiveFrames(7, [0]),
    });
    assert.equal(result, false);
  });

  it('rejects a sender from a tab not in the registry (non-recorded tab)', () => {
    const result = isTrustedActionSender({
      sender: { id: RUNTIME_ID, frameId: 0, tab: { id: 999 } },
      runtimeId: RUNTIME_ID,
      liveRecording: true,
      activeFrames: makeActiveFrames(7, [0]),
    });
    assert.equal(result, false);
  });

  it('rejects when the registry is empty (per contract — nothing is trusted)', () => {
    const result = isTrustedActionSender({
      sender: { id: RUNTIME_ID, frameId: 0, tab: { id: 7 } },
      runtimeId: RUNTIME_ID,
      liveRecording: true,
      activeFrames: new Map(),
    });
    assert.equal(result, false);
  });

  it('rejects a sender with no tab (e.g. message not from a tab frame)', () => {
    const result = isTrustedActionSender({
      sender: { id: RUNTIME_ID, frameId: 0 },
      runtimeId: RUNTIME_ID,
      liveRecording: true,
      activeFrames: makeActiveFrames(7, [0]),
    });
    assert.equal(result, false);
  });

  it('rejects a null/undefined sender without throwing', () => {
    assert.equal(
      isTrustedActionSender({
        sender: null,
        runtimeId: RUNTIME_ID,
        liveRecording: true,
        activeFrames: makeActiveFrames(7, [0]),
      }),
      false,
    );
  });
});
