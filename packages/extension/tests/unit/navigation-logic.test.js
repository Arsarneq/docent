/**
 * navigation-logic.test.js — Unit tests for navigation capture decision logic.
 *
 * Tests shouldCaptureNavigation() with all transition types and timing states,
 * classifyNavigation()'s append path and isDuplicateNavigation()'s reload
 * exemption, and shouldCaptureTabCreated() for context_open decisions (Ctrl+T,
 * Ctrl+Shift+T). A static-source guard reads the service worker and holds that
 * its listeners decide through this module and state no transition rule of
 * their own, so a rule lives in one place, where these cases test it.
 *
 * Covers issue #32.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyNavigation,
  isDuplicateNavigation,
  normaliseNavigationUrl,
  shouldCaptureNavigation,
  shouldCaptureTabCreated,
} from '../../lib/navigation-logic.js';
// The shared source views: by default comments and literal contents are
// blanked (a scan for call shapes reads code only); `{ literals: false }` drops
// comments and keeps literals (a scan for an import specifier or a literal).
import { blankJsLiterals } from '../../../../scripts/check-test-inventory.js';

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

// ─── classifyNavigation / isDuplicateNavigation ───────────────────────────────

describe('classifyNavigation — append path', () => {
  it('routes a link commit inside the new-tab window to the new-tab-link path', () => {
    const result = classifyNavigation(makeDetails({ transitionType: 'link' }), {
      ...DEFAULT_CONTEXT,
      lastTabCreatedTimestamp: 9500,
    });
    assert.deepEqual(result, { action: 'capture', navType: 'link', path: 'new-tab-link' });
  });

  it('routes a browser chrome commit to the browser-chrome path', () => {
    const result = classifyNavigation(
      makeDetails({ transitionType: 'reload', transitionQualifiers: ['forward_back'] }),
      DEFAULT_CONTEXT,
    );
    assert.deepEqual(result, {
      action: 'capture',
      navType: 'back_forward',
      path: 'browser-chrome',
    });
  });

  it('leaves the duplicate check to the caller', () => {
    const result = classifyNavigation(makeDetails(), {
      ...DEFAULT_CONTEXT,
      lastTabNavUrl: 'https://example.com',
    });
    assert.equal(result.action, 'capture');
    assert.equal(result.path, 'browser-chrome');
  });
});

describe('isDuplicateNavigation / normaliseNavigationUrl', () => {
  it('strips one trailing slash', () => {
    assert.equal(normaliseNavigationUrl('https://example.com/a/'), 'https://example.com/a');
    assert.equal(normaliseNavigationUrl('https://example.com/a'), 'https://example.com/a');
  });

  it('counts a repeat of the last recorded URL as a duplicate', () => {
    assert.equal(
      isDuplicateNavigation('https://example.com', 'typed', 'https://example.com'),
      true,
    );
    assert.equal(isDuplicateNavigation('https://example.com', 'typed', 'https://other.com'), false);
    assert.equal(isDuplicateNavigation('https://example.com', 'typed', undefined), false);
  });

  it('never counts a reload as a duplicate', () => {
    assert.equal(
      isDuplicateNavigation('https://example.com', 'reload', 'https://example.com'),
      false,
    );
  });

  it('keys the reload exemption on the classified nav type, not the transition', () => {
    // A forward_back-qualified reload classifies as back_forward and is deduped.
    assert.equal(
      isDuplicateNavigation('https://example.com', 'back_forward', 'https://example.com'),
      true,
    );
  });
});

// ─── The worker decides through this module ───────────────────────────────────

const SW_SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../background/service-worker.js'),
  'utf8',
);

/**
 * The argument span of the first call that starts at `marker` in `code` (a
 * blanked view, so no parenthesis inside a literal or comment is counted).
 * @param {string} code
 * @param {string} marker
 * @returns {string}
 */
function callSpan(code, marker) {
  const start = code.indexOf(marker);
  assert.notEqual(start, -1, `service-worker.js has no ${marker}`);
  const open = start + marker.length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(open, i + 1);
  }
  assert.fail(`unbalanced call at ${marker}`);
}

// Chrome's transition types and transition qualifiers (chrome.webNavigation
// TransitionType and TransitionQualifier, chrome.history TransitionType), and
// the nav type the forward_back qualifier derives.
const TRANSITION_NAMES = [
  'link',
  'typed',
  'auto_bookmark',
  'auto_subframe',
  'manual_subframe',
  'generated',
  'auto_toplevel',
  'start_page',
  'form_submit',
  'reload',
  'keyword',
  'keyword_generated',
  'client_redirect',
  'server_redirect',
  'forward_back',
  'from_address_bar',
  'back_forward',
];

describe('service worker — navigation decisions come from lib/navigation-logic.js', () => {
  it('imports the decision functions and calls them from its listeners', () => {
    // The import specifier is a string, which the default view blanks.
    const withLiterals = blankJsLiterals(SW_SOURCE, { literals: false });
    const imports = [
      ...withLiterals.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/lib\/navigation-logic\.js['"]/g,
      ),
    ];
    assert.equal(imports.length, 1, 'one import from ../lib/navigation-logic.js');
    const names = imports[0][1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(names, [
      'classifyNavigation',
      'isDuplicateNavigation',
      'normaliseNavigationUrl',
      'shouldCaptureTabCreated',
    ]);

    const code = blankJsLiterals(SW_SOURCE);
    const committed = callSpan(code, 'chrome.webNavigation.onCommitted.addListener(');
    for (const fn of ['classifyNavigation', 'normaliseNavigationUrl', 'isDuplicateNavigation']) {
      assert.match(committed, new RegExp(`\\b${fn}\\s*\\(`), `onCommitted calls ${fn}`);
    }
    const created = callSpan(code, 'chrome.tabs.onCreated.addListener(');
    assert.match(
      created,
      /\bshouldCaptureTabCreated\s*\(/,
      'onCreated calls shouldCaptureTabCreated',
    );
  });

  it('states no transition type or qualifier as a literal of its own', () => {
    // Comments are dropped and literals kept; only a literal whose whole content
    // is a listed name counts, so a name inside a longer string is not a rule.
    const lines = blankJsLiterals(SW_SOURCE, { literals: false }).split('\n');
    const hits = [];
    lines.forEach((line, i) => {
      for (const name of TRANSITION_NAMES) {
        for (const q of ["'", '"', '`']) {
          if (line.includes(q + name + q)) hits.push(`${i + 1}: ${q}${name}${q}`);
        }
      }
    });
    assert.deepEqual(hits, [], 'transition rules live in lib/navigation-logic.js');
  });
});
