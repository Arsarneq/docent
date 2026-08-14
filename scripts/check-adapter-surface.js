/**
 * check-adapter-surface.js — admission test for the platform-adapter seam's
 * member agreement (docs/architecture/system/shared-core.md §SC-3): every
 * member the `PlatformAdapter` typedef declares in
 * packages/shared/views/adapter.js is implemented by each concrete adapter —
 * packages/extension/sidepanel/adapter-chrome.js over Chrome extension APIs,
 * packages/desktop/src/adapter-tauri.js over Tauri.
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
 * surface each fail loudly. A refusal is the whole report: the diff legs read
 * their surfaces as member lists, and a refused surface is not one, so no
 * missing-member or shared-member red is ever derived from a refused parse.
 *
 * Honest limits, each named: an `@property` whose type and name do not share a
 * line, and one written in the JSDoc optional form, are refused by name, so
 * extending the typedef's grammar is a decision that reaches review rather than
 * a silently unread entry; the typedef block is located textually over the
 * file's JSDoc comment spans, so exactly one block declaring the typedef is
 * required and any other count is refused; and the shared tokenizer does not
 * model regular-expression literals, so a quote inside one desynchronizes the
 * token stream for the rest of that file — the members past it are then red as
 * missing or refused by shape, or the literal stops closing and reds as such,
 * loud either way.
 *
 * Usage:
 *   node scripts/check-adapter-surface.js  # or: npm run lint:adapter-surface
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { duplicatesIn, missingFrom, tokenizeJs } from './check-test-inventory.js';

/** Repo-relative path of the shared file declaring the adapter contract. */
export const TYPEDEF_PATH = 'packages/shared/views/adapter.js';
/** The typedef whose properties are the contract's members. */
export const TYPEDEF_NAME = 'PlatformAdapter';
/** The shared-core clause the member-agreement legs verify. */
export const SC_CLAUSE_ID = 'SC-3';

/**
 * The concrete adapters, one leg each. Exported so the unit suite's families
 * are generated from this list — an adapter added here is exercised
 * automatically, and the empty-parse and duplicates surfaces below are built
 * from it too.
 */
export const ADAPTERS = [
  { key: 'chromeMembers', path: 'packages/extension/sidepanel/adapter-chrome.js' },
  { key: 'tauriMembers', path: 'packages/desktop/src/adapter-tauri.js' },
];

/**
 * Join the adapter paths into one phrase, whatever length the list is, so the
 * prose is derived from the list rather than written against today's platforms.
 * @param {string[]} paths
 * @returns {string} the paths as one phrase
 */
function joinPaths(paths) {
  if (paths.length < 2) return paths.join('');
  return `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
}

/** Every concrete adapter's path as one phrase, for the reds and the pass line. */
const ADAPTER_PATHS = joinPaths(ADAPTERS.map(({ path }) => path));

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

  let depth = 1;
  let atPropertyStart = true;
  let closed = false;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i];
    const opens = t.type === 'punct' && '([{'.includes(t.value);

    if (t.type === 'punct' && ')]}'.includes(t.value)) {
      depth--;
      if (depth === 0) {
        closed = true; // a trailing comma leaves the property start open — closing it is not a property
        break;
      }
      atPropertyStart = false;
      continue;
    }

    if (depth === 1 && atPropertyStart) {
      const { name, found } = readMember(tokens, i);
      if (name !== null) names.push(name);
      else problems.push(`${path}'s \`${binding}\` object literal states a property the member scan does not model, beginning ${found} — a member is read as a name or a quoted name followed by \`:\`, by an argument list, or by the property's end, with \`async\` admitted before a method name`); // prettier-ignore
      atPropertyStart = false;
      if (opens) depth++;
      continue;
    }

    if (opens) {
      depth++;
      atPropertyStart = false;
      continue;
    }
    if (depth === 1 && t.type === 'punct' && t.value === ',') {
      atPropertyStart = true;
      continue;
    }
    atPropertyStart = false;
  }
  if (!closed) {
    problems.push(`${path}'s \`${binding}\` object literal never closes — the member scan cannot run`); // prettier-ignore
  }
  // Any refusal above makes this list something other than the adapter's
  // surface, so the refusals are the answer and no partial list rides out.
  return problems.length ? { names: [], problems } : { names, problems };
}

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this list —
 * a leg added here is exercised automatically, and the suite holds the list
 * non-empty and its diagnoses distinct.
 */
export const EMPTY_SURFACES = [
  ['typedefProperties', `no @property entries found in the ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH})`], // prettier-ignore
  ...ADAPTERS.map(({ key, path }) => [key, `no members found in the object literal ${path} exports by default`]), // prettier-ignore
];

/**
 * The duplicates guard's legs — the one drift the deduplicating set diffs
 * cannot see: a member named twice in the typedef, or a key written twice in an
 * adapter literal (where the later one silently shadows the earlier). Exported
 * for the suite's generated family and its fixture-key equality lock.
 */
export const DUPLICATE_SURFACES = [
  ['typedefProperties', `the ${TYPEDEF_NAME} typedef's properties`],
  ...ADAPTERS.map(({ key, path }) => [key, `${path}'s adapter literal`]),
];

/**
 * Pure core: evaluate the seam's member agreement.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.typedefProperties the typedef's declared member names
 * @param {string[]} s.chromeMembers the Chrome adapter literal's members
 * @param {string[]} s.tauriMembers the Tauri adapter literal's members
 * @returns {string[]} problems; empty when the typedef and every concrete
 *   adapter agree in both directions (the extractors' anchor failures are their
 *   own problems and are reported beside these)
 */
export function evaluateAdapterSurface(s) {
  const problems = [];

  let vacuous = false;
  for (const [key, message] of EMPTY_SURFACES) {
    if (s[key].length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make the member diffs meaningless

  for (const [key, what] of DUPLICATE_SURFACES) {
    problems.push(...duplicatesIn(s[key], what));
  }

  for (const { key, path } of ADAPTERS) {
    problems.push(
      ...missingFrom(s.typedefProperties, s[key], `is declared by the ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH}) but ${path} does not implement it (${SC_CLAUSE_ID})`), // prettier-ignore
    );
  }

  // The other direction: a member every concrete adapter implements belongs in
  // the typedef, the seam's one home. A member only some platforms' callers
  // need is outside this intersection and stays admitted. The leg needs more
  // than one adapter to mean anything — an intersection over a single adapter
  // is that adapter's whole surface, which would red its every extra member.
  if (ADAPTERS.length > 1) {
    const sharedMembers = [...new Set(s[ADAPTERS[0].key])].filter((member) =>
      ADAPTERS.every(({ key }) => s[key].includes(member)),
    );
    problems.push(
      ...missingFrom(sharedMembers, s.typedefProperties, `is implemented by ${ADAPTER_PATHS} but the ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH}) declares no such member (${SC_CLAUSE_ID}) — declare it as an @property there, or keep it to the platforms whose callers need it, which the adapter file's header admits`), // prettier-ignore
    );
  }

  return problems;
}

/**
 * Read every surface from the working tree and evaluate the contract.
 * @param {(f: string) => string | null} readFile repo-relative content reader,
 *   answering null for a file it cannot read
 * @returns {{ problems: string[], memberCount: number }} `memberCount` is the
 *   declared contract's size — the members every concrete adapter was held to.
 *   A refusal from any extractor is the whole report: the diff legs read the
 *   surfaces as member lists, and a refused surface is not one, so no
 *   missing-member or shared-member red is ever derived from it.
 */
export function auditTree(readFile) {
  const problems = [];
  const read = (path) => {
    const source = readFile(path);
    if (typeof source !== 'string') {
      problems.push(`${path} cannot be read — the seam is compared across every file it names`); // prettier-ignore
      return null;
    }
    return source;
  };

  const typedefSource = read(TYPEDEF_PATH);
  const typedef =
    typedefSource === null ? { names: [], problems: [] } : extractTypedefProperties(typedefSource);
  problems.push(...typedef.problems);

  const s = { typedefProperties: typedef.names };
  for (const { key, path } of ADAPTERS) {
    const source = read(path);
    const members =
      source === null ? { names: [], problems: [] } : extractAdapterMembers(source, path);
    problems.push(...members.problems);
    s[key] = members.names;
  }

  const memberCount = new Set(s.typedefProperties).size;
  if (problems.length) return { problems, memberCount }; // a refused surface is not a member list
  return { problems: evaluateAdapterSurface(s), memberCount };
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
  const { problems, memberCount } = auditTree(readFile);

  if (problems.length) {
    console.error(
      `✗ the platform-adapter seam drifted from the ${TYPEDEF_NAME} typedef:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  The ${TYPEDEF_NAME} typedef (${TYPEDEF_PATH}) is the seam's\n` +
        `  one home: every member it declares is implemented by each concrete adapter\n` +
        `  (${ADAPTER_PATHS}),\n` +
        `  and every member all of them implement is declared there (§${SC_CLAUSE_ID}). Close\n` +
        `  the gap the way the change intends: implement the member in the adapter that\n` +
        `  lacks it, drop the @property once the seam no longer requires it, or declare\n` +
        `  the @property the adapters already agree on. A member only some platforms'\n` +
        `  callers need belongs in those platforms' own adapter files, under the admission\n` +
        `  rule the adapter file's header states.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ adapter surface consistent: ${memberCount} ${TYPEDEF_NAME} members are implemented ` +
      `by each of the ${ADAPTERS.length} concrete adapters (${ADAPTER_PATHS}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
