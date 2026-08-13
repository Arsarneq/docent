/**
 * check-area-map.test.js — Unit tests for the area-map admission test
 * (scripts/check-area-map.js) that gates CI. The map is committed data, so
 * every way it can rot must fail loud. These tests drive the check over
 * synthetic maps and hold each red class of its audit result to the input that
 * earns it — the check's own module header is where that set lives and says
 * what each class holds, so this suite follows it rather than keeping a second
 * copy of the list. Beside the reds they pin the resolution the whole map rests
 * on: the pattern semantics that make "everything under a package belongs to
 * its area" total, the refusal the compile boundary raises for a map that does
 * not fit its shape (and the one posture every consumer prints it with), the
 * declared/expanded governing sets, and the command line — the per-file
 * explanation it prints on demand, and the arguments it declines to answer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  expandBraces,
  globToRegExp,
  compileAlternatives,
  extractDocPointers,
  validateShape,
  compileMap,
  patternEntries,
  recordDeadEntry,
  resolveFile,
  explainFile,
  auditMap,
  refuseOnShapeError,
  AreaMapShapeError,
  SHAPE_ERROR_NAME,
  STRADDLE_SAMPLE,
  MAP_PATH,
} from '../../../../scripts/check-area-map.js';

/** A minimal well-formed map two areas wide, for overriding per test. */
function makeMap(overrides = {}) {
  return {
    description: 'test map',
    'repo-wide': { description: 'x', docs: ['README.md'] },
    areas: {
      alpha: {
        code: ['packages/alpha/**'],
        docs: ['docs/alpha.md'],
      },
      tooling: {
        code: ['scripts/check-*.js', 'package.json'],
        docs: ['docs/tooling.md'],
      },
    },
    unassigned: [{ path: 'LICENSE', reason: 'license text' }],
    'declared-governance': [],
    'governance-partitions': [],
    ...overrides,
  };
}

/** Files that satisfy makeMap() exactly (every pattern live, every doc owned). */
const BASE_FILES = [
  'README.md',
  'docs/alpha.md',
  'docs/tooling.md',
  'packages/alpha/index.js',
  'scripts/check-something.js',
  'package.json',
  'LICENSE',
];

function audit({ map = makeMap(), files = BASE_FILES, contents = {} } = {}) {
  return auditMap({ files, map, readFile: (f) => contents[f] ?? null });
}

const flatten = (r) => Object.values(r).flat();

describe('globToRegExp — pattern semantics', () => {
  it('matches dotfiles under ** (ownership is by location, not filename shape)', () => {
    const re = globToRegExp('packages/alpha/**');
    assert.equal(re.test('packages/alpha/tests/.gitignore'), true);
    assert.equal(re.test('packages/alpha/.config/x.json'), true);
    assert.equal(re.test('packages/alpha/index.js'), true);
    assert.equal(re.test('packages/other/index.js'), false);
  });

  it('keeps * within one segment', () => {
    const re = globToRegExp('scripts/check-*.js');
    assert.equal(re.test('scripts/check-pr-title.js'), true);
    assert.equal(re.test('scripts/check-nested/x.js'), false);
  });

  it('lets a leading **/ match zero directories (root files included)', () => {
    const re = globToRegExp('**/playwright*.config.js');
    assert.equal(re.test('playwright.corpus.config.js'), true);
    assert.equal(re.test('packages/alpha/tests/playwright.config.js'), true);
    assert.equal(re.test('playwright/other.js'), false);
  });

  it('anchors a root dotfile pattern to a single segment', () => {
    const re = globToRegExp('.*');
    assert.equal(re.test('.editorconfig'), true);
    assert.equal(re.test('.github/workflows/test.yml'), false);
  });

  it('rejects unsupported pattern syntax instead of guessing', () => {
    assert.throws(() => globToRegExp('scripts/[ab].js'));
    assert.throws(() => globToRegExp('scripts/?.js'));
  });

  it('rejects ** embedded inside a segment (** is whole-segment only)', () => {
    assert.throws(() => globToRegExp('packages/**.js'));
    assert.throws(() => globToRegExp('a/b**/c.js'));
  });
});

describe('expandBraces', () => {
  it('expands alternation into brace-free patterns', () => {
    assert.deepEqual(expandBraces('a/{x,y-*}.js'), ['a/x.js', 'a/y-*.js']);
  });

  it('expands nested groups and leaves brace-free patterns alone', () => {
    assert.deepEqual(expandBraces('a/{x,{y,z}}.js'), ['a/x.js', 'a/y.js', 'a/z.js']);
    assert.deepEqual(expandBraces('plain.js'), ['plain.js']);
  });

  it('throws on unbalanced braces', () => {
    assert.throws(() => expandBraces('a/{x,y.js'));
  });
});

describe('compileAlternatives — the one compile idiom', () => {
  it('yields a matcher per alternative, each naming the pattern it came from', () => {
    const compiled = compileAlternatives('scripts/{check-*,gone-*}.js');
    assert.deepEqual(
      compiled.map((m) => m.alternative),
      ['scripts/check-*.js', 'scripts/gone-*.js'],
    );
    assert.deepEqual([...new Set(compiled.map((m) => m.pattern))], ['scripts/{check-*,gone-*}.js']);
    assert.equal(compiled[0].regex.test('scripts/check-area-map.js'), true);
    assert.equal(compiled[1].regex.test('scripts/check-area-map.js'), false);
  });

  it('refuses an unsupported pattern instead of compiling something else', () => {
    assert.throws(() => compileAlternatives('scripts/[ab].js'));
    assert.throws(() => compileAlternatives('a/{x,y.js'));
  });
});

describe('auditMap — green path', () => {
  it('reports nothing on a map that exactly covers its tree', () => {
    assert.deepEqual(flatten(audit()), []);
  });
});

describe('auditMap — coverage (a)', () => {
  it('flags a tracked file no area owns', () => {
    const r = audit({ files: [...BASE_FILES, 'orphan/nowhere.txt'] });
    assert.deepEqual(r.zeroArea, ['orphan/nowhere.txt']);
  });

  it('resolves a dotfile under a ** area glob (the matcher-semantics red path)', () => {
    const r = audit({ files: [...BASE_FILES, 'packages/alpha/tests/.gitignore'] });
    assert.deepEqual(r.zeroArea, []);
  });
});

describe('auditMap — staleness (b)', () => {
  it('flags a code pattern with no live alternative left as a stale entry', () => {
    const map = makeMap();
    map.areas.tooling.code = ['scripts/{gone-*,vanished-*}.js', 'package.json'];
    const r = audit({ map });
    assert.deepEqual(r.stalePatterns, [
      'area "tooling": pattern "scripts/{gone-*,vanished-*}.js" matches no tracked file',
    ]);
    // The entry is dead as a whole, so it is not ALSO reported alternative by
    // alternative — one entry, one verdict, one remedy.
    assert.deepEqual(r.deadAlternatives, []);
  });

  it('flags untracked doc, source-of-truth, and repo-wide entries', () => {
    const map = makeMap();
    map.areas.alpha.docs = ['docs/alpha.md', 'docs/moved-away.md'];
    map.areas.alpha['source-of-truth'] = ['schemas/gone.json'];
    map['repo-wide'].docs = ['README.md', 'docs/deleted-hub.md'];
    const r = audit({ map });
    assert.deepEqual(r.untrackedEntries.sort(), [
      'area "alpha": docs/moved-away.md',
      'area "alpha": schemas/gone.json',
      'repo-wide: docs/deleted-hub.md',
    ]);
  });
});

describe('auditMap — per-alternative liveness, in every list that states a pattern', () => {
  it('names a dead alternative of an area code pattern, and leaves the entry alone', () => {
    const map = makeMap();
    map.areas.tooling.code = ['scripts/{check-*,gone-*}.js', 'package.json'];
    const r = audit({ map });
    assert.deepEqual(flatten(r), [
      'area "tooling": pattern "scripts/{check-*,gone-*}.js" — alternative "scripts/gone-*.js" matches no tracked file',
    ]);
  });

  it('names a dead alternative of an "unassigned" exception the tree still needs', () => {
    // LICENSE resolves to no area, so the exception is genuinely needed and the
    // only thing wrong with the entry is the alternative that names nothing.
    const map = makeMap({
      unassigned: [{ path: '{LICENSE,GHOST}', reason: 'license text' }],
    });
    const r = audit({ map });
    assert.deepEqual(flatten(r), [
      '"unassigned" entry "{LICENSE,GHOST}" — alternative "GHOST" matches no tracked file',
    ]);
  });

  it('names a dead alternative of a "declared-governance" declaration', () => {
    const map = makeMap({
      'declared-governance': [
        {
          path: 'packages/alpha/{index.js,ghost.js}',
          reason: 'the alpha entry point',
          'governed-by': ['docs/tooling.md'],
        },
      ],
    });
    const r = audit({ map });
    assert.deepEqual(flatten(r), [
      '"declared-governance" entry "packages/alpha/{index.js,ghost.js}" — alternative "packages/alpha/ghost.js" matches no tracked file',
    ]);
  });

  it('names a dead alternative of a "governance-partitions" tree', () => {
    const map = makeMap({
      'governance-partitions': [{ pattern: 'packages/{alpha,ghost}/**', reason: 'alpha suites' }],
      'declared-governance': [
        { path: 'packages/alpha/**', reason: 'alpha suites', 'governed-by': ['area:alpha'] },
      ],
    });
    const r = audit({ map });
    assert.deepEqual(flatten(r), [
      '"governance-partitions" entry "packages/{alpha,ghost}/**" — alternative "packages/ghost/**" matches no tracked file',
    ]);
  });

  it('keeps the whole-entry verdict for an entry with no live alternative left', () => {
    // Each list keeps its own remedy for a dead entry — remove it — and none of
    // them also reports the alternatives it is dead through.
    const unassigned = audit({
      map: makeMap({ unassigned: [{ path: '{GHOST,PHANTOM}', reason: 'gone' }] }),
      // LICENSE is tracked but no longer excepted, so its own red rides along.
    });
    assert.deepEqual(unassigned.staleUnassigned, ['{GHOST,PHANTOM}']);
    assert.deepEqual(unassigned.deadAlternatives, []);

    const declared = audit({
      map: makeMap({
        'declared-governance': [{ path: 'gone/{a,b}.js', reason: 'x', 'governed-by': [] }],
      }),
    });
    assert.deepEqual(declared.staleGovernance, ['gone/{a,b}.js']);
    assert.deepEqual(declared.deadAlternatives, []);

    const partitions = audit({
      map: makeMap({
        'governance-partitions': [{ pattern: 'packages/{ghost,phantom}/**', reason: 'gone' }],
      }),
    });
    assert.deepEqual(partitions.stalePartitions, ['packages/{ghost,phantom}/**']);
    assert.deepEqual(partitions.deadAlternatives, []);
  });

  it('enumerates every pattern-bearing list, so a leg over patterns cannot skip one', () => {
    // patternEntries is what the liveness leg reads the map through: a list the
    // map grows that this enumeration does not name would be checked by nothing.
    // So the expectation is read off the COMPILED MAP rather than off
    // patternEntries' own output — every compiled list whose entries carry
    // matchers, plus the code entries each area carries, must turn up here.
    const compiled = compileMap(
      makeMap({
        'declared-governance': [
          { path: 'package.json', reason: 'the root manifest', 'governed-by': ['docs/alpha.md'] },
        ],
        'governance-partitions': [{ pattern: 'packages/alpha/**', reason: 'alpha suites' }],
      }),
    );
    const sites = patternEntries(compiled);
    const carriesMatchers = (v) =>
      Array.isArray(v) && v.length > 0 && v.every((e) => Array.isArray(e?.matchers));
    const compiledLists = [
      ...Object.entries(compiled).filter(([, v]) => carriesMatchers(v)),
      ...[...compiled.areas].map(([name, area]) => [`areas.${name}`, area.codeEntries]),
    ];
    // The fixture populates every pattern-bearing list the compiled map has, so
    // the coverage assertion below is answering about all of them.
    assert.deepEqual(compiledLists.map(([name]) => name).sort(), [
      'areas.alpha',
      'areas.tooling',
      'declaredGovernance',
      'partitions',
      'unassigned',
    ]);
    const enumerated = new Set(sites.map((s) => s.matchers));
    for (const [name, entries] of compiledLists) {
      for (const entry of entries) {
        assert.equal(enumerated.has(entry.matchers), true, `${name}: entry not enumerated`);
      }
    }
    // The labels and subjects the reds are printed under.
    assert.deepEqual([...new Set(sites.map((s) => s.list))].sort(), [
      'areas',
      'declared-governance',
      'governance-partitions',
      'unassigned',
    ]);
    const areaEntry = sites.find((s) => s.entry === 'scripts/check-*.js');
    assert.equal(areaEntry.subject, 'area "tooling": pattern "scripts/check-*.js"');
    assert.deepEqual(
      areaEntry.matchers.map((m) => m.alternative),
      ['scripts/check-*.js'],
    );
  });

  it('refuses a dead entry from a list the whole-entry verdict does not answer for', () => {
    // The whole-entry dispatch names every list patternEntries states — the two
    // it reports and the two it hands to their own accounting. A list the map
    // grows that reaches it unnamed is a programming error in this check, not
    // map rot, so it fails loudly instead of dropping that list's dead entries.
    const result = { stalePatterns: [], stalePartitions: [] };
    assert.throws(
      () =>
        recordDeadEntry(
          { list: 'future-list', entry: 'x/**', subject: '"future-list" entry' },
          result,
        ),
      /no whole-entry verdict for pattern list "future-list"/,
    );
    assert.deepEqual(result, { stalePatterns: [], stalePartitions: [] });
    // The named lists: two report here, two delegate and record nothing.
    recordDeadEntry({ list: 'areas', entry: 'a/**', subject: 'area "a": pattern "a/**"' }, result);
    recordDeadEntry({ list: 'governance-partitions', entry: 'p/**', subject: 'x' }, result);
    recordDeadEntry({ list: 'unassigned', entry: 'u', subject: 'x' }, result);
    recordDeadEntry({ list: 'declared-governance', entry: 'd', subject: 'x' }, result);
    assert.deepEqual(result, {
      stalePatterns: ['area "a": pattern "a/**" matches no tracked file'],
      stalePartitions: ['p/**'],
    });
  });
});

describe('auditMap — doc coverage (c)', () => {
  it("flags a tracked doc under docs/ that no area's doc set contains", () => {
    const r = audit({ files: [...BASE_FILES, 'docs/unowned-doctrine.md'] });
    assert.deepEqual(r.uncoveredDocs, ['docs/unowned-doctrine.md']);
  });

  it('does not flag a repo-wide doc under docs/', () => {
    const map = makeMap();
    map['repo-wide'].docs = ['README.md', 'docs/hub.md'];
    const r = audit({ map, files: [...BASE_FILES, 'docs/hub.md'] });
    assert.deepEqual(r.uncoveredDocs, []);
  });

  it('flags a tracked .md OUTSIDE docs/ with no doc home (coverage is repo-wide)', () => {
    // Owned as code (matches alpha's glob) but placed in no doc set — code
    // membership is not a doc home, so (c) still fires and (a) does not.
    const r = audit({ files: [...BASE_FILES, 'packages/alpha/GUIDE.md'] });
    assert.deepEqual(r.uncoveredDocs, ['packages/alpha/GUIDE.md']);
    assert.deepEqual(r.zeroArea, []);
  });

  it('exempts a .md an unassigned entry covers, and counts that entry as needed', () => {
    // A code-covered .md whose only home is an exception: exempt from (c), and
    // the exception is genuinely needed — without it the doc is uncovered —
    // even though the file also resolves to an area as code (the needed-fix).
    const map = makeMap();
    map.unassigned.push({ path: 'packages/alpha/NOTES.md', reason: 'impl note, not doctrine' });
    const r = audit({ map, files: [...BASE_FILES, 'packages/alpha/NOTES.md'] });
    assert.deepEqual(r.uncoveredDocs, []);
    assert.deepEqual(r.unnecessaryUnassigned, []);
    assert.deepEqual(r.staleUnassigned, []);
  });

  it('still flags a redundant exception on an already doc-placed .md as unnecessary', () => {
    // Contrast: a doc-set .md ALSO listed unassigned does no work — the
    // needed-fix must not mask a genuinely unnecessary exception.
    const map = makeMap();
    map.unassigned.push({ path: 'docs/alpha.md', reason: 'redundant with the alpha doc set' });
    const r = audit({ map });
    assert.deepEqual(r.unnecessaryUnassigned, ['docs/alpha.md']);
  });

  it('counts a GLOB exception as needed via a code-owned .md it covers', () => {
    // The real map exercises this (packages/shared/assets/** → reading-guidance.md);
    // pin it synthetically. The glob also matches a code file (index.js) that is
    // NOT needed — the entry earns its keep solely through the .md's doc-home gap.
    const map = makeMap();
    map.unassigned.push({ path: 'packages/alpha/**', reason: 'alpha notes, not doctrine' });
    const r = audit({ map, files: [...BASE_FILES, 'packages/alpha/NOTES.md'] });
    assert.deepEqual(r.uncoveredDocs, []);
    assert.deepEqual(r.unnecessaryUnassigned, []);
    assert.deepEqual(r.staleUnassigned, []);
  });
});

describe('docs-only areas (no code)', () => {
  /** makeMap plus a code-less area that owns one doc. */
  function withDocsOnly() {
    const map = makeMap();
    map.areas.business = { docs: ['docs/positioning.md'] };
    return map;
  }

  it('validateShape accepts an area with a non-empty doc set and no code', () => {
    assert.deepEqual(validateShape(withDocsOnly()), []);
  });

  it('validateShape rejects an area that owns neither code nor docs', () => {
    const map = makeMap();
    map.areas.hollow = { code: [], docs: [] };
    const errors = validateShape(map);
    assert.equal(
      errors.some((e) => e.includes('hollow') && e.includes('must own')),
      true,
    );
  });

  it('validateShape accepts a code-only area (code present, no docs key)', () => {
    // The symmetric half of docs-only areas: making `docs` optional lets an
    // area own only code — the shape a future doc-set-free resolution class
    // leans on. (Coverage/staleness of its patterns is a separate check.)
    const map = makeMap();
    map.areas.codeOnly = { code: ['packages/beta/**'] };
    assert.deepEqual(validateShape(map), []);
  });

  it('compileMap and resolveFile place a docs-only area doc without touching code', () => {
    const compiled = compileMap(withDocsOnly());
    const r = resolveFile('docs/positioning.md', compiled);
    assert.deepEqual(r.areas, ['business']);
    assert.deepEqual(r.docs, ['docs/positioning.md']);
    // No code pattern, so nothing else resolves to the code-less area.
    assert.deepEqual(resolveFile('packages/alpha/index.js', compiled).areas, ['alpha']);
  });

  it('auditMap is clean when a docs-only area covers its tracked doc', () => {
    const r = audit({ map: withDocsOnly(), files: [...BASE_FILES, 'docs/positioning.md'] });
    assert.deepEqual(flatten(r), []);
  });
});

describe('auditMap — unassigned exceptions (d, self-failing)', () => {
  it('flags an entry matching no tracked file as stale', () => {
    const map = makeMap();
    map.unassigned.push({ path: 'REMOVED-FILE', reason: 'gone' });
    const r = audit({ map });
    assert.deepEqual(r.staleUnassigned, ['REMOVED-FILE']);
  });

  it('flags an entry as unnecessary once every matched file resolves to an area', () => {
    const map = makeMap();
    map.unassigned.push({ path: 'packages/alpha/vendored.txt', reason: 'covered anyway' });
    const r = audit({ map, files: [...BASE_FILES, 'packages/alpha/vendored.txt'] });
    assert.deepEqual(r.unnecessaryUnassigned, ['packages/alpha/vendored.txt']);
  });
});

describe('auditMap — doc pointers', () => {
  it('rescues an otherwise unowned file whose pointer names an owned doc', () => {
    const r = audit({
      files: [...BASE_FILES, 'tools/standalone.rs'],
      contents: { 'tools/standalone.rs': 'fn main() {}\n// see docs/alpha.md\n' },
    });
    assert.deepEqual(r.zeroArea, []);
    assert.deepEqual(r.badPointers, []);
  });

  it('flags a pointer at an untracked doc', () => {
    const r = audit({
      files: [...BASE_FILES, 'tools/standalone.rs'],
      contents: { 'tools/standalone.rs': '// see docs/never-existed.md\n' },
    });
    assert.deepEqual(r.badPointers, [
      'tools/standalone.rs points at untracked doc docs/never-existed.md',
    ]);
    assert.deepEqual(r.zeroArea, ['tools/standalone.rs']);
  });

  it("flags a pointer at a doc in no area's doc set", () => {
    const r = audit({
      files: [...BASE_FILES, 'docs/unowned-doctrine.md', 'tools/standalone.rs'],
      contents: { 'tools/standalone.rs': '// see docs/unowned-doctrine.md\n' },
    });
    assert.deepEqual(r.badPointers, [
      "tools/standalone.rs points at docs/unowned-doctrine.md, which is in no area's doc set",
    ]);
  });
});

describe('validateShape — malformed maps fail loud', () => {
  it('requires a description, literal doc paths, and justified exceptions', () => {
    const bad = makeMap({ description: '' });
    bad.areas.alpha.docs = ['docs/*.md'];
    bad.unassigned = [{ path: 'LICENSE', reason: '   ' }];
    const errors = validateShape(bad);
    assert.equal(
      errors.some((e) => e.includes('description')),
      true,
    );
    assert.equal(
      errors.some((e) => e.includes('not a literal path')),
      true,
    );
    assert.equal(
      errors.some((e) => e.includes('no reason')),
      true,
    );
  });

  it('rejects duplicate doc entries and unsupported patterns', () => {
    const bad = makeMap();
    bad.areas.alpha.docs = ['docs/alpha.md', 'docs/alpha.md'];
    bad.areas.tooling.code = ['scripts/[ab].js'];
    const errors = validateShape(bad);
    assert.equal(
      errors.some((e) => e.includes('duplicates')),
      true,
    );
    assert.equal(
      errors.some((e) => e.includes('unsupported pattern syntax')),
      true,
    );
  });

  it('rejects a defined-but-non-array code or docs', () => {
    const bad = makeMap();
    bad.areas.alpha.code = 'packages/alpha/**';
    bad.areas.tooling.docs = 'docs/tooling.md';
    const errors = validateShape(bad);
    assert.equal(
      errors.some((e) => e.includes('"code" must be an array')),
      true,
    );
    assert.equal(
      errors.some((e) => e.includes('"docs" must be an array')),
      true,
    );
  });

  it('short-circuits auditMap on shape errors', () => {
    const r = audit({ map: { description: 'x' } });
    assert.notEqual(r.shapeErrors.length, 0);
    assert.deepEqual(r.zeroArea, []);
  });
});

describe('compileMap — shape-validity is enforced at the boundary', () => {
  /** Partitions in the pre-object string form: a shape error, not a pattern. */
  const stringFormPartitions = () => makeMap({ 'governance-partitions': ['packages/alpha/**'] });

  /** Run `fn`, returning whatever it threw. */
  const thrownBy = (fn) => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return null;
  };

  it('refuses a shape-invalid map with a named error naming the entry it choked on', () => {
    // Before the precondition was enforced, this reached the glob machinery and
    // surfaced as a TypeError about an undefined property — a verdict about the
    // check's internals rather than about the map handed to it.
    const err = thrownBy(() => compileMap(stringFormPartitions()));
    assert.equal(err instanceof AreaMapShapeError, true);
    assert.equal(err.name, SHAPE_ERROR_NAME);
    assert.notEqual(err.name, 'TypeError');
    assert.equal(err.message.includes(MAP_PATH), true);
    assert.match(err.message, /governance-partitions/);
    assert.match(err.message, /packages\/alpha/);
  });

  it('carries every error the shape validator reports for that map', () => {
    const bad = stringFormPartitions();
    bad.description = '';
    bad.unassigned = [{ path: 'LICENSE', reason: '   ' }];
    const errors = validateShape(bad);
    const err = thrownBy(() => compileMap(bad));
    assert.deepEqual(err.shapeErrors, errors); // the same shape implementation, not a second one
    for (const e of errors) assert.equal(err.message.includes(e), true, e);
  });

  it('compiles a shape-valid map without complaint', () => {
    assert.equal(
      thrownBy(() => compileMap(makeMap())),
      null,
    );
  });
});

describe('refuseOnShapeError — one refusal posture for every consumer of the map', () => {
  /** Collectors standing in for the printing and exiting seams. */
  const seams = () => {
    const printed = [];
    const exited = [];
    return { printed, exited, io: { error: (m) => printed.push(m), exit: (c) => exited.push(c) } };
  };

  it('prints the refusal message and ends red', () => {
    const s = seams();
    refuseOnShapeError(new AreaMapShapeError(['"areas" must be a non-empty object']), s.io);
    assert.equal(s.printed.length, 1);
    assert.equal(s.printed[0].includes(MAP_PATH), true);
    assert.match(s.printed[0], /"areas" must be a non-empty object/);
    assert.deepEqual(s.exited, [1]);
  });

  it('rethrows anything else untouched, printing nothing and ending nothing', () => {
    // A map that will not parse, a bug inside a leg: not this refusal's subject,
    // so it leaves as it arrived rather than being reported as a shape verdict.
    const s = seams();
    const other = new SyntaxError('Unexpected token } in JSON at position 12');
    assert.throws(
      () => refuseOnShapeError(other, s.io),
      (e) => e === other,
    );
    assert.deepEqual(s.printed, []);
    assert.deepEqual(s.exited, []);
  });
});

describe('resolveFile', () => {
  it('resolves via code patterns, doc-set membership, and pointers — and returns the governing docs', () => {
    const compiled = compileMap(makeMap());
    const viaPattern = resolveFile('packages/alpha/x.js', compiled);
    assert.deepEqual(viaPattern.areas, ['alpha']);
    assert.deepEqual(viaPattern.docs, ['docs/alpha.md']);
    assert.deepEqual(resolveFile('docs/tooling.md', compiled).areas, ['tooling']);
    const withPointer = resolveFile('elsewhere/y.rs', compiled, '// see docs/alpha.md');
    assert.deepEqual(withPointer.areas, ['alpha']);
    assert.deepEqual(withPointer.docs, ['docs/alpha.md']);
    assert.deepEqual(withPointer.pointerTargets, ['docs/alpha.md']);
  });

  it('reports repo-wide and unassigned membership', () => {
    const compiled = compileMap(makeMap());
    assert.equal(resolveFile('README.md', compiled).repoWide, true);
    assert.equal(resolveFile('LICENSE', compiled).unassigned, true);
    assert.equal(resolveFile('packages/alpha/x.js', compiled).unassigned, false);
  });
});

describe('explainFile — what the map says about one file', () => {
  const compiled = () =>
    compileMap(
      makeMap({
        'declared-governance': [
          {
            path: 'package.json',
            reason: 'the root manifest',
            'governed-by': ['area:alpha', 'docs/tooling.md'],
          },
        ],
      }),
    );

  it('reports an undeclared file: its areas, its governing docs, and that no entry declares it', () => {
    const text = explainFile({
      file: 'packages/alpha/index.js',
      compiled: compiled(),
      tracked: true,
    });
    assert.match(text, /^packages\/alpha\/index\.js$/m);
    assert.match(text, /areas: alpha/);
    assert.match(text, /governing docs: docs\/alpha\.md/);
    assert.match(text, /declared by: no entry/);
    assert.match(text, /repo-wide doc: no/);
    assert.match(text, /unassigned exception: no/);
    assert.match(text, /doc pointers: none/);
  });

  it('reports a declared file: the entry, what it states, and the set that expands to', () => {
    const text = explainFile({ file: 'package.json', compiled: compiled(), tracked: true });
    assert.match(text, /declared by: package\.json/);
    assert.match(text, /governed-by as written: area:alpha, docs\/tooling\.md/);
    assert.match(text, /expanded doc set: docs\/alpha\.md, docs\/tooling\.md/);
  });

  it('reports a file in a partitioned tree that declares nothing as owing its own declaration', () => {
    // The partition's answer is that the file states its own subject, so the
    // report must not hand back the docs its areas supply as the governing set
    // — that is the answer the partition forbids, and the same file reds under
    // auditMap's undeclared-in-partition class.
    const reason = 'The alpha suites sit under two tree-wide code patterns at once.';
    const map = makeMap({
      'governance-partitions': [{ pattern: 'packages/alpha/**', reason }],
    });
    const text = explainFile({
      file: 'packages/alpha/index.js',
      compiled: compileMap(map),
      tracked: true,
    });
    assert.match(text, /in a partitioned tree: "packages\/alpha\/\*\*": /);
    assert.equal(text.includes(reason), true);
    assert.match(text, /owes a "declared-governance" entry/);
    assert.doesNotMatch(text, /governing docs: docs\/alpha\.md/);
    assert.doesNotMatch(text, /the docs above are what its areas supply/);
    // The red the same input earns, which the report is now consistent with.
    assert.equal(audit({ map }).undeclaredInPartition.length, 1);
  });

  it('keeps the declaration report for a declared file inside a partitioned tree', () => {
    const map = makeMap({
      'governance-partitions': [{ pattern: 'packages/alpha/**', reason: 'alpha suites' }],
      'declared-governance': [
        { path: 'packages/alpha/**', reason: 'the alpha suites', 'governed-by': ['area:alpha'] },
      ],
    });
    const text = explainFile({
      file: 'packages/alpha/index.js',
      compiled: compileMap(map),
      tracked: true,
    });
    assert.match(text, /in a partitioned tree: "packages\/alpha\/\*\*": alpha suites/);
    assert.match(text, /governing docs: docs\/alpha\.md/);
    assert.match(text, /declared by: packages\/alpha\/\*\*/);
    assert.doesNotMatch(text, /owes a "declared-governance" entry/);
  });

  it('qualifies a repo-wide doc instead of reporting it as governed by nothing', () => {
    // README.md sits in no area's doc set, so its own governing set is empty —
    // an unqualified "none" would read as ungoverned, when what the map states
    // is that this file governs every area and enters its own edit's scope.
    const text = explainFile({ file: 'README.md', compiled: compiled(), tracked: true });
    assert.doesNotMatch(text, /^ {2}governing docs: none$/m);
    assert.match(text, /governing docs: none \(and it is itself a repo-wide doc — below\)/);
    assert.match(text, /repo-wide doc: yes — a repo-wide doc governs every area/);
    assert.match(text, /puts it in its own disposition scope/);
  });

  it('reports repo-wide and exception membership, and the pointers a file names', () => {
    assert.match(
      explainFile({ file: 'README.md', compiled: compiled(), tracked: true }),
      /repo-wide doc: yes/,
    );
    assert.match(
      explainFile({ file: 'LICENSE', compiled: compiled(), tracked: true }),
      /unassigned exception: yes/,
    );
    const pointed = explainFile({
      file: 'tools/standalone.rs',
      compiled: compiled(),
      tracked: true,
      content: '// see docs/alpha.md\n',
    });
    assert.match(pointed, /doc pointers: docs\/alpha\.md/);
    assert.match(pointed, /areas: alpha/); // the pointer is what puts it in one
  });

  it('reports an untracked path as untracked instead of resolving it', () => {
    const text = explainFile({
      file: 'packages/alpha/ghost.js',
      compiled: compiled(),
      tracked: false,
    });
    assert.match(text, /untracked/);
    assert.doesNotMatch(text, /areas:/); // nothing is guessed for a path the tree does not carry
  });
});

describe('extractDocPointers', () => {
  it('extracts and deduplicates pointer targets', () => {
    const content = '// see docs/a.md\ncode();\n//see docs/b.md\n// see docs/a.md\n';
    assert.deepEqual(extractDocPointers(content), ['docs/a.md', 'docs/b.md']);
  });

  it('ignores non-doc references', () => {
    assert.deepEqual(extractDocPointers('// see scripts/build.js and docs online'), []);
  });
});

describe('validateShape — declared-governance', () => {
  it('accepts entries with a populated and an empty governed-by', () => {
    const map = makeMap();
    map['declared-governance'] = [
      { path: 'codecov.yml', reason: 'Codecov config', 'governed-by': ['docs/alpha.md'] },
      { path: 'data.json', reason: 'pure data', 'governed-by': [] },
    ];
    assert.deepEqual(validateShape(map), []);
  });

  it('rejects a missing/non-array governed-by, non-literal targets, empty reason, bad pattern', () => {
    const bad = (dg) => validateShape(makeMap({ 'declared-governance': dg }));
    // entry with no path
    assert.equal(
      bad([{ reason: 'x', 'governed-by': [] }]).some((e) => e.includes('missing "path"')),
      true,
    );
    // governed-by omitted entirely
    assert.equal(
      bad([{ path: 'a.yml', reason: 'x' }]).some(
        (e) => e.includes('governed-by') && e.includes('must be present'),
      ),
      true,
    );
    // governed-by present but not an array
    assert.equal(
      bad([{ path: 'a.yml', reason: 'x', 'governed-by': 'docs/alpha.md' }]).some(
        (e) => e.includes('governed-by') && e.includes('must be present'),
      ),
      true,
    );
    // governed-by holds a non-literal (pattern) path
    assert.equal(
      bad([{ path: 'a.yml', reason: 'x', 'governed-by': ['docs/*.md'] }]).some((e) =>
        e.includes('not a literal path'),
      ),
      true,
    );
    // empty reason
    assert.equal(
      bad([{ path: 'a.yml', reason: '   ', 'governed-by': [] }]).some((e) =>
        e.includes('no reason'),
      ),
      true,
    );
    // uncompilable path glob (caught here so compileMap is never reached with it)
    assert.equal(
      bad([{ path: 'scripts/[ab].js', reason: 'x', 'governed-by': [] }]).some((e) =>
        e.includes('unsupported pattern syntax'),
      ),
      true,
    );
  });

  it('requires the declared-governance array to be present', () => {
    const map = makeMap();
    delete map['declared-governance'];
    assert.equal(
      validateShape(map).some((e) => e.includes('"declared-governance" must be an array')),
      true,
    );
  });
});

describe('resolveFile — declared-governance', () => {
  /** makeMap plus one declared entry over a code-owned file. */
  function declMap(rawGovernedBy) {
    return makeMap({
      'declared-governance': [
        { path: 'packages/alpha/x.yml', reason: 'alpha config', 'governed-by': rawGovernedBy },
      ],
    });
  }

  it("a declared file's docs are exactly its governed-by — area docs and a // see pointer do not apply", () => {
    const compiled = compileMap(declMap(['docs/tooling.md']));
    // packages/alpha/x.yml matches alpha's code glob (areaSupplied = [docs/alpha.md]) and carries a
    // live pointer to docs/alpha.md — yet the declaration overrides both to exactly governed-by.
    const r = resolveFile('packages/alpha/x.yml', compiled, '// see docs/alpha.md');
    assert.equal(r.declaredGovernance, true);
    assert.deepEqual(r.docs, ['docs/tooling.md']); // the declared set verbatim, not alpha.md nor the pointer
    assert.deepEqual(r.expandedGovernedBy, ['docs/tooling.md']);
    assert.deepEqual(r.rawGovernedBy, ['docs/tooling.md']); // no reference to expand: raw equals expanded
    assert.deepEqual(r.declaredEntryPaths, ['packages/alpha/x.yml']);
    assert.deepEqual(r.areaSuppliedDocs, ['docs/alpha.md']); // bare code-area docs, pre-override
    assert.deepEqual(r.areas, ['alpha']); // coverage preserved (declaration grants no coverage of its own)
  });

  it('a declared file with governed-by [] resolves to no governing docs', () => {
    const compiled = compileMap(declMap([]));
    const r = resolveFile('packages/alpha/x.yml', compiled);
    assert.equal(r.declaredGovernance, true);
    assert.deepEqual(r.docs, []);
    assert.deepEqual(r.expandedGovernedBy, []);
    assert.deepEqual(r.rawGovernedBy, []);
    assert.deepEqual(r.areaSuppliedDocs, ['docs/alpha.md']);
  });

  it('a non-declared file resolves byte-identically (declared-governance is inert for it)', () => {
    const compiled = compileMap(declMap(['docs/tooling.md']));
    const r = resolveFile('packages/alpha/index.js', compiled);
    assert.equal(r.declaredGovernance, false);
    assert.deepEqual(r.areas, ['alpha']);
    assert.deepEqual(r.docs, ['docs/alpha.md']);
  });
});

describe('auditMap — declared-governance', () => {
  it('is clean with a working declaration (governed-by differs from the area-supplied docs)', () => {
    // package.json is code-owned by tooling (areaSupplied [docs/tooling.md]); declaring it governed by
    // docs/alpha.md changes the set → load-bearing, so no stale/redundant/etc.
    const map = makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'manifest', 'governed-by': ['docs/alpha.md'] },
      ],
    });
    assert.deepEqual(flatten(audit({ map })), []);
  });

  it('flags a declaration that matches no tracked file as stale', () => {
    const map = makeMap({
      'declared-governance': [{ path: 'gone/nothing-*.foo', reason: 'x', 'governed-by': [] }],
    });
    assert.deepEqual(audit({ map }).staleGovernance, ['gone/nothing-*.foo']);
  });

  it('flags a non-empty declaration equal to the area-supplied docs as redundant', () => {
    const map = makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'x', 'governed-by': ['docs/tooling.md'] },
      ],
    });
    const r = audit({ map });
    assert.deepEqual(r.redundantGovernance, ['package.json']);
  });

  it('order-insensitively equates governed-by with area-supplied docs (set compare)', () => {
    // A file owned by two areas so its area-supplied set has two docs in a fixed order; a declaration
    // listing them reversed still counts as redundant.
    const map = makeMap();
    map.areas.beta = { code: ['packages/alpha/**'], docs: ['docs/beta.md'] }; // co-owns alpha files
    map['declared-governance'] = [
      {
        path: 'packages/alpha/index.js',
        reason: 'x',
        'governed-by': ['docs/beta.md', 'docs/alpha.md'],
      },
    ];
    const r = audit({ map, files: [...BASE_FILES, 'docs/beta.md'] });
    assert.deepEqual(r.redundantGovernance, ['packages/alpha/index.js']);
  });

  it('never flags an explicit empty pin as redundant — even when the area supplies no docs', () => {
    const map = makeMap();
    map.areas.codeonly = { code: ['vendor/**'] }; // code-only area, no docs
    map['declared-governance'] = [{ path: 'vendor/thing.bin', reason: 'x', 'governed-by': [] }];
    const r = audit({ map, files: [...BASE_FILES, 'vendor/thing.bin'] });
    assert.deepEqual(r.redundantGovernance, []); // [] == [] area docs, but an empty pin is kept
    assert.deepEqual(r.staleGovernance, []);
    assert.deepEqual(r.zeroArea, []); // covered by the code-only area
  });

  it('an empty pin over a doc-bearing area (the shipped data/CI-test shape) is neither stale nor redundant', () => {
    // package.json's covering area (tooling) supplies docs/tooling.md; pinning it to [] drops that
    // doc from scope — load-bearing, so not redundant, and it matches a file, so not stale.
    const map = makeMap({
      'declared-governance': [{ path: 'package.json', reason: 'data', 'governed-by': [] }],
    });
    const r = audit({ map });
    assert.deepEqual(r.redundantGovernance, []);
    assert.deepEqual(r.staleGovernance, []);
  });

  it('flags a file declared by two entries as a conflict and skips its per-file evaluation', () => {
    const map = makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'a', 'governed-by': ['docs/tooling.md'] }, // would be redundant alone
        { path: 'package.json', reason: 'b', 'governed-by': ['docs/alpha.md'] },
      ],
    });
    const r = audit({ map });
    assert.deepEqual(r.conflictingGovernance, ['package.json']);
    // redundancy is skipped for the conflicted file, so the otherwise-redundant entry is NOT flagged
    assert.deepEqual(r.redundantGovernance, []);
  });

  it('flags a declared repo-wide doc, and a declared file with a live // see pointer, as cross-governed', () => {
    const repoWide = makeMap({
      'declared-governance': [{ path: 'README.md', reason: 'x', 'governed-by': [] }],
    });
    assert.deepEqual(audit({ map: repoWide }).crossGovernedDeclaration, ['README.md']);

    const livePointer = makeMap({
      'declared-governance': [
        { path: 'packages/alpha/y.rs', reason: 'x', 'governed-by': ['docs/alpha.md'] },
      ],
    });
    const r = audit({
      map: livePointer,
      files: [...BASE_FILES, 'packages/alpha/y.rs'],
      contents: { 'packages/alpha/y.rs': '// see docs/tooling.md\n' }, // tooling.md is in a live doc set
    });
    assert.deepEqual(r.crossGovernedDeclaration, ['packages/alpha/y.rs']);
  });

  it('does NOT flag a declared file whose // see target is in no doc set (dead fixture pointer)', () => {
    const map = makeMap({
      'declared-governance': [
        { path: 'packages/alpha/z.rs', reason: 'x', 'governed-by': ['docs/alpha.md'] },
      ],
    });
    const r = audit({
      map,
      files: [...BASE_FILES, 'packages/alpha/z.rs'],
      contents: { 'packages/alpha/z.rs': '// see docs/never-real.md\n' }, // target in no doc set
    });
    assert.deepEqual(r.crossGovernedDeclaration, []);
  });

  it('badGovernedBy rejects an untracked target but accepts a repo-wide doc', () => {
    const untracked = makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'x', 'governed-by': ['docs/nope.md'] },
      ],
    });
    assert.equal(
      audit({ map: untracked }).badGovernedBy.some((s) => s.includes('docs/nope.md')),
      true,
    );
    // README.md is repo-wide (in no area doc set) — a legitimate governor, not badGovernedBy.
    const repoWideGov = makeMap({
      'declared-governance': [{ path: 'package.json', reason: 'x', 'governed-by': ['README.md'] }],
    });
    assert.deepEqual(audit({ map: repoWideGov }).badGovernedBy, []);
    // A tracked target that is in no area doc set and not repo-wide is homeless → badGovernedBy.
    const homeless = makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'x', 'governed-by': ['scripts/check-something.js'] },
      ],
    });
    assert.equal(
      audit({ map: homeless }).badGovernedBy.some(
        (s) => s.includes('scripts/check-something.js') && s.includes('no area'),
      ),
      true,
    );
  });
});

describe('validateShape — area references in governed-by', () => {
  /** makeMap with one declared entry over package.json carrying the given elements. */
  const withGov = (rawGovernedBy) =>
    makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'the root manifest', 'governed-by': rawGovernedBy },
      ],
    });

  it('accepts an area reference beside literal doc paths', () => {
    assert.deepEqual(validateShape(withGov(['area:alpha', 'docs/tooling.md'])), []);
  });

  it('rejects a reference to an area the map does not define', () => {
    assert.equal(
      validateShape(withGov(['area:ghost'])).some(
        (e) => e.includes('area:ghost') && e.includes('does not define'),
      ),
      true,
    );
  });

  it('rejects a reference to an area that carries no docs', () => {
    // An area with no doc set expands to nothing, so the reference would state
    // an emptiness the entry should state itself — with [] or literal paths.
    const map = withGov(['area:codeonly']);
    map.areas.codeonly = { code: ['vendor/**'] };
    assert.equal(
      validateShape(map).some((e) => e.includes('area:codeonly') && e.includes('carries no docs')),
      true,
    );
  });
});

describe('resolveFile — area references expand to the area doc set', () => {
  it('expands a reference to its area docs, unioned with the literal extras', () => {
    const map = makeMap({
      'declared-governance': [
        {
          path: 'package.json',
          reason: 'the root manifest',
          'governed-by': ['area:alpha', 'docs/tooling.md'],
        },
      ],
    });
    const r = resolveFile('package.json', compileMap(map));
    assert.deepEqual(r.docs.sort(), ['docs/alpha.md', 'docs/tooling.md']);
    assert.deepEqual(r.expandedGovernedBy.sort(), ['docs/alpha.md', 'docs/tooling.md']);
    // The raw elements stay as the map states them — the reference, unexpanded.
    assert.deepEqual(r.rawGovernedBy, ['area:alpha', 'docs/tooling.md']);
  });

  it('deduplicates a literal the referenced area already supplies', () => {
    const map = makeMap({
      'declared-governance': [
        {
          path: 'package.json',
          reason: 'the root manifest',
          'governed-by': ['area:alpha', 'docs/alpha.md'],
        },
      ],
    });
    assert.deepEqual(resolveFile('package.json', compileMap(map)).docs, ['docs/alpha.md']);
  });
});

describe('auditMap — area references in governed-by', () => {
  it('accepts an area reference as a governed-by target', () => {
    const map = makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'the root manifest', 'governed-by': ['area:alpha'] },
      ],
    });
    assert.deepEqual(audit({ map }).badGovernedBy, []);
  });

  it('reads the EXPANSION when judging redundancy, not the reference token', () => {
    // package.json's covering area is tooling, whose doc set is exactly what
    // `area:tooling` expands to — so the declaration states nothing new. A
    // redundancy verdict comparing raw tokens would go dark here.
    const map = makeMap({
      'declared-governance': [
        { path: 'package.json', reason: 'the root manifest', 'governed-by': ['area:tooling'] },
      ],
    });
    assert.deepEqual(audit({ map }).redundantGovernance, ['package.json']);
  });
});

describe('validateShape — governance partitions', () => {
  it('requires the governance-partitions array to be present', () => {
    const map = makeMap();
    delete map['governance-partitions'];
    assert.equal(
      validateShape(map).some((e) => e.includes('"governance-partitions" must be an array')),
      true,
    );
  });

  it('accepts a { pattern, reason } partition entry', () => {
    const map = makeMap({
      'governance-partitions': [{ pattern: 'packages/alpha/**', reason: 'alpha suites' }],
    });
    assert.deepEqual(validateShape(map), []);
  });

  it('rejects an empty or uncompilable partition pattern', () => {
    assert.equal(
      validateShape(
        makeMap({
          'governance-partitions': [{ pattern: 'packages/[ab]/**', reason: 'x' }],
        }),
      ).some((e) => e.includes('unsupported pattern syntax')),
      true,
    );
    assert.equal(
      validateShape(makeMap({ 'governance-partitions': [{ pattern: '', reason: 'x' }] })).some(
        (e) => e.includes('governance-partitions') && e.includes('missing "pattern"'),
      ),
      true,
    );
  });

  it('rejects a bare-string partition and one with no reason', () => {
    // The element shape is an object naming the tree and recording why its
    // files declare one by one — a bare pattern states no reason at all.
    assert.equal(
      validateShape(makeMap({ 'governance-partitions': ['packages/alpha/**'] })).some((e) =>
        e.includes('missing "pattern"'),
      ),
      true,
    );
    assert.equal(
      validateShape(
        makeMap({ 'governance-partitions': [{ pattern: 'packages/alpha/**', reason: '   ' }] }),
      ).some((e) => e.includes('has no reason')),
      true,
    );
  });
});

describe('auditMap — governance partitions', () => {
  /** makeMap with packages/alpha/** partitioned, plus the declarations to test. */
  const partMap = (declared = []) =>
    makeMap({
      'governance-partitions': [{ pattern: 'packages/alpha/**', reason: 'alpha suites' }],
      'declared-governance': declared,
    });

  /** A declaration over the whole partitioned tree, expansion-equal to its area. */
  const equalSetDeclaration = [
    { path: 'packages/alpha/**', reason: 'alpha suites', 'governed-by': ['area:alpha'] },
  ];

  it('flags a file inside a partitioned tree that declares no governance', () => {
    assert.deepEqual(audit({ map: partMap() }).undeclaredInPartition, [
      'packages/alpha/index.js — in the partitioned tree "packages/alpha/**": alpha suites',
    ]);
  });

  it("carries the partition's own reason into the red, so the author reads why", () => {
    // The reason is the answer to "why must I declare here?" — the red is where
    // the author tripping it is standing, so it says it there rather than
    // sending them back to the map to look it up.
    const map = partMap();
    map['governance-partitions'][0].reason =
      'The alpha suites sit under two tree-wide code patterns at once, so each states its own subject.';
    const r = audit({ map });
    assert.equal(r.undeclaredInPartition.length, 1);
    assert.equal(r.undeclaredInPartition[0].includes(map['governance-partitions'][0].reason), true);
    assert.match(r.undeclaredInPartition[0], /packages\/alpha\/index\.js/);
    assert.match(r.undeclaredInPartition[0], /"packages\/alpha\/\*\*"/);
  });

  it('is clean once every file in the partitioned tree declares its governance', () => {
    const r = audit({
      map: partMap([
        { path: 'packages/alpha/**', reason: 'alpha suites', 'governed-by': ['docs/tooling.md'] },
      ]),
    });
    assert.deepEqual(flatten(r), []);
  });

  it('flags a partition pattern that matches no tracked file as stale', () => {
    const map = makeMap({
      'governance-partitions': [{ pattern: 'packages/gone/**', reason: 'a tree that left' }],
    });
    assert.deepEqual(audit({ map }).stalePartitions, ['packages/gone/**']);
  });

  it('keeps an equal-set declaration green inside a partition, redundant outside one', () => {
    // Inside a partitioned tree the alternative to an equal-set declaration is a
    // red, not an equivalent green — so stating the covering area's own set is
    // the honest declaration there, and stays green.
    const inside = audit({ map: partMap(equalSetDeclaration) });
    assert.deepEqual(inside.redundantGovernance, []);
    assert.deepEqual(inside.undeclaredInPartition, []);
    const outside = audit({ map: makeMap({ 'declared-governance': equalSetDeclaration }) });
    assert.deepEqual(outside.redundantGovernance, ['packages/alpha/**']);
  });

  it('counts partition-covered files toward the entry total, so such an entry is not stale', () => {
    assert.deepEqual(audit({ map: partMap(equalSetDeclaration) }).staleGovernance, []);
  });
});

describe('auditMap — one partition entry per tree', () => {
  /** makeMap with two partition entries, plus a declaration satisfying the tree. */
  const twoPartitions = (patterns) =>
    makeMap({
      'governance-partitions': patterns,
      'declared-governance': [
        { path: 'packages/alpha/**', reason: 'alpha suites', 'governed-by': ['docs/tooling.md'] },
      ],
    });

  it('flags a tracked file two partition entries both claim, naming the patterns', () => {
    // One entry per tree: a file claimed twice is read under two partition
    // statements at once, so the overlap is named rather than silently resolved.
    const r = audit({
      map: twoPartitions([
        { pattern: 'packages/alpha/**', reason: 'alpha suites' },
        { pattern: 'packages/alpha/*.js', reason: 'the alpha sources' },
      ]),
    });
    assert.deepEqual(flatten(r), [
      'packages/alpha/index.js: "packages/alpha/**", "packages/alpha/*.js"',
    ]);
  });

  it('flags a duplicated pattern as the degenerate case of the same overlap', () => {
    const r = audit({
      map: twoPartitions([
        { pattern: 'packages/alpha/**', reason: 'alpha suites' },
        { pattern: 'packages/alpha/**', reason: 'the alpha suites again' },
      ]),
    });
    assert.deepEqual(flatten(r), [
      'packages/alpha/index.js: "packages/alpha/**", "packages/alpha/**"',
    ]);
  });
});

describe('auditMap — a declaration belongs to one side of a partition boundary', () => {
  /**
   * makeMap with `packages/alpha/**` partitioned beside an unpartitioned
   * sibling area, so one entry can be made to reach across the boundary.
   */
  const boundaryMap = (declared) => {
    const map = makeMap({
      'governance-partitions': [{ pattern: 'packages/alpha/**', reason: 'alpha suites' }],
      'declared-governance': declared,
    });
    map.areas.beta = { code: ['packages/beta/**'], docs: ['docs/beta.md'] };
    return map;
  };
  const FILES = [
    ...BASE_FILES,
    'docs/beta.md',
    'packages/alpha/shared-thing.js',
    'packages/beta/shared-thing.js',
  ];
  /** The partitioned tree's other file, declared so the partition stays satisfied. */
  const alphaRest = {
    path: 'packages/alpha/index.js',
    reason: 'the alpha entry point',
    'governed-by': ['docs/tooling.md'],
  };

  /** The refusal line for the straddler both cases below share. */
  const STRADDLE_LINE =
    'packages/*/shared-thing.js — inside a partitioned tree: packages/alpha/shared-thing.js;' +
    ' outside every partition: packages/beta/shared-thing.js';

  it('refuses one entry matching files inside and outside a partitioned tree', () => {
    // Inside a partition an equal-set declaration is the honest statement and
    // outside one it states nothing — so a single entry cannot answer for both
    // sides, and is refused rather than read under whichever rule happens to win.
    const r = audit({
      map: boundaryMap([
        { path: 'packages/*/shared-thing.js', reason: 'x', 'governed-by': ['docs/tooling.md'] },
        alphaRest,
      ]),
      files: FILES,
    });
    // The whole result, not just the straddle key: no other red applies to this
    // fixture, so the refusal arrives alone — naming the files that put the
    // entry on each side, which is what the split is made along.
    assert.deepEqual(flatten(r), [STRADDLE_LINE]);
  });

  it('refuses a straddler that is equal-set outside the partition, and draws nothing else', () => {
    // `docs/beta.md` is exactly what the beta area supplies to the outside file,
    // so the pre-refusal accounting also called this entry redundant — two reds
    // whose fixes contradict (remove it / split it). The refusal displaces the
    // redundancy red specifically; every other red still applies to the entry.
    const r = audit({
      map: boundaryMap([
        { path: 'packages/*/shared-thing.js', reason: 'x', 'governed-by': ['docs/beta.md'] },
        alphaRest,
      ]),
      files: FILES,
    });
    assert.deepEqual(flatten(r), [STRADDLE_LINE]);
  });

  it('names each side of the boundary up to the printed bound, counting the rest', () => {
    // A wide entry must not print a wall: each side names the first few files it
    // matched and counts the remainder, so the red stays the same size whatever
    // the tree grows to.
    const extra = STRADDLE_SAMPLE + 2;
    const inside = Array.from({ length: extra }, (_, i) => `packages/alpha/shared-thing-${i}.js`);
    const r = audit({
      map: boundaryMap([
        { path: 'packages/*/shared-thing-*.js', reason: 'x', 'governed-by': ['docs/tooling.md'] },
        alphaRest,
      ]),
      files: [...BASE_FILES, 'docs/beta.md', ...inside, 'packages/beta/shared-thing-0.js'],
    });
    assert.equal(r.straddlingGovernance.length, 1);
    const line = r.straddlingGovernance[0];
    for (const f of inside.slice(0, STRADDLE_SAMPLE)) assert.equal(line.includes(f), true, f);
    for (const f of inside.slice(STRADDLE_SAMPLE)) assert.equal(line.includes(f), false, f);
    assert.equal(line.includes(`and ${extra - STRADDLE_SAMPLE} more`), true);
    assert.match(line, /outside every partition: packages\/beta\/shared-thing-0\.js$/);
  });

  it('reads an entry spanning two partitioned trees as no crossing — both sides are covered', () => {
    // The boundary the refusal guards is partitioned-vs-unpartitioned. An entry
    // whose every matched file sits inside some partition is read under one rule.
    const map = boundaryMap([
      { path: 'packages/*/shared-thing.js', reason: 'x', 'governed-by': ['docs/tooling.md'] },
      alphaRest,
    ]);
    map['governance-partitions'] = [
      { pattern: 'packages/alpha/**', reason: 'alpha suites' },
      { pattern: 'packages/beta/**', reason: 'beta suites' },
    ];
    assert.deepEqual(flatten(audit({ map, files: FILES })), []);
  });

  it('leaves a same-tree entry alone — the split at the boundary is green', () => {
    const r = audit({
      map: boundaryMap([
        // Inside the partition, stating exactly what the covering area supplies.
        { path: 'packages/alpha/**', reason: 'alpha suites', 'governed-by': ['area:alpha'] },
        // Outside it, a declaration that changes the file's governing set.
        {
          path: 'packages/beta/shared-thing.js',
          reason: 'the beta thing',
          'governed-by': ['docs/tooling.md'],
        },
      ]),
      files: FILES,
    });
    assert.deepEqual(flatten(r), []);
  });
});

describe('run() — the command line', () => {
  const SCRIPT = path.resolve(import.meta.dirname, '../../../../scripts/check-area-map.js');

  /** Commit `files` in a throwaway repo and run the check CLI over that tree. */
  const runCheckOn = (files, args = []) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'area-map-'));
    try {
      const g = (a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8' });
      g(['init', '-q', '-b', 'main']);
      g(['config', 'user.email', 't@example.com']);
      g(['config', 'user.name', 'Test']);
      for (const [rel, text] of Object.entries(files)) {
        const p = path.join(tmp, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, text);
      }
      g(['add', '.']);
      g(['commit', '-qm', 'fixture']);
      return spawnSync('node', [SCRIPT, ...args], { cwd: tmp, encoding: 'utf8' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  /** A tree one exception's `path` away from being exactly what the map states. */
  const fixtureTree = (unassignedPath) => ({
    'scripts/area-map.json': JSON.stringify({
      description: 'fixture map',
      'repo-wide': { description: 'x', docs: ['README.md'] },
      areas: {
        alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md'] },
        tooling: { code: ['scripts/**'], docs: ['docs/tooling.md'] },
      },
      unassigned: [{ path: unassignedPath, reason: 'license text' }],
      'declared-governance': [],
      'governance-partitions': [],
    }),
    'README.md': '# fixture\n',
    'docs/alpha.md': '# alpha\n',
    'docs/tooling.md': '# tooling\n',
    'packages/alpha/index.js': 'export const x = 1;\n',
    LICENSE: 'license text\n',
  });

  it('prints the dead alternative and prescribes rewriting the entry, not removing it', () => {
    // The tree satisfies the map except for one alternative of an exception the
    // tree still needs — so the printed verdict is that alternative's alone, and
    // the remedy it teaches is the one that fits it: the entry is rewritten
    // until every alternative it expands to matches, and the entry stays.
    const r = runCheckOn(fixtureTree('{LICENSE,GHOST}'));
    assert.equal(r.status, 1, `expected the dead alternative to red.\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /alternative "GHOST" matches no tracked file/);
    assert.match(r.stderr, /rewrite the entry so every alternative it expands to matches the tree/);
    assert.match(r.stderr, /the dead one need not appear in the\n\s+entry as written/);
    // The entry itself still describes the tree, so its own removal is not the fix.
    assert.doesNotMatch(r.stderr, /"unassigned" entr\(ies\) match no tracked file/);
  });

  it('refuses an unrecognized argument with the usage line instead of auditing', () => {
    // A mistyped flag used to fall through to the full audit and exit green,
    // reporting on a question nobody asked. The same tree audits green, so the
    // red below is the argument's own.
    const tree = fixtureTree('LICENSE');
    const green = runCheckOn(tree);
    assert.equal(
      green.status,
      0,
      `expected the fixture tree to audit green.\nstderr: ${green.stderr}`,
    );
    const r = runCheckOn(tree, ['--explan', 'README.md']);
    assert.equal(r.status, 1, `expected the mistyped flag to red.\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /unrecognized argument\(s\): --explan/);
    assert.match(r.stderr, /usage: node scripts\/check-area-map\.js \[--explain <path>\]/);
    assert.doesNotMatch(r.stdout, /area map covers the tree/);
  });
});
