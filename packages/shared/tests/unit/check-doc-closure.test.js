/**
 * check-doc-closure.test.js — Unit tests for the doc-closure admission test
 * (scripts/check-doc-closure.js). The guides' closure claims are committed
 * prose, so every red-path family must fail loud: these tests prove the
 * both-way set diffs on each closure leg, the job partition — the totality of
 * its side derivation, which refuses a zero-flag job gated in a way neither
 * side models; its row-scoped flag equality; the flag-definedness leg, which
 * is the only one that can see a typo mirrored on both sides; and the
 * two-readers agreement holding the line scan and the parsed workflow to one
 * job set — the gates table's Where and live-gate legs (with the shell-shaped
 * step reading that keeps a quoted or commented mention, or a command the
 * claim merely prefixes, from resolving a gate), the
 * script-key citation leg, the unreadable-cell and unreadable-citation
 * refusals, the extractor anchor guards, duplicates, the elided-family
 * admission, empty parses, and the workflow-file boundary — and, as a
 * real-tree lock, that the shipped tree satisfies every closure. Every red
 * direction is driven by a fixture; the tree itself is never broken to
 * produce one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CI_DOC_PATH,
  LOCAL_CI_DOC_PATH,
  TEST_WORKFLOW_PATH,
  ROOT_MANIFEST_PATH,
  WORKFLOW_SECTION,
  WORKFLOW_HEADER,
  ACT_SECTION,
  ACT_HEADER,
  LINT_JOB_ID,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  WORKFLOW_FILE_RE,
  linkedFileName,
  extractTableFileNames,
  extractGateRows,
  extractJobsTableRows,
  extractAlwaysRunIds,
  extractJobIds,
  ACT_PARTIAL_PHRASE,
  RUNNER_TABLES,
  completeRunnerLabel,
  deriveActVerdict,
  evaluateRunnerCells,
  extractActVerdicts,
  extractRunnerCells,
  jobNpmRunTokens,
  extractWorkflowGating,
  extractLintSurface,
  extractNpmRunCites,
  extractColonCites,
  admitColonCites,
  collectScriptKeys,
  workflowBasenames,
  evaluateDocClosure,
  treeSurfaces,
} from '../../../../scripts/check-doc-closure.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/**
 * A consistent synthetic surface every closure leg accepts: one always-run
 * job, two path-filtered ones, and the gate rows, citations, and manifest
 * facts they are held against.
 */
function makeSurface(overrides = {}) {
  return {
    workflowFiles: ['test.yml', 'publish.yml'],
    workflowRows: ['test.yml', 'publish.yml'],
    workflowUnreadable: [],
    jobIds: ['lint', 'unit-tests', 'desktop-rust-tests'],
    actRows: ['lint', 'unit-tests', 'desktop-rust-tests'],
    actUnreadable: [],
    gateRows: [
      { gate: 'ESLint', tokens: ['lint:js'], where: ['lint'], command: 'npm run lint:js' },
      { gate: 'Prettier', tokens: ['lint:format', 'format'], where: ['lint'], command: 'npm run lint:format' }, // prettier-ignore
      { gate: 'Clippy', tokens: [], where: ['desktop-rust-tests'], command: 'cargo clippy -- -D warnings' }, // prettier-ignore
    ],
    gatesUnreadable: [],
    jobsTableRows: [
      { job: 'unit-tests', flags: ['ci'], alias: null },
      { job: 'desktop-rust-tests', flags: ['desktop'], alias: null },
    ],
    jobsTableUnreadable: [],
    alwaysRunIds: ['lint'],
    workflowJobs: [
      { id: 'lint', flags: [], stepLines: ['npm run lint:js', 'npm run lint:format -- --quiet'], runners: ['ubuntu-latest'], uploads: [], downloads: [], usesSecret: false }, // prettier-ignore
      { id: 'unit-tests', flags: ['ci'], stepLines: ['npm ci', 'npm run test:shared'], runners: ['ubuntu-latest'], uploads: [], downloads: [], usesSecret: false }, // prettier-ignore
      { id: 'desktop-rust-tests', flags: ['desktop'], stepLines: ['cargo clippy -- -D warnings'], runners: ['windows-latest'], uploads: ['corpus-desktop-events'], downloads: [], usesSecret: false }, // prettier-ignore
    ],
    filterFlags: ['ci', 'desktop'],
    chainTokens: ['lint:js', 'lint:format'],
    lintKeys: ['lint:js', 'lint:format'],
    lintStepTokens: ['lint:js', 'lint:format'],
    runnerCells: [],
    runnerCellsUnreadable: [],
    actVerdicts: [],
    actVerdictsUnreadable: [],
    cites: [{ path: 'docs/a.md', line: 3, token: 'lint:js', elided: false }],
    citeUnreadable: [],
    colonCites: [{ path: 'docs/a.md', line: 3, token: 'lint:js' }],
    allColonCites: [{ path: 'docs/a.md', line: 3, token: 'lint:js' }],
    registeredColonCites: ['lint:js'],
    scriptKeys: new Set(['lint:js', 'lint:format', 'format', 'test:shared']),
    scriptCommands: {
      'lint:js': 'eslint .',
      'lint:format': 'prettier --check .',
      format: 'prettier --write .',
      'test:shared': 'node --test packages/shared/tests/unit/*.test.js',
    },
    ...overrides,
  };
}

/** The baseline plus a row that defers to another row's flags. */
function makeDeferringSurface(overrides = {}) {
  const base = makeSurface();
  return makeSurface({
    jobIds: [...base.jobIds, 'desktop-corpus-diff'],
    actRows: [...base.actRows, 'desktop-corpus-diff'],
    workflowJobs: [
      ...base.workflowJobs,
      { id: 'desktop-corpus-diff', flags: ['desktop'], stepLines: ['npm run corpus:check:desktop'], runners: ['ubuntu-latest'], uploads: [], downloads: ['corpus-desktop-events'], usesSecret: false }, // prettier-ignore
    ],
    jobsTableRows: [
      ...base.jobsTableRows,
      { job: 'desktop-corpus-diff', flags: null, alias: 'desktop-rust-tests' },
    ],
    ...overrides,
  });
}

describe('evaluateDocClosure — compliant baseline', () => {
  it('returns no problems when every closure holds', () => {
    assert.deepEqual(evaluateDocClosure(makeSurface()), []);
  });
});

describe('evaluateDocClosure — workflow-inventory leg (both ways)', () => {
  it('fires when a workflow file has no inventory row', () => {
    const problems = evaluateDocClosure(
      makeSurface({ workflowFiles: ['test.yml', 'publish.yml', 'ghost.yml'] }),
    );
    assert.ok(problems.some((p) => p.includes('ghost.yml') && p.includes('does not list it')));
  });

  it('fires when an inventory row names a workflow the tracked set does not carry', () => {
    const problems = evaluateDocClosure(
      makeSurface({ workflowRows: ['test.yml', 'publish.yml', 'retired.yml'] }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('retired.yml') && p.includes('no tracked workflow file matches it'),
      ),
    );
  });
});

describe('evaluateDocClosure — act-table leg (both ways)', () => {
  it('fires when a job is not keyed by the act table', () => {
    const problems = evaluateDocClosure(makeSurface({ actRows: ['lint', 'unit-tests'] }));
    assert.ok(problems.some((p) => p.includes('desktop-rust-tests') && p.includes('does not key it'))); // prettier-ignore
  });

  it('fires when the act table keys a job that does not exist', () => {
    const problems = evaluateDocClosure(
      makeSurface({ actRows: [...makeSurface().actRows, 'renamed-away'] }),
    );
    assert.ok(problems.some((p) => p.includes('renamed-away') && p.includes('is not a')));
  });
});

describe('evaluateDocClosure — lint-gates leg', () => {
  it('fires when the chain runs a token that is not a lint:* script', () => {
    const problems = evaluateDocClosure(
      makeSurface({ chainTokens: ['lint:js', 'lint:format', 'check:pins'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('check:pins') && p.includes('is not a `lint:*` script')),
    );
  });

  it('fires when a lint:* script is missing from the chain', () => {
    const problems = evaluateDocClosure(
      makeSurface({ lintKeys: ['lint:js', 'lint:format', 'lint:new'] }),
    );
    assert.ok(problems.some((p) => p.includes('lint:new') && p.includes('chain does not run it')));
  });

  it('fires when a lint:* script has no gates-table row', () => {
    const problems = evaluateDocClosure(
      makeSurface({
        chainTokens: ['lint:js', 'lint:format', 'lint:new'],
        lintKeys: ['lint:js', 'lint:format', 'lint:new'],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('lint:new') && p.includes('no lint-gates row names it')),
    );
  });

  it('fires when a lint-job step token has no gates-table row', () => {
    const problems = evaluateDocClosure(
      makeSurface({ lintStepTokens: ['lint:js', 'lint:format', 'check:orphan'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('check:orphan') && p.includes('no lint-gates row names it')),
    );
  });
});

describe('evaluateDocClosure — the job partition, derived from each job’s own gating', () => {
  it('fires when a job is documented on the side its gating does not put it on', () => {
    const problems = evaluateDocClosure(
      makeSurface({
        alwaysRunIds: ['lint', 'desktop-rust-tests'],
        jobsTableRows: [{ job: 'unit-tests', flags: ['ci'], alias: null }],
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`desktop-rust-tests`') &&
          p.includes('the always-run prose') &&
          p.includes('the path-filtered jobs table'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when both surfaces claim the same job', () => {
    const problems = evaluateDocClosure(
      makeSurface({ alwaysRunIds: ['lint', 'desktop-rust-tests'] }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('`desktop-rust-tests`') && p.includes('both surfaces at once'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when a job’s own side does not name it', () => {
    const problems = evaluateDocClosure(
      makeSurface({ jobsTableRows: [{ job: 'unit-tests', flags: ['ci'], alias: null }] }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`desktop-rust-tests`') &&
          p.includes('the path-filtered jobs table') &&
          p.includes('does not name it'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when either surface names something that is not a job', () => {
    const prose = evaluateDocClosure(makeSurface({ alwaysRunIds: ['lint', 'ghost-job'] }));
    assert.ok(
      prose.some(
        (p) =>
          p.includes('`ghost-job`') && p.includes('the always-run prose') && p.includes('is not a'),
      ),
      prose.join('\n'),
    );
    const table = evaluateDocClosure(
      makeSurface({
        jobsTableRows: [
          ...makeSurface().jobsTableRows,
          { job: 'ghost-job', flags: ['ci'], alias: null },
        ],
      }),
    );
    assert.ok(
      table.some(
        (p) =>
          p.includes('`ghost-job`') &&
          p.includes('the path-filtered jobs table') &&
          p.includes('is not a'),
      ),
      table.join('\n'),
    );
  });

  it('refuses a zero-flag job gated some other way, naming the job and its condition', () => {
    // Totality: an empty flag set alone does not mean "runs on every PR".
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        jobIds: [...base.jobIds, 'push-only'],
        actRows: [...base.actRows, 'push-only'],
        workflowJobs: [
          ...base.workflowJobs,
          { id: 'push-only', flags: [], condition: "github.event_name == 'push'", stepLines: ['npm ci'] }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`push-only`') &&
          p.includes("github.event_name == 'push'") &&
          p.includes('neither absent nor `always()`'),
      ),
      problems.join('\n'),
    );
    // …and it is never quietly placed on the always-run side instead.
    assert.ok(
      !problems.some((p) => p.includes('`push-only`') && p.includes('the always-run prose')),
      problems.join('\n'),
    );
  });

  it('derives the always-run side for `always()`, wrapper and whitespace tolerated', () => {
    const base = makeSurface();
    for (const condition of [null, 'always()', ' ${{ always() }} ', 'always( )']) {
      const problems = evaluateDocClosure(
        makeSurface({
          jobIds: [...base.jobIds, 'ci-gate'],
          actRows: [...base.actRows, 'ci-gate'],
          alwaysRunIds: [...base.alwaysRunIds, 'ci-gate'],
          workflowJobs: [
            ...base.workflowJobs,
            { id: 'ci-gate', flags: [], condition, stepLines: ['echo done'] },
          ],
        }),
      );
      assert.deepEqual(problems, [], `${condition} must derive the always-run side`);
    }
  });

  it('fires when the line scan and the parsed workflow name different jobs', () => {
    const missed = evaluateDocClosure(makeSurface({ jobIds: ['lint', 'unit-tests'] }));
    assert.ok(
      missed.some(
        (p) => p.includes('`desktop-rust-tests`') && p.includes('the line scan does not read it'),
      ),
      missed.join('\n'),
    );
    const extra = evaluateDocClosure(makeSurface({ jobIds: [...makeSurface().jobIds, 'phantom'] }));
    assert.ok(
      extra.some(
        (p) => p.includes('`phantom`') && p.includes('the parsed workflow does not carry'),
      ),
      extra.join('\n'),
    );
  });
});

describe('evaluateDocClosure — row-scoped flag equality (both ways per row)', () => {
  it('fires when a row states a flag its job’s gate does not carry', () => {
    const problems = evaluateDocClosure(
      makeSurface({
        jobsTableRows: [
          { job: 'unit-tests', flags: ['ci', 'desktop'], alias: null },
          { job: 'desktop-rust-tests', flags: ['desktop'], alias: null },
        ],
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`desktop`') &&
          p.includes('row for `unit-tests`') &&
          p.includes('does not gate on it'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when a row omits a flag its job’s gate carries (the swapped-flags case)', () => {
    const problems = evaluateDocClosure(
      makeSurface({
        jobsTableRows: [
          { job: 'unit-tests', flags: ['desktop'], alias: null },
          { job: 'desktop-rust-tests', flags: ['desktop'], alias: null },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('`ci`') && p.includes('does not state that flag')),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((p) => p.includes('`desktop`') && p.includes('does not gate on it')),
      problems.join('\n'),
    );
  });

  it('resolves a row that defers to another row’s flags', () => {
    assert.deepEqual(evaluateDocClosure(makeDeferringSurface()), []);
  });

  it('fires when a deferring row’s resolved flags are not its own job’s', () => {
    const base = makeDeferringSurface();
    const problems = evaluateDocClosure(
      makeDeferringSurface({
        filterFlags: ['ci', 'desktop', 'corpus'],
        workflowJobs: base.workflowJobs.map((job) =>
          job.id === 'desktop-corpus-diff' ? { ...job, flags: ['desktop', 'corpus'] } : job,
        ),
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`corpus`') &&
          p.includes('desktop-corpus-diff') &&
          p.includes('does not state that flag'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when a deferring row names no row of the same table', () => {
    const base = makeDeferringSurface();
    const problems = evaluateDocClosure(
      makeDeferringSurface({
        jobsTableRows: base.jobsTableRows.map((row) =>
          row.job === 'desktop-corpus-diff' ? { ...row, alias: 'no-such-row' } : row,
        ),
      }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('defers to `no-such-row`') && p.includes('no row of the same table'),
      ),
      problems.join('\n'),
    );
  });
});

describe('evaluateDocClosure — table flags are defined filters', () => {
  it('fires on a flag word the changes step does not define, even where the gate agrees', () => {
    // The mirrored typo: the row and the job's `if:` state the same word, so
    // row-scoped equality is green and only definedness can see it.
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        jobsTableRows: [
          { job: 'unit-tests', flags: ['ciKore'], alias: null },
          { job: 'desktop-rust-tests', flags: ['desktop'], alias: null },
        ],
        workflowJobs: base.workflowJobs.map((job) =>
          job.id === 'unit-tests' ? { ...job, flags: ['ciKore'] } : job,
        ),
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('`ciKore`') && p.includes('does not define')),
      problems.join('\n'),
    );
    assert.ok(
      !problems.some((p) => p.includes('does not gate on it') || p.includes('does not state that flag')), // prettier-ignore
      `row-scoped equality must stay green on the mirrored typo:\n${problems.join('\n')}`,
    );
  });
});

describe('evaluateDocClosure — the gates table’s Where and live-gate legs', () => {
  it('fires when a Where cell names a job the workflow does not define', () => {
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        gateRows: [{ ...base.gateRows[0], where: ['ghost'] }, ...base.gateRows.slice(1)],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('runs in `ghost`') && p.includes('is not a')),
      problems.join('\n'),
    );
  });

  it('fires when the row’s gate step is gone from its Where job — no family-key escape', () => {
    // The killed false green: `lint:js` still runs in the job, so the family
    // is alive; the row's own gate is not, and that is what must red.
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        gateRows: [
          ...base.gateRows,
          { gate: 'Doc closure', tokens: ['lint:doc-closure'], where: ['lint'], command: 'npm run lint:doc-closure' }, // prettier-ignore
        ],
        chainTokens: [...base.chainTokens, 'lint:doc-closure'],
        lintKeys: [...base.lintKeys, 'lint:doc-closure'],
        scriptKeys: new Set([...base.scriptKeys, 'lint:doc-closure']),
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`Doc closure`') &&
          p.includes('npm run lint:doc-closure') &&
          p.includes('no step of `lint` runs it'),
      ),
      problems.join('\n'),
    );
  });

  it('does not resolve a gate from an advisory mention inside a quoted string', () => {
    // The freshness step's failure message spells the command out for the
    // reader; the step that would RUN it is gone, and that is what must red.
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        gateRows: [
          ...base.gateRows,
          { gate: 'sync-shared freshness', tokens: ['sync-shared'], where: ['unit-tests'], command: 'npm run sync-shared' }, // prettier-ignore
        ],
        workflowJobs: base.workflowJobs.map((job) =>
          job.id === 'unit-tests'
            ? { ...job, stepLines: ['git diff --exit-code packages/*/shared/ || (echo "ERROR: run \'npm run sync-shared\' locally and commit" && exit 1)'] } // prettier-ignore
            : job,
        ),
        scriptKeys: new Set([...base.scriptKeys, 'sync-shared']),
        scriptCommands: { ...base.scriptCommands, 'sync-shared': 'node scripts/sync-shared.js' },
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`sync-shared freshness`') &&
          p.includes('npm run sync-shared') &&
          p.includes('no step of `unit-tests` runs it'),
      ),
      problems.join('\n'),
    );
  });

  it('does not resolve a gate from a `#` comment recording the retired step', () => {
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        gateRows: [
          ...base.gateRows,
          { gate: 'Doc closure', tokens: ['lint:doc-closure'], where: ['lint'], command: 'npm run lint:doc-closure' }, // prettier-ignore
        ],
        chainTokens: [...base.chainTokens, 'lint:doc-closure'],
        lintKeys: [...base.lintKeys, 'lint:doc-closure'],
        workflowJobs: base.workflowJobs.map((job) =>
          job.id === 'lint'
            ? { ...job, stepLines: [...job.stepLines, '# was: npm run lint:doc-closure'] }
            : job,
        ),
        scriptKeys: new Set([...base.scriptKeys, 'lint:doc-closure']),
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('`Doc closure`') && p.includes('no step of `lint` runs it')),
      problems.join('\n'),
    );
  });

  it('does not resolve a row through a command its claim is only a strict prefix of', () => {
    // `prettier --check .` opens `prettier --check ./docs` textually, but the
    // step runs a different, narrower command: the manifest-command shape
    // ends on the same boundary the invocation shape does.
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        workflowJobs: base.workflowJobs.map((job) =>
          job.id === 'lint'
            ? { ...job, stepLines: ['npm run lint:js', 'prettier --check ./docs'] }
            : job,
        ),
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`Prettier`') &&
          p.includes('npm run lint:format') &&
          p.includes('no step of `lint` runs it'),
      ),
      problems.join('\n'),
    );
  });

  it('resolves a gate through the script’s own command when a step invokes it directly', () => {
    // The shipped guard line's shape: the command OPENS the segment and
    // passes an extra argument after it.
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        gateRows: [
          ...base.gateRows,
          { gate: 'Release-output guard', tokens: ['check:no-release-outputs'], where: ['lint'], command: 'npm run check:no-release-outputs' }, // prettier-ignore
        ],
        workflowJobs: base.workflowJobs.map((job) =>
          job.id === 'lint'
            ? { ...job, stepLines: [...job.stepLines, 'node scripts/check-no-release-outputs.js "origin/$GITHUB_BASE_REF"'] } // prettier-ignore
            : job,
        ),
        scriptKeys: new Set([...base.scriptKeys, 'check:no-release-outputs']),
        scriptCommands: {
          ...base.scriptCommands,
          'check:no-release-outputs': 'node scripts/check-no-release-outputs.js',
        },
      }),
    );
    assert.deepEqual(problems, []);
  });

  it('resolves a gate hosted by a job other than lint', () => {
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        gateRows: [
          ...base.gateRows,
          { gate: 'Shared tests', tokens: ['test:shared'], where: ['unit-tests'], command: 'npm run test:shared' }, // prettier-ignore
        ],
      }),
    );
    assert.deepEqual(problems, []);
  });

  it('holds a non-npm-run row to its Where jobs only', () => {
    // The Clippy row of the baseline claims `cargo clippy …`: its job must be
    // real, and nothing further is claimed.
    assert.deepEqual(evaluateDocClosure(makeSurface()), []);
    const base = makeSurface();
    const problems = evaluateDocClosure(
      makeSurface({
        gateRows: base.gateRows.map((row) =>
          row.gate === 'Clippy' ? { ...row, where: ['no-such-job'] } : row,
        ),
      }),
    );
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes('`Clippy`') && problems[0].includes('no-such-job'));
  });
});

describe('evaluateDocClosure — npm-run citation leg', () => {
  it('fires when a citation names a script no manifest defines', () => {
    const problems = evaluateDocClosure(
      makeSurface({
        cites: [{ path: 'docs/a.md', line: 9, token: 'lint:gone', elided: false }],
      }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('docs/a.md:9') && p.includes('lint:gone') && p.includes('no tracked'),
      ),
    );
  });

  it('admits an elided family stem while a key starts with it, and fires when none does', () => {
    const good = evaluateDocClosure(
      makeSurface({ cites: [{ path: 'docs/a.md', line: 2, token: 'lint:', elided: true }] }),
    );
    assert.deepEqual(good, []);
    const bad = evaluateDocClosure(
      makeSurface({ cites: [{ path: 'docs/a.md', line: 2, token: 'corpus:', elided: true }] }),
    );
    assert.ok(bad.some((p) => p.includes('corpus:') && p.includes('no script key starts with')));
  });
});

describe('evaluateDocClosure — script-key citation leg', () => {
  it('fires with file:line when an admitted token is not a defined key', () => {
    const problems = evaluateDocClosure(
      makeSurface({ colonCites: [{ path: 'docs/a.md', line: 12, token: 'lint:retired' }] }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('docs/a.md:12') &&
          p.includes('`lint:retired`') &&
          p.includes('no tracked package.json defines that script key'),
      ),
      problems.join('\n'),
    );
  });

  it('fires on a stale cite that merely PREFIXES a live key (the renamed-script case)', () => {
    const problems = evaluateDocClosure(
      makeSurface({ colonCites: [{ path: 'docs/a.md', line: 4, token: 'lint:j' }] }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('`lint:j`') && p.includes('no tracked package.json defines that script key'), // prettier-ignore
      ),
      problems.join('\n'),
    );
  });

  it('passes a defined key', () => {
    assert.deepEqual(
      evaluateDocClosure(
        makeSurface({ colonCites: [{ path: 'docs/a.md', line: 4, token: 'test:shared' }] }),
      ),
      [],
    );
  });
});

// Fixture rows for the duplicates family, keyed to the check's own exported
// DUPLICATE_SURFACES list. The lock below holds the two key sets equal, so a
// surface added to the check's loop without a fixture row reds here — the
// addition direction the per-leg tests alone cannot see.
const DUPLICATE_FIXTURES = {
  workflowRows: ['test.yml', 'publish.yml', 'test.yml'],
  actRows: ['lint', 'unit-tests', 'desktop-rust-tests', 'lint'],
  jobIds: ['lint', 'unit-tests', 'desktop-rust-tests', 'lint'],
  gateRows: [
    ...makeSurface().gateRows,
    { gate: 'ESLint', tokens: ['lint:js'], where: ['lint'], command: 'npm run lint:js' },
  ],
  jobsTableRows: [
    ...makeSurface().jobsTableRows,
    { job: 'unit-tests', flags: ['ci'], alias: null },
  ],
  chainTokens: ['lint:js', 'lint:format', 'lint:js'],
};

describe('evaluateDocClosure — duplicates, every leg of the duplicates loop', () => {
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
    it(`fires on a duplicate in ${what}`, () => {
      const problems = evaluateDocClosure(makeSurface({ [key]: DUPLICATE_FIXTURES[key] }));
      assert.ok(
        problems.some((p) => p.includes('more than once') && p.includes(what)),
        problems.join('\n') || `no duplicates diagnostic for ${what}`,
      );
    });
  }
});

describe('evaluateDocClosure — empty parses are structural failures', () => {
  it('the export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, message]) => message);
    assert.equal(new Set(messages).size, messages.length);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const empty = key === 'scriptKeys' ? new Set() : [];
      const problems = evaluateDocClosure(makeSurface({ [key]: empty }));
      assert.ok(
        problems.some((p) => p.includes(message)),
        problems.join('\n') || `no vacuous diagnostic for ${key}`,
      );
    });
  }
});

describe('evaluateDocClosure — unreadable surfaces are refused ahead of the diffs', () => {
  it('reports each unreadable family with its own diagnosis', () => {
    const problems = evaluateDocClosure(
      makeSurface({
        workflowUnreadable: ['**bold nonsense**'],
        actUnreadable: ['two `ids` here'],
        gatesUnreadable: ['| | empty gate |'],
        jobsTableUnreadable: ['| prose | flags |'],
        citeUnreadable: ['docs/a.md:7 `npm run lint:`'],
      }),
    );
    assert.ok(problems.some((p) => p.includes('bold nonsense') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('two `ids` here') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('empty gate') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('| prose | flags |') && p.includes('cannot read')));
    // The jobs-table refusal teaches the deferral form literally, so an
    // author reading the red does not have to reverse-engineer the grammar.
    assert.ok(
      problems.some(
        (p) => p.includes('| prose | flags |') && p.includes('after `<job>`, same flags'),
      ),
      problems.join('\n'),
    );
    assert.ok(problems.some((p) => p.includes('docs/a.md:7') && p.includes('cannot read')));
  });
});

describe('linkedFileName / extractTableFileNames', () => {
  it('reads bare and link-wrapped backticked names, refusing anything else', () => {
    assert.equal(linkedFileName('`test.yml`'), 'test.yml');
    assert.equal(linkedFileName('[`test.yml`](../../.github/workflows/test.yml)'), 'test.yml');
    assert.equal(linkedFileName('plain words'), null);
    assert.equal(linkedFileName('[`a.yml`](x) trailing'), null);
  });

  it('selects the one table by section AND first header cell', () => {
    const doc = [
      '## Other section',
      '',
      '| Workflow | Note |',
      '| -------- | ---- |',
      '| `decoy.yml` | not this one |',
      '',
      '## Target',
      '',
      '| Something | Else |',
      '| --------- | ---- |',
      '| `sibling.yml` | not this one either |',
      '',
      '| Workflow | Note |',
      '| -------- | ---- |',
      '| [`real.yml`](x) | yes |',
      '| unreadable cell | no |',
    ].join('\n');
    const read = extractTableFileNames(doc, 'Target', 'Workflow');
    assert.deepEqual(read.names, ['real.yml']);
    assert.deepEqual(read.unreadable, ['unreadable cell']);
  });
});

describe('extractGateRows', () => {
  const doc = (...rows) =>
    [
      '## The test suite (`test.yml`)',
      '',
      '| Gate | Where | Red when | Local command |',
      '| ---- | ----- | -------- | ------------- |',
      ...rows,
    ].join('\n');

  it('reads the Local-command column only, keeping every token in it', () => {
    const read = extractGateRows(
      doc(
        '| ESLint | `lint` | `npm run lint:md` breaks in prose | `npm run lint:js` |',
        '| rustfmt | `lint` | style | `cargo fmt --check` |',
      ),
    );
    assert.deepEqual(
      read.rows.map((row) => [row.gate, row.tokens]),
      [
        ['ESLint', ['lint:js']],
        ['rustfmt', []],
      ],
    );
    assert.deepEqual(read.unreadable, []);
  });

  it('takes the gate claim as the LEADING backticked command, trailing remarks being commentary', () => {
    const read = extractGateRows(
      doc(
        '| Prettier | `lint` | style | `npm run lint:format` (fix: `npm run format`) |',
        '| sync-shared freshness | `unit-tests` | stale | `npm run sync-shared`, then commit the result |',
        '| Clippy | `desktop-rust-tests`, `desktop-cross-compile` | warnings | `cargo clippy -- -D warnings` (from `packages/desktop/src-tauri`) |',
      ),
    );
    assert.deepEqual(
      read.rows.map((row) => row.command),
      ['npm run lint:format', 'npm run sync-shared', 'cargo clippy -- -D warnings'],
    );
    // The parenthetical's own token stays visible to the citation leg.
    assert.deepEqual(read.rows[0].tokens, ['lint:format', 'format']);
  });

  it('reads every shipped Where shape, taking non-backticked remainder as qualifier prose', () => {
    const read = extractGateRows(
      doc(
        '| ESLint | `lint` | rule | `npm run lint:js` |',
        '| Release-output guard | `lint` (PRs only) | outputs | `npm run check:no-release-outputs` |',
        '| Clippy | `desktop-rust-tests`, `desktop-cross-compile` | warnings | `cargo clippy` |',
      ),
    );
    assert.deepEqual(
      read.rows.map((row) => row.where),
      [['lint'], ['lint'], ['desktop-rust-tests', 'desktop-cross-compile']],
    );
  });

  it('refuses a row with an empty gate cell, a Where cell naming no job, or no command', () => {
    const read = extractGateRows(
      doc(
        '|  | `lint` | mystery | `npm run lint:js` |',
        '| Nowhere | every job, really | mystery | `npm run lint:js` |',
        '| Wordless | `lint` | mystery | run it yourself |',
      ),
    );
    assert.deepEqual(read.rows, []);
    assert.equal(read.unreadable.length, 3);
  });

  it('refuses a gates table with no Where column at all', () => {
    const read = extractGateRows(
      [
        '## The test suite (`test.yml`)',
        '',
        '| Gate | Red when | Local command |',
        '| ---- | -------- | ------------- |',
        '| ESLint | rule | `npm run lint:js` |',
      ].join('\n'),
    );
    assert.deepEqual(read.rows, []);
    assert.ok(read.unreadable[0].includes('no `Where` column'));
  });
});

describe('extractJobsTableRows', () => {
  const doc = (...rows) =>
    [
      '## The test suite (`test.yml`)',
      '',
      '| Job | Runs on a PR when the diff sets | Runner | What it verifies |',
      '| --- | ------------------------------- | ------ | ---------------- |',
      ...rows,
    ].join('\n');

  it('reads the job and its bare flag words, comma- and `or`-separated', () => {
    const read = extractJobsTableRows(
      doc(
        '| `unit-tests` | extension, desktop, shared, schema, corpus, ci, or ciCore | ubuntu | tests |',
        '| `desktop-cross-compile` | desktop, shared, or ciCore | windows | compile |',
      ),
    );
    assert.deepEqual(read.rows, [
      { job: 'unit-tests', flags: ['extension', 'desktop', 'shared', 'schema', 'corpus', 'ci', 'ciCore'], alias: null }, // prettier-ignore
      { job: 'desktop-cross-compile', flags: ['desktop', 'shared', 'ciCore'], alias: null },
    ]);
    assert.deepEqual(read.unreadable, []);
  });

  it('reads the deferring form as a reference, not as flag words', () => {
    const read = extractJobsTableRows(
      doc('| `desktop-corpus-diff` | after `desktop-rust-tests`, same flags | ubuntu | diff |'),
    );
    assert.deepEqual(read.rows, [
      { job: 'desktop-corpus-diff', flags: null, alias: 'desktop-rust-tests' },
    ]);
  });

  it('refuses a first cell that is not a lone job id and a flag cell in neither form', () => {
    const read = extractJobsTableRows(
      doc(
        '| the `unit-tests` job | desktop | ubuntu | tests |',
        '| `desktop-rust-tests` | whenever it feels like it | windows | tests |',
      ),
    );
    assert.deepEqual(read.rows, []);
    assert.equal(read.unreadable.length, 2);
  });

  it('refuses a table with no flag column', () => {
    const read = extractJobsTableRows(
      [
        '## The test suite (`test.yml`)',
        '',
        '| Job | Runner |',
        '| --- | ------ |',
        '| `unit-tests` | ubuntu |',
      ].join('\n'),
    );
    assert.deepEqual(read.rows, []);
    assert.ok(read.unreadable[0].includes('no `Runs on a PR when the diff sets` column'));
  });
});

describe('extractAlwaysRunIds', () => {
  const doc = [
    '## The test suite (`test.yml`)',
    '',
    '### Jobs that always run',
    '',
    'These jobs run on every PR: `changes`, `lint` — plus `ci-gate`, which',
    'runs unconditionally (`if: always()`).',
    '',
    '### Path-filtered test jobs',
    '',
    'The remaining jobs, among them `unit-tests`, run on a flag.',
  ].join('\n');

  it('collects the backticked job ids of that subsection only', () => {
    const read = extractAlwaysRunIds(doc);
    assert.deepEqual(read.ids, ['changes', 'lint', 'ci-gate']);
    assert.deepEqual(read.problems, []);
  });

  it('anchors loudly when the subsection heading is gone', () => {
    const read = extractAlwaysRunIds('## Something else\n\nProse.\n');
    assert.deepEqual(read.ids, []);
    assert.ok(read.problems[0].includes('Jobs that always run'));
    assert.ok(read.problems[0].includes('cannot anchor'));
  });

  it('never reads a fenced example as a claim', () => {
    const fenced = [
      '### Jobs that always run',
      '',
      'Prose naming `lint`.',
      '',
      '```text',
      'once upon a time `retired-job` ran here',
      '```',
    ].join('\n');
    assert.deepEqual(extractAlwaysRunIds(fenced).ids, ['lint']);
  });
});

describe('extractJobIds / jobNpmRunTokens', () => {
  const wf = [
    'name: test',
    'on: push',
    'env:',
    '  lint: "a two-space key before jobs: must not anchor the step scan"',
    'jobs:',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: ESLint',
    '        run: npm run lint:js',
    '      - name: Prettier',
    "        run: npm run lint:format ${{ runner.debug == '1' && '-- --log-level debug' || '' }}",
    '      - name: Install',
    '        run: npm ci',
    '  unit-tests:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm run test:shared',
    'env:',
    '  IGNORED: "  fake-job:"',
  ].join('\n');

  it('collects the two-space job keys of the jobs block only', () => {
    const read = extractJobIds(wf);
    assert.deepEqual(read.ids, ['lint', 'unit-tests']);
    assert.deepEqual(read.problems, []);
  });

  it('anchors loudly when jobs: is absent — the line scan naming itself', () => {
    const read = extractJobIds('name: test\non: push\n');
    assert.deepEqual(read.ids, []);
    assert.ok(read.problems[0].includes('no top-level `jobs:` key'));
    assert.ok(read.problems[0].includes('the job scan'));
  });

  it('collects one job’s npm-run tokens from the parsed step commands', () => {
    // Parsed, so the fixture is the workflow shape the parse reads — the line
    // scan's raw-text fixture above is what the retired reader needed.
    const parsed = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - name: ESLint',
      '        run: npm run lint:js',
      '      - name: Prettier',
      "        run: npm run lint:format ${{ runner.debug == '1' && '-- --log-level debug' || '' }}",
      '      - name: Install',
      '        run: npm ci',
      '  unit-tests:',
      '    steps:',
      '      - run: npm run test:shared',
    ].join('\n');
    const jobs = extractWorkflowGating(parsed).jobs;
    assert.deepEqual(jobNpmRunTokens(jobs, 'lint').tokens, ['lint:js', 'lint:format']);
    assert.deepEqual(jobNpmRunTokens(jobs, 'unit-tests').tokens, ['test:shared']);
  });

  it('reads only text the job runs — never a display name, a comment, or an action input', () => {
    // The retired line scan read the job's raw lines, so a token anywhere in
    // them counted. Reading the parsed step commands is what draws the line at
    // what the runner executes.
    const noisy = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      # npm run phantom-comment',
      '      - name: npm run phantom-name',
      '        run: npm run real-gate',
      '      - uses: some/action@abc123',
      '        with:',
      '          args: npm run phantom-with',
    ].join('\n');
    const jobs = extractWorkflowGating(noisy).jobs;
    assert.deepEqual(jobNpmRunTokens(jobs, 'lint').tokens, ['real-gate']);
  });

  it('anchors loudly when the job is absent', () => {
    const read = jobNpmRunTokens([{ id: 'lint', stepLines: [] }], 'ghost');
    assert.deepEqual(read.tokens, []);
    assert.ok(read.problems[0].includes('no `ghost` job'));
  });
});

describe('extractWorkflowGating', () => {
  const wf = [
    'jobs:',
    '  changes:',
    '    steps:',
    '      - uses: dorny/paths-filter@abc123 # v4',
    '        id: filter',
    '        with:',
    '          filters: |',
    '            desktop:',
    "              - 'packages/desktop/**'",
    '            ci:',
    "              - 'scripts/**'",
    '  lint:',
    '    needs: [changes]',
    '    steps:',
    '      - run: npm run lint:js',
    '  unit-tests:',
    '    if: |',
    "      needs.changes.outputs.ci == 'true' ||",
    "      github.event_name == 'push'",
    '    steps:',
    '      - run: |',
    '          npm ci',
    '          npm run test:shared',
  ].join('\n');

  it('reads each job’s gating flags, step lines, and the nested filter map', () => {
    const read = extractWorkflowGating(wf);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(
      read.jobs.map((job) => [job.id, job.flags]),
      [
        ['changes', []],
        ['lint', []],
        ['unit-tests', ['ci']],
      ],
    );
    assert.deepEqual(read.jobs[2].stepLines, ['npm ci', 'npm run test:shared']);
    assert.deepEqual(read.filterFlags, ['desktop', 'ci']);
    // The `if:` text itself, which the side derivation needs to stay total.
    assert.equal(read.jobs[0].condition, null);
    assert.ok(read.jobs[2].condition.includes('needs.changes.outputs.ci'));
  });

  it('refuses unparseable YAML and a file with no jobs mapping', () => {
    assert.ok(extractWorkflowGating('a: [1,').problems[0].includes('does not parse as YAML'));
    assert.ok(extractWorkflowGating('name: test\n').problems[0].includes('no `jobs:` mapping'));
  });

  it('refuses a missing changes job, a missing filter step, and an unreadable filters block, each as its own anchor', () => {
    const noChanges = extractWorkflowGating('jobs:\n  lint:\n    steps: []\n');
    assert.ok(noChanges.problems[0].includes('no `changes` job'));
    const noStep = extractWorkflowGating(
      'jobs:\n  changes:\n    steps:\n      - uses: actions/checkout@abc\n',
    );
    assert.ok(noStep.problems[0].includes('no `paths-filter` step'));
    const noFilters = extractWorkflowGating(
      'jobs:\n  changes:\n    steps:\n      - uses: dorny/paths-filter@abc\n        with:\n          base: main\n',
    );
    assert.ok(noFilters.problems[0].includes('no `with.filters` block'));
    const unreadable = extractWorkflowGating(
      "jobs:\n  changes:\n    steps:\n      - uses: dorny/paths-filter@abc\n        with:\n          filters: 'just prose'\n",
    );
    assert.ok(unreadable.problems[0].includes('does not parse as a mapping'));
    // The same refusal for a block that is not YAML at all: the nested parse
    // throws rather than yielding a non-mapping, and both routes are one
    // anchor problem — the map could not be read.
    const unparseable = extractWorkflowGating(
      [
        'jobs:',
        '  changes:',
        '    steps:',
        '      - uses: dorny/paths-filter@abc',
        '        with:',
        '          filters: |',
        '            a: [1,',
      ].join('\n'),
    );
    assert.deepEqual(unparseable.filterFlags, []);
    assert.ok(unparseable.problems[0].includes('does not parse as a mapping'));
    // Distinct from all of those: a well-formed map that simply defines nothing,
    // which the non-empty guard reports instead.
    const empty = extractWorkflowGating(
      "jobs:\n  changes:\n    steps:\n      - uses: dorny/paths-filter@abc\n        with:\n          filters: '{}'\n",
    );
    assert.deepEqual(empty.problems, []);
    assert.deepEqual(empty.filterFlags, []);
  });
});

describe('extractLintSurface / collectScriptKeys', () => {
  it('reads the chain tokens, the lint:* family, and the script commands', () => {
    const read = extractLintSurface(
      JSON.stringify({
        scripts: {
          lint: 'npm run lint:js && npm run lint:format',
          'lint:js': 'eslint .',
          'lint:format': 'prettier --check .',
          format: 'prettier --write .',
        },
      }),
    );
    assert.deepEqual(read.chainTokens, ['lint:js', 'lint:format']);
    assert.deepEqual(read.lintKeys, ['lint:js', 'lint:format']);
    assert.equal(read.commands['lint:js'], 'eslint .');
    assert.deepEqual(read.problems, []);
  });

  it('is loud on an unparseable manifest, a missing scripts object, and a missing chain', () => {
    assert.ok(extractLintSurface('not json').problems[0].includes('does not parse'));
    assert.ok(extractLintSurface('{}').problems[0].includes('no scripts object'));
    assert.ok(
      extractLintSurface('{"scripts":{"lint:js":"eslint ."}}').problems[0].includes(
        'no `lint` chain',
      ),
    );
  });

  it('unions script keys across manifests and refuses an unparseable one', () => {
    const read = collectScriptKeys([
      { path: 'package.json', text: '{"scripts":{"a":"x"}}' },
      { path: 'sub/package.json', text: '{"scripts":{"b":"y"}}' },
      { path: 'bad/package.json', text: 'nope' },
    ]);
    assert.deepEqual([...read.keys].sort(), ['a', 'b']);
    assert.ok(read.problems[0].includes('bad/package.json'));
  });
});

describe('extractNpmRunCites', () => {
  it('reads tokens from prose and fenced blocks alike, with elision marked', () => {
    const doc = [
      'Run `npm run lint:js` first.',
      '```bash',
      'npm run sync-shared && npm run build:desktop-dist',
      'npm run sufficiency:check -- --write-baseline x.json',
      '```',
      'The whole family: `npm run lint:…` and `cargo …`.',
    ].join('\n');
    const read = extractNpmRunCites(doc, 'docs/x.md');
    assert.deepEqual(read.cites, [
      { path: 'docs/x.md', line: 1, token: 'lint:js', elided: false },
      { path: 'docs/x.md', line: 3, token: 'sync-shared', elided: false },
      { path: 'docs/x.md', line: 3, token: 'build:desktop-dist', elided: false },
      { path: 'docs/x.md', line: 4, token: 'sufficiency:check', elided: false },
      { path: 'docs/x.md', line: 6, token: 'lint:', elided: true },
    ]);
    assert.deepEqual(read.unreadable, []);
  });

  it('refuses a colon-terminated token that is not an elision', () => {
    const read = extractNpmRunCites('Broken: `npm run lint:` here.', 'docs/x.md');
    assert.deepEqual(read.cites, []);
    assert.ok(read.unreadable[0].includes('docs/x.md:1'));
  });
});

describe('extractColonCites / admitColonCites', () => {
  it('reads colon-joined backticked tokens with their line, and nothing else', () => {
    const doc = [
      'The `lint:js` gate and the `capture:action` event.',
      'Not tokens: `npm run lint:js`, `Lint:JS`, `packages/x/y.js`, `changes`.',
      'A deeper key: `corpus:check:desktop`.',
    ].join('\n');
    assert.deepEqual(extractColonCites(doc, 'docs/x.md'), [
      { path: 'docs/x.md', line: 1, token: 'lint:js' },
      { path: 'docs/x.md', line: 1, token: 'capture:action' },
      { path: 'docs/x.md', line: 3, token: 'corpus:check:desktop' },
    ]);
  });

  it('admits only the tokens the register carries, whatever family they read as', () => {
    const cites = extractColonCites(
      '`lint:js` `capture:action` `node:http` `corpus:check`',
      'd.md',
    );
    assert.deepEqual(
      admitColonCites(cites, ['lint:js', 'corpus:check']).map((cite) => cite.token),
      ['lint:js', 'corpus:check'],
    );
    // A token sharing a live family's stem is NOT admitted by that alone —
    // the false red the register exists to close.
    assert.deepEqual(admitColonCites(cites, ['lint:js']).map((cite) => cite.token), ['lint:js']); // prettier-ignore
  });

  it('leaves an unregistered token unread — it is not a script citation', () => {
    const cites = extractColonCites(
      'The `capture:action` event channel, beside `lint:js`.',
      'docs/x.md',
    );
    const admitted = admitColonCites(cites, ['lint:js']);
    assert.deepEqual(
      admitted.map((cite) => cite.token),
      ['lint:js'],
    );
    // …so the unadmitted token never reaches the evaluator's red path.
    assert.deepEqual(
      evaluateDocClosure(
        makeSurface({
          colonCites: admitted,
          allColonCites: cites,
          registeredColonCites: ['lint:js'],
        }),
      ),
      [],
    );
  });

  it('reds a registered token that is no longer a defined key — the family-rename miss', () => {
    // The direction the family-stem admission could not hold: renaming the
    // family took the token out of the leg with it, silently.
    const cite = { path: 'docs/a.md', line: 4, token: 'corpus:check:desktop' };
    const problems = evaluateDocClosure(
      makeSurface({
        colonCites: [cite],
        allColonCites: [cite],
        registeredColonCites: ['corpus:check:desktop'],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('docs/a.md:4') && p.includes('a registered script-key citation')), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('reds a defined key cited but unregistered, and a registered token nothing cites', () => {
    const cite = { path: 'docs/a.md', line: 9, token: 'test:shared' };
    const registered = { path: 'docs/a.md', line: 3, token: 'lint:js' };
    const problems = evaluateDocClosure(
      makeSurface({
        colonCites: [registered],
        allColonCites: [registered, cite],
        registeredColonCites: ['lint:js', 'format:never-cited'],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('docs/a.md:9') && p.includes('register does not carry it')),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((p) => p.includes('`format:never-cited`') && p.includes('no tracked markdown cites it')), // prettier-ignore
      problems.join('\n'),
    );
  });
});

describe('the runner cells and the act verdict', () => {
  const jobs = () => [
    { id: 'lint', runners: ['ubuntu-latest'], uploads: [], downloads: [], usesSecret: false },
    { id: 'win-only', runners: ['windows-latest'], uploads: ['vectors'], downloads: [], usesSecret: false }, // prettier-ignore
    { id: 'both-legs', runners: ['windows-latest', 'ubuntu-latest'], uploads: [], downloads: [], usesSecret: false }, // prettier-ignore
    { id: 'consumer', runners: ['ubuntu-latest'], uploads: [], downloads: ['vectors'], usesSecret: false }, // prettier-ignore
    { id: 'uploader', runners: ['ubuntu-latest'], uploads: [], downloads: [], usesSecret: true },
    { id: 'pattern-consumer', runners: ['ubuntu-latest'], uploads: [], downloads: [], usesSecret: false }, // prettier-ignore
  ];

  it('derives the boundary facts, and only those', () => {
    const all = jobs();
    const of = (id) =>
      deriveActVerdict(
        all.find((j) => j.id === id),
        all,
      );
    assert.equal(of('lint'), 'yes');
    assert.equal(of('win-only'), 'no', 'every runner is Windows');
    assert.equal(of('both-legs'), 'partial', 'a Linux leg beside a Windows one');
    assert.equal(of('consumer'), 'no', 'the artifact it downloads is produced on Windows');
    assert.equal(of('uploader'), 'no', 'a repository secret is outside a local run');
    // The recorded boundary: an artifact taken by PATTERN names no producer,
    // so the job is read as consuming nothing and its verdict rests on the
    // facts that ARE derivable.
    assert.equal(of('pattern-consumer'), 'yes');
  });

  it('reads each table’s runner column through that table’s own matrix spelling', () => {
    const [ciGrammar, localGrammar] = RUNNER_TABLES;
    const ciDoc = [
      `## ${ciGrammar.section}`,
      '',
      `| ${ciGrammar.header} | Runs on a PR when the diff sets | ${ciGrammar.column} | What it verifies |`,
      '| --- | --- | --- | --- |',
      '| `both-legs` | ci | windows-latest + ubuntu | x |',
      '| `win-only` | ci | windows-2022 (deliberately pinned) | x |',
    ].join('\n');
    const localDoc = [
      `## ${localGrammar.section}`,
      '',
      `| ${localGrammar.header} | ${localGrammar.column} | Runs under \`act\`? |`,
      '| --- | --- | --- |',
      '| `both-legs` | windows-latest **and** ubuntu matrix | ✅ the ubuntu leg only |',
      '| `lint` | ubuntu | ✅ yes |',
    ].join('\n');
    assert.deepEqual(extractRunnerCells(ciDoc, ciGrammar).rows, [
      { job: 'both-legs', runners: ['windows-latest', 'ubuntu-latest'], rationale: false },
      { job: 'win-only', runners: ['windows-2022'], rationale: true },
    ]);
    assert.deepEqual(extractRunnerCells(localDoc, localGrammar).rows, [
      { job: 'both-legs', runners: ['windows-latest', 'ubuntu-latest'], rationale: false },
      { job: 'lint', runners: ['ubuntu-latest'], rationale: false },
    ]);
    // The shorthand a cell may write completes to the image the workflow names.
    assert.equal(completeRunnerLabel('ubuntu'), 'ubuntu-latest');
    assert.equal(completeRunnerLabel('windows-2022'), 'windows-2022');
  });

  it('reads the act verdict as the class its cell opens with, refusing an unknown opening', () => {
    const doc = [
      `## ${RUNNER_TABLES[1].section}`,
      '',
      `| ${RUNNER_TABLES[1].header} | CI runner | Runs under \`act\`? |`,
      '| --- | --- | --- |',
      '| `lint` | ubuntu | ✅ yes |',
      '| `win-only` | windows-latest | ❌ no — Windows-only |',
      '| `tool` | ubuntu | unneeded — the tool runs directly |',
      '| `gate` | ubuntu | nothing to run — it aggregates |',
      '| `odd` | ubuntu | maybe? |',
    ].join('\n');
    const read = extractActVerdicts(doc);
    assert.deepEqual(
      read.rows.map((r) => [r.job, r.verdict]),
      [
        ['lint', 'yes'],
        ['win-only', 'no'],
        ['tool', 'unneeded'],
        ['gate', 'nothing to run'],
      ],
    );
    assert.equal(read.unreadable.length, 1);
    assert.match(read.unreadable[0], /`odd` opens its act verdict "maybe\?"/);
  });

  it('refuses a table whose runner or verdict column is gone, and an empty cell', () => {
    const [ciGrammar, localGrammar] = RUNNER_TABLES;
    const noColumn = [
      `## ${ciGrammar.section}`,
      '',
      `| ${ciGrammar.header} | What it verifies |`,
      '| --- | --- |',
      '| `lint` | x |',
    ].join('\n');
    assert.match(
      extractRunnerCells(noColumn, ciGrammar).unreadable[0],
      /states no `Runner` column/,
    );
    const emptyCell = [
      `## ${localGrammar.section}`,
      '',
      `| ${localGrammar.header} | ${localGrammar.column} | Runs under \`act\`? |`,
      '| --- | --- | --- |',
      '| `lint` |  | ✅ yes |',
    ].join('\n');
    assert.match(
      extractRunnerCells(emptyCell, localGrammar).unreadable[0],
      /`lint` states an empty CI runner cell/,
    );
    const noVerdict = [
      `## ${localGrammar.section}`,
      '',
      `| ${localGrammar.header} | ${localGrammar.column} |`,
      '| --- | --- |',
      '| `lint` | ubuntu |',
    ].join('\n');
    assert.match(extractActVerdicts(noVerdict).unreadable[0], /states no .* column/);
  });

  it('reports an unreadable runner cell and an unreadable verdict ahead of the diffs', () => {
    const problems = evaluateDocClosure(
      makeSurface({
        runnerCellsUnreadable: ['docs/guides/ci.md: `lint` states an empty Runner cell'],
        actVerdictsUnreadable: ['docs/guides/local-ci.md: `lint` opens its act verdict "maybe?"'],
      }),
    );
    assert.ok(problems.some((p) => p.startsWith('runner cell the scan cannot read —')));
    assert.ok(problems.some((p) => p.startsWith('act verdict the scan cannot read —')));
  });

  it('reds a falsified or deleted runner cell, in both directions', () => {
    const problems = evaluateRunnerCells({
      workflowJobs: jobs(),
      runnerCells: [
        { doc: 'docs/guides/ci.md', rows: [{ job: 'lint', runners: ['commodore-64'] }] },
        { doc: 'docs/guides/local-ci.md', rows: [{ job: 'both-legs', runners: ['ubuntu-latest'] }] }, // prettier-ignore
      ],
      actVerdicts: [],
    });
    assert.ok(problems.some((p) => p.includes('`commodore-64`') && p.includes('does not run it there'))); // prettier-ignore
    assert.ok(problems.some((p) => p.includes('`ubuntu-latest`') && p.includes('docs/guides/ci.md does not state it'))); // prettier-ignore
    assert.ok(problems.some((p) => p.includes('`windows-latest`') && p.includes('docs/guides/local-ci.md does not state it'))); // prettier-ignore
  });

  it('holds the boundary verdicts exactly and admits the recommendations', () => {
    const surface = (actVerdicts) => ({ workflowJobs: jobs(), runnerCells: [], actVerdicts });
    assert.deepEqual(
      evaluateRunnerCells(surface([{ job: 'lint', verdict: 'unneeded', partial: false }])),
      [],
      'advice about a job that CAN run is admitted',
    );
    assert.ok(
      evaluateRunnerCells(surface([{ job: 'win-only', verdict: 'unneeded', partial: false }])).some(
        (p) => p.includes('outside what a Linux container can run'),
      ),
      'advice cannot stand where the tree states a boundary',
    );
    assert.ok(
      evaluateRunnerCells(surface([{ job: 'lint', verdict: 'no', partial: false }])).some((p) =>
        p.includes('states no boundary this check derives'),
      ),
    );
    assert.ok(
      evaluateRunnerCells(surface([{ job: 'both-legs', verdict: 'yes', partial: false }])).some(
        (p) => p.includes(ACT_PARTIAL_PHRASE),
      ),
    );
    assert.deepEqual(
      evaluateRunnerCells(surface([{ job: 'both-legs', verdict: 'yes', partial: true }])),
      [],
    );
    assert.ok(
      evaluateRunnerCells(surface([{ job: 'lint', verdict: 'yes', partial: true }])).some((p) =>
        p.includes('does not split across platforms'),
      ),
    );
  });
});

describe('real-tree lock', () => {
  it('the shipped tree satisfies every closure — through the CLI’s own tree listing', () => {
    const surfaces = treeSurfaces(ROOT);
    assert.deepEqual(surfaces.anchorProblems, []);
    assert.deepEqual(evaluateDocClosure(surfaces), []);
    assert.ok(surfaces.workflowFiles.length > 0);
    assert.ok(surfaces.cites.length > 0);
    assert.ok(surfaces.colonCites.length > 0);
    assert.ok(surfaces.workflowJobs.length > 0);
    assert.ok(surfaces.filterFlags.length > 0);
  });

  it('a root without the guides fails loudly, never vacuously', () => {
    // A tracked subdirectory is a working git cwd where the guides, the
    // workflow file, and every manifest read miss — their fallbacks return
    // empty and the vacuous guards red. The citation scan still finds this
    // subtree's own markdown, so that leg is deliberately not part of this
    // red.
    const surfaces = treeSurfaces(resolve(ROOT, 'docs'));
    assert.ok(surfaces.anchorProblems.length > 0);
    assert.ok(surfaces.cites.length > 0);
    const problems = evaluateDocClosure(surfaces);
    assert.ok(problems.some((p) => p.includes('no tracked workflow files found')));
    assert.ok(problems.some((p) => p.includes('no workflow-inventory rows found')));
  });

  it('the constants still point where the check reads', () => {
    for (const p of [CI_DOC_PATH, LOCAL_CI_DOC_PATH, TEST_WORKFLOW_PATH, ROOT_MANIFEST_PATH]) {
      assert.ok(readFileSync(resolve(ROOT, p), 'utf8').length > 0, p);
    }
    const ciDoc = readFileSync(resolve(ROOT, CI_DOC_PATH), 'utf8');
    const localCiDoc = readFileSync(resolve(ROOT, LOCAL_CI_DOC_PATH), 'utf8');
    const workflowYaml = readFileSync(resolve(ROOT, TEST_WORKFLOW_PATH), 'utf8');
    assert.ok(extractTableFileNames(ciDoc, WORKFLOW_SECTION, WORKFLOW_HEADER).names.length > 0);
    assert.ok(extractTableFileNames(localCiDoc, ACT_SECTION, ACT_HEADER).names.length > 0);
    assert.ok(extractGateRows(ciDoc).rows.length > 0);
    assert.ok(extractJobsTableRows(ciDoc).rows.length > 0);
    assert.ok(extractAlwaysRunIds(ciDoc).ids.length > 0);
    assert.ok(extractJobIds(workflowYaml).ids.includes(LINT_JOB_ID));
    assert.ok(extractWorkflowGating(workflowYaml).filterFlags.length > 0);
  });
});

describe('WORKFLOW_FILE_RE / workflowBasenames — the inventory leg’s boundary', () => {
  it('keeps top-level YAML and drops nested or non-YAML paths', () => {
    assert.ok(WORKFLOW_FILE_RE.test('.github/workflows/test.yml'));
    assert.ok(WORKFLOW_FILE_RE.test('.github/workflows/nightly.yaml'));
    assert.ok(!WORKFLOW_FILE_RE.test('.github/workflows/nested/inner.yml'));
    assert.ok(!WORKFLOW_FILE_RE.test('.github/workflows/readme.md'));
    assert.ok(!WORKFLOW_FILE_RE.test('.github/other/test.yml'));
  });

  it('applies that boundary on the listing path — git’s `*` crosses `/`', () => {
    assert.deepEqual(
      workflowBasenames([
        '.github/workflows/test.yml',
        '.github/workflows/nested/inner.yml',
        '.github/workflows/deep/er/still.yaml',
      ]),
      ['test.yml'],
    );
  });
});
