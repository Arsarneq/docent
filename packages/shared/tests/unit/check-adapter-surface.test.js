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
 * that cannot be read. A refusal is held to be the whole report: a refused
 * surface yields no member list, and no member diff is derived from it. A
 * member only some platforms' callers need stays admitted, and a case holds
 * that admission on each adapter side. The decoy literals — a second top-level
 * literal, exported and not — are a demonstration rather than a guard: they
 * must never satisfy a typedef member. The real-tree lock and the CLI smoke
 * observe the shipped tree satisfying the contract.
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
  ADAPTERS,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  extractTypedefProperties,
  extractAdapterMembers,
  evaluateAdapterSurface,
  auditTree,
} from '../../../../scripts/check-adapter-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SCRIPT = resolve(ROOT, 'scripts', 'check-adapter-surface.js');
/** A path stood in for an adapter in the extractor-level fixtures. */
const FIXTURE_PATH = 'packages/fixture/adapter-fixture.js';

/** A consistent synthetic surface the contract accepts. */
function makeSurface(overrides = {}) {
  return {
    typedefProperties: ['send', 'loadTheme', 'hasNativeFileDialog'],
    // Each adapter carries one platform-specific member beyond the contract —
    // the shape the adapter file's header admission rule covers.
    chromeMembers: ['send', 'loadTheme', 'hasNativeFileDialog', 'loadStorageQuota'],
    tauriMembers: ['send', 'loadTheme', 'hasNativeFileDialog', 'getPendingActions'],
    ...overrides,
  };
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
    assert.deepEqual(evaluateAdapterSurface(makeSurface()), []);
  });
});

describe('evaluateAdapterSurface — the shared-member leg', () => {
  it('fires when every adapter implements a member the typedef does not declare', () => {
    const problems = evaluateAdapterSurface(
      makeSurface({
        chromeMembers: [...makeSurface().chromeMembers, 'loadWidget'],
        tauriMembers: [...makeSurface().tauriMembers, 'loadWidget'],
      }),
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
      const problems = evaluateAdapterSurface(makeSurface({ [key]: DUPLICATE_FIXTURES[key] }));
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
      const problems = evaluateAdapterSurface(makeSurface({ [key]: [] }));
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
    const problems = evaluateAdapterSurface(makeSurface({ typedefProperties: read.names }));
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
    const problems = evaluateAdapterSurface(makeSurface({ chromeMembers: read.names }));
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
    const problems = evaluateAdapterSurface(makeSurface({ tauriMembers: read.names }));
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

describe('the command-line wrapper', () => {
  it('exits 0 on the committed tree and reports the contract it held', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /adapter surface consistent/);
    assert.match(out, new RegExp(`${TYPEDEF_NAME} members`));
  });

  it('exits 1 on a drifted tree, naming the member and the routes that close it', () => {
    // The red output itself — exit code, the missing member, and the trailer's
    // fix routes — observed by running the wrapper against a tree where one
    // adapter lacks a declared member.
    const dir = mkdtempSync(join(tmpdir(), 'adapter-surface-'));
    try {
      const write = (path, content) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      };
      write(TYPEDEF_PATH, makeTypedefSource(['{() => Promise<string>} loadTheme']));
      write(ADAPTERS[0].path, makeAdapterSource(["async loadTheme() { return 'auto'; },"]));
      write(ADAPTERS[1].path, makeAdapterSource(['send(message) { return post(message); },']));

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
      assert.ok(red.includes("under the admission rule the adapter file's header states"), red);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
