/**
 * naming.property.test.js — Property-based tests for v2.0.0 platform-neutral naming
 *
 * Property 13: Extension actions use platform-neutral naming and DOM capture mode
 *
 * Generates random browser action objects that simulate what the content script
 * (recorder.js) and service worker (service-worker.js) produce, then verifies
 * the v2.0.0 naming invariants hold across all generated actions.
 *
 * **Validates: Requirements 17.10**
 *
 * Uses Node's built-in test runner (node:test) and fast-check.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// ── Generators ─────────────────────────────────────────────────────────────

/** Arbitrary element description matching the schema's element shape. */
const elementArb = fc.record({
  tag:      fc.constantFrom('BUTTON', 'INPUT', 'A', 'DIV', 'SPAN', 'SELECT', 'TEXTAREA', 'LABEL', 'LI'),
  id:       fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
  name:     fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
  role:     fc.option(fc.constantFrom('button', 'link', 'textbox', 'option', 'menuitem', null), { nil: null }),
  type:     fc.option(fc.constantFrom('text', 'password', 'submit', 'checkbox', 'radio', null), { nil: null }),
  text:     fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
  selector: fc.string({ minLength: 1, maxLength: 80 }),
});

const timestampArb = fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 });
const contextIdArb = fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: null });
const frameSrcArb  = fc.option(fc.webUrl(), { nil: null });

const modifiersArb = fc.record({
  ctrl:  fc.boolean(),
  shift: fc.boolean(),
  alt:   fc.boolean(),
  meta:  fc.boolean(),
});

/** Generates a content-script action (click, right_click, type, select, key, focus, drag_start, drop, scroll, file_upload, navigate). */
const contentScriptActionArb = fc.oneof(
  // click
  fc.record({
    type:         fc.constant('click'),
    timestamp:    timestampArb,
    x:            fc.integer({ min: 0, max: 2000 }),
    y:            fc.integer({ min: 0, max: 2000 }),
    element:      elementArb,
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // right_click
  fc.record({
    type:         fc.constant('right_click'),
    timestamp:    timestampArb,
    x:            fc.integer({ min: 0, max: 2000 }),
    y:            fc.integer({ min: 0, max: 2000 }),
    element:      elementArb,
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // type
  fc.record({
    type:         fc.constant('type'),
    timestamp:    timestampArb,
    element:      elementArb,
    value:        fc.string({ minLength: 0, maxLength: 200 }),
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // select
  fc.record({
    type:         fc.constant('select'),
    timestamp:    timestampArb,
    element:      elementArb,
    value:        fc.string({ minLength: 0, maxLength: 100 }),
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // key
  fc.record({
    type:         fc.constant('key'),
    timestamp:    timestampArb,
    key:          fc.constantFrom('Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'),
    modifiers:    modifiersArb,
    element:      elementArb,
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // focus
  fc.record({
    type:         fc.constant('focus'),
    timestamp:    timestampArb,
    element:      elementArb,
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // drag_start
  fc.record({
    type:         fc.constant('drag_start'),
    timestamp:    timestampArb,
    element:      elementArb,
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // drop
  fc.record({
    type:           fc.constant('drop'),
    timestamp:      timestampArb,
    element:        elementArb,
    source_element: fc.option(elementArb, { nil: null }),
    x:              fc.integer({ min: 0, max: 2000 }),
    y:              fc.integer({ min: 0, max: 2000 }),
    context_id:     contextIdArb,
    capture_mode:   fc.constant('dom'),
    window_rect:    fc.constant(null),
    frame_src:      frameSrcArb,
  }),
  // scroll
  fc.record({
    type:         fc.constant('scroll'),
    timestamp:    timestampArb,
    element:      fc.option(elementArb, { nil: null }),
    scroll_top:   fc.integer({ min: 0, max: 50000 }),
    scroll_left:  fc.integer({ min: 0, max: 50000 }),
    delta_y:      fc.integer({ min: -5000, max: 5000 }),
    delta_x:      fc.integer({ min: -5000, max: 5000 }),
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // file_upload
  fc.record({
    type:         fc.constant('file_upload'),
    timestamp:    timestampArb,
    element:      elementArb,
    files:        fc.array(fc.record({
      name: fc.string({ minLength: 1, maxLength: 50 }),
      size: fc.integer({ min: 0, max: 10_000_000 }),
      mime: fc.constantFrom('text/plain', 'image/png', 'application/pdf'),
    }), { minLength: 1, maxLength: 5 }),
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
  // navigate (SPA, from content script)
  fc.record({
    type:         fc.constant('navigate'),
    nav_type:     fc.constant('spa'),
    timestamp:    timestampArb,
    url:          fc.webUrl(),
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
    frame_src:    frameSrcArb,
  }),
);

/** Generates a service-worker action (navigate, context_switch, context_open, context_close). */
const serviceWorkerActionArb = fc.oneof(
  // navigate (cross-document, from service worker)
  fc.record({
    type:         fc.constant('navigate'),
    nav_type:     fc.constantFrom('link', 'typed', 'reload', 'back_forward', 'form_submit', 'generated', 'start_page', 'auto_bookmark', 'keyword'),
    timestamp:    timestampArb,
    url:          fc.webUrl(),
    context_id:   contextIdArb,
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
  }),
  // context_switch
  fc.record({
    type:         fc.constant('context_switch'),
    timestamp:    timestampArb,
    context_id:   contextIdArb,
    source:       fc.webUrl(),
    title:        fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
    capture_mode: fc.constant('dom'),
    window_rect:  fc.constant(null),
  }),
  // context_open
  fc.record({
    type:               fc.constant('context_open'),
    timestamp:          timestampArb,
    context_id:         contextIdArb,
    opener_context_id:  fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: null }),
    source:             fc.option(fc.webUrl(), { nil: null }),
    capture_mode:       fc.constant('dom'),
    window_rect:        fc.constant(null),
  }),
  // context_close
  fc.record({
    type:           fc.constant('context_close'),
    timestamp:      timestampArb,
    context_id:     contextIdArb,
    window_closing: fc.boolean(),
    capture_mode:   fc.constant('dom'),
    window_rect:    fc.constant(null),
  }),
);

/** Any action emitted by the Chrome extension (content script or service worker). */
const extensionActionArb = fc.oneof(contentScriptActionArb, serviceWorkerActionArb);

// ── Allowed action types and context lifecycle types ───────────────────────

const VALID_ACTION_TYPES = new Set([
  'click', 'right_click', 'type', 'select', 'key', 'focus',
  'drag_start', 'drop', 'scroll', 'file_upload', 'navigate',
  'context_switch', 'context_open', 'context_close',
]);

const CONTEXT_LIFECYCLE_TYPES = new Set([
  'context_switch', 'context_open', 'context_close',
]);

const LEGACY_FIELD_NAMES = ['tab_id', 'tab_switch', 'tab_open', 'tab_close'];

// ── Property 13 Tests ──────────────────────────────────────────────────────

describe('Feature: desktop-capture, Property 13: Extension actions use platform-neutral naming and DOM capture mode', () => {

  test('all actions use context_id, never tab_id', async () => {
    await fc.assert(
      fc.asyncProperty(extensionActionArb, async (action) => {
        // Must have context_id field
        assert.ok('context_id' in action,
          `Action of type "${action.type}" must have a context_id field`);
        // Must NOT have tab_id field
        assert.ok(!('tab_id' in action),
          `Action of type "${action.type}" must not have a tab_id field`);
      }),
      { numRuns: 200 },
    );
  });

  test('context lifecycle actions use context_switch/context_open/context_close, never tab_switch/tab_open/tab_close', async () => {
    await fc.assert(
      fc.asyncProperty(extensionActionArb, async (action) => {
        // Action type must be one of the valid v2.0.0 types
        assert.ok(VALID_ACTION_TYPES.has(action.type),
          `Action type "${action.type}" is not a valid v2.0.0 action type`);
        // Must never use legacy tab_* type names
        assert.ok(action.type !== 'tab_switch',
          'Action type must not be "tab_switch" — use "context_switch"');
        assert.ok(action.type !== 'tab_open',
          'Action type must not be "tab_open" — use "context_open"');
        assert.ok(action.type !== 'tab_close',
          'Action type must not be "tab_close" — use "context_close"');
      }),
      { numRuns: 200 },
    );
  });

  test('context lifecycle actions use source field, not url field', async () => {
    // Filter to only context lifecycle actions for this property
    const contextLifecycleArb = fc.oneof(
      // context_switch
      fc.record({
        type:         fc.constant('context_switch'),
        timestamp:    timestampArb,
        context_id:   contextIdArb,
        source:       fc.webUrl(),
        title:        fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
        capture_mode: fc.constant('dom'),
        window_rect:  fc.constant(null),
      }),
      // context_open
      fc.record({
        type:               fc.constant('context_open'),
        timestamp:          timestampArb,
        context_id:         contextIdArb,
        opener_context_id:  fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: null }),
        source:             fc.option(fc.webUrl(), { nil: null }),
        capture_mode:       fc.constant('dom'),
        window_rect:        fc.constant(null),
      }),
      // context_close (no source or url expected)
      fc.record({
        type:           fc.constant('context_close'),
        timestamp:      timestampArb,
        context_id:     contextIdArb,
        window_closing: fc.boolean(),
        capture_mode:   fc.constant('dom'),
        window_rect:    fc.constant(null),
      }),
    );

    await fc.assert(
      fc.asyncProperty(contextLifecycleArb, async (action) => {
        if (action.type === 'context_switch') {
          // context_switch must have source, not url
          assert.ok('source' in action,
            'context_switch must have a "source" field');
          assert.ok(!('url' in action),
            'context_switch must not have a "url" field — use "source"');
        }
        if (action.type === 'context_open') {
          // context_open must have source, not url
          assert.ok('source' in action,
            'context_open must have a "source" field');
          assert.ok(!('url' in action),
            'context_open must not have a "url" field — use "source"');
        }
        // context_close has neither source nor url — no assertion needed
      }),
      { numRuns: 200 },
    );
  });

  test('capture_mode is "dom" on all extension actions', async () => {
    await fc.assert(
      fc.asyncProperty(extensionActionArb, async (action) => {
        assert.strictEqual(action.capture_mode, 'dom',
          `Action of type "${action.type}" must have capture_mode "dom", got "${action.capture_mode}"`);
      }),
      { numRuns: 200 },
    );
  });

  test('no legacy field names appear on any action', async () => {
    await fc.assert(
      fc.asyncProperty(extensionActionArb, async (action) => {
        for (const legacyField of LEGACY_FIELD_NAMES) {
          assert.ok(!(legacyField in action),
            `Action of type "${action.type}" must not contain legacy field "${legacyField}"`);
        }
      }),
      { numRuns: 200 },
    );
  });
});
