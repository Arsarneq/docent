/**
 * dispatch-cooldown.js — Post-send cooldown + rapid-resend guard (panel layer)
 *
 * Platform-agnostic state for the UI half of SECURITY_BACKLOG S4. The core half
 * (exponential backoff on 429/5xx) lives in dispatch-core.js `sendPayload`; this
 * module is the complementary client-side guard that stops a user hammering the
 * Send button: after a successful dispatch the button is held disabled for a
 * short cooldown, which also serves as the "you just sent this" rapid-resend
 * guard.
 *
 * Pure and time-injectable so it can be unit-tested without timers. The panels
 * (`packages/extension/sidepanel/panel.js`, `packages/desktop/src/panel.js`)
 * own the DOM wiring; this module owns only the elapsed-time bookkeeping.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** Default cooldown window after a successful dispatch, in milliseconds. */
export const DISPATCH_COOLDOWN_MS = 5000;

/**
 * Create a dispatch cooldown tracker.
 *
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs=DISPATCH_COOLDOWN_MS] — cooldown length.
 * @param {() => number} [opts.now=Date.now] — clock source (injectable for tests).
 * @returns {{
 *   markSent: () => void,
 *   remainingMs: () => number,
 *   canSend: () => boolean,
 *   reset: () => void,
 * }}
 */
export function createDispatchCooldown({ cooldownMs = DISPATCH_COOLDOWN_MS, now = Date.now } = {}) {
  let lastSendAt = null;

  /** Milliseconds left in the cooldown window; 0 once elapsed or never sent. */
  function remainingMs() {
    if (lastSendAt === null) return 0;
    const elapsed = now() - lastSendAt;
    if (elapsed < 0) return 0; // clock skew — never report a negative/over-long wait
    return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
  }

  return {
    /** Record a successful dispatch as having happened now. */
    markSent() {
      lastSendAt = now();
    },

    remainingMs,

    /** True when a new dispatch is permitted (cooldown elapsed). */
    canSend() {
      return remainingMs() === 0;
    },

    /** Clear the cooldown (e.g. when dispatch settings change). */
    reset() {
      lastSendAt = null;
    },
  };
}
