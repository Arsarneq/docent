/**
 * check-clause-form.js — Hold every registered clause to one home per rule and
 * to units a reader can take in.
 *
 * A clause states a rule once. When a second clause states it again, the two
 * copies drift apart with the next change, and a reader can no longer tell
 * which one holds. A clause is also read by a person: a paragraph that runs on
 * for hundreds of words hides the rule it carries. This check reads the text
 * of every clause the registry (docs/clause-registry.json) names, from its
 * marker to the next marker or heading, and reds on three things:
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
 *   - Units a reader can take in. A unit is a paragraph, a list item or a
 *     table row. A unit over UNIT_WORD_LIMIT words is split into paragraphs or
 *     a list. This limits how much one unit holds, never how much a clause or
 *     a document says.
 *
 * scripts/clause-form-baseline.json lists the cases the check admits, and that
 * list only shrinks: an entry admits exactly the case it names (the clauses an
 * issue is linked from, a pair of clauses sharing text, the count of long
 * units in a clause), a case beyond it reds, and an entry the tree does not
 * need reds until it is removed or lowered. An entry naming a clause the
 * registry does not hold, an entry that admits nothing, and a pair listed
 * twice or out of order red as well. Given a base ref, the check also holds
 * the list against the same file at the merge base of that ref and HEAD: a
 * clause the base does not list under an issue, a pair it does not list, and
 * a count of long units above the base's count for that clause each red, so
 * a new case cannot be admitted by adding an entry. Without a base ref, and
 * when the base holds no baseline, the lists are not compared.
 *
 * Honest limits: a rule restated in other words shares no run and is not
 * seen; that stays a review judgment. Inside a listed pair, further shared
 * text is not counted, and inside a clause's admitted count a long unit may
 * grow. Text outside every clause is not read.
 *
 * A base ref with no merge base with HEAD, a registered document that cannot be read, a registered clause whose marker
 * its document does not carry, and a baseline that is not JSON or lacks one of
 * its three lists in their shape (now or at the base) are the machinery verdict, on this check's own exit code
 * (exit 2), never a pass and never a form problem (exit 1).
 *
 * Usage: node scripts/check-clause-form.js [baseRef]   # or: npm run lint:clause-form
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractClauseSection, selfPath } from './check-test-inventory.js';
import { REGISTRY_INPUT_ERROR_NAME, REGISTRY_PATH, loadRegistry } from './governance-data.js';

const SELF_PATH = selfPath(import.meta.filename);
const ROOT = resolve(import.meta.dirname, '..');

/** The list of cases the check admits. */
export const BASELINE_PATH = 'scripts/clause-form-baseline.json';
/** The length, in words, of a run that counts as the same text. */
export const RUN_WORDS = 12;
/** The most words a paragraph, a list item or a table row holds. */
export const UNIT_WORD_LIMIT = 150;

const BASELINE_LISTS = ['issue-homes', 'shared-text', 'long-units'];
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
 * The units of a clause: each paragraph, each list item with the indented
 * paragraphs that continue it, and each table row.
 * @param {string} section the clause's text
 * @returns {string[]} the units, a list item without its marker
 */
export function clauseUnits(section) {
  const units = [];
  let open = null;
  let inItem = false;
  let afterBlank = false;
  const close = () => {
    if (open !== null) units.push(open);
    open = null;
    inItem = false;
  };
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.replace(/^\s*>\s?/, '');
    if (line.trim() === '') {
      afterBlank = true;
      continue;
    }
    const continues = !afterBlank || (inItem && /^\s/.test(line));
    afterBlank = false;
    if (TABLE_ROW_RE.test(line)) {
      close();
      if (!TABLE_RULE_RE.test(line)) units.push(line.trim());
    } else if (LIST_ITEM_RE.test(line)) {
      close();
      open = line.replace(LIST_ITEM_RE, '');
      inItem = true;
    } else if (open !== null && continues) {
      open = `${open} ${line.trim()}`;
    } else {
      close();
      open = line.trim();
    }
  }
  close();
  return units;
}

/**
 * A baseline, read and held to its shape.
 * @param {() => string} readText the baseline's text
 * @param {string} [name] what the baseline is called in a refusal
 * @returns {{ 'issue-homes': Record<string, string[]>, 'shared-text': string[],
 *   'long-units': Record<string, number> }}
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
    isStrings(parsed['shared-text']) &&
    isObject(parsed['long-units']) &&
    Object.values(parsed['long-units']).every((count) => Number.isInteger(count) && count >= 0);
  if (!shaped) {
    throw new InputError(
      `${name} is out of shape: "issue-homes" maps an issue number to a list of clause ids, ` +
        '"shared-text" is a list of "<clause>|<clause>" pairs, and "long-units" maps a clause id to a whole number',
    );
  }
  return parsed;
}

/**
 * Every registered clause with its text.
 * @param {(path: string) => string} readFile repo-relative reader
 * @returns {Array<{ clause: string, doc: string, text: string }>}
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
    return { clause, doc, text };
  });
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
  for (const [clause, count] of Object.entries(baseline['long-units'])) {
    const before = atBase['long-units'][clause] ?? 0;
    if (count > before) {
      found.push(`admits ${count} unit(s) over ${UNIT_WORD_LIMIT} words in ${clause} where the base admits ${before}`); // prettier-ignore
    }
  }
  return found;
}

/**
 * The verdict over the registered clauses and the baseline.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {(path: string) => string | null} [readBaseFile] the file's text at the base commit, or null when the base lacks it; absent when the run has no base
 * @returns {{ clauseCount: number, docCount: number, listed: number, problems: string[] }}
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
    ...Object.keys(baseline['long-units']),
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

  // Units a reader can take in.
  for (const { clause, doc, text } of clauses) {
    const long = clauseUnits(text)
      .map((unit) => ({ unit, count: clauseWords(unit).length }))
      .filter(({ count }) => count > UNIT_WORD_LIMIT)
      .sort((a, b) => b.count - a.count);
    const admitted = baseline['long-units'][clause] ?? 0;
    if (baseline['long-units'][clause] === 0) {
      problems.push(`${BASELINE_PATH} admits 0 unit(s) over ${UNIT_WORD_LIMIT} words in ${clause}, which admits nothing — remove the entry`); // prettier-ignore
    } else if (long.length > admitted) {
      const opens = long[0].unit.split(/\s+/).slice(0, 6).join(' ');
      const beside = admitted === 0 ? '' : ` where ${BASELINE_PATH} admits ${admitted}`;
      problems.push(`${clause} (${doc}) holds ${long.length} unit(s) over ${UNIT_WORD_LIMIT} words (a paragraph, a list item or a table row)${beside} — split it into paragraphs or a list; the longest runs ${long[0].count} words and opens "${opens}"`); // prettier-ignore
    } else if (long.length < admitted) {
      const fix = long.length === 0 ? 'remove the entry' : `lower the entry to ${long.length}`;
      problems.push(`${BASELINE_PATH} admits ${admitted} unit(s) over ${UNIT_WORD_LIMIT} words in ${clause}, and it holds ${long.length} now — ${fix}`); // prettier-ignore
    }
  }

  return {
    clauseCount: clauses.length,
    docCount: new Set(clauses.map((c) => c.doc)).size,
    listed:
      Object.keys(baseline['issue-homes']).length +
      baseline['shared-text'].length +
      Object.keys(baseline['long-units']).length,
    problems,
  };
}

/**
 * The command line's verdict over the given seams, as its exit code.
 * @param {object} seams the reads and the output sinks
 * @param {(path: string) => string} seams.readFile repo-relative reader
 * @param {(path: string) => string | null} [seams.readBaseFile] the file's text at the base commit, or null; absent when the run has no base
 * @param {(line: string) => void} seams.log the green-line sink
 * @param {(line: string) => void} seams.error the red-line sink
 * @returns {number} 0 when every clause passes, 1 on a problem, 2 on an input out of shape
 */
export function main({ readFile, readBaseFile, log, error }) {
  let audit;
  try {
    audit = auditClauseForm(readFile, readBaseFile);
  } catch (e) {
    if (!(e instanceof InputError) && e?.name !== REGISTRY_INPUT_ERROR_NAME) throw e;
    const what = e instanceof InputError ? e.message : `${REGISTRY_PATH} ${e.problem}`;
    error(`✗ an input this check reads could not be read:\n    ${what}`);
    return 2;
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
    `✓ ${audit.clauseCount} clause(s) in ${audit.docCount} document(s): no issue linked from two clauses of one document, ` +
      `no run of ${RUN_WORDS} words standing in two clauses and no unit over ${UNIT_WORD_LIMIT} words, ` +
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
  let base;
  try {
    base = baseRef === undefined ? undefined : git(['merge-base', baseRef, 'HEAD']).trim();
  } catch {
    console.error(`✗ an input this check reads could not be read:\n    no merge base of ${baseRef} and HEAD`); // prettier-ignore
    process.exit(2);
  }
  const readBaseFile = (rel) => {
    try {
      return git(['show', `${base}:${rel}`]);
    } catch {
      return null;
    }
  };
  process.exitCode = main({
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    readBaseFile: base === undefined ? undefined : readBaseFile,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
/* c8 ignore stop */
