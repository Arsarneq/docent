/**
 * check-schema-echo.test.js — Unit tests for the schema-echo admission test
 * (scripts/check-schema-echo.js). The session-format document restates what
 * the schemas define, so every red path must fail loud: these tests prove the
 * authority-statement leg, one posture red per class, the field-table diffs in
 * both directions on both platforms, the cross-platform def agreement, the
 * unreadable-cell and moved-column refusals, duplicates, empty parses — and,
 * as a real-tree lock, that the shipped tree satisfies every leg through the
 * reader the CLI itself uses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACTION_DEF_PREFIX,
  ACTION_WRAPPER_DEF,
  AUTHORITY_CLAUSE_ID,
  AUTHORITY_SURFACES,
  EMPTY_SURFACES,
  FIELD_TABLE_HEADER,
  FIELD_TABLE_LEGS,
  METADATA_DEF,
  PLATFORM_IDS,
  POSTURE_CLASSES,
  REQUIRED_COLUMN,
  REQUIRED_HEADER,
  SESSION_FORMAT_DOC_PATH,
  TRAVERSED_KEYWORDS,
  UNHELD_FIELD_TABLES,
  auditTree,
  classifyObjectSchema,
  describeDeclaration,
  evaluateSchemaEcho,
  extractFieldTable,
  extractFieldTableKeys,
  fieldTableKey,
  normalizeProse,
  postureHolds,
  readActionMembers,
  readDefSurface,
  treeSurfaces,
  walkObjectSchemas,
} from '../../../../scripts/check-schema-echo.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const readTree = (path) => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * A consistent synthetic surface every echo leg accepts. `tableRows` is
 * derived from `tables` unless a test overrides it, exactly as the tree read
 * derives it — so a fixture cannot state a row count its tables do not carry.
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
    metadataHosts: [{ platform: 'extension', defName: 'project', resolved: true }],
    actionMembers: [
      { platform: 'extension', members: ['action_click'], prefixed: ['action_click'] },
    ],
    fieldTableKeys: [
      ...FIELD_TABLE_LEGS.map(([section, header]) => fieldTableKey(section, header)),
      ...UNHELD_FIELD_TABLES.map(([section, header]) => fieldTableKey(section, header)),
    ],
    tables: [
      {
        defName: 'step',
        label: 'the step-fields table',
        fields: ['uuid', 'narration', 'step_type', 'expect'],
        yes: ['uuid'],
        no: ['expect'],
        oneOf: ['narration', 'step_type'],
      },
    ],
    tableUnreadable: [],
    defs: PLATFORM_IDS.map((platform) => ({
      platform,
      defName: 'step',
      present: true,
      hasAnyOf: true,
      properties: ['uuid', 'narration', 'step_type', 'expect'],
      required: ['uuid'],
      anyOfRequired: ['narration', 'step_type'],
    })),
    ...overrides,
  };
  if (!('tableRows' in overrides)) surface.tableRows = surface.tables.flatMap((t) => t.fields);
  return surface;
}

/** The synthetic surface with one platform's `step` def replaced. */
const withDef = (platform, patch) =>
  makeSurface({
    defs: makeSurface().defs.map((d) => (d.platform === platform ? { ...d, ...patch } : d)),
  });

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

  it('fires when a metadata host stops resolving to the map def', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({
        metadataHosts: [{ platform: 'desktop-windows', defName: 'recording', resolved: false }],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('recording') && p.includes(METADATA_DEF)),
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
        fieldTableKeys: [
          ...makeSurface().fieldTableKeys,
          fieldTableKey('Widget', FIELD_TABLE_HEADER),
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('Widget') && p.includes('no leg holds')),
      problems.join('\n'),
    );
  });

  it('fires when a registration names a table the document no longer carries', () => {
    const problems = evaluateSchemaEcho(
      makeSurface({ fieldTableKeys: makeSurface().fieldTableKeys.slice(1) }),
    );
    assert.ok(
      problems.some((p) => p.includes('the registration is stale')),
      problems.join('\n'),
    );
  });

  it('fires when one section carries two field tables the legs cannot address apart', () => {
    const keys = makeSurface().fieldTableKeys;
    const problems = evaluateSchemaEcho(makeSurface({ fieldTableKeys: [...keys, keys[0]] }));
    assert.ok(
      problems.some((p) => p.includes('more than once')),
      problems.join('\n'),
    );
  });
});

describe('evaluateSchemaEcho — the field-set leg (both ways, both platforms)', () => {
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
});

describe('evaluateSchemaEcho — the cross-platform def agreement', () => {
  it('fires when one platform’s copy of a shared def carries an extra property', () => {
    const problems = evaluateSchemaEcho(
      withDef('desktop-windows', {
        properties: ['uuid', 'narration', 'step_type', 'expect', 'divergent'],
      }),
    );
    assert.ok(
      problems.some(
        (p) => p.includes('`divergent`') && p.includes('the two platforms must share this def'),
      ),
      problems.join('\n'),
    );
  });

  it('fires when the two platforms disagree on the def’s required set', () => {
    const problems = evaluateSchemaEcho(withDef('desktop-windows', { required: [] }));
    assert.ok(
      problems.some(
        (p) => p.includes('`uuid`') && p.includes('the two platforms must share this def'),
      ),
      problems.join('\n'),
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
    const registered = [
      ...FIELD_TABLE_LEGS.map(([section, header]) => fieldTableKey(section, header)),
      ...UNHELD_FIELD_TABLES.map(([section, header]) => fieldTableKey(section, header)),
    ];
    assert.deepEqual([...found].sort(), [...registered].sort());
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

describe('readDefSurface', () => {
  const schema = {
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
    const read = readDefSurface(schema, 'extension', 'step');
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.properties, ['uuid', 'narration', 'step_type']);
    assert.deepEqual(read.required, ['uuid']);
    assert.deepEqual(read.anyOfRequired.sort(), ['narration', 'step_type']);
    assert.equal(read.hasAnyOf, true);
    assert.equal(read.present, true);
  });

  it('is loud on a missing def, a def with no properties, and a non-array required', () => {
    const missing = readDefSurface(schema, 'extension', 'ghost');
    assert.equal(missing.present, false);
    assert.ok(missing.problems[0].includes('no `ghost` def'));
    const loose = readDefSurface(schema, 'extension', 'loose');
    assert.equal(loose.present, false);
    assert.ok(loose.problems[0].includes('no properties object'));
    const odd = readDefSurface(schema, 'extension', 'odd');
    assert.ok(odd.problems[0].includes('required that is not an array'));
  });

  it('refuses an anyOf branch it does not model instead of reading it as empty', () => {
    const read = readDefSurface(schema, 'desktop-windows', 'vague');
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
    assert.ok(!postureHolds('metadata-map', true));
    assert.ok(!postureHolds('metadata-map', false));
    assert.ok(postureHolds('closed', false));
    assert.ok(!postureHolds('closed', undefined));
    assert.ok(!postureHolds('closed', true));
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
        (p) => p.includes('does not compose from its source layers') && p.includes('layer chain broken'), // prettier-ignore
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
    assert.ok(surfaces.tableRows.length > 0);
    assert.ok(surfaces.defs.every((d) => d.present));
    for (const platform of PLATFORM_IDS) {
      assert.ok(surfaces.objects.some((o) => o.platform === platform), platform); // prettier-ignore
    }
  });

  it('a root without the session-format document fails loudly, never vacuously', () => {
    // A tracked subdirectory is a root where every document read misses: the
    // fallback returns empty, the table selections refuse by name, and the
    // vacuous guard reds. The schemas still compose — they come from the
    // repository this script ships in — so the posture legs stay live.
    const surfaces = treeSurfaces(resolve(ROOT, 'corpus'));
    assert.ok(surfaces.anchorProblems.some((p) => p.includes('carries 0 tables')));
    assert.ok(surfaces.objects.length > 0);
    const problems = evaluateSchemaEcho(surfaces);
    assert.ok(problems.some((p) => p.includes('no field-table rows read')));
    assert.ok(problems.some((p) => p.includes('read empty')));
  });
});
