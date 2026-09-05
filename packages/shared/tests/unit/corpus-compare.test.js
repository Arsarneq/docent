/**
 * corpus-compare.test.js — pins for the scripted-truth corpus comparator
 * (scripts/corpus-compare.js): the normalization class rules and the equality
 * relations they preserve, LCS action alignment, alignment-scoped
 * relaxations, baseline serialization, and hygiene locks over the committed
 * corpus tree (every truth file schema-valid per its stamp; every baseline
 * key names a manifest session; every active session fully authored).
 *
 * It also pins the comparator's exit-code contract at the process boundary
 * (STC-5), which only a spawn can observe: the suite runs the real CLI over a
 * temporary corpus and holds 0 / 1 / 2 to their meanings — green, findings the
 * caller must decide on, and machinery breakage that must never read as a diff
 * verdict.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeEnvelope,
  diffEnvelopes,
  discoverSessions,
  sessionsIn,
  serializeFinding,
  toBaseline,
  MachineryError,
  MATCH_STAT_FIELDS,
  NORMALIZED_FIELD_CLASSES,
  PATH_FIELDS,
  SCROLL_AMOUNT_FIELDS,
} from '../../../../scripts/corpus-compare.js';
import { diffBaselines } from '../../../../scripts/sufficiency-lint.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const CORPUS_DIR = resolve(__dirname, '../../../../corpus');
const COMPARATOR = join(REPO_ROOT, 'scripts', 'corpus-compare.js');

/** The comparator's normalization classes, flattened to their field tokens. */
const NORMALIZED_FIELDS = [...new Set(Object.values(NORMALIZED_FIELD_CLASSES).flat())];

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

describe('corpus-compare: the normalization class map covers what the pass does', () => {
  /** A value the pass announces as normalized. */
  const isPlaceholder = (v) => typeof v === 'string' && (/^<.+>$/.test(v) || v === 'coord:<point>');

  it('every enumerated field token is reached by the pass', () => {
    // One crafted envelope carrying every token the class map names, with the
    // token→location table held equal to the map itself: a class that grows a
    // token this table has not learned reds here rather than going unexercised.
    const doc = envelope(
      [
        click({
          window_rect: { x: 1, y: 2, width: 3, height: 4 },
          opener_context_id: 999,
          element: { tag: 'Edit', selector: 'coord:12,34', described_after_ms: 42 },
        }),
      ],
      'desktop-windows',
    );
    const n = normalizeEnvelope(doc);
    const action = (d) => d.recordings[0].steps[0].actions[0];
    const step = (d) => d.recordings[0].steps[0];
    const locations = {
      schema_version: (d) => d.docent_format.schema_version,
      project_id: (d) => d.project.project_id,
      created_at: (d) => d.project.created_at,
      recording_id: (d) => d.recordings[0].recording_id,
      uuid: (d) => step(d).uuid,
      logical_id: (d) => step(d).logical_id,
      timestamp: (d) => action(d).timestamp,
      context_id: (d) => action(d).context_id,
      opener_context_id: (d) => action(d).opener_context_id,
      x: (d) => action(d).x,
      y: (d) => action(d).y,
      window_rect: (d) => action(d).window_rect,
      described_after_ms: (d) => action(d).element.described_after_ms,
      selector: (d) => action(d).element.selector,
    };
    assert.deepEqual(
      Object.keys(locations).sort(),
      [...NORMALIZED_FIELDS].sort(),
      'the crafted envelope and the exported class map name different field sets',
    );
    for (const [token, read] of Object.entries(locations)) {
      assert.ok(isPlaceholder(read(n)), `${token} was not normalized to a placeholder`);
    }
  });

  for (const platform of ['extension', 'desktop-windows']) {
    it(`every field the pass changes across the active ${platform} truths is enumerated`, () => {
      // The other direction, over real documents: whatever the pass actually
      // touches must be a token the class map names. Honest residue: a class
      // reaching a field no active truth carries is invisible here — the walk's
      // domain is the active sessions' committed truths, not the format.
      const changed = new Set();
      const walk = (a, b, key) => {
        if (a === b) return;
        const bothObjects =
          a !== null &&
          b !== null &&
          typeof a === 'object' &&
          typeof b === 'object' &&
          Array.isArray(a) === Array.isArray(b);
        if (!bothObjects) {
          if (key !== null) changed.add(key);
          return;
        }
        if (Array.isArray(a)) {
          for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], key);
          return;
        }
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], k);
      };
      const sessions = discoverSessions(join(CORPUS_DIR, 'manifest.json'), platform).filter(
        (s) => s.status === 'active',
      );
      assert.ok(sessions.length > 0, `no active ${platform} sessions to walk`);
      for (const session of sessions) {
        const truth = JSON.parse(readFileSync(session.truthPath, 'utf8'));
        walk(truth, normalizeEnvelope(truth), null);
      }
      assert.ok(changed.size > 0, 'the pass changed nothing at all — the walk is broken');
      for (const key of [...changed].sort()) {
        assert.ok(
          NORMALIZED_FIELDS.includes(key),
          `the pass changed \`${key}\`, which the class map does not enumerate`,
        );
      }
    });
  }
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

  it('scroll-amounts relaxes every field its class map covers', () => {
    const scroll = (over = {}) => ({
      type: 'scroll',
      timestamp: 3,
      element: { tag: 'DIV', selector: '#s' },
      scroll_top: 1,
      scroll_left: 1,
      delta_y: 1,
      delta_x: 1,
      context_id: 12345,
      capture_mode: 'dom',
      ...over,
    });
    const relax = [{ pointer: 'rec[0].step[0].action[0]', relax: 'scroll-amounts' }];
    for (const field of SCROLL_AMOUNT_FIELDS) {
      const findings = diffEnvelopes(
        envelope([scroll()]),
        envelope([scroll({ [field]: 99 })]),
        relax,
      );
      assert.deepEqual(findings, [], `${field} is covered but survived the relaxation`);
    }
  });

  it('path relaxes every field its class covers', () => {
    const dialog = (over = {}) => ({
      type: 'file_dialog',
      timestamp: 4,
      dialog_type: 'open',
      file_path: 'C:/build-a/fixture.txt',
      source: 'C:/build-a/driver.exe',
      context_id: 12345,
      capture_mode: 'accessibility',
      ...over,
    });
    const relax = [{ pointer: 'rec[0].step[0].action[0]', relax: 'path' }];
    for (const field of PATH_FIELDS) {
      const findings = diffEnvelopes(
        envelope([dialog()]),
        envelope([dialog({ [field]: 'C:/build-b/other.txt' })]),
        relax,
      );
      assert.deepEqual(findings, [], `${field} is covered but survived the relaxation`);
    }
  });

  it('match-stats replaces both statistics, on the truth entry and its aligned partner', () => {
    const withLoc = (locators) =>
      envelope([click({ element: { tag: 'BUTTON', selector: '#b', locators } })]);
    const entry = (over = {}) => ({
      strategy: 'css',
      value: '.b',
      match_count: 1,
      match_index: 0,
      ...over,
    });
    const truth = withLoc([entry()]);
    const relax = [
      { pointer: 'rec[0].step[0].action[0].locators[0]', strategy: 'css', relax: 'match-stats' },
    ];
    for (const field of MATCH_STAT_FIELDS) {
      const findings = diffEnvelopes(truth, withLoc([entry({ [field]: 7 })]), relax);
      assert.deepEqual(findings, [], `${field} is covered but survived the relaxation`);
    }
    // Scoped to the statistics: a differing non-statistic field on the same
    // entry still diffs, so the replacement is not a whole-entry wildcard.
    const findings = diffEnvelopes(
      truth,
      withLoc([entry({ value: '.other', match_count: 3, match_index: 2 })]),
      relax,
    );
    assert.deepEqual(
      findings.map((f) => f.path),
      ['element.locators.0.value'],
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

// The exit-code mapping is a process-boundary contract (STC-5): 0 = no
// findings, 1 = findings the caller must decide on, 2 = machinery breakage
// that can never read as a passing diff. Only a spawn observes it, so this
// suite runs the real CLI over a temporary corpus built from a committed
// truth file (schema-valid by construction). Env: the comparator and its
// import closure read no environment variable, so the inherited environment
// is the pinned one — nothing to override (the check-cli-smoke convention:
// pin every var the target reads).
describe('corpus-compare: CLI exit codes at the process boundary (STC-5)', () => {
  const SESSION = 'smoke';
  const SOURCE_TRUTH = join(CORPUS_DIR, 'sessions', 'ext-click-basic', 'truth.docent.json');
  let root = null;

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Build a temporary one-session corpus. `mutate` (when given) edits the
   * produced copy; `produce: false` leaves the produced file absent.
   */
  function corpus({ mutate = null, produce = true } = {}) {
    root ??= mkdtempSync(join(tmpdir(), 'docent-corpus-'));
    const dir = mkdtempSync(join(root, 'case-'));
    const truth = JSON.parse(readFileSync(SOURCE_TRUTH, 'utf8'));
    mkdirSync(join(dir, 'sessions', SESSION), { recursive: true });
    writeFileSync(join(dir, 'sessions', SESSION, 'truth.docent.json'), JSON.stringify(truth));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ sessions: [{ id: SESSION, platform: 'extension' }] }),
    );
    if (produce) {
      const produced = JSON.parse(JSON.stringify(truth));
      if (mutate) mutate(produced);
      mkdirSync(join(dir, 'out', 'extension'), { recursive: true });
      writeFileSync(
        join(dir, 'out', 'extension', `${SESSION}.docent.json`),
        JSON.stringify(produced),
      );
    }
    return dir;
  }

  /** Run the comparator against a temporary corpus; returns its exit status. */
  function run(dir, extraArgs = [], platform = 'extension') {
    const result = spawnSync(
      process.execPath,
      [
        COMPARATOR,
        '--manifest',
        join(dir, 'manifest.json'),
        '--out',
        join(dir, 'out'),
        '--platform',
        platform,
        ...extraArgs,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('exit 0 under --strict when truth and produced agree', () => {
    // --strict is what makes this leg falsifiable: without it the CLI exits 0
    // whatever it found, so a green here would say nothing about the diff.
    const { status, stdout } = run(corpus(), ['--strict']);
    assert.equal(status, 0);
    assert.match(stdout, /0 diff\(s\)/);
  });

  it('exit 1 under --strict on a one-field difference', () => {
    const dir = corpus({ mutate: (doc) => (doc.project.name = 'renamed by the producer') });
    const { status, stdout } = run(dir, ['--strict']);
    assert.equal(status, 1);
    assert.match(stdout, /wrong-field/);
  });

  it('exit 1 on a baseline mismatch', () => {
    const dir = corpus();
    const baseline = join(dir, 'baseline.json');
    writeFileSync(baseline, JSON.stringify({ [SESSION]: ['wrong-field rec[0] name'] }));
    const { status, stderr } = run(dir, ['--baseline', baseline]);
    assert.equal(status, 1);
    assert.match(stderr, /VANISHED/);
  });

  it('exit 2 when a produced counterpart is missing', () => {
    const { status, stderr } = run(corpus({ produce: false }), ['--strict']);
    assert.equal(status, 2);
    assert.match(stderr, /produced file missing/);
  });

  it('exit 2 on an unknown platform', () => {
    const { status, stderr } = run(corpus(), [], 'desktop-linux');
    assert.equal(status, 2);
    assert.match(stderr, /--platform must be one of/);
  });

  it('a finding and a machinery failure never share an exit code', () => {
    const findings = run(
      corpus({ mutate: (doc) => (doc.project.name = 'renamed by the producer') }),
      ['--strict'],
    ).status;
    const machinery = run(corpus({ produce: false }), ['--strict']).status;
    assert.equal(findings, 1);
    assert.equal(machinery, 2);
    assert.notEqual(findings, machinery, 'tooling breakage must never read as a diff verdict');
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

describe('corpus-compare: the session walk over an already-parsed catalogue', () => {
  it("sessionsIn returns the requested platform's sessions, in manifest order", () => {
    // Nothing is read from disk here: the catalogue is already parsed, and the
    // manifest path is only what the entry files resolve against.
    const manifest = {
      sessions: [
        { id: 'ext-second', platform: 'extension' },
        { id: 'win-only', platform: 'desktop-windows' },
        { id: 'ext-first', platform: 'extension', status: 'retired', overrides: 'o.json' },
        { id: 'ext-named', platform: 'extension', truth: 'named.docent.json' },
      ],
    };
    const walked = sessionsIn(manifest, join(CORPUS_DIR, 'manifest.json'), 'extension');
    assert.deepEqual(
      walked.map((s) => s.id),
      ['ext-second', 'ext-first', 'ext-named'],
    );
    assert.deepEqual(
      walked.map((s) => s.status),
      ['active', 'retired', 'active'],
    );
    assert.equal(
      walked[0].truthPath,
      join(CORPUS_DIR, 'sessions', 'ext-second', 'truth.docent.json'),
    );
    // Both sides of the truth fallback: the default where the entry states no
    // filename, the entry's own where it states one.
    assert.equal(
      walked[2].truthPath,
      join(CORPUS_DIR, 'sessions', 'ext-named', 'named.docent.json'),
    );
    assert.equal(walked[0].overridesPath, null);
    assert.equal(walked[1].overridesPath, join(CORPUS_DIR, 'sessions', 'ext-first', 'o.json'));
  });

  it('catches an unconditional path join grown over a field the guard does not read', () => {
    // The catalogue guard in scripts/check-verification-inventory.js validates
    // the entry values this walk path-joins, to the depth it joins them, and
    // states that mirroring in its own docblock. What this holds is the
    // UNCONDITIONAL half of that pairing: a join grown here straight over an
    // unguarded field meets `notes`'s non-string value and throws out of
    // `join` — machinery breakage where the catalogue's shape verdict belongs
    // — so it reds here. A conditional join, the shape `overrides` already
    // uses, reads the field as absent, skips, and passes: that half is not
    // held by this case.
    const manifest = {
      sessions: [{ id: 'ext-extra', platform: 'extension', notes: 5, extra: null }],
    };
    let walked;
    assert.doesNotThrow(() => {
      walked = sessionsIn(manifest, join(CORPUS_DIR, 'manifest.json'), 'extension');
    });
    assert.deepEqual(
      walked.map((s) => s.id),
      ['ext-extra'],
    );
    assert.equal(
      walked[0].truthPath,
      join(CORPUS_DIR, 'sessions', 'ext-extra', 'truth.docent.json'),
    );
  });
});

for (const platform of ['extension', 'desktop-windows']) {
  describe(`corpus hygiene locks (committed tree, ${platform})`, () => {
    const manifestPath = join(CORPUS_DIR, 'manifest.json');
    const sessions = discoverSessions(manifestPath, platform);

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
        readFileSync(join(CORPUS_DIR, `known-diffs.${platform}.json`), 'utf8'),
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
}

// Regression: a sidecar entry that could never apply — unknown kind, or a
// pointer matching no truth action — was silently ignored (the per-step
// pointer gate preceded all validation), so a typo'd sidecar read as a
// passing diff. Found in the review of the corpus doctrine round (the
// doctrine promises machinery breakage can never read as a pass).
describe('sidecar validation: entries that cannot apply are machinery errors', () => {
  const truth = {
    docent_format: { platform: 'extension', schema_version: '1.0.0' },
    project: { project_id: 'p', name: 'P', created_at: 't' },
    recordings: [
      {
        recording_id: 'r',
        name: 'R',
        created_at: 't',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'u1',
            step_number: 1,
            created_at: 't',
            narration: 'n',
            actions: [
              {
                type: 'click',
                timestamp: 1,
                x: 1,
                y: 1,
                element: { tag: 'a', selector: 's' },
                context_id: 1,
                capture_mode: 'dom',
              },
            ],
            deleted: false,
          },
        ],
      },
    ],
  };

  it('unknown kind on a resolvable pointer is refused (guard)', () => {
    assert.throws(
      () =>
        diffEnvelopes(
          truth,
          truth,
          [{ pointer: 'rec[0].step[0].action[0]', relax: 'everything' }],
          's',
        ),
      /unknown kind/,
    );
  });

  it('regression_dangling_relaxation_pointer_is_a_machinery_error', () => {
    assert.throws(
      () =>
        diffEnvelopes(truth, truth, [{ pointer: 'rec[0].step[9].action[0]', relax: 'path' }], 's'),
      /matched no truth action|does not exist/,
    );
  });

  it('a valid relaxation still applies (guard)', () => {
    const t2 = JSON.parse(JSON.stringify(truth));
    t2.recordings[0].steps[0].actions[0] = {
      type: 'file_dialog',
      timestamp: 1,
      dialog_type: 'open',
      file_path: 'a/b',
      source: 'dialog',
      context_id: 1,
      capture_mode: 'accessibility',
    };
    const produced = JSON.parse(JSON.stringify(t2));
    produced.recordings[0].steps[0].actions[0].file_path = 'c/d';
    const findings = diffEnvelopes(
      t2,
      produced,
      [{ pointer: 'rec[0].step[0].action[0]', relax: 'path' }],
      's',
    );
    assert.deepEqual(findings, []);
  });
});
