/**
 * schema-composition.test.js — Locks the schema build contract (layered
 * compose: platform-agnostic base → optional family layer → per-surface leaf).
 *
 * Everything here composes from the SOURCE LAYERS in schemas/ via the same
 * primitives build-schemas.js uses. It deliberately does NOT compare against
 * schemas/dist/ — dist/ is the released artifact, written only by the release
 * pipeline, and is expected to lag the source layers within a PR. The
 * source-composed schema is the contract this commit defines.
 *
 *   extension:        shared.schema.json → extension.delta.json
 *   desktop-windows:  shared.schema.json → desktop.shared.schema.json → desktop-windows.delta.json
 *
 * These tests guarantee:
 *   1. Every platform composes into an internally consistent schema (all local
 *      $refs resolve) — catching a $def that moved layers but left a dangling ref.
 *   2. The base stays platform-AGNOSTIC — no platform-specific $defs and no
 *      platform names in its wording.
 *   3. Desktop-family defs live in the desktop.shared layer (shared by Windows
 *      and future Linux), not in the base or a single leaf.
 *   4. Each platform's unique definitions land in the composed output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  PLATFORMS,
  composePlatform,
  locatorStrategyDefs,
} from '../../../../scripts/build-schemas.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS_DIR = resolve(__dirname, '../../../../schemas');

const readJson = (name) => JSON.parse(readFileSync(join(SCHEMAS_DIR, name), 'utf8'));

const base = readJson('shared.schema.json');
const desktopFamily = readJson('desktop.shared.schema.json');

describe('Schema composition: every platform composes into a valid schema', () => {
  for (const platform of Object.keys(PLATFORMS)) {
    it(`${platform} composes and all local $refs resolve (Ajv compiles it)`, () => {
      const ajv = new Ajv({ allErrors: true, strict: false });
      addFormats(ajv);
      // Ajv.compile resolves every #/$defs/... ref eagerly; a dangling ref
      // (e.g. a $def left behind in the wrong layer) throws here.
      assert.doesNotThrow(() => ajv.compile(composePlatform(platform)));
    });
  }
});

describe('Schema composition: base is platform-agnostic', () => {
  it('base has the envelope and core structural defs', () => {
    assert.deepStrictEqual(base.required, ['docent_format', 'project', 'recordings']);
    for (const def of ['docent_format', 'project', 'recording', 'step', 'element', 'modifiers']) {
      assert.ok(base.$defs[def], `base missing ${def}`);
    }
  });

  it('base does NOT define platform-specific defs (capture_mode, action oneOf, window_rect, file_dialog, frame_src, locator)', () => {
    for (const platformDef of [
      'capture_mode',
      'action',
      'window_rect',
      'window_rect_or_null',
      'action_file_dialog',
      'frame_src',
      'action_navigate',
      'action_file_upload',
      'locator',
    ]) {
      assert.strictEqual(
        base.$defs[platformDef],
        undefined,
        `base must not define platform-specific "${platformDef}"`,
      );
    }
  });

  it('base wording names no specific platform', () => {
    // The whole point of an agnostic base: descriptions must not mention a
    // concrete platform/technology. Guards against re-introducing the old
    // "(extension) / (desktop)" dual-wording.
    const text = JSON.stringify(base.$defs).toLowerCase();
    for (const term of ['extension', 'desktop', 'chrome', 'uia', 'dom', 'css', 'aria', 'html']) {
      assert.ok(!text.includes(term), `base wording should not mention "${term}"`);
    }
  });
});

describe('Schema composition: desktop-family layer carries desktop-common defs', () => {
  it('desktop.shared owns capture_mode, window_rect(+_or_null), file_dialog, action oneOf', () => {
    assert.deepStrictEqual(desktopFamily.$defs.capture_mode.enum, ['accessibility', 'coordinate']);
    assert.ok(desktopFamily.$defs.window_rect);
    assert.ok(desktopFamily.$defs.window_rect_or_null);
    assert.ok(desktopFamily.$defs.action_file_dialog);
    assert.ok(desktopFamily.$defs.action);
    assert.strictEqual(desktopFamily.actionContextProperty.name, 'window_rect');
  });

  it('desktop-windows leaf carries identity + exactly the Windows locator defs, nothing else', () => {
    // The leaf held no $defs until the locators[] contract (#174) landed: the
    // locator strategy shapes are genuinely Windows-specific (UIA wording,
    // Control-view measurement semantics), so they live in the leaf — a future
    // desktop-linux leaf authors its own against real AT-SPI output (#84).
    const leaf = readJson('desktop-windows.delta.json');
    assert.ok(leaf.title && leaf.version && leaf.$id);
    assert.deepStrictEqual(Object.keys(leaf.$defs), [
      'locator',
      'locator_automation_id',
      'locator_role_name',
      'locator_class_name',
      'locator_labeled_by',
      'locator_tree_path',
    ]);
  });
});

describe('Schema composition: locators[] contract (#174)', () => {
  const strategyConsts = (layer) =>
    locatorStrategyDefs(layer).map(({ def }) => def.properties.strategy.const);

  it('base carries the element.locators ref and exactly the three shared trio defs', () => {
    assert.strictEqual(base.$defs.element.properties.locators.items.$ref, '#/$defs/locator');
    const locatorKeys = Object.keys(base.$defs).filter((k) => k.startsWith('locator'));
    assert.deepStrictEqual(locatorKeys.sort(), [
      'locator_masked',
      'locator_match_count',
      'locator_match_index',
    ]);
  });

  it('extension leaf owns locator + exactly the 11 strategies, in contract order', () => {
    // The oneOf declaration order IS the serialization order the schema
    // documents as semantics-free — a reorder here is a contract change.
    const leaf = readJson('extension.delta.json');
    assert.deepStrictEqual(strategyConsts(leaf), [
      'id',
      'test_id',
      'name',
      'tag_name',
      'role_name',
      'label',
      'text',
      'placeholder',
      'title',
      'alt_text',
      'css',
    ]);
  });

  it('desktop-windows leaf owns locator + exactly the 5 strategies, in contract order', () => {
    const leaf = readJson('desktop-windows.delta.json');
    assert.deepStrictEqual(strategyConsts(leaf), [
      'automation_id',
      'role_name',
      'class_name',
      'labeled_by',
      'tree_path',
    ]);
  });

  it('every strategy def on every platform declares x-value-derived explicitly', () => {
    // The annotation marks the strategies the redaction chokepoint masks in
    // place (see docs/requirements/replay-sufficiency.md — masked values are consumer
    // parameters). Absence must mean nothing: an undeclared def would be
    // indistinguishable from "author forgot", so every strategy def declares
    // it, and a future strategy cannot ship without taking a stance (the
    // sufficiency lint additionally refuses at runtime). The exact per-platform
    // set is pinned where its canonical reader lives, in the sufficiency-lint
    // suite. The shared trio (match_count/match_index/masked) and the base
    // `locator` container deliberately never carry the annotation.
    for (const platform of Object.keys(PLATFORMS)) {
      for (const { name, def } of locatorStrategyDefs(composePlatform(platform))) {
        assert.equal(
          typeof def['x-value-derived'],
          'boolean',
          `${platform}: ${name} must declare x-value-derived`,
        );
      }
    }
  });

  it('desktop.shared (family layer) carries no locator defs', () => {
    const locatorKeys = Object.keys(desktopFamily.$defs).filter((k) => k.startsWith('locator'));
    assert.deepStrictEqual(locatorKeys, []);
  });

  it('composed platforms carry only their own strategy defs', () => {
    const ext = composePlatform('extension');
    const desk = composePlatform('desktop-windows');
    for (const desktopOnly of [
      'locator_automation_id',
      'locator_tree_path',
      'locator_labeled_by',
    ]) {
      assert.strictEqual(
        ext.$defs[desktopOnly],
        undefined,
        `extension must not carry ${desktopOnly}`,
      );
    }
    for (const extOnly of ['locator_css', 'locator_test_id', 'locator_label']) {
      assert.strictEqual(desk.$defs[extOnly], undefined, `desktop must not carry ${extOnly}`);
    }
  });

  it('the shared trio defs are identical in both composed platforms', () => {
    const ext = composePlatform('extension');
    const desk = composePlatform('desktop-windows');
    for (const trio of ['locator_match_count', 'locator_match_index', 'locator_masked']) {
      assert.deepStrictEqual(
        ext.$defs[trio],
        desk.$defs[trio],
        `${trio} diverged across platforms`,
      );
    }
  });
});

describe('Schema composition: platform-unique defs land in the composed output', () => {
  it('extension leaf owns frame_src + navigate/file_upload + dom capture_mode', () => {
    const leaf = readJson('extension.delta.json');
    assert.ok(leaf.$defs.frame_src);
    assert.ok(leaf.$defs.action_navigate);
    assert.ok(leaf.$defs.action_file_upload);
    assert.strictEqual(leaf.$defs.capture_mode.const, 'dom');
    assert.strictEqual(leaf.$defs.action_file_dialog, undefined);
  });

  it('composed extension schema injects frame_src into every action def, never window_rect', () => {
    const composed = composePlatform('extension');
    for (const [name, def] of Object.entries(composed.$defs)) {
      if (name.startsWith('action_') && def.properties) {
        assert.ok(def.properties.frame_src, `${name} missing frame_src`);
        assert.strictEqual(def.properties.window_rect, undefined);
      }
    }
  });

  it('composed desktop schema injects window_rect into every action def, never frame_src', () => {
    const composed = composePlatform('desktop-windows');
    for (const [name, def] of Object.entries(composed.$defs)) {
      if (name.startsWith('action_') && def.properties) {
        assert.ok(def.properties.window_rect, `${name} missing window_rect`);
        assert.strictEqual(def.properties.frame_src, undefined);
      }
    }
  });

  it('composed desktop schema includes file_dialog; extension does not', () => {
    assert.ok(composePlatform('desktop-windows').$defs.action_file_dialog);
    assert.strictEqual(composePlatform('extension').$defs.action_file_dialog, undefined);
  });

  it('composer pins docent_format platform + schema_version consts per platform', () => {
    for (const platform of Object.keys(PLATFORMS)) {
      const composed = composePlatform(platform);
      const df = composed.$defs.docent_format.properties;
      assert.strictEqual(df.platform.const, platform, `${platform} platform const`);
      assert.strictEqual(
        df.schema_version.const,
        composed.version,
        `${platform} schema_version const tracks version`,
      );
    }
  });

  it('docent_format is required at the root of every platform schema', () => {
    for (const platform of Object.keys(PLATFORMS)) {
      assert.ok(composePlatform(platform).required.includes('docent_format'));
    }
  });
});
