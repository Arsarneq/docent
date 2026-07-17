/**
 * navigation-logic.js — Pure navigation capture decision logic.
 *
 * Extracted from service-worker.js for unit testability.
 * Determines whether a webNavigation.onCommitted event should be captured
 * and what nav_type to assign, and whether a tabs.onCreated event should
 * produce a context_open action.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 */
// Governance declared in scripts/area-map.json (see its declared-governance entry): decides when a navigate or context_open action enters the stream, so it bears on the format's context-introduction rule; the per-platform schemas are authoritative for field semantics.

/**
 * URLs that should never be captured.
 */
const SKIP_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'about:'];

/**
 * Transition types that are sub-frame navigations (handled by content script).
 */
const SKIP_TRANSITION_TYPES = new Set(['auto_subframe', 'manual_subframe']);

/**
 * Browser chrome navigation types — these represent user actions in the browser
 * UI (address bar, bookmarks, back/forward buttons) and should be captured.
 */
const BROWSER_CHROME_TYPES = new Set([
  'typed',
  'generated',
  'reload',
  'back_forward',
  'auto_bookmark',
  'start_page',
  'keyword',
]);

/**
 * Determine whether a navigation event should be captured and what type it is.
 *
 * @param {object} details — webNavigation.onCommitted details
 * @param {string} details.url
 * @param {number} details.frameId
 * @param {string} details.transitionType
 * @param {string[]} [details.transitionQualifiers]
 * @param {number} details.tabId
 * @param {object} context — timing context
 * @param {number} context.lastTabCreatedTimestamp
 * @param {number} context.now — current timestamp
 * @param {string|null} context.lastTabNavUrl — last recorded URL (for dedup)
 * @param {number} context.tabCreatedSuppressionMs — suppression window
 * @returns {{ action: 'capture'|'skip', navType?: string, reason?: string }}
 */
export function shouldCaptureNavigation(details, context) {
  // Non-main frame — skip
  if (details.frameId !== 0) {
    return { action: 'skip', reason: 'non-main-frame' };
  }

  // Internal URLs — skip
  if (!details.url || SKIP_URL_PREFIXES.some((p) => details.url.startsWith(p))) {
    return { action: 'skip', reason: 'internal-url' };
  }

  // Sub-frame transition types — skip
  if (SKIP_TRANSITION_TYPES.has(details.transitionType)) {
    return { action: 'skip', reason: 'subframe-transition' };
  }

  // Recently created tab — suppress most navigations
  const timeSinceTabCreated = context.now - context.lastTabCreatedTimestamp;
  if (timeSinceTabCreated < context.tabCreatedSuppressionMs) {
    if (details.transitionType === 'link') {
      // Exception: "Open in new tab" context menu
      return { action: 'capture', navType: 'link' };
    }
    return { action: 'skip', reason: 'recent-tab-created' };
  }

  // Determine nav type (qualifiers can override)
  const qualifiers = details.transitionQualifiers ?? [];
  let navType = details.transitionType;
  if (qualifiers.includes('forward_back')) navType = 'back_forward';

  // Only capture browser chrome types
  if (!BROWSER_CHROME_TYPES.has(navType)) {
    return { action: 'skip', reason: 'in-page-action' };
  }

  // Redirect hops — skip
  if (qualifiers.includes('server_redirect') || qualifiers.includes('client_redirect')) {
    return { action: 'skip', reason: 'redirect' };
  }

  // Deduplication (except reloads)
  if (navType !== 'reload') {
    const normalised = details.url.replace(/\/$/, '');
    if (normalised === context.lastTabNavUrl) {
      return { action: 'skip', reason: 'duplicate-url' };
    }
  }

  return { action: 'capture', navType };
}

/**
 * Determine whether a tabs.onCreated event should produce a context_open action.
 *
 * Browser chrome actions (Ctrl+T, Ctrl+N, Ctrl+Shift+T session restore) produce
 * context_open. Programmatic tab opens (window.open, link target=_blank) are
 * suppressed because the content script already captured the triggering action.
 *
 * Distinguishing signal: if there was a recent in-page user action (within the
 * suppression window), the tab creation is a side-effect. Otherwise it's a
 * deliberate browser chrome action.
 *
 * @param {object} tab — chrome.tabs.onCreated tab object
 * @param {number|null} tab.id — tab ID
 * @param {number|null|undefined} tab.openerTabId — opener tab (set for window.open)
 * @param {string|null|undefined} tab.url — initial URL
 * @param {object} context — timing context
 * @param {boolean} context.isRecording — whether capture is active
 * @param {boolean} context.hadRecentUserAction — whether an in-page action occurred recently
 * @param {number} context.userActionWindowMs — suppression window in ms
 * @returns {{ action: 'capture'|'skip'|'suppress_programmatic', reason?: string }}
 */
export function shouldCaptureTabCreated(tab, context) {
  // Not recording — skip entirely
  if (!context.isRecording) {
    return { action: 'skip', reason: 'not-recording' };
  }

  // Recent in-page user action → tab is a side-effect (window.open, target=_blank)
  if (context.hadRecentUserAction) {
    return { action: 'suppress_programmatic', reason: 'recent-user-action' };
  }

  // Browser chrome action (Ctrl+T, Ctrl+N, Ctrl+Shift+T) → capture as context_open
  return { action: 'capture' };
}
