/**
 * recorder-logic.js — Pure logic extracted from recorder.js
 *
 * Contains selectorFor() and describeElement() logic that can be
 * unit-tested without a real browser DOM.
 *
 * These functions accept a DOM-like element interface:
 * - el.id: string
 * - el.tagName: string (uppercase)
 * - el.type: string | null
 * - el.parentElement: element | null
 * - el.children: element[] (siblings via parentElement.children)
 * - el.getAttribute(name): string | null
 * - el.innerText: string | undefined
 * - el.value: string | undefined
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 */

/**
 * List of interactive element selectors used to find the best click target.
 */
export const INTERACTIVE_SELECTORS = [
  'a',
  'button',
  'label',
  'select',
  '[role="button"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="listitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="treeitem"]',
  '[role="gridcell"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="reset"]',
].join(', ');

/**
 * Escape a string for use in a CSS selector (simplified version for testing).
 * In the browser, CSS.escape() is used instead.
 * @param {string} str
 * @returns {string}
 */
export function cssEscape(str) {
  return str.replace(/([^\w-])/g, '\\$1');
}

/**
 * Build a CSS selector for an element by walking up the DOM tree.
 *
 * @param {object} el — DOM-like element
 * @param {object|null} stopAt — element to stop at (e.g. document.body)
 * @returns {string} CSS selector
 */
export function selectorFor(el, stopAt = null) {
  if (el.id) return `#${cssEscape(el.id)}`;

  const parts = [];
  let node = el;
  let depth = 0;

  while (node && node !== stopAt && depth < 3) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    const siblings = (node.parentElement?.children ?? []).filter((c) => c.tagName === node.tagName);
    if (siblings.length > 1) {
      part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
    depth++;
  }

  return parts.join(' > ');
}

/**
 * Describe a DOM element for capture output.
 *
 * @param {object} el — DOM-like element
 * @param {object|null} stopAt — passed to selectorFor
 * @returns {object} element description
 */
export function describeElement(el, stopAt = null) {
  const isPassword = el.type === 'password';
  return {
    tag: el.tagName,
    id: el.id || null,
    name: el.getAttribute?.('name') || null,
    role: el.getAttribute?.('role') || null,
    type: el.getAttribute?.('type') || null,
    // Captured so the service worker can flag sensitive payment fields via the
    // shared field-sensitivity util; the content script stays pattern-free.
    autocomplete: el.getAttribute?.('autocomplete') || null,
    text: isPassword ? null : (el.innerText ?? el.value ?? '').trim().slice(0, 100) || null,
    selector: selectorFor(el, stopAt),
    // Password value is masked at the type site; mark the element redacted.
    ...(isPassword && { redacted: true }),
  };
}

/**
 * Determine whether a scroll event should be captured.
 * Only significant scrolls (>200px in either axis) are recorded.
 *
 * @param {number} startY — scrollTop at scroll start
 * @param {number} startX — scrollLeft at scroll start
 * @param {number} endY — scrollTop at scroll end
 * @param {number} endX — scrollLeft at scroll end
 * @returns {{ capture: boolean, deltaY: number, deltaX: number }}
 */
export function shouldCaptureScroll(startY, startX, endY, endX) {
  const deltaY = Math.abs(endY - startY);
  const deltaX = Math.abs(endX - startX);
  return {
    capture: deltaY > 200 || deltaX > 200,
    deltaY: endY - startY,
    deltaX: endX - startX,
  };
}
