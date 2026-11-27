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
//   - a `key` that enters a character on a sensitive field names that
//     character, so it is stored as the field's masked `type` instead;
//   - a `navigate` URL has its sensitive query-param values stripped.
// The service worker owns the pendingActions write sites and applies
// `redactSensitive` at each of them; it mutates the soon-to-be-stored action
// in place. `repeatsMaskedEntry` is the test the one append path runs so that
// a masked `type` is not stored twice in a row for one field.
//
// This file is part of Docent.
// Licensed under the GNU General Public License v3.0
// See LICENSE in the project root for license information.

import { isSensitiveField, redactUrl, SENSITIVE_MASK } from '../shared/lib/field-sensitivity.js';

/** The `input` types that take no typed text: a key pressed on one presses or toggles it. */
export const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'file',
  'image',
  'radio',
  'reset',
  'submit',
]);
/** The tags of the controls that take no typed text. */
export const NON_TEXT_TAGS = new Set(['A', 'BUTTON', 'SUMMARY']);
/** The roles of the controls that take no typed text. */
export const NON_TEXT_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'switch',
  'tab',
]);

/**
 * Whether a key pressed on the element presses or toggles it, whatever its
 * name says: a control that takes no typed text. The desktop keeps the same
 * rule by its own control types (buttons, links, checkboxes, radio buttons,
 * menu items, tabs), and a list is on neither platform's list: a character
 * pressed on one picks the option that starts with it.
 */
export function takesNoTypedText(el) {
  const tag = typeof el.tag === 'string' ? el.tag.toUpperCase() : '';
  if (NON_TEXT_TAGS.has(tag)) return true;
  if (
    tag === 'INPUT' &&
    typeof el.type === 'string' &&
    NON_TEXT_INPUT_TYPES.has(el.type.toLowerCase())
  ) {
    return true;
  }
  return typeof el.role === 'string' && NON_TEXT_ROLES.has(el.role.toLowerCase());
}

/**
 * Whether Alt held alone with a character key enters a character: on a Mac it
 * is the Option key, which enters characters of the layout. Everywhere else
 * Alt with a character key reaches for a menu and enters none.
 */
const ALT_ENTERS_CHARACTERS = /mac/i.test(globalThis.navigator?.platform ?? '');

/**
 * Whether a `key` action's key enters a character: its name is one character,
 * `Space` or a dead key, and no shortcut modifier is held. Meta, Ctrl without
 * Alt, and Alt without Ctrl make a shortcut (Alt alone only where it enters no
 * characters); Ctrl and Alt together is AltGr, which enters characters of the
 * layout. The recorder's `keyPressKind` and `isShortcut` state the same rule
 * on the event, and the recorder applies it first: this is the second test.
 *
 * The test reads the name the `key` action carries, so a change to how a key
 * is named (docent#717) has to keep it true for every key that enters a
 * character.
 *
 * @param {object} action — a `key` action
 * @param {boolean} [altEntersCharacters] — whether Alt alone enters characters
 * @returns {boolean}
 */
export function keyEntersText(action, altEntersCharacters = ALT_ENTERS_CHARACTERS) {
  const { ctrl = false, alt = false, meta = false } = action.modifiers || {};
  if (meta || (ctrl && !alt) || (alt && !ctrl && !altEntersCharacters)) return false;
  const key = action.key;
  if (typeof key !== 'string') return false;
  return key === 'Space' || key === 'Dead' || [...key].length === 1;
}

/**
 * Mask what an action would reveal of a sensitive field, in place.
 *
 * A `key` that enters a character on a sensitive field names that character,
 * so it is recorded as the field's masked `type` instead (#702); a key on a
 * control that takes no typed text stays a `key`.
 *
 * @param {object} action — the soon-to-be-stored action; mutated in place
 * @returns {object} the same action, for call-site chaining
 */
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
  if (
    action.type === 'key' &&
    el &&
    typeof el === 'object' &&
    el.redacted === true &&
    keyEntersText(action) &&
    !takesNoTypedText(el)
  ) {
    delete action.key;
    delete action.modifiers;
    delete action.repeat;
    delete action.code;
    delete action.input_method_open;
    delete action.input_method_conversion_mode;
    delete action.held_keys;
    action.type = 'type';
    action.value = SENSITIVE_MASK;
  }
  if (action.type === 'navigate' && typeof action.url === 'string') {
    action.url = redactUrl(action.url);
  }
  return action;
}

/** The field a masked `type` is on, or null for any other action. */
function maskedEntryField(action) {
  const el = action && action.element;
  if (!action || action.type !== 'type' || action.value !== SENSITIVE_MASK) return null;
  if (!el || el.redacted !== true || typeof el.selector !== 'string' || el.selector === '') {
    return null;
  }
  return { context: action.context_id, frame: action.frame_src ?? null, selector: el.selector };
}

/**
 * Typing into a sensitive field is one masked `type`: whether `action` is a
 * masked `type` on the field the action stored just before it is already a
 * masked `type` on. Such an action says nothing the one before it does not
 * (a key recorded as the field's masked `type` beside another, or beside the
 * `type` the field itself writes), so it is not stored again. Any other
 * action between two of them, another field, frame or context, and a field
 * with no selector each keep both.
 *
 * @param {object|undefined} previous — the action stored last, if any
 * @param {object} action — the action about to be stored, already redacted
 * @returns {boolean}
 */
export function repeatsMaskedEntry(previous, action) {
  const before = maskedEntryField(previous);
  const now = maskedEntryField(action);
  return (
    !!before &&
    !!now &&
    before.context === now.context &&
    before.frame === now.frame &&
    before.selector === now.selector
  );
}
