/**
 * check-adapter-surface.js — admission test for the platform-adapter seam's
 * member agreement (docs/architecture/system/shared-core.md §SC-3): every
 * member the `PlatformAdapter` typedef declares in
 * packages/shared/views/adapter.js is implemented by each concrete adapter —
 * today the Chrome one and the Tauri one.
 *
 * WHICH files those are is derived rather than listed, from the convention that
 * clause states: a tracked `adapter-<platform>.js` outside the packages' test
 * trees, with the contract file itself excluded as the one named path it is. So
 * a platform whose
 * adapter lands in the tree owes the seam's obligations by existing, and the
 * shared-core document's own enumeration of the seam is diffed against the same
 * derivation — read as the files its links TARGET, since the names it prints
 * are bare basenames and two packages could carry one of those. The derivation
 * runs over the tracked files of the directory it is invoked from, like every
 * other population read in this family.
 *
 * The typedef side reads one shape: the single JSDoc block declaring that
 * typedef, and inside it each `@property` entry stating its brace-delimited
 * type and its member name on one line. The adapter side reads the object
 * literal the file's DEFAULT EXPORT names: `export default <name>` is resolved
 * to the one binding of that name the file declares — a `const`, `let`, or
 * `var` declaration — whose initializer is read as an object literal, and
 * members are read from that literal's OWN braces — brace-depth bounded, so a
 * member of a second top-level literal in the same file, exported or not, never
 * satisfies a typedef member. Within the literal a member is recognized where a
 * property can start (right after the opening brace and after each top-level
 * comma): a name, or a quoted name, followed by `:`, by an argument list, or by
 * the property's end, with `async` admitted before a method name and read as
 * the member name itself where the property's shape is its own. Every other
 * property shape — an accessor, a computed key, a spread, a generator, anything
 * else — is refused by name rather than skipped.
 *
 * Both directions are held, because the typedef is the seam's one home. The
 * typedef states the obligation, so a member it declares that an adapter does
 * not implement reds; and a member every concrete adapter implements that the
 * typedef does not declare reds as an undeclared shared member. A member only
 * some platforms' callers need stays admitted, under the rule the adapter
 * file's header states for it. A name written twice reds beside those two — an
 * `@property` declared twice, or a key written twice in an adapter literal,
 * where the later one silently shadows the earlier — since the deduplicating
 * set diffs cannot see it.
 *
 * Refusals are machinery verdicts, never silent passes: a file that cannot be
 * read, a count of typedef blocks or `export default` statements or candidate
 * bindings other than one, a default export that names no binding the scan can
 * resolve — an object literal exported directly, with no binding to resolve,
 * among them — a named binding initialized from something other than an object
 * literal, a literal that never closes, a property shape outside the set read,
 * an `@property` entry the reader does not model, and an empty parse on any
 * surface each fail loudly. A refusal takes the MEMBER legs off the report: they
 * read their surfaces as member lists, and a refused surface is not one, so no
 * missing-member or shared-member red is ever derived from a refused parse. The
 * enumeration diff against the seam document is not one of those legs and rides
 * beside such a refusal; the one refusal that suppresses it is a refusal in the
 * derivation, where the set it would be measured against was never produced.
 *
 * Honest limits, each named: the contract file is left out by its PATH, a fixed
 * equality against {@link TYPEDEF_PATH} rather than a rule about the shape of a
 * name, and what a rename of it costs follows that constant. Moved with the
 * file, the equality still excludes it and the derivation is what it was.
 * Left behind, the renamed file derives as a concrete adapter — and the run
 * reds, but as REFUSALS rather than as a seam disagreement: the constant's old
 * path no longer reads, which refuses; the contract file's own
 * `export default undefined` resolves to no binding, which refuses; and a
 * refusal takes the member legs off the report, so the diff that would say the
 * contract file implements nothing is never derived at all. The seam document's
 * enumeration diff rides beside those two and is the red that names the file.
 * The residue is therefore what the reds SAY — a path that cannot be read and a
 * default export that resolves to nothing, never "the contract file was
 * renamed"; an `@property` whose type and name do not share a
 * line, and one written in the JSDoc optional form, are refused by name, so
 * extending the typedef's grammar is a decision that reaches review rather than
 * a silently unread entry; the typedef block is located textually over the
 * file's JSDoc comment spans, so exactly one block declaring the typedef is
 * required and any other count is refused; a member name is a bare or quoted
 * name, so a template literal — which the shared tokenizer gives a type of its
 * own — is refused by shape in the KEY position, as is the computed key that is
 * the only way one reaches that position in valid JavaScript, while a template
 * standing in a value position is read like any other value: the member scan
 * inspects keys, so the names either side of it are read as written; and how
 * the shared tokenizer reads a regular-expression literal, with the shapes
 * where that reading and the grammar part, is stated at {@link tokenizeJs} in
 * [`check-test-inventory.js`](./check-test-inventory.js). The pattern a literal
 * read as division puts into the stream is read as the code that text spells,
 * so a name standing where a property can start there is CREDITED as a member,
 * and one adapter alone carrying it stays admitted, SILENTLY: the reverse leg
 * holds the members every adapter implements, which is the only place such a
 * name would show. A brace written in that pattern moves the member scan's own
 * bound at the same time, and what that costs follows the brace: a balanced
 * pair moves it by nothing; an unbalanced CLOSING brace ends the literal early,
 * so the members past it go unread and red as unimplemented; an unbalanced
 * OPENING brace leaves the literal never closing, which is refused by name —
 * and a refusal takes the member legs off the report here, so no member red is
 * derived from it at all. Past an UNMATCHED quote written there the stream
 * stays out of step to
 * the end of that file, while a division read as a
 * literal takes at most the rest of its own line out of the stream; the members
 * either of those covers red as missing or refused by shape, or the object
 * literal stops closing and reds as such.
 *
 * Usage:
 *   node scripts/check-adapter-surface.js  # or: npm run lint:adapter-surface
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  duplicateSurfaceProblems,
  emptySurfaceProblems,
  formatProblemBlock,
  missingFrom,
  normalizePath,
  stripFences,
  tokenizeJs,
  trackedFilesUnder,
  walkObjectLiteral,
} from './check-test-inventory.js';

/** Repo-relative path of the shared file declaring the adapter contract. */
export const TYPEDEF_PATH = 'packages/shared/views/adapter.js';
/** The typedef whose properties are the contract's members. */
export const TYPEDEF_NAME = 'PlatformAdapter';
/** The shared-core clause the member-agreement legs verify. */
export const SC_CLAUSE_ID = 'SC-3';
/** The tree the concrete adapters are derived from. */
export const ADAPTER_TREE = 'packages';
/** The directory name whose trees the derivation leaves out: a package's tests. */
export const ADAPTER_TEST_DIR = 'tests';
/** The filename convention §SC-3 states, as the derivation reads it. */
const ADAPTER_FILE_RE = /^adapter-([A-Za-z0-9_-]+)\.js$/;
/** The document whose adapter-seam section enumerates the same set in prose. */
export const SEAM_DOC_PATH = 'docs/architecture/system/shared-core.md';
/** The `##` section of that document making the enumeration claim. */
export const SEAM_SECTION = 'The adapter seam';

/**
 * Derive the concrete adapters from a tracked-file listing, by the convention
 * §SC-3 states: a file named `adapter-<platform>.js`, outside the packages' own
 * `tests/` trees — which is what keeps a suite named after an adapter from
 * reading as one — with the contract file itself excluded as the one named path
 * it is: the guard is a path equality against {@link TYPEDEF_PATH}, so a
 * contract file that moved onto an adapter's name with that constant left
 * behind would derive here like any other, and what the run then reds with is
 * stated as a residue in this file's header. The surface
 * key each entry carries is derived from the same name, so a leg is generated
 * per platform rather than written per platform.
 *
 * A name whose platform token this reader cannot take, and two adapters whose
 * tokens collide, are refused by name: the first would be an unread adapter and
 * the second would silently give one leg two files.
 * @param {string[]} files tracked repo-relative paths
 * @returns {{ adapters: { key: string, path: string, platform: string }[], problems: string[] }}
 */
export function deriveAdapters(files) {
  const problems = [];
  const adapters = [];
  const claimed = new Map();
  for (const path of [...files].sort()) {
    if (path === TYPEDEF_PATH) continue;
    const segments = path.split('/');
    if (segments[0] !== ADAPTER_TREE) continue;
    if (segments.includes(ADAPTER_TEST_DIR)) continue;
    const name = segments[segments.length - 1];
    if (!name.startsWith('adapter-') || !name.endsWith('.js')) continue;
    const match = ADAPTER_FILE_RE.exec(name);
    if (match === null) {
      problems.push(`${path} sits where a concrete adapter sits and is named like one, but its platform token is not one this derivation reads — an adapter is \`adapter-<platform>.js\`, and a name outside that is refused rather than left unread (${SC_CLAUSE_ID})`); // prettier-ignore
      continue;
    }
    const platform = match[1];
    if (claimed.has(platform)) {
      problems.push(`${path} and ${claimed.get(platform)} both name the platform \`${platform}\`, so one surface key would answer for two adapters — rename one, since the seam is held per platform (${SC_CLAUSE_ID})`); // prettier-ignore
      continue;
    }
    claimed.set(platform, path);
    adapters.push({ key: `${platform}Members`, path, platform });
  }
  return { adapters, problems };
}

/**
 * The adapters the tree carries, derived from the directory this is invoked
 * from — the population read every check in this family takes.
 * @returns {ReturnType<typeof deriveAdapters>}
 */
export function trackedAdapters() {
  return deriveAdapters(trackedFilesUnder(ADAPTER_TREE));
}

/**
 * Join the adapter paths into one phrase, whatever length the list is, so the
 * prose is derived from the list rather than written against today's platforms.
 * @param {string[]} paths
 * @returns {string} the paths as one phrase
 */
export function joinPaths(paths) {
  if (paths.length < 2) return paths.join('');
  return `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
}

/**
 * The adapter files the seam document's own section enumerates, read as the
 * files its links TARGET rather than as the names it prints: those names are
 * bare basenames, and what a reader is sent to is the path. The section is
 * sliced by its `##` heading, fences blanked first, so an illustrative link
 * inside one is never read as the enumeration.
 * @param {string} markdown the document's text
 * @returns {{ targets: string[] } | { error: string }}
 */
export function extractSeamEnumeration(markdown) {
  const text = stripFences(markdown);
  const at = text.indexOf(`## ${SEAM_SECTION}`);
  if (at === -1) {
    return { error: `${SEAM_DOC_PATH} states no \`## ${SEAM_SECTION}\` section, where this leg reads the seam's own enumeration` }; // prettier-ignore
  }
  const rest = text.slice(at + 1);
  const end = rest.search(/\n#{1,2}\s/);
  const section = end === -1 ? rest : rest.slice(0, end);
  const dir = SEAM_DOC_PATH.split('/').slice(0, -1).join('/');
  const targets = [];
  for (const [, target] of section.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (target.startsWith('#') || /^[a-z]+:/.test(target)) continue;
    const path = normalizePath(`${dir}/${target.split('#')[0]}`);
    if (ADAPTER_FILE_RE.test(path.split('/').pop())) targets.push(path);
  }
  return { targets };
}

const JSDOC_BLOCK_RE = /\/\*\*[\s\S]*?\*\//g;
const TYPEDEF_DECLARATION_RE = new RegExp(`@typedef\\s*\\{[^}]*\\}\\s*${TYPEDEF_NAME}\\b`);
const PROPERTY_TAG = '@property';
const MEMBER_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var']);
/** What a read member's name is followed by: a value, an argument list, or the property's end. */
const PROPERTY_SHAPES = new Set([':', '(', ',', '}']);

/**
 * Read one `@property` entry, starting just past its tag. The entry is read on
 * its own line: a brace-delimited type (nested braces honoured) followed by the
 * member name. Anything else is returned as what the scan found in its place,
 * so an entry outside the grammar is refused by name rather than skipped.
 * @param {string} line the rest of the line after the `@property` tag
 * @returns {{ name: string | null, found: string | null }} the member name, or
 *   what stands in its place (`found` is null exactly when a name was read)
 */
function readProperty(line) {
  const shown = `\`${PROPERTY_TAG}${line.trimEnd()}\``;
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i++;
  if (line[i] !== '{') return { name: null, found: `${shown} states no brace-delimited type` };
  let depth = 0;
  for (; i < line.length; i++) {
    if (line[i] === '{') depth++;
    else if (line[i] === '}' && --depth === 0) {
      i++;
      break;
    }
  }
  if (depth !== 0) return { name: null, found: `${shown} never closes its type braces on its line` }; // prettier-ignore
  while (i < line.length && /\s/.test(line[i])) i++;
  const match = MEMBER_NAME_RE.exec(line.slice(i));
  if (match === null) return { name: null, found: `${shown} states no member name after its type` };
  return { name: match[0], found: null };
}

/**
 * Read the member names the `PlatformAdapter` typedef declares. Exactly one
 * JSDoc block may declare the typedef; every `@property` entry inside it is
 * read or refused by name.
 * @param {string} source the shared adapter file's source
 * @returns {{ names: string[], problems: string[] }}
 */
export function extractTypedefProperties(source) {
  const problems = [];
  const names = [];
  const blocks = (source.match(JSDOC_BLOCK_RE) ?? []).filter((b) => TYPEDEF_DECLARATION_RE.test(b));
  if (blocks.length !== 1) {
    problems.push(`${TYPEDEF_PATH} carries ${blocks.length} JSDoc blocks declaring the ${TYPEDEF_NAME} typedef — the member scan models exactly one`); // prettier-ignore
    return { names, problems };
  }
  const block = blocks[0];
  for (let at = block.indexOf(PROPERTY_TAG); at !== -1;) {
    const from = at + PROPERTY_TAG.length;
    const end = block.indexOf('\n', from);
    const { name, found } = readProperty(block.slice(from, end === -1 ? block.length : end));
    if (name !== null) names.push(name);
    else problems.push(`${TYPEDEF_PATH}'s ${TYPEDEF_NAME} typedef carries an entry the scan cannot read — ${found} — an entry states its brace-delimited type and its member name on one line`); // prettier-ignore
    at = block.indexOf(PROPERTY_TAG, from);
  }
  return { names, problems };
}

/**
 * Read one property of an adapter literal, starting at the token a property
 * begins with. A member is a name — or a quoted name — the property's shape
 * follows: `:`, an argument list, or the property's end (the shorthand form).
 * `async` before a method name is the modifier; standing on a property shape of
 * its own it is the member name. Every other shape is refused by name, so an
 * accessor, a computed key, a spread, a generator, or anything else the reader
 * does not model reds loudly instead of dropping a member silently.
 * @param {{ type: string, value: string }[]} tokens the literal's token stream
 * @param {number} i index of the token the property begins with
 * @returns {{ name: string | null, found: string | null }} the member name, or
 *   what stands in its place (`found` is null exactly when a name was read)
 */
function readMember(tokens, i) {
  const shown = (j) => (tokens[j] ? `\`${tokens[j].value}\`` : '(end of source)');
  const refusal = { name: null, found: `${shown(i)} followed by ${shown(i + 1)}` };
  const isKey = (t) => t && (t.type === 'word' || t.type === 'string');
  const endsProperty = (t) => t && t.type === 'punct' && PROPERTY_SHAPES.has(t.value);

  if (tokens[i] && tokens[i].type === 'word' && tokens[i].value === 'async') {
    if (isKey(tokens[i + 1]) && tokens[i + 2] && tokens[i + 2].value === '(') {
      return { name: tokens[i + 1].value, found: null };
    }
    return endsProperty(tokens[i + 1]) ? { name: 'async', found: null } : refusal;
  }
  if (isKey(tokens[i]) && endsProperty(tokens[i + 1])) {
    return { name: tokens[i].value, found: null };
  }
  return refusal;
}

/**
 * Read the members a concrete adapter implements: the object literal its
 * default export names — the one `const`, `let`, or `var` binding of that name
 * the file declares — read from that literal's own braces. Every anchor failure
 * — the `export default` count, a default export that names no binding the scan
 * can resolve (an object literal exported directly, with no binding to resolve,
 * among them), the binding count, a named binding initialized from something
 * other than an object literal, a literal that never closes — is a problem of
 * this extractor, reported instead of a partial member list passing as the
 * adapter's surface.
 * @param {string} source the adapter file's source
 * @param {string} path the adapter's repo-relative path, for the diagnoses
 * @returns {{ names: string[], problems: string[] }}
 */
export function extractAdapterMembers(source, path) {
  const problems = [];
  const names = [];
  const tokens = tokenizeJs(source);
  const at = (i, type, value) => tokens[i] && tokens[i].type === type && tokens[i].value === value;
  const shown = (i) => (tokens[i] ? `\`${tokens[i].value}\`` : '(end of source)');

  const defaults = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (at(i, 'word', 'export') && at(i + 1, 'word', 'default')) defaults.push(i);
  }
  if (defaults.length !== 1) {
    problems.push(`${path} carries ${defaults.length} \`export default\` statements — the adapter literal is resolved through exactly one`); // prettier-ignore
    return { names, problems };
  }

  const exported = tokens[defaults[0] + 2];
  if (!exported || exported.type !== 'word') {
    problems.push(`${path}'s \`export default\` names no binding the scan can resolve — it exports ${shown(defaults[0] + 2)}, where the adapter is exported as a named object literal`); // prettier-ignore
    return { names, problems };
  }
  const binding = exported.value;

  const declarations = [];
  for (let i = 1; i + 1 < tokens.length; i++) {
    if (
      tokens[i].type === 'word' &&
      tokens[i].value === binding &&
      tokens[i - 1].type === 'word' &&
      DECLARATION_KEYWORDS.has(tokens[i - 1].value) &&
      at(i + 1, 'punct', '=')
    ) {
      declarations.push(i);
    }
  }
  if (declarations.length !== 1) {
    problems.push(`${path} declares ${declarations.length} \`${binding}\` bindings the default export could resolve to — the member scan models exactly one`); // prettier-ignore
    return { names, problems };
  }

  const open = declarations[0] + 2;
  if (!at(open, 'punct', '{')) {
    problems.push(`${path}'s \`${binding}\` is initialized from ${shown(open)} rather than an object literal — the members are read from the literal's own braces`); // prettier-ignore
    return { names, problems };
  }

  // The walk is the shared skeleton; what a property IS is this check's own
  // policy, which reads a member name or refuses the shape by name.
  const { closed } = walkObjectLiteral(tokens, open, (i) => {
    const { name, found } = readMember(tokens, i);
    if (name !== null) names.push(name);
    else problems.push(`${path}'s \`${binding}\` object literal states a property the member scan does not model, beginning ${found} — a member is read as a name or a quoted name followed by \`:\`, by an argument list, or by the property's end, with \`async\` admitted before a method name`); // prettier-ignore
  });
  if (!closed) {
    problems.push(`${path}'s \`${binding}\` object literal never closes — the member scan cannot run`); // prettier-ignore
  }
  // Any refusal above makes this list something other than the adapter's
  // surface, so the refusals are the answer and no partial list rides out.
  return problems.length ? { names: [], problems } : { names, problems };
}

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Built from the DERIVED adapter list, so a platform the tree grows
 * is exercised automatically and the suite's generated family follows it.
 * @param {{ key: string, path: string }[]} adapters the derived adapters
 * @returns {[string, string][]}
 */
export const emptySurfaces = (adapters) => [
  ['typedefProperties', `no @property entries found in the ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH})`], // prettier-ignore
  ...adapters.map(({ key, path }) => [key, `no members found in the object literal ${path} exports by default`]), // prettier-ignore
];

/**
 * The duplicates guard's legs — the one drift the deduplicating set diffs
 * cannot see: a member named twice in the typedef, or a key written twice in an
 * adapter literal (where the later one silently shadows the earlier). Built
 * from the same derived list as its twin.
 * @param {{ key: string, path: string }[]} adapters the derived adapters
 * @returns {[string, string][]}
 */
export const duplicateSurfaces = (adapters) => [
  ['typedefProperties', `the ${TYPEDEF_NAME} typedef's properties`],
  ...adapters.map(({ key, path }) => [key, `${path}'s adapter literal`]),
];

/**
 * Pure core: evaluate the seam's member agreement. The surfaces carry one
 * member list per derived adapter, keyed by that adapter's own surface key, so
 * the legs run per platform rather than per named platform.
 * @param {object} s the extracted surfaces — `typedefProperties` plus one
 *   member list per adapter, under that adapter's `key`
 * @param {{ key: string, path: string }[]} adapters the derived adapters
 * @returns {string[]} problems; empty when the typedef and every concrete
 *   adapter agree in both directions (the extractors' anchor failures are their
 *   own problems and are reported beside these)
 */
export function evaluateAdapterSurface(s, adapters) {
  const problems = [];
  const paths = joinPaths(adapters.map(({ path }) => path));

  // The reverse leg holds the members EVERY adapter implements, so it needs at
  // least two to mean anything: over one adapter the intersection is that
  // adapter's whole surface and would red its every platform-specific member,
  // and over none it holds nothing at all. Either way the derivation has
  // stopped seeing the seam it is here to hold, which is a red of its own
  // rather than a leg quietly skipped.
  if (adapters.length < 2) {
    problems.push(`the derivation finds ${adapters.length} concrete adapter(s) under ${ADAPTER_TREE}/ — ${SC_CLAUSE_ID} holds the seam in both directions, and the direction over the members every adapter implements states nothing below two, so this is the derivation having stopped seeing the seam rather than a seam that agrees`); // prettier-ignore
    return problems;
  }

  const empty = emptySurfaceProblems(s, emptySurfaces(adapters));
  if (empty.length > 0) {
    problems.push(...empty);
    return problems; // empty parses make the member diffs meaningless
  }

  problems.push(...duplicateSurfaceProblems(s, duplicateSurfaces(adapters)));

  for (const { key, path } of adapters) {
    problems.push(
      ...missingFrom(s.typedefProperties, s[key], `is declared by the ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH}) but ${path} does not implement it (${SC_CLAUSE_ID})`), // prettier-ignore
    );
  }

  // The other direction: a member every concrete adapter implements belongs in
  // the typedef, the seam's one home. A member only some platforms' callers
  // need is outside this intersection and stays admitted.
  const sharedMembers = [...new Set(s[adapters[0].key])].filter((member) =>
    adapters.every(({ key }) => s[key].includes(member)),
  );
  problems.push(
    ...missingFrom(sharedMembers, s.typedefProperties, `is implemented by ${paths} but the ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH}) declares no such member (${SC_CLAUSE_ID}) — declare it as an @property there, or keep it to the platforms whose callers need it, which that typedef's own header admits`), // prettier-ignore
  );

  return problems;
}

/**
 * Read every surface from the working tree and evaluate the contract. The
 * adapters are DERIVED from the tracked files by default — the population read
 * this family shares, taken from the directory the check is invoked in — so a
 * caller stating its own listing holds the same legs over the tree it names.
 * @param {(f: string) => string | null} readFile repo-relative content reader,
 *   answering null for a file it cannot read
 * @param {string[]} [files] the tracked listing to derive the adapters from
 * @returns {{ problems: string[], memberCount: number, adapters: object[] }}
 *   `memberCount` is the declared contract's size — the members every concrete
 *   adapter was held to. A refusal from any extractor takes the MEMBER legs off
 *   the report: they read the surfaces as member lists, and a refused surface is
 *   not one, so no missing-member or shared-member red is ever derived from it.
 *   The seam document's enumeration diff is not one of those legs — it rides
 *   beside such a refusal, since it was computed from a derivation that held
 *   against a document that was read; only a refusal in the derivation itself
 *   suppresses it, and there it is never computed.
 */
export function auditTree(readFile, files) {
  const refused = [];
  const drift = [];
  const read = (path) => {
    const source = readFile(path);
    if (typeof source !== 'string') {
      refused.push(`${path} cannot be read — the seam is compared across every file it names`); // prettier-ignore
      return null;
    }
    return source;
  };

  const derived = files === undefined ? trackedAdapters() : deriveAdapters(files);
  const adapters = derived.adapters;
  // A derivation that could not take a name, or that found two adapters under
  // one platform, has not produced the set the legs run over — a refusal, on
  // the same terms as a surface that would not parse.
  refused.push(...derived.problems);

  // The document's own enumeration of the seam, held to the same derivation in
  // both directions: a platform the tree carries that the section does not send
  // a reader to, and a link the section still sends a reader to that the tree
  // no longer carries as an adapter. These are DRIFT, not refusals — each side
  // was read; they disagree — so they stand beside the member diffs rather than
  // in place of them. The one refusal that does suppress them is a refusal in
  // the DERIVATION itself: a diff against a set that was never derived stands
  // on nothing, which is a different thing from one side of a held diff being
  // unreadable somewhere else.
  const derivationRefused = derived.problems.length > 0;
  const seamSource = read(SEAM_DOC_PATH);
  if (seamSource !== null && !derivationRefused) {
    const enumeration = extractSeamEnumeration(seamSource);
    if (enumeration.error) refused.push(enumeration.error);
    else {
      const paths = adapters.map(({ path }) => path);
      drift.push(
        ...missingFrom(paths, enumeration.targets, `is a concrete adapter the tree carries, and no link of ${SEAM_DOC_PATH}'s "${SEAM_SECTION}" section targets it — the section enumerates the seam's implementations (${SC_CLAUSE_ID})`), // prettier-ignore
        ...missingFrom(enumeration.targets, paths, `is targeted by a link of ${SEAM_DOC_PATH}'s "${SEAM_SECTION}" section as an implementation of the seam, and the derivation finds no such concrete adapter in the tree (${SC_CLAUSE_ID})`), // prettier-ignore
      );
    }
  }

  const typedefSource = read(TYPEDEF_PATH);
  const typedef =
    typedefSource === null ? { names: [], problems: [] } : extractTypedefProperties(typedefSource);
  refused.push(...typedef.problems);

  const s = { typedefProperties: typedef.names };
  for (const { key, path } of adapters) {
    const source = read(path);
    const members =
      source === null ? { names: [], problems: [] } : extractAdapterMembers(source, path);
    refused.push(...members.problems);
    s[key] = members.names;
  }

  const memberCount = new Set(s.typedefProperties).size;
  // A refused surface is not a member list, so no MEMBER diff is derived from
  // one: a refusal still takes the member legs off the report. The enumeration
  // drift is not one of those legs — it was computed from a derivation that
  // held, against a document that was read — so it rides beside refusals that
  // stand elsewhere (a surface that would not parse, a file that would not
  // read) rather than being hidden by them. Only a refusal in the derivation
  // suppresses it, and there it was never computed at all.
  if (refused.length) return { problems: [...drift, ...refused], memberCount, adapters };
  return { problems: [...drift, ...evaluateAdapterSurface(s, adapters)], memberCount, adapters };
}

/* c8 ignore start — the CLI wrapper reads the tree and formats the pass/fail
   output; the pure extraction and evaluation core above is unit-tested. */
function run() {
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null; // an unreadable file is refused by name, never parsed as empty
    }
  };
  const { problems, memberCount, adapters } = auditTree(readFile);
  const paths = joinPaths(adapters.map(({ path }) => path));

  if (problems.length) {
    console.error(
      formatProblemBlock(
        `the platform-adapter seam drifted from the ${TYPEDEF_NAME} typedef`,
        problems,
        `  The ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH}) is the seam's\n` +
          `  one home: every member it declares is implemented by each concrete adapter\n` +
          `  the tree carries — a tracked \`adapter-<platform>.js\` outside the packages'\n` +
          `  test trees${paths === '' ? '' : `, today ${paths}`} —\n` +
          `  and every member all of them implement is declared there (§${SC_CLAUSE_ID}). Close\n` +
          `  the gap the way the change intends: implement the member in the adapter that\n` +
          `  lacks it, drop the @property once the seam no longer requires it, or declare\n` +
          `  the @property the adapters already agree on. A member only some platforms'\n` +
          `  callers need belongs in those platforms' own adapter files, under the admission\n` +
          `  rule the typedef's own header states (${TYPEDEF_PATH}).\n`,
      ),
    );
    process.exit(1);
  }
  console.log(
    `✓ adapter surface consistent: ${memberCount} ${TYPEDEF_NAME} members are implemented ` +
      `by each of the ${adapters.length} concrete adapters derived from the tree (${paths}), ` +
      `which is the set ${SEAM_DOC_PATH}'s "${SEAM_SECTION}" section sends a reader to.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
