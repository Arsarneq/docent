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
 * Honest limits: a dispatch route outside the tokenized shapes (a computed
 * message type, a negated or reversed-operand type test, an equality test on
 * a receiver other than `message`/`msg`) is invisible to the scan — a nested
 * dispatcher, by contrast, is refused loudly; the equality scan is
 * module-wide, not listener-scoped, and where the guards sit is review-held
 * (ERT-4's ahead-of-the-switch mechanism is stated doctrine the scan does
 * not verify — token order is not control flow); a regular-expression literal
 * carrying a brace inside the dispatcher body corrupts the depth bound and
 * reds with a misleading diagnosis (loud, never green), while the same
 * unmodelled class costs the whole-file send scan silently: a quote inside a
 * regular-expression literal desynchronizes the token stream for the rest of
 * that file, and the send sites past it are simply not seen; the default arm
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
 * tables' rationale, payload, and response prose stays review-held; and the
 * manifest's resource-exposure facts (CSP absence, empty
 * `web_accessible_resources`) stay judgment-held with their doc bullets.
 *
 * Usage:
 *   node scripts/check-extension-surface.js  # or: npm run lint:extension-surface
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  backtickedName,
  duplicatesIn,
  missingFrom,
  parseTables,
  tokenizeJs,
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
/** The capture-path table's first header cell in that section. */
export const CAPTURE_TABLE_HEADER = 'Type';
/** The panel-protocol table's first header cell in that section. */
export const PANEL_TABLE_HEADER = 'Group';

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
 * Read the first-column backticked names of every matching table in a named
 * `##` section of a doc (fence-aware through the shared table parser). A
 * table is selected by its section AND its first header cell — the house
 * pattern — so a future sibling table under the same heading is never
 * conscripted into the closed set. A body row whose first cell is not a lone
 * backticked name is returned as unreadable, so no row is skipped silently.
 * @param {string} docText the doc's text
 * @param {string} section the `##` section title the table lives under
 * @param {string} headerCell the table's first header cell
 * @returns {{ names: string[], unreadable: string[] }}
 */
export function extractSectionTableNames(docText, section, headerCell) {
  const names = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== section || (table.header[0] ?? '').trim() !== headerCell) continue;
    for (const row of table.rows) {
      const cell = (row[0] ?? '').trim();
      const name = backtickedName(cell);
      if (name !== null) names.push(name);
      else unreadable.push(cell === '' ? '(empty first cell)' : cell);
    }
  }
  return { names, unreadable };
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
  for (const table of parseTables(runtimeText)) {
    if (table.section !== PROTOCOL_SECTION) continue;
    if ((table.header[0] ?? '').trim() !== PANEL_TABLE_HEADER) continue;
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
      at(i + 5, 'punct', '=') &&
      tokens[i + 6]?.type === 'string'
    ) {
      equalityHits.push(tokens[i + 6].value);
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
    } else if (
      depth === 1 &&
      at(i, 'word', 'case') &&
      tokens[i + 1]?.type === 'string' &&
      at(i + 2, 'punct', ':')
    ) {
      caseLabels.push(tokens[i + 1].value);
      i += 2;
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
 * Read one object literal's top-level `type` property, starting at the `{`
 * token that opens it. The walk is bounded by brace depth — the technique the
 * dispatcher scan uses — so a nested payload's own `type` is never read as the
 * message's, and a property is recognized where a property can start: right
 * after the opening brace and after each top-level comma. The key may be bare
 * (`type:`) or quoted (`'type':`), and its value must be a LONE string literal
 * — the token after it is the property separator or the literal's closing
 * brace, so a concatenation is refused rather than credited with its leading
 * piece.
 * @param {{ type: string, value: string }[]} tokens the file's tokens
 * @param {number} open index of the literal's opening `{`
 * @returns {{ type: string | null, found: string | null }} the type, or what
 *   the scan found in its place (`found` is null exactly when a type was read)
 */
function readSendType(tokens, open) {
  const keys = [];
  let depth = 1;
  let atPropertyStart = true;
  let typeAt = -1;
  let closed = false;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && '([{'.includes(t.value)) {
      depth++;
      atPropertyStart = false;
    } else if (t.type === 'punct' && ')]}'.includes(t.value)) {
      depth--;
      if (depth === 0) {
        closed = true;
        break;
      }
    } else if (depth === 1 && t.type === 'punct' && t.value === ',') {
      atPropertyStart = true;
    } else if (
      depth === 1 &&
      atPropertyStart &&
      (t.type === 'word' || t.type === 'string') &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === ':'
    ) {
      keys.push(t.value);
      if (t.value === 'type') typeAt = i;
      atPropertyStart = false;
    } else {
      atPropertyStart = false;
    }
  }
  if (typeAt === -1) {
    if (!closed) return { type: null, found: '(end of source)' };
    return {
      type: null,
      found: keys.length
        ? `no \`type\` key among the top-level properties ${keys.map((k) => `\`${k}\``).join(', ')}`
        : 'no top-level properties at all',
    };
  }
  const value = tokens[typeAt + 2];
  const follower = tokens[typeAt + 3];
  if (!value || !follower) return { type: null, found: '(end of source)' };
  if (value.type !== 'string') return { type: null, found: `a \`type\` key set from \`${value.value}\`` }; // prettier-ignore
  if (follower.type !== 'punct' || (follower.value !== ',' && follower.value !== '}')) {
    return { type: null, found: `a \`type\` key set from \`${value.value}\` followed by \`${follower.value}\`` }; // prettier-ignore
  }
  return { type: value.value, found: null };
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

  let vacuous = false;
  for (const [key, message] of EMPTY_SURFACES) {
    if (s[key].length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make set diffs meaningless

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
  const permissions = extractSectionTableNames(permDoc, 'Permissions', 'Permission');
  const hostPermissions = extractSectionTableNames(permDoc, 'Host permissions', 'Host permission');
  const protocol = extractProtocolTables(readFile(RUNTIME_DOC_PATH));
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
  const panelFiles = execFileSync('git', ['ls-files', PANEL_DIR], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.js'));
  const { problems, permissionCount, typeCount, panelTypeCount } = auditTree(readFile, panelFiles);

  if (problems.length) {
    console.error(
      `✗ the extension surface drifted from its committed contracts:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  The manifest's permission surface and the Permissions / Host permissions tables\n` +
        `  must state the same sets (${PERMISSIONS_DOC_PATH} §${EPM_CLAUSE_ID}); the dispatcher's\n` +
        `  serviced message types, the panel's literal sends, and the runtime doc's\n` +
        `  capture-path and panel-protocol enumerations must state the same sets\n` +
        `  (${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID}).\n` +
        `  Update the drifted surfaces together in the same change.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ extension surface consistent: ${permissionCount} permissions match the doc tables; ` +
      `${typeCount} message types agree between the runtime doc and the worker dispatcher, ` +
      `and its ${panelTypeCount} panel-protocol types agree with the panel's literal sends.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
