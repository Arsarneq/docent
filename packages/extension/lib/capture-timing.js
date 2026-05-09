/**
 * Capture Timing Configuration
 *
 * Central configuration for all timing windows used to distinguish
 * user actions from side-effects. All values in milliseconds.
 *
 * These windows exist because Chrome's APIs don't provide causality
 * information — we only know WHAT happened, not WHY. Timing is used
 * as a proxy to infer whether a browser event was caused by a preceding
 * in-page user action or by the user interacting with browser chrome.
 *
 * Rule of thumb: humans cannot perform two deliberate actions faster
 * than ~200ms apart. Anything under 100ms is reliably "same action."
 *
 * This file is imported by the service worker (ES module).
 * The content script (IIFE, not a module) duplicates these values inline
 * with a reference comment pointing here as the source of truth.
 */

// ─── Content Script Timing ──────────────────────────────────────────────────

/**
 * Window for suppressing synthetic clicks from Enter key activation.
 * When Enter is pressed on a button/link, the browser fires a synthetic
 * click (detail=0) within this window. Safe at 50ms — no human clicks
 * this fast after pressing Enter.
 */
export const ENTER_SYNTHETIC_CLICK_WINDOW = 50;

/**
 * Window for suppressing synthetic clicks from native select confirmation.
 * When an option is selected in a native <select>, the browser may fire
 * a synthetic click at the same timestamp. Safe at 50ms.
 */
export const SELECT_SYNTHETIC_CLICK_WINDOW = 50;

/**
 * Window for correlating focus events with a preceding Tab key press.
 * Focus is only captured if a Tab key was pressed within this window.
 * 150ms accounts for the 50ms setTimeout in the focusin handler plus
 * browser processing time.
 */
export const TAB_FOCUS_CORRELATION_WINDOW = 150;

/**
 * Window for suppressing click-caused focus on the same element.
 * When a user clicks an input, focusin fires before click. The 50ms
 * defer + this window suppresses the redundant focus.
 */
export const CLICK_FOCUS_DEDUP_WINDOW = 100;

// ─── Service Worker Timing ──────────────────────────────────────────────────

/**
 * Window for determining if a tab creation (context_open) is a side-effect
 * of an in-page user action (e.g. window.open from a click handler).
 *
 * If a user action occurred within this window before the tab was created,
 * the tab is considered programmatic (side-effect).
 *
 * Trade-off: Too short → window.open() from async handlers leaks through.
 * Too long → Ctrl+T pressed shortly after a click is wrongly suppressed.
 *
 * 500ms: catches immediate and short-async window.open() calls.
 * Risk: user pressing Ctrl+T within 500ms of a click (unlikely but possible).
 */
export const TAB_CREATED_USER_ACTION_WINDOW = 500;

/**
 * Window for determining if a tab close (context_close) of a programmatic
 * tab is caused by window.close() (side-effect) vs user action (Ctrl+W/X).
 *
 * Only applies to tabs in the programmaticTabs set. If a user action
 * occurred within this window, the close is assumed to be window.close().
 *
 * Trade-off: Too short → delayed window.close() leaks context_close.
 * Too long → user closing a programmatic tab shortly after a click is suppressed.
 *
 * 2000ms: catches window.close() with typical async delays.
 * Risk: user closing a programmatic tab within 2s of their last click.
 */
export const TAB_CLOSED_USER_ACTION_WINDOW = 2000;

/**
 * Window for suppressing auto-switch context_switch after a tab is created.
 * When a new tab opens, the browser auto-activates it — that's not a user action.
 * ELIMINATED: now uses per-tab ID tracking instead of a time window.
 * Kept as fallback for edge cases where the tab ID check fails.
 */
export const TAB_CREATED_SWITCH_SUPPRESSION = 100;

/**
 * Window for suppressing auto-switch context_switch after a tab is closed.
 * When a tab closes, the browser auto-activates another — that's not a user action.
 * ELIMINATED: now uses per-tab ID tracking instead of a time window.
 * Kept as fallback for edge cases where the tab ID check fails.
 */
export const TAB_REMOVED_SWITCH_SUPPRESSION = 100;

/**
 * Window for suppressing cascading navigations after a tab is created/reopened.
 * E.g. Ctrl+Shift+T reopens a tab and reloads its URL — the reload is a
 * cascading effect, not a separate user action. Fires within the same event
 * loop tick, so 100ms is more than sufficient.
 */
export const TAB_CREATED_NAVIGATION_SUPPRESSION = 100;
