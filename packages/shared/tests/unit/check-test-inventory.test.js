/**
 * check-test-inventory.test.js — Unit tests for the test-inventory lint
 * (scripts/check-test-inventory.js) that gates CI. The suite documents' tables,
 * the hand-maintained coverage lists, and the registered suites' own
 * registration are committed data, so every way they can rot must fail loud:
 * these tests drive each red path over synthetic documents, synthetic sources,
 * and synthetic manifests — an undocumented test file, a row naming a file that
 * is not a member of the suite, a duplicate row, a coverage entry pointing at
 * nothing, an entry whose two halves name different files, a globbed suite no
 * entry registers, an entry whose descriptor no longer states what selects it,
 * an entry nothing runs, a mirrored discovery claim that no longer matches the
 * surface it mirrors, and each way any of the extractions can fail to reach its
 * whole subject. Table parsing is proven to read only the documented section
 * and to ignore prose and fenced blocks (the reason the check reads rows, not
 * text), and the array scan survives reformatting while refusing a restructured
 * literal — including a requested property whose value is an expression, which
 * it once recorded as that expression's leading string — rather than reading
 * part of it. The report is proven to carry every class either audit can raise,
 * including one it has no wording for yet. Real-tree locks prove the shipped
 * inventories hold, that the shipped registration closes, and that each suite's
 * membership rule still matches the discovery it mirrors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DOC_INVENTORIES,
  RUNNERS,
  TRACKED_LISTS,
  admittedManifests,
  auditInventories,
  auditRegistrationClosure,
  backtickedName,
  basenameGlobToRegExp,
  classifyArgument,
  configValues,
  extractClauseSection,
  extractLoopGlobs,
  extractStepBody,
  formatProblems,
  identifiesSameFile,
  nodeTestArguments,
  normalizePath,
  parseTables,
  readListEntries,
  registered,
  selectsFor,
  splitRow,
  stripFences,
  tokenizeJs,
} from '../../../../scripts/check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** All tracked repo-relative paths, for the real-tree locks. */
const trackedFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/** The real-tree locks' reader: a repo-relative path's content, null when unreadable. */
const readRepoFile = (f) => {
  try {
    return readFileSync(resolve(ROOT, f), 'utf8');
  } catch {
    return null;
  }
};

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

  it('passes a descriptor-less entry by instead of dying on the rule it has not got', () => {
    // The CLI runs both audits over the same registered list, so this one has to
    // reach the closure that names the refusal — reading the entry here would
    // throw on the `selects` a descriptor-less entry never derived, and the gate
    // would die on a TypeError instead of printing its documented red.
    const bare = registered({
      doc: 'docs/suite.md',
      section: 'What the suite covers',
      column: 'Spec',
      dir: 'tests/specs',
    });
    const result = auditInventories({
      files: ['docs/suite.md', 'tests/specs/a.spec.js'],
      readFile: () => suiteDoc(['a.spec.js']),
      inventories: [bare],
      lists: [],
    });
    assert.deepEqual(formatProblems(result), []);
    // …and the CLI's other audit is where the entry is named.
    const closed = auditRegistrationClosure({
      files: ['package.json'],
      readFile: () => JSON.stringify({ scripts: { lint: 'echo ok' } }),
      inventories: [bare],
    });
    assert.match(closed.undescribed[0], /no discovery descriptor/);
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

  it('formats every populated problem class the registration closure reports', () => {
    // Same driving rule for the second audit: its result shape is the list of
    // classes, so a class it grows cannot be dropped by a report formatting a
    // hand-kept list instead.
    const shape = auditRegistrationClosure({ files: [], readFile: () => null, inventories: [] });
    const populated = Object.fromEntries(Object.keys(shape).map((k) => [k, [`a ${k} problem`]]));
    const blocks = formatProblems(populated);
    assert.equal(blocks.length, Object.keys(shape).length);
    for (const key of Object.keys(shape)) {
      assert.ok(
        blocks.some((b) => b.includes(`a ${key} problem`) && b.includes('Fix:')),
        `the ${key} class reaches the report with its wording`,
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

  it('refuses a requested property whose value is an expression, naming the property and the token', () => {
    // The value is the whole value. Before this rule the object path recorded
    // `'a'` here and reported success, so an entry assembled from a constant
    // (or any other expression) read as its leading string — silently, which
    // contradicts the fail-loud totality the reader states. The plain-list path
    // always refused the same shape; the two now agree.
    const read = readListEntries("const T = [{ src: 'a' + '.js', match: 'a.js' }];", 'T', [
      'src',
      'match',
    ]);
    assert.deepEqual(read, {
      error:
        "the `T` array literal's `src` property is followed by `+`, so its value is not the string this reader read",
    });
  });

  it('names the end of the source when a requested property runs off it', () => {
    const read = readListEntries("const T = [{ src: 'a.js'", 'T', ['src']);
    assert.match(read.error, /followed by `end of source`/);
  });

  it('refuses the same shape in a plain list (the companion path)', () => {
    const read = readListEntries("const T = ['a' + '.js'];", 'T');
    assert.match(read.error, /does not model/);
  });

  it('leaves a property nobody requested to whatever shape it likes', () => {
    // The totality is scoped to the requested properties: an unrequested one is
    // never read, so its shape is not this reader's business.
    assert.deepEqual(readListEntries("const T = [{ src: 'a.js', note: 'x' + 'y' }];", 'T', ['src']), {
      entries: [{ src: 'a.js' }],
    }); // prettier-ignore
  });

  it('reads both shipped coverage lists as they stand (the real-tree parse)', () => {
    // The rule above is a refusal, so the lists it runs over are pinned here:
    // both parse, in the shape their registration asks for.
    for (const { file, name, pathField = null, matchField = null } of TRACKED_LISTS) {
      const fields = pathField === null ? null : [pathField, ...(matchField ? [matchField] : [])];
      const read = readListEntries(readFileSync(resolve(ROOT, file), 'utf8'), name, fields);
      assert.ok(!read.error, `${file}: ${read.error ?? ''}`);
      assert.ok(read.entries.length > 0, `${file} holds entries`);
    }
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

describe('discovery descriptors — one statement, two readers', () => {
  it('turns a basename glob into a pattern that never crosses a directory', () => {
    const re = basenameGlobToRegExp('*.test.js');
    assert.equal(re.test('a.test.js'), true);
    assert.equal(re.test('nested/a.test.js'), false);
    assert.equal(re.test('a.test.js.bak'), false);
    assert.equal(basenameGlobToRegExp('*.rs').test('worker_pool_test.rs'), true);
  });

  it('derives a node-test rule from the descriptor pattern, top level only', () => {
    const selects = selectsFor({ runner: RUNNERS.node, pattern: '*.test.js' });
    assert.equal(selects('session.test.js'), true);
    assert.equal(selects('helper.js'), false);
    assert.equal(selects('nested/session.test.js'), false);
  });

  it('derives the cargo rule from the workflow glob its descriptor names', () => {
    const selects = selectsFor({ runner: RUNNERS.cargo, glob: 'tests/*.rs' });
    assert.equal(selects('worker_pool_test.rs'), true);
    assert.equal(selects('nested/main.rs'), false);
  });

  it('derives the Playwright rule from its default selection, at any depth', () => {
    const selects = selectsFor({ runner: RUNNERS.playwright, workdir: 'pkg/tests/e2e' });
    assert.equal(selects('a.spec.js'), true);
    assert.equal(selects('deep/a.test.ts'), true);
    assert.equal(selects('playwright.config.js'), false);
  });

  it('every shipped entry carries a descriptor and derives its rule from it', () => {
    for (const entry of DOC_INVENTORIES) {
      assert.ok(entry.discovery, `${entry.doc} ("## ${entry.section}") states a descriptor`);
      assert.equal(typeof entry.selects, 'function');
      assert.ok(
        Object.hasOwn(entry, 'selects'),
        'selects stays an own property, so a spread keeps it',
      );
    }
  });

  it('normalizes a joined path to the form the tracked list spells', () => {
    assert.equal(normalizePath('pkg/tests/e2e/./specs'), 'pkg/tests/e2e/specs');
    assert.equal(normalizePath('pkg/tests/integration/.'), 'pkg/tests/integration');
    assert.equal(normalizePath('pkg/a/../b'), 'pkg/b');
  });
});

/** The node-test suite the closure fixtures register. */
const NODE_ENTRY = registered({
  doc: 'docs/suite.md',
  section: 'What the suite covers',
  column: 'Test file',
  dir: 'packages/thing/tests/unit',
  discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
});

/** The cargo suite the mirror fixtures register. */
const CARGO_ENTRY = registered({
  doc: 'docs/rust.md',
  section: 'Suite layout',
  column: 'Test file',
  dir: 'crate/tests',
  discovery: {
    runner: RUNNERS.cargo,
    workflow: '.github/workflows/test.yml',
    step: 'Discover Rust test layers',
    glob: 'tests/*.rs',
  },
});

/** The browser-driven suite the mirror fixtures register. */
const PLAYWRIGHT_ENTRY = registered({
  doc: 'docs/browser.md',
  section: 'What the suite covers',
  column: 'Spec',
  dir: 'pkg/tests/e2e/specs',
  discovery: { runner: RUNNERS.playwright, workdir: 'pkg/tests/e2e' },
});

/** A workflow whose discovery step iterates over one glob, followed by another step. */
const WORKFLOW_TEXT = [
  '      - name: Discover Rust test layers',
  '        run: |',
  '          for path in tests/*.rs; do',
  '            echo "$path"',
  '          done',
  '      - name: Next step',
  '        run: echo done',
].join('\n');

/** A synthetic tree whose root manifest states `scripts`, plus anything else it needs. */
const manifestTree = (scripts, extra = {}) => ({
  'package.json': JSON.stringify({ scripts }),
  ...extra,
});

/** Run the registration closure over an in-memory { path: content } tree. */
function closure(tree, { inventories = [NODE_ENTRY], files } = {}) {
  return auditRegistrationClosure({
    files: files ?? Object.keys(tree),
    readFile: (f) => (f in tree ? tree[f] : null),
    inventories,
  });
}

describe('the registration closure — reading the invocations', () => {
  it('collects every node-test argument, dropping flags and crossing separators', () => {
    assert.deepEqual(nodeTestArguments('node --test a/*.test.js b/*.test.js'), {
      args: ['a/*.test.js', 'b/*.test.js'],
    });
    assert.deepEqual(nodeTestArguments('c8 --reporter=lcov node --test a/*.test.js'), {
      args: ['a/*.test.js'],
    });
    assert.deepEqual(nodeTestArguments('npm run produce && node --test a/one.test.js'), {
      args: ['a/one.test.js'],
    });
    // The runtime's own flags sit between `node` and `--test`: a flag carrying
    // its value in the same token is skipped, so the invocation is read through
    // it rather than passed over as no invocation at all. A flag whose value is
    // a separate token is the refusal below — this reader cannot tell that value
    // from the start of the arguments.
    assert.deepEqual(nodeTestArguments('node --experimental-strip-types --test a/*.test.js'), {
      args: ['a/*.test.js'],
    });
  });

  it('refuses a runtime flag whose value is a separate token, naming that token', () => {
    // The scan stops on `./r.js`; `--test` still stands in the same segment, so
    // the invocation is real and unreadable — silently dropping it would leave a
    // run suite unregistered while this check stayed green.
    const read = nodeTestArguments('node --import ./r.js --test a/*.test.js');
    assert.match(read.error, /`\.\/r\.js`/);
    assert.match(read.error, /does not model/);
    // A `node` that never reaches the runner in its own segment is still no
    // invocation, not a refusal.
    assert.deepEqual(nodeTestArguments('node scripts/build.js && echo done'), { args: [] });
  });

  it('refuses a flag after `--test`, naming it', () => {
    // A flag whose value is a separate token would leave that token collected as
    // a suite argument, so the whole form is refused instead of misread.
    const read = nodeTestArguments('node --test --test-reporter spec a/*.test.js');
    assert.match(read.error, /`--test-reporter`/);
    assert.match(read.error, /does not model/);
    assert.match(nodeTestArguments('node --test a/*.test.js --watch').error, /`--watch`/);
  });

  it('finds nothing in a command that never reaches the runner', () => {
    assert.deepEqual(nodeTestArguments('cd pkg && npx playwright test --config other.js'), {
      args: [],
    });
  });

  it('refuses an invocation reached after a `cd`, which moves the rest of the command', () => {
    for (const command of [
      'cd pkg && node --test tests/*.test.js',
      'npm run sync && cd pkg && node --test tests/*.test.js',
    ]) {
      assert.match(nodeTestArguments(command).error, /`cd`/, command);
    }
  });

  it('refuses an invocation that states no suite', () => {
    assert.match(nodeTestArguments('node --test').error, /no argument/);
    assert.match(nodeTestArguments('node --test && echo done').error, /no argument/);
  });

  it('classifies a resolved argument as a glob over a directory or a member of one', () => {
    assert.deepEqual(classifyArgument('pkg/tests/unit/*.test.js'), {
      kind: 'glob',
      dir: 'pkg/tests/unit',
      pattern: '*.test.js',
    });
    assert.deepEqual(classifyArgument('pkg/tests/unit/one.test.js'), {
      kind: 'literal',
      dir: 'pkg/tests/unit',
      name: 'one.test.js',
    });
    assert.match(classifyArgument('pkg/**/unit/one.test.js').error, /across directories/);
  });

  it('admits the root manifest and every manifest under packages/, and nothing else', () => {
    assert.deepEqual(
      admittedManifests([
        'package.json',
        'packages/extension/package.json',
        'packages/extension/tests/e2e/package.json',
        'reference-implementations/sync-server/package.json',
        'docs/README.md',
      ]),
      ['package.json', 'packages/extension/package.json', 'packages/extension/tests/e2e/package.json'], // prettier-ignore
    );
  });

  it('slices a workflow step and reads the globs its loops discover through', () => {
    const workflow = WORKFLOW_TEXT;
    const body = extractStepBody(workflow, 'Discover Rust test layers');
    assert.ok(body.includes('for path in tests/*.rs; do'));
    assert.ok(!body.includes('Next step'), 'the slice stops at the next step');
    assert.deepEqual(extractLoopGlobs(body), ['tests/*.rs']);
    assert.equal(extractStepBody(workflow, 'A step that is not there'), null);
  });

  it('reads a configuration key through the tokenizer, never a commented mention', () => {
    const source = ["// testMatch: 'never'", "export default { testDir: './specs' };"].join('\n');
    assert.deepEqual(configValues(source, 'testMatch'), []);
    assert.deepEqual(configValues(source, 'testDir'), [{ type: 'string', value: './specs' }]);
  });
});

describe('auditRegistrationClosure — the node-test class, both directions', () => {
  it('reports nothing when an admitted script globs exactly the registered suite', () => {
    const result = closure(
      manifestTree({ 'test:thing': 'node --test packages/thing/tests/unit/*.test.js' }),
    );
    assert.deepEqual(formatProblems(result), []);
  });

  it('flags a globbed suite no entry registers, naming the script and the directory', () => {
    const result = closure(
      manifestTree({
        'test:thing': 'node --test packages/thing/tests/unit/*.test.js',
        'test:other': 'node --test packages/other/tests/unit/*.test.js',
      }),
    );
    assert.equal(result.unregisteredSuite.length, 1);
    assert.match(result.unregisteredSuite[0], /`test:other`/);
    assert.match(result.unregisteredSuite[0], /packages\/other\/tests\/unit\//);
  });

  it('accepts a literal member of a registered suite', () => {
    const result = closure(
      manifestTree({
        'test:thing': 'node --test packages/thing/tests/unit/*.test.js',
        vectors: 'node --test packages/thing/tests/unit/one.test.js',
      }),
    );
    assert.deepEqual(result.unregisteredMember, []);
    assert.deepEqual(formatProblems(result), []);
  });

  it('flags a literal argument whose directory no entry registers', () => {
    const result = closure(
      manifestTree({
        'test:thing': 'node --test packages/thing/tests/unit/*.test.js',
        vectors: 'node --test packages/elsewhere/one.test.js',
      }),
    );
    assert.equal(result.unregisteredMember.length, 1);
    assert.match(result.unregisteredMember[0], /whose directory is packages\/elsewhere\//);
    assert.match(result.unregisteredMember[0], /no entry registers it/);
  });

  it('flags a directory two entries register, naming both — one directory takes one entry', () => {
    // Which entry states the rule the argument is read against would otherwise
    // be an accident of order, so the ambiguity is the red.
    const twin = registered({
      ...NODE_ENTRY,
      doc: 'docs/twin.md',
      discovery: NODE_ENTRY.discovery,
    });
    const result = closure(
      manifestTree({ 'test:thing': 'node --test packages/thing/tests/unit/*.test.js' }),
      { inventories: [NODE_ENTRY, twin] },
    );
    assert.equal(result.unregisteredSuite.length, 1);
    assert.match(result.unregisteredSuite[0], /docs\/suite\.md .* and docs\/twin\.md .* both register it/); // prettier-ignore
  });

  it('flags a literal argument the registered suite does not select', () => {
    const result = closure(
      manifestTree({
        'test:thing': 'node --test packages/thing/tests/unit/*.test.js',
        vectors: 'node --test packages/thing/tests/unit/helper.js',
      }),
    );
    assert.equal(result.unregisteredMember.length, 1);
    assert.match(result.unregisteredMember[0], /does not select/);
  });

  it('reds a registered suite whose glob nothing runs — a literal member keeps it dead', () => {
    // The one liveness rule, asserted in exactly that direction: liveness comes
    // from the glob and from nothing else, because a suite nothing globs is a
    // suite nothing runs. The member invocation below is admitted on its own
    // terms and still leaves the registration dead.
    const result = closure(
      manifestTree({ vectors: 'node --test packages/thing/tests/unit/one.test.js' }),
    );
    assert.deepEqual(result.unregisteredMember, []);
    assert.equal(result.deadRegistration.length, 1);
    assert.match(result.deadRegistration[0], /packages\/thing\/tests\/unit\//);
    assert.match(result.deadRegistration[0], /`\*\.test\.js` no admitted manifest script runs/);
  });

  it('flags a descriptor that no longer states the glob selecting the suite', () => {
    const result = closure(
      manifestTree({ 'test:thing': 'node --test packages/thing/tests/unit/*.spec.js' }),
    );
    assert.equal(result.patternMismatch.length, 1);
    assert.match(result.patternMismatch[0], /`\*\.spec\.js`/);
    assert.match(result.patternMismatch[0], /registers `\*\.test\.js`/);
    // The suite IS run, so the drift is reported once — as the descriptor's.
    assert.deepEqual(result.deadRegistration, []);
  });

  it('refuses a registered entry that states no descriptor, by name', () => {
    // Built through the shipped wrapper, which is where a descriptor-less entry
    // would otherwise fail: with no descriptor it derives no rule, so the entry
    // reaches this refusal instead of throwing before any audit runs.
    const bare = registered({
      doc: NODE_ENTRY.doc,
      section: NODE_ENTRY.section,
      column: NODE_ENTRY.column,
      dir: NODE_ENTRY.dir,
    });
    assert.equal(Object.hasOwn(bare, 'selects'), false, 'no descriptor, no derived rule');
    const result = closure(manifestTree({ lint: 'echo ok' }), { inventories: [bare] });
    assert.equal(result.undescribed.length, 1);
    assert.match(result.undescribed[0], /docs\/suite\.md \("## What the suite covers"\)/);
    assert.match(result.undescribed[0], /no discovery descriptor/);
    // …and the entry is read no further, rather than half-read.
    assert.deepEqual(result.deadRegistration, []);
  });

  it('leaves a manifest outside the admitted set outside the closure', () => {
    // The reference sync server runs its own node-test suites from its own
    // manifest. The admission rule does not admit it, so those suites are not
    // this gate's to register — the closure is silent about them.
    const tree = {
      ...manifestTree({ 'test:thing': 'node --test packages/thing/tests/unit/*.test.js' }),
      'reference-implementations/sync-server/package.json': JSON.stringify({
        scripts: { test: 'node --test tests/unit/*.test.js tests/integration/*.test.js' },
      }),
    };
    assert.deepEqual(formatProblems(closure(tree)), []);
  });

  it('resolves each argument against the manifest that carries it', () => {
    // A package manifest's script is written relative to its own directory, so
    // the same text means a different suite depending on where it is stated.
    const tree = {
      'package.json': JSON.stringify({ scripts: { lint: 'echo ok' } }),
      'packages/thing/package.json': JSON.stringify({
        scripts: { test: 'node --test tests/unit/*.test.js' },
      }),
    };
    assert.deepEqual(formatProblems(closure(tree)), []);
  });
});

describe('auditRegistrationClosure — the mirrored discovery claims', () => {
  it('holds the cargo entry to the workflow step that discovers its binaries', () => {
    const tree = manifestTree({ lint: 'echo ok' }, { '.github/workflows/test.yml': WORKFLOW_TEXT });
    assert.deepEqual(formatProblems(closure(tree, { inventories: [CARGO_ENTRY] })), []);
  });

  it('flags a widened discovery glob, naming both sides', () => {
    const widened = WORKFLOW_TEXT.replace('tests/*.rs', 'tests/*.rs tests/*/main.rs');
    const tree = manifestTree({ lint: 'echo ok' }, { '.github/workflows/test.yml': widened });
    const result = closure(tree, { inventories: [CARGO_ENTRY] });
    assert.equal(result.mirrorDrift.length, 1);
    assert.match(result.mirrorDrift[0], /discovers `tests\/\*\.rs tests\/\*\/main\.rs`/);
    assert.match(result.mirrorDrift[0], /registers `tests\/\*\.rs`/);
  });

  it('refuses a discovery step that vanished under its registered name', () => {
    const renamed = WORKFLOW_TEXT.replace('Discover Rust test layers', 'Find the test layers');
    const tree = manifestTree({ lint: 'echo ok' }, { '.github/workflows/test.yml': renamed });
    const result = closure(tree, { inventories: [CARGO_ENTRY] });
    assert.equal(result.unreadableClosure.length, 1);
    assert.match(result.unreadableClosure[0], /no step is named "Discover Rust test layers"/);
    assert.deepEqual(result.mirrorDrift, [], 'a surface that moved is never reported as a drift');
  });

  it('refuses a discovery step that discovers through no loop at all', () => {
    const empty = ['      - name: Discover Rust test layers', '        run: echo nothing'].join(
      '\n',
    );
    const tree = manifestTree({ lint: 'echo ok' }, { '.github/workflows/test.yml': empty });
    assert.match(
      closure(tree, { inventories: [CARGO_ENTRY] }).unreadableClosure[0],
      /iterates over nothing/,
    );
  });

  const browserTree = (config, test = 'npx playwright test') =>
    manifestTree(
      { lint: 'echo ok' },
      {
        'pkg/tests/e2e/package.json': JSON.stringify({ scripts: { test } }),
        'pkg/tests/e2e/playwright.config.js': config,
      },
    );

  it('holds a browser-driven entry to the default configuration its working directory reaches', () => {
    const tree = browserTree("export default { testDir: './specs' };");
    assert.deepEqual(formatProblems(closure(tree, { inventories: [PLAYWRIGHT_ENTRY] })), []);
  });

  it('flags a default configuration that narrows the selection with testMatch', () => {
    const tree = browserTree("export default { testDir: './specs', testMatch: /a/ };");
    const result = closure(tree, { inventories: [PLAYWRIGHT_ENTRY] });
    assert.equal(result.mirrorDrift.length, 1);
    assert.match(result.mirrorDrift[0], /states `testMatch`/);
  });

  it('flags a default configuration whose testDir moved, naming both directories', () => {
    const tree = browserTree("export default { testDir: './elsewhere' };");
    const result = closure(tree, { inventories: [PLAYWRIGHT_ENTRY] });
    assert.equal(result.mirrorDrift.length, 1);
    assert.match(result.mirrorDrift[0], /collects pkg\/tests\/e2e\/elsewhere\//);
    assert.match(result.mirrorDrift[0], /registers pkg\/tests\/e2e\/specs\//);
  });

  it('flags a working directory whose test script now names a configuration', () => {
    // Config identity is derived from the invocation: once the script selects
    // one explicitly, the default configuration is no longer what collects the
    // suite, so the entry's registered directory is read against the wrong file.
    const tree = browserTree(
      "export default { testDir: './specs' };",
      'npx playwright test --config playwright.corpus.config.js',
    );
    const result = closure(tree, { inventories: [PLAYWRIGHT_ENTRY] });
    assert.equal(result.mirrorDrift.length, 1);
    assert.match(result.mirrorDrift[0], /names a configuration explicitly/);
  });

  it('refuses a default configuration it cannot read, or one stating no testDir', () => {
    const missing = manifestTree(
      { lint: 'echo ok' },
      {
        'pkg/tests/e2e/package.json': JSON.stringify({ scripts: { test: 'npx playwright test' } }),
      },
    );
    assert.match(
      closure(missing, { inventories: [PLAYWRIGHT_ENTRY] }).unreadableClosure[0],
      /default configuration could not be read/,
    );
    const noDir = browserTree('export default { timeout: 1000 };');
    assert.match(
      closure(noDir, { inventories: [PLAYWRIGHT_ENTRY] }).unreadableClosure[0],
      /`testDir` value\(s\)/,
    );
  });

  it('refuses a working directory whose test script does not run the runner', () => {
    const tree = browserTree("export default { testDir: './specs' };", 'echo nothing');
    assert.match(
      closure(tree, { inventories: [PLAYWRIGHT_ENTRY] }).unreadableClosure[0],
      /does not run Playwright/,
    );
  });
});

describe('auditRegistrationClosure — every unreadable surface is refused', () => {
  it('refuses a tree that admits no manifest at all', () => {
    const result = auditRegistrationClosure({
      files: [],
      readFile: () => null,
      inventories: [NODE_ENTRY],
    });
    assert.match(result.unreadableClosure[0], /no admitted manifest is tracked/);
  });

  it('refuses an admitted manifest it cannot read', () => {
    const result = closure({}, { files: ['package.json'] });
    assert.match(result.unreadableClosure[0], /could not be read/);
  });

  it('refuses an admitted manifest that is not readable JSON', () => {
    const result = closure({ 'package.json': '{ not json' });
    assert.match(result.unreadableClosure[0], /not readable JSON/);
  });

  it('refuses an admitted manifest that states no scripts map', () => {
    const result = closure({ 'package.json': JSON.stringify({ name: 'thing' }) });
    assert.match(result.unreadableClosure[0], /states no `scripts` map/);
  });

  it('refuses a script that is not a command string', () => {
    const result = closure({ 'package.json': JSON.stringify({ scripts: { test: ['node'] } }) });
    assert.match(result.unreadableClosure[0], /is not a command string/);
  });

  it('refuses an invocation this reader cannot resolve, rather than reading it anyway', () => {
    for (const [command, pattern] of [
      ['cd packages/thing && node --test tests/unit/*.test.js', /`cd` moved/],
      ['node --test', /no argument/],
      ['node --test packages/*/tests/unit/one.test.js', /across directories/],
    ]) {
      const result = closure(manifestTree({ test: command }));
      assert.equal(result.unreadableClosure.length, 1, command);
      assert.match(result.unreadableClosure[0], pattern);
      assert.match(result.unreadableClosure[0], /script `test`/);
    }
  });
});

describe('real-tree lock', () => {
  it('the committed inventories and coverage lists hold', () => {
    assert.deepEqual(
      formatProblems(auditInventories({ files: trackedFiles(), readFile: readRepoFile })),
      [],
      'scripts/check-test-inventory.js must pass on the committed tree',
    );
  });

  it('the committed registration closes', () => {
    assert.deepEqual(
      formatProblems(auditRegistrationClosure({ files: trackedFiles(), readFile: readRepoFile })),
      [],
      'every registered suite is one the committed tree really selects',
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
    const ruleFor = (dir) => DOC_INVENTORIES.find((inv) => inv.dir === dir).selects;

    // The node-test trees: the runner expands `*.test.js` at the top of each
    // directory, so a helper beside the tests and a file one level deeper are
    // both outside the suite.
    for (const dir of [
      'packages/shared/tests/unit',
      'packages/desktop/tests/unit',
      'packages/extension/tests/unit',
    ]) {
      const selects = ruleFor(dir);
      assert.equal(selects('session.test.js'), true, `${dir} selects session.test.js`);
      assert.equal(selects('vector-measurement.js'), false, `${dir} skips vector-measurement.js`);
      assert.equal(selects('nested/x.test.js'), false, `${dir} skips nested/x.test.js`);
    }

    // Playwright's default testMatch, at any depth under its testDir.
    for (const dir of [
      'packages/extension/tests/e2e/specs',
      'packages/desktop/tests/integration',
    ]) {
      const selects = ruleFor(dir);
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
    const cargo = ruleFor('packages/desktop/src-tauri/tests');
    assert.equal(cargo('worker_pool_test.rs'), true);
    assert.equal(cargo('nested/main.rs'), false);
    assert.equal(cargo('common/mod.rs'), false);
    assert.equal(cargo('worker_pool_test.proptest-regressions'), false);
  });
});

describe('stripFences — the one fence model, exported', () => {
  it('blanks backtick and tilde fences, each closed by its own marker, preserving line count', () => {
    const text = [
      'live',
      '```',
      'fenced ``` still open? no — this closes it? no',
      '```',
      '~~~',
      'tilde fenced',
      '~~~',
      'after',
    ].join('\n');
    const stripped = stripFences(text);
    assert.equal(stripped.split('\n').length, text.split('\n').length);
    assert.ok(stripped.includes('live'));
    assert.ok(stripped.includes('after'));
    assert.ok(!stripped.includes('fenced'));
    assert.ok(!stripped.includes('tilde'));
  });

  it('normalizes CRLF input so consumers need no pre-normalization', () => {
    const stripped = stripFences('live\r\n```\r\nfenced\r\n```\r\nafter');
    assert.ok(!stripped.includes('\r'));
    assert.ok(!stripped.includes('fenced'));
    assert.ok(stripped.includes('after'));
  });
});

describe('extractClauseSection — the shared clause-scope slice', () => {
  const doc = [
    '# Title',
    '',
    '**XX-1.** First clause text.',
    'More of the first clause.',
    '',
    '**XX-2.** Second clause.',
    '',
    '## A Heading',
    '',
    'Outside any clause.',
  ].join('\n');

  it('slices from the marker to the next clause marker', () => {
    const section = extractClauseSection(doc, 'XX-1');
    assert.ok(section.includes('First clause text'));
    assert.ok(section.includes('More of the first clause'));
    assert.ok(!section.includes('Second clause'));
  });

  it('a heading of any level ends the slice — level 1 included', () => {
    const withH1 = doc.replace('## A Heading', '# A Top Heading');
    const section = extractClauseSection(withH1, 'XX-2');
    assert.ok(section.includes('Second clause'));
    assert.ok(!section.includes('Outside any clause'));
  });

  it('returns the empty string when the marker is absent', () => {
    assert.equal(extractClauseSection(doc, 'XX-9'), '');
  });

  it('a fenced marker can neither anchor nor truncate the slice', () => {
    const fenced = [
      '```',
      '**XX-1.** fenced impostor',
      '```',
      '**XX-1.** the real clause',
      'body',
    ].join('\n');
    const section = extractClauseSection(fenced, 'XX-1');
    assert.ok(section.includes('the real clause'));
    assert.ok(!section.includes('impostor'));
  });
});
