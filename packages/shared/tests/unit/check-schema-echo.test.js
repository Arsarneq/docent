/**
 * check-schema-echo.test.js — Unit tests for the schema-echo admission test
 * (scripts/check-schema-echo.js). The session-format document and the sync
 * protocol's payload tables restate what the schemas define, so every red path
 * must fail loud: these tests prove the authority-statement leg, one posture
 * red per class, the field-table and payload-table diffs in both directions
 * over every composed platform, the target pointers those tables are held
 * against, the cross-platform agreement (whose diagnoses must name the
 * platforms they compared), both documents' coverage legs, the unreadable-cell,
 * moved-column and selection refusals, duplicates, empty parses — and, as a
 * real-tree lock, that the shipped tree satisfies every leg through the reader
 * the CLI itself uses.
 *
 * The register/row closure's refusal of a citation naming files by PATTERN is
 * pinned as a retained decision, not an accident of the shape it reads: the
 * citation gate (check-clause-registry.js) and the governance finder
 * (check-clause-governance.js) read the same shape and resolve such a citation
 * against the tracked set, while matching a set against a register of single
 * surfaces has no answer, so this leg names the citation and stops. The mid-path glob is
 * pinned with it — the shape now reads one whole, so no shorter path inside it
 * is ever taken for a surface — and so is what a refusal SAYS: the token as
 * the row writes it, never the form the emphasis strip leaves behind. The
 * reader's other two boundaries are pinned beside them: two citations written
 * without a space between them are read as the two they are, and a Markdown
 * link's label is a citation of its own rather than a token welded to the
 * bracket in front of it.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ACTION_DEF_PREFIX,
  ACTION_WRAPPER_DEF,
  AUTHORITY_CLAUSE_ID,
  AUTHORITY_SURFACES,
  EMPTY_SURFACES,
  FIELD_TABLE_HEADER,
  FIELD_TABLE_LEGS,
  METADATA_DEF,
  METADATA_REF,
  PAYLOAD_TABLE_HEADER,
  PAYLOAD_TABLE_LEGS,
  PLATFORM_IDS,
  POSTURE_CLASSES,
  REGISTRY_PATH,
  REQUIRED_COLUMN,
  REQUIRED_HEADER,
  ROOT_POINTER,
  SESSION_FORMAT_DOC_PATH,
  SYNC_PROTOCOL_DOC_PATH,
  TRAVERSED_KEYWORDS,
  UNHELD_FIELD_TABLES,
  UNHELD_PAYLOAD_TABLES,
  auditTree,
  citedMarkdownPaths,
  classifyObjectSchema,
  describeDeclaration,
  describeTarget,
  evaluateSchemaEcho,
  extractFieldTable,
  extractFieldTableKeys,
  extractPayloadTable,
  extractPayloadTableKeys,
  fieldTableKey,
  fieldTableProblems,
  normalizeProse,
  payloadTableKey,
  postureHolds,
  readActionMembers,
  readClauseRow,
  readTargetSurface,
  registeredFieldTableKeys,
  registeredPayloadTableKeys,
  statesValueConstraint,
  treeSurfaces,
  walkObjectSchemas,
} from '../../../../scripts/check-schema-echo.js';
import { PLATFORMS, composePlatform } from '../../../../scripts/build-schemas.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const readTree = (path) => readFileSync(resolve(ROOT, path), 'utf8');

/** The `step` def's pointer, the target the synthetic field table is held against. */
const STEP = '#/$defs/step';

/**
 * One synthetic composed surface at `pointer` on `platform`, carrying the
 * display strings the check's resolver decides for that pointer.
 */
function surfaceAt(platform, pointer, fields) {
  const target = describeTarget(pointer);
  return {
    platform,
    pointer,
    present: true,
    hasAnyOf: false,
    anyOfBranches: [],
    anyOfRequired: [],
    ...fields,
    where: target.where(platform),
    subject: target.subject,
    noun: target.noun,
  };
}

/**
 * A consistent synthetic surface every echo leg accepts. `tableRows` and
 * `payloadTableRows` are derived from their tables unless a test overrides
 * them, exactly as the tree read derives them — so a fixture cannot state a
 * row count its tables do not carry.
 */
function makeSurface(overrides = {}) {
  const surface = {
    authority: [
      { path: 'docs/x.md', description: 'the authority statement', matched: true, empty: false },
    ],
    objects: [
      { platform: 'extension', pointer: '#/$defs/step', klass: 'closed', declared: false, discriminates: false }, // prettier-ignore
      { platform: 'extension', pointer: '#/$defs/action', klass: 'wrapper', declared: undefined, discriminates: true }, // prettier-ignore
      { platform: 'extension', pointer: '#/$defs/action_click', klass: 'action', declared: undefined, discriminates: false }, // prettier-ignore
      { platform: 'extension', pointer: '#/$defs/metadata', klass: 'metadata-map', declared: { type: 'string' }, discriminates: false }, // prettier-ignore
    ],
    metadataHosts: [{ platform: 'extension', defName: 'project', referenced: true, found: true }],
    actionMembers: [
      { platform: 'extension', members: ['action_click'], prefixed: ['action_click'] },
    ],
    authorityRow: 'docs/x.md is held by this check',
    fieldTableKeys: registeredFieldTableKeys(),
    tables: [
      {
        pointer: STEP,
        label: 'the step-fields table',
        fields: ['uuid', 'narration', 'step_type', 'expect'],
        yes: ['uuid'],
        no: ['expect'],
        oneOf: ['narration', 'step_type'],
      },
    ],
    tableUnreadable: [],
    payloadTableKeys: registeredPayloadTableKeys(),
    payloadTables: [
      {
        pointer: ROOT_POINTER,
        label: 'the sync payload top-level table',
        fields: ['docent_format', 'project', 'recordings'],
        yes: ['docent_format', 'project', 'recordings'],
        no: [],
        oneOf: [],
      },
    ],
    payloadTableUnreadable: [],
    defs: [
      ...PLATFORM_IDS.map((platform) =>
        surfaceAt(platform, STEP, {
          hasAnyOf: true,
          properties: ['uuid', 'narration', 'step_type', 'expect'],
          required: ['uuid'],
          anyOfBranches: [['narration'], ['step_type']],
          anyOfRequired: ['narration', 'step_type'],
        }),
      ),
      ...PLATFORM_IDS.map((platform) =>
        surfaceAt(platform, ROOT_POINTER, {
          properties: ['docent_format', 'project', 'recordings'],
          required: ['docent_format', 'project', 'recordings'],
        }),
      ),
    ],
    ...overrides,
  };
  if (!('tableRows' in overrides)) surface.tableRows = surface.tables.flatMap((t) => t.fields);
  if (!('payloadTableRows' in overrides)) {
    surface.payloadTableRows = surface.payloadTables.flatMap((t) => t.fields);
  }
  return surface;
}

/** The synthetic surface with one platform's surface at `pointer` replaced. */
const withTarget = (pointer, platform, patch) =>
  makeSurface({
    defs: makeSurface().defs.map((d) =>
      d.platform === platform && d.pointer === pointer ? { ...d, ...patch } : d,
    ),
  });

/** The synthetic surface with one platform's schema root replaced. */
const withRoot = (platform, patch) => withTarget(ROOT_POINTER, platform, patch);

/** The synthetic surface with one platform's `step` def replaced. */
const withDef = (platform, patch) => withTarget(STEP, platform, patch);

describe('evaluateSchemaEcho — compliant baseline', () => {
  it('returns no problems when every echo holds', () => {
    assert.deepEqual(evaluateSchemaEcho(makeSurface()), []);
  });
});

describe('evaluateSchemaEcho — the authority-statement leg', () => {
  it('fires when a surface no longer states its claim, naming file and claim', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        authority: [
          { path: 'docs/x.md', description: 'the authority statement', matched: false, empty: false }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('docs/x.md') &&
          p.includes('the authority statement') &&
          p.includes(AUTHORITY_CLAUSE_ID),
      ),
      problems.join('\n'),
    );
  });

  it('reports an unread surface as a read failure, never as a dropped claim', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        authority: [
          {
            path: 'docs/x.md',
            description: 'the authority statement',
            matched: false,
            empty: true,
          },
        ],
      }),
    );
    assert.ok(problems.some((p) => p.includes('docs/x.md') && p.includes('read empty')));
    assert.ok(!problems.some((p) => p.includes('no longer states')));
  });
});

// Fixture rows for the posture family, keyed to the check's own exported
// POSTURE_CLASSES. The lock below holds the two key sets equal, so a class
// added to the check without a fixture row reds here — the addition direction
// the per-class tests alone cannot see.
const POSTURE_FIXTURES = {
  wrapper: { pointer: '#/$defs/action', declared: false, discriminates: true },
  action: { pointer: '#/$defs/action_click', declared: false, discriminates: false },
  'metadata-map': { pointer: `#/$defs/${METADATA_DEF}`, declared: false, discriminates: false },
  closed: { pointer: '#/$defs/step', declared: undefined, discriminates: false },
};

describe('evaluateSchemaEcho — the posture walk, every class', () => {
  it('the fixture table covers exactly the check’s posture classes (addition lock)', () => {
    assert.deepEqual(
      Object.keys(POSTURE_FIXTURES).sort(),
      POSTURE_CLASSES.map(([klass]) => klass).sort(),
    );
  });

  it('the class requirements are pairwise distinct — a copied class cannot hide behind its neighbour', () => {
    assert.ok(POSTURE_CLASSES.length > 0);
    const requirements = POSTURE_CLASSES.map(([, requirement]) => requirement);
    assert.equal(new Set(requirements).size, requirements.length);
  });

  for (const [klass, requirement] of POSTURE_CLASSES) {
    it(`fires when a ${klass} object states the wrong posture`, () => {
      const { pointer, declared, discriminates } = POSTURE_FIXTURES[klass];
      const problems = evaluateSchemaEcho(
        makeSurface({
          objects: [{ platform: 'extension', pointer, klass, declared, discriminates }],
        }),
      );
      assert.ok(
        problems.some(
          (p) => p.includes(pointer) && p.includes(requirement) && p.includes('extension'),
        ),
        problems.join('\n') || `no posture diagnostic for ${klass}`,
      );
    });
  }

  it('fires when a def registered as a wrapper stops discriminating', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        objects: [
          { platform: 'extension', pointer: `#/$defs/${ACTION_WRAPPER_DEF}`, klass: 'wrapper', declared: undefined, discriminates: false }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('states no oneOf members') && p.includes(ACTION_WRAPPER_DEF)),
      problems.join('\n'),
    );
  });

  it('fires when a metadata host inlines the map instead of referencing it', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        metadataHosts: [
          { platform: 'desktop-windows', defName: 'recording', referenced: false, found: true },
        ],
      }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('recording') && p.includes(METADATA_REF) && p.includes('states its own'),
      ),
      problems.join('\n'),
    );
  });

  it('fires, differently, when a metadata host carries no such property at all', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        metadataHosts: [
          { platform: 'extension', defName: 'project', referenced: false, found: false },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('project') && p.includes('carries no')),
      problems.join('\n'),
    );
  });

  it('fires when an object is classified outside the posture model', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        objects: [
          { platform: 'extension', pointer: '#/$defs/mystery', klass: 'invented', declared: false, discriminates: false }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('invented') && p.includes('does not define')),
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the action-wrapper membership leg (both ways)', () => {
  it('fires when a prefixed def is not selected by the wrapper', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        actionMembers: [
          { platform: 'extension', members: ['action_click'], prefixed: ['action_click', 'action_orphan'] }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`action_orphan`') &&
          p.includes(ACTION_DEF_PREFIX) &&
          p.includes('does not select it'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when the wrapper selects a def outside the prefix the open posture follows', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        actionMembers: [
          { platform: 'desktop-windows', members: ['action_click', 'smuggled'], prefixed: ['action_click'] }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('`smuggled`') && p.includes(ACTION_WRAPPER_DEF)),
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the field-table coverage leg (both ways)', () => {
  it('fires when the document carries a field table no list registers', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        fieldTableKeys: [...registeredFieldTableKeys(), fieldTableKey('Widget', FIELD_TABLE_HEADER)], // prettier-ignore
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('Widget') && p.includes('no leg holds')),
      problems.join('\n'),
    );
  });

  it('fires when a registration names a table the document no longer carries', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({ fieldTableKeys: registeredFieldTableKeys().slice(1) }),
    );
    assert.ok(
      problems.some((p) => p.includes('the registration is stale')),
      problems.join('\n'),
    );
  });

  it('fires when one section carries two field tables the legs cannot address apart', () => {
    const keys = registeredFieldTableKeys();
    const problems = evaluateSchemaEcho(makeSurface({ fieldTableKeys: [...keys, keys[0]] }));
    assert.ok(
      problems.some((p) => p.includes('more than once')),
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the field-set leg (both ways, every composed platform)', () => {
  it('fires when the table names a field the def has no property for', () => {
    const table = { ...makeSurface().tables[0] };
    const problems = evaluateSchemaEcho(
      makeSurface({ tables: [{ ...table, fields: [...table.fields, 'ghost'], no: ['ghost'] }] }),
    );
    for (const platform of PLATFORM_IDS) {
      assert.ok(
        problems.some(
          (p) => p.includes('`ghost`') && p.includes(platform) && p.includes('no such property'),
        ),
        problems.join('\n'),
      );
    }
  });

  it('fires when a def property has no row, on the platform that grew it', () => {
    const problems = evaluateSchemaEcho(
      withDef('desktop-windows', {
        properties: ['uuid', 'narration', 'step_type', 'expect', 'sprouted'],
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`sprouted`') && p.includes('desktop-windows') && p.includes('has no row for it'), // prettier-ignore
      ),
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the required leg (both ways)', () => {
  it('fires when a "yes" row is not required by the def', () => {
    const problems = evaluateSchemaEcho(withDef('extension', { required: [] }));
    assert.ok(
      problems.some((p) => p.includes('`uuid`') && p.includes('does not require it')),
      problems.join('\n'),
    );
  });

  it('fires when the def requires a field the table does not mark "yes"', () => {
    const problems = evaluateSchemaEcho(withDef('extension', { required: ['uuid', 'expect'] }));
    assert.ok(
      problems.some((p) => p.includes('`expect`') && p.includes('does not mark it')),
      problems.join('\n'),
    );
  });

  it('fires when a "no" row is in the def’s required array', () => {
    const problems = evaluateSchemaEcho(withDef('extension', { required: ['uuid', 'expect'] }));
    assert.ok(
      problems.some((p) => p.includes('`expect`') && p.includes('requires it')),
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the "one of" leg', () => {
  it('fires when a "one of" row is required by no anyOf branch', () => {
    const problems = evaluateSchemaEcho(withDef('extension', { anyOfRequired: ['narration'] }));
    assert.ok(
      problems.some((p) => p.includes('`step_type`') && p.includes('no anyOf branch')),
      problems.join('\n'),
    );
  });

  it('fires when an anyOf branch requires a field the table does not mark "one of"', () => {
    const problems = evaluateSchemaEcho(
      withDef('extension', { anyOfRequired: ['narration', 'step_type', 'surprise'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('`surprise`') && p.includes('does not mark it')),
      problems.join('\n'),
    );
  });

  it('fires when the table marks "one of" but the def states no anyOf at all', () => {
    const problems = evaluateSchemaEcho(
      withDef('extension', { hasAnyOf: false, anyOfRequired: [] }),
    );
    assert.ok(
      problems.some((p) => p.includes('states no anyOf branches') && p.includes('`narration`')),
      problems.join('\n'),
    );
  });

  it('fires when the branches collapse into one demanding every marked field at once', () => {
    // The union still matches, so only the branch shape can see this: one
    // branch requiring both fields means BOTH are required, which is not
    // "at least one of".
    const problems = evaluateSchemaEcho(
      withDef('extension', { anyOfBranches: [['narration', 'step_type']] }),
    );
    assert.ok(
      problems.some((p) => p.includes('anyOf branch 0') && p.includes('`narration` + `step_type`')),
      problems.join('\n'),
    );
  });

  it('says what is actually wrong when the def branches but the table marks nothing', () => {
    const table = makeSurface().tables[0];
    const problems = evaluateSchemaEcho(
      makeSurface({ tables: [{ ...table, oneOf: [], no: [...table.no, 'narration', 'step_type'] }] }), // prettier-ignore
    );
    assert.ok(
      problems.some((p) => p.includes('anyOf branch 0') && p.includes('no row of') && p.includes('is marked')), // prettier-ignore
      problems.join('\n'),
    );
    // …and never claims the table said "one of" when it said nothing of the kind.
    assert.ok(!problems.some((p) => p.includes('which is one branch per marked field')));
  });

  it('fires when a branch requires a field the table does not mark "one of"', () => {
    const problems = evaluateSchemaEcho(
      withDef('extension', {
        anyOfBranches: [['narration'], ['uuid']],
        anyOfRequired: ['narration', 'step_type'],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('anyOf branch 1') && p.includes('`uuid`')),
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the authority register and the clause row that discloses it', () => {
  it('fires when a registered surface is absent from the row', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({ authorityRow: 'this row names no surface at all' }),
    );
    assert.ok(
      problems.some((p) => p.includes('docs/x.md') && p.includes('does not cite it')),
      problems.join('\n'),
    );
  });

  it('fires when the row cites a surface the register does not hold', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({ authorityRow: 'docs/x.md and docs/invented.md are held by this check' }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('docs/invented.md') && p.includes('no registered surface holds it'),
      ),
      problems.join('\n'),
    );
  });

  it('refuses a citation shape it cannot match against the register', () => {
    // The refusal is retained by design: the sibling readers of this shape
    // resolve a pattern against the tracked set, and a register of single
    // surfaces has no set to resolve one against.
    const problems = evaluateSchemaEcho(
      makeSurface({ authorityRow: 'docs/x.md and everything under docs/*.md are held' }),
    );
    assert.ok(
      problems.some((p) => p.includes('docs/*.md') && p.includes('refuses by design')),
      problems.join('\n'),
    );
  });

  it('words a Markdown-reaching token that names no set on its own terms', () => {
    // The pattern diagnosis would send this author looking for a glob; this
    // one states what the token is instead.
    const problems = evaluateSchemaEcho(makeSurface({ authorityRow: 'docs/x.md,.md is held' }));
    const found = problems.filter((p) => p.includes('cites `.md`'));
    assert.equal(found.length, 1, problems.join('\n'));
    assert.match(found[0], /states no path this leg can match/);
    assert.doesNotMatch(found[0], /refuses by design/);
  });

  it('does not let a shorter path ride inside a longer one', () => {
    // `README.md` is a substring of `docs/README.md`: a substring test would
    // call the root README disclosed by a row that only cites the index.
    const problems = evaluateSchemaEcho(
      makeSurface({
        authority: [
          { path: 'README.md', description: 'the root README', matched: true, empty: false },
          { path: 'docs/README.md', description: 'the docs index', matched: true, empty: false },
        ],
        authorityRow: 'the register holds docs/README.md',
      }),
    );
    assert.ok(
      problems.some((p) => p.startsWith('`README.md`') && p.includes('does not cite it')),
      problems.join('\n'),
    );
  });

  it('skips the closure rather than inventing one when the row could not be read', () => {
    const problems = evaluateSchemaEcho(makeSurface({ authorityRow: null }));
    assert.deepEqual(problems, []);
  });
});

describe('evaluateSchemaEcho — the cross-platform def agreement', () => {
  // Each diagnosis must name the platforms it compared IN ITS DIRECTIONAL
  // SLOTS — "on <a> but not on <b>" — never by position. A message that says
  // "the first platform" and parks the ids in a parenthetical reads the same
  // to a substring test and tells a reader nothing once a third chain exists,
  // so the predicate refuses the positional wording outright.
  // The expected slots are supplied per call site: the fixtures put the
  // divergence on a named platform, so which id lands in which slot is a fact
  // the test knows and must assert — a predicate happy with either order
  // would pass a diff that reversed them.
  const DIRECTIONAL = /on ([A-Za-z0-9-]+) but (?:not|missing) on ([A-Za-z0-9-]+)/;
  const namesPlatforms = (expectedFrom, expectedTo) => (p) => {
    if (/the (?:first|second) platform/.test(p)) return false;
    const match = DIRECTIONAL.exec(p);
    if (match === null) return false;
    const [, from, to] = match;
    return (
      from === expectedFrom &&
      to === expectedTo &&
      PLATFORM_IDS.includes(from) &&
      PLATFORM_IDS.includes(to) &&
      p.includes('every composed platform must share this def')
    );
  };

  it('fires when one platform’s copy of a shared def carries an extra property', () => {
    // The fixture grows the property on desktop-windows, so the diagnosis
    // reads FROM desktop-windows (where it is) TO extension (where it is not).
    const problems = evaluateSchemaEcho(
      withDef('desktop-windows', {
        properties: ['uuid', 'narration', 'step_type', 'expect', 'divergent'],
      }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('`divergent`') && namesPlatforms('desktop-windows', 'extension')(p),
      ),
      problems.join('\n'),
    );
  });

  it('fires when the platforms disagree on the def’s required set', () => {
    // The fixture drops `required` on desktop-windows, so `uuid` is required
    // on extension and not on desktop-windows — the opposite direction.
    const problems = evaluateSchemaEcho(withDef('desktop-windows', { required: [] }));
    assert.ok(
      problems.some((p) => p.includes('`uuid`') && namesPlatforms('extension', 'desktop-windows')(p)), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('fires when the platforms disagree on which fields an anyOf branch requires', () => {
    const problems = evaluateSchemaEcho(
      withDef('desktop-windows', {
        anyOfBranches: [['narration'], ['step_type'], ['diverged']],
        anyOfRequired: ['narration', 'step_type', 'diverged'],
      }),
    );
    assert.ok(
      problems.some(
        (p) =>
          p.includes('`diverged`') &&
          p.includes('anyOf branch') &&
          namesPlatforms('desktop-windows', 'extension')(p),
      ),
      problems.join('\n'),
    );
  });

  it('refuses both the positional wording and a swapped pair of slots', () => {
    // The predicate is only worth having if it rejects what it replaced —
    // and if it rejects the right ids in the wrong order.
    const expected = namesPlatforms('desktop-windows', 'extension');
    assert.ok(
      !expected(
        '`divergent` is a property of `step` (extension vs desktop-windows) on the second platform only — every composed platform must share this def',
      ),
    );
    assert.ok(
      !expected(
        '`divergent` is a property of `step` on extension but missing on desktop-windows — every composed platform must share this def',
      ),
    );
    assert.ok(
      expected(
        '`divergent` is a property of `step` on desktop-windows but missing on extension — every composed platform must share this def',
      ),
    );
  });
});

describe('evaluateSchemaEcho — duplicates, unreadable cells, and empty parses', () => {
  it('fires on a field repeated in one table', () => {
    const table = makeSurface().tables[0];
    const problems = evaluateSchemaEcho(
      makeSurface({ tables: [{ ...table, fields: [...table.fields, 'uuid'] }] }),
    );
    assert.ok(
      problems.some((p) => p.includes('more than once') && p.includes(table.label)),
      problems.join('\n'),
    );
  });

  it('reports unreadable cells ahead of the vacuous guards', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({ tableUnreadable: ['the step-fields table Required cell for `expect` — maybe'] }), // prettier-ignore
    );
    assert.ok(problems.some((p) => p.includes('cannot read') && p.includes('maybe')));
  });

  it('refuses a leg whose table parsed no readable rows instead of passing it', () => {
    const table = makeSurface().tables[0];
    const problems = evaluateSchemaEcho(
      makeSurface({
        tables: [{ ...table, fields: [], yes: [], no: [], oneOf: [] }],
        tableRows: ['kept-alive'], // another leg still read rows
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('parsed no readable rows')),
      problems.join('\n'),
    );
  });

  it('the empty-surface export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, message]) => message);
    assert.equal(new Set(messages).size, messages.length);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateSchemaEcho(makeSurface({ [key]: [] }));
      assert.ok(
        problems.some((p) => p.includes(message)),
        problems.join('\n') || `no vacuous diagnostic for ${key}`,
      );
    });
  }

  it('names what an empty target-surface set stops: both registers’ comparisons', () => {
    const problems = evaluateSchemaEcho(makeSurface({ defs: [] }));
    assert.ok(
      problems.includes('no composed target surfaces read — the field-table and payload-table legs cannot run'), // prettier-ignore
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the payload-table legs (each table against its target)', () => {
  const top = () => makeSurface().payloadTables[0];
  const [first, second] = PLATFORM_IDS;

  it('fires when the table names a field its target has no property for, on every platform', () => {
    const table = top();
    const problems = evaluateSchemaEcho(
      makeSurface({
        payloadTables: [{ ...table, fields: [...table.fields, 'ghost'], no: ['ghost'] }],
      }),
    );
    for (const platform of PLATFORM_IDS) {
      assert.ok(
        problems.includes(`\`ghost\` is a row of the sync payload top-level table but the composed ${platform} schema root has no such property`), // prettier-ignore
        problems.join('\n'),
      );
    }
  });

  it('reports a target’s field drift per table when tables in both registers hold it', () => {
    const held = { ...makeSurface().tables[0], label: 'the sync payload step table' };
    const problems = evaluateSchemaEcho({
      ...withTarget(STEP, second, { properties: ['uuid', 'narration', 'step_type', 'expect', 'sprouted'] }), // prettier-ignore
      payloadTables: [top(), held],
      payloadTableRows: [...top().fields, ...held.fields],
    });
    // The drift lines name exactly the tables that hold the target, one each.
    assert.deepEqual(
      problems.filter((p) => p.startsWith('`sprouted`') && p.endsWith('has no row for it')),
      ['the step-fields table', held.label].map(
        (label) => `\`sprouted\` is a property of the composed ${second} \`step\` def but ${label} has no row for it`, // prettier-ignore
      ),
    );
  });

  it('fires when a root property has no row, on the platform that grew it', () => {
    const problems = evaluateSchemaEcho(
      withRoot(second, { properties: ['docent_format', 'project', 'recordings', 'extra'] }),
    );
    assert.ok(
      problems.includes(`\`extra\` is a property of the composed ${second} schema root but the sync payload top-level table has no row for it`), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('fires on a required mismatch in both directions, and on a "no" row the root requires', () => {
    const notRequired = evaluateSchemaEcho(withRoot(first, { required: ['project', 'recordings'] })); // prettier-ignore
    assert.ok(
      notRequired.includes(`\`docent_format\` is marked "yes" in the sync payload top-level table but the composed ${first} schema root does not require it`), // prettier-ignore
      notRequired.join('\n'),
    );
    const markedNo = evaluateSchemaEcho(
      makeSurface({ payloadTables: [{ ...top(), yes: ['project', 'recordings'], no: ['docent_format'] }] }), // prettier-ignore
    );
    assert.ok(
      markedNo.includes(`\`docent_format\` is required by the composed ${first} schema root but the sync payload top-level table does not mark it "yes"`), // prettier-ignore
      markedNo.join('\n'),
    );
    assert.ok(
      markedNo.includes(`\`docent_format\` is marked "no" in the sync payload top-level table but the composed ${first} schema root requires it`), // prettier-ignore
      markedNo.join('\n'),
    );
  });

  it('holds every platform to one root, in the root’s own words', () => {
    const problems = evaluateSchemaEcho(withRoot(second, { required: ['project', 'recordings'] }));
    assert.ok(
      problems.includes(`\`docent_format\` is required by the schema root on ${first} but not on ${second} — every composed platform must share this root`), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('prints a cross-platform split once for a def both registers hold', () => {
    const held = { ...makeSurface().tables[0], label: 'the sync payload step table' };
    const problems = evaluateSchemaEcho({
      ...withDef(second, { required: [] }),
      payloadTables: [top(), held],
      payloadTableRows: [...top().fields, ...held.fields],
    });
    const split = `\`uuid\` is required by \`step\` on ${first} but not on ${second} — every composed platform must share this def`; // prettier-ignore
    assert.equal(problems.filter((p) => p === split).length, 1, problems.join('\n'));
  });

  it('holds the platforms to one surface at every pointer read, whether or not a table parsed rows', () => {
    const surfaces = withRoot(second, { required: [] }).defs;
    assert.ok(
      fieldTableProblems([], surfaces).includes(`\`project\` is required by the schema root on ${first} but not on ${second} — every composed platform must share this root`), // prettier-ignore
    );
  });

  it('refuses a payload table that parsed no readable rows, in its target’s words', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        payloadTables: [{ ...top(), fields: [], yes: [] }],
        payloadTableRows: ['kept-alive'],
      }),
    );
    assert.ok(
      problems.includes('the sync payload top-level table parsed no readable rows — the payload-table legs cannot run'), // prettier-ignore
      problems.join('\n'),
    );
    const defTable = evaluateSchemaEcho(
      makeSurface({
        tables: [{ ...makeSurface().tables[0], fields: [], yes: [], no: [], oneOf: [] }],
        tableRows: ['kept-alive'],
      }),
    );
    assert.ok(
      defTable.includes(
        'the step-fields table parsed no readable rows — the field-table legs cannot run',
      ),
      defTable.join('\n'),
    );
  });

  it('names an unreadable payload-table cell by the sync protocol', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({ payloadTableUnreadable: ['a Required cell — maybe'] }),
    );
    assert.ok(
      problems.includes(`${SYNC_PROTOCOL_DOC_PATH} carries a cell the scan cannot read — a Required cell — maybe`), // prettier-ignore
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the payload coverage leg (both ways)', () => {
  it('fires when the sync protocol carries a field table no list registers', () => {
    const extra = payloadTableKey('Payload Shapes', 'Widget fields', PAYLOAD_TABLE_HEADER);
    const problems = evaluateSchemaEcho(
      makeSurface({ payloadTableKeys: [...registeredPayloadTableKeys(), extra] }),
    );
    assert.ok(
      problems.includes(`\`${extra}\` is a field table in ${SYNC_PROTOCOL_DOC_PATH} that no payload leg holds and no entry records as review-held`), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('fires when a registration names a table the sync protocol no longer carries', () => {
    const [gone, ...kept] = registeredPayloadTableKeys();
    const problems = evaluateSchemaEcho(makeSurface({ payloadTableKeys: kept }));
    assert.ok(
      problems.includes(`\`${gone}\` is registered as a payload table but ${SYNC_PROTOCOL_DOC_PATH} carries no such table — the registration is stale`), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('fires when one heading carries a pair under one whole header the selector cannot address', () => {
    const keys = registeredPayloadTableKeys();
    const problems = evaluateSchemaEcho(makeSurface({ payloadTableKeys: [...keys, keys.at(-1)] }));
    assert.ok(
      problems.some((p) => p.includes('more than once') && p.includes('a pair the selector cannot address')), // prettier-ignore
      problems.join('\n'),
    );
  });

  it('derives the registered keys from both lists through the one key', () => {
    assert.deepEqual(registeredPayloadTableKeys(), [
      ...PAYLOAD_TABLE_LEGS.map(([section, subsection]) => payloadTableKey(section, subsection, PAYLOAD_TABLE_HEADER)), // prettier-ignore
      ...UNHELD_PAYLOAD_TABLES.map(([section, subsection, header]) => payloadTableKey(section, subsection, header)), // prettier-ignore
    ]);
    assert.equal(payloadTableKey('A', 'B', ['Field', 'Type']), 'A / B / Field | Type');
  });

  it('keys every Field-headed table by section, heading and whole header, and no other table', () => {
    const doc = [
      'Preamble.',
      '',
      '| Field | Note |',
      '| ----- | ---- |',
      '| `x` | before any heading |',
      '',
      '## Shapes',
      '',
      '| Field | Type |',
      '| ----- | ---- |',
      '| `a` | t |',
      '',
      '### One',
      '',
      '| Field | Type | Required | Description |',
      '| ----- | ---- | -------- | ----------- |',
      '| `b` | t | yes | d |',
      '',
      '| Code | Meaning |',
      '| ---- | ------- |',
      '| 200 | ok |',
    ].join('\n');
    assert.deepEqual(extractPayloadTableKeys(doc), [
      '(no section) / (no heading) / Field | Note',
      'Shapes / (no heading) / Field | Type',
      'Shapes / One / Field | Type | Required | Description',
    ]);
  });
});

describe('PAYLOAD_TABLE_LEGS — the registered payload tables', () => {
  it('is non-empty and distinct, and its header carries the Required column where the row reader reads it', () => {
    assert.ok(PAYLOAD_TABLE_LEGS.length > 0);
    for (const projection of [
      PAYLOAD_TABLE_LEGS.map(([section, subsection]) => `${section}\t${subsection}`),
      PAYLOAD_TABLE_LEGS.map(([, , pointer]) => pointer),
      PAYLOAD_TABLE_LEGS.map(([, , , label]) => label),
    ]) {
      assert.equal(new Set(projection).size, projection.length, projection.join(' | '));
    }
    assert.equal(PAYLOAD_TABLE_HEADER[REQUIRED_COLUMN], REQUIRED_HEADER);
  });

  for (const [section, subsection, pointer, label] of PAYLOAD_TABLE_LEGS) {
    it(`${label} selects exactly one readable table, and its target ${pointer} resolves on every platform`, () => {
      const read = extractPayloadTable(
        readTree(SYNC_PROTOCOL_DOC_PATH),
        section,
        subsection,
        label,
      );
      assert.deepEqual(read.problems, []);
      assert.deepEqual(read.unreadable, []);
      assert.ok(read.rows.length > 0, `${label} parsed no rows`);
      for (const platform of PLATFORM_IDS) {
        const surface = readTargetSurface(composePlatform(platform), platform, pointer);
        assert.deepEqual(surface.problems, [], platform);
        assert.equal(surface.present, true, platform);
      }
    });
  }
});

describe('UNHELD_PAYLOAD_TABLES — the review-held sync-protocol tables', () => {
  it('states a reason per entry and never collides with a held leg', () => {
    const legKeys = PAYLOAD_TABLE_LEGS.map(([section, subsection]) => payloadTableKey(section, subsection, PAYLOAD_TABLE_HEADER)); // prettier-ignore
    const keys = UNHELD_PAYLOAD_TABLES.map(([section, subsection, header]) => payloadTableKey(section, subsection, header)); // prettier-ignore
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.ok(!legKeys.includes(key), key);
    for (const [, , , reason] of UNHELD_PAYLOAD_TABLES) assert.ok(reason.length > 0);
  });

  it('the sync protocol carries every registered table and no other Field-headed one', () => {
    const found = extractPayloadTableKeys(readTree(SYNC_PROTOCOL_DOC_PATH));
    assert.deepEqual([...found].sort(), [...registeredPayloadTableKeys()].sort());
  });
});

describe('extractPayloadTable', () => {
  const doc = [
    '## Payload Shapes',
    '',
    '### Payload',
    '',
    '#### Top-level fields',
    '',
    '| Field | Type | Required | Description |',
    '| ----- | ---- | -------- | ----------- |',
    '| `docent_format` | object | yes | stamp |',
    '',
    '#### Project fields',
    '',
    '| Field | Type | Required | Description |',
    '| ----- | ---- | -------- | ----------- |',
    '| `project_id` | string | yes | id |',
  ].join('\n');

  it('selects by section, heading, and whole header — one of several same-header tables', () => {
    const read = extractPayloadTable(doc, 'Payload Shapes', 'Top-level fields', 'the top table');
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.rows, [{ field: 'docent_format', required: 'yes' }]);
  });

  it('refuses a selection matching no table, by name', () => {
    const read = extractPayloadTable(doc, 'Payload Shapes', 'Payload', 'the top table');
    assert.deepEqual(read.rows, []);
    assert.deepEqual(read.problems, [
      `${SYNC_PROTOCOL_DOC_PATH} carries 0 tables under "Payload Shapes › Payload" headed "${PAYLOAD_TABLE_HEADER.join(' | ')}" — the top table models exactly one`, // prettier-ignore
    ]);
  });

  it('refuses a selection matching two tables rather than merging them', () => {
    const twice = doc.replace('#### Project fields', '');
    const read = extractPayloadTable(twice, 'Payload Shapes', 'Top-level fields', 'the top table');
    assert.deepEqual(read.rows, []);
    assert.ok(read.problems[0].includes(`${SYNC_PROTOCOL_DOC_PATH} carries 2 tables`), read.problems.join('\n')); // prettier-ignore
  });

  it('refuses a header that differs in any cell, never selecting on the first alone', () => {
    const offCell = doc.replace('| Field | Type | Required | Description |', '| Field | Type | Needed | Description |'); // prettier-ignore
    const read = extractPayloadTable(offCell, 'Payload Shapes', 'Top-level fields', 'the top table'); // prettier-ignore
    assert.ok(read.problems[0].includes('carries 0 tables'), read.problems.join('\n'));
  });
});

describe('auditTree — the sync protocol read empty or not at all', () => {
  for (const [what, answer, tail] of [
    ['read empty', '', 'read empty'],
    ['unreadable', null, 'could not be read'],
  ]) {
    it(`names the read failure once, by the authority leg, and the selection refusals follow when it is ${what}`, () => {
      const surfaces = auditTree((path) => (path === SYNC_PROTOCOL_DOC_PATH ? answer : readTree(path)), composePlatform); // prettier-ignore
      for (const [, subsection] of PAYLOAD_TABLE_LEGS) {
        assert.ok(
          surfaces.machineryProblems.some((p) => p.startsWith(`${SYNC_PROTOCOL_DOC_PATH} carries 0 tables under "Payload Shapes › ${subsection}"`)), // prettier-ignore
          surfaces.machineryProblems.join('\n'),
        );
      }
      const problems = evaluateSchemaEcho(surfaces);
      const failures = problems.filter((p) => p.startsWith(`${SYNC_PROTOCOL_DOC_PATH} ${tail}`));
      assert.deepEqual(failures, [`${SYNC_PROTOCOL_DOC_PATH} ${tail} — ${describe1(SYNC_PROTOCOL_DOC_PATH)}`]); // prettier-ignore
      assert.ok(
        problems.includes(`no payload-table rows read from ${SYNC_PROTOCOL_DOC_PATH} — the payload-table legs cannot run`), // prettier-ignore
        problems.join('\n'),
      );
    });
  }
});

describe('auditTree — each target read once per platform across both registers', () => {
  it('reads a def both registers hold once, so a def missing on one platform is named once', () => {
    const [first, second] = PLATFORM_IDS;
    const compose = (platform) => {
      const schema = composePlatform(platform);
      if (platform !== second) return schema;
      const { project: _dropped, ...defs } = schema.$defs;
      return { ...schema, $defs: defs };
    };
    const surfaces = auditTree((path) => readTree(path), compose);
    const pairs = surfaces.defs.map((d) => `${d.platform} ${d.pointer}`);
    assert.equal(new Set(pairs).size, pairs.length, pairs.join(' | '));
    const missing = `the composed ${second} schema carries no \`project\` def — the field-table and payload-table legs cannot run`; // prettier-ignore
    assert.equal(surfaces.anchorProblems.filter((p) => p === missing).length, 1, surfaces.anchorProblems.join('\n')); // prettier-ignore
    assert.ok(
      !surfaces.anchorProblems.some((p) => p.includes(`composed ${first} schema carries no`)),
    );
  });
});

describe('AUTHORITY_SURFACES — the registered echo surfaces', () => {
  it('is non-empty and pairwise distinct in path, claim, and description', () => {
    assert.ok(AUTHORITY_SURFACES.length > 0);
    for (const projection of [
      AUTHORITY_SURFACES.map(([path]) => path),
      AUTHORITY_SURFACES.map(([, claim]) => claim.source),
      AUTHORITY_SURFACES.map(([, , description]) => description),
    ]) {
      assert.equal(new Set(projection).size, projection.length, projection.join(' | '));
    }
  });

  for (const [path, claim, description] of AUTHORITY_SURFACES) {
    it(`${path} states ${description}`, () => {
      assert.match(normalizeProse(readTree(path)), claim);
    });
  }
});

describe('FIELD_TABLE_LEGS — the registered field tables', () => {
  it('is non-empty and pairwise distinct in def, label, and section+header', () => {
    assert.ok(FIELD_TABLE_LEGS.length > 0);
    for (const projection of [
      FIELD_TABLE_LEGS.map(([, , defName]) => defName),
      FIELD_TABLE_LEGS.map(([, , , label]) => label),
      FIELD_TABLE_LEGS.map(([section, header]) => `${section}\t${header}`),
    ]) {
      assert.equal(new Set(projection).size, projection.length, projection.join(' | '));
    }
  });

  for (const [section, header, defName, label] of FIELD_TABLE_LEGS) {
    it(`${label} selects exactly one readable table for \`${defName}\``, () => {
      const read = extractFieldTable(readTree(SESSION_FORMAT_DOC_PATH), section, header, label);
      assert.deepEqual(read.problems, []);
      assert.deepEqual(read.unreadable, []);
      assert.ok(read.rows.length > 0, `${label} parsed no rows`);
    });
  }
});

describe('UNHELD_FIELD_TABLES — the review-held field tables', () => {
  it('states a distinct reason per entry and never collides with a held leg', () => {
    const keys = UNHELD_FIELD_TABLES.map(([section, header]) => fieldTableKey(section, header));
    const legKeys = FIELD_TABLE_LEGS.map(([section, header]) => fieldTableKey(section, header));
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.ok(!legKeys.includes(key), key);
    const reasons = UNHELD_FIELD_TABLES.map(([, , reason]) => reason);
    assert.equal(new Set(reasons).size, reasons.length);
    for (const reason of reasons) assert.ok(reason.length > 0);
  });

  it('the document carries every registered field table and no other', () => {
    const found = extractFieldTableKeys(readTree(SESSION_FORMAT_DOC_PATH));
    assert.deepEqual([...found].sort(), [...registeredFieldTableKeys()].sort());
  });
});

describe('PLATFORM_IDS — the platforms this check covers', () => {
  it('the composer declares at least one chain to cover', () => {
    // The list IS the composer's keys by construction, so the value worth
    // pinning is that the composer declares any chain at all — an empty
    // PLATFORMS would make every schema leg vacuous.
    assert.ok(Object.keys(PLATFORMS).length > 0);
    assert.ok(PLATFORM_IDS.length > 0);
  });

  it('the real-tree read covers every one of them', () => {
    const surfaces = treeSurfaces(ROOT);
    for (const platform of PLATFORM_IDS) {
      assert.ok(surfaces.objects.some((o) => o.platform === platform), `${platform} objects`); // prettier-ignore
      assert.ok(surfaces.actionMembers.some((m) => m.platform === platform), `${platform} members`); // prettier-ignore
      assert.ok(surfaces.defs.some((d) => d.platform === platform), `${platform} defs`); // prettier-ignore
    }
  });
});

describe('citedMarkdownPaths', () => {
  it('reads whole path tokens, keeps only Markdown, and deduplicates', () => {
    const cited = citedMarkdownPaths(
      'scripts/check-schema-echo.js holds docs/README.md, README.md, docs/README.md, and reference-implementations/sync-server/README.md (npm run lint:schema-echo)', // prettier-ignore
    );
    assert.deepEqual(cited.paths, [
      'docs/README.md',
      'README.md',
      'reference-implementations/sync-server/README.md',
    ]);
    assert.deepEqual(cited.unmodelled, []);
  });

  it('reads nothing from a row that cites no path', () => {
    assert.deepEqual(citedMarkdownPaths('held by review only').paths, []);
    assert.deepEqual(citedMarkdownPaths(undefined).paths, []);
  });

  it('refuses a glob or brace citation instead of extracting nothing from it', () => {
    // The wider governance-class shape admits these, so they are seen and
    // named rather than falling out of the scan silently — the refusal this
    // leg keeps while the citation gate (check-clause-registry.js) and the
    // governance finder (check-clause-governance.js) resolve such a pattern.
    const glob = citedMarkdownPaths('the register holds docs/*.md');
    assert.deepEqual(glob.paths, []);
    assert.deepEqual(glob.unmodelled, ['docs/*.md']);
    const brace = citedMarkdownPaths('the register holds docs/{a,b}.md');
    assert.deepEqual(brace.unmodelled, ['docs/{a,b}.md']);
  });

  it('reads through Markdown emphasis to the surface citation inside it', () => {
    const cited = citedMarkdownPaths('the register holds **docs/README.md**');
    assert.deepEqual(cited.paths, ['docs/README.md']);
    assert.deepEqual(cited.unmodelled, []);
  });

  it('names a refused token as WRITTEN, never as the strip leaves it', () => {
    // The leading run comes off for the MATCH; reporting the stripped form
    // would name `.md`, a citation the row does not make.
    const cited = citedMarkdownPaths('the register holds every *.md in the tree');
    assert.deepEqual(cited.paths, []);
    assert.deepEqual(cited.unmodelled, ['*.md']);
  });

  it('reads a comma as a separator, so an unspaced pair is two citations', () => {
    const both = citedMarkdownPaths('the register holds docs/README.md,README.md');
    assert.deepEqual(both.paths, ['docs/README.md', 'README.md']);
    assert.deepEqual(both.unmodelled, []);
    // Both halves are answered on their own terms — one resolved, one refused
    // — rather than merged into a single token that is neither.
    const mixed = citedMarkdownPaths('the register holds docs/README.md,docs/*.md');
    assert.deepEqual(mixed.paths, ['docs/README.md']);
    assert.deepEqual(mixed.unmodelled, ['docs/*.md']);
  });

  it('reads a Markdown link’s label as the surface it names', () => {
    // The shared shape admits no bracket in a directory segment, so the label
    // is a citation of its own rather than a token welded to the bracket
    // before it — which would then misreport as a refused pattern.
    const cited = citedMarkdownPaths('the register holds [docs/README.md](docs/README.md)');
    assert.deepEqual(cited.paths, ['docs/README.md']);
    assert.deepEqual(cited.unmodelled, []);
  });

  it('reads a directory-less link’s label the same way', () => {
    // The file-name segment admits no bracket either, so a root-file link
    // names its surface once rather than yielding a bracketed twin beside it.
    const cited = citedMarkdownPaths('the register holds [README.md](README.md)');
    assert.deepEqual(cited.paths, ['README.md']);
    assert.deepEqual(cited.unmodelled, []);
  });

  it('sees a mid-path glob whole, so the shorter path inside it is never taken as a surface', () => {
    // The shared shape reads directory segments with pattern characters now,
    // so this names one set and is refused as one — never read as `x.md`.
    const cited = citedMarkdownPaths('the register holds docs/*/x.md');
    assert.deepEqual(cited.paths, []);
    assert.deepEqual(cited.unmodelled, ['docs/*/x.md']);
  });

  it('ignores a non-plain citation that names no Markdown — outside the leg, not refused', () => {
    // The refusal is scoped to Markdown-reaching shapes; a row sentence
    // citing, say, a script glob is not an authority-surface citation and
    // must neither extract nor red.
    const script = citedMarkdownPaths('held by scripts/*.js and the checks');
    assert.deepEqual(script.paths, []);
    assert.deepEqual(script.unmodelled, []);
  });

  it('reads a separator-carrying prose token as prose, on the sibling readers’ rule', () => {
    // A host and a version each carry a separator and an interior dot in the
    // first segment, which is what that rule reads as sentence text — so
    // neither is extracted as a surface nor refused as a shape.
    const host = citedMarkdownPaths('as github.com/Arsarneq/docent/README.md shows');
    assert.deepEqual(host.paths, []);
    assert.deepEqual(host.unmodelled, []);
    assert.deepEqual(host.unshaped, []);
    const version = citedMarkdownPaths('between 1.2/2.0.md and the rest');
    assert.deepEqual(version.paths, []);
    assert.deepEqual(version.unshaped, []);
  });

  it('keeps the bare surface name the separator condition protects', () => {
    // That prose rule judges a first SEGMENT; a registered root surface has
    // none, so gating it unconditionally would drop a surface the row cites.
    assert.deepEqual(citedMarkdownPaths('the register holds README.md').paths, ['README.md']);
  });

  it('reports a Markdown-reaching token that names no set apart from a pattern', () => {
    // The comma splits one matched token into two citations, and the second
    // reaches for Markdown while carrying no pattern character and no path the
    // shape admits — a different finding from a glob, so it comes back on its
    // own list and the two diagnoses can differ.
    const cited = citedMarkdownPaths('the register holds docs/x.md,.md');
    assert.deepEqual(cited.paths, ['docs/x.md']);
    assert.deepEqual(cited.unmodelled, []);
    assert.deepEqual(cited.unshaped, ['.md']);
  });
});

describe('AUTHORITY_SURFACES ⇄ the row’s citation shape', () => {
  it('every registered surface is a Markdown path, which is what the row’s scan reads', () => {
    // The cited side keeps only `.md` tokens; if a register entry were some
    // other file type the two sides could never agree, and the closure leg
    // would red on a correct row.
    for (const [path] of AUTHORITY_SURFACES) {
      assert.ok(path.endsWith('.md'), path);
    }
  });
});

describe('readClauseRow', () => {
  it('reads the clause’s check-ref from the registry', () => {
    const read = readClauseRow(readTree(REGISTRY_PATH), AUTHORITY_CLAUSE_ID);
    assert.deepEqual(read.problems, []);
    assert.ok(read.text.includes('check-schema-echo.js'));
  });

  it('is loud on an unparseable registry and on a missing row', () => {
    assert.ok(
      readClauseRow('not json', AUTHORITY_CLAUSE_ID).problems[0].includes('does not parse'),
    );
    const absent = readClauseRow(JSON.stringify({ clauses: [] }), AUTHORITY_CLAUSE_ID);
    assert.equal(absent.text, null);
    assert.ok(absent.problems[0].includes('no §SF-1 row'));
  });
});

describe('readActionMembers', () => {
  const schema = {
    $defs: {
      [ACTION_WRAPPER_DEF]: {
        oneOf: [{ $ref: '#/$defs/action_click' }, { $ref: '#/$defs/action_type' }],
      },
      action_click: { properties: {} },
      action_type: { properties: {} },
      element: { properties: {} },
    },
  };

  it('reads the wrapper’s members and the prefixed defs', () => {
    const read = readActionMembers(schema, 'extension');
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.members, ['action_click', 'action_type']);
    assert.deepEqual(read.prefixed, ['action_click', 'action_type']);
  });

  it('refuses an empty union rather than diffing two empty lists', () => {
    const read = readActionMembers({ $defs: { [ACTION_WRAPPER_DEF]: { oneOf: [] } } }, 'extension');
    assert.deepEqual(read.members, []);
    assert.ok(read.problems[0].includes('selects nothing'), read.problems.join('\n'));
  });

  it('is loud when the wrapper is missing and when a member is not a reference', () => {
    const missing = readActionMembers({ $defs: { action_click: {} } }, 'extension');
    assert.deepEqual(missing.members, []);
    assert.ok(missing.problems[0].includes(ACTION_WRAPPER_DEF));
    const inline = readActionMembers(
      { $defs: { [ACTION_WRAPPER_DEF]: { oneOf: [{ properties: {} }] } } },
      'desktop-windows',
    );
    assert.deepEqual(inline.members, []);
    assert.ok(inline.problems[0].includes('oneOf member 0') && inline.problems[0].includes('desktop-windows')); // prettier-ignore
  });
});

describe('extractFieldTable', () => {
  const doc = [
    '## Elsewhere',
    '',
    '| Field | Type | Required | Description |',
    '| ----- | ---- | -------- | ----------- |',
    '| `decoy` | string | yes | another section |',
    '',
    '## Target',
    '',
    '| Name | Type | Required | Description |',
    '| ---- | ---- | -------- | ----------- |',
    '| `sibling` | string | yes | a sibling table under the same section |',
    '',
    '| Field | Type | Required | Description |',
    '| ----- | ---- | -------- | ----------- |',
    '| `uuid` | UUIDv7 | yes | id |',
    '| `narration` | string | one of | text |',
    '| `expect` | string | no | assertion |',
    '| unreadable | string | yes | first cell is not a backticked name |',
    '| `mystery` | string | maybe | Required cell outside the vocabulary |',
  ].join('\n');

  it('selects by section AND first header cell, reading names and required marks', () => {
    const read = extractFieldTable(doc, 'Target', 'Field', 'the target table');
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.rows, [
      { field: 'uuid', required: 'yes' },
      { field: 'narration', required: 'one of' },
      { field: 'expect', required: 'no' },
    ]);
    assert.equal(read.unreadable.length, 2);
    assert.ok(read.unreadable.some((u) => u.includes('unreadable')));
    assert.ok(read.unreadable.some((u) => u.includes('mystery') && u.includes('maybe')));
  });

  it('refuses a section+header pair that selects no table', () => {
    const read = extractFieldTable(doc, 'Absent', 'Field', 'the missing table');
    assert.deepEqual(read.rows, []);
    assert.ok(read.problems[0].includes('carries 0 tables') && read.problems[0].includes('the missing table')); // prettier-ignore
  });

  it('refuses a section+header pair that selects two tables rather than merging them', () => {
    const twice = `${doc}\n\n| Field | Type | Required | Description |\n| - | - | - | - |\n| \`late\` | string | yes | a second table |`; // prettier-ignore
    const read = extractFieldTable(twice, 'Target', 'Field', 'the target table');
    assert.deepEqual(read.rows, []);
    assert.ok(read.problems[0].includes('carries 2 tables'));
  });

  it('refuses a table whose Required column moved', () => {
    const moved = [
      '## Target',
      '',
      '| Field | Type | Description | Required |',
      '| ----- | ---- | ----------- | -------- |',
      '| `uuid` | UUIDv7 | id | yes |',
    ].join('\n');
    const read = extractFieldTable(moved, 'Target', 'Field', 'the target table');
    assert.deepEqual(read.rows, []);
    assert.ok(
      read.problems[0].includes(`column ${REQUIRED_COLUMN}`) &&
        read.problems[0].includes(REQUIRED_HEADER),
    );
  });

  it('never reads a table inside a fence', () => {
    const fenced = [
      '## Target',
      '',
      '```markdown',
      '| Field | Type | Required | Description |',
      '| ----- | ---- | -------- | ----------- |',
      '| `illustrative` | string | yes | inside a fence |',
      '```',
    ].join('\n');
    const read = extractFieldTable(fenced, 'Target', 'Field', 'the target table');
    assert.deepEqual(read.rows, []);
    assert.ok(read.problems[0].includes('carries 0 tables'));
  });
});

describe('describeTarget — the target pointers and the words each one decides', () => {
  it('reads the root pointer as the schema root', () => {
    const target = describeTarget(ROOT_POINTER);
    assert.equal(target.defName, null);
    assert.equal(target.where('extension'), 'the composed extension schema root');
    assert.equal(target.subject, 'the schema root');
    assert.equal(target.legs, 'the payload-table legs');
    assert.equal(target.noun, 'this root');
  });

  it('reads a def pointer as that def, naming its legs by the register kinds that hold it', () => {
    const target = describeTarget('#/$defs/project');
    assert.equal(target.defName, 'project');
    assert.equal(target.where('desktop-windows'), 'the composed desktop-windows `project` def');
    assert.equal(target.subject, '`project`');
    assert.equal(target.legs, 'the field-table and payload-table legs');
    assert.equal(describeTarget('#/$defs/step').legs, 'the field-table legs');
    assert.equal(target.noun, 'this def');
  });

  it('throws by name on a pointer in neither form — the register’s own bug, not a tree input', () => {
    for (const pointer of ['#/properties/project', '#/$defs/a/b', '', undefined]) {
      assert.throws(() => describeTarget(pointer), /is neither "#" nor "#\/\$defs\/<name>"/, String(pointer)); // prettier-ignore
      assert.throws(() => readTargetSurface({}, 'extension', pointer), /check's own bug/);
    }
  });
});

describe('readTargetSurface', () => {
  const schema = {
    properties: { a: {}, b: {} },
    required: ['a'],
    anyOf: [{ required: ['b'] }],
    $defs: {
      step: {
        type: 'object',
        properties: { uuid: {}, narration: {}, step_type: {} },
        required: ['uuid'],
        anyOf: [{ required: ['narration'] }, { required: ['step_type', 'narration'] }],
      },
      loose: { type: 'object' },
      odd: { type: 'object', properties: {}, required: 'uuid' },
      vague: { type: 'object', properties: { a: {} }, anyOf: [{ minProperties: 1 }] },
    },
  };

  it('reads properties, required, and the deduplicated anyOf union', () => {
    const read = readTargetSurface(schema, 'extension', '#/$defs/step');
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.properties, ['uuid', 'narration', 'step_type']);
    assert.deepEqual(read.required, ['uuid']);
    assert.deepEqual(read.anyOfRequired.sort(), ['narration', 'step_type']);
    assert.equal(read.hasAnyOf, true);
    assert.equal(read.present, true);
    assert.equal(read.where, 'the composed extension `step` def');
  });

  it('reads the root envelope’s own properties, required, and anyOf', () => {
    const read = readTargetSurface(schema, 'extension', ROOT_POINTER);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.properties, ['a', 'b']);
    assert.deepEqual(read.required, ['a']);
    assert.deepEqual(read.anyOfRequired, ['b']);
    assert.equal(read.where, 'the composed extension schema root');
    assert.equal(read.noun, 'this root');
  });

  it('is loud on a missing def, a def with no properties, and a non-array required', () => {
    const missing = readTargetSurface(schema, 'extension', '#/$defs/ghost');
    assert.equal(missing.present, false);
    assert.deepEqual(missing.problems, [
      'the composed extension schema carries no `ghost` def — the field-table legs cannot run',
    ]);
    assert.equal(missing.where, 'the composed extension `ghost` def');
    const loose = readTargetSurface(schema, 'extension', '#/$defs/loose');
    assert.equal(loose.present, false);
    assert.deepEqual(loose.problems, [
      'the composed extension `loose` def carries no properties object — the field-table legs cannot run',
    ]);
    const odd = readTargetSurface(schema, 'extension', '#/$defs/odd');
    assert.ok(odd.problems[0].includes('required that is not an array'));
  });

  it('is loud on a root with no properties and on a schema that is not an object', () => {
    const bare = readTargetSurface({ $defs: {} }, 'extension', ROOT_POINTER);
    assert.equal(bare.present, false);
    assert.deepEqual(bare.problems, [
      'the composed extension schema root carries no properties object — the payload-table legs cannot run',
    ]);
    const absent = readTargetSurface(null, 'desktop-windows', ROOT_POINTER);
    assert.equal(absent.present, false);
    assert.deepEqual(absent.problems, [
      'the composed desktop-windows schema is not an object — the payload-table legs cannot run',
    ]);
  });

  it('refuses an anyOf branch it does not model instead of reading it as empty', () => {
    const read = readTargetSurface(schema, 'desktop-windows', '#/$defs/vague');
    assert.equal(read.hasAnyOf, true);
    assert.deepEqual(read.anyOfRequired, []);
    assert.ok(read.problems[0].includes('anyOf branch 0') && read.problems[0].includes('desktop-windows')); // prettier-ignore
  });
});

describe('walkObjectSchemas / classifyObjectSchema / postureHolds', () => {
  it('finds objects through every composition keyword it descends', () => {
    const schema = {
      type: 'object',
      properties: { nested: { type: 'object', properties: {} } },
      $defs: {
        action_click: { properties: {} },
        listy: { type: 'array', items: { type: 'object', properties: {} } },
        branchy: { oneOf: [{ type: 'object', properties: {} }], anyOf: [{ required: ['x'] }] },
        mapped: { type: 'object', additionalProperties: { type: 'object', properties: {} } },
      },
    };
    const pointers = walkObjectSchemas(schema).map((o) => o.pointer);
    for (const expected of [
      '#',
      '#/properties/nested',
      '#/$defs/action_click',
      '#/$defs/listy/items',
      '#/$defs/branchy/oneOf/0',
      '#/$defs/mapped',
      '#/$defs/mapped/additionalProperties',
    ]) {
      assert.ok(pointers.includes(expected), `${expected} missing from ${pointers.join(', ')}`);
    }
  });

  it('records whether each object discriminates, the shape a wrapper’s exemption rests on', () => {
    const found = walkObjectSchemas({
      $defs: {
        host: { type: 'object', properties: {}, oneOf: [{ $ref: '#/$defs/leaf' }] },
        leaf: { type: 'object', properties: {}, additionalProperties: false },
      },
    });
    const at = (pointer) => found.find((o) => o.pointer === pointer);
    assert.equal(at('#/$defs/host').discriminates, true);
    assert.equal(at('#/$defs/leaf').discriminates, false);
  });

  it('classifies by def name at the top level and treats every nested object as closed', () => {
    assert.equal(classifyObjectSchema('#/$defs/action'), 'wrapper');
    assert.equal(classifyObjectSchema('#/$defs/locator'), 'wrapper');
    assert.equal(classifyObjectSchema('#/$defs/action_click'), 'action');
    assert.equal(classifyObjectSchema(`#/$defs/${METADATA_DEF}`), 'metadata-map');
    assert.equal(classifyObjectSchema('#/$defs/element'), 'closed');
    assert.equal(classifyObjectSchema('#'), 'closed');
    assert.equal(classifyObjectSchema('#/$defs/action_file_upload/properties/files/items'), 'closed'); // prettier-ignore
  });

  it('holds each class to its own declaration, and describes what it found', () => {
    assert.ok(postureHolds('action', undefined));
    assert.ok(!postureHolds('action', false));
    assert.ok(postureHolds('wrapper', undefined));
    assert.ok(!postureHolds('wrapper', {}));
    assert.ok(postureHolds('metadata-map', { type: 'string' }));
    assert.ok(postureHolds('metadata-map', { oneOf: [{ type: 'string' }] }));
    // An empty schema accepts anything — the map is open in its KEYS, not in
    // what a value may be, so this is not the exemption's shape.
    assert.ok(!postureHolds('metadata-map', {}));
    assert.ok(!postureHolds('metadata-map', true));
    assert.ok(!postureHolds('metadata-map', false));
    assert.ok(postureHolds('closed', false));
    assert.ok(!postureHolds('closed', undefined));
    assert.ok(!postureHolds('closed', true));
    assert.ok(statesValueConstraint({ $ref: '#/$defs/x' }));
    assert.ok(!statesValueConstraint({ description: 'prose only' }));
    // A class with no arm is a programming error, never a silent inheritance
    // of the closed rule.
    assert.throws(() => postureHolds('invented', false), /no posture is defined/);
    assert.equal(describeDeclaration(undefined), 'declares none');
    assert.equal(describeDeclaration(false), 'declares `false`');
    assert.equal(describeDeclaration(true), 'declares `true`');
    assert.equal(describeDeclaration({ type: 'string' }), 'declares a schema');
    assert.equal(describeDeclaration(['odd']), 'declares ["odd"]');
  });

  it('publishes the keywords it actually descends, derived rather than restated', () => {
    for (const keyword of ['properties', '$defs', 'items', 'oneOf', 'additionalProperties']) {
      assert.ok(TRAVERSED_KEYWORDS.includes(keyword), keyword);
    }
    assert.equal(new Set(TRAVERSED_KEYWORDS).size, TRAVERSED_KEYWORDS.length);
  });
});

describe('normalizeProse', () => {
  it('blanks fences and collapses wrapping, so a re-wrapped claim still matches', () => {
    const doc = [
      'A claim that',
      'wraps across lines.',
      '```json',
      '{ "not": "prose" }',
      '```',
    ].join('\n');
    const prose = normalizeProse(doc);
    assert.match(prose, /A claim that wraps across lines\./);
    assert.ok(!prose.includes('not'));
  });
});

describe('auditTree — a schema that will not compose', () => {
  it('names the failure instead of skipping the legs it feeds', () => {
    const surfaces = auditTree(
      (path) => readTree(path),
      () => {
        throw new Error('layer chain broken');
      },
    );
    assert.ok(
      surfaces.anchorProblems.some(
        (p) => p.includes('does not compose from its source layers') && p.includes('layer chain broken') && p.endsWith('— the posture, field-table and payload-table legs cannot run'), // prettier-ignore
      ),
      surfaces.anchorProblems.join('\n'),
    );
    assert.deepEqual(surfaces.objects, []);
    assert.ok(evaluateSchemaEcho(surfaces).some((p) => p.includes('no object subschemas found')));
  });
});

describe('real-tree lock', () => {
  it('the shipped tree satisfies every echo — through the CLI’s own tree reader', () => {
    const surfaces = treeSurfaces(ROOT);
    assert.deepEqual(surfaces.anchorProblems, []);
    assert.deepEqual(evaluateSchemaEcho(surfaces), []);
    assert.equal(surfaces.authority.length, AUTHORITY_SURFACES.length);
    assert.equal(surfaces.tables.length, FIELD_TABLE_LEGS.length);
    assert.equal(surfaces.payloadTables.length, PAYLOAD_TABLE_LEGS.length);
    assert.ok(surfaces.tableRows.length > 0);
    assert.ok(surfaces.payloadTableRows.length > 0);
    assert.ok(surfaces.defs.every((d) => d.present));
    const targets = new Set([
      ...FIELD_TABLE_LEGS.map(([, , defName]) => `#/$defs/${defName}`),
      ...PAYLOAD_TABLE_LEGS.map(([, , pointer]) => pointer),
    ]);
    assert.equal(surfaces.defs.length, targets.size * PLATFORM_IDS.length);
    for (const platform of PLATFORM_IDS) {
      assert.ok(surfaces.objects.some((o) => o.platform === platform), platform); // prettier-ignore
    }
  });

  it('a root without the session-format document fails loudly, never vacuously', () => {
    // A tracked subdirectory is a root where every document read misses: the
    // reader answers unreadable, the table selections refuse by name, and the
    // vacuous guard reds. The schemas still compose — they come from the
    // repository this script ships in — so the posture legs stay live.
    const surfaces = treeSurfaces(resolve(ROOT, 'corpus'));
    assert.ok(surfaces.anchorProblems.some((p) => p.includes('carries 0 tables')));
    assert.ok(surfaces.objects.length > 0);
    const problems = evaluateSchemaEcho(surfaces);
    assert.ok(problems.some((p) => p.includes('no field-table rows read')));
    assert.ok(problems.some((p) => p.includes('could not be read')));
  });

  it('a surface that cannot be read is named apart from one that read empty', () => {
    // The two reads a tree can answer with are different facts, so the report
    // says which it was: a document the tree cannot hand over is unreadable, a
    // document that is there and says nothing read empty. A reader answering
    // the same thing to both is what made the second indistinguishable.
    const empty = auditTree(() => '', () => ({})); // prettier-ignore
    const unreadable = auditTree(() => null, () => ({})); // prettier-ignore
    assert.ok(empty.authority.every((s) => s.empty && !s.unreadable));
    assert.ok(unreadable.authority.every((s) => s.empty && s.unreadable));

    const emptyProblems = evaluateSchemaEcho(empty);
    const unreadableProblems = evaluateSchemaEcho(unreadable);
    for (const [path] of AUTHORITY_SURFACES) {
      assert.ok(emptyProblems.some((p) => p === `${path} read empty — ${describe1(path)}`), path); // prettier-ignore
      assert.ok(unreadableProblems.some((p) => p === `${path} could not be read — ${describe1(path)}`), path); // prettier-ignore
    }
    // The registry read discriminates too: its own refusal names the read, not
    // a parse it never reached.
    assert.deepEqual(readClauseRow(null, AUTHORITY_CLAUSE_ID).problems, [
      `${REGISTRY_PATH} could not be read — the §${AUTHORITY_CLAUSE_ID} register closure cannot run`,
    ]);
    assert.deepEqual(readClauseRow('{', AUTHORITY_CLAUSE_ID).problems, [
      `${REGISTRY_PATH} does not parse as JSON — the §${AUTHORITY_CLAUSE_ID} register closure cannot run`,
    ]);
    // And it says which side of the exit-code partition each answer sits on.
    assert.equal(readClauseRow(null, AUTHORITY_CLAUSE_ID).machinery, true);
    assert.equal(readClauseRow('{', AUTHORITY_CLAUSE_ID).machinery, true);
    assert.equal(readClauseRow('{"clauses":[]}', AUTHORITY_CLAUSE_ID).machinery, false);
  });
});

describe('the CLI’s two exit codes, over copies of the surfaces it reads', () => {
  const SCRIPT = join(ROOT, 'scripts', 'check-schema-echo.js');
  // Exactly the tree-side read-set: the registered authority surfaces (the
  // session-format document among them) and the registry the register closure
  // reads. The schemas are composed from the source layers of the repository
  // the script ships in, so a copy needs no schema sources of its own.
  const READ_SET = [...AUTHORITY_SURFACES.map(([path]) => path), REGISTRY_PATH];
  let root = null;

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A throwaway tree holding copies of the surfaces the check reads. */
  function tree(mutate = null) {
    root ??= mkdtempSync(join(tmpdir(), 'docent-echo-cli-'));
    const dir = mkdtempSync(join(root, 'case-'));
    const files = new Map(READ_SET.map((rel) => [rel, readTree(rel)]));
    if (mutate) mutate(files);
    for (const [rel, text] of files) {
      const target = join(dir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }

  /** Run the real CLI against a throwaway tree. */
  function run(dir) {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('exit 0 over pristine copies of every surface it reads', () => {
    const r = run(tree());
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /schema echoes consistent/);
  });

  it('a registry it cannot read at all is the machinery verdict, on exit 2', () => {
    const r = run(tree((files) => files.delete(REGISTRY_PATH)));
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${REGISTRY_PATH.replace('.', '\\.')} could not be read`));
    assert.match(r.stderr, /exit 2/);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  });

  it('a registry whose text is not JSON is that same verdict, on the same code', () => {
    const r = run(tree((files) => files.set(REGISTRY_PATH, '{ "clauses": [')));
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /does not parse as JSON/);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  });

  it('a payload table whose heading no longer selects it is the machinery verdict, on exit 2', () => {
    const doc = SYNC_PROTOCOL_DOC_PATH;
    const [[, subsection]] = PAYLOAD_TABLE_LEGS;
    const r = run(tree((files) => files.set(doc, files.get(doc).replace(`#### ${subsection}`, '#### Renamed')))); // prettier-ignore
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /carries 0 tables under/);
  });

  it('a payload table that dropped a required field is drift, on exit 1', () => {
    const doc = SYNC_PROTOCOL_DOC_PATH;
    const r = run(tree((files) => files.set(doc, files.get(doc).replace(/^\| `recordings` .*\n/m, '')))); // prettier-ignore
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /`recordings` is a property of the composed \S+ schema root but the sync payload top-level table has no row for it/); // prettier-ignore
  });

  it('a Field-headed table no payload register holds is drift, on exit 1', () => {
    const doc = SYNC_PROTOCOL_DOC_PATH;
    const added = '\n## Appendix\n\n| Field | Type |\n| ----- | ---- |\n| `x` | t |\n';
    const r = run(tree((files) => files.set(doc, `${files.get(doc)}${added}`)));
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /`Appendix \/ \(no heading\) \/ Field \| Type` is a field table in docs\/api\/sync-protocol\.md that no payload leg holds/); // prettier-ignore
  });

  it('an echo that drifted, every read having answered, ends on exit 1 instead', () => {
    // One perturbation, on a surface the machinery legs read cleanly: the row
    // that discloses which surfaces are held cites one more than the register
    // backs. Every read answers, so what is left is the disagreement itself.
    const cited = 'docs/an-unregistered-surface.md';
    const r = run(
      tree((files) => {
        const registry = JSON.parse(files.get(REGISTRY_PATH));
        const row = registry.clauses.find((c) => c.clause === AUTHORITY_CLAUSE_ID);
        row['check-ref'] = `${row['check-ref']} and ${cited}`;
        files.set(REGISTRY_PATH, JSON.stringify(registry, null, 2));
      }),
    );
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(cited.replace('.', '\\.')));
    assert.match(r.stderr, /no registered surface holds it/);
  });
});

/** The description the register states for one authority surface, with its tail. */
function describe1(path) {
  const [, , description] = AUTHORITY_SURFACES.find(([p]) => p === path);
  return `${description} cannot be checked`;
}
