/**
 * check-docs-disposition.js — format check for the two structured PR-body
 * sections, `## Docs disposition` and `## Change record`.
 *
 * Every change is governed by docs (scripts/area-map.json maps code to them),
 * and the PR body must carry one explicit line per governing doc saying what
 * happened to it — one of the two per-doc forms UPDATED_LINE_TEMPLATE and
 * UNAFFECTED_LINE_TEMPLATE spell out below. When a governing doc states its
 * rules as registered clauses (docs/clause-registry.json), each clause tagged
 * judgment-only additionally takes its own line, anchored by the clause id, in
 * the form CLAUSE_LINE_TEMPLATE spells out beside them.
 *
 * (Clauses guarded by named checks need no per-clause line — the checks
 * themselves guard those.) The `## Change record` section must be present and
 * carry its structural markers (`Intent:`, `Outside knowledge:`, `mutation:`)
 * each at the start of a line. HTML comments are stripped before any parsing,
 * so the PR template's guidance comments neither satisfy nor break the check.
 *
 * This checks FORM ONLY — that every expected line exists, anchors a doc or
 * clause actually in scope, and picks exactly one of updated/unaffected. It
 * never judges whether a reason is adequate; that stays with review.
 *
 * Declared classes (not author-based), each with its admission test and the
 * inputs that decide it:
 *
 *   dependency-only — decided from the diff alone. Every changed file is a
 *   lockfile; a package.json whose two sides, parsed, differ only in
 *   dependency-resolution fields (dependencies, devDependencies,
 *   peerDependencies, optionalDependencies, overrides — compared structurally,
 *   so nested overrides entries qualify and formatting-only differences count
 *   as no change); a Cargo.toml whose changed lines all sit inside the
 *   dependency sections Cargo defines for them, the per-crate table form
 *   included; or a workflow file whose change only moves action pins (same
 *   action, new SHA). Such a PR carries neither section.
 *
 *   release-automation — decided from the diff together with the head branch
 *   this run is entitled to act on, which check-no-release-outputs.js derives
 *   from the forwarded head branch and head repository (effectiveHeadRef):
 *   under a GitHub Actions run that names a branch only for a pull request
 *   opened on this repository, and with no Actions context it is the head ref
 *   as supplied.
 *   That head ref is the branch the release pipeline opens for its own
 *   regeneration PR, and every changed file is part of the release-output
 *   surface — whose one home is the enumeration in check-no-release-outputs.js,
 *   imported here rather than restated. Such a PR carries neither section; its
 *   record is the release itself plus the body the pipeline generates.
 *
 *   governance-data-only — decided from the diff alone: every changed file is
 *   the area map or the clause registry, and the map is among them. Such a PR
 *   carries `## Change record` as usual, and a `## Docs disposition` section of
 *   exactly one line, in place of the per-doc lines — the line
 *   GOVERNANCE_LINE_TEMPLATE spells out below, recording the judgment
 *   CONTRIBUTING ("Extending the Docs Governance") asks for. The same line on
 *   any other diff is unearned, and red.
 *
 * A change admitted by neither exempt class — an npm script edit, an engines
 * bump, an action identity swap, a file the release pipeline does not write —
 * carries both sections in full; a governance-data-only change carries them
 * too, with the marker line standing in for the per-doc lines.
 *
 * Red output enumerates the exact lines expected, so the check teaches its
 * own fix — except where the area map no longer fits the shape this check
 * reads it through, which prints that shape refusal instead, there being no
 * scope to derive the lines from.
 *
 * Inputs: PR_BODY via env (from the event payload, never interpolated into a
 * shell), the event's head branch and head repository via env (PR_HEAD_REF /
 * PR_HEAD_REPO, forwarded as they arrive and never read raw — effectiveHeadRef
 * reads them against the run context to decide which branch this run may act
 * on, and takes PR_HEAD_REF as supplied where there is no Actions context), the
 * base ref as argv[2] (default origin/main).
 *
 * Usage:
 *   PR_BODY="..." [PR_HEAD_REF="<branch>"] node scripts/check-docs-disposition.js [baseRef]
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  compileMap,
  resolveFile,
  globToRegExp,
  loadMap,
  MAP_PATH,
  refuseOnShapeError,
} from './check-area-map.js';
import {
  REGISTRY_PATH,
  loadRegistry,
  readTextOrNull,
  refuseOnRegistryError,
} from './governance-data.js';
import {
  AUTOMATED_BRANCH,
  effectiveHeadRef,
  isAllowedReleaseOutput,
} from './check-no-release-outputs.js';
import { escapeForRegExp, extractHeadingSection } from './check-test-inventory.js';

/**
 * Repo-relative path of the clause registry — the shared governance-data
 * constant, re-exported rather than restated, so the path this check reads is
 * the path every check that reads that file names.
 */
export { REGISTRY_PATH };

/** Section headings required in every non-exempt PR body. */
export const DISPOSITION_HEADING = '## Docs disposition';
export const CHANGE_RECORD_HEADING = '## Change record';

/** Structural markers the change record must carry, each at a line start. */
export const CHANGE_RECORD_MARKERS = ['Intent:', 'Outside knowledge:', 'mutation:'];

/**
 * The cadence word the standing mutation sentence reports. The fact itself is
 * the schedule in .github/workflows/mutation.yml, and the cadence's
 * authoritative statement is mutation testing §MUT-1 — this constant is only
 * the word the sentence below has to spell, held to both by the unit suite.
 */
export const MUTATION_CADENCE = 'weekly';

/**
 * The fixed mutation line a contributor pastes into the change record, spelled
 * once. One home for a sentence that is otherwise typed out wherever a
 * contributor meets it: this check's own red output offers it as the fix, and
 * the unit suite holds the copies in CONTRIBUTING and the PR template against
 * it.
 */
export const MUTATION_LINE = `mutation: no per-change claim; mutation testing runs as a standing ${MUTATION_CADENCE} job.`;

/** Lockfiles — machine-generated, path-exempt. */
const LOCKFILE_GLOBS = ['**/package-lock.json', '**/Cargo.lock'];

/** Dependency manifests — exempt only when the changed lines stay inside dependency blocks. */
const MANIFEST_GLOBS = ['**/package.json', '**/Cargo.toml'];

const lockfileRes = LOCKFILE_GLOBS.map(globToRegExp);
const manifestRes = MANIFEST_GLOBS.map(globToRegExp);

/** A workflow line that carries an action pin: `uses: <action>@<40-hex sha>`. */
const PIN_LINE_RE = /^\s*(?:-\s*)?uses:\s*(\S+)@[0-9a-f]{40}(?:\s*#.*)?$/;

/**
 * The package.json fields that hold dependency-resolution data — the fields a
 * dependency-only change may touch, at any nesting depth. Every other field
 * (scripts, engines, packageManager, version, …) is a real change: engines and
 * packageManager state the project's toolchain contract, which governed docs
 * restate, while these five are read only by the package manager's resolver.
 */
export const PACKAGE_JSON_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
];

/**
 * Cargo.toml sections whose entries a dependency bump may touch: the
 * `dependencies`, `dev-dependencies`, and `build-dependencies` tables, their
 * `target.<cfg>.` and `workspace.` scopes, and the
 * per-crate table form (`[dependencies.serde]`). Anchored on those scopes so
 * the open third-party namespaces that merely end in a dependency-shaped name
 * (`[package.metadata.dependencies]`, `[lints.dependencies]`) stay outside —
 * they hold arbitrary tool data, not dependency data.
 */
const CARGO_DEP_SECTION =
  /^\s*\[(target\.[^\]]+\.|workspace\.)?(dependencies|dev-dependencies|build-dependencies)(\.[^\]]+)?\]/;

/**
 * Context lines for the exemption diffs — effectively the whole file (git
 * clamps to file length). The package.json exemption reconstructs both full
 * sides from the diff text and parses them, and the Cargo.toml exemption
 * tracks the enclosing dependency section through the context lines — both
 * need the whole file visible; git's default 3-line context yields fragments
 * and misjudges a pure dependency bump.
 */
const MANIFEST_DIFF_CONTEXT = 1_000_000;

/**
 * The changed (+/-) line contents of a unified diff, sign stripped. Excludes
 * exactly the `+++`/`---` file headers, so content beginning with `+` or `-`
 * at column 0 still counts as a changed line.
 * @param {string} diffText unified diff for one file
 * @returns {string[]}
 */
export function changedLines(diffText) {
  return diffText
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^\+\+\+ /.test(l) && !/^--- /.test(l))
    .map((l) => l.slice(1));
}

/**
 * Pure core: does a workflow file's diff only move action pins? Every changed
 * line must be a pin line, and the set of action identities (the part before
 * `@`) must be unchanged — a bump moves the SHA, never which action runs.
 * @param {string} diffText unified diff for one workflow file
 * @returns {boolean}
 */
export function isPinOnlyWorkflowDiff(diffText) {
  const removed = [];
  const added = [];
  for (const raw of diffText.split('\n')) {
    if (/^\+\+\+ /.test(raw) || /^--- /.test(raw)) continue;
    if (raw.startsWith('+')) added.push(raw.slice(1));
    else if (raw.startsWith('-')) removed.push(raw.slice(1));
  }
  if (added.length === 0 && removed.length === 0) return false;
  const identities = (lines) => {
    const ids = [];
    for (const l of lines) {
      const m = l.match(PIN_LINE_RE);
      if (!m) return null;
      ids.push(m[1]);
    }
    return ids.sort();
  };
  const a = identities(added);
  const r = identities(removed);
  if (a === null || r === null) return false;
  return a.length === r.length && a.every((id, i) => id === r[i]);
}

/**
 * Both sides of a single-file unified diff, reconstructed from its text.
 * Complete only when the diff carries full-file context (the caller diffs
 * with `-U${MANIFEST_DIFF_CONTEXT}`); with partial context the sides are
 * fragments, which the JSON-parsing caller rejects — fail closed.
 * @param {string} diffText unified diff for one file
 * @returns {{ before: string, after: string }}
 */
function diffSides(diffText) {
  const before = [];
  const after = [];
  let inHunk = false;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue; // headers / "\ No newline …"
    if (raw.startsWith('+')) after.push(raw.slice(1));
    else if (raw.startsWith('-')) before.push(raw.slice(1));
    else {
      const line = raw.startsWith(' ') ? raw.slice(1) : raw;
      before.push(line);
      after.push(line);
    }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/**
 * Pure core: does a package.json diff change only dependency-resolution data?
 * Both sides are reconstructed from the diff (which MUST carry full-file
 * context — the caller diffs with `-U${MANIFEST_DIFF_CONTEXT}`) and parsed as
 * JSON; the diff qualifies when every top-level field whose parsed value
 * differs (per node:util isDeepStrictEqual) is one of
 * PACKAGE_JSON_DEPENDENCY_FIELDS — so a nested overrides entry qualifies
 * while an npm-script or engines edit never does, and formatting-only
 * differences (indentation, key order) parse equal and count as no change.
 * A side that does not parse as a JSON object (a fragment from a
 * partial-context diff, invalid JSON, a byte-order mark, a file created or
 * deleted) fails closed as non-exempt. Duplicate keys resolve last-wins,
 * exactly as the package manager's own JSON.parse-equivalent read does.
 * @param {string} diffText unified diff for one package.json
 * @returns {boolean}
 */
export function isDependencyOnlyPackageJsonDiff(diffText) {
  const { before, after } = diffSides(diffText);
  let a;
  let b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return false;
  }
  const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  // Own-property reads: a plain a[f] would resolve a "__proto__" member absent
  // on one side through the prototype chain (Object.prototype deep-equals {}),
  // misreading its addition or removal as no change.
  const own = (o, f) => (Object.hasOwn(o, f) ? o[f] : undefined);
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...fields].every(
    (f) => isDeepStrictEqual(own(a, f), own(b, f)) || PACKAGE_JSON_DEPENDENCY_FIELDS.includes(f),
  );
}

/**
 * Pure core: does a Cargo.toml diff change only dependency-section entries?
 * Like the package.json check, this needs full-file context (the caller diffs
 * with `-U${MANIFEST_DIFF_CONTEXT}`) so the `[dependencies]`-style section header
 * is visible; a hunk that omits it yields a false negative.
 * @param {string} diffText unified diff for one Cargo.toml
 * @returns {boolean}
 */
export function isDependencyOnlyCargoTomlDiff(diffText) {
  let sawChange = false;
  let inDepSection = false;
  for (const raw of diffText.split('\n')) {
    if (/^(\+\+\+ |--- |@@ |diff |index )/.test(raw)) {
      inDepSection = false;
      continue;
    }
    const changed = /^[+-]/.test(raw);
    const line = changed ? raw.slice(1) : raw.startsWith(' ') ? raw.slice(1) : raw;
    if (/^\s*\[/.test(line)) inDepSection = CARGO_DEP_SECTION.test(line);
    if (changed) {
      sawChange = true;
      if (!inDepSection && !CARGO_DEP_SECTION.test(line)) return false;
    }
  }
  return sawChange;
}

/** The exempt classes, by the name each one reports on the green path. */
export const DEPENDENCY_ONLY_CLASS = 'dependency-only';
export const RELEASE_AUTOMATION_CLASS = 'release-automation';

/**
 * Pure core: does this diff move only dependency data? True when every changed
 * file is a lockfile, a dependency-only manifest change, or a pin-only workflow
 * change. Decided from the diff alone.
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @param {(f: string) => string} opts.fileDiff unified diff text for one file
 * @returns {boolean}
 */
export function isDependencyOnlyDiff({ files, fileDiff }) {
  if (files.length === 0) return false;
  return files.every((f) => {
    if (lockfileRes.some((re) => re.test(f))) return true;
    if (manifestRes.some((re) => re.test(f))) {
      return f.endsWith('Cargo.toml')
        ? isDependencyOnlyCargoTomlDiff(fileDiff(f))
        : isDependencyOnlyPackageJsonDiff(fileDiff(f));
    }
    // The workflow-file boundary. Its one home is `WORKFLOW_FILE_RE` in
    // check-doc-closure.js; this literal is a deliberate second copy rather
    // than an import, because importing it would ADD that check's own closure —
    // a YAML parser, and check-ci-filter.js, which brings the same parser — to
    // the command line that runs on every pull request, against the
    // lean-closure principle scripts/governance-data.js states: a command
    // line's import closure must not inherit parsers or heavy modules it does
    // not use. The parser is what that principle declines here; the shared
    // tracked-file reader that closure also names is already inherited through
    // check-area-map.js and is builtins-only, so it costs nothing either way.
    // The copy is WELDED instead: a unit
    // case in check-docs-disposition.test.js reads this file's source text and
    // asserts the literal below equals `WORKFLOW_FILE_RE.source`, so the two
    // cannot drift even though neither runs the other's code.
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) return isPinOnlyWorkflowDiff(fileDiff(f));
    return false;
  });
}

/**
 * Pure core: is this the release pipeline's own regeneration PR? True when the
 * head ref is the pipeline's automation branch AND every changed file is part
 * of the release-output surface. The surface's one home is
 * check-no-release-outputs.js, which this consults rather than restates; so is
 * the rule deriving the head ref its caller passes, which under a GitHub
 * Actions run names a branch only for a pull request opened on this repository
 * and passes the supplied ref through with no Actions context.
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @param {string} opts.headRef the head branch this run may act on (empty when none does)
 * @returns {boolean}
 */
export function isReleaseAutomationDiff({ files, headRef }) {
  if (files.length === 0 || headRef !== AUTOMATED_BRANCH) return false;
  return files.every((f) => isAllowedReleaseOutput(f));
}

/**
 * Pure core: which admitted class exempts this diff from carrying the
 * sections, or null when none does.
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @param {(f: string) => string} opts.fileDiff unified diff text for one file
 * @param {string} [opts.headRef] the head branch this run may act on (empty when none does)
 * @returns {string | null} the admitting class name
 */
export function exemptionClass({ files, fileDiff, headRef = '' }) {
  if (isReleaseAutomationDiff({ files, headRef })) return RELEASE_AUTOMATION_CLASS;
  if (isDependencyOnlyDiff({ files, fileDiff })) return DEPENDENCY_ONLY_CLASS;
  return null;
}

/**
 * Pure core: is this diff exempt from carrying the sections?
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @param {(f: string) => string} opts.fileDiff unified diff text for one file
 * @param {string} [opts.headRef] the head branch this run may act on (empty when none does)
 * @returns {boolean}
 */
export function isExemptDiff({ files, fileDiff, headRef = '' }) {
  return exemptionClass({ files, fileDiff, headRef }) !== null;
}

/**
 * Pure core: does this diff change only the governance data — every changed
 * file the area map or the clause registry, with the map among them? Such a
 * diff records one governance-data-only line in place of the per-doc lines.
 * A registry-only diff is outside the class: its per-doc wall is empty (the
 * map declares it governed by no doc), so there is nothing for the line to
 * replace.
 * @param {string[]} files changed file paths
 * @returns {boolean}
 */
export function isGovernanceDataDiff(files) {
  if (files.length === 0) return false;
  return files.includes(MAP_PATH) && files.every((f) => f === MAP_PATH || f === REGISTRY_PATH);
}

/**
 * Pure core: the docs in disposition scope for a set of changed files.
 * Scope = the union of the resolved areas' doc sets, plus any repo-wide doc
 * that is itself edited (repo-wide docs inside an area's doc set already enter
 * via that area).
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @param {any} opts.map parsed area-map.json
 * @param {(f: string) => (string | null)} opts.readFile content reader for
 *   pointer scanning (null when unreadable/absent)
 * @returns {string[]} sorted in-scope doc paths
 */
export function docsInScope({ files, map, readFile }) {
  const compiled = compileMap(map);
  const docs = new Set();
  for (const f of files) {
    const r = resolveFile(f, compiled, readFile(f));
    for (const d of r.docs) docs.add(d);
    if (r.repoWide && !compiled.docSets.has(f)) docs.add(f);
  }
  return [...docs].sort();
}

/**
 * Pure core: the exact disposition lines a PR must carry.
 * @param {object} opts
 * @param {string[]} opts.docs in-scope doc paths
 * @param {any} opts.registry parsed clause-registry.json
 * @returns {{ doc: string, clause: string | null }[]} one entry per expected line
 */
export function expectedDispositionLines({ docs, registry }) {
  const expected = [];
  for (const doc of docs) {
    expected.push({ doc, clause: null });
    for (const row of registry.clauses ?? []) {
      if (row.doc === doc && row.tag === 'judgment-only') {
        expected.push({ doc, clause: row.clause });
      }
    }
  }
  return expected;
}

/**
 * Remove HTML comments (`<!-- … -->`, including multi-line and unterminated
 * ones) so template guidance can neither satisfy nor break the check.
 * @param {string} text
 * @returns {string}
 */
export function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/** One disposition line: verb, doc, optional §clause, a dash, free text. */
const LINE_RE = /^(updated|unaffected):\s+(\S+?)(?:\s+§(\S+))?\s+—\s+(.+)$/;

/** Markdown prefixes tolerated in front of a disposition line. */
const PREFIX_RE = /^(?:>\s*)?(?:[-*+]\s+|\d+\.\s+)?/;

/** The doc placeholder the contributor-facing examples of the grammar stand on. */
export const DOC_PLACEHOLDER = 'docs/<path>';

/**
 * The anchor the clause-anchored example stands on — a real registered clause,
 * so the line a contributor copies is one the check would actually expect for
 * that doc. One example, so the surfaces cannot teach two.
 */
export const CLAUSE_EXAMPLE_ANCHOR = 'docs/architecture/system/capture-principles.md §CP-3';

/**
 * The per-doc grammar forms, each rendered for the anchor it names — a
 * doc path, a `doc §clause` pair, or a placeholder standing for either. One
 * home for a grammar that is otherwise typed out wherever a contributor meets
 * it: this check's own red output builds its lines from here, and the unit
 * suite holds the copies in CONTRIBUTING and the PR template against it.
 * @param {string} anchor
 * @returns {string}
 */
export const updatedLine = (anchor) => `updated: ${anchor} — <what changed>`;

/**
 * The per-doc form for a doc this diff cannot violate.
 * @param {string} anchor
 * @returns {string}
 */
export const unaffectedLine = (anchor) =>
  `unaffected: ${anchor} — <why this diff cannot violate it>`;

/**
 * The clause-anchored form, whose placeholder asks about the rule rather than
 * the document.
 * @param {string} anchor
 * @returns {string}
 */
export const clauseLine = (anchor) =>
  `unaffected: ${anchor} — <why this diff cannot violate this rule>`;

/** Those forms as the contributor-facing surfaces show them. */
export const UPDATED_LINE_TEMPLATE = updatedLine(DOC_PLACEHOLDER);
export const UNAFFECTED_LINE_TEMPLATE = unaffectedLine(DOC_PLACEHOLDER);
export const CLAUSE_LINE_TEMPLATE = clauseLine(CLAUSE_EXAMPLE_ANCHOR);

/**
 * The anchor the malformed-line red shows: a doc, its clause optional. The
 * bracketed optional is this red's parse-shape notation rather than another
 * template home — it teaches the accepted grammar in the one line that has to
 * state what would have parsed.
 */
export const FORM_ANCHOR = `${DOC_PLACEHOLDER} [§<clause-id>]`;

/** The marker opening the governance-data-only class's single line. */
export const GOVERNANCE_MARKER = 'governance-data-only:';

/**
 * That line as the contributor-facing surfaces show it — the marker followed by
 * the placeholder naming what the reason has to say. One home for a template
 * that is otherwise typed out wherever a contributor meets it: this check's own
 * red output builds it from here, and the unit suite holds the copies in
 * CONTRIBUTING and the PR template against it.
 */
export const GOVERNANCE_LINE_TEMPLATE = `${GOVERNANCE_MARKER} <why the documented governance goals survive this edit>`;

/** That line in full: the exact marker, then a non-empty reason. */
const GOVERNANCE_LINE_RE = /^governance-data-only:\s*(\S.*)$/;

/**
 * A line reaching for the marker without landing on it — a near-miss spelling
 * of the hyphenated stem, or a reason left empty. Anchored on that stem so an
 * attempt is reported as malformed while ordinary prose ("Governance data is
 * untouched by this change.") stays prose; a spaced spelling is deliberately
 * left to the missing-line red, which prints the marker template inline.
 */
const GOVERNANCE_ATTEMPT_RE = /^governance-data/i;

/**
 * Pure core: parse the disposition section's lines (assumes comments are
 * already stripped).
 * @param {string} section the section text (without the heading)
 * @returns {{ lines: { verb: string, doc: string, clause: string | null, text: string }[],
 *             malformed: string[] }}
 */
export function parseDispositionSection(section) {
  const lines = [];
  const malformed = [];
  for (const raw of section.split('\n')) {
    const line = raw
      .trim()
      .replace(PREFIX_RE, '')
      .replace(/^\*\*(updated|unaffected):\*\*/i, '$1:')
      .trim();
    if (!line) continue;
    const m = line.match(LINE_RE);
    if (!m) {
      // Tolerate prose only if it does not look like an attempted line.
      if (/^(updated|unaffected)/i.test(line)) malformed.push(line);
      continue;
    }
    const doc = m[2].replace(/^`(.+)`$/, '$1');
    const clause = m[3] ? m[3].replace(/^`(.+)`$/, '$1') : null;
    lines.push({ verb: m[1], doc, clause, text: m[4].trim() });
  }
  return { lines, malformed };
}

/**
 * Pure core: parse the disposition section's governance-data-only lines —
 * recognized beside the per-doc grammar, not through it, so the per-doc
 * parser's shape stays exactly what its other reader consumes. Assumes
 * comments are already stripped.
 * @param {string} section the section text (without the heading)
 * @returns {{ reasons: string[], malformed: string[] }}
 */
export function parseGovernanceSection(section) {
  const reasons = [];
  const malformed = [];
  for (const raw of section.split('\n')) {
    const line = raw
      .trim()
      .replace(PREFIX_RE, '')
      .replace(/^\*\*(governance-data-only):\*\*/i, '$1:')
      .trim();
    if (!line) continue;
    const m = line.match(GOVERNANCE_LINE_RE);
    if (m) reasons.push(m[1].trim());
    else if (GOVERNANCE_ATTEMPT_RE.test(line)) malformed.push(line);
  }
  return { reasons, malformed };
}

/**
 * Extract a `## `-headed section's body from a PR description: the text between
 * this heading and the next UNFENCED `## ` heading. The slice itself is the
 * shared {@link extractHeadingSection}, which finds both boundaries on a
 * fence-stripped view (the one fence model, `stripFences` in
 * `check-test-inventory.js`, which blanks fenced lines and keeps the line
 * count) and returns the raw lines between
 * them, so a `##` line inside a fenced example neither ends a section nor opens
 * one — a heading inside a fence is not a heading, and a body whose only
 * section heading sits inside one carries no such section. A fence left open
 * runs to the end of the body, so every heading below it is inside it, and
 * everything the author fenced comes back in the section it sits in. What this
 * reading states of its own is the two patterns: the heading is `## ` and the
 * title, case-insensitively and with nothing but whitespace after it, and only
 * another `## ` line ends the section — a `### ` subheading is inside it.
 * @param {string} body
 * @param {string} title the section title without the `## ` prefix
 * @returns {string | null} the text between this heading and the next unfenced `## `, or null
 */
export function extractSection(body, title) {
  return extractHeadingSection(
    body,
    new RegExp(`^##\\s+${escapeForRegExp(title)}\\s*$`, 'i'),
    /^##\s+/,
  );
}

const key = ({ doc, clause }) => `${doc}§${clause ?? ''}`;

function describeExpected({ doc, clause }) {
  return clause ? `${doc} §${clause}` : doc;
}

/**
 * Pure core: audit a PR body against the expected lines. HTML comments are
 * stripped first, so template scaffolding is inert in both directions.
 * @param {object} opts
 * @param {string} opts.body the PR description
 * @param {{ doc: string, clause: string | null }[]} opts.expected
 * @param {boolean} [opts.governanceData] true when the diff is in the
 *   governance-data-only class, whose section carries the single marker line
 *   in place of the per-doc lines (callers pass an empty `expected` with it);
 *   on any other diff that line is unearned.
 * @returns {{ missingSections: string[], missing: string[], unexpected: string[],
 *             malformed: string[], duplicates: string[], governanceProblems: string[],
 *             changeRecordProblems: string[] }}
 */
export function auditBody({ body, expected, governanceData = false }) {
  const result = {
    missingSections: [],
    missing: [],
    unexpected: [],
    malformed: [],
    duplicates: [],
    governanceProblems: [],
    changeRecordProblems: [],
  };
  const clean = stripHtmlComments(body ?? '');

  const dispo = extractSection(clean, 'Docs disposition');
  if (dispo === null) {
    result.missingSections.push(DISPOSITION_HEADING);
    result.missing = expected.map(describeExpected);
    if (governanceData) result.governanceProblems.push(`no "${GOVERNANCE_MARKER}" line`);
  } else {
    const { lines, malformed } = parseDispositionSection(dispo);
    const governance = parseGovernanceSection(dispo);
    result.malformed = [...malformed, ...governance.malformed];
    if (governanceData) {
      if (governance.reasons.length === 0) {
        result.governanceProblems.push(`no "${GOVERNANCE_MARKER}" line`);
      } else if (governance.reasons.length > 1) {
        result.governanceProblems.push(
          `${governance.reasons.length} "${GOVERNANCE_MARKER}" lines — the section carries exactly one`,
        );
      }
    } else if (governance.reasons.length > 0) {
      result.governanceProblems.push(
        `"${GOVERNANCE_MARKER}" line on a diff outside the governance-data-only class`,
      );
    }
    const seen = new Set();
    for (const l of lines) {
      if (seen.has(key(l))) result.duplicates.push(describeExpected(l));
      seen.add(key(l));
    }
    for (const e of expected) {
      if (!seen.has(key(e))) result.missing.push(describeExpected(e));
    }
    const expectedKeys = new Set(expected.map(key));
    for (const l of lines) {
      if (!expectedKeys.has(key(l))) result.unexpected.push(describeExpected(l));
    }
  }

  const record = extractSection(clean, 'Change record');
  if (record === null) {
    result.missingSections.push(CHANGE_RECORD_HEADING);
  } else {
    for (const marker of CHANGE_RECORD_MARKERS) {
      const escaped = escapeForRegExp(marker);
      if (!new RegExp(`^\\s*${escaped}`, 'm').test(record)) {
        result.changeRecordProblems.push(`change record has no "${marker}" line`);
      }
    }
  }

  return result;
}

/* c8 ignore start — the CLI wrapper reads the PR body from env and the diff
 * from git; the scope resolution, exemption rules, expected-line computation,
 * and body parsing it delegates to are unit-tested above. */
function run() {
  const baseRef = process.argv[2] || 'origin/main';
  const body = process.env.PR_BODY || '';
  // Derived from the forwarded head branch and head repository by the guard
  // that owns that rule: under a GitHub Actions run the release-automation
  // class then admits nothing a branch on another repository can name, and with
  // no Actions context the supplied ref passes through
  // (check-no-release-outputs.js, effectiveHeadRef).
  const headRef = effectiveHeadRef();

  const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
  const files = git(['diff', '--name-only', `${baseRef}...HEAD`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // Full-file context so the manifest exemption checks always see the enclosing
  // dependency block's opener/header (see MANIFEST_DIFF_CONTEXT).
  const fileDiff = (f) => git(['diff', `-U${MANIFEST_DIFF_CONTEXT}`, `${baseRef}...HEAD`, '--', f]);

  const exempt = exemptionClass({ files, fileDiff, headRef });
  if (exempt === RELEASE_AUTOMATION_CLASS) {
    console.log(
      `✓ release-automation change on ${AUTOMATED_BRANCH} — no docs disposition required.`,
    );
    return;
  }
  if (exempt === DEPENDENCY_ONLY_CLASS) {
    console.log('✓ dependency-only change — no docs disposition required.');
    return;
  }

  const governanceData = isGovernanceDataDiff(files);
  let docs = [];
  let expected = [];
  if (!governanceData) {
    // The map is read through its own check's loader and the registry through
    // the shared governance-data home, so one that cannot be read as its own
    // data — one that cannot be read at all, or text that is not JSON — is
    // refused with that loader's named verdict, never a stack trace and never
    // an expected-line list derived from nothing. The two loaders end on
    // different codes, deliberately: the registry's refusal takes this check's
    // own exit code (exit 2), which keeps machinery breakage apart from a body
    // that is missing lines (exit 1), while the map's refusal is still printed
    // on that ordinary red path.
    let map;
    try {
      map = loadMap();
    } catch (err) {
      refuseOnShapeError(err);
    }
    let registry;
    try {
      registry = loadRegistry();
    } catch (err) {
      refuseOnRegistryError(err);
    }
    try {
      docs = docsInScope({ files, map, readFile: readTextOrNull });
    } catch (err) {
      // A map that no longer fits the shape this check reads it through is a
      // refusal on the check's own input: the red is that named verdict,
      // printed as the refusal states it on the ordinary red path — never a
      // stack trace, and never an expected-line list derived from nothing.
      refuseOnShapeError(err);
    }
    expected = expectedDispositionLines({ docs, registry });
  }
  const r = auditBody({ body, expected, governanceData });

  const problems = [];
  if (r.missingSections.length) {
    problems.push(
      `✗ missing PR-body section(s): ${r.missingSections.join(', ')} — add each as its own "## " heading; a heading inside a code fence is not one, and a fence left open runs to the end of the body.`,
    );
  }
  if (r.missing.length) {
    problems.push(
      `✗ ${r.missing.length} expected disposition line(s) are missing. The PR body's\n` +
        `"${DISPOSITION_HEADING}" section needs exactly one line for each of:\n` +
        r.missing
          .map((d) =>
            d.includes('§')
              ? `    ${updatedLine(d)}   OR   ${clauseLine(d)}`
              : `    ${updatedLine(d)}   OR   ${unaffectedLine(d)}`,
          )
          .join('\n'),
    );
  }
  if (r.unexpected.length) {
    problems.push(
      `✗ ${r.unexpected.length} disposition line(s) name docs/clauses not in this change's scope:\n` +
        r.unexpected.map((d) => `    ${d}`).join('\n') +
        (governanceData
          ? `\n  This diff changes only the governance data, so its section carries exactly this\n` +
            `  one line in place of every per-doc line:\n` +
            `    ${GOVERNANCE_LINE_TEMPLATE}`
          : `\n  Scope is derived from the changed files via ${MAP_PATH}; remove lines that are not in scope\n` +
            `  (and write paths bare — a path that only differs by backticks parses as a different doc).`),
    );
  }
  if (r.governanceProblems.length) {
    problems.push(
      `✗ governance-data-only problems:\n` +
        r.governanceProblems.map((d) => `    ${d}`).join('\n') +
        (governanceData
          ? `\n  Every changed file here is ${MAP_PATH} or ${REGISTRY_PATH}, with the map among\n` +
            `  them, so the "${DISPOSITION_HEADING}" section carries exactly this one line:\n` +
            `    ${GOVERNANCE_LINE_TEMPLATE}\n` +
            `  and no per-doc lines. "${CHANGE_RECORD_HEADING}" is unchanged.`
          : `\n  That line is earned only by a diff whose every changed file is ${MAP_PATH} or\n` +
            `  ${REGISTRY_PATH}, with the map among them. ` +
            (expected.length === 0
              ? `This diff owes no per-doc lines\n  either, so its "${DISPOSITION_HEADING}" section stays without the marker.`
              : `This diff carries the per-doc lines instead.`)),
    );
  }
  if (r.malformed.length) {
    problems.push(
      `✗ ${r.malformed.length} line(s) look like dispositions but do not parse:\n` +
        r.malformed.map((d) => `    ${d}`).join('\n') +
        `\n  Form: "${updatedLine(FORM_ANCHOR)}" or "${unaffectedLine(FORM_ANCHOR)}" (em dash),\n` +
        `  or "${GOVERNANCE_LINE_TEMPLATE}" for a diff whose changed files are ${MAP_PATH},\n` +
        `  alone or together with ${REGISTRY_PATH}.`,
    );
  }
  if (r.duplicates.length) {
    problems.push(
      `✗ duplicate disposition line(s) for:\n` + r.duplicates.map((d) => `    ${d}`).join('\n'),
    );
  }
  if (r.changeRecordProblems.length) {
    problems.push(
      `✗ change-record problems:\n` +
        r.changeRecordProblems.map((d) => `    ${d}`).join('\n') +
        `\n  Every PR carries a "${CHANGE_RECORD_HEADING}" section with at least "Intent:",\n` +
        `  "Outside knowledge:" (say "none" explicitly if so), and a "mutation:" statement,\n` +
        `  each starting its own line — the "mutation:" line's standing sentence to paste:\n` +
        `    ${MUTATION_LINE}`,
    );
  }

  if (problems.length) {
    console.error(problems.join('\n\n'));
    console.error(
      `\nThis check verifies the sections' form only — the judgments in them are read by people.\n` +
        `See .github/CONTRIBUTING.md ("Docs Disposition and Change Record") for the grammar.`,
    );
    process.exit(1);
  }
  console.log(
    governanceData
      ? `✓ docs disposition well-formed: the governance-data-only record; change record present.`
      : `✓ docs disposition well-formed: ${expected.length} line(s) covering ${docs.length} doc(s); change record present.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
