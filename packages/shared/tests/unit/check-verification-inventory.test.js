/**
 * check-verification-inventory.test.js — Unit tests for the
 * verification-inventory admission test
 * (scripts/check-verification-inventory.js). Each inventory is committed
 * prose held against a constant, the manifest, or the workflow, so every
 * red-path family must fail loud: these tests prove the both-way set diffs on
 * each set inventory and the one-way containment of the job-citation leg (every
 * cite names a real job; a job owes no cite), the per-kind field diffs, the
 * class claim, the unreadable-item, unreadable-cell, and unreadable-token
 * refusals, the exactly-one-table selection, the per-document
 * citation vacuity guard, duplicates, empty parses, and the loud refusal of an
 * input file the command-line readers cannot read or cannot recognise as a
 * session catalogue — plus the extraction
 * grammars on synthetic documents, and, as a real-tree lock, that the shipped
 * documents satisfy every pin.
 *
 * The exit-code contract is pinned where it lives, at the process boundary: a
 * spawned-CLI family runs the real command over a temporary tree holding copies
 * of the files it reads, and holds 0 / 1 / 2 to their meanings — green, an
 * inventory that drifted, and machinery breakage that must never read as a
 * drift verdict.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CORPUS_DOC_PATH,
  LINT_DOC_PATH,
  MANIFEST_PATH,
  NORMALIZATION_TABLE_HEADER,
  PER_ACTION_TABLE_HEADER,
  RECORDING_TABLE_HEADER,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  CODE_RELAXATION_FIELDS,
  CODE_NORMALIZATION_TOKENS,
  RELAXATION_LITERALS,
  NORMALIZATION_LITERALS,
  readFieldTokens,
  topLevelListItems,
  extractRelaxationCoverage,
  selectTableByHeader,
  extractNormalizationTokens,
  extractSessionIds,
  extractPredicateTables,
  extractJobCites,
  evaluateVerificationInventory,
  auditTree,
  InputError,
  readTreeFile,
  listActiveDesktopSessions,
} from '../../../../scripts/check-verification-inventory.js';
import { TEST_WORKFLOW_PATH } from '../../../../scripts/check-doc-closure.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** A consistent synthetic surface every leg accepts. */
function makeSurface(overrides = {}) {
  return {
    docKinds: ['match-stats', 'path'],
    docKindFields: [
      ['match-stats', ['match_count', 'match_index']],
      ['path', ['file_path', 'source']],
    ],
    relaxUnreadable: [],
    codeKinds: ['match-stats', 'path'],
    codeKindFields: [
      ['match-stats', ['match_count', 'match_index']],
      ['path', ['file_path', 'source']],
    ],
    docNormalizationTokens: ['project_id', 'timestamp'],
    normalizationTableMatches: 1,
    codeNormalizationTokens: ['project_id', 'timestamp'],
    docSessionIds: ['d-click', 'd-redaction'],
    manifestSessionIds: ['d-click', 'd-redaction'],
    docPerAction: ['element-locators', 'key-nonempty'],
    perActionTableMatches: 1,
    codePerAction: ['element-locators', 'key-nonempty'],
    codeNonFailPerAction: [],
    docRecording: ['context-introduced fail', 'start-point gap'],
    recordingTableMatches: 1,
    codeRecording: ['context-introduced fail', 'start-point gap'],
    predicateUnreadable: [],
    unreadableTokens: [],
    docCites: [
      { path: CORPUS_DOC_PATH, cites: ['unit-tests'] },
      { path: LINT_DOC_PATH, cites: ['unit-tests'] },
    ],
    workflowJobIds: ['lint', 'unit-tests'],
    ...overrides,
  };
}

describe('evaluateVerificationInventory — compliant baseline', () => {
  it('returns no problems when every inventory holds', () => {
    assert.deepEqual(evaluateVerificationInventory(makeSurface()), []);
  });
});

describe('evaluateVerificationInventory — relaxation kinds and their fields', () => {
  it('fires when the clause states a kind the comparator does not carry', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docKinds: ['match-stats', 'path', 'timings'],
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['timings', ['duration_ms']],
        ],
      }),
    );
    assert.ok(problems.some((p) => p.includes('timings') && p.includes('RELAX_KINDS does not')));
  });

  it('fires when the comparator carries a kind the clause does not state', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        codeKinds: ['match-stats', 'path', 'scroll-amounts'],
        codeKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['scroll-amounts', ['scroll_top']],
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('scroll-amounts') && p.includes('does not state')),
      problems.join('\n'),
    );
  });

  it('fires when a comparator kind has no field list in this check', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docKinds: ['match-stats', 'path', 'scroll-amounts'],
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['scroll-amounts', ['scroll_top']],
        ],
        codeKinds: ['match-stats', 'path', 'scroll-amounts'],
      }),
    );
    assert.ok(problems.some((p) => p.includes('scroll-amounts') && p.includes('knows no field list'))); // prettier-ignore
  });

  it('fires when this check knows a field list for a kind the comparator dropped', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        codeKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['retired-kind', ['gone']],
        ],
      }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('retired-kind') && p.includes('is not a comparator relaxation kind'),
      ),
    );
  });

  it('fires on a field stated twice inside one kind’s item', () => {
    // The set diffs deduplicate, so a doubled field is invisible to them.
    const problems = evaluateVerificationInventory(
      makeSurface({
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source', 'file_path']],
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('file_path') && p.includes('more than once') && p.includes('`path` covered-field list')), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('fires in both directions on one kind’s covered fields', () => {
    const docExtra = evaluateVerificationInventory(
      makeSurface({
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source', 'dialog_path']],
        ],
      }),
    );
    assert.ok(docExtra.some((p) => p.includes('dialog_path') && p.includes('does not carry')));
    const codeExtra = evaluateVerificationInventory(
      makeSurface({
        codeKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source', 'dialog_path']],
        ],
      }),
    );
    assert.ok(codeExtra.some((p) => p.includes('dialog_path') && p.includes('does not state')));
  });
});

describe('evaluateVerificationInventory — normalization classes (both ways)', () => {
  it('fires when the table names a token the class map does not carry', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docNormalizationTokens: ['project_id', 'timestamp', 'viewport'] }),
    );
    assert.ok(problems.some((p) => p.includes('viewport') && p.includes('class map does not carry'))); // prettier-ignore
  });

  it('fires when the class map carries a token the table does not state', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ codeNormalizationTokens: ['project_id', 'timestamp', 'window_rect'] }),
    );
    assert.ok(problems.some((p) => p.includes('window_rect') && p.includes('does not state')));
  });
});

describe('evaluateVerificationInventory — session catalogue (both ways)', () => {
  it('fires when the clause enumerates a session the manifest does not run', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docSessionIds: ['d-click', 'd-redaction', 'd-retired'] }),
    );
    assert.ok(problems.some((p) => p.includes('d-retired') && p.includes('no active')));
  });

  it('fires when an active session is missing from the clause', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ manifestSessionIds: ['d-click', 'd-redaction', 'd-new-behaviour'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('d-new-behaviour') && p.includes('does not enumerate it')),
    );
  });
});

describe('evaluateVerificationInventory — predicate catalogue', () => {
  it('fires in both directions on the per-action names', () => {
    const docExtra = evaluateVerificationInventory(
      makeSurface({ docPerAction: ['element-locators', 'key-nonempty', 'ghost-predicate'] }),
    );
    assert.ok(docExtra.some((p) => p.includes('ghost-predicate') && p.includes('does not define')));
    const codeExtra = evaluateVerificationInventory(
      makeSurface({ codePerAction: ['element-locators', 'key-nonempty', 'new-predicate'] }),
    );
    assert.ok(
      codeExtra.some((p) => p.includes('new-predicate') && p.includes('table does not carry')),
    );
  });

  it('fires on a recording-level class the doc and the code disagree on', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docRecording: ['context-introduced fail', 'start-point fail'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('start-point fail') && p.includes('does not define')),
    );
    assert.ok(problems.some((p) => p.includes('start-point gap') && p.includes('does not carry')));
  });

  it('fires when a per-action predicate is not fail class', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ codeNonFailPerAction: ['key-nonempty'] }),
    );
    assert.ok(problems.some((p) => p.includes('key-nonempty') && p.includes('not `fail` class')));
  });
});

describe('evaluateVerificationInventory — job citations', () => {
  it('fires when a document cites a job the workflow does not define', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docCites: [
          { path: CORPUS_DOC_PATH, cites: ['unit-tests', 'renamed-away'] },
          { path: LINT_DOC_PATH, cites: ['unit-tests'] },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('renamed-away') && p.includes('has no such job')),
      problems.join('\n'),
    );
  });

  it('fires per scanned document when its citation extraction comes back empty', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docCites: [
          { path: CORPUS_DOC_PATH, cites: ['unit-tests'] },
          { path: LINT_DOC_PATH, cites: [] },
        ],
      }),
    );
    // The guard is unconditional; its message names both legitimate exits
    // rather than asserting the scan is the broken side.
    const empty = problems.filter((p) => p.includes(LINT_DOC_PATH) && p.includes('no job citations found')); // prettier-ignore
    assert.equal(empty.length, 1, problems.join('\n'));
    assert.ok(empty[0].includes('restore a job cite'), empty[0]);
    assert.ok(empty[0].includes("drop the document from this check's scanned set"), empty[0]);
  });
});

describe('evaluateVerificationInventory — table selection is exactly one', () => {
  for (const [key, header, label] of [
    ['normalizationTableMatches', NORMALIZATION_TABLE_HEADER, 'normalization'],
    ['perActionTableMatches', PER_ACTION_TABLE_HEADER, 'per-action'],
    ['recordingTableMatches', RECORDING_TABLE_HEADER, 'recording-level'],
  ]) {
    it(`fires when the ${label} header tuple matches no table`, () => {
      const problems = evaluateVerificationInventory(makeSurface({ [key]: 0 }));
      assert.ok(problems.some((p) => p.includes(header.join(' | ')) && p.includes('exactly one')));
    });

    it(`fires when the ${label} header tuple matches two tables`, () => {
      const problems = evaluateVerificationInventory(makeSurface({ [key]: 2 }));
      assert.ok(problems.some((p) => p.includes(header.join(' | ')) && p.includes('exactly one')));
    });
  }
});

describe('evaluateVerificationInventory — unreadable surfaces are refused ahead of the diffs', () => {
  it('reports each unreadable family with its own diagnosis', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        relaxUnreadable: ['a prose bullet with no kind'],
        predicateUnreadable: ['per-action row first cell "two `names` here"'],
      }),
    );
    assert.ok(problems.some((p) => p.includes('a prose bullet with no kind')));
    assert.ok(problems.some((p) => p.includes('two `names` here') && p.includes('cannot read')));
  });
});

// Fixture rows for the duplicates family, keyed to the check's own exported
// DUPLICATE_SURFACES list. The lock below holds the two key sets equal, so a
// surface added to the check's loop without a fixture row reds here — the
// addition direction the per-leg tests alone cannot see.
const DUPLICATE_FIXTURES = {
  docKinds: ['match-stats', 'path', 'path'],
  docNormalizationTokens: ['project_id', 'timestamp', 'project_id'],
  docSessionIds: ['d-click', 'd-redaction', 'd-click'],
  docPerAction: ['element-locators', 'key-nonempty', 'element-locators'],
  docRecording: ['context-introduced fail', 'start-point gap', 'context-introduced fail'],
};

describe('evaluateVerificationInventory — duplicates, every leg of the duplicates loop', () => {
  it('the fixture table covers exactly the check’s duplicates legs (addition lock)', () => {
    assert.deepEqual(
      Object.keys(DUPLICATE_FIXTURES).sort(),
      DUPLICATE_SURFACES.map(([key]) => key).sort(),
    );
  });

  it('the surface labels are pairwise distinct — a copied leg cannot hide behind its neighbour', () => {
    assert.ok(DUPLICATE_SURFACES.length > 0);
    const labels = DUPLICATE_SURFACES.map(([, what]) => what);
    assert.equal(new Set(labels).size, labels.length);
  });

  for (const [key, what] of DUPLICATE_SURFACES) {
    it(`fires on a duplicate in ${what}`, () => {
      const problems = evaluateVerificationInventory(
        makeSurface({ [key]: DUPLICATE_FIXTURES[key] }),
      );
      assert.ok(
        problems.some((p) => p.includes('more than once') && p.includes(what)),
        problems.join('\n') || `no duplicates diagnostic for ${what}`,
      );
    });
  }
});

describe('evaluateVerificationInventory — empty parses are structural failures', () => {
  it('the export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, message]) => message);
    assert.equal(new Set(messages).size, messages.length);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateVerificationInventory(makeSurface({ [key]: [] }));
      assert.ok(
        problems.some((p) => p.includes(message)),
        problems.join('\n') || `no vacuous diagnostic for ${key}`,
      );
    });
  }
});

describe('topLevelListItems — item bounding', () => {
  const clause = [
    ' **Sidecar shape.** Intro prose that runs',
    'across two lines:',
    '',
    '- `first` — covers `alpha_one` and',
    '  `alpha_two`;',
    '- `second` — covers `beta_one` (and keeps `0` exact).',
    '',
    'A following paragraph naming `gamma_one` must not be absorbed.',
  ].join('\n');

  it('reads one item per top-level marker, joining its indented continuation', () => {
    assert.deepEqual(topLevelListItems(clause), [
      '`first` — covers `alpha_one` and `alpha_two`;',
      '`second` — covers `beta_one` (and keeps `0` exact).',
    ]);
  });

  it('the paragraph after the list stays outside the last item', () => {
    assert.ok(!topLevelListItems(clause).some((item) => item.includes('gamma_one')));
  });

  it('returns nothing for a clause with no list', () => {
    assert.deepEqual(topLevelListItems('plain prose only'), []);
  });
});

describe('extractRelaxationCoverage — kind and fields per item', () => {
  const doc = [
    '## Comparator and relaxations',
    '',
    '**STC-21.** **Sidecar shape.** Each kind alters exactly its covered fields:',
    '',
    '- `match-stats` — the entry’s `match_count` and `match_index`;',
    '- `scroll-amounts` — the nonzero values of `scroll_top` and',
    '  `delta_y` (the class map keeps `0` exact);',
    '',
    'A closing paragraph about `pointer` semantics.',
    '',
    '## Page-authoring rules',
  ].join('\n');

  it('takes the first backticked token as the kind and the rest as its fields', () => {
    const read = extractRelaxationCoverage(doc);
    assert.deepEqual(read.kinds, ['match-stats', 'scroll-amounts']);
    assert.deepEqual(new Map(read.fields).get('match-stats'), ['match_count', 'match_index']);
    assert.deepEqual(new Map(read.fields).get('scroll-amounts'), ['scroll_top', 'delta_y']);
    assert.deepEqual(read.unreadable, []);
  });

  it('reports an item that names no kind rather than skipping it', () => {
    const read = extractRelaxationCoverage(
      doc.replace(
        '- `match-stats` — the entry’s `match_count` and `match_index`;',
        '- prose only;',
      ),
    );
    assert.ok(read.unreadable.some((item) => item.includes('prose only')), JSON.stringify(read)); // prettier-ignore
  });

  it('reads nothing when the clause marker is absent', () => {
    assert.deepEqual(extractRelaxationCoverage('# no clauses here').kinds, []);
  });
});

/** A minimal document whose normalization table sits under §STC-19, as shipped. */
const normalizationDoc = () =>
  [
    '**STC-19.** Comparison is normalized.',
    '',
    '| Class | Rule |',
    '| --- | --- |',
    '| identifiers (`project_id`, `recording_id`) | ordinal placeholders |',
    '| coordinate-mode `selector` (`coord:x,y`) | point placeholder |',
  ].join('\n');

describe('readFieldTokens / selectTableByHeader / extractNormalizationTokens', () => {
  it('keeps field-shaped tokens and allows the scope’s own literals', () => {
    const read = readFieldTokens(
      '`x`/`y`; non-null `window_rect` (`coord:x,y`)',
      NORMALIZATION_LITERALS,
    );
    assert.deepEqual(read.fields, ['x', 'y', 'window_rect']);
    assert.deepEqual(read.unreadable, []);
  });

  it('skips the leading tokens another grammar already read', () => {
    const read = readFieldTokens('`scroll-amounts` — `scroll_top` and `0`', RELAXATION_LITERALS, 1);
    assert.deepEqual(read.fields, ['scroll_top']);
    assert.deepEqual(read.unreadable, []);
  });

  it('selects on the whole header tuple, and refuses an ambiguous document', () => {
    const one = ['| Class | Rule |', '| --- | --- |', '| `a_field` | r |'].join('\n');
    assert.equal(selectTableByHeader(one, ['Class', 'Rule']).matches, 1);
    // A sibling table sharing only the first header cell is never conscripted.
    const sibling = [one, '', '| Class | Meaning |', '| --- | --- |', '| `b_field` | m |'].join('\n'); // prettier-ignore
    assert.equal(selectTableByHeader(sibling, ['Class', 'Rule']).matches, 1);
    const twice = [one, '', one].join('\n');
    assert.equal(selectTableByHeader(twice, ['Class', 'Rule']).matches, 2);
    assert.equal(selectTableByHeader(twice, ['Class', 'Rule']).table, null);
  });

  it('reads the Class column’s field tokens from the one matching table', () => {
    const read = extractNormalizationTokens(normalizationDoc());
    assert.equal(read.matches, 1);
    assert.deepEqual(read.tokens, ['project_id', 'recording_id', 'selector']);
  });

  it('reads the table only inside §STC-19’s own section', () => {
    // The attribution this check prints ("§STC-19's Class cell") is only true
    // while the table is read from under that clause. A table that moved out
    // must come back as zero matches, not be read from wherever it landed.
    const moved = normalizationDoc().replace('**STC-19.** Comparison is normalized.\n\n', '');
    assert.equal(extractNormalizationTokens(moved).matches, 0);
    assert.deepEqual(extractNormalizationTokens(moved).tokens, []);

    // …and a same-shaped table under a later clause is not conscripted either.
    const elsewhere = [
      normalizationDoc(),
      '',
      '**STC-20.** Order of operations.',
      '',
      '| Class | Rule |',
      '| --- | --- |',
      '| `imposter_field` | not §STC-19’s |',
    ].join('\n');
    const read = extractNormalizationTokens(elsewhere);
    assert.equal(read.matches, 1);
    assert.ok(!read.tokens.includes('imposter_field'), read.tokens.join(','));
  });
});

describe('extractSessionIds / extractPredicateTables / extractJobCites', () => {
  it('reads the session ids of the catalogue clause only', () => {
    const doc = [
      '**STC-22.** Each session pins one behaviour: `d-click`, `d-type-edit`.',
      '',
      '## Elsewhere',
      '',
      'An unrelated mention of `d-not-a-session`.',
    ].join('\n');
    const read = extractSessionIds(doc);
    assert.deepEqual(read.ids, ['d-click', 'd-type-edit']);
    assert.deepEqual(read.unreadableTokens, []);
  });

  it('refuses a session token that misses the grammar rather than dropping it', () => {
    // Dropped, these produced the inverted diagnosis: the manifest-side diff
    // would report the session as one the clause "does not enumerate", when the
    // clause names it and only the spelling is off.
    const doc = [
      '**STC-22.** Each session pins one behaviour: `d-click`, `d-Type-Edit`,',
      '`d-scroll-floor2`.',
    ].join('\n');
    const read = extractSessionIds(doc);
    assert.deepEqual(read.ids, ['d-click']);
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['d-Type-Edit', 'd-scroll-floor2'],
    );
    const problems = evaluateVerificationInventory(
      makeSurface({ unreadableTokens: read.unreadableTokens }),
    );
    assert.ok(
      problems.some((p) => p.includes('d-Type-Edit') && p.includes('session ids there are')),
      problems.join('\n'),
    );
  });

  it('the shipped catalogue clause carries no unreadable session token', () => {
    const read = extractSessionIds(readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8'));
    assert.deepEqual(read.unreadableTokens, []);
    assert.ok(read.ids.length > 0);
  });

  it('reads both predicate tables and refuses an unreadable cell', () => {
    const doc = [
      '| Predicate | Applies to | Requires |',
      '| --- | --- | --- |',
      '| `element-locators` | elements | one candidate |',
      '',
      '| Predicate | Class | States |',
      '| --- | --- | --- |',
      '| `start-point` | `gap` | where reproduction begins |',
      '| two `names` here | `fail` | unreadable |',
    ].join('\n');
    const read = extractPredicateTables(doc);
    assert.deepEqual(read.perAction, ['element-locators']);
    assert.equal(read.perActionMatches, 1);
    assert.deepEqual(read.recording, ['start-point gap']);
    assert.equal(read.recordingMatches, 1);
    assert.ok(read.unreadable.some((cell) => cell.includes('two `names` here')));
  });

  it('reads job citations from live text and never from a fenced example', () => {
    const doc = [
      'Produced by the `extension-e2e-tests` job and diffed there.',
      '',
      '```text',
      'the `imaginary-job` job would print here',
      '```',
    ].join('\n');
    assert.deepEqual(extractJobCites(doc), ['extension-e2e-tests']);
  });
});

describe('unreadable backticked tokens are refused, never dropped', () => {
  it('a camelCase token in a scanned Class cell reds instead of shrinking the scan', () => {
    const doc = normalizationDoc().replace('`recording_id`', '`matchCount`');
    const read = extractNormalizationTokens(doc);
    assert.deepEqual(read.tokens, ['project_id', 'selector']); // matchCount did not vanish into these
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['matchCount'],
    );
    const problems = evaluateVerificationInventory(
      makeSurface({ unreadableTokens: read.unreadableTokens }),
    );
    assert.ok(
      problems.some((p) => p.includes('matchCount') && p.includes('lower-case with underscores')),
      problems.join('\n'),
    );
  });

  it('a digit-bearing field name reds rather than vanishing from a kind’s coverage', () => {
    const doc = [
      '**STC-21.** **Sidecar shape.** Each kind alters exactly its covered fields:',
      '',
      '- `scroll-amounts` — the nonzero values of `scroll_top` and `delta_y2`',
      '  (the class map keeps `0` exact);',
    ].join('\n');
    const read = extractRelaxationCoverage(doc);
    assert.deepEqual(new Map(read.fields).get('scroll-amounts'), ['scroll_top']);
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['delta_y2'],
    );
    assert.ok(read.unreadableTokens[0].where.includes('scroll-amounts'));
  });

  it('the shipped document’s own shapes carry no unreadable token', () => {
    const text = readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8');
    assert.deepEqual(extractRelaxationCoverage(text).unreadableTokens, []);
    assert.deepEqual(extractNormalizationTokens(text).unreadableTokens, []);
  });

  it('each allowance is load-bearing — its literal reds where the scope does not allow it', () => {
    for (const literal of [...RELAXATION_LITERALS, ...NORMALIZATION_LITERALS]) {
      assert.deepEqual(
        readFieldTokens(`a field \`some_field\` beside \`${literal}\``, new Set()).unreadable,
        [literal],
      );
    }
  });
});

describe('the check’s own code-side association', () => {
  it('carries a field list for every kind, none of them empty', () => {
    assert.ok(CODE_RELAXATION_FIELDS.size > 0);
    for (const [kind, fields] of CODE_RELAXATION_FIELDS) {
      assert.ok(Array.isArray(fields) && fields.length > 0, `no fields listed for ${kind}`);
    }
  });

  it('flattens the comparator’s class map into distinct field tokens', () => {
    assert.ok(CODE_NORMALIZATION_TOKENS.length > 0);
    assert.equal(new Set(CODE_NORMALIZATION_TOKENS).size, CODE_NORMALIZATION_TOKENS.length);
  });
});

describe('command-line readers — an unreadable input is never an empty inventory', () => {
  it('a malformed manifest fails loudly naming the file, not as an empty session catalogue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, '{ "sessions": [ ');
    try {
      assert.throws(
        () => listActiveDesktopSessions(manifest),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.ok(error.message.includes(manifest), error.message);
          // The drift diagnosis this must never be mistaken for.
          assert.ok(!error.message.includes('no active'), error.message);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a manifest that parses but carries no sessions array gets its own words', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, '{ "sessions": {} }');
    try {
      assert.throws(
        () => listActiveDesktopSessions(manifest),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, /carries no `sessions` array/);
          // Shape, not readability — the file read and parsed perfectly well.
          assert.doesNotMatch(error.message, /could not be read|not parseable/);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed session entry takes the shape verdict, whichever way it would escape', () => {
    // Two routes, one verdict. A missing `id` fell through to the discovery
    // walk and left as a TypeError — the drift exit code, and a stack instead
    // of a diagnosis. A missing `platform` never raised at all: the walk
    // filters on it, so the entry silently dropped, and with one entry in the
    // manifest the catalogue came back EMPTY — routing to the vacuity
    // diagnosis against the manifest. Still the wrong verdict class for a
    // malformed file, which is why the shape guard takes it first.
    for (const [missing, entry] of [
      ['id', { platform: 'desktop-windows' }],
      ['platform', { id: 'd-click' }],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
      const manifest = join(dir, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ sessions: [entry] }));
      try {
        assert.throws(
          () => listActiveDesktopSessions(manifest),
          (error) => {
            assert.ok(error instanceof InputError, `not an InputError for ${missing}: ${error}`);
            assert.match(error.message, /shape is what failed here/);
            assert.match(error.message, new RegExp(`sessions\\[0\\]\` entry carries no string \`${missing}\``)); // prettier-ignore
            assert.doesNotMatch(error.message, /could not be read|not parseable/);
            return true;
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('a non-string truth or overrides takes the shape verdict too', () => {
    // The other keys the discovery walk path-joins. No spawned leg here: the
    // malformed-entry case below already pins that these reach the CLI as the
    // machinery verdict — what is new is only which keys are covered.
    for (const [key, entry] of [
      ['truth', { id: 'd-click', platform: 'desktop-windows', truth: 5 }],
      ['overrides', { id: 'd-click', platform: 'desktop-windows', overrides: 5 }],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
      const manifest = join(dir, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ sessions: [entry] }));
      try {
        assert.throws(
          () => listActiveDesktopSessions(manifest),
          (error) => {
            assert.ok(error instanceof InputError, `not an InputError for ${key}: ${error}`);
            assert.match(error.message, /shape is what failed here/);
            assert.match(error.message, new RegExp(`sessions\\[0\\]\` entry carries a non-string \`${key}\``)); // prettier-ignore
            assert.doesNotMatch(error.message, /could not be read|not parseable/);
            return true;
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('an unreadable document fails loudly naming it rather than parsing as empty', () => {
    assert.throws(
      () => readTreeFile(join(ROOT, 'docs', 'verification', 'no-such-document.md')),
      (error) =>
        error instanceof InputError &&
        error.message.includes('no-such-document.md') &&
        error.message.includes('could not be read'),
    );
  });

  it('a readable file still comes back as its text', () => {
    assert.ok(readTreeFile(join(ROOT, CORPUS_DOC_PATH)).includes('STC-19'));
  });
});

// The exit-code contract is a process-boundary fact — 0 green, 1 an inventory
// that drifted, 2 machinery breakage that must never read as a drift verdict —
// and only a spawn observes it. Every file the CLI reads is cwd-relative (both
// verification documents, the workflow, the manifest), so a temporary tree
// holding copies of exactly those is a complete input surface: nothing else it
// touches comes off disk. Env: the script's whole import closure reads no
// process.env, so the inherited environment is already the pinned one.
describe('check-verification-inventory: CLI exit codes at the process boundary', () => {
  const SCRIPT = join(ROOT, 'scripts', 'check-verification-inventory.js');
  const READS = [CORPUS_DOC_PATH, LINT_DOC_PATH, TEST_WORKFLOW_PATH, MANIFEST_PATH];
  let root = null;

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A temporary tree holding copies of the files the CLI reads. */
  function tree(mutate = null) {
    root ??= mkdtempSync(join(tmpdir(), 'docent-inventory-cli-'));
    const dir = mkdtempSync(join(root, 'case-'));
    const files = new Map(READS.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
    if (mutate) mutate(files);
    for (const [rel, text] of files) {
      const target = join(dir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }

  /** Run the real CLI against a temporary tree; returns its exit status. */
  function run(dir) {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('exit 0 over pristine copies of the files it reads', () => {
    const { status, stdout } = run(tree());
    assert.equal(status, 0, stdout);
    assert.match(stdout, /verification inventories current/);
  });

  it('exit 1 with the drift verdict when a documented covered field is dropped', () => {
    const { status, stderr } = run(
      tree((files) => {
        const doc = files.get(CORPUS_DOC_PATH);
        const stated = ', and `delta_x` (';
        assert.ok(doc.includes(stated), 'the mutation anchor moved');
        files.set(CORPUS_DOC_PATH, doc.replace(stated, ' ('));
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /inventory drifted/);
    assert.match(stderr, /delta_x/);
  });

  it('exit 2 with the machinery verdict when the manifest will not parse', () => {
    const { status, stderr } = run(tree((files) => files.set(MANIFEST_PATH, '{ "sessions": [ ')));
    assert.equal(status, 2);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /is not parseable JSON/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /inventory drifted/);
  });

  it('exit 2 when a session entry is malformed, not exit 1 with a type error', () => {
    // Executed escape before the shape guard went deeper: this input exited 1
    // with a TypeError stack, so a broken manifest read as a drifted inventory.
    const { status, stderr } = run(
      tree((files) =>
        files.set(MANIFEST_PATH, JSON.stringify({ sessions: [{ platform: 'desktop-windows' }] })),
      ),
    );
    assert.equal(status, 2, stderr);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /shape is what failed here/);
    assert.doesNotMatch(stderr, /inventory drifted/);
    assert.doesNotMatch(stderr, /TypeError/);
  });

  it('the drift verdict and the machinery verdict never share an exit code', () => {
    const drift = run(
      tree((files) =>
        files.set(CORPUS_DOC_PATH, files.get(CORPUS_DOC_PATH).replace(', and `delta_x` (', ' (')),
      ),
    ).status;
    const machinery = run(tree((files) => files.set(MANIFEST_PATH, '{ "sessions": [ '))).status;
    assert.notEqual(drift, machinery);
    assert.equal(drift, 1);
    assert.equal(machinery, 2);
  });
});

describe('real-tree lock', () => {
  it('the committed verification documents satisfy every inventory pin', () => {
    // Through the shipped reader, uncaught: a renamed or moved document must
    // red here as the read failure it is, never as an inventory that came back
    // empty. Only the root anchoring is this lock's own (the suite runs from
    // anywhere; the CLI runs from the repository root).
    const readFile = (path) => readTreeFile(join(ROOT, path));
    const listSessions = () => listActiveDesktopSessions(join(ROOT, MANIFEST_PATH));
    const { problems, pinCount } = auditTree(readFile, listSessions);
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(pinCount > 0, 'the audit read no documented entries at all');
  });
});
