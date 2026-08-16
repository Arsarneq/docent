/**
 * check-clippy-invocation.test.js — unit tests for the Clippy gate's
 * single-stated-invocation admission test (docs/guides/ci.md §CI-1).
 *
 * Each red path is driven on synthetic input — a small workflow object, a small
 * gates table, a small document set — so a case states one disagreement and
 * names the surface reporting it. The green path over the committed tree is a
 * real-tree lock at the end, the same shape the sibling check suites use.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CI_DOC_PATH,
  CLIPPY_GATE,
  InputError,
  STATED_INVOCATION_EXCEPTIONS,
  TEST_WORKFLOW_PATH,
  checkClippyInvocation,
  clippyGateRow,
  evaluate,
  normalizeCommand,
  statedInvocations,
  treeSurfaces,
  workflowClippySites,
} from '../../../../scripts/check-clippy-invocation.js';

const EXECUTED = 'cargo clippy --all-targets -- -D warnings';
const CRATE = 'packages/desktop/src-tauri';

/** A gates table carrying one Clippy row, in the shape the guide states it. */
const gatesDoc = ({
  where = '`desktop-rust-tests`, `desktop-cross-compile`',
  command = `\`${EXECUTED}\` (from \`${CRATE}\`)`,
  gate = CLIPPY_GATE,
} = {}) => `## The test suite (\`test.yml\`)

### The lint and freshness gates

| Gate | Where | Red when | Local command |
| ---- | ----- | -------- | ------------- |
| ESLint | \`lint\` | A rule fails. | \`npm run lint:js\` |
| ${gate} | ${where} | Any clippy warning. | ${command} |
`;

/** A workflow whose named jobs each run one clippy step. */
const workflow = ({ jobs = { 'desktop-rust-tests': {}, 'desktop-cross-compile': {} } } = {}) => ({
  jobs: Object.fromEntries(
    Object.entries(jobs).map(([id, { command = EXECUTED, directory = CRATE, extra = [] }]) => [
      id,
      {
        steps: [
          { name: 'Checkout', uses: 'actions/checkout@sha' },
          { name: 'Clippy', 'working-directory': directory, run: command },
          ...extra,
        ],
      },
    ]),
  ),
});

/** The surfaces a green evaluation reads, ready to be perturbed one at a time. */
const greenInput = () => ({
  sites: workflowClippySites(workflow()),
  row: clippyGateRow(gatesDoc()),
  stated: [
    { doc: 'docs/guides/ci.md', span: EXECUTED },
    ...STATED_INVOCATION_EXCEPTIONS.map(({ doc, span }) => ({ doc, span })),
  ],
});

describe('normalizeCommand', () => {
  it('strips workflow expressions and collapses the whitespace they leave', () => {
    assert.equal(
      normalizeCommand("cargo clippy --all-targets ${{ runner.debug == '1' && '-v' || '' }} -- -D warnings"), // prettier-ignore
      EXECUTED,
    );
  });

  it('reads a hand-wrapped command as the one command it spells', () => {
    assert.equal(normalizeCommand('  cargo clippy\n   --all-targets  '), 'cargo clippy --all-targets'); // prettier-ignore
  });

  it('reads absent text as the empty command rather than throwing', () => {
    assert.equal(normalizeCommand(undefined), '');
  });
});

describe('workflowClippySites', () => {
  it('reads one site per clippy step, with the job and directory it runs in', () => {
    assert.deepEqual(workflowClippySites(workflow()), [
      { job: 'desktop-rust-tests', command: EXECUTED, directory: CRATE },
      { job: 'desktop-cross-compile', command: EXECUTED, directory: CRATE },
    ]);
  });

  it('passes over steps that run something else', () => {
    const wf = workflow({
      jobs: {
        'desktop-rust-tests': { extra: [{ name: 'Tests', run: 'cargo test --lib' }] },
      },
    });
    assert.deepEqual(
      workflowClippySites(wf).map((s) => s.command),
      [EXECUTED],
    );
  });

  it("falls back to the job's own run defaults when a step states no directory", () => {
    const wf = {
      jobs: {
        'desktop-cross-compile': {
          defaults: { run: { 'working-directory': CRATE } },
          steps: [{ name: 'Clippy', run: EXECUTED }],
        },
      },
    };
    assert.deepEqual(workflowClippySites(wf), [
      { job: 'desktop-cross-compile', command: EXECUTED, directory: CRATE },
    ]);
  });

  it('reads a clippy call inside a multi-line run block as a site', () => {
    const wf = {
      jobs: {
        'desktop-rust-tests': {
          steps: [
            {
              name: 'Lint',
              'working-directory': CRATE,
              run: `rustup component add clippy\n${EXECUTED}\n`,
            },
          ],
        },
      },
    };
    assert.deepEqual(workflowClippySites(wf), [
      { job: 'desktop-rust-tests', command: EXECUTED, directory: CRATE },
    ]);
  });

  it('reads the shipped expression form without splitting on the `||` inside it', () => {
    const wf = {
      jobs: {
        'desktop-rust-tests': {
          steps: [
            {
              name: 'Clippy',
              'working-directory': CRATE,
              run: "cargo clippy --all-targets ${{ runner.debug == '1' && '-v' || '' }} -- -D warnings",
            },
          ],
        },
      },
    };
    assert.deepEqual(
      workflowClippySites(wf).map((s) => s.command),
      [EXECUTED],
    );
  });

  it('reads a workflow with no jobs as no sites at all', () => {
    assert.deepEqual(workflowClippySites({}), []);
  });
});

describe('clippyGateRow', () => {
  it('reads the row’s jobs, its leading command, and every span of that cell', () => {
    const row = clippyGateRow(gatesDoc());
    assert.deepEqual(row.where, ['desktop-rust-tests', 'desktop-cross-compile']);
    assert.equal(row.command, EXECUTED);
    assert.equal(row.directory, CRATE, 'the cell’s `(from …)` form is read as the directory');
  });

  it('refuses a guide whose gates table states no Clippy row', () => {
    assert.throws(() => clippyGateRow(gatesDoc({ gate: 'Stylelint' })), InputError);
  });
});

describe('statedInvocations', () => {
  const read = (docs) => (doc) => docs[doc];

  it('reads each span that opens with the command, and no other', () => {
    const docs = {
      'a.md': 'run `cargo clippy --all-targets -- -D warnings` from the crate',
      'b.md': 'the `clippy` conventions and `cargo fmt --check`',
    };
    assert.deepEqual(statedInvocations(Object.keys(docs), read(docs)), [
      { doc: 'a.md', span: EXECUTED },
    ]);
  });

  it('leaves a fenced statement outside the scan', () => {
    const docs = { 'a.md': ['```bash', `\`${EXECUTED}\``, '```'].join('\n') };
    assert.deepEqual(statedInvocations(Object.keys(docs), read(docs)), []);
  });

  it('reads spans a line at a time, so two lone backticks are not one span', () => {
    const docs = { 'a.md': ['a ` here', `and \`${EXECUTED}\` there`].join('\n') };
    assert.deepEqual(statedInvocations(Object.keys(docs), read(docs)), [
      { doc: 'a.md', span: EXECUTED },
    ]);
  });
});

describe('evaluate — the surfaces agree', () => {
  it('reports nothing when the run lines, the row, and the stated spans agree', () => {
    assert.deepEqual(evaluate(greenInput()), []);
  });

  it('admits the registered variant without asking it to match the run lines', () => {
    const input = greenInput();
    assert.ok(
      STATED_INVOCATION_EXCEPTIONS.every(({ span }) => span !== EXECUTED),
      'the register exists to admit a span the run lines do not spell',
    );
    assert.deepEqual(evaluate(input), []);
  });
});

describe('evaluate — the run lines', () => {
  it('reds when two steps spell different commands, naming the workflow', () => {
    const input = greenInput();
    input.sites = workflowClippySites(
      workflow({
        jobs: {
          'desktop-rust-tests': {},
          'desktop-cross-compile': { command: 'cargo clippy -- -D warnings' },
        },
      }),
    );
    const [problem, ...rest] = evaluate(input);
    assert.match(problem, /test\.yml runs more than one clippy command/);
    assert.deepEqual(rest, [], 'one disagreement, reported once');
  });

  it('reds when two steps run from different directories, naming the workflow', () => {
    const input = greenInput();
    input.sites = workflowClippySites(
      workflow({
        jobs: {
          'desktop-rust-tests': {},
          'desktop-cross-compile': { directory: 'packages/desktop' },
        },
      }),
    );
    assert.match(evaluate(input)[0], /runs clippy from more than one directory/);
  });

  it('reds when the directory the steps run from is not the one the row states', () => {
    const input = greenInput();
    input.row = clippyGateRow(gatesDoc({ command: `\`${EXECUTED}\` (from \`packages/desktop\`)` }));
    const [problem] = evaluate(input);
    assert.match(problem, /runs clippy from `packages\/desktop\/src-tauri`/);
    assert.match(problem, /states `packages\/desktop`/);
  });

  it('reds when the steps state no directory and the row states one', () => {
    const input = greenInput();
    input.sites = workflowClippySites({
      jobs: Object.fromEntries(
        ['desktop-rust-tests', 'desktop-cross-compile'].map((id) => [
          id,
          { steps: [{ name: 'Clippy', run: EXECUTED }] },
        ]),
      ),
    });
    const [problem] = evaluate(input);
    assert.match(problem, /runs clippy from the checkout root, while/);
    assert.match(problem, /states `packages\/desktop\/src-tauri`/);
  });

  it('reds when the row states no directory and the steps run from one', () => {
    const input = greenInput();
    input.row = clippyGateRow(gatesDoc({ command: `\`${EXECUTED}\`` }));
    const [problem] = evaluate(input);
    assert.match(problem, /states none/);
  });
});

describe('evaluate — the row’s own command', () => {
  it('reds when the row leads with a command the workflow does not run', () => {
    const input = greenInput();
    input.row = clippyGateRow(
      gatesDoc({ command: '`cargo clippy --workspace -- -D warnings` (from `' + CRATE + '`)' }),
    );
    const [problem] = evaluate(input);
    assert.match(problem, /row leads with `cargo clippy --workspace -- -D warnings`/);
    assert.match(problem, /invocation's one home/);
  });

  it('reds when the cell states a directory but no command at all', () => {
    // The reader takes a cell's LEADING span as the command, so a cell reworked
    // into prose around its directory leaves that directory standing as the
    // claimed command — the shape CI-1's leading sentence exists to refuse.
    const input = greenInput();
    input.row = clippyGateRow(gatesDoc({ command: 'the crate lint, run from `' + CRATE + '`' }));
    const [problem] = evaluate(input);
    assert.match(problem, /row leads with `packages\/desktop\/src-tauri`/);
  });
});

describe('evaluate — the row’s jobs', () => {
  it('reds on a documented job the workflow gives no clippy step, naming the guide', () => {
    const input = greenInput();
    input.sites = workflowClippySites(workflow({ jobs: { 'desktop-rust-tests': {} } }));
    const [problem] = evaluate(input);
    assert.match(problem, /ci\.md's `Clippy` row names `desktop-cross-compile`/);
  });

  it('reds on a job running clippy that the row does not name, naming the workflow', () => {
    const input = greenInput();
    input.row = clippyGateRow(gatesDoc({ where: '`desktop-rust-tests`' }));
    const [problem] = evaluate(input);
    assert.match(problem, /test\.yml's `desktop-cross-compile` runs `cargo clippy`/);
  });
});

describe('evaluate — the stated invocations', () => {
  it('reds on a stated span that is not the command the workflow runs', () => {
    const input = greenInput();
    input.stated.push({ doc: 'docs/test/desktop-rust.md', span: 'cargo clippy --all-targets' });
    const [problem] = evaluate(input);
    assert.match(problem, /^docs\/test\/desktop-rust\.md states `cargo clippy --all-targets`/);
    assert.match(problem, /check-clippy-invocation\.js/);
  });

  it('reds on a registered exception no document states any more', () => {
    const input = greenInput();
    input.stated = [{ doc: 'docs/guides/ci.md', span: EXECUTED }];
    const problems = evaluate(input);
    assert.equal(problems.length, STATED_INVOCATION_EXCEPTIONS.length);
    for (const problem of problems) assert.match(problem, /records an exception for/);
  });

  it('holds a stated span to nothing while the run lines themselves disagree', () => {
    const input = greenInput();
    input.sites = workflowClippySites(
      workflow({
        jobs: {
          'desktop-rust-tests': {},
          'desktop-cross-compile': { command: 'cargo clippy -- -D warnings' },
        },
      }),
    );
    input.stated.push({ doc: 'docs/test/desktop-rust.md', span: 'cargo clippy --all-targets' });
    assert.deepEqual(
      evaluate(input).filter((p) => p.startsWith('docs/test/desktop-rust.md')),
      [],
      'with no single executed command, a stated span has nothing to be held against',
    );
  });
});

describe('checkClippyInvocation — the refusals', () => {
  const surfaces = ({ workflow, ciDoc, markdown = [] }) => ({
    readFile: (path) =>
      path === TEST_WORKFLOW_PATH ? workflow : path === CI_DOC_PATH ? ciDoc : '',
    listMarkdown: () => markdown,
  });

  it('refuses a workflow that states no clippy step', () => {
    assert.throws(
      () =>
        checkClippyInvocation(
          surfaces({ workflow: 'jobs:\n  lint:\n    steps:\n      - run: npm ci\n', ciDoc: gatesDoc() }), // prettier-ignore
        ),
      InputError,
    );
  });

  it('refuses an empty tracked-markdown listing rather than scanning nothing', () => {
    const workflow = [
      'jobs:',
      '  desktop-rust-tests:',
      '    steps:',
      `      - working-directory: ${CRATE}`,
      `        run: ${EXECUTED}`,
      '  desktop-cross-compile:',
      '    steps:',
      `      - working-directory: ${CRATE}`,
      `        run: ${EXECUTED}`,
    ].join('\n');
    assert.throws(
      () => checkClippyInvocation(surfaces({ workflow, ciDoc: gatesDoc(), markdown: [] })),
      InputError,
    );
  });
});

describe('the committed tree', () => {
  it('states one clippy invocation, and it is the one CI runs', () => {
    assert.deepEqual(checkClippyInvocation(treeSurfaces()), []);
  });
});
