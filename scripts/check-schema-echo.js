/**
 * check-schema-echo.js — admission test for the session-format document's
 * echo contract against the schemas that define the format:
 *
 *   - authority statements (docs/technical/session-format.md §SF-1): every
 *     registered surface that restates which side governs still carries its
 *     claim, so a rewrite that drops one leaves the ordering asserted
 *     somewhere else rather than nowhere; and the register agrees with the
 *     clause row that discloses it;
 *   - the unknown-key posture (§SF-14): every object subschema of every
 *     composed platform declares the posture its class states — action
 *     objects open, the user-defined `metadata` map open with typed values,
 *     the discriminating wrappers silent, every other object closed. No
 *     exemption rests on a name alone: a wrapper must still discriminate, the
 *     action wrapper must select exactly the defs the prefix grants openness
 *     to, and each metadata host must reference the one map definition;
 *   - the field tables: each registered table's field names, its `yes` rows
 *     and its `one of` rows equal the composed def's `properties`,
 *     `required`, and `anyOf` branches — both directions, every platform, and
 *     the platforms held to the same shared def — over a table set the
 *     document cannot grow silently: every `Field`-headed table it carries is
 *     either a registered leg or a registered review-held entry, held both
 *     ways.
 *
 * Schemas are composed IN-PROCESS from the source layers through
 * `composePlatform` ([`build-schemas.js`](./build-schemas.js)). The published
 * copies under `schemas/dist/` are release output that deliberately lags the
 * source layers between releases and are never read here.
 *
 * Every parsed surface must be non-empty, an unreadable table cell is refused
 * rather than skipped, a table whose Required column moved or whose section
 * and header no longer select exactly one table is refused by name, and a def
 * the posture model exempts must still have the shape the exemption rests on
 * — a broken read fails loudly instead of passing vacuously. A def outside
 * every registered class is judged as a closed object, so it must declare
 * `additionalProperties: false` like the rest.
 *
 * Honest limits, and where each one's residue is held instead:
 *
 *   - the prose MEANING of an authority statement is review-held — the leg
 *     pins that the claim is still made on each registered surface, never
 *     that the surfaces word it equivalently, and a surface outside
 *     `AUTHORITY_SURFACES` is outside the leg;
 *   - the posture MODEL is stated here (`POSTURE_CLASSES` and the def
 *     registries beside it) and held against the schemas, in that direction
 *     only. The check never reads the posture clause's sentence, so whether
 *     the model and that sentence still say the same thing is a review
 *     judgment on any change to either — the direction a prose-parsing leg
 *     would close, at the cost of reading normative prose as data;
 *   - the walk reaches an object subschema when it states `type: "object"` or
 *     carries a `properties` key and sits under one of the keywords in
 *     `TRAVERSED_KEYWORDS` (derived from the shapes the walk handles). A
 *     schema written outside that reach is not judged at all rather than
 *     judged loudly, so widening the schemas' vocabulary widens the walk too;
 *   - the field-table legs read names, required status, and the `one of`
 *     marking. `one of` is held as the branch shape the phrase means — one
 *     `anyOf` branch per marked field, each requiring that field alone — so a
 *     collapsed branch demanding several at once reds rather than passing on
 *     the union. A row's Type and Description columns are review-held, as are
 *     the document's prose echoes of field semantics. `UNHELD_FIELD_TABLES`
 *     carries the field tables no def answers, each with its reason, and the
 *     coverage leg holds that register honest in both directions;
 *   - what the field-table legs close over is the `Field`-headed shape in
 *     this one document; a table the document carries in another shape, and
 *     the format's echoes in other documents, are outside this check. Where a
 *     table's section and first header cell are shared by a sibling, the
 *     one-table selection could not address it even if it were registered.
 *
 * Usage:
 *   node scripts/check-schema-echo.js  # or: npm run lint:schema-echo
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLATFORMS, composePlatform } from './build-schemas.js';
import {
  backtickedName,
  duplicatesIn,
  missingFrom,
  parseTables,
  stripFences,
} from './check-test-inventory.js';

/** Repo-relative path of the document whose echoes this check holds. */
export const SESSION_FORMAT_DOC_PATH = 'docs/technical/session-format.md';
/** The authority-ordering clause the statement leg verifies. */
export const AUTHORITY_CLAUSE_ID = 'SF-1';
/** The unknown-key posture clause the posture walk verifies. */
export const POSTURE_CLAUSE_ID = 'SF-14';
/** Repo-relative path of the registry whose rows name these checks. */
export const CLAUSE_REGISTRY_PATH = 'docs/clause-registry.json';
/**
 * The platforms whose schemas are composed and compared — derived from the
 * composer's own chain declarations, so a surface that gains a layer chain
 * enters this check's legs with it rather than waiting to be hand-added.
 */
export const PLATFORM_IDS = Object.keys(PLATFORMS);

/**
 * The surfaces that restate the schemas' authority over the prose, each with
 * the claim it must still carry. Matched against the surface's text with
 * fences stripped and whitespace collapsed, so a re-wrap or a re-fill can
 * never red a claim that is still made. Exported so the suite's family is
 * generated from this list — a surface added here is exercised
 * automatically, and the suite holds the list non-empty and its entries
 * pairwise distinct.
 */
export const AUTHORITY_SURFACES = [
  [
    SESSION_FORMAT_DOC_PATH,
    /Where this prose and a schema disagree, the schema governs/,
    'the authority-ordering statement itself',
  ],
  [
    'docs/README.md',
    /\[JSON Schemas\]\([^)]*\) are the authoritative source of truth/,
    "the documentation map naming the schemas the format's source of truth",
  ],
  [
    'README.md',
    /defined by per-platform JSON Schemas — the single source of truth/,
    'the root README naming the schemas the format definition',
  ],
  [
    'docs/requirements/replay-sufficiency.md',
    /Field semantics are defined by the per-platform schemas/,
    'the sufficiency principle deferring field semantics to the schemas',
  ],
  [
    'docs/api/dispatch.md',
    /is defined by the per-platform \[JSON Schemas\]/,
    'the dispatch specification deferring the payload data to the schemas',
  ],
  [
    'docs/api/sync-protocol.md',
    /the per-platform schemas define it authoritatively/,
    'the sync protocol deferring the step structure to the schemas',
  ],
  [
    'reference-implementations/sync-server/README.md',
    /whose schemas define the `Full_Project_Payload` shape/,
    "the reference server's index deferring the payload shape to the schemas",
  ],
];

/**
 * The field tables held against a composed def: `[section, headerCell,
 * defName, label]`. A table is selected by its `##` section AND its first
 * header cell — the house pattern — and exactly one table must match, so a
 * sibling table under the same heading is never conscripted or silently
 * merged. `parseTables` tags a table with its `##` section, so the Step
 * fields table (a `###` under Steps) carries the section `Steps`. Exported
 * so the suite's family is generated from this list.
 */
export const FIELD_TABLE_LEGS = [
  ['Format stamp', 'Field', 'docent_format', 'the format-stamp table'],
  ['Project', 'Field', 'project', 'the project table'],
  ['Recording', 'Field', 'recording', 'the recording table'],
  ['Steps', 'Field', 'step', 'the step-fields table'],
  ['Element', 'Field', 'element', 'the element table'],
];

/**
 * The first header cell that marks a table as a field table — the shape the
 * legs close over.
 */
export const FIELD_TABLE_HEADER = 'Field';

/**
 * The field tables held by review rather than by a leg, each with the reason
 * no def answers it: `[section, headerCell, reason]`. Together with
 * {@link FIELD_TABLE_LEGS} this closes the document's field-table set — the
 * coverage leg holds both directions, so a new field table must join one list
 * or the other, and an entry naming a table the document no longer carries is
 * refused as stale.
 */
export const UNHELD_FIELD_TABLES = [
  ['Actions', FIELD_TABLE_HEADER, 'the fields it lists live on every action def rather than one, and it carries no Required column'], // prettier-ignore
  ['Locator candidates (`locators`)', FIELD_TABLE_HEADER, 'its fields are the locator wrapper plus what every strategy member shares, which no single def states'], // prettier-ignore
];

/** The Required column's index in every registered field table. */
export const REQUIRED_COLUMN = 2;
/** The header cell that column must carry. */
export const REQUIRED_HEADER = 'Required';
/** Required cell: the field is in the def's `required` array. */
export const REQUIRED_YES = 'yes';
/** Required cell: the field is absent from `required`. */
export const REQUIRED_NO = 'no';
/** Required cell: the field is required by one `anyOf` branch. */
export const REQUIRED_ONE_OF = 'one of';
/** The complete Required vocabulary; any other cell is unreadable. */
export const REQUIRED_VOCABULARY = [REQUIRED_YES, REQUIRED_NO, REQUIRED_ONE_OF];

/** The `$defs` prefix marking a concrete action object. */
export const ACTION_DEF_PREFIX = 'action_';
/**
 * The discriminating wrappers: a `$def` whose own `properties` carry the
 * common fields while a `oneOf` selects the concrete member. Closing one
 * would reject the member's own fields, so the posture belongs to the member,
 * not the wrapper. Named rather than inferred, so a NEW wrapper reds as a
 * closed object that lost its `additionalProperties` and forces the decision
 * into the open.
 */
export const WRAPPER_DEFS = ['action', 'locator'];
/**
 * The wrapper whose members are exactly the defs carrying
 * {@link ACTION_DEF_PREFIX}, held both ways so the open posture the prefix
 * grants cannot be claimed by a def the wrapper does not select, and an
 * action def cannot fall out of the wrapper unnoticed. The locator wrapper
 * has no equivalent leg: its member names share their prefix with the shared
 * property defs (`locator_match_count` and its siblings), so membership there
 * is not derivable from the name.
 */
export const ACTION_WRAPPER_DEF = 'action';
/** The `$def` holding the user-defined key-value map. */
export const METADATA_DEF = 'metadata';
/**
 * The defs whose `metadata` property must reference that map, and the
 * reference form they must use. The composition states the map once and
 * refers to it, so an inline copy is refused rather than accepted as an
 * equivalent: two spellings of one contract drift, and the posture walk
 * judges the shared def, not a copy of it.
 */
export const METADATA_HOSTS = ['project', 'recording'];
/** The reference every metadata host's property must carry. */
export const METADATA_REF = `#/$defs/${METADATA_DEF}`;
/**
 * The keywords a value schema can use to state what a metadata value may be.
 * The map is open by design, so its exemption rests on the values still being
 * typed — an empty schema accepts anything and is refused.
 */
export const VALUE_CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'anyOf', 'allOf', 'enum', 'const', '$ref']; // prettier-ignore

/**
 * The posture classes and the declaration each one requires. Exported so the
 * suite exercises one red path per class and holds the requirements pairwise
 * distinct.
 */
export const POSTURE_CLASSES = [
  ['wrapper', 'must declare no additionalProperties — the member the wrapper selects carries the posture'], // prettier-ignore
  ['action', `must declare no additionalProperties — they are the additive evolution surface (§${POSTURE_CLAUSE_ID})`], // prettier-ignore
  ['metadata-map', `must declare an additionalProperties schema that states what a value may be — arbitrary keys, typed values (§${POSTURE_CLAUSE_ID})`], // prettier-ignore
  ['closed', `must declare additionalProperties: false — every other object is closed (§${POSTURE_CLAUSE_ID})`], // prettier-ignore
];

const MAP_KEYWORDS = ['properties', 'patternProperties', '$defs'];
const LIST_KEYWORDS = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];
const NODE_KEYWORDS = ['items', 'additionalProperties', 'not'];

/**
 * The composition keywords the posture walk descends through, derived from the
 * keyword groups the walk handles rather than restated — a keyword the walk
 * gains or loses moves this published list with it. A schema built with a
 * keyword outside the set would hide object subschemas from the walk, so this
 * list is the walk's stated reach.
 */
export const TRAVERSED_KEYWORDS = [...MAP_KEYWORDS, ...LIST_KEYWORDS, ...NODE_KEYWORDS];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Collapse a document to matchable prose: fenced blocks blanked (the one
 * fence model the doc-scanning checks share) and every whitespace run — line
 * breaks included — collapsed to a single space, so a claim that survives a
 * re-wrap still matches.
 * @param {string} docText
 * @returns {string}
 */
export function normalizeProse(docText) {
  return stripFences(docText ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read one field table: its rows as `{ field, required }`, the cells the
 * reader refuses, and its own anchor problems (no table, more than one, a
 * moved Required column).
 * @param {string} docText the session-format document's text
 * @param {string} section the `##` section the table sits in
 * @param {string} headerCell the table's first header cell
 * @param {string} label how the leg names the table in a diagnosis
 * @returns {{ rows: { field: string, required: string }[], unreadable: string[], problems: string[] }}
 */
export function extractFieldTable(docText, section, headerCell, label) {
  const matched = parseTables(docText).filter(
    (t) => t.section === section && (t.header[0] ?? '').trim() === headerCell,
  );
  if (matched.length !== 1) {
    return { rows: [], unreadable: [], problems: [`${SESSION_FORMAT_DOC_PATH} carries ${matched.length} tables under "${section}" leading with "${headerCell}" — ${label} models exactly one`] }; // prettier-ignore
  }
  const table = matched[0];
  const problems = [];
  const headerAt = (table.header[REQUIRED_COLUMN] ?? '').trim();
  if (headerAt !== REQUIRED_HEADER) {
    problems.push(`${label}'s column ${REQUIRED_COLUMN} is headed "${headerAt}", not "${REQUIRED_HEADER}" — the required read cannot run`); // prettier-ignore
    return { rows: [], unreadable: [], problems };
  }
  const rows = [];
  const unreadable = [];
  for (const row of table.rows) {
    const field = backtickedName(row[0] ?? '');
    const required = (row[REQUIRED_COLUMN] ?? '').trim();
    if (field === null) {
      unreadable.push(`${label} first cell — ${(row[0] ?? '').trim() || '(empty)'} — rows lead with a lone backticked field name`); // prettier-ignore
      continue;
    }
    if (!REQUIRED_VOCABULARY.includes(required)) {
      unreadable.push(`${label} Required cell for \`${field}\` — ${required || '(empty)'} — the vocabulary is ${REQUIRED_VOCABULARY.map((v) => `"${v}"`).join(', ')}`); // prettier-ignore
      continue;
    }
    rows.push({ field, required });
  }
  return { rows, unreadable, problems };
}

/**
 * Every field table the document carries, each keyed `<section> / <header>` —
 * the set the coverage leg closes over, so a field table that joins the
 * document must join a leg or the unheld register.
 * @param {string} docText the session-format document's text
 * @returns {string[]}
 */
export function extractFieldTableKeys(docText) {
  return parseTables(docText)
    .filter((table) => (table.header[0] ?? '').trim() === FIELD_TABLE_HEADER)
    .map((table) => fieldTableKey(table.section ?? '(no section)', FIELD_TABLE_HEADER));
}

/**
 * The coverage leg's key for one field table.
 * @param {string} section
 * @param {string} headerCell
 * @returns {string}
 */
export function fieldTableKey(section, headerCell) {
  return `${section} / ${headerCell}`;
}

/**
 * Every field table the registers account for — the held legs plus the
 * review-held entries. The one derivation, so the coverage leg and the suite
 * cannot disagree about what "registered" means.
 * @returns {string[]}
 */
export function registeredFieldTableKeys() {
  return [...FIELD_TABLE_LEGS, ...UNHELD_FIELD_TABLES].map(([section, header]) =>
    fieldTableKey(section, header),
  );
}

/**
 * A citation candidate, in the WIDE shape
 * [`check-clause-governance.js`](./check-clause-governance.js) reads over the
 * same registry rows: its last segment admits the glob and brace
 * metacharacters a citation may legitimately carry elsewhere in the registry.
 */
const CITED_CANDIDATE_RE = /(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.*{},[\]]+\.[A-Za-z0-9]+/g;

/** The subset of that shape this leg models: a plain, literal path. */
const PLAIN_PATH_RE = /^(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.]+\.[A-Za-z0-9]+$/;

/**
 * The Markdown paths a clause row cites, deduplicated, plus the citations
 * whose shape this leg does not model. Candidates are read in the wide shape
 * and then held to the plain one: a glob or brace form names a set of files
 * this leg cannot resolve to registered surfaces, so it is refused by name
 * rather than silently extracting nothing.
 *
 * The row's WHOLE text is the enumeration — a Markdown path mentioned
 * anywhere in it, residue prose included, is a cited surface. Paths are
 * compared as a SET against the register, so neither side can hide in the
 * other's prose: a substring test would let `README.md` ride on
 * `docs/README.md`, and would never see a path the row cites that no
 * surface backs.
 * @param {string} text a clause row's check-ref
 * @returns {{ paths: string[], unmodelled: string[] }}
 */
export function citedMarkdownPaths(text) {
  const paths = [];
  const unmodelled = [];
  for (const candidate of new Set((text ?? '').match(CITED_CANDIDATE_RE) ?? [])) {
    if (!PLAIN_PATH_RE.test(candidate)) unmodelled.push(candidate);
    else if (candidate.endsWith('.md')) paths.push(candidate);
  }
  return { paths, unmodelled };
}

/**
 * The clause row that names this check, read from the registry: the text a
 * reader consults to learn which surfaces are held. Returns null with a
 * problem when the registry cannot be read or carries no such row.
 * @param {string} registryJson the registry's text
 * @param {string} clauseId the clause whose row to read
 * @returns {{ text: string | null, problems: string[] }}
 */
export function readClauseRow(registryJson, clauseId) {
  let parsed;
  try {
    parsed = JSON.parse(registryJson);
  } catch {
    return { text: null, problems: [`${CLAUSE_REGISTRY_PATH} does not parse as JSON — the §${clauseId} register closure cannot run`] }; // prettier-ignore
  }
  const rows = Array.isArray(parsed?.clauses) ? parsed.clauses : [];
  const row = rows.find((r) => r?.clause === clauseId);
  if (!isPlainObject(row) || typeof row['check-ref'] !== 'string') {
    return { text: null, problems: [`${CLAUSE_REGISTRY_PATH} carries no §${clauseId} row with a check-ref — the register closure cannot run`] }; // prettier-ignore
  }
  return { text: row['check-ref'], problems: [] };
}

/**
 * Read the action wrapper's membership: the defs its `oneOf` selects and the
 * defs carrying the action prefix, so the two can be diffed. A wrapper that
 * is missing, states no `oneOf`, or lists a member this reader cannot
 * dereference is a problem, never an empty pass.
 * @param {object} schema a composed platform schema
 * @param {string} platform the platform id, for diagnoses
 * @returns {{ members: string[], prefixed: string[], problems: string[] }}
 */
export function readActionMembers(schema, platform) {
  const defs = schema?.$defs;
  const prefixed = isPlainObject(defs)
    ? Object.keys(defs).filter((name) => name.startsWith(ACTION_DEF_PREFIX))
    : [];
  const wrapper = defs?.[ACTION_WRAPPER_DEF];
  if (!isPlainObject(wrapper) || !Array.isArray(wrapper.oneOf)) {
    return { members: [], prefixed, problems: [`the composed ${platform} schema carries no \`${ACTION_WRAPPER_DEF}\` wrapper with a oneOf — the action-membership leg cannot run`] }; // prettier-ignore
  }
  const members = [];
  const problems = [];
  if (wrapper.oneOf.length === 0) {
    problems.push(`the composed ${platform} \`${ACTION_WRAPPER_DEF}\` wrapper selects nothing — an empty union makes the membership diff vacuous`); // prettier-ignore
  }
  for (const [i, member] of wrapper.oneOf.entries()) {
    const ref = isPlainObject(member) && typeof member.$ref === 'string' ? member.$ref : null;
    const name = ref?.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : null;
    if (name === null) {
      problems.push(`the composed ${platform} \`${ACTION_WRAPPER_DEF}\` wrapper's oneOf member ${i} is not a \`#/$defs/\` reference — the action-membership leg models references only`); // prettier-ignore
      continue;
    }
    members.push(name);
  }
  return { members, prefixed, problems };
}

/**
 * Read one composed def's field surface: its property names, its `required`
 * array, and the union of its `anyOf` branches' `required` arrays (the
 * schema's expression of "at least one of"). A def that is missing, carries
 * no `properties`, or carries an `anyOf` branch this reader does not model is
 * a problem, never an empty pass.
 * Each `anyOf` branch's own `required` array is kept alongside their union:
 * the union answers which fields the branches mention, the branches answer
 * whether the shape is one-per-field.
 * @param {object} schema a composed platform schema
 * @param {string} platform the platform id, for diagnoses
 * @param {string} defName the `$defs` key
 * @returns {{ present: boolean, hasAnyOf: boolean, properties: string[], required: string[], anyOfBranches: string[][], anyOfRequired: string[], problems: string[] }}
 */
export function readDefSurface(schema, platform, defName) {
  const empty = {
    present: false,
    hasAnyOf: false,
    properties: [],
    required: [],
    anyOfBranches: [],
    anyOfRequired: [],
  };
  const def = schema?.$defs?.[defName];
  if (!isPlainObject(def)) {
    return { ...empty, problems: [`the composed ${platform} schema carries no \`${defName}\` def — the field-table leg cannot run`] }; // prettier-ignore
  }
  if (!isPlainObject(def.properties)) {
    return { ...empty, problems: [`the composed ${platform} \`${defName}\` def carries no properties object — the field-table leg cannot run`] }; // prettier-ignore
  }
  const problems = [];
  const required = Array.isArray(def.required) ? def.required : [];
  if (def.required !== undefined && !Array.isArray(def.required)) {
    problems.push(`the composed ${platform} \`${defName}\` def carries a required that is not an array — the required read cannot run`); // prettier-ignore
  }
  const hasAnyOf = Array.isArray(def.anyOf);
  const anyOfRequired = [];
  const anyOfBranches = [];
  if (hasAnyOf) {
    for (const [i, branch] of def.anyOf.entries()) {
      if (!isPlainObject(branch) || !Array.isArray(branch.required)) {
        problems.push(`the composed ${platform} \`${defName}\` def's anyOf branch ${i} states no required array — the one-of read models required-only branches`); // prettier-ignore
        continue;
      }
      anyOfBranches.push(branch.required);
      anyOfRequired.push(...branch.required);
    }
  }
  return {
    present: true,
    hasAnyOf,
    properties: Object.keys(def.properties),
    required,
    anyOfBranches,
    anyOfRequired: [...new Set(anyOfRequired)],
    problems,
  };
}

/**
 * The posture class of one object subschema, keyed on its pointer: a
 * top-level `$defs` entry classifies by its def name, and every nested object
 * is a closed object. A def name the model does not know is not possible —
 * the classes partition the space, and an unmodelled def lands in `closed`,
 * where a missing `additionalProperties: false` reds.
 * @param {string} pointer the subschema's JSON-pointer-ish path
 * @returns {string} a class name from {@link POSTURE_CLASSES}
 */
export function classifyObjectSchema(pointer) {
  const top = /^#\/\$defs\/([^/]+)$/.exec(pointer);
  if (!top) return 'closed';
  const defName = top[1];
  if (WRAPPER_DEFS.includes(defName)) return 'wrapper';
  if (defName.startsWith(ACTION_DEF_PREFIX)) return 'action';
  if (defName === METADATA_DEF) return 'metadata-map';
  return 'closed';
}

/**
 * Walk every object subschema of a composed schema: the envelope, every
 * `$def`, and every object nested inside them, descending through
 * {@link TRAVERSED_KEYWORDS}. An object subschema is one that states
 * `type: "object"` or carries a `properties` key — the two ways this format's
 * schemas describe an object. Each hit also records whether the node
 * discriminates (carries a `oneOf` array), which is what a wrapper's exemption
 * from the closed posture rests on.
 * @param {object} schema a composed platform schema
 * @returns {{ pointer: string, klass: string, declared: unknown, discriminates: boolean }[]}
 */
export function walkObjectSchemas(schema) {
  const found = [];
  const visit = (node, pointer) => {
    if (!isPlainObject(node)) return;
    if (node.type === 'object' || 'properties' in node) {
      found.push({
        pointer,
        klass: classifyObjectSchema(pointer),
        declared: 'additionalProperties' in node ? node.additionalProperties : undefined,
        discriminates: Array.isArray(node.oneOf) && node.oneOf.length > 0,
      });
    }
    for (const keyword of MAP_KEYWORDS) {
      if (!isPlainObject(node[keyword])) continue;
      for (const [key, child] of Object.entries(node[keyword])) {
        visit(child, `${pointer}/${keyword}/${key}`);
      }
    }
    for (const keyword of LIST_KEYWORDS) {
      if (!Array.isArray(node[keyword])) continue;
      node[keyword].forEach((child, i) => visit(child, `${pointer}/${keyword}/${i}`));
    }
    for (const keyword of NODE_KEYWORDS) {
      if (isPlainObject(node[keyword])) visit(node[keyword], `${pointer}/${keyword}`);
    }
  };
  visit(schema, '#');
  return found;
}

/**
 * How a subschema's `additionalProperties` declaration reads in a diagnosis.
 * @param {unknown} declared
 * @returns {string}
 */
export function describeDeclaration(declared) {
  if (declared === undefined) return 'declares none';
  if (declared === false) return 'declares `false`';
  if (declared === true) return 'declares `true`';
  if (isPlainObject(declared)) {
    return statesValueConstraint(declared)
      ? 'declares a schema'
      : 'declares a schema that constrains nothing';
  }
  return `declares ${JSON.stringify(declared)}`;
}

/**
 * Whether one object subschema satisfies its class's posture. Every class in
 * {@link POSTURE_CLASSES} has its own arm; a class outside that list is a
 * programming error rather than a schema defect, so it throws instead of
 * inheriting a neighbour's rule — the evaluator reports an unmodelled class
 * as its own problem before reaching here.
 * @param {string} klass a class name from {@link POSTURE_CLASSES}
 * @param {unknown} declared the subschema's `additionalProperties`, or undefined
 * @returns {boolean}
 */
export function postureHolds(klass, declared) {
  if (klass === 'wrapper' || klass === 'action') return declared === undefined;
  if (klass === 'metadata-map') return statesValueConstraint(declared);
  if (klass === 'closed') return declared === false;
  throw new Error(`no posture is defined for the class "${klass}"`);
}

/**
 * Whether a value schema says anything about what a value may be. `{}` and
 * `true` accept anything, which is not the typed-value surface the map's
 * exemption rests on.
 * @param {unknown} declared an `additionalProperties` declaration
 * @returns {boolean}
 */
export function statesValueConstraint(declared) {
  return isPlainObject(declared) && VALUE_CONSTRAINT_KEYWORDS.some((k) => k in declared);
}

/**
 * The non-empty guard's legs: every aggregate surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this
 * list — a leg added here is exercised automatically, and the suite holds
 * the list non-empty and its diagnoses distinct.
 */
export const EMPTY_SURFACES = [
  [
    'authority',
    `no authority surfaces read — the §${AUTHORITY_CLAUSE_ID} statement leg cannot run`,
  ],
  ['objects', `no object subschemas found in the composed schemas — the §${POSTURE_CLAUSE_ID} posture walk is broken`], // prettier-ignore
  ['metadataHosts', `no metadata hosts read from the composed schemas — the §${POSTURE_CLAUSE_ID} map leg cannot run`], // prettier-ignore
  ['actionMembers', `no action-wrapper membership read from the composed schemas — the §${POSTURE_CLAUSE_ID} prefix leg cannot run`], // prettier-ignore
  ['fieldTableKeys', `no field tables found in ${SESSION_FORMAT_DOC_PATH} — the coverage leg cannot run`], // prettier-ignore
  ['tableRows', `no field-table rows read from ${SESSION_FORMAT_DOC_PATH} — the field-table legs cannot run`], // prettier-ignore
  ['defs', 'no composed defs read — the field-table legs cannot run'],
];

/**
 * Pure core: evaluate every echo leg.
 * @param {object} s the extracted surfaces
 * @param {{ path: string, description: string, matched: boolean, empty: boolean }[]} s.authority
 * @param {{ platform: string, pointer: string, klass: string, declared: unknown, discriminates: boolean }[]} s.objects
 * @param {{ platform: string, defName: string, referenced: boolean, found: boolean }[]} s.metadataHosts
 * @param {string | null} s.authorityRow the §SF-1 row's check-ref, or null when unreadable
 * @param {{ platform: string, members: string[], prefixed: string[] }[]} s.actionMembers
 * @param {string[]} s.fieldTableKeys every field table the document carries
 * @param {{ defName: string, label: string, fields: string[], yes: string[], no: string[], oneOf: string[] }[]} s.tables
 * @param {string[]} s.tableRows every readable field name, across the tables
 * @param {string[]} s.tableUnreadable refused table cells
 * @param {{ platform: string, defName: string, present: boolean, hasAnyOf: boolean, properties: string[], required: string[], anyOfBranches: string[][], anyOfRequired: string[] }[]} s.defs
 * @returns {string[]} problems; empty when every echo holds
 */
export function evaluateSchemaEcho(s) {
  const problems = [];

  // Unreadable cells and unread surfaces are reported ahead of the vacuous
  // guards: the likeliest cause of an empty parse is rows or files that
  // stopped being readable, so the most useful line must survive the early
  // return.
  for (const cell of s.tableUnreadable) {
    problems.push(`${SESSION_FORMAT_DOC_PATH} carries a cell the scan cannot read — ${cell}`);
  }
  for (const surface of s.authority) {
    if (surface.empty) {
      problems.push(`${surface.path} read empty — ${surface.description} cannot be checked`);
    }
  }

  let vacuous = false;
  for (const [key, message] of EMPTY_SURFACES) {
    if (s[key].length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make the echo diffs meaningless

  for (const surface of s.authority) {
    if (!surface.empty && !surface.matched) {
      problems.push(`${surface.path} no longer states ${surface.description} — §${AUTHORITY_CLAUSE_ID} holds the schemas' authority over this prose, and every surface that restates it must keep saying so`); // prettier-ignore
    }
  }

  for (const object of s.objects) {
    const modelled = POSTURE_CLASSES.find(([name]) => name === object.klass);
    if (!modelled) {
      problems.push(`${object.platform} ${object.pointer} is classified \`${object.klass}\`, which the posture model does not define — a class without a stated declaration cannot be judged`); // prettier-ignore
      continue;
    }
    if (!postureHolds(object.klass, object.declared)) {
      problems.push(`${object.platform} ${object.pointer} ${describeDeclaration(object.declared)} — \`${object.klass}\` objects ${modelled[1]}`); // prettier-ignore
    }
    // A wrapper's exemption rests on its shape, not on its name: a def that
    // stopped discriminating is an ordinary object whose unknown keys the
    // registration would otherwise leave open.
    if (object.klass === 'wrapper' && !object.discriminates) {
      problems.push(`${object.platform} ${object.pointer} is registered as a discriminating wrapper but states no oneOf members — the exemption from the closed posture rests on that shape`); // prettier-ignore
    }
  }
  for (const host of s.metadataHosts) {
    if (host.referenced) continue;
    const what = host.found
      ? `states its own \`${METADATA_DEF}\` shape instead of \`${METADATA_REF}\` — the map is declared once and referenced, so the posture walk judges one definition rather than each copy`
      : `carries no \`${METADATA_DEF}\` property to reference \`${METADATA_REF}\``;
    problems.push(`the composed ${host.platform} \`${host.defName}\` def ${what} (§${POSTURE_CLAUSE_ID} states the user-defined maps as the one keyed-value surface)`); // prettier-ignore
  }

  for (const membership of s.actionMembers) {
    problems.push(
      ...missingFrom(membership.members, membership.prefixed, `is selected by the composed ${membership.platform} \`${ACTION_WRAPPER_DEF}\` wrapper but does not carry the \`${ACTION_DEF_PREFIX}\` prefix the open posture is granted by`), // prettier-ignore
      ...missingFrom(membership.prefixed, membership.members, `carries the \`${ACTION_DEF_PREFIX}\` prefix on ${membership.platform} — and with it the open posture — but the \`${ACTION_WRAPPER_DEF}\` wrapper does not select it`), // prettier-ignore
    );
  }

  // The registry row is where a reader learns which surfaces are held, so the
  // register and the row are held to the same SET, both ways: a surface
  // registered here and absent from the row would be guarded without being
  // disclosed, and a path the row cites that no surface backs would be
  // disclosed without being guarded. The row's whole text is the enumeration
  // — a Markdown path anywhere in it, residue prose included, is a citation.
  if (s.authorityRow !== null) {
    const cited = citedMarkdownPaths(s.authorityRow);
    const registered = s.authority.map((surface) => surface.path);
    for (const candidate of cited.unmodelled) {
      problems.push(`the §${AUTHORITY_CLAUSE_ID} row in ${CLAUSE_REGISTRY_PATH} cites \`${candidate}\`, a path shape this leg does not model — it enumerates surfaces one literal path at a time, so a glob or brace form cannot be matched against the register`); // prettier-ignore
    }
    problems.push(
      ...missingFrom(registered, cited.paths, `is a registered authority surface but the §${AUTHORITY_CLAUSE_ID} row in ${CLAUSE_REGISTRY_PATH} does not cite it — the row states which surfaces are held`), // prettier-ignore
      ...missingFrom(cited.paths, registered, `is cited as an authority surface by the §${AUTHORITY_CLAUSE_ID} row in ${CLAUSE_REGISTRY_PATH} but no registered surface holds it`), // prettier-ignore
    );
  }

  // The field tables the legs hold plus the ones recorded as review-held are
  // the document's whole field-table set, both ways: a new table must join a
  // list, and a registration whose table is gone is stale.
  const registeredTables = registeredFieldTableKeys();
  problems.push(
    ...duplicatesIn(s.fieldTableKeys, `${SESSION_FORMAT_DOC_PATH}'s field tables — a section carrying two of them is one the legs cannot address`), // prettier-ignore
    ...missingFrom(s.fieldTableKeys, registeredTables, `is a field table in ${SESSION_FORMAT_DOC_PATH} that no leg holds and no entry records as review-held`), // prettier-ignore
    ...missingFrom(registeredTables, s.fieldTableKeys, `is registered as a field table but ${SESSION_FORMAT_DOC_PATH} carries no such table — the registration is stale`), // prettier-ignore
  );

  const defsFor = (defName) => s.defs.filter((d) => d.defName === defName);
  for (const table of s.tables) {
    problems.push(...duplicatesIn(table.fields, table.label));
    if (table.fields.length === 0) {
      problems.push(`${table.label} parsed no readable rows — the \`${table.defName}\` legs cannot run`); // prettier-ignore
      continue;
    }
    for (const def of defsFor(table.defName)) {
      if (!def.present) continue; // the read's own problem, reported beside these
      const where = `the composed ${def.platform} \`${def.defName}\` def`;
      problems.push(
        ...missingFrom(table.fields, def.properties, `is a row of ${table.label} but ${where} has no such property`), // prettier-ignore
        ...missingFrom(def.properties, table.fields, `is a property of ${where} but ${table.label} has no row for it`), // prettier-ignore
        ...missingFrom(table.yes, def.required, `is marked "${REQUIRED_YES}" in ${table.label} but ${where} does not require it`), // prettier-ignore
        ...missingFrom(def.required, table.yes, `is required by ${where} but ${table.label} does not mark it "${REQUIRED_YES}"`), // prettier-ignore
      );
      for (const field of table.no) {
        if (def.required.includes(field)) {
          problems.push(`\`${field}\` is marked "${REQUIRED_NO}" in ${table.label} but ${where} requires it`); // prettier-ignore
        }
      }
      if (table.oneOf.length > 0 && !def.hasAnyOf) {
        problems.push(`${table.label} marks ${table.oneOf.map((f) => `\`${f}\``).join(', ')} "${REQUIRED_ONE_OF}" but ${where} states no anyOf branches`); // prettier-ignore
        continue;
      }
      problems.push(
        ...missingFrom(table.oneOf, def.anyOfRequired, `is marked "${REQUIRED_ONE_OF}" in ${table.label} but no anyOf branch of ${where} requires it`), // prettier-ignore
        ...missingFrom(def.anyOfRequired, table.oneOf, `is required by an anyOf branch of ${where} but ${table.label} does not mark it "${REQUIRED_ONE_OF}"`), // prettier-ignore
      );
      // "At least one of" is the branch SHAPE, not just the union: one branch
      // per field, each requiring that field alone. A collapsed branch
      // requiring several at once demands all of them, which the union cannot
      // see and the table's wording would then misstate.
      for (const [i, branch] of def.anyOfBranches.entries()) {
        const requires = branch.map((f) => `\`${f}\``).join(' + ') || '(nothing)';
        if (table.oneOf.length === 0) {
          problems.push(`anyOf branch ${i} of ${where} requires ${requires} but no row of ${table.label} is marked "${REQUIRED_ONE_OF}"`); // prettier-ignore
        } else if (branch.length !== 1 || !table.oneOf.includes(branch[0])) {
          problems.push(`anyOf branch ${i} of ${where} requires ${requires} — ${table.label} says "${REQUIRED_ONE_OF}", which is one branch per marked field, each requiring that field alone`); // prettier-ignore
        }
      }
    }

    // Every composed platform shares each registered def; a leaf or family
    // layer that replaces one outright would otherwise satisfy the table on
    // the platform the doc was written against and diverge on the others.
    // Each diagnosis names the two platforms it compared, so a tree with more
    // than two reports which pair disagreed.
    const [first, ...rest] = defsFor(table.defName).filter((d) => d.present);
    for (const other of rest) {
      const which = `\`${table.defName}\``;
      const shared = 'every composed platform must share this def';
      problems.push(
        ...missingFrom(first.properties, other.properties, `is a property of ${which} on ${first.platform} but missing on ${other.platform} — ${shared}`), // prettier-ignore
        ...missingFrom(other.properties, first.properties, `is a property of ${which} on ${other.platform} but missing on ${first.platform} — ${shared}`), // prettier-ignore
        ...missingFrom(first.required, other.required, `is required by ${which} on ${first.platform} but not on ${other.platform} — ${shared}`), // prettier-ignore
        ...missingFrom(other.required, first.required, `is required by ${which} on ${other.platform} but not on ${first.platform} — ${shared}`), // prettier-ignore
        ...missingFrom(first.anyOfRequired, other.anyOfRequired, `is required by an anyOf branch of ${which} on ${first.platform} but not on ${other.platform} — ${shared}`), // prettier-ignore
        ...missingFrom(other.anyOfRequired, first.anyOfRequired, `is required by an anyOf branch of ${which} on ${other.platform} but not on ${first.platform} — ${shared}`), // prettier-ignore
      );
    }
  }

  return problems;
}

/**
 * Read every surface from a tree.
 * @param {(path: string) => string} readFile repo-relative reader
 * @param {(platform: string) => object} composeFor composes one platform's schema
 * @returns {Parameters<typeof evaluateSchemaEcho>[0] & { anchorProblems: string[] }}
 */
export function auditTree(readFile, composeFor) {
  const anchorProblems = [];

  const authority = AUTHORITY_SURFACES.map(([path, claim, description]) => {
    const prose = normalizeProse(readFile(path));
    return { path, description, empty: prose === '', matched: claim.test(prose) };
  });

  const objects = [];
  const metadataHosts = [];
  const actionMembers = [];
  const defs = [];
  const schemas = new Map();
  for (const platform of PLATFORM_IDS) {
    let schema;
    try {
      schema = composeFor(platform);
    } catch (error) {
      anchorProblems.push(`the ${platform} schema does not compose from its source layers (${error.message}) — the posture and field-table legs cannot run`); // prettier-ignore
      continue;
    }
    schemas.set(platform, schema);
    for (const object of walkObjectSchemas(schema)) objects.push({ platform, ...object });
    for (const defName of METADATA_HOSTS) {
      const property = schema?.$defs?.[defName]?.properties?.[METADATA_DEF];
      metadataHosts.push({
        platform,
        defName,
        referenced: property?.$ref === METADATA_REF,
        found: isPlainObject(property),
      });
    }
    const membership = readActionMembers(schema, platform);
    anchorProblems.push(...membership.problems);
    actionMembers.push({ platform, members: membership.members, prefixed: membership.prefixed });
  }

  const row = readClauseRow(readFile(CLAUSE_REGISTRY_PATH), AUTHORITY_CLAUSE_ID);
  anchorProblems.push(...row.problems);

  const docText = readFile(SESSION_FORMAT_DOC_PATH);
  const tables = [];
  const tableUnreadable = [];
  for (const [section, headerCell, defName, label] of FIELD_TABLE_LEGS) {
    const read = extractFieldTable(docText, section, headerCell, label);
    anchorProblems.push(...read.problems);
    tableUnreadable.push(...read.unreadable);
    const marked = (mark) => read.rows.filter((r) => r.required === mark).map((r) => r.field);
    tables.push({
      defName,
      label,
      fields: read.rows.map((r) => r.field),
      yes: marked(REQUIRED_YES),
      no: marked(REQUIRED_NO),
      oneOf: marked(REQUIRED_ONE_OF),
    });
    for (const [platform, schema] of schemas) {
      const surface = readDefSurface(schema, platform, defName);
      anchorProblems.push(...surface.problems);
      defs.push({ platform, defName, ...surface });
    }
  }

  return {
    authority,
    authorityRow: row.text,
    objects,
    metadataHosts,
    actionMembers,
    fieldTableKeys: extractFieldTableKeys(docText),
    tables,
    tableRows: tables.flatMap((t) => t.fields),
    tableUnreadable,
    defs,
    anchorProblems,
  };
}

/**
 * Read every surface from the real tree at `root` — the one reader the CLI
 * and the suite's real-tree lock share, so the lock exercises exactly what CI
 * runs. Documents are read from `root`; the schemas are composed from the
 * source layers of the repository this script ships in, which is the
 * composition every other consumer of `composePlatform` gets.
 * @param {string} root repository root (absolute or relative)
 * @returns {ReturnType<typeof auditTree>}
 */
export function treeSurfaces(root) {
  return auditTree((path) => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return '';
    }
  }, composePlatform);
}

/* c8 ignore start -- CLI wrapper: the pure pieces above are unit-tested; this
 * glue reads the real tree and formats the verdict. An unreadable surface
 * fails the non-empty guards loudly. */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const surfaces = treeSurfaces('.');
  const problems = [...surfaces.anchorProblems, ...evaluateSchemaEcho(surfaces)];
  if (problems.length > 0) {
    console.error('Schema-echo check failed:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`\n${problems.length} problem(s). Where a document and a schema disagree, the schema governs (§${AUTHORITY_CLAUSE_ID}): fix the prose unless the schema is the wrong side. Where a schema and this check's posture model disagree, a def changed shape — change it back, or move the model and the clause it restates together.`); // prettier-ignore
    process.exit(1);
  }
  console.log(`✓ schema echoes consistent: ${surfaces.authority.length} authority surfaces, ${surfaces.tables.length} field tables, and the additionalProperties posture over ${surfaces.objects.length} object subschemas agree with the composed schemas.`); // prettier-ignore
}
/* c8 ignore stop */
