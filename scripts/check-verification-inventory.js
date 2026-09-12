/**
 * check-verification-inventory.js — admission test for the inventories the
 * verification documents state in their own text, each held to the code
 * constant, the committed manifest, the vector meta-schema, or the workflow it
 * describes:
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
 *     the active `desktop-windows` sessions of corpus/manifest.json, for as long
 *     as the strict-flip watch still mints that platform's surface — that platform
 *     leaving the watch is named as the mover there instead;
 *   - the predicate catalogue
 *     (docs/verification/sufficiency-lint.md): the per-action table's names
 *     equal the lint's `PREDICATES` ids, the class that table's own heading
 *     states of all of them is the class this check holds every one of them
 *     to, and the recording-level table's (predicate, class) pairs equal
 *     the lint's `RECORDING_PREDICATES`;
 *   - the shipping outcome §STC-23 states: the clause names the field the
 *     vector meta-schema corpus/vector.schema.json states a committed
 *     vector's outcome under, and the outcome the clause states equals that
 *     property's `const` — which the meta-schema also requires of every
 *     vector, as the clause says every committed vector states it;
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
 *     cites names a job of .github/workflows/test.yml;
 *   - the suite the cited job runs: READ — the steps of
 *     .github/workflows/test.yml's `unit-tests` job, taken through the
 *     workflow's own `jobs` map. HOW — each step's `run` text split into the
 *     command segments a shell would run and stopped at the first `cd`, then
 *     each remaining segment that opens with a modelled invocation read as the
 *     step's own command and through the root manifest's script for every
 *     `npm run` token it states. Each reading goes to the test-inventory
 *     check's own `nodeTestArguments` and its `classifyArgument`, so the
 *     arguments this leg compares are the ones that gate itself would select.
 *     HELD — the shared unit suite's registered `dir` and `pattern` are among
 *     those classified answers: the ARGUMENT SET, never a command string, so
 *     the step stays free to be respelled and the job free to grow further
 *     suites. REFUSED, each by name — a step stating its own
 *     `working-directory`; a segment stating a modelled invocation off its own
 *     head; a segment whose `npm run` script token this reader cannot read; an
 *     `npm run` the root manifest defines no script for; a command the argument
 *     reader will not model; a step carrying the suite under a condition, a
 *     truthy or expression-valued tolerance, or an operator that keeps its
 *     verdict from reaching the job; a job whose commands this reading resolves
 *     none of; and the job itself being gone. LIMITS — the verification
 *     documents' own CI-reach sentences are prose, so whether each still says the job runs
 *     the suite is review-held, as is whether the CI guide row's flag list for
 *     the job is the right set; the job's desktop and extension trees are
 *     review-held beside them; the shell's own settings are not read, so a
 *     `shell:` key or a `set +e` inside a `run:` block states nothing here;
 *     text inside a heredoc body or a command substitution is read as the
 *     line's own, the segment grammar's limit inherited; and the premise is
 *     scoped — the shapes that keep writing a coverage report pass every
 *     tracked check, while a deleted step or a swap to a non-coverage script
 *     reds the job's own coverage-staging copy two steps later, naming no
 *     drift.
 *
 * Every set inventory is diffed BOTH ways — a doc entry the code does not have
 * is as red as a code entry the doc does not state. A leg held one-way states
 * its own ground for the side it does not hold. The job citations: every cite
 * must name a real job of the workflow, and a job owes no cite — a workflow may
 * grow a job neither verification document has reason to mention, so the
 * workflow side carries nothing the documents can be found to have dropped. The
 * vector meta-schema's `required` membership: the meta-schema must require the
 * outcome field of every vector, while §STC-23's own every-committed-vector
 * demand is running prose this check never reads, so that leg reds when the
 * meta-schema stops requiring the field and says nothing about a clause that
 * stopped demanding it.
 *
 * The suite the cited job runs is held one-way as well, and at the grain the
 * runner reads rather than the grain the command is spelled at: the job's own
 * steps are resolved to the `node --test` arguments their commands state —
 * through the root manifest's scripts for an `npm run` token, and from the
 * step's own command text where the step spells the invocation itself — and the
 * registered glob must be among them. The job stays free to run further suites
 * and the command free to be
 * respelled or renamed — what it cannot do is stop running the suite the
 * documents say it runs, which is why the ARGUMENT SET is what this leg pins
 * and the command string is not: a pin on the string would hold the step
 * stricter than the reader that resolves it. Nothing is held from the other
 * end: a registered suite CI runs nowhere is the test-inventory lint's
 * registration closure to speak for — it holds every registered suite to
 * some admitted manifest script — and this leg adds the one thing that
 * closure cannot see, which job's own steps run it. A `run:` line any segment
 * of which is a `cd` is refused whole rather than read against a working
 * directory this reading does not follow: that same job runs a second script
 * of the same NAME from another package's manifest behind exactly such a
 * `cd`, so reading a segment without the relocation ahead of it would let that
 * step's token answer for the root script. A step stating its own
 * `working-directory` is refused the same way and for the same reason, named
 * rather than skipped — the leg cannot answer green over commands it declined
 * to read.
 *
 * A repeat is legitimate wherever a claim is read from running prose rather
 * than from an enumeration: an enumeration states each entry once, so a repeat
 * there is drift, while prose may state the same fact in two sentences. The
 * citation scan therefore collects a repeated cite once instead of refusing it,
 * and §STC-23's outcome extraction dedupes the tokens its clause's prose
 * carries for the same reason — the carve-out the enumerations'
 * refuse-a-repeat posture is stated against. Every extraction must be
 * non-empty (per scanned document, for the citation leg), every table is
 * selected by its exact header tuple and must match exactly one table, the
 * per-action heading is read the same way — exactly one heading states that
 * class — and the workflow the job ids come from must carry the anchor the
 * scan reads them under; a check that silently reads part of an inventory, or
 * none of it, would pass forever. An input file the readers refuse —
 * unreadable, unparseable, or parseable but not shaped like the surface it is
 * read as (the session catalogue, a known-diffs baseline, the sufficiency
 * baseline, the vector meta-schema, or the package manifest) — is a third
 * verdict, not a drift finding: they refuse loudly, naming the file and which
 * failure mode it was, and the wrapper exits 2 so machinery breakage never
 * reads as a pin that stopped holding. A workflow whose top-level `jobs:`
 * anchor the shared extractor cannot find takes that same verdict here: no
 * pin stopped holding, the file the job ids are read from moved, so it is
 * refused as an input rather than reported beside the pins a drift verdict
 * names.
 *
 * Why the always-on `lint` job: the diff that stales a doc inventory is
 * frequently docs-only, and a pull request that sets none of the workflow's
 * change flags — usually a docs-only one — skips every path-filtered test
 * job: the same placement rationale the test-inventory lint records. The
 * behavioural half of these contracts (that the comparator and the lint act
 * on exactly these constants) is the unit suites' work, and a code diff
 * reaches them through the workflow's script filter.
 *
 * Honest limits: this check compares names and tokens, never prose — whether
 * a table row's Rule or Requires column still describes what the code does is
 * review-held. Which exported list a relaxation kind's fields live in is this
 * check's own association (below), so it holds the kinds against
 * `RELAX_KINDS` too: a kind added to the comparator that this check has not
 * learned reds here rather than passing unexamined. Which platforms the
 * strict-flip watch covers is this check's own list on the same footing, so
 * the session catalogue's platform population is diffed against it: a platform
 * the corpus grows sessions for that the watch has not learned reds here
 * rather than going unwatched, while a watched platform the catalogue no
 * longer carries reds on that platform's derived active-session vacuity leg
 * first, so the diff's watch side never prints from a tree state (the
 * population diff's own comment says what holds that end). Which documents the
 * citation leg scans is this check's own declared decision too, stated once in
 * `CITED_JOB_DOCUMENTS` below and held to the tracked verification documents
 * by the unit suite; a document outside that list is outside the leg —
 * docs/requirements/replay-sufficiency.md cites no job and is deliberately
 * unscanned, so an empty extraction there could never distinguish a doc with
 * no cites from a broken scan. The job citations are the one leg with no
 * registered clause behind it: both documents state their cites as ordinary
 * prose, so this leg keeps a documentation surface honest rather than guarding
 * a clause, and it deliberately takes no clause-registry row.
 *
 * Which job the job-suite leg reads, and which registered suite it demands of
 * that job, are this check's own constants too (`UNIT_SUITE_JOB_ID`
 * and `UNIT_SUITE_DIR` below): a second job either document claims a suite
 * for is outside the leg until it is named there, and the glob itself is
 * never spelled here — it comes off the discovery descriptor `DOC_INVENTORIES`
 * registers that directory under, so the suite this leg demands of the job is
 * the suite that registration demands a documented row for. Inside the job,
 * each step's own condition and tolerance come back through the reader, beside
 * the operators its `run:` lines state: a step that carries the suite under any
 * of them is REFUSED by name rather than counted, because this reader evaluates
 * neither a condition nor the shell state an operator leaves behind — so what
 * the leg holds is that the job states the invocation in a step whose verdict
 * reaches the job, and a legitimate condition reds with a message saying to
 * teach the reader. And the documents' sentences are prose
 * like every other: that each still says the job runs the suite is
 * review-held — what this leg makes machine-held is the fact they state.
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
  DOC_INVENTORIES,
  RUNNERS,
  backtickedName,
  backtickedTokens,
  classifyArgument,
  duplicateSurfaceProblems,
  duplicatesIn,
  emptySurfaceProblems,
  extractClauseSection,
  flattenWhitespace,
  missingFrom,
  nodeTestArguments,
  selectTablesByHeader,
  selfPath,
  stripFences,
  topLevelListItems,
} from './check-test-inventory.js';
import {
  TEST_WORKFLOW_PATH,
  extractJobIds,
  extractLintSurface,
  isJobAnchorProblem,
} from './check-doc-closure.js';
import { InputError as WorkflowJobsError, readJobs } from './check-workflow-bounds.js';
import {
  MATCH_STAT_FIELDS,
  NORMALIZED_FIELD_CLASSES,
  PATH_FIELDS,
  RELAX_KINDS,
  SCROLL_AMOUNT_FIELDS,
  sessionsIn,
} from './corpus-compare.js';
import { PREDICATES, RECORDING_PREDICATES } from './sufficiency-lint.js';

const SELF_PATH = selfPath(import.meta.filename);

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
/** Repo-relative path of the meta-schema every committed conformance vector is shaped by. */
export const VECTOR_SCHEMA_PATH = 'corpus/vector.schema.json';
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
/** The clause stating the outcome every committed conformance vector carries. */
export const OUTCOME_CLAUSE_ID = 'STC-23';

/** Exact header tuple of the normalization-class table. */
export const NORMALIZATION_TABLE_HEADER = ['Class', 'Rule'];
/** Exact header tuple of the per-action predicate table. */
export const PER_ACTION_TABLE_HEADER = ['Predicate', 'Applies to', 'Requires'];
/** Exact header tuple of the recording-level predicate table. */
export const RECORDING_TABLE_HEADER = ['Predicate', 'Class', 'States'];

/** The class every per-action predicate carries. */
export const PER_ACTION_CLASS = 'fail';
/**
 * The heading the lint document states that class in, with the class itself as
 * the capture. Capturing it rather than matching it is what makes a heading
 * restating another class READ and diffed instead of missed: only a heading
 * that no longer states a class this way is absent, and the exactly-one rule
 * on the match count refuses a document carrying two rather than reading the
 * first one it finds.
 */
export const PER_ACTION_HEADING_RE = /^#{1,6} +Per-action predicates \(all (.+) class\)\s*$/gm;
/** A finding class as the lint document writes one. */
export const CLASS_TOKEN_RE = /^[a-z][a-z-]*$/;
/** What a readable class looks like in that heading. */
export const PER_ACTION_CLASS_EXPECTATION =
  'the class that heading states is one lower-case backticked token and nothing else';

/** The property §STC-23 and the vector meta-schema both state a vector's outcome under. */
export const OUTCOME_FIELD = 'expected_outcome';
/** An outcome as the clause and the meta-schema write one: lower-case, hyphen-separated. */
export const OUTCOME_TOKEN_RE = /^[a-z][a-z-]*$/;
/** What a readable token looks like in §STC-23's scope, beside the field name. */
export const OUTCOME_TOKEN_EXPECTATION =
  'the clause states its outcome as a lower-case hyphenated token, beside the field name it states that outcome under';

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
/** A job citation as a scanned verification document writes one. */
const JOB_CITE_RE = /`([a-z0-9-]+)` job/g;

/**
 * The documents whose job citations this leg holds — the check's own declared
 * decision about which documentation surfaces are kept honest, stated here
 * once instead of at the call site, so widening the leg is an edit to a list
 * a reviewer can read. The unit suite holds this list to the tracked documents
 * under docs/verification/, so a third verification document reds there rather
 * than landing silently outside the leg.
 */
export const CITED_JOB_DOCUMENTS = [CORPUS_DOC_PATH, LINT_DOC_PATH];

/**
 * The workflow job whose own steps the job-suite leg reads — the job both
 * verification documents name as the one that runs the shared unit suite in
 * CI. This check's own constant, on the same footing as the scanned-document
 * list above: a job neither document claims a suite for has nothing to be
 * held to here, and a second job that one of them does claim is outside the
 * leg until it is named here.
 */
export const UNIT_SUITE_JOB_ID = 'unit-tests';

/**
 * The registered suite directory that job is held to running: the shared unit
 * tree, where both documents' own locks live. The GLOB is not stated here —
 * {@link registeredNodeSuite} takes it off the discovery descriptor
 * `DOC_INVENTORIES` registers this directory under, so the suite this leg
 * demands of the job and the suite the test-inventory lint demands a
 * documented row for are one statement rather than two.
 */
export const UNIT_SUITE_DIR = 'packages/shared/tests/unit';

/** An `npm run` as one of a step's command segments opens with it. */
const NPM_RUN_SEGMENT_RE = /^npm\s+run(?:\s|$)/;
/** A script key as `npm run` states one, once npm's own flags are behind it. */
const SCRIPT_TOKEN_RE = /^[A-Za-z0-9:_-]+$/;
/** A `cd` as one of a step's command segments states it. */
const CD_SEGMENT_RE = /^cd(?:\s|$)/;

/**
 * The invocations this reading models, as the head of a command segment. A
 * segment opening with one of them is handed to the argument reader as the
 * step's own command; a segment stating one anywhere else is refused by name,
 * because the argument reader would find the invocation in a position no shell
 * runs it from and credit the segment with arguments the step never states.
 */
const MODELLED_INVOCATIONS = new Set(['node', 'npx', 'c8', 'npm']);

/** The operators a step's `run:` text states between its commands. */
const SEGMENT_OPERATORS = ['&&', '||', ';', '|'];
/** The operators that keep a command's verdict from reaching the job. */
const SWALLOWING_OPERATORS = ['||', '|'];
/** The operator whose swallowing depends on where on the line it stands. */
const CONDITIONAL_OPERATOR = '&&';

/**
 * One step's `run:` text, split the way {@link commandSegments} splits it and
 * answered with the operator state each segment stands in. A LOCAL positional
 * lexer, because `commandSegments` consumes the operators and exports no
 * stripper: the rules it applies are that function's own — a `#` preceded by
 * whitespace opens a comment that runs to the end of its line, quoted text is
 * data rather than command text, a segment is trimmed and loses an opening
 * `(` — and the unit suite holds the two to the same answers over the same
 * text. What this lexer adds is position: for each segment, the operator
 * immediately before it, the operator immediately after it, every operator its
 * own line states, and whether that line is the last line of the block to
 * state a command at all (a trailing blank or comment-only line states none,
 * so it does not move the last one).
 *
 * Inherited limit, the segment grammar's own: text inside a heredoc body or a
 * command substitution is read as the line's own, so an operator written there
 * counts as the line's.
 * @param {string} text one step's `run:` block
 * @returns {{ command: string, before: string | null, after: string | null,
 *             operators: string[], line: number, last: boolean }[]}
 */
export function commandOperators(text) {
  const items = []; // { kind: 'command' | 'operator' | 'break', text, line }
  let current = '';
  let line = 0;
  let quote = null;
  let comment = false;
  const flush = (line_) => {
    const command = current.trim().replace(/^\(\s*/, '');
    if (command !== '') items.push({ kind: 'command', text: command, line: line_ });
    current = '';
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (comment) {
      if (char !== '\n') continue;
      comment = false;
      flush(line);
      items.push({ kind: 'break', line });
      line++;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        current += char;
        quote = null;
      }
      continue; // quoted text is data the shell passes on, never a command
    }
    if (char === '#' && (at === 0 || /\s/.test(text[at - 1]))) {
      comment = true;
      continue;
    }
    if (char === '\n') {
      flush(line);
      items.push({ kind: 'break', line });
      line++;
      continue;
    }
    const operator = SEGMENT_OPERATORS.find((op) => text.startsWith(op, at));
    if (operator !== undefined) {
      flush(line);
      items.push({ kind: 'operator', text: operator, line });
      at += operator.length - 1;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    current += char;
  }
  flush(line);

  const commandLines = new Set(items.filter((i) => i.kind === 'command').map((i) => i.line));
  const lastLine = Math.max(-1, ...commandLines);
  const neighbour = (from, step) => {
    for (let at = from + step; at >= 0 && at < items.length; at += step) {
      if (items[at].kind === 'break') return null;
      if (items[at].kind === 'operator') return items[at].text;
    }
    return null;
  };
  return items
    .map((item, at) => ({ item, at }))
    .filter(({ item }) => item.kind === 'command')
    .map(({ item, at }) => ({
      command: item.text,
      before: neighbour(at, -1),
      after: neighbour(at, +1),
      operators: items.filter((i) => i.kind === 'operator' && i.line === item.line).map((i) => i.text), // prettier-ignore
      line: item.line,
      last: item.line === lastLine,
    }));
}

/**
 * The script key one command segment states through `npm run`, with npm's own
 * `-`-prefixed flags stepped over so a flagged invocation resolves rather than
 * taking the flag for the key. Undefined where the segment states no `npm run`
 * at all; `{ unreadable: true }` where it states one whose key this reader
 * cannot read — a key carrying a character the grammar does not admit, a
 * closing paren riding it among them — which the leg refuses by name rather
 * than passing over as a segment stating nothing.
 * @param {string} segment one command segment
 * @returns {{ token: string } | { unreadable: true } | undefined}
 */
export function npmRunScript(segment) {
  if (!NPM_RUN_SEGMENT_RE.test(segment)) return undefined;
  const words = segment.split(/\s+/).filter(Boolean).slice(2);
  const token = words.find((word) => !word.startsWith('-'));
  if (token === undefined || !SCRIPT_TOKEN_RE.test(token)) return { unreadable: true };
  return { token };
}

/**
 * One suite directory's registered `node --test` discovery, read off the
 * registration rather than restated: the `DOC_INVENTORIES` entry for that
 * directory, where a `node --test` glob is how it is discovered. Undefined
 * where no entry registers it that way — this check's {@link UNIT_SUITE_DIR}
 * and the registration it reads disagreeing, which the leg names as such
 * instead of reporting a job that runs nothing.
 * @param {string} dir the suite directory, repo-relative
 * @returns {{ doc: string, section: string, dir: string, pattern: string } | undefined}
 */
export function registeredNodeSuite(dir) {
  const entry = DOC_INVENTORIES.find((e) => e.dir === dir && e.discovery?.runner === RUNNERS.node);
  if (entry === undefined) return undefined;
  return { doc: entry.doc, section: entry.section, dir: entry.dir, pattern: entry.discovery.pattern }; // prettier-ignore
}

/** One registered node discovery as a reader of a command states its argument. */
export const suiteGlob = (suite) => `${suite.dir}/${suite.pattern}`;

/**
 * The `node --test` arguments one command text states, classified: the
 * test-inventory lint's own argument reader, then its own classifier, so the
 * answers this leg compares are the ones that gate itself would select. The
 * first refusal either reader states is the answer — reading past it would
 * credit the command with arguments it does not state.
 * @param {string} text one command line
 * @returns {{ globs: { dir: string, pattern: string }[], classified: number }
 *           | { error: string }}
 */
function classifiedArguments(text) {
  const read = nodeTestArguments(text);
  if (read.error !== undefined) return { error: read.error };
  const globs = [];
  let classified = 0;
  for (const argument of read.args) {
    const answer = classifyArgument(argument);
    if (answer.error !== undefined) return { error: answer.error };
    classified++;
    if (answer.kind === 'glob') globs.push({ dir: answer.dir, pattern: answer.pattern });
  }
  return { globs, classified };
}

/**
 * How a refusal names the step it is about: the step's own `name` where it
 * states one, and its position in the job's `steps` list where it does not.
 * @param {Record<string, unknown>} step one step of the job
 * @param {number} index that step's position in the job's `steps` list
 * @returns {string}
 */
function stepSubject(step, index) {
  const name = step?.name;
  return typeof name === 'string' && name !== ''
    ? `the step named \`${name}\``
    : `the step at index ${index} of its \`steps\` list`;
}

/**
 * What one workflow job's own steps state they run `node --test` over, read
 * the way the runner resolves it: each step's `run:` block split into the
 * command segments a shell would run, and each segment that OPENS with a
 * modelled invocation read both as the step's own command and — where it states
 * `npm run <script>` — through that script's command in the root manifest. Both
 * readings go to the test-inventory lint's own argument reader, so what this leg
 * compares is what that gate itself would select. A step spelling the
 * invocation out rather than naming a script is therefore read as what it is,
 * and npm's own `-`-prefixed flags are stepped over so a flagged `npm run`
 * resolves to the script it names.
 *
 * The answer carries flat fields across the whole job — every script key read,
 * every classified glob, and the refusals — beside a `steps` array answering
 * per step: its name, its position, the condition and the tolerance it states,
 * and one entry per resolving segment carrying that segment's command, its
 * classified globs, and the operator state it stands in. The verdict function
 * is where the registered suite is known, so it is what decides which of those
 * states refuses a step; this reader stays a reader of its arguments.
 *
 * Shapes refused rather than read, each for the same reason — the command they
 * state does not resolve against the root of the repository, or does not resolve
 * at all, and this reading guesses at neither. A `cd` segment ends the STEP it
 * stands in — not merely its line — because everything after it, on that line
 * and on the lines of the same block below it, runs somewhere else; the job
 * this leg reads carries exactly such a step, invoking a script of the same
 * NAME from another package's manifest, so a reading that took that segment on
 * its own would resolve the name against the root manifest and report the root
 * suite as still run after the root step is gone. A step stating its own
 * `working-directory` is refused by name for the same reason, and named rather
 * than skipped so the leg cannot answer green over a job whose commands it
 * declined to read. A segment stating a modelled invocation somewhere other
 * than its own head is refused by name: the argument reader would find the
 * invocation in a position no shell runs it from, so `echo node --test <glob>`
 * would otherwise read as a step carrying the suite and `time npm run <script>`
 * as a step stating no command at all. A segment whose `npm run` script key
 * this reader cannot read is refused the same way, for the same reason.
 * @param {Record<string, unknown>} jobsMap the workflow's `jobs` map
 * @param {Record<string, string>} commands the root manifest's script commands
 * @param {string} jobId the job whose steps to read
 * @returns {{ absent: boolean, tokens: string[],
 *             globs: { dir: string, pattern: string }[], refusals: string[],
 *             jobContinueOnError: string | null,
 *             steps: { name: string | undefined, index: number,
 *                      condition: string | null, continueOnError: string | null,
 *                      segments: { command: string, classified: number,
 *                                  globs: { dir: string, pattern: string }[],
 *                                  before: string | null, after: string | null,
 *                                  operators: string[], last: boolean }[] }[] }}
 */
export function jobSuiteArguments(jobsMap, commands, jobId) {
  const job = jobsMap[jobId];
  if (job === undefined) {
    return { absent: true, tokens: [], globs: [], refusals: [], jobContinueOnError: null, steps: [] }; // prettier-ignore
  }
  const tokens = [];
  const globs = [];
  const refusals = [];
  const steps = [];
  const jobSteps = Array.isArray(job?.steps) ? job.steps : [];
  for (const [index, step] of jobSteps.entries()) {
    if (typeof step?.run !== 'string') continue;
    const directory = step?.['working-directory'];
    if (directory !== undefined) {
      refusals.push(`runs a step under \`working-directory: ${directory}\`, a relocation this reading does not follow`); // prettier-ignore
      continue;
    }
    const segments = [];
    for (const lexed of commandOperators(step.run)) {
      if (CD_SEGMENT_RE.test(lexed.command)) break; // a `cd` moves the rest of the step
      const words = lexed.command.split(/\s+/).filter(Boolean);
      if (!MODELLED_INVOCATIONS.has(words[0])) {
        const offHead = words.find((word) => MODELLED_INVOCATIONS.has(word));
        if (offHead !== undefined) {
          refusals.push(`states \`${offHead}\` somewhere other than the head of the command segment \`${lexed.command}\`, a position this reading does not resolve`); // prettier-ignore
        }
        continue;
      }
      const script = npmRunScript(lexed.command);
      if (script?.unreadable === true) {
        refusals.push(`states \`npm run\` in the command segment \`${lexed.command}\`, whose script key this reader cannot read — the key is what the root manifest is asked for`); // prettier-ignore
        continue;
      }
      // The step's own command first: a step that spells the invocation out
      // states its suite here, and a reader error on it is the step's, not a
      // script key's.
      const own = classifiedArguments(lexed.command);
      if (own.error !== undefined) {
        refusals.push(`states \`${lexed.command}\` in ${stepSubject(step, index)}, a command that ${own.error}`); // prettier-ignore
        continue;
      }
      let viaScript = { globs: [], classified: 0 };
      if (script !== undefined) {
        tokens.push(script.token);
        const command = commands[script.token];
        if (typeof command !== 'string') {
          refusals.push(`states \`npm run ${script.token}\`, which ${PACKAGE_JSON_PATH} defines no script for`); // prettier-ignore
          continue;
        }
        viaScript = classifiedArguments(command);
        if (viaScript.error !== undefined) {
          refusals.push(`states \`npm run ${script.token}\`, whose command ${viaScript.error}`);
          continue;
        }
      }
      const merged = [...own.globs, ...viaScript.globs];
      globs.push(...merged);
      segments.push({
        command: lexed.command,
        classified: own.classified + viaScript.classified,
        globs: merged,
        before: lexed.before,
        after: lexed.after,
        operators: lexed.operators,
        last: lexed.last,
      });
    }
    steps.push({
      name: typeof step?.name === 'string' ? step.name : undefined,
      index,
      condition: step?.if === undefined ? null : String(step.if),
      continueOnError: step?.['continue-on-error'] ? String(step['continue-on-error']) : null,
      segments,
    });
  }
  return {
    absent: false,
    tokens: [...new Set(tokens)],
    globs,
    refusals,
    jobContinueOnError: job?.['continue-on-error'] ? String(job['continue-on-error']) : null,
    steps,
  };
}

/**
 * What a carrying step states that keeps this reader from answering for its
 * verdict, named as the refusal names it. A step whose resolution does NOT
 * carry the registered suite is not asked: it may state whatever it likes.
 *
 * The operator rules follow the shell the workflow runs a `run:` block under —
 * `bash -e`, with no pipefail. `||` anywhere on the carrying command's line
 * swallows the verdict whichever side of the command it stands on: before it,
 * the command may never run at all; after it, its failure is absorbed. `|`
 * hands the verdict to the last command of the pipeline instead. `&&` BEFORE
 * the command is the same absorption, because a failed left side of `&&` is not
 * fatal under errexit and the block runs on — which is also why `&&` AFTER the
 * command swallows only while its line is not the block's last command line:
 * there the step's verdict is the last line's, so an earlier line's absorbed
 * failure never reaches the job. Admitted, therefore: `;`, which errexit aborts
 * at, and `&&` after the command on the block's last line.
 * @param {{ condition: string | null, continueOnError: string | null,
 *           segments: { globs: { dir: string, pattern: string }[],
 *                       before: string | null, after: string | null,
 *                       operators: string[], last: boolean }[] }} step
 * @param {{ dir: string, pattern: string }} suite the registered discovery
 * @param {string | null} jobTolerance the job's own recorded `continue-on-error`
 * @returns {string[]} the offenders, each as a refusal names it; empty admits
 */
function carryingStepOffenders(step, suite, jobTolerance) {
  const carrying = (step.segments ?? []).filter((segment) =>
    segment.globs.some((g) => g.dir === suite.dir && g.pattern === suite.pattern),
  );
  if (carrying.length === 0) return [];
  const offenders = [];
  if (step.condition !== null) offenders.push(`the condition \`if: ${step.condition}\``);
  if (step.continueOnError !== null) {
    offenders.push(`the tolerance \`continue-on-error: ${step.continueOnError}\``);
  }
  if (jobTolerance !== null) {
    offenders.push(`the job's own tolerance \`continue-on-error: ${jobTolerance}\``);
  }
  const operators = new Set();
  for (const segment of carrying) {
    for (const operator of SWALLOWING_OPERATORS) {
      if (segment.operators.includes(operator)) operators.add(operator);
    }
    if (segment.before === CONDITIONAL_OPERATOR) operators.add(CONDITIONAL_OPERATOR);
    if (segment.after === CONDITIONAL_OPERATOR && !segment.last) {
      operators.add(CONDITIONAL_OPERATOR);
    }
  }
  for (const operator of operators) {
    offenders.push(`the \`${operator}\` its own line states between commands`);
  }
  return offenders;
}

/**
 * The job-suite leg's verdict: the registered suite this check names, against
 * what the named job's own steps resolve to. The registered suite is known
 * here and nowhere upstream, so this is also where a carrying step's condition,
 * tolerance, and operator state are judged.
 *
 * The states are named apart, because the remedies differ. A registration
 * this check's directory constant no longer matches names that constant and
 * the registration — the leg has nothing left to hold the job to. A job the
 * workflow no longer carries names the workflow, beside the citation leg,
 * which reds on every document cite of that same id. A job none of whose
 * commands this reading resolves, by either route, names the job and stops
 * there: a scan that read nothing would answer green forever, so it is refused
 * rather than reported as a suite the job dropped. A step that carries the
 * suite under something this reader does not evaluate is refused by name and
 * does not count as carrying it, so a refused SOLE carrying step prints that
 * refusal and the suite-absent finding together — the two lines are the
 * verdict — while a refused second carrying step beside an admitted one prints
 * the refusal alone, the membership test being satisfied without it. Those
 * refusals print their own line rather than going through the reader-refusal
 * wrapper below, whose "cannot be resolved" clause is false of them: the
 * command resolved, and what the step does with its verdict is the finding.
 *
 * An answer carrying no `steps` array reads as one stating no steps, and the
 * membership test then falls back to the flat glob field — the shape a caller
 * that hands this function a glob set directly states.
 * @param {{ doc: string, section: string, dir: string, pattern: string } | undefined} suite
 *   the registered discovery, or undefined where the registration states none
 * @param {{ absent: boolean, tokens: string[],
 *           globs: { dir: string, pattern: string }[], refusals: string[],
 *           jobContinueOnError?: string | null, steps?: object[] }} read
 *   what {@link jobSuiteArguments} answered for the job
 * @returns {string[]} problems; empty when the job states the registered glob
 */
export function jobSuiteProblems(suite, read) {
  if (suite === undefined) {
    return [`${SELF_PATH} holds CI's \`${UNIT_SUITE_JOB_ID}\` job to running \`${UNIT_SUITE_DIR}\`, which DOC_INVENTORIES registers no \`node --test\` discovery for — that descriptor is where the glob this leg demands of the job comes from, so the leg has nothing left to hold it to: point UNIT_SUITE_DIR at a registered node suite directory, or retire the leg in the same change`]; // prettier-ignore
  }
  if (read.absent) {
    return [`${TEST_WORKFLOW_PATH} has no \`${UNIT_SUITE_JOB_ID}\` job, so nothing there states that ${suiteGlob(suite)} — the suite ${suite.doc} ("${suite.section}") registers — is run in CI: restore the job, or move UNIT_SUITE_JOB_ID in ${SELF_PATH} to the job that runs it, in the change that renames it`]; // prettier-ignore
  }
  const problems = read.refusals.map(
    (refusal) => `${TEST_WORKFLOW_PATH}'s \`${UNIT_SUITE_JOB_ID}\` job ${refusal}, so what that step runs cannot be resolved — the suite this leg holds the job to is then neither found nor ruled out`, // prettier-ignore
  );
  const steps = Array.isArray(read.steps) ? read.steps : undefined;
  // The vacuity guard counts what the reading resolved, by either route: a
  // script key it looked up, or a `node --test` argument it classified off a
  // step's own command. A step refused for what it does with its verdict still
  // resolved its command, so it is counted here — this guard answers for a scan
  // that read nothing, never for a step whose verdict was declined.
  const resolved =
    steps === undefined
      ? read.globs.length
      : steps.reduce((n, s) => n + s.segments.reduce((m, g) => m + g.classified, 0), 0);
  if (read.tokens.length === 0 && resolved === 0) {
    problems.push(`${TEST_WORKFLOW_PATH}'s \`${UNIT_SUITE_JOB_ID}\` job states no \`npm run\` this reader could resolve and no \`node --test\` invocation it could read, in any \`run:\` line a \`cd\` does not move, so this leg read none of that job's commands — a scan that reads nothing would pass forever, so it reds here rather than reporting the suite as one the job dropped`); // prettier-ignore
    return problems;
  }
  const admitted = [];
  for (const step of steps ?? []) {
    const offenders = carryingStepOffenders(step, suite, read.jobContinueOnError ?? null);
    const subject = step.name === undefined ? `the step at index ${step.index} of its \`steps\` list` : `the step named \`${step.name}\``; // prettier-ignore
    for (const offender of offenders) {
      problems.push(`${TEST_WORKFLOW_PATH}'s \`${UNIT_SUITE_JOB_ID}\` job states ${suiteGlob(suite)} in ${subject}, under ${offender} — which this reader does not evaluate, so it cannot answer that running the job runs the suite: state the suite in a step this reading admits, carrying no condition, no tolerance, and no operator that keeps its verdict from the job, or teach the reader to read ${offender}`); // prettier-ignore
    }
    if (offenders.length > 0) continue; // refused: this step does not carry the suite
    admitted.push(...step.segments.flatMap((segment) => segment.globs));
  }
  const carried = steps === undefined ? read.globs : admitted;
  if (!carried.some((g) => g.dir === suite.dir && g.pattern === suite.pattern)) {
    const reading = carried.length === 0 ? 'no `node --test` suite at all' : carried.map(suiteGlob).join(', '); // prettier-ignore
    problems.push(`${TEST_WORKFLOW_PATH}'s \`${UNIT_SUITE_JOB_ID}\` job states no command resolving to ${suiteGlob(suite)}, the discovery ${suite.doc} ("${suite.section}") registers — the commands this reading admits resolve to ${reading} — while both verification documents state that job runs that suite in CI: put the suite back in that job's command, or stop the documents claiming it`); // prettier-ignore
  }
  return problems;
}

/**
 * The legs this check runs, and the home of their names. Each entry carries
 * the `label` the success line prints for it and the `bullet` its
 * header-docblock entry opens with. The success line is rendered from
 * `label`, and the unit suite holds `bullet` to the docblock's bullet list
 * both ways, so a leg gained or retired is one edit here plus the bullet that
 * edit is red without — rather than a sentence, a comment, and a map entry
 * each restating the set by hand. The CI guide's lint-table row for this gate
 * states the gate's drift classes in the guide's own words and is held to
 * this constant by nothing.
 *
 * The cut is the docblock's: one entry per bullet, each naming the surface it
 * holds and citing what that entry is read against — a clause of the corpus
 * doctrine for most, the sufficiency-lint document whose tables the predicate
 * catalogue is read against, and the workflow for the job citations, which
 * this file's header records as the one leg with no registered clause behind
 * it. Sub-holds ride with their leg — the per-action class heading with the
 * predicate catalogue, the meta-schema's `required` membership with the
 * vector outcome, and the gate-argument cross-check over each command's own
 * `--platform` and `--baseline` plus the watched-platform population diff
 * with the strict-flip watch — because each is that leg's own surface read a
 * second way, not a subject of its own. The session catalogue's manifest side
 * is the watched desktop platform's active sessions, so that leg reads through
 * the watch's platform list.
 */
export const INVENTORY_LEGS = [
  { label: 'relaxation-coverage', bullet: 'the relaxation coverage lists' },
  { label: 'relaxation-kind-set', bullet: 'the closed kind set' },
  { label: 'normalization', bullet: 'the normalization classes' },
  { label: 'session', bullet: 'the desktop session catalogue' },
  { label: 'predicate', bullet: 'the predicate catalogue' },
  { label: 'vector-outcome', bullet: 'the shipping outcome' },
  { label: 'gate-watch', bullet: 'the strict-flip watch' },
  { label: 'job-citation', bullet: 'the job citations' },
  { label: 'job-suite', bullet: 'the suite the cited job runs' },
];

/**
 * The leg labels as the success line lists them: the last joined by `and`,
 * with the serial comma from three labels on and none at two — `a and b`,
 * `a, b, and c`. A single leg renders as its own label alone, so the sentence
 * stays grammatical however far the set is ever narrowed.
 * @param {{ label: string }[]} [legs] the legs to list
 * @returns {string} the rendered list
 */
export function legList(legs = INVENTORY_LEGS) {
  const labels = legs.map((leg) => leg.label);
  if (labels.length < 2) return labels.join('');
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

/**
 * How many causes a diagnosis names before it counts the rest. A watch verdict
 * is one line in a list, and the population it names is a corpus that grows.
 */
export const NAMED_CAUSE_CAP = 3;

/**
 * The causes a diagnosis names, capped: up to {@link NAMED_CAUSE_CAP} of them
 * by name, then how many more there are. An empty list renders as the empty
 * string, so a caller can append this to a message that stands on its own —
 * which is also what a hand-built watch entry omitting the population gets.
 * @param {string[]} causes what is holding the state the diagnosis reports
 * @param {number} [cap] how many to name
 * @returns {string} ` (a, b, and N more)`, or '' for nothing to name
 */
export function namedCauses(causes, cap = NAMED_CAUSE_CAP) {
  if (causes.length === 0) return '';
  const named = causes.slice(0, cap);
  const rest = causes.length - named.length;
  return ` (${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''})`;
}

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
 * The shipping outcome §STC-23 states, and whether the clause still names the
 * field it states that outcome under. The clause's WHOLE section is read: it
 * carries no declarative anchor phrase to slice a sentence at, and a
 * sentence scan would bound at the period inside the clause's own marker.
 * Reading it whole keeps every token the clause carries in scope, which is
 * what the grammars below then bin.
 *
 * The field name is this check's own constant, matched against the document
 * rather than inferred from where a token sits: both tokens the clause
 * carries are lower-case words, so shape cannot tell the field from the
 * outcome, and a positional rule would misread an equivalent reword. Every
 * remaining token is either outcome-shaped or returned unreadable, never
 * dropped. Repeats collapse: the clause states its outcome in running prose,
 * so a sibling sentence naming the same field or outcome again is a sentence,
 * not a second entry — the carve-out the citation leg takes, for the reason it
 * takes it.
 *
 * `fields` is therefore never a population: every entry it can take is this
 * check's own constant and the token stream is deduplicated, so it comes back
 * carrying that one token or nothing. It is a list because the emptiness guard
 * that reads it takes lists, and the guard's question of it is the only one
 * asked — whether the clause still names the field at all.
 * @param {string} docText the corpus doctrine's text
 * @returns {{ fields: string[], outcomes: string[],
 *             unreadableTokens: { where: string, token: string, expected: string }[] }}
 *   `fields` holding that one token or nothing
 */
export function extractStatedOutcome(docText) {
  const clause = extractClauseSection(docText, OUTCOME_CLAUSE_ID);
  const where = `${CORPUS_DOC_PATH} §${OUTCOME_CLAUSE_ID}`;
  const fields = [];
  const outcomes = [];
  const unreadableTokens = [];
  for (const token of backtickedTokens(clause, { dedupe: true })) {
    if (token === OUTCOME_FIELD) fields.push(token);
    else if (OUTCOME_TOKEN_RE.test(token)) outcomes.push(token);
    else unreadableTokens.push({ where, token, expected: OUTCOME_TOKEN_EXPECTATION });
  }
  return { fields, outcomes, unreadableTokens };
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
 * The class the lint document's per-action heading states of all its
 * predicates. Read from the document's fence-stripped text rather than from a
 * clause section: that heading sits outside every clause scope, so it is
 * ordinary prose — and a heading written inside an illustrative fence is not
 * the document's claim about its own catalogue.
 *
 * The match count comes back with it, so the caller can refuse a document
 * stating that class in no heading or in two: either way the attribution this
 * check prints would be a guess. A stated class the grammar cannot read comes
 * back as an unreadable entry with its own expectation, never as a claim that
 * silently went absent — and it carries the heading's fragment AS WRITTEN,
 * marked so the shared renderer shows it verbatim. The channel's other
 * producers hand a name whose backticks the extraction already consumed, so
 * that renderer puts them back; here the backticks are part of what can be
 * wrong — absent, or wrapped around more than one token — and a fragment the
 * renderer re-wrapped would show an unbackticked class as exactly the
 * backticked token its expectation asks for.
 * @param {string} docText the sufficiency-lint doctrine's text
 * @returns {{ klass: string | null, matches: number,
 *             unreadableTokens: { where: string, token: string, asWritten?: boolean,
 *                                 expected: string }[] }}
 */
export function extractPerActionClass(docText) {
  const headings = [...stripFences(docText ?? '').matchAll(PER_ACTION_HEADING_RE)];
  if (headings.length !== 1) {
    return { klass: null, matches: headings.length, unreadableTokens: [] };
  }
  const stated = headings[0][1].trim();
  const klass = backtickedName(stated);
  if (klass === null || !CLASS_TOKEN_RE.test(klass)) {
    const where = `${LINT_DOC_PATH}'s per-action heading`;
    return {
      klass: null,
      matches: 1,
      unreadableTokens: [
        { where, token: stated, asWritten: true, expected: PER_ACTION_CLASS_EXPECTATION },
      ],
    };
  }
  return { klass, matches: 1, unreadableTokens: [] };
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
 * The job citations of every document the citation leg scans, in the order the
 * scanned set states them. The set is the caller's — {@link CITED_JOB_DOCUMENTS}
 * at the one call site — so the leg's population is a list a reader can find,
 * and a document added to that list is scanned by the same edit.
 * @param {string[]} paths the documents to scan
 * @param {(path: string) => string} readDoc one scanned document's text
 * @returns {{ path: string, cites: string[] }[]}
 */
export function documentCitations(paths, readDoc) {
  return paths.map((path) => ({ path, cites: extractJobCites(readDoc(path)) }));
}

/**
 * The non-empty guard's legs: every parsed surface the guard speaks for, with
 * its empty-parse diagnosis. Exported so the unit suite's family is generated
 * from this list — a leg added here is exercised automatically, and the suite
 * holds the list non-empty and its diagnoses distinct. The per-document
 * citation extractions are guarded separately (one leg per scanned document).
 *
 * The outcome the vector meta-schema states is guarded by its reader instead:
 * {@link readVectorOutcome} holds that `const` to the outcome grammar and
 * refuses a meta-schema stating none as this check's machinery verdict, so the
 * surface reaches this guard stating an outcome, and a meta-schema that states
 * none stops the run before this guard is reached.
 */
export const EMPTY_SURFACES = [
  ['docKinds', `no relaxation kinds found in ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID}`],
  ['docStatedKinds', `no relaxation kinds found in ${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}`], // prettier-ignore
  ['codeKinds', `no relaxation kinds found in the comparator's RELAX_KINDS`],
  ['docNormalizationTokens', `no class field tokens found in ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}`], // prettier-ignore
  ['codeNormalizationTokens', `no field tokens found in the comparator's normalization class map`],
  ['docSessionIds', `no session ids found in ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID}`],
  ['docOutcomeFields', `no \`${OUTCOME_FIELD}\` field token found in ${CORPUS_DOC_PATH} §${OUTCOME_CLAUSE_ID}, which is the property ${VECTOR_SCHEMA_PATH} states a committed vector's outcome under`], // prettier-ignore
  ['docOutcomes', `no shipping outcome found in ${CORPUS_DOC_PATH} §${OUTCOME_CLAUSE_ID}`],
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
 * @param {string[]} s.docOutcomeFields §STC-23's own token for the outcome
 *   field, which is this check's constant or nothing: the scan matches against
 *   that constant and deduplicates, so this surface states the field's presence
 *   rather than a population
 * @param {string[]} s.docOutcomes the outcome §STC-23 states committed vectors carry
 * @param {string[]} s.schemaOutcomes what the vector meta-schema states under that field
 * @param {boolean} s.schemaRequiresOutcome whether the meta-schema requires the field
 * @param {string[]} s.docPerAction the per-action table's predicate names
 * @param {number} s.perActionTableMatches how many tables carry its header tuple
 * @param {string | null} s.docPerActionClass the class the per-action heading states
 * @param {number} s.perActionHeadingMatches how many headings state that class
 * @param {string[]} s.codePerAction the lint's per-action predicate ids
 * @param {string[]} s.codeNonFailPerAction those whose class is not `fail`
 * @param {string[]} s.docRecording the recording-level table's `"<id> <class>"` pairs
 * @param {number} s.recordingTableMatches how many tables carry its header tuple
 * @param {string[]} s.codeRecording the lint's recording-level pairs
 * @param {string[]} s.predicateUnreadable unreadable predicate-table cells
 * @param {{ where: string, token: string, asWritten?: boolean, expected: string }[]}
 *   s.unreadableTokens backticked tokens a scanned scope carries that its
 *   grammar cannot read, each with the expectation its own scope states; an
 *   `asWritten` entry carries the scope's fragment showing its own delimiters
 *   rather than a token whose backticks the extraction consumed
 * @param {{ path: string, cites: string[] }[]} s.docCites per-document job citations
 * @param {{ platform: string, script: string, baselinePath: string,
 *           knownDiffsEmpty: boolean, knownDiffsCarrying: string[],
 *           failFree: boolean, failKeys: string[], strict: boolean,
 *           lintStrict: boolean, platformArg: string | null,
 *           baselineArg: string | null }[]} s.strictWatch per-platform gate
 *   state: whether each trigger has come true, which baseline keys are holding
 *   a shut one shut, whether its flag is passed, and the platform and baseline
 *   the gate command itself names
 * @param {string[]} s.manifestPlatforms every platform the session catalogue carries
 * @param {string[]} s.watchedPlatforms the platforms the strict-flip watch covers
 * @param {string | null} s.sufficiencyBaselineArg the baseline `sufficiency:check` names
 * @param {string[]} s.workflowJobIds test.yml's job ids
 * @param {[string, string][]} emptySurfaces the non-empty guard's legs, defaulting
 *   to {@link EMPTY_SURFACES}
 * @returns {string[]} problems; empty when every inventory holds
 */
export function evaluateVerificationInventory(s, emptySurfaces = EMPTY_SURFACES) {
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
  for (const { where, token, asWritten, expected } of s.unreadableTokens) {
    // A token producer hands a name whose backticks its extraction consumed, so
    // they go back on here; an `asWritten` entry already shows its own
    // delimiters and is rendered verbatim, the way the predicate cell above is.
    const carried = asWritten ? token : `\`${token}\``;
    problems.push(`${where} carries ${carried}, which the scan cannot read — ${expected} — and a token the scan cannot read is an inventory entry it would silently drop`); // prettier-ignore
  }
  for (const [count, header, where] of [
    [s.normalizationTableMatches, NORMALIZATION_TABLE_HEADER, `${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}`], // prettier-ignore
    [s.perActionTableMatches, PER_ACTION_TABLE_HEADER, `${LINT_DOC_PATH}'s per-action catalogue`],
    [s.recordingTableMatches, RECORDING_TABLE_HEADER, `${LINT_DOC_PATH}'s recording-level catalogue`], // prettier-ignore
  ]) {
    // Scalar counts, guarded fail-closed on the `!== 1` form the shared rule
    // states (`emptySurfaceProblems` in scripts/check-test-inventory.js): a
    // surface stating no count hands this `undefined`, which is not 1, so a
    // read that answered nothing reds here rather than passing over.
    if (count !== 1) {
      problems.push(`${where}: ${count} table(s) carry the header \`${header.join(' | ')}\` — the scan reads exactly one`); // prettier-ignore
    }
  }
  // The same fail-closed `!== 1` form on the one heading this check reads: a
  // document stating its per-action class in no heading, or in two, leaves the
  // attribution the class finding prints a guess, so the count reds here and
  // the class itself is never read from whichever heading came first.
  if (s.perActionHeadingMatches !== 1) {
    problems.push(`${LINT_DOC_PATH}: ${s.perActionHeadingMatches} heading(s) state the per-action predicates' class — the scan reads exactly one`); // prettier-ignore
  }
  for (const { path, cites } of s.docCites) {
    if (cites.length === 0) {
      problems.push(`no job citations found in ${path} — a scanned document that cites nothing cannot tell a scan that broke from a document that legitimately stopped citing, so this reds either way: restore a job cite, or drop the document from CITED_JOB_DOCUMENTS in ${SELF_PATH}, which the unit suite holds equal to the tracked docs/verification documents — so dropping one means retiring or narrowing that case in the same change`); // prettier-ignore
    }
  }

  // The gate-argument cross-check runs ahead of the early return, because it
  // is sound on a vacuous tree: every input it reads is a gate command's own
  // arguments or one of this check's constants, and not one of them comes from
  // a parsed document surface or from active-session discovery. A gate pointed
  // at another file is exactly as wrong on a tree whose extractions came back
  // empty — and behind the return it went undiagnosed there, since any one
  // empty surface hid it. The strict-flip watch stays behind the return for
  // the opposite reason: `failFree` over an empty active set is vacuously
  // true, so it would read a retired corpus as a flip trigger.
  //
  // A survey stating no watch at all hands this `undefined`, the way one
  // stating no table count hands the scalar guards theirs: the `?? []` lets the
  // emptiness guard below own that state and name the surface, rather than this
  // leg taking a type error on a state that already has words for it.
  problems.push(...gateArgumentProblems(s.strictWatch ?? [], s.sufficiencyBaselineArg));

  // The suite the cited job runs stands beside that cross-check, and for the
  // same reason: every input it reads is the workflow's own job graph, the root
  // manifest's scripts, or one of this check's constants — not one of them
  // comes from a parsed document surface — so it is sound on a tree whose
  // document extractions came back empty, and behind the early return any one
  // of those empty surfaces would have hidden it.
  problems.push(...jobSuiteProblems(s.registeredSuite, s.jobSuite));

  // The session catalogue's diff partner is one WATCHED platform's surface, minted
  // by `activeSessionsKey` from STRICT_WATCH_PLATFORMS and given its emptiness leg
  // from the same list — so a platform leaving the watch takes the surface and the
  // guard that would have spoken for it away in one edit, and the catalogue diff
  // would then read a surface that is gone as a catalogue that states nothing and
  // report every enumerated session as retired. This leg reads only this check's
  // own list, never a parsed document, so it is sound on a vacuous tree and runs
  // beside the gate-argument cross-check for the same reason.
  const desktopSessions = s[activeSessionsKey(DESKTOP_PLATFORM)];
  if (desktopSessions === undefined) {
    problems.push(`${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID}'s session catalogue has no surface to diff against — \`${DESKTOP_PLATFORM}\` is not in STRICT_WATCH_PLATFORMS in ${SELF_PATH}, and that list is where both the platform's active-session surface and its own emptiness guard come from, so the diff would read a surface that is gone as a catalogue that is empty; put the platform back on the watch, or move the clause's diff to a platform the watch covers`); // prettier-ignore
  }

  // The vacuous seed above the shared guard: a scanned document that cites no
  // job is already reported, and it stops the run for the same reason an empty
  // surface does, so the early return has to survive an all-non-empty pass.
  const vacuousCites = s.docCites.some((d) => d.cites.length === 0);
  const empty = emptySurfaceProblems(s, emptySurfaces);
  problems.push(...empty);
  if (empty.length > 0 || vacuousCites) return problems; // empty parses make the set diffs meaningless

  problems.push(...duplicateSurfaceProblems(s, DUPLICATE_SURFACES));

  const docFields = new Map(s.docKindFields);
  const codeFields = new Map(s.codeKindFields);
  problems.push(
    ...missingFrom(s.docKinds, s.codeKinds, `is a relaxation kind ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID} states but the comparator's RELAX_KINDS does not carry`), // prettier-ignore
    ...missingFrom(s.codeKinds, s.docKinds, `is a relaxation kind the comparator carries but ${CORPUS_DOC_PATH} §${RELAXATION_CLAUSE_ID} does not state`), // prettier-ignore
    ...missingFrom(s.docStatedKinds, s.codeKinds, `is a relaxation kind ${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}'s kind sentence states but the comparator's RELAX_KINDS does not carry`), // prettier-ignore
    ...missingFrom(s.codeKinds, s.docStatedKinds, `is a relaxation kind the comparator carries but ${CORPUS_DOC_PATH} §${RELAXATION_KINDS_CLAUSE_ID}'s kind sentence does not state`), // prettier-ignore
    ...missingFrom(s.codeKinds, [...codeFields.keys()], `is in the comparator's RELAX_KINDS but ${SELF_PATH} knows no field list for it — extend CODE_RELAXATION_FIELDS in the same change`), // prettier-ignore
    ...missingFrom([...codeFields.keys()], s.codeKinds, `has a field list in ${SELF_PATH} but is not a comparator relaxation kind`), // prettier-ignore
    // The watched-platform population, diffed both ways. The catalogue side
    // reds from a tree state: a platform the corpus grows that the watch has
    // not learned. The watch side states the same demand from the other end,
    // and no tree state prints it — a watched platform the catalogue carries no
    // session for has no active session for it either, so that platform's
    // derived vacuity leg in `EMPTY_SURFACES` names the manifest and returns
    // first. What holds that end is the unit suite: the case that hands this
    // diff the surface directly, and the case pinning the shipped catalogue and
    // the shipped watch to the same platforms.
    ...missingFrom(s.manifestPlatforms, s.watchedPlatforms, `has sessions in ${MANIFEST_PATH} but is a platform the ${STRICT_CLAUSE_ID} strict-flip watch has not learned — extend STRICT_WATCH_PLATFORMS in ${SELF_PATH} in the same change, so the platform's gate is watched from the moment its sessions land`), // prettier-ignore
    ...missingFrom(s.watchedPlatforms, s.manifestPlatforms, `is a platform the ${STRICT_CLAUSE_ID} strict-flip watch covers but ${MANIFEST_PATH} carries no session for`), // prettier-ignore
    ...missingFrom(s.docNormalizationTokens, s.codeNormalizationTokens, `is a field token ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID} normalizes but the comparator's class map does not carry`), // prettier-ignore
    ...missingFrom(s.codeNormalizationTokens, s.docNormalizationTokens, `is a field token the comparator's class map normalizes but ${CORPUS_DOC_PATH} §${NORMALIZATION_CLAUSE_ID}'s table does not state`), // prettier-ignore
    // The catalogue's diff legs run only while the strict-flip watch still mints
    // their partner surface; a platform the watch no longer covers is named as the
    // mover by the refusal ahead of the vacuity return, so these stay silent
    // instead of reading a gone surface as an empty catalogue.
    ...(desktopSessions === undefined
      ? []
      : [
          ...missingFrom(s.docSessionIds, desktopSessions, `is a session ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID} enumerates but ${MANIFEST_PATH} carries no active ${DESKTOP_PLATFORM} session for`), // prettier-ignore
          ...missingFrom(desktopSessions, s.docSessionIds, `is an active ${DESKTOP_PLATFORM} session in ${MANIFEST_PATH} but ${CORPUS_DOC_PATH} §${SESSION_CLAUSE_ID} does not enumerate it`), // prettier-ignore
        ]),
    ...missingFrom(s.docOutcomes, s.schemaOutcomes, `is an outcome ${CORPUS_DOC_PATH} §${OUTCOME_CLAUSE_ID} states every committed vector carries but ${VECTOR_SCHEMA_PATH} does not state under \`${OUTCOME_FIELD}\``), // prettier-ignore
    ...missingFrom(s.schemaOutcomes, s.docOutcomes, `is the outcome ${VECTOR_SCHEMA_PATH} states under \`${OUTCOME_FIELD}\` but ${CORPUS_DOC_PATH} §${OUTCOME_CLAUSE_ID} does not state`), // prettier-ignore
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

  if (!s.schemaRequiresOutcome) {
    problems.push(`${VECTOR_SCHEMA_PATH} does not require \`${OUTCOME_FIELD}\` of every vector while ${CORPUS_DOC_PATH} §${OUTCOME_CLAUSE_ID} states every committed vector states its outcome — the clause's demand and the meta-schema's are the same demand or one of them moved`); // prettier-ignore
  }

  // The heading's own claim, read rather than assumed: the per-predicate loop
  // below holds predicates to this check's class constant, and the heading is
  // diffed against that same constant here, so neither claim is asserted from
  // the other's side. A surface stating no class at all reads as one the scan
  // did not read — the count guard above owns that state — rather than
  // rendering `undefined` as the class the document supposedly states.
  if (s.docPerActionClass != null && s.docPerActionClass !== PER_ACTION_CLASS) {
    problems.push(`${LINT_DOC_PATH}'s per-action heading states its predicates are all \`${s.docPerActionClass}\` class while ${SELF_PATH} holds every one of them to \`${PER_ACTION_CLASS}\` — the heading and the class this check reads it as must name the same one`); // prettier-ignore
  }
  // The attributive clause below is the DOCUMENT's claim, so it is rendered
  // only where the heading was read stating that same class. Where the heading
  // states another class — or none this scan could read — the finding above is
  // the one carrying the doc-side claim, and this line states the code-side
  // fact alone rather than telling a reader the heading states a class it does
  // not.
  const statedOfAll =
    s.docPerActionClass === PER_ACTION_CLASS
      ? `, which ${LINT_DOC_PATH}'s per-action heading states of all of them`
      : '';
  for (const id of s.codeNonFailPerAction) {
    problems.push(`the lint's per-action predicate \`${id}\` is not \`${PER_ACTION_CLASS}\` class${statedOfAll}`); // prettier-ignore
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
  // A command that passes no value at all and a surface that states none read
  // the same way here — both are the absence this leg has words for, and
  // neither renders as a backticked `undefined`.
  const named = (value) => (value == null ? 'nothing' : `\`${value}\``);
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
 *
 * A verdict about a trigger that has not come true names what is holding it
 * shut — the baseline keys still carrying a diff, the corpus truths still
 * carrying a `fail` finding — capped at {@link NAMED_CAUSE_CAP} with a count
 * of the rest, so the line stays one line as the corpus grows. Each population
 * names keys, never the entries under them: a name a reader can open. An entry
 * that states no population names none, and the verdict stands without it.
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
    // What is holding each trigger shut, named: a reader of the verdict would
    // otherwise go looking for it by hand in a file of per-session lists, and
    // the population these come from is a corpus that grows.
    const carrying = `${w.baselinePath} still carries a known diff${namedCauses(w.knownDiffsCarrying ?? [])}`; // prettier-ignore
    const failing = `${SUFFICIENCY_BASELINE_PATH} still carries a \`fail\`-class entry on an active ${w.platform} corpus truth${namedCauses(w.failKeys ?? [])}`; // prettier-ignore
    if (!w.knownDiffsEmpty && w.strict) {
      problems.push(`${gate} passes \`${STRICT_FLAG}\` while ${carrying} — ${cite} wires that flag only once the baseline empties`); // prettier-ignore
    }
    const unmet = [...(w.knownDiffsEmpty ? [] : [carrying]), ...(w.failFree ? [] : [failing])];
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
  const outcome = extractStatedOutcome(corpusDoc);
  const vector = readVectorOutcome(readFile, VECTOR_SCHEMA_PATH);
  const predicates = extractPredicateTables(lintDoc);
  const perActionClass = extractPerActionClass(lintDoc);
  // One read of the workflow for both readings of it: the raw-text job-id scan
  // the citation leg diffs against, and the structural parse the job-suite leg
  // takes the named job's own step commands from.
  const workflowText = readFile(TEST_WORKFLOW_PATH);
  const jobs = extractJobIds(workflowText);
  // The anchor condition alone, asked of the extractor that reports it rather
  // than answered by "any problem it reported": a workflow the job scan cannot
  // anchor in is a file this check could not use — the machinery verdict every
  // other unusable input already takes — while a problem that extractor grows
  // later keeps the route it has today until this check has learned what it
  // means.
  const anchorProblem = jobs.problems.find(isJobAnchorProblem);
  if (anchorProblem !== undefined) throw new InputError(anchorProblem);

  // The structural half of the same read: the `jobs` map, through the reader
  // the workflow-bounds check exports for it, handed the text this run already
  // read rather than opening the file a second time. Its refusals are that
  // reader's own words, re-raised as this check's machinery verdict — the
  // route the job-id anchor condition already takes, one file over.
  let jobsMap;
  try {
    jobsMap = readJobs(() => workflowText, TEST_WORKFLOW_PATH);
  } catch (error) {
    if (!(error instanceof WorkflowJobsError)) throw error;
    throw new InputError(error.message);
  }

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
  // The root manifest's script commands, read after the gate commands above so
  // an unparseable manifest takes that reader's machinery verdict, which names
  // the manifest and which way it failed.
  const lintSurface = extractLintSurface(readFile(PACKAGE_JSON_PATH));
  const registeredSuite = registeredNodeSuite(UNIT_SUITE_DIR);
  const jobSuite = jobSuiteArguments(jobsMap, lintSurface.commands, UNIT_SUITE_JOB_ID);
  const strictWatch = STRICT_WATCH_PLATFORMS.map((w) => {
    const active = activeByPlatform.get(w.platform);
    const command = gateCommands.get(w.script);
    const knownDiffs = readKnownDiffsBaseline(readFile, w.baselinePath, active);
    const failKeys = corpusFailKeys(sufficiency, active);
    return {
      platform: w.platform,
      script: w.script,
      baselinePath: w.baselinePath,
      knownDiffsEmpty: knownDiffs.empty,
      knownDiffsCarrying: knownDiffs.carrying,
      failFree: failKeys.length === 0,
      failKeys,
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
    docOutcomeFields: outcome.fields,
    docOutcomes: outcome.outcomes,
    schemaOutcomes: [vector.outcome],
    schemaRequiresOutcome: vector.required,
    // One active-session surface per watched platform, from the same derived
    // keys the vacuity legs read, so neither can be added without the other.
    //
    // Only the desktop key is a diff partner (§STC-22's session catalogue).
    // Every other watched platform's key is read by one thing, the vacuity
    // leg — and that leg is load-bearing rather than ceremonial: `failFree`
    // over an empty active set is vacuously true, so a platform whose sessions
    // were all retired would otherwise have its `--lint-strict` demanded on a
    // corpus the comparator lints nothing from.
    ...Object.fromEntries(
      STRICT_WATCH_PLATFORMS.map((w) => [
        activeSessionsKey(w.platform),
        activeByPlatform.get(w.platform),
      ]),
    ),
    docPerAction: predicates.perAction,
    perActionTableMatches: predicates.perActionMatches,
    docPerActionClass: perActionClass.klass,
    perActionHeadingMatches: perActionClass.matches,
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
      ...outcome.unreadableTokens,
      ...perActionClass.unreadableTokens,
    ],
    // The scanned set is the declared list, read through the same injected
    // reader: the leg's population comes from that list alone, rather than
    // from a second table of the documents this check happens to have read
    // for other legs — which would be one more place to keep in step with it.
    // The re-read is the price of that, and it is one file read per document.
    docCites: documentCitations(CITED_JOB_DOCUMENTS, readFile),
    strictWatch,
    manifestPlatforms: readManifestPlatforms(readFile, MANIFEST_PATH),
    watchedPlatforms: STRICT_WATCH_PLATFORMS.map((w) => w.platform),
    sufficiencyBaselineArg: argumentValue(gateCommands.get(SUFFICIENCY_SCRIPT), BASELINE_ARG),
    workflowJobIds: jobs.ids,
    registeredSuite,
    jobSuite,
  };
  return {
    problems: [...jobs.problems, ...evaluateVerificationInventory(s)],
    pinCount:
      s.docKinds.length +
      s.docStatedKinds.length +
      s.docNormalizationTokens.length +
      s.docSessionIds.length +
      s.docOutcomeFields.length +
      s.docOutcomes.length +
      s.docPerAction.length +
      // The class the heading states is one documented entry when it was read;
      // a heading the scan refused states none it could hold.
      (s.docPerActionClass === null ? 0 : 1) +
      s.docRecording.length +
      s.strictWatch.length +
      s.docCites.reduce((n, d) => n + new Set(d.cites).size, 0) +
      // The job-suite leg holds one entry: the registered glob the named job's
      // own commands must resolve to. A registration this check's directory
      // constant no longer matches holds none, and says so.
      (s.registeredSuite === undefined ? 0 : 1),
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
 * One platform's known-diffs baseline, reduced to the facts the watch needs:
 * whether it still carries a diff, and which sessions are carrying one — so a
 * verdict about a trigger that has not come true can name what is holding it
 * shut instead of leaving the reader to find it in the file.
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
 * @returns {{ empty: boolean, carrying: string[] }} whether the baseline is
 *   empty, and the session keys whose entry lists are not
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
  const carrying = entries.filter(([, list]) => list.length > 0).map(([id]) => id);
  return { empty: carrying.length === 0, carrying };
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
 * The session catalogue, read through the injected reader and validated to the
 * depth this check reads it. The catalogue's shape is stated HERE and only
 * here: both surfaces below — the platform population and the active-session
 * lister — come through this one reader, so a catalogue that is not a
 * catalogue fails as itself in the same words whichever of the two reaches it
 * first, and a guard cannot be deepened on one of them alone.
 *
 * A broken manifest is not an empty catalogue — diagnosing it as one would
 * send the reader to §STC-22's clause, which is not the file at fault — so
 * each way the file can fail gets its own words: unreadable, unparseable, or
 * parseable but not shaped like a session catalogue. The shape check runs to
 * the depth the comparator's session walk relies on: string `id` and
 * `platform` always, and — mirroring exactly the values that walk would
 * path-join — `truth` whenever it is non-nullish and `overrides` whenever it
 * is truthy. A present-but-nullish `truth` or a falsy `overrides` is
 * deliberately not flagged: the walk substitutes its default or skips the
 * join, so nothing reaches `join` to fail on.
 *
 * The guards run over every entry, not only one platform's, and that is
 * deliberate: an entry of another platform with a mistyped key is joined by
 * that platform's own comparator runs, so a malformed catalogue is refused
 * wholesale. Whatever route a malformation would otherwise take — a raw type
 * error out of a path-joined field on a discovered entry, or a silently
 * dropped entry when `platform` is non-string, leaving the catalogue no longer
 * reflecting the manifest — the shape verdict takes it first, because a
 * malformed catalogue must fail as itself and never as a drift verdict — a
 * pin that no longer holds.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path the catalogue's repo-relative path
 * @returns {{ sessions: object[] }} the parsed, shape-checked catalogue
 * @throws {InputError} naming the catalogue and which way it failed
 */
export function readSessionCatalogue(readFile, path) {
  const shapeProblem = (what) => shapeError(path, 'the session catalogue', what);
  const parsed = parseJsonInput(readFile, path);
  if (!Array.isArray(parsed?.sessions)) {
    throw shapeProblem('carries no `sessions` array');
  }
  parsed.sessions.forEach((session, i) => {
    for (const field of ['id', 'platform']) {
      if (typeof session?.[field] !== 'string') {
        throw shapeProblem(`its \`sessions[${i}]\` entry carries no string \`${field}\``);
      }
    }
    // The optional keys the session walk path-joins, each guarded exactly as
    // that walk consumes it: `truth` falls back when nullish, `overrides` is
    // skipped when falsy — so only the values it would really join are checked.
    if (session.truth != null && typeof session.truth !== 'string') {
      throw shapeProblem(`its \`sessions[${i}]\` entry carries a non-string \`truth\``);
    }
    if (session.overrides && typeof session.overrides !== 'string') {
      throw shapeProblem(`its \`sessions[${i}]\` entry carries a non-string \`overrides\``);
    }
  });
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
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path the catalogue's repo-relative path
 * @returns {string[]}
 * @throws {InputError} naming the catalogue and which way it failed
 */
export function readManifestPlatforms(readFile, path) {
  const platforms = [];
  for (const session of readSessionCatalogue(readFile, path).sessions) {
    if (!platforms.includes(session.platform)) platforms.push(session.platform);
  }
  return platforms;
}

/**
 * The baseline keys that carry a fail-class entry against one platform's ACTIVE
 * corpus truths — the truth files holding the `--lint-strict` trigger shut, so
 * a verdict can name them and a reader knows which files to open. The keys are
 * what a diagnosis names, not the entries under them: one truth file carrying
 * several fail findings names once, and a line that named whole findings would
 * run past the width a reader takes in at a glance. A retired session keeps its
 * truth on disk and — because SL-5's standing corpus is a directory walk of
 * `corpus/sessions` — its baseline entry with it; those keys are deliberately
 * outside this population, since the comparator's `--lint-strict` never lints
 * them.
 * @param {Record<string, string[]>} baseline a validated sufficiency baseline
 * @param {string[]} activeIds the platform's active session ids
 * @returns {string[]} each such key once, in file order
 */
export function corpusFailKeys(baseline, activeIds) {
  const active = new Set(activeIds);
  const found = [];
  for (const [key, list] of Object.entries(baseline)) {
    const match = CORPUS_TRUTH_KEY_RE.exec(key);
    if (!match || !active.has(match[1])) continue;
    if (list.some((finding) => finding.startsWith(FAIL_ENTRY_PREFIX))) found.push(key);
  }
  return found;
}

/**
 * The outcome the vector meta-schema states every committed vector carries,
 * and whether it requires the field that outcome sits under. Both are read
 * under this check's own field constant, never under a name taken from the
 * document: a clause that renamed the field has to red as the drift it is,
 * naming both surfaces, instead of sending the reader to a meta-schema that
 * never moved.
 *
 * Validated to the depth it reads, like the sibling readers above — a
 * meta-schema that states no outcome under that property is a machinery
 * verdict naming the file, never an outcome the clause can be found to
 * disagree with.
 *
 * The outcome is held to {@link OUTCOME_TOKEN_RE} — the grammar the clause
 * side is read by — exactly as the meta-schema writes it, never trimmed
 * first. Padding is a disagreement rather than a formatting artifact: the
 * const as written is what every committed vector is validated against, so a
 * padded one has to surface here as this file's shape failing instead of
 * reading as the token it resembles. The verdict it takes is the one the
 * blank const already takes, and the outcome set diff in
 * {@link evaluateVerificationInventory} stays a diff between two tokens the
 * grammar admits.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} path the meta-schema's repo-relative path
 * @returns {{ outcome: string, required: boolean }} the outcome as one
 *   token-shaped word, and whether the meta-schema requires its field
 * @throws {InputError} naming the meta-schema and which way it failed
 */
export function readVectorOutcome(readFile, path) {
  const subject = 'the vector meta-schema';
  const parsed = parseJsonInput(readFile, path);
  if (!isRecord(parsed) || !isRecord(parsed.properties)) {
    throw shapeError(path, subject, 'carries no `properties` object');
  }
  const property = parsed.properties[OUTCOME_FIELD];
  if (!isRecord(property)) {
    throw shapeError(path, subject, `carries no \`properties.${OUTCOME_FIELD}\` object`);
  }
  const outcome = typeof property.const === 'string' ? property.const : '';
  if (!OUTCOME_TOKEN_RE.test(outcome)) {
    throw shapeError(
      path,
      subject,
      `its \`${OUTCOME_FIELD}\` property states no \`const\` outcome this check can read — the const is held to the token grammar §${OUTCOME_CLAUSE_ID}'s own side is read by: ${OUTCOME_TOKEN_EXPECTATION}`,
    );
  }
  return {
    outcome,
    required: Array.isArray(parsed.required) && parsed.required.includes(OUTCOME_FIELD),
  };
}

/**
 * The gate commands the root manifest defines, read as a small local view of
 * its `scripts` map. A named script that is missing or is not a command string
 * is a machinery verdict: the watch cannot say whether a gate carries its flag
 * when it cannot find the gate.
 *
 * Each command comes back trimmed: the blank test below already trims, so
 * returning the untrimmed string would test one form of the command and hand
 * back another. Every consumer tokenizes on whitespace, so the trim moves no
 * verdict — which is what parts this from the outcome reader above, where the
 * padding a trim would drop is a disagreement the grammar has to refuse.
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
    commands.set(key, command.trim());
  }
  return commands;
}

/**
 * One platform's active session ids from the session catalogue, read through
 * the same injected reader every sibling surface takes — so the lister is one
 * more reader of the tree rather than a second, hidden route to disk, and a
 * caller (the suite included) that hands this check a tree hands it the whole
 * tree.
 *
 * The catalogue's shape verdict is {@link readSessionCatalogue}'s, stated
 * once; the walk over the validated document is the comparator's own
 * `sessionsIn`, so session discovery stays that one implementation rather than
 * being reimplemented here. Nothing wraps the walk — on a catalogue the reader
 * has already found well-formed, a break in ITS contract is a code defect that
 * must surface as itself, never be relabelled a bad input file.
 *
 * The platform is a parameter rather than a bound constant so this stays the
 * one guarded entry point for every platform the check discovers sessions for.
 * @param {(path: string) => string} readFile repo-relative content reader
 * @param {string} platform the manifest platform whose sessions to list
 * @param {string} [manifestPath] repo-relative path to the session catalogue
 * @returns {string[]}
 * @throws {InputError} naming the manifest and which way it failed
 */
export function listActiveSessions(readFile, platform, manifestPath = MANIFEST_PATH) {
  return sessionsIn(readSessionCatalogue(readFile, manifestPath), manifestPath, platform)
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
    audit = auditTree(readTreeFile, (platform) => listActiveSessions(readTreeFile, platform));
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(
      `✗ an input this check reads could not be used:\n` +
        `    ${error.message}\n\n` +
        `  This is machinery breakage, not a pin that stopped holding — fix the file named\n` +
        `  above. Exit 2 keeps it distinct from the drift verdict (exit 1).\n`,
    );
    process.exit(2);
  }
  const { problems, pinCount } = audit;

  if (problems.length) {
    console.error(
      `✗ a verification pin no longer holds:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  A finding naming two surfaces — a document, a code constant, the manifest, the\n` +
        `  vector meta-schema, the workflow, or a gate command's own arguments — is telling you\n` +
        `  the two no longer state the same thing: update both sides in the same change, and\n` +
        `  read the finding for which side moved. A finding that a diff has no surface to diff\n` +
        `  against names a document and one of this check's own lists, but not two statements\n` +
        `  that disagree: that list is where the missing side was minted, so the remedy is the\n` +
        `  list alone — put the subject back on it, or move the diff to a subject the list\n` +
        `  still carries. A gate-flag finding — a gate command's own flag against the trigger\n` +
        `  that wires it — names no second statement, so its remedy is the gate itself: flip\n` +
        `  the command's flag, or regenerate the baseline whose state it disagrees with. A\n` +
        `  finding that a statement could not be read as one — a list item, a cell, a token, a\n` +
        `  heading, or a table the header tuple no longer selects exactly once — names no\n` +
        `  second statement either: the inventory is no longer where this check reads it, so\n` +
        `  put the statement back in the form the reader takes, or move the reader to where it\n` +
        `  now stands.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ verification inventories current: ${pinCount} held entr(ies) — the documented inventory ` +
      `entries plus the watched platforms — across the ${legList()} legs match their subjects.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
