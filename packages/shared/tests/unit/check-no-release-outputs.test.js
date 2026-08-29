/**
 * check-no-release-outputs.test.js — Unit tests for the release-output guard
 * (scripts/check-no-release-outputs.js) that gates CI. Its two modes protect
 * the release pipeline's outputs: feature branches must not touch them, and the
 * pipeline's own automation branch must contain nothing else. These tests prove
 * the classification red paths fire (a dist/ touch, a delta version bump, a
 * ride-along file on the automation branch), that the deliberate green edges
 * stay green (delta content changes, added/deleted deltas), and that the switch
 * between its modes reads the CI inputs the way the readers of that decision —
 * this guard's own mode switch, and check-docs-disposition.js's
 * release-automation class — depend on: a branch on this repository selects the
 * positive mode, every other event shape takes the feature-branch guard. The
 * last of them reads the shipped workflows, holding the guard steps that supply
 * those inputs to the event fields the derivation is written against. Beside
 * them the suite welds the automation branch's name to the contributor-facing
 * documents that spell it out, so a rename cannot leave a reader pointed at a
 * PR that no longer exists.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  isAllowedReleaseOutput,
  featureBranchViolations,
  automatedBranchViolations,
  parsePorcelainPaths,
  effectiveHeadRef,
  isAutomatedBranchRun,
  AUTOMATED_BRANCH,
  DELTA_RE,
} from '../../../../scripts/check-no-release-outputs.js';

/** versionAt stub from a { 'ref:file': version } table (missing key = absent file). */
const versionTable = (entries) => (ref, file) => entries[`${ref}:${file}`] ?? null;

describe('featureBranchViolations — the guard has teeth', () => {
  it('flags any change under schemas/dist/', () => {
    const violations = featureBranchViolations({
      files: ['schemas/dist/extension.schema.json', 'packages/shared/lib/session.js'],
      baseRef: 'origin/main',
      versionAt: versionTable({}),
    });
    assert.deepEqual(violations, [
      'schemas/dist/extension.schema.json (composed schema is a release artifact)',
    ]);
  });

  it('flags a delta version bump, naming both versions', () => {
    const violations = featureBranchViolations({
      files: ['schemas/extension.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({
        'origin/main:schemas/extension.delta.json': '3.0.0',
        'HEAD:schemas/extension.delta.json': '3.1.0',
      }),
    });
    assert.deepEqual(violations, [
      'schemas/extension.delta.json (version bumped 3.0.0 → 3.1.0 — release pipeline owns this)',
    ]);
  });

  it('allows a delta content change that does not bump the version', () => {
    const violations = featureBranchViolations({
      files: ['schemas/extension.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({
        'origin/main:schemas/extension.delta.json': '3.0.0',
        'HEAD:schemas/extension.delta.json': '3.0.0',
      }),
    });
    assert.deepEqual(violations, []);
  });

  it('allows a brand-new delta (absent at base) and a deleted delta (absent at HEAD)', () => {
    const added = featureBranchViolations({
      files: ['schemas/desktop-linux.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({ 'HEAD:schemas/desktop-linux.delta.json': '1.0.0' }),
    });
    assert.deepEqual(added, []);

    const deleted = featureBranchViolations({
      files: ['schemas/old.delta.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({ 'origin/main:schemas/old.delta.json': '1.0.0' }),
    });
    assert.deepEqual(deleted, []);
  });

  it('reports nothing for ordinary source changes', () => {
    const violations = featureBranchViolations({
      files: ['packages/extension/content/recorder.js', 'schemas/shared.schema.json'],
      baseRef: 'origin/main',
      versionAt: versionTable({}),
    });
    assert.deepEqual(violations, []);
  });
});

describe('automatedBranchViolations — nothing rides along', () => {
  it('flags a file outside the release-output set', () => {
    const violations = automatedBranchViolations({
      files: ['README.md', 'packages/shared/lib/session.js'],
    });
    assert.deepEqual(violations, [
      `packages/shared/lib/session.js (not a release output — must not change on ${AUTOMATED_BRANCH})`,
    ]);
  });

  it('accepts the full legitimate regeneration set', () => {
    const violations = automatedBranchViolations({
      files: [
        'schemas/dist/extension.schema.json',
        'schemas/extension.delta.json',
        'README.md',
        'docs/technical/session-format.md',
        'packages/extension/manifest.json',
        'packages/desktop/src-tauri/tauri.conf.json',
        'packages/desktop/src-tauri/Cargo.toml',
        'packages/desktop/src-tauri/Cargo.lock',
        'reference-implementations/sync-server/samples/extension-sample.json',
        'reference-implementations/sync-server/samples/desktop-windows-sample.json',
      ],
    });
    assert.deepEqual(violations, []);
  });
});

describe('isAllowedReleaseOutput / DELTA_RE', () => {
  it('treats any schemas/*.delta.json as a release-output surface', () => {
    assert.equal(DELTA_RE.test('schemas/extension.delta.json'), true);
    assert.equal(DELTA_RE.test('schemas/desktop-windows.delta.json'), true);
    assert.equal(DELTA_RE.test('schemas/shared.schema.json'), false);
    assert.equal(isAllowedReleaseOutput('schemas/extension.delta.json'), true);
  });

  it('matches directory prefixes and exact paths, not lookalikes', () => {
    assert.equal(isAllowedReleaseOutput('schemas/dist/anything.json'), true);
    assert.equal(isAllowedReleaseOutput('README.md'), true);
    assert.equal(isAllowedReleaseOutput('docs/README.md'), false);
    assert.equal(isAllowedReleaseOutput('README.md.bak'), false);
  });
});

describe('effectiveHeadRef — which branch a run may act on', () => {
  // The repository names are fixtures: the rule compares them for equality, so
  // what they spell never matters, only whether they agree.
  const CI = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo' };

  it('takes the supplied ref as given off CI — the documented local runs', () => {
    // docs/guides/local-ci.md tells a maintainer to name the automation branch
    // to exercise the positive mode; there is no event to derive anything from,
    // so the ref they typed is the answer.
    assert.equal(effectiveHeadRef({ PR_HEAD_REF: AUTOMATED_BRANCH }), AUTOMATED_BRANCH);
    assert.equal(effectiveHeadRef({ PR_HEAD_REF: 'feature/x' }), 'feature/x');
    assert.equal(effectiveHeadRef({}), '');
  });

  it('names the branch under CI when the head repository is this repository', () => {
    assert.equal(
      effectiveHeadRef({ ...CI, PR_HEAD_REPO: 'owner/repo', PR_HEAD_REF: AUTOMATED_BRANCH }),
      AUTOMATED_BRANCH,
    );
  });

  it('names nothing under CI when the head repository is another one', () => {
    assert.equal(
      effectiveHeadRef({ ...CI, PR_HEAD_REPO: 'fork-owner/repo', PR_HEAD_REF: AUTOMATED_BRANCH }),
      '',
    );
  });

  it('names nothing under CI when either side of the comparison is absent', () => {
    // Fail closed: an event that did not carry the head repository, or a run
    // with no repository of its own to compare against, decides nothing — two
    // absent values must never read as agreement.
    assert.equal(effectiveHeadRef({ ...CI, PR_HEAD_REF: AUTOMATED_BRANCH }), '');
    assert.equal(
      effectiveHeadRef({
        GITHUB_ACTIONS: 'true',
        PR_HEAD_REPO: '',
        PR_HEAD_REF: AUTOMATED_BRANCH,
      }),
      '',
    );
    assert.equal(
      effectiveHeadRef({
        GITHUB_ACTIONS: 'true',
        PR_HEAD_REPO: 'owner/repo',
        PR_HEAD_REF: AUTOMATED_BRANCH,
      }),
      '',
    );
  });
});

describe('isAutomatedBranchRun — the mode switch', () => {
  const SAME_REPO = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_HEAD_REPO: 'owner/repo',
  };

  it('selects the positive validation for the automation branch on this repository', () => {
    assert.equal(isAutomatedBranchRun({ ...SAME_REPO, PR_HEAD_REF: AUTOMATED_BRANCH }), true);
  });

  it('takes the feature-branch guard for that same name from another repository', () => {
    // The name is the pipeline's, the diff could be anything; the head
    // repository is what decides, so this run is guarded, not validated.
    assert.equal(
      isAutomatedBranchRun({
        ...SAME_REPO,
        PR_HEAD_REPO: 'fork-owner/repo',
        PR_HEAD_REF: AUTOMATED_BRANCH,
      }),
      false,
    );
  });

  it('takes the feature-branch guard for an ordinary branch and for no branch at all', () => {
    assert.equal(isAutomatedBranchRun({ ...SAME_REPO, PR_HEAD_REF: 'feature/x' }), false);
    assert.equal(isAutomatedBranchRun({ ...SAME_REPO, PR_HEAD_REF: '' }), false);
    assert.equal(isAutomatedBranchRun({}), false);
  });

  it('selects the positive validation off CI on the supplied ref alone', () => {
    assert.equal(isAutomatedBranchRun({ PR_HEAD_REF: AUTOMATED_BRANCH }), true);
  });
});

describe('the guard steps forward what the derivation reads', () => {
  // Under a GitHub Actions run the derivation above answers the empty string
  // unless the head branch and the head repository both arrive, and the empty
  // string selects no mode and admits no class. So a workflow that stops
  // forwarding one of them leaves the release pipeline's own PR taking the
  // feature-branch paths — red at release time, on the one PR nobody is
  // watching. These env blocks have no other reader, so this is where that edit
  // can red at the keystroke instead.
  //
  // `env:` on a step reaches that step's own process and nothing else, so the
  // pin is step-scoped: the assignments are read out of the block belonging to
  // the step that runs the script, which is what makes moving them to a
  // neighbouring step a red rather than a rename the file-wide count would miss.
  // The whole-file count runs beside it, refusing a second, drifted copy.
  const REPO = path.resolve(import.meta.dirname, '../../../..');

  /** The event fields a guard step forwards, spelled as the workflows state them. */
  const FORWARDED = {
    PR_HEAD_REF: '${{ github.head_ref }}',
    PR_HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
  };

  /** Escape a literal for embedding in a RegExp source. */
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * A workflow parsed into steps, refusing readably where YAML cannot read it
   * at all — a key written twice inside one block is exactly the drift this
   * pin exists for, and the parser reports it as breakage rather than as an
   * answer, so the refusal states the rule instead of re-throwing.
   * @param {string} text the workflow source
   * @param {string} workflowFile repo-relative workflow path, for the refusal
   */
  const parseWorkflow = (text, workflowFile) => {
    try {
      return yaml.load(text);
    } catch (err) {
      assert.fail(
        `${workflowFile} does not parse as YAML, so the guard step's env block cannot be read ` +
          `— a variable assigned twice inside one block reads as this rather than as a value: ` +
          `${err.message.split('\n')[0]}`,
      );
    }
  };

  /**
   * The one step in a parsed workflow whose `run:` invokes `script`, with the
   * step's own name for the refusals.
   * @param {any} workflow the parsed workflow document
   * @param {string} workflowFile repo-relative workflow path, for the refusal
   * @param {string} script repo-relative path of the check the step runs
   * @returns {{ name: string, env: Record<string, string> }}
   */
  const guardStep = (workflow, workflowFile, script) => {
    const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job?.steps ?? []);
    const running = steps.filter(
      (step) => typeof step?.run === 'string' && step.run.includes(script),
    );
    assert.equal(
      running.length,
      1,
      `${workflowFile} must run ${script} from exactly one step — the guard step whose own ` +
        `env block supplies the head-ref derivation its inputs (found ${running.length})`,
    );
    return { name: running[0].name ?? '(unnamed step)', env: running[0].env ?? {} };
  };

  for (const [workflowFile, script] of [
    ['.github/workflows/test.yml', 'scripts/check-no-release-outputs.js'],
    ['.github/workflows/docs-disposition.yml', 'scripts/check-docs-disposition.js'],
  ]) {
    it(`${workflowFile} hands ${script} the head branch and the head repository`, () => {
      const text = readFileSync(path.join(REPO, workflowFile), 'utf8');
      const step = guardStep(parseWorkflow(text, workflowFile), workflowFile, script);

      for (const [key, expression] of Object.entries(FORWARDED)) {
        assert.equal(
          step.env[key],
          expression,
          `${workflowFile}: the "${step.name}" step must set ${key} to ${expression} in its ` +
            `own env block — step env reaches that step alone, and the derivation reads the ` +
            `head branch and the head repository together, naming no branch unless both ` +
            `arrive, so a ${key} dropped, rewritten, or moved to another step silently ` +
            `selects no mode (found ${step.env[key] === undefined ? 'no such key there' : `"${step.env[key]}"`})`,
        );
        const copies = [...text.matchAll(new RegExp(String.raw`^\s*${esc(key)}:`, 'gm'))];
        assert.equal(
          copies.length,
          1,
          `${workflowFile} must assign ${key} exactly once — the "${step.name}" step's env ` +
            `block is its one home in this workflow (found ${copies.length})`,
        );
      }
    });
  }
});

describe('the automation branch name — welded to the prose that spells it out', () => {
  // The branch name is a value with one home (AUTOMATED_BRANCH), and the
  // documents a contributor reads before a release spell it out in full: the
  // release process itself, and the local reproduction of the guards that key
  // on it. A rename lands in the constant and the workflows — which the
  // disposition suite pins from the other side, holding both publish workflows'
  // `branch:` key to this constant ('both publish workflows open the automation
  // PR on the branch the guards key on', in
  // packages/shared/tests/unit/check-docs-disposition.test.js) — while these
  // prose copies would keep naming a branch that no longer exists, sending a
  // reader to a PR they will never find. This suite holds that class: the
  // contributor-facing documents that spell the name out. The name's echoes
  // inside code comments and workflow comments are a different class,
  // cite-the-owner territory, and stay outside this weld.
  const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

  /** Escape a literal for embedding in a RegExp source. */
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * The branch's own namespace — the segment the name opens with, derived from
   * the constant rather than spelled a second time. Anchoring the scan on it is
   * what makes a DRIFTED name visible: a scan for the whole name would find a
   * renamed copy nowhere and pass on silence.
   */
  const BRANCH_NAMESPACE = `${AUTOMATED_BRANCH.split('/')[0]}/`;
  const TOKEN_RE = new RegExp(`${escapeRe(BRANCH_NAMESPACE)}\\S+`, 'g');

  /**
   * What a prose mention can put after the name and still be naming it: the
   * punctuation that ends the sentence or closes the code span, the markdown
   * emphasis a mention can be wrapped in, and the possessive a sentence can
   * attach to it. The name itself carries none of these, so trimming them is
   * what leaves the branch a reader reads.
   */
  const TRAILER_RE = /(?:'s|[`*.,;:)\]'"])+$/;

  /**
   * The branch tokens a document spells, each with that trailer removed.
   * @param {string} text
   * @returns {string[]}
   */
  const branchTokens = (text) =>
    [...text.matchAll(TOKEN_RE)].map((m) => m[0].replace(TRAILER_RE, ''));

  for (const doc of ['.github/PUBLISHING.md', 'docs/guides/local-ci.md']) {
    it(`${doc} names the automation branch as the constant spells it`, () => {
      const tokens = branchTokens(readFileSync(path.join(REPO_ROOT, doc), 'utf8'));
      assert.notEqual(
        tokens.length,
        0,
        `${doc} must name the automation branch — this weld holds what it says about it, and a ` +
          `document that stopped saying it would pass this on silence`,
      );
      for (const token of tokens) {
        assert.equal(
          token,
          AUTOMATED_BRANCH,
          `${doc} names "${token}", but the branch the guards key on is "${AUTOMATED_BRANCH}" ` +
            `(scripts/check-no-release-outputs.js) — a reader sent to that PR would not find it`,
        );
      }
    });
  }

  it('reads a name that ends a sentence, closes a code span, carries emphasis or a possessive as the name alone', () => {
    // The documents spell the branch inside backticks, inside emphasis, at the
    // end of sentences, and with a possessive attached, so the trim is
    // load-bearing: without it every such mention would read as a different
    // branch and the weld would red on prose that is perfectly correct.
    assert.deepEqual(
      branchTokens(
        `The pipeline opens its PR on \`${AUTOMATED_BRANCH}\`.\n` +
          `Nothing else lands on ${AUTOMATED_BRANCH}.\n` +
          `The branch is **${AUTOMATED_BRANCH}**, and ${AUTOMATED_BRANCH}'s PR is the one to read.\n` +
          `Run it with PR_HEAD_REF=${AUTOMATED_BRANCH} first`,
      ),
      Array(5).fill(AUTOMATED_BRANCH),
    );
  });
});

describe('parsePorcelainPaths', () => {
  it('strips the 2-char status and keeps untracked (??) entries', () => {
    const out = ' M schemas/dist/extension.schema.json\n?? schemas/dist/new-platform.schema.json\n';
    assert.deepEqual(parsePorcelainPaths(out), [
      'schemas/dist/extension.schema.json',
      'schemas/dist/new-platform.schema.json',
    ]);
  });

  it('returns nothing for empty output', () => {
    assert.deepEqual(parsePorcelainPaths(''), []);
    assert.deepEqual(parsePorcelainPaths('\n'), []);
  });
});
