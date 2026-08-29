/**
 * check-verification-inventory.test.js — Unit tests for the
 * verification-inventory admission test
 * (scripts/check-verification-inventory.js). Each inventory is committed
 * prose held against a constant, the manifest, or the workflow, so every
 * red-path family must fail loud: these tests prove the both-way set diffs on
 * each set inventory and the one-way containment of the job-citation leg (every
 * cite names a real job; a job owes no cite), the per-kind field diffs, the
 * class claim and the heading the document states it in, the outcome the
 * corpus clause and the vector meta-schema state of every shipped vector, the
 * unreadable-item, unreadable-cell, and unreadable-token
 * refusals, the exactly-one-table and exactly-one-heading selections, the
 * per-document
 * citation vacuity guard, duplicates, empty parses, and the loud refusal of an
 * input file the command-line readers cannot read or cannot recognise as the
 * surface they read it as — plus the extraction
 * grammars on synthetic documents, and, as a real-tree lock, that the shipped
 * documents satisfy every pin.
 *
 * The decisions the check declares rather than derives get their own families:
 * which documents the citation leg scans, held to the tracked verification
 * documents so a third one cannot land outside the leg unseen, and which
 * problem of the shared job-id extractor means the workflow itself could not be
 * read — the words that classification keys on are pinned, so a problem that
 * extractor grows later keeps the route it has today.
 *
 * The strict-flip watch gets its own families: every quadrant of both flag legs
 * on every watched platform, the axis independence between them (one flag owed
 * never implies the other), the active-filtered fail-entry population, the
 * token-exact flag detection that keeps the `--lint` both gates already pass
 * from reading as `--lint-strict`, and a shape verdict for each way each file
 * it reads can be truncated, emptied, or malformed — because each of
 * those, believed, would read as a trigger that came true. Two further families
 * hold the watch to the tree it claims to watch: the catalogue's platform
 * population diffed against the watched set both ways, and each gate command's
 * own `--platform` and `--baseline` argument values against what this check
 * reads for it — a gate pointed elsewhere is watched against a state it does
 * not gate on.
 *
 * The exit-code contract is pinned where it lives, at the process boundary: a
 * spawned-CLI family runs the real command over a temporary tree holding copies
 * of the files it reads, and holds 0 / 1 / 2 to their meanings — green, an
 * inventory that drifted, and machinery breakage that must never read as a
 * drift verdict.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CORPUS_DOC_PATH,
  LINT_DOC_PATH,
  MANIFEST_PATH,
  PACKAGE_JSON_PATH,
  SUFFICIENCY_BASELINE_PATH,
  VECTOR_SCHEMA_PATH,
  NORMALIZATION_TABLE_HEADER,
  PER_ACTION_TABLE_HEADER,
  RECORDING_TABLE_HEADER,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  activeSessionsKey,
  CODE_RELAXATION_FIELDS,
  CODE_NORMALIZATION_TOKENS,
  RELAXATION_LITERALS,
  NORMALIZATION_LITERALS,
  STRICT_WATCH_PLATFORMS,
  STRICT_FLAG,
  LINT_STRICT_FLAG,
  PLATFORM_ARG,
  BASELINE_ARG,
  SUFFICIENCY_SCRIPT,
  PER_ACTION_CLASS,
  OUTCOME_FIELD,
  OUTCOME_CLAUSE_ID,
  CITED_JOB_DOCUMENTS,
  NAMED_CAUSE_CAP,
  JOB_ANCHOR_PROBLEM,
  readFieldTokens,
  extractRelaxationCoverage,
  extractStatedKinds,
  extractStatedOutcome,
  selectTableByHeader,
  extractNormalizationTokens,
  extractSessionIds,
  extractPredicateTables,
  extractPerActionClass,
  extractJobCites,
  documentCitations,
  commandTokens,
  passesFlag,
  argumentValue,
  namedCauses,
  strictWatchProblems,
  gateArgumentProblems,
  readKnownDiffsBaseline,
  readSufficiencyBaseline,
  readVectorOutcome,
  corpusFailKeys,
  readGateCommands,
  readManifestPlatforms,
  evaluateVerificationInventory,
  auditTree,
  InputError,
  readTreeFile,
  listActiveSessions,
} from '../../../../scripts/check-verification-inventory.js';
import { topLevelListItems, trackedFilesUnder } from '../../../../scripts/check-test-inventory.js';
import { RELAX_KINDS } from '../../../../scripts/corpus-compare.js';
import { TEST_WORKFLOW_PATH, extractJobIds } from '../../../../scripts/check-doc-closure.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/**
 * One platform's gate state for the strict-flip watch, defaulting to the
 * shipped situation: a baseline that still carries a diff, corpus truths that
 * still carry a fail-class finding, and neither flag passed.
 *
 * `knownDiffsEmpty` and `failFree` are DERIVED from the populations beside
 * them, exactly as `auditTree` derives them from what it read, so no fixture
 * can state a watch state a real tree cannot produce. A case that wants a
 * trigger's condition met passes that condition's population empty, and the
 * boolean follows it.
 */
function watchEntry(overrides = {}) {
  const platform = overrides.platform ?? 'extension';
  const baselinePath = overrides.baselinePath ?? 'corpus/known-diffs.extension.json';
  const entry = {
    platform,
    script: 'corpus:check',
    baselinePath,
    // What is holding each trigger shut, as the shipped watch reads it: the
    // baseline sessions still carrying a diff, and the baseline keys whose
    // active corpus truths still carry a fail-class finding.
    knownDiffsCarrying: [`${platform}-open-diff`],
    failKeys: [`corpus/sessions/${platform}-a/truth.docent.json`],
    strict: false,
    lintStrict: false,
    // The gate command's own argument values, defaulting to agreement with the
    // entry — the shipped state, so a case that does not repoint them is green.
    platformArg: platform,
    baselineArg: baselinePath,
    ...overrides,
  };
  return {
    ...entry,
    knownDiffsEmpty: entry.knownDiffsCarrying.length === 0,
    failFree: entry.failKeys.length === 0,
  };
}

/**
 * The active-session list each watched platform's surface carries in the
 * fixture. A platform the watch grows and this table has not is given a
 * non-empty stand-in rather than left undefined, so the derived family below
 * extends itself and the compliant baseline stays green until someone gives it
 * meaningful ids.
 */
const FIXTURE_SESSIONS = {
  'desktop-windows': ['d-click', 'd-redaction'],
  extension: ['ext-click-basic', 'ext-key'],
};

/** A consistent synthetic surface every leg accepts. */
function makeSurface(overrides = {}) {
  return {
    docKinds: ['match-stats', 'path'],
    docKindFields: [
      ['match-stats', ['match_count', 'match_index']],
      ['path', ['file_path', 'source']],
    ],
    relaxUnreadable: [],
    docStatedKinds: ['match-stats', 'path'],
    codeKinds: ['match-stats', 'path'],
    codeKindFields: [
      ['match-stats', ['match_count', 'match_index']],
      ['path', ['file_path', 'source']],
    ],
    docNormalizationTokens: ['project_id', 'timestamp'],
    normalizationTableMatches: 1,
    codeNormalizationTokens: ['project_id', 'timestamp'],
    docSessionIds: ['d-click', 'd-redaction'],
    docOutcomeFields: [OUTCOME_FIELD],
    docOutcomes: ['resolved'],
    schemaOutcomes: ['resolved'],
    schemaRequiresOutcome: true,
    // One per watched platform, keyed exactly as the check keys its own — so a
    // platform added to the watch needs no edit here to stay covered.
    ...Object.fromEntries(
      STRICT_WATCH_PLATFORMS.map((w) => [
        activeSessionsKey(w.platform),
        FIXTURE_SESSIONS[w.platform] ?? [`${w.platform}-session`],
      ]),
    ),
    docPerAction: ['element-locators', 'key-nonempty'],
    perActionTableMatches: 1,
    docPerActionClass: PER_ACTION_CLASS,
    perActionHeadingMatches: 1,
    codePerAction: ['element-locators', 'key-nonempty'],
    codeNonFailPerAction: [],
    docRecording: ['context-introduced fail', 'start-point gap'],
    recordingTableMatches: 1,
    codeRecording: ['context-introduced fail', 'start-point gap'],
    predicateUnreadable: [],
    unreadableTokens: [],
    docCites: [
      { path: CORPUS_DOC_PATH, cites: ['unit-tests'] },
      { path: LINT_DOC_PATH, cites: ['unit-tests'] },
    ],
    strictWatch: [
      watchEntry(),
      watchEntry({
        platform: 'desktop-windows',
        script: 'corpus:check:desktop',
        baselinePath: 'corpus/known-diffs.desktop-windows.json',
      }),
    ],
    manifestPlatforms: ['extension', 'desktop-windows'],
    watchedPlatforms: ['extension', 'desktop-windows'],
    sufficiencyBaselineArg: SUFFICIENCY_BASELINE_PATH,
    workflowJobIds: ['lint', 'unit-tests'],
    ...overrides,
  };
}

describe('evaluateVerificationInventory — compliant baseline', () => {
  it('returns no problems when every inventory holds', () => {
    assert.deepEqual(evaluateVerificationInventory(makeSurface()), []);
  });
});

describe('evaluateVerificationInventory — relaxation kinds and their fields', () => {
  it('fires when the clause states a kind the comparator does not carry', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docKinds: ['match-stats', 'path', 'timings'],
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['timings', ['duration_ms']],
        ],
      }),
    );
    assert.ok(problems.some((p) => p.includes('timings') && p.includes('RELAX_KINDS does not')));
  });

  it('fires when the comparator carries a kind the clause does not state', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        codeKinds: ['match-stats', 'path', 'scroll-amounts'],
        codeKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['scroll-amounts', ['scroll_top']],
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('scroll-amounts') && p.includes('does not state')),
      problems.join('\n'),
    );
  });

  it('fires when a comparator kind has no field list in this check', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docKinds: ['match-stats', 'path', 'scroll-amounts'],
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['scroll-amounts', ['scroll_top']],
        ],
        codeKinds: ['match-stats', 'path', 'scroll-amounts'],
      }),
    );
    assert.ok(problems.some((p) => p.includes('scroll-amounts') && p.includes('knows no field list'))); // prettier-ignore
  });

  it('fires when this check knows a field list for a kind the comparator dropped', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        codeKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source']],
          ['retired-kind', ['gone']],
        ],
      }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('retired-kind') && p.includes('is not a comparator relaxation kind'),
      ),
    );
  });

  it('fires on a field stated twice inside one kind’s item', () => {
    // The set diffs deduplicate, so a doubled field is invisible to them.
    const problems = evaluateVerificationInventory(
      makeSurface({
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source', 'file_path']],
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('file_path') && p.includes('more than once') && p.includes('`path` covered-field list')), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('fires in both directions on one kind’s covered fields', () => {
    const docExtra = evaluateVerificationInventory(
      makeSurface({
        docKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source', 'dialog_path']],
        ],
      }),
    );
    assert.ok(docExtra.some((p) => p.includes('dialog_path') && p.includes('does not carry')));
    const codeExtra = evaluateVerificationInventory(
      makeSurface({
        codeKindFields: [
          ['match-stats', ['match_count', 'match_index']],
          ['path', ['file_path', 'source', 'dialog_path']],
        ],
      }),
    );
    assert.ok(codeExtra.some((p) => p.includes('dialog_path') && p.includes('does not state')));
  });
});

describe('evaluateVerificationInventory — §STC-5’s stated kind set (both ways)', () => {
  it('fires when the kind sentence states a kind the comparator does not carry', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docStatedKinds: ['match-stats', 'path', 'timings'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('timings') && p.includes('kind sentence states')),
      problems.join('\n'),
    );
  });

  it('fires when the comparator carries a kind the sentence does not state', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docStatedKinds: ['match-stats'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('path') && p.includes('kind sentence does not state')),
      problems.join('\n'),
    );
  });

  it('names the sentence, not §STC-21’s per-kind list, so the two copies stay tellable apart', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docStatedKinds: ['match-stats', 'path', 'timings'] }),
    );
    const stated = problems.filter((p) => p.includes('timings'));
    assert.equal(stated.length, 1, problems.join('\n'));
    assert.ok(stated[0].includes('STC-5'), stated[0]);
    assert.ok(!stated[0].includes('STC-21'), stated[0]);
  });
});

describe('evaluateVerificationInventory — normalization classes (both ways)', () => {
  it('fires when the table names a token the class map does not carry', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docNormalizationTokens: ['project_id', 'timestamp', 'viewport'] }),
    );
    assert.ok(problems.some((p) => p.includes('viewport') && p.includes('class map does not carry'))); // prettier-ignore
  });

  it('fires when the class map carries a token the table does not state', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ codeNormalizationTokens: ['project_id', 'timestamp', 'window_rect'] }),
    );
    assert.ok(problems.some((p) => p.includes('window_rect') && p.includes('does not state')));
  });
});

describe('evaluateVerificationInventory — session catalogue (both ways)', () => {
  it('fires when the clause enumerates a session the manifest does not run', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docSessionIds: ['d-click', 'd-redaction', 'd-retired'] }),
    );
    assert.ok(problems.some((p) => p.includes('d-retired') && p.includes('no active')));
  });

  it('fires when an active session is missing from the clause', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        [activeSessionsKey('desktop-windows')]: ['d-click', 'd-redaction', 'd-new-behaviour'],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('d-new-behaviour') && p.includes('does not enumerate it')),
    );
  });
});

describe('evaluateVerificationInventory — predicate catalogue', () => {
  it('fires in both directions on the per-action names', () => {
    const docExtra = evaluateVerificationInventory(
      makeSurface({ docPerAction: ['element-locators', 'key-nonempty', 'ghost-predicate'] }),
    );
    assert.ok(docExtra.some((p) => p.includes('ghost-predicate') && p.includes('does not define')));
    const codeExtra = evaluateVerificationInventory(
      makeSurface({ codePerAction: ['element-locators', 'key-nonempty', 'new-predicate'] }),
    );
    assert.ok(
      codeExtra.some((p) => p.includes('new-predicate') && p.includes('table does not carry')),
    );
  });

  it('fires on a recording-level class the doc and the code disagree on', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ docRecording: ['context-introduced fail', 'start-point fail'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('start-point fail') && p.includes('does not define')),
    );
    assert.ok(problems.some((p) => p.includes('start-point gap') && p.includes('does not carry')));
  });

  it('fires when a per-action predicate is not fail class', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ codeNonFailPerAction: ['key-nonempty'] }),
    );
    const named = problems.filter((p) => p.includes('key-nonempty') && p.includes('not `fail` class')); // prettier-ignore
    assert.equal(named.length, 1, problems.join('\n'));
    // The heading was read stating that same class here, so this line may
    // attribute the class to the document.
    assert.ok(named[0].includes('per-action heading states of all of them'), named[0]);
  });

  it('drops the heading attribution where the heading states another class', () => {
    // Both claims are the document's own and they disagree: the heading finding
    // carries the doc-side claim, so the per-predicate line must not also tell
    // the reader the heading states `fail` of all of them.
    const problems = evaluateVerificationInventory(
      makeSurface({ docPerActionClass: 'gap', codeNonFailPerAction: ['key-nonempty'] }),
    );
    const named = problems.filter((p) => p.includes('key-nonempty') && p.includes('not `fail` class')); // prettier-ignore
    assert.equal(named.length, 1, problems.join('\n'));
    assert.ok(!named[0].includes('heading'), named[0]);
    assert.ok(
      problems.some((p) => p.includes('states its predicates are all `gap` class')),
      problems.join('\n'),
    );
  });
});

describe('evaluateVerificationInventory — job citations', () => {
  it('fires when a document cites a job the workflow does not define', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docCites: [
          { path: CORPUS_DOC_PATH, cites: ['unit-tests', 'renamed-away'] },
          { path: LINT_DOC_PATH, cites: ['unit-tests'] },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('renamed-away') && p.includes('has no such job')),
      problems.join('\n'),
    );
  });

  it('fires per scanned document when its citation extraction comes back empty', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        docCites: [
          { path: CORPUS_DOC_PATH, cites: ['unit-tests'] },
          { path: LINT_DOC_PATH, cites: [] },
        ],
      }),
    );
    // The guard is unconditional; its message names both legitimate exits
    // rather than asserting the scan is the broken side.
    const empty = problems.filter((p) => p.includes(LINT_DOC_PATH) && p.includes('no job citations found')); // prettier-ignore
    assert.equal(empty.length, 1, problems.join('\n'));
    assert.ok(empty[0].includes('restore a job cite'), empty[0]);
    // The other exit names the declared list and what dropping a document from
    // it really costs: the case below holding that list to the tracked
    // verification documents has to be retired or narrowed in the same change.
    assert.ok(empty[0].includes('drop the document from CITED_JOB_DOCUMENTS'), empty[0]);
    assert.ok(empty[0].includes('retiring or narrowing that case'), empty[0]);
  });
});

// The strict-flip watch, driven through every quadrant of both legs on each
// watched platform. The two flags are on separate axes by §STC-3, so the
// green/red table is per flag, and the cases below hold that separation: a
// platform can owe `--strict` while `--lint-strict` is correctly still absent.
for (const { platform, script, baselinePath } of STRICT_WATCH_PLATFORMS) {
  const gate = (overrides) => [watchEntry({ platform, script, baselinePath, ...overrides })];

  describe(`strict-flip watch — ${platform}`, () => {
    it('demands the strict flag once the known-diffs baseline empties', () => {
      const problems = strictWatchProblems(gate({ knownDiffsCarrying: [] }));
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes(baselinePath), problems[0]);
      assert.ok(problems[0].includes(`npm run ${script}`), problems[0]);
      assert.ok(problems[0].includes(STRICT_FLAG), problems[0]);
      assert.ok(problems[0].includes('STC-3'), problems[0]);
    });

    it('reds on a strict flag passed before its trigger', () => {
      const problems = strictWatchProblems(gate({ strict: true }));
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes('still carries a known diff'), problems[0]);
      assert.ok(problems[0].includes(`passes \`${STRICT_FLAG}\``), problems[0]);
    });

    it('is green with the flag absent before the trigger, and present after it', () => {
      assert.deepEqual(strictWatchProblems(gate({})), []);
      assert.deepEqual(strictWatchProblems(gate({ knownDiffsCarrying: [], strict: true })), []);
    });

    it('demands the lint-strict flag only once BOTH of its conditions hold', () => {
      // Known-diffs empty alone is not enough — that is the `--strict` axis.
      const halfway = strictWatchProblems(gate({ knownDiffsCarrying: [], strict: true }));
      assert.deepEqual(halfway, []);
      const problems = strictWatchProblems(
        gate({ knownDiffsCarrying: [], failKeys: [], strict: true }),
      );
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes(LINT_STRICT_FLAG), problems[0]);
      assert.ok(problems[0].includes(SUFFICIENCY_BASELINE_PATH), problems[0]);
      assert.ok(problems[0].includes(platform), problems[0]);
    });

    it('names every unmet condition when the lint-strict flag is passed early', () => {
      const onlyDiffs = strictWatchProblems(gate({ failKeys: [], lintStrict: true }));
      assert.equal(onlyDiffs.length, 1, onlyDiffs.join('\n'));
      assert.ok(onlyDiffs[0].includes('still carries a known diff'), onlyDiffs[0]);
      assert.ok(!onlyDiffs[0].includes('fail`-class entry'), onlyDiffs[0]);

      const onlyFails = strictWatchProblems(
        gate({ knownDiffsCarrying: [], strict: true, lintStrict: true }),
      );
      assert.equal(onlyFails.length, 1, onlyFails.join('\n'));
      assert.ok(onlyFails[0].includes('`fail`-class entry'), onlyFails[0]);
      assert.ok(!onlyFails[0].includes('still carries a known diff'), onlyFails[0]);

      const both = strictWatchProblems(gate({ lintStrict: true }));
      const premature = both.filter((p) => p.includes(LINT_STRICT_FLAG));
      assert.equal(premature.length, 1, both.join('\n'));
      assert.ok(premature[0].includes('still carries a known diff'), premature[0]);
      assert.ok(premature[0].includes('`fail`-class entry'), premature[0]);
    });

    it('is green with the lint-strict flag absent before, and present after, both conditions', () => {
      assert.deepEqual(strictWatchProblems(gate({ failKeys: [] })), []);
      assert.deepEqual(
        strictWatchProblems(
          gate({ knownDiffsCarrying: [], failKeys: [], strict: true, lintStrict: true }),
        ),
        [],
      );
    });

    it('keeps the two axes independent — one flag owed never implies the other', () => {
      const problems = strictWatchProblems(gate({ knownDiffsCarrying: [] }));
      assert.ok(!problems.some((p) => p.includes(LINT_STRICT_FLAG)), problems.join('\n'));
    });
  });
}

describe('the strict-flip watch reaches the evaluator', () => {
  it('a demanded flag surfaces through evaluateVerificationInventory', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ strictWatch: [watchEntry({ knownDiffsCarrying: [] })] }),
    );
    assert.ok(
      problems.some((p) => p.includes(STRICT_FLAG) && p.includes('does not pass it')),
      problems.join('\n'),
    );
  });

  it('the watch never runs on a vacuous surface — an empty parse returns first', () => {
    // A platform with zero active sessions routes to the drift channel through
    // its own EMPTY_SURFACES entry, and the early return keeps the watch from
    // reading "no active session carries a fail finding" as a flip trigger.
    const problems = evaluateVerificationInventory(
      makeSurface({
        [activeSessionsKey('extension')]: [],
        strictWatch: [watchEntry({ knownDiffsCarrying: [], failKeys: [] })],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('no active extension sessions')),
      problems.join('\n'),
    );
    assert.ok(!problems.some((p) => p.includes(LINT_STRICT_FLAG)), problems.join('\n'));
  });
});

// The gate-argument cross-check reads gate commands and this check's own
// constants only — no parsed document surface, no session discovery — so it is
// sound on a tree whose extractions came back empty, and it runs there. Behind
// the vacuity return it was undiagnosable: any one empty surface hid a gate
// pointed at a file it does not gate on.
describe('the gate-argument cross-check survives a vacuous surface', () => {
  it('diagnoses a repointed gate beside an emptied active-session list', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        [activeSessionsKey('extension')]: [],
        strictWatch: [watchEntry({ baselineArg: 'corpus/elsewhere.json' })],
      }),
    );
    assert.ok(problems.some((p) => p.includes('no active extension sessions')), problems.join('\n')); // prettier-ignore
    assert.ok(problems.some((p) => p.includes('corpus/elsewhere.json') && p.includes(BASELINE_ARG)), problems.join('\n')); // prettier-ignore
  });

  it('diagnoses one beside a scanned document that stopped citing a job', () => {
    // The likelier trigger of the two: one scanned document carries a single
    // job cite, so an ordinary reword fires its per-document vacuity leg.
    const problems = evaluateVerificationInventory(
      makeSurface({
        docCites: [
          { path: CORPUS_DOC_PATH, cites: ['unit-tests'] },
          { path: LINT_DOC_PATH, cites: [] },
        ],
        strictWatch: [watchEntry({ platformArg: 'desktop-windows' })],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('no job citations found')),
      problems.join('\n'),
    );
    assert.ok(problems.some((p) => p.includes(PLATFORM_ARG) && p.includes('desktop-windows')), problems.join('\n')); // prettier-ignore
  });

  it('a surface stating no watch reaches the guard rather than a type error', () => {
    const surface = makeSurface();
    delete surface.strictWatch;
    const problems = evaluateVerificationInventory(surface);
    assert.ok(
      problems.some((p) => p.includes('`strictWatch`')),
      problems.join('\n'),
    );
  });

  it('a surface stating no sufficiency baseline argument reads as nothing, never as `undefined`', () => {
    const surface = makeSurface();
    delete surface.sufficiencyBaselineArg;
    const problems = evaluateVerificationInventory(surface);
    const named = problems.filter((p) => p.includes(`npm run ${SUFFICIENCY_SCRIPT}`));
    assert.equal(named.length, 1, problems.join('\n'));
    assert.ok(named[0].includes('passes nothing for'), named[0]);
    assert.ok(!named[0].includes('undefined'), named[0]);
  });
});

// A verdict about a trigger that has not come true names what is holding it
// shut: without that, "still carries a known diff" sends the reader to a file
// of per-session lists to search by hand.
describe('strict-flip verdicts name what is holding a trigger shut', () => {
  const truthKey = (id) => `corpus/sessions/${id}/truth.docent.json`;

  it('names the baseline sessions still carrying a diff, on both legs that report one', () => {
    const premature = strictWatchProblems([
      watchEntry({ strict: true, knownDiffsCarrying: ['ext-pointer-drag', 'ext-scroll-floor'] }),
    ]);
    assert.equal(premature.length, 1, premature.join('\n'));
    assert.ok(premature[0].includes('(ext-pointer-drag, ext-scroll-floor)'), premature[0]);

    const unmet = strictWatchProblems([
      watchEntry({ lintStrict: true, failKeys: [], knownDiffsCarrying: ['ext-pointer-drag'] }),
    ]);
    assert.equal(unmet.length, 1, unmet.join('\n'));
    assert.ok(unmet[0].includes('still carries a known diff (ext-pointer-drag)'), unmet[0]);
  });

  it('names the corpus truths still carrying a fail-class finding, by baseline key alone', () => {
    const problems = strictWatchProblems([
      watchEntry({
        knownDiffsCarrying: [],
        strict: true,
        lintStrict: true,
        failKeys: [truthKey('ext-tab-open')],
      }),
    ]);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.ok(problems[0].includes(`(${truthKey('ext-tab-open')})`), problems[0]);
    // The key names a file to open; the findings under it stay out of the line,
    // which is what keeps one verdict readable at the width a reader scans.
    assert.ok(!problems[0].includes('fail:element-locators'), problems[0]);
  });

  it('names up to the cap and counts the rest, so one line stays one line', () => {
    const carrying = Array.from({ length: NAMED_CAUSE_CAP + 2 }, (_, i) => `ext-session-${i}`);
    const problems = strictWatchProblems([
      watchEntry({ strict: true, knownDiffsCarrying: carrying }),
    ]);
    assert.equal(problems.length, 1, problems.join('\n'));
    for (const named of carrying.slice(0, NAMED_CAUSE_CAP)) {
      assert.ok(problems[0].includes(named), problems[0]);
    }
    assert.ok(!problems[0].includes(carrying[NAMED_CAUSE_CAP]), problems[0]);
    assert.ok(problems[0].includes('and 2 more'), problems[0]);
  });

  it('names nothing where an entry states no population, and the verdict still stands', () => {
    const bare = { ...watchEntry({ strict: true }), knownDiffsCarrying: undefined };
    const problems = strictWatchProblems([bare]);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.ok(problems[0].includes('still carries a known diff —'), problems[0]);
    assert.ok(!problems[0].includes(' ('), problems[0]);
  });

  it('the cap renders a name list, a counted remainder, and nothing for nothing', () => {
    assert.equal(namedCauses([]), '');
    assert.equal(namedCauses(['a', 'b']), ' (a, b)');
    assert.equal(namedCauses(['a', 'b', 'c'], 2), ' (a, b, and 1 more)');
  });
});

describe('flag detection is token-exact', () => {
  it('splits a command into whitespace-separated tokens', () => {
    assert.deepEqual(commandTokens('node x.js  --platform extension --lint'), [
      'node',
      'x.js',
      '--platform',
      'extension',
      '--lint',
    ]);
    assert.deepEqual(commandTokens(undefined), []);
  });

  it('`--lint` neither satisfies nor trips the lint-strict legs', () => {
    // Both shipped gate commands pass `--lint`; a substring test would read it
    // as `--lint-strict` and green the demand leg forever.
    const withLint = 'node scripts/corpus-compare.js --platform extension --lint';
    assert.equal(passesFlag(withLint, LINT_STRICT_FLAG), false);
    assert.equal(passesFlag(withLint, STRICT_FLAG), false);
    const withLintStrict = `${withLint}-strict`;
    assert.equal(passesFlag(withLintStrict, LINT_STRICT_FLAG), true);
    assert.equal(passesFlag(withLintStrict, '--lint'), false);
    assert.equal(passesFlag(`${withLint} ${STRICT_FLAG}`, STRICT_FLAG), true);
  });

  it('the shipped gate commands carry `--lint` and neither strict flag', () => {
    const commands = readGateCommands(
      (path) => readFileSync(join(ROOT, path), 'utf8'),
      PACKAGE_JSON_PATH,
      STRICT_WATCH_PLATFORMS.map((w) => w.script),
    );
    for (const [, command] of commands) {
      assert.ok(passesFlag(command, '--lint'), command);
      assert.equal(passesFlag(command, STRICT_FLAG), false, command);
      assert.equal(passesFlag(command, LINT_STRICT_FLAG), false, command);
    }
  });
});

// The watch covers a hand-maintained platform list, exactly like the relaxation
// kinds' field association: a corpus that grows a platform the list has not
// learned would leave that platform's gate unwatched and green.
describe('evaluateVerificationInventory — watched platforms vs the catalogue (both ways)', () => {
  it('fires when the catalogue carries a platform the watch has not learned', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ manifestPlatforms: ['extension', 'desktop-windows', 'desktop-linux'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('desktop-linux') && p.includes('has not learned')),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((p) => p.includes('STRICT_WATCH_PLATFORMS')),
      problems.join('\n'),
    );
  });

  it('fires when a watched platform has no session in the catalogue', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ manifestPlatforms: ['extension'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('desktop-windows') && p.includes('carries no session for')),
      problems.join('\n'),
    );
  });

  it('the shipped catalogue and the shipped watch cover the same platforms', () => {
    const platforms = readManifestPlatforms(
      (path) => readFileSync(join(ROOT, path), 'utf8'),
      MANIFEST_PATH,
    );
    assert.deepEqual([...platforms].sort(), STRICT_WATCH_PLATFORMS.map((w) => w.platform).sort());
  });

  it('reads the catalogue’s platforms distinctly, and refuses one it cannot read', () => {
    const at = (text) => () => text;
    assert.deepEqual(
      readManifestPlatforms(at('{"sessions":[{"platform":"a"},{"platform":"b"},{"platform":"a"}]}'), MANIFEST_PATH), // prettier-ignore
      ['a', 'b'],
    );
    assert.throws(
      () => readManifestPlatforms(at('{"sessions":[{"id":"x"}]}'), MANIFEST_PATH),
      (error) => {
        assert.ok(error instanceof InputError, `not an InputError: ${error}`);
        assert.match(error.message, /carries no string `platform`/);
        assert.match(error.message, /shape is what failed here/);
        return true;
      },
    );
  });
});

// A gate command that names a different platform or baseline than this check
// reads for it makes every verdict above a statement about a file the gate does
// not gate on — so both sides are named, whichever one moved.
describe('gate arguments — the commands name what this check reads', () => {
  it('reads the token after an argument, and nothing when there is none', () => {
    const command = 'node scripts/corpus-compare.js --platform extension --baseline b.json --lint';
    assert.equal(argumentValue(command, PLATFORM_ARG), 'extension');
    assert.equal(argumentValue(command, BASELINE_ARG), 'b.json');
    assert.equal(argumentValue(command, '--absent'), null);
    assert.equal(argumentValue('node x.js --baseline', BASELINE_ARG), null);
  });

  it('is green when every gate names exactly what the watch reads', () => {
    assert.deepEqual(
      gateArgumentProblems(makeSurface().strictWatch, SUFFICIENCY_BASELINE_PATH),
      [],
    );
  });

  it('reds on a repointed `--baseline`, naming the gate and what the watch reads', () => {
    const problems = gateArgumentProblems(
      [watchEntry({ baselineArg: 'corpus/known-diffs.desktop-windows.json' })],
      SUFFICIENCY_BASELINE_PATH,
    );
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.ok(problems[0].includes('corpus/known-diffs.desktop-windows.json'), problems[0]);
    assert.ok(problems[0].includes('corpus/known-diffs.extension.json'), problems[0]);
    assert.ok(problems[0].includes('npm run corpus:check'), problems[0]);
    assert.ok(problems[0].includes(BASELINE_ARG), problems[0]);
  });

  it('reds on a repointed `--platform`, and on the argument dropped entirely', () => {
    const repointed = gateArgumentProblems(
      [watchEntry({ platformArg: 'desktop-windows' })],
      SUFFICIENCY_BASELINE_PATH,
    );
    assert.equal(repointed.length, 1, repointed.join('\n'));
    assert.ok(repointed[0].includes(PLATFORM_ARG), repointed[0]);
    assert.ok(repointed[0].includes('desktop-windows') && repointed[0].includes('extension'), repointed[0]); // prettier-ignore

    const dropped = gateArgumentProblems(
      [watchEntry({ platformArg: null })],
      SUFFICIENCY_BASELINE_PATH,
    );
    assert.equal(dropped.length, 1, dropped.join('\n'));
    assert.ok(dropped[0].includes('passes nothing for'), dropped[0]);
  });

  it('reds when the sufficiency gate names a baseline this check does not read', () => {
    const problems = gateArgumentProblems(makeSurface().strictWatch, 'packages/shared/other.json');
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.ok(problems[0].includes(`npm run ${SUFFICIENCY_SCRIPT}`), problems[0]);
    assert.ok(problems[0].includes('packages/shared/other.json'), problems[0]);
    assert.ok(problems[0].includes(SUFFICIENCY_BASELINE_PATH), problems[0]);
  });

  it('a repointed gate reaches the evaluator, not only the leg', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({ strictWatch: [watchEntry({ baselineArg: 'corpus/elsewhere.json' })] }),
    );
    assert.ok(
      problems.some((p) => p.includes('corpus/elsewhere.json')),
      problems.join('\n'),
    );
  });

  it('the shipped gate commands name exactly the platform and baseline they are watched by', () => {
    const commands = readGateCommands(
      (path) => readFileSync(join(ROOT, path), 'utf8'),
      PACKAGE_JSON_PATH,
      [...STRICT_WATCH_PLATFORMS.map((w) => w.script), SUFFICIENCY_SCRIPT],
    );
    for (const { platform, script, baselinePath } of STRICT_WATCH_PLATFORMS) {
      const command = commands.get(script);
      assert.equal(argumentValue(command, PLATFORM_ARG), platform, command);
      assert.equal(argumentValue(command, BASELINE_ARG), baselinePath, command);
    }
    assert.equal(
      argumentValue(commands.get(SUFFICIENCY_SCRIPT), BASELINE_ARG),
      SUFFICIENCY_BASELINE_PATH,
      commands.get(SUFFICIENCY_SCRIPT),
    );
  });
});

describe('evaluateVerificationInventory — table selection is exactly one', () => {
  for (const [key, header, label] of [
    ['normalizationTableMatches', NORMALIZATION_TABLE_HEADER, 'normalization'],
    ['perActionTableMatches', PER_ACTION_TABLE_HEADER, 'per-action'],
    ['recordingTableMatches', RECORDING_TABLE_HEADER, 'recording-level'],
  ]) {
    it(`fires when the ${label} header tuple matches no table`, () => {
      const problems = evaluateVerificationInventory(makeSurface({ [key]: 0 }));
      assert.ok(problems.some((p) => p.includes(header.join(' | ')) && p.includes('exactly one')));
    });

    it(`fires when the ${label} header tuple matches two tables`, () => {
      const problems = evaluateVerificationInventory(makeSurface({ [key]: 2 }));
      assert.ok(problems.some((p) => p.includes(header.join(' | ')) && p.includes('exactly one')));
    });

    it(`is fail-closed when the ${label} surface states no count at all`, () => {
      // The `!== 1` form, pinned per key. A comparison that reads as its
      // opposite would no-op on every surface omitting the key, so a read that
      // answered nothing would pass here instead of reding.
      const surface = makeSurface();
      delete surface[key];
      assert.ok(
        evaluateVerificationInventory(surface).some(
          (p) => p.includes(header.join(' | ')) && p.includes('exactly one'),
        ),
        'a surface without the key must red',
      );
    });
  }
});

describe('evaluateVerificationInventory — unreadable surfaces are refused ahead of the diffs', () => {
  it('reports each unreadable family with its own diagnosis', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        relaxUnreadable: ['a prose bullet with no kind'],
        predicateUnreadable: ['per-action row first cell "two `names` here"'],
      }),
    );
    assert.ok(problems.some((p) => p.includes('a prose bullet with no kind')));
    assert.ok(problems.some((p) => p.includes('two `names` here') && p.includes('cannot read')));
  });
});

// Fixture rows for the duplicates family, keyed to the check's own exported
// DUPLICATE_SURFACES list. The lock below holds the two key sets equal, so a
// surface added to the check's loop without a fixture row reds here — the
// addition direction the per-leg tests alone cannot see.
const DUPLICATE_FIXTURES = {
  docKinds: ['match-stats', 'path', 'path'],
  docStatedKinds: ['match-stats', 'path', 'match-stats'],
  docNormalizationTokens: ['project_id', 'timestamp', 'project_id'],
  docSessionIds: ['d-click', 'd-redaction', 'd-click'],
  docPerAction: ['element-locators', 'key-nonempty', 'element-locators'],
  docRecording: ['context-introduced fail', 'start-point gap', 'context-introduced fail'],
};

describe('evaluateVerificationInventory — duplicates, every leg of the duplicates loop', () => {
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
      const problems = evaluateVerificationInventory(
        makeSurface({ [key]: DUPLICATE_FIXTURES[key] }),
      );
      assert.ok(
        problems.some((p) => p.includes('more than once') && p.includes(what)),
        problems.join('\n') || `no duplicates diagnostic for ${what}`,
      );
    });
  }
});

describe('evaluateVerificationInventory — empty parses are structural failures', () => {
  it('the export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, message]) => message);
    assert.equal(new Set(messages).size, messages.length);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateVerificationInventory(makeSurface({ [key]: [] }));
      assert.ok(
        problems.some((p) => p.includes(message)),
        problems.join('\n') || `no vacuous diagnostic for ${key}`,
      );
    });
  }
});

describe('topLevelListItems — item bounding', () => {
  const clause = [
    ' **Sidecar shape.** Intro prose that runs',
    'across two lines:',
    '',
    '- `first` — covers `alpha_one` and',
    '  `alpha_two`;',
    '- `second` — covers `beta_one` (and keeps `0` exact).',
    '',
    'A following paragraph naming `gamma_one` must not be absorbed.',
  ].join('\n');

  it('reads one item per top-level marker, joining its indented continuation', () => {
    assert.deepEqual(topLevelListItems(clause), [
      '`first` — covers `alpha_one` and `alpha_two`;',
      '`second` — covers `beta_one` (and keeps `0` exact).',
    ]);
  });

  it('the paragraph after the list stays outside the last item', () => {
    assert.ok(!topLevelListItems(clause).some((item) => item.includes('gamma_one')));
  });

  it('returns nothing for a clause with no list', () => {
    assert.deepEqual(topLevelListItems('plain prose only'), []);
  });
});

describe('extractRelaxationCoverage — kind and fields per item', () => {
  const doc = [
    '## Comparator and relaxations',
    '',
    '**STC-21.** **Sidecar shape.** Each kind alters exactly its covered fields:',
    '',
    '- `match-stats` — the entry’s `match_count` and `match_index`;',
    '- `scroll-amounts` — the nonzero values of `scroll_top` and',
    '  `delta_y` (the class map keeps `0` exact);',
    '',
    'A closing paragraph about `pointer` semantics.',
    '',
    '## Page-authoring rules',
  ].join('\n');

  it('takes the first backticked token as the kind and the rest as its fields', () => {
    const read = extractRelaxationCoverage(doc);
    assert.deepEqual(read.kinds, ['match-stats', 'scroll-amounts']);
    assert.deepEqual(new Map(read.fields).get('match-stats'), ['match_count', 'match_index']);
    assert.deepEqual(new Map(read.fields).get('scroll-amounts'), ['scroll_top', 'delta_y']);
    assert.deepEqual(read.unreadable, []);
  });

  it('reports an item that names no kind rather than skipping it', () => {
    const read = extractRelaxationCoverage(
      doc.replace(
        '- `match-stats` — the entry’s `match_count` and `match_index`;',
        '- prose only;',
      ),
    );
    assert.ok(read.unreadable.some((item) => item.includes('prose only')), JSON.stringify(read)); // prettier-ignore
  });

  it('reads nothing when the clause marker is absent', () => {
    assert.deepEqual(extractRelaxationCoverage('# no clauses here').kinds, []);
  });
});

describe('extractStatedKinds — §STC-5’s kind sentence', () => {
  /** A minimal §STC-5 shaped like the shipped clause: kinds sentenced alone. */
  const doc = (kinds = '`match-stats`, `scroll-amounts`, and `path`') =>
    [
      '**STC-5.** A session may carry an `overrides.json` sidecar of **relaxations**,',
      `and the comparator holds them to a closed contract. The relaxation kinds are`,
      `exactly ${kinds}. Sidecar pointers index the **truth** document, and the`,
      '`scroll-amounts` class map keeps `0` exact.',
      '',
      '**STC-21.** **Sidecar shape.** A later clause naming `match-stats` again.',
    ].join('\n');

  it('reads exactly the kinds of the anchored sentence', () => {
    const read = extractStatedKinds(doc());
    assert.deepEqual(read.kinds, ['match-stats', 'scroll-amounts', 'path']);
    assert.deepEqual(read.unreadableTokens, []);
  });

  it('takes nothing from outside that sentence — no allow-set is needed', () => {
    // `overrides.json` sits before it and the literal `0` after it; the
    // sentence bound is what keeps both out, so the duplicate guard over this
    // surface stays a plain one.
    const read = extractStatedKinds(doc());
    assert.ok(!read.kinds.includes('overrides.json'), read.kinds.join(','));
    assert.ok(!read.kinds.includes('0'), read.kinds.join(','));
    assert.equal(read.kinds.filter((k) => k === 'match-stats').length, 1);
  });

  it('finds the anchor whatever line the prose wraps on', () => {
    const wrapped = doc().replace('The relaxation kinds are\nexactly', 'The relaxation\nkinds are exactly'); // prettier-ignore
    assert.deepEqual(extractStatedKinds(wrapped).kinds, ['match-stats', 'scroll-amounts', 'path']);
  });

  it('refuses a token in the sentence the kind grammar cannot read', () => {
    const read = extractStatedKinds(doc('`match-stats`, `Scroll_Amounts`, and `path`'));
    assert.deepEqual(read.kinds, ['match-stats', 'path']);
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['Scroll_Amounts'],
    );
    const problems = evaluateVerificationInventory(
      makeSurface({ unreadableTokens: read.unreadableTokens }),
    );
    assert.ok(
      problems.some((p) => p.includes('Scroll_Amounts') && p.includes('lower-case with hyphens')),
      problems.join('\n'),
    );
  });

  it('reads nothing when the anchor phrase is gone — the vacuity guard takes it', () => {
    const moved = doc().replace('The relaxation kinds are\nexactly', 'The kinds are just');
    assert.deepEqual(extractStatedKinds(moved).kinds, []);
    const problems = evaluateVerificationInventory(makeSurface({ docStatedKinds: [] }));
    assert.ok(
      problems.some((p) => p.includes('no relaxation kinds found') && p.includes('STC-5')),
      problems.join('\n'),
    );
  });

  it('reads nothing when the clause marker is absent', () => {
    assert.deepEqual(extractStatedKinds('# no clauses here').kinds, []);
  });

  it('the shipped clause states exactly the comparator’s closed kind set', () => {
    const read = extractStatedKinds(readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8'));
    assert.deepEqual(read.unreadableTokens, []);
    assert.deepEqual([...read.kinds].sort(), [...RELAX_KINDS].sort());
  });

  it('a mutated kind list in the shipped clause reds — the leg is not vacuous', () => {
    const text = readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8');
    const stated = 'exactly `match-stats`, `scroll-amounts`, and `path`.';
    assert.ok(text.includes(stated), 'the mutation anchor moved');
    const read = extractStatedKinds(text.replace(stated, 'exactly `match-stats` and `path`.'));
    assert.deepEqual(read.kinds, ['match-stats', 'path']);
    const problems = evaluateVerificationInventory(
      makeSurface({ docStatedKinds: read.kinds, codeKinds: [...RELAX_KINDS] }),
    );
    assert.ok(
      problems.some((p) => p.includes('scroll-amounts') && p.includes('kind sentence does not state')), // prettier-ignore
      problems.join('\n'),
    );
  });
});

describe('extractStatedOutcome — §STC-23’s shipping outcome', () => {
  /** A minimal §STC-23 shaped like the shipped clause: the whole section read. */
  const doc = (
    sentence = 'Only vectors whose `expected_outcome` is `resolved` ship: every committed vector MUST state that outcome.', // prettier-ignore
  ) =>
    [
      `**STC-23.** ${sentence}`,
      '',
      '### Emission',
      '',
      'A later section naming `not-resolved` outside the clause.',
    ].join('\n');

  it('bins the clause’s tokens by the field this check reads the meta-schema under', () => {
    const read = extractStatedOutcome(doc());
    assert.deepEqual(read.fields, [OUTCOME_FIELD]);
    assert.deepEqual(read.outcomes, ['resolved']);
    assert.deepEqual(read.unreadableTokens, []);
  });

  it('takes nothing from outside the clause’s own section', () => {
    assert.ok(!extractStatedOutcome(doc()).outcomes.includes('not-resolved'));
  });

  it('binds the two roles by that constant, never by where a token sits', () => {
    // The equivalent reword: the same tokens, the other order. A positional
    // rule would read the outcome as the field and red a document that says
    // exactly what the shipped one says.
    const read = extractStatedOutcome(
      doc('Every committed vector MUST state the outcome `resolved`, under `expected_outcome`.'),
    );
    assert.deepEqual(read.fields, [OUTCOME_FIELD]);
    assert.deepEqual(read.outcomes, ['resolved']);
    assert.deepEqual(
      evaluateVerificationInventory(
        makeSurface({ docOutcomeFields: read.fields, docOutcomes: read.outcomes }),
      ),
      [],
    );
  });

  it('collapses a repeat, so a sibling sentence naming the outcome again is prose', () => {
    const twice = doc(
      'Only vectors whose `expected_outcome` is `resolved` ship. A vector stating anything but `resolved` is outside the shipped set.', // prettier-ignore
    );
    assert.deepEqual(extractStatedOutcome(twice).outcomes, ['resolved']);
  });

  it('refuses a token the outcome grammar cannot read rather than dropping it', () => {
    const read = extractStatedOutcome(
      doc('Only vectors whose `expected_outcome` is `Resolved_OK` ship.'),
    );
    assert.deepEqual(read.outcomes, []);
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['Resolved_OK'],
    );
    const problems = evaluateVerificationInventory(
      makeSurface({ unreadableTokens: read.unreadableTokens }),
    );
    assert.ok(
      problems.some((p) => p.includes('Resolved_OK') && p.includes('lower-case hyphenated token')),
      problems.join('\n'),
    );
  });

  it('reads nothing when the clause marker is absent', () => {
    const read = extractStatedOutcome('# no clauses here');
    assert.deepEqual(read.fields, []);
    assert.deepEqual(read.outcomes, []);
  });

  it('the shipped clause and the shipped meta-schema state the same outcome', () => {
    const read = extractStatedOutcome(readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8'));
    const schema = readVectorOutcome(
      (path) => readFileSync(join(ROOT, path), 'utf8'),
      VECTOR_SCHEMA_PATH,
    );
    assert.deepEqual(read.unreadableTokens, []);
    assert.deepEqual(read.fields, [OUTCOME_FIELD]);
    assert.deepEqual(read.outcomes, [schema.outcome]);
    assert.equal(schema.required, true);
  });

  it('a mutated outcome in the shipped clause reds — the leg is not vacuous', () => {
    const text = readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8');
    const stated = 'is `resolved` ship';
    assert.ok(text.includes(stated), 'the mutation anchor moved');
    const read = extractStatedOutcome(text.replace(stated, 'is `matched` ship'));
    assert.deepEqual(read.outcomes, ['matched']);
    const problems = evaluateVerificationInventory(makeSurface({ docOutcomes: read.outcomes }));
    assert.ok(
      problems.some((p) => p.includes('`matched`') && p.includes(VECTOR_SCHEMA_PATH)),
      problems.join('\n'),
    );
  });
});

describe('evaluateVerificationInventory — the shipping outcome, both ways', () => {
  it('fires when the clause states an outcome the meta-schema does not', () => {
    const problems = evaluateVerificationInventory(makeSurface({ docOutcomes: ['matched'] }));
    assert.ok(
      problems.some((p) => p.includes('`matched`') && p.includes('does not state under')),
      problems.join('\n'),
    );
  });

  it('fires when the meta-schema states one the clause does not', () => {
    const problems = evaluateVerificationInventory(makeSurface({ schemaOutcomes: ['matched'] }));
    assert.ok(
      problems.some((p) => p.includes('`matched`') && p.includes(`§${OUTCOME_CLAUSE_ID} does not state`)), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('a clause that renamed the field is drift naming both surfaces, never machinery', () => {
    // The escape a schema lookup keyed by the DOCUMENT's token would take: it
    // would refuse the meta-schema, which never moved, and exit on the
    // machinery verdict instead of naming the two surfaces that disagree.
    const problems = evaluateVerificationInventory(makeSurface({ docOutcomeFields: [] }));
    const named = problems.filter((p) => p.includes(OUTCOME_FIELD) && p.includes(OUTCOME_CLAUSE_ID)); // prettier-ignore
    assert.equal(named.length, 1, problems.join('\n'));
    assert.ok(named[0].includes(VECTOR_SCHEMA_PATH), named[0]);
    assert.ok(!named[0].includes('shape is what failed here'), named[0]);
  });

  it('fires when the meta-schema stops requiring the field of every vector', () => {
    const problems = evaluateVerificationInventory(makeSurface({ schemaRequiresOutcome: false }));
    assert.ok(
      problems.some((p) => p.includes('does not require') && p.includes(OUTCOME_FIELD)),
      problems.join('\n'),
    );
  });

  it('is fail-closed when the surface states no required membership at all', () => {
    // The treatment the table and heading count guards take: a surface omitting
    // the key hands `undefined` — not the required membership — so a read that
    // answered nothing reds rather than passing over as a requiring meta-schema.
    const surface = makeSurface();
    delete surface.schemaRequiresOutcome;
    assert.ok(
      evaluateVerificationInventory(surface).some((p) => p.includes('does not require')),
      'a surface without the key must red',
    );
  });
});

describe('readVectorOutcome — the meta-schema side, keyed by this check’s constant', () => {
  const reader = (text) => (path) => {
    if (path !== VECTOR_SCHEMA_PATH) throw new InputError(`${path} could not be read`);
    return text;
  };
  const schema = (properties, required = [OUTCOME_FIELD]) =>
    JSON.stringify({ required, properties });

  it('reads the stated outcome and the required membership', () => {
    const read = readVectorOutcome(
      reader(schema({ [OUTCOME_FIELD]: { const: 'resolved' } })),
      VECTOR_SCHEMA_PATH,
    );
    assert.deepEqual(read, { outcome: 'resolved', required: true });
  });

  it('reads a meta-schema that lists the field nowhere in `required` as not requiring it', () => {
    const read = readVectorOutcome(
      reader(schema({ [OUTCOME_FIELD]: { const: 'resolved' } }, ['vector_id'])),
      VECTOR_SCHEMA_PATH,
    );
    assert.equal(read.required, false);
  });

  for (const [label, text, expected] of [
    ['unparseable', '{ "properties": ', /is not parseable JSON/],
    ['no properties object', '{"properties": []}', /carries no `properties` object/],
    ['no such property', '{"properties": {"vector_id": {}}}', /carries no `properties\.expected_outcome` object/], // prettier-ignore
    ['no const', '{"properties": {"expected_outcome": {"type": "string"}}}', /states no `const` outcome/], // prettier-ignore
    ['a blank const', '{"properties": {"expected_outcome": {"const": "  "}}}', /states no `const` outcome/], // prettier-ignore
  ]) {
    it(`refuses ${label} as machinery, naming the meta-schema`, () => {
      assert.throws(
        () => readVectorOutcome(reader(text), VECTOR_SCHEMA_PATH),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, expected);
          assert.ok(error.message.includes(VECTOR_SCHEMA_PATH), error.message);
          // The verdict a meta-schema this check cannot read must never take.
          assert.doesNotMatch(error.message, /does not state/);
          return true;
        },
      );
    });
  }
});

/** A minimal document whose normalization table sits under §STC-19, as shipped. */
const normalizationDoc = () =>
  [
    '**STC-19.** Comparison is normalized.',
    '',
    '| Class | Rule |',
    '| --- | --- |',
    '| identifiers (`project_id`, `recording_id`) | ordinal placeholders |',
    '| coordinate-mode `selector` (`coord:x,y`) | point placeholder |',
  ].join('\n');

describe('readFieldTokens / selectTableByHeader / extractNormalizationTokens', () => {
  it('keeps field-shaped tokens and allows the scope’s own literals', () => {
    const read = readFieldTokens(
      '`x`/`y`; non-null `window_rect` (`coord:x,y`)',
      NORMALIZATION_LITERALS,
    );
    assert.deepEqual(read.fields, ['x', 'y', 'window_rect']);
    assert.deepEqual(read.unreadable, []);
  });

  it('skips the leading tokens another grammar already read', () => {
    const read = readFieldTokens('`scroll-amounts` — `scroll_top` and `0`', RELAXATION_LITERALS, 1);
    assert.deepEqual(read.fields, ['scroll_top']);
    assert.deepEqual(read.unreadable, []);
  });

  it('selects on the whole header tuple, and refuses an ambiguous document', () => {
    const one = ['| Class | Rule |', '| --- | --- |', '| `a_field` | r |'].join('\n');
    assert.equal(selectTableByHeader(one, ['Class', 'Rule']).matches, 1);
    // A sibling table sharing only the first header cell is never conscripted.
    const sibling = [one, '', '| Class | Meaning |', '| --- | --- |', '| `b_field` | m |'].join('\n'); // prettier-ignore
    assert.equal(selectTableByHeader(sibling, ['Class', 'Rule']).matches, 1);
    const twice = [one, '', one].join('\n');
    assert.equal(selectTableByHeader(twice, ['Class', 'Rule']).matches, 2);
    assert.equal(selectTableByHeader(twice, ['Class', 'Rule']).table, null);
  });

  it('reads the Class column’s field tokens from the one matching table', () => {
    const read = extractNormalizationTokens(normalizationDoc());
    assert.equal(read.matches, 1);
    assert.deepEqual(read.tokens, ['project_id', 'recording_id', 'selector']);
  });

  it('reads the table only inside §STC-19’s own section', () => {
    // The attribution this check prints ("§STC-19's Class cell") is only true
    // while the table is read from under that clause. A table that moved out
    // must come back as zero matches, not be read from wherever it landed.
    const moved = normalizationDoc().replace('**STC-19.** Comparison is normalized.\n\n', '');
    assert.equal(extractNormalizationTokens(moved).matches, 0);
    assert.deepEqual(extractNormalizationTokens(moved).tokens, []);

    // …and a same-shaped table under a later clause is not conscripted either.
    const elsewhere = [
      normalizationDoc(),
      '',
      '**STC-20.** Order of operations.',
      '',
      '| Class | Rule |',
      '| --- | --- |',
      '| `imposter_field` | not §STC-19’s |',
    ].join('\n');
    const read = extractNormalizationTokens(elsewhere);
    assert.equal(read.matches, 1);
    assert.ok(!read.tokens.includes('imposter_field'), read.tokens.join(','));
  });
});

describe('extractSessionIds / extractPredicateTables / extractJobCites', () => {
  it('reads the session ids of the catalogue clause only', () => {
    const doc = [
      '**STC-22.** Each session pins one behaviour: `d-click`, `d-type-edit`.',
      '',
      '## Elsewhere',
      '',
      'An unrelated mention of `d-not-a-session`.',
    ].join('\n');
    const read = extractSessionIds(doc);
    assert.deepEqual(read.ids, ['d-click', 'd-type-edit']);
    assert.deepEqual(read.unreadableTokens, []);
  });

  it('refuses a session token that misses the grammar rather than dropping it', () => {
    // Dropped, these produced the inverted diagnosis: the manifest-side diff
    // would report the session as one the clause "does not enumerate", when the
    // clause names it and only the spelling is off.
    const doc = [
      '**STC-22.** Each session pins one behaviour: `d-click`, `d-Type-Edit`,',
      '`d-scroll-floor2`.',
    ].join('\n');
    const read = extractSessionIds(doc);
    assert.deepEqual(read.ids, ['d-click']);
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['d-Type-Edit', 'd-scroll-floor2'],
    );
    const problems = evaluateVerificationInventory(
      makeSurface({ unreadableTokens: read.unreadableTokens }),
    );
    assert.ok(
      problems.some((p) => p.includes('d-Type-Edit') && p.includes('session ids there are')),
      problems.join('\n'),
    );
  });

  it('the shipped catalogue clause carries no unreadable session token', () => {
    const read = extractSessionIds(readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8'));
    assert.deepEqual(read.unreadableTokens, []);
    assert.ok(read.ids.length > 0);
  });

  it('reads both predicate tables and refuses an unreadable cell', () => {
    const doc = [
      '| Predicate | Applies to | Requires |',
      '| --- | --- | --- |',
      '| `element-locators` | elements | one candidate |',
      '',
      '| Predicate | Class | States |',
      '| --- | --- | --- |',
      '| `start-point` | `gap` | where reproduction begins |',
      '| two `names` here | `fail` | unreadable |',
    ].join('\n');
    const read = extractPredicateTables(doc);
    assert.deepEqual(read.perAction, ['element-locators']);
    assert.equal(read.perActionMatches, 1);
    assert.deepEqual(read.recording, ['start-point gap']);
    assert.equal(read.recordingMatches, 1);
    assert.ok(read.unreadable.some((cell) => cell.includes('two `names` here')));
  });

  it('reads job citations from live text and never from a fenced example', () => {
    const doc = [
      'Produced by the `extension-e2e-tests` job and diffed there.',
      '',
      '```text',
      'the `imaginary-job` job would print here',
      '```',
    ].join('\n');
    assert.deepEqual(extractJobCites(doc), ['extension-e2e-tests']);
  });
});

describe('extractPerActionClass — the class the lint document’s heading states', () => {
  const doc = (heading = '### Per-action predicates (all `fail` class)') =>
    [
      heading,
      '',
      '| Predicate | Applies to | Requires |',
      '| --- | --- | --- |',
      '| `element-locators` | elements | one candidate |',
    ].join('\n');

  it('reads the class out of the one heading that states it', () => {
    assert.deepEqual(extractPerActionClass(doc()), {
      klass: 'fail',
      matches: 1,
      unreadableTokens: [],
    });
  });

  it('reads a heading stating another class rather than missing the claim', () => {
    const read = extractPerActionClass(doc('### Per-action predicates (all `gap` class)'));
    assert.equal(read.klass, 'gap');
    const problems = evaluateVerificationInventory(makeSurface({ docPerActionClass: read.klass }));
    assert.ok(
      problems.some((p) => p.includes('`gap`') && p.includes(PER_ACTION_CLASS) && p.includes('per-action heading')), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('counts a document stating that class in no heading, rather than passing over it', () => {
    assert.deepEqual(extractPerActionClass(doc('### Per-action predicates')), {
      klass: null,
      matches: 0,
      unreadableTokens: [],
    });
    const problems = evaluateVerificationInventory(
      makeSurface({ docPerActionClass: null, perActionHeadingMatches: 0 }),
    );
    assert.ok(
      problems.some((p) => p.includes('0 heading(s)') && p.includes('exactly one')),
      problems.join('\n'),
    );
  });

  it('refuses a document stating it twice rather than reading whichever came first', () => {
    const read = extractPerActionClass(
      [doc(), '', '### Per-action predicates (all `gap` class)'].join('\n'),
    );
    assert.equal(read.matches, 2);
    assert.equal(read.klass, null);
    const problems = evaluateVerificationInventory(
      makeSurface({ docPerActionClass: null, perActionHeadingMatches: 2 }),
    );
    assert.ok(
      problems.some((p) => p.includes('2 heading(s)') && p.includes('exactly one')),
      problems.join('\n'),
    );
  });

  it('never reads a heading written inside an illustrative fence', () => {
    const fenced = [doc(), '', '```md', '### Per-action predicates (all `gap` class)', '```'].join('\n'); // prettier-ignore
    const read = extractPerActionClass(fenced);
    assert.equal(read.matches, 1);
    assert.equal(read.klass, 'fail');
  });

  it('refuses an unbackticked class, and shows the fragment as the heading writes it', () => {
    // The evidence is the whole finding here: a fragment the renderer wrapped in
    // backticks of its own would show an unbackticked class as `fail` — exactly
    // the one lower-case backticked token the expectation beside it asks for, so
    // the line would read as a heading that satisfies it being refused anyway.
    const read = extractPerActionClass(doc('### Per-action predicates (all fail class)'));
    assert.equal(read.klass, null);
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['fail'],
    );
    const problems = evaluateVerificationInventory(
      makeSurface({ unreadableTokens: read.unreadableTokens }),
    );
    const named = problems.filter((p) => p.includes('one lower-case backticked token'));
    assert.equal(named.length, 1, problems.join('\n'));
    assert.ok(named[0].includes('per-action heading carries fail,'), named[0]);
    assert.ok(!named[0].includes('carries `fail`'), named[0]);
  });

  for (const [label, stated] of [
    ['a backticked class the grammar refuses', '`Fail`'],
    ['a heading stating more than one token', '`fail` `gap`'],
  ]) {
    it(`refuses ${label}, showing its own backticks once`, () => {
      const read = extractPerActionClass(doc(`### Per-action predicates (all ${stated} class)`));
      assert.equal(read.klass, null);
      const problems = evaluateVerificationInventory(
        makeSurface({ unreadableTokens: read.unreadableTokens }),
      );
      const named = problems.filter((p) => p.includes('one lower-case backticked token'));
      assert.equal(named.length, 1, problems.join('\n'));
      assert.ok(named[0].includes(`carries ${stated},`), named[0]);
      // A re-wrapped fragment renders its delimiters doubled, which is unreadable
      // as evidence: the reader cannot tell what the heading actually states.
      assert.ok(!named[0].includes('``'), named[0]);
    });
  }

  it('is fail-closed when the surface states no heading count at all', () => {
    // The `!== 1` form, as on the table counts: a surface omitting the key
    // hands the guard `undefined`, which is not 1, so a read that answered
    // nothing reds here instead of passing over.
    const surface = makeSurface();
    delete surface.perActionHeadingMatches;
    assert.ok(
      evaluateVerificationInventory(surface).some((p) => p.includes('exactly one')),
      'a surface without the key must red',
    );
  });

  it('a surface stating no class reads as one the scan did not read, never as `undefined`', () => {
    const surface = makeSurface();
    delete surface.docPerActionClass;
    assert.ok(
      !evaluateVerificationInventory(surface).some((p) => p.includes('undefined')),
      'the class finding must not render an absent read',
    );
  });

  it('the shipped document states this check’s own per-action class', () => {
    const read = extractPerActionClass(readFileSync(join(ROOT, LINT_DOC_PATH), 'utf8'));
    assert.equal(read.matches, 1);
    assert.equal(read.klass, PER_ACTION_CLASS);
    assert.deepEqual(read.unreadableTokens, []);
  });

  it('a mutated heading in the shipped document reds — the leg is not vacuous', () => {
    const text = readFileSync(join(ROOT, LINT_DOC_PATH), 'utf8');
    const stated = '### Per-action predicates (all `fail` class)';
    assert.ok(text.includes(stated), 'the mutation anchor moved');
    const read = extractPerActionClass(
      text.replace(stated, '### Per-action predicates (all `gap` class)'),
    );
    const problems = evaluateVerificationInventory(makeSurface({ docPerActionClass: read.klass }));
    assert.ok(
      problems.some((p) => p.includes('states its predicates are all `gap` class')),
      problems.join('\n'),
    );
  });
});

// Which documents the citation leg scans is a declared decision, not a pair
// written into the call — and the suite is where that decision is forced to
// stay true of the tree.
describe('the citation leg’s scanned set is declared', () => {
  it('the declared set is exactly the tracked verification documents', () => {
    assert.deepEqual(
      [...CITED_JOB_DOCUMENTS].sort(),
      trackedFilesUnder('docs/verification', { extensions: ['.md'], cwd: ROOT }).sort(),
    );
  });

  it('the deliberately unscanned document is outside it', () => {
    // The check's own header names it: it cites no job, so an empty extraction
    // there could not tell a broken scan from a document that never cited.
    assert.ok(!CITED_JOB_DOCUMENTS.includes('docs/requirements/replay-sufficiency.md'));
  });

  it('the leg reads whatever list it is handed, one entry per document', () => {
    const cites = documentCitations(
      ['a.md', 'b.md', 'c.md'],
      (path) => `Produced by the \`${path.replace('.md', '')}-job\` job.`,
    );
    assert.deepEqual(cites, [
      { path: 'a.md', cites: ['a-job'] },
      { path: 'b.md', cites: ['b-job'] },
      { path: 'c.md', cites: ['c-job'] },
    ]);
  });

  it('every declared document of the shipped tree cites a job', () => {
    const cites = documentCitations(CITED_JOB_DOCUMENTS, (path) =>
      readFileSync(join(ROOT, path), 'utf8'),
    );
    assert.equal(cites.length, CITED_JOB_DOCUMENTS.length);
    for (const { path, cites: found } of cites) assert.ok(found.length > 0, `${path} cites no job`);
  });
});

describe('unreadable backticked tokens are refused, never dropped', () => {
  it('a camelCase token in a scanned Class cell reds instead of shrinking the scan', () => {
    const doc = normalizationDoc().replace('`recording_id`', '`matchCount`');
    const read = extractNormalizationTokens(doc);
    assert.deepEqual(read.tokens, ['project_id', 'selector']); // matchCount did not vanish into these
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['matchCount'],
    );
    const problems = evaluateVerificationInventory(
      makeSurface({ unreadableTokens: read.unreadableTokens }),
    );
    assert.ok(
      problems.some((p) => p.includes('matchCount') && p.includes('lower-case with underscores')),
      problems.join('\n'),
    );
    // Pins the wrap side of the render contract: a bare token renders backticked.
    assert.ok(problems.some((p) => p.includes('carries `matchCount`,')), problems.join('\n')); // prettier-ignore
  });

  it('a digit-bearing field name reds rather than vanishing from a kind’s coverage', () => {
    const doc = [
      '**STC-21.** **Sidecar shape.** Each kind alters exactly its covered fields:',
      '',
      '- `scroll-amounts` — the nonzero values of `scroll_top` and `delta_y2`',
      '  (the class map keeps `0` exact);',
    ].join('\n');
    const read = extractRelaxationCoverage(doc);
    assert.deepEqual(new Map(read.fields).get('scroll-amounts'), ['scroll_top']);
    assert.deepEqual(
      read.unreadableTokens.map((u) => u.token),
      ['delta_y2'],
    );
    assert.ok(read.unreadableTokens[0].where.includes('scroll-amounts'));
  });

  it('the shipped document’s own shapes carry no unreadable token', () => {
    const text = readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8');
    assert.deepEqual(extractRelaxationCoverage(text).unreadableTokens, []);
    assert.deepEqual(extractNormalizationTokens(text).unreadableTokens, []);
  });

  it('each allowance is load-bearing — its literal reds where the scope does not allow it', () => {
    for (const literal of [...RELAXATION_LITERALS, ...NORMALIZATION_LITERALS]) {
      assert.deepEqual(
        readFieldTokens(`a field \`some_field\` beside \`${literal}\``, new Set()).unreadable,
        [literal],
      );
    }
  });
});

describe('the check’s own code-side association', () => {
  it('carries a field list for every kind, none of them empty', () => {
    assert.ok(CODE_RELAXATION_FIELDS.size > 0);
    for (const [kind, fields] of CODE_RELAXATION_FIELDS) {
      assert.ok(Array.isArray(fields) && fields.length > 0, `no fields listed for ${kind}`);
    }
  });

  it('flattens the comparator’s class map into distinct field tokens', () => {
    assert.ok(CODE_NORMALIZATION_TOKENS.length > 0);
    assert.equal(new Set(CODE_NORMALIZATION_TOKENS).size, CODE_NORMALIZATION_TOKENS.length);
  });
});

// The strict-flip watch's three new reads. Each is a file whose truncation or
// emptying would read as "the trigger came true", so each way it can fail gets
// its own words and the machinery verdict, never a flip demand.
describe('strict-watch readers — a broken input is never a flipped trigger', () => {
  /** An in-memory tree reader; a path with no entry reads as unreadable. */
  const reader = (files) => (path) => {
    if (!(path in files)) throw new InputError(`${path} could not be read — no such entry`);
    return files[path];
  };
  const KD = 'corpus/known-diffs.extension.json';
  const at = (text) => reader({ [KD]: text });

  it('reads emptiness only from a baseline that covers every active session', () => {
    assert.deepEqual(readKnownDiffsBaseline(at('{"a": [], "b": []}'), KD, ['a', 'b']), {
      empty: true,
      carrying: [],
    });
    assert.deepEqual(readKnownDiffsBaseline(at('{"a": [], "b": ["x"]}'), KD, ['a', 'b']), {
      empty: false,
      carrying: ['b'],
    });
  });

  it('returns the sessions still carrying a diff, so the verdict can name them', () => {
    // The read a diagnosis stands on: emptiness alone leaves "still carries a
    // known diff" pointing at a file of per-session lists to search by hand.
    const read = readKnownDiffsBaseline(at('{"a": ["x"], "b": [], "c": ["y", "z"]}'), KD, ['a']);
    assert.equal(read.empty, false);
    assert.deepEqual(read.carrying, ['a', 'c']);
  });

  for (const [label, text, expected] of [
    ['unparseable', '{ "a": [', /is not parseable JSON/],
    ['not an object', '[]', /is not a JSON object of per-session entry lists/],
    ['keyless', '{}', /carries no session keys at all/],
    ['a non-array entry', '{"a": "x"}', /its `a` entry is not an array/],
  ]) {
    it(`refuses ${label} known-diffs input as machinery, naming the baseline`, () => {
      assert.throws(
        () => readKnownDiffsBaseline(at(text), KD, ['a']),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, expected);
          assert.ok(error.message.includes(KD), error.message);
          // The verdict a truncated baseline must never take.
          assert.doesNotMatch(error.message, /wires `--strict`/);
          return true;
        },
      );
    });
  }

  it('refuses a short-keyed known-diffs baseline naming the uncovered sessions', () => {
    assert.throws(
      () => readKnownDiffsBaseline(at('{"a": []}'), KD, ['a', 'b', 'c']),
      (error) => {
        assert.match(error.message, /carries no key for active session\(s\) b, c/);
        assert.match(error.message, /shape is what failed here/);
        return true;
      },
    );
  });

  const SB = SUFFICIENCY_BASELINE_PATH;
  const sb = (text) => reader({ [SB]: text });
  const truthKey = (id) => `corpus/sessions/${id}/truth.docent.json`;

  it('returns the parsed sufficiency baseline once it covers every active session', () => {
    const text = JSON.stringify({
      [truthKey('a')]: [],
      'packages/shared/tests/f.json': ['fail:x'],
    });
    assert.deepEqual(readSufficiencyBaseline(sb(text), SB, ['a']), JSON.parse(text));
  });

  for (const [label, text, expected] of [
    ['unparseable', '{ "a": [', /is not parseable JSON/],
    ['not an object', '[]', /is not a JSON object of per-file finding lists/],
    ['keyless', '{}', /carries no file keys at all/],
    ['a non-array entry', '{"k": 3}', /its `k` entry is not an array of findings/],
    ['a non-string finding', '{"k": [3]}', /its `k` entry carries a non-string finding/],
  ]) {
    it(`refuses ${label} sufficiency-baseline input as machinery`, () => {
      assert.throws(
        () => readSufficiencyBaseline(sb(text), SB, []),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, expected);
          assert.ok(error.message.includes(SB), error.message);
          return true;
        },
      );
    });
  }

  it('refuses a short-keyed sufficiency baseline naming the uncovered sessions', () => {
    assert.throws(
      () => readSufficiencyBaseline(sb(JSON.stringify({ [truthKey('a')]: [] })), SB, ['a', 'b']),
      (error) => {
        assert.match(error.message, /carries no `corpus\/sessions\/` entry for active session\(s\) b/); // prettier-ignore
        assert.match(error.message, /shape is what failed here/);
        return true;
      },
    );
  });

  it('names ACTIVE sessions’ truth keys only, once each, and never a frozen fixture’s', () => {
    const baseline = {
      [truthKey('active-one')]: ['fail:element-locators rec[0]', 'fail:key-nonempty rec[1]', 'gap:start-point rec[0]'], // prettier-ignore
      [truthKey('active-two')]: ['gap:start-point rec[0]'],
      [truthKey('retired-one')]: ['fail:element-locators rec[0]'],
      'packages/shared/tests/fixtures/extension/v3.0.0.docent.json': ['fail:element-locators rec[0]'], // prettier-ignore
    };
    // One truth file carrying several fail findings names once — the diagnosis
    // names files to open, not the findings inside them — and a truth carrying
    // none is not holding the trigger shut at all.
    assert.deepEqual(corpusFailKeys(baseline, ['active-one', 'active-two']), [truthKey('active-one')]); // prettier-ignore
    // A retired session's truth stays on disk and in the ledger by §STC-14;
    // unfiltered, its entry would hold the trigger shut forever.
    assert.deepEqual(corpusFailKeys(baseline, ['other']), []);
    assert.deepEqual(corpusFailKeys(baseline, ['active-one', 'retired-one']), [
      truthKey('active-one'),
      truthKey('retired-one'),
    ]);
  });

  const PKG = PACKAGE_JSON_PATH;
  const pkg = (text) => reader({ [PKG]: text });

  it('reads the named gate commands out of the scripts map', () => {
    const text = JSON.stringify({ scripts: { 'corpus:check': 'node x --lint', other: 'y' } });
    assert.deepEqual(
      [...readGateCommands(pkg(text), PKG, ['corpus:check'])],
      [['corpus:check', 'node x --lint']],
    );
  });

  for (const [label, text, expected] of [
    ['unparseable', '{ "scripts": ', /is not parseable JSON/],
    ['no scripts object', '{"scripts": []}', /carries no `scripts` object/],
    ['a missing script', '{"scripts": {}}', /defines no `corpus:check` command/],
    ['a non-string command', '{"scripts": {"corpus:check": 3}}', /defines no `corpus:check` command/], // prettier-ignore
    ['a blank command', '{"scripts": {"corpus:check": "  "}}', /defines no `corpus:check` command/],
  ]) {
    it(`refuses ${label} in the package manifest as machinery`, () => {
      assert.throws(
        () => readGateCommands(pkg(text), PKG, ['corpus:check']),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, expected);
          assert.ok(error.message.includes(PKG), error.message);
          return true;
        },
      );
    });
  }
});

// The job ids come from a file this check reads, so a workflow the shared scan
// cannot anchor in is that file failing, not an inventory drifting. The
// classification sits on this check's side of the shared call, which is why the
// vocabulary it keys on is pinned here.
describe('the workflow anchor is an input this check reads', () => {
  const deAnchor = (yaml) => yaml.replace(/^jobs:/m, '# jobs:');

  it('the shared extractor states the anchor problem in the words this check matches', () => {
    const workflow = readFileSync(join(ROOT, TEST_WORKFLOW_PATH), 'utf8');
    const read = extractJobIds(deAnchor(workflow));
    assert.deepEqual(read.ids, []);
    assert.equal(read.problems.length, 1, read.problems.join('\n'));
    assert.ok(read.problems[0].includes(JOB_ANCHOR_PROBLEM), read.problems[0]);
    assert.ok(read.problems[0].includes(TEST_WORKFLOW_PATH), read.problems[0]);

    // An anchored workflow with no job keys is a different fact: the extractor
    // reports no problem at all, so that emptiness stays the vacuity leg's.
    assert.deepEqual(extractJobIds(['jobs:', '', 'name: t'].join('\n')), { ids: [], problems: [] });
  });

  it('auditTree refuses a de-anchored workflow as an input, once, naming it', () => {
    const readFile = (path) =>
      path === TEST_WORKFLOW_PATH
        ? deAnchor(readFileSync(join(ROOT, path), 'utf8'))
        : readTreeFile(join(ROOT, path));
    assert.throws(
      () => auditTree(readFile, (platform) => listActiveSessions(platform, join(ROOT, MANIFEST_PATH))), // prettier-ignore
      (error) => {
        assert.ok(error instanceof InputError, `not an InputError: ${error}`);
        assert.ok(error.message.includes(JOB_ANCHOR_PROBLEM), error.message);
        // The duplicate the reclassification dissolves: the same fact reported
        // again as an inventory that came back empty.
        assert.doesNotMatch(error.message, /no job ids found/);
        return true;
      },
    );
  });
});

describe('command-line readers — an unreadable input is never an empty inventory', () => {
  it('a malformed manifest fails loudly naming the file, not as an empty session catalogue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, '{ "sessions": [ ');
    try {
      assert.throws(
        () => listActiveSessions('desktop-windows', manifest),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.ok(error.message.includes(manifest), error.message);
          // The drift diagnosis this must never be mistaken for.
          assert.ok(!error.message.includes('no active'), error.message);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a manifest that parses but carries no sessions array gets its own words', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, '{ "sessions": {} }');
    try {
      assert.throws(
        () => listActiveSessions('desktop-windows', manifest),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, /carries no `sessions` array/);
          // Shape, not readability — the file read and parsed perfectly well.
          assert.doesNotMatch(error.message, /could not be read|not parseable/);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed session entry takes the shape verdict, whichever way it would escape', () => {
    // Two routes, one verdict. A missing `id` fell through to the discovery
    // walk and left as a TypeError — the drift exit code, and a stack instead
    // of a diagnosis. A missing `platform` never raised at all: the walk
    // filters on it, so the entry silently dropped, and with one entry in the
    // manifest the catalogue came back EMPTY — routing to the vacuity
    // diagnosis against the manifest. Still the wrong verdict class for a
    // malformed file, which is why the shape guard takes it first.
    for (const [missing, entry] of [
      ['id', { platform: 'desktop-windows' }],
      ['platform', { id: 'd-click' }],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
      const manifest = join(dir, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ sessions: [entry] }));
      try {
        assert.throws(
          () => listActiveSessions('desktop-windows', manifest),
          (error) => {
            assert.ok(error instanceof InputError, `not an InputError for ${missing}: ${error}`);
            assert.match(error.message, /shape is what failed here/);
            assert.match(error.message, new RegExp(`sessions\\[0\\]\` entry carries no string \`${missing}\``)); // prettier-ignore
            assert.doesNotMatch(error.message, /could not be read|not parseable/);
            return true;
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('a non-string truth or overrides takes the shape verdict too', () => {
    // The other keys the discovery walk path-joins. No spawned leg here: the
    // malformed-entry case below already pins that these reach the CLI as the
    // machinery verdict — what is new is only which keys are covered.
    for (const [key, entry] of [
      ['truth', { id: 'd-click', platform: 'desktop-windows', truth: 5 }],
      ['overrides', { id: 'd-click', platform: 'desktop-windows', overrides: 5 }],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
      const manifest = join(dir, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ sessions: [entry] }));
      try {
        assert.throws(
          () => listActiveSessions('desktop-windows', manifest),
          (error) => {
            assert.ok(error instanceof InputError, `not an InputError for ${key}: ${error}`);
            assert.match(error.message, /shape is what failed here/);
            assert.match(error.message, new RegExp(`sessions\\[0\\]\` entry carries a non-string \`${key}\``)); // prettier-ignore
            assert.doesNotMatch(error.message, /could not be read|not parseable/);
            return true;
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('an unreadable document fails loudly naming it rather than parsing as empty', () => {
    assert.throws(
      () => readTreeFile(join(ROOT, 'docs', 'verification', 'no-such-document.md')),
      (error) =>
        error instanceof InputError &&
        error.message.includes('no-such-document.md') &&
        error.message.includes('could not be read'),
    );
  });

  it('a readable file still comes back as its text', () => {
    assert.ok(readTreeFile(join(ROOT, CORPUS_DOC_PATH)).includes('STC-19'));
  });
});

// The exit-code contract is a process-boundary fact — 0 green, 1 an inventory
// that drifted, 2 machinery breakage that must never read as a drift verdict —
// and only a spawn observes it. Every file the CLI reads is cwd-relative (both
// verification documents, the workflow, the manifest, both known-diffs
// baselines, the sufficiency baseline, and the root package manifest), so a
// temporary tree holding copies of exactly those is a complete input surface:
// nothing else it touches comes off disk. Env: the script's whole import
// closure reads no process.env, so the inherited environment is already the
// pinned one.
describe('check-verification-inventory: CLI exit codes at the process boundary', () => {
  const SCRIPT = join(ROOT, 'scripts', 'check-verification-inventory.js');
  const EXT_BASELINE = STRICT_WATCH_PLATFORMS[0].baselinePath;
  const READS = [
    CORPUS_DOC_PATH,
    LINT_DOC_PATH,
    TEST_WORKFLOW_PATH,
    MANIFEST_PATH,
    SUFFICIENCY_BASELINE_PATH,
    PACKAGE_JSON_PATH,
    VECTOR_SCHEMA_PATH,
    ...STRICT_WATCH_PLATFORMS.map((w) => w.baselinePath),
  ];
  let root = null;

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A temporary tree holding copies of the files the CLI reads. */
  function tree(mutate = null) {
    root ??= mkdtempSync(join(tmpdir(), 'docent-inventory-cli-'));
    const dir = mkdtempSync(join(root, 'case-'));
    const files = new Map(READS.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
    if (mutate) mutate(files);
    for (const [rel, text] of files) {
      const target = join(dir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }

  /** Run the real CLI against a temporary tree; returns its exit status. */
  function run(dir) {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('exit 0 over pristine copies of the files it reads', () => {
    const { status, stdout } = run(tree());
    assert.equal(status, 0, stdout);
    assert.match(stdout, /verification inventories current/);
  });

  it('exit 1 with the drift verdict when a documented covered field is dropped', () => {
    const { status, stderr } = run(
      tree((files) => {
        const doc = files.get(CORPUS_DOC_PATH);
        const stated = ', and `delta_x` (';
        assert.ok(doc.includes(stated), 'the mutation anchor moved');
        files.set(CORPUS_DOC_PATH, doc.replace(stated, ' ('));
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /inventory drifted/);
    assert.match(stderr, /delta_x/);
  });

  it('exit 2 with the machinery verdict when the manifest will not parse', () => {
    const { status, stderr } = run(tree((files) => files.set(MANIFEST_PATH, '{ "sessions": [ ')));
    assert.equal(status, 2);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /is not parseable JSON/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /inventory drifted/);
  });

  it('exit 2 when a session entry is malformed, not exit 1 with a type error', () => {
    // Executed escape before the shape guard went deeper: this input exited 1
    // with a TypeError stack, so a broken manifest read as a drifted inventory.
    const { status, stderr } = run(
      tree((files) =>
        files.set(MANIFEST_PATH, JSON.stringify({ sessions: [{ platform: 'desktop-windows' }] })),
      ),
    );
    assert.equal(status, 2, stderr);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /shape is what failed here/);
    assert.doesNotMatch(stderr, /inventory drifted/);
    assert.doesNotMatch(stderr, /TypeError/);
  });

  it('exit 1 demanding the strict flip when a known-diffs baseline is emptied', () => {
    const { status, stderr } = run(
      tree((files) => {
        const baseline = JSON.parse(files.get(EXT_BASELINE));
        for (const id of Object.keys(baseline)) baseline[id] = [];
        files.set(EXT_BASELINE, JSON.stringify(baseline, null, 2));
      }),
    );
    assert.equal(status, 1, stderr);
    assert.match(stderr, /inventory drifted/);
    assert.match(stderr, /carries no known diff/);
    assert.match(stderr, /--strict/);
    assert.match(stderr, /npm run corpus:check/);
  });

  it('exit 1 on a strict flag passed before its trigger', () => {
    const { status, stderr } = run(
      tree((files) => {
        const manifest = JSON.parse(files.get(PACKAGE_JSON_PATH));
        manifest.scripts['corpus:check'] += ' --strict';
        files.set(PACKAGE_JSON_PATH, JSON.stringify(manifest, null, 2));
      }),
    );
    assert.equal(status, 1, stderr);
    assert.match(stderr, /passes `--strict` while/);
    assert.match(stderr, /still carries a known diff/);
  });

  it('exit 2 when a known-diffs baseline is emptied of its keys, not exit 1 demanding the flip', () => {
    // The false green this guard exists for: `{}` satisfies "every present
    // array is empty" vacuously, so without the guard a truncated file would
    // read as a real flip trigger.
    const { status, stderr } = run(tree((files) => files.set(EXT_BASELINE, '{}')));
    assert.equal(status, 2, stderr);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /carries no session keys at all/);
    assert.doesNotMatch(stderr, /inventory drifted/);
    assert.doesNotMatch(stderr, /carries no known diff/);
  });

  it('exit 2 when the workflow carries no anchor, and the fact is stated once', () => {
    // Before the reclassification this exited 1 under the drift headline, and
    // twice over: once as the extractor's problem and again as an inventory
    // that came back empty.
    const anchor = run(
      tree((files) =>
        files.set(TEST_WORKFLOW_PATH, files.get(TEST_WORKFLOW_PATH).replace(/^jobs:/m, '# jobs:')),
      ),
    );
    assert.equal(anchor.status, 2, anchor.stderr);
    assert.match(anchor.stderr, /could not be used/);
    assert.match(anchor.stderr, /carries no top-level/);
    assert.doesNotMatch(anchor.stderr, /inventory drifted/);
    assert.doesNotMatch(anchor.stderr, /no job ids found/);

    const drift = run(
      tree((files) =>
        files.set(CORPUS_DOC_PATH, files.get(CORPUS_DOC_PATH).replace(', and `delta_x` (', ' (')),
      ),
    );
    assert.notEqual(anchor.status, drift.status);
  });

  it('exit 2 when the vector meta-schema states no outcome under the field it is read by', () => {
    const { status, stderr } = run(
      tree((files) => {
        const schema = JSON.parse(files.get(VECTOR_SCHEMA_PATH));
        delete schema.properties.expected_outcome.const;
        files.set(VECTOR_SCHEMA_PATH, JSON.stringify(schema, null, 2));
      }),
    );
    assert.equal(status, 2, stderr);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /states no `const` outcome/);
    assert.doesNotMatch(stderr, /inventory drifted/);
  });

  it('exit 1 when the clause states an outcome the meta-schema does not', () => {
    const { status, stderr } = run(
      tree((files) => {
        const doc = files.get(CORPUS_DOC_PATH);
        const stated = 'is `resolved` ship';
        assert.ok(doc.includes(stated), 'the mutation anchor moved');
        files.set(CORPUS_DOC_PATH, doc.replace(stated, 'is `matched` ship'));
      }),
    );
    assert.equal(status, 1, stderr);
    assert.match(stderr, /inventory drifted/);
    assert.match(stderr, /matched/);
    assert.doesNotMatch(stderr, /could not be used/);
  });

  it('the drift verdict and the machinery verdict never share an exit code', () => {
    const drift = run(
      tree((files) =>
        files.set(CORPUS_DOC_PATH, files.get(CORPUS_DOC_PATH).replace(', and `delta_x` (', ' (')),
      ),
    ).status;
    const machinery = run(tree((files) => files.set(MANIFEST_PATH, '{ "sessions": [ '))).status;
    assert.notEqual(drift, machinery);
    assert.equal(drift, 1);
    assert.equal(machinery, 2);
  });
});

describe('real-tree lock', () => {
  it('the committed verification documents satisfy every inventory pin', () => {
    // Through the shipped reader, uncaught: a renamed or moved document must
    // red here as the read failure it is, never as an inventory that came back
    // empty. Only the root anchoring is this lock's own (the suite runs from
    // anywhere; the CLI runs from the repository root).
    const readFile = (path) => readTreeFile(join(ROOT, path));
    const listSessions = (platform) => listActiveSessions(platform, join(ROOT, MANIFEST_PATH));
    const { problems, pinCount } = auditTree(readFile, listSessions);
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(pinCount > 0, 'the audit read no documented entries at all');
  });

  it('the manifest shape guard serves every platform the check discovers', () => {
    // The desktop view is exercised throughout; this drives the SAME fused
    // guard through the extension view, so a platform-specific escape cannot
    // hide behind the one view the rest of the suite uses.
    const dir = mkdtempSync(join(tmpdir(), 'docent-inventory-'));
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ sessions: [{ id: 'ext-a', truth: 5 }] }));
    try {
      assert.throws(
        () => listActiveSessions('extension', manifest),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, /carries no string `platform`/);
          return true;
        },
      );
      writeFileSync(
        manifest,
        JSON.stringify({
          sessions: [
            { id: 'ext-a', platform: 'extension' },
            { id: 'ext-b', platform: 'extension', status: 'retired' },
            { id: 'd-a', platform: 'desktop-windows' },
          ],
        }),
      );
      assert.deepEqual(listActiveSessions('extension', manifest), ['ext-a']);
      assert.deepEqual(listActiveSessions('desktop-windows', manifest), ['d-a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the shipped tree carries an active session list for every watched platform', () => {
    for (const { platform } of STRICT_WATCH_PLATFORMS) {
      const ids = listActiveSessions(platform, join(ROOT, MANIFEST_PATH));
      assert.ok(ids.length > 0, `no active ${platform} sessions discovered`);
    }
  });
});
