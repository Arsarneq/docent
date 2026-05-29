/**
 * navigation-logic.js — Pure navigation capture decision logic.
 *
 * Extracted from service-worker.js for unit testability.
 * Determines whether a webNavigation.onCommitted event should be captured
 * and what nav_type to assign.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 */

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
