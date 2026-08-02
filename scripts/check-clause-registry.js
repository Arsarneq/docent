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
 *   - every citation the resolution grammar below admits — in a row's
 *     `check-ref` and in its `justification` alike — resolves: a reference to
 *     something that does not exist is a red, not a promise;
 *   - a check-exists row names something runnable: an `npm run` target or a
 *     cited `.js`/`.mjs`/`.rs`/`.json` file;
 *   - the hygiene-lock surfaces state one numbering, checked on every run
 *     whether or not a row cites an ordinal: the active entries of the
 *     {@link LOCK_ORDINAL_CLAUSE} list and the {@link LOCK_SUITE_PATH} suite's
 *     titles agree both ways, an entry the list retires no longer carries a
 *     title, and the prose of the clause's own document — which the clause
 *     authorizes to cite locks by number — names active entries outside its
 *     list ({@link extractDocLockCites}, and see the boundary recorded there:
 *     that document only, with the surfaces left to review named). A row's
 *     ordinal citation (`lock 5`) is held against the list AND the suite, and
 *     is the registry's own red rather than the surfaces';
 *   - a file citation carries its repository path: a path-less `commands.rs`
 *     or `foo.test.js` is refused (see {@link BARE_FILE_SUFFIXES});
 *   - registry text records how a clause is verified, so the requirement
 *     keywords themselves belong to the clause, not to the row — a row states
 *     no uppercase RFC 2119 spelling (the set `RFC_2119_RE` carries) outside a
 *     `code span`;
 *   - the gate's own registered list stays true: every enumerated citable root
 *     file names a tracked source, whether or not a row cites it;
 *   - retired identifiers stay retired: absent from doc text and active rows.
 *
 * The resolution grammar, deliberately narrow and identical for both text
 * fields: a token carrying a directory separator and ending in a dotted file
 * name resolves against the tracked set; one ending in `/` resolves as a
 * tracked-path prefix (at least one tracked file under it); `npm run <name>`
 * resolves against package.json's scripts; and a separator-less file name
 * resolves when it is one of the enumerated {@link CITABLE_ROOT_FILES}. Every
 * other separator-less `name.ext` a row's prose contains (`chrome.storage`,
 * `recording.steps`, `index.html`) is unvalidated by design — except the
 * suite/source suffixes the refusal bullet above names, which are refused
 * rather than ignored ({@link BARE_FILE_SUFFIXES}).
 *
 * Two boundaries keep that grammar off ordinary prose. A token carrying a
 * PATTERN character ({@link PATTERN_CHAR_RE} — `*`, or brace alternation) names
 * a set of files rather than one, so it is taken whole and dropped: a glob is
 * pattern prose, never split into fragments that would resolve against nothing.
 * Asterisk runs at a token's EDGES are Markdown emphasis instead, so
 * `**docs/x.md**` gates the citation inside them, and a lone comma is a
 * separator rather than part of a path, so an unspaced `a/x.js,b/y.js` gates
 * both. And a token whose first segment is a bare number or carries an interior
 * dot is prose, not a path ({@link isProsePathToken}) — `401/403`, `1.2/1.3`,
 * `github.com/…` — while a leading dot stays a dotfile directory, so
 * `.github/workflows/test.yml` gates.
 *
 * How this relates to [`check-clause-governance.js`](./check-clause-governance.js)'s
 * `CITED_PATH_RE`: that shape is a FINDER for governance edges — it casts wide
 * so no citation that might be an edge is missed, and a token it over-collects
 * costs nothing, because a non-path simply resolves to no governance. This one
 * is a GATE: every token it admits must resolve or the build reds, so it admits
 * only tokens whose failure to resolve is unambiguously a broken citation.
 * Neither admission set contains the other: the finder takes the separator-less
 * dotted names this gate leaves unvalidated, and this gate takes the
 * trailing-slash directory citations, the `npm run` targets, and the lock
 * ordinals the finder has no shape for. Pattern-bearing citations are outside
 * BOTH — this gate drops such a token whole, and the finder's directory shape
 * stops at a mid-path glob, so it reads a shorter path than the text names. A
 * citation that names files by pattern is held by neither — a shared
 * limitation, stated on both sides. A pattern-aware shape would be a deliberate
 * future widening of both, not something either does today.
 *
 * This checks form, resolvability, and — for the lock ordinals — that the two
 * surfaces defining them agree. Whether a check actually guards its clause, or
 * a justification is adequate, is judged in review, never here.
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

/** The row text fields this check reads, in the order it reports them. */
const TEXT_FIELDS = ['check-ref', 'justification'];

/**
 * The clause whose numbered list defines the hygiene-lock ordinals a row may
 * cite (`lock 5`), and the suite whose `lock (N):` titles run them. That clause
 * declares its numbering append-only, which is what makes an ordinal a stable
 * reference rather than a position; this check holds every citation against
 * both surfaces, so a renamed lock or a restructured list surfaces here.
 * The clause's doc is read from the registry's own prefix table, never guessed.
 */
export const LOCK_ORDINAL_CLAUSE = 'STC-11';
export const LOCK_SUITE_PATH = 'packages/shared/tests/unit/conformance-vectors.test.js';

/**
 * The closed list of root files a row may cite by bare name — each must be
 * tracked. Enumerating them is what keeps the gate narrow: every other
 * separator-less `name.ext` in a row's prose stays unvalidated by design.
 */
export const CITABLE_ROOT_FILES = [
  'CLA.md',
  'README.md',
  'codecov.yml',
  'eslint.config.js',
  'lefthook.yml',
  'package.json',
];

/**
 * Suffixes whose path-less form is refused: a suite or source file is cited by
 * the repository path that identifies it. `.html` is deliberately outside the
 * list — SC-2 cites the plural generic `index.html` (one assembled page per
 * platform), which has no single qualified form.
 */
export const BARE_FILE_SUFFIXES = ['.test.js', '.spec.js', '.rs', '.mjs'];

/** Extensions that make a cited file a runnable check for the check-exists leg. */
const RUNNABLE_EXT_RE = /\.(?:js|mjs|rs|json)$/;

/**
 * A token carrying at least one directory separator. The pattern characters
 * (`*`, and the brace-alternation `{`, `}`, `,`) are inside the token shape so
 * a pattern is matched WHOLE — the gate then drops it as pattern prose, rather
 * than seeing the fragments a pattern-blind shape would leave behind.
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_.*{},-]+(?:\/[A-Za-z0-9_.*{},-]*)+/g;

/**
 * What makes a token a pattern rather than one file's path. A comma is NOT
 * here: alone it separates two citations, and only inside a brace alternation
 * does it belong to a pattern — which the braces themselves already say.
 */
const PATTERN_CHAR_RE = /[*{}]/;

/**
 * Whether a separator-carrying token is ordinary prose rather than a citation,
 * decided on its FIRST segment: a bare number (`401/403`), or a name carrying
 * an interior dot — a version or measurement (`1.2/1.3`, `200/201.5`) and a
 * host (`github.com/…`) alike. A LEADING dot is a dotfile directory, so
 * `.github/workflows/test.yml` stays a citation; an empty first segment is no
 * name at all.
 * @param {string} token
 * @returns {boolean}
 */
export function isProsePathToken(token) {
  const first = token.split('/')[0];
  if (!first) return true;
  if (/^[0-9]+$/.test(first)) return true;
  return first.replace(/^\./, '').includes('.');
}

/** A separator-less file name: `README.md`, `commands.rs`, `chrome.storage`. */
const BARE_NAME_RE = /(?<![\w/.-])[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]+(?![\w/.-])/g;

/** An npm script citation. */
const NPM_RUN_RE = /npm run ([A-Za-z0-9:_-]+)/g;

/**
 * A hygiene-lock ordinal citation. Case-insensitive (`Lock 2` reads as `lock
 * 2`), in the bracketed and unbracketed spellings alike (`lock 5`, `lock (5)`),
 * and in the hyphenated compound (`hygiene-lock 5`) — admitted defensively: the
 * term itself is written both ways, but no surface here writes the hyphenated
 * compound FOLLOWED BY AN ORDINAL, so that spelling is one a row could reach
 * for rather than one already in use. The plural is admitted for its
 * singular reading only: `locks 5 and 6` cites 5, and the conjunction's further
 * ordinals are not captured. Recorded, not fixed — a row meaning two ordinals
 * writes two citations.
 */
const LOCK_CITE_RE = /(?<![\w-])(?:hygiene-)?locks?\s*\(?([1-9][0-9]*)\)?/gi;

/** The suite's lock titles: `it('lock (5): …')`. */
const LOCK_TITLE_RE = /(?<![\w-])lock\s*\(([1-9][0-9]*)\)\s*:/gi;

/**
 * The RFC 2119 requirement keywords — every uppercase spelling the RFC defines,
 * longest first so a compound is read whole rather than as its tail.
 */
const RFC_2119_RE =
  /(?<![\w-])(NOT RECOMMENDED|RECOMMENDED|SHOULD NOT|SHALL NOT|MUST NOT|REQUIRED|OPTIONAL|SHOULD|SHALL|MUST|MAY)(?![\w-])/g;

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
 * Extract every citation the resolution grammar admits from one row text field
 * (the same grammar for `check-ref` and `justification` — see the header).
 * @param {string} text
 * @returns {{ paths: string[], prefixes: string[], npmScripts: string[],
 *             rootFiles: string[], bareFiles: string[] }}
 *   `paths` tracked-path citations, `prefixes` trailing-slash directory
 *   citations, `npmScripts` `npm run` targets, `rootFiles` citable root files,
 *   `bareFiles` path-less suite/source names the gate refuses — each list
 *   deduplicated, so one citation is reported once however often a row repeats it
 */
export function extractCitedTargets(text) {
  const paths = [];
  const prefixes = [];
  const rootFiles = [];
  const bareFiles = [];
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    // Markdown emphasis wraps a citation in asterisk runs at the token's edges
    // (`**docs/x.md**`); those come off with the sentence punctuation, and what
    // remains is judged as the citation.
    const candidate = m[0].replace(/^\*+/, '').replace(/[.,*]+$/, '');
    if (PATTERN_CHAR_RE.test(candidate)) continue; // a pattern names files, not one file
    // A comma left inside separates citations written without a space.
    for (const token of candidate.split(',')) {
      if (isProsePathToken(token)) continue;
      if (token.endsWith('/')) prefixes.push(token);
      else if (/\/[^/]*\.[A-Za-z0-9]+$/.test(token)) paths.push(token);
    }
  }
  for (const m of text.matchAll(BARE_NAME_RE)) {
    const name = m[0];
    if (CITABLE_ROOT_FILES.includes(name)) rootFiles.push(name);
    else if (BARE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) bareFiles.push(name);
  }
  const unique = (values) => [...new Set(values)];
  return {
    paths: unique(paths),
    prefixes: unique(prefixes),
    npmScripts: unique([...text.matchAll(NPM_RUN_RE)].map((m) => m[1])),
    rootFiles: unique(rootFiles),
    bareFiles: unique(bareFiles),
  };
}

/**
 * The hygiene-lock ordinals a row text cites, in order and with duplicates
 * collapsed.
 * @param {string} text
 * @returns {number[]}
 */
export function extractLockOrdinalCites(text) {
  return [...new Set([...text.matchAll(LOCK_CITE_RE)].map((m) => Number(m[1])))];
}

/**
 * The number a source ordered-list item states, read off the raw markdown.
 * mdast keeps only the list's start, so what an item's own line states is
 * legible in the source and nowhere else — this reads it there.
 */
const LIST_ITEM_NUMBER_RE = /^\s*([0-9]+)[.)]/;

/**
 * The retirement marking an entry carries: its text opens `Retired:`, plainly
 * or emphasized (`**Retired:**`, `**Retired**:`), and with the issue link the
 * clause invites written between the word and the colon (`Retired (#42):`).
 */
const RETIRED_ITEM_RE = /^[*_]*retired[*_]*\s*(?:\([^)]*\))?[*_]*\s*:/i;

/**
 * The ordinals a clause's own numbered list states, split into the entries
 * that still stand and the entries it retires. The list read is the first
 * ordered list following the clause's marker, within the clause's scope; scope
 * ends at the next heading OR the next clause marker, whichever comes first —
 * the marker-to-next-marker-or-heading rule the doctrine states, so a sibling
 * clause's list is never adopted as this clause's numbering.
 *
 * Why retirement lives IN the list: a numbering is append-only only if nothing
 * can shift it, and an entry removed from a Markdown ordered list shifts every
 * number below it — silently, since a formatter renumbers the remaining items
 * to run contiguously. So a retired lock keeps its numbered entry, marked
 * retired with its reason, and loses only its suite title; a removal is a
 * visible edit to this list. Numbers are read literally from the source rather
 * than derived as `start + offset`, which is honest about what each line says
 * and costs nothing.
 * @param {string} markdown the doc stating the clause
 * @param {string} clauseId e.g. `STC-11`
 * @returns {{ active: number[], retired: number[] }} both empty when the marker
 *   or its list is not where this reads
 */
/**
 * The ordered list a clause's numbering lives in: the first ordered list after
 * the clause's marker and within its scope, or null.
 * @param {string} markdown
 * @param {string} clauseId
 * @returns {any} the mdast list node, or null
 */
function findLockList(markdown, clauseId) {
  const tree = unified().use(remarkParse).parse(markdown);
  const nodes = tree.children ?? [];
  const markersIn = (node) => {
    const ids = [];
    visit(node, 'strong', (strong) => {
      if (strong.children?.length === 1 && strong.children[0].type === 'text') {
        const m = strong.children[0].value.match(MARKER_TEXT_RE);
        if (m) ids.push(m[1]);
      }
    });
    return ids;
  };
  const start = nodes.findIndex((node) => markersIn(node).includes(clauseId));
  if (start === -1) return null;
  for (let i = start + 1; i < nodes.length; i++) {
    if (nodes[i].type === 'heading' || markersIn(nodes[i]).length) break;
    if (nodes[i].type === 'list' && nodes[i].ordered) return nodes[i];
  }
  return null;
}

export function parseLockListOrdinals(markdown, clauseId) {
  const empty = { active: [], retired: [] };
  const list = findLockList(markdown, clauseId);
  if (!list) return empty;
  const active = [];
  const retired = [];
  for (const item of list.children ?? []) {
    const from = item.position?.start?.offset;
    const to = item.position?.end?.offset;
    const source = from == null ? null : markdown.slice(from, to ?? undefined);
    const stated = source === null ? null : source.match(LIST_ITEM_NUMBER_RE);
    if (!stated) return empty;
    const body = source.slice(stated[0].length).trimStart();
    (RETIRED_ITEM_RE.test(body) ? retired : active).push(Number(stated[1]));
  }
  return { active, retired };
}

/**
 * The lock ordinals the clause's own document cites in PROSE: every `lock N`
 * outside the numbered list itself, with the line it sits on. The clause
 * authorizes documents to cite locks by number, so the document that states it
 * is held to its own numbering the same way a registry row is.
 *
 * Boundary, deliberate: the doc scanned is the one the registry names for the
 * clause's prefix, and only that one. Two surfaces in the tree cite lock
 * ordinals and are NOT held here — the `description` string of
 * `corpus/vector-fixtures.json`, and code comments. Reading either would mean a
 * fourth parse surface for one string, so both stay held by review; a sweep of
 * every tracked file found no third.
 * @param {string} markdown the doc stating the clause
 * @param {string} clauseId e.g. `STC-11`
 * @returns {{ ordinal: number, line: number }[]} in document order
 */
export function extractDocLockCites(markdown, clauseId) {
  const list = findLockList(markdown, clauseId);
  const from = list?.position?.start?.offset ?? -1;
  const to = list?.position?.end?.offset ?? -1;
  const cites = [];
  for (const m of markdown.matchAll(LOCK_CITE_RE)) {
    if (from >= 0 && m.index >= from && m.index < to) continue;
    cites.push({ ordinal: Number(m[1]), line: markdown.slice(0, m.index).split('\n').length });
  }
  return cites;
}

/**
 * The ordinals the hygiene-lock suite titles, ascending.
 * @param {string} source the suite file's text
 * @returns {number[]} empty when no `lock (N):` title is where this reads
 */
export function parseLockSuiteOrdinals(source) {
  const ordinals = [...source.matchAll(LOCK_TITLE_RE)].map((m) => Number(m[1]));
  return [...new Set(ordinals)].sort((a, b) => a - b);
}

/**
 * The RFC 2119 requirement keywords a row text states outside a code span —
 * quoting one as `` `MUST` `` cites it instead of stating it. Both span
 * delimiters are stripped, the doubled one first, so a span that itself quotes
 * backticks reads as a citation too.
 * @param {string} text
 * @returns {string[]}
 */
export function extractRequirementKeywords(text) {
  const quotesRemoved = text.replace(/``[\s\S]*?``/g, ' ').replace(/`[^`]*`/g, ' ');
  return [...new Set([...quotesRemoved.matchAll(RFC_2119_RE)].map((m) => m[1]))];
}

/**
 * Pure core: audit the registry against the tracked docs.
 * @param {object} opts
 * @param {any} opts.registry parsed clause-registry.json
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable)
 * @param {string[]} opts.packageScripts names in package.json "scripts"
 * @returns {{ shapeErrors: string[], rowErrors: string[], markerErrors: string[],
 *             refErrors: string[], textErrors: string[], retiredErrors: string[],
 *             listErrors: string[], surfaceErrors: string[] }}
 */
export function auditClauseRegistry({ registry, files, readFile, packageScripts }) {
  const r = {
    shapeErrors: [],
    rowErrors: [],
    markerErrors: [],
    refErrors: [],
    textErrors: [],
    retiredErrors: [],
    listErrors: [],
    surfaceErrors: [],
  };

  const tracked = new Set(files);

  // The gate's own registered list, held unconditionally: an enumerated citable
  // root file names one tracked source whether or not a row cites it, so a
  // renamed or deleted root file is red at the list rather than lying dormant
  // until the next citation.
  for (const name of CITABLE_ROOT_FILES) {
    if (!tracked.has(name)) {
      r.listErrors.push(
        `CITABLE_ROOT_FILES enumerates ${name}, which is not a tracked file; an enumerated root file names one tracked source`,
      );
    }
  }

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
  const ordinalCites = [];
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
    } else if (typeof row['check-ref'] !== 'string' || !row['check-ref'].trim()) {
      r.rowErrors.push(`clause "${id}" is ${row.tag} but states no check-ref`);
    }

    // One resolution grammar over both text fields.
    for (const field of TEXT_FIELDS) {
      const text = row[field];
      if (typeof text !== 'string' || !text.trim()) continue;
      const { paths, prefixes: dirs, npmScripts, rootFiles, bareFiles } = extractCitedTargets(text);
      if (field === 'check-ref' && row.tag === 'check-exists') {
        const runnable = [...paths, ...rootFiles].filter((p) => RUNNABLE_EXT_RE.test(p));
        if (runnable.length + npmScripts.length === 0) {
          r.refErrors.push(
            `clause "${id}" is check-exists: its check-ref names the check that exists — an npm run target, or a cited .js/.mjs/.rs/.json file`,
          );
        }
      }
      for (const p of paths) {
        if (!tracked.has(p)) {
          r.refErrors.push(`clause "${id}" ${field} cites ${p}; a cited path is a tracked file`);
        }
      }
      for (const dir of dirs) {
        if (!files.some((f) => f.startsWith(dir))) {
          r.refErrors.push(
            `clause "${id}" ${field} cites ${dir}; a cited directory holds at least one tracked file`,
          );
        }
      }
      for (const s of npmScripts) {
        if (!packageScripts.includes(s)) {
          r.refErrors.push(
            `clause "${id}" ${field} cites npm run ${s}; a cited script is one package.json defines`,
          );
        }
      }
      for (const name of rootFiles) {
        if (!tracked.has(name)) {
          r.refErrors.push(
            `clause "${id}" ${field} cites ${name}; a citable root file is a tracked file`,
          );
        }
      }
      for (const name of bareFiles) {
        r.refErrors.push(
          `clause "${id}" ${field} cites ${name}; a file citation carries the repository path that identifies it`,
        );
      }
      for (const keyword of extractRequirementKeywords(text)) {
        r.textErrors.push(
          `clause "${id}" ${field} states ${keyword}; a row records how the clause is verified, and the clause states the requirement — quote a keyword in a code span to cite it`,
        );
      }
      for (const ordinal of extractLockOrdinalCites(text))
        ordinalCites.push({ id, field, ordinal });
    }
    if (!rowsByDoc.has(row.doc)) rowsByDoc.set(row.doc, new Set());
    rowsByDoc.get(row.doc).add(id);
  }

  // Hygiene-lock surfaces. Every leg but the per-row-citation one runs on EVERY
  // audit, cited or not: the surfaces define one numbering whether or not a row
  // happens to lean on it this week, and each answers for its own emptiness — a
  // moved clause marker or a retitled lock is a machinery problem to name, never
  // a leg that quietly holds nothing. Residue: this holds the surfaces to each
  // other, so a renumbering carried out in step across BOTH of them agrees with
  // itself and stays review-held.
  //
  // What is whose fault decides where each red is reported: a surface that will
  // not parse, two surfaces parting, a retired entry still titled, and the
  // clause doc's own prose citing a lock its list does not state are all facts
  // about the SURFACES (surfaceErrors) — the registry may be perfectly correct
  // while any of them holds. Only a row's own citation is the registry's
  // (refErrors).
  {
    const lockPrefix = LOCK_ORDINAL_CLAUSE.match(CLAUSE_ID_RE)[1];
    const lockDoc = prefixes[lockPrefix];
    const lockDocText = lockDoc ? readFile(lockDoc) : null;
    const { active: activeOrdinals, retired: retiredOrdinals } = lockDocText
      ? parseLockListOrdinals(lockDocText, LOCK_ORDINAL_CLAUSE)
      : { active: [], retired: [] };
    const suiteText = readFile(LOCK_SUITE_PATH);
    const suiteOrdinals = suiteText ? parseLockSuiteOrdinals(suiteText) : [];
    const listWhere = lockDoc
      ? `${lockDoc} §${LOCK_ORDINAL_CLAUSE}`
      : `the doc registering prefix "${lockPrefix}"`;
    if (!activeOrdinals.length) {
      r.surfaceErrors.push(
        `EMPTY SURFACE: no active ordinals read from ${listWhere} — the check reads the ordered list that follows the clause marker, so restore that shape before an ordinal citation can be held`,
      );
    }
    if (!suiteOrdinals.length) {
      r.surfaceErrors.push(
        `EMPTY SURFACE: no \`lock (N):\` titles read from ${LOCK_SUITE_PATH} — the check reads the suite's lock titles, so restore that shape before an ordinal citation can be held`,
      );
    }
    if (activeOrdinals.length && suiteOrdinals.length) {
      const inActive = new Set(activeOrdinals);
      const inRetired = new Set(retiredOrdinals);
      const inSuite = new Set(suiteOrdinals);
      const stated = `${listWhere} numbers ${activeOrdinals.join(', ')} active and ${LOCK_SUITE_PATH} titles ${suiteOrdinals.join(', ')}`;
      for (const n of retiredOrdinals) {
        if (inSuite.has(n)) {
          r.surfaceErrors.push(
            `${listWhere} retires lock ${n} while ${LOCK_SUITE_PATH} still titles it; a retired lock keeps its numbered entry and loses its title`,
          );
        }
      }
      const untitled = activeOrdinals.filter((n) => !inSuite.has(n));
      const unlisted = suiteOrdinals.filter((n) => !inActive.has(n) && !inRetired.has(n));
      const parting = [...new Set([...untitled, ...unlisted])].sort((a, b) => a - b);
      if (parting.length) {
        r.surfaceErrors.push(
          `the two lock surfaces state one numbering: ${stated}; they part on ${parting.join(', ')}`,
        );
      }
      // The clause authorizes documents to cite locks by number, so its own
      // prose is held to its own list.
      const seenDocCites = new Set();
      for (const cite of lockDocText ? extractDocLockCites(lockDocText, LOCK_ORDINAL_CLAUSE) : []) {
        if (inActive.has(cite.ordinal)) continue;
        const key = `${cite.line}\t${cite.ordinal}`;
        if (seenDocCites.has(key)) continue;
        seenDocCites.add(key);
        r.surfaceErrors.push(
          `${lockDoc}:${cite.line} cites lock ${cite.ordinal} in prose; a citation names an active lock — ${stated}`,
        );
      }
      const seenCites = new Set();
      for (const cite of ordinalCites) {
        const key = `${cite.id}\t${cite.field}\t${cite.ordinal}`;
        if (seenCites.has(key)) continue;
        seenCites.add(key);
        if (inRetired.has(cite.ordinal)) {
          r.refErrors.push(
            `clause "${cite.id}" ${cite.field} cites lock ${cite.ordinal}, which ${listWhere} retires; a citation names an active lock`,
          );
        } else if (!inActive.has(cite.ordinal) || !inSuite.has(cite.ordinal)) {
          r.refErrors.push(
            `clause "${cite.id}" ${cite.field} cites lock ${cite.ordinal}; a cited ordinal is one both surfaces state — ${stated}`,
          );
        }
      }
    }
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
  // Each section names its own subject: the registry answers for its rows, and
  // this check answers for the list it registers.
  const sections = [
    [REGISTRY_PATH, 'is malformed', r.shapeErrors],
    [REGISTRY_PATH, 'has inconsistent rows', r.rowErrors],
    [REGISTRY_PATH, 'disagrees with the docs', r.markerErrors],
    [REGISTRY_PATH, 'cites what does not resolve', r.refErrors],
    [REGISTRY_PATH, 'states requirements its clauses own', r.textErrors],
    [REGISTRY_PATH, 'violates retirement (retired identifiers are never reused)', r.retiredErrors],
    ['scripts/check-clause-registry.js', 'registers what does not resolve', r.listErrors],
    [
      `the hygiene-lock surfaces (${LOCK_ORDINAL_CLAUSE}'s list and prose, ${LOCK_SUITE_PATH})`,
      'do not state one numbering',
      r.surfaceErrors,
    ],
  ];
  let failed = false;
  for (const [subject, what, errors] of sections) {
    if (!errors.length) continue;
    failed = true;
    console.error(`✗ ${subject} ${what}:\n` + errors.map((e) => `    ${e}`).join('\n') + '\n');
  }
  if (failed) {
    console.error(
      `  Fix: keep doc clause markers (e.g. **CP-3.**) and registry rows in one-to-one agreement,\n` +
        `  give every judgment-only row a justification and every checkable/check-exists row a\n` +
        `  check-ref, and never reuse a retired identifier. A row's text cites a tracked path (with\n` +
        `  its directories), a directory holding tracked files, an npm run target package.json\n` +
        `  defines, one of ${CITABLE_ROOT_FILES.join(', ')}, or an ACTIVE lock ordinal both\n` +
        `  ${LOCK_ORDINAL_CLAUSE} and ${LOCK_SUITE_PATH} state; an intended-but-unbuilt check is\n` +
        `  described in prose, and a check-exists row names the runnable check that exists.\n` +
        `  A retired lock keeps its numbered entry in ${LOCK_ORDINAL_CLAUSE}'s list, marked\n` +
        `  Retired: with the reason, and loses its suite title — that is what keeps the numbering\n` +
        `  append-only, so the two surfaces are held to each other on every run, cited or not.\n` +
        `  The last block is this check's own register, not the registry's: the citable root files\n` +
        `  it enumerates must name tracked sources, and a stale entry reds there against an\n` +
        `  otherwise correct registry.`,
    );
    process.exit(1);
  }
  const docCount = new Set(Object.values(registry.prefixes)).size;
  console.log(
    `✓ clause registry consistent: ${registry.clauses.length} clauses across ${docCount} doc(s), ` +
      `every marker registered, every citation resolves.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
