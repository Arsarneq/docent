/**
 * check-adapter-surface.test.js — Unit tests for the adapter-seam admission
 * test (scripts/check-adapter-surface.js). The seam's member agreement is a
 * committed contract (shared-core.md §SC-3), so every red path must fail loud:
 * these tests prove the missing-member red on each adapter side, the red a new
 * typedef property raises, the red a member every concrete adapter implements
 * with no typedef entry raises, the duplicates and empty-parse legs, the member
 * shapes the scan reads (a name or quoted name followed by a value, an argument
 * list, or the property's end, `async` before a method name and as a member
 * name of its own), and every refusal arm of both extractors — the
 * typedef-block count, the entry grammar, the `export default` count, the
 * binding count, a default export that names no binding the scan can resolve, a
 * named binding initialized from something other than an object literal, a
 * property shape outside the set read, a literal that never closes, and a file
 * that cannot be read. A refusal is held to take the MEMBER legs off the report:
 * a refused surface yields no member list, and no member diff is derived from
 * it — while the seam document's enumeration diff, computed from a derivation
 * that held against a document that was read, rides beside such a refusal and is
 * suppressed only by a refusal in that derivation, which a case holds both ways.
 * A
 * member only some platforms' callers need stays admitted, and a case holds
 * that admission on each adapter side. The decoy literals — a second top-level
 * literal, exported and not — are a demonstration rather than a guard: they
 * must never satisfy a typedef member.
 *
 * WHICH adapters those legs run over is itself derived, so the derivation has
 * its own family: the filename convention it reads, the packages' test trees
 * and the contract file it leaves out, the platform token it refuses and the
 * collision it refuses, the diff against the seam document's own link targets
 * in both directions, and the explicit red below two adapters — the arity the
 * direction over every adapter's members needs. Every generated family here
 * follows that derivation rather than a copy of it.
 *
 * The real-tree lock and the CLI smoke observe the shipped tree satisfying the
 * contract; the drifted-tree case runs the wrapper over a scratch git
 * repository, because the derivation reads the tracked files of the directory
 * it is invoked in, and a source lock holds the wrapper to taking its adapters
 * from that derivation rather than from a list of its own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  TYPEDEF_PATH,
  TYPEDEF_NAME,
  SC_CLAUSE_ID,
  ADAPTER_TREE,
  ADAPTER_TEST_DIR,
  SEAM_DOC_PATH,
  SEAM_SECTION,
  deriveAdapters,
  trackedAdapters,
  extractSeamEnumeration,
  emptySurfaces,
  duplicateSurfaces,
  extractTypedefProperties,
  extractAdapterMembers,
  evaluateAdapterSurface,
  auditTree,
} from '../../../../scripts/check-adapter-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SCRIPT = resolve(ROOT, 'scripts', 'check-adapter-surface.js');
/** A path stood in for an adapter in the extractor-level fixtures. */
const FIXTURE_PATH = 'packages/fixture/adapter-fixture.js';

/**
 * The adapters the shipped tree derives — the same list the check itself runs
 * on, so every generated family below follows the tree rather than a copy of
 * it. The suite runs from the repository root, which is what the derivation
 * reads its population from.
 */
const ADAPTERS = trackedAdapters().adapters;
const EMPTY_SURFACES = emptySurfaces(ADAPTERS);
const DUPLICATE_SURFACES = duplicateSurfaces(ADAPTERS);

/** A consistent synthetic surface the contract accepts, keyed to the derivation. */
function makeSurface(overrides = {}) {
  const surface = { typedefProperties: ['send', 'loadTheme', 'hasNativeFileDialog'] };
  // Each adapter carries one platform-specific member beyond the contract — the
  // shape the admission rule in the typedef's own header covers — named after
  // its own platform so the fixtures stay distinct however the tree grows.
  for (const { key, platform } of ADAPTERS) {
    surface[key] = ['send', 'loadTheme', 'hasNativeFileDialog', `load_${platform}_only`];
  }
  return { ...surface, ...overrides };
}

/**
 * A typedef file shaped like the real one: a sibling typedef carrying its own
 * properties, then the contract's block.
 */
function makeTypedefSource(
  entries = ['{(m: Object) => Promise<Object>} send', '{boolean} hasNativeFileDialog'],
) {
  // prettier-ignore
  return [
    '/**',
    ' * adapter.js — fixture header',
    ' */',
    '',
    '/**',
    ' * @typedef {Object} DispatchSettings',
    ' * @property {string|null} endpointUrl',
    ' */',
    '',
    '/**',
    ` * @typedef {Object} ${TYPEDEF_NAME}`,
    ...entries.map((entry) => ` * @property ${entry}`),
    ' */',
    '',
    'export default undefined;',
  ].join('\n');
}

/** An adapter file: a named object literal, exported by default. */
function makeAdapterSource(members, { binding = 'adapter', prologue = '', epilogue = '' } = {}) {
  return [
    prologue,
    `const ${binding} = {`,
    ...members.map((member) => `  ${member}`),
    '};',
    '',
    `export default ${binding};`,
    epilogue,
  ].join('\n');
}

/**
 * A seam document shaped like the real one: the `##` section whose links send a
 * reader to each concrete adapter, which is the enumeration the check diffs its
 * derivation against.
 * @param {string[]} paths repo-relative adapter paths the section links to
 * @returns {string} the document's text
 */
function makeSeamDoc(paths) {
  const up = '../'.repeat(SEAM_DOC_PATH.split('/').length - 1);
  return [
    '# Shared Core — fixture',
    '',
    `## ${SEAM_SECTION}`,
    '',
    'Each platform implements the seam once:',
    ...paths.map((path) => `- [\`${path.split('/').pop()}\`](${up}${path})`),
    '',
    '## After',
    '',
    'Text past the section.',
    '',
  ].join('\n');
}

/**
 * A scratch git repository the wrapper's own derivation can read: `git init`,
 * the files the case writes, and `git add` so they are TRACKED — the population
 * every check in this family reads from the directory it is invoked in.
 * @param {(write: (path: string, content: string) => void) => void} populate
 * @returns {string} the repository's directory
 */
function makeScratchRepo(populate) {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-surface-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--quiet');
  populate((path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  });
  git('add', '--all');
  return dir;
}

/** The member shapes the adapters actually use. */
const LIVE_MEMBER_SHAPES = [
  'send(message) {',
  '    return post(message);',
  '  },',
  '  async loadTheme() {',
  "    return 'auto';",
  '  },',
  '  hasNativeFileDialog: false,',
];

describe('evaluateAdapterSurface — compliant baseline', () => {
  it('the fixture covers exactly the check’s adapter keys (addition lock)', () => {
    // The same addition lock the duplicates family carries: an adapter added to
    // the check's list without a fixture key reds here by name, instead of the
    // baseline case dying on an undefined surface.
    const fixtureKeys = Object.keys(makeSurface()).filter((k) => k !== 'typedefProperties');
    assert.deepEqual(fixtureKeys.sort(), ADAPTERS.map(({ key }) => key).sort());
  });

  it('returns no problems when every adapter implements the whole contract', () => {
    assert.deepEqual(evaluateAdapterSurface(makeSurface(), ADAPTERS), []);
  });
});

describe('evaluateAdapterSurface — the shared-member leg', () => {
  it('fires when every adapter implements a member the typedef does not declare', () => {
    const problems = evaluateAdapterSurface(
      makeSurface(
        Object.fromEntries(ADAPTERS.map(({ key }) => [key, [...makeSurface()[key], 'loadWidget']])),
      ),
      ADAPTERS,
    );
    const red = problems.find((p) => p.includes('loadWidget'));
    assert.ok(red, problems.join('\n') || 'no undeclared-shared-member diagnostic');
    // The red names the member, every adapter that implements it, the typedef
    // the declaration belongs in, the clause, and both routes that close it.
    assert.ok(red.includes('`loadWidget`'), red);
    for (const { path } of ADAPTERS) assert.ok(red.includes(path), red);
    assert.ok(red.includes(TYPEDEF_PATH), red);
    assert.ok(red.includes(TYPEDEF_NAME), red);
    assert.ok(red.includes(SC_CLAUSE_ID), red);
    assert.ok(red.includes('declare it as an @property'), red);
    assert.ok(red.includes('keep it to the platforms whose callers need it'), red);
  });

  for (const { key, path } of ADAPTERS) {
    it(`admits a member only ${path} implements — the platform-specific case`, () => {
      const problems = evaluateAdapterSurface(
        makeSurface({ [key]: [...makeSurface()[key], 'loadWidget'] }),
        ADAPTERS,
      );
      assert.deepEqual(problems, [], problems.join('\n'));
    });
  }
});

describe('evaluateAdapterSurface — the member-agreement leg, every adapter', () => {
  it('the adapter list carries what both directions need, with distinct paths', () => {
    // The member-agreement leg needs an adapter to hold; the shared-member leg
    // needs more than one, since an intersection over a single adapter is that
    // adapter's whole surface and would red its every platform-specific member.
    assert.ok(ADAPTERS.length > 1);
    const paths = ADAPTERS.map(({ path }) => path);
    assert.equal(new Set(paths).size, paths.length);
  });

  for (const { key, path } of ADAPTERS) {
    it(`fires when ${path} does not implement a declared member`, () => {
      const problems = evaluateAdapterSurface(
        makeSurface({ [key]: makeSurface()[key].filter((m) => m !== 'loadTheme') }),
        ADAPTERS,
      );
      const red = problems.find((p) => p.includes('loadTheme'));
      assert.ok(red, problems.join('\n') || `no missing-member diagnostic for ${path}`);
      // The red names the member, both sides of the comparison, and the clause.
      assert.ok(red.includes(`\`loadTheme\``), red);
      assert.ok(red.includes(TYPEDEF_PATH), red);
      assert.ok(red.includes(path), red);
      assert.ok(red.includes(SC_CLAUSE_ID), red);
    });
  }

  it('fires on every adapter when the typedef declares a member neither implements', () => {
    const problems = evaluateAdapterSurface(
      makeSurface({ typedefProperties: [...makeSurface().typedefProperties, 'loadCapabilities'] }),
      ADAPTERS,
    );
    for (const { path } of ADAPTERS) {
      assert.ok(
        problems.some((p) => p.includes('loadCapabilities') && p.includes(path)),
        problems.join('\n') || `no added-property diagnostic for ${path}`,
      );
    }
  });
});

// Fixture rows for the duplicates family, keyed to the check's own exported
// DUPLICATE_SURFACES list. The lock below holds the two key sets equal, so a
// surface added to the check's loop without a fixture row reds here — the
// addition direction the per-leg tests alone cannot see.
const DUPLICATE_FIXTURES = {
  typedefProperties: ['send', 'loadTheme', 'send', 'hasNativeFileDialog'],
  chromeMembers: ['send', 'loadTheme', 'hasNativeFileDialog', 'loadTheme'],
  tauriMembers: ['send', 'loadTheme', 'hasNativeFileDialog', 'send'],
};

describe('evaluateAdapterSurface — duplicates, every leg of the duplicates loop', () => {
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
    it(`fires on a name written twice in ${what}`, () => {
      const problems = evaluateAdapterSurface(
        makeSurface({ [key]: DUPLICATE_FIXTURES[key] }),
        ADAPTERS,
      );
      assert.ok(
        problems.some((p) => p.includes('more than once') && p.includes(what)),
        problems.join('\n') || `no duplicates diagnostic for ${what}`,
      );
    });
  }
});

describe('evaluateAdapterSurface — empty parses are structural failures', () => {
  it('the export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, message]) => message);
    assert.equal(new Set(messages).size, messages.length);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateAdapterSurface(makeSurface({ [key]: [] }), ADAPTERS);
      assert.ok(
        problems.some((p) => p.includes(message)),
        problems.join('\n') || `no vacuous diagnostic for ${key}`,
      );
    });
  }
});

describe('extractTypedefProperties — the one block, the one entry grammar', () => {
  it('reads the contract block’s member names and never a sibling typedef’s', () => {
    const read = extractTypedefProperties(makeTypedefSource());
    assert.deepEqual(read.names, ['send', 'hasNativeFileDialog']);
    assert.deepEqual(read.problems, []);
    assert.ok(!read.names.includes('endpointUrl'));
  });

  it('reads a type carrying nested braces', () => {
    const read = extractTypedefProperties(
      makeTypedefSource(['{{ serverUrl: string }} loadSyncSettings']),
    );
    assert.deepEqual(read.names, ['loadSyncSettings']);
    assert.deepEqual(read.problems, []);
  });

  it('reads the last entry of a block that ends on its line', () => {
    const read = extractTypedefProperties(
      `/**\n * @typedef {Object} ${TYPEDEF_NAME}\n * @property {boolean} hasNativeFileDialog */`,
    );
    assert.deepEqual(read.names, ['hasNativeFileDialog']);
    assert.deepEqual(read.problems, []);
  });

  it('refuses a source carrying no JSDoc block at all', () => {
    const read = extractTypedefProperties('const adapter = {};\n');
    assert.deepEqual(read.names, []);
    assert.ok(read.problems.some((p) => p.includes('0 JSDoc blocks')));
  });

  it('refuses a tree carrying no block declaring the typedef', () => {
    const read = extractTypedefProperties('/**\n * @typedef {Object} Other\n */\n');
    assert.deepEqual(read.names, []);
    assert.ok(read.problems.some((p) => p.includes('0 JSDoc blocks') && p.includes(TYPEDEF_NAME)));
  });

  it('refuses a second block declaring the same typedef', () => {
    const read = extractTypedefProperties(`${makeTypedefSource()}\n${makeTypedefSource()}`);
    assert.deepEqual(read.names, []);
    assert.ok(read.problems.some((p) => p.includes('2 JSDoc blocks')));
  });

  it('refuses each entry outside the grammar, naming the entry it read', () => {
    const cases = [
      ['boolean hasNativeFileDialog', 'states no brace-delimited type'],
      ['{() => Promise<void> saveTheme', 'never closes its type braces on its line'],
      ['{boolean}', 'states no member name after its type'],
      ['{string} [loadTheme]', 'states no member name after its type'],
    ];
    for (const [entry, diagnosis] of cases) {
      const read = extractTypedefProperties(makeTypedefSource([entry]));
      assert.deepEqual(read.names, [], `${entry} must contribute no member`);
      assert.ok(
        read.problems.some((p) => p.includes(diagnosis) && p.includes(entry.trim())),
        read.problems.join('\n') || `no refusal for ${entry}`,
      );
    }
  });

  it('refuses a truncated file whose JSDoc block never closes', () => {
    const read = extractTypedefProperties(`/**\n * @typedef {Object} ${TYPEDEF_NAME}\n * @property {string`); // prettier-ignore
    assert.deepEqual(read.names, []);
    assert.ok(
      read.problems.some((p) => p.includes('0 JSDoc blocks')),
      read.problems.join('\n'),
    );
  });

  it('a block whose every entry is refused parses empty, and that empty parse evaluates as vacuous', () => {
    const read = extractTypedefProperties(makeTypedefSource(['boolean hasNativeFileDialog']));
    assert.deepEqual(read.names, []);
    const problems = evaluateAdapterSurface(
      makeSurface({ typedefProperties: read.names }),
      ADAPTERS,
    );
    assert.ok(problems.some((p) => p.includes('no @property entries found')));
  });
});

describe('extractAdapterMembers — the default-exported literal, and only it', () => {
  it('reads every member shape the adapters use, skipping comments', () => {
    const source = makeAdapterSource([
      '// send({ type: "COMMENTED_OUT" }) is never a member',
      ...LIVE_MEMBER_SHAPES,
      "  'loadSchema'() {",
      '    return {};',
      '  },',
    ]);
    const read = extractAdapterMembers(source, FIXTURE_PATH);
    assert.deepEqual(read.names, ['send', 'loadTheme', 'hasNativeFileDialog', 'loadSchema']);
    assert.deepEqual(read.problems, []);
  });

  it('never reads a nested literal’s own keys as members', () => {
    const source = makeAdapterSource([
      'send(message) { return post(message); },',
      "  defaults: { loadTheme: 'auto', hasNativeFileDialog: false },",
    ]);
    const read = extractAdapterMembers(source, FIXTURE_PATH);
    assert.deepEqual(read.names, ['send', 'defaults']);
  });

  it('reads a shorthand property as the member it names', () => {
    const source = makeAdapterSource([
      'send,',
      '  loadTheme,',
      '  hasNativeFileDialog', // the literal's last property, closed by the brace
    ]);
    const read = extractAdapterMembers(source, FIXTURE_PATH);
    assert.deepEqual(read.names, ['send', 'loadTheme', 'hasNativeFileDialog']);
    assert.deepEqual(read.problems, []);
  });

  it('reads `async` as the member name where the property’s shape is its own', () => {
    const shapes = [
      ['async: true,', 'async'],
      ['async,', 'async'],
      ['async() { return 1; },', 'async'],
      ['async loadTheme() { return 1; },', 'loadTheme'],
    ];
    for (const [property, expected] of shapes) {
      const read = extractAdapterMembers(makeAdapterSource([property]), FIXTURE_PATH);
      assert.deepEqual(read.names, [expected], `${property} must read as ${expected}`);
      assert.deepEqual(read.problems, [], read.problems.join('\n'));
    }
  });

  it('refuses each property shape outside the set read, naming what it found', () => {
    const shapes = [
      ['get loadTheme() { return 1; },', '`get` followed by `loadTheme`'],
      ['set loadTheme(v) {},', '`set` followed by `loadTheme`'],
      ['[computedKey]: 1,', '`[` followed by `computedKey`'],
      ['...spreadIn,', '`.` followed by `.`'],
      ['*stream() {},', '`*` followed by `stream`'],
      ['async *stream() {},', '`async` followed by `*`'],
    ];
    for (const [property, found] of shapes) {
      const read = extractAdapterMembers(
        makeAdapterSource(['send(message) { return post(message); },', `  ${property}`]),
        FIXTURE_PATH,
      );
      const red = read.problems.find((p) => p.includes('does not model'));
      assert.ok(red, read.problems.join('\n') || `no refusal for ${property}`);
      assert.ok(red.includes(found), red);
      assert.ok(red.includes(FIXTURE_PATH), red);
      // A refused surface yields no member list at all — not even the members
      // read before the refusal, which would diff as though the parse held.
      assert.deepEqual(read.names, [], `${property} must leave no partial list`);
    }
  });

  it('reads no member name from a template standing in the key position', () => {
    // The exclusion is the token type doing its work: a member name is a bare
    // or quoted name, and a template is neither. A template can only reach a
    // key position through the computed form, which the scan already refuses;
    // both shapes are refused here rather than credited with the text.
    for (const property of ['[`loadTheme`]: 1,', '`loadTheme`: 1,']) {
      const read = extractAdapterMembers(
        makeAdapterSource(['send(message) { return post(message); },', `  ${property}`]),
        FIXTURE_PATH,
      );
      const red = read.problems.find((p) => p.includes('does not model'));
      assert.ok(red, read.problems.join('\n') || `no refusal for ${property}`);
      assert.deepEqual(read.names, [], `${property} must leave no partial list`);
    }
  });

  it('reads a template member VALUE without disturbing the member scan', () => {
    // A template in a value position is nobody's key: the member names either
    // side of it are read exactly as they were.
    const read = extractAdapterMembers(
      makeAdapterSource(['send(message) { return post(message); },', '  loadTheme: `auto`,']),
      FIXTURE_PATH,
    );
    assert.deepEqual(read.names, ['send', 'loadTheme']);
    assert.deepEqual(read.problems, []);
  });

  it('a member in a second EXPORTED top-level literal never satisfies the contract — the live shape', () => {
    // `export const _testOnly = { … }` is the shape the desktop adapter ships
    // beside its default export. Its members are outside the literal the scan
    // reads, and no refusal arm fires on it.
    const source = makeAdapterSource(['send(message) { return post(message); },'], {
      epilogue: ['', 'export const _testOnly = {', '  loadTheme: () => {},', '};'].join('\n'),
    });
    const read = extractAdapterMembers(source, FIXTURE_PATH);
    assert.deepEqual(read.names, ['send']);
    assert.deepEqual(read.problems, []);
    const problems = evaluateAdapterSurface(
      makeSurface({ [ADAPTERS[0].key]: read.names }),
      ADAPTERS,
    );
    assert.ok(
      problems.some((p) => p.includes('`loadTheme`') && p.includes('does not implement it')),
      problems.join('\n') || 'the decoy member greened a typedef member',
    );
  });

  it('a member in a NON-EXPORTED top-level literal never satisfies the contract either', () => {
    const source = makeAdapterSource(['send(message) { return post(message); },'], {
      prologue: ['const helpers = {', '  loadTheme: () => {},', '};', ''].join('\n'),
    });
    const read = extractAdapterMembers(source, FIXTURE_PATH);
    assert.deepEqual(read.names, ['send']);
    assert.deepEqual(read.problems, []);
    const problems = evaluateAdapterSurface(
      makeSurface({ [ADAPTERS[1].key]: read.names }),
      ADAPTERS,
    );
    assert.ok(
      problems.some((p) => p.includes('`loadTheme`') && p.includes('does not implement it')),
      problems.join('\n') || 'the decoy member greened a typedef member',
    );
  });

  it('refuses a file with no default export, and one with two', () => {
    const none = extractAdapterMembers('const adapter = { send() {} };\n', FIXTURE_PATH);
    assert.deepEqual(none.names, []);
    assert.ok(none.problems.some((p) => p.includes('0 `export default` statements')));

    const two = extractAdapterMembers(
      `${makeAdapterSource(['send() {},'])}\nexport default other;\n`,
      FIXTURE_PATH,
    );
    assert.deepEqual(two.names, []);
    assert.ok(two.problems.some((p) => p.includes('2 `export default` statements')));
  });

  it('refuses a default export that names no binding', () => {
    const read = extractAdapterMembers('export default { send() {} };\n', FIXTURE_PATH);
    assert.deepEqual(read.names, []);
    assert.ok(
      read.problems.some((p) => p.includes('names no binding the scan can resolve')),
      read.problems.join('\n') || 'no anonymous-default refusal',
    );
  });

  it('refuses a source that ends mid-anchor, naming the end of source', () => {
    const truncatedExport = extractAdapterMembers('export default', FIXTURE_PATH);
    assert.deepEqual(truncatedExport.names, []);
    assert.ok(
      truncatedExport.problems.some((p) => p.includes('(end of source)')),
      truncatedExport.problems.join('\n') || 'no end-of-source refusal for the export',
    );
    const truncatedBinding = extractAdapterMembers(
      'export default adapter;\nconst adapter =',
      FIXTURE_PATH,
    );
    assert.deepEqual(truncatedBinding.names, []);
    assert.ok(
      truncatedBinding.problems.some((p) => p.includes('(end of source)')),
      truncatedBinding.problems.join('\n') || 'no end-of-source refusal for the initializer',
    );
  });

  it('refuses a default export whose binding the file does not declare', () => {
    const read = extractAdapterMembers('export default imported;\n', FIXTURE_PATH);
    assert.deepEqual(read.names, []);
    assert.ok(read.problems.some((p) => p.includes('0 `imported` bindings')));
  });

  it('refuses more than one candidate binding for the default export', () => {
    const source = [
      'const adapter = { send() {} };',
      'const adapter = { loadTheme() {} };',
      'export default adapter;',
    ].join('\n');
    const read = extractAdapterMembers(source, FIXTURE_PATH);
    assert.deepEqual(read.names, []);
    assert.ok(read.problems.some((p) => p.includes('2 `adapter` bindings')));
  });

  it('refuses an initializer that is not an object literal', () => {
    const read = extractAdapterMembers(
      'const adapter = makeAdapter();\nexport default adapter;\n',
      FIXTURE_PATH,
    );
    assert.deepEqual(read.names, []);
    assert.ok(
      read.problems.some((p) => p.includes('rather than an object literal') && p.includes('makeAdapter')), // prettier-ignore
      read.problems.join('\n') || 'no non-literal refusal',
    );
  });

  it('refuses a literal that never closes, yielding no member list', () => {
    const read = extractAdapterMembers(
      'export default adapter;\nconst adapter = {\n  send() {},\n',
      FIXTURE_PATH,
    );
    assert.ok(
      read.problems.some((p) => p.includes('never closes')),
      read.problems.join('\n') || 'no unterminated-literal refusal',
    );
    // Like every other refusal arm: what it read is not the adapter's surface.
    assert.deepEqual(read.names, []);
  });
});

describe('auditTree — reading the tree', () => {
  const REAL = (f) => readFileSync(resolve(ROOT, f), 'utf8');

  for (const path of [TYPEDEF_PATH, ...ADAPTERS.map((a) => a.path)]) {
    it(`refuses an unreadable ${path} instead of parsing it as empty`, () => {
      const { problems } = auditTree((f) => (f === path ? null : REAL(f)));
      assert.ok(
        problems.some((p) => p.includes(path) && p.includes('cannot be read')),
        problems.join('\n') || `no unreadable-file refusal for ${path}`,
      );
    });
  }

  it('a refused surface is the whole report — no member diff is derived from it', () => {
    // One live typedef entry rewritten to the JSDoc optional form the reader
    // refuses. Every adapter still implements that member, so a diff over the
    // refused list would red it as undeclared — the refusal is the answer.
    const refused = REAL(TYPEDEF_PATH).replace(
      '@property {() => Promise<string>} loadTheme',
      '@property {() => Promise<string>} [loadTheme]',
    );
    const { problems } = auditTree((f) => (f === TYPEDEF_PATH ? refused : REAL(f)));
    assert.ok(
      problems.some((p) => p.includes('states no member name after its type')),
      problems.join('\n') || 'no optional-form refusal',
    );
    assert.ok(!problems.some((p) => p.includes('declares no such member')), problems.join('\n'));
    assert.ok(!problems.some((p) => p.includes('does not implement it')), problems.join('\n'));
    assert.equal(problems.length, 1, problems.join('\n'));
  });

  it('the shipped tree satisfies the contract', () => {
    const { problems, memberCount } = auditTree(REAL);
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(memberCount > 0);
    // The lock also proves the check reads the real files it names.
    for (const path of [TYPEDEF_PATH, ...ADAPTERS.map((a) => a.path)]) {
      assert.doesNotThrow(() => readFileSync(resolve(ROOT, path)));
    }
  });
});

describe('deriveAdapters — the filename convention decides the set', () => {
  const CHROME = 'packages/extension/sidepanel/adapter-chrome.js';
  const TAURI = 'packages/desktop/src/adapter-tauri.js';

  it('takes every tracked adapter-<platform>.js and derives its surface key from the name', () => {
    const { adapters, problems } = deriveAdapters([
      CHROME,
      TAURI,
      'packages/shared/lib/session.js',
    ]);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      adapters.map(({ platform, key, path }) => [platform, key, path]),
      [
        ['tauri', 'tauriMembers', TAURI],
        ['chrome', 'chromeMembers', CHROME],
      ],
    );
  });

  it('leaves out the packages’ test trees, the contract file, and everything outside packages/', () => {
    const { adapters, problems } = deriveAdapters([
      CHROME,
      TAURI,
      TYPEDEF_PATH,
      `packages/extension/${ADAPTER_TEST_DIR}/unit/adapter-chrome.test.js`,
      `packages/desktop/${ADAPTER_TEST_DIR}/unit/adapter-tauri.test.js`,
      'scripts/check-adapter-surface.js',
    ]);
    assert.deepEqual(problems, []);
    assert.deepEqual(adapters.map(({ path }) => path).sort(), [TAURI, CHROME].sort());
  });

  it('refuses a platform token it cannot read rather than leaving the file unread', () => {
    const { adapters, problems } = deriveAdapters([
      CHROME,
      TAURI,
      `${ADAPTER_TREE}/desktop/src/adapter-web.view.js`,
    ]);
    assert.equal(adapters.length, 2);
    assert.ok(
      problems.some((p) => p.includes('adapter-web.view.js') && p.includes('platform token')),
      problems.join('\n') || 'no refusal for an unreadable platform token',
    );
  });

  it('refuses two adapters claiming one platform token', () => {
    const { problems } = deriveAdapters([CHROME, TAURI, `${ADAPTER_TREE}/other/src/adapter-tauri.js`]); // prettier-ignore
    assert.ok(
      problems.some((p) => p.includes('`tauri`') && p.includes('two adapters')),
      problems.join('\n') || 'no refusal for a colliding platform token',
    );
  });

  it('the shipped tree derives the adapters the seam document sends a reader to', () => {
    const derived = trackedAdapters();
    assert.deepEqual(derived.problems, []);
    assert.ok(derived.adapters.length > 1);
    const enumeration = extractSeamEnumeration(readFileSync(resolve(ROOT, SEAM_DOC_PATH), 'utf8'));
    assert.equal(enumeration.error, undefined);
    assert.deepEqual(
      enumeration.targets.slice().sort(),
      derived.adapters.map(({ path }) => path).sort(),
    );
  });
});

describe('evaluateAdapterSurface — the arity guard', () => {
  for (const derived of [[], [ADAPTERS[0]]]) {
    it(`reds explicitly on a derivation of ${derived.length} adapter(s)`, () => {
      const problems = evaluateAdapterSurface(makeSurface(), derived);
      assert.ok(
        problems.some((p) => p.includes(`finds ${derived.length} concrete adapter(s)`)),
        problems.join('\n') || 'the arity guard passed over a derivation it cannot hold',
      );
      assert.ok(problems.some((p) => p.includes(SC_CLAUSE_ID)), problems.join('\n')); // prettier-ignore
    });
  }
});

describe('extractSeamEnumeration — the document’s own enumeration, read as link targets', () => {
  it('resolves each link target against the document’s directory, adapters only', () => {
    const read = extractSeamEnumeration(
      makeSeamDoc(['packages/extension/sidepanel/adapter-chrome.js']).replace(
        'Each platform implements the seam once:',
        `Each platform implements the seam once, over [the contract](${'../'.repeat(SEAM_DOC_PATH.split('/').length - 1)}${TYPEDEF_PATH}) and [a guide](../../user/extension.md):`,
      ),
    );
    assert.deepEqual(read.targets, ['packages/extension/sidepanel/adapter-chrome.js']);
  });

  it('refuses a document that no longer states the section', () => {
    const read = extractSeamEnumeration('# Shared Core\n\n## Something else\n\nText.\n');
    assert.ok(read.error?.includes(SEAM_SECTION), read.error ?? 'no refusal');
  });

  it('reads no link a fenced example carries, and stops at the next heading', () => {
    const doc = [
      `## ${SEAM_SECTION}`,
      '',
      '```md',
      '[`adapter-ghost.js`](../../../packages/ghost/src/adapter-ghost.js)',
      '```',
      '',
      '## After',
      '',
      '[`adapter-later.js`](../../../packages/later/src/adapter-later.js)',
      '',
    ].join('\n');
    assert.deepEqual(extractSeamEnumeration(doc).targets, []);
  });
});

describe('auditTree — the derivation and the document’s enumeration are held together', () => {
  const REAL = (f) => readFileSync(resolve(ROOT, f), 'utf8');

  it('a planted tracked adapter reds the drift direction, on the tree and in the document', () => {
    const planted = `${ADAPTER_TREE}/ghost/src/adapter-ghost.js`;
    const files = [...ADAPTERS.map(({ path }) => path), planted];
    const { problems } = auditTree(
      (f) =>
        f === planted ? makeAdapterSource(['send(message) { return post(message); },']) : REAL(f),
      files,
    );
    // The seam document sends a reader to no such adapter…
    assert.ok(
      problems.some((p) => p.includes(planted) && p.includes('no link of')),
      problems.join('\n') || 'the planted adapter was not held against the document',
    );
    // …and it implements none of the members the typedef declares.
    assert.ok(
      problems.some((p) => p.includes(planted) && p.includes('does not implement it')),
      problems.join('\n') || 'the planted adapter was not held against the typedef',
    );
  });

  it('enumeration drift rides beside an unrelated refusal, and a derivation refusal suppresses it', () => {
    const planted = `${ADAPTER_TREE}/ghost/src/adapter-ghost.js`;
    const files = [...ADAPTERS.map(({ path }) => path), planted];
    // The DERIVATION holds; what refuses is the planted adapter's own member
    // extraction. The drift was measured against a set that was derived and a
    // document that was read, so it rides beside that refusal.
    const beside = auditTree(
      (f) => (f === planted ? 'const ghost = 1;\nexport default ghost;\n' : REAL(f)),
      files,
    );
    assert.ok(
      beside.problems.some((p) => p.includes(planted) && p.includes('rather than an object literal')), // prettier-ignore
      beside.problems.join('\n') || 'the member-extraction refusal is missing',
    );
    assert.ok(
      beside.problems.some((p) => p.includes(planted) && p.includes('no link of')),
      beside.problems.join('\n') || 'the enumeration drift was hidden by an unrelated refusal',
    );
    // A refusal IN the derivation is the other case: the set the diff would run
    // against was never produced, so the drift stands on nothing and is gone.
    const refusedDerivation = auditTree(
      (f) => (f === planted ? makeAdapterSource(LIVE_MEMBER_SHAPES) : REAL(f)),
      [...files, `${ADAPTER_TREE}/ghost/src/adapter-web.view.js`],
    );
    assert.ok(
      refusedDerivation.problems.some((p) => p.includes('platform token')),
      refusedDerivation.problems.join('\n') || 'the derivation refusal is missing',
    );
    assert.ok(
      !refusedDerivation.problems.some((p) => p.includes('no link of')),
      refusedDerivation.problems.join('\n'),
    );
  });

  it('a link the document still states that the tree no longer carries reds the other way', () => {
    const gone = `${ADAPTER_TREE}/ghost/src/adapter-ghost.js`;
    const up = '../'.repeat(SEAM_DOC_PATH.split('/').length - 1);
    const drifted = REAL(SEAM_DOC_PATH).replace(
      '## The adapter seam',
      `## The adapter seam\n\n[\`adapter-ghost.js\`](${up}${gone})`,
    );
    const { problems } = auditTree((f) => (f === SEAM_DOC_PATH ? drifted : REAL(f)));
    assert.ok(
      problems.some((p) => p.includes(gone) && p.includes('no such concrete adapter')),
      problems.join('\n') || 'a stale enumeration entry passed',
    );
  });
});

describe('the command-line wrapper', () => {
  it('exits 0 on the committed tree and reports the contract it held', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /adapter surface consistent/);
    assert.match(out, new RegExp(`${TYPEDEF_NAME} members`));
    for (const { path } of ADAPTERS) assert.ok(out.includes(path), out);
  });

  it('the wrapper takes the derived adapters, never a list of its own (source lock)', () => {
    // `run()` is outside the coverage the pure core carries, so what holds its
    // wiring is its own source: it calls auditTree with the reader alone, which
    // is what makes the derivation the wrapper's answer, and it renders the
    // adapters that call hands back rather than any list written beside it.
    const source = readFileSync(SCRIPT, 'utf8');
    assert.ok(source.includes('auditTree(readFile)'), 'the wrapper stopped calling auditTree with the reader alone'); // prettier-ignore
    assert.ok(
      /const \{ problems, memberCount, adapters \} = auditTree\(readFile\);/.test(source),
      'the wrapper stopped taking its adapters from the audit it runs',
    );
  });

  it('exits 1 on a drifted tree, naming the member and the routes that close it', () => {
    // The red output itself — exit code, the missing member, and the trailer's
    // fix routes — observed by running the wrapper against a tree where one
    // adapter lacks a declared member. The scratch tree is a real git
    // repository, because the wrapper DERIVES its adapters from the tracked
    // files of the directory it is invoked in: the case that proves the command
    // line observes drift has to give that derivation something to read, and a
    // bare temporary directory gives it nothing.
    const dir = makeScratchRepo((write) => {
      write(TYPEDEF_PATH, makeTypedefSource(['{() => Promise<string>} loadTheme']));
      write(SEAM_DOC_PATH, makeSeamDoc([ADAPTERS[0].path, ADAPTERS[1].path]));
      write(ADAPTERS[0].path, makeAdapterSource(["async loadTheme() { return 'auto'; },"]));
      write(ADAPTERS[1].path, makeAdapterSource(['send(message) { return post(message); },']));
    });
    try {
      let failure = null;
      try {
        execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
      } catch (err) {
        failure = err;
      }
      assert.ok(failure, 'the drifted tree must fail the check');
      assert.equal(failure.status, 1);
      // Read past the trailer's own line wrapping: what is held is the wording,
      // not where the lines break.
      const red = failure.stderr.replace(/\s+/g, ' ');
      assert.match(red, /✗ the platform-adapter seam drifted/);
      assert.ok(red.includes('`loadTheme`') && red.includes(ADAPTERS[1].path), red);
      assert.ok(red.includes(SC_CLAUSE_ID), red);
      assert.ok(red.includes('implement the member in the adapter that lacks it'), red);
      // The rule the sentence points at lives in the shared contract's own
      // header, so the trailer names that file rather than the adapters'.
      assert.ok(red.includes("under the admission rule the typedef's own header states"), red);
      assert.ok(red.includes(TYPEDEF_PATH), red);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
