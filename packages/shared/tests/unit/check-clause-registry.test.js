/**
 * check-clause-registry.test.js — Unit tests for the clause-registry parity
 * check (scripts/check-clause-registry.js) that gates CI. Docs state clauses
 * as bold stable identifiers (**CP-3.**) and docs/clause-registry.json records
 * how each is verified; these tests prove every way the pairing can rot fails
 * loud: unregistered markers, one-sided clauses, missing justifications or
 * check-refs, citations naming dead scripts, paths, directories or root files,
 * file names cited without their path, hygiene-lock ordinals no surface states
 * or the list retires, requirement keywords in rationale text, a register the
 * check itself states going stale — an enumerated citable root file or the
 * fixture path the tree no longer carries, and a reason-bearing map list the
 * entry-list constant does not name — and reuse of retired ids. The
 * structured test-case cites get the same treatment: a row's named case is
 * resolved against the DECLARATORS of the anchor-bearing files that row's
 * check-ref cites — the title a bare `it`/`test` call states in a JavaScript
 * file, the name an `fn` declares in a Rust one, with each way a mention can
 * look like one of those red — and the cases where the field is
 * stated with nowhere to resolve it, on a row that states no check-ref, or in a
 * shape that is not a list of identifiers each red as the row problems they
 * are, while a row that states no such field stays exactly as it was and a
 * `checkable` row states it as freely as a `check-exists` one. The row grammar
 * that field joined is closed, and its closure is proved from both sides: every
 * key the grammar carries is admitted together on one row, and a key outside it
 * — a near-miss spelling of a real field most of all — is named. The
 * resolution cases run over both text fields, because one grammar covers them
 * both; the AST cases prove a marker quoted in a fenced code block is never
 * counted, the prose cases prove a version number stays outside the gate while
 * Markdown emphasis around a real citation does not hide it, and the
 * lock-surface cases prove the surfaces are held to each other on every audit —
 * a retired entry keeping its number and losing its title, the clause
 * document's own prose held to its own list, an empty parse named rather than
 * passed vacuously.
 *
 * The pattern cases run the citation grammar's own split: a glob or brace form
 * naming FILES is a pattern citation, resolved or red (matching nothing, or
 * not compiling at all — named rather than thrown); one naming DIRECTORIES
 * stays outside the gate; a trailing star run comes off as emphasis, leaving
 * the directory citation the token names; and a separator-less pattern reaches
 * no shape here at all. The sentence-final period is proved in both
 * directions — a citable root file closing a sentence resolves, a path-less
 * suite name closing one is still refused — and the two citation surfaces
 * beyond the registry get their own families: the area map's entry reasons
 * (active, retired, an identifier no active row states, an unregistered prefix
 * left unread, each list read, an absent list or an unparseable map refused
 * while a stated-but-empty list stays green) and the vector fixtures'
 * description (active, retired, unstated, an unreadable file refused).
 *
 * Which subject a red is filed under is asserted, not incidental: a surface
 * fact is the surfaces' to answer for, a map citation the map's, a fixture
 * citation the fixture's, a file that would not answer where the check reads it
 * the tree's own, and only a row's own citation is the registry's —
 * asserted through the report's own section model, so the split cannot drift
 * into a formatting detail. The read-failure family gets its own cases — a
 * registered document that will not read, a cited anchor that will not read or
 * that the tracked set does not carry, and a computed title named rather than
 * read — and the printed fix block is held to the constants it is built from,
 * each closed list rendered whole. A real-tree lock holds the committed map and
 * fixtures green.
 *
 * Because those legs are unconditional, every fixture carries all of their
 * surfaces (see {@link BASE_CONTENTS}); a case that means to red one says so.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractClauseCites,
  extractClauseMarkers,
  extractCitedTargets,
  extractDocLockCites,
  extractLockOrdinalCites,
  extractRequirementKeywords,
  fixBlock,
  isProsePathToken,
  parseLockListOrdinals,
  parseLockSuiteOrdinals,
  splitCitationTokens,
  auditClauseRegistry,
  reportSections,
  resolvePatternCitation,
  AREA_MAP_ENTRY_LISTS,
  BARE_FILE_SUFFIXES,
  CITABLE_ROOT_FILES,
  LOCK_ORDINAL_CLAUSE,
  LOCK_SUITE_PATH,
  ROW_KEYS,
  TEST_CASES_FIELD,
  VALID_TAGS,
  VECTOR_FIXTURES_PATH,
} from '../../../../scripts/check-clause-registry.js';
import { MAP_PATH } from '../../../../scripts/check-area-map.js';
import {
  ClauseRegistryInputError,
  REGISTRY_INPUT_ERROR_NAME,
  REGISTRY_PATH,
  loadRegistry,
  readTextOrNull,
  refuseOnRegistryError,
} from '../../../../scripts/governance-data.js';

/** The prefix the ordinal clause belongs to, and the doc a fixture registers it in. */
const LOCK_PREFIX = LOCK_ORDINAL_CLAUSE.split('-')[0];
const LOCK_DOC = 'docs/locks.md';

/**
 * The rule each normalized refusal states after its `;` — the house form is
 * `<subject> <verb> <token>; <rule>`, so what the gate admits is written out
 * where it is refused. Stated once here and cited by the cases, and derived
 * from the constant wherever the message interpolates one.
 */
const PATH_RULE =
  'a cited path is a tracked file — a token carrying a directory separator and ending in a dotted file name is read as one';
const BARE_FILE_RULE = `a file citation carries the repository path that identifies it, and the suffixes held that way are ${BARE_FILE_SUFFIXES.join(', ')}`;
const RUNNABLE_RULE =
  "a check that exists is an npm run target, a scripts/*.js or scripts/*.mjs file, or a suite's own code — a .js, .mjs, or .rs file under a tests/ path, or a file named *.test.js or *.spec.js";
/** The one unregistered-prefix rule, over the prefix set a fixture registers. */
const prefixRule = (...prefixes) =>
  `a registered prefix is one of the prefixes ${REGISTRY_PATH} states: ${prefixes.join(', ')}`;

/** A numbered lock list: a number is an active entry, `{ n }` a retired one. */
const lockList = (entries) =>
  `# Locks\n\n**${LOCK_ORDINAL_CLAUSE}.** Each lock is a count:\n\n` +
  entries
    .map((e) =>
      typeof e === 'number'
        ? `${e}. lock ${e} holds;`
        : `${e.n}. Retired: superseded by a later lock.`,
    )
    .join('\n') +
  '\n';

/** The suite's `lock (N):` titles for the given ordinals. */
const lockSuite = (ordinals) =>
  ordinals.map((n) => `  it('lock (${n}): holds', () => {});`).join('\n');

const LOCK_DOC_TEXT = lockList([1, 2, 3]);
const LOCK_SUITE_TEXT = lockSuite([1, 2, 3]);

/** The registry row the ordinal clause's own marker needs, for the bijection. */
const lockRow = () => ({
  doc: LOCK_DOC,
  clause: LOCK_ORDINAL_CLAUSE,
  tag: 'judgment-only',
  justification: 'a person decides',
});

/** A minimal consistent registry + doc pair, for overriding per test. */
function makeRegistry(overrides = {}) {
  return {
    description: 'test registry',
    prefixes: { TP: 'docs/testable.md', [LOCK_PREFIX]: LOCK_DOC },
    retired: { TP: [] },
    clauses: [
      {
        doc: 'docs/testable.md',
        clause: 'TP-1',
        tag: 'judgment-only',
        justification: 'a person decides',
      },
      {
        doc: 'docs/testable.md',
        clause: 'TP-2',
        tag: 'check-exists',
        'check-ref': 'Guarded by scripts/real-check.js via npm run real:check.',
      },
      lockRow(),
    ],
    ...overrides,
  };
}

const BASE_DOC = '# Testable\n\n**TP-1.** First rule.\n\n**TP-2.** Second rule.\n';

/**
 * The tracked universe every fixture starts from: the check's own register —
 * the enumerated citable root files and the vector-fixtures path, held against
 * the tracked set on every audit, cited or not — plus the fixture doc, the
 * check it names, and the two lock surfaces.
 */
const BASE_FILES = [
  ...CITABLE_ROOT_FILES,
  VECTOR_FIXTURES_PATH,
  'docs/testable.md',
  'scripts/real-check.js',
  LOCK_DOC,
  LOCK_SUITE_PATH,
];

/** The declared entry every map fixture carries, named in the reds it earns. */
const MAP_ENTRY_PATH = 'scripts/declared.js';

/** An area map whose entry reasons cite `cited`, or nothing when omitted. */
const mapWithReason = (cited) =>
  JSON.stringify({
    'declared-governance': [
      { path: MAP_ENTRY_PATH, reason: `a declared script${cited ? `, guarding ${cited}` : ''}` },
    ],
    unassigned: [{ path: 'LICENSE', reason: 'licence text, owned by no area' }],
    'governance-partitions': [{ pattern: 'packages/x/**', reason: 'each file declares its own' }],
  });

/** A fixture file whose description cites `ordinal`, or nothing when omitted. */
const fixtureCiting = (ordinal) =>
  JSON.stringify({
    description: `Enumerated vector fixtures${ordinal ? ` (lock (${ordinal}) checks them)` : ''}.`,
    fixtures: [],
  });

/**
 * The contents every fixture reads, before a case overrides them. The map and
 * the vector fixtures join the lock surfaces here for the same reason: their
 * legs run on every audit, so a case that means to red one says so.
 */
const BASE_CONTENTS = {
  'docs/testable.md': BASE_DOC,
  [LOCK_DOC]: LOCK_DOC_TEXT,
  [LOCK_SUITE_PATH]: LOCK_SUITE_TEXT,
  [MAP_PATH]: mapWithReason(null),
  [VECTOR_FIXTURES_PATH]: fixtureCiting(2),
};

function audit({
  registry = makeRegistry(),
  files = BASE_FILES,
  contents = {},
  packageScripts = ['real:check'],
} = {}) {
  const all = { ...BASE_CONTENTS, ...contents };
  return auditClauseRegistry({
    registry,
    files,
    readFile: (f) => all[f] ?? null,
    packageScripts,
  });
}

const flatten = (r) => Object.values(r).flat();

describe('extractClauseMarkers', () => {
  it('extracts bold identifier-period markers in order', () => {
    assert.deepEqual(extractClauseMarkers(BASE_DOC), ['TP-1', 'TP-2']);
  });

  it('does not match prose mentions without a number or period', () => {
    const md = 'Each rule carries an identifier (**CP-n**), and **CP-1** is bold prose.\n';
    assert.deepEqual(extractClauseMarkers(md), []);
  });

  it('does not match a marker quoted inside a fenced code block (AST correctness)', () => {
    const md = 'Example:\n\n```md\n**TP-9.** quoted, not stated\n```\n\n**TP-1.** real.\n';
    assert.deepEqual(extractClauseMarkers(md), ['TP-1']);
  });

  it('preserves duplicates so callers can flag them', () => {
    assert.deepEqual(extractClauseMarkers('**TP-1.** a\n\n**TP-1.** again\n'), ['TP-1', 'TP-1']);
  });
});

describe('extractCitedTargets', () => {
  it('pulls paths, directories, npm run names, and citable root files out of prose', () => {
    const ref =
      'Intended: scripts/next-check.js. Interim probe: scripts/other.js and the fixtures under ' +
      'packages/extension/tests/e2e/, with the rule stated in README.md; run via npm run corpus:check and npm run lint.';
    assert.deepEqual(extractCitedTargets(ref), {
      paths: ['scripts/next-check.js', 'scripts/other.js'],
      patterns: [],
      prefixes: ['packages/extension/tests/e2e/'],
      npmScripts: ['corpus:check', 'lint'],
      rootFiles: ['README.md'],
      bareFiles: [],
    });
  });

  it('admits a path only when a separator-carrying token ends in a file name', () => {
    const { paths } = extractCitedTargets(
      'the recorder/service-worker split, a 401/403 response, and docs/guides/ci.md',
    );
    assert.deepEqual(paths, ['docs/guides/ci.md']);
  });

  it('takes a separator-carrying token whole, so a mid-token prefix is never mis-read', () => {
    const { paths } = extractCitedTargets(
      'see sub-packages/foo.js and scripted-truth-corpus/vectors.json and packages/x/scripts/real.js',
    );
    assert.deepEqual(paths, [
      'sub-packages/foo.js',
      'scripted-truth-corpus/vectors.json',
      'packages/x/scripts/real.js',
    ]);
  });

  it('leaves separator-less prose names outside the grammar, and refuses bare file cites', () => {
    const { paths, rootFiles, bareFiles } = extractCitedTargets(
      'chrome.storage, recording.steps, and the assembled index.html; pinned in commands.rs and foo.test.js',
    );
    assert.deepEqual(paths, []);
    assert.deepEqual(rootFiles, []);
    assert.deepEqual(bareFiles, ['commands.rs', 'foo.test.js']);
  });

  it('every enumerated citable root file is admitted by its own bare name', () => {
    for (const name of CITABLE_ROOT_FILES) {
      const { rootFiles } = extractCitedTargets(`the rule lives in ${name} today`);
      assert.deepEqual(rootFiles, [name], name);
    }
  });

  it('reads through Markdown emphasis to the citation inside it', () => {
    const { paths } = extractCitedTargets('see **docs/x.md** and *docs/y.md* for the rule');
    assert.deepEqual(paths, ['docs/x.md', 'docs/y.md']);
  });

  it('an emphasized citation is gated, so it resolves or reds like any other', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Guarded by **scripts/real-check.js**; npm run real:check.';
    assert.deepEqual(audit({ registry }).refErrors, []);

    registry.clauses[1]['check-ref'] = 'Guarded by **scripts/gone.js**; npm run real:check.';
    assert.deepEqual(audit({ registry }).refErrors, [
      `clause "TP-2" check-ref cites scripts/gone.js; ${PATH_RULE}`,
    ]);
  });

  it('takes a glob whole, as a pattern where it names files', () => {
    const both = extractCitedTargets(
      'the vectors under corpus/sessions/*/vectors/** and the modules packages/shared/*.js',
    );
    // The directory-form glob names a set of directories, which nothing here
    // resolves; the file-form one is a pattern citation and is gated as such.
    assert.deepEqual([both.paths, both.prefixes], [[], []]);
    assert.deepEqual(both.patterns, ['packages/shared/*.js']);
  });

  it('takes a brace alternation whole, comma and all', () => {
    const out = extractCitedTargets('pinned by packages/shared/tests/unit/{a,b}.test.js today');
    assert.deepEqual([out.paths, out.prefixes, out.bareFiles], [[], [], []]);
    assert.deepEqual(out.patterns, ['packages/shared/tests/unit/{a,b}.test.js']);
  });

  it('strips a trailing star run, so `dir/**` gates as the directory it names', () => {
    const out = extractCitedTargets('everything under packages/extension/** is covered');
    assert.deepEqual([out.patterns, out.paths], [[], []]);
    assert.deepEqual(out.prefixes, ['packages/extension/']);
  });

  it('never sees a separator-less pattern: it is outside every shape here', () => {
    const out = extractCitedTargets('every *.test.js under the tree, and *.md beside it');
    assert.deepEqual(
      [out.patterns, out.paths, out.prefixes, out.rootFiles, out.bareFiles],
      [[], [], [], [], []],
    );
  });

  it('leaves a comma-separated list of real citations intact', () => {
    const { paths } = extractCitedTargets('pinned by docs/a.md, docs/b.md, and docs/c.md');
    assert.deepEqual(paths, ['docs/a.md', 'docs/b.md', 'docs/c.md']);
  });

  it('reads a comma as a separator, so an unspaced pair gates both', () => {
    const { paths } = extractCitedTargets('pinned by packages/a/x.js,packages/b/y.js today');
    assert.deepEqual(paths, ['packages/a/x.js', 'packages/b/y.js']);
  });
});

describe('splitCitationTokens — the one home of the comma rule and a part’s edges', () => {
  const tokens = (candidate) => splitCitationTokens(candidate).map((p) => p.token);

  it('strips both edges of a part: the emphasis in front, the punctuation and stars behind', () => {
    assert.deepEqual(tokens('**docs/x.md**'), ['docs/x.md']);
    assert.deepEqual(tokens('docs/x.md.'), ['docs/x.md']);
    // The strip class holds no `/`, so a directory pattern's trailing stars
    // come off while the slash that makes it a directory stays.
    assert.deepEqual(tokens('packages/extension/**'), ['packages/extension/']);
  });

  it('strips EACH part’s edges, so an unspaced emphasized pair reads as the two it is', () => {
    // The run between the two citations sits in the middle of the text a
    // caller sees; only the split knows it is two parts’ edges.
    assert.deepEqual(splitCitationTokens('**a/x.js**,**b/y.js**'), [
      { raw: '**a/x.js**', token: 'a/x.js' },
      { raw: '**b/y.js**', token: 'b/y.js' },
    ]);
  });

  it('answers with the part as WRITTEN beside the form a reader matches', () => {
    // The pair is what lets a refusal name the citation the row makes while
    // the match runs on the stripped form.
    assert.deepEqual(splitCitationTokens('*.md'), [{ raw: '*.md', token: '.md' }]);
  });

  it('keeps a comma inside a brace alternation with the pattern it belongs to', () => {
    assert.deepEqual(tokens('docs/{a,b}.md'), ['docs/{a,b}.md']);
    assert.deepEqual(tokens('docs/a.md,docs/b.md'), ['docs/a.md', 'docs/b.md']);
  });

  it('gives a part that is nothing but edges the empty token', () => {
    assert.deepEqual(tokens('**'), ['']);
    assert.deepEqual(tokens('*,*'), ['', '']);
    assert.deepEqual(tokens('**docs/a.md**,**,**docs/b.md**'), ['docs/a.md', '', 'docs/b.md']);
  });

  it('reads an empty part as no citation at all, rather than as a nonsense one', () => {
    const out = extractCitedTargets('cites **docs/a.md**,**,**docs/b.md** today');
    assert.deepEqual(
      [out.paths, out.patterns, out.prefixes, out.rootFiles, out.bareFiles],
      [['docs/a.md', 'docs/b.md'], [], [], [], []],
    );
  });
});

describe('isProsePathToken', () => {
  it('reads a version range, a measurement, and a host as prose', () => {
    assert.deepEqual(['1.2/1.3', '200/201.5', 'github.com/Arsarneq/docent'].map(isProsePathToken), [
      true,
      true,
      true,
    ]);
    assert.deepEqual(extractCitedTargets('spans 1.2/1.3, 200/201.5, github.com/o/r.git').paths, []);
  });

  it('reads a repository path as a citation, dotfile directories included', () => {
    assert.deepEqual(['docs/x.md', '.github/workflows/test.yml'].map(isProsePathToken), [
      false,
      false,
    ]);
    assert.deepEqual(extractCitedTargets('see docs/x.md today').paths, ['docs/x.md']);
  });
});

describe('extractRequirementKeywords', () => {
  it('reads the requirement keywords a text states, longest spelling first', () => {
    assert.deepEqual(
      extractRequirementKeywords('The value MUST NOT leak; a consumer SHOULD retry, and MAY stop.'),
      ['MUST NOT', 'SHOULD', 'MAY'],
    );
  });

  it('reads no keyword out of a code span, or out of ordinary words', () => {
    assert.deepEqual(
      extractRequirementKeywords('the clause quotes `MUST NOT` while the row must not restate it'),
      [],
    );
  });

  it('reads no keyword out of a doubled code span either', () => {
    assert.deepEqual(
      extractRequirementKeywords('the clause quotes ``a `SHALL` fence`` and states nothing'),
      [],
    );
  });

  it('reads every uppercase spelling the RFC defines', () => {
    assert.deepEqual(
      extractRequirementKeywords(
        'the field MUST be present and MUST NOT be empty; a client SHOULD retry, ' +
          'SHOULD NOT loop, and MAY stop; a header is REQUIRED, the flag is OPTIONAL, ' +
          'a server SHALL answer but SHALL NOT redirect; caching is RECOMMENDED and ' +
          'a plaintext fallback NOT RECOMMENDED.',
      ),
      [
        'MUST',
        'MUST NOT',
        'SHOULD',
        'SHOULD NOT',
        'MAY',
        'REQUIRED',
        'OPTIONAL',
        'SHALL',
        'SHALL NOT',
        'RECOMMENDED',
        'NOT RECOMMENDED',
      ],
    );
  });
});

describe('lock-ordinal surfaces', () => {
  it('reads ordinal citations in both spellings, deduplicated', () => {
    assert.deepEqual(
      extractLockOrdinalCites('lock 5 and lock (2); lock 5 again, not a block 9'),
      [5, 2],
    );
  });

  it('reads the hyphenated compound as the citation it is', () => {
    assert.deepEqual(extractLockOrdinalCites('held by hygiene-lock 3 alone'), [3]);
  });

  it('reads a plural conjunction as its first ordinal only (recorded residue)', () => {
    assert.deepEqual(extractLockOrdinalCites('locks 5 and 6 both probe it'), [5]);
  });

  it("reads a clause's numbered list as its active entries", () => {
    const md = '# D\n\n**SL-4.** Each lock counts:\n\n1. first;\n2. second;\n3. third.\n';
    assert.deepEqual(parseLockListOrdinals(md, 'SL-4'), { active: [1, 2, 3], retired: [] });
  });

  it('reads a retired entry as reserving its number, not as an active lock', () => {
    const md =
      '# D\n\n**SL-4.** Each lock counts:\n\n1. first;\n' +
      '2. Retired: superseded by lock 3.\n3. third.\n';
    assert.deepEqual(parseLockListOrdinals(md, 'SL-4'), { active: [1, 3], retired: [2] });
  });

  it('reads the retirement marking emphasized as well as plain', () => {
    const md = '# D\n\n**SL-4.** Each lock counts:\n\n1. first;\n2. **Retired**: gone.\n';
    assert.deepEqual(parseLockListOrdinals(md, 'SL-4'), { active: [1], retired: [2] });
  });

  it('reads the marking with the issue link the clause invites', () => {
    const forms = ['Retired (#42): gone.', '**Retired (#42):** gone.', '**Retired (#42)**: gone.'];
    for (const form of forms) {
      const md = `# D\n\n**SL-4.** Each lock counts:\n\n1. first;\n2. ${form}\n`;
      assert.deepEqual(parseLockListOrdinals(md, 'SL-4'), { active: [1], retired: [2] }, form);
    }
  });

  it('reads no list when the marker is absent, or when a heading intervenes', () => {
    assert.deepEqual(parseLockListOrdinals('**SL-4.** Each lock counts.\n', 'SL-9'), {
      active: [],
      retired: [],
    });
    assert.deepEqual(
      parseLockListOrdinals('**SL-4.** Each lock counts.\n\n## Other\n\n1. a;\n2. b.\n', 'SL-4'),
      { active: [], retired: [] },
    );
  });

  it("does not adopt a list belonging to the next clause's scope", () => {
    const md = '**SL-4.** Each lock counts.\n\n**SL-5.** Another rule:\n\n1. a;\n2. b.\n';
    assert.deepEqual(parseLockListOrdinals(md, 'SL-4'), { active: [], retired: [] });
    assert.deepEqual(parseLockListOrdinals(md, 'SL-5'), { active: [1, 2], retired: [] });
  });

  it('reads the suite lock titles, ascending and deduplicated', () => {
    const src = "it('lock (2): b', …); it('lock (1): a', …); it('lock (2): b again', …);";
    assert.deepEqual(parseLockSuiteOrdinals(src), [1, 2]);
  });
});

describe('auditClauseRegistry — green path', () => {
  it('reports nothing when docs and registry agree', () => {
    assert.deepEqual(flatten(audit()), []);
  });
});

describe('auditClauseRegistry — marker/registry parity', () => {
  it('flags a doc clause the registry has no row for', () => {
    const contents = { 'docs/testable.md': BASE_DOC + '\n**TP-3.** Unregistered rule.\n' };
    const r = audit({ contents });
    assert.deepEqual(r.markerErrors, [
      'docs/testable.md states clause "TP-3" but the registry has no row for it',
    ]);
  });

  it('flags a registry row whose clause the doc no longer states', () => {
    const contents = { 'docs/testable.md': '# Testable\n\n**TP-1.** Only rule now.\n' };
    const r = audit({ contents });
    assert.deepEqual(r.markerErrors, [
      'registry has a row for "TP-2" but docs/testable.md states no such clause',
    ]);
  });

  it('flags a marker with an unregistered prefix — in any tracked Markdown file', () => {
    const r = audit({
      files: [...BASE_FILES, 'docs/newcomer.md'],
      contents: {
        'docs/testable.md': BASE_DOC,
        'docs/newcomer.md': '**ZZ-1.** A clause nobody registered.\n',
      },
    });
    assert.deepEqual(r.markerErrors, [
      `docs/newcomer.md states clause "ZZ-1" with unregistered prefix "ZZ"; ${prefixRule('TP', LOCK_PREFIX)}`,
    ]);
  });

  it("flags a marker sitting outside its prefix's registered doc", () => {
    const r = audit({
      files: [...BASE_FILES, 'docs/elsewhere.md'],
      contents: {
        'docs/testable.md': BASE_DOC,
        'docs/elsewhere.md': '**TP-7.** Stated in the wrong doc.\n',
      },
    });
    assert.deepEqual(r.markerErrors, [
      'docs/elsewhere.md states clause "TP-7" but prefix "TP" registers docs/testable.md',
    ]);
  });

  it('flags the same clause stated twice in one doc', () => {
    const contents = { 'docs/testable.md': BASE_DOC + '\n**TP-2.** Stated again.\n' };
    const r = audit({ contents });
    assert.deepEqual(r.markerErrors, ['docs/testable.md states clause "TP-2" more than once']);
  });
});

describe('auditClauseRegistry — row well-formedness', () => {
  it('flags a judgment-only row with no justification', () => {
    const registry = makeRegistry();
    delete registry.clauses[0].justification;
    const r = audit({ registry });
    assert.deepEqual(r.rowErrors, ['clause "TP-1" is judgment-only but states no justification']);
  });

  it('flags a checkable/check-exists row with no check-ref', () => {
    const registry = makeRegistry();
    delete registry.clauses[1]['check-ref'];
    const r = audit({ registry });
    assert.deepEqual(r.rowErrors, ['clause "TP-2" is check-exists but states no check-ref']);
  });

  it('flags a row whose own prefix no table registers, stating the same rule', () => {
    // The third site the one unregistered-prefix rule is stated at: a row, a
    // retired list, and a marker each name the closed set the table states.
    const registry = makeRegistry();
    registry.clauses.push({
      doc: 'docs/testable.md',
      clause: 'ZZ-1',
      tag: 'judgment-only',
      justification: 'a person decides',
    });
    assert.deepEqual(audit({ registry }).rowErrors, [
      `clause "ZZ-1" uses unregistered prefix "ZZ"; ${prefixRule('TP', LOCK_PREFIX)}`,
    ]);
  });

  it('flags an invalid tag, a duplicate row, and a doc/prefix mismatch', () => {
    const registry = makeRegistry();
    registry.clauses[0].tag = 'someday-maybe';
    registry.clauses.push({ ...registry.clauses[1] });
    registry.clauses.push({
      doc: 'docs/other.md',
      clause: 'TP-3',
      tag: 'judgment-only',
      justification: 'x',
    });
    const contents = { 'docs/testable.md': BASE_DOC + '\n**TP-3.** Third.\n' };
    const r = audit({ registry, contents });
    assert.equal(
      r.rowErrors.some((e) =>
        e.includes(`invalid tag "someday-maybe"; a row's tag is one of ${VALID_TAGS.join(', ')}`),
      ),
      true,
    );
    assert.equal(
      r.rowErrors.some((e) => e.includes('duplicate registry row for clause "TP-2"')),
      true,
    );
    assert.equal(
      r.rowErrors.some((e) =>
        e.includes('clause "TP-3" names doc "docs/other.md" but prefix "TP" registers'),
      ),
      true,
    );
  });
});

describe('auditClauseRegistry — citation resolvability', () => {
  it('flags a check-ref naming an untracked script', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Guarded by scripts/imaginary-check.js.';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, [
      `clause "TP-2" check-ref cites scripts/imaginary-check.js; ${PATH_RULE}`,
    ]);
  });

  it('flags a check-exists row whose check-ref names nothing runnable', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'A check somewhere in CI guards this.';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, [
      `clause "TP-2" is check-exists but its check-ref names nothing runnable; ${RUNNABLE_RULE}`,
    ]);
  });

  it('allows a checkable row to describe an intended check in prose', () => {
    const registry = makeRegistry();
    registry.clauses[1].tag = 'checkable';
    registry.clauses[1]['check-ref'] =
      'Intended: a static scan of event registrations (not yet built).';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, []);
  });

  it('flags a check-ref naming a missing npm script', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Run npm run does:not:exist to verify.';
    const r = audit({ registry });
    assert.deepEqual(r.refErrors, [
      'clause "TP-2" check-ref cites npm run does:not:exist; a cited script is one package.json defines',
    ]);
  });

  it('resolves a trailing-slash citation as a tracked-path prefix, and flags an empty one', () => {
    const green = makeRegistry();
    green.clauses[1]['check-ref'] =
      'The fixtures under scripts/ are exercised by npm run real:check.';
    assert.deepEqual(audit({ registry: green }).refErrors, []);

    const red = makeRegistry();
    red.clauses[1]['check-ref'] = 'The fixtures under fixtures/none/ back npm run real:check.';
    assert.deepEqual(audit({ registry: red }).refErrors, [
      'clause "TP-2" check-ref cites fixtures/none/; a cited directory holds at least one tracked file',
    ]);
  });

  it('holds an enumerated root-file citation to the tracked set', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] =
      'The rule lives in eslint.config.js; run npm run real:check.';
    const files = BASE_FILES.filter((f) => f !== 'eslint.config.js');
    assert.deepEqual(audit({ registry, files }).refErrors, [
      'clause "TP-2" check-ref cites eslint.config.js; a citable root file is a tracked file',
    ]);
    assert.deepEqual(audit({ registry }).refErrors, []);
  });

  it('names what runs a check: a script, a suite file, or an npm run target', () => {
    const registry = makeRegistry();
    for (const ref of [
      'Guarded by scripts/real-check.js.',
      'Pinned by packages/shared/tests/unit/thing.test.js.',
      'Pinned by packages/shared/tests/helpers/fixture.js.',
      'Run npm run real:check.',
    ]) {
      registry.clauses[1]['check-ref'] = ref;
      const files = [
        ...BASE_FILES,
        'packages/shared/tests/unit/thing.test.js',
        'packages/shared/tests/helpers/fixture.js',
      ];
      assert.deepEqual(audit({ registry, files }).refErrors, [], ref);
    }
  });

  it('a tests/ path names a runnable check through the code that runs there', () => {
    // What the alternative admits is a suite's own code; a page a suite loads
    // and a manifest beside it are read by the suite rather than run as one.
    const registry = makeRegistry();
    for (const cited of [
      'packages/extension/tests/manual/browser-chrome.html',
      'packages/desktop/tests/integration/package.json',
    ]) {
      registry.clauses[1]['check-ref'] = `Pinned by ${cited}, alone.`;
      const files = [...BASE_FILES, cited];
      assert.deepEqual(
        audit({ registry, files }).refErrors,
        [
          `clause "TP-2" is check-exists but its check-ref names nothing runnable; ${RUNNABLE_RULE}`,
        ],
        cited,
      );
    }
  });

  it('a configuration file names no runnable check, however citable it is', () => {
    // A citable root file resolves as a citation — it is a tracked file the
    // row may name — while naming nothing this repository RUNS, which is the
    // separate question check-exists asks.
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'The rule the lint runs lives in eslint.config.js, alone.';
    assert.deepEqual(audit({ registry }).refErrors, [
      `clause "TP-2" is check-exists but its check-ref names nothing runnable; ${RUNNABLE_RULE}`,
    ]);
    // The same citation on a row that only describes an intended check stands.
    registry.clauses[1].tag = 'checkable';
    assert.deepEqual(audit({ registry }).refErrors, []);
  });

  it('a row citing only package.json names no runnable check either', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'The gate is configured in package.json.';
    assert.deepEqual(audit({ registry }).refErrors, [
      `clause "TP-2" is check-exists but its check-ref names nothing runnable; ${RUNNABLE_RULE}`,
    ]);
  });

  it('reports one line per citation however often a row repeats it', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] =
      'Guarded by scripts/imaginary-check.js; scripts/imaginary-check.js runs it, ' +
      'via npm run does:not:exist and again npm run does:not:exist.';
    assert.deepEqual(audit({ registry }).refErrors, [
      `clause "TP-2" check-ref cites scripts/imaginary-check.js; ${PATH_RULE}`,
      'clause "TP-2" check-ref cites npm run does:not:exist; a cited script is one package.json defines',
    ]);
  });

  it('leaves a directory-form glob outside the gate, whole rather than in fragments', () => {
    const ref = 'The vectors under corpus/sessions/*/vectors/** back npm run real:check.';
    assert.deepEqual(extractCitedTargets(ref), {
      paths: [],
      patterns: [],
      prefixes: [],
      npmScripts: ['real:check'],
      rootFiles: [],
      bareFiles: [],
    });
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = ref;
    assert.deepEqual(audit({ registry }).refErrors, []);
  });

  it('refuses a suite or source file cited without its path, in either field', () => {
    const registry = makeRegistry();
    registry.clauses[0].justification = 'a person decides; commands.rs shows the shape';
    registry.clauses[1]['check-ref'] = 'Pinned by recorder.test.js; run npm run real:check.';
    assert.deepEqual(audit({ registry }).refErrors, [
      `clause "TP-1" justification cites commands.rs; ${BARE_FILE_RULE}`,
      `clause "TP-2" check-ref cites recorder.test.js; ${BARE_FILE_RULE}`,
    ]);
  });

  it('leaves a plural generic page name outside the refusal shapes', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] =
      'A diff on the assembled index.html files reds; run npm run real:check.';
    assert.deepEqual(audit({ registry }).refErrors, []);
  });

  it('resolves a pattern that names a tracked file, however many it names', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Guarded by scripts/*.js; run npm run real:check.';
    // scripts/real-check.js is the one tracked match here; a pattern naming
    // many files resolves the same way — breadth is review's judgment, and no
    // red exists for it.
    assert.deepEqual(audit({ registry }).refErrors, []);

    const many = makeRegistry();
    many.clauses[1]['check-ref'] =
      'Guarded by scripts/**; the modules docs/*.md; npm run real:check.';
    assert.deepEqual(audit({ registry: many }).refErrors, []);
  });

  it('flags a pattern that names no tracked file', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Guarded by scripts/gone/*.js; run npm run real:check.';
    assert.deepEqual(audit({ registry }).refErrors, [
      'clause "TP-2" check-ref cites scripts/gone/*.js; a cited pattern names at least one tracked file',
    ]);
  });

  it('flags a pattern that does not compile, as its own red rather than a throw', () => {
    for (const token of ['scripts/{real-check.js', 'scripts/re**al/check.js']) {
      const registry = makeRegistry();
      registry.clauses[1]['check-ref'] = `Guarded by ${token}; run npm run real:check.`;
      let r;
      assert.doesNotThrow(() => {
        r = audit({ registry });
      }, token);
      assert.deepEqual(
        r.refErrors,
        [
          `clause "TP-2" check-ref cites ${token}, which does not compile as a pattern; a cited pattern is written in the map's own syntax — \`*\` within a segment, \`**\` as a whole segment, \`{a,b}\` alternation`,
        ],
        token,
      );
    }
  });

  it('reads a pattern citation exactly as the map reads an ownership pattern', () => {
    const files = ['scripts/a.js', 'docs/x.md'];
    assert.equal(resolvePatternCitation('scripts/*.js', files), 'matches');
    assert.equal(resolvePatternCitation('scripts/*.md', files), 'no-match');
    assert.equal(resolvePatternCitation('scripts/{a.js', files), 'uncompilable');
    assert.equal(resolvePatternCitation('scr**ipts/a.js', files), 'uncompilable');
  });

  it('extracts a citable root file that ends a sentence, and resolves it', () => {
    // The row describes an intended check, so the sentence-final extraction is
    // the whole subject here: the citation resolves, or reds as untracked.
    const registry = makeRegistry();
    registry.clauses[1].tag = 'checkable';
    registry.clauses[1]['check-ref'] = 'The rule the lint runs lives in eslint.config.js.';
    assert.deepEqual(audit({ registry }).refErrors, []);

    const files = BASE_FILES.filter((f) => f !== 'eslint.config.js');
    assert.deepEqual(audit({ registry, files }).refErrors, [
      'clause "TP-2" check-ref cites eslint.config.js; a citable root file is a tracked file',
    ]);
  });

  it('still refuses a path-less suite name that ends a sentence', () => {
    const registry = makeRegistry();
    registry.clauses[1]['check-ref'] = 'Pinned by recorder.test.js. Run npm run real:check.';
    assert.deepEqual(audit({ registry }).refErrors, [
      `clause "TP-2" check-ref cites recorder.test.js; ${BARE_FILE_RULE}`,
    ]);
  });

  it('applies the same grammar to a judgment-only justification', () => {
    const registry = makeRegistry();
    registry.clauses[0].justification =
      'a person decides; scripts/gone.js and npm run nope are only orientation';
    assert.deepEqual(audit({ registry }).refErrors, [
      `clause "TP-1" justification cites scripts/gone.js; ${PATH_RULE}`,
      'clause "TP-1" justification cites npm run nope; a cited script is one package.json defines',
    ]);
  });
});

describe('auditClauseRegistry — requirement keywords in registry text', () => {
  it('flags an uppercase keyword in a check-ref and in a justification alike', () => {
    const registry = makeRegistry();
    registry.clauses[0].justification = 'the value MUST NOT be recorded, so a person decides';
    registry.clauses[1]['check-ref'] =
      'scripts/real-check.js asserts the field SHOULD be present; run npm run real:check.';
    const r = audit({ registry });
    assert.deepEqual(r.textErrors, [
      'clause "TP-1" justification states MUST NOT; a row records how the clause is verified, and the clause states the requirement — quote a keyword in a code span to cite it',
      'clause "TP-2" check-ref states SHOULD; a row records how the clause is verified, and the clause states the requirement — quote a keyword in a code span to cite it',
    ]);
  });

  it('flags the added spellings in a justification and in a check-ref alike', () => {
    const registry = makeRegistry();
    registry.clauses[0].justification = 'the field is REQUIRED, so a person decides';
    registry.clauses[1]['check-ref'] =
      'scripts/real-check.js asserts the retry is NOT RECOMMENDED; run npm run real:check.';
    assert.deepEqual(audit({ registry }).textErrors, [
      'clause "TP-1" justification states REQUIRED; a row records how the clause is verified, and the clause states the requirement — quote a keyword in a code span to cite it',
      'clause "TP-2" check-ref states NOT RECOMMENDED; a row records how the clause is verified, and the clause states the requirement — quote a keyword in a code span to cite it',
    ]);
  });

  it('lets a row quote a keyword as code to cite it', () => {
    const registry = makeRegistry();
    registry.clauses[0].justification = 'whether the `MUST` holds is a per-change judgment';
    assert.deepEqual(audit({ registry }).textErrors, []);
  });
});

describe('auditClauseRegistry — retirement', () => {
  it('flags a retired id that still has an active row or marker', () => {
    const registry = makeRegistry({ retired: { TP: ['TP-2'] } });
    const r = audit({ registry });
    assert.equal(
      r.retiredErrors.includes('retired clause "TP-2" has an active registry row'),
      true,
    );
    assert.equal(r.retiredErrors.includes('docs/testable.md states retired clause "TP-2"'), true);
  });

  it('flags retired ids under the wrong or an unregistered prefix', () => {
    const registry = makeRegistry({ retired: { TP: ['XX-1'], QQ: ['QQ-1'] } });
    const r = audit({ registry });
    assert.equal(
      r.retiredErrors.includes('retired id "XX-1" does not belong to prefix "TP"'),
      true,
    );
    assert.equal(
      r.retiredErrors.includes(
        `retired list for unregistered prefix "QQ"; ${prefixRule('TP', LOCK_PREFIX)}`,
      ),
      true,
    );
  });

  it('states the rule over the prefixes the table itself states well', () => {
    // A prefix this same run refuses for shape is not one to send a reader
    // after, so the rule names the entries that passed the table's checks.
    const registry = makeRegistry({
      prefixes: { TP: 'docs/testable.md', bad: 'docs/testable.md', [LOCK_PREFIX]: LOCK_DOC },
      retired: { QQ: ['QQ-1'] },
    });
    const r = audit({ registry });
    assert.equal(r.shapeErrors.includes('prefix "bad" is not an uppercase identifier'), true);
    assert.deepEqual(r.retiredErrors, [
      `retired list for unregistered prefix "QQ"; ${prefixRule('TP', LOCK_PREFIX)}`,
    ]);
  });

  it('says the table registers none rather than trailing off after the colon', () => {
    const registry = makeRegistry({ prefixes: {}, retired: { QQ: ['QQ-1'] }, clauses: [] });
    assert.deepEqual(audit({ registry }).retiredErrors, [
      `retired list for unregistered prefix "QQ"; a registered prefix is one ${REGISTRY_PATH} states in its prefix table, which registers none this run — restore that table before a clause identifier can name a registered prefix`,
    ]);
  });
});

describe('auditClauseRegistry — shape', () => {
  it('flags a prefix registering an untracked doc', () => {
    const registry = makeRegistry({ prefixes: { TP: 'docs/never-committed.md' } });
    const r = audit({ registry });
    assert.equal(
      r.shapeErrors.includes('prefix "TP" registers untracked doc "docs/never-committed.md"'),
      true,
    );
  });

  it('flags missing top-level structure without throwing', () => {
    const r = audit({ registry: { description: 'x' } });
    assert.notEqual(r.shapeErrors.length, 0);
    assert.deepEqual(r.markerErrors, []);
  });
});

describe('auditClauseRegistry: cited paths across the tree', () => {
  /**
   * Audit a one-clause registry beside the lock surfaces, so the lock legs —
   * which run on every audit — stay green and only the case under test reds.
   */
  function auditOne(clause, extraFiles = []) {
    const contents = { ...BASE_CONTENTS, 'docs/t.md': '**T-1.** rule' };
    return auditClauseRegistry({
      registry: {
        description: 'd',
        prefixes: { T: 'docs/t.md', [LOCK_PREFIX]: LOCK_DOC },
        retired: { T: [] },
        clauses: [clause, lockRow()],
      },
      files: [
        ...CITABLE_ROOT_FILES,
        VECTOR_FIXTURES_PATH,
        'docs/t.md',
        LOCK_DOC,
        LOCK_SUITE_PATH,
        ...extraFiles,
      ],
      readFile: (f) => contents[f] ?? null,
      packageScripts: [],
    });
  }

  it('extracts a cited path wherever it sits — check trees, docs, and workflows alike', () => {
    const { paths } = extractCitedTargets(
      'pinned by packages/shared/tests/unit/foo.test.js and corpus/vectors-coverage.json; ' +
        'the server side by reference-implementations/sync-server/tests/integration/bar.test.js, ' +
        'the gate by .github/workflows/test.yml, and the prose by docs/guides/ci.md',
    );
    assert.deepEqual(paths, [
      'packages/shared/tests/unit/foo.test.js',
      'corpus/vectors-coverage.json',
      'reference-implementations/sync-server/tests/integration/bar.test.js',
      '.github/workflows/test.yml',
      'docs/guides/ci.md',
    ]);
  });

  it('an untracked path reddens a checkable row too', () => {
    const r = auditOne({
      doc: 'docs/t.md',
      clause: 'T-1',
      tag: 'checkable',
      'check-ref': 'Interim probe: packages/shared/tests/unit/gone.test.js.',
    });
    assert.equal(r.refErrors.length, 1);
    assert.ok(r.refErrors[0].includes(PATH_RULE));
  });

  it('leaves a separator-less prose name outside the grammar unless a shape claims it', () => {
    const { paths, rootFiles, bareFiles } = extractCitedTargets(
      'see vector-measurement.js and chrome.storage',
    );
    assert.deepEqual([paths, rootFiles, bareFiles], [[], [], []]);
  });

  it('a tracked file path satisfies check-exists on its own', () => {
    const r = auditOne(
      {
        doc: 'docs/t.md',
        clause: 'T-1',
        tag: 'check-exists',
        'check-ref': 'pinned by packages/shared/tests/unit/foo.test.js.',
      },
      ['packages/shared/tests/unit/foo.test.js'],
    );
    assert.deepEqual(r.refErrors, []);
  });

  it('an untracked named check file reddens', () => {
    const r = auditOne({
      doc: 'docs/t.md',
      clause: 'T-1',
      tag: 'check-exists',
      'check-ref': 'pinned by packages/shared/tests/unit/gone.test.js.',
    });
    assert.equal(r.refErrors.length, 1);
    assert.ok(
      r.refErrors[0].includes(`cites packages/shared/tests/unit/gone.test.js; ${PATH_RULE}`),
    );
  });
});

describe('auditClauseRegistry — structured test-case cites, and the closed row grammar', () => {
  const SUITE = 'packages/shared/tests/unit/cases.test.js';
  const SOURCE = 'packages/desktop/src-tauri/src/capture/thing.rs';
  const SUITE_TEXT = "it('the_case_that_pins_it', () => {});\n";
  const SOURCE_TEXT = '#[test]\nfn the_in_crate_case() {}\n';

  /**
   * Audit a one-clause registry beside the lock surfaces, with the cited
   * suite and source readable, so only the field under test can red. A case
   * that means to change what an anchor file states — or to make one
   * unreadable, by giving it `null` — overrides its content here.
   */
  function auditRow(clause, overrides = {}) {
    const contents = {
      ...BASE_CONTENTS,
      'docs/t.md': '**T-1.** rule',
      [SUITE]: SUITE_TEXT,
      [SOURCE]: SOURCE_TEXT,
      ...overrides,
    };
    return auditClauseRegistry({
      registry: {
        description: 'd',
        prefixes: { T: 'docs/t.md', [LOCK_PREFIX]: LOCK_DOC },
        retired: { T: [] },
        clauses: [clause, lockRow()],
      },
      files: [
        ...CITABLE_ROOT_FILES,
        VECTOR_FIXTURES_PATH,
        'docs/t.md',
        LOCK_DOC,
        LOCK_SUITE_PATH,
        SUITE,
        SOURCE,
      ],
      readFile: (f) => contents[f] ?? null,
      packageScripts: ['test:shared'],
    });
  }

  const row = (overrides) => ({
    doc: 'docs/t.md',
    clause: 'T-1',
    tag: 'check-exists',
    'check-ref': `Pinned by ${SUITE} (npm run test:shared).`,
    ...overrides,
  });

  it('resolves a named case against a file the row cites', () => {
    const r = auditRow(row({ [TEST_CASES_FIELD]: ['the_case_that_pins_it'] }));
    assert.deepEqual(flatten(r), []);
  });

  it('resolves a case a cited Rust source declares as a bare fn', () => {
    const r = auditRow(
      row({
        'check-ref': `Pinned in ${SOURCE} (npm run test:shared).`,
        [TEST_CASES_FIELD]: ['the_in_crate_case'],
      }),
    );
    assert.deepEqual(flatten(r), []);
  });

  it('flags an identifier no cited file declares as a test case, naming the files searched', () => {
    const r = auditRow(row({ [TEST_CASES_FIELD]: ['the_case_that_pins_it', 'a_case_long_gone'] }));
    assert.deepEqual(r.refErrors, [
      `clause "T-1" ${TEST_CASES_FIELD} names a_case_long_gone, which none of the files its check-ref cites declares as a test case: ${SUITE}`,
    ]);
  });

  it('resolves a DECLARATOR, never a mention: each false-green class reds', () => {
    // Each of these carries the cited identifier somewhere in the file while
    // declaring no such case: what a whole-file search cannot tell apart from
    // a declaration, and what a scan taking any `it`/`test` word for one
    // cannot.
    for (const [what, text] of [
      ['a comment-only mention', "// the_case_that_pins_it lived here once\nit('another', () => {});\n"], // prettier-ignore
      ['a superstring rename', "it('the_case_that_pins_it_but_renamed_entirely', () => {});\n"],
      ['an assertion-message mention', "it('another', () => {\n  assert.ok(x, 'the_case_that_pins_it');\n});\n"], // prettier-ignore
      ['a non-declarator string literal', "const title = 'the_case_that_pins_it';\nit('another', () => {});\n"], // prettier-ignore
      ['a skipped title', "it.skip('the_case_that_pins_it', () => {});\n"],
      ['a focused title', "it.only('the_case_that_pins_it', () => {});\n"],
      ["another object's own it", "suite.it('the_case_that_pins_it', () => {});\n"],
      ['a member call that is no declarator at all', "RE.test('the_case_that_pins_it');\nit('another', () => {});\n"], // prettier-ignore
    ]) {
      const r = auditRow(row({ [TEST_CASES_FIELD]: ['the_case_that_pins_it'] }), { [SUITE]: text });
      assert.deepEqual(
        r.refErrors,
        [
          `clause "T-1" ${TEST_CASES_FIELD} names the_case_that_pins_it, which none of the files its check-ref cites declares as a test case: ${SUITE}`,
        ],
        what,
      );
    }
  });

  it('reads a Rust declaration, never a comment, a message, or a longer name', () => {
    const cited = row({
      'check-ref': `Pinned in ${SOURCE} (npm run test:shared).`,
      [TEST_CASES_FIELD]: ['the_in_crate_case'],
    });
    for (const [what, text] of [
      ['a comment-only mention', '// fn the_in_crate_case() {}\n#[test]\nfn another_case() {}\n'],
      ['a message quoting the declaration', '#[test]\nfn another_case() { panic!("fn the_in_crate_case("); }\n'], // prettier-ignore
      ['a superstring rename', '#[test]\nfn the_in_crate_case_but_renamed_entirely() {}\n'],
    ]) {
      const r = auditRow(cited, { [SOURCE]: text });
      assert.deepEqual(
        r.refErrors,
        [
          `clause "T-1" ${TEST_CASES_FIELD} names the_in_crate_case, which none of the files its check-ref cites declares as a test case: ${SOURCE}`,
        ],
        what,
      );
    }
  });

  it('resolves a Rust case whose parameter list carries its inputs', () => {
    // A property-based case declares its inputs in the parameter list, so the
    // declaration is `fn <name>(` and not `fn <name>()`.
    const r = auditRow(
      row({
        'check-ref': `Pinned in ${SOURCE} (npm run test:shared).`,
        [TEST_CASES_FIELD]: ['the_in_crate_case'],
      }),
      {
        [SOURCE]: 'proptest! {\n  #[test]\n  fn the_in_crate_case(events in any_events()) {}\n}\n',
      },
    );
    assert.deepEqual(flatten(r), []);
  });

  it('resolves a title carrying regex metacharacters, by token equality', () => {
    const title = 'does NOT capture exactly 200px (threshold is >200, not >=200)';
    const r = auditRow(row({ [TEST_CASES_FIELD]: [title] }), {
      [SUITE]: `it(${JSON.stringify(title)}, () => {});\n`,
    });
    assert.deepEqual(flatten(r), []);
  });

  it('reds cleanly on a metacharacter-bearing identifier cited against a Rust anchor', () => {
    // A Rust function name carries no metacharacter, so one cited here names
    // no declaration. Unescaped, the first would MATCH the declaration below
    // and the second would not compile at all; escaped, both are plain reds.
    for (const name of ['the_.*_case', 'the_(case']) {
      const cited = row({
        'check-ref': `Pinned in ${SOURCE} (npm run test:shared).`,
        [TEST_CASES_FIELD]: [name],
      });
      let r;
      assert.doesNotThrow(() => {
        r = auditRow(cited, { [SOURCE]: '#[test]\nfn the_in_crate_case() {}\n' });
      }, name);
      assert.deepEqual(
        r.refErrors,
        [
          `clause "T-1" ${TEST_CASES_FIELD} names ${name}, which none of the files its check-ref cites declares as a test case: ${SOURCE}`,
        ],
        name,
      );
    }
  });

  it('flags the field where the row cites no file to resolve it in', () => {
    const r = auditRow(
      row({
        'check-ref': 'Pinned by the shared suite (npm run test:shared).',
        [TEST_CASES_FIELD]: ['the_case_that_pins_it'],
      }),
    );
    assert.deepEqual(r.rowErrors, [
      `clause "T-1" states ${TEST_CASES_FIELD} but its check-ref cites no anchor-bearing file; a named case is a test the row's own cited .js, .mjs, or .rs file declares`,
    ]);
    assert.deepEqual(r.refErrors, []);
  });

  it('flags the field on a judgment-only row, which states no check-ref', () => {
    const r = auditRow({
      doc: 'docs/t.md',
      clause: 'T-1',
      tag: 'judgment-only',
      justification: 'a person decides',
      [TEST_CASES_FIELD]: ['the_case_that_pins_it'],
    });
    assert.deepEqual(r.rowErrors, [
      `clause "T-1" is judgment-only and states ${TEST_CASES_FIELD}; the field names cases a check-ref's anchor-bearing files declare, so it belongs on a row that states a check-ref`,
    ]);
  });

  it('flags a field that is not a non-empty list of identifiers', () => {
    for (const value of [[], 'the_case_that_pins_it', [''], ['ok', 7]]) {
      const r = auditRow(row({ [TEST_CASES_FIELD]: value }));
      assert.deepEqual(
        r.rowErrors,
        [
          `clause "T-1" states ${TEST_CASES_FIELD} as ${JSON.stringify(value)}; the field is a non-empty array of test-case identifiers`,
        ],
        JSON.stringify(value),
      );
    }
  });

  it('admits the field on a checkable row, which states a check-ref too', () => {
    const r = auditRow(row({ tag: 'checkable', [TEST_CASES_FIELD]: ['the_case_that_pins_it'] }));
    assert.deepEqual(flatten(r), []);
  });

  it('leaves a row that states no such field exactly as it was', () => {
    const r = auditRow(row({}));
    assert.deepEqual(flatten(r), []);
  });

  it('names a near-miss spelling of the field rather than reading nothing', () => {
    for (const key of ['test-case', 'testCases', 'test_cases']) {
      const r = auditRow(row({ [key]: ['the_case_that_pins_it'] }));
      assert.deepEqual(
        r.rowErrors,
        [`clause "T-1" states unknown key "${key}"; a row states ${ROW_KEYS.join(', ')}`],
        key,
      );
      assert.deepEqual(r.refErrors, [], key);
    }
  });

  it('names every unknown key a row states', () => {
    const r = auditRow(row({ notes: 'x', owner: 'y' }));
    assert.deepEqual(r.rowErrors, [
      `clause "T-1" states unknown key "notes"; a row states ${ROW_KEYS.join(', ')}`,
      `clause "T-1" states unknown key "owner"; a row states ${ROW_KEYS.join(', ')}`,
    ]);
  });

  it('states the same refusal where the row cites only anchor-less files', () => {
    const r = auditRow(
      row({
        'check-ref': 'Stated in docs/t.md (npm run test:shared).',
        [TEST_CASES_FIELD]: ['the_case_that_pins_it'],
      }),
    );
    assert.deepEqual(r.rowErrors, [
      `clause "T-1" states ${TEST_CASES_FIELD} but its check-ref cites no anchor-bearing file; a named case is a test the row's own cited .js, .mjs, or .rs file declares`,
    ]);
    assert.deepEqual(r.refErrors, []);
  });

  it('names an anchor file that will not read, and searches nothing in its place', () => {
    // With no readable anchor there is no search space: naming the file once
    // is the whole diagnosis, and a per-identifier cascade would only repeat it.
    const r = auditRow(row({ [TEST_CASES_FIELD]: ['the_case_that_pins_it'] }), { [SUITE]: null });
    assert.deepEqual(r.readErrors, [
      `EMPTY SURFACE: no text read from ${SUITE} — clause "T-1" resolves its ${TEST_CASES_FIELD} in the anchor-bearing files its check-ref cites, so restore that file before a case can be held there`,
    ]);
    assert.deepEqual(r.refErrors, []);
  });

  it('keeps searching the anchors that DID read, and says the space was reduced', () => {
    // Suppressing here would silently stop holding the readable anchors'
    // identifiers, so the miss stays — labelled with what it could not search.
    const cited = row({
      'check-ref': `Pinned by ${SUITE} and in ${SOURCE} (npm run test:shared).`,
      [TEST_CASES_FIELD]: ['the_case_that_pins_it', 'a_case_long_gone'],
    });
    const r = auditRow(cited, { [SOURCE]: null });
    assert.deepEqual(r.readErrors, [
      `EMPTY SURFACE: no text read from ${SOURCE} — clause "T-1" resolves its ${TEST_CASES_FIELD} in the anchor-bearing files its check-ref cites, so restore that file before a case can be held there`,
    ]);
    assert.deepEqual(r.refErrors, [
      `clause "T-1" ${TEST_CASES_FIELD} names a_case_long_gone, which none of the files its check-ref cites declares as a test case: ${SUITE} — a reduced search space, computed without ${SOURCE}, which did not read`,
    ]);
  });

  it('names a template title rather than reading it as its literal run', () => {
    const r = auditRow(row({ [TEST_CASES_FIELD]: ['the_case_that_pins_it'] }), {
      [SUITE]: 'it(`the_case_that_pins_it ${suffix}`, () => {});\n',
    });
    assert.deepEqual(r.readErrors, [
      `no case title read from a template literal in ${SUITE} (\`the_case_that_pins_it \`) — clause "T-1" resolves its ${TEST_CASES_FIELD} against the titles that file declares, and a computed title is refused rather than read as its literal run`,
    ]);
    assert.deepEqual(r.refErrors, [
      `clause "T-1" ${TEST_CASES_FIELD} names the_case_that_pins_it, which none of the files its check-ref cites declares as a test case: ${SUITE}`,
    ]);
  });

  it('leaves a resolved row green whatever titles its anchor files compute', () => {
    // The refusal is the reason a citation could not resolve there; with every
    // named case resolved there is no such reason to give, and the titles a
    // suite computes for its own purposes are its own business.
    const r = auditRow(row({ [TEST_CASES_FIELD]: ['the_case_that_pins_it'] }), {
      [SUITE]: "it('the_case_that_pins_it', () => {});\nit(`another ${suffix}`, () => {});\n",
    });
    assert.deepEqual(flatten(r), []);
  });

  it('names a template title that opens with an interpolation by where it sits', () => {
    // Its leading literal run is empty, so the file it sits in is what
    // identifies it — an empty backticked name would name nothing at all.
    const r = auditRow(row({ [TEST_CASES_FIELD]: ['the_case_that_pins_it'] }), {
      [SUITE]: 'it(`${prefix} the case`, () => {});\n',
    });
    assert.deepEqual(r.readErrors, [
      `no case title read from a template literal in ${SUITE} opening with an interpolation — clause "T-1" resolves its ${TEST_CASES_FIELD} against the titles that file declares, and a computed title is refused rather than read as its literal run`,
    ]);
    assert.deepEqual(r.refErrors, [
      `clause "T-1" ${TEST_CASES_FIELD} names the_case_that_pins_it, which none of the files its check-ref cites declares as a test case: ${SUITE}`,
    ]);
  });

  it('leaves an untracked cited anchor to the one red that names it', () => {
    // A file the tree does not carry is not a file that failed to read: the
    // cited-path red is the whole diagnosis, and a read failure beside it
    // would give one fact two subjects.
    const missing = 'packages/shared/tests/unit/gone.test.js';
    const r = auditRow(
      row({
        'check-ref': `Pinned by ${missing} (npm run test:shared).`,
        [TEST_CASES_FIELD]: ['the_case_that_pins_it'],
      }),
    );
    assert.deepEqual(r.refErrors, [`clause "T-1" check-ref cites ${missing}; ${PATH_RULE}`]);
    assert.deepEqual([r.readErrors, r.rowErrors], [[], []]);

    // It still narrowed the search, so where a tracked anchor remains to
    // search, the miss says what the search was computed without.
    const mixed = auditRow(
      row({
        'check-ref': `Pinned by ${SUITE} and ${missing} (npm run test:shared).`,
        [TEST_CASES_FIELD]: ['a_case_long_gone'],
      }),
    );
    assert.deepEqual(mixed.refErrors, [
      `clause "T-1" check-ref cites ${missing}; ${PATH_RULE}`,
      `clause "T-1" ${TEST_CASES_FIELD} names a_case_long_gone, which none of the files its check-ref cites declares as a test case: ${SUITE} — a reduced search space, computed without ${missing}, which the tracked set does not carry`,
    ]);
    assert.deepEqual(mixed.readErrors, []);
  });

  it('admits every key the grammar carries', () => {
    const r = auditRow({
      doc: 'docs/t.md',
      clause: 'T-1',
      tag: 'check-exists',
      justification: 'stated alongside the check-ref',
      'check-ref': `Pinned by ${SUITE} (npm run test:shared).`,
      [TEST_CASES_FIELD]: ['the_case_that_pins_it'],
    });
    assert.deepEqual(flatten(r), []);
  });
});

describe("auditClauseRegistry — the check's own register", () => {
  it('flags an enumerated citable root file that is not tracked, uncited', () => {
    const files = BASE_FILES.filter((f) => f !== 'CLA.md');
    const r = audit({ files });
    assert.deepEqual(r.listErrors, [
      'CITABLE_ROOT_FILES enumerates CLA.md, which is not a tracked file; an enumerated root file names one tracked source',
    ]);
    assert.deepEqual(r.refErrors, []);
  });

  it('flags a fixture path the register names but the tree no longer tracks', () => {
    // A RENAMED fixture is the check's own stale pointer. It must red here,
    // under the check's subject — not as the fixtures' restore-that-shape
    // surface error, which would blame a file that is perfectly present.
    const r = audit({ files: BASE_FILES.filter((f) => f !== VECTOR_FIXTURES_PATH) });
    assert.deepEqual(r.listErrors, [
      `VECTOR_FIXTURES_PATH names ${VECTOR_FIXTURES_PATH}, which is not a tracked file; the fixture surface this check reads names one tracked source`,
    ]);
  });

  it('flags a reason-bearing map list the entry-list constant does not name', () => {
    // The other direction of the same register: a new class of entry that
    // explains itself in a `reason` no leg reads.
    const map = JSON.parse(mapWithReason(null));
    map['declared-suites'] = [{ path: 'scripts/new.js', reason: 'a new class of entry, per TP-1' }];
    const r = audit({ contents: { [MAP_PATH]: JSON.stringify(map) } });
    assert.deepEqual(r.listErrors, [
      `${MAP_PATH} states a reason-bearing "declared-suites" list that AREA_MAP_ENTRY_LISTS does not name; every entry list whose reasons can cite a clause is read here`,
    ]);
    assert.deepEqual(r.mapErrors, [], 'the map itself cites nothing unresolvable');
  });

  it('leaves a map list that carries no reason alone — nothing there can cite a clause', () => {
    // The admission is the reason-bearing SHAPE, not the presence of a list:
    // a top-level array of plain data explains nothing and reds nothing.
    const map = JSON.parse(mapWithReason(null));
    map['tracked-fixtures'] = [{ path: 'corpus/x.json' }, 'corpus/y.json'];
    assert.deepEqual(audit({ contents: { [MAP_PATH]: JSON.stringify(map) } }).listErrors, []);
  });

  it('reports nothing when every register entry names the tree it points at', () => {
    assert.deepEqual(audit().listErrors, []);
  });

  it("reports the register's reds under the check's own subject", () => {
    const r = audit({ files: BASE_FILES.filter((f) => f !== VECTOR_FIXTURES_PATH) });
    const withErrors = reportSections(r).filter((s) => s.errors.length);
    assert.deepEqual(
      withErrors.map((s) => s.subject),
      ['scripts/check-clause-registry.js'],
    );
  });
});

describe('auditClauseRegistry — a registered doc that will not read', () => {
  it('names the doc, under the tree’s own subject', () => {
    // Its markers are what the bijection stands on, so a doc that does not
    // read leaves that leg with nothing to assert — said out loud here.
    const r = audit({ contents: { 'docs/testable.md': null } });
    assert.deepEqual(r.readErrors, [
      `EMPTY SURFACE: no text read from docs/testable.md — the check reads each registered doc's clause markers, so restore that file before its markers and the registry's rows can be held to each other`,
    ]);
    const withErrors = reportSections(r).filter((s) => s.errors.length);
    assert.deepEqual(
      withErrors.map((s) => s.subject),
      ['the tree this check resolves against'],
    );
    // And the bijection stands down for that doc: a line per row claiming the
    // document dropped a clause would be about text nobody has read.
    assert.deepEqual(r.markerErrors, []);
  });

  it('passes over an UNREGISTERED tracked .md that will not read, as it always has', () => {
    // Every fixture here carries the citable root files as tracked-but-
    // contentless, which is the ordinary case: what a document outside the
    // prefix table might state is unheld whether or not it reads.
    assert.deepEqual(audit().readErrors, []);
    const r = audit({ files: [...BASE_FILES, 'docs/nobody-registers-this.md'] });
    assert.deepEqual(r.readErrors, []);
  });
});

describe('readTextOrNull — the discriminated tree read', () => {
  it("answers null for a file that is not there and '' for one that is there and empty", () => {
    // The reader's own contract, held beside the loader's: the answers a read
    // can give are what every consumer's diagnosis rests on, and a reader
    // collapsing the unreadable read into the empty one makes an unreadable
    // surface indistinguishable from an empty one for every guard downstream.
    const dir = mkdtempSync(join(tmpdir(), 'docent-reader-'));
    try {
      const empty = join(dir, 'empty.md');
      const filled = join(dir, 'filled.md');
      writeFileSync(empty, '');
      writeFileSync(filled, 'text\n');
      assert.equal(readTextOrNull(join(dir, 'absent.md')), null, 'absent reads as null');
      assert.equal(readTextOrNull(empty), '', 'present and empty reads as the empty string');
      assert.equal(readTextOrNull(filled), 'text\n');
      // The three are distinct at the boundary, which is the whole point.
      assert.notEqual(readTextOrNull(empty), readTextOrNull(join(dir, 'absent.md')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadRegistry — the read that turns the committed file into the rows', () => {
  it('reads the one committed path and parses what it finds there', () => {
    const asked = [];
    const registry = { prefixes: {}, clauses: [] };
    const loaded = loadRegistry((p) => {
      asked.push(p);
      return JSON.stringify(registry);
    });
    assert.deepEqual(asked, [REGISTRY_PATH]);
    assert.deepEqual(loaded, registry);
  });

  it('refuses a file that does not read as JSON, naming the file and the parser reason', () => {
    assert.throws(
      () => loadRegistry(() => '{ "clauses": '),
      (err) => {
        assert.equal(err instanceof ClauseRegistryInputError, true);
        assert.equal(err.name, REGISTRY_INPUT_ERROR_NAME);
        assert.equal(err.message.includes(REGISTRY_PATH), true);
        assert.match(err.message, /does not read as JSON/);
        // What the file is read for, so the refusal states what cannot be held
        // until it is restored rather than leaving a parser message to speak.
        assert.match(err.message, /before any clause can be held/);
        return true;
      },
    );
  });

  it('refuses a file it cannot read at all with the same class, saying which of the two it was', () => {
    // The read sits inside the guarded region with the parse, so a registry
    // that is not there to read reaches a consumer as the same named refusal a
    // registry that will not parse does, each saying which of the two it was.
    assert.throws(
      () =>
        loadRegistry(() => {
          throw new Error(`ENOENT: no such file or directory, open '${REGISTRY_PATH}'`);
        }),
      (err) => {
        assert.equal(err instanceof ClauseRegistryInputError, true);
        assert.equal(err.name, REGISTRY_INPUT_ERROR_NAME);
        assert.equal(err.message.includes(REGISTRY_PATH), true);
        assert.match(err.message, /could not be read/);
        assert.match(err.message, /ENOENT/);
        assert.doesNotMatch(err.message, /does not read as JSON/);
        assert.match(err.message, /before any clause can be held/);
        return true;
      },
    );
  });

  it('prints that refusal and ends red through the one posture, without a stack', () => {
    const printed = [];
    const exited = [];
    try {
      loadRegistry(() => 'not json at all');
    } catch (err) {
      refuseOnRegistryError(err, {
        error: (m) => printed.push(m),
        exit: (c) => exited.push(c),
      });
    }
    assert.equal(printed.length, 1);
    assert.match(printed[0], /does not read as JSON/);
    assert.doesNotMatch(printed[0], /^\s+at /m);
    assert.deepEqual(exited, [1]);
  });

  it('rethrows anything else untouched, printing nothing and ending nothing', () => {
    const printed = [];
    const exited = [];
    const other = new Error('a bug inside a leg');
    assert.throws(
      () =>
        refuseOnRegistryError(other, {
          error: (m) => printed.push(m),
          exit: (c) => exited.push(c),
        }),
      (e) => e === other,
    );
    assert.deepEqual(printed, []);
    assert.deepEqual(exited, []);
  });
});

describe('fixBlock — the printed advice, built from the rules that produced the red', () => {
  it('renders each closed list the audit reads, whole and in one piece', () => {
    // Derived, not hand-kept: a member added to one of these constants reaches
    // the printed text without anyone copying it there. What is asserted is the
    // JOINED rendering, contiguous — so an interpolation replaced by hand-
    // written text reds even where every member is echoed elsewhere in the
    // block.
    const block = fixBlock();
    const lists = {
      VALID_TAGS,
      CITABLE_ROOT_FILES,
      BARE_FILE_SUFFIXES,
      ROW_KEYS,
      AREA_MAP_ENTRY_LISTS,
    };
    for (const [name, members] of Object.entries(lists)) {
      const rendered = members.join(', ');
      assert.ok(
        block.includes(rendered),
        `${name} renders as "${rendered}", which the fix block does not state in one piece`,
      );
    }
  });

  it('every problem class the audit reports reaches the report', () => {
    // Driven from the audit's own result shape, so a bucket added later cannot
    // be dropped by a section list that enumerates a hand-kept set instead.
    const shape = auditClauseRegistry({
      registry: null,
      files: [],
      readFile: () => null,
      packageScripts: [],
    });
    const populated = Object.fromEntries(Object.keys(shape).map((k) => [k, [`a ${k} problem`]]));
    const sections = reportSections(populated);
    assert.equal(sections.length, Object.keys(shape).length);
    for (const key of Object.keys(shape)) {
      assert.ok(
        sections.some((s) => s.subject && s.what && s.errors.includes(`a ${key} problem`)),
        `the ${key} class reaches the report under a subject`,
      );
    }
  });
});

describe('auditClauseRegistry — hygiene-lock surfaces', () => {
  /** The lock doc, plus a sibling clause the citing rows belong to. */
  const lockDocWith = (entries) => `${lockList(entries)}\n**SL-1.** A clause that cites one.\n`;

  /**
   * Audit a registry whose one sibling row states `checkRef` (or, with
   * `justification`, cites from the other field), against a doc listing
   * `entries` and a suite titling `titles`.
   */
  function lockAudit({
    checkRef,
    justification,
    entries = [1, 2, 3],
    titles = [1, 2, 3],
    docText,
    suiteText,
    omitSuite,
    omitOrdinalPrefix,
  }) {
    const sibling = justification
      ? { doc: LOCK_DOC, clause: 'SL-1', tag: 'judgment-only', justification }
      : { doc: LOCK_DOC, clause: 'SL-1', tag: 'check-exists', 'check-ref': checkRef };
    const registry = {
      description: 'lock registry',
      prefixes: omitOrdinalPrefix ? { SL: LOCK_DOC } : { [LOCK_PREFIX]: LOCK_DOC, SL: LOCK_DOC },
      retired: omitOrdinalPrefix ? { SL: [] } : { [LOCK_PREFIX]: [], SL: [] },
      clauses: omitOrdinalPrefix ? [sibling] : [lockRow(), sibling],
    };
    const contents = { ...BASE_CONTENTS, [LOCK_DOC]: docText ?? lockDocWith(entries) };
    // The fixture description cites a lock too, so a case that renumbers the
    // surfaces states what the fixture cites rather than inheriting a red.
    contents[VECTOR_FIXTURES_PATH] = fixtureCiting(null);
    if (omitSuite) delete contents[LOCK_SUITE_PATH];
    else contents[LOCK_SUITE_PATH] = suiteText ?? lockSuite(titles);
    return auditClauseRegistry({
      registry,
      files: [...CITABLE_ROOT_FILES, VECTOR_FIXTURES_PATH, LOCK_DOC, LOCK_SUITE_PATH],
      readFile: (f) => contents[f] ?? null,
      packageScripts: ['test:shared'],
    });
  }

  const CITE = `Lock 2 (${LOCK_SUITE_PATH}); run via npm run test:shared.`;
  const stated = (active, titles) =>
    `${LOCK_DOC} §${LOCK_ORDINAL_CLAUSE} numbers ${active} active and ${LOCK_SUITE_PATH} titles ${titles}`;

  it('passes an ordinal both surfaces state', () => {
    assert.deepEqual(lockAudit({ checkRef: CITE }).refErrors, []);
  });

  it('flags an ordinal outside what the surfaces state', () => {
    const r = lockAudit({ checkRef: `Lock 9 (${LOCK_SUITE_PATH}); run via npm run test:shared.` });
    assert.deepEqual(r.refErrors, [
      `clause "SL-1" check-ref cites lock 9; a cited ordinal is one both surfaces state — ${stated('1, 2, 3', '1, 2, 3')}`,
    ]);
  });

  it('flags an ordinal cited from a justification, on the same grammar', () => {
    const out = lockAudit({ justification: 'a person decides; lock 7 only probes it' });
    assert.equal(out.refErrors.length, 1);
    assert.ok(out.refErrors[0].startsWith('clause "SL-1" justification cites lock 7;'));
  });

  it('a retired entry reserves its number: outside the active set, and no title owed', () => {
    const r = lockAudit({ entries: [1, { n: 2 }, 3], titles: [1, 3] });
    assert.deepEqual([r.refErrors, r.surfaceErrors], [[], []]);
  });

  it("flags a citation naming a lock the list retires — the registry's own red", () => {
    const r = lockAudit({ entries: [1, { n: 2 }, 3], titles: [1, 3], checkRef: CITE });
    assert.deepEqual(r.refErrors, [
      `clause "SL-1" check-ref cites lock 2, which ${LOCK_DOC} §${LOCK_ORDINAL_CLAUSE} retires; a citation names an active lock`,
    ]);
    assert.deepEqual(r.surfaceErrors, []);
  });

  it("flags a retired entry whose suite title is still there — the surfaces' red", () => {
    const r = lockAudit({ entries: [1, { n: 2 }, 3], titles: [1, 2, 3] });
    assert.deepEqual(r.surfaceErrors, [
      `${LOCK_DOC} §${LOCK_ORDINAL_CLAUSE} retires lock 2 while ${LOCK_SUITE_PATH} still titles it; a retired lock keeps its numbered entry and loses its title`,
    ]);
    assert.deepEqual(r.refErrors, []);
  });

  it("names the prefix itself when no doc registers the ordinal clause's prefix", () => {
    const out = lockAudit({
      omitOrdinalPrefix: true,
      docText: '# Locks\n\n**SL-1.** A clause that cites one.\n',
      justification: 'a person decides; lock 2 only probes it',
    });
    assert.deepEqual(out.surfaceErrors, [
      `EMPTY SURFACE: no active ordinals read from the doc registering prefix "${LOCK_PREFIX}" — the check reads the ordered list that follows the clause marker, so restore that shape before an ordinal citation can be held`,
    ]);
  });

  it('flags the two surfaces parting, in either direction', () => {
    assert.deepEqual(lockAudit({ entries: [1, 2, 3, 4] }).surfaceErrors, [
      `the two lock surfaces state one numbering: ${stated('1, 2, 3, 4', '1, 2, 3')}; they part on 4`,
    ]);
    assert.deepEqual(lockAudit({ titles: [1, 2, 3, 4] }).surfaceErrors, [
      `the two lock surfaces state one numbering: ${stated('1, 2, 3', '1, 2, 3, 4')}; they part on 4`,
    ]);
  });

  it('holds the surfaces against each other with no row citing an ordinal', () => {
    const r = lockAudit({ checkRef: `Run npm run test:shared.`, entries: [1, 2, 3, 4] });
    assert.deepEqual(r.surfaceErrors, [
      `the two lock surfaces state one numbering: ${stated('1, 2, 3, 4', '1, 2, 3')}; they part on 4`,
    ]);
    assert.deepEqual(r.refErrors, []);
  });

  it('names an emptied clause-list surface instead of passing vacuously', () => {
    const r = lockAudit({
      checkRef: CITE,
      docText: `# Locks\n\n**${LOCK_ORDINAL_CLAUSE}.** No list here.\n\n**SL-1.** A clause that cites one.\n`,
    });
    assert.deepEqual(
      r.surfaceErrors.filter((e) => e.startsWith('EMPTY SURFACE')),
      [
        `EMPTY SURFACE: no active ordinals read from ${LOCK_DOC} §${LOCK_ORDINAL_CLAUSE} — the check reads the ordered list that follows the clause marker, so restore that shape before an ordinal citation can be held`,
      ],
    );
  });

  it('names an emptied suite surface instead of passing vacuously', () => {
    const r = lockAudit({ checkRef: CITE, suiteText: "  it('the second lock holds', () => {});" });
    assert.deepEqual(r.surfaceErrors, [
      `EMPTY SURFACE: no \`lock (N):\` titles read from ${LOCK_SUITE_PATH} — the check reads the suite's lock titles, so restore that shape before an ordinal citation can be held`,
    ]);
  });

  it('names an unreadable suite surface the same way an emptied one is named', () => {
    const r = lockAudit({ checkRef: CITE, omitSuite: true });
    assert.deepEqual(r.surfaceErrors, [
      `EMPTY SURFACE: no \`lock (N):\` titles read from ${LOCK_SUITE_PATH} — the check reads the suite's lock titles, so restore that shape before an ordinal citation can be held`,
    ]);
  });
});

describe('extractClauseCites', () => {
  it('reads identifier-shaped tokens, deduplicated in first-seen order', () => {
    assert.deepEqual(
      extractClauseCites('TP-2 and ZZ-1 both matter; TP-2 again, and TP-2.'),
      ['TP-2', 'ZZ-1'],
      'the shape is read here; which prefixes are registered is the audit’s question',
    );
  });

  it('reads no identifier out of a longer hyphenated compound', () => {
    // `UTF-8` and `RFC-2119` ARE the shape — an unregistered prefix is what
    // leaves them prose, and that is the audit's decision, not this one's.
    assert.deepEqual(extractClauseCites('UTF-8 in an ABC-1-2 build, and RFC-2119 prose'), [
      'UTF-8',
      'RFC-2119',
    ]);
    assert.deepEqual(extractClauseCites(undefined), []);
  });
});

describe("auditClauseRegistry — the area map's clause citations", () => {
  const auditMapText = (mapText, overrides = {}) =>
    audit({ contents: { [MAP_PATH]: mapText }, ...overrides });

  const entry = (list) => `${MAP_PATH} "${list}" entry ${MAP_ENTRY_PATH}`;

  it('passes a reason citing an active clause', () => {
    assert.deepEqual(auditMapText(mapWithReason('TP-1')).mapErrors, []);
  });

  it('flags a reason citing a clause the registry retires, naming the retirement', () => {
    const registry = makeRegistry({ retired: { TP: ['TP-9'] } });
    assert.deepEqual(auditMapText(mapWithReason('TP-9'), { registry }).mapErrors, [
      `${entry('declared-governance')} cites clause "TP-9", which ${REGISTRY_PATH} retires; a citation names an active clause`,
    ]);
  });

  it('flags a reason citing a number no active registry row states', () => {
    // What the leg tests is membership in the ACTIVE ROW set, so that is what
    // the red says: the marker leg answers separately for whether the document
    // states the clause, and the two must not contradict each other in one run.
    assert.deepEqual(auditMapText(mapWithReason('TP-7')).mapErrors, [
      `${entry('declared-governance')} cites clause "TP-7", which no active row of ${REGISTRY_PATH} states; a citation names a registered clause, and prefix "TP" registers docs/testable.md`,
    ]);
  });

  it('leaves a token whose prefix no row registers unread, as the prose it is', () => {
    const r = auditMapText(mapWithReason('ZZ-1 (and UTF-8)'));
    assert.deepEqual(r.mapErrors, []);
    assert.deepEqual(r.refErrors, []);
  });

  it('reads every list the leg names, not the first one only', () => {
    const map = JSON.parse(mapWithReason(null));
    map.unassigned[0].reason = 'licence text; nothing like TP-7 governs it';
    map['governance-partitions'][0].reason = 'each file declares its own, per TP-7';
    const r = auditMapText(JSON.stringify(map));
    const missing = `cites clause "TP-7", which no active row of ${REGISTRY_PATH} states; a citation names a registered clause, and prefix "TP" registers docs/testable.md`;
    assert.deepEqual(r.mapErrors, [
      `${MAP_PATH} "unassigned" entry LICENSE ${missing}`,
      `${MAP_PATH} "governance-partitions" entry packages/x/** ${missing}`,
    ]);
  });

  it('refuses an entry list the map no longer states at all', () => {
    const map = JSON.parse(mapWithReason(null));
    delete map['declared-governance'];
    assert.deepEqual(auditMapText(JSON.stringify(map)).mapErrors, [
      `EMPTY SURFACE: ${MAP_PATH} states no "declared-governance" array — the check reads every entry's reason there, so restore that shape before a reason's clause citation can be held`,
    ]);
  });

  it('passes a stated but empty entry list — a fact about the tree, not a shape that moved', () => {
    // The area map's own gate demands removing an entry that is no longer
    // needed, so a list emptied down to nothing must stay green here: redding
    // it would leave the two gates unable to be satisfied at once.
    const map = JSON.parse(mapWithReason(null));
    map['declared-governance'] = [];
    const r = auditMapText(JSON.stringify(map));
    assert.deepEqual([r.mapErrors, r.listErrors], [[], []]);
  });

  it('refuses a map whose text is not JSON, saying that is what it found', () => {
    const r = audit({ contents: { [MAP_PATH]: '{ not json' } });
    assert.deepEqual(r.mapErrors, [
      `EMPTY SURFACE: ${MAP_PATH} does not read as JSON — the check reads the reason of every entry in ${AREA_MAP_ENTRY_LISTS.join(', ')}, so restore that shape before a reason's clause citation can be held`,
    ]);
  });

  it('refuses a map whose text is JSON but not the map object, saying THAT is what it found', () => {
    // The third class the guard admits: the text parses, so calling it bad JSON
    // would be false. Each scalar reaches the same repair — put the map object
    // back — and takes the wording the map's own check prints for that input.
    for (const text of ['null', '42', '"a map"', 'true']) {
      const r = audit({ contents: { [MAP_PATH]: text } });
      assert.deepEqual(
        r.mapErrors,
        [
          `EMPTY SURFACE: ${MAP_PATH} is not an object — the check reads the reason of every entry in ${AREA_MAP_ENTRY_LISTS.join(', ')}, so restore that shape before a reason's clause citation can be held`,
        ],
        text,
      );
    }
  });

  it('refuses a map it could not read at all, saying THAT is what it found', () => {
    // Each class is a different repair — restore the file, fix its text, or put
    // the map object back — so the surface red names the one it found instead of
    // reporting an absent file as bad JSON.
    const r = audit({ contents: { [MAP_PATH]: null } });
    assert.deepEqual(r.mapErrors, [
      `EMPTY SURFACE: ${MAP_PATH} could not be read — the check reads the reason of every entry in ${AREA_MAP_ENTRY_LISTS.join(', ')}, so restore that shape before a reason's clause citation can be held`,
    ]);
  });

  it("reports under the map's own subject, never the registry's", () => {
    const r = auditMapText(mapWithReason('TP-7'));
    const sections = reportSections(r);
    const withErrors = sections.filter((s) => s.errors.length);
    assert.deepEqual(
      withErrors.map((s) => s.subject),
      [MAP_PATH],
    );
  });
});

describe("auditClauseRegistry — the vector fixtures' lock citations", () => {
  const auditFixture = (text) => audit({ contents: { [VECTOR_FIXTURES_PATH]: text } });
  const stated = `${LOCK_DOC} §${LOCK_ORDINAL_CLAUSE} numbers 1, 2, 3 active and ${LOCK_SUITE_PATH} titles 1, 2, 3`;

  it('passes a description citing an active lock both surfaces state', () => {
    const r = auditFixture(fixtureCiting(2));
    assert.deepEqual([r.fixtureErrors, r.refErrors, r.surfaceErrors], [[], [], []]);
  });

  it('flags a description citing an ordinal outside what the surfaces state', () => {
    assert.deepEqual(auditFixture(fixtureCiting(9)).fixtureErrors, [
      `${VECTOR_FIXTURES_PATH} description cites lock 9; a cited ordinal is one both surfaces state — ${stated}`,
    ]);
  });

  it('flags a description citing a lock the list retires', () => {
    const contents = {
      [LOCK_DOC]: lockList([1, { n: 2 }, 3]),
      [LOCK_SUITE_PATH]: lockSuite([1, 3]),
      [VECTOR_FIXTURES_PATH]: fixtureCiting(2),
    };
    const r = audit({ contents });
    assert.deepEqual(r.fixtureErrors, [
      `${VECTOR_FIXTURES_PATH} description cites lock 2, which ${LOCK_DOC} §${LOCK_ORDINAL_CLAUSE} retires; a citation names an active lock`,
    ]);
    assert.deepEqual([r.refErrors, r.surfaceErrors], [[], []]);
  });

  it('refuses an unreadable or shapeless fixture instead of passing vacuously', () => {
    const refusal = `EMPTY SURFACE: no "description" string read from ${VECTOR_FIXTURES_PATH} — the check reads that description's lock citations, so restore that shape before one can be held`;
    for (const text of [
      null,
      'not json',
      JSON.stringify({ fixtures: [] }),
      JSON.stringify({ description: '  ' }),
    ]) {
      // prettier-ignore
      assert.deepEqual(auditFixture(text).fixtureErrors, [refusal], String(text));
    }
  });

  it("reports under the fixture's own subject, never the registry's or the surfaces'", () => {
    const withErrors = reportSections(auditFixture(fixtureCiting(9))).filter(
      (s) => s.errors.length,
    );
    assert.deepEqual(
      withErrors.map((s) => s.subject),
      [VECTOR_FIXTURES_PATH],
    );
  });
});

describe('baseline lock (real tree)', () => {
  it("the committed map's and fixtures' citations resolve", () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const readFile = readTextOrNull;
    const r = auditClauseRegistry({
      registry: JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')),
      files,
      readFile,
      packageScripts: Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts),
    });
    assert.deepEqual(
      r.mapErrors,
      [],
      'an area-map entry reason cites a clause that does not resolve — fix the reason, or the clause it names',
    );
    assert.deepEqual(
      r.fixtureErrors,
      [],
      'the vector fixtures cite a lock ordinal the two lock surfaces do not both state',
    );
  });
});

describe("auditClauseRegistry — the clause document's own prose cites", () => {
  /** The lock doc with `prose` following its list, and the sibling clause. */
  const docWithProse = (entries, prose) =>
    `${lockList(entries)}\n${prose}\n\n**SL-1.** A clause that cites nothing.\n`;

  function proseAudit(entries, prose, titles = [1, 2, 3]) {
    const contents = {
      ...BASE_CONTENTS,
      [LOCK_DOC]: docWithProse(entries, prose),
      [LOCK_SUITE_PATH]: lockSuite(titles),
      [VECTOR_FIXTURES_PATH]: fixtureCiting(null),
    };
    return auditClauseRegistry({
      registry: {
        description: 'lock registry',
        prefixes: { [LOCK_PREFIX]: LOCK_DOC, SL: LOCK_DOC },
        retired: { [LOCK_PREFIX]: [], SL: [] },
        clauses: [
          lockRow(),
          {
            doc: LOCK_DOC,
            clause: 'SL-1',
            tag: 'judgment-only',
            justification: 'a person decides',
          },
        ],
      },
      files: [...CITABLE_ROOT_FILES, VECTOR_FIXTURES_PATH, LOCK_DOC, LOCK_SUITE_PATH],
      readFile: (f) => contents[f] ?? null,
      packageScripts: [],
    });
  }

  it('passes prose that cites active locks, in either spelling', () => {
    const r = proseAudit([1, 2, 3], "Lock 3's evaluator runs it, and lock (2) checks consistency.");
    assert.deepEqual([r.surfaceErrors, r.refErrors], [[], []]);
  });

  it('flags prose citing an ordinal no entry states, naming the line', () => {
    const r = proseAudit([1, 2, 3], "Lock 9's evaluator runs it.");
    assert.equal(r.surfaceErrors.length, 1);
    assert.ok(
      r.surfaceErrors[0].startsWith(`${LOCK_DOC}:9 cites lock 9 in prose; a citation names`),
      r.surfaceErrors[0],
    );
  });

  it('flags prose citing a lock the list retires', () => {
    const r = proseAudit([1, { n: 2 }, 3], 'The retired lock 2 is still described here.', [1, 3]);
    assert.equal(r.surfaceErrors.length, 1);
    assert.ok(r.surfaceErrors[0].includes('cites lock 2 in prose'), r.surfaceErrors[0]);
  });

  it('reads the numbered list itself as the list, never as prose citing itself', () => {
    assert.deepEqual(
      extractDocLockCites(lockList([1, 2, 3]), LOCK_ORDINAL_CLAUSE),
      [],
      'the entries own their numbers; only prose outside the list cites them',
    );
  });
});
