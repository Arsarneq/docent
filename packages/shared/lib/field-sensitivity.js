/**
 * field-sensitivity.js — detect sensitive form fields and redact tokened URLs.
 *
 * Docent captures real user actions, including values typed into fields. Some of
 * those values are sensitive (credit-card numbers, SSNs, secrets) and some URLs
 * carry auth tokens — none of which should be persisted into a `.docent.json`.
 * Passwords are already masked at capture (extension `type="password"`, desktop
 * UIA `IsPassword`); this module covers the rest with a SINGLE, shared pattern
 * set so both platforms stay in sync.
 *
 * It is imported by the JS module that each platform routes captured actions
 * through BEFORE they are stored — the extension service worker's
 * `appendSwAction` and the desktop adapter's action stream — so a sensitive value
 * is masked before it ever reaches storage. (The extension content script and the
 * desktop Rust capture layer cannot import modules, but they do not need to: they
 * only keep the native, signal-based password masking.)
 *
 * Detection is intentionally CONSERVATIVE. Docent's output is used to generate
 * tests, so masking a legitimate field (a username, an email, a search box)
 * destroys the product's value. We mask only on strong signals: the HTML
 * `autocomplete` payment tokens, and a tight name/id pattern for clearly
 * financial / secret / SSN fields.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** The mask substituted for a redacted value (same glyphs as the password mask). */
export const SENSITIVE_MASK = '••••••••';

/**
 * `autocomplete` tokens (HTML spec) that designate payment fields we always mask.
 * Matched case-insensitively against the full token value.
 */
const SENSITIVE_AUTOCOMPLETE = new Set([
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]);

/**
 * Tight name/id pattern for clearly sensitive fields. Deliberately narrow —
 * broad terms (`account`, `id`, `code`, `name`, `email`) are EXCLUDED so we never
 * mask a legitimate workflow field.
 */
const SENSITIVE_NAME_RE =
  /card.?number|cardnum|ccnum|credit.?card|cvv|cvc|csc|ssn|social.?security|routing|iban|sort.?code|account.?number|api.?key|secret|passw|pwd|\botp\b|tax.?id/i;

/**
 * Query-parameter NAMES whose VALUES {@link redactUrl} masks. Matched
 * case-insensitively against the exact param name; other params are preserved so
 * a captured workflow stays replayable.
 */
const SENSITIVE_PARAMS = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth',
  'authorization',
  'api_key',
  'apikey',
  'key',
  'secret',
  'client_secret',
  'password',
  'pwd',
  'session',
  'sessionid',
  'sid',
  'otp',
  'code',
  'signature',
  'sig',
  'sso',
]);

/**
 * Report whether a captured field should have its value redacted, from the
 * element's signals. `type === 'password'` is already masked at capture but is
 * honoured here too. Total over missing fields (the desktop UIA element has no
 * `autocomplete`).
 *
 * @param {{ type?: string|null, name?: string|null, id?: string|null, autocomplete?: string|null }} [element]
 * @returns {boolean}
 */
export function isSensitiveField(element) {
  if (!element || typeof element !== 'object') return false;
  const { type, name, id, autocomplete } = element;
  if (typeof type === 'string' && type.toLowerCase() === 'password') return true;
  if (
    typeof autocomplete === 'string' &&
    SENSITIVE_AUTOCOMPLETE.has(autocomplete.trim().toLowerCase())
  ) {
    return true;
  }
  if (typeof name === 'string' && SENSITIVE_NAME_RE.test(name)) return true;
  if (typeof id === 'string' && SENSITIVE_NAME_RE.test(id)) return true;
  return false;
}

/**
 * Return `url` with the VALUES of known-sensitive query parameters replaced by
 * {@link SENSITIVE_MASK}, leaving other params intact. A non-string or
 * unparseable URL is returned unchanged (best-effort; never throws).
 *
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  if (typeof url !== 'string' || url === '') return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, SENSITIVE_MASK);
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}
