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

/** Suppress synthetic clicks from Enter key activation (detail=0). */
export const ENTER_SYNTHETIC_CLICK_WINDOW = 50;

/** Suppress synthetic clicks from native select confirmation. */
export const SELECT_SYNTHETIC_CLICK_WINDOW = 50;

/** Correlate focus events with a preceding Tab key press. */
export const TAB_FOCUS_CORRELATION_WINDOW = 150;

/** Suppress click-caused focus on the same element. */
export const CLICK_FOCUS_DEDUP_WINDOW = 100;

// ─── Service Worker Timing ──────────────────────────────────────────────────

/**
 * Determine if a tab creation is a side-effect of window.open().
 *
 * Trade-off at 500ms:
 * - Too short → window.open() from async handlers leaks context_open.
 * - Too long → Ctrl+T shortly after a click is wrongly suppressed.
 */
export const TAB_CREATED_USER_ACTION_WINDOW = 500;

/**
 * Determine if a programmatic tab close is from window.close().
 * Only applies to tabs in the programmaticTabs set.
 *
 * Trade-off at 2000ms:
 * - Too short → delayed window.close() leaks context_close.
 * - Too long → user closing a programmatic tab shortly after a click is suppressed.
 */
export const TAB_CLOSED_USER_ACTION_WINDOW = 2000;

/** Suppress auto-switch after tab creation. Fallback for per-tab ID tracking. */
export const TAB_CREATED_SWITCH_SUPPRESSION = 100;

/** Suppress auto-switch after tab close. */
export const TAB_REMOVED_SWITCH_SUPPRESSION = 100;

/** Suppress cascading navigations after tab creation (e.g. Ctrl+Shift+T reload). */
export const TAB_CREATED_NAVIGATION_SUPPRESSION = 100;
