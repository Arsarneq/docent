/**
 * check-clause-registry.js — parity check between docs that carry stable clause
 * identifiers (e.g. `**CP-3.**`) and `docs/clause-registry.json`, which records
 * how each clause is verified. Guards the well-formedness of that pairing:
 *
 *   - every clause marker in any tracked `.md` uses a registered prefix, sits
 *     in that prefix's registered doc, and appears at most once per doc. That
 *     scope states its own open surface: outside the text this file reads — the
 *     registry's rows, those Markdown markers, and the area map's reason
 *     strings below — a clause-id-shaped token carrying a registered prefix in
 *     a tracked non-Markdown source, in a code comment and in a string literal
 *     alike, is read by no check. The same scope bounds the read failure the
 *     sweep names: a REGISTERED doc that will not read is named, because its
 *     markers are what the bijection stands on, while an unregistered tracked
 *     `.md` that will not read is passed over as it always has been — the
 *     markers it might carry stay unheld either way, which is the standing
 *     posture of every document outside the prefix table;
 *   - markers and registry rows are a bijection per doc — no unregistered
 *     clause, no registry row for a clause the doc no longer states;
 *   - each row's tag carries its required field: `judgment-only` states a
 *     justification, `checkable`/`check-exists` state a check-ref;
 *   - a row states only the keys the grammar carries ({@link ROW_KEYS}): the
 *     shape is closed, so a key outside it — a near-miss spelling of a real
 *     field, say — is named rather than silently read by nothing;
 *   - every citation the resolution grammar below admits — in a row's
 *     `check-ref` and in its `justification` alike — resolves: a reference to
 *     something that does not exist is a red, not a promise;
 *   - a check-exists row names something runnable: an `npm run` target, a
 *     `scripts/*.js` or `scripts/*.mjs` file — the flat `scripts/` tree, which
 *     is by design where this repository keeps the scripts it runs — or a
 *     suite's own code: a `.js`, `.mjs`, or `.rs` file under a `tests/` path,
 *     or a file named `*.test.js`/`*.spec.js`. Whether the thing named
 *     really guards the clause stays review's judgment, as below; what this
 *     admits is a check something in this repository RUNS;
 *   - a row that states {@link TEST_CASES_FIELD} names test cases its own
 *     check-ref's files DECLARE: the field is a list of test-case identifiers
 *     on a check-ref-bearing row, and each identifier is resolved against the
 *     declarators of the anchor-bearing files that check-ref cites by path
 *     ({@link isCaseAnchorFile}) — the title an `it`/`test` call states in a
 *     `.js`/`.mjs` file ({@link jsDeclaredCases}), the name an `fn` declares in
 *     a `.rs` one ({@link rustDeclaresCase}). A declarator is the whole search:
 *     a name a comment mentions, an assertion message quotes, a non-declaring
 *     literal states, or a longer identifier contains is not a case, and
 *     neither is a title a MEMBER call states — `it.skip`, `it.only`, and
 *     another object's own `it` alike break the bare-call shape a declaration
 *     is read as, and a skipped or focused case pins nothing. The field is opt-in, and that
 *     is its admission test: what a row states here is held, and identifiers a
 *     row's prose merely mentions stay prose;
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
 *   - the area map's citations resolve too: a clause-id-shaped token carrying a
 *     registered prefix, in the reason of an entry in one of the map's
 *     {@link AREA_MAP_ENTRY_LISTS}, names an ACTIVE clause — membership in the
 *     registry's active rows is what the leg tests, so an identifier no active
 *     row states, and one the registry retires, are both the MAP's red and name
 *     the entry they sit in; a token whose prefix no row registers is prose the
 *     leg leaves alone, so what this holds is the registered-prefix citations —
 *     a mistyped number reds, and a mistyped PREFIX lands outside the
 *     admission. A list the constant names must be STATED, and its absence is
 *     the MAP's refusal — the surface moved. What that list then holds is the
 *     tree's own answer: an empty one stays green, because the area map's gate
 *     demands removing an entry that is no longer needed, and refusing it here
 *     would deadlock the two gates;
 *   - the enumerated vector fixtures' `description` ({@link VECTOR_FIXTURES_PATH})
 *     is held to the same lock numbering a row's citation is, and a miscite
 *     there is the FIXTURE's red under its own subject: the registry and both
 *     lock surfaces can each be perfectly correct while that description names
 *     a lock nobody states;
 *   - a file citation carries its repository path: a path-less `commands.rs`
 *     or `foo.test.js` is refused (see {@link BARE_FILE_SUFFIXES});
 *   - registry text records how a clause is verified, so the requirement
 *     keywords themselves belong to the clause, not to the row — a row states
 *     no uppercase RFC 2119 spelling (the set `RFC_2119_RE` carries) outside a
 *     `code span`;
 *   - the gate's own register stays true, whether or not a row leans on it:
 *     every enumerated citable root file and the vector-fixtures path name a
 *     tracked source, and a top-level list the map states in the same
 *     reason-bearing shape as the ones {@link AREA_MAP_ENTRY_LISTS} names is
 *     one of them, or a whole class of entry explains itself in reasons no leg
 *     reads. That is this register's own direction; whether a list the constant
 *     names is still there is the MAP's, stated with the map leg above;
 *   - retired identifiers stay retired: absent from doc text and active rows.
 *
 * The resolution grammar, deliberately narrow and identical for both text
 * fields: a token carrying a directory separator and ending in a dotted file
 * name resolves against the tracked set; the same token carrying a pattern
 * character resolves as a PATTERN — expanded and compiled through the map's
 * own glob helpers, it names at least one tracked file; one ending in `/`
 * resolves as a tracked-path prefix (at least one tracked file under it);
 * `npm run <name>` resolves against package.json's scripts; and a
 * separator-less file name resolves when it is one of the enumerated
 * {@link CITABLE_ROOT_FILES}. Every
 * other separator-less `name.ext` a row's prose contains (`chrome.storage`,
 * `recording.steps`, `index.html`) is unvalidated by design — except the
 * suite/source suffixes the refusal bullet above names, which are refused
 * rather than ignored ({@link BARE_FILE_SUFFIXES}).
 *
 * A token carrying a PATTERN character ({@link PATTERN_CHAR_RE} — `*`, or
 * brace alternation) names a SET of files, and is always taken whole rather
 * than split into fragments that would resolve against nothing. Where the set
 * is named in FILE form (`packages/shared/*.js`) it is gated as a pattern;
 * where it is named in DIRECTORY form — a glob whose token ends in a
 * separator — it names a set of directories, which the trailing-slash shape
 * resolves nothing for, so it stays outside the gate.
 *
 * Three boundaries keep the grammar off ordinary prose. Asterisk runs at a
 * PART's edges are Markdown emphasis, so `**docs/x.md**` gates the citation
 * inside them — and they come off with the sentence punctuation inside
 * {@link splitCitationTokens}, part by part, so the trailing stars of
 * `packages/extension/**` leave the directory citation the token names and a
 * run landing where two unspaced citations meet comes off with them. A lone
 * comma is a separator rather than part of a path, so an
 * unspaced `a/x.js,b/y.js` gates both, while a comma inside a brace
 * alternation belongs to the pattern and stays with it. And a token whose
 * first segment is a bare number or carries an interior dot is prose, not a
 * path ({@link isProsePathToken}) — `401/403`, `1.2/1.3`, `github.com/…` —
 * while a leading dot stays a dotfile directory, so
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
 * ordinals the finder has no shape for.
 *
 * A citation that names files by PATTERN is read by three surfaces, and each
 * states the same split. This gate and that finder both RESOLVE a
 * separator-carrying pattern against the tracked set: here it must name at
 * least one tracked file, and there every file it names becomes a governance
 * edge. [`check-schema-echo.js`](./check-schema-echo.js), which reads the
 * finder's shape to enumerate the surfaces one registry row registers, REFUSES
 * a pattern by design — it matches surfaces one literal path at a time against
 * a register, and a set of files is not something that register answers. The
 * SEPARATOR-LESS pattern (`*.test.js`) is the residue of all three: it never
 * reaches this gate's path shape, the finder leaves it unexpanded, and the echo
 * check refuses it only in the shape that reaches for Markdown — a citation
 * naming no Markdown at all sits outside that leg entirely, since the row cites
 * other files for other reasons.
 *
 * Honest limits of the declarator reading, each named. The shared tokenizer a
 * JavaScript title is read through ({@link tokenizeJs}) does not model
 * regular-expression literals — the limit
 * [`check-adapter-surface.js`](./check-adapter-surface.js) already discloses
 * for its own use — so what desynchronizes that file's token stream from there
 * on is a QUOTE written inside such a literal; the failure direction is a loud
 * false red at the CITE, a title past it ceasing to resolve, never a case
 * credited to a file that declares no such thing. The cited anchors carry
 * regular-expression literals today, and none of them carries a quote inside
 * one. On the
 * Rust side a declaration is `fn <name>(` alone: the attribute stack above it
 * is not modelled, so a helper function sharing a cited case's name would
 * resolve as that case. A title built around a value declares nothing either
 * way — named where it is written as a template, and passed over otherwise,
 * with the cite's own red the loud half in both.
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
import { MAP_PATH, expandBraces, globToRegExp } from './check-area-map.js';
import { blankRustStrings, stripRustComments } from './check-command-surface.js';
import { readLoneStringLiteral, tokenizeJs } from './check-test-inventory.js';

/** Repo-relative path of the registry this check guards. */
export const REGISTRY_PATH = 'docs/clause-registry.json';

/**
 * The area-map entry lists whose `reason` text this check reads for clause
 * citations. Each entry names what it decides — a `path`, or the `pattern` a
 * partition covers — so a red can name the entry a reader has to open.
 */
export const AREA_MAP_ENTRY_LISTS = ['declared-governance', 'unassigned', 'governance-partitions'];

/** Repo-relative path of the fixture file whose description cites lock ordinals. */
export const VECTOR_FIXTURES_PATH = 'corpus/vector-fixtures.json';

/** A clause identifier: registered PREFIX, dash, number. */
const CLAUSE_ID_RE = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/;

/** The in-doc marker form: the identifier bolded with a trailing period. */
const MARKER_TEXT_RE = /^([A-Z][A-Z0-9]*-[1-9][0-9]*)\.$/;

/**
 * The same identifier shape as a token inside prose, bounded on both sides so
 * a longer word or a hyphenated compound never yields one. Whether the PREFIX
 * is registered is what decides admission afterwards: an unregistered prefix
 * is ordinary prose (`UTF-8`, `RFC-2119`), and only a registered one makes the
 * token a citation this check holds.
 */
const CLAUSE_TOKEN_RE = /(?<![\w-])([A-Z][A-Z0-9]*)-([1-9][0-9]*)(?![\w-])/g;

/** The closed set of tags a row states, in the order a refusal lists them. */
export const VALID_TAGS = ['checkable', 'check-exists', 'judgment-only'];

/** The row text fields this check reads, in the order it reports them. */
const TEXT_FIELDS = ['check-ref', 'justification'];

/**
 * The optional row field carrying test-case identifiers: the cases that pin the
 * clause, each one a case DECLARED by an anchor-bearing file the same row's
 * check-ref cites by path.
 * A row opts in by stating it, which is what keeps the leg exact — every
 * identifier it lists is held against those files' declarators, and nothing
 * else in the tree is scanned for case-shaped text.
 */
export const TEST_CASES_FIELD = 'test-cases';

/**
 * The closed row grammar: the complete set of keys a registry row states. Every
 * leg here reads a key from this list, so a key outside it is read by nothing —
 * which is what makes a near-miss spelling of a real field (a singular or
 * camelCase variant of {@link TEST_CASES_FIELD}) worth naming out loud: the row
 * looks held and is not. Adding a field to the registry means adding it here.
 */
export const ROW_KEYS = ['clause', 'doc', 'tag', 'justification', 'check-ref', TEST_CASES_FIELD];

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

/**
 * What makes a cited file a runnable check for the check-exists leg: a script
 * this repository runs — the flat `scripts/` tree (`scripts/<name>.js`,
 * `.mjs`), which is where those scripts live by design — or a suite's own
 * code: a `.js`, `.mjs`, or `.rs` file under a `tests/` directory, or a file
 * named `*.test.js`/`*.spec.js` wherever it sits. What a `tests/` path admits
 * is therefore the code that runs there: a page a suite loads, a manifest
 * beside it, or a recorded artifact states no check, however useful it is to
 * the suite that reads it. A row that names none of those, and no `npm run`
 * target either, has described a check rather than named one.
 */
const RUNNABLE_PATH_RE =
  /^scripts\/[^/]+\.m?js$|(?:^|\/)tests\/.*\.(?:m?js|rs)$|\.(?:test|spec)\.js$/;

/** A JavaScript module, where a test case is declared by its title. */
const JS_ANCHOR_RE = /\.m?js$/;

/** A Rust source, where a test case is declared by its function name. */
const RUST_ANCHOR_RE = /\.rs$/;

/** The call words a JavaScript suite declares a case with. */
const CASE_DECLARATORS = ['it', 'test'];

/**
 * A token carrying at least one directory separator. The pattern characters
 * (`*`, and the brace-alternation `{`, `}`, `,`) are inside the token shape so
 * a pattern is matched WHOLE, never as the fragments a pattern-blind shape
 * would leave behind: the gate can then judge a pattern named in FILE form
 * against the tracked set, and leave one named in DIRECTORY form to the
 * trailing-slash branch, which resolves nothing for it.
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

/**
 * A separator-less file name: `README.md`, `commands.rs`, `chrome.storage`.
 * The trailing guard admits a SENTENCE-FINAL period — what continues a name is
 * a dot with a name character after it, and a dot ending a sentence has none —
 * so a citable root file closing a sentence still extracts, and a path-less
 * suite name closing one is still refused instead of escaping the gate.
 */
const BARE_NAME_RE =
  /(?<![\w/.-])[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]+(?![\w/-])(?!\.[A-Za-z0-9])/g;

/** The tail that makes a separator-carrying token name a file. */
const FILE_NAME_TAIL_RE = /\/[^/]*\.[A-Za-z0-9]+$/;

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
 * Split a candidate on the commas that separate two citations written without
 * a space, keeping a comma inside a brace alternation with the pattern it
 * belongs to. An unclosed brace holds its commas the same way — the pattern
 * that results is then refused as uncompilable, which names the typo.
 *
 * Exported as the ONE home of the comma rule AND of a part's edges: the
 * governance finder
 * ([`check-clause-governance.js`](./check-clause-governance.js)) and the
 * schema-echo register reader ([`check-schema-echo.js`](./check-schema-echo.js))
 * read the same rows through a wider token shape that admits a comma inside a
 * directory segment, so an unspaced `a/x.js,b/y.js` reaches each of them as one
 * token. Splitting it here, once, is what keeps the three readers from
 * disagreeing about how many citations that text makes.
 *
 * The split is also what decides where a part's edges ARE, so it strips them:
 * Markdown emphasis around two unspaced citations (`**a/x.js**,**b/y.js**`)
 * puts an asterisk run in the MIDDLE of the text a caller sees, and a caller
 * stripping before the split — or stripping one edge after it — reads a
 * different citation set than its siblings. The strip class holds no `/`, so a
 * directory pattern's trailing stars come off while its trailing slash stays
 * (`packages/extension/**` → `packages/extension/`).
 *
 * Each part arrives as a PAIR, because the two forms answer different
 * questions: `token` is the form a reader MATCHES against the tree, and `raw`
 * is the form the text writes, which is what a refusal names — reporting the
 * stripped form would name a citation the row does not make. A part that is
 * nothing but edges has the empty string for its token; every caller refuses
 * one.
 * @param {string} candidate one path token, edges included
 * @returns {{ raw: string, token: string }[]} one entry per part, in text order
 */
export function splitCitationTokens(candidate) {
  const parts = [];
  let current = '';
  let depth = 0;
  const push = (raw) => parts.push({ raw, token: raw.replace(/^\*+/, '').replace(/[.,*]+$/, '') });
  for (const ch of candidate) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      push(current);
      current = '';
    } else current += ch;
  }
  push(current);
  return parts;
}

/**
 * Extract every citation the resolution grammar admits from one row text field
 * (the same grammar for `check-ref` and `justification` — see the header).
 * @param {string} text
 * @returns {{ paths: string[], patterns: string[], prefixes: string[],
 *             npmScripts: string[], rootFiles: string[], bareFiles: string[] }}
 *   `paths` tracked-path citations, `patterns` pattern citations in file form,
 *   `prefixes` trailing-slash directory citations, `npmScripts` `npm run`
 *   targets, `rootFiles` citable root files, `bareFiles` path-less
 *   suite/source names the gate refuses — each list deduplicated, so one
 *   citation is reported once however often a row repeats it
 */
export function extractCitedTargets(text) {
  const paths = [];
  const patterns = [];
  const prefixes = [];
  const rootFiles = [];
  const bareFiles = [];
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    // Markdown emphasis wraps a citation in asterisk runs at a part's edges
    // (`**docs/x.md**`); those come off with the sentence punctuation inside
    // the split, part by part, so a run landing where two unspaced citations
    // meet comes off too. What each part is left with is judged as the citation.
    for (const { token } of splitCitationTokens(m[0])) {
      if (isProsePathToken(token)) continue;
      if (PATTERN_CHAR_RE.test(token)) {
        // A pattern naming files is gated as a pattern; one naming
        // directories is a set the trailing-slash shape resolves nothing for.
        if (FILE_NAME_TAIL_RE.test(token)) patterns.push(token);
      } else if (token.endsWith('/')) prefixes.push(token);
      else if (FILE_NAME_TAIL_RE.test(token)) paths.push(token);
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
    patterns: unique(patterns),
    prefixes: unique(prefixes),
    npmScripts: unique([...text.matchAll(NPM_RUN_RE)].map((m) => m[1])),
    rootFiles: unique(rootFiles),
    bareFiles: unique(bareFiles),
  };
}

/**
 * Whether a pattern citation names a tracked file. Expansion and compilation
 * are the map's own ([`check-area-map.js`](./check-area-map.js)), so a citation
 * is read exactly as an ownership pattern is; a pattern the compiler refuses is
 * an outcome of its own rather than a throw, so a mistyped pattern names itself
 * instead of ending the run in a stack trace.
 * @param {string} pattern a separator-carrying pattern token in file form
 * @param {string[]} files all git-tracked repo-relative paths
 * @returns {'matches' | 'no-match' | 'uncompilable'}
 */
export function resolvePatternCitation(pattern, files) {
  let compiled;
  try {
    compiled = expandBraces(pattern).map((expanded) => globToRegExp(expanded));
  } catch {
    return 'uncompilable';
  }
  return files.some((f) => compiled.some((re) => re.test(f))) ? 'matches' : 'no-match';
}

/**
 * The clause identifiers a prose text states, deduplicated in first-seen order.
 * Whether an identifier's prefix is registered is the caller's question — this
 * reads the shape, and the registry decides which of those tokens are
 * citations at all.
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractClauseCites(text) {
  const matches = typeof text === 'string' ? [...text.matchAll(CLAUSE_TOKEN_RE)] : [];
  return [...new Set(matches.map((m) => m[0]))];
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
 * clause's prefix, and only that one — every other surface that cites a lock
 * ordinal answers under its own subject instead. A registry row's citation is
 * the registry's, and the enumerated vector fixtures' `description` is the
 * fixtures' ({@link VECTOR_FIXTURES_PATH}). What a sweep of every tracked file
 * for the citation form finds beyond those is this check's own text and the
 * fixtures its suite is built from — quotations of the form, naming no lock —
 * and the suite titles, which are one of the two surfaces rather than a
 * citation of them.
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
 * Whether a cited path is a file whose DECLARATORS can anchor a test case: a
 * JavaScript module, where a case is the title an `it`/`test` call declares, or
 * a Rust source, where it is a function name. Every other cited extension
 * contributes no anchors — a document, a schema, or a configuration states no
 * test case, and a directory citation resolves no file to read.
 * @param {string} path a cited repository path
 * @returns {boolean}
 */
export function isCaseAnchorFile(path) {
  return JS_ANCHOR_RE.test(path) || RUST_ANCHOR_RE.test(path);
}

/**
 * The test-case titles a JavaScript source DECLARES: the string literal
 * standing alone as the first argument of an `it(`/`test(` call, read off the
 * shared token stream ({@link tokenizeJs}) so a title in a comment, in an
 * assertion message, or in any other string is not one of them.
 *
 * Read as a token SEQUENCE — the call word standing FREE, its `(`, and the
 * literal the following punctuation proves whole — so a title a member call
 * states declares nothing here: a `.` on either side of the word breaks that
 * shape. That is what makes `it.skip('…')` and `it.only('…')` declare no case,
 * a skipped or focused title pinning nothing, and what keeps `suite.it('…')`
 * or `RE.test('…')` from crediting a case to a file that declares none.
 * A title built around a value is not a literal standing
 * alone; a TEMPLATE one is refused by name rather than passed over, because a
 * template is how a computed title is written and its author is owed the
 * reason their citation cannot resolve there.
 * @param {string} source the suite's text
 * @returns {{ titles: Set<string>, refused: string[] }} `refused` names each
 *   template title, by the run of literal text it opens with — the empty string
 *   where the title opens with an interpolation instead
 */
export function jsDeclaredCases(source) {
  const tokens = tokenizeJs(source);
  const titles = new Set();
  const refused = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'word' || !CASE_DECLARATORS.includes(tokens[i].value)) continue;
    // The word stands free or it declares nothing: a preceding `.` makes this a
    // member call on some other object, whose argument is that object's
    // business rather than a case this file states.
    const before = tokens[i - 1];
    if (before?.type === 'punct' && before.value === '.') continue;
    const open = tokens[i + 1];
    if (open?.type !== 'punct' || open.value !== '(') continue;
    const read = readLoneStringLiteral(tokens, i + 2, ',)');
    // A template's own flat value is what a refusal names, and the reader
    // answers with the candidate token wherever the kind says there is one.
    if (read.lone) titles.add(read.value);
    else if (read.kind === 'template') refused.push(read.token);
  }
  return { titles, refused };
}

/** Every regular-expression metacharacter, so a name matches only itself. */
const REGEXP_META_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Whether a Rust source DECLARES `name` as a function — `fn <name>(`, read over
 * the comment-stripped, string-blanked view ({@link stripRustComments},
 * {@link blankRustStrings}) so a name a comment or a message mentions is not a
 * declaration. The parameter list is not required empty: a property-based case
 * declares its inputs there.
 *
 * The name is escaped before it becomes a pattern. A Rust function name cannot
 * carry a metacharacter, so one cited against a Rust anchor names no
 * declaration — and escaping is what makes that a clean red rather than a throw
 * or a pattern matching something it was never meant to.
 * @param {string} source the Rust source's text
 * @param {string} name the cited identifier
 * @returns {boolean}
 */
export function rustDeclaresCase(source, name) {
  const anchors = blankRustStrings(stripRustComments(source));
  const escaped = name.replace(REGEXP_META_RE, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])fn\\s+${escaped}\\s*\\(`).test(anchors);
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
 *             listErrors: string[], surfaceErrors: string[], mapErrors: string[],
 *             fixtureErrors: string[], readErrors: string[] }}
 *   each bucket named for the surface that answers for it — `mapErrors` the
 *   area map's own clause citations, `fixtureErrors` the vector fixtures'
 *   description, `readErrors` the tree itself where a file this check reads did
 *   not answer, none of them the registry's to answer for
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
    mapErrors: [],
    fixtureErrors: [],
    readErrors: [],
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
  // The same register, one file wider: the fixture surface this check reads by
  // path. Holding it here is what makes a RENAMED fixture this check's own red
  // at its register, rather than the fixtures' restore-that-shape surface error
  // for a file that is perfectly present under its new name.
  if (!tracked.has(VECTOR_FIXTURES_PATH)) {
    r.listErrors.push(
      `VECTOR_FIXTURES_PATH names ${VECTOR_FIXTURES_PATH}, which is not a tracked file; the fixture surface this check reads names one tracked source`,
    );
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

  const registered = [];
  for (const [prefix, doc] of Object.entries(prefixes)) {
    let stated = true;
    if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) {
      r.shapeErrors.push(`prefix "${prefix}" is not an uppercase identifier`);
      stated = false;
    }
    if (typeof doc !== 'string' || !tracked.has(doc)) {
      r.shapeErrors.push(`prefix "${prefix}" registers untracked doc ${JSON.stringify(doc)}`);
      stated = false;
    }
    if (stated) registered.push(prefix);
  }
  // One rule text for every unregistered-prefix refusal, wherever it is found:
  // what a registered prefix IS is the closed list the registry's own prefix
  // table states, so a reader is shown that list rather than left to look it
  // up. The list is the entries that passed the checks above, so the refusal
  // offers a reader the prefixes this run stands behind — and where that
  // leaves none, the rule says so, because a list ending in nothing tells a
  // reader nothing about what to write.
  const prefixRule = registered.length
    ? `a registered prefix is one of the prefixes ${REGISTRY_PATH} states: ${registered.join(', ')}`
    : `a registered prefix is one ${REGISTRY_PATH} states in its prefix table, which registers none this run — restore that table before a clause identifier can name a registered prefix`;
  for (const [prefix, ids] of Object.entries(retired)) {
    if (!(prefix in prefixes)) {
      r.retiredErrors.push(`retired list for unregistered prefix "${prefix}"; ${prefixRule}`);
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
      r.rowErrors.push(`clause "${id}" uses unregistered prefix "${m[1]}"; ${prefixRule}`);
      continue;
    }
    // The row grammar is closed, so a key no leg reads is named rather than
    // ignored: an unrecognized field sits in the registry looking held while
    // nothing holds it, which a near-miss spelling of a real field is exactly.
    for (const key of Object.keys(row)) {
      if (!ROW_KEYS.includes(key)) {
        r.rowErrors.push(
          `clause "${id}" states unknown key ${JSON.stringify(key)}; a row states ${ROW_KEYS.join(', ')}`,
        );
      }
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
      r.rowErrors.push(
        `clause "${id}" has invalid tag ${JSON.stringify(row.tag)}; a row's tag is one of ${VALID_TAGS.join(', ')}`,
      );
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
      const {
        paths,
        patterns,
        prefixes: dirs,
        npmScripts,
        rootFiles,
        bareFiles,
      } = extractCitedTargets(text);
      if (field === 'check-ref' && row.tag === 'check-exists') {
        const runnable = [...paths, ...rootFiles].filter((p) => RUNNABLE_PATH_RE.test(p));
        if (runnable.length + npmScripts.length === 0) {
          r.refErrors.push(
            `clause "${id}" is check-exists but its check-ref names nothing runnable; a check that exists is an npm run target, a scripts/*.js or scripts/*.mjs file, or a suite's own code — a .js, .mjs, or .rs file under a tests/ path, or a file named *.test.js or *.spec.js`,
          );
        }
      }
      for (const p of paths) {
        if (!tracked.has(p)) {
          r.refErrors.push(
            `clause "${id}" ${field} cites ${p}; a cited path is a tracked file — a token carrying a directory separator and ending in a dotted file name is read as one`,
          );
        }
      }
      // A pattern citation names a set, so what it must do is name a real one:
      // whether it names too many files is a breadth judgment review makes,
      // never a resolvability question this gate can answer.
      for (const pattern of patterns) {
        const outcome = resolvePatternCitation(pattern, files);
        if (outcome === 'uncompilable') {
          r.refErrors.push(
            `clause "${id}" ${field} cites ${pattern}, which does not compile as a pattern; a cited pattern is written in the map's own syntax — \`*\` within a segment, \`**\` as a whole segment, \`{a,b}\` alternation`,
          );
        } else if (outcome === 'no-match') {
          r.refErrors.push(
            `clause "${id}" ${field} cites ${pattern}; a cited pattern names at least one tracked file`,
          );
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
          `clause "${id}" ${field} cites ${name}; a file citation carries the repository path that identifies it, and the suffixes held that way are ${BARE_FILE_SUFFIXES.join(', ')}`,
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

    // Structured test-case cites. The field states identifiers; the row's own
    // check-ref states where they live, so the two are read together — the
    // anchor-bearing files that check-ref cites by path are the whole search
    // space, and an identifier none of them DECLARES is a citation that
    // resolves to nothing. A declarator is what is read, never the file's whole
    // text: a name a comment mentions, an assertion message quotes, or a longer
    // identifier contains states no case.
    if (TEST_CASES_FIELD in row) {
      const cases = row[TEST_CASES_FIELD];
      const wellFormed =
        Array.isArray(cases) &&
        cases.length > 0 &&
        cases.every((name) => typeof name === 'string' && name.trim());
      if (row.tag === 'judgment-only') {
        r.rowErrors.push(
          `clause "${id}" is judgment-only and states ${TEST_CASES_FIELD}; the field names cases a check-ref's anchor-bearing files declare, so it belongs on a row that states a check-ref`,
        );
      } else if (!wellFormed) {
        r.rowErrors.push(
          `clause "${id}" states ${TEST_CASES_FIELD} as ${JSON.stringify(cases)}; the field is a non-empty array of test-case identifiers`,
        );
      } else {
        const ref = typeof row['check-ref'] === 'string' ? row['check-ref'] : '';
        const cited = extractCitedTargets(ref).paths.filter(isCaseAnchorFile);
        if (!cited.length) {
          r.rowErrors.push(
            `clause "${id}" states ${TEST_CASES_FIELD} but its check-ref cites no anchor-bearing file; a named case is a test the row's own cited .js, .mjs, or .rs file declares`,
          );
        } else {
          // The read leg runs over the TRACKED anchors: a citation the tracked
          // set does not answer for is already named by the cited-path red
          // above, and one subject per fact is what keeps that red the whole
          // diagnosis rather than half of two. It still narrows the search,
          // so it is named in the label below beside a file that would not
          // read — a miss reported as a search over the files the row cites
          // would be a search the check never made.
          const anchors = cited.filter((path) => tracked.has(path));
          const untracked = cited.filter((path) => !tracked.has(path));
          // A file that will not read is a fact about the TREE, not about the
          // citation: naming it is what keeps a search over the files that did
          // read from reporting as a search over the files the row cites.
          const searched = [];
          const unread = [];
          for (const path of anchors) {
            const text = readFile(path);
            if (text == null) unread.push(path);
            else searched.push({ path, text });
          }
          for (const path of unread) {
            r.readErrors.push(
              `EMPTY SURFACE: no text read from ${path} — clause "${id}" resolves its ${TEST_CASES_FIELD} in the anchor-bearing files its check-ref cites, so restore that file before a case can be held there`,
            );
          }
          const templates = [];
          const declarators = searched.map(({ path, text }) => {
            if (!JS_ANCHOR_RE.test(path)) return (name) => rustDeclaresCase(text, name);
            const { titles, refused } = jsDeclaredCases(text);
            for (const title of refused) templates.push({ path, title });
            return (name) => titles.has(name);
          });
          // With nothing readable there is no search space at all, so the
          // per-identifier cascade is suppressed: every line it would print
          // would say the row cites what could not be read, which the reds
          // above already say once per file.
          const excluded = [];
          if (untracked.length) {
            excluded.push(`${untracked.join(', ')}, which the tracked set does not carry`);
          }
          if (unread.length) excluded.push(`${unread.join(', ')}, which did not read`);
          const reduced = excluded.length
            ? ` — a reduced search space, computed without ${excluded.join(' and ')}`
            : '';
          const unresolved = (searched.length ? cases : []).filter(
            (name) => !declarators.some((declares) => declares(name)),
          );
          // A refused template is the reason a citation could not resolve in
          // that file, so it is stated where a citation failed to resolve: a
          // row whose every named case resolves is answered already, and the
          // titles a suite computes for its own reasons are its own business.
          for (const { path, title } of unresolved.length ? templates : []) {
            const which = title
              ? `a template literal in ${path} (\`${title}\`)`
              : `a template literal in ${path} opening with an interpolation`;
            r.readErrors.push(
              `no case title read from ${which} — clause "${id}" resolves its ${TEST_CASES_FIELD} against the titles that file declares, and a computed title is refused rather than read as its literal run`,
            );
          }
          for (const name of unresolved) {
            r.refErrors.push(
              `clause "${id}" ${TEST_CASES_FIELD} names ${name}, which none of the files its check-ref cites declares as a test case: ${searched.map((s) => s.path).join(', ')}${reduced}`,
            );
          }
        }
      }
    }

    if (!rowsByDoc.has(row.doc)) rowsByDoc.set(row.doc, new Set());
    rowsByDoc.get(row.doc).add(id);
  }

  // The area map's own citations. A declaration, an exception, and a partition
  // each explain themselves in a `reason`, and those reasons name clauses —
  // which makes them citations, held here like any other. What is whose fault
  // decides the subject: the registry may be perfectly correct while the map
  // names a clause nobody states, so these are the MAP's reds, each naming the
  // entry a reader has to open. The admission is the registered PREFIX: a
  // token whose prefix no row registers is ordinary prose and stays unread, so
  // what this leg holds is the registered-prefix citations.
  {
    const mapText = readFile(MAP_PATH);
    let map;
    try {
      map = mapText === null ? null : JSON.parse(mapText);
    } catch {
      map = null;
    }
    if (!map || typeof map !== 'object') {
      r.mapErrors.push(
        `EMPTY SURFACE: ${MAP_PATH} does not read as JSON — the check reads the reason of every entry in ${AREA_MAP_ENTRY_LISTS.join(', ')}, so restore that shape before a reason's clause citation can be held`,
      );
    } else {
      // The both-directions hold on this check's own register of entry lists.
      // Outward first: a top-level list the map states in the same
      // reason-bearing shape, which this check does not name, is a class of
      // entry explaining itself in a reason no leg reads — the check's red,
      // under its own subject, not the map's.
      for (const [key, value] of Object.entries(map)) {
        if (AREA_MAP_ENTRY_LISTS.includes(key) || !Array.isArray(value)) continue;
        if (!value.some((entry) => typeof entry?.reason === 'string' && entry.reason.trim())) {
          continue;
        }
        r.listErrors.push(
          `${MAP_PATH} states a reason-bearing "${key}" list that AREA_MAP_ENTRY_LISTS does not name; every entry list whose reasons can cite a clause is read here`,
        );
      }
      for (const list of AREA_MAP_ENTRY_LISTS) {
        const entries = map[list];
        // The refusal keys on the list KEY being gone — a shape that moved —
        // and never on an empty array, which is a stated fact about the tree:
        // the area map's own gate demands removing an entry that is no longer
        // needed, so redding an empty list here would deadlock the two gates
        // against each other.
        if (!Array.isArray(entries)) {
          r.mapErrors.push(
            `EMPTY SURFACE: ${MAP_PATH} states no "${list}" array — the check reads every entry's reason there, so restore that shape before a reason's clause citation can be held`,
          );
          continue;
        }
        for (const entry of entries) {
          const names = entry?.path ?? entry?.pattern ?? JSON.stringify(entry ?? null);
          const where = `${MAP_PATH} "${list}" entry ${names}`;
          for (const cited of extractClauseCites(entry?.reason)) {
            const prefix = cited.match(CLAUSE_ID_RE)[1];
            if (!(prefix in prefixes)) continue;
            if (retiredIds.has(cited)) {
              r.mapErrors.push(
                `${where} cites clause "${cited}", which ${REGISTRY_PATH} retires; a citation names an active clause`,
              );
            } else if (!seenIds.has(cited)) {
              r.mapErrors.push(
                `${where} cites clause "${cited}", which no active row of ${REGISTRY_PATH} states; a citation names a registered clause, and prefix "${prefix}" registers ${prefixes[prefix]}`,
              );
            }
          }
        }
      }
    }
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
    // The enumerated vector fixtures cite lock ordinals in their description,
    // which the clause authorizes; a miscite there is the FIXTURE's own red,
    // never the registry's and never the lock surfaces' — those three can each
    // be correct while that description names a lock nobody states.
    let fixtureDescription = null;
    try {
      const parsed = JSON.parse(readFile(VECTOR_FIXTURES_PATH) ?? '');
      if (typeof parsed?.description === 'string' && parsed.description.trim()) {
        fixtureDescription = parsed.description;
      }
    } catch {
      fixtureDescription = null;
    }
    if (fixtureDescription === null) {
      r.fixtureErrors.push(
        `EMPTY SURFACE: no "description" string read from ${VECTOR_FIXTURES_PATH} — the check reads that description's lock citations, so restore that shape before one can be held`,
      );
    }
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
      for (const ordinal of fixtureDescription ? extractLockOrdinalCites(fixtureDescription) : []) {
        if (inRetired.has(ordinal)) {
          r.fixtureErrors.push(
            `${VECTOR_FIXTURES_PATH} description cites lock ${ordinal}, which ${listWhere} retires; a citation names an active lock`,
          );
        } else if (!inActive.has(ordinal) || !inSuite.has(ordinal)) {
          r.fixtureErrors.push(
            `${VECTOR_FIXTURES_PATH} description cites lock ${ordinal}; a cited ordinal is one both surfaces state — ${stated}`,
          );
        }
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
  const registeredDocs = new Set(Object.values(prefixes));
  const unreadableDocs = new Set();
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const content = readFile(file);
    if (content == null) {
      // A REGISTERED doc is one whose markers this check holds to the rows in
      // one-to-one agreement, so a doc that does not read leaves that leg with
      // nothing to assert — named here rather than left to be read as a
      // document stating no clause.
      if (registeredDocs.has(file)) {
        unreadableDocs.add(file);
        r.readErrors.push(
          `EMPTY SURFACE: no text read from ${file} — the check reads each registered doc's clause markers, so restore that file before its markers and the registry's rows can be held to each other`,
        );
      }
      continue;
    }
    const ids = extractClauseMarkers(content);
    if (!ids.length) continue;
    const seen = new Set();
    for (const id of ids) {
      const prefix = id.match(CLAUSE_ID_RE)[1];
      if (!(prefix in prefixes)) {
        r.markerErrors.push(
          `${file} states clause "${id}" with unregistered prefix "${prefix}"; ${prefixRule}`,
        );
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

  // Bijection per registered doc: markers <-> rows. A doc whose text did not
  // read states nothing this leg can pair, so the read failure named above is
  // the whole diagnosis for it — the alternative is a line per row claiming
  // the document dropped a clause, about text nobody has seen.
  for (const doc of registeredDocs) {
    if (unreadableDocs.has(doc)) continue;
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

/**
 * The report sections in output order, each pairing the SUBJECT that answers
 * for a bucket with what went wrong there. Exported because which surface a
 * red is filed under is part of the contract, not a formatting detail: the
 * registry answers for its rows, this check for the list it registers, the
 * lock surfaces for their numbering, the area map for the clauses its reasons
 * cite, the vector fixtures for the locks their description cites, and the tree
 * itself for a file this check reads that did not answer there.
 * @param {ReturnType<typeof auditClauseRegistry>} r
 * @returns {{ subject: string, what: string, errors: string[] }[]}
 */
export function reportSections(r) {
  return [
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
    [MAP_PATH, 'states clause citations that do not resolve', r.mapErrors],
    [VECTOR_FIXTURES_PATH, 'cites lock ordinals that do not resolve', r.fixtureErrors],
    [
      'the tree this check resolves against',
      'does not answer where this check reads it',
      r.readErrors,
    ],
  ].map(([subject, what, errors]) => ({ subject, what, errors }));
}

/**
 * The report's closing fix block: what a row states, what a citation resolves
 * against, and which subject answers for each block above it. BUILT rather than
 * written out, so every closed list it describes is the constant the audit
 * itself reads — a member added to one of them reaches this text without anyone
 * copying it here, which is what keeps the printed advice from drifting away
 * from the rules that produced the red.
 * @returns {string}
 */
export function fixBlock() {
  return (
    `  Fix: keep doc clause markers (e.g. **CP-3.**) and registry rows in one-to-one\n` +
    `  agreement. A row's tag is one of ${VALID_TAGS.join(', ')}: give every\n` +
    `  judgment-only row a justification and every checkable or check-exists row a check-ref,\n` +
    `  and never reuse a retired identifier. A row's text cites a tracked path (with its\n` +
    `  directories), a pattern naming at least one tracked file, a directory holding tracked\n` +
    `  files, an npm run target package.json defines, one of\n` +
    `  ${CITABLE_ROOT_FILES.join(', ')}, or an ACTIVE lock ordinal both\n` +
    `  ${LOCK_ORDINAL_CLAUSE} and ${LOCK_SUITE_PATH} state; a\n` +
    `  file whose name ends in one of ${BARE_FILE_SUFFIXES.join(', ')} is cited by the\n` +
    `  repository path that identifies it. An intended-but-unbuilt check is described in\n` +
    `  prose, and a check-exists row names the runnable check that exists: an npm run target,\n` +
    `  a scripts/*.js or scripts/*.mjs file, or a suite's own code — a .js, .mjs, or .rs file\n` +
    `  under a tests/ path, or a file named *.test.js or *.spec.js.\n` +
    `  A row states "${TEST_CASES_FIELD}" to have its named test cases held: each identifier\n` +
    `  listed there is a test DECLARED by one of the anchor-bearing files that row's check-ref\n` +
    `  cites by path — a title a BARE it/test call states in a .js or .mjs file (a member\n` +
    `  call's title, it.skip or it.only or another object's own it, declares none), a fn name\n` +
    `  in a .rs one. The row grammar is closed at ${ROW_KEYS.join(', ')} — a key\n` +
    `  outside it is read by no leg, so it is named here rather than left looking held.\n` +
    `  A retired lock keeps its numbered entry in ${LOCK_ORDINAL_CLAUSE}'s list, marked\n` +
    `  Retired: with the reason, and loses its suite title — that is what keeps the numbering\n` +
    `  append-only, so the two surfaces are held to each other on every run, cited or not.\n` +
    `  The blocks after the registry's own name other subjects: this check's register (the\n` +
    `  citable root files and the fixture path it names must be tracked sources, and a\n` +
    `  reason-bearing top-level list the map states outside the entry lists this check\n` +
    `  reads — ${AREA_MAP_ENTRY_LISTS.join(', ')} — is a class of entry no leg reads),\n` +
    `  the lock surfaces, the clause citations ${MAP_PATH} states in its entry reasons\n` +
    `  together with its stating each of those lists at all, the lock ordinals\n` +
    `  ${VECTOR_FIXTURES_PATH} cites in its description, and the tree itself wherever a file\n` +
    `  this check reads did not answer where it reads it — each reds against an otherwise\n` +
    `  correct registry, and is fixed where it is stated.`
  );
}

/* c8 ignore start — the CLI wrapper reads the registry, the git file list, and
   package.json and formats the pass/fail output; the pure audit core, the
   report's section model, and the fix block above are unit-tested, and what
   remains here is thin plumbing. */
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
  let failed = false;
  for (const { subject, what, errors } of reportSections(r)) {
    if (!errors.length) continue;
    failed = true;
    console.error(`✗ ${subject} ${what}:\n` + errors.map((e) => `    ${e}`).join('\n') + '\n');
  }
  if (failed) {
    console.error(fixBlock());
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
/* c8 ignore stop */
