/**
 * check-extension-surface.js — admission test for the extension's two
 * committed surface contracts:
 *
 *   - the permission surface
 *     (docs/architecture/application/extension/permissions.md §EPM-1): the
 *     manifest's `permissions` and `host_permissions` arrays must equal, in
 *     both directions, the backticked names in that doc's Permissions and
 *     Host permissions tables;
 *   - the message surface
 *     (docs/architecture/application/extension/runtime.md §ERT-4): the worker
 *     dispatcher's `switch (msg.type)` case labels must equal the panel
 *     protocol's closed type set, the panel's own literal sends must equal
 *     that same set, and the module's `message.type` equality literals must
 *     equal the capture-path table's types — all read through a comment-safe
 *     tokenizer, each diffed in both directions, with the two doc
 *     enumerations disjoint.
 *
 * The clause's own sender statement is held present beside those sets: ERT-4's
 * scope carries the existence claim the send leg enforces
 * ({@link SENDER_STATEMENT_ANCHOR}) exactly once, so the leg can never go on
 * enforcing a rule the document has stopped making, and an update can never
 * land on one copy of it while another stands — anywhere in the clause, a
 * paragraph of its own or the one the claim already sits in.
 *
 * The sender side reads one shape: a `send(` call whose first argument OPENS
 * an object literal. That literal's TOP-LEVEL properties are then read for a
 * `type` key — bare or quoted, in any position, since property order is not
 * meaning — carrying a lone string literal; a send with no such property is
 * refused by name, naming what the scan found in its place. The scanned
 * surface is the tracked JavaScript under `packages/extension/sidepanel`
 * (`git ls-files` over that directory, recursive, filtered to `.js`).
 *
 * Every parsed set must be non-empty, every table cell must be readable
 * (fence-aware, refusing unreadable rows rather than skipping them), the
 * dispatcher must carry exactly one `switch (msg.type)` with a `default:`
 * arm, and the manifest read refuses every shape outside its model — a
 * document that is not a JSON object, a permission field that is not an
 * array, an entry that is not a string, and an optional-permission key in
 * any shape other than the empty array — so a broken read fails loudly
 * instead of passing vacuously.
 *
 * Each of the three type reads — the dispatcher's case labels, the module's
 * equality guards, and the panel's sends — takes a quoted string literal that
 * its own end follows: the label's colon, the punctuation that ends the
 * equality's operand, and the send property's separator or closing brace. A
 * literal any other token follows is refused by name, so a type built around
 * one is never credited with its leading piece; a template literal is refused
 * the same way, the shared tokenizer giving it a type of its own, and that
 * type is also what keeps a template out of the `type` key position — which a
 * template reaches only through the computed form, that being the one way any
 * expression stands where a key belongs in valid JavaScript. A property the
 * key reader does not read — a computed key, a spread, a shorthand — is named
 * as the shape it is, so a send stating no readable `type` says which shape
 * stood there.
 *
 * Honest limits: a dispatch route outside the tokenized shapes (a computed
 * message type, a negated or reversed-operand type test, an equality test on
 * a receiver other than `message`/`msg`) is invisible to the scan — a nested
 * dispatcher, by contrast, is refused loudly; the equality scan is
 * module-wide, not listener-scoped, and where the guards sit is review-held
 * (ERT-4's ahead-of-the-switch mechanism is stated doctrine the scan does
 * not verify — token order is not control flow); how the shared tokenizer
 * reads a regular-expression literal, with the shapes where that reading and
 * the grammar part, is stated at {@link tokenizeJs} in
 * [`check-test-inventory.js`](./check-test-inventory.js), and those shapes cost
 * this check in both directions. The pattern a literal read as division puts
 * into the stream is read as the code that text spells, so a send written
 * inside one is CREDITED as a send the panel makes, and a type the enumeration
 * does not state reds there, naming a send no source wrote. An UNBALANCED brace
 * in such a pattern also moves the dispatcher's walk, which counts braces alone
 * — a balanced pair, `/a{2,3}/` among them, moves it by nothing, and a bracket
 * or a parenthesis costs it nothing at all — and what a moved bound costs is
 * decided by where the literal stands. Standing right after the switch's own
 * opening brace it leaves every arm unread, and the check reds vacuously,
 * naming no type; standing between the arms it leaves the arms past it unread,
 * each enumerated type whose arm went unread reported as unserviced and the
 * `default:` arm no longer seen at the moved depth beside them; standing past
 * every arm it leaves the labels read and carries the walk on, where a later
 * `switch` word falling inside the moved bound reds at the nesting anchor,
 * naming a nesting the source does not have, and where none does it passes
 * green. Past an UNMATCHED quote written in such a pattern the stream stays out
 * of step to the end of that file, and a send site
 * standing beyond such a quote, or inside what a division read as a literal
 * takes out of the stream (at most the rest of its own line), is simply not
 * seen. The default arm
 * is presence-checked only (the envelope it answers is ERT-2's own
 * verification). The panel table's sender-side claim is held over the
 * literal-send subset the scan reads, and carries residues of its own, each
 * named here: a send-shaped site whose first argument is anything but an
 * opening object literal is outside that subset and invisible here — the
 * function declaration, the method-shorthand declaration, the
 * receiver-qualified forward, and the call passing a payload assembled
 * beforehand are all that shape — and, in the reverse direction, an
 * enumerated type sent only through such a site reds as "never sent", a
 * misleading red the check cannot tell from a genuinely unsent type. The
 * sender statement's own presence guard holds the claim's WORDS: a faithful
 * rewording that drops them reds although the doctrine still stands, and a
 * sentence keeping them while the prose around them turns into something else
 * passes — what the statement means stays review-held, the same way the
 * tables' prose does. The
 * tables' rationale, payload, and response prose stays review-held; and the
 * manifest's resource-exposure facts (CSP absence, empty
 * `web_accessible_resources`) stay judgment-held with their doc bullets.
 *
 * Usage:
 *   node scripts/check-extension-surface.js  # or: npm run lint:extension-surface
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  backtickedName,
  duplicatesIn,
  emptySurfaceProblems,
  extractClauseSection,
  flattenWhitespace,
  formatProblemBlock,
  missingFrom,
  readLoneStringLiteral,
  readTableColumn,
  selectTablesByHeader,
  tokenizeJs,
  trackedFilesUnder,
  walkObjectLiteral,
} from './check-test-inventory.js';

/** Repo-relative path of the extension manifest. */
export const MANIFEST_PATH = 'packages/extension/manifest.json';
/** Repo-relative path of the permissions doc whose tables state EPM-1. */
export const PERMISSIONS_DOC_PATH = 'docs/architecture/application/extension/permissions.md';
/** Repo-relative path of the runtime doc whose enumerations state ERT-4. */
export const RUNTIME_DOC_PATH = 'docs/architecture/application/extension/runtime.md';
/** Repo-relative path of the service worker carrying the dispatcher. */
export const WORKER_PATH = 'packages/extension/background/service-worker.js';
/** Repo-relative directory of the panel JavaScript the send scan reads. */
export const PANEL_DIR = 'packages/extension/sidepanel';
/** The permission-surface clause the manifest legs verify. */
export const EPM_CLAUSE_ID = 'EPM-1';
/** The message-surface clause the dispatcher legs verify. */
export const ERT_CLAUSE_ID = 'ERT-4';
/** The `##` section of the runtime doc carrying both protocol tables. */
export const PROTOCOL_SECTION = 'Message protocol';
/** The capture-path table's whole header in that section. */
export const CAPTURE_TABLE_HEADER = ['Type', 'Payload', 'Response'];
/** The panel-protocol table's whole header in that section. */
export const PANEL_TABLE_HEADER = ['Group', 'Types'];
/** The permission tables' whole headers, each with the `##` section it sits in. */
export const PERMISSION_TABLES = [
  ['Permissions', ['Permission', 'What Docent does with it']],
  ['Host permissions', ['Host permission', 'What Docent does with it']],
];

/**
 * The punctuation that ends an equality's right-hand operand, which is the
 * proof that the type literal was the whole of it: a closing bracket of any
 * kind, a statement or argument separator, a conditional's own punctuation, or
 * the first character of `&&` / `||` (the tokenizer emits each as two). A
 * literal any other token follows — `+` building a name, `.` calling a method
 * on it — is refused, never credited with its leading piece.
 */
const EQUALITY_OPERAND_END = ')]};,?:&|';
/** The punctuation that ends a case label: the label's own colon, nothing else. */
const CASE_LABEL_END = ':';

/**
 * The words the clause's sender statement makes its existence claim in — the
 * doctrine the send leg holds, quoted from the clause rather than paraphrased,
 * so the phrase has one home and the suite reads it from here.
 */
export const SENDER_STATEMENT_ANCHOR = 'has at least one send written as an object literal';

/**
 * Count how many times the clause's own scope states the sender statement.
 * The clause section is fence-aware (so a fenced illustration cannot stand in
 * for the doctrine) and bounded at the clause's marker, so a statement that
 * drifts out of the clause counts as gone; the whole scope is
 * whitespace-flattened before the anchor is sought, so the anchor is found
 * whatever line the prose wraps on.
 *
 * Occurrences, not paragraphs: a second copy of the claim is a second copy an
 * update can land beside whether or not a blank line separates the two, so
 * the count the one-statement rule is read from cannot depend on where the
 * copy was pasted.
 * @param {string} runtimeText the runtime doc's text
 * @returns {number} occurrences of the anchor in the clause's scope
 */
export function countSenderStatements(runtimeText) {
  const scope = flattenWhitespace(extractClauseSection(runtimeText, ERT_CLAUSE_ID));
  return scope.split(SENDER_STATEMENT_ANCHOR).length - 1;
}

/**
 * Read the manifest's permission surface. Entries that are not strings are
 * refused, never skipped.
 * @param {string} manifestJson manifest.json source
 * @returns {{ permissions: string[], hostPermissions: string[], problems: string[] }}
 */
export function extractManifestSurface(manifestJson) {
  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return { permissions: [], hostPermissions: [], problems: [`${MANIFEST_PATH} does not parse as JSON`] }; // prettier-ignore
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { permissions: [], hostPermissions: [], problems: [`${MANIFEST_PATH} parses as JSON but not as an object — the permission read cannot run`] }; // prettier-ignore
  }
  const readArray = (field) => {
    const out = [];
    const raw = field in parsed ? parsed[field] : [];
    if (!Array.isArray(raw)) {
      problems.push(`${MANIFEST_PATH} carries a ${field} that is not an array (${JSON.stringify(raw)}) — the read cannot run`); // prettier-ignore
      return out;
    }
    for (const entry of raw) {
      if (typeof entry === 'string') {
        out.push(entry);
      } else {
        problems.push(`${MANIFEST_PATH} carries a ${field} entry the scan cannot read (${JSON.stringify(entry)})`); // prettier-ignore
      }
    }
    return out;
  };
  for (const field of ['optional_permissions', 'optional_host_permissions']) {
    if (field in parsed && !(Array.isArray(parsed[field]) && parsed[field].length === 0)) {
      problems.push(`${MANIFEST_PATH} declares ${field}, which the permission tables do not model — extend the doc and this check together, drop the key, or set it to the empty array`); // prettier-ignore
    }
  }
  return {
    permissions: readArray('permissions'),
    hostPermissions: readArray('host_permissions'),
    problems,
  };
}

/**
 * Read the first-column backticked names of every table in a named `##`
 * section of a doc carrying an exact header (fence-aware through the shared
 * table parser). A table is selected by its section AND its WHOLE header, so a
 * sibling table under the same heading is never conscripted into the closed
 * set by sharing a column name. A body row whose first cell is not a lone
 * backticked name is returned as unreadable, so no row is skipped silently.
 * @param {string} docText the doc's text
 * @param {string} section the `##` section title the table lives under
 * @param {string[]} header the table's whole header
 * @returns {{ names: string[], unreadable: string[] }}
 */
export function extractSectionTableNames(docText, section, header) {
  const { tables } = selectTablesByHeader(docText, { section, header });
  return readTableColumn(tables, { empty: '(empty first cell)' });
}

/**
 * Read the runtime doc's two protocol enumerations from the Message protocol
 * section: the capture-path table (first header cell `Type`, first-column
 * names via the shared reader) and the panel-protocol table (first header
 * cell `Group`, whose Types cells are comma-separated backticked tokens).
 * Any piece that is not a lone backticked token is unreadable, never
 * skipped.
 * @param {string} runtimeText the runtime doc's text
 * @returns {{ captureTypes: string[], panelTypes: string[], unreadable: string[] }}
 */
export function extractProtocolTables(runtimeText) {
  const capture = extractSectionTableNames(runtimeText, PROTOCOL_SECTION, CAPTURE_TABLE_HEADER);
  const panelTypes = [];
  const unreadable = [...capture.unreadable];
  const panel = selectTablesByHeader(runtimeText, {
    section: PROTOCOL_SECTION,
    header: PANEL_TABLE_HEADER,
  });
  for (const table of panel.tables) {
    for (const row of table.rows) {
      for (const piece of (row[1] ?? '').split(',')) {
        const token = piece.trim();
        const name = backtickedName(token);
        if (name !== null) panelTypes.push(name);
        else unreadable.push(token === '' ? '(empty Types piece)' : token);
      }
    }
  }
  return { captureTypes: capture.names, panelTypes, unreadable };
}

/**
 * Read the worker dispatcher's serviced surface through the shared
 * comment-safe tokenizer: the case labels anywhere in the body of the one
 * `switch ((msg|message).type)` (bounded by brace depth, so labels after the
 * `default:` arm still count and a sibling switch elsewhere is never
 * misread), and the `message.type === '…'` (or `msg.type`) equality literals
 * anywhere in the module — deduplicated, since guarding one type twice is
 * legal; where in the module they sit is review-held (token order is not
 * control flow, so a position rule would red legal declaration moves).
 * Anchor failures — no dispatcher switch, more than one, a missing
 * `default:` arm, a nested switch — are problems of this extractor, so they
 * fire even when other surfaces parse empty.
 * @param {string} workerSource service-worker.js source
 * @returns {{ caseLabels: string[], equalityTypes: string[], problems: string[] }}
 */
export function extractDispatcherSurface(workerSource) {
  const tokens = tokenizeJs(workerSource);
  const problems = [];
  const caseLabels = [];
  const equalityHits = [];
  const at = (i, type, value) => tokens[i] && tokens[i].type === type && tokens[i].value === value;
  const isReceiver = (i) =>
    tokens[i] && tokens[i].type === 'word' && (tokens[i].value === 'msg' || tokens[i].value === 'message'); // prettier-ignore

  const switchHeads = [];
  for (let i = 0; i + 5 < tokens.length; i++) {
    if (
      at(i, 'word', 'switch') &&
      at(i + 1, 'punct', '(') &&
      isReceiver(i + 2) &&
      at(i + 3, 'punct', '.') &&
      at(i + 4, 'word', 'type') &&
      at(i + 5, 'punct', ')')
    ) {
      switchHeads.push(i);
    }
    if (
      isReceiver(i) &&
      at(i + 1, 'punct', '.') &&
      at(i + 2, 'word', 'type') &&
      at(i + 3, 'punct', '=') &&
      at(i + 4, 'punct', '=') &&
      at(i + 5, 'punct', '=')
    ) {
      // The literal is the whole operand, which the punctuation ending the
      // operand is what establishes: `'CAPTURE_START' + suffix` tokenizes as a
      // string first, so reading the string alone would credit the doc's type
      // to a guard that tests another one.
      const read = readLoneStringLiteral(tokens, i + 6, EQUALITY_OPERAND_END);
      if (read.lone) equalityHits.push(read.value);
      else if (read.kind === 'template') {
        problems.push(`${WORKER_PATH} guards a message type with a template literal (\`${read.token}\`) — the scan reads a quoted string literal standing alone as the operand, so the capture-path closure stays checkable`); // prettier-ignore
      } else if (read.kind === 'regex') {
        problems.push(`${WORKER_PATH} guards a message type with a regular-expression literal (\`${read.token}\`) — the scan reads a quoted string literal standing alone as the operand, so the capture-path closure stays checkable`); // prettier-ignore
      } else if (read.isString) {
        problems.push(`${WORKER_PATH} guards a message type with \`${read.token}\` followed by \`${read.follower ?? 'end of source'}\` — the scan reads a quoted string literal standing alone as the operand, so the capture-path closure stays checkable`); // prettier-ignore
      }
    }
  }

  const equalityTypes = [...new Set(equalityHits)];

  if (switchHeads.length !== 1) {
    problems.push(`${WORKER_PATH} carries ${switchHeads.length} dispatcher switches over the message type — the scan models exactly one`); // prettier-ignore
    return { caseLabels, equalityTypes, problems };
  }

  let hasDefault = false;
  let i = switchHeads[0] + 6;
  if (!at(i, 'punct', '{')) {
    problems.push(`${WORKER_PATH}'s dispatcher switch has no readable body — the case-label scan cannot run`); // prettier-ignore
    return { caseLabels, equalityTypes, problems };
  }
  let depth = 1;
  for (i += 1; i < tokens.length && depth > 0; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '{') depth++;
    else if (t.type === 'punct' && t.value === '}') depth--;
    else if (at(i, 'word', 'switch')) {
      problems.push(`${WORKER_PATH} nests a switch inside the dispatcher's — the case-label scan models exactly one level`); // prettier-ignore
      return { caseLabels, equalityTypes, problems };
    } else if (depth === 1 && at(i, 'word', 'case')) {
      // The label is the whole label, which its own colon is what establishes:
      // `case 'PROJECTS_LIST' + k:` tokenizes as a string first, so reading the
      // string alone would credit the enumeration's type to an arm that
      // services another one.
      const read = readLoneStringLiteral(tokens, i + 1, CASE_LABEL_END);
      if (read.lone) {
        caseLabels.push(read.value);
        i += 2;
      } else if (read.kind === 'template') {
        problems.push(`${WORKER_PATH}'s dispatcher switch labels an arm with a template literal (\`${read.token}\`) — the scan reads a quoted string literal the label's own colon follows, so the panel-protocol closure stays checkable`); // prettier-ignore
      } else if (read.kind === 'regex') {
        problems.push(`${WORKER_PATH}'s dispatcher switch labels an arm with a regular-expression literal (\`${read.token}\`) — the scan reads a quoted string literal the label's own colon follows, so the panel-protocol closure stays checkable`); // prettier-ignore
      } else if (read.isString) {
        problems.push(`${WORKER_PATH}'s dispatcher switch labels an arm \`${read.token}\` followed by \`${read.follower ?? 'end of source'}\` — the scan reads a quoted string literal the label's own colon follows, so the panel-protocol closure stays checkable`); // prettier-ignore
      }
    } else if (depth === 1 && at(i, 'word', 'default') && at(i + 1, 'punct', ':')) {
      hasDefault = true;
    }
  }
  if (!hasDefault) {
    problems.push(`the dispatcher switch has no default: arm — ${ERT_CLAUSE_ID} promises the error envelope for a type outside the enumerations`); // prettier-ignore
  }
  return { caseLabels, equalityTypes, problems };
}

/**
 * How a token standing where a top-level key belongs is named when the key
 * reader does not read it: by the property shape it opens, so the diagnosis
 * states the send's actual shape rather than a missing property. A bare or
 * quoted name with no colon after it is the shorthand form, and naming the
 * name is what makes that case self-explaining. A literal the key reader does
 * not read is named by its kind, with what the source wrote beside it — a
 * template's leading run of literal text, a regular expression's literal as
 * written.
 * @param {{ type: string, value: string }} token the token at the property start
 * @returns {string}
 */
function describeKeyPosition(token) {
  if (token.type === 'punct' && token.value === '[') return 'a computed key';
  if (token.type === 'punct' && token.value === '.') return 'a spread';
  if (token.type === 'template') return `a template literal (\`${token.value}\`)`;
  if (token.type === 'regex') return `a regular-expression literal (\`${token.value}\`)`;
  if (token.type === 'word' || token.type === 'string') {
    return `\`${token.value}\`, which no colon follows`;
  }
  return `\`${token.value}\` where a key belongs`;
}

/**
 * Read one object literal's top-level `type` property, starting at the `{`
 * token that opens it. The walk is bounded by brace depth — the technique the
 * dispatcher scan uses — so a nested payload's own `type` is never read as the
 * message's, and a property is recognized where a property can start: right
 * after the opening brace and after each top-level comma. The key may be bare
 * (`type:`) or quoted (`'type':`), and its value must be a LONE string literal
 * — the token after it is the property separator or the literal's closing
 * brace, so a concatenation is refused rather than credited with its leading
 * piece, and a template literal is named as a template rather than as its
 * leading run of text.
 * A property the key reader does not read is NAMED rather than dropped: a
 * computed key, a spread, and a shorthand property each stand where a key
 * belongs, so the diagnosis states what was there instead of reporting a
 * literal with no properties at all — a cause such a send does not have.
 * @param {{ type: string, value: string }[]} tokens the file's tokens
 * @param {number} open index of the literal's opening `{`
 * @returns {{ type: string | null, found: string | null }} the type, or what
 *   the scan found in its place (`found` is null exactly when a type was read)
 */
function readSendType(tokens, open) {
  const properties = [];
  let typeAt = -1;
  // The walk is the shared skeleton; what a property IS is this check's own
  // policy, which reads a key name where the shape states one and names the
  // position otherwise.
  const { closed } = walkObjectLiteral(tokens, open, (i, t) => {
    const isKey =
      (t.type === 'word' || t.type === 'string') &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === ':';
    if (!isKey) {
      properties.push(describeKeyPosition(t));
      return;
    }
    properties.push(`\`${t.value}\``);
    if (t.value === 'type') typeAt = i;
  });
  if (typeAt === -1) {
    if (!closed) return { type: null, found: '(end of source)' };
    return {
      type: null,
      // The list holds read key names and named shapes alike, so it is
      // bracketed: `properties a computed key` would read as a garden path
      // where `properties (a computed key)` reads as the list it is.
      found: properties.length
        ? `no \`type\` key among the top-level properties (${properties.join(', ')})`
        : 'no top-level properties at all',
    };
  }
  const read = readLoneStringLiteral(tokens, typeAt + 2, ',}');
  if (read.token === null || read.follower === null)
    return { type: null, found: '(end of source)' };
  // A template literal is named by its kind: its token value is a run of its
  // literal text, so naming the token alone would state a type the send never
  // writes — and an interpolated one, a type no enumeration can ever carry.
  if (read.kind === 'template') {
    return { type: null, found: `a \`type\` key set from a template literal (\`${read.token}\`)` };
  }
  if (!read.isString) return { type: null, found: `a \`type\` key set from \`${read.token}\`` };
  if (!read.lone) {
    return { type: null, found: `a \`type\` key set from \`${read.token}\` followed by \`${read.follower}\`` }; // prettier-ignore
  }
  return { type: read.value, found: null };
}

/**
 * Read the panel's literal send sites through the shared comment-safe
 * tokenizer. The scan reads ONE shape — a `send(` call whose first argument
 * opens an object literal — and reads that literal's top-level properties for
 * the `type` the message states, refusing by name the send that states none,
 * so a restructured payload cannot pass as a partially-read send. Property
 * order carries no meaning and the scan reads none into it. A send-shaped site
 * whose first argument is not an opening brace is outside the shape the scan
 * reads and contributes nothing: the declaration forms, the receiver-qualified
 * forward, and the call passing a variable assembled beforehand all sit there,
 * and the reverse-direction diff's limit is exactly that residue.
 * @param {Map<string, string>} sourceByPath path → panel JavaScript source
 * @returns {{ path: string, ordinal: number, type: string | null, found: string | null }[]}
 *   one entry per object-literal send, numbered per file in source order
 */
export function extractSendSites(sourceByPath) {
  const sites = [];
  for (const [path, source] of sourceByPath) {
    const tokens = tokenizeJs(source);
    let ordinal = 0;
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].type !== 'word' || tokens[i].value !== 'send') continue;
      if (tokens[i + 1].type !== 'punct' || tokens[i + 1].value !== '(') continue;
      if (tokens[i + 2].type !== 'punct' || tokens[i + 2].value !== '{') continue;
      ordinal += 1;
      sites.push({ path, ordinal, ...readSendType(tokens, i + 2) });
    }
  }
  return sites;
}

/**
 * How a send site is named in the check's output: its file and its position
 * among that file's object-literal sends — the only sends the ordinal counts —
 * comments excluded.
 * @param {{ path: string, ordinal: number }} site
 * @returns {string}
 */
function sendLabel(site) {
  return `${site.path} (object-literal send( call site ${site.ordinal})`;
}

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this
 * list — a leg added here is exercised automatically, and the suite holds
 * the list non-empty and its diagnoses distinct.
 */
export const EMPTY_SURFACES = [
  ['manifestPermissions', `no permissions found in ${MANIFEST_PATH}`],
  ['manifestHostPermissions', `no host_permissions found in ${MANIFEST_PATH}`],
  ['docPermissions', `no Permissions table names found in ${PERMISSIONS_DOC_PATH}`],
  ['docHostPermissions', `no Host permissions table names found in ${PERMISSIONS_DOC_PATH}`],
  ['docCaptureTypes', `no capture-path types found in ${RUNTIME_DOC_PATH}`],
  ['docPanelTypes', `no panel-protocol types found in ${RUNTIME_DOC_PATH}`],
  ['caseLabels', `no case labels found in the dispatcher switch (${WORKER_PATH})`],
  ['equalityTypes', `no message-type equality literals found in ${WORKER_PATH}`],
  ['sendTypes', `no object-literal send( call site naming a type found in the tracked ${PANEL_DIR} JavaScript`], // prettier-ignore
];

/**
 * The duplicates guard's legs — drift signal on the doc surfaces and on case
 * labels (a repeated label is unreachable code); equality guards and send
 * types are exempt: testing or sending one type twice is legal code shape.
 * The equality types arrive deduplicated from their extractor; the send types
 * are deduplicated in `auditTree`, whose set the diffs run over, while the
 * extractor keeps every site so a refusal can name one. Exported for the
 * suite's generated family plus the fixture-key equality lock its
 * hand-written fixtures need.
 */
export const DUPLICATE_SURFACES = [
  ['manifestPermissions', `the manifest's permissions`],
  ['manifestHostPermissions', `the manifest's host_permissions`],
  ['docPermissions', `the Permissions table`],
  ['docHostPermissions', `the Host permissions table`],
  ['docCaptureTypes', `the capture-path table`],
  ['docPanelTypes', `the panel-protocol enumeration`],
  ['caseLabels', `the dispatcher's case labels`],
];

/**
 * Pure core: evaluate both extension surface contracts.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.manifestPermissions manifest `permissions` entries
 * @param {string[]} s.manifestHostPermissions manifest `host_permissions` entries
 * @param {string[]} s.docPermissions the permissions doc's Permissions table names
 * @param {string[]} s.docHostPermissions its Host permissions table names
 * @param {string[]} s.permissionsUnreadable unreadable permission-table cells
 * @param {string[]} s.docCaptureTypes the runtime doc's capture-path types
 * @param {string[]} s.docPanelTypes the runtime doc's panel-protocol types
 * @param {string[]} s.protocolUnreadable unreadable protocol cells/pieces
 * @param {string[]} s.caseLabels the dispatcher switch's case labels
 * @param {string[]} s.equalityTypes the worker module's equality-literal types
 * @param {string[]} s.sendTypes the panel's literal send types, deduplicated
 * @param {{ path: string, ordinal: number, type: string | null, found: string | null }[]} s.sendSites every object-literal send site, readable or not
 * @param {number} s.senderStatements times the clause's scope states its sender statement
 * @returns {string[]} problems; empty when both contracts hold (the
 *   dispatcher anchor guards — switch count, the default arm, nesting — are
 *   the extractor's own problems and are reported beside these)
 */
export function evaluateExtensionSurface(s) {
  const problems = [];

  // Unreadable cells are reported ahead of the vacuous guards: the likeliest
  // cause of an empty table parse is rows that stopped being readable, so the
  // most useful line must survive the early return.
  for (const cell of s.permissionsUnreadable) {
    problems.push(`${PERMISSIONS_DOC_PATH} carries a first cell the scan cannot read — ${cell} — rows are \`name\`, nothing else`); // prettier-ignore
  }
  for (const cell of s.protocolUnreadable) {
    problems.push(`${RUNTIME_DOC_PATH} carries a protocol cell the scan cannot read — ${cell} — types are lone backticked names`); // prettier-ignore
  }
  for (const site of s.sendSites.filter((x) => x.type === null)) {
    problems.push(`${sendLabel(site)} states no readable message type — the scan found ${site.found} — an object-literal send carries its type as a string literal in a top-level \`type\` property, in any position, so the sender side stays readable`); // prettier-ignore
  }

  // The sender statement is the doctrine the send leg holds, so it is read
  // ahead of the vacuous return: a doc edit that broke the tables and took the
  // statement with it must say both things. Written fail-closed — a surface
  // that states no count is a surface that proved nothing.
  if (!(s.senderStatements >= 1)) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} states no sender statement — nothing in the clause's scope carries "${SENDER_STATEMENT_ANCHOR}" — the panel-side closure this check's send leg holds (every panel-protocol type carrying at least one object-literal send( that names it) is doctrine the clause states, and the leg cannot hold a rule the document no longer makes`); // prettier-ignore
  } else if (s.senderStatements > 1) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} makes the "${SENDER_STATEMENT_ANCHOR}" claim ${s.senderStatements} times — the clause states it once, so an update cannot land on one copy and leave another standing, wherever in the clause that copy was written`); // prettier-ignore
  }

  const empty = emptySurfaceProblems(s, EMPTY_SURFACES);
  if (empty.length > 0) {
    problems.push(...empty);
    return problems; // empty parses make set diffs meaningless
  }

  for (const [key, what] of DUPLICATE_SURFACES) {
    problems.push(...duplicatesIn(s[key], what));
  }

  problems.push(
    ...missingFrom(s.manifestPermissions, s.docPermissions, `is requested in ${MANIFEST_PATH} but the Permissions table does not document it (${EPM_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.docPermissions, s.manifestPermissions, `is documented in the Permissions table but ${MANIFEST_PATH} does not request it`), // prettier-ignore
    ...missingFrom(s.manifestHostPermissions, s.docHostPermissions, `is requested in ${MANIFEST_PATH} but the Host permissions table does not document it (${EPM_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.docHostPermissions, s.manifestHostPermissions, `is documented in the Host permissions table but ${MANIFEST_PATH} does not request it`), // prettier-ignore
    ...missingFrom(s.docPanelTypes, s.caseLabels, `is in the panel-protocol enumeration but the dispatcher switch has no case servicing it (${ERT_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.caseLabels, s.docPanelTypes, `is serviced by the dispatcher switch but the panel-protocol enumeration does not state it`), // prettier-ignore
    ...missingFrom(s.docCaptureTypes, s.equalityTypes, `is in the capture-path table but no equality guard in the worker module services it (${ERT_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.equalityTypes, s.docCaptureTypes, `is serviced by an equality guard in the worker module but the capture-path table does not state it`), // prettier-ignore
    ...missingFrom(s.sendTypes, s.docPanelTypes, `is sent by the panel but the panel-protocol enumeration does not state it (${ERT_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.docPanelTypes, s.sendTypes, `is in the panel-protocol enumeration but no object-literal send( in the tracked ${PANEL_DIR} JavaScript sends it (${ERT_CLAUSE_ID}) — a type sent only through a payload assembled beforehand is invisible to this leg and reds here too, which this direction cannot tell from a type nothing sends: moving a send outside the object-literal shape is a change that updates the runtime doc's sender statement and this check together`), // prettier-ignore
  );

  const overlap = s.docCaptureTypes.filter((t) => s.docPanelTypes.includes(t));
  for (const t of overlap) {
    problems.push(`\`${t}\` appears in both the capture-path table and the panel-protocol enumeration — the two are disjoint by ${ERT_CLAUSE_ID}`); // prettier-ignore
  }

  return problems;
}

/**
 * Read every surface from the working tree and evaluate both contracts.
 * @param {(f: string) => string} readFile repo-relative content reader
 * @param {string[]} panelFiles the tracked panel JavaScript paths the send
 *   scan reads
 * @returns {{ problems: string[], permissionCount: number, typeCount: number, panelTypeCount: number }}
 *   `typeCount` is the doc's whole message-type union — the surface the
 *   dispatcher legs cover — and `panelTypeCount` the panel-protocol subset the
 *   sender leg covers
 */
export function auditTree(readFile, panelFiles) {
  const manifest = extractManifestSurface(readFile(MANIFEST_PATH));
  const permDoc = readFile(PERMISSIONS_DOC_PATH);
  const [permissions, hostPermissions] = PERMISSION_TABLES.map(([section, header]) =>
    extractSectionTableNames(permDoc, section, header),
  );
  const runtimeDoc = readFile(RUNTIME_DOC_PATH);
  const protocol = extractProtocolTables(runtimeDoc);
  const dispatcher = extractDispatcherSurface(readFile(WORKER_PATH));
  const sendSites = extractSendSites(new Map(panelFiles.map((p) => [p, readFile(p)])));

  const s = {
    manifestPermissions: manifest.permissions,
    manifestHostPermissions: manifest.hostPermissions,
    docPermissions: permissions.names,
    docHostPermissions: hostPermissions.names,
    permissionsUnreadable: [...permissions.unreadable, ...hostPermissions.unreadable],
    docCaptureTypes: protocol.captureTypes,
    docPanelTypes: protocol.panelTypes,
    protocolUnreadable: protocol.unreadable,
    caseLabels: dispatcher.caseLabels,
    equalityTypes: dispatcher.equalityTypes,
    sendTypes: [...new Set(sendSites.filter((x) => x.type !== null).map((x) => x.type))],
    sendSites,
    senderStatements: countSenderStatements(runtimeDoc),
  };
  return {
    problems: [...manifest.problems, ...dispatcher.problems, ...evaluateExtensionSurface(s)],
    permissionCount: new Set([...s.manifestPermissions, ...s.manifestHostPermissions]).size,
    typeCount: new Set([...s.docCaptureTypes, ...s.docPanelTypes]).size,
    panelTypeCount: new Set(s.docPanelTypes).size,
  };
}

/* c8 ignore start — the CLI wrapper reads the tree and formats the pass/fail
   output; the pure extraction and evaluation core above is unit-tested. */
function run() {
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return ''; // an unreadable surface fails the non-empty guards loudly
    }
  };
  const panelFiles = trackedFilesUnder(PANEL_DIR, { extensions: ['.js'] });
  const { problems, permissionCount, typeCount, panelTypeCount } = auditTree(readFile, panelFiles);

  if (problems.length) {
    console.error(
      formatProblemBlock(
        'the extension surface drifted from its committed contracts',
        problems,
        `  The manifest's permission surface and the Permissions / Host permissions tables\n` +
          `  must state the same sets (${PERMISSIONS_DOC_PATH} §${EPM_CLAUSE_ID}); the dispatcher's\n` +
          `  serviced message types, the panel's literal sends, and the runtime doc's\n` +
          `  capture-path and panel-protocol enumerations must state the same sets\n` +
          `  (${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID}).\n` +
          `  Update the drifted surfaces together in the same change.\n`,
      ),
    );
    process.exit(1);
  }
  console.log(
    `✓ extension surface consistent: ${permissionCount} permissions match the doc tables; ` +
      `${typeCount} message types agree between the runtime doc and the worker dispatcher, ` +
      `and its ${panelTypeCount} panel-protocol types agree with the panel's literal sends, ` +
      `whose closure the clause's own scope states once.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
