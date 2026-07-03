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
 * Discovery and serialization come FROM the lint (collectFiles/toBaseline),
 * so this lock covers exactly the file set and entry format the CLI's
 * --write-baseline produces — the two can never diverge. Validity of every
 * fixture is asserted by the same pass: lintFile throws on schema-invalid
 * input or an unknown platform stamp.
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
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lintFile,
  lintRecordingFile,
  collectFiles,
  toBaseline,
  diffBaselines,
} from '../../../../scripts/sufficiency-lint.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../fixtures');
const BASELINE_PATH = join(FIXTURES_DIR, 'sufficiency-baseline.json');

describe('Sufficiency lint: corpus baseline lock', () => {
  it('findings over the frozen corpus equal the committed baseline exactly', () => {
    const expected = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const results = new Map();
    for (const file of collectFiles([FIXTURES_DIR])) {
      results.set(file, lintFile(file)); // throws on invalid input
    }
    const diff = diffBaselines(expected, toBaseline(results));
    assert.deepEqual(
      diff,
      [],
      `sufficiency baseline mismatch — decide intentionally, never silence:\n${diff.join('\n')}`,
    );
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

  it('locator-pair-invariants fires on a NUMERIC index without count, not on the legal null', () => {
    const base = { type: 'click', x: 1, y: 2, context_id: 1, capture_mode: 'dom' };
    const orphanNumeric = lintRecordingFile(
      doc('extension', [
        {
          ...base,
          element: el({ locators: [{ strategy: 'css', value: '#a', match_index: 0 }] }),
        },
      ]),
    );
    assert.ok(ids(orphanNumeric).includes('fail:locator-pair-invariants'));
    // match_index: null WITHOUT match_count is the only expressible encoding
    // of "measured, matched zero elements" (match_count has minimum 1) —
    // legal and honest, never a finding.
    const legalNull = lintRecordingFile(
      doc('extension', [
        {
          ...base,
          element: el({ locators: [{ strategy: 'css', value: '#a', match_index: null }] }),
        },
      ]),
    );
    assert.ok(!ids(legalNull).includes('fail:locator-pair-invariants'));
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

  it('coordinate-no-identity-claims fires on locators AND on any identity fact', () => {
    const mk = (elExtra) => ({
      type: 'click',
      x: 1,
      y: 2,
      context_id: 1,
      capture_mode: 'coordinate',
      window_rect: { x: 0, y: 0, width: 10, height: 10 },
      element: el(elExtra),
    });
    const withLocators = lintRecordingFile(
      doc('desktop-windows', [mk({ locators: [{ strategy: 'class_name', value: 'X' }] })]),
    );
    assert.ok(ids(withLocators).includes('fail:coordinate-no-identity-claims'));
    // The full identity-claim set mirrors the desktop capture's
    // strip_identity_claims: provider facts count too, not just locators.
    for (const fact of [
      { position_in_set: 1 },
      { size_of_set: 2 },
      { level: 1 },
      { framework_id: 'Win32' },
      { described_after_ms: 0 },
    ]) {
      const withFact = lintRecordingFile(doc('desktop-windows', [mk(fact)]));
      assert.ok(
        ids(withFact).includes('fail:coordinate-no-identity-claims'),
        `expected identity-claim finding for ${Object.keys(fact)[0]}`,
      );
    }
  });

  it('type-value-nonempty fires on empty value but leaves redacted to masking-honesty', () => {
    const base = { type: 'type', context_id: 1, capture_mode: 'dom' };
    const bad = lintRecordingFile(doc('extension', [{ ...base, value: '', element: el() }]));
    assert.ok(ids(bad).includes('fail:type-value-nonempty'));
    const redacted = lintRecordingFile(
      doc('extension', [{ ...base, value: '', element: el({ redacted: true, text: null }) }]),
    );
    assert.ok(!ids(redacted).includes('fail:type-value-nonempty'));
  });

  it('masking-honesty requires the EXACT mask: empty value on a redacted action fails', () => {
    const base = { type: 'type', context_id: 1, capture_mode: 'dom' };
    // An empty value would erase the parameter-slot marker the scope
    // boundaries stand on — only the exact mask glyph is honest.
    const empty = lintRecordingFile(
      doc('extension', [{ ...base, value: '', element: el({ redacted: true, text: null }) }]),
    );
    assert.ok(ids(empty).includes('fail:masking-honesty'));
    const masked = lintRecordingFile(
      doc('extension', [
        { ...base, value: '••••••••', element: el({ redacted: true, text: null }) },
      ]),
    );
    assert.ok(!ids(masked).includes('fail:masking-honesty'));
    const leakedText = lintRecordingFile(
      doc('extension', [
        { ...base, value: '••••••••', element: el({ redacted: true, text: 'leaked' }) },
      ]),
    );
    assert.ok(ids(leakedText).includes('fail:masking-honesty'));
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

  it('start-point counts coverage only when the context BEGINS with a stated start', () => {
    const click = {
      type: 'click',
      x: 1,
      y: 2,
      context_id: 1,
      capture_mode: 'dom',
      element: el({ locators: [{ strategy: 'css', value: '#a' }] }),
    };
    const nav = { type: 'navigate', url: 'https://x', context_id: 1, capture_mode: 'dom' };
    const uncovered = lintRecordingFile(doc('extension', [click]));
    assert.ok(ids(uncovered).includes('gap:start-point'));
    const covered = lintRecordingFile(doc('extension', [nav, click]));
    assert.ok(!ids(covered).includes('gap:start-point'));
    // A LATE navigate states where the recording went, not where the earlier
    // click began — the gap must survive it.
    const lateNav = lintRecordingFile(doc('extension', [click, nav]));
    assert.ok(ids(lateNav).includes('gap:start-point'));
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
