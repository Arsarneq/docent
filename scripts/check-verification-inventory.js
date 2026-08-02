/**
 * check-verification-inventory.js — admission test for the inventories the
 * verification documents state in their own text, each held to the code
 * constant, the committed manifest, or the workflow it describes:
 *
 *   - the relaxation coverage lists
 *     (docs/verification/scripted-truth-corpus.md §STC-21): the clause's list
 *     of kinds, and each kind's covered fields, equal the comparator's
 *     exported closed sets;
 *   - the normalization classes (§STC-19): the class table's field tokens
 *     equal the comparator's exported class map, flattened;
 *   - the desktop session catalogue (§STC-22): the clause's session ids equal
 *     the active `desktop-windows` sessions of corpus/manifest.json;
 *   - the predicate catalogue
 *     (docs/verification/sufficiency-lint.md): the per-action table's names
 *     equal the lint's `PREDICATES` ids and every one of those is `fail`
 *     class, and the recording-level table's (predicate, class) pairs equal
 *     the lint's `RECORDING_PREDICATES`;
 *   - the job citations: every `` `<job>` job `` either verification document
 *     cites names a job of .github/workflows/test.yml.
 *
 * Every set inventory is diffed BOTH ways — a doc entry the code does not have
 * is as red as a code entry the doc does not state. The job citations are the
 * one leg held one-way, by design: every cite must name a real job of the
 * workflow, and a job owes no cite — a workflow may grow a job neither
 * verification document has reason to mention. Every extraction must be
 * non-empty (per scanned document, for the citation leg), every table is
 * selected by its exact header tuple and must match exactly one table, and
 * the job-id extractor's own anchor problems are reported rather than read as
 * an empty green — a check that silently reads part of an inventory, or none
 * of it, would pass forever. An input file the readers refuse — unreadable,
 * unparseable, or parseable but not shaped like a session catalogue — is a
 * third verdict, not a drift finding: they refuse loudly, naming the file and
 * which of those three it was, and the wrapper exits 2 so machinery breakage
 * never reads as an inventory that went stale.
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
 * learned reds here rather than passing unexamined. Documents outside those
 * named here are outside the citation leg — docs/requirements/replay-sufficiency.md
 * cites no job and is deliberately unscanned, so an empty extraction there
 * could never distinguish a doc with no cites from a broken scan.
 *
 * Usage:
 *   node scripts/check-verification-inventory.js  # or: npm run lint:verification-inventory
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  backtickedName,
  duplicatesIn,
  extractClauseSection,
  missingFrom,
  parseTables,
  stripFences,
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
/** The manifest platform whose session ids §STC-22 enumerates. */
export const DESKTOP_PLATFORM = 'desktop-windows';

/** The clause stating each relaxation kind's covered fields. */
export const RELAXATION_CLAUSE_ID = 'STC-21';
/** The clause stating the normalized field classes. */
export const NORMALIZATION_CLAUSE_ID = 'STC-19';
/** The clause stating the desktop session catalogue. */
export const SESSION_CLAUSE_ID = 'STC-22';

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
/** Every backticked token of one line or cell. */
const BACKTICKED_TOKEN_RE = /`([^`]+)`/g;

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

/** The backticked tokens of one string, in order. */
const backtickedTokens = (text) => [...(text ?? '').matchAll(BACKTICKED_TOKEN_RE)].map((m) => m[1]);

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
 * The top-level `- ` list items of a clause's text, each bounded to its own
 * lines: an item runs from its `- ` marker through the continuation lines
 * indented under it, and ends at the first blank line or unindented line — so
 * the paragraph that follows a list is never absorbed into its last item.
 * @param {string} clauseText a clause section's text
 * @returns {string[]} one flattened string per item (marker stripped)
 */
export function topLevelListItems(clauseText) {
  const items = [];
  let current = null;
  for (const line of (clauseText ?? '').split(/\r?\n/)) {
    if (/^- \S/.test(line)) {
      current = [line.slice(2).trim()];
      items.push(current);
    } else if (current !== null && /^\s+\S/.test(line)) {
      current.push(line.trim());
    } else {
      current = null;
    }
  }
  return items.map((parts) => parts.join(' '));
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
 * The one table of a document with an exact header tuple. Selection by the
 * whole header — not the first cell alone — so a sibling table can never be
 * conscripted, and the match count is returned so an ambiguous document is
 * refused rather than silently read through its first match.
 * @param {string} docText
 * @param {string[]} header the exact header cells
 * @returns {{ table: { header: string[], rows: string[][] } | null, matches: number }}
 */
export function selectTableByHeader(docText, header) {
  const matches = parseTables(docText).filter(
    (t) => t.header.length === header.length && t.header.every((cell, i) => cell === header[i]),
  );
  return { table: matches.length === 1 ? matches[0] : null, matches: matches.length };
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
  ['codeKinds', `no relaxation kinds found in the comparator's RELAX_KINDS`],
  ['docNormalizationTokens', `no class field tokens found in ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}`], // prettier-ignore
  ['codeNormalizationTokens', `no field tokens found in the comparator's normalization class map`],
  ['docSessionIds', `no session ids found in ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID}`],
  ['manifestSessionIds', `no active ${DESKTOP_PLATFORM} sessions found in ${MANIFEST_PATH}`],
  ['docPerAction', `no per-action predicate rows found in ${LINT_DOC_PATH}`],
  ['codePerAction', `no per-action predicates found in the lint's PREDICATES`],
  ['docRecording', `no recording-level predicate rows found in ${LINT_DOC_PATH}`],
  ['codeRecording', `no recording-level predicates found in the lint's RECORDING_PREDICATES`],
  ['workflowJobIds', `no job ids found in ${TEST_WORKFLOW_PATH}`],
];

/**
 * The duplicates guard's legs — the drift the deduplicating set diffs cannot
 * see. Exported for the same suite treatment as {@link EMPTY_SURFACES}.
 */
export const DUPLICATE_SURFACES = [
  ['docKinds', `${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID}'s kind list`],
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
 * @param {string[]} s.codeKinds the comparator's RELAX_KINDS
 * @param {[string, string[]][]} s.codeKindFields the comparator's per-kind lists
 * @param {string[]} s.docNormalizationTokens §STC-19's class-column field tokens
 * @param {number} s.normalizationTableMatches how many tables carry its header tuple
 * @param {string[]} s.codeNormalizationTokens the comparator's class map, flattened
 * @param {string[]} s.docSessionIds §STC-22's session ids
 * @param {string[]} s.manifestSessionIds the manifest's active desktop session ids
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
    ...missingFrom(s.codeKinds, [...codeFields.keys()], `is in the comparator's RELAX_KINDS but scripts/check-verification-inventory.js knows no field list for it — extend CODE_RELAXATION_FIELDS in the same change`), // prettier-ignore
    ...missingFrom([...codeFields.keys()], s.codeKinds, `has a field list in scripts/check-verification-inventory.js but is not a comparator relaxation kind`), // prettier-ignore
    ...missingFrom(s.docNormalizationTokens, s.codeNormalizationTokens, `is a field token ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID} normalizes but the comparator's class map does not carry`), // prettier-ignore
    ...missingFrom(s.codeNormalizationTokens, s.docNormalizationTokens, `is a field token the comparator's class map normalizes but ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}'s table does not state`), // prettier-ignore
    ...missingFrom(s.docSessionIds, s.manifestSessionIds, `is a session ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID} enumerates but ${MANIFEST_PATH} carries no active ${DESKTOP_PLATFORM} session for`), // prettier-ignore
    ...missingFrom(s.manifestSessionIds, s.docSessionIds, `is an active ${DESKTOP_PLATFORM} session in ${MANIFEST_PATH} but ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID} does not enumerate it`), // prettier-ignore
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

  return problems;
}

/**
 * Read every surface from a tree and evaluate the inventories.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {() => string[]} listActiveDesktopSessions active desktop session ids
 * @returns {{ problems: string[], pinCount: number }}
 */
export function auditTree(readFile, listActiveDesktopSessions) {
  const corpusDoc = readFile(CORPUS_DOC_PATH);
  const lintDoc = readFile(LINT_DOC_PATH);
  const relaxation = extractRelaxationCoverage(corpusDoc);
  const normalization = extractNormalizationTokens(corpusDoc);
  const sessions = extractSessionIds(corpusDoc);
  const predicates = extractPredicateTables(lintDoc);
  const jobs = extractJobIds(readFile(TEST_WORKFLOW_PATH));

  const s = {
    docKinds: relaxation.kinds,
    docKindFields: relaxation.fields,
    relaxUnreadable: relaxation.unreadable,
    codeKinds: [...RELAX_KINDS],
    codeKindFields: [...CODE_RELAXATION_FIELDS],
    docNormalizationTokens: normalization.tokens,
    normalizationTableMatches: normalization.matches,
    codeNormalizationTokens: CODE_NORMALIZATION_TOKENS,
    docSessionIds: sessions.ids,
    manifestSessionIds: listActiveDesktopSessions(),
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
      ...normalization.unreadableTokens,
      ...sessions.unreadableTokens,
    ],
    docCites: [
      { path: CORPUS_DOC_PATH, cites: extractJobCites(corpusDoc) },
      { path: LINT_DOC_PATH, cites: extractJobCites(lintDoc) },
    ],
    workflowJobIds: jobs.ids,
  };
  return {
    problems: [...jobs.problems, ...evaluateVerificationInventory(s)],
    pinCount:
      s.docKinds.length +
      s.docNormalizationTokens.length +
      s.docSessionIds.length +
      s.docPerAction.length +
      s.docRecording.length +
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
 * The manifest's active desktop session ids. A broken manifest is not an empty
 * catalogue — diagnosing it as one would send the reader to §STC-22's clause,
 * which is not the file at fault — so each way the file can fail this check
 * gets its own words: unreadable, unparseable, or parseable but not shaped like
 * a session catalogue. The shape check runs to the depth `discoverSessions`
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
 * @param {string} [manifestPath] repo-relative path to the session catalogue
 * @returns {string[]}
 * @throws {InputError} naming the manifest and which way it failed
 */
export function listActiveDesktopSessions(manifestPath = MANIFEST_PATH) {
  const raw = readTreeFile(manifestPath); // unreadable → that reader's words
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${manifestPath} is not parseable JSON — ${error.message}`);
  }
  const shapeProblem = (what) =>
    new InputError(
      `${manifestPath} parses but ${what} — the session catalogue's shape is what failed here, not its readability`,
    );
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
  return discoverSessions(manifestPath, DESKTOP_PLATFORM)
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
    audit = auditTree(readTreeFile, listActiveDesktopSessions);
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
        `\n\n  Each inventory is stated twice — once in the document, once in the code constant,\n` +
        `  the manifest, or the workflow it describes — and the two must state the same set.\n` +
        `  Update both sides in the same change.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ verification inventories current: ${pinCount} documented entr(ies) across the relaxation, ` +
      `normalization, session, predicate, and job-citation inventories match their subjects.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
