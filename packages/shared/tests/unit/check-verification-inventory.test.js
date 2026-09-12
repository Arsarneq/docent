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
 * population diffed against the watched set in each direction on a direct
 * surface (from a tree state only the corpus side prints), and each gate
 * command's own `--platform` and `--baseline` argument values against what this
 * check reads for it — a gate pointed elsewhere is watched against a state it
 * does not gate on. Beyond the legs, the suite pins the guard's own shape: the
 * §STC-22 session diff is refused by name when the watch stops minting its
 * partner, and the outcome the vector meta-schema states carries no vacuity
 * leg, because its reader refuses ahead of the guard.
 *
 * The exit-code contract is pinned where it lives, at the process boundary: a
 * spawned-CLI family runs the real command over a temporary tree holding copies
 * of the files it reads, and holds 0 / 1 / 2 to their meanings — green, a pin
 * that no longer holds, and machinery breakage that must never read as a
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
  SESSION_CLAUSE_ID,
  CITED_JOB_DOCUMENTS,
  UNIT_SUITE_JOB_ID,
  UNIT_SUITE_DIR,
  INVENTORY_LEGS,
  legList,
  NAMED_CAUSE_CAP,
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
  registeredNodeSuite,
  suiteGlob,
  jobSuiteArguments,
  jobSuiteProblems,
  plainCommandShape,
  npmRunScript,
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
  readSessionCatalogue,
  evaluateVerificationInventory,
  auditTree,
  InputError,
  readTreeFile,
  listActiveSessions,
} from '../../../../scripts/check-verification-inventory.js';
import {
  blankJsLiterals,
  topLevelListItems,
  trackedFilesUnder,
} from '../../../../scripts/check-test-inventory.js';
import { RELAX_KINDS } from '../../../../scripts/corpus-compare.js';
import {
  TEST_WORKFLOW_PATH,
  commandSegments,
  extractJobIds,
  extractLintSurface,
  isJobAnchorProblem,
} from '../../../../scripts/check-doc-closure.js';
import { readJobs } from '../../../../scripts/check-workflow-bounds.js';

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

/**
 * A vector meta-schema stating the outcome field but no `const` under it — the
 * text the reader's refusal row and the vacuity-leg pin below both read.
 */
const SCHEMA_WITHOUT_CONST = '{"properties": {"expected_outcome": {"type": "string"}}}';

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
    registeredSuite: registeredNodeSuite(UNIT_SUITE_DIR),
    jobSuite: {
      absent: false,
      tokens: ['test:coverage'],
      globs: [{ dir: UNIT_SUITE_DIR, pattern: registeredNodeSuite(UNIT_SUITE_DIR)?.pattern }],
      refusals: [],
    },
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

  // The partner surface is minted per WATCHED platform, and the emptiness leg
  // that would speak for it is derived from the same list — so one edit, dropping
  // a platform from STRICT_WATCH_PLATFORMS, takes both away together (covering a
  // platform whose sessions have all been retired reds on its active-session
  // vacuity leg; dropping it from the watch reds here). Every fixture here
  // supplies the key, which is what leaves this state unpinned until a case omits
  // it. In a fixture the two still arrive together: omitting the key trips the
  // shared guard's key-absent arm, so these cases stop at the vacuity return, and
  // their negative assertion — no session reported retired — rides that return
  // rather than the catalogue legs' own silence. What holds the silence itself,
  // and the refusal's falling through so the population finding still prints
  // beside it, is the case that hands the evaluator the state the tree would
  // produce — the platform gone from the watched set and from the guard list, its
  // key absent — alone; that the legs run when the surface is present is held by
  // the cases that fire on a session the manifest does not run and on an active
  // session the clause omits.
  it('refuses the diff, naming the watch, when the watch no longer mints its partner', () => {
    const surface = makeSurface();
    delete surface[activeSessionsKey('desktop-windows')];
    const problems = evaluateVerificationInventory(surface);
    assert.ok(
      problems.some(
        (p) => p.includes('no surface to diff against') && p.includes('STRICT_WATCH_PLATFORMS'),
      ),
      problems.join('\n'),
    );
    // …and none of the clause's sessions is reported retired on the way past.
    assert.ok(
      !problems.some((p) => p.includes('carries no active desktop-windows session for')),
      problems.join('\n'),
    );
  });

  it('names the watch on a tree whose parses came back empty too', () => {
    // The refusal reads this check's own list and no parsed document, so it is
    // sound on a vacuous tree and states itself there rather than waiting
    // behind the early return, where any one empty surface would hide it.
    const surface = makeSurface({ docKinds: [] });
    delete surface[activeSessionsKey('desktop-windows')];
    const problems = evaluateVerificationInventory(surface);
    assert.ok(problems.some((p) => p.includes('no relaxation kinds found')), problems.join('\n')); // prettier-ignore
    assert.ok(problems.some((p) => p.includes('no surface to diff against')), problems.join('\n')); // prettier-ignore
  });

  it('states the clause, the list that moved, and where the remedy is — the watch, or the diff', () => {
    const surface = makeSurface();
    delete surface[activeSessionsKey('desktop-windows')];
    const refusal = evaluateVerificationInventory(surface).find((p) =>
      p.includes('no surface to diff against'),
    );
    assert.ok(refusal, 'no refusal to read');
    assert.ok(refusal.includes(`§${SESSION_CLAUSE_ID}`), refusal);
    assert.ok(refusal.includes('scripts/check-verification-inventory.js'), refusal);
    assert.ok(refusal.includes('STRICT_WATCH_PLATFORMS'), refusal);
    assert.ok(refusal.includes('put the platform back on the watch'), refusal);
    assert.ok(refusal.includes("move the clause's diff to a platform the watch covers"), refusal);
  });

  it('runs the catalogue diff legs silent when the watch has really dropped the platform', () => {
    // The state `auditTree` builds when the platform leaves the watch: gone from
    // the watched set and from the watch entries, its active-session key never
    // minted, and its derived leg gone from the guard list — while the manifest
    // still carries its sessions.
    const surface = makeSurface({ watchedPlatforms: ['extension'], strictWatch: [watchEntry()] });
    delete surface[activeSessionsKey('desktop-windows')];
    const legs = EMPTY_SURFACES.filter(([k]) => k !== activeSessionsKey('desktop-windows'));
    const problems = evaluateVerificationInventory(surface, legs);
    assert.ok(
      problems.some((p) => p.includes('no surface to diff against')),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((p) => p.includes('desktop-windows') && p.includes('has not learned')),
      problems.join('\n'),
    );
    assert.ok(
      !problems.some((p) => p.includes('carries no active desktop-windows session for')),
      problems.join('\n'),
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

// The job-suite leg: the job both verification documents name runs the suite
// they name, read the way the runner resolves it. The cases below are the
// leg's own readers over synthetic jobs, then the shipped workflow and
// manifest, then the readings a shallower one would get wrong.
describe('the suite the named job runs', () => {
  /** The shipped registration, read once — the fixtures below key off it. */
  const SUITE = registeredNodeSuite(UNIT_SUITE_DIR);
  /** Whether one resolved argument is that suite's registered glob. */
  const isSuite = (g) => g.dir === SUITE.dir && g.pattern === SUITE.pattern;
  /** A `jobs` map carrying one job whose steps run the given commands. */
  const jobs = (runs, id = UNIT_SUITE_JOB_ID) => ({
    [id]: { steps: runs.map((run) => ({ run })) },
  });
  /**
   * The manifest scripts the fixtures below resolve through: the shipped shape,
   * where the job states a script of its own beside the one carrying the suite.
   */
  const RESOLVING_COMMANDS = {
    'sync-shared': 'node scripts/sync-shared.js',
    'test:coverage': `c8 node --test ${suiteGlob(SUITE)} packages/desktop/tests/unit/*.test.js`,
    'test:desktop:coverage': 'c8 node --test packages/desktop/tests/unit/*.test.js',
  };
  /**
   * A job whose first step resolves a script key whatever the step under test
   * does, so the vacuity refusal — which answers for a scan that read nothing —
   * never stands in for the finding a case is about.
   */
  const resolving = (runs) => jobs(['npm run sync-shared', ...runs]);

  it('the registration is where the glob comes from, not this check', () => {
    assert.notEqual(SUITE, undefined, `DOC_INVENTORIES registers ${UNIT_SUITE_DIR}`);
    assert.equal(SUITE.dir, UNIT_SUITE_DIR);
    assert.equal(suiteGlob(SUITE), `${UNIT_SUITE_DIR}/${SUITE.pattern}`);
    // A directory no entry registers a node discovery for answers nothing,
    // rather than a half-built descriptor the leg would read as a suite.
    assert.equal(registeredNodeSuite('packages/shared/tests/fixtures'), undefined);
    // The cargo suite IS registered — but not by a `node --test` glob, so this
    // reader passes it over rather than demanding a node invocation for it.
    assert.equal(registeredNodeSuite('packages/desktop/src-tauri/tests'), undefined);
  });

  it('a job stating the glob through its script satisfies the leg', () => {
    const read = jobSuiteArguments(
      jobs(['npm run sync-shared', 'npm run test:coverage']),
      { 'sync-shared': 'node scripts/sync-shared.js', 'test:coverage': `c8 node --test ${suiteGlob(SUITE)} packages/desktop/tests/unit/*.test.js` }, // prettier-ignore
      UNIT_SUITE_JOB_ID,
    );
    assert.deepEqual(read.refusals, []);
    assert.deepEqual(read.tokens, ['sync-shared', 'test:coverage']);
    assert.deepEqual(jobSuiteProblems(SUITE, read), []);
  });

  it('a job stating further suites beside it still satisfies the leg', () => {
    // The pin is membership, not equality: the job is free to grow a tree.
    const read = jobSuiteArguments(
      jobs(['npm run everything']),
      { everything: `node --test ${suiteGlob(SUITE)} packages/extension/tests/unit/*.test.js` },
      UNIT_SUITE_JOB_ID,
    );
    assert.deepEqual(jobSuiteProblems(SUITE, read), []);
  });

  it('the glob dropped from the script it resolves through reds, naming what is left', () => {
    const read = jobSuiteArguments(
      jobs(['npm run test:coverage']),
      { 'test:coverage': 'c8 node --test packages/desktop/tests/unit/*.test.js' },
      UNIT_SUITE_JOB_ID,
    );
    const problems = jobSuiteProblems(SUITE, read);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes(suiteGlob(SUITE)), problems[0]);
    assert.ok(problems[0].includes('packages/desktop/tests/unit/*.test.js'), problems[0]);
    assert.ok(problems[0].includes(SUITE.doc), problems[0]);
  });

  it('the command swapped for another real script reds the same way', () => {
    // The ARGUMENT SET is the pin: a step free to be respelled is not free to
    // stop running the suite. Nothing here reads the command string.
    const read = jobSuiteArguments(
      jobs(['npm run build:schemas']),
      { 'build:schemas': 'node scripts/build-schemas.js', 'test:coverage': `node --test ${suiteGlob(SUITE)}` }, // prettier-ignore
      UNIT_SUITE_JOB_ID,
    );
    const problems = jobSuiteProblems(SUITE, read);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes('resolve to no `node --test` suite at all'), problems[0]);
  });

  it('a literal member of the suite is not the suite', () => {
    const read = jobSuiteArguments(
      jobs(['npm run one']),
      { one: `node --test ${UNIT_SUITE_DIR}/conformance-vectors.test.js` },
      UNIT_SUITE_JOB_ID,
    );
    assert.deepEqual(read.globs, []);
    assert.equal(jobSuiteProblems(SUITE, read).length, 1);
  });

  describe('a relocated command is not read against the root', () => {
    // The readings a shallower one gets wrong. In each, the step's `npm run`
    // token is spelled exactly like the root script's and the root manifest
    // defines that name — so resolving the token without its relocation would
    // report the ROOT suite run by a step that runs another package's.
    const commands = { 'test:coverage': `c8 node --test ${suiteGlob(SUITE)}` };

    for (const [shape, run] of [
      ['a `cd` ahead of it on the same line', 'cd packages/extension && npm run test:coverage'],
      ['a `cd` on an earlier line of the same block', 'cd packages/extension\nnpm run test:coverage'], // prettier-ignore
      ['a `cd` earlier still, with the command two lines down', 'cd packages/extension\nnpm ci\nnpm run test:coverage'], // prettier-ignore
    ]) {
      it(`${shape} leaves the command unread, and says so`, () => {
        const read = jobSuiteArguments(jobs([run]), commands, UNIT_SUITE_JOB_ID);
        assert.deepEqual(read.globs, []);
        assert.deepEqual(read.tokens, []);
        // The verdict is the scan's own refusal, not a suite reported dropped.
        const problems = jobSuiteProblems(SUITE, read);
        assert.equal(problems.length, 1);
        assert.ok(problems[0].includes('read none of that job'), problems[0]);
      });
    }

    it('a step stating its own working directory is refused by name', () => {
      const read = jobSuiteArguments(
        { [UNIT_SUITE_JOB_ID]: { steps: [{ 'working-directory': 'packages/extension', run: 'npm run test:coverage' }] } }, // prettier-ignore
        commands,
        UNIT_SUITE_JOB_ID,
      );
      assert.equal(read.refusals.length, 1);
      assert.ok(read.refusals[0].includes('working-directory: packages/extension'), read.refusals[0]); // prettier-ignore
      assert.deepEqual(read.globs, []);
      assert.ok(jobSuiteProblems(SUITE, read).some((p) => p.includes('cannot be resolved')));
    });

    it('a `cd` AFTER the command does not unread it', () => {
      // The relocation bounds what follows it, not what precedes it: the reader
      // resolves the command standing before the `cd` and carries its globs.
      const read = jobSuiteArguments(
        jobs(['npm run test:coverage && cd packages/extension && npm ci']),
        commands,
        UNIT_SUITE_JOB_ID,
      );
      assert.ok(read.globs.some(isSuite), JSON.stringify(read));
      assert.deepEqual(read.refusals, []);
      // What refuses the step is the admission the verdict holds, not the `cd`:
      // the carrying command does not stand alone on its line.
      const problems = jobSuiteProblems(SUITE, read);
      assert.ok(problems[0].includes('the operator `&&`'), problems[0]);
      assert.ok(!problems[0].includes('`cd`'), problems[0]);
    });
  });

  it('a job the workflow does not carry is named as that, not as a dropped suite', () => {
    const read = jobSuiteArguments(jobs(['npm run test:coverage'], 'other-job'), {}, UNIT_SUITE_JOB_ID); // prettier-ignore
    assert.equal(read.absent, true);
    const problems = jobSuiteProblems(SUITE, read);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes(`has no \`${UNIT_SUITE_JOB_ID}\` job`), problems[0]);
  });

  it('a registration this check’s directory no longer matches names both', () => {
    const problems = jobSuiteProblems(undefined, { absent: false, tokens: [], globs: [], refusals: [] }); // prettier-ignore
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes('UNIT_SUITE_DIR'), problems[0]);
    assert.ok(problems[0].includes('DOC_INVENTORIES'), problems[0]);
  });

  it('a script the root manifest does not define is refused by name', () => {
    const read = jobSuiteArguments(jobs(['npm run test:coverage']), {}, UNIT_SUITE_JOB_ID);
    assert.equal(read.refusals.length, 1);
    assert.ok(read.refusals[0].includes(PACKAGE_JSON_PATH), read.refusals[0]);
    assert.ok(jobSuiteProblems(SUITE, read).some((p) => p.includes('cannot be resolved')));
  });

  it('a command the argument reader will not model is refused, never read as empty', () => {
    for (const command of [
      'cd packages/desktop && node --test tests/unit/*.test.js',
      'node --test packages/*/tests/unit/*.test.js',
    ]) {
      const read = jobSuiteArguments(jobs(['npm run odd']), { odd: command }, UNIT_SUITE_JOB_ID);
      assert.equal(read.refusals.length, 1, command);
      const problems = jobSuiteProblems(SUITE, read);
      assert.ok(problems.some((p) => p.includes('cannot be resolved')), command); // prettier-ignore
      assert.ok(
        problems.some((p) => p.includes('does not model')),
        command,
      );
    }
  });

  // The step's own command, and the one anchoring rule both routes take.
  describe('the step’s own command is read by the same reader', () => {
    const inlined = `npx c8 --reporter=text --reporter=lcov node --test ${suiteGlob(SUITE)} packages/desktop/tests/unit/*.test.js`; // prettier-ignore

    it('a step spelling the invocation out carries the suite', () => {
      // Named no script at all: read today as a job that dropped the suite.
      const read = jobSuiteArguments(jobs([inlined]), {}, UNIT_SUITE_JOB_ID);
      assert.deepEqual(read.refusals, []);
      assert.ok(read.globs.some(isSuite), JSON.stringify(read.globs));
      assert.deepEqual(jobSuiteProblems(SUITE, read), []);
    });

    it('npm’s own flags are stepped over, so a flagged invocation resolves', () => {
      const read = jobSuiteArguments(
        jobs(['npm run --silent test:coverage']),
        { 'test:coverage': `c8 node --test ${suiteGlob(SUITE)}` },
        UNIT_SUITE_JOB_ID,
      );
      assert.deepEqual(read.tokens, ['test:coverage']);
      assert.deepEqual(jobSuiteProblems(SUITE, read), []);
    });

    it('a step stating the invocation after a `cd` is still stopped at the `cd`', () => {
      const read = jobSuiteArguments(
        resolving([`cd packages/extension && node --test ${suiteGlob(SUITE)}`]),
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.deepEqual(read.globs, []);
      const problems = jobSuiteProblems(SUITE, read);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes(suiteGlob(SUITE)), problems[0]);
    });

    for (const [shape, run, named] of [
      ['an invocation standing as another command’s argument', `echo node --test ${suiteGlob(SUITE)}`, 'node'], // prettier-ignore
      ['an invocation behind a shell keyword', `if true; then node --test ${suiteGlob(SUITE)}; fi`, 'node'], // prettier-ignore
      ['a script invocation behind a timer', 'time npm run test:coverage', 'npm'],
      ['a script invocation behind a shell keyword', 'if true; then npm run test:coverage; fi', 'npm'], // prettier-ignore
    ]) {
      it(`${shape} is refused by name rather than read`, () => {
        const read = jobSuiteArguments(resolving([run]), RESOLVING_COMMANDS, UNIT_SUITE_JOB_ID);
        assert.equal(read.refusals.length, 1, JSON.stringify(read.refusals));
        assert.ok(read.refusals[0].includes(`\`${named}\``), read.refusals[0]);
        assert.ok(read.refusals[0].includes('other than the head'), read.refusals[0]);
        const problems = jobSuiteProblems(SUITE, read);
        assert.equal(problems.length, 2, problems.join('\n'));
        assert.ok(problems[1].includes(suiteGlob(SUITE)), problems[1]);
      });
    }

    it('a script key this reader cannot read is refused by name', () => {
      // The closing paren rides the key, so the root manifest would be asked
      // for a key no manifest defines.
      const read = jobSuiteArguments(
        resolving(['(npm run test:coverage)']),
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.equal(read.refusals.length, 1, JSON.stringify(read.refusals));
      assert.ok(read.refusals[0].includes('script key this reader cannot read'), read.refusals[0]);
      assert.equal(jobSuiteProblems(SUITE, read).length, 2);
    });

    it('the key reader names the key it reads and refuses the one it cannot', () => {
      assert.equal(npmRunScript('npm ci'), undefined);
      assert.deepEqual(npmRunScript('npm run test:coverage'), { token: 'test:coverage' });
      assert.deepEqual(npmRunScript('npm run --silent test:coverage'), { token: 'test:coverage' });
      // npm takes its own flags on either side of the verb, so this reader does.
      assert.deepEqual(npmRunScript('npm --silent run test:coverage'), { token: 'test:coverage' });
      assert.deepEqual(npmRunScript('npm run test:coverage)'), { unreadable: true });
      assert.deepEqual(npmRunScript('npm run'), { unreadable: true });
      // npm's own aliases of the run verb resolve the key the same way.
      for (const verb of ['run', 'run-script', 'rum', 'urn']) {
        assert.deepEqual(npmRunScript(`npm ${verb} test:coverage`), { token: 'test:coverage' }, verb); // prettier-ignore
      }
      // A flag that answers the key from another manifest, on either side of it,
      // in npm's long spelling and its short one.
      assert.deepEqual(npmRunScript('npm run --prefix packages/extension test:coverage'), { relocated: '--prefix' }); // prettier-ignore
      assert.deepEqual(npmRunScript('npm run -C packages/extension test:coverage'), { relocated: '-C' }); // prettier-ignore
      assert.deepEqual(npmRunScript('npm run test:coverage -w packages/extension'), { relocated: '-w' }); // prettier-ignore
      assert.deepEqual(npmRunScript('npm run test:coverage -ws'), { relocated: '-ws' });
      // The flag is named as the segment states it, its `=` value included.
      assert.deepEqual(npmRunScript('npm run test:coverage --workspace=packages/extension'), { relocated: '--workspace=packages/extension' }); // prettier-ignore
      assert.deepEqual(npmRunScript('npm --prefix packages/extension run test:coverage'), { relocated: '--prefix' }); // prettier-ignore
      // A verb that runs a manifest script without naming a run verb.
      for (const verb of ['test', 't', 'tst', 'start', 'stop', 'restart', 'exec', 'x']) {
        assert.deepEqual(npmRunScript(`npm ${verb}`), { verb }, verb);
      }
      // A verb that runs no manifest script is read as naming none, and the
      // relocation scan does not reach past it.
      assert.equal(npmRunScript('npm ci --prefix packages/extension'), undefined);
      assert.equal(npmRunScript('npm install --workspaces'), undefined);
    });

    it('the vacuity refusal names both routes and stays silent once either resolved', () => {
      const unread = jobSuiteArguments(
        jobs(['cd packages/extension && npm run test:coverage']),
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      const refusal = jobSuiteProblems(SUITE, unread);
      assert.equal(refusal.length, 1, refusal.join('\n'));
      assert.ok(refusal[0].includes('no `npm run` this reader could resolve'), refusal[0]);
      assert.ok(refusal[0].includes('no `node --test` invocation it could read'), refusal[0]);
      // The step's own command resolved, so the guard has read something even
      // though no script key was looked up.
      const viaStep = jobSuiteArguments(jobs([inlined]), {}, UNIT_SUITE_JOB_ID);
      assert.deepEqual(viaStep.tokens, []);
      assert.deepEqual(jobSuiteProblems(SUITE, viaStep), []);
    });
  });

  // The spellings this reading does not resolve, each refused by name rather
  // than passed over as a segment that states nothing.
  describe('spellings this reading refuses rather than passes over', () => {
    for (const [shape, run, named] of [
      ['an `npm run` whose key another manifest would answer', 'npm run --prefix packages/extension test:coverage', '`--prefix`'], // prettier-ignore
      ['npm’s short spelling of that flag', 'npm run -C packages/extension test:coverage', '`-C`'], // prettier-ignore
      ['that same flag after the key', 'npm run test:coverage -w packages/extension', '`-w`'],
      ['a verb that runs a script without naming a run verb', 'npm test', '`npm test`'],
      ['one of npm’s lifecycle verbs', 'npm start', '`npm start`'],
      ['an argument list whose quoted text the grammar passed over', `node --test "${suiteGlob(SUITE)}"`, 'could not be read whole'], // prettier-ignore
      ['a continuation with no line left to join it to', 'npm run test:coverage \\', 'could not be read whole'], // prettier-ignore
    ]) {
      it(`${shape} is refused by name`, () => {
        const read = jobSuiteArguments(resolving([run]), RESOLVING_COMMANDS, UNIT_SUITE_JOB_ID);
        assert.equal(read.refusals.length, 1, JSON.stringify(read.refusals));
        assert.ok(read.refusals[0].includes(named), read.refusals[0]);
        assert.ok(!read.globs.some(isSuite), JSON.stringify(read.globs));
        const problems = jobSuiteProblems(SUITE, read);
        assert.equal(problems.length, 2, problems.join('\n'));
        assert.ok(problems[1].includes(suiteGlob(SUITE)), problems[1]);
      });
    }

    it('npm’s own flag before the verb still resolves the script it names', () => {
      const read = jobSuiteArguments(
        jobs(['npm --silent run test:coverage']),
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.deepEqual(read.tokens, ['test:coverage']);
      assert.deepEqual(jobSuiteProblems(SUITE, read), []);
    });

    it('a quoted argument the reader passed over is the carrying step’s own shape', () => {
      // The grammar passes over quoted text everywhere, so the reader refuses
      // nothing here — it read no argument list of its own. What refuses is the
      // admission the verdict holds: the carrying command does not stand alone.
      const read = jobSuiteArguments(
        jobs([`npm run test:coverage -- --grep 'a|b'`]),
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.deepEqual(read.refusals, []);
      const problems = jobSuiteProblems(SUITE, read);
      assert.equal(problems.length, 2, problems.join('\n'));
      assert.ok(problems[0].includes('a quoted argument'), problems[0]);
    });

    it('a continuation is joined before the split, so what it joins is read', () => {
      // The shell removes a backslash-newline before it parses, so `echo \` and
      // the line below it are ONE command — an invocation standing off its head.
      const read = jobSuiteArguments(
        resolving([`echo staging \\\nnode --test ${suiteGlob(SUITE)}`]),
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.equal(read.refusals.length, 1, JSON.stringify(read.refusals));
      assert.ok(read.refusals[0].includes('other than the head'), read.refusals[0]);
      assert.ok(!read.globs.some(isSuite), JSON.stringify(read.globs));
    });

    it('a relocation stated at the workflow’s own root is refused by name', () => {
      // It applies to every job of the workflow, so it leaves this job's steps
      // unread the way the job's own default does.
      const read = jobSuiteArguments(
        { [UNIT_SUITE_JOB_ID]: { steps: [{ run: 'npm run test:coverage' }] } },
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
        'packages/extension',
      );
      assert.deepEqual(read.refusals, []);
      assert.equal(read.jobRefusals.length, 1, JSON.stringify(read.jobRefusals));
      assert.ok(read.jobRefusals[0].includes("the workflow's own root"), read.jobRefusals[0]);
      assert.deepEqual(read.steps, []);
      const problems = jobSuiteProblems(SUITE, read);
      // One line: the refusal already says why nothing was read.
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes('what its steps run cannot be resolved'), problems[0]);
    });

    it('a job stating its own default working directory is refused by name', () => {
      const read = jobSuiteArguments(
        { [UNIT_SUITE_JOB_ID]: { defaults: { run: { 'working-directory': 'packages/extension' } }, steps: [{ run: 'npm run test:coverage' }] } }, // prettier-ignore
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.deepEqual(read.refusals, []);
      assert.equal(read.jobRefusals.length, 1, JSON.stringify(read.jobRefusals));
      assert.ok(read.jobRefusals[0].includes('defaults.run.working-directory: packages/extension'), read.jobRefusals[0]); // prettier-ignore
      // It moves every step, so none of their commands is resolved against the root.
      assert.deepEqual(read.steps, []);
      assert.deepEqual(read.globs, []);
      // ONE line: the refusal's own sentence, with no step to point at, and no
      // second line claiming the job states no command this reader could resolve.
      const problems = jobSuiteProblems(SUITE, read);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes('what its steps run cannot be resolved'), problems[0]);
      assert.ok(!problems[0].includes('that step runs'), problems[0]);
    });

    it('a job stating a tolerance of its own is refused as the job’s, not a step’s', () => {
      const problems = jobSuiteProblems(
        SUITE,
        jobSuiteArguments(
          { [UNIT_SUITE_JOB_ID]: { 'continue-on-error': true, steps: [{ name: 'Tests', run: 'npm run test:coverage' }] } }, // prettier-ignore
          RESOLVING_COMMANDS,
          UNIT_SUITE_JOB_ID,
        ),
      );
      assert.equal(problems.length, 2, problems.join('\n'));
      assert.ok(problems[0].includes('the tolerance `continue-on-error: true` of its own'), problems[0]); // prettier-ignore
      assert.ok(!problems[0].includes('the step named'), problems[0]);
      assert.ok(problems[0].includes('teach the reader'), problems[0]);
      assert.ok(problems[1].includes(suiteGlob(SUITE)), problems[1]);
    });

    it('a step read only as far as a `cd` over an install is not named', () => {
      // The note points at a step that could have carried the suite. A dependency
      // install behind a `cd` resolves nothing, so naming it would be noise.
      const read = jobSuiteArguments(
        {
          [UNIT_SUITE_JOB_ID]: {
            steps: [
              { name: 'Sync shared code', run: 'npm run sync-shared' },
              { name: 'Install', run: 'cd packages/extension && npm ci' },
            ],
          },
        },
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.equal(read.steps[1].truncated, false, JSON.stringify(read.steps[1]));
      const problems = jobSuiteProblems(SUITE, read);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(!problems[0].includes('read only as far as'), problems[0]);
    });

    it('a step read only as far as its `cd` is named beside the suite-absent finding', () => {
      const read = jobSuiteArguments(
        {
          [UNIT_SUITE_JOB_ID]: {
            steps: [
              { name: 'Sync shared code', run: 'npm run sync-shared' },
              { name: 'Tests', run: 'cd packages/extension && npm ci\nnpm run test:coverage' },
            ],
          },
        },
        RESOLVING_COMMANDS,
        UNIT_SUITE_JOB_ID,
      );
      assert.equal(read.steps[1].truncated, true, JSON.stringify(read.steps[1]));
      const problems = jobSuiteProblems(SUITE, read);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes(suiteGlob(SUITE)), problems[0]);
      assert.ok(problems[0].includes('the step named `Tests` was read only as far as its `cd`'), problems[0]); // prettier-ignore
    });
  });

  // The resolved script's own verdict: what the step delegates to is a manifest
  // command, and an operator inside it stops the failure there.
  describe('the resolved script’s own command stands alone too', () => {
    const spelled = `c8 --reporter=text --reporter=lcov node --test ${suiteGlob(SUITE)} packages/desktop/tests/unit/*.test.js`; // prettier-ignore
    const answer = (command) =>
      jobSuiteProblems(
        SUITE,
        jobSuiteArguments(jobs(['npm run test:coverage']), { 'test:coverage': command }, UNIT_SUITE_JOB_ID), // prettier-ignore
      );

    // The script runs under npm's own `sh -c`, which sets no errexit, so whatever
    // stands beside the invocation on its line can take its verdict or drop it.
    for (const [shape, command, named] of [
      ['an operator absorbing its failure', `${spelled} || true`, 'the operator `||`'],
      ['a `;` handing the verdict to a later command', `${spelled}; echo staged`, 'the operator `;`'], // prettier-ignore
      ['an `&&` after it', `${spelled} && echo ok`, 'the operator `&&`'],
      ['a background `&`', `${spelled} &`, 'the operator `&`'],
      ['a pipeline taking its verdict', `${spelled} | tee out.log`, 'the operator `|`'],
      ['an `&&` before its invocation', `echo staging && ${spelled}`, 'the operator `&&`'],
      ['a quoted argument', `c8 --reporter='text' node --test ${suiteGlob(SUITE)}`, 'a quoted argument'], // prettier-ignore
      ['a command substitution', `c8 --reporter=$(echo text) node --test ${suiteGlob(SUITE)}`, 'a command substitution'], // prettier-ignore
      ['a trailing comment', `${spelled} # staged`, 'a comment'],
    ]) {
      it(`${shape} in the script is refused by name, beside the suite-absent finding`, () => {
        const problems = answer(command);
        assert.equal(problems.length, 2, problems.join('\n'));
        assert.ok(problems[0].includes('`npm run test:coverage`'), problems[0]);
        assert.ok(problems[0].includes(named), problems[0]);
        assert.ok(problems[0].includes(PACKAGE_JSON_PATH), problems[0]);
        // Never through the reader-refusal wrapper: the script DID resolve.
        assert.ok(!problems[0].includes('cannot be resolved'), problems[0]);
        assert.ok(problems[0].includes("put the suite's command alone there"), problems[0]);
        assert.ok(problems[1].includes(suiteGlob(SUITE)), problems[1]);
      });
    }

    it('the command standing alone is admitted, however it is spelled', () => {
      assert.deepEqual(answer(spelled), []);
      assert.deepEqual(
        answer(`npx c8 --reporter=lcov --reporter=text node --test ${suiteGlob(SUITE)} packages/desktop/tests/unit/*.test.js`), // prettier-ignore
        [],
      );
    });

    it('a script the job names for something else is not this leg’s subject', () => {
      // The shape is asked of the command that CARRIES the suite. An advisory
      // script beside it may state whatever it likes; this leg answers for the
      // suite, not for every script the job runs.
      const problems = jobSuiteProblems(
        SUITE,
        jobSuiteArguments(
          {
            [UNIT_SUITE_JOB_ID]: {
              steps: [
                { name: 'Tests', run: 'npm run test:coverage' },
                { name: 'Advisory', run: 'npm run schema:impact' },
                { name: 'Stage', run: 'npm run stage:coverage' },
              ],
            },
          },
          {
            'test:coverage': spelled,
            'schema:impact': 'node scripts/auto-version-schemas.js --check || true',
            'stage:coverage': 'cat coverage/lcov.info | tee staged.lcov',
          },
          UNIT_SUITE_JOB_ID,
        ),
      );
      assert.deepEqual(problems, []);
    });
  });

  // The carrying step's own verdict: the states this reader declines to
  // evaluate, each refused by name, and the shapes it admits.
  describe('a carrying step whose verdict this reader cannot answer for', () => {
    /** The benign step every fixture below carries, so the reading is never vacuous. */
    const benign = { name: 'Sync shared code', run: 'npm run sync-shared' };
    /** The carrying step under test, beside that benign one. */
    const job = (step, jobKeys = {}) => ({
      [UNIT_SUITE_JOB_ID]: { ...jobKeys, steps: [benign, { name: 'Tests', ...step }] },
    });
    const answer = (step, jobKeys) =>
      jobSuiteProblems(
        SUITE,
        jobSuiteArguments(job(step, jobKeys), RESOLVING_COMMANDS, UNIT_SUITE_JOB_ID),
      );

    for (const [shape, step, named] of [
      ['a condition', { run: 'npm run test:coverage', if: 'false' }, 'if: false'],
      ['an expression condition', { run: 'npm run test:coverage', if: 'always()' }, 'if: always()'],
      ['a truthy tolerance', { run: 'npm run test:coverage', 'continue-on-error': true }, 'continue-on-error: true'], // prettier-ignore
      ['a tolerance written as an expression', { run: 'npm run test:coverage', 'continue-on-error': '${{ github.event_name == \'push\' }}' }, 'continue-on-error: ${{'], // prettier-ignore
    ]) {
      it(`${shape} is refused by name, beside the suite-absent finding`, () => {
        const problems = answer(step);
        assert.equal(problems.length, 2, problems.join('\n'));
        assert.ok(problems[0].includes('the step named `Tests`'), problems[0]);
        assert.ok(problems[0].includes(named), problems[0]);
        assert.ok(problems[0].includes('teach the reader'), problems[0]);
        // Never through the reader-refusal wrapper: the command DID resolve.
        assert.ok(!problems[0].includes('cannot be resolved'), problems[0]);
        assert.ok(problems[1].includes(suiteGlob(SUITE)), problems[1]);
      });
    }

    // ONE PLAIN COMMAND: what the carrying step's own `run` text may not state
    // beside its command, each shape named as the refusal names it. The step
    // runs under the workflow's default shell, and anything standing beside the
    // invocation there can take its verdict or drop it.
    for (const [shape, run, named] of [
      ['an operator absorbing its failure', 'npm run test:coverage || echo advisory', 'the operator `||`'], // prettier-ignore
      ['an operator that may never reach it', 'echo probe || npm run test:coverage', 'the operator `||`'], // prettier-ignore
      ['a pipeline taking its verdict', 'npm run test:coverage | tee out.log', 'the operator `|`'],
      ['an `&&` before it', 'echo x && npm run test:coverage', 'the operator `&&`'],
      ['an `&&` after it', 'npm run test:coverage && echo done', 'the operator `&&`'],
      ['a `;` after it', 'npm run test:coverage; echo staged', 'the operator `;`'],
      ['a background `&`', 'npm run test:coverage &', 'the operator `&`'],
      ['a quoted argument', "npm run test:coverage -- --grep 'a|b'", 'a quoted argument'],
      ['a command substitution', 'npm run test:coverage -- --grep $(cat pattern)', 'a command substitution'], // prettier-ignore
      ['a heredoc', 'npm run test:coverage <<EOF', 'a heredoc'],
      ['a trailing comment', 'npm run test:coverage # advisory', 'a comment'],
      ['a second command line', 'npm run test:coverage\necho staged', 'a second command line'],
      ['a swallowing operator on another line of the block', 'npm run test:coverage\nrm -rf tmp || true', 'a second command line'], // prettier-ignore
      ['a line continuation', 'npm run test:coverage \\\necho staged', 'a line continuation'],
    ]) {
      it(`${shape} on the carrying step is refused by name, beside the suite-absent finding`, () => {
        const problems = answer({ run });
        assert.equal(problems.length, 2, problems.join('\n'));
        assert.ok(problems[0].includes('the step named `Tests`'), problems[0]);
        assert.ok(problems[0].includes(named), problems[0]);
        assert.ok(problems[0].includes('standing alone on its step'), problems[0]);
        assert.ok(problems[0].includes("put the suite's command alone there"), problems[0]);
        // Never through the reader-refusal wrapper: the command DID resolve.
        assert.ok(!problems[0].includes('cannot be resolved'), problems[0]);
        assert.ok(problems[1].includes(suiteGlob(SUITE)), problems[1]);
      });
    }

    for (const [shape, step] of [
      ['a tolerance that tolerates nothing', { run: 'npm run test:coverage', 'continue-on-error': false }], // prettier-ignore
      ['a comment-only line beside it', { run: 'npm run test:coverage\n# the shared and desktop suites' }], // prettier-ignore
      ['a blank line after it', { run: 'npm run test:coverage\n\n' }],
    ]) {
      it(`${shape} is admitted`, () => {
        assert.deepEqual(answer(step), []);
      });
    }

    it('the rule reads one command text, whatever states it', () => {
      // One home for the admitted shape, so the step side and the script side
      // cannot drift apart: each asks this of its own text.
      assert.equal(plainCommandShape('npm run test:coverage'), null);
      assert.equal(plainCommandShape('npm run test:coverage\n# a note\n'), null);
      assert.equal(plainCommandShape('npm run test:coverage || true'), 'the operator `||`');
      assert.equal(plainCommandShape('npm run test:coverage && echo ok'), 'the operator `&&`');
      assert.equal(plainCommandShape('npm run test:coverage; echo ok'), 'the operator `;`');
      assert.equal(plainCommandShape('npm run test:coverage | tee log'), 'the operator `|`');
      assert.equal(plainCommandShape('npm run test:coverage &'), 'the operator `&`');
      assert.equal(plainCommandShape("npm run test:coverage 'x'"), 'a quoted argument');
      assert.equal(plainCommandShape('npm run test:coverage $(x)'), 'a command substitution');
      assert.equal(plainCommandShape('npm run test:coverage `x`'), 'a command substitution');
      assert.equal(plainCommandShape('npm run test:coverage <<EOF'), 'a heredoc');
      assert.equal(plainCommandShape('npm run test:coverage # note'), 'a comment');
      assert.equal(plainCommandShape('npm run test:coverage\necho x'), 'a second command line');
      assert.equal(plainCommandShape('npm run test:coverage \\\necho x'), 'a line continuation');
    });

    it('a step resolving to no suite states what it likes', () => {
      assert.deepEqual(
        answer({ run: 'npm run test:coverage' }),
        [],
        'the carrying step is clean, so the conditioned one below is the subject',
      );
      const problems = jobSuiteProblems(
        SUITE,
        jobSuiteArguments(
          {
            [UNIT_SUITE_JOB_ID]: {
              steps: [
                { name: 'Tests', run: 'npm run test:coverage' },
                { name: 'Probe', run: 'node scripts/sync-shared.js', if: 'always()' },
                { name: 'Desktop', run: 'npm run test:desktop:coverage', if: 'always()' },
              ],
            },
          },
          RESOLVING_COMMANDS,
          UNIT_SUITE_JOB_ID,
        ),
      );
      assert.deepEqual(problems, []);
    });

    it('a second carrying step under a condition is refused, the first still carrying', () => {
      const problems = jobSuiteProblems(
        SUITE,
        jobSuiteArguments(
          {
            [UNIT_SUITE_JOB_ID]: {
              steps: [
                { name: 'Tests', run: 'npm run test:coverage' },
                { name: 'Again', run: 'npm run test:coverage', if: 'always()' },
              ],
            },
          },
          RESOLVING_COMMANDS,
          UNIT_SUITE_JOB_ID,
        ),
      );
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes('the step named `Again`'), problems[0]);
    });

    it('a refused step with no name of its own is named by its position', () => {
      const problems = jobSuiteProblems(
        SUITE,
        jobSuiteArguments(
          {
            [UNIT_SUITE_JOB_ID]: { steps: [benign, { run: 'npm run test:coverage', if: 'false' }] },
          },
          RESOLVING_COMMANDS,
          UNIT_SUITE_JOB_ID,
        ),
      );
      assert.ok(problems[0].includes('the step at index 1'), problems[0]);
    });
  });

  it('the leg reaches the evaluator, beside the surfaces it does not depend on', () => {
    const problems = evaluateVerificationInventory(
      makeSurface({
        jobSuite: { absent: false, tokens: ['test:coverage'], globs: [], refusals: [] },
        // Every document surface empty: the leg still prints, the way the
        // gate-argument cross-check does, because it reads none of them.
        docKinds: [],
      }),
    );
    assert.ok(problems.some((p) => p.includes(suiteGlob(SUITE))), problems.join('\n')); // prettier-ignore
  });

  describe('over the shipped tree', () => {
    const read = (path) => readFileSync(join(ROOT, path), 'utf8');
    const shippedJobs = () => readJobs(read, TEST_WORKFLOW_PATH);
    const shippedCommands = () => extractLintSurface(read(PACKAGE_JSON_PATH)).commands;

    it('the shipped job states the shared suite’s registered glob', () => {
      const answer = jobSuiteArguments(shippedJobs(), shippedCommands(), UNIT_SUITE_JOB_ID);
      assert.deepEqual(jobSuiteProblems(SUITE, answer), []);
      assert.deepEqual(answer.refusals, []);
      assert.ok(
        answer.globs.some(isSuite),
        `${UNIT_SUITE_JOB_ID} resolves to: ${answer.globs.map(suiteGlob).join(', ')}`,
      );
    });

    it('the shipped carrying step is one this reading admits', () => {
      // The real-tree lock on the verdict the refusals above are about: the
      // step that carries the suite today states no condition, no tolerance,
      // and nothing beside its command — on its own line or in the manifest
      // command it resolves through — while the job DOES carry a tolerated step
      // elsewhere, which is why a refusal keyed on the job rather than on the
      // carrying step would red what ships.
      const answer = jobSuiteArguments(shippedJobs(), shippedCommands(), UNIT_SUITE_JOB_ID);
      assert.equal(answer.jobContinueOnError, null);
      assert.deepEqual(answer.jobRefusals, []);
      const carrying = answer.steps.filter((step) =>
        step.segments.some((segment) => segment.globs.some(isSuite)),
      );
      assert.equal(carrying.length, 1, JSON.stringify(answer.steps.map((s) => s.name)));
      assert.equal(carrying[0].condition, null);
      assert.equal(carrying[0].continueOnError, null);
      assert.equal(carrying[0].shape, null, JSON.stringify(carrying[0]));
      for (const segment of carrying[0].segments) {
        assert.equal(segment.script?.shape ?? null, null, segment.command);
      }
      assert.ok(
        answer.steps.some((step) => step.continueOnError !== null),
        'the shipped job states a tolerated step of its own',
      );
    });

    it('the step gone, the one behind its `cd` does not stand in for it', () => {
      // The mutation the leg exists for, over the real job — and the step it
      // removes is FOUND rather than spelled: the one whose resolved arguments
      // carry the suite. Spelling it would pin the command string this leg
      // deliberately leaves free, and this case would then red on the very
      // respelling the leg permits.
      const commands = shippedCommands();
      const steps = shippedJobs()[UNIT_SUITE_JOB_ID].steps;
      const answer = (subset) =>
        jobSuiteArguments({ [UNIT_SUITE_JOB_ID]: { steps: subset } }, commands, UNIT_SUITE_JOB_ID);
      const carrying = steps.filter((step) => answer([step]).globs.some(isSuite));
      assert.equal(carrying.length, 1, `one step of \`${UNIT_SUITE_JOB_ID}\` resolves to ${suiteGlob(SUITE)}`); // prettier-ignore
      const rest = steps.filter((step) => !carrying.includes(step));
      // What remains still states a relocated command — the shape a reading
      // without the relocation guard would resolve against the root manifest.
      assert.ok(
        rest.some(
          (step) =>
            typeof step?.run === 'string' &&
            commandSegments(step.run).some((segment) => /^cd(\s|$)/.test(segment)),
        ),
        `\`${UNIT_SUITE_JOB_ID}\` still states a \`cd\`-moved command`,
      );
      const problems = jobSuiteProblems(SUITE, answer(rest));
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes(suiteGlob(SUITE)), problems[0]);
    });
  });
});

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
      readManifestPlatforms(at('{"sessions":[{"id":"p","platform":"a"},{"id":"q","platform":"b"},{"id":"r","platform":"a"}]}'), MANIFEST_PATH), // prettier-ignore
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
  it('the vector meta-schema’s outcome is guarded by its reader, so the guard’s list states no leg for it', () => {
    // The surface the check builds for that field is whatever its reader
    // handed back, and the reader refuses a meta-schema that states no outcome
    // this check can read — so a vacuity leg here would carry a diagnosis the
    // tree cannot produce, and the machinery verdict is what a reader meets.
    assert.ok(
      !EMPTY_SURFACES.some(([key]) => key === 'schemaOutcomes'),
      'EMPTY_SURFACES carries a schemaOutcomes leg — the reader guards that surface instead',
    );
    assert.throws(
      () => readVectorOutcome(() => SCHEMA_WITHOUT_CONST, VECTOR_SCHEMA_PATH),
      InputError,
    );
  });

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

  // The prose sentence under STC-23 records the weld this family holds.
  // Held whitespace-flat so rewrapping the paragraph never reds it.
  const OUTCOME_WELD_SENTENCE =
    'held to each other by the verification-inventory lint: it reds when either states an outcome the other does not, and when the meta-schema stops requiring the field this clause states that outcome under.';

  it('the shipped clause states in prose that the outcome is machine-held', () => {
    const flat = readFileSync(join(ROOT, CORPUS_DOC_PATH), 'utf8').replace(/\s+/g, ' ');
    assert.ok(
      flat.includes(OUTCOME_WELD_SENTENCE),
      `${CORPUS_DOC_PATH} no longer states the outcome weld in prose`,
    );
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
    ['no const', SCHEMA_WITHOUT_CONST, /states no `const` outcome/],
    ['a blank const', '{"properties": {"expected_outcome": {"const": "  "}}}', /states no `const` outcome/], // prettier-ignore
    ['a padded const', '{"properties": {"expected_outcome": {"const": " resolved "}}}', /states no `const` outcome/], // prettier-ignore
    ['a const the outcome grammar cannot read', '{"properties": {"expected_outcome": {"const": "Resolved OK"}}}', /states no `const` outcome/], // prettier-ignore
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

  // The prose sentence under the heading records the weld this family holds.
  // Held whitespace-flat so rewrapping the paragraph never reds it.
  const WELD_SENTENCE =
    'held to each other by the verification-inventory lint: it reds when the two name different classes, and when this document states that class in no heading or in more than one, since either leaves the attribution a guess.';

  it('the shipped document states in prose that the heading is machine-held', () => {
    const flat = readFileSync(join(ROOT, LINT_DOC_PATH), 'utf8').replace(/\s+/g, ' ');
    assert.ok(
      flat.includes(WELD_SENTENCE),
      `${LINT_DOC_PATH} no longer states the per-action heading weld in prose`,
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

// The legs' names live in `INVENTORY_LEGS`. This family holds the check's header
// docblock to that constant both ways, and holds the success line's rendering to it —
// the source lock reads the line's own template segment. What the rendered line says is
// held beside it by the spawned-CLI case, which observes the printed line naming every
// leg. The guide's lint-table row for the gate states its drift classes in the guide's
// own words, which nothing holds to the constant.
describe('the leg set is declared, and the header docblock states it', () => {
  const SOURCE = readFileSync(join(ROOT, 'scripts', 'check-verification-inventory.js'), 'utf8');

  /**
   * The header docblock's bullet list, flattened to one line per bullet.
   *
   * Match form: the header docblock is the source text ahead of the first
   * block-comment terminator. Inside it, a line whose comment body — the line
   * with its leading whitespace and one `*` removed, then trimmed — starts
   * with `- ` opens a bullet; a non-empty body that opens no bullet continues
   * the one above it; the first empty body after the list has started ends the
   * list, which is how the paragraphs below the bullets stay out. Each
   * bullet's text is then whitespace-flattened, and a leg is matched to it by
   * a plain, case-sensitive `startsWith` — no regular expression over the
   * prose, no normalisation of the words themselves.
   *
   * Limit: this proves which legs the bullet list names, and that it names
   * each exactly once. Whether a bullet's remaining sentence still describes
   * what its leg does is prose, and stays review-held — the same limit the
   * check's own header records for the table cells it reads.
   */
  function docblockBullets() {
    const header = SOURCE.slice(0, SOURCE.indexOf('*/'));
    const bullets = [];
    for (const line of header.split('\n')) {
      const body = line.replace(/^\s*\*/, '').trim();
      if (body.startsWith('- ')) bullets.push(body.slice(2));
      else if (bullets.length === 0) continue;
      else if (body === '') break;
      else bullets[bullets.length - 1] += ` ${body}`;
    }
    return bullets.map((b) => b.replace(/\s+/g, ' ').trim());
  }

  it('every leg opens exactly one docblock bullet', () => {
    const bullets = docblockBullets();
    assert.ok(bullets.length > 0, 'the docblock bullet scan read nothing');
    for (const leg of INVENTORY_LEGS) {
      const opened = bullets.filter((b) => b.startsWith(leg.bullet));
      assert.equal(opened.length, 1, `${leg.label}: ${opened.length} bullet(s) open with "${leg.bullet}"`); // prettier-ignore
    }
  });

  it('every docblock bullet is opened by a leg', () => {
    for (const bullet of docblockBullets()) {
      const legs = INVENTORY_LEGS.filter((leg) => bullet.startsWith(leg.bullet));
      assert.equal(legs.length, 1, `no single leg opens the bullet "${bullet.slice(0, 60)}…"`);
    }
  });

  it('the success line is rendered from the constant', () => {
    // Match form: the check's source read through `blankJsLiterals` with
    // literal contents kept (`{ literals: false }`) — comments blanked,
    // template text standing — searched for the success line's own template
    // segment, so a bare `legList()` interpolation elsewhere in the file does
    // not satisfy it. Limit: the text alone; a second template carrying the
    // line's own words would satisfy it, and the CLI case beside it observes
    // the rendered line.
    const view = blankJsLiterals(SOURCE, { literals: false });
    assert.ok(
      view.includes('across the ${legList()} legs match their subjects'),
      'the success line must interpolate legList()',
    );
  });

  it('the rendered list joins the labels the way the success sentence reads', () => {
    assert.equal(legList([{ label: 'a' }]), 'a');
    assert.equal(legList([{ label: 'a' }, { label: 'b' }]), 'a and b');
    assert.equal(legList([{ label: 'a' }, { label: 'b' }, { label: 'c' }]), 'a, b, and c');
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
// classification sits on this check's side of the shared call, and the
// condition it routes on is the extractor's own to recognize — so what is held
// here is the ROUTE: the shared scan reports the anchor condition, and this
// check turns it into the machinery verdict rather than an inventory finding.
describe('the workflow anchor is an input this check reads', () => {
  const deAnchor = (yaml) => yaml.replace(/^jobs:/m, '# jobs:');

  it('the shared extractor reports the anchor condition, and recognizes it as one', () => {
    const workflow = readFileSync(join(ROOT, TEST_WORKFLOW_PATH), 'utf8');
    const read = extractJobIds(deAnchor(workflow));
    assert.deepEqual(read.ids, []);
    assert.equal(read.problems.length, 1, read.problems.join('\n'));
    assert.ok(isJobAnchorProblem(read.problems[0]), read.problems[0]);
    assert.ok(read.problems[0].includes(TEST_WORKFLOW_PATH), read.problems[0]);

    // An anchored workflow with no job keys is a different fact: the extractor
    // reports no problem at all, so that emptiness stays the vacuity leg's.
    assert.deepEqual(extractJobIds(['jobs:', '', 'name: t'].join('\n')), { ids: [], problems: [] });
  });

  it('a workflow the structural read refuses is that same verdict, in its words', () => {
    // The job-suite leg reads the `jobs` MAP, through the workflow-bounds
    // check's own reader, where the citation leg reads the ids from the text.
    // A file the text scan still anchors in but the map read refuses — an
    // `jobs:` block stating nothing — is machinery breakage too, and it reaches the
    // wrapper as this check's InputError rather than as a pin that stopped
    // holding or a type error out of the leg.
    const readFile = (path) =>
      path === TEST_WORKFLOW_PATH ? 'jobs:\n' : readTreeFile(join(ROOT, path));
    assert.deepEqual(extractJobIds('jobs:\n'), { ids: [], problems: [] });
    assert.throws(
      () => auditTree(readFile, (platform) => listActiveSessions(readFile, platform)),
      (error) => {
        assert.ok(error instanceof InputError, `not an InputError: ${error}`);
        assert.ok(error.message.includes(TEST_WORKFLOW_PATH), error.message);
        assert.match(error.message, /`jobs` map/);
        return true;
      },
    );
  });

  it('auditTree refuses a de-anchored workflow as an input, once, naming it', () => {
    const readFile = (path) =>
      path === TEST_WORKFLOW_PATH
        ? deAnchor(readFileSync(join(ROOT, path), 'utf8'))
        : readTreeFile(join(ROOT, path));
    assert.throws(
      () => auditTree(readFile, (platform) => listActiveSessions(readFile, platform)),
      (error) => {
        assert.ok(error instanceof InputError, `not an InputError: ${error}`);
        assert.ok(isJobAnchorProblem(error.message), error.message);
        // The duplicate the reclassification dissolves: the same fact reported
        // again as an inventory that came back empty.
        assert.doesNotMatch(error.message, /no job ids found/);
        return true;
      },
    );
  });
});

describe('command-line readers — an unreadable input is never an empty inventory', () => {
  // The lister takes the reader every sibling surface takes, so the catalogue
  // it reads is an in-memory one here exactly as the baselines and the package
  // manifest are above — no temporary tree, and the fake really is the file the
  // listing path reads.
  /** The catalogue as an in-memory tree; any other path reads as unreadable. */
  const at = (text) => (path) => {
    if (path !== MANIFEST_PATH) throw new InputError(`${path} could not be read — no such entry`);
    return text;
  };

  it('a malformed manifest fails loudly naming the file, not as an empty session catalogue', () => {
    assert.throws(
      () => listActiveSessions(at('{ "sessions": [ '), 'desktop-windows'),
      (error) => {
        assert.ok(error instanceof InputError, `not an InputError: ${error}`);
        assert.ok(error.message.includes(MANIFEST_PATH), error.message);
        // The drift diagnosis this must never be mistaken for.
        assert.ok(!error.message.includes('no active'), error.message);
        return true;
      },
    );
  });

  it('a manifest that parses but carries no sessions array gets its own words', () => {
    assert.throws(
      () => listActiveSessions(at('{ "sessions": {} }'), 'desktop-windows'),
      (error) => {
        assert.ok(error instanceof InputError, `not an InputError: ${error}`);
        assert.match(error.message, /carries no `sessions` array/);
        // Shape, not readability — the file read and parsed perfectly well.
        assert.doesNotMatch(error.message, /could not be read|not parseable/);
        return true;
      },
    );
  });

  it('a malformed session entry takes the shape verdict, whichever way it would escape', () => {
    // Two routes, one verdict. A missing `id` fell through to the session walk
    // and left as a TypeError — the drift exit code, and a stack instead
    // of a diagnosis. A missing `platform` never raised at all: the walk
    // filters on it, so the entry silently dropped, and with one entry in the
    // manifest the catalogue came back EMPTY — routing to the vacuity
    // diagnosis against the manifest. Still the wrong verdict class for a
    // malformed file, which is why the shape guard takes it first.
    for (const [missing, entry] of [
      ['id', { platform: 'desktop-windows' }],
      ['platform', { id: 'd-click' }],
    ]) {
      assert.throws(
        () => listActiveSessions(at(JSON.stringify({ sessions: [entry] })), 'desktop-windows'),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError for ${missing}: ${error}`);
          assert.match(error.message, /shape is what failed here/);
          assert.match(error.message, new RegExp(`sessions\\[0\\]\` entry carries no string \`${missing}\``)); // prettier-ignore
          assert.doesNotMatch(error.message, /could not be read|not parseable/);
          return true;
        },
      );
    }
  });

  it('a non-string truth or overrides takes the shape verdict too', () => {
    // The other keys the session walk path-joins. No spawned leg here: the
    // malformed-entry case below already pins that these reach the CLI as the
    // machinery verdict — what is new is only which keys are covered.
    for (const [key, entry] of [
      ['truth', { id: 'd-click', platform: 'desktop-windows', truth: 5 }],
      ['overrides', { id: 'd-click', platform: 'desktop-windows', overrides: 5 }],
    ]) {
      assert.throws(
        () => listActiveSessions(at(JSON.stringify({ sessions: [entry] })), 'desktop-windows'),
        (error) => {
          assert.ok(error instanceof InputError, `not an InputError for ${key}: ${error}`);
          assert.match(error.message, /shape is what failed here/);
          assert.match(error.message, new RegExp(`sessions\\[0\\]\` entry carries a non-string \`${key}\``)); // prettier-ignore
          assert.doesNotMatch(error.message, /could not be read|not parseable/);
          return true;
        },
      );
    }
  });

  it('the lister reads the catalogue through the reader it is handed, never off disk', () => {
    // The seam this family stands on: hand the lister a tree that exists
    // nowhere on disk and it must answer from that tree. A lister that read
    // the file itself would answer with the shipped catalogue's sessions
    // instead, and every refusal above would be testing a temporary file
    // rather than the injected surface.
    const catalogue = JSON.stringify({
      sessions: [
        { id: 'invented-a', platform: 'desktop-windows' },
        { id: 'invented-b', platform: 'desktop-windows', status: 'retired' },
        { id: 'invented-c', platform: 'extension' },
      ],
    });
    assert.deepEqual(listActiveSessions(at(catalogue), 'desktop-windows'), ['invented-a']);
    assert.deepEqual(listActiveSessions(at(catalogue), 'extension'), ['invented-c']);
    // Nothing else was read: the reader refuses every other path, and a lister
    // reaching past it for the manifest would have thrown that refusal.
    assert.deepEqual(listActiveSessions(at(catalogue), 'no-such-platform'), []);
  });

  it('the platform population and the lister refuse a catalogue in the same words', () => {
    // One shape-guard helper, two callers: the words a malformed catalogue is
    // refused in cannot drift between them, because there is only one
    // statement of them left to drift.
    for (const [text, expected] of [
      ['{ "sessions": {} }', /carries no `sessions` array/],
      ['{"sessions":[{"platform":"desktop-windows"}]}', /entry carries no string `id`/],
      ['{"sessions":[{"id":"d-a"}]}', /entry carries no string `platform`/],
      ['{"sessions":[{"id":"d-a","platform":"desktop-windows","truth":5}]}', /entry carries a non-string `truth`/], // prettier-ignore
      ['{"sessions":[{"id":"d-a","platform":"desktop-windows","overrides":5}]}', /entry carries a non-string `overrides`/], // prettier-ignore
    ]) {
      const words = (call) => {
        try {
          call();
        } catch (error) {
          assert.ok(error instanceof InputError, `not an InputError: ${error}`);
          assert.match(error.message, expected);
          return error.message;
        }
        assert.fail(`no refusal for ${text}`);
      };
      assert.equal(
        words(() => listActiveSessions(at(text), 'desktop-windows')),
        words(() => readSessionCatalogue(at(text), MANIFEST_PATH)),
      );
      assert.equal(
        words(() => readManifestPlatforms(at(text), MANIFEST_PATH)),
        words(() => readSessionCatalogue(at(text), MANIFEST_PATH)),
      );
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
    // The success line names every leg, read at the process boundary: a leg
    // the line stops naming reds here. That it is rendered from the constant
    // is held by the source lock beside this family.
    for (const leg of INVENTORY_LEGS)
      assert.ok(stdout.includes(leg.label), `${leg.label} unnamed: ${stdout}`);
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
    assert.match(stderr, /pin no longer holds/);
    assert.match(stderr, /delta_x/);
  });

  it('exit 2 with the machinery verdict when the manifest will not parse', () => {
    const { status, stderr } = run(tree((files) => files.set(MANIFEST_PATH, '{ "sessions": [ ')));
    assert.equal(status, 2);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /is not parseable JSON/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /pin no longer holds/);
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
    assert.doesNotMatch(stderr, /pin no longer holds/);
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
    assert.match(stderr, /pin no longer holds/);
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

  it('the drift headline holds over a finding that names no verification document', () => {
    // The over-claim this headline was reworded out of: a gate-argument
    // finding names a manifest command and this check's own constant, and no
    // verification document at all — so a headline saying a verification
    // document's inventory drifted described a document the list never named.
    const { status, stderr } = run(
      tree((files) => {
        const manifest = JSON.parse(files.get(PACKAGE_JSON_PATH));
        manifest.scripts[SUFFICIENCY_SCRIPT] = manifest.scripts[SUFFICIENCY_SCRIPT].replace(
          SUFFICIENCY_BASELINE_PATH,
          SUFFICIENCY_BASELINE_PATH.replace('.json', '-moved.json'),
        );
        files.set(PACKAGE_JSON_PATH, JSON.stringify(manifest, null, 2));
      }),
    );
    assert.equal(status, 1, stderr);
    assert.match(stderr, /pin no longer holds/);
    assert.match(stderr, /-moved\.json` for `--baseline`/);
    // The finding beneath the headline names no document under docs/.
    const findings = stderr.split('\n').filter((line) => line.startsWith('    `npm run'));
    assert.equal(findings.length, 1, stderr);
    assert.doesNotMatch(findings[0], /docs\//);
    // The headline this reworded away from, which that finding does not bear out.
    assert.doesNotMatch(stderr, /verification document's inventory drifted/);
  });

  it('exit 2 when a known-diffs baseline is emptied of its keys, not exit 1 demanding the flip', () => {
    // The false green this guard exists for: `{}` satisfies "every present
    // array is empty" vacuously, so without the guard a truncated file would
    // read as a real flip trigger.
    const { status, stderr } = run(tree((files) => files.set(EXT_BASELINE, '{}')));
    assert.equal(status, 2, stderr);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /carries no session keys at all/);
    assert.doesNotMatch(stderr, /pin no longer holds/);
    assert.doesNotMatch(stderr, /carries no known diff/);
  });

  it('exit 2 when the workflow carries no anchor, and the fact is stated once', () => {
    // Before the reclassification this exited 1 under the drift headline, and
    // twice over: once as the extractor's problem and again as an inventory
    // that came back empty. No drift fixture is spawned beside it: this case
    // reads the anchor verdict's own code, and the separation from the drift
    // verdict is pinned by the exit-code case at the end of this family, which
    // holds the two to the absolute 1 and 2 rather than to being unequal.
    const anchor = run(
      tree((files) =>
        files.set(TEST_WORKFLOW_PATH, files.get(TEST_WORKFLOW_PATH).replace(/^jobs:/m, '# jobs:')),
      ),
    );
    assert.equal(anchor.status, 2, anchor.stderr);
    assert.match(anchor.stderr, /could not be used/);
    assert.match(anchor.stderr, /carries no top-level/);
    assert.doesNotMatch(anchor.stderr, /pin no longer holds/);
    assert.doesNotMatch(anchor.stderr, /no job ids found/);
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
    assert.doesNotMatch(stderr, /pin no longer holds/);
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
    assert.match(stderr, /pin no longer holds/);
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
    const listSessions = (platform) => listActiveSessions(readFile, platform);
    const { problems, pinCount } = auditTree(readFile, listSessions);
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(pinCount > 0, 'the audit read no documented entries at all');
  });

  it('the manifest shape guard serves every platform the check discovers', () => {
    // The desktop view is exercised throughout; this drives the same shape
    // guard, `readSessionCatalogue`, through the extension view, so a
    // platform-specific escape cannot hide behind the one view the rest of the
    // suite uses.
    const at = (text) => () => text;
    assert.throws(
      () => listActiveSessions(at(JSON.stringify({ sessions: [{ id: 'ext-a', truth: 5 }] })), 'extension'), // prettier-ignore
      (error) => {
        assert.ok(error instanceof InputError, `not an InputError: ${error}`);
        assert.match(error.message, /carries no string `platform`/);
        return true;
      },
    );
    const catalogue = at(
      JSON.stringify({
        sessions: [
          { id: 'ext-a', platform: 'extension' },
          { id: 'ext-b', platform: 'extension', status: 'retired' },
          { id: 'd-a', platform: 'desktop-windows' },
        ],
      }),
    );
    assert.deepEqual(listActiveSessions(catalogue, 'extension'), ['ext-a']);
    assert.deepEqual(listActiveSessions(catalogue, 'desktop-windows'), ['d-a']);
  });

  it('the shipped tree carries an active session list for every watched platform', () => {
    for (const { platform } of STRICT_WATCH_PLATFORMS) {
      const ids = listActiveSessions((path) => readTreeFile(join(ROOT, path)), platform);
      assert.ok(ids.length > 0, `no active ${platform} sessions discovered`);
    }
  });
});
