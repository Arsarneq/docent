/**
 * check-test-inventory.test.js — Unit tests for the test-inventory lint
 * (scripts/check-test-inventory.js) that gates CI. The suite documents' tables
 * and the hand-maintained coverage lists are committed data, so every way they
 * can rot must fail loud: these tests drive each red path over synthetic
 * documents and synthetic sources — an undocumented test file, a row naming a
 * file that is not a member of the suite, a duplicate row, a coverage entry
 * pointing at nothing, an entry whose two halves name different files, and each
 * way the extraction can fail to reach its whole subject. Table parsing is
 * proven to read only the documented section and to ignore prose and fenced
 * blocks (the reason the check reads rows, not text), and the array scan survives
 * reformatting while refusing a restructured literal rather than reading part
 * of it. The report is proven to carry every class the audit can raise,
 * including one it has no wording for yet. Real-tree locks prove the shipped
 * inventories hold and that each suite's membership rule still matches the
 * discovery it mirrors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DOC_INVENTORIES,
  TRACKED_LISTS,
  auditInventories,
  backtickedName,
  formatProblems,
  identifiesSameFile,
  parseTables,
  readListEntries,
  splitRow,
  tokenizeJs,
} from '../../../../scripts/check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** All tracked repo-relative paths, for the real-tree locks. */
const trackedFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * One synthetic inventory document + the suite it claims to describe. Its
 * membership rule is deliberately the simplest one that can be wrong in both
 * directions — top-level `.spec.js` only; the recursive case gets its own
 * inventory in the test that needs it.
 */
const INVENTORY = [
  {
    doc: 'docs/suite.md',
    section: 'What the suite covers',
    column: 'Spec',
    dir: 'tests/specs',
    selects: (name) => /^[^/]+\.spec\.js$/.test(name),
  },
];

/** Build a synthetic suite document with the given spec names as rows. */
function suiteDoc(names, { column = 'Spec', section = 'What the suite covers' } = {}) {
  return [
    '# A suite',
    '',
    'Prose that names `corpus/elsewhere.spec.js`, which lives outside the directory.',
    '',
    `## ${section}`,
    '',
    `| ${column} | Covers |`,
    '| --- | --- |',
    ...names.map((n) => `| \`${n}\` | what it covers |`),
    '',
  ].join('\n');
}

/** Run the audit over an in-memory { path: content } tree. */
function audit(tree, { files, inventories = INVENTORY, lists = [] } = {}) {
  return auditInventories({
    files: files ?? Object.keys(tree),
    readFile: (f) => (f in tree ? tree[f] : null),
    inventories,
    lists,
  });
}

describe('auditInventories — suite tables vs the suite directory', () => {
  it('reports nothing when the table names exactly the files in the directory', () => {
    const result = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js', 'b.spec.js']) },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js', 'tests/specs/b.spec.js'] },
    );
    assert.deepEqual(result.undocumented, []);
    assert.deepEqual(result.absent, []);
    assert.deepEqual(formatProblems(result), []);
  });

  it('flags a test file the document does not list (missing from the doc)', () => {
    const result = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js']) },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js', 'tests/specs/new.spec.js'] },
    );
    assert.deepEqual(result.undocumented, [
      'tests/specs/new.spec.js is in the suite but has no row in docs/suite.md',
    ]);
    assert.deepEqual(result.absent, []);
  });

  it('flags a documented file that is no longer a member (gone from the suite)', () => {
    const result = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js', 'renamed.spec.js']) },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js'] },
    );
    assert.deepEqual(result.absent, [
      'docs/suite.md lists `renamed.spec.js`, which is not a member of the suite in tests/specs/',
    ]);
    assert.deepEqual(result.undocumented, []);
  });

  it('flags a documented file that is still tracked but outside the suite', () => {
    // The row is red because the file is no longer a member, not because it is
    // gone — a spec moved out of the directory, or (for a suite whose rule reads
    // only the top level) down into a subdirectory of it.
    const result = audit(
      { 'docs/suite.md': suiteDoc(['moved.spec.js']) },
      { files: ['docs/suite.md', 'tests/elsewhere/moved.spec.js'] },
    );
    assert.deepEqual(result.absent, [
      'docs/suite.md lists `moved.spec.js`, which is not a member of the suite in tests/specs/',
    ]);
  });

  it('reports both directions of a rename at once', () => {
    const result = audit(
      { 'docs/suite.md': suiteDoc(['old.spec.js']) },
      { files: ['docs/suite.md', 'tests/specs/new.spec.js'] },
    );
    assert.equal(result.undocumented.length, 1);
    assert.equal(result.absent.length, 1);
    assert.match(result.undocumented[0], /new\.spec\.js/);
    assert.match(result.absent[0], /old\.spec\.js/);
  });

  it('flags a file listed by two rows', () => {
    const result = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js', 'a.spec.js']) },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js'] },
    );
    assert.deepEqual(result.duplicated, ['docs/suite.md: `a.spec.js` has more than one row']);
  });

  it('counts exactly the members its registered rule selects', () => {
    // A helper the rule does not select is not a suite member; nor is a file one
    // level deeper, for a rule that reads only the top level.
    const result = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js']) },
      {
        files: [
          'docs/suite.md',
          'tests/specs/a.spec.js',
          'tests/specs/fixture.js',
          'tests/specs/nested/deep.spec.js',
        ],
      },
    );
    assert.deepEqual(result.undocumented, []);
    assert.deepEqual(result.absent, []);
  });

  it('counts a nested test where the rule admits it, named by its path', () => {
    const files = ['docs/suite.md', 'tests/specs/a.spec.js', 'tests/specs/nested/deep.spec.js'];
    const recursive = [{ ...INVENTORY[0], selects: (name) => name.endsWith('.spec.js') }];
    const missing = audit({ 'docs/suite.md': suiteDoc(['a.spec.js']) }, { files, inventories: recursive }); // prettier-ignore
    assert.deepEqual(missing.undocumented, [
      'tests/specs/nested/deep.spec.js is in the suite but has no row in docs/suite.md',
    ]);
    const listed = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js', 'nested/deep.spec.js']) },
      { files, inventories: recursive },
    );
    assert.deepEqual(listed.undocumented, []);
    assert.deepEqual(listed.absent, []);
  });

  it('reads only tables whose first column carries the documented header', () => {
    const doc = suiteDoc(['a.spec.js']).replace(
      '| Spec | Covers |',
      ['| Other | Covers |', '| --- | --- |', '| `not-a-spec.js` | a different table |', '', '| Spec | Covers |'].join('\n'), // prettier-ignore
    );
    const result = audit(
      { 'docs/suite.md': doc },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js'] },
    );
    assert.deepEqual(result.absent, []);
    assert.deepEqual(result.unparsed, []);
  });

  it('reads only tables in the documented section', () => {
    // A same-shaped table under a different heading documents something else —
    // here, a producer that lives outside the suite directory.
    const doc = [
      suiteDoc(['a.spec.js']),
      '## Runs sharing this tree',
      '',
      '| Spec | Covers |',
      '| --- | --- |',
      '| `corpus.spec.js` | a producer outside the suite directory |',
      '',
    ].join('\n');
    const result = audit(
      { 'docs/suite.md': doc },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js'] },
    );
    assert.deepEqual(result.absent, []);
    assert.deepEqual(result.undocumented, []);
  });

  it('unions every inventory table in the documented section', () => {
    const doc = [
      suiteDoc(['a.spec.js']),
      '### A subsection of the same section',
      '',
      '| Spec | Covers |',
      '| --- | --- |',
      '| `b.spec.js` | still the same section |',
      '',
    ].join('\n');
    const result = audit(
      { 'docs/suite.md': doc },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js', 'tests/specs/b.spec.js'] },
    );
    assert.deepEqual(result.undocumented, []);
    assert.deepEqual(result.absent, []);
  });
});

describe('auditInventories — the extraction fails loudly', () => {
  it('flags an inventory document it cannot read', () => {
    const result = audit({}, { files: ['tests/specs/a.spec.js'] });
    assert.deepEqual(result.unreadable, ['docs/suite.md: inventory document could not be read']);
  });

  it('flags a document whose inventory table it cannot find (renamed column)', () => {
    const result = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js'], { column: 'Test file' }) },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js'] },
    );
    assert.equal(result.unparsed.length, 1);
    assert.match(result.unparsed[0], /no inventory table found/);
    // And it does NOT silently report the suite as undocumented.
    assert.deepEqual(result.undocumented, []);
  });

  it('flags a document whose inventory section was renamed', () => {
    const result = audit(
      { 'docs/suite.md': suiteDoc(['a.spec.js'], { section: 'Coverage' }) },
      { files: ['docs/suite.md', 'tests/specs/a.spec.js'] },
    );
    assert.equal(result.unparsed.length, 1);
    assert.match(result.unparsed[0], /"## What the suite covers"/);
    assert.deepEqual(result.undocumented, []);
  });

  it('flags a row whose first cell is not a bare backticked file name', () => {
    const doc = ['## What the suite covers', '', '| Spec | Covers |', '| --- | --- |', '| the smoke spec | prose |', ''].join('\n'); // prettier-ignore
    const result = audit({ 'docs/suite.md': doc }, { files: ['docs/suite.md'] });
    assert.equal(result.unparsed.length, 1);
    assert.match(result.unparsed[0], /not a single backticked file name/);
  });
});

describe('formatProblems — the red report', () => {
  it('formats every populated problem class the audit reports', () => {
    // Driven from the audit's own result shape: every class it can populate
    // must reach the report, so a class added later cannot be silently dropped
    // by a report that formats a hand-kept list instead.
    const shape = auditInventories({ files: [], readFile: () => null, inventories: [], lists: [] });
    const populated = Object.fromEntries(Object.keys(shape).map((k) => [k, [`a ${k} problem`]]));
    const blocks = formatProblems(populated);
    assert.equal(blocks.length, Object.keys(shape).length);
    assert.ok(blocks.every((b) => b.startsWith('✗') && b.includes('Fix:')));
    for (const key of Object.keys(shape)) {
      assert.ok(
        blocks.some((b) => b.includes(`a ${key} problem`)),
        `the ${key} class reaches the report`,
      );
    }
  });

  it('reports a problem class it has no wording for rather than dropping it', () => {
    const blocks = formatProblems({ somethingNew: ['an unworded problem'] });
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /somethingNew/);
    assert.match(blocks[0], /an unworded problem/);
  });
});

describe('auditInventories — the coverage lists', () => {
  const LISTS = [
    { file: 'tests/coverage-fixture.js', name: 'TRACKED_FILES', root: 'src' },
    {
      file: 'tests/teardown.js',
      name: 'TRACKED_FILES',
      root: 'pkg',
      pathField: 'src',
      matchField: 'match',
    },
  ];

  it('reports nothing when every entry identifies a tracked file', () => {
    const result = audit(
      {
        'tests/coverage-fixture.js': "const TRACKED_FILES = ['panel.js'];",
        'tests/teardown.js': "const TRACKED_FILES = [{ match: 'a/panel.js', src: 'a/panel.js' }];",
      },
      { files: ['src/panel.js', 'pkg/a/panel.js'], inventories: [], lists: LISTS },
    );
    assert.deepEqual(result.missingSource, []);
    assert.deepEqual(result.splitEntry, []);
  });

  it('flags an entry naming a file that is not tracked', () => {
    const result = audit(
      {
        'tests/coverage-fixture.js': "const TRACKED_FILES = ['panel.js', 'gone.js'];",
        'tests/teardown.js': "const TRACKED_FILES = [{ match: 'a/x.js', src: 'a/x.js' }];",
      },
      { files: ['src/panel.js'], inventories: [], lists: LISTS },
    );
    assert.deepEqual(result.missingSource, [
      'tests/coverage-fixture.js: `TRACKED_FILES` entry "gone.js" names src/gone.js, which is not a tracked file',
      'tests/teardown.js: `TRACKED_FILES` entry "a/x.js" names pkg/a/x.js, which is not a tracked file',
    ]);
  });

  it('flags an entry whose URL match and source path name different files', () => {
    // The rename-half-done case: `src` was repointed, the URL the suite matches
    // on was left behind — the entry looks well-formed and collects nothing.
    const result = audit(
      {
        'tests/teardown.js': "const TRACKED_FILES = [{ match: 'a/old.js', src: 'a/new.js' }];",
      },
      { files: ['pkg/a/new.js'], inventories: [], lists: [LISTS[1]] },
    );
    assert.deepEqual(result.missingSource, []);
    assert.deepEqual(result.splitEntry, [
      'tests/teardown.js: `TRACKED_FILES` entry matches URLs ending "/a/old.js" but reports coverage against "a/new.js" — one entry, two files',
    ]);
  });

  it('flags a list source it cannot read (the list relocated)', () => {
    const result = audit({}, { files: [], inventories: [], lists: [LISTS[0]] });
    assert.deepEqual(result.unreadable, [
      'tests/coverage-fixture.js: coverage list source could not be read',
    ]);
  });

  it('flags a list whose declaration it cannot find (the list renamed)', () => {
    const result = audit(
      { 'tests/coverage-fixture.js': "const COVERED = ['panel.js'];" },
      { files: ['src/panel.js'], inventories: [], lists: [LISTS[0]] },
    );
    assert.equal(result.unparsed.length, 1);
    assert.match(result.unparsed[0], /no `TRACKED_FILES = \[\.\.\.\]` array literal found/);
    assert.deepEqual(result.missingSource, []);
  });
});

describe('parseTables / splitRow / backtickedName', () => {
  it('parses a table into its section, header and rows', () => {
    const [table] = parseTables('## Covers\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n');
    assert.equal(table.section, 'Covers');
    assert.deepEqual(table.header, ['A', 'B']);
    assert.deepEqual(table.rows, [
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps a deeper heading inside its section and resets on a top-level one', () => {
    const md = [
      '## One',
      '### Deeper',
      '| A |',
      '| --- |',
      '| 1 |',
      '',
      '# Top',
      '| B |',
      '| --- |',
      '| 2 |',
    ].join('\n');
    const [first, second] = parseTables(md);
    assert.equal(first.section, 'One');
    assert.equal(second.section, null);
  });

  it('does NOT read a table inside a fenced code block', () => {
    const md = ['```markdown', '| Spec | Covers |', '| --- | --- |', '| `x.spec.js` | e |', '```', ''].join('\n'); // prettier-ignore
    assert.deepEqual(parseTables(md), []);
  });

  it('resumes parsing after a fence closes', () => {
    const md = ['```', 'not a table', '```', '', '| A |', '| --- |', '| 1 |'].join('\n');
    assert.equal(parseTables(md).length, 1);
  });

  it('ignores a pipe line that is not followed by a delimiter row', () => {
    assert.deepEqual(parseTables('| just | pipes |\nplain prose\n'), []);
  });

  it('keeps an escaped pipe inside a cell', () => {
    assert.deepEqual(splitRow('| a \\| b | c |'), ['a \\| b', 'c']);
  });

  it('accepts aligned delimiter rows', () => {
    const [table] = parseTables('| A | B |\n| :-- | --: |\n| 1 | 2 |\n');
    assert.deepEqual(table.header, ['A', 'B']);
  });

  it('reads a file name only from a cell that is exactly one backticked token', () => {
    assert.equal(backtickedName('`smoke.spec.js`'), 'smoke.spec.js');
    assert.equal(backtickedName('  `smoke.spec.js`  '), 'smoke.spec.js');
    assert.equal(backtickedName('the `smoke.spec.js` spec'), null);
    assert.equal(backtickedName('smoke.spec.js'), null);
    assert.equal(backtickedName(undefined), null);
  });
});

describe('tokenizeJs / readListEntries', () => {
  it('drops comments and whitespace, keeping words, strings and punctuation', () => {
    const tokens = tokenizeJs("// gone\nconst A = ['x']; /* also gone */");
    assert.deepEqual(tokens, [
      { type: 'word', value: 'const' },
      { type: 'word', value: 'A' },
      { type: 'punct', value: '=' },
      { type: 'punct', value: '[' },
      { type: 'string', value: 'x' },
      { type: 'punct', value: ']' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('reads string entries regardless of formatting', () => {
    const oneLine = readListEntries("const T = ['a.js', 'b.js'];", 'T');
    const multiLine = readListEntries("const T = [\n  'a.js', // first\n  'b.js',\n];\n", 'T');
    assert.deepEqual(oneLine, { entries: ['a.js', 'b.js'] });
    assert.deepEqual(multiLine, { entries: ['a.js', 'b.js'] });
  });

  it('reads the named fields of object entries as records', () => {
    const source =
      "const T = [{ match: 'x/a.js', src: 'a.js' }, { match: 'x/b.js', src: 'b.js' }];";
    assert.deepEqual(readListEntries(source, 'T', ['src', 'match']), {
      entries: [
        { match: 'x/a.js', src: 'a.js' },
        { match: 'x/b.js', src: 'b.js' },
      ],
    });
  });

  it('reads a record property only at that record’s own level', () => {
    const source = "const T = [{ src: 'a.js', meta: { src: 'DEEP.js' } }];";
    assert.deepEqual(readListEntries(source, 'T', ['src']), { entries: [{ src: 'a.js' }] });
  });

  it('is not fooled by the name inside a comment or a string', () => {
    const source = ["// T = ['decoy.js']", "const label = \"T = ['decoy.js']\";", "const T = ['real.js'];"].join('\n'); // prettier-ignore
    assert.deepEqual(readListEntries(source, 'T'), { entries: ['real.js'] });
  });

  it('errors when the declaration is absent', () => {
    assert.deepEqual(readListEntries('const OTHER = [];', 'T'), {
      error: 'no `T = [...]` array literal found',
    });
  });

  it('errors when the literal never closes', () => {
    assert.deepEqual(readListEntries("const T = ['a.js',", 'T'), {
      error: 'the `T` array literal is never closed',
    });
  });

  it('errors on an empty result rather than passing vacuously', () => {
    assert.deepEqual(readListEntries('const T = [];', 'T'), {
      error: 'the `T` array literal holds no entries',
    });
  });

  it('errors when a record is missing a requested property', () => {
    assert.deepEqual(readListEntries("const T = [{ match: 'x' }];", 'T', ['src']), {
      error: 'an entry of `T` has no `src` property',
    });
  });

  it('refuses an element form it does not model rather than reading the rest', () => {
    // A spread, a nested array, and a bare identifier each hide entries from a
    // reader that only understands literals — each must be red, not partial.
    for (const source of [
      "const MORE = ['c.js'];\nconst T = ['a.js', ...MORE];",
      "const T = [['a.js'], 'b.js'];",
      "const T = ['a.js', OTHER];",
    ]) {
      const read = readListEntries(source, 'T');
      assert.ok(read.error, `expected an error for: ${source}`);
      assert.match(read.error, /does not model/);
    }
    // Same for an object element in a plain list, and a nested array in a
    // record list.
    assert.match(
      readListEntries("const T = ['a.js', { note: 'x' }];", 'T').error,
      /does not model/,
    );
    assert.match(readListEntries("const T = [['x']];", 'T', ['src']).error, /does not model/);
  });

  it('refuses a literal embedded in a larger expression', () => {
    const read = readListEntries("const T = ['a.js'].concat(EXTRA);", 'T');
    assert.deepEqual(read, {
      error:
        'the `T` array literal is part of a larger expression, which this reader does not model',
    });
  });
});

describe('identifiesSameFile', () => {
  it("accepts a match the converted file's own URL would end with", () => {
    assert.equal(identifiesSameFile('a/panel.js', 'a/panel.js'), true);
    assert.equal(identifiesSameFile('panel.js', 'sidepanel/panel.js'), true);
  });

  it('rejects a match longer than the path it converts — no URL can satisfy it', () => {
    // The suite matches URLs ending in `/<match>` and converts `<path>`, whose
    // own URL is `<origin>/<path>`; a longer match names a file it never sees.
    assert.equal(identifiesSameFile('served/a/panel.js', 'a/panel.js'), false);
  });

  it('rejects different files, including a partial-segment near-match', () => {
    assert.equal(identifiesSameFile('a/old.js', 'a/new.js'), false);
    assert.equal(identifiesSameFile('panel.js', 'sidepanel-panel.js'), false);
  });
});

describe('real-tree lock', () => {
  it('the committed inventories and coverage lists hold', () => {
    const readFile = (f) => {
      try {
        return readFileSync(resolve(ROOT, f), 'utf8');
      } catch {
        return null;
      }
    };
    assert.deepEqual(
      formatProblems(auditInventories({ files: trackedFiles(), readFile })),
      [],
      'scripts/check-test-inventory.js must pass on the committed tree',
    );
  });

  it('every configured document, suite, and coverage list is in the tree', () => {
    const files = trackedFiles();
    const tracked = new Set(files);
    for (const { doc, dir, selects } of DOC_INVENTORIES) {
      assert.ok(tracked.has(doc), `${doc} is tracked`);
      assert.ok(
        files.some((f) => f.startsWith(`${dir}/`) && selects(f.slice(dir.length + 1))),
        `${dir} holds tracked test files`,
      );
    }
    for (const { file } of TRACKED_LISTS) assert.ok(tracked.has(file), `${file} is tracked`);
  });

  it('each membership rule matches the discovery it mirrors', () => {
    // The rules mirror the discovery that actually selects each suite's tests,
    // so they are pinned against it: a rule that drifts lets a file that gets
    // picked up sit with no row, and the check would stay green on the drift it
    // exists to catch.
    const selectsFor = (dir) => DOC_INVENTORIES.find((inv) => inv.dir === dir).selects;

    // Playwright's default testMatch, at any depth under its testDir.
    for (const dir of [
      'packages/extension/tests/e2e/specs',
      'packages/desktop/tests/integration',
    ]) {
      const selects = selectsFor(dir);
      for (const name of ['a.spec.js', 'a.test.js', 'a.spec.mjs', 'a.test.ts', 'deep/a.spec.js']) {
        assert.equal(selects(name), true, `${dir} selects ${name}`);
      }
      for (const name of ['helpers.js', 'playwright.config.js', 'package.json', 'fixture.mjs']) {
        assert.equal(selects(name), false, `${dir} does not select ${name}`);
      }
    }

    // The desktop crate: one binary per tests/*.rs, which is what CI's
    // layer-discovery step globs. Cargo would also build tests/<name>/main.rs,
    // but that step never sees it, so it is not part of the documented suite.
    const cargo = selectsFor('packages/desktop/src-tauri/tests');
    assert.equal(cargo('worker_pool_test.rs'), true);
    assert.equal(cargo('nested/main.rs'), false);
    assert.equal(cargo('common/mod.rs'), false);
    assert.equal(cargo('worker_pool_test.proptest-regressions'), false);
  });
});
