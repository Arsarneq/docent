/**
 * sufficiency-lint.test.js — replay-sufficiency baseline lock over the corpus.
 *
 * Runs the sufficiency lint (scripts/sufficiency-lint.js — the static
 * predicates of docs/replay-sufficiency.md, Falsifiability item 1) over every
 * frozen fixture under tests/fixtures/ and asserts the findings equal the
 * committed baseline EXACTLY, in both directions:
 *
 *   - a NEW finding means a predicate or fixture changed — decide
 *     intentionally, don't silence;
 *   - a VANISHED finding means the baseline is stale (a known gap closed or a
 *     rule was weakened) — regenerate the baseline deliberately via
 *     `node scripts/sufficiency-lint.js packages/shared/tests/fixtures
 *      --write-baseline packages/shared/tests/fixtures/sufficiency-baseline.json`.
 *
 * These fixtures are HISTORICAL exports, so this lock guards the rules and
 * the corpus's documented truth — not current capture output. Recordings
 * produced by current code join the corpus with the scripted-truth work, and
 * flow through this same lint unchanged.
 *
 * Also pins each predicate individually on minimal hand-built actions so a
 * predicate that silently stops firing (or fires on legal absence) is caught
 * without depending on what the corpus happens to contain.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lintFile,
  lintRecordingFile,
  diffBaselines,
} from '../../../../scripts/sufficiency-lint.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../fixtures');
const REPO_ROOT = resolve(__dirname, '../../../..');
const BASELINE_PATH = join(FIXTURES_DIR, 'sufficiency-baseline.json');

function corpusFiles() {
  const files = [];
  for (const platform of readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    for (const f of readdirSync(join(FIXTURES_DIR, platform.name))) {
      if (f.endsWith('.docent.json')) {
        files.push(join(FIXTURES_DIR, platform.name, f));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

describe('Sufficiency lint: corpus baseline lock', () => {
  it('findings over the frozen corpus equal the committed baseline exactly', () => {
    const expected = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const actual = {};
    for (const file of corpusFiles()) {
      const { findings } = lintFile(file);
      const key = relative(REPO_ROOT, file).replaceAll('\\', '/');
      actual[key] = findings.map((f) => `${f.class}:${f.id} ${f.pointer}`).sort();
    }
    const diff = diffBaselines(expected, actual);
    assert.deepEqual(
      diff,
      [],
      `sufficiency baseline mismatch — decide intentionally, never silence:\n${diff.join('\n')}`,
    );
  });

  it('every corpus fixture is a contract-valid recording (lint refuses otherwise)', () => {
    for (const file of corpusFiles()) {
      lintFile(file); // throws on schema-invalid input or unknown stamp
    }
  });
});

// ─── Per-predicate pins on minimal documents ─────────────────────────────────

function doc(platform, actions) {
  return {
    docent_format: { platform, schema_version: '0.0.0' },
    recordings: [{ steps: [{ actions }] }],
  };
}

const el = (extra = {}) => ({
  tag: 'button',
  id: null,
  name: null,
  role: null,
  type: null,
  text: null,
  selector: 'x',
  ...extra,
});

function ids(findings) {
  return findings.map((f) => `${f.class}:${f.id}`).sort();
}

describe('Sufficiency lint: predicate pins', () => {
  it('element-locators fires on a locator-less element and passes with one', () => {
    const base = { type: 'click', x: 1, y: 2, context_id: 1, capture_mode: 'dom' };
    const bad = lintRecordingFile(doc('extension', [{ ...base, element: el() }]));
    assert.ok(ids(bad).includes('fail:element-locators'));
    const good = lintRecordingFile(
      doc('extension', [
        { ...base, element: el({ locators: [{ strategy: 'css', value: '#a' }] }) },
      ]),
    );
    assert.ok(!ids(good).includes('fail:element-locators'));
  });

  it('locator-pair-invariants fires on index-without-count and index >= count', () => {
    const base = { type: 'click', x: 1, y: 2, context_id: 1, capture_mode: 'dom' };
    const orphanIndex = lintRecordingFile(
      doc('extension', [
        {
          ...base,
          element: el({ locators: [{ strategy: 'css', value: '#a', match_index: 0 }] }),
        },
      ]),
    );
    assert.ok(ids(orphanIndex).includes('fail:locator-pair-invariants'));
    const outOfRange = lintRecordingFile(
      doc('extension', [
        {
          ...base,
          element: el({
            locators: [{ strategy: 'css', value: '#a', match_count: 1, match_index: 1 }],
          }),
        },
      ]),
    );
    assert.ok(ids(outOfRange).includes('fail:locator-pair-invariants'));
  });

  it('coordinate-geometry requires window_rect on desktop coordinate points', () => {
    const base = {
      type: 'click',
      x: 1,
      y: 2,
      context_id: 1,
      capture_mode: 'coordinate',
      element: el(),
    };
    const bad = lintRecordingFile(doc('desktop-windows', [{ ...base, window_rect: null }]));
    assert.ok(ids(bad).includes('fail:coordinate-geometry'));
    const good = lintRecordingFile(
      doc('desktop-windows', [{ ...base, window_rect: { x: 0, y: 0, width: 10, height: 10 } }]),
    );
    assert.ok(!ids(good).includes('fail:coordinate-geometry'));
  });

  it('coordinate-no-identity-claims fires when a coordinate element carries locators', () => {
    const bad = lintRecordingFile(
      doc('desktop-windows', [
        {
          type: 'click',
          x: 1,
          y: 2,
          context_id: 1,
          capture_mode: 'coordinate',
          window_rect: { x: 0, y: 0, width: 10, height: 10 },
          element: el({ locators: [{ strategy: 'class_name', value: 'X' }] }),
        },
      ]),
    );
    assert.ok(ids(bad).includes('fail:coordinate-no-identity-claims'));
  });

  it('type-value-nonempty fires on empty value but tolerates redacted elements', () => {
    const base = { type: 'type', context_id: 1, capture_mode: 'dom' };
    const bad = lintRecordingFile(doc('extension', [{ ...base, value: '', element: el() }]));
    assert.ok(ids(bad).includes('fail:type-value-nonempty'));
    const redacted = lintRecordingFile(
      doc('extension', [{ ...base, value: '', element: el({ redacted: true, text: null }) }]),
    );
    assert.ok(!ids(redacted).includes('fail:type-value-nonempty'));
  });

  it('masking-honesty fires on a redacted element that still carries text', () => {
    const bad = lintRecordingFile(
      doc('extension', [
        {
          type: 'type',
          value: '••••••••',
          context_id: 1,
          capture_mode: 'dom',
          element: el({ redacted: true, text: 'leaked' }),
        },
      ]),
    );
    assert.ok(ids(bad).includes('fail:masking-honesty'));
  });

  it('key-nonempty fires on an empty key', () => {
    const bad = lintRecordingFile(
      doc('extension', [
        {
          type: 'key',
          key: '',
          modifiers: { ctrl: false, shift: false, alt: false, meta: false },
          context_id: 1,
          capture_mode: 'dom',
          element: el(),
        },
      ]),
    );
    assert.ok(ids(bad).includes('fail:key-nonempty'));
  });

  it('context-introduced fires when a second context appears without a lifecycle action', () => {
    const mk = (ctx, type = 'click') => ({
      type,
      x: 1,
      y: 2,
      context_id: ctx,
      capture_mode: 'dom',
      element: el({ locators: [{ strategy: 'css', value: '#a' }] }),
    });
    const bad = lintRecordingFile(doc('extension', [mk(1), mk(2)]));
    assert.ok(ids(bad).includes('fail:context-introduced'));
    const good = lintRecordingFile(
      doc('extension', [
        mk(1),
        { type: 'context_switch', context_id: 2, source: 'https://x', capture_mode: 'dom' },
        mk(2),
      ]),
    );
    assert.ok(!ids(good).includes('fail:context-introduced'));
  });

  it('start-point gap covers the initial context only when a source/url states it', () => {
    const click = {
      type: 'click',
      x: 1,
      y: 2,
      context_id: 1,
      capture_mode: 'dom',
      element: el({ locators: [{ strategy: 'css', value: '#a' }] }),
    };
    const uncovered = lintRecordingFile(doc('extension', [click]));
    assert.ok(ids(uncovered).includes('gap:start-point'));
    const covered = lintRecordingFile(
      doc('extension', [
        { type: 'navigate', url: 'https://x', context_id: 1, capture_mode: 'dom' },
        click,
      ]),
    );
    assert.ok(!ids(covered).includes('gap:start-point'));
  });

  it('viewport-context gap fires once per browser recording with point actions', () => {
    const click = {
      type: 'click',
      x: 1,
      y: 2,
      context_id: 1,
      capture_mode: 'dom',
      element: el({ locators: [{ strategy: 'css', value: '#a' }] }),
    };
    const findings = lintRecordingFile(doc('extension', [click, click]));
    assert.equal(findings.filter((f) => f.id === 'viewport-context').length, 1);
    const desktop = lintRecordingFile(
      doc('desktop-windows', [
        {
          ...click,
          capture_mode: 'accessibility',
          element: el({ locators: [{ strategy: 'class_name', value: 'X' }] }),
        },
      ]),
    );
    assert.ok(!ids(desktop).includes('gap:viewport-context'));
  });
});
