/**
 * render.test.js — Unit tests for shared rendering functions.
 *
 * Tests escapeHtml() and describeAction() from packages/shared/views/render.js
 * using the Node.js built-in test runner and assert module.
 *
 * Validates: Requirements 10.7
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, describeAction } from '../views/render.js';

// ─── escapeHtml ───────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    assert.equal(escapeHtml('a&b'), 'a&amp;b');
  });

  it('escapes less-than', () => {
    assert.equal(escapeHtml('a<b'), 'a&lt;b');
  });

  it('escapes greater-than', () => {
    assert.equal(escapeHtml('a>b'), 'a&gt;b');
  });

  it('escapes double quotes', () => {
    assert.equal(escapeHtml('a"b'), 'a&quot;b');
  });

  it('escapes single quotes', () => {
    assert.equal(escapeHtml("a'b"), 'a&#39;b');
  });

  it('escapes multiple special characters in one string', () => {
    assert.equal(
      escapeHtml('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('returns empty string for undefined input', () => {
    assert.equal(escapeHtml(undefined), '');
  });

  it('returns empty string for no arguments', () => {
    assert.equal(escapeHtml(), '');
  });

  it('returns the same string when no special characters', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
  });

  it('returns empty string for empty string input', () => {
    assert.equal(escapeHtml(''), '');
  });
});

// ─── describeAction — all v2.0.0 action types ────────────────────────────────

describe('describeAction', () => {

  // ── navigate ──────────────────────────────────────────────────────────

  it('describes navigate action with url', () => {
    const action = { type: 'navigate', url: 'https://example.com' };
    assert.equal(describeAction(action), 'https://example.com');
  });

  it('escapes HTML in navigate url', () => {
    const action = { type: 'navigate', url: '<script>' };
    assert.equal(describeAction(action), '&lt;script&gt;');
  });

  // ── click ─────────────────────────────────────────────────────────────

  it('describes click action with element text', () => {
    const action = { type: 'click', element: { text: 'Submit', selector: '#btn' } };
    assert.equal(describeAction(action), 'Submit');
  });

  it('describes click action falling back to selector', () => {
    const action = { type: 'click', element: { text: null, selector: '#btn' } };
    assert.equal(describeAction(action), '#btn');
  });

  it('describes click action with empty element', () => {
    const action = { type: 'click', element: {} };
    assert.equal(describeAction(action), '');
  });

  // ── right_click ───────────────────────────────────────────────────────

  it('describes right_click action with element text', () => {
    const action = { type: 'right_click', element: { text: 'Item', selector: '.item' } };
    assert.equal(describeAction(action), 'right-click Item');
  });

  it('describes right_click action falling back to selector', () => {
    const action = { type: 'right_click', element: { text: null, selector: '.item' } };
    assert.equal(describeAction(action), 'right-click .item');
  });

  // ── type ──────────────────────────────────────────────────────────────

  it('describes type action with selector and value', () => {
    const action = { type: 'type', element: { selector: '#email' }, value: 'user@test.com' };
    assert.equal(describeAction(action), '#email → "user@test.com"');
  });

  it('describes type action with empty value', () => {
    const action = { type: 'type', element: { selector: '#input' }, value: '' };
    assert.equal(describeAction(action), '#input → ""');
  });

  it('describes type action with missing value', () => {
    const action = { type: 'type', element: { selector: '#input' } };
    assert.equal(describeAction(action), '#input → ""');
  });

  // ── select ────────────────────────────────────────────────────────────

  it('describes select action with selector and value', () => {
    const action = { type: 'select', element: { selector: '#country' }, value: 'Norway' };
    assert.equal(describeAction(action), '#country → "Norway"');
  });

  it('describes select action with missing value', () => {
    const action = { type: 'select', element: { selector: '#dropdown' } };
    assert.equal(describeAction(action), '#dropdown → ""');
  });

  // ── key ───────────────────────────────────────────────────────────────

  it('describes key action without modifiers', () => {
    const action = {
      type: 'key',
      key: 'Enter',
      modifiers: { ctrl: false, shift: false, alt: false, meta: false },
      element: { selector: '#input' }
    };
    assert.equal(describeAction(action), 'Enter on #input');
  });

  it('describes key action with Ctrl modifier', () => {
    const action = {
      type: 'key',
      key: 'Tab',
      modifiers: { ctrl: true, shift: false, alt: false, meta: false },
      element: { selector: '#field' }
    };
    assert.equal(describeAction(action), 'Tab (Ctrl) on #field');
  });

  it('describes key action with Shift modifier', () => {
    const action = {
      type: 'key',
      key: 'Tab',
      modifiers: { ctrl: false, shift: true, alt: false, meta: false },
      element: { selector: '#field' }
    };
    assert.equal(describeAction(action), 'Tab (Shift) on #field');
  });

  it('describes key action with both Ctrl and Shift', () => {
    const action = {
      type: 'key',
      key: 'Escape',
      modifiers: { ctrl: true, shift: true, alt: false, meta: false },
      element: { selector: '.modal' }
    };
    assert.equal(describeAction(action), 'Escape (Ctrl) (Shift) on .modal');
  });

  // ── focus ─────────────────────────────────────────────────────────────

  it('describes focus action', () => {
    const action = { type: 'focus', element: { selector: '#name' } };
    assert.equal(describeAction(action), 'focus #name');
  });

  // ── file_upload ───────────────────────────────────────────────────────

  it('describes file_upload action with files', () => {
    const action = {
      type: 'file_upload',
      element: { selector: '#upload' },
      files: [{ name: 'doc.pdf', size: 1024, mime: 'application/pdf' }]
    };
    assert.equal(describeAction(action), '#upload → doc.pdf');
  });

  it('describes file_upload action with multiple files', () => {
    const action = {
      type: 'file_upload',
      element: { selector: '#upload' },
      files: [
        { name: 'a.png', size: 100, mime: 'image/png' },
        { name: 'b.jpg', size: 200, mime: 'image/jpeg' }
      ]
    };
    assert.equal(describeAction(action), '#upload → a.png, b.jpg');
  });

  it('describes file_upload action with no files', () => {
    const action = { type: 'file_upload', element: { selector: '#upload' }, files: [] };
    assert.equal(describeAction(action), '#upload → ');
  });

  it('describes file_upload action with missing files array', () => {
    const action = { type: 'file_upload', element: { selector: '#upload' } };
    assert.equal(describeAction(action), '#upload → ');
  });

  // ── drag_start ────────────────────────────────────────────────────────

  it('describes drag_start action with element text', () => {
    const action = { type: 'drag_start', element: { text: 'Card', selector: '.card' } };
    assert.equal(describeAction(action), 'drag Card');
  });

  it('describes drag_start action falling back to selector', () => {
    const action = { type: 'drag_start', element: { text: null, selector: '.card' } };
    assert.equal(describeAction(action), 'drag .card');
  });

  // ── drop ──────────────────────────────────────────────────────────────

  it('describes drop action with element text', () => {
    const action = { type: 'drop', element: { text: 'Zone', selector: '.zone' } };
    assert.equal(describeAction(action), 'drop onto Zone');
  });

  it('describes drop action falling back to selector', () => {
    const action = { type: 'drop', element: { text: null, selector: '.zone' } };
    assert.equal(describeAction(action), 'drop onto .zone');
  });

  // ── scroll ────────────────────────────────────────────────────────────

  it('describes scroll down action', () => {
    const action = { type: 'scroll', delta_y: 300, delta_x: 0 };
    assert.equal(describeAction(action), 'scroll ↓ 300px');
  });

  it('describes scroll up action', () => {
    const action = { type: 'scroll', delta_y: -150, delta_x: 0 };
    assert.equal(describeAction(action), 'scroll ↑ 150px');
  });

  // ── context_switch ────────────────────────────────────────────────────

  it('describes context_switch action with title', () => {
    const action = { type: 'context_switch', title: 'Notepad', source: 'notepad.exe' };
    assert.equal(describeAction(action), 'switch to tab: Notepad');
  });

  it('describes context_switch action falling back to source', () => {
    const action = { type: 'context_switch', title: null, source: 'notepad.exe' };
    assert.equal(describeAction(action), 'switch to tab: notepad.exe');
  });

  it('describes context_switch action with empty title and source', () => {
    const action = { type: 'context_switch', title: '', source: '' };
    assert.equal(describeAction(action), 'switch to tab: ');
  });

  // ── context_open ──────────────────────────────────────────────────────

  it('describes context_open action with source', () => {
    const action = { type: 'context_open', source: 'chrome.exe' };
    assert.equal(describeAction(action), 'new tab opened: chrome.exe');
  });

  it('describes context_open action without source', () => {
    const action = { type: 'context_open', source: null };
    assert.equal(describeAction(action), 'new tab opened');
  });

  it('describes context_open action with empty source', () => {
    const action = { type: 'context_open', source: '' };
    assert.equal(describeAction(action), 'new tab opened');
  });

  // ── context_close ─────────────────────────────────────────────────────

  it('describes context_close action', () => {
    const action = { type: 'context_close', context_id: 42 };
    assert.equal(describeAction(action), 'tab closed');
  });

  // ── file_dialog ───────────────────────────────────────────────────────

  it('describes file_dialog action with open type', () => {
    const action = { type: 'file_dialog', dialog_type: 'open', file_path: '/docs/readme.md' };
    assert.equal(describeAction(action), 'open dialog → /docs/readme.md');
  });

  it('describes file_dialog action with save type', () => {
    const action = { type: 'file_dialog', dialog_type: 'save', file_path: 'C:\\output.txt' };
    assert.equal(describeAction(action), 'save dialog → C:\\output.txt');
  });

  it('describes file_dialog action with save_as type', () => {
    const action = { type: 'file_dialog', dialog_type: 'save_as', file_path: '/tmp/file.zip' };
    assert.equal(describeAction(action), 'save_as dialog → /tmp/file.zip');
  });

  it('describes file_dialog action with missing dialog_type', () => {
    const action = { type: 'file_dialog', file_path: '/tmp/file.zip' };
    assert.equal(describeAction(action), 'file dialog → /tmp/file.zip');
  });

  it('describes file_dialog action with missing file_path', () => {
    const action = { type: 'file_dialog', dialog_type: 'open' };
    assert.equal(describeAction(action), 'open dialog → ');
  });

  // ── unknown type ──────────────────────────────────────────────────────

  it('returns empty string for unknown action type', () => {
    const action = { type: 'unknown_action' };
    assert.equal(describeAction(action), '');
  });

  // ── edge cases ────────────────────────────────────────────────────────

  it('handles click with no element', () => {
    const action = { type: 'click' };
    // element is undefined, so element?.text and element?.selector are both undefined
    assert.equal(describeAction(action), '');
  });

  it('handles key action with no modifiers object', () => {
    const action = { type: 'key', key: 'Enter', element: { selector: '#btn' } };
    // modifiers is undefined, so modifiers?.ctrl is undefined (falsy)
    assert.equal(describeAction(action), 'Enter on #btn');
  });

  it('escapes HTML in element text for click', () => {
    const action = { type: 'click', element: { text: '<b>Bold</b>', selector: '#x' } };
    assert.equal(describeAction(action), '&lt;b&gt;Bold&lt;/b&gt;');
  });

  it('escapes HTML in type value', () => {
    const action = { type: 'type', element: { selector: '#in' }, value: '<img onerror="alert(1)">' };
    assert.equal(describeAction(action), '#in → "&lt;img onerror=&quot;alert(1)&quot;&gt;"');
  });
});
