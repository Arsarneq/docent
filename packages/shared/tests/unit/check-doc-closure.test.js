/**
 * check-doc-closure.test.js — Unit tests for the doc-closure admission test
 * (scripts/check-doc-closure.js). The guides' closure claims are committed
 * prose, so every red-path family must fail loud: these tests prove the
 * both-way set diffs on each closure leg, the unreadable-cell and
 * unreadable-citation refusals, the extractor anchor guards, duplicates,
 * the elided-family admission, and empty parses — and, as a real-tree lock,
 * that the shipped tree satisfies every closure.
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
  linkedFileName,
  extractTableFileNames,
  extractGateRows,
  extractJobIds,
  extractJobNpmRunTokens,
  extractLintSurface,
  extractNpmRunCites,
  collectScriptKeys,
  evaluateDocClosure,
  treeSurfaces,
} from '../../../../scripts/check-doc-closure.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** A consistent synthetic surface every closure leg accepts. */
function makeSurface(overrides = {}) {
  return {
    workflowFiles: ['test.yml', 'publish.yml'],
    workflowRows: ['test.yml', 'publish.yml'],
    workflowUnreadable: [],
    jobIds: ['lint', 'unit-tests'],
    actRows: ['lint', 'unit-tests'],
    actUnreadable: [],
    gateRows: [
      { gate: 'ESLint', tokens: ['lint:js'] },
      { gate: 'Prettier', tokens: ['lint:format', 'format'] },
    ],
    gatesUnreadable: [],
    chainTokens: ['lint:js', 'lint:format'],
    lintKeys: ['lint:js', 'lint:format'],
    lintStepTokens: ['lint:js', 'lint:format'],
    cites: [{ path: 'docs/a.md', line: 3, token: 'lint:js', elided: false }],
    citeUnreadable: [],
    scriptKeys: new Set(['lint:js', 'lint:format', 'format']),
    ...overrides,
  };
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

  it('fires when an inventory row names a workflow that does not exist', () => {
    const problems = evaluateDocClosure(
      makeSurface({ workflowRows: ['test.yml', 'publish.yml', 'retired.yml'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('retired.yml') && p.includes('no such workflow file')),
    );
  });
});

describe('evaluateDocClosure — act-table leg (both ways)', () => {
  it('fires when a job is not keyed by the act table', () => {
    const problems = evaluateDocClosure(makeSurface({ jobIds: ['lint', 'unit-tests', 'new-job'] }));
    assert.ok(problems.some((p) => p.includes('new-job') && p.includes('does not key it')));
  });

  it('fires when the act table keys a job that does not exist', () => {
    const problems = evaluateDocClosure(
      makeSurface({ actRows: ['lint', 'unit-tests', 'renamed-away'] }),
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

// Fixture rows for the duplicates family, keyed to the check's own exported
// DUPLICATE_SURFACES list. The lock below holds the two key sets equal, so a
// surface added to the check's loop without a fixture row reds here — the
// addition direction the per-leg tests alone cannot see.
const DUPLICATE_FIXTURES = {
  workflowRows: ['test.yml', 'publish.yml', 'test.yml'],
  actRows: ['lint', 'unit-tests', 'lint'],
  jobIds: ['lint', 'unit-tests', 'lint'],
  gateRows: [
    { gate: 'ESLint', tokens: ['lint:js'] },
    { gate: 'Prettier', tokens: ['lint:format', 'format'] },
    { gate: 'ESLint', tokens: ['lint:js'] },
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
        citeUnreadable: ['docs/a.md:7 `npm run lint:`'],
      }),
    );
    assert.ok(problems.some((p) => p.includes('bold nonsense') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('two `ids` here') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('empty gate') && p.includes('cannot read')));
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
  it('reads the Local-command column only, keeping every token in it', () => {
    const doc = [
      '## The test suite (`test.yml`)',
      '',
      '| Gate | Where | Red when | Local command |',
      '| ---- | ----- | -------- | ------------- |',
      '| ESLint | `lint` | `npm run lint:md` breaks in prose | `npm run lint:js` |',
      '| Prettier | `lint` | style | `npm run lint:format` (fix: `npm run format`) |',
      '| rustfmt | `lint` | style | `cargo fmt --check` |',
    ].join('\n');
    const read = extractGateRows(doc);
    assert.deepEqual(read.rows, [
      { gate: 'ESLint', tokens: ['lint:js'] },
      { gate: 'Prettier', tokens: ['lint:format', 'format'] },
      { gate: 'rustfmt', tokens: [] },
    ]);
    assert.deepEqual(read.unreadable, []);
  });

  it('refuses a row with an empty gate cell', () => {
    const doc = [
      '## The test suite (`test.yml`)',
      '',
      '| Gate | Where | Red when | Local command |',
      '| ---- | ----- | -------- | ------------- |',
      '|  | `lint` | mystery | `npm run lint:js` |',
    ].join('\n');
    const read = extractGateRows(doc);
    assert.deepEqual(read.rows, []);
    assert.equal(read.unreadable.length, 1);
  });
});

describe('extractJobIds / extractJobNpmRunTokens', () => {
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

  it('anchors loudly when jobs: is absent — both scans', () => {
    const read = extractJobIds('name: test\non: push\n');
    assert.deepEqual(read.ids, []);
    assert.ok(read.problems[0].includes('no top-level `jobs:` key'));
    const steps = extractJobNpmRunTokens('name: test\non: push\n', 'lint');
    assert.deepEqual(steps.tokens, []);
    assert.ok(steps.problems[0].includes('no top-level `jobs:` key'));
  });

  it('collects one job’s npm-run tokens, deduplicated and bounded to the job', () => {
    const read = extractJobNpmRunTokens(wf, 'lint');
    assert.deepEqual(read.tokens, ['lint:js', 'lint:format']);
    const other = extractJobNpmRunTokens(wf, 'unit-tests');
    assert.deepEqual(other.tokens, ['test:shared']);
  });

  it('anchors loudly when the job is absent', () => {
    const read = extractJobNpmRunTokens(wf, 'ghost');
    assert.deepEqual(read.tokens, []);
    assert.ok(read.problems[0].includes('no `ghost` job'));
  });
});

describe('extractLintSurface / collectScriptKeys', () => {
  it('reads the chain tokens and the lint:* family', () => {
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

describe('real-tree lock', () => {
  it('the shipped tree satisfies every closure — through the CLI’s own tree listing', () => {
    const surfaces = treeSurfaces(ROOT);
    assert.deepEqual(surfaces.anchorProblems, []);
    assert.deepEqual(evaluateDocClosure(surfaces), []);
    assert.ok(surfaces.workflowFiles.length > 0);
    assert.ok(surfaces.cites.length > 0);
  });

  it('the constants still point where the check reads', () => {
    for (const p of [CI_DOC_PATH, LOCAL_CI_DOC_PATH, TEST_WORKFLOW_PATH, ROOT_MANIFEST_PATH]) {
      assert.ok(readFileSync(resolve(ROOT, p), 'utf8').length > 0, p);
    }
    const ciDoc = readFileSync(resolve(ROOT, CI_DOC_PATH), 'utf8');
    const localCiDoc = readFileSync(resolve(ROOT, LOCAL_CI_DOC_PATH), 'utf8');
    assert.ok(extractTableFileNames(ciDoc, WORKFLOW_SECTION, WORKFLOW_HEADER).names.length > 0);
    assert.ok(extractTableFileNames(localCiDoc, ACT_SECTION, ACT_HEADER).names.length > 0);
    assert.ok(extractGateRows(ciDoc).rows.length > 0);
    assert.ok(
      extractJobIds(readFileSync(resolve(ROOT, TEST_WORKFLOW_PATH), 'utf8')).ids.includes(
        LINT_JOB_ID,
      ),
    );
  });
});
