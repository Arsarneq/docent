/**
 * navigation-logic.test.js — Unit tests for navigation capture decision logic.
 *
 * Tests shouldCaptureNavigation() with all transition types and timing states,
 * and shouldCaptureTabCreated() for context_open decisions (Ctrl+T, Ctrl+Shift+T).
 *
 * Covers issue #32.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCaptureNavigation, shouldCaptureTabCreated } from '../../lib/navigation-logic.js';

const DEFAULT_CONTEXT = {
  lastTabCreatedTimestamp: 0,
  now: 10000,
  lastTabNavUrl: null,
  tabCreatedSuppressionMs: 1000,
};

function makeDetails(overrides = {}) {
  return {
    url: 'https://example.com',
    frameId: 0,
    transitionType: 'typed',
    transitionQualifiers: [],
    tabId: 1,
    ...overrides,
  };
}

// ─── Basic filtering ──────────────────────────────────────────────────────────

describe('shouldCaptureNavigation — basic filtering', () => {
  it('skips non-main-frame navigations', () => {
    const result = shouldCaptureNavigation(makeDetails({ frameId: 1 }), DEFAULT_CONTEXT);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'non-main-frame');
  });

  it('skips chrome:// URLs', () => {
    const result = shouldCaptureNavigation(
      makeDetails({ url: 'chrome://extensions' }),
      DEFAULT_CONTEXT,
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'internal-url');
  });

  it('skips chrome-extension:// URLs', () => {
    const result = shouldCaptureNavigation(
      makeDetails({ url: 'chrome-extension://abc/popup.html' }),
      DEFAULT_CONTEXT,
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'internal-url');
  });

  it('skips about: URLs', () => {
    const result = shouldCaptureNavigation(makeDetails({ url: 'about:blank' }), DEFAULT_CONTEXT);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'internal-url');
  });

  it('skips null/empty URLs', () => {
    const result = shouldCaptureNavigation(makeDetails({ url: '' }), DEFAULT_CONTEXT);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'internal-url');
  });

  it('skips auto_subframe transitions', () => {
    const result = shouldCaptureNavigation(
      makeDetails({ transitionType: 'auto_subframe' }),
      DEFAULT_CONTEXT,
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'subframe-transition');
  });

  it('skips manual_subframe transitions', () => {
    const result = shouldCaptureNavigation(
      makeDetails({ transitionType: 'manual_subframe' }),
      DEFAULT_CONTEXT,
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'subframe-transition');
  });
});

// ─── Browser chrome types ─────────────────────────────────────────────────────

describe('shouldCaptureNavigation — browser chrome types', () => {
  for (const type of ['typed', 'generated', 'reload', 'auto_bookmark', 'start_page', 'keyword']) {
    it(`captures ${type} navigation`, () => {
      const result = shouldCaptureNavigation(
        makeDetails({ transitionType: type }),
        DEFAULT_CONTEXT,
      );
      assert.equal(result.action, 'capture');
      assert.equal(result.navType, type);
    });
  }

  it('captures back_forward via qualifier override', () => {
    const result = shouldCaptureNavigation(
      makeDetails({ transitionType: 'link', transitionQualifiers: ['forward_back'] }),
      DEFAULT_CONTEXT,
    );
    assert.equal(result.action, 'capture');
    assert.equal(result.navType, 'back_forward');
  });
});

// ─── In-page action types (should be skipped) ─────────────────────────────────

describe('shouldCaptureNavigation — in-page actions skipped', () => {
  for (const type of ['link', 'form_submit', 'auto_toplevel']) {
    it(`skips ${type} navigation (in-page action)`, () => {
      const result = shouldCaptureNavigation(
        makeDetails({ transitionType: type }),
        DEFAULT_CONTEXT,
      );
      assert.equal(result.action, 'skip');
      assert.equal(result.reason, 'in-page-action');
    });
  }
});

// ─── Tab creation suppression ─────────────────────────────────────────────────

describe('shouldCaptureNavigation — tab creation suppression', () => {
  it('suppresses navigation on recently created tab', () => {
    const context = { ...DEFAULT_CONTEXT, lastTabCreatedTimestamp: 9500, now: 10000 };
    const result = shouldCaptureNavigation(makeDetails({ transitionType: 'typed' }), context);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'recent-tab-created');
  });

  it('allows link navigation on recently created tab (Open in new tab)', () => {
    const context = { ...DEFAULT_CONTEXT, lastTabCreatedTimestamp: 9500, now: 10000 };
    const result = shouldCaptureNavigation(makeDetails({ transitionType: 'link' }), context);
    assert.equal(result.action, 'capture');
    assert.equal(result.navType, 'link');
  });

  it('does not suppress after suppression window expires', () => {
    const context = { ...DEFAULT_CONTEXT, lastTabCreatedTimestamp: 5000, now: 10000 };
    const result = shouldCaptureNavigation(makeDetails({ transitionType: 'typed' }), context);
    assert.equal(result.action, 'capture');
  });
});

// ─── Redirect suppression ─────────────────────────────────────────────────────

describe('shouldCaptureNavigation — redirect suppression', () => {
  it('skips server redirects', () => {
    const result = shouldCaptureNavigation(
      makeDetails({ transitionType: 'typed', transitionQualifiers: ['server_redirect'] }),
      DEFAULT_CONTEXT,
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'redirect');
  });

  it('skips client redirects', () => {
    const result = shouldCaptureNavigation(
      makeDetails({ transitionType: 'typed', transitionQualifiers: ['client_redirect'] }),
      DEFAULT_CONTEXT,
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'redirect');
  });
});

// ─── URL deduplication ────────────────────────────────────────────────────────

describe('shouldCaptureNavigation — URL deduplication', () => {
  it('skips duplicate URL (same as last)', () => {
    const context = { ...DEFAULT_CONTEXT, lastTabNavUrl: 'https://example.com' };
    const result = shouldCaptureNavigation(makeDetails(), context);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'duplicate-url');
  });

  it('skips duplicate URL with trailing slash difference', () => {
    const context = { ...DEFAULT_CONTEXT, lastTabNavUrl: 'https://example.com' };
    const result = shouldCaptureNavigation(makeDetails({ url: 'https://example.com/' }), context);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'duplicate-url');
  });

  it('does not deduplicate reloads', () => {
    const context = { ...DEFAULT_CONTEXT, lastTabNavUrl: 'https://example.com' };
    const result = shouldCaptureNavigation(makeDetails({ transitionType: 'reload' }), context);
    assert.equal(result.action, 'capture');
    assert.equal(result.navType, 'reload');
  });

  it('captures when URL is different from last', () => {
    const context = { ...DEFAULT_CONTEXT, lastTabNavUrl: 'https://other.com' };
    const result = shouldCaptureNavigation(makeDetails(), context);
    assert.equal(result.action, 'capture');
  });
});

// ─── shouldCaptureTabCreated ──────────────────────────────────────────────────

describe('shouldCaptureTabCreated — basic decisions', () => {
  it('skips when not recording', () => {
    const result = shouldCaptureTabCreated(
      { id: 1, openerTabId: null, url: 'chrome://newtab/' },
      { isRecording: false, hadRecentUserAction: false, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'not-recording');
  });

  it('suppresses programmatic tab (recent user action = window.open)', () => {
    const result = shouldCaptureTabCreated(
      { id: 2, openerTabId: 1, url: 'https://popup.example.com' },
      { isRecording: true, hadRecentUserAction: true, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'suppress_programmatic');
    assert.equal(result.reason, 'recent-user-action');
  });

  it('captures Ctrl+T (no recent user action, no opener)', () => {
    const result = shouldCaptureTabCreated(
      { id: 3, openerTabId: null, url: 'chrome://newtab/' },
      { isRecording: true, hadRecentUserAction: false, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'capture');
  });

  it('captures Ctrl+N (new window, no recent user action)', () => {
    const result = shouldCaptureTabCreated(
      { id: 4, openerTabId: null, url: null },
      { isRecording: true, hadRecentUserAction: false, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'capture');
  });
});

describe('shouldCaptureTabCreated — session restore (Ctrl+Shift+T, manual test 8)', () => {
  it('captures session restore (Ctrl+Shift+T) as context_open', () => {
    // Session restore creates a tab with the restored URL and no recent user action.
    // Chrome sets openerTabId to undefined for restored tabs.
    const result = shouldCaptureTabCreated(
      { id: 5, openerTabId: undefined, url: 'https://previously-closed.example.com' },
      { isRecording: true, hadRecentUserAction: false, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'capture');
  });

  it('captures session restore even when tab has a URL', () => {
    // Restored tabs immediately have their previous URL
    const result = shouldCaptureTabCreated(
      { id: 6, openerTabId: undefined, url: 'https://docs.example.com/page' },
      { isRecording: true, hadRecentUserAction: false, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'capture');
  });

  it('suppresses if user action happened just before restore (edge case)', () => {
    // If user clicked something and then immediately Ctrl+Shift+T,
    // the timing window might still be active — this is the known trade-off
    const result = shouldCaptureTabCreated(
      { id: 7, openerTabId: undefined, url: 'https://restored.example.com' },
      { isRecording: true, hadRecentUserAction: true, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'suppress_programmatic');
    assert.equal(result.reason, 'recent-user-action');
  });
});

describe('shouldCaptureTabCreated — link target=_blank suppression', () => {
  it('suppresses target=_blank link (recent user action + openerTabId)', () => {
    const result = shouldCaptureTabCreated(
      { id: 8, openerTabId: 1, url: 'https://external.example.com' },
      { isRecording: true, hadRecentUserAction: true, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'suppress_programmatic');
  });

  it('captures if opener present but no recent user action (manual open-in-new-tab)', () => {
    // Right-click → "Open in new tab" doesn't trigger content script action
    const result = shouldCaptureTabCreated(
      { id: 9, openerTabId: 1, url: 'https://example.com/page' },
      { isRecording: true, hadRecentUserAction: false, userActionWindowMs: 500 },
    );
    assert.equal(result.action, 'capture');
  });
});
