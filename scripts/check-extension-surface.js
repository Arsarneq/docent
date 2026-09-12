/**
 * check-extension-surface.js — admission test for the extension's committed
 * surface contracts:
 *
 *   - the permission surface
 *     (docs/architecture/application/extension/permissions.md §EPM-1): the
 *     manifest's `permissions` and `host_permissions` arrays must equal, in
 *     both directions, the backticked names in that doc's Permissions and
 *     Host permissions tables;
 *   - the message surface
 *     (docs/architecture/application/extension/runtime.md §ERT-4): the
 *     dispatcher's `switch (msg.type)` case labels must equal the panel
 *     protocol's closed type set, the panel's own literal sends must equal
 *     that same set, and the `message.type` equality literals the scanned
 *     background modules carry must equal the capture-path table's types —
 *     collected across that whole scanned set and diffed back to the table
 *     from it, diffed forward from the table to the service worker's own
 *     guards — all read through a comment-safe tokenizer, with the two doc
 *     enumerations disjoint; and, on the capture path's own sender side, the
 *     tracked JavaScript under `packages/extension/content` is read for the
 *     platform path `chrome.runtime.sendMessage`: the types those sends state
 *     must equal the capture-path table's in both directions, and each send
 *     site's own top-level payload keys must equal what that type's Payload
 *     cell states;
 *   - the worker-state introspection handle's member surface
 *     (docs/architecture/application/extension/runtime.md §ERT-5): the members
 *     the worker freezes onto its own global equal, in both directions, the
 *     backticked names in that clause's member table; every worker
 *     module-scope name a member's body reaches sits in the reach set below
 *     ({@link HANDLE_REACH_SET}) and equals, member by member and in both
 *     directions, what that member's own row states it reaches; and the
 *     handle's own name stands exactly
 *     once in the extension package's production JavaScript — the assignment
 *     itself, so no production module carries a route into the plants and
 *     wipes ERT-5 states run from no production event.
 *
 * The dispatcher legs run over a POPULATION, derived rather than listed: the
 * tracked JavaScript modules under `packages/extension/background`, which is
 * the directory the runtime doc's Components table homes the worker in. A
 * background module the extension grows is read the day it lands, with nothing
 * to update here. The population is held non-empty and required to carry the
 * service worker, whose own guards the forward capture-path diff stands on;
 * exactly one dispatcher switch stands anywhere in it, and that one switch
 * stands in the worker.
 *
 * The handle's no-production-caller leg runs over the PRODUCTION population,
 * derived the same way and IMPORTED rather than re-derived: the extension
 * package's tracked production JavaScript — the tracked `.js`, `.mjs`, and
 * `.cjs` modules under {@link PRODUCTION_POPULATION_ROOT} outside
 * {@link PRODUCTION_POPULATION_TEST_TREE} — which is the set
 * [`check-capture-surface.js`](./check-capture-surface.js) already derives for
 * its own registration closure. One population, one exclusion: the tests tree,
 * which is where the handle's observers live. The content tree is INSIDE it, so
 * a handle mention written there reds; that each extension surface runs in a
 * global scope of its own, which is what makes such a mention a defect rather
 * than a use, is doctrine the runtime doc states (§ERT-6) and never a carve-out
 * in this scan.
 *
 * The handle itself is read from one ANCHOR, tokenized whole:
 * `globalThis.__docentCaptureBookkeeping = Object.freeze({`. The assignment
 * head alone — the same target assigned an unfrozen literal — is refused by
 * name rather than read as the surface, and a second head anywhere in the
 * worker is refused too, so the members this check diffs come from one
 * statement. From the literal's opening brace the top-level property names are
 * the members, read through the shared object-literal walk: a property the key
 * reader does not read is named as the shape it is, and a literal that never
 * closes is refused rather than half-read. The reach leg is a MEMBERSHIP test
 * over each member's body: the identifiers the body names are intersected with
 * the worker's own module-scope bindings and import names, and everything in
 * that intersection is a name {@link HANDLE_REACH_SET} states — and, member by
 * member, a name that member's own Reaches cell states, the WELD the clause's
 * own closure sentence ({@link HANDLE_CLOSURE_ANCHOR}) asks for: read both
 * ways, so a member reaching a binding ANOTHER member's row names reds although
 * the whole-handle membership test passes it, and a row stating a reach its
 * member's body does not name reds beside it. The rows' own names are held to
 * the same constant, so a row can never legalize a reach the clause does not
 * place the handle over: a row's names serve as its member's allowed set
 * unfiltered, and the ROW-SIDE placement leg is what refuses a name a row
 * states outside that set — the whole-handle leg reads bodies and never sees a
 * row. A Reaches column that yields no readable cell at all is refused as its
 * own diagnosis, the surface the weld reads having gone empty. Locals,
 * parameters, and built-ins bind nothing at module scope, so they sit outside
 * the test by construction and the leg cannot red on them; what the binding
 * collector reads is stated at {@link collectModuleBindings}, with the one
 * declaration shape it refuses rather than reads past.
 *
 * The clause's own sender statement is held present beside those sets: ERT-4's
 * scope carries the existence claim the send leg enforces
 * ({@link SENDER_STATEMENT_ANCHOR}) exactly once, so the leg can never go on
 * enforcing a rule the document has stopped making, and an update can never
 * land on one copy of it while another stands — anywhere in the clause, a
 * paragraph of its own or the one the claim already sits in. The recorder's half
 * of that claim ({@link RECORDER_STATEMENT_ANCHOR}), which the forward
 * capture-path type diff holds, is held present in the same scope the same way.
 *
 * The sender side reads one shape: a call — written `(` or the optional `?.(` —
 * whose callee's own path stands whole before it and whose first argument OPENS an
 * object literal. The panel's callee is the word `send` and the capture path's is
 * the platform path `chrome.runtime.sendMessage`, read token by token. That literal's TOP-LEVEL
 * properties are then read for a `type` key — bare or quoted, in any position,
 * since property order is not meaning — carrying a lone string literal; a send
 * with no such property is refused by name, naming what the scan found in its
 * place. Beside the type, a capture-path site carries the top-level payload keys
 * its own literal states, which is what the table is welded to site by site. The
 * scanned surfaces are the tracked JavaScript under
 * `packages/extension/sidepanel` for the panel and under
 * `packages/extension/content` for the capture path (`git ls-files` over each
 * directory, recursive, filtered to `.js`).
 *
 * Every parsed set must be non-empty, every table cell must be readable
 * (code-block-aware, refusing unreadable rows rather than skipping them), the
 * scanned population must carry exactly one `switch (msg.type)`, standing in
 * the service worker and carrying a `default:` arm, and the manifest read
 * refuses every shape outside its model — a document that is not a JSON
 * object, a permission field that is not an array, an entry that is not a
 * string, and an optional-permission key in any shape other than the empty
 * array — so a broken read fails loudly instead of passing vacuously.
 *
 * The type reads — the dispatcher's case labels, the population's equality
 * guards, and the sends the panel and the recorder make, read alike under each
 * leg's own callee — each take a quoted string literal that its own end follows:
 * the label's colon, the punctuation that ends the equality's operand, and the
 * send property's separator or closing brace. A literal any other token follows
 * is refused by name, so a type built around one is never credited with its
 * leading piece; a template literal is refused
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
 * dispatcher, by contrast, is refused loudly; equality guards are COLLECTED
 * across the whole population, while the FORWARD capture-path diff is held to
 * the service worker's own guards, because ERT-4 states those types are
 * serviced by the listener's dedicated guards and the listener is the
 * worker's — a guard standing in another module is not that guard, so
 * deleting the worker's guard reds there whatever else the population carries.
 * Where inside the worker its guards sit stays review-held (ERT-4's
 * ahead-of-the-switch mechanism is stated doctrine the scan does not verify —
 * token order is not control flow), and a worker that delegates its switch or
 * its guards to a module outside the background tree carries them outside the
 * population, where this check does not read — the listener registration
 * itself is pinned across the JavaScript modules the extension package tracks
 * outside its `tests` tree by the ECP-7 admission that keys
 * `chrome.runtime.onMessage` to the service worker (the admission list in
 * [`check-capture-surface.js`](./check-capture-surface.js)), so a second
 * registration in any of those modules reds there. The dispatcher's location
 * leg holds ONE direction: it pins the file the found switch stands in to
 * {@link WORKER_PATH}, the constant whose own doc comment cites the Components
 * table that homes it, so editing that table's row alone leaves this check
 * reading its constant — the row's own sentence stays review-held. How the
 * shared tokenizer reads a regular-expression literal, with the shapes where
 * that reading and the grammar part, is stated at {@link tokenizeJs} in
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
 * seen. Every one of those readings is a reading the WHOLE population can
 * pay for: each background module is tokenized on its own, so a pattern in one
 * of them can put a `switch` head or an equality hit into that file's stream
 * that no source wrote, or take one out of it — moving the counted switch
 * total, the file a switch is attributed to, and the guards collected — while
 * the bound stays the file's own, the out-of-step stream reaching the end of
 * that file and no further. The default arm
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
 * tables' rationale and response prose stays review-held, their Payload column
 * no longer among it — a cell is read as key names, and a row that disagrees
 * with its senders reds; and the
 * manifest's resource-exposure facts (CSP absence, empty
 * `web_accessible_resources`) stay judgment-held with their doc bullets.
 *
 * The handle legs carry residues of their own, each named here. The member
 * table's What-it-does prose stays review-held; its Reaches column does not,
 * being read as names rather than as prose ({@link readReachCell}) — a cell
 * states the worker binding names its member reaches, backticked and
 * comma-separated, or the lone marker {@link HANDLE_NO_REACH_MARKER}, and
 * anything else is refused rather than read as a shorter set. A worker binding
 * actually called that marker could not be stated in a cell, which is the
 * reserved word's one cost. That grammar sentence's own presence guard holds
 * its WORDS ({@link REACH_GRAMMAR_ANCHOR}), the way the sender statement's
 * does: a faithful rewording that drops them reds although the doctrine still
 * stands, and a sentence keeping them while the prose around them turns into
 * something else passes — what the grammar sentence means stays review-held.
 * The clause's closure sentence ({@link HANDLE_CLOSURE_ANCHOR}) — the one the
 * weld below is the enforcement of — is held present the same way, and the
 * weld's own diagnostics are built from that constant, so the sentence the
 * clause must state and the sentence those reds quote have one home.
 * The identifier scan
 * over a member's body reads every word token in it, property names included,
 * so a property called after a module-scope binding — `x.activeFrames` — is
 * read as a reach; that direction is a false red, never a false green, and it
 * is what keeps the leg from having to model what a name is used AS. The
 * false-GREEN side is the membership test's own bound: what the leg tests is
 * the worker's MODULE-SCOPE names, so a reach that passes through no such name
 * is outside it — a member body calling a platform API directly reaches
 * whatever that call reaches, with nothing here to see. The weld INHERITS that
 * bound rather than closing it: what a row says about such a member, the
 * no-reach marker included, is a claim about reaches this leg cannot see, and
 * stays review-held. The anchor's own head is tokenized as `globalThis`, the
 * handle name, and `=`, which a COMPARISON on that name satisfies as well:
 * written `===` or `==` it is counted as a head, so beside the real assignment
 * it reds as a second assignment, and standing alone it reds for the shape that
 * follows — each diagnosis naming an assignment the source never made. Both
 * readings are reds rather than greens, with the members unread and the
 * empty-surface guard answering beside them, and they are named here so the
 * diagnosis is read as the shape it is. The mention count reads word and
 * string token positions, so a computed access (`globalThis['…']`) is counted
 * while a name written as a template literal's own text is not. The anchor
 * models the dot-assignment form alone: a handle installed through a computed
 * target reds as an absent anchor, and its string occurrence reds again at the
 * mention leg. And the `globalThis` binding stays writable however the object
 * is frozen, so a rebound handle installs a different surface with no edit to
 * the anchor — the property the freeze pin holds is that the enumerated
 * literal cannot be extended in place.
 *
 * Usage:
 *   node scripts/check-extension-surface.js  # or: npm run lint:extension-surface
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  backtickedName,
  duplicateSurfaceProblems,
  emptySurfaceProblems,
  extractClauseSection,
  flattenWhitespace,
  formatProblemBlock,
  isUnreadLiteralKind,
  missingFrom,
  namedLiteral,
  readLoneStringLiteral,
  readTableColumn,
  resolveColumn,
  selectTablesByHeader,
  tokenizeJs,
  trackedFilesUnder,
  walkObjectLiteral,
} from './check-test-inventory.js';
import {
  POPULATION_EXTENSIONS,
  POPULATION_ROOT as PRODUCTION_POPULATION_ROOT,
  POPULATION_TEST_TREE as PRODUCTION_POPULATION_TEST_TREE,
  derivePopulation as deriveProductionPopulation,
} from './check-capture-surface.js';

/** Repo-relative path of the extension manifest. */
export const MANIFEST_PATH = 'packages/extension/manifest.json';
/** Repo-relative path of the permissions doc whose tables state EPM-1. */
export const PERMISSIONS_DOC_PATH = 'docs/architecture/application/extension/permissions.md';
/** Repo-relative path of the runtime doc whose enumerations state ERT-4. */
export const RUNTIME_DOC_PATH = 'docs/architecture/application/extension/runtime.md';
/**
 * Repo-relative path of the service worker. It is where the runtime doc's
 * Components table homes the message dispatcher, and — ERT-4 stating that the
 * capture-path types are serviced by the listener's dedicated guards — where
 * that listener's guards are, which is what the forward capture-path diff and
 * the dispatcher's location leg each stand on.
 */
export const WORKER_PATH = 'packages/extension/background/service-worker.js';
/** Repo-relative directory of the panel JavaScript the send scan reads. */
export const PANEL_DIR = 'packages/extension/sidepanel';
/**
 * Repo-relative directory of the content-script JavaScript the capture-path
 * send scan reads. It is the tree the runtime doc's Components table homes the
 * recorder in, and the recorder is the sender the capture-path table names.
 */
export const CONTENT_DIR = 'packages/extension/content';
/**
 * The directory whose tracked JavaScript the dispatcher legs scan: the
 * worker's own module tree, which is the tree the Components table homes the
 * dispatcher in.
 */
export const BACKGROUND_ROOT = 'packages/extension/background';
/** The permission-surface clause the manifest legs verify. */
export const EPM_CLAUSE_ID = 'EPM-1';
/** The message-surface clause the dispatcher legs verify. */
export const ERT_CLAUSE_ID = 'ERT-4';
/** The handle-surface clause the introspection-handle legs verify. */
export const HANDLE_CLAUSE_ID = 'ERT-5';
/** The name the worker assigns its introspection handle to on its own global. */
export const HANDLE_NAME = '__docentCaptureBookkeeping';
/**
 * The handle's member table, by its whole header — selected inside the clause's
 * own scope, so the enumeration this check diffs is the one the clause states.
 */
export const HANDLE_TABLE_HEADER = ['Member', 'Reaches', 'What it does'];
/**
 * The member table's READ columns, each spelled as the header word the
 * document carries — the name each read states and each empty-cell placeholder
 * names. The suite holds both to be members of {@link HANDLE_TABLE_HEADER}, so a
 * header renamed without these constants refuses loudly at the read rather than
 * standing.
 */
export const HANDLE_MEMBER_COLUMN = 'Member';
/** The column whose cells state what a member reaches ({@link readReachCell}). */
export const HANDLE_REACHES_COLUMN = 'Reaches';
/**
 * The worker module-scope names the handle's members reach — a structure the
 * clause places the handle over, a function it runs to reach one, or a query of
 * its own that touches no placed structure: the frame registry and the
 * programmatic-tab set, the production registration a plant goes through, and
 * the record-start seed's own tab query the target-set read answers from. A
 * member reaching a module-scope name outside this set reaches a binding the
 * clause neither places the handle over nor runs it through, which is the
 * surface change ERT-5 and this constant state together.
 */
export const HANDLE_REACH_SET = [
  'activeFrames',
  'programmaticTabs',
  'registerFrame',
  'queryCaptureTargetTabs',
];
/**
 * The Reaches cell's marker for a member that reaches no module-scope name of
 * the worker at all — one standing on a platform call alone. It is the cell's
 * OTHER whole form, which is what keeps an empty or prose-only cell unreadable
 * rather than readable as this: a row states either the names its member
 * reaches or, explicitly, that it reaches none. A worker binding actually
 * called `none` could not be stated in a cell, which is the reserved word's one
 * cost. The near misses are refused with the form to write rather than read as
 * a shorter set: a bare word outside backticks, the marker standing beside a
 * name, and an em dash written in place of it each red as an unreadable cell,
 * naming what stood there. No row the runtime doc ships states the marker
 * today — the cases that exercise it are the suite's.
 */
export const HANDLE_NO_REACH_MARKER = 'none';
/** The `##` section of the runtime doc carrying both protocol tables. */
export const PROTOCOL_SECTION = 'Message protocol';
/** The capture-path table's whole header in that section. */
export const CAPTURE_TABLE_HEADER = ['Type', 'Payload', 'Response'];
/**
 * The capture-path table's payload column, by its header NAME, spelled as the
 * word the document carries. The column is resolved from each admitted table's
 * own header by that word, through the shared reader's named form
 * ({@link resolveColumn}), the way the member table's own columns are spelled and
 * read ({@link HANDLE_MEMBER_COLUMN}, {@link HANDLE_REACHES_COLUMN}). The suite
 * holds this name to be a member of
 * {@link CAPTURE_TABLE_HEADER}, so a header renamed without this constant refuses
 * loudly at the read rather than standing: taking the name from the header by
 * INDEX instead would read whichever column that position now holds and blame the
 * document for what it found there.
 *
 * Admission is the WHOLE header in its stated order
 * ({@link CAPTURE_TABLE_HEADER}), so a document stating the column under another
 * name or at another position admits no table here and answers the empty surface
 * this leg's own guard reds on, and a named column absent from an admitted table
 * is a defect in this check, refused loudly where it is resolved.
 */
export const CAPTURE_PAYLOAD_COLUMN = 'Payload';
/**
 * The Payload cell's marker for a message that carries no payload at all: an em
 * dash, written in the cell BACKTICKED, the cell's other whole form beside a
 * backticked object shape. Every cell this check parses is one backticked span,
 * and this constant is the marker's own text inside that span, so the cell's
 * backticks belong to the span rather than to the marker. It is what keeps an
 * empty cell unreadable rather than readable as this: a row states the key names
 * its message carries or, explicitly, that it carries none. A message whose
 * payload key is actually called after the marker could not be stated in a cell,
 * which is the reserved form's one cost.
 */
export const CAPTURE_PAYLOAD_NONE_MARKER = '\u2014';
/**
 * The shape of a top-level payload key, on both sides of the weld: a bare
 * JavaScript identifier. It is what refuses a nested shape, a quoted piece, and
 * a prose fragment inside the braces, rather than reading a shorter set out of
 * one.
 */
const PAYLOAD_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The panel-protocol table's whole header in that section. */
export const PANEL_TABLE_HEADER = ['Group', 'Types'];
/**
 * That table's READ column, spelled as the header word the document carries — the
 * name the read states and the empty-piece placeholder names. The suite holds it
 * to be a member of {@link PANEL_TABLE_HEADER}, so a header renamed without this
 * constant refuses loudly at the read rather than standing.
 */
export const PANEL_TYPES_COLUMN = 'Types';
/** The permission tables' whole headers, each with the `##` section it sits in. */
export const PERMISSION_TABLES = [
  ['Permissions', ['Permission', 'What Docent does with it']],
  ['Host permissions', ['Host permission', 'What Docent does with it']],
];

/**
 * Derive the scanned population: the tracked JavaScript modules under
 * {@link BACKGROUND_ROOT}, filtered to {@link POPULATION_EXTENSIONS}. Deriving
 * from the directory rather than naming its files is what makes the set
 * maintain itself — a background module the extension grows is scanned the day
 * it lands, with nothing to update here.
 *
 * Membership is TRACKEDNESS, POSITION, and EXTENSION: a file `git ls-files`
 * reports under this root, carrying one of those extensions, is in — and the
 * derivation excludes nothing further. A module written under the root but not
 * yet tracked is outside the population until it is added, which is the same
 * boundary the repository draws around every other file it governs.
 * The package's test home sits at `packages/extension/tests` by the
 * repository's own structure, outside this root, so no exclusion is needed to
 * keep tests out — and none is claimed for a test file written UNDER the root
 * instead. Such a file would be read like any other: one carrying a second
 * dispatcher or an unstated guard reds, on a diagnosis about the shipped
 * surface rather than about a fixture, and one carrying neither contributes
 * nothing at all. Neither outcome is a property this closure holds.
 *
 * Paths come back verbatim: `trackedFilesUnder` in
 * [`check-test-inventory.js`](./check-test-inventory.js) states the quotepath
 * policy.
 *
 * This is the one derivation of the dispatcher legs' population: the CLI runs
 * them over what it returns, and the suite's real-tree locks hold that same set,
 * so a change here cannot leave those locks holding a population the check no
 * longer scans. The panel tree's population is derived beside it
 * ({@link derivePanelPopulation}), the content tree's beside that
 * ({@link deriveContentPopulation}), and the production set the handle's
 * mention leg reads comes from the sibling check that already derives it rather
 * than from a copy made here: one derivation apiece, none of them restated.
 * @param {string} [cwd] the directory to enumerate from — the repository root,
 *   which is where the CLI runs and where the suite points it
 * @returns {string[]} repo-relative paths, in `git ls-files` order
 */
export function derivePopulation(cwd = process.cwd()) {
  return trackedFilesUnder(BACKGROUND_ROOT, { extensions: POPULATION_EXTENSIONS, cwd });
}

/**
 * The panel-side extension of that same rule: the tracked JavaScript under
 * {@link PANEL_DIR}, which is the population the send leg reads. Derived, not
 * listed, for the reason the background derivation is — a panel module the
 * extension grows is scanned the day it lands.
 *
 * The filter is `.js` alone, narrower than the background set's on purpose:
 * the panel ships plain scripts, and widening this set is a change to what the
 * send closure covers rather than a detail of how it is spelled.
 *
 * This is the one derivation of the send leg's population: the CLI runs the
 * leg over what it returns, and the suite's real-tree locks hold that same
 * set.
 * @param {string} [cwd] the directory to enumerate from
 * @returns {string[]} repo-relative paths, in `git ls-files` order
 */
export function derivePanelPopulation(cwd = process.cwd()) {
  return trackedFilesUnder(PANEL_DIR, { extensions: ['.js'], cwd });
}

/**
 * The capture path's own extension of that same rule: the tracked JavaScript
 * under {@link CONTENT_DIR}, which is the population the capture-path send scan
 * reads. Derived, not listed, for the reason the others are — a content module
 * the extension grows is scanned the day it lands.
 *
 * The filter is `.js` alone, the panel derivation's and for its reason: the
 * content tree ships plain scripts, and widening this set is a change to what
 * the capture-path send closure covers rather than a detail of how it is
 * spelled.
 *
 * The tree carries a block two of its modules share, kept in step by a parity
 * test, and this population reads both copies. A send written inside that block
 * therefore stands twice, which the weld reads as two sites of one type: each
 * site is held to that type's row on its own, and two identical copies state the
 * same key set, so both meet the row and the duplication moves the leg by
 * nothing.
 *
 * This is the one derivation of the capture-path send leg's population: the CLI
 * runs the leg over what it returns, and the suite's real-tree locks hold that
 * same set.
 * @param {string} [cwd] the directory to enumerate from
 * @returns {string[]} repo-relative paths, in `git ls-files` order
 */
export function deriveContentPopulation(cwd = process.cwd()) {
  return trackedFilesUnder(CONTENT_DIR, { extensions: ['.js'], cwd });
}

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
 * The global-object names a platform global may be qualified by: a receiver
 * written `globalThis.chrome`, `self.chrome` or `window.chrome` names the same
 * object the bare `chrome` names, so the grammar admits one such qualifier
 * before the path's first name.
 */
export const GLOBAL_QUALIFIERS = ['globalThis', 'self', 'window'];

/**
 * The callee a send scan reads, as a PATH with one grammar
 * ({@link standsAtCallee} walks it): each name after the first is reached by a
 * step written plain (`.name`), optional (`?.name`), computed (`['name']`, either
 * quote), or optional computed (`?.['name']`); the call itself is `(` or the
 * optional `?.(`, and its first argument opens an object literal.
 *
 * `qualifiers` is what a path whose first name is a platform GLOBAL carries: the
 * global-object names that first name may be qualified by, which is also the
 * statement that it is a global at all — a path without them reads its first name
 * wherever it stands, the way the panel's own sender is called. `name` is the
 * path's last name — the callee a diagnosis names — derived here rather than
 * written beside the path, so the callee has one spelling.
 * @param {string[]} path the callee's names, receiver first
 * @param {string[] | null} [qualifiers] the global-object names the first name
 *   may be qualified by, where that name is a platform global
 * @returns {{ path: string[], qualifiers: string[] | null, name: string }}
 */
function sendCallee(path, qualifiers = null) {
  return { path, qualifiers, name: path[path.length - 1] };
}

/**
 * The panel's own callee: the word its sender is called by, read wherever that
 * word stands before a call whose first argument opens an object literal — bare
 * (`send({ … })`) or qualified by a receiver of its own
 * (`adapter.send({ … })`), since the panel's sender is a binding of the panel's
 * making rather than a platform global. What the panel leg does NOT read is
 * decided by the argument alone: a send-shaped site whose first argument is
 * anything but an opening object literal.
 */
export const PANEL_SEND_CALLEE = sendCallee(['send']);
/**
 * The capture path's own callee: the platform send, the path
 * `chrome.runtime.sendMessage` in any spelling the grammar
 * {@link standsAtCallee} walks states — the receiver the platform global
 * `chrome`, written bare or qualified by one global-object name
 * ({@link GLOBAL_QUALIFIERS}), each following name reached by a step written
 * plain, optional, computed, or optional computed, and the call plain or
 * optional. Naming the whole path is what holds the scan to the capture path
 * itself, and it keeps the declaration shapes out of a scan whose callee is a
 * plausible parameter name: a function or method cannot be DECLARED with a
 * receiver before its name, so the declaration shapes whose third token is an
 * opening brace — the function declaration `function sendMessage({ type }) {}`
 * and the method shorthand `{ sendMessage({ type }) {} }` — state no site.
 *
 * A binding spelled `chrome` is read BY ITS SPELLING: the scan cannot tell a
 * local of that name from the platform global, so a send written through one is
 * credited to the capture path — a false-red direction, since the type it states
 * must then stand in the capture-path table.
 *
 * Forms outside the shape, as observed so far: a send written through an ALIAS of
 * the receiver (`const rt = chrome.runtime; rt.sendMessage({ … })`), one written
 * unqualified or through a destructured `sendMessage({ … })`, one reaching the
 * platform object through another object or a private field (`wrapper.chrome…`,
 * `bag['chrome']…`, `this.#chrome…`), one whose receiver or path is written
 * parenthesized, and a computed step written as anything but a quoted string.
 * Each stands outside the shape and is invisible to both directions of the
 * closure — the type such a send states reds on the forward diff as a type
 * nothing sends, and the payload it carries is held to no row. Moving a send onto
 * one of those forms is a change that updates the capture-path table and this
 * check together. A `sendMessage` on another receiver — a port, a wrapper of the
 * platform call — is not read at all, being a call of that name rather than the
 * platform send the capture-path table states.
 */
export const CAPTURE_SEND_CALLEE = sendCallee(
  ['chrome', 'runtime', 'sendMessage'],
  GLOBAL_QUALIFIERS,
);

/**
 * The words the clause's sender statement makes its existence claim in — the
 * doctrine the send leg holds, quoted from the clause rather than paraphrased,
 * so the phrase has one home and the suite reads it from here.
 */
export const SENDER_STATEMENT_ANCHOR = 'has at least one send written as an object literal';

/**
 * Count how many times the clause's own scope states the sender statement.
 * The clause section is code-block-aware (so an illustration inside a code
 * block cannot stand in for the doctrine) and bounded at the clause's marker,
 * so a statement that drifts out of the clause counts as gone; the whole
 * scope is whitespace-flattened before the anchor is sought, so the anchor is
 * found whatever line the prose wraps on.
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
 * The words the handle clause states its member surface's closure in — the
 * sentence the per-member weld is the enforcement of, a row standing as the
 * allowed set for its own member and read against that member's body both
 * ways. Quoted from the clause rather than paraphrased, and spelled once: the
 * weld's own diagnostics are built from it and the suite reads it from here, so
 * the sentence the clause must state and the sentence those reds quote have one
 * home.
 */
export const HANDLE_CLOSURE_ANCHOR =
  'each member reaches exactly the worker bindings its row names';

/**
 * Count how many times the handle clause's own scope states that closure.
 * Read exactly the way the sender statement is: the clause section is
 * code-block-aware, bounded at the clause's marker, and whitespace-flattened
 * before the anchor is sought, so the sentence is found whatever line the prose
 * wraps on and a copy that drifts out of the clause counts as gone.
 *
 * Occurrences, not paragraphs, for the sibling's reason: a second copy is a
 * second copy an update can land beside whether or not a blank line separates
 * the two.
 * @param {string} runtimeText the runtime doc's text
 * @returns {number} occurrences of the anchor in the handle clause's scope
 */
export function countClosureStatements(runtimeText) {
  const scope = flattenWhitespace(extractClauseSection(runtimeText, HANDLE_CLAUSE_ID));
  return scope.split(HANDLE_CLOSURE_ANCHOR).length - 1;
}

/**
 * The words the handle clause's reach-cell grammar makes its own claim in —
 * the sentence that tells a reader how a Reaches cell states a reach, and
 * which marker stands for none. It is BUILT from {@link
 * HANDLE_NO_REACH_MARKER} rather than spelled out, so the marker the cell
 * reader accepts and the marker the clause names have one home and cannot part
 * company: renaming the marker moves both, and a clause left naming the old
 * one reds here rather than standing beside a reader that no longer reads it.
 */
export const REACH_GRAMMAR_ANCHOR = `backticked, separated by commas \u2014 or \`${HANDLE_NO_REACH_MARKER}\`, where the member reaches no worker binding at all`;

/**
 * Count how many times the handle clause's own scope states that grammar.
 * Read exactly the way the sender statement is: the clause section is
 * code-block-aware, bounded at the clause's marker, and whitespace-flattened
 * before the anchor is sought, so the sentence is found whatever line the
 * prose wraps on and a copy that drifts out of the clause counts as gone.
 * @param {string} runtimeText the runtime doc's text
 * @returns {number} occurrences of the anchor in the handle clause's scope
 */
export function countReachGrammarStatements(runtimeText) {
  const scope = flattenWhitespace(extractClauseSection(runtimeText, HANDLE_CLAUSE_ID));
  return scope.split(REACH_GRAMMAR_ANCHOR).length - 1;
}

/**
 * The words the message clause's capture-path statement makes its EXISTENCE claim
 * in — the recorder's half of the sender statement, which the forward type diff
 * holds: every type the capture-path table states is sent. Quoted from the clause
 * rather than paraphrased, the way {@link SENDER_STATEMENT_ANCHOR} is, so the
 * phrase has one home and the suite reads it from here.
 */
export const RECORDER_STATEMENT_ANCHOR = 'is sent at least once from an object literal';

/**
 * Count how many times the message clause's own scope states that claim. Read
 * exactly the way the sender statement and the payload grammar beside it are: the
 * clause section is code-block-aware, bounded at the clause's marker, and
 * whitespace-flattened before the anchor is sought, so the claim is found
 * whatever line the prose wraps on and a copy that drifts out of the clause
 * counts as gone.
 *
 * Occurrences, not paragraphs: a second copy is a second copy an update can land
 * beside whether or not a blank line separates the two.
 * @param {string} runtimeText the runtime doc's text
 * @returns {number} occurrences of the anchor in the message clause's scope
 */
export function countRecorderStatements(runtimeText) {
  const scope = flattenWhitespace(extractClauseSection(runtimeText, ERT_CLAUSE_ID));
  return scope.split(RECORDER_STATEMENT_ANCHOR).length - 1;
}

/**
 * The words the message clause's capture-path statement makes its payload claim
 * in — the doctrine the weld holds, quoted from the clause rather than
 * paraphrased. It is BUILT from {@link CAPTURE_PAYLOAD_NONE_MARKER} the way
 * {@link REACH_GRAMMAR_ANCHOR} is built from its own marker, so the marker the
 * cell reader accepts and the marker the clause names have one home: respelling
 * it moves both, and a clause left naming the old one reds here rather than
 * standing beside a reader that no longer reads it. The sentence states the
 * marker's own SPAN beside it — the marker stands in the cell backticked, which
 * is the uniformity {@link readPayloadCell} reads every cell by — so the
 * document states the form the reader accepts.
 */
export const CAPTURE_PAYLOAD_GRAMMAR_ANCHOR = `states the message's remaining top-level keys \u2014 each a bare name, backticked together as one object shape, or the lone marker \`${CAPTURE_PAYLOAD_NONE_MARKER}\`, itself one backticked span, where the message carries none`;

/**
 * Count how many times the message clause's own scope states that grammar. Read
 * exactly the way the sender statement and the reach grammar are: the clause
 * section is code-block-aware, bounded at the clause's marker, and
 * whitespace-flattened before the anchor is sought, so the sentence is found
 * whatever line the prose wraps on and a copy that drifts out of the clause
 * counts as gone.
 * @param {string} runtimeText the runtime doc's text
 * @returns {number} occurrences of the anchor in the message clause's scope
 */
export function countCapturePayloadGrammarStatements(runtimeText) {
  const scope = flattenWhitespace(extractClauseSection(runtimeText, ERT_CLAUSE_ID));
  return scope.split(CAPTURE_PAYLOAD_GRAMMAR_ANCHOR).length - 1;
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
 * An unreadable cell as every red in this check renders it: the cell's own text
 * wrapped in double quotation marks. The marks are the cell's bounds — a red
 * states its reason around em-dash separators, so a cell whose whole text is
 * punctuation, the payload marker's own character included, is otherwise
 * indistinguishable from them. A placeholder a reader writes in place of an
 * empty cell names a shape rather than a text and stands as it is, which is what
 * `empty` identifies; a reader that decides the emptiness itself passes the
 * text alone.
 * @param {string} cell the cell's text, or the placeholder for an empty cell
 * @param {string|null} [empty] that placeholder, where the caller holds one
 * @returns {string} the cell as a red renders it
 */
function quotedCell(cell, empty = null) {
  return cell === empty ? cell : `"${cell}"`;
}

/**
 * What a cell states, as every weld in this check renders it: each name
 * backticked, comma-separated, in the order the red shows them — or the column's
 * own marker where the cell states no name at all. Naming nothing where a cell
 * states nothing would read as a cell the scan failed to quote, so the marker
 * itself stands there; the marker comes from the caller because each column has
 * its own, and the rendering is one function because the two welds render it
 * alike.
 * @param {string[]} names the names the cell states
 * @param {string} marker the column's marker for a cell stating none
 * @returns {string} the names as a red renders them
 */
function statesNames(names, marker) {
  return names.length === 0 ? `\`${marker}\`` : names.map((n) => `\`${n}\``).join(', ');
}

/**
 * Read the first-column backticked names of every table in a named `##`
 * section of a doc carrying an exact header (code-block-aware through the
 * shared table parser). A table is selected by its section AND its WHOLE
 * header, so a sibling table under the same heading is never conscripted into
 * the closed set by sharing a column name. A body row whose first cell is not
 * a lone backticked name is returned as unreadable, so no row is skipped
 * silently, each rendered by {@link quotedCell}.
 *
 * The column read is the selected header's FIRST one, by construction: every
 * table this reader serves states its enumeration there, and the header it was
 * selected by is where that column's name comes from — so the name is never
 * spelled a second time here, and a caller reading any other column spells that
 * column itself, the way the member table's reads do
 * ({@link HANDLE_MEMBER_COLUMN}).
 * @param {string} docText the doc's text
 * @param {string} section the `##` section title the table lives under
 * @param {string[]} header the table's whole header
 * @returns {{ names: string[], unreadable: string[] }}
 */
export function extractSectionTableNames(docText, section, header) {
  const { tables } = selectTablesByHeader(docText, { section, header });
  const empty = `(empty ${header[0]} cell)`;
  const { names, unreadable } = readTableColumn(tables, { empty, column: header[0] });
  return { names, unreadable: unreadable.map((cell) => quotedCell(cell, empty)) };
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
    const typesIndex = resolveColumn(table, PANEL_TYPES_COLUMN);
    for (const row of table.rows) {
      for (const piece of (row[typesIndex] ?? '').split(',')) {
        const token = piece.trim();
        const name = backtickedName(token);
        if (name !== null) panelTypes.push(name);
        else unreadable.push(token === '' ? `(empty ${PANEL_TYPES_COLUMN} piece)` : quotedCell(token)); // prettier-ignore
      }
    }
  }
  return { captureTypes: capture.names, panelTypes, unreadable };
}

/**
 * Read one Payload cell as the top-level key names its message carries.
 *
 * The grammar is TOTAL and fail-closed, the shape {@link readReachCell} has: a
 * cell is ONE whole backticked span, and that span is either an object shape
 * whose contents are comma-separated bare names — `{ readyAt, url }` — or the
 * lone marker {@link CAPTURE_PAYLOAD_NONE_MARKER}, standing for a message that
 * carries no payload at all. Reading the span first is the uniformity every cell
 * this check parses carries, so the marker counts where the cell writes it
 * backticked, and a bare dash is text like any other. Everything else is
 * unreadable, and the caller reds on it rather than reading a shorter set out of
 * it: prose, an empty cell, a shape or a marker written outside backticks, empty
 * braces, a nested shape, a quoted piece, a name stated twice. Empty braces are
 * refused rather than read as the empty set for the marker's sake — one form
 * per meaning is what makes a cell's silence impossible, so a payload set is
 * always something the document said.
 *
 * The names come back as the cell WRITES them, in document order: a cell states
 * a set, so neither side's order is meaning, and the weld compares sorted copies
 * — which leaves the document's own order free to stand in a red, where a cell
 * quoted as its author wrote it is what a reader goes back to the table with. A
 * name stated twice is refused rather than deduplicated, so the order carries no
 * repeat either.
 * @param {string} cell the cell text
 * @returns {string[] | null} the key names in the order the cell states them
 *   (empty for the marker), or null when the cell is not the grammar
 */
export function readPayloadCell(cell) {
  const inner = backtickedName(cell);
  if (inner === null) return null;
  if (inner === CAPTURE_PAYLOAD_NONE_MARKER) return [];
  const shape = /^\{(.+)\}$/.exec(inner.trim());
  if (shape === null) return null;
  const names = [];
  for (const piece of shape[1].split(',')) {
    const name = piece.trim();
    if (!PAYLOAD_KEY_RE.test(name)) return null;
    names.push(name);
  }
  return new Set(names).size === names.length ? names : null;
}

/**
 * Read the capture-path table's payload surface: each row's type PAIRED with
 * the top-level key names its Payload cell states. A cell is the one backticked
 * span {@link readPayloadCell} reads — an object shape, or the marker a message
 * carrying its type alone states.
 *
 * The column is resolved from each admitted table's own header BY NAME, through
 * the shared reader's named form ({@link resolveColumn} over
 * {@link CAPTURE_PAYLOAD_COLUMN}), the way the member table's own columns are
 * spelled and read ({@link HANDLE_MEMBER_COLUMN}, {@link HANDLE_REACHES_COLUMN}).
 * What the named form buys is legibility at the read itself: the column this
 * check reads is the header word the document carries, so the leg states which
 * column it is about rather than a number a reader has to count out against the
 * table. Admission is the WHOLE header in its stated order
 * ({@link CAPTURE_TABLE_HEADER}), so a document stating the column under another
 * name or at another position admits no table here and answers the empty surface
 * this leg's own guard reds on. A named column absent from an admitted table is
 * a defect in this check, and the resolver refuses it loudly — the posture every
 * named read in this check takes.
 *
 * The PAIR is why the rows are walked here rather than read through that shared
 * column reader: the reader answers with a column's names and its unreadable
 * cells, and a weld needs each cell beside the type whose row it is. The pattern
 * is {@link extractHandleTable}'s, including its one silence — a row whose type
 * cell is itself unreadable is left to the type column's own refusal, since
 * naming it twice would report one defect as two.
 * @param {string} runtimeText the runtime doc's text
 * @returns {{ payloads: { type: string, keys: string[] }[], unreadable: string[] }}
 */
export function extractCapturePayloads(runtimeText) {
  const { tables } = selectTablesByHeader(runtimeText, {
    section: PROTOCOL_SECTION,
    header: CAPTURE_TABLE_HEADER,
  });
  const payloads = [];
  const unreadable = [];
  for (const table of tables) {
    // The shared reader's own resolution, taken directly because the weld needs
    // each cell beside its own row's type rather than one column's names.
    const index = resolveColumn(table, CAPTURE_PAYLOAD_COLUMN);
    for (const row of table.rows) {
      const type = backtickedName((row[0] ?? '').trim());
      if (type === null) continue; // the type column's own read already named it
      const cell = (row[index] ?? '').trim();
      const keys = readPayloadCell(cell);
      if (keys === null) {
        unreadable.push(`\`${type}\`: ${cell === '' ? `(empty ${CAPTURE_PAYLOAD_COLUMN} cell)` : quotedCell(cell)}`); // prettier-ignore
        continue;
      }
      payloads.push({ type, keys });
    }
  }
  return { payloads, unreadable };
}

/**
 * Read the handle's member surface from the runtime doc's member table, taken
 * from inside {@link HANDLE_CLAUSE_ID}'s own scope (the shared clause slice,
 * code-block-aware and bounded at the next marker or heading), so a table that
 * drifts out of the clause states nothing here.
 *
 * The read columns come back together, each resolved from the table's own header
 * by the name its constant spells ({@link HANDLE_MEMBER_COLUMN},
 * {@link HANDLE_REACHES_COLUMN}). The member column's backticked names are the
 * members. Each row's Reaches cell is read by {@link readReachCell} and
 * comes back PAIRED with the member whose row it is, which is what lets the
 * caller hold a row and its own member's body to one another; a row whose
 * member cell is itself unreadable is left to the member column's own refusal,
 * since naming it twice would report one defect as two. A Reaches cell outside
 * that grammar is unreadable rather than a shorter set, and comes back named
 * per member in a list of its own, beside the member column's unreadable cells.
 *
 * The posture comes back beside the names, counted over the WHOLE document: the
 * surface is stated as one table, so a second one carrying the same header —
 * anywhere in the doc, in the clause or outside it — is drift the caller reds
 * on rather than a set this reader silently merges.
 * @param {string} runtimeText the runtime doc's text
 * @returns {{ members: string[], reaches: { member: string, names: string[] }[],
 *   unreadable: string[], reachUnreadable: string[], matches: number }}
 */
export function extractHandleTable(runtimeText) {
  const scope = extractClauseSection(runtimeText, HANDLE_CLAUSE_ID);
  const { tables } = selectTablesByHeader(scope, { header: HANDLE_TABLE_HEADER });
  const emptyMember = `(empty ${HANDLE_MEMBER_COLUMN} cell)`;
  const { names, unreadable } = readTableColumn(tables, {
    empty: emptyMember,
    column: HANDLE_MEMBER_COLUMN,
  });
  const reaches = [];
  const reachUnreadable = [];
  for (const table of tables) {
    // Both columns by NAME, through the shared reader's own resolution, so this
    // loop reads the columns its constants spell rather than the positions they
    // happen to stand at.
    const memberIndex = resolveColumn(table, HANDLE_MEMBER_COLUMN);
    const reachIndex = resolveColumn(table, HANDLE_REACHES_COLUMN);
    for (const row of table.rows) {
      const member = backtickedName((row[memberIndex] ?? '').trim());
      if (member === null) continue; // the member read above already named it
      const cell = (row[reachIndex] ?? '').trim();
      const stated = readReachCell(cell);
      if (stated === null) {
        reachUnreadable.push(`\`${member}\`: ${cell === '' ? `(empty ${HANDLE_REACHES_COLUMN} cell)` : quotedCell(cell)}`); // prettier-ignore
        continue;
      }
      reaches.push({ member, names: stated });
    }
  }
  const { matches } = selectTablesByHeader(runtimeText, { header: HANDLE_TABLE_HEADER });
  return {
    members: names,
    reaches,
    unreadable: unreadable.map((cell) => quotedCell(cell, emptyMember)),
    reachUnreadable,
    matches,
  };
}

/**
 * Read one Reaches cell as the names its row states its member reaches.
 *
 * The grammar is TOTAL and fail-closed: a cell is either a comma-separated run
 * of whole backticked names, or the lone marker {@link HANDLE_NO_REACH_MARKER}
 * backticked, standing for a member that reaches no module-scope name of the
 * worker. Everything else — prose, an empty cell, a name outside backticks, the
 * marker beside a name, the same name twice — is unreadable, and the caller
 * reds on it rather than reading a shorter set out of it. That is what makes a
 * row's silence impossible: a member's stated reach set is always something the
 * document said, never something a cell failed to say.
 * @param {string} cell the cell text
 * @returns {string[] | null} the stated names (empty for the marker), or null
 *   when the cell is not the grammar
 */
export function readReachCell(cell) {
  const text = (cell ?? '').trim();
  if (text === '') return null;
  const names = [];
  for (const piece of text.split(',')) {
    const name = backtickedName(piece.trim());
    if (name === null) return null;
    names.push(name);
  }
  if (names.includes(HANDLE_NO_REACH_MARKER)) return names.length === 1 ? [] : null;
  return new Set(names).size === names.length ? names : null;
}

/**
 * Read the dispatcher's serviced surface across the scanned population through
 * the shared comment-safe tokenizer. Every file is tokenized on its own, and
 * `caseLabels`, `equalityTypes`, `equalitySites` and `workerEqualityTypes` come
 * back beside the extractor's own `problems`:
 *
 *   - `caseLabels`, the case labels anywhere in the body of the ONE
 *     `switch ((msg|message).type)` the population carries (bounded by brace
 *     depth, so labels after the `default:` arm still count and a sibling
 *     switch elsewhere is never misread);
 *   - `equalityTypes`, the `message.type === '…'` (or `msg.type`) equality
 *     literals anywhere in the population, deduplicated, since guarding one
 *     type twice is legal — the surface the REVERSE capture-path diff reads,
 *     so a guard on an undocumented type reds wherever in the population it
 *     was written;
 *   - `equalitySites`, the same equality hits UNdeduplicated, each carrying the
 *     path it was read in beside the type it guards — the deduplicated set says
 *     which types the population guards, and only the sites can say which
 *     module carries a given guard, which is what the reverse refusal names;
 *   - `workerEqualityTypes`, the same literals read from {@link WORKER_PATH}
 *     alone — the surface the FORWARD capture-path diff reads, ERT-4 stating
 *     that those types are serviced by the listener's own guards.
 *
 * Where inside a file its guards sit is review-held (token order is not
 * control flow, so a position rule would red legal declaration moves). Anchor
 * failures — no dispatcher switch in the population, more than one, one
 * outside {@link WORKER_PATH}, a switch with no readable body, a nested
 * switch, a missing `default:` arm — are problems of this extractor, so they
 * fire even when other surfaces parse empty. A per-file refusal names its
 * file; a refusal about the population as a whole names the derived scope.
 *
 * An EMPTY map states no population, which is a machinery fact rather than a
 * dispatcher that went missing: it is diagnosed by
 * {@link evaluateExtensionSurface}'s own guards, so this extractor stays
 * silent on it and reports no singleton refusal.
 * @param {Map<string, string>} sourceByPath path → background module source
 * @returns {{ caseLabels: string[], equalityTypes: string[],
 *   equalitySites: { path: string, type: string }[],
 *   workerEqualityTypes: string[], problems: string[] }}
 */
export function extractDispatcherSurface(sourceByPath) {
  const problems = [];
  const caseLabels = [];
  const equalityHits = [];
  const workerEqualityHits = [];
  /** Every dispatcher head found, each with the file and token stream it sits in. */
  const switchHeads = [];

  for (const [path, source] of sourceByPath) {
    const tokens = tokenizeJs(source);
    const at = (i, type, value) =>
      tokens[i] && tokens[i].type === type && tokens[i].value === value;
    const isReceiver = (i) =>
      tokens[i] && tokens[i].type === 'word' && (tokens[i].value === 'msg' || tokens[i].value === 'message'); // prettier-ignore

    for (let i = 0; i + 5 < tokens.length; i++) {
      if (
        at(i, 'word', 'switch') &&
        at(i + 1, 'punct', '(') &&
        isReceiver(i + 2) &&
        at(i + 3, 'punct', '.') &&
        at(i + 4, 'word', 'type') &&
        at(i + 5, 'punct', ')')
      ) {
        switchHeads.push({ path, tokens, at, index: i });
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
        if (read.lone) {
          equalityHits.push({ path, type: read.value });
          if (path === WORKER_PATH) workerEqualityHits.push(read.value);
        } else if (isUnreadLiteralKind(read.kind)) {
          problems.push(`${path} guards a message type with ${namedLiteral(read.kind, read.token)} — the scan reads a quoted string literal standing alone as the operand, so the capture-path closure stays checkable`); // prettier-ignore
        } else if (read.isString) {
          problems.push(`${path} guards a message type with \`${read.token}\` followed by \`${read.follower ?? 'end of source'}\` — the scan reads a quoted string literal standing alone as the operand, so the capture-path closure stays checkable`); // prettier-ignore
        }
      }
    }
  }

  const equalityTypes = [...new Set(equalityHits.map((hit) => hit.type))];
  const workerEqualityTypes = [...new Set(workerEqualityHits)];
  // The sites keep the file each hit was read in, which the deduplicated set
  // above drops: the reverse capture-path refusal names the module carrying
  // the guard, and only the sites can say which one that is.
  const surface = () => ({ caseLabels, equalityTypes, equalitySites: equalityHits, workerEqualityTypes, problems }); // prettier-ignore

  // Nothing scanned states nothing about the dispatcher: an empty population is
  // the evaluator's machinery diagnosis, and a singleton refusal here would
  // report a missing dispatcher over a set that was never read.
  if (sourceByPath.size === 0) return surface();

  if (switchHeads.length !== 1) {
    // Fail-closed on the labels: a second dispatcher's arms are not this
    // surface, and feeding an ambiguous label set to the diffs would report
    // drift the population does not have.
    if (switchHeads.length === 0) {
      problems.push(`no dispatcher switch over the message type found in the tracked ${POPULATION_EXTENSIONS.join('/')} modules under ${BACKGROUND_ROOT} — the scan models exactly one`); // prettier-ignore
    } else {
      const perFile = [...new Set(switchHeads.map((head) => head.path))]
        .map((path) => `${path} (${switchHeads.filter((head) => head.path === path).length})`)
        .join(', ');
      problems.push(`the tracked ${POPULATION_EXTENSIONS.join('/')} modules under ${BACKGROUND_ROOT} carry ${switchHeads.length} dispatcher switches over the message type — ${perFile} — the scan models exactly one`); // prettier-ignore
    }
    return surface();
  }

  const { path, tokens, at, index } = switchHeads[0];
  // The one dispatcher's HOME is part of what this check holds: the runtime
  // doc's Components table homes the dispatcher in the service worker, so a
  // switch standing anywhere else in the population is refused by name. The
  // hold runs CODE-SIDE, in one direction: the found switch's file is pinned to
  // WORKER_PATH, the constant whose own doc comment cites that row. Nothing
  // here reads the row's text, so the row's own sentence stays review-held —
  // editing it alone leaves this leg pinning the code to the constant. The
  // refusal below names the table as the reason the file is pinned, which is
  // where a reader goes to see the two agree. The labels PASS THROUGH — the
  // singleton holds, so the one dispatcher's labels are well defined, and
  // withholding them could only hide drift the diffs would otherwise name.
  // Whether those diffs run at all is a separate question the guarded surfaces
  // answer: a move that carries the worker's equality guards along with the
  // switch empties that subset, and the empty-parse return then stands ahead
  // of every diff.
  if (path !== WORKER_PATH) {
    problems.push(`${path} carries the dispatcher switch over the message type — the Components table homes it in ${WORKER_PATH}, which is also the file whose guards the forward capture-path diff reads`); // prettier-ignore
  }

  let hasDefault = false;
  let i = index + 6;
  if (!at(i, 'punct', '{')) {
    problems.push(`${path}'s dispatcher switch has no readable body — the case-label scan cannot run`); // prettier-ignore
    return surface();
  }
  let depth = 1;
  for (i += 1; i < tokens.length && depth > 0; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '{') depth++;
    else if (t.type === 'punct' && t.value === '}') depth--;
    else if (at(i, 'word', 'switch')) {
      problems.push(`${path} nests a switch inside the dispatcher's — the case-label scan models exactly one level`); // prettier-ignore
      return surface();
    } else if (depth === 1 && at(i, 'word', 'case')) {
      // The label is the whole label, which its own colon is what establishes:
      // `case 'PROJECTS_LIST' + k:` tokenizes as a string first, so reading the
      // string alone would credit the enumeration's type to an arm that
      // services another one.
      const read = readLoneStringLiteral(tokens, i + 1, CASE_LABEL_END);
      if (read.lone) {
        caseLabels.push(read.value);
        i += 2;
      } else if (isUnreadLiteralKind(read.kind)) {
        problems.push(`${path}'s dispatcher switch labels an arm with ${namedLiteral(read.kind, read.token)} — the scan reads a quoted string literal the label's own colon follows, so the panel-protocol closure stays checkable`); // prettier-ignore
      } else if (read.isString) {
        problems.push(`${path}'s dispatcher switch labels an arm \`${read.token}\` followed by \`${read.follower ?? 'end of source'}\` — the scan reads a quoted string literal the label's own colon follows, so the panel-protocol closure stays checkable`); // prettier-ignore
      }
    } else if (depth === 1 && at(i, 'word', 'default') && at(i + 1, 'punct', ':')) {
      hasDefault = true;
    }
  }
  if (!hasDefault) {
    problems.push(`${path}'s dispatcher switch has no default: arm — ${ERT_CLAUSE_ID} promises the error envelope for a type outside the enumerations`); // prettier-ignore
  }
  return surface();
}

/**
 * Whether the token at `at` opens a KEYED property: a bare or quoted name the
 * property's own colon follows. Both object scans here read a member the same
 * way — the dispatcher's send literals and the introspection handle's member
 * literal — so what counts as a key is one decision, and the position this
 * refuses is exactly the one {@link describeKeyPosition} then names.
 * @param {{ type: string, value: string }[]} tokens the file's tokens
 * @param {number} at index of the token standing at the property start
 * @returns {boolean}
 */
function startsKeyedProperty(tokens, at) {
  const token = tokens[at];
  return (
    (token.type === 'word' || token.type === 'string') &&
    tokens[at + 1]?.type === 'punct' &&
    tokens[at + 1].value === ':'
  );
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
  // The literal arms are the shared phrase's, so a key-position literal reads
  // exactly as one standing anywhere else this family refuses a literal.
  if (isUnreadLiteralKind(token.type)) return namedLiteral(token.type, token.value);
  if (token.type === 'word' || token.type === 'string') {
    return `\`${token.value}\`, which no colon follows`;
  }
  return `\`${token.value}\` where a key belongs`;
}

/**
 * The one name the payload read gives every property shape that DECLARES a name
 * of its own instead of stating one. The shapes it names are exactly these, and
 * it claims no others: a name the call's `(` follows — written bare, quoted, or
 * as a number — which is a method; `get`, `set`, or `async` before another name,
 * a computed name, or a generator's `*`, which is an accessor or an async method;
 * and a `*` standing first, which is a generator. Each keeps its name inside a
 * declaration this read does not enter, so the site refuses rather than carrying
 * the word that opened it.
 */
const HIDDEN_METHOD_SHAPE = 'a method or accessor';
/** The words an accessor or an async method stands behind. */
const ACCESSOR_WORDS = ['get', 'set', 'async'];
/**
 * The name the payload read gives a key written outside the shape a Payload cell
 * states: a quoted key and a numeric key each name a property the cell's grammar
 * — a bare identifier — has no form for, so the site refuses rather than
 * carrying a name no row can ever state. The message's own `type` key is the
 * type read's, never the payload's, so a quoted `type` states no payload key and
 * leaves the site readable.
 */
const UNSTATABLE_KEY_SHAPE = 'a key outside the identifier shape a Payload cell states';

/**
 * Which hidden-name shape stands at a property start the key test refused, or
 * null where the position states a SHORTHAND key the read takes by name.
 *
 * A word standing here is that shorthand exactly when the property ends right
 * after it — the next token its separator or the literal's own closing brace.
 * Every other shape a word can open declares its name
 * ({@link HIDDEN_METHOD_SHAPE}); a spread and a computed key keep the names
 * {@link describeKeyPosition} gives them, and any other token standing here is
 * named the same way.
 * @param {{ type: string, value: string }[]} tokens the file's tokens
 * @param {number} at index of the token at the property start
 * @returns {string | null} the shape's name, or null for a shorthand key
 */
function hiddenNameShape(tokens, at) {
  const token = tokens[at];
  const next = tokens[at + 1];
  const follower = next?.type === 'punct' ? next.value : null;
  if (token.type === 'punct' && token.value === '*') return HIDDEN_METHOD_SHAPE;
  // A METHOD is named the same way however its own name is written — bare,
  // quoted, or as a number — the call punctuation after it being what makes it
  // one.
  if ((token.type === 'word' || token.type === 'string') && follower === '(') {
    return HIDDEN_METHOD_SHAPE;
  }
  if (token.type !== 'word') return describeKeyPosition(token);
  if (follower === ',' || follower === '}') return null;
  // A name standing after `get`, `set` or `async` declares one whether it is
  // written bare or quoted, and a computed name or a generator's `*` does the
  // same.
  const declares =
    next?.type === 'word' || next?.type === 'string' || follower === '*' || follower === '[';
  if (ACCESSOR_WORDS.includes(token.value) && declares) return HIDDEN_METHOD_SHAPE;
  return describeKeyPosition(token);
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
 *
 * The PAYLOAD read beside it admits the names a Payload cell can state and
 * refuses the rest by name: a bare identifier key and the shorthand stating one
 * are read as the key they name, while a shape declaring a name of its own
 * ({@link HIDDEN_METHOD_SHAPE}) and a key written outside the identifier shape
 * ({@link UNSTATABLE_KEY_SHAPE}) each refuse the site. The message's own `type`
 * property is the type read's, bare or quoted, and stands outside the payload
 * either way.
 * @param {{ type: string, value: string }[]} tokens the file's tokens
 * @param {number} open index of the literal's opening `{`
 * @returns {{ type: string | null, found: string | null, keys: string[] | null,
 *   keysFound: string | null }} the type, or what the scan found in its place
 *   (`found` is null exactly when a type was read), beside the payload the
 *   literal states: its top-level key names without `type`, deduplicated and
 *   sorted — or a null set with `keysFound` naming the shape that hid a name, or
 *   the end of a literal that never closed (`keysFound` is null exactly when the
 *   keys were read)
 */
function readSendType(tokens, open) {
  const properties = [];
  const keys = [];
  let hidden = null;
  let typeAt = -1;
  // The walk is the shared skeleton; what a property IS is this check's own
  // policy, which reads a key name where the shape states one and names the
  // position otherwise.
  const { closed } = walkObjectLiteral(tokens, open, (i, t) => {
    if (!startsKeyedProperty(tokens, i)) {
      properties.push(describeKeyPosition(t));
      // A SHORTHAND property states a key and no value, and the key read takes
      // its name: `{ type: 'X', action }` carries a top-level `action` exactly
      // as `action: stamped` does, and names are the whole of what a payload
      // surface states. The shapes standing here that HIDE a name instead are a
      // closed list — a spread's own properties, a computed key's resolved name,
      // and the name a method, an accessor, or a generator declares
      // ({@link hiddenNameShape}) — so the key read refuses the site rather than
      // reading a shorter set out of it. The type read refuses the shorthand
      // beside them for a different reason: it carries no string literal to read
      // a type from.
      const shape = hiddenNameShape(tokens, i);
      if (shape === null) keys.push(t.value);
      else if (hidden === null) hidden = shape;
      return;
    }
    properties.push(`\`${t.value}\``);
    // A key the cell's grammar can state is a bare identifier, and the payload
    // read takes exactly those: a quoted key and a numeric key name a property
    // no cell can ever state ({@link UNSTATABLE_KEY_SHAPE}), so the site refuses
    // instead of carrying a name the weld could never be satisfied over. The
    // `type` key itself is the type read's and stands outside the payload
    // whichever of the two ways it is written.
    if (t.value === 'type') {
      typeAt = i;
      keys.push(t.value);
    } else if (t.type === 'string' || !PAYLOAD_KEY_RE.test(t.value)) {
      if (hidden === null) hidden = UNSTATABLE_KEY_SHAPE;
    } else {
      keys.push(t.value);
    }
  });
  // The payload the literal states, read once for every return below: the
  // top-level key names other than the one naming the message, deduplicated (a
  // literal may legally state a key twice) and sorted, because a key set's order
  // is not meaning. Unreadable when a shape hid a name, or when the literal
  // never closed and the names past the end are unknown.
  const payload =
    closed && hidden === null
      ? { keys: [...new Set(keys.filter((k) => k !== 'type'))].sort(), keysFound: null }
      : { keys: null, keysFound: hidden ?? '(end of source)' };
  if (typeAt === -1) {
    if (!closed) return { type: null, found: '(end of source)', ...payload };
    return {
      type: null,
      ...payload,
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
    return { type: null, found: '(end of source)', ...payload };
  // A template literal is named by its kind: its token value is a run of its
  // literal text, so naming the token alone would state a type the send never
  // writes — and an interpolated one, a type no enumeration can ever carry.
  // Template only, deliberately: a regular expression falls through to the arm
  // below, which names the token as written — and a regex's token value IS its
  // literal text, so that is the reading its own shape asks for.
  if (read.kind === 'template') {
    return { type: null, found: `a \`type\` key set from ${namedLiteral(read.kind, read.token)}`, ...payload }; // prettier-ignore
  }
  if (!read.isString) return { type: null, found: `a \`type\` key set from \`${read.token}\``, ...payload }; // prettier-ignore
  if (!read.lone) {
    return { type: null, found: `a \`type\` key set from \`${read.token}\` followed by \`${read.follower}\``, ...payload }; // prettier-ignore
  }
  return { type: read.value, found: null, ...payload };
}

/**
 * The tokens a name standing on its own may not follow: a member-access dot —
 * which is also the second token of an optional-chaining pair, so `?.` is this
 * same dot — a `]` closing a computed member access, and the `#` a private name is
 * marked with. Each of them says the name is a property of something else's
 * object, which is a path this scan does not read.
 */
const NAME_PRECEDED_BY = ['.', ']', '#'];

/**
 * Whether the callee path ENDS at `at`, walked backwards over the one grammar the
 * scan reads:
 *
 *   - each name AFTER the first is reached by one step, written plain (`.name`),
 *     optional (`?.name`), computed (`['name']`, either quote style), or optional
 *     computed (`?.['name']`) — the spellings the shared tokenizer distinguishes,
 *     the last name included;
 *   - the path's FIRST name, where the callee states its global-object qualifiers,
 *     is that global: the name standing on its own — no token of
 *     {@link NAME_PRECEDED_BY} before it — or reached by one step of its own from
 *     one of those qualifiers, itself standing on its own. A callee that states no
 *     qualifiers makes no claim about its first name, which is then read wherever
 *     it stands;
 *   - the call punctuation and the opening literal are the caller's to read
 *     ({@link opensLiteralCall}).
 *
 * @param {{ type: string, value: string }[]} tokens the file's tokens
 * @param {number} at index of the path's last token — the final name's word, or
 *   the `]` closing it where that name is written computed
 * @param {{ path: string[], qualifiers: string[] | null }} callee the callee whose
 *   path and first-name rule the walk reads
 * @returns {boolean}
 */
function standsAtCallee(tokens, at, { path, qualifiers }) {
  /** Whether a name may stand after this token at all. */
  const opensName = (token) => !(token?.type === 'punct' && NAME_PRECEDED_BY.includes(token.value));
  let i = at;
  // Whether the path's first name was written computed, which carries its own
  // step: `globalThis['chrome']` reaches the global through the brackets, so no
  // further step stands before it.
  let computedFirst = false;
  for (let k = path.length - 1; k >= 0; k--) {
    // A name written COMPUTED carries its own brackets, which are the step that
    // reached it — so only an optional computed step adds punctuation before them.
    if (tokens[i]?.type === 'punct' && tokens[i].value === ']') {
      const named = tokens[i - 1];
      if (!(named?.type === 'string' && named.value === path[k])) return false;
      if (!(tokens[i - 2]?.type === 'punct' && tokens[i - 2].value === '[')) return false;
      i -= 3;
      if (tokens[i]?.type === 'punct' && tokens[i].value === '.') {
        if (!(tokens[i - 1]?.type === 'punct' && tokens[i - 1].value === '?')) return false;
        i -= 2;
      }
      if (k === 0) computedFirst = true;
      continue;
    }
    const word = tokens[i];
    if (!(word?.type === 'word' && word.value === path[k])) return false;
    i -= 1;
    if (k === 0) break;
    // The step that reached this name: a `.`, which an optional-chaining `?` may
    // stand before (the tokenizer emits `?.` as the two punctuation tokens it is
    // written with).
    if (!(tokens[i]?.type === 'punct' && tokens[i].value === '.')) return false;
    i -= 1;
    if (tokens[i]?.type === 'punct' && tokens[i].value === '?') i -= 1;
  }
  if (qualifiers === null) return true;
  // The first name is the platform global: standing on its own, or reached by one
  // step from a global-object name that stands on its own.
  if (!computedFirst && opensName(tokens[i])) return true;
  let j = i;
  if (!computedFirst) {
    if (!(tokens[j]?.type === 'punct' && tokens[j].value === '.')) return false;
    j -= 1;
    if (tokens[j]?.type === 'punct' && tokens[j].value === '?') j -= 1;
  }
  const qualifier = tokens[j];
  if (!(qualifier?.type === 'word' && qualifiers.includes(qualifier.value))) return false;
  return opensName(tokens[j - 1]);
}

/**
 * Where the object literal a call at `at` opens stands, or -1 where the tokens
 * after the callee are not that shape: the call punctuation is `(` or the
 * optional call `?.(`, and its first argument opens an object literal.
 * @param {{ type: string, value: string }[]} tokens the file's tokens
 * @param {number} at index of the callee path's last token
 * @returns {number} index of the literal's `{`, or -1
 */
function opensLiteralCall(tokens, at) {
  let i = at + 1;
  if (tokens[i]?.type === 'punct' && tokens[i].value === '?') {
    if (!(tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.')) return -1;
    i += 2;
  }
  if (!(tokens[i]?.type === 'punct' && tokens[i].value === '(')) return -1;
  if (!(tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '{')) return -1;
  return i + 1;
}

/**
 * Read the literal send sites a callee's own path states, through the shared
 * comment-safe tokenizer. The scan reads ONE shape — the callee's path, token
 * by token ({@link sendCallee}), followed by a call written `(` or the optional
 * `?.(` whose first argument opens an object literal — and reads that literal's top-level properties for the
 * `type` the message states, refusing by name the send that states none,
 * so a restructured payload cannot pass as a partially-read send. Property
 * order carries no meaning and the scan reads none into it. A send-shaped site
 * whose first argument is not an opening brace is outside the shape the scan
 * reads and contributes nothing: the declaration forms, the receiver-qualified
 * forward, and the call passing a variable assembled beforehand all sit there,
 * and the reverse-direction diff's limit is exactly that residue. A call the
 * callee's path does not stand whole before is outside the shape the same way —
 * for the capture path, a send made through an alias of the receiver, through an
 * unqualified or destructured `sendMessage(`, or through a platform object
 * reached by way of another object or a global alias; a `sendMessage` called on
 * another receiver is not the platform send at all
 * ({@link CAPTURE_SEND_CALLEE} states that residue in full).
 * Beside the type each site carries the top-level key NAMES its literal states,
 * the message's own `type` property excluded — the payload surface a table
 * stating one can be welded to. The panel's table states no payload column
 * today, so its sites carry a read nothing holds them to; the capture path's
 * does, and the two legs differ in which columns answer rather than in how a
 * send is read.
 * @param {Map<string, string>} sourceByPath path → JavaScript source
 * @param {{ path: string[], name: string }} [callee] the callee whose path the
 *   scan reads
 * @returns {{ path: string, ordinal: number, type: string | null, found: string | null, keys: string[] | null, keysFound: string | null }[]}
 *   one entry per object-literal send, numbered per file in source order
 */
export function extractSendSites(sourceByPath, callee = PANEL_SEND_CALLEE) {
  const sites = [];
  for (const [path, source] of sourceByPath) {
    const tokens = tokenizeJs(source);
    let ordinal = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (!standsAtCallee(tokens, i, callee)) continue;
      const open = opensLiteralCall(tokens, i);
      if (open === -1) continue;
      ordinal += 1;
      sites.push({ path, ordinal, ...readSendType(tokens, open) });
    }
  }
  return sites;
}

/**
 * How a send site is named in the check's output: its file and its position
 * among that file's object-literal sends — the only sends the ordinal counts —
 * comments excluded. The callee is named with it, so a reader of either leg's
 * refusal can find the site by the call the scan actually read.
 * @param {{ path: string, ordinal: number }} site
 * @param {string} [callee] the callee name that leg's scan reads
 * @returns {string}
 */
function sendLabel(site, callee = PANEL_SEND_CALLEE.name) {
  return `${site.path} (object-literal ${callee}( call site ${site.ordinal})`;
}

/**
 * Collect the MODULE-SCOPE names a source binds: the population the handle's
 * reach leg tests each member's identifiers against. Binding at module scope is
 * the whole criterion — a name bound anywhere else is a local or a parameter,
 * which the handle reaches nothing through.
 *
 * The shapes read, all at brace depth zero: a `const`/`let`/`var` declarator
 * list (each name in it, the ones after a comma included), a `function` or
 * `class` declaration, and an import's default binding, its named list — where
 * `a as b` binds `b`, the specifier's last name being the local one either way
 * — and its namespace alias, in either position that alias can stand in: alone
 * after `import`, or after a default binding and its comma. A side-effect
 * import and a dynamic `import(` bind nothing and are passed over as such.
 *
 * One shape is REFUSED rather than read past: a destructuring pattern standing
 * where a declarator name belongs. Its names are bindings the reach leg would
 * then be testing against an incomplete list — a member could reach one and red
 * nowhere — so the refusal keeps the leg's population honest instead of letting
 * it quietly shrink.
 *
 * A declarator list stays open until its `;` or the next declaration keyword,
 * which is what carries the reader across an initializer's own words. Where a
 * source ends a statement by line break alone, that flag can outlive it and a
 * later top-level comma then contributes a name nothing declares — collecting a
 * name too many, which reds a member that reaches it. The conservative
 * direction is the deliberate one here: this set exists to make reaches
 * testable, and a name it holds spuriously costs a false red, where a name it
 * misses costs a reach nothing tests.
 * @param {{ type: string, value: string }[]} tokens the tokenized source
 * @returns {{ bindings: Set<string>, problems: string[] }}
 */
export function collectModuleBindings(tokens) {
  const bindings = new Set();
  const problems = [];
  let depth = 0;
  /** Whether a `const`/`let`/`var` declarator list is still open at depth zero. */
  let declarators = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && '([{'.includes(t.value)) {
      depth++;
      continue;
    }
    if (t.type === 'punct' && ')]}'.includes(t.value)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (t.type === 'punct' && t.value === ';') {
      declarators = false;
      continue;
    }
    if (t.type === 'punct' && t.value === ',' && declarators) {
      // The declarator list continues: `const a = 1, b = 2` binds both.
      if (tokens[i + 1]?.type === 'word') bindings.add(tokens[i + 1].value);
      continue;
    }
    if (t.type !== 'word') continue;
    if (t.value === 'const' || t.value === 'let' || t.value === 'var') {
      const next = tokens[i + 1];
      if (next?.type === 'word') {
        bindings.add(next.value);
        declarators = true;
      } else {
        declarators = false;
        problems.push(`${WORKER_PATH} declares a module-scope binding through ${namedLiteral(next?.type, next?.value ?? 'end of source')} where the collector reads a name — the handle's reach leg tests each member's identifiers against the worker's module-scope names, and a name it cannot see is a reach it cannot test`); // prettier-ignore
      }
      continue;
    }
    if (t.value === 'function' || t.value === 'class') {
      declarators = false;
      // A generator's `*` stands between the keyword and the name.
      const at = tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '*' ? i + 2 : i + 1;
      if (tokens[at]?.type === 'word') bindings.add(tokens[at].value);
      continue;
    }
    if (t.value !== 'import') continue;
    declarators = false;
    let j = i + 1;
    // A side-effect import binds nothing; a dynamic import is an expression.
    if (tokens[j]?.type === 'string') continue;
    if (tokens[j]?.type === 'punct' && tokens[j].value === '(') continue;
    if (tokens[j]?.type === 'word') {
      bindings.add(tokens[j].value);
      j += 1;
      if (tokens[j]?.type === 'punct' && tokens[j].value === ',') j += 1;
    }
    // The namespace alias is read HERE, past the default arm, so it is bound in
    // both positions it can stand in: alone after `import`, and after a default
    // binding and its comma. Read before that arm it would answer for the first
    // shape only, and the alias of the combined form would bind nothing at all.
    if (tokens[j]?.type === 'punct' && tokens[j].value === '*') {
      if (tokens[j + 2]?.type === 'word') bindings.add(tokens[j + 2].value);
      continue;
    }
    if (!(tokens[j]?.type === 'punct' && tokens[j].value === '{')) continue;
    let specifier = [];
    for (let k = j + 1; k < tokens.length; k++) {
      const inner = tokens[k];
      const ends = inner.type === 'punct' && (inner.value === ',' || inner.value === '}');
      if (!ends) {
        specifier.push(inner);
        continue;
      }
      // `a as b` binds `b`, `a` binds `a`: the specifier's last name is local.
      const local = specifier.filter((x) => x.type === 'word').pop();
      if (local) bindings.add(local.value);
      specifier = [];
      if (inner.value === '}') break;
    }
  }
  return { bindings, problems };
}

/**
 * Read the worker's introspection handle: its members, and the module-scope
 * names each member's body reaches.
 *
 * The anchor is the whole assignment — `globalThis`, the handle name, `=`,
 * `Object.freeze(`, the literal's `{` — so the surface is read from one
 * statement or from none. An assignment head with anything else after it is
 * named as what stands there (the unfrozen literal among them), a second head
 * anywhere in the file is refused with both counted, and a literal that never
 * closes is refused rather than half-read.
 *
 * Each member's body runs from its value token to the next top-level property
 * (its separating comma excluded) or to the literal's own closing brace, and
 * every word token in it is an identifier the member NAMES. What that body
 * REACHES is the intersection of those identifiers with the module-scope
 * bindings above; both come back, the named list so the suite can hold the
 * identifiers a healthy tree leaves outside the reach test.
 * @param {string} workerSource the service worker's source
 * @returns {{ members: string[], named: { member: string, identifiers: string[] }[],
 *   reaches: { member: string, name: string }[], problems: string[] }}
 */
export function extractHandleSurface(workerSource) {
  const problems = [];
  const members = [];
  const named = [];
  const reaches = [];
  const tokens = tokenizeJs(workerSource);
  const surface = () => ({ members, named, reaches, problems });
  const { bindings, problems: bindingProblems } = collectModuleBindings(tokens);
  problems.push(...bindingProblems);

  const at = (i, type, value) => tokens[i] && tokens[i].type === type && tokens[i].value === value;
  const heads = [];
  for (let i = 0; i + 3 < tokens.length; i++) {
    if (at(i, 'word', 'globalThis') && at(i + 1, 'punct', '.') && at(i + 2, 'word', HANDLE_NAME) && at(i + 3, 'punct', '=')) heads.push(i); // prettier-ignore
  }
  if (heads.length !== 1) {
    problems.push(heads.length === 0
      ? `${WORKER_PATH} assigns no \`globalThis.${HANDLE_NAME}\` — the member surface ${HANDLE_CLAUSE_ID} states is read from that one assignment`
      : `${WORKER_PATH} carries ${heads.length} \`globalThis.${HANDLE_NAME}\` assignments — the scan models exactly one, since the members diffed against the table come from one statement`); // prettier-ignore
    return surface();
  }

  const head = heads[0];
  const frozen =
    at(head + 4, 'word', 'Object') &&
    at(head + 5, 'punct', '.') &&
    at(head + 6, 'word', 'freeze') &&
    at(head + 7, 'punct', '(') &&
    at(head + 8, 'punct', '{');
  if (!frozen) {
    const stood = tokens[head + 4];
    problems.push(`${WORKER_PATH} assigns \`globalThis.${HANDLE_NAME}\` from ${stood ? namedLiteral(stood.type, stood.value) : '(end of source)'} — the scan reads \`Object.freeze({\`, the shape that keeps the enumerated members from being replaced or extended in place`); // prettier-ignore
    return surface();
  }

  const starts = [];
  const { closed, end } = walkObjectLiteral(tokens, head + 8, (i, t) => starts.push({ i, t }));
  if (!closed) {
    problems.push(`${WORKER_PATH}'s handle literal never closes — the member scan cannot run`);
    return surface();
  }
  for (let k = 0; k < starts.length; k++) {
    const { i, t } = starts[k];
    if (!startsKeyedProperty(tokens, i)) {
      problems.push(`${WORKER_PATH}'s handle literal carries a member the scan cannot read — ${describeKeyPosition(t)} — a member is a bare or quoted name carrying its value, so the enumeration stays diffable`); // prettier-ignore
      continue;
    }
    members.push(t.value);
    const identifiers = [];
    const bodyEnd = k + 1 < starts.length ? starts[k + 1].i - 1 : end;
    for (let j = i + 2; j < bodyEnd; j++) {
      if (tokens[j].type === 'word' && !identifiers.includes(tokens[j].value)) {
        identifiers.push(tokens[j].value);
      }
    }
    named.push({ member: t.value, identifiers });
    for (const name of identifiers) {
      if (bindings.has(name)) reaches.push({ member: t.value, name });
    }
  }
  return surface();
}

/**
 * Count the handle's name across a population, per file. A word token equal to
 * the name and a string token containing it both count — the second is what
 * makes a computed access (`globalThis['…']`) a mention rather than an invisible
 * one — while comments are already out of the stream the shared tokenizer emits,
 * so a name a comment mentions is no mention at all.
 * @param {Map<string, string>} sourceByPath path → module source
 * @returns {{ path: string, count: number }[]} one entry per file that names it
 */
export function countHandleMentions(sourceByPath) {
  const counts = [];
  for (const [path, source] of sourceByPath) {
    let count = 0;
    for (const token of tokenizeJs(source)) {
      if (token.type === 'word' && token.value === HANDLE_NAME) count += 1;
      else if (token.type === 'string' && token.value.includes(HANDLE_NAME)) count += 1;
    }
    if (count > 0) counts.push({ path, count });
  }
  return counts;
}

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this
 * list — a leg added here is exercised automatically, and the suite holds
 * the list non-empty and its diagnoses distinct.
 *
 * Both equality surfaces take a leg of their own, each naming the scope it is
 * read from: the population-wide set the REVERSE capture-path diff runs over,
 * and the WORKER subset the FORWARD diff reads. This evaluator is a pure
 * function of the surface handed to it, so the population set's non-emptiness
 * cannot be inferred from the subset's — a surface stating an empty population
 * beside a guarded worker subset would otherwise run the reverse diff over
 * nothing — and holding each where it is read is what keeps "every parsed set
 * must be non-empty" in the header above a true statement of what runs here.
 * The case-label diagnosis names the derived scope rather than the worker:
 * the dispatcher's file is held by the extractor's own location leg, so a
 * dispatcher found elsewhere must not be described here as the worker's.
 */
export const EMPTY_SURFACES = [
  ['manifestPermissions', `no permissions found in ${MANIFEST_PATH}`],
  ['manifestHostPermissions', `no host_permissions found in ${MANIFEST_PATH}`],
  ['docPermissions', `no Permissions table names found in ${PERMISSIONS_DOC_PATH}`],
  ['docHostPermissions', `no Host permissions table names found in ${PERMISSIONS_DOC_PATH}`],
  ['docCaptureTypes', `no capture-path types found in ${RUNTIME_DOC_PATH}`],
  ['docPanelTypes', `no panel-protocol types found in ${RUNTIME_DOC_PATH}`],
  ['caseLabels', `no case labels found in the dispatcher switch the tracked ${BACKGROUND_ROOT} JavaScript carries`], // prettier-ignore
  ['equalityTypes', `no message-type equality literals found in the tracked ${BACKGROUND_ROOT} JavaScript`], // prettier-ignore
  ['workerEqualityTypes', `no message-type equality literals found in ${WORKER_PATH}`],
  ['sendTypes', `no object-literal ${PANEL_SEND_CALLEE.name}( call site naming a type found in the tracked ${PANEL_DIR} JavaScript`], // prettier-ignore
  // A capture-path header the document renames states neither column here, so
  // this entry's line and the type column's stand together: one header, both
  // lines, which is what each guard answering for its own read costs and what
  // keeps either of them from standing on the other.
  ['docCapturePayloads', `no readable ${CAPTURE_PAYLOAD_COLUMN} cell found in the capture-path table in ${RUNTIME_DOC_PATH}`], // prettier-ignore
  ['captureSendTypes', `no object-literal ${CAPTURE_SEND_CALLEE.name}( call site naming a type found in the tracked ${CONTENT_DIR} JavaScript`], // prettier-ignore
  ['handleMembers', `no members found on the introspection handle in ${WORKER_PATH}`],
  ['docHandleMembers', `no handle members found in the ${HANDLE_CLAUSE_ID} member table in ${RUNTIME_DOC_PATH}`], // prettier-ignore
  ['docHandleReaches', `no readable Reaches cells found in the ${HANDLE_CLAUSE_ID} member table in ${RUNTIME_DOC_PATH}`], // prettier-ignore
];

/**
 * The duplicates guard's legs — drift signal on the doc surfaces and on case
 * labels (a repeated label is unreachable code); equality guards and send
 * types are exempt: testing or sending one type twice is legal code shape.
 * Both equality sets arrive deduplicated from their extractor; the send types
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
  ['handleMembers', `the introspection handle's own members`],
  ['docHandleMembers', `the ${HANDLE_CLAUSE_ID} member table`],
];

/**
 * Pure core: evaluate every extension surface contract.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.manifestPermissions manifest `permissions` entries
 * @param {string[]} s.manifestHostPermissions manifest `host_permissions` entries
 * @param {string[]} s.docPermissions the permissions doc's Permissions table names
 * @param {string[]} s.docHostPermissions its Host permissions table names
 * @param {string[]} s.permissionsUnreadable unreadable permission-table cells
 * @param {string[]} s.docCaptureTypes the runtime doc's capture-path types
 * @param {string[]} s.docPanelTypes the runtime doc's panel-protocol types
 * @param {string[]} s.protocolUnreadable unreadable protocol cells/pieces
 * @param {string[]} s.backgroundFiles the scanned population, in the order it was read
 * @param {string[]} s.caseLabels the dispatcher switch's case labels
 * @param {string[]} s.equalityTypes every equality-literal type the scanned
 *   population guards, deduplicated — the reverse capture-path diff's surface
 * @param {{ path: string, type: string }[]} s.equalitySites those same hits
 *   undeduplicated, each with the module it was read in — what lets the
 *   reverse refusal name the file rather than the tree
 * @param {string[]} s.workerEqualityTypes the subset of those the service
 *   worker itself guards — the forward capture-path diff's surface, ERT-4
 *   stating the capture-path types are serviced by the listener's own guards
 * @param {string[]} s.panelFiles the panel population the send scan read, in
 *   the order it was read
 * @param {{ type: string, keys: string[] }[]} s.docCapturePayloads each
 *   capture-path row's type with the top-level key names its Payload cell
 *   states, empty where the row states the no-payload marker
 * @param {string[]} s.capturePayloadUnreadable Payload cells the grammar refuses
 * @param {string[]} s.contentFiles the content population the capture-path send
 *   scan read, in the order it was read
 * @param {string[]} s.captureSendTypes the content scripts' literal send types,
 *   deduplicated
 * @param {{ path: string, ordinal: number, type: string | null, found: string | null, keys: string[] | null, keysFound: string | null }[]} s.captureSendSites every object-literal capture-path send site, readable or not
 * @param {string[]} s.sendTypes the panel's literal send types, deduplicated
 * @param {{ path: string, ordinal: number, type: string | null, found: string | null, keys: string[] | null, keysFound: string | null }[]} s.sendSites every object-literal send site, readable or not
 * @param {number} s.capturePayloadGrammarStatements times the clause's scope states its capture-path payload grammar
 * @param {number} s.senderStatements times the clause's scope states its sender statement
 * @param {number} s.recorderStatements times the clause's scope states its capture-path sender statement
 * @param {number} s.reachGrammarStatements times the handle clause's scope states its reach-cell grammar
 * @param {number} s.closureStatements times the handle clause's scope states its closure sentence
 * @param {string[]} s.handleMembers the members the worker's handle literal carries
 * @param {string[]} s.docHandleMembers the member table's names
 * @param {string[]} s.handleUnreadable unreadable member-table cells
 * @param {string[]} s.handleReachUnreadable Reaches cells the grammar refuses
 * @param {{ member: string, names: string[] }[]} s.docHandleReaches each
 *   member row's stated reach set, empty where the row states the marker
 * @param {number} s.handleTableMatches tables in the doc carrying the member header
 * @param {{ member: string, name: string }[]} s.handleReaches each module-scope
 *   name a member's body reaches, with the member that reaches it
 * @param {string[]} s.productionFiles the extension package's production
 *   JavaScript, in the order it was read
 * @param {{ path: string, count: number }[]} s.handleMentions the files naming
 *   the handle, with each file's occurrence count
 * @returns {string[]} problems; empty when every contract holds (the
 *   dispatcher anchor guards — switch count, the switch's home, the default
 *   arm, nesting — are the extractor's own problems and are reported beside
 *   these)
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
  for (const cell of s.handleUnreadable) {
    problems.push(`${RUNTIME_DOC_PATH} carries a ${HANDLE_CLAUSE_ID} member cell the scan cannot read — ${cell} — members are lone backticked names`); // prettier-ignore
  }
  for (const cell of s.handleReachUnreadable) {
    problems.push(`${RUNTIME_DOC_PATH} carries a ${HANDLE_CLAUSE_ID} Reaches cell the scan cannot read — ${cell} — a cell states the worker binding names its member reaches, backticked and comma-separated, or the lone marker \`${HANDLE_NO_REACH_MARKER}\``); // prettier-ignore
  }
  for (const cell of s.capturePayloadUnreadable) {
    problems.push(`${RUNTIME_DOC_PATH} carries a capture-path ${CAPTURE_PAYLOAD_COLUMN} cell the scan cannot read — ${cell} — a cell states the message's top-level key names as one backticked object shape (\`{ a, b }\`), or the lone marker \`${CAPTURE_PAYLOAD_NONE_MARKER}\` where the message carries no payload at all`); // prettier-ignore
  }
  for (const site of s.sendSites.filter((x) => x.type === null)) {
    problems.push(`${sendLabel(site)} states no readable message type — the scan found ${site.found} — an object-literal send carries its type as a string literal in a top-level \`type\` property, in any position, so the sender side stays readable`); // prettier-ignore
  }
  for (const site of s.captureSendSites.filter((x) => x.type === null)) {
    problems.push(`${sendLabel(site, CAPTURE_SEND_CALLEE.name)} states no readable message type — the scan found ${site.found} — an object-literal send carries its type as a string literal in a top-level \`type\` property, in any position, so the sender side stays readable`); // prettier-ignore
  }
  for (const site of s.captureSendSites.filter((x) => x.type !== null && x.keys === null)) {
    problems.push(`${sendLabel(site, CAPTURE_SEND_CALLEE.name)} states a payload the scan cannot read — the scan found ${site.keysFound} — a send states its payload as top-level keys, which is what the capture-path table's ${CAPTURE_PAYLOAD_COLUMN} cell is held to, so a shape that hides a name is refused rather than read as a shorter set`); // prettier-ignore
  }

  // The sender statement is the doctrine the send leg holds, so it is read
  // ahead of the vacuous return: a doc edit that broke the tables and took the
  // statement with it must say both things. Written fail-closed on the
  // `!(n >= 1)` form the shared rule states (`emptySurfaceProblems` in
  // scripts/check-test-inventory.js) — a surface that states no count is a
  // surface that proved nothing.
  if (!(s.senderStatements >= 1)) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} states no sender statement — nothing in the clause's scope carries "${SENDER_STATEMENT_ANCHOR}" — the panel-side closure this check's send leg holds (every panel-protocol type carrying at least one object-literal ${PANEL_SEND_CALLEE.name}( that names it) is doctrine the clause states, and the leg cannot hold a rule the document no longer makes`); // prettier-ignore
  } else if (s.senderStatements > 1) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} makes the "${SENDER_STATEMENT_ANCHOR}" claim ${s.senderStatements} times — the clause states it once, so an update cannot land on one copy and leave another standing, wherever in the clause that copy was written`); // prettier-ignore
  }

  // The recorder's own existence claim is the doctrine the FORWARD type diff
  // holds — every type the capture-path table states is sent — and it is held
  // present beside the payload grammar it shares a paragraph with, for the reason
  // the panel's statement is: the diff cannot go on holding a claim the document
  // has stopped making, and an update cannot land on one copy of it while another
  // stands. Written fail-closed on the `!(n >= 1)` form.
  if (!(s.recorderStatements >= 1)) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} states no capture-path sender statement — nothing in the clause's scope carries "${RECORDER_STATEMENT_ANCHOR}" — the capture-path closure this check's forward type diff holds (every type the table states carrying at least one object-literal ${CAPTURE_SEND_CALLEE.name}( that names it) is doctrine the clause states, and the leg cannot hold a rule the document no longer makes`); // prettier-ignore
  } else if (s.recorderStatements > 1) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} makes the "${RECORDER_STATEMENT_ANCHOR}" claim ${s.recorderStatements} times — the clause states it once, so an update cannot land on one copy and leave another standing, wherever in the clause that copy was written`); // prettier-ignore
  }

  // The capture-path grammar is the doctrine the payload weld reads cells by,
  // and it names the marker this check accepts. Held the way the two statements
  // beside it are, and for their reason: the weld refuses every cell outside that
  // grammar, so a clause that stops stating it — or that states it twice, where
  // an update can land on one copy — leaves the reader enforcing a rule the
  // document no longer makes. Written fail-closed on the `!(n >= 1)` form.
  if (!(s.capturePayloadGrammarStatements >= 1)) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} states no capture-path payload grammar — nothing in the clause's scope carries "${CAPTURE_PAYLOAD_GRAMMAR_ANCHOR}" — the capture-path table's ${CAPTURE_PAYLOAD_COLUMN} column is read as key names rather than prose, and the marker for a message that carries no payload is doctrine the clause states, which this check's cell reader cannot hold once the document stops stating it`); // prettier-ignore
  } else if (s.capturePayloadGrammarStatements > 1) {
    problems.push(`${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID} makes the "${CAPTURE_PAYLOAD_GRAMMAR_ANCHOR}" claim ${s.capturePayloadGrammarStatements} times — the clause states it once, so an update cannot land on one copy and leave another standing, wherever in the clause that copy was written`); // prettier-ignore
  }

  // The reach-cell grammar is the doctrine the Reaches leg reads cells by, and
  // it names the marker this check accepts. Held the same way and for the same
  // reason: the leg refuses every cell outside that grammar, so a clause that
  // stops stating it — or that states it twice, where an update can land on one
  // copy — leaves the reader enforcing a rule the document no longer makes.
  if (!(s.reachGrammarStatements >= 1)) {
    problems.push(`${RUNTIME_DOC_PATH} §${HANDLE_CLAUSE_ID} states no reach-cell grammar — nothing in the clause's scope carries "${REACH_GRAMMAR_ANCHOR}" — the Reaches column is read as names rather than prose, and the marker for a member that reaches no worker binding is doctrine the clause states, which this check's cell reader cannot hold once the document stops stating it`); // prettier-ignore
  } else if (s.reachGrammarStatements > 1) {
    problems.push(`${RUNTIME_DOC_PATH} §${HANDLE_CLAUSE_ID} makes the "${REACH_GRAMMAR_ANCHOR}" claim ${s.reachGrammarStatements} times — the clause states it once, so an update cannot land on one copy and leave another standing, wherever in the clause that copy was written`); // prettier-ignore
  }

  // The closure sentence is the doctrine the per-member weld is the enforcement
  // of: it is what makes a row the allowed set for its own member rather than a
  // note beside the handle. Held the same way and for the same reason — the weld
  // reds a row and a body that disagree in either direction, which a clause that
  // has stopped stating the closure no longer asks for — and the reds themselves
  // quote this constant, so a clause reworded past it cannot leave them standing.
  if (!(s.closureStatements >= 1)) {
    problems.push(`${RUNTIME_DOC_PATH} §${HANDLE_CLAUSE_ID} states no closure sentence — nothing in the clause's scope carries "${HANDLE_CLOSURE_ANCHOR}" — the per-member weld this check holds (each row read against its member's body in both directions, the row standing as that member's allowed set) is doctrine the clause states, and the leg cannot hold a rule the document no longer makes`); // prettier-ignore
  } else if (s.closureStatements > 1) {
    problems.push(`${RUNTIME_DOC_PATH} §${HANDLE_CLAUSE_ID} makes the "${HANDLE_CLOSURE_ANCHOR}" claim ${s.closureStatements} times — the clause states it once, so an update cannot land on one copy and leave another standing, wherever in the clause that copy was written`); // prettier-ignore
  }

  // The handle is assigned once and read from no production module, which is
  // what the mention count holds: the observers that do reach it live under the
  // package's tests tree, outside this population. Read ahead of the vacuous
  // return, because a production route into the plants and wipes is a fact
  // about the shipped extension whatever the doc's tables parse to.
  for (const { path, count } of s.handleMentions) {
    if (path === WORKER_PATH) {
      if (count > 1) {
        problems.push(`${WORKER_PATH} names \`${HANDLE_NAME}\` ${count} times — the assignment is its one occurrence, so a further one is a production route into the plants and wipes ${HANDLE_CLAUSE_ID} states run from no production event`); // prettier-ignore
      }
      continue;
    }
    problems.push(`${path} names \`${HANDLE_NAME}\` (${count}) — no module of the extension's production JavaScript names the handle beside the assignment in ${WORKER_PATH}: ${HANDLE_CLAUSE_ID} states its plants and wipes run from no production event, and the observers that do reach it sit under ${PRODUCTION_POPULATION_TEST_TREE}, outside this population`); // prettier-ignore
  }

  // The population is the dispatcher legs' own subject. An empty one, or one
  // that has lost the service worker, means the file list stopped naming what
  // it exists to hold — a broken read of the surface, not a surface that went
  // quiet — and the diffs below would then run over a population that is not
  // the one claimed. Its own diagnosis is what such a tree must print, in place
  // of the empty-parse lines that would blame the dispatcher for it.
  const machinery = [];
  if (s.backgroundFiles.length === 0) {
    machinery.push(`no tracked JavaScript module found under ${BACKGROUND_ROOT} — the dispatcher closure has no population to hold`); // prettier-ignore
  }
  // The send leg's own population, held the same way: an empty one means the
  // panel file list stopped naming what the leg exists to read, which is a
  // broken read rather than a panel that sends nothing. No member is required
  // of it — the leg stands on no single panel module the way the forward
  // capture-path diff stands on the worker — so emptiness is the whole guard.
  if (s.panelFiles.length === 0) {
    machinery.push(`no tracked JavaScript module found under ${PANEL_DIR} — the panel's send closure has no population to read`); // prettier-ignore
  }
  // The capture path's own population, held the same way and for the same
  // reason: an empty one means the content file list stopped naming what the
  // weld exists to read, which is a broken read rather than a recorder that
  // sends nothing. No member is required of it — the weld stands on no single
  // content module — so emptiness is the whole guard.
  if (s.contentFiles.length === 0) {
    machinery.push(`no tracked JavaScript module found under ${CONTENT_DIR} — the content-side capture-path read has no population to scan`); // prettier-ignore
  }
  if (!s.backgroundFiles.includes(WORKER_PATH)) {
    // Deliberately beside the extractor's location refusal, which a tree can
    // draw at the same time: this line states that the POPULATION lost the file
    // the forward diff stands on, and that one states where the dispatcher
    // actually sits. Two facts, two lines.
    machinery.push(`${WORKER_PATH} is outside the scanned population — the forward capture-path diff reads that file's own guards by construction, so a population without it is a population this check cannot stand on`); // prettier-ignore
  }
  // The handle's own population, held the same way and for the same reason: its
  // one legitimate occurrence stands in the worker, so a set that has lost that
  // file cannot tell a handle nothing reads from a handle nothing scanned.
  if (s.productionFiles.length === 0) {
    machinery.push(`no tracked JavaScript module found under ${PRODUCTION_POPULATION_ROOT} outside ${PRODUCTION_POPULATION_TEST_TREE} — the handle's no-production-caller leg has no population to hold`); // prettier-ignore
  }
  if (!s.productionFiles.includes(WORKER_PATH)) {
    machinery.push(`${WORKER_PATH} is outside the production population — the handle's one legitimate occurrence stands in that file, so a population without it reads a mention count that proves nothing`); // prettier-ignore
  }
  if (machinery.length) return [...problems, ...machinery];

  // The surface is stated as one table, counted over the whole document: a
  // second one carrying the same header would state the enumeration twice, and
  // an update could then land on one copy. Fail-closed on the `!== 1` form — a
  // surface stating no count at all reds here rather than passing.
  if (s.handleTableMatches !== 1) {
    problems.push(`${RUNTIME_DOC_PATH} carries ${s.handleTableMatches} tables headed ${HANDLE_TABLE_HEADER.join(' | ')} — the handle's member surface is stated as exactly one table, and ${HANDLE_CLAUSE_ID}'s own scope is where this check reads it`); // prettier-ignore
  }

  const empty = emptySurfaceProblems(s, EMPTY_SURFACES);
  if (empty.length > 0) {
    problems.push(...empty);
    return problems; // empty parses make set diffs meaningless
  }

  problems.push(...duplicateSurfaceProblems(s, DUPLICATE_SURFACES));

  problems.push(
    ...missingFrom(s.manifestPermissions, s.docPermissions, `is requested in ${MANIFEST_PATH} but the Permissions table does not document it (${EPM_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.docPermissions, s.manifestPermissions, `is documented in the Permissions table but ${MANIFEST_PATH} does not request it`), // prettier-ignore
    ...missingFrom(s.manifestHostPermissions, s.docHostPermissions, `is requested in ${MANIFEST_PATH} but the Host permissions table does not document it (${EPM_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.docHostPermissions, s.manifestHostPermissions, `is documented in the Host permissions table but ${MANIFEST_PATH} does not request it`), // prettier-ignore
    ...missingFrom(s.docPanelTypes, s.caseLabels, `is in the panel-protocol enumeration but the dispatcher switch has no case servicing it (${ERT_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.caseLabels, s.docPanelTypes, `is serviced by the dispatcher switch but the panel-protocol enumeration does not state it`), // prettier-ignore
    // The capture-path pair is deliberately ASYMMETRIC. Forward, the table is
    // held to the worker's OWN guards: ERT-4 states those types are serviced by
    // the listener's dedicated guards, so deleting the worker's guard reds even
    // where a copy of it survives in another module. Reverse, the whole
    // population answers: a guard on a type the table does not state is drift
    // wherever it was written.
    ...missingFrom(s.docCaptureTypes, s.workerEqualityTypes, `is in the capture-path table but no equality guard in ${WORKER_PATH} services it (${ERT_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.sendTypes, s.docPanelTypes, `is sent by the panel but the panel-protocol enumeration does not state it (${ERT_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.docPanelTypes, s.sendTypes, `is in the panel-protocol enumeration but no object-literal ${PANEL_SEND_CALLEE.name}( in the tracked ${PANEL_DIR} JavaScript sends it (${ERT_CLAUSE_ID}) — a type sent only through a payload assembled beforehand is invisible to this leg and reds here too, which this direction cannot tell from a type nothing sends: moving a send outside the object-literal shape is a change that updates the runtime doc's sender statement and this check together`), // prettier-ignore
  );

  // The reverse direction, written as a loop rather than a set diff so the
  // refusal can name the module the guard stands in: the diff's own answer is
  // the tree, and a reader given the tree has to search it.
  for (const type of s.equalityTypes) {
    if (s.docCaptureTypes.includes(type)) continue;
    const homes = [...new Set(s.equalitySites.filter((site) => site.type === type).map((site) => site.path))]; // prettier-ignore
    problems.push(`\`${type}\` is serviced by an equality guard in ${homes.join(', ')} but the capture-path table does not state it`); // prettier-ignore
  }

  // The capture path's SENDER side, welded per send site. The pair above holds the
  // table against the worker's guards — who services a message; this holds it
  // against the content scripts that send one: every type the table states is
  // sent, every type sent is stated, and a type's Payload cell states exactly
  // the top-level keys its sends carry.
  problems.push(
    ...missingFrom(s.docCaptureTypes, s.captureSendTypes, `is in the capture-path table but no object-literal ${CAPTURE_SEND_CALLEE.name}( in the tracked ${CONTENT_DIR} JavaScript sends it (${ERT_CLAUSE_ID}) — a type sent only through a payload assembled beforehand is invisible to this leg and reds here too, which this direction cannot tell from a type nothing sends: moving a send outside the object-literal shape is a change that updates the capture-path table and this check together`), // prettier-ignore
    ...missingFrom(s.captureSendTypes, s.docCaptureTypes, `is sent by an object-literal ${CAPTURE_SEND_CALLEE.name}( in the tracked ${CONTENT_DIR} JavaScript but the capture-path table does not state it (${ERT_CLAUSE_ID})`), // prettier-ignore
  );

  // The hold is per SEND SITE: each readable site whose type the table states is
  // held to that type's row in both directions, and the red names the site it is
  // about. Two IDENTICAL copies of one send — the block two content modules
  // share, kept in step by a parity test — state the same key set, so each meets
  // the same row and both stay green by construction, while a key added to one
  // copy alone reds on that copy rather than hiding behind its twin.
  //
  // The rows are walked as the table states them, one hold per row, so a type
  // two rows state is held to its senders twice: the repeat's own guard line
  // names the duplication, and each of the two rows names its own disagreement
  // with the senders. That is the residue of holding every row the table
  // states — a second row's statement stands on its own rather than standing
  // behind the first — and it is why this weld adds no duplicate-surface entry
  // and the duplicate guard needs no early return ahead of it.
  for (const { type, keys } of s.docCapturePayloads) {
    for (const site of s.captureSendSites) {
      // A row for a type no readable site sends is already named by the diff
      // above, and there is no send to hold it to, so the key comparisons stay
      // silent rather than asserting a payload no site states — the same silence
      // the handle's weld keeps for a row whose member the handle does not carry.
      // A site whose payload the scan refused is named above, its keys unread
      // rather than read short.
      if (site.type !== type || site.keys === null) continue;
      // Both sides are compared as sets, the row's names sorted for the
      // comparison the way the site's arrive, while the reds quote a cell in the
      // order the document wrote it.
      for (const name of [...keys].sort()) {
        if (site.keys.includes(name)) continue;
        problems.push(`the capture-path row for \`${type}\` states a payload key \`${name}\` that ${sendLabel(site, CAPTURE_SEND_CALLEE.name)} does not carry (it carries ${statesNames(site.keys, CAPTURE_PAYLOAD_NONE_MARKER)}) — a row states the message's whole top-level key set, so a row and a send that disagree are one change left half-made`); // prettier-ignore
      }
      for (const name of site.keys) {
        if (keys.includes(name)) continue;
        problems.push(`\`${type}\` is sent by ${sendLabel(site, CAPTURE_SEND_CALLEE.name)} carrying a top-level \`${name}\` that its capture-path ${CAPTURE_PAYLOAD_COLUMN} cell does not state (the cell states ${statesNames(keys, CAPTURE_PAYLOAD_NONE_MARKER)}) — a row states the message's whole top-level key set, so a key added to the send is added to the row in the same change`); // prettier-ignore
      }
    }
  }

  problems.push(
    ...missingFrom(s.handleMembers, s.docHandleMembers, `is a member of the introspection handle in ${WORKER_PATH} but the ${HANDLE_CLAUSE_ID} member table does not state it (${HANDLE_CLAUSE_ID})`), // prettier-ignore
    ...missingFrom(s.docHandleMembers, s.handleMembers, `is in the ${HANDLE_CLAUSE_ID} member table but the introspection handle in ${WORKER_PATH} does not carry it`), // prettier-ignore
  );

  // The reach leg, a membership test: a member reaching a worker module-scope
  // name outside the stated set reaches a structure the clause does not place
  // the handle over — the change the table alone cannot show, since a member
  // can grow a reach without its name or its row changing at all. It runs
  // whatever the table states, so a member the table has lost is still held to
  // the clause's own set.
  for (const { member, name } of s.handleReaches) {
    if (HANDLE_REACH_SET.includes(name)) continue;
    problems.push(`\`${member}\` reaches \`${name}\`, a module-scope name of ${WORKER_PATH} outside the set ${HANDLE_CLAUSE_ID} places the handle over (${HANDLE_REACH_SET.map((n) => `\`${n}\``).join(', ')}) — a member reaching further is a surface change the clause and this check state together`); // prettier-ignore
  }

  // The WELD, per member and both ways: the clause's closure sentence, held
  // present above, states the row is the allowed set for that member alone.
  // What the union above cannot see is a member reaching a binding another
  // member's row names — a cross-wiring the whole-handle membership test
  // passes, with both rows left saying the opposite.
  const statedReaches = new Map(s.docHandleReaches.map(({ member, names }) => [member, names]));
  const reachedBy = new Map();
  for (const { member, name } of s.handleReaches) {
    if (!reachedBy.has(member)) reachedBy.set(member, []);
    reachedBy.get(member).push(name);
  }
  for (const [member, names] of statedReaches) {
    // A row for a member the handle does not carry is already named by the
    // member diff above, and there is no body to hold that row to, so the BODY
    // comparisons below stay silent rather than asserting a body that is not
    // there — the same way `extractHandleTable` leaves an unreadable member
    // cell to the member column's own refusal, since naming it twice would
    // report one defect as two. The ROW-SIDE placement leg needs no body: it
    // reads the row's own names against the constant, so it runs on every
    // readable row, and a cell naming a binding outside the placement set is
    // refused whether or not the handle still carries its member.
    const carried = s.handleMembers.includes(member);
    const reached = reachedBy.get(member) ?? [];
    for (const name of names) {
      // The table's own bound: a row cannot legalize a reach the clause does
      // not place the handle over. The row's names serve as this member's
      // allowed set unfiltered, and this ROW-SIDE leg is what refuses a name
      // the row states outside the constant — the same name still meets the
      // body comparison in the same run.
      if (!HANDLE_REACH_SET.includes(name)) {
        problems.push(`the ${HANDLE_CLAUSE_ID} row for \`${member}\` states a reach to \`${name}\`, a name outside the set that clause places the handle over (${HANDLE_REACH_SET.map((n) => `\`${n}\``).join(', ')}) — a row states which of those bindings its member reaches, never which bindings the handle may reach at all`); // prettier-ignore
      }
      if (carried && !reached.includes(name)) {
        problems.push(`the ${HANDLE_CLAUSE_ID} row for \`${member}\` states it reaches \`${name}\`, which its body in ${WORKER_PATH} does not name — ${HANDLE_CLOSURE_ANCHOR}, so a row and a body that disagree are one change left half-made`); // prettier-ignore
      }
    }
    if (!carried) continue;
    for (const name of new Set(reached)) {
      if (names.includes(name)) continue;
      problems.push(`\`${member}\` reaches \`${name}\` in ${WORKER_PATH}, which its ${HANDLE_CLAUSE_ID} row does not state (the row states ${statesNames(names, HANDLE_NO_REACH_MARKER)}) — ${HANDLE_CLOSURE_ANCHOR}, and a reach the handle already places elsewhere is no exception`); // prettier-ignore
    }
  }

  const overlap = s.docCaptureTypes.filter((t) => s.docPanelTypes.includes(t));
  for (const t of overlap) {
    problems.push(`\`${t}\` appears in both the capture-path table and the panel-protocol enumeration — the two are disjoint by ${ERT_CLAUSE_ID}`); // prettier-ignore
  }

  return problems;
}

/**
 * Read every surface from the working tree and evaluate every contract.
 *
 * Every file list is passed in rather than derived here, so the suite can hold
 * this closure over populations it states — the shape the sibling capture
 * check's file-list leg already has. Over the real tree the callers pass the
 * derivations these legs stand on: the panel tree's
 * ({@link derivePanelPopulation}) for the panel modules the send scan reads,
 * the background tree's ({@link derivePopulation}) for the background modules
 * the dispatcher legs read, the content tree's
 * ({@link deriveContentPopulation}) for the modules the capture-path send scan
 * reads, and the production set's, imported from
 * [`check-capture-surface.js`](./check-capture-surface.js) for the handle's
 * mention count. None is re-derived here or anywhere else in this file.
 * @param {(f: string) => string} readFile repo-relative content reader
 * @param {string[]} panelFiles the tracked panel JavaScript paths the send
 *   scan reads
 * @param {string[]} backgroundFiles the tracked background JavaScript the
 *   dispatcher legs scan
 * @param {string[]} productionFiles the extension package's tracked production
 *   JavaScript, which the handle's no-production-caller leg counts over
 * @param {string[]} contentFiles the tracked content JavaScript the capture-path
 *   send scan reads
 * @returns {{ problems: string[], permissionCount: number, typeCount: number, panelTypeCount: number, captureTypeCount: number, memberCount: number }}
 *   `typeCount` is the doc's whole message-type union — the surface the
 *   dispatcher legs cover — `panelTypeCount` the panel-protocol subset the
 *   sender leg covers, `captureTypeCount` the capture-path subset the payload
 *   weld covers, and `memberCount` the handle members the third contract holds
 */
export function auditTree(readFile, panelFiles, backgroundFiles, productionFiles, contentFiles) {
  const manifest = extractManifestSurface(readFile(MANIFEST_PATH));
  const permDoc = readFile(PERMISSIONS_DOC_PATH);
  const [permissions, hostPermissions] = PERMISSION_TABLES.map(([section, header]) =>
    extractSectionTableNames(permDoc, section, header),
  );
  const runtimeDoc = readFile(RUNTIME_DOC_PATH);
  const protocol = extractProtocolTables(runtimeDoc);
  const dispatcher = extractDispatcherSurface(new Map(backgroundFiles.map((p) => [p, readFile(p)]))); // prettier-ignore
  const sendSites = extractSendSites(new Map(panelFiles.map((p) => [p, readFile(p)])));
  const captureSendSites = extractSendSites(new Map(contentFiles.map((p) => [p, readFile(p)])), CAPTURE_SEND_CALLEE); // prettier-ignore
  const capturePayloads = extractCapturePayloads(runtimeDoc);
  const handle = extractHandleSurface(readFile(WORKER_PATH));
  const handleTable = extractHandleTable(runtimeDoc);
  const handleMentions = countHandleMentions(new Map(productionFiles.map((p) => [p, readFile(p)]))); // prettier-ignore

  const s = {
    manifestPermissions: manifest.permissions,
    manifestHostPermissions: manifest.hostPermissions,
    docPermissions: permissions.names,
    docHostPermissions: hostPermissions.names,
    permissionsUnreadable: [...permissions.unreadable, ...hostPermissions.unreadable],
    docCaptureTypes: protocol.captureTypes,
    docPanelTypes: protocol.panelTypes,
    protocolUnreadable: protocol.unreadable,
    backgroundFiles,
    caseLabels: dispatcher.caseLabels,
    equalityTypes: dispatcher.equalityTypes,
    equalitySites: dispatcher.equalitySites,
    workerEqualityTypes: dispatcher.workerEqualityTypes,
    panelFiles,
    sendTypes: [...new Set(sendSites.filter((x) => x.type !== null).map((x) => x.type))],
    sendSites,
    docCapturePayloads: capturePayloads.payloads,
    capturePayloadUnreadable: capturePayloads.unreadable,
    contentFiles,
    captureSendTypes: [...new Set(captureSendSites.filter((x) => x.type !== null).map((x) => x.type))], // prettier-ignore
    captureSendSites,
    senderStatements: countSenderStatements(runtimeDoc),
    recorderStatements: countRecorderStatements(runtimeDoc),
    capturePayloadGrammarStatements: countCapturePayloadGrammarStatements(runtimeDoc),
    reachGrammarStatements: countReachGrammarStatements(runtimeDoc),
    closureStatements: countClosureStatements(runtimeDoc),
    handleMembers: handle.members,
    docHandleMembers: handleTable.members,
    handleUnreadable: handleTable.unreadable,
    handleReachUnreadable: handleTable.reachUnreadable,
    handleTableMatches: handleTable.matches,
    handleReaches: handle.reaches,
    docHandleReaches: handleTable.reaches,
    productionFiles,
    handleMentions,
  };
  return {
    problems: [
      ...manifest.problems,
      ...dispatcher.problems,
      ...handle.problems,
      ...evaluateExtensionSurface(s),
    ],
    permissionCount: new Set([...s.manifestPermissions, ...s.manifestHostPermissions]).size,
    typeCount: new Set([...s.docCaptureTypes, ...s.docPanelTypes]).size,
    panelTypeCount: new Set(s.docPanelTypes).size,
    captureTypeCount: new Set(s.docCaptureTypes).size,
    memberCount: new Set(s.docHandleMembers).size,
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
  const panelFiles = derivePanelPopulation();
  const backgroundFiles = derivePopulation();
  const productionFiles = deriveProductionPopulation();
  const contentFiles = deriveContentPopulation();
  const { problems, permissionCount, typeCount, panelTypeCount, captureTypeCount, memberCount } =
    auditTree(readFile, panelFiles, backgroundFiles, productionFiles, contentFiles);

  if (problems.length) {
    console.error(
      formatProblemBlock(
        'the extension surface drifted from its committed contracts',
        problems,
        `  The manifest's permission surface and the Permissions / Host permissions tables\n` +
          `  must state the same sets (${PERMISSIONS_DOC_PATH} §${EPM_CLAUSE_ID}); the dispatcher's\n` +
          `  serviced message types, the panel's literal sends, and the runtime doc's\n` +
          `  capture-path and panel-protocol enumerations must state the same sets\n` +
          `  (${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID}); and the capture-path table's types and\n` +
          `  ${CAPTURE_PAYLOAD_COLUMN} key sets must state what the literal sends the tracked\n` +
          `  ${CONTENT_DIR} JavaScript makes carry\n` +
          `  (${RUNTIME_DOC_PATH} §${ERT_CLAUSE_ID}).\n` +
          `  The dispatcher legs read the tracked ${POPULATION_EXTENSIONS.join('/')} modules under\n` +
          `  ${BACKGROUND_ROOT}: one dispatcher switch stands in that set,\n` +
          `  in ${WORKER_PATH}, whose own guards the\n` +
          `  capture-path table is held to, while a guard anywhere in the set is held\n` +
          `  back to that table.\n` +
          `  The introspection handle the worker freezes onto its own global must state the\n` +
          `  same members as the §${HANDLE_CLAUSE_ID} table, reach only the worker bindings that\n` +
          `  clause places it over, hold each member's module-scope reaches — the worker\n` +
          `  bindings its own body names — matching its own row, and be named nowhere\n` +
          `  else in the tracked ${POPULATION_EXTENSIONS.join('/')} modules ${PRODUCTION_POPULATION_ROOT} carries\n` +
          `  outside ${PRODUCTION_POPULATION_TEST_TREE}.\n` +
          `  Update the drifted surfaces together in the same change.\n`,
      ),
    );
    process.exit(1);
  }
  console.log(
    `✓ extension surface consistent: ${permissionCount} permissions match the doc tables; ` +
      `${typeCount} message types agree between the runtime doc and the dispatcher surface ` +
      `read from the tracked ${BACKGROUND_ROOT} JavaScript, ` +
      `and its ${panelTypeCount} panel-protocol types agree with the panel's literal sends, ` +
      `whose closure the clause's own scope states once; ` +
      `its ${captureTypeCount} capture-path types agree with the literal sends the tracked ` +
      `${CONTENT_DIR} JavaScript makes, each carrying the top-level payload keys its own row states; ` +
      `${memberCount} introspection-handle members match the §${HANDLE_CLAUSE_ID} table, ` +
      `reaching only the worker bindings that clause places the handle over, ` +
      `each member's module-scope reaches — the worker bindings its own body names — ` +
      `matching its own row, ` +
      `and named in no other of the tracked ${POPULATION_EXTENSIONS.join('/')} modules ` +
      `${PRODUCTION_POPULATION_ROOT} carries outside ${PRODUCTION_POPULATION_TEST_TREE}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
