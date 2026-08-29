/**
 * check-test-inventory.test.js — Unit tests for the test-inventory lint
 * (scripts/check-test-inventory.js) that gates CI. The suite documents' tables,
 * the hand-maintained coverage lists, the registered suites' own registration,
 * and the mutation kill sets and mutate scope beside them are committed data,
 * so every way they can rot must fail loud:
 * these tests drive each red path over synthetic documents, synthetic sources,
 * and synthetic manifests — an undocumented test file, a row naming a file that
 * is not a member of the suite, a duplicate row, a coverage entry pointing at
 * nothing, an entry whose two halves name different files, a globbed suite no
 * entry registers, an entry whose descriptor no longer states what selects it,
 * an entry nothing runs, a mirrored discovery claim that no longer matches the
 * surface it mirrors, a test binary hidden from CI by any route past the
 * top-level discovery — the directory form, and each spelling in which the
 * crate manifest states the test targets itself — a mutation kill set naming a
 * test file that is not there or globbing none, on either engine, a mutate
 * scope the cargo configuration and the strategy document state differently in
 * either direction or one of them states twice, and a scope module both
 * surfaces agree on that the tree does not carry — and each way any of the
 * extractions can fail to reach its whole subject. Table parsing is proven to read only the documented section
 * and to ignore prose and fenced blocks (the reason the check reads rows, not
 * text), and the array scan survives reformatting while refusing a restructured
 * literal — including a requested property whose value is an expression, which
 * it once recorded as that expression's leading string — rather than reading
 * part of it; the kill-set readers refuse the same way, a joining call being the
 * one trailing expression they model because it leaves the set alone.
 *
 * Beside that staleness closure runs the MEMBERSHIP one, which decides what a
 * kill set ought to state rather than whether what it states is there, and it
 * carries its own families: the specifier classification, each class of it and
 * the refusal that makes it total; the walk over the followed class alone, with
 * confinement holding against a terminated one; the dynamic literal edge and
 * the computed non-edge beside it; the property arm's declared-class-first
 * precedence, the mixed surface it admits and the residue it states; both
 * directions of the test-surface leg on both engines; the in-module entry held
 * present and held back from answering for the module leg; the integration
 * classifier read as an import, with a comment-only mention admitted; the
 * module leg and the empty expansion it refuses; the `pub use` that makes the
 * Rust module mapping unsound; and the allowlist held from both sides. The
 * report is proven to carry every class any of the audits can raise, including
 * one it has no wording for yet, with the block count read from the shape it
 * was handed. Real-tree locks prove the shipped
 * inventories hold, that the shipped registration closes, that the shipped kill
 * sets name files that are there over one stated mutate scope, that each of
 * them states exactly what the criterion places in it, and that each
 * suite's membership rule still matches the discovery it mirrors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DOC_INVENTORIES,
  JS_KILL_SETS,
  JS_MEMBERSHIP,
  MEMBERSHIP_ALLOWLIST,
  MUTATE_SCOPE,
  RUNNERS,
  RUST_KILL_SET,
  RUST_MEMBERSHIP,
  SPECIFIER_CLASSES,
  TRACKED_LISTS,
  admittedManifests,
  auditInventories,
  auditKillSetMembership,
  auditMutationKillSets,
  auditRegistrationClosure,
  classifySpecifier,
  classifyTestSurface,
  crateLibraryName,
  importSpecifiers,
  pathGlobToRegExp,
  reachableFiles,
  resolveUsePath,
  rustUseTargets,
  stripRustComments,
  useTargets,
  backtickedName,
  backtickedTokens,
  basenameGlobToRegExp,
  blankJsLiterals,
  classifyArgument,
  configValues,
  duplicateSurfaceProblems,
  emptySurfaceProblems,
  extractClauseSection,
  extractLoopGlobs,
  flattenWhitespace,
  extractStepBody,
  formatProblems,
  identifiesSameFile,
  killSetTargets,
  nodeTestArguments,
  normalizePath,
  parseTables,
  readListEntries,
  readLoneStringLiteral,
  readPropertyStringArray,
  readScopeTable,
  readTableColumn,
  readTomlLine,
  readTomlStringArray,
  registered,
  selectTablesByHeader,
  selectsFor,
  splitRow,
  stripFences,
  stripTomlComment,
  switchCaseLabels,
  trackedFilesUnder,
  tokenizeJs,
  topLevelListItems,
  walkObjectLiteral,
} from '../../../../scripts/check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** All tracked repo-relative paths, for the real-tree locks. */
const trackedFiles = () => trackedFilesUnder('.', { cwd: ROOT });

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
    header: ['Spec', 'Covers'],
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

  it('reads only the tables carrying the documented WHOLE header', () => {
    // The sibling leads with the same first cell and differs in the second:
    // selection by the whole header is what leaves it alone.
    const doc = suiteDoc(['a.spec.js']).replace(
      '| Spec | Covers |',
      ['| Spec | Notes |', '| --- | --- |', '| `not-a-spec.js` | a different table |', '', '| Spec | Covers |'].join('\n'), // prettier-ignore
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
      header: ['Spec', 'Covers'],
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

  it('refuses a list that states one file twice — the drift the tracked-set diff cannot see', () => {
    const result = audit(
      {
        'tests/coverage-fixture.js': "const TRACKED_FILES = ['panel.js', 'panel.js'];",
        'tests/teardown.js':
          "const TRACKED_FILES = [{ match: 'a/panel.js', src: 'a/panel.js' }, { match: 'a/panel.js', src: 'a/panel.js' }];", // prettier-ignore
      },
      { files: ['src/panel.js', 'pkg/a/panel.js'], inventories: [], lists: LISTS },
    );
    assert.deepEqual(result.duplicatedEntry, [
      '`panel.js` appears more than once in `TRACKED_FILES` in tests/coverage-fixture.js',
      '`a/panel.js` appears more than once in `TRACKED_FILES` in tests/teardown.js',
    ]);
    // The entry is a tracked file either way: the repeat is the whole finding.
    assert.deepEqual(result.missingSource, []);
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

describe('trackedFilesUnder — the one population read', () => {
  it('states the quotepath policy: a non-ASCII path arrives as itself', () => {
    // The policy this reader exists to state, held behaviourally: git's
    // default quotes such a path (`"caf\303\251.js"`), and every filter a
    // caller applies then drops the file — present in the tree, absent from
    // the scan. Deleting the policy reds here, in its own name.
    const dir = mkdtempSync(join(tmpdir(), 'docent-quotepath-'));
    try {
      const name = 'café.js';
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, name), '// probe\n');
      execFileSync('git', ['add', name], { cwd: dir });

      assert.deepEqual(trackedFilesUnder('.', { cwd: dir }), [name]);
      assert.deepEqual(trackedFilesUnder('.', { cwd: dir, extensions: ['.js'] }), [name]);

      // The contrast, run the way git does it without the policy: the same
      // file comes back quoted and escaped, so an extension filter loses it.
      const quoted = execFileSync('git', ['ls-files', '.'], { cwd: dir, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      assert.notDeepEqual(quoted, [name], 'git quotes the path without the policy');
      assert.equal(
        quoted.filter((f) => f.endsWith('.js')).length,
        0,
        'and an extension filter then drops it',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the caller’s filters, and neither by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docent-population-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      for (const name of ['a.js', 'b.mjs', 'notes.md']) writeFileSync(join(dir, name), 'x\n');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      assert.deepEqual(trackedFilesUnder('.', { cwd: dir }), ['a.js', 'b.mjs', 'notes.md']);
      assert.deepEqual(trackedFilesUnder('.', { cwd: dir, extensions: ['.js', '.mjs'] }), ['a.js', 'b.mjs']); // prettier-ignore
      assert.deepEqual(trackedFilesUnder('*.md', { cwd: dir }), ['notes.md'], 'a pathspec, not only a directory'); // prettier-ignore
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the shared doc-scan primitives', () => {
  const doc = [
    '## Section',
    '',
    '| Spec | Covers |',
    '| --- | --- |',
    '| `a.spec.js` | one |',
    '',
    '### Deeper',
    '',
    '| Spec | Covers |',
    '| --- | --- |',
    '| `b.spec.js` | two |',
    '',
    '| Spec | Notes |',
    '| --- | --- |',
    '| `c.spec.js` | a sibling with another header |',
    '',
  ].join('\n');

  it('tags each table with the deeper heading it sits under, so a section can hold several', () => {
    const tables = parseTables(doc);
    assert.deepEqual(
      tables.map((t) => [t.section, t.subsection, t.header[1]]),
      [
        ['Section', null, 'Covers'],
        ['Section', 'Deeper', 'Covers'],
        ['Section', 'Deeper', 'Notes'],
      ],
    );
  });

  it('selects by the WHOLE header, and a subsection addresses one same-header table', () => {
    const all = selectTablesByHeader(doc, { section: 'Section', header: ['Spec', 'Covers'] });
    assert.equal(all.matches, 2, 'both same-header tables of the section');
    assert.deepEqual(all.tables.flatMap((t) => t.rows.map((r) => r[0])), ['`a.spec.js`', '`b.spec.js`']); // prettier-ignore

    const one = selectTablesByHeader(doc, {
      section: 'Section',
      subsection: 'Deeper',
      header: ['Spec', 'Covers'],
    });
    assert.equal(one.matches, 1, 'the subsection tag addresses one of them');
    assert.deepEqual(one.tables[0].rows[0][0], '`b.spec.js`');

    const sibling = selectTablesByHeader(doc, { section: 'Section', header: ['Spec', 'Notes'] });
    assert.equal(sibling.matches, 1, 'the sibling is its own table, never conscripted');
  });

  it('reads a column as names, keeping the cells that do not read as one', () => {
    const table = { header: ['Spec', 'Covers'], rows: [['`a.js`', 'x'], ['plain', 'y'], ['', 'z']] }; // prettier-ignore
    const read = readTableColumn([table], { empty: '(empty first cell)' });
    assert.deepEqual(read.names, ['a.js']);
    assert.deepEqual(read.unreadable, ['plain', '(empty first cell)']);
  });

  it('reads a column the table itself names, and passes over a table that has none', () => {
    const named = { header: ['Spec', 'Source'], rows: [['x', '`b.js`']] };
    const without = { header: ['Spec', 'Covers'], rows: [['x', 'y']] };
    const column = (t) => t.header.findIndex((cell) => cell === 'Source');
    const read = readTableColumn([named, without], { empty: '(empty)', column });
    assert.deepEqual(read.names, ['b.js']);
    assert.deepEqual(read.unreadable, []);
  });

  it('collects WHOLE backticked spans only, in document order, dedup at the caller', () => {
    const text = 'takes `alpha`, then `alpha` again, and `emit("alpha") beside beta` in one span';
    assert.deepEqual(backtickedTokens(text), ['alpha', 'alpha', 'emit("alpha") beside beta']);
    assert.deepEqual(backtickedTokens(text, { dedupe: true }), [
      'alpha',
      'emit("alpha") beside beta',
    ]);
    // A token inside a larger span is not a token here — the property every
    // collector asserted for itself before this primitive existed.
    assert.deepEqual(backtickedTokens(text, { shape: /^alpha$/ }), ['alpha', 'alpha']);
    assert.deepEqual(backtickedTokens(text, { shape: (t) => t.startsWith('beta') }), []);
    assert.deepEqual(backtickedTokens(null), []);
  });

  it('bounds a top-level list item to its own lines', () => {
    const text = ['- one', '  continued', '- two', '', 'a paragraph after'].join('\n');
    assert.deepEqual(topLevelListItems(text), ['one continued', 'two']);
  });

  it('flattens every whitespace run and trims the ends', () => {
    assert.equal(flattenWhitespace('  a\n  b\tc  '), 'a b c');
    assert.equal(flattenWhitespace(null), '');
  });

  it('reads the shipped multi-table section as the one inventory it is', () => {
    // The live pin for merge-all: this section states its inventory as several
    // tables of one header, so a selector that demanded exactly one would red
    // the shipped tree, and the subsection tag is what makes them addressable
    // one at a time.
    const e2e = readRepoFile('docs/test/e2e.md');
    const { tables, matches } = selectTablesByHeader(e2e, {
      section: 'What the suite covers',
      header: ['Spec', 'Covers'],
    });
    assert.ok(matches > 1, `expected several tables, got ${matches}`);
    assert.equal(new Set(tables.map((t) => t.subsection)).size, matches, 'each under its own heading'); // prettier-ignore
    assert.ok(tables.flatMap((t) => t.rows).length > 0);
  });
});

describe('switchCaseLabels — the brace-bounded case collector', () => {
  const view = (source) => blankJsLiterals(source, { literals: false });

  it('reads every label of the switch body, including one after the default arm', () => {
    const src = [
      'switch (cmd) {',
      "  case 'a': return 1;",
      '  default: return 0;',
      "  case 'after_default': return 2;",
      '}',
    ].join('\n');
    const read = switchCaseLabels(view(src), 'switch (cmd)');
    assert.deepEqual(read.labels, ['a', 'after_default']);
    assert.equal(read.hasDefault, true);
    assert.deepEqual(read.problems, []);
  });

  it('never reads a label the source comments out', () => {
    const src = ['switch (cmd) {', '  /*', "  case 'commented': return 1;", '  */', '}'].join('\n');
    assert.deepEqual(switchCaseLabels(view(src), 'switch (cmd)').labels, []);
  });

  it('refuses a second switch at its own depth rather than crediting those labels', () => {
    const src = "switch (cmd) { case 'host': switch (x) { case 'inner': break; } }";
    const read = switchCaseLabels(view(src), 'switch (cmd)');
    assert.deepEqual(read.labels, []);
    assert.match(read.problems[0], /carries a second switch at this switch's own depth/);
  });

  it('refuses a body that never closes, and an anchor that is not there', () => {
    assert.match(switchCaseLabels("switch (cmd) { case 'a':", 'switch (cmd)').problems[0], /never closes/); // prettier-ignore
    assert.match(switchCaseLabels('const x = 1;', 'switch (cmd)').problems[0], /no .* statement found/); // prettier-ignore
  });

  it('blanks an unterminated template to the end of the source', () => {
    // The arm that runs off the end: the view stays a view, and the scan that
    // reads it finds no switch rather than reading the rest of the file.
    const src = 'const script = `switch (cmd) { case ';
    assert.deepEqual(switchCaseLabels(blankJsLiterals(src, { literals: false }), 'switch (cmd)').labels, []); // prettier-ignore
    assert.match(blankJsLiterals(src), /const script = `\s+$/);
  });

  it('reads a switch a template literal carries, through the template’s own text', () => {
    // The welded half, and the nesting it forces. A token stream hands a
    // template over as ONE token, so the scan cannot see the switch at all
    // through the default view — and a view of the outer source that merely
    // keeps literal text does not blank the SCRIPT's comments either, because
    // at that level the template's text is not code. The caller therefore
    // takes the template's text and reads it as the source it becomes.
    const src = "const script = `switch (cmd) { case 'a': return 1; /* case 'off': */ }`;";
    assert.deepEqual(switchCaseLabels(blankJsLiterals(src), 'switch (cmd)').labels, []);
    assert.deepEqual(switchCaseLabels(view(src), 'switch (cmd)').labels, ['a', 'off']);

    const carrier = tokenizeJs(src).find((t) => t.type === 'template');
    assert.deepEqual(switchCaseLabels(view(carrier.value), 'switch (cmd)').labels, ['a']);
  });
});

describe('walkObjectLiteral — the shared object-literal skeleton', () => {
  /** The property-start tokens the walk hands its policy, as text. */
  const starts = (source) => {
    const tokens = tokenizeJs(source);
    const open = tokens.findIndex((t) => t.type === 'punct' && t.value === '{');
    const seen = [];
    const { closed } = walkObjectLiteral(tokens, open, (i, t) => seen.push(t.value));
    return { seen, closed };
  };

  it('hands the policy each top-level property start and passes nested shapes through whole', () => {
    const read = starts('({ a: 1, b: { c: 2 }, d: [3, 4], e: f(5, 6) })');
    assert.deepEqual(read.seen, ['a', 'b', 'd', 'e']);
    assert.equal(read.closed, true);
  });

  it('reads a comma at a property start as the separator it is', () => {
    // The one semantic decision the merged skeleton fixes: the walks it
    // replaces disagreed here, and this is the reading both callers now get.
    assert.deepEqual(starts('({ a: 1,, b: 2 })').seen, ['a', 'b']);
    assert.deepEqual(starts('({ , a: 1 })').seen, ['a']);
  });

  it('hands an opening bracket at a property start to the policy, then descends', () => {
    assert.deepEqual(starts('({ [k]: 1, b: 2 })').seen, ['[', 'b']);
  });

  it('reports a literal that never closes, having walked what it could', () => {
    const read = starts('({ a: 1, b: 2');
    assert.deepEqual(read.seen, ['a', 'b']);
    assert.equal(read.closed, false);
  });

  it('leaves a trailing comma stating no property', () => {
    assert.deepEqual(starts('({ a: 1, })').seen, ['a']);
  });
});

describe('tokenizeJs — template literals', () => {
  it('reads a template with no interpolation as one template token', () => {
    // A template is not a quoted string: every reader that accepts a `string`
    // token accepts a quoted literal, so the type is what keeps a template from
    // being credited as one.
    assert.deepEqual(tokenizeJs('invoke(`load_state`)'), [
      { type: 'word', value: 'invoke' },
      { type: 'punct', value: '(' },
      { type: 'template', value: 'load_state' },
      { type: 'punct', value: ')' },
    ]);
  });

  it('reads an interpolation’s contents as the code they are', () => {
    assert.deepEqual(tokenizeJs('invoke(`load_${suffix}`)'), [
      { type: 'word', value: 'invoke' },
      { type: 'punct', value: '(' },
      { type: 'template', value: 'load_' },
      { type: 'word', value: 'suffix' },
      { type: 'template', value: '' },
      { type: 'punct', value: ')' },
    ]);
  });

  it('surfaces a call written inside an interpolation', () => {
    // The whole interpolation used to be string content, so a call written
    // there was invisible to every whole-file scan.
    assert.deepEqual(tokenizeJs('log(`x${invoke("load_state")}y`)'), [
      { type: 'word', value: 'log' },
      { type: 'punct', value: '(' },
      { type: 'template', value: 'x' },
      { type: 'word', value: 'invoke' },
      { type: 'punct', value: '(' },
      { type: 'string', value: 'load_state' },
      { type: 'punct', value: ')' },
      { type: 'template', value: 'y' },
      { type: 'punct', value: ')' },
    ]);
  });

  it('reads a nested template’s text as text, not as code', () => {
    // Text inside a nested template is text of the outer template's
    // interpolation; reading it as source would let a literal state a call, a
    // case label, or a registration that nothing performs.
    assert.deepEqual(tokenizeJs('invoke(`a${`b`}c`)'), [
      { type: 'word', value: 'invoke' },
      { type: 'punct', value: '(' },
      { type: 'template', value: 'a' },
      { type: 'template', value: 'b' },
      { type: 'template', value: 'c' },
      { type: 'punct', value: ')' },
    ]);
    assert.deepEqual(tokenizeJs("const t = `${`invoke('fake_cmd')`}`;"), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 't' },
      { type: 'punct', value: '=' },
      { type: 'template', value: '' },
      { type: 'template', value: "invoke('fake_cmd')" },
      { type: 'template', value: '' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('keeps a brace inside a template out of the surrounding depth count', () => {
    // The `${` and `}` delimiters never reach the stream, and a brace written
    // inside the template's text is text — so a depth-bounded walk over the
    // code around it counts what the code opened and nothing else.
    assert.deepEqual(tokenizeJs('{ const t = `${`}`}`; }'), [
      { type: 'punct', value: '{' },
      { type: 'word', value: 'const' },
      { type: 'word', value: 't' },
      { type: 'punct', value: '=' },
      { type: 'template', value: '' },
      { type: 'template', value: '}' },
      { type: 'template', value: '' },
      { type: 'punct', value: ';' },
      { type: 'punct', value: '}' },
    ]);
  });

  it('reads a tagged template as its tag and its text', () => {
    assert.deepEqual(tokenizeJs('html`<p>${x}</p>`'), [
      { type: 'word', value: 'html' },
      { type: 'template', value: '<p>' },
      { type: 'word', value: 'x' },
      { type: 'template', value: '</p>' },
    ]);
  });

  it('keeps the stream in step through a backtick quoted inside an interpolation', () => {
    // One of the shapes that used to desynchronize the rest of the file: the
    // quoted backtick closed the template and inverted every literal after it,
    // so both real call sites here were lost in silence.
    assert.deepEqual(tokenizeJs("invoke(`${f('`')}`); invoke('after');"), [
      { type: 'word', value: 'invoke' },
      { type: 'punct', value: '(' },
      { type: 'template', value: '' },
      { type: 'word', value: 'f' },
      { type: 'punct', value: '(' },
      { type: 'string', value: '`' },
      { type: 'punct', value: ')' },
      { type: 'template', value: '' },
      { type: 'punct', value: ')' },
      { type: 'punct', value: ';' },
      { type: 'word', value: 'invoke' },
      { type: 'punct', value: '(' },
      { type: 'string', value: 'after' },
      { type: 'punct', value: ')' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('honours escapes in template text and closes an unterminated one', () => {
    assert.deepEqual(tokenizeJs('`a\\`b`'), [{ type: 'template', value: 'a`b' }]);
    assert.deepEqual(tokenizeJs('`open'), [{ type: 'template', value: 'open' }]);
  });
});

describe('tokenizeJs — regular-expression literals', () => {
  // Whether a `/` opens a literal or divides is decided from the token before
  // it. These are the positions an expression can start at, so a literal may
  // open at each — and the quote inside the body is what proves it was read as
  // a literal: read as code, that quote opens a string and inverts every
  // literal after it.
  const OPENS_AFTER = [
    'const re =',
    'call(',
    'call(a,',
    'const o = { k:',
    'const a = [',
    'if (!',
    'a &&',
    'a ||',
    'a ??',
    'const f = () =>',
    'a ?',
    'a;',
    'if (a) {',
    'if (a) { g(); }',
    'return',
    'typeof',
    'a instanceof',
    'k in',
    'for (const k of',
    'new',
    'delete',
    'void',
    'case',
    'export default',
    'do',
    'else',
    'class A extends',
    'yield',
    'await',
    'throw',
  ];

  it('opens a literal wherever an expression can start', () => {
    for (const before of OPENS_AFTER) {
      const tokens = tokenizeJs(`${before} /a'b/`);
      assert.deepEqual(
        tokens[tokens.length - 1],
        { type: 'regex', value: "/a'b/" },
        `a literal should open after ${JSON.stringify(before)}`,
      );
      assert.equal(
        tokens.some((t) => t.type === 'string'),
        false,
        `no phantom string after ${JSON.stringify(before)}`,
      );
    }
  });

  it('divides after a value, whatever kind of value it is', () => {
    // The other half of the same decision: an identifier, a number, and the
    // closers that end a call, a group, or an index are all values.
    for (const source of ['a / b', '(a) / 2', '4 / 2', 'a[0] / 2', 'f() / 2', "'s' / 2"]) {
      const tokens = tokenizeJs(source);
      assert.equal(
        tokens.some((t) => t.type === 'regex'),
        false,
        `${JSON.stringify(source)} divides`,
      );
      assert.ok(
        tokens.some((t) => t.type === 'punct' && t.value === '/'),
        `${JSON.stringify(source)} keeps its division as punctuation`,
      );
    }
  });

  it('reads a keyword written as a property name as the value it is', () => {
    // A word a `.` precedes is a property, so `o.in` is a value and the `/`
    // after it divides — the member rule, without which `in` would open a
    // literal here and swallow the rest of the expression.
    assert.deepEqual(tokenizeJs('o.in / 2 / 3'), [
      { type: 'word', value: 'o' },
      { type: 'punct', value: '.' },
      { type: 'word', value: 'in' },
      { type: 'punct', value: '/' },
      { type: 'word', value: '2' },
      { type: 'punct', value: '/' },
      { type: 'word', value: '3' },
    ]);
    assert.deepEqual(tokenizeJs('RE.test(s)'), [
      { type: 'word', value: 'RE' },
      { type: 'punct', value: '.' },
      { type: 'word', value: 'test' },
      { type: 'punct', value: '(' },
      { type: 'word', value: 's' },
      { type: 'punct', value: ')' },
    ]);
  });

  it('honours an escaped delimiter inside the pattern', () => {
    assert.deepEqual(tokenizeJs('const re = /a\\/b/;'), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 're' },
      { type: 'punct', value: '=' },
      { type: 'regex', value: '/a\\/b/' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('reads a delimiter inside a character class as pattern text', () => {
    // An unescaped `/` is legal inside `[…]`, so a class is what decides where
    // the literal ends.
    assert.deepEqual(tokenizeJs('const re = /x:\\/\\/([^/]+)/;'), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 're' },
      { type: 'punct', value: '=' },
      { type: 'regex', value: '/x:\\/\\/([^/]+)/' },
      { type: 'punct', value: ';' },
    ]);
    assert.deepEqual(tokenizeJs('const re = /[\\]]/;'), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 're' },
      { type: 'punct', value: '=' },
      { type: 'regex', value: '/[\\]]/' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('keeps the stream in step through a quote written inside a pattern', () => {
    // One of the shapes that used to desynchronize the rest of the file: the
    // quote used to open a string literal, so the real call site after it was
    // lost in silence — the same failure the quoted backtick used to cause in
    // a template.
    assert.deepEqual(tokenizeJs("const re = /[^'\"]+/g; send({ type: 'PING' });"), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 're' },
      { type: 'punct', value: '=' },
      { type: 'regex', value: '/[^\'"]+/g' },
      { type: 'punct', value: ';' },
      { type: 'word', value: 'send' },
      { type: 'punct', value: '(' },
      { type: 'punct', value: '{' },
      { type: 'word', value: 'type' },
      { type: 'punct', value: ':' },
      { type: 'string', value: 'PING' },
      { type: 'punct', value: '}' },
      { type: 'punct', value: ')' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('keeps the stream in step through a backtick written inside a pattern', () => {
    // A backtick inside a pattern must not open a template: it used to, and a
    // phantom template run swallows code the same way a phantom string does.
    assert.deepEqual(tokenizeJs("const re = /`/; send({ type: 'PING' });"), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 're' },
      { type: 'punct', value: '=' },
      { type: 'regex', value: '/`/' },
      { type: 'punct', value: ';' },
      { type: 'word', value: 'send' },
      { type: 'punct', value: '(' },
      { type: 'punct', value: '{' },
      { type: 'word', value: 'type' },
      { type: 'punct', value: ':' },
      { type: 'string', value: 'PING' },
      { type: 'punct', value: '}' },
      { type: 'punct', value: ')' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('carries the flag run with the literal it belongs to', () => {
    assert.deepEqual(tokenizeJs('const re = /a/gimsy;'), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 're' },
      { type: 'punct', value: '=' },
      { type: 'regex', value: '/a/gimsy' },
      { type: 'punct', value: ';' },
    ]);
    assert.deepEqual(tokenizeJs('const re = /a/;'), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 're' },
      { type: 'punct', value: '=' },
      { type: 'regex', value: '/a/' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('reads a literal written inside an interpolation', () => {
    // An interpolation opens at an expression start, whatever text preceded
    // the `${`.
    assert.deepEqual(tokenizeJs('log(`x${/a"b/.test(s)}y`)'), [
      { type: 'word', value: 'log' },
      { type: 'punct', value: '(' },
      { type: 'template', value: 'x' },
      { type: 'regex', value: '/a"b/' },
      { type: 'punct', value: '.' },
      { type: 'word', value: 'test' },
      { type: 'punct', value: '(' },
      { type: 'word', value: 's' },
      { type: 'punct', value: ')' },
      { type: 'template', value: 'y' },
      { type: 'punct', value: ')' },
    ]);
  });

  it('skips a hashbang line rather than reading a path as a literal', () => {
    assert.deepEqual(tokenizeJs('#!/usr/bin/env node\nconst a = 1;'), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 'a' },
      { type: 'punct', value: '=' },
      { type: 'word', value: '1' },
      { type: 'punct', value: ';' },
    ]);
    // Only at the start: `#!` anywhere else is punctuation like any other.
    assert.deepEqual(tokenizeJs('a;\n#!b'), [
      { type: 'word', value: 'a' },
      { type: 'punct', value: ';' },
      { type: 'punct', value: '#' },
      { type: 'punct', value: '!' },
      { type: 'word', value: 'b' },
    ]);
  });

  it('abandons a run that reaches a line terminator, reading the `/` as punctuation', () => {
    // A literal may not cross a line terminator. Abandoning the run is what
    // bounds a `/` read as a literal by mistake to the line it is written on.
    assert.deepEqual(tokenizeJs("const y = / b\nsend('after');"), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 'y' },
      { type: 'punct', value: '=' },
      { type: 'punct', value: '/' },
      { type: 'word', value: 'b' },
      { type: 'word', value: 'send' },
      { type: 'punct', value: '(' },
      { type: 'string', value: 'after' },
      { type: 'punct', value: ')' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('reads a literal after the `)` of an `if` head as division — a named residual', () => {
    // The prior token cannot tell that `)` from the one closing a call, so the
    // literal is read as the code it is not: the pattern's own text enters the
    // stream, and the unmatched quote written in it opens a string that runs on
    // past the literal's end — which is what the last token below states.
    assert.deepEqual(tokenizeJs("if (a) /x'y/.test(s);"), [
      { type: 'word', value: 'if' },
      { type: 'punct', value: '(' },
      { type: 'word', value: 'a' },
      { type: 'punct', value: ')' },
      { type: 'punct', value: '/' },
      { type: 'word', value: 'x' },
      { type: 'string', value: 'y/.test(s);' },
    ]);
  });

  it('caps a division read as a literal at its own line — the other named residual', () => {
    // A `}` is read as ending a statement, so a division written after an
    // object literal opens a literal instead. The run closes at the next `/`
    // ON THAT LINE and cannot reach further: the line after it tokenizes
    // exactly as written.
    assert.deepEqual(tokenizeJs('const n = { a: 1 } / 2 / 3;\nsend({ type: "AFTER" });'), [
      { type: 'word', value: 'const' },
      { type: 'word', value: 'n' },
      { type: 'punct', value: '=' },
      { type: 'punct', value: '{' },
      { type: 'word', value: 'a' },
      { type: 'punct', value: ':' },
      { type: 'word', value: '1' },
      { type: 'punct', value: '}' },
      { type: 'regex', value: '/ 2 /' },
      { type: 'word', value: '3' },
      { type: 'punct', value: ';' },
      { type: 'word', value: 'send' },
      { type: 'punct', value: '(' },
      { type: 'punct', value: '{' },
      { type: 'word', value: 'type' },
      { type: 'punct', value: ':' },
      { type: 'string', value: 'AFTER' },
      { type: 'punct', value: '}' },
      { type: 'punct', value: ')' },
      { type: 'punct', value: ';' },
    ]);
  });

  it('keeps a brace inside a literal read as one out of the surrounding depth count', () => {
    // A literal is one token, so no brace it carries reaches a depth-bounded
    // walk over the code around it — balanced or not.
    for (const pattern of ['/a{2,3}/', '/[{]/', '/\\{/', '/[}]/']) {
      const tokens = tokenizeJs(`if (${pattern}.test(s)) { g(); }`);
      const braces = tokens.filter(
        (t) => t.type === 'punct' && (t.value === '{' || t.value === '}'),
      );
      assert.deepEqual(
        braces.map((t) => t.value),
        ['{', '}'],
        `${pattern} contributes no brace of its own`,
      );
    }
  });
});

describe('blankJsLiterals', () => {
  /**
   * Assert the view is the source's own shape: same length, same newlines, and
   * every character either its own or a space.
   * @param {string} source
   * @returns {string} the view
   */
  const view = (source) => {
    const blanked = blankJsLiterals(source);
    assert.equal(blanked.length, source.length, 'length preserved');
    assert.deepEqual(
      [...blanked].map((c, k) => (c === '\n' ? k : -1)).filter((k) => k !== -1),
      [...source].map((c, k) => (c === '\n' ? k : -1)).filter((k) => k !== -1),
      'every newline at its own offset',
    );
    for (let k = 0; k < source.length; k++) {
      assert.ok(
        blanked[k] === source[k] || blanked[k] === ' ',
        `character ${k} is its own or a space`,
      );
    }
    return blanked;
  };

  it('keeps every offset, every newline, and the source’s own length', () => {
    const source = "const u = 'http://x';\n// gone\n/* also\ngone */\nconst t = `a${b}c`;\n";
    const blanked = view(source);
    assert.equal(blanked.indexOf('const t'), source.indexOf('const t'));
  });

  it('blanks a comment whole and a literal’s contents only', () => {
    assert.equal(view('a; // gone\nb;'), 'a;        \nb;');
    assert.equal(view('a; /* gone\ngone */ b;'), 'a;        \n        b;');
    assert.equal(view("const u = 'http://x';"), "const u = '        ';");
    assert.equal(view('const u = "ab";'), 'const u = "  ";');
  });

  it('keeps a template’s delimiters and reads its interpolation as the code it is', () => {
    // The backtick, the `${`, and the `}` delimit; the text between them is
    // what the literal carries.
    assert.equal(view('x(`a${b}c`)'), 'x(` ${b} `)');
  });

  it('keeps a regular-expression literal’s delimiters and pattern, and blanks its flag run', () => {
    // The pattern is text the source states about what it handles, so it
    // stands; the flag run is word-shaped literal data, and a view that left it
    // standing would hand a guard an identifier nobody wrote. Both delimiters
    // stay, the closing one included, flagged or not.
    assert.equal(view("const re = /a'b/g;"), "const re = /a'b/ ;");
    assert.equal(view('const re = /\\/$/g;'), 'const re = /\\/$/ ;');
    assert.equal(view('const re = /a/;'), 'const re = /a/;');
  });

  it('shows a search the name a pattern mentions, and hides the one a string carries', () => {
    // The direction a guard asserting an absence depends on: a forbidden name
    // written into a pattern is a mention the guard can report, while the same
    // name inside a string is the source's own data and stays out of view.
    assert.match(view('const re = /window_rect/;'), /\bwindow_rect\b/);
    assert.doesNotMatch(view("const s = 'window_rect';"), /\bwindow_rect\b/);
  });

  it('reads the live shapes a guard meets in these sources', () => {
    // A `//` inside a URL string is that string's contents; a glob inside a
    // template is template text; a quote inside a pattern is pattern text. Code
    // written after each of them is code, and stays visible as code.
    const urls = "chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });\nchrome.runtime.id;";
    assert.ok(view(urls).includes('chrome.runtime.id;'), 'code after a URL-glob string survives');

    const scheme = "if (tab.url.startsWith('chrome://')) return;\nchrome.tabs.query();";
    assert.ok(view(scheme).includes('chrome.tabs.query();'), 'code after a scheme string survives');

    const glob =
      'await page.route(`${origin}/**`, h);\nchrome.runtime.id;\n/** doc */\nchrome.tabs.query();';
    assert.ok(view(glob).includes('chrome.tabs.query();'), 'code after a template glob survives');

    const cssString =
      'return String(v).replace(/\\\\/g, "x").replace(/"/g, "y");\nel.namespaceURI;';
    assert.ok(
      view(cssString).includes('el.namespaceURI;'),
      'code after a quote-carrying pattern survives',
    );
  });

  it('renders a source carrying each blanked kind exactly as stated', () => {
    // Every kind the view blanks, in one source: a comment, a string's
    // contents, a template's text either side of an interpolation whose code
    // stands, and a pattern's flag run. What each rendering does with a
    // literal's contents is its own — the stream carries a string's text as a
    // token value where the view blanks it, and keeps a pattern as a token
    // value where the view leaves it standing — and a comment reaches neither.
    const source = "const re = /[^'\"]+/g;\nsend({ type: 'PING', at: `x${k}y` }); // note\n";
    assert.equal(
      view(source),
      "const re = /[^'\"]+/ ;\nsend({ type: '    ', at: ` ${k} ` });        \n",
    );
  });

  it('reads the shapes the tracked modules carry no instance of the same way as the stream', () => {
    // Agreement over the tree can only hold what the tree contains, so the ends
    // of the scanning rules are pinned by hand: a literal whose run reaches the
    // line terminator, an escape standing at the very end of the source, and a
    // lone carriage return as the terminator that abandons a run.
    const edges = [
      "const re = /unterminated;\nsend({ type: 'AFTER' });",
      'const re = /a\\',
      "const y = / b\rsend('after');",
    ];
    for (const source of edges) {
      assert.deepEqual(
        tokenizeJs(blankJsLiterals(source)).map((token) => token.type),
        tokenizeJs(source).map((token) => token.type),
        JSON.stringify(source),
      );
    }
  });
});

describe('readLoneStringLiteral', () => {
  it('answers lone for a string literal an accepted follower ends', () => {
    const tokens = tokenizeJs("invoke('load_state');");
    assert.deepEqual(readLoneStringLiteral(tokens, 2, ',)'), {
      lone: true,
      value: 'load_state',
      token: 'load_state',
      kind: 'string',
      isString: true,
      follower: ')',
    });
  });

  it('answers the facts, never a verdict, when the literal leads an expression', () => {
    const tokens = tokenizeJs("invoke('load_state' + suffix);");
    assert.deepEqual(readLoneStringLiteral(tokens, 2, ',)'), {
      lone: false,
      value: null,
      token: 'load_state',
      kind: 'string',
      isString: true,
      follower: '+',
    });
  });

  it('distinguishes a template and a non-literal from a string, naming each kind', () => {
    // The kind is what lets a caller name a template as a template: both
    // candidates below answer the same on every other fact, and a refusal
    // reading `token` alone would state the template's text as the argument.
    assert.deepEqual(readLoneStringLiteral(tokenizeJs('invoke(`load_state`);'), 2, ',)'), {
      lone: false,
      value: null,
      token: 'load_state',
      kind: 'template',
      isString: false,
      follower: ')',
    });
    assert.deepEqual(readLoneStringLiteral(tokenizeJs('invoke(commandName);'), 2, ',)'), {
      lone: false,
      value: null,
      token: 'commandName',
      kind: 'word',
      isString: false,
      follower: ')',
    });
  });

  it('names a regular-expression literal standing in a value position', () => {
    // `string` still means a quoted literal and nothing else, so a pattern in
    // an argument is refused — and the kind travelling with the answer is what
    // lets the refusal name it as the pattern the source states rather than as
    // a lump of punctuation.
    assert.deepEqual(readLoneStringLiteral(tokenizeJs('invoke(/load_state/);'), 2, ',)'), {
      lone: false,
      value: null,
      token: '/load_state/',
      kind: 'regex',
      isString: false,
      follower: ')',
    });
  });

  it('answers null for a token and a follower the stream does not carry', () => {
    // Truncation is a fact of its own, because the callers that distinguish it
    // render it differently from every other refusal.
    assert.deepEqual(readLoneStringLiteral(tokenizeJs("invoke('load_state'"), 2, ',)'), {
      lone: false,
      value: null,
      token: 'load_state',
      kind: 'string',
      isString: true,
      follower: null,
    });
    assert.deepEqual(readLoneStringLiteral(tokenizeJs('invoke('), 2, ',)'), {
      lone: false,
      value: null,
      token: null,
      kind: null,
      isString: false,
      follower: null,
    });
  });

  it('honours the follower set it is given rather than one of its own', () => {
    const tokens = tokenizeJs("send({ type: 'PING' })");
    assert.equal(readLoneStringLiteral(tokens, 5, ',}').lone, true);
    assert.equal(readLoneStringLiteral(tokens, 5, ',)').lone, false);
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

  it('names a requested property written as a template rather than reporting it missing', () => {
    // The property IS there; recording nothing and reporting "no `src`
    // property" would name a cause the source does not have.
    for (const source of ['const T = [{ src: `a.js` }];', 'const T = [{ src: `a-${v}.js` }];']) {
      const read = readListEntries(source, 'T', ['src']);
      assert.match(read.error, /`src` property is a template literal/, source);
      assert.match(read.error, /reads a quoted string literal/, source);
    }
  });

  it('names a requested property written as a regular expression, with the pattern the source states', () => {
    // The same rule for the other literal this reader does not read, and the
    // literal is named as written: a pattern's escapes are its meaning.
    const read = readListEntries('const T = [{ src: /a\\.js/ }];', 'T', ['src']);
    assert.match(read.error, /`src` property is a regular-expression literal \(`\/a\\\.js\/`\)/);
    assert.match(read.error, /reads a quoted string literal/);
  });

  it('names a template element of a plain list as a template, not as its text', () => {
    // The element IS there, and a template's token value is a run of its
    // literal text: naming the token alone would state an element the source
    // never writes — and, interpolated, a name nothing can ever match.
    for (const source of ['const T = [`a.js`];', 'const T = [`a-${v}.js`];']) {
      const read = readListEntries(source, 'T');
      assert.match(read.error, /holds a template literal \(`a/, source);
      assert.match(read.error, /does not model/, source);
    }
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
  header: ['Test file', 'Covers'],
  dir: 'packages/thing/tests/unit',
  discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
});

/** The cargo suite the mirror fixtures register. */
const CARGO_ENTRY = registered({
  doc: 'docs/rust.md',
  section: 'Suite layout',
  header: ['Test file', 'Covers'],
  dir: 'crate/tests',
  discovery: {
    runner: RUNNERS.cargo,
    workflow: '.github/workflows/test.yml',
    step: 'Discover Rust test layers',
    glob: 'tests/*.rs',
    manifest: 'crate/Cargo.toml',
  },
});

/** The browser-driven suite the mirror fixtures register. */
const PLAYWRIGHT_ENTRY = registered({
  doc: 'docs/browser.md',
  section: 'What the suite covers',
  header: ['Spec', 'Covers'],
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

/**
 * A crate manifest declaring no test binary of its own — the shape the
 * admission accepts — optionally carrying extra lines inside its `[package]`
 * table. Where a declaration sits decides whether it is Cargo's own, so the
 * fixtures place their lines rather than appending them to whatever table the
 * manifest happens to end in.
 */
const cargoManifest = (...packageLines) =>
  ['[package]', 'name = "crate"', ...packageLines, '', '[dev-dependencies]', 'proptest = "1"'].join('\n'); // prettier-ignore

/** The manifest as it stands with no extra line — the accepted shape. */
const CARGO_MANIFEST = cargoManifest();

/** A synthetic tree whose root manifest states `scripts`, plus anything else it needs. */
const manifestTree = (scripts, extra = {}) => ({
  'package.json': JSON.stringify({ scripts }),
  ...extra,
});

/**
 * A synthetic tree carrying both surfaces the cargo entry is read against: the
 * workflow step its membership rule mirrors, and the crate manifest its
 * discovery admission reads.
 */
const cargoTree = (extra = {}) =>
  manifestTree(
    { lint: 'echo ok' },
    { '.github/workflows/test.yml': WORKFLOW_TEXT, 'crate/Cargo.toml': CARGO_MANIFEST, ...extra },
  );

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
      header: NODE_ENTRY.header,
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
    assert.deepEqual(formatProblems(closure(cargoTree(), { inventories: [CARGO_ENTRY] })), []);
  });

  it('flags a widened discovery glob, naming both sides', () => {
    const widened = WORKFLOW_TEXT.replace('tests/*.rs', 'tests/*.rs tests/*/main.rs');
    const tree = cargoTree({ '.github/workflows/test.yml': widened });
    const result = closure(tree, { inventories: [CARGO_ENTRY] });
    assert.equal(result.mirrorDrift.length, 1);
    assert.match(result.mirrorDrift[0], /discovers `tests\/\*\.rs tests\/\*\/main\.rs`/);
    assert.match(result.mirrorDrift[0], /registers `tests\/\*\.rs`/);
  });

  it('refuses a discovery step that vanished under its registered name', () => {
    const renamed = WORKFLOW_TEXT.replace('Discover Rust test layers', 'Find the test layers');
    const tree = cargoTree({ '.github/workflows/test.yml': renamed });
    const result = closure(tree, { inventories: [CARGO_ENTRY] });
    assert.equal(result.unreadableClosure.length, 1);
    assert.match(result.unreadableClosure[0], /no step is named "Discover Rust test layers"/);
    assert.deepEqual(result.mirrorDrift, [], 'a surface that moved is never reported as a drift');
  });

  it('refuses a discovery step that discovers through no loop at all', () => {
    const empty = ['      - name: Discover Rust test layers', '        run: echo nothing'].join(
      '\n',
    );
    const tree = cargoTree({ '.github/workflows/test.yml': empty });
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

  it('names a testDir written as a template rather than counting it unreadable', () => {
    // The configuration DOES state a `testDir`; counting it among the values
    // this reader cannot read would name a cause the source does not have.
    const templated = browserTree('export default { testDir: `./${d}` };');
    const problem = closure(templated, { inventories: [PLAYWRIGHT_ENTRY] }).unreadableClosure[0];
    assert.match(problem, /states its `testDir` as a template literal/);
    assert.match(problem, /reads a quoted string literal/);
  });

  it('names a testDir written as a regular expression the same way', () => {
    const patterned = browserTree('export default { testDir: /specs/ };');
    const problem = closure(patterned, { inventories: [PLAYWRIGHT_ENTRY] }).unreadableClosure[0];
    assert.match(problem, /states its `testDir` as a regular-expression literal \(`\/specs\/`\)/);
    assert.match(problem, /reads a quoted string literal/);
  });

  it('refuses a working directory whose test script does not run the runner', () => {
    const tree = browserTree("export default { testDir: './specs' };", 'echo nothing');
    assert.match(
      closure(tree, { inventories: [PLAYWRIGHT_ENTRY] }).unreadableClosure[0],
      /does not run Playwright/,
    );
  });
});

describe('auditRegistrationClosure — the discovery admission, both routes', () => {
  /** The cargo tree plus the tracked files the path route reads. */
  const treeWithFiles = (files, extra = {}) => ({ tree: cargoTree(extra), files });

  /** Run the closure over a cargo tree whose tracked set carries suite files too. */
  const admit = ({ tree, files }) =>
    closure(tree, { inventories: [CARGO_ENTRY], files: [...Object.keys(tree), ...files] });

  it('admits the suite as it is meant to look: top-level binaries and shared module code', () => {
    // A nested non-`main.rs` file is the `tests/common/mod.rs` convention —
    // shared module code that runs nowhere on its own — and a `main.rs` deeper
    // than one level is not a binary Cargo builds either.
    const result = admit(
      treeWithFiles([
        'crate/tests/worker_pool_test.rs',
        'crate/tests/common/mod.rs',
        'crate/tests/common/deeper/main.rs',
      ]),
    );
    assert.deepEqual(formatProblems(result), []);
  });

  it('reds the directory form, naming the file and its own fix', () => {
    const result = admit(
      treeWithFiles(['crate/tests/worker_pool_test.rs', 'crate/tests/nested/main.rs']),
    );
    assert.equal(result.undiscoveredBinary.length, 1);
    assert.match(result.undiscoveredBinary[0], /^crate\/tests\/nested\/main\.rs:/);
    assert.match(result.undiscoveredBinary[0], /Cargo builds this as a test binary/);
    assert.match(result.undiscoveredBinary[0], /move it to a top-level `\.rs` in crate\/tests\//);
    // Its own leg, its own bucket: the mirror claim still holds, and is not
    // where this red is reported.
    assert.deepEqual(result.mirrorDrift, []);
    assert.deepEqual(result.unreadableClosure, []);
  });

  it('reds a manifest `[[test]]` stanza, naming it and its own fix', () => {
    const declaring = [CARGO_MANIFEST, '', '[[test]]', 'name = "hidden"', 'path = "elsewhere/hidden.rs"'].join('\n'); // prettier-ignore
    const result = admit(
      treeWithFiles(['crate/tests/worker_pool_test.rs'], { 'crate/Cargo.toml': declaring }),
    );
    assert.equal(result.undiscoveredBinary.length, 1);
    assert.match(result.undiscoveredBinary[0], /^crate\/Cargo\.toml: states a `\[\[test\]\]` stanza/); // prettier-ignore
    assert.match(result.undiscoveredBinary[0], /names a test target explicitly/);
    assert.match(result.undiscoveredBinary[0], /drop it and let auto-discovery select/);
    assert.deepEqual(result.mirrorDrift, []);
  });

  it('reds a `test =` target array, the same declaration written as a value', () => {
    // Cargo reads a ROOT-table `test` value as the array of tables the
    // `[[test]]` form spells, so a manifest writing it this way registers the
    // same targets — and passed this admission before the scan read the table
    // each key sits in.
    const manifest = ['test = [{ name = "hidden", path = "elsewhere/hidden.rs" }]', '', CARGO_MANIFEST].join('\n'); // prettier-ignore
    const result = admit(treeWithFiles([], { 'crate/Cargo.toml': manifest }));
    assert.equal(result.undiscoveredBinary.length, 1);
    assert.match(result.undiscoveredBinary[0], /states a `test =` target array/);
    assert.match(result.undiscoveredBinary[0], /naming its test targets explicitly/);
  });

  it('leaves each target key outside the one table Cargo reads it in', () => {
    // The two tables are disjoint, so the mirrored spellings are both green:
    // a `[package]` `test` is an unused manifest key that builds no target,
    // and a root-table `autotests` is an unused manifest key that changes no
    // binary. A scan admitting either table for either key would red a
    // manifest Cargo itself ignores.
    for (const manifest of [
      cargoManifest('test = [{ name = "hidden", path = "elsewhere/hidden.rs" }]'),
      ['autotests = false', '', CARGO_MANIFEST].join('\n'),
    ]) {
      const result = admit(
        treeWithFiles(['crate/tests/worker_pool_test.rs'], { 'crate/Cargo.toml': manifest }),
      );
      assert.deepEqual(formatProblems(result), [], manifest);
    }
  });

  it('reds a quoted spelling of the `[[test]]` header, which names the same table', () => {
    for (const header of ['[["test"]]', "[['test']]"]) {
      const result = admit(
        treeWithFiles([], {
          'crate/Cargo.toml': `${CARGO_MANIFEST}\n\n${header}\nname = "hidden"`,
        }),
      );
      assert.equal(result.undiscoveredBinary.length, 1, header);
      assert.match(result.undiscoveredBinary[0], /states a `\[\[test\]\]` stanza/, header);
    }
  });

  it('reds an `autotests` key, whichever value it carries', () => {
    for (const declaration of ['autotests = false', 'autotests=true']) {
      const result = admit(treeWithFiles([], { 'crate/Cargo.toml': cargoManifest(declaration) }));
      assert.equal(result.undiscoveredBinary.length, 1, declaration);
      assert.match(result.undiscoveredBinary[0], /states an `autotests` key/, declaration);
      // The consequence every manifest red states, whichever route raised it:
      // the deciding moved to the manifest. `autotests = true` is the edition
      // default and changes no binary, so a red claiming a changed set here
      // would be false of the very value this loop drives.
      assert.match(
        result.undiscoveredBinary[0],
        /which test binaries exist is then this manifest's to decide/,
        declaration,
      );
    }
  });

  it('leaves a `test` key another table declares to that table', () => {
    // `[features]` may name a feature `test`, and any table may carry a key
    // spelled like a target one — neither is Cargo's target selection, and a
    // scan blind to the table it is reading would red both.
    const manifest = [CARGO_MANIFEST, '', '[features]', 'test = []', '', '[dependencies]', 'autotests = "1"'].join('\n'); // prettier-ignore
    const result = admit(
      treeWithFiles(['crate/tests/worker_pool_test.rs'], { 'crate/Cargo.toml': manifest }),
    );
    assert.deepEqual(formatProblems(result), []);
  });

  it('resolves a dotted key onto the table its own segments name', () => {
    // A manifest may spell every table inline. `package.autotests` at the root
    // is the `[package]` key, turning discovery off exactly as the sectioned
    // spelling does — and passed this admission silently while the scan read
    // only the `[table]` header it sat under.
    const dotted = ['package.name = "crate"', 'package.autotests = false'].join('\n');
    const red = admit(treeWithFiles([], { 'crate/Cargo.toml': dotted }));
    assert.equal(red.undiscoveredBinary.length, 1);
    assert.match(red.undiscoveredBinary[0], /states an `autotests` key/);
    // The other direction: a dotted key resolving anywhere else names that
    // table's own key, not a target selection.
    const elsewhere = ['dependencies.autotests = "1"', '', CARGO_MANIFEST].join('\n');
    const green = admit(
      treeWithFiles(['crate/tests/worker_pool_test.rs'], { 'crate/Cargo.toml': elsewhere }),
    );
    assert.deepEqual(formatProblems(green), []);
  });

  it('reports each route once, and every route when a manifest states them all', () => {
    const all = [
      'test = [{ name = "declared" }]',
      '',
      cargoManifest('autotests = false'),
      '',
      '[[ test ]]',
      'name = "hidden"',
      '',
      '[[test]]',
      'name = "hidden-too"',
    ].join('\n');
    const result = admit(
      treeWithFiles(['crate/tests/nested/main.rs'], { 'crate/Cargo.toml': all }),
    );
    assert.equal(result.undiscoveredBinary.length, 4, 'three routes plus the tree route');
    assert.equal(formatProblems(result).length, 1, 'one block carries the whole class');
    assert.match(
      formatProblems(result)[0],
      /place\(s\) where the discovery step does not decide which test binaries exist/,
    );
    assert.match(formatProblems(result)[0], /widen the discovery on\n {2}purpose/);
  });

  it('reads a commented-out declaration as the comment it is', () => {
    const commented = [CARGO_MANIFEST, '# autotests = false', '# [[test]]'].join('\n');
    const result = admit(treeWithFiles([], { 'crate/Cargo.toml': commented }));
    assert.deepEqual(formatProblems(result), []);
  });

  it('refuses a crate manifest it cannot read, and still reports the path route', () => {
    const tree = cargoTree();
    delete tree['crate/Cargo.toml'];
    const result = closure(tree, {
      inventories: [CARGO_ENTRY],
      files: [...Object.keys(tree), 'crate/tests/nested/main.rs'],
    });
    assert.equal(result.unreadableClosure.length, 1);
    assert.match(result.unreadableClosure[0], /^crate\/Cargo\.toml: the crate manifest/);
    assert.match(result.unreadableClosure[0], /could not be read/);
    assert.equal(result.undiscoveredBinary.length, 1, 'the tree route is read on its own');
  });

  it('strips a TOML comment without letting a `#` inside a value truncate the line', () => {
    assert.equal(stripTomlComment('# [[test]]'), '');
    assert.equal(stripTomlComment('  autotests = false  # off'), 'autotests = false');
    assert.equal(stripTomlComment('description = "a # sign"'), 'description = "a # sign"');
    assert.equal(stripTomlComment("name = 'a # sign'"), "name = 'a # sign'");
    assert.equal(stripTomlComment('a = "he said \\"#\\"" # gone'), 'a = "he said \\"#\\""');
  });

  it('reads a manifest line as the header it opens, the key it assigns, or neither', () => {
    assert.deepEqual(readTomlLine('[[test]]'), { header: 'test', array: true });
    assert.deepEqual(readTomlLine('[[ "test" ]]'), { header: 'test', array: true });
    assert.deepEqual(readTomlLine('[package]'), { header: 'package', array: false });
    assert.deepEqual(readTomlLine("[target.'cfg(windows)'.dependencies]"), {
      header: 'target.cfg(windows).dependencies',
      array: false,
    });
    assert.deepEqual(readTomlLine('autotests=true'), { key: 'autotests', within: '' });
    assert.deepEqual(readTomlLine('"autotests" = true'), { key: 'autotests', within: '' });
    assert.deepEqual(readTomlLine('package.autotests = false'), {
      key: 'autotests',
      within: 'package',
    });
    // A `.` inside a quoted segment is that key's own, not a separator.
    assert.deepEqual(readTomlLine('"package.autotests" = false'), {
      key: 'package.autotests',
      within: '',
    });
    assert.equal(readTomlLine(''), null);
    assert.equal(readTomlLine('"Win32_Foundation",'), null);
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

describe('the mutation kill sets — reading the two list shapes', () => {
  const jsConfig = (...paths) =>
    `export default {\n  testRunner: 'command',\n  commandRunner: {\n    command: [\n      'node --test',\n${paths
      .map((p) => `      '${p}',\n`)
      .join('')}    ].join(' '),\n  },\n};\n`;

  it('reads a command list stated as a property array with a joining call', () => {
    assert.deepEqual(readPropertyStringArray(jsConfig('a.test.js', 'b.test.js'), 'command'), {
      entries: ['node --test', 'a.test.js', 'b.test.js'],
    });
  });

  it('is not fooled by the property name as a value or inside another word', () => {
    // `testRunner: 'command'` states the name as a string, and `commandRunner`
    // carries it as a prefix; neither declares the list.
    const source = "export default { testRunner: 'command', commandRunner: { x: 1 } };";
    assert.match(readPropertyStringArray(source, 'command').error, /no `command: \[\.\.\.\]`/);
  });

  it('accepts the joining call’s chain, the residue of modelling one call', () => {
    // The guard bounds the FIRST call after the literal, so a chained call
    // rides through: recorded at the guard site, and held here so the record
    // is executable rather than a claim about code nobody runs.
    assert.deepEqual(
      readPropertyStringArray("const a = { command: ['x'].join(' ') };", 'command'),
      {
        entries: ['x'],
      },
    );
    assert.deepEqual(
      readPropertyStringArray("const a = { command: ['x'].join(' ').concat(y) };", 'command'),
      { entries: ['x'] },
    );
    // What the guard does refuse, for contrast: a first call that is not the
    // joining one.
    assert.match(
      readPropertyStringArray("const a = { command: ['x'].filter(Boolean) };", 'command').error,
      /is followed by `\.`/,
    );
  });

  it('refuses a property stated twice, which literal states the list being an accident of order', () => {
    const source = "const a = { command: ['x'] }; const b = { command: ['y'] };";
    assert.match(readPropertyStringArray(source, 'command').error, /states `command: \[\.\.\.\]` 2 times/); // prettier-ignore
  });

  it('refuses an element form it does not model, an unclosed literal, and an empty one', () => {
    assert.match(
      readPropertyStringArray('const a = { command: [...others] };', 'command').error,
      /holds `\.`, which this reader does not model/,
    );
    assert.match(
      readPropertyStringArray("const a = { command: ['x', ['y']] };", 'command').error,
      /holds `\[`, which this reader does not model/,
    );
    assert.match(
      readPropertyStringArray("const a = { command: ['x',", 'command').error,
      /is never closed/,
    );
    assert.match(
      readPropertyStringArray('const a = { command: [] };', 'command').error,
      /holds no entries/,
    );
  });

  it('refuses a trailing call other than the join, which could change the set', () => {
    const filtered = "const a = { command: ['x'].filter(Boolean) };";
    assert.match(
      readPropertyStringArray(filtered, 'command').error,
      /is followed by `\.`, so the entries this reader read are not the list/,
    );
  });

  it('reads a bare literal a separator terminates, no joining call needed', () => {
    // The accept path beside the joined one: a list that ends at its record's
    // brace states its entries outright, so tightening the trailing-expression
    // refusal can never quietly start refusing it.
    assert.deepEqual(
      readPropertyStringArray("const a = { command: ['node --test', 'a.test.js'] };", 'command'),
      { entries: ['node --test', 'a.test.js'] },
    );
  });

  it('reads a root-table TOML array, comments and other tables left to themselves', () => {
    // Everything after a table header belongs to that table, so the root-table
    // assignment is the one before it; the commented-out spelling and the
    // `[features]` key of the same name are both left where they are.
    const source = [
      '# test_args = ["--test", "commented_out"]',
      'test_args = [',
      '  "--lib", # a trailing comment',
      '  "--test", "a_test",',
      ']',
      '',
      '[features]',
      'test_args = ["not_the_root_one"]',
    ].join('\n');
    assert.deepEqual(readTomlStringArray(source, 'test_args'), {
      values: ['--lib', '--test', 'a_test'],
    });
  });

  it('reads only the root-table key when another table states the same name', () => {
    const scoped = '[features]\ntest_args = ["not_the_root_one"]\n';
    assert.match(readTomlStringArray(scoped, 'test_args').error, /no root-table `test_args/);
  });

  it('refuses a missing key, a non-array value, an unclosed array, and an empty one', () => {
    assert.match(readTomlStringArray('other = 1\n', 'test_args').error, /no root-table `test_args/);
    assert.match(
      readTomlStringArray('test_args = "a"\n', 'test_args').error,
      /is assigned `"a"`, which is not the array literal this reader models/,
    );
    assert.match(readTomlStringArray('test_args = [\n  "a",\n', 'test_args').error, /never closed/);
    assert.match(readTomlStringArray('test_args = []\n', 'test_args').error, /holds no values/);
  });

  it('refuses a value form it does not model and an unterminated string', () => {
    assert.match(
      readTomlStringArray('test_args = [\n  42,\n]\n', 'test_args').error,
      /holds `4`, which this reader does not model/,
    );
    assert.match(
      readTomlStringArray('test_args = [\n  "a\n', 'test_args').error,
      /holds an unterminated string/,
    );
    assert.match(
      readTomlStringArray('test_args =\n', 'test_args').error,
      /is assigned `nothing`, which is not the array literal this reader models/,
    );
  });

  it('refuses a nested array rather than flattening its values into the list', () => {
    assert.match(
      readTomlStringArray('test_args = [\n  ["a"],\n]\n', 'test_args').error,
      /holds a nested array, which this reader does not model/,
    );
  });

  it('reads each TOML string form as TOML does: escapes in a basic string, none in a literal', () => {
    assert.deepEqual(readTomlStringArray('test_args = ["a\\"b"]\n', 'test_args'), {
      values: ['a"b'],
    });
    assert.deepEqual(readTomlStringArray("test_args = ['a\\b']\n", 'test_args'), {
      values: ['a\\b'],
    });
  });

  it('reads a dotted key as the table its own segments name, not as the root one', () => {
    const dotted = 'package.test_args = ["not_the_root_one"]\n';
    assert.match(readTomlStringArray(dotted, 'test_args').error, /no root-table `test_args/);
  });

  it('pairs each selecting flag with its target, valueless flags left alone', () => {
    assert.deepEqual(killSetTargets(['--lib', '--test', 'a_test', '--test', 'b_test'], '--test'), {
      targets: ['a_test', 'b_test'],
    });
  });

  it('pairs the joined spelling too, which cargo reads as the same selection', () => {
    assert.deepEqual(killSetTargets(['--lib', '--test=a_test', '--test', 'b_test'], '--test'), {
      targets: ['a_test', 'b_test'],
    });
    // The joined spelling carries its own value, so an empty one states no
    // target at all — the same refusal the split spelling raises.
    assert.match(killSetTargets(['--test='], '--test').error, /states `--test=` with no target after it/); // prettier-ignore
  });

  it('refuses a flag with no target, a value no flag claimed, and a list selecting nothing', () => {
    assert.match(killSetTargets(['--test'], '--test').error, /with no target after it/);
    assert.match(killSetTargets(['--test', '--lib'], '--test').error, /with no target after it/);
    assert.match(
      killSetTargets(['--features', 'windows', '--test', 'a_test'], '--test').error,
      /states `windows`, which this reader does not model/,
    );
    assert.match(killSetTargets(['--lib'], '--test').error, /states no `--test` entry/);
  });

  it('reads the mutate-scope table through the clause that carries it', () => {
    const doc = [
      '# Doc',
      '',
      '| Module | Note |',
      '| --- | --- |',
      '| `src/elsewhere.rs` | a table outside the clause |',
      '',
      '**XX-3.** The scope:',
      '',
      '| Module | What it carries |',
      '| --- | --- |',
      '| `src/a.rs` | a |',
      '| `src/b.rs` | b |',
      '',
      '**XX-4.** The next clause.',
      '',
      '| Module | Note |',
      '| --- | --- |',
      '| `src/after.rs` | a table after the clause |',
    ].join('\n');
    assert.deepEqual(readScopeTable(doc, 'XX-3', ['Module', 'What it carries']), {
      modules: ['src/a.rs', 'src/b.rs'],
    });
    // The clause also carries a `Module | Note` table in the fixture's other
    // clauses: whole-header selection is what leaves those to their own leg.
  });

  it('refuses a missing marker, a missing table, and a cell that is not a module path', () => {
    const doc =
      '**XX-3.** The scope:\n\n| Module | X |\n| --- | --- |\n| the `a.rs` module | a |\n';
    const header = ['Module', 'What it carries'];
    assert.match(readScopeTable('# Doc\n', 'XX-3', header).error, /states no `\*\*XX-3\.\*\*` marker/); // prettier-ignore
    assert.match(
      readScopeTable('**XX-3.** No table here.\n', 'XX-3', header).error,
      /states no table headed "Module" \| "What it carries" inside §XX-3/,
    );
    assert.match(
      readScopeTable(doc.replace('| Module | X |', '| Module | What it carries |'), 'XX-3', header).error, // prettier-ignore
      /whose first cell is not a single backticked module path/,
    );
  });
});

describe('auditMutationKillSets — staleness, agreement, and the refusals', () => {
  const SETS = {
    js: { glob: 'mutate.*.mjs', property: 'command' },
    rust: {
      config: 'crate/.cargo/mutants.toml',
      key: 'test_args',
      flag: '--test',
      dir: 'crate/tests',
      suffix: '.rs',
      main: 'main.rs',
    },
    scope: {
      config: 'crate/.cargo/mutants.toml',
      key: 'examine_globs',
      root: 'crate',
      doc: 'docs/mutation.md',
      clause: 'XX-3',
      header: ['Module', 'What it carries'],
    },
  };

  const jsConfig = (...paths) =>
    `export default { commandRunner: { command: ['node --test', ${paths
      .map((p) => `'${p}'`)
      .join(', ')}].join(' ') } };`;

  const manifest = ({ globs = ['src/a.rs'], binaries = ['a_test'] } = {}) =>
    [
      'examine_globs = [',
      ...globs.map((g) => `  "${g}",`),
      ']',
      '',
      'test_args = [',
      '  "--lib",',
      ...binaries.map((b) => `  "--test", "${b}",`),
      ']',
    ].join('\n');

  const scopeDoc = (modules = ['src/a.rs']) =>
    [
      '# Mutation',
      '',
      '**XX-3.** The scope is what the configuration lists:',
      '',
      '| Module | What it carries |',
      '| --- | --- |',
      ...modules.map((m) => `| \`${m}\` | prose |`),
      '',
      '**XX-4.** After the scope.',
    ].join('\n');

  const tree = (over = {}) => ({
    'mutate.desktop.mjs': jsConfig('pkg/tests/a.test.js'),
    'crate/.cargo/mutants.toml': manifest(),
    'docs/mutation.md': scopeDoc(),
    ...over,
  });

  const files = (source, extra = []) => [
    ...Object.keys(source),
    'pkg/tests/a.test.js',
    'crate/tests/a_test.rs',
    'crate/src/a.rs',
    ...extra,
  ];

  const killSets = (source, over = {}) =>
    auditMutationKillSets({
      files: over.files ?? files(source),
      readFile: (f) => (f in source ? source[f] : null),
      jsKillSets: SETS.js,
      rustKillSet: over.rustKillSet ?? SETS.rust,
      mutateScope: over.mutateScope ?? SETS.scope,
    });

  it('reports nothing when every listed entry is there and both surfaces state one scope', () => {
    const result = killSets(tree());
    assert.deepEqual(formatProblems(result), []);
  });

  it('flags a JavaScript entry naming a file that is not there, and says why it is silent', () => {
    const source = tree({
      'mutate.desktop.mjs': jsConfig('pkg/tests/a.test.js', 'pkg/tests/gone.test.js'),
    });
    assert.deepEqual(killSets(source).staleKillSetEntry, [
      'mutate.desktop.mjs: `command` names pkg/tests/gone.test.js, which is not a tracked file — the weekly mutation run drops it in silence, since `node --test` runs the paths it finds and reports nothing for the one it does not',
    ]);
  });

  it('flags a Rust entry naming a binary that is not there, naming the paths it looked at', () => {
    const source = tree({
      'crate/.cargo/mutants.toml': manifest({ binaries: ['a_test', 'renamed_test'] }),
    });
    assert.deepEqual(killSets(source).staleKillSetEntry, [
      'crate/.cargo/mutants.toml: `test_args` names `--test renamed_test`, which is no tracked binary at crate/tests/renamed_test.rs or at crate/tests/renamed_test/main.rs — cargo refuses a target that is not there, so the weekly run fails on it; this names it at lint time instead',
    ]);
  });

  it('resolves a target through either route Cargo builds a binary from', () => {
    // The directory form is a live binary, so a target living there is the
    // target it is — red only when neither route reaches it.
    const source = tree({ 'crate/.cargo/mutants.toml': manifest({ binaries: ['dir_test'] }) });
    const nested = killSets(source, {
      files: [...files(source), 'crate/tests/dir_test/main.rs'],
    });
    assert.deepEqual(nested.staleKillSetEntry, []);
    assert.deepEqual(killSets(source).staleKillSetEntry, [
      'crate/.cargo/mutants.toml: `test_args` names `--test dir_test`, which is no tracked binary at crate/tests/dir_test.rs or at crate/tests/dir_test/main.rs — cargo refuses a target that is not there, so the weekly run fails on it; this names it at lint time instead',
    ]);
  });

  it('holds a target the joined spelling names, exactly as it holds the split one', () => {
    const live = manifest().replace('"--test", "a_test",', '"--test=a_test",');
    assert.deepEqual(killSets(tree({ 'crate/.cargo/mutants.toml': live })).staleKillSetEntry, []);
    const dead = manifest().replace('"--test", "a_test",', '"--test=renamed_test",');
    assert.deepEqual(killSets(tree({ 'crate/.cargo/mutants.toml': dead })).staleKillSetEntry, [
      'crate/.cargo/mutants.toml: `test_args` names `--test renamed_test`, which is no tracked binary at crate/tests/renamed_test.rs or at crate/tests/renamed_test/main.rs — cargo refuses a target that is not there, so the weekly run fails on it; this names it at lint time instead',
    ]);
  });

  it('accepts a glob argument that selects tracked files — the runner expands it', () => {
    const source = tree({ 'mutate.desktop.mjs': jsConfig('pkg/tests/*.test.js') });
    assert.deepEqual(killSets(source).staleKillSetEntry, []);
  });

  it('reds a glob argument selecting nothing, without the dead-literal explanation', () => {
    const source = tree({ 'mutate.desktop.mjs': jsConfig('pkg/tests/*.spec.js') });
    assert.deepEqual(killSets(source).staleKillSetEntry, [
      'mutate.desktop.mjs: `command` states the glob pkg/tests/*.spec.js, which selects no tracked file — the runner expands it against the tree, so the weekly mutation run takes no test from this entry',
    ]);
  });

  it('refuses an argument that globs across directories, which no membership rule models', () => {
    const source = tree({ 'mutate.desktop.mjs': jsConfig('pkg/*/a.test.js') });
    assert.deepEqual(killSets(source).unreadableKillSet, [
      'mutate.desktop.mjs: its `command` globs across directories in `pkg/*/a.test.js`, which this reader does not model',
    ]);
  });

  it('discovers every configuration the glob names, so a new one joins by existing', () => {
    const source = tree({ 'mutate.shared.mjs': jsConfig('pkg/tests/nowhere.test.js') });
    assert.deepEqual(killSets(source).staleKillSetEntry, [
      'mutate.shared.mjs: `command` names pkg/tests/nowhere.test.js, which is not a tracked file — the weekly mutation run drops it in silence, since `node --test` runs the paths it finds and reports nothing for the one it does not',
    ]);
  });

  it('flags a module the configuration mutates that the document does not state', () => {
    const source = tree({ 'crate/.cargo/mutants.toml': manifest({ globs: ['src/a.rs', 'src/b.rs'] }) }); // prettier-ignore
    assert.deepEqual(killSets(source).mutateScopeDrift, [
      '`src/b.rs` is in `examine_globs` in crate/.cargo/mutants.toml but has no row in docs/mutation.md §XX-3',
    ]);
  });

  it('flags a module the document states that the configuration does not mutate', () => {
    const source = tree({ 'docs/mutation.md': scopeDoc(['src/a.rs', 'src/stale.rs']) });
    assert.deepEqual(killSets(source).mutateScopeDrift, [
      '`src/stale.rs` is a row of docs/mutation.md §XX-3 but is not in `examine_globs` in crate/.cargo/mutants.toml',
    ]);
  });

  it('flags a module the document states twice — the drift a set diff cannot see', () => {
    const source = tree({ 'docs/mutation.md': scopeDoc(['src/a.rs', 'src/a.rs']) });
    assert.deepEqual(killSets(source).mutateScopeDrift, [
      '`src/a.rs` appears more than once in docs/mutation.md §XX-3',
    ]);
  });

  it('flags a module the configuration states twice — both statements read alike', () => {
    const source = tree({
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/a.rs', 'src/a.rs'] }),
    });
    assert.deepEqual(killSets(source).mutateScopeDrift, [
      '`src/a.rs` appears more than once in `examine_globs` in crate/.cargo/mutants.toml',
    ]);
  });

  it('reds a module both surfaces agree on that the tree does not carry', () => {
    // The two surfaces edited in step agree with each other about a module
    // nothing mutates, which the agreement diff between them cannot see.
    const agreed = tree({
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/a.rs', 'src/gone.rs'] }),
      'docs/mutation.md': scopeDoc(['src/a.rs', 'src/gone.rs']),
    });
    const result = killSets(agreed);
    assert.deepEqual(result.mutateScopeDrift, []);
    assert.deepEqual(result.deadScopeModule, [
      'crate/.cargo/mutants.toml: `examine_globs` names src/gone.rs, which is no tracked source at crate/src/gone.rs — both this configuration and docs/mutation.md §XX-3 state it',
    ]);
    // Stated by the configuration alone, the line says so and the agreement
    // diff answers for the missing row separately.
    const oneSided = tree({
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/a.rs', 'src/gone.rs'] }),
    });
    assert.deepEqual(killSets(oneSided).deadScopeModule, [
      'crate/.cargo/mutants.toml: `examine_globs` names src/gone.rs, which is no tracked source at crate/src/gone.rs — this configuration states it',
    ]);
  });

  it('holds a pattern entry to selecting a source, naming the form when it selects none', () => {
    const selecting = tree({
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/*.rs'] }),
      'docs/mutation.md': scopeDoc(['src/*.rs']),
    });
    assert.deepEqual(killSets(selecting).deadScopeModule, []);
    const empty = tree({
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/capture/*.rs'] }),
      'docs/mutation.md': scopeDoc(['src/capture/*.rs']),
    });
    assert.deepEqual(killSets(empty).deadScopeModule, [
      'crate/.cargo/mutants.toml: `examine_globs` states the pattern src/capture/*.rs, which selects no tracked source under crate/ — both this configuration and docs/mutation.md §XX-3 state it',
    ]);
  });

  it('reads each declared source at its own path, so a refusal names the file it opened', () => {
    // The scope config and the kill-set config are two declared paths: reading
    // the scope out of the neighbour's content would refuse a file this audit
    // never opened, and diff a list it never read.
    const source = tree();
    const apart = { ...SETS.scope, config: 'crate/.cargo/scope.toml' };
    const result = killSets(source, { mutateScope: apart });
    assert.deepEqual(result.unreadableKillSet, [
      'crate/.cargo/scope.toml: the mutate scope this leg reads could not be read',
    ]);
    assert.deepEqual(result.mutateScopeDrift, []);
    assert.deepEqual(result.staleKillSetEntry, []);
  });

  it('diffs the scope against the list in the file it names, not one it already read', () => {
    const source = {
      ...tree({ 'docs/mutation.md': scopeDoc(['src/z.rs']) }),
      'crate/.cargo/scope.toml': 'examine_globs = [\n  "src/z.rs",\n]\n',
    };
    const result = killSets(source, {
      files: [...files(source), 'crate/src/z.rs'],
      mutateScope: { ...SETS.scope, config: 'crate/.cargo/scope.toml' },
    });
    assert.deepEqual(result.mutateScopeDrift, []);
    assert.deepEqual(result.deadScopeModule, []);
    assert.deepEqual(result.unreadableKillSet, []);
  });

  it('refuses a tree the glob discovers no configuration in', () => {
    const source = { 'crate/.cargo/mutants.toml': manifest(), 'docs/mutation.md': scopeDoc() };
    assert.deepEqual(killSets(source).unreadableKillSet, [
      'no tracked file matches `mutate.*.mjs`, so the JavaScript kill sets this leg holds are not where it reads them',
    ]);
  });

  it('refuses a configuration it cannot read, and one whose list it cannot find', () => {
    const unreadable = killSets(tree(), {
      files: [...files(tree()), 'mutate.gone.mjs'],
    });
    assert.ok(
      unreadable.unreadableKillSet.includes(
        'mutate.gone.mjs: mutation configuration could not be read',
      ),
    );
    const renamed = killSets(tree({ 'mutate.desktop.mjs': 'export default { commandRunner: {} };' })); // prettier-ignore
    assert.deepEqual(renamed.unreadableKillSet, [
      'mutate.desktop.mjs: no `command: [...]` array literal found',
    ]);
  });

  it('refuses a command list that states no runner invocation, and one it cannot resolve', () => {
    const noRunner = killSets(
      tree({ 'mutate.desktop.mjs': "export default { commandRunner: { command: ['vitest run'] } };" }), // prettier-ignore
    );
    assert.deepEqual(noRunner.unreadableKillSet, [
      'mutate.desktop.mjs: its `command` states no `node --test` invocation, so the kill set this leg holds is not where it reads it',
    ]);
    const relocated = killSets(
      tree({ 'mutate.desktop.mjs': jsConfig('a.test.js').replace('node --test', 'cd pkg && node --test') }), // prettier-ignore
    );
    assert.match(relocated.unreadableKillSet[0], /its `command` runs `node --test` in a directory a `cd` moved/); // prettier-ignore
  });

  it('refuses a cargo configuration it cannot read, both lists at once', () => {
    const source = { 'mutate.desktop.mjs': jsConfig('pkg/tests/a.test.js'), 'docs/mutation.md': scopeDoc() }; // prettier-ignore
    const result = killSets(source, { files: [...Object.keys(source), 'pkg/tests/a.test.js'] });
    assert.deepEqual(result.unreadableKillSet, [
      'crate/.cargo/mutants.toml: the mutation configuration this leg reads could not be read',
      'crate/.cargo/mutants.toml: the mutate scope this leg reads could not be read',
    ]);
    assert.deepEqual(result.mutateScopeDrift, []);
  });

  it('refuses a document it cannot read, and holds no scope against half a pair', () => {
    const source = tree();
    delete source['docs/mutation.md'];
    const result = killSets(source, { files: files(tree()) });
    assert.deepEqual(result.unreadableKillSet, [
      'docs/mutation.md: the document stating the mutate scope could not be read',
    ]);
    assert.deepEqual(result.mutateScopeDrift, []);
  });

  it('refuses each list of a readable manifest it cannot read as a list, separately', () => {
    // The two lists answer for themselves: the kill set and the mutate scope
    // are read from the same file, and one being unreadable says nothing about
    // the other.
    const source = tree({
      'crate/.cargo/mutants.toml': 'examine_globs = 3\ntest_args = "a"\n',
    });
    assert.deepEqual(killSets(source).unreadableKillSet, [
      'crate/.cargo/mutants.toml: `test_args` is assigned `"a"`, which is not the array literal this reader models',
      'crate/.cargo/mutants.toml: `examine_globs` is assigned `3`, which is not the array literal this reader models',
    ]);
  });

  it('refuses a document whose scope table is not where this leg reads it', () => {
    const source = tree({ 'docs/mutation.md': '# Mutation\n\n**XX-3.** No table here.\n' });
    assert.deepEqual(killSets(source).unreadableKillSet, [
      'docs/mutation.md: states no table headed "Module" | "What it carries" inside §XX-3, where this leg reads the mutate scope',
    ]);
    assert.deepEqual(killSets(source).mutateScopeDrift, []);
  });

  it('refuses a kill set that states one entry twice, on the projection each list states', () => {
    // The Rust flip reads the `--test` TARGETS, never the raw argument list:
    // the flag itself repeats once per target by the grammar of a cargo
    // argument list, so a raw-list reading would red every healthy tree.
    const source = tree({
      'crate/.cargo/mutants.toml': manifest({ binaries: ['a_test', 'a_test'] }),
      'mutate.desktop.mjs': jsConfig('pkg/tests/a.test.js', 'pkg/tests/a.test.js'),
    });
    const result = killSets(source);
    assert.deepEqual(result.duplicatedEntry, [
      '`pkg/tests/a.test.js` appears more than once in `command`\'s `node --test` arguments in mutate.desktop.mjs', // prettier-ignore
      "`a_test` appears more than once in `test_args`'s `--test` targets in crate/.cargo/mutants.toml",
    ]);
    // Both entries name tracked binaries: the repeat is the whole finding.
    assert.deepEqual(result.staleKillSetEntry, []);
  });

  it('reads the raw argument list without refusing the repeated flag token', () => {
    // The control for the projection: `--test` appears once per target, and a
    // healthy configuration must stay green with it.
    const result = killSets(tree({
      'crate/.cargo/mutants.toml': manifest({ binaries: ['a_test', 'b_test'] }),
    })); // prettier-ignore
    assert.deepEqual(result.duplicatedEntry, []);
  });

  it('refuses a kill-set list whose entries it cannot pair, naming the list', () => {
    const source = tree({
      'crate/.cargo/mutants.toml': manifest().replace('"--lib",', '"--features", "windows",'),
    });
    assert.match(
      killSets(source).unreadableKillSet[0],
      /`test_args` states `windows`, which this reader does not model/,
    );
  });

  it('formats every populated problem class this audit reports', () => {
    // The shape states the classes, and the block count is read from it: a class
    // added to the audit without a wording here reds as a count, rather than
    // sliding past positional matches written against yesterday's list.
    const shape = {
      staleKillSetEntry: ['an entry'],
      mutateScopeDrift: ['a module'],
      deadScopeModule: ['a module'],
      unreadableKillSet: ['a source'],
    };
    const blocks = formatProblems(shape);
    assert.equal(blocks.length, Object.keys(shape).length);
    const block = (name) => blocks[Object.keys(shape).indexOf(name)];
    // One heading over both entry kinds: a dead literal names a file that is
    // not there, and a glob names a set with nothing in it.
    assert.match(block('staleKillSetEntry'), /name no test file that is there[\s\S]*Fix: repoint each entry/); // prettier-ignore
    // One heading over both kinds this class aggregates: a disagreement
    // between the surfaces, and a module one surface states twice.
    assert.match(
      block('mutateScopeDrift'),
      /stated by one surface and not the other, or stated twice by one[\s\S]*Fix: state the scope/,
    );
    assert.match(block('deadScopeModule'), /name no source the tree carries[\s\S]*Fix: repoint each entry/); // prettier-ignore
    // The refusal block carries both surfaces, so its heading names both: a
    // scope-table refusal routed under a kill-set headline would send a reader
    // to the wrong file.
    assert.match(
      block('unreadableKillSet'),
      /mutation kill-set or mutate-scope source\(s\) could not be read as what they state[\s\S]*Fix: restore the shape/,
    );
  });
});

describe('pathGlobToRegExp — the mutate patterns’ own glob dialect', () => {
  const matches = (pattern, path) => {
    const compiled = pathGlobToRegExp(pattern);
    assert.equal(compiled.error, undefined, compiled.error);
    return compiled.regex.test(path);
  };

  it('crosses directories on a whole `**` segment and stays inside one on `*`', () => {
    assert.ok(matches('packages/shared/lib/**/*.js', 'packages/shared/lib/session.js'));
    assert.ok(matches('packages/shared/lib/**/*.js', 'packages/shared/lib/deep/session.js'));
    assert.ok(!matches('packages/shared/lib/*.js', 'packages/shared/lib/deep/session.js'));
    assert.ok(matches('packages/shared/sync-client.js', 'packages/shared/sync-client.js'));
  });

  it('answers with a refusal rather than throwing on syntax it does not model', () => {
    // The one difference from the area map's own compiler: a pattern this
    // reader cannot take has to red in the middle of a run, not abort it.
    for (const pattern of ['packages/**.js', 'packages/{a,b}/x.js', 'packages/?.js']) {
      const compiled = pathGlobToRegExp(pattern);
      assert.equal(compiled.regex, undefined, pattern);
      assert.ok(compiled.error, pattern);
    }
  });
});

describe('importSpecifiers — literal edges, and the one silence beside them', () => {
  it('reads the re-exporting `export … from` form as an edge, and a local export as none', () => {
    // A barrel is a real edge: a surface reaching a mutated module through one
    // classifies as reaching it, where a walk blind to the form would place the
    // surface outside every kill set with nothing red anywhere.
    const read = importSpecifiers(
      [
        "export { a } from './named.js';",
        "export * from './star.js';",
        "export * as ns from './namespace.js';",
        'export const local = 1;',
        'export { local };',
        'export default local;',
      ].join('\n'),
    );
    assert.deepEqual(read.literal, ['./named.js', './star.js', './namespace.js']);
    assert.equal(read.computed, 0);
  });

  it('reads static and dynamic literal specifiers alike', () => {
    const read = importSpecifiers(
      [
        "import assert from 'node:assert/strict';",
        "import { a, b as c } from './a.js';",
        "import './side-effect.js';",
        "const m = await import('./dynamic.js');",
      ].join('\n'),
    );
    assert.deepEqual(read.literal, [
      'node:assert/strict',
      './a.js',
      './side-effect.js',
      './dynamic.js',
    ]);
    assert.equal(read.computed, 0);
  });

  it('counts a computed dynamic import as a non-edge rather than reading past it', () => {
    const read = importSpecifiers('const m = await import(pathToFileURL(file).href);\n');
    assert.deepEqual(read.literal, []);
    assert.equal(read.computed, 1);
  });

  it('never reads a JSDoc `import()` annotation as an edge, and passes over `import.meta`', () => {
    const read = importSpecifiers(
      [
        '/**',
        " * @typedef {import('./types.js').Thing} Thing",
        ' */',
        "import { real } from './real.js';",
        'const here = import.meta.dirname;',
      ].join('\n'),
    );
    assert.deepEqual(read.literal, ['./real.js']);
    assert.equal(read.computed, 0);
  });
});

describe('stripRustComments — the Rust view, in the shared-primitive home', () => {
  it('blanks line and nested block comments while keeping every offset', () => {
    const source = 'use a::b; // use commented::out;\n/* outer /* inner */ still */ use c::d;\n';
    const view = stripRustComments(source);
    assert.equal(view.length, source.length);
    assert.ok(view.includes('use a::b;') && view.includes('use c::d;'));
    assert.ok(!view.includes('commented') && !view.includes('inner'));
  });

  it('leaves a comment marker inside a string literal standing', () => {
    assert.ok(stripRustComments('let s = "not // a comment";\n').includes('not // a comment'));
  });
});

describe('reachableFiles — the walk, breadth-first over the followed class', () => {
  it('collects the transitive in-package reach and reports each refusal by name', () => {
    const tracked = new Set([
      'packages/pkg/tests/unit/a.test.js',
      'packages/pkg/src/a.js',
      'packages/pkg/src/deep.js',
      'scripts/tool.js',
    ]);
    const stated = {
      'packages/pkg/tests/unit/a.test.js': {
        literal: ['../../src/a.js', '../../../../scripts/tool.js', 'node:assert/strict'],
        computed: 0,
      },
      'packages/pkg/src/a.js': { literal: ['./deep.js', './gone.js'], computed: 0 },
      'packages/pkg/src/deep.js': { literal: [], computed: 0 },
    };
    const walk = reachableFiles('packages/pkg/tests/unit/a.test.js', {
      tracked,
      specifiers: (f) => stated[f] ?? null,
    });
    assert.deepEqual([...walk.reached].sort(), [
      'packages/pkg/src/a.js',
      'packages/pkg/src/deep.js',
      'packages/pkg/tests/unit/a.test.js',
    ]);
    // The out-of-package file was terminated, not followed — confinement has
    // precedence over the terminated classes.
    assert.ok(!walk.reached.has('scripts/tool.js'));
    assert.equal(walk.refusals.length, 1);
    assert.match(walk.refusals[0], /packages\/pkg\/src\/gone\.js/);
  });
});

describe('classifySpecifier — the classification is total by construction', () => {
  const FROM = 'packages/pkg/tests/unit/a.test.js';
  const tracked = new Set([FROM, 'packages/pkg/src/a.js', 'scripts/tool.js']);
  const classOf = (specifier) => classifySpecifier(specifier, FROM, tracked).class;

  it('reads a bare specifier as the dependency class, terminated by definition', () => {
    assert.equal(classOf('node:assert/strict'), SPECIFIER_CLASSES.dependency);
    assert.equal(classOf('fast-check'), SPECIFIER_CLASSES.dependency);
  });

  it('follows a tracked file of the surface’s own package, and only that class', () => {
    assert.equal(classOf('../../src/a.js'), SPECIFIER_CLASSES.followed);
  });

  it('terminates a tracked file outside the package, the synced copy, and the generated validator', () => {
    assert.equal(classOf('../../../../scripts/tool.js'), SPECIFIER_CLASSES.outOfPackage);
    assert.equal(classOf('../../shared/lib/session.js'), SPECIFIER_CLASSES.syncedShared);
    assert.equal(classOf('../../shared/generated/validate.js'), SPECIFIER_CLASSES.generated);
    assert.equal(
      classifySpecifier('../../shared/generated/validate.js', 'packages/pkg/src/a.js', tracked)
        .class,
      SPECIFIER_CLASSES.generated,
    );
  });

  it('refuses a relative specifier that falls into no class, naming where it resolved', () => {
    const read = classifySpecifier('../../src/gone.js', FROM, tracked);
    assert.equal(read.class, SPECIFIER_CLASSES.unresolved);
    assert.equal(read.path, 'packages/pkg/src/gone.js');
  });

  it('resolves by path shape, never by disk state — the same answer in every checkout', () => {
    // The tracked set decides only the followed/out-of-package split; the
    // terminated shapes answer without consulting it at all.
    const empty = new Set();
    assert.equal(
      classifySpecifier('../../shared/lib/session.js', FROM, empty).class,
      SPECIFIER_CLASSES.syncedShared,
    );
  });
});

describe('classifyTestSurface — declared class first, then content', () => {
  const CASE = (body) => `it('a case', () => { ${body} });`;
  const runner = `import fc from '${JS_MEMBERSHIP.propertyRunner}';\n`;

  it('takes a `*.property.test.js` file by its own declaration, plain cases and all', () => {
    const read = classifyTestSurface(
      'packages/pkg/tests/unit/thing.property.test.js',
      `${runner}${CASE('assert.ok(true);')}`,
    );
    assert.equal(read.kind, 'declared');
  });

  it('excludes a file outside the class whose every case drives the unseeded runner', () => {
    const read = classifyTestSurface(
      'packages/pkg/tests/unit/thing.test.js',
      `${runner}${CASE('fc.assert(fc.property(fc.integer(), (n) => n === n));')}`,
    );
    assert.equal(read.kind, 'all-property');
    assert.equal(read.cases, read.property);
  });

  it('admits a mixed file on its plain cases, and states the residue it accepts', () => {
    const read = classifyTestSurface(
      'packages/pkg/tests/unit/thing.test.js',
      `${runner}${CASE('fc.assert(fc.property(fc.integer(), (n) => n === n));')}\n${CASE('assert.ok(true);')}`,
    );
    assert.equal(read.kind, 'mixed');
    assert.equal(read.property, 1);
    assert.equal(read.cases, 2);
  });

  it('reads a member call as declaring no case, the way the registry’s reader does', () => {
    const read = classifyTestSurface(
      'packages/pkg/tests/unit/thing.test.js',
      `it.skip('skipped', () => {});\nother.it('foreign', () => {});\n${CASE('assert.ok(true);')}`,
    );
    assert.equal(read.kind, 'plain');
    assert.equal(read.cases, 1);
  });

  it('refuses a surface stating no case, and one importing the runner it cannot bind', () => {
    assert.ok(classifyTestSurface('packages/pkg/tests/unit/a.test.js', 'const x = 1;\n').error);
    const unbound = classifyTestSurface(
      'packages/pkg/tests/unit/a.test.js',
      `import { assert as check } from '${JS_MEMBERSHIP.propertyRunner}';\n${CASE('check();')}`,
    );
    assert.ok(unbound.error?.includes('cannot bind'), unbound.error);
  });
});

describe('the Rust reading — use edges, containment, and the crate root', () => {
  it('reads each `use` declaration on a comment-stripped view and counts re-exports', () => {
    const read = rustUseTargets(
      [
        '//! doc: unlike the enigo suite next door',
        '// use commented::out;',
        'use lib::capture::scroll::{a, b};',
        'pub use lib::capture::timing;',
      ].join('\n'),
    );
    assert.deepEqual(read.targets, [
      'lib::capture::scroll',
      'lib::capture::scroll::a',
      'lib::capture::scroll::b',
    ]);
    assert.equal(read.reexports, 1);
    assert.ok(!read.targets.some((t) => t.includes('commented')));
  });

  it('reads a `use` written inside a string literal as the text it is', () => {
    // The view is comment-stripped AND string-blanked: a declaration a source
    // merely quotes is neither an edge nor the re-export that refuses the
    // whole Rust relation.
    const read = rustUseTargets(
      [
        'use fixture_lib::a::a;',
        'const FIXTURE: &str = "',
        'use fixture_lib::quoted::thing;',
        'pub use crate::quoted::thing;',
        '";',
        'const RAW: &str = r#" use fixture_lib::raw::thing; "#;',
      ].join('\n'),
    );
    assert.deepEqual(read.targets, ['fixture_lib::a::a']);
    assert.equal(read.reexports, 0);
  });

  it('takes a brace group’s prefix and each item, dropping a rename and a glob', () => {
    assert.deepEqual(useTargets('super::x as y'), ['super::x']);
    assert.deepEqual(useTargets('super::*'), ['super']);
    assert.deepEqual(useTargets('a::{b, c::d}'), ['a', 'a::b', 'a::c::d']);
  });

  const modules = new Map([
    ['', 'crate/src/lib.rs'],
    ['capture', 'crate/src/capture/mod.rs'],
    ['capture::scroll', 'crate/src/capture/scroll.rs'],
    ['commands', 'crate/src/commands.rs'],
  ]);
  const how = { roots: ['crate', 'fixture_lib'], modules };

  it('resolves a crate-rooted path by the longest prefix the tree carries a module for', () => {
    assert.equal(resolveUsePath('fixture_lib::capture::scroll::Acc', null, how), 'crate/src/capture/scroll.rs'); // prettier-ignore
    assert.equal(resolveUsePath('fixture_lib::capture::Event', null, how), 'crate/src/capture/mod.rs'); // prettier-ignore
    assert.equal(resolveUsePath('fixture_lib::Thing', null, how), 'crate/src/lib.rs');
  });

  it('resolves `super` and `self` against the module stating them', () => {
    const from = ['capture', 'scroll'];
    assert.equal(resolveUsePath('super::timing', from, how), 'crate/src/capture/mod.rs');
    assert.equal(resolveUsePath('self::inner', from, how), 'crate/src/capture/scroll.rs');
    assert.equal(resolveUsePath('super::super::commands', from, how), 'crate/src/commands.rs');
  });

  it('reads a uniform path only where its first segment names a crate module', () => {
    // Every external crate's path has the same shape, so resolving one down to
    // the crate root would claim them all.
    assert.equal(resolveUsePath('commands::AppState', [], how), 'crate/src/commands.rs');
    assert.equal(resolveUsePath('windows::Win32::Foundation::HWND', [], how), null);
    assert.equal(resolveUsePath('std::sync::mpsc', ['capture'], how), null);
  });

  it('reaches nothing of the crate from a test binary except through the library name', () => {
    assert.equal(resolveUsePath('super::*', null, how), null);
    assert.equal(resolveUsePath('crate::capture', null, how), 'crate/src/capture/mod.rs');
  });

  it('reads the crate library name, and derives it from the package name otherwise', () => {
    assert.deepEqual(crateLibraryName('[package]\nname = "a-b"\n\n[lib]\nname = "c_d"\n'), { name: 'c_d' }); // prettier-ignore
    assert.deepEqual(crateLibraryName('[package]\nname = "a-b"\n'), { name: 'a_b' });
    assert.ok(crateLibraryName('[dependencies]\nserde = "1"\n').error);
  });
});

describe('auditKillSetMembership — the criterion, both legs and both engines', () => {
  const SETS = {
    js: { glob: 'mutate.*.mjs', property: 'command' },
    rust: {
      config: 'crate/.cargo/mutants.toml',
      key: 'test_args',
      flag: '--test',
      dir: 'crate/tests',
      suffix: '.rs',
      main: 'main.rs',
    },
    scope: { config: 'crate/.cargo/mutants.toml', key: 'examine_globs', root: 'crate' },
    rustShape: { ...RUST_MEMBERSHIP, manifest: 'crate/Cargo.toml' },
  };

  const INVENTORIES = [
    registered({
      doc: 'docs/unit.md',
      section: 'S',
      header: ['Test file', 'Covers'],
      dir: 'packages/pkg/tests/unit',
      discovery: { runner: RUNNERS.node, pattern: '*.test.js' },
    }),
    registered({
      doc: 'docs/rust.md',
      section: 'S',
      header: ['Test file', 'Covers'],
      dir: 'crate/tests',
      discovery: {
        runner: RUNNERS.cargo,
        workflow: '.github/workflows/w.yml',
        step: 'Discover',
        glob: 'tests/*.rs',
        manifest: 'crate/Cargo.toml',
      },
    }),
  ];

  const jsConfig = ({ mutate = ['packages/pkg/src/**/*.js'], tests = ['a.test.js'] } = {}) =>
    `export default {\n  mutate: [${mutate.map((m) => `'${m}'`).join(', ')}],\n  commandRunner: { command: ['node --test', ${tests
      .map((t) => `'packages/pkg/tests/unit/${t}'`)
      .join(', ')}].join(' ') },\n};`;

  const testFile = (body) => `import { describe, it } from 'node:test';\n${body}\nit('a case', () => {});\n`; // prettier-ignore

  const manifest = ({ globs = ['src/a.rs'], binaries = ['a_test'], lib = true } = {}) =>
    [
      'examine_globs = [',
      ...globs.map((g) => `  "${g}",`),
      ']',
      '',
      'test_args = [',
      ...(lib ? ['  "--lib",'] : []),
      ...binaries.map((b) => `  "--test", "${b}",`),
      ']',
    ].join('\n');

  const BASE = {
    'mutate.pkg.mjs': jsConfig(),
    'packages/pkg/src/a.js': 'export const a = 1;\n',
    'packages/pkg/tests/unit/a.test.js': testFile("import { a } from '../../src/a.js';"),
    'crate/Cargo.toml': '[package]\nname = "fixture"\n\n[lib]\nname = "fixture_lib"\n',
    'crate/src/lib.rs': 'pub mod a;\n',
    'crate/src/a.rs': 'pub fn a() {}\n',
    'crate/tests/a_test.rs': 'use fixture_lib::a::a;\n',
    'crate/.cargo/mutants.toml': manifest(),
  };

  const membership = (over = {}, options = {}) => {
    const source = { ...BASE, ...over };
    for (const gone of options.remove ?? []) delete source[gone];
    return auditKillSetMembership({
      files: options.files ?? Object.keys(source),
      readFile: (f) => (f in source ? source[f] : null),
      jsKillSets: SETS.js,
      rustKillSet: SETS.rust,
      mutateScope: SETS.scope,
      rustMembership: SETS.rustShape,
      allowlist: options.allowlist ?? [],
      inventories: INVENTORIES,
    });
  };

  it('reports nothing when each list states exactly what the criterion places in it', () => {
    assert.deepEqual(formatProblems(membership()), []);
  });

  it('reds an unlisted reaching JavaScript surface, naming the file and the configuration', () => {
    const result = membership({
      'packages/pkg/tests/unit/b.test.js': testFile("import { a } from '../../src/a.js';"),
    });
    assert.equal(result.unlistedMember.length, 1);
    assert.match(result.unlistedMember[0], /packages\/pkg\/tests\/unit\/b\.test\.js/);
    assert.match(result.unlistedMember[0], /mutate\.pkg\.mjs/);
  });

  it('reds a listed surface that reaches no mutated module, with the reason', () => {
    const result = membership({
      'mutate.pkg.mjs': jsConfig({ tests: ['a.test.js', 'b.test.js'] }),
      'packages/pkg/tests/unit/b.test.js': testFile("import assert from 'node:assert/strict';"),
    });
    assert.equal(result.listedNonMember.length, 1);
    assert.match(result.listedNonMember[0], /b\.test\.js, which reaches no module/);
  });

  it('reds a LISTED declared property suite in the same direction', () => {
    const result = membership({
      'mutate.pkg.mjs': jsConfig({ tests: ['a.test.js', 'b.property.test.js'] }),
      'packages/pkg/tests/unit/b.property.test.js': testFile("import { a } from '../../src/a.js';"),
    });
    assert.equal(result.listedNonMember.length, 1);
    assert.match(result.listedNonMember[0], /declares itself a property suite/);
  });

  it('the precedence pair: a declared property suite with plain cases stays out, a mixed file stays in', () => {
    const runner = `import fc from '${JS_MEMBERSHIP.propertyRunner}';`;
    const result = membership({
      // Declared class, plain cases and all — never a member, so leaving it
      // unlisted is silent.
      'packages/pkg/tests/unit/declared.property.test.js': testFile(
        `${runner}\nimport { a } from '../../src/a.js';`,
      ),
      // Outside the class, property cases beside plain ones — admitted, so its
      // absence from the list reds.
      'packages/pkg/tests/unit/mixed.test.js': [
        `import fc from '${JS_MEMBERSHIP.propertyRunner}';`,
        "import { a } from '../../src/a.js';",
        "it('property', () => { fc.assert(fc.property(fc.integer(), (n) => n === n)); });",
        "it('plain', () => {});",
      ].join('\n'),
    });
    assert.deepEqual(
      result.unlistedMember.map((p) => p.split(' ')[0]),
      ['packages/pkg/tests/unit/mixed.test.js'],
    );
    assert.deepEqual(result.admittedMixed['mutate.pkg.mjs'], [
      'packages/pkg/tests/unit/mixed.test.js',
    ]);
  });

  it('follows a dynamic literal `import()` edge and stops at a computed one', () => {
    const reaching = membership({
      'packages/pkg/tests/unit/b.test.js': testFile("const m = await import('../../src/a.js');"),
    });
    assert.equal(reaching.unlistedMember.length, 1);
    const computed = membership({
      'mutate.pkg.mjs': jsConfig({ tests: ['a.test.js', 'b.test.js'] }),
      'packages/pkg/tests/unit/b.test.js': testFile('const m = await import(url);'),
    });
    assert.match(computed.listedNonMember[0], /b\.test\.js, which reaches no module/);
  });

  it('walks transitively, and confines the walk to the surface’s own package', () => {
    const result = membership({
      'packages/pkg/src/a.js': "export * from './deep.js';\nimport './deep.js';\n",
      'packages/pkg/src/deep.js': 'export const deep = 1;\n',
      'mutate.pkg.mjs': jsConfig({ mutate: ['packages/pkg/src/deep.js'] }),
    });
    // a.test.js reaches src/a.js, which reaches src/deep.js — the mutated one.
    assert.deepEqual(result.unlistedMember, []);
    assert.deepEqual(result.listedNonMember, []);
  });

  it('refuses a relative specifier that resolves into no class the walk models', () => {
    const result = membership({
      'packages/pkg/tests/unit/a.test.js': testFile("import { x } from '../../src/gone.js';"),
    });
    assert.ok(
      result.unreadableMembership.some((p) => p.includes('packages/pkg/src/gone.js')),
      result.unreadableMembership.join('\n'),
    );
  });

  it('reds a mutate-scope module no listed surface reaches, and refuses an empty expansion', () => {
    const unreached = membership({
      'packages/pkg/src/b.js': 'export const b = 1;\n',
    });
    assert.deepEqual(unreached.unreachableScopeModule.map((p) => p.split(' ')[0]), ['packages/pkg/src/b.js']); // prettier-ignore
    const empty = membership({ 'mutate.pkg.mjs': jsConfig({ mutate: ['packages/pkg/gone/**/*.js'] }) }); // prettier-ignore
    assert.ok(
      empty.unreadableMembership.some((p) => p.includes('expands against the tree to no tracked file')), // prettier-ignore
      empty.unreadableMembership.join('\n'),
    );
  });

  it('reds an unlisted transitively-reaching Rust binary, and a listed non-reaching one', () => {
    const unlisted = membership({
      'crate/src/b.rs': 'use super::a;\n',
      'crate/tests/b_test.rs': 'use fixture_lib::b::b;\n',
      'crate/src/lib.rs': 'pub mod a;\npub mod b;\n',
    });
    assert.ok(
      unlisted.unlistedMember.some((p) => p.includes('`b_test`')),
      unlisted.unlistedMember.join('\n'),
    );
    const listed = membership({
      'crate/tests/b_test.rs': 'use std::sync::mpsc;\n',
      'crate/.cargo/mutants.toml': manifest({ binaries: ['a_test', 'b_test'] }),
    });
    assert.ok(
      listed.listedNonMember.some((p) => p.includes('`--test b_test`') && p.includes('reaches no module')), // prettier-ignore
      listed.listedNonMember.join('\n'),
    );
  });

  it('reaches a mutated module through a re-exporting barrel', () => {
    // The surface imports the barrel; the barrel re-exports the mutated module.
    // Read without the `export … from` edge the surface reaches nothing, which
    // is a silent pass in the unlisted direction and a false red in the module
    // leg — so both are asserted absent here.
    const result = membership({
      'mutate.pkg.mjs': jsConfig({ mutate: ['packages/pkg/src/a.js'] }),
      'packages/pkg/src/index.js': "export { a } from './a.js';\n",
      'packages/pkg/tests/unit/a.test.js': testFile("import { a } from '../../src/index.js';"),
    });
    assert.deepEqual(result.listedNonMember, []);
    assert.deepEqual(result.unreachableScopeModule, []);
    assert.deepEqual(result.unlistedMember, []);
  });

  it('resolves a directory-form Rust binary through the routes Cargo builds from', () => {
    // `tests/<name>/main.rs` is a target as much as `tests/<name>.rs` is, and
    // the staleness leg already reads a listed target through both routes.
    const unlisted = membership({ 'crate/tests/b_test/main.rs': 'use fixture_lib::a::a;\n' });
    assert.ok(
      unlisted.unlistedMember.some((p) => p.includes('`b_test`')),
      unlisted.unlistedMember.join('\n'),
    );
    const listed = membership({
      'crate/tests/b_test/main.rs': 'use fixture_lib::a::a;\n',
      'crate/.cargo/mutants.toml': manifest({ binaries: ['a_test', 'b_test'] }),
    });
    assert.deepEqual(listed.unlistedMember, []);
    assert.deepEqual(listed.listedNonMember, []);
  });

  it('expands the Rust mutate scope against the tree, glob entries included', () => {
    // The cargo configuration's entries are globs as readily as literal paths.
    // Left unexpanded, the pattern text is a scope module nothing can reach and
    // reds as a gap in the suites rather than as the string it is.
    const globbed = membership({
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/a*.rs'] }),
    });
    assert.deepEqual(globbed.unreachableScopeModule, []);
    assert.deepEqual(globbed.unreadableMembership, []);
  });

  it('refuses a Rust mutate-scope entry that expands to nothing, as machinery', () => {
    const empty = membership({
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/gone/**/*.rs'] }),
    });
    assert.ok(
      empty.unreadableMembership.some((p) => p.includes('expands against the tree to no tracked file')), // prettier-ignore
      empty.unreadableMembership.join('\n'),
    );
  });

  it('asserts the in-module entry present, and never lets it satisfy the module leg', () => {
    const gone = membership({ 'crate/.cargo/mutants.toml': manifest({ lib: false }) });
    assert.ok(
      gone.unlistedMember.some((p) => p.includes('fixed in-module entry')),
      gone.unlistedMember.join('\n'),
    );
    // A scope module only the crate's own in-module blocks exercise: the list
    // still carries `--lib`, and the module still reds.
    const inModule = membership({
      'crate/src/b.rs': 'pub fn b() {}\n',
      'crate/.cargo/mutants.toml': manifest({ globs: ['src/a.rs', 'src/b.rs'] }),
    });
    assert.deepEqual(
      inModule.unreachableScopeModule.map((p) => p.split(' ')[0]),
      ['crate/src/b.rs'],
    );
  });

  it('subtracts the integration class by IMPORT, and admits a comment-only mention', () => {
    const imported = membership({
      'crate/tests/b_test.rs': `use ${RUST_MEMBERSHIP.integrationImport}::Enigo;\nuse fixture_lib::a::a;\n`, // prettier-ignore
    });
    assert.ok(
      !imported.unlistedMember.some((p) => p.includes('`b_test`')),
      imported.unlistedMember.join('\n'),
    );
    const mentioned = membership({
      'crate/tests/b_test.rs': `//! unlike the ${RUST_MEMBERSHIP.integrationImport} suite next door\nuse fixture_lib::a::a;\n`, // prettier-ignore
    });
    assert.ok(
      mentioned.unlistedMember.some((p) => p.includes('`b_test`')),
      mentioned.unlistedMember.join('\n'),
    );
  });

  it('refuses a `pub use` under the crate’s source rather than mapping past it', () => {
    const result = membership({ 'crate/src/a.rs': 'pub use crate::b::thing;\n' });
    assert.ok(
      result.unreadableMembership.some((p) => p.includes('pub use') && p.includes('crate/src/a.rs')), // prettier-ignore
      result.unreadableMembership.join('\n'),
    );
  });

  it('refuses a mutate scope spanning more than one package, and a suite it cannot find', () => {
    const spanning = membership({
      'mutate.pkg.mjs': jsConfig({ mutate: ['packages/pkg/src/**/*.js', 'packages/other/x.js'] }),
      'packages/other/x.js': 'export const x = 1;\n',
    });
    assert.ok(
      spanning.unreadableMembership.some((p) => p.includes('package tree(s)')),
      spanning.unreadableMembership.join('\n'),
    );
    const homeless = membership(
      { 'mutate.pkg.mjs': jsConfig({ mutate: ['packages/other/x.js'] }), 'packages/other/x.js': 'export const x = 1;\n' }, // prettier-ignore
    );
    assert.ok(
      homeless.unreadableMembership.some((p) => p.includes('no registered node-test suite')),
      homeless.unreadableMembership.join('\n'),
    );
  });

  it('excuses what an allowlist entry names, and reds the entry that excuses nothing', () => {
    const entry = {
      surface: 'mutate.pkg.mjs',
      leg: 'test-surface',
      entry: 'packages/pkg/tests/unit/b.test.js',
      reason: 'asserts wall-clock budgets',
    };
    const excused = membership(
      { 'packages/pkg/tests/unit/b.test.js': testFile("import { a } from '../../src/a.js';") },
      { allowlist: [entry] },
    );
    assert.deepEqual(excused.unlistedMember, []);
    assert.deepEqual(excused.staleMembershipAllowlist, []);
    // With nothing for it to rule on, the same entry is stale.
    const stale = membership({}, { allowlist: [entry] });
    assert.equal(stale.staleMembershipAllowlist.length, 1);
    assert.match(stale.staleMembershipAllowlist[0], /excuses nothing|that nothing needs/);
  });

  it('formats every populated problem class this audit reports, and no residue as one', () => {
    const shape = {
      unlistedMember: ['a surface'],
      listedNonMember: ['an entry'],
      unreachableScopeModule: ['a module'],
      staleMembershipAllowlist: ['an exclusion'],
      unreadableMembership: ['a source'],
    };
    const blocks = formatProblems({ ...shape, admittedMixed: { 'a.mjs': ['b.test.js'] } });
    assert.equal(blocks.length, Object.keys(shape).length);
    const block = (name) => blocks[Object.keys(shape).indexOf(name)];
    assert.match(block('unlistedMember'), /belong to a kill set that does not list them[\s\S]*Fix: list each one/); // prettier-ignore
    assert.match(block('listedNonMember'), /name a test surface that does not belong[\s\S]*Fix: drop each entry/); // prettier-ignore
    assert.match(block('unreachableScopeModule'), /reached by no listed test surface[\s\S]*Fix: list a test surface/); // prettier-ignore
    assert.match(block('staleMembershipAllowlist'), /excuse nothing[\s\S]*Fix: remove each entry/); // prettier-ignore
    assert.match(block('unreadableMembership'), /could not be read as what the criterion needs[\s\S]*Fix: restore the shape/); // prettier-ignore
  });
});

describe('real-tree lock', () => {
  it('the committed kill sets state exactly what the criterion places in them', () => {
    const result = auditKillSetMembership({ files: trackedFiles(), readFile: readRepoFile });
    assert.deepEqual(
      formatProblems(result),
      [],
      'every kill set must list the surfaces the membership criterion derives',
    );
    // The residue the property arm accepts is stated, never left implicit.
    assert.ok(Object.keys(result.admittedMixed).length > 0);
    assert.ok(MEMBERSHIP_ALLOWLIST.length > 0);
  });

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

  it('the committed tree and crate manifest hold no undiscovered test binary', () => {
    // The guard's own day-one green, pinned by name rather than left inside the
    // closure's aggregate: neither route exists today, so a future one is the
    // change that turns this red.
    const result = auditRegistrationClosure({ files: trackedFiles(), readFile: readRepoFile });
    assert.deepEqual(result.undiscoveredBinary, []);
  });

  it('the committed mutation kill sets name test files that are there', () => {
    // The staleness guard's own day-one green, pinned by name rather than left
    // inside the aggregate: one dead desktop entry was live on the tree when
    // this leg was written, and removing it is what turned this green.
    const result = auditMutationKillSets({ files: trackedFiles(), readFile: readRepoFile });
    assert.deepEqual(result.staleKillSetEntry, []);
    assert.deepEqual(result.unreadableKillSet, []);
  });

  it('the committed mutate scope is stated the same by its config and its document', () => {
    const result = auditMutationKillSets({ files: trackedFiles(), readFile: readRepoFile });
    assert.deepEqual(result.mutateScopeDrift, []);
    assert.deepEqual(result.deadScopeModule, []);
  });

  it('every configured document, suite, coverage list, and kill set is in the tree', () => {
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
    const jsConfigs = files.filter((f) => basenameGlobToRegExp(JS_KILL_SETS.glob).test(f));
    assert.ok(jsConfigs.length > 0, `${JS_KILL_SETS.glob} names tracked configurations`);
    assert.ok(tracked.has(RUST_KILL_SET.config), `${RUST_KILL_SET.config} is tracked`);
    assert.ok(tracked.has(MUTATE_SCOPE.config), `${MUTATE_SCOPE.config} is tracked`);
    assert.ok(tracked.has(MUTATE_SCOPE.doc), `${MUTATE_SCOPE.doc} is tracked`);
    assert.ok(
      files.some((f) => f.startsWith(`${RUST_KILL_SET.dir}/`)),
      `${RUST_KILL_SET.dir} holds tracked test binaries`,
    );
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
    // layer-discovery step globs. Cargo would also build tests/<name>/main.rs;
    // the discovery admission refuses that form — and the manifest routes to
    // the same place — so the rule and the tree state one top-level suite.
    const cargo = ruleFor('packages/desktop/src-tauri/tests');
    assert.equal(cargo('worker_pool_test.rs'), true);
    assert.equal(cargo('nested/main.rs'), false);
    assert.equal(cargo('common/mod.rs'), false);
    assert.equal(cargo('worker_pool_test.proptest-regressions'), false);
  });

  it('reads every tracked module the same way through the stream and through the view', () => {
    // The stream and the view share their scanning rules, and this is where
    // that sharing is held: over the modules the repository tracks rather than
    // over one example. A literal either rendering opened where the other did not
    // would show up as a token of a different kind, or as one more or one fewer,
    // so the kinds and their count are what agree — the values are each
    // rendering's own, the view carrying a blanked string where the stream
    // carries its text.
    const divergent = [];
    for (const path of trackedFiles()) {
      if (!/\.(js|mjs|cjs)$/.test(path)) continue;
      const source = readRepoFile(path);
      if (source === null) continue;
      const stream = tokenizeJs(source).map((token) => token.type);
      const view = tokenizeJs(blankJsLiterals(source)).map((token) => token.type);
      if (stream.length !== view.length || stream.join(' ') !== view.join(' ')) {
        divergent.push(`${path}: ${stream.length} tokens read from the source, ${view.length} from its view`); // prettier-ignore
      }
    }
    assert.deepEqual(divergent, []);
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

describe('the shared surface guards — one loop, one projector contract', () => {
  it('names an empty surface by its own diagnosis, and only that surface', () => {
    const entries = [
      ['alpha', 'no alpha rows read'],
      ['beta', 'no beta rows read'],
    ];
    assert.deepEqual(emptySurfaceProblems({ alpha: [], beta: ['b'] }, entries), [
      'no alpha rows read',
    ]);
    assert.deepEqual(emptySurfaceProblems({ alpha: ['a'], beta: ['b'] }, entries), []);
  });

  it('applies the projector an entry supplies, so a derived surface is readable', () => {
    // A Set has no length, so the projection is what makes the guard able to
    // read it at all — the contract both loops share.
    const project = (s) => [...s.keys];
    assert.deepEqual(
      emptySurfaceProblems({ keys: new Set() }, [['keys', 'no keys read', project]]),
      ['no keys read'],
    );
    assert.deepEqual(
      emptySurfaceProblems({ keys: new Set(['k']) }, [['keys', 'no keys read', project]]),
      [],
    );
  });

  it('a key the extraction does not state is its own finding, not an empty surface', () => {
    // The guard's table and its extraction disagreeing reads nothing like a
    // document that went empty: the message names the key the entry asked for
    // and says the extraction states it on nothing, so the reader is sent to
    // the table rather than to the document.
    const problems = emptySurfaceProblems({ alpha: ['a'] }, [['bteo', 'no beta rows read']]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /the empty-surface guard reads `bteo`/);
    assert.match(problems[0], /states that key on nothing/);
    assert.doesNotMatch(problems[0], /no beta rows read/);
  });

  it('the duplicate twin reads the same tuples, projector included', () => {
    const entries = [
      ['names', 'the name list'],
      ['keys', 'the key set', (s) => [...s.keys]],
    ];
    const surfaces = { names: ['a', 'b', 'a'], keys: new Set(['k']) };
    const problems = duplicateSurfaceProblems(surfaces, entries);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`a` appears more than once in the name list/);
    assert.deepEqual(duplicateSurfaceProblems({ names: ['a'], keys: new Set() }, entries), []);
  });

  it('the duplicate twin takes the same missing-key finding, not a silent no-duplicates', () => {
    // A duplicate list keyed on a surface the extraction stopped stating reads
    // `undefined` as "nothing repeated" — the shape only this arm can see,
    // since a surface genuinely free of repeats answers the same way.
    const problems = duplicateSurfaceProblems({ names: ['a', 'a'] }, [['nmaes', 'the name list']]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /the duplicate-surface guard reads `nmaes`/);
    assert.match(problems[0], /states that key on nothing/);
    assert.doesNotMatch(problems[0], /appears more than once/);
  });
});
