/**
 * check-area-map.test.js — Unit tests for the area-map admission test
 * (scripts/check-area-map.js) that gates CI. The map is committed data, so
 * every way it can rot must fail loud: these tests prove each red path fires
 * on synthetic input (zero-area files, stale patterns, untracked entries,
 * uncovered docs, stale/unnecessary exceptions, dangling doc pointers) and
 * that the pattern matcher includes dotfiles under `**` — the semantics that
 * make "everything under a package belongs to its area" actually total.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandBraces,
  globToRegExp,
  extractDocPointers,
  validateShape,
  compileMap,
  resolveFile,
  auditMap,
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
  it('flags a pattern matching no tracked file, naming the dead brace member', () => {
    const map = makeMap();
    map.areas.tooling.code = ['scripts/{check-*,gone-*}.js', 'package.json'];
    const r = audit({ map });
    assert.equal(r.stalePatterns.length, 1);
    assert.match(r.stalePatterns[0], /scripts\/gone-\*\.js/);
    assert.match(r.stalePatterns[0], /from "scripts\/\{check-\*,gone-\*\}\.js"/);
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
  function declMap(governedBy) {
    return makeMap({
      'declared-governance': [
        { path: 'packages/alpha/x.yml', reason: 'alpha config', 'governed-by': governedBy },
      ],
    });
  }

  it("a declared file's docs are exactly its governed-by — area docs and a // see pointer do not apply", () => {
    const compiled = compileMap(declMap(['docs/tooling.md']));
    // packages/alpha/x.yml matches alpha's code glob (areaSupplied = [docs/alpha.md]) and carries a
    // live pointer to docs/alpha.md — yet the declaration overrides both to exactly governed-by.
    const r = resolveFile('packages/alpha/x.yml', compiled, '// see docs/alpha.md');
    assert.equal(r.declaredGovernance, true);
    assert.deepEqual(r.docs, ['docs/tooling.md']); // governed-by verbatim, not alpha.md nor the pointer
    assert.deepEqual(r.governedBy, ['docs/tooling.md']);
    assert.deepEqual(r.areaSuppliedDocs, ['docs/alpha.md']); // bare code-area docs, pre-override
    assert.deepEqual(r.areas, ['alpha']); // coverage preserved (declaration grants no coverage of its own)
  });

  it('a declared file with governed-by [] resolves to no governing docs', () => {
    const compiled = compileMap(declMap([]));
    const r = resolveFile('packages/alpha/x.yml', compiled);
    assert.equal(r.declaredGovernance, true);
    assert.deepEqual(r.docs, []);
    assert.deepEqual(r.governedBy, []);
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
