/**
 * check-verification-inventory.js — admission test for the inventories the
 * verification documents state in their own text, each held to the code
 * constant, the committed manifest, or the workflow it describes:
 *
 *   - the relaxation coverage lists
 *     (docs/verification/scripted-truth-corpus.md §STC-21): the clause's list
 *     of kinds, and each kind's covered fields, equal the comparator's
 *     exported closed sets;
 *   - the closed kind set §STC-5 states in its own sentence: the kinds that
 *     sentence names equal `RELAX_KINDS` both ways, so the doctrine's two
 *     statements of the closed set cannot drift apart or away from the code;
 *   - the normalization classes (§STC-19): the class table's field tokens
 *     equal the comparator's exported class map, flattened;
 *   - the desktop session catalogue (§STC-22): the clause's session ids equal
 *     the active `desktop-windows` sessions of corpus/manifest.json;
 *   - the predicate catalogue
 *     (docs/verification/sufficiency-lint.md): the per-action table's names
 *     equal the lint's `PREDICATES` ids and every one of those is `fail`
 *     class, and the recording-level table's (predicate, class) pairs equal
 *     the lint's `RECORDING_PREDICATES`;
 *   - the strict-flip watch (§STC-3): per platform, the corpus gate command
 *     in package.json carries `--strict` exactly when that platform's
 *     known-diffs baseline is empty, and `--lint-strict` exactly when that is
 *     true AND none of that platform's ACTIVE committed truths carries a
 *     `fail`-class entry in the sufficiency baseline. Both legs are held in
 *     both directions: a trigger that has come true while the flag is absent
 *     is as red as a flag passed before its trigger. Each gate command must
 *     also name, in its own arguments, the platform and the known-diffs
 *     baseline this watch reads for it — and `sufficiency:check` the baseline
 *     this check reads the `fail`-class population from — because a gate
 *     pointed at another file is being watched against a state it does not
 *     gate on;
 *   - the job citations: every `` `<job>` job `` either verification document
 *     cites names a job of .github/workflows/test.yml.
 *
 * Every set inventory is diffed BOTH ways — a doc entry the code does not have
 * is as red as a code entry the doc does not state. The job citations are the
 * one leg held one-way, by design: every cite must name a real job of the
 * workflow, and a job owes no cite — a workflow may grow a job neither
 * verification document has reason to mention. That leg is also the one place
 * a repeat is legitimate rather than drift: an enumeration states each entry
 * once, but a document may cite the same job in two sentences, so the citation
 * scan collects a repeated cite once instead of refusing it — the carve-out
 * the enumerations' refuse-a-repeat posture is stated against. Every extraction must be
 * non-empty (per scanned document, for the citation leg), every table is
 * selected by its exact header tuple and must match exactly one table, and
 * the job-id extractor's own anchor problems are reported rather than read as
 * an empty green — a check that silently reads part of an inventory, or none
 * of it, would pass forever. An input file the readers refuse — unreadable,
 * unparseable, or parseable but not shaped like the surface it is read as (the
 * session catalogue, a known-diffs baseline, the sufficiency baseline, or the
 * package manifest) — is a third verdict, not a drift finding: they refuse
 * loudly, naming the file and which failure mode it was, and the wrapper exits
 * 2 so machinery breakage never reads as an inventory that went stale.
 *
 * Why the always-on `lint` job: the diff that stales a doc inventory is
 * frequently docs-only, and a docs-only pull request skips every
 * path-filtered test job — the same placement rationale the test-inventory
 * lint records. The behavioural half of these contracts (that the comparator
 * and the lint act on exactly these constants) is the unit suites' work, and
 * a code diff reaches them through the workflow's script filter.
 *
 * Honest limits: this check compares names and tokens, never prose — whether
 * a table row's Rule or Requires column still describes what the code does is
 * review-held. Which exported list a relaxation kind's fields live in is this
 * check's own association (below), so it holds the kinds against
 * `RELAX_KINDS` too: a kind added to the comparator that this check has not
 * learned reds here rather than passing unexamined. Which platforms the
 * strict-flip watch covers is this check's own list on the same footing, so
 * the session catalogue's platform population is diffed against it both ways:
 * a platform the corpus grows sessions for that the watch has not learned reds
 * here rather than going unwatched, and a watched platform the catalogue no
 * longer carries reds equally. Documents outside those named here are outside
 * the citation leg — docs/requirements/replay-sufficiency.md
 * cites no job and is deliberately unscanned, so an empty extraction there
 * could never distinguish a doc with no cites from a broken scan. The job
 * citations are the one leg with no registered clause behind it: both
 * documents state their cites as ordinary prose, so this leg keeps a
 * documentation surface honest rather than guarding a clause, and it
 * deliberately takes no clause-registry row.
 *
 * What the strict-flip watch deliberately does NOT watch: the whole-file
 * `npm run sufficiency:check` surface. Two independent grounds, both recorded
 * so neither has to be rediscovered. First, the frozen historical fixtures
 * that make up half of that surface's corpus carry `fail` findings
 * permanently by design, so its emptiness is not a state the project is
 * moving toward — a watch there would never fire. Second, that script runs in
 * no workflow step and no git hook, so a demand for its `--strict` would
 * change no CI verdict even if the first ground were lifted. The watch
 * therefore scopes to the comparator gate commands the watch covers, which do
 * run in CI, and to the corpus-truth half of the sufficiency baseline, which
 * really can empty.
 *
 * Usage:
 *   node scripts/check-verification-inventory.js  # or: npm run lint:verification-inventory
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  backtickedName,
  backtickedTokens,
  duplicatesIn,
  extractClauseSection,
  flattenWhitespace,
  missingFrom,
  selectTablesByHeader,
  stripFences,
  topLevelListItems,
} from './check-test-inventory.js';
import { TEST_WORKFLOW_PATH, extractJobIds } from './check-doc-closure.js';
import {
  MATCH_STAT_FIELDS,
  NORMALIZED_FIELD_CLASSES,
  PATH_FIELDS,
  RELAX_KINDS,
  SCROLL_AMOUNT_FIELDS,
  discoverSessions,
} from './corpus-compare.js';
import { PREDICATES, RECORDING_PREDICATES } from './sufficiency-lint.js';

/** Repo-relative path of the corpus doctrine whose clauses this check reads. */
export const CORPUS_DOC_PATH = 'docs/verification/scripted-truth-corpus.md';
/** Repo-relative path of the sufficiency-lint doctrine whose tables it reads. */
export const LINT_DOC_PATH = 'docs/verification/sufficiency-lint.md';
/** Repo-relative path of the corpus session catalogue. */
export const MANIFEST_PATH = 'corpus/manifest.json';
/** Repo-relative path of the sufficiency lint's committed baseline. */
export const SUFFICIENCY_BASELINE_PATH = 'packages/shared/tests/fixtures/sufficiency-baseline.json';
/** Repo-relative path of the root package manifest whose scripts wire the gates. */
export const PACKAGE_JSON_PATH = 'package.json';
/** The manifest platform whose session ids §STC-22 enumerates. */
export const DESKTOP_PLATFORM = 'desktop-windows';
/** The manifest platform the browser corpus gate runs. */
export const EXTENSION_PLATFORM = 'extension';

/** The clause stating each relaxation kind's covered fields. */
export const RELAXATION_CLAUSE_ID = 'STC-21';
/** The clause stating the closed relaxation-kind set in its own sentence. */
export const RELAXATION_KINDS_CLAUSE_ID = 'STC-5';
/** The clause stating the normalized field classes. */
export const NORMALIZATION_CLAUSE_ID = 'STC-19';
/** The clause stating the desktop session catalogue. */
export const SESSION_CLAUSE_ID = 'STC-22';
/** The clause stating the per-platform strict-flip triggers. */
export const STRICT_CLAUSE_ID = 'STC-3';

/** Exact header tuple of the normalization-class table. */
export const NORMALIZATION_TABLE_HEADER = ['Class', 'Rule'];
/** Exact header tuple of the per-action predicate table. */
export const PER_ACTION_TABLE_HEADER = ['Predicate', 'Applies to', 'Requires'];
/** Exact header tuple of the recording-level predicate table. */
export const RECORDING_TABLE_HEADER = ['Predicate', 'Class', 'States'];

/** The class every per-action predicate carries. */
export const PER_ACTION_CLASS = 'fail';

/** A field token as the docs write one: lower-case, underscore-separated. */
export const FIELD_TOKEN_RE = /^[a-z][a-z_]*$/;
/** A relaxation kind as the docs write one: lower-case, hyphen-separated. */
export const KIND_TOKEN_RE = /^[a-z][a-z-]*$/;
/** What a readable token looks like in the kind-sentence scope. */
export const KIND_TOKEN_EXPECTATION =
  'relaxation kinds there are lower-case with hyphens, and the sentence names nothing else';
/**
 * The phrase §STC-5 opens its closed-kind sentence with. The extraction is
 * anchored to the sentence, not the clause: the clause also names the sidecar
 * file and a literal `0` elsewhere, and reading the whole clause would drag
 * both into the kind set. Bounded at the sentence's own period, exactly the
 * kind tokens are in scope, so no allow-set and no weakened duplicate guard
 * are needed anywhere.
 */
export const RELAXATION_KINDS_ANCHOR = 'The relaxation kinds are exactly';
/** Non-field backticked tokens §STC-21's list items legitimately carry. */
export const RELAXATION_LITERALS = new Set(['0']);
/** Non-field backticked tokens §STC-19's Class column legitimately carries. */
export const NORMALIZATION_LITERALS = new Set(['coord:x,y']);
/** What a readable token looks like in a field-token scope, for the diagnosis. */
export const FIELD_TOKEN_EXPECTATION =
  'field tokens there are lower-case with underscores, beside only the literals that scope allows';
/** What a readable token looks like in the session-id scope. */
export const SESSION_TOKEN_EXPECTATION =
  'session ids there are `d-` followed by lower-case letters and hyphens';
/** A desktop session id as §STC-22 writes one. */
const SESSION_ID_RE = /`(d-[a-z-]+)`/g;
/** The strict session-id grammar, applied to a whole backticked token. */
export const SESSION_ID_TOKEN_RE = /^d-[a-z-]+$/;
/** What marks a token as *meant* as a session id, however it is then spelled. */
export const SESSION_ID_PREFIX_RE = /^d-/i;
/** A job citation as either verification document writes one. */
const JOB_CITE_RE = /`([a-z0-9-]+)` job/g;

/**
 * Which exported comparator list carries each relaxation kind's covered
 * fields. The association is this check's own — that `applyRelaxation`
 * consumes exactly these lists is the comparator suite's pin — so the kinds
 * are held against `RELAX_KINDS` in both directions below, and a kind this
 * map has not learned reds rather than going unexamined.
 */
export const CODE_RELAXATION_FIELDS = new Map([
  ['match-stats', MATCH_STAT_FIELDS],
  ['scroll-amounts', SCROLL_AMOUNT_FIELDS],
  ['path', PATH_FIELDS],
]);

/** The flat field-token union of the comparator's normalization class map. */
export const CODE_NORMALIZATION_TOKENS = Object.values(NORMALIZED_FIELD_CLASSES).flat();

/** The flag §STC-3 wires once a platform's known-diffs baseline empties. */
export const STRICT_FLAG = '--strict';
/** The flag §STC-3 wires once that AND the fail-free condition hold. */
export const LINT_STRICT_FLAG = '--lint-strict';
/** The argument a corpus gate command names its platform with. */
export const PLATFORM_ARG = '--platform';
/** The argument a gate command names the baseline it locks against with. */
export const BASELINE_ARG = '--baseline';
/** The sufficiency lint's own gate script, read for its baseline argument. */
export const SUFFICIENCY_SCRIPT = 'sufficiency:check';
/** The prefix a fail-class sufficiency-baseline entry carries. */
export const FAIL_ENTRY_PREFIX = 'fail:';
/** A sufficiency-baseline key naming a corpus session's committed truth. */
export const CORPUS_TRUTH_KEY_RE = /^corpus\/sessions\/([^/]+)\//;

/**
 * The platforms the strict-flip watch covers: each one's CI-wired corpus gate
 * command and the known-diffs baseline whose emptiness flips it. Every entry
 * runs in CI, which is what makes a missing flag a real gate hole rather than a
 * cosmetic one.
 */
export const STRICT_WATCH_PLATFORMS = [
  {
    platform: EXTENSION_PLATFORM,
    script: 'corpus:check',
    baselinePath: 'corpus/known-diffs.extension.json',
  },
  {
    platform: DESKTOP_PLATFORM,
    script: 'corpus:check:desktop',
    baselinePath: 'corpus/known-diffs.desktop-windows.json',
  },
];

/**
 * The surface key carrying one watched platform's active session ids. Keyed by
 * a function rather than one hand-written constant per shipped platform, so the
 * vacuity guard, the catalogue diff, and the suite's generated family all name
 * the same surface for a platform nobody has added yet: extending
 * {@link STRICT_WATCH_PLATFORMS} really is the whole edit, and the second
 * platform's guard cannot be the one someone forgets.
 * @param {string} platform
 * @returns {string}
 */
export const activeSessionsKey = (platform) => `activeSessions:${platform}`;

/**
 * Read one string's backticked tokens as field names. A token that is neither
 * field-shaped nor one of the scope's allowed literals is returned as
 * unreadable, never dropped: a renamed, mistyped, or digit-bearing field name
 * must red loudly rather than leave the scanned inventory quietly smaller.
 * @param {string} text the line or cell to read
 * @param {Set<string>} allowed the non-field tokens this scope permits
 * @param {number} [skip] leading tokens another grammar already read (the kind)
 * @returns {{ fields: string[], unreadable: string[] }}
 */
export function readFieldTokens(text, allowed, skip = 0) {
  const fields = [];
  const unreadable = [];
  for (const token of backtickedTokens(text).slice(skip)) {
    if (FIELD_TOKEN_RE.test(token)) fields.push(token);
    else if (!allowed.has(token)) unreadable.push(token);
  }
  return { fields, unreadable };
}

/**
 * The relaxation coverage the clause states: each list item's first backticked
 * token is the kind, and the item's remaining field tokens are that kind's
 * covered fields. An item with no backticked token is unreadable, never
 * skipped, and so is a token after the kind that reads as neither a field nor
 * an allowed literal.
 * @param {string} docText the corpus doctrine's text
 * @returns {{ kinds: string[], fields: [string, string[]][], unreadable: string[],
 *             unreadableTokens: { where: string, token: string, expected: string }[] }}
 */
export function extractRelaxationCoverage(docText) {
  const clause = extractClauseSection(docText, RELAXATION_CLAUSE_ID);
  const kinds = [];
  const fields = [];
  const unreadable = [];
  const unreadableTokens = [];
  for (const item of topLevelListItems(clause)) {
    const tokens = backtickedTokens(item);
    if (tokens.length === 0) {
      unreadable.push(item);
      continue;
    }
    const kind = tokens[0];
    kinds.push(kind);
    // The kind is read by the grammar above and diffed against RELAX_KINDS, so
    // it is skipped here rather than judged against the field shape.
    const read = readFieldTokens(item, RELAXATION_LITERALS, 1);
    fields.push([kind, read.fields]);
    const where = `${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID}'s \`${kind}\` item`;
    for (const token of read.unreadable) {
      unreadableTokens.push({ where, token, expected: FIELD_TOKEN_EXPECTATION });
    }
  }
  return { kinds, fields, unreadable, unreadableTokens };
}

/**
 * The closed relaxation-kind set §STC-5 states, read from the one sentence
 * carrying {@link RELAXATION_KINDS_ANCHOR} and bounded at that sentence's own
 * period. The clause text is whitespace-flattened first, so the anchor is found
 * whatever line the prose wraps on. A backticked token inside the sentence that
 * is not kind-shaped is returned as unreadable, never dropped: a mistyped kind
 * must red loudly rather than leave the stated set quietly smaller than the
 * comparator's.
 * @param {string} docText the corpus doctrine's text
 * @returns {{ kinds: string[],
 *             unreadableTokens: { where: string, token: string, expected: string }[] }}
 */
export function extractStatedKinds(docText) {
  const clause = flattenWhitespace(extractClauseSection(docText, RELAXATION_KINDS_CLAUSE_ID));
  const at = clause.indexOf(RELAXATION_KINDS_ANCHOR);
  if (at === -1) return { kinds: [], unreadableTokens: [] };
  const rest = clause.slice(at);
  const stop = rest.indexOf('.');
  const sentence = stop === -1 ? rest : rest.slice(0, stop + 1);
  const where = `${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}'s kind sentence`;
  const kinds = [];
  const unreadableTokens = [];
  for (const token of backtickedTokens(sentence)) {
    if (KIND_TOKEN_RE.test(token)) kinds.push(token);
    else unreadableTokens.push({ where, token, expected: KIND_TOKEN_EXPECTATION });
  }
  return { kinds, unreadableTokens };
}

/**
 * The whitespace-separated tokens of one npm script command.
 * @param {string} command
 * @returns {string[]}
 */
export function commandTokens(command) {
  return (command ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Whether a command passes a flag, matched token-exactly. Equality over whole
 * tokens is the whole point: a substring test would read `--lint` as
 * `--lint-strict` (both gate commands pass `--lint` today), and would read
 * `--lint-strict` as `--lint` too — either way the watch would report the
 * wrong flag as present.
 * @param {string} command
 * @param {string} flag
 * @returns {boolean}
 */
export function passesFlag(command, flag) {
  return commandTokens(command).includes(flag);
}

/**
 * The value one command passes for an argument — the token that follows it.
 * `null` when the command does not pass the argument at all, or passes it as
 * its last token with nothing to read: both are states the caller must be able
 * to name as a missing value rather than compare as one.
 * @param {string} command
 * @param {string} argument
 * @returns {string | null}
 */
export function argumentValue(command, argument) {
  const tokens = commandTokens(command);
  const at = tokens.indexOf(argument);
  if (at === -1 || at + 1 === tokens.length) return null;
  return tokens[at + 1];
}

/**
 * The one table of a document with an exact header tuple. Selection by the
 * whole header — not the first cell alone — so a sibling table can never be
 * conscripted, and the match count is returned so an ambiguous document is
 * refused rather than silently read through its first match.
 * @param {string} docText
 * @param {string[]} header the exact header cells
 * @returns {{ table: { header: string[], rows: string[][] } | null, matches: number }}
 */
export function selectTableByHeader(docText, header) {
  const { tables, matches } = selectTablesByHeader(docText, { header });
  return { table: matches === 1 ? tables[0] : null, matches };
}

/**
 * The field tokens the normalization-class table's Class column names, from
 * the one table carrying that exact header tuple **inside §STC-19's own clause
 * section**. Bounding the search to the clause is what makes the "§STC-19's
 * Class cell" attribution in this check's messages true: a table moved out from
 * under the clause, or a clause renumbered away from it, reds as zero matches
 * rather than being read from wherever else it landed. A cell token that reads
 * as neither a field nor an allowed literal is unreadable, never skipped.
 * @param {string} docText the corpus doctrine's text
 * @returns {{ tokens: string[], matches: number,
 *             unreadableTokens: { where: string, token: string, expected: string }[] }}
 */
export function extractNormalizationTokens(docText) {
  const clause = extractClauseSection(docText, NORMALIZATION_CLAUSE_ID);
  const { table, matches } = selectTableByHeader(clause, NORMALIZATION_TABLE_HEADER);
  const tokens = [];
  const unreadableTokens = [];
  for (const row of table?.rows ?? []) {
    const read = readFieldTokens(row[0], NORMALIZATION_LITERALS);
    tokens.push(...read.fields);
    const where = `${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}'s Class cell "${row[0]}"`;
    for (const token of read.unreadable) {
      unreadableTokens.push({ where, token, expected: FIELD_TOKEN_EXPECTATION });
    }
  }
  return { tokens, matches, unreadableTokens };
}

/**
 * The desktop session ids §STC-22's clause text names. A backticked token that
 * is plainly meant as a session id — anything carrying the `d-` prefix, in any
 * case — but does not satisfy the strict grammar is unreadable, never dropped:
 * dropping it would leave the manifest-side diff to report the session as one
 * the clause "does not enumerate", which inverts the diagnosis when the clause
 * does name it and only the spelling is off.
 * @param {string} docText the corpus doctrine's text
 * @returns {{ ids: string[],
 *             unreadableTokens: { where: string, token: string, expected: string }[] }}
 */
export function extractSessionIds(docText) {
  const clause = extractClauseSection(docText, SESSION_CLAUSE_ID);
  const ids = [...clause.matchAll(SESSION_ID_RE)].map((m) => m[1]);
  const where = `${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID}'s session list`;
  const unreadableTokens = backtickedTokens(clause)
    .filter((token) => SESSION_ID_PREFIX_RE.test(token) && !SESSION_ID_TOKEN_RE.test(token))
    .map((token) => ({ where, token, expected: SESSION_TOKEN_EXPECTATION }));
  return { ids, unreadableTokens };
}

/**
 * The predicate catalogue the lint document tabulates: the per-action table's
 * names, and the recording-level table's (predicate, class) pairs serialized
 * `"<id> <class>"`. A row cell that is not a lone backticked name is
 * unreadable, never skipped.
 * @param {string} docText the sufficiency-lint doctrine's text
 * @returns {{ perAction: string[], perActionMatches: number, recording: string[],
 *             recordingMatches: number, unreadable: string[] }}
 */
export function extractPredicateTables(docText) {
  const unreadable = [];
  const perActionTable = selectTableByHeader(docText, PER_ACTION_TABLE_HEADER);
  const perAction = [];
  for (const row of perActionTable.table?.rows ?? []) {
    const name = backtickedName(row[0]);
    if (name === null) unreadable.push(`per-action row first cell "${row[0]}"`);
    else perAction.push(name);
  }
  const recordingTable = selectTableByHeader(docText, RECORDING_TABLE_HEADER);
  const recording = [];
  for (const row of recordingTable.table?.rows ?? []) {
    const name = backtickedName(row[0]);
    const klass = backtickedName(row[1]);
    if (name === null || klass === null) {
      unreadable.push(`recording-level row "${row[0]} | ${row[1]}"`);
      continue;
    }
    recording.push(`${name} ${klass}`);
  }
  return {
    perAction,
    perActionMatches: perActionTable.matches,
    recording,
    recordingMatches: recordingTable.matches,
    unreadable,
  };
}

/**
 * The job ids one document cites, read from its text with fenced blocks
 * blanked (a job named inside an illustrative command is not a claim about
 * the workflow's job graph).
 * @param {string} docText
 * @returns {string[]}
 */
export function extractJobCites(docText) {
  return [...stripFences(docText ?? '').matchAll(JOB_CITE_RE)].map((m) => m[1]);
}

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this
 * list — a leg added here is exercised automatically, and the suite holds the
 * list non-empty and its diagnoses distinct. The per-document citation
 * extractions are guarded separately (one leg per scanned document).
 */
export const EMPTY_SURFACES = [
  ['docKinds', `no relaxation kinds found in ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID}`],
  ['docStatedKinds', `no relaxation kinds found in ${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}`], // prettier-ignore
  ['codeKinds', `no relaxation kinds found in the comparator's RELAX_KINDS`],
  ['docNormalizationTokens', `no class field tokens found in ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}`], // prettier-ignore
  ['codeNormalizationTokens', `no field tokens found in the comparator's normalization class map`],
  ['docSessionIds', `no session ids found in ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID}`],
  // One leg per watched platform, derived so a platform added to the watch
  // gains its vacuity guard in the same edit that adds it.
  ...STRICT_WATCH_PLATFORMS.map((w) => [
    activeSessionsKey(w.platform),
    `no active ${w.platform} sessions found in ${MANIFEST_PATH}`,
  ]),
  ['docPerAction', `no per-action predicate rows found in ${LINT_DOC_PATH}`],
  ['codePerAction', `no per-action predicates found in the lint's PREDICATES`],
  ['docRecording', `no recording-level predicate rows found in ${LINT_DOC_PATH}`],
  ['codeRecording', `no recording-level predicates found in the lint's RECORDING_PREDICATES`],
  ['strictWatch', `no platforms read for the ${STRICT_CLAUSE_ID} strict-flip watch`],
  ['workflowJobIds', `no job ids found in ${TEST_WORKFLOW_PATH}`],
];

/**
 * The duplicates guard's legs — the drift the deduplicating set diffs cannot
 * see. Exported for the same suite treatment as {@link EMPTY_SURFACES}.
 */
export const DUPLICATE_SURFACES = [
  ['docKinds', `${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID}'s kind list`],
  ['docStatedKinds', `${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}'s kind sentence`],
  ['docNormalizationTokens', `${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}'s class table`],
  ['docSessionIds', `${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID}'s session list`],
  ['docPerAction', `${LINT_DOC_PATH}'s per-action predicate table`],
  ['docRecording', `${LINT_DOC_PATH}'s recording-level predicate table`],
];

/**
 * Pure core: evaluate every inventory pin.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.docKinds §STC-21's relaxation kinds
 * @param {[string, string[]][]} s.docKindFields its per-kind covered fields
 * @param {string[]} s.relaxUnreadable its unreadable list items
 * @param {string[]} s.docStatedKinds §STC-5's kind-sentence kinds
 * @param {string[]} s.codeKinds the comparator's RELAX_KINDS
 * @param {[string, string[]][]} s.codeKindFields the comparator's per-kind lists
 * @param {string[]} s.docNormalizationTokens §STC-19's class-column field tokens
 * @param {number} s.normalizationTableMatches how many tables carry its header tuple
 * @param {string[]} s.codeNormalizationTokens the comparator's class map, flattened
 * @param {string[]} s.docSessionIds §STC-22's session ids
 * @param {string[]} s[activeSessionsKey(platform)] one list per watched platform:
 *   that platform's active manifest session ids. The desktop platform's list is
 *   also §STC-22's diff partner; each is its own vacuity leg.
 * @param {string[]} s.docPerAction the per-action table's predicate names
 * @param {number} s.perActionTableMatches how many tables carry its header tuple
 * @param {string[]} s.codePerAction the lint's per-action predicate ids
 * @param {string[]} s.codeNonFailPerAction those whose class is not `fail`
 * @param {string[]} s.docRecording the recording-level table's `"<id> <class>"` pairs
 * @param {number} s.recordingTableMatches how many tables carry its header tuple
 * @param {string[]} s.codeRecording the lint's recording-level pairs
 * @param {string[]} s.predicateUnreadable unreadable predicate-table cells
 * @param {{ where: string, token: string, expected: string }[]} s.unreadableTokens
 *   backticked tokens a scanned scope carries that its grammar cannot read, each
 *   with the expectation its own scope states
 * @param {{ path: string, cites: string[] }[]} s.docCites per-document job citations
 * @param {{ platform: string, script: string, baselinePath: string,
 *           knownDiffsEmpty: boolean, failFree: boolean, strict: boolean,
 *           lintStrict: boolean, platformArg: string | null,
 *           baselineArg: string | null }[]} s.strictWatch per-platform gate
 *   state: whether each trigger has come true, whether its flag is passed, and
 *   the platform and baseline the gate command itself names
 * @param {string[]} s.manifestPlatforms every platform the session catalogue carries
 * @param {string[]} s.watchedPlatforms the platforms the strict-flip watch covers
 * @param {string | null} s.sufficiencyBaselineArg the baseline `sufficiency:check` names
 * @param {string[]} s.workflowJobIds test.yml's job ids
 * @returns {string[]} problems; empty when every inventory holds
 */
export function evaluateVerificationInventory(s) {
  const problems = [];

  // Unreadable input is reported ahead of the vacuous guards: the likeliest
  // cause of an empty parse is a surface that stopped being readable, so the
  // most useful line must survive the early return.
  for (const item of s.relaxUnreadable) {
    problems.push(`${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID} has a list item naming no kind — "${item}" — each item leads with its backticked kind`); // prettier-ignore
  }
  for (const cell of s.predicateUnreadable) {
    problems.push(`${LINT_DOC_PATH} has a predicate cell the scan cannot read — ${cell} — predicate and class cells are lone backticked names`); // prettier-ignore
  }
  for (const { where, token, expected } of s.unreadableTokens) {
    problems.push(`${where} carries \`${token}\`, which the scan cannot read — ${expected} — and a token the scan cannot read is an inventory entry it would silently drop`); // prettier-ignore
  }
  for (const [count, header, where] of [
    [s.normalizationTableMatches, NORMALIZATION_TABLE_HEADER, `${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}`], // prettier-ignore
    [s.perActionTableMatches, PER_ACTION_TABLE_HEADER, `${LINT_DOC_PATH}'s per-action catalogue`],
    [s.recordingTableMatches, RECORDING_TABLE_HEADER, `${LINT_DOC_PATH}'s recording-level catalogue`], // prettier-ignore
  ]) {
    if (count !== 1) {
      problems.push(`${where}: ${count} table(s) carry the header \`${header.join(' | ')}\` — the scan reads exactly one`); // prettier-ignore
    }
  }
  for (const { path, cites } of s.docCites) {
    if (cites.length === 0) {
      problems.push(`no job citations found in ${path} — a scanned document that cites nothing cannot tell a scan that broke from a document that legitimately stopped citing, so this reds either way: restore a job cite, or drop the document from this check's scanned set (its docCites list and the header note naming what is scanned)`); // prettier-ignore
    }
  }

  let vacuous = s.docCites.some((d) => d.cites.length === 0);
  for (const [key, message] of EMPTY_SURFACES) {
    if (s[key].length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make the set diffs meaningless

  for (const [key, what] of DUPLICATE_SURFACES) {
    problems.push(...duplicatesIn(s[key], what));
  }

  const docFields = new Map(s.docKindFields);
  const codeFields = new Map(s.codeKindFields);
  problems.push(
    ...missingFrom(s.docKinds, s.codeKinds, `is a relaxation kind ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID} states but the comparator's RELAX_KINDS does not carry`), // prettier-ignore
    ...missingFrom(s.codeKinds, s.docKinds, `is a relaxation kind the comparator carries but ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID} does not state`), // prettier-ignore
    ...missingFrom(s.docStatedKinds, s.codeKinds, `is a relaxation kind ${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}'s kind sentence states but the comparator's RELAX_KINDS does not carry`), // prettier-ignore
    ...missingFrom(s.codeKinds, s.docStatedKinds, `is a relaxation kind the comparator carries but ${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}'s kind sentence does not state`), // prettier-ignore
    ...missingFrom(s.codeKinds, [...codeFields.keys()], `is in the comparator's RELAX_KINDS but scripts/check-verification-inventory.js knows no field list for it — extend CODE_RELAXATION_FIELDS in the same change`), // prettier-ignore
    ...missingFrom([...codeFields.keys()], s.codeKinds, `has a field list in scripts/check-verification-inventory.js but is not a comparator relaxation kind`), // prettier-ignore
    ...missingFrom(s.manifestPlatforms, s.watchedPlatforms, `has sessions in ${MANIFEST_PATH} but is a platform the ${STRICT_CLAUSE_ID} strict-flip watch has not learned — extend STRICT_WATCH_PLATFORMS in scripts/check-verification-inventory.js in the same change, so the platform's gate is watched from the moment its sessions land`), // prettier-ignore
    ...missingFrom(s.watchedPlatforms, s.manifestPlatforms, `is a platform the ${STRICT_CLAUSE_ID} strict-flip watch covers but ${MANIFEST_PATH} carries no session for`), // prettier-ignore
    ...missingFrom(s.docNormalizationTokens, s.codeNormalizationTokens, `is a field token ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID} normalizes but the comparator's class map does not carry`), // prettier-ignore
    ...missingFrom(s.codeNormalizationTokens, s.docNormalizationTokens, `is a field token the comparator's class map normalizes but ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}'s table does not state`), // prettier-ignore
    ...missingFrom(s.docSessionIds, s[activeSessionsKey(DESKTOP_PLATFORM)], `is a session ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID} enumerates but ${MANIFEST_PATH} carries no active ${DESKTOP_PLATFORM} session for`), // prettier-ignore
    ...missingFrom(s[activeSessionsKey(DESKTOP_PLATFORM)], s.docSessionIds, `is an active ${DESKTOP_PLATFORM} session in ${MANIFEST_PATH} but ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID} does not enumerate it`), // prettier-ignore
    ...missingFrom(s.docPerAction, s.codePerAction, `is a per-action predicate ${LINT_DOC_PATH} tabulates but the lint's PREDICATES does not define`), // prettier-ignore
    ...missingFrom(s.codePerAction, s.docPerAction, `is a per-action predicate the lint defines but ${LINT_DOC_PATH}'s table does not carry`), // prettier-ignore
    ...missingFrom(s.docRecording, s.codeRecording, `is a recording-level (predicate, class) pair ${LINT_DOC_PATH} tabulates but the lint's RECORDING_PREDICATES does not define`), // prettier-ignore
    ...missingFrom(s.codeRecording, s.docRecording, `is a recording-level (predicate, class) pair the lint defines but ${LINT_DOC_PATH}'s table does not carry`), // prettier-ignore
  );

  for (const kind of s.docKinds) {
    // Per-kind duplicates first: the set diffs below deduplicate, so a field
    // stated twice inside one kind's item is invisible to them.
    problems.push(
      ...duplicatesIn(docFields.get(kind) ?? [], `${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID}'s \`${kind}\` covered-field list`), // prettier-ignore
    );
    if (!codeFields.has(kind)) continue; // already reported by the kind diff
    problems.push(
      ...missingFrom(docFields.get(kind) ?? [], codeFields.get(kind), `is a field ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID} says \`${kind}\` covers but the comparator's list for it does not carry`), // prettier-ignore
      ...missingFrom(codeFields.get(kind), docFields.get(kind) ?? [], `is a field the comparator's \`${kind}\` list covers but ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID} does not state`), // prettier-ignore
    );
  }

  for (const id of s.codeNonFailPerAction) {
    problems.push(`the lint's per-action predicate \`${id}\` is not \`${PER_ACTION_CLASS}\` class, which ${LINT_DOC_PATH}'s per-action heading states of all of them`); // prettier-ignore
  }

  const jobIds = new Set(s.workflowJobIds);
  for (const { path, cites } of s.docCites) {
    for (const cite of [...new Set(cites)]) {
      if (!jobIds.has(cite)) {
        problems.push(`${path} cites \`${cite}\` as a job but ${TEST_WORKFLOW_PATH} has no such job`); // prettier-ignore
      }
    }
  }

  problems.push(...strictWatchProblems(s.strictWatch));
  problems.push(...gateArgumentProblems(s.strictWatch, s.sufficiencyBaselineArg));

  return problems;
}

/**
 * The gate commands name what this check reads for them. Each watched
 * platform's command carries its own `--platform` and `--baseline` arguments,
 * and this check reads a platform constant and a baseline path beside them; if
 * the two ever name different things, every verdict above is computed from a
 * file the gate does not gate on — a loud problem that must name both sides,
 * because either one could be the side that moved. The sufficiency lint's own
 * gate is held the same way: its `--baseline` is the file the `fail`-class
 * population is read from.
 * @param {object[]} watch the per-platform gate state, carrying each command's
 *   own `--platform` and `--baseline` values
 * @param {string | null} sufficiencyBaselineArg the baseline `sufficiency:check` names
 * @returns {string[]} problems; empty when every gate names what this check reads
 */
export function gateArgumentProblems(watch, sufficiencyBaselineArg) {
  const problems = [];
  const named = (value) => (value === null ? 'nothing' : `\`${value}\``);
  for (const w of watch) {
    for (const [argument, passed, read, what] of [
      [PLATFORM_ARG, w.platformArg, w.platform, 'the platform this watch reads it as'],
      [BASELINE_ARG, w.baselineArg, w.baselinePath, 'the baseline this watch reads for it'],
    ]) {
      if (passed !== read) {
        problems.push(`\`npm run ${w.script}\` passes ${named(passed)} for \`${argument}\` while ${what} is \`${read}\` — the gate and the watch must name the same one, or the watch is reading a state the gate does not gate on`); // prettier-ignore
      }
    }
  }
  if (sufficiencyBaselineArg !== SUFFICIENCY_BASELINE_PATH) {
    problems.push(`\`npm run ${SUFFICIENCY_SCRIPT}\` passes ${named(sufficiencyBaselineArg)} for \`${BASELINE_ARG}\` while this check reads the \`fail\`-class population from \`${SUFFICIENCY_BASELINE_PATH}\` — the gate and this check must name the same baseline`); // prettier-ignore
  }
  return problems;
}

/**
 * The strict-flip watch's legs, per platform and in both directions. Each flag
 * has its own trigger — the axis §STC-3 states — so they are never coupled
 * here: a platform can owe `--strict` while `--lint-strict` is correctly still
 * absent.
 *
 * The `--lint-strict` population is ACTIVE-filtered on purpose. The comparator
 * lints the platform's active sessions only, while a retired session keeps its
 * manifest entry (§STC-14) and its truth file on disk — and the sufficiency
 * lint's standing corpus is a directory walk of `corpus/sessions` (SL-5), so
 * that truth keeps its baseline entry whatever its status. An unfiltered scan
 * would therefore let one retired session's `fail` entry hold the trigger shut
 * forever, which is the drift this watch exists to prevent.
 * @param {object[]} watch the per-platform gate state
 * @returns {string[]} problems; empty when every gate matches its triggers
 */
export function strictWatchProblems(watch) {
  const problems = [];
  for (const w of watch) {
    const gate = `\`npm run ${w.script}\``;
    const cite = `${CORPUS_DOC_PATH} §${STRICT_CLAUSE_ID}`;
    if (w.knownDiffsEmpty && !w.strict) {
      problems.push(`${w.baselinePath} carries no known diff, so ${cite} wires \`${STRICT_FLAG}\` for ${w.platform} — ${gate} does not pass it: flip the gate, or regenerate the baseline if its emptiness is not the real state`); // prettier-ignore
    }
    if (!w.knownDiffsEmpty && w.strict) {
      problems.push(`${gate} passes \`${STRICT_FLAG}\` while ${w.baselinePath} still carries a known diff — ${cite} wires that flag only once the baseline empties`); // prettier-ignore
    }
    const unmet = [
      ...(w.knownDiffsEmpty ? [] : [`${w.baselinePath} still carries a known diff`]),
      ...(w.failFree ? [] : [`${SUFFICIENCY_BASELINE_PATH} still carries a \`fail\`-class entry on an active ${w.platform} corpus truth`]), // prettier-ignore
    ];
    if (unmet.length === 0 && !w.lintStrict) {
      problems.push(`${w.baselinePath} carries no known diff and no active ${w.platform} corpus truth carries a \`fail\`-class entry in ${SUFFICIENCY_BASELINE_PATH}, so ${cite} wires \`${LINT_STRICT_FLAG}\` for ${w.platform} — ${gate} does not pass it`); // prettier-ignore
    }
    if (unmet.length > 0 && w.lintStrict) {
      problems.push(`${gate} passes \`${LINT_STRICT_FLAG}\` while ${unmet.join(' and ')} — ${cite} wires that flag only once both of its conditions hold`); // prettier-ignore
    }
  }
  return problems;
}

/**
 * Read every surface from a tree and evaluate the inventories.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {(platform: string) => string[]} listActive one platform's active session ids
 * @returns {{ problems: string[], pinCount: number }}
 */
export function auditTree(readFile, listActive) {
  const corpusDoc = readFile(CORPUS_DOC_PATH);
  const lintDoc = readFile(LINT_DOC_PATH);
  const relaxation = extractRelaxationCoverage(corpusDoc);
  const statedKinds = extractStatedKinds(corpusDoc);
  const normalization = extractNormalizationTokens(corpusDoc);
  const sessions = extractSessionIds(corpusDoc);
  const predicates = extractPredicateTables(lintDoc);
  const jobs = extractJobIds(readFile(TEST_WORKFLOW_PATH));

  // The strict-flip watch's inputs. Active discovery runs once per platform and
  // feeds both the required-key guards on the two baselines and the
  // active-filtered fail-entry population.
  const activeByPlatform = new Map(
    STRICT_WATCH_PLATFORMS.map((w) => [w.platform, listActive(w.platform)]),
  );
  const allActive = [...activeByPlatform.values()].flat();
  const sufficiency = readSufficiencyBaseline(readFile, SUFFICIENCY_BASELINE_PATH, allActive);
  const gateCommands = readGateCommands(readFile, PACKAGE_JSON_PATH, [
    ...STRICT_WATCH_PLATFORMS.map((w) => w.script),
    SUFFICIENCY_SCRIPT,
  ]);
  const strictWatch = STRICT_WATCH_PLATFORMS.map((w) => {
    const active = activeByPlatform.get(w.platform);
    const command = gateCommands.get(w.script);
    return {
      platform: w.platform,
      script: w.script,
      baselinePath: w.baselinePath,
      knownDiffsEmpty: readKnownDiffsBaseline(readFile, w.baselinePath, active).empty,
      failFree: corpusFailEntries(sufficiency, active).length === 0,
      strict: passesFlag(command, STRICT_FLAG),
      lintStrict: passesFlag(command, LINT_STRICT_FLAG),
      platformArg: argumentValue(command, PLATFORM_ARG),
      baselineArg: argumentValue(command, BASELINE_ARG),
    };
  });

  const s = {
    docKinds: relaxation.kinds,
    docKindFields: relaxation.fields,
    relaxUnreadable: relaxation.unreadable,
    docStatedKinds: statedKinds.kinds,
    codeKinds: [...RELAX_KINDS],
    codeKindFields: [...CODE_RELAXATION_FIELDS],
    docNormalizationTokens: normalization.tokens,
    normalizationTableMatches: normalization.matches,
    codeNormalizationTokens: CODE_NORMALIZATION_TOKENS,
    docSessionIds: sessions.ids,
    // One active-session surface per watched platform, from the same derived
    // keys the vacuity legs read, so neither can be added without the other.
    ...Object.fromEntries(
      STRICT_WATCH_PLATFORMS.map((w) => [
        activeSessionsKey(w.platform),
        activeByPlatform.get(w.platform),
      ]),
    ),
    docPerAction: predicates.perAction,
    perActionTableMatches: predicates.perActionMatches,
    codePerAction: PREDICATES.map((p) => p.id),
    codeNonFailPerAction: PREDICATES.filter((p) => p.class !== PER_ACTION_CLASS).map((p) => p.id),
    docRecording: predicates.recording,
    recordingTableMatches: predicates.recordingMatches,
    codeRecording: RECORDING_PREDICATES.map((p) => `${p.id} ${p.class}`),
    predicateUnreadable: predicates.unreadable,
    unreadableTokens: [
      ...relaxation.unreadableTokens,
      ...statedKinds.unreadableTokens,
      ...normalization.unreadableTokens,
      ...sessions.unreadableTokens,
    ],
    docCites: [
      { path: CORPUS_DOC_PATH, cites: extractJobCites(corpusDoc) },
      { path: LINT_DOC_PATH, cites: extractJobCites(lintDoc) },
    ],
    strictWatch,
    manifestPlatforms: readManifestPlatforms(readFile, MANIFEST_PATH),
    watchedPlatforms: STRICT_WATCH_PLATFORMS.map((w) => w.platform),
    sufficiencyBaselineArg: argumentValue(gateCommands.get(SUFFICIENCY_SCRIPT), BASELINE_ARG),
    workflowJobIds: jobs.ids,
  };
  return {
    problems: [...jobs.problems, ...evaluateVerificationInventory(s)],
    pinCount:
      s.docKinds.length +
      s.docStatedKinds.length +
      s.docNormalizationTokens.length +
      s.docSessionIds.length +
      s.docPerAction.length +
      s.docRecording.length +
      s.strictWatch.length +
      s.docCites.reduce((n, d) => n + new Set(d.cites).size, 0),
  };
}

/**
 * An input surface the command line cannot read at all. Machinery breakage,
 * kept apart from inventory drift: a file that will not read or parse says
 * nothing about whether an inventory is current, and reporting it as an empty
 * extraction would name the wrong file to fix.
 */
export class InputError extends Error {}

/**
 * Read one file of the tree, refusing loudly rather than yielding an empty
 * surface. An unreadable document is not a document stating nothing.
 * @param {string} path repo-relative path
 * @returns {string}
 * @throws {InputError} naming the file and the underlying read error
 */
export function readTreeFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new InputError(`${path} could not be read — ${error.message}`);
  }
}

/**
 * The shape verdict's words, shared by every reader below so a malformed input
 * always names itself as a shape failure and never as a readability one.
 * @param {string} path the file that parsed but does not fit
 * @param {string} subject what the file is, for the diagnosis
 * @param {string} what the way it does not fit
 * @returns {InputError}
 */
function shapeError(path, subject, what) {
  return new InputError(
    `${path} parses but ${what} — ${subject}'s shape is what failed here, not its readability`,
  );
}

/**
 * Parse one JSON input read through the injected reader, keeping an unparseable
 * file distinct from a well-formed one that says nothing.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path
 * @returns {any}
 * @throws {InputError} naming the file
 */
function parseJsonInput(readFile, path) {
  const raw = readFile(path); // unreadable → the reader's own words
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${path} is not parseable JSON — ${error.message}`);
  }
}

/** A parsed value usable as a keyed record. */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One platform's known-diffs baseline, reduced to the single fact the watch
 * needs: whether it still carries a diff.
 *
 * Emptiness is only computed once the file has proved it is the whole
 * baseline. A truncated or hand-emptied file would otherwise read as "every
 * known diff is fixed" and demand the strict flip — the exact false green this
 * watch exists to prevent — so a baseline with no keys at all, or one missing a
 * key for an active session, is a machinery verdict naming the baseline. The
 * required-key set is derived from the same active-session discovery the
 * comparator runs on, and mirrors the comparator's own refusal to compare
 * against a baseline that has no key for a session it is about to diff.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path the baseline's repo-relative path
 * @param {string[]} requiredIds the platform's active session ids
 * @returns {{ empty: boolean }}
 * @throws {InputError} naming the baseline and which way it failed
 */
export function readKnownDiffsBaseline(readFile, path, requiredIds) {
  const subject = 'the known-diffs baseline';
  const parsed = parseJsonInput(readFile, path);
  if (!isRecord(parsed)) {
    throw shapeError(path, subject, 'is not a JSON object of per-session entry lists');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw shapeError(path, subject, 'carries no session keys at all');
  }
  for (const [id, list] of entries) {
    if (!Array.isArray(list)) {
      throw shapeError(path, subject, `its \`${id}\` entry is not an array of diff entries`);
    }
  }
  const missing = requiredIds.filter((id) => !(id in parsed));
  if (missing.length > 0) {
    throw shapeError(path, subject, `it carries no key for active session(s) ${missing.join(', ')}`); // prettier-ignore
  }
  return { empty: entries.every(([, list]) => list.length === 0) };
}

/**
 * The sufficiency lint's committed baseline, validated to the depth the watch
 * reads it. Same reasoning as the known-diffs guard: a truncated baseline would
 * read as "no corpus truth carries a fail-class finding" and demand
 * `--lint-strict`, so a keyless file, a non-array entry list, a non-string
 * entry, or a missing `corpus/sessions/` key for an active session is a
 * machinery verdict naming the baseline.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path the baseline's repo-relative path
 * @param {string[]} requiredIds every watched platform's active session ids
 * @returns {Record<string, string[]>} the parsed baseline
 * @throws {InputError} naming the baseline and which way it failed
 */
export function readSufficiencyBaseline(readFile, path, requiredIds) {
  const subject = 'the sufficiency baseline';
  const parsed = parseJsonInput(readFile, path);
  if (!isRecord(parsed)) {
    throw shapeError(path, subject, 'is not a JSON object of per-file finding lists');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw shapeError(path, subject, 'carries no file keys at all');
  }
  for (const [key, list] of entries) {
    if (!Array.isArray(list)) {
      throw shapeError(path, subject, `its \`${key}\` entry is not an array of findings`);
    }
    for (const finding of list) {
      if (typeof finding !== 'string') {
        throw shapeError(path, subject, `its \`${key}\` entry carries a non-string finding`);
      }
    }
  }
  const covered = new Set();
  for (const [key] of entries) {
    const match = CORPUS_TRUTH_KEY_RE.exec(key);
    if (match) covered.add(match[1]);
  }
  const missing = requiredIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    throw shapeError(path, subject, `it carries no \`corpus/sessions/\` entry for active session(s) ${missing.join(', ')}`); // prettier-ignore
  }
  return parsed;
}

/**
 * Every platform the session catalogue carries a session for, distinct and in
 * file order. The population is the WHOLE catalogue, not its active slice —
 * and a platform whose sessions have all been retired has no green
 * configuration, deliberately: covering it in the watch reds on that
 * platform's active-session vacuity leg, and dropping it from the watch reds
 * here. Nothing in the tree resolves that state, which is the point — it
 * resolves when the maintainer either reactivates a session for the platform
 * or retires the platform's watch entry, gate command, and baseline together.
 * Editing this check is the deliberate act there, exactly as extending it is.
 *
 * Validated to the depth it reads, like the sibling readers above — a
 * catalogue that is not a catalogue must fail as itself, never as a platform
 * the watch has not learned.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path the catalogue's repo-relative path
 * @returns {string[]}
 * @throws {InputError} naming the catalogue and which way it failed
 */
export function readManifestPlatforms(readFile, path) {
  const subject = 'the session catalogue';
  const parsed = parseJsonInput(readFile, path);
  if (!Array.isArray(parsed?.sessions)) {
    throw shapeError(path, subject, 'carries no `sessions` array');
  }
  const platforms = [];
  parsed.sessions.forEach((session, i) => {
    if (typeof session?.platform !== 'string') {
      throw shapeError(
        path,
        subject,
        `its \`sessions[${i}]\` entry carries no string \`platform\``,
      );
    }
    if (!platforms.includes(session.platform)) platforms.push(session.platform);
  });
  return platforms;
}

/**
 * The fail-class entries the sufficiency baseline records against one
 * platform's ACTIVE corpus truths, each returned with the key it sits under so
 * a caller can name what is holding the trigger shut. A retired session keeps
 * its truth on disk and — because SL-5's standing corpus is a directory walk of
 * `corpus/sessions` — its baseline entry with it; those entries are
 * deliberately outside this population, since the comparator's `--lint-strict`
 * never lints them.
 * @param {Record<string, string[]>} baseline a validated sufficiency baseline
 * @param {string[]} activeIds the platform's active session ids
 * @returns {string[]} `"<key> <entry>"` per fail-class entry, in file order
 */
export function corpusFailEntries(baseline, activeIds) {
  const active = new Set(activeIds);
  const found = [];
  for (const [key, list] of Object.entries(baseline)) {
    const match = CORPUS_TRUTH_KEY_RE.exec(key);
    if (!match || !active.has(match[1])) continue;
    for (const finding of list) {
      if (finding.startsWith(FAIL_ENTRY_PREFIX)) found.push(`${key} ${finding}`);
    }
  }
  return found;
}

/**
 * The gate commands the root manifest defines, read as a small local view of
 * its `scripts` map. A named script that is missing or is not a command string
 * is a machinery verdict: the watch cannot say whether a gate carries its flag
 * when it cannot find the gate.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path the manifest's repo-relative path
 * @param {string[]} scriptKeys the script names the watch reads
 * @returns {Map<string, string>} each named script's command string
 * @throws {InputError} naming the manifest and which way it failed
 */
export function readGateCommands(readFile, path, scriptKeys) {
  const subject = 'the package manifest';
  const parsed = parseJsonInput(readFile, path);
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    throw shapeError(path, subject, 'carries no `scripts` object');
  }
  const commands = new Map();
  for (const key of scriptKeys) {
    const command = parsed.scripts[key];
    if (typeof command !== 'string' || command.trim() === '') {
      throw shapeError(path, subject, `its \`scripts\` map defines no \`${key}\` command`);
    }
    commands.set(key, command);
  }
  return commands;
}

/**
 * One platform's active session ids from the manifest. A broken manifest is not
 * an empty catalogue — diagnosing it as one would send the reader to §STC-22's
 * clause, which is not the file at fault — so each way the file can fail this
 * check gets its own words: unreadable, unparseable, or parseable but not
 * shaped like a session catalogue. The shape check runs to the depth `discoverSessions`
 * relies on: string `id` and `platform` always, and — mirroring exactly the
 * values that walk would path-join — `truth` whenever it is non-nullish and
 * `overrides` whenever it is truthy. A present-but-nullish `truth` or a falsy
 * `overrides` is deliberately not flagged: the walk substitutes its default or
 * skips the join, so nothing reaches `join` to fail on.
 *
 * The guards run over every entry, not only the discovered platform's, and that
 * is deliberate: an entry of another platform with a mistyped key is joined by
 * that platform's own comparator runs, so a malformed catalogue is refused
 * wholesale. Whatever route a malformation would otherwise take — a raw type
 * error out of a path-joined field on a discovered entry, or a silently dropped
 * entry when `platform` is non-string, leaving the catalogue no longer
 * reflecting the manifest — the shape verdict takes it first, because a
 * malformed catalogue must fail as itself and never as inventory drift.
 *
 * The manifest is read here and again by `discoverSessions`. That is deliberate:
 * validating the shape needs the parsed document, and session discovery stays
 * the comparator's single implementation rather than being reimplemented here.
 * Nothing wraps the `discoverSessions` call — on a manifest this function has
 * already found well-formed, a break in ITS contract is a code defect that must
 * surface as itself, never be relabelled a bad input file.
 *
 * The platform is a parameter rather than a bound constant so this stays the
 * one guarded entry point for every platform the check discovers sessions for:
 * the fused shape validation below serves them all, and `discoverSessions` is
 * still called exactly once, in one place.
 * @param {string} platform the manifest platform whose sessions to list
 * @param {string} [manifestPath] repo-relative path to the session catalogue
 * @returns {string[]}
 * @throws {InputError} naming the manifest and which way it failed
 */
export function listActiveSessions(platform, manifestPath = MANIFEST_PATH) {
  const raw = readTreeFile(manifestPath); // unreadable → that reader's words
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${manifestPath} is not parseable JSON — ${error.message}`);
  }
  const shapeProblem = (what) => shapeError(manifestPath, 'the session catalogue', what);
  if (!Array.isArray(manifest?.sessions)) {
    throw shapeProblem('carries no `sessions` array');
  }
  manifest.sessions.forEach((session, i) => {
    for (const field of ['id', 'platform']) {
      if (typeof session?.[field] !== 'string') {
        throw shapeProblem(`its \`sessions[${i}]\` entry carries no string \`${field}\``);
      }
    }
    // The optional keys `discoverSessions` path-joins, each guarded exactly as
    // that walk consumes it: `truth` falls back when nullish, `overrides` is
    // skipped when falsy — so only the values it would really join are checked.
    if (session.truth != null && typeof session.truth !== 'string') {
      throw shapeProblem(`its \`sessions[${i}]\` entry carries a non-string \`truth\``);
    }
    if (session.overrides && typeof session.overrides !== 'string') {
      throw shapeProblem(`its \`sessions[${i}]\` entry carries a non-string \`overrides\``);
    }
  });
  return discoverSessions(manifestPath, platform)
    .filter((session) => session.status === 'active')
    .map((session) => session.id);
}

/* c8 ignore start — the CLI wrapper drives the readers above and formats the
 * verdict; the extraction, evaluation, and reader cores are unit-tested, and
 * the wrapper's three exit codes are pinned at the process boundary by the
 * spawned-CLI suite in packages/shared/tests/unit. */
function run() {
  let audit;
  try {
    audit = auditTree(readTreeFile, (platform) => listActiveSessions(platform));
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(
      `✗ an input this check reads could not be used:\n` +
        `    ${error.message}\n\n` +
        `  This is machinery breakage, not an inventory that drifted — fix the file named\n` +
        `  above. Exit 2 keeps it distinct from the drift verdict (exit 1).\n`,
    );
    process.exit(2);
  }
  const { problems, pinCount } = audit;

  if (problems.length) {
    console.error(
      `✗ a verification document's inventory drifted from what it describes:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  A finding naming two surfaces — a document, a code constant, the manifest, the\n` +
        `  workflow, or a gate command's own arguments — is telling you the two no longer state\n` +
        `  the same thing: update both sides in the same change, and read the finding for which\n` +
        `  side moved. A gate-watch FLAG finding names no second statement, so its remedy is the\n` +
        `  gate itself: flip the command's flag, or regenerate the baseline whose state it\n` +
        `  disagrees with.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ verification inventories current: ${pinCount} held entr(ies) — the documented inventory ` +
      `entries plus the watched platforms — across the relaxation, normalization, session, ` +
      `predicate, gate-watch, and job-citation legs match their subjects.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
