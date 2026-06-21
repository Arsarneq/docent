/**
 * schema-split.test.js — Tests that the per-platform PUBLISHED schemas (the
 * copies synced into each package by sync-shared) carry the correct
 * platform-specific content. Complements schema-composition.test.js, which
 * validates the source-layer composition; this checks the synced build output
 * each package actually ships with.
 *
 * - Extension schema has correct platform-specific content
 * - Desktop schema has correct platform-specific content
 * - Both share the cross-platform definitions
 * - Platform-impossible fields are absent (frame_src on desktop, window_rect on
 *   extension, etc.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

function loadSchema(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

describe('Extension schema', () => {
  const schema = loadSchema('packages/extension/shared/session.schema.json');
  const defs = schema.$defs;

  it('has correct title', () => {
    assert.strictEqual(schema.title, 'Docent Extension Schema');
  });

  it('capture_mode is const "dom"', () => {
    assert.strictEqual(defs.capture_mode.const, 'dom');
  });

  it('has frame_src definition', () => {
    assert.ok(defs.frame_src);
    assert.deepStrictEqual(defs.frame_src.type, ['string', 'null']);
  });

  it('does NOT have window_rect_or_null', () => {
    assert.strictEqual(defs.window_rect_or_null, undefined);
  });

  it('has navigate and file_upload action types', () => {
    assert.ok(defs.action_navigate);
    assert.ok(defs.action_file_upload);
  });

  it('does NOT have file_dialog action type', () => {
    assert.strictEqual(defs.action_file_dialog, undefined);
  });

  it('has 14 action types in oneOf', () => {
    assert.strictEqual(defs.action.oneOf.length, 14);
  });

  it('shared action types include frame_src', () => {
    assert.ok(defs.action_click.properties.frame_src);
    assert.ok(defs.action_key.properties.frame_src);
    assert.ok(defs.action_scroll.properties.frame_src);
    assert.ok(defs.action_context_switch.properties.frame_src);
  });

  it('shared action types do NOT include window_rect', () => {
    assert.strictEqual(defs.action_click.properties.window_rect, undefined);
  });
});

describe('Desktop Windows schema', () => {
  const schema = loadSchema('packages/desktop/shared/session.schema.json');
  const defs = schema.$defs;

  it('has correct title', () => {
    assert.strictEqual(schema.title, 'Docent Desktop (Windows) Schema');
  });

  it('capture_mode is enum ["accessibility", "coordinate"]', () => {
    assert.deepStrictEqual(defs.capture_mode.enum, ['accessibility', 'coordinate']);
  });

  it('has window_rect_or_null definition', () => {
    assert.ok(defs.window_rect_or_null);
  });

  it('does NOT have frame_src', () => {
    assert.strictEqual(defs.frame_src, undefined);
  });

  it('has file_dialog action type', () => {
    assert.ok(defs.action_file_dialog);
  });

  it('does NOT have navigate or file_upload action types', () => {
    assert.strictEqual(defs.action_navigate, undefined);
    assert.strictEqual(defs.action_file_upload, undefined);
  });

  it('has 13 action types in oneOf', () => {
    assert.strictEqual(defs.action.oneOf.length, 13);
  });

  it('shared action types include window_rect', () => {
    assert.ok(defs.action_click.properties.window_rect);
    assert.ok(defs.action_key.properties.window_rect);
    assert.ok(defs.action_scroll.properties.window_rect);
    assert.ok(defs.action_context_switch.properties.window_rect);
  });

  it('shared action types do NOT include frame_src', () => {
    assert.strictEqual(defs.action_click.properties.frame_src, undefined);
  });
});

describe('Shared definitions present in both schemas', () => {
  const ext = loadSchema('packages/extension/shared/session.schema.json');
  const desk = loadSchema('packages/desktop/shared/session.schema.json');

  // Cross-platform shared defs only. window_rect is intentionally NOT here — it
  // is a desktop-family concept (see desktop.shared.schema.json) and is absent
  // from the extension schema.
  const sharedKeys = [
    'project',
    'recording',
    'step',
    'element',
    'modifiers',
    'uuidv7',
    'iso8601',
    'context_id',
    'metadata',
  ];

  for (const key of sharedKeys) {
    it(`both schemas have ${key} definition`, () => {
      assert.ok(ext.$defs[key], `extension missing ${key}`);
      assert.ok(desk.$defs[key], `desktop missing ${key}`);
    });
  }

  it('project definitions are identical', () => {
    assert.deepStrictEqual(ext.$defs.project, desk.$defs.project);
  });

  it('recording definitions are identical', () => {
    assert.deepStrictEqual(ext.$defs.recording, desk.$defs.recording);
  });

  it('step definitions are identical', () => {
    assert.deepStrictEqual(ext.$defs.step, desk.$defs.step);
  });

  it('element definitions are identical', () => {
    assert.deepStrictEqual(ext.$defs.element, desk.$defs.element);
  });
});
