/**
 * recorder-logic.test.js — Unit tests for extracted content script logic.
 *
 * Tests selectorFor() and describeElement() with mock DOM elements.
 * No browser required.
 *
 * Covers issue #31.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectorFor, describeElement, cssEscape } from '../../content/recorder-logic.js';

// ─── Mock DOM helpers ─────────────────────────────────────────────────────────

function createElement(tag, { id, type, name, role, text, value, parent, siblings } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    id: id || '',
    type: type || null,
    innerText: text,
    value: value,
    parentElement: parent || null,
    children: [],
    getAttribute(attr) {
      if (attr === 'name') return name || null;
      if (attr === 'role') return role || null;
      if (attr === 'type') return type || null;
      return null;
    },
  };
  if (parent) {
    if (!parent.children.includes(el)) {
      parent.children.push(el);
    }
  }
  if (siblings) {
    // Add siblings to parent's children
    for (const sib of siblings) {
      if (!el.parentElement.children.includes(sib)) {
        el.parentElement.children.push(sib);
      }
    }
  }
  return el;
}

// ─── cssEscape ────────────────────────────────────────────────────────────────

describe('cssEscape', () => {
  it('escapes special characters', () => {
    assert.equal(cssEscape('my.class'), 'my\\.class');
    assert.equal(cssEscape('has:colon'), 'has\\:colon');
    assert.equal(cssEscape('with space'), 'with\\ space');
  });

  it('does not escape alphanumeric and hyphens', () => {
    assert.equal(cssEscape('normal-id'), 'normal-id');
    assert.equal(cssEscape('btn_submit'), 'btn_submit');
    assert.equal(cssEscape('item123'), 'item123');
  });
});

// ─── selectorFor ──────────────────────────────────────────────────────────────

describe('selectorFor', () => {
  it('returns #id when element has an id', () => {
    const el = createElement('button', { id: 'submit-btn' });
    assert.equal(selectorFor(el), '#submit-btn');
  });

  it('escapes special characters in id', () => {
    const el = createElement('div', { id: 'my.element' });
    assert.equal(selectorFor(el), '#my\\.element');
  });

  it('returns tag name when no id and no parent', () => {
    const el = createElement('button');
    assert.equal(selectorFor(el), 'button');
  });

  it('adds nth-of-type when siblings have same tag', () => {
    const parent = createElement('div');
    const sib1 = createElement('button', { parent });
    const sib2 = createElement('button', { parent });
    parent.children = [sib1, sib2];
    sib1.parentElement = parent;
    sib2.parentElement = parent;

    assert.equal(selectorFor(sib1), 'div > button:nth-of-type(1)');
    assert.equal(selectorFor(sib2), 'div > button:nth-of-type(2)');
  });

  it('does not add nth-of-type when only child of its type', () => {
    const parent = createElement('div');
    const child = createElement('button', { parent });
    const otherChild = createElement('span', { parent });
    parent.children = [child, otherChild];
    child.parentElement = parent;

    // Walks up: button (only button sibling) > div (no parent)
    assert.equal(selectorFor(child), 'div > button');
  });

  it('walks up to 3 levels', () => {
    const grandparent = createElement('section');
    const parent = createElement('div', { parent: grandparent });
    parent.parentElement = grandparent;
    grandparent.children = [parent];
    const child = createElement('span', { parent });
    child.parentElement = parent;
    parent.children = [child];

    const selector = selectorFor(child);
    // Should include up to 3 levels: section > div > span
    assert.ok(selector.includes('span'), 'Should include the element tag');
  });

  it('stops at stopAt element', () => {
    const body = createElement('body');
    const parent = createElement('div', { parent: body });
    parent.parentElement = body;
    body.children = [parent];
    const child = createElement('button', { parent });
    child.parentElement = parent;
    parent.children = [child];

    const selector = selectorFor(child, body);
    // Should not include body in the selector
    assert.ok(!selector.includes('body'));
  });

  it('stops early when ancestor has id', () => {
    const parent = createElement('div', { id: 'container' });
    const child = createElement('button', { parent });
    child.parentElement = parent;
    parent.children = [child];

    const selector = selectorFor(child);
    assert.equal(selector, '#container > button');
  });
});

// ─── describeElement ──────────────────────────────────────────────────────────

describe('describeElement', () => {
  it('returns all fields for a basic element', () => {
    const el = createElement('button', { id: 'btn', text: 'Click me', role: 'button' });
    const desc = describeElement(el);

    assert.equal(desc.tag, 'BUTTON');
    assert.equal(desc.id, 'btn');
    assert.equal(desc.role, 'button');
    assert.equal(desc.text, 'Click me');
    assert.equal(desc.selector, '#btn');
  });

  it('returns null for empty optional fields', () => {
    const el = createElement('div');
    const desc = describeElement(el);

    assert.equal(desc.id, null);
    assert.equal(desc.name, null);
    assert.equal(desc.role, null);
    assert.equal(desc.type, null);
  });

  it('masks password field text', () => {
    const el = createElement('input', { type: 'password', value: 'secret123' });
    const desc = describeElement(el);

    assert.equal(desc.text, null);
    assert.equal(desc.type, 'password');
  });

  it('truncates text to 100 characters', () => {
    const longText = 'A'.repeat(200);
    const el = createElement('p', { text: longText });
    const desc = describeElement(el);

    assert.equal(desc.text.length, 100);
  });

  it('uses value when innerText is undefined', () => {
    const el = createElement('input', { value: 'typed text' });
    el.innerText = undefined;
    const desc = describeElement(el);

    assert.equal(desc.text, 'typed text');
  });

  it('trims whitespace from text', () => {
    const el = createElement('span', { text: '  hello world  ' });
    const desc = describeElement(el);

    assert.equal(desc.text, 'hello world');
  });
});
