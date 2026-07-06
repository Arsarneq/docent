/**
 * corpus-compare.test.js — pins for the scripted-truth corpus comparator
 * (scripts/corpus-compare.js): the normalization class rules and the equality
 * relations they preserve, LCS action alignment, alignment-scoped
 * relaxations, baseline serialization, and hygiene locks over the committed
 * corpus tree (every truth file schema-valid per its stamp; every baseline
 * key names a manifest session; every active session fully authored).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeEnvelope,
  diffEnvelopes,
  discoverSessions,
  serializeFinding,
  toBaseline,
  MachineryError,
} from '../../../../scripts/corpus-compare.js';
import { diffBaselines } from '../../../../scripts/sufficiency-lint.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = resolve(__dirname, '../../../../corpus');

// Minimal buildExport-shaped envelope. Realistic values; normalization is
// platform-aware via the docent_format stamp.
function envelope(actions, platform = 'extension') {
  return {
    docent_format: { platform, schema_version: '3.0.0' },
    project: {
      project_id: '019e11fd-78ba-7fdb-8362-6fe9f697f641',
      name: 'p',
      created_at: '2026-07-04T10:00:00.000Z',
    },
    recordings: [
      {
        recording_id: '019e11fd-78ba-7fdb-8362-6fe9f697f642',
        name: 'r',
        created_at: '2026-07-04T10:00:01.000Z',
        steps: [
          {
            uuid: '019e11fd-78ba-7fdb-8362-6fe9f697f643',
            logical_id: '019e11fd-78ba-7fdb-8362-6fe9f697f643',
            step_number: 1,
            created_at: '2026-07-04T10:00:02.000Z',
            narration: 's',
            narration_source: 'typed',
            actions,
            deleted: false,
          },
        ],
      },
    ],
  };
}

const click = (over = {}) => ({
  type: 'click',
  timestamp: 1751623200000,
  x: 10,
  y: 20,
  element: { tag: 'BUTTON', selector: '#b', text: 'B' },
  context_id: 12345,
  capture_mode: 'dom',
  ...over,
});

describe('corpus-compare: normalization classes', () => {
  it('uuid map preserves logical_id grouping; distinct ids stay distinct', () => {
    const doc = envelope([click()]);
    doc.recordings[0].steps.push({
      ...structuredClone(doc.recordings[0].steps[0]),
      uuid: '019e11fd-78ba-7fdb-8362-6fe9f697f699', // later version, same logical_id
    });
    const n = normalizeEnvelope(doc);
    const [s1, s2] = n.recordings[0].steps;
    assert.equal(s1.logical_id, s2.logical_id, 'shared logical_id normalizes equal');
    assert.equal(s1.uuid, s1.logical_id, 'v1 uuid === its logical_id');
    assert.notEqual(s2.uuid, s1.uuid, 'distinct uuids stay distinct');
  });

  it('context map keeps same-context equality, cross-context distinctness, and routes opener through the same map', () => {
    const n = normalizeEnvelope(
      envelope([
        click({ context_id: 111 }),
        click({ context_id: 222 }),
        {
          type: 'context_open',
          timestamp: 1,
          context_id: 222,
          opener_context_id: 111,
          capture_mode: 'dom',
        },
        click({ context_id: null }),
      ]),
    );
    const a = n.recordings[0].steps[0].actions;
    assert.equal(a[0].context_id, '<ctx:1>');
    assert.equal(a[1].context_id, '<ctx:2>');
    assert.equal(a[2].context_id, '<ctx:2>', 'same real context normalizes equal');
    assert.equal(a[2].opener_context_id, '<ctx:1>', 'opener goes through the SAME map');
    assert.equal(a[3].context_id, null, 'null preserved');
  });

  it('described_after_ms: 0 exact, positive → <measured>, null/absent preserved', () => {
    const n = normalizeEnvelope(
      envelope([
        click({ element: { tag: 'A', selector: '#a', described_after_ms: 0 } }),
        click({ element: { tag: 'A', selector: '#a', described_after_ms: 42 } }),
        click({ element: { tag: 'A', selector: '#a', described_after_ms: null } }),
        click({ element: { tag: 'A', selector: '#a' } }),
      ]),
    );
    const els = n.recordings[0].steps[0].actions.map((x) => x.element);
    assert.equal(els[0].described_after_ms, 0);
    assert.equal(els[1].described_after_ms, '<measured>');
    assert.equal(els[2].described_after_ms, null);
    assert.ok(!('described_after_ms' in els[3]));
  });

  it('coordinates → <point> on both platforms; desktop window_rect/coord selector wildcarded; null and absence preserved', () => {
    const ext = normalizeEnvelope(envelope([click()]));
    assert.equal(ext.recordings[0].steps[0].actions[0].x, '<point>');

    const desk = normalizeEnvelope(
      envelope(
        [
          click({
            window_rect: { x: 1, y: 2, width: 3, height: 4 },
            element: { tag: 'unknown', selector: 'coord:12,34' },
          }),
          click({ window_rect: null, element: { tag: 'Button', selector: 'Win > Button' } }),
        ],
        'desktop-windows',
      ),
    );
    const [d1, d2] = desk.recordings[0].steps[0].actions;
    assert.equal(d1.window_rect, '<rect>');
    assert.equal(d1.element.selector, 'coord:<point>');
    assert.equal(d2.window_rect, null, 'null window_rect preserved (coordinate-geometry stands on it)'); // prettier-ignore
    assert.equal(d2.element.selector, 'Win > Button', 'non-coord selector untouched');
  });

  it('is pure and idempotent', () => {
    const doc = envelope([click()]);
    const before = JSON.stringify(doc);
    const once = normalizeEnvelope(doc);
    assert.equal(JSON.stringify(doc), before, 'input not mutated');
    assert.deepEqual(normalizeEnvelope(once), once, 'double-normalization is a fixpoint');
  });
});

describe('corpus-compare: diff + alignment', () => {
  it('identical envelopes diff to []', () => {
    assert.deepEqual(diffEnvelopes(envelope([click()]), envelope([click()])), []);
  });

  it('a deleted middle action is ONE missing-action, no positional cascade', () => {
    const truth = envelope([
      click(),
      { type: 'type', timestamp: 2, element: { tag: 'INPUT', selector: '#i' }, value: 'v', context_id: 12345, capture_mode: 'dom' }, // prettier-ignore
      click({ element: { tag: 'BUTTON', selector: '#submit', text: 'Go' } }),
    ]);
    const produced = envelope([
      click(),
      click({ element: { tag: 'BUTTON', selector: '#submit', text: 'Go' } }),
    ]);
    const findings = diffEnvelopes(truth, produced);
    assert.deepEqual(
      findings.map((f) => `${f.kind} ${f.pointer}`),
      ['missing-action rec[0].step[0].action[1]:type'],
    );
  });

  it('extra produced actions carry the produced: pointer prefix', () => {
    const findings = diffEnvelopes(envelope([click()]), envelope([click(), click()]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'extra-action');
    assert.ok(findings[0].pointer.startsWith('produced:'));
  });

  it('aligned pairs get deep wrong-field findings with truth-side pointers', () => {
    const truth = envelope([click({ element: { tag: 'BUTTON', selector: '#b', text: 'Save' } })]);
    const produced = envelope([click({ element: { tag: 'BUTTON', selector: '#b', text: 'Save!' } })]); // prettier-ignore
    const findings = diffEnvelopes(truth, produced);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'wrong-field');
    assert.equal(findings[0].pointer, 'rec[0].step[0].action[0]:click');
    assert.equal(findings[0].path, 'element.text');
  });
});

describe('corpus-compare: relaxations (alignment-scoped, refuse-loudly)', () => {
  const scrollAction = (dy) => ({
    type: 'scroll',
    timestamp: 3,
    element: { tag: 'DIV', selector: '#s' },
    scroll_top: dy,
    scroll_left: 0,
    delta_y: dy,
    delta_x: 0,
    context_id: 12345,
    capture_mode: 'dom',
  });

  it('scroll-amounts is a 0-vs-nonzero class map: fabricated zeros stay visible', () => {
    const relax = [{ pointer: 'rec[0].step[0].action[0]', relax: 'scroll-amounts' }];
    // Truth nonzero, produced fabricated 0 → diff survives the relaxation.
    const f1 = diffEnvelopes(envelope([scrollAction(300)]), envelope([scrollAction(0)]), relax);
    assert.ok(f1.some((f) => f.path === 'delta_y' && f.expected === '<measured>' && f.actual === 0)); // prettier-ignore
    // Truth nonzero, produced differently-nonzero → both <measured>, no diff.
    const f2 = diffEnvelopes(envelope([scrollAction(300)]), envelope([scrollAction(280)]), relax);
    assert.deepEqual(f2, []);
  });

  it('match-stats requires the strategy cross-check and refuses masked entries', () => {
    const withLoc = (locators) =>
      envelope([click({ element: { tag: 'BUTTON', selector: '#b', locators } })]);
    const truth = withLoc([{ strategy: 'id', value: 'b', match_count: 1, match_index: 0 }]);
    assert.throws(
      () =>
        diffEnvelopes(truth, structuredClone(truth), [
          { pointer: 'rec[0].step[0].action[0].locators[0]', strategy: 'text', relax: 'match-stats' }, // prettier-ignore
        ]),
      MachineryError,
      'strategy cross-check',
    );
    const masked = withLoc([
      { strategy: 'text', value: '••••••••', masked: true, match_count: 1, match_index: 0 },
    ]);
    assert.throws(
      () =>
        diffEnvelopes(masked, structuredClone(masked), [
          { pointer: 'rec[0].step[0].action[0].locators[0]', strategy: 'text', relax: 'match-stats' }, // prettier-ignore
        ]),
      MachineryError,
      'redaction fields are never relaxable',
    );
  });

  it('unknown relax kinds and dangling pointers are machinery errors', () => {
    const doc = envelope([click()]);
    assert.throws(
      () => diffEnvelopes(doc, structuredClone(doc), [{ pointer: 'rec[0].step[0].action[0]', relax: 'everything' }]), // prettier-ignore
      MachineryError,
    );
    assert.throws(
      () => diffEnvelopes(doc, structuredClone(doc), [{ pointer: 'rec[0].step[0].action[9]', relax: 'scroll-amounts' }]), // prettier-ignore
      MachineryError,
    );
  });
});

describe('corpus-compare: baseline mechanics', () => {
  it('serializeFinding + toBaseline round-trip through diffBaselines in both directions', () => {
    const truth = envelope([click(), click()]);
    const produced = envelope([click()]);
    const results = [{ sessionId: 's1', findings: diffEnvelopes(truth, produced) }];
    const baseline = toBaseline(results);
    assert.equal(baseline.s1.length, 1);
    assert.deepEqual(diffBaselines(baseline, baseline), []);
    const regressed = toBaseline([
      { sessionId: 's1', findings: diffEnvelopes(envelope([click(), click(), click()]), produced) }, // prettier-ignore
    ]);
    assert.ok(diffBaselines(baseline, regressed).some((l) => l.startsWith('NEW')));
    const fixed = toBaseline([{ sessionId: 's1', findings: [] }]);
    assert.ok(diffBaselines(baseline, fixed).some((l) => l.startsWith('VANISHED')));
  });
});

describe('corpus hygiene locks (committed tree)', () => {
  const manifestPath = join(CORPUS_DIR, 'manifest.json');
  const sessions = discoverSessions(manifestPath, 'extension');

  it('every active session has a truth file, and every truth validates per its stamp', async () => {
    // Validation goes through the comparator's own loader by round-tripping a
    // trivial self-diff (loadValidated is internal; compareSession needs a
    // produced file, so validate via lintFile which applies the same
    // relaxed-stamp schema bar).
    const { lintFile } = await import('../../../../scripts/sufficiency-lint.js');
    for (const s of sessions.filter((x) => x.status === 'active')) {
      assert.ok(existsSync(s.truthPath), `${s.id} has no truth file`);
      assert.doesNotThrow(() => lintFile(s.truthPath), `${s.id} truth is not schema-valid`);
    }
  });

  it('every baseline key names a manifest session, and every active session has a key', () => {
    const baseline = JSON.parse(
      readFileSync(join(CORPUS_DIR, 'known-diffs.extension.json'), 'utf8'),
    );
    const ids = new Set(sessions.map((s) => s.id));
    for (const key of Object.keys(baseline)) {
      assert.ok(ids.has(key), `baseline key "${key}" names no manifest session`);
    }
    for (const s of sessions.filter((x) => x.status === 'active')) {
      assert.ok(s.id in baseline, `active session "${s.id}" missing from the baseline`);
    }
  });

  it('every sidecar parses, uses known kinds, and points inside its truth', () => {
    for (const s of sessions) {
      if (!s.overridesPath || !existsSync(s.overridesPath)) continue;
      const sidecar = JSON.parse(readFileSync(s.overridesPath, 'utf8'));
      const truth = JSON.parse(readFileSync(s.truthPath, 'utf8'));
      // Applying the relaxations to a self-diff throws on any malformed entry.
      assert.doesNotThrow(() =>
        diffEnvelopes(truth, structuredClone(truth), sidecar.relaxations ?? [], s.id),
      );
    }
  });
});
