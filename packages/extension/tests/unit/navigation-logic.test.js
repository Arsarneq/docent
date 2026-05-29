/**
 * navigation-logic.test.js — Unit tests for navigation capture decision logic.
 *
 * Tests shouldCaptureNavigation() with all transition types and timing states.
 *
 * Covers issue #32.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCaptureNavigation } from '../../lib/navigation-logic.js';

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
