/**
 * check-clause-form.js — Hold every registered clause to one home per rule, and
 * list the units of a clause that grew.
 *
 * A clause states a rule once. When a second clause states it again, the two
 * copies drift apart with the next change, and a reader can no longer tell
 * which one holds. This check reads the text of every clause the registry
 * (docs/clause-registry.json) names, from its marker to the next marker or
 * heading, and reds on two things:
 *
 *   - One home for a linked issue. An issue of this repository linked from
 *     two clauses of one document (by any link whose target is the issue's
 *     address) is a departure or an open case stated twice. Within a
 *     document it is linked from one clause, and any other clause cites that
 *     clause by its identifier. Two documents may each link the issue once:
 *     a case that holds on two platforms stands on each platform's own list.
 *   - One home for a run of words. A run of RUN_WORDS words that stands in two
 *     clauses is a rule stated twice. Words are compared lowercased, with link
 *     targets and fenced blocks left out and a code span counted as one word,
 *     so a shared link, example or command is not a shared rule.
 *
 * scripts/clause-form-baseline.json lists the cases the check admits, and that
 * list only shrinks: an entry admits exactly the case it names (the clauses an
 * issue is linked from, a pair of clauses sharing text), a case beyond it
 * reds, and an entry the tree does not need reds until it is removed. An entry
 * naming a clause the registry does not hold, an entry that admits nothing,
 * and a pair listed twice or out of order red as well. Given a base ref, the
 * check also holds the list against the same file at the merge base of that
 * ref and HEAD: a clause the base does not list under an issue and a pair it
 * does not list each red, so a new case cannot be admitted by adding an entry.
 * Without a base ref, and when the base holds no baseline, the lists are not
 * compared.
 *
 * A unit is a paragraph, a list item or a table row, and it has no word limit.
 * Given a base ref, the check lists each unit of a clause that grew or was
 * added since the merge base, as `doc:line:` (the line of the unit) with both
 * word counts, or says no unit grew. Units carry no name, so they are matched
 * by shared words: the pair of a unit now and a unit of the same clause at the
 * base that shares the most words is matched first (a word counted as many
 * times as both hold it; the longer base unit when two pairs share as many),
 * then the next among the units still unmatched. A base unit is the match of
 * one unit, and a unit left without a match, or sharing no word with any,
 * counts as added, from 0 words. So of a unit split in two, the part that
 * shares fewer words with it is listed as added. The list never fails the
 * check: the pull request's reviewer answers it
 * (docs/guides/docs-governance.md, "Writing docs"). In CI the list also goes
 * to the job summary.
 *
 * Honest limits: a rule restated in other words shares no run and is not
 * seen; that stays a review judgment. Inside a listed pair, further shared
 * text is not counted. A clause the base does not hold in the same document
 * (a new clause, or one moved from another document) is not compared. A unit
 * added where another left is compared with the one that left when they
 * share a word, so it is listed only when it is the longer. A unit that grew
 * where another unit of the clause was cut is not listed when it shares more
 * words with the cut unit's earlier text than with its own (docent#877).
 * Text outside every clause is not read.
 *
 * A base ref with no merge base with HEAD, a registered document that cannot be read, a registered clause whose marker
 * its document does not carry, and a baseline that is not JSON or lacks one of
 * its two lists in their shape (now or at the base) are the machinery verdict, on this check's own exit code
 * (exit 2), never a pass and never a form problem (exit 1).
 *
 * Usage: node scripts/check-clause-form.js [baseRef]   # or: npm run lint:clause-form
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractClauseSection, selfPath, stripFences } from './check-test-inventory.js';
import {
  GROWTH_ANSWER,
  REGISTRY_INPUT_ERROR_NAME,
  REGISTRY_PATH,
  baseFileReader,
  loadRegistry,
  summaryCell,
} from './governance-data.js';

const SELF_PATH = selfPath(import.meta.filename);
const ROOT = resolve(import.meta.dirname, '..');

/** The list of cases the check admits. */
export const BASELINE_PATH = 'scripts/clause-form-baseline.json';
/** The length, in words, of a run that counts as the same text. */
export const RUN_WORDS = 12;

const BASELINE_LISTS = ['issue-homes', 'shared-text'];
const ISSUE_LINK_RE = /github\.com\/arsarneq\/docent\/issues\/(\d+)/gi;
const LINK_TARGET_RE = /\]\([^)\s]*\)/g;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW_RE = /^\s*\|/;
const TABLE_RULE_RE = /^\s*\|[\s|:-]+\|\s*$/;
const ONE_HOME_RULE = 'and any other clause cites that clause';
const ISSUE_HOME_RULE = `within one document a departure or an open case is linked from one clause, ${ONE_HOME_RULE}`;

/**
 * An input this check reads that answered with something other than what it
 * reads there — reported on the check's own exit code.
 */
export class InputError extends Error {}

/**
 * The words of a stretch of clause text: lowercased, link targets left out,
 * and a code span counted as one word whatever it holds.
 * @param {string} text the clause text
 * @returns {string[]}
 */
export function clauseWords(text) {
  return (
    text
      .replace(LINK_TARGET_RE, ']')
      .toLowerCase()
      .match(/`[^`\n]*`|[a-z0-9_]+/g) ?? []
  );
}

/**
 * The issues of this repository a stretch of clause text links to.
 * @param {string} text the clause text
 * @returns {Set<string>} the issue numbers
 */
export function issueLinks(text) {
  return new Set([...text.matchAll(ISSUE_LINK_RE)].map((m) => m[1]));
}

/**
 * The units of a clause, each with the line it opens on.
 * @param {string} section the clause's text
 * @returns {Array<{ text: string, line: number }>} `line` counts from 0 at the section's first line
 */
function unitsWithLines(section) {
  const units = [];
  let open = null;
  let inItem = false;
  let afterBlank = false;
  const close = () => {
    if (open !== null) units.push(open);
    open = null;
    inItem = false;
  };
  for (const [index, raw] of section.split(/\r?\n/).entries()) {
    const line = raw.replace(/^\s*>\s?/, '');
    if (line.trim() === '') {
      afterBlank = true;
      continue;
    }
    const continues = !afterBlank || (inItem && /^\s/.test(line));
    afterBlank = false;
    if (TABLE_ROW_RE.test(line)) {
      close();
      if (!TABLE_RULE_RE.test(line)) units.push({ text: line.trim(), line: index });
    } else if (LIST_ITEM_RE.test(line)) {
      close();
      open = { text: line.replace(LIST_ITEM_RE, ''), line: index };
      inItem = true;
    } else if (open !== null && continues) {
      open.text = `${open.text} ${line.trim()}`;
    } else {
      close();
      open = { text: line.trim(), line: index };
    }
  }
  close();
  return units;
}

/**
 * The units of a clause: each paragraph, each list item with the indented
 * paragraphs that continue it, and each table row.
 * @param {string} section the clause's text
 * @returns {string[]} the units, a list item without its marker
 */
export function clauseUnits(section) {
  return unitsWithLines(section).map((unit) => unit.text);
}

/**
 * A baseline, read and held to its shape.
 * @param {() => string} readText the baseline's text
 * @param {string} [name] what the baseline is called in a refusal
 * @returns {{ 'issue-homes': Record<string, string[]>, 'shared-text': string[] }}
 * @throws {InputError} when it cannot be read, is not JSON, or lacks a list
 */
function loadBaseline(readText, name = BASELINE_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readText());
  } catch (error) {
    throw new InputError(`${name} does not read as JSON: ${error.message}`);
  }
  for (const list of BASELINE_LISTS) {
    if (parsed === null || typeof parsed !== 'object' || !(list in parsed)) {
      throw new InputError(`${name} carries no "${list}" list`);
    }
  }
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isStrings = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');
  const shaped =
    isObject(parsed['issue-homes']) &&
    Object.values(parsed['issue-homes']).every(isStrings) &&
    isStrings(parsed['shared-text']);
  if (!shaped) {
    throw new InputError(
      `${name} is out of shape: "issue-homes" maps an issue number to a list of clause ids, ` +
        'and "shared-text" is a list of "<clause>|<clause>" pairs',
    );
  }
  return parsed;
}

/**
 * Every registered clause with its text.
 * @param {(path: string) => string} readFile repo-relative reader
 * @returns {Array<{ clause: string, doc: string, text: string, line: number }>} `line` is the 1-based line of the clause's marker
 * @throws {InputError} when a document cannot be read or carries no marker
 */
function loadClauses(readFile) {
  const docs = new Map();
  return loadRegistry(readFile).clauses.map(({ clause, doc }) => {
    if (!docs.has(doc)) {
      try {
        docs.set(doc, readFile(doc));
      } catch (error) {
        throw new InputError(`${doc} is registered but cannot be read: ${error.message}`);
      }
    }
    const text = extractClauseSection(docs.get(doc), clause);
    if (text === '') throw new InputError(`${doc} carries no marker for ${clause}`);
    const before = stripFences(docs.get(doc)).split(`**${clause}.**`)[0];
    return { clause, doc, text, line: before.split('\n').length };
  });
}

/**
 * The units of a clause, each with its words.
 * @param {string} text the clause's text
 * @returns {Array<{ words: string[], line: number }>} `line` counts from 0 at the clause's marker
 */
function unitWords(text) {
  return unitsWithLines(text).map((unit) => ({ words: clauseWords(unit.text), line: unit.line }));
}

/**
 * How many words two units share, a word counted as many times as both hold it.
 * @param {string[]} a one unit's words
 * @param {Map<string, number>} b the other unit's words, each with its count
 * @returns {number}
 */
function sharedWords(a, b) {
  const left = new Map(b);
  let shared = 0;
  for (const word of a) {
    const count = left.get(word) ?? 0;
    if (count === 0) continue;
    left.set(word, count - 1);
    shared++;
  }
  return shared;
}

/**
 * The units of the clauses that grew since the base. Units carry no name, so
 * they are matched by shared words: the pair of a unit now and a unit of the
 * same clause at the base that shares the most words is matched first (the
 * longer base unit when two pairs share as many), then the next among the
 * units still unmatched, and a base unit is the match of one unit. A unit
 * left without a match, or sharing no word with any, counts as added, from 0
 * words. A unit that holds more words than its match is listed with its line
 * now. A clause the base does not hold in the same document is not compared.
 * @param {ReturnType<typeof loadClauses>} clauses the clauses now
 * @param {(path: string) => string | null} readBaseFile the file's text at the base commit, or null when the base lacks it
 * @returns {Array<{ clause: string, doc: string, line: number, was: number, now: number }>} in registry and then line order
 */
function unitGrowth(clauses, readBaseFile) {
  const baseDocs = new Map();
  const notes = [];
  for (const { clause, doc, text, line } of clauses) {
    if (!baseDocs.has(doc)) baseDocs.set(doc, readBaseFile(doc));
    const before =
      baseDocs.get(doc) === null ? '' : extractClauseSection(baseDocs.get(doc), clause);
    if (before === '') continue;
    const base = unitWords(before).map(({ words }) => {
      const counts = new Map();
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
      return { length: words.length, counts };
    });
    const units = unitWords(text);
    const pairs = [];
    for (const [u, unit] of units.entries()) {
      for (const [b, { length, counts }] of base.entries()) {
        const shared = sharedWords(unit.words, counts);
        if (shared > 0) pairs.push({ u, b, shared, length });
      }
    }
    pairs.sort((x, y) => y.shared - x.shared || y.length - x.length || x.u - y.u || x.b - y.b);
    const was = new Map();
    const taken = new Set();
    for (const { u, b, length } of pairs) {
      if (was.has(u) || taken.has(b)) continue;
      was.set(u, length);
      taken.add(b);
    }
    for (const [u, unit] of units.entries()) {
      const matched = was.get(u) ?? 0;
      if (unit.words.length > matched) {
        notes.push({ clause, doc, line: line + unit.line, was: matched, now: unit.words.length });
      }
    }
  }
  return notes;
}

/**
 * What the check prints for the grown units: a heading that says the list does
 * not fail and who answers it, then one indented line per unit. No notes, one
 * line that says so, so the log shows the clauses were compared.
 * @param {ReturnType<typeof unitGrowth>} notes the grown units
 * @param {string} baseRef the base they were compared with, as given
 * @returns {string[]} the lines to print
 */
function formatGrowth(notes, baseRef) {
  if (notes.length === 0) return [`note: no unit of a clause grew since ${baseRef}.`];
  return [
    `note: ${notes.length} unit(s) of a clause grew since ${baseRef}. ${GROWTH_ANSWER}`,
    ...notes.map(
      ({ clause, doc, line, was, now }) =>
        `  ${doc}:${line}: ${clause}: a unit (a paragraph, a list item or a table row) grew from ${was} to ${now} words`,
    ),
  ];
}

/**
 * The grown units as markdown for the job summary.
 * @param {ReturnType<typeof unitGrowth>} notes the grown units, at least one
 * @param {string} baseRef the base they were compared with, as given
 * @returns {string} the markdown to append, ending in a newline
 */
function growthSummary(notes, baseRef) {
  const cell = summaryCell;
  return [
    `### Units of a clause that grew since ${baseRef}`,
    '',
    GROWTH_ANSWER,
    '',
    '| Document | Line | Clause | Before | Now |',
    '| --- | --- | --- | --- | --- |',
    ...notes.map(
      ({ clause, doc, line, was, now }) =>
        `| \`${cell(doc)}\` | ${line} | ${cell(clause)} | ${was} | ${now} |`,
    ),
    '',
  ].join('\n');
}

/**
 * The entries of a baseline that the base baseline does not hold.
 * @param {ReturnType<typeof loadBaseline>} baseline the baseline now
 * @param {ReturnType<typeof loadBaseline>} atBase the baseline at the base
 * @returns {string[]} one statement per new entry
 */
function newEntries(baseline, atBase) {
  const found = [];
  for (const [issue, clauses] of Object.entries(baseline['issue-homes'])) {
    const added = clauses.filter(
      (clause) => !(atBase['issue-homes'][issue] ?? []).includes(clause),
    );
    if (added.length > 0) {
      found.push(`lists docent#${issue} for ${added.join(', ')}, which the base does not`);
    }
  }
  for (const pair of baseline['shared-text']) {
    if (!atBase['shared-text'].includes(pair)) {
      found.push(`lists ${pair} as sharing text, which the base does not`);
    }
  }
  return found;
}

/**
 * The verdict over the registered clauses and the baseline.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {(path: string) => string | null} [readBaseFile] the file's text at the base commit, or null when the base lacks it; absent when the run has no base
 * @returns {{ clauseCount: number, docCount: number, listed: number, problems: string[],
 *   grown: ReturnType<typeof unitGrowth> | null }} `grown` is null when the run has no base
 * @throws {InputError} on an input out of shape
 */
export function auditClauseForm(readFile, readBaseFile) {
  const baseline = loadBaseline(() => readFile(BASELINE_PATH));
  const clauses = loadClauses(readFile);
  const known = new Set(clauses.map((c) => c.clause));
  const docOf = new Map(clauses.map((c) => [c.clause, c.doc]));
  const problems = [];

  // The list only shrinks: no entry the base does not hold.
  const baseText = readBaseFile?.(BASELINE_PATH) ?? null;
  if (baseText !== null) {
    const atBase = loadBaseline(() => baseText, `${BASELINE_PATH} at the base`);
    for (const entry of newEntries(baseline, atBase)) {
      problems.push(`${BASELINE_PATH} ${entry} — the list only shrinks: fix the clause and take the new entry out`); // prettier-ignore
    }
  }

  const named = [
    ...Object.values(baseline['issue-homes']).flat(),
    ...baseline['shared-text'].flatMap((pair) => pair.split('|')),
  ];
  for (const clause of [...new Set(named)].sort()) {
    if (!known.has(clause)) {
      problems.push(`${BASELINE_PATH} names ${clause}, which is no registered clause — remove the entry`); // prettier-ignore
    }
  }

  // One home for a linked issue, within a document.
  const linking = new Map();
  for (const { clause, doc, text } of clauses) {
    for (const issue of issueLinks(text)) {
      if (!linking.has(issue)) linking.set(issue, new Map());
      linking.get(issue).set(doc, [...(linking.get(issue).get(doc) ?? []), clause]);
    }
  }
  const inDocs = (list) => [...new Set(list.map((clause) => docOf.get(clause)))].sort().join(', ');
  const issues = new Set([...linking.keys(), ...Object.keys(baseline['issue-homes'])]);
  for (const issue of [...issues].sort((a, b) => a - b)) {
    const found = [...(linking.get(issue)?.values() ?? [])]
      .filter((inOneDoc) => inOneDoc.length > 1)
      .flat()
      .sort();
    const admitted = baseline['issue-homes'][issue];
    if (admitted !== undefined && admitted.length < 2) {
      problems.push(`${BASELINE_PATH} lists docent#${issue} for one clause, which admits nothing — remove the entry`); // prettier-ignore
      continue;
    }
    if (admitted === undefined) {
      if (found.length > 1) {
        problems.push(`docent#${issue} is linked from ${found.join(' and ')} in ${inDocs(found)} — ${ISSUE_HOME_RULE}`); // prettier-ignore
      }
      continue;
    }
    const extra = found.filter((clause) => !admitted.includes(clause));
    if (extra.length > 0) {
      problems.push(`docent#${issue} is linked from ${extra.join(', ')} in ${inDocs(extra)} as well as the clauses ${BASELINE_PATH} lists for it (${admitted.join(', ')}) — ${ISSUE_HOME_RULE}`); // prettier-ignore
    } else if (found.length === 0) {
      problems.push(`${BASELINE_PATH} lists docent#${issue} for ${admitted.join(', ')}, and no two clauses of one document link it now — remove the entry`); // prettier-ignore
    } else if (found.length < admitted.length) {
      problems.push(`${BASELINE_PATH} lists docent#${issue} for ${admitted.join(', ')}, and it is now linked from ${found.join(', ')} only — cut the entry to those`); // prettier-ignore
    }
  }

  // One home for a run of words.
  const runs = new Map();
  for (const { clause, text } of clauses) {
    const words = clauseWords(text);
    for (let i = 0; i + RUN_WORDS <= words.length; i++) {
      const run = words.slice(i, i + RUN_WORDS).join(' ');
      if (!runs.has(run)) runs.set(run, new Set());
      runs.get(run).add(clause);
    }
  }
  const sharing = new Map();
  for (const [run, holders] of runs) {
    if (holders.size < 2) continue;
    const sorted = [...holders].sort();
    for (let a = 0; a < sorted.length; a++) {
      for (let b = a + 1; b < sorted.length; b++) {
        const pair = `${sorted[a]}|${sorted[b]}`;
        if (!sharing.has(pair)) sharing.set(pair, run);
      }
    }
  }
  for (const pair of [...sharing.keys()].sort()) {
    if (baseline['shared-text'].includes(pair)) continue;
    const both = pair.split('|').map((clause) => `${clause} (${docOf.get(clause)})`);
    problems.push(`${both.join(' and ')} both state "${sharing.get(pair)}" — a rule is stated in one clause, ${ONE_HOME_RULE}`); // prettier-ignore
  }
  for (const [i, pair] of baseline['shared-text'].entries()) {
    const ordered = pair.split('|').sort().join('|');
    if (baseline['shared-text'].indexOf(pair) !== i) {
      problems.push(`${BASELINE_PATH} lists ${pair} twice — remove one entry`);
    } else if (ordered !== pair) {
      problems.push(`${BASELINE_PATH} lists ${pair}, and a pair is written with its two clauses in order — write it ${ordered}`); // prettier-ignore
    } else if (!sharing.has(pair) && pair.split('|').every((clause) => known.has(clause))) {
      problems.push(`${BASELINE_PATH} lists ${pair} as sharing text, and they share no run of ${RUN_WORDS} words now — remove the entry`); // prettier-ignore
    }
  }

  return {
    clauseCount: clauses.length,
    docCount: new Set(clauses.map((c) => c.doc)).size,
    listed: Object.keys(baseline['issue-homes']).length + baseline['shared-text'].length,
    problems,
    grown: readBaseFile ? unitGrowth(clauses, readBaseFile) : null,
  };
}

/**
 * The command line's verdict over the given seams, as its exit code.
 * @param {object} seams the reads and the output sinks
 * @param {(path: string) => string} seams.readFile repo-relative reader
 * @param {(path: string) => string | null} [seams.readBaseFile] the file's text at the base commit, or null; absent when the run has no base
 * @param {string} [seams.baseRef] the base as given, for the list of grown units; with `readBaseFile`
 * @param {(line: string) => void} seams.log the green-line and note sink
 * @param {(line: string) => void} seams.error the red-line sink
 * @param {(markdown: string) => void} [seams.summary] the job-summary sink, called when a unit grew; required with `readBaseFile`
 * @returns {number} 0 when every clause passes, 1 on a problem, 2 on an input out of shape
 */
export function main({ readFile, readBaseFile, baseRef, log, error, summary }) {
  let audit;
  try {
    audit = auditClauseForm(readFile, readBaseFile);
  } catch (e) {
    if (!(e instanceof InputError) && e?.name !== REGISTRY_INPUT_ERROR_NAME) throw e;
    const what = e instanceof InputError ? e.message : `${REGISTRY_PATH} ${e.problem}`;
    error(`✗ an input this check reads could not be read:\n    ${what}`);
    return 2;
  }
  if (audit.grown !== null) {
    for (const line of formatGrowth(audit.grown, baseRef)) log(line);
    if (audit.grown.length > 0) summary(growthSummary(audit.grown, baseRef));
  }
  if (audit.problems.length > 0) {
    for (const problem of audit.problems) error(`✗ ${problem}`);
    error(
      `\n${audit.problems.length} problem${audit.problems.length === 1 ? '' : 's'}. ` +
        `Fix the clause; do not add an entry to ${BASELINE_PATH}. ${SELF_PATH} holds the rules.`,
    );
    return 1;
  }
  log(
    `✓ ${audit.clauseCount} clause(s) in ${audit.docCount} document(s): no issue linked from two clauses of one document ` +
      `and no run of ${RUN_WORDS} words standing in two clauses, ` +
      `beyond the ${audit.listed} case(s) ${BASELINE_PATH} lists.`,
  );
  return 0;
}

/* c8 ignore start -- CLI wrapper: main() is unit-tested over injected seams;
 * this glue binds it to the tree and the process. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const baseRef = process.argv[2];
  let readBaseFile;
  try {
    readBaseFile = baseRef === undefined ? undefined : baseFileReader(git, baseRef);
  } catch (e) {
    console.error(`✗ an input this check reads could not be read:\n    ${e.message}`);
    process.exit(2);
  }
  process.exitCode = main({
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    readBaseFile,
    baseRef,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    summary: (markdown) => {
      const path = process.env.GITHUB_STEP_SUMMARY;
      if (path) appendFileSync(path, markdown);
    },
  });
}
/* c8 ignore stop */
