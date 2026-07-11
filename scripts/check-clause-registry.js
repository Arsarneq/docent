/**
 * check-clause-registry.js — parity check between docs that carry stable clause
 * identifiers (e.g. `**CP-3.**`) and `docs/clause-registry.json`, which records
 * how each clause is verified. Guards the well-formedness of that pairing:
 *
 *   - every clause marker in any tracked `.md` uses a registered prefix, sits
 *     in that prefix's registered doc, and appears at most once per doc;
 *   - markers and registry rows are a bijection per doc — no unregistered
 *     clause, no registry row for a clause the doc no longer states;
 *   - each row's tag carries its required field: `judgment-only` states a
 *     justification, `checkable`/`check-exists` state a check-ref;
 *   - every `scripts/*.js` path, `npm run <name>`, and tracked check-file
 *     path (under packages/, corpus/, or reference-implementations/, with a
 *     .js/.mjs/.json/.rs extension) named in a check-ref resolves — a reference to a check that does not exist is a
 *     red, not a promise;
 *   - retired identifiers stay retired: absent from doc text and active rows.
 *
 * This checks form and resolvability only — whether a check actually guards
 * its clause, or a justification is adequate, is judged in review, never here.
 *
 * Marker extraction is AST-based (unified + remark-parse): a `**CP-1.**` shown
 * inside a fenced code block is not a strong node, so quoting a marker in an
 * example can never create a phantom clause.
 *
 * Usage:
 *   node scripts/check-clause-registry.js      # or: npm run lint:clause-registry
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

/** Repo-relative path of the registry this check guards. */
export const REGISTRY_PATH = 'docs/clause-registry.json';

/** A clause identifier: registered PREFIX, dash, number. */
const CLAUSE_ID_RE = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/;

/** The in-doc marker form: the identifier bolded with a trailing period. */
const MARKER_TEXT_RE = /^([A-Z][A-Z0-9]*-[1-9][0-9]*)\.$/;

const VALID_TAGS = ['checkable', 'check-exists', 'judgment-only'];

/**
 * Extract clause markers (`**CP-3.**` strong nodes) from a Markdown document.
 * @param {string} markdown
 * @returns {string[]} clause ids in document order (duplicates preserved)
 */
export function extractClauseMarkers(markdown) {
  const tree = unified().use(remarkParse).parse(markdown);
  const ids = [];
  visit(tree, 'strong', (node) => {
    if (node.children?.length === 1 && node.children[0].type === 'text') {
      const m = node.children[0].value.match(MARKER_TEXT_RE);
      if (m) ids.push(m[1]);
    }
  });
  return ids;
}

/**
 * Extract the check references a check-ref names: `scripts/<name>.js` paths and
 * `npm run <name>` script names, and tracked check-file paths under
 * packages/, corpus/, or reference-implementations/ (a path-shaped token is
 * extracted only when it carries a directory separator, so bare filenames
 * stay unvalidated prose).
 * @param {string} checkRef
 * @returns {{ scriptPaths: string[], npmScripts: string[], filePaths: string[] }}
 */
export function extractCheckRefTargets(checkRef) {
  return {
    scriptPaths: [...checkRef.matchAll(/(?<![\w/.-])scripts\/[A-Za-z0-9_\-.]+\.js/g)].map(
      (m) => m[0],
    ),
    npmScripts: [...checkRef.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]),
    filePaths: [
      ...checkRef.matchAll(
        /(?<![\w/.-])(?:packages|corpus|reference-implementations)\/[A-Za-z0-9_\-./]+\.(?:mjs|json|js|rs)\b/g,
      ),
    ].map((m) => m[0]),
  };
}

/**
 * Pure core: audit the registry against the tracked docs.
 * @param {object} opts
 * @param {any} opts.registry parsed clause-registry.json
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable)
 * @param {string[]} opts.packageScripts names in package.json "scripts"
 * @returns {{ shapeErrors: string[], rowErrors: string[], markerErrors: string[],
 *             refErrors: string[], retiredErrors: string[] }}
 */
export function auditClauseRegistry({ registry, files, readFile, packageScripts }) {
  const r = { shapeErrors: [], rowErrors: [], markerErrors: [], refErrors: [], retiredErrors: [] };

  // Shape.
  if (typeof registry !== 'object' || registry === null) {
    return { ...r, shapeErrors: ['registry is not an object'] };
  }
  if (typeof registry.description !== 'string' || !registry.description) {
    r.shapeErrors.push('missing top-level "description" string');
  }
  const prefixes = registry.prefixes;
  if (!prefixes || typeof prefixes !== 'object') r.shapeErrors.push('"prefixes" must be an object');
  const retired = registry.retired;
  if (!retired || typeof retired !== 'object') r.shapeErrors.push('"retired" must be an object');
  if (!Array.isArray(registry.clauses)) r.shapeErrors.push('"clauses" must be an array');
  if (r.shapeErrors.length) return r;

  const tracked = new Set(files);
  for (const [prefix, doc] of Object.entries(prefixes)) {
    if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) {
      r.shapeErrors.push(`prefix "${prefix}" is not an uppercase identifier`);
    }
    if (typeof doc !== 'string' || !tracked.has(doc)) {
      r.shapeErrors.push(`prefix "${prefix}" registers untracked doc ${JSON.stringify(doc)}`);
    }
  }
  for (const [prefix, ids] of Object.entries(retired)) {
    if (!(prefix in prefixes)) {
      r.retiredErrors.push(`retired list for unregistered prefix "${prefix}"`);
      continue;
    }
    if (!Array.isArray(ids)) {
      r.shapeErrors.push(`"retired.${prefix}" must be an array`);
      continue;
    }
    for (const id of ids) {
      const m = typeof id === 'string' && id.match(CLAUSE_ID_RE);
      if (!m || m[1] !== prefix) {
        r.retiredErrors.push(
          `retired id ${JSON.stringify(id)} does not belong to prefix "${prefix}"`,
        );
      }
    }
  }
  if (r.shapeErrors.length) return r;

  // Rows.
  const seenIds = new Set();
  const rowsByDoc = new Map();
  const retiredIds = new Set(Object.values(retired).flat());
  for (const row of registry.clauses) {
    if (!row || typeof row !== 'object' || typeof row.clause !== 'string') {
      r.rowErrors.push(`malformed clause row: ${JSON.stringify(row)}`);
      continue;
    }
    const id = row.clause;
    const m = id.match(CLAUSE_ID_RE);
    if (!m) {
      r.rowErrors.push(`clause id "${id}" does not match PREFIX-number`);
      continue;
    }
    if (!(m[1] in prefixes)) {
      r.rowErrors.push(`clause "${id}" uses unregistered prefix "${m[1]}"`);
      continue;
    }
    if (seenIds.has(id)) r.rowErrors.push(`duplicate registry row for clause "${id}"`);
    seenIds.add(id);
    if (retiredIds.has(id))
      r.retiredErrors.push(`retired clause "${id}" has an active registry row`);
    if (row.doc !== prefixes[m[1]]) {
      r.rowErrors.push(
        `clause "${id}" names doc ${JSON.stringify(row.doc)} but prefix "${m[1]}" registers ${prefixes[m[1]]}`,
      );
    }
    if (!VALID_TAGS.includes(row.tag)) {
      r.rowErrors.push(`clause "${id}" has invalid tag ${JSON.stringify(row.tag)}`);
      continue;
    }
    if (row.tag === 'judgment-only') {
      if (typeof row.justification !== 'string' || !row.justification.trim()) {
        r.rowErrors.push(`clause "${id}" is judgment-only but states no justification`);
      }
    } else {
      const ref = row['check-ref'];
      if (typeof ref !== 'string' || !ref.trim()) {
        r.rowErrors.push(`clause "${id}" is ${row.tag} but states no check-ref`);
      } else {
        const { scriptPaths, npmScripts, filePaths } = extractCheckRefTargets(ref);
        if (
          row.tag === 'check-exists' &&
          scriptPaths.length + npmScripts.length + filePaths.length === 0
        ) {
          r.refErrors.push(
            `clause "${id}" is check-exists but its check-ref names no script, npm run target, or tracked check file`,
          );
        }
        for (const p of [...scriptPaths, ...filePaths]) {
          if (!tracked.has(p)) r.refErrors.push(`clause "${id}" check-ref names untracked ${p}`);
        }
        for (const s of npmScripts) {
          if (!packageScripts.includes(s)) {
            r.refErrors.push(`clause "${id}" check-ref names missing npm script "${s}"`);
          }
        }
      }
    }
    if (!rowsByDoc.has(row.doc)) rowsByDoc.set(row.doc, new Set());
    rowsByDoc.get(row.doc).add(id);
  }

  // Markers across every tracked Markdown file.
  const markersByDoc = new Map();
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const content = readFile(file);
    if (content == null) continue;
    const ids = extractClauseMarkers(content);
    if (!ids.length) continue;
    const seen = new Set();
    for (const id of ids) {
      const prefix = id.match(CLAUSE_ID_RE)[1];
      if (!(prefix in prefixes)) {
        r.markerErrors.push(`${file} states clause "${id}" with unregistered prefix "${prefix}"`);
        continue;
      }
      if (prefixes[prefix] !== file) {
        r.markerErrors.push(
          `${file} states clause "${id}" but prefix "${prefix}" registers ${prefixes[prefix]}`,
        );
        continue;
      }
      if (seen.has(id)) r.markerErrors.push(`${file} states clause "${id}" more than once`);
      seen.add(id);
      if (retiredIds.has(id)) r.retiredErrors.push(`${file} states retired clause "${id}"`);
    }
    markersByDoc.set(file, seen);
  }

  // Bijection per registered doc: markers <-> rows.
  for (const doc of new Set(Object.values(prefixes))) {
    const markers = markersByDoc.get(doc) ?? new Set();
    const rows = rowsByDoc.get(doc) ?? new Set();
    for (const id of markers) {
      if (!rows.has(id))
        r.markerErrors.push(`${doc} states clause "${id}" but the registry has no row for it`);
    }
    for (const id of rows) {
      if (!markers.has(id)) {
        r.markerErrors.push(`registry has a row for "${id}" but ${doc} states no such clause`);
      }
    }
  }

  return r;
}

function run() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const packageScripts = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts);
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const r = auditClauseRegistry({ registry, files, readFile, packageScripts });
  const sections = [
    ['is malformed', r.shapeErrors],
    ['has inconsistent rows', r.rowErrors],
    ['disagrees with the docs', r.markerErrors],
    ['names checks that do not resolve', r.refErrors],
    ['violates retirement (retired identifiers are never reused)', r.retiredErrors],
  ];
  let failed = false;
  for (const [what, errors] of sections) {
    if (!errors.length) continue;
    failed = true;
    console.error(
      `✗ ${REGISTRY_PATH} ${what}:\n` + errors.map((e) => `    ${e}`).join('\n') + '\n',
    );
  }
  if (failed) {
    console.error(
      `  Fix: keep doc clause markers (e.g. **CP-3.**) and registry rows in one-to-one agreement,\n` +
        `  give every judgment-only row a justification and every checkable/check-exists row a\n` +
        `  check-ref that names real scripts, and never reuse a retired identifier. Describe an\n` +
        `  intended-but-unbuilt check in prose; name a scripts/ path, npm run target, or tracked\n` +
        `  check-file path only once it exists (a check-exists row must name at least one).`,
    );
    process.exit(1);
  }
  const docCount = new Set(Object.values(registry.prefixes)).size;
  console.log(
    `✓ clause registry consistent: ${registry.clauses.length} clauses across ${docCount} doc(s), ` +
      `every marker registered, every named check resolves.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
