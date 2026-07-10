/**
 * check-docs-disposition.js — format check for the two structured PR-body
 * sections, `## Docs disposition` and `## Change record`.
 *
 * Every change is governed by docs (scripts/area-map.json maps code to them),
 * and the PR body must carry one explicit line per governing doc saying what
 * happened to it:
 *
 *   updated: docs/<path> — <what changed>
 *   unaffected: docs/<path> — <why this diff cannot violate it>
 *
 * When a governing doc states its rules as registered clauses
 * (docs/clause-registry.json), each clause tagged judgment-only additionally
 * takes its own line, anchored by the clause id:
 *
 *   unaffected: docs/<path> §CP-3 — <why this diff cannot violate this rule>
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
 * Declared exemption (not author-based): a PR is exempt when every changed
 * file is a lockfile, a dependency manifest whose changed lines all sit inside
 * dependency blocks, or a workflow file whose change only moves action pins
 * (same action, new SHA). Anything more — an npm script edit, an action
 * identity swap — is a real change and carries the sections.
 *
 * Red output enumerates the exact lines expected, so the check teaches its
 * own fix.
 *
 * Inputs (CI): PR_BODY via env (from the event payload, never interpolated
 * into a shell), the base ref as argv[2] (default origin/main).
 *
 * Usage:
 *   PR_BODY="..." node scripts/check-docs-disposition.js [baseRef]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileMap, resolveFile, globToRegExp, MAP_PATH } from './check-area-map.js';

/** Repo-relative path of the clause registry (same file check-clause-registry.js guards). */
const REGISTRY_PATH = 'docs/clause-registry.json';

/** Section headings required in every non-exempt PR body. */
export const DISPOSITION_HEADING = '## Docs disposition';
export const CHANGE_RECORD_HEADING = '## Change record';

/** Structural markers the change record must carry, each at a line start. */
export const CHANGE_RECORD_MARKERS = ['Intent:', 'Outside knowledge:', 'mutation:'];

/** Lockfiles — machine-generated, path-exempt. */
const LOCKFILE_GLOBS = ['**/package-lock.json', '**/Cargo.lock'];

/** Dependency manifests — exempt only when the changed lines stay inside dependency blocks. */
const MANIFEST_GLOBS = ['**/package.json', '**/Cargo.toml'];

const lockfileRes = LOCKFILE_GLOBS.map(globToRegExp);
const manifestRes = MANIFEST_GLOBS.map(globToRegExp);

/** A workflow line that carries an action pin: `uses: <action>@<40-hex sha>`. */
const PIN_LINE_RE = /^\s*(?:-\s*)?uses:\s*(\S+)@[0-9a-f]{40}(?:\s*#.*)?$/;

/** package.json blocks whose entries a dependency bump may touch. */
const PACKAGE_JSON_DEP_BLOCKS =
  /^\s*"(dependencies|devDependencies|peerDependencies|optionalDependencies|overrides)"\s*:\s*\{/;

/** Cargo.toml sections whose entries a dependency bump may touch. */
const CARGO_DEP_SECTION = /^\s*\[(.+\.)?(dependencies|dev-dependencies|build-dependencies)\]/;

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
 * Pure core: does a package.json diff change only dependency-block entries?
 * Tracks the enclosing block through the hunk's context lines (indent-matched
 * braces), so an npm-script or metadata edit is never exempt.
 * @param {string} diffText unified diff for one package.json
 * @returns {boolean}
 */
export function isDependencyOnlyPackageJsonDiff(diffText) {
  let sawChange = false;
  let depIndent = null; // indent of the open dependency block, when inside one
  for (const raw of diffText.split('\n')) {
    if (/^(\+\+\+ |--- |@@ |diff |index )/.test(raw)) {
      depIndent = null; // context does not carry across hunks
      continue;
    }
    const changed = /^[+-]/.test(raw);
    const line = changed ? raw.slice(1) : raw.startsWith(' ') ? raw.slice(1) : raw;
    if (depIndent === null) {
      if (PACKAGE_JSON_DEP_BLOCKS.test(line)) depIndent = line.match(/^\s*/)[0].length;
      if (changed) {
        sawChange = true;
        if (!PACKAGE_JSON_DEP_BLOCKS.test(line)) return false; // changed outside a dep block
      }
    } else {
      const closes = new RegExp(`^\\s{${depIndent}}\\}`).test(line);
      if (changed) {
        sawChange = true;
        // Inside a dependency block only simple "name": "range" entries move.
        if (!closes && !/^\s*"[^"]+"\s*:\s*"[^"]*",?\s*$/.test(line)) return false;
      }
      if (closes) depIndent = null;
    }
  }
  return sawChange;
}

/**
 * Pure core: does a Cargo.toml diff change only dependency-section entries?
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

/**
 * Pure core: is this diff exempt from carrying the sections? True when every
 * changed file is a lockfile, a dependency-only manifest change, or a
 * pin-only workflow change.
 * @param {object} opts
 * @param {string[]} opts.files changed file paths
 * @param {(f: string) => string} opts.fileDiff unified diff text for one file
 * @returns {boolean}
 */
export function isExemptDiff({ files, fileDiff }) {
  if (files.length === 0) return false;
  return files.every((f) => {
    if (lockfileRes.some((re) => re.test(f))) return true;
    if (manifestRes.some((re) => re.test(f))) {
      return f.endsWith('Cargo.toml')
        ? isDependencyOnlyCargoTomlDiff(fileDiff(f))
        : isDependencyOnlyPackageJsonDiff(fileDiff(f));
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) return isPinOnlyWorkflowDiff(fileDiff(f));
    return false;
  });
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
 * Extract a `## `-headed section's body from a PR description.
 * @param {string} body
 * @param {string} title the section title without the `## ` prefix
 * @returns {string | null} the text between this heading and the next `## `, or null
 */
export function extractSection(body, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = body.match(new RegExp(`^##\\s+${escaped}\\s*$`, 'mi'));
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
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
 * @returns {{ missingSections: string[], missing: string[], unexpected: string[],
 *             malformed: string[], duplicates: string[], changeRecordProblems: string[] }}
 */
export function auditBody({ body, expected }) {
  const result = {
    missingSections: [],
    missing: [],
    unexpected: [],
    malformed: [],
    duplicates: [],
    changeRecordProblems: [],
  };
  const clean = stripHtmlComments(body ?? '');

  const dispo = extractSection(clean, 'Docs disposition');
  if (dispo === null) {
    result.missingSections.push(DISPOSITION_HEADING);
    result.missing = expected.map(describeExpected);
  } else {
    const { lines, malformed } = parseDispositionSection(dispo);
    result.malformed = malformed;
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
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
  const files = git(['diff', '--name-only', `${baseRef}...HEAD`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const fileDiff = (f) => git(['diff', `${baseRef}...HEAD`, '--', f]);

  if (isExemptDiff({ files, fileDiff })) {
    console.log('✓ dependency-only change — no docs disposition required.');
    return;
  }

  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const docs = docsInScope({ files, map, readFile });
  const expected = expectedDispositionLines({ docs, registry });
  const r = auditBody({ body, expected });

  const problems = [];
  if (r.missingSections.length) {
    problems.push(
      `✗ missing PR-body section(s): ${r.missingSections.join(', ')} — add each as its own "## " heading.`,
    );
  }
  if (r.missing.length) {
    problems.push(
      `✗ ${r.missing.length} expected disposition line(s) are missing. The PR body's\n` +
        `"${DISPOSITION_HEADING}" section needs exactly one line for each of:\n` +
        r.missing
          .map(
            (d) =>
              `    updated: ${d} — <what changed>   OR   unaffected: ${d} — <why this diff cannot violate it>`,
          )
          .join('\n'),
    );
  }
  if (r.unexpected.length) {
    problems.push(
      `✗ ${r.unexpected.length} disposition line(s) name docs/clauses not in this change's scope:\n` +
        r.unexpected.map((d) => `    ${d}`).join('\n') +
        `\n  Scope is derived from the changed files via ${MAP_PATH}; remove lines that are not in scope\n` +
        `  (and write paths bare — a path that only differs by backticks parses as a different doc).`,
    );
  }
  if (r.malformed.length) {
    problems.push(
      `✗ ${r.malformed.length} line(s) look like dispositions but do not parse:\n` +
        r.malformed.map((d) => `    ${d}`).join('\n') +
        `\n  Form: "updated: docs/<path> [§<clause-id>] — <text>" or "unaffected: docs/<path> [§<clause-id>] — <text>" (em dash).`,
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
        `  each starting its own line.`,
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
    `✓ docs disposition well-formed: ${expected.length} line(s) covering ${docs.length} doc(s); change record present.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
