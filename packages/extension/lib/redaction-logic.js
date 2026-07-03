// Sensitive-data redaction at the storage chokepoint — pure logic, extracted
// so the unit suite exercises the REAL function instead of a hand-copied
// replica (the same single-source discipline as frame-trust.js). The content
// script already masks passwords inline (native `type=password` signal); this
// catches the rest with the SHARED field-sensitivity util, before anything is
// persisted:
//   - a sensitive non-password field (cc/ssn/secret/payment-autocomplete) has
//     its value masked and its element text nulled + flagged `redacted`;
//   - its value-derived locator entries (`text` strategy — the strategies the
//     schema annotates `x-value-derived`) have their value masked IN PLACE
//     with `masked: true` — the entry is kept, never omitted, and its match
//     statistics (measured pre-masking at capture) stay untouched.
//     Identity-derived entries (id/test_id/name/…) are markup, not user data,
//     and are never masked;
//   - a `navigate` URL has its sensitive query-param values stripped.
// The service worker owns the pendingActions write sites and applies this at
// each of them; this only masks. Mutates the soon-to-be-stored action in place.
//
// This file is part of Docent.
// Licensed under the GNU General Public License v3.0
// See LICENSE in the project root for license information.

import { isSensitiveField, redactUrl, SENSITIVE_MASK } from '../shared/lib/field-sensitivity.js';

export function redactSensitive(action) {
  if (!action || typeof action !== 'object') return action;
  const el = action.element;
  if (el && typeof el === 'object' && !el.redacted && isSensitiveField(el)) {
    if (typeof action.value === 'string') action.value = SENSITIVE_MASK;
    el.text = null;
    el.redacted = true;
    if (Array.isArray(el.locators)) {
      for (const loc of el.locators) {
        if (loc && loc.strategy === 'text' && typeof loc.value === 'string') {
          loc.value = SENSITIVE_MASK;
          loc.masked = true;
        }
      }
    }
  }
  if (action.type === 'navigate' && typeof action.url === 'string') {
    action.url = redactUrl(action.url);
  }
  return action;
}
